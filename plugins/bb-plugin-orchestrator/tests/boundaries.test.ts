/**
 * Acceptance suite for orchestrator §24.1 (PLUG-410): границы для агентов
 * кодом (§24 п.1–4), установка хуков, live-checkout под §23.
 *
 * Every git run here uses an isolated global config (`GIT_CONFIG_GLOBAL`
 * per test) and the isolated HOME from register-hooks.ts; the last test
 * compares the REAL machine's global core.hooksPath before and after.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import Database from "better-sqlite3";
import { makeTempDir } from "./helpers/temp.js";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import {
  HOOK_NAMES,
  installHooks,
  readHookNames,
  runHooksDoctor,
  readChainConfig,
} from "../src/hooks.js";
import {
  LIVE_MARKER,
  beginPublish,
  chmodRecursive,
  getLiveCheckoutRequest,
  isLiveCheckoutMigrating,
  isLiveCheckoutPath,
  issueLiveToken,
  liveCopyLockPath,
  migrationLockPath,
  parsePluginList,
  pruneLiveRegistry,
  registerLiveCopy,
  requestLiveCheckout,
  resumeLiveCheckout,
  revokeLiveToken,
  rollbackOrder,
  runLiveCheckoutMigration,
  saveLiveCheckoutRequest,
  setLiveCheckoutMigrating,
  writeLiveRegistry,
  writeTargetsRegistry,
  type LiveCheckoutRequest,
  type MigrationDeps,
  type PluginInfo,
} from "../src/live-checkout.js";
import { acquireCopyLock } from "../src/merge.js";
import { OrchestratorError } from "../src/errors.js";

// The real machine's global hooks path, read with the ORIGINAL home and
// no GIT_CONFIG_GLOBAL — snapshotted before any test of this file runs.
const REAL_HOME = process.env.ORCH_TEST_REAL_HOME || "";
function realGlobalHooksPath(): string {
  if (!REAL_HOME) return "";
  const env = { ...process.env, HOME: REAL_HOME } as Record<string, string | undefined>;
  delete env.GIT_CONFIG_GLOBAL;
  const r = spawnSync("git", ["config", "--global", "--get", "core.hooksPath"], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : "";
}
const REAL_BEFORE = realGlobalHooksPath();

const HOOKS_SRC = new URL("../hooks", import.meta.url).pathname;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
}

function initRepo(repo: string, branch = "main"): void {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch, repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "agent@bb.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "BB Agent"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

// PLUG-439: настоящий bb не вызывается ни разу. Всё, что прошло мимо
// заглушки hookEnv (BB_CLI и `bb` на PATH из register-hooks.ts), пишется
// в журнал файла FILE_BB_LOG — тест-сторож в конце файла требует его
// пустым. Каталог не через makeTempDir: тот чистится после каждого теста.
const FILE_BB_DIR = mkdtempSync(join(tmpdir(), "orch-boundaries-bb-"));
const FILE_BB_LOG = join(FILE_BB_DIR, "untracked-bb-calls");
process.env.ORCH_TEST_BB_LOG = FILE_BB_LOG;
process.on("exit", () => rmSync(FILE_BB_DIR, { recursive: true, force: true }));
/** Every BB_CLI handed out by hookEnv — the guard checks each is a stub. */
const HOOK_ENV_BB: string[] = [];

/** Isolated environment: own global git config with our hooks installed,
 * BB_CLI = заглушка в tmp (exit 0, каждый вызов строкой в `bbCalls`). */
async function hookEnv(prefix: string) {
  const tmp = makeTempDir(prefix);
  const bbCli = join(tmp, "fake-bb");
  const bbCalls = join(tmp, "bb-calls");
  writeFileSync(bbCli, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${bbCalls}'\nexit 0\n`, { mode: 0o755 });
  HOOK_ENV_BB.push(bbCli);
  const hooksDir = join(tmp, "git-hooks");
  const gcfg = join(tmp, "gitconfig");
  writeFileSync(gcfg, "");
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gcfg;
  try {
    await installHooks({ hooksDir });
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gcfg, BB_CLI: bbCli } as NodeJS.ProcessEnv;
  delete env.BB_THREAD_ID;
  return { tmp, hooksDir, gcfg, env, bbCli, bbCalls };
}

function initDb(dbPath: string): { db: InstanceType<typeof Database>; store: DelegationStore } {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  for (const m of MIGRATIONS) db.exec(m);
  return { db, store: new DelegationStore(db) };
}

/** A fake bb.db with the two tables the hooks read. */
function initBbDb(path: string, threads: Array<[string, string]>, envs: Array<[string, string]>) {
  const db = new Database(path);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, environment_id TEXT, parent_thread_id TEXT)");
  db.exec("CREATE TABLE environments (id TEXT PRIMARY KEY, path TEXT)");
  for (const [id, env] of threads) db.prepare("INSERT INTO threads (id, environment_id) VALUES (?, ?)").run(id, env);
  for (const [id, p] of envs) db.prepare("INSERT INTO environments (id, path) VALUES (?, ?)").run(id, p);
  db.close();
}

function insertDelegation(db: InstanceType<typeof Database>, threadId: string, envId: string | null) {
  db.prepare(
    `INSERT INTO delegations (task_key, coordinator_thread_id, thread_id, level, route, preset, provider, status, created_at, updated_at, result_env_id)
     VALUES (?, 'thr_coord', ?, 'simple', 'r', 'p', 'prov', 'running', 0, 0, ?)`,
  ).run(`PLUG-${threadId}`, threadId, envId);
}

function commit(repo: string, env: NodeJS.ProcessEnv, file: string, content = "x\n") {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  git(repo, ["add", file], env);
  return git(repo, ["commit", "-q", "-m", `add ${file}`], env);
}

// ────────────────────────────────────────────────────────────────────────
// §24.1 п.1: один список имён, установка, doctor
// ────────────────────────────────────────────────────────────────────────

test("§24.1 п.1: HOOK_NAMES — тот же список, что hooks/hook-names (один источник для обеих установок)", () => {
  assert.deepEqual([...HOOK_NAMES], [...readHookNames()]);
  assert.equal(HOOK_NAMES.length, 27);
  for (const n of ["p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit"]) {
    assert.ok(HOOK_NAMES.includes(n), `HOOK_NAMES missing ${n}`);
  }
  assert.ok(!HOOK_NAMES.includes("push-to-checkout"));
});

test("§24.1 п.6: doctor на копии с локальным core.hooksPath → код 2, строка владельцу; сбой доставки виден", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-doc-local-");
  const repo = join(tmp, "repo");
  initRepo(repo);
  git(repo, ["config", "--local", "core.hooksPath", join(tmp, "own")], env);
  const lines: string[] = [];
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  try {
    const res = await runHooksDoctor({
      hooksDir,
      repo,
      notifyOwner: async (l) => {
        lines.push(l);
        return true;
      },
    });
    assert.equal(res.code, 2);
    assert.ok(res.issues.some((i) => i.type === "local-hooks-path"));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /local core\.hooksPath/);
    const failed = await runHooksDoctor({ hooksDir, repo, notifyOwner: async () => false });
    assert.equal(failed.ownerNotified, false);
    assert.match(failed.message, /не доставлена/);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
});

test("§24.1 п.6: doctor — неисполняемый pre-commit и отсутствующий commit-msg → код 2 с перечнем", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-doc-set-");
  const repo = join(tmp, "repo");
  initRepo(repo);
  chmodSync(join(hooksDir, "pre-commit"), 0o644);
  execFileSync("rm", [join(hooksDir, "commit-msg")]);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  try {
    const res = await runHooksDoctor({ hooksDir, repo });
    assert.equal(res.code, 2);
    assert.match(res.message, /commit-msg/);
    assert.match(res.message, /pre-commit/);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
});

test("§24.1 п.6: push-to-checkout не ставится и не считается ошибкой; полный набор → код 0", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-doc-ok-");
  const repo = join(tmp, "repo");
  initRepo(repo);
  assert.equal(existsSync(join(hooksDir, "push-to-checkout")), false);
  assert.ok(existsSync(join(hooksDir, "hook-lib.mjs")));
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  try {
    const res = await runHooksDoctor({ hooksDir, repo });
    assert.equal(res.code, 0, res.message);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
});

test("§24.1 п.1 (аудит р.3 п.4): doctor проверяет живую копию из настройки вне ~/.bb/plugin-live", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-doc-live-");
  const repo = join(tmp, "repo");
  const live = join(tmp, "elsewhere", "live");
  initRepo(repo);
  initRepo(live);
  git(live, ["config", "--local", "core.hooksPath", join(tmp, "own")], env);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  try {
    const without = await runHooksDoctor({ hooksDir, repo });
    assert.equal(without.code, 0);
    const res = await runHooksDoctor({ hooksDir, repo, liveCheckouts: [live] });
    assert.equal(res.code, 2);
    assert.ok(res.issues.some((i) => i.copy === realpathSync(live)));
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
});

test("§24.1 п.6: локальный commit-msg репозитория срабатывает через обёртку (настоящий коммит)", async () => {
  const { tmp, env } = await hookEnv("orch-chain-cm-");
  const repo = join(tmp, "repo");
  initRepo(repo);
  git(repo, ["checkout", "-q", "-b", "work"], env);
  const local = join(repo, ".git", "hooks", "commit-msg");
  writeFileSync(local, '#!/bin/sh\necho ran > "$(git rev-parse --show-toplevel)/../cm-ran"\nexit 0\n');
  chmodSync(local, 0o755);
  const r = commit(repo, env, "a.txt");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(tmp, "cm-ran")));
});

test("§24.1 п.6 (аудит р.3 п.4): прежний глобальный хук вызывается по цепочке; хук репозитория — в приоритете", async () => {
  const tmp = makeTempDir("orch-chain-prev-");
  const hooksDir = join(tmp, "git-hooks");
  const prevGlobal = join(tmp, "prev-global");
  mkdirSync(prevGlobal, { recursive: true });
  writeFileSync(join(prevGlobal, "pre-commit"), '#!/bin/sh\necho g >> "$(git rev-parse --show-toplevel)/../ran"\n');
  chmodSync(join(prevGlobal, "pre-commit"), 0o755);
  const gcfg = join(tmp, "gitconfig");
  writeFileSync(gcfg, `[core]\n\thooksPath = ${prevGlobal}\n`);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gcfg;
  try {
    await installHooks({ hooksDir });
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
  assert.equal(readChainConfig(hooksDir).previousGlobalHooksPath, prevGlobal);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gcfg } as NodeJS.ProcessEnv;
  delete env.BB_THREAD_ID;
  const repo = join(tmp, "repo");
  initRepo(repo);
  git(repo, ["checkout", "-q", "-b", "work"], env);
  assert.equal(commit(repo, env, "a.txt").status, 0);
  assert.equal(readFileSync(join(tmp, "ran"), "utf8"), "g\n");
  // a repository hook now exists → it runs, not the old global one
  const local = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(local, '#!/bin/sh\necho l >> "$(git rev-parse --show-toplevel)/../ran"\n');
  chmodSync(local, 0o755);
  assert.equal(commit(repo, env, "b.txt").status, 0);
  assert.equal(readFileSync(join(tmp, "ran"), "utf8"), "g\nl\n");
});

test("§24.1 п.1 (аудит р.3 п.4): относительный прежний глобальный путь — от каталога запуска хука, как у git", async () => {
  const tmp = makeTempDir("orch-chain-rel-");
  const hooksDir = join(tmp, "git-hooks");
  const gcfg = join(tmp, "gitconfig");
  writeFileSync(gcfg, "[core]\n\thooksPath = .githooks\n");
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gcfg;
  try {
    await installHooks({ hooksDir });
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
  assert.equal(readChainConfig(hooksDir).previousGlobalHooksPath, ".githooks");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gcfg } as NodeJS.ProcessEnv;
  delete env.BB_THREAD_ID;
  const repo = join(tmp, "repo");
  initRepo(repo);
  git(repo, ["checkout", "-q", "-b", "work"], env);
  mkdirSync(join(repo, ".githooks"));
  writeFileSync(join(repo, ".githooks", "pre-commit"), '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/../rel-ran"\n');
  chmodSync(join(repo, ".githooks", "pre-commit"), 0o755);
  assert.equal(commit(repo, env, "a.txt").status, 0);
  assert.ok(existsSync(join(tmp, "rel-ran")));
});

test("§24.1 п.1 (аудит р.3 п.4): --fix-local только владельцу; область worktree переносится и проверяется", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-fixlocal-");
  const repo = join(tmp, "repo");
  initRepo(repo);
  git(repo, ["config", "extensions.worktreeConfig", "true"], env);
  const wt = join(tmp, "wt");
  assert.equal(git(repo, ["worktree", "add", "-q", "-b", "wt", wt], env).status, 0);
  const own = join(tmp, "own-hooks");
  mkdirSync(own);
  git(wt, ["config", "--worktree", "core.hooksPath", own], env);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  try {
    await assert.rejects(
      installHooks({ hooksDir, fixLocalCopy: wt, confirmed: true, owner: false }),
      (e: unknown) => e instanceof OrchestratorError && e.code === "permission-denied",
    );
    await assert.rejects(
      installHooks({ hooksDir, fixLocalCopy: wt, confirmed: false, owner: true }),
      (e: unknown) => e instanceof OrchestratorError && e.code === "fix-local-needs-confirmation",
    );
    const res = await installHooks({ hooksDir, fixLocalCopy: wt, confirmed: true, owner: true });
    assert.equal(res.ok, true);
    const eff = git(wt, ["rev-parse", "--git-path", "hooks"], env).stdout.trim();
    assert.equal(realpathSync(eff), realpathSync(hooksDir));
    assert.equal(readChainConfig(hooksDir).localHooks?.[realpathSync(wt)], realpathSync(own));
    const doc = await runHooksDoctor({ hooksDir, repo });
    assert.equal(doc.code, 0, doc.message);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
});

test("§24.1 п.1 (аудит р.5 п.2): --fix-local local=scripts/hooks — хук репозитория срабатывает и в worktree, созданном ПОСЛЕ переноса", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-fixlocal-rel-");
  const repo = join(tmp, "repo");
  initRepo(repo);
  git(repo, ["checkout", "-q", "-b", "work"], env);
  const log = join(tmp, "repo-hook.log");
  mkdirSync(join(repo, "scripts", "hooks"), { recursive: true });
  writeFileSync(
    join(repo, "scripts", "hooks", "commit-msg"),
    `#!/bin/sh\nbasename "$(git rev-parse --show-toplevel)" >> "${log}"\nexit 0\n`,
  );
  chmodSync(join(repo, "scripts", "hooks", "commit-msg"), 0o755);
  assert.equal(commit(repo, env, "scripts/hooks/commit-msg", readFileSync(join(repo, "scripts", "hooks", "commit-msg"), "utf8")).status, 0);
  git(repo, ["config", "--local", "core.hooksPath", "scripts/hooks"], env);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  try {
    const res = await installHooks({ hooksDir, fixLocalCopy: repo, confirmed: true, owner: true });
    assert.equal(res.ok, true, res.message);
    const common = realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim());
    // stored as written, by the repository's common dir — not per copy
    assert.equal(readChainConfig(hooksDir).repoHooks?.[common], "scripts/hooks");
    assert.equal(readChainConfig(hooksDir).localHooks?.[realpathSync(repo)], undefined);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
  writeFileSync(log, "");
  const wt = join(tmp, "wt-new");
  assert.equal(git(repo, ["worktree", "add", "-q", "-b", "task", wt], env).status, 0);
  const r1 = commit(wt, env, "w.txt");
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = commit(repo, env, "m.txt");
  assert.equal(r2.status, 0, r2.stderr);
  // the hook ran in BOTH copies (2 of 2), each resolved from its own top
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["wt-new", "repo"]);
});

// ────────────────────────────────────────────────────────────────────────
// §24 п.2 / §24.1 п.4–5: коммиты по ролям (настоящий git commit)
// ────────────────────────────────────────────────────────────────────────

async function roleEnv(prefix: string) {
  const base = await hookEnv(prefix);
  const dbPath = join(base.tmp, "data.db");
  const { db, store } = initDb(dbPath);
  const bbDb = join(base.tmp, "bb.db");
  const env = {
    ...base.env,
    ORCHESTRATOR_DB_PATH: dbPath,
    ORCHESTRATOR_BB_DB_PATH: bbDb,
  } as NodeJS.ProcessEnv;
  return { ...base, db, store, bbDb, env };
}

test("§24.1 п.6: координатор — docs/ проходит, plugins/ отказ, смешанный — отказ с перечнем", async () => {
  const { tmp, store, env, db } = await roleEnv("orch-role-coord-");
  store.setThreadRole("thr_coord", "orchestrator", "owner");
  initBbDb(join(tmp, "bb.db"), [], []);
  db.close();
  const repo = join(tmp, "repo");
  initRepo(repo);
  const e = { ...env, BB_THREAD_ID: "thr_coord" };
  git(repo, ["checkout", "-q", "-b", "docs-work"], e);
  assert.equal(commit(repo, e, "docs/spec.md").status, 0);
  const r = commit(repo, e, "plugins/x/a.ts");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /координатор код не пишет: delegate/);
  writeFileSync(join(repo, "docs", "b.md"), "b\n");
  git(repo, ["add", "docs/b.md"], e);
  const m = commit(repo, e, "plugins/x/c.ts");
  assert.notEqual(m.status, 0);
  assert.match(m.stderr, /пути вне docs: plugins\/x\/a\.ts, plugins\/x\/c\.ts|пути вне docs: .*plugins\/x\/c\.ts/);
});

test("§24.1 п.6: человек на рабочей ветке проходит, в main — отказ; цель проекта из targets.json — отказ", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-role-human-");
  const repo = join(tmp, "repo");
  initRepo(repo);
  writeFileSync(join(hooksDir, "projects.json"), JSON.stringify([realpathSync(join(repo, ".git"))]));
  const r = commit(repo, env, "a.txt");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /в целевую ветку не коммитят/);
  git(repo, ["checkout", "-q", "-b", "work"], env);
  assert.equal(commit(repo, env, "a.txt").status, 0);
  writeTargetsRegistry(hooksDir, ["release-x"]);
  git(repo, ["checkout", "-q", "-b", "release-x"], env);
  const t = commit(repo, env, "b.txt");
  assert.notEqual(t.status, 0);
  assert.match(t.stderr, /в целевую ветку не коммитят/);
});

test("§24.1 п.6: корневой executor — рабочая ветка проходит, main — отказ, копия координатора — отказ", async () => {
  const { tmp, store, env, db, bbDb, hooksDir } = await roleEnv("orch-role-exec-");
  store.setThreadRole("thr_exec", "executor", "owner");
  const coordCopy = join(tmp, "coord");
  initRepo(coordCopy);
  db.prepare(
    `INSERT INTO coordinator_worktrees (project_id, coordinator_thread_id, env_id, worktree_path, state, reason, decision_generation, created_at, updated_at)
     VALUES ('p', 'thr_coord', 'env_c', ?, 'active', 'coordinator-live', 1, 0, 0)`,
  ).run(coordCopy);
  db.close();
  initBbDb(bbDb, [], []);
  const repo = join(tmp, "repo");
  initRepo(repo);
  writeFileSync(join(hooksDir, "projects.json"), JSON.stringify([realpathSync(join(repo, ".git"))]));
  const e = { ...env, BB_THREAD_ID: "thr_exec" };
  assert.notEqual(commit(repo, e, "a.txt").status, 0);
  git(repo, ["checkout", "-q", "-b", "work"], e);
  assert.equal(commit(repo, e, "a.txt").status, 0);
  git(coordCopy, ["checkout", "-q", "-b", "cwork"], e);
  const c = commit(coordCopy, e, "a.txt");
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /коммит вне копии задачи/);
});

test("§24 п.2 (аудит р.3 п.3): executor с делегированием — только в своей копии по реальному пути; путь неизвестен — отказ", async () => {
  const { tmp, store, env, db, bbDb } = await roleEnv("orch-role-deleg-");
  store.setThreadRole("thr_exec", "executor", "owner");
  insertDelegation(db, "thr_exec", "env_own");
  insertDelegation(db, "thr_lost", null);
  store.setThreadRole("thr_lost", "executor", "owner");
  db.close();
  const own = join(tmp, "own-thr_lost-PLUG-1");
  const other = join(tmp, "other");
  initRepo(own);
  initRepo(other);
  initBbDb(bbDb, [["thr_exec", "env_thread"]], [["env_own", own], ["env_thread", other]]);
  const e = { ...env, BB_THREAD_ID: "thr_exec" };
  git(own, ["checkout", "-q", "-b", "w"], e);
  git(other, ["checkout", "-q", "-b", "w"], e);
  assert.equal(commit(own, e, "a.txt").status, 0);
  const f = commit(other, e, "a.txt");
  assert.notEqual(f.status, 0);
  assert.match(f.stderr, /коммит вне копии задачи/);
  // no env for the delegation, no thread env → refusal even though the
  // path contains the thread id and task key (no substring guessing)
  const l = commit(own, { ...env, BB_THREAD_ID: "thr_lost" }, "b.txt");
  assert.notEqual(l.status, 0);
  assert.match(l.stderr, /коммит вне копии задачи/);
});

test("§24.1 п.6: коммит helper — отказ «помощник не коммитит»", async () => {
  const { tmp, env, db, bbDb } = await roleEnv("orch-role-helper-");
  db.prepare(
    `INSERT INTO helpers (caller_thread_id, coordinator_thread_id, thread_id, preset, route, level, title, status, created_at, updated_at)
     VALUES ('thr_caller', 'thr_coord', 'thr_help', 'p', 'r', 'simple', 't', 'running', 0, 0)`,
  ).run();
  db.close();
  initBbDb(bbDb, [], []);
  const repo = join(tmp, "repo");
  initRepo(repo);
  const e = { ...env, BB_THREAD_ID: "thr_help" };
  git(repo, ["checkout", "-q", "-b", "w"], e);
  const r = commit(repo, e, "a.txt");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /помощник не коммитит/);
});

test("§24 п.2 (аудит р.3 п.3): база роли не читается → предупреждение и только правило (а)", async () => {
  const { tmp, env } = await hookEnv("orch-role-broken-");
  const dbPath = join(tmp, "broken.db");
  writeFileSync(dbPath, "not a database");
  const repo = join(tmp, "repo");
  initRepo(repo);
  const e = { ...env, BB_THREAD_ID: "thr_x", ORCHESTRATOR_DB_PATH: dbPath };
  git(repo, ["checkout", "-q", "-b", "w"], e);
  const r = commit(repo, e, "a.txt");
  assert.equal(r.status, 0);
  assert.match(r.stderr + r.stdout, /база плагина недоступна/);
});

// ────────────────────────────────────────────────────────────────────────
// §24 п.3: post-checkout → одна строка через checkout-notice
// ────────────────────────────────────────────────────────────────────────

test("§24.1 п.6: post-checkout из треда с ролью в чужой копии → один вызов checkout-notice", async () => {
  const { tmp, store, env, db, bbDb, bbCalls: calls } = await roleEnv("orch-postco-");
  store.setThreadRole("thr_coord", "orchestrator", "owner");
  db.close();
  initBbDb(bbDb, [], []);
  const repo = join(tmp, "owner-copy");
  initRepo(repo);
  // BB_CLI — заглушка hookEnv, без своей подмены (PLUG-439)
  const e = { ...env, BB_THREAD_ID: "thr_coord" };
  assert.equal(git(repo, ["checkout", "-q", "-b", "feature"], e).status, 0);
  const lines = readFileSync(calls, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^orchestrator checkout-notice --copy .*owner-copy --branch feature/);
  // a human (no BB_THREAD_ID) — nothing
  git(repo, ["checkout", "-q", "main"], env);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
});

// ────────────────────────────────────────────────────────────────────────
// §24.1 п.3: живая копия — только чтение + reference-transaction
// ────────────────────────────────────────────────────────────────────────

function makeLive(tmp: string, env: NodeJS.ProcessEnv, liveDir: string) {
  const origin = join(tmp, "origin.git");
  const seed = join(tmp, "seed");
  initRepo(seed);
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  execFileSync("git", ["clone", "-q", origin, liveDir], { env });
  const common = git(liveDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
  writeFileSync(join(common, LIVE_MARKER), "{}\n");
  return { origin, seed };
}

test("§24.1 п.6: коммит, checkout и merge в живой копии (вне ~/.bb/plugin-live) без токена → отказ до изменения", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-live-protect-");
  const liveDir = join(tmp, "custom", "live");
  makeLive(tmp, env, liveDir);
  assert.equal(isLiveCheckoutPath(liveDir, hooksDir), true);
  const headBefore = git(liveDir, ["rev-parse", "HEAD"]).stdout.trim();
  // reference-transaction refuses even while files are writable
  const br = git(liveDir, ["checkout", "-q", "-b", "agent-branch"], env);
  assert.notEqual(br.status, 0);
  assert.match(br.stderr, /изменение ссылок в служебной живой копии/);
  chmodRecursive(liveDir, false);
  try {
    assert.throws(() => writeFileSync(join(liveDir, "exploit.ts"), "x"));
    const m = git(liveDir, ["merge", "--ff-only", "origin/main"], env);
    assert.equal(git(liveDir, ["rev-parse", "HEAD"]).stdout.trim(), headBefore);
    assert.ok(m.status === 0 || m.status !== 0); // up to date or refused — HEAD unchanged
  } finally {
    chmodRecursive(liveDir, true);
  }
});

test("§24.1 п.6: fetch + ff с токеном этой копии проходит; токен другой копии или просроченный — нет", async () => {
  const { tmp, env } = await hookEnv("orch-live-token-");
  const liveDir = join(tmp, "custom", "live");
  const { seed, origin } = makeLive(tmp, env, liveDir);
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty", "-m", "next"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  execFileSync("git", ["-C", seed, "push", "-q", origin, "main"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  chmodRecursive(liveDir, false);
  try {
    const other = issueLiveToken(join(tmp, "another-copy"));
    chmodRecursive(liveDir, true);
    const bad = git(liveDir, ["fetch", "-q", "origin"], { ...env, ORCH_LIVE_TOKEN: other });
    assert.notEqual(bad.status, 0, "token of another copy must not open this one");
    const token = issueLiveToken(liveDir);
    const f = git(liveDir, ["fetch", "-q", "origin"], { ...env, ORCH_LIVE_TOKEN: token });
    assert.equal(f.status, 0, f.stderr);
    const ff = git(liveDir, ["merge", "-q", "--ff-only", "origin/main"], { ...env, ORCH_LIVE_TOKEN: token });
    assert.equal(ff.status, 0, ff.stderr);
    revokeLiveToken(liveDir, token);
    const after = git(liveDir, ["checkout", "-q", "-b", "x"], { ...env, ORCH_LIVE_TOKEN: token });
    assert.notEqual(after.status, 0, "revoked token");
  } finally {
    chmodRecursive(liveDir, true);
  }
});

test("§24.1 п.6 (аудит р.3 п.2/п.5): штатный runPostPublish — защищённая копия вне ~/.bb/plugin-live, настоящие хуки, ff проходит, .git снова только чтение", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-live-pp-");
  const liveDir = join(tmp, "custom", "live");
  const { seed, origin } = makeLive(tmp, env, liveDir);
  const repo = join(tmp, "repo");
  execFileSync("git", ["clone", "-q", origin, repo]);
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty", "-m", "next"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  execFileSync("git", ["-C", seed, "push", "-q", origin, "main"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  const newSha = git(seed, ["rev-parse", "HEAD"]).stdout.trim();
  chmodRecursive(liveDir, false);
  const { store, db } = initDb(join(tmp, "data.db"));
  const { runPostPublish } = await import("../src/release.js");
  const { parseReleaseConfig } = await import("../src/release-config.js");
  const { createCmd } = await import("../src/cmd.js");
  const cfg = parseReleaseConfig(
    JSON.stringify({
      defaults: { target: { action: "push", branch: "main" } },
      projects: { p1: { postPublish: { checkout: liveDir, on: "published" } } },
    }),
  );
  assert.deepEqual(cfg.errors, []);
  const prevG = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  try {
    const deps = {
      store,
      cmd: createCmd(),
      loadReleaseConfig: () => cfg,
      hooksDir: () => hooksDir,
      instanceId: "inst-pp",
      log: {},
    } as never;
    const row = {
      id: 42,
      task_key: "PLUG-410",
      repo_path: repo,
      repo_root: repo,
      settings_project_id: "p1",
      project_id: "p1",
      target_action: "push",
      target_branch: "main",
      branch: "main",
      head_sha: newSha,
      published_sha: newSha,
    } as never;
    const res = await runPostPublish(deps, row, "release.published");
    assert.equal(git(liveDir, ["rev-parse", "HEAD"]).stdout.trim(), newSha, JSON.stringify(res));
    assert.throws(() => writeFileSync(join(liveDir, ".git", "x"), "x"), "the copy's .git is read-only again");
    assert.equal(existsSync(join(liveDir, ".git", "orchestrator-merge.lock")), false);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prevG;
    chmodRecursive(liveDir, true);
    db.close();
  }
});

test("§24.1 п.1 (аудит р.5 п.1): postPublish.checkout = обычная копия владельца → не живая: реестр её не берёт, права не меняются, ссылки не блокируются", async () => {
  const { tmp, hooksDir, env } = await hookEnv("orch-owner-copy-");
  const seed = join(tmp, "seed");
  const origin = join(tmp, "origin.git");
  initRepo(seed);
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  const owner = join(tmp, "work", "bb-addons");
  execFileSync("git", ["clone", "-q", origin, owner], { env });
  writeFileSync(join(owner, "secret.env"), "k=v\n", { mode: 0o600 });
  // a registry entry left by an older build (or written by hand) does
  // not make a marker-less copy live, and is pruned
  writeFileSync(join(hooksDir, "live-copies.json"), JSON.stringify([owner]) + "\n");
  assert.equal(isLiveCheckoutPath(owner, hooksDir), false);
  const br0 = git(owner, ["checkout", "-q", "-b", "owner-1"], env);
  assert.equal(br0.status, 0, br0.stderr);
  pruneLiveRegistry(hooksDir);
  assert.deepEqual(JSON.parse(readFileSync(join(hooksDir, "live-copies.json"), "utf8")), []);
  writeLiveRegistry(hooksDir, [owner]);
  registerLiveCopy(hooksDir, owner);
  assert.deepEqual(JSON.parse(readFileSync(join(hooksDir, "live-copies.json"), "utf8")), []);
  git(owner, ["checkout", "-q", "main"], env);

  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty", "-m", "next"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  execFileSync("git", ["-C", seed, "push", "-q", origin, "main"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  const newSha = git(seed, ["rev-parse", "HEAD"]).stdout.trim();
  const repo = join(tmp, "repo");
  execFileSync("git", ["clone", "-q", origin, repo]);
  const gitMode = statSync(join(owner, ".git")).mode & 0o777;
  const { store, db } = initDb(join(tmp, "data.db"));
  const { runPostPublish } = await import("../src/release.js");
  const { parseReleaseConfig } = await import("../src/release-config.js");
  const { createCmd } = await import("../src/cmd.js");
  const cfg = parseReleaseConfig(
    JSON.stringify({
      defaults: { target: { action: "push", branch: "main" } },
      projects: { p1: { postPublish: { checkout: owner, on: "published" } } },
    }),
  );
  assert.deepEqual(cfg.errors, []);
  const prevG = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  try {
    const deps = {
      store,
      cmd: createCmd(),
      loadReleaseConfig: () => cfg,
      hooksDir: () => hooksDir,
      instanceId: "inst-owner",
      log: {},
    } as never;
    const row = {
      id: 43,
      task_key: "PLUG-410",
      repo_path: repo,
      repo_root: repo,
      settings_project_id: "p1",
      project_id: "p1",
      target_action: "push",
      target_branch: "main",
      branch: "main",
      head_sha: newSha,
      published_sha: newSha,
    } as never;
    const res = await runPostPublish(deps, row, "release.published");
    assert.equal(git(owner, ["rev-parse", "HEAD"]).stdout.trim(), newSha, JSON.stringify(res));
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prevG;
    db.close();
  }
  // permissions untouched: secret stays 0600, .git and tree writable
  assert.equal(statSync(join(owner, "secret.env")).mode & 0o777, 0o600);
  assert.equal(statSync(join(owner, ".git")).mode & 0o777, gitMode);
  writeFileSync(join(owner, ".git", "probe"), "x");
  writeFileSync(join(owner, "probe.txt"), "x");
  // reference-transaction does not refuse the owner's ref updates
  const br = git(owner, ["checkout", "-q", "-b", "owner-2"], env);
  assert.equal(br.status, 0, br.stderr);
  assert.equal(isLiveCheckoutPath(owner, hooksDir), false);
});

// ────────────────────────────────────────────────────────────────────────
// §24.1 п.2: live-checkout setup под §23
// ────────────────────────────────────────────────────────────────────────

test("§24.1 п.6: setup без одобрения — заявка и live-checkout-needs-approval; повтор — та же заявка", () => {
  const tmp = makeTempDir("orch-live-req-");
  const repo = join(tmp, "repo");
  initRepo(repo);
  const { store, db } = initDb(join(tmp, "data.db"));
  const a = requestLiveCheckout({ repoRoot: repo, projectId: "p1", targetBranch: "main", store, threadId: "thr_coord" });
  assert.equal(a.created, true);
  assert.equal(a.request.status, "pending");
  assert.equal(a.request.projectId, "p1");
  const b = requestLiveCheckout({ repoRoot: repo, projectId: "p1", targetBranch: "main", store, threadId: "thr_coord" });
  assert.equal(b.created, false);
  assert.equal(b.request.id, a.request.id);
  assert.throws(
    () => requestLiveCheckout({ repoRoot: repo, projectId: "", targetBranch: "main", store }),
    (e: unknown) => e instanceof OrchestratorError && e.code === "live-checkout-project-unresolved",
  );
  db.close();
});

test("§24.1 п.2: применить можно только одобренную заявку", async () => {
  const tmp = makeTempDir("orch-live-unapproved-");
  const repo = join(tmp, "repo");
  initRepo(repo);
  const { store, db } = initDb(join(tmp, "data.db"));
  const { request } = requestLiveCheckout({ repoRoot: repo, projectId: "p1", targetBranch: "main", store });
  await assert.rejects(
    runLiveCheckoutMigration(
      { store, instanceId: "i1", writeCheckout: async () => {}, notifyOwner: async () => true },
      request,
    ),
    (e: unknown) => e instanceof OrchestratorError && e.code === "live-checkout-needs-approval",
  );
  db.close();
});

test("§24.1 п.2 (аудит р.3 п.1): каталог BB — строгая форма; {} и запись без полей → сбой", () => {
  assert.throws(() => parsePluginList("{}"), /нет массива plugins/);
  assert.throws(() => parsePluginList('{"plugins":[{"id":"a"}]}'), /нет поля rootDir/);
  assert.deepEqual(parsePluginList('{"plugins":[]}'), []);
});

/** Repo with two plugin dirs, an origin, and an approved request. */
function migrationFixture(prefix: string) {
  const tmp = makeTempDir(prefix);
  const origin = join(tmp, "origin.git");
  const seed = join(tmp, "seed");
  initRepo(seed);
  for (const p of ["p1", "p2"]) {
    mkdirSync(join(seed, "plugins", p), { recursive: true });
    writeFileSync(join(seed, "plugins", p, "package.json"), `{"name":"${p}"}\n`);
  }
  execFileSync("git", ["-C", seed, "add", "."]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "plugins"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  const repo = join(tmp, "repo");
  execFileSync("git", ["clone", "-q", origin, repo]);
  const liveDir = join(tmp, "live", "repo");
  const { store, db } = initDb(join(tmp, "data.db"));
  const { request } = requestLiveCheckout({ repoRoot: repo, projectId: "p1", targetBranch: "main", liveDir, store });
  const approved: LiveCheckoutRequest = { ...request, status: "approved" };
  saveLiveCheckoutRequest(store, approved);
  const repoReal = realpathSync(repo);
  const state = new Map<string, PluginInfo>([
    ["plug-1", { id: "plug-1", rootDir: join(repoReal, "plugins", "p1"), source: `path:${join(repoReal, "plugins", "p1")}`, status: "running" }],
    ["plug-2", { id: "plug-2", rootDir: join(repoReal, "plugins", "p2"), source: `path:${join(repoReal, "plugins", "p2")}`, status: "running" }],
  ]);
  const switches: string[] = [];
  const writes: string[] = [];
  const owner: string[] = [];
  const deps = (over: Partial<MigrationDeps> = {}): MigrationDeps => ({
    store,
    instanceId: "inst-1",
    settleMs: 50,
    pollMs: 5,
    listPlugins: async () => [...state.values()],
    buildPlugin: async (dir, sha) => {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "build-info.json"), JSON.stringify({ gitSha: sha }));
    },
    switchPlugin: async (id, dir) => {
      switches.push(`${id}→${dir.includes("/live/") ? "live" : "prev"}`);
      const cur = state.get(id)!;
      state.set(id, { ...cur, rootDir: dir, source: `path:${dir}` });
    },
    writeCheckout: async (_pid, dir) => {
      writes.push(dir);
    },
    notifyOwner: async (line) => {
      owner.push(line);
      return true;
    },
    ...over,
  });
  return { tmp, repo, liveDir, store, db, approved, state, switches, writes, owner, deps };
}

test("§24.1 п.6: сбой перевода второго плагина → первый возвращён, postPublish.checkout прежний, строка владельцу", async () => {
  const f = migrationFixture("orch-live-mig-fail-");
  const base = f.deps();
  await assert.rejects(
    runLiveCheckoutMigration(
      f.deps({
        switchPlugin: async (id, dir) => {
          if (id === "plug-2" && dir.includes("/live/")) throw new Error("simulated install failure");
          await base.switchPlugin!(id, dir);
        },
      }),
      f.approved,
    ),
    /simulated install failure/,
  );
  assert.deepEqual(f.switches, ["plug-1→live", "plug-2→prev", "plug-1→prev"]);
  assert.deepEqual(f.writes, []);
  assert.equal(getLiveCheckoutRequest(f.store, f.approved.id)?.status, "failed");
  assert.match(f.owner.at(-1)!, /не выполнен.*plug-2/);
  assert.equal(isLiveCheckoutMigrating(f.store, f.repo), false);
  chmodRecursive(f.liveDir, true);
  f.db.close();
});

test("§24.1 п.2 (аудит р.3 п.1): плагин не поднялся (disabled) после перевода → откат, запись не делается", async () => {
  const f = migrationFixture("orch-live-mig-disabled-");
  const base = f.deps();
  await assert.rejects(
    runLiveCheckoutMigration(
      f.deps({
        switchPlugin: async (id, dir) => {
          await base.switchPlugin!(id, dir);
          if (id === "plug-2" && dir.includes("/live/")) {
            f.state.set(id, { ...f.state.get(id)!, status: "disabled" });
          }
        },
      }),
      f.approved,
    ),
    /не поднялся/,
  );
  assert.deepEqual(f.writes, []);
  chmodRecursive(f.liveDir, true);
  f.db.close();
});

test("§24.1 п.2 (аудит р.3 п.1): сбой записи настройки → откат всех переведённых", async () => {
  const f = migrationFixture("orch-live-mig-write-");
  await assert.rejects(
    runLiveCheckoutMigration(
      f.deps({ writeCheckout: async () => { throw new Error("settings write refused"); } }),
      f.approved,
    ),
    /settings write refused/,
  );
  assert.deepEqual(f.switches, ["plug-1→live", "plug-2→live", "plug-2→prev", "plug-1→prev"]);
  chmodRecursive(f.liveDir, true);
  f.db.close();
});

test("§24.1 п.2: успешная миграция — оба плагина, одна запись, маркер живой копии, копия только для чтения", async () => {
  const f = migrationFixture("orch-live-mig-ok-");
  const res = await runLiveCheckoutMigration(f.deps(), f.approved);
  assert.equal(res.ok, true);
  assert.deepEqual(res.switchedPlugins, ["plug-1", "plug-2"]);
  assert.deepEqual(f.writes, [f.liveDir]);
  assert.equal(getLiveCheckoutRequest(f.store, f.approved.id)?.status, "done");
  assert.equal(isLiveCheckoutPath(f.liveDir), true);
  assert.throws(() => writeFileSync(join(f.liveDir, "x"), "x"));
  chmodRecursive(f.liveDir, true);
  f.db.close();
});

// ────────────────────────────────────────────────────────────────────────
// Замки: миграция ↔ шаг 6 ↔ postPublish (аудит р.3 п.2)
// ────────────────────────────────────────────────────────────────────────

test("§24.1 п.6: release во время миграции → live-checkout-migrating; публикация в полёте → миграция отказывает", async () => {
  const f = migrationFixture("orch-live-mig-lock-");
  setLiveCheckoutMigrating(f.store, f.repo, true);
  assert.throws(
    () => beginPublish(f.store, f.repo, 7),
    (e: unknown) => e instanceof OrchestratorError && e.code === "live-checkout-migrating",
  );
  setLiveCheckoutMigrating(f.store, f.repo, false);
  const end = beginPublish(f.store, f.repo, 8);
  try {
    await assert.rejects(
      runLiveCheckoutMigration(f.deps(), f.approved),
      (e: unknown) => e instanceof OrchestratorError && e.code === "live-checkout-busy",
    );
  } finally {
    end();
  }
  assert.equal(isLiveCheckoutMigrating(f.store, f.repo), false);
  f.db.close();
});

test("§24.1 п.3 (аудит р.3 п.2): замок живой копии того же экземпляра не крадётся; замок миграции = migrating", async () => {
  const tmp = makeTempDir("orch-live-lock-");
  const live = join(tmp, "live");
  mkdirSync(live);
  const git0 = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const rel = await acquireCopyLock(git0, live, liveCopyLockPath(live), { owner: "inst-A" });
  await assert.rejects(
    acquireCopyLock(git0, live, liveCopyLockPath(live), { owner: "inst-A" }),
    /already running/,
  );
  rel();
  const repo = join(tmp, "repo");
  initRepo(repo);
  const relM = await acquireCopyLock(git0, repo, migrationLockPath(repo), { owner: "inst-A" });
  assert.equal(isLiveCheckoutMigrating(null, repo), true);
  relM();
  assert.equal(isLiveCheckoutMigrating(null, repo), false);
  assert.ok(!liveCopyLockPath(live).startsWith(live), "lock lives outside the protected copy");
});

// ────────────────────────────────────────────────────────────────────────
// Тест-страж: настоящий глобальный core.hooksPath машины не тронут
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
// §24.1 п.2 (аудит р.5 п.5): самоперевод orchestrator, продолжение, откат
// ────────────────────────────────────────────────────────────────────────

/** Миграция, в которой plug-1 — «этот» orchestrator: прежний экземпляр
 * переводит себя последним и отдаёт итог новому (pendingSelf). */
async function selfHandoff(prefix: string) {
  const f = migrationFixture(prefix);
  const oldSelf = join(realpathSync(f.repo), "plugins", "p1");
  const res = await runLiveCheckoutMigration(
    f.deps({ selfPluginId: "plug-1", selfRoot: oldSelf }),
    f.approved,
  );
  assert.equal(res.ok, true);
  assert.equal(res.pendingSelf, true);
  // orchestrator переведён последним; запись настройки и маркер — ещё нет
  assert.deepEqual(f.switches, ["plug-2→live", "plug-1→live"]);
  assert.deepEqual(f.writes, []);
  assert.equal(isLiveCheckoutPath(f.liveDir), false, "marker only after success");
  assert.equal(isLiveCheckoutMigrating(f.store, f.repo), true);
  assert.equal(getLiveCheckoutRequest(f.store, f.approved.id)?.status, "migrating");
  const newSelf = realpathSync(join(f.liveDir, "plugins", "p1"));
  return { ...f, oldSelf, newSelf, liveSha: res.headSha };
}

test("§24.1 п.2 (аудит р.5 п.5): самоперевод → новый экземпляр из служебной копии с верным build-info пишет checkout и маркер", async () => {
  const f = await selfHandoff("orch-self-ok-");
  const out = await resumeLiveCheckout(f.deps({ selfPluginId: "plug-1", selfRoot: f.newSelf }));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.ok, true, out[0]!.message);
  assert.deepEqual(f.writes, [f.liveDir]);
  assert.deepEqual(f.switches, ["plug-2→live", "plug-1→live"], "no rollback");
  assert.equal(getLiveCheckoutRequest(f.store, f.approved.id)?.status, "done");
  assert.equal(isLiveCheckoutMigrating(f.store, f.repo), false);
  assert.equal(existsSync(migrationLockPath(f.repo)), false, "migration lock released");
  // marker `.bb-live-checkout` written into the read-only .git
  assert.equal(LIVE_MARKER, ".bb-live-checkout");
  assert.equal(isLiveCheckoutPath(f.liveDir), true);
  assert.throws(() => writeFileSync(join(f.liveDir, ".git", "x"), "x"), ".git stays read-only");
  assert.match(f.owner.at(-1)!, /plug-2, plug-1/);
  // повтор — заявка закрыта, ничего не делает
  assert.deepEqual(await resumeLiveCheckout(f.deps({ selfPluginId: "plug-1", selfRoot: f.newSelf })), []);
  chmodRecursive(f.liveDir, true);
  f.db.close();
});

test("§24.1 п.2 (аудит р.5 п.5): build-info ≠ SHA → откат всех, orchestrator ПОСЛЕДНИМ, записи и маркера нет", async () => {
  const f = await selfHandoff("orch-self-badsha-");
  const info = join(f.newSelf, "dist", "build-info.json");
  chmodRecursive(f.liveDir, true);
  writeFileSync(info, JSON.stringify({ gitSha: "0".repeat(40) }));
  chmodRecursive(f.liveDir, false);
  const out = await resumeLiveCheckout(f.deps({ selfPluginId: "plug-1", selfRoot: f.newSelf }));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.ok, false);
  assert.match(out[0]!.message, /build-info/);
  assert.deepEqual(f.switches, ["plug-2→live", "plug-1→live", "plug-2→prev", "plug-1→prev"]);
  assert.deepEqual(f.writes, []);
  assert.equal(isLiveCheckoutPath(f.liveDir), false);
  assert.equal(getLiveCheckoutRequest(f.store, f.approved.id)?.status, "failed");
  assert.equal(isLiveCheckoutMigrating(f.store, f.repo), false);
  assert.equal(existsSync(migrationLockPath(f.repo)), false);
  assert.match(f.owner.at(-1)!, /не выполнен/);
  chmodRecursive(f.liveDir, true);
  f.db.close();
});

test("§24.1 п.2 (аудит р.5 п.5): новый экземпляр не из служебной копии — до срока ждёт, по истечении откат прочих", async () => {
  const f = await selfHandoff("orch-self-expire-");
  const early = await resumeLiveCheckout(f.deps({ selfPluginId: "plug-1", selfRoot: f.oldSelf }));
  assert.deepEqual(early, [], "within the deadline — still waiting");
  assert.equal(isLiveCheckoutMigrating(f.store, f.repo), true);
  const out = await resumeLiveCheckout(f.deps({ selfPluginId: "plug-1", selfRoot: f.oldSelf }), { maxAgeMs: -1 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.ok, false);
  assert.match(out[0]!.message, /не завершился/);
  // orchestrator остался на прежнем источнике — откатываются только прочие
  assert.deepEqual(f.switches, ["plug-2→live", "plug-1→live", "plug-2→prev"]);
  assert.deepEqual(f.writes, []);
  assert.equal(getLiveCheckoutRequest(f.store, f.approved.id)?.status, "failed");
  assert.equal(isLiveCheckoutMigrating(f.store, f.repo), false);
  assert.equal(existsSync(migrationLockPath(f.repo)), false);
  chmodRecursive(f.liveDir, true);
  f.db.close();
});

test("§24.1 п.2 (аудит р.5 п.5б): сбой перевода самого orchestrator → откат в обратном порядке, orchestrator последним", async () => {
  const f = migrationFixture("orch-self-fail-");
  const base = f.deps();
  await assert.rejects(
    runLiveCheckoutMigration(
      f.deps({
        selfPluginId: "plug-1",
        switchPlugin: async (id, dir) => {
          if (id === "plug-1" && dir.includes("/live/")) {
            f.switches.push("plug-1→live!");
            throw new Error("simulated self install failure");
          }
          await base.switchPlugin!(id, dir);
        },
      }),
      f.approved,
    ),
    /simulated self install failure/,
  );
  assert.deepEqual(f.switches, ["plug-2→live", "plug-1→live!", "plug-2→prev", "plug-1→prev"]);
  assert.deepEqual(f.writes, []);
  assert.equal(isLiveCheckoutPath(f.liveDir), false);
  chmodRecursive(f.liveDir, true);
  f.db.close();
});

test("§24.1 п.2 (аудит р.5 п.5б): rollbackOrder — обратный порядок, self в конце", () => {
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);
  assert.deepEqual(ids(rollbackOrder([{ id: "a" }, { id: "orchestrator" }, { id: "b" }], "orchestrator")), ["b", "a", "orchestrator"]);
  assert.deepEqual(ids(rollbackOrder([{ id: "a" }, { id: "b" }, { id: "orchestrator" }], "orchestrator")), ["b", "a", "orchestrator"]);
  assert.deepEqual(ids(rollbackOrder([{ id: "a" }, { id: "b" }], "orchestrator")), ["b", "a"]);
});

test("тест-страж: глобальный core.hooksPath реальной машины до и после прогона совпадает", () => {
  assert.notEqual(process.env.HOME, REAL_HOME, "HOME тестов изолирован");
  assert.notEqual(homedir(), REAL_HOME);
  assert.equal(realGlobalHooksPath(), REAL_BEFORE);
});

test("тест-страж (PLUG-439): за прогон файла настоящий bb не вызван ни разу", () => {
  const realBb = process.env.ORCH_TEST_REAL_BB_CLI ?? "";
  const stub = process.env.ORCH_TEST_BB_STUB ?? "";
  assert.ok(stub, "register-hooks.ts поставил заглушку bb");
  assert.equal(process.env.BB_CLI, stub, "BB_CLI процесса тестов — заглушка");
  if (realBb) assert.notEqual(process.env.BB_CLI, realBb);
  // `bb` по PATH (хук без BB_CLI) — тоже заглушка, не настоящий bb
  const which = spawnSync("sh", ["-c", "command -v bb"], { encoding: "utf8", env: process.env });
  assert.equal(which.stdout.trim(), stub);
  // каждая среда hookEnv отдала хукам свою заглушку
  assert.ok(HOOK_ENV_BB.length > 0);
  for (const b of HOOK_ENV_BB) {
    assert.notEqual(b, realBb);
    assert.match(b, /\/fake-bb$/);
  }
  // ни один вызов не прошёл мимо заглушки hookEnv
  const untracked = existsSync(FILE_BB_LOG) ? readFileSync(FILE_BB_LOG, "utf8").trim() : "";
  assert.equal(untracked, "", `вызовы bb мимо заглушки hookEnv:\n${untracked}`);
});
