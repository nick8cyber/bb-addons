import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import { type CmdRunner } from "../src/cmd.js";
import { makeTempDir } from "./helpers/temp.js";
import { OrchestratorError } from "../src/errors.js";
import { runRunQueue } from "../src/workgraph.js";
import { verifySpecBeforeCodeGate } from "../src/spec-gate.js";

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
                key: args[2] ?? "PLUG-414",
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
      run: async (file: string, args: string[]): Promise<BbCliResult> => {
        calls.push({ file, args });
        const res = overrides?.(file, args);
        if (res) return res;
        const key = `${file} ${args.join(" ")}`;
        if (key.includes("rev-parse --show-toplevel")) {
          return ok("/tmp/fake-repo");
        }
        if (
          key.includes("rev-parse --verify origin/main") ||
          key.includes("rev-parse --verify refs/remotes/origin/main") ||
          key.includes("rev-parse --verify --quiet origin/main") ||
          key.includes("rev-parse origin/main") ||
          key.includes("rev-parse HEAD")
        ) {
          return ok("0000000000000000000000000000000000000001");
        }
        if (file === "git" && args[0] === "remote") {
          return ok("origin\n");
        }
        if (key.includes("rev-parse --verify")) {
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
  prProvider?: any,
) {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-reroute-"),
    settings: {
      policy: POLICY_TEXT,
      language: "ru",
      workGraph: "strict",
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
    prProvider,
  });
  const origRunCli = host.harness.runCli.bind(host.harness);
  host.harness.runCli = (argv, ctx = {}) => {
    return origRunCli(argv, { cwd: "/tmp/fake-repo", ...ctx });
  };
  return host;
}

// ── 1. Success in strict mode (CLI & RPC) ──────────────────────────────────

test("§29.9: success in strict mode via CLI (route = 'feature', node = 'start', status = 'queued')", async () => {
  const fake = fakeCmd();
  const host = await hostWith({ workGraph: "strict" }, fakeCli().cli, fake.cmd);
  const store = new DelegationStore(host.bb.storage.database());

  store.setThreadRole("thr_coord_1", "orchestrator", "owner");
  store.insertTask({
    taskKey: "PLUG-426-S1",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord_1",
    route: "fix",
    level: "simple",
    priority: 100,
    confirmationMode: "auto",
  });
  // Simulate task stalled at start
  store.updateTask("PLUG-426-S1", { node: "start", status: "stalled" });

  const sentMessages: string[] = [];
  host.harness.sdk.stub("threads.send", async (args: any) => {
    if (args.input?.[0]?.text) sentMessages.push(args.input[0].text);
    return { id: "msg_1" };
  });

  const res = await host.harness.runCli(
    [
      "reroute",
      "PLUG-426-S1",
      "--route",
      "feature",
      "--reason",
      "требуется спека и дизайн",
      "--json",
    ],
    { threadId: "thr_coord_1" },
  );

  assert.equal(res.exitCode, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.task.route, "feature");
  assert.equal(data.task.node, "start");
  assert.equal(data.task.status, "queued");

  // Verify DB state
  const updated = store.getTask("PLUG-426-S1")!;
  assert.equal(updated.route, "feature");
  assert.equal(updated.node, "start");
  assert.equal(updated.status, "queued");
  assert.equal(updated.level, "simple"); // unchanged
  assert.equal(updated.confirmation_mode, "auto"); // unchanged

  // Verify transition log (§29.9 п. 5)
  const transitions = store.listTransitions("PLUG-426-S1");
  const lastTr = transitions.at(-1)!;
  assert.equal(lastTr.actor, "coordinator:auto");
  assert.equal(
    lastTr.reason,
    "coordinator-auto:reroute:fix→feature:требуется спека и дизайн",
  );
  assert.equal(lastTr.from_node, "start");
  assert.equal(lastTr.to_node, "start");
  assert.equal(lastTr.from_status, "stalled");
  assert.equal(lastTr.to_status, "queued");
  const payload = JSON.parse(lastTr.payload!);
  assert.equal(payload.event, "coordinator_auto");
  assert.equal(payload.command, "reroute");
  assert.equal(payload.from_route, "fix");
  assert.equal(payload.to_route, "feature");
  assert.equal(payload.caller_thread_id, "thr_coord_1");

  // Verify owner notification
  assert.ok(
    sentMessages.some((m) =>
      m.includes("PLUG-426-S1: маршрут fix → feature, координатор (§29.9): требуется спека и дизайн"),
    ),
    "Owner notification line must be sent",
  );
});

// ── 2. Success in shadow mode via RPC ──────────────────────────────────────

test("§29.9: success in shadow mode via RPC (node and status untouched)", async () => {
  const fake = fakeCmd();
  const host = await hostWith({ workGraph: "shadow" }, fakeCli().cli, fake.cmd);
  const store = new DelegationStore(host.bb.storage.database());

  store.setThreadRole("thr_coord_shadow", "orchestrator", "owner");
  store.insertTask({
    taskKey: "PLUG-426-SH",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord_shadow",
    route: "simple",
    level: "simple",
    priority: 100,
    confirmationMode: "auto",
  });
  // In shadow mode, node and status follow reality (e.g. node = 'design', status = 'queued')
  store.updateTask("PLUG-426-SH", { node: "design", status: "queued" });

  const rpcRes = (await host.harness.callRpc("reroute", {
    taskKey: "PLUG-426-SH",
    route: "feature",
    reason: "shadow reroute to feature",
    callerThreadId: "thr_coord_shadow",
  })) as { ok: boolean; task: any };

  assert.equal(rpcRes.ok, true);
  assert.equal(rpcRes.task.route, "feature");
  assert.equal(rpcRes.task.node, "design"); // untouched!
  assert.equal(rpcRes.task.status, "queued"); // untouched!

  const updated = store.getTask("PLUG-426-SH")!;
  assert.equal(updated.route, "feature");
  assert.equal(updated.node, "design");
  assert.equal(updated.status, "queued");

  const lastTr = store.listTransitions("PLUG-426-SH").at(-1)!;
  assert.equal(lastTr.actor, "coordinator:auto");
  assert.equal(
    lastTr.reason,
    "coordinator-auto:reroute:simple→feature:shadow reroute to feature",
  );
  assert.equal(lastTr.from_node, "design");
  assert.equal(lastTr.to_node, "design");
  assert.equal(lastTr.from_status, "queued");
  assert.equal(lastTr.to_status, "queued");
});

// ── 3. Every denial code tested individually ───────────────────────────────

test("§29.9 denial 1 (pre-tx): reason-required when --reason is empty or missing", async () => {
  const host = await hostWith({ workGraph: "strict" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const store = new DelegationStore(host.bb.storage.database());
  store.setThreadRole("thr_coord", "orchestrator", "owner");
  store.insertTask({
    taskKey: "PLUG-ERR-1",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });

  const resEmpty = await host.harness.runCli(
    ["reroute", "PLUG-ERR-1", "--route", "feature", "--reason", "", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resEmpty.exitCode, 1);
  const data = JSON.parse(resEmpty.stdout);
  assert.equal(data.error.code, "reason-required");

  // Verify task, transitions, and notifications unchanged
  assert.equal(store.getTask("PLUG-ERR-1")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-1").length, 1); // only enqueue
  assert.equal(sentMessages, 0, "No owner notification on reason-required refusal");
});

test("§29.9 denial 2 (pre-tx): task-not-found when task does not exist", async () => {
  const host = await hostWith({ workGraph: "strict" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const res = await host.harness.runCli(
    ["reroute", "NON-EXISTENT", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(res.exitCode, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "task-not-found");
  assert.equal(sentMessages, 0, "No owner notification on task-not-found refusal");
});

test("§29.9 denial 3 (pre-tx): graph-disabled when workGraph is off", async () => {
  const host = await hostWith({ workGraph: "off" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const store = new DelegationStore(host.bb.storage.database());
  store.setThreadRole("thr_coord", "orchestrator", "owner");
  store.insertTask({
    taskKey: "PLUG-ERR-3",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });

  const res = await host.harness.runCli(
    ["reroute", "PLUG-ERR-3", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(res.exitCode, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "graph-disabled");

  assert.equal(store.getTask("PLUG-ERR-3")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-3").length, 1);
  assert.equal(sentMessages, 0, "No owner notification on graph-disabled refusal");
});

test("§29.9 denial 4 (а): not-coordinator when caller has no orchestrator role in thread_roles", async () => {
  const host = await hostWith({ workGraph: "strict" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const store = new DelegationStore(host.bb.storage.database());
  store.setThreadRole("thr_coord", "orchestrator", "owner");
  store.setThreadRole("thr_exec", "executor", "owner");
  store.insertTask({
    taskKey: "PLUG-ERR-4",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });

  // Call without threadId (e.g. bare owner call)
  const resNoThread = await host.harness.runCli([
    "reroute",
    "PLUG-ERR-4",
    "--route",
    "feature",
    "--reason",
    "test",
    "--json",
  ]);
  assert.equal(resNoThread.exitCode, 1);
  const dataNoThread = JSON.parse(resNoThread.stdout);
  assert.equal(dataNoThread.error.code, "permission-denied");
  assert.equal(dataNoThread.error.message, "owner-only (§29.9: not-coordinator)");

  // Call from executor thread
  const resExec = await host.harness.runCli(
    ["reroute", "PLUG-ERR-4", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_exec" },
  );
  assert.equal(resExec.exitCode, 1);
  const dataExec = JSON.parse(resExec.stdout);
  assert.equal(dataExec.error.code, "permission-denied");
  assert.equal(dataExec.error.message, "owner-only (§29.9: not-coordinator)");

  assert.equal(store.getTask("PLUG-ERR-4")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-4").length, 1);
  assert.equal(sentMessages, 0, "No owner notification on not-coordinator refusal");
});

test("§29.9 denial 5 (б): foreign-coordinator when caller is not the task coordinator", async () => {
  const host = await hostWith({ workGraph: "strict" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const store = new DelegationStore(host.bb.storage.database());
  store.setThreadRole("thr_coord_owner", "orchestrator", "owner");
  store.setThreadRole("thr_coord_other", "orchestrator", "owner");
  store.insertTask({
    taskKey: "PLUG-ERR-5",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord_owner",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });

  const res = await host.harness.runCli(
    ["reroute", "PLUG-ERR-5", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord_other" },
  );
  assert.equal(res.exitCode, 1);
  const data = JSON.parse(res.stdout);
  assert.equal(data.error.code, "permission-denied");
  assert.equal(data.error.message, "owner-only (§29.9: foreign-coordinator)");

  assert.equal(store.getTask("PLUG-ERR-5")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-5").length, 1);
  assert.equal(sentMessages, 0, "No owner notification on foreign-coordinator refusal");
});

test("§29.9 denial 6 (в): manual-mode when task is in manual confirmation mode", async () => {
  const host = await hostWith({ workGraph: "strict" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const store = new DelegationStore(host.bb.storage.database());
  store.setThreadRole("thr_coord", "orchestrator", "owner");
  store.insertTask({
    taskKey: "PLUG-ERR-6",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "manual",
  });

  const res = await host.harness.runCli(
    ["reroute", "PLUG-ERR-6", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(res.exitCode, 1);
  const data = JSON.parse(res.stdout);
  assert.equal(data.error.code, "permission-denied");
  assert.equal(data.error.message, "owner-only (§29.9: manual-mode)");

  assert.equal(store.getTask("PLUG-ERR-6")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-6").length, 1);
  assert.equal(sentMessages, 0, "No owner notification on manual-mode refusal");
});

test("§29.9 denial 7 (г): route-not-allowed when target is not feature or source is not fix/simple", async () => {
  const host = await hostWith({ workGraph: "strict" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const store = new DelegationStore(host.bb.storage.database());
  store.setThreadRole("thr_coord", "orchestrator", "owner");

  // 7.1 target route is simple instead of feature
  store.insertTask({
    taskKey: "PLUG-ERR-7A",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  const resTargetNotFeature = await host.harness.runCli(
    ["reroute", "PLUG-ERR-7A", "--route", "simple", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resTargetNotFeature.exitCode, 1);
  assert.equal(
    JSON.parse(resTargetNotFeature.stdout).error.message,
    "owner-only (§29.9: route-not-allowed)",
  );
  assert.equal(store.getTask("PLUG-ERR-7A")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-7A").length, 1);

  // 7.2 task route is docs
  store.insertTask({
    taskKey: "PLUG-ERR-7B",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "docs",
    level: "simple",
    confirmationMode: "auto",
  });
  const resDocs = await host.harness.runCli(
    ["reroute", "PLUG-ERR-7B", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resDocs.exitCode, 1);
  assert.equal(
    JSON.parse(resDocs.stdout).error.message,
    "owner-only (§29.9: route-not-allowed)",
  );
  assert.equal(store.getTask("PLUG-ERR-7B")!.route, "docs");
  assert.equal(store.listTransitions("PLUG-ERR-7B").length, 1);

  // 7.3 repeat reroute on already feature task -> route-not-allowed
  store.insertTask({
    taskKey: "PLUG-ERR-7C",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  });
  const resRepeatFeature = await host.harness.runCli(
    ["reroute", "PLUG-ERR-7C", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resRepeatFeature.exitCode, 1);
  assert.equal(
    JSON.parse(resRepeatFeature.stdout).error.message,
    "owner-only (§29.9: route-not-allowed)",
  );
  assert.equal(store.getTask("PLUG-ERR-7C")!.route, "feature");
  assert.equal(store.listTransitions("PLUG-ERR-7C").length, 1);

  assert.equal(sentMessages, 0, "No owner notification on route-not-allowed refusal");
});

test("§29.9 denial 8 (д): code-dispatched when code delegation or to_node = 'code' exists", async () => {
  const host = await hostWith({ workGraph: "strict" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const db = host.bb.storage.database();
  const store = new DelegationStore(db);
  store.setThreadRole("thr_coord", "orchestrator", "owner");

  // 8.1 delegation with code level ('medium') in cancelled status
  store.insertTask({
    taskKey: "PLUG-ERR-8A",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  db.prepare(
    `INSERT INTO delegations (task_key, coordinator_thread_id, level, route, preset, provider, status, setup_errors, created_at, updated_at)
     VALUES ('PLUG-ERR-8A', 'thr_coord', 'medium', 'fix', 'simple', 'p', 'cancelled', '[]', 100, 100)`,
  ).run();

  const resCodeDelegation = await host.harness.runCli(
    ["reroute", "PLUG-ERR-8A", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resCodeDelegation.exitCode, 1);
  assert.equal(
    JSON.parse(resCodeDelegation.stdout).error.message,
    "owner-only (§29.9: code-dispatched)",
  );
  assert.equal(store.getTask("PLUG-ERR-8A")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-8A").length, 1);

  // 8.2 transition to_node = 'code' exists in history
  store.insertTask({
    taskKey: "PLUG-ERR-8B",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  db.prepare(
    `INSERT INTO task_transitions (task_key, from_node, to_node, from_status, to_status, actor, reason, created_at)
     VALUES ('PLUG-ERR-8B', 'start', 'code', 'queued', 'running', 'coordinator', 'test', 100)`,
  ).run();

  const resCodeTransition = await host.harness.runCli(
    ["reroute", "PLUG-ERR-8B", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resCodeTransition.exitCode, 1);
  assert.equal(
    JSON.parse(resCodeTransition.stdout).error.message,
    "owner-only (§29.9: code-dispatched)",
  );
  assert.equal(store.getTask("PLUG-ERR-8B")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-8B").length, 2);
  assert.equal(sentMessages, 0, "No owner notification on code-dispatched refusal");

  // 8.3 non-code delegations (spec, research, architect) do NOT block reroute!
  store.insertTask({
    taskKey: "PLUG-OK-8C",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  db.prepare(
    `INSERT INTO delegations (task_key, coordinator_thread_id, level, route, preset, provider, status, setup_errors, created_at, updated_at)
     VALUES ('PLUG-OK-8C', 'thr_coord', 'spec', 'fix', 'simple', 'p', 'done', '[]', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO delegations (task_key, coordinator_thread_id, level, route, preset, provider, status, setup_errors, created_at, updated_at)
     VALUES ('PLUG-OK-8C', 'thr_coord', 'research', 'fix', 'simple', 'p', 'done', '[]', 100, 100)`,
  ).run();

  const resNonCode = await host.harness.runCli(
    ["reroute", "PLUG-OK-8C", "--route", "feature", "--reason", "spec done, upgrade", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resNonCode.exitCode, 0);
  assert.equal(JSON.parse(resNonCode.stdout).task.route, "feature");
  assert.equal(sentMessages, 1, "Success reroute sends 1 owner notification");
});

test("§29.9 denial 9 (е): released when release record or to_status = 'pr_open' exists", async () => {
  const host = await hostWith({ workGraph: "strict" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const db = host.bb.storage.database();
  const store = new DelegationStore(db);
  store.setThreadRole("thr_coord", "orchestrator", "owner");

  // 9.1 row in releases table
  store.insertTask({
    taskKey: "PLUG-ERR-9A",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  db.prepare(
    `INSERT INTO releases (task_key, project_id, coordinator_thread_id, repo_path, branch, target_action, target_branch, status, created_at, updated_at)
     VALUES ('PLUG-ERR-9A', 'proj_bb', 'thr_coord', '/tmp/fake-repo', 'bb/plug', 'pr', 'main', 'auditing', 100, 100)`,
  ).run();

  const resRel = await host.harness.runCli(
    ["reroute", "PLUG-ERR-9A", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resRel.exitCode, 1);
  assert.equal(
    JSON.parse(resRel.stdout).error.message,
    "owner-only (§29.9: released)",
  );
  assert.equal(store.getTask("PLUG-ERR-9A")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-9A").length, 1);

  // 9.2 transition with to_status = 'pr_open'
  store.insertTask({
    taskKey: "PLUG-ERR-9B",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  db.prepare(
    `INSERT INTO task_transitions (task_key, from_node, to_node, from_status, to_status, actor, reason, created_at)
     VALUES ('PLUG-ERR-9B', 'release', 'release', 'running', 'pr_open', 'coordinator', 'test', 100)`,
  ).run();

  const resPrOpen = await host.harness.runCli(
    ["reroute", "PLUG-ERR-9B", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resPrOpen.exitCode, 1);
  assert.equal(
    JSON.parse(resPrOpen.stdout).error.message,
    "owner-only (§29.9: released)",
  );
  assert.equal(store.getTask("PLUG-ERR-9B")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-9B").length, 2);
  assert.equal(sentMessages, 0, "No owner notification on released refusal");
});

test("§29.9 denial 10 (ж): task-busy when task has active delegation (dispatching or running)", async () => {
  const host = await hostWith({ workGraph: "strict" });
  let sentMessages = 0;
  host.harness.sdk.stub("threads.send", async () => {
    sentMessages++;
    return { id: "msg_1" };
  });
  const db = host.bb.storage.database();
  const store = new DelegationStore(db);
  store.setThreadRole("thr_coord", "orchestrator", "owner");

  store.insertTask({
    taskKey: "PLUG-ERR-10",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  db.prepare(
    `INSERT INTO delegations (task_key, coordinator_thread_id, level, route, preset, provider, status, setup_errors, created_at, updated_at)
     VALUES ('PLUG-ERR-10', 'thr_coord', 'spec', 'fix', 'simple', 'p', 'running', '[]', 100, 100)`,
  ).run();

  const res = await host.harness.runCli(
    ["reroute", "PLUG-ERR-10", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(res.exitCode, 1);
  assert.equal(
    JSON.parse(res.stdout).error.message,
    "owner-only (§29.9: task-busy)",
  );
  assert.equal(store.getTask("PLUG-ERR-10")!.route, "fix");
  assert.equal(store.listTransitions("PLUG-ERR-10").length, 1);
  assert.equal(sentMessages, 0, "No owner notification on task-busy refusal");
});

test("§29.9 denial 11 (з): not-at-start (in strict: not at start/queued|stalled; in shadow: done|cancelled)", async () => {
  const hostStrict = await hostWith({ workGraph: "strict" });
  let sentMessagesStrict = 0;
  hostStrict.harness.sdk.stub("threads.send", async () => {
    sentMessagesStrict++;
    return { id: "msg_1" };
  });
  const dbStrict = hostStrict.bb.storage.database();
  const storeStrict = new DelegationStore(dbStrict);
  storeStrict.setThreadRole("thr_coord", "orchestrator", "owner");

  // In strict: task at node 'design'
  storeStrict.insertTask({
    taskKey: "PLUG-ERR-11A",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  storeStrict.updateTask("PLUG-ERR-11A", { node: "design", status: "queued" });

  const resDesign = await hostStrict.harness.runCli(
    ["reroute", "PLUG-ERR-11A", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resDesign.exitCode, 1);
  assert.equal(
    JSON.parse(resDesign.stdout).error.message,
    "owner-only (§29.9: not-at-start)",
  );
  assert.equal(storeStrict.getTask("PLUG-ERR-11A")!.route, "fix");
  assert.equal(storeStrict.listTransitions("PLUG-ERR-11A").length, 1);

  // In strict: task at node 'start' but status 'blocked'
  storeStrict.insertTask({
    taskKey: "PLUG-ERR-11B",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  storeStrict.updateTask("PLUG-ERR-11B", { node: "start", status: "blocked" });

  const resBlocked = await hostStrict.harness.runCli(
    ["reroute", "PLUG-ERR-11B", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resBlocked.exitCode, 1);
  assert.equal(
    JSON.parse(resBlocked.stdout).error.message,
    "owner-only (§29.9: not-at-start)",
  );
  assert.equal(storeStrict.getTask("PLUG-ERR-11B")!.route, "fix");
  assert.equal(storeStrict.listTransitions("PLUG-ERR-11B").length, 1);
  assert.equal(sentMessagesStrict, 0, "No owner notification on not-at-start refusal in strict");

  // In shadow: task status 'done' or 'cancelled'
  const hostShadow = await hostWith({ workGraph: "shadow" });
  let sentMessagesShadow = 0;
  hostShadow.harness.sdk.stub("threads.send", async () => {
    sentMessagesShadow++;
    return { id: "msg_1" };
  });
  const dbShadow = hostShadow.bb.storage.database();
  const storeShadow = new DelegationStore(dbShadow);
  storeShadow.setThreadRole("thr_coord", "orchestrator", "owner");

  storeShadow.insertTask({
    taskKey: "PLUG-ERR-11C",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });
  storeShadow.updateTask("PLUG-ERR-11C", { status: "done" });

  const resDone = await hostShadow.harness.runCli(
    ["reroute", "PLUG-ERR-11C", "--route", "feature", "--reason", "test", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(resDone.exitCode, 1);
  assert.equal(
    JSON.parse(resDone.stdout).error.message,
    "owner-only (§29.9: not-at-start)",
  );
  assert.equal(storeShadow.getTask("PLUG-ERR-11C")!.route, "fix");
  assert.equal(storeShadow.listTransitions("PLUG-ERR-11C").length, 1);
  assert.equal(sentMessagesShadow, 0, "No owner notification on not-at-start refusal in shadow");
});

// ── 4. Two concurrent reroutes: CAS ensures exactly one succeeds ───────────

test("§29.9: two concurrent reroutes - CAS ensures exactly one succeeds, other fails with route-not-allowed", async () => {
  const host = await hostWith({ workGraph: "strict" });
  const store = new DelegationStore(host.bb.storage.database());
  store.setThreadRole("thr_coord", "orchestrator", "owner");

  store.insertTask({
    taskKey: "PLUG-PARALLEL",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });

  const [res1, res2] = await Promise.all([
    host.harness.callRpc("reroute", {
      taskKey: "PLUG-PARALLEL",
      route: "feature",
      reason: "parallel attempt 1",
      callerThreadId: "thr_coord",
    }).then(
      (val) => ({ success: true, val }),
      (err) => ({ success: false, err }),
    ),
    host.harness.callRpc("reroute", {
      taskKey: "PLUG-PARALLEL",
      route: "feature",
      reason: "parallel attempt 2",
      callerThreadId: "thr_coord",
    }).then(
      (val) => ({ success: true, val }),
      (err) => ({ success: false, err }),
    ),
  ]);

  const successes = [res1, res2].filter((r) => r.success);
  const failures = [res1, res2].filter((r) => !r.success);

  assert.equal(successes.length, 1, "Exactly one parallel reroute must succeed");
  assert.equal(failures.length, 1, "Exactly one parallel reroute must fail");
  assert.match(
    (failures[0] as any).err.message,
    /route-not-allowed/,
    "Failed parallel reroute must receive route-not-allowed",
  );

  const updated = store.getTask("PLUG-PARALLEL")!;
  assert.equal(updated.route, "feature");
});

// ── 5. Zero calls to cmdRunner, threads.stop and prProvider ───────────────

test("§29.9: mock cmdRunner, threads.stop and external systems receive 0 calls during reroute", async () => {
  const fake = fakeCmd();
  let prProviderCalls = 0;
  const countingPrProvider = new Proxy(
    {
      view: async () => {
        prProviderCalls++;
        return {};
      },
      create: async () => {
        prProviderCalls++;
        return {};
      },
      find: async () => {
        prProviderCalls++;
        return {};
      },
    },
    {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target)) {
          return (..._args: any[]) => {
            prProviderCalls++;
            return {};
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    },
  );

  const host = await hostWith(
    { workGraph: "strict" },
    fakeCli().cli,
    fake.cmd,
    countingPrProvider,
  );
  const store = new DelegationStore(host.bb.storage.database());
  store.setThreadRole("thr_coord", "orchestrator", "owner");

  let threadStopCalls = 0;
  host.harness.sdk.stub("threads.stop", async () => {
    threadStopCalls++;
    return { ok: true };
  });

  store.insertTask({
    taskKey: "PLUG-NO-EXT",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    confirmationMode: "auto",
  });

  const initialCmdCalls = fake.calls.length;

  const res = await host.harness.runCli(
    ["reroute", "PLUG-NO-EXT", "--route", "feature", "--reason", "pure sqlite", "--json"],
    { threadId: "thr_coord" },
  );

  assert.equal(res.exitCode, 0);
  assert.equal(
    fake.calls.length,
    initialCmdCalls,
    "cmdRunner must receive 0 calls during reroute",
  );
  assert.equal(threadStopCalls, 0, "threads.stop must receive 0 calls");
  assert.equal(prProviderCalls, 0, "prProvider must receive 0 calls during reroute");
});

// ── 6. Scenario PLUG-414: passes §31.9 gate on feature route after reroute ───

test("§29.9 & §31.9: task PLUG-414 passes §31.9 gate via standard feature pipeline without owner", async () => {
  const fake = fakeCmd((file, args) => {
    const key = `${file} ${args.join(" ")}`;
    if (key.includes("rev-parse --verify refs/heads/bb/plug-414-test-task-slug-feature")) {
      return ok("branch-sha-414");
    }
    return undefined;
  });

  const host = await hostWith({ workGraph: "strict" }, fakeCli().cli, fake.cmd);
  const db = host.bb.storage.database();
  const store = new DelegationStore(db);
  store.setThreadRole("thr_coord", "orchestrator", "owner");

  // Step 1: PLUG-414 enters as 'fix' without acceptance contract in auto mode
  store.insertTask({
    taskKey: "PLUG-414",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "simple",
    priority: 100,
    confirmationMode: "auto",
  });

  const taskInitial = store.getTask("PLUG-414")!;
  assert.equal(taskInitial.route, "fix");
  assert.equal(taskInitial.acceptance_sha, null);

  // Step 2: Coordinator calls reroute PLUG-414 to feature (§29.9)
  const resReroute = await host.harness.runCli(
    [
      "reroute",
      "PLUG-414",
      "--route",
      "feature",
      "--reason",
      "PLUG-414: повышаем до feature для получения договора приёмки и спеки",
      "--json",
    ],
    { threadId: "thr_coord" },
  );

  assert.equal(resReroute.exitCode, 0);
  assert.equal(JSON.parse(resReroute.stdout).task.route, "feature");

  // Step 3: Next run-queue tick advances task along feature route to 'design'
  await runRunQueue({
    store,
    cmd: fake.cmd,
    repoRoot: "/tmp/fake-repo",
    mergeBaseBranch: "main",
    workGraphMode: "strict",
    approvalMode: "auto",
  });

  const taskDesign = store.getTask("PLUG-414")!;
  assert.equal(taskDesign.route, "feature");
  assert.equal(taskDesign.node, "design");
  assert.equal(taskDesign.status, "running");

  // Step 4: Architect delivers design and acceptance criteria: design -> spec
  store.updateTask("PLUG-414", {
    payload: JSON.stringify({
      design_done: true,
      acceptance_text: "Acceptance criteria contract for PLUG-414 (§31)",
    }),
  });
  await runRunQueue({
    store,
    cmd: fake.cmd,
    repoRoot: "/tmp/fake-repo",
    mergeBaseBranch: "main",
    workGraphMode: "strict",
    approvalMode: "auto",
  });

  const taskSpec = store.getTask("PLUG-414")!;
  assert.equal(taskSpec.node, "spec");
  assert.equal(taskSpec.status, "running");
  assert.ok(taskSpec.acceptance_sha, "Acceptance contract sha must be committed on feature route");

  // Step 5: Spec executor commits specification: spec -> spec_review
  store.updateTask("PLUG-414", {
    payload: JSON.stringify({
      spec_done: true,
      spec_sha: "sha-spec-plug414",
    }),
  });
  await runRunQueue({
    store,
    cmd: fake.cmd,
    repoRoot: "/tmp/fake-repo",
    mergeBaseBranch: "main",
    workGraphMode: "strict",
    approvalMode: "auto",
  });

  const taskSpecReview = store.getTask("PLUG-414")!;
  assert.equal(taskSpecReview.node, "spec_review");
  assert.equal(taskSpecReview.status, "running");
  assert.equal(taskSpecReview.spec_sha, "sha-spec-plug414");

  // Step 6: Spec review approves: spec_review -> code
  // In auto mode, §31.9 automatically links and approves spec without owner!
  store.updateTask("PLUG-414", {
    payload: JSON.stringify({
      spec_review_verdict: "OK",
    }),
  });
  await runRunQueue({
    store,
    cmd: fake.cmd,
    repoRoot: "/tmp/fake-repo",
    mergeBaseBranch: "main",
    workGraphMode: "strict",
    approvalMode: "auto",
  });

  const taskCode = store.getTask("PLUG-414")!;
  assert.equal(taskCode.node, "code");
  assert.equal(taskCode.status, "running");

  // Verify that §31.9 gate contract was resolved & persisted with approvalId
  const specContract = store.getSpecContract("PLUG-414")!;
  assert.ok(specContract, "Spec contract must be persisted in task_spec_contracts");
  assert.ok(specContract.approval_id, "Contract must have approval_id");
  assert.equal(specContract.spec_sha, "sha-spec-plug414");

  // Verify verifySpecBeforeCodeGate passes without owner intervention
  await verifySpecBeforeCodeGate({
    taskKey: "PLUG-414",
    role: "executor",
    level: "simple",
    store,
    cmd: fake.cmd,
    repoRoot: "/tmp/fake-repo",
    baseBranchName: "main",
    workGraphMode: "strict",
    approvalMode: "auto",
  });
});
