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
  INPUT_TRANSCRIPT_LAG_MS,
  TRANSCRIPT_WAIT_MS,
  UTTERANCE_SILENCE_MS,
  WINDOW_PADDING_MS,
  WINDOW_SERVER_SLACK_MS,
} from "./contract.js";
export const HINT_SPEECH_PEAK = 300;
export const HINT_SPEECH_MIN_MS = 150;
const SPEECH_BLOCK_SAMPLES = 320;
const SPEECH_BLOCK_BYTES = 640;
import {
  claimWordsOf,
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
  /** Снимки resolve встроенных инструментов, отделённые от пользовательских аргументов (PLUG-120 R1). */
  resolved?: Record<string, unknown>;
}

export type RequestResult =
  | { pending: PendingConfirmation }
  | { rejected: "pending_exists" | "recent_verdict"; message: string };

/**
 * Канонический хеш аргументов: отсортированные ключи, без пробелов (контракт §5).
 * Хеш считается по всем аргументам, которые уйдут исполнителю.
 * У ручек коннектора (имя с «__») хешируется ВЕСЬ payload без исключений (PLUG-120 R1).
 * Исключение _targetThread/_targetInteraction применяется ТОЛЬКО для встроенных инструментов с resolve.
 */
const RESOLVE_SNAPSHOT_KEYS = new Set(["_targetThread", "_targetInteraction"]);

export function argsHash(tool: string, args: Record<string, unknown>): string {
  const isConnector = tool.includes("__");
  const stable = isConnector
    ? args
    : Object.fromEntries(Object.entries(args).filter(([k]) => !RESOLVE_SNAPSHOT_KEYS.has(k)));
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

export type VerdictVia = "barge" | "window" | "button" | "system";

interface Utterance {
  firstChunkAt: number;
  lastChunkAt: number;
  text: string;
  vadStartAt?: number;
}

export interface GateEvents {
  /** Pending создан, изменён (подсказка) или открыт window: обновить оверлей и say. */
  onConfirmationUpdate?: (pending: PendingConfirmation, phase: "asking" | "listening", isHint?: boolean) => void;
  /** Вердикт определён. Исполнение — на вызывающей стороне. */
  onVerdict?: (p: PendingConfirmation, verdict: Verdict, via?: VerdictVia, utteranceAt?: number) => void;
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
  /**
   * Ответ владельца не распознан — одиночный шум (§7.1 п. 5.2).
   * Сервер прерывает модель и просит повторить вопрос подтверждения.
   */
  onUnrecognized?: (p: PendingConfirmation) => void;
  /**
   * Подсказка класса L/P (PLUG-120 п. 7): «Да» не подходит, модель говорит кодовое слово.
   */
  onHint?: (p: PendingConfirmation) => void;
  /**
   * Окно инвалидировано (PLUG-120 round-3, C1): позднее аудио подсказки закрывает окно и сбрасывает реплику.
   */
  onWindowInvalidated?: () => void;
}

/**
 * Проверка появления начала вопроса в транскрипте модели (§7.1 п. 3.1).
 * Слова шаблона идут по порядку, между соседними <= 1 вставленное слово,
 * и сразу после последнего слова шаблона идут слова объекта.
 */
export function matchesQuestionStart(words: string[], tw: string[], ow: string[]): boolean {
  if (ow.length === 0) return false;
  const matchObj = (startIdx: number): boolean => {
    if (startIdx + ow.length > words.length) return false;
    for (let k = 0; k < ow.length; k++) {
      if (words[startIdx + k] !== ow[k]) return false;
    }
    return true;
  };

  if (tw.length === 0) {
    for (let i = 0; i < words.length; i++) {
      if (matchObj(i)) return true;
    }
    return false;
  }

  function matchTemplate(wordIdx: number, tmplIdx: number): boolean {
    if (tmplIdx === tw.length) {
      return matchObj(wordIdx);
    }
    if (wordIdx >= words.length) return false;

    // 0 вставленных слов
    if (words[wordIdx] === tw[tmplIdx]) {
      if (matchTemplate(wordIdx + 1, tmplIdx + 1)) return true;
    }
    // 1 вставленное слово (только между словами шаблона: tmplIdx > 0)
    if (tmplIdx > 0 && wordIdx + 1 < words.length && words[wordIdx + 1] === tw[tmplIdx]) {
      if (matchTemplate(wordIdx + 2, tmplIdx + 1)) return true;
    }
    return false;
  }

  for (let i = 0; i < words.length; i++) {
    if (words[i] === tw[0]) {
      if (matchTemplate(i + 1, 1)) return true;
    }
  }
  return false;
}

/**
 * Запасное правило: проверка появления последних двух слов say подряд (§7.1 п. 3.1).
 */
export function matchesTail(words: string[], tailWords: string[]): boolean {
  if (tailWords.length !== 2 || words.length < 2) return false;
  for (let i = 0; i <= words.length - 2; i++) {
    if (words[i] === tailWords[0] && words[i + 1] === tailWords[1]) {
      return true;
    }
  }
  return false;
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
  /** Слова шаблона до первой « и первые два слова объекта внутри «...» (§7.1 п. 3.1) */
  private templateWords: string[] = [];
  private objectWords: string[] = [];
  private sayTailWords: string[] = [];
  private tailIsIdentifying = false;
  private hasQuotes = false;
  private unrecognizedCount = 0;
  private lastModelTurnTranscript = "";
  private questionTranscript = "";
  private recentVerdicts = new Map<string, { verdict: Verdict; at: number }>();
  private usedIds = new Set<string>();
  private confirmWaiters = new Map<string, Array<{ resolve: (v: Verdict) => void; timer: unknown }>>();
  private falseClaimInjected = false;
  private earlyInjectedForQuestion = false;
  private maxInterruptedTurnSeq = 0;
  private ended = false;
  private windowGeneration = 0;
  private hintTimer: unknown = null;
  private hintActive = false;
  private reaskTimer: unknown = null;
  private reaskActive = false;
  private speechEvidenceMs = 0;
  private speechResidual: Uint8Array = new Uint8Array(0);

  constructor(
    private words: ConfirmWords,
    private clock: GateClock = realClock,
    private events: GateEvents = {},
  ) {}

  setWords(words: ConfirmWords) {
    this.words = words;
  }

  private wordsFor(tool: string): ConfirmWords {
    const extra = this.words.toolExtras?.[tool] ?? (tool === "stop_thread" ? this.words.toolExtra : undefined) ?? [];
    return {
      ...this.words,
      toolExtra: extra,
    };
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
    if (this.ended) {
      return { rejected: "pending_exists", message: "звонок завершён" };
    }
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

    const resolved = !tool.includes("__")
      ? Object.fromEntries(Object.entries(args).filter(([k]) => RESOLVE_SNAPSHOT_KEYS.has(k)))
      : undefined;

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
      resolved: resolved && Object.keys(resolved).length > 0 ? resolved : undefined,
    };
    // Микрофон во время вопроса открыт: владелец может перебить вопрос словом
    // подтверждения (решение владельца 04.11, спека §7.1 п. 3.1). Защита от эха —
    // в onOwnerTranscriptChunk: до открытия окна засчитывается только согласие,
    // не раньше BARGE_IN_MIN_MS и не совпадающее со словами самого вопроса.
    this.falseClaimInjected = false;
    this.earlyInjectedForQuestion = false;
    this.unrecognizedCount = 0;
    this.questionTranscript = "";
    this.hintActive = false;
    this.reaskActive = false;
    if (this.reaskTimer !== null) {
      this.clock.clearTimeout(this.reaskTimer);
      this.reaskTimer = null;
    }
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
      // Начало вопроса (§7.1 п. 3.1): только кавычка «.
      // Слова шаблона — слова say до первой «.
      // Слова объекта — первые два слова внутри этой пары «...» (одно, если там одно слово).
      const firstQuoteIdx = say.indexOf("«");
      const match = say.match(/«([^»]+)»/);
      if (firstQuoteIdx >= 0 && match) {
        this.hasQuotes = true;
        const beforeQuote = say.slice(0, firstQuoteIdx);
        this.templateWords = claimWordsOf(beforeQuote);
        const quoteWords = claimWordsOf(match[1]);
        this.objectWords = quoteWords.slice(0, 2);

        const allQuoteWords = new Set(
          Array.from(say.matchAll(/«([^»]+)»/g)).flatMap((m) => claimWordsOf(m[1])),
        );
        const fullSayWords = claimWordsOf(say);
        this.sayTailWords = fullSayWords.slice(-2);
        this.tailIsIdentifying =
          this.sayTailWords.length === 2 &&
          this.sayTailWords.some((w) => allQuoteWords.has(w));
      } else {
        this.hasQuotes = false;
        this.templateWords = [];
        this.objectWords = [];
        this.sayTailWords = [];
        this.tailIsIdentifying = false;
      }
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

  getSpeechEvidenceMs(): number {
    return this.speechEvidenceMs;
  }

  isHintActive(): boolean {
    return this.hintActive;
  }

  isReaskActive(): boolean {
    return this.reaskActive;
  }

  private resetSpeechEvidence() {
    this.speechEvidenceMs = 0;
    this.speechResidual = new Uint8Array(0);
  }

  /**
   * Свидетельство новой речи в окне после подсказки (§7.1 п. 5.3 (б)).
   * Учитывается только валидный PCM текущего окна, фактически переданный в сессию.
   */
  recordOwnerSpeech(pcm: Uint8Array) {
    if (!this.hintActive || !this.windowOpen()) {
      return;
    }
    if (pcm.length % 2 !== 0) {
      return;
    }
    const totalBytes = this.speechResidual.length + pcm.length;
    const combined = new Uint8Array(totalBytes);
    combined.set(this.speechResidual, 0);
    combined.set(pcm, this.speechResidual.length);

    let offset = 0;
    while (offset + SPEECH_BLOCK_BYTES <= totalBytes) {
      let peak = 0;
      const view = new DataView(combined.buffer, combined.byteOffset + offset, SPEECH_BLOCK_BYTES);
      for (let i = 0; i < SPEECH_BLOCK_SAMPLES; i++) {
        const sample = view.getInt16(i * 2, true);
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
      }
      if (peak > HINT_SPEECH_PEAK) {
        this.speechEvidenceMs += 20;
      }
      offset += SPEECH_BLOCK_BYTES;
    }
    this.speechResidual = combined.slice(offset);
  }

  /** Аудио хода модели: байты PCM 24 кГц, помечены turnSeq (спека §7.1 п. 3.2). */
  onModelAudio(turnSeq: number, byteLen: number, at = this.clock.now()) {
    if (this.ended) return;
    if (turnSeq <= this.maxInterruptedTurnSeq) return;
    if (byteLen <= 0) return;
    if (this.hintTimer !== null) {
      this.clock.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    if (this.windowTimer !== null) {
      this.clock.clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    this.windowGeneration++;
    const tr = this.playingTurns.get(turnSeq) ?? { firstAt: at, bytes: 0 };
    tr.bytes += byteLen;
    this.playingTurns.set(turnSeq, tr);
    for (const [seq, t] of this.playingTurns) if (at - t.firstAt > 120_000) this.playingTurns.delete(seq);
    if (!this.pending) return;

    if (this.hintActive || this.reaskActive) {
      // (а) C1: каждый ненулевой PCM-кадр активного поколения подсказки или повтора
      // (в т.ч. после резервного открытия по таймеру 3 с) закрывает шлюз,
      // инвалидирует окно, снимает таймер окна и незавершённую реплику/таймер
      // классификации этого окна, сбрасывает свидетельство (§7.1 п. 5.2, п. 5.3).
      this.micOpen = false;
      this.windowOpenAt = null;
      ++this.windowGeneration;
      if (this.windowTimer !== null) {
        this.clock.clearTimeout(this.windowTimer);
        this.windowTimer = null;
      }
      if (this.hintTimer !== null) {
        this.clock.clearTimeout(this.hintTimer);
        this.hintTimer = null;
      }
      if (this.reaskTimer !== null) {
        this.clock.clearTimeout(this.reaskTimer);
        this.reaskTimer = null;
      }
      if (this.utteranceTimer !== null) {
        this.clock.clearTimeout(this.utteranceTimer);
        this.utteranceTimer = null;
      }
      this.currentUtterance = null;
      if (this.bargeTimer !== null) {
        this.clock.clearTimeout(this.bargeTimer);
        this.bargeTimer = null;
      }
      this.bargeUtterance = null;
      this.resetSpeechEvidence();
      this.events.onWindowInvalidated?.();
      this.events.onConfirmationUpdate?.(this.pending, "asking", this.hintActive);
    } else if (this.windowOpenAt !== null) {
      return;
    }

    this.audioSinceRequest += byteLen;
    if (!this.turnAudio.has(turnSeq)) this.turnAudio.set(turnSeq, 0);
    this.turnAudio.set(turnSeq, (this.turnAudio.get(turnSeq) ?? 0) + byteLen);
    this.turnDrained.delete(turnSeq);
    this.lastAudioAt = at;
    if (this.firstAudioAt === null) this.firstAudioAt = at;
  }

  onPlaybackDrained(turnSeq: number, at = this.clock.now()) {
    if (this.ended) return;
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
    if (this.ended || !this.pending || this.windowOpenAt !== null) return;
    if (this.turnAudio.size === 0) return;
    const allDrained = [...this.turnAudio.keys()].every((t) => this.turnDrained.has(t));
    const quiet = this.lastAudioAt !== null && at - this.lastAudioAt >= WINDOW_PADDING_MS;
    if (!allDrained || !quiet) return;
    if (this.windowTimer !== null) {
      this.clock.clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    const gen = ++this.windowGeneration;
    const estimate = this.estimateWindowAt();
    const openAt = Math.max(at, estimate ?? 0) + WINDOW_PADDING_MS;
    const open = () => {
      this.windowTimer = null;
      if (this.ended || !this.pending || this.windowOpenAt !== null) return;
      if (this.windowGeneration !== gen) return;
      const now = this.clock.now();
      const isAllDrained = [...this.turnAudio.keys()].every((t) => this.turnDrained.has(t));
      const isQuiet = this.lastAudioAt !== null && now - this.lastAudioAt >= WINDOW_PADDING_MS;
      if (!isAllDrained || !isQuiet) return;
      this.windowOpenAt = openAt;
      this.micOpen = true;
      this.resetSpeechEvidence();
      this.events.onConfirmationUpdate?.(this.pending, "listening", this.hintActive);
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
    if (this.ended) return;
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

  /** Выходной транскрипт модели (кусками или кумулятивно). */
  onModelTranscript(text: string, at = this.clock.now()) {
    const delta = this.lastModelTurnTranscript && text.startsWith(this.lastModelTurnTranscript)
      ? text.slice(this.lastModelTurnTranscript.length)
      : text;
    this.lastModelTurnTranscript = text;

    const words = claimWordsOf(text);
    if (words.length > 0) this.modelSpeech.push({ at, words });

    if (this.pending && this.questionAudioOffset === null && this.hasQuotes && (this.objectWords.length > 0 || this.tailIsIdentifying)) {
      if (delta) {
        this.questionTranscript = (this.questionTranscript ? this.questionTranscript + " " : "") + delta;
      }
      const questionWords = claimWordsOf(this.questionTranscript);
      let heard = matchesQuestionStart(questionWords, this.templateWords, this.objectWords);

      // Запасное правило по хвосту вопроса
      if (!heard && this.tailIsIdentifying && matchesTail(questionWords, this.sayTailWords)) {
        heard = true;
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

  onModelTurnComplete() {
    this.lastModelTurnTranscript = "";
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
      this.burn(p, "expired", "system");
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
    const wordsForTool = this.wordsFor(p.tool);
    if (classify(u.text, p.class, wordsForTool) !== "approved") return;

    const utteranceMoment = u.vadStartAt ?? (u.firstChunkAt - INPUT_TRANSCRIPT_LAG_MS);

    // Если в say есть « и вопрос зазвучал — засчитываем перебивание (§7.1 п. 3.1).
    // Без « question_heard не наступает, согласие разрешено только в окне.
    if (this.hasQuotes && this.questionStarted(p, utteranceMoment)) {
      p.verdict = "approved";
      this.micOpen = true;
      this.events.onVerdict?.(p, "approved", "barge", utteranceMoment);
      return;
    }

    // Согласие до того, как вопрос зазвучал, либо вопрос без « — раннее «да» (спека §7.1 п. 3.1).
    // Отброшенное согласие сервер не замалчивает, а вставляет системное сообщение.
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
  onOwnerUtteranceEnd(text: string, firstChunkAt: number, at = this.clock.now(), vadStartAt?: number) {
    if (this.ended) return;
    const p = this.pending;
    if (!p) return;
    if (p.expiresAt <= at) {
      this.burn(p, "expired", "system");
      return;
    }
    if (this.windowOpenAt === null || firstChunkAt < this.windowOpenAt) return;
    if (this.utteranceTimer !== null) {
      this.clock.clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }
    this.currentUtterance = { firstChunkAt, lastChunkAt: at, text, vadStartAt };
    this.finalizeUtterance();
  }

  private finalizeUtterance() {
    this.utteranceTimer = null;
    const u = this.currentUtterance;
    this.currentUtterance = null;
    const p = this.pending;
    if (!u || !p || p.verdict !== null) return;
    if (p.expiresAt <= this.clock.now()) {
      this.burn(p, "expired", "system");
      return;
    }

    const utteranceMoment = u.vadStartAt ?? (u.firstChunkAt - INPUT_TRANSCRIPT_LAG_MS);
    const words = normalizeUtterance(u.text);
    if (words.length === 0) return;

    // Эхо-фильтр в окне ответа (§7.1 п. 5):
    // В окне эхо-набор — только вопрос и карточка.
    const sayWords = new Set(normalizeUtterance(`${p.say} ${p.card ?? ""}`));
    if (words.every((w) => isEchoWord(w, sayWords))) {
      return; // Реплика, все слова которой — эхо, не решает ничего: ни approved, ни cancelled
    }

    const wordsForTool = this.wordsFor(p.tool);

    // 1. Отказ или стоп-слово (§7.1 п. 5.1)
    if (words.some((w) => wordsForTool.refuse.includes(w))) {
      p.verdict = "cancelled";
      this.events.onVerdict?.(p, "cancelled", "window", utteranceMoment);
      this.burn(p, "cancelled", "window", utteranceMoment);
      return;
    }

    // Проверяем наличие согласия любого класса (§7.1 п. 5.2)
    const allAgreements = new Set([
      ...this.words.confirm,
      ...this.words.permit,
      ...this.words.launch,
      ...(this.words.toolExtra ?? []),
      ...Object.values(this.words.toolExtras ?? {}).flat(),
    ]);
    const hasAnyAgreement = words.some((w) => allAgreements.has(w));

    if (!hasAnyAgreement) {
      // 2. Шум (§7.1 п. 5.2): нет ни согласия, ни отказа
      const nonEcho = words.filter((w) => !isEchoWord(w, sayWords));
      if (nonEcho.length === 0) {
        return; // пустая реплика — молча, без вставки и без счёта
      }
      if (nonEcho.length === 1) {
        if (this.unrecognizedCount === 0) {
          this.unrecognizedCount++;
          this.resetQuestionTiming();
          this.reaskActive = true;
          this.micOpen = false;
          this.events.onUnrecognized?.(p);
          this.events.onConfirmationUpdate?.(p, "asking");
          if (this.reaskTimer !== null) {
            this.clock.clearTimeout(this.reaskTimer);
            this.reaskTimer = null;
          }
          const gen = ++this.windowGeneration;
          this.reaskTimer = this.clock.setTimeout(() => {
            this.reaskTimer = null;
            if (this.ended || !this.pending || this.windowOpenAt !== null) return;
            if (this.windowGeneration !== gen) return;
            if (this.turnAudio.size > 0) return;
            const openAt = this.clock.now() + WINDOW_PADDING_MS;
            this.windowTimer = this.clock.setTimeout(() => {
              this.windowTimer = null;
              if (this.ended || !this.pending || this.windowOpenAt !== null) return;
              if (this.windowGeneration !== gen) return;
              this.windowOpenAt = openAt;
              this.micOpen = true;
              this.events.onConfirmationUpdate?.(this.pending, "listening");
            }, WINDOW_PADDING_MS);
          }, 3000);
          return;
        }
        // Второе нераспознанное одиночное слово → отмена
        this.reaskActive = false;
        p.verdict = "cancelled";
        this.events.onVerdict?.(p, "cancelled", "window", utteranceMoment);
        this.burn(p, "cancelled", "window", utteranceMoment);
        return;
      }
      // nonEcho.length > 1: отмена по п. 3 / п. 7
      this.reaskActive = false;
      p.verdict = "cancelled";
      this.events.onVerdict?.(p, "cancelled", "window", utteranceMoment);
      this.burn(p, "cancelled", "window", utteranceMoment);
      return;
    }

    const verdict = classify(u.text, p.class, wordsForTool, sayWords);
    if (verdict === "hint") {
      this.reaskActive = false;
      if (this.reaskTimer !== null) {
        this.clock.clearTimeout(this.reaskTimer);
        this.reaskTimer = null;
      }
      // Подсказка не снимает pending; пока она звучит, шлюз снова закрыт,
      // окно переоткрывается по правилу п. 3 (спека §7.1 п. 5.3).
      this.resetQuestionTiming();
      this.hintActive = true;
      this.resetSpeechEvidence();
      this.micOpen = false;
      this.events.onConfirmationUpdate?.(p, "asking", true);
      this.events.onHint?.(p);
      if (this.hintTimer !== null) {
        this.clock.clearTimeout(this.hintTimer);
        this.hintTimer = null;
      }
      const gen = ++this.windowGeneration;
      this.hintTimer = this.clock.setTimeout(() => {
        this.hintTimer = null;
        if (this.ended || !this.pending || this.windowOpenAt !== null) return;
        if (this.windowGeneration !== gen) return;
        if (this.turnAudio.size > 0) return;
        const openAt = this.clock.now() + WINDOW_PADDING_MS;
        this.windowTimer = this.clock.setTimeout(() => {
          this.windowTimer = null;
          if (this.ended || !this.pending || this.windowOpenAt !== null) return;
          if (this.windowGeneration !== gen) return;
          this.windowOpenAt = openAt;
          this.micOpen = true;
          this.resetSpeechEvidence();
          this.events.onConfirmationUpdate?.(this.pending, "listening", true);
        }, WINDOW_PADDING_MS);
      }, 3000);
      return;
    }
    if (verdict === "approved") {
      if (this.hintActive && this.speechEvidenceMs < HINT_SPEECH_MIN_MS) {
        // Эвристика свидетельства новой речи (§7.1 п. 5.3 (б)):
        // недостаточно валидной речи в текущем окне после подсказки.
        // Реплика заканчивается без вердикта, pending ждёт дальше.
        return;
      }
      this.hintActive = false;
      this.reaskActive = false;
    } else {
      this.hintActive = false;
      this.reaskActive = false;
    }
    p.verdict = verdict;
    this.events.onVerdict?.(p, verdict, "window", utteranceMoment);
    if (verdict !== "approved") this.burn(p, verdict, "window", utteranceMoment);
  }

  /**
   * confirm_action от модели (режим native, спека §7.1 п. 4): если реплика ещё
   * не классифицирована, ждём окончания до 3 с, потом not_confirmed.
   */
  confirmAction(confirmationId: string): Promise<Verdict> {
    if (this.ended) return Promise.resolve("cancelled");
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
    if (this.ended) return "cancelled";
    const p = this.pending;
    if (!p || p.confirmationId !== confirmationId) return this.usedIds.has(confirmationId) ? "expired" : "not_confirmed";
    if (p.verdict !== null) return p.verdict;
    if (p.expiresAt <= this.clock.now()) return this.burn(p, "expired", "button", this.clock.now());
    const verdict: Verdict = decision === "approve" ? "approved" : "cancelled";
    this.hintActive = false;
    this.reaskActive = false;
    if (this.reaskTimer !== null) {
      this.clock.clearTimeout(this.reaskTimer);
      this.reaskTimer = null;
    }
    this.resetSpeechEvidence();
    p.verdict = verdict;
    // Аудит PLUG-108: решение кнопкой сразу открывает микрофон — владелец не говорит в пустоту
    // до конца исполнения или истечения срока.
    this.micOpen = true;
    this.events.onVerdict?.(p, verdict, "button", this.clock.now());
    // Отмена: исполнения нет — запись сгорает сразу, следующая запись не получает pending_exists.
    if (verdict === "cancelled") return this.burn(p, "cancelled", "button", this.clock.now());
    // Подтверждение: исполняет сервер немедленно; consume() после исполнения.
    return verdict;
  }

  /** TTL. Драйвер вызывает из своего таймера. */
  tick(): void {
    if (this.ended) return;
    const p = this.pending;
    if (!p) return;
    const now = this.clock.now();
    if (p.expiresAt <= now) {
      this.burn(p, "expired", "system", now);
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
      this.resetSpeechEvidence();
      this.events.onConfirmationUpdate?.(p, "listening", this.hintActive);
    }
  }

  /** Драйвер исполнил действие — запись сгорает, id больше не действует. */
  consume(confirmationId: string): void {
    const p = this.pending;
    if (!p || p.confirmationId !== confirmationId) return;
    this.burn(p, "approved", "system", this.clock.now());
  }

  /** Вердикт зафиксирован, исполнение не требуется (отказ, отмена, истёк срок). */
  private burn(
    p: PendingConfirmation,
    verdict: Verdict,
    via: VerdictVia = "system",
    utteranceAt: number = this.clock.now(),
  ): Verdict {
    const fireEvent = p.verdict === null;
    p.verdict = verdict;
    this.hintActive = false;
    this.reaskActive = false;
    if (this.reaskTimer !== null) {
      this.clock.clearTimeout(this.reaskTimer);
      this.reaskTimer = null;
    }
    this.resetSpeechEvidence();
    if (this.pending === p) this.pending = null;
    this.usedIds.add(p.confirmationId);
    this.recentVerdicts.set(p.argsHash, { verdict, at: this.clock.now() });
    this.falseClaimInjected = false;
    this.unrecognizedCount = 0;
    this.hasQuotes = false;
    this.templateWords = [];
    this.objectWords = [];
    this.sayTailWords = [];
    this.tailIsIdentifying = false;
    this.questionTranscript = "";
    this.resetWindow();
    this.micOpen = true;
    if (fireEvent) {
      this.events.onVerdict?.(p, verdict, via, utteranceAt);
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
    this.windowGeneration++;
    this.turnAudio.clear();
    this.turnDrained.clear();
    this.firstAudioAt = null;
    this.lastAudioAt = null;
    this.currentUtterance = null;
    this.resetSpeechEvidence();
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
    if (this.hintTimer !== null) {
      this.clock.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    if (this.reaskTimer !== null) {
      this.clock.clearTimeout(this.reaskTimer);
      this.reaskTimer = null;
    }
  }

  resetQuestionTiming() {
    this.windowOpenAt = null;
    this.windowGeneration++;
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
    this.questionTranscript = "";
    this.resetSpeechEvidence();
    if (this.windowTimer !== null) {
      this.clock.clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    if (this.hintTimer !== null) {
      this.clock.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    if (this.reaskTimer !== null) {
      this.clock.clearTimeout(this.reaskTimer);
      this.reaskTimer = null;
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.hintActive = false;
    this.reaskActive = false;
    if (this.reaskTimer !== null) {
      this.clock.clearTimeout(this.reaskTimer);
      this.reaskTimer = null;
    }
    this.resetWindow();
    for (const waiters of this.confirmWaiters.values()) {
      for (const w of waiters) {
        if (w.timer !== null) this.clock.clearTimeout(w.timer);
        w.resolve("cancelled");
      }
    }
    this.confirmWaiters.clear();
    if (this.pending) {
      this.pending.verdict = "cancelled";
      this.pending = null;
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
