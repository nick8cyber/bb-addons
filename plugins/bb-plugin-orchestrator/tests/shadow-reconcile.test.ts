/**
 * §32.5.8 (PLUG-398, ADR-0041): наблюдатель-сверка shadow через настоящие
 * входы плагина (§19.7): CLI `delegate`/`approve`/`run-queue`/`shadow-report`,
 * итог ревью — штатный переход делегирования в done с вердиктом (событие
 * review.verdict), публикация — штатная запись выкладки (release.published).
 */
import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCmd } from "../src/cmd.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import { DelegationStore, type TaskTransitionRow } from "../src/store.js";
import { createPlugin } from "../server.js";
import { makeTempDir } from "./helpers/temp.js";
import {
  buildShadowReport,
  matrixEdges,
  releaseRefusalCountedByEvent,
  reverseReviewLevel,
  SHADOW_RECONCILE_STARTED_EVENT,
} from "../src/shadow-reconcile.js";
import {
  parseWorkGraphProjects,
  OFF_OVERRIDE_MAX_MS,
} from "../src/workgraph-mode.js";
import { runRunQueue } from "../src/workgraph.js";

const ORIGINAL_BB_THREAD_ID = process.env.BB_THREAD_ID;
delete process.env.BB_THREAD_ID;
beforeEach(() => {
  delete process.env.BB_THREAD_ID;
});
after(() => {
  if (ORIGINAL_BB_THREAD_ID !== undefined) process.env.BB_THREAD_ID = ORIGINAL_BB_THREAD_ID;
  else delete process.env.BB_THREAD_ID;
});

const PROJECT = "proj_shadow";

const POLICY = {
  version: 1,
  limits: { maxActive: 9 },
  specBeforeCode: false,
  reviewByLevel: {
    complex: "review",
    medium: "review-medium",
    simple: "review-simple",
  },
  levels: {
    spec: { chain: ["r"] },
    research: { role: "researcher", chain: ["r"] },
    architect: { chain: ["r"] },
    complex: { chain: ["r"] },
    medium: { chain: ["r"] },
    simple: { chain: ["r"] },
    review: { role: "auditor", chain: ["r"] },
    "review-medium": { role: "auditor", chain: ["r"] },
    "review-simple": { role: "auditor", chain: ["r"] },
    "release-audit": { role: "auditor", chain: ["r"] },
  },
  routes: { r: { preset: "simple", provider: "acp-opencode" } },
};

const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

interface TrackerTask {
  status?: string;
  route?: string;
  project?: string | null;
}

/** Окружения: id окружения → путь рабочей копии (`environment show`). */
type EnvPaths = Map<string, string>;
/** Хук на любой внешний вызов (bb CLI / git) — для регрессий гонок. */
type CallHook = { fn: (() => void) | null };

function fakeCli(
  tracker: Map<string, TrackerTask>,
  envPaths: EnvPaths,
  hook: CallHook,
): { cli: BbCli; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    cli: {
      run: async (args) => {
        calls.push(args);
        hook.fn?.();
        const key = args.join(" ");
        if (key.startsWith("environment show")) {
          const path = envPaths.get(args[2] ?? "");
          return path
            ? ok(JSON.stringify({ id: args[2], path, mergeBaseBranch: "main" }))
            : { exitCode: 1, stdout: "", stderr: "not found" };
        }
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
        if (key.startsWith("tasks show")) {
          const tk = (args[2] ?? "").toUpperCase();
          const t = tracker.get(tk) ?? {};
          const project = t.project === undefined ? PROJECT : t.project;
          return ok(
            JSON.stringify({
              task: {
                id: `task-${tk}`,
                key: tk,
                title: "do it",
                status: t.status ?? "in_progress",
                ...(t.route ? { payload: { route: t.route } } : {}),
              },
              project: project ? { name: "p", linkedBbProjectId: project } : null,
              subtasks: [],
              attachments: [],
              comments: [],
            }),
          );
        }
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
        if (key.startsWith("provider-retry status")) return ok(JSON.stringify({ retries: [] }));
        return ok();
      },
    },
  };
}

interface Ctx {
  host: Awaited<ReturnType<typeof makeHost>>["host"];
  store: DelegationStore;
  tracker: Map<string, TrackerTask>;
  sent: { threadId: string; text: string }[];
  clock: { now: number };
  envPaths: EnvPaths;
  hook: CallHook;
}

async function makeHost(
  settings: Record<string, string | boolean> = {},
  opts: { clock?: { now: number } } = {},
) {
  const tracker = new Map<string, TrackerTask>();
  const envPaths: EnvPaths = new Map();
  const hook: CallHook = { fn: null };
  const { cli } = fakeCli(tracker, envPaths, hook);
  const realCmd = createCmd();
  const sent: { threadId: string; text: string }[] = [];
  let spawned = 0;
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-shadow-reconcile-"),
    settings: {
      policy: JSON.stringify(POLICY),
      language: "ru",
      workGraph: "off",
      workGraphProjects: JSON.stringify({ [PROJECT]: "shadow" }),
      ...settings,
    },
    agentSkillIds: [
      "orchestrator-setup",
      "orchestrator-coordinator",
      "orchestrator-setup-ru",
      "orchestrator-coordinator-ru",
    ],
    sdk: {
      threads: {
        get: async (a: { threadId?: string } = {}) => ({
          id: "thr_coord",
          parentThreadId: null,
          title: "coordinator",
          titleFallback: null,
          originPluginId: null,
          projectId: PROJECT,
          environmentId:
            (a.threadId ?? "thr_coord") === "thr_coord" && envPaths.has("env_coord")
              ? "env_coord"
              : null,
        }),
        spawn: async () => {
          spawned++;
          return { id: `thr_exec_${spawned}` };
        },
        list: async () => [],
        update: async () => ({}),
        send: async (a: { threadId: string; input: { text: string }[] }) => {
          sent.push({ threadId: a.threadId, text: a.input.map((i) => i.text).join("") });
          return {};
        },
      },
    } as any,
  });
  const clock = opts.clock;
  await createPlugin(host.bb, {
    bbCli: cli,
    cmd: {
      ...realCmd,
      run: (file, args, o) => {
        hook.fn?.();
        return realCmd.run(file, args, o);
      },
    },
    ...(clock ? { now: () => clock.now } : {}),
  });
  const store = new DelegationStore(host.bb.storage.database());
  return { host, store, tracker, sent, clock: clock ?? { now: Date.now() }, envPaths, hook };
}

async function cli(c: Ctx, argv: string[], threadId: string | null = "thr_coord") {
  const res = await c.host.harness.runCli(
    [...argv, "--json"],
    threadId ? { threadId } : {},
  );
  return { ...res, body: JSON.parse(res.stdout || "{}") };
}

async function delegate(c: Ctx, key: string, level: string, extra: string[] = []) {
  const res = await cli(c, ["delegate", key, "--level", level, ...extra]);
  assert.equal(res.exitCode, 0, `delegate ${key} ${level}: ${res.stdout} ${res.stderr}`);
  return res.body.delegationId as number;
}

/** Исполнитель сдал (delegation.done), ревьюер — с вердиктом (review.verdict). */
function finish(c: Ctx, id: number, verdict?: "OK" | "CHANGES") {
  c.store.setStatus(id, "running");
  if (verdict) {
    c.store.setStatusIf(id, "running", "done", {
      reviewVerdict: { verdict, blockers: verdict === "OK" ? 0 : 2 },
    } as any);
  } else {
    c.store.setStatusIf(id, "running", "done");
  }
}

async function approve(c: Ctx, key: string) {
  const res = await cli(c, ["approve", key], null);
  assert.equal(res.exitCode, 0, `approve ${key}: ${res.stdout} ${res.stderr}`);
}

/** Публикация выкладки — штатная запись release.ts (updateRelease → release.published). */
function publish(c: Ctx, key: string, action: "push" | "pr" = "push") {
  const rel = c.store.insertRelease({
    taskKey: key,
    projectId: PROJECT,
    coordinatorThreadId: "thr_coord",
    repoPath: "/tmp/repo",
    branch: `bb/${key.toLowerCase()}`,
    targetAction: action,
    targetBranch: "main",
  } as any);
  c.store.updateRelease(rel.id, { status: "published" });
  return rel.id;
}

function gitR(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/**
 * Настоящие копии для CLI `merge` (§19.7): копия координатора — клон на
 * ветке `work`, копия исполнителя — связанный worktree на `bb/<key>`.
 * `conflict: true` — встречная правка того же файла в `work`.
 */
function setupMergeCopies(c: Ctx, key: string, opts: { conflict?: boolean } = {}) {
  const base = makeTempDir("orch-shadow-merge-");
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const coord = join(base, "coord");
  execFileSync("git", ["init", "-q", "-b", "main", coord]);
  gitR(coord, ["config", "user.name", "Agent"]);
  gitR(coord, ["config", "user.email", "agent@x.io"]);
  writeFileSync(join(coord, "a.txt"), "one\n");
  gitR(coord, ["add", "."]);
  gitR(coord, ["commit", "-q", "-m", "base"]);
  gitR(coord, ["remote", "add", "origin", remote]);
  gitR(coord, ["push", "-q", "-u", "origin", "main"]);
  gitR(coord, ["checkout", "-q", "-b", "work"]);
  const exec = join(base, "exec");
  const branch = `bb/${key.toLowerCase()}`;
  gitR(coord, ["worktree", "add", "-q", exec, "-b", branch]);
  if (opts.conflict) {
    writeFileSync(join(coord, "f.txt"), "coordinator side\n");
    gitR(coord, ["add", "."]);
    gitR(coord, ["commit", "-q", "-m", "coord change"]);
  }
  writeFileSync(join(exec, "f.txt"), opts.conflict ? "executor side\n" : "feature\n");
  gitR(exec, ["add", "."]);
  gitR(exec, ["commit", "-q", "-m", "feat"]);
  c.envPaths.set("env_coord", coord);
  c.envPaths.set(`env_exec_${key}`, exec);
  return { coord, exec, branch, sha: gitR(exec, ["rev-parse", "HEAD"]) };
}

/** Итог круга исполнителя — штатная запись watchdog (setRoundResult). */
function recordRound(
  c: Ctx,
  id: number,
  copies: { branch: string; sha: string },
  key: string,
) {
  c.store.setRoundResult(id, {
    envId: `env_exec_${key}`,
    branch: copies.branch,
    sha: copies.sha,
    commits: 1,
    dirty: false,
  });
}

/** Ручной `merge <KEY>` через CLI плагина. */
async function mergeCli(c: Ctx, key: string) {
  const res = await cli(c, ["merge", key]);
  assert.equal(res.exitCode, 0, `merge ${key}: ${res.stdout} ${res.stderr}`);
  return res.body;
}

/**
 * Раздача вне очереди: задача разослана до выкладки §32.5 (записи в
 * task_queue нет), исполнитель сдал итог круга на настоящих копиях.
 */
function outOfQueueDelegation(c: Ctx, key: string) {
  const row = c.store.insert({
    taskKey: key,
    projectId: PROJECT,
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "simple",
    provider: "acp-opencode",
    round: 1,
  });
  finish(c, row.id);
  recordRound(c, row.id, setupMergeCopies(c, key), key);
  return row.id;
}

function reasonRows(c: Ctx, key: string, reason: string) {
  return c.store.listTransitions(key).filter((r) => r.reason === reason);
}

function followRows(rows: TaskTransitionRow[]) {
  return rows
    .filter((r) => r.actor === "shadow:follow")
    .map((r) => {
      const p = JSON.parse(r.payload ?? "{}");
      return { verdict: p.verdict as string, node: r.to_node, command: p.command as string, rule: p.rule, detail: p.verdict_detail, transition_id: p.transition_id, id: r.id, reason: r.reason };
    });
}

function verdicts(c: Ctx, key: string): string[] {
  return followRows(c.store.listTransitions(key))
    .filter((r) => r.verdict)
    .map((r) => (r.verdict === "graph-only" ? `graph-only:${r.node}` : `${r.verdict}:${r.command}`));
}

// ── 1. Приём ────────────────────────────────────────────────────────────

test("§32.5.8 1: shadow, delegate medium вне очереди → приём в code/running, одна строка shadow:adopt, run-queue без раздач", async () => {
  const c = (await makeHost()) as Ctx;
  const delId = await delegate(c, "SMK-1", "medium");
  const task = c.store.getTask("SMK-1");
  assert.ok(task, "задача принята в очередь");
  assert.equal(task.node, "code");
  assert.equal(task.status, "running");
  assert.equal(task.route, "feature");
  assert.equal(task.level, "medium");
  assert.equal(task.project_id, PROJECT);
  assert.equal(task.coordinator_thread_id, "thr_coord");
  const payload = JSON.parse(task.payload ?? "{}");
  assert.equal(payload.origin, "shadow-adopt");
  assert.equal(payload.adopted_delegation_id, delId);
  const rows = c.store.listTransitions("SMK-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor, "shadow:adopt");
  assert.equal(rows[0]!.from_node, "none");
  assert.equal(rows[0]!.from_status, "none");
  assert.equal(rows[0]!.reason, "shadow-adopt:delegate");
  assert.equal(JSON.parse(rows[0]!.payload ?? "{}").verdict, undefined, "приём не получает класса");

  const delegationsBefore = c.store.delegationsByTask("SMK-1").length;
  const rq = await cli(c, ["run-queue", "--once"], null);
  assert.equal(rq.exitCode, 0, rq.stdout);
  assert.equal(c.store.delegationsByTask("SMK-1").length, delegationsBefore, "run-queue не раздаёт");
  const after = c.store.getTask("SMK-1")!;
  assert.equal(after.node, "code");
  assert.equal(after.status, "running");
  assert.equal(c.store.listTransitions("SMK-1").length, 1);
});

// ── 2. Следование и match (manual) ───────────────────────────────────────

async function featureFlow(c: Ctx, key: string, manual: boolean) {
  const spec = await delegate(c, key, "spec");
  finish(c, spec);
  const sr = await delegate(c, key, "review", ["--kind", "spec_review"]);
  finish(c, sr, "OK");
  if (manual) await approve(c, key);
  const code = await delegate(c, key, "complex");
  finish(c, code);
  recordRound(c, code, setupMergeCopies(c, key), key);
  const rv = await delegate(c, key, "review");
  finish(c, rv, "OK");
  if (manual) await approve(c, key);
  const m = await mergeCli(c, key);
  assert.equal(m.mergeStatus, "merged", JSON.stringify(m));
  publish(c, key);
}

test("§32.5.8 2: feature manual — только match и graph-only (checks, design_check), в конце release/done", async () => {
  const c = (await makeHost({ approvalMode: "manual" })) as Ctx;
  await featureFlow(c, "SMK-2", true);
  assert.deepEqual(verdicts(c, "SMK-2"), [
    "match:delegate", // spec → spec_review
    "match:approve", // spec_review → owner_gate → code
    "match:delegate", // раздача кода, dispatched = false
    "match:delegate", // code → checks → review
    "graph-only:checks",
    "match:approve", // review → design_check → owner_gate → release
    "graph-only:design_check",
    "match:merge", // 4а
    "match:release", // 4б
  ]);
  const t = c.store.getTask("SMK-2")!;
  assert.equal(t.node, "release");
  assert.equal(t.status, "done");
  assert.equal(t.confirmation_mode, "manual");
  // graph-only несут transition_id своей строки следования
  const rows = followRows(c.store.listTransitions("SMK-2"));
  for (const g of rows.filter((r) => r.verdict === "graph-only")) {
    assert.ok(rows.some((r) => r.id === g.transition_id && r.verdict === "match"));
  }
  // зеркало ни разу не было в owner_gate
  assert.ok(!c.store.listTransitions("SMK-2").some((r) => r.to_node === "owner_gate"));
});

test("§32.5.8 2а: feature auto без approve — только match и graph-only", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
  await featureFlow(c, "SMK-3", false);
  assert.deepEqual(verdicts(c, "SMK-3"), [
    "match:delegate", // spec → spec_review
    "match:delegate", // spec_review → code (auto)
    "match:delegate", // code → checks → review
    "graph-only:checks",
    "match:merge", // review → design_check → release
    "graph-only:design_check",
    "match:release",
  ]);
  const t = c.store.getTask("SMK-3")!;
  assert.equal(t.node, "release");
  assert.equal(t.status, "done");
});

test("§32.5.8 2б: docs manual — approve ведёт в release, все шаги match", async () => {
  const c = (await makeHost({ approvalMode: "manual" })) as Ctx;
  c.tracker.set("SMK-4", { route: "docs" });
  const spec = await delegate(c, "SMK-4", "spec");
  assert.equal(c.store.getTask("SMK-4")!.route, "docs");
  finish(c, spec);
  const sr = await delegate(c, "SMK-4", "review", ["--kind", "spec_review"]);
  finish(c, sr, "OK");
  await approve(c, "SMK-4");
  assert.equal(c.store.getTask("SMK-4")!.node, "release");
  publish(c, "SMK-4");
  assert.deepEqual(verdicts(c, "SMK-4"), ["match:delegate", "match:approve", "match:release"]);
  const t = c.store.getTask("SMK-4")!;
  assert.equal(t.node, "release");
  assert.equal(t.status, "done");
});

test("§32.5.8 2в: feature manual, merge после ревью кода OK без второго approve → skip с ожидаемым owner_gate (pre_release)", async () => {
  const c = (await makeHost({ approvalMode: "manual" })) as Ctx;
  const spec = await delegate(c, "SMK-5", "spec");
  finish(c, spec);
  const sr = await delegate(c, "SMK-5", "review", ["--kind", "spec_review"]);
  finish(c, sr, "OK");
  await approve(c, "SMK-5");
  const code = await delegate(c, "SMK-5", "complex");
  finish(c, code);
  recordRound(c, code, setupMergeCopies(c, "SMK-5"), "SMK-5");
  const rv = await delegate(c, "SMK-5", "review");
  finish(c, rv, "OK");
  await mergeCli(c, "SMK-5");
  const last = followRows(c.store.listTransitions("SMK-5")).at(-1)!;
  assert.equal(last.verdict, "skip");
  assert.equal(last.command, "merge");
  assert.equal(last.detail.expected_node, "owner_gate");
  assert.equal(last.detail.expected_gate, "pre_release");
  assert.equal(last.detail.actual_node, "release");
  assert.equal(c.store.getTask("SMK-5")!.node, "release", "запись всё равно следует за фактом");
});

test("§32.5.8 2г: repeat в code, match 3 review → code после CHANGES, четвёртый круг ревью → skip round-cap-exceeded", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
  const k = "SMK-6";
  const c1 = await delegate(c, k, "complex"); // приём в code
  finish(c, c1);
  const c2 = await delegate(c, k, "complex"); // повтор в code
  finish(c, c2);
  let rows = followRows(c.store.listTransitions(k));
  assert.equal(rows.at(-1)!.verdict, "repeat");
  for (let round = 1; round <= 3; round++) {
    const rv = await delegate(c, k, "review");
    assert.equal(c.store.getTask(k)!.node, "review");
    finish(c, rv, "CHANGES");
    assert.equal(c.store.getTask(k)!.code_review_rounds, round);
    const code = await delegate(c, k, "complex");
    finish(c, code);
    rows = followRows(c.store.listTransitions(k));
    const last = rows.at(-1)!;
    if (round < 3) {
      assert.equal(last.verdict, "match", `round ${round}: review → code после CHANGES`);
      assert.equal(last.rule, "3");
    }
  }
  const rv4 = await delegate(c, k, "review");
  finish(c, rv4, "CHANGES");
  rows = followRows(c.store.listTransitions(k));
  const fourth = rows.filter((r) => r.command === "delegate" && r.node === "review").at(-1)!;
  assert.equal(fourth.verdict, "skip");
  assert.equal(fourth.detail.reason, "round-cap-exceeded");
});

test("§32.5.8 2д: research с ключом → приём route=research, branch=NULL, node=research; release-audit → 0 записей", async () => {
  const c = (await makeHost()) as Ctx;
  await delegate(c, "SMK-7", "research");
  const t = c.store.getTask("SMK-7")!;
  assert.equal(t.route, "research");
  assert.equal(t.branch, null);
  assert.equal(t.node, "research");
  assert.equal(t.status, "running");

  const res = await cli(c, ["delegate", "SMK-8", "--level", "release-audit"]);
  assert.equal(c.store.getTask("SMK-8"), null, `release-audit не принимается: ${res.stdout}`);
  assert.equal(
    c.store.listTransitions("SMK-8").filter((r) => r.actor.startsWith("shadow:")).length,
    0,
  );
});

// ── 3. skip ─────────────────────────────────────────────────────────────

test("§32.5.8 3: feature, код раздан без принятого ревью спеки → skip с ожидаемым spec_review, запись следует в code", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
  const spec = await delegate(c, "SMK-9", "spec");
  finish(c, spec);
  await delegate(c, "SMK-9", "complex");
  const last = followRows(c.store.listTransitions("SMK-9")).at(-1)!;
  assert.equal(last.verdict, "skip");
  assert.equal(last.detail.expected_node, "spec_review");
  assert.equal(last.detail.actual_node, "code");
  assert.equal(typeof last.detail.delegation_id, "number");
  assert.equal(c.store.getTask("SMK-9")!.node, "code");
});

// ── 4. Синхронизация ────────────────────────────────────────────────────

test("§32.5.8 4: задача done в трекере при записи start/queued → после такта done, строка shadow:sync, shadow_eval без would_transition", async () => {
  const c = (await makeHost()) as Ctx;
  for (const key of ["SMK-10", "SMK-11"]) {
    c.store.insertTask({
      taskKey: key,
      projectId: PROJECT,
      coordinatorThreadId: "thr_coord",
      route: "simple",
      level: "simple",
      confirmationMode: "auto",
    });
  }
  c.tracker.set("SMK-10", { status: "done" });
  c.tracker.set("SMK-11", { status: "canceled" });
  const rq = await cli(c, ["run-queue", "--once"], null);
  assert.equal(rq.exitCode, 0, rq.stdout);
  const t = c.store.getTask("SMK-10")!;
  assert.equal(t.status, "done");
  assert.equal(t.node, "start", "узел без изменений");
  const sync = c.store.listTransitions("SMK-10").find((r) => r.actor === "shadow:sync")!;
  assert.equal(sync.reason, "tracker-terminal:done");
  assert.equal(JSON.parse(t.payload ?? "{}").shadow_eval?.would_transition, undefined);
  const t11 = c.store.getTask("SMK-11")!;
  assert.equal(t11.status, "cancelled");
  assert.equal(
    c.store.listTransitions("SMK-11").find((r) => r.actor === "shadow:sync")?.reason,
    "tracker-terminal:canceled",
  );
});

// ── 5. Срок переопределения ─────────────────────────────────────────────

test("§32.5.8 5: { mode: off, until: now+1s } → до срока off, после — наследуемый режим, ключ удалён, событие override-expired, сообщение координатору; until=now+48h → 24h", async () => {
  const clock = { now: Date.parse("2026-11-24T00:00:00Z") };
  const c = (await makeHost(
    {
      workGraph: "shadow",
      workGraphProjects: JSON.stringify({
        [PROJECT]: { mode: "off", until: new Date(clock.now + 1000).toISOString(), reason: "hotfix" },
      }),
    },
    { clock },
  )) as Ctx;
  // координатор проекта известен по раздачам
  c.store.insert({
    taskKey: "SMK-12",
    projectId: PROJECT,
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "simple",
    provider: "acp-opencode",
    round: 1,
  });
  // до срока: проект в off — молчание
  await cli(c, ["delegate", "SMK-13", "--level", "simple"]);
  assert.equal(c.store.getTask("SMK-13"), null);
  assert.equal(c.store.listTransitions("SMK-13").length, 0);

  clock.now += 2000;
  // такт run-queue удаляет истёкший ключ
  await cli(c, ["run-queue", "--once"], null);
  // наследуемый режим — глобальный shadow
  await cli(c, ["delegate", "SMK-14", "--level", "simple"]);
  assert.ok(c.store.getTask("SMK-14"), "после срока действует наследуемый shadow");
  const ev = c.store
    .listEvents("setting.changed")
    .map((e) => JSON.parse(e.payload))
    .find((p) => p.reason === "override-expired");
  assert.ok(ev, "событие смены настройки с reason override-expired");
  assert.equal(ev.setting, "workGraphProjects");
  assert.equal(ev.source, "menu");
  assert.deepEqual(JSON.parse(ev.newValue), {});
  assert.ok(
    c.sent.some((m) => m.threadId === "thr_coord" && /было off, стало shadow/.test(m.text)),
    `сообщение координатору: ${JSON.stringify(c.sent)}`,
  );

  // обрезка off до 24 ч — через смену настроек (§19.7), как это делает владелец
  await c.host.harness.setSettings({
    workGraphProjects: JSON.stringify({
      [PROJECT]: { mode: "off", until: new Date(clock.now + 48 * 3600_000).toISOString() },
    }),
  });
  let capped: any;
  for (let i = 0; i < 50 && !capped; i++) {
    await new Promise((r) => setImmediate(r));
    capped = c.store
      .listEvents("setting.changed")
      .map((e) => JSON.parse(e.payload))
      .find((p) => p.reason === "off-override-capped");
  }
  assert.ok(capped, "событие смены настройки с reason off-override-capped");
  assert.equal(capped.setting, "workGraphProjects");
  assert.equal(capped.source, "menu");
  assert.equal(
    Date.parse(JSON.parse(capped.newValue)[PROJECT].until),
    clock.now + OFF_OVERRIDE_MAX_MS,
    "срок off обрезан до 24 ч от записи",
  );
});

// ── 6. Отчёт ────────────────────────────────────────────────────────────

test("§32.5.8 6: shadow-report --json на фикстуре — точные числа по классам и список skip", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
  // метка стартовой сверки §32.5.4 п. 4 (в работе её ставит первый такт)
  const first = await cli(c, ["shadow-report", "--project", PROJECT], null);
  assert.equal(first.exitCode, 0, first.stdout);
  // приём (1)
  await delegate(c, "SMK-20", "medium");
  // auto-поток (2а): приём spec + 5 match + 2 graph-only
  await featureFlow(c, "SMK-21", false);
  // skip (3): 1 skip
  const spec = await delegate(c, "SMK-22", "spec");
  finish(c, spec);
  await delegate(c, "SMK-22", "complex");
  // синхронизация (4)
  c.store.insertTask({
    taskKey: "SMK-23",
    projectId: PROJECT,
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });
  c.tracker.set("SMK-23", { status: "done" });
  // ручной merge по задаче вне очереди → ровно одна строка task-not-enqueued
  outOfQueueDelegation(c, "SMK-24");
  const merged = await mergeCli(c, "SMK-24");
  assert.equal(merged.mergeStatus, "merged", JSON.stringify(merged));
  const rep = await cli(c, ["shadow-report", "--project", PROJECT], null);
  assert.equal(rep.exitCode, 0, rep.stdout);
  const p = rep.body.projects.find((x: any) => x.projectId === PROJECT);
  assert.ok(p, JSON.stringify(rep.body));
  assert.deepEqual(p.classes, { match: 5, repeat: 0, skip: 1, "graph-only": 2, unmapped: 0 });
  assert.equal(p.adopted, 3);
  assert.equal(p.fullCycles, 1);
  assert.equal(p.skips.length, 1);
  assert.equal(p.skips[0].taskKey, "SMK-22");
  assert.equal(p.skips[0].detail.expected_node, "spec_review");
  assert.equal(p.unmapped.length, 0);
  assert.equal(p.primaryRatio, 5 / 6);
  assert.equal(p.manualActions, 10);
  assert.equal(p.taskNotEnqueued, 1);
  assert.equal(p.taskNotEnqueuedShare, 1 / 10);
  assert.equal(p.reopened, 0);
  assert.equal(p.closedTaskActions, 0);
  assert.equal(p.readyForStrict, false);
  assert.deepEqual(rep.body.synced, [{ taskKey: "SMK-23", status: "done" }]);
  assert.equal(c.store.getTask("SMK-23")!.status, "done", "отчёт первым шагом синхронизирует");
  // переопределения в отчёте: строковое — permanent
  assert.deepEqual(rep.body.overrides, [{ projectId: PROJECT, mode: "shadow", permanent: true }]);
});

// ── 7. off молчит ───────────────────────────────────────────────────────

test("§32.5.8 7: проект off — сценарии 1–5 дают 0 строк task_transitions и 0 записей очереди", async () => {
  const c = (await makeHost({ workGraphProjects: JSON.stringify({ [PROJECT]: "off" }), workGraph: "shadow" })) as Ctx;
  const d1 = await delegate(c, "OFF-1", "medium");
  finish(c, d1);
  recordRound(c, d1, setupMergeCopies(c, "OFF-1"), "OFF-1");
  const sr = await delegate(c, "OFF-1", "review", ["--kind", "spec_review"]);
  finish(c, sr, "OK");
  const rv = await delegate(c, "OFF-1", "review");
  finish(c, rv, "CHANGES");
  const m = await mergeCli(c, "OFF-1");
  assert.equal(m.mergeStatus, "merged", "merge в off выполняется штатно");
  publish(c, "OFF-1");
  const rel = await cli(c, ["release", "OFF-1"]);
  assert.notEqual(rel.exitCode, 0, "выкладка без конфигурации — отказ");
  await delegate(c, "OFF-2", "research");
  c.tracker.set("OFF-1", { status: "done" });
  await cli(c, ["run-queue", "--once"], null);
  assert.equal(c.store.getTask("OFF-1"), null);
  assert.equal(c.store.getTask("OFF-2"), null);
  assert.equal(c.store.listTransitions("OFF-1").length, 0);
  assert.equal(c.store.listTransitions("OFF-2").length, 0);
});

// ── вспомогательное: граф матрицы ───────────────────────────────────────

test("§32.5.3: граф матрицы §28.1 строится пробами — ключевые рёбра feature/manual и auto", () => {
  const m = matrixEdges("feature", "manual");
  const has = (edges: typeof m, from: string, to: string) =>
    edges.some((e) => e.from === from && e.to === to);
  assert.ok(has(m, "spec", "spec_review"));
  assert.ok(has(m, "spec_review", "owner_gate"));
  assert.ok(has(m, "owner_gate", "code"));
  assert.ok(has(m, "code", "checks"));
  assert.ok(has(m, "checks", "review"));
  assert.ok(has(m, "review", "design_check"));
  assert.ok(has(m, "design_check", "owner_gate"));
  assert.ok(has(m, "owner_gate", "release"));
  const a = matrixEdges("feature", "auto");
  assert.ok(has(a, "spec_review", "code"));
  assert.ok(has(a, "design_check", "release"));
  assert.ok(!has(a, "spec_review", "owner_gate"));
  void buildShadowReport;
});

// ── регрессии ревью PLUG-398 (заход 1) ─────────────────────────────────

test("§32.5.2: merge через CLI с исходом conflict — зеркало не двигается, класса нет", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
  const k = "SMK-30";
  const code = await delegate(c, k, "complex");
  finish(c, code);
  recordRound(c, code, setupMergeCopies(c, k, { conflict: true }), k);
  const rv = await delegate(c, k, "review");
  finish(c, rv, "OK");
  const before = c.store.listTransitions(k).length;
  const res = await cli(c, ["merge", k, "--no-autofix"]);
  assert.equal(res.exitCode, 0, res.stdout);
  assert.equal(res.body.mergeStatus, "conflict", JSON.stringify(res.body));
  const t = c.store.getTask(k)!;
  assert.equal(t.node, "review", "несостоявшийся merge не переводит зеркало в release");
  assert.equal(t.status, "running");
  assert.equal(c.store.listTransitions(k).length, before, "ни строки следования, ни класса");
  assert.equal(JSON.parse(t.payload ?? "{}").mirror.dispatched, true);
});

test("§32.5.1 п. 2: ветка принятой записи — фактическая ветка раздачи из итога круга", async () => {
  const c = (await makeHost()) as Ctx;
  const k = "SMK-31";
  const id = await delegate(c, k, "medium");
  assert.equal(c.store.getTask(k)!.branch, null, "до итога круга ветка неизвестна");
  finish(c, id); // delegation.done — итога круга ещё нет
  assert.equal(c.store.getTask(k)!.branch, null);
  const copies = setupMergeCopies(c, k);
  recordRound(c, id, copies, k); // watchdog: collectRoundResult → setRoundResult
  assert.equal(c.store.getTask(k)!.branch, copies.branch);
  // ревью не перезаписывает ветку
  const rv = await delegate(c, k, "review");
  finish(c, rv, "OK");
  assert.equal(c.store.getTask(k)!.branch, copies.branch);
});

test("§32.5.2: отказ выкладки считается один раз — событием после вставки строки, CLI — только до неё", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
  const k = "SMK-32";
  const code = await delegate(c, k, "complex");
  finish(c, code);
  recordRound(c, code, setupMergeCopies(c, k), k);
  const rv = await delegate(c, k, "review");
  finish(c, rv, "OK");
  await mergeCli(c, k);
  assert.equal(c.store.getTask(k)!.node, "release");
  // 1) отказ до вставки строки (нет конфигурации выкладки) — путь CLI
  const before = c.store.latestReleaseByTask(k)?.id ?? 0;
  const r1 = await cli(c, ["release", k]);
  assert.notEqual(r1.exitCode, 0);
  assert.equal(releaseRefusalCountedByEvent(c.store, k, before), false);
  assert.equal(c.store.getTask(k)!.release_attempts, 1);
  // 2) отказ после вставки: строка → failed (событие release.failed) —
  // CLI видит, что отказ уже учтён, и второй раз не считает
  const idBefore = c.store.latestReleaseByTask(k)?.id ?? 0;
  const rel = c.store.insertRelease({
    taskKey: k,
    projectId: PROJECT,
    coordinatorThreadId: "thr_coord",
    repoPath: "/tmp/repo",
    branch: `bb/${k.toLowerCase()}`,
    targetAction: "push",
    targetBranch: "main",
  } as any);
  c.store.updateRelease(rel.id, { status: "failed", error: "sync conflict" });
  assert.equal(c.store.getTask(k)!.release_attempts, 2, "событие release.failed");
  assert.equal(releaseRefusalCountedByEvent(c.store, k, idBefore), true);
  const refused = c.store
    .listTransitions(k)
    .filter((r) => r.reason === "shadow-release:refused");
  assert.equal(refused.length, 2);
});

test("§32.5.1 п. 1: release-audit при неопределённом проекте — полное молчание", async () => {
  const c = (await makeHost({ workGraph: "shadow" })) as Ctx;
  c.tracker.set("NOP-1", { project: null });
  await cli(c, ["delegate", "NOP-1", "--level", "release-audit"]);
  assert.equal(c.store.getTask("NOP-1"), null);
  assert.equal(c.store.listTransitions("NOP-1").length, 0, "ни task-not-enqueued, ни shadow:*");
  // контроль: обычная раздача без проекта — task-not-enqueued (§32.5.1 п. 6)
  c.tracker.set("NOP-2", { project: null });
  await cli(c, ["delegate", "NOP-2", "--level", "simple"]);
  assert.equal(
    c.store.listTransitions("NOP-2").filter((r) => r.reason === "task-not-enqueued").length,
    1,
  );
});

test("§32.5.4: approve в shadow не открывает закрытую запись", async () => {
  const c = (await makeHost({ approvalMode: "manual" })) as Ctx;
  const k = "SMK-33";
  await delegate(c, k, "spec");
  c.tracker.set(k, { status: "done" });
  await cli(c, ["run-queue", "--once"], null);
  assert.equal(c.store.getTask(k)!.status, "done");
  const before = c.store.listTransitions(k).length;
  // даже при открытой в трекере задаче approve запись не переоткрывает
  c.tracker.set(k, { status: "in_progress" });
  await cli(c, ["approve", k], null);
  const t = c.store.getTask(k)!;
  assert.equal(t.status, "done", "закрытая запись остаётся закрытой");
  assert.equal(t.node, "spec");
  assert.equal(
    c.store.listTransitions(k).filter((r) => r.actor === "shadow:follow").length,
    0,
  );
  assert.equal(c.store.listTransitions(k).length, before + 1, "одна строка closed-task-action");
  const [row] = reasonRows(c, k, "closed-task-action");
  assert.equal(row!.actor, "shadow:coordinator");
  assert.equal(row!.from_node, "none");
  assert.equal(row!.to_status, "none");
  assert.equal(JSON.parse(row!.payload ?? "{}").command, "approve");
});

test("§32.5.2: run-queue пишет shadow_eval поверх свежего payload — следование зеркала за время await не теряется", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
  await delegate(c, "SMK-34", "complex");
  await delegate(c, "SMK-35", "complex");
  let fired = false;
  c.hook.fn = () => {
    if (fired) return;
    const a = c.store.getTask("SMK-34");
    if (!a || !JSON.parse(a.payload ?? "{}").shadow_eval) return;
    // пока run-queue ждёт гейт по SMK-34, по SMK-35 пришёл итог ревью
    fired = true;
    const b = c.store.getTask("SMK-35")!;
    const p = JSON.parse(b.payload ?? "{}");
    p.mirror.last_verdict.review = "OK";
    c.store.updateTask("SMK-35", { payload: JSON.stringify(p) });
  };
  const rq = await cli(c, ["run-queue", "--once"], null);
  c.hook.fn = null;
  assert.equal(rq.exitCode, 0, rq.stdout);
  assert.ok(fired, "гейт run-queue ждал внешний вызов между задачами");
  const p = JSON.parse(c.store.getTask("SMK-35")!.payload ?? "{}");
  assert.ok(p.shadow_eval, "shadow_eval записан");
  assert.equal(p.mirror.last_verdict.review, "OK", "свежий payload.mirror не затёрт");
});

// ── регрессии ревью PLUG-398 (заход 2) и уточнение спеки r34.10 ─────────

test("§32.5.1 п. 6: ручной merge вне очереди — ровно одна строка task-not-enqueued; merge --dry-run — ни одной", async () => {
  const c = (await makeHost()) as Ctx;
  const k = "SMK-40";
  const id = outOfQueueDelegation(c, k);
  const dry = await cli(c, ["merge", k, "--dry-run"]);
  assert.equal(dry.exitCode, 0, dry.stdout);
  assert.equal(c.store.listTransitions(k).length, 0, "пробный запуск записей не создаёт");
  const res = await mergeCli(c, k);
  assert.equal(res.mergeStatus, "merged", JSON.stringify(res));
  const rows = c.store.listTransitions(k);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0]!.reason, "task-not-enqueued");
  const payload = JSON.parse(rows[0]!.payload ?? "{}");
  assert.equal(payload.command, "merge");
  assert.equal(payload.project_id, PROJECT);
  assert.equal(c.store.getTask(k), null, "merge вне очереди задачу не принимает");
  void id;
});

test("§32.5.4 п. 3: delegate по закрытой записи, задача открыта в трекере — переоткрытие shadow-reopen:delegate, счётчики и mirror сброшены, без класса", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
  const k = "SMK-41";
  const code = await delegate(c, k, "complex");
  finish(c, code);
  const rv = await delegate(c, k, "review");
  finish(c, rv, "CHANGES");
  assert.equal(c.store.getTask(k)!.code_review_rounds, 1);
  c.tracker.set(k, { status: "done" });
  await cli(c, ["run-queue", "--once"], null);
  assert.equal(c.store.getTask(k)!.status, "done");
  const classesBefore = verdicts(c, k).length;
  // доработка: в трекере задача снова открыта
  c.tracker.set(k, { status: "in_progress" });
  const again = await delegate(c, k, "medium");
  const t = c.store.getTask(k)!;
  assert.equal(t.node, "code");
  assert.equal(t.status, "running");
  assert.equal(t.code_review_rounds, 0, "счётчики кругов сброшены");
  const payload = JSON.parse(t.payload ?? "{}");
  assert.deepEqual(payload.mirror, { dispatched: true, last_verdict: {} }, "mirror сброшен");
  assert.equal(payload.adopted_delegation_id, again);
  const reopen = reasonRows(c, k, "shadow-reopen:delegate");
  assert.equal(reopen.length, 1);
  assert.equal(reopen[0]!.actor, "shadow:adopt");
  assert.equal(reopen[0]!.from_node, "none");
  assert.equal(verdicts(c, k).length, classesBefore, "класс вердикта не присваивается");
  assert.equal(reasonRows(c, k, "closed-task-action").length, 0);
  const rep = await cli(c, ["shadow-report", "--project", PROJECT, "--since", "2000-01-01T00:00:00Z"], null);
  const p = rep.body.projects.find((x: any) => x.projectId === PROJECT);
  assert.equal(p.reopened, 1);
  assert.equal(p.adopted, 1);
});

test("§32.5.4 п. 3: delegate по закрытой записи, задача закрыта в трекере — запись не меняется, одна строка closed-task-action, отдельный счётчик отчёта", async () => {
  const c = (await makeHost()) as Ctx;
  const k = "SMK-42";
  finish(c, await delegate(c, k, "medium"));
  c.tracker.set(k, { status: "done" });
  await cli(c, ["run-queue", "--once"], null);
  const closed = c.store.getTask(k)!;
  assert.equal(closed.status, "done");
  const before = c.store.listTransitions(k).length;
  const id = await delegate(c, k, "simple");
  const t = c.store.getTask(k)!;
  assert.deepEqual(
    { node: t.node, status: t.status, payload: t.payload, updated: t.updated_at },
    { node: closed.node, status: closed.status, payload: closed.payload, updated: closed.updated_at },
    "запись не меняется",
  );
  const rows = c.store.listTransitions(k).slice(before);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0]!.reason, "closed-task-action");
  assert.equal(rows[0]!.actor, "shadow:coordinator");
  assert.equal(rows[0]!.from_node, "none");
  assert.equal(rows[0]!.to_node, "none");
  const payload = JSON.parse(rows[0]!.payload ?? "{}");
  assert.equal(payload.command, "delegate");
  assert.equal(payload.delegation_id, id);
  const rep = await cli(c, ["shadow-report", "--project", PROJECT, "--since", "2000-01-01T00:00:00Z"], null);
  const p = rep.body.projects.find((x: any) => x.projectId === PROJECT);
  assert.equal(p.closedTaskActions, 1);
  assert.equal(p.closedActions[0].taskKey, k);
  assert.equal(p.closedActions[0].delegationId, id);
  assert.equal(p.manualActions, 1, "closed-task-action в долю готовности не входит");
  assert.equal(p.criteria.skipsReviewed, "manual");
});

test("§32.5.4 п. 3: merge и release по закрытой записи её не переоткрывают — по одной строке closed-task-action", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
  const k = "SMK-43";
  const code = await delegate(c, k, "complex");
  finish(c, code);
  recordRound(c, code, setupMergeCopies(c, k), k);
  c.tracker.set(k, { status: "done" });
  await cli(c, ["run-queue", "--once"], null);
  const closed = c.store.getTask(k)!;
  assert.equal(closed.status, "done");
  // в трекере задача снова открыта — merge/release всё равно не переоткрывают
  c.tracker.set(k, { status: "in_progress" });
  const before = c.store.listTransitions(k).length;
  const dry = await cli(c, ["merge", k, "--dry-run"]);
  assert.equal(dry.exitCode, 0, dry.stdout);
  assert.equal(c.store.listTransitions(k).length, before, "--dry-run — не действие");
  const m = await mergeCli(c, k);
  assert.equal(m.mergeStatus, "merged");
  const rel = await cli(c, ["release", k]);
  assert.notEqual(rel.exitCode, 0, "выкладка без конфигурации — отказ");
  const rows = c.store.listTransitions(k).slice(before);
  assert.deepEqual(
    rows.map((r) => [r.reason, JSON.parse(r.payload ?? "{}").command]),
    [
      ["closed-task-action", "merge"],
      ["closed-task-action", "release"],
    ],
  );
  assert.equal(JSON.parse(rows[0]!.payload ?? "{}").delegation_id, code);
  const t = c.store.getTask(k)!;
  assert.equal(t.status, "done");
  assert.equal(t.node, closed.node);
  assert.equal(t.release_attempts, closed.release_attempts);
});

test("§32.5.5 п. 1: shadow-report без метки стартовой сверки фиксирует её сейчас — история до выкладки §32.5 в отчёт не входит", async () => {
  const clock = { now: Date.parse("2026-11-24T00:00:00Z") };
  const c = (await makeHost({}, { clock })) as Ctx;
  // история: строка до выкладки §32.5
  c.store.insertTransition({
    taskKey: "OLD-1",
    fromNode: "none",
    toNode: "none",
    fromStatus: "none",
    toStatus: "none",
    actor: "shadow:coordinator",
    reason: "task-not-enqueued",
    payload: JSON.stringify({ command: "delegate", project_id: PROJECT }),
    createdAt: clock.now - 3600_000,
  });
  assert.equal(c.store.listEvents(SHADOW_RECONCILE_STARTED_EVENT).length, 0);
  const rep = await cli(c, ["shadow-report"], null);
  assert.equal(rep.exitCode, 0, rep.stdout);
  assert.equal(rep.body.since, clock.now, "since — метка, а не 0");
  assert.equal(c.store.listEvents(SHADOW_RECONCILE_STARTED_EVENT).length, 1);
  assert.equal(
    rep.body.projects.reduce((n: number, p: any) => n + p.taskNotEnqueued, 0),
    0,
    "строка до метки не считается",
  );
});

test("§32.5.4 п. 2: run-queue проверяет в трекере оцениваемые записи без пропуска по интервалу", async () => {
  const c = (await makeHost()) as Ctx;
  const k = "SMK-44";
  c.store.insertTask({
    taskKey: k,
    projectId: PROJECT,
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });
  const t0 = Date.now();
  // проход reconcile только что проверил запись (трекер тогда был открыт)
  const lastChecked = new Map<string, number>([[k, t0]]);
  const asked: string[] = [];
  await runRunQueue({
    store: c.store,
    workGraphMode: "off",
    workGraphProjects: { [PROJECT]: "shadow" },
    getWorkGraphMode: (pid?: string | null) => (pid === PROJECT ? "shadow" : "off"),
    maxActiveTasks: 1,
    now: () => t0 + 1000,
    cmd: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as any,
    getTrackerStatus: async (key: string) => {
      asked.push(key);
      return "done";
    },
    trackerSyncMinIntervalMs: 60_000,
    trackerSyncLastChecked: lastChecked,
  } as any);
  assert.deepEqual(asked, [k], "оцениваемая запись проверена, несмотря на интервал");
  const t = c.store.getTask(k)!;
  assert.equal(t.status, "done");
  assert.equal(JSON.parse(t.payload ?? "{}").shadow_eval?.would_transition, undefined);
});

test("§32.6 п. 5: reverseReviewLevel chooses senior level on multiple matches", () => {
  // complex > high > medium > simple
  const polAll = {
    version: 1,
    reviewByLevel: {
      complex: "review",
      high: "review",
      medium: "review",
      simple: "review",
    },
  };
  assert.equal(reverseReviewLevel("review", polAll as any), "complex");

  const polHigh = {
    version: 1,
    reviewByLevel: {
      high: "review",
      medium: "review",
      simple: "review",
    },
  };
  assert.equal(reverseReviewLevel("review", polHigh as any), "high");

  const polMedium = {
    version: 1,
    reviewByLevel: {
      medium: "review",
      simple: "review",
    },
  };
  assert.equal(reverseReviewLevel("review", polMedium as any), "medium");

  const polSimple = {
    version: 1,
    reviewByLevel: {
      simple: "review",
    },
  };
  assert.equal(reverseReviewLevel("review", polSimple as any), "simple");

  assert.equal(reverseReviewLevel("unknown-review", polAll as any), null);
});

test("§32.6 п. 5: adopt §32.5.1 of high level delegation creates task_queue entry without CHECK error", async () => {
  const policyWithHigh = {
    ...POLICY,
    levels: {
      ...POLICY.levels,
      high: { chain: ["r"] },
    },
    reviewByLevel: {
      ...POLICY.reviewByLevel,
      high: "review",
    },
  };
  const c = (await makeHost({ policy: JSON.stringify(policyWithHigh) })) as Ctx;
  const k = "SMK-45";
  const id = await delegate(c, k, "high");
  assert.ok(id > 0);
  const task = c.store.getTask(k);
  assert.ok(task, "задача принята в очередь");
  assert.equal(task.level, "high", "level = high без ошибки CHECK");
  assert.equal(task.route, "feature");
  assert.equal(task.node, "code");
  assert.equal(task.status, "running");
});
