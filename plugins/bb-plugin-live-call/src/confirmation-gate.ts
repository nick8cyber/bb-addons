/**
 * ConfirmationGate: протокол подтверждений (спека §7.1, контракт §5).
 * Pending-действие одно; решает сервер; шлюз микрофона закрыт, пока звучит вопрос;
 * окно ответа открывается по playback_drained + оценке сервера; вердикт одноразовый.
 *
 * Вердикт и исполнение разделены: в режиме router драйвер исполняет сразу по
 * approved и вызывает consume(); в режиме native исполнение происходит по
 * confirm_action(id) от модели. Отмена, отказ и TTL сжигают запись сразу.
 */
import { createHash } from "node:crypto";
import {
  ARGS_HASH_DEDUP_MS,
  BYTES_PER_SECOND_24K,
  CONFIRM_TTL_MS,
  BARGE_IN_MIN_MS,
  TRANSCRIPT_WAIT_MS,
  UTTERANCE_SILENCE_MS,
  WINDOW_PADDING_MS,
  WINDOW_SERVER_SLACK_MS,
} from "./contract.js";
import {
  classify,
  isEchoWord,
  isFalseClaim,
  normalizeUtterance,
  type ConfirmClass,
  type ConfirmWords,
  type Verdict,
} from "./classify.js";

export interface PendingConfirmation {
  confirmationId: string;
  tool: string;
  argsHash: string;
  class: ConfirmClass;
  say: string;
  /** Полный текст для карточки; вслух — короткий say. */
  card?: string;
  /** Источники текста действия для false_claim (§7.1 п. 9.1 шаг 2) */
  actionTexts?: string[];
  createdAt: number;
  expiresAt: number;
  /** Вердикт владельца; до него null. */
  verdict: Verdict | null;
}

export type RequestResult =
  | { pending: PendingConfirmation }
  | { rejected: "pending_exists" | "recent_verdict"; message: string };

/**
 * Канонический хеш аргументов: отсортированные ключи, без пробелов (контракт §5).
 * Служебные ключи `_*` верхнего уровня (запись треда, взаимодействия из resolve) в хеш не входят:
 * у них меняются updatedAt/status, и один и тот же вызов давал разный хеш — ломались
 * «тот же вызов → та же запись» и «уже выполнено» (ревью PLUG-113, блокер A).
 */
export function argsHash(tool: string, args: Record<string, unknown>): string {
  const stable = Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith("_")));
  return argsHashRaw(tool, stable);
}

function argsHashRaw(tool: string, args: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  return createHash("sha256").update(`${tool}:${JSON.stringify(canonical(args))}`).digest("hex");
}

interface Utterance {
  firstChunkAt: number;
  lastChunkAt: number;
  text: string;
}

export interface GateEvents {
  /** Pending создан, изменён (подсказка) или открыт window: обновить оверлей и say. */
  onConfirmationUpdate?: (pending: PendingConfirmation, phase: "asking" | "listening") => void;
  /** Вердикт определён. Исполнение — на вызывающей стороне. */
  onVerdict?: (p: PendingConfirmation, verdict: Verdict) => void;
  /**
   * Расчётный момент, когда вопрос зазвучит у владельца (для журнала и приёмки).
   * offsetMs — длительность звука модели после запроса до начала вопроса (по байтам),
   * чтобы приёмка сверила его с тем, что реально проиграл браузер, а не с этой оценкой.
   */
  onQuestionHeardAt?: (p: PendingConfirmation, at: number, offsetMs: number) => void;
  /**
   * Владелец сказал «да» до вопроса — отброшенное раннее согласие.
   * Сервер прерывает модель и вставляет [СИСТЕМА] (спека §7.1 п. 3.1).
   */
  onEarlyApproval?: (p: PendingConfirmation) => void;
}

export interface GateClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: GateClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Запас поверх оценки, если playback_drained так и не пришёл. */
export const DRAINED_LOST_SLACK_MS = 2500;
/** Речь модели за столько до запроса подтверждения тоже считается возможным эхом (филлер перед вызовом). */
export const MODEL_ECHO_BEFORE_REQUEST_MS = 15_000;
/** Запас на сеть и буфер плеера: вопрос считается услышанным не раньше этого после расчётного начала. */
export const QUESTION_HEARD_SLACK_MS = 500;
const MODEL_ECHO_MEMORY_MS = 60_000;

export class ConfirmationGate {
  private pending: PendingConfirmation | null = null;
  private micOpen = true;
  private windowOpenAt: number | null = null;
  /** Аудио ходов модели после needs_confirmation: turnSeq → байты PCM 24 кГц. */
  private turnAudio = new Map<number, number>();
  private turnDrained = new Set<number>();
  private firstAudioAt: number | null = null;
  private lastAudioAt: number | null = null;
  private windowTimer: unknown = null;
  private currentUtterance: Utterance | null = null;
  private utteranceTimer: unknown = null;
  private bargeUtterance: Utterance | null = null;
  /**
   * Недавняя речь модели с отметкой времени: эхо из динамиков не может быть ответом.
   * Копится всегда, не только во время pending: филлер «Да, сейчас отправлю…» звучит
   * до вызова инструмента, а доигрывается и распознаётся уже после request().
   */
  private modelSpeech: Array<{ at: number; words: string[] }> = [];
  private bargeTimer: unknown = null;
  /** До этого момента куски транскрипта — хвост уже отброшенной реплики. */
  private tailUntil = 0;
  /** Байты аудио модели после запроса (сквозь все ходы) и сколько их было до начала вопроса. */
  private audioSinceRequest = 0;
  private questionAudioOffset: number | null = null;
  /** Ходы модели, чей звук ещё может доигрываться: turnSeq → первый кадр и байты. */
  private playingTurns = new Map<number, { firstAt: number; bytes: number }>();
  /** Когда доиграет звук ходов, начатых до запроса (оценка сервера). */
  private priorPlaybackEnd = 0;
  /** Значимые слова вопроса без слов из аргументов действия (филлер может их повторять). */
  private objectWords: string[] = [];
  private sayTailWords: string[] = [];
  private tailIsIdentifying = false;
  private recentVerdicts = new Map<string, { verdict: Verdict; at: number }>();
  private usedIds = new Set<string>();
  private confirmWaiters = new Map<string, Array<{ resolve: (v: Verdict) => void; timer: unknown }>>();
  private falseClaimInjected = false;
  private earlyInjectedForQuestion = false;
  private maxInterruptedTurnSeq = 0;

  constructor(
    private words: ConfirmWords,
    private clock: GateClock = realClock,
    private events: GateEvents = {},
  ) {}

  setWords(words: ConfirmWords) {
    this.words = words;
  }

  /**
   * Инструмент класса C/P/L просит подтверждение. Повтор с тем же argsHash
   * возвращает ту же запись; другой вызов записи отклоняется до вердикта;
   * тот же argsHash в течение 5 мин после вердикта — «уже выполнено» / «отменено».
   */
  request(
    tool: string,
    args: Record<string, unknown>,
    cls: ConfirmClass,
    say: string,
    card?: string,
    actionTexts?: string[],
  ): RequestResult {
    const hash = argsHash(tool, args);
    const recent = this.recentVerdicts.get(hash);
    if (recent && this.clock.now() - recent.at < ARGS_HASH_DEDUP_MS) {
      return {
        rejected: "recent_verdict",
        message: this.recentVerdictText(hash) ?? "действие уже обработано",
      };
    }
    if (this.pending) {
      if (this.pending.argsHash === hash) return { pending: this.pending };
      return { rejected: "pending_exists", message: "сначала ответь на текущее подтверждение" };
    }
    const now = this.clock.now();
    const resolvedActionTexts: string[] = actionTexts !== undefined ? actionTexts : (() => {
      const texts: string[] = [];
      const full = ["text", "answer", "task", "body"].map((k) => args[k]).find((v) => typeof v === "string" && (v as string).trim()) as string | undefined;
      if (full && full.trim()) texts.push(full.trim());
      return texts;
    })();

    this.pending = {
      confirmationId: `cf_${hash.slice(0, 12)}_${now.toString(36)}`,
      tool,
      argsHash: hash,
      class: cls,
      say,
      card,
      actionTexts: resolvedActionTexts,
      createdAt: now,
      expiresAt: now + CONFIRM_TTL_MS,
      verdict: null,
    };
    // Микрофон во время вопроса открыт: владелец может перебить вопрос словом
    // подтверждения (решение владельца 04.11, спека §7.1 п. 3.1). Защита от эха —
    // в onOwnerTranscriptChunk: до открытия окна засчитывается только согласие,
    // не раньше BARGE_IN_MIN_MS и не совпадающее со словами самого вопроса.
    this.falseClaimInjected = false;
    this.earlyInjectedForQuestion = false;
    this.resetWindow();
    this.tailUntil = 0;
    this.audioSinceRequest = 0;
    this.questionAudioOffset = null;
    // Филлер, сгенерированный до вызова инструмента, ещё доигрывается: вопрос зазвучит после него.
    this.priorPlaybackEnd = 0;
    for (const t of this.playingTurns.values()) {
      this.priorPlaybackEnd = Math.max(this.priorPlaybackEnd, t.firstAt + (t.bytes / BYTES_PER_SECOND_24K) * 1000);
    }
    this.playingTurns.clear();
    {
      const quotes = Array.from(say.matchAll(/[«"']([^»"']{1,})[»"']/g)).map((m) => m[1].trim());
      // Шаблонная часть say-фразы (вне кавычек)
      const templateText = say.replace(/[«"'][^»"']*[»"']/g, " ");
      const templateWords = new Set(normalizeUtterance(templateText));
      const stopWords = new Set([
        "в", "на", "с", "со", "по", "к", "ко", "о", "об", "обо", "от", "ото",
        "из", "изо", "для", "и", "а", "но", "что", "как", "я", "он", "она",
        "мы", "вы", "они", "это", "этот", "эта", "эти", "то", "же", "у", "за",
      ]);

      // Аргументные слова для защиты от ложного heard по отдельным словам (§7.1 п. 3.1)
      const argWords = new Set(
        Object.values(args).flatMap((v) => (typeof v === "string" ? normalizeUtterance(v) : [])),
      );

      // Слова объекта: только из цитат say, за вычетом шаблонных слов вопроса, предлогов
      // и слов из аргументов действия (§7.1 п. 3.1). Слова из аргументов не должны становиться
      // objectWords, чтобы филлер со словами аргументов («секунду», «пожалуйста», «в», «тред»)
      // не вызывал преждевременный question_heard до того, как прозвучит хвост вопроса.
      const rawQuoteWords = quotes.flatMap((q) => normalizeUtterance(q));
      this.objectWords = Array.from(
        new Set(rawQuoteWords.filter((w) => !templateWords.has(w) && !stopWords.has(w) && !argWords.has(w))),
      );

      const fullSayWords = normalizeUtterance(say);
      this.sayTailWords = fullSayWords.slice(-2);
      this.tailIsIdentifying =
        this.sayTailWords.length === 2 &&
        this.sayTailWords.some((w) => !templateWords.has(w) && !stopWords.has(w));
    }
    this.micOpen = true;
    this.events.onConfirmationUpdate?.(this.pending, "asking");
    return { pending: this.pending };
  }

  pendingConfirmation(): PendingConfirmation | null {
    return this.pending;
  }

  isMicOpen(): boolean {
    return this.micOpen;
  }

  windowOpen(): boolean {
    return this.windowOpenAt !== null && this.clock.now() >= this.windowOpenAt;
  }

  /** Аудио хода модели: байты PCM 24 кГц, помечены turnSeq (спека §7.1 п. 3.2). */
  onModelAudio(turnSeq: number, byteLen: number, at = this.clock.now()) {
    if (turnSeq <= this.maxInterruptedTurnSeq) return;
    const tr = this.playingTurns.get(turnSeq) ?? { firstAt: at, bytes: 0 };
    tr.bytes += byteLen;
    this.playingTurns.set(turnSeq, tr);
    for (const [seq, t] of this.playingTurns) if (at - t.firstAt > 120_000) this.playingTurns.delete(seq);
    if (!this.pending || this.windowOpenAt !== null) return;
    this.audioSinceRequest += byteLen;
    if (!this.turnAudio.has(turnSeq)) this.turnAudio.set(turnSeq, 0);
    this.turnAudio.set(turnSeq, (this.turnAudio.get(turnSeq) ?? 0) + byteLen);
    this.turnDrained.delete(turnSeq);
    this.lastAudioAt = at;
    if (this.firstAudioAt === null) this.firstAudioAt = at;
  }

  onPlaybackDrained(turnSeq: number, at = this.clock.now()) {
    this.playingTurns.delete(turnSeq);
    if (!this.pending || this.windowOpenAt !== null) return;
    if (turnSeq <= this.maxInterruptedTurnSeq) return;
    if (!this.turnAudio.has(turnSeq)) this.turnAudio.set(turnSeq, 0);
    this.turnDrained.add(turnSeq);
    this.maybeOpenWindow(at);
  }

  /** Оценка сервера страхует потерянный playback_drained (спека §7.1 п. 3.4). */
  private estimateWindowAt(): number | null {
    if (this.firstAudioAt === null) return null;
    const totalBytes = [...this.turnAudio.values()].reduce((a, b) => a + b, 0);
    const audioMs = (totalBytes / BYTES_PER_SECOND_24K) * 1000;
    return this.firstAudioAt + audioMs + WINDOW_SERVER_SLACK_MS;
  }

  private maybeOpenWindow(at: number) {
    if (!this.pending || this.windowOpenAt !== null) return;
    if (this.turnAudio.size === 0) return;
    const allDrained = [...this.turnAudio.keys()].every((t) => this.turnDrained.has(t));
    const quiet = this.lastAudioAt !== null && at - this.lastAudioAt >= WINDOW_PADDING_MS;
    if (!allDrained || !quiet) return;
    const estimate = this.estimateWindowAt();
    const openAt = Math.max(at, estimate ?? 0) + WINDOW_PADDING_MS;
    const open = () => {
      if (!this.pending || this.windowOpenAt !== null) return;
      this.windowOpenAt = openAt;
      this.micOpen = true;
      this.events.onConfirmationUpdate?.(this.pending, "listening");
    };
    if (openAt <= at) open();
    else this.windowTimer = this.clock.setTimeout(open, openAt - at);
  }

  /**
   * Кусок транскрипта владельца. В зачёт идут только реплики, первый кусок которых
   * пришёл после открытия окна (спека §7.1 п. 5): хвост опоздавшей речи не склеивается.
   * Реплика завершается по 700 мс тишины — тогда classify.
   */
  onOwnerTranscriptChunk(text: string, at = this.clock.now()) {
    const p = this.pending;
    if (!p) return;
    if (p.expiresAt <= at) {
      this.burn(p, "expired");
      return;
    }
    // Хвост реплики, начатой раньше: продлевается до 700 мс тишины и отбрасывается целиком
    // (§7.1 п. 3.1, п. 3.5; ревью PLUG-113, блокер B).
    if (at < this.tailUntil) {
      this.tailUntil = at + UTTERANCE_SILENCE_MS;
      return;
    }
    // Реплика-перебивание, начатая до окна, доигрывается в том же пути, а не режется окном.
    if (this.bargeUtterance || this.windowOpenAt === null || at < this.windowOpenAt) {
      this.onBargeInChunk(text, at);
      return;
    }
    if (!this.currentUtterance) {
      this.currentUtterance = { firstChunkAt: at, lastChunkAt: at, text };
    } else {
      this.currentUtterance.text += text;
      this.currentUtterance.lastChunkAt = at;
    }
    if (this.utteranceTimer !== null) this.clock.clearTimeout(this.utteranceTimer);
    this.utteranceTimer = this.clock.setTimeout(() => this.finalizeUtterance(), UTTERANCE_SILENCE_MS);
  }

  /** Выходной транскрипт модели (кусками или кумулятивно — набор слов всё равно тот же). */
  onModelTranscript(text: string, at = this.clock.now()) {
    const words = normalizeUtterance(text);
    if (words.length > 0) this.modelSpeech.push({ at, words });
    // Начало вопроса в аудио: сколько байт модели пришло до первого куска со словами вопроса.
    // Текст приходит со скоростью генерации, звук играет в реальном времени — момент, когда
    // владелец СЛЫШИТ вопрос, считается от первого кадра аудио плюс длительность филлера.
    if (this.pending && this.questionAudioOffset === null && (this.objectWords.length > 0 || this.tailIsIdentifying)) {
      const spoken = new Set(words);
      let heard = false;

      // 1. По названию объекта действия (спека §7.1 п. 3.1)
      if (this.objectWords.length >= 2) {
        let hits = 0;
        for (const w of this.objectWords) if (spoken.has(w)) hits++;
        if (hits >= Math.min(2, this.objectWords.length)) heard = true;
      } else if (this.objectWords.length === 1) {
        if (spoken.has(this.objectWords[0])) {
          // Для 1-словного объекта требуем также наличие слова вопроса (не аргумента),
          // чтобы филлер с одним случайным словом аргумента не считался вопросом.
          const sayWords = normalizeUtterance(this.pending.say);
          const nonObjSayWords = sayWords.filter((w) => w !== this.objectWords[0]);
          if (nonObjSayWords.some((w) => spoken.has(w))) heard = true;
        }
      }

      // 2. По хвосту вопроса (последние два слова say-фразы, спека §7.1 п. 3.1)
      if (!heard && this.tailIsIdentifying) {
        if (this.sayTailWords.every((w) => spoken.has(w))) heard = true;
      }

      if (heard) {
        this.earlyInjectedForQuestion = false;
        this.questionAudioOffset = this.audioSinceRequest;
        const playFrom = Math.max(this.firstAudioAt ?? at, this.priorPlaybackEnd);
        const offsetMs = (this.questionAudioOffset / BYTES_PER_SECOND_24K) * 1000;
        this.events.onQuestionHeardAt?.(this.pending, playFrom + offsetMs + QUESTION_HEARD_SLACK_MS, offsetMs);
      }
    }
    // Хранится только то, что ещё может вернуться эхом.
    this.modelSpeech = this.modelSpeech.filter((c) => at - c.at <= MODEL_ECHO_MEMORY_MS);
  }

  /**
   * Перебивание вопроса (окно ещё не открыто). Засчитывается только согласие:
   * отказ, шум и длинные фразы здесь ничего не решают — иначе эхо вопроса из
   * динамиков отменяло бы действие. Отказ — после вопроса или кнопкой.
   */
  private onBargeInChunk(text: string, at: number) {
    const p = this.pending;
    if (!p || p.verdict !== null) return;
    if (p.expiresAt <= at) {
      this.burn(p, "expired");
      return;
    }
    if (!this.bargeUtterance) {
      // Реплика, начатая раньше 1,5 с от запроса, — хвост просьбы владельца, не ответ:
      // отбрасывается вместе со всеми кусками до паузы.
      if (at - p.createdAt < BARGE_IN_MIN_MS) {
        this.tailUntil = at + UTTERANCE_SILENCE_MS;
        return;
      }
      this.bargeUtterance = { firstChunkAt: at, lastChunkAt: at, text };
    } else {
      this.bargeUtterance.text += text;
      this.bargeUtterance.lastChunkAt = at;
    }
    if (this.bargeTimer !== null) this.clock.clearTimeout(this.bargeTimer);
    this.bargeTimer = this.clock.setTimeout(() => this.finalizeBargeIn(), UTTERANCE_SILENCE_MS);
  }

  /**
   * Вопрос начал звучать У ВЛАДЕЛЬЦА: первый кадр аудио после запроса + длительность аудио
   * до куска с вопросом + запас. По тексту нельзя — он обгоняет звук (ревью advisor, приёмка PLUG-114).
   */
  private questionStarted(_p: PendingConfirmation, at: number): boolean {
    if (this.questionAudioOffset === null || this.firstAudioAt === null) return false;
    const playFrom = Math.max(this.firstAudioAt, this.priorPlaybackEnd);
    const startsAt = playFrom + (this.questionAudioOffset / BYTES_PER_SECOND_24K) * 1000 + QUESTION_HEARD_SLACK_MS;
    return at >= startsAt;
  }

  private finalizeBargeIn() {
    this.bargeTimer = null;
    const u = this.bargeUtterance;
    this.bargeUtterance = null;
    const p = this.pending;
    if (!u || !p || p.verdict !== null) return;
    if (p.expiresAt <= this.clock.now()) {
      this.burn(p, "expired");
      return;
    }
    // Эхо: все слова реплики есть в самом вопросе — это голос агента из динамиков.
    // Модель говорит вопрос своими словами («Да, конечно. Отправить…?») — её слова тоже эхо.
    const since = p.createdAt - MODEL_ECHO_BEFORE_REQUEST_MS;
    const sayWords = new Set([
      ...normalizeUtterance(`${p.say} ${p.card ?? ""}`),
      ...this.modelSpeech.filter((c) => c.at >= since).flatMap((c) => c.words),
    ]);
    const words = normalizeUtterance(u.text);
    if (words.length === 0 || words.every((w) => isEchoWord(w, sayWords))) return;
    if (classify(u.text, p.class, this.words) !== "approved") return;

    if (this.questionStarted(p, u.firstChunkAt)) {
      p.verdict = "approved";
      this.micOpen = true;
      this.events.onVerdict?.(p, "approved");
      return;
    }

    // Согласие до того, как вопрос зазвучал — раннее «да» (спека §7.1 п. 3.1)
    this.tailUntil = this.clock.now() + UTTERANCE_SILENCE_MS;
    if (!this.earlyInjectedForQuestion) {
      this.earlyInjectedForQuestion = true;
      if (this.events.onEarlyApproval) {
        this.resetQuestionTiming();
        this.events.onEarlyApproval(p);
      }
    }
  }

  /** Явный конец реплики от транспорта (VAD), не ждём 700 мс. */
  onOwnerUtteranceEnd(text: string, firstChunkAt: number, at = this.clock.now()) {
    const p = this.pending;
    if (!p) return;
    if (p.expiresAt <= at) {
      this.burn(p, "expired");
      return;
    }
    if (this.windowOpenAt === null || firstChunkAt < this.windowOpenAt) return;
    if (this.utteranceTimer !== null) {
      this.clock.clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }
    this.currentUtterance = { firstChunkAt, lastChunkAt: at, text };
    this.finalizeUtterance();
  }

  private finalizeUtterance() {
    this.utteranceTimer = null;
    const u = this.currentUtterance;
    this.currentUtterance = null;
    const p = this.pending;
    if (!u || !p || p.verdict !== null) return;
    if (p.expiresAt <= this.clock.now()) {
      this.burn(p, "expired");
      return;
    }

    // Эхо-фильтр в окне ответа (§7.1 п. 5):
    // В окне эхо-набор — только вопрос и карточка.
    const words = normalizeUtterance(u.text);
    if (words.length > 0) {
      const sayWords = new Set(normalizeUtterance(`${p.say} ${p.card ?? ""}`));
      if (words.every((w) => isEchoWord(w, sayWords))) {
        return; // Реплика, все слова которой — эхо, не решает ничего: ни approved, ни cancelled
      }
    }

    const verdict = classify(u.text, p.class, this.words);
    if (verdict === "hint") {
      // Подсказка не снимает pending; пока она звучит, шлюз снова закрыт,
      // окно переоткрывается по правилу п. 3 (спека §7.1 п. 5.3).
      this.resetWindow();
      this.micOpen = false;
      this.events.onConfirmationUpdate?.(p, "asking");
      return;
    }
    p.verdict = verdict;
    this.events.onVerdict?.(p, verdict);
    if (verdict !== "approved") this.burn(p, verdict);
  }

  /**
   * confirm_action от модели (режим native, спека §7.1 п. 4): если реплика ещё
   * не классифицирована, ждём окончания до 3 с, потом not_confirmed.
   */
  confirmAction(confirmationId: string): Promise<Verdict> {
    const at = this.clock.now();
    const p = this.pending;
    if (!p || p.confirmationId !== confirmationId) {
      return Promise.resolve(this.usedIds.has(confirmationId) ? "expired" : "not_confirmed");
    }
    if (p.expiresAt <= at) return Promise.resolve(this.burn(p, "expired"));
    if (p.verdict === "approved") return Promise.resolve("approved");
    if (p.verdict === "cancelled" || p.verdict === "expired") return Promise.resolve(p.verdict);
    return new Promise<Verdict>((resolve) => {
      const waiter = (v: Verdict) => resolve(v);
      const timer = this.clock.setTimeout(() => {
        const list = this.confirmWaiters.get(confirmationId);
        if (list) {
          this.confirmWaiters.set(
            confirmationId,
            list.filter((w) => w.resolve !== waiter),
          );
        }
        resolve("not_confirmed");
      }, TRANSCRIPT_WAIT_MS);
      const list = this.confirmWaiters.get(confirmationId) ?? [];
      list.push({ resolve: waiter, timer });
      this.confirmWaiters.set(confirmationId, list);
    });
  }

  /** Кнопки оверлея: явное действие владельца, равно approved/cancel (спека §7.1 п. 7). */
  decide(confirmationId: string, decision: "approve" | "cancel"): Verdict {
    const p = this.pending;
    if (!p || p.confirmationId !== confirmationId) return this.usedIds.has(confirmationId) ? "expired" : "not_confirmed";
    if (p.verdict !== null) return p.verdict;
    if (p.expiresAt <= this.clock.now()) return this.burn(p, "expired");
    const verdict: Verdict = decision === "approve" ? "approved" : "cancelled";
    p.verdict = verdict;
    // Аудит PLUG-108: решение кнопкой сразу открывает микрофон — владелец не говорит в пустоту
    // до конца исполнения или истечения срока.
    this.micOpen = true;
    this.events.onVerdict?.(p, verdict);
    // Отмена: исполнения нет — запись сгорает сразу, следующая запись не получает pending_exists.
    if (verdict === "cancelled") return this.burn(p, "cancelled");
    // Подтверждение: исполняет сервер немедленно; consume() после исполнения.
    return verdict;
  }

  /** TTL. Драйвер вызывает из своего таймера. */
  tick(): void {
    const p = this.pending;
    if (!p) return;
    const now = this.clock.now();
    if (p.expiresAt <= now) {
      this.burn(p, "expired");
      return;
    }
    // Резерв: playback_drained не пришёл (фон на телефоне, потерянный кадр) — окно
    // открывается по оценке сервера с запасом (спека §7.1 п. 3.7). Без этого микрофон
    // оставался закрыт до конца TTL и голосом ответить было нельзя (приёмка 02.11).
    if (this.windowOpenAt !== null || this.turnAudio.size === 0 || this.lastAudioAt === null) return;
    const estimate = this.estimateWindowAt();
    if (estimate === null) return;
    const quiet = now - this.lastAudioAt >= WINDOW_PADDING_MS;
    if (quiet && now >= estimate + DRAINED_LOST_SLACK_MS) {
      this.windowOpenAt = now + WINDOW_PADDING_MS;
      this.micOpen = true;
      this.events.onConfirmationUpdate?.(p, "listening");
    }
  }

  /** Драйвер исполнил действие — запись сгорает, id больше не действует. */
  consume(confirmationId: string): void {
    const p = this.pending;
    if (!p || p.confirmationId !== confirmationId) return;
    this.burn(p, "approved");
  }

  /** Вердикт зафиксирован, исполнение не требуется (отказ, отмена, истёк срок). */
  private burn(p: PendingConfirmation, verdict: Verdict): Verdict {
    const fireEvent = p.verdict === null;
    p.verdict = verdict;
    if (this.pending === p) this.pending = null;
    this.usedIds.add(p.confirmationId);
    this.recentVerdicts.set(p.argsHash, { verdict, at: this.clock.now() });
    this.falseClaimInjected = false;
    this.objectWords = [];
    this.sayTailWords = [];
    this.tailIsIdentifying = false;
    this.resetWindow();
    this.micOpen = true;
    if (fireEvent) {
      this.events.onVerdict?.(p, verdict);
    }
    for (const w of this.confirmWaiters.get(p.confirmationId) ?? []) {
      if (w.timer !== null) this.clock.clearTimeout(w.timer);
      w.resolve(verdict);
    }
    this.confirmWaiters.delete(p.confirmationId);
    // Первый вердикт (в т.ч. expired, нужный §14.10 для удаления превью) уже отдан через onVerdict выше.
    return verdict;
  }

  private resetWindow() {
    this.windowOpenAt = null;
    this.turnAudio.clear();
    this.turnDrained.clear();
    this.firstAudioAt = null;
    this.lastAudioAt = null;
    this.currentUtterance = null;
    if (this.utteranceTimer !== null) {
      this.clock.clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }
    this.bargeUtterance = null;
    if (this.bargeTimer !== null) {
      this.clock.clearTimeout(this.bargeTimer);
      this.bargeTimer = null;
    }
    if (this.windowTimer !== null) {
      this.clock.clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
  }

  resetQuestionTiming() {
    this.windowOpenAt = null;
    for (const seq of this.turnAudio.keys()) {
      this.maxInterruptedTurnSeq = Math.max(this.maxInterruptedTurnSeq, seq);
    }
    for (const seq of this.playingTurns.keys()) {
      this.maxInterruptedTurnSeq = Math.max(this.maxInterruptedTurnSeq, seq);
    }
    this.turnAudio.clear();
    this.turnDrained.clear();
    this.firstAudioAt = null;
    this.lastAudioAt = null;
    this.audioSinceRequest = 0;
    this.questionAudioOffset = null;
    this.playingTurns.clear();
    this.priorPlaybackEnd = 0;
    if (this.windowTimer !== null) {
      this.clock.clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
  }

  checkFalseClaim(turnText: string): boolean {
    const p = this.pending;
    if (!p || p.verdict !== null || this.falseClaimInjected) return false;
    if (isFalseClaim(turnText, p.say, p.actionTexts ?? [])) {
      this.falseClaimInjected = true;
      return true;
    }
    return false;
  }

  /** Ответ по недавнему вердикту этого argsHash — что отдать модели (спека §2.1). */
  recentVerdictText(hash: string): string | null {
    const r = this.recentVerdicts.get(hash);
    if (!r) return null;
    if (r.verdict === "approved") return "уже выполнено, больше не вызывай";
    return "владелец уже ответил на это действие — отменено";
  }

  argsHashOf(tool: string, args: Record<string, unknown>): string {
    return argsHash(tool, args);
  }
}
