import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import {
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import {
  decideRole,
  handleMessageDispatch,
  ROLE_INSTRUCTIONS_MAX,
  ROLES,
  type RoleDecisionProbes,
} from "../src/roles.js";
import { buildAgentConfiguration } from "../src/agent-config.js";
import { pendingRoleRpc } from "../server.js";

function makeStore() {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const probes: RoleDecisionProbes = {
    threadRole: (id) => store.threadRole(id),
    pendingRole: (projectId) => store.pendingRole(projectId),
    activeDelegationByTaskKey: (key) => store.activeByTaskKey(key),
  };
  const warnings: string[] = [];
  const hook = (ctx: MessageDispatchHookContext) =>
    handleMessageDispatch(
      ctx,
      probes,
      (threadId, role) => store.setThreadRole(threadId, role, "hook"),
      (m) => warnings.push(m),
    );
  return { db, store, probes, hook, warnings };
}

const dispatch = (
  overrides: Parameters<typeof makeMessageDispatchHookContext>[0],
) => makeMessageDispatchHookContext(overrides);

const facts = (
  over: Partial<Parameters<typeof decideRole>[0]>,
): Parameters<typeof decideRole>[0] => ({
  threadId: "thr_t",
  status: "pending",
  originPluginId: null,
  title: null,
  sourceThreadId: null,
  parentThreadId: null,
  attempt: "start-turn",
  origin: "app",
  projectId: "proj_a",
  ...over,
});

const noProbes: RoleDecisionProbes = {
  threadRole: () => undefined,
  pendingRole: () => undefined,
  activeDelegationByTaskKey: () => undefined,
};

test("migrations add pending_roles and thread_roles", () => {
  const { db } = makeStore();
  const pending = (db
    .prepare(`PRAGMA table_info(pending_roles)`)
    .all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(pending.sort(), ["project_id", "role", "updated_at"]);
  const roles = (db
    .prepare(`PRAGMA table_info(thread_roles)`)
    .all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(roles.sort(), [
    "decided_at",
    "role",
    "source",
    "thread_id",
  ]);
});

test("store: pending pick upserts per project; thread role records source", () => {
  const { store } = makeStore();
  store.setPendingRole("proj_a", "auditor");
  assert.equal(store.pendingRole("proj_a"), "auditor");
  store.setPendingRole("proj_a", "executor");
  assert.equal(store.pendingRole("proj_a"), "executor");
  assert.equal(store.pendingRole("proj_b"), undefined);

  store.setThreadRole("thr_1", "executor", "hook");
  assert.equal(store.threadRole("thr_1")?.source, "hook");
  // The delegate path corrects an earlier hook guess.
  store.setThreadRole("thr_1", "auditor", "delegate");
  const row = store.threadRole("thr_1")!;
  assert.equal(row.role, "auditor");
  assert.equal(row.source, "delegate");
  // `source` is checked: anything outside hook|delegate is rejected.
  assert.throws(() =>
    store.setThreadRole("thr_1", "executor", "bogus" as never),
  );
});

test("decideRole: not the first message → no decision", () => {
  assert.equal(decideRole(facts({ attempt: "join-turn" }), noProbes), null);
  assert.equal(decideRole(facts({ status: "idle" }), noProbes), null);
  assert.equal(decideRole(facts({ status: "active" }), noProbes), null);
  // already decided → no rewrite
  assert.equal(
    decideRole(facts({}), {
      ...noProbes,
      threadRole: () => ({ role: "executor" }),
    }),
    null,
  );
});

test("decideRole: tasks origin wins over everything else", () => {
  // review-level delegation in dispatching/running → auditor
  assert.equal(
    decideRole(
      facts({
        originPluginId: "tasks",
        title: "PLUG-7 · review the spec",
        parentThreadId: "thr_parent", // tasks branch beats the parent one
      }),
      {
        ...noProbes,
        activeDelegationByTaskKey: (k) =>
          k === "PLUG-7" ? { level: "review" } : undefined,
      },
    ),
    "auditor",
  );
  // any other level → executor
  assert.equal(
    decideRole(
      facts({ originPluginId: "tasks", title: "PLUG-7 · do it" }),
      {
        ...noProbes,
        activeDelegationByTaskKey: () => ({ level: "simple" }),
      },
    ),
    "executor",
  );
  // no delegation row → executor; no title key → executor
  assert.equal(
    decideRole(
      facts({ originPluginId: "tasks", title: "PLUG-7 · do it" }),
      noProbes,
    ),
    "executor",
  );
  assert.equal(
    decideRole(facts({ originPluginId: "tasks", title: null }), noProbes),
    "executor",
  );
});

test("decideRole: source role inherits; no source row → next branch", () => {
  assert.equal(
    decideRole(facts({ sourceThreadId: "thr_src" }), {
      ...noProbes,
      threadRole: (id) =>
        id === "thr_src" ? { role: "auditor" } : undefined,
    }),
    "auditor",
  );
  // a source without a row falls through to the parent branch → executor
  assert.equal(
    decideRole(
      facts({ sourceThreadId: "thr_src", parentThreadId: "thr_p" }),
      noProbes,
    ),
    "executor",
  );
});

test("decideRole: parent → executor; app → pending pick; else orchestrator", () => {
  assert.equal(
    decideRole(facts({ parentThreadId: "thr_p" }), noProbes),
    "executor",
  );
  // app + pending pick → the pick
  assert.equal(
    decideRole(facts({ origin: "app" }), {
      ...noProbes,
      pendingRole: (p) => (p === "proj_a" ? "auditor" : undefined),
    }),
    "auditor",
  );
  // app + no pick → orchestrator
  assert.equal(
    decideRole(facts({ origin: "app" }), noProbes),
    "orchestrator",
  );
  // a pick for ANOTHER project does not leak
  assert.equal(
    decideRole(facts({ origin: "app" }), {
      ...noProbes,
      pendingRole: (p) => (p === "proj_b" ? "executor" : undefined),
    }),
    "orchestrator",
  );
  // cli / plugin / sdk / internal → orchestrator
  for (const origin of ["cli", "plugin", "sdk", null]) {
    assert.equal(
      decideRole(facts({ origin }), noProbes),
      "orchestrator",
      `origin ${origin}`,
    );
  }
});

test("hook: first app message records the project's pick", () => {
  const { store, hook } = makeStore();
  store.setPendingRole("proj_a", "auditor");
  const decision = hook(
    dispatch({
      thread: { id: "thr_new", status: "pending" },
      origin: "app",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
  );
  assert.deepEqual(decision, { action: "proceed" });
  const row = store.threadRole("thr_new")!;
  assert.equal(row.role, "auditor");
  assert.equal(row.source, "hook");
});

test("hook: an old non-pending thread keeps its role untouched", () => {
  const { store, hook } = makeStore();
  store.setThreadRole("thr_old", "orchestrator", "hook");
  hook(
    dispatch({
      thread: { id: "thr_old", status: "idle" },
      origin: "app",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
  );
  assert.equal(store.threadRole("thr_old")!.role, "orchestrator");
  // a never-decided old thread stays undecided — the fallback criterion
  // answers in configure instead
  hook(
    dispatch({
      thread: { id: "thr_older", status: "idle" },
      origin: "app",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
  );
  assert.equal(store.threadRole("thr_older"), undefined);
});

test("hook: reviewer from delegate --level review is auditor on first message", () => {
  const { store, hook } = makeStore();
  // The delegation row exists before the executor's first message (§4.2).
  store.insert({
    taskKey: "PLUG-9",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_a",
    level: "review",
    route: "review",
    preset: "review",
    provider: "claude-code",
  });
  hook(
    dispatch({
      thread: {
        id: "thr_rev",
        status: "pending",
        originPluginId: "tasks",
        title: "PLUG-9 · review specs",
      },
      origin: "plugin",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
  );
  const row = store.threadRole("thr_rev")!;
  assert.equal(row.role, "auditor");
  assert.equal(row.source, "hook");
});

test("hook: a tasks thread without a delegation row is executor", () => {
  const { store, hook } = makeStore();
  hook(
    dispatch({
      thread: {
        id: "thr_manual",
        status: "pending",
        originPluginId: "tasks",
        title: "PLUG-10 · dispatched by hand",
      },
      origin: "cli",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
  );
  assert.equal(store.threadRole("thr_manual")!.role, "executor");
});

test("hook: an exception inside answers proceed and writes nothing", () => {
  const { store } = makeStore();
  const warnings: string[] = [];
  const decision = handleMessageDispatch(
    dispatch({
      thread: { id: "thr_x", status: "pending" },
      origin: "app",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
    {
      threadRole: () => {
        throw new Error("db gone");
      },
      pendingRole: () => undefined,
      activeDelegationByTaskKey: () => undefined,
    },
    (id, role) => store.setThreadRole(id, role, "hook"),
    (m) => warnings.push(m),
  );
  assert.deepEqual(decision, { action: "proceed" });
  assert.equal(store.threadRole("thr_x"), undefined);
  assert.equal(warnings.length, 1);
});

test("hook: the handler answers in milliseconds", () => {
  const { hook } = makeStore();
  const ctx = dispatch({
    thread: { id: "thr_fast", status: "pending" },
    origin: "app",
    attempt: "start-turn",
    project: { id: "proj_a" },
  });
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) hook(ctx);
  const elapsed = (performance.now() - t0) / 100;
  assert.ok(elapsed < 50, `handler took ${elapsed}ms`);
});

test("hook before first configure: the decided role drives issuance", () => {
  const { store, hook } = makeStore();
  store.setPendingRole("proj_a", "auditor");
  hook(
    dispatch({
      thread: { id: "thr_seq", status: "pending" },
      origin: "app",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
  );
  const config = buildAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: "thr_seq" } }),
    {
      injectInstructions: true,
      instructionsText: "RULE",
      probes: {
        delegationByThreadId: () => undefined,
        hasFreshDispatching: () => false,
        roleByThreadId: (id) => store.threadRole(id)?.role,
      },
    },
  );
  assert.deepEqual(config.tools, []);
  assert.equal(config.instructions, ROLES.auditor.instructions);
});

test("projectId = null: nothing stored, the read-back is the default", () => {
  const { store } = makeStore();
  const rpc = pendingRoleRpc(store);
  assert.deepEqual(
    rpc.setPendingRole({ projectId: null, role: "auditor" }),
    { ok: true },
  );
  assert.deepEqual(rpc.pendingRole({ projectId: null }), { role: null });
  // a real project round-trips
  rpc.setPendingRole({ projectId: "proj_a", role: "executor" });
  assert.deepEqual(rpc.pendingRole({ projectId: "proj_a" }), {
    role: "executor",
  });
});

test("§3 budget: longest role + a 1500-char rule stays under 4096", () => {
  for (const role of Object.values(ROLES)) {
    assert.ok(
      role.instructions.length <= ROLE_INSTRUCTIONS_MAX,
      `${role.id} is ${role.instructions.length} chars`,
    );
  }
  const rule = "x".repeat(1500);
  const config = buildAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: "thr_orch" } }),
    {
      injectInstructions: true,
      instructionsText: rule,
      probes: {
        delegationByThreadId: () => undefined,
        hasFreshDispatching: () => false,
        roleByThreadId: () => "orchestrator",
      },
    },
  );
  assert.ok(
    config.instructions!.length <= 4096,
    `composed instructions are ${config.instructions!.length} chars`,
  );
  assert.ok(config.instructions!.includes(rule));
  assert.ok(
    config.instructions!.startsWith(
      ROLES.orchestrator.instructions.slice(0, 30),
    ),
  );
});

test("injectInstructions=false: no texts for any role, tools stay", () => {
  const ctxFor = (id: string) =>
    makePluginAgentConfigurationContext({ thread: { id } });
  const probes = (role: string) => ({
    delegationByThreadId: () => undefined,
    hasFreshDispatching: () => false,
    roleByThreadId: () => role,
  });
  const deps = { injectInstructions: false, instructionsText: "RULE" };
  const orch = buildAgentConfiguration(ctxFor("thr_o"), {
    ...deps,
    probes: probes("orchestrator"),
  });
  assert.equal(orch.instructions, undefined);
  assert.equal(orch.tools.length, 4);
  assert.deepEqual(orch.skills, ["orchestrator-setup"]);
  const exec = buildAgentConfiguration(ctxFor("thr_e"), {
    ...deps,
    probes: probes("executor"),
  });
  assert.equal(exec.instructions, undefined);
  assert.deepEqual(exec.tools, []);
  assert.deepEqual(exec.skills, []);
});

test("a role row beats the fallback markers in both directions", () => {
  const base = {
    delegationByThreadId: () => undefined,
    hasFreshDispatching: () => false,
  };
  // executor role + coordinator-looking facts → not a coordinator
  const exec = buildAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: "thr_e", parentThreadId: null, title: null },
    }),
    {
      injectInstructions: true,
      instructionsText: "RULE",
      probes: { ...base, roleByThreadId: () => "executor" },
    },
  );
  assert.deepEqual(exec.tools, []);
  assert.equal(exec.instructions, ROLES.executor.instructions);
  // orchestrator role + executor-looking facts (a parent) → coordinator
  const orch = buildAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: "thr_o", parentThreadId: "thr_p" },
    }),
    {
      injectInstructions: true,
      instructionsText: "RULE",
      probes: { ...base, roleByThreadId: () => "orchestrator" },
    },
  );
  assert.equal(orch.tools.length, 4);
  assert.ok(orch.instructions!.includes("RULE"));
});

test("role instructions carry no site process rules (PLUG-148)", () => {
  for (const role of Object.values(ROLES)) {
    assert.doesNotMatch(role.instructions, /push/i, role.id);
    assert.doesNotMatch(role.instructions, /in_review/i, role.id);
    assert.doesNotMatch(role.instructions, /--author/, role.id);
  }
  // the executor text points at the task's own contract instead
  assert.match(ROLES.executor.instructions, /Работа с git/);
  assert.match(ROLES.executor.instructions, /контракту из описания задачи/);
});
