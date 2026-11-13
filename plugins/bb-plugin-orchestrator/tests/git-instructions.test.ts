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
  NO_CODE_LINE,
} from "../src/instructions.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { ThreadFacts } from "../src/agent-config.js";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";

const POLICY_TEXT = JSON.stringify({
  version: 1,
  levels: {
    simple: { chain: ["simple"] },
    review: { chain: ["simple"] },
  },
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
  const spawnCalls: { prompt?: string; pluginMetadata?: unknown }[] = [];
  const cli: BbCli = {
    run: async (args) => {
      calls.push(args);
      if (overrides.cli) return overrides.cli(args);
      const key = args.join(" ");
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
      if (key.startsWith("tasks dispatch"))
        return ok(JSON.stringify({ task: { id: "task-1" }, threadId: "thr_exec" }));
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
      return ok();
    },
  };
  const deps: DelegateDeps & DispatchStepsDeps = {
    store,
    bbCli: cli,
    threads: {
      spawn: async (a) => {
        spawnCalls.push(a as { prompt?: string });
        return { id: "thr_exec" };
      },
      list: async () => [],
      update: async () => ({}),
      stop: async () => ({}),
    },
    primaryHostId: async () => "host_test",
    loadPolicy: async () => parsePolicy(POLICY_TEXT, PRESETS),
    probes: {
      delegationByThreadId: (id) => store.byThreadId(id),
      hasFreshDispatching: (s, scope) => store.hasFreshDispatching(s, scope),
    },
    ...(overrides.gitInstructions !== undefined
      ? { gitInstructions: () => overrides.gitInstructions }
      : {}),
  };
  return { deps, store, calls, spawnCalls };
}

/** The «Additional instructions» section of the last `threads.spawn`
 * prompt — the merged git/round/extra text, if a section was sent. */
function dispatchedInstructions(
  spawnCalls: { prompt?: string }[],
): string | undefined {
  const prompt = [...spawnCalls].reverse().find((c) => c.prompt)?.prompt;
  const m = prompt?.match(/## Additional instructions\n\n([\s\S]*?)(?:\n\n## |$)/u);
  return m?.[1].trimEnd();
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
  const { deps, spawnCalls } = makeDeps({ gitInstructions: "GIT-RULES" });
  await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "simple",
      instructions: "EXTRA",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(dispatchedInstructions(spawnCalls), "GIT-RULES\n\nEXTRA");
});

test("dispatchToRoute (the reissue path) sends the same git section", async () => {
  // §5.4 reissues go through the same shared dispatch step, so the section
  // lands on reissued threads too.
  const { deps, store, spawnCalls } = makeDeps({ gitInstructions: "GIT-RULES" });
  const row = insertRow(store);
  await dispatchToRoute(row, { instructions: "EXTRA" }, deps);
  assert.equal(dispatchedInstructions(spawnCalls), "GIT-RULES\n\nEXTRA");
});

test("empty gitInstructions adds no section and no flag", async () => {
  const { deps, spawnCalls } = makeDeps({ gitInstructions: "  \n " });
  await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  assert.equal(dispatchedInstructions(spawnCalls), undefined);
  assert.equal(spawnCalls.length, 1, "spawned without an instructions section");
});

test("empty gitInstructions still passes call instructions alone", async () => {
  const { deps, spawnCalls } = makeDeps({ gitInstructions: "" });
  await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "simple",
      instructions: "EXTRA",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(dispatchedInstructions(spawnCalls), "EXTRA");
});

test("over-limit gitInstructions is skipped, extras still pass", async () => {
  const { deps, spawnCalls } = makeDeps({
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
  assert.equal(dispatchedInstructions(spawnCalls), "EXTRA");
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
    agentSkillIds: [
        "orchestrator-setup",
        "orchestrator-coordinator",
        "orchestrator-setup-ru",
        "orchestrator-coordinator-ru",
      ],
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

// ── Wiring through the server factory: setting → stepsDeps → dispatch ──

function fakeCli(respond?: (args: string[]) => BbCliResult | undefined) {
  const calls: string[][] = [];
  return {
    calls,
    cli: {
      run: async (args: string[]) => {
        calls.push(args);
        const custom = respond?.(args);
        if (custom) return custom;
        const key = args.join(" ");
        if (key.startsWith("tasks preset list"))
          return ok(JSON.stringify({ presets: [{ name: "simple", id: "p1" }] }));
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
        return ok();
      },
    } satisfies BbCli,
  };
}

const COORDINATOR_THREAD = {
  id: "thr_coord",
  parentThreadId: null,
  title: "coordinator",
  titleFallback: null,
  originPluginId: null,
  projectId: "proj_main",
};

async function hostWith(
  settings: Record<string, string | boolean>,
  cli: BbCli,
) {
  const spawnCalls: { prompt?: string }[] = [];
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    settings: { policy: POLICY_TEXT, language: "ru", ...settings },
    agentSkillIds: [
        "orchestrator-setup",
        "orchestrator-coordinator",
        "orchestrator-setup-ru",
        "orchestrator-coordinator-ru",
      ],
    sdk: {
      threads: {
        get: async () => COORDINATOR_THREAD,
        spawn: async (a: { prompt?: string }) => {
          spawnCalls.push(a);
          return { id: "thr_exec" };
        },
        list: async () => [],
        update: async () => ({}),
      },
    } as never,
  });
  await createPlugin(host.bb, { bbCli: cli });
  return { host, spawnCalls };
}

const delegate = (host: Awaited<ReturnType<typeof hostWith>>["host"], key = "PLUG-1") =>
  host.harness.runCli(
    ["delegate", key, "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );

test("server wiring: the default gitInstructions section reaches the dispatch", async () => {
  const { cli } = fakeCli();
  const { host, spawnCalls } = await hostWith({}, cli);
  const res = await delegate(host);
  assert.equal(res.exitCode, 0);
  const instructions = dispatchedInstructions(spawnCalls);
  assert.ok(instructions?.startsWith("Работа с git:"));
  assert.equal(instructions, DEFAULT_GIT_INSTRUCTIONS);
});

test("server wiring: a custom setting value reaches the dispatch", async () => {
  const { cli } = fakeCli();
  const { host, spawnCalls } = await hostWith({ gitInstructions: "CUSTOM-GIT" }, cli);
  const res = await delegate(host);
  assert.equal(res.exitCode, 0);
  assert.equal(dispatchedInstructions(spawnCalls), "CUSTOM-GIT");
});

test("server wiring: an emptied setting drops the section", async () => {
  const { cli } = fakeCli();
  const { host, spawnCalls } = await hostWith({ gitInstructions: "" }, cli);
  const res = await delegate(host);
  assert.equal(res.exitCode, 0);
  assert.equal(dispatchedInstructions(spawnCalls), undefined);
});

test("server wiring: a settings change is picked up by the next dispatch", async () => {
  const { cli } = fakeCli();
  const { host, spawnCalls } = await hostWith({ gitInstructions: "GIT-V1" }, cli);
  assert.equal((await delegate(host)).exitCode, 0);
  assert.equal(dispatchedInstructions(spawnCalls), "GIT-V1");
  await host.harness.setSettings({ gitInstructions: "GIT-V2" });
  assert.equal((await delegate(host, "PLUG-2")).exitCode, 0);
  assert.equal(dispatchedInstructions(spawnCalls), "GIT-V2");
});

// ── rev 23: rounds — «Заход N» in --instructions, --from/--fresh ────────

test("round 2 dispatch gets the «Заход 2» section with the round-1 SHA", async () => {
  const { deps, store, spawnCalls } = makeDeps();
  const prev = insertRow(store);
  store.setStatus(prev.id, "done");
  store.setRoundResult(prev.id, {
    branch: "exec-r1",
    sha: "abc123def",
    commits: 3,
    dirty: false,
  });
  await runDelegate(
    { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
    deps,
  );
  const text = dispatchedInstructions(spawnCalls)!;
  assert.match(text, /Заход 2: продолжение работы с коммита abc123def/);
  assert.match(text, /ветка exec-r1 прошлого захода/);
  assert.match(text, /git merge --ff-only abc123def/);
  assert.match(text, /git merge -m "merge abc123d" abc123def/);
  const row = store.listActive()[0]!;
  assert.equal(row.round, 2);
  assert.equal(row.continue_from, "abc123def");
});

test("--fresh disables continuation: no Заход section, continue_from null", async () => {
  const { deps, store, spawnCalls } = makeDeps();
  const prev = insertRow(store);
  store.setStatus(prev.id, "done");
  store.setRoundResult(prev.id, {
    branch: "exec-r1",
    sha: "abc123def",
    commits: 3,
    dirty: false,
  });
  await runDelegate(
    { taskKey: "PLUG-1", level: "simple", fresh: true, caller: COORDINATOR },
    deps,
  );
  const text = dispatchedInstructions(spawnCalls);
  assert.ok(!text || !/Заход/.test(text), `unexpected section: ${text}`);
  const row = store.listActive()[0]!;
  assert.equal(row.round, 2);
  assert.equal(row.continue_from, null);
});

test("--from overrides continuation with the given ref", async () => {
  const { deps, store, spawnCalls } = makeDeps();
  await runDelegate(
    { taskKey: "PLUG-1", level: "simple", from: "deadbeef", caller: COORDINATOR },
    deps,
  );
  const text = dispatchedInstructions(spawnCalls)!;
  assert.match(text, /Заход 1: продолжение работы с коммита deadbeef/);
  const row = store.listActive()[0]!;
  assert.equal(row.continue_from, "deadbeef");
});

test("a reissue inherits round and continue_from — the same «Заход N»", async () => {
  const { deps, store, spawnCalls } = makeDeps();
  const row = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    projectId: "proj_main",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
    round: 1,
    continueFrom: "abc123def",
  });
  store.setStatus(row.id, "stalled");
  const fresh = store.reissue(row.id, {
    route: "simple",
    preset: "simple",
    provider: "p",
  })!;
  // §4.1 r23: a reissue retries the same round, not round + 1
  assert.equal(fresh.round, 1);
  assert.equal(fresh.continue_from, "abc123def");
  await dispatchToRoute(fresh, {}, deps);
  assert.match(
    dispatchedInstructions(spawnCalls)!,
    /Заход 1: продолжение работы с коммита abc123def/,
  );
});

test("reissue accepts a failed row (§5.4 r23)", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const row = store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
  });
  store.setStatus(row.id, "failed");
  const fresh = store.reissue(row.id, {
    route: "simple-alt",
    preset: "simple-alt",
    provider: "p2",
  });
  assert.ok(fresh);
  assert.equal(store.get(row.id)!.status, "reissued");
  assert.equal(fresh.route, "simple-alt");
});

test("--from + --fresh → incompatible-flags, nothing inserted", async () => {
  const { deps, store, calls, spawnCalls } = makeDeps();
  await assert.rejects(
    runDelegate(
      {
        taskKey: "PLUG-1",
        level: "simple",
        from: "abc123def",
        fresh: true,
        caller: COORDINATOR,
      },
      deps,
    ),
    (e: unknown) =>
      e instanceof Error && (e as { code?: string }).code === "incompatible-flags",
  );
  assert.equal(store.activeCount(), 0);
  assert.ok(
    !calls.some((c) => c.join(" ").startsWith("tasks dispatch")),
    "no dispatch expected",
  );
});

test("review level gets «Проверяемый итог», not the «Заход N» section", async () => {
  const { deps, store, spawnCalls } = makeDeps();
  const prev = insertRow(store);
  store.setStatus(prev.id, "done");
  store.setRoundResult(prev.id, {
    branch: "exec-r1",
    sha: "abc123def",
    commits: 3,
    dirty: false,
  });
  await runDelegate(
    { taskKey: "PLUG-1", level: "review", caller: COORDINATOR },
    deps,
  );
  const text = dispatchedInstructions(spawnCalls)!;
  // §4.1 r23: a read-only role gets the commit to check, no git commands
  assert.match(
    text,
    /Проверяемый итог: коммит abc123def \(ветка exec-r1, заход 1\)/,
  );
  assert.ok(!/Заход|git merge/.test(text), `unexpected section: ${text}`);
  const row = store.listActive()[0]!;
  assert.equal(row.level, "review");
  assert.equal(row.continue_from, "abc123def");
});

test("review level with an unrecorded --from ref names just the commit", async () => {
  const { deps, spawnCalls } = makeDeps();
  await runDelegate(
    { taskKey: "PLUG-1", level: "review", from: "deadbeef", caller: COORDINATOR },
    deps,
  );
  const text = dispatchedInstructions(spawnCalls)!;
  assert.match(text, /^Проверяемый итог: коммит deadbeef$/m);
  assert.ok(!/Заход|git merge/.test(text), `unexpected section: ${text}`);
});

// ── §4.1 r28 (PLUG-237): the «задача без кода» instruction line ───────

test("mergeDispatchInstructions: the no-code line lands before extras", () => {
  // §4.1 r28.1: the git memo is NOT sent for a no-code row — its commit
  // requirements would contradict the «не коммитить» line.
  const merged = mergeDispatchInstructions("GIT-RULES", "EXTRA", undefined, true)!;
  assert.equal(
    merged,
    "задача без кода: файлы репозитория не менять, не коммитить; итог — отчёт\n\nEXTRA",
  );
  assert.equal(
    mergeDispatchInstructions(undefined, undefined, undefined, true),
    NO_CODE_LINE,
  );
  assert.equal(
    mergeDispatchInstructions(undefined, undefined, undefined, false),
    undefined,
  );
});

test("§4.1 r28.1: no-code instructions carry no requirement to commit", () => {
  // The §2.2 memo's commit/branch/SHA-in-the-report requirements must not
  // reach a no-code executor — with the default memo nothing but
  // NO_CODE_LINE remains, whatever text the memo itself holds.
  const merged = mergeDispatchInstructions(
    DEFAULT_GIT_INSTRUCTIONS,
    undefined,
    undefined,
    true,
  )!;
  assert.equal(merged, NO_CODE_LINE);
  const requirements = merged.replace(NO_CODE_LINE, "");
  assert.doesNotMatch(requirements, /коммит|commit|sha/i);
  assert.doesNotMatch(merged, /локальный коммит|ветка и SHA/);
});

test("§4.1 r28.1: a «Заход N» section still reaches a no-code round", () => {
  // The continuation merge commands are positioning, not a commit
  // requirement — they stay; only the §2.2 memo is dropped.
  const merged = mergeDispatchInstructions(
    DEFAULT_GIT_INSTRUCTIONS,
    undefined,
    "Заход 2: продолжение работы с коммита abc123def",
    true,
  )!;
  assert.match(merged, /Заход 2: продолжение работы с коммита abc123def/);
  assert.match(merged, /задача без кода/);
  assert.doesNotMatch(merged, /локальный коммит|ветка и SHA/);
});

test("§4.1 r28: dispatchToRoute adds the no-code line for a marked row", async () => {
  const { deps, store, spawnCalls } = makeDeps({ gitInstructions: "GIT-RULES" });
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
  await dispatchToRoute(row, {}, deps);
  // r28.1: the §2.2 memo is dropped — the no-code line goes out alone.
  assert.equal(
    dispatchedInstructions(spawnCalls),
    "задача без кода: файлы репозитория не менять, не коммитить; итог — отчёт",
  );
});

test("§4.1 r28: a reissue of a no_code row dispatches the line too", async () => {
  // §5.4: the reissue inherits the mark through store.reissue — the line
  // reaches the replacement executor without the coordinator re-flagging.
  const { deps, store, spawnCalls } = makeDeps();
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
  const fresh = store.reissue(row.id, {
    route: "simple",
    preset: "simple",
    provider: "p",
  })!;
  assert.equal(fresh.no_code, 1);
  await dispatchToRoute(fresh, {}, deps);
  assert.match(dispatchedInstructions(spawnCalls)!, /задача без кода/);
});
