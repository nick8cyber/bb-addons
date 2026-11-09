/**
 * Серверная часть bb-plugin-voice-stt (спека §4): настройки, регистрация
 * AI-сервиса `voice` функциональной формой (единственная, которую принимает
 * валидатор bb 0.48.1), мост к host-энтри как у provider-codex, CLI
 * `bb voice-stt`.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CHAIN_TIMEOUT_MS,
  HOST_CALL_TIMEOUT_MS,
  MAX_AUDIO_BYTES,
  STATUS_HOST_TIMEOUT_MS,
  contract,
  normalizeLanguage,
  transcribeOutputSchema,
  voiceSttHostContract,
  type CodexAuthState,
  type TranscribeConfig,
  type TranscribeOutput,
} from "./src/contract.js";
import { LiveGeminiSession } from "./src/live-session.js";
import { LiveTokenStore } from "./src/live-token.js";
import { createLiveVoiceHandler, type LiveVoiceConfig } from "./src/live-ws.js";
import { vocabularyTerms } from "./src/gemini-live.js";

const DEFAULT_GEMINI_MODEL = "gemini-3.5-transcribe-live";
const DEFAULT_GROQ_MODEL = "whisper-large-v3-turbo";

const MIME_BY_EXT: Record<string, string> = {
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".flac": "audio/flac",
};

interface EngineStatus {
  geminiKeys: number;
  groqKey: boolean;
  codexAuth: CodexAuthState | null;
  ffmpeg: boolean | null;
  hostNote: string | null;
}

/** RPC для фронтенда живого режима (спека §4.1, §4.3а). */
const rpcContract = defineRpcContract({
  liveToken: {
    input: z.object({}).strict(),
    output: z.object({ token: z.string() }).strict(),
  },
  /** Диагностика клиента, когда живого сокета нет (запасной режим, итог вставки). */
  clientLog: {
    input: z.object({ msg: z.string().min(1).max(500) }).strict(),
    output: z.object({}).strict(),
  },
  liveFallback: {
    input: z
      .object({
        // cap как у серверного PCM (10 МБ → ~13.4 МБ base64 + запас).
        audioBase64: z.string().min(1).max(14 * 1024 * 1024),
        filename: z.string().min(1).max(255),
        // Запасной режим (MediaRecorder): audio/mp4, audio/webm…; без — WAV.
        mimeType: z.string().min(1).max(100).optional(),
      })
      .strict(),
    output: transcribeOutputSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    geminiKeys: {
      type: "string",
      secret: true,
      label: "Ключи Gemini (AI Studio)",
      description: "1–2 ключа, по одному на строку — те же, что у live-call. Первый — основной.",
    },
    groqApiKey: {
      type: "string",
      secret: true,
      label: "Ключ Groq",
      description: "Фоллбэк №2 (whisper-large-v3-turbo). Пусто — стадия Groq пропускается.",
    },
    language: {
      type: "string",
      label: "Язык",
      description: "BCP-47 (ru, ru-RU). Пусто — автодетект. Невалидное значение игнорируется.",
      default: "",
    },
    geminiLiveModel: {
      type: "string",
      label: "Live-модель Gemini",
      description: "Модель BidiGenerateContent; префикс models/ добавляется сам.",
      default: DEFAULT_GEMINI_MODEL,
    },
    groqModel: {
      type: "string",
      label: "Модель Groq",
      description: "Батч-модель транскрибации Groq.",
      default: DEFAULT_GROQ_MODEL,
    },
    liveInput: {
      type: "boolean",
      label: "Живой ввод (диктовка)",
      description: "Кнопка/команда/оверлей живого режима (спека voice-stt-live §7). Файловый сервис не трогает.",
      default: true,
    },
    micWarmSeconds: {
      type: "number",
      label: "Тёплый микрофон, сек",
      description:
        "Сколько секунд микрофон остаётся включённым после диктовки (горит индикатор микрофона): следующая запись стартует мгновенно, и ~0.5 с звука ДО касания становятся её началом и уходят на распознавание. Остальной звук между записями держится только в памяти и не отправляется. 0 — выключать сразу (без тёплого микрофона и без звука до касания).",
      default: 30,
    },
    vocabularyTerms: {
      type: "string",
      label: "Словарь живого ввода",
      description: "Термины для custom_vocabulary Gemini на живом пути — по одному на строку или через запятую (hint'а тут нет).",
    },
  });

  const host = bb.hosts.experimental_client({ contract });
  // Внутренний host-RPC живого режима — тот же метод, но с skipStages (§4.5).
  const liveHost = bb.hosts.experimental_client({ contract: voiceSttHostContract });

  const str = (value: unknown, fallback = ""): string => {
    const s = typeof value === "string" ? value.trim() : "";
    return s === "" ? fallback : s;
  };

  /** Настройки → config host RPC; "" языка нормализуется в null (спека §5). */
  const readConfig = async (): Promise<TranscribeConfig> => {
    const s = await settings.get();
    return {
      geminiKeys: str(s.geminiKeys)
        .split(/\r?\n/)
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 2),
      geminiLiveModel: str(s.geminiLiveModel, DEFAULT_GEMINI_MODEL),
      groqApiKey: str(s.groqApiKey) || null,
      groqModel: str(s.groqModel, DEFAULT_GROQ_MODEL),
      language: normalizeLanguage(s.language),
    };
  };

  /** Настройки → конфиг живой сессии (спека §7: те же ключи, словарь из настройки). */
  const readLiveConfig = async (): Promise<LiveVoiceConfig> => {
    const s = await settings.get();
    return {
      geminiKeys: str(s.geminiKeys)
        .split(/\r?\n/)
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 2),
      geminiLiveModel: str(s.geminiLiveModel, DEFAULT_GEMINI_MODEL),
      language: normalizeLanguage(s.language),
      vocabulary: vocabularyTerms(str(s.vocabularyTerms)),
    };
  };

  const liveInputEnabled = async (): Promise<boolean> => (await settings.get()).liveInput !== false;

  const primaryHostId = async (): Promise<string | null> =>
    (await bb.sdk.system.config()).primaryHostId;

  const requirePrimaryHostId = async (): Promise<string> => {
    const hostId = await primaryHostId();
    if (hostId === null) throw new Error("No primary machine is connected");
    return hostId;
  };

  const callTranscribe = async (
    audio: { bytes: Buffer; mimeType: string; filename: string },
    hint: string | null,
    signal?: AbortSignal,
  ): Promise<TranscribeOutput> => {
    const config = await readConfig();
    const hostId = await requirePrimaryHostId();
    return await host.call(
      "voice-stt.transcribe",
      {
        audioBase64: audio.bytes.toString("base64"),
        mimeType: audio.mimeType,
        filename: audio.filename,
        hint,
        config,
        timeoutMs: CHAIN_TIMEOUT_MS,
      },
      { hostId, signal, timeoutMs: HOST_CALL_TIMEOUT_MS },
    );
  };

  /**
   * Сводка по движкам: локальные ключи видны серверу, codex-auth и ffmpeg —
   * только хосту (спека §4.3, бюджет host-вызова ~1.2 c из общих ≤2 c).
   */
  const collectStatus = async (): Promise<EngineStatus> => {
    const cfg = await readConfig();
    const status: EngineStatus = {
      geminiKeys: cfg.geminiKeys.length,
      groqKey: cfg.groqApiKey !== null,
      codexAuth: null,
      ffmpeg: null,
      hostNote: null,
    };
    const hostId = await primaryHostId().catch(() => null);
    if (hostId === null) {
      status.hostNote = "no primary machine is connected";
      return status;
    }
    try {
      const hostStatus = await host.call(
        "voice-stt.status",
        {},
        { hostId, timeoutMs: STATUS_HOST_TIMEOUT_MS },
      );
      status.codexAuth = hostStatus.codexAuth;
      status.ffmpeg = hostStatus.ffmpeg;
    } catch {
      status.hostNote = "host entry did not answer";
    }
    return status;
  };

  /**
   * expired считается доступным: codex всё равно идёт на запрос (токен могли
   * обновить вне файла), 401 уйдёт в фоллбэк — семантика provider-codex (§7.1).
   */
  const codexReady = (s: EngineStatus): boolean =>
    s.codexAuth === "ok" || s.codexAuth === "expired";

  const serviceStatus = async (): Promise<{ ready: true } | { ready: false; message: string }> => {
    const s = await collectStatus();
    if (s.geminiKeys > 0 || codexReady(s) || s.groqKey) return { ready: true };
    const why = [
      `gemini keys: ${s.geminiKeys > 0 ? "set" : "missing"}`,
      `codex auth: ${s.codexAuth ?? "unknown"}`,
      `groq key: ${s.groqKey ? "set" : "missing"}`,
    ];
    if (s.hostNote !== null) why.push(s.hostNote);
    return { ready: false, message: `No voice transcription engine is ready — ${why.join(", ")}` };
  };

  bb.experimental_aiServices.register({
    id: "gemini-live",
    displayName: "Gemini Live STT",
    transcribe: async (audio, { signal, hint }) => {
      if (audio.size > MAX_AUDIO_BYTES) {
        throw new Error(
          `Recordings over ${MAX_AUDIO_BYTES / (1024 * 1024)} MB are too large to transcribe`,
        );
      }
      const res = await callTranscribe(
        {
          bytes: Buffer.from(await audio.arrayBuffer()),
          mimeType: audio.type || "application/octet-stream",
          filename: audio.name || "voice-input",
        },
        hint,
        signal,
      );
      if (!res.ok) throw new Error(res.message);
      bb.log.info(`voice-stt: transcribed via ${res.engine}`);
      return res.text;
    },
    status: serviceStatus,
  });

  bb.cli.register({
    name: "voice-stt",
    summary: "Голосовой ввод: Gemini Live STT, фоллбэки Codex и Groq",
    commands: [
      {
        name: "status",
        summary: "Сводка по движкам транскрибации",
        usage: "bb voice-stt status",
      },
      {
        name: "transcribe",
        summary: "Прогнать аудиофайл через цепочку движков",
        usage: "bb voice-stt transcribe <file>",
      },
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      if (command === "status") {
        const s = await collectStatus();
        const lines = [
          `gemini-live: ${s.geminiKeys > 0 ? `${s.geminiKeys} key(s)` : "no keys"}`,
          `codex: ${s.codexAuth ?? "unknown"}`,
          `groq: ${s.groqKey ? "key set" : "no key"}`,
          `ffmpeg: ${s.ffmpeg === null ? "unknown" : s.ffmpeg ? "yes" : "no"}`,
        ];
        if (s.hostNote !== null) lines.push(`host: ${s.hostNote}`);
        const ready = s.geminiKeys > 0 || codexReady(s) || s.groqKey;
        lines.push(`ready: ${ready ? "yes" : "no"}`);
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }
      if (command === "transcribe") {
        const path = argv[1];
        if (path === undefined) {
          return { exitCode: 1, stderr: "usage: bb voice-stt transcribe <file>\n" };
        }
        let bytes: Buffer;
        try {
          bytes = await readFile(path);
        } catch (e) {
          return {
            exitCode: 1,
            stderr: `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}\n`,
          };
        }
        const mimeType = MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
        try {
          const res = await callTranscribe(
            { bytes, mimeType, filename: path.split("/").pop() ?? "voice-input" },
            null,
          );
          if (!res.ok) {
            return { exitCode: 1, stderr: `${res.code}: ${res.message}\n` };
          }
          return { exitCode: 0, stdout: `engine: ${res.engine}\n${res.text}\n` };
        } catch (e) {
          return { exitCode: 1, stderr: `${e instanceof Error ? e.message : String(e)}\n` };
        }
      }
      return {
        exitCode: 1,
        stderr: `unknown command ${command}; use "status" or "transcribe <file>"\n`,
      };
    },
  });

  // --- Живой режим (спека voice-stt-live §4): WS-стриминг + RPC токена/фоллбэка ---

  const liveTokens = new LiveTokenStore();
  const liveLog = (message: string) => bb.log.info(message);

  /** Фоллбэк живого режима (§4.5): WAV → host-RPC codex→groq без ffmpeg. */
  const liveFallback = async (wav: Uint8Array): Promise<TranscribeOutput> => {
    const config = await readConfig();
    const hostId = await requirePrimaryHostId();
    return await liveHost.call(
      "voice-stt.transcribe",
      {
        audioBase64: Buffer.from(wav).toString("base64"),
        mimeType: "audio/wav",
        filename: "live-dictation.wav",
        hint: null,
        config,
        timeoutMs: CHAIN_TIMEOUT_MS,
        skipStages: ["gemini-live"],
      },
      { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
    );
  };

  bb.http.experimental_websocket(
    "/live-voice",
    createLiveVoiceHandler({
      tokens: liveTokens,
      readConfig: readLiveConfig,
      createSession: (options) => new LiveGeminiSession({ ...options, log: liveLog }),
      fallback: liveFallback,
      log: liveLog,
    }),
    { auth: "local" },
  );

  bb.rpc.register(rpcContract, {
    liveToken: async () => {
      if (!(await liveInputEnabled())) {
        throw new Error("живой ввод выключен в настройках плагина");
      }
      return { token: liveTokens.issue() };
    },
    /**
     * Файловая цепочка для клиентского фоллбэка (§4.3а): сокет умер до
     * отпускания — реплея не было, Gemini не трогали, skipStages не нужен.
     */
    clientLog: async ({ msg }) => {
      bb.log.info(`live-voice: client ${msg}`);
      return {};
    },
    liveFallback: async ({ audioBase64, filename, mimeType }) => {
      const bytes = Buffer.from(audioBase64, "base64");
      const res = await callTranscribe(
        {
          bytes,
          mimeType: mimeType ?? "audio/wav",
          filename,
        },
        null,
      );
      // Итог файлового распознавания живого режима — иначе в логе сервера его не видно.
      bb.log.info(
        `live-voice: file fallback ${mimeType ?? "audio/wav"} ${Math.round(bytes.byteLength / 1024)} KB → ${
          res.ok ? `${res.text.length} chars via ${res.engine}` : `failed: ${res.message}`
        }`,
      );
      return res;
    },
  });
}
