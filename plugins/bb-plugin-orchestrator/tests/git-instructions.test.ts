import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import {
  dispatchToRoute,
  runDelegate,
  type DelegateDeps,
  type DispatchStepsDeps,
} from "../src/delegate.js";
import { parsePolicy } from "../src/policy.js";
import {
  DEFAULT_GIT_INSTRUCTIONS,
  GIT_INSTRUCTIONS_MAX,
  gitInstructionsError,
  mergeDispatchInstructions,
} from "../src/instructions.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { ThreadFacts } from "../src/agent-config.js";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";

const POLICY_TEXT = JSON.stringify({
  version: 1,
  levels: { simple: { chain: ["simple"] } },
  routes: { simple: { preset: "simple", provider: "acp-opencode" } },
});
const PRESETS = new Set(["simple"]);

const COORDINATOR: ThreadFacts = {
  threadId: "thr_coord",
  parentThreadId: null,
  title: "coordinate work",
  originPluginId: null,
  projectId: "proj_main",
};

const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

function makeDeps(overrides: {
  gitInstructions?: string | undefined;
  cli?: (args: string[]) => BbCliResult | Promise<BbCliResult>;
} = {}) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const calls: string[][] = [];
  const cli: BbCli = {
    run: async (args) => {
      calls.push(args);
      if (overrides.cli) return overrides.cli(args);
      const key = args.join(" ");
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ task: { id: "task-1" }, threadId: "thr_exec" }));
      if (key.startsWith("tasks preset show"))
        return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
      return ok();
    },
  };
  const deps: DelegateDeps & DispatchStepsDeps = {
    store,
    bbCli: cli,
    threads: {
      update: async () => ({}),
      stop: async () => ({}),
    },
    loadPolicy: async () => parsePolicy(POLICY_TEXT, PRESETS),
    probes: {
      delegationByThreadId: (id) => store.byThreadId(id),
      hasFreshDispatching: (s, scope) => store.hasFreshDispatching(s, scope),
    },
    ...(overrides.gitInstructions !== undefined
      ? { gitInstructions: () => overrides.gitInstructions }
      : {}),
  };
  return { deps, store, calls };
}

/** The `--instructions` value of the `tasks dispatch` call, if sent. */
function dispatchedInstructions(calls: string[][]): string | undefined {
  const args = calls.find((c) => c[0] === "tasks" && c[1] === "dispatch");
  const i = args?.indexOf("--instructions") ?? -1;
  return i >= 0 ? args![i + 1] : undefined;
}

function insertRow(store: DelegationStore) {
  return store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
  });
}

test("mergeDispatchInstructions: git section first, then call instructions", () => {
  const merged = mergeDispatchInstructions("GIT-RULES", "EXTRA")!;
  assert.ok(merged.startsWith("GIT-RULES"));
  assert.equal(merged, "GIT-RULES\n\nEXTRA");
  assert.equal(mergeDispatchInstructions("GIT-RULES", undefined), "GIT-RULES");
  assert.equal(mergeDispatchInstructions("  ", "EXTRA"), "EXTRA");
  assert.equal(mergeDispatchInstructions(undefined, undefined), undefined);
  assert.equal(mergeDispatchInstructions("x".repeat(GIT_INSTRUCTIONS_MAX + 1), "EXTRA"), "EXTRA");
});

test("gitInstructionsError flags only over-limit values", () => {
  assert.equal(gitInstructionsError(undefined), null);
  assert.equal(gitInstructionsError(""), null);
  assert.equal(gitInstructionsError("x".repeat(GIT_INSTRUCTIONS_MAX)), null);
  assert.match(
    gitInstructionsError("x".repeat(GIT_INSTRUCTIONS_MAX + 1))!,
    /1500/,
  );
});

test("delegate sends the git section inside --instructions, before extras", async () => {
  const { deps, calls } = makeDeps({ gitInstructions: "GIT-RULES" });
  await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "simple",
      instructions: "EXTRA",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(dispatchedInstructions(calls), "GIT-RULES\n\nEXTRA");
});

test("dispatchToRoute (the reissue path) sends the same git section", async () => {
  // §5.4 reissues go through the same shared dispatch step, so the section
  // lands on reissued threads too.
  const { deps, store, calls } = makeDeps({ gitInstructions: "GIT-RULES" });
  const row = insertRow(store);
  await dispatchToRoute(row, { instructions: "EXTRA" }, deps);
  assert.equal(dispatchedInstructions(calls), "GIT-RULES\n\nEXTRA");
});

test("empty gitInstructions adds no section and no flag", async () => {
  const { deps, calls } = makeDeps({ gitInstructions: "  \n " });
  await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(dispatchedInstructions(calls), undefined);
  assert.ok(
    calls.some(
      (c) => c.join(" ") === "tasks dispatch PLUG-1 --preset simple --json",
    ),
  );
});

test("empty gitInstructions still passes call instructions alone", async () => {
  const { deps, calls } = makeDeps({ gitInstructions: "" });
  await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "simple",
      instructions: "EXTRA",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(dispatchedInstructions(calls), "EXTRA");
});

test("over-limit gitInstructions is skipped, extras still pass", async () => {
  const { deps, calls } = makeDeps({
    gitInstructions: "x".repeat(GIT_INSTRUCTIONS_MAX + 1),
  });
  await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "simple",
      instructions: "EXTRA",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(dispatchedInstructions(calls), "EXTRA");
});

test("the default text is the spec §2.2 section and fits the limit", () => {
  assert.ok(DEFAULT_GIT_INSTRUCTIONS.length <= GIT_INSTRUCTIONS_MAX);
  assert.ok(DEFAULT_GIT_INSTRUCTIONS.startsWith("Работа с git:"));
  assert.equal(gitInstructionsError(DEFAULT_GIT_INSTRUCTIONS), null);
});

test("over-limit gitInstructions: schema refuses the write, a stored one flags needs-configuration", async () => {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    settings: {
      policy: POLICY_TEXT,
      // pre-seeded (stored) over-limit value — stored settings bypass the
      // write schema, the §2.2 status check catches them instead
      gitInstructions: "x".repeat(GIT_INSTRUCTIONS_MAX + 1),
    },
    agentSkillIds: ["orchestrator-setup", "orchestrator-coordinator"],
  });
  await createPlugin(host.bb, {
    bbCli: { run: async () => ok() },
  });
  assert.ok(
    host.harness.needsConfigurationMessages.some((m) =>
      m.includes("gitInstructions"),
    ),
  );
  await assert.rejects(
    host.harness.setSettings({
      gitInstructions: "x".repeat(GIT_INSTRUCTIONS_MAX + 1),
    }),
    /1500/,
  );
});
