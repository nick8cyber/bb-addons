/**
 * The watchdog (spec §5) and the reconcile pass (§7). Event-driven: BB
 * lifecycle events (`thread.idle`, `thread.failed`, `turn.failed`,
 * `interaction.pending`, archive/delete) plus the executor's event stream
 * (`threads.events.list` after `last_seq`, kicked by
 * `experimental_thread.events`); a periodic `checkTimers` covers the
 * first-response window (§5.1) and `maxRunSeconds` (§5.3 timeout); a 60 s
 * `reconcile` re-checks everything and finishes half-done setup steps, so
 * a plugin restart loses nothing.
 *
 * Statuses transition status-first, then `threads.stop` (§5.3) — an own
 * stop must never read as an external interrupt. All entry points run
 * through the shared `enqueue` chain with `delegate`, so the watchdog,
 * `delegate` and `cancel` cannot interleave.
 */
import { OrchestratorError } from "./errors.js";
import {
  BUILTIN_UNAVAILABLE_PATTERNS,
  quotaGroupOf,
  quotaGroupsForOneOff,
  type PolicyLoad,
  type PolicyRoute,
} from "./policy.js";
import type { DelegationRow, DelegationStore } from "./store.js";
import {
  presetModelMap,
  runChecked,
  runJson,
  type BbCli,
} from "./bb-cli.js";
import type { DispatchStepsResult, SetupError } from "./delegate.js";

/** §5.2 built-in quota text patterns; `routes.*.quotaPatterns` extends. */
export const BUILTIN_QUOTA_PATTERNS = [
  "429",
  "rate limit",
  "quota",
  "usage limit",
  "free usage limit reached",
  "insufficient credits",
] as const;

/** §5.3: a start failure before the first turn reads as `unavailable`. */
const THREAD_START_FAILED = "thread.start failed";

/** §5.2 typed signal: `errorInfo.category` values that mean quota. */
const QUOTA_CATEGORIES = new Set(["rate-limit", "billing"]);
const QUOTA_HOLD_MS = 15 * 60 * 1000;
const APPROVAL_NOTIFY_MS = 10 * 60 * 1000;
const DISPATCH_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_FIRST_RESPONSE_SECONDS = 90;
const DEFAULT_MAX_RUN_SECONDS = 7200;
/** §16.5 `routes.*.startSeconds` — no turn for this long → one message. */
const DEFAULT_START_SECONDS = 600;
/** §16.5 `routes.*.idleSeconds` — response silence → one message. */
const DEFAULT_IDLE_SECONDS = 1800;
/** §16.5: the executor's report rides the result message under this cap. */
const RESULT_OUTPUT_CAP = 3000;
/** §16.5: BB is the primary outcome channel — its child-* notice gets
 * this long to reach the coordinator's journal before the plugin checks
 * the journal and sends its own line. */
const RESULT_BB_GRACE_MS = 120_000;
/** §16.5: the coordinator journal's compaction event (SDK `thread/compacted`). */
const COMPACTION_EVENT_TYPE = "thread/compacted";
/** §5.1 rev 18: the BB server rejects `events.list` pages over 100. */
const EVENT_PAGE_SIZE = 100;
/** Coverage kept from the 500×20 days: 100 pages × 100 events. */
const EVENT_MAX_PAGES = 100;

/**
 * §5.1 response events: `item/started` (except `userMessage`),
 * `item/completed`, text and reasoning deltas, `item/toolCall/progress`,
 * `item/commandExecution/outputDelta` — plus the sibling output deltas that
 * prove the executor is producing output. `item/started`/`item/completed`
 * are handled separately to drop `userMessage` items.
 */
const RESPONSE_EVENT_TYPES = new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/toolCall/progress",
  "item/mcpToolCall/progress",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  "item/delegation/progress",
  "item/delegation/completed",
]);

const ACTIVE = new Set(["dispatching", "running"]);
const isActive = (status: string) => ACTIVE.has(status);
/** §16.2: statuses a fresh `turn/started` revives to `running`. */
const REVIVABLE = new Set(["done", "failed", "cancelled"]);
/** §16.2: superseded statuses — a `turn/started` on them is a rogue turn
 * that is always stopped (auto-retry lifting an already-replaced round). */
const SUPERSEDED = new Set(["reissued", "stalled", "quota"]);
/** §16.2: the tasks plugin's comment fan-out prefix — a turn opened by
 * it is a notification wake, not a revive. */
const TRACKER_COMMENT_PREFIX = "New comment on task ";

/** §16.2: text of a `client/turn/requested` journal entry. */
const requestText = (e: WatchdogThreadEvent): string =>
  (
    ((e.data as { input?: { text?: string }[] } | null | undefined)?.input ??
      []) as { text?: string }[]
  )
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * §16.1 shared loop: drop the thread's queued BB auto-retry rows before
 * an own stop — an uncancelled retry lifts the thread back minutes
 * later. `no_pending_retry` means the row already fired between the
 * status read and the cancel — that is a drained queue, not a failure
 * (PLUG-184). A thread may hold more than one row (accepted and
 * unaccepted input), so status→cancel repeats until the queue reads
 * empty (≤3 cancels, one status re-read after each).
 */
export async function cancelProviderRetries(
  providerRetry:
    | {
        pending(threadId: string): Promise<unknown[]>;
        cancel(threadId: string): Promise<void>;
      }
    | undefined,
  threadId: string,
): Promise<true | string> {
  if (!providerRetry) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    let pending: unknown[];
    try {
      pending = await providerRetry.pending(threadId);
    } catch (e) {
      return `provider-retry status: ${message(e)}`;
    }
    if (pending.length === 0) return true;
    try {
      await providerRetry.cancel(threadId);
    } catch (e) {
      if (/no_pending_retry/i.test(message(e))) continue; // fired — re-read
      return `provider-retry cancel: ${message(e)}`;
    }
  }
  return "provider-retry: queue still non-empty after cancels";
}

/** §16.1: the `bb provider-retry status|cancel <id> --json` CLI seam —
 * shared by the watchdog deps and `orchestrator cancel`. */
export function providerRetryCli(
  bbCli: BbCli,
): NonNullable<WatchdogDeps["providerRetry"]> {
  return {
    pending: async (threadId) => {
      const res = await runJson<{ retries?: unknown[] }>(bbCli, [
        "provider-retry",
        "status",
        threadId,
        "--json",
      ]);
      return res.retries ?? [];
    },
    cancel: async (threadId) => {
      const res = await bbCli.run([
        "provider-retry",
        "cancel",
        threadId,
        "--json",
      ]);
      if (res.exitCode === 0) return;
      // The live CLI answers `no_pending_retry` with exit 1, the code in
      // the stdout JSON and the human sentence in stderr (PLUG-190) —
      // the row fired between status and cancel, i.e. a drained queue.
      try {
        const j = JSON.parse(res.stdout) as
          | { error?: { code?: unknown } }
          | null
          | undefined;
        if (j?.error?.code === "no_pending_retry") return;
      } catch {
        // not JSON — fall through to the text check
      }
      if (/no_pending_retry/i.test(`${res.stdout}\n${res.stderr}`)) return;
      throw new OrchestratorError(
        "bb-cli-failed",
        `bb provider-retry cancel ${threadId} failed (exit ` +
          `${res.exitCode}): ${
            res.stderr.trim() || res.stdout.trim() || "no output"
          }`,
      );
    },
  };
}

/** The thread DTO subset the watchdog reads (status + tombstones). */
export interface WatchdogThreadDto {
  id: string;
  status?: string | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
  /** §16.5 binding verify: the executor's parent link and notify mode. */
  parentThreadId?: string | null;
  parentNotifications?: string | null;
}

/** One stored event-stream row (subset of `ThreadEventRow`). */
export interface WatchdogThreadEvent {
  seq: number;
  type: string;
  createdAt: number;
  data?: Record<string, unknown> | null;
}

export interface WatchdogThreads {
  get(args: { threadId: string }): Promise<WatchdogThreadDto>;
  events: {
    list(args: {
      threadId: string;
      afterSeq?: string;
      order?: "asc" | "desc";
      limit?: string;
      types?: readonly string[];
    }): Promise<WatchdogThreadEvent[]>;
  };
  queuedMessages: {
    list(args: { threadId: string }): Promise<unknown[]>;
  };
  send(args: {
    threadId: string;
    mode: "queue-if-active";
    input: unknown[];
  }): Promise<unknown>;
  stop(args: { threadId: string }): Promise<unknown>;
  /** §16.5: the executor's own report text (`bb thread output`). */
  output(args: { threadId: string }): Promise<{ output?: string | null } | null>;
  /** §16.5 binding re-verify: re-apply parent + visibility on a drift. */
  update(args: {
    threadId: string;
    parentThreadId?: string | null;
    visibility?: string;
  }): Promise<unknown>;
}

/** The `turn.failed` lifecycle event fields the watchdog consumes. */
export interface TurnFailedInfo {
  threadId: string;
  errorInfo?: { category?: string | null } | null;
}

/** §4.1 round result: the executor environment facts the watchdog needs. */
export interface RoundEnvironment {
  id?: string | null;
  path?: string | null;
  branchName?: string | null;
  mergeBaseBranch?: string | null;
}

export interface ReconcileSummary {
  scanned: number;
  cancelled: number;
  relinked: number;
  removed: number;
  finalized: number;
  retriedSteps: number;
  errors: string[];
}

export interface WatchdogDeps {
  store: DelegationStore;
  bbCli: BbCli;
  threads: WatchdogThreads;
  loadPolicy(): Promise<PolicyLoad>;
  /**
   * §4 steps 3–7 on a fresh `dispatching` row (`dispatchToRoute`): the
   * reissue path reuses it so future changes to those steps cover
   * reissued threads too. Throws `dispatch-failed`/`dispatch-unknown`.
   * `onDispatchFailure: "fail"` keeps the record as `failed` instead of
   * deleting it — required for `reissue_of` rows (§5.4 rev 13).
   */
  dispatch(
    row: DelegationRow,
    opts?: { onDispatchFailure?: "remove" | "fail" },
  ): Promise<DispatchStepsResult>;
  /** §4 steps 4–6 on a `dispatching` row that already has `thread_id`. */
  finalize(
    row: DelegationRow,
  ): Promise<{ status: "running" | "cancelled"; setupErrors: SetupError[] }>;
  /** §7: retry failed §4.4–4.6 steps on a `running` row. */
  retrySetup(row: DelegationRow): Promise<SetupError[]>;
  /**
   * §16.1: BB's own provider auto-retry queue (`bb provider-retry
   * status|cancel <thread-id>`). `pending` answers the thread's queued
   * retry rows — a non-empty list means the thread's "failure" is a
   * transient the provider will retry itself, not an outcome.
   * `cancel` drops the queued retries before an own `threads.stop` —
   * an uncancelled retry would lift the thread back after the stop.
   * Optional: an absent seam reads as "no retry ever pending" (tests
   * that do not exercise §16.1 need no fake).
   */
  providerRetry?: {
    pending(threadId: string): Promise<unknown[]>;
    cancel(threadId: string): Promise<void>;
  };
  /**
   * §4.1 round result at `done`: resolve the executor's environment and
   * run git inside it. Optional — tests without a git seam skip the
   * collection entirely.
   */
  round?: {
    environment(threadId: string): Promise<RoundEnvironment | null>;
    git(repo: string, args: string[]): Promise<string>;
  };
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  now?: () => number;
  log?: {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };
}

/**
 * §6/§7 helper: the thread `bb tasks` attached to the task after the
 * delegation record was created — how a `dispatching` row without
 * `thread_id` (a timed-out or unreadable `bb tasks dispatch` answer) gets
 * its executor back.
 */
export async function findTaskThreadId(
  bbCli: BbCli,
  taskKey: string,
  createdAfter: number,
): Promise<string | null> {
  const res = await runJson<{
    taskThreads?: { threadId?: string; attachedAt?: string }[];
  }>(bbCli, ["tasks", "threads", taskKey, "--json"]);
  const candidates = (res.taskThreads ?? [])
    .filter((t): t is { threadId: string; attachedAt?: string } =>
      typeof t.threadId === "string",
    )
    .map((t) => ({
      id: t.threadId,
      at: t.attachedAt ? Date.parse(t.attachedAt) : Number.NaN,
    }))
    .filter((t) => Number.isFinite(t.at) && t.at >= createdAfter)
    .sort((a, b) => a.at - b.at);
  if (candidates[0]) return candidates[0].id;
  // A task thread exists but its `attachedAt` does not parse — taking it
  // is wrong less often than dispatching a duplicate executor (§5.4).
  // Dated entries that failed the `createdAfter` filter are proven OLDER
  // than the record and must never be picked.
  const undatable = (res.taskThreads ?? []).find(
    (t) =>
      typeof t.threadId === "string" &&
      !Number.isFinite(Date.parse(t.attachedAt ?? "")),
  );
  return undatable?.threadId ?? null;
}

export function createWatchdog(deps: WatchdogDeps) {
  const store = deps.store;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? {};
  /** `system/thread/interrupted` seen in the stream since the latest turn. */
  const interrupted = new Set<number>();
  /** Latest provider/system error text per delegation, for `failed` reports. */
  const lastErrorText = new Map<number, string>();

  const clearMarks = (id: number) => {
    interrupted.delete(id);
    lastErrorText.delete(id);
  };

  const matchesQuota = (text: string, patterns: readonly string[]) => {
    const hay = text.toLowerCase();
    return patterns.some((p) => hay.includes(p.toLowerCase()));
  };

  /**
   * §5.3 `unavailable`: a `thread.start failed` error while no turn ever
   * began, or the error text matching a removed-model pattern. Checked
   * after quota, before `failed`. "No turn began" is either an empty
   * `turn_started_at` or a pending resume (`resume-await` clears only when
   * a real turn starts — an interrupt before the first turn leaves the
   * start failure inside the unavailable gate).
   */
  const isUnavailable = (
    row: DelegationRow,
    text: string,
    patterns: readonly string[],
  ): boolean => {
    const hay = text.toLowerCase();
    if (
      (row.turn_started_at == null || hasSetupError(row, "resume-await")) &&
      hay.includes(THREAD_START_FAILED)
    ) {
      return true;
    }
    return patterns.some((p) => hay.includes(p.toLowerCase()));
  };

  /** Route facts from the live policy, falling back to the stored row. */
  const routeInfo = async (row: DelegationRow) => {
    const load = await deps.loadPolicy();
    const route = load.policy?.routes[row.route];
    // §2.3 r24 (PLUG-182): a `preset:` one-off is not in the policy
    // routes — a quota burn holds the quota group of every same-provider
    // AND same-model policy route plus the one-off's own name. The
    // `preset list` call is lazy (PLUG-186): only the quota path needs
    // the groups — pattern checks must not pay up to 15s per event.
    let cachedGroups: string[] | undefined;
    const quotaGroups = async (): Promise<string[]> => {
      if (cachedGroups) return cachedGroups;
      if (route) {
        cachedGroups = [quotaGroupOf(route, row.route)];
      } else if (row.route.startsWith("preset:")) {
        const models = await presetModelMap(deps.bbCli);
        cachedGroups = quotaGroupsForOneOff(
          load.policy,
          {
            route: row.route,
            provider: row.provider,
            modelId: models.get(row.preset),
          },
          models,
        );
      } else {
        cachedGroups = [row.route];
      }
      return cachedGroups;
    };
    return {
      load,
      policy: load.policy,
      level: load.policy?.levels[row.level],
      route,
      quotaGroups,
      patterns: [...BUILTIN_QUOTA_PATTERNS, ...(route?.quotaPatterns ?? [])],
      unavailablePatterns: [
        ...BUILTIN_UNAVAILABLE_PATTERNS,
        ...(route?.unavailablePatterns ?? []),
      ],
    };
  };

  const notifyCoordinator = async (row: DelegationRow, text: string) => {
    try {
      await deps.threads.send({
        threadId: row.coordinator_thread_id,
        mode: "queue-if-active",
        input: [
          { type: "text", text: `[orchestrator] ${text}`, mentions: [] },
        ],
      });
    } catch (e) {
      log.warn?.(`orchestrator: notify ${row.coordinator_thread_id}: ${message(e)}`);
    }
  };

  const commentOnTask = async (row: DelegationRow, text: string) => {
    try {
      await runChecked(deps.bbCli, [
        "tasks",
        "comment",
        row.task_key,
        "--body",
        text,
      ]);
    } catch (e) {
      log.warn?.(`orchestrator: comment on ${row.task_key}: ${message(e)}`);
    }
  };

  /** §5.3 `interrupted`: nudge the executor to resume its task. */
  const sendToExecutor = async (row: DelegationRow, text: string) => {
    if (!row.thread_id) return;
    try {
      await deps.threads.send({
        threadId: row.thread_id,
        mode: "queue-if-active",
        input: [
          { type: "text", text: `[orchestrator] ${text}`, mentions: [] },
        ],
      });
    } catch (e) {
      const msg = `resume send failed: ${message(e)}`;
      store.addSetupError(row.id, "resume-send", msg);
      log.warn?.(`orchestrator: resume to ${row.thread_id}: ${message(e)}`);
    }
  };

  const report = async (row: DelegationRow, text: string) => {
    await notifyCoordinator(row, text);
    await commentOnTask(row, text);
  };

  const hasSetupError = (row: DelegationRow, step: string) => {
    try {
      const parsed = JSON.parse(row.setup_errors) as { step?: string }[];
      return Array.isArray(parsed) && parsed.some((e) => e?.step === step);
    } catch {
      return false;
    }
  };

  /**
   * §16.1: the thread's pending BB auto-retry rows are cancelled before
   * an own stop or reissue — an uncancelled retry would lift the thread
   * back. Returns true when the queue is provably empty (or absent);
   * an error string when the status read or the cancel failed.
   */
  const ensureRetryCancelled = async (
    row: DelegationRow,
  ): Promise<true | string> => {
    if (!deps.providerRetry || !row.thread_id) return true;
    const res = await cancelProviderRetries(
      deps.providerRetry,
      row.thread_id,
    );
    if (res === true && hasSetupError(row, "provider-retry-pending")) {
      store.clearSetupError(row.id, "provider-retry-pending");
    }
    return res;
  };

  /**
   * §16.1 — the FIRST check of every outcome entry point: a pending BB
   * provider-retry row means the thread's "failure" is a queued automatic
   * retry, not an outcome. The delegation stays `running` (a premature
   * `failed` revives — the queued retry owes the thread a turn, §16.2)
   * and carries `provider-retry-pending`. Returns true when NO outcome
   * may be decided now — a retry is pending, or the queue could not be
   * read (unreadable is not "empty", same rule as the journal §5.1 rev 18).
   */
  const retryBlocksOutcome = async (
    row: DelegationRow,
  ): Promise<boolean> => {
    if (!deps.providerRetry || !row.thread_id) return false;
    let pending: unknown[];
    try {
      pending = await deps.providerRetry.pending(row.thread_id);
    } catch (e) {
      log.warn?.(
        `orchestrator: provider-retry status ${row.thread_id}: ${message(e)}`,
      );
      return true; // defer — the next pass re-checks
    }
    if (pending.length === 0) {
      if (hasSetupError(row, "provider-retry-pending")) {
        store.clearSetupError(row.id, "provider-retry-pending");
      }
      return false;
    }
    if (!hasSetupError(row, "provider-retry-pending")) {
      store.addSetupError(row.id, "provider-retry-pending", "auto-retry queued");
    }
    if (row.status === "failed") {
      // §16.2/PLUG-184: only the task's LAST round may revive — a queued
      // retry on a superseded executor must not lift it back. The
      // active-sibling check runs inside revive()'s transaction so the
      // partial unique index cannot trip mid-handler.
      if (
        store.hasNewerForTask(row.task_key, row.id) ||
        !store.revive(row.id)
      ) {
        const err = await ensureRetryCancelled(row);
        if (err !== true) {
          log.warn?.(
            `orchestrator: auto-retry cancel on superseded ${row.thread_id}: ${err}`,
          );
        }
      }
    }
    log.info?.(
      `orchestrator: delegation #${row.id} — provider-retry pending, stays running`,
    );
    return true;
  };

  /**
   * §5.4 rev 13: a reissue is allowed only after the old executor is
   * confirmed stopped — §16.1 cancels the thread's own auto-retry rows
   * first, `threads.stop` answered without an error AND the thread read
   * back `idle`/`error` (§16.5: only those two confirm an own stop).
   * Returns true when confirmed; on failure the `watchdog-stop` setup
   * error marks the row for the §7 retry.
   */
  const confirmStop = async (row: DelegationRow): Promise<boolean> => {
    const fail = async (why: string) => {
      const msg = `stop not confirmed: ${why}`;
      if (!hasSetupError(row, "watchdog-stop")) {
        store.addSetupError(row.id, "watchdog-stop", msg);
      }
      log.warn?.(`orchestrator: delegation #${row.id} ${msg}`);
      return false;
    };
    if (!row.thread_id) return true;
    // §16.1: BB's own auto-retry row is cancelled BEFORE our stop —
    // a failed cancel means the stop is not confirmed either.
    const cancelled = await ensureRetryCancelled(row);
    if (cancelled !== true) return fail(cancelled);
    try {
      await deps.threads.stop({ threadId: row.thread_id });
    } catch (e) {
      // A thread that no longer exists counts as stopped.
      if (/not.?found|does not exist|deleted|archiv/i.test(message(e))) {
        return true;
      }
      return fail(`threads.stop: ${message(e)}`);
    }
    let thread: WatchdogThreadDto | null;
    try {
      thread = await getThread(row.thread_id);
    } catch (e) {
      return fail(`threads.get: ${message(e)}`);
    }
    // §16.5: only `idle`/`error` (or a gone thread) confirms the stop —
    // `stopping`/`active`/anything else is retried by the §7 pass.
    if (!thread || thread.deletedAt || thread.archivedAt) return true;
    if (thread.status === "idle" || thread.status === "error") return true;
    return fail(`thread status is ${thread.status ?? "?"}, not stopped`);
  };

  // ── Outcomes (§5.3, §5.4) ────────────────────────────────────────────

  /** §5.4: report the outcome, and auto-reissue when the level allows. */
  const outcomeAndMaybeReissue = async (
    row: DelegationRow,
    outcome: "stalled" | "quota" | "unavailable" | "failed",
    detail: string,
  ) => {
    const info = await routeInfo(row);
    const outcomeText =
      outcome === "stalled"
        ? "исполнитель завис"
        : outcome === "unavailable"
          ? detail
            ? `маршрут недоступен (${detail.slice(0, 120)})`
            : "маршрут недоступен"
          : outcome === "failed"
            ? detail
              ? `исполнитель завершился с ошибкой (${detail.slice(0, 120)})`
              : "исполнитель завершился с ошибкой"
            : detail
              ? `квота исполнителя исчерпана (${detail.slice(0, 120)})`
              : "квота исполнителя исчерпана";
    // §16.1: no reissue while the thread's own auto-retry is uncancelled
    // — the queued retry would lift the reissued-away thread back. A
    // cancel failure is a stop-not-confirmed: the §7 retry loop covers
    // it and the coordinator hears about it exactly once.
    const cancelled = await ensureRetryCancelled(row);
    if (cancelled !== true) {
      const current = store.get(row.id) ?? row;
      if (!hasSetupError(current, "watchdog-stop")) {
        store.addSetupError(
          row.id,
          "watchdog-stop",
          `stop not confirmed: ${cancelled}`,
        );
      }
      if (!hasSetupError(current, "watchdog-stop-reported")) {
        store.addSetupError(row.id, "watchdog-stop-reported", "coordinator notified");
        await report(
          row,
          `${outcomeText}: задача ${row.task_key}, маршрут ${row.route} — ` +
            `не удалось отменить автоповтор исполнителя (${cancelled}), ` +
            `перевыпуска нет, сверка повторит`,
        );
      }
      return;
    }
    let nextName: string | undefined;
    let nextRoute: PolicyRoute | undefined;
    if (info.level?.autoFallback && info.policy) {
      // §5.4 rev 13 + §16.8/§2.3 (PLUG-182): for a natural chain route the
      // candidates are the routes AFTER the current one (only routes an
      // auto-reissue already used are excluded — `reissue_of IS NOT
      // NULL`). An explicit --route/--preset delegation restarts from the
      // chain's beginning and skips every route this task already ran on.
      const held = store.heldGroups(now());
      const unavailable = new Set(info.load.unavailableRoutes);
      const idx = info.level.chain.indexOf(row.route);
      const restart = idx === -1 || row.explicit_route !== 0;
      const candidates = restart
        ? info.level.chain
        : info.level.chain.slice(idx + 1);
      const used = restart
        ? new Set(
            store.delegationsByTask(row.task_key).map((r) => r.route),
          )
        : store.routesUsedByTask(row.task_key);
      for (const name of candidates) {
        const r = info.policy.routes[name];
        if (!r || used.has(name) || unavailable.has(name)) continue;
        // §5.2 holds sit on quota groups, §5.3 `unavailable` on route
        // names — a candidate is out when either is held.
        if (held.has(name) || held.has(quotaGroupOf(r, name))) continue;
        nextName = name;
        nextRoute = r;
        break;
      }
    }
    if (nextName && nextRoute) {
      // §5.4 rev 15: the task may already carry an active delegation (the
      // coordinator re-delegated manually while the stop retried) — the
      // unique index then refuses the insert; the row keeps its outcome
      // status and the coordinator hears about it exactly once.
      let fresh: DelegationRow | undefined;
      try {
        fresh = store.reissue(row.id, {
          route: nextName,
          preset: nextRoute.preset,
          provider: nextRoute.provider,
        });
      } catch (e) {
        const current = store.get(row.id) ?? row;
        if (!hasSetupError(current, "reissue-conflict")) {
          store.addSetupError(row.id, "reissue-conflict", message(e));
          await report(
            row,
            `${outcomeText}: задача ${row.task_key}, маршрут ${row.route} — ` +
              `перевыпуск за координатором: у задачи уже есть активное ` +
              `делегирование`,
          );
        }
        return;
      }
      if (fresh) {
        try {
          const res = await deps.dispatch(fresh, {
            onDispatchFailure: "fail",
          });
          await report(
            row,
            `${outcomeText}: задача ${row.task_key}, маршрут ${row.route} → ` +
              `перевыпущено на ${nextName}, новый тред ${res.threadId ?? "—"}`,
          );
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (
            code === "dispatch-failed" &&
            (await dispatchRefusalIsUnavailable(fresh, message(e)))
          ) {
            return;
          }
          await report(
            row,
            code === "dispatch-failed"
              ? `${outcomeText}: задача ${row.task_key}, перевыпуск потерян — ` +
                  `раздача на ${nextName} отклонена (${message(e)})`
              : `${outcomeText}: задача ${row.task_key}, перевыпуск на ` +
                  `${nextName} не удался: ${message(e)}`,
          );
        }
        return;
      }
    }
    const reason = !info.level?.autoFallback
      ? "autoFallback выключен"
      : nextName
        ? "запись уже ушла из исхода"
        : "нет доступного маршрута в цепочке";
    await report(
      row,
      `${outcomeText}: задача ${row.task_key}, маршрут ${row.route} — ` +
        `перевыпуск за координатором (${reason})`,
    );
  };

  /**
   * §5.4 rev 13: without a confirmed stop there is no reissue — the status
   * stands, the coordinator hears about it once, and the §7 reconcile
   * retries the stop (rows with a `watchdog-stop` setup error).
   */
  const afterOutcomeStatus = async (
    row: DelegationRow,
    outcome: "stalled" | "quota" | "failed",
    detail: string,
  ) => {
    // §7: the outcome reason outlives the stop retry — the reissue report
    // needs it after `watchdog-stop` is already cleared.
    if (detail) store.addSetupError(row.id, "outcome-detail", detail);
    const outcomeText =
      outcome === "stalled"
        ? "исполнитель завис"
        : outcome === "failed"
          ? detail
            ? `исполнитель завершился с ошибкой (${detail.slice(0, 120)})`
            : "исполнитель завершился с ошибкой"
          : detail
            ? `квота исполнителя исчерпана (${detail.slice(0, 120)})`
            : "квота исполнителя исчерпана";
    if (await confirmStop(row)) {
      await outcomeAndMaybeReissue(row, outcome, detail);
      return;
    }
    // Message the coordinator once; the reconcile retry is silent.
    const current = store.get(row.id) ?? row;
    if (!hasSetupError(current, "watchdog-stop-reported")) {
      store.addSetupError(row.id, "watchdog-stop-reported", "coordinator notified");
      await report(
        row,
        `${outcomeText}: задача ${row.task_key}, маршрут ${row.route}, ` +
          `тред ${row.thread_id ?? "—"} — не удалось остановить исполнителя, ` +
          `перевыпуск отложен, сверка повторит`,
      );
    }
  };

  /**
   * §5.3 `interrupted`: a non-manual interruption is not a cancellation.
   * First time — resume the executor (`queue-if-active`), keep `running`,
   * notify the coordinator. A repeat interruption is treated like
   * `stalled`. Repeats are counted per outcome kind (r23): the
   * `interrupted-resume-sent` mark gates the interrupt repeat, the
   * `errored-resume-sent` mark the errored one — `resume_count` itself is
   * statistics only, so an errored resume does not burn the interrupt's
   * one retry (PLUG-176). Returns true when the delegation ended.
   */
  const handleInterrupted = async (
    row: DelegationRow,
    reason: string,
    at: number,
  ): Promise<boolean> => {
    const fresh = store.get(row.id);
    if (!fresh || fresh.status !== "running") return true;
    if (hasSetupError(fresh, "interrupted-resume-sent")) {
      await toStalled(fresh, `повторное прерывание хода (${reason})`);
      return true;
    }
    // §5.3 rev 15: the interrupt time opens the window for the NEW turn —
    // if none starts within `firstResponseSeconds`, the row is treated as
    // a repeat interruption. `resume-await` marks the wait; a following
    // idle must not read as `done` while the resume is still in flight.
    // `interrupted-resume-sent` is this outcome's own repeat mark (r23).
    store.bumpResume(fresh.id);
    store.setTurnStarted(fresh.id, at);
    store.addSetupError(fresh.id, "resume-await", reason);
    store.addSetupError(fresh.id, "interrupted-resume-sent", "1");
    await sendToExecutor(fresh, `ход прерван (${reason}), продолжай задачу`);
    await notifyCoordinator(
      fresh,
      `ход исполнителя прерван (${reason}): задача ${fresh.task_key}, ` +
        `маршрут ${fresh.route}, тред ${fresh.thread_id ?? "—"} — ` +
        `послал продолжение (resume #${fresh.resume_count + 1})`,
    );
    return false;
  };

  const toStalled = async (row: DelegationRow, detail: string) => {
    const fresh = store.get(row.id);
    if (!fresh || fresh.status !== "running") return;
    store.setStatus(fresh.id, "stalled"); // status first, stop second (§5.3)
    clearMarks(fresh.id);
    await afterOutcomeStatus(fresh, "stalled", detail);
  };

  const toQuota = async (row: DelegationRow, detail: string) => {
    const fresh = store.get(row.id);
    // A typed `turn.failed` category may upgrade a premature `failed`.
    if (!fresh || !(isActive(fresh.status) || fresh.status === "failed")) {
      return;
    }
    store.setStatus(fresh.id, "quota"); // status first, stop second (§5.3)
    clearMarks(fresh.id);
    const info = await routeInfo(fresh);
    for (const group of await info.quotaGroups()) {
      store.hold(group, now() + QUOTA_HOLD_MS, detail.slice(0, 200));
    }
    await afterOutcomeStatus(fresh, "quota", detail);
  };

  /**
   * §5.3 `unavailable` → `stalled` with the "route unavailable" reason.
   * The stop counts as confirmed — the executor never started — so §5.4
   * runs without `threads.stop`; the ROUTE (not the quota group) goes on
   * hold for 15 minutes.
   */
  const toUnavailable = async (row: DelegationRow, detail: string) => {
    const fresh = store.get(row.id);
    // A start-failure signal may upgrade a premature `failed` — same
    // precedence the typed quota category has (§5.3 before `failed`).
    if (!fresh || !(isActive(fresh.status) || fresh.status === "failed")) {
      return;
    }
    store.setStatus(fresh.id, "stalled"); // §5.3: unavailable lands as stalled
    clearMarks(fresh.id);
    const reason = `маршрут недоступен: ${detail.slice(0, 180)}`;
    store.hold(fresh.route, now() + QUOTA_HOLD_MS, reason);
    store.addSetupError(fresh.id, "outcome-detail", reason);
    await outcomeAndMaybeReissue(fresh, "unavailable", detail);
  };

  /**
   * §5.3 rev 19: a synchronous dispatch refusal naming a removed model is
   * the `unavailable` outcome too — hold the ROUTE, land the refused row
   * as `stalled` with the reason, and let §5.4 continue the chain to the
   * next route. Returns false when the refusal is an ordinary error.
   */
  const dispatchRefusalIsUnavailable = async (
    row: DelegationRow,
    text: string,
  ): Promise<boolean> => {
    const info = await routeInfo(row);
    if (
      !info.unavailablePatterns.some((p) =>
        text.toLowerCase().includes(p.toLowerCase()),
      )
    ) {
      return false;
    }
    const reason = `маршрут недоступен: ${text.slice(0, 180)}`;
    store.setStatus(row.id, "stalled");
    store.hold(row.route, now() + QUOTA_HOLD_MS, reason);
    store.addSetupError(row.id, "outcome-detail", reason);
    await outcomeAndMaybeReissue(store.get(row.id) ?? row, "unavailable", text);
    return true;
  };

  const toFailed = async (row: DelegationRow, errorText: string) => {
    const fresh = store.get(row.id);
    if (!fresh || !isActive(fresh.status)) return;
    store.setStatus(fresh.id, "failed"); // status first, stop second (§5.3)
    clearMarks(fresh.id);
    const info = await routeInfo(fresh);
    // §5.4 r23: `failed` reissues through the same confirmed-stop gate —
    // without it a dead executor stayed `failed` forever (503 UNAVAILABLE
    // on a review route was the live case that motivated ADR-0024).
    if (info.level?.autoFallback) {
      await afterOutcomeStatus(fresh, "failed", errorText);
      return;
    }
    // §16.1/PLUG-184: a final `failed` without autoFallback still owns a
    // stop — the queued BB auto-retry is cancelled first so the dead
    // executor cannot lift back; a failed cancel retries through the
    // §7 watchdog-stop loop.
    const cancelled = await ensureRetryCancelled(fresh);
    if (cancelled !== true) {
      store.addSetupError(
        fresh.id,
        "watchdog-stop",
        `stop not confirmed: ${cancelled}`,
      );
    }
    await report(
      fresh,
      `исполнитель завершился с ошибкой: задача ${fresh.task_key}, ` +
        `маршрут ${fresh.route}, тред ${fresh.thread_id ?? "—"} — ${errorText.slice(0, 300)}`,
    );
  };

  const toCancelled = async (row: DelegationRow, reason: string) => {
    const fresh = store.get(row.id);
    if (!fresh || !isActive(fresh.status)) return;
    store.setStatus(fresh.id, "cancelled");
    clearMarks(fresh.id);
    // §16.1/PLUG-184: a cancelled row's queued auto-retry would lift the
    // stopped thread back — drop it best-effort (the thread is already
    // gone or stopped, so a failure only logs).
    const retryCancel = await ensureRetryCancelled(fresh);
    if (retryCancel !== true) {
      log.warn?.(
        `orchestrator: cancelled #${fresh.id} auto-retry: ${retryCancel}`,
      );
    }
    // §5.3: comment, no reissue. The interrupt/archive/delete already
    // stopped the thread — nothing to stop.
    await commentOnTask(
      fresh,
      `делегирование отменено: ${reason} (задача ${fresh.task_key}, ` +
        `маршрут ${fresh.route}, тред ${fresh.thread_id ?? "—"})`,
    );
    // §16.5: cancelled delivers a result too — the same one-message
    // format as `done` («без отчёта» when the output is empty).
    const finished = store.get(fresh.id) ?? fresh;
    await collectRoundResult(finished);
    await deliverResult(finished);
  };

  // ── Event stream (§5.1) ──────────────────────────────────────────────

  const errorTextOf = (
    data: Record<string, unknown> | undefined | null,
  ): string | null => {
    if (!data) return null;
    const parts = [
      data.message,
      data.detail,
      data.code,
      (data.error as { message?: unknown } | undefined)?.message,
    ].filter((s): s is string => typeof s === "string" && s.length > 0);
    return parts.length ? parts.join(": ") : null;
  };

  /**
   * §5.1/§16.5: a response event sets the turn's first-response marker and
   * refreshes `last_response_at` (the `idleSeconds` clock). The DB write
   * is throttled — a delta stream fires far more often than the 30-minute
   * silence window needs.
   */
  const bumpResponse = (id: number, row: DelegationRow, at: number) => {
    store.setFirstResponse(id, at);
    if (row.last_response_at == null || at - row.last_response_at > 10_000) {
      store.setLastResponse(id, at);
      // §16.5/PLUG-184: a response after the silence notice re-arms it.
      store.clearSetupError(id, "idle-notified");
    }
  };

  /**
   * One stream event → delegation markers; returns true when the event
   * terminated the delegation (quota) and the batch should stop.
   */
  const applyStreamEvent = async (
    id: number,
    ev: WatchdogThreadEvent,
  ): Promise<boolean> => {
    const row = store.get(id);
    if (!row || !isActive(row.status)) return true;
    const data = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === "turn/started") {
      store.setTurnStarted(id, ev.createdAt);
      store.clearSetupError(id, "resume-await"); // the resumed turn began
      // §16.1: the queued provider retry materialized — clear its mark.
      store.clearSetupError(id, "provider-retry-pending");
      interrupted.delete(id);
      return false;
    }
    if (ev.type === "system/thread/interrupted") {
      // §5.3 rev 13: only `manual-stop` cancels a delegation; every other
      // reason resumes first and stalls on repeat.
      const reason =
        typeof data.reason === "string" ? data.reason : "unknown";
      if (reason === "manual-stop") {
        interrupted.add(id);
        return false;
      }
      return handleInterrupted(row, reason, ev.createdAt);
    }
    if (ev.type === "provider/error" || ev.type === "system/error") {
      const text = errorTextOf(data);
      if (text) lastErrorText.set(id, text);
      // §5.2 rev 13: a provider that says "I will retry" is not a quota.
      if (data.willRetry === true) return false;
      // §16.1: mid-turn quota is decided by the typed category ONLY — a
      // text pattern while the turn still runs is noise, not a verdict;
      // the text check stays for turn-ending signals (turn/completed,
      // thread.failed, the idle tail, `errored`).
      const category = (
        data.errorInfo as { category?: unknown } | undefined
      )?.category;
      if (typeof category === "string" && QUOTA_CATEGORIES.has(category)) {
        await toQuota(row, `${ev.type}: ${category}`);
        return true;
      }
      return false;
    }
    if (ev.type === "turn/completed") {
      // §5.2: the turn's own error text is a quota fallback signal too —
      // a lost turn.failed lifecycle event must not hide a rate limit.
      const errText = errorTextOf(
        data.error as Record<string, unknown> | undefined,
      );
      if (errText) {
        lastErrorText.set(id, errText);
        const info = await routeInfo(row);
        if (matchesQuota(errText, info.patterns)) {
          await toQuota(row, `turn/completed: ${errText.slice(0, 200)}`);
          return true;
        }
      }
      return false;
    }
    if (ev.type === "item/started" || ev.type === "item/completed") {
      const item = data.item as { type?: unknown } | undefined;
      if (item?.type !== "userMessage") {
        bumpResponse(id, row, ev.createdAt);
      }
      return false;
    }
    if (RESPONSE_EVENT_TYPES.has(ev.type)) {
      bumpResponse(id, row, ev.createdAt);
    }
    return false;
  };

  /**
   * Read the thread's events after `last_seq`, applying §5 to each.
   * Returns false when the journal could not be fully read — §5.1 rev 18:
   * an unread journal is not silence, so no outcome may be decided on it.
   */
  const processStream = async (row: DelegationRow): Promise<boolean> => {
    if (!row.thread_id) return true;
    let after = row.last_seq ?? 0;
    for (let page = 0; page < EVENT_MAX_PAGES; page++) {
      let events: WatchdogThreadEvent[];
      try {
        events = await deps.threads.events.list({
          threadId: row.thread_id,
          afterSeq: String(Math.max(after, 0)),
          order: "asc",
          limit: String(EVENT_PAGE_SIZE),
        });
      } catch (e) {
        log.warn?.(
          `orchestrator: events.list ${row.thread_id}: ${message(e)}`,
        );
        return false;
      }
      if (events.length === 0) return true;
      for (const ev of events) {
        after = Math.max(after, ev.seq);
        const terminal = await applyStreamEvent(row.id, ev);
        store.advanceLastSeq(row.id, ev.seq);
        if (terminal) return true;
      }
      if (events.length < EVENT_PAGE_SIZE) return true;
    }
    // Page cap hit with a full last page — the journal may hold more.
    return false;
  };

  /**
   * The done/cancelled gate (§5.3): an interrupt counts only when it came
   * after the latest turn start — either seen in the stream just now or
   * still sitting in the event log (plugin restart lost the in-memory flag).
   * Returns null when the journal could not be read — §5.1 rev 18: an
   * unreadable journal is "unknown", not "no interrupt".
   */
  const recentInterrupt = async (
    row: DelegationRow,
  ): Promise<boolean | null> => {
    if (interrupted.has(row.id)) return true;
    if (!row.thread_id) return false;
    try {
      const events = await deps.threads.events.list({
        threadId: row.thread_id,
        order: "desc",
        limit: "50",
        types: ["system/thread/interrupted"],
      });
      return events.some(
        (ev) =>
          (ev.data as { reason?: unknown } | null | undefined)?.reason ===
            "manual-stop" &&
          (row.turn_started_at == null || ev.createdAt >= row.turn_started_at),
      );
    } catch {
      return null;
    }
  };

  /**
   * §5.3 r23 `errored`: collect the current turn's tail (newest → oldest
   * up to its start). When the tail holds a `turn/completed`, that event
   * alone decides: only `status = "failed"` or an `error` field is
   * errored — `interrupted` is a new-message/stop interruption, not an
   * error, and errors arriving AFTER the completion (the agent process
   * exiting, stray provider noise) never count (PLUG-176). Without a
   * `turn/completed`, the newest verdict event decides: a trailing
   * `turn.failed` or `provider/error`/`system/error` without
   * `willRetry = true` ends the turn errored, while a response event or a
   * retrying error means the agent kept working. Returns null when the
   * journal cannot be read — unknown is not "clean" (§5.1 rev 18).
   */
  const lastTurnError = async (
    row: DelegationRow,
  ): Promise<{ text: string } | "clean" | null> => {
    if (!row.thread_id) return "clean";
    let events: WatchdogThreadEvent[];
    try {
      events = await deps.threads.events.list({
        threadId: row.thread_id,
        order: "desc",
        limit: "100",
      });
    } catch (e) {
      log.warn?.(
        `orchestrator: events.tail ${row.thread_id}: ${message(e)}`,
      );
      return null;
    }
    // The turn's tail, newest first, up to the turn's start boundary.
    const tail: WatchdogThreadEvent[] = [];
    for (const ev of events) {
      if (row.turn_started_at != null && ev.createdAt < row.turn_started_at) {
        break; // older turns are out of scope
      }
      if (ev.type === "turn/started") break;
      tail.push(ev);
    }
    const completed = tail.find((e) => e.type === "turn/completed");
    if (completed) {
      const data = (completed.data ?? {}) as Record<string, unknown>;
      const errText =
        errorTextOf(data.error as Record<string, unknown> | undefined) ??
        errorTextOf(data);
      if (data.status === "failed" || data.error != null) {
        return {
          text: errText ?? `turn/completed: status ${String(data.status)}`,
        };
      }
      return "clean";
    }
    for (const ev of tail) {
      const data = (ev.data ?? {}) as Record<string, unknown>;
      if (ev.type === "turn.failed" || ev.type === "turn/failed") {
        return { text: errorTextOf(data) ?? "turn failed" };
      }
      if (ev.type === "provider/error" || ev.type === "system/error") {
        // §5.3: `willRetry` means the provider is still retrying — the
        // turn did not end with an error and idle carries no verdict.
        if (data.willRetry === true) return "clean";
        return { text: errorTextOf(data) ?? ev.type };
      }
      if (ev.type === "item/started" || ev.type === "item/completed") {
        const item = data.item as { type?: unknown } | undefined;
        if (item?.type !== "userMessage") return "clean";
        continue;
      }
      if (RESPONSE_EVENT_TYPES.has(ev.type)) return "clean";
    }
    return "clean";
  };

  /**
   * §5.3 `errored`: first time — «продолжай» to the executor and one line
   * to the coordinator, `running` stays (resume_count + 1); a repeat
   * `errored` is `failed` and follows §5.4. Quota and unavailable texts
   * still outrank the safety outcome.
   */
  const handleErrored = async (
    row: DelegationRow,
    text: string,
    at: number,
  ) => {
    const fresh = store.get(row.id);
    if (!fresh || fresh.status !== "running") return;
    // §16.1: a queued BB auto-retry is not an `errored` — checked first.
    if (await retryBlocksOutcome(fresh)) return;
    const info = await routeInfo(fresh);
    if (matchesQuota(text, info.patterns)) {
      await toQuota(fresh, `errored: ${text.slice(0, 200)}`);
      return;
    }
    if (isUnavailable(fresh, text, info.unavailablePatterns)) {
      await toUnavailable(fresh, `errored: ${text.slice(0, 200)}`);
      return;
    }
    if (hasSetupError(fresh, "errored-resume-sent")) {
      await toFailed(fresh, `повторный обрыв хода ошибкой: ${text.slice(0, 200)}`);
      return;
    }
    // The resume opens a new first-response window — `resume-await`
    // carries the kind so the timer and the idle pass can tell an errored
    // resume (→ `failed` on repeat) from an interrupted one (→ `stalled`).
    store.bumpResume(fresh.id);
    store.setTurnStarted(fresh.id, at);
    store.addSetupError(fresh.id, "resume-await", `errored: ${text.slice(0, 200)}`);
    store.addSetupError(fresh.id, "errored-resume-sent", "1");
    await sendToExecutor(
      fresh,
      `ход оборвался ошибкой: ${text.slice(0, 300)}. Продолжай задачу`,
    );
    await notifyCoordinator(
      fresh,
      `ход исполнителя оборвался ошибкой: задача ${fresh.task_key}, ` +
        `маршрут ${fresh.route}, тред ${fresh.thread_id ?? "—"} — ` +
        `послал продолжение (resume #${fresh.resume_count + 1}). ` +
        `Ошибка: ${text.slice(0, 300)}`,
    );
  };

  /**
   * §4.1 round result at `done`: the executor's worktree answers — its
   * branch, HEAD, commit count over the merge base and cleanliness — into
   * `result_*`. A foreign branch, zero commits or a dirty copy gets one
   * coordinator line. Review-level and auditor delegations commit
   * nothing, so the check does not run for them; env/git failures land
   * in `round-result`, never in the outcome.
   */
  const collectRoundResult = async (row: DelegationRow) => {
    if (!deps.round || !row.thread_id) return;
    if (row.level === "review") return;
    const role = store.threadRole(row.thread_id)?.role;
    if (role === "auditor" || role === "release-auditor") return;
    try {
      const env = await deps.round.environment(row.thread_id);
      if (!env?.path) {
        store.addSetupError(
          row.id,
          "round-result",
          "среда исполнителя не найдена",
        );
        return;
      }
      const git = (args: string[]) => deps.round!.git(env.path!, args);
      const sha = (await git(["rev-parse", "HEAD"])).trim();
      const branch = await git(["symbolic-ref", "--short", "HEAD"])
        .then((s) => s.trim())
        .catch(() => null);
      const dirty = (await git(["status", "--porcelain"])).trim().length > 0;
      let commits: number | null = null;
      if (env.mergeBaseBranch) {
        const out = await git([
          "rev-list",
          "--count",
          `${env.mergeBaseBranch}..HEAD`,
        ]);
        const n = Number(out.trim());
        commits = Number.isFinite(n) ? n : null;
      }
      store.setRoundResult(row.id, {
        envId: env.id ?? null,
        branch,
        sha,
        commits,
        dirty,
      });
      const problems: string[] = [];
      if (env.branchName && branch !== env.branchName) {
        problems.push(
          `ветка ${branch ?? "—"} вместо ${env.branchName} (ушёл в чужую ветку)`,
        );
      }
      // §16.5 one channel (PLUG-184): the doubts ride the single result
      // message, not a second send. «Коммитов нет» is noise for a
      // cancelled round — the executor may have been stopped mid-work.
      if (commits === 0 && row.status !== "cancelled") {
        problems.push("коммитов нет");
      }
      if (dirty) problems.push("копия грязная (незакоммиченные правки)");
      if (problems.length) {
        store.addSetupError(row.id, "round-problems", problems.join("; "));
      } else {
        store.clearSetupError(row.id, "round-problems");
      }
    } catch (e) {
      store.addSetupError(row.id, "round-result", message(e));
    }
  };

  /**
   * §16.2: a `turn/started` after the last processed seq on a finished
   * delegation (`done`/`failed`/`cancelled`) means BB or the coordinator
   * started the thread again — a queued provider retry materializing, a
   * `bb thread tell` lifting the thread back, anything. Without another
   * ACTIVE delegation on the task the row goes back to `running`
   * (`revived_count += 1`); this also covers the `autoFallback = false`
   * `failed` BB revives without supervision and the tell-interrupted
   * `done`. With another active delegation the duplicate turn is stopped
   * and the coordinator hears one line. Returns true when the row's
   * outcome must NOT be delivered/decided right now.
   */
  /**
   * §16.2/PLUG-184: a rogue turn on a finished delegation is suppressed —
   * the queued BB auto-retry is cancelled FIRST (§16.1 ordering), then
   * the thread is stopped and the stop is confirmed by a read-back
   * (idle|error|gone per §16.5). A confirmed stop advances last_seq past
   * this wake; an unconfirmed one leaves it, so the next event pass
   * retries — suppression is repeatable, never a one-shot mark. The
   * coordinator hears exactly one line (`revived-suppressed`).
   */
  const suppressWake = async (
    row: DelegationRow,
    turnSeq: number,
    reason: string,
  ) => {
    const cancelErr = await ensureRetryCancelled(row);
    if (cancelErr !== true) {
      log.warn?.(
        `orchestrator: suppress #${row.id} auto-retry cancel: ${cancelErr}`,
      );
    }
    let confirmed = false;
    try {
      await deps.threads.stop({ threadId: row.thread_id! });
      const t = await getThread(row.thread_id!).catch(() => null);
      confirmed =
        !t ||
        !!t.deletedAt ||
        !!t.archivedAt ||
        t.status === "idle" ||
        t.status === "error";
    } catch (e) {
      if (/not.?found|does not exist|deleted|archiv/i.test(message(e))) {
        confirmed = true;
      } else {
        log.warn?.(
          `orchestrator: suppress stop ${row.thread_id}: ${message(e)}`,
        );
      }
    }
    if (confirmed) {
      // This wake is handled — a NEW turn/started re-fires suppression.
      store.advanceLastSeq(row.id, turnSeq);
    } else {
      log.warn?.(
        `orchestrator: suppress stop of ${row.thread_id} unconfirmed — next pass retries`,
      );
    }
    const cur = store.get(row.id) ?? row;
    if (!hasSetupError(cur, "revived-suppressed")) {
      store.addSetupError(
        row.id,
        "revived-suppressed",
        "coordinator notified",
      );
      await notifyCoordinator(
        row,
        `${row.task_key}: исполнитель ${row.thread_id} поднял новый ход ` +
          `после исхода «${row.status}» — ${reason}: автоповтор отменён, ` +
          `тред ${confirmed ? "остановлен" : "останавливаю"}`,
      );
    }
  };

  /**
   * §16.2 r25 (PLUG-193): a wake opened ONLY by tracker comment
   * notifications is not a revive and never reaches the coordinator —
   * the rogue turn of a TERMINAL delegation is just stopped (the plugin
   * journal records it), the status stands and the cursor moves past
   * the consumed turn. The stop is confirmed by a read-back like
   * suppressWake's; an unconfirmed stop keeps the cursor so the next
   * pass retries.
   */
  const silentStopWake = async (row: DelegationRow, turnSeq: number) => {
    let confirmed = false;
    // §16.2 (spec 560588a): the thread's own auto-retry rows go BEFORE
    // the silent stop — an uncancelled retry would lift the rogue turn
    // back; a failed cancel is an unconfirmed stop retried next pass.
    const cancelled = await ensureRetryCancelled(row);
    if (cancelled !== true) {
      log.warn?.(
        `orchestrator: tracker-wake stop of ${row.thread_id} ` +
          `unconfirmed — auto-retry cancel: ${cancelled}`,
      );
      return;
    }
    try {
      await deps.threads.stop({ threadId: row.thread_id! });
      const t = await getThread(row.thread_id!).catch(() => null);
      confirmed =
        !t ||
        !!t.deletedAt ||
        !!t.archivedAt ||
        t.status === "idle" ||
        t.status === "error";
    } catch (e) {
      if (/not.?found|does not exist|deleted|archiv/i.test(message(e))) {
        confirmed = true;
      } else {
        log.warn?.(
          `orchestrator: tracker-wake stop ${row.thread_id}: ${message(e)}`,
        );
      }
    }
    if (confirmed) {
      store.advanceLastSeq(row.id, turnSeq);
      log.info?.(
        `orchestrator: delegation #${row.id} tracker wake ` +
          `stopped silently (turn seq ${turnSeq})`,
      );
    } else {
      log.warn?.(
        `orchestrator: tracker-wake stop of ${row.thread_id} ` +
          `unconfirmed — next pass retries`,
      );
    }
  };

  /**
   * §16.2 r25 (PLUG-193): the wake verdict reads EVERY
   * `client/turn/requested` above `last_seq` — BB writes the request
   * when a message is QUEUED, not when its turn starts, so judging each
   * `turn/started` by the request right before it misreads queued
   * batches: a coordinator's tell arriving mid-turn between two tracker
   * comments was consumed as a tracker wake and the executor worked
   * unsupervised. All-requests-tracker → silent stop, status stands,
   * cursor consumed. Any other request — or none at all (an
   * unattributed turn such as an auto-retry resume) — → the general
   * rule: superseded/newer → suppress, otherwise revive. A full window
   * is read on — the "all requests are tracker" verdict needs EVERY
   * request after `last_seq`, so the scan keeps paging (pages ≤100,
   * §5.1 rev 18) until the journal tail is reached (PLUG-196).
   */
  type WakeVerdict =
    | "none"
    | "silent"
    | "revived"
    | "suppressed"
    | "unreadable";
  const scanTerminalWake = async (
    row: DelegationRow,
  ): Promise<WakeVerdict> => {
    const events: WatchdogThreadEvent[] = [];
    try {
      let after = row.last_seq ?? 0;
      let tailReached = false;
      for (let page = 0; page < EVENT_MAX_PAGES; page++) {
        const chunk = await deps.threads.events.list({
          threadId: row.thread_id!,
          afterSeq: String(after),
          order: "asc",
          limit: "50",
          types: ["turn/started", "client/turn/requested"],
        });
        events.push(...chunk);
        if (chunk.length < 50) {
          tailReached = true;
          break;
        }
        after = Math.max(...chunk.map((e) => e.seq));
      }
      if (!tailReached) {
        // Page cap hit with a full last page — the tail is unread, the
        // all-tracker verdict would be unproven. Defer to a later pass.
        log.warn?.(
          `orchestrator: revive check ${row.thread_id}: page cap reached`,
        );
        return "unreadable";
      }
    } catch (e) {
      log.warn?.(
        `orchestrator: revive check ${row.thread_id}: ${message(e)}`,
      );
      return "unreadable"; // a later pass re-checks
    }
    const starts = events.filter((e) => e.type === "turn/started");
    if (starts.length === 0) return "none";
    const turnSeq = Math.max(...starts.map((e) => e.seq));
    const requests = events.filter(
      (e) => e.type === "client/turn/requested",
    );
    if (
      requests.length > 0 &&
      requests.every((r) =>
        requestText(r).startsWith(TRACKER_COMMENT_PREFIX),
      )
    ) {
      await silentStopWake(row, turnSeq);
      return "silent";
    }
    const superseded = SUPERSEDED.has(row.status);
    const newer = store.hasNewerForTask(row.task_key, row.id);
    if (superseded || newer) {
      await suppressWake(
        row,
        turnSeq,
        newer
          ? "у задачи есть более новое делегирование"
          : `исход «${row.status}» уже зафиксирован`,
      );
      return "suppressed";
    }
    if (!store.revive(row.id)) {
      // Lost the race — another delegation of the task is active
      // (the revive() transaction guards the partial unique index).
      await suppressWake(
        row,
        turnSeq,
        "у задачи есть более новое делегирование",
      );
      return "suppressed";
    }
    clearMarks(row.id);
    log.info?.(`orchestrator: delegation #${row.id} revived (turn/started)`);
    // Drain the stream so the new turn's `turn/started` reopens
    // supervision (turn_started_at, cleared marks).
    await processStream(store.get(row.id) ?? row);
    return "revived";
  };

  const maybeRevive = async (row: DelegationRow): Promise<boolean> => {
    if (
      !row.thread_id ||
      !(REVIVABLE.has(row.status) || SUPERSEDED.has(row.status))
    ) {
      return false;
    }
    const verdict = await scanTerminalWake(row);
    // A finished row keeps delivering its outcome; "suppressed" blocks
    // only for superseded statuses (they never reach the delivery list
    // anyway), "revived" always blocks — the outcome is void.
    return (
      verdict === "revived" ||
      (verdict === "suppressed" && SUPERSEDED.has(row.status))
    );
  };

  /**
   * §16.5: did BB itself report this executor's outcome to the
   * coordinator? The coordinator's journal is scanned (pages ≤ 100,
   * §5.1) for a `client/turn/requested` system message that arrived
   * after the executor's last turn started: `systemMessageKind`
   * `child-completed`/`child-interrupted` with
   * `systemMessageSubject.threadId` = the executor's thread, or a
   * `child-outcome-batch` listing it in `outcomes`. A batch without a
   * thread list counts only when it arrived after the executor's last
   * response — an unattributed batch can only stand in for a turn that
   * already ended. Returns null when the journal could not be read to
   * its tail: unproven is not "absent".
   */
  const coordinatorSawOutcome = async (
    row: DelegationRow,
  ): Promise<boolean | null> => {
    if (!row.thread_id) return false;
    const since = row.turn_started_at ?? 0;
    const turnEnd = Math.max(row.last_response_at ?? 0, since);
    let after = 0;
    try {
      for (let page = 0; page < EVENT_MAX_PAGES; page++) {
        const chunk = await deps.threads.events.list({
          threadId: row.coordinator_thread_id,
          afterSeq: String(after),
          order: "asc",
          limit: String(EVENT_PAGE_SIZE),
          types: ["client/turn/requested"],
        });
        for (const e of chunk) {
          if (e.createdAt <= since) continue;
          const d = e.data as
            | {
                systemMessageKind?: unknown;
                systemMessageSubject?: {
                  threadId?: unknown;
                  outcomes?: unknown;
                } | null;
              }
            | null
            | undefined;
          const kind = d?.systemMessageKind;
          const subj = d?.systemMessageSubject;
          if (
            (kind === "child-completed" || kind === "child-interrupted") &&
            subj?.threadId === row.thread_id
          ) {
            return true;
          }
          if (kind === "child-outcome-batch") {
            const outcomes = subj?.outcomes;
            if (Array.isArray(outcomes) && outcomes.length > 0) {
              if (
                outcomes.some(
                  (o) =>
                    (o as { threadId?: unknown } | null)?.threadId ===
                    row.thread_id,
                )
              ) {
                return true;
              }
            } else if (turnEnd > 0 && e.createdAt > turnEnd) {
              return true;
            }
          }
        }
        if (chunk.length < EVENT_PAGE_SIZE) return false;
        after = Math.max(...chunk.map((e) => e.seq));
      }
    } catch (e) {
      log.warn?.(
        `orchestrator: coordinator journal ` +
          `${row.coordinator_thread_id}: ${message(e)}`,
      );
      return null;
    }
    return null; // page cap — the journal tail was not proven
  };

  /**
   * §16.5: BB is the primary outcome channel — `parentNotifications =
   * auto` (§4 step 4) makes it report the executor's `done`/`cancelled`
   * to the coordinator itself. RESULT_BB_GRACE_MS after the finished row
   * is first seen (and at every §7 pass until confirmed) the plugin
   * checks the coordinator's journal for BB's notice about the
   * executor's thread; found — `result_notice = bb`, no message.
   * Absent — the plugin's own ONE line (branch, sha7, copy cleanliness,
   * executor output ≤ 3000 or «без отчёта»), `result_notice = plugin`.
   * An empty or doubtful (§4.1) result always gets the plugin line.
   * `result_notified_at` is the durable delivery record; a gone
   * coordinator records the delivery with a NULL `result_notice` so the
   * row never rescans.
   */
  const deliverResult = async (row: DelegationRow) => {
    // §16.2 hedge: a revived thread voids the outcome — check first.
    if (await maybeRevive(row)) return;
    const fresh = store.get(row.id) ?? row;
    // PLUG-190: only a RECORDED delivery ends the resend — a `-1` claim
    // left by a crash mid-delivery is stale work, not a delivered result
    // (`claimResultDelivery` re-takes it after two minutes).
    if ((fresh.result_notified_at ?? 0) > 0 || fresh.result_notice != null) {
      return;
    }
    if (fresh.status !== "done" && fresh.status !== "cancelled") return;
    // §16.5: the `result-window` marker opens BB's grace window at the
    // finished row's first sight (it survives restarts; a revive clears
    // it in store.revive). A `-1` claim skips the window — that row
    // already waited it out before the send was claimed (or the claim
    // predates the window).
    if (fresh.result_notified_at == null) {
      const win = store.findSetupError(fresh, "result-window");
      if (!win) {
        store.addSetupError(fresh.id, "result-window", String(now()));
        return;
      }
      if (now() - Number(win.message) < RESULT_BB_GRACE_MS) return;
    }
    // §16.5 exactly-once (PLUG-184): the conditional claim below is the
    // atomic gate — event-driven and reconcile paths cannot both send.
    // Anything that bails afterwards releases the claim so the §7 pass
    // retries instead of losing the result forever.
    if (!store.claimResultDelivery(fresh.id)) return;
    let output: string | null = null;
    if (fresh.thread_id) {
      try {
        const res = await deps.threads.output({ threadId: fresh.thread_id });
        output = res?.output ?? null;
      } catch (e) {
        if (!/not.?found|does not exist|deleted|archiv/i.test(message(e))) {
          log.warn?.(
            `orchestrator: output ${fresh.thread_id}: ${message(e)}`,
          );
          store.releaseResultClaim(fresh.id);
          return; // transient read error — the §7 pass retries
        }
      }
    }
    let coord: WatchdogThreadDto | null;
    try {
      coord = await getThread(fresh.coordinator_thread_id);
    } catch (e) {
      log.warn?.(
        `orchestrator: coordinator ${fresh.coordinator_thread_id}: ${message(e)}`,
      );
      store.releaseResultClaim(fresh.id);
      return;
    }
    if (!coord || coord.deletedAt || coord.archivedAt) {
      log.info?.(
        `orchestrator: delegation #${fresh.id} — coordinator gone, result dropped`,
      );
      store.setResultNotified(fresh.id, null);
      return;
    }
    const report = output?.trim() ?? "";
    // §16.5 one channel: the round's doubts ride the result message.
    const doubt = store.findSetupError(fresh, "round-problems")?.message;
    // §16.5: BB's own notice about this thread in the coordinator's
    // journal satisfies the delivery (`result_notice = bb`) — except an
    // empty or doubtful result, which the plugin always reports itself.
    // An unreadable journal is not "absent": the claim is released so
    // the §7 pass re-checks — a duplicate line is worse than a late one.
    if (report.length > 0 && !doubt) {
      const seen = await coordinatorSawOutcome(fresh);
      if (seen === null) {
        store.releaseResultClaim(fresh.id);
        await trackRetry(
          fresh,
          "проверка журнала координатора",
          "events.list failed",
        );
        return;
      }
      if (seen) {
        store.setResultNotified(fresh.id, "bb");
        store.resetRetry(fresh.id);
        return;
      }
    }
    const branch = fresh.result_branch ?? "—";
    const sha7 = fresh.result_sha ? fresh.result_sha.slice(0, 7) : "—";
    const copy =
      fresh.result_dirty == null
        ? "—"
        : fresh.result_dirty
          ? "грязная"
          : "чистая";
    const body =
      report.length > 0
        ? report.slice(0, RESULT_OUTPUT_CAP)
        : "исполнитель закончил без отчёта";
    try {
      await deps.threads.send({
        threadId: coord.id,
        mode: "queue-if-active",
        input: [
          {
            type: "text",
            text:
              `[orchestrator] ${fresh.task_key} (${fresh.level}, тред ` +
              `${fresh.thread_id ?? "—"}): ${fresh.status}, ветка ${branch}, ` +
              `коммит ${sha7}, копия ${copy}` +
              (doubt ? `, итог сомнителен: ${doubt}` : "") +
              `\n${body}`,
            mentions: [],
          },
        ],
      });
    } catch (e) {
      store.releaseResultClaim(fresh.id);
      await trackRetry(fresh, "доставка итога координатору", message(e));
      return;
    }
    store.setResultNotified(fresh.id, "plugin");
    store.resetRetry(fresh.id);
  };

  const evaluateIdle = async (
    row: DelegationRow,
    thread: WatchdogThreadDto,
    streamRead: boolean,
  ) => {
    // Tombstones come from the DTO, not the journal — they decide alone.
    if (thread.deletedAt || thread.archivedAt) {
      await toCancelled(
        row,
        thread.deletedAt ? "тред удалён" : "тред в архиве",
      );
      return;
    }
    // §5.1 rev 18: done/cancelled/stalled all stand on the journal —
    // an unread one is not silence; the next check re-reads it.
    if (!streamRead) return;
    const interruptedNow = await recentInterrupt(row);
    if (interruptedNow === null) return; // interrupt lookup failed too
    if (interruptedNow) {
      await toCancelled(row, "ход прерван (system/thread/interrupted)");
      return;
    }
    // `done` only after a turn started and with an empty queue (§5.3).
    if (row.turn_started_at == null) return;
    let queue: unknown[];
    try {
      queue = await deps.threads.queuedMessages.list({ threadId: thread.id });
    } catch (e) {
      // An unreadable queue is not an empty one — stay running.
      log.warn?.(`orchestrator: queuedMessages ${thread.id}: ${message(e)}`);
      return;
    }
    // §5.3 rev 15/23: a resume that never lifted a new turn repeats the
    // failure — an errored resume lands `failed`, an interrupted one
    // `stalled`; both follow §5.4 and neither is `done`.
    const resumeAwait = store.findSetupError(row, "resume-await");
    if (resumeAwait) {
      if (queue.length === 0) {
        if (resumeAwait.message.startsWith("errored:")) {
          await toFailed(row, "продолжение не подняло новый ход");
        } else {
          await toStalled(row, "продолжение не подняло новый ход");
        }
      }
      return; // queue holds the resume message — give it time to deliver
    }
    if (queue.length === 0) {
      // §5.3 r23 `errored`: the turn may have ended with an error while
      // the thread went idle — the journal tail decides between a resume
      // nudge (→ `failed` on repeat) and `done`.
      const verdict = await lastTurnError(row);
      if (verdict === null) return; // unreadable journal is not a clean one
      if (verdict !== "clean") {
        await handleErrored(row, verdict.text, now());
        return;
      }
      // PLUG-184: the status move is conditional — a row that left
      // `running` meanwhile (manual cancel, revive) never flips to done.
      if (!store.setStatusIf(row.id, "running", "done")) return;
      clearMarks(row.id);
      const finished = store.get(row.id) ?? row;
      await collectRoundResult(finished);
      // §16.5: the §4.1 round result is collected — now the result
      // message goes out (or is recorded for the §7 resend pass).
      await deliverResult(finished);
    }
  };

  const getThread = async (
    threadId: string | null,
  ): Promise<WatchdogThreadDto | null> => {
    if (!threadId) return null;
    try {
      return await deps.threads.get({ threadId });
    } catch (e) {
      if (/not.?found|does not exist|deleted|archiv/i.test(message(e))) {
        return null;
      }
      throw e;
    }
  };

  // ── Public handlers ──────────────────────────────────────────────────

  /** `experimental_thread.events` — something changed; read new events. */
  const onThreadEvents = async (payload: {
    thread: WatchdogThreadDto;
    sequence?: number;
  }) => {
    const row = store.byThreadId(payload.thread.id);
    if (!row) return;
    if (!isActive(row.status)) {
      // §16.2: a `turn/started` on a finished delegation revives it.
      await maybeRevive(row);
      return;
    }
    await processStream(row);
  };

  /** §5.1: a transition into `active` opens the window when no turn did. */
  const onThreadActive = async (thread: WatchdogThreadDto) => {
    const row = store.byThreadId(thread.id);
    if (!row || row.status !== "running" || row.turn_started_at != null) {
      return;
    }
    store.setTurnStarted(row.id, now());
  };

  const onThreadIdle = async (thread: WatchdogThreadDto) => {
    const row = store.byThreadId(thread.id);
    if (!row || !isActive(row.status)) return;
    const streamRead = await processStream(row);
    const fresh = store.get(row.id);
    if (!fresh || fresh.status !== "running") return;
    await evaluateIdle(fresh, thread, streamRead);
  };

  const onThreadFailed = async (
    thread: WatchdogThreadDto,
    error: string | null,
  ) => {
    const row = store.byThreadId(thread.id);
    // `failed` rows pass: a stronger signal in this event may upgrade the
    // outcome (§5.2/§5.3 precede `failed` whenever it is re-evaluated).
    if (!row || !(isActive(row.status) || row.status === "failed")) return;
    // §16.1: a queued BB auto-retry is not an outcome — checked first.
    if (await retryBlocksOutcome(row)) return;
    const streamRead = await processStream(row);
    const fresh = store.get(row.id);
    // A later, stronger signal may still upgrade a premature `failed` —
    // let `failed` rows reach the decision too (§5.2/§5.3 before `failed`).
    if (!fresh || !(isActive(fresh.status) || fresh.status === "failed")) {
      return;
    }
    // §5.2: the failed-vs-quota decision needs the turn's events read.
    if (!streamRead) return;
    const text = error ?? lastErrorText.get(fresh.id) ?? "thread failed";
    const info = await routeInfo(fresh);
    if (matchesQuota(text, info.patterns)) {
      await toQuota(fresh, `thread.failed: ${text.slice(0, 200)}`);
    } else if (isUnavailable(fresh, text, info.unavailablePatterns)) {
      await toUnavailable(fresh, `thread.failed: ${text.slice(0, 200)}`);
    } else {
      await toFailed(fresh, text);
    }
  };

  const onTurnFailed = async (event: TurnFailedInfo) => {
    const row = store.byThreadId(event.threadId);
    if (!row) return;
    // §16.1: a queued BB auto-retry is not an outcome — checked first,
    // even before the typed quota category (§16.1's retry outranks it).
    if (
      (isActive(row.status) || row.status === "failed") &&
      (await retryBlocksOutcome(row))
    ) {
      return;
    }
    // §5.2 first signal: the typed category — it wins even over a `failed`
    // a premature thread.failed already committed (rev 13 ordering).
    const category = event.errorInfo?.category;
    if (category && QUOTA_CATEGORIES.has(category)) {
      await toQuota(row, `turn.failed: ${category}`);
      return;
    }
    if (!(isActive(row.status) || row.status === "failed")) return;
    const streamRead = await processStream(row);
    const fresh = store.get(row.id);
    if (!fresh || !(isActive(fresh.status) || fresh.status === "failed")) {
      return;
    }
    // §5.2: the failed-vs-quota decision needs the turn's events read.
    if (!streamRead) return;
    const text =
      lastErrorText.get(fresh.id) ??
      `turn failed${category ? ` (${category})` : ""}`;
    const info = await routeInfo(fresh);
    if (matchesQuota(text, info.patterns)) {
      await toQuota(fresh, `turn.failed: ${text.slice(0, 200)}`);
    } else if (isUnavailable(fresh, text, info.unavailablePatterns)) {
      await toUnavailable(fresh, `turn.failed: ${text.slice(0, 200)}`);
    } else {
      await toFailed(fresh, text);
    }
  };

  const describeInteraction = (interaction: unknown): string => {
    const p = interaction as
      | {
          id?: string;
          payload?: {
            kind?: string;
            title?: string;
            subject?: { command?: string };
            question?: string;
          };
        }
      | undefined;
    const kind = p?.payload?.kind ?? "unknown";
    const subject =
      p?.payload?.title ??
      p?.payload?.subject?.command ??
      p?.payload?.question ??
      "";
    return `${kind}${subject ? ` — ${subject.slice(0, 200)}` : ""}`;
  };

  const onInteractionPending = async (
    thread: WatchdogThreadDto,
    interaction: unknown,
  ) => {
    const row = store.byThreadId(thread.id);
    if (!row || !isActive(row.status)) return;
    // §5.3: at most one approval notification per 10 minutes.
    if (
      row.last_approval_notified_at != null &&
      now() - row.last_approval_notified_at < APPROVAL_NOTIFY_MS
    ) {
      return;
    }
    store.setApprovalNotified(row.id, now());
    const id =
      (interaction as { id?: string } | undefined)?.id ?? "<interactionId>";
    await notifyCoordinator(
      row,
      `исполнитель ждёт решения: задача ${row.task_key}, маршрут ${row.route}, ` +
        `тред ${row.thread_id} — ${describeInteraction(interaction)}. ` +
        `Реши: bb thread interactions approve|deny|grant|answer|respond ${id} ${row.thread_id}`,
    );
  };

  const onThreadGone = async (
    thread: WatchdogThreadDto,
    reason: "archived" | "deleted" | "not-found",
  ) => {
    const row = store.byThreadId(thread.id);
    if (!row || !isActive(row.status)) return;
    const text =
      reason === "archived"
        ? "тред в архиве"
        : reason === "deleted"
          ? "тред удалён"
          : "тред не найден";
    await toCancelled(row, text);
  };

  /** §5.1 first-response window + §5.3 `maxRunSeconds` — the timer pass. */
  const checkTimers = async () => {
    const { policy } = await deps.loadPolicy();
    // §2 rule 4 (r23): a route's own `firstResponseSeconds` overrides the
    // global window — slow cold starts (agy takes 2–3 min) must not stall.
    const firstMsOf = (row: DelegationRow) =>
      (policy?.routes[row.route]?.firstResponseSeconds ??
        policy?.firstResponseSeconds ??
        DEFAULT_FIRST_RESPONSE_SECONDS) * 1000;
    // §16.5: `routes.*.startSeconds` (no turn began) and
    // `routes.*.idleSeconds` (response silence) — one message each,
    // never a stop.
    const startMsOf = (row: DelegationRow) =>
      (policy?.routes[row.route]?.startSeconds ?? DEFAULT_START_SECONDS) *
      1000;
    const idleMsOf = (row: DelegationRow) =>
      (policy?.routes[row.route]?.idleSeconds ?? DEFAULT_IDLE_SECONDS) *
      1000;
    const maxRunMs =
      (policy?.maxRunSeconds ?? DEFAULT_MAX_RUN_SECONDS) * 1000;
    const t = now();
    for (const row of store.listActive()) {
      if (row.status !== "running") continue;
      const firstMs = firstMsOf(row);
      if (
        row.turn_started_at != null &&
        row.first_response_at == null &&
        t - row.turn_started_at > firstMs
      ) {
        // §5.1 rev 13: drain the event log first — a response already
        // recorded after `last_seq` cancels the stalled decision.
        // rev 18: an unreadable journal is not silence — no stalled
        // decision (the resume window below included); the next
        // check retries.
        if (!(await processStream(row))) continue;
        const fresh = store.get(row.id);
        if (
          !fresh ||
          fresh.status !== "running" ||
          fresh.turn_started_at == null ||
          fresh.first_response_at != null ||
          t - fresh.turn_started_at <= firstMs
        ) {
          continue;
        }
        // Re-read the thread: a finished turn may already have idled it.
        const thread = await getThread(row.thread_id);
        // §5.3 rev 15/23: a pending resume shares the window — an idle
        // executor with an empty queue never began the new turn. An
        // errored resume lands `failed`, an interrupted one `stalled`.
        const resumeAwait = store.findSetupError(fresh, "resume-await");
        if (resumeAwait) {
          if (!thread || thread.status !== "active") {
            const queue = await deps.threads.queuedMessages
              .list({ threadId: row.thread_id! })
              .catch(() => null);
            if (queue && queue.length === 0) {
              if (resumeAwait.message.startsWith("errored:")) {
                await toFailed(fresh, "продолжение не подняло новый ход");
              } else {
                await toStalled(fresh, "продолжение не подняло новый ход");
              }
            }
          }
          continue;
        }
        if (thread && thread.status === "active") {
          await toStalled(
            fresh,
            `нет первого ответа за ${Math.round(firstMs / 1000)}с`,
          );
          continue;
        }
      }
      if (row.timeout_notified_at == null && t - row.created_at > maxRunMs) {
        store.setTimeoutNotified(row.id, t);
        // §5.3: one message, never a stop.
        await notifyCoordinator(
          row,
          `делегирование #${row.id} дольше maxRunSeconds ` +
            `(${Math.round(maxRunMs / 1000)}с): задача ${row.task_key}, ` +
            `маршрут ${row.route}, тред ${row.thread_id} — не останавливаю`,
        );
      }
      // §16.5 `startSeconds`: the executor never started a turn — one
      // message (the dispatch itself may have quietly not fired).
      const startMs = startMsOf(row);
      if (
        row.turn_started_at == null &&
        !hasSetupError(row, "start-notified") &&
        t - row.created_at > startMs
      ) {
        store.addSetupError(row.id, "start-notified", "1");
        await notifyCoordinator(
          row,
          `делегирование #${row.id}: исполнитель не начал ход за ` +
            `${Math.round(startMs / 1000)}с — задача ${row.task_key}, ` +
            `маршрут ${row.route}, тред ${row.thread_id ?? "—"} — ` +
            `не останавливаю`,
        );
      }
      // §16.5 `idleSeconds`: response silence — one message. PLUG-184:
      // silence is measured from the LATER of the last response and the
      // current turn's start — a new turn after a long auto-retry wait
      // or resume must not fire the notice instantly. And a thread with
      // a queued BB auto-retry is sleeping on BB, not silent.
      const idleMs = idleMsOf(row);
      const lastResp = Math.max(
        row.last_response_at ?? row.first_response_at ?? 0,
        row.turn_started_at ?? 0,
      );
      if (
        lastResp > 0 &&
        !hasSetupError(row, "idle-notified") &&
        !hasSetupError(row, "provider-retry-pending") &&
        t - lastResp > idleMs
      ) {
        store.addSetupError(row.id, "idle-notified", "1");
        await notifyCoordinator(
          row,
          `делегирование #${row.id}: нет событий ответа дольше ` +
            `${Math.round(idleMs / 1000)}с — задача ${row.task_key}, ` +
            `маршрут ${row.route}, тред ${row.thread_id ?? "—"} — ` +
            `не останавливаю`,
        );
      }
    }
  };

  // ── Reconcile (§7) ───────────────────────────────────────────────────

  /**
   * §7 retry limit: 10 consecutive failed retries of the same action →
   * `retry-exhausted` in setup_errors and one coordinator message with
   * the last error and the manual-resolution commands.
   */
  const RETRY_LIMIT = 10;
  const retryExhausted = async (row: DelegationRow, action: string) => {
    const current = store.get(row.id) ?? row;
    if (hasSetupError(current, "retry-exhausted")) return;
    const last =
      store.findSetupError(current, "retry-last-error")?.message ??
      store.findSetupError(current, "watchdog-stop")?.message ??
      "—";
    store.addSetupError(row.id, "retry-exhausted", last);
    await report(
      row,
      `исчерпан предел повторов (${RETRY_LIMIT}): ${action} по ` +
        `делегированию #${row.id} — последняя ошибка: ${last}. Ручное ` +
        `решение: \`bb orchestrator show ${row.id}\` и ` +
        `\`bb orchestrator cancel ${row.id}\`, затем раздать заново`,
    );
  };

  /**
   * §7 retry limit shared by the reconcile paths. Every failed retry also
   * refreshes `retry-last-error` — the exhaustion message quotes the error
   * of the action being retried, whatever it is (cleared by `resetRetry`).
   */
  const trackRetry = async (
    row: DelegationRow,
    action: string,
    lastError: string,
  ) => {
    store.bumpRetry(row.id);
    store.clearSetupError(row.id, "retry-last-error");
    store.addSetupError(row.id, "retry-last-error", lastError);
    const fresh = store.get(row.id) ?? row;
    if (fresh.retry_count >= RETRY_LIMIT) await retryExhausted(fresh, action);
  };

  /** The §5.4 completion report for a `reissue_of` row the reconcile
   * finished: without it a restart between the transaction and the
   * dispatch would leave the coordinator uninformed. */
  const reportReissueDone = async (row: DelegationRow) => {
    const prev = row.reissue_of != null ? store.get(row.reissue_of) : undefined;
    const text =
      `перевыпуск завершён: задача ${row.task_key}, ` +
      `маршрут ${prev?.route ?? "?"} → ${row.route}, ` +
      `новый тред ${row.thread_id ?? "—"}`;
    await report(row, text);
  };

  const reconcileDispatching = async (
    row: DelegationRow,
    s: ReconcileSummary,
  ) => {
    if (now() - row.created_at < DISPATCH_GRACE_MS) return;
    // §7 retry limit: an exhausted reissue stays `dispatching` for the
    // coordinator to resolve by hand — retries stop entirely.
    if (hasSetupError(row, "retry-exhausted")) return;
    if (!row.thread_id) {
      // «Результат раздачи неизвестен»: find the thread the tasks plugin
      // attached after the record was created.
      let threadId: string | null;
      try {
        threadId = await findTaskThreadId(
          deps.bbCli,
          row.task_key,
          row.created_at,
        );
      } catch (e) {
        if (row.reissue_of != null) {
          await trackRetry(row, "доведение перевыпуска", message(e));
        }
        throw new OrchestratorError("bb-cli-failed", message(e));
      }
      if (!threadId) {
        if (row.reissue_of != null) {
          // §5.4 rev 13: a reissue record is driven to dispatch, never
          // silently removed. The thread search came up empty, so the
          // dispatch runs here; a refusal marks the row `failed`.
          try {
            const res = await deps.dispatch(store.get(row.id) ?? row, {
              onDispatchFailure: "fail",
            });
            store.resetRetry(row.id); // resolved — the streak is over
            if (res.status === "running") {
              s.relinked++;
              await reportReissueDone(store.get(row.id) ?? row);
            } else {
              s.cancelled++;
            }
          } catch (e) {
            const err = e as { code?: string };
            if (err.code === "dispatch-failed") {
              if (
                await dispatchRefusalIsUnavailable(
                  store.get(row.id) ?? row,
                  message(e),
                )
              ) {
                return;
              }
              s.errors.push(
                `delegation #${row.id}: reissue dispatch failed`,
              );
              await report(
                row,
                `перевыпуск потерян: задача ${row.task_key}, маршрут ` +
                  `${row.route} — раздача отклонена (${message(e)})`,
              );
            } else {
              // `dispatch-unknown` leaves the row `dispatching`; the
              // §7 limit bounds how long the next passes may retry.
              await trackRetry(row, "доведение перевыпуска", message(e));
            }
          }
          return;
        }
        store.remove(row.id);
        s.removed++;
        await commentOnTask(
          row,
          `раздача не подтверждена: делегирование #${row.id} удалено ` +
            `(тред не найден через bb tasks threads)`,
        );
        return;
      }
      store.setThreadInfo(row.id, threadId);
      s.relinked++;
    }
    const fresh = store.get(row.id);
    if (!fresh || fresh.status !== "dispatching") return;
    // §7: a `dispatching` older than five minutes gets steps 4–6 finished.
    const res = await deps.finalize(fresh);
    store.resetRetry(row.id); // resolved — the retry streak is over
    if (res.status === "running") {
      s.finalized++;
      if (fresh.reissue_of != null) await reportReissueDone(store.get(row.id)!);
    } else {
      s.cancelled++;
    }
  };

  const reconcileRunning = async (row: DelegationRow, s: ReconcileSummary) => {
    const thread = await getThread(row.thread_id);
    if (!thread) {
      await toCancelled(row, "тред не найден");
      s.cancelled++;
      return;
    }
    if (thread.deletedAt || thread.archivedAt) {
      await toCancelled(
        row,
        thread.deletedAt ? "тред удалён" : "тред в архиве",
      );
      s.cancelled++;
      return;
    }
    const streamRead = await processStream(row);
    let fresh = store.get(row.id);
    if (!fresh || fresh.status !== "running") return;
    // §7 "apply §5": derive the outcome from the current thread status —
    // only on a fully read journal (§5.1 rev 18, §5.2); an unreadable
    // one is not silence and the next pass re-reads it.
    if (streamRead) {
      if (thread.status === "idle") {
        await evaluateIdle(fresh, thread, streamRead);
      } else if (thread.status === "error") {
        // §16.1: a queued BB auto-retry is not an outcome — checked first.
        if (!(await retryBlocksOutcome(fresh))) {
          const text = lastErrorText.get(fresh.id) ?? "thread failed";
          const info = await routeInfo(fresh);
          if (matchesQuota(text, info.patterns)) {
            await toQuota(fresh, `thread.error: ${text.slice(0, 200)}`);
          } else if (isUnavailable(fresh, text, info.unavailablePatterns)) {
            await toUnavailable(fresh, `thread.error: ${text.slice(0, 200)}`);
          } else {
            await toFailed(fresh, text);
          }
        }
      }
      fresh = store.get(row.id);
      if (!fresh || fresh.status !== "running") return;
    }
    // §7: repeat unfinished §4.4–4.6 steps (setup_errors + the bypass check).
    const retried = await deps.retrySetup(fresh);
    s.retriedSteps += retried.length;
    // §16.5/PLUG-184: the executor→coordinator binding is verified by
    // `bb thread show --json` — the SDK thread DTO omits
    // `parentNotifications`, so reading the DTO never confirms and the
    // update re-applied forever. A drifted binding is re-applied — `auto`
    // is required so BB itself delivers the executor's outcome notice
    // (§16.5) — and the next pass re-reads the show output. The marker
    // records the mode it confirmed: an r24 `confirmed` row re-verifies
    // once, which also migrates live `stuck` executors to `auto`.
    if (
      fresh.thread_id &&
      store.findSetupError(fresh, "attach-verified")?.message !== "auto"
    ) {
      let facts:
        | {
            parentThreadId?: string | null;
            parentNotifications?: string | null;
          }
        | null = null;
      let readErr: string | null = null;
      try {
        const res = await runJson<{
          thread?: {
            parentThreadId?: string | null;
            parentNotifications?: string | null;
          };
        }>(deps.bbCli, ["thread", "show", fresh.thread_id, "--json"]);
        facts = res.thread ?? null;
      } catch (e) {
        readErr = `thread show: ${message(e)}`;
      }
      if (
        facts &&
        facts.parentThreadId === fresh.coordinator_thread_id &&
        facts.parentNotifications === "auto"
      ) {
        store.addSetupError(fresh.id, "attach-verified", "auto");
      } else {
        let err: string | null = readErr;
        try {
          await deps.threads.update({
            threadId: fresh.thread_id,
            parentThreadId: fresh.coordinator_thread_id,
            visibility: "hidden",
          });
        } catch (e) {
          err = `${err ? `${err}; ` : ""}threads.update: ${message(e)}`;
        }
        try {
          await runChecked(deps.bbCli, [
            "thread",
            "update",
            fresh.thread_id,
            "--parent-notifications",
            "auto",
          ]);
        } catch (e) {
          err = `${err ? `${err}; ` : ""}parent-notifications: ${message(e)}`;
        }
        const cur = store.get(fresh.id) ?? fresh;
        if (err) {
          store.addSetupError(fresh.id, "attach-verify", err);
          if (!hasSetupError(cur, "attach-verify-reported")) {
            store.addSetupError(fresh.id, "attach-verify-reported", "1");
            await notifyCoordinator(
              fresh,
              `${fresh.task_key}: привязка исполнителя ${fresh.thread_id} ` +
                `не подтверждена (${err}) — сверка повторяет`,
            );
          }
        } else {
          store.clearSetupError(fresh.id, "attach-verify");
        }
      }
    }
  };

  /**
   * §16.5: after a compaction the coordinator gets one §3 reminder —
   * delegation flow and the HANDOFF location. The newest `thread/compacted`
   * seq per coordinator is the durable cursor (`plugin_meta`), so a plugin
   * restart neither repeats nor loses the reminder.
   */
  const compactionReminders = async (s: ReconcileSummary) => {
    for (const coordId of store.coordinatorThreadIds()) {
      const key = `compact-seq:${coordId}`;
      let events: WatchdogThreadEvent[];
      try {
        events = await deps.threads.events.list({
          threadId: coordId,
          order: "desc",
          limit: "5",
          types: [COMPACTION_EVENT_TYPE],
        });
      } catch (e) {
        s.errors.push(`compact scan ${coordId}: ${message(e)}`);
        continue;
      }
      const latest = events[0];
      const stored = store.metaGet(key);
      if (stored === undefined) {
        // PLUG-184/B1: first sight of this coordinator (e.g. a fresh r25
        // plugin on an old base) — start at the newest compaction; old
        // events owe nobody a reminder.
        store.metaSet(key, String(latest?.seq ?? 0));
        continue;
      }
      const seen = Number(stored);
      if (!latest || latest.seq <= seen) continue;
      let coord: WatchdogThreadDto | null;
      try {
        coord = await getThread(coordId);
      } catch (e) {
        s.errors.push(`compact scan ${coordId}: ${message(e)}`);
        continue;
      }
      if (!coord || coord.deletedAt || coord.archivedAt) {
        store.metaSet(key, String(latest.seq)); // nobody to remind
        continue;
      }
      const counts = store.countsByStatus();
      const parts = Object.entries(counts)
        .map(([st, n]) => `${st}: ${n}`)
        .join(", ");
      try {
        await deps.threads.send({
          threadId: coordId,
          mode: "queue-if-active",
          input: [
            {
              type: "text",
              text:
                `[orchestrator] контекст был сжат — напоминание §3: раздача ` +
                `только через orchestrator_delegate; итоги исполнителей ` +
                `приходят сообщениями [orchestrator] — ждать в форграунде ` +
                `нельзя. Делегирования: ${parts || "нет"}. ` +
                `Хендофф: $BB_THREAD_STORAGE/HANDOFF.md`,
              mentions: [],
            },
          ],
        });
        store.metaSet(key, String(latest.seq));
      } catch (e) {
        s.errors.push(`compact remind ${coordId}: ${message(e)}`);
      }
    }
  };

  /** §16.5 rollout (PLUG-193 #4): give up the last_seq sync after this
   * many incomplete passes (a permanently unreadable journal). */
  const LASTSEQ_SYNC_PASSES = 10;

  /**
   * §16.5 rollout (PLUG-190): delegations closed BEFORE the delivery
   * columns existed carry a stale `last_seq` — on the live base ten
   * terminal rows had turn/started events above their cursor, so the
   * first post-upgrade event would revive them on a HISTORICAL turn or
   * suppress a thread's CURRENT work. One pass lifts every such row's
   * cursor to its thread's journal tip; `plugin_meta` makes it
   * once-per-install, and a journal that cannot be read retries the
   * pass on the next reconcile (a gone thread cannot revive — it counts
   * as synced). PLUG-193 #4: the scope is rows terminal AT THE
   * MIGRATION (`result_notice='legacy'`, `listLegacyTerminal`) — a row
   * closed after the rollout keeps its live cursor so a genuine
   * post-cursor turn still reaches the §16.2 wake rule.
   */
  const syncTerminalLastSeq = async (s: ReconcileSummary) => {
    if (store.metaGet("legacy-lastseq") === "1") return;
    let complete = true;
    for (const row of store.listLegacyTerminal()) {
      let tip: WatchdogThreadEvent[] | undefined;
      try {
        tip = await deps.threads.events.list({
          threadId: row.thread_id!,
          order: "desc",
          limit: "1",
        });
      } catch {
        tip = undefined;
      }
      if (tip === undefined) {
        // An unreadable journal retries next pass unless the thread
        // itself is gone (a gone thread cannot produce a reviving turn).
        let gone = false;
        try {
          const t = await getThread(row.thread_id);
          gone = !t || !!t.deletedAt || !!t.archivedAt;
        } catch (e) {
          s.errors.push(`lastseq sync ${row.thread_id}: ${message(e)}`);
        }
        if (!gone) complete = false;
        continue;
      }
      if (tip[0]) store.advanceLastSeq(row.id, tip[0]!.seq);
    }
    if (complete) {
      store.metaSet("legacy-lastseq", "1");
      return;
    }
    // PLUG-193 #4: an unrecoverable read must not rescan the whole
    // terminal list forever — bound the retries, then record the flag
    // with a journal error (the unscanned rows keep a stale cursor and
    // are still covered by the §16.2 wake scan below).
    const attempts =
      Number(store.metaGet("legacy-lastseq-attempts") ?? "0") + 1;
    store.metaSet("legacy-lastseq-attempts", String(attempts));
    if (attempts >= LASTSEQ_SYNC_PASSES) {
      store.metaSet("legacy-lastseq", "1");
      log.error?.(
        `orchestrator: lastseq sync incomplete after ${attempts} ` +
          `passes — giving up`,
      );
    }
  };

  /**
   * §16.2 r25 (PLUG-193 #3): a plugin restart mid-turn loses the
   * `experimental_thread.events` kick — the reconcile pass applies the
   * revive rule to every terminal row whose journal still holds
   * post-cursor turns. Bounded: each terminal row is scanned ONCE per
   * process start — an unreadable journal keeps the row pending for
   * the next pass, a gone thread counts as scanned (it cannot produce
   * a reviving turn). Wakes while the plugin runs arrive through
   * onThreadEvents.
   */
  let terminalWakesPrimed = false;
  const terminalWakesPending = new Set<number>();
  const scanTerminalWakes = async (s: ReconcileSummary) => {
    if (!terminalWakesPrimed) {
      terminalWakesPrimed = true;
      for (const row of store.listTerminalWithThread()) {
        terminalWakesPending.add(row.id);
      }
    }
    for (const id of [...terminalWakesPending]) {
      const row = store.get(id);
      if (!row || isActive(row.status) || !row.thread_id) {
        terminalWakesPending.delete(id);
        continue;
      }
      s.scanned++;
      const verdict = await scanTerminalWake(row);
      if (verdict !== "unreadable") {
        terminalWakesPending.delete(id);
        continue;
      }
      // Unreadable journal — retry next pass unless the thread is gone.
      let gone = false;
      try {
        const t = await getThread(row.thread_id);
        gone = !t || !!t.deletedAt || !!t.archivedAt;
      } catch (e) {
        s.errors.push(`wake scan ${row.thread_id}: ${message(e)}`);
      }
      if (gone) terminalWakesPending.delete(id);
    }
  };

  const reconcile = async (): Promise<ReconcileSummary> => {
    const summary: ReconcileSummary = {
      scanned: 0,
      cancelled: 0,
      relinked: 0,
      removed: 0,
      finalized: 0,
      retriedSteps: 0,
      errors: [],
    };
    for (const row of store.listActive()) {
      summary.scanned++;
      try {
        if (row.status === "dispatching") {
          await reconcileDispatching(row, summary);
        } else {
          await reconcileRunning(row, summary);
        }
      } catch (e) {
        summary.errors.push(`delegation #${row.id}: ${message(e)}`);
      }
    }
    // §5.4 rev 13/23: stalled/quota/failed rows whose stop never confirmed
    // get the stop retried; once confirmed, the reissue decision runs as
    // usual. §7: bounded by retry_count — exhausted rows stop retrying.
    for (const row of store.listByStatuses(["stalled", "quota", "failed"])) {
      if (!hasSetupError(row, "watchdog-stop")) continue;
      if (hasSetupError(row, "retry-exhausted")) continue;
      summary.scanned++;
      try {
        if (await confirmStop(row)) {
          const detail =
            store.findSetupError(row, "outcome-detail")?.message ?? "";
          store.clearSetupError(row.id, "watchdog-stop");
          store.clearSetupError(row.id, "watchdog-stop-reported");
          store.resetRetry(row.id);
          const cur = store.get(row.id) ?? row;
          // PLUG-190: `failed` on a level without autoFallback was already
          // reported by toFailed — the retry only owed the auto-retry
          // cancel, not a second «завершился с ошибкой» message.
          if (cur.status === "failed") {
            const info = await routeInfo(cur);
            if (!info.level?.autoFallback) continue;
          }
          await outcomeAndMaybeReissue(
            cur,
            cur.status as "stalled" | "quota" | "failed",
            detail,
          );
        } else {
          const fresh = store.get(row.id) ?? row;
          await trackRetry(
            fresh,
            "остановка исполнителя",
            store.findSetupError(fresh, "watchdog-stop")?.message ??
              "stop not confirmed",
          );
        }
      } catch (e) {
        summary.errors.push(`delegation #${row.id}: ${message(e)}`);
      }
    }
    // §16.5 rollout: stale cursors on pre-upgrade terminal rows first —
    // a historical turn must not decide revive/suppress below.
    try {
      await syncTerminalLastSeq(summary);
    } catch (e) {
      summary.errors.push(`lastseq sync: ${message(e)}`);
    }
    // §16.2 r25: terminal rows with post-cursor turns (a wake missed at
    // a plugin restart) get the revive rule once per process start.
    try {
      await scanTerminalWakes(summary);
    } catch (e) {
      summary.errors.push(`terminal wakes: ${message(e)}`);
    }
    // §16.5: every done/cancelled row delivers its result exactly once —
    // the pass resends until `result_notified_at` records the delivery.
    for (const row of store.listPendingResult()) {
      summary.scanned++;
      try {
        await deliverResult(row);
      } catch (e) {
        summary.errors.push(`delegation #${row.id}: ${message(e)}`);
      }
    }
    // §16.5: the post-compaction §3 reminder — one per compaction event.
    try {
      await compactionReminders(summary);
    } catch (e) {
      summary.errors.push(`compact reminders: ${message(e)}`);
    }
    return summary;
  };

  return {
    onThreadEvents: (payload: { thread: WatchdogThreadDto; sequence?: number }) =>
      deps.enqueue(() => onThreadEvents(payload)),
    onThreadActive: (thread: WatchdogThreadDto) =>
      deps.enqueue(() => onThreadActive(thread)),
    onThreadIdle: (thread: WatchdogThreadDto) =>
      deps.enqueue(() => onThreadIdle(thread)),
    onThreadFailed: (thread: WatchdogThreadDto, error: string | null) =>
      deps.enqueue(() => onThreadFailed(thread, error)),
    onTurnFailed: (event: TurnFailedInfo) =>
      deps.enqueue(() => onTurnFailed(event)),
    onInteractionPending: (thread: WatchdogThreadDto, interaction: unknown) =>
      deps.enqueue(() => onInteractionPending(thread, interaction)),
    onThreadGone: (
      thread: WatchdogThreadDto,
      reason: "archived" | "deleted" | "not-found",
    ) => deps.enqueue(() => onThreadGone(thread, reason)),
    checkTimers: () => deps.enqueue(() => checkTimers()),
    reconcile: () => deps.enqueue(() => reconcile()),
  };
}

export type Watchdog = ReturnType<typeof createWatchdog>;
