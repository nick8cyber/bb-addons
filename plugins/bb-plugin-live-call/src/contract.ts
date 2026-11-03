/**
 * Протокол браузер ↔ сервер и константы аудио (контракт §2).
 * Версия протоколов — 1; любое несовместимое изменение поднимает её.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Вход: PCM16 LE моно 16 кГц, кадр 20 мс = 320 сэмплов = 640 байт. Выход: PCM16 LE 24 кГц. */
export const MIC_RATE = 16000;
export const PLAYBACK_RATE = 24000;
export const MIC_FRAME_MS = 20;
export const MIC_FRAME_BYTES = (MIC_RATE * MIC_FRAME_MS * 2) / 1000; // 640
export const BYTES_PER_SECOND_24K = PLAYBACK_RATE * 2; // 48000 байт = 1 с аудио

/** Служебный заголовок бинарного кадра: byte 0 — тип, bytes 1..4 — turnSeq uint32 LE. */
export const FRAME_HEADER_BYTES = 5;
export const FRAME_MIC = 0x01;
export const FRAME_PLAYBACK = 0x02;

export const CONFIRM_TTL_MS = 60_000;
export const WINDOW_PADDING_MS = 300;
export const WINDOW_SERVER_SLACK_MS = 1000;
export const UTTERANCE_SILENCE_MS = 700;
export const TRANSCRIPT_WAIT_MS = 3000;
export const MAX_UTTERANCE_WORDS = 6;
/** Окно дедупликации записи по argsHash после вердикта (спека §7.1 п. 1). */
export const ARGS_HASH_DEDUP_MS = 5 * 60_000;
export const TOOL_TIMEOUT_MS = 20_000;
export const TOOL_RESULT_MAX_CHARS = 6000;
export const TPM_WARN_THRESHOLD = 50_000;
export const TPM_WINDOW_MS = 60_000;
export const HELLO_TIMEOUT_MS = 5000;
export const BUSY_CLOSE_CODE = 4009;

export function packFrame(type: number, turnSeq: number, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + pcm.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, turnSeq, true);
  out.set(pcm, FRAME_HEADER_BYTES);
  return out;
}

export function parseFrame(data: Uint8Array): { type: number; turnSeq: number; pcm: Uint8Array } {
  if (data.length < FRAME_HEADER_BYTES) throw new Error("frame too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    type: data[0],
    turnSeq: view.getUint32(1, true),
    pcm: data.subarray(FRAME_HEADER_BYTES),
  };
}

export const clientFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(PROTOCOL_VERSION),
    mode: z.enum(["normal", "extended"]).optional(),
    /** Переподключение к идущему звонку после обрыва WS (мобильная сеть, Connect). */
    resume: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("mute"), muted: z.boolean() }),
  z.object({ type: z.literal("playback_drained"), turnSeq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("switch_mode"), mode: z.enum(["normal", "extended"]) }),
  z.object({
    type: z.literal("confirm"),
    confirmationId: z.string().min(1),
    decision: z.enum(["approve", "cancel"]),
  }),
  z.object({ type: z.literal("end") }),
  // Диагностика браузера: ошибки микрофона, уровень сигнала. Сервер пишет в журнал звонка.
  z.object({ type: z.literal("client_log"), event: z.string().min(1), detail: z.string().max(500).optional() }),
]);
export type ClientFrame = z.infer<typeof clientFrame>;

const stateSchema = z.enum([
  "connecting", "listening", "thinking", "speaking", "working", "reconnecting", "muted", "ended",
]);

export const serverFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    callId: z.string(),
    mode: z.enum(["normal", "extended"]),
    voice: z.string(),
    keys: z.object({ active: z.number().int().min(1).max(2), of: z.number().int().min(1).max(2) }),
  }),
  z.object({ type: z.literal("thread"), threadId: z.string() }),
  z.object({ type: z.literal("state"), state: stateSchema, detail: z.string().optional() }),
  z.object({
    type: z.literal("transcript"),
    role: z.enum(["owner", "agent"]),
    text: z.string(),
    final: z.boolean(),
    turnSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("interrupted"), turnSeq: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("action"),
    actionId: z.string(),
    tool: z.string(),
    class: z.enum(["R", "C", "P", "L"]),
    status: z.enum(["running", "done", "failed", "cancelled"]),
    summary: z.string(),
    threadId: z.string().optional(),
  }),
  z.object({
    type: z.literal("confirmation"),
    confirmationId: z.string(),
    class: z.enum(["C", "P", "L"]),
    tool: z.string(),
    summary: z.string(),
    word: z.string(),
    expiresAt: z.string(),
    phase: z.enum(["asking", "listening"]),
  }),
  z.object({
    type: z.literal("confirmation_result"),
    confirmationId: z.string(),
    verdict: z.enum(["approved", "hint", "cancelled", "expired", "not_confirmed"]),
  }),
  z.object({
    type: z.literal("event"),
    kind: z.enum(["thread.idle", "thread.failed", "interaction.pending"]),
    threadId: z.string(),
    summary: z.string(),
    queued: z.boolean(),
  }),
  z.object({ type: z.literal("mode"), mode: z.enum(["normal", "extended"]), switching: z.boolean() }),
  z.object({
    type: z.literal("key"),
    active: z.number().int().min(1).max(2),
    of: z.number().int().min(1).max(2),
    reason: z.enum(["quota", "unavailable"]),
  }),
  z.object({
    type: z.literal("warning"),
    code: z.enum(["tpm_near_limit", "call_ending", "extended_unavailable", "mic_silent"]),
    message: z.string(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string(), retryable: z.boolean() }),
  z.object({
    type: z.literal("ended"),
    callId: z.string(),
    threadId: z.string().nullable(),
    reason: z.enum(["owner", "limit", "error"]),
  }),
]);
export type ServerFrame = z.infer<typeof serverFrame>;

/** Ответ инструмента (контракт §4). */
export type ToolResult =
  | { ok: true; data: Json; truncated?: boolean }
  | { ok: false; error: { code: string; message: string } }
  | { ok: false; needsConfirmation: { confirmationId: string; say: string } };

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const TOOL_CLASS = ["R", "C", "P", "L"] as const;
export type ToolClass = (typeof TOOL_CLASS)[number];
