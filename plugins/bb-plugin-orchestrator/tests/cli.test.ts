import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
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
        return ok();
      },
    },
  };
}

async function hostWith(
  settings: Record<string, string | boolean> = {},
  cli: BbCli = fakeCli().cli,
  sdk: NonNullable<Parameters<typeof createFakePluginHost>[0]>["sdk"] = {},
) {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    settings: { policy: POLICY_TEXT, ...settings },
    sdk,
  });
  await createPlugin(host.bb, { bbCli: cli });
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
    ["orchestrator_cancel", "orchestrator_delegate", "orchestrator_status"],
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
