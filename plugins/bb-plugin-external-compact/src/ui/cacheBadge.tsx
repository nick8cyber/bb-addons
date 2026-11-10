/**
 * Бейдж-напоминание о протухшем кэше на строке треда (спека «Поток» п. 6):
 * experimental_threadRowMetadata. Опрос threads.context — не чаще
 * OFFER_POLL_MIN_INTERVAL_MS (≥60с) и только по idle/error тредам, чтобы
 * не нагружать хост.
 */
import { useEffect, useMemo, useState } from "react";
import {
  useSdk,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
} from "@get-bb/plugin-sdk/app";

import { isCompactionOffered, OFFER_POLL_MIN_INTERVAL_MS } from "../contract.js";

/** threadId → у треда истёк кэш (compactionOfferAt в прошлом). */
export type CacheBadgeData = Record<string, true>;

function isPollable(status: string): boolean {
  return status === "idle" || status === "error";
}

export function useCacheBadgeData(
  input: ExperimentalThreadRowMetadataDataInput,
): CacheBadgeData {
  const sdk = useSdk();
  const candidateKey = useMemo(
    () =>
      input.threads
        .filter((t) => isPollable(t.status))
        .map((t) => t.id)
        .sort()
        .join(","),
    [input.threads],
  );
  const [expired, setExpired] = useState<CacheBadgeData>({});

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const ids = candidateKey === "" ? [] : candidateKey.split(",");
      const next: CacheBadgeData = {};
      await Promise.all(
        ids.map(async (threadId) => {
          try {
            const ctx = await sdk.threads.context({ threadId });
            if (isCompactionOffered(ctx?.usage)) next[threadId] = true;
          } catch {
            // Тред недоступен (удалён, хост офлайн) — бейджа просто нет.
          }
        }),
      );
      if (!cancelled) setExpired(next);
    };
    void poll();
    const timer = setInterval(() => void poll(), OFFER_POLL_MIN_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sdk, candidateKey]);

  return expired;
}

export function CacheBadge({
  thread,
  data,
}: ExperimentalThreadRowMetadataProps<CacheBadgeData>) {
  if (data?.[thread.id] !== true) return null;
  return (
    <span
      className="ec-badge"
      title="Кэш промпта истёк — bb предлагает compact. Действие «Compact via Gemini (free)» сожмёт историю бесплатной Gemini в новый тред."
    >
      <span aria-hidden="true">⏳</span> compact?
    </span>
  );
}
