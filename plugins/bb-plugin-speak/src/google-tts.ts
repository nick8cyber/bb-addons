/**
 * The Google Cloud Text-to-Speech REST client — `fetch` and nothing else.
 *
 * The API key belongs to the server alone. It goes into the query string
 * because that is the only place Google accepts it, which means every string
 * that leaves this module (a message, a log line) has to be run through
 * `redact` first: Google's own error bodies quote the request URL back at you,
 * key included.
 */
import type { SynthesisErrorCode, VoiceRow } from "./contract.js";

const BASE = "https://texttospeech.googleapis.com/v1";

/** Long enough for a full 4200-byte chunk, short enough to fail a hung socket. */
const TIMEOUT_MS = 30_000;

/** Google's error bodies can be long; the first few lines say what is wrong. */
const MAX_QUOTED = 300;

export type TtsFailure = { ok: false; code: SynthesisErrorCode; message: string };

/** Strip anything that could be the key out of text on its way to a human. */
function redact(text: string, apiKey: string): string {
  let safe = text.replace(/key=[^&\s"'`)\]}]*/gi, "key=REDACTED");
  if (apiKey.length >= 8) safe = safe.split(apiKey).join("REDACTED");
  return safe;
}

function fail(code: SynthesisErrorCode, message: string): TtsFailure {
  return { ok: false, code, message };
}

function endpoint(path: string, apiKey: string, params: Record<string, string> = {}): string {
  const url = new URL(`${BASE}/${path}`);
  const search = new URLSearchParams({ ...params, key: apiKey });
  url.search = search.toString();
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
    const parsed = JSON.parse(body) as { error?: { message?: unknown; status?: unknown } };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    // Not JSON — an HTML error page from a proxy, say. Quote it as it came.
  }
  return redact(message, apiKey).trim().slice(0, MAX_QUOTED);
}

function mapStatus(status: number, body: string, apiKey: string): TtsFailure {
  const detail = quote(body, apiKey);
  const invalidKey = /API_KEY_INVALID|API key not valid/i.test(body);
  if (status === 401 || status === 403 || (status === 400 && invalidKey)) {
    return fail("auth", `Google rejected the API key (HTTP ${status}): ${detail}`);
  }
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(body)) {
    return fail("rate_limited", `Google is rate-limiting this key (HTTP ${status}): ${detail}`);
  }
  return fail("request_failed", `Google Text-to-Speech failed (HTTP ${status}): ${detail}`);
}

/** One request, with every failure already turned into a `SynthesisErrorCode`. */
async function callGoogle(args: {
  apiKey: string;
  url: string;
  init: RequestInit;
  signal?: AbortSignal;
}): Promise<{ ok: true; body: unknown } | TtsFailure> {
  const { apiKey, url, init, signal } = args;
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { ...init, signal: deadline(signal) });
    text = await response.text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail("request_failed", `Google Text-to-Speech is unreachable: ${redact(reason, apiKey)}`);
  }
  if (!response.ok) return mapStatus(response.status, text, apiKey);
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return fail("request_failed", "Google Text-to-Speech returned a reply that is not JSON");
  }
}

export async function synthesizeChunk(args: {
  apiKey: string;
  text: string;
  languageCode: string;
  voiceName: string | undefined;
  speakingRate: number;
  signal?: AbortSignal;
}): Promise<{ ok: true; audioBase64: string } | TtsFailure> {
  const { apiKey, text, languageCode, voiceName, speakingRate, signal } = args;
  const result = await callGoogle({
    apiKey,
    url: endpoint("text:synthesize", apiKey),
    signal,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { text },
        // Without `name` Google picks the language's default voice, which is
        // what an unset preference is supposed to mean.
        voice: voiceName ? { languageCode, name: voiceName } : { languageCode },
        audioConfig: { audioEncoding: "MP3", speakingRate },
      }),
    },
  });
  if (!result.ok) return result;
  const audioContent = (result.body as { audioContent?: unknown } | null)?.audioContent;
  if (typeof audioContent !== "string" || audioContent.length === 0) {
    return fail("request_failed", "Google Text-to-Speech returned no audio");
  }
  return { ok: true, audioBase64: audioContent };
}

export async function listVoices(args: {
  apiKey: string;
  languageCode: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; voices: VoiceRow[] } | TtsFailure> {
  const { apiKey, languageCode, signal } = args;
  const result = await callGoogle({
    apiKey,
    url: endpoint("voices", apiKey, { languageCode }),
    signal,
    init: { method: "GET" },
  });
  if (!result.ok) return result;
  const raw = (result.body as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(raw)) {
    return fail("request_failed", "Google Text-to-Speech returned no voice list");
  }
  const voices: VoiceRow[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.name !== "string") continue;
    voices.push({
      name: entry.name,
      languageCodes: Array.isArray(entry.languageCodes)
        ? entry.languageCodes.filter((code): code is string => typeof code === "string")
        : [],
      ssmlGender: typeof entry.ssmlGender === "string" ? entry.ssmlGender : "SSML_VOICE_GENDER_UNSPECIFIED",
    });
  }
  voices.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, voices };
}
