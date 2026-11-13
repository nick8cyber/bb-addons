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
import { parseAllowedTrailer } from "./scan.js";
import { T_RU, type T } from "./i18n/index.js";

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
  /** §4 r11/§18.6: category-2 commit trailers (Co-Authored-By, ботские
   * подписи). Default `warn`; the author's install sets `"block"`. */
  trailers?: LeakStrictness;
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
  /** §6 r11 (PLUG-245): послевыкладочные шаги — обновление копии,
   * произвольные команды через общий запускатель, перезагрузка плагинов. */
  postPublish?: PostPublishLayer;
  /** orchestrator §18.5: таймауты конвейера — по ключам поверх
   * `timing` верхнего слоя. */
  timing?: ReleaseTiming;
  /** §18.3/§2 п.6: провайдер PR (create/view/find, github по умолчанию). */
  prProvider?: PrProviderLayer;
  /** §18.6: шаблон тела PR — подстановки {thread}, {task}, {title}. */
  prBody?: string;
  /** §18.6: обязательная заметка — без --kb/--no-kb шаг 1 отказывает. */
  requireNote?: boolean;
}

export type PostPublishOn = "published" | "merged";

/** §6 r11: одна postPublish-команда (§18.2 — через общий запускатель;
 * в настройке поле `run`, здесь — уже разрешённый argv). */
export interface PostPublishCommandLayer {
  name: string;
  argv: string[];
  /** Абсолютный путь, слово `checkout` — каталог копии, или
   * относительный путь (от каталога репозитория);
   * без значения — checkout, если настроен, иначе каталог репозитория. */
  cwd?: string;
  timeoutSec?: number;
  /** glob-патчи (ANY) против изменённых путей выкладки. */
  when?: string[];
  stopOnFail?: boolean;
  /** Команда сама ставит зависимости — снимает «переустанови вручную». */
  installsDeps?: boolean;
}

export interface PostPublishLayer {
  checkout?: string;
  branch?: string;
  reloadPlugins?: boolean;
  /** Триггер: `published` — после публикации; `merged` — после merge
   * PR (push трактует как published). Без явного — по target. */
  on?: PostPublishOn;
  commands?: PostPublishCommandLayer[];
}

/** orchestrator §18.5: ключи таймаутов конвейера выкладки. */
export interface ReleaseTiming {
  auditTimeoutMinutes?: number;
  checksMinutes?: number;
  prepareMinutes?: number;
  prPollMinutes?: number;
  prStaleHours?: number;
  prReopenWatchHours?: number;
  prErrorLimit?: number;
  prCommandTimeoutSec?: number;
  commandTimeoutSec?: number;
  /** §18.5: общий срок ОЖИДАНИЯ шагов postPublish (замок копии,
   * очередь команд, удержание перезагрузки). */
  postPublishWaitMinutes?: number;
}

export type ResolvedTiming = Required<ReleaseTiming>;

/** §18.5: дефолты таймаутов — бывшие константы конвейера. */
export const DEFAULT_TIMING: ResolvedTiming = {
  auditTimeoutMinutes: 30,
  checksMinutes: 10,
  prepareMinutes: 20,
  prPollMinutes: 5,
  prStaleHours: 72,
  prReopenWatchHours: 72,
  prErrorLimit: 3,
  prCommandTimeoutSec: 60,
  commandTimeoutSec: 300,
  postPublishWaitMinutes: 30,
};

export type PrProviderType = "github" | "command" | "none";

export interface PrProviderLayer {
  type: PrProviderType;
  /** Сырой объект — снимок доверия хеширует command целиком. */
  raw: unknown;
  /** §18.3 command: argv создания PR (env + тело в stdin, печатает URL). */
  create?: string[];
  /** §18.3 command: argv состояния PR (ORCH_PR_URL → JSON). */
  view?: string[];
  /** §18.3 command (необяз.): argv поиска открытого PR ветки. */
  find?: string[];
}

/** §18.6: тело PR по умолчанию — маркеры, которые разбор «чей PR»
 * узнаёт (§18.3). Установка автора задаёт прежний шаблон явно. */
export const DEFAULT_PR_BODY = "BB-Thread: {thread}\n\nBB-Task: {task}";

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
  /** §18.5/§6 r11: мягкие замечания — конфиг грузится, поле заменено
   * дефолтом или трактуется иначе. */
  warnings: PolicyIssue[];
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
    trailers: LeakStrictness;
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
  /** §6 r11: послевыкладочные шаги (`branch` уже с подставленной
   * целевой; `checkout` может отсутствовать — тогда только команды). */
  postPublish: {
    checkout?: string;
    branch: string;
    reloadPlugins: boolean;
    on: PostPublishOn;
    commands: ResolvedPostPublishCommand[];
  } | null;
  /** §18.5: эффективные таймауты (defaults ← проект, по ключам). */
  timing: ResolvedTiming;
  /** §2 п.6 r11/§18.3: PR-провайдер (`github` по умолчанию); у
   * `command` — разобранные argv create/view/find. */
  prProvider: PrProviderLayer;
  /** §18.6: шаблон тела PR (по умолчанию DEFAULT_PR_BODY; при
   * `threadIds: false` не применяется — тело пустое). */
  prBody: string;
  /** §18.6: обязательная заметка --kb/--no-kb на шаге 1 (default false). */
  requireNote: boolean;
}

export interface ResolvedPostPublishCommand {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutSec?: number;
  when?: string[];
  stopOnFail: boolean;
  installsDeps: boolean;
  /** `cwd: "checkout"` при отсутствующем checkout — пропуск
   * «нет checkout» (§6 r11). */
  noCheckout: boolean;
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
  t: T,
): ReleaseTarget | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    err(path, t("rc.targetObject"));
    return undefined;
  }
  let action: ReleaseAction | undefined;
  if (value.action !== "push" && value.action !== "pr") {
    err(`${path}.action`, t("rc.actionEnum"));
  } else {
    action = value.action;
  }
  let branch: string | undefined;
  if (!isNonEmptyString(value.branch)) {
    err(`${path}.branch`, t("rc.branchReq"));
  } else {
    branch = value.branch.trim();
  }
  return action && branch ? { action, branch } : undefined;
}

function parseLayer(
  value: unknown,
  path: string,
  err: (p: string, m: string) => void,
  warn: (p: string, m: string) => void,
  t: T,
): ReleaseProjectLayer {
  const layer: ReleaseProjectLayer = {};
  if (!isRecord(value)) {
    err(path, t("rc.isObject"));
    return layer;
  }
  const target = parseTarget(value.target, `${path}.target`, err, t);
  if (target) layer.target = target;
  if (value.sync !== undefined) {
    if (value.sync === "merge" || value.sync === "rebase") {
      layer.sync = value.sync;
    } else {
      err(`${path}.sync`, t("rc.syncEnum"));
    }
  }
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks)) {
      err(`${path}.checks`, t("rc.checksArray"));
    } else {
      const bad = value.checks.findIndex((c) => !isNonEmptyString(c));
      if (bad >= 0) {
        err(`${path}.checks[${bad}]`, t("rc.commandNonEmpty"));
      } else {
        layer.checks = value.checks.map((c) => (c as string).trim());
      }
    }
  }
  if (value.public !== undefined) {
    if (typeof value.public !== "boolean") {
      err(`${path}.public`, t("rc.isBool"));
    } else {
      layer.public = value.public;
    }
  }
  if (value.docsMap !== undefined) {
    if (!isRecord(value.docsMap)) {
      err(`${path}.docsMap`, t("rc.docsMapObject"));
    } else {
      const docsMap: Record<string, string[]> = {};
      for (const [prefix, docs] of Object.entries(value.docsMap)) {
        if (!isNonEmptyString(prefix)) {
          err(`${path}.docsMap`, t("rc.docsMapPrefixes"));
          continue;
        }
        if (
          !Array.isArray(docs) ||
          docs.some((d) => !isNonEmptyString(d))
        ) {
          err(
            `${path}.docsMap.${prefix}`, t("rc.docsArray"));
          continue;
        }
        docsMap[prefix] = docs.map((d) => (d as string).trim());
      }
      layer.docsMap = docsMap;
    }
  }
  if (value.leaks !== undefined) {
    if (!isRecord(value.leaks)) {
      err(`${path}.leaks`, t("rc.leaksObject"));
    } else {
      const leaks: ReleaseLeaks = {};
      for (const key of ["machine", "bbIds", "trailers"] as const) {
        const v = value.leaks[key];
        if (v === undefined) continue;
        if (v === "block" || v === "warn") {
          leaks[key] = v;
        } else {
          err(`${path}.leaks.${key}`, t("rc.leaksEnum"));
        }
      }
      if (value.leaks.allow !== undefined) {
        if (
          !Array.isArray(value.leaks.allow) ||
          value.leaks.allow.some((a) => !isNonEmptyString(a))
        ) {
          err(`${path}.leaks.allow`, t("rc.pathsArray"));
        } else {
          leaks.allow = value.leaks.allow.map((a) => (a as string).trim());
        }
      }
      layer.leaks = leaks;
    }
  }
  if (value.excluded !== undefined) {
    if (typeof value.excluded !== "boolean") {
      err(`${path}.excluded`, t("rc.isBool"));
    } else {
      layer.excluded = value.excluded;
    }
  }
  if (value.commitIdentity !== undefined) {
    if (!isCommitIdentity(value.commitIdentity)) {
      err(
        `${path}.commitIdentity`, t("rc.commitIdentity"));
    } else {
      layer.commitIdentity = value.commitIdentity;
    }
  }
  if (value.threadIds !== undefined) {
    if (typeof value.threadIds !== "boolean") {
      err(`${path}.threadIds`, t("rc.isBool"));
    } else {
      layer.threadIds = value.threadIds;
    }
  }
  for (const key of ["allowedTrailers", "allowedEmails"] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((a) => !isNonEmptyString(a))) {
      err(`${path}.${key}`, t("rc.stringArray"));
    } else {
      layer[key] = v.map((a) => (a as string).trim());
    }
  }
  // §17.3 (С6, PLUG-224): an `allowedTrailers` element is a known
  // trailer name, optionally with a ": <value prefix>" — anything else
  // (a typo'd name, an empty prefix) is a config error, not dead config.
  if (layer.allowedTrailers) {
    const bad = layer.allowedTrailers.findIndex(
      (a) => parseAllowedTrailer(a) === null,
    );
    if (bad >= 0) {
      err(
        `${path}.allowedTrailers[${bad}]`, t("rc.trailerName"));
    }
  }
  if (value.postPublish !== undefined) {
    layer.postPublish = parsePostPublish(
      value.postPublish,
      `${path}.postPublish`,
      err,
      warn,
      t,
    );
  }
  if (value.timing !== undefined) {
    const timing = parseTiming(value.timing, `${path}.timing`, err, warn, t);
    if (timing) layer.timing = timing;
  }
  if (value.prProvider !== undefined) {
    const prov = value.prProvider;
    const pp = `${path}.prProvider`;
    if (
      !isRecord(prov) ||
      (prov.type !== "github" && prov.type !== "command" && prov.type !== "none")
    ) {
      err(pp, t("rc.providerType"));
    } else {
      const layer_: PrProviderLayer = { type: prov.type, raw: prov };
      // §18.3: argv-поля — только у command; у github/none лишние
      // ключи — мягкое замечание (игнорируются), не ошибка.
      const argv = (key: "create" | "view" | "find"): string[] | undefined => {
        const v = prov[key];
        if (v === undefined) return undefined;
        if (
          !Array.isArray(v) ||
          v.length === 0 ||
          v.some((a) => !isNonEmptyString(a))
        ) {
          err(`${pp}.${key}`, t("rc.argvArray"));
          return undefined;
        }
        return v.map((a) => (a as string).trim());
      };
      if (prov.type === "command") {
        for (const key of ["create", "view"] as const) {
          const a = argv(key);
          if (a) layer_[key] = a;
          else if (prov[key] === undefined) {
            err(`${pp}.${key}`, t("rc.requiredForCommand"));
          }
        }
        const f = argv("find");
        if (f) layer_.find = f;
      } else {
        for (const key of ["create", "view", "find"] as const) {
          if (prov[key] !== undefined) {
            warn(`${pp}.${key}`, t("rc.ignoredForType", { type: prov.type }));
          }
        }
      }
      layer.prProvider = layer_;
    }
  }
  if (value.prBody !== undefined) {
    if (typeof value.prBody !== "string") {
      err(`${path}.prBody`, t("rc.templateString"));
    } else {
      layer.prBody = value.prBody;
    }
  }
  if (value.requireNote !== undefined) {
    if (typeof value.requireNote !== "boolean") {
      err(`${path}.requireNote`, t("rc.isBool"));
    } else {
      layer.requireNote = value.requireNote;
    }
  }
  return layer;
}

/** §18.5: пределы значений таймаутов по единицам. */
const TIMING_BOUNDS: Record<
  keyof ReleaseTiming,
  { min: number; max: number; unit: string }
> = {
  auditTimeoutMinutes: { min: 1, max: 1440, unit: "min" },
  checksMinutes: { min: 1, max: 1440, unit: "min" },
  prepareMinutes: { min: 1, max: 1440, unit: "min" },
  prPollMinutes: { min: 1, max: 1440, unit: "min" },
  prStaleHours: { min: 1, max: 720, unit: "h" },
  prReopenWatchHours: { min: 1, max: 720, unit: "h" },
  prErrorLimit: { min: 1, max: 100, unit: "count" },
  prCommandTimeoutSec: { min: 5, max: 3600, unit: "sec" },
  commandTimeoutSec: { min: 5, max: 3600, unit: "sec" },
  postPublishWaitMinutes: { min: 1, max: 1440, unit: "min" },
};

/** §18.5: вне пределов — предупреждение и дефолт, не ошибка конфига. */
function parseTiming(
  value: unknown,
  path: string,
  err: (p: string, m: string) => void,
  warn: (p: string, m: string) => void,
  t: T,
): ReleaseTiming | undefined {
  if (!isRecord(value)) {
    err(path, t("rc.timingObject"));
    return undefined;
  }
  const timing: ReleaseTiming = {};
  for (const key of Object.keys(TIMING_BOUNDS) as (keyof ReleaseTiming)[]) {
    const v = value[key];
    if (v === undefined) continue;
    const bounds = TIMING_BOUNDS[key];
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < bounds.min ||
      v > bounds.max
    ) {
      warn(
        `${path}.${key}`, t("rc.outOfBoundsDefault", { min: bounds.min, max: bounds.max }));
      continue;
    }
    timing[key] = v;
  }
  return timing;
}

function parsePostPublish(
  value: unknown,
  path: string,
  err: (p: string, m: string) => void,
  warn: (p: string, m: string) => void,
  t: T,
): PostPublishLayer | undefined {
  if (!isRecord(value)) {
    err(
      path, t("rc.ppObject"));
    return undefined;
  }
  const pp: PostPublishLayer = {};
  if (value.checkout !== undefined) {
    if (!isNonEmptyString(value.checkout)) {
      err(`${path}.checkout`, t("rc.checkoutPath"));
    } else {
      pp.checkout = value.checkout.trim();
    }
  }
  if (value.branch !== undefined) {
    if (!isNonEmptyString(value.branch)) {
      err(`${path}.branch`, t("rc.branchNonEmpty"));
    } else {
      pp.branch = value.branch.trim();
    }
  }
  if (value.reloadPlugins !== undefined) {
    if (typeof value.reloadPlugins !== "boolean") {
      err(`${path}.reloadPlugins`, t("rc.isBool"));
    } else {
      pp.reloadPlugins = value.reloadPlugins;
    }
  }
  if (value.on !== undefined) {
    if (value.on === "published" || value.on === "merged") {
      pp.on = value.on;
    } else {
      err(`${path}.on`, t("rc.onEnum"));
    }
  }
  if (value.commands !== undefined) {
    if (!Array.isArray(value.commands)) {
      err(`${path}.commands`, t("rc.commandsArray"));
    } else {
      const commands: PostPublishCommandLayer[] = [];
      const seen = new Set<string>();
      for (const [i, c] of value.commands.entries()) {
        const cp = `${path}.commands[${i}]`;
        if (!isRecord(c)) {
          err(cp, t("rc.commandObject"));
          continue;
        }
        if (!isNonEmptyString(c.name)) {
          err(`${cp}.name`, t("rc.commandNameReq"));
          continue;
        }
        const name = c.name.trim();
        if (seen.has(name)) {
          // §6 r11: дубль name — предупреждение, вторая не выполняется.
          warn(`${cp}.name`, t("rc.dupCommand", { name: name }));
          continue;
        }
        // §18.2: поле по спеке — `run` (argv-массив); `argv` принимаем
        // как алиас, `command`-строка — явный выбор владельца на sh -c.
        let argv: string[] | undefined;
        const runArr = c.run !== undefined ? c.run : c.argv;
        if (runArr !== undefined) {
          if (
            !Array.isArray(runArr) ||
            runArr.length === 0 ||
            runArr.some((a) => !isNonEmptyString(a))
          ) {
            err(`${cp}.run`, t("rc.stringArray"));
            continue;
          }
          argv = runArr.map((a) => (a as string).trim());
        } else if (isNonEmptyString(c.command)) {
          argv = ["sh", "-c", c.command.trim()];
        } else {
          err(`${cp}.run`, t("rc.runReq"));
          continue;
        }
        const cmd: PostPublishCommandLayer = { name, argv };
        if (c.cwd !== undefined) {
          if (!isNonEmptyString(c.cwd)) {
            err(`${cp}.cwd`, t("rc.cwdPath"));
          } else {
            cmd.cwd = c.cwd.trim();
          }
        }
        if (c.timeoutSec !== undefined) {
          if (
            typeof c.timeoutSec !== "number" ||
            !Number.isFinite(c.timeoutSec) ||
            c.timeoutSec < 5 ||
            c.timeoutSec > 3600
          ) {
            warn(`${cp}.timeoutSec`, t("rc.timeoutBounds"));
          } else {
            cmd.timeoutSec = c.timeoutSec;
          }
        }
        if (c.when !== undefined) {
          if (
            !Array.isArray(c.when) ||
            c.when.some((w) => !isNonEmptyString(w))
          ) {
            err(`${cp}.when`, t("rc.whenArray"));
          } else {
            cmd.when = c.when.map((w) => (w as string).trim());
          }
        }
        for (const key of ["stopOnFail", "installsDeps"] as const) {
          if (c[key] !== undefined) {
            if (typeof c[key] !== "boolean") {
              err(`${cp}.${key}`, t("rc.isBool"));
            } else {
              cmd[key] = c[key] as boolean;
            }
          }
        }
        seen.add(name);
        commands.push(cmd);
      }
      pp.commands = commands;
    }
  }
  if (pp.checkout === undefined && (pp.commands?.length ?? 0) === 0) {
    err(path, t("rc.ppNeedsSomething"));
    return undefined;
  }
  return pp;
}

export function parseReleaseConfig(
  text: string | undefined,
  t: T = T_RU,
): ReleaseConfigLoad {
  const errors: PolicyIssue[] = [];
  const warnings: PolicyIssue[] = [];
  const err = (path: string, message: string) =>
    errors.push({ path, message });
  const warn = (path: string, message: string) =>
    warnings.push({ path, message });
  const done = (empty = false): ReleaseConfigLoad => ({
    config: null,
    empty,
    errors,
    warnings,
  });

  if (!text || text.trim() === "") return done(true);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    err("$", t("rc.badJson", { error: (e as Error).message }));
    return done();
  }
  if (!isRecord(raw)) {
    err("$", t("rc.notObject"));
    return done();
  }

  let commitIdentity: string | undefined;
  if (raw.commitIdentity !== undefined) {
    if (!isCommitIdentity(raw.commitIdentity)) {
      err(
        "commitIdentity", t("rc.commitIdentity"));
    } else {
      commitIdentity = raw.commitIdentity;
    }
  }

  const defaults = parseLayer(raw.defaults ?? {}, "defaults", err, warn, t);

  const projects: Record<string, ReleaseProjectLayer> = {};
  if (raw.projects !== undefined) {
    if (!isRecord(raw.projects)) {
      err("projects", t("rc.projectsObject"));
    } else {
      for (const [id, value] of Object.entries(raw.projects)) {
        if (!isNonEmptyString(id)) {
          err("projects", t("rc.projectIds"));
          continue;
        }
        projects[id] = parseLayer(value, `projects.${id}`, err, warn, t);
      }
    }
  }

  if (errors.length > 0) return done();

  /* §6 r11: мягкие замечания по эффективному контексту (defaults и
   * каждый проект поверх них). */
  const effectiveOn = (
    pp: PostPublishLayer | undefined,
    target: ReleaseTarget,
  ): PostPublishOn | undefined =>
    pp?.on === undefined
      ? target.action === "pr"
        ? "merged"
        : "published"
      : pp.on === "merged" && target.action === "push"
        ? "published"
        : pp.on;
  const contexts: [string, ReleaseProjectLayer][] = [["defaults", defaults]];
  for (const [id, layer] of Object.entries(projects)) {
    contexts.push([`projects.${id}`, { ...defaults, ...layer }]);
  }
  for (const [ctx, layer] of contexts) {
    const pp = layer.postPublish;
    if (!pp) continue;
    const target = layer.target ?? { action: "push" as const, branch: "main" };
    const on = pp.on ?? (target.action === "pr" ? "merged" : "published");
    if (on === "merged" && target.action === "push") {
      warn(`${ctx}.postPublish.on`, t("rc.mergedOnPush"));
    }
    if (
      effectiveOn(pp, target) === "merged" &&
      (layer.prProvider?.type ?? "github") === "none"
    ) {
      warn(
        `${ctx}.postPublish.on`, t("rc.mergedNever"));
    }
    for (const cmd of pp.commands ?? []) {
      if (cmd.cwd === "checkout" && pp.checkout === undefined) {
        warn(
          `${ctx}.postPublish.commands`, t("rc.missingCheckout", { name: cmd.name }));
      }
    }
  }

  return {
    config: {
      ...(commitIdentity ? { commitIdentity } : {}),
      defaults,
      projects,
    },
    empty: false,
    errors,
    warnings,
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
  const own = config.projects[projectId] ?? {};
  const layer = { ...config.defaults, ...own };
  // §18.5: `leaks` и `timing` сливаются по ключам — проектный ключ
  // заменяет defaults-ключ, остальные наследуются.
  const leaks = { ...(config.defaults.leaks ?? {}), ...(own.leaks ?? {}) };
  const timing: ResolvedTiming = {
    ...DEFAULT_TIMING,
    ...(config.defaults.timing ?? {}),
    ...(own.timing ?? {}),
  };
  const isPublic = layer.public === true;
  const defaultStrictness: LeakStrictness = isPublic ? "block" : "warn";
  const target = layer.target ?? { action: "push" as const, branch: "main" };
  const pp = layer.postPublish;
  const ppOn: PostPublishOn =
    pp?.on === undefined
      ? target.action === "pr"
        ? "merged"
        : "published"
      : pp.on === "merged" && target.action === "push"
        ? "published"
        : pp.on;
  return {
    excluded: layer.excluded === true,
    target,
    sync: layer.sync ?? "merge",
    checks: layer.checks ?? [],
    public: isPublic,
    docsMap: layer.docsMap ?? {},
    leaks: {
      machine: leaks.machine ?? defaultStrictness,
      bbIds: leaks.bbIds ?? defaultStrictness,
      // §18.6: trailers default to `warn` for a new installation —
      // public/private does not apply; the author's install pins
      // `"block"` explicitly.
      trailers: leaks.trailers ?? "warn",
      allow: leaks.allow ?? [],
    },
    commitIdentity: layer.commitIdentity ?? config.commitIdentity,
    threadIds: layer.threadIds ?? true,
    allowedTrailers: layer.allowedTrailers ?? [],
    allowedEmails: layer.allowedEmails ?? [],
    postPublish: pp
      ? {
          ...(pp.checkout !== undefined ? { checkout: pp.checkout } : {}),
          branch: pp.branch ?? target.branch,
          reloadPlugins: pp.reloadPlugins === true,
          on: ppOn,
          commands: (pp.commands ?? []).map((c) => ({
            name: c.name,
            argv: c.argv,
            ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
            ...(c.timeoutSec !== undefined
              ? { timeoutSec: c.timeoutSec }
              : {}),
            ...(c.when !== undefined ? { when: c.when } : {}),
            stopOnFail: c.stopOnFail === true,
            installsDeps: c.installsDeps === true,
            noCheckout: c.cwd === "checkout" && pp.checkout === undefined,
          })),
        }
      : null,
    timing,
    prProvider: layer.prProvider ?? { type: "github", raw: undefined },
    prBody: layer.prBody ?? DEFAULT_PR_BODY,
    requireNote: layer.requireNote === true,
  };
}

/**
 * §4 r11/§18.6: a missing commit identity is a WARNING, not a release
 * blocker — the scan flags such commits but the pipeline goes on. The
 * plugin reports it in `status` while no inheritable identity exists:
 * neither the top-level `commitIdentity` nor `defaults.commitIdentity`
 * is set (a project with its own layer still covers only itself — any
 * unlisted project resolves through defaults and would lack one).
 */
export function commitIdentityMissing(config: ReleaseConfig): boolean {
  return (
    (config.defaults.commitIdentity ?? config.commitIdentity) === undefined
  );
}
