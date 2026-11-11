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
  SKILL_COORDINATOR,
  SKILL_SETUP,
  type ExecutorProbes,
} from "../src/agent-config.js";
import { ROLES } from "../src/roles.js";

const ORCH_TEXT = ROLES.orchestrator.instructions;

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
    [
      "orchestrator_delegate",
      "orchestrator_status",
      "orchestrator_cancel",
      "orchestrator_merge",
    ],
  );
  // §3 rev 16: a fallback-decided coordinator gets the orchestrator
  // role's text too — instruction + rule.
  assert.equal(config.instructions, `${ORCH_TEXT}

RULE`);
});

test("injectInstructions=false silences texts but keeps the tools", () => {
  const config = buildAgentConfiguration(ctx({}), {
    ...deps,
    injectInstructions: false,
  });
  assert.equal(config.tools.length, 4);
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
  assert.equal(buildAgentConfiguration(clean, deps).tools.length, 4);
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
  assert.equal(fb.tools.length, 4);
  const fbExec = fallbackAgentConfiguration(
    ctx({ thread: { parentThreadId: "thr_p" } }),
    true,
    "RULE",
  );
  assert.deepEqual(fbExec.tools, []);
});

test("the fallback issues the same skills: coordinator always gets setup", () => {
  // §3: setup — always (needed before the first delegation even with texts
  // off); coordinator — only when injectInstructions is on.
  const fb = fallbackAgentConfiguration(ctx({}), true, "RULE");
  assert.deepEqual(fb.skills, [SKILL_COORDINATOR, SKILL_SETUP]);
  const fbSilent = fallbackAgentConfiguration(ctx({}), false, "RULE");
  assert.deepEqual(fbSilent.skills, [SKILL_SETUP]);
  assert.equal(fbSilent.instructions, undefined);
  const fbExec = fallbackAgentConfiguration(
    ctx({ thread: { parentThreadId: "thr_p" } }),
    true,
    "RULE",
  );
  assert.deepEqual(fbExec.skills, []);
});

test("a broken role read falls back to the static-facts result", () => {
  // §3 resilience: a store error inside configure must not silence the
  // plugin — the production handler catches and issues from static facts.
  const broken: ExecutorProbes = {
    delegationByThreadId: () => undefined,
    hasFreshDispatching: () => false,
    roleByThreadId: () => {
      throw new Error("db gone");
    },
  };
  assert.throws(() =>
    buildAgentConfiguration(ctx({}), { ...deps, probes: broken }),
  );
  const fb = fallbackAgentConfiguration(ctx({}), true, "RULE");
  assert.equal(fb.tools.length, 4);
  assert.equal(fb.instructions, `${ORCH_TEXT}

RULE`);
});

test("configure without a thread_roles row: fallback gives orchestrator texts", () => {
  // §3 rev 16: a coordinator decided by the fallback criterion (no
  // `thread_roles` row) receives the same as the orchestrator role —
  // its instruction plus the rule — and nothing is recorded.
  const config = buildAgentConfiguration(ctx({}), {
    ...deps,
    probes: { ...noProbes, roleByThreadId: () => undefined },
  });
  assert.equal(config.tools.length, 4);
  assert.equal(config.instructions, `${ORCH_TEXT}

RULE`);
  assert.ok(config.instructions!.length <= 4096);
  const silent = buildAgentConfiguration(ctx({}), {
    injectInstructions: false,
    instructionsText: "RULE",
    probes: { ...noProbes, roleByThreadId: () => undefined },
  });
  assert.equal(silent.instructions, undefined);
});
