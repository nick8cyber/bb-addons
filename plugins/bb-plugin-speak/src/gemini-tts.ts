/**
 * The Gemini TTS REST client — `fetch` and nothing else.
 *
 * The API key belongs to the server alone. It goes into the query string
 * because that is where `generativelanguage.googleapis.com` takes it, which
 * means every string that leaves this module (a message, a log line) has to be
 * run through `redact` first: Google's own error bodies quote the request URL
 * back at you, key included.
 *
 * What comes back is `audio/L16;codec=pcm;rate=24000` — raw 24 kHz mono 16-bit
 * little-endian samples with no container at all. `wrapPcmAsWav` puts the
 * 44-byte RIFF header on them, because that is the one thing an `<audio>`
 * element will play without a decoder of our own.
 */
import {
  GEMINI_BASE_URL,
  PCM_CHANNELS,
  PCM_SAMPLE_RATE,
  PCM_SAMPLE_WIDTH,
  type SynthesisErrorCode,
} from "./contract.js";

/**
 * Longer than the Cloud client's 30s: Gemini generates the speech rather than
 * concatenating units, and a full chunk of it is measurably slower.
 */
const TIMEOUT_MS = 60_000;

/** Google's error bodies can be long; the first few lines say what is wrong. */
const MAX_QUOTED = 300;

export type TtsFailure = {
  ok: false;
  code: SynthesisErrorCode;
  message: string;
  /**
   * For a 429 only: whether the allowance that ran out is the daily one or the
   * per-minute one. They arrive as the same status and mean very different
   * things — a burst of parallel chunks trips the minute, and treating that as
   * the day would bench a model until midnight over a momentary spike.
   */
  quotaScope?: "day" | "burst";
  /** What Google's RetryInfo asked for, in ms, when it said. */
  retryAfterMs?: number;
};

/** Strip anything that could be the key out of text on its way to a human. */
function redact(text: string, apiKey: string): string {
  let safe = text.replace(/key=[^&\s"'`)\]}]*/gi, "key=REDACTED");
  if (apiKey.length >= 8) safe = safe.split(apiKey).join("REDACTED");
  return safe;
}

function fail(code: SynthesisErrorCode, message: string, extra: Partial<TtsFailure> = {}): TtsFailure {
  return { ok: false, code, message, ...extra };
}

/**
 * Which allowance a 429 is about. Google names the metric in the body —
 * `...PerDay` / `PerDayPerProject` for the daily one, `PerMinute` for the
 * other — and usually attaches a RetryInfo. When it names neither, assume the
 * cheaper reading: a burst, recoverable in a minute, rather than a day gone.
 */
export function readQuotaScope(body: string): { scope: "day" | "burst"; retryAfterMs?: number } {
  const retry = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(body);
  const retryAfterMs = retry ? Math.round(Number(retry[1]) * 1000) : undefined;
  const perDay = /per[_\s-]?day|PerDayPerProject|RequestsPerDay/i.test(body);
  const perMinute = /per[_\s-]?minute|PerMinutePerProject|RequestsPerMinute/i.test(body);
  if (perDay && !perMinute) return { scope: "day", retryAfterMs };
  return { scope: "burst", retryAfterMs };
}

function endpoint(baseUrl: string, model: string, apiKey: string): string {
  const url = new URL(`${baseUrl}/models/${model}:generateContent`);
  url.search = new URLSearchParams({ key: apiKey }).toString();
  return url.toString();
}

/** The caller's cancellation and our own deadline, whichever fires first. */
function deadline(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** Pull `error.message` out of a Google error body, falling back to the body. */
function quote(body: string, apiKey: string): string {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    // Not JSON — an HTML error page from a proxy, say. Quote it as it came.
  }
  return redact(message, apiKey).trim().slice(0, MAX_QUOTED);
}

function mapStatus(status: number, body: string, apiKey: string): TtsFailure {
  const detail = quote(body, apiKey);
  // A 400 is usually about the request — an unknown voice, an unknown model —
  // and only counts as `auth` when Google names the key as the thing at fault.
  const invalidKey = /API_KEY_INVALID|API key not valid/i.test(body);
  if (status === 401 || status === 403 || (status === 400 && invalidKey)) {
    return fail("auth", `Google rejected the Gemini API key (HTTP ${status}): ${detail}`);
  }
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(body)) {
    const quota = readQuotaScope(body);
    return fail(
      "rate_limited",
      `Google is rate-limiting this key (HTTP ${status}): ${detail}`,
      quota,
    );
  }
  return fail("request_failed", `Gemini TTS failed (HTTP ${status}): ${detail}`);
}

/** Write an ASCII tag at `offset`; the four-byte chunk ids of a RIFF file. */
function writeTag(view: DataView, offset: number, tag: string): void {
  for (let index = 0; index < tag.length; index += 1) {
    view.setUint8(offset + index, tag.charCodeAt(index));
  }
}

/** Raw signed little-endian PCM in, a playable WAV out. Exported for the tests. */
export function wrapPcmAsWav(pcm: Uint8Array): Uint8Array {
  const byteRate = PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_SAMPLE_WIDTH;
  const blockAlign = PCM_CHANNELS * PCM_SAMPLE_WIDTH;

  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  writeTag(view, 0, "RIFF");
  // Everything after this field: the 36 remaining header bytes plus the data.
  view.setUint32(4, 36 + pcm.length, true);
  writeTag(view, 8, "WAVE");
  writeTag(view, 12, "fmt ");
  view.setUint32(16, 16, true); // the size of this fmt chunk
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, PCM_CHANNELS, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PCM_SAMPLE_WIDTH * 8, true);
  writeTag(view, 36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** The base64 payload of the one part that carries audio, or undefined. */
function findInlineAudio(body: unknown): string | undefined {
  const candidate = (body as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidate) || candidate.length === 0) return undefined;
  const parts = (candidate[0] as { content?: { parts?: unknown } } | null)?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts as Array<Record<string, unknown>>) {
    if (!part) continue;
    // The API has answered with both spellings, sometimes in the same session.
    const inline = (part.inlineData ?? part.inline_data) as { data?: unknown } | undefined;
    const data = inline?.data;
    if (typeof data === "string" && data.length > 0) return data;
  }
  return undefined;
}

export async function synthesizeChunk(args: {
  /** Where the Gemini surface lives. A cliproxy in front of a key
   *  pool speaks the same v1beta shape, so this is all that has to change. */
  baseUrl?: string;
  apiKey: string;
  text: string;
  voice: string;
  model: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; wavBase64: string } | TtsFailure> {
  const { apiKey, text, voice, model, signal, baseUrl = GEMINI_BASE_URL } = args;

  let response: Response;
  let raw: string;
  try {
    response = await fetch(endpoint(baseUrl, model, apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
      signal: deadline(signal),
    });
    raw = await response.text();
  } catch (error) {
    // An abort — ours or the caller's — arrives here too, and is no different
    // from a dead socket as far as the app is concerned.
    const reason = error instanceof Error ? error.message : String(error);
    return fail("request_failed", `Gemini TTS is unreachable: ${redact(reason, apiKey)}`);
  }

  if (!response.ok) return mapStatus(response.status, raw, apiKey);

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return fail("request_failed", "Gemini TTS returned a reply that is not JSON");
  }

  const pcmBase64 = findInlineAudio(body);
  if (pcmBase64 === undefined) {
    return fail("request_failed", "Gemini TTS returned no audio");
  }

  const pcm = Buffer.from(pcmBase64, "base64");
  if (pcm.length === 0) {
    return fail("request_failed", "Gemini TTS returned no audio");
  }
  const wav = wrapPcmAsWav(new Uint8Array(pcm));
  return { ok: true, wavBase64: Buffer.from(wav).toString("base64") };
}
