import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { STALE_USAGE_WARNING } from "./collector-adapter";

type UsageWindow = {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  cost: null;
};

type Usage = {
  status: "ok" | "error" | "expired";
  accountEmail: string | null;
  planLabel: string | null;
  windows?: UsageWindow[];
  message?: string;
};

type Snapshot = { usage: Usage | null; warning: string | null };
type Credentials = {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  project_id: string;
};
type Profile = { key: string; credentials: Credentials | null };
type Json = Record<string, unknown>;

const PROD = "https://cloudcode-pa.googleapis.com";
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
// Google's ACP useragent.py requires the antigravity client token to select
// Antigravity entitlements. Identify this collector as its own client surface.
const USER_AGENT =
  `antigravity/usage-pro/0.1.0 (aidev_client; os_type=${platform()}; arch=${arch()};` +
  " host_path=bb-usage-pro/0.1.0; proxy_client=antigravity/sdk)";

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

class QuotaError extends Error {
  constructor(message: string, readonly expired = false) {
    super(message);
  }
}

function quotaWindows(response: Json): UsageWindow[] {
  if (!Array.isArray(response.groups)) {
    throw new QuotaError("Google did not return quota groups.");
  }
  const windows: UsageWindow[] = [];
  for (const rawGroup of response.groups) {
    const group = object(rawGroup);
    if (!Array.isArray(group.buckets)) continue;
    for (const rawBucket of group.buckets) {
      const bucket = object(rawBucket);
      // Disabled buckets are frozen counters while the longer window governs;
      // the pool card emits them verbatim, so the native card does too.
      const fraction = bucket.remainingFraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction) ||
          fraction < 0 || fraction > 1) {
        throw new QuotaError("Google returned an invalid quota measurement.");
      }
      const family = text(group.displayName) ?? "Antigravity";
      const label = family.includes("Gemini") ? "Gemini"
        : /Claude|GPT/.test(family) ? "Claude" : family;
      const window = bucket.window === "5h" ? "5h"
        : bucket.window === "weekly" ? "Weekly" : text(bucket.displayName);
      const reset = text(bucket.resetTime);
      windows.push({
        label: [label, window].filter(Boolean).join(" "),
        usedPercent: Math.round((1 - fraction) * 10_000) / 100,
        resetsAt: reset && Number.isFinite(Date.parse(reset)) ? reset : null,
        cost: null,
      });
    }
  }
  return windows;
}

/** Picks a window suffix from the reset distance: matches the pool's 5h/Weekly convention. */
function windowKind(resetsAt: string | null, now: number): string {
  if (!resetsAt) return "Weekly";
  const delta = Date.parse(resetsAt) - now;
  if (delta <= 10 * 3_600_000) return "5h";
  if (delta <= 40 * 3_600_000) return "Daily";
  return "Weekly";
}

/**
 * Per-model quota from fetchAvailableModels. The grouped summary can omit an
 * entire family (Google reports only the third-party group for some tiers), so
 * the tightest remaining share across the family's models becomes its window.
 */
function modelWindows(response: Json, existing: UsageWindow[], now: number): UsageWindow[] {
  const models = object(response.models);
  const families = new Map<string, { fraction: number; resetsAt: string | null }>();
  for (const raw of Object.values(models)) {
    const model = object(raw);
    const provider = text(model.apiProvider) ?? "";
    const family = provider.includes("GOOGLE_GEMINI") ? "Gemini"
      : /Claude|GPT|OPENAI|ANTHROPIC/.test(provider) ? "Claude" : null;
    if (family === null) continue;
    const quota = object(model.quotaInfo);
    const rawFraction = quota.remainingFraction;
    const fraction = typeof rawFraction === "number" && Number.isFinite(rawFraction)
      ? rawFraction
      : text(quota.resetTime) !== null ? 0 : null;
    if (fraction === null || fraction < 0 || fraction > 1) continue;
    const reset = text(quota.resetTime);
    const resetsAt = reset && Number.isFinite(Date.parse(reset)) ? reset : null;
    const seen = families.get(family);
    if (!seen || fraction < seen.fraction ||
        (fraction === seen.fraction && resetsAt !== null &&
         (seen.resetsAt === null || resetsAt < seen.resetsAt))) {
      families.set(family, { fraction, resetsAt });
    }
  }
  const windows: UsageWindow[] = [];
  for (const [family, quota] of families) {
    const label = `${family} ${windowKind(quota.resetsAt, now)}`;
    // A summary bucket already covers this family when it lands on the same
    // reset instant — distance-named labels can alias it into a fake second
    // window (e.g. a weekly reset ~35h out would read as "Daily").
    const dupe = existing.some(w => w.label === label ||
      (w.label.startsWith(`${family} `) && w.resetsAt !== null &&
       quota.resetsAt !== null &&
       Math.abs(Date.parse(w.resetsAt) - Date.parse(quota.resetsAt)) < 120_000));
    if (dupe) continue;
    windows.push({
      label,
      usedPercent: Math.round((1 - quota.fraction) * 10_000) / 100,
      resetsAt: quota.resetsAt,
      cost: null,
    });
  }
  return windows;
}

/** Reads the native ACP profile and Google quota APIs; never starts an agent or writes auth. */
export function createAntigravityAcpUsage(options: {
  userHome: () => string;
  fetch: typeof fetch;
  now: () => number;
}) {
  let activeKey: string | null = null;
  let cached: Snapshot | null = null;
  let loadedAt = 0;
  let access: { key: string; token: string; expiresAt: number } | null = null;
  let pending: { key: string; promise: Promise<Snapshot | null> } | null = null;

  function profile(): Profile | null {
    let raw: string;
    try {
      raw = readFileSync(join(options.userHome(), ".gemini", "antigravity-acp", "acp_token.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { key: "unreadable", credentials: null };
    }
    const key = createHash("sha256").update(raw).digest("hex");
    try {
      const value = object(JSON.parse(raw));
      const valid = ["client_id", "client_secret", "refresh_token", "project_id"]
        .every((field) => text(value[field]) !== null);
      return { key, credentials: valid ? value as Credentials : null };
    } catch {
      return { key, credentials: null };
    }
  }

  function current(): Profile | null {
    const value = profile();
    if ((value?.key ?? null) !== activeKey) {
      activeKey = value?.key ?? null;
      cached = null;
      access = null;
      loadedAt = 0;
    }
    return value;
  }

  function getCached(): Snapshot | null {
    return current() ? cached ?? { usage: null, warning: null } : null;
  }

  async function request(url: string, init: RequestInit): Promise<Json> {
    let response: Response;
    try {
      response = await options.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new QuotaError("Google quota service could not be reached.");
    }
    if (!response.ok) {
      const oauth = url === "https://oauth2.googleapis.com/token";
      throw new QuotaError(
        `Google ${oauth ? "authorization" : "quota"} request failed (HTTP ${response.status}).`,
        response.status === 401 || (oauth && response.status === 400),
      );
    }
    try {
      return object(await response.json());
    } catch {
      throw new QuotaError("Google returned an unreadable quota response.");
    }
  }

  async function collect(value: Profile): Promise<Snapshot> {
    const credentials = value.credentials;
    if (!credentials) throw new QuotaError("The native Antigravity profile is incomplete or unreadable.");
    let token = access?.key === value.key && access.expiresAt > options.now() ? access.token : null;
    if (!token) {
      const auth = await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          refresh_token: credentials.refresh_token,
        }),
      });
      token = text(auth.access_token);
      if (!token) throw new QuotaError("Google did not return an access token.", true);
      const expires = typeof auth.expires_in === "number" && auth.expires_in > 60 ? auth.expires_in : 300;
      if (current()?.key === value.key) {
        access = { key: value.key, token, expiresAt: options.now() + (expires - 60) * 1000 };
      }
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    const [identity, entitlement] = await Promise.all([
      request("https://www.googleapis.com/oauth2/v2/userinfo", { headers }),
      request(`${PROD}/v1internal:loadCodeAssist`, {
        method: "POST", headers, body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      }),
    ]);
    const email = text(identity.email);
    if (!email || identity.verified_email !== true) {
      throw new QuotaError("Google could not verify the Antigravity account.");
    }
    const paidTier = object(entitlement.paidTier);
    const base = paidTier.usesGcpTos === true ? PROD : DAILY;
    const quotaBody = JSON.stringify({ project: credentials.project_id });
    // The per-model quota reports the currently governing window — the prod
    // backend returns a notional full share for consumer tiers, so only the
    // tier's own base carries real measurements.
    const [summary, models] = await Promise.all([
      request(`${base}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST", headers, body: quotaBody,
      }),
      request(`${base}/v1internal:fetchAvailableModels`, {
        method: "POST", headers, body: quotaBody,
      }),
    ]);
    const windows = quotaWindows(summary);
    const derived = modelWindows(models, windows, options.now());
    windows.push(...derived);
    if (windows.length === 0) {
      throw new QuotaError("Google did not report usable quota windows.");
    }
    windows.sort((a, b) =>
      Number(a.label.endsWith("Weekly")) - Number(b.label.endsWith("Weekly")));
    return {
      usage: {
        status: "ok", accountEmail: email,
        planLabel: text(paidTier.name) ?? text(object(entitlement.currentTier).name),
        windows,
      },
      warning: null,
    };
  }

  async function get(force: boolean, maxAgeMs: number): Promise<Snapshot | null> {
    const value = current();
    if (!value) return null;
    if (!force && cached && options.now() - loadedAt < Math.max(maxAgeMs, 180_000)) return cached;
    if (pending?.key === value.key) return pending.promise;
    const promise = (async () => {
      let result: Snapshot;
      try {
        result = await collect(value);
      } catch (error) {
        const expired = error instanceof QuotaError && error.expired;
        result = !expired && cached?.usage?.status === "ok" && activeKey === value.key
          ? { ...cached, warning: STALE_USAGE_WARNING }
          : {
            usage: {
              status: expired ? "expired" : "error",
              accountEmail: null, planLabel: null,
              ...(!expired ? { message: error instanceof QuotaError ? error.message : "Antigravity usage could not be collected." } : {}),
            },
            warning: null,
          };
      }
      // A completed request for a replaced/deleted login must never paint the new account.
      if (current()?.key !== value.key) return getCached();
      cached = result;
      loadedAt = options.now();
      return cached;
    })().finally(() => {
      if (pending?.promise === promise) pending = null;
    });
    pending = { key: value.key, promise };
    return promise;
  }

  return {
    get, getCached,
    invalidate() { loadedAt = 0; },
    accountEmail(): string | null {
      const usage = cached?.usage;
      return usage?.status === "ok" ? usage.accountEmail : null;
    },
  };
}
