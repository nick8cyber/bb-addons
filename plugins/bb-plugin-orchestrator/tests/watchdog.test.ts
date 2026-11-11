import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS, type DelegationRow } from "../src/store.js";
import { parsePolicy } from "../src/policy.js";
import { OrchestratorError } from "../src/errors.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import {
  createDelegateQueue,
  dispatchToRoute,
  finishDispatchSteps,
  retrySetupSteps,
} from "../src/delegate.js";
import {
  createWatchdog,
  findTaskThreadId,
  type WatchdogDeps,
  type WatchdogThreadDto,
  type WatchdogThreadEvent,
} from "../src/watchdog.js";

const POLICY = JSON.stringify({
  version: 1,
  firstResponseSeconds: 30,
  maxRunSeconds: 300,
  levels: {
    simple: { chain: ["simple", "simple-alt"], autoFallback: true },
    strict: { chain: ["strict"], autoFallback: false },
  },
  routes: {
    simple: { preset: "simple", provider: "acp-opencode", quotaGroup: "zen" },
    "simple-alt": { preset: "simple-alt", provider: "agy" },
    strict: { preset: "strict", provider: "acp-devin" },
  },
});
const PRESETS = new Set(["simple", "simple-alt", "strict"]);

const T0 = 1_700_000_000_000;
const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

const ev = (
  seq: number,
  type: string,
  createdAt: number,
  data: Record<string, unknown> = {},
): WatchdogThreadEvent => ({ seq, type, createdAt, data });

function makeHarness(
  opts: {
    policyText?: string;
    cli?: (args: string[]) => BbCliResult | undefined;
    dispatchThreadId?: string;
    /** Throw on the first N `threads.stop` calls (confirmStop tests). */
    stopFails?: number;
    /** Throw on the first N `threads.send` calls (§16.5 resend tests). */
    sendFails?: number;
    /** §16.1: provider-retry status/cancel fail counts. */
    retryStatusFails?: number;
    retryCancelFails?: number;
    /** §16.1: first N cancels answer `no_pending_retry` (row fired early). */
    retryCancelNoPending?: number;
    /** §4.1 round-result seam; absent → the done path skips collection. */
    round?: WatchdogDeps["round"];
    /** B1: a pre-migrated "old" database — caller drives the schema. */
    db?: import("better-sqlite3").Database;
  } = {},
) {
  const db = opts.db ?? new Database(":memory:");
  if (!opts.db) for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const calls: string[][] = [];
  const cli: BbCli = {
    run: async (args) => {
      calls.push(args);
      const custom = opts.cli?.(args);
      if (custom) return custom;
      const key = args.join(" ");
      if (key.startsWith("tasks dispatch")) {
        return ok(
          JSON.stringify({
            task: { id: "t-1" },
            threadId: opts.dispatchThreadId ?? "thr_new",
          }),
        );
      }
      if (key.startsWith("tasks preset show"))
        return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
      if (key.startsWith("tasks threads"))
        return ok(JSON.stringify({ taskThreads: [] }));
      // §16.5 attach-verify: `bb thread show <id> --json` answers the
      // thread facts from the DTO map (parentNotifications included).
      if (args[0] === "thread" && args[1] === "show") {
        const dto = threadDtos.get(args[2]!);
        if (!dto)
          return { exitCode: 1, stdout: "", stderr: "thread not found" };
        return ok(JSON.stringify({ thread: dto }));
      }
      // `bb thread update <id> --parent-notifications <v>` applies to the DTO.
      if (args[0] === "thread" && args[1] === "update") {
        const dto = threadDtos.get(args[2]!);
        const i = args.indexOf("--parent-notifications");
        if (dto && i >= 0) {
          (dto as { parentNotifications?: string }).parentNotifications =
            args[i + 1];
        }
        return ok();
      }
      return ok();
    },
  };

  const sends: { threadId: string; mode: string; input: unknown[] }[] = [];
  const stops: string[] = [];
  const updates: unknown[] = [];
  /** §16.5: watchdog `threads.update` calls (binding re-verify). */
  const wdUpdates: {
    threadId: string;
    parentThreadId?: string | null;
    visibility?: string;
  }[] = [];
  /** §16.5: `threads.output` answers — the executor's report text. */
  const outputs = new Map<string, string | null>();
  /** §16.1: pending provider-retry rows per thread. */
  const retryPendingRows = new Map<string, unknown[]>();
  /** §16.1: scripted `pending` answers — each call shifts one entry. */
  const retryStatusScript: unknown[][] = [];
  const retryCancels: string[] = [];
  const retryKnobs = {
    statusFails: opts.retryStatusFails ?? 0,
    cancelFails: opts.retryCancelFails ?? 0,
    cancelNoPending: opts.retryCancelNoPending ?? 0,
  };
  /** Call-order record: `stop:<id>`, `retry-status:<id>`, `retry-cancel:<id>`. */
  const ops: string[] = [];
  const eventLog = new Map<string, WatchdogThreadEvent[]>();
  const threadDtos = new Map<string, WatchdogThreadDto>();
  const queues = new Map<string, unknown[]>();
  /** §5.1 rev 18: threadIds whose journal reads must fail (server down). */
  const eventsBlocked = new Set<string>();
  /** §16.5: the status a successful `threads.stop` leaves behind. */
  const stopResult = { status: "idle" as string | null };
  let sendFailsLeft = opts.sendFails ?? 0;
  const threads = {
    get: async ({ threadId }: { threadId: string }) => {
      const dto = threadDtos.get(threadId);
      if (!dto) throw new Error(`thread not found: ${threadId}`);
      return dto;
    },
    events: {
      list: async (args: {
        threadId: string;
        afterSeq?: string;
        order?: "asc" | "desc";
        limit?: string;
        types?: readonly string[];
      }) => {
        // The live BB server refuses pages over 100 (§5.1 rev 18).
        if (Number(args.limit) > 100) {
          throw new Error("Thread event limit cannot exceed 100");
        }
        if (eventsBlocked.has(args.threadId)) {
          throw new Error("events.list unavailable (test)");
        }
        let rows = (eventLog.get(args.threadId) ?? []).slice();
        if (args.types?.length) {
          rows = rows.filter((r) => args.types!.includes(r.type));
        }
        if (args.afterSeq !== undefined) {
          rows = rows.filter((r) => r.seq > Number(args.afterSeq));
        }
        rows.sort((a, b) =>
          args.order === "desc" ? b.seq - a.seq : a.seq - b.seq,
        );
        if (args.limit) rows = rows.slice(0, Number(args.limit));
        return rows;
      },
    },
    queuedMessages: {
      list: async ({ threadId }: { threadId: string }) =>
        queues.get(threadId) ?? [],
    },
    send: async (args: {
      threadId: string;
      mode: "queue-if-active";
      input: unknown[];
    }) => {
      if (sendFailsLeft > 0) {
        sendFailsLeft--;
        throw new Error("send failed (test)");
      }
      sends.push(args);
      return {};
    },
    stop: async ({ threadId }: { threadId: string }) => {
      const row = store.byThreadId(threadId);
      statusAtStop.push(row?.status ?? "none");
      stops.push(threadId);
      ops.push(`stop:${threadId}`);
      if (stopFailsLeft > 0) {
        stopFailsLeft--;
        throw new Error("stop failed (test)");
      }
      const dto = threadDtos.get(threadId);
      if (dto) dto.status = stopResult.status;
      return {};
    },
    output: async ({ threadId }: { threadId: string }) => {
      if (!threadDtos.has(threadId) && !outputs.has(threadId)) {
        throw new Error(`thread not found: ${threadId}`);
      }
      return { output: outputs.get(threadId) ?? null };
    },
    update: async (a: {
      threadId: string;
      parentThreadId?: string | null;
      visibility?: string;
    }) => {
      wdUpdates.push(a);
      const dto = threadDtos.get(a.threadId);
      if (dto && a.parentThreadId !== undefined) {
        dto.parentThreadId = a.parentThreadId;
      }
      return {};
    },
  };
  let stopFailsLeft = opts.stopFails ?? 0;
  const statusAtStop: (string | undefined)[] = [];

  let nowVal = T0;
  const enqueue = createDelegateQueue();
  const stepsDeps = {
    store,
    bbCli: cli,
    threads: {
      update: async (a: unknown) => {
        updates.push(a);
        return {};
      },
      stop: threads.stop,
    },
  };
  const warns: string[] = [];
  const wd = createWatchdog({
    store,
    bbCli: cli,
    threads,
    loadPolicy: async () => parsePolicy(opts.policyText ?? POLICY, PRESETS),
    dispatch: (row, opts) => dispatchToRoute(row, opts ?? {}, stepsDeps),
    finalize: (row) => finishDispatchSteps(row, stepsDeps),
    retrySetup: (row) => retrySetupSteps(row, stepsDeps),
    providerRetry: {
      pending: async (threadId) => {
        ops.push(`retry-status:${threadId}`);
        if (retryKnobs.statusFails > 0) {
          retryKnobs.statusFails--;
          throw new Error("provider-retry status failed (test)");
        }
        if (retryStatusScript.length > 0) {
          return retryStatusScript.shift()!;
        }
        return retryPendingRows.get(threadId) ?? [];
      },
      cancel: async (threadId) => {
        if (retryKnobs.cancelFails > 0) {
          retryKnobs.cancelFails--;
          throw new Error("provider-retry cancel failed (test)");
        }
        if (retryKnobs.cancelNoPending > 0) {
          retryKnobs.cancelNoPending--;
          ops.push(`retry-cancel:${threadId}`);
          throw new Error(
            "bb provider-retry cancel failed (exit 1): no_pending_retry",
          );
        }
        ops.push(`retry-cancel:${threadId}`);
        retryCancels.push(threadId);
        // §16.1: BB's cancel drops ONE queued row per call.
        const rows = retryPendingRows.get(threadId) ?? [];
        rows.shift();
        if (rows.length) retryPendingRows.set(threadId, rows);
        else retryPendingRows.delete(threadId);
      },
    },
    ...(opts.round ? { round: opts.round } : {}),
    enqueue,
    now: () => nowVal,
    log: { warn: (m) => warns.push(m), info: () => {}, error: () => {} },
  });

  const insertActive = (input: {
    taskKey?: string;
    level?: string;
    route?: string;
    preset?: string;
    provider?: string;
    threadId?: string | null;
    status?: "dispatching" | "running";
    createdAt?: number;
  } = {}): DelegationRow => {
    const row = store.insert({
      taskKey: input.taskKey ?? "PLUG-1",
      coordinatorThreadId: "thr_coord",
      projectId: "proj_main",
      level: input.level ?? "simple",
      route: input.route ?? "simple",
      preset: input.preset ?? "simple",
      provider: input.provider ?? "acp-opencode",
    });
    if (input.threadId) store.setThreadInfo(row.id, input.threadId);
    store.setStatus(row.id, input.status ?? "running");
    if (input.createdAt !== undefined) {
      db.prepare(`UPDATE delegations SET created_at = ? WHERE id = ?`).run(
        input.createdAt,
        row.id,
      );
    }
    return store.get(row.id)!;
  };

  return {
    store,
    wd,
    db,
    calls,
    sends,
    stops,
    updates,
    eventLog,
    threadDtos,
    queues,
    eventsBlocked,
    warns,
    statusAtStop,
    outputs,
    wdUpdates,
    retryPendingRows,
    retryStatusScript,
    retryCancels,
    retryKnobs,
    ops,
    stopResult,
    insertActive,
    setNow: (v: number) => {
      nowVal = v;
    },
    getNow: () => nowVal,
  };
}

const dto = (
  id: string,
  status = "active",
  extra: Partial<WatchdogThreadDto> = {},
): WatchdogThreadDto => ({
  id,
  status,
  archivedAt: null,
  deletedAt: null,
  ...extra,
});

test("first response in time: no stall, markers recorded", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "item/started", T0 + 1000, { item: { type: "userMessage" } }),
    ev(3, "item/started", T0 + 2000, { item: { type: "agentMessage" } }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 3 });
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.turn_started_at, T0);
  assert.equal(fresh.first_response_at, T0 + 2000); // userMessage is not a response
  assert.equal(fresh.last_seq, 3);
  h.setNow(T0 + 120_000);
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "running");
  assert.deepEqual(h.stops, []);
});

test("silence past firstResponseSeconds → stalled, stop, auto-reissue", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();

  const old = h.store.get(row.id)!;
  assert.equal(old.status, "reissued");
  assert.deepEqual(h.stops, ["thr_e1"]);
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.route, "simple-alt");
  assert.equal(fresh.thread_id, "thr_new");
  assert.equal(fresh.reissue_of, row.id);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]!.mode, "queue-if-active");
  assert.match(
    JSON.stringify(h.sends[0]!.input),
    /\[orchestrator\].*перевыпущено на simple-alt/,
  );
  assert.ok(
    h.calls.some((c) => c.join(" ").startsWith("tasks comment PLUG-1")),
    "expected a task comment",
  );
});

test("autoFallback=false: executor stopped, no reissue", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();

  assert.equal(h.store.get(row.id)!.status, "stalled");
  assert.deepEqual(h.stops, ["thr_e1"]);
  assert.equal(h.store.listActive().length, 0);
  assert.match(JSON.stringify(h.sends[0]!.input), /перевыпуск за координатором/);
  assert.ok(
    !h.calls.some((c) => c.join(" ").startsWith("tasks dispatch")),
    "no dispatch expected",
  );
});

test("quota by errorInfo.category → route_holds on the quota group + reissue", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  await h.wd.onTurnFailed({
    threadId: "thr_e1",
    errorInfo: { category: "rate-limit" },
  });

  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.deepEqual(h.stops, ["thr_e1"]);
  const held = h.store.heldGroups(h.getNow());
  assert.ok(held.has("zen"), "quota group held");
  const holdRow = h.store.holds().find((r) => r.quota_group === "zen")!;
  assert.ok(holdRow.until - h.getNow() <= 15 * 60 * 1000);
  assert.ok(holdRow.until - h.getNow() > 14 * 60 * 1000);
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "simple-alt"); // another quota group
  assert.equal(fresh.status, "running");
});

test("§16.1: mid-turn quota TEXT does not transition; turn-ending text does", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "provider/error", T0, { message: "Free usage limit reached" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  // §16.1: text patterns mid-turn are noise — only errorInfo.category may
  // transition an ACTIVE turn; the row stays running.
  assert.equal(h.store.get(row.id)!.status, "running");
  assert.equal(h.store.heldGroups(h.getNow()).size, 0);

  // The turn ending with the same error text is still quota.
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "provider/error", T0, { message: "Free usage limit reached" }),
    ev(3, "turn/completed", T0 + 1000, {
      error: { message: "Free usage limit reached" },
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 3 });
  assert.equal(h.store.get(row.id)!.status, "quota"); // autoFallback off → stays
  assert.ok(h.store.heldGroups(h.getNow()).has("strict"));
  assert.equal(h.store.listActive().length, 0);
});

test("approval → one coordinator message per 10 minutes", async () => {
  const h = makeHarness();
  h.insertActive({ threadId: "thr_e1" });
  const thread = dto("thr_e1", "active");
  const inter = { id: "int_1", payload: { kind: "approval", subject: { command: "rm -rf /tmp/x" } } };
  await h.wd.onInteractionPending(thread, inter);
  await h.wd.onInteractionPending(thread, inter);
  assert.equal(h.sends.length, 1);
  assert.match(JSON.stringify(h.sends[0]!.input), /interactions approve/);
  h.setNow(h.getNow() + 11 * 60 * 1000);
  await h.wd.onInteractionPending(thread, inter);
  assert.equal(h.sends.length, 2);
});

test("timeout → one coordinator message, never repeated", async () => {
  const h = makeHarness();
  h.insertActive({ threadId: "thr_e1", createdAt: T0 - 400_000 });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  await h.wd.checkTimers();
  assert.equal(h.sends.length, 1);
  assert.match(JSON.stringify(h.sends[0]!.input), /maxRunSeconds/);
  await h.wd.checkTimers();
  assert.equal(h.sends.length, 1);
});

test("idle with a non-empty queue stays running; empty → done", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0 - 1000)]);
  h.queues.set("thr_e1", [{ id: "q1" }]);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "running");
  h.queues.set("thr_e1", []);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "done");
});

test("external stop: interrupted + idle → cancelled, not done", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "system/thread/interrupted", T0, { reason: "manual-stop" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "cancelled");
  assert.ok(
    h.calls.some((c) => c.join(" ").startsWith("tasks comment PLUG-1")),
  );
});

test("own stop after stalled is not misread as cancelled", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "stalled");
  // the stop we issued idles the thread — must not flip to cancelled
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "stalled");
});

test("deleted thread → cancelled; archived too", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  await h.wd.onThreadGone(dto("thr_e1"), "deleted");
  assert.equal(h.store.get(row.id)!.status, "cancelled");

  const row2 = h.insertActive({ taskKey: "PLUG-2", threadId: "thr_e2" });
  h.threadDtos.set("thr_e2", dto("thr_e2", "idle", { archivedAt: T0 }));
  await h.wd.reconcile();
  assert.equal(h.store.get(row2.id)!.status, "cancelled");
});

test("reconcile: dispatching without thread_id relinks via bb tasks threads", async () => {
  const h = makeHarness({
    cli: (args) => {
      if (args.join(" ").startsWith("tasks threads"))
        return ok(
          JSON.stringify({
            taskThreads: [
              { threadId: "thr_e2", attachedAt: new Date(T0 - 1000).toISOString() },
            ],
          }),
        );
      return undefined;
    },
  });
  // restart-mid-reissue state: transaction done, dispatch not yet run
  const row = h.insertActive({
    threadId: null,
    status: "dispatching",
    createdAt: T0 - 6 * 60_000,
  });
  const summary = await h.wd.reconcile();
  assert.equal(summary.relinked, 1);
  assert.equal(summary.finalized, 1);
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.thread_id, "thr_e2");
  assert.equal(fresh.status, "running");
  // one active row only — no duplicate delegation
  assert.equal(h.store.listActive().length, 1);
  assert.ok(
    !h.calls.some((c) => c.join(" ").startsWith("tasks dispatch")),
    "no re-dispatch",
  );
});

test("reconcile: dispatching without thread_id and no task thread → removed + comment", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: null,
    status: "dispatching",
    createdAt: T0 - 6 * 60_000,
  });
  const summary = await h.wd.reconcile();
  assert.equal(summary.removed, 1);
  assert.equal(h.store.get(row.id), undefined);
  assert.ok(
    h.calls.some(
      (c) =>
        c.join(" ").startsWith("tasks comment PLUG-1") &&
        c.join(" ").includes("не подтверждена"),
    ),
  );
});

test("reconcile: dispatching with thread_id older than 5 min → steps 4–6 finished", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    status: "dispatching",
    createdAt: T0 - 6 * 60_000,
  });
  const summary = await h.wd.reconcile();
  assert.equal(summary.finalized, 1);
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.deepEqual(h.updates, [
    { threadId: "thr_e1", parentThreadId: "thr_coord", visibility: "hidden" },
  ]);
  assert.ok(
    h.calls.some(
      (c) => c.join(" ") === "thread update thr_e1 --parent-notifications stuck",
    ),
  );
  assert.ok(
    h.calls.some(
      (c) =>
        c.join(" ").startsWith("tasks comment PLUG-1") &&
        c.join(" ").includes("Раздано"),
    ),
  );
});

test("reconcile: running row retries recorded setup_errors and clears them", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.store.addSetupError(row.id, "comment", "comments closed");
  h.store.addSetupError(row.id, "attach", "sdk down");
  // give the row a turn so idle evaluation lands on done… no: keep it
  // running — the retry happens before any terminal evaluation anyway
  // when the thread is idle only with an empty queue. Use a queued
  // message to hold it running.
  h.queues.set("thr_e1", [{ id: "q1" }]);
  const summary = await h.wd.reconcile();
  assert.equal(h.store.get(row.id)!.status, "running");
  assert.ok(
    h.calls.some(
      (c) =>
        c.join(" ").startsWith("tasks comment PLUG-1") &&
        c.join(" ").includes("Раздано"),
    ),
  );
  assert.deepEqual(h.updates, [
    { threadId: "thr_e1", parentThreadId: "thr_coord", visibility: "hidden" },
  ]);
  // the real errors are cleared; the bypass-settled marker may stay
  assert.doesNotMatch(
    h.store.get(row.id)!.setup_errors,
    /"step":"(comment|attach)"/,
  );
  assert.equal(summary.retriedSteps, 0); // both retries succeeded
});

test("reissue never picks a route the task already ran on", async () => {
  const h = makeHarness();
  // first delegation already used both chain routes: simple (reissued)
  // and simple-alt (running, now stalls) → no route left → stays stalled.
  const row1 = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.store.setStatus(row1.id, "stalled");
  const row2 = h.store.reissue(row1.id, {
    route: "simple-alt",
    preset: "simple-alt",
    provider: "agy",
  })!;
  h.store.setThreadInfo(row2.id, "thr_e2");
  h.store.setStatus(row2.id, "running");
  h.threadDtos.set("thr_e2", dto("thr_e2", "active"));
  h.eventLog.set("thr_e2", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e2"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();

  assert.equal(h.store.get(row2.id)!.status, "stalled");
  assert.equal(h.store.listActive().length, 0);
  assert.match(
    JSON.stringify(h.sends[0]!.input),
    /нет доступного маршрута в цепочке/,
  );
});

test("findTaskThreadId picks the thread attached after the record", async () => {
  const h = makeHarness();
  const cli: BbCli = {
    run: async (args) => {
      if (args.join(" ").startsWith("tasks threads"))
        return ok(
          JSON.stringify({
            taskThreads: [
              { threadId: "thr_old", attachedAt: new Date(T0 - 60_000).toISOString() },
              { threadId: "thr_new", attachedAt: new Date(T0 + 1000).toISOString() },
            ],
          }),
        );
      return ok();
    },
  };
  const id = await findTaskThreadId(cli, "PLUG-1", T0);
  assert.equal(id, "thr_new");
});

// ── Доработка по ревью PLUG-144 / спека rev 13 ──────────────────────────

test("stalled decision drains the stream first: a pending response cancels it", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  // turn/started processed (window open); the response lands in the
  // journal afterwards but is not yet processed (debounce/queue lag)
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "item/agentMessage/delta", T0 + 5000, { text: "hi" }),
  ]);
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.first_response_at, T0 + 5000);
  assert.deepEqual(h.stops, []);
});

test("unconfirmed stop: no reissue, one message, reconcile retries the stop", async () => {
  const h = makeHarness({ stopFails: 1 });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();

  const stalled = h.store.get(row.id)!;
  assert.equal(stalled.status, "stalled"); // status kept, NOT reissued
  assert.equal(h.store.listActive().length, 0);
  assert.equal(h.store.listByStatuses(["reissued"]).length, 0);
  assert.equal(h.stops.length, 1); // attempted once, failed
  assert.match(stalled.setup_errors, /watchdog-stop/);
  assert.equal(h.sends.length, 1);
  assert.match(
    JSON.stringify(h.sends[0]!.input),
    /не удалось остановить исполнителя/,
  );

  // reconcile retries: now stop succeeds → the §5.4 decision runs
  const summary = await h.wd.reconcile();
  assert.equal(h.store.get(row.id)!.status, "reissued");
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "simple-alt");
  assert.equal(fresh.status, "running");
  assert.equal(fresh.reissue_of, row.id);
  assert.ok(summary.errors.length === 0);
});

test("interrupted (non-manual reason): resume once, stalled on repeat", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "system/thread/interrupted", T0, { reason: "host-daemon-restarted" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });

  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.resume_count, 1);
  // window for the new turn opened at the interrupt (rev 15)
  assert.equal(fresh.turn_started_at, T0);
  assert.equal(fresh.first_response_at, null);
  assert.match(fresh.setup_errors, /resume-await/);
  // message to the executor + coordinator notification
  const executorMsg = h.sends.find((s) => s.threadId === "thr_e1");
  const coordMsg = h.sends.find((s) => s.threadId === "thr_coord");
  assert.ok(executorMsg, "executor resume expected");
  assert.match(JSON.stringify(executorMsg!.input), /продолжай задачу/);
  assert.ok(coordMsg, "coordinator notification expected");

  // a second interruption → stalled path
  h.eventLog.set("thr_e1", [
    ev(3, "system/thread/interrupted", T0 + 10_000, { reason: "provider-turn-idle" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 3 });
  assert.equal(h.store.get(row.id)!.status, "stalled");
  assert.deepEqual(h.stops, ["thr_e1"]);
});

test("reconcile drives a reissue_of dispatching row to dispatch + report", async () => {
  const h = makeHarness();
  // restart between the reissue transaction and the dispatch
  const old = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.store.setStatus(old.id, "stalled");
  const row2 = h.store.reissue(old.id, {
    route: "simple-alt",
    preset: "simple-alt",
    provider: "agy",
  })!;
  h.db.prepare(`UPDATE delegations SET created_at = ? WHERE id = ?`).run(
    T0 - 6 * 60_000,
    row2.id,
  );

  const summary = await h.wd.reconcile();
  const fresh = h.store.get(row2.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.thread_id, "thr_new");
  assert.equal(h.store.get(old.id)!.status, "reissued");
  assert.equal(h.store.listActive().length, 1);
  assert.ok(
    h.calls.some((c) => c.join(" ").startsWith("tasks dispatch PLUG-1")),
  );
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /перевыпуск завершён/,
  );
  assert.equal(summary.errors.length, 0);
});

test("reconcile: refused reissue dispatch → new row failed + lost-reissue report", async () => {
  const h = makeHarness({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks dispatch"))
        return { exitCode: 1, stdout: "", stderr: "preset gone" };
      if (key.startsWith("tasks threads"))
        return ok(JSON.stringify({ taskThreads: [] }));
      return ok();
    },
  });
  const old = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.store.setStatus(old.id, "stalled");
  const row2 = h.store.reissue(old.id, {
    route: "simple-alt",
    preset: "simple-alt",
    provider: "agy",
  })!;
  h.db.prepare(`UPDATE delegations SET created_at = ? WHERE id = ?`).run(
    T0 - 6 * 60_000,
    row2.id,
  );

  await h.wd.reconcile();
  const fresh = h.store.get(row2.id)!;
  assert.equal(fresh.status, "failed"); // kept, not removed
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /перевыпуск потерян/,
  );
});

test("turn.failed category upgrades a premature failed to quota + hold", async () => {
  // the first stop fails → the premature `failed` is still standing when
  // the typed category arrives (autoFallback reissues `failed` on its own)
  const h = makeHarness({ stopFails: 1 });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  // race: thread.failed lands first with a non-pattern error text
  await h.wd.onThreadFailed(dto("thr_e1", "error"), "provider blew up");
  assert.equal(h.store.get(row.id)!.status, "failed");
  // then turn.failed arrives carrying the typed signal
  await h.wd.onTurnFailed({
    threadId: "thr_e1",
    errorInfo: { category: "rate-limit" },
  });
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.ok(h.store.heldGroups(h.getNow()).has("zen"));
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "simple-alt");
});

test("provider/error with willRetry=true is not a quota", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    ev(1, "provider/error", T0, {
      message: "rate limit 429, retrying",
      willRetry: true,
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  assert.equal(h.store.get(row.id)!.status, "running");
  assert.equal(h.store.heldGroups(h.getNow()).size, 0);
});

test("provider/error with errorInfo.category is a quota", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    ev(1, "provider/error", T0, {
      message: "nope",
      errorInfo: { category: "billing" },
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  assert.equal(h.store.get(row.id)!.status, "quota");
  assert.ok(h.store.heldGroups(h.getNow()).has("strict"));
});

test("status is written before the stop call (§5.3 order)", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  assert.deepEqual(h.statusAtStop, ["stalled"]); // not "running"
  assert.equal(h.store.get(row.id)!.status, "stalled");
});

test("manual-stop interrupt recovered from the journal after restart", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  // interrupt already consumed in an earlier life: last_seq moved past it,
  // the in-memory flag (lost on restart) is empty
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(5, "system/thread/interrupted", T0 - 500, { reason: "manual-stop" }),
  ]);
  h.store.advanceLastSeq(row.id, 5);
  h.store.setTurnStarted(row.id, T0 - 1000);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "cancelled");
});

test("idle with archivedAt → cancelled (evaluateIdle tombstones)", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle", { archivedAt: T0 }));
  await h.wd.onThreadIdle(dto("thr_e1", "idle", { archivedAt: T0 }));
  assert.equal(h.store.get(row.id)!.status, "cancelled");
});

test("store.reissue refuses non-stalled sources and double reissues", async () => {
  const h = makeHarness();
  const running = h.insertActive({ taskKey: "PLUG-7" });
  assert.equal(
    h.store.reissue(running.id, {
      route: "simple-alt",
      preset: "p",
      provider: "p",
    }),
    undefined,
  );
  h.store.setStatus(running.id, "stalled");
  const next = h.store.reissue(running.id, {
    route: "simple-alt",
    preset: "p",
    provider: "p",
  })!;
  assert.equal(next.reissue_of, running.id);
  // already reissued — a second call must not produce another row
  assert.equal(
    h.store.reissue(running.id, { route: "x", preset: "x", provider: "x" }),
    undefined,
  );
  assert.equal(
    h.store.list().filter((r) => r.task_key === "PLUG-7").length,
    2,
  );
});

test("reissue route choice starts after the current route", async () => {
  const h = makeHarness();
  // delegated explicitly to simple-alt (second in chain); a stall must not
  // walk back to the earlier `simple`
  const row = h.insertActive({ threadId: "thr_e1", route: "simple-alt", preset: "simple-alt", provider: "agy" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "stalled");
  assert.equal(h.store.listActive().length, 0); // no route after simple-alt
  assert.match(JSON.stringify(h.sends[0]!.input), /перевыпуск за координатором/);
});

// ── Доработка №2 по ревью PLUG-145 / спека rev 15 ───────────────────────

test("interrupted + resume send failed → pending resume stalls it", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  // threads.send to the executor fails; the nudge never lands
  const origSend = (h as never as Record<string, unknown>);
  void origSend;
  h.eventLog.set("thr_e1", [
    ev(1, "system/thread/interrupted", T0, { reason: "host-daemon-restarted" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  assert.equal(h.store.get(row.id)!.status, "running");
  assert.match(h.store.get(row.id)!.setup_errors, /resume-await/);

  // no new turn, idle, empty queue → repeat interruption → stalled
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "stalled");
});

test("pending resume caught by checkTimers and by reconcile", async () => {
  // checkTimers path
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.queues.set("thr_e1", []);
  h.eventLog.set("thr_e1", [
    ev(1, "system/thread/interrupted", T0, { reason: "provider-turn-idle" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000); // past firstResponseSeconds=30
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "stalled");

  // reconcile path — same state, second harness
  const h2 = makeHarness();
  const row2 = h2.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h2.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h2.queues.set("thr_e1", []);
  h2.eventLog.set("thr_e1", [
    ev(1, "system/thread/interrupted", T0, { reason: "provider-turn-idle" }),
  ]);
  await h2.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h2.setNow(T0 + 31_000);
  await h2.wd.reconcile();
  assert.equal(h2.store.get(row2.id)!.status, "stalled");
});

test("resumed turn starting clears resume-await (normal lifecycle resumes)", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    ev(1, "system/thread/interrupted", T0, { reason: "provider-turn-idle" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  // the provider starts the new turn on its own
  h.eventLog.set("thr_e1", [
    ev(1, "system/thread/interrupted", T0, { reason: "provider-turn-idle" }),
    ev(2, "turn/started", T0 + 2000),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.doesNotMatch(fresh.setup_errors, /resume-await/);
  h.setNow(T0 + 40_000);
  await h.wd.checkTimers();
  // window reopened, no response → stalled → §5.4 reissue (autoFallback)
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.equal(h.store.listActive()[0]!.route, "simple-alt");
});

test("reissue conflict with a manual active delegation → one message, no retries", async () => {
  const h = makeHarness({ stopFails: 1 });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers(); // stop failed → stalled + watchdog-stop
  assert.equal(h.store.get(row.id)!.status, "stalled");
  // coordinator re-delegates manually while the stop was retrying
  const manual = h.insertActive({
    taskKey: "PLUG-1",
    threadId: "thr_m",
    route: "simple-alt",
    preset: "simple-alt",
    provider: "agy",
  });
  h.threadDtos.set("thr_m", dto("thr_m", "active")); // stays alive in reconcile
  // reconcile confirms the stop → reissue hits the unique index
  await h.wd.reconcile();
  const old = h.store.get(row.id)!;
  assert.equal(old.status, "stalled"); // kept — not reissued
  assert.match(old.setup_errors, /reissue-conflict/);
  const msgs = h.sends.filter((s) =>
    JSON.stringify(s.input).includes("уже есть активное"),
  );
  assert.equal(msgs.length, 1);
  // reconcile does not re-attempt and does not re-message
  await h.wd.reconcile();
  const msgs2 = h.sends.filter((s) =>
    JSON.stringify(s.input).includes("уже есть активное"),
  );
  assert.equal(msgs2.length, 1);
  assert.equal(h.store.get(manual.id)!.status, "running");
});

test("instant reissue dispatch refused → new row failed + lost-reissue report", async () => {
  const h = makeHarness({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks dispatch"))
        return { exitCode: 1, stdout: "", stderr: "provider off" };
      if (key.startsWith("tasks preset show"))
        return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
      if (key.startsWith("tasks threads"))
        return ok(JSON.stringify({ taskThreads: [] }));
      return ok();
    },
  });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();

  assert.equal(h.store.get(row.id)!.status, "reissued");
  const children = h.store.listByStatuses(["failed"]);
  assert.equal(children.length, 1);
  assert.equal(children[0]!.reissue_of, row.id);
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /перевыпуск потерян/,
  );
});

test("10 failed stops → retry-exhausted + one escalation message", async () => {
  const h = makeHarness({ stopFails: 99 });
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "stalled");

  for (let i = 0; i < 10; i++) await h.wd.reconcile();
  const fresh = h.store.get(row.id)!;
  assert.match(fresh.setup_errors, /retry-exhausted/);
  const exhausted = h.sends.filter((s) =>
    JSON.stringify(s.input).includes("исчерпан предел повторов"),
  );
  assert.equal(exhausted.length, 1);
  assert.match(JSON.stringify(exhausted[0]!.input), /orchestrator cancel/);
  // §7: the message carries the last real error, not a dash
  assert.match(JSON.stringify(exhausted[0]!.input), /stop failed \(test\)/);

  // retries stopped for good
  const callsBefore = h.stops.length;
  await h.wd.reconcile();
  assert.equal(h.stops.length, callsBefore);
});

test("turn/completed with a quota-pattern error → quota (not silent)", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/completed", T0, {
      error: { message: "insufficient credits" },
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  assert.equal(h.store.get(row.id)!.status, "quota");
  assert.ok(h.store.heldGroups(h.getNow()).has("strict"));
});

test("findTaskThreadId: dated candidates win; undatable ones still count", async () => {
  const cli: BbCli = {
    run: async (args) => {
      if (args.join(" ").startsWith("tasks threads"))
        return ok(
          JSON.stringify({
            taskThreads: [
              { threadId: "thr_nan", attachedAt: "garbage" },
              { threadId: "thr_late", attachedAt: new Date(T0 + 5000).toISOString() },
              { threadId: "thr_first", attachedAt: new Date(T0 + 1000).toISOString() },
            ],
          }),
        );
      return ok();
    },
  };
  const id = await findTaskThreadId(cli, "PLUG-1", T0);
  assert.equal(id, "thr_first"); // earliest provable candidate wins

  // §5.4 rev 15: a thread whose attachedAt does not parse is still a
  // task thread — taking it beats a duplicate dispatch
  const cli2: BbCli = {
    run: async (args) =>
      args.join(" ").startsWith("tasks threads")
        ? ok(
            JSON.stringify({
              taskThreads: [{ threadId: "thr_only", attachedAt: "??" }],
            }),
          )
        : ok(),
  };
  assert.equal(await findTaskThreadId(cli2, "PLUG-1", T0), "thr_only");
});

test("reconcile: undatable attachedAt relinks instead of a second dispatch", async () => {
  const h = makeHarness({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks threads"))
        return ok(
          JSON.stringify({
            taskThreads: [{ threadId: "thr_undated", attachedAt: "garbage" }],
          }),
        );
      return undefined;
    },
  });
  const old = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.store.setStatus(old.id, "stalled");
  const row2 = h.store.reissue(old.id, {
    route: "simple-alt",
    preset: "simple-alt",
    provider: "agy",
  })!;
  h.db.prepare(`UPDATE delegations SET created_at = ? WHERE id = ?`).run(
    T0 - 6 * 60_000,
    row2.id,
  );
  await h.wd.reconcile();
  const fresh = h.store.get(row2.id)!;
  assert.equal(fresh.thread_id, "thr_undated"); // relinked, not re-dispatched
  assert.equal(fresh.status, "running");
  assert.ok(
    !h.calls.some((c) => c.join(" ").startsWith("tasks dispatch")),
    "no second dispatch allowed",
  );
});

test("relink + finalize resets retry_count (Н4 оговорка)", async () => {
  let failLookup = true;
  const h = makeHarness({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks threads"))
        return failLookup
          ? { exitCode: 1, stdout: "", stderr: "api down" }
          : ok(
              JSON.stringify({
                taskThreads: [
                  { threadId: "thr_e2", attachedAt: new Date(T0).toISOString() },
                ],
              }),
            );
      return undefined;
    },
  });
  const old = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.store.setStatus(old.id, "stalled");
  const row2 = h.store.reissue(old.id, {
    route: "simple-alt",
    preset: "simple-alt",
    provider: "agy",
  })!;
  h.db.prepare(`UPDATE delegations SET created_at = ? WHERE id = ?`).run(
    T0 - 6 * 60_000,
    row2.id,
  );
  await h.wd.reconcile(); // lookup fails → retry_count = 1
  assert.equal(h.store.get(row2.id)!.retry_count, 1);
  assert.match(h.store.get(row2.id)!.setup_errors, /retry-last-error/);
  failLookup = false;
  await h.wd.reconcile(); // relink + finalize → resolved
  const fresh = h.store.get(row2.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.retry_count, 0);
  assert.doesNotMatch(fresh.setup_errors, /retry-last-error/);
});

test("setup_errors never duplicates the same step+message", async () => {
  const h = makeHarness();
  const row = h.insertActive();
  h.store.addSetupError(row.id, "watchdog-stop", "same failure");
  h.store.addSetupError(row.id, "watchdog-stop", "same failure");
  h.store.addSetupError(row.id, "watchdog-stop", "different failure");
  const parsed = JSON.parse(h.store.get(row.id)!.setup_errors) as {
    step: string;
    message: string;
  }[];
  assert.deepEqual(parsed, [
    { step: "watchdog-stop", message: "same failure" },
    { step: "watchdog-stop", message: "different failure" },
  ]);
});

test("bypass-settled stops the options check (Н6 следствие)", async () => {
  const h = makeHarness({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(JSON.stringify({ preset: { permissionMode: "full" } }));
      if (key.startsWith("thread options thr_e1 --json"))
        return ok(
          JSON.stringify({
            options: [
              { id: "mode", value: "bypass", values: [{ id: "bypass" }] },
            ],
          }),
        );
      return undefined;
    },
  });
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.queues.set("thr_e1", [{ id: "q1" }]); // keeps it running past idle eval
  await h.wd.reconcile(); // settles: options reported → marker recorded
  assert.match(h.store.get(row.id)!.setup_errors, /bypass-settled/);
  const optionsCalls = () =>
    h.calls.filter(
      (c) =>
        c.join(" ").startsWith("thread options") ||
        c.join(" ").startsWith("tasks preset show"),
    ).length;
  const before = optionsCalls();
  await h.wd.reconcile(); // settled → no more CLI for the bypass check
  assert.equal(optionsCalls(), before);
});


test("findTaskThreadId: dated-but-old entries never win the fallback (Н7)", async () => {
  const mk = (taskThreads: unknown[]): BbCli => ({
    run: async (args) =>
      args.join(" ").startsWith("tasks threads")
        ? ok(JSON.stringify({ taskThreads }))
        : ok(),
  });
  const older = new Date(T0 - 60_000).toISOString();
  // a dated-old entry first, then an undated one → the undated wins
  assert.equal(
    await findTaskThreadId(
      mk([
        { threadId: "thr_old", attachedAt: older },
        { threadId: "thr_undated", attachedAt: "garbage" },
      ]),
      "PLUG-1",
      T0,
    ),
    "thr_undated",
  );
  // only a dated-old entry → null, never the predecessor's thread
  assert.equal(
    await findTaskThreadId(
      mk([{ threadId: "thr_old", attachedAt: older }]),
      "PLUG-1",
      T0,
    ),
    null,
  );
  // a fresh dated entry beats the undated one entirely
  assert.equal(
    await findTaskThreadId(
      mk([
        { threadId: "thr_old", attachedAt: older },
        { threadId: "thr_fresh", attachedAt: new Date(T0 + 1000).toISOString() },
        { threadId: "thr_undated", attachedAt: "garbage" },
      ]),
      "PLUG-1",
      T0,
    ),
    "thr_fresh",
  );
});

// ── Доработка по ревью PLUG-148 ────────────────────────────────────────

test("retry-exhausted on доведение перевыпуска quotes that action's error", async () => {
  const h = makeHarness({
    cli: (args) => {
      if (args.join(" ").startsWith("tasks threads"))
        return { exitCode: 1, stdout: "", stderr: "tasks api down" };
      return undefined;
    },
  });
  const old = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.store.setStatus(old.id, "stalled");
  const row2 = h.store.reissue(old.id, {
    route: "simple-alt",
    preset: "simple-alt",
    provider: "agy",
  })!;
  h.db.prepare(`UPDATE delegations SET created_at = ? WHERE id = ?`).run(
    T0 - 6 * 60_000,
    row2.id,
  );
  for (let i = 0; i < 10; i++) await h.wd.reconcile();
  const exhausted = h.sends.filter((s) =>
    JSON.stringify(s.input).includes("исчерпан предел повторов"),
  );
  assert.equal(exhausted.length, 1);
  const msg = JSON.stringify(exhausted[0]!.input);
  assert.match(msg, /доведение перевыпуска/);
  assert.match(msg, /tasks api down/); // the action's own last error, not "—"
});

test("unconfirmed stop on quota: the reissue report keeps the quota reason", async () => {
  const h = makeHarness({ stopFails: 1 });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    // §16.1: text quota is a verdict only when the turn ENDED with an
    // error — a turn/completed error carries it.
    ev(1, "turn/completed", T0, {
      error: { message: "insufficient credits" },
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  const quota = h.store.get(row.id)!;
  assert.equal(quota.status, "quota");
  assert.match(quota.setup_errors, /watchdog-stop/);
  assert.match(quota.setup_errors, /outcome-detail/);

  await h.wd.reconcile(); // the second stop confirms → the §5.4 decision
  assert.equal(h.store.get(row.id)!.status, "reissued");
  const msg = JSON.stringify(h.sends.at(-1)!.input);
  assert.match(msg, /insufficient credits/);
  assert.match(msg, /перевыпущено на simple-alt/);
});

test("approval message names the deny command too (§5.3 rev 17)", async () => {
  const h = makeHarness();
  h.insertActive({ threadId: "thr_e1" });
  await h.wd.onInteractionPending(dto("thr_e1", "active"), {
    id: "int_9",
    payload: { kind: "approval", subject: { command: "rm -rf /tmp/x" } },
  });
  assert.match(
    JSON.stringify(h.sends[0]!.input),
    /interactions approve\|deny\|grant\|answer\|respond int_9 thr_e1/,
  );
});

// ── Доработка по приёмке PLUG-149 / спека rev 18 ───────────────────────

test("events.list failure past the window: no stalled, no stop; a late response cancels", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);

  // journal unreadable → no stalled decision, no threads.stop (rev 18)
  h.eventsBlocked.add("thr_e1");
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "running");
  assert.deepEqual(h.stops, []);
  await h.wd.checkTimers(); // the next pass re-tries, still nothing
  assert.equal(h.store.get(row.id)!.status, "running");
  assert.deepEqual(h.stops, []);

  // reading recovered; a response in the journal cancels the decision
  h.eventsBlocked.delete("thr_e1");
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "item/agentMessage/delta", T0 + 20_000, { text: "hi" }),
  ]);
  await h.wd.checkTimers();
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.first_response_at, T0 + 20_000);
  assert.deepEqual(h.stops, []);
});

test("resume window with an unreadable journal: decision deferred, not stalled", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.queues.set("thr_e1", []);
  h.eventLog.set("thr_e1", [
    ev(1, "system/thread/interrupted", T0, { reason: "provider-turn-idle" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  assert.match(h.store.get(row.id)!.setup_errors, /resume-await/);
  h.setNow(T0 + 31_000); // past the resume window

  h.eventsBlocked.add("thr_e1");
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "running"); // deferred
  assert.deepEqual(h.stops, []);

  // journal readable again, still no new turn → stalled as before
  h.eventsBlocked.delete("thr_e1");
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "stalled");
  assert.deepEqual(h.stops, ["thr_e1"]);
});

test("idle with an unreadable journal stays running — no done/cancelled", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.store.setTurnStarted(row.id, T0 - 1000);
  h.queues.set("thr_e1", []); // empty queue would mean done — if readable
  h.eventsBlocked.add("thr_e1");
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "running");
  // reconcile follows the same rule
  await h.wd.reconcile();
  assert.equal(h.store.get(row.id)!.status, "running");

  // once the journal reads again, the usual done applies
  h.eventsBlocked.delete("thr_e1");
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "done");
});

// ── PLUG-150 / спека rev 19: исход `unavailable` ───────────────────────

test("unavailable: thread.start failed before the first turn → reissue + route hold, no stop", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  await h.wd.onThreadFailed(
    dto("thr_e1", "error"),
    "Command thread.start failed / Invalid params: model not found: acme-9",
  );

  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.deepEqual(h.stops, []); // executor never ran — no threads.stop
  const held = h.store.heldGroups(h.getNow());
  assert.ok(held.has("simple"), "the route NAME is held, not the quota group");
  assert.ok(!held.has("zen"));
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "simple-alt");
  assert.equal(fresh.status, "running");
  assert.equal(fresh.reissue_of, row.id);
  assert.match(h.store.get(row.id)!.setup_errors, /маршрут недоступен/);
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /маршрут недоступен.*перевыпущено на simple-alt/,
  );
});

test("unavailable: 'model not found' in the journal error text → same path", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  h.eventLog.set("thr_e1", [
    ev(1, "provider/error", T0, { message: "model not found: gpt-x" }),
  ]);
  await h.wd.onThreadFailed(dto("thr_e1", "error"), null);

  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.deepEqual(h.stops, []);
  assert.ok(h.store.heldGroups(h.getNow()).has("simple"));
  assert.equal(h.store.listActive()[0]!.route, "simple-alt");
});

test("unavailable without autoFallback → stalled, coordinator reissues by hand", async () => {
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  await h.wd.onThreadFailed(
    dto("thr_e1", "error"),
    "Command thread.start failed / Invalid params: model not found: x",
  );

  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "stalled");
  assert.deepEqual(h.stops, []);
  assert.ok(h.store.heldGroups(h.getNow()).has("strict"));
  assert.equal(h.store.listActive().length, 0);
  assert.ok(
    !h.calls.some((c) => c.join(" ").startsWith("tasks dispatch")),
    "no dispatch expected",
  );
  assert.match(
    JSON.stringify(h.sends[0]!.input),
    /маршрут недоступен.*перевыпуск за координатором/,
  );
});

test("ordinary error after the first turn → failed as before (no hold, no reissue)", async () => {
  // strict level: autoFallback off, so `failed` stays terminal (§5.4 r23)
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  await h.wd.onThreadFailed(dto("thr_e1", "error"), "provider blew up");

  assert.equal(h.store.get(row.id)!.status, "failed");
  assert.equal(h.store.heldGroups(h.getNow()).size, 0);
  assert.equal(h.store.listActive().length, 0);
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /завершился с ошибкой.*provider blew up/,
  );
});

test("start-failure text after a begun turn is not unavailable → failed", async () => {
  // the thread.start-failed marker only counts while no turn ever started;
  // strict level keeps `failed` terminal (autoFallback off)
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  await h.wd.onThreadFailed(
    dto("thr_e1", "error"),
    "Command thread.start failed / connection reset",
  );
  assert.equal(h.store.get(row.id)!.status, "failed");
  assert.equal(h.store.heldGroups(h.getNow()).size, 0);
});

test("unavailablePatterns from the policy extend the built-in list", async () => {
  const policy = JSON.stringify({
    version: 1,
    levels: {
      simple: { chain: ["simple", "simple-alt"], autoFallback: true },
    },
    routes: {
      simple: {
        preset: "simple",
        provider: "acp-opencode",
        unavailablePatterns: ["model retired upstream"],
      },
      "simple-alt": { preset: "simple-alt", provider: "agy" },
    },
  });
  const h = makeHarness({ policyText: policy });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  await h.wd.onThreadFailed(dto("thr_e1", "error"), "model retired upstream");

  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.equal(h.store.listActive()[0]!.route, "simple-alt");
});

test("quota is checked before unavailable: both signals → quota path", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  await h.wd.onThreadFailed(
    dto("thr_e1", "error"),
    "rate limit while loading model not found",
  );

  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.deepEqual(h.stops, ["thr_e1"]); // quota does stop — unavailable does not
  const held = h.store.heldGroups(h.getNow());
  assert.ok(held.has("zen")); // the quota GROUP, not the route name
  assert.ok(!held.has("simple"));
});

// ── PLUG-150 ревью: находки 1–4 ────────────────────────────────────────

const POLICY_THREE_ROUTES = JSON.stringify({
  version: 1,
  firstResponseSeconds: 30,
  levels: { lvl: { chain: ["a", "b", "c"], autoFallback: true } },
  routes: {
    a: { preset: "simple", provider: "p" },
    b: { preset: "simple-alt", provider: "p", quotaGroup: "g1" },
    c: { preset: "strict", provider: "p" },
  },
});

test("reissue skips a name-held route sitting after the current one", async () => {
  const h = makeHarness({ policyText: POLICY_THREE_ROUTES });
  // name-hold on "b" while its quotaGroup "g1" is free — only the §5.3
  // route-name check can skip it
  h.store.hold("b", h.getNow() + 15 * 60 * 1000, "route unavailable");
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "lvl",
    route: "a",
    preset: "simple",
    provider: "p",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();

  assert.equal(h.store.get(row.id)!.status, "reissued");
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "c"); // "b" skipped via the name hold
});

test("reissue dispatch refused with a removed model → hold + chain continues", async () => {
  const h = makeHarness({
    policyText: POLICY_THREE_ROUTES,
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks dispatch") && key.includes("--preset simple-alt"))
        return { exitCode: 1, stdout: "", stderr: "model not found: b-9" };
      return undefined;
    },
  });
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "lvl",
    route: "a",
    preset: "simple",
    provider: "p",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  await h.wd.onThreadFailed(
    dto("thr_e1", "error"),
    "Command thread.start failed / Invalid params: model not found: a-1",
  );

  const held = h.store.heldGroups(h.getNow());
  assert.ok(held.has("a") && held.has("b"), "both refused routes on hold");
  assert.ok(!held.has("g1"), "the quota GROUP is not held — names are");
  const mid = h.store.list().find((r) => r.route === "b")!;
  assert.equal(mid.status, "reissued"); // unavailable → stalled → reissued onward
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "c");
  assert.equal(fresh.status, "running");
  assert.equal(fresh.reissue_of, mid.id);
  assert.deepEqual(h.stops, []);
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /перевыпущено на c/,
  );
});

test("reconcile: reissue dispatch refused with a removed model → hold + next route", async () => {
  const h = makeHarness({
    policyText: POLICY_THREE_ROUTES,
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks dispatch") && key.includes("--preset simple-alt"))
        return { exitCode: 1, stdout: "", stderr: "model not found: b-9" };
      return undefined;
    },
  });
  const old = h.insertActive({
    threadId: "thr_e1",
    level: "lvl",
    route: "a",
    preset: "simple",
    provider: "p",
  });
  h.store.setStatus(old.id, "stalled");
  const row2 = h.store.reissue(old.id, {
    route: "b",
    preset: "simple-alt",
    provider: "p",
  })!;
  h.db.prepare(`UPDATE delegations SET created_at = ? WHERE id = ?`).run(
    T0 - 6 * 60_000,
    row2.id,
  );

  await h.wd.reconcile();
  const mid = h.store.get(row2.id)!;
  assert.equal(mid.status, "reissued");
  assert.ok(h.store.heldGroups(h.getNow()).has("b"));
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "c");
  assert.equal(fresh.status, "running");
});

test("start-failure after a pre-first-turn interrupt is still unavailable", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  // interrupt before any turn → resume sent, turn_started_at now marks the
  // resume window, not a real turn
  h.eventLog.set("thr_e1", [
    ev(1, "system/thread/interrupted", T0, { reason: "host-daemon-restarted" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  assert.match(h.store.get(row.id)!.setup_errors, /resume-await/);
  assert.notEqual(h.store.get(row.id)!.turn_started_at, null);

  await h.wd.onThreadFailed(
    dto("thr_e1", "error"),
    "Command thread.start failed / connection refused",
  );
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.ok(h.store.heldGroups(h.getNow()).has("simple"));
  assert.equal(h.store.listActive()[0]!.route, "simple-alt");
});

test("a later thread.failed upgrades a premature failed to unavailable", async () => {
  // the first stop fails, so the premature `failed` is still standing when
  // the stronger signal arrives (§5.4 r23: autoFallback reissues `failed`)
  const h = makeHarness({ stopFails: 1 });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  // race: thread.failed lands first with a non-pattern error text
  await h.wd.onThreadFailed(dto("thr_e1", "error"), "provider blew up");
  assert.equal(h.store.get(row.id)!.status, "failed");
  // then the same failure arrives carrying the removed-model signal
  await h.wd.onThreadFailed(
    dto("thr_e1", "error"),
    "Command thread.start failed / Invalid params: model not found: x",
  );
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.ok(h.store.heldGroups(h.getNow()).has("simple"));
  assert.equal(h.store.listActive()[0]!.route, "simple-alt");
});

// ── rev 23: failed → reissue, errored, per-route window, round result ───

test("§5.4 r23: failed reissues to the next route under autoFallback (503 no capacity)", async () => {
  // the live case behind ADR-0024: a reviewer died with "503 UNAVAILABLE:
  // No capacity available" and the row stayed `failed` forever
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  await h.wd.onThreadFailed(
    dto("thr_e1", "error"),
    "503 UNAVAILABLE: No capacity available",
  );
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.deepEqual(h.stops, ["thr_e1"]);
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "simple-alt");
  assert.equal(fresh.reissue_of, row.id);
  // §4.1 r23: a reissue retries the SAME round, it does not open a new one
  assert.equal(fresh.round, row.round);
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /завершился с ошибкой.*перевыпущено на simple-alt/,
  );
});

test("§2 rule 4: routes.*.firstResponseSeconds overrides the global window", async () => {
  const h = makeHarness({
    policyText: JSON.stringify({
      version: 1,
      firstResponseSeconds: 30,
      levels: { simple: { chain: ["simple"], autoFallback: true } },
      routes: {
        simple: {
          preset: "simple",
          provider: "p",
          firstResponseSeconds: 300,
        },
      },
    }),
  });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.setNow(T0 + 31_000); // past the global 30s, inside the route's 300s
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "running");
  h.setNow(T0 + 301_000);
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "stalled");
});

test("§5.3 r23: a turn that ended with an error at idle → continue + coordinator line", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "provider/error", T0 + 500, { message: "tool exploded" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.resume_count, 1);
  const toExec = h.sends.find((s) => s.threadId === "thr_e1")!;
  assert.match(
    JSON.stringify(toExec.input),
    /оборвался ошибкой.*tool exploded.*Продолжай/,
  );
  const toCoord = h.sends.find((s) => s.threadId === "thr_coord")!;
  assert.match(JSON.stringify(toCoord.input), /оборвался ошибкой/);
});

test("§5.3 r23: a repeat errored → failed → autoFallback reissue", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "provider/error", T0 + 500, { message: "tool exploded" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "running");
  // the resumed turn also ends with an error
  h.eventLog.get("thr_e1")!.push(
    ev(3, "turn/started", T0 + 1000),
    ev(4, "provider/error", T0 + 1500, { message: "tool exploded again" }),
  );
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 4 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "reissued");
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "simple-alt");
  assert.equal(fresh.reissue_of, row.id);
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /завершился с ошибкой.*перевыпущено на simple-alt/,
  );
});

test("§5.3 r23: a mid-turn tool error followed by response events is done, not errored", async () => {
  // the sample case: provider/error mid-turn, then twenty more minutes of
  // work — NOT an outcome
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "provider/error", T0 + 500, { message: "tool exploded" }),
    ev(3, "item/agentMessage/delta", T0 + 600, { delta: "working on it" }),
    ev(4, "item/completed", T0 + 700, { item: { type: "agentMessage" } }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 4 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "done");
  assert.equal(
    h.sends.filter((s) => s.threadId === "thr_e1").length,
    0,
    "no resume nudge for a clean turn",
  );
});

test("§5.3 r23: turn/completed with a non-completed status → errored resume", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 500, { status: "failed" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.resume_count, 1);
  const toExec = h.sends.find((s) => s.threadId === "thr_e1")!;
  assert.match(JSON.stringify(toExec.input), /оборвался ошибкой/);
});

test("§5.3 r23: a clean turn/completed → done", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 500, { status: "completed" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "done");
});

test("§5.3 r23: a quota text in the errored path → quota, not a resume", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "turn.failed", T0 + 500, { message: "429 rate limit exceeded" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.ok(h.store.heldGroups(h.getNow()).has("zen"));
});

test("§5.3 r23: a removed-model text at the turn's end → stalled + route hold + reissue", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 500, {
      status: "failed",
      error: { message: "model not found: m-1" },
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.ok(h.store.heldGroups(h.getNow()).has("simple")); // route name held
});

test("§5.3 r23: an errored resume that lifts no turn within the window → failed", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "provider/error", T0 + 500, { message: "tool exploded" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "running");
  // the resume never lifted a turn; the thread went quiet past the window
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.equal(h.store.listActive()[0]!.route, "simple-alt");
});

// ── §4.1 round result at done (real git repo in a temp dir) ─────────────

const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

function makeExecutorRepo(opts: { commits?: number; dirty?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "round-"));
  execFileSync("git", ["init", repo]);
  git(repo, ["config", "user.email", "a@b.c"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["checkout", "-b", "exec-branch"]);
  for (let i = 0; i < (opts.commits ?? 1); i++) {
    writeFileSync(join(repo, `w${i}.txt`), String(i));
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", `work ${i}`]);
  }
  if (opts.dirty) writeFileSync(join(repo, "dirty.txt"), "x");
  return repo;
}

const roundDeps = (repo: string, branchName = "exec-branch") => ({
  environment: async () => ({
    id: "env_1",
    path: repo,
    branchName,
    mergeBaseBranch: "master",
  }),
  git: async (r: string, args: string[]) => git(r, args),
});

async function runToDone(h: ReturnType<typeof makeHarness>) {
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  // §16.5 one channel: a live coordinator receives the result message
  // (the round doubts ride it, PLUG-184 M12).
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 10, { status: "completed" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  return row;
}

test("§4.1: done collects the round result — branch, sha, commits, clean", async () => {
  const repo = makeExecutorRepo({ commits: 2 });
  const sha = git(repo, ["rev-parse", "HEAD"]);
  const h = makeHarness({ round: roundDeps(repo) });
  const row = await runToDone(h);
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done");
  assert.equal(fresh.result_env_id, "env_1");
  assert.equal(fresh.result_branch, "exec-branch");
  assert.equal(fresh.result_sha, sha);
  assert.equal(fresh.result_commits, 2);
  assert.equal(fresh.result_dirty, 0);
  assert.equal(
    h.sends.filter((s) => /сомнителен/.test(JSON.stringify(s.input))).length,
    0,
    "a clean result sends no warning",
  );
});

test("§4.1: a dirty copy reports to the coordinator", async () => {
  const repo = makeExecutorRepo({ commits: 1, dirty: true });
  const h = makeHarness({ round: roundDeps(repo) });
  const row = await runToDone(h);
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done");
  assert.equal(fresh.result_dirty, 1);
  const note = h.sends.find((s) =>
    /сомнителен/.test(JSON.stringify(s.input)),
  )!;
  assert.match(JSON.stringify(note.input), /грязная/);
});

test("§4.1: zero commits reports to the coordinator", async () => {
  const repo = makeExecutorRepo({ commits: 0 });
  const h = makeHarness({ round: roundDeps(repo) });
  const row = await runToDone(h);
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.result_commits, 0);
  const note = h.sends.find((s) =>
    /сомнителен/.test(JSON.stringify(s.input)),
  )!;
  assert.match(JSON.stringify(note.input), /коммитов нет/);
});

test("§4.1: a foreign branch reports to the coordinator", async () => {
  const repo = makeExecutorRepo({ commits: 1 });
  git(repo, ["checkout", "master"]); // executor left its branch
  const h = makeHarness({ round: roundDeps(repo) });
  const row = await runToDone(h);
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.result_branch, "master");
  const note = h.sends.find((s) =>
    /сомнителен/.test(JSON.stringify(s.input)),
  )!;
  assert.match(JSON.stringify(note.input), /master вместо exec-branch/);
});

test("§4.1: review-level delegations skip the result collection", async () => {
  const repo = makeExecutorRepo({ commits: 1 });
  const h = makeHarness({ round: roundDeps(repo) });
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "review",
    route: "simple",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 10, { status: "completed" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done");
  assert.equal(fresh.result_sha, null);
});

test("§4.1: a missing environment lands in setup_errors, not the outcome", async () => {
  const h = makeHarness({
    round: {
      environment: async () => null,
      git: async () => "",
    },
  });
  const row = await runToDone(h);
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done");
  assert.ok(
    h.store.findSetupError(fresh, "round-result"),
    "round-result setup error recorded",
  );
});

test("§5.3 r23: a trailing willRetry provider error is not errored → done", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "provider/error", T0 + 500, {
      message: "backend hiccup",
      willRetry: true,
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "done");
});

// ── PLUG-176 review fixes: separate repeat marks, strict errored gate ───

test("§5.3 r23: errored → interrupt counts separately — first interrupt still resumes", async () => {
  // PLUG-176 #1: an errored resume bumped resume_count, so the FIRST
  // non-manual interrupt afterwards read as a repeat and stalled (or
  // reissued) a working executor. Repeats are per-outcome marks now.
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "provider/error", T0 + 500, { message: "tool exploded" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "running");
  assert.equal(h.store.get(row.id)!.resume_count, 1); // stats only

  // the resumed turn starts, then a first non-manual interrupt arrives —
  // it gets its own resume, not stalled
  h.eventLog.get("thr_e1")!.push(
    ev(3, "turn/started", T0 + 1000),
    ev(4, "system/thread/interrupted", T0 + 2000, {
      reason: "host-daemon-restarted",
    }),
  );
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 4 });
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.resume_count, 2);
  const toExec = h.sends.filter((s) => s.threadId === "thr_e1");
  assert.match(JSON.stringify(toExec.at(-1)!.input), /продолжай задачу/);

  // a SECOND interruption is the interrupt repeat → stalled
  h.eventLog.get("thr_e1")!.push(
    ev(5, "system/thread/interrupted", T0 + 3000, {
      reason: "provider-turn-idle",
    }),
  );
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 5 });
  assert.equal(h.store.get(row.id)!.status, "stalled");
  assert.deepEqual(h.stops, ["thr_e1"]);
});

test("§5.3 r23: interrupt → errored counts separately — first errored still resumes", async () => {
  // the other order (PLUG-176 #1): an interrupted resume must not burn
  // the errored outcome's one retry either
  const h = makeHarness();
  const row = h.insertActive({
    threadId: "thr_e1",
    level: "strict",
    route: "strict",
    preset: "strict",
    provider: "acp-devin",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "system/thread/interrupted", T0, { reason: "provider-turn-idle" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  assert.equal(h.store.get(row.id)!.status, "running");
  assert.equal(h.store.get(row.id)!.resume_count, 1);

  // the resumed turn starts, then ends with an error at idle — the FIRST
  // errored verdict, so a resume, not `failed`
  h.eventLog.get("thr_e1")!.push(
    ev(3, "turn/started", T0 + 1000),
    ev(4, "provider/error", T0 + 1500, { message: "tool exploded" }),
  );
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 4 });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.resume_count, 2);
  const toExec = h.sends.filter((s) => s.threadId === "thr_e1");
  assert.match(JSON.stringify(toExec.at(-1)!.input), /оборвался ошибкой/);

  // a second errored verdict is the errored repeat → failed (strict: no
  // reissue)
  h.eventLog.get("thr_e1")!.push(
    ev(5, "turn/started", T0 + 2500),
    ev(6, "provider/error", T0 + 3000, { message: "tool exploded again" }),
  );
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 6 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "failed");
});

test("§5.3 r23: turn/completed status interrupted is not errored → done", async () => {
  // PLUG-176 #2: `bb thread tell` interrupts the turn without a
  // system/thread/interrupted event; the interrupted/cancelled paths own
  // that outcome, so errored must not fire on it
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 500, { status: "interrupted" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "done");
  assert.equal(
    h.sends.filter((s) => s.threadId === "thr_e1").length,
    0,
    "no resume nudge on an interrupted completion",
  );
});

test("§5.3 r23: an error after a clean turn/completed does not count → done", async () => {
  // PLUG-176 #3, the live case: "agy exited (code null, signal SIGKILL)"
  // lands after the turn already completed — the completion alone decides
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 500, { status: "completed" }),
    ev(3, "provider/error", T0 + 600, {
      message: "agy exited (code null, signal SIGKILL)",
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 3 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "done");
  assert.equal(
    h.sends.filter((s) => s.threadId === "thr_e1").length,
    0,
    "no resume nudge for noise after a completed turn",
  );
});

test("§5.3 r23: a failed turn/completed still decides when errors trail it → errored", async () => {
  // PLUG-176 #3 both ways: the turn/completed decides alone — a failed
  // completion is errored even though the trailing noise is not an error
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 500, { status: "failed" }),
    ev(3, "provider/error", T0 + 600, {
      message: "agy exited (code null, signal SIGKILL)",
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 3 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.resume_count, 1);
  const toExec = h.sends.find((s) => s.threadId === "thr_e1")!;
  assert.match(JSON.stringify(toExec.input), /оборвался ошибкой/);
});


const STRICT = {
  level: "strict",
  route: "strict",
  preset: "strict",
  provider: "acp-devin",
};

// ── §16.1 provider-retry ───────────────────────────────────────────────

test("§16.1: pending provider-retry + thread.failed → running + mark", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  h.retryPendingRows.set("thr_e1", [{ id: 1, reason: "overloaded" }]);
  await h.wd.onThreadFailed(dto("thr_e1", "error"), "provider blew up");
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.match(fresh.setup_errors, /provider-retry-pending/);
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.stops, []);
  assert.equal(h.store.listByStatuses(["failed"]).length, 0);
});

test("§16.1: pending retry outranks the typed quota category on turn.failed", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  h.retryPendingRows.set("thr_e1", [{}]);
  await h.wd.onTurnFailed({
    threadId: "thr_e1",
    errorInfo: { category: "rate-limit" },
  });
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.match(fresh.setup_errors, /provider-retry-pending/);
  assert.equal(h.store.heldGroups(h.getNow()).size, 0);
});

test("§16.1: a premature failed row with a pending retry revives", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", ...STRICT });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  h.store.setStatus(row.id, "failed");
  h.retryPendingRows.set("thr_e1", [{}]);
  await h.wd.onTurnFailed({ threadId: "thr_e1", errorInfo: null });
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.revived_count, 1);
  assert.match(fresh.setup_errors, /provider-retry-pending/);
});

test("§16.1: reconcile thread.status=error defers while a retry is queued", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  h.retryPendingRows.set("thr_e1", [{}]);
  await h.wd.reconcile();
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.match(fresh.setup_errors, /provider-retry-pending/);
  assert.equal(h.sends.length, 0);
});

test("§16.1: the errored path also holds while a retry is queued", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.queues.set("thr_e1", []);
  h.retryPendingRows.set("thr_e1", [{}]);
  // turn tail ends on a non-retrying error → idle verdict is `errored`
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "provider/error", T0, { message: "connection reset" }),
  ]);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.match(fresh.setup_errors, /provider-retry-pending/);
  assert.doesNotMatch(fresh.setup_errors, /errored-resume-sent/);
});

test("§16.1: provider-retry status unreadable → the outcome defers", async () => {
  const h = makeHarness({ retryStatusFails: 1 });
  const row = h.insertActive({ threadId: "thr_e1", ...STRICT });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  await h.wd.onThreadFailed(dto("thr_e1", "error"), "provider blew up");
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running"); // undecided, not failed
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.stops, []);
});

test("§16.1: cancel runs BEFORE threads.stop inside confirmStop", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.retryPendingRows.set("thr_e1", [{ id: 7 }]); // retry queued mid-turn
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.deepEqual(h.retryCancels, ["thr_e1"]);
  assert.deepEqual(h.stops, ["thr_e1"]);
  // order: retry-status → … → retry-cancel → stop
  const iCancel = h.ops.indexOf("retry-cancel:thr_e1");
  const iStop = h.ops.indexOf("stop:thr_e1");
  assert.ok(iCancel >= 0 && iStop > iCancel, h.ops.join(","));
});

test("§16.1: cancel failure → stop unconfirmed, one message, reconcile retries", async () => {
  const h = makeHarness({ retryCancelFails: 1 });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.retryPendingRows.set("thr_e1", [{}]);
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  const stalled = h.store.get(row.id)!;
  assert.equal(stalled.status, "stalled"); // outcome kept, stop NOT confirmed
  assert.deepEqual(h.stops, []); // threads.stop never ran
  assert.match(stalled.setup_errors, /watchdog-stop/);
  assert.equal(h.sends.length, 1);
  assert.match(JSON.stringify(h.sends[0]!.input), /не удалось остановить/);

  // retry cancelled on the next pass → stop confirmed → §5.4 reissue
  await h.wd.reconcile();
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.equal(h.stops.length, 1);
  const fresh = h.store.listActive()[0]!;
  assert.equal(fresh.route, "simple-alt");
});

test("§16.1: unavailable path cancels a retry appearing after the decision", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  // Entry check sees an empty queue; the reissue gate sees the new row.
  h.retryStatusScript.push([], [{}]);
  await h.wd.onThreadFailed(
    dto("thr_e1", "error"),
    "thread.start failed: model not found",
  );
  assert.equal(h.store.get(row.id)!.status, "reissued");
  assert.deepEqual(h.retryCancels, ["thr_e1"]);
});

test("§16.1: reissue gate cancel failure → watchdog-stop + once-message, no reissue", async () => {
  const h = makeHarness({ retryCancelFails: 1 });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  // 1st read — the entry gate (empty); 2nd — confirmStop's cancel
  // (empty → threads.stop); 3rd — the reissue gate sees the new row.
  h.retryStatusScript.push([], [], [{}]);
  await h.wd.onThreadFailed(dto("thr_e1", "error"), "provider blew up");
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "failed"); // outcome kept
  assert.match(fresh.setup_errors, /watchdog-stop/);
  assert.match(fresh.setup_errors, /provider-retry cancel/);
  assert.equal(h.store.listActive().length, 0);
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /не удалось отменить автоповтор/,
  );
});

// ── §16.2 revival ──────────────────────────────────────────────────────

test("§16.2: turn/started on done → running, result delivery re-arms", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.outputs.set("thr_e1", "итог захода 1");
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0 - 1000)]);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  let fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done");
  assert.equal(fresh.result_notice, "plugin"); // result delivered
  const delivered = h.sends.length;

  // A `bb thread tell` lifts the thread: a new turn starts.
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "turn/started", T0 + 5000),
  ]);
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.revived_count, 1);
  assert.equal(fresh.result_notified_at, null); // delivery re-armed
  assert.equal(fresh.turn_started_at, T0 + 5000);

  // The revived turn finishes → the round's result is sent AGAIN (§16.2
  // «итог захода пересчитывается при каждом done»).
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "turn/started", T0 + 5000),
    ev(3, "turn/completed", T0 + 9000, { status: "completed" }),
  ]);
  h.queues.set("thr_e1", []);
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done");
  assert.equal(fresh.result_notice, "plugin");
  assert.equal(h.sends.length, delivered + 1);
});

test("§16.2: failed without autoFallback revives when BB lifts the thread", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", ...STRICT });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  await h.wd.onThreadFailed(dto("thr_e1", "error"), "provider blew up");
  assert.equal(h.store.get(row.id)!.status, "failed");
  // BB retries on its own — a turn/started without watchdog supervision.
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0 + 5000)]);
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.revived_count, 1);
});

test("§16.2: turn/started on cancelled revives too", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "system/thread/interrupted", T0, { reason: "manual-stop" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  assert.equal(h.store.get(row.id)!.status, "cancelled");

  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "system/thread/interrupted", T0, { reason: "manual-stop" }),
    ev(3, "turn/started", T0 + 5000),
  ]);
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 3 });
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.equal(fresh.revived_count, 1);
});

test("§16.2: a duplicate turn is stopped when the task has an active row", async () => {
  const h = makeHarness();
  const row = h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e1" });
  h.store.setStatus(row.id, "failed");
  h.store.advanceLastSeq(row.id, 5);
  const other = h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e2" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.threadDtos.set("thr_e2", dto("thr_e2", "active"));
  h.eventLog.set("thr_e1", [ev(6, "turn/started", T0 + 9999)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 6 });
  assert.equal(h.store.get(row.id)!.status, "failed"); // outcome stands
  assert.equal(h.store.get(other.id)!.status, "running");
  assert.deepEqual(h.stops, ["thr_e1"]);
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /более новое делегирование/,
  );
});

// ── §16.5 result delivery ──────────────────────────────────────────────

const ROUND_FAKE: WatchdogDeps["round"] = {
  environment: async () => ({
    id: "env_1",
    path: "/tmp/wt",
    branchName: "bb/plug-1",
    mergeBaseBranch: "main",
  }),
  git: async (_repo, args) => {
    const k = args.join(" ");
    if (k.startsWith("rev-parse")) return "abc1234deadbeef\n";
    if (k.startsWith("symbolic-ref")) return "bb/plug-1\n";
    if (k.startsWith("status")) return "\n";
    if (k.startsWith("rev-list")) return "3\n";
    return "";
  },
};

test("§16.5: done delivers ONE plugin message with branch/sha7/копия/output", async () => {
  const h = makeHarness({ round: ROUND_FAKE });
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.outputs.set("thr_e1", "готово: npm test + typecheck");
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0 - 1000)]);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done");
  assert.equal(fresh.result_notice, "plugin");
  assert.ok(fresh.result_notified_at != null);
  const msg = h.sends.find((x) => x.threadId === "thr_coord");
  assert.ok(msg, "result message expected");
  const text = JSON.stringify(msg!.input);
  assert.match(text, /PLUG-1 \(simple, тред thr_e1\): done/);
  assert.match(text, /ветка bb\/plug-1/);
  assert.match(text, /коммит abc1234/);
  assert.match(text, /копия чистая/);
  assert.match(text, /npm test \+ typecheck/);
});

test("§16.5: empty output → «без отчёта»; output is capped at 3000", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  const row2 = h.insertActive({ taskKey: "PLUG-2", threadId: "thr_e2" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.threadDtos.set("thr_e2", dto("thr_e2", "idle"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.outputs.set("thr_e2", "y".repeat(4000));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0 - 1000)]);
  h.eventLog.set("thr_e2", [ev(1, "turn/started", T0 - 1000)]);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  await h.wd.onThreadIdle(dto("thr_e2", "idle"));
  const m1 = JSON.stringify(h.sends.find((x) => x.threadId === "thr_coord")!.input);
  assert.match(m1, /без отчёта/);
  const m2 = JSON.stringify(h.sends.filter((x) => x.threadId === "thr_coord").at(-1)!.input);
  assert.ok(m2.includes("y".repeat(3000)));
  assert.ok(!m2.includes("y".repeat(3001)));
  assert.equal(h.store.get(row.id)!.result_notice, "plugin");
  assert.equal(h.store.get(row2.id)!.result_notice, "plugin");
});

test("§16.5: send failure → reconcile resends until delivered", async () => {
  const h = makeHarness({ sendFails: 1 });
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.outputs.set("thr_e1", "итог");
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0 - 1000)]);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  let fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done");
  assert.equal(fresh.result_notified_at, null); // not delivered yet
  assert.equal(fresh.retry_count, 1);

  await h.wd.reconcile(); // resend succeeds now
  fresh = h.store.get(row.id)!;
  assert.equal(fresh.result_notice, "plugin");
  const msgs = h.sends.filter((x) => x.threadId === "thr_coord");
  assert.equal(msgs.length, 1);
});

test("§16.5: a gone coordinator records the delivery and never rescans", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  // thr_coord is NOT in threadDtos — it is gone
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0 - 1000)]);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done");
  assert.ok(fresh.result_notified_at != null);
  assert.equal(fresh.result_notice, null); // recorded without a notice
  assert.equal(h.sends.length, 0);
  const s = await h.wd.reconcile();
  assert.equal(s.errors.length, 0);
  assert.equal(h.sends.length, 0); // no rescan attempts
});

test("§16.5: cancelled delivers a result message too", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.outputs.set("thr_e1", "частичный прогресс");
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "system/thread/interrupted", T0, { reason: "manual-stop" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "cancelled");
  assert.equal(fresh.result_notice, "plugin");
  const msg = h.sends.find((x) => x.threadId === "thr_coord");
  assert.match(JSON.stringify(msg!.input), /: cancelled, ветка/);
});

test("§16.5: only idle|error confirm a stop — 'stopping' retries via watchdog-stop", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", ...STRICT });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.stopResult.status = "stopping"; // BB accepted the stop but is not down yet
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  const stalled = h.store.get(row.id)!;
  assert.equal(stalled.status, "stalled");
  assert.match(stalled.setup_errors, /watchdog-stop/);
  h.stopResult.status = "idle"; // the stop lands on the next pass
  await h.wd.reconcile();
  const cur = h.store.get(row.id)!;
  assert.doesNotMatch(cur.setup_errors, /"watchdog-stop"/);
});

// ── §16.5 startSeconds / idleSeconds / памятка / привязка ─────────────

const TIMER_POLICY = JSON.stringify({
  version: 1,
  firstResponseSeconds: 30,
  maxRunSeconds: 300,
  levels: {
    simple: { chain: ["simple"], autoFallback: false },
  },
  routes: {
    simple: {
      preset: "simple",
      provider: "acp-opencode",
      startSeconds: 60,
      idleSeconds: 60,
    },
  },
});

test("§16.5 startSeconds: no turn for the window → one message, no stop", async () => {
  const h = makeHarness({ policyText: TIMER_POLICY });
  const row = h.insertActive({ threadId: "thr_e1", createdAt: T0 - 200_000 });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  await h.wd.checkTimers();
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.deepEqual(h.stops, []);
  const msgs = h.sends.filter((x) => x.threadId === "thr_coord");
  assert.equal(msgs.length, 1);
  assert.match(JSON.stringify(msgs[0]!.input), /не начал ход/);
  await h.wd.checkTimers(); // one-shot
  assert.equal(h.sends.length, 1);
});

test("§16.5 idleSeconds: response silence → one message, no stop", async () => {
  const h = makeHarness({ policyText: TIMER_POLICY });
  const row = h.insertActive({ threadId: "thr_e1", createdAt: T0 - 200_000 });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 150_000),
    ev(2, "item/agentMessage/delta", T0 - 140_000, {}),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 2 });
  await h.wd.checkTimers(); // silence 140s > idleSeconds 60s
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "running");
  assert.deepEqual(h.stops, []);
  const msgs = h.sends.filter((x) => x.threadId === "thr_coord");
  assert.equal(msgs.length, 1);
  assert.match(JSON.stringify(msgs[0]!.input), /нет событий ответа/);
  await h.wd.checkTimers();
  assert.equal(h.sends.length, 1); // one-shot
});

test("§16.5: post-compaction §3 reminder — one per thread/compacted", async () => {
  const h = makeHarness();
  h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.eventLog.set("thr_coord", [ev(9, "thread/compacted", T0)]);
  // PLUG-184 B1: the first sight of a coordinator initializes the cursor
  // to the newest existing seq — old compactions owe no reminder.
  await h.wd.reconcile();
  assert.equal(
    h.sends.filter((x) => /сжат/.test(JSON.stringify(x.input))).length,
    0,
  );
  // a NEW compaction event fires the reminder
  h.eventLog.set("thr_coord", [
    ev(9, "thread/compacted", T0),
    ev(10, "thread/compacted", T0 + 60_000),
  ]);
  await h.wd.reconcile();
  const msgs = h.sends.filter(
    (x) => x.threadId === "thr_coord" && /сжат/.test(JSON.stringify(x.input)),
  );
  assert.equal(msgs.length, 1);
  assert.match(JSON.stringify(msgs[0]!.input), /orchestrator_delegate/);
  await h.wd.reconcile(); // the cursor stops the repeat
  assert.equal(
    h.sends.filter((x) => /сжат/.test(JSON.stringify(x.input))).length,
    1,
  );
  h.eventLog.set("thr_coord", [
    ev(9, "thread/compacted", T0),
    ev(10, "thread/compacted", T0 + 60_000),
    ev(11, "thread/compacted", T0 + 120_000),
  ]);
  await h.wd.reconcile();
  assert.equal(
    h.sends.filter((x) => /сжат/.test(JSON.stringify(x.input))).length,
    2,
  );
});

test("§16.5: drifted binding re-applied until attach-verified", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set(
    "thr_e1",
    dto("thr_e1", "active", {
      parentThreadId: "thr_other",
      parentNotifications: "off",
    }),
  );
  await h.wd.reconcile();
  assert.ok(
    h.wdUpdates.some(
      (u) => u.threadId === "thr_e1" && u.parentThreadId === "thr_coord",
    ),
    "threads.update re-applies the parent",
  );
  assert.ok(
    h.calls.some(
      (c) => c.join(" ") === "thread update thr_e1 --parent-notifications stuck",
    ),
  );
  assert.doesNotMatch(h.store.get(row.id)!.setup_errors, /attach-verified/);
  // once the DTO confirms, the row is marked verified and untouched
  h.threadDtos.set(
    "thr_e1",
    dto("thr_e1", "active", {
      parentThreadId: "thr_coord",
      parentNotifications: "stuck",
    }),
  );
  const updatesBefore = h.wdUpdates.length;
  await h.wd.reconcile();
  assert.match(h.store.get(row.id)!.setup_errors, /attach-verified/);
  assert.equal(h.wdUpdates.length, updatesBefore); // no further re-apply
});

// ── PLUG-184 review fixes (r25 rollout) ───────────────────────────────

test("PLUG-184 B1: an old base's migration marks legacy results; first reconcile sends nothing", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS.slice(0, -1)) db.exec(m); // pre-rollout schema
  db.prepare(
    `INSERT INTO delegations (task_key, coordinator_thread_id, thread_id,
       level, route, preset, provider, status, created_at, updated_at)
     VALUES ('PLUG-OLD','thr_coord','thr_old','simple','simple','simple',
       'acp-opencode','done',?,?)`,
  ).run(T0 - 10_000, T0 - 9_000);
  db.exec(MIGRATIONS.at(-1)!); // the rollout UPDATE
  const stored = db
    .prepare(`SELECT result_notified_at, result_notice FROM delegations`)
    .get() as { result_notified_at: number | null; result_notice: string };
  assert.equal(stored.result_notice, "legacy");
  assert.ok(stored.result_notified_at != null);

  const h = makeHarness({ db });
  h.threadDtos.set("thr_old", dto("thr_old", "idle"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.eventLog.set("thr_coord", [ev(7, "thread/compacted", T0 - 1000)]);
  const s = await h.wd.reconcile();
  assert.equal(
    h.sends.length,
    0,
    "first reconcile re-sends no legacy result or compaction reminder",
  );
  // a NEW compaction still fires the reminder
  h.eventLog.set("thr_coord", [
    ev(7, "thread/compacted", T0 - 1000),
    ev(8, "thread/compacted", T0),
  ]);
  await h.wd.reconcile();
  assert.equal(
    h.sends.filter((x) => /сжат/.test(JSON.stringify(x.input))).length,
    1,
  );
});

test("PLUG-184 B2: a tracker comment waking an OLD round → cancel+stop, status stands", async () => {
  const h = makeHarness();
  const old = h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e1" });
  h.store.setStatus(old.id, "done");
  h.store.advanceLastSeq(old.id, 5);
  h.store.setResultNotified(old.id, "plugin");
  h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e2" }); // newer round
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.retryPendingRows.set("thr_e1", [{}]);
  h.eventLog.set("thr_e1", [
    ev(6, "client/turn/requested", T0, {
      input: [{ text: "New comment on task PLUG-1 from thr_coord: ок" }],
    }),
    ev(7, "turn/started", T0 + 100),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 7 });
  assert.equal(h.store.get(old.id)!.status, "done");
  assert.deepEqual(h.retryCancels, ["thr_e1"]); // §16.1 cancel BEFORE stop
  assert.deepEqual(h.stops, ["thr_e1"]);
  assert.equal(
    h.sends.filter((x) => x.threadId === "thr_coord").length,
    1,
    "one suppression line",
  );
});

test("PLUG-184 B2: a tracker comment on the LATEST round is not a revive", async () => {
  const h = makeHarness();
  const row = h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e1" });
  h.store.setStatus(row.id, "done");
  h.store.advanceLastSeq(row.id, 5);
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [
    ev(6, "client/turn/requested", T0, {
      input: [
        { text: "New comment on task PLUG-1 from thr_coord: ping" },
      ],
    }),
    ev(7, "turn/started", T0 + 100),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 7 });
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "done"); // stays finished — notification wake
  assert.equal(fresh.revived_count, 0);
  assert.deepEqual(h.stops, []); // the latest round is never stopped
});

test("PLUG-184 B2: auto-retry lifts a reissued thread → cancel+stop+one line", async () => {
  const h = makeHarness();
  const old = h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e1" });
  h.store.setStatus(old.id, "stalled");
  h.store.reissue(old.id, {
    route: "simple-alt",
    preset: "simple-alt",
    provider: "agy",
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.retryPendingRows.set("thr_e1", [{}]);
  h.eventLog.set("thr_e1", [ev(3, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 3 });
  const fresh = h.store.get(old.id)!;
  assert.equal(fresh.status, "reissued");
  assert.deepEqual(h.retryCancels, ["thr_e1"]);
  assert.deepEqual(h.stops, ["thr_e1"]);
  const lines = h.sends.filter((x) => x.threadId === "thr_coord");
  assert.equal(lines.length, 1);
  assert.match(JSON.stringify(lines[0]!.input), /reissued|перевыпуск|исхода/);
});

test("PLUG-184 M10: suppressed wake — stop repeats on a second turn, outcome still delivered", async () => {
  const h = makeHarness();
  const old = h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e1" });
  h.store.setStatus(old.id, "done"); // outcome not delivered yet
  h.store.advanceLastSeq(old.id, 5);
  h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e2" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.threadDtos.set("thr_e2", dto("thr_e2", "active"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.eventLog.set("thr_e1", [ev(6, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 6 });
  assert.deepEqual(h.stops, ["thr_e1"]);
  // the suppressed row's outcome still delivers — exactly once
  await h.wd.reconcile();
  const doneRow = h.store.get(old.id)!;
  assert.equal(doneRow.result_notice, "plugin");
  const results = h.sends.filter(
    (x) => x.threadId === "thr_coord" && /: done/.test(JSON.stringify(x.input)),
  );
  assert.equal(results.length, 1);
  // a SECOND wake on the same thread stops again — one line total
  h.eventLog.set("thr_e1", [
    ev(6, "turn/started", T0),
    ev(7, "turn/started", T0 + 100),
  ]);
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 7 });
  assert.equal(h.stops.length, 2);
  assert.equal(
    h.sends.filter(
      (x) => x.threadId === "thr_coord" && /остановлен|останавливаю/.test(
        JSON.stringify(x.input),
      ),
    ).length,
    1,
    "coordinator still heard the suppression exactly once",
  );
});

test("PLUG-184 C3: claimResultDelivery is atomic; a stale claim rescans", () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1" });
  h.store.setStatus(row.id, "done");
  assert.ok(h.store.claimResultDelivery(row.id));
  assert.ok(!h.store.claimResultDelivery(row.id), "second claim refused");
  // a crashed claim (old updated_at) still shows up for the resend pass
  h.db
    .prepare(`UPDATE delegations SET updated_at = ? WHERE id = ?`)
    .run(Date.now() - 200_000, row.id);
  assert.deepEqual(h.store.listPendingResult().map((r) => r.id), [row.id]);
  h.store.releaseResultClaim(row.id);
  assert.equal(h.store.get(row.id)!.result_notified_at, null);
  assert.ok(h.store.claimResultDelivery(row.id), "released claim retakes");
});

test("PLUG-184 C3: event done + reconcile → exactly one result send", async () => {
  const h = makeHarness({ round: ROUND_FAKE });
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0 - 1000)]);
  await h.wd.onThreadIdle(dto("thr_e1", "idle"));
  await h.wd.reconcile(); // the second path must not resend
  const msgs = h.sends.filter(
    (x) =>
      x.threadId === "thr_coord" &&
      /\[orchestrator\] PLUG-1.*: done/.test(JSON.stringify(x.input)),
  );
  assert.equal(msgs.length, 1);
  assert.equal(h.store.get(row.id)!.result_notice, "plugin");
});

test("PLUG-184 C4: pending retry on a failed row with an active sibling → no revive, retry cancelled", async () => {
  const h = makeHarness();
  const row = h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e1" });
  h.store.setStatus(row.id, "failed");
  const other = h.insertActive({ taskKey: "PLUG-1", threadId: "thr_e2" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  h.retryPendingRows.set("thr_e1", [{}]);
  await h.wd.onTurnFailed({ threadId: "thr_e1", errorInfo: null });
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "failed"); // revive refused — sibling owns it
  assert.equal(fresh.revived_count, 0);
  assert.equal(h.store.get(other.id)!.status, "running");
  assert.deepEqual(h.retryCancels, ["thr_e1"]);
});

test("PLUG-184 C6: no_pending_retry is a drained queue; two rows need two cancels", async () => {
  const h = makeHarness({ retryCancelNoPending: 1 });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  // first cancel answers no_pending_retry (row fired) then the queue
  // reads empty — the decision is a success, not a stop-blocker.
  h.retryPendingRows.set("thr_e1", [{}]);
  h.setNow(T0 + 31_000);
  await h.wd.checkTimers();
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "reissued");
  assert.deepEqual(h.stops, ["thr_e1"]);

  const h2 = makeHarness();
  const row2 = h2.insertActive({ threadId: "thr_e1", route: "simple" });
  h2.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  h2.eventLog.set("thr_e1", [ev(1, "turn/started", T0)]);
  await h2.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h2.retryPendingRows.set("thr_e1", [{}, {}]); // two queued rows
  h2.setNow(T0 + 31_000);
  await h2.wd.checkTimers();
  assert.equal(h2.store.get(row2.id)!.status, "reissued");
  assert.deepEqual(h2.retryCancels, ["thr_e1", "thr_e1"]);
  assert.deepEqual(h2.stops, ["thr_e1"]);
});

test("PLUG-184 C7: a final failed without autoFallback cancels the auto-retry first", async () => {
  const h = makeHarness();
  const row = h.insertActive({ threadId: "thr_e1", ...STRICT });
  h.threadDtos.set("thr_e1", dto("thr_e1", "error"));
  // entry check sees an empty queue; the row appears before the stop
  h.retryStatusScript.push([], [{}], []);
  await h.wd.onThreadFailed(dto("thr_e1", "error"), "provider blew up");
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.status, "failed");
  assert.deepEqual(h.retryCancels, ["thr_e1"]);
  assert.match(
    JSON.stringify(h.sends.at(-1)!.input),
    /завершился с ошибкой/,
  );
});

test("PLUG-184 M8: silence counts from the turn's own response; pending retry suppresses; a response re-arms", async () => {
  const h = makeHarness({ policyText: TIMER_POLICY });
  const row = h.insertActive({
    threadId: "thr_e1",
    createdAt: T0 - 400_000,
  });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  // old turn with a stale response + a NEW turn (post auto-retry wait)
  // that answered 40s ago — silence measures from the new turn, not the
  // stale response (was: instant «нет событий ответа»).
  h.eventLog.set("thr_e1", [
    ev(1, "turn/started", T0 - 300_000),
    ev(2, "item/agentMessage/delta", T0 - 290_000),
    ev(3, "turn/started", T0 - 50_000),
    ev(4, "item/agentMessage/delta", T0 - 40_000),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 4 });
  const silenced = () =>
    h.sends.filter((x) => /нет событий ответа/.test(JSON.stringify(x.input)))
      .length;
  await h.wd.checkTimers(); // silence 40s < 60s
  assert.equal(silenced(), 0);
  // a queued auto-retry is sleeping on BB, not silent
  h.store.addSetupError(row.id, "provider-retry-pending", "auto-retry queued");
  h.setNow(T0 + 30_000); // silence 70s — but suppressed
  await h.wd.checkTimers();
  assert.equal(silenced(), 0);
  h.store.clearSetupError(row.id, "provider-retry-pending");
  await h.wd.checkTimers();
  assert.equal(silenced(), 1);
  // a response after the notice re-arms it
  h.eventLog.get("thr_e1")!.push(
    ev(5, "item/agentMessage/delta", T0 + 31_000),
  );
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 5 });
  h.setNow(T0 + 100_000); // silence 69s after the response → a second notice
  await h.wd.checkTimers();
  assert.equal(silenced(), 2);
});

test("PLUG-184 M9: an unreadable `thread show` lands attach-verify once", async () => {
  const h = makeHarness({
    cli: (args) =>
      args.join(" ").startsWith("thread show")
        ? { exitCode: 1, stdout: "", stderr: "daemon down" }
        : undefined,
  });
  const row = h.insertActive({ threadId: "thr_e1" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "active"));
  await h.wd.reconcile();
  const fresh = h.store.get(row.id)!;
  assert.doesNotMatch(fresh.setup_errors, /attach-verified/);
  assert.match(fresh.setup_errors, /attach-verify.*thread show/);
  const lines = h.sends.filter(
    (x) => x.threadId === "thr_coord" && /привязка/.test(JSON.stringify(x.input)),
  );
  assert.equal(lines.length, 1);
});

test("PLUG-184: a cancelled result never claims «коммитов нет»", async () => {
  const repo = makeExecutorRepo({ commits: 0 });
  const h = makeHarness({ round: roundDeps(repo) });
  const row = h.insertActive({ threadId: "thr_e1", route: "simple" });
  h.threadDtos.set("thr_e1", dto("thr_e1", "idle"));
  h.threadDtos.set("thr_coord", dto("thr_coord", "idle"));
  h.eventLog.set("thr_e1", [ev(1, "turn/started", T0 - 1000)]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });
  h.store.setStatus(row.id, "cancelled");
  // collect the round facts and deliver — the cancelled outcome must not
  // brand «коммитов нет» (the executor was stopped mid-work).
  const finished = h.store.get(row.id)!;
  await (h.wd as any).reconcile();
  const sends = h.sends.filter(
    (x) => x.threadId === "thr_coord" && /cancelled/.test(JSON.stringify(x.input)),
  );
  assert.equal(sends.length, 1);
  assert.doesNotMatch(JSON.stringify(sends[0]!.input), /коммитов нет/);
});
