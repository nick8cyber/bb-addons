/**
 * Декодирование входного аудио в PCM16 s16le 16 kHz mono через ffmpeg — нужно
 * только для Gemini Live (спека §5 п. 2). Нет ffmpeg или ошибка декода —
 * Gemini-стадия пропускается, codex/groq работают по исходному файлу.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { AiServiceFailure } from "./contract.js";

const FFMPEG_ARGS = (input: string, output: string): string[] => [
  "-v",
  "error",
  "-i",
  input,
  "-f",
  "s16le",
  "-acodec",
  "pcm_s16le",
  "-ar",
  "16000",
  "-ac",
  "1",
  "-y",
  output,
];

let cachedAvailability: boolean | null = null;

/** Есть ли ffmpeg на PATH. Кэшируется только успех: ffmpeg могут доустановить. */
export function ffmpegAvailable(): boolean {
  if (cachedAvailability === true) return true;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 3_000 });
    cachedAvailability = true;
    return true;
  } catch {
    return false;
  }
}

/** Сброс кэша доступности — для тестов. */
export function resetFfmpegAvailabilityCache(): void {
  cachedAvailability = null;
}

/**
 * Декодирует `inputPath` в PCM16 s16le 16 kHz mono и возвращает байты.
 * Таймаут — `timeoutMs` (спека: ≤4 c); прерывание по `signal`.
 */
export async function decodeToPcm16(
  inputPath: string,
  outputPath: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Buffer> {
  if (!ffmpegAvailable()) {
    throw new AiServiceFailure(
      "service_unavailable",
      "ffmpeg_missing",
      "ffmpeg is not installed on this host; Gemini Live stage is skipped",
    );
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "ffmpeg",
      FFMPEG_ARGS(inputPath, outputPath),
      { timeout: options.timeoutMs, killSignal: "SIGKILL" },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve();
          return;
        }
        if (error.killed || options.signal?.aborted) {
          reject(
            new AiServiceFailure(
              "timeout",
              "ffmpeg_timeout",
              `ffmpeg decode timed out after ${options.timeoutMs}ms`,
            ),
          );
          return;
        }
        const detail = typeof stderr === "string" && stderr.trim() !== "" ? `: ${stderr.trim().slice(0, 200)}` : "";
        reject(
          new AiServiceFailure(
            "request_failed",
            "ffmpeg_decode_failed",
            `ffmpeg failed to decode the recording${detail}`,
          ),
        );
      },
    );
    options.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  });
  try {
    return await readFile(outputPath);
  } catch (e) {
    throw new AiServiceFailure(
      "request_failed",
      "ffmpeg_decode_failed",
      `ffmpeg produced no PCM output: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
