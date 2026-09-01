/**
 * The wire contract between the settings UI, the message button, and the
 * server — one file so the two halves of the plugin cannot drift.
 *
 * Only the server ever sees the Google key: it lives in a `secret` plugin
 * setting, which the SDK keeps in a 0600 file and never sends to a frontend.
 * Everything the UI is allowed to know about it is the boolean `configured`.
 */
import { z } from "zod";

/** Audio the browser can play from a data URL without a decoder of our own. */
export const AUDIO_MIME = "audio/mpeg";

/**
 * Google's synthesize endpoint rejects an input over 5000 bytes. Chunks are
 * cut below that with room to spare, because the limit counts UTF-8 bytes and
 * Cyrillic spends two per letter.
 */
export const MAX_CHUNK_BYTES = 4200;

/** How much text one click may send, across all its chunks. */
export const MAX_SPEAKABLE_CHARS = 20_000;

/**
 * The two languages the plugin picks between on its own. Everything else is
 * reachable by naming a voice explicitly in settings.
 */
export const AUTO_LANGUAGES = ["ru-RU", "en-US"] as const;
export type AutoLanguage = (typeof AUTO_LANGUAGES)[number];

/** Voices chosen for being the least robotic free-tier option per language. */
export const DEFAULT_VOICES: Record<AutoLanguage, string> = {
  "ru-RU": "ru-RU-Wavenet-C",
  "en-US": "en-US-Wavenet-F",
};

export const speakingRateSchema = z.number().min(0.25).max(4);

export const prefsSchema = z.object({
  /** Voice name per BCP-47 language, e.g. `{"ru-RU": "ru-RU-Wavenet-C"}`. */
  voices: z.record(z.string(), z.string()),
  speakingRate: speakingRateSchema,
  /** Speak with the browser's own voice when Google cannot answer. */
  fallbackEnabled: z.boolean(),
});
export type Prefs = z.infer<typeof prefsSchema>;

export const DEFAULT_PREFS: Prefs = {
  voices: { ...DEFAULT_VOICES },
  speakingRate: 1,
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

export const voiceRowSchema = z.object({
  name: z.string(),
  languageCodes: z.array(z.string()),
  ssmlGender: z.string(),
});
export type VoiceRow = z.infer<typeof voiceRowSchema>;

export const contract = {
  /** Everything the settings page needs in one round trip. */
  status: {
    input: z.object({}),
    output: z.object({
      configured: z.boolean(),
      prefs: prefsSchema,
      autoLanguages: z.array(z.string()),
      defaultVoices: z.record(z.string(), z.string()),
    }),
  },
  savePrefs: {
    input: z.object({ prefs: prefsSchema }),
    output: z.object({ prefs: prefsSchema }),
  },
  /** Google's own catalog, so the picker cannot offer a voice that is gone. */
  voices: {
    input: z.object({ languageCode: z.string().min(2) }),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), voices: z.array(voiceRowSchema) }),
      z.object({
        ok: z.literal(false),
        code: synthesisErrorCodeSchema,
        message: z.string(),
      }),
    ]),
  },
  /**
   * Text in, base64 MP3 out. Chunked, because one message can exceed what the
   * endpoint accepts; the app plays the pieces back to back.
   */
  synthesize: {
    input: z.object({
      text: z.string(),
      languageCode: z.string().min(2),
    }),
    output: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        mimeType: z.literal(AUDIO_MIME),
        voice: z.string(),
        chunks: z.array(z.string()),
      }),
      z.object({
        ok: z.literal(false),
        code: synthesisErrorCodeSchema,
        message: z.string(),
      }),
    ]),
  },
} as const;

export type StatusOutput = z.infer<typeof contract.status.output>;
export type VoicesOutput = z.infer<typeof contract.voices.output>;
export type SynthesizeOutput = z.infer<typeof contract.synthesize.output>;
