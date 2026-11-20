// plugins/bb-plugin-orchestrator/tests/workgraph-transition-linkage-e2e.test.ts
// E2E verification of the 7 connected transition events through real workgraph executions.
// Spec: §31.6, §31.7, §28.1, Acceptance 20.11

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import { runRunQueue, resolveTransition, extractCounters } from "../src/workgraph.js";
import type { TaskQueueRow } from "../src/store.js";

function setupStore(): { db: any; store: DelegationStore; cleanup: () => void } {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const cleanup = () => {
    try {
      db.close();
    } catch {}
  };
  return { db, store, cleanup };
}

function insertDelegation(
  db: any,
  del: {
    task_key: string;
    thread_id: string;
    status: string;
    route?: string;
    result_sha?: string;
    result_commits?: number;
    created_at?: number;
  },
) {
  const now = del.created_at ?? Date.now();
  db.prepare(`
    INSERT INTO delegations (
      task_key, coordinator_thread_id, thread_id, level, route, preset, provider, status,
      result_sha, result_commits, created_at, updated_at
    ) VALUES (?, 'thr_coord', ?, 'complex', ?, 'default', 'test', ?, ?, ?, ?, ?)
  `).run(
    del.task_key,
    del.thread_id,
    del.route ?? "feature",
    del.status,
    del.result_sha ?? null,
    del.result_commits ?? 0,
    now,
    now,
  );
}

test("§31.7 E2E: fix/simple task with route violation escalates to feature/design", async () => {
  const { db, store, cleanup } = setupStore();
  try {
    const taskKey = "FIX-001";
    const now = Date.now();
    store.insertTask({
      taskKey,
      projectId: "proj_1",
      coordinatorThreadId: "thr_coord",
      route: "fix",
      level: "simple",
      priority: 10,
    });

    // Move task to code/running with mode auto
    store.transitionTask({
      taskKey,
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "code",
      toStatus: "running",
      actor: "test",
      reason: "start code",
      updates: { confirmation_mode: "auto" },
    });

    const fakeResultSha = "abc123def456";
    insertDelegation(db, {
      task_key: taskKey,
      thread_id: "thr_exec_01",
      route: "fix",
      status: "done",
      result_sha: fakeResultSha,
      result_commits: 1,
      created_at: now + 500,
    });

    let checkedCalled = false;
    const res = await runRunQueue({
      store,
      workGraphMode: "strict",
      checkRouteLimits: async (task, resultSha) => {
        checkedCalled = true;
        assert.equal(task.task_key, taskKey);
        assert.equal(resultSha, fakeResultSha);
        return {
          violated: true,
          reason: "route-violation: fix task modified 5 files > 3",
          filesCount: 5,
        };
      },
    });

    assert.equal(checkedCalled, true, "checkRouteLimits must be called");
    assert.equal(res.advancedCount, 1);

    const updated = store.getTask(taskKey);
    assert.ok(updated);
    assert.equal(updated.node, "design");
    assert.equal(updated.status, "running");
    assert.equal(updated.route, "feature", "Route must escalate to feature");
    assert.equal(updated.code_attempts, 0);

    const transitions = store.listTransitions(taskKey);
    const lastTr = transitions.at(-1);
    assert.ok(lastTr);
    assert.equal(lastTr.from_node, "code");
    assert.equal(lastTr.to_node, "design");
    assert.ok(lastTr.reason?.includes("route_violation"));
  } finally {
    cleanup();
  }
});

test("§31.6 E2E: spec task with fabricated symbol fails, [new] passes, notRun does not advance", async () => {
  const { db, store, cleanup } = setupStore();
  try {
    const now = Date.now();

    // 1. Fabricated symbol -> spec_invalid_reference transition
    const taskKey1 = "SPEC-001";
    store.insertTask({
      taskKey: taskKey1,
      projectId: "proj_1",
      coordinatorThreadId: "thr_coord",
      route: "feature",
      level: "complex",
      priority: 10,
    });
    store.transitionTask({
      taskKey: taskKey1,
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "spec",
      toStatus: "running",
      actor: "test",
      reason: "start spec",
      updates: { confirmation_mode: "auto" },
    });

    insertDelegation(db, {
      task_key: taskKey1,
      thread_id: "thr_spec_01",
      route: "feature",
      status: "done",
      result_sha: "spec_sha_1",
      result_commits: 1,
      created_at: now + 500,
    });

    const res1 = await runRunQueue({
      store,
      workGraphMode: "strict",
      verifySpecReferences: async (task, specSha) => {
        return {
          valid: false,
          notRun: false,
          missingReferences: ["symbol:FabricatedServiceDoesNotExist"],
          reason: "spec-refused: invalid-codebase-reference: symbol:FabricatedServiceDoesNotExist",
        };
      },
    });

    assert.equal(res1.advancedCount, 1);
    const t1 = store.getTask(taskKey1);
    assert.ok(t1);
    assert.equal(t1.node, "spec");
    assert.equal(t1.status, "running"); // retried
    assert.equal(t1.spec_attempts, 1);

    const transitions1 = store.listTransitions(taskKey1);
    assert.ok(transitions1.at(-1)?.reason?.includes("invalid-codebase-reference"));

    // 2. Marked with [new] -> valid passes to spec_review
    const taskKey2 = "SPEC-002";
    store.insertTask({
      taskKey: taskKey2,
      projectId: "proj_1",
      coordinatorThreadId: "thr_coord",
      route: "feature",
      level: "complex",
      priority: 10,
    });
    store.transitionTask({
      taskKey: taskKey2,
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "spec",
      toStatus: "running",
      actor: "test",
      reason: "start spec",
      updates: { confirmation_mode: "auto" },
    });

    insertDelegation(db, {
      task_key: taskKey2,
      threadId: "thr_spec_02",
      route: "feature",
      status: "done",
      result_sha: "spec_sha_2",
      result_commits: 1,
      created_at: now + 500,
    });

    const res2 = await runRunQueue({
      store,
      workGraphMode: "strict",
      verifySpecReferences: async (task, specSha) => {
        return { valid: true };
      },
    });

    assert.equal(res2.advancedCount, 1);
    const t2 = store.getTask(taskKey2);
    assert.ok(t2);
    assert.equal(t2.node, "spec_review");
    assert.equal(t2.status, "running");

    // 3. Verification check not run -> does not advance
    const taskKey3 = "SPEC-003";
    store.insertTask({
      taskKey: taskKey3,
      projectId: "proj_1",
      coordinatorThreadId: "thr_coord",
      route: "feature",
      level: "complex",
      priority: 10,
    });
    store.transitionTask({
      taskKey: taskKey3,
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "spec",
      toStatus: "running",
      actor: "test",
      reason: "start spec",
      updates: { confirmation_mode: "auto" },
    });

    insertDelegation(db, {
      task_key: taskKey3,
      thread_id: "thr_spec_03",
      route: "feature",
      status: "done",
      result_sha: "spec_sha_3",
      result_commits: 1,
      created_at: now + 500,
    });

    const res3 = await runRunQueue({
      store,
      workGraphMode: "strict",
      verifySpecReferences: async (task, specSha) => {
        return { valid: false, notRun: true, reason: "git error" };
      },
    });

    assert.equal(res3.advancedCount, 0, "Must not advance when check notRun");
    const t3 = store.getTask(taskKey3);
    assert.ok(t3);
    assert.equal(t3.node, "spec");
    assert.equal(t3.status, "running");
    assert.equal(t3.spec_attempts, 0); // No attempt consumed on notRun
  } finally {
    cleanup();
  }
});

test("PR events E2E: pr_merged -> done, pr_closed -> stalled, pr_changes_requested -> code/running", async () => {
  const { db, store, cleanup } = setupStore();
  try {
    // 1. pr_merged -> release / done
    store.insertTask({
      taskKey: "PR-001",
      projectId: "proj_1",
      coordinatorThreadId: "thr_coord",
      route: "feature",
      level: "complex",
      priority: 10,
    });
    store.transitionTask({
      taskKey: "PR-001",
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "release",
      toStatus: "pr_open",
      actor: "test",
      reason: "pr open",
      updates: { confirmation_mode: "auto" },
    });

    await runRunQueue({
      store,
      workGraphMode: "strict",
      checkPrStatus: async (task) => {
        return { state: "MERGED", mergeCommit: "merge_commit_sha_123" };
      },
    });

    const t1 = store.getTask("PR-001");
    assert.ok(t1);
    assert.equal(t1.node, "release");
    assert.equal(t1.status, "done");
    assert.equal(t1.result_sha, "merge_commit_sha_123");

    // 2. pr_closed -> release / stalled
    store.insertTask({
      taskKey: "PR-002",
      projectId: "proj_1",
      coordinatorThreadId: "thr_coord",
      route: "fix",
      level: "simple",
      priority: 10,
    });
    store.transitionTask({
      taskKey: "PR-002",
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "release",
      toStatus: "pr_open",
      actor: "test",
      reason: "pr open",
      updates: { confirmation_mode: "auto" },
    });

    await runRunQueue({
      store,
      workGraphMode: "strict",
      checkPrStatus: async (task) => {
        return { state: "CLOSED" };
      },
    });

    const t2 = store.getTask("PR-002");
    assert.ok(t2);
    assert.equal(t2.node, "release");
    assert.equal(t2.status, "stalled");
    const p2 = JSON.parse(t2.payload || "{}");
    assert.equal(p2.stalled_reason, "pr_closed");

    // 3. pr_changes_requested -> code / running
    store.insertTask({
      taskKey: "PR-003",
      projectId: "proj_1",
      coordinatorThreadId: "thr_coord",
      route: "simple",
      level: "simple",
      priority: 10,
    });
    store.transitionTask({
      taskKey: "PR-003",
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "release",
      toStatus: "pr_open",
      actor: "test",
      reason: "pr open",
      updates: { confirmation_mode: "auto" },
    });

    await runRunQueue({
      store,
      workGraphMode: "strict",
      checkPrStatus: async (task) => {
        return { state: "CHANGES_REQUESTED" };
      },
    });

    const t3 = store.getTask("PR-003");
    assert.ok(t3);
    assert.equal(t3.node, "code");
    assert.equal(t3.status, "running");
  } finally {
    cleanup();
  }
});

test("research_question_or_no_report E2E: nudges then stalls upon exhaustion", async () => {
  const { db, store, cleanup } = setupStore();
  try {
    const taskKey = "RES-001";
    const now = Date.now();
    store.insertTask({
      taskKey,
      projectId: "proj_1",
      coordinatorThreadId: "thr_coord",
      route: "research",
      level: "simple",
      priority: 10,
    });
    store.transitionTask({
      taskKey,
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "research",
      toStatus: "running",
      actor: "test",
      reason: "start research",
      updates: { confirmation_mode: "auto" },
    });

    // Delegation ended without a report
    insertDelegation(db, {
      task_key: taskKey,
      thread_id: "thr_res_01",
      route: "research",
      status: "done",
      created_at: now + 500,
    });

    // First round -> nudge 1
    await runRunQueue({
      store,
      workGraphMode: "strict",
    });

    let t = store.getTask(taskKey);
    assert.ok(t);
    assert.equal(t.node, "research");
    assert.equal(t.status, "running");
    let p = JSON.parse(t.payload || "{}");
    assert.equal(p.nudge_count, 1);

    // Set nudge_count to 3 -> exhaustion transitions to stalled
    store.updateTask(taskKey, {
      payload: JSON.stringify({ ...p, nudge_count: 3 }),
    });

    await runRunQueue({
      store,
      workGraphMode: "strict",
    });

    t = store.getTask(taskKey);
    assert.ok(t);
    assert.equal(t.node, "research");
    assert.equal(t.status, "stalled");
    const trs = store.listTransitions(taskKey);
    assert.ok(trs.at(-1)?.reason?.includes("exhausted nudges"));
  } finally {
    cleanup();
  }
});

test("owner_gate_timeout E2E: resolveTransition keeps task in waiting_approval", () => {
  const t: TaskQueueRow = {
    id: 1,
    task_key: "GATE-001",
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    priority: 0,
    spec_sha: null,
    result_sha: null,
    acceptance_sha: null,
    branch: null,
    confirmation_mode: "manual",
    spec_attempts: 0,
    code_attempts: 0,
    check_attempts: 0,
    spec_review_rounds: 0,
    code_review_rounds: 0,
    design_check_rounds: 0,
    release_attempts: 0,
    nudge_count: 0,
    node_alarm_at: null,
    interaction_id: "int_123",
    depends_on: null,
    coordinator_thread_id: null,
    payload: null,
    entered_at: 1000,
    updated_at: 1000,
    created_at: 1000,
  };

  const res = resolveTransition({
    route: t.route,
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_gate_timeout", reason: "card cancelled" },
    mode: t.confirmation_mode,
    counters: extractCounters(t),
  });

  assert.equal(res.allowed, true);
  assert.equal(res.toNode, "owner_gate");
  assert.equal(res.toStatus, "waiting_approval");
  assert.equal(res.ruleId, "rule-31-owner-gate-timeout");
});
