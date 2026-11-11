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
import { mergeDispatchInstructions, roundSection } from "./instructions.js";
import {
  BUILTIN_UNAVAILABLE_PATTERNS,
  pickRoute,
  type PolicyLoad,
} from "./policy.js";
import type { DelegationRow, DelegationStore } from "./store.js";
import { isCoordinator, type ExecutorProbes, type ThreadFacts } from "./agent-config.js";
import { roleForLevel } from "./roles.js";
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
  /** §6 `--from`: continue this round from an explicit sha/branch. */
  from?: string;
  /** §6 `--fresh`: no continuation — the round starts from the base. */
  fresh?: boolean;
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
    /** §13.2 п.4 display metadata; absent in tests that do not fake it. */
    updatePluginMetadata?(args: {
      threadId: string;
      set: { role: string };
    }): Promise<unknown>;
  };
  loadPolicy(): Promise<PolicyLoad>;
  probes: ExecutorProbes;
  dispatchTimeoutMs?: number;
  /** §2.2 git rules, read fresh at dispatch so edits and reissues see the
   * current setting. */
  gitInstructions?: () => string | undefined;
}

/**
 * Narrower deps for the post-insert steps: dispatch (§4.3), attach,
 * notifications, bypass, finalize, comment (§4.4–4.7). The watchdog's
 * reissue (§5.4) and reconcile (§7) call these without the §4.1–4.2 checks,
 * so later changes to the steps cover reissued threads too.
 */
export interface DispatchStepsDeps {
  store: DelegationStore;
  bbCli: BbCli;
  threads: DelegateDeps["threads"];
  dispatchTimeoutMs?: number;
  gitInstructions?: DelegateDeps["gitInstructions"];
}

export interface DispatchStepsResult {
  threadId: string | null;
  /** `cancelled` when the delegation was cancelled while dispatch ran. */
  status: "running" | "cancelled";
  setupErrors: SetupError[];
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

  // §4.1 rounds: every delegate is a new round. The round continues from
  // `--from`, else from the previous round's recorded result SHA; `--fresh`
  // disables continuation.
  const round = store.nextRound(taskKey);
  const continueFrom = params.fresh
    ? null
    : (params.from ?? store.latestResultByTask(taskKey)?.result_sha ?? null);

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
      round,
      continueFrom,
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

  // Steps 3–7 — shared with the watchdog's reissue (§5.4): the same
  // function dispatches, attaches, finalizes and reports.
  let res: DispatchStepsResult;
  try {
    res = await dispatchToRoute(row, { instructions: params.instructions }, deps);
  } catch (e) {
    // §5.3 rev 19: a synchronous refusal naming a removed model puts the
    // ROUTE on hold so the next dispatch skips it (the reissue path holds
    // and continues the chain from the watchdog).
    if ((e as { code?: string }).code === "dispatch-failed") {
      const patterns = [
        ...BUILTIN_UNAVAILABLE_PATTERNS,
        ...(route.unavailablePatterns ?? []),
      ];
      const text = message(e);
      if (patterns.some((p) => text.toLowerCase().includes(p.toLowerCase()))) {
        store.hold(
          routeName,
          Date.now() + 15 * 60 * 1000,
          `маршрут недоступен: ${text.slice(0, 180)}`,
        );
        throw new OrchestratorError(
          "dispatch-failed",
          `${text} — маршрут ${routeName} отмечен недоступным на 15 минут`,
          e instanceof OrchestratorError ? e.hint : undefined,
        );
      }
    }
    throw e;
  }

  return {
    ok: true,
    delegationId: row.id,
    taskKey: row.task_key,
    threadId: res.threadId,
    level: params.level,
    route: routeName,
    status: res.status,
    setupErrors: res.setupErrors,
  };
}

/**
 * §4 step 3 + steps 4–7 on an existing `dispatching` row: `bb tasks
 * dispatch`, record `thread_id`, attach, notifications, bypass, `running`,
 * «Раздано» comment. Also the reissue path (§5.4): the watchdog inserts the
 * `dispatching` row itself and calls this — no copied dispatch logic.
 *
 * An explicit dispatch failure deletes the row; a timeout or unreadable
 * answer leaves it `dispatching` without `thread_id` for the §7 reconcile
 * and throws `dispatch-unknown`.
 */
export async function dispatchToRoute(
  row: DelegationRow,
  opts: {
    instructions?: string;
    /**
     * What an explicit dispatch refusal does to the record. Default
     * `remove` (§4 step 3); `fail` marks it `failed` instead — the §7
     * reconcile uses it for `reissue_of` rows, which must never silently
     * vanish (§5.4 rev 13).
     */
    onDispatchFailure?: "remove" | "fail";
  },
  deps: DispatchStepsDeps,
): Promise<DispatchStepsResult> {
  const { store, bbCli } = deps;

  // §2.2: the «Работа с git» section leads --instructions, then «Заход N»
  // for continuation rounds (§4.1), then this call's extra instructions —
  // in this shared step they cover the §5.4 reissue path too.
  const instructions = mergeDispatchInstructions(
    deps.gitInstructions?.(),
    opts.instructions,
    row.continue_from
      ? roundSection(
          row.round,
          row.continue_from,
          store.resultBranchForSha(row.task_key, row.continue_from),
        )
      : undefined,
  );
  const dispatchArgs = [
    "tasks",
    "dispatch",
    row.task_key,
    "--preset",
    row.preset,
    ...(instructions ? ["--instructions", instructions] : []),
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
    if (opts.onDispatchFailure === "fail") {
      store.setStatus(row.id, "failed");
    } else {
      store.remove(row.id);
    }
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
  const linked = store.get(row.id) ?? row;

  const done = await finishDispatchSteps(linked, deps);
  return { threadId, status: done.status, setupErrors: done.setupErrors };
}

/**
 * §4 steps 4–6 on a `dispatching` row that already has `thread_id`: attach
 * (parent + hidden), `parentNotifications=auto`, best-effort `mode=bypass`,
 * `dispatching`→`running` (a cancel that landed meanwhile wins and the
 * created thread is stopped), «Раздано» comment. Errors land in
 * `setup_errors`; the §7 reconcile retries them.
 */
export async function finishDispatchSteps(
  row: DelegationRow,
  deps: DispatchStepsDeps,
): Promise<{ status: "running" | "cancelled"; setupErrors: SetupError[] }> {
  const { store, bbCli } = deps;
  const threadId = row.thread_id;
  if (!threadId) {
    throw new OrchestratorError(
      "internal-error",
      `delegation ${row.id} has no thread_id for the setup steps`,
    );
  }
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
      parentThreadId: row.coordinator_thread_id,
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

  // §4 step 4 / §13.2: record the executor's role — `review` level maps to
  // `auditor`, everything else to `executor`. The upsert corrects a role
  // the hook may already have guessed from the title alone; a corrected
  // role applies from the next session build. Display metadata mirrors it
  // (§13.2 п.4) — `thread_roles` stays the source of truth.
  const role = roleForLevel(row.level);
  try {
    store.setThreadRole(threadId, role, "delegate");
  } catch (e) {
    noteError("thread-role", e);
  }
  if (deps.threads.updatePluginMetadata) {
    try {
      await deps.threads.updatePluginMetadata({
        threadId,
        set: { role },
      });
    } catch (e) {
      noteError("role-metadata", e);
    }
  }

  await ensureBypassMode(row, noteError, deps);

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
      return { status: "cancelled", setupErrors };
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
      row.task_key,
      "--body",
      `Раздано: уровень ${row.level}, маршрут ${row.route}, тред ${threadId}`,
    ]);
  } catch (e) {
    noteError("comment", e);
  }

  return { status: "running", setupErrors };
}

/** §4 step 5 — best-effort `mode=bypass` for `permissionMode=full` presets. */
async function ensureBypassMode(
  row: DelegationRow,
  noteError: (step: string, e: unknown) => void,
  deps: DispatchStepsDeps,
): Promise<void> {
  const threadId = row.thread_id;
  if (!threadId) return;
  try {
    await ensureBypassModeOrThrow(row, threadId, deps);
  } catch (e) {
    noteError("bypass-mode", e);
  }
}

/**
 * Returns `true` when the step is settled for this delegation — the
 * preset is not `full`, or the session already reported its options
 * (mode set, already `bypass`, or `bypass` not offered). An empty options
 * list means the session is still building → `false`, retry next pass.
 */
async function ensureBypassModeOrThrow(
  row: DelegationRow,
  threadId: string,
  deps: DispatchStepsDeps,
): Promise<boolean> {
  const show = await runJson<{ preset?: { permissionMode?: string } }>(
    deps.bbCli,
    ["tasks", "preset", "show", row.preset, "--json"],
  );
  if (show.preset?.permissionMode !== "full") return true;
  const opts = await runJson<{
    options?:
      | {
          id?: string;
          name?: string;
          value?: unknown;
          values?: unknown[];
        }[]
      | null;
  }>(deps.bbCli, ["thread", "options", threadId, "--json"]);
  const options = opts.options ?? [];
  if (!options.length) return false; // §4.5: retry while options unseen
  const mode = options.find(
    (o) => o.id === "mode" || o.name === "mode",
  );
  const offers = (mode?.values ?? []).some((v) =>
    typeof v === "string" ? v === "bypass" : (v as { id?: string }).id === "bypass",
  );
  if (offers && mode?.value !== "bypass") {
    await runChecked(deps.bbCli, [
      "thread",
      "options",
      threadId,
      "--set",
      "mode=bypass",
    ]);
  }
  return true;
}

/**
 * §4.5 retries step 5 only while the session can still be building its
 * options — bounded by the delegation's age so reconcile does not spend
 * two CLI calls per row per minute forever.
 */
const BYPASS_RETRY_WINDOW_MS = 30 * 60 * 1000;

/**
 * §7 reconcile helper for `running` rows: retry the §4.4–4.6 steps that
 * `setup_errors` recorded as failed — plus step 5 while inside the retry
 * window (session options can be empty right after dispatch; the preset
 * check is the only cost). A successful attempt clears its recorded error.
 */
export async function retrySetupSteps(
  row: DelegationRow,
  deps: DispatchStepsDeps,
): Promise<SetupError[]> {
  const { store } = deps;
  const threadId = row.thread_id;
  if (!threadId) return [];

  let recorded: Set<string>;
  try {
    const parsed = JSON.parse(row.setup_errors) as { step?: string }[];
    recorded = new Set(
      (Array.isArray(parsed) ? parsed : [])
        .map((e) => e?.step)
        .filter((s): s is string => typeof s === "string"),
    );
  } catch {
    recorded = new Set();
  }

  const errors: SetupError[] = [];
  const attempt = async (step: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      store.clearSetupError(row.id, step);
    } catch (e) {
      store.clearSetupError(row.id, step);
      const msg = message(e);
      store.addSetupError(row.id, step, msg);
      errors.push({ step, message: msg });
    }
  };

  if (recorded.has("attach")) {
    await attempt("attach", () =>
      deps.threads.update({
        threadId,
        parentThreadId: row.coordinator_thread_id,
        visibility: "hidden",
      }),
    );
  }
  if (recorded.has("parent-notifications")) {
    await attempt("parent-notifications", () =>
      runChecked(deps.bbCli, [
        "thread",
        "update",
        threadId,
        "--parent-notifications",
        "auto",
      ]),
    );
  }
  // §4.5 "пока сессия не сообщит опции": retry while the options list is
  // empty — and stop for good once it reported (marked `bypass-settled`)
  // or the delegation outgrew the retry window.
  if (
    Date.now() - row.created_at < BYPASS_RETRY_WINDOW_MS &&
    !store.findSetupError(row, "bypass-settled")
  ) {
    try {
      if (await ensureBypassModeOrThrow(row, threadId, deps)) {
        store.addSetupError(row.id, "bypass-settled", "options reported");
        store.clearSetupError(row.id, "bypass-mode");
      }
    } catch (e) {
      const msg = message(e);
      store.clearSetupError(row.id, "bypass-mode");
      store.addSetupError(row.id, "bypass-mode", msg);
      errors.push({ step: "bypass-mode", message: msg });
    }
  }
  if (recorded.has("thread-role")) {
    await attempt("thread-role", async () => {
      store.setThreadRole(threadId, roleForLevel(row.level), "delegate");
    });
  }
  if (recorded.has("role-metadata") && deps.threads.updatePluginMetadata) {
    await attempt("role-metadata", () =>
      deps.threads.updatePluginMetadata!({
        threadId,
        set: { role: roleForLevel(row.level) },
      }),
    );
  }
  if (recorded.has("comment")) {
    await attempt("comment", () =>
      runChecked(deps.bbCli, [
        "tasks",
        "comment",
        row.task_key,
        "--body",
        `Раздано: уровень ${row.level}, маршрут ${row.route}, тред ${threadId}`,
      ]),
    );
  }
  if (recorded.has("cancel-stop")) {
    await attempt("cancel-stop", () => deps.threads.stop({ threadId }));
  }
  return errors;
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
