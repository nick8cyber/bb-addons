/**
 * The `janitor` plugin setting (spec orchestrator §15): one JSON document
 * controlling the background cleanup of merged executor copies, branches
 * and threads. Default `{"enabled": false}` — a fresh user gets no
 * janitor; the `orchestrator-setup` skill offers enabling it.
 *
 * Unlike `policy`/`release`, a malformed document is NOT a configuration
 * error: §15 prescribes a journal warning and the janitor stays off, so
 * `parseJanitorConfig` returns `config = null` alongside `errors` and the
 * caller only logs.
 *
 * Shape:
 * {
 *   "enabled": true,
 *   "mode": "apply",
 *   "afterMerge": "10h",
 *   "abandonedAfter": "10d",
 *   "intervalMinutes": 60,
 *   "excludeProjects": ["proj_x"],
 *   "protectedBranches": ["main", "master", "dev"],
 *   "deleteBranches": true,
 *   "scope": "workers"
 * }
 *
 * §15: a missing or invalid `mode` falls back to `report` — never delete
 * on an unclear setting; an unknown key is a validation error and keeps
 * the janitor off.
 */
import type { PolicyIssue } from "./policy.js";

export type JanitorMode = "apply" | "report";
/** §16.3: `workers` — dispatch threads and children; `all` — root chats too. */
export type JanitorScope = "workers" | "all";

export interface JanitorConfig {
  enabled: boolean;
  mode: JanitorMode;
  afterMergeMs: number;
  abandonedAfterMs: number;
  intervalMinutes: number;
  excludeProjects: string[];
  protectedBranches: string[];
  deleteBranches: boolean;
  scope: JanitorScope;
}

export interface JanitorConfigLoad {
  /** Normalized config, or null when disabled/empty/invalid. */
  config: JanitorConfig | null;
  errors: PolicyIssue[];
}

const DEFAULT_PROTECTED = ["main", "master", "dev"];
const MIN_AFTER_MERGE_MS = 15 * 60_000;
const MIN_ABANDONED_MS = 24 * 60 * 60_000;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isNonEmptyString = (x: unknown): x is string =>
  typeof x === "string" && x.trim().length > 0;

/** `<n>m` minutes, `<n>h` hours, `<n>d` days -> milliseconds. */
export function parseDurationMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  return unit === "m"
    ? n * 60_000
    : unit === "h"
      ? n * 3_600_000
      : n * 86_400_000;
}

export function parseJanitorConfig(
  text: string | undefined,
): JanitorConfigLoad {
  const errors: PolicyIssue[] = [];
  const err = (path: string, message: string) =>
    errors.push({ path, message });

  if (!text || text.trim() === "") {
    return { config: null, errors };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    err("$", `invalid JSON: ${(e as Error).message}`);
    return { config: null, errors };
  }
  if (!isRecord(raw)) {
    err("$", "janitor setting must be a JSON object");
    return { config: null, errors };
  }

  const KNOWN_KEYS = new Set([
    "enabled",
    "mode",
    "afterMerge",
    "abandonedAfter",
    "intervalMinutes",
    "excludeProjects",
    "protectedBranches",
    "deleteBranches",
    "scope",
  ]);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      err(
        key,
        key === "enable"
          ? "unknown key `enable` — did you mean `enabled`?"
          : "unknown janitor setting key",
      );
    }
  }

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    err("enabled", "must be a boolean");
  }
  const enabled = raw.enabled === true;
  if (!enabled) {
    return { config: null, errors };
  }

  const mode: JanitorMode = raw.mode === "apply" ? "apply" : "report";

  let afterMergeMs = 10 * 3_600_000;
  if (raw.afterMerge !== undefined) {
    const ms = parseDurationMs(raw.afterMerge);
    if (ms === undefined || ms < MIN_AFTER_MERGE_MS) {
      err("afterMerge", "must be <n>m|h|d, at least 15m");
    } else {
      afterMergeMs = ms;
    }
  }

  let abandonedAfterMs = 10 * 86_400_000;
  if (raw.abandonedAfter !== undefined) {
    const ms = parseDurationMs(raw.abandonedAfter);
    if (ms === undefined || ms < MIN_ABANDONED_MS) {
      err("abandonedAfter", "must be <n>m|h|d, at least 1d");
    } else {
      abandonedAfterMs = ms;
    }
  }

  let intervalMinutes = 60;
  if (raw.intervalMinutes !== undefined) {
    if (
      typeof raw.intervalMinutes !== "number" ||
      !Number.isFinite(raw.intervalMinutes) ||
      raw.intervalMinutes < 15
    ) {
      err("intervalMinutes", "must be a number >= 15");
    } else {
      intervalMinutes = raw.intervalMinutes;
    }
  }

  let excludeProjects: string[] = [];
  if (raw.excludeProjects !== undefined) {
    if (
      !Array.isArray(raw.excludeProjects) ||
      raw.excludeProjects.some((p) => !isNonEmptyString(p))
    ) {
      err("excludeProjects", "must be an array of bb project ids");
    } else {
      excludeProjects = raw.excludeProjects.map((p) => (p as string).trim());
    }
  }

  let protectedBranches = DEFAULT_PROTECTED;
  if (raw.protectedBranches !== undefined) {
    if (
      !Array.isArray(raw.protectedBranches) ||
      raw.protectedBranches.length === 0 ||
      raw.protectedBranches.some((b) => !isNonEmptyString(b))
    ) {
      err("protectedBranches", "must be a non-empty array of branch names");
    } else {
      protectedBranches = raw.protectedBranches.map((b) =>
        (b as string).trim(),
      );
    }
  }

  let deleteBranches = true;
  if (raw.deleteBranches !== undefined) {
    if (typeof raw.deleteBranches !== "boolean") {
      err("deleteBranches", "must be a boolean");
    } else {
      deleteBranches = raw.deleteBranches;
    }
  }

  let scope: JanitorScope = "workers";
  if (raw.scope !== undefined) {
    if (raw.scope !== "workers" && raw.scope !== "all") {
      err("scope", 'must be "workers" or "all"');
    } else {
      scope = raw.scope;
    }
  }

  if (errors.length > 0) return { config: null, errors };
  return {
    config: {
      enabled,
      mode,
      afterMergeMs,
      abandonedAfterMs,
      intervalMinutes,
      excludeProjects,
      protectedBranches,
      deleteBranches,
      scope,
    },
    errors,
  };
}
