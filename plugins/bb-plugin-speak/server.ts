/**
 * bb-plugin-speak — server entry.
 *
 * The browser never talks to Google. It cannot: the API key lives in a
 * `secret` plugin setting, which the SDK keeps in a 0600 file outside the
 * database and never includes in any payload sent to a frontend. So the app
 * posts text here, and this file is the only place that holds a key, builds a
 * Google URL, or sees an error body that might quote one back.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";

import {
  AUDIO_MIME,
  AUTO_LANGUAGES,
  DEFAULT_PREFS,
  DEFAULT_VOICES,
  MAX_SPEAKABLE_CHARS,
  contract,
  prefsSchema,
  type AutoLanguage,
  type Prefs,
} from "./src/contract.js";
import { chunkForSynthesis } from "./src/chunk.js";
import { listVoices, synthesizeChunk } from "./src/google-tts.js";

const PREFS_KEY = "prefs";

/** Where a human is told to go when there is no key. */
const WHERE_TO_PUT_THE_KEY = "Settings → Extensions → Speak";

export const rpcContract = defineRpcContract(contract);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    googleApiKey: {
      type: "string",
      // `secret: true` is the whole reason this plugin has a server half: the
      // value stays in a 0600 file, out of bb.db and out of every frontend
      // payload, so synthesis has to happen here rather than in the browser.
      secret: true,
      label: "Google Cloud API key",
      description:
        "An API key from a Google Cloud project with the Cloud Text-to-Speech API enabled — enable the Cloud Text-to-Speech API on the project the key belongs to, or every request comes back as 403. Restrict the key to that one API.",
    },
  });

  /** The key, or undefined when it is absent or blank. Never logged. */
  const apiKey = async (): Promise<string | undefined> => {
    const value = (await settings.get()).googleApiKey;
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length > 0 ? trimmed : undefined;
  };

  /** Non-secret preferences live in kv; anything unreadable becomes defaults. */
  const readPrefs = async (): Promise<Prefs> => {
    const stored = await bb.storage.kv.get<unknown>(PREFS_KEY);
    if (stored === undefined) return DEFAULT_PREFS;
    const parsed = prefsSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    bb.log.warn("stored preferences did not validate; falling back to the defaults");
    return DEFAULT_PREFS;
  };

  /**
   * An explicit preference wins; otherwise the two languages the plugin knows
   * get their curated voice, and anything else is left for Google to choose.
   */
  const resolveVoice = (prefs: Prefs, languageCode: string): string | undefined => {
    const chosen = prefs.voices[languageCode]?.trim();
    if (chosen) return chosen;
    if ((AUTO_LANGUAGES as readonly string[]).includes(languageCode)) {
      return DEFAULT_VOICES[languageCode as AutoLanguage];
    }
    return undefined;
  };

  bb.rpc.register(rpcContract, {
    status: async () => ({
      configured: (await apiKey()) !== undefined,
      prefs: await readPrefs(),
      autoLanguages: [...AUTO_LANGUAGES],
      defaultVoices: { ...DEFAULT_VOICES },
    }),

    savePrefs: async ({ prefs }) => {
      const validated = prefsSchema.parse(prefs);
      await bb.storage.kv.set(PREFS_KEY, validated);
      bb.log.info(`preferences saved (rate ${validated.speakingRate})`);
      return { prefs: validated };
    },

    voices: async ({ languageCode }) => {
      const key = await apiKey();
      if (!key) {
        return {
          ok: false as const,
          code: "not_configured" as const,
          message: `No Google API key yet. Add one in ${WHERE_TO_PUT_THE_KEY}.`,
        };
      }
      return await listVoices({ apiKey: key, languageCode });
    },

    synthesize: async ({ text, languageCode }) => {
      if (text.trim().length === 0) {
        return { ok: false as const, code: "empty" as const, message: "There is nothing to read." };
      }
      if (text.length > MAX_SPEAKABLE_CHARS) {
        return {
          ok: false as const,
          code: "too_long" as const,
          message: `This message is ${text.length} characters; the limit for one click is ${MAX_SPEAKABLE_CHARS}.`,
        };
      }
      const key = await apiKey();
      if (!key) {
        return {
          ok: false as const,
          code: "not_configured" as const,
          message: `No Google API key yet. Add one in ${WHERE_TO_PUT_THE_KEY}.`,
        };
      }

      const prefs = await readPrefs();
      const voiceName = resolveVoice(prefs, languageCode);
      const pieces = chunkForSynthesis(text);
      if (pieces.length === 0) {
        return { ok: false as const, code: "empty" as const, message: "There is nothing to read." };
      }

      const chunks: string[] = [];
      // Sequentially: firing a long message's chunks in parallel trips
      // Google's per-minute quota, and the audio has to be ordered anyway.
      for (const piece of pieces) {
        const result = await synthesizeChunk({
          apiKey: key,
          text: piece,
          languageCode,
          voiceName,
          speakingRate: prefs.speakingRate,
        });
        if (!result.ok) {
          bb.log.warn(`synthesis stopped after ${chunks.length}/${pieces.length} chunks: ${result.code}`);
          return { ok: false as const, code: result.code, message: result.message };
        }
        chunks.push(result.audioBase64);
      }
      bb.log.info(`synthesized ${chunks.length} chunk(s) for ${languageCode}`);
      return { ok: true as const, mimeType: AUDIO_MIME as typeof AUDIO_MIME, voice: voiceName ?? "", chunks };
    },
  });

  bb.cli.register({
    name: "speak",
    summary: "Read chat messages aloud through Google Cloud Text-to-Speech",
    commands: [
      { name: "status", summary: "Show whether a key is configured, and the current voice settings", usage: "bb speak status" },
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      if (command === "help" || command === "--help" || command === "-h") {
        return { exitCode: 0, stdout: "Usage: bb speak status\n" };
      }
      if (command !== "status") {
        return { exitCode: 1, stderr: `unknown command ${command}\n\nUsage: bb speak status\n` };
      }
      const configured = (await apiKey()) !== undefined;
      const prefs = await readPrefs();
      const lines = [
        // Only ever the boolean: printing any part of the key would put it in
        // a shell history and a terminal scrollback.
        `Google API key: ${configured ? "configured" : `not set — add it in ${WHERE_TO_PUT_THE_KEY}`}`,
        `speaking rate:  ${prefs.speakingRate}`,
        `browser voice fallback: ${prefs.fallbackEnabled ? "on" : "off"}`,
        "voices:",
      ];
      const entries = Object.entries(prefs.voices);
      if (entries.length === 0) lines.push("  (none chosen; Google picks per language)");
      for (const [language, voice] of entries) lines.push(`  ${language.padEnd(8)} ${voice}`);
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });

  bb.log.info("speak ready: bb speak status");
}
