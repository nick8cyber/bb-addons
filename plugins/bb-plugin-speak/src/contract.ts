/**
 * The wire contract between the settings UI, the message button, and the
 * server — one file so the two halves of the plugin cannot drift.
 *
 * The engine is Gemini's TTS, the same one the Hermes gateway speaks Telegram
 * with: `generativelanguage.googleapis.com`, model
 * `gemini-2.5-flash-preview-tts`, voice `Kore`. Not Google Cloud
 * Text-to-Speech — a different API, a different key, and a markedly better
 * voice.
 *
 * Only the server ever sees the key: it lives in a `secret` plugin setting,
 * which the SDK keeps in a 0600 file and never sends to a frontend. All the UI
 * is allowed to know about it is the boolean `configured`.
 */
import { z } from "zod";

/**
 * Gemini answers with `audio/L16;codec=pcm;rate=24000` — raw samples, no
 * container. The server puts a WAV header on them, because that is the one
 * thing an `<audio>` element will play without a decoder of our own, and this
 * machine has no ffmpeg to make anything smaller.
 */
export const AUDIO_MIME = "audio/wav";
export const PCM_SAMPLE_RATE = 24_000;
export const PCM_CHANNELS = 1;
export const PCM_SAMPLE_WIDTH = 2;

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Measured, not guessed: 73 characters of Russian came back as 261646 PCM
 *  bytes — 5.45 seconds. Uncompressed audio is why one message cannot be one
 *  response, and why the budgets below are in characters of *input*. */
export const PCM_BYTES_PER_CHAR = 3584;

/**
 * The first chunk is deliberately short: it is the one the user waits for
 * before hearing anything. The rest are sized so generation stays well ahead
 * of audio playback with zero stutter.
 */
export const FIRST_CHUNK_CHARS = 100;
export const CHUNK_CHARS = 260;

/** How much text one click may send, across all its chunks. */
export const MAX_SPEAKABLE_CHARS = 20_000;

export const TTS_MODELS = [
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
  "gemini-3.1-flash-tts-preview",
] as const;
export const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";

/**
 * The thirty prebuilt voices, taken from the API's own rejection message
 * rather than from documentation. The API matches them case-insensitively;
 * these are the display forms.
 */
export const GEMINI_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede",
  "Autonoe", "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome",
  "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda",
  "Orus", "Puck", "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager",
  "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi",
] as const;

/** What Hermes uses. */
export const DEFAULT_VOICE = "Kore";

export const prefsSchema = z.object({
  /** One voice for every language: Gemini's voices are multilingual. */
  voice: z.string().min(1),
  model: z.string().min(1),
  /**
   * Gemini's TTS takes no rate parameter — pace is a matter of prompt
   * direction — so this reaches only the browser's fallback voice.
   */
  browserRate: z.number().min(0.5).max(2),
  fallbackEnabled: z.boolean(),
});
export type Prefs = z.infer<typeof prefsSchema>;

export const DEFAULT_PREFS: Prefs = {
  voice: DEFAULT_VOICE,
  model: DEFAULT_MODEL,
  browserRate: 1,
  fallbackEnabled: true,
};

/**
 * Why synthesis produced no audio. The app keys its fallback on this: only
 * `not_configured`, `auth`, `rate_limited` and `request_failed` are worth
 * retrying with the browser voice — `empty` and `too_long` are about the text
 * itself, and no second engine would fix them.
 */
export const synthesisErrorCodeSchema = z.enum([
  "not_configured",
  "auth",
  "rate_limited",
  "request_failed",
  "empty",
  "too_long",
]);
export type SynthesisErrorCode = z.infer<typeof synthesisErrorCodeSchema>;

const failure = z.object({
  ok: z.literal(false),
  code: synthesisErrorCodeSchema,
  message: z.string(),
});

export const contract = {
  /** Everything the settings page needs in one round trip. */
  status: {
    input: z.object({}),
    output: z.object({
      configured: z.boolean(),
      prefs: prefsSchema,
      voices: z.array(z.string()),
      models: z.array(z.string()),
    }),
  },
  savePrefs: {
    input: z.object({ prefs: prefsSchema }),
    output: z.object({ prefs: prefsSchema }),
  },
  /**
   * One chunk per call. Uncompressed 24 kHz audio runs about 4.8 KB of base64
   * per character of input, so a whole message in one response would be
   * megabytes the user waits for in silence. The player asks for chunk 0,
   * starts playing it, and fetches the next while that one runs.
   *
   * Chunking is a pure function of the text, so the server re-derives the same
   * boundaries on every call and the client never has to send them back.
   */
  synthesize: {
    input: z.object({
      text: z.string(),
      chunkIndex: z.number().int().min(0),
    }),
    output: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        mimeType: z.literal(AUDIO_MIME),
        voice: z.string(),
        chunkIndex: z.number().int().min(0),
        chunkCount: z.number().int().min(1),
        audioBase64: z.string(),
      }),
      failure,
    ]),
  },
  /** Synthesizes one short fixed sentence, for the settings page's Test. */
  probe: {
    input: z.object({ voice: z.string().min(1), model: z.string().min(1) }),
    output: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        mimeType: z.literal(AUDIO_MIME),
        audioBase64: z.string(),
      }),
      failure,
    ]),
  },
} as const;

export type StatusOutput = z.infer<typeof contract.status.output>;
export type SynthesizeOutput = z.infer<typeof contract.synthesize.output>;
export type ProbeOutput = z.infer<typeof contract.probe.output>;
