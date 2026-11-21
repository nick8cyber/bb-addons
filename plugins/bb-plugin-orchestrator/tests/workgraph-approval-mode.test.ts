import assert from "node:assert/strict";
import test, { beforeEach, afterEach, after } from "node:test";
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
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import { makeTempDir } from "./helpers/temp.js";

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

test("§29.2: owner defer moves task to deferred and resume restores status with interaction_id reset", async () => {
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
      interaction_id: "interact_old_card_123",
    },
  });

  // Verify interaction_id is present initially
  assert.equal(store.getTask("PLUG-160")?.interaction_id, "interact_old_card_123");

  // Owner defers task -> interaction_id is reset to null!
  const deferred = await runDefer("PLUG-160", "wait for client feedback", {
    store,
    ctx: {},
    workGraphMode: "strict",
  });
  assert.equal(deferred.task.status, "deferred");
  assert.equal(deferred.task.node, "owner_gate");
  assert.equal(deferred.task.deferred_by, "owner");
  assert.equal(deferred.task.deferred_reason, "wait for client feedback");
  assert.equal(deferred.task.interaction_id, null);

  // Owner resumes task from deferred -> interaction_id is null and waiting_approval restored
  const resumed = await runResume("PLUG-160", undefined, {
    store,
    ctx: {},
    workGraphMode: "strict",
  });
  assert.equal(resumed.task.status, "waiting_approval");
  assert.equal(resumed.task.node, "owner_gate");
  assert.equal(resumed.task.interaction_id, null);

  // Run run-queue: verifies interaction is re-requested and advancedCount is 0 (card request doesn't inflate advancedCount)
  let requested = false;
  const resQueue = await runRunQueue({
    store,
    workGraphMode: "strict",
    autoAdvance: true,
    maxActiveTasks: 1,
    repoRoot: "/tmp",
    requestOwnerGateInteraction: async (task, stage) => {
      requested = true;
      return "interact_fresh_456";
    },
  });
  assert.equal(requested, true);
  assert.equal(resQueue.advancedCount, 0); // Not counted as task advance!
  assert.equal(store.getTask("PLUG-160")?.interaction_id, "interact_fresh_456");
});

const testHosts: Array<{ harness: { dispose: () => Promise<void> } }> = [];
afterEach(async () => {
  while (testHosts.length > 0) {
    const h = testHosts.pop();
    if (h) await h.harness.dispose();
  }
});

async function createTestHost(
  settings: Record<string, string | boolean> = {},
) {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-test-plug360-"),
    settings: {
      workGraph: "off",
      approvalMode: "",
      language: "ru",
      ...settings,
    },
  });
  testHosts.push(host);
  const instance = await createPlugin(host.bb, {
    bbCli: fakeCli(),
    cmd: fakeCmd(),
  });
  return {
    ...host,
    getSettings: async () => instance.settings.get(),
  };
}

test("§32.3 п.5 (1): Тест меню владельца - интерфейсный вызов изменяет настройку с source: 'menu'", async () => {
  const host = await createTestHost({ approvalMode: "" });

  // Interface call from owner menu (setProjectApprovalMode)
  const rpcRes = (await host.harness.callRpc("setProjectApprovalMode", {
    mode: "auto",
  })) as { ok: true };
  assert.equal(rpcRes.ok, true);

  // Setting is updated
  const current = await host.getSettings();
  assert.equal(current.approvalMode, "auto");

  // Interaction card is NOT created for menu changes
  assert.equal(host.harness.pendingInteractions.length, 0);

  // Machine event recorded in events table with source: 'menu'
  const db = host.bb.storage.database();
  const events = db
    .prepare("SELECT * FROM events WHERE kind = 'setting.changed' ORDER BY id DESC")
    .all() as { id: number; kind: string; payload: string }[];
  assert.ok(events.length >= 1);
  const payload = JSON.parse(events[0]!.payload);
  assert.equal(payload.setting, "approvalMode");
  assert.equal(payload.oldValue, "");
  assert.equal(payload.newValue, "auto");
  assert.equal(payload.source, "menu");
  assert.ok(typeof payload.timestamp === "number");
});

test("§32.3 п.5 (2): Тест смены вне меню - изменение настройки без метки фиксирует source: 'outside_menu' и создаёт карточку", async () => {
  const host = await createTestHost({ workGraph: "off" });

  // Outside menu change (e.g. platform/CLI settings write without menu intent)
  await host.harness.setSettings({ workGraph: "strict" });

  // Event recorded with source: 'outside_menu'
  const db = host.bb.storage.database();
  const events = db
    .prepare("SELECT * FROM events WHERE kind = 'setting.changed' ORDER BY id DESC")
    .all() as { id: number; kind: string; payload: string }[];
  assert.ok(events.length >= 1);
  const payload = JSON.parse(events[0]!.payload);
  assert.equal(payload.setting, "workGraph");
  assert.equal(payload.oldValue, "off");
  assert.equal(payload.newValue, "strict");
  assert.equal(payload.source, "outside_menu");
  assert.ok(typeof payload.timestamp === "number");

  // Card created for owner
  assert.equal(host.harness.pendingInteractions.length, 1);
  const interaction = host.harness.pendingInteractions[0]!;
  assert.equal(interaction.rendererId, "orchestrator-settings-alert");
  assert.equal(
    interaction.title,
    "⚠️ Настройка workGraph оркестратора изменена вне меню плагина (было: off, стало: strict)",
  );
  assert.deepEqual(interaction.payload, {
    setting: "workGraph",
    oldValue: "off",
    newValue: "strict",
    source: "outside_menu",
  });
});

test("§32.3 п.5 (3): Тест записи в журнал с source в обоих случаях (menu и outside_menu)", async () => {
  const host = await createTestHost({ approvalMode: "", workGraph: "off" });

  // 1) Menu change
  await host.harness.callRpc("setProjectApprovalMode", { mode: "manual" });

  // 2) Outside menu change
  await host.harness.setSettings({ workGraph: "shadow" });

  const db = host.bb.storage.database();
  const events = db
    .prepare("SELECT * FROM events WHERE kind = 'setting.changed' ORDER BY id ASC")
    .all() as { id: number; kind: string; payload: string }[];
  assert.equal(events.length, 2);

  const menuEvent = JSON.parse(events[0]!.payload);
  assert.equal(menuEvent.setting, "approvalMode");
  assert.equal(menuEvent.oldValue, "");
  assert.equal(menuEvent.newValue, "manual");
  assert.equal(menuEvent.source, "menu");

  const outsideEvent = JSON.parse(events[1]!.payload);
  assert.equal(outsideEvent.setting, "workGraph");
  assert.equal(outsideEvent.oldValue, "off");
  assert.equal(outsideEvent.newValue, "shadow");
  assert.equal(outsideEvent.source, "outside_menu");

  // Verify command_runs entries logged for both
  const commandRuns = db
    .prepare("SELECT * FROM command_runs WHERE source = 'setting.change' ORDER BY id ASC")
    .all() as { id: number; name: string; stdin: string }[];
  assert.equal(commandRuns.length, 2);
  assert.match(commandRuns[0]!.name, /setting:approvalMode/);
  assert.match(commandRuns[1]!.name, /setting:workGraph/);
});

test("§32.3 п.5 (4): Тест кнопки возврата - [ Вернуть прежнее значение ] восстанавливает oldValue", async () => {
  const host = await createTestHost({ approvalMode: "manual" });

  // Outside menu change
  await host.harness.setSettings({ approvalMode: "auto" });
  assert.equal(host.harness.pendingInteractions.length, 1);
  const card = host.harness.pendingInteractions[0]!;

  // Owner clicks [ Вернуть прежнее значение ] (submits interaction with { action: "revert" })
  host.harness.submitInteraction(card.id, { action: "revert" });
  await new Promise((r) => setTimeout(r, 50));

  // Setting is restored to oldValue ("manual")
  const restored = await host.getSettings();
  assert.equal(restored.approvalMode, "manual");

  // Interaction card closed
  assert.equal(host.harness.pendingInteractions.length, 0);

  // The revert itself was performed with menu intent, so events record source: 'menu'
  const db = host.bb.storage.database();
  const events = db
    .prepare("SELECT * FROM events WHERE kind = 'setting.changed' ORDER BY id DESC")
    .all() as { id: number; kind: string; payload: string }[];
  const revertEvent = JSON.parse(events[0]!.payload);
  assert.equal(revertEvent.setting, "approvalMode");
  assert.equal(revertEvent.oldValue, "auto");
  assert.equal(revertEvent.newValue, "manual");
  assert.equal(revertEvent.source, "menu");
});

test("§32.3 п.5 (5): Тест кнопки подтверждения - [ Оставить ] сохраняет newValue", async () => {
  const host = await createTestHost({ workGraph: "off" });

  // Outside menu change
  await host.harness.setSettings({ workGraph: "strict" });
  assert.equal(host.harness.pendingInteractions.length, 1);
  const card = host.harness.pendingInteractions[0]!;

  // Owner clicks [ Оставить ] (submits interaction with { action: "keep" })
  host.harness.submitInteraction(card.id, { action: "keep" });
  await new Promise((r) => setTimeout(r, 50));

  // Setting is kept at newValue ("strict")
  const current = await host.getSettings();
  assert.equal(current.workGraph, "strict");

  // Interaction card closed
  assert.equal(host.harness.pendingInteractions.length, 0);
});

test("§32.3 п.5 (6): Тест CLI-защиты - вызов с BB_THREAD_ID отклоняется с permission-denied: owner-only", async () => {
  const host = await createTestHost({ workGraph: "off" });

  // 1) Agent call with ctx.threadId
  const resAgentCtx = await host.harness.runCli(
    ["config", "set", "workGraph", "strict", "--json"],
    { threadId: "thr_agent_42" },
  );
  assert.equal(resAgentCtx.exitCode, 1);
  const errAgentCtx = JSON.parse(resAgentCtx.stdout);
  assert.equal(errAgentCtx.error.code, "permission-denied");
  assert.equal(errAgentCtx.error.message, "owner-only");

  // 2) Agent call with process.env.BB_THREAD_ID
  process.env.BB_THREAD_ID = "thr_agent_env_99";
  try {
    const resEnv = await host.harness.runCli([
      "config",
      "set",
      "workGraph",
      "strict",
      "--json",
    ]);
    assert.equal(resEnv.exitCode, 1);
    const errEnv = JSON.parse(resEnv.stdout);
    assert.equal(errEnv.error.code, "permission-denied");
    assert.equal(errEnv.error.message, "owner-only");

    // Also test mode command
    const resModeEnv = await host.harness.runCli([
      "mode",
      "auto",
      "--json",
    ]);
    assert.equal(resModeEnv.exitCode, 1);
    const errModeEnv = JSON.parse(resModeEnv.stdout);
    assert.equal(errModeEnv.error.code, "permission-denied");
    assert.equal(errModeEnv.error.message, "owner-only");
  } finally {
    delete process.env.BB_THREAD_ID;
  }

  // 3) Owner call (no threadId, no BB_THREAD_ID) succeeds
  const resOwner = await host.harness.runCli([
    "config",
    "set",
    "workGraph",
    "shadow",
    "--json",
  ]);
  assert.equal(resOwner.exitCode, 0);
  const okOwner = JSON.parse(resOwner.stdout);
  assert.equal(okOwner.ok, true);
  const current = await host.getSettings();
  assert.equal(current.workGraph, "shadow");
});

