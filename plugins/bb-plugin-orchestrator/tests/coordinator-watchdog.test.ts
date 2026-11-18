import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { Policy, PolicyLoad } from "../src/policy.js";
import {
  createWatchdog,
  type WatchdogDeps,
  type WatchdogThreadDto,
  type WatchdogThreadEvent,
} from "../src/watchdog.js";

/** §5.6 (r33.11): the coordinator watchdog — idle reminders at
 * cumulative N/3N/7N from the idle anchor, the owner escalation at
 * 11N, the productive-action and user-message resets. */

const T0 = 1_700_000_000_000;
const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

const ev = (
  seq: number,
  type: string,
  createdAt: number,
  data: Record<string, unknown> = {},
): WatchdogThreadEvent => ({ seq, type, createdAt, data });

const request = (
  seq: number,
  createdAt: number,
  text: string,
  kind: string | null = "unlabeled",
): WatchdogThreadEvent =>
  ev(seq, "client/turn/requested", createdAt, {
    systemMessageKind: kind,
    input: [{ type: "text", text }],
  });

function makeHarness(
  opts: { timing?: Policy["timing"]; limits?: Policy["limits"] } = {},
) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const cliCalls: string[][] = [];
  const cli: BbCli = {
    run: async (args) => {
      cliCalls.push(args);
      const key = args.join(" ");
      if (key.startsWith("tasks project list")) {
        return ok(
          JSON.stringify({
            projects: [
              { prefix: "PLUG", linkedBbProjectId: "proj_bb" },
              { prefix: "OTHER", linkedBbProjectId: "proj_other" },
            ],
          }),
        );
      }
      if (key.startsWith("tasks list")) {
        return ok(
          JSON.stringify({
            tasks: backlogKeys.map((k) => ({ key: k, status: "backlog" })),
          }),
        );
      }
      return ok();
    },
  };
  const backlogKeys: string[] = [];
  const sends: { threadId: string; input: { text?: string }[] }[] = [];
  const eventLog = new Map<string, WatchdogThreadEvent[]>();
  const threadDtos = new Map<string, WatchdogThreadDto>();
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
    queuedMessages: { list: async () => [] },
    send: async (args: {
      threadId: string;
      mode: "queue-if-active";
      input: { type: string; text?: string }[];
    }) => {
      sends.push({
        threadId: args.threadId,
        input: args.input as { text?: string }[],
      });
      // A delivered message opens a turn — the thread leaves `idle`.
      const dto = threadDtos.get(args.threadId);
      if (dto) dto.status = "active";
      return {};
    },
    stop: async () => ({}),
    output: async () => ({ output: null }),
    update: async () => ({}),
  };
  let nowMs = T0;
  const policy: Policy = {
    version: 1,
    levels: {},
    routes: {},
    ...(opts.timing ? { timing: opts.timing } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  };
  const deps: WatchdogDeps = {
    store,
    bbCli: cli,
    threads,
    loadPolicy: async (): Promise<PolicyLoad> => ({
      policy,
      errors: [],
      warnings: [],
      unavailableRoutes: [],
    }),
    dispatch: async () => ({ ok: true }) as never,
    finalize: async () => ({ status: "running", setupErrors: [] }),
    retrySetup: async () => [],
    enqueue: async (fn) => fn(),
    now: () => nowMs,
  };
  const watchdog = createWatchdog(deps);
  return {
    db,
    store,
    watchdog,
    sends,
    cliCalls,
    eventLog,
    threadDtos,
    backlogKeys,
    advance: (ms: number) => {
      nowMs += ms;
    },
    /** A delegation row in a terminal state for `coordinator`. */
    doneDelegation: (
      coordinator: string,
      taskKey = "PLUG-1",
      status: "done" | "failed" = "done",
    ) => {
      const row = store.insert({
        taskKey,
        coordinatorThreadId: coordinator,
        level: "simple",
        route: "r",
        preset: "p",
        provider: "acp",
      });
      store.setStatus(row.id, status);
      return row;
    },
    coordinator: (
      id = "thr_c",
      extra: Partial<WatchdogThreadDto> = {},
    ): WatchdogThreadDto => {
      store.setThreadRole(id, "orchestrator", "hook");
      const dto: WatchdogThreadDto = {
        id,
        status: "idle",
        parentThreadId: null,
        projectId: "proj_bb",
        ...extra,
      };
      threadDtos.set(id, dto);
      return dto;
    },
  };
}

const NUDGE_MIN = 5;

test("§5.6: an idle coordinator with a done-unmerged delegation is nudged at cumulative N, 3N, 7N", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  // Anchor the idle epoch, then let the pass discover it.
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "no nudge before the threshold");
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1, "nudge #1 at N");
  const n1 = h.sends[0]!;
  assert.equal(n1.threadId, "thr_c");
  const t1 = n1.input[0]!.text!;
  assert.match(t1, /^\[orchestrator\] Напоминание \(1\/3\)/);
  assert.match(t1, /PLUG-1/);
  // The nudge-woken turn does not move the anchor — #2 waits for the
  // cumulative 3N of the same quiet spell.
  await h.watchdog.onThreadActive(c);
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1, "no early nudge #2");
  h.advance(NUDGE_MIN * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 2, "nudge #2 at cumulative 3N");
  assert.match(h.sends[1]!.input[0]!.text!, /\(2\/3\)/);
  // #3 at cumulative 7N.
  await h.watchdog.onThreadActive(c);
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  h.advance(3 * NUDGE_MIN * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 2, "no early nudge #3");
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 3, "nudge #3 at cumulative 7N");
  assert.match(h.sends[2]!.input[0]!.text!, /\(3\/3\)/);
});

test("§5.6: at cumulative 11N — escalation to the parent thread", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c", { parentThreadId: "thr_p" });
  threadDtosParent(h, "thr_p");
  h.doneDelegation("thr_c");
  await h.watchdog.onThreadIdle(c);
  // Burn the three nudges quickly.
  for (const wait of [1, 2, 4]) {
    h.advance(wait * NUDGE_MIN * 60_000 + 1);
    await h.watchdog.checkTimers();
    await h.watchdog.onThreadActive(c);
    c.status = "idle";
    await h.watchdog.onThreadIdle(c);
  }
  assert.equal(h.sends.length, 3);
  h.advance(4 * NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 4, "escalation sent");
  const esc = h.sends[3]!;
  assert.equal(esc.threadId, "thr_p", "escalation goes to the parent");
  assert.match(esc.input[0]!.text!, /^\[orchestrator:alert\]/);
  assert.match(esc.input[0]!.text!, /@thread:thr_c/);
  // Afterwards the watchdog waits silently.
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 4, "no spam after escalation");
});

/** The parent's DTO must resolve for the escalation send. */
function threadDtosParent(
  h: ReturnType<typeof makeHarness>,
  id: string,
) {
  h.threadDtos.set(id, { id, status: "idle" });
}

test("§5.6: a root coordinator escalates via push-notifications", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c", { parentThreadId: null });
  h.doneDelegation("thr_c");
  await h.watchdog.onThreadIdle(c);
  for (const wait of [1, 2, 4]) {
    h.advance(wait * NUDGE_MIN * 60_000 + 1);
    await h.watchdog.checkTimers();
    await h.watchdog.onThreadActive(c);
    c.status = "idle";
    await h.watchdog.onThreadIdle(c);
  }
  h.advance(4 * NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  const push = h.cliCalls.find((a) => a[0] === "push-notifications");
  assert.ok(push, "push CLI called for a root chat");
  assert.ok(push!.includes("--thread"));
  assert.ok(push!.includes("thr_c"));
});

test("§5.6: a productive plugin call resets the nudge schedule", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  await h.watchdog.onThreadActive(c);
  // The coordinator answers with a productive tool call.
  h.watchdog.markCoordinatorAction("thr_c");
  const w = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w.nudge_count, 0, "counter reset");
  assert.equal(w.escalated_at, null);
});

test("§5.6: a user message in the journal resets the schedule", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  const w0 = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w0.nudge_count, 1);
  // The owner's own line — not a system notice — resets the counter.
  h.eventLog.set("thr_c", [
    request(10, now() + 1, "привет, посмотри делегирования"),
    request(11, now() + 2, "[orchestrator] Напоминание (1/3): …"),
    request(12, now() + 3, "[bb system] child completed"),
  ]);
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  h.advance(1000);
  await h.watchdog.checkTimers();
  const w = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w.nudge_count, 0, "user message resets");
});

test("§5.6: running executors make sleeping the contract — no nudge", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  // A NEW active delegation for another task — the coordinator waits.
  h.store.insert({
    taskKey: "PLUG-2",
    coordinatorThreadId: "thr_c",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "acp",
  });
  await h.watchdog.onThreadIdle(c);
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "no nudge while an executor runs");
});

test("§5.6: project backlog counts under the maxActive cap", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.backlogKeys.push("PLUG-77", "PLUG-78");
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1, "backlog alone nudges");
  assert.match(h.sends[0]!.input[0]!.text!, /PLUG-77/);
});

test("§5.6: no work at all — the coordinator sleeps undisturbed", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  await h.watchdog.onThreadIdle(c);
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0);
  const w = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w.nudge_count, 0);
});

test("§5.6: a non-orchestrator thread is never watched", async () => {
  const h = makeHarness();
  h.store.setThreadRole("thr_x", "executor", "hook");
  h.threadDtos.set("thr_x", { id: "thr_x", status: "idle" });
  h.doneDelegation("thr_x");
  await h.watchdog.onThreadIdle({ id: "thr_x", status: "idle" });
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0);
});

test("§5.6: timing.coordinatorWatchdogEnabled=false disables the pass", async () => {
  const h = makeHarness({
    timing: { coordinatorWatchdogEnabled: false },
  });
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.watchdog.onThreadIdle(c);
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0);
});

test("§5.6: work cleared — the schedule resets", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  const row = h.doneDelegation("thr_c");
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  // The task got merged — nothing pending any more.
  h.store.setMerged(row.id, { into: "main", sha: "abc" });
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  const w = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w.nudge_count, 0, "cleared work resets");
  assert.equal(w.idle_since, null);
});

test("§5.6: active releases (auditing, publishing, published) exclude task from pending", async () => {
  const h = makeHarness();
  h.coordinator("thr_c");
  const row = h.doneDelegation("thr_c");
  const pendingBefore = h.store.coordinatorPendingTasks("thr_c");
  assert.equal(pendingBefore.length, 1);

  for (const st of ["auditing", "publishing", "published"]) {
    h.db.prepare("DELETE FROM releases").run();
    h.db
      .prepare(
        `INSERT INTO releases (
          task_key, project_id, coordinator_thread_id, repo_path, branch,
          target_action, target_branch, status, created_at, updated_at
        ) VALUES (?, 'proj_1', 'thr_c', '/repo', 'main', 'push', 'main', ?, 1, 1)`,
      )
      .run(row.task_key, st);

    const pendingAfter = h.store.coordinatorPendingTasks("thr_c");
    assert.equal(pendingAfter.length, 0, `${st} release excludes from pending`);
  }
});

test("§5.6: settled no-code delegation (done, no_code=1, result_commits=0) is not pending, but failed is pending", async () => {
  const h = makeHarness();
  h.coordinator("thr_c");
  const row = h.store.insert({
    taskKey: "PLUG-NC",
    coordinatorThreadId: "thr_c",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "acp",
    noCode: true,
  });
  h.store.setStatus(row.id, "done");
  const pendingDone = h.store.coordinatorPendingTasks("thr_c");
  assert.equal(pendingDone.length, 0, "settled no-code done excluded from pending");

  // But if it failed, it needs attention (reissue or cancel)
  h.store.setStatus(row.id, "failed");
  const pendingFailed = h.store.coordinatorPendingTasks("thr_c");
  assert.equal(pendingFailed.length, 1, "failed no-code is pending");
});

test("§5.6: agent tell messages do not reset the nudge schedule", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  const w0 = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w0.nudge_count, 1);

  // An incoming message from another agent (tell) must NOT reset the schedule
  h.eventLog.set("thr_c", [
    {
      seq: 20,
      type: "client/turn/requested",
      createdAt: now() + 1,
      data: {
        senderThreadId: "thr_a",
        source: "tell",
        input: [{ type: "text", text: "[bb message from thread:thr_a] ping" }],
      },
    },
  ]);
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  h.advance(1000);
  await h.watchdog.checkTimers();
  const w1 = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w1.nudge_count, 1, "agent tell does not reset nudge schedule");
});

test("§5.6: escalation occurs after +4N even with coordinatorMaxNudges=1", async () => {
  const h = makeHarness({ timing: { coordinatorMaxNudges: 1 } });
  h.coordinator("thr_p");
  const c = h.coordinator("thr_c", { parentThreadId: "thr_p" });
  h.doneDelegation("thr_c");
  await h.watchdog.onThreadIdle(c);

  // At 1N (5 min) -> nudge 1
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]!.threadId, "thr_c");

  // At 3N (15 min) -> no escalation yet (must wait +4N after nudge 1)
  c.status = "idle";
  h.advance(2 * NUDGE_MIN * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1, "no premature escalation at 3N when maxNudges=1");

  // At 5N (25 min = 1N + 4N) -> escalation to parent
  h.advance(2 * NUDGE_MIN * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1]!.threadId, "thr_p", "escalation at 1N + 4N");
});

test("§5.6: reminder includes both pending delegations and backlog keys", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c", "PLUG-10");
  h.backlogKeys.push("PLUG-99");
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  const text = h.sends[0]!.input[0]!.text!;
  assert.match(text, /PLUG-10/);
  assert.match(text, /PLUG-99/);
});

function now() {
  return Date.now();
}
