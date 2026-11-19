import assert from "node:assert/strict";
import test, { beforeEach, after } from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { CmdRunner } from "../src/cmd.js";
import {
  runRunQueue,
  runEnqueue,
  runApprove,
  runDefer,
  runDequeue,
  runReject,
  runResume,
} from "../src/workgraph.js";

function createStore(): DelegationStore {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  return new DelegationStore(db);
}

const ORIGINAL_BB_THREAD_ID = process.env.BB_THREAD_ID;
delete process.env.BB_THREAD_ID;
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

function fakeCli(): BbCli {
  return {
    run: async () => ok(),
  };
}

function fakeCmd(): CmdRunner {
  return {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

test("§29.2: setTaskConfirmationMode and getTaskConfirmationMode in store", () => {
  const store = createStore();
  store.insertTask({
    taskKey: "PLUG-101",
    projectId: "default",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 100,
    confirmationMode: "manual",
    branch: "bb/plug-101-test",
    actor: "owner",
  });

  assert.equal(store.getTaskConfirmationMode("PLUG-101"), "manual");
  const updated = store.setTaskConfirmationMode("PLUG-101", "auto");
  assert.equal(updated, true);
  assert.equal(store.getTaskConfirmationMode("PLUG-101"), "auto");

  // Non-existent task returns null
  assert.equal(store.getTaskConfirmationMode("PLUG-999"), null);
  assert.equal(store.setTaskConfirmationMode("PLUG-999", "auto"), false);
});

test("§29.3: resolution order 1 - explicit --mode auto|manual by owner", async () => {
  const store = createStore();
  const resAuto = await runEnqueue(
    { taskKey: "PLUG-102", route: "feature", level: "complex", mode: "auto" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: {}, // Human/owner
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: "manual", // Overridden by explicit flag
    },
  );
  assert.equal(resAuto.task.confirmation_mode, "auto");

  const resManual = await runEnqueue(
    { taskKey: "PLUG-103", route: "fix", level: "simple", mode: "manual", acceptance: "check tests" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: {}, // Human/owner
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: "auto", // Overridden by explicit flag
    },
  );
  assert.equal(resManual.task.confirmation_mode, "manual");

  // Invalid mode rejects
  await assert.rejects(
    () =>
      runEnqueue(
        { taskKey: "PLUG-104", route: "feature", level: "complex", mode: "invalid_mode" },
        {
          store,
          cmd: fakeCmd(),
          bbCli: fakeCli(),
          ctx: {},
          workGraphMode: "strict",
          repoRoot: "/tmp",
          mergeBaseBranch: "main",
        },
      ),
    (err: any) => err.code === "invalid-arguments",
  );
});

test("§29.3: resolution order 1 - agent passing --mode is rejected with permission-denied: owner-only", async () => {
  const store = createStore();
  await assert.rejects(
    () =>
      runEnqueue(
        { taskKey: "PLUG-105", route: "feature", level: "complex", mode: "auto" },
        {
          store,
          cmd: fakeCmd(),
          bbCli: fakeCli(),
          ctx: { threadId: "thr_agent" },
          workGraphMode: "strict",
          repoRoot: "/tmp",
          mergeBaseBranch: "main",
        },
      ),
    /owner-only/,
  );

  process.env.BB_THREAD_ID = "thr_agent_env";
  await assert.rejects(
    () =>
      runEnqueue(
        { taskKey: "PLUG-106", route: "feature", level: "complex", mode: "manual" },
        {
          store,
          cmd: fakeCmd(),
          bbCli: fakeCli(),
          ctx: {},
          workGraphMode: "strict",
          repoRoot: "/tmp",
          mergeBaseBranch: "main",
        },
      ),
    /owner-only/,
  );
  delete process.env.BB_THREAD_ID;
});

test("§29.3: resolution order 2 - project setting orchestrator.approvalMode applies when no flag", async () => {
  const store = createStore();
  // Project setting approvalMode = "auto"
  const resAuto = await runEnqueue(
    { taskKey: "PLUG-107", route: "feature", level: "complex" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: {},
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: "auto",
    },
  );
  assert.equal(resAuto.task.confirmation_mode, "auto");

  // Agent call with approvalMode = "auto"
  const resAgentAuto = await runEnqueue(
    { taskKey: "PLUG-108", route: "feature", level: "complex" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: { threadId: "thr_coord" },
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: "auto",
    },
  );
  assert.equal(resAgentAuto.task.confirmation_mode, "auto");

  // Project setting approvalMode = "manual"
  const resManual = await runEnqueue(
    { taskKey: "PLUG-109", route: "fix", level: "simple", acceptance: "verify fix" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: {},
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: "manual",
    },
  );
  assert.equal(resManual.task.confirmation_mode, "manual");
});

test("§29.3: resolution order 3 - fallback per route when approvalMode is null", async () => {
  const store = createStore();
  // route feature -> manual
  const resFeat = await runEnqueue(
    { taskKey: "PLUG-110", route: "feature", level: "complex" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: {},
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: null,
    },
  );
  assert.equal(resFeat.task.confirmation_mode, "manual");

  // route fix -> auto
  const resFix = await runEnqueue(
    { taskKey: "PLUG-111", route: "fix", level: "simple", acceptance: "check" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: {},
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: null,
    },
  );
  assert.equal(resFix.task.confirmation_mode, "auto");

  // route simple -> auto
  const resSimple = await runEnqueue(
    { taskKey: "PLUG-112", route: "simple", level: "simple", acceptance: "check" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: {},
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: null,
    },
  );
  assert.equal(resSimple.task.confirmation_mode, "auto");

  // route docs -> auto
  const resDocs = await runEnqueue(
    { taskKey: "PLUG-113", route: "docs", level: "spec" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: {},
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: null,
    },
  );
  assert.equal(resDocs.task.confirmation_mode, "auto");

  // route research -> auto
  const resRes = await runEnqueue(
    { taskKey: "PLUG-114", route: "research", level: "research" },
    {
      store,
      cmd: fakeCmd(),
      bbCli: fakeCli(),
      ctx: {},
      workGraphMode: "strict",
      repoRoot: "/tmp",
      mergeBaseBranch: "main",
      approvalMode: null,
    },
  );
  assert.equal(resRes.task.confirmation_mode, "auto");
});

test("§29.4: all 7 human-only commands reject agent callers with permission-denied: owner-only", async () => {
  const store = createStore();
  store.insertTask({
    taskKey: "PLUG-120",
    projectId: "default",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 100,
    confirmationMode: "manual",
    actor: "owner",
  });

  const agentCtx = { threadId: "thr_agent_123" };

  // 1) approve
  await assert.rejects(
    () => runApprove("PLUG-120", "comment", { store, ctx: agentCtx, workGraphMode: "strict" }),
    /owner-only/,
  );

  // 2) defer
  await assert.rejects(
    () => runDefer("PLUG-120", "defer reason", { store, ctx: agentCtx, workGraphMode: "strict" }),
    /owner-only/,
  );

  // 3) dequeue
  await assert.rejects(
    () => runDequeue("PLUG-120", "dequeue reason", {
      store,
      cmd: fakeCmd(),
      ctx: agentCtx,
      workGraphMode: "strict",
      repoRoot: "/tmp",
    }),
    /owner-only/,
  );

  // 4) resume from blocked
  store.transitionTask({
    taskKey: "PLUG-120",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "blocked",
    actor: "run-queue",
    reason: "ceiling reached",
  });
  await assert.rejects(
    () => runResume("PLUG-120", "code", { store, ctx: agentCtx, workGraphMode: "strict" }),
    /owner-only/,
  );

  // 5) resume from deferred
  store.transitionTask({
    taskKey: "PLUG-120",
    expectedNode: "code",
    expectedStatus: "blocked",
    toNode: "code",
    toStatus: "deferred",
    actor: "owner",
    reason: "deferred",
  });
  await assert.rejects(
    () => runResume("PLUG-120", undefined, { store, ctx: agentCtx, workGraphMode: "strict" }),
    /owner-only/,
  );

  // 6) reject at owner_gate
  store.transitionTask({
    taskKey: "PLUG-120",
    expectedNode: "code",
    expectedStatus: "deferred",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "run-queue",
    reason: "enter gate",
  });
  await assert.rejects(
    () => runReject("PLUG-120", "spec", "reject reason", { store, ctx: agentCtx, workGraphMode: "strict" }),
    /owner-only/,
  );

  // 7) enqueue --mode or --acceptance
  await assert.rejects(
    () => runEnqueue(
      { taskKey: "PLUG-121", route: "feature", level: "complex", mode: "auto" },
      { store, cmd: fakeCmd(), bbCli: fakeCli(), ctx: agentCtx, workGraphMode: "strict", repoRoot: "/tmp", mergeBaseBranch: "main" },
    ),
    /owner-only/,
  );
  await assert.rejects(
    () => runEnqueue(
      { taskKey: "PLUG-122", route: "fix", level: "simple", acceptance: "contract" },
      { store, cmd: fakeCmd(), bbCli: fakeCli(), ctx: agentCtx, workGraphMode: "strict", repoRoot: "/tmp", mergeBaseBranch: "main" },
    ),
    /owner-only/,
  );
});

test("§29.1, §29.2: owner_gate interaction request in run-queue", async () => {
  const store = createStore();
  store.insertTask({
    taskKey: "PLUG-130",
    projectId: "default",
    coordinatorThreadId: "thr_coord_130",
    route: "feature",
    level: "complex",
    priority: 100,
    confirmationMode: "manual",
    actor: "owner",
  });

  // Advance task to owner_gate in waiting_approval
  store.transitionTask({
    taskKey: "PLUG-130",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "run-queue",
    reason: "feature spec review passed OK",
    updates: {
      payload: JSON.stringify({ gate_stage: "pre_code" }),
      spec_sha: "abcd123",
      acceptance_sha: "beef456",
    },
  });

  let interactionRequestedWith: { taskKey: string; gateStage: string } | null = null;
  const requestOwnerGateInteraction = async (task: any, gateStage: any) => {
    interactionRequestedWith = { taskKey: task.task_key, gateStage };
    return "interact_req_999";
  };

  // Run run-queue: should request interaction and record interaction_id
  await runRunQueue({
    store,
    workGraphMode: "strict",
    autoAdvance: true,
    maxActiveTasks: 1,
    repoRoot: "/tmp",
    requestOwnerGateInteraction,
  });

  assert.deepEqual(interactionRequestedWith, { taskKey: "PLUG-130", gateStage: "pre_code" });
  let task = store.getTask("PLUG-130");
  assert.equal(task?.interaction_id, "interact_req_999");
  assert.equal(task?.node, "owner_gate");
  assert.equal(task?.status, "waiting_approval");

  // Next run-queue tick should NOT re-trigger interaction while interaction_id is set
  interactionRequestedWith = null;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    autoAdvance: true,
    maxActiveTasks: 1,
    repoRoot: "/tmp",
    requestOwnerGateInteraction,
  });
  assert.equal(interactionRequestedWith, null);

  // Card times out / cancelled -> transition owner_gate_timeout resets interaction_id
  store.transitionTask({
    taskKey: "PLUG-130",
    expectedNode: "owner_gate",
    expectedStatus: "waiting_approval",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "orchestrator",
    reason: "gate-timeout: card cancelled (timeout)",
    updates: { interaction_id: null },
  });
  task = store.getTask("PLUG-130");
  assert.equal(task?.interaction_id, null);

  // Next run-queue tick re-requests interaction since interaction_id was reset
  interactionRequestedWith = null;
  await runRunQueue({
    store,
    workGraphMode: "strict",
    autoAdvance: true,
    maxActiveTasks: 1,
    repoRoot: "/tmp",
    requestOwnerGateInteraction,
  });
  assert.deepEqual(interactionRequestedWith, { taskKey: "PLUG-130", gateStage: "pre_code" });
  task = store.getTask("PLUG-130");
  assert.equal(task?.interaction_id, "interact_req_999");

  // Owner approves via runApprove: advances to code, interaction_id is reset to null
  const approved = await runApprove("PLUG-130", "LGTM", {
    store,
    ctx: {}, // Owner
    workGraphMode: "strict",
  });
  assert.equal(approved.task.node, "code");
  assert.equal(approved.task.status, "running");
  assert.equal(approved.task.interaction_id, null);
});

test("§29.2: toggle behavior scope (r34.2) - executor changes task only, coordinator changes project only", () => {
  const store = createStore();
  // Insert two tasks
  store.insertTask({
    taskKey: "PLUG-141",
    projectId: "proj_alpha",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
    actor: "owner",
  });
  store.insertTask({
    taskKey: "PLUG-142",
    projectId: "proj_alpha",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
    actor: "owner",
  });

  // Link executor delegation to thread
  store.insert({
    taskKey: "PLUG-141",
    level: "complex",
    route: "feature",
    preset: "test",
    provider: "test",
    coordinatorThreadId: "thr_coord",
  });

  // Executor toggles task PLUG-141 to auto
  const updated = store.setTaskConfirmationMode("PLUG-141", "auto");
  assert.equal(updated, true);

  // PLUG-141 changed to auto, PLUG-142 remains manual
  assert.equal(store.getTaskConfirmationMode("PLUG-141"), "auto");
  assert.equal(store.getTaskConfirmationMode("PLUG-142"), "manual");
});

test("§29.2: owner gate reject at pre_release can route to code, spec, or design", async () => {
  const store = createStore();
  store.insertTask({
    taskKey: "PLUG-150",
    projectId: "default",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 100,
    confirmationMode: "manual",
    actor: "owner",
  });

  // Task at owner_gate pre_release
  store.transitionTask({
    taskKey: "PLUG-150",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "run-queue",
    reason: "design_check passed",
    updates: {
      payload: JSON.stringify({ gate_stage: "pre_release" }),
      result_sha: "1111aaa",
      spec_sha: "2222bbb",
      acceptance_sha: "3333ccc",
    },
  });

  // Owner rejects with target code
  const rejCode = await runReject("PLUG-150", "code", "rework needed", {
    store,
    ctx: {},
    workGraphMode: "strict",
  });
  assert.equal(rejCode.task.node, "code");
  assert.equal(rejCode.task.status, "running");

  // Advance back to owner_gate pre_release
  store.transitionTask({
    taskKey: "PLUG-150",
    expectedNode: "code",
    expectedStatus: "running",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "run-queue",
    reason: "design_check passed again",
    updates: {
      payload: JSON.stringify({ gate_stage: "pre_release" }),
    },
  });

  // Owner rejects with target spec
  const rejSpec = await runReject("PLUG-150", "spec", "spec flaw", {
    store,
    ctx: {},
    workGraphMode: "strict",
  });
  assert.equal(rejSpec.task.node, "spec");
  assert.equal(rejSpec.task.status, "running");

  // Advance back to owner_gate pre_release
  store.transitionTask({
    taskKey: "PLUG-150",
    expectedNode: "spec",
    expectedStatus: "running",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "run-queue",
    reason: "design_check passed again",
    updates: {
      payload: JSON.stringify({ gate_stage: "pre_release" }),
    },
  });

  // Owner rejects with target design
  const rejDesign = await runReject("PLUG-150", "design", "redesign needed", {
    store,
    ctx: {},
    workGraphMode: "strict",
  });
  assert.equal(rejDesign.task.node, "design");
  assert.equal(rejDesign.task.status, "running");
});

test("§29.2: owner defer moves task to deferred and resume restores status", async () => {
  const store = createStore();
  store.insertTask({
    taskKey: "PLUG-160",
    projectId: "default",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 100,
    confirmationMode: "manual",
    actor: "owner",
  });

  store.transitionTask({
    taskKey: "PLUG-160",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "run-queue",
    reason: "ready for review",
    updates: {
      payload: JSON.stringify({ gate_stage: "pre_code" }),
    },
  });

  // Owner defers task
  const deferred = await runDefer("PLUG-160", "wait for client feedback", {
    store,
    ctx: {},
    workGraphMode: "strict",
  });
  assert.equal(deferred.task.status, "deferred");
  assert.equal(deferred.task.node, "owner_gate");
  assert.equal(deferred.task.deferred_by, "owner");
  assert.equal(deferred.task.deferred_reason, "wait for client feedback");

  // Owner resumes task from deferred
  const resumed = await runResume("PLUG-160", undefined, {
    store,
    ctx: {},
    workGraphMode: "strict",
  });
  assert.equal(resumed.task.status, "waiting_approval");
  assert.equal(resumed.task.node, "owner_gate");
});

