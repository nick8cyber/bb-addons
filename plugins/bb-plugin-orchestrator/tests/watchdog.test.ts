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
      stops.push(threadId);
      const dto = threadDtos.get(threadId);
      if (dto) dto.status = "idle";
      return {};
    },
  };

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
    dispatch: (row) => dispatchToRoute(row, {}, stepsDeps),
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
    warns,
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
  assert.equal(h.store.get(row.id)!.setup_errors, "[]");
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
