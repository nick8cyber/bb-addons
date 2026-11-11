/**
 * The `release` plugin setting (spec orchestrator-release §6): the default
 * rule plus per-bb-project overrides, in one JSON document. An empty
 * setting means the `release` command is disabled — the plugin loads fine
 * and the command refuses with a setup hint (orchestrator §2 rev 20).
 * A malformed document is a configuration error: the plugin reports
 * `needs-configuration`.
 *
 * Shape:
 * {
 *   "commitIdentity": "Имя <id+логин@users.noreply.github.com>" | "repo",
 *   "defaults": { "target": {"action":"push","branch":"main"}, "checks": [], "public": false, … },
 *   "projects": { "proj_a": {…}, "proj_b": {"target":{"action":"pr","branch":"dev"}, …} }
 * }
 * Project keys override `defaults` key by key; a project's `commitIdentity`
 * overrides the top-level one.
 */
import type { PolicyIssue } from "./policy.js";

export type ReleaseAction = "push" | "pr";
export type SyncMode = "merge" | "rebase";
export type LeakStrictness = "block" | "warn";

export interface ReleaseTarget {
  action: ReleaseAction;
  branch: string;
}

export interface ReleaseLeaks {
  machine?: LeakStrictness;
  bbIds?: LeakStrictness;
  allow?: string[];
}

/** One layer of the §6 document — `defaults` and each `projects.*` entry. */
export interface ReleaseProjectLayer {
  target?: ReleaseTarget;
  sync?: SyncMode;
  checks?: string[];
  public?: boolean;
  docsMap?: Record<string, string[]>;
  leaks?: ReleaseLeaks;
  excluded?: boolean;
  commitIdentity?: string;
  /** §16.6: `true` (default) — the «Источник: bb тред thr_…» line goes
   * into PR bodies and `thr_…` ids are not a leak; `false` — no
   * «Источник» line and `thr_…` is a `leaks.bbIds` finding. */
  threadIds?: boolean;
  /** §17.3 (С6): category-2 trailer names the project allows in commit
   * messages (`Co-Authored-By`, `Signed-off-by`, …). Unset — every
   * foreign-bot trailer blocks. */
  allowedTrailers?: string[];
  /** §17.3 (С6): addresses (`a@b.c`) and domains (`@b.c` or `b.c`)
   * that do not count as a personal-email leak. */
  allowedEmails?: string[];
}

export interface ReleaseConfig {
  commitIdentity?: string;
  defaults: ReleaseProjectLayer;
  projects: Record<string, ReleaseProjectLayer>;
}

export interface ReleaseConfigLoad {
  /** Normalized config, or null (empty text or `errors` non-empty). */
  config: ReleaseConfig | null;
  /** True when the setting is unset — release disabled, not an error. */
  empty: boolean;
  errors: PolicyIssue[];
}

/** The per-project view after `defaults` and `commitIdentity` resolution. */
export interface ResolvedProject {
  excluded: boolean;
  target: ReleaseTarget;
  sync: SyncMode;
  checks: string[];
  public: boolean;
  docsMap: Record<string, string[]>;
  leaks: {
    machine: LeakStrictness;
    bbIds: LeakStrictness;
    allow: string[];
  };
  /** Allowed commit signature, `"repo"` (read from the repo config), or
   * undefined when nothing allows a signature — every author then fails
   * category 2. */
  commitIdentity?: string;
  /** §16.6 `threadIds` — default `true`. */
  threadIds: boolean;
  /** §17.3 (С6): foreign-bot trailers this project accepts (default []). */
  allowedTrailers: string[];
  /** §17.3 (С6): emails/domains that are not a leak (default []). */
  allowedEmails: string[];
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isNonEmptyString = (x: unknown): x is string =>
  typeof x === "string" && x.trim().length > 0;

/** `"repo"` or a `Name <email>` signature (§4 category 2). */
export const isCommitIdentity = (x: unknown): x is string =>
  x === "repo" ||
  (typeof x === "string" && /^[^\n<>]+<[^\s<>]+@[^\s<>]+>\s*$/.test(x.trim()));

function parseTarget(
  value: unknown,
  path: string,
  err: (p: string, m: string) => void,
): ReleaseTarget | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    err(path, "must be an object {action, branch}");
    return undefined;
  }
  let action: ReleaseAction | undefined;
  if (value.action !== "push" && value.action !== "pr") {
    err(`${path}.action`, `must be "push" or "pr"`);
  } else {
    action = value.action;
  }
  let branch: string | undefined;
  if (!isNonEmptyString(value.branch)) {
    err(`${path}.branch`, "required non-empty branch name");
  } else {
    branch = value.branch.trim();
  }
  return action && branch ? { action, branch } : undefined;
}

function parseLayer(
  value: unknown,
  path: string,
  err: (p: string, m: string) => void,
): ReleaseProjectLayer {
  const layer: ReleaseProjectLayer = {};
  if (!isRecord(value)) {
    err(path, "must be an object");
    return layer;
  }
  const target = parseTarget(value.target, `${path}.target`, err);
  if (target) layer.target = target;
  if (value.sync !== undefined) {
    if (value.sync === "merge" || value.sync === "rebase") {
      layer.sync = value.sync;
    } else {
      err(`${path}.sync`, `must be "merge" or "rebase"`);
    }
  }
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks)) {
      err(`${path}.checks`, "must be an array of non-empty commands");
    } else {
      const bad = value.checks.findIndex((c) => !isNonEmptyString(c));
      if (bad >= 0) {
        err(`${path}.checks[${bad}]`, "must be a non-empty command");
      } else {
        layer.checks = value.checks.map((c) => (c as string).trim());
      }
    }
  }
  if (value.public !== undefined) {
    if (typeof value.public !== "boolean") {
      err(`${path}.public`, "must be a boolean");
    } else {
      layer.public = value.public;
    }
  }
  if (value.docsMap !== undefined) {
    if (!isRecord(value.docsMap)) {
      err(`${path}.docsMap`, "must be an object path-prefix → doc paths");
    } else {
      const docsMap: Record<string, string[]> = {};
      for (const [prefix, docs] of Object.entries(value.docsMap)) {
        if (!isNonEmptyString(prefix)) {
          err(`${path}.docsMap`, "path prefixes must be non-empty strings");
          continue;
        }
        if (
          !Array.isArray(docs) ||
          docs.some((d) => !isNonEmptyString(d))
        ) {
          err(
            `${path}.docsMap.${prefix}`,
            "must be an array of non-empty doc paths",
          );
          continue;
        }
        docsMap[prefix] = docs.map((d) => (d as string).trim());
      }
      layer.docsMap = docsMap;
    }
  }
  if (value.leaks !== undefined) {
    if (!isRecord(value.leaks)) {
      err(`${path}.leaks`, "must be an object {machine, bbIds, allow}");
    } else {
      const leaks: ReleaseLeaks = {};
      for (const key of ["machine", "bbIds"] as const) {
        const v = value.leaks[key];
        if (v === undefined) continue;
        if (v === "block" || v === "warn") {
          leaks[key] = v;
        } else {
          err(`${path}.leaks.${key}`, `must be "block" or "warn"`);
        }
      }
      if (value.leaks.allow !== undefined) {
        if (
          !Array.isArray(value.leaks.allow) ||
          value.leaks.allow.some((a) => !isNonEmptyString(a))
        ) {
          err(`${path}.leaks.allow`, "must be an array of non-empty paths");
        } else {
          leaks.allow = value.leaks.allow.map((a) => (a as string).trim());
        }
      }
      layer.leaks = leaks;
    }
  }
  if (value.excluded !== undefined) {
    if (typeof value.excluded !== "boolean") {
      err(`${path}.excluded`, "must be a boolean");
    } else {
      layer.excluded = value.excluded;
    }
  }
  if (value.commitIdentity !== undefined) {
    if (!isCommitIdentity(value.commitIdentity)) {
      err(
        `${path}.commitIdentity`,
        'must be "repo" or a "Name <email>" signature',
      );
    } else {
      layer.commitIdentity = value.commitIdentity;
    }
  }
  if (value.threadIds !== undefined) {
    if (typeof value.threadIds !== "boolean") {
      err(`${path}.threadIds`, "must be a boolean");
    } else {
      layer.threadIds = value.threadIds;
    }
  }
  for (const key of ["allowedTrailers", "allowedEmails"] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((a) => !isNonEmptyString(a))) {
      err(`${path}.${key}`, "must be an array of non-empty strings");
    } else {
      layer[key] = v.map((a) => (a as string).trim());
    }
  }
  return layer;
}

export function parseReleaseConfig(
  text: string | undefined,
): ReleaseConfigLoad {
  const errors: PolicyIssue[] = [];
  const err = (path: string, message: string) =>
    errors.push({ path, message });
  const done = (empty = false): ReleaseConfigLoad => ({
    config: null,
    empty,
    errors,
  });

  if (!text || text.trim() === "") return done(true);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    err("$", `невалидный JSON: ${(e as Error).message}`);
    return done();
  }
  if (!isRecord(raw)) {
    err("$", "настройка release должна быть JSON-объектом");
    return done();
  }

  let commitIdentity: string | undefined;
  if (raw.commitIdentity !== undefined) {
    if (!isCommitIdentity(raw.commitIdentity)) {
      err(
        "commitIdentity",
        'must be "repo" or a "Name <email>" signature',
      );
    } else {
      commitIdentity = raw.commitIdentity;
    }
  }

  const defaults = parseLayer(raw.defaults ?? {}, "defaults", err);

  const projects: Record<string, ReleaseProjectLayer> = {};
  if (raw.projects !== undefined) {
    if (!isRecord(raw.projects)) {
      err("projects", "must be an object of bb-project overrides");
    } else {
      for (const [id, value] of Object.entries(raw.projects)) {
        if (!isNonEmptyString(id)) {
          err("projects", "project ids must be non-empty strings");
          continue;
        }
        projects[id] = parseLayer(value, `projects.${id}`, err);
      }
    }
  }

  if (errors.length > 0) return done();
  return {
    config: {
      ...(commitIdentity ? { commitIdentity } : {}),
      defaults,
      projects,
    },
    empty: false,
    errors,
  };
}

/**
 * §6: project keys override `defaults` key by key; the project's
 * `commitIdentity` overrides the top-level one. `leaks.machine`/`bbIds`
 * default to the §4 strictness: `block` for public projects, `warn` for
 * private ones. Without a `target` the §6 default is `push` to `main`.
 */
export function resolveProject(
  config: ReleaseConfig,
  projectId: string,
): ResolvedProject {
  const layer = { ...config.defaults, ...(config.projects[projectId] ?? {}) };
  const isPublic = layer.public === true;
  const defaultStrictness: LeakStrictness = isPublic ? "block" : "warn";
  return {
    excluded: layer.excluded === true,
    target: layer.target ?? { action: "push", branch: "main" },
    sync: layer.sync ?? "merge",
    checks: layer.checks ?? [],
    public: isPublic,
    docsMap: layer.docsMap ?? {},
    leaks: {
      machine: layer.leaks?.machine ?? defaultStrictness,
      bbIds: layer.leaks?.bbIds ?? defaultStrictness,
      allow: layer.leaks?.allow ?? [],
    },
    commitIdentity: layer.commitIdentity ?? config.commitIdentity,
    threadIds: layer.threadIds ?? true,
    allowedTrailers: layer.allowedTrailers ?? [],
    allowedEmails: layer.allowedEmails ?? [],
  };
}
