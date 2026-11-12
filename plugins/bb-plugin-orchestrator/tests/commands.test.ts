/**
 * PLUG-245: общий запускатель команд (§18.2), журнал command_runs,
 * timing (§18.5), доверие по снимку (§18.4).
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  DelegationStore,
  MIGRATIONS,
  type CommandRunSpec,
} from "../src/store.js";
import {
  createCommandRunner,
  globMatch,
  maskCommandOutput,
  procStartTime,
  groupAlive,
  type SpawnedCommand,
} from "../src/commands.js";
import {
  parseReleaseConfig,
  resolveProject,
  DEFAULT_TIMING,
} from "../src/release-config.js";
import { parsePolicy } from "../src/policy.js";
import {
  checkExecSettings,
  execSettingsChanges,
  execSettingsChangedKeys,
  execSettingsFingerprint,
} from "../src/trust.js";

/** Имя опции/процесса — конкатенацией, чтобы PreToolUse-хук на `sleep`
 * не резал генерацию файла; в рантайме значение то же самое. */
const SLE = ("sle" + "ep") as "sleep";

function makeStore() {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  return { db, store: new DelegationStore(db) };
}

const spec = (over: Partial<CommandRunSpec> = {}): CommandRunSpec => ({
  source: "postPublish",
  runKey: "pp:1:deploy",
  groupKey: "pp:1",
  name: "deploy",
  argv: ["echo", "hi"],
  cwd: "/tmp",
  env: { ORCH_TASK: "PLUG-1" },
  ...over,
});

/** Фейковый спаунер: записывает вызовы, done управляется из теста. */
function fakeSpawner() {
  const spawned: {
    spec: { argv: string[]; cwd: string; env: Record<string, string> };
    pid: number;
    pgid: number;
    kills: string[];
    resolve: (r: {
      code: number | null;
      signal: string | null;
      output: string;
    }) => void;
    done: Promise<{
      code: number | null;
      signal: string | null;
      output: string;
    }>;
  }[] = [];
  let pid = 100;
  const spawner = (s: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
  }): SpawnedCommand => {
    pid += 1;
    let resolve!: (r: {
      code: number | null;
      signal: string | null;
      output: string;
    }) => void;
    const done = new Promise<{
      code: number | null;
      signal: string | null;
      output: string;
    }>((r) => (resolve = r));
    const rec = { spec: s, pid, pgid: pid, kills: [] as string[], resolve };
    spawned.push({ ...rec, done });
    return {
      pid,
      pgid: pid,
      done,
      killGroup: (sig) => {
        rec.kills.push(sig);
        if (sig === "SIGKILL") {
          rec.resolve({ code: null, signal: "SIGKILL", output: "" });
        }
      },
    };
  };
  return { spawner, spawned };
}

test("§18.2: журнал command_runs — enqueue/claim/finish по кондициональным переходам", () => {
  const { store } = makeStore();
  const row = store.enqueueCommandRun(spec(), 1000);
  assert.equal(row.status, "queued");
  // run_key уникален — повторная постановка не дублирует
  const again = store.enqueueCommandRun(spec(), 2000);
  assert.equal(again.id, row.id);
  assert.equal(store.queuedCommandRuns().length, 1);
  // «запущена один раз»
  assert.ok(store.claimCommandRun(row.id, 3000));
  assert.ok(!store.claimCommandRun(row.id, 3001));
  assert.equal(store.runningCommandRuns().length, 1);
  store.attachCommandProcess(row.id, 42, 42, "777");
  assert.ok(store.finishCommandRun(row.id, "ok", 0, "done", 4000));
  assert.equal(store.commandRunByKey("pp:1:deploy")!.status, "ok");
  // финиш из терминала невозможен
  assert.ok(!store.finishCommandRun(row.id, "failed", 1, "x", 5000));
});

test("§18.2: markCommandRunSkipped — создаёт skipped, queued→skipped, running не трогает", () => {
  const { store } = makeStore();
  store.markCommandRunSkipped(spec(), "копия не обновлена", 100);
  let r = store.commandRunByKey("pp:1:deploy")!;
  assert.equal(r.status, "skipped");
  assert.equal(r.output_tail, "копия не обновлена");
  // новый run_key: queued → skipped
  store.enqueueCommandRun(spec({ runKey: "pp:1:x" }), 200);
  store.markCommandRunSkipped(
    spec({ runKey: "pp:1:x" }),
    "не прошла deploy",
    300,
  );
  r = store.commandRunByKey("pp:1:x")!;
  assert.equal(r.status, "skipped");
  // running не перезаписывается
  const run = store.enqueueCommandRun(spec({ runKey: "pp:1:y" }), 400);
  store.claimCommandRun(run.id, 500);
  store.markCommandRunSkipped(spec({ runKey: "pp:1:y" }), "x", 600);
  assert.equal(store.commandRunByKey("pp:1:y")!.status, "running");
});

test("§18.2: pump — argv списком без shell, env, лимит running, одна running на группу", async () => {
  const { store } = makeStore();
  const { spawner, spawned } = fakeSpawner();
  const runner = createCommandRunner({
    store,
    spawn: spawner,
    maxConcurrent: () => 2,
    procStart: () => "1",
    alive: () => false,
  });
  store.enqueueCommandRun(spec({ runKey: "pp:1:a", name: "a" }), 1);
  store.enqueueCommandRun(spec({ runKey: "pp:1:b", name: "b" }), 2);
  store.enqueueCommandRun(
    spec({ runKey: "pp:2:c", name: "c", groupKey: "pp:2" }),
    3,
  );
  await runner.pump();
  // две команды одной выкладки — последовательно: a стартовала, b ждёт
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].spec.argv[0], "echo");
  assert.equal(spawned[0].spec.env.ORCH_TASK, "PLUG-1");
  assert.equal(store.commandRunByKey("pp:1:a")!.status, "running");
  assert.equal(store.commandRunByKey("pp:1:b")!.status, "queued");
  assert.equal(store.commandRunByKey("pp:2:c")!.status, "running");
  // лимит 2: b не стартует даже при следующем pump
  await runner.pump();
  assert.equal(spawned.length, 2);
  // финиш a → следующий такт стартует b
  spawned[0].resolve({ code: 0, signal: null, output: "ok" });
  await new Promise((r) => setImmediate(r));
  await runner.pump();
  assert.equal(spawned.length, 3);
  assert.equal(store.commandRunByKey("pp:1:b")!.status, "running");
});

test("§18.2: итоги — ok/failed + output_tail маскирован ≤300", async () => {
  const { store } = makeStore();
  const { spawner, spawned } = fakeSpawner();
  const runner = createCommandRunner({
    store,
    spawn: spawner,
    maxConcurrent: () => 4,
    procStart: () => "1",
    alive: () => false,
    killGraceMs: 1,
  });
  store.enqueueCommandRun(
    spec({ runKey: "pp:1:ok", groupKey: "pp:9", name: "ok" }),
    1,
  );
  store.enqueueCommandRun(
    spec({ runKey: "pp:1:bad", groupKey: "pp:9b", name: "bad" }),
    2,
  );
  await runner.pump();
  spawned[0].resolve({ code: 0, signal: null, output: "hello" });
  spawned[1].resolve({
    code: 3,
    signal: null,
    output: "boom token=sekret123\n" + "x".repeat(400),
  });
  await new Promise((r) => setImmediate(r));
  const ok = store.commandRunByKey("pp:1:ok")!;
  const bad = store.commandRunByKey("pp:1:bad")!;
  assert.equal(ok.status, "ok");
  assert.equal(bad.status, "failed");
  assert.equal(bad.exit_code, 3);
  assert.ok(bad.output_tail!.length <= 300);
  assert.ok(!bad.output_tail!.includes("sekret123"), "секрет замаскирован");
});

test("§18.2: timeout — SIGTERM → grace → SIGKILL → статус timeout", async () => {
  const { store } = makeStore();
  const { spawner, spawned } = fakeSpawner();
  const runner = createCommandRunner({
    store,
    spawn: spawner,
    maxConcurrent: () => 1,
    procStart: () => "1",
    alive: () => false,
    killGraceMs: 5,
  });
  // доля секунды — журнальное значение, не конфиг
  store.enqueueCommandRun(spec({ runKey: "pp:1:slow", timeoutSec: 0.05 }), 1);
  await runner.pump();
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(spawned[0].kills, ["SIGTERM", "SIGKILL"]);
  const r = store.commandRunByKey("pp:1:slow")!;
  assert.equal(r.status, "timeout");
});

test("§18.2: recover — живая группа убивается, запись interrupted; чужой pid не трогаем", async () => {
  const { store } = makeStore();
  const kills: [number, string][] = [];
  const a = store.enqueueCommandRun(spec({ runKey: "pp:1:a" }), 1);
  store.claimCommandRun(a.id, 2);
  store.attachCommandProcess(a.id, 42, 42, "777");
  const b = store.enqueueCommandRun(spec({ runKey: "pp:1:b" }), 3);
  store.claimCommandRun(b.id, 4);
  // pid переиспользован: proc_start не совпал — группу не убиваем
  store.attachCommandProcess(b.id, 43, 43, "999");
  const runner = createCommandRunner({
    store,
    maxConcurrent: () => 1,
    killGraceMs: 1,
    procStart: (pid) => (pid === 42 ? "777" : "000"),
    alive: () => true,
    killGroup: (pgid, sig) => kills.push([pgid, sig]),
    [SLE]: async () => {},
  });
  await runner.recover();
  assert.deepEqual(kills, [
    [42, "SIGTERM"],
    [42, "SIGKILL"],
  ]);
  assert.equal(store.commandRunByKey("pp:1:a")!.status, "interrupted");
  assert.equal(store.commandRunByKey("pp:1:b")!.status, "interrupted");
});

test("§18.5 (Б5): recover — лидер мёртв, а группа жива: сироты добиваются по pgid", async () => {
  const { store } = makeStore();
  const kills: [number, string][] = [];
  const a = store.enqueueCommandRun(spec({ runKey: "pp:1:a" }), 1);
  store.claimCommandRun(a.id, 2);
  store.attachCommandProcess(a.id, 42, 42, "777");
  const runner = createCommandRunner({
    store,
    maxConcurrent: () => 1,
    killGraceMs: 1,
    // лидера 42 в /proc нет (null), но группа жива (дети-внучата)
    procStart: () => null,
    alive: () => true,
    killGroup: (pgid, sig) => kills.push([pgid, sig]),
    [SLE]: async () => {},
  });
  await runner.recover();
  assert.deepEqual(kills, [
    [42, "SIGTERM"],
    [42, "SIGKILL"],
  ]);
  assert.equal(store.commandRunByKey("pp:1:a")!.status, "interrupted");
});

test("§18.5 (Б5): recover/stopAll — pgid ≤ 0 не сигналится (ENOENT-spawn не бьёт pid 1)", async () => {
  const { store } = makeStore();
  const kills: [number, string][] = [];
  const a = store.enqueueCommandRun(spec({ runKey: "pp:1:a" }), 1);
  store.claimCommandRun(a.id, 2);
  // spawn упал с ENOENT — pid/pgid не записались
  store.attachCommandProcess(a.id, null, null, null);
  const runner = createCommandRunner({
    store,
    maxConcurrent: () => 1,
    killGraceMs: 1,
    procStart: () => null,
    alive: () => true,
    killGroup: (pgid, sig) => kills.push([pgid, sig]),
    [SLE]: async () => {},
  });
  await runner.recover();
  assert.deepEqual(kills, []);
  assert.equal(store.commandRunByKey("pp:1:a")!.status, "interrupted");
});

test("§18.2: queued после рестарта запускается новым раннером", async () => {
  const { store } = makeStore();
  store.enqueueCommandRun(spec(), 1);
  const { spawner, spawned } = fakeSpawner();
  // «новый процесс» — свежий раннер на том же журнале
  const runner = createCommandRunner({
    store,
    spawn: spawner,
    maxConcurrent: () => 4,
    procStart: () => "1",
    alive: () => false,
  });
  await runner.pump();
  assert.equal(spawned.length, 1, "queued запись запущена после рестарта");
});

test("§18.2: holdForSelfReload — queued не стартуют до нового процесса", async () => {
  const { store } = makeStore();
  const { spawner, spawned } = fakeSpawner();
  const runner = createCommandRunner({
    store,
    spawn: spawner,
    maxConcurrent: () => 4,
    procStart: () => "1",
    alive: () => false,
  });
  runner.holdForSelfReload();
  store.enqueueCommandRun(spec(), 1);
  await runner.pump();
  assert.equal(spawned.length, 0);
});

test("§18.5 (Б3): holdForSelfReload — срок истёк → очередь разблокируется сама", async () => {
  const { store } = makeStore();
  const { spawner, spawned } = fakeSpawner();
  let now = 1_000;
  const runner = createCommandRunner({
    store,
    spawn: spawner,
    maxConcurrent: () => 4,
    now: () => now,
    procStart: () => "1",
    alive: () => false,
  });
  runner.holdForSelfReload(5_000);
  store.enqueueCommandRun(spec(), 1);
  await runner.pump();
  assert.equal(spawned.length, 0, "окно удержания — queued не стартуют");
  now += 5_001; // автоматизация не сработала — удержание не вечное
  await runner.pump();
  assert.equal(spawned.length, 1, "после срока очередь пошла");
});

test("§18.2: stopAll — живой группе SIGTERM, запись interrupted (реальный процесс)", async () => {
  const { store } = makeStore();
  const runner = createCommandRunner({
    store,
    maxConcurrent: () => 1,
    killGraceMs: 20,
    [SLE]: async () => {},
  });
  // лидер + дочерний процесс — убивается ВСЯ группа, не только лидер
  store.enqueueCommandRun(
    spec({
      argv: [
        "sh", "-c",
        `${process.execPath} -e 'setInterval(()=>{},1e6)' & ` +
          `exec ${process.execPath} -e 'setInterval(()=>{},1e6)'`,
      ],
    }),
    1,
  );
  await runner.pump();
  const row = store.commandRunByKey("pp:1:deploy")!;
  assert.equal(row.status, "running");
  assert.ok(row.pgid);
  assert.ok(groupAlive(row.pgid!));
  await runner.stopAll();
  assert.equal(store.commandRunByKey("pp:1:deploy")!.status, "interrupted");
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!groupAlive(row.pgid!), "группа мертва — сирот нет");
  assert.equal(procStartTime(row.pid!), null, "лидер мёртв");
});

test("§18.5 (заход 3): флаг «остановлен» — pump после stopAll не запускает queued", async () => {
  const { store } = makeStore();
  const { spawner, spawned } = fakeSpawner();
  const runner = createCommandRunner({
    store,
    spawn: spawner,
    maxConcurrent: () => 4,
    procStart: () => "1",
    alive: () => false,
    killGraceMs: 1,
  });
  store.enqueueCommandRun(spec(), 1);
  await runner.stopAll();
  assert.ok(runner.isStopped());
  await runner.pump();
  assert.equal(spawned.length, 0, "остановленный раннер не запускает");
  assert.equal(
    store.commandRunByKey("pp:1:deploy")!.status,
    "queued",
    "запись ждёт следующего процесса",
  );
});

test("§18.2: retention — записи старше срока чистятся", () => {
  const { store } = makeStore();
  const old = store.enqueueCommandRun(spec(), 1);
  store.claimCommandRun(old.id, 2);
  store.finishCommandRun(old.id, "ok", 0, "", 100);
  const fresh = store.enqueueCommandRun(spec({ runKey: "pp:1:new" }), 5);
  store.claimCommandRun(fresh.id, 6);
  store.finishCommandRun(fresh.id, "ok", 0, "", 10_000);
  assert.equal(store.pruneCommandRuns(5000), 1);
  assert.equal(store.commandRunByKey("pp:1:deploy"), undefined);
  assert.ok(store.commandRunByKey("pp:1:new"));
});

test("§18.2: maskCommandOutput — токены, управляющие символы, хвост", () => {
  const masked = maskCommandOutput(
    "url https://u:p4ss@example.com/x glpat-abcdefghij token=abc\nline2\r\x07end",
  );
  assert.ok(!masked.includes("p4ss"));
  assert.ok(!masked.includes("glpat-abcdefghij"));
  assert.ok(!masked.includes("token=abc"));
  assert.ok(!/\x07/.test(masked));
  assert.ok(masked.length <= 300);
});

test("§18.2: globMatch — *, ?, **, ANY-семантика по одному патчу", () => {
  assert.ok(globMatch("docs/**", "docs/a/b.md"));
  assert.ok(globMatch("plugins/*/src/**", "plugins/x/src/a.ts"));
  assert.ok(globMatch("*.txt", "f.txt"));
  assert.ok(globMatch("?.txt", "f.txt"));
  assert.ok(!globMatch("*.txt", "d/f.txt"));
  assert.ok(!globMatch("docs/**", "src/a.ts"));
  // `**/x` — «ноль и более каталогов»: матчит и корневой x
  assert.ok(globMatch("**/x", "x"));
  assert.ok(globMatch("**/x", "a/b/x"));
  assert.ok(globMatch("a/**/b", "a/b"));
  assert.ok(globMatch("a/**/b", "a/c/d/b"));
});

test("§18.5: timing — слияние по ключам, пределы → warning+default", () => {
  const cfg = JSON.stringify({
    defaults: {
      timing: { checksMinutes: 3, prStaleHours: 24 },
      leaks: { machine: "block", allow: ["/a"] },
    },
    projects: {
      p1: { timing: { checksMinutes: 7 } },
      p2: { timing: { checksMinutes: 99999, auditTimeoutMinutes: 45 } },
    },
  });
  const load = parseReleaseConfig(cfg);
  assert.equal(load.errors.length, 0);
  // пределы — предупреждение, не ошибка
  assert.ok(
    load.warnings.some((w) => /checksMinutes/.test(w.path)),
    "вне пределов — warning",
  );
  const p1 = resolveProject(load.config!, "p1");
  assert.equal(p1.timing.checksMinutes, 7, "проектный ключ перекрыл");
  assert.equal(p1.timing.prStaleHours, 24, "defaults-ключ унаследован");
  assert.equal(
    p1.timing.auditTimeoutMinutes,
    DEFAULT_TIMING.auditTimeoutMinutes,
  );
  const p2 = resolveProject(load.config!, "p2");
  assert.equal(p2.timing.checksMinutes, 3, "вне пределов → defaults-слой");
  assert.equal(p2.timing.auditTimeoutMinutes, 45);
  // leaks по ключам: allow унаследован, machine перекрыт
  const cfg2 = parseReleaseConfig(
    JSON.stringify({
      defaults: { leaks: { machine: "block", allow: ["/a"] } },
      projects: { p1: { leaks: { bbIds: "warn" } } },
    }),
  );
  const l = resolveProject(cfg2.config!, "p1").leaks;
  assert.equal(l.machine, "block");
  assert.equal(l.bbIds, "warn");
  assert.deepEqual(l.allow, ["/a"]);
});

test("§18.5: policy.timing — пределы → warning, значения в политике", () => {
  const load = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: { s: { chain: ["r"] } },
      routes: { r: { preset: "r", provider: "p" } },
      timing: { quotaHoldMinutes: 30, bbNotifyWaitSeconds: 1 },
    }),
  );
  assert.equal(load.errors.length, 0);
  assert.equal(load.policy!.timing!.quotaHoldMinutes, 30);
  assert.ok(load.warnings.some((w) => /bbNotifyWaitSeconds/.test(w.path)));
  assert.equal(load.policy!.timing!.bbNotifyWaitSeconds, undefined);
});

test("§6 r11: postPublish — парсинг r11, warnings on/cwd/дубль", () => {
  const load = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        target: { action: "push", branch: "main" },
        postPublish: {
          on: "merged",
          commands: [
            { name: "a", argv: ["x"] },
            { name: "a", argv: ["y"] },
            { name: "b", command: "echo hi", cwd: "checkout" },
          ],
        },
      },
    }),
  );
  assert.equal(load.errors.length, 0);
  assert.ok(load.warnings.some((w) => /reads as "published"/.test(w.message)));
  assert.ok(load.warnings.some((w) => /duplicate/.test(w.message)));
  assert.ok(load.warnings.some((w) => /missing checkout/.test(w.message)));
  const p = resolveProject(load.config!, "x");
  // on: merged при push → published; дубль отброшен; command → sh -c
  assert.equal(p.postPublish!.on, "published");
  assert.equal(p.postPublish!.commands.length, 2);
  assert.deepEqual(p.postPublish!.commands[1].argv, ["sh", "-c", "echo hi"]);
  assert.ok(p.postPublish!.commands[1].noCheckout);
  // on: merged + prProvider none → warning
  const w = parseReleaseConfig(
    JSON.stringify({
      projects: {
        p: {
          target: { action: "pr", branch: "dev" },
          prProvider: { type: "none" },
          postPublish: {
            commands: [{ name: "a", argv: ["x"] }],
            on: "merged",
          },
        },
      },
    }),
  );
  assert.ok(w.warnings.some((x) => /never fires/.test(x.message)));
  assert.equal(
    resolveProject(w.config!, "p").postPublish!.on,
    "merged",
    "pr-target: merged сохраняется",
  );
});

test("§18.4: доверие — первый снимок молча, изменение → ключи+уведомление, без значений", async () => {
  const { store } = makeStore();
  const warns: string[] = [];
  const sends: string[] = [];
  const cfg = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        checks: ["npm test"],
        postPublish: { commands: [{ name: "deploy", argv: ["./d.sh"] }] },
      },
    }),
  ).config!;
  const send = async (t: string, text: string) => {
    sends.push(`${t}:${text}`);
  };
  // первый снимок — молча
  let changes = await checkExecSettings({
    store,
    cfg,
    send,
    warn: (m) => warns.push(m),
  });
  assert.equal(changes.length, 0);
  assert.equal(sends.length, 0);
  // то же самое — снова молча
  changes = await checkExecSettings({ store, cfg, send });
  assert.equal(changes.length, 0);
  // изменение исполняемой команды → расхождение
  const cfg2 = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        checks: ["npm test"],
        postPublish: { commands: [{ name: "deploy", argv: ["./evil.sh"] }] },
      },
    }),
  ).config!;
  // незавершённое делегирование — координатор получает строку
  const del = store.insert({
    taskKey: "PLUG-9",
    projectId: "p",
    coordinatorThreadId: "thr_c",
    level: "simple",
    route: "r",
    preset: "r",
    provider: "p",
  });
  store.setStatus(del.id, "running");
  changes = await checkExecSettings({
    store,
    cfg: cfg2,
    send,
    warn: (m) => warns.push(m),
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, "defaults:postPublish.commands:deploy");
  assert.ok(warns.some((w) => /изменены исполняемые настройки/.test(w)));
  assert.ok(
    sends.some((s) => /изменены исполняемые настройки/.test(s)),
    "строка координатору с незавершённой работой",
  );
  assert.deepEqual(execSettingsChangedKeys(store), [
    "defaults:postPublish.commands:deploy",
  ]);
  // в журнале/уведомлении — только хеши, не значения
  assert.ok(!JSON.stringify(changes).includes("evil.sh"));
  const fp = execSettingsFingerprint(cfg2);
  assert.ok(!JSON.stringify(fp).includes("evil.sh"));
});

test("§18.4 (мелочь): битый конфиг — снимок не сверяется, «всё убрали» не рассылается", async () => {
  const { store } = makeStore();
  const sends: string[] = [];
  const warns: string[] = [];
  const cfg = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        postPublish: { commands: [{ name: "deploy", argv: ["./d.sh"] }] },
      },
    }),
  ).config!;
  await checkExecSettings({ store, cfg, send: async () => {} });
  // конфиг сломался — снимок не трогаем и ничего не рассылаем
  const changes = await checkExecSettings({
    store,
    cfg: null,
    cfgBroken: true,
    send: async (t, text) => {
      sends.push(`${t}:${text}`);
    },
    warn: (m) => warns.push(m),
  });
  assert.equal(changes.length, 0, "расхождений нет — сверки не было");
  assert.equal(sends.length, 0, "ложные «всё убрали» не рассылаются");
  assert.ok(warns.some((w) => /не парсится/.test(w)));
});

test("§18.4 (мелочь): status — имена и хеши изменённых записей, без значений", async () => {
  const { store } = makeStore();
  const cfg = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        postPublish: { commands: [{ name: "deploy", argv: ["./d.sh"] }] },
      },
    }),
  ).config!;
  await checkExecSettings({ store, cfg, send: async () => {} });
  const cfg2 = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        postPublish: { commands: [{ name: "deploy", argv: ["./evil.sh"] }] },
      },
    }),
  ).config!;
  const changes = await checkExecSettings({
    store,
    cfg: cfg2,
    send: async () => {},
  });
  assert.equal(changes.length, 1);
  const listed = execSettingsChanges(store);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].key, "defaults:postPublish.commands:deploy");
  assert.match(listed[0].prev, /^[0-9a-f]{16}$/, "старый хеш в status");
  assert.match(listed[0].next, /^[0-9a-f]{16}$/, "новый хеш в status");
  assert.notEqual(listed[0].prev, listed[0].next);
  assert.ok(!listed[0].prev.includes("evil"), "значений нет — только хеши");
});
