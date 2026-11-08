/**
 * `delegate` — one call instead of dispatch → thread update → options mode
 * (spec §4). Steps:
 *   1. policy/level/route/limits checks;
 *   2. INSERT the delegation as `dispatching` (the partial unique index is
 *      the double-dispatch guard);
 *   3. `bb tasks dispatch --json` → record `thread_id` at once;
 *   4. attach: `threads.update` (parent, hidden) + CLI `--parent-notifications auto`;
 *   5. best-effort `mode=bypass` for `permissionMode=full` presets;
 *   6. status `running` + task comment «Раздано: …»;
 *   7. return the delegation.
 * Steps 4–6 errors land in `setup_errors`; the delegation stays `running`
 * and the reconcile stage (later) retries them.
 */
import { OrchestratorError } from "./errors.js";
import { pickRoute, type PolicyLoad } from "./policy.js";
import type { DelegationStore } from "./store.js";
import { isCoordinator, type ExecutorProbes, type ThreadFacts } from "./agent-config.js";
import { runChecked, runJson, type BbCli } from "./bb-cli.js";

export interface SetupError {
  step: string;
  message: string;
}

export interface DelegateParams {
  taskKey: string;
  level: string;
  route?: string;
  instructions?: string;
  caller: ThreadFacts;
}

export interface DelegateResult {
  ok: true;
  delegationId: number;
  taskKey: string;
  threadId: string | null;
  level: string;
  route: string;
  /** `cancelled` when the delegation was cancelled while dispatch ran. */
  status: "running" | "cancelled";
  setupErrors: SetupError[];
}

interface DispatchResponse {
  threadId?: string;
  task?: { id?: string };
}

export interface DelegateDeps {
  store: DelegationStore;
  bbCli: BbCli;
  /** `bb.sdk.threads` — `update` for the attach step, `stop` for the
   * cancelled-during-dispatch cleanup. */
  threads: {
    update(args: {
      threadId: string;
      parentThreadId?: string | null;
      visibility?: "hidden" | "visible";
    }): Promise<unknown>;
    stop(args: { threadId: string }): Promise<unknown>;
  };
  loadPolicy(): Promise<PolicyLoad>;
  probes: ExecutorProbes;
  dispatchTimeoutMs?: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** bb task keys look like `PLUG-129`; anything else is resolved as a ULID. */
const TASK_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;

export async function runDelegate(
  params: DelegateParams,
  deps: DelegateDeps,
): Promise<DelegateResult> {
  const { store, bbCli } = deps;

  // Caller gate (§4): only a coordinator may delegate, even from a CLI shell
  // running inside an executor thread.
  if (!isCoordinator(params.caller, deps.probes)) {
    throw new OrchestratorError(
      "not-a-coordinator",
      `thread ${params.caller.threadId} is not a coordinator (has a parent or executor markers)`,
      "delegate is only available to coordinator threads",
    );
  }

  // §4 input: a task ULID resolves to its key before every check, so the
  // dedup index works on one canonical form.
  let taskKey = params.taskKey.trim();
  if (!TASK_KEY_RE.test(taskKey)) {
    const shown = await runJson<{ task?: { key?: string; id?: string } }>(
      bbCli,
      ["tasks", "show", taskKey, "--json"],
    ).catch((e) => {
      throw new OrchestratorError(
        "task-not-found",
        `cannot resolve task "${params.taskKey}": ${message(e)}`,
      );
    });
    if (!shown.task?.key) {
      throw new OrchestratorError(
        "task-not-found",
        `cannot resolve task "${params.taskKey}" to a key`,
      );
    }
    taskKey = shown.task.key;
  }
  taskKey = taskKey.toUpperCase();

  const load = await deps.loadPolicy();
  const policy = load.policy;
  if (!policy) {
    const first = load.errors[0];
    throw new OrchestratorError(
      "policy-invalid",
      `policy is not usable: ${first ? `${first.path}: ${first.message}` : "empty"}`,
      "fix it via `bb plugin config orchestrator set policy …`, then `bb orchestrator policy validate`",
    );
  }

  const held = store.heldGroups(Date.now());
  const { name: routeName, route } = pickRoute(policy, params.level, {
    requested: params.route,
    unavailableRoutes: new Set(load.unavailableRoutes),
    heldGroups: held,
  });

  // Limits (§4 step 1) — over the limit is a refusal, not a queue (§10).
  const maxActive = policy.limits?.maxActive;
  if (maxActive !== undefined) {
    const count = store.activeCount();
    if (count >= maxActive) {
      throw new OrchestratorError(
        "limit-exceeded",
        `active delegations ${count}/${maxActive}`,
        "wait for an active delegation to finish or raise limits.maxActive",
      );
    }
  }
  const perLevel = policy.limits?.perLevel?.[params.level];
  if (perLevel !== undefined) {
    const count = store.activeCountByLevel(params.level);
    if (count >= perLevel) {
      throw new OrchestratorError(
        "limit-exceeded",
        `active "${params.level}" delegations ${count}/${perLevel}`,
      );
    }
  }

  // Step 2 — the unique index makes this atomic across processes.
  let row;
  try {
    row = store.insert({
      taskKey,
      projectId: params.caller.projectId,
      coordinatorThreadId: params.caller.threadId,
      level: params.level,
      route: routeName,
      preset: route.preset,
      provider: route.provider,
    });
  } catch (e) {
    if (
      (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
      /UNIQUE constraint/.test(message(e))
    ) {
      throw new OrchestratorError(
        "task-already-delegated",
        `task ${taskKey} already has an active executor`,
        "use `bb orchestrator status` / `bb orchestrator cancel` first",
      );
    }
    throw e;
  }

  // Step 3 — dispatch through the tasks CLI. Only an explicit failure
  // (non-zero exit, not a timeout) removes the record: `bb tasks dispatch`
  // spawns the thread before it answers, so on a timeout or an unreadable
  // answer the executor may already exist and must stay tracked — the §7
  // reconcile finds it through `bb tasks threads`.
  const dispatchArgs = [
    "tasks",
    "dispatch",
    taskKey,
    "--preset",
    route.preset,
    ...(params.instructions ? ["--instructions", params.instructions] : []),
    "--json",
  ];
  const dispatchRes = await bbCli.run(dispatchArgs, {
    timeoutMs: deps.dispatchTimeoutMs ?? 120_000,
  });
  const unknownDispatch = () =>
    new OrchestratorError(
      "dispatch-unknown",
      `результат раздачи неизвестен (dispatch did not answer cleanly: exit ${dispatchRes.exitCode})`,
      "the delegation stays `dispatching`; the reconcile pass will link the thread or remove the record",
    );
  if (dispatchRes.exitCode !== 0 && !dispatchRes.timedOut) {
    store.remove(row.id);
    throw new OrchestratorError(
      "dispatch-failed",
      `bb tasks dispatch failed (exit ${dispatchRes.exitCode}): ${
        dispatchRes.stderr.trim() || dispatchRes.stdout.trim() || "no output"
      }`,
    );
  }
  if (dispatchRes.timedOut) throw unknownDispatch();
  let dispatch: DispatchResponse;
  try {
    dispatch = JSON.parse(dispatchRes.stdout.trim()) as DispatchResponse;
  } catch {
    throw unknownDispatch();
  }
  const threadId = dispatch.threadId;
  if (!threadId) throw unknownDispatch();
  store.setThreadInfo(row.id, threadId, dispatch.task?.id);

  const setupErrors: SetupError[] = [];
  const noteError = (step: string, e: unknown) => {
    const err = { step, message: message(e) };
    setupErrors.push(err);
    store.addSetupError(row.id, err.step, err.message);
  };

  // Step 4 — attach and wire parent notifications. The SDK type lacks
  // `parentNotifications` (SDK 0.4.87), so it goes through the CLI.
  try {
    await deps.threads.update({
      threadId,
      parentThreadId: params.caller.threadId,
      visibility: "hidden",
    });
  } catch (e) {
    noteError("attach", e);
  }
  try {
    await runChecked(bbCli, [
      "thread",
      "update",
      threadId,
      "--parent-notifications",
      "auto",
    ]);
  } catch (e) {
    noteError("parent-notifications", e);
  }

  // Step 5 — best-effort `mode=bypass` when the preset asks for full
  // permission. Session options may still be empty right after dispatch;
  // the reconcile pass repeats this until the session reports them.
  try {
    const show = await runJson<{ preset?: { permissionMode?: string } }>(
      bbCli,
      ["tasks", "preset", "show", route.preset, "--json"],
    );
    if (show.preset?.permissionMode === "full") {
      const opts = await runJson<{
        options?:
          | {
              id?: string;
              name?: string;
              value?: unknown;
              values?: unknown[];
            }[]
          | null;
      }>(bbCli, ["thread", "options", threadId, "--json"]);
      const mode = (opts.options ?? []).find(
        (o) => o.id === "mode" || o.name === "mode",
      );
      const offers = (mode?.values ?? []).some((v) =>
        typeof v === "string" ? v === "bypass" : (v as { id?: string }).id === "bypass",
      );
      if (offers && mode?.value !== "bypass") {
        await runChecked(bbCli, [
          "thread",
          "options",
          threadId,
          "--set",
          "mode=bypass",
        ]);
      }
    }
  } catch (e) {
    noteError("bypass-mode", e);
  }

  // Step 6 — `running` only from `dispatching`: a cancel that landed while
  // dispatch ran wins, and the executor it created is stopped here.
  if (!store.setStatusIf(row.id, "dispatching", "running")) {
    const current = store.get(row.id);
    if (current?.status === "cancelled") {
      try {
        await deps.threads.stop({ threadId });
      } catch (e) {
        noteError("cancel-stop", e);
      }
      return {
        ok: true,
        delegationId: row.id,
        taskKey: row.task_key,
        threadId,
        level: params.level,
        route: routeName,
        status: "cancelled",
        setupErrors,
      };
    }
    noteError(
      "finalize",
      new OrchestratorError(
        "internal-error",
        `delegation left 'dispatching' before step 6 (now '${current?.status ?? "missing"}')`,
      ),
    );
  }
  try {
    await runChecked(bbCli, [
      "tasks",
      "comment",
      taskKey,
      "--body",
      `Раздано: уровень ${params.level}, маршрут ${routeName}, тред ${threadId}`,
    ]);
  } catch (e) {
    noteError("comment", e);
  }

  // Step 7.
  return {
    ok: true,
    delegationId: row.id,
    taskKey: row.task_key,
    threadId,
    level: params.level,
    route: routeName,
    status: "running",
    setupErrors,
  };
}

/** Serialize delegate calls inside this process (§4): the unique index is
 * the cross-process guard, the chain makes same-process races impossible. */
export function createDelegateQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
