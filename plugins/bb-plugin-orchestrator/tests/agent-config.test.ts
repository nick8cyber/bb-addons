import assert from "node:assert/strict";
import test from "node:test";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";

type CtxOverrides = NonNullable<
  Parameters<typeof makePluginAgentConfigurationContext>[0]
>;
import {
  buildAgentConfiguration,
  fallbackAgentConfiguration,
  isCoordinator,
  type ExecutorProbes,
} from "../src/agent-config.js";

const noProbes: ExecutorProbes = {
  delegationByThreadId: () => undefined,
  hasFreshDispatching: () => false,
};

const ctx = (overrides: CtxOverrides) =>
  makePluginAgentConfigurationContext(overrides);

const deps = {
  injectInstructions: true,
  instructionsText: "RULE",
  probes: noProbes,
};

test("a root app thread is a coordinator: gets tools and the rule", () => {
  const config = buildAgentConfiguration(ctx({}), deps);
  assert.deepEqual(
    config.tools,
    ["orchestrator_delegate", "orchestrator_status", "orchestrator_cancel"],
  );
  assert.equal(config.instructions, "RULE");
});

test("injectInstructions=false silences texts but keeps the tools", () => {
  const config = buildAgentConfiguration(ctx({}), {
    ...deps,
    injectInstructions: false,
  });
  assert.equal(config.tools.length, 3);
  assert.equal(config.instructions, undefined);
});

test("a thread with a parent is not a coordinator", () => {
  const config = buildAgentConfiguration(
    ctx({ thread: { parentThreadId: "thr_parent" } }),
    deps,
  );
  assert.deepEqual(config.tools, []);
  assert.equal(config.instructions, undefined);
});

test("a tasks-dispatched thread gets nothing (origin.pluginId)", () => {
  const config = buildAgentConfiguration(
    ctx({ origin: { pluginId: "tasks" } }),
    deps,
  );
  assert.deepEqual(config.tools, []);
});

test("a thread recorded in delegations gets nothing", () => {
  const config = buildAgentConfiguration(ctx({}), {
    ...deps,
    probes: { ...noProbes, delegationByThreadId: () => ({ id: 1 }) },
  });
  assert.deepEqual(config.tools, []);
});

test("a dispatch-shaped title marks an executor", () => {
  const config = buildAgentConfiguration(
    ctx({ thread: { title: "PLUG-129 · orchestrator MVP" } }),
    deps,
  );
  assert.deepEqual(config.tools, []);
});

test("a fresh dispatching row without thread_id marks the window", () => {
  const config = buildAgentConfiguration(ctx({}), {
    ...deps,
    probes: { ...noProbes, hasFreshDispatching: () => true },
  });
  assert.deepEqual(config.tools, []);
});

test("a dispatching row that is not fresh does not mark the thread", () => {
  const probes: ExecutorProbes = {
    delegationByThreadId: () => undefined,
    hasFreshDispatching: () => false,
  };
  assert.equal(
    isCoordinator(
      {
        threadId: "t",
        parentThreadId: null,
        title: null,
        originPluginId: null,
        projectId: "proj_x",
      },
      probes,
      Date.now(),
    ),
    true,
  );
});

test("each executor marker alone is enough — one test per marker", () => {
  const clean = ctx({ thread: { title: null } });
  // marker: parent
  assert.deepEqual(
    buildAgentConfiguration(
      ctx({ thread: { title: null, parentThreadId: "thr_p" } }),
      deps,
    ).tools,
    [],
  );
  // marker: origin tasks
  assert.deepEqual(
    buildAgentConfiguration(
      ctx({ thread: { title: null }, origin: { pluginId: "tasks" } }),
      deps,
    ).tools,
    [],
  );
  // marker: recorded in delegations
  assert.deepEqual(
    buildAgentConfiguration(clean, {
      ...deps,
      probes: { ...noProbes, delegationByThreadId: () => ({ id: 1 }) },
    }).tools,
    [],
  );
  // marker: dispatch title
  assert.deepEqual(
    buildAgentConfiguration(
      ctx({ thread: { title: "PLUG-5 · do a thing" } }),
      deps,
    ).tools,
    [],
  );
  // marker: fresh dispatching in the same project
  assert.deepEqual(
    buildAgentConfiguration(clean, {
      ...deps,
      probes: { ...noProbes, hasFreshDispatching: () => true },
    }).tools,
    [],
  );
  // none of the markers → coordinator
  assert.equal(buildAgentConfiguration(clean, deps).tools.length, 3);
});

test("the fallback uses static facts only when probes throw", () => {
  const broken: ExecutorProbes = {
    delegationByThreadId: () => {
      throw new Error("db gone");
    },
    hasFreshDispatching: () => {
      throw new Error("db gone");
    },
  };
  // The production handler catches and calls fallbackAgentConfiguration.
  assert.throws(() =>
    buildAgentConfiguration(ctx({}), { ...deps, probes: broken }),
  );
  const fb = fallbackAgentConfiguration(ctx({}), true, "RULE");
  assert.equal(fb.tools.length, 3);
  const fbExec = fallbackAgentConfiguration(
    ctx({ thread: { parentThreadId: "thr_p" } }),
    true,
    "RULE",
  );
  assert.deepEqual(fbExec.tools, []);
});
