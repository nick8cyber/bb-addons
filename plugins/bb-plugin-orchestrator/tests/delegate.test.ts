import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import {
  runDelegate,
  createDelegateQueue,
  dispatchToRoute,
  retrySetupSteps,
  buildSeedPrompt,
  delegatedThreadTitle,
  truncateToWidth,
  type DelegateDeps,
} from "../src/delegate.js";
import { parsePolicy } from "../src/policy.js";
import { OrchestratorError } from "../src/errors.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import {
  buildAgentConfiguration,
  type ThreadFacts,
} from "../src/agent-config.js";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";

const POLICY_TEXT = JSON.stringify({
  version: 1,
  limits: { maxActive: 2, perLevel: { complex: 1 } },
  levels: {
    complex: { chain: ["complex", "complex-alt"] },
    simple: { chain: ["simple"] },
  },
  routes: {
    complex: { preset: "complex", provider: "acp-devin" },
    "complex-alt": { preset: "complex-alt", provider: "agy" },
    simple: { preset: "simple", provider: "acp-opencode" },
  },
});

const PRESETS = new Set(["complex", "complex-alt", "simple"]);

const COORDINATOR: ThreadFacts = {
  threadId: "thr_coord",
  parentThreadId: null,
  title: "coordinate work",
  originPluginId: null,
  projectId: "proj_main",
};

const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

interface Call {
  args: string[];
}

/** §4 r30: a preset payload complete enough for the own-spawn dispatch —
 * provider, model, reasoning, permission and environment kind all set. */
const FULL_PRESET = {
  providerId: "acp-devin",
  modelId: "m1",
  reasoningLevel: "medium",
  serviceTier: null,
  permissionMode: "full",
  environmentKind: "project-default",
  baseBranch: null,
  machineId: null,
  instructions: "",
};

/** A `bb tasks show --json` payload complete enough for the seed prompt. */
const taskShowJson = (key: string) =>
  JSON.stringify({
    task: {
      id: "task-1",
      key,
      title: "do it",
      description: "the task body",
      status: "todo",
    },
    project: { name: "main", linkedBbProjectId: "proj_bb" },
    subtasks: [],
    attachments: [],
    comments: [],
  });

/** `bb thread show --json` answering a correctly-bound spawned thread. */
const boundThreadJson = JSON.stringify({
  thread: {
    parentThreadId: "thr_coord",
    parentNotifications: "auto",
    visibility: "hidden",
  },
});

/** The default fake CLI: answers every command the own-spawn path issues
 * — `tasks show`, `preset show`, `attach`, `thread show` (bound) — and
 * still answers `tasks dispatch` for the fallback-path tests. */
function defaultCli(args: string[]): BbCliResult {
  const key = args.join(" ");
  if (key.startsWith("tasks show"))
    return ok(taskShowJson(args[2] ?? "PLUG-1"));
  if (key.startsWith("tasks dispatch"))
    return ok(
      JSON.stringify({ task: { id: "task-1" }, preset: {}, threadId: "thr_exec" }),
    );
  if (key.startsWith("tasks preset show"))
    return ok(JSON.stringify({ preset: FULL_PRESET }));
  if (key.startsWith("thread show")) return ok(boundThreadJson);
  if (key.startsWith("thread options") && key.includes("--json"))
    return ok(
      JSON.stringify({
        options: [
          {
            id: "mode",
            type: "select",
            value: "acceptEdits",
            values: [{ id: "acceptEdits" }, { id: "bypass" }],
          },
        ],
      }),
    );
  return ok();
}

function makeDeps(overrides: {
  cli?: (args: string[]) => BbCliResult | Promise<BbCliResult>;
  threadsUpdate?: () => Promise<unknown>;
  updatePluginMetadata?: () => Promise<unknown>;
  /** `threads.spawn` impl — default answers `{id:"thr_exec"}`. */
  spawn?: (args: Record<string, unknown>) => Promise<{ id?: string }>;
  /** `threads.list` answer for the label lookup. */
  list?: () => Promise<
    { id: string; title?: string | null; createdAt?: number | null }[]
  >;
  pluginMetadata?: () => Promise<Record<string, unknown> | null>;
  policyText?: string;
  held?: [string, number][];
  /** §4 r30 (в): `system.config().primaryHostId` — default "host_1". */
  primaryHostId?: () => Promise<string>;
} = {}) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  for (const [g, until] of overrides.held ?? []) store.hold(g, until, "test");
  const calls: Call[] = [];
  const cli: BbCli = {
    run: async (args) => {
      calls.push({ args });
      if (overrides.cli) return overrides.cli(args);
      return defaultCli(args);
    },
  };
  const updates: unknown[] = [];
  const stops: string[] = [];
  const spawnArgs: Record<string, unknown>[] = [];
  const metadata: { threadId: string; set: { role: string } }[] = [];
  const deps: DelegateDeps = {
    store,
    bbCli: cli,
    threads: {
      spawn: async (args) => {
        spawnArgs.push(args as unknown as Record<string, unknown>);
        if (overrides.spawn)
          return overrides.spawn(args as unknown as Record<string, unknown>);
        return { id: "thr_exec" };
      },
      list: async () => (overrides.list ? overrides.list() : []),
      getPluginMetadata: async () =>
        overrides.pluginMetadata ? overrides.pluginMetadata() : null,
      update: async (args) => {
        updates.push(args);
        if (overrides.threadsUpdate) return overrides.threadsUpdate();
        return {};
      },
      stop: async ({ threadId }) => {
        stops.push(threadId);
        return {};
      },
      updatePluginMetadata: async (args) => {
        metadata.push(args);
        if (overrides.updatePluginMetadata)
          return overrides.updatePluginMetadata();
        return {};
      },
    },
    loadPolicy: async () =>
      parsePolicy(overrides.policyText ?? POLICY_TEXT, PRESETS),
    probes: {
      delegationByThreadId: (id) => store.byThreadId(id),
      hasFreshDispatching: (s, scope) => store.hasFreshDispatching(s, scope),
      roleByThreadId: (id) => store.threadRole(id)?.role,
    },
    primaryHostId: overrides.primaryHostId ?? (async () => "host_1"),
  };
  return { deps, store, calls, updates, stops, spawnArgs, metadata, db };
}

test("happy path: record → spawn → attach → bypass → running → comment", async () => {
  const { deps, store, calls, updates, spawnArgs } = makeDeps();
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.ok, true);
  assert.equal(res.threadId, "thr_exec");
  assert.equal(res.status, "running");
  assert.deepEqual(res.setupErrors, []);

  const row = store.get(res.delegationId)!;
  assert.equal(row.status, "running");
  assert.equal(row.thread_id, "thr_exec");
  assert.equal(row.task_id, "task-1");
  assert.equal(row.coordinator_thread_id, "thr_coord");

  // §4 r30 (в): the spawn carries parent, hidden, auto notifications and
  // the delegationId label at creation — no tasks dispatch, no update.
  assert.equal(spawnArgs.length, 1);
  const spawn = spawnArgs[0]!;
  assert.equal(spawn.projectId, "proj_bb");
  assert.equal(spawn.parentThreadId, "thr_coord");
  assert.equal(spawn.parentNotifications, "auto");
  assert.equal(spawn.visibility, "hidden");
  assert.deepEqual(spawn.pluginMetadata, { delegationId: row.id });
  assert.equal(spawn.title, "PLUG-1 · do it");
  assert.equal(spawn.providerId, "acp-devin");
  assert.equal(spawn.model, "m1");
  assert.equal(spawn.permissionMode, "full");
  assert.deepEqual(spawn.environment, { type: "project-default" });
  assert.match(String(spawn.prompt), /^# PLUG-1 · do it\n/);
  assert.match(String(spawn.prompt), /## Report-back contract/);
  assert.ok(!calls.some((c) => c.args.join(" ").startsWith("tasks dispatch")));

  const cmds = calls.map((c) => c.args.join(" "));
  assert.ok(cmds.some((c) => c === "tasks show PLUG-1 --json"));
  assert.ok(cmds.some((c) => c === "tasks preset show simple --json"));
  assert.ok(cmds.some((c) => c === "tasks attach PLUG-1 --thread thr_exec"));
  assert.ok(cmds.some((c) => c === "tasks update PLUG-1 --status in_progress"));
  assert.ok(cmds.some((c) => c === "thread show thr_exec --json"));
  // bound at spawn → NO blind updates (r30: no ownership-assigned)
  assert.ok(!cmds.some((c) => c.startsWith("thread update")));
  assert.deepEqual(updates, []);
  assert.ok(cmds.some((c) => c === "thread options thr_exec --json"));
  assert.ok(cmds.some((c) => c === "thread options thr_exec --set mode=bypass"));
  assert.ok(
    cmds.some((c) =>
      c.startsWith("tasks comment PLUG-1") &&
      c.includes("Раздано") &&
      c.includes("пресет simple"),
    ),
  );
});

test("§4 r30 (в): a new-worktree preset maps machineId/baseBranch into the host env", async () => {
  const { deps, spawnArgs } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: {
              ...FULL_PRESET,
              environmentKind: "new-worktree",
              machineId: "host_named",
              baseBranch: "dev",
            },
          }),
        );
      return defaultCli(args);
    },
  });
  await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.deepEqual(spawnArgs[0]!.environment, {
    type: "host",
    hostId: "host_named",
    workspace: {
      type: "managed-worktree",
      baseBranch: { kind: "named", name: "dev" },
    },
  });
});

test("§4 r30 (в): new-worktree without machineId uses primaryHostId + default branch", async () => {
  const { deps, spawnArgs } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: {
              ...FULL_PRESET,
              environmentKind: "new-worktree",
            },
          }),
        );
      return defaultCli(args);
    },
  });
  await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.deepEqual(spawnArgs[0]!.environment, {
    type: "host",
    hostId: "host_1",
    workspace: {
      type: "managed-worktree",
      baseBranch: { kind: "default" },
    },
  });
});

test("§4 r30 (а): a task project without a linked bb project is refused", async () => {
  const { deps, store, spawnArgs } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks show"))
        return ok(
          JSON.stringify({
            task: { id: "task-1", key: "PLUG-1", title: "t", status: "todo" },
            project: { name: "main", linkedBbProjectId: null },
          }),
        );
      return defaultCli(args);
    },
  });
  await assert.rejects(
    runDelegate(
      { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-failed",
  );
  assert.equal(store.list().length, 0);
  assert.equal(spawnArgs.length, 0);
});

test("§4 r30 (е 3): a schema refusal on the parent fields falls back to tasks dispatch", async () => {
  const { deps, store, calls, updates } = makeDeps({
    spawn: async () => {
      const e = new Error(
        'HTTP 400: unrecognized field "parentNotifications" in createThread',
      ) as Error & { code: string | null; status: number };
      e.code = "invalid_request";
      e.status = 400;
      throw e;
    },
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("thread show"))
        // the fallback's dispatch thread is NOT bound at creation
        return ok(
          JSON.stringify({
            thread: {
              parentThreadId: null,
              parentNotifications: "stuck",
              visibility: "visible",
            },
          }),
        );
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.status, "running");
  assert.equal(res.threadId, "thr_exec"); // the fallback's dispatch id
  const row = store.get(res.delegationId)!;
  assert.match(row.setup_errors, /свой запуск недоступен/);
  const cmds = calls.map((c) => c.args.join(" "));
  assert.ok(
    cmds.some((c) => c === "tasks dispatch PLUG-1 --preset simple --json"),
  );
  // the dispatch thread has no binding → the verify re-applies it
  assert.deepEqual(updates, [
    {
      threadId: "thr_exec",
      parentThreadId: "thr_coord",
      visibility: "hidden",
    },
  ]);
  assert.ok(
    cmds.some((c) => c === "thread update thr_exec --parent-notifications auto"),
  );
});

test("§4 r30 (е 2): a non-schema 4xx refusal is final — no dispatch fallback", async () => {
  const { deps, store, calls } = makeDeps({
    spawn: async () => {
      const e = new Error("HTTP 404: model gone") as Error & {
        code: string | null;
        status: number;
        details: { reason: string };
      };
      e.code = "model_unavailable";
      e.status = 404;
      e.details = { reason: "model removed from the provider" };
      throw e;
    },
  });
  await assert.rejects(
    runDelegate(
      { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
      deps,
    ),
    (e: unknown) =>
      (e as OrchestratorError).code === "dispatch-failed" &&
      /model removed/.test((e as OrchestratorError).message),
  );
  assert.equal(store.list().length, 0);
  assert.ok(
    !calls.some((c) => c.args.join(" ").startsWith("tasks dispatch")),
    "explicit refusal → no fallback",
  );
});

test("non-coordinator caller is refused with not-a-coordinator", async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(
    runDelegate(
      {
        taskKey: "PLUG-1",
        level: "simple",
        caller: { ...COORDINATOR, threadId: "thr_exec2", parentThreadId: "thr_coord" },
      },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "not-a-coordinator",
  );
  assert.equal(calls.length, 0);
});

test("a caller recorded in delegations is refused", async () => {
  const { deps, store } = makeDeps();
  store.insert({
    taskKey: "PLUG-9",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
  });
  const row = store.list()[0]!;
  store.setThreadInfo(row.id, "thr_exec2");
  await assert.rejects(
    runDelegate(
      {
        taskKey: "PLUG-1",
        level: "simple",
        caller: { ...COORDINATOR, threadId: "thr_exec2" },
      },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "not-a-coordinator",
  );
});

test("maxActive limit refuses with the current counter", async () => {
  const { deps, store } = makeDeps();
  for (const key of ["PLUG-2", "PLUG-3"]) {
    store.insert({
      taskKey: key,
      coordinatorThreadId: "thr_coord",
      projectId: "proj_main",
      level: "simple",
      route: "simple",
      preset: "simple",
      provider: "p",
    });
  }
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-4", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "limit-exceeded" &&
      /2\/2/.test((e as OrchestratorError).message),
  );
});

test("perLevel limit is checked against the level counter", async () => {
  const { deps, store } = makeDeps();
  store.insert({
    taskKey: "PLUG-2",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "complex",
    route: "complex",
    preset: "complex",
    provider: "p",
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-4", level: "complex", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "limit-exceeded",
  );
});

test("a second delegation of the same task is refused", async () => {
  const { deps, store } = makeDeps();
  store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
  });
  await assert.rejects(
    runDelegate({ taskKey: "plug-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "task-already-delegated",
  );
});

test("two parallel delegates of one task: exactly one wins", async () => {
  const { deps } = makeDeps();
  const enqueue = createDelegateQueue();
  const results = await Promise.allSettled([
    enqueue(() =>
      runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    ),
    enqueue(() =>
      runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    ),
  ]);
  const oks = results.filter((r) => r.status === "fulfilled");
  const fails = results.filter((r) => r.status === "rejected");
  assert.equal(oks.length, 1);
  assert.equal(fails.length, 1);
  assert.equal(
    ((fails[0] as PromiseRejectedResult).reason as OrchestratorError).code,
    "task-already-delegated",
  );
});

test("dispatch failure deletes the record", async () => {
  const { deps, store } = makeDeps({
    spawn: async () => {
      const e = new Error("HTTP 400: no such preset") as Error & {
        code: string | null;
        status: number;
      };
      e.code = "invalid_request";
      e.status = 400;
      throw e;
    },
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-failed",
  );
  assert.equal(store.list().length, 0);
  assert.equal(store.activeByTaskKey("PLUG-1"), undefined);
});

test("attach failure lands in setup_errors and the run still reports", async () => {
  const { deps, store } = makeDeps({
    cli: (args) => {
      if (args.join(" ").startsWith("tasks attach"))
        return { exitCode: 1, stdout: "", stderr: "attach api down" };
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.ok, true);
  assert.ok(res.setupErrors.some((s) => s.step === "tasks-attach"));
  const row = store.get(res.delegationId)!;
  assert.equal(row.status, "running");
  assert.match(row.setup_errors, /tasks-attach/);
});

test("a held route makes the chain fall through to the next route", async () => {
  const future = Date.now() + 60_000;
  const { deps, calls } = makeDeps({ held: [["complex", future]] });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "complex", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.route, "complex-alt");
  assert.ok(
    calls.some((c) =>
      c.args.join(" ").includes("tasks preset show complex-alt"),
    ),
  );
});

test("all routes held → route-unavailable, nothing dispatched", async () => {
  const future = Date.now() + 60_000;
  const { deps, calls } = makeDeps({
    held: [
      ["complex", future],
      ["complex-alt", future],
    ],
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "complex", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "route-unavailable",
  );
  assert.equal(calls.length, 0);
});

test("invalid policy refuses before touching the store", async () => {
  const { deps, calls } = makeDeps({ policyText: "{bad" });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "policy-invalid",
  );
  assert.equal(calls.length, 0);
});

test("non-full presets skip the bypass attempt entirely", async () => {
  const { deps, calls } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: { ...FULL_PRESET, permissionMode: "auto" },
          }),
        );
      return defaultCli(args);
    },
  });
  await runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps);
  const cmds = calls.map((c) => c.args.join(" "));
  assert.ok(!cmds.some((c) => c.includes("--set mode=bypass")));
});

test("thread_id is already recorded when attach runs", async () => {
  const { deps, store } = makeDeps();
  const seen: (string | null | undefined)[] = [];
  const prevRun = deps.bbCli.run.bind(deps.bbCli);
  deps.bbCli.run = async (args, opts) => {
    if (args.join(" ").startsWith("tasks attach")) {
      seen.push(
        store.byThreadId("thr_exec")?.status ??
          store.byThreadId("thr_exec")?.thread_id ??
          null,
      );
    }
    return prevRun(args, opts);
  };
  await runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], "dispatching"); // row exists, status still dispatching
});

test("spawn timeout keeps the record dispatching without thread_id", async () => {
  const { deps, store } = makeDeps({
    spawn: async () => {
      throw new Error("request timed out after 75s");
    },
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-unknown",
  );
  const row = store.activeByTaskKey("PLUG-1");
  assert.equal(row?.status, "dispatching");
  assert.equal(row?.thread_id, null);
});

test("spawn 5xx keeps the record (thread may exist)", async () => {
  const { deps, store } = makeDeps({
    spawn: async () => {
      const e = new Error("HTTP 500: internal") as Error & {
        code: string | null;
        status: number;
      };
      e.code = "internal";
      e.status = 500;
      throw e;
    },
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-unknown",
  );
  assert.equal(store.activeByTaskKey("PLUG-1")?.status, "dispatching");
});

test("spawn answer without a thread id keeps the record", async () => {
  const { deps, store } = makeDeps({
    spawn: async () => ({}),
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-unknown",
  );
  assert.equal(store.activeByTaskKey("PLUG-1")?.status, "dispatching");
});

test("cancel during dispatch: executor stopped, result cancelled", async () => {
  const { deps, store, stops, calls } = makeDeps();
  const prevRun = deps.bbCli.run.bind(deps.bbCli);
  deps.bbCli.run = async (args, opts) => {
    // a cancel lands while the finish steps are in flight
    if (args.join(" ").startsWith("tasks attach")) {
      const row = store.list()[0]!;
      store.setStatus(row.id, "cancelled");
    }
    return prevRun(args, opts);
  };
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.status, "cancelled");
  assert.deepEqual(stops, ["thr_exec"]);
  const row = store.get(res.delegationId)!;
  assert.equal(row.status, "cancelled");
  // no «Раздано» comment for a cancelled dispatch
  assert.ok(!calls.some((c) => c.args.join(" ").startsWith("tasks comment")));
});

test("binding repair failure lands in setup_errors", async () => {
  const { deps, store } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("thread show"))
        return ok(
          JSON.stringify({
            thread: {
              parentThreadId: "thr_coord",
              parentNotifications: "off",
              visibility: "hidden",
            },
          }),
        );
      if (key.startsWith("thread update"))
        return { exitCode: 1, stdout: "", stderr: "boom" };
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.ok, true);
  assert.ok(res.setupErrors.some((e) => e.step === "attach"));
  assert.match(store.get(res.delegationId)!.setup_errors, /attach/);
});

test("bypass step failure lands in setup_errors", async () => {
  let presetShows = 0;
  const { deps, store } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      // the dispatch's own preset read succeeds; the bypass check's
      // second read fails
      if (key.startsWith("tasks preset show") && ++presetShows > 1)
        return { exitCode: 1, stdout: "", stderr: "preset gone" };
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.ok(res.setupErrors.some((e) => e.step === "bypass-mode"));
  assert.equal(store.get(res.delegationId)!.status, "running");
});

test("comment failure lands in setup_errors, run still reported", async () => {
  const { deps, store } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks comment"))
        return { exitCode: 1, stdout: "", stderr: "comments closed" };
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.ok, true);
  assert.ok(res.setupErrors.some((e) => e.step === "comment"));
  assert.equal(store.get(res.delegationId)!.status, "running");
});

test("a ULID resolves to the key before dedup: second delegate refused", async () => {
  const { deps } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks show"))
        return ok(taskShowJson("PLUG-1"));
      return defaultCli(args);
    },
  });
  const first = await runDelegate(
    { taskKey: "01ULIDEXAMPLE00000000000", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(first.taskKey, "PLUG-1");
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "task-already-delegated",
  );
});

test("unresolvable task input is refused before any dispatch", async () => {
  const { deps, calls, store, spawnArgs } = makeDeps({
    cli: (args) =>
      args.join(" ").startsWith("tasks show")
        ? { exitCode: 1, stdout: "", stderr: "task not found" }
        : ok(),
  });
  await assert.rejects(
    runDelegate(
      { taskKey: "01DOESNOTEXIST0000000000000", level: "simple", caller: COORDINATOR },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "task-not-found",
  );
  assert.equal(store.list().length, 0);
  assert.equal(spawnArgs.length, 0);
  assert.ok(!calls.some((c) => c.args.join(" ").startsWith("tasks dispatch")));
});

test("configure during the dispatch window: unlinked executor gets nothing", async () => {
  // Inside the fake `threads.spawn` — the moment BB has created the
  // executor thread but the plugin has not written thread_id yet — the
  // executor's first configure sees only the fresh-dispatching marker.
  const { deps } = makeDeps();
  const executorCtx = makePluginAgentConfigurationContext({
    thread: { id: "thr_exec", title: null, parentThreadId: null },
    origin: { pluginId: null },
    project: { id: "proj_main" },
  });
  let seenInWindow: string[] = [];
  const prevSpawn = deps.threads.spawn.bind(deps.threads);
  deps.threads.spawn = async (args) => {
    const config = buildAgentConfiguration(executorCtx, {
      injectInstructions: true,
      instructionsText: "RULE",
      probes: deps.probes,
    });
    seenInWindow = config.tools.map(String);
    return prevSpawn(args);
  };
  await runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps);
  assert.deepEqual(seenInWindow, []);
  // After the link, the delegations.row marker keeps it an executor.
  const config = buildAgentConfiguration(executorCtx, {
    injectInstructions: true,
    instructionsText: "RULE",
    probes: deps.probes,
  });
  assert.deepEqual(config.tools, []);
});

test("step 4: the executor's role is recorded and mirrored to metadata", async () => {
  const { deps, store, metadata } = makeDeps();
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  const row = store.threadRole("thr_exec")!;
  assert.equal(row.role, "executor");
  assert.equal(row.source, "delegate");
  assert.deepEqual(metadata, [
    { threadId: "thr_exec", set: { role: "executor" } },
  ]);
  void res;
});

test("step 4: review level delegates an auditor, correcting a hook guess", async () => {
  const { deps, store, metadata } = makeDeps({
    policyText: JSON.stringify({
      version: 1,
      levels: { review: { chain: ["simple"] } },
      routes: { simple: { preset: "simple", provider: "p" } },
    }),
  });
  // The hook may already have written `executor` from the bare title.
  store.setThreadRole("thr_exec", "executor", "hook");
  await runDelegate(
    { taskKey: "PLUG-1", level: "review", caller: COORDINATOR },
    deps,
  );
  const row = store.threadRole("thr_exec")!;
  assert.equal(row.role, "auditor");
  assert.equal(row.source, "delegate");
  assert.deepEqual(metadata, [
    { threadId: "thr_exec", set: { role: "auditor" } },
  ]);
});

test("a thread with role executor gets not-a-coordinator through delegate", async () => {
  const { deps, store, calls } = makeDeps();
  store.setThreadRole("thr_exec2", "executor", "hook");
  await assert.rejects(
    runDelegate(
      {
        taskKey: "PLUG-1",
        level: "simple",
        // executor-looking facts are absent on purpose — the role alone refuses
        caller: { ...COORDINATOR, threadId: "thr_exec2" },
      },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "not-a-coordinator",
  );
  assert.equal(calls.length, 0);
});

test("a thread with role orchestrator delegates despite executor markers", async () => {
  const { deps, store } = makeDeps();
  store.setThreadRole("thr_exec2", "orchestrator", "hook");
  const res = await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "simple",
      caller: { ...COORDINATOR, threadId: "thr_exec2", parentThreadId: "thr_p" },
    },
    deps,
  );
  assert.equal(res.ok, true);
});

test("a failed role-metadata write lands in setup_errors and retries", async () => {
  let fail = true;
  const { deps, store, metadata } = makeDeps({
    updatePluginMetadata: async () => {
      if (fail) throw new Error("metadata endpoint down");
      return {};
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.ok(res.setupErrors.some((e) => e.step === "role-metadata"));
  assert.equal(store.get(res.delegationId)!.status, "running");
  // reconcile retries it; a success clears the recorded error
  fail = false;
  const retried = await retrySetupSteps(store.get(res.delegationId)!, deps);
  assert.deepEqual(retried, []);
  assert.equal(
    store.findSetupError(store.get(res.delegationId)!, "role-metadata"),
    undefined,
  );
  assert.equal(metadata.length, 2);
});

test("dispatch refusal naming a removed model holds the route (§5.3 r19)", async () => {
  const { deps, store } = makeDeps({
    spawn: async () => {
      const e = new Error("HTTP 400: spawn refused") as Error & {
        code: string | null;
        status: number;
        details: { reason: string };
      };
      e.code = "invalid_params";
      e.status = 400;
      e.details = { reason: "Invalid params: model not found: m-9" };
      throw e;
    },
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-failed",
  );
  assert.ok(
    store.heldGroups(Date.now()).has("simple"),
    "route name on hold for 15 minutes",
  );
  assert.equal(store.list().length, 0); // refusal still removes the record

  // the next delegate skips the held route → route-unavailable for a
  // single-route level
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-2", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "route-unavailable",
  );
});

test("dispatch refusal without a model pattern holds nothing", async () => {
  const { deps, store } = makeDeps({
    spawn: async () => {
      const e = new Error("HTTP 400: no such preset") as Error & {
        code: string | null;
        status: number;
      };
      e.code = "invalid_params";
      e.status = 400;
      throw e;
    },
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
  );
  assert.equal(store.heldGroups(Date.now()).size, 0);
});


// ── §2.3 r24: --route anywhere, --preset one-off, reviewByLevel ───────

test("§2.3 --route outside the level chain dispatches that route", async () => {
  const { deps, store } = makeDeps();
  const res = await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "complex",
      route: "simple",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(res.route, "simple");
  const row = store.listActive()[0]!;
  assert.equal(row.route, "simple");
  assert.equal(row.preset, "simple");
  assert.equal(row.level, "complex");
  assert.equal(row.explicit_route, 1, "explicit --route marks the row");
});

test("§2.3 --route and --preset are mutually exclusive", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    runDelegate(
      {
        taskKey: "PLUG-1",
        level: "simple",
        route: "simple",
        preset: "one-off",
        caller: COORDINATOR,
      },
      deps,
    ),
    (e: unknown) =>
      (e as OrchestratorError).code === "incompatible-flags",
  );
});

test("§2.3 --preset: one-off preset → route preset:<name>, provider recorded", async () => {
  const { deps, store, calls, spawnArgs } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: {
              ...FULL_PRESET,
              providerId: "acp-opencode",
              permissionMode: "auto",
            },
          }),
        );
      if (key.startsWith("thread options"))
        return ok(JSON.stringify({ options: [] }));
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "complex",
      preset: "one-off",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(res.route, "preset:one-off");
  const row = store.listActive()[0]!;
  assert.equal(row.route, "preset:one-off");
  assert.equal(row.preset, "one-off");
  assert.equal(row.provider, "acp-opencode");
  assert.ok(
    calls.some((c) =>
      c.args.join(" ").includes("tasks preset show one-off"),
    ),
    "the dispatch reads the one-off preset",
  );
  assert.equal(spawnArgs.length, 1);
});

test("§2.3 --preset: unknown preset refused before any dispatch", async () => {
  const { deps, calls } = makeDeps({
    cli: (args) => {
      if (args.join(" ").startsWith("tasks preset show"))
        return { exitCode: 1, stdout: "", stderr: "preset not found" };
      return ok();
    },
  });
  await assert.rejects(
    runDelegate(
      {
        taskKey: "PLUG-1",
        level: "complex",
        preset: "ghost",
        caller: COORDINATOR,
      },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "unknown-preset",
  );
  assert.ok(
    !calls.some((c) => c.args.join(" ").startsWith("tasks dispatch")),
  );
});

test("§2.3 --preset: held group of a same-provider+model route refuses it", async () => {
  // "complex" (acp-devin, model m1) shares the one-off's provider AND
  // model → its group joins the one-off's holds; "complex" held → refuse.
  const { deps } = makeDeps({
    held: [["complex", Date.now() + 60_000]],
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: { providerId: "acp-devin", modelId: "m1" },
          }),
        );
      if (key.startsWith("tasks preset list"))
        return ok(
          JSON.stringify({
            presets: [
              { name: "one-off", providerId: "acp-devin", modelId: "m1" },
              { name: "complex", providerId: "acp-devin", modelId: "m1" },
              { name: "complex-alt", providerId: "agy", modelId: "m2" },
              { name: "simple", providerId: "acp-opencode", modelId: "m3" },
            ],
          }),
        );
      return ok();
    },
  });
  await assert.rejects(
    runDelegate(
      {
        taskKey: "PLUG-1",
        level: "complex",
        preset: "one-off",
        caller: COORDINATOR,
      },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "route-held",
  );
});

test("§2.3 --preset: a same-provider route on ANOTHER model stays open", async () => {
  // Same scenario but the one-off runs model m9 — "complex" (m1) is a
  // different quota pool, so its hold does not block the dispatch.
  const { deps, store } = makeDeps({
    held: [["complex", Date.now() + 60_000]],
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: {
              ...FULL_PRESET,
              providerId: "acp-devin",
              modelId: "m9",
              permissionMode: "auto",
            },
          }),
        );
      if (key.startsWith("tasks preset list"))
        return ok(
          JSON.stringify({
            presets: [
              { name: "one-off", providerId: "acp-devin", modelId: "m9" },
              { name: "complex", providerId: "acp-devin", modelId: "m1" },
            ],
          }),
        );
      if (key.startsWith("thread options"))
        return ok(JSON.stringify({ options: [] }));
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "complex",
      preset: "one-off",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(res.route, "preset:one-off");
  assert.equal(store.listActive()[0]!.route, "preset:one-off");
});

const REVIEW_POLICY = (() => {
  const p = JSON.parse(POLICY_TEXT);
  p.levels["review-mid"] = { role: "auditor", chain: ["simple"] };
  p.levels.review = { chain: ["simple"] };
  p.reviewByLevel = { simple: "review-mid" };
  return JSON.stringify(p);
})();

test("§2.3 reviewByLevel: bare --level review maps to the executor's auditor level", async () => {
  const { deps, store, calls } = makeDeps({ policyText: REVIEW_POLICY });
  const exec = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "acp-opencode",
  });
  store.setStatus(exec.id, "done");
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "review", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.level, "review-mid");
  assert.match(
    res.note ?? "",
    /review → review-mid по сложности исполнения simple/,
  );
  const row = store.listActive()[0]!;
  assert.equal(row.level, "review-mid");
  assert.ok(
    calls.some((c) =>
      c.args.join(" ").includes("review → review-mid по сложности исполнения simple"),
    ),
    "the task comment should carry the mapping note",
  );
  // The auditor level binds the auditor role.
  assert.equal(store.threadRole("thr_exec")?.role, "auditor");
});

test("§2.3 reviewByLevel: executor level missing from the map → stays review", async () => {
  // PLUG-182: the LATEST executor delegation decides — `complex` is not
  // in the map, so the review stays on `review`, not the older match.
  const { deps, store } = makeDeps({ policyText: REVIEW_POLICY });
  for (const lvl of ["simple", "complex"]) {
    const row = store.insert({
      taskKey: "PLUG-1",
      projectId: "proj_main",
      coordinatorThreadId: "thr_coord",
      level: lvl,
      route: "simple",
      preset: "simple",
      provider: "acp-opencode",
    });
    store.setStatus(row.id, "done");
  }
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "review", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.level, "review");
  assert.equal(res.note, undefined);
});

test("§2.3 reviewByLevel: a newer auditor delegation does not hide the executor", async () => {
  // The map looks at the latest EXECUTOR delegation — an auditor
  // delegation in between does not change the mapped level.
  const { deps, store } = makeDeps({ policyText: REVIEW_POLICY });
  const exec = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "acp-opencode",
  });
  store.setStatus(exec.id, "done");
  const audit = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review-mid",
    route: "simple",
    preset: "simple",
    provider: "acp-opencode",
  });
  store.setStatus(audit.id, "done");
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "review", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.level, "review-mid");
  assert.match(
    res.note ?? "",
    /review → review-mid по сложности исполнения simple/,
  );
});

test("§2.3 reviewByLevel: a release-audit delegation is not the executor", async () => {
  // PLUG-186: release.ts stores its audit delegation under the
  // `release-audit` level — roleForLevel maps it to release-auditor, not
  // executor, so the map still sees the earlier executor delegation.
  const { deps, store } = makeDeps({ policyText: REVIEW_POLICY });
  const exec = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "acp-opencode",
  });
  store.setStatus(exec.id, "done");
  const audit = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "release-audit",
    route: "simple",
    preset: "simple",
    provider: "acp-opencode",
  });
  store.setStatus(audit.id, "done");
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "review", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.level, "review-mid");
  assert.match(
    res.note ?? "",
    /review → review-mid по сложности исполнения simple/,
  );
});

test("§2.3 reviewByLevel: --route/--preset keep the caller's level (no mapping)", async () => {
  const { deps, store } = makeDeps({ policyText: REVIEW_POLICY });
  const exec = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "acp-opencode",
  });
  store.setStatus(exec.id, "done");
  const res = await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "review",
      route: "simple",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(res.level, "review");
  assert.equal(res.note, undefined);
});

// ── §17 r26 ──────────────────────────────────────────────────────────

test("§17.3 (мелко 3): --level release-audit is refused — the pipeline alone assigns it", async () => {
  const { deps, calls, spawnArgs } = makeDeps();
  await assert.rejects(
    runDelegate(
      { taskKey: "PLUG-1", level: "release-audit", caller: COORDINATOR },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "level-forbidden",
  );
  assert.equal(spawnArgs.length, 0);
  assert.equal(
    calls.filter((c) => c.args.join(" ").startsWith("tasks dispatch")).length,
    0,
  );
});

test("§17.3 (мелко 3): --preset still checks the level against the policy", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    runDelegate(
      {
        taskKey: "PLUG-1",
        level: "nonexistent",
        preset: "oneoff",
        caller: COORDINATOR,
      },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "unknown-level",
  );
});

test("§17.2 (e2e 2): round numbers count executor-role delegations only", async () => {
  const { deps, store } = makeDeps();
  // Round 1: an executor finished; a review (auditor-role) delegation ran
  // after it — the NEXT executor round is 2, not 3.
  const execRow = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
    round: 1,
  });
  store.setStatus(execRow.id, "done");
  const reviewRow = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "review",
    route: "simple",
    preset: "simple",
    provider: "p",
    round: 1,
  });
  store.setStatus(reviewRow.id, "done");
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.ok, true);
  assert.equal(store.get(res.delegationId)!.round, 2);
});

test("§17.2 (e2e 6): a dispatch refusal comments the reason on the task", async () => {
  const { deps, calls } = makeDeps({
    spawn: async () => {
      const e = new Error(
        "HTTP 400: spawn refused",
      ) as Error & { code: string | null; status: number; details: { reason: string } };
      e.code = "invalid_params";
      e.status = 400;
      e.details = { reason: 'reasoning level "extreme" unknown' };
      throw e;
    },
  });
  await assert.rejects(
    runDelegate(
      { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-failed",
  );
  const comment = calls.find(
    (c) =>
      c.args.join(" ").startsWith("tasks comment PLUG-1") &&
      c.args.join(" ").includes("отклонена"),
  );
  assert.ok(comment, "the refusal reason is recorded as a task comment");
  assert.ok(comment!.args.join(" ").includes("reasoning level"));
});

test("§17.2 (мелко 4): the reissue route budget is per round, not per task", async () => {
  const { store } = makeDeps();
  const r1 = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
    round: 1,
  });
  store.setStatus(r1.id, "stalled");
  const r1b = store.reissue(r1.id, {
    route: "simple-alt",
    preset: "preset-alt",
    provider: "agy",
  })!;
  store.setStatus(r1b.id, "done");
  const r2 = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
    round: 2,
  });
  store.setStatus(r2.id, "stalled");
  const r2b = store.reissue(r2.id, {
    route: "complex",
    preset: "preset-c",
    provider: "agy",
  })!;
  assert.deepEqual(
    [...store.routesUsedByTask("PLUG-1", 1)].sort(),
    ["simple-alt"],
    "round 1 sees only its own auto-reissues",
  );
  assert.deepEqual(
    [...store.routesUsedByTask("PLUG-1", 2)].sort(),
    ["complex"],
  );
  assert.deepEqual(
    [...store.routesUsedByTask("PLUG-1")].sort(),
    ["complex", "simple-alt"],
    "the unscoped call still answers every reissue",
  );
  assert.ok(r2b.id > r1b.id);
});

test("§17.2 r26 (PLUG-211 С2/мелко 2): the reissue reserve counts one reissue CHAIN", () => {
  const { store } = makeDeps();
  // executor chain at round 1: root `simple`, its auto-reissue burned
  // `simple-alt`
  const exec = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
    round: 1,
  });
  store.setStatus(exec.id, "stalled");
  const re1 = store.reissue(exec.id, {
    route: "simple-alt",
    preset: "preset-alt",
    provider: "agy",
  })!;
  store.setStatus(re1.id, "stalled");
  // a review chain in the SAME round number — review and audit rows
  // share the executor's round space (§17.2 e2e 2) but form their own
  // chain: their burned route must not eat the executor's reserve.
  const review = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "review",
    route: "strict",
    preset: "strict",
    provider: "p",
    round: 1,
  });
  store.setStatus(review.id, "stalled");
  const re2 = store.reissue(review.id, {
    route: "simple",
    preset: "simple",
    provider: "p",
  })!;
  store.setStatus(re2.id, "stalled");

  assert.deepEqual(
    [...store.chainUsedRoutes(store.get(re1.id)!, { reissuesOnly: true })].sort(),
    ["simple-alt"],
    "the executor chain sees only its own auto-reissues — the review's `simple` reissue does not eat its reserve",
  );
  assert.deepEqual(
    [...store.chainUsedRoutes(store.get(re2.id)!, { reissuesOnly: true })].sort(),
    ["simple"],
    "the review chain counts its own reissue",
  );
  assert.deepEqual(
    [...store.chainUsedRoutes(store.get(re1.id)!)].sort(),
    ["simple", "simple-alt"],
    "the explicit-restart rule counts the whole chain (root included)",
  );
});

// ── §4.1 r28 (PLUG-237): «задача без кода» --no-code ──────────────────

test("§4.1 r28: --no-code marks the row and adds the no-code instruction line", async () => {
  const { deps, store, spawnArgs } = makeDeps();
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", noCode: true, caller: COORDINATOR },
    deps,
  );
  assert.equal(res.ok, true);
  const row = store.get(res.delegationId)!;
  assert.equal(row.no_code, 1);
  assert.match(
    String(spawnArgs[0]!.prompt),
    /задача без кода: файлы репозитория не менять, не коммитить; итог — отчёт/,
  );
});

test("§4.1 r28: a delegate without the flag is an ordinary dispatch", async () => {
  const { deps, store, spawnArgs } = makeDeps();
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(store.get(res.delegationId)!.no_code, 0);
  assert.doesNotMatch(String(spawnArgs[0]!.prompt), /задача без кода/);
});

test("§4.1 r28: a new delegate without the flag resets the mark", async () => {
  const { deps, store } = makeDeps();
  const first = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", noCode: true, caller: COORDINATOR },
    deps,
  );
  assert.equal(store.get(first.delegationId)!.no_code, 1);
  store.setStatus(first.delegationId, "done");
  const second = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(
    store.get(second.delegationId)!.no_code,
    0,
    "заход 2 без флага — снова обычная раздача",
  );
});

test("§4.1 r28: a reissue inherits no_code, a second hop keeps it", async () => {
  const { deps, store, spawnArgs } = makeDeps();
  const row = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
    noCode: true,
  });
  store.setStatus(row.id, "stalled");
  const re1 = store.reissue(row.id, {
    route: "simple",
    preset: "simple",
    provider: "p",
  })!;
  assert.equal(re1.no_code, 1, "reissue inherits the mark");
  // the reissued dispatch also carries the instruction line
  await dispatchToRoute(re1, {}, deps);
  assert.match(String(spawnArgs.at(-1)!.prompt), /задача без кода/);
  // a second hop in the chain keeps it too
  store.setStatus(re1.id, "stalled");
  const re2 = store.reissue(re1.id, {
    route: "simple",
    preset: "simple",
    provider: "p",
  })!;
  assert.equal(re2.no_code, 1);
});

test("§4 r30 (б): the seed prompt repeats BB's buildSeedPrompt sections in order", () => {
  const prompt = buildSeedPrompt({
    task: { key: "PLUG-1", title: "do it", description: "the body" },
    project: { name: "main", linkedBbProjectId: "proj_bb" },
    subtasks: [{ key: "PLUG-2", title: "sub", status: "todo" }],
    attachments: [{ fileName: "spec.md", id: "att_1" }],
    recentComments: [
      {
        authorName: "cli",
        kind: "user",
        createdAt: "2026-11-12",
        body: "note",
      },
    ],
    presetInstructions: "preset line",
    extraInstructions: "extra line",
  });
  assert.match(prompt, /^# PLUG-1 · do it\n/);
  const order = [
    "## Description",
    "## Project context",
    "## Sub-tasks",
    "## Attachments",
    "## Recent comments",
    "## Report-back contract",
    "## Preset instructions",
    "## Additional instructions",
  ];
  let at = -1;
  for (const section of order) {
    const i = prompt.indexOf(section);
    assert.ok(i > at, `${section} must be present and in order`);
    at = i;
  }
  // attachments are listed with the fetch line, never downloaded
  assert.match(
    prompt,
    /- spec\.md · att_1\n {2}Fetch with: bb tasks attachment get att_1 --out <path>/,
  );
  assert.match(prompt, /- PLUG-2 · sub \(todo\)/);
  assert.match(prompt, /### cli · user · 2026-11-12\n\nnote/);
  assert.match(prompt, /- Name: main\n- Linked bb project: proj_bb/);
});

test("§4 r30 (б): empty seed sections collapse; optional ones are absent", () => {
  const prompt = buildSeedPrompt({
    task: { key: "PLUG-1", title: "t" },
    project: {},
    subtasks: [],
    attachments: [],
    recentComments: [],
  });
  assert.match(prompt, /## Description\n\nNo description provided\./);
  assert.match(prompt, /## Sub-tasks\n\nNone\./);
  assert.match(prompt, /## Attachments\n\nNone\./);
  assert.match(prompt, /## Recent comments\n\nNone\./);
  assert.match(prompt, /- Linked bb project: Not linked/);
  assert.ok(!prompt.includes("## Preset instructions"));
  assert.ok(!prompt.includes("## Additional instructions"));
});

test("§4 r30 (б): truncateToWidth clips by display width — CJK and emoji count 2", () => {
  assert.equal(truncateToWidth("abc", 2), "ab");
  assert.equal(truncateToWidth("", 120), "");
  // a wide grapheme past the limit is dropped whole, never halved
  assert.equal(truncateToWidth("ab界c", 3), "ab");
  assert.equal(truncateToWidth("ab界c", 4), "ab界");
  assert.equal(truncateToWidth("a🚀b", 2), "a");
  assert.equal(truncateToWidth("a🚀b", 3), "a🚀");
  // the delegated title is `KEY · title` at display width <= 120
  const long = delegatedThreadTitle("PLUG-1", "x".repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.startsWith("PLUG-1 · "));
  const cjk = delegatedThreadTitle("PLUG-1", "界".repeat(200));
  // 9 ASCII + 55 wide graphemes = display width 119 <= 120
  assert.equal(cjk, `PLUG-1 · ${"界".repeat(55)}`);
});

test("§4 r30 (а): a preset without modelId/reasoningLevel still spawns — BB defaults apply", async () => {
  const { deps, spawnArgs } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: {
              providerId: "acp-devin",
              modelId: null,
              reasoningLevel: null,
              permissionMode: "full",
              environmentKind: "project-default",
            },
          }),
        );
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.status, "running");
  assert.equal(spawnArgs.length, 1);
  // the fields are left unset, not refused — BB picks the defaults
  assert.equal(spawnArgs[0]!.model, undefined);
  assert.equal(spawnArgs[0]!.reasoningLevel, undefined);
  assert.equal(spawnArgs[0]!.providerId, "acp-devin");
});

test("§4 r30 (в): a system.config failure is dispatch-unknown — spawn never attempted", async () => {
  const { deps, store, spawnArgs } = makeDeps({
    primaryHostId: async () => {
      throw new Error("system.config unavailable");
    },
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: { ...FULL_PRESET, environmentKind: "new-worktree" },
          }),
        );
      return defaultCli(args);
    },
  });
  await assert.rejects(
    runDelegate(
      { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-unknown",
  );
  // the row stays dispatching without thread_id for the §7 reconcile
  const rows = store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "dispatching");
  assert.equal(rows[0]!.thread_id, null);
  assert.equal(spawnArgs.length, 0);
});

test("§4 r30 (в): an empty primaryHostId is an explicit refusal", async () => {
  const { deps, store, spawnArgs } = makeDeps({
    primaryHostId: async () => "",
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: { ...FULL_PRESET, environmentKind: "new-worktree" },
          }),
        );
      return defaultCli(args);
    },
  });
  await assert.rejects(
    runDelegate(
      { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
      deps,
    ),
    (e: unknown) =>
      (e as OrchestratorError).code === "dispatch-failed" &&
      /no default machine/.test((e as OrchestratorError).message),
  );
  assert.equal(store.list().length, 0);
  assert.equal(spawnArgs.length, 0);
});

test("§4 r30 п.4: a thread show read error performs NO threads.update", async () => {
  const { deps, updates, calls, store } = makeDeps({
    cli: (args) => {
      if (args.join(" ").startsWith("thread show"))
        return { exitCode: 1, stdout: "", stderr: "server down" };
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  // the read failure is a setup error, not a dispatch failure — but a
  // blind update would send ownership-assigned, so none may happen
  assert.equal(res.status, "running");
  assert.ok(res.setupErrors.some((s) => s.step === "attach"));
  assert.deepEqual(updates, []);
  assert.ok(
    !calls.some((c) => c.args.join(" ").startsWith("thread update")),
    "no CLI re-apply either",
  );
  assert.match(store.get(res.delegationId)!.setup_errors, /"attach"/);
});

test("§4 r30 (г): a failed tasks-attach is retried by retrySetupSteps", async () => {
  let attachCalls = 0;
  const { deps, store, calls } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks attach")) {
        attachCalls++;
        if (attachCalls === 1)
          return { exitCode: 1, stdout: "", stderr: "db locked" };
      }
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.status, "running");
  assert.ok(res.setupErrors.some((s) => s.step === "tasks-attach"));

  const retried = await retrySetupSteps(
    store.get(res.delegationId)!,
    deps,
  );
  assert.equal(attachCalls, 2, "the reconcile retried the attach");
  assert.deepEqual(retried, []);
  assert.doesNotMatch(
    store.get(res.delegationId)!.setup_errors,
    /tasks-attach/,
  );
  assert.ok(
    calls.some(
      (c) => c.args.join(" ") === "tasks update PLUG-1 --status in_progress",
    ),
    "the retried attach also moves the task to in_progress",
  );
});

test("§4 r30 (е 2): a record gone mid-dispatch still stops the spawned thread", async () => {
  let st: import("../src/store.js").DelegationStore;
  const h = makeDeps({
    cli: (args) => {
      // the record vanishes mid-dispatch (a remove that is NOT a cancel)
      if (args.join(" ").startsWith("tasks attach")) {
        const row = st.list()[0];
        if (row) st.remove(row.id);
      }
      return defaultCli(args);
    },
  });
  st = h.store;
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    h.deps,
  );
  assert.deepEqual(h.stops, ["thr_exec"], "unsupervised executor stopped");
  assert.ok(res.setupErrors.some((s) => s.step === "finalize"));
});
