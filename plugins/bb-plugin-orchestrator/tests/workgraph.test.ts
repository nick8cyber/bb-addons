import assert from "node:assert/strict";
import test, { beforeEach, after } from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { makeTempDir } from "./helpers/temp.js";
import {
  createFakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import { type CmdRunner, createCmd } from "../src/cmd.js";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import { createPlugin } from "../server.js";
import {
  checkAndPrepareTaskBranch,
  archiveAndCleanupTaskBranch,
  computeTaskBranch,
  isOwnerCalling,
  normalizeWorkGraphMode,
  runRunQueue,
  runResume,
  runEnqueue,
  runApprove,
  DEFAULT_ALLOWED_ENV_VARS,
  buildChecksEnvironment,
  runTddFailFirstVerification,
  extractAcceptanceCommands,
  formatDesignCheckPacket,
} from "../src/workgraph.js";
import { parsePolicy } from "../src/policy.js";

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

const POLICY_TEXT = JSON.stringify({
  version: 1,
  limits: { maxActive: 5 },
  levels: {
    simple: { chain: ["simple"] },
    complex: { chain: ["simple"] },
  },
  routes: {
    simple: { preset: "simple", provider: "acp-opencode" },
  },
});

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
        const custom = respond?.(args);
        if (custom) return custom;
        const key = args.join(" ");
        if (key.startsWith("tasks preset list"))
          return ok(JSON.stringify({ presets: [{ name: "simple", id: "p1" }] }));
        if (key.startsWith("tasks preset show"))
          return ok(
            JSON.stringify({
              preset: {
                providerId: "p",
                modelId: "m1",
                reasoningLevel: "medium",
                permissionMode: "auto",
                environmentKind: "project-default",
              },
            }),
          );
        if (key.startsWith("tasks show"))
          return ok(
            JSON.stringify({
              task: {
                id: "task-1",
                key: args[2] ?? "PLUG-1",
                title: "Test Task Slug Feature",
                status: "in_progress",
              },
              project: { name: "p", linkedBbProjectId: "proj_bb" },
              subtasks: [],
              attachments: [],
              comments: [],
            }),
          );
        if (key.startsWith("projects list"))
          return ok(
            JSON.stringify({
              projects: [
                {
                  id: "proj_bb",
                  name: "p",
                  repoRoot: "/tmp/fake-repo",
                  hosts: [{ hostId: "local", repoPath: "/tmp/fake-repo" }],
                },
              ],
            }),
          );
        if (key.startsWith("thread show"))
          return ok(
            JSON.stringify({
              thread: {
                parentThreadId: "thr_coord",
                parentNotifications: "auto",
                visibility: "hidden",
              },
            }),
          );
        if (key.startsWith("thread output"))
          return ok(JSON.stringify({ output: "" }));
        if (key.startsWith("thread tell"))
          return ok();
        return ok();
      },
    },
  };
}

function fakeCmd(
  overrides?: (file: string, args: string[]) => BbCliResult | undefined,
): { cmd: CmdRunner; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  return {
    calls,
    cmd: {
      run: async (file, args) => {
        calls.push({ file, args });
        const res = overrides?.(file, args);
        if (res) return res;
        const key = `${file} ${args.join(" ")}`;
        if (key.includes("rev-parse --show-toplevel")) {
          return ok("/tmp/fake-repo");
        }
        if (
          key.includes("rev-parse --verify origin/main") ||
          key.includes("rev-parse --verify refs/remotes/origin/main")
        ) {
          return ok("0000000000000000000000000000000000000001");
        }
        if (key.includes("rev-parse --verify")) {
          // default: refs don't exist
          return { exitCode: 1, stdout: "", stderr: "fatal: Needed a single revision" };
        }
        if (file === "git" && args[0] === "hash-object") {
          return ok("acc-blob-sha-1234567890");
        }
        if (file === "git" && args[0] === "read-tree") {
          return ok();
        }
        if (file === "git" && args[0] === "update-index") {
          return ok();
        }
        if (file === "git" && args[0] === "write-tree") {
          return ok("acc-tree-sha-1234567890");
        }
        if (file === "git" && args[0] === "commit-tree") {
          return ok("acc-commit-sha-1234567890");
        }
        if (file === "git" && args[0] === "update-ref") {
          return ok();
        }
        if (file === "git" && args[0] === "rev-parse" && args[1]?.startsWith("refs/heads/")) {
          return ok("acc-parent-sha-1234567890");
        }
        if (key.includes("ls-remote")) {
          return ok("");
        }
        return ok();
      },
    },
  };
}

async function hostWith(
  settings: Record<string, string | boolean> = {},
  cli: BbCli = fakeCli().cli,
  cmdRunner: CmdRunner = fakeCmd().cmd,
) {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-wg-"),
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

// ── 1. Schema & Check Constraints (§27.1) ─────────────────────────────

test("task_queue and task_transitions check constraints and defaults", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  // Insert valid task
  const task = store.insertTask({
    taskKey: "PLUG-10",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    priority: 150,
  });

  assert.equal(task.task_key, "PLUG-10");
  assert.equal(task.route, "feature");
  assert.equal(task.level, "complex");
  assert.equal(task.node, "start");
  assert.equal(task.status, "queued");
  assert.equal(task.priority, 150);
  assert.equal(task.confirmation_mode, "manual");
  assert.equal(task.spec_attempts, 0);
  assert.equal(task.code_attempts, 0);

  // Initial transition recorded
  const transitions = store.listTransitions("PLUG-10");
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]!.from_node, "start");
  assert.equal(transitions[0]!.to_node, "start");
  assert.equal(transitions[0]!.from_status, "queued");
  assert.equal(transitions[0]!.to_status, "queued");
  assert.equal(transitions[0]!.reason, "enqueue");

  // Invalid route rejected by CHECK constraint
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO task_queue (
            task_key, project_id, coordinator_thread_id, route, level,
            node, status, entered_at, created_at, updated_at
          ) VALUES ('PLUG-INV-1', 'p', 'c', 'invalid_route', 'complex', 'start', 'queued', 1, 1, 1)`,
        )
        .run(),
    /CHECK constraint failed/,
  );

  // Invalid level rejected
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO task_queue (
            task_key, project_id, coordinator_thread_id, route, level,
            node, status, entered_at, created_at, updated_at
          ) VALUES ('PLUG-INV-2', 'p', 'c', 'feature', 'ultra_complex', 'start', 'queued', 1, 1, 1)`,
        )
        .run(),
    /CHECK constraint failed/,
  );

  // Invalid node rejected
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO task_queue (
            task_key, project_id, coordinator_thread_id, route, level,
            node, status, entered_at, created_at, updated_at
          ) VALUES ('PLUG-INV-3', 'p', 'c', 'feature', 'complex', 'invalid_node', 'queued', 1, 1, 1)`,
        )
        .run(),
    /CHECK constraint failed/,
  );

  // Invalid status rejected
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO task_queue (
            task_key, project_id, coordinator_thread_id, route, level,
            node, status, entered_at, created_at, updated_at
          ) VALUES ('PLUG-INV-4', 'p', 'c', 'feature', 'complex', 'start', 'invalid_status', 1, 1, 1)`,
        )
        .run(),
    /CHECK constraint failed/,
  );

  // Duplicate task_key rejected by PRIMARY KEY
  assert.throws(
    () =>
      store.insertTask({
        taskKey: "PLUG-10",
        projectId: "proj_1",
        coordinatorThreadId: "thr_coord",
        route: "feature",
        level: "complex",
      }),
    /UNIQUE constraint failed/,
  );
});

// ── 2. CAS Deterministic Transitions (§27.1 п.2, §28.1) ───────────────

test("transitionTask executes atomic CAS and logs in task_transitions", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.insertTask(
    {
      taskKey: "PLUG-20",
      projectId: "proj_1",
      coordinatorThreadId: "thr_coord",
      route: "feature",
      level: "complex",
    },
    1000,
  );

  // Step 1: start/queued -> design/running
  const res1 = store.transitionTask(
    {
      taskKey: "PLUG-20",
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "design",
      toStatus: "running",
      actor: "run-queue",
      reason: "dispatch-design",
      now: 1100,
    },
    1100,
  );

  assert.equal(res1.ok, true);
  assert.equal(res1.task!.node, "design");
  assert.equal(res1.task!.status, "running");
  assert.equal(res1.task!.entered_at, 1100);
  assert.equal(res1.task!.updated_at, 1100);

  // Conflict test: parallel CAS with wrong expectedNode
  const conflictRes = store.transitionTask(
    {
      taskKey: "PLUG-20",
      expectedNode: "start", // Stale expectation!
      expectedStatus: "queued",
      toNode: "spec",
      toStatus: "running",
      actor: "parallel-worker",
      reason: "conflict-attempt",
      now: 1200,
    },
    1200,
  );

  assert.equal(conflictRes.ok, false);
  assert.equal(conflictRes.conflict, true);
  // Row did not change
  assert.equal(store.getTask("PLUG-20")!.node, "design");

  // Step 2: design/running -> spec/running with acceptance_sha update
  const res2 = store.transitionTask(
    {
      taskKey: "PLUG-20",
      expectedNode: "design",
      expectedStatus: "running",
      toNode: "spec",
      toStatus: "running",
      actor: "architect",
      reason: "acceptance-committed",
      now: 1300,
      updates: {
        acceptance_sha: "sha_acceptance_1",
      },
    },
    1300,
  );

  assert.equal(res2.ok, true);
  assert.equal(res2.task!.node, "spec");
  assert.equal(res2.task!.acceptance_sha, "sha_acceptance_1");

  // Transitions log has 3 entries: enqueue, design, spec
  const transitions = store.listTransitions("PLUG-20");
  assert.equal(transitions.length, 3);
  assert.equal(transitions[1]!.from_node, "start");
  assert.equal(transitions[1]!.to_node, "design");
  assert.equal(transitions[1]!.actor, "run-queue");
  assert.equal(transitions[2]!.from_node, "design");
  assert.equal(transitions[2]!.to_node, "spec");
  assert.equal(transitions[2]!.actor, "architect");
});

// ── 3. Branch Slug & Helper Functions ─────────────────────────────────

test("computeTaskBranch generates deterministic normalized slug", () => {
  // Route feature with title
  const b1 = computeTaskBranch("PLUG-100", "feature", "Support OAuth2 Login & Flow!");
  assert.equal(b1, "bb/plug-100-support-oauth2-login-flow");

  // Long title clamped to 30 chars
  const b2 = computeTaskBranch(
    "PLUG-101",
    "fix",
    "A Very Long Feature Title That Exceeds Thirty Characters In Length",
  );
  assert.equal(b2, "bb/plug-101-a-very-long-feature-title-that");
  assert.ok(b2!.length <= 30 + "bb/plug-101-".length);

  // Title without latin letters falls back to route
  const b3 = computeTaskBranch("PLUG-102", "simple", "Проверка русских символов");
  assert.equal(b3, "bb/plug-102-simple");

  // Route research has no branch
  const b4 = computeTaskBranch("PLUG-103", "research", "Market Analysis");
  assert.equal(b4, null);
});

test("isOwnerCalling checks BB_THREAD_ID and context", () => {
  // Clean env, no threadId
  const prevEnv = process.env.BB_THREAD_ID;
  try {
    delete process.env.BB_THREAD_ID;
    assert.equal(isOwnerCalling(), true);
    assert.equal(isOwnerCalling({ threadId: "" }), true);
    assert.equal(isOwnerCalling({ threadId: "thr_agent" } as any), false);

    process.env.BB_THREAD_ID = "thr_agent_env";
    assert.equal(isOwnerCalling(), false);
    assert.equal(isOwnerCalling({} as any), false);
  } finally {
    delete process.env.BB_THREAD_ID;
  }
});

test("normalizeWorkGraphMode parses settings", () => {
  assert.equal(normalizeWorkGraphMode("off"), "off");
  assert.equal(normalizeWorkGraphMode("shadow"), "shadow");
  assert.equal(normalizeWorkGraphMode("strict"), "strict");
  assert.equal(normalizeWorkGraphMode("SHADOW"), "shadow");
  assert.equal(normalizeWorkGraphMode("unknown"), "off");
  assert.equal(normalizeWorkGraphMode(undefined), "off");
});

// ── 4. CLI Queue Commands: enqueue, dequeue, defer, reject, resume, approve, release-note, run-queue ─

test("CLI enqueue creates new task with branch and defaults", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  const res = await host.harness.runCli([
    "enqueue",
    "PLUG-200",
    "--route",
    "feature",
    "--level",
    "complex",
    "--priority",
    "80",
    "--release-note",
    "feat: initial release note",
    "--json",
  ]);

  assert.equal(res.exitCode, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.task.task_key, "PLUG-200");
  assert.equal(data.task.route, "feature");
  assert.equal(data.task.level, "complex");
  assert.equal(data.task.status, "queued");
  assert.equal(data.task.priority, 80);
  assert.equal(data.task.release_note, "feat: initial release note");
  assert.match(data.task.branch, /^bb\/plug-200-/);
});

test("CLI enqueue rejects code route with spec or architect level", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  const res = await host.harness.runCli([
    "enqueue",
    "PLUG-201",
    "--route",
    "feature",
    "--level",
    "spec",
    "--json",
  ]);

  assert.equal(res.exitCode, 1);
  const err = JSON.parse(res.stdout);
  assert.equal(err.error.code, "invalid-level");

  // Invalid level string
  const resBadLevel = await host.harness.runCli([
    "enqueue",
    "PLUG-201",
    "--level",
    "foo",
    "--json",
  ]);
  assert.equal(resBadLevel.exitCode, 1);
  assert.equal(JSON.parse(resBadLevel.stdout).error.code, "invalid-arguments");

  // Invalid priority string
  const resBadPri = await host.harness.runCli([
    "enqueue",
    "PLUG-201",
    "--priority",
    "abc",
    "--json",
  ]);
  assert.equal(resBadPri.exitCode, 1);
  assert.equal(JSON.parse(resBadPri.stdout).error.code, "invalid-arguments");

  // docs route with complex level rejected
  const resDocsComplex = await host.harness.runCli([
    "enqueue",
    "PLUG-201",
    "--route",
    "docs",
    "--level",
    "complex",
    "--json",
  ]);
  assert.equal(resDocsComplex.exitCode, 1);
  assert.equal(JSON.parse(resDocsComplex.stdout).error.code, "invalid-level");
});

test("CLI enqueue prevents double active enqueue", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "PLUG-202", "--route", "feature", "--json"]);

  const res = await host.harness.runCli([
    "enqueue",
    "PLUG-202",
    "--route",
    "feature",
    "--json",
  ]);

  assert.equal(res.exitCode, 1);
  const err = JSON.parse(res.stdout);
  assert.equal(err.error.code, "task-already-enqueued");
});

test("CLI enqueue owner-only flags are rejected from agent thread", async () => {
  const prevEnv = process.env.BB_THREAD_ID;
  try {
    process.env.BB_THREAD_ID = "thr_agent";
    const host = await hostWith({ workGraph: "shadow" });

    // --mode rejected
    const resMode = await host.harness.runCli([
      "enqueue",
      "PLUG-203",
      "--mode",
      "auto",
      "--json",
    ]);
    assert.equal(resMode.exitCode, 1);
    assert.equal(JSON.parse(resMode.stdout).error.code, "permission-denied");
    assert.match(
      JSON.parse(resMode.stdout).error.message,
      /--mode flag is restricted to owner/,
    );

    // --acceptance rejected
    const resAcc = await host.harness.runCli([
      "enqueue",
      "PLUG-204",
      "--acceptance",
      "acceptance text",
      "--json",
    ]);
    assert.equal(resAcc.exitCode, 1);
    assert.equal(JSON.parse(resAcc.stdout).error.code, "permission-denied");
  } finally {
    delete process.env.BB_THREAD_ID;
  }
});

test("CLI enqueue with unmerged branch requires --force-reset-branch", async () => {
  const fake = fakeCmd((file, args) => {
    const k = args.join(" ");
    if (k.includes("rev-parse --verify refs/heads/bb/plug-205")) {
      return ok("sha_local_unmerged");
    }
    if (k.includes("merge-base --is-ancestor")) {
      // not an ancestor!
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    return undefined;
  });

  const host = await hostWith({ workGraph: "shadow" }, fakeCli().cli, fake.cmd);

  // Without force reset -> error unmerged-branch-exists
  const resFail = await host.harness.runCli([
    "enqueue",
    "PLUG-205",
    "--route",
    "feature",
    "--json",
  ]);
  assert.equal(resFail.exitCode, 1);
  assert.equal(JSON.parse(resFail.stdout).error.code, "unmerged-branch-exists");

  // With force reset -> passes and archives
  const resOk = await host.harness.runCli([
    "enqueue",
    "PLUG-205",
    "--route",
    "feature",
    "--force-reset-branch",
    "--json",
  ]);
  assert.equal(resOk.exitCode, 0);
  assert.equal(JSON.parse(resOk.stdout).ok, true);

  // Tag archive created
  const tagCall = fake.calls.find(
    (c) =>
      c.args.includes("tag") &&
      c.args.some((a) => a.includes("archive/PLUG-205-force-reset-")),
  );
  assert.ok(tagCall, "archive tag should be created on force reset");
});

test("CLI dequeue owner-only, cancels task and archives branch", async () => {
  const fake = fakeCmd((file, args) => {
    const k = args.join(" ");
    if (k.includes("rev-parse --verify refs/heads/bb/plug-206")) {
      return ok("sha_local_to_cancel");
    }
    return undefined;
  });

  const host = await hostWith({ workGraph: "shadow" }, fakeCli().cli, fake.cmd);
  await host.harness.runCli(["enqueue", "PLUG-206", "--json"]);

  // Dequeue with thread ID (agent) -> permission denied
  const prevEnv = process.env.BB_THREAD_ID;
  try {
    process.env.BB_THREAD_ID = "thr_agent";
    const resAgent = await host.harness.runCli([
      "dequeue",
      "PLUG-206",
      "--reason",
      "test",
      "--json",
    ]);
    assert.equal(resAgent.exitCode, 1);
    assert.equal(JSON.parse(resAgent.stdout).error.code, "permission-denied");
  } finally {
    delete process.env.BB_THREAD_ID;
  }

  // Dequeue as owner -> success
  const resOwner = await host.harness.runCli([
    "dequeue",
    "PLUG-206",
    "--reason",
    "owner cancelled",
    "--json",
  ]);
  assert.equal(resOwner.exitCode, 0);
  const data = JSON.parse(resOwner.stdout);
  assert.equal(data.task.status, "cancelled");

  // Tag archive created for cancelled task
  const cancelTag = fake.calls.find(
    (c) =>
      c.args.includes("tag") &&
      c.args.some((a) => a.includes("archive/PLUG-206-cancelled-")),
  );
  assert.ok(cancelTag, "archive tag should be created on dequeue");

  // Re-enqueue from cancelled on fix route without acceptance -> rejected!
  const resReenqueueNoAcc = await host.harness.runCli([
    "enqueue",
    "PLUG-206",
    "--route",
    "fix",
    "--json",
  ]);
  assert.equal(resReenqueueNoAcc.exitCode, 1);
  assert.equal(
    JSON.parse(resReenqueueNoAcc.stdout).error.code,
    "acceptance-missing",
  );
});

test("CLI defer and resume from deferred", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "PLUG-207", "--json"]);

  // Defer requires reason
  const resNoReason = await host.harness.runCli(["defer", "PLUG-207", "--json"]);
  assert.equal(resNoReason.exitCode, 1);
  assert.equal(JSON.parse(resNoReason.stdout).error.code, "invalid-arguments");

  // Defer as owner
  const resDefer = await host.harness.runCli([
    "defer",
    "PLUG-207",
    "--reason",
    "postponed to next sprint",
    "--json",
  ]);
  assert.equal(resDefer.exitCode, 0);
  assert.equal(JSON.parse(resDefer.stdout).task.status, "deferred");
  assert.equal(JSON.parse(resDefer.stdout).task.deferred_by, "owner");

  // Resume from deferred (queued on start)
  const resResume = await host.harness.runCli(["resume", "PLUG-207", "--json"]);
  assert.equal(resResume.exitCode, 0);
  assert.equal(JSON.parse(resResume.stdout).task.status, "queued");
  assert.equal(JSON.parse(resResume.stdout).task.node, "start");
  assert.equal(JSON.parse(resResume.stdout).task.deferred_by, null);

  // Advance to owner_gate and defer on fix route, then update acceptance via enqueue
  await host.harness.runCli([
    "enqueue",
    "FIX-207",
    "--route",
    "fix",
    "--acceptance",
    "initial-contract",
    "--json",
  ]);
  const db = (host.bb.storage as any).database();
  const store = new DelegationStore(db);
  store.transitionTask({
    taskKey: "FIX-207",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "deferred",
    actor: "owner",
    reason: "hold",
    updates: {
      deferred_by: "owner",
      deferred_reason: "hold",
    },
  });

  // Updating acceptance at owner_gate/deferred atomically transitions to waiting_approval
  const resAccept = await host.harness.runCli([
    "enqueue",
    "FIX-207",
    "--acceptance",
    "updated-acceptance-contract",
    "--json",
  ]);
  assert.equal(resAccept.exitCode, 0);
  const acceptTask = JSON.parse(resAccept.stdout).task;
  assert.equal(acceptTask.status, "waiting_approval");
  assert.equal(acceptTask.node, "owner_gate");
  assert.equal(acceptTask.deferred_by, null);
  assert.equal(acceptTask.deferred_reason, null);

  // Verify transition is logged in task_transitions
  const trans = store.listTransitions("FIX-207");
  const updateTrans = trans.find((t) => t.reason === "update-acceptance");
  assert.ok(updateTrans, "update-acceptance transition must be recorded in task_transitions");
  assert.equal(updateTrans.from_status, "deferred");
  assert.equal(updateTrans.to_status, "waiting_approval");

  // Chain test: start/queued -> defer -> resume -> advance to owner_gate -> reject -> resume
  // Must return to owner_gate/waiting_approval, NEVER owner_gate/queued!
  await host.harness.runCli([
    "enqueue",
    "CHAIN-1",
    "--route",
    "fix",
    "--acceptance",
    "contract",
    "--json",
  ]);
  await host.harness.runCli(["defer", "CHAIN-1", "--reason", "pause", "--json"]);
  await host.harness.runCli(["resume", "CHAIN-1", "--json"]);
  // Advance to owner_gate / waiting_approval
  store.transitionTask({
    taskKey: "CHAIN-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "system",
    reason: "entered_owner_gate",
  });
  // Reject at owner_gate -> moves to deferred
  await host.harness.runCli(["reject", "CHAIN-1", "--reason", "needs-fix", "--json"]);
  const chainDeferred = store.getTask("CHAIN-1")!;
  assert.equal(chainDeferred.node, "owner_gate");
  assert.equal(chainDeferred.status, "deferred");
  // Resume from deferred at owner_gate must be waiting_approval, not queued!
  const chainResumed = await host.harness.runCli(["resume", "CHAIN-1", "--json"]);
  assert.equal(chainResumed.exitCode, 0);
  const chainData = JSON.parse(chainResumed.stdout).task;
  assert.equal(chainData.node, "owner_gate");
  assert.equal(chainData.status, "waiting_approval");
  const payloadParsed = chainData.payload ? JSON.parse(chainData.payload) : {};
  assert.equal(payloadParsed.previous_status, undefined);
});

test("CLI reject at owner_gate for feature and docs routes", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "PLUG-208", "--route", "feature", "--json"]);

  // Directly advance store to owner_gate / waiting_approval for testing
  const db = (host.bb.storage as any).database();
  const store = new DelegationStore(db);
  store.transitionTask({
    taskKey: "PLUG-208",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "system",
    reason: "test-advance",
  });

  // Reject with target design
  const resReject = await host.harness.runCli([
    "reject",
    "PLUG-208",
    "--target",
    "design",
    "--reason",
    "redesign required",
    "--json",
  ]);
  assert.equal(resReject.exitCode, 0);
  const data = JSON.parse(resReject.stdout);
  assert.equal(data.task.node, "design");
  assert.equal(data.task.status, "running");
});

test("CLI approve at owner_gate transitions to code (feature) or release (docs)", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "PLUG-209", "--route", "feature", "--json"]);

  const db = (host.bb.storage as any).database();
  const store = new DelegationStore(db);
  store.transitionTask({
    taskKey: "PLUG-209",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "owner_gate",
    toStatus: "waiting_approval",
    actor: "system",
    reason: "test-advance",
  });

  // Approve
  const resApprove = await host.harness.runCli([
    "approve",
    "PLUG-209",
    "--comment",
    "specs look great",
    "--json",
  ]);
  assert.equal(resApprove.exitCode, 0);
  const data = JSON.parse(resApprove.stdout);
  assert.equal(data.task.node, "code");
  assert.equal(data.task.status, "running");

  // Transitions log reflects approval
  const transitions = store.listTransitions("PLUG-209");
  const last = transitions[transitions.length - 1]!;
  assert.equal(last.from_node, "owner_gate");
  assert.equal(last.to_node, "code");
  assert.equal(last.actor, "owner");
  assert.equal(last.reason, "specs look great");
});

test("CLI release-note only works when waiting_release_note", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "PLUG-210", "--json"]);

  // Fails when task is queued
  const resFail = await host.harness.runCli([
    "release-note",
    "PLUG-210",
    "v1.0.0 released",
    "--json",
  ]);
  assert.equal(resFail.exitCode, 1);
  assert.equal(JSON.parse(resFail.stdout).error.code, "invalid-status");

  // Advance to waiting_release_note
  const db = (host.bb.storage as any).database();
  const store = new DelegationStore(db);
  store.transitionTask({
    taskKey: "PLUG-210",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "release",
    toStatus: "waiting_release_note",
    actor: "system",
    reason: "need-note",
  });

  const resOk = await host.harness.runCli([
    "release-note",
    "PLUG-210",
    "v1.0.0 released with features",
    "--json",
  ]);
  assert.equal(resOk.exitCode, 0);
  const data = JSON.parse(resOk.stdout);
  assert.equal(data.task.release_note, "v1.0.0 released with features");
  assert.equal(data.task.status, "running");
});

test("CLI resume from blocked resets counters according to target", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "PLUG-211", "--route", "feature", "--json"]);

  const db = (host.bb.storage as any).database();
  const store = new DelegationStore(db);

  // Set counters and blocked status at checks
  store.transitionTask({
    taskKey: "PLUG-211",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "checks",
    toStatus: "blocked",
    actor: "checks-runner",
    reason: "3 failed test rounds",
    updates: {
      code_attempts: 3,
      check_attempts: 3,
      code_review_rounds: 1,
    },
  });

  // Resume to release from unverified checks -> rejected!
  const resInvalid = await host.harness.runCli([
    "resume",
    "PLUG-211",
    "--target",
    "release",
    "--json",
  ]);
  assert.equal(resInvalid.exitCode, 1);
  assert.equal(JSON.parse(resInvalid.stdout).error.code, "target-invalid");

  // Resume to code -> resets code_attempts, check_attempts
  const resResume = await host.harness.runCli([
    "resume",
    "PLUG-211",
    "--target",
    "code",
    "--json",
  ]);
  assert.equal(resResume.exitCode, 0);
  const data = JSON.parse(resResume.stdout);
  assert.equal(data.task.node, "code");
  assert.equal(data.task.status, "running");
  assert.equal(data.task.code_attempts, 0);
  assert.equal(data.task.check_attempts, 0);

  // Resume without --target from spec/blocked on docs route -> targets spec (not code)
  await host.harness.runCli(["enqueue", "DOCS-1", "--route", "docs", "--json"]);
  store.transitionTask({
    taskKey: "DOCS-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "spec",
    toStatus: "blocked",
    actor: "spec-runner",
    reason: "3 failed spec rounds",
    updates: {
      spec_attempts: 3,
    },
  });
  const resDocsResume = await host.harness.runCli([
    "resume",
    "DOCS-1",
    "--json",
  ]);
  assert.equal(resDocsResume.exitCode, 0);
  const docsData = JSON.parse(resDocsResume.stdout);
  assert.equal(docsData.task.node, "spec");
  assert.equal(docsData.task.status, "running");
  assert.equal(docsData.task.spec_attempts, 0);
});

test("CLI run-queue --once reports queue statistics and dependencies", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "DEP-1", "--json"]);
  await host.harness.runCli([
    "enqueue",
    "TASK-MAIN",
    "--depends-on",
    "DEP-1",
    "--json",
  ]);

  const res = await host.harness.runCli(["run-queue", "--once", "--json"]);
  assert.equal(res.exitCode, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.queuedCount, 2);
  // DEP-1 has no dependencies so readyCount = 1, TASK-MAIN depends on DEP-1 which is queued (not done)
  assert.equal(data.readyCount, 1);
});

test("Strict workGraph mode blocks direct delegate, merge, release", async () => {
  const host = await hostWith({ workGraph: "strict" });

  // 1. Direct delegate of un-enqueued task fails with graph-required
  const resDelUnk = await host.harness.runCli([
    "delegate",
    "UNENQUEUED-1",
    "--level",
    "simple",
    "--json",
  ]);
  assert.equal(resDelUnk.exitCode, 1);
  assert.equal(JSON.parse(resDelUnk.stdout).error.code, "graph-required");

  // 2. Direct delegate of active queued task fails with graph-managed
  await host.harness.runCli(["enqueue", "PLUG-220", "--json"]);
  const resDelActive = await host.harness.runCli([
    "delegate",
    "PLUG-220",
    "--level",
    "simple",
    "--json",
  ]);
  assert.equal(resDelActive.exitCode, 1);
  assert.equal(JSON.parse(resDelActive.stdout).error.code, "graph-managed");
  assert.match(
    JSON.parse(resDelActive.stdout).error.message,
    /управляется графом/,
  );

  // 3. Direct merge of un-enqueued task fails with graph-required
  const resMerge = await host.harness.runCli([
    "merge",
    "UNENQUEUED-2",
    "--json",
  ]);
  assert.equal(resMerge.exitCode, 1);
  assert.equal(JSON.parse(resMerge.stdout).error.code, "graph-required");

  // 4. Direct release of un-enqueued task fails with graph-required
  const resRelease = await host.harness.runCli([
    "release",
    "UNENQUEUED-3",
    "--json",
  ]);
  assert.equal(resRelease.exitCode, 1);
  assert.equal(JSON.parse(resRelease.stdout).error.code, "graph-required");
});

test("When workGraph is off, queue commands reject with graph-disabled", async () => {
  const host = await hostWith({ workGraph: "off" });
  const res = await host.harness.runCli(["enqueue", "PLUG-230", "--json"]);
  assert.equal(res.exitCode, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "graph-disabled");
});

test("Archive tags create true git refs refs/tags/archive/<KEY>-... in real repository", async () => {
  const originDir = makeTempDir("real-git-origin-");
  const repoDir = makeTempDir("real-git-repo-");
  const cmd = createCmd();
  await cmd.run("git", ["init", "--bare", originDir]);
  await cmd.run("git", ["init", repoDir]);
  await cmd.run("git", ["-C", repoDir, "config", "user.name", "Tester"]);
  await cmd.run("git", ["-C", repoDir, "config", "user.email", "tester@test.com"]);
  await cmd.run("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"]);
  await cmd.run("git", ["-C", repoDir, "branch", "-M", "main"]);
  await cmd.run("git", ["-C", repoDir, "remote", "add", "origin", originDir]);
  await cmd.run("git", ["-C", repoDir, "push", "-u", "origin", "main"]);
  await cmd.run("git", ["-C", repoDir, "checkout", "-b", "bb/plug-real-branch"]);
  await cmd.run("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "feature-work"]);
  await cmd.run("git", ["-C", repoDir, "checkout", "main"]);

  // Force-reset archiving
  const resReset = await checkAndPrepareTaskBranch(
    cmd,
    repoDir,
    "bb/plug-real-branch",
    "PLUG-REAL",
    "main",
    true,
  );
  assert.equal(resReset.ok, true);
  assert.equal(resReset.action, "force-reset-archived");

  // Verify true refs with git for-each-ref
  const refsReset = await cmd.run("git", ["-C", repoDir, "for-each-ref", "--format=%(refname)"]);
  const allRefsReset = refsReset.stdout.split("\n").filter(Boolean);
  const foundResetTag = allRefsReset.find((r) => r.startsWith("refs/tags/archive/PLUG-REAL-force-reset-"));
  assert.ok(foundResetTag, `must have true ref refs/tags/archive/PLUG-REAL-force-reset-...; found: ${allRefsReset.join(", ")}`);
  assert.ok(!allRefsReset.some((r) => r.includes("refs/tags/refs/tags/")), "must NOT have duplicated refs/tags/ prefix");

  // Dequeue archiving
  await cmd.run("git", ["-C", repoDir, "checkout", "-b", "bb/plug-real-dequeue"]);
  await cmd.run("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "dequeue-work"]);
  await cmd.run("git", ["-C", repoDir, "checkout", "main"]);
  await archiveAndCleanupTaskBranch(cmd, repoDir, "bb/plug-real-dequeue", "PLUG-REAL");

  const refsDequeue = await cmd.run("git", ["-C", repoDir, "for-each-ref", "--format=%(refname)"]);
  const allRefsDequeue = refsDequeue.stdout.split("\n").filter(Boolean);
  const foundCancelTag = allRefsDequeue.find((r) => r.startsWith("refs/tags/archive/PLUG-REAL-cancelled-"));
  assert.ok(foundCancelTag, `must have true ref refs/tags/archive/PLUG-REAL-cancelled-...; found: ${allRefsDequeue.join(", ")}`);
  assert.ok(!allRefsDequeue.some((r) => r.includes("refs/tags/refs/tags/")), "must NOT have duplicated refs/tags/ prefix");
});

test("Git network/remote errors during branch check throw git-failed", async () => {
  const fake = fakeCmd((file, args) => {
    const k = args.join(" ");
    if (k.includes("ls-remote")) {
      return { exitCode: 128, stdout: "", stderr: "fatal: remote origin unreachable" };
    }
    return undefined;
  });

  await assert.rejects(
    async () => {
      await checkAndPrepareTaskBranch(
        fake.cmd,
        "/tmp/fake-repo",
        "bb/test-err",
        "PLUG-ERR",
        "main",
        false,
      );
    },
    (err: any) => err.code === "git-failed" && /remote origin unreachable/.test(err.message),
  );
});

test("Squash-merged PR without commit in merge-base is verified via PR state and deleted", async () => {
  const prHeadSha = "deadbeef1234567890abcdef1234567890abcdef";
  const fake = fakeCmd((file, args) => {
    const k = `${file} ${args.join(" ")}`;
    if (k.includes("rev-parse --verify refs/heads/bb/squash-branch")) {
      return ok(prHeadSha);
    }
    if (k.includes("ls-remote")) {
      return ok("");
    }
    if (k.includes("merge-base --is-ancestor deadbeef origin/main")) {
      // Squash merge: commit is NOT an ancestor of origin/main
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    if (k.includes("gh pr list")) {
      return ok(
        JSON.stringify([
          {
            number: 42,
            state: "MERGED",
            headRefOid: prHeadSha,
          },
        ]),
      );
    }
    return undefined;
  });

  const res = await checkAndPrepareTaskBranch(
    fake.cmd,
    "/tmp/fake-repo",
    "bb/squash-branch",
    "PLUG-SQ",
    "main",
    false,
  );
  assert.equal(res.ok, true);
  assert.equal(res.action, "deleted-merged");

  // But if extra commit was pushed after PR was merged -> merge is NOT confirmed
  const fakeExtra = fakeCmd((file, args) => {
    const k = `${file} ${args.join(" ")}`;
    if (k.includes("rev-parse --verify refs/heads/bb/squash-branch")) {
      return ok("newcommit9999");
    }
    if (k.includes("ls-remote")) return ok("");
    if (k.includes("merge-base --is-ancestor newcommit9999 origin/main")) return { exitCode: 1, stdout: "", stderr: "" };
    if (k.includes("gh pr list")) {
      return ok(
        JSON.stringify([
          {
            number: 42,
            state: "MERGED",
            headRefOid: prHeadSha, // older sha than newcommit9999
          },
        ]),
      );
    }
    if (k.includes("merge-base --is-ancestor newcommit9999 deadbeef")) {
      // new commit is NOT ancestor of PR head
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    return undefined;
  });

  await assert.rejects(
    async () => {
      await checkAndPrepareTaskBranch(
        fakeExtra.cmd,
        "/tmp/fake-repo",
        "bb/squash-branch",
        "PLUG-SQ",
        "main",
        false,
      );
    },
    (err: any) => err.code === "unmerged-branch-exists",
  );
});

test("--acceptance resolves relative file against caller cwd and fails on missing path", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  const testDir = makeTempDir("acc-cwd-");
  const accFile = path.join(testDir, "contract.md");
  writeFileSync(accFile, "# Acceptance Criteria\nAll tests pass.");

  // Missing path fails with acceptance-missing
  const resMissing = await host.harness.runCli([
    "enqueue",
    "ACC-MISS",
    "--route",
    "fix",
    "--acceptance",
    "./nonexistent-contract.md",
    "--json",
  ], { cwd: testDir });
  assert.equal(resMissing.exitCode, 1);
  assert.equal(JSON.parse(resMissing.stdout).error.code, "acceptance-missing");
  assert.match(JSON.parse(resMissing.stdout).error.message, /nonexistent-contract\.md/);

  // Existing relative path resolves correctly
  const resOk = await host.harness.runCli([
    "enqueue",
    "ACC-OK",
    "--route",
    "fix",
    "--acceptance",
    "./contract.md",
    "--json",
  ], { cwd: testDir });
  assert.equal(resOk.exitCode, 0);
  const task = JSON.parse(resOk.stdout).task;
  const payload = JSON.parse(task.payload);
  assert.match(payload.acceptance_text, /All tests pass/);
});

test("Owner-only CLI commands reject caller with threadId in ctx", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "OWN-1", "--route", "feature", "--json"]);

  // 1. approve
  const resApprove = await host.harness.runCli(["approve", "OWN-1", "--json"], {
    threadId: "thr_agent",
  });
  assert.equal(resApprove.exitCode, 1);
  assert.equal(JSON.parse(resApprove.stdout).error.code, "permission-denied");

  // 2. defer
  const resDefer = await host.harness.runCli(["defer", "OWN-1", "--reason", "r", "--json"], {
    threadId: "thr_agent",
  });
  assert.equal(resDefer.exitCode, 1);
  assert.equal(JSON.parse(resDefer.stdout).error.code, "permission-denied");

  // 3. dequeue
  const resDequeue = await host.harness.runCli(["dequeue", "OWN-1", "--reason", "r", "--json"], {
    threadId: "thr_agent",
  });
  assert.equal(resDequeue.exitCode, 1);
  assert.equal(JSON.parse(resDequeue.stdout).error.code, "permission-denied");

  // 4. enqueue --mode
  const resMode = await host.harness.runCli(["enqueue", "OWN-MODE", "--mode", "manual", "--json"], {
    threadId: "thr_agent",
  });
  assert.equal(resMode.exitCode, 1);
  assert.equal(JSON.parse(resMode.stdout).error.code, "permission-denied");

  // 5. enqueue --acceptance
  const resAcc = await host.harness.runCli(["enqueue", "OWN-ACC", "--acceptance", "text", "--json"], {
    threadId: "thr_agent",
  });
  assert.equal(resAcc.exitCode, 1);
  assert.equal(JSON.parse(resAcc.stdout).error.code, "permission-denied");
});

test("Repeat defer on already deferred task rejects with invalid-status", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "DEF-REP", "--json"]);
  const res1 = await host.harness.runCli(["defer", "DEF-REP", "--reason", "hold1", "--json"]);
  assert.equal(res1.exitCode, 0);

  const res2 = await host.harness.runCli(["defer", "DEF-REP", "--reason", "hold2", "--json"]);
  assert.equal(res2.exitCode, 1);
  assert.equal(JSON.parse(res2.stdout).error.code, "invalid-status");
  assert.match(JSON.parse(res2.stdout).error.message, /уже отложена/);
});

test("reject requires --reason argument", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  await host.harness.runCli(["enqueue", "REJ-NOREASON", "--json"]);
  const res = await host.harness.runCli(["reject", "REJ-NOREASON", "--json"]);
  assert.equal(res.exitCode, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "missing-reason");
});

test("Blocker 1: commitAcceptanceContract failure stalls task without fake sha", async () => {
  const host = await hostWith({ workGraph: "strict" });
  const { cmd } = fakeCmd((file, args) => {
    if (file === "git" && args[0] === "hash-object") {
      return { exitCode: 1, stdout: "", stderr: "fatal: git error" };
    }
    return undefined;
  });
  const store = new DelegationStore(host.bb.storage.database());
  store.insertTask({
    taskKey: "FAIL-ACC",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    payload: JSON.stringify({ acceptance_text: "contract text" }),
  });
  await runRunQueue({ store, workGraphMode: "strict", cmd });
  const t = store.getTask("FAIL-ACC")!;
  assert.equal(t.status, "stalled");
  const transitions = store.listTransitions("FAIL-ACC");
  const lastTr = transitions[transitions.length - 1];
  assert.match(lastTr.reason, /git-failed/);
  assert.equal(t.acceptance_sha, null);
});

test("Blocker 2: resume --target from release/stalled requires pr_closed reason", async () => {
  const host = await hostWith({ workGraph: "shadow" });
  const store = new DelegationStore(host.bb.storage.database());
  await host.harness.runCli(["enqueue", "RES-PR", "--json"]);

  // Stalled with different reason (e.g. script failure)
  store.transitionTask({
    taskKey: "RES-PR",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "release",
    toStatus: "stalled",
    actor: "test",
    reason: "release failed",
    updates: { payload: JSON.stringify({ stalled_reason: "release_failed_script" }) },
  });

  const resOther = await host.harness.runCli(["resume", "RES-PR", "--target", "code", "--json"]);
  assert.equal(resOther.exitCode, 1);
  assert.equal(JSON.parse(resOther.stdout).error.code, "target-invalid");
  assert.match(JSON.parse(resOther.stdout).error.message, /pr_closed/);

  // Stalled with pr_closed
  store.updateTask("RES-PR", {
    payload: JSON.stringify({ stalled_reason: "pr_closed" }),
  });
  const resPr = await host.harness.runCli(["resume", "RES-PR", "--target", "code", "--json"]);
  assert.equal(resPr.exitCode, 0);
  const task = store.getTask("RES-PR")!;
  assert.equal(task.node, "code");
  assert.equal(task.status, "running");
});

test("Round 2 Blocker 1: active delegation #2 prevents advancing on stale delegation #1", async () => {
  const host = await hostWith({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();
  store.insertTask({
    taskKey: "STALE-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, now - 5000);
  // Transition task to code
  store.transitionTask({
    taskKey: "STALE-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now: now - 4000,
  }, now - 4000);

  // Delegation 1 (finished long ago with done)
  const d1 = store.insert({
    taskKey: "STALE-1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  store.setStatus(d1.id, "done");
  host.bb.storage.database().prepare("UPDATE delegations SET created_at = ?, result_sha = ?, result_commits = ? WHERE id = ?").run(now - 5000, "sha-stale-1", 1, d1.id);

  // Delegation 2 (currently active/dispatching)
  const d2 = store.insert({
    taskKey: "STALE-1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  host.bb.storage.database().prepare("UPDATE delegations SET created_at = ? WHERE id = ?").run(now - 1000, d2.id);

  // Run run-queue: must NOT advance code using d1's stale sha
  await runRunQueue({ store, workGraphMode: "strict" });
  const t = store.getTask("STALE-1")!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.result_sha, null);
});

test("Round 2 Blocker 2: review done without verdict does not auto-OK, code done without sha does not fake sha", async () => {
  const host = await hostWith({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();

  // Test A: Code done without result_sha triggers code_question_or_no_report without fake sha
  store.insertTask({
    taskKey: "NOSHA-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, now);
  store.transitionTask({
    taskKey: "NOSHA-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now,
  }, now);
  const dCode = store.insert({
    taskKey: "NOSHA-1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  // Worker finished without committing any sha
  store.setStatus(dCode.id, "done");
  host.bb.storage.database().prepare("UPDATE delegations SET result_sha = NULL, result_commits = 0 WHERE id = ?").run(dCode.id);

  await runRunQueue({ store, workGraphMode: "strict" });
  const tCode = store.getTask("NOSHA-1")!;
  assert.equal(tCode.node, "code");
  assert.equal(tCode.status, "running");
  assert.equal(tCode.result_sha, null);
  const codeTr = store.listTransitions("NOSHA-1").at(-1)!;
  assert.match(codeTr.reason, /without artifact/);

  // Test B: Review done without verdict does not auto-OK
  store.insertTask({
    taskKey: "NOVERD-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, now);
  store.transitionTask({
    taskKey: "NOVERD-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "review",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now,
  }, now);
  const dRev = store.insert({
    taskKey: "NOVERD-1",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review",
    preset: "review",
    provider: "opencode",
  });
  // Reviewer finished without JSON verdict line
  store.setStatus(dRev.id, "done");

  await runRunQueue({ store, workGraphMode: "strict" });
  const tRev = store.getTask("NOVERD-1")!;
  assert.equal(tRev.node, "review");
  assert.equal(tRev.status, "running");
  assert.notEqual(tRev.node, "release");
});

test("Round 2 Blocker 3: stalled delegation on checks/release does not spam transitions", async () => {
  const host = await hostWith({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();

  store.insertTask({
    taskKey: "NOFAIL-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, now);
  store.transitionTask({
    taskKey: "NOFAIL-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "release",
    toStatus: "running",
    actor: "run-queue",
    reason: "to-release",
    now,
  }, now);

  const d = store.insert({
    taskKey: "NOFAIL-1",
    coordinatorThreadId: "thr_coord",
    level: "release",
    route: "release",
    preset: "release",
    provider: "opencode",
  });
  store.setStatus(d.id, "stalled");

  const countBefore = store.listTransitions("NOFAIL-1").length;
  await runRunQueue({ store, workGraphMode: "strict" });
  const countAfter = store.listTransitions("NOFAIL-1").length;
  // Should NOT write any dummy design_failed transition
  assert.equal(countAfter, countBefore);
});

test("Round 3 Blocker 2 & Non-blockers 6-7: fallback verdict parsing with thread output and JSON fields", async () => {
  const customCli: BbCli = {
    run: async (args: string[]) => {
      const key = args.join(" ");
      if (key.includes("tasks show")) {
        // Return comments without verdict to trigger fallback to thread output
        return ok(
          JSON.stringify({
            comments: [
              {
                kind: "agent",
                threadId: "thr_rev_1",
                body: "Running review checks in progress...",
              },
            ],
          }),
        );
      }
      if (key.includes("thread output thr_rev_1")) {
        // Return JSON verdict in thread output with target: design and formatted JSON
        return ok(
          JSON.stringify({
            output: 'Review finished with changes needed:\n{ "verdict": "CHANGES", "blockers": 2, "target": "design" }\nDone.',
          }),
        );
      }
      return ok();
    },
  };

  const host = await hostWith({ workGraph: "strict" }, customCli);
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();

  store.insertTask({
    taskKey: "VERD-FALLBACK",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  }, now);
  store.transitionTask({
    taskKey: "VERD-FALLBACK",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design_check",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now,
  }, now);

  const d = store.insert({
    taskKey: "VERD-FALLBACK",
    coordinatorThreadId: "thr_coord",
    level: "architect",
    route: "feature",
    preset: "architect",
    provider: "opencode",
  });
  store.setStatus(d.id, "done");
  host.bb.storage.database().prepare("UPDATE delegations SET thread_id = ? WHERE id = ?").run("thr_rev_1", d.id);

  await runRunQueue({ store, workGraphMode: "strict", bbCli: customCli });
  const t = store.getTask("VERD-FALLBACK")!;
  // target: "design" routes CHANGES to design node
  assert.equal(t.node, "design");
  assert.equal(t.status, "running");
});

test("Round 3 Blocker 3 & 4: no-verdict and code no-sha transitions are nudged once and not spammed", async () => {
  const host = await hostWith({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();

  store.insertTask({
    taskKey: "NUDGE-ONCE",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, now);
  store.transitionTask({
    taskKey: "NUDGE-ONCE",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now,
  }, now);

  const d = store.insert({
    taskKey: "NUDGE-ONCE",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  store.setStatus(d.id, "done");
  host.bb.storage.database().prepare("UPDATE delegations SET result_sha = NULL, result_commits = 0 WHERE id = ?").run(d.id);

  // Tick 1: should record 1 transition for code_question_or_no_report
  await runRunQueue({ store, workGraphMode: "strict" });
  const count1 = store.listTransitions("NUDGE-ONCE").length;
  assert.ok(count1 > 1); // start transition + code_question transition

  // Tick 2: delegation is already nudged, must NOT write duplicate self-transitions
  await runRunQueue({ store, workGraphMode: "strict" });
  const count2 = store.listTransitions("NUDGE-ONCE").length;
  assert.equal(count2, count1, "Repeated tick must not spam self-transitions");
});

test("Round 3 Blocker 5: resume from stalled does not immediately re-stall on next tick", async () => {
  const host = await hostWith({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();

  store.insertTask({
    taskKey: "RESUME-STALL",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, now - 5000);
  store.transitionTask({
    taskKey: "RESUME-STALL",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now: now - 4000,
  }, now - 4000);

  // Delegation fails
  const d = store.insert({
    taskKey: "RESUME-STALL",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  store.setStatus(d.id, "stalled");

  // Tick 1: task transitions to stalled because of failed delegation
  await runRunQueue({ store, workGraphMode: "strict" });
  let t = store.getTask("RESUME-STALL")!;
  assert.equal(t.status, "stalled");

  // User resumes the task back to running
  await runResume("RESUME-STALL", undefined, {
    store,
    ctx: { cwd: "/tmp/fake-repo" } as any,
    workGraphMode: "strict",
    now: () => now,
  });
  t = store.getTask("RESUME-STALL")!;
  assert.equal(t.status, "running");

  // Tick 2: runRunQueue must NOT immediately re-stall from the old delegation!
  await runRunQueue({ store, workGraphMode: "strict" });
  t = store.getTask("RESUME-STALL")!;
  assert.equal(t.status, "running", "Task should remain running after resume, not re-stall");
});

test("Round 4 Blocker 1: review done without verdict receives nudge, and late verdict response advances task", async () => {
  let threadOutput = "";
  const customCli: BbCli = {
    run: async (args: string[]) => {
      const key = args.join(" ");
      if (key.includes("tasks show")) {
        return ok(JSON.stringify({ comments: [] }));
      }
      if (key.includes("thread output thr_rev_late")) {
        return ok(JSON.stringify({ output: threadOutput }));
      }
      return ok();
    },
  };

  const host = await hostWith({ workGraph: "strict" }, customCli);
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();

  store.insertTask({
    taskKey: "LATE-VERD",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, now);
  store.transitionTask({
    taskKey: "LATE-VERD",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "review",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now,
  }, now);

  const d = store.insert({
    taskKey: "LATE-VERD",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review",
    preset: "review",
    provider: "opencode",
  });
  store.setStatus(d.id, "done");
  host.bb.storage.database().prepare("UPDATE delegations SET thread_id = ? WHERE id = ?").run("thr_rev_late", d.id);

  // Tick 1: reviewer finished without verdict -> nudge transition, stays in review
  await runRunQueue({ store, workGraphMode: "strict", bbCli: customCli });
  let t = store.getTask("LATE-VERD")!;
  assert.equal(t.node, "review");
  assert.equal(t.status, "running");

  // Reviewer now replies with verdict OK
  threadOutput = 'Completed review successfully:\n{ "verdict": "OK", "blockers": 0 }\nAll tests pass.';

  // Tick 2: runRunQueue must read late verdict and advance task to release
  await runRunQueue({ store, workGraphMode: "strict", bbCli: customCli });
  t = store.getTask("LATE-VERD")!;
  assert.equal(t.node, "release");
  assert.equal(t.status, "running");
});

test("Round 4 Blocker 2: failEvent triggers for quota and cancelled delegations", async () => {
  const host = await hostWith({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();

  // Test A: Quota delegation
  store.insertTask({
    taskKey: "QUOTA-TASK",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, now);
  store.transitionTask({
    taskKey: "QUOTA-TASK",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now,
  }, now);
  const dQuota = store.insert({
    taskKey: "QUOTA-TASK",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  store.setStatus(dQuota.id, "quota");

  await runRunQueue({ store, workGraphMode: "strict" });
  const tQuota = store.getTask("QUOTA-TASK")!;
  assert.equal(tQuota.status, "stalled");

  // Test B: Cancelled delegation
  store.insertTask({
    taskKey: "CANCEL-TASK",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  }, now);
  store.transitionTask({
    taskKey: "CANCEL-TASK",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "code",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now,
  }, now);
  const dCancel = store.insert({
    taskKey: "CANCEL-TASK",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "opencode",
  });
  store.setStatus(dCancel.id, "cancelled");

  await runRunQueue({ store, workGraphMode: "strict" });
  const tCancel = store.getTask("CANCEL-TASK")!;
  assert.equal(tCancel.status, "stalled");
});

test("Round 4 Blocker 3: design node extracts architect report and commits acceptance contract; missing report nudges", async () => {
  let architectReport = "";
  const customCli: BbCli = {
    run: async (args: string[]) => {
      const key = args.join(" ");
      if (key.includes("tasks show")) {
        return ok(JSON.stringify({ comments: [] }));
      }
      if (key.includes("thread output thr_arch_1")) {
        return ok(JSON.stringify({ output: architectReport }));
      }
      return ok();
    },
  };

  const { cmd } = fakeCmd();
  const host = await hostWith({ workGraph: "strict" }, customCli, cmd);
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();

  store.insertTask({
    taskKey: "ARCH-REPORT",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
    branch: "bb/ARCH-REPORT-feature",
  }, now);
  store.transitionTask({
    taskKey: "ARCH-REPORT",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now,
  }, now);

  const d = store.insert({
    taskKey: "ARCH-REPORT",
    coordinatorThreadId: "thr_coord",
    level: "architect",
    route: "feature",
    preset: "architect",
    provider: "opencode",
  });
  store.setStatus(d.id, "done");
  host.bb.storage.database().prepare("UPDATE delegations SET thread_id = ? WHERE id = ?").run("thr_arch_1", d.id);

  // Case A: done without report -> triggers design_question_or_no_report
  await runRunQueue({ store, workGraphMode: "strict", bbCli: customCli, cmd });
  let t = store.getTask("ARCH-REPORT")!;
  assert.equal(t.node, "design");
  assert.equal(t.status, "running");
  const tr = store.listTransitions("ARCH-REPORT").at(-1)!;
  assert.match(tr.reason, /question without report/);

  // Case B: architect delivers report
  architectReport = "# Acceptance Contract\n\n1. Project must build\n2. Tests must pass\n";
  await runRunQueue({ store, workGraphMode: "strict", bbCli: customCli, cmd });
  t = store.getTask("ARCH-REPORT")!;
  assert.equal(t.node, "spec");
  assert.equal(t.status, "running");
  assert.ok(t.acceptance_sha);
});

test("Round 5 Blocker 1: design_check preserves blockers count and prevents OK when blockers > 0", async () => {
  let threadOutput = "";
  const customCli: BbCli = {
    run: async (args: string[]) => {
      const key = args.join(" ");
      if (key.includes("tasks show")) {
        return ok(JSON.stringify({ comments: [] }));
      }
      if (key.includes("thread output thr_arch_chk")) {
        return ok(JSON.stringify({ output: threadOutput }));
      }
      return ok();
    },
  };

  const host = await hostWith({ workGraph: "strict" }, customCli);
  const store = new DelegationStore(host.bb.storage.database());
  const now = Date.now();

  // Test A: verdict OK with blockers: 2 must NOT advance to release, but route to code (round 1)
  store.insertTask({
    taskKey: "DC-BLOCKERS",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  }, now);
  store.transitionTask({
    taskKey: "DC-BLOCKERS",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "design_check",
    toStatus: "running",
    actor: "run-queue",
    reason: "start",
    now,
  }, now);

  const d1 = store.insert({
    taskKey: "DC-BLOCKERS",
    coordinatorThreadId: "thr_coord",
    level: "architect",
    route: "feature",
    preset: "architect",
    provider: "opencode",
  });
  store.setStatus(d1.id, "done");
  host.bb.storage.database().prepare("UPDATE delegations SET thread_id = ? WHERE id = ?").run("thr_arch_chk", d1.id);

  threadOutput = 'Design check finished:\n{ "verdict": "OK", "blockers": 2 }\nNeeds fix.';
  await runRunQueue({ store, workGraphMode: "strict", bbCli: customCli });

  let t = store.getTask("DC-BLOCKERS")!;
  // Must NOT be release! Must be code due to blockers > 0
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.design_check_rounds, 1);

  // Test B: verdict OK with blockers: 0 advances to release
  store.transitionTask({
    taskKey: "DC-BLOCKERS",
    expectedNode: "code",
    expectedStatus: "running",
    toNode: "design_check",
    toStatus: "running",
    actor: "test",
    reason: "back to design_check",
    now: Date.now(),
  }, Date.now());

  const d2 = store.insert({
    taskKey: "DC-BLOCKERS",
    coordinatorThreadId: "thr_coord",
    level: "architect",
    route: "feature",
    preset: "architect",
    provider: "opencode",
  });
  store.setStatus(d2.id, "done");
  host.bb.storage.database().prepare("UPDATE delegations SET thread_id = ? WHERE id = ?").run("thr_arch_chk", d2.id);

  threadOutput = 'Design check finished:\n{ "verdict": "OK", "blockers": 0 }\nAll clean.';
  await runRunQueue({ store, workGraphMode: "strict", bbCli: customCli });

  t = store.getTask("DC-BLOCKERS")!;
  assert.equal(t.node, "release");
  assert.equal(t.status, "running");
});

test("§34.3 (ADR-0037): buildChecksEnvironment allows only whitelisted env vars and rejects secret keys in extraEnvVars", () => {
  const fakeEnv = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    USER: "alice",
    SECRET_TOKEN: "super-secret-123",
    AWS_SECRET_KEY: "secret-key",
    CI: "true",
  };

  const clean = buildChecksEnvironment(["APP_PORT", "DATABASE_URL"], DEFAULT_ALLOWED_ENV_VARS, fakeEnv as any);
  assert.equal(clean.PATH, "/usr/bin");
  assert.equal(clean.HOME, "/home/user");
  assert.equal(clean.CI, "true");
  assert.equal(clean.SECRET_TOKEN, undefined);
  assert.equal(clean.AWS_SECRET_KEY, undefined);

  // Forbidden extra env vars
  assert.throws(
    () => buildChecksEnvironment(["GITHUB_TOKEN"], DEFAULT_ALLOWED_ENV_VARS, fakeEnv as any),
    (e: any) => e.code === "checks-invalid-env" && e.message.includes("TOKEN"),
  );
  assert.throws(
    () => buildChecksEnvironment(["AWS_KEY"], DEFAULT_ALLOWED_ENV_VARS, fakeEnv as any),
    (e: any) => e.code === "checks-invalid-env" && e.message.includes("KEY"),
  );
  assert.throws(
    () => buildChecksEnvironment(["DB_PASSWORD"], DEFAULT_ALLOWED_ENV_VARS, fakeEnv as any),
    (e: any) => e.code === "checks-invalid-env" && e.message.includes("PASSWORD"),
  );
  assert.throws(
    () => buildChecksEnvironment(["APP_SECRET"], DEFAULT_ALLOWED_ENV_VARS, fakeEnv as any),
    (e: any) => e.code === "checks-invalid-env" && e.message.includes("SECRET"),
  );
  assert.throws(
    () => buildChecksEnvironment(["USER_CREDENTIAL"], DEFAULT_ALLOWED_ENV_VARS, fakeEnv as any),
    (e: any) => e.code === "checks-invalid-env" && e.message.includes("CREDENTIAL"),
  );
});

test("§34.4 (ADR-0037): Queue stall alarm sets node_alarm_at on enqueue and triggers alarm in run-queue", async () => {
  const host = createFakePluginHost();
  const db = host.bb.storage.database();
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const t0 = 1000000;
  const enq = await runEnqueue(
    { taskKey: "STALL-1", route: "research", level: "research", dependsOn: "BLOCKER-1" },
    { store, ctx: { projectId: "p1" }, workGraphMode: "strict", now: () => t0 },
  );
  assert.equal(enq.ok, true);
  const t = store.getTask("STALL-1")!;
  assert.equal(t.status, "queued");
  assert.equal(t.node_alarm_at, t0 + 30 * 60_000);

  // Fast-forward time past alarm
  const t1 = t0 + 31 * 60_000;
  await runRunQueue({ store, workGraphMode: "strict", now: () => t1, maxActiveTasks: 0 }); // 0 slots so it stays queued
  const updated = store.getTask("STALL-1")!;
  assert.equal(updated.status, "queued");
  const p = JSON.parse(updated.payload!);
  assert.equal(p.queued_stalled, true);

  const events = store.listEvents("task.alarm_triggered");
  assert.ok(events.some((e) => e.payload?.includes("queued-stalled") && e.payload?.includes("STALL-1")));
});

test("§34.5 (ADR-0037): TDD Fail-First Verification detects vacuous contracts", async () => {
  const taskVacuous: any = {
    task_key: "VAC-1",
    payload: JSON.stringify({ mock_acceptance_vacuous: true }),
  };
  const resVac = await runTddFailFirstVerification({}, taskVacuous, "sha1");
  assert.equal(resVac.failedAsExpected, false);
  assert.ok(resVac.output?.includes("acceptance-contract-vacuous"));

  const taskRed: any = {
    task_key: "RED-1",
    payload: JSON.stringify({ mock_acceptance_red: true }),
  };
  const resRed = await runTddFailFirstVerification({}, taskRed, "sha1");
  assert.equal(resRed.failedAsExpected, true);
});

test("§34.6 (ADR-0037): formatDesignCheckPacket creates structured markdown", () => {
  const packet = formatDesignCheckPacket({
    taskKey: "ARCH-1",
    acceptanceText: "- Test 1\n- Test 2",
    netDiff: "+ line added",
    checksRunJson: '{"exitCode":0}',
    reviewVerdict: "OK",
  });
  assert.ok(packet.includes("ARCH-1"));
  assert.ok(packet.includes("## 1. Договор приёмки"));
  assert.ok(packet.includes("## 2. Нетто-дифф реализации"));
  assert.ok(packet.includes("## 3. Протокол машинных проверок"));
  assert.ok(packet.includes("## 4. Отчёт код-ревью"));
  assert.ok(packet.includes('{"verdict":"OK"|"CHANGES"'));
});

test("§34.5 (ADR-0037): Rule 81 end-to-end via runRunQueue on spec_review with vacuous contract", async () => {
  const host = createFakePluginHost();
  const db = host.bb.storage.database();
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  await runEnqueue(
    { taskKey: "FEAT-VAC-1", route: "feature" },
    { store, ctx: { projectId: "p1" }, workGraphMode: "strict" },
  );
  store.transitionTask({
    taskKey: "FEAT-VAC-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "spec_review",
    toStatus: "running",
    actor: "test",
    reason: "test jump to spec_review",
    updates: { acceptance_sha: "acc-sha-123" },
  });

  const del = store.insert({
    taskKey: "FEAT-VAC-1",
    projectId: "p1",
    coordinatorThreadId: "coord-1",
    level: "review",
    route: "review-route",
    preset: "p-review",
    provider: "test-prov",
    round: 1,
  });
  store.setStatus(del.id, "done");
  store.updateTask("FEAT-VAC-1", {
    payload: JSON.stringify({
      spec_review_verdict: "OK",
      spec_review_blockers: 0,
    }),
  });

  let tddCalls = 0;
  // 1st time: TDD verification detects vacuous contract -> Rule 81 returns to design
  await runRunQueue({
    store,
    workGraphMode: "strict",
    runTddCheck: async () => {
      tddCalls++;
      return { ok: true, failedAsExpected: false, output: "acceptance-contract-vacuous" };
    },
  });

  assert.equal(tddCalls, 1);
  const taskAfterRule81 = store.getTask("FEAT-VAC-1")!;
  assert.equal(taskAfterRule81.node, "design");
  assert.equal(taskAfterRule81.status, "running");
  assert.equal(taskAfterRule81.design_check_rounds, 1);

  // Advance design -> spec -> spec_review again with design_check_rounds: 2
  store.updateTask("FEAT-VAC-1", {
    design_check_rounds: 2,
    payload: JSON.stringify({
      spec_review_verdict: "OK",
      spec_review_blockers: 0,
    }),
  });
  store.transitionTask({
    taskKey: "FEAT-VAC-1",
    expectedNode: "design",
    expectedStatus: "running",
    toNode: "spec_review",
    toStatus: "running",
    actor: "test",
    reason: "fast forward to spec_review round 3",
  });

  // 2nd time: reaches ceiling design_check_rounds = 3 -> transitions to blocked
  await runRunQueue({
    store,
    workGraphMode: "strict",
    runTddCheck: async () => ({ ok: true, failedAsExpected: false, output: "acceptance-contract-vacuous" }),
  });

  const taskBlocked = store.getTask("FEAT-VAC-1")!;
  assert.equal(taskBlocked.status, "blocked");
  assert.equal(taskBlocked.design_check_rounds, 3);
});

test("§34.5 (ADR-0037): Rule 82 end-to-end via runRunQueue on fix route and owner_gate handling", async () => {
  const host = createFakePluginHost();
  const db = host.bb.storage.database();
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  // 1. Enqueue in manual mode with a mock cmd that simulates branch creation
  const mockCmd = {
    run: async (cmd: string, args: string[]) => ({
      exitCode: 0,
      stdout: "1234567\n",
      stderr: "",
    }),
  } as any;

  await runEnqueue(
    { taskKey: "FIX-VAC-1", route: "fix", mode: "manual", acceptance: "- initial vacuous acceptance" },
    {
      store,
      ctx: { projectId: "p1" },
      workGraphMode: "strict",
      cmd: mockCmd,
      repoRoot: "/fake/repo",
    },
  );

  const initialTask = store.getTask("FIX-VAC-1")!;
  assert.equal(initialTask.status, "queued");

  // 2. runRunQueue takes task, runs TDD check, detects vacuous contract -> triggers Rule 82
  await runRunQueue({
    store,
    workGraphMode: "strict",
    cmd: mockCmd,
    repoRoot: "/fake/repo",
    runTddCheck: async () => ({ ok: true, failedAsExpected: false, output: "acceptance-contract-vacuous" }),
  });

  const taskAfterRule82 = store.getTask("FIX-VAC-1")!;
  assert.equal(taskAfterRule82.node, "owner_gate");
  assert.equal(taskAfterRule82.status, "waiting_approval");
  assert.equal(taskAfterRule82.check_attempts, 1);
  const p1 = JSON.parse(taskAfterRule82.payload!);
  assert.equal(p1.vacuous_contract, true);
  assert.equal(p1.gate_stage, "pre_code");

  // 3. runApprove while vacuous_contract is true must throw
  await assert.rejects(
    async () => runApprove("FIX-VAC-1", "approve anyway", { store, ctx: { projectId: "p1" }, workGraphMode: "strict" }),
    (e: any) => e.code === "acceptance-contract-vacuous",
  );

  // 4. Update acceptance via runEnqueue: still vacuous -> triggers Rule 82 on owner_gate, attempts = 2
  await runEnqueue(
    { taskKey: "FIX-VAC-1", acceptance: "- second try still vacuous" },
    {
      store,
      ctx: { projectId: "p1" },
      workGraphMode: "strict",
      cmd: mockCmd,
      repoRoot: "/fake/repo",
      runTddCheck: async () => ({ ok: true, failedAsExpected: false }),
    },
  );
  const taskSecondVac = store.getTask("FIX-VAC-1")!;
  assert.equal(taskSecondVac.node, "owner_gate");
  assert.equal(taskSecondVac.status, "waiting_approval");
  assert.equal(taskSecondVac.check_attempts, 2);
  const p2 = JSON.parse(taskSecondVac.payload!);
  assert.equal(p2.vacuous_contract, true);

  // 5. Update acceptance with failing tests (failedAsExpected: true) -> clears vacuous_contract
  await runEnqueue(
    { taskKey: "FIX-VAC-1", acceptance: "- proper failing tests" },
    {
      store,
      ctx: { projectId: "p1" },
      workGraphMode: "strict",
      cmd: mockCmd,
      repoRoot: "/fake/repo",
      runTddCheck: async () => ({ ok: true, failedAsExpected: true, output: "tests failed as expected" }),
    },
  );
  const taskFixed = store.getTask("FIX-VAC-1")!;
  assert.equal(taskFixed.node, "owner_gate");
  assert.equal(taskFixed.status, "waiting_approval");
  const p3 = JSON.parse(taskFixed.payload!);
  assert.equal(p3.vacuous_contract, undefined);

  // 6. Now runApprove succeeds and moves to code
  const approved = await runApprove("FIX-VAC-1", "approved", {
    store,
    ctx: { projectId: "p1" },
    workGraphMode: "strict",
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.task.node, "code");
  assert.equal(approved.task.status, "running");
});

test("§34.3 & §34.4 (ADR-0037): parsePolicy parses checks config and queueStallMinutes bounds", () => {
  const pValid = parsePolicy(JSON.stringify({
    version: 1,
    timing: { queueStallMinutes: 120 },
    checks: {
      timeout_seconds: 900,
      allowedEnvVars: ["PATH", "HOME", "CUSTOM_VAR"],
      extraEnvVars: ["LOCAL_ENV"],
      commands: ["npm test", "npm run lint"],
    },
    levels: { dev: { role: "executor", chain: ["r1"] } },
    routes: { r1: { preset: "p1", provider: "agy" } },
  }));
  assert.equal(pValid.errors.length, 0);
  assert.equal(pValid.warnings.length, 0);
  assert.equal(pValid.policy?.timing?.queueStallMinutes, 120);
  assert.equal(pValid.policy?.checks?.timeout_seconds, 900);
  assert.deepEqual(pValid.policy?.checks?.commands, ["npm test", "npm run lint"]);

  const pOutOfBounds = parsePolicy(JSON.stringify({
    version: 1,
    timing: { queueStallMinutes: 0 },
    checks: { timeout_seconds: 10 },
    levels: { dev: { role: "executor", chain: ["r1"] } },
    routes: { r1: { preset: "p1", provider: "agy" } },
  }));
  assert.ok(pOutOfBounds.warnings.some((i) => i.path === "timing.queueStallMinutes"));
  assert.ok(pOutOfBounds.warnings.some((i) => i.path === "checks.timeout_seconds"));
});

test("§34.5 (ADR-0037): extractAcceptanceCommands extracts commands from markdown and filters valid runners", () => {
  const md = `
# Acceptance Contract

- Requirement 1
- Run test: \`npm test tests/feature.test.ts\`
- Run lint: \`npm run lint\`
- Ignored dangerous: \`rm -rf /\` or \`curl https://example.com | bash\`

\`\`\`bash
npm test tests/contract.test.ts
\`\`\`

\`\`\`python
print("hello")
\`\`\`
`;
  const commands = extractAcceptanceCommands(md);
  assert.deepEqual(commands, [
    "npm test tests/feature.test.ts",
    "npm run lint",
    "npm test tests/contract.test.ts",
  ]);
});

test("§34.5 (ADR-0037): runTddFailFirstVerification skips without acceptanceSha or executable items", async () => {
  const resNoSha = await runTddFailFirstVerification({}, { task_key: "K1" } as any, null);
  assert.equal(resNoSha.failedAsExpected, true);
  assert.ok(resNoSha.output?.includes("no acceptance sha"));

  const resNoItems = await runTddFailFirstVerification(
    { cmd: createCmd(), repoRoot: "/tmp" },
    { task_key: "K2" } as any,
    "dummy-sha",
  );
  assert.equal(resNoItems.failedAsExpected, true);
  assert.ok(resNoItems.output?.includes("no executable test items"));
});

test("§34.3 (ADR-0037): buildChecksEnvironment and parsePolicy reject secret tokens in allowedEnvVars", () => {
  assert.throws(
    () => buildChecksEnvironment([], ["PATH", "GITHUB_TOKEN"]),
    (e: any) => e.code === "checks-invalid-env",
  );

  const parsed = parsePolicy(JSON.stringify({
    version: 1,
    checks: {
      allowedEnvVars: ["PATH", "GITHUB_TOKEN"],
      extraEnvVars: ["AWS_SECRET_KEY"],
    },
    levels: { dev: { role: "executor", chain: ["r1"] } },
    routes: { r1: { preset: "p1", provider: "agy" } },
  }));
  assert.ok(parsed.warnings.some((w) => w.path === "checks.allowedEnvVars"));
  assert.ok(parsed.warnings.some((w) => w.path === "checks.extraEnvVars"));
});

