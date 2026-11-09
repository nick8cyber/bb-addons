import assert from "node:assert/strict";
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
  } = {},
) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
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
      return ok();
    },
  };

  const sends: { threadId: string; mode: string; input: unknown[] }[] = [];
  const stops: string[] = [];
  const updates: unknown[] = [];
  const eventLog = new Map<string, WatchdogThreadEvent[]>();
  const threadDtos = new Map<string, WatchdogThreadDto>();
  const queues = new Map<string, unknown[]>();
  /** §5.1 rev 18: threadIds whose journal reads must fail (server down). */
  const eventsBlocked = new Set<string>();
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
      sends.push(args);
      return {};
    },
    stop: async ({ threadId }: { threadId: string }) => {
      const row = store.byThreadId(threadId);
      statusAtStop.push(row?.status ?? "none");
      stops.push(threadId);
      if (stopFailsLeft > 0) {
        stopFailsLeft--;
        throw new Error("stop failed (test)");
      }
      const dto = threadDtos.get(threadId);
      if (dto) dto.status = "idle";
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

test("quota by text pattern → hold by route name when no quotaGroup", async () => {
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
    ev(1, "provider/error", T0, { message: "Free usage limit reached" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_e1"), sequence: 1 });

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
      (c) => c.join(" ") === "thread update thr_e1 --parent-notifications auto",
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
  const h = makeHarness();
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
    ev(1, "provider/error", T0, { message: "insufficient credits" }),
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
