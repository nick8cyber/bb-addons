import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import {
  runDelegate,
  createDelegateQueue,
  retrySetupSteps,
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

function makeDeps(overrides: {
  cli?: (args: string[]) => BbCliResult | Promise<BbCliResult>;
  threadsUpdate?: () => Promise<unknown>;
  updatePluginMetadata?: () => Promise<unknown>;
  policyText?: string;
  held?: [string, number][];
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
      const key = args.join(" ");
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ task: { id: "task-1" }, preset: {}, threadId: "thr_exec" }));
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: { permissionMode: "full", providerId: "acp-devin" },
          }),
        );
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
    },
  };
  const updates: unknown[] = [];
  const stops: string[] = [];
  const metadata: { threadId: string; set: { role: string } }[] = [];
  const deps: DelegateDeps = {
    store,
    bbCli: cli,
    threads: {
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
  };
  return { deps, store, calls, updates, stops, metadata, db };
}

test("happy path: record → dispatch → attach → bypass → running → comment", async () => {
  const { deps, store, calls, updates } = makeDeps();
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

  const cmds = calls.map((c) => c.args.join(" "));
  assert.ok(cmds.some((c) => c === "tasks dispatch PLUG-1 --preset simple --json"));
  assert.ok(cmds.some((c) => c === "thread update thr_exec --parent-notifications auto"));
  assert.ok(cmds.some((c) => c === "thread options thr_exec --json"));
  assert.ok(cmds.some((c) => c === "thread options thr_exec --set mode=bypass"));
  assert.ok(
    cmds.some((c) =>
      c.startsWith("tasks comment PLUG-1") && c.includes("Раздано"),
    ),
  );
  assert.deepEqual(updates, [
    { threadId: "thr_exec", parentThreadId: "thr_coord", visibility: "hidden" },
  ]);
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
    cli: (args) =>
      args.join(" ").startsWith("tasks dispatch")
        ? { exitCode: 1, stdout: "", stderr: "no such preset" }
        : ok(),
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
    threadsUpdate: () => Promise.reject(new Error("sdk down")),
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.ok, true);
  assert.ok(res.setupErrors.some((s) => s.step === "attach"));
  const row = store.get(res.delegationId)!;
  assert.equal(row.status, "running");
  assert.match(row.setup_errors, /attach/);
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
    calls.some((c) => c.args.join(" ").includes("--preset complex-alt")),
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
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ threadId: "thr_exec" }));
      if (key.startsWith("tasks preset show"))
        return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
      return ok();
    },
  });
  await runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps);
  const cmds = calls.map((c) => c.args.join(" "));
  assert.ok(!cmds.some((c) => c.includes("--set mode=bypass")));
});

test("thread_id is already recorded when attach runs", async () => {
  const { deps, store } = makeDeps();
  const seen: (string | null | undefined)[] = [];
  deps.threads.update = async () => {
    seen.push(store.byThreadId("thr_exec")?.status ?? store.byThreadId("thr_exec")?.thread_id ?? null);
    return {};
  };
  await runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], "dispatching"); // row exists, status still dispatching
});

test("dispatch timeout keeps the record dispatching without thread_id", async () => {
  const { deps, store } = makeDeps({
    cli: (args) =>
      args.join(" ").startsWith("tasks dispatch")
        ? { exitCode: 1, stdout: "", stderr: "timed out after 120000ms", timedOut: true }
        : ok(),
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-unknown",
  );
  const row = store.activeByTaskKey("PLUG-1");
  assert.equal(row?.status, "dispatching");
  assert.equal(row?.thread_id, null);
});

test("non-JSON dispatch answer keeps the record (thread may exist)", async () => {
  const { deps, store } = makeDeps({
    cli: (args) =>
      args.join(" ").startsWith("tasks dispatch") ? ok("not json") : ok(),
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-unknown",
  );
  assert.equal(store.activeByTaskKey("PLUG-1")?.status, "dispatching");
});

test("dispatch answer without threadId keeps the record", async () => {
  const { deps, store } = makeDeps({
    cli: (args) =>
      args.join(" ").startsWith("tasks dispatch")
        ? ok(JSON.stringify({ task: { id: "t" }, preset: {} }))
        : ok(),
  });
  await assert.rejects(
    runDelegate({ taskKey: "PLUG-1", level: "simple", caller: COORDINATOR }, deps),
    (e: unknown) => (e as OrchestratorError).code === "dispatch-unknown",
  );
  assert.equal(store.activeByTaskKey("PLUG-1")?.status, "dispatching");
});

test("cancel during dispatch: executor stopped, result cancelled", async () => {
  const { deps, store, stops, calls } = makeDeps();
  deps.threads.update = async () => {
    // a cancel lands while dispatch is in flight
    const row = store.list()[0]!;
    store.setStatus(row.id, "cancelled");
    return {};
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

test("parent-notifications failure lands in setup_errors", async () => {
  const { deps, store } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ threadId: "thr_exec" }));
      if (key.startsWith("thread update"))
        return { exitCode: 1, stdout: "", stderr: "boom" };
      return ok();
    },
  });
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.ok, true);
  assert.ok(res.setupErrors.some((e) => e.step === "parent-notifications"));
  assert.match(store.get(res.delegationId)!.setup_errors, /parent-notifications/);
});

test("bypass step failure lands in setup_errors", async () => {
  const { deps, store } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ threadId: "thr_exec" }));
      if (key.startsWith("tasks preset show"))
        return { exitCode: 1, stdout: "", stderr: "preset gone" };
      return ok();
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
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ threadId: "thr_exec" }));
      if (key.startsWith("tasks comment"))
        return { exitCode: 1, stdout: "", stderr: "comments closed" };
      return ok();
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
        return ok(JSON.stringify({ task: { key: "PLUG-1", id: "01ULIDEXAMPLE00000000000" } }));
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ task: { id: "01ULIDEXAMPLE00000000000" }, threadId: "thr_exec" }));
      return ok();
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
  const { deps, calls, store } = makeDeps({
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
  assert.ok(!calls.some((c) => c.args.join(" ").startsWith("tasks dispatch")));
});

test("configure during the dispatch window: unlinked executor gets nothing", async () => {
  // Inside the fake `tasks dispatch` — the moment BB has created the
  // executor thread but the plugin has not written thread_id yet — the
  // executor's first configure sees only the fresh-dispatching marker.
  const { deps } = makeDeps();
  const executorCtx = makePluginAgentConfigurationContext({
    thread: { id: "thr_exec", title: null, parentThreadId: null },
    origin: { pluginId: null },
    project: { id: "proj_main" },
  });
  let seenInWindow: string[] = [];
  const prevRun = deps.bbCli.run.bind(deps.bbCli);
  deps.bbCli.run = async (args, opts) => {
    if (args.join(" ").startsWith("tasks dispatch")) {
      const config = buildAgentConfiguration(executorCtx, {
        injectInstructions: true,
        instructionsText: "RULE",
        probes: deps.probes,
      });
      seenInWindow = config.tools.map(String);
    }
    return prevRun(args, opts);
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
    cli: (args) =>
      args.join(" ").startsWith("tasks dispatch")
        ? { exitCode: 1, stdout: "", stderr: "Invalid params: model not found: m-9" }
        : ok(),
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
    cli: (args) =>
      args.join(" ").startsWith("tasks dispatch")
        ? { exitCode: 1, stdout: "", stderr: "no such preset" }
        : ok(),
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
  const { deps, store, calls } = makeDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: { providerId: "acp-opencode", permissionMode: "auto" },
          }),
        );
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ task: { id: "t1" }, threadId: "thr_p" }));
      if (key.startsWith("thread options"))
        return ok(JSON.stringify({ options: [] }));
      return ok();
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
    calls.some((c) => c.args.join(" ").includes("--preset one-off")),
    "dispatch should use the preset name",
  );
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
            preset: { providerId: "acp-devin", modelId: "m9" },
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
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ task: { id: "t1" }, threadId: "thr_p" }));
      if (key.startsWith("thread options"))
        return ok(JSON.stringify({ options: [] }));
      return ok();
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
