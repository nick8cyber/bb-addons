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
  DEFAULT_HANDOFF_PATH,
  DEFAULT_ROLE,
  DEFAULT_USER_THREAD_PLUGINS,
  HANDOFF_PATH_MAX,
  handleMessageDispatch,
  handoffPathError,
  parseRoleTexts,
  reviewLevelName,
  roleForLevel,
  roleInstructions,
  ROLE_INSTRUCTIONS_MAX,
  roleTextsError,
  ROLES,
  type RoleDecisionProbes,
} from "../src/roles.js";
import { parsePolicy } from "../src/policy.js";
import { createT } from "../src/i18n/index.js";
import {
  buildAgentConfiguration,
  migratePluginThreadRoles,
} from "../src/agent-config.js";
import { pendingRoleRpc, threadRoleRpc } from "../server.js";

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
  // `source` is checked: anything outside hook|delegate|owner is rejected.
  assert.throws(() =>
    store.setThreadRole("thr_1", "executor", "bogus" as never),
  );
});

test("§25 (r33.4): the CHECK migration keeps old rows and allows 'owner'", () => {
  // An "old" database — every migration but the CHECK widen — with
  // hook/delegate rows already inside; the recreate must keep them.
  // The migration is found by its `thread_roles_owner` marker, not by
  // position — later revisions append their own after it (r33.5).
  const idx = MIGRATIONS.findIndex((m) => m.includes("thread_roles_owner"));
  assert.ok(idx > 0, "thread_roles_owner migration found");
  const db = new Database(":memory:");
  for (const m of MIGRATIONS.slice(0, idx)) db.exec(m);
  db.prepare(
    `INSERT INTO thread_roles (thread_id, role, decided_at, source)
     VALUES ('thr_h', 'executor', 1, 'hook'),
            ('thr_d', 'orchestrator', 1, 'delegate')`,
  ).run();
  // 'owner' does not fit the OLD check.
  assert.throws(() =>
    db.prepare(
      `INSERT INTO thread_roles (thread_id, role, decided_at, source)
       VALUES ('thr_o', 'executor', 1, 'owner')`,
    ).run(),
  );
  db.exec(MIGRATIONS[idx]!);
  const store = new DelegationStore(db);
  assert.equal(store.threadRole("thr_h")!.source, "hook");
  assert.equal(store.threadRole("thr_d")!.source, "delegate");
  store.setThreadRole("thr_o", "orchestrator", "owner");
  assert.equal(store.threadRole("thr_o")!.source, "owner");
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

test("decideRole: parent → executor; app → pending pick; else the r33 default", () => {
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
  // §19.3: app + no pick → the configured default (executor absent a
  // defaultRole probe); `none` is a real pick.
  assert.equal(
    decideRole(facts({ origin: "app" }), noProbes),
    "executor",
  );
  assert.equal(
    decideRole(facts({ origin: "app" }), {
      ...noProbes,
      defaultRole: () => "orchestrator",
    }),
    "orchestrator",
  );
  assert.equal(
    decideRole(facts({ origin: "app" }), {
      ...noProbes,
      pendingRole: (p) => (p === "proj_a" ? "none" : undefined),
    }),
    "none",
  );
  // a pick for ANOTHER project does not leak
  assert.equal(
    decideRole(facts({ origin: "app" }), {
      ...noProbes,
      pendingRole: (p) => (p === "proj_b" ? "executor" : undefined),
    }),
    "executor",
  );
  // §19.4 (r33): a CLI thread without a parent gets NO role; plugin/,
  // sdk- and automation-born threads keep `none`.
  assert.equal(decideRole(facts({ origin: "cli" }), noProbes), "none");
  for (const origin of ["plugin", "sdk", null]) {
    assert.equal(
      decideRole(facts({ origin }), noProbes),
      "none",
      `origin ${origin}`,
    );
  }
});

test("§17.1: a plugin-origin dispatch records the none row, no coordinator", () => {
  const { store, hook } = makeStore();
  const decision = hook(
    dispatch({
      thread: {
        id: "thr_plugin",
        status: "pending",
        originPluginId: "advisor",
      },
      origin: "plugin",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
  );
  assert.deepEqual(decision, { action: "proceed" });
  assert.equal(store.threadRole("thr_plugin")!.role, "none");
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

// ── §25 (r33.4): the thread window's role picker RPC ─────────────────

test("§25: threadRole reads the decided role; no row → none", () => {
  const { store } = makeStore();
  const rpc = threadRoleRpc(store);
  assert.deepEqual(rpc.threadRole({ threadId: "thr_x" }), {
    role: "none",
    source: null,
  });
  store.setThreadRole("thr_e", "executor", "hook");
  assert.deepEqual(rpc.threadRole({ threadId: "thr_e" }), {
    role: "executor",
    source: "hook",
  });
  // a helper row reads back too — the schema is a plain string, the
  // window renders it disabled.
  store.setThreadRole("thr_h", "helper", "delegate");
  assert.equal(rpc.threadRole({ threadId: "thr_h" }).role, "helper");
});

test("§25: setThreadRole writes source=owner + role.manual; next configure gives orchestrator tools", async () => {
  const { store } = makeStore();
  const meta: { set?: unknown; remove?: string[] }[] = [];
  const rpc = threadRoleRpc(store, {
    updatePluginMetadata: async (a) => {
      meta.push(a);
      return {};
    },
  });
  store.setThreadRole("thr_t", "executor", "hook");
  const res = await rpc.setThreadRole({
    threadId: "thr_t",
    role: "orchestrator",
  });
  assert.deepEqual(res, { ok: true });
  const row = store.threadRole("thr_t")!;
  assert.equal(row.role, "orchestrator");
  assert.equal(row.source, "owner");
  const ev = store.listEvents("role.manual").at(-1)!;
  const payload = JSON.parse(ev.payload) as {
    thread: string;
    role: string;
    previous: string;
    actor: string;
  };
  assert.equal(payload.thread, "thr_t");
  assert.equal(payload.previous, "executor");
  assert.equal(payload.role, "orchestrator");
  assert.equal(payload.actor, "ui");
  assert.deepEqual(meta, [{ threadId: "thr_t", set: { role: "orchestrator" } }]);
  // The very next configure issues the orchestrator tool set.
  const config = buildAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: "thr_t" } }),
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
  assert.equal(config.tools.length, 6);
});

test("§25: setThreadRole refuses non-pickable roles and clears the badge on none", async () => {
  const { store } = makeStore();
  const meta: { set?: unknown; remove?: string[] }[] = [];
  const rpc = threadRoleRpc(store, {
    updatePluginMetadata: async (a) => {
      meta.push(a);
      return {};
    },
  });
  for (const role of ["helper", "release-auditor", "bogus"]) {
    await assert.rejects(
      rpc.setThreadRole({ threadId: "thr_t", role }),
      (e: unknown) => (e as { code?: string }).code === "role-not-allowed",
    );
  }
  assert.equal(store.threadRole("thr_t"), undefined);
  // a helper thread's own role is plugin-managed — refused as a target.
  store.setThreadRole("thr_hp", "helper", "delegate");
  await assert.rejects(
    rpc.setThreadRole({ threadId: "thr_hp", role: "executor" }),
    (e: unknown) => (e as { code?: string }).code === "role-not-allowed",
  );
  assert.equal(store.threadRole("thr_hp")!.role, "helper");
  // orchestrator → none while the thread runs an ACTIVE delegation:
  // §25 п.3 — no participation refusal, the row is written, the
  // delegation is untouched, the badge is removed.
  const d = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_c",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  store.setStatus(d.id, "running");
  store.setThreadRole("thr_c", "orchestrator", "delegate");
  await rpc.setThreadRole({ threadId: "thr_c", role: "none" });
  const row = store.threadRole("thr_c")!;
  assert.equal(row.role, "none");
  assert.equal(row.source, "owner");
  assert.equal(store.get(d.id)!.status, "running");
  assert.deepEqual(meta.at(-1), { threadId: "thr_c", remove: ["role"] });
});

test("§25 п.4: every role text carries the owner-only role-change line", () => {
  for (const role of Object.values(ROLES)) {
    assert.match(
      role.instructions,
      /Роль треда меняет только владелец в окне треда — не вызывай RPC плагина сам/,
      role.id,
    );
  }
  const en = createT("en");
  for (const id of ["orchestrator", "executor", "auditor", "release-auditor", "helper"] as const) {
    assert.match(
      roleInstructions(id, { t: en }),
      /Only the owner changes thread role in the thread UI — do not call the plugin RPC yourself/,
      id,
    );
  }
});

test("§25: app.roleHelper exists in both catalogs", async () => {
  const { EN } = await import("../src/i18n/en.js");
  const { RU } = await import("../src/i18n/ru.js");
  assert.equal(RU["app.roleHelper"], "Помощник");
  assert.equal(EN["app.roleHelper"], "Helper");
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

test("§17.1: orchestrator and executor instructions forbid host changes", () => {
  for (const id of ["orchestrator", "executor"] as const) {
    const text = ROLES[id].instructions;
    assert.match(text, /ни sudo, ни установки пакетов/, `${id} bans sudo/pkg`);
  }
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
  assert.equal(orch.tools.length, 6);
  assert.deepEqual(orch.skills, ["orchestrator-setup"]);
  const exec = buildAgentConfiguration(ctxFor("thr_e"), {
    ...deps,
    probes: probes("executor"),
  });
  assert.equal(exec.instructions, undefined);
  // §19.1/§26.4: helpers and kb.
  assert.deepEqual(exec.tools, ["orchestrator_helper", "orchestrator_kb"]);
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
  assert.deepEqual(exec.tools, ["orchestrator_helper", "orchestrator_kb"]);
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
  assert.equal(orch.tools.length, 6);
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


// ── §2.3 r24 / §16.7 r25: policy-aware roles, verdict + handoff text ──

test("§2.3 roleForLevel: policy-aware — auditor levels map to auditor", () => {
  const policy = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: {
        "review-mid": { role: "auditor", chain: ["r"] },
        exec: { chain: ["r"] },
      },
      routes: { r: { preset: "p", provider: "x" } },
    }),
  ).policy;
  assert.equal(roleForLevel("review-mid", policy), "auditor");
  assert.equal(roleForLevel("exec", policy), "executor");
  assert.equal(roleForLevel("release-audit", policy), "release-auditor");
  // Without the policy the historical name rule applies.
  assert.equal(roleForLevel("review"), "auditor");
  assert.equal(roleForLevel("review-mid"), "executor");
});

test("§19.3 (r33): invalid policy — the hook still records the role", () => {
  // r33 removed the §16.7 gating: an invalid policy no longer drops the
  // decision — `configure` narrows the issuance to the setup skill.
  const badPolicy: RoleDecisionProbes = { ...noProbes, policy: () => null };
  assert.equal(decideRole(facts({ origin: "app" }), badPolicy), "executor");
  assert.equal(decideRole(facts({ origin: "cli" }), badPolicy), "none");
  // An explicit pending pick still wins — orchestrator included.
  assert.equal(
    decideRole(facts({ origin: "app" }), {
      ...badPolicy,
      pendingRole: (p) => (p === "proj_a" ? "executor" : undefined),
    }),
    "executor",
  );
  assert.equal(
    decideRole(facts({ origin: "app" }), {
      ...badPolicy,
      pendingRole: (p) => (p === "proj_a" ? "orchestrator" : undefined),
    }),
    "orchestrator",
  );
  // Valid policy → the configured default applies (executor without a
  // defaultRole probe).
  const good = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: { simple: { chain: ["s"] } },
      routes: { s: { preset: "p", provider: "x" } },
    }),
  ).policy;
  assert.equal(
    decideRole(facts({ origin: "app" }), { ...noProbes, policy: () => good }),
    "executor",
  );
  // Valid policy → the window's orchestrator pick applies as before.
  assert.equal(
    decideRole(facts({ origin: "app" }), {
      ...noProbes,
      policy: () => good,
      pendingRole: (p) => (p === "proj_a" ? "orchestrator" : undefined),
    }),
    "orchestrator",
  );
  // tasks origin keeps its mapping under an invalid policy.
  assert.equal(
    decideRole(
      facts({ originPluginId: "tasks", title: "PLUG-9 · do x" }),
      badPolicy,
    ),
    "executor",
  );
});

test("§16.7 auditor instructions demand the JSON verdict; §13.1 handoff on doers", () => {
  const auditor = ROLES.auditor.instructions;
  assert.match(auditor, /\{"verdict":"OK"\|"CHANGES","blockers"/);
  assert.ok(!auditor.includes("HANDOFF"), "auditor keeps no handoff file");
  assert.ok(
    !ROLES["release-auditor"].instructions.includes("HANDOFF"),
    "release-auditor keeps no handoff file",
  );
  for (const id of ["orchestrator", "executor"] as const) {
    const text = ROLES[id].instructions;
    assert.match(text, /HANDOFF\.md/, `${id} handoff rule`);
    assert.match(text, /\$BB_THREAD_STORAGE/, `${id} storage path`);
    assert.match(
      text,
      /~\/\.cache\/bb-handoff/,
      `${id} fallback path when no storage`,
    );
  }
});

// ── §17.1 r26 (PLUG-211 Б1/Б2): userThreadPlugins + the r26 role fix ──

test("§17.1 r26 (Б2): a userThreadPlugins thread inherits the source role", () => {
  // a listed plugin's thread with a decidable source inherits it —
  // like any side chat (the list itself is not needed on this branch).
  assert.equal(
    decideRole(
      facts({
        origin: "plugin",
        originPluginId: "handoff",
        sourceThreadId: "thr_src",
      }),
      {
        ...noProbes,
        threadRole: (id) =>
          id === "thr_src" ? { role: "executor" } : undefined,
      },
    ),
    "executor",
  );
});

test("§19.3 (r33): a handoff thread without a decidable source → the configured default", () => {
  // §18.6: the DEFAULT list is empty — a listed plugin is configured
  // explicitly, like the author's install does.
  const userPlugins = () => ["handoff", "external-compact"];
  // no source thread — the continued human chat gets the default role
  // (executor absent a defaultRole probe).
  assert.equal(
    decideRole(facts({ origin: "plugin", originPluginId: "handoff" }), {
      ...noProbes,
      userThreadPlugins: userPlugins,
    }),
    "executor",
  );
  assert.equal(
    decideRole(facts({ origin: "plugin", originPluginId: "handoff" }), {
      ...noProbes,
      userThreadPlugins: userPlugins,
      defaultRole: () => "orchestrator",
    }),
    "orchestrator",
  );
  // §17.1 (PLUG-215 С2): a source without a recorded role falls through
  // to the PARENT branch — the parent rule beats userThreadPlugins: a
  // handed-off worker is an executor, not a human chat.
  assert.equal(
    decideRole(
      facts({
        origin: "plugin",
        originPluginId: "handoff",
        sourceThreadId: "thr_src",
        parentThreadId: "thr_p",
      }),
      { ...noProbes, userThreadPlugins: userPlugins },
    ),
    "executor",
  );
  // a plugin NOT in the configured list keeps `none` — the list decides
  assert.equal(
    decideRole(facts({ origin: "plugin", originPluginId: "handoff" }), {
      ...noProbes,
      userThreadPlugins: () => [],
    }),
    "none",
  );
  // other plugin ids still get none
  assert.equal(
    decideRole(facts({ origin: "plugin", originPluginId: "advisor" }), noProbes),
    "none",
  );
  assert.equal(
    decideRole(
      facts({ origin: "plugin", originPluginId: "live-call" }),
      noProbes,
    ),
    "none",
  );
  // §19.3: an invalid policy no longer drops the decision — the hook
  // records the configured default anyway.
  assert.equal(
    decideRole(facts({ origin: "plugin", originPluginId: "handoff" }), {
      ...noProbes,
      userThreadPlugins: userPlugins,
      policy: () => null,
    }),
    "executor",
  );
});

test("§17.1 r26 (PLUG-215 Б1): a configured external-compact continues the human chat", () => {
  const userPlugins = () => ["handoff", "external-compact"];
  // `bb external-compact` continues the human chat in a new thread —
  // without a decidable source it gets the configured default.
  assert.equal(
    decideRole(
      facts({ origin: "plugin", originPluginId: "external-compact" }),
      { ...noProbes, userThreadPlugins: userPlugins },
    ),
    "executor",
  );
  // …and inherits the source role when decidable.
  assert.equal(
    decideRole(
      facts({
        origin: "plugin",
        originPluginId: "external-compact",
        sourceThreadId: "thr_src",
      }),
      {
        ...noProbes,
        userThreadPlugins: userPlugins,
        threadRole: (id) =>
          id === "thr_src" ? { role: "auditor" } : undefined,
      },
    ),
    "auditor",
  );
});

test("§18.6: an EMPTY userThreadPlugins default denies handoff threads", () => {
  // A new installation's default list is empty — a handoff-born thread
  // is plugin-born like any other and records `none`.
  assert.equal(
    decideRole(
      facts({ origin: "plugin", originPluginId: "handoff" }),
      noProbes,
    ),
    "none",
  );
});

test("§17.1 r26 (PLUG-215 С2): the parent rule beats userThreadPlugins", () => {
  // a handed-off WORKER (the plugin's thread kept its parent) is an
  // executor — the human-chat default is for parentless threads only.
  const userPlugins = () => ["handoff", "external-compact"];
  for (const pluginId of ["handoff", "external-compact"]) {
    assert.equal(
      decideRole(
        facts({
          origin: "plugin",
          originPluginId: pluginId,
          parentThreadId: "thr_p",
        }),
        { ...noProbes, userThreadPlugins: userPlugins },
      ),
      "executor",
      pluginId,
    );
  }
});

test("§19.3 (r33): the hook records the configured default for a handoff thread", () => {
  const { store, probes } = makeStore();
  const hook = (ctx: MessageDispatchHookContext) =>
    handleMessageDispatch(
      ctx,
      {
        ...probes,
        userThreadPlugins: () => ["handoff", "external-compact"],
      },
      (threadId, role) => store.setThreadRole(threadId, role, "hook"),
    );
  const decision = hook(
    dispatch({
      thread: { id: "thr_ho", status: "pending", originPluginId: "handoff" },
      origin: "plugin",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
  );
  assert.deepEqual(decision, { action: "proceed" });
  assert.equal(store.threadRole("thr_ho")!.role, "executor");
});

test("§17.1 r26 (Б1): the one-time migration rewrites plugin orchestrator rows", async () => {
  const { store } = makeStore();
  // live pre-r26 rows: plugin-created threads wrongly recorded
  // `orchestrator` before the §17.1 plugin rule existed.
  for (const id of ["thr_adv", "thr_call", "thr_persp", "thr_ext"]) {
    store.setThreadRole(id, "orchestrator", "hook");
  }
  store.setThreadRole("thr_app", "orchestrator", "hook"); // human chat
  store.setThreadRole("thr_cli", "orchestrator", "hook"); // bb thread spawn
  store.setThreadRole("thr_ho", "orchestrator", "hook"); // handoff — user chat
  store.setThreadRole("thr_del", "orchestrator", "delegate"); // not hook-written
  const origins = new Map<string, string | null>([
    ["thr_adv", "advisor"],
    ["thr_call", "live-call"],
    ["thr_persp", "perspectives"],
    ["thr_ext", "external-compact"],
    ["thr_app", null],
    ["thr_cli", null],
    ["thr_ho", "handoff"],
    ["thr_del", "advisor"],
  ]);
  const moved = await migratePluginThreadRoles(store, {
    threadOriginPluginId: async (id) => origins.get(id),
    userThreadPlugins: ["handoff", "external-compact"],
  });
  assert.equal(moved, 3);
  for (const id of ["thr_adv", "thr_call", "thr_persp"]) {
    assert.equal(store.threadRole(id)!.role, "none", id);
  }
  // PLUG-215 Б1: external-compact is in the configured userThreadPlugins —
  // its orchestrator row is not stale and survives the migration.
  for (const id of ["thr_app", "thr_cli", "thr_ho", "thr_ext"]) {
    assert.equal(store.threadRole(id)!.role, "orchestrator", id);
  }
  // a `delegate`-sourced row is the delegate path's own correction —
  // the migration only owns hook-written rows
  assert.equal(store.threadRole("thr_del")!.role, "orchestrator");
  // a thread whose origin read fails is skipped, not rewritten
  store.setThreadRole("thr_gone", "orchestrator", "hook");
  const warns: string[] = [];
  const moved2 = await migratePluginThreadRoles(store, {
    threadOriginPluginId: async (id) => {
      if (id === "thr_gone") throw new Error("thread not found");
      return origins.get(id);
    },
    userThreadPlugins: ["handoff", "external-compact"],
    log: { warn: (m) => warns.push(m) },
  });
  // the first pass already rewrote the live rows — only the skipped
  // thread is left in scope
  assert.equal(moved2, 0);
  assert.equal(store.threadRole("thr_gone")!.role, "orchestrator");
  assert.equal(warns.length, 1);
});

test("decideRole: an orchestrator-origin (own-spawn) thread is an executor too (r30 д)", () => {
  // §4 r30 д: own-spawn executors carry originPluginId "orchestrator"
  assert.equal(
    decideRole(
      facts({ originPluginId: "orchestrator", title: "PLUG-7 · do it" }),
      {
        ...noProbes,
        activeDelegationByTaskKey: (k) =>
          k === "PLUG-7" ? { level: "simple" } : undefined,
      },
    ),
    "executor",
  );
  // the level still decides auditor vs executor
  assert.equal(
    decideRole(
      facts({
        originPluginId: "orchestrator",
        title: "PLUG-7 · review it",
        parentThreadId: "thr_parent", // the origin rule beats the parent one
      }),
      {
        ...noProbes,
        activeDelegationByTaskKey: (k) =>
          k === "PLUG-7" ? { level: "review" } : undefined,
      },
    ),
    "auditor",
  );
  // no delegation row → executor, like a tasks thread
  assert.equal(
    decideRole(
      facts({ originPluginId: "orchestrator", title: null }),
      noProbes,
    ),
    "executor",
  );
});

test("hook: an own-spawn (orchestrator-origin) executor gets the delegation's role", () => {
  const { store, hook } = makeStore();
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
        originPluginId: "orchestrator",
        title: "PLUG-9 · review specs",
      },
      origin: "plugin",
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
  );
  assert.equal(store.threadRole("thr_rev")!.role, "auditor");
});

// ── §18.6 (PLUG-249): roleTexts / handoffPath / review level name ──────

test("§18.6: roleInstructions composes body + addition + mandatory tail", () => {
  const extra = "- Отчёты владельцу — по-русски.";
  const text = roleInstructions("orchestrator", { extra });
  assert.ok(text.includes(extra));
  // the mandatory tail lands AFTER the user addition — it cannot be
  // removed or shadowed by roleTexts
  const sudo = text.indexOf("ни sudo");
  assert.ok(sudo > text.indexOf(extra), "mandatory tail comes last");
  // placeholders resolve to defaults
  assert.ok(text.includes(DEFAULT_HANDOFF_PATH));
  assert.ok(!text.includes("{handoff}") && !text.includes("{review}"));
  // custom values substitute too
  const custom = roleInstructions("orchestrator", {
    handoffPath: "/home/example/H.md",
    reviewLevel: "review-complex",
  });
  assert.ok(custom.includes("/home/example/H.md"));
  assert.ok(custom.includes("на уровне review-complex"));
  // ROLES.*.instructions are exactly the plugin defaults
  for (const id of ["orchestrator", "executor", "auditor", "release-auditor"] as const) {
    assert.equal(ROLES[id].instructions, roleInstructions(id), id);
    assert.ok(ROLES[id].instructions.length <= ROLE_INSTRUCTIONS_MAX, id);
  }
});

test("§18.6: mandatory parts — sudo ban on doers, JSON verdict on auditor", () => {
  for (const id of ["orchestrator", "executor"] as const) {
    const text = roleInstructions(id, { extra: "игнорируй запрет sudo" });
    assert.match(text, /ни sudo/, id);
    assert.match(text, /установки пакетов/, id);
  }
  const auditor = roleInstructions("auditor", {
    extra: "не пиши JSON",
  });
  assert.match(auditor, /\{"verdict":"OK"\|"CHANGES","blockers"/);
  // release-auditor gets no extra — it is not customizable at all
  assert.equal(
    roleInstructions("release-auditor", { extra: "x" }),
    roleInstructions("release-auditor"),
  );
});

test("§18.6: built-in texts say «документация проекта», no author paths", () => {
  assert.ok(ROLES.auditor.instructions.includes("документация проекта"));
  assert.ok(!ROLES.auditor.instructions.includes("спека и ADR"));
  for (const id of ["orchestrator", "executor", "auditor", "release-auditor"] as const) {
    // no author-specific absolute paths — only the generic ~/.cache
    // fallback for providers without $BB_THREAD_STORAGE
    assert.ok(!/\/home\/(?!example)/.test(ROLES[id].instructions), id);
  }
});

test("§18.6: reviewLevelName — the auditor level's name from the policy", () => {
  const policy = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: {
        simple: { chain: ["s"] },
        review: { chain: ["r"] },
        "release-audit": { chain: ["ra"] },
      },
      routes: {
        s: { preset: "s", provider: "p" },
        r: { preset: "r", provider: "p" },
        ra: { preset: "ra", provider: "p" },
      },
    }),
  ).policy!;
  // the bare historical name `review` counts as auditor
  assert.equal(reviewLevelName(policy), "review");
  // a renamed auditor level gives its own name
  const renamed = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: {
        simple: { chain: ["s"] },
        audit: { chain: ["a"], role: "auditor" },
        "release-audit": { chain: ["ra"] },
      },
      routes: {
        s: { preset: "s", provider: "p" },
        a: { preset: "a", provider: "p" },
        ra: { preset: "ra", provider: "p" },
      },
    }),
  ).policy!;
  assert.equal(reviewLevelName(renamed), "audit");
  // release-audit alone is never picked; no auditor level → the default
  const execOnly = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: {
        simple: { chain: ["s"] },
        "release-audit": { chain: ["ra"] },
      },
      routes: {
        s: { preset: "s", provider: "p" },
        ra: { preset: "ra", provider: "p" },
      },
    }),
  ).policy!;
  assert.equal(reviewLevelName(execOnly), "review");
  assert.equal(reviewLevelName(null), "review");
});

test("§18.6: parseRoleTexts — keys, types, the 2500 limit, whole-doc errors", () => {
  // a valid document yields the trimmed additions
  const ok = parseRoleTexts(
    JSON.stringify({
      orchestrator: "  - custom  ",
      executor: "- do x",
      auditor: "- check y",
    }),
  );
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.texts.orchestrator, "- custom");
  // unknown keys — release-auditor included — are errors, and a broken
  // document applies NOTHING (ignored whole)
  for (const bad of [
    '{"release-auditor": "x"}',
    '{"janitor": "x"}',
    '{"executor": 42}',
    '["executor"]',
    "{bad",
  ]) {
    const l = parseRoleTexts(bad);
    assert.ok(l.errors.length > 0, bad);
    assert.deepEqual(l.texts, {}, bad);
  }
  // an addition pushing the composed text over the BB budget errors
  const l = parseRoleTexts(
    JSON.stringify({ executor: "x".repeat(ROLE_INSTRUCTIONS_MAX) }),
  );
  assert.ok(
    l.errors.some((e) => e.path === "roleTexts.executor"),
    "over-limit executor",
  );
  // a mixed document — one bad key poisons the whole thing
  const mixed = parseRoleTexts(
    JSON.stringify({ orchestrator: "- ok", auditor: 1 }),
  );
  assert.deepEqual(mixed.texts, {});
  // empty / whitespace means "no additions", no error
  assert.equal(parseRoleTexts("").errors.length, 0);
  assert.equal(parseRoleTexts("  ").errors.length, 0);
  // the needs-configuration line names the first issue
  assert.match(roleTextsError(mixed) ?? "", /roleTexts\.auditor/);
  assert.equal(roleTextsError(ok), null);
});

test("§18.6: userThreadPlugins defaults to an EMPTY list", () => {
  assert.deepEqual([...DEFAULT_USER_THREAD_PLUGINS], []);
});

test("§18.6: handoffPath — one line of at most 256 characters", () => {
  assert.equal(handoffPathError(undefined), null);
  assert.equal(handoffPathError(""), null);
  assert.equal(handoffPathError("   "), null);
  assert.equal(handoffPathError("/home/example/H.md"), null);
  assert.equal(handoffPathError("p".repeat(HANDOFF_PATH_MAX)), null);
  assert.match(
    handoffPathError("p".repeat(HANDOFF_PATH_MAX + 1)) ?? "",
    /256/,
  );
  assert.match(handoffPathError("a\nb") ?? "", /одной строкой/);
  assert.match(handoffPathError("a\rb") ?? "", /одной строкой/);
});

test("§18.6: the 2500 limit is checked on the REAL substitutions", () => {
  // An addition sized to fit under the default handoffPath (29 chars)…
  const base = roleInstructions("orchestrator");
  const extra = "y".repeat(ROLE_INSTRUCTIONS_MAX - base.length - 150);
  const doc = JSON.stringify({ orchestrator: extra });
  assert.equal(parseRoleTexts(doc).errors.length, 0, "fits by default");
  // …overflows once a real 256-char handoffPath is substituted (+227).
  const longPath = "/" + "p".repeat(HANDOFF_PATH_MAX - 1);
  const real = parseRoleTexts(doc, { handoffPath: longPath });
  assert.ok(real.errors.length > 0, "over the limit with the real path");
  assert.deepEqual(real.texts, {}, "an over-limit document applies nothing");
  // …and once a real review-level name longer than "review" is used —
  // only for the orchestrator text, other roles are unaffected (the
  // executor text carries no {review} and stays well under the limit).
  const longLevel = "review-" + "l".repeat(HANDOFF_PATH_MAX);
  const realLevel = parseRoleTexts(doc, { reviewLevel: longLevel });
  assert.ok(realLevel.errors.length > 0, "over with the real level name");
  const executorDoc = JSON.stringify({ executor: "- small note" });
  assert.equal(
    parseRoleTexts(executorDoc, {
      handoffPath: longPath,
      reviewLevel: longLevel,
    }).errors.length,
    0,
    "executor text has no {review} substitution",
  );
});

test("§18.6: composed role + a 1500-char rule stays under 4096 — the SDK never truncates the mandatory tail", () => {
  // The biggest valid addition keeps the role text at exactly 2500; the
  // coordinator instructions (role + rule + separator) then fit the SDK
  // limit with the mandatory tail intact — never cut mid-text.
  for (const id of ["orchestrator", "executor", "auditor"] as const) {
    const full = roleInstructions(id);
    const extra = "y".repeat(ROLE_INSTRUCTIONS_MAX - full.length - 1);
    const text = roleInstructions(id, { extra });
    assert.equal(text.length, ROLE_INSTRUCTIONS_MAX, id);
    const config = buildAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_x" } }),
      {
        injectInstructions: true,
        instructionsText: "r".repeat(1500),
        probes: {
          delegationByThreadId: () => undefined,
          hasFreshDispatching: () => false,
          roleByThreadId: () => (id === "orchestrator" ? id : undefined),
        },
        roleInstructions: () => text,
      },
    );
    const composed = config.instructions ?? "";
    assert.ok(composed.length <= 4096, `${id}: ${composed.length}`);
    // the mandatory tail survives inside the composed instructions
    assert.ok(
      composed.includes(id === "auditor" ? '"blockers"' : "ни sudo"),
      `${id}: mandatory tail truncated`,
    );
  }
});

test("roles: DEFAULT_ROLE is executor (owner decision 15.11 & UI parity)", () => {
  assert.equal(DEFAULT_ROLE, "executor");
});

