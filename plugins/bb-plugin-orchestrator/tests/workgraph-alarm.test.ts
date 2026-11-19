import assert from "node:assert/strict";
import test, { beforeEach, after } from "node:test";
import Database from "better-sqlite3";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import { type CmdRunner } from "../src/cmd.js";
import {
  DelegationStore,
  MIGRATIONS,
  ACTIVE_ALARM_NODES,
  PASSIVE_ALARM_STATUSES,
  type TaskNode,
  type TaskStatus,
} from "../src/store.js";
import {
  runRunQueue,
  assertGraphAllowsDirectAction,
} from "../src/workgraph.js";
import { parsePolicy, type Policy } from "../src/policy.js";

const ORIGINAL_BB_THREAD_ID = process.env.BB_THREAD_ID;
beforeEach(() => {
  delete process.env.BB_THREAD_ID;
});
after(() => {
  if (ORIGINAL_BB_THREAD_ID !== undefined) {
    process.env.BB_THREAD_ID = ORIGINAL_BB_THREAD_ID;
  } else {
    delete process.env.BB_THREAD_ID;
  }
});

const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

function createTestStore(): DelegationStore {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  return new DelegationStore(db);
}

function fakeCli(): { cli: BbCli; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    cli: {
      run: async (args) => {
        calls.push(args);
        return ok();
      },
    },
  };
}

const POLICY_WITH_NODE_POLICY: Policy = {
  version: 1,
  limits: { maxActive: 2 },
  levels: {
    simple: { chain: ["simple"] },
    complex: { chain: ["complex"] },
  },
  routes: {
    simple: { preset: "simple", provider: "opencode" },
    complex: { preset: "complex", provider: "devin" },
  },
  node_policy: {
    design: { timeout_seconds: 1800, max_retries: 2 },
    code: { timeout_seconds: 7200, max_retries: 3 },
    checks: { timeout_seconds: 600 },
    review: { timeout_seconds: 2400 },
  },
};

test("§28.2 п. 5: Active nodes arm node_alarm_at with node_policy timeout or default 3600s", () => {
  const store = createTestStore();
  const t0 = 1_000_000;

  store.insertTask({
    taskKey: "ALARM-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  }, t0);

  // Transition to design (active node) with custom timeout 1800s
  const tr1 = store.transitionTask({
    taskKey: "ALARM-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design",
    toStatus: "running",
    actor: "run-queue",
    reason: "start-design",
    timeoutSeconds: 1800,
  }, t0);

  assert.ok(tr1.ok);
  assert.equal(tr1.task?.node_alarm_at, t0 + 1800 * 1000);

  // Transition to code with default timeout (3600s when omitted)
  const t1 = t0 + 100_000;
  const tr2 = store.transitionTask({
    taskKey: "ALARM-1",
    expectedNode: "design",
    expectedStatus: "running",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "design-to-code",
  }, t1);

  assert.ok(tr2.ok);
  assert.equal(tr2.task?.node_alarm_at, t1 + 3600 * 1000);

  // Test every active node arms alarm
  const activeNodes: TaskNode[] = [
    "design", "spec", "spec_review", "code", "checks", "review", "design_check", "release", "research",
  ];
  for (const node of activeNodes) {
    assert.ok(ACTIVE_ALARM_NODES.has(node), `${node} must be recognized as active alarm node`);
  }
});

test("§28.2 п. 5: Passive states do NOT arm alarm (node_alarm_at = NULL)", () => {
  const store = createTestStore();
  const t0 = 1_000_000;

  store.insertTask({
    taskKey: "PASSIVE-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
  }, t0);

  // start/queued -> node_alarm_at is null
  let task = store.getTask("PASSIVE-1")!;
  assert.equal(task.node_alarm_at, null);

  // 1. owner_gate (waiting_approval) -> NULL
  store.transitionTask({
    taskKey: "PASSIVE-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "run-queue",
    reason: "gate",
  }, t0);
  task = store.getTask("PASSIVE-1")!;
  assert.equal(task.node_alarm_at, null);

  // Approve into code (running) -> armed
  store.transitionTask({
    taskKey: "PASSIVE-1",
    expectedNode: "owner_gate",
    expectedStatus: "waiting_approval",
    toNode: "code",
    toStatus: "running",
    actor: "owner",
    reason: "approved",
    timeoutSeconds: 3600,
  }, t0);
  task = store.getTask("PASSIVE-1")!;
  assert.equal(task.node_alarm_at, t0 + 3600 * 1000);

  // 2. stalled -> NULL
  store.transitionTask({
    taskKey: "PASSIVE-1",
    expectedNode: "code",
    expectedStatus: "running",
    toNode: "code",
    toStatus: "stalled",
    actor: "run-queue",
    reason: "stalled",
  }, t0 + 5000);
  task = store.getTask("PASSIVE-1")!;
  assert.equal(task.node_alarm_at, null);

  // Resume into code (running) -> re-armed
  store.transitionTask({
    taskKey: "PASSIVE-1",
    expectedNode: "code",
    expectedStatus: "stalled",
    toNode: "code",
    toStatus: "running",
    actor: "owner",
    reason: "resumed",
    timeoutSeconds: 3600,
  }, t0 + 10000);
  task = store.getTask("PASSIVE-1")!;
  assert.equal(task.node_alarm_at, t0 + 10000 + 3600 * 1000);

  // 3. blocked -> NULL
  store.transitionTask({
    taskKey: "PASSIVE-1",
    expectedNode: "code",
    expectedStatus: "running",
    toNode: "checks",
    toStatus: "blocked",
    actor: "run-queue",
    reason: "blocked",
  }, t0 + 15000);
  task = store.getTask("PASSIVE-1")!;
  assert.equal(task.node_alarm_at, null);

  // 4. release with waiting_release_note -> NULL
  store.transitionTask({
    taskKey: "PASSIVE-1",
    expectedNode: "checks",
    expectedStatus: "blocked",
    toNode: "release",
    toStatus: "waiting_release_note",
    actor: "owner",
    reason: "resumed-release",
  }, t0 + 20000);
  task = store.getTask("PASSIVE-1")!;
  assert.equal(task.node_alarm_at, null);

  // 5. release with pr_open -> NULL
  store.transitionTask({
    taskKey: "PASSIVE-1",
    expectedNode: "release",
    expectedStatus: "waiting_release_note",
    toNode: "release",
    toStatus: "pr_open",
    actor: "run-queue",
    reason: "pr-opened",
  }, t0 + 25000);
  task = store.getTask("PASSIVE-1")!;
  assert.equal(task.node_alarm_at, null);

  // 6. release with done -> NULL
  store.transitionTask({
    taskKey: "PASSIVE-1",
    expectedNode: "release",
    expectedStatus: "pr_open",
    toNode: "release",
    toStatus: "done",
    actor: "run-queue",
    reason: "pr-merged",
  }, t0 + 30000);
  task = store.getTask("PASSIVE-1")!;
  assert.equal(task.node_alarm_at, null);

  // Verify all passive statuses
  const passiveStatuses: TaskStatus[] = [
    "waiting_approval", "waiting_release_note", "pr_open", "deferred", "blocked", "done", "stalled", "cancelled",
  ];
  for (const st of passiveStatuses) {
    assert.ok(PASSIVE_ALARM_STATUSES.has(st), `${st} must be in PASSIVE_ALARM_STATUSES`);
  }
});

test("§28.2 п. 5: Resetting alarm on new commit from executor", async () => {
  const store = createTestStore();
  const { cli } = fakeCli();
  const t0 = 1_000_000;
  let currentTime = t0;

  store.insertTask({
    taskKey: "COMMIT-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    branch: "bb/commit-1-simple",
  }, t0);

  store.transitionTask({
    taskKey: "COMMIT-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start-code",
    timeoutSeconds: 3600,
  }, t0);

  let currentGitSha = "sha-initial-111";
  const cmd: CmdRunner = {
    run: async (cmdName, args) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${currentGitSha}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  // Tick 1: initializes last_alarm_branch_sha
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    bbCli: cli,
    policy: POLICY_WITH_NODE_POLICY,
    now: () => currentTime,
  });

  let task = store.getTask("COMMIT-1")!;
  const initialAlarm = task.node_alarm_at;
  assert.equal(initialAlarm, t0 + 3600 * 1000);

  // Advance time by 1000s without new commit: routine tick does NOT reset alarm
  currentTime = t0 + 1000_000;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    bbCli: cli,
    policy: POLICY_WITH_NODE_POLICY,
    now: () => currentTime,
  });
  task = store.getTask("COMMIT-1")!;
  assert.equal(task.node_alarm_at, initialAlarm, "Routine tick without commit must NOT reset alarm");

  // Executor creates a new commit in task branch!
  currentGitSha = "sha-new-commit-222";
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    bbCli: cli,
    policy: POLICY_WITH_NODE_POLICY,
    now: () => currentTime,
  });

  task = store.getTask("COMMIT-1")!;
  // Configured code timeout in POLICY_WITH_NODE_POLICY is 7200s
  assert.equal(task.node_alarm_at, currentTime + 7200 * 1000, "New commit must reset node_alarm_at");
});

test("§28.2 п. 5: Resetting alarm on review verdict", async () => {
  const store = createTestStore();
  const { cli } = fakeCli();
  const t0 = 1_000_000;
  let currentTime = t0;

  store.insertTask({
    taskKey: "VERDICT-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, t0);

  store.transitionTask({
    taskKey: "VERDICT-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "review",
    toStatus: "running",
    actor: "run-queue",
    reason: "start-review",
    timeoutSeconds: 2400,
  }, t0);

  let task = store.getTask("VERDICT-1")!;
  assert.equal(task.node_alarm_at, t0 + 2400 * 1000);

  // Advance time: routine tick does not reset alarm
  currentTime = t0 + 500_000;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli,
    policy: POLICY_WITH_NODE_POLICY,
    now: () => currentTime,
  });
  task = store.getTask("VERDICT-1")!;
  assert.equal(task.node_alarm_at, t0 + 2400 * 1000);

  // Verdict recorded
  store.updateTask("VERDICT-1", {
    payload: JSON.stringify({ review_verdict: "CHANGES", review_blockers: 1 }),
  });

  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli,
    policy: POLICY_WITH_NODE_POLICY,
    now: () => currentTime,
  });

  // Task looped back to code (running), with alarm armed for code (7200s)
  task = store.getTask("VERDICT-1")!;
  assert.equal(task.node, "code");
  assert.equal(task.status, "running");
  assert.equal(task.node_alarm_at, currentTime + 7200 * 1000);
});

test("§28.2 п. 5: Alarm Trigger 1 (ping + event) and Trigger 2 (stalled + stop thread)", async () => {
  const store = createTestStore();
  const { cli, calls } = fakeCli();
  const t0 = 1_000_000;
  let currentTime = t0;

  store.insertTask({
    taskKey: "ALARM-FIRE-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, t0);

  const timeoutSeconds = 600; // 10 minutes
  store.transitionTask({
    taskKey: "ALARM-FIRE-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start-code",
    timeoutSeconds,
  }, t0);

  // Create an executor delegation with thread_id
  const d = store.insert({
    taskKey: "ALARM-FIRE-1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  store.setThreadInfo(d.id, "thr_executor_42");

  let task = store.getTask("ALARM-FIRE-1")!;
  assert.equal(task.node_alarm_at, t0 + 600 * 1000);

  // Advance time to alarm expiration: Trigger 1
  currentTime = t0 + 600_000 + 1; // 1ms past alarm
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli,
    policy: {
      ...POLICY_WITH_NODE_POLICY,
      node_policy: { code: { timeout_seconds: timeoutSeconds } },
    },
    now: () => currentTime,
  });

  // Verify Trigger 1 actions:
  // 1. Thread tell was invoked to ping executor
  const tellCall = calls.find((c) => c[0] === "thread" && c[1] === "tell" && c[2] === "thr_executor_42");
  assert.ok(tellCall, "Trigger 1 must ping executor thread");
  assert.match(tellCall[3] ?? "", /превышено время ожидания/);

  // 2. Task remains running
  task = store.getTask("ALARM-FIRE-1")!;
  assert.equal(task.node, "code");
  assert.equal(task.status, "running");

  // 3. Alarm count is 1, re-armed for another timeoutSeconds
  const payload = JSON.parse(task.payload ?? "{}");
  assert.equal(payload.alarm_count, 1);
  assert.equal(task.node_alarm_at, currentTime + timeoutSeconds * 1000);

  // 4. Event task.alarm_triggered was recorded
  const events = store.listEvents ? store.listEvents() : [];
  // Verify events table has task.alarm_triggered
  const rawEvents = (store as any).db
    .prepare("SELECT * FROM events WHERE kind = 'task.alarm_triggered'")
    .all();
  assert.equal(rawEvents.length, 1);
  const evPayload = JSON.parse(rawEvents[0].payload);
  assert.equal(evPayload.event, "task.alarm_triggered");
  assert.equal(evPayload.task, "ALARM-FIRE-1");
  assert.equal(evPayload.node, "code");

  // Advance time to 2nd alarm: Trigger 2
  currentTime = currentTime + timeoutSeconds * 1000 + 1;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli,
    policy: {
      ...POLICY_WITH_NODE_POLICY,
      node_policy: { code: { timeout_seconds: timeoutSeconds } },
    },
    now: () => currentTime,
  });

  // Verify Trigger 2 actions:
  // 1. Thread stop was invoked
  const stopCall = calls.find((c) => c[0] === "thread" && c[1] === "stop" && c[2] === "thr_executor_42");
  assert.ok(stopCall, "Trigger 2 must stop executor thread");

  // 2. Task transitioned to stalled
  task = store.getTask("ALARM-FIRE-1")!;
  assert.equal(task.node, "code");
  assert.equal(task.status, "stalled");
  assert.equal(task.node_alarm_at, null, "stalled task must have node_alarm_at = NULL");

  // 3. Second task.alarm_triggered event emitted
  const allEvents = (store as any).db
    .prepare("SELECT * FROM events WHERE kind = 'task.alarm_triggered'")
    .all();
  assert.equal(allEvents.length, 2);
  const ev2 = JSON.parse(allEvents[1].payload);
  assert.equal(ev2.outcome, "stalled");
});

test("§28.2 п. 5: Active running thread gets up to 3× timeout before stalling", async () => {
  const store = createTestStore();
  const { cli, calls } = fakeCli();
  const t0 = 1_000_000;
  let currentTime = t0;

  store.insertTask({
    taskKey: "RUNNING-TH-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, t0);

  const timeoutSeconds = 600;
  store.transitionTask({
    taskKey: "RUNNING-TH-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start-code",
    timeoutSeconds,
  }, t0);

  const d = store.insert({
    taskKey: "RUNNING-TH-1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  store.setThreadInfo(d.id, "thr_active_99");

  // Thread is active / running
  const getThread = async (_id: string) => ({ status: "active" });

  // 1st alarm at 1× timeout
  currentTime = t0 + 600_000 + 1;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli,
    getThread,
    policy: {
      ...POLICY_WITH_NODE_POLICY,
      node_policy: { code: { timeout_seconds: timeoutSeconds } },
    },
    now: () => currentTime,
  });

  let task = store.getTask("RUNNING-TH-1")!;
  assert.equal(task.status, "running", "Must stay running on 1st alarm");

  // 2nd alarm at 2× timeout (elapsed 1200s < 3× 600s = 1800s): running thread does NOT stall!
  currentTime = t0 + 1200_000 + 1;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli,
    getThread,
    policy: {
      ...POLICY_WITH_NODE_POLICY,
      node_policy: { code: { timeout_seconds: timeoutSeconds } },
    },
    now: () => currentTime,
  });

  task = store.getTask("RUNNING-TH-1")!;
  assert.equal(task.status, "running", "Running thread must NOT be stalled before 3× timeout");

  // Exceeding 3× timeout (elapsed 1850s > 1800s): now transitions to stalled!
  currentTime = t0 + 1850_000;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli,
    getThread,
    policy: {
      ...POLICY_WITH_NODE_POLICY,
      node_policy: { code: { timeout_seconds: timeoutSeconds } },
    },
    now: () => currentTime,
  });

  task = store.getTask("RUNNING-TH-1")!;
  assert.equal(task.status, "stalled", "Running thread must be stalled once 3× timeout is exceeded");
});

test("§32: Strict mode guards block direct delegate, merge, release", () => {
  const store = createTestStore();
  const t0 = 1_000_000;

  // 1. Task not enqueued -> graph-required
  assert.throws(
    () => assertGraphAllowsDirectAction(store, "UNKNOWN-99", "strict", { command: "delegate" }),
    (e: any) => e.code === "graph-required",
  );

  assert.throws(
    () => assertGraphAllowsDirectAction(store, "UNKNOWN-99", "strict", { command: "merge" }),
    (e: any) => e.code === "graph-required",
  );

  assert.throws(
    () => assertGraphAllowsDirectAction(store, "UNKNOWN-99", "strict", { command: "release" }),
    (e: any) => e.code === "graph-required",
  );

  // 2. Task enqueued and active -> graph-managed
  store.insertTask({
    taskKey: "ACTIVE-99",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, t0);

  assert.throws(
    () => assertGraphAllowsDirectAction(store, "ACTIVE-99", "strict", { command: "delegate" }),
    (e: any) => e.code === "graph-managed" && e.message.includes("управляется графом"),
  );

  // 3. Task done -> graph-managed (completed)
  store.transitionTask({
    taskKey: "ACTIVE-99",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "release",
    toStatus: "done",
    actor: "run-queue",
    reason: "done",
  }, t0);

  assert.throws(
    () => assertGraphAllowsDirectAction(store, "ACTIVE-99", "strict", { command: "delegate" }),
    (e: any) => e.code === "graph-managed" && e.message.includes("завершена (done)"),
  );
});

test("§28.2 п. 5: alarm_count resets to 0 on node transition and store resolver works", () => {
  const store = createTestStore();
  store.setNodeTimeoutResolver((node) => {
    if (node === "design") return 1800;
    if (node === "code") return 7200;
    return 3600;
  });
  const t0 = 1_000_000;

  store.insertTask({
    taskKey: "RESET-ALARM-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  }, t0);

  // Transition to design using resolver (no explicit timeoutSeconds) -> 1800s
  const tr1 = store.transitionTask({
    taskKey: "RESET-ALARM-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design",
    toStatus: "running",
    actor: "run-queue",
    reason: "start-design",
  }, t0);
  assert.ok(tr1.ok);
  assert.equal(tr1.task?.node_alarm_at, t0 + 1800 * 1000);

  // Simulate alarm Trigger 1 setting alarm_count = 1
  store.updateTask("RESET-ALARM-1", {
    payload: JSON.stringify({ alarm_count: 1 }),
  });
  let task = store.getTask("RESET-ALARM-1")!;
  assert.equal(JSON.parse(task.payload!).alarm_count, 1);

  // Transition to code (node change) -> alarm_count must reset to 0, node_alarm_at uses code timeout (7200s)
  const t1 = t0 + 1800 * 1000;
  const tr2 = store.transitionTask({
    taskKey: "RESET-ALARM-1",
    expectedNode: "design",
    expectedStatus: "running",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "advance",
  }, t1);
  assert.ok(tr2.ok);
  assert.equal(tr2.task?.node_alarm_at, t1 + 7200 * 1000);
  assert.equal(JSON.parse(tr2.task!.payload!).alarm_count, 0);

  // Transition to checks (non-delegation node) with alarm_count = 1
  store.updateTask("RESET-ALARM-1", {
    payload: JSON.stringify({ alarm_count: 1 }),
  });
  const t2 = t1 + 7200 * 1000;
  const tr3 = store.transitionTask({
    taskKey: "RESET-ALARM-1",
    expectedNode: "code",
    expectedStatus: "running",
    toNode: "checks",
    toStatus: "running",
    actor: "run-queue",
    reason: "advance",
  }, t2);
  assert.ok(tr3.ok);
  assert.equal(JSON.parse(tr3.task!.payload!).alarm_count, 0);
});

test("§28.2 п. 5: design_check_verdict resets alarm and checks node does not ping old code thread", async () => {
  const store = createTestStore();
  const cli = fakeCli();
  const t0 = 1_000_000;

  store.insertTask({
    taskKey: "DC-VERDICT-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  }, t0);

  store.transitionTask({
    taskKey: "DC-VERDICT-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design_check",
    toStatus: "running",
    actor: "run-queue",
    reason: "design-check",
    timeoutSeconds: 3600,
  }, t0);

  // 1. Advance tick with design_check_verdict recorded
  store.updateTask("DC-VERDICT-1", {
    payload: JSON.stringify({ design_check_verdict: "OK: approved", alarm_count: 1 }),
  });

  const t1 = t0 + 1000;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli.cli,
    now: () => t1,
    policy: POLICY_WITH_NODE_POLICY,
  });

  const taskAfterVerdict = store.getTask("DC-VERDICT-1")!;
  assert.equal(taskAfterVerdict.node_alarm_at, t1 + 3600 * 1000);
  assert.equal(JSON.parse(taskAfterVerdict.payload!).alarm_count, 0);

  // 2. Checks node alarm expiry does not ping previous code thread
  const del = store.insert({
    taskKey: "CHECKS-NO-PING",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
    now: t0 + 10,
  });
  store.setThreadInfo(del.id, "thr_old_code");

  store.insertTask({
    taskKey: "CHECKS-NO-PING",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, t0);

  store.transitionTask({
    taskKey: "CHECKS-NO-PING",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "checks",
    toStatus: "running",
    actor: "run-queue",
    reason: "checks",
    timeoutSeconds: 600,
  }, t0);

  // Trigger 1 at t0 + 600s
  cli.calls.length = 0;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli.cli,
    now: () => t0 + 600 * 1000,
    policy: POLICY_WITH_NODE_POLICY,
  });

  // Verify no thread tell call was made to thr_old_code
  assert.equal(cli.calls.length, 0, "checks node must not ping old code thread");

  // Verify task.alarm_triggered event has both task and taskKey
  const events = store.listEvents("task.alarm_triggered");
  assert.ok(events.length > 0);
  const evPayload = JSON.parse(events[events.length - 1].payload!);
  assert.equal(evPayload.task, "CHECKS-NO-PING");
  assert.equal(evPayload.taskKey, "CHECKS-NO-PING");
});

test("§28.2 п. 5: same-node resume from deferred resets alarm_count, entered_at, and arms alarm", async () => {
  const store = createTestStore();
  const cli = fakeCli();
  const t0 = 1_000_000;

  const del = store.insert({
    taskKey: "SAME-RESUME-1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
    now: t0 + 10,
  });
  store.setThreadInfo(del.id, "thr_code_exec");

  store.insertTask({
    taskKey: "SAME-RESUME-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, t0);

  // 1. Enter code/running with timeout 3600s
  store.transitionTask({
    taskKey: "SAME-RESUME-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start-code",
    timeoutSeconds: 3600,
  }, t0);

  // Trigger 1 at t0 + 3600s sets alarm_count = 1
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli.cli,
    now: () => t0 + 3600 * 1000,
    policy: POLICY_WITH_NODE_POLICY,
  });

  let task = store.getTask("SAME-RESUME-1")!;
  assert.equal(JSON.parse(task.payload!).alarm_count, 1);
  assert.equal(task.node_alarm_at, t0 + (3600 + 7200) * 1000);

  // 2. Task deferred at t0 + 4000s -> passive state: node_alarm_at = NULL
  const tDefer = t0 + 4000 * 1000;
  store.transitionTask({
    taskKey: "SAME-RESUME-1",
    expectedNode: "code",
    expectedStatus: "running",
    toNode: "code",
    toStatus: "deferred",
    actor: "owner",
    reason: "defer",
  }, tDefer);

  task = store.getTask("SAME-RESUME-1")!;
  assert.equal(task.status, "deferred");
  assert.equal(task.node_alarm_at, null);

  // 3. Resume from deferred at tResume = t0 + 10000s (>2× timeout later)
  const tResume = t0 + 10000 * 1000;
  const trResume = store.transitionTask({
    taskKey: "SAME-RESUME-1",
    expectedNode: "code",
    expectedStatus: "deferred",
    toNode: "code",
    toStatus: "running",
    actor: "owner",
    reason: "resume",
    timeoutSeconds: 7200,
  }, tResume);

  assert.ok(trResume.ok);
  task = store.getTask("SAME-RESUME-1")!;
  assert.equal(task.status, "running");
  assert.equal(task.entered_at, tResume, "entered_at must be reset upon resume into running");
  assert.equal(JSON.parse(task.payload!).alarm_count, 0, "alarm_count must be reset to 0 upon resume into running");
  assert.equal(task.node_alarm_at, tResume + 7200 * 1000, "node_alarm_at must be re-armed from resume time");

  // 4. First alarm after resume at tResume + 7200s must ping (Trigger 1), NOT stall!
  cli.calls.length = 0;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli.cli,
    now: () => tResume + 7200 * 1000,
    policy: POLICY_WITH_NODE_POLICY,
  });

  task = store.getTask("SAME-RESUME-1")!;
  assert.equal(task.status, "running", "Task must stay running on first alarm after resume");
  assert.equal(JSON.parse(task.payload!).alarm_count, 1);
  assert.equal(cli.calls.length, 1, "Must have pinged executor on first alarm after resume");
  assert.ok(cli.calls[0].includes("tell"));

  // 4b. Second alarm after resume at tResume + 2×7200s with active thread -> ping again, stay running!
  cli.calls.length = 0;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    bbCli: cli.cli,
    getThread: async () => ({ status: "active" }),
    now: () => tResume + 2 * 7200 * 1000,
    policy: POLICY_WITH_NODE_POLICY,
  });

  task = store.getTask("SAME-RESUME-1")!;
  assert.equal(task.status, "running", "Active thread must get 3× grace after resume");
  assert.equal(JSON.parse(task.payload!).alarm_count, 2);
  assert.equal(cli.calls.length, 1, "Must have pinged active executor on second alarm");

  // 5. Test waiting_release_note -> release/running same-node resume
  store.insertTask({
    taskKey: "REL-RESUME-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  }, t0);

  store.transitionTask({
    taskKey: "REL-RESUME-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "release",
    toStatus: "waiting_release_note",
    actor: "run-queue",
    reason: "release-note-needed",
  }, t0);

  task = store.getTask("REL-RESUME-1")!;
  assert.equal(task.node_alarm_at, null);

  const tRelResume = t0 + 5000 * 1000;
  store.transitionTask({
    taskKey: "REL-RESUME-1",
    expectedNode: "release",
    expectedStatus: "waiting_release_note",
    toNode: "release",
    toStatus: "running",
    actor: "run-queue",
    reason: "release-note-provided",
    timeoutSeconds: 3600,
  }, tRelResume);

  task = store.getTask("REL-RESUME-1")!;
  assert.equal(task.status, "running");
  assert.equal(task.entered_at, tRelResume);
  assert.equal(task.node_alarm_at, tRelResume + 3600 * 1000);
});
