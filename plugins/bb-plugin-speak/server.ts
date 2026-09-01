/**
 * bb-plugin-speak — server entry.
 *
 * The browser never talks to Google. It cannot: the API key lives in a
 * `secret` plugin setting, which the SDK keeps in a 0600 file outside the
 * database and never includes in any payload sent to a frontend. So the app
 * posts text here, and this file is the only place that holds a key, builds a
 * Gemini URL, or sees an error body that might quote one back.
 *
 * One call synthesizes one chunk. The split is a pure function of the text, so
 * the client sends nothing but an index and this file re-derives the very same
 * boundaries — see `src/chunk.ts`.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";

import {
  AUDIO_MIME,
  DEFAULT_MODEL,
  DEFAULT_PREFS,
  FALLBACK_MODEL,
  GEMINI_BASE_URL,
  GEMINI_VOICES,
  MAX_SPEAKABLE_CHARS,
  TTS_MODELS,
  contract,
  prefsSchema,
  type Prefs,
} from "./src/contract.js";
import { chunkForSynthesis } from "./src/chunk.js";
import { isQuotaFailure, nextQuotaReset, planModels } from "./src/model-chain.js";
import { synthesizeChunk } from "./src/gemini-tts.js";

const PREFS_KEY = "prefs";

/** Where a human is told to go when there is no key. */
const WHERE_TO_PUT_THE_KEY = "Settings → Extensions → Speak";

/** Short enough to audition a voice in a second or two, long enough to judge it. */
const PROBE_TEXT = "Проверка голоса: так это будет звучать вслух.";

export const rpcContract = defineRpcContract(contract);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    geminiApiKey: {
      type: "string",
      // `secret: true` is the whole reason this plugin has a server half: the
      // value stays in a 0600 file, out of bb.db and out of every frontend
      // payload, so synthesis has to happen here rather than in the browser.
      secret: true,
      label: "Gemini API key",
      description:
        "A Gemini API key from Google AI Studio — https://aistudio.google.com/app/apikey. This is not a Google Cloud console key: a Cloud Text-to-Speech key pasted here is rejected, because the engine is Gemini's TTS on generativelanguage.googleapis.com, a different API on a different key.",
    },
    baseUrl: {
      type: "string",
      label: "Gemini endpoint",
      description:
        "Leave empty for Google's own https://generativelanguage.googleapis.com/v1beta. Point it at a CLIProxyAPI instead — e.g. http://127.0.0.1:8318/v1beta — to spread the reading across a pool of AI Studio keys rather than one; the proxy speaks the same v1beta shape, so the key above becomes the proxy's gateway key.",
    },
  });

  /** The key, or undefined when it is absent or blank. Never logged. */
  const apiKey = async (): Promise<string | undefined> => {
    const value = (await settings.get()).geminiApiKey;
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length > 0 ? trimmed : undefined;
  };

  /** The configured endpoint, or Google's own. Trailing slashes are a common
   *  paste artefact and would produce a double slash in the path. */
  const baseUrl = async (): Promise<string> => {
    const value = (await settings.get()).baseUrl;
    const trimmed = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
    return trimmed.length > 0 ? trimmed : GEMINI_BASE_URL;
  };

  /**
   * Which models are known to be out of quota, and until when. Kept in kv so
   * the knowledge survives a reload and so the other chunks of the same
   * message do not each re-discover it at the cost of a wasted round trip.
   */
  const COOLDOWN_KEY = "quota-cooldown";
  const readCooldowns = async (): Promise<Record<string, number>> => {
    const stored = await bb.storage.kv.get<unknown>(COOLDOWN_KEY);
    if (stored === null || typeof stored !== "object") return {};
    const out: Record<string, number> = {};
    for (const [model, until] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof until === "number" && Number.isFinite(until)) out[model] = until;
    }
    return out;
  };
  const markExhausted = async (model: string): Promise<void> => {
    const until = nextQuotaReset();
    await bb.storage.kv.set(COOLDOWN_KEY, { ...(await readCooldowns()), [model]: until });
  };

  /** Non-secret preferences live in kv; anything unreadable becomes defaults. */
  const readPrefs = async (): Promise<Prefs> => {
    const stored = await bb.storage.kv.get<unknown>(PREFS_KEY);
    if (stored === undefined) return DEFAULT_PREFS;
    const parsed = prefsSchema.safeParse(stored);
    // Deliberately no rewriting of a saved model here. An earlier version
    // forced 2.5 back to 3.1 on every read, which made 2.5 impossible to
    // choose — and it is now the fallback, so it has to survive being stored.
    if (parsed.success) return parsed.data;
    const legacy = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
    const migrated: Prefs = {
      voice: typeof legacy.voice === "string" ? legacy.voice : DEFAULT_PREFS.voice,
      model: typeof legacy.model === "string" && legacy.model.length > 0
        ? legacy.model
        : DEFAULT_PREFS.model,
      fallbackModel: typeof legacy.fallbackModel === "string"
        ? legacy.fallbackModel
        : DEFAULT_PREFS.fallbackModel,
      browserRate:
        typeof legacy.browserRate === "number"
          ? legacy.browserRate
          : typeof legacy.speakingRate === "number"
            ? legacy.speakingRate
            : DEFAULT_PREFS.browserRate,
      fallbackEnabled:
        typeof legacy.fallbackEnabled === "boolean"
          ? legacy.fallbackEnabled
          : DEFAULT_PREFS.fallbackEnabled,
    };
    const validated = prefsSchema.safeParse(migrated);
    const result = validated.success ? validated.data : DEFAULT_PREFS;
    bb.log.info(`migrated legacy speak preferences to current schema (voice ${result.voice}, model ${result.model})`);
    await bb.storage.kv.set(PREFS_KEY, result);
    return result;
  };

  const notConfigured = () => ({
    ok: false as const,
    code: "not_configured" as const,
    message: `No Gemini API key yet. Add one in ${WHERE_TO_PUT_THE_KEY}.`,
  });

  bb.rpc.register(rpcContract, {
    status: async () => ({
      configured: (await apiKey()) !== undefined,
      prefs: await readPrefs(),
      voices: [...GEMINI_VOICES],
      models: [...TTS_MODELS],
    }),

    savePrefs: async ({ prefs }) => {
      const validated = prefsSchema.parse(prefs);
      await bb.storage.kv.set(PREFS_KEY, validated);
      bb.log.info(`preferences saved (voice ${validated.voice}, model ${validated.model})`);
      return { prefs: validated };
    },

    synthesize: async ({ text, chunkIndex }) => {
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
      if (!key) return notConfigured();

      const pieces = chunkForSynthesis(text);
      if (pieces.length === 0) {
        return { ok: false as const, code: "empty" as const, message: "There is nothing to read." };
      }
      const piece = pieces[chunkIndex];
      if (piece === undefined) {
        // The client asked past the end of a split it derived from the same
        // text with the same function, so either the text changed underneath
        // it or the two halves have drifted. Either way, say which it was.
        return {
          ok: false as const,
          code: "request_failed" as const,
          message: `Chunk ${chunkIndex} does not exist; this text has ${pieces.length} chunk(s).`,
        };
      }

      const prefs = await readPrefs();
      const endpoint = await baseUrl();
      const cooldowns = await readCooldowns();
      const now = Date.now();
      const chain = planModels(
        prefs.model,
        prefs.fallbackModel,
        (model) => (cooldowns[model] ?? 0) > now,
      );

      let result = undefined as Awaited<ReturnType<typeof synthesizeChunk>> | undefined;
      let spokenBy = prefs.model;
      for (const model of chain) {
        result = await synthesizeChunk({
          baseUrl: endpoint,
          apiKey: key,
          text: piece,
          voice: prefs.voice,
          model,
        });
        spokenBy = model;
        if (result.ok) break;
        // Only a spent quota is worth a second model. A rejected key or an
        // unreachable proxy fails identically on the next one, and retrying
        // would just double the wait before the browser voice takes over.
        if (!isQuotaFailure(result.code)) break;
        await markExhausted(model);
        bb.log.warn(
          `${model} is out of quota across the whole pool; ` +
            `chunk ${chunkIndex + 1}/${pieces.length} moves on`,
        );
      }

      if (result === undefined) {
        return {
          ok: false as const,
          code: "request_failed" as const,
          message: "No TTS model is configured to try.",
        };
      }
      if (!result.ok) {
        bb.log.warn(`chunk ${chunkIndex}/${pieces.length} failed: ${result.code} — ${result.message}`);
        return { ok: false as const, code: result.code, message: result.message };
      }
      bb.log.info(
        `synthesized chunk ${chunkIndex + 1}/${pieces.length} as ${prefs.voice} on ${spokenBy}`,
      );
      return {
        ok: true as const,
        mimeType: AUDIO_MIME as typeof AUDIO_MIME,
        voice: prefs.voice,
        model: spokenBy,
        chunkIndex,
        chunkCount: pieces.length,
        audioBase64: result.wavBase64,
      };
    },

    probe: async ({ voice, model }) => {
      const key = await apiKey();
      if (!key) return notConfigured();
      // Deliberately the arguments and not the saved preferences: the point of
      // Test is to hear a voice before committing to it.
      const result = await synthesizeChunk({
      apiKey: key, text: PROBE_TEXT, voice, model, baseUrl: await baseUrl(),
    });
      if (!result.ok) {
        bb.log.warn(`probe of ${voice} on ${model} failed: ${result.code}`);
        return { ok: false as const, code: result.code, message: result.message };
      }
      bb.log.info(`probed ${voice} on ${model}`);
      return {
        ok: true as const,
        mimeType: AUDIO_MIME as typeof AUDIO_MIME,
        audioBase64: result.wavBase64,
      };
    },
  });

  bb.cli.register({
    name: "speak",
    summary: "Read chat messages aloud through Gemini TTS",
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
        `Gemini API key: ${configured ? "configured" : `not set — add it in ${WHERE_TO_PUT_THE_KEY}`}`,
        `voice:          ${prefs.voice}`,
        `model:          ${prefs.model}`,
        `browser voice fallback: ${prefs.fallbackEnabled ? `on (rate ${prefs.browserRate})` : "off"}`,
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });

  bb.log.info("speak ready: bb speak status");
}
