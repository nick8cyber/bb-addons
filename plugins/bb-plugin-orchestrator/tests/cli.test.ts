import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import { DelegationStore } from "../src/store.js";
import type { CmdRunner } from "../src/cmd.js";
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
                title: "do it",
                status: "in_progress",
              },
              project: { name: "p", linkedBbProjectId: "proj_bb" },
              subtasks: [],
              attachments: [],
              comments: [],
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
        if (key.startsWith("provider-retry status"))
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
  const { cli, calls } = fakeCli();
  const updates: unknown[] = [];
  const spawnCalls: {
    parentThreadId?: string;
    parentNotifications?: string;
    visibility?: string;
    pluginMetadata?: { delegationId?: unknown };
  }[] = [];
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
      spawn: async (a: (typeof spawnCalls)[number]) => {
        spawnCalls.push(a);
        return { id: "thr_exec" };
      },
      list: async () => [],
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
    delegationId: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.threadId, "thr_exec");
  assert.equal(body.route, "simple");
  // §4 r30: parent/hidden/auto + the delegationId label are set AT
  // spawn — no repair update, no `ownership-assigned` wakeup.
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]!.parentThreadId, "thr_coord");
  assert.equal(spawnCalls[0]!.parentNotifications, "auto");
  assert.equal(spawnCalls[0]!.visibility, "hidden");
  assert.equal(spawnCalls[0]!.pluginMetadata?.delegationId, body.delegationId);
  assert.ok(
    !calls.some((c) => c.join(" ").startsWith("thread update")),
    "no parent-notifications repair call",
  );
  assert.deepEqual(updates, []);
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
  /** §4 r30: the own-spawn dispatch — the fake returns the executor id. */
  spawn: async () => ({ id: "thr_exec" }),
  list: async () => [],
  getPluginMetadata: async () => null,
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
  const { cli } = fakeCli();
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
      spawn: async () => ({ id: "thr_exec" }),
      list: async () => [],
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

  // PLUG-224: the coordinator's own cancel is marked — the §16.5
  // delivery then skips the «исполнитель закончил без отчёта» tail
  const shown = await host.harness.runCli(
    ["show", String(delegationId), "--json"],
    { threadId: "thr_coord" },
  );
  const delegation = (
    JSON.parse(shown.stdout) as {
      delegation: { status: string; setup_errors: string };
    }
  ).delegation;
  assert.equal(delegation.status, "cancelled");
  assert.match(delegation.setup_errors, /coordinator-cancel/);
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
  const { cli } = fakeCli();
  const host = await hostWith({}, cli, {
    threads: {
      ...COORDINATOR_SDK,
      // §4 r30: the spawn outcome is uncertain — no thread id survives,
      // but the thread exists under the coordinator with the label.
      spawn: async () => {
        throw new Error("spawn timed out");
      },
      list: async () => [
        {
          id: "thr_late",
          title: "PLUG-1 · do it",
          createdAt: Date.now(),
        },
      ],
      getPluginMetadata: async ({ threadId }: { threadId: string }) =>
        threadId === "thr_late" ? { delegationId: 1 } : null,
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
      // §4 r30 е 3: a schema refusal on the own-spawn fields falls back
      // to `bb tasks dispatch` (which times out here) — the row gets the
      // `own-spawn` marker, so cancel searches `bb tasks threads`.
      spawn: async () => {
        throw Object.assign(
          new Error("HTTP 400: unrecognized field parentNotifications"),
          { code: "invalid_params", status: 400 },
        );
      },
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
  const { cli } = fakeCli();
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

test("§17.2 r26 (PLUG-215 мелко 2): `show` labels the notify-muted mark, not a setup error", async () => {
  const { cli } = fakeCli();
  const host = await hostWith({}, cli, {
    threads: { ...COORDINATOR_SDK, update: async () => ({}) },
  });
  const created = await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );
  const delegationId = (
    JSON.parse(created.stdout) as { delegationId: number }
  ).delegationId;
  // the quiet-stop mark plus a real setup error — only the real one
  // stays inside setup_errors=
  const store = new DelegationStore(host.bb.storage.database());
  store.addSetupError(delegationId, "notify-muted", "thr_exec");
  store.addSetupError(delegationId, "attach-verify", "gone");

  const res = await host.harness.runCli(["show", String(delegationId)]);
  assert.equal(res.exitCode, 0);
  assert.doesNotMatch(res.stdout, /"step":"notify-muted"/);
  assert.match(res.stdout, /notify-muted=thr_exec/);
  assert.match(res.stdout, /заглушены/);
  assert.match(res.stdout, /setup_errors=\[/);
  assert.match(res.stdout, /"step":"attach-verify"/);
});

test("§17.2 r26 (PLUG-227): `show` labels coordinator-cancel, not in setup_errors", async () => {
  const { cli } = fakeCli();
  const host = await hostWith({}, cli, {
    threads: { ...COORDINATOR_SDK, update: async () => ({}) },
  });
  const created = await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );
  const delegationId = (
    JSON.parse(created.stdout) as { delegationId: number }
  ).delegationId;
  const store = new DelegationStore(host.bb.storage.database());
  store.setStatus(delegationId, "cancelled");
  store.addSetupError(delegationId, "coordinator-cancel", "thr_coord");
  store.addSetupError(delegationId, "attach-verify", "gone");

  const res = await host.harness.runCli(["show", String(delegationId)]);
  assert.equal(res.exitCode, 0);
  assert.doesNotMatch(res.stdout, /"step":"coordinator-cancel"/);
  assert.match(res.stdout, /coordinator-cancel=thr_coord/);
  assert.match(res.stdout, /отменено координатором/);
  assert.match(res.stdout, /setup_errors=\[/);
  assert.match(res.stdout, /"step":"attach-verify"/);
});

// §17.4 (PLUG-212): a janitor pass refused on git < 2.39 is a recorded
// failure — `janitor run` exits non-zero instead of printing a healthy
// empty report.
test("janitor run on unsupported git exits non-zero (§17.4 мелко 11)", async () => {
  const { cli } = fakeCli();
  const oldGit: CmdRunner = {
    run: async (f, a) =>
      f === "git" && a.includes("--version")
        ? ok("git version 2.30.0\n")
        : ok(),
  };
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    settings: {
      policy: POLICY_TEXT,
      janitor: JSON.stringify({ enabled: true, mode: "report" }),
    },
    agentSkillIds: [],
  });
  await createPlugin(host.bb, { bbCli: cli, cmd: oldGit });
  const res = await host.harness.runCli(["janitor", "run"], {});
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr ?? "", /unsupported-git|2\.39/);
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

// ── §4.1 r28 (PLUG-237): delegate --no-code ────────────────────────────

test("CLI delegate --no-code marks the row, instructs the executor, shows in status/show", async () => {
  const { cli } = fakeCli();
  const spawnCalls: { prompt?: string }[] = [];
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
      spawn: async (a: { prompt?: string }) => {
        spawnCalls.push(a);
        return { id: "thr_exec" };
      },
      list: async () => [],
      update: async () => ({}),
    },
  });
  const res = await host.harness.runCli(
    ["delegate", "PLUG-1", "--level", "simple", "--no-code", "--json"],
    { threadId: "thr_coord" },
  );
  assert.equal(res.exitCode, 0, res.stdout + (res.stderr ?? ""));
  const body = JSON.parse(res.stdout) as { ok: boolean; delegationId: number };
  assert.equal(body.ok, true);

  // §4.1 r28: the no-code line lands in the spawn prompt (r30)
  assert.equal(spawnCalls.length, 1, "executor spawned");
  assert.match(
    spawnCalls[0]!.prompt!,
    /задача без кода: файлы репозитория не менять, не коммитить; итог — отчёт/,
  );

  // show renders the no-code mark
  const shown = await host.harness.runCli(
    ["show", String(body.delegationId)],
    { threadId: "thr_coord" },
  );
  assert.match(shown.stdout, /no-code/);
  // status renders it too
  const status = await host.harness.runCli(["status"], {
    threadId: "thr_coord",
  });
  assert.match(status.stdout, /status=running no-code/);
  // --json exposes the column
  const shownJson = await host.harness.runCli(
    ["show", String(body.delegationId), "--json"],
    { threadId: "thr_coord" },
  );
  const row = (JSON.parse(shownJson.stdout) as {
    delegation: { no_code: number };
  }).delegation;
  assert.equal(row.no_code, 1);
});

test("agent tool noCode: true marks the delegation", async () => {
  const { cli } = fakeCli();
  const spawnCalls: { prompt?: string }[] = [];
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
      spawn: async (a: { prompt?: string }) => {
        spawnCalls.push(a);
        return { id: "thr_exec" };
      },
      list: async () => [],
      update: async () => ({}),
    },
  });
  const out = (await host.harness.callAgentTool(
    "orchestrator_delegate",
    { taskKey: "PLUG-1", level: "simple", noCode: true },
    { threadId: "thr_coord" },
  )) as string;
  const body = JSON.parse(out) as { ok: boolean; delegationId: number };
  assert.equal(body.ok, true);
  const shown = await host.harness.runCli(
    ["show", String(body.delegationId)],
    { threadId: "thr_coord" },
  );
  assert.match(shown.stdout, /no-code/);
  assert.equal(spawnCalls.length, 1, "executor spawned");
  assert.match(spawnCalls[0]!.prompt!, /задача без кода/);
});

// ── §18.6 (PLUG-249): roleTexts / handoffPath / userThreadPlugins ──────

test("§18.6: roleTexts + handoffPath reach the coordinator text", async () => {
  const host = await hostWith({
    roleTexts: JSON.stringify({ orchestrator: "- custom rule xyz" }),
    handoffPath: "/home/example/H.md",
  });
  const resolved = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({}),
  );
  const text = resolved.instructions ?? "";
  assert.match(text, /- custom rule xyz/);
  assert.match(text, /\/home\/example\/H\.md/);
  // the mandatory tail survives the user's addition
  assert.match(text, /ни sudo/);
});

test("§18.6: invalid roleTexts reports needs-configuration", async () => {
  const host = await hostWith({ roleTexts: '{"release-auditor": "x"}' });
  assert.ok(host.harness.needsConfigurationMessages.length > 0);
  assert.match(
    host.harness.needsConfigurationMessages.join(" "),
    /roleTexts\.release-auditor/,
  );
});

test("§18.6: handoffPath empty falls back to the default", async () => {
  const host = await hostWith({ handoffPath: "" });
  const resolved = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({}),
  );
  assert.match(resolved.instructions ?? "", /\$BB_THREAD_STORAGE\/HANDOFF\.md/);
});

test("§18.6: userThreadPlugins — empty default denies, explicit list allows", async () => {
  const denied = await hostWith();
  const res1 = await denied.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      origin: { pluginId: "handoff" },
    }),
  );
  assert.deepEqual(res1.tools, []);
  const allowed = await hostWith({
    userThreadPlugins: "handoff external-compact",
  });
  const res2 = await allowed.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      origin: { pluginId: "handoff" },
    }),
  );
  assert.equal(res2.tools.length, 4);
});

test("§18.6: status reports a missing commitIdentity as a warning", async () => {
  const host = await hostWith({
    release: JSON.stringify({
      defaults: { target: { action: "push", branch: "main" } },
    }),
  });
  const res = await host.harness.runCli(["status"], { threadId: "thr_c" });
  assert.match(res.stdout, /автор коммитов не задан/);
  const okHost = await hostWith({
    release: JSON.stringify({
      commitIdentity: "A <a@x.io>",
      defaults: { target: { action: "push", branch: "main" } },
    }),
  });
  const res2 = await okHost.harness.runCli(["status"], {
    threadId: "thr_c",
  });
  assert.ok(!/автор коммитов не задан/.test(res2.stdout));
});
