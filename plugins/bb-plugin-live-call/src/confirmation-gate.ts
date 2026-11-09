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
  REASK_SILENCE_MS,
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

export interface SpeechStart {
  turnSeq: number;
  playedMs: number;
  /** Момент прихода кадра (для speechAt в журнале). */
  at: number;
}

interface Utterance {
  firstChunkAt: number;
  lastChunkAt: number;
  text: string;
  vadStartAt?: number;
  /** Кадр speech_start браузера, привязанный к этой реплике (§7.2.1). */
  speechStart?: SpeechStart;
}

/**
 * Источник момента реплики (§7.2.1): кадр браузера speech_start; no_marker —
 * кадра не было; tail — реплика отброшена как хвост просьбы.
 */
export type TimingSource = "client" | "no_marker" | "tail";

export interface GateEvents {
  /** Pending создан, изменён (подсказка) или открыт window: обновить оверлей и say. */
  onConfirmationUpdate?: (pending: PendingConfirmation, phase: "asking" | "listening", isHint?: boolean) => void;
  /** Вердикт определён. Исполнение — на вызывающей стороне. timing — источник момента реплики (§7.2.1). */
  onVerdict?: (p: PendingConfirmation, verdict: Verdict, via?: VerdictVia, utteranceAt?: number, timing?: TimingSource) => void;
  /**
   * Расчётный момент, когда вопрос зазвучит у владельца (для журнала и приёмки).
   * offsetMs — длительность звука модели после запроса до начала вопроса (по байтам),
   * только журнал: на вердикт не влияет (§7.2.1).
   */
  onQuestionHeardAt?: (p: PendingConfirmation, at: number, offsetMs: number) => void;
  /**
   * Владелец сказал «да» до звука ответа — отброшенное раннее согласие.
   * Сервер прерывает модель и вставляет [СИСТЕМА]; вставка общего лимита —
   * одна на pending в сумме с повтором по тишине (§7.2.1–7.2.2).
   */
  onEarlyApproval?: (p: PendingConfirmation) => void;
  /**
   * Каждое отброшенное раннее «да» — в журнал early_approval (спека §7.2.2):
   * early (кадр, timing client), no_marker (без кадра), tail (отброшено как хвост).
   * Срабатывает на каждую реплику, включая те, что не вызвали вставку.
   */
  onEarlyApprovalLogged?: (
    p: PendingConfirmation,
    info: { speechAt: number; requestTurnSeq: number; timing: TimingSource },
  ) => void;
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
  /**
   * Решение по каждой реплике в пути перебивания при pending — журнал
   * barge_decision (спека §7.2.1, контракт §11).
   */
  onBargeDecision?: (p: PendingConfirmation, info: BargeDecision) => void;
  /**
   * Модель сказала вопрос длиннее say + 6 слов — метрика §7.2.3.
   */
  onQuestionLong?: (p: PendingConfirmation, words: number) => void;
  /**
   * Звук хода с вопросом доигран (playback_drained): длительность вопроса (§7.2.3).
   */
  onQuestionDuration?: (p: PendingConfirmation, at: number, offsetMs: number, durationMs: number) => void;
  /**
   * Вопрос не прозвучал у владельца (ход оборван/без итога), модель замолчала —
   * сервер один раз просит её повторить вопрос дословно (§7.2.1).
   */
  onReaskQuestion?: (p: PendingConfirmation) => void;
}

/**
 * Событие журнала barge_decision (спека §7.2.1): часы кадра speech_start и
 * снимок точки отсчёта на момент запроса, плюс итог. no_marker — реплика-
 * согласие без кадра: перебивание не засчитывается, обрабатывается как раннее.
 * tailSource — откуда взят момент начала хвоста: кадр браузера или оценка.
 */
export interface BargeDecision {
  turnSeq: number | null;
  playedMs: number | null;
  requestTurnSeq: number;
  requestTurnMs: number;
  tailSource?: "client" | "estimate";
  result: "approved" | "early" | "echo" | "not_approval" | "no_marker" | "tail";
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
  /**
   * Отброшенный хвост просьбы: накопленный текст, кадр и момент начала — для
   * журнала early_approval timing "tail", если хвостом оказалось настоящее «да»
   * (§7.2.1). Вставки по хвосту нет.
   */
  private tailText = "";
  private tailTimer: unknown = null;
  private tailStartAt = 0;
  private tailMarker: SpeechStart | undefined;
  /** Байты аудио модели после запроса (сквозь все ходы) и сколько их было до начала вопроса — журнал. */
  private audioSinceRequest = 0;
  private questionAudioOffset: number | null = null;
  /**
   * Снимок на момент запроса (§7.2.1): открытый ход или последний выданный
   * (0 до первого хода модели) и сколько мс его звука уже получено сервером.
   * Решение «до/после звука ответа» — только по кадру speech_start с ним.
   */
  private requestTurnSeq = 0;
  private requestTurnMs = 0;
  /** Весь звук каждого увиденного хода, байты — requestTurnMs и playedMs итогов. */
  private turnBytesTotal = new Map<number, number>();
  /**
   * Звук ответа реально проигран у владельца (playback_drained/stopped или
   * speech_start по критерию согласия §7.2.1) — условие резервного окна §7.1.
   */
  private responsePlayed = false;
  /** Последний кусок транскрипта владельца — счёт тишины для повтора вопроса (§7.2.1). */
  private lastOwnerChunkAt: number | null = null;
  /** Ход с транскриптом вопроса — только журнал (question_heard/durationMs/question_long), на решение не влияет. */
  private questionHeardTurnSeq: number | null = null;
  /** Старший turnSeq из увиденных — «последний выданный» для requestTurnSeq. */
  private maxSeenTurnSeq = 0;
  /**
   * Итог проигрывания хода у владельца (§7.2.1): доигран (playback_drained → вся
   * длительность) или оборван (playback_stopped → реально прозвучавшие мс).
   */
  private turnFinalPlayedMs = new Map<number, number>();
  /** Ходы, оборванные со стороны модели или сервера; playedMs ждёт кадра playback_stopped. */
  private interruptedTurns = new Set<number>();
  /** Куски транскрипта модели до совпадения вопроса — question_long только по ходу вопроса (§7.2.3). */
  private questionChunks: Array<{ seq: number | null; text: string }> = [];
  /** Оценка момента, когда вопрос зазвучал у владельца (для durationMs и журнала). */
  private questionHeardAtEst: number | null = null;
  private questionDrainedFired = false;
  private questionLongChecked = false;
  /**
   * Вставка «повтори вопрос дословно» — одна на pending в сумме (§7.2.1–7.2.2):
   * по тишине модели или по раннему «да»/no_marker, что раньше.
   */
  private questionReasked = false;
  /** Ходы модели, чей звук ещё может доигрываться: turnSeq → первый кадр и байты. */
  private playingTurns = new Map<number, { firstAt: number; bytes: number }>();
  /** Когда доиграет звук ходов, начатых до запроса (оценка сервера). */
  private priorPlaybackEnd = 0;
  /**
   * Последняя известная точка конца проигрыша у владельца (§7.2.1): приход
   * кадра playback_stopped/playback_drained или обрыв хода без итога.
   */
  private lastPlaybackEndAt: number | null = null;
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
   * Очередь кадров speech_start браузера (§7.2.1): каждый кадр привязывается к
   * ближайшей следующей реплике. Очередь, а не один слот: второй кадр не должен
   * затирать непривязанный первый.
   */
  private speechMarkers: SpeechStart[] = [];

  /** Кадр speech_start { turnSeq, playedMs } из браузера (§7.2.1). */
  onSpeechStart(turnSeq: number, playedMs: number, at = this.clock.now()) {
    if (this.ended) return;
    this.speechMarkers.push({ turnSeq, playedMs, at });
    if (this.speechMarkers.length > 8) this.speechMarkers.shift();
    // Кадр с проигранным звуком после запроса — звук ответа реально дошёл
    // до владельца: условие резервного окна §7.1 (тот же критерий, что у согласия).
    if (this.pending && this.postRequestPlayed(turnSeq, playedMs)) this.responsePlayed = true;
  }

  /**
   * Критерий «звук ответа реально проигран» (§7.2.1): ход позже requestTurnSeq
   * с playedMs > 0, либо тот же ход, но проиграно больше, чем было получено к запросу.
   * Кадры с turnSeq = 0 (хода ещё не было) звуком ответа не считаются.
   */
  private postRequestPlayed(turnSeq: number, playedMs: number): boolean {
    if (turnSeq <= 0) return false;
    return (
      (turnSeq > this.requestTurnSeq && playedMs > 0) ||
      (turnSeq === this.requestTurnSeq && playedMs > this.requestTurnMs)
    );
  }

  /**
   * Ожидаемый конец воспроизведения звука у владельца (§7.2.1 «модель молчит»):
   * ход без итога — приход первого куска + длительность полученного звука
   * (звук буферится ~×7 быстрее реального времени); ход с кадром
   * playback_stopped/playback_drained или обрывом — момент кадра/обрыва.
   */
  private expectedPlaybackEnd(): number {
    // priorPlaybackEnd не учитывается: пред-запросные ходы, ещё играющие, живут в playingTurns
    // и снимаются оттуда кадром stopped/drained — застывшая оценка задерживала бы повтор (ревью r9).
    let end = this.lastPlaybackEndAt ?? 0;
    for (const t of this.playingTurns.values()) {
      end = Math.max(end, t.firstAt + (t.bytes / BYTES_PER_SECOND_24K) * 1000);
    }
    return end;
  }

  /**
   * Ближайший к реплике кадр: самый ранний в пределах 3 с до её первого куска
   * (реальное начало речи; лаг транскрипта ~2 с). Кадр, пришедший после первого
   * куска реплики, к ней не привязывается и остаётся в очереди — он относится
   * к следующей реплике (спека §7.2.1, правка 09.11). Старшие кадры выбрасываются.
   */
  private takeSpeechMarker(firstChunkAt: number): SpeechStart | undefined {
    while (this.speechMarkers.length > 0 && firstChunkAt - this.speechMarkers[0].at > 3000) {
      this.speechMarkers.shift();
    }
    const head = this.speechMarkers[0];
    if (head && head.at <= firstChunkAt) return this.speechMarkers.shift();
    return undefined;
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
    this.questionReasked = false;
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
    this.clearTail();
    this.audioSinceRequest = 0;
    this.questionAudioOffset = null;
    // §7.2.1: снимок точки отсчёта — открытый ход или последний выданный
    // (0 до первого хода модели) и сколько мс его звука уже получено.
    this.requestTurnSeq = this.maxSeenTurnSeq;
    this.requestTurnMs = ((this.turnBytesTotal.get(this.requestTurnSeq) ?? 0) / BYTES_PER_SECOND_24K) * 1000;
    this.responsePlayed = false;
    this.lastOwnerChunkAt = null;
    this.questionHeardTurnSeq = null;
    this.questionHeardAtEst = null;
    this.questionDrainedFired = false;
    this.questionLongChecked = false;
    this.questionChunks = [];
    // Филлер, сгенерированный до вызова инструмента, ещё доигрывается: вопрос зазвучит после него.
    // playingTurns не очищается: доигрывающие ходы участвуют в ожидаемом конце
    // воспроизведения — точке отсчёта тишины повтора (§7.2.1 «модель молчит»).
    this.priorPlaybackEnd = 0;
    for (const t of this.playingTurns.values()) {
      this.priorPlaybackEnd = Math.max(this.priorPlaybackEnd, t.firstAt + (t.bytes / BYTES_PER_SECOND_24K) * 1000);
    }
    this.lastPlaybackEndAt = null;
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
    this.maxSeenTurnSeq = Math.max(this.maxSeenTurnSeq, turnSeq);
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
    this.turnBytesTotal.set(turnSeq, (this.turnBytesTotal.get(turnSeq) ?? 0) + byteLen);
    for (const seq of this.turnBytesTotal.keys()) if (seq < turnSeq - 64) this.turnBytesTotal.delete(seq);
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
    // Кадр об итоге проигрыша — новая точка ожидаемого конца воспроизведения (§7.2.1).
    this.lastPlaybackEndAt = Math.max(this.lastPlaybackEndAt ?? 0, at);
    if (!this.pending || this.windowOpenAt !== null) return;
    if (turnSeq <= this.maxInterruptedTurnSeq) return;
    if (!this.turnAudio.has(turnSeq)) this.turnAudio.set(turnSeq, 0);
    this.turnDrained.add(turnSeq);
    // Доигранный ход — finalPlayedMs = вся длительность его звука.
    // Уже зафиксированный итог (playback_stopped) не переписываем.
    const totalMs =
      (((this.turnBytesTotal.get(turnSeq) ?? this.turnAudio.get(turnSeq)) ?? 0) / BYTES_PER_SECOND_24K) * 1000;
    if (!this.turnFinalPlayedMs.has(turnSeq)) {
      this.turnFinalPlayedMs.set(turnSeq, totalMs);
    }
    this.interruptedTurns.delete(turnSeq);
    // Звук хода после запроса реально доигран — условие резервного окна §7.1.
    if (this.postRequestPlayed(turnSeq, totalMs)) this.responsePlayed = true;
    // §7.2.3: длительность вопроса — от оценки начала до playback_drained его хода (журнал).
    if (this.pending && this.questionHeardTurnSeq === turnSeq) {
      this.fireQuestionDuration(this.pending, at);
    }
    this.maybeOpenWindow(at);
  }

  /**
   * Кадр playback_stopped из браузера (§7.2.1): ход оборван, playedMs — реально
   * прозвучавший звук. Проигранный звук после запроса — условие резервного окна.
   */
  onPlaybackStopped(turnSeq: number, playedMs: number) {
    if (this.ended) return;
    // Итог хода записывается один раз — playback_stopped и playback_drained
    // уже закрытый ход не переписывают.
    if (!this.turnFinalPlayedMs.has(turnSeq)) {
      this.turnFinalPlayedMs.set(turnSeq, playedMs);
    }
    this.interruptedTurns.delete(turnSeq);
    this.playingTurns.delete(turnSeq);
    // Кадр об итоге проигрыша — новая точка ожидаемого конца воспроизведения (§7.2.1).
    this.lastPlaybackEndAt = Math.max(this.lastPlaybackEndAt ?? 0, this.clock.now());
    const p = this.pending;
    if (!p || p.verdict !== null || this.windowOpenAt !== null) return;
    if (this.postRequestPlayed(turnSeq, playedMs)) this.responsePlayed = true;
    if (turnSeq === this.questionHeardTurnSeq) {
      this.fireQuestionDuration(p, this.clock.now());
    }
    // Оборванный ход тоже закончился: окно может открыться по §7.1.
    this.turnDrained.add(turnSeq);
    this.maybeOpenWindow(this.clock.now());
  }

  /**
   * §7.2.1: пересоздание голосовой сессии или возврат браузера после обрыва —
   * ходы без итога (ни playback_drained, ни playback_stopped) помечаются
   * оборванными с неизвестным итогом; если среди них ход вопроса — точка
   * отсчёта сбрасывается до нового совпадения текста.
   */
  markUnfinishedTurnsInterrupted() {
    if (this.ended) return;
    const seqs = new Set<number>([...this.turnAudio.keys(), ...this.playingTurns.keys()]);
    let marked = false;
    for (const seq of seqs) {
      if (!this.turnFinalPlayedMs.has(seq)) {
        this.interruptedTurns.add(seq);
        this.playingTurns.delete(seq);
        marked = true;
      }
    }
    if (marked) this.lastPlaybackEndAt = Math.max(this.lastPlaybackEndAt ?? 0, this.clock.now());
  }

  /**
   * Сервер сообщает об обрыве хода со стороны модели (Gemini interrupted) или
   * своей вставки (§7.2.1): playedMs придёт кадром playback_stopped; до него и
   * без него (старый клиент) оценка «после вопроса» по этому ходу неприменима.
   */
  onModelInterrupted(turnSeq: number | null) {
    if (this.ended) return;
    const seq = turnSeq ?? this.maxSeenTurnSeq;
    if (this.turnDrained.has(seq) || this.turnFinalPlayedMs.has(seq)) return;
    this.interruptedTurns.add(seq);
    // Обрыв без итога: звук хода у владельца закончился примерно сейчас (§7.2.1) —
    // старый клиент без playback_stopped получит повтор через 4 с от обрыва.
    this.playingTurns.delete(seq);
    this.lastPlaybackEndAt = Math.max(this.lastPlaybackEndAt ?? 0, this.clock.now());
  }

  /**
   * Длительность вопроса в журнал (§7.2.3): один раз — по playback_drained хода
   * либо по вердикту, если он случился раньше (pending сгорает до drained).
   */
  private fireQuestionDuration(p: PendingConfirmation, at: number) {
    if (this.questionDrainedFired || this.questionHeardAtEst === null || this.questionAudioOffset === null) return;
    this.questionDrainedFired = true;
    const offsetMs = (this.questionAudioOffset / BYTES_PER_SECOND_24K) * 1000;
    this.events.onQuestionDuration?.(p, this.questionHeardAtEst, offsetMs, Math.max(0, at - this.questionHeardAtEst));
  }

  /** Оценка сервера страхует потерянный playback_drained (спека §7.1 п. 3.4). */
  private estimateWindowAt(): number | null {
    if (this.firstAudioAt === null) return null;
    const totalBytes = [...this.turnAudio.values()].reduce((a, b) => a + b, 0);
    const audioMs = (totalBytes / BYTES_PER_SECOND_24K) * 1000;
    return this.firstAudioAt + audioMs + WINDOW_SERVER_SLACK_MS;
  }

  /** Все ходы завершены: доиграны, оборваны или закрыты итогом (§7.2.1). */
  private allTurnsEnded(): boolean {
    return [...this.turnAudio.keys()].every(
      (t) => this.turnDrained.has(t) || this.interruptedTurns.has(t) || this.turnFinalPlayedMs.has(t),
    );
  }

  private maybeOpenWindow(at: number) {
    if (this.ended || !this.pending || this.windowOpenAt !== null) return;
    if (this.turnAudio.size === 0) return;
    // §7.2.1: окно — и основное, и резервное — только при проигранном звуке
    // ответа. Итог хода playedMs = 0 (или ≤ requestTurnMs для хода запроса)
    // не засчитывает проигрыш: владелец не слышал ни звука ответа.
    if (!this.responsePlayed) return;
    const allEnded = this.allTurnsEnded();
    const quiet = this.lastAudioAt !== null && at - this.lastAudioAt >= WINDOW_PADDING_MS;
    if (!allEnded || !quiet) return;
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
      const isAllEnded = this.allTurnsEnded();
      const isQuiet = this.lastAudioAt !== null && now - this.lastAudioAt >= WINDOW_PADDING_MS;
      if (!isAllEnded || !isQuiet) return;
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
    this.lastOwnerChunkAt = at;
    // Хвост реплики, начатой раньше: продлевается до 700 мс тишины и отбрасывается целиком
    // (§7.1 п. 3.1, п. 3.5; ревью PLUG-113, блокер B). Текст копится: если хвостом
    // оказалось настоящее «да», оно уйдёт в журнал early_approval timing "tail" (§7.2.1).
    if (at < this.tailUntil) {
      this.tailUntil = at + UTTERANCE_SILENCE_MS;
      this.tailText += text;
      if (this.tailTimer !== null) this.clock.clearTimeout(this.tailTimer);
      this.tailTimer = this.clock.setTimeout(() => this.finalizeTail(), UTTERANCE_SILENCE_MS);
      return;
    }
    // Реплика-перебивание, начатая до окна, доигрывается в том же пути, а не режется окном.
    if (this.bargeUtterance || this.windowOpenAt === null || at < this.windowOpenAt) {
      this.onBargeInChunk(text, at);
      return;
    }
    if (!this.currentUtterance) {
      this.currentUtterance = { firstChunkAt: at, lastChunkAt: at, text, speechStart: this.takeSpeechMarker(at) };
    } else {
      this.currentUtterance.text += text;
      this.currentUtterance.lastChunkAt = at;
    }
    if (this.utteranceTimer !== null) this.clock.clearTimeout(this.utteranceTimer);
    this.utteranceTimer = this.clock.setTimeout(() => this.finalizeUtterance(), UTTERANCE_SILENCE_MS);
  }

  /** Выходной транскрипт модели (кусками или кумулятивно). */
  onModelTranscript(text: string, at = this.clock.now(), turnSeq?: number | null) {
    {
      const seen = turnSeq ?? [...this.turnAudio.keys()].pop() ?? null;
      if (seen !== null) this.maxSeenTurnSeq = Math.max(this.maxSeenTurnSeq, seen);
    }
    const delta = this.lastModelTurnTranscript && text.startsWith(this.lastModelTurnTranscript)
      ? text.slice(this.lastModelTurnTranscript.length)
      : text;
    this.lastModelTurnTranscript = text;

    const words = claimWordsOf(text);
    if (words.length > 0) this.modelSpeech.push({ at, words });

    if (this.pending && this.hasQuotes && !this.questionLongChecked && (this.objectWords.length > 0 || this.tailIsIdentifying)) {
      if (delta) {
        this.questionTranscript = (this.questionTranscript ? this.questionTranscript + " " : "") + delta;
        // Куски транскрипта помечены ходом — question_long считается только по
        // ходу вопроса (§7.2.3). seq=null — кусок пришёл между ходами; undefined —
        // seq не передан (тесты): последний ход со звуком.
        const chunkSeq = turnSeq === undefined ? ([...this.turnAudio.keys()].pop() ?? null) : turnSeq;
        this.questionChunks.push({ seq: chunkSeq, text: delta });
      }
      if (this.questionAudioOffset === null) {
        const questionWords = claimWordsOf(this.questionTranscript);
        let heard = matchesQuestionStart(questionWords, this.templateWords, this.objectWords);

        // Запасное правило по хвосту вопроса
        if (!heard && this.tailIsIdentifying && matchesTail(questionWords, this.sayTailWords)) {
          heard = true;
        }

        if (heard) {
          // §7.2.1: место вопроса внутри хода для решения не определяется —
          // совпадение остаётся только для журнала (question_heard, durationMs,
          // question_long) и false_claim.
          this.questionAudioOffset = this.audioSinceRequest;
          this.questionHeardTurnSeq = turnSeq === undefined ? ([...this.turnAudio.keys()].pop() ?? null) : turnSeq;
          const playFrom = Math.max(this.firstAudioAt ?? at, this.priorPlaybackEnd);
          const offsetMs = (this.questionAudioOffset / BYTES_PER_SECOND_24K) * 1000;
          this.questionHeardAtEst = playFrom + offsetMs + QUESTION_HEARD_SLACK_MS;
          this.events.onQuestionHeardAt?.(this.pending, this.questionHeardAtEst, offsetMs);
        }
      }
    }
    // Хранится только то, что ещё может вернуться эхом.
    this.modelSpeech = this.modelSpeech.filter((c) => at - c.at <= MODEL_ECHO_MEMORY_MS);
  }

  /** Куски транскрипта вопросного хода (seq неизвестен — считаем своим). */
  private questionTurnChunks() {
    return this.questionChunks.filter(
      (c) => this.questionHeardTurnSeq === null || c.seq === null || c.seq === this.questionHeardTurnSeq,
    );
  }

  /** Слова транскрипта хода с вопросом — для question_long (§7.2.3). */
  private questionTurnWords(): string[] {
    return this.questionTurnChunks().flatMap((c) => claimWordsOf(c.text));
  }

  onModelTurnComplete(_turnSeq?: number) {
    this.lastModelTurnTranscript = "";
    // §7.2.3: модель должна читать say дословно; длинный вопрос — в журнал.
    // Считаются только слова хода с вопросом, начиная с первого слова вопроса —
    // фраза ожидания перед ним длину не раздувает.
    const p = this.pending;
    if (p && this.questionAudioOffset !== null && !this.questionLongChecked) {
      this.questionLongChecked = true;
      const words = this.questionTurnWords();
      const anchor = this.templateWords[0] ?? this.objectWords[0] ?? this.sayTailWords[0];
      const idx = anchor ? words.indexOf(anchor) : -1;
      const said = idx >= 0 ? words.length - idx : words.length;
      const allowed = claimWordsOf(p.say).length + 6;
      if (said > allowed) {
        this.events.onQuestionLong?.(p, said);
      }
    }
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
      // отбрасывается вместе со всеми кусками до паузы. Решение — тоже в журнал
      // (спека §7.2.1: barge_decision пишется на каждую реплику пути перебивания).
      const m = this.takeSpeechMarker(at);
      // §7.2.1: момент начала реплики — приход кадра speech_start; без кадра —
      // оценка firstChunkAt − 2 с. Оценка допустима: она только отбрасывает.
      const startedAt = m?.at ?? at - INPUT_TRANSCRIPT_LAG_MS;
      if (startedAt - p.createdAt < BARGE_IN_MIN_MS) {
        this.tailUntil = at + UTTERANCE_SILENCE_MS;
        this.tailText = text;
        this.tailMarker = m;
        this.tailStartAt = startedAt;
        if (this.tailTimer !== null) this.clock.clearTimeout(this.tailTimer);
        this.tailTimer = this.clock.setTimeout(() => this.finalizeTail(), UTTERANCE_SILENCE_MS);
        this.events.onBargeDecision?.(p, {
          turnSeq: m?.turnSeq ?? null,
          playedMs: m?.playedMs ?? null,
          requestTurnSeq: this.requestTurnSeq,
          requestTurnMs: Math.round(this.requestTurnMs),
          tailSource: m ? "client" : "estimate",
          result: "tail",
        });
        return;
      }
      this.bargeUtterance = { firstChunkAt: at, lastChunkAt: at, text, speechStart: m };
    } else {
      this.bargeUtterance.text += text;
      this.bargeUtterance.lastChunkAt = at;
    }
    if (this.bargeTimer !== null) this.clock.clearTimeout(this.bargeTimer);
    this.bargeTimer = this.clock.setTimeout(() => this.finalizeBargeIn(), UTTERANCE_SILENCE_MS);
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
    const questionWords = new Set(normalizeUtterance(`${p.say} ${p.card ?? ""}`));
    const sayWords = new Set([
      ...questionWords,
      ...this.modelSpeech.filter((c) => c.at >= since).flatMap((c) => c.words),
    ]);
    const words = normalizeUtterance(u.text);
    const bargeDecision = (result: BargeDecision["result"]) =>
      this.events.onBargeDecision?.(p, {
        turnSeq: u.speechStart?.turnSeq ?? null,
        playedMs: u.speechStart?.playedMs ?? null,
        requestTurnSeq: this.requestTurnSeq,
        requestTurnMs: Math.round(this.requestTurnMs),
        result,
      });
    if (words.length === 0 || words.every((w) => isEchoWord(w, sayWords))) {
      bargeDecision("echo");
      return;
    }
    const wordsForTool = this.wordsFor(p.tool);
    // Остаток для классификации — после удаления эха только вопроса и карточки, как в окне (§7.1 п. 5.3):
    // «Да, отправь.» во время «Отправить в тред: …?» — согласие. Широкий набор с речью модели выше
    // решает лишь, не эхо ли вся реплика, иначе «да» с уточнением из слов филлера засчитывалось бы.
    if (classify(u.text, p.class, wordsForTool, questionWords) !== "approved") {
      bargeDecision("not_approval");
      return;
    }

    const utteranceMoment = u.vadStartAt ?? (u.firstChunkAt - INPUT_TRANSCRIPT_LAG_MS);

    // §7.2.1: решение — только по кадру speech_start против снимка запроса:
    // turnSeq > requestTurnSeq && playedMs > 0, либо тот же ход с playedMs >
    // requestTurnMs. Без кадра перебивание не засчитывается (no_marker = раннее).
    const m = u.speechStart;
    if (m && this.postRequestPlayed(m.turnSeq, m.playedMs)) {
      bargeDecision("approved");
      p.verdict = "approved";
      this.micOpen = true;
      // §7.2.3: вердикт в середине вопроса тоже закрывает durationMs —
      // playback_drained после него уже не придёт с pending.
      this.fireQuestionDuration(p, utteranceMoment);
      this.events.onVerdict?.(p, "approved", "barge", utteranceMoment, "client");
      return;
    }

    // Согласие до звука ответа (early) или без кадра (no_marker) — раннее «да»:
    // журнал на каждое, вставка — общий лимит одна на pending (§7.2.1–7.2.2).
    bargeDecision(m ? "early" : "no_marker");
    this.tailUntil = this.clock.now() + UTTERANCE_SILENCE_MS;
    this.events.onEarlyApprovalLogged?.(p, {
      speechAt: m?.at ?? utteranceMoment,
      requestTurnSeq: this.requestTurnSeq,
      timing: m ? "client" : "no_marker",
    });
    if (!this.questionReasked) {
      this.questionReasked = true;
      if (this.events.onEarlyApproval) {
        this.resetQuestionTiming();
        this.events.onEarlyApproval(p);
      }
    }
  }

  /**
   * Хвост закончился (700 мс тишины): если в нём было настоящее «да» —
   * журнал early_approval timing "tail", без вставки (§7.2.1–7.2.2).
   */
  private finalizeTail() {
    this.tailTimer = null;
    const text = this.tailText;
    const marker = this.tailMarker;
    const startedAt = this.tailStartAt;
    this.clearTail();
    const p = this.pending;
    if (!p || p.verdict !== null || !text.trim()) return;
    const questionWords = new Set(normalizeUtterance(`${p.say} ${p.card ?? ""}`));
    const words = normalizeUtterance(text);
    if (words.length === 0 || words.every((w) => isEchoWord(w, questionWords))) return;
    if (classify(text, p.class, this.wordsFor(p.tool), questionWords) !== "approved") return;
    this.events.onEarlyApprovalLogged?.(p, {
      speechAt: marker?.at ?? startedAt,
      requestTurnSeq: this.requestTurnSeq,
      timing: "tail",
    });
  }

  private clearTail() {
    this.tailText = "";
    this.tailMarker = undefined;
    this.tailStartAt = 0;
    if (this.tailTimer !== null) {
      this.clock.clearTimeout(this.tailTimer);
      this.tailTimer = null;
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
    this.currentUtterance = { firstChunkAt, lastChunkAt: at, text, vadStartAt, speechStart: this.takeSpeechMarker(firstChunkAt) };
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
    // §7.2.1: модель после запроса так и не заговорила и молчит
    // REASK_SILENCE_MS тишины У ВЛАДЕЛЬЦА и без реплики владельца — один повтор
    // вопроса дословно. Лимит вставки общий с ранним «да» (questionReasked).
    // Тишина — от ожидаемого конца воспроизведения (звук буферится ~×7 быстрее
    // реального времени, приход последнего куска не годится) либо от кадра
    // playback_stopped/drained/обрыва. «Модель молчит» — пока звук ответа не
    // подтверждён проигранным: уже полученный, но не доигранный звук повтор
    // не блокирует. Молчит и после повтора — окна нет, только кнопка или
    // голос, когда модель заговорит.
    if (
      !this.questionReasked &&
      p.verdict === null &&
      this.windowOpenAt === null &&
      !this.responsePlayed &&
      !this.hintActive &&
      !this.reaskActive &&
      !this.bargeUtterance &&
      !this.currentUtterance &&
      now - Math.max(p.createdAt, this.lastOwnerChunkAt ?? 0, this.expectedPlaybackEnd()) >= REASK_SILENCE_MS
    ) {
      this.questionReasked = true;
      this.resetQuestionTiming();
      this.events.onReaskQuestion?.(p);
    }
    // Резерв: playback_drained не пришёл (фон на телефоне, потерянный кадр) — окно
    // открывается по оценке сервера с запасом (спека §7.1 п. 3.7). §7.2.1: резерв
    // действует только если звук ответа реально проигран у владельца
    // (playback_drained/stopped хода после запроса или speech_start по критерию согласия).
    if (this.windowOpenAt !== null || this.turnAudio.size === 0 || this.lastAudioAt === null) return;
    if (!this.responsePlayed) return;
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
    // Вердикт до конца звука вопроса: durationMs закрываем сразу (§7.2.3).
    this.fireQuestionDuration(p, utteranceAt);
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
    // §7.2.3: длительность вопроса, оборванного сбросом точки отсчёта (раннее
    // «да», переспрос, подсказка, обрыв хода), — в журнал до очистки полей.
    if (this.pending && this.pending.verdict === null) {
      this.fireQuestionDuration(this.pending, this.clock.now());
    }
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
    this.questionHeardTurnSeq = null;
    this.questionHeardAtEst = null;
    this.questionDrainedFired = false;
    this.questionLongChecked = false;
    this.questionChunks = [];
    // Новое поколение вопроса: старый звук ответа не считается проигранным —
    // резервное окно снова ждёт подтверждения проигрыша. Общий лимит вставки
    // (questionReasked) и снимок запроса (requestTurnSeq/requestTurnMs) НЕ сбрасываются.
    this.responsePlayed = false;
    this.clearTail();
    this.playingTurns.clear();
    this.priorPlaybackEnd = 0;
    this.lastPlaybackEndAt = null;
    this.questionTranscript = "";
    // Модель повторит вопрос возможно тем же текстом: поток транскрипта сброшен,
    // иначе дельта следующего хода пустая и совпадения больше не будет.
    this.lastModelTurnTranscript = "";
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
