/**
 * Policy loading and validation (spec §2). The policy is JSON in the
 * `policy` plugin setting; an empty or invalid policy puts the plugin in
 * `needs-configuration` and makes `delegate` refuse calls.
 *
 * Structural errors carry a JSON path (`levels.simple.chain[0]`); a missing
 * preset is a warning, not an error — the route is marked unavailable and a
 * level whose whole chain is unavailable refuses delegation at call time.
 */
import { OrchestratorError } from "./errors.js";

export interface PolicyRoute {
  preset: string;
  provider: string;
  quotaGroup?: string;
  quotaPatterns?: string[];
  unavailablePatterns?: string[];
  /** §2 rule 4: per-route first-response window, overrides the global one. */
  firstResponseSeconds?: number;
}

/** §2.3: what a level's delegation does — executes or only checks. */
export type LevelRole = "auditor" | "executor";

export interface PolicyLevel {
  description?: string;
  /** §2.3: `auditor` marks a review level; default `executor`, except a
   * level named `review` which stays `auditor` as before. */
  role?: LevelRole;
  chain: string[];
  autoFallback?: boolean;
}

export interface PolicyLimits {
  maxActive?: number;
  perLevel?: Record<string, number>;
}

export interface Policy {
  version: 1;
  limits?: PolicyLimits;
  firstResponseSeconds?: number;
  maxRunSeconds?: number;
  /** §2.3: executor level → the auditor level that reviews its work. */
  reviewByLevel?: Record<string, string>;
  levels: Record<string, PolicyLevel>;
  routes: Record<string, PolicyRoute>;
}

export interface PolicyIssue {
  path: string;
  message: string;
}

export interface PolicyLoad {
  /** Normalized policy, or null when `errors` is non-empty. */
  policy: Policy | null;
  errors: PolicyIssue[];
  /** Non-fatal findings — e.g. a route naming a preset that does not exist. */
  warnings: PolicyIssue[];
  /** Routes rejected by warnings; delegating to them is refused. */
  unavailableRoutes: string[];
}

export const EMPTY_POLICY_MESSAGE =
  "политика не задана — настройте через навык `orchestrator-setup`";

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isNonEmptyString = (x: unknown): x is string =>
  typeof x === "string" && x.trim().length > 0;

const isPositiveInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= 1;

/**
 * Parse and validate the raw `policy` setting. `knownPresets` is the set of
 * existing preset names and ids from `bb tasks preset list`; when undefined,
 * the preset-existence check (rule 2, warning side) is skipped.
 */
export function parsePolicy(
  text: string | undefined,
  knownPresets?: ReadonlySet<string>,
  /** §16.8: preset name/id → facts; used for the executor-worktree warning. */
  presetDetails?: ReadonlyMap<string, { environmentKind?: string | null }>,
): PolicyLoad {
  const errors: PolicyIssue[] = [];
  const warnings: PolicyIssue[] = [];
  const unavailableRoutes: string[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) =>
    warnings.push({ path, message });
  const done = (): PolicyLoad => ({
    policy: null,
    errors,
    warnings,
    unavailableRoutes,
  });

  if (!text || text.trim() === "") {
    err("policy", EMPTY_POLICY_MESSAGE);
    return done();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    err("$", `невалидный JSON: ${(e as Error).message}`);
    return done();
  }
  if (!isRecord(raw)) {
    err("$", "политика должна быть JSON-объектом");
    return done();
  }

  // Rule 1.
  if (raw.version !== 1) err("version", "version must be 1");

  const routesRaw = isRecord(raw.routes) ? raw.routes : undefined;
  if (!routesRaw) err("routes", "required object of route definitions");

  // Routes.
  const routes: Record<string, PolicyRoute> = {};
  if (routesRaw) {
    for (const [name, value] of Object.entries(routesRaw)) {
      const path = `routes.${name}`;
      if (!isRecord(value)) {
        err(path, "route must be an object");
        continue;
      }
      if (!isNonEmptyString(value.preset)) {
        err(`${path}.preset`, "required non-empty preset name");
      }
      if (!isNonEmptyString(value.provider)) {
        err(`${path}.provider`, "required non-empty provider id");
      }
      if (value.quotaGroup !== undefined && !isNonEmptyString(value.quotaGroup)) {
        err(`${path}.quotaGroup`, "must be a non-empty string");
      }
      // Rules 5 + 6: quota and removed-model pattern lists share the shape.
      const patternsOf = (
        key: "quotaPatterns" | "unavailablePatterns",
      ): string[] | undefined => {
        const raw = value[key];
        if (raw === undefined) return undefined;
        if (!Array.isArray(raw)) {
          err(`${path}.${key}`, "must be an array of non-empty strings");
          return undefined;
        }
        if (raw.length > 20) err(`${path}.${key}`, "at most 20 patterns");
        const bad = raw.findIndex((p) => !isNonEmptyString(p));
        if (bad >= 0) {
          err(`${path}.${key}[${bad}]`, "must be a non-empty string");
          return undefined;
        }
        return raw.map((p) => (p as string).trim());
      };
      const quotaPatterns = patternsOf("quotaPatterns");
      const unavailablePatterns = patternsOf("unavailablePatterns");
      // Rule 4, per route: a cold-start-heavy provider gets its own window.
      let routeFirst: number | undefined;
      if (value.firstResponseSeconds !== undefined) {
        const v = value.firstResponseSeconds;
        if (typeof v !== "number" || v < 30 || v > 600) {
          err(`${path}.firstResponseSeconds`, "must be a number in 30–600");
        } else {
          routeFirst = v;
        }
      }
      if (isNonEmptyString(value.preset) && isNonEmptyString(value.provider)) {
        routes[name] = {
          preset: value.preset,
          provider: value.provider,
          ...(isNonEmptyString(value.quotaGroup)
            ? { quotaGroup: value.quotaGroup }
            : {}),
          ...(quotaPatterns ? { quotaPatterns } : {}),
          ...(unavailablePatterns ? { unavailablePatterns } : {}),
          ...(routeFirst !== undefined
            ? { firstResponseSeconds: routeFirst }
            : {}),
        };
      }
    }
  }

  // Levels + rule 2 (chain references).
  const levels: Record<string, PolicyLevel> = {};
  if (!isRecord(raw.levels)) {
    err("levels", "required object of level definitions");
  } else {
    for (const [name, value] of Object.entries(raw.levels)) {
      const path = `levels.${name}`;
      if (!isRecord(value)) {
        err(path, "level must be an object");
        continue;
      }
      if (value.description !== undefined && typeof value.description !== "string") {
        err(`${path}.description`, "must be a string");
      }
      if (value.autoFallback !== undefined && typeof value.autoFallback !== "boolean") {
        err(`${path}.autoFallback`, "must be a boolean");
      }
      // §2.3: the level's role — `auditor` (review) or `executor`.
      if (
        value.role !== undefined &&
        value.role !== "auditor" &&
        value.role !== "executor"
      ) {
        err(`${path}.role`, `must be "auditor" or "executor"`);
      }
      let chain: string[] = [];
      if (!Array.isArray(value.chain) || value.chain.length === 0) {
        err(`${path}.chain`, "required non-empty array of route names");
      } else {
        const bad = value.chain.findIndex((r) => !isNonEmptyString(r));
        if (bad >= 0) {
          err(`${path}.chain[${bad}]`, "route name must be a non-empty string");
        } else {
          chain = value.chain.map((r) => (r as string).trim());
          chain.forEach((routeName, i) => {
            if (!routesRaw || !(routeName in routesRaw)) {
              err(
                `${path}.chain[${i}]`,
                `route "${routeName}" is not declared in routes`,
              );
            }
          });
        }
      }
      levels[name] = {
        ...(typeof value.description === "string"
          ? { description: value.description }
          : {}),
        ...(value.role === "auditor" || value.role === "executor"
          ? { role: value.role }
          : {}),
        chain,
        ...(typeof value.autoFallback === "boolean"
          ? { autoFallback: value.autoFallback }
          : {}),
      };
    }
  }

  // §2.3: reviewByLevel — executor level → auditor level that reviews it.
  // Every map value must name a declared level with the auditor role.
  let reviewByLevel: Record<string, string> | undefined;
  if (raw.reviewByLevel !== undefined) {
    if (!isRecord(raw.reviewByLevel)) {
      err("reviewByLevel", "must be an object of level → review level");
    } else {
      reviewByLevel = {};
      for (const [execLevel, reviewLevel] of Object.entries(
        raw.reviewByLevel,
      )) {
        // §2.3: the map key is the EXECUTED level — it must name a
        // declared level with the executor role.
        const source = levels[execLevel];
        const sourceRole = source
          ? (source.role ?? (execLevel === "review" ? "auditor" : "executor"))
          : undefined;
        if (!source) {
          err(
            `reviewByLevel.${execLevel}`,
            `level "${execLevel}" is not declared in levels`,
          );
          continue;
        }
        if (sourceRole !== "executor") {
          err(
            `reviewByLevel.${execLevel}`,
            `level "${execLevel}" does not have role "executor"`,
          );
          continue;
        }
        if (!isNonEmptyString(reviewLevel)) {
          err(`reviewByLevel.${execLevel}`, "must be a level name");
          continue;
        }
        const target = levels[reviewLevel];
        if (!target) {
          err(
            `reviewByLevel.${execLevel}`,
            `level "${reviewLevel}" is not declared in levels`,
          );
          continue;
        }
        const targetRole =
          target.role ?? (reviewLevel === "review" ? "auditor" : "executor");
        if (targetRole !== "auditor") {
          err(
            `reviewByLevel.${execLevel}`,
            `level "${reviewLevel}" does not have role "auditor"`,
          );
          continue;
        }
        reviewByLevel[execLevel] = reviewLevel;
      }
    }
  }

  // Rule 3.
  let limits: PolicyLimits | undefined;
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) {
      err("limits", "must be an object");
    } else {
      const l = raw.limits;
      let maxActive: number | undefined;
      if (l.maxActive !== undefined) {
        if (!isPositiveInt(l.maxActive)) {
          err("limits.maxActive", "must be an integer ≥ 1");
        } else {
          maxActive = l.maxActive;
        }
      }
      let perLevel: Record<string, number> | undefined;
      if (l.perLevel !== undefined) {
        if (!isRecord(l.perLevel)) {
          err("limits.perLevel", "must be an object of level → cap");
        } else {
          perLevel = {};
          for (const [levelName, cap] of Object.entries(l.perLevel)) {
            if (!isPositiveInt(cap)) {
              err(`limits.perLevel.${levelName}`, "must be an integer ≥ 1");
              continue;
            }
            if (maxActive !== undefined && cap > maxActive) {
              err(
                `limits.perLevel.${levelName}`,
                `must be ≤ limits.maxActive (${maxActive})`,
              );
              continue;
            }
            perLevel[levelName] = cap;
          }
        }
      }
      limits = { ...(maxActive !== undefined ? { maxActive } : {}), ...(perLevel ? { perLevel } : {}) };
    }
  }

  // Rule 4.
  let firstResponseSeconds: number | undefined;
  if (raw.firstResponseSeconds !== undefined) {
    const v = raw.firstResponseSeconds;
    if (typeof v !== "number" || v < 30 || v > 600) {
      err("firstResponseSeconds", "must be a number in 30–600");
    } else {
      firstResponseSeconds = v;
    }
  }
  let maxRunSeconds: number | undefined;
  if (raw.maxRunSeconds !== undefined) {
    const v = raw.maxRunSeconds;
    if (typeof v !== "number" || v < 300) {
      err("maxRunSeconds", "must be a number ≥ 300");
    } else {
      maxRunSeconds = v;
    }
  }

  // Rule 2, warning side: presets that exist in the installation.
  if (routesRaw && knownPresets) {
    for (const [name, route] of Object.entries(routes)) {
      if (!knownPresets.has(route.preset)) {
        warn(`routes.${name}.preset`, `preset "${route.preset}" not found in bb tasks preset list`);
        unavailableRoutes.push(name);
      }
    }
  }

  // §16.8: an executor-level preset must give the executor its own
  // worktree — a preset that does not create one is a warning.
  if (presetDetails) {
    for (const [levelName, level] of Object.entries(levels)) {
      const role = level.role ?? (levelName === "review" ? "auditor" : "executor");
      if (role !== "executor") continue;
      for (const routeName of level.chain) {
        const route = routes[routeName];
        if (!route) continue;
        const detail = presetDetails.get(route.preset);
        if (detail && detail.environmentKind !== "new-worktree") {
          warn(
            `routes.${routeName}.preset`,
            `preset "${route.preset}" does not create a worktree ` +
              `(environmentKind=${detail.environmentKind ?? "—"}); ` +
              `уровню "${levelName}" исполнителю нужна своя копия`,
          );
        }
      }
    }
  }

  if (errors.length > 0) return done();
  return {
    policy: {
      version: 1,
      ...(limits ? { limits } : {}),
      ...(reviewByLevel ? { reviewByLevel } : {}),
      ...(firstResponseSeconds !== undefined ? { firstResponseSeconds } : {}),
      ...(maxRunSeconds !== undefined ? { maxRunSeconds } : {}),
      levels,
      routes,
    },
    errors,
    warnings,
    unavailableRoutes,
  };
}

/** Quota group a route belongs to: its `quotaGroup`, or itself. */
export function quotaGroupOf(route: PolicyRoute, name: string): string {
  return route.quotaGroup ?? name;
}

/**
 * §2.3: the effective role of a level — its `role` field, or the default:
 * a level named `review` audits (as before r24), every other executes.
 * `release-audit` keeps its own role (§13.1) — callers needing the thread
 * role use `roleForLevel` in roles.ts.
 */
export function levelRole(
  policy: Policy | null | undefined,
  levelName: string,
): LevelRole {
  const role = policy?.levels[levelName]?.role;
  if (role) return role;
  return levelName === "review" ? "auditor" : "executor";
}

/**
 * §2.3 (уточнение PLUG-182): the hold names a burned `preset:<name>`
 * one-off shares — the quota group of every policy route on the same
 * provider AND the same model (preset `modelId` from `bb tasks preset
 * show`/`list`), plus the one-off route's own name so the preset itself
 * is paused for re-dispatch. A route whose preset model is unknown does
 * not join — a one-off never pauses same-provider routes on other models.
 */
export function quotaGroupsForOneOff(
  policy: Policy | null | undefined,
  oneOff: { route: string; provider: string; modelId?: string | null },
  presetModels: ReadonlyMap<string, string | null | undefined>,
): string[] {
  const groups = new Set<string>([oneOff.route]);
  const want = baseModelId(oneOff.modelId);
  if (!policy || !want) return [...groups];
  for (const [name, route] of Object.entries(policy.routes)) {
    if (route.provider !== oneOff.provider) continue;
    if (baseModelId(presetModels.get(route.preset)) !== want) continue;
    groups.add(quotaGroupOf(route, name));
  }
  return [...groups];
}

/** §2.3: model ids compare without the bracketed variant suffix —
 * `claude-opus-5-5[1m]` and `claude-opus-5-5` share one quota. */
function baseModelId(
  modelId: string | null | undefined,
): string | null | undefined {
  return modelId?.replace(/\[[^\]]*\]\s*$/, "");
}

/** §5.3 removed-model text patterns; `routes.*.unavailablePatterns` extends. */
export const BUILTIN_UNAVAILABLE_PATTERNS = [
  "model not found",
  "model_not_found",
  "unknown model",
] as const;

/**
 * First usable route of a level chain: one whose preset exists and whose
 * quota group is not on hold (§2, §4 step 1). `undefined` when the whole
 * chain is unavailable.
 */
export function pickRoute(
  policy: Policy,
  levelName: string,
  opts: {
    requested?: string;
    unavailableRoutes?: ReadonlySet<string>;
    heldGroups?: ReadonlySet<string>;
  } = {},
): { name: string; route: PolicyRoute } {
  const level = policy.levels[levelName];
  if (!level) {
    throw new OrchestratorError(
      "unknown-level",
      `level "${levelName}" is not in the policy`,
      `levels: ${Object.keys(policy.levels).join(", ")}`,
    );
  }
  const unavailable = opts.unavailableRoutes ?? new Set<string>();
  const held = opts.heldGroups ?? new Set<string>();
  const usable = (name: string) => {
    const route = policy.routes[name];
    if (!route) return false;
    // Holds sit on quota groups (§5.2) and on route names (§5.3
    // `unavailable`) — a route is unusable when either is on hold.
    return (
      !unavailable.has(name) &&
      !held.has(name) &&
      !held.has(quotaGroupOf(route, name))
    );
  };
  if (opts.requested !== undefined) {
    const name = opts.requested;
    // §2.3: `--route` names any route of the policy, not only the level's
    // chain — the chain is only the fallback order.
    if (!policy.routes[name]) {
      throw new OrchestratorError(
        "unknown-route",
        `route "${name}" is not declared in routes`,
        `routes: ${Object.keys(policy.routes).join(", ")}`,
      );
    }
    if (!usable(name)) {
      throw new OrchestratorError(
        "route-unavailable",
        `route "${name}" is unavailable (missing preset or route/quota hold)`,
      );
    }
    return { name, route: policy.routes[name]! };
  }
  const name = level.chain.find(usable);
  if (!name) {
    throw new OrchestratorError(
      "route-unavailable",
      `level "${levelName}" has no available route`,
      `chain: ${level.chain.join(" → ")}`,
    );
  }
  return { name, route: policy.routes[name]! };
}
