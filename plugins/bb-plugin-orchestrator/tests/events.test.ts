/**
 * PLUG-246: хуки событий (§18.5) — таблица events в той же транзакции,
 * что и переход; таблица переходов → события v1; сопоставление с
 * хуками в момент события (queued в command_runs); JSON v1 в stdin +
 * ORCH_*; notifyOnFail — одна строка на серию сбоев; доверие по
 * снимку с eventHooks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  DelegationStore,
  MIGRATIONS,
  type DelegationRow,
} from "../src/store.js";
import {
  onHookRunFinished,
  parseEventHooks,
  type EventHookSetting,
} from "../src/events.js";
import {
  checkExecSettings,
  execSettingsFingerprint,
} from "../src/trust.js";
import { parseReleaseConfig } from "../src/release-config.js";

function makeStore(hooks: EventHookSetting[] = []) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.eventHooksProvider = () => ({ hooks, cwd: "/tmp/hooks" });
  return { db, store };
}

const insertDelegation = (store: DelegationStore, over = {}) =>
  store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_a",
    coordinatorThreadId: "thr_c",
    level: "simple",
    route: "r",
    preset: "r",
    provider: "p",
    ...over,
  });

const running = (store: DelegationStore, over = {}): DelegationRow => {
  const d = insertDelegation(store, over);
  store.setStatus(d.id, "running");
  store.setThreadInfo(d.id, "thr_w");
  return store.get(d.id)!;
};

const hook = (over: Partial<EventHookSetting> = {}): EventHookSetting => ({
  name: "h1",
  on: ["delegation.done"],
  run: ["/bin/echo", "hi"],
  ...over,
});

const runPayload = (s: string | null) =>
  JSON.parse(s ?? "{}") as Record<string, unknown>;

test("§18.5: переход → событие и queued хук в той же записи (JSON v1 + ORCH_*)", () => {
  const { store } = makeStore([hook({ notifyOnFail: true })]);
  const d = running(store);
  assert.ok(store.setStatusIf(d.id, "running", "done"));

  const events = store.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "delegation.done");
  const doc = runPayload(events[0].payload);
  assert.equal(doc.version, 1);
  assert.equal(doc.event, "delegation.done");
  assert.equal(doc.task, "PLUG-1");
  assert.equal(doc.project, "proj_a");
  assert.equal(doc.coordinatorThreadId, "thr_c");
  assert.equal(doc.delegationId, d.id);
  assert.equal(doc.level, "simple");
  assert.equal(doc.route, "r");
  assert.equal(doc.threadId, "thr_w");
  assert.equal(typeof doc.at, "number");

  const runs = store.queuedCommandRuns();
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.source, "hook");
  assert.equal(r.run_key, `event:${events[0].id}:h1`);
  assert.equal(r.name, "h1");
  assert.equal(r.status, "queued");
  assert.deepEqual(JSON.parse(r.argv!), ["/bin/echo", "hi"]);
  assert.equal(r.cwd, "/tmp/hooks");
  assert.equal(r.timeout_sec, 120, "дефолтный срок хука — 120");
  assert.equal(r.notify_on_fail, 1);
  const env = JSON.parse(r.env!);
  assert.equal(env.ORCH_EVENT, "delegation.done");
  assert.equal(env.ORCH_TASK, "PLUG-1");
  assert.equal(env.ORCH_PROJECT, "proj_a");
  // stdin — тот же документ события v1
  assert.deepEqual(runPayload(r.stdin), doc);
});

test("§18.5: два хука на одно событие — оба queued", () => {
  const { store } = makeStore([
    hook({ name: "first" }),
    hook({ name: "second", timeoutSec: 30 }),
  ]);
  const d = running(store);
  store.setStatusIf(d.id, "running", "done");
  const runs = store.queuedCommandRuns();
  assert.equal(runs.length, 2);
  const ev = store.listEvents()[0];
  assert.deepEqual(
    runs.map((r) => r.run_key),
    [`event:${ev.id}:first`, `event:${ev.id}:second`],
  );
  assert.equal(runs[1].timeout_sec, 30);
});

test("§18.5: хук, добавленный после события, по нему не запускается", () => {
  const { store } = makeStore([]);
  const d = running(store);
  store.setStatusIf(d.id, "running", "done");
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.queuedCommandRuns().length, 0);
  // хук появился ПОСЛЕ события — старое событие не сопоставляется
  store.eventHooksProvider = () => ({
    hooks: [hook()],
    cwd: "/tmp/hooks",
  });
  assert.equal(store.queuedCommandRuns().length, 0);
  // а новое событие — сопоставляется
  const d2 = running(store);
  store.setStatus(d2.id, "failed");
  assert.equal(store.queuedCommandRuns().length, 0, "on фильтрует вид");
  store.eventHooksProvider = () => ({
    hooks: [hook({ on: ["delegation.failed"] })],
    cwd: "/tmp/hooks",
  });
  const d3 = running(store);
  store.setStatus(d3.id, "failed");
  assert.equal(store.queuedCommandRuns().length, 1);
});

test("§18.5: старые записи после миграции — тишина", () => {
  const db = new Database(":memory:");
  // «старая» база: все миграции до PLUG-246 (3 последних — events,
  // verdict_event_at, notify_on_fail)
  for (const m of MIGRATIONS.slice(0, -3)) db.exec(m);
  const past = Date.now() - 86_400_000;
  db.prepare(
    `INSERT INTO delegations (
      task_key, coordinator_thread_id, level, route, preset, provider,
      status, round, explicit_route, no_code, resume_count, retry_count,
      revived_count, created_at, updated_at
    ) VALUES ('PLUG-1','thr_c','simple','r','r','p','done',1,0,0,0,0,0,?,?)`,
  ).run(past, past);
  db.prepare(
    `INSERT INTO releases (
      task_key, project_id, coordinator_thread_id, repo_path, branch,
      target_action, target_branch, status, pr_error_count,
      created_at, updated_at
    ) VALUES ('PLUG-1','p','thr_c','/r','b','push','main','published',0,?,?)`,
  ).run(past, past);
  // миграция PLUG-246 — история событий не порождает
  for (const m of MIGRATIONS.slice(-3)) db.exec(m);
  const store = new DelegationStore(db);
  assert.equal(store.listEvents().length, 0);
  assert.equal(store.queuedCommandRuns().length, 0);
});

test("§18.5: таблица переходов — failed/stalled/quota, cancelled и reissued молчат", () => {
  const { store } = makeStore([
    hook({ on: ["delegation.failed", "delegation.stalled"] }),
  ]);
  const d1 = running(store);
  store.setStatus(d1.id, "failed");
  const d2 = running(store);
  store.setStatus(d2.id, "stalled");
  const d3 = running(store);
  store.setStatus(d3.id, "quota");
  assert.deepEqual(
    store.listEvents().map((e) => e.kind),
    ["delegation.failed", "delegation.stalled", "delegation.stalled"],
  );
  assert.deepEqual(
    store.listEvents("delegation.stalled").map(
      (e) => runPayload(e.payload).reason,
    ),
    ["stalled", "quota"],
  );
  assert.equal(store.queuedCommandRuns().length, 3);
  // cancelled — внутреннее, событий нет
  const d4 = running(store);
  store.setStatus(d4.id, "cancelled");
  // reissued — внутреннее, событий нет
  const d5 = running(store);
  store.setStatus(d5.id, "stalled"); // даст ещё delegation.stalled
  store.reissue(d5.id, { route: "r", preset: "r", provider: "p" });
  const kinds = store.listEvents().map((e) => e.kind);
  assert.equal(
    kinds.filter((k) => k === "delegation.stalled").length,
    3,
    "reissue новых событий не дал",
  );
  assert.equal(
    kinds.filter((k) => k === "delegation.cancelled").length,
    0,
  );
});

test("§18.5: оживший тред — повторный delegation.done с новым id события", () => {
  const { store } = makeStore([hook()]);
  const d = running(store);
  store.setStatusIf(d.id, "running", "done");
  assert.ok(store.revive(d.id), "revive: done → running");
  assert.ok(store.setStatusIf(d.id, "running", "done"));
  const events = store.listEvents("delegation.done");
  assert.equal(events.length, 2);
  assert.notEqual(events[0].id, events[1].id);
  assert.equal(runPayload(events[1].payload).delegationId, d.id);
  // оба запуска хука — с разными ключами
  assert.equal(store.queuedCommandRuns().length, 2);
});

test("§18.5: release-audit не порождает delegation.done", () => {
  const { store } = makeStore([hook()]);
  const d = running(store, { level: "release-audit" });
  store.setStatusIf(d.id, "running", "done");
  assert.equal(store.listEvents().length, 0);
  assert.equal(store.queuedCommandRuns().length, 0);
});

test("§18.5: review.verdict — один раз на делегирование, с вердиктом", () => {
  const { store } = makeStore([
    hook({ on: ["review.verdict", "delegation.done"] }),
  ]);
  const d = running(store, { level: "review" });
  store.setStatusIf(d.id, "running", "done", {
    reviewVerdict: { verdict: "CHANGES", blockers: 2 },
  });
  const verdicts = store.listEvents("review.verdict");
  assert.equal(verdicts.length, 1);
  const doc = runPayload(verdicts[0].payload);
  assert.equal(doc.verdict, "CHANGES");
  assert.equal(doc.blockers, 2);
  assert.equal(doc.delegationId, d.id);
  assert.equal(store.get(d.id)!.verdict_event_at != null, true);
  // delegation.done пришёл вместе с ним
  assert.equal(store.listEvents("delegation.done").length, 1);
  // оживление → снова done: delegation.done повторяется, review.verdict — нет
  assert.ok(store.revive(d.id));
  store.setStatusIf(d.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  });
  assert.equal(store.listEvents("review.verdict").length, 1);
  assert.equal(store.listEvents("delegation.done").length, 2);
});

test("§18.5: события выкладки — published/rejected/failed, проект settings_project_id", () => {
  const { store } = makeStore([
    hook({ on: ["release.published", "release.rejected", "release.failed"] }),
  ]);
  const insert = (task: string) =>
    store.insertRelease({
      taskKey: task,
      projectId: "proj_repo",
      coordinatorThreadId: "thr_c",
      repoPath: "/r",
      branch: "bb/feat",
      targetAction: "pr",
      targetBranch: "dev",
      settingsProjectId: "proj_a",
    });
  const r1 = insert("PLUG-1");
  store.updateRelease(r1.id, {
    publishedSha: "abc123",
    publishBranch: "release/abc123",
    prUrl: "https://example.com/pr/1",
    status: "published",
  });
  const r2 = insert("PLUG-2");
  store.transitionReleaseStatus(r2.id, ["auditing"], "rejected", "проверки");
  const r3 = insert("PLUG-3");
  // промежуточный publishing — без события
  store.updateRelease(r3.id, { status: "publishing" });
  store.transitionReleaseStatus(r3.id, ["publishing"], "failed", "push упал");
  const r4 = insert("PLUG-4");
  store.updateRelease(r4.id, { status: "publishing" });

  const kinds = store.listEvents().map((e) => e.kind);
  assert.deepEqual(kinds, [
    "release.published",
    "release.rejected",
    "release.failed",
  ]);
  const doc = runPayload(store.listEvents("release.published")[0].payload);
  assert.equal(doc.project, "proj_a", "settings_project_id, не repo project");
  assert.equal(doc.releaseId, r1.id);
  assert.equal(doc.sha, "abc123");
  assert.equal(doc.branch, "release/abc123");
  assert.equal(doc.target, "dev");
  assert.equal(doc.prUrl, "https://example.com/pr/1");
  assert.equal(doc.task, "PLUG-1");
  assert.equal(store.queuedCommandRuns().length, 3);
});

test("§18.5: события PR — merged/closed; open/merging/superseded молчат", () => {
  const { store } = makeStore([hook({ on: ["pr.merged", "pr.closed"] })]);
  const r = store.insertRelease({
    taskKey: "PLUG-1",
    projectId: "p",
    coordinatorThreadId: "thr_c",
    repoPath: "/r",
    branch: "b",
    targetAction: "pr",
    targetBranch: "dev",
  });
  store.updateRelease(r.id, {
    status: "published",
    prUrl: "https://example.com/pr/9",
  });
  store.initPrTracking(r.id);
  assert.equal(store.listEvents().length, 1, "published — одно событие");
  assert.equal(store.transitionPrState(r.id, ["open"], "merging"), true);
  assert.equal(store.transitionPrState(r.id, ["merging"], "merged"), true);
  const kinds = store.listEvents().map((e) => e.kind);
  assert.deepEqual(kinds, ["release.published", "pr.merged"]);
  const doc = runPayload(store.listEvents("pr.merged")[0].payload);
  assert.equal(doc.prUrl, "https://example.com/pr/9");
  // closed — событие; superseded/error/closed_final — нет
  const r2 = store.insertRelease({
    taskKey: "PLUG-2",
    projectId: "p",
    coordinatorThreadId: "thr_c",
    repoPath: "/r",
    branch: "b",
    targetAction: "pr",
    targetBranch: "dev",
  });
  store.updateRelease(r2.id, {
    status: "published",
    prUrl: "https://example.com/pr/10",
  });
  store.initPrTracking(r2.id);
  store.transitionPrState(r2.id, ["open"], "closed");
  store.transitionPrState(r2.id, ["closed"], "closed_final");
  assert.deepEqual(
    store.listEvents().map((e) => e.kind),
    [
      "release.published",
      "pr.merged",
      "release.published",
      "pr.closed",
    ],
    "closed_final — внутреннее состояние, события нет",
  );
});

test("§18.5: projects хука фильтрует по проекту события", () => {
  const { store } = makeStore([
    hook({ name: "all" }),
    hook({ name: "only-a", projects: ["proj_a"] }),
  ]);
  const a = running(store, { projectId: "proj_a" });
  store.setStatusIf(a.id, "running", "done");
  const b = running(store, { projectId: "proj_b" });
  store.setStatusIf(b.id, "running", "done");
  const noProj = running(store, { projectId: undefined });
  store.setStatusIf(noProj.id, "running", "done");
  const names = store.queuedCommandRuns().map((r) => `${r.run_key}`);
  assert.equal(names.length, 4, "a:2 + b:1 + null:1");
  const evById = (i: number) => store.listEvents()[i].id;
  assert.ok(names.includes(`event:${evById(0)}:all`));
  assert.ok(names.includes(`event:${evById(0)}:only-a`));
  assert.ok(names.includes(`event:${evById(1)}:all`));
  assert.ok(!names.includes(`event:${evById(1)}:only-a`));
  assert.ok(names.includes(`event:${evById(2)}:all`));
  assert.ok(!names.includes(`event:${evById(2)}:only-a`));
});

test("§18.5: notifyOnFail — одна строка на серию сбоев, снимается успехом", async () => {
  const { store } = makeStore();
  const sends: string[] = [];
  const deps = {
    store,
    send: async (t: string, text: string) => {
      sends.push(`${t}|${text}`);
    },
  };
  const mkRun = (name: string, notify: boolean, coordinator = "thr_c") =>
    store.enqueueCommandRun(
      {
        source: "hook",
        runKey: `event:1:${name}:${Math.random()}`,
        name,
        argv: ["x"],
        cwd: "/tmp",
        stdin: JSON.stringify({
          version: 1,
          event: "delegation.done",
          coordinatorThreadId: coordinator,
        }),
        notifyOnFail: notify,
      },
      Date.now(),
    );
  // notifyOnFail=false — молча
  const quiet = mkRun("quiet", false);
  onHookRunFinished(deps, quiet, "failed", "boom");
  assert.equal(sends.length, 0);
  // первая неудача с флагом — строка
  const fail1 = mkRun("chatty", true);
  onHookRunFinished(deps, fail1, "failed", "exit 1: broken");
  assert.equal(sends.length, 1);
  assert.match(sends[0], /^thr_c\|хук chatty на delegation\.done упал: /);
  // серия — вторая неудача молчит
  const fail2 = mkRun("chatty", true);
  onHookRunFinished(deps, fail2, "timeout", "t/o");
  assert.equal(sends.length, 1, "серия — одна строка");
  // успех снимает серию — следующая неудача снова пишет
  const ok1 = mkRun("chatty", true);
  onHookRunFinished(deps, ok1, "ok", "");
  const fail3 = mkRun("chatty", true);
  onHookRunFinished(deps, fail3, "failed", "again");
  assert.equal(sends.length, 2);
  // чужой source — не реагирует
  const pp = store.enqueueCommandRun(
    {
      source: "postPublish",
      runKey: "pp:1:x",
      name: "deploy",
      argv: ["x"],
      cwd: "/tmp",
    },
    Date.now(),
  );
  onHookRunFinished(deps, pp, "failed", "x");
  assert.equal(sends.length, 2);
});

test("§18.5: срок хранения events = retentionDays", () => {
  const { db, store } = makeStore();
  const past = Date.now() - 31 * 86_400_000;
  db.prepare(
    `INSERT INTO events (kind, payload, created_at) VALUES ('x','{}',?)`,
  ).run(past);
  const d = running(store);
  store.setStatusIf(d.id, "running", "done");
  assert.equal(store.listEvents().length, 2);
  assert.equal(store.pruneEvents(Date.now() - 30 * 86_400_000), 1);
  assert.equal(store.listEvents().length, 1);
});

test("§18.5: доверие — eventHooks в снимке исполняемых настроек", async () => {
  const { store } = makeStore();
  const sends: string[] = [];
  const cfg = parseReleaseConfig(
    JSON.stringify({ defaults: {} }),
  ).config!;
  const h1 = [hook({ name: "chat" })];
  // первый снимок — молча
  let changes = await checkExecSettings({
    store,
    cfg,
    hooks: h1,
    send: async () => {},
  });
  assert.equal(changes.length, 0);
  // изменение хука — расхождение
  const del = running(store);
  void del;
  const h2 = [hook({ name: "chat", run: ["/bin/evil"] })];
  changes = await checkExecSettings({
    store,
    cfg,
    hooks: h2,
    send: async (t, text) => {
      sends.push(`${t}:${text}`);
    },
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, "plugin:eventHooks:chat");
  assert.ok(sends.some((x) => /изменены исполняемые настройки/.test(x)));
  // значения argv не печатаются
  const fp = execSettingsFingerprint(cfg, h2);
  assert.ok(!JSON.stringify(fp).includes("evil"));
  assert.equal(fp["plugin:eventHooks:chat"].length, 16);
});

test("§18.5: parseEventHooks — разбор и ошибки", () => {
  assert.deepEqual(parseEventHooks(""), { hooks: [], errors: [] });
  assert.deepEqual(parseEventHooks(undefined), { hooks: [], errors: [] });
  const good = parseEventHooks(
    JSON.stringify([
      {
        name: "h",
        on: ["delegation.done"],
        run: ["/bin/x"],
        projects: ["proj_a"],
        timeoutSec: 60,
        notifyOnFail: true,
      },
    ]),
  );
  assert.equal(good.errors.length, 0);
  assert.equal(good.hooks.length, 1);
  assert.deepEqual(good.hooks[0].projects, ["proj_a"]);
  const bad = parseEventHooks("не json");
  assert.equal(bad.hooks.length, 0);
  assert.ok(bad.errors.length > 0);
  const notArr = parseEventHooks("{}");
  assert.ok(notArr.errors.length > 0);
  const badFields = parseEventHooks(
    JSON.stringify([
      { name: "x", on: [], run: ["a"] },
      { name: "y", on: ["e"], run: "не массив" },
      { name: "z", on: ["e"], run: ["a"], timeoutSec: 0 },
    ]),
  );
  assert.equal(badFields.hooks.length, 0);
  assert.equal(badFields.errors.length, 3);
});
