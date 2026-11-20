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
import { RU } from "./i18n/ru.js";
import { T_RU, type T } from "./i18n/index.js";

/** §20.1 п.5: the queue wait when the route sets no
 * `routeBusyWaitSeconds`. */
export const DEFAULT_ROUTE_BUSY_WAIT_SECONDS = 1200;

export interface PolicyRoute {
  preset: string;
  provider: string;
  quotaGroup?: string;
  quotaPatterns?: string[];
  unavailablePatterns?: string[];
  /** §2 rule 4: per-route first-response window, overrides the global one. */
  firstResponseSeconds?: number;
  /** §16.5: no turn for this long → one coordinator message (default 600). */
  startSeconds?: number;
  /** §16.5: response silence this long → one coordinator message (default 1800). */
  idleSeconds?: number;
  /** §20.1 п.5 (r34.4): parallel dispatches cap for this route; the
   * excess stays `dispatching` in the `queued_at` queue. Counted per
   * quota group. */
  maxActive?: number;
  /** §20.1 п.5: how long a queued dispatch waits for a busy route before
   * the next chain route is tried (default 1200). */
  routeBusyWaitSeconds?: number;
  /** §34.1 (ADR-0037): explicit model name for route matching / reviewer ≠ executor. */
  model?: string;
}

/** §2.3: what a level's delegation does — executes, only checks, or
 * researches (§21). */
export type LevelRole = "auditor" | "executor" | "researcher" | "architect";

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
  /** §17.2 (e2e 8): first-response window for `--preset` one-off routes
   * when no policy route on the same provider carries its own
   * `firstResponseSeconds`, e.g. `{"codex": 300}`. */
  firstResponseSecondsByProvider?: Record<string, number>;
  maxRunSeconds?: number;
  /** §18.5 (PLUG-245): таймауты сторожа/плагина — по ключам. */
  timing?: PolicyTiming;
  /** §2.3: executor level → the auditor level that reviews its work. */
  reviewByLevel?: Record<string, string>;
  /** §28.2 п. 3: per-node timeout, retry limits, and level assignment. */
  node_policy?: PolicyNodePolicy;
  /** §20.3 (r34.4): alias → canonical name dictionaries. A direct
   * config match always wins over an alias lookup; chains resolve to
   * the terminal name; cycles are rejected at validation
   * (`policy-error: alias-cycle`). */
  routeAliases?: Record<string, string>;
  presetAliases?: Record<string, string>;
  quotaGroupAliases?: Record<string, string>;
  levels: Record<string, PolicyLevel>;
  routes: Record<string, PolicyRoute>;
  /** §31 / §34.3: Configuration for checks node. */
  checks?: PolicyChecksConfig;
}

/** §28.2 п. 3: Конфигурация узлов (node_policy): таймаут, попытки, уровень. */
export interface PolicyNodeConfig {
  timeout_seconds?: number;
  max_retries?: number;
  level?: string;
}

export type PolicyNodePolicy = Record<string, PolicyNodeConfig>;

/** §18.5: настраиваемые таймауты сторожа (policy.timing). */
export interface PolicyTiming {
  /** Холд квоты/маршрута после quota/unavailable (default 15). */
  quotaHoldMinutes?: number;
  /** Повторная строка «ждёт решения» не чаще (default 10). */
  approvalRepeatMinutes?: number;
  /** Окно неизвестного результата раздачи (default 5). */
  postDispatchGraceMinutes?: number;
  /** Окно ожидания BB-нотифика о результате (default 120 с). */
  bbNotifyWaitSeconds?: number;
  /** §5.6 (r33.11): порог простоя координатора до напоминания #1
   * (default 5 мин). */
  coordinatorIdleMinutes?: number;
  /** §5.6 (r33.11): напоминаний до эскалации владельцу (default 3). */
  coordinatorMaxNudges?: number;
  /** §5.6 (r33.11): сторож координатора включён (default true). */
  coordinatorWatchdogEnabled?: boolean;
  /** §5.6 (r34.1): предел неактивности координатора — тред без
   * пользовательского хода или продуктивного действия старше этого
   * возраста сторож не будит никогда (default 24 ч). */
  coordinatorMaxThreadAgeHours?: number;
  /** §34.4 (ADR-0037): будильник очереди для задач в queued (default 30 мин). */
  queueStallMinutes?: number;
}

export interface PolicyChecksConfig {
  timeout_seconds?: number;
  allowedEnvVars?: readonly string[];
  extraEnvVars?: string[];
  commands?: string[];
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

/** Compat export — the `ru` catalog value; language-aware callers use
 * `t("pol.empty")`. */
export const EMPTY_POLICY_MESSAGE = RU["pol.empty"]!;

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
  /** §18.1 (PLUG-247a): parse messages come from the language catalog. */
  t: T = T_RU,
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
    err("policy", t("pol.empty"));
    return done();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    err("$", t("pol.badJson", { error: (e as Error).message }));
    return done();
  }
  if (!isRecord(raw)) {
    err("$", t("pol.notObject"));
    return done();
  }

  // Rule 1.
  if (raw.version !== 1) err("version", t("pol.version"));

  const routesRaw = isRecord(raw.routes) ? raw.routes : undefined;
  if (!routesRaw) err("routes", t("pol.routesReq"));

  // Routes.
  const routes: Record<string, PolicyRoute> = {};
  if (routesRaw) {
    for (const [name, value] of Object.entries(routesRaw)) {
      const path = `routes.${name}`;
      if (!isRecord(value)) {
        err(path, t("pol.routeObject"));
        continue;
      }
      if (!isNonEmptyString(value.preset)) {
        err(`${path}.preset`, t("pol.presetReq"));
      }
      if (!isNonEmptyString(value.provider)) {
        err(`${path}.provider`, t("pol.providerReq"));
      }
      if (value.quotaGroup !== undefined && !isNonEmptyString(value.quotaGroup)) {
        err(`${path}.quotaGroup`, t("pol.nonEmptyString"));
      }
      // Rules 5 + 6: quota and removed-model pattern lists share the shape.
      const patternsOf = (
        key: "quotaPatterns" | "unavailablePatterns",
      ): string[] | undefined => {
        const raw = value[key];
        if (raw === undefined) return undefined;
        if (!Array.isArray(raw)) {
          err(`${path}.${key}`, t("pol.stringArray"));
          return undefined;
        }
        if (raw.length > 20) err(`${path}.${key}`, t("pol.maxPatterns"));
        const bad = raw.findIndex((p) => !isNonEmptyString(p));
        if (bad >= 0) {
          err(`${path}.${key}[${bad}]`, t("pol.nonEmptyString"));
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
          err(`${path}.firstResponseSeconds`, t("pol.seconds30600"));
        } else {
          routeFirst = v;
        }
      }
      // §16.5, per route: the stall notices — `startSeconds` (no turn
      // began) and `idleSeconds` (response silence) — one message each.
      let routeStart: number | undefined;
      if (value.startSeconds !== undefined) {
        const v = value.startSeconds;
        if (typeof v !== "number" || v < 30) {
          err(`${path}.startSeconds`, t("pol.numGe30"));
        } else {
          routeStart = v;
        }
      }
      let routeIdle: number | undefined;
      if (value.idleSeconds !== undefined) {
        const v = value.idleSeconds;
        if (typeof v !== "number" || v < 60) {
          err(`${path}.idleSeconds`, t("pol.numGe60"));
        } else {
          routeIdle = v;
        }
      }
      // §20.2 (r34.4): `tools`, `maxPromptBytes`, `splitPackets` are
      // removed fields — a policy carrying them still loads (no
      // breaking change) but registers a deprecation warning; the
      // route itself is always treated as a tools-capable one.
      if (value.tools !== undefined) {
        warn(`${path}.tools`, t("pol.toolsDeprecated"));
      }
      if (value.maxPromptBytes !== undefined || value.splitPackets !== undefined) {
        warn(`${path}.packetFields`, t("pol.packetFieldsDeprecated"));
      }
      const numField = (
        key: "maxActive" | "routeBusyWaitSeconds",
      ): number | undefined => {
        const v = value[key];
        if (v === undefined) return undefined;
        if (!isPositiveInt(v)) {
          err(`${path}.${key}`, t("pol.intGe1"));
          return undefined;
        }
        return v;
      };
      const routeMaxActive = numField("maxActive");
      const routeBusyWait = numField("routeBusyWaitSeconds");
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
          ...(routeStart !== undefined ? { startSeconds: routeStart } : {}),
          ...(routeIdle !== undefined ? { idleSeconds: routeIdle } : {}),
          ...(routeMaxActive !== undefined
            ? { maxActive: routeMaxActive }
            : {}),
          ...(routeBusyWait !== undefined
            ? { routeBusyWaitSeconds: routeBusyWait }
            : {}),
          ...(isNonEmptyString(value.model) ? { model: value.model } : {}),
        };
      }
    }
  }

  // §20.3 (r34.4): the alias dictionaries — `Record<alias, canonical>`,
  // exact case, chains resolve to the terminal name; a cycle is a
  // blocking `policy-error: alias-cycle`. Parsed before the levels:
  // `routeAliases` applies to the chain-reference validation below.
  const aliasesOf = (
    key: "routeAliases" | "presetAliases" | "quotaGroupAliases",
  ): Record<string, string> | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!isRecord(v)) {
      err(key, t("pol.aliasObject"));
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!isNonEmptyString(k) || !isNonEmptyString(val)) {
        err(`${key}.${k || "?"}`, t("pol.aliasString"));
        continue;
      }
      out[k] = val;
    }
    for (const k of Object.keys(out)) {
      const chain = aliasChain(k, out);
      if (chain.cycle) {
        err(`${key}.${k}`, t("pol.aliasCycle", { chain: chain.names.join(" -> ") }));
      }
    }
    return out;
  };
  const routeAliases = aliasesOf("routeAliases");
  const presetAliases = aliasesOf("presetAliases");
  const quotaGroupAliases = aliasesOf("quotaGroupAliases");

  // Levels + rule 2 (chain references).
  const levels: Record<string, PolicyLevel> = {};
  if (!isRecord(raw.levels)) {
    err("levels", t("pol.levelsReq"));
  } else {
    for (const [name, value] of Object.entries(raw.levels)) {
      const path = `levels.${name}`;
      if (!isRecord(value)) {
        err(path, t("pol.levelObject"));
        continue;
      }
      if (value.description !== undefined && typeof value.description !== "string") {
        err(`${path}.description`, t("pol.isString"));
      }
      if (value.autoFallback !== undefined && typeof value.autoFallback !== "boolean") {
        err(`${path}.autoFallback`, t("pol.isBool"));
      }
      // §2.3/§30: the level's role — `auditor` (review), `executor`,
      // `researcher` (§21), or `architect` (§30).
      if (
        value.role !== undefined &&
        value.role !== "auditor" &&
        value.role !== "executor" &&
        value.role !== "researcher" &&
        value.role !== "architect"
      ) {
        err(`${path}.role`, t("pol.roleEnum"));
      }
      let chain: string[] = [];
      if (!Array.isArray(value.chain) || value.chain.length === 0) {
        err(`${path}.chain`, t("pol.chainReq"));
      } else {
        const bad = value.chain.findIndex((r) => !isNonEmptyString(r));
        if (bad >= 0) {
          err(`${path}.chain[${bad}]`, t("pol.routeNameStr"));
        } else {
          chain = value.chain.map((r) => (r as string).trim());
          chain.forEach((routeName, i) => {
            // §20.3 п.3: `routeAliases` applies here too — a chain entry
            // is declared when any hop of its alias chain names a route.
            const declared = routeNameChain(routeName, routeAliases).some(
              (n) => routesRaw !== undefined && n in routesRaw,
            );
            if (!declared) {
              err(
                `${path}.chain[${i}]`, t("pol.routeUndeclared", { route: routeName }));
            }
          });
        }
      }
      levels[name] = {
        ...(typeof value.description === "string"
          ? { description: value.description }
          : {}),
        ...(value.role === "auditor" ||
        value.role === "executor" ||
        value.role === "researcher" ||
        value.role === "architect"
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
      err("reviewByLevel", t("pol.reviewByLevelObject"));
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
            `reviewByLevel.${execLevel}`, t("pol.levelUndeclared", { level: execLevel }));
          continue;
        }
        if (sourceRole !== "executor") {
          err(
            `reviewByLevel.${execLevel}`, t("pol.levelNotExecutor", { level: execLevel }));
          continue;
        }
        if (!isNonEmptyString(reviewLevel)) {
          err(`reviewByLevel.${execLevel}`, t("pol.levelName"));
          continue;
        }
        const target = levels[reviewLevel];
        if (!target) {
          err(
            `reviewByLevel.${execLevel}`, t("pol.levelUndeclared", { level: reviewLevel }));
          continue;
        }
        const targetRole =
          target.role ?? (reviewLevel === "review" ? "auditor" : "executor");
        if (targetRole !== "auditor") {
          err(
            `reviewByLevel.${execLevel}`, t("pol.levelNotAuditor", { level: reviewLevel }));
          continue;
        }
        reviewByLevel[execLevel] = reviewLevel;
      }
    }
  }

  // §28.2 п. 3: node_policy — конфигурация узлов (timeout_seconds, max_retries, level).
  let node_policy: PolicyNodePolicy | undefined;
  if (raw.node_policy !== undefined) {
    if (!isRecord(raw.node_policy)) {
      err("node_policy", t("pol.isObject"));
    } else {
      node_policy = {};
      for (const [nodeName, nodeCfg] of Object.entries(raw.node_policy)) {
        const path = `node_policy.${nodeName}`;
        if (!isRecord(nodeCfg)) {
          err(path, t("pol.isObject"));
          continue;
        }
        let timeout_seconds: number | undefined;
        if (nodeCfg.timeout_seconds !== undefined) {
          if (!isPositiveInt(nodeCfg.timeout_seconds)) {
            err(`${path}.timeout_seconds`, t("pol.intGe1"));
          } else {
            timeout_seconds = nodeCfg.timeout_seconds;
          }
        }
        let max_retries: number | undefined;
        if (nodeCfg.max_retries !== undefined) {
          if (
            typeof nodeCfg.max_retries !== "number" ||
            !Number.isInteger(nodeCfg.max_retries) ||
            nodeCfg.max_retries < 0
          ) {
            err(`${path}.max_retries`, t("pol.intGe0"));
          } else {
            max_retries = nodeCfg.max_retries;
          }
        }
        let level: string | undefined;
        if (nodeCfg.level !== undefined) {
          if (!isNonEmptyString(nodeCfg.level)) {
            err(`${path}.level`, t("pol.isString"));
          } else if (!levels[nodeCfg.level]) {
            err(
              `${path}.level`,
              t("pol.levelUndeclared", { level: nodeCfg.level }),
            );
          } else {
            level = nodeCfg.level;
          }
        }
        node_policy[nodeName] = {
          ...(timeout_seconds !== undefined ? { timeout_seconds } : {}),
          ...(max_retries !== undefined ? { max_retries } : {}),
          ...(level !== undefined ? { level } : {}),
        };
      }
    }
  }

  // Rule 3.
  let limits: PolicyLimits | undefined;
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) {
      err("limits", t("pol.isObject"));
    } else {
      const l = raw.limits;
      let maxActive: number | undefined;
      if (l.maxActive !== undefined) {
        if (!isPositiveInt(l.maxActive)) {
          err("limits.maxActive", t("pol.intGe1"));
        } else {
          maxActive = l.maxActive;
        }
      }
      let perLevel: Record<string, number> | undefined;
      if (l.perLevel !== undefined) {
        if (!isRecord(l.perLevel)) {
          err("limits.perLevel", t("pol.perLevelObject"));
        } else {
          perLevel = {};
          for (const [levelName, cap] of Object.entries(l.perLevel)) {
            if (!isPositiveInt(cap)) {
              err(`limits.perLevel.${levelName}`, t("pol.intGe1"));
              continue;
            }
            if (maxActive !== undefined && cap > maxActive) {
              err(
                `limits.perLevel.${levelName}`, t("pol.capOverMax", { max: maxActive }));
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
      err("firstResponseSeconds", t("pol.seconds30600"));
    } else {
      firstResponseSeconds = v;
    }
  }
  // §17.2 (e2e 8): per-provider first-response windows for one-off
  // preset dispatches — same 30–600 bounds as the route/global fields.
  let firstResponseSecondsByProvider: Record<string, number> | undefined;
  if (raw.firstResponseSecondsByProvider !== undefined) {
    if (!isRecord(raw.firstResponseSecondsByProvider)) {
      err(
        "firstResponseSecondsByProvider", t("pol.byProviderObject"));
    } else {
      firstResponseSecondsByProvider = {};
      for (const [providerId, v] of Object.entries(
        raw.firstResponseSecondsByProvider,
      )) {
        if (typeof v !== "number" || v < 30 || v > 600) {
          err(
            `firstResponseSecondsByProvider.${providerId}`, t("pol.seconds30600"));
          continue;
        }
        firstResponseSecondsByProvider[providerId] = v;
      }
    }
  }
  /* §18.5: policy.timing — вне пределов предупреждение и дефолт. */
  const timing: PolicyTiming = {};
  if (raw.timing !== undefined) {
    if (!isRecord(raw.timing)) {
      warn("timing", t("pol.timingObjectIgnored"));
    } else {
      const bounds: Partial<
        Record<keyof PolicyTiming, [number, number]>
      > = {
        quotaHoldMinutes: [1, 1440],
        approvalRepeatMinutes: [1, 1440],
        postDispatchGraceMinutes: [1, 1440],
        bbNotifyWaitSeconds: [5, 3600],
        coordinatorIdleMinutes: [1, 1440],
        coordinatorMaxNudges: [1, 100],
        coordinatorMaxThreadAgeHours: [1, 720],
        queueStallMinutes: [1, 1440],
      };
      for (const [key, [min, max]] of Object.entries(bounds) as [
        keyof PolicyTiming,
        [number, number],
      ][]) {
        const v = raw.timing[key];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
          warn(`timing.${key}`, t("pol.outOfBoundsDefault", { min: min, max: max }));
        } else {
          (timing as Record<string, unknown>)[key] = v;
        }
      }
      const enabled = raw.timing.coordinatorWatchdogEnabled;
      if (enabled !== undefined) {
        if (typeof enabled === "boolean") {
          timing.coordinatorWatchdogEnabled = enabled;
        } else {
          warn("timing.coordinatorWatchdogEnabled", t("pol.isBool"));
        }
      }
    }
  }

  let checks: PolicyChecksConfig | undefined;
  if (raw.checks !== undefined) {
    if (!isRecord(raw.checks)) {
      warn("checks", "checks configuration must be an object");
    } else {
      checks = {};
      if (raw.checks.timeout_seconds !== undefined) {
        const v = raw.checks.timeout_seconds;
        if (typeof v !== "number" || v < 30 || v > 3600) {
          warn("checks.timeout_seconds", "timeout_seconds must be between 30 and 3600");
        } else {
          checks.timeout_seconds = v;
        }
      }
      if (raw.checks.allowedEnvVars !== undefined) {
        if (
          Array.isArray(raw.checks.allowedEnvVars) &&
          raw.checks.allowedEnvVars.every((s: unknown) => typeof s === "string")
        ) {
          const bad = (raw.checks.allowedEnvVars as string[]).find((s) =>
            /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(s),
          );
          if (bad) {
            warn("checks.allowedEnvVars", `allowedEnvVars contains forbidden secret keyword: "${bad}"`);
          } else {
            checks.allowedEnvVars = raw.checks.allowedEnvVars;
          }
        } else {
          warn("checks.allowedEnvVars", "allowedEnvVars must be an array of strings");
        }
      }
      if (raw.checks.extraEnvVars !== undefined) {
        if (
          Array.isArray(raw.checks.extraEnvVars) &&
          raw.checks.extraEnvVars.every((s: unknown) => typeof s === "string")
        ) {
          const bad = (raw.checks.extraEnvVars as string[]).find((s) =>
            /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(s),
          );
          if (bad) {
            warn("checks.extraEnvVars", `extraEnvVars contains forbidden secret keyword: "${bad}"`);
          } else {
            checks.extraEnvVars = raw.checks.extraEnvVars;
          }
        } else {
          warn("checks.extraEnvVars", "extraEnvVars must be an array of strings");
        }
      }
      if (raw.checks.commands !== undefined) {
        if (
          Array.isArray(raw.checks.commands) &&
          raw.checks.commands.every((s: unknown) => typeof s === "string")
        ) {
          checks.commands = raw.checks.commands;
        } else {
          warn("checks.commands", "commands must be an array of strings");
        }
      }
    }
  }

  let maxRunSeconds: number | undefined;
  if (raw.maxRunSeconds !== undefined) {
    const v = raw.maxRunSeconds;
    if (typeof v !== "number" || v < 300) {
      err("maxRunSeconds", t("pol.numGe300"));
    } else {
      maxRunSeconds = v;
    }
  }

  // Rule 2, warning side: presets that exist in the installation.
  if (routesRaw && knownPresets) {
    for (const [name, route] of Object.entries(routes)) {
      if (!knownPresets.has(route.preset)) {
        warn(`routes.${name}.preset`, t("pol.presetNotFound", { preset: route.preset }));
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
        const resolvedName = routeNameChain(routeName, routeAliases).find(
          (n) => routes[n] !== undefined,
        );
        if (resolvedName === undefined) continue;
        const route = routes[resolvedName]!;
        const detail = presetDetails.get(route.preset);
        if (detail && detail.environmentKind !== "new-worktree") {
          warn(
            `routes.${resolvedName}.preset`, t("pol.presetNoWorktree", { preset: route.preset, kind: detail.environmentKind ?? "—", level: levelName }));
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
      ...(firstResponseSecondsByProvider !== undefined
        ? { firstResponseSecondsByProvider }
        : {}),
      ...(maxRunSeconds !== undefined ? { maxRunSeconds } : {}),
      ...(Object.keys(timing).length > 0 ? { timing } : {}),
      ...(node_policy && Object.keys(node_policy).length > 0
        ? { node_policy }
        : {}),
      ...(routeAliases && Object.keys(routeAliases).length > 0
        ? { routeAliases }
        : {}),
      ...(presetAliases && Object.keys(presetAliases).length > 0
        ? { presetAliases }
        : {}),
      ...(quotaGroupAliases && Object.keys(quotaGroupAliases).length > 0
        ? { quotaGroupAliases }
        : {}),
      ...(checks && Object.keys(checks).length > 0 ? { checks } : {}),
      levels,
      routes,
    },
    errors,
    warnings,
    unavailableRoutes,
  };
}

/* ── §20.3 (r34.4): generic alias machinery — the policy carries the
 * dictionaries (`routeAliases`/`presetAliases`/`quotaGroupAliases`);
 * no provider names are hardcoded. */

/**
 * Walk the alias chain from `name`: returns every hop in order
 * (`name`, `aliases[name]`, …). `cycle` marks a walk that re-entered a
 * name — validation rejects those with `alias-cycle`; at runtime the
 * walk just stops at the repeat.
 */
function aliasChain(
  name: string,
  aliases: Record<string, string> | undefined,
): { names: string[]; cycle: boolean } {
  const names = [name];
  const seen = new Set(names);
  let cur = name;
  while (aliases && aliases[cur] !== undefined) {
    cur = aliases[cur]!;
    if (seen.has(cur)) return { names: [...names, cur], cycle: true };
    seen.add(cur);
    names.push(cur);
  }
  return { names, cycle: false };
}

/** §20.3: every name in `name`'s alias chain, itself first. */
export function routeNameChain(
  name: string,
  aliases: Record<string, string> | undefined,
): string[] {
  return aliasChain(name, aliases).names;
}

/** Canonical preset name: the terminal of the `presetAliases` chain. */
export function canonicalPresetName(
  name: string | undefined,
  policy?: Policy | null,
): string {
  if (!name) return "";
  const chain = aliasChain(name, policy?.presetAliases).names;
  return chain[chain.length - 1]!;
}

/** Canonical route name: the terminal of the `routeAliases` chain. */
export function canonicalRouteName(
  name: string | undefined,
  policy?: Policy | null,
): string {
  if (!name) return "";
  const chain = aliasChain(name, policy?.routeAliases).names;
  return chain[chain.length - 1]!;
}

/** Canonical quota group: `quotaGroupAliases` first, then
 * `presetAliases` inside a `preset:` group. */
export function canonicalQuotaGroup(
  g: string,
  policy?: Policy | null,
): string {
  const chain = aliasChain(g, policy?.quotaGroupAliases).names;
  const resolved = chain[chain.length - 1]!;
  if (resolved.startsWith("preset:")) {
    const p = resolved.slice("preset:".length);
    return `preset:${canonicalPresetName(p, policy)}`;
  }
  return resolved;
}

/** §20.3: two preset names are the same preset when their canonical
 * forms match (or they are literally equal). */
export function samePreset(
  policy: Policy | null | undefined,
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return canonicalPresetName(a, policy) === canonicalPresetName(b, policy);
}

/** Resolves a route from a policy or routes map by direct name or
 * alias chain (the direct match wins — §20.3 п.3). */
export function findRoute(
  policyOrRoutes: Policy | Record<string, PolicyRoute> | null | undefined,
  name: string | undefined,
): PolicyRoute | undefined {
  if (!policyOrRoutes || !name) return undefined;
  const isPolicy =
    "version" in policyOrRoutes && policyOrRoutes.version === 1;
  const routes: Record<string, PolicyRoute> = isPolicy
    ? (policyOrRoutes as Policy).routes
    : (policyOrRoutes as Record<string, PolicyRoute>);
  const aliases = isPolicy
    ? (policyOrRoutes as Policy).routeAliases
    : undefined;
  for (const n of routeNameChain(name, aliases)) {
    if (routes[n]) return routes[n];
  }
  return undefined;
}

/**
 * Resolves a route by name from policy.routes — a direct match first,
 * then each `routeAliases` hop. Returns the resolved route name and
 * route object.
 */
export function resolvePolicyRoute(
  policy: Policy | null | undefined,
  name: string | undefined,
): { name: string; route: PolicyRoute } | undefined {
  if (!policy || !name) return undefined;
  for (const n of routeNameChain(name, policy.routeAliases)) {
    if (policy.routes[n]) {
      return { name: n, route: policy.routes[n] };
    }
  }
  return undefined;
}

/** Quota group a route belongs to: its `quotaGroup`, or itself —
 * canonicalized through the policy's alias dictionaries. */
export function quotaGroupOf(
  route: PolicyRoute,
  name: string,
  policy?: Policy | null,
): string {
  return canonicalQuotaGroup(
    route.quotaGroup ?? canonicalRouteName(name, policy),
    policy,
  );
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
  if (levelName === "review") return "auditor";
  if (levelName === "research") return "researcher";
  if (levelName === "architect") return "architect";
  return "executor";
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
  const canon = canonicalQuotaGroup(oneOff.route, policy);
  const groups = new Set<string>([canon, oneOff.route]);
  // A route_holds row may carry ANY spelling of the group — every name
  // (alias or canonical) that canonicalizes to `canon` joins the set.
  const aliases = policy?.quotaGroupAliases;
  if (aliases) {
    for (const name of [...Object.keys(aliases), ...Object.values(aliases)]) {
      if (canonicalQuotaGroup(name, policy) === canon) groups.add(name);
    }
  }
  if (canon.startsWith("preset:")) {
    const p = canon.slice("preset:".length);
    const pAliases = policy?.presetAliases;
    const names = new Set([p]);
    if (pAliases) {
      for (const name of [
        ...Object.keys(pAliases),
        ...Object.values(pAliases),
      ]) {
        if (canonicalPresetName(name, policy) === p) names.add(name);
      }
    }
    for (const n of names) groups.add(`preset:${n}`);
  }
  const want = baseModelId(oneOff.modelId);
  if (!policy || !want) return [...groups];
  for (const [name, route] of Object.entries(policy.routes)) {
    if (route.provider !== oneOff.provider) continue;
    if (baseModelId(presetModels.get(route.preset)) !== want) continue;
    groups.add(quotaGroupOf(route, name, policy));
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
    skipSameModelAsExecutor?: boolean;
    lastExecutorRoute?: string;
    lastExecutorProvider?: string;
    lastExecutorModel?: string;
  } = {},
): { name: string; route: PolicyRoute; warning?: string } {
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
  const canonHeld = new Set(
    [...held].map((h) => canonicalQuotaGroup(h, policy)),
  );
  const usable = (name: string) => {
    const resolved = resolvePolicyRoute(policy, name);
    const route = resolved?.route;
    if (!route) return false;
    const names = new Set([
      ...routeNameChain(name, policy.routeAliases),
      resolved.name,
    ]);
    const qg = quotaGroupOf(route, resolved.name, policy);
    // Holds sit on quota groups (§5.2) and on route names (§5.3
    // `unavailable`) — a route is unusable when either is on hold.
    return (
      ![...names].some((n) => unavailable.has(n)) &&
      ![...names].some((n) => held.has(n)) &&
      !held.has(qg) &&
      !canonHeld.has(qg)
    );
  };

  const matchesExecutor = (name: string): boolean => {
    const resolved = resolvePolicyRoute(policy, name);
    const r = resolved?.route;
    if (!r) return false;
    if (
      opts.lastExecutorProvider &&
      r.provider &&
      r.provider === opts.lastExecutorProvider
    ) {
      return true;
    }
    if (
      opts.lastExecutorModel &&
      r.model &&
      r.model === opts.lastExecutorModel
    ) {
      return true;
    }
    if (opts.lastExecutorRoute) {
      const names = new Set([
        ...routeNameChain(name, policy.routeAliases),
        resolved.name,
      ]);
      if (names.has(opts.lastExecutorRoute)) return true;
    }
    return false;
  };

  if (opts.requested !== undefined) {
    const resolved = resolvePolicyRoute(policy, opts.requested);
    // §2.3: `--route` names any route of the policy, not only the level's
    // chain — the chain is only the fallback order.
    if (!resolved) {
      throw new OrchestratorError(
        "unknown-route",
        `route "${opts.requested}" is not declared in routes`,
        `routes: ${Object.keys(policy.routes).join(", ")}`,
      );
    }
    if (!usable(resolved.name) && !usable(opts.requested)) {
      throw new OrchestratorError(
        "route-unavailable",
        `route "${opts.requested}" is unavailable (missing preset or route/quota hold)`,
      );
    }
    let warning: string | undefined;
    if (opts.skipSameModelAsExecutor && matchesExecutor(resolved.name)) {
      const provider =
        opts.lastExecutorProvider ?? resolved.route.provider ?? "same";
      warning = `warning: reviewer-same-model: ревьюер и исполнитель используют одного провайдера/модель (${provider}); рекомендуется добавить альтернативный маршрут в цепочку уровня`;
    }
    return { ...resolved, ...(warning ? { warning } : {}) };
  }

  let name: string | undefined;
  let reviewerSameModelWarning: string | undefined;

  if (opts.skipSameModelAsExecutor) {
    name = level.chain.find((n) => usable(n) && !matchesExecutor(n));
    if (!name) {
      name = level.chain.find(usable);
      if (name) {
        const resolvedFallback = resolvePolicyRoute(policy, name);
        const provider =
          opts.lastExecutorProvider ??
          resolvedFallback?.route.provider ??
          "same";
        reviewerSameModelWarning = `warning: reviewer-same-model: ревьюер и исполнитель используют одного провайдера/модель (${provider}); рекомендуется добавить альтернативный маршрут в цепочку уровня`;
      }
    }
  } else {
    name = level.chain.find(usable);
  }

  if (!name) {
    throw new OrchestratorError(
      "route-unavailable",
      `level "${levelName}" has no available route`,
      `chain: ${level.chain.join(" → ")}`,
    );
  }
  const resolved = resolvePolicyRoute(policy, name);
  if (!resolved) {
    throw new OrchestratorError(
      "unknown-route",
      `route "${name}" in chain is not declared in routes`,
      `routes: ${Object.keys(policy.routes).join(", ")}`,
    );
  }
  return {
    ...resolved,
    ...(reviewerSameModelWarning ? { warning: reviewerSameModelWarning } : {}),
  };
}

/**
 * §28.2 п. 3: Таймаут узла в секундах из node_policy, по умолчанию 3600 с.
 */
export function getNodeTimeoutSeconds(
  policy: Policy | null | undefined,
  node: string,
): number {
  const timeout = policy?.node_policy?.[node]?.timeout_seconds;
  return typeof timeout === "number" && timeout > 0 ? timeout : 3600;
}

/**
 * §28.2 п. 3: Лимит попыток узла из node_policy, по умолчанию 3.
 */
export function getNodeMaxRetries(
  policy: Policy | null | undefined,
  node: string,
): number {
  const retries = policy?.node_policy?.[node]?.max_retries;
  return typeof retries === "number" && retries >= 0 ? retries : 3;
}

