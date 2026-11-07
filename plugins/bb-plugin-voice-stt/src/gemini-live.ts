/**
 * Gemini Live STT — порт OmniFlow `GeminiLiveTranscriptionService.swift` +
 * `GeminiLiveTranscription.swift` (спека §6, ADR-0002 OmniFlow).
 *
 * Отличия от оригинала — только форма ввода: у нас готовый файл, не живой
 * поток, поэтому после setupComplete все чанки уходят подряд и сразу следом
 * `audioStreamEnd` (§6.7). Буфер pendingChunks (drop-oldest 200) не нужен:
 * аудио в сокет не пишется до setupComplete вообще.
 *
 * Аутентификация — ключ в query `?key=` (канонический способ Google и путь
 * live-call, §6.1). Значение ключа маскируется в логах и текстах ошибок.
 */
import { LiveTranscriptAccumulator } from "./accumulator.js";
import {
  AiServiceFailure,
  maskKeyParam,
  maskSecretValue,
  type FailureCode,
} from "./contract.js";

export const GEMINI_LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Режим транскрибации — uppercase (у batch Interactions API — lowercase "smart"). */
const SMART_MODE = "SMART";

/** ~100 мс PCM16 при 16 кГц (спека §6.2). */
const AUDIO_CHUNK_BYTES = 3_200;
const SAMPLE_RATE = 16_000;

/** PCM16 s16le mono 16 кГц = 32 байта на миллисекунду. */
const BYTES_PER_PCM_MS = 32;

// Адаптивный финиш — файловый режим (спека §6.6, поправка PLUG-126):
// файл уходит пачкой, транскрипт догоняет потоком — settle побольше живого
// режима, cap масштабируется длиной аудио и трактуется как ПРОВАЛ (урезанный
// текст никогда не возвращается), turnComplete сессию не завершает.
const FINISH_MIN_WAIT_MS = 800;
const FINISH_SETTLE_MS = 3_000;
const FINISH_TIMEOUT_BASE_MS = 8_000;
const FINISH_TIMEOUT_PER_AUDIO_MS = 0.4;
const FINISH_TIMEOUT_MAX_MS = 45_000;
const FINISH_POLL_MS = 80;

const CUSTOM_VOCABULARY_LIMIT = 1_000;

/** Сообщение «Check the transcription API key» — отказ до setupComplete (§6.3). */
const PRE_SETUP_FAILURE_MESSAGE =
  "Could not connect to Gemini live transcription. Check the transcription API key.";

/** Минимальный сокет для сессии — DOM WebSocket Node 22 удовлетворяет ему. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener?(type: string, listener: (event: never) => void): void;
}

export type WsFactory = (url: string) => WebSocketLike;

// --- Кадры протокола (порт GeminiLiveTranscription.swift) ---

export interface ServerFrame {
  /** serverContent.inputTranscription.text — финал сегмента, ЗАМЕНЯЕТ открытый. */
  transcript: string | null;
  /** serverContent.interimInputTranscription.text — интерим, ЗАМЕНЯЕТ открытый. */
  interimTranscript: string | null;
  activityStartsSegment: boolean;
  activityEndsSegment: boolean;
  /** turnComplete/generationComplete — конец СЕРВЕРНОГО хода, не сессии. */
  isComplete: boolean;
  errorMessage: string | null;
  isSetupComplete: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseServerFrame(text: string): ServerFrame {
  const frame: ServerFrame = {
    transcript: null,
    interimTranscript: null,
    activityStartsSegment: false,
    activityEndsSegment: false,
    isComplete: false,
    errorMessage: null,
    isSetupComplete: false,
  };
  let root: Record<string, unknown> | null = null;
  try {
    root = asRecord(JSON.parse(text));
  } catch {
    root = null;
  }
  if (root === null) return frame;

  const error = asRecord(root["error"]);
  if (error !== null) {
    frame.errorMessage =
      typeof error["message"] === "string" ? error["message"] : "Gemini live transcription failed.";
    frame.isComplete = true;
    return frame;
  }
  if (root["setupComplete"] !== undefined) {
    frame.isSetupComplete = true;
  }
  const voiceActivity = asRecord(root["voiceActivity"]);
  const activityType = voiceActivity?.["type"];
  if (typeof activityType === "string") {
    // У transcribe-live нет turnComplete: границы сегментов — voice activity.
    frame.activityStartsSegment = activityType === "ACTIVITY_START";
    frame.activityEndsSegment = activityType === "ACTIVITY_END";
  }
  const server = asRecord(root["serverContent"]);
  if (server === null) return frame;
  // Только два поля транскрипции; modelTurn (собственный вывод модели) игнорируется.
  const inputTranscription = asRecord(server["inputTranscription"]);
  const finalText = inputTranscription?.["text"];
  if (typeof finalText === "string") {
    frame.transcript = finalText;
  }
  const interim = asRecord(server["interimInputTranscription"]);
  const interimText = interim?.["text"];
  if (typeof interimText === "string") {
    // Пустая строка — валидный сброс сегмента, кормится как есть.
    frame.interimTranscript = interimText;
  }
  frame.isComplete = server["turnComplete"] === true || server["generationComplete"] === true;
  return frame;
}

/** Порт `GeminiTranscription.vocabularyTerms` (спека §6.4). */
export function vocabularyTerms(rawVocabulary: string): string[] {
  const terms = rawVocabulary
    .split(/[\n,;]/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const seen = new Set<string>();
  const deduplicated = terms.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduplicated.slice(0, CUSTOM_VOCABULARY_LIMIT);
}

export function normalizedModelPath(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("models/") ? trimmed : `models/${trimmed}`;
}

/**
 * Setup-кадр (спека §6.2). `custom_vocabulary` — осознанно snake_case, как у
 * OmniFlow (proto-JSON принимает исходные имена полей). `languageCodes` —
 * только когда язык задан; строковое поле `language` ЗАПРЕЩЕНО — с ним сервер
 * не отвечает setupComplete.
 */
export function setupMessage(options: {
  model: string;
  vocabularyTerms: string[];
  languageCodes: string[] | null;
}): string {
  const inputAudioTranscription: Record<string, unknown> = { mode: SMART_MODE };
  if (options.vocabularyTerms.length > 0) {
    inputAudioTranscription["custom_vocabulary"] = options.vocabularyTerms;
  }
  if (options.languageCodes !== null && options.languageCodes.length > 0) {
    inputAudioTranscription["languageCodes"] = options.languageCodes;
  }
  return JSON.stringify({
    setup: {
      model: normalizedModelPath(options.model),
      generationConfig: { responseModalities: ["TEXT"] },
      inputAudioTranscription,
    },
  });
}

export function audioMessage(pcm16: Buffer, sampleRate = SAMPLE_RATE): string {
  return JSON.stringify({
    realtimeInput: {
      audio: {
        mimeType: `audio/pcm;rate=${sampleRate}`,
        data: pcm16.toString("base64"),
      },
    },
  });
}

export const AUDIO_STREAM_END_MESSAGE = JSON.stringify({
  realtimeInput: { audioStreamEnd: true },
});

/** URL сессии. В лог и ошибки уходит только через maskKeyParam/maskSecretValue. */
export function socketUrl(apiKey: string): string {
  return `${GEMINI_LIVE_WS_URL}?key=${encodeURIComponent(apiKey)}`;
}

// --- Классификация сбоев ---

const AUTH_ERROR_RE =
  /api[ -]?key|permission|unauthenticated|unauthorized|forbidden|\b40[13]\b|PERMISSION_DENIED|UNAUTHENTICATED/i;
const QUOTA_ERROR_RE = /resource.?exhausted|quota|rate.?limit|\b429\b/i;
const UNAVAILABLE_RE = /unavailable|overloaded|\b5\d\d\b|INTERNAL\b/i;

function classifyGeminiError(message: string): FailureCode {
  if (QUOTA_ERROR_RE.test(message)) return "rate_limited";
  if (AUTH_ERROR_RE.test(message)) return "auth_required";
  if (UNAVAILABLE_RE.test(message)) return "service_unavailable";
  return "request_failed";
}

// --- Сессия (порт GeminiLiveTranscriptionService) ---

export interface GeminiLiveSessionOptions {
  apiKey: string;
  model: string;
  /** PCM16 s16le 16 kHz mono целиком. */
  pcm: Buffer;
  /** BCP-47 (`ru`, `ru-RU`) или null = автодетект. */
  language: string | null;
  /** Подсказка словаря (pre-trimmed) или null. */
  hint: string | null;
  /** Бюджет ключ-сессии (спека §5: ≤12 c). */
  timeoutMs: number;
  /** Бюджет connect+setup (спека §6.7: ≤5 c). */
  setupTimeoutMs?: number;
  signal?: AbortSignal;
  wsFactory?: WsFactory;
  /** Лог стадии — только факты/коды, без ключа и без транскрипта. */
  log?: (message: string) => void;
}

const defaultWsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

/**
 * Один заход на одном ключе. Возвращает накопленный текст — пустая строка
 * (тишина) валидна и трактуется стадией как мягкий провал (ADR-0002).
 * Любой сбой бросает AiServiceFailure.
 */
export function transcribeGeminiLive(options: GeminiLiveSessionOptions): Promise<string> {
  const {
    apiKey,
    model,
    pcm,
    language,
    hint,
    timeoutMs,
    signal,
    log = () => {},
  } = options;
  const setupTimeoutMs = options.setupTimeoutMs ?? 5_000;
  const wsFactory = options.wsFactory ?? defaultWsFactory;

  const url = socketUrl(apiKey);
  log(`gemini-live: connecting ${maskKeyParam(url)}`);

  return new Promise<string>((resolve, reject) => {
    const accumulator = new LiveTranscriptAccumulator();
    let ws: WebSocketLike | null = null;
    let setupCompleted = false;
    let streamEnded = false;
    let settled = false;
    let lastActivityAt = 0;
    let streamEndedAt = 0;
    let setupTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionTimer: ReturnType<typeof setTimeout> | null = null;
    let finishTimer: ReturnType<typeof setTimeout> | null = null;

    const failWith = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (setupTimer !== null) clearTimeout(setupTimer);
      if (sessionTimer !== null) clearTimeout(sessionTimer);
      if (finishTimer !== null) clearTimeout(finishTimer);
      signal?.removeEventListener("abort", onAbort);
      try {
        ws?.close();
      } catch {
        // закрытие мёртвого сокета — не ошибка
      }
      ws = null;
      const failure =
        error instanceof AiServiceFailure
          ? error
          : new AiServiceFailure(
              "request_failed",
              "gemini_live_error",
              maskSecretValue(error instanceof Error ? error.message : String(error), apiKey),
            );
      log(`gemini-live: failed ${failure.detailCode}: ${maskSecretValue(failure.message, apiKey)}`);
      reject(failure);
    };

    const done = (): void => {
      if (settled) return;
      settled = true;
      if (setupTimer !== null) clearTimeout(setupTimer);
      if (sessionTimer !== null) clearTimeout(sessionTimer);
      if (finishTimer !== null) clearTimeout(finishTimer);
      signal?.removeEventListener("abort", onAbort);
      try {
        ws?.close();
      } catch {
        // закрытие мёртвого сокета — не ошибка
      }
      ws = null;
      const text = accumulator.finalText();
      log(`gemini-live: finished with ${text.length} transcript characters`);
      resolve(text);
    };

    const onAbort = (): void => {
      failWith(
        new AiServiceFailure("timeout", "gemini_live_aborted", "Gemini live session was aborted"),
      );
    };

    // Cap финиша масштабируется длиной аудио (§6.6): файл ушёл пачкой, хвост
    // транскрипта догоняет примерно пропорционально его длительности.
    const audioMs = pcm.length / BYTES_PER_PCM_MS;
    const finishTimeoutMs = Math.min(
      FINISH_TIMEOUT_BASE_MS + audioMs * FINISH_TIMEOUT_PER_AUDIO_MS,
      FINISH_TIMEOUT_MAX_MS,
    );

    /** Адаптивный финиш (§6.6): settle → resolve; cap → ПРОВАЛ стадии. */
    const scheduleFinishCheck = (): void => {
      finishTimer = setTimeout(() => {
        finishTimer = null;
        if (settled || !streamEnded) return;
        const now = Date.now();
        const sinceEnd = now - streamEndedAt;
        const sinceLast = now - lastActivityAt;
        if (sinceEnd >= finishTimeoutMs) {
          // Кап при живом потоке кадров — текст, скорее всего, урезан.
          failWith(
            new AiServiceFailure(
              "timeout",
              "gemini_live_finish_timeout",
              `Gemini live transcript still arriving after ${finishTimeoutMs}ms`,
            ),
          );
          return;
        }
        if (sinceEnd >= FINISH_MIN_WAIT_MS && sinceLast >= FINISH_SETTLE_MS) {
          done();
          return;
        }
        scheduleFinishCheck();
      }, FINISH_POLL_MS);
    };

    const sendFrame = (message: string): boolean => {
      try {
        ws?.send(message);
        return true;
      } catch (e) {
        failWith(e);
        return false;
      }
    };

    /** Файловый режим (§6.7): все чанки подряд, затем audioStreamEnd. */
    const flushFileAudio = (): void => {
      for (let offset = 0; offset < pcm.length; offset += AUDIO_CHUNK_BYTES) {
        if (!sendFrame(audioMessage(pcm.subarray(offset, offset + AUDIO_CHUNK_BYTES)))) return;
      }
      streamEnded = true;
      streamEndedAt = Date.now();
      sendFrame(AUDIO_STREAM_END_MESSAGE);
      scheduleFinishCheck();
    };

    const socketFailure = (detail: string): void => {
      if (settled) return;
      // Отказ до setupComplete — Live API отклоняет плохие ключи на HTTP-апгрейде.
      failWith(
        setupCompleted
          ? new AiServiceFailure(
              "service_unavailable",
              "gemini_live_socket",
              `Gemini live socket closed before the final transcript: ${maskSecretValue(detail, apiKey)}`,
            )
          : new AiServiceFailure("service_unavailable", "gemini_live_socket", PRE_SETUP_FAILURE_MESSAGE),
      );
    };

    const handleFrame = (text: string): void => {
      const frame = parseServerFrame(text);
      if (frame.isSetupComplete) {
        setupCompleted = true;
        if (setupTimer !== null) {
          clearTimeout(setupTimer);
          setupTimer = null;
        }
        // Армим settle-таймер от setup: на чистой тишине интеримов не будет,
        // а адаптивный финиш всё равно должен сработать (§6.6).
        lastActivityAt = Date.now();
        flushFileAudio();
        return;
      }
      if (frame.errorMessage !== null) {
        const message = maskSecretValue(frame.errorMessage, apiKey);
        failWith(new AiServiceFailure(classifyGeminiError(message), "gemini_live_error", message));
        return;
      }
      if (
        frame.activityStartsSegment ||
        frame.activityEndsSegment ||
        frame.interimTranscript !== null ||
        frame.transcript !== null
      ) {
        // Любой кадр активности/транскрипта — доказательство живого распознавания.
        lastActivityAt = Date.now();
        if (frame.activityStartsSegment) accumulator.startSegment();
        if (frame.activityEndsSegment) accumulator.endSegment();
        if (frame.interimTranscript !== null) accumulator.feedInterim(frame.interimTranscript);
        if (frame.transcript !== null) accumulator.feedFinal(frame.transcript);
      }
      if (frame.isComplete) {
        // turnComplete закрывает серверный ХОД, не сессию; в файловом режиме
        // может прийти посреди буфера — коммитим сегмент, но не завершаем
        // (финиш только по settle, §6.6).
        accumulator.endSegment();
      }
    };

    const onMessage = (data: unknown): void => {
      if (settled) return;
      if (typeof data === "string") {
        handleFrame(data);
        return;
      }
      if (data instanceof Blob) {
        void data
          .text()
          .then((t) => {
            if (!settled) handleFrame(t);
          })
          .catch(() => {});
        return;
      }
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
      handleFrame(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
    };

    const onOpen = (): void => {
      const vocabulary = vocabularyTerms(hint ?? "");
      sendFrame(
        setupMessage({
          model,
          vocabularyTerms: vocabulary,
          languageCodes: language === null ? null : [language],
        }),
      );
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    sessionTimer = setTimeout(() => {
      sessionTimer = null;
      failWith(
        new AiServiceFailure(
          "timeout",
          "gemini_live_timeout",
          `Gemini live session timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    try {
      ws = wsFactory(url);
    } catch (e) {
      failWith(e);
      return;
    }
    // Бюджет connect+setup (спека §5): открытие сокета до setupComplete.
    setupTimer = setTimeout(() => {
      setupTimer = null;
      failWith(
        new AiServiceFailure(
          "timeout",
          "gemini_live_setup_timeout",
          `Gemini live setup timed out after ${setupTimeoutMs}ms`,
        ),
      );
    }, setupTimeoutMs);
    ws.addEventListener("open", onOpen as never);
    ws.addEventListener("message", ((ev: { data: unknown }) => onMessage(ev.data)) as never);
    ws.addEventListener("error", (() => socketFailure("websocket error")) as never);
    ws.addEventListener("close", ((ev: { code?: number; reason?: string }) =>
      socketFailure(`socket closed (${ev.code ?? "?"})${ev.reason ? `: ${ev.reason}` : ""}`)) as never);
  });
}
