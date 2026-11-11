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
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type StandardSchemaV1,
} from "@get-bb/plugin-sdk";
import { OrchestratorError, errorJson, toErrorBody } from "./src/errors.js";
import { parsePolicy, type PolicyLoad } from "./src/policy.js";
import { DelegationStore, MIGRATIONS, type DelegationRow } from "./src/store.js";
import {
  createBbCli,
  runChecked,
  runJson,
  type BbCli,
} from "./src/bb-cli.js";
import {
  buildAgentConfiguration,
  fallbackAgentConfiguration,
  type ExecutorProbes,
  type ThreadFacts,
} from "./src/agent-config.js";
import {
  DEFAULT_GIT_INSTRUCTIONS,
  generateRoutingRule,
  GIT_INSTRUCTIONS_MAX,
  gitInstructionsError,
  SETUP_HINT_TEXT,
} from "./src/instructions.js";
import {
  createDelegateQueue,
  dispatchToRoute,
  finishDispatchSteps,
  retrySetupSteps,
  runDelegate,
} from "./src/delegate.js";
import {
  createWatchdog,
  findTaskThreadId,
  type WatchdogThreads,
} from "./src/watchdog.js";
import {
  handleMessageDispatch,
  isRoleId,
  PICKABLE_ROLE_IDS,
  type RoleDecisionProbes,
  type RoleId,
} from "./src/roles.js";
import {
  parseReleaseConfig,
  type ReleaseConfigLoad,
} from "./src/release-config.js";
import { createCmd } from "./src/cmd.js";
import { pumpReleases, runRelease } from "./src/release.js";

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
}

const describeError = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

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
        "Release pipeline JSON (orchestrator-release §6): commitIdentity, defaults and per-project overrides (target, sync, checks, public, docsMap, leaks, excluded). Empty — `release` disabled.",
      experimental_multiline: true,
      default: "",
    },
    gitInstructions: {
      type: "string",
      label: "Git instructions",
      description:
        "«Работа с git» section (§2.2) prepended to every dispatch's --instructions. Empty disables the section.",
      experimental_multiline: true,
      experimental_schema: gitInstructionsSchema,
      default: DEFAULT_GIT_INSTRUCTIONS,
    },
  });

  let currentSettings = await settings.get();

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = new DelegationStore(db);
  const enqueue = createDelegateQueue();

  // The probes behind the §3 executor heuristics; one implementation for
  // `configure`, `delegate`, and the CLI caller check.
  const probes: ExecutorProbes = {
    delegationByThreadId: (threadId) => store.byThreadId(threadId),
    hasFreshDispatching: (freshSince, scope) =>
      store.hasFreshDispatching(freshSince, scope),
    roleByThreadId: (threadId) => store.threadRole(threadId)?.role,
  };

  // §13.2 п.1-2: the role decision's read side — synchronous SQLite only,
  // the `message.dispatch` hook may not call out anywhere.
  const roleProbes: RoleDecisionProbes = {
    threadRole: (threadId) => store.threadRole(threadId),
    pendingRole: (projectId) => store.pendingRole(projectId),
    activeDelegationByTaskKey: (taskKey) =>
      store.activeByTaskKey(taskKey),
  };

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
    if (!checkPresets) return parsePolicy(text);
    let knownPresets: Set<string> | undefined;
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
    } catch (e) {
      presetWarning = `preset check skipped: ${describeError(e)}`;
    }
    const load = parsePolicy(text, knownPresets);
    if (presetWarning) {
      load.warnings.push({ path: "policy", message: presetWarning });
    }
    return load;
  };

  // Structural validation only — nothing may block plugin load on the CLI.
  let policyLoad = parsePolicy(currentSettings.policy ?? "");
  let releaseConfig: ReleaseConfigLoad = parseReleaseConfig(
    currentSettings.release ?? "",
  );
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
        refreshStatus();
      })
      .catch(() => undefined)
      .finally(() => {
        presetCheckInFlight = false;
      });
  };

  const refreshStatus = () => {
    const first = policyLoad.errors[0];
    const gitError = gitInstructionsError(currentSettings.gitInstructions);
    let problem: string | null = null;
    if (first) {
      const rest =
        policyLoad.errors.length > 1
          ? ` (+${policyLoad.errors.length - 1} ещё)`
          : "";
      problem =
        `${first.path}: ${first.message}${rest} — ` +
        "исправьте `policy` и выполните `bb plugin reload orchestrator`";
    } else if (releaseConfig.errors.length) {
      const first = releaseConfig.errors[0]!;
      problem =
        `release: ${first.path}: ${first.message}` +
        (releaseConfig.errors.length > 1
          ? ` (+${releaseConfig.errors.length - 1} ещё)`
          : "") +
        " — исправьте `release` и выполните `bb plugin reload orchestrator`";
    } else if (gitError) {
      problem =
        `${gitError} — исправьте ` +
        "`gitInstructions` и выполните `bb plugin reload orchestrator`";
    }
    // needs-configuration clears only on plugin reload (SDK V1), so the
    // message tells the user how to re-check after fixing the setting.
    if (problem) bb.status.needsConfiguration(`orchestrator: ${problem}`);
  };
  refreshStatus();
  maybeCheckPresets();

  settings.onChange((next) => {
    currentSettings = next;
    policyLoad = parsePolicy(currentSettings.policy ?? "");
    releaseConfig = parseReleaseConfig(currentSettings.release ?? "");
    refreshStatus();
    maybeCheckPresets();
  });

  const instructionsText = () =>
    policyLoad.policy
      ? generateRoutingRule(policyLoad.policy)
      : SETUP_HINT_TEXT;

  // §3: one configure handler, the choice delegated to agent-config.ts. A
  // throw inside must not silence the plugin (SDK fail-closed), so it falls
  // back to static facts and warns.
  bb.agents.configure((context) => {
    try {
      const config = buildAgentConfiguration(context, {
        injectInstructions: currentSettings.injectInstructions ?? true,
        instructionsText: instructionsText(),
        probes,
      });
      // §13.2 п.4: reflect the decided role into display metadata. The
      // hook itself may not touch the network, so the write rides on the
      // first session build after the decision — display-only either way.
      const decided = store.threadRole(context.thread.id)?.role;
      if (decided && context.pluginMetadata.role !== decided) {
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
    instructions?: string;
    from?: string;
    fresh?: boolean;
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
        threads: bb.sdk.threads,
        loadPolicy: () => loadPolicy(true),
        probes,
        gitInstructions: () => currentSettings.gitInstructions,
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
  const stepsDeps = {
    store,
    bbCli,
    threads: bb.sdk.threads,
    gitInstructions: () => currentSettings.gitInstructions,
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
      return "/tmp/bb-orchestrator";
    }
  };
  const releaseDeps = {
    store,
    bbCli,
    cmd,
    threads: {
      get: (a: { threadId: string }) =>
        bb.sdk.threads.get(a) as never,
      send: (a: never) => bb.sdk.threads.send(a) as never,
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
    log: bb.log,
  };
  const pumpRelease = () =>
    pumpReleases(releaseDeps).catch((e) =>
      bb.log.warn(`orchestrator release pump: ${describeError(e)}`),
    );

  const watchdog = createWatchdog({
    store,
    bbCli,
    threads: watchdogThreads,
    // The §2 schedule keeps `policyLoad` fresh; the watchdog must not run
    // `bb tasks preset list` on every timer/event.
    loadPolicy: async () => policyLoad,
    dispatch: (row, opts) => dispatchToRoute(row, opts ?? {}, stepsDeps),
    finalize: (row) => finishDispatchSteps(row, stepsDeps),
    retrySetup: (row) => retrySetupSteps(row, stepsDeps),
    round: {
      // §4.1: the executor's environment from its thread, then the env's
      // own facts via `bb environment show`.
      environment: async (threadId: string) => {
        const t = (await bb.sdk.threads.get({ threadId })) as {
          environmentId?: string | null;
        };
        if (!t.environmentId) return null;
        const env = await runJson<{
          id?: string;
          path?: string;
          branchName?: string;
          mergeBaseBranch?: string | null;
          baseBranch?: string | { name?: string } | null;
        }>(bbCli, ["environment", "show", t.environmentId, "--json"]);
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
      },
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
    description:
      "Delegate a bb task to an executor thread under the routing policy: dispatch, attach as hidden child, parent notifications, and setup in one call.",
    instructions:
      "Use orchestrator_delegate instead of running `bb tasks dispatch` + `bb thread update` by hand. The executor's report arrives as a message — finish your turn after delegating.",
    parameters: z.object({
      taskKey: z.string().min(1).describe("Task key, e.g. PLUG-129"),
      level: z
        .string()
        .min(1)
        .describe("Level name from the routing policy"),
      route: z
        .string()
        .optional()
        .describe("Route name within the level chain; defaults to the first available"),
      instructions: z
        .string()
        .optional()
        .describe("Extra instructions for this dispatch only"),
      from: z
        .string()
        .optional()
        .describe("Continue this round from an explicit sha or branch (§6 --from)"),
      fresh: z
        .boolean()
        .optional()
        .describe("Start the round without continuing the previous result (§6 --fresh)"),
    }),
    async execute(params, ctx) {
      try {
        const res = await delegate({ ...params, threadId: ctx.threadId });
        return JSON.stringify({
          ...res,
          note: "Ответ исполнителя придёт сообщением — закончи ход.",
        });
      } catch (e) {
        return JSON.stringify(errorJson(e));
      }
    },
  });

  bb.agents.registerTool({
    name: "orchestrator_status",
    description:
      "List this coordinator's delegations and counters (active vs policy limits).",
    parameters: z.object({
      all: z
        .boolean()
        .optional()
        .describe("Include delegations of all coordinators"),
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
    description:
      "Cancel a delegation: stop the executor thread and mark the record cancelled. Accepts a delegation id or thread id.",
    parameters: z.object({
      target: z
        .string()
        .min(1)
        .describe("Delegation id (number) or executor thread id (thr_…)"),
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

  const statusReport = (filter: { coordinatorThreadId?: string }) => {
    const delegations = store.list(filter);
    const counts = store.countsByStatus();
    return {
      active: store.activeCount(),
      counts,
      limits: policyLoad.policy?.limits ?? null,
      delegations,
    };
  };

  const cancelDelegation = async (ref: string, callerThreadId?: string) =>
    enqueue(async () => {
      const row = findDelegation(ref);
      if (!row) {
        throw new OrchestratorError(
          "not-found",
          `no delegation ${ref}`,
          "see `bb orchestrator status`",
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
      // §6: a `dispatching` record without `thread_id` — the thread the
      // tasks plugin attached after the record may still exist; find it
      // first so the stop below can reach it.
      let stopTarget = row.thread_id;
      let warning: string | undefined;
      if (!stopTarget && row.status === "dispatching") {
        try {
          stopTarget = await findTaskThreadId(
            bbCli,
            row.task_key,
            row.created_at,
          );
        } catch (e) {
          warning = `task thread lookup failed: ${describeError(e)}`;
        }
        if (stopTarget) store.setThreadInfo(row.id, stopTarget);
      }
      // Status first, stop second — otherwise our own stop can read as external.
      store.setStatus(row.id, "cancelled");
      if (stopTarget) {
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

  const renderDelegation = (d: DelegationRow) =>
    `#${d.id} ${d.task_key} level=${d.level} route=${d.route} status=${d.status}` +
    `${d.thread_id ? ` thread=${d.thread_id}` : ""} ` +
    `coordinator=${d.coordinator_thread_id}` +
    (d.setup_errors !== "[]" ? ` setup_errors=${d.setup_errors}` : "");

  bb.cli.register({
    name: "orchestrator",
    summary:
      "Delegate bb tasks to executor threads under the routing policy (spec: docs/specs/orchestrator.md)",
    commands: [
      {
        name: "delegate",
        summary: "Dispatch a task to an executor under the policy",
        usage:
          "bb orchestrator delegate <KEY> --level <level> [--route <route>] [--instructions <text>] [--from <sha|branch>] [--fresh] [--json]",
      },
      {
        name: "status",
        summary: "Delegations and counters",
        usage: "bb orchestrator status [--coordinator <thr>] [--all] [--json]",
      },
      {
        name: "show",
        summary: "One delegation by id or thread id",
        usage: "bb orchestrator show <delegationId|threadId> [--json]",
      },
      {
        name: "cancel",
        summary: "Stop the executor and mark the delegation cancelled",
        usage: "bb orchestrator cancel <delegationId|threadId> [--json]",
      },
      {
        name: "policy",
        summary: "Show or validate the configured policy",
        usage: "bb orchestrator policy [show|validate] [--json]",
      },
      {
        name: "instructions",
        summary: "Print the generated routing rule (§3)",
        usage: "bb orchestrator instructions",
      },
      {
        name: "reconcile",
        summary: "Force a reconciliation pass (watchdog stage)",
        usage: "bb orchestrator reconcile [--json]",
      },
      {
        name: "release",
        summary:
          "Deterministic publish pipeline (spec orchestrator-release §2)",
        usage:
          "bb orchestrator release <KEY> [--no-docs <причина>] [--kb <заметка>|--no-kb <причина>] [--json]",
      },
      {
        name: "hooks-dir",
        summary: "Directory of the shared pre-push hook + push token",
        usage: "bb orchestrator hooks-dir",
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
          argv[i - 1] !== "--route" && argv[i - 1] !== "--instructions" &&
          argv[i - 1] !== "--coordinator" && argv[i - 1] !== "--from",
      );
      const cmd = positional[0];

      try {
        if (cmd === "delegate") {
          const taskKey = positional[1];
          const level = flag("--level");
          if (!taskKey || !level) {
            throw new OrchestratorError(
              "invalid-arguments",
              "usage: bb orchestrator delegate <KEY> --level <level> [--route <r>] [--instructions <t>] [--from <sha|branch>] [--fresh]",
            );
          }
          const res = await delegate({
            taskKey,
            level,
            route: flag("--route"),
            instructions: flag("--instructions"),
            from: flag("--from"),
            fresh: argv.includes("--fresh"),
            threadId: ctx.threadId,
          });
          return json
            ? jsonOk(res)
            : {
                exitCode: 0,
                stdout:
                  `delegated ${res.taskKey}: level=${res.level} route=${res.route} thread=${res.threadId} (delegation #${res.delegationId})` +
                  (res.setupErrors.length
                    ? `\nsetup errors: ${res.setupErrors.map((s) => `${s.step}: ${s.message}`).join("; ")}`
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
            `  counts: ${JSON.stringify(res.counts)}\n`;
          for (const d of res.delegations) out += renderDelegation(d) + "\n";
          if (!res.delegations.length) out += "no delegations\n";
          return { exitCode: 0, stdout: out };
        }

        if (cmd === "show") {
          const ref = positional[1];
          const row = ref && findDelegation(ref);
          if (!row) {
            throw new OrchestratorError(
              "not-found",
              `no delegation ${ref ?? ""}`,
              "see `bb orchestrator status`",
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
              "usage: bb orchestrator cancel <delegationId|threadId>",
            );
          }
          const res = await cancelDelegation(ref, ctx.threadId);
          return json
            ? jsonOk(res)
            : {
                exitCode: 0,
                stdout: `cancelled delegation #${res.delegationId}` +
                  (res.warning ? ` (${res.warning})` : "") + "\n",
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
            let out = text.trim() ? text + "\n" : "(policy is empty)\n";
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
                    "policy is valid\n" +
                    policyLoad.warnings
                      .map((w) => `warning ${w.path}: ${w.message}\n`)
                      .join(""),
                };
          }
          throw new OrchestratorError(
            "invalid-arguments",
            `unknown policy subcommand "${sub}" (show|validate)`,
          );
        }

        if (cmd === "instructions") {
          if (!policyLoad.policy) {
            throw new OrchestratorError(
              "policy-invalid",
              "cannot generate the routing rule without a valid policy",
              "set it up via the `orchestrator-setup` skill (§2.1), then `bb orchestrator policy validate`",
            );
          }
          const text = generateRoutingRule(policyLoad.policy);
          return json
            ? jsonOk({ ok: true, instructions: text })
            : { exitCode: 0, stdout: text + "\n" };
        }

        if (cmd === "release") {
          const key = positional[1];
          if (!key) {
            throw new OrchestratorError(
              "invalid-arguments",
              "usage: bb orchestrator release <KEY> [--no-docs <причина>] [--kb <заметка>|--no-kb <причина>]",
            );
          }
          if (flag("--kb") && flag("--no-kb")) {
            throw new OrchestratorError(
              "invalid-arguments",
              "--kb и --no-kb несовместимы",
            );
          }
          if (!ctx.threadId) {
            throw new OrchestratorError(
              "no-caller-thread",
              "release works only from a bb thread (BB_THREAD_ID is absent)",
            );
          }
          const caller = await callerFacts(ctx.threadId);
          const res = await enqueue(() =>
            runRelease(
              {
                taskKey: key,
                caller,
                noDocs: flag("--no-docs"),
                kb: flag("--kb"),
                noKb: flag("--no-kb"),
              },
              releaseDeps,
            ),
          );
          return json
            ? jsonOk(res)
            : {
                exitCode: 0,
                stdout:
                  `release ${res.taskKey}: аудит запущен ` +
                  `(release #${res.releaseId}, тред ${res.auditThreadId ?? "—"})` +
                  (res.warnings.length
                    ? `
предупреждения скана:
${res.warnings
                        .slice(0, 10)
                        .map((f) => `- ${f.file ?? ""}:${f.line ?? ""} ${f.problem}`)
                        .join("\n")}`
                    : "") +
                  `
итог придёт сообщением [orchestrator] — закончи ход.
`,
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

        throw new OrchestratorError(
          "invalid-arguments",
          `unknown subcommand "${cmd ?? ""}"`,
          "commands: delegate, status, show, cancel, policy, instructions, reconcile",
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
