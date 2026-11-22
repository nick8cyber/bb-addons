/**
 * Slice 5c (Срез 5в): Rehearsal of the whole task work graph with mock/substitute agents
 * across all real entry points (docs/specs/orchestrator.md §32, ADR-0032):
 * 1. End-to-end rehearsal across all 5 levels: spec, research, architect, review, complex
 *    with verification of live dispatch ("вычислено, но не подключено" in shadow mode)
 * 2. Honest path start -> done through real plugin host CLI commands and tools
 * 3. Failing executor handling: stalled, failed, quota -> failure events, 3 attempts ceiling -> blocked
 * 4. Step skip attempts: strict mode blocks direct delegate, merge, release outside run-queue
 * 5. Checks test failure: test commands failing up to 3 times, loop back to code -> blocked
 * Fast execution: each test verifies within milliseconds, completely deterministic without real LLMs.
 */
import assert from "node:assert/strict";
import test, { beforeEach, after } from "node:test";
import { makeTempDir } from "./helpers/temp.js";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import { type CmdRunner } from "../src/cmd.js";
import { DelegationStore, type DelegationStatus } from "../src/store.js";
import { createPlugin } from "../server.js";
import { runRunQueue } from "../src/workgraph.js";

function finishDelegation(
  store: DelegationStore,
  id: number,
  opts: {
    status?: DelegationStatus;
    resultSha?: string;
    resultCommits?: number;
    resultDirty?: number | boolean;
  },
) {
  store.setStatus(id, opts.status ?? "done");
  if (opts.resultSha) {
    store.setRoundResult(id, {
      envId: null,
      branch: "bb/result",
      sha: opts.resultSha,
      commits: opts.resultCommits ?? 1,
      dirty: Boolean(opts.resultDirty),
    });
  }
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
          return { exitCode: 0, stdout: "acc-tree-sha-12345", stderr: "" };
        }
        if (c === "git" && a[0] === "commit-tree") {
          return { exitCode: 0, stdout: "acc-commit-sha-12345", stderr: "" };
        }
        if (c === "git" && a[0] === "update-ref") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (c === "git" && a[0] === "rev-parse" && a[1]?.startsWith("refs/heads/")) {
          return { exitCode: 0, stdout: "acc-parent-sha-12345", stderr: "" };
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

const POLICY_TEXT = JSON.stringify({
  version: 1,
  limits: { maxActive: 5 },
  reviewByLevel: {
    complex: "review",
    medium: "review",
    simple: "review",
  },
  levels: {
    spec: { chain: ["spec-route"] },
    research: { role: "researcher", chain: ["research-route"] },
    architect: { chain: ["architect-route"] },
    complex: { chain: ["complex-route"] },
    medium: { chain: ["simple-route"] },
    simple: { chain: ["simple-route"] },
    review: { role: "auditor", chain: ["review-route"] },
  },
  routes: {
    "spec-route": { preset: "spec-preset", provider: "acp-opencode" },
    "research-route": { preset: "research-preset", provider: "acp-opencode" },
    "architect-route": { preset: "architect-preset", provider: "acp-opencode" },
    "complex-route": { preset: "complex-preset", provider: "acp-opencode" },
    "simple-route": { preset: "simple-preset", provider: "acp-opencode" },
    "review-route": { preset: "review-preset", provider: "acp-opencode" },
  },
});

export async function createRehearsalHost(
  settings: Record<string, string | boolean> = {},
  cli: BbCli = fakeCli().cli,
  cmdRunner: CmdRunner = fakeCmd().cmd,
) {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-rehearsal-"),
    settings: {
      policy: POLICY_TEXT,
      language: "ru",
      workGraph: "shadow",
      ...settings,
    },
    agentSkillIds: [
      "orchestrator-setup",
      "orchestrator-coordinator",
      "orchestrator-setup-ru",
      "orchestrator-coordinator-ru",
    ],
  });
  await createPlugin(host.bb, {
    bbCli: cli,
    cmd: cmdRunner,
  });
  const origRunCli = host.harness.runCli.bind(host.harness);
  host.harness.runCli = (argv, ctx = {}) => {
    return origRunCli(argv, { cwd: "/tmp/fake-repo", ...ctx });
  };
  return host;
}

// ── 1. Shadow Mode Mirroring & Audit (§32 Б4) ─────────────────────────────

test("5в Shadow: un-enqueued manual command logs 'none' sentinels in task_transitions", async () => {
  const host = await createRehearsalHost({ workGraph: "shadow" });
  const store = new DelegationStore(host.bb.storage.database());

  // Direct delegate of un-enqueued task via CLI in shadow mode
  // The command proceeds to delegation logic, and assertGraphAllowsDirectAction mirrors it
  await host.harness.runCli([
    "delegate",
    "UNENQ-1",
    "--level",
    "simple",
    "--json",
  ]);

  const transitions = store.listTransitions("UNENQ-1");
  assert.equal(transitions.length, 1);
  const t0 = transitions[0]!;
  assert.equal(t0.from_node, "none");
  assert.equal(t0.to_node, "none");
  assert.equal(t0.from_status, "none");
  assert.equal(t0.to_status, "none");
  assert.equal(t0.actor, "shadow:coordinator");
  assert.equal(t0.reason, "task-not-enqueued");
  const payload = JSON.parse(t0.payload ?? "{}");
  assert.equal(payload.event, "manual_command");
  assert.equal(payload.command, "delegate");
  assert.equal(payload.would_reject, "graph-required");
  assert.equal(payload.would_block?.reason, "graph-required");
});

test("5в Shadow: enqueued task manual command records would_allow / would_reject in shadow_eval", async () => {
  const host = await createRehearsalHost({ workGraph: "shadow" });
  const store = new DelegationStore(host.bb.storage.database());

  // Enqueue task at node: start -> code
  const enqRes = await host.harness.runCli([
    "enqueue",
    "TASK-ENQ-1",
    "--route",
    "simple",
    "--acceptance",
    "Acceptance criteria",
    "--json",
  ]);
  assert.equal(enqRes.exitCode, 0);
  store.transitionTask({
    taskKey: "TASK-ENQ-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "test",
    reason: "test-advance",
  });

  // 1. Manual delegate matching current node (code) with level simple
  await host.harness.runCli([
    "delegate",
    "TASK-ENQ-1",
    "--level",
    "simple",
    "--json",
  ]);

  let task = store.getTask("TASK-ENQ-1")!;
  let payload = JSON.parse(task.payload ?? "{}");
  assert.equal(payload.shadow_eval.command, "delegate");
  assert.equal(payload.shadow_eval.would_allow, "delegate");
  assert.equal(payload.shadow_eval.would_reject, undefined);

  // 2. Manual delegate with mismatched level (e.g. spec while at code)
  await host.harness.runCli([
    "delegate",
    "TASK-ENQ-1",
    "--level",
    "spec",
    "--json",
  ]);

  task = store.getTask("TASK-ENQ-1")!;
  payload = JSON.parse(task.payload ?? "{}");
  assert.equal(payload.shadow_eval.command, "delegate");
  assert.match(payload.shadow_eval.would_reject, /invalid_node/);

  // 3. Move to node review and test custom auditor level from policy
  store.transitionTask({
    taskKey: "TASK-ENQ-1",
    expectedNode: "code",
    expectedStatus: "running",
    toNode: "review",
    toStatus: "running",
    actor: "test",
    reason: "test-advance",
  });

  await host.harness.runCli([
    "delegate",
    "TASK-ENQ-1",
    "--level",
    "review",
    "--json",
  ]);
  task = store.getTask("TASK-ENQ-1")!;
  payload = JSON.parse(task.payload ?? "{}");
  assert.equal(payload.shadow_eval.would_allow, "delegate");
  assert.equal(payload.shadow_eval.would_reject, undefined);
});

test("5в Shadow: run-queue logs 'вычислено, но не подключено' in shadow mode", async () => {
  const host = await createRehearsalHost({ workGraph: "shadow" });
  const store = new DelegationStore(host.bb.storage.database());

  const enqRes = await host.harness.runCli([
    "enqueue",
    "TASK-SHADOW-1",
    "--route",
    "simple",
    "--acceptance",
    "Acceptance criteria",
    "--json",
  ]);
  assert.equal(enqRes.exitCode, 0);

  // 1. Queued task at start: evaluated without autoAdvance gives would_transition to code
  const res1 = await host.harness.runCli(["run-queue", "--once", "--json"]);
  assert.equal(res1.exitCode, 0);

  let task = store.getTask("TASK-SHADOW-1")!;
  let payload = JSON.parse(task.payload ?? "{}");
  assert.equal(payload.shadow_eval?.note, "вычислено, но не подключено");
  assert.deepEqual(payload.shadow_eval?.would_transition, {
    from_node: "start",
    to_node: "code",
    to_status: "running",
    event: "queue_take",
  });

  // 2. Active running task at code with completed delegation
  store.transitionTask({
    taskKey: "TASK-SHADOW-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "test",
    reason: "test-advance",
  });

  const del = store.insert({
    taskKey: "TASK-SHADOW-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_test",
    level: "simple",
    route: "simple-route",
    preset: "simple-preset",
    provider: "acp-opencode",
  });
  finishDelegation(store, del.id, {
    status: "done",
    resultSha: "shadow-code-sha-1",
    resultCommits: 1,
    resultDirty: 0,
  });

  const res2 = await host.harness.runCli(["run-queue", "--once", "--json"]);
  assert.equal(res2.exitCode, 0);

  task = store.getTask("TASK-SHADOW-1")!;
  payload = JSON.parse(task.payload ?? "{}");
  assert.equal(payload.shadow_eval?.note, "вычислено, но не подключено");
  assert.deepEqual(payload.shadow_eval?.would_transition, {
    from_node: "code",
    to_node: "checks",
    to_status: "running",
    event: "code_delivered",
  });
});

// ── 2. All 5 Levels Rehearsal ─────────────────────────────────────────────

test("5в Levels: spec level commits specification and advances to spec_review", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd } = fakeCmd();
  const { cli } = fakeCli();

  // Enqueue task on feature route
  store.insertTask({
    taskKey: "SPEC-101",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "auto",
  });

  // Advance start -> design
  await runRunQueue({
    store,
    cmd,
    bbCli: cli,
    workGraphMode: "strict",
    autoAdvance: true,
  });
  let task = store.getTask("SPEC-101")!;
  assert.equal(task.node, "design");

  // Deliver design report -> advances design -> spec
  store.updateTask("SPEC-101", {
    payload: JSON.stringify({ acceptance_text: "Acceptance criteria 1.0", design_done: true }),
  });
  await runRunQueue({
    store,
    cmd,
    bbCli: cli,
    workGraphMode: "strict",
    autoAdvance: true,
  });
  task = store.getTask("SPEC-101")!;
  assert.equal(task.node, "spec");
  assert.equal(task.status, "running");

  // Spec executor delivers commit with spec
  const del = store.insert({
    taskKey: "SPEC-101",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_test",
    level: "spec",
    route: "spec-route",
    preset: "spec-preset",
    provider: "acp-opencode",
  });
  finishDelegation(store, del.id, {
    status: "done",
    resultSha: "spec-commit-sha-789",
    resultCommits: 1,
    resultDirty: 0,
  });

  // Advance spec -> spec_review
  await runRunQueue({
    store,
    cmd,
    bbCli: cli,
    workGraphMode: "strict",
    autoAdvance: true,
  });
  task = store.getTask("SPEC-101")!;
  assert.equal(task.node, "spec_review");
  assert.equal(task.spec_sha, "spec-commit-sha-789");
});

test("5в Levels: research route completes start -> research -> done without branch", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd } = fakeCmd();
  const { cli } = fakeCli();

  // Enqueue task on research route
  store.insertTask({
    taskKey: "RES-101",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "research",
    level: "research",
    priority: 10,
    confirmationMode: "auto",
  });

  // Start -> research
  await runRunQueue({
    store,
    cmd,
    bbCli: cli,
    workGraphMode: "strict",
    autoAdvance: true,
  });
  let task = store.getTask("RES-101")!;
  assert.equal(task.node, "research");
  assert.equal(task.status, "running");
  assert.equal(task.branch, null, "research task has no branch");

  // Researcher completes turn
  const del = store.insert({
    taskKey: "RES-101",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_test",
    level: "research",
    route: "research-route",
    preset: "research-preset",
    provider: "acp-opencode",
    noCode: true,
  });
  finishDelegation(store, del.id, {
    status: "done",
    resultDirty: 0,
  });

  // Advance research -> done
  await runRunQueue({
    store,
    cmd,
    bbCli: cli,
    workGraphMode: "strict",
    autoAdvance: true,
  });
  task = store.getTask("RES-101")!;
  assert.equal(task.node, "research");
  assert.equal(task.status, "done");
});

test("5в Levels: architect level design node commits acceptance contract", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd, calls: cmdCalls } = fakeCmd();
  const { cli } = fakeCli();

  store.insertTask({
    taskKey: "ARCH-101",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 10,
    confirmationMode: "auto",
  });

  // start -> design
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  let task = store.getTask("ARCH-101")!;
  assert.equal(task.node, "design");

  // Architect provides acceptance criteria
  store.updateTask("ARCH-101", {
    payload: JSON.stringify({ acceptance_text: "Mandatory criteria:\n1. Fast\n2. Secure", design_done: true }),
  });

  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  task = store.getTask("ARCH-101")!;
  assert.equal(task.node, "spec");
  assert.ok(task.acceptance_sha, "acceptance_sha must be recorded");

  // Check that git hash-object / commit-tree was called for acceptance contract
  const gitCommitCalls = cmdCalls.filter(c => c.cmd === "git" && (c.args.includes("commit-tree") || c.args.includes("hash-object")));
  assert.ok(gitCommitCalls.length > 0, "must invoke git plumbing for acceptance contract");
});

test("5в Levels: review level verifies OK verdict with 0 blockers and advances", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd } = fakeCmd();
  const { cli } = fakeCli((args) => {
    if (args[0] === "tasks" && args[1] === "show") {
      return ok(JSON.stringify({
        task: { key: "REV-101" },
        comments: [{
          authorName: "reviewer",
          kind: "agent",
          threadId: "thr_rev_1",
          body: "Всё отлично!\n{\"verdict\":\"OK\",\"blockers\":0}",
          createdAt: "2026-11-19T04:00:00Z",
        }],
      }));
    }
    return undefined;
  });

  store.insertTask({
    taskKey: "REV-101",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    priority: 10,
    confirmationMode: "auto",
  });

  // Manually position at node: review
  store.transitionTask({
    taskKey: "REV-101",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "review",
    toStatus: "running",
    actor: "test",
    reason: "test-advance",
  });

  const del = store.insert({
    taskKey: "REV-101",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_test",
    level: "review",
    route: "review-route",
    preset: "review-preset",
    provider: "acp-opencode",
    noCode: true,
  });
  store.setThreadInfo(del.id, "thr_rev_1");
  finishDelegation(store, del.id, { status: "done", resultDirty: 0 });

  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  const task = store.getTask("REV-101")!;
  assert.equal(task.node, "release", "advances from review to release on OK with 0 blockers");
});

test("5в Honest path: complete pipeline start -> done across all nodes", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd } = fakeCmd();
  const { cli } = fakeCli((args) => {
    if (args[0] === "tasks" && args[1] === "show") {
      return ok(JSON.stringify({
        task: { key: "HAPPY-101" },
        comments: [{
          authorName: "reviewer",
          kind: "agent",
          threadId: "thr_rev_happy",
          body: "{\"verdict\":\"OK\",\"blockers\":0}",
          createdAt: "2026-11-19T04:00:00Z",
        }],
      }));
    }
    return undefined;
  });

  // Enqueue via CLI
  await host.harness.runCli([
    "enqueue",
    "HAPPY-101",
    "--route",
    "simple",
    "--mode",
    "auto",
    "--acceptance",
    "Kind: mechanical\nBasis: Pass tests",
    "--json",
  ]);

  // 1. start -> code
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  let task = store.getTask("HAPPY-101")!;
  assert.equal(task.node, "code");

  // Code delivery
  const delCode = store.insert({
    taskKey: "HAPPY-101",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_test",
    level: "simple",
    route: "simple-route",
    preset: "simple-preset",
    provider: "acp-opencode",
  });
  finishDelegation(store, delCode.id, { status: "done", resultSha: "code-sha-111", resultCommits: 2, resultDirty: 0 });

  // 2. code -> checks -> review
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  task = store.getTask("HAPPY-101")!;
  assert.equal(task.node, "review");

  // Review delivery
  const delRev = store.insert({
    taskKey: "HAPPY-101",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_test",
    level: "review",
    route: "review-route",
    preset: "review-preset",
    provider: "acp-opencode",
    noCode: true,
  });
  store.setThreadInfo(delRev.id, "thr_rev_happy");
  finishDelegation(store, delRev.id, { status: "done", resultDirty: 0 });

  // 3. review -> release
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  task = store.getTask("HAPPY-101")!;
  assert.equal(task.node, "release");

  // 4. release -> done
  await runRunQueue({
    store,
    cmd,
    bbCli: cli,
    workGraphMode: "strict",
    autoAdvance: true,
    runReleaseStep: async () => ({ status: "published", publishedSha: "pub-sha-999" }),
  });
  task = store.getTask("HAPPY-101")!;
  assert.equal(task.status, "done");
});

// ── 3. Failing Executor & Impasse Handling ────────────────────────────────

test("5в Failure: executor stalled/failed/quota transitions to stalled, zero-commits blocks at ceiling 3", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const { cmd } = fakeCmd();
  const { cli } = fakeCli();

  await host.harness.runCli([
    "enqueue",
    "FAIL-101",
    "--route",
    "simple",
    "--mode",
    "auto",
    "--acceptance",
    "Kind: mechanical\nBasis: Criteria",
    "--json",
  ]);

  // Advance start -> code
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  let task = store.getTask("FAIL-101")!;
  assert.equal(task.node, "code");
  assert.equal(task.status, "running");

  // 1. Infrastructure failure: delegation fails (quota/stalled)
  let del = store.insert({
    taskKey: "FAIL-101",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_test",
    level: "simple",
    route: "simple-route",
    preset: "simple-preset",
    provider: "acp-opencode",
  });
  finishDelegation(store, del.id, { status: "quota" });

  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
  task = store.getTask("FAIL-101")!;
  assert.equal(task.status, "stalled", "delegation failure must transition task to stalled");

  // Resume task back to running
  const resResume = await host.harness.runCli(["resume", "FAIL-101", "--json"]);
  assert.equal(resResume.exitCode, 0);
  task = store.getTask("FAIL-101")!;
  assert.equal(task.status, "running");

  // 2. Output failure: executor delivers 0 commits -> increments code_attempts up to 3 -> blocked
  for (let attempt = 1; attempt <= 3; attempt++) {
    del = store.insert({
      taskKey: "FAIL-101",
      coordinatorThreadId: "thr_coord",
      projectId: "proj_test",
      level: "simple",
      route: "simple-route",
      preset: "simple-preset",
      provider: "acp-opencode",
    });
    finishDelegation(store, del.id, {
      status: "done",
      resultSha: "sha-empty",
      resultCommits: 0,
      resultDirty: 0,
    });

    await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });
    task = store.getTask("FAIL-101")!;
    assert.equal(task.code_attempts, attempt);
    if (attempt < 3) {
      assert.equal(task.status, "running");
    } else {
      assert.equal(task.status, "blocked", "must transition to blocked when ceiling 3 is reached");
    }
  }
});

// ── 4. Step Skip Prevention & Strict Mode Enforcement ─────────────────────

test("5в Step skip: strict mode blocks direct delegate, merge, and release", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });

  // Direct delegate un-enqueued -> graph-required
  const resDel = await host.harness.runCli(["delegate", "SKIP-101", "--level", "simple", "--json"]);
  assert.equal(resDel.exitCode, 1);
  assert.equal(JSON.parse(resDel.stdout).error.code, "graph-required");

  // Enqueue task
  await host.harness.runCli([
    "enqueue",
    "SKIP-101",
    "--route",
    "simple",
    "--acceptance",
    "Kind: mechanical\nBasis: Criteria",
    "--json",
  ]);

  // Direct delegate while active -> graph-managed
  const resDelManaged = await host.harness.runCli(["delegate", "SKIP-101", "--level", "simple", "--json"]);
  assert.equal(resDelManaged.exitCode, 1);
  assert.equal(JSON.parse(resDelManaged.stdout).error.code, "graph-managed");

  // Direct merge -> graph-managed
  const resMerge = await host.harness.runCli(["merge", "SKIP-101", "--json"]);
  assert.equal(resMerge.exitCode, 1);
  assert.equal(JSON.parse(resMerge.stdout).error.code, "graph-managed");

  // Direct release -> graph-managed
  const resRelease = await host.harness.runCli(["release", "SKIP-101", "--json"]);
  assert.equal(resRelease.exitCode, 1);
  assert.equal(JSON.parse(resRelease.stdout).error.code, "graph-managed");
});

// ── 5. Checks Test Failure Loop ───────────────────────────────────────────

test("5в Checks failure: failing checks test loops back to code and blocks after 3 attempts", async () => {
  const host = await createRehearsalHost({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  let checksFail = true;
  const { cmd } = fakeCmd((c, a) => {
    if (c === "npm" && a[0] === "test" && checksFail) {
      return { exitCode: 1, stdout: "", stderr: "Tests failed assertion" };
    }
    return undefined;
  });
  const { cli } = fakeCli();

  store.insertTask({
    taskKey: "CHK-101",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    priority: 10,
    confirmationMode: "auto",
    payload: JSON.stringify({ acceptance_text: "Kind: mechanical\nBasis: Checks failure loop acceptance criteria" }),
  });

  // start -> code
  await runRunQueue({ store, cmd, bbCli: cli, workGraphMode: "strict", autoAdvance: true });

  for (let round = 1; round <= 3; round++) {
    // Deliver code
    const del = store.insert({
      taskKey: "CHK-101",
      coordinatorThreadId: "thr_coord",
      projectId: "proj_test",
      level: "simple",
      route: "simple-route",
      preset: "simple-preset",
      provider: "acp-opencode",
    });
    finishDelegation(store, del.id, {
      status: "done",
      resultSha: `code-chk-sha-${round}`,
      resultCommits: 1,
      resultDirty: 0,
    });

    // Run checks with failing runChecks configured
    await runRunQueue({
      store,
      cmd,
      bbCli: cli,
      workGraphMode: "strict",
      autoAdvance: true,
      runChecks: async () => ({ ok: false, exitCode: 1, output: "Tests failed assertion" }),
    });

    const task = store.getTask("CHK-101")!;
    if (round < 3) {
      assert.equal(task.node, "code", `round ${round} must loop back to code`);
      assert.equal(task.check_attempts, round);
      assert.equal(task.status, "running");
    } else {
      assert.equal(task.node, "checks", "round 3 must stay on checks");
      assert.equal(task.check_attempts, 3);
      assert.equal(task.status, "blocked", "round 3 must transition to blocked");
    }
  }
});
