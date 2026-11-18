/**
 * End-to-end deterministic rehearsal tests for task work graph r34 (§27, §28, §31, §32 and ADR-0032).
 * Slice 5b: run-queue service and full transition matrix with maxActiveTasks, depends_on,
 * auto-transitions, 3-attempt ceilings, failure handling, and checks execution without real LLMs.
 */
import assert from "node:assert/strict";
import test, { beforeEach, after } from "node:test";
import Database from "better-sqlite3";
import { makeTempDir } from "./helpers/temp.js";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import { type CmdRunner, createCmd } from "../src/cmd.js";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import { createPlugin } from "../server.js";
import {
  runRunQueue,
  commitAcceptanceContract,
  validateCheckCommand,
  executeChecks,
  checkAcceptanceTampered,
  DEFAULT_ALLOWED_RUNNERS,
} from "../src/workgraph.js";

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

function fakeCli(respond?: (args: string[]) => BbCliResult | undefined): {
  cli: BbCli;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    cli: {
      run: async (args) => {
        calls.push(args);
        const r = respond?.(args);
        if (r) return r;
        return ok();
      },
    },
  };
}

function fakeCmd(
  respond?: (cmd: string, args: string[]) => { exitCode: number; stdout: string; stderr: string } | undefined,
): { cmd: CmdRunner; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    cmd: {
      run: async (c, a) => {
        calls.push({ cmd: c, args: a });
        const r = respond?.(c, a);
        if (r) return r;
        // Default git responses for branch checks
        const key = `${c} ${a.join(" ")}`;
        if (key.includes("rev-parse --show-toplevel")) {
          return { exitCode: 0, stdout: "/tmp/fake-repo", stderr: "" };
        }
        if (key.includes("rev-parse --verify origin/main") || key.includes("rev-parse --verify refs/remotes/origin/main")) {
          return { exitCode: 0, stdout: "0000000000000000000000000000000000000001", stderr: "" };
        }
        if (c === "git" && a[0] === "rev-parse" && a[1] === "--verify") {
          return { exitCode: 0, stdout: "base-sha-1234567890", stderr: "" };
        }
        if (c === "git" && a[0] === "merge-base" && a[1] === "--is-ancestor") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (c === "git" && a[0] === "branch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

function createTestStore(): DelegationStore {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  return new DelegationStore(db);
}

// ── 1. Happy Path Full Pipeline Auto-Transitions (Simple/Fix Route) ───────

test("Full cycle auto-transitions: queued -> code -> checks -> review -> release -> done", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();
  const { cli, calls: cliCalls } = fakeCli();

  // Enqueue task on simple route in auto mode
  store.insertTask({
    taskKey: "PLUG-101",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  // Step 1: run-queue picks up from queued -> start -> code (running)
  let res = await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    bbCli: cli,
  });

  let task = store.getTask("PLUG-101")!;
  assert.equal(task.node, "code");
  assert.equal(task.status, "running");
  assert.equal(task.branch, "bb/plug-101-simple");

  // Step 2: Code finishes with 1 commit and clean contract
  store.updateTask("PLUG-101", {
    payload: JSON.stringify({ code_done: true, result_commits: 1, result_sha: "sha-code-1" }),
  });

  res = await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    bbCli: cli,
    runChecks: async () => ({ ok: true, exitCode: 0, output: "tests pass" }),
  });

  task = store.getTask("PLUG-101")!;
  // Advances from code -> checks (passes) -> review (running)
  assert.equal(task.node, "review");
  assert.equal(task.status, "running");
  assert.equal(task.check_attempts, 0);
  assert.equal(task.result_sha, "sha-code-1");

  // Step 3: Review passes with OK verdict -> advances to release (running)
  store.updateTask("PLUG-101", {
    payload: JSON.stringify({ review_verdict: "OK", review_blockers: 0 }),
  });

  res = await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    bbCli: cli,
    runReleaseStep: async () => ({ status: "published", publishedSha: "sha-pub-1" }),
  });

  task = store.getTask("PLUG-101")!;
  // Advances from review -> release (published) -> done!
  assert.equal(task.node, "release");
  assert.equal(task.status, "done");
  assert.equal(task.result_sha, "sha-pub-1");

  // Verify tracker closure call
  const taskUpdateCall = cliCalls.find(
    (c) => c[0] === "tasks" && c[1] === "update" && c[2] === "PLUG-101" && c[4] === "done",
  );
  assert.ok(taskUpdateCall, "task tracker update called on done");

  // Verify transition audit trail
  const transitions = store.listTransitions("PLUG-101");
  const pathNodes = transitions.map((t) => `${t.from_node}->${t.to_node}(${t.to_status})`);
  assert.deepEqual(pathNodes, [
    "start->start(queued)",
    "start->code(running)",
    "code->checks(running)",
    "checks->review(running)",
    "review->release(running)",
    "release->release(done)",
  ]);
});

// ── 2. Sequential Queue with `depends_on` and `maxActiveTasks: 1` ──────────

test("Sequential queue: maxActiveTasks=1 and depends_on blocks and unblocks next task", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();
  const { cli } = fakeCli();

  // Task 1: no dependencies
  store.insertTask({
    taskKey: "TASK-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    priority: 100,
  });

  // Task 2: depends on TASK-1
  store.insertTask({
    taskKey: "TASK-2",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    priority: 100,
    dependsOn: ["TASK-1"],
  });

  // Tick 1: TASK-1 starts, TASK-2 stays in queued
  let res = await runRunQueue({
    store,
    workGraphMode: "strict",
    maxActiveTasks: 1,
    cmd,
    bbCli: cli,
  });

  assert.equal(res.activeCount, 1);
  assert.equal(res.queuedCount, 1);
  const task1 = store.getTask("TASK-1")!;
  const task2 = store.getTask("TASK-2")!;
  assert.equal(task1.status, "running");
  assert.equal(task2.status, "queued");

  // Advance TASK-1 through to completion
  store.updateTask("TASK-1", {
    payload: JSON.stringify({
      code_done: true,
      review_verdict: "OK",
    }),
  });

  res = await runRunQueue({
    store,
    workGraphMode: "strict",
    maxActiveTasks: 1,
    cmd,
    bbCli: cli,
    runChecks: async () => ({ ok: true, exitCode: 0 }),
    runReleaseStep: async () => ({ status: "published", publishedSha: "sha-task1-pub" }),
  });

  // TASK-1 is now done!
  assert.equal(store.getTask("TASK-1")!.status, "done");

  // In the same runRunQueue cascade (or next tick), TASK-2 was unblocked and started!
  const task2After = store.getTask("TASK-2")!;
  assert.equal(task2After.status, "running");
  assert.equal(task2After.node, "code");
});

// ── 3. Concurrency Limit `maxActiveTasks` ──────────────────────────────────

test("Concurrency limit maxActiveTasks allows parallel tasks when limit > 1", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "PAR-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    priority: 100,
  });
  store.insertTask({
    taskKey: "PAR-2",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    priority: 90,
  });
  store.insertTask({
    taskKey: "PAR-3",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    priority: 80,
  });

  // Run with maxActiveTasks = 2
  const res = await runRunQueue({
    store,
    workGraphMode: "strict",
    maxActiveTasks: 2,
    cmd,
  });

  assert.equal(res.activeCount, 2);
  assert.equal(res.queuedCount, 1);
  assert.equal(store.getTask("PAR-1")!.status, "running");
  assert.equal(store.getTask("PAR-2")!.status, "running");
  assert.equal(store.getTask("PAR-3")!.status, "queued");
});

// ── 4. Full Feature Route: All 9 Nodes Pipeline ───────────────────────────

test("Full feature pipeline: design -> spec -> spec_review -> code -> checks -> review -> design_check -> release -> done", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();
  const { cli } = fakeCli();

  store.insertTask({
    taskKey: "FEAT-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  });

  // 1. Queued -> design
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  let t = store.getTask("FEAT-1")!;
  assert.equal(t.node, "design");
  assert.equal(t.status, "running");

  // 2. Design -> spec
  store.updateTask("FEAT-1", {
    payload: JSON.stringify({ design_done: true, acceptance_text: "Acceptance criteria 1.0" }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("FEAT-1")!;
  assert.equal(t.node, "spec");
  assert.ok(t.acceptance_sha);

  // 3. Spec -> spec_review
  store.updateTask("FEAT-1", {
    payload: JSON.stringify({ spec_done: true, spec_sha: "sha-spec-feat1" }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("FEAT-1")!;
  assert.equal(t.node, "spec_review");
  assert.equal(t.spec_sha, "sha-spec-feat1");

  // 4. Spec review OK -> code (auto mode)
  store.updateTask("FEAT-1", {
    payload: JSON.stringify({ spec_review_verdict: "OK" }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("FEAT-1")!;
  assert.equal(t.node, "code");

  // 5. Code -> checks -> review
  store.updateTask("FEAT-1", {
    payload: JSON.stringify({ code_done: true, result_commits: 2, result_sha: "sha-code-feat1" }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: true, exitCode: 0 }),
  });
  t = store.getTask("FEAT-1")!;
  assert.equal(t.node, "review");

  // 6. Review OK -> design_check (feature route)
  store.updateTask("FEAT-1", {
    payload: JSON.stringify({ review_verdict: "OK" }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("FEAT-1")!;
  assert.equal(t.node, "design_check");

  // 7. Design check OK -> release
  store.updateTask("FEAT-1", {
    payload: JSON.stringify({ design_check_verdict: "OK" }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("FEAT-1")!;
  assert.equal(t.node, "release");

  // 8. Release published -> done
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    bbCli: cli,
    runReleaseStep: async () => ({ status: "published", publishedSha: "sha-feat1-released" }),
  });
  t = store.getTask("FEAT-1")!;
  assert.equal(t.node, "release");
  assert.equal(t.status, "done");
  assert.equal(t.result_sha, "sha-feat1-released");
});

// ── 5. Checks Failure Loop and 3-Attempt Ceiling ───────────────────────────

test("Checks failure loop: returns to code up to 3 times then transitions to blocked", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "CHK-FAIL",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  // Start task -> code
  await runRunQueue({ store, workGraphMode: "strict", cmd });

  // Failure round 1: code done -> checks fail -> returns to code (check_attempts = 1)
  store.updateTask("CHK-FAIL", {
    payload: JSON.stringify({ code_done: true, result_commits: 1 }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: false, exitCode: 1, output: "AssertionError: expected true" }),
  });

  let t = store.getTask("CHK-FAIL")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.check_attempts, 1);

  // Failure round 2: redeliver code -> checks fail -> returns to code (check_attempts = 2)
  store.updateTask("CHK-FAIL", {
    payload: JSON.stringify({ code_done: true, result_commits: 1 }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: false, exitCode: 1, output: "AssertionError round 2" }),
  });

  t = store.getTask("CHK-FAIL")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.check_attempts, 2);

  // Failure round 3: redeliver code -> checks fail 3rd time -> transitions to blocked!
  store.updateTask("CHK-FAIL", {
    payload: JSON.stringify({ code_done: true, result_commits: 1 }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: false, exitCode: 1, output: "AssertionError round 3" }),
  });

  t = store.getTask("CHK-FAIL")!;
  assert.equal(t.node, "checks");
  assert.equal(t.status, "blocked");
  assert.equal(t.check_attempts, 3);
});

// ── 6. Checks Command Validation and Not-Run Stalled State ─────────────────

test("Checks validation: forbidden flags, metacharacters and not_run stalled transition", async () => {
  // Test validateCheckCommand rules (§31.3)
  assert.equal(validateCheckCommand("npm test").valid, true);
  assert.equal(validateCheckCommand("npm run test:unit -v").valid, true);
  assert.equal(validateCheckCommand("pytest -k test_workgraph").valid, true);

  // Shell metacharacters forbidden
  assert.equal(validateCheckCommand("npm test && rm -rf /").valid, false);
  assert.equal(validateCheckCommand("pytest; echo done").valid, false);
  assert.equal(validateCheckCommand("npm test | cat").valid, false);

  // Forbidden binaries forbidden
  assert.equal(validateCheckCommand("npx jest").valid, false);
  assert.equal(validateCheckCommand("go run main.go").valid, false);
  assert.equal(validateCheckCommand("npm install foo").valid, false);

  // Forbidden flags forbidden
  assert.equal(validateCheckCommand("go test -exec ./hack").valid, false);
  assert.equal(validateCheckCommand("python -m unittest --import evil").valid, false);

  // executeChecks with checks_not_run causes transition to stalled
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "CHK-STALL",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  await runRunQueue({ store, workGraphMode: "strict", cmd });

  store.updateTask("CHK-STALL", {
    payload: JSON.stringify({
      code_done: true,
      result_commits: 1,
      checks_not_run: true,
    }),
  });

  await runRunQueue({ store, workGraphMode: "strict", cmd });
  const t = store.getTask("CHK-STALL")!;
  assert.equal(t.node, "checks");
  assert.equal(t.status, "stalled");
});

// ── 7. Acceptance Contract Tampering Detection ────────────────────────────

test("Tampered acceptance contract rejected and blocks after 3 attempts", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "TAMPER-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    acceptanceSha: "sha-original-acc",
  });

  await runRunQueue({ store, workGraphMode: "strict", cmd });

  // Tampering attempt 1: code_done with tampered contract
  store.updateTask("TAMPER-1", {
    payload: JSON.stringify({ code_done: true, acceptance_tampered: true }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });

  let t = store.getTask("TAMPER-1")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.code_attempts, 1);

  // Tampering attempt 2
  store.updateTask("TAMPER-1", {
    payload: JSON.stringify({ code_done: true, acceptance_tampered: true }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("TAMPER-1")!;
  assert.equal(t.code_attempts, 2);

  // Tampering attempt 3 -> blocked!
  store.updateTask("TAMPER-1", {
    payload: JSON.stringify({ code_done: true, acceptance_tampered: true }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("TAMPER-1")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "blocked");
  assert.equal(t.code_attempts, 3);
});

// ── 8. Zero Commits Rejection ─────────────────────────────────────────────

test("Zero commits delivery rejected and blocked after 3 attempts", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "NO-COMMITS",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  await runRunQueue({ store, workGraphMode: "strict", cmd });

  // Deliver with 0 commits
  store.updateTask("NO-COMMITS", {
    payload: JSON.stringify({ code_done: true, result_commits: 0 }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  let t = store.getTask("NO-COMMITS")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.code_attempts, 1);

  // Attempt 2
  store.updateTask("NO-COMMITS", {
    payload: JSON.stringify({ code_done: true, result_commits: 0 }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("NO-COMMITS")!;
  assert.equal(t.code_attempts, 2);

  // Attempt 3 -> blocked!
  store.updateTask("NO-COMMITS", {
    payload: JSON.stringify({ code_done: true, result_commits: 0 }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("NO-COMMITS")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "blocked");
  assert.equal(t.code_attempts, 3);
});

// ── 9. Review CHANGES Loop and 3-Round Ceiling ─────────────────────────────

test("Review CHANGES loop: returns to code up to 3 times then transitions to blocked", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "REV-LOOP",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  await runRunQueue({ store, workGraphMode: "strict", cmd });

  // Move code -> checks -> review
  store.updateTask("REV-LOOP", {
    payload: JSON.stringify({ code_done: true, result_commits: 1 }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: true, exitCode: 0 }),
  });

  let t = store.getTask("REV-LOOP")!;
  assert.equal(t.node, "review");

  // Round 1: CHANGES -> returns to code (code_review_rounds = 1)
  store.updateTask("REV-LOOP", {
    payload: JSON.stringify({ review_verdict: "CHANGES", review_blockers: 2 }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });

  t = store.getTask("REV-LOOP")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.code_review_rounds, 1);

  // Redeliver code -> checks -> review (round 2)
  store.updateTask("REV-LOOP", {
    payload: JSON.stringify({ code_done: true, result_commits: 1 }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: true, exitCode: 0 }),
  });
  store.updateTask("REV-LOOP", {
    payload: JSON.stringify({ review_verdict: "CHANGES", review_blockers: 1 }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });

  t = store.getTask("REV-LOOP")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.code_review_rounds, 2);

  // Redeliver code -> checks -> review (round 3 -> blocked!)
  store.updateTask("REV-LOOP", {
    payload: JSON.stringify({ code_done: true, result_commits: 1 }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: true, exitCode: 0 }),
  });
  store.updateTask("REV-LOOP", {
    payload: JSON.stringify({ review_verdict: "CHANGES", review_blockers: 1 }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });

  t = store.getTask("REV-LOOP")!;
  assert.equal(t.node, "review");
  assert.equal(t.status, "blocked");
  assert.equal(t.code_review_rounds, 3);
});

// ── 10. Release Failure Loop and 3-Attempt Ceiling ─────────────────────────

test("Release failure loop: returns to code up to 3 times then transitions to blocked", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "REL-FAIL",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  // Fast forward to release node
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  store.updateTask("REL-FAIL", {
    payload: JSON.stringify({ code_done: true, result_commits: 1, review_verdict: "OK" }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: true, exitCode: 0 }),
  });

  let t = store.getTask("REL-FAIL")!;
  assert.equal(t.node, "release");

  // Release attempt 1: failed -> returns to code (release_attempts = 1)
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runReleaseStep: async () => ({ status: "failed", error: "merge conflict on target" }),
  });
  t = store.getTask("REL-FAIL")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.release_attempts, 1);

  // Fast forward to release attempt 2
  store.updateTask("REL-FAIL", {
    payload: JSON.stringify({ code_done: true, result_commits: 1, review_verdict: "OK" }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: true, exitCode: 0 }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runReleaseStep: async () => ({ status: "failed", error: "audit rejected" }),
  });
  t = store.getTask("REL-FAIL")!;
  assert.equal(t.node, "code");
  assert.equal(t.release_attempts, 2);

  // Fast forward to release attempt 3 -> blocked!
  store.updateTask("REL-FAIL", {
    payload: JSON.stringify({ code_done: true, result_commits: 1, review_verdict: "OK" }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runChecks: async () => ({ ok: true, exitCode: 0 }),
  });
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runReleaseStep: async () => ({ status: "failed", error: "audit rejected 3" }),
  });
  t = store.getTask("REL-FAIL")!;
  assert.equal(t.node, "release");
  assert.equal(t.status, "blocked");
  assert.equal(t.release_attempts, 3);
});

// ── 11. Delegation Failure and Level Chain Exhaustion ──────────────────────

test("Delegation failure or exhaustion transitions task to stalled", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "DELEG-STALL",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  // Start task -> code (running)
  await runRunQueue({ store, workGraphMode: "strict", cmd });

  // Simulate active delegation for DELEG-STALL exhausting level chain (status stalled)
  const d = store.insert({
    taskKey: "DELEG-STALL",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  store.setStatusIf(d.id, "dispatching", "stalled");

  await runRunQueue({ store, workGraphMode: "strict", cmd });
  const t = store.getTask("DELEG-STALL")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "stalled");
});

// ── 12. Branch Collision on Start ──────────────────────────────────────────

test("Branch collision on start transitions task to stalled: branch-exists", async () => {
  const store = createTestStore();
  // Command runner that indicates branch exists and is NOT ancestor of base
  const { cmd } = fakeCmd((c, a) => {
    if (c === "git" && a[0] === "rev-parse" && a[2] === "refs/heads/bb/coll-1-simple") {
      return { exitCode: 0, stdout: "branch-sha-dirty", stderr: "" };
    }
    if (c === "git" && a[0] === "merge-base" && a[1] === "--is-ancestor") {
      return { exitCode: 1, stdout: "", stderr: "not ancestor" };
    }
    return undefined;
  });

  store.insertTask({
    taskKey: "COLL-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  await runRunQueue({ store, workGraphMode: "strict", cmd });
  const t = store.getTask("COLL-1")!;
  assert.equal(t.node, "start");
  assert.equal(t.status, "stalled");
  assert.ok(
    store.listTransitions("COLL-1").at(-1)!.reason.includes("branch-exists"),
  );
});

// ── 13. Docs Route Pipeline ────────────────────────────────────────────────

test("Docs route: spec -> spec_review -> release -> done", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "DOCS-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "docs",
    level: "spec",
    confirmationMode: "auto",
  });

  // Start -> spec (running, acceptance_sha is null)
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  let t = store.getTask("DOCS-1")!;
  assert.equal(t.node, "spec");
  assert.equal(t.status, "running");
  assert.equal(t.acceptance_sha, null);

  // Spec delivered -> spec_review
  store.updateTask("DOCS-1", {
    payload: JSON.stringify({ spec_done: true, spec_sha: "sha-docs-spec" }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("DOCS-1")!;
  assert.equal(t.node, "spec_review");

  // Spec review OK -> release (auto mode on docs bypasses code)
  store.updateTask("DOCS-1", {
    payload: JSON.stringify({ spec_review_verdict: "OK" }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("DOCS-1")!;
  assert.equal(t.node, "release");

  // Release published -> done
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd,
    runReleaseStep: async () => ({ status: "published", publishedSha: "sha-docs-pub" }),
  });
  t = store.getTask("DOCS-1")!;
  assert.equal(t.node, "release");
  assert.equal(t.status, "done");
  assert.equal(t.result_sha, "sha-docs-pub");
});

// ── 14. Research Route Pipeline ───────────────────────────────────────────

test("Research route: start -> research -> done without branch or release", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "RES-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "research",
    level: "research",
  });

  // Start -> research (running, branch is null)
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  let t = store.getTask("RES-1")!;
  assert.equal(t.node, "research");
  assert.equal(t.status, "running");
  assert.equal(t.branch, null);

  // Research completed -> done
  store.updateTask("RES-1", {
    payload: JSON.stringify({ research_done: true }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("RES-1")!;
  assert.equal(t.node, "research");
  assert.equal(t.status, "done");
});

// ── 15. Manual Mode Owner Gate ─────────────────────────────────────────────

test("Manual mode pauses at owner_gate with waiting_approval until approved", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "MAN-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "manual",
  });

  // Start in manual mode transitions to owner_gate / waiting_approval
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  let t = store.getTask("MAN-1")!;
  assert.equal(t.node, "owner_gate");
  assert.equal(t.status, "waiting_approval");

  // Subsequent runRunQueue tick leaves task in waiting_approval
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  t = store.getTask("MAN-1")!;
  assert.equal(t.node, "owner_gate");
  assert.equal(t.status, "waiting_approval");

  // Owner approves transition to code
  store.transitionTask({
    taskKey: "MAN-1",
    expectedNode: "owner_gate",
    expectedStatus: "waiting_approval",
    toNode: "code",
    toStatus: "running",
    actor: "owner",
    reason: "owner approved",
  });

  t = store.getTask("MAN-1")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
});

// ── 16. Design Check Redesign Loop and Counter Resets ──────────────────────

test("Design check redesign request resets downstream counters", async () => {
  const store = createTestStore();
  const { cmd } = fakeCmd();

  store.insertTask({
    taskKey: "REDESIGN-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  });

  // Fast forward task directly to design_check with accumulated downstream counters
  store.transitionTask({
    taskKey: "REDESIGN-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design_check",
    toStatus: "running",
    actor: "test",
    reason: "fast forward",
    updates: {
      spec_attempts: 2,
      spec_review_rounds: 2,
      code_attempts: 2,
      check_attempts: 1,
      code_review_rounds: 2,
      payload: JSON.stringify({
        design_check_verdict: "CHANGES",
        design_check_target: "design",
      }),
    },
  });

  // Run queue advances design_check with target: design
  await runRunQueue({ store, workGraphMode: "strict", cmd });

  const t = store.getTask("REDESIGN-1")!;
  assert.equal(t.node, "design");
  assert.equal(t.status, "running");
  assert.equal(t.design_check_rounds, 1);
  // Downstream counters must be reset to 0 (§28.1)
  assert.equal(t.spec_attempts, 0);
  assert.equal(t.spec_review_rounds, 0);
  assert.equal(t.code_attempts, 0);
  assert.equal(t.check_attempts, 0);
  assert.equal(t.code_review_rounds, 0);
});

// ── 17. Background Service & CLI Integration in Strict Mode ───────────────

test("CLI run-queue in strict mode advances queue automatically", async () => {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-e2e-"),
    settings: {
      workGraph: "strict",
      maxActiveTasks: 1,
    },
  });
  await createPlugin(host.bb, {
    bbCli: fakeCli().cli,
    cmd: fakeCmd().cmd,
  });

  // Enqueue via CLI
  const enqRes = await host.harness.runCli(["enqueue", "AUTO-CLI", "--mode", "auto", "--json"], {
    cwd: "/tmp/fake-repo",
  });
  assert.equal(enqRes.exitCode, 0);

  // Run run-queue command
  const res = await host.harness.runCli(["run-queue", "--once", "--json"], {
    cwd: "/tmp/fake-repo",
  });
  assert.equal(res.exitCode, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.activeCount, 1);
  assert.equal(data.queuedCount, 0);
});
