/**
 * Which model to try, and in what order, when a daily quota runs out.
 *
 * AI Studio's free tier meters each TTS model separately — ten requests a day
 * per account per model — so 3.1 running dry says nothing about 2.5. The proxy
 * in front of the accounts is configured with `max-retry-credentials: 0`,
 * which its own documentation glosses as "try all available credentials", so a
 * quota error arriving here means every account in the pool is out for that
 * model, not that one of them was unlucky. That is the moment to change model
 * rather than to give up.
 *
 * Kept apart from server.ts because it is the part worth testing, and testing
 * it there would mean standing up a whole plugin host.
 */

/** Milliseconds in a day; the reset interval Google meters against. */
const DAY_MS = 86_400_000;

/**
 * When the exhausted model can be tried again: the next midnight in Pacific
 * time, which is where Google rolls free-tier daily quotas over. Computed from
 * the wall clock there rather than from a fixed offset, so it survives the
 * twice-yearly hour.
 */
export function nextQuotaReset(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const at = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  // Some ICU builds render midnight as hour 24 rather than 0.
  const elapsed = ((at("hour") % 24) * 3600 + at("minute") * 60 + at("second")) * 1000;
  return now.getTime() + (DAY_MS - elapsed);
}

/**
 * The models to try, best first. A model in cooldown is skipped — but if that
 * would leave nothing, the full chain is returned anyway: the cooldown is our
 * guess about a clock we do not own, and guessing wrong must not turn into
 * refusing to speak.
 */
export function planModels(
  primary: string,
  fallback: string,
  isExhausted: (model: string) => boolean,
): string[] {
  const chain = [primary, fallback]
    .map((model) => model.trim())
    .filter((model, index, all) => model.length > 0 && all.indexOf(model) === index);
  if (chain.length === 0) return [];
  const live = chain.filter((model) => !isExhausted(model));
  return live.length > 0 ? live : chain;
}

/** Only a spent quota is worth changing model for. */
export function isQuotaFailure(code: string): boolean {
  return code === "rate_limited";
}

/** A burst that Google gave no delay for; long enough to outlast a minute window. */
const BURST_COOLDOWN_MS = 90_000;

/**
 * How long to stop offering a model that just returned 429.
 *
 * The daily allowance and the per-minute one arrive as the same status, and
 * the player fires several chunks at once, which is exactly what trips the
 * minute. So only a 429 that names the *day* earns a bench until the Pacific
 * rollover; anything else gets Google's own retryDelay, or a minute and a
 * half. Getting this backwards would take a model out of service for a day
 * over one busy second.
 */
export function cooldownUntil(
  failure: { quotaScope?: "day" | "burst"; retryAfterMs?: number },
  now: Date = new Date(),
): number {
  if (failure.quotaScope === "day") return nextQuotaReset(now);
  const asked = failure.retryAfterMs;
  const wait = typeof asked === "number" && asked > 0 ? asked : BURST_COOLDOWN_MS;
  return now.getTime() + Math.min(wait, nextQuotaReset(now) - now.getTime());
}
