import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import { resolveTaskProjectId } from "../src/workgraph.js";
import { runDelegate, dispatchToRoute, type DelegateDeps, type DispatchStepsDeps } from "../src/delegate.js";
import { createWatchdog } from "../src/watchdog.js";
import { parsePolicy } from "../src/policy.js";
import { T_RU } from "../src/i18n/index.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { ThreadFacts } from "../src/agent-config.js";

const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

test("resolveTaskProjectId: handles confirmed conflict between historical done-delegation and tracker", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  // Historical delegations exist across all 6 non-active statuses with proj_old
  const statuses = ["done", "failed", "cancelled", "reissued", "stalled", "quota"] as const;
  const delIds: number[] = [];
  for (const st of statuses) {
    const d = store.insert({
      taskKey: "CONFLICT-1",
      projectId: "proj_old",
      coordinatorThreadId: "thr_coord",
      level: "simple",
      route: "simple",
      preset: "preset_1",
      provider: "provider_1",
      round: 1,
    });
    store.setStatus(d.id, st);
    delIds.push(d.id);
  }

  const trackerMock = {
    getTask: async (k: string) => ({
      task: { key: k, projectId: "proj_tracker" },
      project: { linkedBbProjectId: "proj_tracker" },
    }),
  };

  // 1. Explicit refusal on conflict
  await assert.rejects(
    async () => {
      await resolveTaskProjectId(store, "CONFLICT-1", {
        tracker: trackerMock,
        onConflict: "refuse",
      });
    },
    (err: any) => {
      assert.equal(err.code, "task-project-conflict");
      assert.match(err.message, /proj_old.*proj_tracker/);
      return true;
    },
  );

  // 2. Standard recovery path (read-only): tracker is authoritative, does not mutate DB without heal: true
  const warnings: string[] = [];
  const resolvedReadOnly = await resolveTaskProjectId(store, "CONFLICT-1", {
    tracker: trackerMock,
    log: { warn: (msg) => warnings.push(msg) },
  });

  assert.equal(resolvedReadOnly, "proj_tracker");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /recovering to tracker project proj_tracker/);
  // Verify DB was NOT mutated on read-only call across all rows
  for (const id of delIds) {
    assert.equal(store.get(id)!.project_id, "proj_old");
  }

  // 3. Mutating recovery path (heal: true): heals historical delegations across ALL statuses in DB
  const resolvedHeal = await resolveTaskProjectId(store, "CONFLICT-1", {
    tracker: trackerMock,
    heal: true,
  });
  assert.equal(resolvedHeal, "proj_tracker");
  for (const id of delIds) {
    const healed = store.get(id)!;
    assert.equal(healed.project_id, "proj_tracker", `row #${id} status ${healed.status} should be healed`);
  }
});

test("connected cross-project scenario: coordinator in proj_coord, task in proj_task, transient failure → watchdog reissue", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const REPO_COORD = "/work/bb/repo-coord";
  const REPO_TASK = "/work/bb/repo-task";
  const ACCEPTED_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
  const BASE_SHA = "0000111122223333444455556666777788889999";

  const POLICY_TEXT = JSON.stringify({
    version: 1,
    approvalMode: "auto",
    levels: {
      medium: { chain: ["route-primary", "route-fallback"], autoFallback: true },
    },
    routes: {
      "route-primary": { preset: "p-primary", provider: "acp-primary" },
      "route-fallback": { preset: "p-fallback", provider: "acp-fallback" },
    },
  });
  const policy = parsePolicy(POLICY_TEXT, new Set(["p-primary", "p-fallback"]));

  // Pre-seed accepted spec contract for the task in proj_task
  store.saveSpecContract({
    taskKey: "CROSS-1",
    kind: "behavior_change",
    specPath: "docs/specs/test.md",
    specSha: ACCEPTED_SHA,
    approvalId: `appr:proj_task:CROSS-1:${ACCEPTED_SHA}:123456`,
    projectId: "proj_task",
  });

  // Track all git calls and their cwd
  const gitCalls: { cmd: string; args: string[]; cwd: string }[] = [];
  const fakeCmd = {
    run: async (cmdName: string, args: string[], opts?: { cwd?: string }) => {
      const cwd = opts?.cwd ?? "";
      gitCalls.push({ cmd: cmdName, args, cwd });
      if (cmdName === "git") {
        if (args.includes("rev-parse")) {
          return { exitCode: 0, stdout: BASE_SHA, stderr: "" };
        }
        if (args.includes("cat-file")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("--is-ancestor")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const spawnArgs: Record<string, unknown>[] = [];
  const threadDtos = new Map<string, any>();
  const cli: BbCli = {
    run: async (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks show")) {
        return ok(
          JSON.stringify({
            task: { id: "t-cross-1", key: "CROSS-1", title: "cross task", status: "todo", projectId: "proj_task" },
            project: { name: "task-project", linkedBbProjectId: "proj_task" },
            subtasks: [],
            attachments: [],
            comments: [],
          }),
        );
      }
      if (key.startsWith("tasks preset show")) {
        return ok(
          JSON.stringify({
            preset: {
              providerId: "fake-provider",
              modelId: "m1",
              reasoningLevel: "medium",
              permissionMode: "auto",
              environmentKind: "project-default",
            },
          }),
        );
      }
      if (key.startsWith("thread show")) {
        const id = args[2]!;
        const dto = threadDtos.get(id) ?? {
          id,
          parentThreadId: "thr_coord",
          parentNotifications: "auto",
          visibility: "hidden",
        };
        return ok(JSON.stringify({ thread: dto }));
      }
      return ok();
    },
  };

  let nextThreadNum = 1;
  const delegateDeps: DelegateDeps = {
    store,
    bbCli: cli,
    threads: {
      spawn: async (args) => {
        const id = `thr_exec_${nextThreadNum++}`;
        spawnArgs.push({ ...args, id });
        threadDtos.set(id, { id, status: "idle", parentThreadId: "thr_coord" });
        return { id };
      },
      list: async () => [],
      getPluginMetadata: async () => null,
      update: async () => ({}),
      stop: async () => ({}),
    },
    loadPolicy: async () => policy,
    probes: {
      delegationByThreadId: (id) => store.byThreadId(id),
      hasFreshDispatching: (s, scope) => store.hasFreshDispatching(s, scope),
      roleByThreadId: (id) => store.threadRole(id)?.role,
    },
    primaryHostId: async () => "host_1",
    cmd: fakeCmd as any,
    workGraphMode: (pid?: string) => (pid === "proj_task" ? "shadow" : "off"),
    repoRoot: REPO_TASK,
    resolveProject: (pid: string) => ({ id: pid, approvalMode: "auto" } as any),
  };

  const COORDINATOR: ThreadFacts = {
    threadId: "thr_coord",
    parentThreadId: null,
    title: "coordinate",
    originPluginId: null,
    projectId: "proj_coord", // Coordinator belongs to proj_coord
  };

  // 1. Initial delegation of CROSS-1 (task belongs to proj_task)
  const initialRes = await runDelegate(
    {
      taskKey: "CROSS-1",
      level: "medium",
      route: "route-primary",
      from: ACCEPTED_SHA,
      caller: COORDINATOR,
      projectId: "proj_task",
    },
    delegateDeps,
  );

  assert.equal(initialRes.ok, true);
  const row1 = store.get(initialRes.delegationId)!;
  assert.equal(row1.project_id, "proj_task");
  assert.equal(row1.continue_from, ACCEPTED_SHA);
  assert.equal(row1.status, "running");
  assert.equal(spawnArgs[0]?.projectId, "proj_task");
  const threadId1 = initialRes.threadId!;

  // Setup watchdog stepsDeps
  const stepsDeps: DispatchStepsDeps = {
    store,
    bbCli: cli,
    threads: delegateDeps.threads as any,
    primaryHostId: delegateDeps.primaryHostId,
    cmd: fakeCmd as any,
    policy: () => policy.policy,
    t: T_RU,
    now: () => Date.now(),
    unavailableRoutes: () => new Set(),
    workGraphMode: (pid?: string) => (pid === "proj_task" ? "shadow" : "off"),
    resolveRepoRoot: async (r) => (r.project_id === "proj_task" ? REPO_TASK : REPO_COORD),
    resolveProject: (pid: string) => ({ id: pid, approvalMode: "auto" } as any),
  };

  // Create real watchdog with stepsDeps wired to dispatchToRoute
  const wd = createWatchdog({
    store,
    bbCli: cli,
    threads: {
      get: async (a) => ({ id: a.threadId, status: "error" }),
      events: { list: async () => [] },
      queuedMessages: { list: async () => [] },
      send: async () => ({}),
      stop: async () => ({}),
      output: async () => null,
      update: async () => ({}),
    },
    loadPolicy: async () => policy,
    dispatch: async (fresh, opts) => dispatchToRoute(fresh, opts ?? {}, stepsDeps),
    finalize: async () => ({ status: "running" as const, setupErrors: [] }),
    retrySetup: async () => [],
    enqueue: async (fn) => fn(),
    t: T_RU,
    now: () => Date.now(),
    workGraphMode: () => "shadow",
    resolveProject: (pid: string) => ({ id: pid, approvalMode: "auto" } as any),
  });

  // 2. First executor experiences transient failure
  // Watchdog receives onThreadFailed
  await wd.onThreadFailed(
    { id: threadId1, status: "error" },
    "Provider error: model ended turn without response",
  );

  // Verify first delegation was marked reissued (superseded by reissue)
  const failedRow = store.get(row1.id)!;
  assert.equal(failedRow.status, "reissued");

  // Verify reissued delegation was created and dispatched
  const reissues = store.delegationsByTask("CROSS-1");
  const fresh = reissues.find((d) => d.reissue_of === row1.id);
  assert.ok(fresh, "expected reissue row to be created by watchdog");
  assert.equal(fresh.project_id, "proj_task"); // Inherits task's project ID!
  assert.equal(fresh.continue_from, ACCEPTED_SHA); // Inherits accepted spec SHA!
  assert.equal(fresh.route, "route-fallback");
  assert.equal(fresh.status, "running");

  // Reissued thread spawned in proj_task
  assert.equal(spawnArgs[1]?.projectId, "proj_task");

  // 3. Verify Git-calls isolation:
  // All git calls MUST have cwd === REPO_TASK. ZERO git calls in REPO_COORD.
  assert.ok(gitCalls.length > 0, "expected git calls during spec gate verification");
  for (const call of gitCalls) {
    assert.equal(
      call.cwd,
      REPO_TASK,
      `Git call ${call.cmd} ${call.args.join(" ")} should have targeted REPO_TASK but targeted ${call.cwd}`,
    );
    assert.notEqual(call.cwd, REPO_COORD, `Git call must NOT target REPO_COORD`);
  }
});
