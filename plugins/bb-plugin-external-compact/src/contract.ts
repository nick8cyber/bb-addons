/**
 * RPC-контракт bb-plugin-external-compact (спека docs/specs/external-compact.md).
 * Секретные значения (geminiApiKey) по RPC не ходят: status отдаёт только их
 * количество.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const compactThreadInputSchema = z
  .object({ threadId: z.string().min(1) })
  .strict();

export const compactThreadOutputSchema = z
  .object({
    ok: z.boolean(),
    newThreadId: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export const statusInputSchema = z.object({}).strict();

export const statusOutputSchema = z
  .object({
    /** Готовность к сжатию: настроен хотя бы один ключ Gemini. */
    ready: z.boolean(),
    /** Сколько ключей разобрано из настройки (никогда сами ключи). */
    geminiKeys: z.number().int().nonnegative(),
    /** Модель-суммаризатор. */
    model: z.string(),
    autoArchiveSource: z.boolean(),
    /** Пояснение состояния (например, что ключ не настроен). */
    note: z.string().optional(),
  })
  .strict();

export const contract = defineRpcContract({
  compactThread: {
    input: compactThreadInputSchema,
    output: compactThreadOutputSchema,
  },
  status: {
    input: statusInputSchema,
    output: statusOutputSchema,
  },
});

export type CompactThreadInput = z.infer<typeof compactThreadInputSchema>;
export type CompactThreadOutput = z.infer<typeof compactThreadOutputSchema>;
export type StatusOutput = z.infer<typeof statusOutputSchema>;

/** Модель-суммаризатор (спека «Модель и доступ»). */
export const SUMMARIZER_MODEL = "gemini-3.6-flash";
/** Минимальный интервал опроса офферов (спека «Поток» п. 1). */
export const OFFER_POLL_MIN_INTERVAL_MS = 60_000;

/** Минимальная форма usage из `threads.context` для оффера и гейта. */
export interface ThreadUsageLike {
  usedTokens?: number;
  compactionOfferAt?: string | null;
}

/** Оффер компакта: `usage.compactionOfferAt` в прошлом (спека «Поток» п. 1). */
export function isCompactionOffered(
  usage: ThreadUsageLike | null | undefined,
  now: number = Date.now(),
): boolean {
  const offerAt = usage?.compactionOfferAt;
  if (!offerAt) return false;
  const at = Date.parse(offerAt);
  return Number.isFinite(at) && at <= now;
}
