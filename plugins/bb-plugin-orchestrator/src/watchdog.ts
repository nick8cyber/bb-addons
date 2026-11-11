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
  quotaGroupForProvider,
  quotaGroupOf,
  type PolicyLoad,
  type PolicyRoute,
} from "./policy.js";
import type { DelegationRow, DelegationStore } from "./store.js";
import { runChecked, runJson, type BbCli } from "./bb-cli.js";
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
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The thread DTO subset the watchdog reads (status + tombstones). */
export interface WatchdogThreadDto {
  id: string;
  status?: string | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
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
    // §2.3 r24: a `preset:` one-off is not in the policy routes — its
    // quota group is the same-provider policy route's group, else the
    // provider name, so a quota burn holds the provider's routes too.
    const quotaGroup = route
      ? quotaGroupOf(route, row.route)
      : row.route.startsWith("preset:")
        ? quotaGroupForProvider(load.policy, row.provider)
        : row.route;
    return {
      load,
      policy: load.policy,
      level: load.policy?.levels[row.level],
      route,
      quotaGroup,
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
   * §5.4 rev 13: a reissue is allowed only after the old executor is
   * confirmed stopped — `threads.stop` answered without an error AND the
   * thread is not `active`. Returns true when confirmed; on failure the
   * `watchdog-stop` setup error marks the row for the §7 retry.
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
      thread = await deps.threads.get({ threadId: row.thread_id });
    } catch (e) {
      return fail(`threads.get: ${message(e)}`);
    }
    if (thread && thread.status === "active") {
      return fail("thread is still active after stop");
    }
    return true;
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
    let nextName: string | undefined;
    let nextRoute: PolicyRoute | undefined;
    if (info.level?.autoFallback && info.policy) {
      // §5.4 rev 13 + §16.8: for a route in the chain the candidates are
      // the routes AFTER the current one; for an explicit --route/--preset
      // outside the chain (`idx === -1`) reissue starts from the chain's
      // beginning. Only routes an auto-reissue already used are excluded
      // (`reissue_of IS NOT NULL`), manual delegations do not count.
      const used = store.routesUsedByTask(row.task_key);
      const held = store.heldGroups(now());
      const unavailable = new Set(info.load.unavailableRoutes);
      const idx = info.level.chain.indexOf(row.route);
      const candidates = idx === -1 ? info.level.chain : info.level.chain.slice(idx + 1);
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
    store.hold(info.quotaGroup, now() + QUOTA_HOLD_MS, detail.slice(0, 200));
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
    // §5.3: comment, no reissue. The interrupt/archive/delete already
    // stopped the thread — nothing to stop.
    await commentOnTask(
      fresh,
      `делегирование отменено: ${reason} (задача ${fresh.task_key}, ` +
        `маршрут ${fresh.route}, тред ${fresh.thread_id ?? "—"})`,
    );
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
      // §5.2: the typed category first, the text patterns as fallback.
      const category = (
        data.errorInfo as { category?: unknown } | undefined
      )?.category;
      if (typeof category === "string" && QUOTA_CATEGORIES.has(category)) {
        await toQuota(row, `${ev.type}: ${category}`);
        return true;
      }
      if (text) {
        const info = await routeInfo(row);
        if (matchesQuota(text, info.patterns)) {
          await toQuota(row, `${ev.type}: ${text.slice(0, 200)}`);
          return true;
        }
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
        store.setFirstResponse(id, ev.createdAt);
      }
      return false;
    }
    if (RESPONSE_EVENT_TYPES.has(ev.type)) {
      store.setFirstResponse(id, ev.createdAt);
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
      if (commits === 0) problems.push("коммитов нет");
      if (dirty) problems.push("копия грязная (незакоммиченные правки)");
      if (problems.length) {
        await notifyCoordinator(
          row,
          `${row.task_key}: итог захода ${row.round} сомнителен — ` +
            `${problems.join("; ")}. Копия: ${env.path}, ` +
            `HEAD ${sha.slice(0, 12)}`,
        );
      }
    } catch (e) {
      store.addSetupError(row.id, "round-result", message(e));
    }
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
      store.setStatus(row.id, "done");
      clearMarks(row.id);
      await collectRoundResult(store.get(row.id) ?? row);
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
    if (!row || !isActive(row.status)) return;
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
      fresh = store.get(row.id);
      if (!fresh || fresh.status !== "running") return;
    }
    // §7: repeat unfinished §4.4–4.6 steps (setup_errors + the bypass check).
    const retried = await deps.retrySetup(fresh);
    s.retriedSteps += retried.length;
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
