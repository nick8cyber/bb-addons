/**
 * LiveGeminiSession — потоковая Gemini Live STT-сессия для живого ввода
 * (спека voice-stt-live §4.3, §4.4). Общий каркас с `transcribeGeminiLive`
 * (src/gemini-live.ts), но режим другой: аудио идёт живым темпом чанками
 * `push`, а не файловым blast'ом.
 *
 * Отличия от файлового пути:
 * - кадры до `setupComplete` БУФЕРЯТСЯ и доливаются по порядку (клиент шлёт
 *   PCM сразу после hello, не дожидаясь ready — §4.2);
 * - `audioStreamEnd` уходит строго после последнего аудио-кадра (§4.2 —
 *   иначе сервер отбрасывает хвост, подтверждено живьём);
 * - финиш — исходные константы OmniFlow для живого потока: settle
 *   sinceEnd ≥ 0.8 c и sinceLastActivity ≥ 1.0 c → resolve; cap 6.0 c →
 *   провал; turnComplete после нашего streamEnd → resolve (§4.4).
 */
import { LiveTranscriptAccumulator } from "./accumulator.js";
import { AiServiceFailure, maskKeyParam, maskSecretValue } from "./contract.js";
import {
  AUDIO_STREAM_END_MESSAGE,
  PRE_SETUP_FAILURE_MESSAGE,
  audioMessage,
  classifyGeminiError,
  parseServerFrame,
  setupMessage,
  socketUrl,
  type WebSocketLike,
  type WsFactory,
} from "./gemini-live.js";

// Константы финиша живого стрима — исходные OmniFlow (§4.4). Файловые
// (3.0 c settle, масштабируемый cap) здесь НЕ применяются: в стриме сервер
// не отстаёт, интеримы уже шли.
export const LIVE_FINISH_MIN_WAIT_MS = 800;
export const LIVE_FINISH_SETTLE_MS = 1_000;
export const LIVE_FINISH_CAP_MS = 6_000;
const FINISH_POLL_MS = 80;

const DEFAULT_SETUP_TIMEOUT_MS = 5_000;

const defaultWsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

export interface LiveGeminiSessionOptions {
  apiKey: string;
  model: string;
  /** BCP-47 (`ru`, `ru-RU`) или null = автодетект. */
  language: string | null;
  /** Термины `custom_vocabulary` — с живого пути из настройки, не из hint. */
  vocabulary: string[];
  setupTimeoutMs?: number;
  wsFactory?: WsFactory;
  log?: (message: string) => void;
  /** Полный текст накопителя после каждого кадра транскрипта — для оверлея. */
  onInterim?: (text: string) => void;
  /** setupComplete — оверлей показывает «слушаю». */
  onSetupComplete?: () => void;
  /**
   * Фатальный сбой сессии (до или без `end`). Вызывается ровно один раз;
   * если `end()` уже ждёт — его промис тоже отклоняется тем же failure.
   */
  onFailure?: (failure: AiServiceFailure) => void;
}

export class LiveGeminiSession {
  private readonly options: LiveGeminiSessionOptions;
  private readonly accumulator = new LiveTranscriptAccumulator();
  private ws: WebSocketLike | null = null;
  private pending: Buffer[] = [];
  private setupCompleted = false;
  private endRequested = false;
  private streamEnded = false;
  private settled = false;
  private lastActivityAt = 0;
  private streamEndedAt = 0;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private endPromise: Promise<string> | null = null;
  private endResolve: ((text: string) => void) | null = null;
  private endReject: ((failure: AiServiceFailure) => void) | null = null;
  private terminalFailure: AiServiceFailure | null = null;

  constructor(options: LiveGeminiSessionOptions) {
    this.options = options;
  }

  private get log(): (message: string) => void {
    return this.options.log ?? (() => {});
  }

  /** Открыть сокет и послать setup. Идемпотентно. */
  open(): void {
    if (this.ws !== null || this.settled) return;
    const { apiKey } = this.options;
    const url = socketUrl(apiKey);
    const wsFactory = this.options.wsFactory ?? defaultWsFactory;
    this.log(`live-session: connecting ${maskKeyParam(url)}`);
    try {
      this.ws = wsFactory(url);
    } catch (e) {
      this.failWith(e);
      return;
    }
    const setupTimeoutMs = this.options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    this.setupTimer = setTimeout(() => {
      this.setupTimer = null;
      this.failWith(
        new AiServiceFailure(
          "timeout",
          "gemini_live_setup_timeout",
          `Gemini live setup timed out after ${setupTimeoutMs}ms`,
        ),
      );
    }, setupTimeoutMs);
    this.ws.addEventListener("open", (() => {
      this.sendFrame(
        setupMessage({
          model: this.options.model,
          vocabularyTerms: this.options.vocabulary,
          languageCodes: this.options.language === null ? null : [this.options.language],
        }),
      );
    }) as never);
    this.ws.addEventListener("message", ((ev: { data: unknown }) => this.onMessage(ev.data)) as never);
    this.ws.addEventListener("error", (() => this.socketFailure("websocket error")) as never);
    this.ws.addEventListener("close", ((ev: { code?: number; reason?: string }) =>
      this.socketFailure(`socket closed (${ev.code ?? "?"})${ev.reason ? `: ${ev.reason}` : ""}`)) as never);
  }

  /**
   * Очередной чанк PCM16 16 кГц. До setupComplete буферится (§4.3 п. 2),
   * после `end` — игнорируется (§9).
   */
  push(chunk: Buffer): void {
    if (this.settled || this.endRequested) return;
    if (!this.setupCompleted) {
      this.pending.push(Buffer.from(chunk));
      return;
    }
    this.sendAudio(chunk);
  }

  /**
   * Пользователь отпустил: дослать буфер, затем audioStreamEnd и ждать
   * финал по §4.4. Резолвится текстом (пустая строка валидна — решение
   * «тишина vs фоллбэк» принимает вызывающий по RMS). Сбой → reject
   * AiServiceFailure. Идемпотентно: повторный вызов даёт тот же промис.
   */
  end(): Promise<string> {
    if (this.endPromise !== null) return this.endPromise;
    this.endPromise = new Promise<string>((resolve, reject) => {
      this.endResolve = resolve;
      this.endReject = reject;
    });
    this.endRequested = true;
    if (this.settled) {
      // Сессия уже умерла — отклоняем сохранённым failure (пойдёт в фоллбэк).
      this.endReject?.(
        this.terminalFailure ??
          new AiServiceFailure(
            "service_unavailable",
            "gemini_live_socket",
            "Gemini live session ended before stream end",
          ),
      );
      return this.endPromise;
    }
    this.open(); // end до open — легально: дождёмся setup и завершимся пустым.
    if (this.setupCompleted) this.finishStream();
    return this.endPromise;
  }

  /** Отмена: сессия закрывается, ничего не транскрибируем (§4.2). */
  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.closeSocket();
    this.endReject?.(
      new AiServiceFailure(
        "request_failed",
        "live_session_cancelled",
        "Live dictation session was cancelled",
      ),
    );
  }

  private clearTimers(): void {
    if (this.setupTimer !== null) clearTimeout(this.setupTimer);
    if (this.finishTimer !== null) clearTimeout(this.finishTimer);
    this.setupTimer = null;
    this.finishTimer = null;
  }

  private closeSocket(): void {
    try {
      this.ws?.close();
    } catch {
      // закрытие мёртвого сокета — не ошибка
    }
    this.ws = null;
  }

  private failWith(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.closeSocket();
    const failure =
      error instanceof AiServiceFailure
        ? error
        : new AiServiceFailure(
            "request_failed",
            "gemini_live_error",
            maskSecretValue(
              error instanceof Error ? error.message : String(error),
              this.options.apiKey,
            ),
          );
    this.log(
      `live-session: failed ${failure.detailCode}: ${maskSecretValue(failure.message, this.options.apiKey)}`,
    );
    this.terminalFailure = failure;
    this.options.onFailure?.(failure);
    this.endReject?.(failure);
  }

  private done(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.closeSocket();
    const text = this.accumulator.finalText();
    this.log(`live-session: finished with ${text.length} transcript characters`);
    this.endResolve?.(text);
  }

  private sendFrame(message: string): boolean {
    try {
      this.ws?.send(message);
      return true;
    } catch (e) {
      this.failWith(e);
      return false;
    }
  }

  private sendAudio(chunk: Buffer): boolean {
    return this.sendFrame(audioMessage(chunk));
  }

  /** Долить буфер по порядку, затем при endRequested — audioStreamEnd. */
  private flushPending(): void {
    for (const chunk of this.pending) {
      if (!this.sendAudio(chunk)) return;
    }
    this.pending = [];
    if (this.endRequested && !this.streamEnded) this.finishStream();
  }

  /** §4.2: streamEnd строго после последнего аудио-кадра → ждать финал §4.4. */
  private finishStream(): void {
    if (this.streamEnded || this.settled) return;
    this.streamEnded = true;
    this.streamEndedAt = Date.now();
    if (!this.sendFrame(AUDIO_STREAM_END_MESSAGE)) return;
    this.scheduleFinishCheck();
  }

  /** Финиш §4.4: settle → resolve; cap 6 c → провал стадии. */
  private scheduleFinishCheck(): void {
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      if (this.settled || !this.streamEnded) return;
      const now = Date.now();
      const sinceEnd = now - this.streamEndedAt;
      const sinceLast = now - this.lastActivityAt;
      if (sinceEnd >= LIVE_FINISH_CAP_MS) {
        this.failWith(
          new AiServiceFailure(
            "timeout",
            "gemini_live_finish_timeout",
            `Gemini live transcript still arriving ${LIVE_FINISH_CAP_MS}ms after stream end`,
          ),
        );
        return;
      }
      if (sinceEnd >= LIVE_FINISH_MIN_WAIT_MS && sinceLast >= LIVE_FINISH_SETTLE_MS) {
        this.done();
        return;
      }
      this.scheduleFinishCheck();
    }, FINISH_POLL_MS);
  }

  private socketFailure(detail: string): void {
    if (this.settled) return;
    // Отказ до setupComplete — Live API отклоняет плохие ключи на HTTP-апгрейде.
    this.failWith(
      this.setupCompleted
        ? new AiServiceFailure(
            "service_unavailable",
            "gemini_live_socket",
            `Gemini live socket closed before the final transcript: ${maskSecretValue(detail, this.options.apiKey)}`,
          )
        : new AiServiceFailure("service_unavailable", "gemini_live_socket", PRE_SETUP_FAILURE_MESSAGE),
    );
  }

  private handleFrame(text: string): void {
    const frame = parseServerFrame(text);
    if (frame.isSetupComplete) {
      this.setupCompleted = true;
      if (this.setupTimer !== null) {
        clearTimeout(this.setupTimer);
        this.setupTimer = null;
      }
      // Армим settle от setup: на чистой тишине интеримов не будет,
      // а финиш всё равно должен сработать (§4.4).
      this.lastActivityAt = Date.now();
      this.options.onSetupComplete?.();
      this.flushPending();
      return;
    }
    if (frame.errorMessage !== null) {
      const message = maskSecretValue(frame.errorMessage, this.options.apiKey);
      this.failWith(new AiServiceFailure(classifyGeminiError(message), "gemini_live_error", message));
      return;
    }
    if (
      frame.activityStartsSegment ||
      frame.activityEndsSegment ||
      frame.interimTranscript !== null ||
      frame.transcript !== null
    ) {
      this.lastActivityAt = Date.now();
      if (frame.activityStartsSegment) this.accumulator.startSegment();
      if (frame.activityEndsSegment) this.accumulator.endSegment();
      if (frame.interimTranscript !== null) this.accumulator.feedInterim(frame.interimTranscript);
      if (frame.transcript !== null) this.accumulator.feedFinal(frame.transcript);
      this.options.onInterim?.(this.accumulator.current());
    }
    if (frame.isComplete) {
      // turnComplete после нашего audioStreamEnd завершает финал (§4.4);
      // посреди записи — просто коммит открытого сегмента.
      this.accumulator.endSegment();
      if (this.streamEnded) {
        this.options.onInterim?.(this.accumulator.current());
        this.done();
      }
    }
  }

  private onMessage(data: unknown): void {
    if (this.settled) return;
    if (typeof data === "string") {
      this.handleFrame(data);
      return;
    }
    if (data instanceof Blob) {
      void data
        .text()
        .then((t) => {
          if (!this.settled) this.handleFrame(t);
        })
        .catch(() => {});
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
    this.handleFrame(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
  }
}
