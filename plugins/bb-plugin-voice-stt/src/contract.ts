/**
 * Единый источник правды проводных схем плагина (спека §5): zod-схемы host RPC
 * и общие типы/константы — их разделяют server.ts, host.ts и src/*.
 */
import { z } from "zod";

export const ENGINE_IDS = ["gemini-live", "codex", "groq"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

/** Множество кодов ошибок (спека §5 — как у provider-codex). */
export const FAILURE_CODES = [
  "timeout",
  "rate_limited",
  "service_unavailable",
  "auth_required",
  "request_failed",
  "invalid_response",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Аналог `AiServiceFailure` provider-codex: code уходит наверх, detailCode — в лог. */
export class AiServiceFailure extends Error {
  readonly code: FailureCode;
  readonly detailCode: string;
  constructor(code: FailureCode, detailCode: string, message: string) {
    super(message);
    this.name = "AiServiceFailure";
    this.code = code;
    this.detailCode = detailCode;
  }
}

export type FailureResult = { ok: false; code: FailureCode; message: string };

/** Порт `toAiServiceFailure` бандла: AbortError → timeout, прочее → request_failed. */
export function toFailureResult(e: unknown): FailureResult {
  if (e instanceof AiServiceFailure) {
    return { ok: false, code: e.code, message: e.message };
  }
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "AbortError") {
    return { ok: false, code: "timeout", message };
  }
  return { ok: false, code: "request_failed", message };
}

// --- Бюджеты и лимиты (спека §4.3, §5) ---

/** Внутренний бюджет цепочки (ядро даёт 70 c, прецедент codex 65 c). */
export const CHAIN_TIMEOUT_MS = 65_000;
/** RPC-таймаут вызова host-энтри: цепочка +1 c grace, как у provider-codex. */
export const HOST_CALL_TIMEOUT_MS = CHAIN_TIMEOUT_MS + 1_000;
/** Лимит входного аудио (как у provider-codex). */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** Стадия пропускается, если до общего дедлайна осталось меньше (спека §5). */
export const STAGE_MIN_REMAINING_MS = 5_000;
export const FFMPEG_TIMEOUT_MS = 4_000;
export const GEMINI_KEY_SESSION_MS = 12_000;
export const GEMINI_SETUP_TIMEOUT_MS = 5_000;
export const CODEX_TIMEOUT_MS = 15_000;
export const GROQ_TIMEOUT_MS = 15_000;
/** Бюджет host-вызова из status() — весь status ≤ 2 c (спека §4.3). */
export const STATUS_HOST_TIMEOUT_MS = 1_200;
/** Лимит ответа транскрибации (как у provider-codex). */
export const RESPONSE_MAX_BYTES = 1024 * 1024;
/** Срез тела ошибки для сообщения (как у provider-codex). */
export const ERROR_BODY_MAX_CHARS = 400;

// --- Схемы host RPC (спека §5) ---

export const transcribeConfigSchema = z
  .object({
    geminiKeys: z.array(z.string()),
    geminiLiveModel: z.string(),
    groqApiKey: z.string().nullable(),
    groqModel: z.string(),
    language: z.string().nullable(),
  })
  .strict();
export type TranscribeConfig = z.infer<typeof transcribeConfigSchema>;

const transcribeInput = z
  .object({
    audioBase64: z.string().min(1),
    mimeType: z.string(),
    filename: z.string(),
    hint: z.string().nullable(),
    config: transcribeConfigSchema,
    timeoutMs: z.number().int().positive(),
  })
  .strict();

const transcribeOutput = z.union([
  z
    .object({
      ok: z.literal(true),
      text: z.string(),
      engine: z.enum(ENGINE_IDS),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(FAILURE_CODES),
      message: z.string(),
    })
    .strict(),
]);

export const codexAuthStateSchema = z.enum(["ok", "missing", "invalid", "unusable", "expired"]);
export type CodexAuthState = z.infer<typeof codexAuthStateSchema>;

const statusOutput = z
  .object({
    codexAuth: codexAuthStateSchema,
    ffmpeg: z.boolean(),
  })
  .strict();

export const contract = {
  "voice-stt.transcribe": { input: transcribeInput, output: transcribeOutput },
  "voice-stt.status": { input: z.object({}).strict(), output: statusOutput },
} as const;

export type TranscribeInput = z.infer<typeof transcribeInput>;
export type TranscribeOutput = z.infer<typeof transcribeOutput>;

// --- Маскировка секретов (спека §6.1, §10) ---

/** Маскирует `?key=…` в URL и текстах. */
export function maskKeyParam(text: string): string {
  return text.replace(/([?&]key=)[^&\s]+/g, "$1…");
}

/** Вычищает конкретное значение ключа из текста ошибки перед пробросом наверх. */
export function maskSecretValue(text: string, secret: string | null | undefined): string {
  if (!secret) return maskKeyParam(text);
  return maskKeyParam(text.split(secret).join("…"));
}

// --- Язык (спека §4.1, §8) ---

const LANGUAGE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/** Нормализация настройки `language`: "" и невалидный BCP-47 → null. */
export function normalizeLanguage(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "" || !LANGUAGE_RE.test(s)) return null;
  return s;
}

/** Базовый субтег для провайдеров с ISO-639-1: `ru-RU` → `ru` (спека §8). */
export function languageBaseCode(language: string | null): string | null {
  if (language === null) return null;
  const base = language.split("-", 1)[0]?.trim() ?? "";
  return base === "" ? null : base;
}
