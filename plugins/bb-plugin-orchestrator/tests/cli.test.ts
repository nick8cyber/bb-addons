import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import { createPlugin } from "../server.js";

const POLICY_TEXT = JSON.stringify({
  version: 1,
  limits: { maxActive: 5 },
  levels: { simple: { chain: ["simple"] } },
  routes: { simple: { preset: "simple", provider: "acp-opencode" } },
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
        const custom = respond?.(args);
        if (custom) return custom;
        if (args.join(" ").startsWith("tasks preset list"))
          return ok(JSON.stringify({ presets: [{ name: "simple", id: "p1" }] }));
        if (args.join(" ").startsWith("provider-retry status"))
          return ok(JSON.stringify({ retries: [] }));
        return ok();
      },
    },
  };
}

async function hostWith(
  settings: Record<string, string | boolean> = {},
  cli: BbCli = fakeCli().cli,
  sdk: NonNullable<Parameters<typeof createFakePluginHost>[0]>["sdk"] = {},
  now?: () => number,
) {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    settings: { policy: POLICY_TEXT, ...settings },
    agentSkillIds: ["orchestrator-setup", "orchestrator-coordinator"],
    sdk,
  });
  await createPlugin(host.bb, { bbCli: cli, ...(now ? { now } : {}) });
  return host;
}

test("empty policy reports needs-configuration at load", async () => {
  const host = await hostWith({ policy: "" });
  assert.ok(host.harness.needsConfigurationMessages.length > 0);
  assert.match(
    host.harness.needsConfigurationMessages[0] ?? "",
    /policy|политика/i,
  );
});

test("configure wires the registered tools for a coordinator thread", async () => {
  const host = await hostWith();
  const resolved = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({}),
  );
  assert.deepEqual(
    resolved.tools.map((t) => t.name).sort(),
    [
      "orchestrator_cancel",
      "orchestrator_delegate",
      "orchestrator_merge",
      "orchestrator_status",
    ],
  );
  assert.match(resolved.instructions ?? "", /delegate/);
});

test("configure gives an executor-shaped thread nothing", async () => {
  const host = await hostWith();
  const resolved = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { parentThreadId: "thr_parent" },
    }),
  );
  assert.deepEqual(resolved.tools, []);
  assert.equal(resolved.instructions, null);
});

test("CLI delegate from an executor thread is refused not-a-coordinator", async () => {
  const host = await hostWith({}, fakeCli().cli, {
    threads: {
      get: async () => ({
        id: "thr_exec",
        parentThreadId: "thr_coord",
        title: "PLUG-1 · do it",
        titleFallback: null,
        originPluginId: "tasks",
        projectId: "proj_main",
      }),
    },
  });
  const res = await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    { threadId: "thr_exec" },
  );
  assert.equal(res.exitCode, 1);
  const body = JSON.parse(res.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "not-a-coordinator");
});

test("CLI delegate without a calling thread is refused", async () => {
  const host = await hostWith();
  const res = await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    {},
  );
  assert.equal(res.exitCode, 1);
  const body = JSON.parse(res.stdout) as { error: { code: string } };
  assert.equal(body.error.code, "no-caller-thread");
});

test("CLI delegate end-to-end through the fake host", async () => {
  const { cli, calls } = fakeCli((args) => {
    if (args.join(" ").startsWith("tasks dispatch"))
      return ok(JSON.stringify({ task: { id: "t1" }, threadId: "thr_exec" }));
    if (args.join(" ").startsWith("tasks preset show"))
      return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
    return undefined;
  });
  const updates: unknown[] = [];
  const host = await hostWith({}, cli, {
    threads: {
      get: async () => ({
        id: "thr_coord",
        parentThreadId: null,
        title: "coordinator",
        titleFallback: null,
        originPluginId: null,
        projectId: "proj_main",
      }),
      update: async (a: unknown) => {
        updates.push(a);
        return {};
      },
    },
  });
  const res = await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(res.exitCode, 0);
  const body = JSON.parse(res.stdout) as {
    ok: boolean;
    threadId: string;
    route: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.threadId, "thr_exec");
  assert.equal(body.route, "simple");
  assert.ok(
    calls.some((c) => c.join(" ") === "thread update thr_exec --parent-notifications auto"),
  );
  assert.deepEqual(updates, [
    { threadId: "thr_exec", parentThreadId: "thr_coord", visibility: "hidden" },
  ]);
});

test("policy validate rejects an invalid policy with a path", async () => {
  const host = await hostWith({ policy: '{"version": 2}' });
  const res = await host.harness.runCli(["policy", "validate", "--json"]);
  assert.equal(res.exitCode, 1);
  const body = JSON.parse(res.stdout) as {
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(body.error.code, "policy-invalid");
  assert.match(body.error.message, /version/);
});

test("instructions prints the generated rule", async () => {
  const host = await hostWith();
  const res = await host.harness.runCli(["instructions"]);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /delegate/);
  assert.match(res.stdout, /orchestrator-coordinator/);
});

test("instructions without a valid policy points at orchestrator-setup", async () => {
  const host = await hostWith({ policy: "" });
  const res = await host.harness.runCli(["instructions", "--json"]);
  assert.equal(res.exitCode, 1);
  const body = JSON.parse(res.stdout) as {
    error: { code: string; hint?: string };
  };
  assert.equal(body.error.code, "policy-invalid");
  assert.match(body.error.hint ?? "", /orchestrator-setup/);
});

test("reconcile runs a pass and reports counters", async () => {
  const host = await hostWith();
  const res = await host.harness.runCli(["reconcile"]);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /scanned=0/);
  const json = await host.harness.runCli(["reconcile", "--json"]);
  const body = JSON.parse(json.stdout) as { ok: boolean; scanned: number };
  assert.equal(body.ok, true);
  assert.equal(body.scanned, 0);
});

const COORDINATOR_SDK = {
  get: async () => ({
    id: "thr_coord",
    parentThreadId: null,
    title: "coordinator",
    titleFallback: null,
    originPluginId: null,
    projectId: "proj_main",
  }),
};

test("agent tool delegate returns structured errors", async () => {
  const host = await hostWith({}, fakeCli().cli, {
    threads: {
      get: async () => ({
        id: "thr_exec",
        parentThreadId: "thr_coord",
        title: null,
        titleFallback: null,
        originPluginId: "tasks",
        projectId: "proj_main",
      }),
    },
  });
  const out = (await host.harness.callAgentTool(
    "orchestrator_delegate",
    { taskKey: "PLUG-1", level: "simple" },
    { threadId: "thr_exec" },
  )) as string;
  const body = JSON.parse(out) as { ok: boolean; error: { code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "not-a-coordinator");
});

test("CLI cancel from a foreign thread is refused; owner coordinator cancels", async () => {
  const { cli, calls } = fakeCli((args) => {
    if (args.join(" ").startsWith("tasks dispatch"))
      return ok(JSON.stringify({ threadId: "thr_exec" }));
    if (args.join(" ").startsWith("tasks preset show"))
      return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
    return undefined;
  });
  const stops: string[] = [];
  const host = await hostWith({}, cli, {
    threads: {
      get: async () => ({
        id: "thr_coord",
        parentThreadId: null,
        title: "coordinator",
        titleFallback: null,
        originPluginId: null,
        projectId: "proj_main",
      }),
      update: async () => ({}),
      stop: async ({ threadId }: { threadId: string }) => {
        stops.push(threadId);
        return {};
      },
    },
  });
  const created = await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(created.exitCode, 0);
  const delegationId = (JSON.parse(created.stdout) as { delegationId: number })
    .delegationId;

  // another thread may not cancel it
  const refused = await host.harness.runCli(
    ["cancel", String(delegationId), "--json"],
    { threadId: "thr_other" },
  );
  assert.equal(refused.exitCode, 1);
  assert.equal(
    (JSON.parse(refused.stdout) as { error: { code: string } }).error.code,
    "not-a-coordinator",
  );
  assert.deepEqual(stops, []);

  // the owning coordinator may
  const allowed = await host.harness.runCli(
    ["cancel", String(delegationId), "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(allowed.exitCode, 0);
  assert.equal(
    (JSON.parse(allowed.stdout) as { status: string }).status,
    "cancelled",
  );
  assert.deepEqual(stops, ["thr_exec"]);
});

// ── rev 13: cancel без thread_id, dispose-интертность, throttle пресетов ──

const DISPATCH_TIMEOUT = {
  exitCode: 1,
  stdout: "",
  stderr: "timed out",
  timedOut: true,
} as const;

test("cancel of a dispatching row without thread_id finds and stops the thread (§6)", async () => {
  const stops: string[] = [];
  const { cli } = fakeCli((args) => {
    const key = args.join(" ");
    if (key.startsWith("tasks dispatch")) return { ...DISPATCH_TIMEOUT };
    if (key.startsWith("tasks preset show"))
      return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
    if (key.startsWith("tasks threads"))
      return ok(
        JSON.stringify({
          taskThreads: [
            { threadId: "thr_late", attachedAt: new Date().toISOString() },
          ],
        }),
      );
    return undefined;
  });
  const host = await hostWith({}, cli, {
    threads: {
      ...COORDINATOR_SDK,
      update: async () => ({}),
      stop: async ({ threadId }: { threadId: string }) => {
        stops.push(threadId);
        return {};
      },
    },
  });
  const delegated = await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(
    (JSON.parse(delegated.stdout) as { error: { code: string } }).error.code,
    "dispatch-unknown",
  );

  const res = await host.harness.runCli(["cancel", "1", "--json"], {
    threadId: "thr_coord",
  });
  const body = JSON.parse(res.stdout) as {
    ok: boolean;
    status: string;
    warning?: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.status, "cancelled");
  assert.equal(body.warning, undefined);
  assert.deepEqual(stops, ["thr_late"]);
});

test("PLUG-184 C5: cancel drops the BB auto-retry BEFORE the stop", async () => {
  const ops: string[] = [];
  let retryCleared = false;
  const { cli } = fakeCli((args) => {
    const key = args.join(" ");
    if (key.startsWith("provider-retry")) ops.push(`cli:${key.split(" ")[1]}`);
    if (key.startsWith("tasks dispatch"))
      return ok(JSON.stringify({ threadId: "thr_exec" }));
    if (key.startsWith("tasks preset show"))
      return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
    if (key.startsWith("provider-retry status"))
      return ok(JSON.stringify({ retries: retryCleared ? [] : [{}] }));
    if (key.startsWith("provider-retry cancel")) {
      retryCleared = true;
      return ok();
    }
    return undefined;
  });
  const host = await hostWith({}, cli, {
    threads: {
      ...COORDINATOR_SDK,
      update: async () => ({}),
      stop: async ({ threadId }: { threadId: string }) => {
        ops.push(`sdk:stop ${threadId}`);
        return {};
      },
    },
  });
  await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );
  const res = await host.harness.runCli(["cancel", "1", "--json"], {
    threadId: "thr_coord",
  });
  const body = JSON.parse(res.stdout) as { ok: boolean; warning?: string };
  assert.equal(body.ok, true);
  assert.equal(body.warning, undefined);
  const cancelIdx = ops.findIndex((o) => o === "cli:cancel");
  const stopIdx = ops.findIndex((o) => o === "sdk:stop thr_exec");
  assert.ok(cancelIdx >= 0 && stopIdx >= 0, `both ran: ${JSON.stringify(ops)}`);
  assert.ok(
    cancelIdx < stopIdx,
    `auto-retry cancel precedes stop: ${JSON.stringify(ops)}`,
  );
});

test("cancel surfaces the thread-lookup failure as a warning", async () => {
  const stops: string[] = [];
  const { cli } = fakeCli((args) => {
    const key = args.join(" ");
    if (key.startsWith("tasks dispatch")) return { ...DISPATCH_TIMEOUT };
    if (key.startsWith("tasks threads"))
      return { exitCode: 1, stdout: "", stderr: "tasks api down" };
    return undefined;
  });
  const host = await hostWith({}, cli, {
    threads: {
      ...COORDINATOR_SDK,
      update: async () => ({}),
      stop: async ({ threadId }: { threadId: string }) => {
        stops.push(threadId);
        return {};
      },
    },
  });
  await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );
  const res = await host.harness.runCli(["cancel", "1", "--json"], {
    threadId: "thr_coord",
  });
  const body = JSON.parse(res.stdout) as { status: string; warning?: string };
  assert.equal(body.status, "cancelled");
  assert.match(body.warning ?? "", /task thread lookup failed/);
  assert.deepEqual(stops, []);
});

test("a stopped watchdog service ignores thread events (dispose)", async () => {
  const eventLists: number[] = [];
  const { cli } = fakeCli((args) => {
    const key = args.join(" ");
    if (key.startsWith("tasks dispatch"))
      return ok(JSON.stringify({ threadId: "thr_exec" }));
    if (key.startsWith("tasks preset show"))
      return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
    return undefined;
  });
  const host = await hostWith({}, cli, {
    threads: {
      ...COORDINATOR_SDK,
      update: async () => ({}),
      stop: async () => ({}),
      get: async ({ threadId }: { threadId: string }) =>
        threadId === "thr_exec"
          ? { id: "thr_exec", status: "active", archivedAt: null, deletedAt: null }
          : COORDINATOR_SDK.get(),
      events: {
        list: async () => {
          eventLists.push(1);
          return [];
        },
      },
      queuedMessages: { list: async () => [] },
      send: async () => ({}),
    },
  });
  await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );
  const { controller, done } = host.harness.runService("orchestrator-watchdog");
  const tick = () => new Promise((r) => setImmediate(r));
  await host.harness.emitThreadEvent("experimental_thread.events", {
    thread: makeThreadResponse({ id: "thr_exec" }),
    sequence: 7,
  });
  await tick(); // the handler resolves before its enqueued work drains
  await tick();
  const liveCalls = eventLists.length;
  assert.ok(liveCalls > 0, "running service should read the stream");

  controller.abort();
  await done;
  await host.harness.emitThreadEvent("experimental_thread.events", {
    thread: makeThreadResponse({ id: "thr_exec" }),
    sequence: 9,
  });
  await tick();
  await tick();
  assert.equal(eventLists.length, liveCalls, "stopped service must be inert");
});

test("preset check: throttled to 10 min and gated on change/activity", async () => {
  let fakeNow = 1_000_000;
  const presetListCalls = () =>
    calls.filter((c) => c.join(" ").startsWith("tasks preset list")).length;
  const { cli, calls } = fakeCli();
  const host = await hostWith({}, cli, {}, () => fakeNow);
  // initial background check — one call
  await new Promise((r) => setImmediate(r));
  assert.equal(presetListCalls(), 1);

  const POLICY2 = JSON.stringify({
    version: 1,
    levels: { simple: { chain: ["simple"] } },
    routes: { simple: { preset: "simple", provider: "agy" } },
  });
  // changed policy but inside the 10-minute window → still 1
  fakeNow += 5 * 60_000;
  await host.harness.setSettings({ policy: POLICY2 });
  await new Promise((r) => setImmediate(r));
  assert.equal(presetListCalls(), 1);
  // past the window with a changed policy → second call
  fakeNow += 6 * 60_000;
  await host.harness.setSettings({
    policy: POLICY2.replace("agy", "acp-devin"),
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(presetListCalls(), 2);
});

test("janitor run is refused while disabled, report works", async () => {
  const { cli } = fakeCli((args) =>
    args.join(" ").startsWith("environment list")
      ? ok(JSON.stringify([]))
      : undefined,
  );
  const host = await hostWith({}, cli);
  // disabled (default {"enabled": false}) → refusal with hint
  let res = await host.harness.runCli(["janitor", "run", "--json"], {});
  assert.equal(res.exitCode, 1);
  let body = JSON.parse(res.stdout) as { ok: boolean; error: { code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "janitor-disabled");
  // --dry-run passes without enabled config
  res = await host.harness.runCli(["janitor", "run", "--dry-run", "--json"], {});
  assert.equal(res.exitCode, 0);
  const dry = JSON.parse(res.stdout) as { ok: boolean; applied: boolean };
  assert.equal(dry.ok, true);
  assert.equal(dry.applied, false);
  // report: JSON summary shape
  res = await host.harness.runCli(["janitor", "report", "--json"], {});
  assert.equal(res.exitCode, 0);
  const rep = JSON.parse(res.stdout) as {
    ok: boolean;
    items: unknown[];
    abandoned: unknown[];
    lastRun: { removed: number } | null;
  };
  assert.equal(rep.ok, true);
  assert.ok(Array.isArray(rep.items));
  assert.ok(rep.lastRun !== null);
});

test("janitor run with invalid config reports janitor-invalid", async () => {
  const { cli } = fakeCli();
  const host = await hostWith({ janitor: "{oops" }, cli);
  const res = await host.harness.runCli(["janitor", "run"], {});
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr ?? "", /janitor-invalid/);
});

test("release CLI: --no-docs/--kb/--no-kb values are not positional (§17.3 м7)", async () => {
  const { cli, calls } = fakeCli((args) =>
    args.join(" ").startsWith("tasks show")
      ? ok(JSON.stringify({ task: { key: "PLUG-1", title: "t" }, comments: [] }))
      : undefined,
  );
  const host = await hostWith(
    {
      // release must get far enough to resolve the task key — a valid
      // config and the release-audit level, so only приёмка refuses.
      policy: JSON.stringify({
        version: 1,
        levels: {
          "release-audit": { chain: ["ra"] },
          complex: { chain: ["ra"] },
        },
        routes: { ra: { preset: "ra", provider: "p" } },
      }),
      release: JSON.stringify({
        defaults: { target: { action: "push", branch: "main" } },
      }),
    },
    cli,
    {
      threads: {
        get: async () => ({
          id: "thr_coord",
          parentThreadId: null,
          title: "coordinator",
          titleFallback: null,
          originPluginId: null,
          projectId: "proj_main",
        }),
      },
    },
  );
  const res = await host.harness.runCli(
    [
      "release",
      "PLUG-1",
      "--no-docs",
      "причина без доков",
      "--kb",
      "заметка",
      "--json",
    ],
    { threadId: "thr_coord" },
  );
  // the flag values must not land in positionals — PLUG-1 is the key
  assert.ok(
    calls.some((c) => c.join(" ") === "tasks show PLUG-1 --json"),
    `expected lookup of PLUG-1, got: ${JSON.stringify(calls)}`,
  );
  assert.ok(!calls.some((c) => c.join(" ").includes("причина без доков")));
  void res;
});
