import assert from "node:assert/strict";
import test, { beforeEach, after } from "node:test";
import { DelegationStore } from "../src/store.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { CmdRunner } from "../src/cmd.js";
import type { Policy } from "../src/policy.js";
import { resolveTransition } from "../src/transition-matrix.js";
import {
  runRunQueue,
  runResume,
  runEnqueue,
  commitAcceptanceContract,
  checkAcceptanceTampered,
  resolveLevelRoleForWorkGraph,
  matchesNodeLevel,
} from "../src/workgraph.js";
import { createRehearsalHost } from "./workgraph-rehearsal.test.js";

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
      run: async (args: string[]) => {
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
      run: async (c: string, a: string[]) => {
        calls.push({ cmd: c, args: a });
        const r = respond?.(c, a);
        if (r) return r;
        const key = `${c} ${a.join(" ")}`;
        if (key.includes("rev-parse --show-toplevel")) {
          return { exitCode: 0, stdout: "/tmp/fake-repo", stderr: "" };
        }
        if (key.includes("rev-parse --verify origin/main") || key.includes("rev-parse --verify refs/remotes/origin/main")) {
          return { exitCode: 0, stdout: "0000000000000000000000000000000000000001", stderr: "" };
        }
        if (c === "git" && a[0] === "hash-object") {
          return { exitCode: 0, stdout: "acc-blob-sha-12345", stderr: "" };
        }
        if (c === "git" && a[0] === "read-tree") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (c === "git" && a[0] === "update-index") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (c === "git" && a[0] === "write-tree") {
          return { exitCode: 0, stdout: "acc-tree-sha-67890", stderr: "" };
        }
        if (c === "git" && a[0] === "commit-tree") {
          return { exitCode: 0, stdout: "acc-commit-sha-abcdef", stderr: "" };
        }
        if (c === "git" && a[0] === "update-ref") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (c === "git" && a[0] === "branch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (c === "git" && a[0] === "diff") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (c === "git" && a[0] === "rev-parse") {
          return { exitCode: 0, stdout: "0000000000000000000000000000000000000001", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

test("§30.1: resolveLevelRoleForWorkGraph and matchesNodeLevel for architect and spec", () => {
  const policy: Policy = {
    version: 1,
    levels: {
      architect: { chain: ["arch"] },
      spec: { chain: ["sp"] },
      custom_arch: { role: "architect", chain: ["arch"] },
      complex: { chain: ["cplx"] },
    },
    routes: {},
  };

  assert.equal(resolveLevelRoleForWorkGraph("architect", policy), "architect");
  assert.equal(resolveLevelRoleForWorkGraph("custom_arch", policy), "architect");
  assert.equal(resolveLevelRoleForWorkGraph("spec", policy), "spec");
  assert.equal(resolveLevelRoleForWorkGraph("complex", policy), "executor");

  assert.equal(matchesNodeLevel("design", "architect", policy), true);
  assert.equal(matchesNodeLevel("design", "custom_arch", policy), true);
  assert.equal(matchesNodeLevel("design_check", "architect", policy), true);
  assert.equal(matchesNodeLevel("spec", "spec", policy), true);

  assert.equal(matchesNodeLevel("code", "architect", policy), false);
  assert.equal(matchesNodeLevel("design", "complex", policy), false);
  assert.equal(matchesNodeLevel("spec", "complex", policy), false);
});

test("§30 / §31: design node extracts architect acceptance contract and creates git commit", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd, calls: cmdCalls } = fakeCmd();
  const { cli } = fakeCli();

  store.insertTask({
    taskKey: "ARCH-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "auto",
  });

  // start -> design
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  let task = store.getTask("ARCH-1")!;
  assert.equal(task.node, "design");
  assert.equal(task.status, "running");

  // Architect finishes turn with acceptance criteria text
  store.updateTask("ARCH-1", {
    payload: JSON.stringify({
      acceptance_text: "# Acceptance Contract ARCH-1\n1. Validated\n2. Tested",
      design_done: true,
    }),
  });

  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  task = store.getTask("ARCH-1")!;
  assert.equal(task.node, "spec");
  assert.equal(task.status, "running");
  assert.equal(task.acceptance_sha, "acc-commit-sha-abcdef");

  // Verify commit-tree call created commit with message referencing §31
  const commitCall = cmdCalls.find(c => c.cmd === "git" && c.args[0] === "commit-tree");
  assert.ok(commitCall, "must invoke git commit-tree");
  assert.ok(commitCall.args.includes("docs: договор приёмки ARCH-1 (§31)"));
});

test("§31.5: spec node verifies acceptance contract unchanged; tampered contract retries and blocks", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd } = fakeCmd();
  const { cli } = fakeCli();

  store.insertTask({
    taskKey: "ARCH-2",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "auto",
  });

  // start -> design -> spec
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  store.updateTask("ARCH-2", {
    payload: JSON.stringify({ acceptance_text: "Acceptance 1.0", design_done: true }),
  });
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  let task = store.getTask("ARCH-2")!;
  assert.equal(task.node, "spec");

  // Tampered check: simulate acceptance contract modified
  let checkCalls = 0;
  const tamperedCheck = async () => {
    checkCalls++;
    return true; // tampered!
  };

  // Attempt 1
  store.updateTask("ARCH-2", {
    payload: JSON.stringify({ spec_done: true, spec_sha: "sha-spec-1" }),
  });
  await runRunQueue({
    store,
    cmd,
    bbCli: cli,
    workGraphMode: "strict",
    autoAdvance: true,
    checkAcceptanceTampered: tamperedCheck,
  });
  task = store.getTask("ARCH-2")!;
  assert.equal(task.node, "spec");
  assert.equal(task.status, "running");
  assert.equal(task.spec_attempts, 1);

  // Attempt 2
  store.updateTask("ARCH-2", {
    payload: JSON.stringify({ spec_done: true, spec_sha: "sha-spec-2" }),
  });
  await runRunQueue({
    store,
    cmd,
    bbCli: cli,
    workGraphMode: "strict",
    autoAdvance: true,
    checkAcceptanceTampered: tamperedCheck,
  });
  task = store.getTask("ARCH-2")!;
  assert.equal(task.spec_attempts, 2);

  // Attempt 3 -> blocks
  store.updateTask("ARCH-2", {
    payload: JSON.stringify({ spec_done: true, spec_sha: "sha-spec-3" }),
  });
  await runRunQueue({
    store,
    cmd,
    bbCli: cli,
    workGraphMode: "strict",
    autoAdvance: true,
    checkAcceptanceTampered: tamperedCheck,
  });
  task = store.getTask("ARCH-2")!;
  assert.equal(task.node, "spec");
  assert.equal(task.status, "blocked");
  assert.equal(checkCalls, 3);
});

test("§30.3: design_check node verdict OK in auto mode advances to release, in manual to owner_gate", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd } = fakeCmd();
  const { cli } = fakeCli();

  // 1. Auto mode
  store.insertTask({
    taskKey: "ARCH-3A",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "auto",
  });
  // Fast forward to design_check
  store.transitionTask({
    taskKey: "ARCH-3A",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design_check",
    toStatus: "running",
    actor: "test",
    reason: "fast-forward",
  });
  store.updateTask("ARCH-3A", {
    payload: JSON.stringify({ design_check_verdict: "OK", design_check_blockers: 0 }),
  });
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  let task = store.getTask("ARCH-3A")!;
  assert.equal(task.node, "release");
  assert.equal(task.status, "running");

  // 2. Manual mode
  store.insertTask({
    taskKey: "ARCH-3B",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "manual",
  });
  store.transitionTask({
    taskKey: "ARCH-3B",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design_check",
    toStatus: "running",
    actor: "test",
    reason: "fast-forward",
  });
  store.updateTask("ARCH-3B", {
    payload: JSON.stringify({ design_check_verdict: "OK", design_check_blockers: 0 }),
  });
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  task = store.getTask("ARCH-3B")!;
  assert.equal(task.node, "owner_gate");
  assert.equal(task.status, "waiting_approval");
  const p = JSON.parse(task.payload || "{}");
  assert.equal(p.gate_stage, "pre_release");
});

test("§30.3: design_check verdict CHANGES target=code loops to code, target=design loops to design resetting counters", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd } = fakeCmd();
  const { cli } = fakeCli();

  // Test target: code
  store.insertTask({
    taskKey: "ARCH-4A",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "auto",
  });
  store.transitionTask({
    taskKey: "ARCH-4A",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design_check",
    toStatus: "running",
    actor: "test",
    reason: "fast-forward",
  });
  store.updateTask("ARCH-4A", {
    payload: JSON.stringify({
      design_check_verdict: "CHANGES",
      design_check_target: "code",
      design_check_blockers: 1,
    }),
  });
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  let task = store.getTask("ARCH-4A")!;
  assert.equal(task.node, "code");
  assert.equal(task.status, "running");
  assert.equal(task.design_check_rounds, 1);

  // Test target: design (resets downstream counters)
  store.insertTask({
    taskKey: "ARCH-4B",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "auto",
  });
  store.transitionTask({
    taskKey: "ARCH-4B",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design_check",
    toStatus: "running",
    actor: "test",
    reason: "fast-forward",
  });
  // Give it accumulated downstream counters
  store.updateTask("ARCH-4B", {
    spec_attempts: 2,
    code_attempts: 2,
    code_review_rounds: 2,
    payload: JSON.stringify({
      design_check_verdict: "CHANGES",
      design_check_target: "design",
      design_check_blockers: 2,
    }),
  });
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  task = store.getTask("ARCH-4B")!;
  assert.equal(task.node, "design");
  assert.equal(task.status, "running");
  assert.equal(task.design_check_rounds, 1);
  assert.equal(task.spec_attempts, 0);
  assert.equal(task.code_attempts, 0);
  assert.equal(task.code_review_rounds, 0);
});

test("runResume invokes dispatchNode when resolving action", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());

  store.insertTask({
    taskKey: "ARCH-5",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "auto",
  });
  store.transitionTask({
    taskKey: "ARCH-5",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "stalled",
    actor: "test",
    reason: "stalled",
  });

  const dispatched: { taskKey: string; node: string }[] = [];
  const dispatchNode = async (t: any, node: any) => {
    dispatched.push({ taskKey: t.task_key, node });
  };

  const res = await runResume("ARCH-5", undefined, {
    store,
    ctx: { threadId: "thr_coord" } as any,
    workGraphMode: "strict",
    dispatchNode,
  });

  assert.equal(res.ok, true);
  assert.equal(res.task.status, "running");
  assert.equal(res.task.node, "code");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.taskKey, "ARCH-5");
  assert.equal(dispatched[0]!.node, "code");
});

test("§31.5: enqueue --acceptance rejected with acceptance-contract-immutable on feature or pre_release", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd } = fakeCmd();

  // 1. Feature route is immutable
  store.insertTask({
    taskKey: "ARCH-IMM-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "manual",
  });
  store.transitionTask({
    taskKey: "ARCH-IMM-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "test",
    reason: "test",
  });

  await assert.rejects(
    async () => {
      await runEnqueue(
        { taskKey: "ARCH-IMM-1", acceptance: "updated contract" },
        { store, ctx: {} as any, workGraphMode: "strict", cmd, repoRoot: "/tmp/fake-repo", mergeBaseBranch: "main" },
      );
    },
    (err: any) => {
      assert.equal(err.code, "acceptance-contract-immutable");
      return true;
    },
  );

  // 2. Fix route at owner_gate pre_release is immutable
  store.insertTask({
    taskKey: "ARCH-IMM-2",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    priority: 10,
    confirmationMode: "manual",
  });
  store.transitionTask({
    taskKey: "ARCH-IMM-2",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "test",
    reason: "test",
  });
  store.updateTask("ARCH-IMM-2", {
    payload: JSON.stringify({ gate_stage: "pre_release" }),
  });

  await assert.rejects(
    async () => {
      await runEnqueue(
        { taskKey: "ARCH-IMM-2", acceptance: "updated contract" },
        { store, ctx: {} as any, workGraphMode: "strict", cmd, repoRoot: "/tmp/fake-repo", mergeBaseBranch: "main" },
      );
    },
    (err: any) => {
      assert.equal(err.code, "acceptance-contract-immutable");
      return true;
    },
  );

  // 3. Fix route at owner_gate pre_code IS mutable (owner update allowed)
  store.updateTask("ARCH-IMM-2", {
    payload: JSON.stringify({ gate_stage: "pre_code" }),
    branch: "bb/ARCH-IMM-2",
  });
  const res = await runEnqueue(
    { taskKey: "ARCH-IMM-2", acceptance: "owner updated contract" },
    { store, ctx: {} as any, workGraphMode: "strict", cmd, repoRoot: "/tmp/fake-repo", mergeBaseBranch: "main" },
  );
  assert.equal(res.ok, true);

  // 4. Rule-29 transition matrix test for pre_release
  const tr = resolveTransition({
    route: "fix",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_enqueue_acceptance", isOwner: true, acceptanceText: "new text" },
    mode: "manual",
    counters: {
      spec_attempts: 0,
      spec_review_rounds: 0,
      code_attempts: 0,
      check_attempts: 0,
      code_review_rounds: 0,
      design_check_rounds: 0,
      release_attempts: 0,
    },
    gateStage: "pre_release",
  });
  assert.equal(tr.allowed, false);
  assert.equal(tr.errorCode, "acceptance-contract-immutable");
});

test("§31.4 / §31.5 non-blockers: checkAcceptanceTampered fail-closed and read-tree failure check", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());

  // checkAcceptanceTampered fails closed on git diff error
  const failDiffCmd = {
    run: async (c: string, a: string[]) => {
      if (c === "git" && a[0] === "diff") {
        return { exitCode: 128, stdout: "", stderr: "fatal: bad object" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const taskRow = {
    task_key: "ARCH-TAM-1",
    acceptance_sha: "acc-sha-123",
    payload: JSON.stringify({}),
  } as any;
  const isTampered = await checkAcceptanceTampered(
    { cmd: failDiffCmd as any, repoRoot: "/tmp/fake-repo" },
    taskRow,
    "res-sha-456",
  );
  assert.equal(isTampered, true);

  // commitAcceptanceContract checks read-tree exitCode
  const failReadTreeCmd = {
    run: async (c: string, a: string[]) => {
      if (c === "git" && a[0] === "hash-object") {
        return { exitCode: 0, stdout: "blob-123", stderr: "" };
      }
      if (c === "git" && a[0] === "rev-parse") {
        return { exitCode: 0, stdout: "parent-123", stderr: "" };
      }
      if (c === "git" && a[0] === "read-tree") {
        return { exitCode: 1, stdout: "", stderr: "read-tree failed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await assert.rejects(
    async () => {
      await commitAcceptanceContract(failReadTreeCmd as any, "/tmp/fake-repo", "branch-1", "ARCH-TAM-1", "text");
    },
    (err: any) => {
      assert.equal(err.code, "git-failed");
      assert.match(err.message, /read-tree failed/);
      return true;
    },
  );
});
