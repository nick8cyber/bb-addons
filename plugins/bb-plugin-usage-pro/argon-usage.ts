import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ARGON_PROVIDER_ID = "acp-argon";
export const ARGON_STALE_MS = 30 * 60 * 1000;

export type ArgonUsageMetric = {
  percent: number;
  resetEpochSec: number | null;
};

export type ArgonAccountSnapshot = {
  id: string;
  daily: ArgonUsageMetric | null;
  weekly: ArgonUsageMetric | null;
  tier: string | null;
  updatedAtMs: number | null;
  stale: boolean;
  ageMs: number | null;
};

function metric(value: unknown): ArgonUsageMetric | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const percent = (value as Record<string, unknown>).percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return null;
  const reset = (value as Record<string, unknown>).resetEpochSec;
  return {
    percent,
    resetEpochSec:
      typeof reset === "number" && Number.isFinite(reset) && reset >= 1.6e9
        ? Math.floor(reset)
        : null,
  };
}

export function formatArgonAge(ageMs: number): string {
  if (ageMs < 60_000) return "только что";
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} д назад`;
}

export function argonTierLabel(tier: string | null): string | null {
  if (tier === null) return null;
  const lower = tier.toLowerCase();
  if (lower === "ultra") return "Ultra";
  if (lower === "pro") return "Pro";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function defaultStateDir(userHome: () => string): string {
  const env = process.env.WEB_GEMINI_STATE_DIR || process.env.ARGON_STATE_DIR;
  if (typeof env === "string" && env.trim() !== "") return env;
  const geminiDir = join(userHome(), ".bb", "plugins", "provider-web-gemini");
  const argonDir = join(userHome(), ".bb", "plugins", "provider-argon");
  if (existsSync(geminiDir)) return geminiDir;
  if (existsSync(argonDir)) return argonDir;
  return geminiDir;
}

/**
 * Reads the usage file written by provider-web-gemini, formerly provider-argon
 * (PLUG-289 contract): `$STATE_DIR/accounts-usage.json` where $STATE_DIR is
 * `WEB_GEMINI_STATE_DIR`, else `ARGON_STATE_DIR`, else the default state dir —
 * `~/.bb/plugins/provider-web-gemini` when present, `provider-argon` as the
 * legacy fallback (mirrors the writer's resolveDefaultStateDir). The file has
 * per-account daily/weekly percent, reset epoch seconds, tier, updatedAt and
 * stale flag. The file is the only source; a missing or unreadable file yields
 * an empty list so the section simply stays hidden.
 */
export function createArgonUsage(options: {
  userHome: () => string;
  now: () => number;
  stateDir?: string | (() => string | undefined);
}) {
  const dir = () => {
    const explicit =
      typeof options.stateDir === "function" ? options.stateDir() : options.stateDir;
    return typeof explicit === "string" && explicit !== ""
      ? explicit
      : defaultStateDir(options.userHome);
  };

  function readAccounts(): ArgonAccountSnapshot[] {
    let parsed: unknown;
    try {
      const file = join(dir(), "accounts-usage.json");
      if (!existsSync(file)) return [];
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return [];
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const accounts = (parsed as Record<string, unknown>).accounts;
    if (accounts === null || typeof accounts !== "object" || Array.isArray(accounts)) {
      return [];
    }
    const now = options.now();
    const snapshots: ArgonAccountSnapshot[] = [];
    for (const [id, raw] of Object.entries(accounts)) {
      // A blank key would serialize as "" and fail the nonemptyString schema
      // of the whole getUsage response downstream.
      const accountId = id.trim();
      if (accountId === "") continue;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const updatedAt = entry.updatedAt;
      const updatedAtMs =
        typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
          ? updatedAt
          : null;
      const ageMs = updatedAtMs === null ? null : Math.max(0, now - updatedAtMs);
      snapshots.push({
        id: accountId,
        daily: metric(entry.daily),
        weekly: metric(entry.weekly),
        tier:
          typeof entry.tier === "string" && entry.tier.trim() !== ""
            ? entry.tier.trim()
            : null,
        updatedAtMs,
        stale: entry.stale === true || ageMs === null || ageMs > ARGON_STALE_MS,
        ageMs,
      });
    }
    return snapshots;
  }

  return { readAccounts };
}
