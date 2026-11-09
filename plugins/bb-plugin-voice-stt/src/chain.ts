/**
 * Оркестратор стадий `voice-stt.transcribe` (спека §5):
 * ffmpeg → Gemini Live (по ключу за раз) → Codex → Groq.
 *
 * Общий дедлайн — `timeoutMs` от вызвавшего и `context.signal`; перед каждой
 * стадией guard `remainingMs < 5000` пропускает её с пометкой `timeout`.
 * Первый непустой текст побеждает; если все стадии упали — `{ok:false}` с
 * причинами по стадиям и кодом последней из ОТРАБОТАВШИХ.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { decodeToPcm16 } from "./audio.js";
import { transcribeCodex, type TranscribeCodexOptions } from "./codex.js";
import {
  CODEX_TIMEOUT_MS,
  FFMPEG_TIMEOUT_MS,
  GROQ_TIMEOUT_MS,
  MAX_AUDIO_BYTES,
  STAGE_MIN_REMAINING_MS,
  AiServiceFailure,
  languageBaseCode,
  maskSecretValue,
  toFailureResult,
  type EngineId,
  type FailureCode,
  type TranscribeInput,
  type TranscribeOutput,
} from "./contract.js";
import { transcribeGeminiLive, type GeminiLiveSessionOptions } from "./gemini-live.js";
import { transcribeGroq, type TranscribeGroqOptions } from "./groq.js";

export interface ChainContext {
  signal: AbortSignal;
  tempDir: string;
  /** Лог host-воркера — факты стадий и коды, без ключей и транскрипта. */
  log?: (message: string) => void;
}

/** Точки внедрения для тестов — замоканные стадии и часы. */
export interface ChainDeps {
  decodePcm?: (inputPath: string, outputPath: string, timeoutMs: number, signal: AbortSignal) => Promise<Buffer>;
  gemini?: (options: GeminiLiveSessionOptions) => Promise<string>;
  codex?: (options: TranscribeCodexOptions) => Promise<string>;
  groq?: (options: TranscribeGroqOptions) => Promise<string>;
  now?: () => number;
}

interface StageFailure {
  stage: string;
  code: FailureCode;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "video/webm": ".webm",
};

/** Имя временного входного файла: basename без сюрпризов, расширение по mime. */
function inputFileName(filename: string, mimeType: string): string {
  const base = basename(filename).replace(/[^\w.\-]+/g, "_") || "voice-input";
  if (extname(base) !== "") return base;
  return `${base}${MIME_EXTENSIONS[mimeType.split(";", 1)[0]?.trim() ?? ""] ?? ".webm"}`;
}

export async function runTranscribeChain(
  input: TranscribeInput,
  context: ChainContext,
  deps: ChainDeps = {},
): Promise<TranscribeOutput> {
  const now = deps.now ?? (() => Date.now());
  const log = context.log ?? (() => {});
  const decodePcm =
    deps.decodePcm ??
    ((inputPath: string, outputPath: string, timeoutMs: number, signal: AbortSignal) =>
      decodeToPcm16(inputPath, outputPath, { timeoutMs, signal }));
  const gemini = deps.gemini ?? transcribeGeminiLive;
  const codex = deps.codex ?? transcribeCodex;
  const groq = deps.groq ?? transcribeGroq;

  const audio = Buffer.from(input.audioBase64, "base64");
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new AiServiceFailure(
      "request_failed",
      "voice_stt_input_too_large",
      `Recordings over ${MAX_AUDIO_BYTES / (1024 * 1024)} MB are too large to transcribe`,
    );
  }

  const deadline = now() + input.timeoutMs;
  const remaining = (): number => Math.max(0, deadline - now());
  const budget = (cap: number): number => Math.min(cap, remaining());

  const dir = await mkdtemp(join(context.tempDir, "voice-stt-"));
  const inputPath = join(dir, inputFileName(input.filename, input.mimeType));
  await writeFile(inputPath, audio);

  const reasons: string[] = [];
  const failures: StageFailure[] = [];

  const skippedByBudget = (stage: string): boolean => {
    if (remaining() >= STAGE_MIN_REMAINING_MS) return false;
    reasons.push(`${stage}: skipped (less than ${STAGE_MIN_REMAINING_MS}ms left)`);
    failures.push({ stage, code: "timeout" });
    log(`${stage}: skipped, ${remaining()}ms left`);
    return true;
  };

  // Явный пропуск стадий (спека voice-stt-live §4.5): фоллбэк живого режима
  // просит codex→groq без повторного прогона Gemini и без ffmpeg-декода.
  const skipStages = new Set<EngineId>(input.skipStages ?? []);
  const skippedByCaller = (stage: EngineId): boolean => {
    if (!skipStages.has(stage)) return false;
    reasons.push(`${stage}: skipped (skipStages)`);
    log(`${stage}: skipped via skipStages`);
    return true;
  };

  try {
    const cfg = input.config;

    // --- Стадия Gemini Live (§5 п. 3, §6) ---
    if (cfg.geminiKeys.length > 0 && !skippedByCaller("gemini-live") && !skippedByBudget("gemini-live")) {
      let pcm: Buffer | null = null;
      try {
        pcm = await decodePcm(
          inputPath,
          join(dir, "audio.pcm"),
          budget(FFMPEG_TIMEOUT_MS),
          context.signal,
        );
      } catch (e) {
        const failure = toFailureResult(e);
        log(`gemini-live: ffmpeg decode failed: ${failure.message}`);
        reasons.push(`gemini-live: ffmpeg: ${failure.message}`);
        failures.push({ stage: "gemini-live", code: failure.code });
      }
      if (pcm !== null) {
        let keyFailure: { code: FailureCode; message: string } | null = null;
        let emptyTranscript = false;
        for (const [index, key] of cfg.geminiKeys.entries()) {
          if (remaining() < STAGE_MIN_REMAINING_MS) {
            keyFailure = {
              code: "timeout",
              message: `key ${index + 1}: skipped (less than ${STAGE_MIN_REMAINING_MS}ms left)`,
            };
            break;
          }
          try {
            // Бюджет ключ-сессии масштабируется длиной аудио (спека §5):
            // min(15 + 0.4·audioSec, 55) с — файл ушёл пачкой, транскрипт
            // догоняет потоком примерно пропорционально длительности.
            const audioMs = pcm.length / 32;
            const sessionMs = Math.min(15_000 + audioMs * 0.4, 55_000);
            const text = (
              await gemini({
                apiKey: key,
                model: cfg.geminiLiveModel,
                pcm,
                language: cfg.language,
                hint: input.hint,
                timeoutMs: budget(sessionMs),
                signal: context.signal,
                log,
              })
            ).trim();
            if (text !== "") {
              log(`gemini-live: key ${index + 1} produced ${text.length} characters`);
              return { ok: true, text, engine: "gemini-live" };
            }
            // Пустой финал (тишина) — мягкий провал стадии, без смены ключа (ADR-0002).
            emptyTranscript = true;
            break;
          } catch (e) {
            const failure = toFailureResult(e);
            // Страховка §6.1/§10: значение ключа не должно всплыть в причинах.
            keyFailure = {
              code: failure.code,
              message: maskSecretValue(failure.message, key),
            };
            log(`gemini-live: key ${index + 1} failed: ${keyFailure.message}`);
          }
        }
        const reason =
          emptyTranscript && keyFailure === null
            ? "gemini-live: empty transcript (silence)"
            : `gemini-live: ${keyFailure?.message ?? "failed"}`;
        reasons.push(reason);
        failures.push({ stage: "gemini-live", code: keyFailure?.code ?? "invalid_response" });
      }
    }

    // --- Стадия Codex (§5 п. 4, §7) ---
    if (!skippedByCaller("codex") && !skippedByBudget("codex")) {
      try {
        const text = (
          await codex({
            audio,
            mimeType: input.mimeType,
            filename: input.filename,
            hint: input.hint,
            timeoutMs: budget(CODEX_TIMEOUT_MS),
            signal: context.signal,
          })
        ).trim();
        if (text !== "") {
          log(`codex: produced ${text.length} characters`);
          return { ok: true, text, engine: "codex" };
        }
        reasons.push("codex: empty transcript");
        failures.push({ stage: "codex", code: "invalid_response" });
      } catch (e) {
        const failure = toFailureResult(e);
        log(`codex: failed ${failure.code}: ${failure.message}`);
        reasons.push(`codex: ${failure.message}`);
        failures.push({ stage: "codex", code: failure.code });
      }
    }

    // --- Стадия Groq (§5 п. 5, §8) ---
    if (cfg.groqApiKey === null) {
      reasons.push("groq: skipped (no API key)");
      log("groq: skipped, no API key configured");
    } else if (!skippedByCaller("groq") && !skippedByBudget("groq")) {
      try {
        const text = (
          await groq({
            apiKey: cfg.groqApiKey,
            model: cfg.groqModel,
            audio,
            mimeType: input.mimeType,
            filename: input.filename,
            language: languageBaseCode(cfg.language),
            hint: input.hint,
            timeoutMs: budget(GROQ_TIMEOUT_MS),
            signal: context.signal,
          })
        ).trim();
        if (text !== "") {
          log(`groq: produced ${text.length} characters`);
          return { ok: true, text, engine: "groq" };
        }
        reasons.push("groq: empty transcript");
        failures.push({ stage: "groq", code: "invalid_response" });
      } catch (e) {
        const failure = toFailureResult(e);
        // Ключ Groq из config не логируем и в причины не тащим.
        const message = maskSecretValue(failure.message, cfg.groqApiKey);
        log(`groq: failed ${failure.code}: ${message}`);
        reasons.push(`groq: ${message}`);
        failures.push({ stage: "groq", code: failure.code });
      }
    }

    const last = failures[failures.length - 1];
    const message = reasons.join("; ") || "all transcription stages failed";
    log(`voice-stt: chain failed: ${message}`);
    return { ok: false, code: last?.code ?? "request_failed", message };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
