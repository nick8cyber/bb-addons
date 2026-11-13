/**
 * bb-plugin-orchestrator — policy-driven delegation of bb tasks (spec
 * docs/specs/orchestrator.md, ADR-0015). MVP scope: policy setting +
 * validation, SQLite delegations/route_holds, `delegate` (CLI + agent
 * tool), coordinator-only `bb.agents.configure`, status/show/cancel/
 * policy/instructions CLI, and the §5 watchdog (background service) with
 * the §7 reconcile pass behind `bb orchestrator reconcile`.
 */
import { z } from "zod";
import { join as joinPath } from "node:path";
import { homedir } from "node:os";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type StandardSchemaV1,
} from "@get-bb/plugin-sdk";
import { OrchestratorError, errorJson, toErrorBody } from "./src/errors.js";
import { parsePolicy, type PolicyLoad } from "./src/policy.js";
import {
  DelegationStore,
  JanitorStore,
  MIGRATIONS,
  type DelegationRow,
} from "./src/store.js";
import {
  parseJanitorConfig,
  type JanitorConfigLoad,
} from "./src/janitor-config.js";
import { createJanitor } from "./src/janitor.js";
import {
  createBbCli,
  runChecked,
  runJson,
  type BbCli,
} from "./src/bb-cli.js";
import {
  buildAgentConfiguration,
  fallbackAgentConfiguration,
  migratePluginThreadRoles,
  skillSet,
  type ExecutorProbes,
  type ThreadFacts,
} from "./src/agent-config.js";
import {
  DEFAULT_GIT_INSTRUCTIONS,
  effectiveGitInstructions,
  generateRoutingRule,
  GIT_INSTRUCTIONS_MAX,
  gitInstructionsError,
} from "./src/instructions.js";
import {
  createDelegateQueue,
  dispatchToRoute,
  finishDispatchSteps,
  retrySetupSteps,
  runDelegate,
  type DelegateThreads,
} from "./src/delegate.js";
import {
  cancelProviderRetries,
  createWatchdog,
  findDelegatedThreadId,
  providerRetryCli,
  type WatchdogThreads,
} from "./src/watchdog.js";
import {
  DEFAULT_HANDOFF_PATH,
  DEFAULT_USER_THREAD_PLUGINS,
  HANDOFF_PATH_MAX,
  handleMessageDispatch,
  handoffPathError,
  isRoleId,
  parseRoleTexts,
  PICKABLE_ROLE_IDS,
  reviewLevelName,
  ROLE_INSTRUCTIONS_MAX,
  roleForLevel,
  roleInstructions,
  roleTextsError,
  type RoleDecisionProbes,
  type RoleId,
} from "./src/roles.js";
import {
  commitIdentityMissing,
  parseReleaseConfig,
  resolveProject,
  type ReleaseConfigLoad,
} from "./src/release-config.js";
import { createCmd } from "./src/cmd.js";
import { createCommandRunner } from "./src/commands.js";
import {
  effectiveHooks,
  onHookRunFinished,
  parseEventHooks,
} from "./src/events.js";
import {
  checkExecSettings,
  execSettingsChanges,
} from "./src/trust.js";
import { isEnvironmentGone, runMerge } from "./src/merge.js";
import {
  assertInstalledHookFresh,
  pumpReleases,
  releaseAllPostPublishLocks,
  releaseThreadsGet,
  runRelease,
  settingsProjectId,
  syncInstalledPrePush,
} from "./src/release.js";
import {
  createT,
  resolveLang,
  type Params,
  type T,
} from "./src/i18n/index.js";

/** §13.2 п.1: the new-chat window's role picker writes the project's
 * current selection through `setPendingRole`; `pendingRole` reads it back
 * so a reopened window shows the remembered pick. */
export const rpcContract = defineRpcContract({
  setPendingRole: {
    input: z.object({
      projectId: z.string().nullable(),
      role: z.enum(["orchestrator", "executor", "auditor"]),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  pendingRole: {
    input: z.object({ projectId: z.string().nullable() }),
    output: z.object({
      role: z.enum(["orchestrator", "executor", "auditor"]).nullable(),
    }),
  },
});

/** The `pending_roles` RPC handlers; `projectId = null` (projectless
 * compose) stores nothing and reads back the default. */
export function pendingRoleRpc(store: DelegationStore) {
  return {
    setPendingRole({
      projectId,
      role,
    }: {
      projectId: string | null;
      role: RoleId;
    }) {
      if (projectId !== null) store.setPendingRole(projectId, role);
      return { ok: true as const };
    },
    pendingRole({ projectId }: { projectId: string | null }) {
      const role =
        projectId === null ? undefined : store.pendingRole(projectId);
      return {
        role:
          role !== undefined && isRoleId(role) && role !== "release-auditor"
            ? role
            : null,
      };
    },
  };
}

export interface OrchestratorDeps {
  bbCli?: BbCli;
  cmd?: ReturnType<typeof createCmd>;
  /** Clock for the §2 preset-check throttle; tests inject a fake. */
  now?: () => number;
}

interface PresetListEntry {
  id?: string;
  name?: string;
  /** §2.3 one-off presets + §16.8 worktree check need provider/env kind. */
  providerId?: string;
  environmentKind?: string;
}

const describeError = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

/** §18.6: refuse a multi-line or over-limit `handoffPath` at write time. */
const handoffPathSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "orchestrator",
    validate: (v) =>
      typeof v === "string" && !handoffPathError(v)
        ? { value: v }
        : {
            issues: [
              {
                message: `one line, at most ${HANDOFF_PATH_MAX} characters`,
              },
            ],
          },
  },
};

/** §18.1 (PLUG-247a): the UI/log language — `en` (default) or `ru`. */
const languageSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "orchestrator",
    validate: (v) =>
      v === "en" || v === "ru"
        ? { value: v }
        : { issues: [{ message: '"en" or "ru"' }] },
  },
};

/** §2.2: refuse over-limit `gitInstructions` at write time. */
const gitInstructionsSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "orchestrator",
    validate: (v) =>
      typeof v === "string" && v.length <= GIT_INSTRUCTIONS_MAX
        ? { value: v }
        : {
            issues: [
              { message: `at most ${GIT_INSTRUCTIONS_MAX} characters` },
            ],
          },
  },
};

export async function createPlugin(
  bb: BbPluginApi,
  deps: OrchestratorDeps = {},
) {
  const bbCli = deps.bbCli ?? createBbCli();
  const now = deps.now ?? Date.now;

  const settings = bb.settings.define({
    // §18.1 (PLUG-247a): UI/log language — catalog `src/i18n/<lang>.ts`.
    language: {
      type: "string",
      label: "Language",
      description:
        "Interface language for coordinator messages, CLI output, " +
        "instructions and the pre-push hook: `en` (default) or `ru`. " +
        "Missing strings fall back to English with a log warning.",
      experimental_schema: languageSchema,
      default: "en",
    },
    policy: {
      type: "string",
      label: "Policy",
      description:
        "Routing policy JSON (spec §2): version, limits, levels with route chains, routes naming bb tasks presets. Empty or invalid — plugin reports needs-configuration and delegate refuses calls.",
      experimental_multiline: true,
      default: "",
    },
    injectInstructions: {
      type: "boolean",
      label: "Inject coordinator instructions",
      description:
        "Give coordinator threads the generated routing rule (§3). When off, all plugin texts are silenced; tools stay.",
      default: true,
    },
    release: {
      type: "string",
      label: "Release config",
      description:
        "Release pipeline JSON (orchestrator-release §6): commitIdentity, defaults and per-project overrides (target, sync, checks, public, docsMap, leaks, excluded, threadIds). Empty — `release` disabled.",
      experimental_multiline: true,
      default: "",
    },
    gitInstructions: {
      type: "string",
      label: "Git instructions",
      description:
        '"Working with git" section (§2.2) prepended to every dispatch\'s --instructions. Empty disables the section.',
      experimental_multiline: true,
      experimental_schema: gitInstructionsSchema,
      default: DEFAULT_GIT_INSTRUCTIONS,
    },
    mergeAutofix: {
      type: "boolean",
      label: "Auto-delegate merge conflicts",
      description:
        "§14/§16.6: on a merge conflict, delegate a fix round to the same task and level. Off — only report the conflict to the coordinator.",
      default: false,
    },
    userThreadPlugins: {
      type: "string",
      label: "User thread plugins",
      description:
        "§17.1: plugin ids whose threads continue a human chat (session handoff, chat compaction into a new thread) — they keep the coordinator role instead of the plugin `none`. Comma/space-separated; default EMPTY — only an explicitly saved value is kept (the author's sets `handoff, external-compact`).",
      default: "",
    },
    roleTexts: {
      type: "string",
      label: "Role texts",
      description:
        "§18.6: JSON {orchestrator|executor|auditor: string} — text APPENDED to the built-in role instructions; the mandatory tails (sudo/packages ban, auditor JSON verdict) always stay and `release-auditor` cannot be changed. The composed text must stay within 2500 characters per role. Empty — built-in texts only.",
      experimental_multiline: true,
      default: "",
    },
    handoffPath: {
      type: "string",
      label: "Handoff path",
      description:
        "§18.6: the handoff file path shown in role texts and the §16.5 compaction reminder — one line, at most 256 characters. Empty — the default `$BB_THREAD_STORAGE/HANDOFF.md`.",
      experimental_schema: handoffPathSchema,
      default: DEFAULT_HANDOFF_PATH,
    },
    maxConcurrentCommands: {
      type: "string",
      label: "Max concurrent commands",
      description:
        "§18.2: cap on simultaneously running journaled commands (postPublish/event hooks). Default 4.",
      default: "4",
    },
    retentionDays: {
      type: "string",
      label: "Command journal retention (days)",
      description:
        "§18.2: command_runs and events entries older than this are pruned. Default 30.",
      default: "30",
    },
    eventHooks: {
      type: "string",
      label: "Event hooks",
      description:
        "§18.5: JSON array of event hooks — [{name, on:[<event>…], run:[argv…], projects?:[proj_…], timeoutSec?:120, notifyOnFail?:false}]. Hook commands run via the shared command runner from the plugin data dir; the v1 event JSON goes to stdin, ORCH_EVENT/ORCH_TASK/ORCH_PROJECT to the env. Empty — no hooks.",
      experimental_multiline: true,
      default: "",
    },
    janitor: {
      type: "string",
      label: "Janitor",
      description:
        "Janitor JSON (spec §15-16): enabled, mode apply|report, afterMerge, abandonedAfter, intervalMinutes, excludeProjects, protectedBranches, deleteBranches, scope workers|all. Disabled by default; an invalid document warns in the journal and keeps the janitor off.",
      experimental_multiline: true,
      default: '{"enabled": false}',
    },
  });

  let currentSettings = await settings.get();
  /** §18.1 (PLUG-247a): the selected language and its translator.
   * `t` is a STABLE forwarding wrapper — deps objects capture it once,
   * a `language` change only rebinds `currentT`, and every later call
   * picks up the new language. Missing keys fall back to English with
   * a one-time warning each. */
  let lang = resolveLang(currentSettings.language);
  let currentT = createT(lang, (m) => bb.log.warn(m));
  const t: T = Object.assign(
    (key: string, params?: Params) => currentT(key, params),
    { get lang() { return currentT.lang; } },
  );

  /** §17.1 r26 (PLUG-211 Б2): plugin ids continuing a human chat —
   * comma/space-separated in the `userThreadPlugins` setting. */
  const userPlugins = (): readonly string[] =>
    (
      currentSettings.userThreadPlugins ??
      DEFAULT_USER_THREAD_PLUGINS.join(" ")
    )
      .split(/[\s,]+/)
      .filter(Boolean);

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = new DelegationStore(db);
  const janitorStore = new JanitorStore(db);
  const enqueue = createDelegateQueue();
  const positiveInt = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : dflt;
  };
  // §18.2 (PLUG-245): общий запускатель журнальных команд. Сразу
  // recover(): running записи прошлого процесса — живая группа
  // убивается, запись interrupted; queued запустит следующий pump.
  // §18.5 (PLUG-246): хуки событий — разбор настройки `eventHooks`;
  // сопоставление — синхронно внутри транзакции перехода, поэтому
  // провайдер отдаёт последний разобранный список.
  let hooksLoad = parseEventHooks(currentSettings.eventHooks ?? "", t);
  for (const e of hooksLoad.errors) {
    bb.log.warn(`orchestrator eventHooks: ${e.path}: ${e.message}`);
  }
  // §18.5 (ревью Б2): ошибка разбора eventHooks — хуки не запускаются
  // вовсе (действующий список пуст, события в `events` пишутся всё
  // равно).
  store.eventHooksProvider = () => ({
    hooks: effectiveHooks(hooksLoad),
    cwd: pluginDataDir(),
  });
  const commandRunner = createCommandRunner({
    store,
    maxConcurrent: () =>
      positiveInt(currentSettings.maxConcurrentCommands, 4),
    warn: (m) => bb.log.warn(m),
    t,
    // §18.5 notifyOnFail: строка координатору на серию сбоев хука.
    onFinish: (row, status, _code, tail) =>
      onHookRunFinished(
        {
          store,
          send: async (threadId, text) => {
            await bb.sdk.threads.send({
              threadId,
              mode: "queue-if-active",
              input: [
                { type: "text", text: `[orchestrator] ${text}`, mentions: [] },
              ],
            });
          },
          warn: (m) => bb.log.warn(m),
          t,
        },
        row,
        status,
        tail,
      ),
  });
  void commandRunner
    .recover()
    .catch((e) =>
      bb.log.warn(`orchestrator commands recover: ${describeError(e)}`),
    );

  // The probes behind the §3 executor heuristics; one implementation for
  // `configure`, `delegate`, and the CLI caller check.
  const probes: ExecutorProbes = {
    delegationByThreadId: (threadId) => store.byThreadId(threadId),
    hasFreshDispatching: (freshSince, scope) =>
      store.hasFreshDispatching(freshSince, scope),
    roleByThreadId: (threadId) => store.threadRole(threadId)?.role,
    // §17.1 r26 (PLUG-211 Б1): the configure-time lazy rewrite of a
    // stale `orchestrator` row on a plugin-born thread.
    writeRole: (threadId, role) =>
      store.setThreadRole(threadId, role, "hook"),
    // §17.1 r26 (PLUG-211 Б2): plugins continuing a human chat.
    userThreadPlugins: () => userPlugins(),
  };

  // §13.2 п.1-2: the role decision's read side — synchronous SQLite only,
  // the `message.dispatch` hook may not call out anywhere.
  const roleProbes: RoleDecisionProbes = {
    threadRole: (threadId) => store.threadRole(threadId),
    pendingRole: (projectId) => store.pendingRole(projectId),
    activeDelegationByTaskKey: (taskKey) =>
      store.activeByTaskKey(taskKey),
    // §16.7: level→role map + "invalid policy → root chat gets no role".
    policy: () => policyLoad.policy,
    // §17.1 r26 (PLUG-211 Б2): plugins continuing a human chat.
    userThreadPlugins: () => userPlugins(),
  };

  // §17.1 r26 (PLUG-211 Б1): one-time rewrite — hook-decided
  // `orchestrator` rows on plugin-born threads outside
  // `userThreadPlugins` become `none`; `configure`'s lazy fix covers
  // what this pass cannot reach.
  const ROLE_MIGRATION_KEY = "role-migration-r26";
  if (store.metaGet(ROLE_MIGRATION_KEY) === undefined) {
    void migratePluginThreadRoles(store, {
      threadOriginPluginId: async (threadId) =>
        (await bb.sdk.threads.get({ threadId })).originPluginId,
      userThreadPlugins: userPlugins(),
      log: bb.log,
    })
      .then((moved) => {
        if (moved > 0) {
          bb.log.info(
            `orchestrator: role migration r26 rewrote ${moved} thread_roles`,
          );
        }
        store.metaSet(ROLE_MIGRATION_KEY, "1");
      })
      .catch((e) =>
        bb.log.warn(`orchestrator: role migration r26: ${describeError(e)}`),
      );
  }

  /**
   * Load + validate the configured policy. The structural parse never
   * touches the CLI; rule 2's preset-existence check (`bb tasks preset
   * list`) runs only when `checkPresets` — at `policy validate`, at each
   * delegate, and in the background on the §2 schedule. An unreadable
   * preset list degrades to a warning so a CLI hiccup cannot make a good
   * policy look invalid (§2).
   */
  const loadPolicy = async (checkPresets = false): Promise<PolicyLoad> => {
    const text = currentSettings.policy ?? "";
    if (!checkPresets) return parsePolicy(text, undefined, undefined, t);
    let knownPresets: Set<string> | undefined;
    let presetDetails:
      | Map<string, { environmentKind?: string | null }>
      | undefined;
    let presetWarning: string | undefined;
    try {
      const res = await runJson<{ presets?: PresetListEntry[] }>(
        bbCli,
        ["tasks", "preset", "list", "--json"],
        { timeoutMs: 15_000 },
      );
      knownPresets = new Set(
        (res.presets ?? []).flatMap((p) =>
          [p.name, p.id].filter((x): x is string => typeof x === "string"),
        ),
      );
      presetDetails = new Map(
        (res.presets ?? []).flatMap((p) =>
          [p.name, p.id]
            .filter((x): x is string => typeof x === "string")
            .map(
              (key) =>
                [
                  key,
                  { environmentKind: p.environmentKind ?? null },
                ] as const,
            ),
        ),
      );
    } catch (e) {
      presetWarning = `preset check skipped: ${describeError(e)}`;
    }
    const load = parsePolicy(text, knownPresets, presetDetails, t);
    if (presetWarning) {
      load.warnings.push({ path: "policy", message: presetWarning });
    }
    return load;
  };

  // Structural validation only — nothing may block plugin load on the CLI.
  let policyLoad = parsePolicy(
    currentSettings.policy ?? "",
    undefined,
    undefined,
    t,
  );
  let releaseConfig: ReleaseConfigLoad = parseReleaseConfig(
    currentSettings.release ?? "",
    t,
  );
  // §18.6 (PLUG-249): roleTexts — дополнение к текстам ролей; битый
  // документ игнорируется целиком и виден в status/needs-configuration.
  // §18.6: handoffPath — одна строка ≤ 256 символов; невалидное
  // значение игнорируется (действует умолчание) и видно в status.
  const handoffPath = (): string => {
    const p = currentSettings.handoffPath?.trim();
    return p && !handoffPathError(p) ? p : DEFAULT_HANDOFF_PATH;
  };
  /** Предел 2500 проверяется на итоговом тексте с РЕАЛЬНЫМИ
   * подстановками — текущими handoffPath и именем уровня ревью из
   * политики, а не умолчаниями. */
  const parseRoleTextsNow = () =>
    parseRoleTexts(currentSettings.roleTexts ?? "", {
      handoffPath: handoffPath(),
      reviewLevel: reviewLevelName(policyLoad.policy),
      t,
    });
  let roleTextsLoad = parseRoleTextsNow();
  for (const e of roleTextsLoad.errors) {
    bb.log.warn(`orchestrator roleTexts: ${e.path}: ${e.message}`);
  }
  /** §18.6: эффективный текст роли — тело + roleTexts + обязательный
   * хвост; {handoff} из настройки, {review} — имя уровня по политике. */
  const roleTextFor = (id: RoleId): string => {
    const opts = {
      handoffPath: handoffPath(),
      reviewLevel: reviewLevelName(policyLoad.policy),
    };
    const extra =
      id === "release-auditor" ? undefined : roleTextsLoad.texts[id];
    const text = roleInstructions(id, { extra, ...opts, t });
    // Подстановки могли вырасти уже после разбора (смена политики,
    // handoffPath) — текст за пределом 2500 теряет дополнение, чтобы
    // обязательный хвост не обрезался лимитом SDK (роль+правило ≤ 4096).
    return extra && text.length > ROLE_INSTRUCTIONS_MAX
      ? roleInstructions(id, { ...opts, t })
      : text;
  };
  const janitorConfig = (): JanitorConfigLoad =>
    parseJanitorConfig(currentSettings.janitor ?? "");
  {
    const l = janitorConfig();
    for (const e of l.errors) {
      bb.log.warn(`orchestrator janitor: ${e.path}: ${e.message}`);
    }
  }
  /**
   * §2 (rev 13): the background preset check runs at most once per ten
   * minutes, only when the policy text changed since the last check or
   * delegations are active — and outside the `delegate` queue, so a slow
   * `bb tasks preset list` cannot stall dispatches.
   */
  const PRESET_CHECK_INTERVAL_MS = 10 * 60 * 1000;
  let lastPresetCheckAt = 0;
  let lastPresetCheckPolicy: string | undefined;
  let presetCheckInFlight = false;
  const maybeCheckPresets = () => {
    const text = currentSettings.policy ?? "";
    const due =
      !presetCheckInFlight &&
      now() - lastPresetCheckAt >= PRESET_CHECK_INTERVAL_MS &&
      (lastPresetCheckPolicy !== text || store.activeCount() > 0);
    if (!due) return;
    presetCheckInFlight = true;
    lastPresetCheckAt = now();
    lastPresetCheckPolicy = text;
    void loadPolicy(true)
      .then((load) => {
        policyLoad = load;
        for (const w of load.warnings) {
          bb.log.warn(`orchestrator: ${w.path}: ${w.message}`);
        }
        // §18.6: имя уровня ревью входит в текст оркестратора — смена
        // политики перепроверяет roleTexts на новых подстановках.
        roleTextsLoad = parseRoleTextsNow();
        for (const e of roleTextsLoad.errors) {
          bb.log.warn(`orchestrator roleTexts: ${e.path}: ${e.message}`);
        }
        refreshStatus();
      })
      .catch(() => undefined)
      .finally(() => {
        presetCheckInFlight = false;
      });
  };

  const refreshStatus = () => {
    // §18.6 (ревью Н3): проблемы не прячут друг друга — все битые
    // настройки перечисляются одной строкой, а не только первая.
    const problems: string[] = [];
    const first = policyLoad.errors[0];
    if (first) {
      const rest =
        policyLoad.errors.length > 1
          ? t("status.moreErrs", { n: policyLoad.errors.length - 1 })
          : "";
      problems.push(
        `${first.path}: ${first.message}${rest} — ` +
          t("status.fixSetting", { name: "policy" }),
      );
    }
    if (releaseConfig.errors.length) {
      const e = releaseConfig.errors[0]!;
      problems.push(
        `release: ${e.path}: ${e.message}` +
          (releaseConfig.errors.length > 1
            ? t("status.moreErrs", {
                n: releaseConfig.errors.length - 1,
              })
            : "") +
          " — " +
          t("status.fixSetting", { name: "release" }),
      );
    }
    const gitError = gitInstructionsError(
      currentSettings.gitInstructions,
      t,
    );
    if (gitError) {
      problems.push(
        `${gitError} — ` +
          t("status.fixSetting", { name: "gitInstructions" }),
      );
    }
    const hpError = handoffPathError(currentSettings.handoffPath, t);
    if (hpError) {
      problems.push(
        `${hpError} — ` + t("status.fixSetting", { name: "handoffPath" }),
      );
    }
    const textsError = roleTextsError(roleTextsLoad, t);
    if (textsError) {
      problems.push(
        `${textsError} — ` +
          t("status.fixSetting", { name: "roleTexts" }),
      );
    }
    // needs-configuration clears only on plugin reload (SDK V1), so the
    // message tells the user how to re-check after fixing the setting.
    if (problems.length) {
      bb.status.needsConfiguration(
        `orchestrator: ${problems.join("; ")}` +
          t("status.reloadHint"),
      );
    }
  };
  // §18.4 (PLUG-245): доверие по снимку исполняемых настроек —
  // первый снимок молча, расхождение — строка координаторам с
  // незавершённой работой + список ключей в plugin_meta (значений нет).
  const execSettingsCheck = () =>
    checkExecSettings({
      store,
      cfg: releaseConfig.config,
      hooks: hooksLoad.hooks,
      // §18.5 (ревью Б2): сверка идёт по частям — битый `release` не
      // отключает проверку хуков и наоборот.
      cfgBroken: releaseConfig.errors.length > 0,
      hooksBroken: hooksLoad.errors.length > 0,
      // §18.5 (ревью заход 3): сырая строка — хеш маркера битого
      // документа в снимке доверия.
      hooksRaw: currentSettings.eventHooks ?? "",
      send: async (threadId, text) => {
        await bb.sdk.threads.send({
          threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: `[orchestrator] ${text}`, mentions: [] }],
        });
      },
      warn: (m) => bb.log.warn(m),
      t,
    }).catch((e) =>
      bb.log.warn(`orchestrator exec-settings: ${describeError(e)}`),
    );

  refreshStatus();
  maybeCheckPresets();
  void execSettingsCheck();

  settings.onChange((next) => {
    currentSettings = next;
    // §18.1 (PLUG-247a): a language change rebuilds the translator and
    // rewrites the installed pre-push (its texts are versioned with the
    // language); everything below re-parses under the new `t`.
    const nextLang = resolveLang(currentSettings.language);
    if (nextLang !== lang) {
      lang = nextLang;
      currentT = createT(lang, (m) => bb.log.warn(m));
      try {
        if (
          syncInstalledPrePush(
            joinPath(pluginDataDir(), "git-hooks"),
            t,
          )
        ) {
          bb.log.warn(
            "orchestrator: pre-push rewritten for the new language",
          );
        }
      } catch (e) {
        bb.log.warn(
          `orchestrator: pre-push sync: ${describeError(e)}`,
        );
      }
    }
    policyLoad = parsePolicy(currentSettings.policy ?? "", undefined, undefined, t);
    releaseConfig = parseReleaseConfig(currentSettings.release ?? "", t);
    for (const w of releaseConfig.warnings) {
      bb.log.warn(`orchestrator release config: ${w.path}: ${w.message}`);
    }
    hooksLoad = parseEventHooks(currentSettings.eventHooks ?? "", t);
    for (const e of hooksLoad.errors) {
      bb.log.warn(`orchestrator eventHooks: ${e.path}: ${e.message}`);
    }
    roleTextsLoad = parseRoleTextsNow();
    for (const e of roleTextsLoad.errors) {
      bb.log.warn(`orchestrator roleTexts: ${e.path}: ${e.message}`);
    }
    void execSettingsCheck();
    for (const e of janitorConfig().errors) {
      bb.log.warn(`orchestrator janitor: ${e.path}: ${e.message}`);
    }
    refreshStatus();
    maybeCheckPresets();
  });

  const instructionsText = () =>
    policyLoad.policy
      ? generateRoutingRule(policyLoad.policy, t)
      : t("instr.setupHint");

  // §3: one configure handler, the choice delegated to agent-config.ts. A
  // throw inside must not silence the plugin (SDK fail-closed), so it falls
  // back to static facts and warns.
  bb.agents.configure((context) => {
    try {
      const config = buildAgentConfiguration(context, {
        injectInstructions: currentSettings.injectInstructions ?? true,
        instructionsText: instructionsText(),
        probes,
        policyOk: policyLoad.policy !== null,
        roleInstructions: roleTextFor,
        skills: skillSet(lang),
      });
      // §13.2 п.4: reflect the decided role into display metadata. The
      // hook itself may not touch the network, so the write rides on the
      // first session build after the decision — display-only either way.
      const decided = store.threadRole(context.thread.id)?.role;
      // §17.1: the `none` verdict is not a role — nothing to display.
      if (
        decided &&
        isRoleId(decided) &&
        context.pluginMetadata.role !== decided
      ) {
        void bb.sdk.threads
          .updatePluginMetadata({
            threadId: context.thread.id,
            set: { role: decided },
          })
          .catch((e) =>
            bb.log.warn(
              `orchestrator: role metadata: ${describeError(e)}`,
            ),
          );
      }
      return config;
    } catch (e) {
      bb.log.warn(
        `orchestrator: configure fell back to static facts: ${describeError(e)}`,
      );
      return fallbackAgentConfiguration(
        context,
        currentSettings.injectInstructions ?? true,
        instructionsText(),
        policyLoad.policy !== null,
        userPlugins(),
        roleTextFor("orchestrator"),
        skillSet(lang),
      );
    }
  });

  // §13.2 п.2 — the role decision hook; the handler lives in roles.ts so
  // its decision and fail-closed path stay unit-testable.
  bb.experimental_hooks.on("message.dispatch", (context) =>
    handleMessageDispatch(
      context,
      roleProbes,
      (threadId, role) => store.setThreadRole(threadId, role, "hook"),
      (m) => bb.log.warn(`orchestrator: role hook skipped: ${m}`),
    ),
  );

  /** §4 caller facts: the invoking thread's identity for the coordinator gate. */
  const callerFacts = async (threadId: string): Promise<ThreadFacts> => {
    const thread = await bb.sdk.threads.get({ threadId });
    return {
      threadId,
      parentThreadId: thread.parentThreadId,
      title: thread.title ?? thread.titleFallback,
      originPluginId: thread.originPluginId,
      projectId: thread.projectId,
    };
  };

  const delegate = (input: {
    taskKey: string;
    level: string;
    route?: string;
    preset?: string;
    instructions?: string;
    from?: string;
    fresh?: boolean;
    noCode?: boolean;
    threadId?: string;
  }) =>
    enqueue(async () => {
      if (!input.threadId) {
        throw new OrchestratorError(
          "no-caller-thread",
          "delegate works only from a bb thread (BB_THREAD_ID is absent)",
          "run it inside a thread, or via the orchestrator_delegate tool",
        );
      }
      let caller: ThreadFacts;
      try {
        caller = await callerFacts(input.threadId);
      } catch (e) {
        throw new OrchestratorError(
          "not-a-coordinator",
          `calling thread ${input.threadId} is not readable: ${describeError(e)}`,
        );
      }
      return runDelegate({ ...input, caller }, {
        store,
        bbCli,
        threads: bb.sdk.threads as unknown as DelegateThreads,
        loadPolicy: () => loadPolicy(true),
        probes,
        primaryHostId,
        gitInstructions: () =>
        effectiveGitInstructions(currentSettings.gitInstructions, t),
        cmd,
        t,
      });
    });

  const findDelegation = (ref: string): DelegationRow | undefined =>
    /^\d+$/.test(ref) ? store.get(Number(ref)) : store.byThreadId(ref);

  // ── Watchdog (§5) + reconcile (§7) ──────────────────────────────────
  //
  // The dispatch steps are the same functions `delegate` runs (§4.3–4.7),
  // so a reissued executor gets every later change to those steps for
  // free. `enqueue` serializes watchdog actions against delegate/cancel
  // calls in this process.
  /** This machine's bb hostId (release §6 r8; janitor host scoping) — a
   * `system.config` failure is not fatal there and degrades to "". */
  const localHostId = async () => {
    try {
      const sys = await (
        bb.sdk as unknown as {
          system?: { config?: () => Promise<{ primaryHostId?: string }> };
        }
      ).system?.config?.();
      return sys?.primaryHostId ?? "";
    } catch {
      return "";
    }
  };
  /** §4 r30 (в): the dispatch steps' host lookup must NOT swallow a
   * `system.config` failure — `dispatchViaSpawn` maps a throw to
   * `dispatch-unknown`; an empty id is an explicit refusal there. */
  const primaryHostId = async () => {
    const sys = await (
      bb.sdk as unknown as {
        system?: { config?: () => Promise<{ primaryHostId?: string }> };
      }
    ).system?.config?.();
    return sys?.primaryHostId ?? "";
  };
  const stepsDeps = {
    store,
    bbCli,
    threads: bb.sdk.threads as unknown as DelegateThreads,
    primaryHostId,
    gitInstructions: () =>
        effectiveGitInstructions(currentSettings.gitInstructions, t),
    policy: () => policyLoad.policy,
    t,
  };
  const watchdogThreads: WatchdogThreads = {
    get: (a) => bb.sdk.threads.get(a),
    events: {
      list: (a) =>
        bb.sdk.threads.events.list(a as never) as never,
    },
    queuedMessages: { list: (a) => bb.sdk.threads.queuedMessages.list(a) },
    send: (a) => bb.sdk.threads.send(a as never),
    stop: (a) => bb.sdk.threads.stop(a),
    output: (a) => bb.sdk.threads.output(a),
    update: (a) => bb.sdk.threads.update(a as never),
    // §4 r30 (е 4): the own-spawn label lookup for `dispatching` rows
    // without `thread_id` — children of the coordinator + the
    // `pluginMetadata.delegationId` read per candidate.
    list: (a) => bb.sdk.threads.list(a) as never,
    getPluginMetadata: (a: { threadId: string }) =>
      bb.sdk.threads.getPluginMetadata(a),
  };
  const cmd = deps.cmd ?? createCmd();
  const pluginDataDir = () => {
    try {
      return joinPath(
        bb.server.experimental_dataDir,
        "plugins",
        bb.pluginId,
      );
    } catch {
      // §17.3 (мелко 9): the token dir must be ONE path the plugin and
      // hooks/install.mjs both know — the installer's default
      // `~/.bb/plugins/orchestrator`, never a per-boot /tmp a reinstalled
      // hook would not find tokens in.
      return joinPath(homedir(), ".bb", "plugins", "orchestrator");
    }
  };
  /** `bb environment show <id> --json` — the env's own facts (§4.1,
   * §14). Shared by `environmentOf` below and release's copy lookup
   * (PLUG-229): an SDK thread has `environmentId` only, so
   * `releaseThreadsGet` fills `environmentPath`/`environmentBranchName`
   * from here — for the executor's copy and, on a merged round, the
   * coordinator's. */
  const environmentFacts = (envId: string) =>
    runJson<{
      id?: string;
      path?: string;
      branchName?: string;
      mergeBaseBranch?: string | null;
      baseBranch?: string | { name?: string } | null;
    }>(bbCli, ["environment", "show", envId, "--json"]);
  const releaseDeps = {
    store,
    bbCli,
    cmd,
    localHostId,
    threads: {
      get: releaseThreadsGet(
        (a: { threadId: string }) => bb.sdk.threads.get(a),
        environmentFacts,
      ),
      send: (a: never) => bb.sdk.threads.send(a) as never,
      output: (a: { threadId: string }) =>
        bb.sdk.threads.output(a) as never,
      events: {
        list: (a: never) => bb.sdk.threads.events.list(a) as never,
      },
    },
    stepsDeps,
    loadPolicy: async () => policyLoad,
    loadReleaseConfig: () => releaseConfig,
    probes,
    hooksDir: () => joinPath(pluginDataDir(), "git-hooks"),
    packetDir: () => joinPath(pluginDataDir(), "release-audit"),
    // §17.3 (С1): only the release-auditor dispatch goes through the
    // delegate queue — the outer release flow runs outside it.
    enqueue,
    commandRunner,
    commandRetentionDays: () =>
      positiveInt(currentSettings.retentionDays, 30),
    // PLUG-245 Б2: владелец замков копии postPublish — этот экземпляр.
    instanceId: `orch-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    log: bb.log,
    t,
  };
  // §18.1 (PLUG-247a): an installed pre-push is language-versioned —
  // sync it at startup too (a plugin update may have added MESSAGES).
  try {
    syncInstalledPrePush(releaseDeps.hooksDir(), t);
  } catch (e) {
    bb.log.warn(`orchestrator: pre-push sync: ${describeError(e)}`);
  }
  const pumpRelease = () =>
    pumpReleases(releaseDeps).catch((e) =>
      bb.log.warn(`orchestrator release pump: ${describeError(e)}`),
    );

  /**
   * A thread's worktree: `threads.get` gives the environment id, `bb
   * environment show` its facts (§4.1, §14). Shared by the watchdog's
   * round-result reader and `merge`'s coordinator copy.
   */
  const environmentOf = async (threadId: string) => {
    const t = (await bb.sdk.threads.get({ threadId })) as {
      environmentId?: string | null;
    };
    if (!t.environmentId) return null;
    const env = await environmentFacts(t.environmentId);
    const mergeBase =
      env.mergeBaseBranch ??
      (typeof env.baseBranch === "string"
        ? env.baseBranch
        : (env.baseBranch?.name ?? null));
    return {
      id: env.id ?? t.environmentId,
      path: env.path,
      branchName: env.branchName,
      mergeBaseBranch: mergeBase,
    };
  };

  // §14 merge — deliberately NOT on the `delegate` queue (§16.8): the
  // autofix path calls `delegate`, which is queued itself; queuing the
  // outer merge would deadlock. The per-copy lock lives in merge.ts.
  const mergeDelegation = (input: {
    ref: string;
    into?: string;
    noAutofix?: boolean;
    dryRun?: boolean;
    callerThreadId: string;
  }) =>
    runMerge(input, {
      store,
      bbCli,
      git: async (repo, args, opts) => {
        const res = await cmd.run("git", ["-C", repo, ...args], {
          timeoutMs: opts?.timeoutMs,
        });
        return {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
        };
      },
      environment: environmentOf,
      // §14: a deleted executor environment (404) answers null — the
      // §16.2 check is skipped, a gone copy's result cannot change.
      environmentById: async (envId) => {
        try {
          const env = await runJson<{ path?: string }>(bbCli, [
            "environment",
            "show",
            envId,
            "--json",
          ]);
          return { path: env.path };
        } catch (e) {
          if (isEnvironmentGone(e)) return null;
          throw e;
        }
      },
      threads: {
        send: (a) => bb.sdk.threads.send(a as never) as Promise<unknown>,
      },
      delegate: (d) =>
        delegate({ ...d, threadId: input.callerThreadId }),
      // §17.2 (e2e 1): BB's notice can outrun the watchdog's `done` —
      // merge forces the row's sync before judging its status.
      syncRow: (row) => watchdog.syncDelegation(row),
      // §17.2 r26 (PLUG-211 Б3): a task ref resolves by the newest
      // EXECUTOR delegation — review/release-audit rows share the
      // task's delegation list but are never merge targets.
      isExecutorLevel: (level) =>
        roleForLevel(level, policyLoad.policy) === "executor",
      // §17.3 (мелко 2): the protected list is the janitor's
      // `protectedBranches` setting, not the hardcoded default.
      protectedBranches:
        janitorConfig().config?.protectedBranches ?? undefined,
      mergeAutofix: () => currentSettings.mergeAutofix === true,
      // §16.6 `threadIds`: off → merge commits drop the task key.
      // §6 (r8) п.7: the settings project is the repository's bb
      // project; a resolver error or ambiguity counts `threadIds:
      // false` — stricter, never the delegation's project.
      releaseThreadIds: async (repoPath, projectId) => {
        if (!releaseConfig.config) return true;
        try {
          return resolveProject(
            releaseConfig.config,
            await settingsProjectId(
              { cmd, bbCli, localHostId },
              repoPath,
              projectId ?? "",
              releaseConfig.config,
            ),
          ).threadIds;
        } catch {
          return false;
        }
      },
      log: bb.log,
      t,
    });

  const watchdog = createWatchdog({
    t,
    store,
    bbCli,
    threads: watchdogThreads,
    // The §2 schedule keeps `policyLoad` fresh; the watchdog must not run
    // `bb tasks preset list` on every timer/event.
    loadPolicy: async () => policyLoad,
    dispatch: (row, opts) => dispatchToRoute(row, opts ?? {}, stepsDeps),
    finalize: (row) => finishDispatchSteps(row, stepsDeps),
    retrySetup: (row) => retrySetupSteps(row, stepsDeps),
    // §16.1: BB's own auto-retry queue via the CLI — `status` answers the
    // thread's pending retry rows, `cancel` drops them before an own stop.
    providerRetry: providerRetryCli(bbCli),
    round: {
      // §4.1: the executor's environment from its thread, then the env's
      // own facts via `bb environment show`.
      environment: environmentOf,
      git: async (repo, args) => {
        const res = await cmd.run("git", ["-C", repo, ...args]);
        if (res.exitCode !== 0) {
          throw new Error(
            `git ${args.join(" ")}: ${(res.stderr || res.stdout).trim()}`,
          );
        }
        return res.stdout;
      },
    },
    enqueue,
    handoffPath,
    log: bb.log,
  });

  let watchdogSubscribed = false;
  let serviceRunning = false;
  bb.background.service("orchestrator-watchdog", {
    start(signal) {
      // `bb.events.on` has no unsubscribe: handlers check the flag, so a
      // stopped service is inert even though registrations stay.
      const run = (p: Promise<unknown>) =>
        void p.catch((e) =>
          bb.log.warn(`orchestrator watchdog: ${describeError(e)}`),
        );
      const live = <T>(fn: () => Promise<T>): Promise<T | undefined> =>
        serviceRunning ? fn() : Promise.resolve(undefined);
      // `bb.events.on` has no unsubscribe; guard so a service crash
      // restart does not stack duplicate handlers.
      if (!watchdogSubscribed) {
        watchdogSubscribed = true;
        bb.events.on("experimental_thread.events", (p) =>
          run(live(() => watchdog.onThreadEvents(p))),
        );
        bb.events.on("thread.active", ({ thread }) =>
          run(live(() => watchdog.onThreadActive(thread))),
        );
        bb.events.on("thread.idle", ({ thread }) =>
          run(live(() => watchdog.onThreadIdle(thread))),
        );
        bb.events.on("thread.failed", ({ thread, error }) =>
          run(live(() => watchdog.onThreadFailed(thread, error))),
        );
        bb.events.on("turn.failed", (e) => run(live(() => watchdog.onTurnFailed(e))));
        bb.events.on("interaction.pending", ({ thread, interaction }) =>
          run(live(() => watchdog.onInteractionPending(thread, interaction))),
        );
        bb.events.on("thread.archived", ({ thread }) =>
          run(live(() => watchdog.onThreadGone(thread, "archived"))),
        );
        bb.events.on("thread.deleted", ({ thread }) =>
          run(live(() => watchdog.onThreadGone(thread, "deleted"))),
        );
      }
      // §7: a reconcile pass at start, then every 60 s; the §5.1/§5.3
      // timers run on a shorter beat. Busy guards keep a slow pass from
      // piling up queued copies of itself.
      serviceRunning = true;
      let busy = false;
      const beat = (fn: () => Promise<unknown>) => {
        if (busy) return;
        busy = true;
        void live(fn)
          ?.catch((e) =>
            bb.log.warn(`orchestrator watchdog: ${describeError(e)}`),
          )
          .finally(() => {
            busy = false;
          });
      };
      beat(async () => {
        await watchdog.reconcile();
        await pumpRelease();
      });
      maybeCheckPresets();
      const reconcileTimer = setInterval(() => {
        beat(async () => {
          await watchdog.reconcile();
          await pumpRelease();
        });
        maybeCheckPresets();
      }, 60_000);
      const timersTimer = setInterval(
        () =>
          beat(async () => {
            await watchdog.checkTimers();
            await pumpRelease();
          }),
        5_000,
      );
      return new Promise<void>((resolve) => {
        const stop = () => {
          serviceRunning = false;
          clearInterval(reconcileTimer);
          clearInterval(timersTimer);
          // §18.2: живым группам SIGTERM, записи — interrupted.
          void commandRunner.stopAll();
          // §18.5: замки копий postPublish не переживают экземпляр.
          releaseAllPostPublishLocks();
          resolve();
        };
        if (signal.aborted) {
          stop();
          return;
        }
        signal.addEventListener("abort", stop);
      });
    },
  });

  // ── Janitor (§15) ──────────────────────────────────────────────────
  //
  // A second background service: the watchdog owns delegation lifecycle,
  // the janitor owns disk. It ticks every minute and runs a pass when the
  // configured interval elapsed; the first pass goes right away so a
  // plugin restart never postpones a due cleanup.
  const janitor = createJanitor({
    store,
    janitor: janitorStore,
    bbCli,
    cmd,
    threads: {
      send: (a) => bb.sdk.threads.send(a as never) as never,
      // §17.4 (С7): paged SDK list — the one-shot CLI dump overflowed
      // its buffer at ~5700 threads. No `count`: the SDK wrapper drops
      // includeArchived/includeHidden, so the janitor proves the list
      // by reading it twice and comparing id sets (PLUG-213).
      list: (a) => bb.sdk.threads.list(a) as Promise<unknown>,
    },
    loadConfig: janitorConfig,
    localHostId,
    log: bb.log,
    t,
  });
  let janitorBusy = false;
  let lastJanitorRunAt = 0;
  const janitorTick = () => {
    const cfg = janitorConfig().config;
    if (!cfg?.enabled || janitorBusy) return;
    if (now() - lastJanitorRunAt < cfg.intervalMinutes * 60_000) return;
    janitorBusy = true;
    lastJanitorRunAt = now();
    void janitor
      .run()
      .catch((e) =>
        bb.log.warn(`orchestrator janitor: ${describeError(e)}`),
      )
      .finally(() => {
        janitorBusy = false;
      });
  };
  // §16.4: while the service runs, an archived executor with a dirty
  // copy gets a rescue ref before BB frees it (the ~5-minute window).
  let janitorLive = false;
  let janitorSubscribed = false;
  bb.background.service("orchestrator-janitor", {
    start(signal) {
      // A plugin restart must not replay a due-early pass: the last run's
      // timestamp survives in janitor_runs.
      lastJanitorRunAt = Math.max(
        lastJanitorRunAt,
        janitorStore.latestRun()?.started_at ?? 0,
      );
      // `bb.events.on` has no unsubscribe; guard so a service restart
      // does not stack duplicate handlers.
      if (!janitorSubscribed) {
        janitorSubscribed = true;
        bb.events.on("thread.archived", ({ thread }) =>
          void (janitorLive
            ? janitor.onThreadArchived(thread)
            : Promise.resolve(undefined)
          ).catch((e) =>
            bb.log.warn(`orchestrator janitor: ${describeError(e)}`),
          ),
        );
        // §16.4 r29: the same rescue on `thread.deleted` — BB retires
        // the copy identically (~5 min after the first of the two
        // events), the reason word is the only difference.
        bb.events.on("thread.deleted", ({ thread }) =>
          void (janitorLive
            ? janitor.onThreadDeleted(thread)
            : Promise.resolve(undefined)
          ).catch((e) =>
            bb.log.warn(`orchestrator janitor: ${describeError(e)}`),
          ),
        );
      }
      const timer = setInterval(janitorTick, 60_000);
      janitorLive = true;
      janitorTick();
      return new Promise<void>((resolve) => {
        const stop = () => {
          janitorLive = false;
          clearInterval(timer);
          resolve();
        };
        if (signal.aborted) {
          stop();
          return;
        }
        signal.addEventListener("abort", stop);
      });
    },
  });

  // ── RPC (§13.2 п.1): the composer's «Роль» picker. ─────────────────
  // `projectId = null` is a projectless compose — the default role
  // applies and nothing is stored.
  bb.rpc.register(rpcContract, pendingRoleRpc(store));

  // ── Agent tools (§6): coordinators only, via configure. ──────────────

  bb.agents.registerTool({
    name: "orchestrator_delegate",
    description: t("tool.delegate"),
    instructions: t("tool.delegateInstr"),
    parameters: z.object({
      taskKey: z.string().min(1).describe(t("tool.delTaskKey")),
      level: z
        .string()
        .min(1)
        .describe(t("tool.delLevel")),
      route: z
        .string()
        .optional()
        .describe(t("tool.delRoute")),
      preset: z
        .string()
        .optional()
        .describe(t("tool.delPreset")),
      instructions: z
        .string()
        .optional()
        .describe(t("tool.delInstructions")),
      from: z
        .string()
        .optional()
        .describe(t("tool.delFrom")),
      fresh: z
        .boolean()
        .optional()
        .describe(t("tool.delFresh")),
      noCode: z
        .boolean()
        .optional()
        .describe(t("cli.noCodeDescribe")),
    }),
    async execute(params, ctx) {
      try {
        const res = await delegate({ ...params, threadId: ctx.threadId });
        return JSON.stringify({
          ...res,
          // §2.3 (PLUG-182): `res.note` carries the reviewByLevel mapping
          // («review → review-medium по сложности…») — the reminder must
          // not overwrite it.
          reminder: t("cli.reminder"),
        });
      } catch (e) {
        return JSON.stringify(errorJson(e));
      }
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_status",
    description: t("tool.status"),
    parameters: z.object({
      all: z
        .boolean()
        .optional()
        .describe(t("tool.statusAll")),
    }),
    async execute(params, ctx) {
      try {
        const res = statusReport(
          params.all ? {} : { coordinatorThreadId: ctx.threadId },
        );
        return JSON.stringify({ ok: true, ...res });
      } catch (e) {
        return JSON.stringify(errorJson(e));
      }
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_cancel",
    description: t("tool.cancel"),
    parameters: z.object({
      target: z
        .string()
        .min(1)
        .describe(t("tool.cancelTarget")),
    }),
    async execute(params, _ctx) {
      try {
        return JSON.stringify(
          await cancelDelegation(params.target, _ctx.threadId),
        );
      } catch (e) {
        return JSON.stringify(errorJson(e));
      }
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_merge",
    description:
      "Merge a finished delegation round's result into your worktree (spec §14): checks, `git merge --no-ff`, a conflict-fix round when mergeAutofix is on.",
    instructions:
      "Call after checking the executor's result. Only the delegation's own coordinator may merge. Protected branches (main/master/dev) are refused — use `bb orchestrator release` for those. --dry-run checks for conflicts without touching the copy.",
    parameters: z.object({
      ref: z
        .string()
        .min(1)
        .describe("Task key (latest done delegation) or delegation id"),
      into: z
        .string()
        .optional()
        .describe("Target branch; defaults to the worktree's current branch"),
      noAutofix: z
        .boolean()
        .optional()
        .describe("Never delegate a conflict-fix round, even with mergeAutofix on"),
      dryRun: z
        .boolean()
        .optional()
        .describe("Checks + merge-tree only; the worktree stays untouched"),
    }),
    async execute(params, ctx) {
      try {
        return JSON.stringify(
          await mergeDelegation({ ...params, callerThreadId: ctx.threadId }),
        );
      } catch (e) {
        return JSON.stringify(errorJson(e));
      }
    },
  });

  const statusReport = (filter: { coordinatorThreadId?: string }) => {
    const delegations = store.list(filter);
    const counts = store.countsByStatus();
    return {
      active: store.activeCount(),
      counts,
      limits: policyLoad.policy?.limits ?? null,
      delegations,
      // §18.4: изменённые исполняемые настройки — имена и хеши,
      // без значений.
      execSettingsChanges: execSettingsChanges(store),
      // §18.6: предупреждение — ни верхний, ни defaults
      // `commitIdentity` не задан; подписи коммитов скан лишь
      // предупреждает (§4 r11), не блокирует.
      commitIdentityMissing:
        releaseConfig.config !== null &&
        commitIdentityMissing(releaseConfig.config),
    };
  };

  const cancelDelegation = async (ref: string, callerThreadId?: string) =>
    enqueue(async () => {
      const row = findDelegation(ref);
      if (!row) {
        throw new OrchestratorError(
          "not-found",
          t("cli.noDelegation", { ref }),
          t("cli.noDelegationHint"),
        );
      }
      // §6: from a thread, only the coordinator that owns this delegation.
      if (callerThreadId && callerThreadId !== row.coordinator_thread_id) {
        throw new OrchestratorError(
          "not-a-coordinator",
          `thread ${callerThreadId} is not the coordinator of delegation ${row.id}`,
          "only the delegating coordinator may cancel it",
        );
      }
      if (row.status !== "dispatching" && row.status !== "running") {
        throw new OrchestratorError(
          "not-active",
          `delegation ${row.id} is already ${row.status}`,
        );
      }
      // §6: a `dispatching` record without `thread_id` — the thread may
      // still exist (an uncertain spawn result); find it first so the
      // stop below can reach it — §4 r30 (е 4) the label lookup.
      let stopTarget = row.thread_id;
      let warning: string | undefined;
      if (!stopTarget && row.status === "dispatching") {
        try {
          stopTarget = await findDelegatedThreadId(row, {
            bbCli,
            threads: watchdogThreads,
          });
        } catch (e) {
          warning = `task thread lookup failed: ${describeError(e)}`;
        }
        if (stopTarget) store.setThreadInfo(row.id, stopTarget);
      }
      // Status first, stop second — otherwise our own stop can read as external.
      store.setStatus(row.id, "cancelled");
      // PLUG-224: the coordinator cancelled it — the §16.5 delivery
      // must not tail «исполнитель закончил без отчёта».
      store.addSetupError(
        row.id,
        "coordinator-cancel",
        callerThreadId ?? "cli",
      );
      if (stopTarget) {
        // §16.1/PLUG-184: the thread's queued BB auto-retry is cancelled
        // BEFORE our stop — otherwise it lifts the cancelled executor
        // back minutes later. A cancel failure does not block the user's
        // cancel; it surfaces as the warning.
        const cancelled = await cancelProviderRetries(
          providerRetryCli(bbCli),
          stopTarget,
        );
        if (cancelled !== true) {
          warning = `auto-retry cancel failed: ${cancelled}`;
        }
        try {
          await bb.sdk.threads.stop({ threadId: stopTarget });
        } catch (e) {
          warning = `thread stop failed: ${describeError(e)}`;
          store.addSetupError(row.id, "cancel-stop", warning);
        }
      }
      return {
        ok: true as const,
        delegationId: row.id,
        status: "cancelled" as const,
        ...(warning ? { warning } : {}),
      };
    });

  // ── CLI (§6) ─────────────────────────────────────────────────────────

  const jsonOk = (value: unknown) => ({
    exitCode: 0,
    stdout: JSON.stringify(value, null, 2) + "\n",
  });
  const jsonFail = (error: unknown) => ({
    exitCode: 1,
    stdout: JSON.stringify(errorJson(error), null, 2) + "\n",
  });
  const textFail = (error: unknown) => {
    const body = toErrorBody(error);
    return {
      exitCode: 1,
      stderr: `${body.code}: ${body.message}${body.hint ? `\nhint: ${body.hint}` : ""}\n`,
    };
  };
  const fail = (json: boolean, error: unknown) =>
    json ? jsonFail(error) : textFail(error);

  // §17.2 r26 (PLUG-215 мелко 2, PLUG-227): `notify-muted` and
  // `coordinator-cancel` setup_errors entries are state marks (the
  // quiet-stop mark awaiting the `auto` restore; the coordinator cancel
  // record suppressing «закончил без отчёта»), not setup failures;
  // render them under their own labels instead of inside `setup_errors`.
  const renderSetupErrors = (raw: string): string => {
    try {
      const entries = JSON.parse(raw) as {
        step?: string;
        message?: string;
      }[];
      if (!Array.isArray(entries)) return ` setup_errors=${raw}`;
      const errors = entries.filter(
        (e) => e?.step !== "notify-muted" && e?.step !== "coordinator-cancel",
      );
      const muted = entries.filter((e) => e?.step === "notify-muted");
      const cancelled = entries.filter((e) => e?.step === "coordinator-cancel");
      let out = errors.length
        ? ` setup_errors=${JSON.stringify(errors)}`
        : "";
      if (muted.length) {
        out +=
          ` notify-muted=${muted.at(-1)?.message ?? "?"}` +
          t("status.notifyMuted");
      }
      if (cancelled.length) {
        out +=
          ` coordinator-cancel=${cancelled.at(-1)?.message ?? "?"}` +
          t("status.coordCancel");
      }
      return out;
    } catch {
      return ` setup_errors=${raw}`;
    }
  };
  const renderDelegation = (d: DelegationRow) =>
    `#${d.id} ${d.task_key} level=${d.level} route=${d.route} status=${d.status}` +
    `${d.no_code ? " no-code" : ""}` +
    `${d.thread_id ? ` thread=${d.thread_id}` : ""} ` +
    `coordinator=${d.coordinator_thread_id}` +
    (d.setup_errors !== "[]" ? renderSetupErrors(d.setup_errors) : "");

  bb.cli.register({
    name: "orchestrator",
    summary: t("cli.helpSummary"),
    commands: [
      {
        name: "delegate",
        summary: t("cli.helpDelegateS"),
        usage:
          "bb orchestrator delegate <KEY> --level <level> [--route <route>|--preset <preset>] [--instructions <text>] [--from <sha|branch>] [--fresh] [--no-code] [--json]",
      },
      {
        name: "status",
        summary: t("cli.helpStatusS"),
        usage: "bb orchestrator status [--coordinator <thr>] [--all] [--json]",
      },
      {
        name: "show",
        summary: t("cli.helpShowS"),
        usage: "bb orchestrator show <delegationId|threadId> [--json]",
      },
      {
        name: "cancel",
        summary: t("cli.helpCancelS"),
        usage: "bb orchestrator cancel <delegationId|threadId> [--json]",
      },
      {
        name: "merge",
        summary: t("cli.helpMergeS"),
        usage:
          "bb orchestrator merge <KEY|delegationId> [--into <branch>] [--no-autofix] [--dry-run] [--json]",
      },
      {
        name: "policy",
        summary: t("cli.helpPolicyS"),
        usage: "bb orchestrator policy [show|validate] [--json]",
      },
      {
        name: "instructions",
        summary: t("cli.helpInstructionsS"),
        usage: "bb orchestrator instructions",
      },
      {
        name: "reconcile",
        summary: t("cli.helpReconcileS"),
        usage: "bb orchestrator reconcile [--json]",
      },
      {
        name: "release",
        summary: t("cli.helpReleaseS"),
        usage: t("cli.releaseUsage"),
      },
      {
        name: "hooks-dir",
        summary: t("cli.helpHooksDirS"),
        usage: "bb orchestrator hooks-dir",
      },
      {
        name: "janitor",
        summary: t("cli.helpJanitorS"),
        usage: "bb orchestrator janitor [run|report] [--dry-run] [--json]",
      },
    ],
    async run(argv, ctx: PluginCliContext) {
      const json = argv.includes("--json");
      const flag = (name: string) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
      };
      const positional = argv.filter(
        (a, i) => !a.startsWith("--") && argv[i - 1] !== "--level" &&
          argv[i - 1] !== "--route" && argv[i - 1] !== "--preset" &&
          argv[i - 1] !== "--instructions" &&
          argv[i - 1] !== "--coordinator" && argv[i - 1] !== "--from" &&
          argv[i - 1] !== "--into" && argv[i - 1] !== "--no-docs" &&
          argv[i - 1] !== "--kb" && argv[i - 1] !== "--no-kb",
      );
      const cmd = positional[0];

      try {
        if (cmd === "delegate") {
          const taskKey = positional[1];
          const level = flag("--level");
          if (!taskKey || !level) {
            throw new OrchestratorError(
              "invalid-arguments",
              t("cli.delegateUsage"),
            );
          }
          const res = await delegate({
            taskKey,
            level,
            route: flag("--route"),
            preset: flag("--preset"),
            instructions: flag("--instructions"),
            from: flag("--from"),
            fresh: argv.includes("--fresh"),
            noCode: argv.includes("--no-code"),
            threadId: ctx.threadId,
          });
          return json
            ? jsonOk(res)
            : {
                exitCode: 0,
                stdout:
                  t("cli.delegated", {
                    taskKey: res.taskKey,
                    level: res.level,
                    route: res.route,
                    thread: res.threadId ?? "—",
                    id: res.delegationId,
                  }) +
                  (res.note
                    ? "\n" + t("cli.note", { note: res.note })
                    : "") +
                  (res.setupErrors.length
                    ? "\n" +
                      t("cli.setupErrors", {
                        list: res.setupErrors
                          .map((s) => `${s.step}: ${s.message}`)
                          .join("; "),
                      })
                    : "") +
                  "\n",
              };
        }

        if (cmd === "status") {
          const all = argv.includes("--all");
          const coordinator = flag("--coordinator");
          const filter =
            coordinator !== undefined
              ? { coordinatorThreadId: coordinator }
              : all
                ? {}
                : ctx.threadId
                  ? { coordinatorThreadId: ctx.threadId }
                  : {};
          const res = statusReport(filter);
          if (json) return jsonOk({ ok: true, ...res });
          let out = `active: ${res.active}` +
            (res.limits?.maxActive !== undefined
              ? `/${res.limits.maxActive}`
              : "") +
            `  counts: ${JSON.stringify(res.counts)}\n` +
            (res.execSettingsChanges.length
              ? t("status.execChanged", {
                  names: res.execSettingsChanges
                    .map((c) => c.key)
                    .join(", "),
                }) + "\n"
              : "") +
            (res.commitIdentityMissing
              ? t("status.noIdentity") + "\n"
              : "");
          for (const d of res.delegations) out += renderDelegation(d) + "\n";
          if (!res.delegations.length)
            out += t("status.noDelegations") + "\n";
          return { exitCode: 0, stdout: out };
        }

        if (cmd === "show") {
          const ref = positional[1];
          const row = ref && findDelegation(ref);
          if (!row) {
            throw new OrchestratorError(
              "not-found",
              t("cli.noDelegation", { ref: ref ?? "" }),
              t("cli.noDelegationHint"),
            );
          }
          return json
            ? jsonOk({ ok: true, delegation: row })
            : { exitCode: 0, stdout: renderDelegation(row) + "\n" };
        }

        if (cmd === "cancel") {
          const ref = positional[1];
          if (!ref) {
            throw new OrchestratorError(
              "invalid-arguments",
              t("cli.cancelUsage"),
            );
          }
          const res = await cancelDelegation(ref, ctx.threadId);
          return json
            ? jsonOk(res)
            : {
                exitCode: 0,
                stdout:
                  t("cli.cancelled", { id: res.delegationId }) +
                  (res.warning ? ` (${res.warning})` : "") +
                  "\n",
              };
        }

        if (cmd === "merge") {
          const ref = positional[1];
          if (!ref) {
            throw new OrchestratorError(
              "invalid-arguments",
              t("cli.mergeUsage"),
            );
          }
          if (!ctx.threadId) {
            throw new OrchestratorError(
              "no-caller-thread",
              t("cli.mergeNoThread"),
              t("cli.mergeNoThreadHint"),
            );
          }
          const res = await mergeDelegation({
            ref,
            into: flag("--into"),
            noAutofix: argv.includes("--no-autofix"),
            dryRun: argv.includes("--dry-run"),
            callerThreadId: ctx.threadId,
          });
          if (json) return jsonOk(res);
          if ("dryRun" in res) {
            return {
              exitCode: res.wouldConflict ? 1 : 0,
              stdout:
                t("cli.mergeOut", {
                  task: res.taskKey,
                  round: res.round,
                  into: res.into,
                  verdict: res.wouldConflict
                    ? t("cli.conflict", {
                        files: res.conflictFiles.slice(0, 10).join(", "),
                      })
                    : t("cli.clean"),
                }) +
                t("cli.mergeDrySuffix") +
                "\n",
            };
          }
          return {
            exitCode: 0,
            stdout:
              t("cli.mergeOut", {
                task: res.taskKey,
                round: res.round,
                into: res.into,
                verdict:
                  res.mergeStatus === "merged"
                    ? t("cli.merged", { sha: res.mergedSha?.slice(0, 7) ?? "" })
                    : res.mergeStatus === "fix-delegated"
                      ? t("cli.fixDelegated", {
                          id: res.fixDelegationId,
                          thread: res.fixThreadId ?? "—",
                        })
                      : t("cli.conflictClean"),
              }) +
              (res.warning ? `\nwarning: ${res.warning}` : "") +
              "\n",
          };
        }

        if (cmd === "policy") {
          const sub = positional[1] ?? "show";
          if (sub === "show") {
            const text = currentSettings.policy ?? "";
            if (json) {
              return jsonOk({
                ok: true,
                policy: policyLoad.policy,
                errors: policyLoad.errors,
                warnings: policyLoad.warnings,
                raw: text,
              });
            }
            let out =
              text.trim() ? text + "\n" : t("cli.policyEmpty") + "\n";
            for (const e of policyLoad.errors)
              out += `error ${e.path}: ${e.message}\n`;
            for (const w of policyLoad.warnings)
              out += `warning ${w.path}: ${w.message}\n`;
            return { exitCode: 0, stdout: out };
          }
          if (sub === "validate") {
            policyLoad = await loadPolicy(true);
            if (policyLoad.errors.length) {
              const e = policyLoad.errors[0]!;
              if (json) {
                return {
                  exitCode: 1,
                  stdout:
                    JSON.stringify(
                      {
                        ok: false,
                        error: {
                          code: "policy-invalid",
                          message: `${e.path}: ${e.message}`,
                          hint: "fix `bb plugin config orchestrator set policy …`",
                        },
                        errors: policyLoad.errors,
                        warnings: policyLoad.warnings,
                      },
                      null,
                      2,
                    ) + "\n",
                };
              }
              return {
                exitCode: 1,
                stderr:
                  `policy-invalid: ${e.path}: ${e.message}\n` +
                  policyLoad.errors
                    .slice(1)
                    .map((x) => `  ${x.path}: ${x.message}\n`)
                    .join(""),
              };
            }
            return json
              ? jsonOk({
                  ok: true,
                  warnings: policyLoad.warnings,
                  unavailableRoutes: policyLoad.unavailableRoutes,
                })
              : {
                  exitCode: 0,
                  stdout:
                    t("cli.policyValid") + "\n" +
                    policyLoad.warnings
                      .map((w) => `warning ${w.path}: ${w.message}\n`)
                      .join(""),
                };
          }
          throw new OrchestratorError(
            "invalid-arguments",
            t("cli.unknownPolicySub", { sub }),
          );
        }

        if (cmd === "instructions") {
          if (!policyLoad.policy) {
            throw new OrchestratorError(
              "policy-invalid",
              t("cli.cannotGenerate"),
              t("cli.cannotGenerateHint", {
                skill: skillSet(lang).setup,
              }),
            );
          }
          const text = generateRoutingRule(policyLoad.policy, t);
          return json
            ? jsonOk({ ok: true, instructions: text })
            : { exitCode: 0, stdout: text + "\n" };
        }

        if (cmd === "release") {
          const key = positional[1];
          if (!key) {
            throw new OrchestratorError(
              "invalid-arguments",
              t("cli.releaseUsageShort"),
            );
          }
          if (flag("--kb") && flag("--no-kb")) {
            throw new OrchestratorError(
              "invalid-arguments",
              t("cli.kbConflict"),
            );
          }
          if (!ctx.threadId) {
            throw new OrchestratorError(
              "no-caller-thread",
              t("cli.noCallerThread"),
            );
          }
          const caller = await callerFacts(ctx.threadId);
          // §17.3 (С1): release runs OUTSIDE the delegate queue — only
          // the release-auditor dispatch inside it is enqueued. A queued
          // release that internally dispatches would deadlock waiting
          // for its own queue slot.
          const res = await runRelease(
            {
              taskKey: key,
              caller,
              noDocs: flag("--no-docs"),
              kb: flag("--kb"),
              noKb: flag("--no-kb"),
            },
            releaseDeps,
          );
          return json
            ? jsonOk(res)
            : {
                exitCode: 0,
                stdout:
                  t("cli.releaseStarted", {
                    taskKey: res.taskKey,
                    id: res.releaseId,
                    thread: res.auditThreadId ?? "—",
                    settings: res.settingsProjectId,
                    delegation: res.delegationProjectId,
                  }) +
                  (res.warnings.length
                    ? t("cli.scanWarnings", {
                        list: res.warnings
                          .slice(0, 10)
                          .map(
                            (f) =>
                              `- ${f.file ?? ""}:${f.line ?? ""} ${f.problem}`,
                          )
                          .join("\n"),
                      })
                    : "") +
                  t("cli.releaseReminder"),
              };
        }

        if (cmd === "hooks-dir") {
          return { exitCode: 0, stdout: releaseDeps.hooksDir() + "\n" };
        }

        if (cmd === "reconcile") {
          const res = await watchdog.reconcile();
          return json
            ? jsonOk({ ok: true, ...res })
            : {
                exitCode: res.errors.length ? 1 : 0,
                stdout:
                  `reconcile: scanned=${res.scanned} cancelled=${res.cancelled} ` +
                  `relinked=${res.relinked} removed=${res.removed} ` +
                  `finalized=${res.finalized} retried=${res.retriedSteps}\n` +
                  res.errors.map((e) => `error: ${e}\n`).join(""),
              };
        }

        if (cmd === "janitor") {
          const sub = positional[1] ?? "report";
          const dryRun = argv.includes("--dry-run");
          if (sub === "run") {
            const cfgLoad = janitorConfig();
            if (cfgLoad.errors.length) {
              const e = cfgLoad.errors[0]!;
              throw new OrchestratorError(
                "janitor-invalid",
                `janitor config: ${e.path}: ${e.message}`,
                "fix `bb plugin config orchestrator set janitor '<json>'`",
              );
            }
            if (!cfgLoad.config?.enabled && !dryRun) {
              throw new OrchestratorError(
                "janitor-disabled",
                "the janitor is disabled (janitor.enabled is false)",
                'enable it via `bb plugin config orchestrator set janitor`' +
                  " (mode: report first), or run `bb orchestrator janitor run --dry-run`",
              );
            }
            if (janitorBusy) {
              throw new OrchestratorError(
                "janitor-busy",
                "a janitor pass is already running",
              );
            }
            janitorBusy = true;
            lastJanitorRunAt = now();
            try {
              const res = await janitor.run({ dryRun });
              // §17.4 (мелко 11): a refused pass is a recorded
              // failure, not a quiet skip — `janitor run` exits
              // non-zero so cron/a caller sees it; the run row in
              // the ledger carries the reason for `janitor report`.
              if (res.skipped === "unsupported-git") {
                throw new OrchestratorError(
                  "unsupported-git",
                  res.errors[0] ?? t("cli.gitTooOld"),
                );
              }
              const keptText = Object.entries(res.kept)
                .map(([r, n]) => `${r}=${n}`)
                .join(" ");
              return json
                ? jsonOk({ ok: true, ...res })
                : {
                    exitCode: 0,
                    stdout:
                      `janitor ${res.applied ? "apply" : "report"}: ` +
                      `removed ${res.removedCopies} copies, ` +
                      `${res.removedBranches} branches, ` +
                      `${res.archivedThreads} threads, ` +
                      `freed ${Math.round(res.freedKb / 1024)} MB, ` +
                      `ready ${res.ready}` +
                      (res.orphanBranches
                        ? `, orphan branches ${res.orphanBranches}`
                        : "") +
                      // §17.4 (ревью PLUG-220): what was removed, with
                      // the tip SHA to restore it — `git branch <name>
                      // <sha>` while gc keeps the objects.
                      (res.removedItems.length
                        ? `\nremoved:\n${res.removedItems
                            .map(
                              (i) =>
                                `  ${i.branch ?? i.envId} ${i.tipSha ?? "-"}` +
                                (i.headSha ? ` head ${i.headSha}` : "") +
                                (i.repo ? ` (${i.repo})` : ""),
                            )
                            .join("\n")}`
                        : "") +
                      // §17.4 (С9): «готова к удалению» is a list, not
                      // only a count — this is what `apply` removes.
                      (res.readyItems.length
                        ? `\nready to remove:\n${res.readyItems
                            .map(
                              (i) =>
                                `  ${i.envId} ${i.branch ?? "-"} ${i.path ?? "-"}`,
                            )
                            .join("\n")}`
                        : "") +
                      (keptText ? `
kept: ${keptText}` : "") +
                      (res.reported.length
                        ? `
abandoned: ${res.reported
                            .map(
                              (i) =>
                                `${i.branch ?? i.envId} (${i.reason}` +
                                (i.reason === "squash-suspect"
                                  ? t("cli.squashSuspect")
                                  : "") +
                                ")",
                            )
                            .join(", ")}`
                        : "") +
                      (res.errors.length
                        ? `\nerrors: ${res.errors.join("; ")}`
                        : "") +
                      "\n",
                  };
            } finally {
              janitorBusy = false;
            }
          }
          if (sub === "report") {
            const rep = await janitor.report();
            if (json) return jsonOk({ ok: true, ...rep });
            let out =
              `janitor: ${
                rep.config?.enabled
                  ? `enabled (${rep.config.mode})`
                  : "disabled"
              }\n` +
              (rep.lastRun
                ? `last run #${rep.lastRun.id}: ` +
                  `started ${new Date(rep.lastRun.started_at).toISOString()} ` +
                  `removed=${rep.lastRun.removed} kept=${rep.lastRun.kept} ` +
                  `freed=${Math.round(rep.lastRun.freed_kb / 1024)} MB` +
                  (rep.lastRun.error ? ` error=${rep.lastRun.error}` : "") +
                  "\n"
                : "no runs yet\n");
            // §17.4 (С9): «готова к удалению» — the report answers
            // what `apply` would remove, not only what is abandoned.
            if (rep.ready.length) {
              out += "ready to remove:\n";
              for (const i of rep.ready) {
                out += `  ${i.envId} ${i.branch ?? "-"} ${i.path ?? "-"}\n`;
              }
            }
            if (rep.abandoned.length) {
              out += "abandoned:\n";
              for (const i of rep.abandoned) {
                out += `  ${i.envId} ${i.branch ?? "-"} ${i.path ?? "-"} (${i.reason}` +
                  (i.reason === "squash-suspect"
                    ? t("cli.squashSuspect")
                    : "") +
                  ")\n";
              }
            }
            const kept = rep.items.filter((i) => i.state === "kept");
            if (kept.length) {
              out += "kept:\n";
              for (const i of kept.slice(0, 20)) {
                out += `  ${i.env_id} ${i.branch ?? "-"} (${i.reason ?? "-"})\n`;
              }
              if (kept.length > 20) out += `  ... and ${kept.length - 20} more\n`;
            }
            // §16.4 r29: the rescue ledger — saved work whose line
            // never reached a coordinator stays findable here. Rows
            // with notified=0 always show (ревью PLUG-240) — an
            // undelivered rescue must not scroll out of sight.
            if (rep.rescues.length) {
              out += "rescued work:\n";
              const shown = new Set([
                ...rep.rescues.filter((r) => !r.notified),
                ...rep.rescues.slice(-20),
              ]);
              for (const r of rep.rescues) {
                if (!shown.has(r)) continue;
                out +=
                  `  ${r.thread_id} ${r.ref ?? t("jn.snapFailed")} ` +
                  `${r.reason}` +
                  (r.repo_root ? ` (${r.repo_root})` : "") +
                  (r.notified ? "" : t("cli.notDelivered")) +
                  (r.error ? ` [${r.error}]` : "") +
                  "\n";
              }
              if (shown.size < rep.rescues.length) {
                out += `  ... and ${rep.rescues.length - shown.size} more\n`;
              }
            }
            return { exitCode: 0, stdout: out };
          }
          throw new OrchestratorError(
            "invalid-arguments",
            t("cli.unknownJanitorSub", { sub }),
          );
        }

        throw new OrchestratorError(
          "invalid-arguments",
          t("cli.unknownSub", { cmd: cmd ?? "" }),
          t("cli.commandsHint"),
        );
      } catch (e) {
        return fail(json, e);
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("bb-plugin-orchestrator disposed");
  });
}

export default async function plugin(bb: BbPluginApi) {
  await createPlugin(bb);
}
