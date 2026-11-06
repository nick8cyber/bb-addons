/**
 * Groq — фоллбэк №2 (спека §8): OpenAI-совместимый endpoint
 * `api.groq.com/openai/v1/audio/transcriptions`, модель по умолчанию
 * `whisper-large-v3-turbo`. Маппинг ошибок — как у codex.
 */
import {
  AiServiceFailure,
  ERROR_BODY_MAX_CHARS,
  RESPONSE_MAX_BYTES,
  type FailureCode,
} from "./contract.js";

export const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo";

/** Модели Groq, которым нужен `verbose_json` (спека §8). */
const VERBOSE_JSON_MODELS = new Set(["whisper-1", "whisper-large-v3", "whisper-large-v3-turbo"]);

export function groqResponseFormat(model: string): "verbose_json" | "json" {
  return VERBOSE_JSON_MODELS.has(model) ? "verbose_json" : "json";
}

function groqHttpErrorCode(status: number): [FailureCode, string] {
  if (status === 401) return ["auth_required", "groq_auth_failed"];
  if (status === 429) return ["rate_limited", "groq_rate_limited"];
  if (status >= 500) return ["service_unavailable", "groq_service_unavailable"];
  return ["request_failed", "groq_request_failed"];
}

function extractErrorMessage(body: string): string | null {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(collapsed);
    const find = (v: unknown): string | null => {
      if (typeof v === "string") {
        const s = v.replace(/\s+/g, " ").trim();
        return s.length > 0 ? s : null;
      }
      if (Array.isArray(v)) {
        for (const item of v) {
          const found = find(item);
          if (found !== null) return found;
        }
        return null;
      }
      if (v !== null && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        for (const key of ["message", "detail", "error"]) {
          if (obj[key] === undefined) continue;
          const found = find(obj[key]);
          if (found !== null) return found;
        }
      }
      return null;
    };
    return find(parsed) ?? collapsed;
  } catch {
    return collapsed;
  }
}

export interface TranscribeGroqOptions {
  apiKey: string;
  model: string;
  audio: Buffer;
  mimeType: string;
  filename: string;
  /** ISO-639-1 (`ru`) — сервер уже срезал регион с BCP-47. */
  language: string | null;
  hint: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function transcribeGroq(options: TranscribeGroqOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const inner = new AbortController();
  const timer = setTimeout(() => inner.abort(), options.timeoutMs);
  const onOuterAbort = () => inner.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(options.audio)], { type: options.mimeType }),
      options.filename,
    );
    form.set("model", options.model);
    form.set("response_format", groqResponseFormat(options.model));
    if (options.language !== null) form.set("language", options.language);
    if (options.hint !== null) form.set("prompt", options.hint);

    const headers = new Headers();
    headers.set("Authorization", `Bearer ${options.apiKey}`);

    const response = await fetchImpl(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers,
      body: form,
      signal: inner.signal,
    });
    if (!response.ok) {
      const prefix = `Groq transcription request failed with HTTP ${response.status}`;
      let detail: string | null = null;
      try {
        const body = await response.text();
        detail = extractErrorMessage(
          body.length > ERROR_BODY_MAX_CHARS ? `${body.slice(0, ERROR_BODY_MAX_CHARS)}...` : body,
        );
      } catch {
        detail = null;
      }
      throw new AiServiceFailure(
        ...groqHttpErrorCode(response.status),
        `${prefix}${detail ? `: ${detail}` : ""}`,
      );
    }
    const buf = await response.arrayBuffer();
    if (buf.byteLength > RESPONSE_MAX_BYTES) {
      throw new AiServiceFailure(
        "invalid_response",
        "groq_response_too_large",
        "Groq response exceeded the maximum supported size.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      throw new AiServiceFailure(
        "invalid_response",
        "groq_response_invalid",
        "Groq transcription response was not valid JSON.",
      );
    }
    const text =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["text"]
        : undefined;
    if (typeof text !== "string" || text.trim() === "") {
      throw new AiServiceFailure(
        "invalid_response",
        "groq_response_invalid",
        "Groq transcription response did not include transcript text.",
      );
    }
    return text;
  } catch (e) {
    if (e instanceof AiServiceFailure) throw e;
    if (options.signal?.aborted) {
      throw new AiServiceFailure(
        "request_failed",
        "groq_request_cancelled",
        "Groq request was cancelled",
      );
    }
    if (inner.signal.aborted) {
      throw new AiServiceFailure(
        "timeout",
        "groq_request_timeout",
        `Groq request timed out after ${options.timeoutMs}ms`,
      );
    }
    if (e instanceof Error && e.name === "AbortError") {
      throw new AiServiceFailure(
        "timeout",
        "groq_request_timeout",
        `Groq request timed out after ${options.timeoutMs}ms`,
      );
    }
    throw new AiServiceFailure(
      "request_failed",
      "groq_request_failed",
      `Groq transcription request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
