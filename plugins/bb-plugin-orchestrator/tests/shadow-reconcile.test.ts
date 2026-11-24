/**
 * §32.5.8 (PLUG-398, ADR-0041): наблюдатель-сверка shadow через настоящие
 * входы плагина (§19.7): CLI `delegate`/`approve`/`run-queue`/`shadow-report`,
 * итог ревью — штатный переход делегирования в done с вердиктом (событие
 * review.verdict), публикация — штатная запись выкладки (release.published).
 */
import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import { DelegationStore, type TaskTransitionRow } from "../src/store.js";
import { createPlugin } from "../server.js";
import { makeTempDir } from "./helpers/temp.js";
import {
  shadowObserveMerge,
  buildShadowReport,
  matrixEdges,
} from "../src/shadow-reconcile.js";
import {
  parseWorkGraphProjects,
  rewriteWorkGraphProjects,
  OFF_OVERRIDE_MAX_MS,
} from "../src/workgraph-mode.js";

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

function fakeCli(tracker: Map<string, TrackerTask>): { cli: BbCli; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    cli: {
      run: async (args) => {
        calls.push(args);
        const key = args.join(" ");
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
}

async function makeHost(
  settings: Record<string, string | boolean> = {},
  opts: { clock?: { now: number } } = {},
) {
  const tracker = new Map<string, TrackerTask>();
  const { cli } = fakeCli(tracker);
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
        get: async () => ({
          id: "thr_coord",
          parentThreadId: null,
          title: "coordinator",
          titleFallback: null,
          originPluginId: null,
          projectId: PROJECT,
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
    ...(clock ? { now: () => clock.now } : {}),
  });
  const store = new DelegationStore(host.bb.storage.database());
  return { host, store, tracker, sent, clock: clock ?? { now: Date.now() } };
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
  const rv = await delegate(c, key, "review");
  finish(c, rv, "OK");
  if (manual) await approve(c, key);
  shadowObserveMerge(c.store, {
    taskKey: key,
    projectId: PROJECT,
    delegationId: code,
    mode: "shadow",
    policy: POLICY as any,
  });
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
  const rv = await delegate(c, "SMK-5", "review");
  finish(c, rv, "OK");
  shadowObserveMerge(c.store, { taskKey: "SMK-5", projectId: PROJECT, delegationId: code, mode: "shadow" });
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

  // обрезка off до 24 ч
  const rw = rewriteWorkGraphProjects(
    JSON.stringify({ [PROJECT]: { mode: "off", until: new Date(clock.now + 48 * 3600_000).toISOString() } }),
    { now: clock.now },
  )!;
  assert.deepEqual(rw.capped, [PROJECT]);
  assert.equal(Date.parse(JSON.parse(rw.value)[PROJECT].until), clock.now + OFF_OVERRIDE_MAX_MS);
});

// ── 6. Отчёт ────────────────────────────────────────────────────────────

test("§32.5.8 6: shadow-report --json на фикстуре — точные числа по классам и список skip", async () => {
  const c = (await makeHost({ approvalMode: "auto" })) as Ctx;
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
  // вне очереди merge без проекта → task-not-enqueued
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
  assert.equal(p.manualActions, 9);
  assert.equal(p.taskNotEnqueued, 0);
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
  const sr = await delegate(c, "OFF-1", "review", ["--kind", "spec_review"]);
  finish(c, sr, "OK");
  const rv = await delegate(c, "OFF-1", "review");
  finish(c, rv, "CHANGES");
  shadowObserveMerge(c.store, { taskKey: "OFF-1", projectId: PROJECT, mode: "off" });
  publish(c, "OFF-1");
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
