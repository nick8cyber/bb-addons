import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import { parsePolicy } from "../src/policy.js";
import { OrchestratorError } from "../src/errors.js";
import {
  runDelegate,
  dispatchToRoute,
  createDelegateQueue,
  type DelegateDeps,
  type DispatchStepsDeps,
} from "../src/delegate.js";
import {
  createWatchdog,
  type WatchdogThreadDto,
  type WatchdogThreadEvent,
} from "../src/watchdog.js";
import { T_RU } from "../src/i18n/index.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { ThreadFacts } from "../src/agent-config.js";

const T0 = 1_700_000_000_000;
const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

// §20.1 п.5 (r34.4) test policy: `web-review` and `web-research` share
// the `shared-tab` quotaGroup with `maxActive: 1` — provider-neutral
// names; the busy-route queue contract no longer needs `tools: false`.
const POLICY_TEXT = JSON.stringify({
  version: 1,
  firstResponseSeconds: 30,
  limits: { maxActive: 10 },
  levels: {
    review: {
      role: "auditor",
      chain: ["web-review", "local-review"],
      autoFallback: true,
    },
    research: { role: "researcher", chain: ["web-research"], autoFallback: true },
    simple: { chain: ["simple"] },
  },
  routes: {
    "web-review": {
      preset: "w-r",
      provider: "prov-x",
      maxActive: 1,
      quotaGroup: "shared-tab",
    },
    "local-review": { preset: "l-r", provider: "acp-devin" },
    "web-research": {
      preset: "w-r2",
      provider: "prov-x",
      maxActive: 1,
      quotaGroup: "shared-tab",
    },
    simple: { preset: "simple", provider: "acp-opencode" },
  },
});
const PRESETS = new Set(["w-r", "l-r", "w-r2", "simple"]);

const FULL_PRESET = {
  providerId: "acp-devin",
  modelId: "m1",
  reasoningLevel: "medium",
  serviceTier: null,
  permissionMode: "full",
  environmentKind: "project-default",
  baseBranch: null,
  machineId: null,
  instructions: "",
};

const taskShowJson = (key: string) =>
  JSON.stringify({
    task: {
      id: "task-1",
      key,
      title: "do it",
      description: "the task body",
      status: "todo",
    },
    project: { name: "main", linkedBbProjectId: "proj_bb" },
    subtasks: [],
    attachments: [],
    comments: [],
  });

const boundThreadJson = JSON.stringify({
  thread: {
    parentThreadId: "thr_coord",
    parentNotifications: "auto",
    visibility: "hidden",
  },
});

function defaultCli(args: string[]): BbCliResult {
  const key = args.join(" ");
  if (key.startsWith("tasks show")) return ok(taskShowJson(args[2] ?? "PLUG-1"));
  if (key.startsWith("tasks dispatch"))
    return ok(
      JSON.stringify({ task: { id: "task-1" }, preset: {}, threadId: "thr_exec" }),
    );
  if (key.startsWith("tasks preset show"))
    return ok(JSON.stringify({ preset: FULL_PRESET }));
  if (key.startsWith("thread show")) return ok(boundThreadJson);
  if (key.startsWith("thread options") && key.includes("--json"))
    return ok(
      JSON.stringify({
        options: [
          {
            id: "mode",
            type: "select",
            value: "acceptEdits",
            values: [{ id: "acceptEdits" }],
          },
        ],
      }),
    );
  return ok();
}

const COORDINATOR: ThreadFacts = {
  threadId: "thr_coord",
  parentThreadId: null,
  title: "coordinate work",
  originPluginId: null,
  projectId: "proj_main",
};

function makeDelegateDeps(
  overrides: {
    cli?: (args: string[]) => BbCliResult | Promise<BbCliResult>;
    policyText?: string;
    presets?: Set<string>;
    spawn?: (a: Record<string, unknown>) => Promise<{ id?: string }>;
  } = {},
) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const spawnArgs: Record<string, unknown>[] = [];
  let nowVal = T0;
  const threads = {
    spawn: async (args: any) => {
      spawnArgs.push(args);
      return overrides.spawn ? overrides.spawn(args) : { id: "thr_exec" };
    },
    list: async () => [],
    getPluginMetadata: async () => null,
    update: async () => ({}),
    stop: async () => ({}),
    updatePluginMetadata: async () => ({}),
  } as unknown as DelegateDeps["threads"];
  const policyOf = () =>
    parsePolicy(overrides.policyText ?? POLICY_TEXT, overrides.presets ?? PRESETS);
  const deps: DelegateDeps = {
    store,
    bbCli: {
      run: async (args) =>
        overrides.cli ? overrides.cli(args) : defaultCli(args),
    },
    threads,
    loadPolicy: async () => policyOf(),
    probes: {
      delegationByThreadId: (id) => store.byThreadId(id),
      hasFreshDispatching: (s, scope) => store.hasFreshDispatching(s, scope),
      roleByThreadId: (id) => store.threadRole(id)?.role,
    },
    primaryHostId: async () => "host_1",
    now: () => nowVal,
  };
  const stepsDeps: DispatchStepsDeps = {
    store,
    bbCli: deps.bbCli,
    threads,
    primaryHostId: deps.primaryHostId,
    policy: () => policyOf().policy,
    now: () => nowVal,
    t: T_RU,
  };
  return {
    deps,
    stepsDeps,
    store,
    spawnArgs,
    db,
    setNow: (v: number) => {
      nowVal = v;
    },
  };
}

const row = (
  taskKey: string,
  over: Record<string, unknown> = {},
): any => ({
  taskKey,
  projectId: "proj_main",
  coordinatorThreadId: "thr_coord",
  level: "review",
  route: "web-review",
  preset: "w-r",
  provider: "prov-x",
  ...over,
});

// ── §20.1 п.5: the busy-route queue ───────────────────────────────────

test("§20.1 п.5: a busy maxActive route queues the row; an expired wait (default 1200s) advances to the next chain route", async () => {
  const { stepsDeps, store, spawnArgs, setNow } = makeDelegateDeps();
  // The shared group's one slot is taken by a running research row.
  const blocker = store.insert({
    taskKey: "PLUG-9",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "research",
    route: "web-research",
    preset: "w-r2",
    provider: "prov-x",
  });
  store.setThreadInfo(blocker.id, "thr_r9");
  store.setStatus(blocker.id, "running");

  const r1 = store.insert(row("PLUG-1"));
  const res = await dispatchToRoute(store.get(r1.id)!, {}, stepsDeps);
  assert.equal(res.status, "queued");
  assert.equal(spawnArgs.length, 0);
  assert.ok(store.get(r1.id)!.queued_at != null);

  const r2 = store.insert(
    row("PLUG-2", {
      level: "research",
      route: "web-research",
      preset: "w-r2",
    }),
  );
  const res2 = await dispatchToRoute(store.get(r2.id)!, {}, stepsDeps);
  assert.equal(res2.status, "queued");

  // 1200s default — the wait expires → the review row advances to
  // local-review (route-busy-timeout → next chain route).
  setNow(T0 + 1300 * 1000);
  const res3 = await dispatchToRoute(store.get(r1.id)!, {}, stepsDeps);
  assert.equal(res3.status, "running");
  assert.equal(store.get(r1.id)!.route, "local-review");
  assert.equal(spawnArgs.length, 1);
});

test("§20.1 п.5: a freed slot dispatches the parked row on its route (queued_at consumed)", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps();
  const blocker = store.insert(
    row("PLUG-9", {
      level: "research",
      route: "web-research",
      preset: "w-r2",
    }),
  );
  store.setThreadInfo(blocker.id, "thr_r9");
  store.setStatus(blocker.id, "running");
  const r1 = store.insert(row("PLUG-1"));
  await dispatchToRoute(store.get(r1.id)!, {}, stepsDeps);
  assert.ok(store.get(r1.id)!.queued_at != null);
  // The slot frees — the retry dispatches on web-review itself.
  store.setStatus(blocker.id, "done");
  const res = await dispatchToRoute(store.get(r1.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  assert.equal(store.get(r1.id)!.route, "web-review");
  assert.equal(store.get(r1.id)!.queued_at, null);
  assert.equal(spawnArgs.length, 1);
});

test("§20.1 п.5: routeBusyWaitSeconds overrides the 1200s default", async () => {
  const policy = JSON.parse(POLICY_TEXT);
  policy.routes["web-review"].routeBusyWaitSeconds = 60;
  const { stepsDeps, store, spawnArgs, setNow } = makeDelegateDeps({
    policyText: JSON.stringify(policy),
  });
  const blocker = store.insert(
    row("PLUG-9", {
      level: "research",
      route: "web-research",
      preset: "w-r2",
    }),
  );
  store.setThreadInfo(blocker.id, "thr_r9");
  store.setStatus(blocker.id, "running");
  const r1 = store.insert(row("PLUG-1"));
  await dispatchToRoute(store.get(r1.id)!, {}, stepsDeps);
  assert.ok(store.get(r1.id)!.queued_at != null);
  // 59s — still waiting.
  setNow(T0 + 59_000);
  const still = await dispatchToRoute(store.get(r1.id)!, {}, stepsDeps);
  assert.equal(still.status, "queued");
  assert.equal(spawnArgs.length, 0);
  // 61s — expired → advance.
  setNow(T0 + 61_000);
  const res = await dispatchToRoute(store.get(r1.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  assert.equal(store.get(r1.id)!.route, "local-review");
});

test("§20.1 п.5: two parallel dispatches on a free maxActive:1 — one runs, one queues", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps();
  // Both rows dispatch concurrently — at the busy gate neither has
  // thread_id/queued_at yet. A row still dispatching ranks LAST, so
  // exactly one wins the slot.
  const a = store.insert(row("PLUG-1"));
  const b = store.insert(row("PLUG-2"));
  const [ra, rb] = await Promise.all([
    dispatchToRoute(store.get(a.id)!, {}, stepsDeps),
    dispatchToRoute(store.get(b.id)!, {}, stepsDeps),
  ]);
  assert.equal(spawnArgs.length, 1);
  assert.deepEqual([ra.status, rb.status].sort(), ["queued", "running"]);
  const winner = ra.status === "running" ? a : b;
  const parked = ra.status === "running" ? b : a;
  assert.equal(store.get(winner.id)!.queued_at, null);
  assert.ok(store.get(parked.id)!.queued_at != null);
});

test("§20.1 п.5: a queued row counts toward limits.maxActive", async () => {
  const policy = JSON.parse(POLICY_TEXT);
  policy.limits.maxActive = 1;
  const { deps, store } = makeDelegateDeps({
    policyText: JSON.stringify(policy),
  });
  // Park a queued row — `dispatching` with `queued_at`.
  const parked = store.insert(row("PLUG-9"));
  store.setQueuedAt(parked.id, T0 - 1000);
  store.setStatus(parked.id, "dispatching");
  await assert.rejects(
    runDelegate(
      { taskKey: "PLUG-1", level: "simple", caller: COORDINATOR },
      deps,
    ),
    (e: unknown) => (e as OrchestratorError).code === "limit-exceeded",
  );
});

test("§20.1 п.4: --attach lists the paths in the seed prompt, never the file bytes", async () => {
  const { deps, spawnArgs } = makeDelegateDeps({
    cli: (args) => {
      const key = args.join(" ");
      if (key.startsWith("tasks show"))
        return ok(taskShowJson("PLUG-1"));
      return defaultCli(args);
    },
  });
  const res = await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "simple",
      attach: ["src/a.ts", "src/b.ts"],
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(res.status, "running");
  const prompt = String(spawnArgs[0]!.prompt);
  assert.ok(prompt.includes("src/a.ts") && prompt.includes("src/b.ts"));
  assert.ok(!prompt.includes("FILE CONTENT"));
  assert.doesNotMatch(prompt, /МАТЕРИАЛ|MATERIAL/);
});

// ── §20.1 п.5: FIFO retry through the watchdog reconcile ──────────────

const dto = (
  id: string,
  status = "active",
  extra: Partial<WatchdogThreadDto> = {},
): WatchdogThreadDto =>
  ({
    id,
    status,
    archivedAt: null,
    deletedAt: null,
    ...extra,
  }) as WatchdogThreadDto;

function makeWatchdog(policyText = POLICY_TEXT, presets = PRESETS) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const calls: string[][] = [];
  const cli: BbCli = {
    run: async (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key.startsWith("tasks show"))
        return ok(taskShowJson(args[2] ?? "PLUG-1"));
      if (key.startsWith("tasks preset show"))
        return ok(JSON.stringify({ preset: FULL_PRESET }));
      if (key.startsWith("tasks threads"))
        return ok(JSON.stringify({ taskThreads: [] }));
      if (args[0] === "thread" && args[1] === "show") {
        const d = threadDtos.get(args[2]!);
        if (!d) return { exitCode: 1, stdout: "", stderr: "not found" };
        return ok(JSON.stringify({ thread: d }));
      }
      return ok();
    },
  };
  const sends: { threadId: string; mode: string; input: unknown[] }[] = [];
  const stops: string[] = [];
  const eventLog = new Map<string, WatchdogThreadEvent[]>();
  const threadDtos = new Map<string, WatchdogThreadDto>();
  const outputs = new Map<string, string | null>();
  let nowVal = T0;
  const threads = {
    get: async ({ threadId }: { threadId: string }) => {
      const d = threadDtos.get(threadId);
      if (!d) throw new Error(`not found ${threadId}`);
      return d;
    },
    events: {
      list: async (args: {
        threadId: string;
        afterSeq?: string;
        order?: "asc" | "desc";
        limit?: string;
        types?: readonly string[];
      }) => {
        let rows = (eventLog.get(args.threadId) ?? []).slice();
        if (args.types?.length)
          rows = rows.filter((r) => args.types!.includes(r.type));
        if (args.afterSeq !== undefined)
          rows = rows.filter((r) => r.seq > Number(args.afterSeq));
        rows.sort((a, b) =>
          args.order === "desc" ? b.seq - a.seq : a.seq - b.seq,
        );
        if (args.limit) rows = rows.slice(0, Number(args.limit));
        return rows;
      },
    },
    queuedMessages: { list: async () => [] },
    send: async (args: {
      threadId: string;
      mode: string;
      input: unknown[];
    }) => {
      sends.push(args);
      return {};
    },
    stop: async ({ threadId }: { threadId: string }) => {
      stops.push(threadId);
      const d = threadDtos.get(threadId);
      if (d) d.status = "idle";
      return {};
    },
    output: async ({ threadId }: { threadId: string }) => ({
      output: outputs.get(threadId) ?? null,
    }),
    update: async () => ({}),
    list: async () => [],
    getPluginMetadata: async () => null,
  };
  const spawnCalls: Record<string, unknown>[] = [];
  const stepsDeps = {
    store,
    bbCli: cli,
    threads: {
      spawn: async (
        a: Parameters<DispatchStepsDeps["threads"]["spawn"]>[0],
      ) => {
        spawnCalls.push(a as unknown as Record<string, unknown>);
        const id = "thr_new";
        threadDtos.set(id, dto(id, "active"));
        return { id };
      },
      list: threads.list,
      getPluginMetadata: threads.getPluginMetadata,
      update: async () => ({}),
      stop: threads.stop,
    },
    primaryHostId: async () => "host_1",
    policy: () => parsePolicy(policyText, presets).policy,
    now: () => nowVal,
    t: T_RU,
  };
  const wd = createWatchdog({
    store,
    bbCli: cli,
    threads: threads as never,
    loadPolicy: async () => parsePolicy(policyText, presets),
    dispatch: (row, o) => dispatchToRoute(row, o ?? {}, stepsDeps),
    finalize: async () => ({ status: "running" as const, setupErrors: [] }),
    retrySetup: async () => [],
    providerRetry: {
      pending: async () => [],
      cancel: async () => {},
    },
    enqueue: createDelegateQueue(),
    now: () => nowVal,
    log: { warn: () => {}, info: () => {}, error: () => {} },
  });
  const insertActive = (input: {
    taskKey?: string;
    level?: string;
    route?: string;
    preset?: string;
    provider?: string;
    threadId?: string;
    status?: "dispatching" | "running";
    queuedAt?: number;
    attach?: string;
  } = {}) => {
    const r = store.insert({
      taskKey: input.taskKey ?? "PLUG-1",
      projectId: "proj_main",
      coordinatorThreadId: "thr_coord",
      level: input.level ?? "simple",
      route: input.route ?? "simple",
      preset: input.preset ?? "simple",
      provider: input.provider ?? "acp-opencode",
      attach: input.attach ?? null,
    });
    if (input.threadId) store.setThreadInfo(r.id, input.threadId);
    if (input.queuedAt !== undefined)
      store.setQueuedAt(r.id, input.queuedAt);
    store.setStatus(r.id, input.status ?? "running");
    return store.get(r.id)!;
  };
  return {
    store,
    wd,
    calls,
    sends,
    stops,
    eventLog,
    threadDtos,
    outputs,
    spawnCalls,
    insertActive,
    setNow: (v: number) => {
      nowVal = v;
    },
  };
}

test("§20.1 п.5: the reconcile retries queued rows FIFO by queued_at", async () => {
  const h = makeWatchdog();
  // Park two rows behind the busy shared-tab group.
  const blocker = h.insertActive({
    taskKey: "PLUG-9",
    threadId: "thr_b",
    level: "research",
    route: "web-research",
    preset: "w-r2",
    provider: "prov-x",
  });
  h.threadDtos.set("thr_b", dto("thr_b", "active"));
  const q1 = h.insertActive({
    taskKey: "PLUG-1",
    level: "review",
    route: "web-review",
    preset: "w-r",
    provider: "prov-x",
    status: "dispatching",
    queuedAt: T0 - 1000,
  });
  const q2 = h.insertActive({
    taskKey: "PLUG-2",
    level: "research",
    route: "web-research",
    preset: "w-r2",
    provider: "prov-x",
    status: "dispatching",
    queuedAt: T0 - 500,
  });
  // Still busy → the reconcile keeps both queued, no spawn.
  await h.wd.reconcile();
  assert.equal(h.spawnCalls.length, 0);
  assert.ok(h.store.get(q1.id)!.queued_at != null);
  // The slot frees → first queued (oldest queued_at) dispatches.
  h.store.setStatus(blocker.id, "done");
  await h.wd.reconcile();
  assert.equal(h.spawnCalls.length, 1);
  const done1 = h.store.get(q1.id)!;
  assert.equal(done1.queued_at, null);
  assert.equal(done1.route, "web-review");
  // The second is still parked (one slot).
  assert.ok(h.store.get(q2.id)!.queued_at != null);
});

test("§20.1 п.5: one slot, three waiting — all queue behind the group", async () => {
  const h = makeWatchdog();
  h.insertActive({
    taskKey: "PLUG-9",
    threadId: "thr_b",
    level: "research",
    route: "web-research",
    preset: "w-r2",
    provider: "prov-x",
  });
  h.threadDtos.set("thr_b", dto("thr_b", "active"));
  const rows = [
    h.insertActive({
      taskKey: "PLUG-1",
      level: "review",
      route: "web-review",
      preset: "w-r",
      provider: "prov-x",
      status: "dispatching",
      queuedAt: T0 - 2000,
    }),
    h.insertActive({
      taskKey: "PLUG-2",
      level: "review",
      route: "web-review",
      preset: "w-r",
      provider: "prov-x",
      status: "dispatching",
      queuedAt: T0 - 1000,
    }),
    h.insertActive({
      taskKey: "PLUG-3",
      level: "research",
      route: "web-research",
      preset: "w-r2",
      provider: "prov-x",
      status: "dispatching",
      queuedAt: T0 - 500,
    }),
  ];
  await h.wd.reconcile();
  assert.equal(h.spawnCalls.length, 0);
  for (const r of rows) {
    assert.ok(h.store.get(r.id)!.queued_at != null);
  }
});
