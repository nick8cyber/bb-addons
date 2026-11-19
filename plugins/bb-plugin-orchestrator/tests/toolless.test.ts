import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS, type DelegationRow } from "../src/store.js";
import { parsePolicy, levelRole } from "../src/policy.js";
import { OrchestratorError } from "../src/errors.js";
import {
  wrapPromptWithPacket,
  resolveRepoPath,
  PacketSkip,
  parseAttachSpec,
  DEFAULT_MAX_PROMPT_BYTES,
  type PacketGit,
} from "../src/packet.js";
import {
  runDelegate,
  dispatchToRoute,
  createDelegateQueue,
  quotaGroupsOfRow,
  type DelegateDeps,
  type DispatchStepsDeps,
} from "../src/delegate.js";
import {
  createHelperWatchdog,
  runHelper,
  type HelperDeps,
} from "../src/helper.js";
import { maskLeakText } from "../src/scan.js";
import {
  roleForLevel,
  roleInstructions,
  ROLES,
  ROLE_INSTRUCTIONS_MAX,
  WINDOW_ROLE_IDS,
} from "../src/roles.js";
import { createWatchdog, type WatchdogThreadDto, type WatchdogThreadEvent } from "../src/watchdog.js";
import { createT, T_RU } from "../src/i18n/index.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { ThreadFacts } from "../src/agent-config.js";
import {
  GH_TOKEN_RE,
  LEAK_GH_TOKEN,
  LEAK_GH_TOKEN_2,
  LEAK_THREAD_ID,
} from "./fixtures/leak-samples.js";

const T0 = 1_700_000_000_000;
const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

// §20/§21 test policy: a tool-less argon route first in the review
// chain, a researcher level on its own argon route — shared quotaGroup.
const POLICY_TEXT = JSON.stringify({
  version: 1,
  firstResponseSeconds: 30,
  limits: { maxActive: 10 },
  levels: {
    review: {
      role: "auditor",
      chain: ["argon-review", "opus-review"],
      autoFallback: true,
    },
    research: { role: "researcher", chain: ["research-argon"], autoFallback: true },
    architect: { role: "architect", chain: ["arch-route"], autoFallback: true },
    simple: { chain: ["simple"] },
  },
  routes: {
    "argon-review": {
      preset: "a-r",
      provider: "acp-argon",
      tools: false,
      maxActive: 1,
      quotaGroup: "argon",
    },
    "opus-review": { preset: "o-r", provider: "acp-devin" },
    "research-argon": {
      preset: "r-a",
      provider: "acp-argon",
      tools: false,
      maxActive: 1,
      quotaGroup: "argon",
    },
    "arch-route": {
      preset: "a-arch",
      provider: "claude-code",
      tools: false,
    },
    simple: { preset: "simple", provider: "acp-opencode" },
  },
});
const PRESETS = new Set(["a-r", "o-r", "r-a", "simple", "a-arch"]);

// ── §20.1 policy validation ───────────────────────────────────────────

test("§20.1: tools:false in an executor level is a policy error", () => {
  const load = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: { simple: { chain: ["a"] } },
      routes: { a: { preset: "simple", provider: "p", tools: false } },
    }),
    PRESETS,
  );
  assert.equal(load.policy, null);
  assert.ok(
    load.errors.some(
      (e) => e.path === "routes.a.tools" && /auditor|researcher/.test(e.message),
    ),
  );
});

test("§20.1: tools:false in release-audit is a policy error", () => {
  const load = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: { "release-audit": { chain: ["a"] } },
      routes: { a: { preset: "simple", provider: "p", tools: false } },
    }),
    PRESETS,
  );
  assert.equal(load.policy, null);
  assert.ok(load.errors.some((e) => e.path === "routes.a.tools"));
});

test("§20.1/§21.3/§30.1: tools:false is valid on auditor, researcher, and architect levels", () => {
  const load = parsePolicy(POLICY_TEXT, PRESETS);
  assert.equal(load.errors.length, 0, JSON.stringify(load.errors));
  assert.ok(load.policy);
  assert.equal(levelRole(load.policy, "review"), "auditor");
  assert.equal(levelRole(load.policy, "research"), "researcher");
  assert.equal(levelRole(load.policy, "architect"), "architect");
  assert.equal(roleForLevel("research", load.policy), "researcher");
  assert.equal(roleForLevel("architect", load.policy), "architect");
});

test("§20.1: tools must be a boolean", () => {
  const load = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: { review: { chain: ["a"] } },
      routes: { a: { preset: "a-r", provider: "p", tools: "no" } },
    }),
    PRESETS,
  );
  assert.equal(load.policy, null);
  assert.ok(load.errors.some((e) => e.path === "routes.a.tools"));
});

// ── §20.2 packet unit tests ───────────────────────────────────────────

/** A fake `git -C repo …` answering rev-parse/merge-base/diff/show. */
function fakeGit(script: {
  diffStat?: string;
  diff?: string;
  files?: Record<string, string>;
  mergeBase?: string;
}) {
  const calls: string[][] = [];
  const git: PacketGit = async (_repo, args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key.startsWith("rev-parse")) {
      const name = args.at(-1)!.replace(/\^\{commit\}$/, "");
      if (name === "HEAD") return "shaHEAD\n";
      if (name.startsWith("origin/")) return "shaBASE\n";
      throw new Error(`unknown ref ${name}`);
    }
    if (key.startsWith("merge-base")) return (script.mergeBase ?? "shaMB") + "\n";
    if (key.startsWith("diff") && key.includes("--stat")) {
      return (script.diffStat ?? " a.ts | 2 +-\n") + "\n";
    }
    if (key.startsWith("diff")) return (script.diff ?? "DIFF_BODY") + "\n";
    if (key.startsWith("show")) {
      const path = args.at(-1)!.split(":").slice(1).join(":");
      const content = script.files?.[path];
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    }
    throw new Error(`unexpected ${key}`);
  };
  return { git, calls };
}

const packetArgs = (over: Record<string, unknown> = {}) => ({
  role: "auditor" as const,
  prompt: "TASK TEXT",
  spec: { paths: [] as string[], from: "shaLINK" as string | null },
  continueFrom: null,
  repoPath: "/repo",
  ...over,
});

test("§20.2: auditor packet — header, stat, attach block, -U10 diff, all from the link commit", async () => {
  const { git, calls } = fakeGit({
    files: { "src/a.ts": "FILE CONTENT" },
  });
  const { prompt } = await wrapPromptWithPacket(
    packetArgs({ spec: { paths: ["src/a.ts"], from: "shaLINK" }, git }),
  );
  assert.match(prompt, /МАТЕРИАЛ ДЛЯ ПРОВЕРКИ/);
  // Order: header → task → --stat → attached file → diff.
  const order = [
    prompt.indexOf("МАТЕРИАЛ ДЛЯ ПРОВЕРКИ"),
    prompt.indexOf("TASK TEXT"),
    prompt.indexOf("git diff --stat"),
    prompt.indexOf("=== src/a.ts ==="),
    prompt.indexOf("git diff -U10"),
  ];
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(prompt.includes("FILE CONTENT"));
  // The attach file comes from the link commit, never the worktree.
  assert.ok(calls.some((c) => c.join(" ") === "show shaLINK:src/a.ts"));
  // Diff exclusions: lockfiles of every ecosystem, dist/, node_modules/.
  const diffCall = calls.find(
    (c) => c[0] === "diff" && c.includes("-U10"),
  )!;
  const diffText = diffCall.join(" ");
  for (const ex of [
    "*.lock",
    "*-lock.json",
    "*-lock.yaml",
    "bun.lockb",
    "npm-shrinkwrap.json",
    "go.sum",
    "dist/",
    "node_modules/",
    ".env*",
    "*.pem",
    "*.key",
  ]) {
    assert.ok(diffText.includes(ex), `exclude ${ex}`);
  }
  assert.ok(diffText.includes("shaMB..shaLINK"));
});

test("§20.2 п.4 (аудит C): instructions ride after the diff; .env* covers .envrc; binaries leave the diff; --stat drops lockfiles", async () => {
  const { git, calls } = fakeGit({
    diff:
      "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-x\n+y\n" +
      "diff --git a/i.png b/i.png\nindex 000..111 100644\nBinary files a/i.png and b/i.png differ\n",
  });
  const { prompt } = await wrapPromptWithPacket(
    packetArgs({
      spec: { paths: [], from: "shaLINK" },
      git,
      trailing: "## Preset instructions\n\nDO LAST",
    }),
  );
  // шапка → задача → --stat → дифф → инструкции.
  const order = [
    prompt.indexOf("МАТЕРИАЛ ДЛЯ ПРОВЕРКИ"),
    prompt.indexOf("TASK TEXT"),
    prompt.indexOf("git diff --stat"),
    prompt.indexOf("git diff -U10"),
    prompt.indexOf("Preset instructions"),
  ];
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Binary chunks are a --stat line only — never a diff block.
  assert.ok(!prompt.includes("Binary files"), prompt);
  // §20.2 п.2: --stat drops the same lock/dist/node_modules noise.
  const statCall = calls.find((c) => c.includes("--stat"))!.join(" ");
  for (const ex of ["*.lock", "dist/", "node_modules/", "go.sum"]) {
    assert.ok(statCall.includes(ex), `stat exclude ${ex}`);
  }
  // `.env*` beyond the dot form — the git pathspec's own coverage.
  await assert.rejects(
    () =>
      wrapPromptWithPacket(
        packetArgs({ spec: { paths: [".envrc"], from: "shaLINK" }, git }),
      ),
    (e: OrchestratorError) => e.code === "attach-secret",
  );
  await assert.rejects(
    () =>
      wrapPromptWithPacket(
        packetArgs({
          spec: { paths: ["config/.env-prod"], from: "shaLINK" },
          git,
        }),
      ),
    (e: OrchestratorError) => e.code === "attach-secret",
  );
});

test("§20.2: attach-missing / attach-secret / attach-binary refuse the dispatch", async () => {
  const { git } = fakeGit({});
  await assert.rejects(
    () =>
      wrapPromptWithPacket(
        packetArgs({ spec: { paths: ["gone.ts"], from: "shaLINK" }, git }),
      ),
    (e: OrchestratorError) => {
      assert.equal(e.code, "attach-missing");
      assert.match(e.message, /gone\.ts/);
      return true;
    },
  );
  await assert.rejects(
    () =>
      wrapPromptWithPacket(
        packetArgs({ spec: { paths: [".env"], from: "shaLINK" }, git }),
      ),
    (e: OrchestratorError) => e.code === "attach-secret",
  );
  const binary = "A\0B" + "x".repeat(100);
  const { git: gitBin } = fakeGit({ files: { "img.png": binary } });
  await assert.rejects(
    () =>
      wrapPromptWithPacket(
        packetArgs({
          spec: { paths: ["img.png"], from: "shaLINK" },
          git: gitBin,
        }),
      ),
    (e: OrchestratorError) => e.code === "attach-binary",
  );
});

test("§20.2: no diff and no files → PacketSkip(packet-empty); oversized → packet-too-large", async () => {
  const { git } = fakeGit({ diff: "", diffStat: "" });
  await assert.rejects(
    () => wrapPromptWithPacket(packetArgs({ git })),
    (e: PacketSkip) => {
      assert.equal(e.reason, "packet-empty");
      return true;
    },
  );
  const big = fakeGit({ diff: "x".repeat(600_000) });
  await assert.rejects(
    () => wrapPromptWithPacket(packetArgs({ git: big.git })),
    (e: PacketSkip) => e.reason === "packet-too-large",
  );
  // A small explicit cap works the same way.
  await assert.rejects(
    () =>
      wrapPromptWithPacket(
        packetArgs({
          git: fakeGit({ diff: "y".repeat(900) }).git,
          maxPromptBytes: 500,
        }),
      ),
    (e: PacketSkip) => e.reason === "packet-too-large",
  );
});

test("§21.3: research packet — no diff without --from, no packet-empty; --from adds the diff", async () => {
  // No link, no files: an auditor would skip packet-empty; the
  // researcher's question alone is enough material.
  const res = await wrapPromptWithPacket(
    packetArgs({
      role: "researcher",
      spec: { paths: [], from: null },
      repoPath: null,
      git: undefined,
    }),
  );
  assert.match(res.prompt, /МАТЕРИАЛ ДЛЯ ИССЛЕДОВАНИЯ/);
  assert.ok(!res.prompt.includes("git diff"));
  // --from → the diff rides along.
  const { git } = fakeGit({ diff: "R_DIFF" });
  const res2 = await wrapPromptWithPacket(
    packetArgs({ role: "researcher", spec: { paths: [], from: "shaLINK" }, git }),
  );
  assert.ok(res2.prompt.includes("R_DIFF"));
});

test("§20.2 п.5: the mask runs before the packet leaves; the header counts masked fragments", async () => {
  const { git } = fakeGit({ diff: "leak: " + LEAK_GH_TOKEN });
  const res = await wrapPromptWithPacket(
    packetArgs({
      git,
      mask: (text: string) => {
        const hits = text.match(GH_TOKEN_RE) ?? [];
        return {
          text: text.replace(GH_TOKEN_RE, "[скрыто: github-token]"),
          count: hits.length,
        };
      },
    }),
  );
  assert.ok(res.prompt.includes("[скрыто: github-token]"));
  assert.ok(!res.prompt.includes(LEAK_GH_TOKEN));
  // §20.2 п.5 (r33): the count sums prompt + stat + attaches + diff.
  assert.match(res.prompt, /скрыто: 1|фрагментов: 1/i);
});

test("§20.2: parseAttachSpec round-trips the stored spec", () => {
  assert.deepEqual(parseAttachSpec(null), { paths: [], from: null });
  assert.deepEqual(
    parseAttachSpec('{"paths":["a.ts"],"from":"sha1"}'),
    { paths: ["a.ts"], from: "sha1" },
  );
  assert.deepEqual(parseAttachSpec("junk"), { paths: [], from: null });
});

// ── delegate harness (the delegate.test.ts makeDeps, trimmed) ─────────

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
    now?: () => number;
    repoPath?: (row: DelegationRow) => Promise<string | null>;
    packetGit?: PacketGit;
    packetMask?: DispatchStepsDeps["packetMask"];
  } = {},
) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const spawnArgs: Record<string, unknown>[] = [];
  let nowVal = T0;
  const deps: DelegateDeps = {
    store,
    bbCli: {
      run: async (args) =>
        overrides.cli ? overrides.cli(args) : defaultCli(args),
    },
    threads: {
      spawn: async (args) => {
        spawnArgs.push(args as unknown as Record<string, unknown>);
        return overrides.spawn
          ? overrides.spawn(args as unknown as Record<string, unknown>)
          : { id: "thr_exec" };
      },
      list: async () => [],
      getPluginMetadata: async () => null,
      update: async () => ({}),
      stop: async () => ({}),
      updatePluginMetadata: async () => ({}),
    },
    loadPolicy: async () =>
      parsePolicy(overrides.policyText ?? POLICY_TEXT, overrides.presets ?? PRESETS),
    probes: {
      delegationByThreadId: (id) => store.byThreadId(id),
      hasFreshDispatching: (s, scope) => store.hasFreshDispatching(s, scope),
      roleByThreadId: (id) => store.threadRole(id)?.role,
    },
    primaryHostId: async () => "host_1",
    now: overrides.now ?? (() => nowVal),
    repoPath: overrides.repoPath ?? (async () => "/repo"),
    packetGit: overrides.packetGit,
    packetMask: overrides.packetMask,
  };
  const stepsDeps: DispatchStepsDeps = {
    store,
    bbCli: deps.bbCli,
    threads: deps.threads,
    primaryHostId: deps.primaryHostId,
    policy: () =>
      parsePolicy(overrides.policyText ?? POLICY_TEXT, overrides.presets ?? PRESETS).policy,
    now: overrides.now ?? (() => nowVal),
    repoPath: overrides.repoPath ?? (async () => "/repo"),
    packetGit: overrides.packetGit,
    packetMask: overrides.packetMask,
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

test("§20.3: --preset of a tools:false route on an executor level → preset-not-allowed", async () => {
  const { deps } = makeDelegateDeps();
  await assert.rejects(
    () =>
      runDelegate(
        {
          taskKey: "PLUG-1",
          level: "simple",
          preset: "a-r",
          caller: COORDINATOR,
        },
        deps,
      ),
    (e: OrchestratorError) => {
      assert.equal(e.code, "preset-not-allowed");
      return true;
    },
  );
});

test("§20.3: the same preset on the auditor level is allowed (tool-less flag by preset lookup)", async () => {
  const { deps } = makeDelegateDeps();
  // a-r maps to a tools:false route; review's role is auditor → pass
  // the gate. The packet then needs a repo seam the harness does not
  // give it — a packet-stage refusal (packet-repo, not
  // preset-not-allowed) proves the flag was read from the preset's
  // route rather than refused up front.
  await assert.rejects(
    () =>
      runDelegate(
        {
          taskKey: "PLUG-1",
          level: "review",
          preset: "a-r",
          attach: ["src/a.ts"],
          caller: COORDINATOR,
        },
        deps,
      ),
    (e: OrchestratorError) => {
      assert.equal(e.code, "packet-repo");
      return true;
    },
  );
});

test("PLUG-294: runDelegate on tool-less route with packetGit/repoPath succeeds without packet-repo", async () => {
  const { git } = fakeGit({
    diffStat: " a.ts | 2 +-\n",
    diff: "DIFF_BODY",
    files: { "src/a.ts": "FILE_CONTENT" },
  });
  const { deps, store, spawnArgs } = makeDelegateDeps({
    packetGit: git,
    repoPath: async () => "/repo",
  });
  const res = await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "review",
      route: "argon-review",
      from: "shaLINK",
      attach: ["src/a.ts"],
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(res.status, "running");
  assert.equal(store.threadRole("thr_exec")?.role, "auditor");
  const prompt = String(spawnArgs[0]!.prompt);
  assert.match(prompt, /МАТЕРИАЛ ДЛЯ ПРОВЕРКИ/);
  assert.ok(prompt.includes("FILE_CONTENT"));
  assert.ok(prompt.includes("DIFF_BODY"));
});

test("PLUG-295: runDelegate on fresh review row uses resolveRepoPath to pick last done result env", async () => {
  const { git } = fakeGit({
    diffStat: " a.ts | 2 +-\n",
    diff: "DIFF_FROM_EXEC_REPO",
  });
  const envFacts: Record<string, { id: string; path?: string }> = {
    env_exec: { id: "env_exec", path: "/path/to/exec/worktree" },
    env_coord: { id: "env_coord", path: "/path/to/coord" },
  };
  const { deps, store, spawnArgs } = makeDelegateDeps({
    packetGit: git,
    repoPath: (row) =>
      resolveRepoPath(row, {
        store,
        threads: {
          get: async () => ({ environmentId: "env_coord" }),
        },
        environmentFacts: async (id) => envFacts[id] ?? {},
      }),
  });
  // Record a prior done execution for PLUG-1
  const prev = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "route_exec",
    preset: "preset_exec",
    provider: "provider_exec",
    round: 1,
    continueFrom: null,
    explicitRoute: false,
    noCode: false,
    attach: null,
  });
  store.setRoundResult(prev.id, {
    envId: "env_exec",
    branch: "bb/plug-1",
    sha: "shaDONE",
    commits: 1,
    dirty: false,
  });
  store.setStatus(prev.id, "done");

  const res = await runDelegate(
    {
      taskKey: "PLUG-1",
      level: "review",
      route: "argon-review",
      from: "shaDONE",
      caller: COORDINATOR,
    },
    deps,
  );
  assert.equal(res.status, "running");
  assert.equal(store.threadRole("thr_exec")?.role, "auditor");
  const prompt = String(spawnArgs[0]!.prompt);
  assert.match(prompt, /МАТЕРИАЛ ДЛЯ ПРОВЕРКИ/);
  assert.ok(prompt.includes("DIFF_FROM_EXEC_REPO"));
});

test("PLUG-295: runDelegate on tool-less route when all envs dead throws packet-repo", async () => {
  const { git } = fakeGit({});
  const { deps } = makeDelegateDeps({
    packetGit: git,
    repoPath: async () => null,
  });
  await assert.rejects(
    () =>
      runDelegate(
        {
          taskKey: "PLUG-1",
          level: "review",
          route: "argon-review",
          from: "shaLINK",
          caller: COORDINATOR,
        },
        deps,
      ),
    (e: OrchestratorError) => {
      assert.equal(e.code, "packet-repo");
      assert.match(e.message, /no repository access/);
      return true;
    },
  );
});

test("§20.2: --attach rejects paths escaping the repo", async () => {
  const { deps } = makeDelegateDeps();
  await assert.rejects(
    () =>
      runDelegate(
        {
          taskKey: "PLUG-1",
          level: "simple",
          attach: ["../secret"],
          caller: COORDINATOR,
        },
        deps,
      ),
    (e: OrchestratorError) => e.code === "invalid-arguments",
  );
});

test("§21.2: delegate --level research → researcher-role thread, research packet, no diff, no git memo", async () => {
  const { deps, store, spawnArgs } = makeDelegateDeps();
  const res = await runDelegate(
    { taskKey: "PLUG-1", level: "research", caller: COORDINATOR },
    deps,
  );
  assert.equal(res.status, "running");
  assert.equal(store.threadRole("thr_exec")?.role, "researcher");
  const prompt = String(spawnArgs[0]!.prompt);
  assert.match(prompt, /МАТЕРИАЛ ДЛЯ ИССЛЕДОВАНИЯ/);
  assert.ok(!prompt.includes("git diff"), prompt.slice(0, 400));
});

test("§20.2: a busy tool-less route queues the row; an expired wait moves to the next route", async () => {
  const { stepsDeps, store, spawnArgs, setNow } = makeDelegateDeps({
    packetGit: fakeGit({}).git,
  });
  // The argon group's one slot is taken by a running research row.
  const blocker = store.insert({
    taskKey: "PLUG-9",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  store.setThreadInfo(blocker.id, "thr_r9");
  store.setStatus(blocker.id, "running");

  const row = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
    // A non-empty packet (the --from diff) reaches the busy gate — an
    // empty one would skip argon for opus before ever queueing (r33).
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "queued");
  assert.equal(spawnArgs.length, 0);
  assert.ok(store.get(row.id)!.queued_at != null);

  // Two queued rows on the shared group: the research one queues too.
  const row2 = store.insert({
    taskKey: "PLUG-2",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  const res2 = await dispatchToRoute(store.get(row2.id)!, {}, stepsDeps);
  assert.equal(res2.status, "queued");

  // The wait expires → the review row advances to opus-review.
  setNow(T0 + 1300 * 1000);
  const res3 = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res3.status, "running");
  assert.equal(store.get(row.id)!.route, "opus-review");
  assert.equal(spawnArgs.length, 1);
});

test("§20.2: a freed argon slot dispatches on the tool-less route (queued_at consumed)", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps({
    packetGit: fakeGit({}).git,
  });
  const blocker = store.insert({
    taskKey: "PLUG-9",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  store.setThreadInfo(blocker.id, "thr_r9");
  store.setStatus(blocker.id, "running");
  const row = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
    // A review packet needs the checked work — an empty packet would
    // legitimately skip argon for opus; the stored spec gives it a
    // --from diff instead.
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.ok(store.get(row.id)!.queued_at != null);
  // The slot frees — the retry dispatches on review-argon itself.
  store.setStatus(blocker.id, "done");
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  assert.equal(store.get(row.id)!.route, "argon-review");
  assert.equal(store.get(row.id)!.queued_at, null);
  assert.equal(spawnArgs.length, 1);
});

test("§20.2: a tool route gets the attach paths as a list, never the file contents", async () => {
  const { deps, spawnArgs } = makeDelegateDeps();
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
});

// ── §21 role window / texts / helper ──────────────────────────────────

test("§21.1: the role window offers researcher; labels and the ≤2500-char texts exist", () => {
  assert.ok((WINDOW_ROLE_IDS as readonly string[]).includes("researcher"));
  const ru = createT("ru");
  const en = createT("en");
  assert.equal(ru("app.roleResearcher"), "Ресерчер");
  assert.equal(en("app.roleResearcher"), "Researcher");
  for (const t of [T_RU, createT("en")]) {
    const text = roleInstructions("researcher", { t });
    assert.ok(text.length > 0 && text.length <= ROLE_INSTRUCTIONS_MAX);
    assert.match(text, /источник|source/i);
    assert.match(text, /субагент|subagent/i);
    assert.match(text, /Не найдено|Not found/);
  }
  assert.deepEqual(ROLES.researcher.tools, []);
  assert.equal(ROLES.researcher.delegates, false);
});

test("§30.1: the role window offers architect; labels and the ≤2500-char texts exist", () => {
  assert.ok((WINDOW_ROLE_IDS as readonly string[]).includes("architect"));
  const ru = createT("ru");
  const en = createT("en");
  assert.equal(ru("app.roleArchitect"), "Архитектор");
  assert.equal(en("app.roleArchitect"), "Architect");
  for (const t of [T_RU, createT("en")]) {
    const text = roleInstructions("architect", { t });
    assert.ok(text.length > 0 && text.length <= ROLE_INSTRUCTIONS_MAX);
    assert.match(text, /архитектор|architect/i);
    assert.match(text, /design/i);
    assert.match(text, /design_check/i);
    assert.match(text, /договор приёмки|acceptance contract/i);
  }
  assert.deepEqual(ROLES.architect.tools, []);
  assert.equal(ROLES.architect.delegates, false);
});

test("§21.2: the orchestrator role text tells the coordinator to delegate research first", () => {
  for (const t of [T_RU, createT("en")]) {
    const text = roleInstructions("orchestrator", { t });
    assert.match(text, /--level research|level: research/);
  }
});

function makeHelperDeps(policyText = POLICY_TEXT, presets = PRESETS) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.setThreadRole("thr_call", "orchestrator", "hook");
  const roles: { threadId: string; role: string }[] = [];
  const deps: HelperDeps = {
    store,
    threads: {
      spawn: async () => ({ id: "thr_h" }),
      send: async () => ({}),
      get: async () => ({ id: "x", status: "idle" }),
      stop: async () => ({}),
      list: async () => [],
      getPluginMetadata: async () => null,
      archive: async () => ({}),
      events: { list: async () => [] },
      queuedMessages: { list: async () => [] },
      output: async () => ({ output: null }),
      update: async () => ({}),
    } as HelperDeps["threads"],
    enqueue: (fn) => fn(),
    loadPolicy: async () => parsePolicy(policyText, presets),
    helpers: () => ({ maxActive: 3, defaultLevel: "simple" }),
    callerFacts: async () => ({
      threadId: "thr_call",
      parentThreadId: null,
      sourceThreadId: null,
      originPluginId: null,
      projectId: "proj_a",
      environmentId: "env_1",
    }),
    t: T_RU,
    now: () => T0,
  };
  return { deps, store, roles };
}

test("§20.3: helper --preset of a tools:false route → preset-not-allowed", async () => {
  const { deps } = makeHelperDeps();
  await assert.rejects(
    () =>
      runHelper(
        { prompt: "do x", preset: "a-r", threadId: "thr_call" },
        deps,
      ),
    (e: OrchestratorError) => e.code === "preset-not-allowed",
  );
});

test("§21.2: helper --level research → researcher-role helper thread", async () => {
  const { deps, store } = makeHelperDeps();
  const res = await runHelper(
    { prompt: "research x", level: "research", threadId: "thr_call" },
    deps,
  );
  assert.equal(res.threadId, "thr_h");
  assert.equal(store.threadRole("thr_h")?.role, "researcher");
});

// ── §20.3 watchdog: tool-less outcome overrides ───────────────────────

const ev = (
  seq: number,
  type: string,
  createdAt: number,
  data: Record<string, unknown> = {},
): WatchdogThreadEvent => ({ seq, type, createdAt, data });

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
    send: async (args: { threadId: string; mode: string; input: unknown[] }) => {
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
      spawn: async (a: Parameters<DispatchStepsDeps["threads"]["spawn"]>[0]) => {
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
    repoPath: async () => "/repo",
    packetGit: fakeGit({}).git,
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
    const row = store.insert({
      taskKey: input.taskKey ?? "PLUG-1",
      projectId: "proj_main",
      coordinatorThreadId: "thr_coord",
      level: input.level ?? "simple",
      route: input.route ?? "simple",
      preset: input.preset ?? "simple",
      provider: input.provider ?? "acp-opencode",
      attach: input.attach ?? null,
    });
    if (input.threadId) store.setThreadInfo(row.id, input.threadId);
    if (input.queuedAt !== undefined)
      store.setQueuedAt(row.id, input.queuedAt);
    store.setStatus(row.id, input.status ?? "running");
    return store.get(row.id)!;
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

test("§20.3: a tool-less auditor's missing verdict → route failed at once, no reminder, next route dispatched", async () => {
  const h = makeWatchdog();
  const row = h.insertActive({
    threadId: "thr_a",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
  });
  h.threadDtos.set("thr_a", dto("thr_a", "idle"));
  h.outputs.set("thr_a", "отчёт без вердикта");
  h.eventLog.set("thr_a", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 10, { status: "completed" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_a"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_a", "idle"));
  const fresh = h.store.get(row.id)!;
  // stalled → autoFallback reissue: the old row ends `reissued`.
  assert.equal(fresh.status, "reissued");
  // No reminder ever went to the tool-less auditor.
  assert.equal(
    h.sends.filter((s) => s.threadId === "thr_a").length,
    0,
    JSON.stringify(h.sends.map((s) => s.threadId)),
  );
  // The chain advanced: a reissue row on opus-review.
  const next = h.store
    .listActive()
    .find((r) => r.reissue_of === row.id);
  assert.ok(next, "reissue row expected");
  assert.equal(next!.route, "opus-review");
  assert.equal(h.spawnCalls.length, 1);
});

test("§20.3: a tool-less route interrupted → failed at once, no resume message", async () => {
  const h = makeWatchdog();
  const row = h.insertActive({
    threadId: "thr_a",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
  });
  h.threadDtos.set("thr_a", dto("thr_a", "active"));
  h.eventLog.set("thr_a", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "system/thread/interrupted", T0, {
      reason: "host-daemon-restarted",
    }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_a"), sequence: 2 });
  const fresh = h.store.get(row.id)!;
  // stalled → autoFallback reissue, never a resume.
  assert.equal(fresh.status, "reissued");
  assert.equal(fresh.resume_count, 0);
  assert.equal(
    h.sends.filter((s) => s.threadId === "thr_a").length,
    0,
    "no resume for a tool-less route",
  );
});

test("§20.3: an errored turn on a tool-less route → failed, no resume, reissue on the next route", async () => {
  const h = makeWatchdog();
  const row = h.insertActive({
    threadId: "thr_a",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
  });
  h.threadDtos.set("thr_a", dto("thr_a", "error"));
  h.eventLog.set("thr_a", [
    ev(1, "turn/started", T0 - 1000),
    ev(2, "turn/completed", T0, { status: "failed" }),
  ]);
  await h.wd.onThreadFailed(dto("thr_a", "error"), "provider blew up");
  const fresh = h.store.get(row.id)!;
  // failed → autoFallback reissue on the next chain route.
  assert.equal(fresh.status, "reissued");
  assert.equal(fresh.resume_count, 0);
  assert.equal(
    h.sends.filter((s) => s.threadId === "thr_a").length,
    0,
  );
  const next = h.store
    .listActive()
    .find((r) => r.reissue_of === row.id);
  assert.ok(next);
  assert.equal(next!.route, "opus-review");
});

test("§20.2: a queued row is retried by reconcile in queued_at order", async () => {
  const h = makeWatchdog();
  // Park two rows behind the busy argon group.
  const blocker = h.insertActive({
    taskKey: "PLUG-9",
    threadId: "thr_b",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  h.threadDtos.set("thr_b", dto("thr_b", "active"));
  const q1 = h.insertActive({
    taskKey: "PLUG-1",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
    status: "dispatching",
    queuedAt: T0 - 1000,
    // The --from spec keeps the review packet non-empty so the freed
    // slot lands it on argon-review itself, not on the opus fallback.
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  const q2 = h.insertActive({
    taskKey: "PLUG-2",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
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
  assert.equal(done1.route, "argon-review");
  // The second is still parked (one slot).
  assert.ok(h.store.get(q2.id)!.queued_at != null);
});

test("§21.4: two reviews and one research on the argon group — one runs, two queue", async () => {
  const h = makeWatchdog();
  h.insertActive({
    taskKey: "PLUG-9",
    threadId: "thr_b",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  h.threadDtos.set("thr_b", dto("thr_b", "active"));
  const a = h.insertActive({
    taskKey: "PLUG-1",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
    status: "dispatching",
    queuedAt: T0 - 2000,
    // The --from spec keeps the review packet non-empty — an empty
    // packet skips argon before the busy gate (r33).
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  const b = h.insertActive({
    taskKey: "PLUG-2",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
    status: "dispatching",
    queuedAt: T0 - 1000,
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  const c = h.insertActive({
    taskKey: "PLUG-3",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
    status: "dispatching",
    queuedAt: T0 - 500,
  });
  // One runs already (the blocker); all three queue behind the group.
  await h.wd.reconcile();
  assert.equal(h.spawnCalls.length, 0);
  for (const r of [a, b, c]) {
    assert.ok(h.store.get(r.id)!.queued_at != null);
  }
});

// ── r33 review regressions (Argon + Gemini) ───────────────────────────

/** A 3-route chain for the consecutive-skip regression: two tool-less
 * argon routes, then the tool fallback. */
const POLICY_3ROUTES = JSON.stringify({
  version: 1,
  limits: { maxActive: 10 },
  levels: {
    review: {
      role: "auditor",
      chain: ["argon-1", "argon-2", "opus-fb"],
      autoFallback: true,
    },
  },
  routes: {
    "argon-1": { preset: "a-r", provider: "acp-argon", tools: false },
    "argon-2": { preset: "a-r", provider: "acp-argon", tools: false },
    "opus-fb": { preset: "o-r", provider: "acp-devin" },
  },
});

test("r33 B1: an explicit-route row that skips advances once — no recursion, explicit_route cleared", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps({
    packetGit: fakeGit({}).git, // empty diff → packet-empty on argon
  });
  const row = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
    explicitRoute: true, // `--route argon-review` — the recursion vector
  });
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  const fresh = store.get(row.id)!;
  assert.equal(fresh.route, "opus-review");
  assert.equal(fresh.explicit_route, 0);
  assert.equal(spawnArgs.length, 1);
  assert.deepEqual(
    (res.skipped ?? []).map((s) => s.route),
    ["argon-review"],
  );
});

test("r33 B1: two consecutive packet-empty skips walk the chain exactly once", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps({
    policyText: POLICY_3ROUTES,
    packetGit: fakeGit({}).git,
  });
  const row = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "argon-1",
    preset: "a-r",
    provider: "acp-argon",
  });
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  assert.equal(store.get(row.id)!.route, "opus-fb");
  assert.equal(spawnArgs.length, 1);
  assert.deepEqual(
    (res.skipped ?? []).map((s) => `${s.route}:${s.reason}`),
    ["argon-1:packet-empty", "argon-2:packet-empty"],
  );
});

test("r33 B2: the task prompt itself is masked before the packet leaves", async () => {
  const { git } = fakeGit({ diff: "DIFF" });
  const res = await wrapPromptWithPacket(
    packetArgs({
      prompt: "review it; pat " + LEAK_GH_TOKEN_2 + " is in the task",
      git,
      mask: (text: string) => {
        const hits = text.match(GH_TOKEN_RE) ?? [];
        return {
          text: text.replace(GH_TOKEN_RE, "[скрыто: github-token]"),
          count: hits.length,
        };
      },
    }),
  );
  assert.ok(!res.prompt.includes(LEAK_GH_TOKEN_2));
  assert.ok(res.prompt.includes("[скрыто: github-token]"));
  assert.match(res.prompt, /фрагментов: 1|скрыто: 1/);
});

test("r33 B2: leaks.allow relaxes categories 3–4 only inside its files — secrets never", () => {
  const bbRef = `see thread ${LEAK_THREAD_ID} for context`;
  // threadIds off → bb ids are category-4 findings.
  const masked = maskLeakText(bbRef, { threadIds: false });
  assert.ok(!masked.text.includes(LEAK_THREAD_ID));
  const allowed = maskLeakText(bbRef, {
    threadIds: false,
    file: "docs/notes.md",
    allow: ["docs/**"],
  });
  assert.ok(allowed.text.includes(LEAK_THREAD_ID));
  const secret = maskLeakText("key " + LEAK_GH_TOKEN, {
    file: "docs/notes.md",
    allow: ["docs/**"],
  });
  assert.ok(!secret.text.includes(LEAK_GH_TOKEN));
});

test("r33 B3: attach-missing on a busy tool-less route refuses at once — the row never parks", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps({
    packetGit: fakeGit({}).git,
  });
  const blocker = store.insert({
    taskKey: "PLUG-9",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  store.setThreadInfo(blocker.id, "thr_r9");
  store.setStatus(blocker.id, "running");
  const row = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
    attach: JSON.stringify({ paths: ["gone.ts"], from: "shaLINK" }),
  });
  await assert.rejects(
    () => dispatchToRoute(store.get(row.id)!, {}, stepsDeps),
    (e: OrchestratorError) => {
      assert.equal(e.code, "attach-missing"); // the real code, not dispatch-failed
      return true;
    },
  );
  assert.equal(store.get(row.id), undefined); // refused → removed, not queued
  assert.equal(spawnArgs.length, 0);
});

test("r33 B3: packet-empty on a busy tool-less route advances — never parks behind it", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps({
    packetGit: fakeGit({}).git, // empty → packet-empty
  });
  const blocker = store.insert({
    taskKey: "PLUG-9",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  store.setThreadInfo(blocker.id, "thr_r9");
  store.setStatus(blocker.id, "running");
  const row = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
  });
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  const fresh = store.get(row.id)!;
  assert.equal(fresh.route, "opus-review");
  assert.equal(fresh.queued_at, null);
  assert.equal(spawnArgs.length, 1);
});

test("r33 B4: helper --level research on tools:false gets the §21.3 packet", async () => {
  const { deps, store } = makeHelperDeps();
  const prompts: string[] = [];
  const origSpawn = deps.threads.spawn;
  deps.threads.spawn = async (a) => {
    prompts.push(String(a.prompt));
    return origSpawn(a);
  };
  const res = await runHelper(
    { prompt: "find the quota docs", level: "research", threadId: "thr_call" },
    deps,
  );
  assert.equal(res.route, "research-argon");
  assert.equal(store.threadRole("thr_h")?.role, "researcher");
  assert.match(prompts[0]!, /МАТЕРИАЛ ДЛЯ ИССЛЕДОВАНИЯ/);
  assert.match(prompts[0]!, /find the quota docs/);
});

test("r33 B4: a full shared quotaGroup refuses the helper route-busy", async () => {
  const { deps, store } = makeHelperDeps();
  const blocker = store.insert({
    taskKey: "PLUG-9",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  store.setThreadInfo(blocker.id, "thr_r9");
  store.setStatus(blocker.id, "running");
  await assert.rejects(
    () =>
      runHelper(
        { prompt: "x", level: "research", threadId: "thr_call" },
        deps,
      ),
    (e: OrchestratorError) => e.code === "route-busy",
  );
});

test("r33 аудит C: a parked delegation holds the shared quotaGroup against a helper", async () => {
  const { deps, store } = makeHelperDeps();
  const parked = store.insert({
    taskKey: "PLUG-9",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  // dispatching + queued_at, no thread: the parked claim occupies the
  // slot ahead of any new helper — a helper never jumps the queue even
  // in a freed-slot gap (FIFO like the delegate busy gate).
  store.setQueuedAt(parked.id, T0);
  await assert.rejects(
    () =>
      runHelper(
        { prompt: "x", level: "research", threadId: "thr_call" },
        deps,
      ),
    (e: OrchestratorError) => e.code === "route-busy",
  );
});

test("r33 аудит C: an in-flight packet builder holds no slot for a helper", async () => {
  const { deps, store } = makeHelperDeps();
  store.insert({
    taskKey: "PLUG-9",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "research",
    route: "research-argon",
    preset: "r-a",
    provider: "acp-argon",
  });
  // dispatching, no thread_id, no queued_at — rank LAST like the
  // delegate gate: it neither occupies the slot nor blocks the helper.
  const res = await runHelper(
    { prompt: "x", level: "research", threadId: "thr_call" },
    deps,
  );
  assert.equal(res.route, "research-argon");
});

test("r33 B4: a running helper occupies the shared quotaGroup for delegations", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps({
    packetGit: fakeGit({}).git,
  });
  // The helper on research-argon holds the argon group's only slot.
  const helper = store.insertHelperChecked(
    {
      callerThreadId: "thr_call",
      coordinatorThreadId: "thr_coord",
      preset: "r-a",
      route: "research-argon",
      level: "research",
    },
    { perCaller: 5, sharedMax: 99 },
  );
  store.setHelperThread(helper.id, "thr_h");
  store.setHelperStatus(helper.id, "running");
  const row = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "argon-review",
    preset: "a-r",
    provider: "acp-argon",
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "queued");
  assert.equal(spawnArgs.length, 0);
  assert.ok(store.get(row.id)!.queued_at != null);
});

test("r33 B4: a tool-less helper's interruption fails at once — no resume send", async () => {
  const { deps, store } = makeHelperDeps();
  const sends: string[] = [];
  const stops: string[] = [];
  const threads = {
    ...deps.threads,
    send: async (a: { threadId: string }) => {
      sends.push(a.threadId);
      return {};
    },
    stop: async (a: { threadId: string }) => {
      stops.push(a.threadId);
      return {};
    },
    events: {
      list: async () => [
        {
          seq: 1,
          type: "turn/started",
          createdAt: T0 + 50,
          data: {},
        },
        {
          seq: 2,
          type: "system/thread/interrupted",
          createdAt: T0 + 100,
          data: { reason: "restart" },
        },
      ],
    },
  };
  const helperDeps = { ...deps, threads: threads as HelperDeps["threads"] };
  const callerLines: string[] = [];
  const wd = createHelperWatchdog({
    ...helperDeps,
    callerSend: async (_t: string, text: string) => {
      callerLines.push(text);
      return {};
    },
  });
  await runHelper(
    { prompt: "research x", level: "research", threadId: "thr_call" },
    helperDeps,
  );
  await wd.onTurnFailed({ threadId: "thr_h" });
  const helper = store.helper(1)!;
  assert.equal(helper.status, "failed");
  assert.equal(helper.resume_count, 0);
  assert.equal(sends.length, 0, "no resume message to the helper");
  assert.deepEqual(stops, ["thr_h"]);
  assert.equal(callerLines.length, 1);
});

test("r33 (Gemini): the tool-less route strings speak Russian in the ru locale", () => {
  const ru = createT("ru");
  assert.match(
    ru("del.presetNotAllowed", { preset: "a-r", level: "review" }),
    /пресет\/маршрут «a-r».*«review».*preset-not-allowed/,
  );
  assert.equal(
    ru("del.routeBusy", { route: "argon-review" }),
    "argon-review занят — в очереди, итог придёт строкой",
  );
  assert.match(
    ru("del.routeBusyExhausted", { route: "argon-review" }),
    /маршрут «argon-review».*дольше лимита/,
  );
  assert.equal(
    ru("del.routeSkipped", { route: "x", reason: "packet-empty" }),
    "пропущен x: packet-empty",
  );
});

// ── r33 ревью 2 (Argon, 046cae43) ─────────────────────────────────────

const argonRow = (key: string) => ({
  taskKey: key,
  projectId: "proj_main",
  coordinatorThreadId: "thr_coord",
  level: "review",
  route: "argon-review",
  preset: "a-r",
  provider: "acp-argon",
});

test("r33 rev2 B1: two parallel dispatches on a free maxActive:1 — one runs, one queues", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps({
    packetGit: fakeGit({}).git,
  });
  // Both rows build their packets concurrently — at the busy gate
  // neither has thread_id/queued_at yet. The old (queued_at ?? -1)
  // rank read each builder as "already running" and parked BOTH.
  const attach = JSON.stringify({ paths: [], from: "shaLINK" });
  const a = store.insert({ ...argonRow("PLUG-1"), attach });
  const b = store.insert({ ...argonRow("PLUG-2"), attach });
  const [ra, rb] = await Promise.all([
    dispatchToRoute(store.get(a.id)!, {}, stepsDeps),
    dispatchToRoute(store.get(b.id)!, {}, stepsDeps),
  ]);
  assert.equal(spawnArgs.length, 1);
  assert.deepEqual(
    [ra.status, rb.status].sort(),
    ["queued", "running"],
  );
  // The later claim parked; the winner consumed nothing (never queued).
  const winner = ra.status === "running" ? a : b;
  const parked = ra.status === "running" ? b : a;
  assert.equal(store.get(winner.id)!.queued_at, null);
  assert.ok(store.get(parked.id)!.queued_at != null);
});

test("r33 rev2 B1: an in-flight packet builder does not block a parked row's dequeue", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps({
    packetGit: fakeGit({}).git,
  });
  // A dispatch mid-`wrapPromptWithPacket`: dispatching, no thread, no
  // queued_at. The parked row's gate must not read it as a running
  // thread (rank -1) blocking the freed slot.
  store.insert(argonRow("PLUG-2"));
  const parked = store.insert({
    ...argonRow("PLUG-1"),
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  store.setQueuedAt(parked.id, T0);
  const res = await dispatchToRoute(store.get(parked.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  assert.equal(store.get(parked.id)!.route, "argon-review");
  assert.equal(spawnArgs.length, 1);
});

test("r33 rev2 B2: helper --level research packet-too-large walks the chain to the tool route", async () => {
  const policy = JSON.stringify({
    version: 1,
    limits: { maxActive: 10 },
    levels: {
      research: {
        role: "researcher",
        chain: ["research-argon", "research-opus"],
        autoFallback: true,
      },
    },
    routes: {
      "research-argon": {
        preset: "r-a",
        provider: "acp-argon",
        tools: false,
        maxPromptBytes: 10, // every packet is too large → PacketSkip
      },
      "research-opus": { preset: "o-r", provider: "acp-devin" },
    },
  });
  const { deps, store } = makeHelperDeps(policy);
  const presetCalls: string[] = [];
  deps.presetShow = async (preset) => {
    presetCalls.push(preset);
    return {
      providerId: preset === "r-a" ? "acp-argon" : "acp-devin",
      permissionMode: "full",
    };
  };
  const prompts: string[] = [];
  const origSpawn = deps.threads.spawn;
  deps.threads.spawn = async (a) => {
    prompts.push(String(a.prompt));
    return origSpawn(a);
  };
  const res = await runHelper(
    { prompt: "find the quota docs", level: "research", threadId: "thr_call" },
    deps,
  );
  // The skip advanced to the next chain route — the preset was
  // re-read and the row moved with it.
  assert.equal(res.route, "research-opus");
  assert.equal(res.preset, "o-r");
  assert.deepEqual(presetCalls, ["r-a", "o-r"]);
  const row = store.helper(res.helperId)!;
  assert.equal(row.route, "research-opus");
  assert.equal(row.preset, "o-r");
  // A `tools !== false` route gets the bare prompt — no packet.
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0]!.includes("МАТЕРИАЛ ДЛЯ"));
  assert.match(prompts[0]!, /find the quota docs/);
});

test("r33 rev2 B3: packet-empty on every chain route refuses with its own code", async () => {
  const { stepsDeps, store, spawnArgs } = makeDelegateDeps({
    policyText: JSON.stringify({
      version: 1,
      limits: { maxActive: 10 },
      levels: {
        review: {
          role: "auditor",
          chain: ["argon-1", "argon-2"],
          autoFallback: true,
        },
      },
      routes: {
        "argon-1": { preset: "a-r", provider: "acp-argon", tools: false },
        "argon-2": { preset: "a-r", provider: "acp-argon", tools: false },
      },
    }),
    packetGit: fakeGit({}).git, // no link → packet-empty on both
  });
  const row = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "argon-1",
    preset: "a-r",
    provider: "acp-argon",
  });
  await assert.rejects(
    () => dispatchToRoute(store.get(row.id)!, {}, stepsDeps),
    (e: OrchestratorError) => {
      // The chain burned out on packet skips — the refusal keeps the
      // skip's code, not a generic dispatch-failed.
      assert.equal(e.code, "packet-empty");
      return true;
    },
  );
  assert.equal(store.get(row.id), undefined);
  assert.equal(spawnArgs.length, 0);
});

/** A 4xx naming the own-spawn fields → SpawnSchemaRefusal → the
 * tasks-CLI fallback. */
const schemaRefusal = () =>
  Object.assign(
    new Error('HTTP 400: unrecognized field "parentThreadId"'),
    { code: "invalid_request", status: 400 },
  );

test("r33 аудит C: a schema refusal on a tool-less route never reaches the tasks-CLI fallback", async () => {
  // §20.2 п.4: the CLI fallback lets bb build the seed — task text
  // first, --instructions after — so the packet header could not lead.
  // A refused own-spawn on a tool-less route advances the chain; the
  // tool route behind it still falls back to tasks dispatch.
  let injected = false;
  const { stepsDeps, store } = makeDelegateDeps({
    packetGit: fakeGit({}).git,
    spawn: async () => {
      if (!injected) {
        injected = true;
        const blocker = store.insert({
          taskKey: "PLUG-9",
          projectId: "proj_main",
          coordinatorThreadId: "thr_coord",
          level: "research",
          route: "research-argon",
          preset: "r-a",
          provider: "acp-argon",
        });
        store.setThreadInfo(blocker.id, "thr_late");
        store.setStatus(blocker.id, "running");
      }
      throw schemaRefusal();
    },
  });
  const row = store.insert({
    ...argonRow("PLUG-1"),
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  const fresh = store.get(row.id)!;
  assert.equal(fresh.route, "opus-review");
  assert.deepEqual(
    res.skipped,
    [{ route: "argon-review", reason: "own-spawn-refused" }],
  );
});

test("r33 аудит C: an expired queue plus a schema refusal advances off the tool-less route", async () => {
  let injected = false;
  const { stepsDeps, store, setNow } = makeDelegateDeps({
    packetGit: fakeGit({}).git,
    spawn: async () => {
      if (!injected) {
        injected = true;
        const blocker = store.insert({
          taskKey: "PLUG-9",
          projectId: "proj_main",
          coordinatorThreadId: "thr_coord",
          level: "research",
          route: "research-argon",
          preset: "r-a",
          provider: "acp-argon",
        });
        store.setThreadInfo(blocker.id, "thr_late");
        store.setStatus(blocker.id, "running");
      }
      throw schemaRefusal();
    },
  });
  const row = store.insert({
    ...argonRow("PLUG-1"),
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  // Parked long ago — the wait has already expired.
  store.setQueuedAt(row.id, T0);
  setNow(T0 + 1300_000);
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  // The gate passed (the expired wait's claim released pre-spawn), the
  // own-spawn was refused → advanceRoute to the tool route, whose own
  // refusal still lands in the tasks-CLI fallback.
  assert.equal(res.status, "running");
  const fresh = store.get(row.id)!;
  assert.equal(fresh.route, "opus-review");
  assert.equal(fresh.queued_at, null);
});

// ── PLUG-298 tests ───────────────────────────────────────────────────

test("PLUG-298: advanceRoute normalizes legacy routes, aliases, and holds", async () => {
  const policyText = JSON.stringify({
    version: 1,
    levels: {
      review: {
        role: "auditor",
        chain: ["review-web-gemini", "opus-review"],
        autoFallback: true,
      },
    },
    routes: {
      "review-web-gemini": {
        preset: "web-gemini-review",
        provider: "acp-web-gemini",
        quotaGroup: "web-gemini",
        tools: false,
        maxActive: 1,
      },
      "opus-review": {
        preset: "o-r",
        provider: "acp-devin",
      },
    },
  });
  const { stepsDeps, store } = makeDelegateDeps({
    policyText,
    packetGit: fakeGit({}).git,
    spawn: async () => {
      throw schemaRefusal();
    },
  });
  // Row with legacy route "review-argon"
  const row = store.insert({
    taskKey: "PLUG-100",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-argon",
    preset: "argon-review",
    provider: "acp-web-gemini",
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  // Advance route should find review-argon matching review-web-gemini, not restart to review-web-gemini,
  // and advance to opus-review!
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  const fresh = store.get(row.id)!;
  assert.equal(fresh.route, "opus-review");
});

test("PLUG-298: advanceRoute skips review-web-gemini when held on 'argon'", async () => {
  const policyText = JSON.stringify({
    version: 1,
    levels: {
      review: {
        role: "auditor",
        chain: ["start-route", "review-web-gemini", "opus-review"],
        autoFallback: true,
      },
    },
    routes: {
      "start-route": {
        preset: "start",
        provider: "acp-devin",
        tools: false,
      },
      "review-web-gemini": {
        preset: "web-gemini-review",
        provider: "acp-web-gemini",
        quotaGroup: "web-gemini",
        tools: false,
      },
      "opus-review": {
        preset: "o-r",
        provider: "acp-devin",
      },
    },
  });
  const { stepsDeps, store } = makeDelegateDeps({
    policyText,
    presets: new Set(["start", "web-gemini-review", "o-r"]),
    packetGit: fakeGit({}).git,
    spawn: async () => {
      throw schemaRefusal();
    },
  });
  store.hold("argon", T0 + 100_000, "held");
  const row = store.insert({
    taskKey: "PLUG-101",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "start-route",
    preset: "start",
    provider: "acp-devin",
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  const fresh = store.get(row.id)!;
  // review-web-gemini was skipped because "argon" is held!
  assert.equal(fresh.route, "opus-review");
});

test("PLUG-298: helper advanceChain respects held 'argon' and advances past review-web-gemini", async () => {
  const policyText = JSON.stringify({
    version: 1,
    levels: {
      review: {
        role: "auditor",
        chain: ["review-web-gemini", "simple"],
        autoFallback: true,
      },
    },
    routes: {
      "review-web-gemini": {
        preset: "web-gemini-review",
        provider: "acp-web-gemini",
        quotaGroup: "web-gemini",
        tools: false,
        maxActive: 1,
      },
      simple: {
        preset: "simple",
        provider: "acp-opencode",
      },
    },
  });
  const { deps, store } = makeHelperDeps(policyText, new Set(["web-gemini-review", "simple"]));
  // Hold "argon"
  store.hold("argon", T0 + 100_000, "held");
  const res = await runHelper({ prompt: "audit this", level: "review", threadId: "thr_call" }, deps);
  assert.equal(res.route, "simple");
});

test("PLUG-298: helper --preset argon-review resolves and respects held 'argon'", async () => {
  const policyText = JSON.stringify({
    version: 1,
    levels: {
      review: { role: "auditor", chain: ["review-web-gemini"] },
    },
    routes: {
      "review-web-gemini": {
        preset: "web-gemini-review",
        provider: "acp-web-gemini",
        quotaGroup: "web-gemini",
        tools: false,
      },
    },
  });
  const { deps, store } = makeHelperDeps(policyText, new Set(["web-gemini-review"]));
  // Without hold: resolves successfully via alias
  const res = await runHelper({ prompt: "audit this", preset: "argon-review", level: "review", threadId: "thr_call" }, deps);
  assert.equal(res.route, "review-web-gemini");

  // With hold on "argon": fails with route-unavailable
  store.hold("argon", T0 + 100_000, "held");
  await assert.rejects(
    async () => runHelper({ prompt: "audit this", preset: "argon-review", level: "review", threadId: "thr_call" }, deps),
    (err: any) => err instanceof OrchestratorError && err.code === "route-unavailable",
  );
});

test("PLUG-298: toolless flag preserved for preset:argon-review via PRESET_ALIASES", async () => {
  const policyText = JSON.stringify({
    version: 1,
    levels: {
      review: { role: "auditor", chain: ["review-web-gemini", "opus-review"], autoFallback: true },
    },
    routes: {
      "review-web-gemini": {
        preset: "web-gemini-review",
        provider: "acp-web-gemini",
        tools: false,
      },
      "opus-review": { preset: "o-r", provider: "acp-devin" },
    },
  });
  const presets = new Set(["web-gemini-review", "o-r"]);
  const policy = parsePolicy(policyText, presets).policy;
  const { store, stepsDeps, spawnArgs } = makeDelegateDeps({
    policyText,
    presets,
    packetGit: fakeGit({}).git,
  });

  const row = store.insert({
    taskKey: "PLUG-102",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "preset:argon-review",
    preset: "argon-review",
    provider: "acp-web-gemini",
    attach: JSON.stringify({ paths: [], from: "shaLINK" }),
  });
  const res = await dispatchToRoute(store.get(row.id)!, {}, stepsDeps);
  assert.equal(res.status, "running");
  assert.ok(
    String(spawnArgs[0]?.prompt ?? "").includes("МАТЕРИАЛ ДЛЯ ПРОВЕРКИ"),
    "auditor packet expected for preset:argon-review",
  );

  // Watchdog recognizes toolless: missing verdict triggers immediate reissue without reminder
  const h = makeWatchdog(policyText, presets);
  const rowWd = h.insertActive({
    threadId: "thr_wd",
    level: "review",
    route: "preset:argon-review",
    preset: "argon-review",
    provider: "acp-web-gemini",
  });
  h.threadDtos.set("thr_wd", dto("thr_wd", "idle"));
  h.outputs.set("thr_wd", "отчёт без вердикта");
  h.eventLog.set("thr_wd", [
    ev(1, "turn/started", T0),
    ev(2, "turn/completed", T0 + 10, { status: "completed" }),
  ]);
  await h.wd.onThreadEvents({ thread: dto("thr_wd"), sequence: 2 });
  await h.wd.onThreadIdle(dto("thr_wd", "idle"));
  const freshWd = h.store.get(rowWd.id)!;
  assert.equal(freshWd.status, "reissued");
  assert.equal(h.sends.filter((s) => s.threadId === "thr_wd").length, 0);

  // quotaGroupsOfRow returns both canonical and alias groups
  const groups = quotaGroupsOfRow(row, policy);
  assert.ok(groups.has("preset:web-gemini-review"));
  assert.ok(groups.has("preset:argon-review"));
  assert.ok(groups.has("web-gemini"));
});
