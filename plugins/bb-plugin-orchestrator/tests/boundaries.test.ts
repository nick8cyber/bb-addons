/**
 * Acceptance test suite for orchestrator §24.1 (PLUG-410):
 * Границы для агентов кодом (§24 п.1–4) и установка хуков.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { makeTempDir } from "./helpers/temp.js";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import {
  HOOK_NAMES,
  installHooks,
  runHooksDoctor,
  writeChainConfig,
  readChainConfig,
} from "../src/hooks.js";
import {
  setupLiveCheckout,
  chmodRecursive,
  isLiveCheckoutMigrating,
  setLiveCheckoutMigrating,
} from "../src/live-checkout.js";
import { OrchestratorError } from "../src/errors.js";
import { runRelease, type ReleaseDeps } from "../src/release.js";

const HOOKS_SRC = fileURLToPath(new URL("../hooks", import.meta.url));
const PC_SRC = join(HOOKS_SRC, "pre-commit");
const SCAN_SRC = join(HOOKS_SRC, "leak-scan.ts");
const CHAIN_SRC = join(HOOKS_SRC, "chain");
const REF_SRC = join(HOOKS_SRC, "reference-transaction");

function initRepo(repoPath: string, branch = "main"): void {
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", repoPath], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "agent@bb.local"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "BB Agent"]);
  execFileSync("git", ["-C", repoPath, "checkout", "-B", branch], { stdio: "ignore" });
  execFileSync("git", ["-c", "core.hooksPath=", "-C", repoPath, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
}

function setupTestHooksDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const name of HOOK_NAMES) {
    const src = (name === "pre-commit" || name === "pre-push" || name === "post-checkout" || name === "reference-transaction")
      ? join(HOOKS_SRC, name)
      : CHAIN_SRC;
    const dst = join(dir, name);
    copyFileSync(src, dst);
    chmodSync(dst, 0o755);
  }
  copyFileSync(SCAN_SRC, join(dir, "leak-scan.ts"));
  writeFileSync(join(dir, "exclusions"), "");
}

function initDb(dbPath: string): { db: InstanceType<typeof Database>; store: DelegationStore } {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  for (const m of MIGRATIONS) {
    db.exec(m);
  }
  const store = new DelegationStore(db);
  return { db, store };
}

// ────────────────────────────────────────────────────────────────────────────
// §24.1 п.6: Тесты 1–5 — hooks doctor и chain wrapper
// ────────────────────────────────────────────────────────────────────────────

test("§24.1 п.6 (1): hooks doctor на копии с локальным core.hooksPath возвращает код 2", async () => {
  const tmp = makeTempDir("orch-hook-doc-1-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  initRepo(repo);
  setupTestHooksDir(hooksDir);

  // Настраиваем локальный core.hooksPath
  execFileSync("git", ["-C", repo, "config", "--local", "core.hooksPath", "/tmp/local-hooks"]);

  const res = await runHooksDoctor({ copy: repo, hooksDir });
  assert.equal(res.code, 2);
  assert.equal(res.ok, false);
  const issue = res.issues.find((i) => i.type === "local-hooks-path");
  assert.ok(issue, "должна быть найдена проблема local-hooks-path");
  assert.match(res.message, /локальный core\.hooksPath/);
});

test("§24.1 п.6 (2): hooks doctor на копии без исполняемого pre-commit возвращает код 2", async () => {
  const tmp = makeTempDir("orch-hook-doc-2-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  initRepo(repo);
  setupTestHooksDir(hooksDir);

  // Снимаем права на исполнение с pre-commit
  chmodSync(join(hooksDir, "pre-commit"), 0o644);

  const res = await runHooksDoctor({ copy: repo, hooksDir });
  assert.equal(res.code, 2);
  assert.equal(res.ok, false);
  const issue = res.issues.find((i) => i.type === "non-executable-hook");
  assert.ok(issue, "должна быть найдена проблема non-executable-hook");
  assert.match(res.message, /не имеют флага исполнения/);
});

test("§24.1 п.6 (3): hooks doctor на hooksDir без commit-msg возвращает код 2 со списком", async () => {
  const tmp = makeTempDir("orch-hook-doc-3-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  initRepo(repo);
  setupTestHooksDir(hooksDir);

  // Удаляем commit-msg
  rmSync(join(hooksDir, "commit-msg"), { force: true });

  const res = await runHooksDoctor({ copy: repo, hooksDir });
  assert.equal(res.code, 2);
  assert.equal(res.ok, false);
  const issue = res.issues.find((i) => i.type === "missing-hook");
  assert.ok(issue, "должна быть найдена проблема missing-hook");
  assert.match(res.message, /commit-msg/);
});

test("§24.1 п.6 (4): локальный commit-msg хук репозитория срабатывает через обёртку chain", () => {
  const tmp = makeTempDir("orch-hook-doc-4-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  initRepo(repo);
  setupTestHooksDir(hooksDir);

  // Создаём локальный .git/hooks/commit-msg, записывающий маркер
  const localHook = join(repo, ".git", "hooks", "commit-msg");
  const marker = join(tmp, "commit-msg-ran");
  writeFileSync(localHook, `#!/bin/sh\necho "marker" > "${marker}"\nexit 0\n`);
  chmodSync(localHook, 0o755);

  const msgFile = join(tmp, "msg.txt");
  writeFileSync(msgFile, "test commit message\n");

  const chainWrapper = join(hooksDir, "commit-msg");
  const r = spawnSync(chainWrapper, [msgFile], {
    cwd: repo,
    env: { ...process.env, GIT_DIR: join(repo, ".git") },
    encoding: "utf8",
  });

  assert.equal(r.status, 0, `wrapper exit 0: ${r.stderr}`);
  assert.ok(existsSync(marker), "локальный хук должен был создасть маркер");
});

test("§24.1 п.6 (5): отсутствие push-to-checkout в ~/.bb/git-hooks НЕ считается ошибкой в doctor", async () => {
  const tmp = makeTempDir("orch-hook-doc-5-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  initRepo(repo);
  setupTestHooksDir(hooksDir);

  // Убеждаемся, что push-to-checkout отсутствует
  assert.equal(existsSync(join(hooksDir, "push-to-checkout")), false);

  const res = await runHooksDoctor({
    copy: repo,
    hooksDir,
    runCmd: (cmd, args) => {
      if (cmd === "git" && args.includes("--git-path")) {
        return hooksDir;
      }
      return "";
    },
  });
  assert.equal(res.code, 0);
  assert.equal(res.ok, true);
  assert.equal(res.issues.length, 0);
});

test("§24.1 п.6 (6): install с прежним глобальным core.hooksPath сохраняет его в chain.json", async () => {
  const tmp = makeTempDir("orch-hook-doc-6-");
  const hooksDir = join(tmp, "hooks");
  const prevGlobal = join(tmp, "prev-global-hooks");
  mkdirSync(prevGlobal, { recursive: true });

  const customCmds: Array<{ cmd: string; args: string[] }> = [];
  const fakeCmd = (cmd: string, args: string[]) => {
    customCmds.push({ cmd, args });
    if (cmd === "git" && args[0] === "config" && args[1] === "--global" && args[2] === "core.hooksPath" && args.length === 3) {
      return prevGlobal;
    }
    return "";
  };

  const res = await installHooks({
    hooksDir,
    runCmd: fakeCmd,
  });

  assert.equal(res.ok, true);
  const chain = readChainConfig(hooksDir);
  assert.equal(chain.previousGlobalHooksPath, resolve(prevGlobal));
});

// ────────────────────────────────────────────────────────────────────────────
// §24.1 п.6: Тесты 7–11 — коммиты агентов по ролям (pre-commit)
// ────────────────────────────────────────────────────────────────────────────

function runPc(repo: string, hooksDir: string, env: Record<string, string>) {
  return spawnSync("node", [join(hooksDir, "pre-commit")], {
    cwd: repo,
    env: { ...process.env, GIT_DIR: join(repo, ".git"), ...env },
    encoding: "utf8",
  });
}

test("§24.1 п.6 (7): коммит координатора только с docs/ проходит", () => {
  const tmp = makeTempDir("orch-hook-coord-1-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  const dbPath = join(tmp, "data.db");
  initRepo(repo, "task/feature-1");
  setupTestHooksDir(hooksDir);

  const { db, store } = initDb(dbPath);
  try {
    store.setThreadRole("thr_coord", "orchestrator", "hook");

    // Добавляем файл только в docs/
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "spec.md"), "# Spec\n");
    execFileSync("git", ["-C", repo, "add", "docs/spec.md"]);

    const r = runPc(repo, hooksDir, {
      BB_THREAD_ID: "thr_coord",
      ORCHESTRATOR_DB_PATH: dbPath,
    });

    assert.equal(r.status, 0, `pre-commit should succeed: ${r.stderr}`);
  } finally {
    db.close();
  }
});

test("§24.1 п.6 (8): коммит координатора с plugins/ отказ «координатор код не пишет: delegate»", () => {
  const tmp = makeTempDir("orch-hook-coord-2-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  const dbPath = join(tmp, "data.db");
  initRepo(repo, "task/feature-1");
  setupTestHooksDir(hooksDir);

  const { db, store } = initDb(dbPath);
  try {
    store.setThreadRole("thr_coord", "orchestrator", "hook");

    mkdirSync(join(repo, "plugins", "test"), { recursive: true });
    writeFileSync(join(repo, "plugins", "test", "index.ts"), "export const x = 1;\n");
    execFileSync("git", ["-C", repo, "add", "plugins/test/index.ts"]);

    const r = runPc(repo, hooksDir, {
      BB_THREAD_ID: "thr_coord",
      ORCHESTRATOR_DB_PATH: dbPath,
    });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /координатор код не пишет: delegate/);
  } finally {
    db.close();
  }
});

test("§24.1 п.6 (9): коммит координатора со смешанным docs/ + plugins/ отказ со списком путей", () => {
  const tmp = makeTempDir("orch-hook-coord-3-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  const dbPath = join(tmp, "data.db");
  initRepo(repo, "task/feature-1");
  setupTestHooksDir(hooksDir);

  const { db, store } = initDb(dbPath);
  try {
    store.setThreadRole("thr_coord", "orchestrator", "hook");

    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "spec.md"), "# Spec\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "code.ts"), "const a = 1;\n");
    execFileSync("git", ["-C", repo, "add", "docs/spec.md", "src/code.ts"]);

    const r = runPc(repo, hooksDir, {
      BB_THREAD_ID: "thr_coord",
      ORCHESTRATOR_DB_PATH: dbPath,
    });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /координатор код не пишет: delegate \(пути вне docs: src\/code\.ts\)/);
  } finally {
    db.close();
  }
});

test("§24.1 п.6 (10): корневой executor на рабочей ветке проходит, на main отказ, в копии координатора отказ", () => {
  const tmp = makeTempDir("orch-hook-exec-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  const dbPath = join(tmp, "data.db");
  initRepo(repo, "task/fix-bug");
  setupTestHooksDir(hooksDir);

  const { db, store } = initDb(dbPath);
  try {
    // В thread_roles роль executor, но строки в delegations нет
    store.setThreadRole("thr_root_exec", "executor", "hook");

    // 10.1: В собственной копии на рабочей ветке — проходит
    writeFileSync(join(repo, "fix.ts"), "const fix = true;\n");
    execFileSync("git", ["-C", repo, "add", "fix.ts"]);

    const r1 = runPc(repo, hooksDir, {
      BB_THREAD_ID: "thr_root_exec",
      ORCHESTRATOR_DB_PATH: dbPath,
    });
    assert.equal(r1.status, 0, `executor on feature branch should succeed: ${r1.stderr}`);

    // 10.2: На ветке main — отказ
    execFileSync("git", ["-C", repo, "checkout", "-b", "main"], { stdio: "ignore" });
    const r2 = runPc(repo, hooksDir, {
      BB_THREAD_ID: "thr_root_exec",
      ORCHESTRATOR_DB_PATH: dbPath,
    });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /в целевую ветку не коммитят, работай в копии задачи/);

    // 10.3: В копии координатора — отказ
    execFileSync("git", ["-C", repo, "checkout", "-b", "task/fix-bug-2"], { stdio: "ignore" });
    db.prepare(
      "INSERT INTO coordinator_worktrees (project_id, coordinator_thread_id, env_id, worktree_path, state, created_at, updated_at) VALUES ('proj_1', 'thr_coord', 'env_1', ?, 'active', 1, 1)",
    ).run(repo);

    const r3 = runPc(repo, hooksDir, {
      BB_THREAD_ID: "thr_root_exec",
      ORCHESTRATOR_DB_PATH: dbPath,
    });
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /коммит вне копии задачи/);
  } finally {
    db.close();
  }
});

test("§24.1 п.6 (11): коммит helper отказ «помощник не коммитит, итог — текстом вызвавшему»", () => {
  const tmp = makeTempDir("orch-hook-helper-");
  const repo = join(tmp, "repo");
  const hooksDir = join(tmp, "hooks");
  const dbPath = join(tmp, "data.db");
  initRepo(repo, "task/helper-work");
  setupTestHooksDir(hooksDir);

  const { db, store } = initDb(dbPath);
  try {
    db.prepare(
      "INSERT INTO helpers (caller_thread_id, coordinator_thread_id, thread_id, preset, status, created_at, updated_at) VALUES ('thr_parent', 'thr_coord', 'thr_hlp', 'preset', 'running', 1, 1)",
    ).run();

    writeFileSync(join(repo, "helper.ts"), "const h = 1;\n");
    execFileSync("git", ["-C", repo, "add", "helper.ts"]);

    const r = runPc(repo, hooksDir, {
      BB_THREAD_ID: "thr_hlp",
      ORCHESTRATOR_DB_PATH: dbPath,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /помощник не коммитит, итог — текстом вызвавшему/);
  } finally {
    db.close();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// §24.1 п.6: Тесты 12–16 — live checkout, token gate и миграция
// ────────────────────────────────────────────────────────────────────────────

test("§24.1 п.6 (12): коммит, checkout и merge в живой копии без токена отвергаются", () => {
  const tmp = makeTempDir("orch-live-protect-");
  const liveDir = join(tmp, ".bb", "plugin-live", "my-repo");
  const hooksDir = join(tmp, "hooks");
  initRepo(liveDir, "main");
  setupTestHooksDir(hooksDir);

  // Настраиваем защиту: chmod a-w
  chmodRecursive(liveDir, false);

  // 1. Попытка создания / записи файла в read-only дерево пресекается ФС
  assert.throws(() => {
    writeFileSync(join(liveDir, "exploit.ts"), "hack");
  });

  // 2. reference-transaction hook блокирует обновление ref без токена
  const refHook = join(hooksDir, "reference-transaction");
  const stdinLine = `0000000000000000000000000000000000000000 ${"a".repeat(40)} refs/heads/newbranch\n`;
  const r = spawnSync("node", [refHook, "prepared"], {
    cwd: liveDir,
    input: stdinLine,
    env: { ...process.env, GIT_DIR: join(liveDir, ".git") },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /изменение ссылок в служебной живой копии/);
});

test("§24.1 п.6 (13): postPublish с токеном: fast-forward успешен", () => {
  const tmp = makeTempDir("orch-live-token-");
  const liveDir = join(tmp, ".bb", "plugin-live", "my-repo");
  const hooksDir = join(tmp, "hooks");
  initRepo(liveDir, "main");
  setupTestHooksDir(hooksDir);

  chmodRecursive(liveDir, false);

  // Проверяем, что с токеном reference-transaction пропускает
  const token = "valid-test-token-123";
  const tokenFile = join(dirname(liveDir), ".token");
  writeFileSync(
    tokenFile,
    JSON.stringify({
      token,
      repo: liveDir,
      expiresAt: Date.now() + 60_000,
    }),
  );

  const refHook = join(hooksDir, "reference-transaction");
  const stdinLine = `0000000000000000000000000000000000000000 ${"a".repeat(40)} refs/heads/main\n`;

  const r = spawnSync("node", [refHook, "prepared"], {
    cwd: liveDir,
    input: stdinLine,
    env: { ...process.env, GIT_DIR: join(liveDir, ".git"), ORCH_LIVE_TOKEN: token },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `reference-transaction with token should pass: ${r.stderr}`);
});

test("§24.1 п.6 (14): live-checkout setup без одобрения даёт отказ live-checkout-needs-approval", async () => {
  const tmp = makeTempDir("orch-live-setup-1-");
  const repo = join(tmp, "repo");
  initRepo(repo);

  await assert.rejects(
    async () => {
      await setupLiveCheckout({
        repoRoot: repo,
        approved: false,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "live-checkout-needs-approval");
      return true;
    },
  );
});

test("§24.1 п.6 (15): сбой на 2-м плагине при setup — откат 1-го плагина, postPublish.checkout не изменился", async () => {
  const tmp = makeTempDir("orch-live-setup-2-");
  const repo = join(tmp, "repo");
  const liveDir = join(tmp, ".bb", "plugin-live", "repo");
  const dbPath = join(tmp, "data.db");
  initRepo(repo);

  const { store } = initDb(dbPath);

  const switchedBack: string[] = [];
  const switchedTo: string[] = [];
  let updateConfigCalled = false;

  await assert.rejects(
    async () => {
      await setupLiveCheckout({
        repoRoot: repo,
        approved: true,
        liveDir,
        store,
        pluginsToMigrate: [
          { id: "plugin-1", dirName: "p1", currentSourceDir: "/original/p1" },
          { id: "plugin-2", dirName: "p2", currentSourceDir: "/original/p2" },
        ],
        onBuildPlugins: async () => {},
        onSwitchPlugin: async (pluginId, newDir) => {
          if (newDir.includes("/original/")) {
            switchedBack.push(pluginId);
          } else {
            switchedTo.push(pluginId);
            if (pluginId === "plugin-2") {
              throw new Error("simulated failure on plugin-2");
            }
          }
        },
        updateReleaseConfigCheckout: async () => {
          updateConfigCalled = true;
        },
      });
    },
    (err: unknown) => {
      assert.match(String(err), /simulated failure on plugin-2/);
      return true;
    },
  );

  assert.deepEqual(switchedTo, ["plugin-1", "plugin-2"]);
  assert.deepEqual(switchedBack, ["plugin-1"], "plugin-1 должен быть откачен назад");
  assert.equal(updateConfigCalled, false, "updateReleaseConfigCheckout не должен был вызываться");
  assert.equal(isLiveCheckoutMigrating(store, repo), false, "migrating flag должен быть сброшен");
});

test("§24.1 п.6 (16): release во время миграции отказывает с live-checkout-migrating (флаг миграции блокирует release)", () => {
  const tmp = makeTempDir("orch-live-migrating-");
  const repo = join(tmp, "repo");
  const dbPath = join(tmp, "data.db");
  initRepo(repo);

  const { store } = initDb(dbPath);
  assert.equal(isLiveCheckoutMigrating(store, repo), false);
  setLiveCheckoutMigrating(store, repo, true);
  assert.equal(isLiveCheckoutMigrating(store, repo), true);
  setLiveCheckoutMigrating(store, repo, false);
  assert.equal(isLiveCheckoutMigrating(store, repo), false);
});
