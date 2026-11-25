import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeTempDir } from "./helpers/temp.js";
import { writePushToken } from "../src/release.js";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import {
  HOOK_NAMES,
  SPECIALIZED_HOOK_NAMES,
  HOOK_SUPPORT_FILES,
  installHooks,
  runHooksDoctor,
  collectProjectsRegistry,
} from "../src/hooks.js";
import {
  IP_VERSION_LIKE,
  LEAK_GHP_SECRET,
  LEAK_HOME_PREFIX,
  LEAK_MACHINE_PATH,
  LEAK_PERSONAL_EMAIL,
  LEAK_PRIVATE_IP,
  LEAK_THREAD_ID,
} from "./fixtures/leak-samples.js";

const HOOK_SRC = new URL("../hooks/pre-push", import.meta.url).pathname;
const PC_SRC = new URL("../hooks/pre-commit", import.meta.url).pathname;
const SCAN_SRC = new URL("../hooks/leak-scan.ts", import.meta.url).pathname;
const LIB_SRC = new URL("../hooks/hook-lib.mjs", import.meta.url).pathname;
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function makeEnv(withLocalHook = false) {
  const base = makeTempDir("hookenv-");
  const hooksDir = join(base, "global-hooks");
  const repo = join(base, "repo");
  mkdirSync(hooksDir, { recursive: true });
  cpSync(HOOK_SRC, join(hooksDir, "pre-push"));
  cpSync(LIB_SRC, join(hooksDir, "hook-lib.mjs"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "a@b.c"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  if (withLocalHook) {
    const local = join(repo, ".git", "hooks", "pre-push");
    writeFileSync(local, "#!/bin/sh\necho LOCAL > \"$GIT_DIR/../local-ran\"\nexit 0\n");
    execFileSync("chmod", ["+x", local]);
  }
  return { base, hooksDir, repo };
}

function runHook(repo: string, hooksDir: string, refline: string) {
  return spawnSync("node", [join(hooksDir, "pre-push")], {
    cwd: repo,
    input: refline,
    env: { ...process.env, GIT_DIR: join(repo, ".git") },
    encoding: "utf8",
  });
}

const LINE = `refs/heads/x ${SHA} refs/heads/x 0000000000000000000000000000000000000000`;

test("hook: no token → refuse with release hint", () => {
  const { repo, hooksDir } = makeEnv();
  const r = runHook(repo, hooksDir, LINE + "\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /orchestrator release/);
});

test("hook: valid token+sha → pass, token consumed, local hook runs", () => {
  const { repo, hooksDir } = makeEnv(true);
  const file = writePushToken(hooksDir, SHA, "x");
  const r = runHook(repo, hooksDir, LINE + "\n");
  assert.equal(r.status, 0);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(join(repo, "local-ran")), true);
});

test("hook: token for another sha → refuse, token kept", () => {
  const { repo, hooksDir } = makeEnv();
  const file = writePushToken(hooksDir, OTHER, "x");
  const r = runHook(repo, hooksDir, LINE + "\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /другой коммит/);
  assert.equal(existsSync(file), true);
});

// §16.6: the token binds the BRANCH too — a valid sha pushed to a
// different branch is refused.
test("hook: token for another branch, same sha → refuse, token kept", () => {
  const { repo, hooksDir } = makeEnv();
  const file = writePushToken(hooksDir, SHA, "y");
  const r = runHook(repo, hooksDir, LINE + "\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /другую ветку/);
  assert.equal(existsSync(file), true);
});

// §16.6: a file per release run — two parallel releases coexist; the
// hook consumes only the token of the pushed branch.
test("hook: two tokens on different branches — right one consumed", () => {
  const { repo, hooksDir } = makeEnv();
  const fileX = writePushToken(hooksDir, SHA, "x");
  const fileY = writePushToken(hooksDir, SHA, "y");
  const line = `refs/heads/y ${SHA} refs/heads/y ${"0".repeat(40)}\n`;
  const r = runHook(repo, hooksDir, line);
  assert.equal(r.status, 0);
  assert.equal(existsSync(fileY), false); // consumed
  assert.equal(existsSync(fileX), true);  // the other release's marker stays
});

test("hook: expired token → refuse", () => {
  const { repo, hooksDir } = makeEnv();
  writeFileSync(
    join(hooksDir, "push-token-stale.json"),
    JSON.stringify({
      token: "t",
      sha: SHA,
      branch: "x",
      expiresAt: Date.now() - 1,
    }),
  );
  const r = runHook(repo, hooksDir, LINE + "\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /истёк/);
});

// §16.6 (PLUG-191): a token must bind the branch — a branchless token
// is refused in ANY file, including the legacy `push-token.json` name.
test("hook: legacy branchless push-token.json → refuse (PLUG-191)", () => {
  const { repo, hooksDir } = makeEnv(true);
  const legacy = join(hooksDir, "push-token.json");
  writeFileSync(
    legacy,
    JSON.stringify({
      token: "t",
      sha: SHA,
      expiresAt: Date.now() + 60_000,
    }),
  );
  const r = runHook(repo, hooksDir, LINE + "\n");
  assert.equal(r.status, 1);
  assert.equal(existsSync(legacy), true); // not a token — not consumed
  assert.equal(existsSync(join(repo, "local-ran")), false);
});

test("hook: branchless push-token-<id>.json is not a token → refuse", () => {
  const { repo, hooksDir } = makeEnv();
  writeFileSync(
    join(hooksDir, "push-token-abc.json"),
    JSON.stringify({
      token: "t",
      sha: SHA,
      expiresAt: Date.now() + 60_000,
    }),
  );
  const r = runHook(repo, hooksDir, LINE + "\n");
  assert.equal(r.status, 1);
});

// §16.6 (PLUG-189): the branch is compared to the FULL pushed ref — a
// token for branch `v1` must not pass a `refs/tags/v1` push.
test("hook: a branch token never satisfies a tag push", () => {
  const { repo, hooksDir } = makeEnv();
  writePushToken(hooksDir, SHA, "v1");
  const line = `refs/tags/v1 ${SHA} refs/tags/v1 ${"0".repeat(40)}\n`;
  const r = runHook(repo, hooksDir, line);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /другую ветку/);
});

test("hook: exclusions file skips the gate", () => {
  const { repo, hooksDir } = makeEnv();
  const top = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  writeFileSync(join(hooksDir, "exclusions"), `${top}\n`);
  const r = runHook(repo, hooksDir, LINE + "\n");
  assert.equal(r.status, 0);
});

test("f4/f6: installer inventory sees .bb worktrees, real --self-test run", () => {
  const root = makeTempDir("inv-");
  const wtRoot = join(root, ".bb", "plugins", "environment-git-worktree", "host-data", "worktrees", "x");
  mkdirSync(wtRoot, { recursive: true });
  execFileSync("git", ["init", wtRoot]);
  const out = execFileSync("node", ["hooks/install.mjs", "--dry-run", "--repos-root", root], {
    cwd: new URL("..", import.meta.url).pathname, encoding: "utf8",
  });
  assert.match(out, new RegExp(wtRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out, /excluded:true/); // f5 hint

  const st = execFileSync("node", [
    "hooks/install.mjs",
    "--self-test",
    "--hooks-dir", join(root, "hd"),
  ], {
    cwd: new URL("..", import.meta.url).pathname, encoding: "utf8",
  });
  assert.match(st, /all \d+ wrappers chain: plain/);
  assert.match(st, /all \d+ wrappers chain: worktree/);
  // §17.3 (ревью PLUG-214): the server-side names exist for bare
  // repositories — the self-test exercises that shape too
  assert.match(st, /all \d+ wrappers chain: bare/);
  assert.match(st, /OK  self-test passed/);
  // N2: live hooksDir untouched — no fake token left behind
  assert.equal(
    existsSync(join(root, "hd"))
      ? readdirSync(join(root, "hd")).filter((f) =>
          /^push-token(?:-.+)?\.json$/.test(f),
        ).length
      : 0,
    0,
  );
});

// ── §17.3 r26: обёртки всех имён хуков, единый каталог токенов ────────

const PLUGIN_DIR = new URL("..", import.meta.url).pathname;
const HOOKS_SRC = join(PLUGIN_DIR, "hooks");
const CHAIN_SRC = new URL("../hooks/chain", import.meta.url).pathname;
const NAMES_SRC = new URL("../hooks/hook-names", import.meta.url).pathname;

test("Б2/мелко9: installer covers every standard hook name; shared token dir", () => {
  const root = makeTempDir("install-");
  const gd = join(root, "hooks");
  const gcfg = join(root, "gitconfig");
  execFileSync(
    "node",
    ["hooks/install.mjs", "--hooks-dir", gd, "--repos-root", join(root, "empty")],
    {
      cwd: PLUGIN_DIR,
      encoding: "utf8",
      // redirect the global git config — the real --global write must not
      // touch the developer's config
      env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg },
    },
  );
  const names = readFileSync(NAMES_SRC, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const gateSrc = readFileSync(HOOK_SRC, "utf8");
  const pcSrc = readFileSync(PC_SRC, "utf8");
  const postCheckoutSrc = readFileSync(join(HOOKS_SRC, "post-checkout"), "utf8");
  const refTxSrc = readFileSync(join(HOOKS_SRC, "reference-transaction"), "utf8");
  const chainSrc = readFileSync(CHAIN_SRC, "utf8");
  for (const n of names) {
    const f = join(gd, n);
    assert.ok(existsSync(f), `${n} installed`);
    // specialized hooks carry gates; the rest are chain wrappers
    const expected =
      n === "pre-push"
        ? gateSrc
        : n === "pre-commit"
          ? pcSrc
          : n === "post-checkout"
            ? postCheckoutSrc
            : n === "reference-transaction"
              ? refTxSrc
              : chainSrc;
    assert.equal(readFileSync(f, "utf8"), expected);
  }
  // §22.1: the shared scanner core lands next to the hooks.
  assert.ok(existsSync(join(gd, "leak-scan.ts")), "leak-scan.ts installed");
  assert.ok(existsSync(join(gd, "hook-lib.mjs")), "hook-lib.mjs installed");
  assert.match(readFileSync(gcfg, "utf8"), /hookspath/i);
  // the token dir is the SAME dir the installer installs into — the
  // plugin's writePushToken lands where the installed hook scans
  const repo = join(root, "repo");
  execFileSync("git", ["init", repo]);
  const file = writePushToken(gd, SHA, "x");
  const r = spawnSync("node", [join(gd, "pre-push")], {
    cwd: repo,
    input: LINE + "\n",
    env: { ...process.env, GIT_DIR: join(repo, ".git") },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(existsSync(file), false);
});

test("Б2: a non-pre-push wrapper chains the repository-local hook", () => {
  const { repo, hooksDir } = makeEnv();
  cpSync(CHAIN_SRC, join(hooksDir, "pre-commit"));
  execFileSync("chmod", ["+x", join(hooksDir, "pre-commit")]);
  writeFileSync(
    join(repo, ".git", "hooks", "pre-commit"),
    '#!/bin/sh\necho hit > "$GIT_DIR/../precommit-ran"\nexit 0\n',
  );
  execFileSync("chmod", ["+x", join(repo, ".git", "hooks", "pre-commit")]);
  const r = spawnSync(join(hooksDir, "pre-commit"), [], {
    cwd: repo,
    env: { ...process.env, GIT_DIR: join(repo, ".git") },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(repo, "precommit-ran")), true);
  // no local hook at all → pass-through exit 0
  const { repo: bare, hooksDir: hd2 } = makeEnv();
  cpSync(CHAIN_SRC, join(hd2, "commit-msg"));
  execFileSync("chmod", ["+x", join(hd2, "commit-msg")]);
  const r2 = spawnSync(join(hd2, "commit-msg"), ["msg-file"], {
    cwd: bare,
    env: { ...process.env, GIT_DIR: join(bare, ".git") },
    encoding: "utf8",
  });
  assert.equal(r2.status, 0);
});

// ── ревью PLUG-210: исполняемость, полнота имён, каталог токенов ────

test("§17.3 (PLUG-210): chain skips a NON-executable local hook — git semantics", () => {
  const { repo, hooksDir } = makeEnv();
  cpSync(CHAIN_SRC, join(hooksDir, "pre-commit"));
  execFileSync("chmod", ["+x", join(hooksDir, "pre-commit")]);
  // a local hook WITHOUT the exec bit — git itself would skip it; the
  // wrapper must not turn that into an error (or run it anyway)
  writeFileSync(
    join(repo, ".git", "hooks", "pre-commit"),
    '#!/bin/sh\necho hit > "$GIT_DIR/../precommit-ran"\nexit 0\n',
  ); // no chmod — stays 0644
  const r = spawnSync(join(hooksDir, "pre-commit"), [], {
    cwd: repo,
    env: { ...process.env, GIT_DIR: join(repo, ".git") },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(repo, "precommit-ran")), false);
});

test("§17.3 (PLUG-210): pre-push chains only to an EXECUTABLE local hook", () => {
  const { repo, hooksDir } = makeEnv();
  writeFileSync(
    join(repo, ".git", "hooks", "pre-push"),
    '#!/bin/sh\necho hit > "$GIT_DIR/../local-ran"\nexit 0\n',
  ); // no chmod
  const file = writePushToken(hooksDir, SHA, "x");
  const r = runHook(repo, hooksDir, LINE + "\n");
  // the gate passes (valid token) and the non-executable local hook is
  // skipped instead of crashing the push with EACCES
  assert.equal(r.status, 0);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(join(repo, "local-ran")), false);
});

test("§17.3 / §24.1: hook-names covers every githooks(5) name (exactly 27 names, p4-* included)", () => {
  const names = new Set(
    readFileSync(NAMES_SRC, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  assert.equal(names.size, 27);
  // the full githooks(5) inventory — client AND receive-pack hooks,
  // EXCEPT push-to-checkout (ревью PLUG-214: the hook's mere presence
  // disables git's built-in worktree update on updateInstead pushes)
  for (const n of [
    "applypatch-msg", "pre-applypatch", "post-applypatch",
    "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg",
    "post-commit", "pre-rebase", "post-checkout", "post-merge",
    "pre-push", "pre-receive", "update", "proc-receive", "post-receive",
    "post-update", "reference-transaction",
    "pre-auto-gc", "post-rewrite", "sendemail-validate",
    "fsmonitor-watchman", "post-index-change",
    "p4-changelist", "p4-prepare-changelist", "p4-post-changelist",
    "p4-pre-submit",
  ]) {
    assert.ok(names.has(n), `hook-names missing ${n}`);
  }
  assert.ok(
    !names.has("push-to-checkout"),
    "push-to-checkout must never be wrapped",
  );
});

test("§17.3 (PLUG-210): installer takes the token dir from `bb orchestrator hooks-dir`", () => {
  const root = makeTempDir("install-dir-");
  const pluginDir = join(root, "plugin-hooks");
  // a stub `bb` answering `orchestrator hooks-dir` with the plugin's dir
  const bbStub = join(root, "bb-stub");
  writeFileSync(bbStub, `#!/bin/sh\necho "${pluginDir}"\n`);
  execFileSync("chmod", ["+x", bbStub]);
  const gcfg = join(root, "gitconfig");
  execFileSync(
    "node",
    ["hooks/install.mjs", "--repos-root", join(root, "empty")],
    {
      cwd: PLUGIN_DIR,
      encoding: "utf8",
      env: { ...process.env, BB_CLI: bbStub, GIT_CONFIG_GLOBAL: gcfg },
    },
  );
  // the install landed where the plugin reports — not the hard-coded
  // ~/.bb path the installer used to compute on its own
  assert.ok(existsSync(join(pluginDir, "pre-push")));
  assert.ok(existsSync(join(pluginDir, "update")));
});

// ── ревью PLUG-214: без push-to-checkout, отказы установщика ──────────

test("§17.3 (PLUG-214): install removes a stale push-to-checkout wrapper", () => {
  const root = makeTempDir("install-retire-");
  const gd = join(root, "hooks");
  mkdirSync(gd, { recursive: true });
  // a pre-fix install left the retired wrapper — the update must remove
  // it, else every updateInstead push on the machine stays broken
  writeFileSync(join(gd, "push-to-checkout"), "#!/bin/sh\n# stale\n");
  const gcfg = join(root, "gitconfig");
  execFileSync(
    "node",
    ["hooks/install.mjs", "--hooks-dir", gd, "--repos-root", join(root, "empty")],
    {
      cwd: PLUGIN_DIR,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg },
    },
  );
  assert.equal(existsSync(join(gd, "push-to-checkout")), false);
  assert.ok(existsSync(join(gd, "pre-push")));
});

test("§17.3 (PLUG-214): no --hooks-dir and no bb answer → refuse with a hint", () => {
  const root = makeTempDir("install-nodir-");
  const r = spawnSync(
    "node",
    ["hooks/install.mjs", "--repos-root", join(root, "empty")],
    {
      cwd: PLUGIN_DIR,
      encoding: "utf8",
      // a `bb` that cannot answer `orchestrator hooks-dir`
      env: { ...process.env, BB_CLI: join(root, "no-such-bb") },
    },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /hooks-dir/);
});

test("§17.3 (PLUG-214): a foreign global core.hooksPath refuses BEFORE copying", () => {
  const root = makeTempDir("install-hp-");
  const gd = join(root, "hooks");
  const gcfg = join(root, "gitconfig");
  writeFileSync(gcfg, "[core]\n\thooksPath = /other/hooks\n");
  const r = spawnSync(
    "node",
    ["hooks/install.mjs", "--hooks-dir", gd, "--repos-root", join(root, "empty")],
    {
      cwd: PLUGIN_DIR,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg },
    },
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /core\.hooksPath/);
  // the refusal left no wrappers behind
  assert.equal(existsSync(join(gd, "pre-push")), false);
});

test("§17.3 (PLUG-216): --self-test/--dry-run need no hooks-dir and no bb", () => {
  const root = makeTempDir("install-needless-");
  const env = {
    ...process.env,
    // a `bb` that cannot answer `orchestrator hooks-dir`, and a clean
    // global gitconfig — the same shape the refusal test uses
    BB_CLI: join(root, "no-such-bb"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  };
  const dry = spawnSync(
    "node",
    ["hooks/install.mjs", "--dry-run", "--repos-root", join(root, "empty")],
    { cwd: PLUGIN_DIR, encoding: "utf8", env },
  );
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /hooks dir/);
  const st = spawnSync(
    "node",
    ["hooks/install.mjs", "--self-test"],
    { cwd: PLUGIN_DIR, encoding: "utf8", env },
  );
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /OK  self-test passed/);
});

// ── §22.1: общий хук `pre-commit` — утечки на staged diff ─────────────

function makePcEnv(withLocalHook = false) {
  const base = makeTempDir("pcenv-");
  const hooksDir = join(base, "global-hooks");
  const repo = join(base, "repo");
  mkdirSync(hooksDir, { recursive: true });
  cpSync(PC_SRC, join(hooksDir, "pre-commit"));
  cpSync(SCAN_SRC, join(hooksDir, "leak-scan.ts"));
  cpSync(LIB_SRC, join(hooksDir, "hook-lib.mjs"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "a@b.c"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  execFileSync("git", ["-C", repo, "checkout", "-B", "task/work"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
  if (withLocalHook) {
    const local = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(local, "#!/bin/sh\necho LOCAL > \"$GIT_DIR/../pc-local-ran\"\nexit 0\n");
    execFileSync("chmod", ["+x", local]);
  }
  return { base, hooksDir, repo };
}

function stage(repo: string, file: string, text: string) {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), text);
  execFileSync("git", ["-C", repo, "add", file]);
}

function runPreCommit(repo: string, hooksDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: join(repo, ".git") };
  delete env.BB_THREAD_ID;
  return spawnSync("node", [join(hooksDir, "pre-commit")], {
    cwd: repo,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

test("§22.1: чистый коммит проходит и цепляет локальный хук", () => {
  const { repo, hooksDir } = makePcEnv(true);
  stage(repo, "a.ts", "const y = 1;\n");
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(repo, "pc-local-ran")), true);
});

test("§22.1: путь машины в добавленной строке — отказ «файл:строка — тип: фрагмент»", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(repo, "a.ts", `const x = '${LEAK_MACHINE_PATH}';\n`);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.ts:1 — путь машины: /);
});

test("§22.1: однострочный .map > 1 МБ — отказ с усечённым фрагментом ≤120", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(repo, "big.map", `${"x".repeat(2 * 1024 * 1024)}${LEAK_HOME_PREFIX}/y`);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  const line = r.stderr.split("\n").find((l) => /big\.map/.test(l))!;
  const frag = line.split("— путь машины: ")[1]!.trim();
  assert.ok(frag.length <= 120, `fragment ${frag.length} <= 120`);
});

test("§22.1 (ревью): фрагмент вокруг совпадения — не первые 120 байт строки", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(repo, "a.ts", `${"pad".repeat(100)} ${LEAK_MACHINE_PATH}\n`);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  const line = r.stderr.split("\n").find((l) => /a\.ts/.test(l))!;
  const frag = line.split("— путь машины: ")[1]!.trim();
  assert.ok(frag.length <= 120, `fragment ${frag.length} <= 120`);
  // The match sits far past the first 120 bytes — the fragment must
  // still carry the leak itself.
  assert.match(frag, /alice/);
});

test("§22.1 (ревью): фрагмент маскирует секрет ДО обрезки до 120", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(repo, "a.ts", `${"q".repeat(90)} ${LEAK_GHP_SECRET} ${"z".repeat(90)}\n`);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  const line = r.stderr.split("\n").find((l) => /a\.ts/.test(l))!;
  const frag = line.split("— секрет: ")[1]!.trim();
  assert.ok(frag.length <= 120, `fragment ${frag.length} <= 120`);
  assert.match(frag, /\*\*\*/);
  assert.ok(!frag.includes(LEAK_GHP_SECRET.slice(6)), "raw secret tail hidden");
});

test("§22.1 (ревью): private-ip — три октета не адрес, четыре — блок", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(repo, "v.ts", `const ver = "${IP_VERSION_LIKE}";\n`);
  const ok = runPreCommit(repo, hooksDir);
  assert.equal(ok.status, 0, `version string is not an address: ${ok.stderr}`);
  stage(
    repo,
    "v.ts",
    `const ver = "${IP_VERSION_LIKE}";\nconst ip = "${LEAK_PRIVATE_IP}";\n`,
  );
  const bad = runPreCommit(repo, hooksDir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /v\.ts:2 — путь машины: /);
});

test("§22.1: удаление строки с утечкой проходит", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(repo, "a.ts", `const x = '${LEAK_MACHINE_PATH}';\nconst ok = 1;\n`);
  execFileSync("git", ["-C", repo, "commit", "-m", "with leak"]);
  writeFileSync(join(repo, "a.ts"), "const ok = 1;\n");
  execFileSync("git", ["-C", repo, "add", "a.ts"]);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 0);
});

test("§22.1: thr_ id при threadIds:false — отказ «id треда»", () => {
  const { repo, hooksDir } = makePcEnv();
  writeFileSync(
    join(repo, ".git", "orchestrator-leaks.json"),
    JSON.stringify({ version: 1, threadIds: false }),
  );
  stage(repo, "a.ts", `const t = "${LEAK_THREAD_ID}";\n`);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.ts:1 — id треда: /);
});

test("§22.1 (ревью): thr_ в ФАЙЛЕ — отказ даже при threadIds:true и без снапшота", () => {
  const { repo, hooksDir } = makePcEnv();
  // `threadIds` анонимизирует только трейлер BB-Thread: в сообщении —
  // в добавленных строках файла thr_ флагается всегда.
  stage(repo, "a.ts", `const t = "${LEAK_THREAD_ID}";\n`);
  const noSnap = runPreCommit(repo, hooksDir);
  assert.equal(noSnap.status, 1);
  assert.match(noSnap.stderr, /a\.ts:1 — id треда: /);
  execFileSync("git", ["-C", repo, "reset", "-q"]);
  writeFileSync(
    join(repo, ".git", "orchestrator-leaks.json"),
    JSON.stringify({ version: 1, threadIds: true }),
  );
  stage(repo, "a.ts", `const t = "${LEAK_THREAD_ID}";\n`);
  const anon = runPreCommit(repo, hooksDir);
  assert.equal(anon.status, 1);
  assert.match(anon.stderr, /a\.ts:1 — id треда: /);
});

test("§22.1 (ревью): встроенный allow — файл фикстур утечек свободен и без снапшота", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(
    repo,
    "tests/fixtures/leak-samples.ts",
    `export const p = "${LEAK_MACHINE_PATH}";\nexport const t = "${LEAK_THREAD_ID}";\n`,
  );
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 0, `builtin fixture allow: ${r.stderr}`);
});

test("§22.1 (ревью): без снапшота hostname берётся из os.hostname()", () => {
  const { repo, hooksDir } = makePcEnv();
  const host = execFileSync("hostname", { encoding: "utf8" }).trim();
  assert.ok(host.length > 2, "test needs a host name");
  stage(repo, "a.ts", `const h = "${host}";\n`);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.ts:1 — путь машины: /);
});

test("§22.1 (ревью): exclusions по корню ОСНОВНОГО репо — из worktree тоже пропуск", () => {
  const { repo, hooksDir, base } = makePcEnv();
  const wt = join(base, "copy-excluded");
  execFileSync("git", ["-C", repo, "worktree", "add", wt, "--detach"]);
  // `?? wt` — не копия repo: --show-toplevel в worktree НЕ даёт корень
  // основного репо, только dirname(commonDir).
  writeFileSync(join(hooksDir, "exclusions"), `${repo}\n`);
  stage(wt, "a.ts", `const x = '${LEAK_MACHINE_PATH}';\n`);
  const r = runPreCommit(wt, hooksDir);
  assert.equal(r.status, 0, `excluded main root covers worktrees: ${r.stderr}`);
});

test("§22.1: настройки проекта из снапшота общего каталога — worktree копии", () => {
  const { repo, hooksDir, base } = makePcEnv();
  // `allow` в снапшоте общего .git — копия (worktree) применяет её же.
  writeFileSync(
    join(repo, ".git", "orchestrator-leaks.json"),
    JSON.stringify({
      version: 1,
      allow: ["gen/**"],
      threadIds: false,
    }),
  );
  const wt = join(base, "copy");
  execFileSync("git", ["-C", repo, "worktree", "add", wt, "--detach"]);
  stage(wt, "gen/out.ts", `const x = '${LEAK_MACHINE_PATH}';\n`);
  const r = runPreCommit(wt, hooksDir);
  assert.equal(r.status, 0, `allow из снапшота: ${r.stderr}`);
  // а файл вне allow — отказ даже в копии
  stage(wt, "b.ts", `const x = '${LEAK_MACHINE_PATH}';\n`);
  const r2 = runPreCommit(wt, hooksDir);
  assert.equal(r2.status, 1);
  // excluded:true — скан пропущен целиком
  writeFileSync(
    join(repo, ".git", "orchestrator-leaks.json"),
    JSON.stringify({ version: 1, excluded: true }),
  );
  const r3 = runPreCommit(wt, hooksDir);
  assert.equal(r3.status, 0);
});

test("§22.1: warn-строгость — предупреждение, коммит проходит", () => {
  const { repo, hooksDir } = makePcEnv();
  writeFileSync(
    join(repo, ".git", "orchestrator-leaks.json"),
    JSON.stringify({ version: 1, machine: "warn" }),
  );
  stage(repo, "a.ts", `const x = '${LEAK_MACHINE_PATH}';\n`);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /предупреждение/);
});

test("§22.1: нет снапшота — встроенные правила с дефолтной строгостью", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(repo, "a.ts", `const e = '${LEAK_PERSONAL_EMAIL}';\n`);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /— почта: /);
});

test("§4 r11.1: синтетика (секрет и почта) в файле фикстур — проходит", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(
    repo,
    "tests/fixtures/leak-samples.ts",
    `export const s = "${LEAK_GHP_SECRET}";\nexport const e = "${LEAK_PERSONAL_EMAIL}";\n`,
  );
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 0, `synthetic fixture values exempt: ${r.stderr}`);
});

test("§4 r11.1: та же синтетика в обычном файле — отказ «секрет»", () => {
  const { repo, hooksDir } = makePcEnv();
  stage(repo, "a.ts", `const s = "${LEAK_GHP_SECRET}";\n`);
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.ts:1 — секрет: /);
});

test("§4 r11.1: реальная форма (неповторяющееся тело) в файле фикстур — отказ", () => {
  const { repo, hooksDir } = makePcEnv();
  // §5: a real-form literal may not exist ANYWHERE (it is always a
  // finding, fixture file included) — the test corrupts one char of
  // the imported synthetic sample at runtime instead.
  const realForm = LEAK_GHP_SECRET.replace(/x$/, "xQ");
  stage(
    repo,
    "tests/fixtures/leak-samples.ts",
    `export const s = "${realForm}";\n`,
  );
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /leak-samples\.ts:1 — секрет: /);
});

test("§4 r11.1: реальная почта в файле фикстур — отказ «почта»", () => {
  const { repo, hooksDir } = makePcEnv();
  const realMail = LEAK_PERSONAL_EMAIL.replace("EXAMPLE", "petr");
  stage(
    repo,
    "tests/fixtures/leak-samples.ts",
    `export const e = "${realMail}";\n`,
  );
  const r = runPreCommit(repo, hooksDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /leak-samples\.ts:1 — почта: /);
});

// ── §24.4 (PLUG-421): Область запрета целевой ветки и полные исключения ──

async function setupHooksEnv(prefix: string, opts?: { exclusions?: string; projects?: string[] }) {
  const base = makeTempDir(prefix);
  const hooksDir = join(base, "hooks");
  const gcfg = join(base, "gitconfig");
  writeFileSync(gcfg, "");
  const prevGcfg = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gcfg;
  try {
    await installHooks({ hooksDir });
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prevGcfg;
  }
  if (opts?.exclusions !== undefined) {
    writeFileSync(join(hooksDir, "exclusions"), opts.exclusions);
  }
  if (opts?.projects !== undefined) {
    writeFileSync(join(hooksDir, "projects.json"), JSON.stringify(opts.projects));
  }
  const dbPath = join(base, "data.db");
  const db = new Database(dbPath);
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const bbDb = join(base, "bb.db");
  const bdb = new Database(bbDb);
  bdb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, environment_id TEXT, parent_thread_id TEXT)");
  bdb.exec("CREATE TABLE environments (id TEXT PRIMARY KEY, path TEXT)");
  bdb.close();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gcfg,
    ORCHESTRATOR_DB_PATH: dbPath,
    ORCHESTRATOR_BB_DB_PATH: bbDb,
  };
  delete env.BB_THREAD_ID;

  return { base, hooksDir, gcfg, db, store, env };
}

function initTestRepo(repo: string, branch = "main") {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch, repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
}

function doCommit(repo: string, env: NodeJS.ProcessEnv, file = "a.txt", content = "hello\n") {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), content);
  spawnSync("git", ["-C", repo, "add", file], { env, encoding: "utf8" });
  return spawnSync("git", ["-C", repo, "commit", "-m", `add ${file}`], { env, encoding: "utf8" });
}

test("§24.4 (6.1): коммит в /tmp проходит при установленных хуках (с /tmp/ и без /tmp/ в exclusions)", async () => {
  // Вариант А: с /tmp/ в exclusions
  {
    const { base, env, store } = await setupHooksEnv("test-6-1a-", { exclusions: "/tmp/\n" });
    const repo = join(base, "repo-a");
    initTestRepo(repo, "main");
    const r1 = doCommit(repo, env, "file.txt", "content\n");
    assert.equal(r1.status, 0, `commit with /tmp/ in exclusions failed: ${r1.stderr}`);

    // Тот же репо с BB_THREAD_ID роли executor без делегирования
    store.setThreadRole("thr_exec_a", "executor", "owner");
    const r2 = doCommit(repo, { ...env, BB_THREAD_ID: "thr_exec_a" }, "file2.txt", "content2\n");
    assert.equal(r2.status, 0, `executor commit with /tmp/ failed: ${r2.stderr}`);
  }

  // Вариант Б: без /tmp/ в exclusions
  {
    const { base, env, store } = await setupHooksEnv("test-6-1b-", { exclusions: "" });
    const repo = join(base, "repo-b");
    initTestRepo(repo, "main");
    const r1 = doCommit(repo, env, "file.txt", "content\n");
    assert.equal(r1.status, 0, `commit without /tmp/ in exclusions failed: ${r1.stderr}`);

    // Тот же репо с BB_THREAD_ID роли executor без делегирования
    store.setThreadRole("thr_exec_b", "executor", "owner");
    const r2 = doCommit(repo, { ...env, BB_THREAD_ID: "thr_exec_b" }, "file2.txt", "content2\n");
    assert.equal(r2.status, 0, `executor commit without /tmp/ failed: ${r2.stderr}`);
  }
});

test("§24.4 (6.2): неуправляемый репозиторий вне exclusions на main — коммит проходит, утечки ловятся", async () => {
  const { base, env } = await setupHooksEnv("test-6-2-", { exclusions: "" });
  const repo = join(base, "repo");
  initTestRepo(repo, "main");
  // Чистый коммит проходит
  const ok = doCommit(repo, env, "clean.txt", "ok\n");
  assert.equal(ok.status, 0, `clean commit failed: ${ok.stderr}`);

  // thr_... в добавленной строке — отказ
  const leak = doCommit(repo, env, "leak.txt", `const t = "${LEAK_THREAD_ID}";\n`);
  assert.equal(leak.status, 1);
  assert.match(leak.stderr, /id треда/);
});

test("§24.4 (6.3): основная копия проекта из projects.json на main — отказ; worktree на main — отказ, на рабочей ветке — проходит", async () => {
  const { base, hooksDir, env } = await setupHooksEnv("test-6-3-", { exclusions: "" });
  const repo = join(base, "repo");
  initTestRepo(repo, "main");
  writeFileSync(join(hooksDir, "projects.json"), JSON.stringify([realpathSync(join(repo, ".git"))]));

  // Основная копия на main — отказ
  const rMain = doCommit(repo, env, "a.txt");
  assert.equal(rMain.status, 1);
  assert.match(rMain.stderr, /в целевую ветку не коммитят/);

  // Сделаем начальный коммит в рабочей ветке, чтобы можно было создать worktree
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "work"]);
  assert.equal(doCommit(repo, env, "init.txt").status, 0);
  execFileSync("git", ["-C", repo, "branch", "main", "work"]);

  // Worktree на рабочей ветке — проходит
  const wtWork = join(base, "wt-work");
  execFileSync("git", ["-C", repo, "worktree", "add", wtWork, "-b", "feature"]);
  assert.equal(doCommit(wtWork, env, "wt.txt").status, 0);

  // Worktree на main — отказ
  const wtMain = join(base, "wt-main");
  execFileSync("git", ["-C", repo, "worktree", "add", wtMain, "main"]);
  const rWtMain = doCommit(wtMain, env, "wt-main.txt");
  assert.equal(rWtMain.status, 1);
  assert.match(rWtMain.stderr, /в целевую ветку не коммитят/);
});

test("§24.4 (6.4): репозиторий со слепком orchestrator-leaks.json без excluded на main — отказ", async () => {
  const { base, env } = await setupHooksEnv("test-6-4-", { exclusions: "" });
  const repo = join(base, "repo");
  initTestRepo(repo, "main");
  writeFileSync(
    join(repo, ".git", "orchestrator-leaks.json"),
    JSON.stringify({ version: 1, threadIds: true }),
  );
  const r = doCommit(repo, env, "a.txt");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /в целевую ветку не коммитят/);
});

test("§24.4 (6.5): проект с excluded: true не входит в projects.json, коммит на main проходит, install --exclude добавляет путь, doctor не считает ошибкой", async () => {
  const { base, hooksDir, env } = await setupHooksEnv("test-6-5-", { exclusions: "" });
  const repo = join(base, "repo");
  initTestRepo(repo, "main");

  // Слепок со снапшотом excluded: true
  writeFileSync(
    join(repo, ".git", "orchestrator-leaks.json"),
    JSON.stringify({ version: 1, excluded: true }),
  );
  const r = doCommit(repo, env, "a.txt");
  assert.equal(r.status, 0, `excluded project commit on main failed: ${r.stderr}`);

  // hooks install с --exclude
  const prevGcfg = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
  try {
    const res = await installHooks({
      hooksDir,
      exclude: [repo],
      releaseConfig: {
        projects: {
          proj_ex: { excluded: true },
        },
      },
      projectsList: [
        { id: "proj_ex", sources: [{ type: "local_path", path: repo, isDefault: true }] },
      ],
    });
    assert.equal(res.ok, true);

    // doctor не считает эту запись пересечением
    const doc = await runHooksDoctor({ hooksDir, repo });
    assert.equal(doc.ok, true);
    assert.equal(doc.issues.some((i) => i.type === "exclusion-covers-project"), false);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prevGcfg;
  }

  // Запись добавлена в exclusions
  const exclContent = readFileSync(join(hooksDir, "exclusions"), "utf8");
  assert.ok(exclContent.includes(repo));
});

test("§24.4 (6.6): нет projects.json, exclusions содержит <tmp>/excluded/: управляемый по слепку — отказ, прочий — предупреждение, в excluded — без предупреждения", async () => {
  const { base, hooksDir, env } = await setupHooksEnv("test-6-6-");
  try {
    const { rmSync } = await import("node:fs");
    rmSync(join(hooksDir, "projects.json"));
  } catch {}

  const exclPrefix = join(base, "excluded") + "/";
  writeFileSync(join(hooksDir, "exclusions"), exclPrefix);

  // 1. Управляемый по слепку (в <tmp>/managed/repo) -> отказ
  const managedRepo = join(base, "managed", "repo");
  initTestRepo(managedRepo, "main");
  writeFileSync(
    join(managedRepo, ".git", "orchestrator-leaks.json"),
    JSON.stringify({ version: 1, threadIds: true }),
  );
  const rManaged = doCommit(managedRepo, env, "a.txt");
  assert.equal(rManaged.status, 1);
  assert.match(rManaged.stderr, /в целевую ветку не коммитят/);

  // 2. Прочий на main вне <tmp>/excluded/ -> проходит с предупреждением projectsRegistryMissing
  const otherRepo = join(base, "other", "repo");
  initTestRepo(otherRepo, "main");
  const rOther = doCommit(otherRepo, env, "b.txt");
  assert.equal(rOther.status, 0);
  assert.match(rOther.stderr, /реестр проектов не найден — запрет целевой ветки только по слепку настроек/);

  // 3. Неуправляемый репозиторий в <tmp>/excluded/ -> проходит без предупреждения
  const exclRepo = join(base, "excluded", "repo");
  initTestRepo(exclRepo, "main");
  const rExcl = doCommit(exclRepo, env, "c.txt");
  assert.equal(rExcl.status, 0);
  assert.ok(!rExcl.stderr.includes("реестр проектов не найден"));
});

test("§24.4 (6.7): репозиторий под /tmp/ с ролью orchestrator и файлом вне docs/ — проходит", async () => {
  const { base, env, store } = await setupHooksEnv("test-6-7-", { exclusions: "/tmp/\n" });
  store.setThreadRole("thr_coord_7", "orchestrator", "owner");
  const repo = join(base, "repo");
  initTestRepo(repo, "main");
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature"]);
  const e = { ...env, BB_THREAD_ID: "thr_coord_7" };
  const r = doCommit(repo, e, "src/code.ts", "console.log('code');\n");
  assert.equal(r.status, 0, `ordinarily forbidden coordinator commit passed under exclusions: ${r.stderr}`);
});

test("§24.4 (6.8): worktree управляемого репозитория под исключённым префиксом — проверки pre-commit и pre-push действуют", async () => {
  const { base, hooksDir, env, store } = await setupHooksEnv("test-6-8-");
  const managedRepo = join(base, "managed", "repo");
  initTestRepo(managedRepo, "main");
  writeFileSync(join(hooksDir, "projects.json"), JSON.stringify([realpathSync(join(managedRepo, ".git"))]));

  const exclPrefix = join(base, "excluded") + "/";
  writeFileSync(join(hooksDir, "exclusions"), exclPrefix);

  // Подготовим коммит на рабочей ветке в managedRepo
  execFileSync("git", ["-C", managedRepo, "checkout", "-q", "-b", "work"]);
  assert.equal(doCommit(managedRepo, env, "init.txt").status, 0);
  execFileSync("git", ["-C", managedRepo, "branch", "main", "work"]);

  // Создадим worktree под исключённым префиксом: <tmp>/excluded/wt
  const wt = join(base, "excluded", "wt");
  execFileSync("git", ["-C", managedRepo, "worktree", "add", wt, "-b", "wt-branch"]);

  // pre-commit в worktree:
  // 1) с ролью orchestrator коммит файла вне docs/ -> отказ
  store.setThreadRole("thr_coord_8", "orchestrator", "owner");
  const rCoord = doCommit(wt, { ...env, BB_THREAD_ID: "thr_coord_8" }, "src/app.ts");
  assert.equal(rCoord.status, 1);
  assert.match(rCoord.stderr, /координатор код не пишет/);

  // 2) на main без роли -> отказ правила (а)
  execFileSync("git", ["-C", wt, "checkout", "-q", "main"]);
  const rMain = doCommit(wt, env, "main.txt");
  assert.equal(rMain.status, 1);
  assert.match(rMain.stderr, /в целевую ветку не коммитят/);

  // 3) на рабочей ветке без роли -> проходит
  execFileSync("git", ["-C", wt, "checkout", "-q", "wt-branch"]);
  const rWork = doCommit(wt, env, "work.txt");
  assert.equal(rWork.status, 0);

  // pre-push:
  const remote = join(base, "managed", "remote.git");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["-C", wt, "remote", "add", "origin", remote]);

  // push рабочей ветки из worktree без маркера release -> отказ
  const pushWt = spawnSync("git", ["-C", wt, "push", "origin", "wt-branch"], { env, encoding: "utf8" });
  assert.equal(pushWt.status, 1);
  assert.match(pushWt.stderr, /выкладка только через `bb orchestrator release`/);

  // тот же push из неуправляемого репозитория в <tmp>/excluded/ -> проходит
  const unmanagedRepo = join(base, "excluded", "unmanaged");
  initTestRepo(unmanagedRepo, "main");
  execFileSync("git", ["-C", unmanagedRepo, "checkout", "-q", "-b", "u-work"]);
  assert.equal(doCommit(unmanagedRepo, env, "u.txt").status, 0);
  const uRemote = join(base, "managed", "u-remote.git");
  execFileSync("git", ["init", "--bare", uRemote]);
  execFileSync("git", ["-C", unmanagedRepo, "remote", "add", "origin", uRemote]);
  const pushUnm = spawnSync("git", ["-C", unmanagedRepo, "push", "origin", "u-work"], { env, encoding: "utf8" });
  assert.equal(pushUnm.status, 0, `unmanaged push should pass: ${pushUnm.stderr}`);
});

test("§24.4 (6.9): post-checkout и reference-transaction в исключённом репозитории вызывают только локальный хук", async () => {
  const { base, hooksDir, env, store } = await setupHooksEnv("test-6-9-", { exclusions: "/tmp/\n" });
  store.setThreadRole("thr_coord_9", "orchestrator", "owner");
  const repo = join(base, "repo");
  initTestRepo(repo, "main");
  assert.equal(doCommit(repo, env, "init.txt").status, 0);

  // Локальный post-checkout
  const localCo = join(repo, ".git", "hooks", "post-checkout");
  writeFileSync(localCo, "#!/bin/sh\necho LOCAL_CO > \"${GIT_DIR:-.git}/../local-co-ran\"\nexit 0\n");
  chmodSync(localCo, 0o755);

  // post-checkout: переключение ветки с ролью orchestrator в чужой копии не даёт ошибок и строк
  const co = spawnSync("git", ["-C", repo, "checkout", "-q", "-b", "branch-9"], {
    env: { ...env, BB_THREAD_ID: "thr_coord_9" },
    encoding: "utf8",
  });
  assert.equal(co.status, 0);
  assert.equal(existsSync(join(repo, "local-co-ran")), true);

  // reference-transaction: создаём маркер живой копии
  writeFileSync(join(repo, ".git", ".bb-live-checkout"), "");
  const refTx = spawnSync("node", [join(hooksDir, "reference-transaction"), "prepared"], {
    cwd: repo,
    input: "ref lines\n",
    env,
    encoding: "utf8",
  });
  assert.equal(refTx.status, 0);
  assert.ok(!refTx.stderr.includes("отказ: изменение ссылок"));
});

test("§24.4 (6.10): запись через символьную ссылку сопоставляется после realpath", async () => {
  const { base, hooksDir, env, store } = await setupHooksEnv("test-6-10-");
  store.setThreadRole("thr_coord_10", "orchestrator", "owner");

  const realDir = join(base, "real");
  mkdirSync(realDir, { recursive: true });
  const linkDir = join(base, "link");
  symlinkSync(realDir, linkDir);

  // Неуправляемый репозиторий в real/repo
  const repo = join(realDir, "repo");
  initTestRepo(repo, "main");
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "work"]);

  // В exclusions теста только <tmp>/link/
  writeFileSync(join(hooksDir, "exclusions"), `${linkDir}/\n`);

  const e = { ...env, BB_THREAD_ID: "thr_coord_10" };
  const rPass = doCommit(repo, e, "src/a.ts");
  assert.equal(rPass.status, 0, `symlink exclusion matched after realpath: ${rPass.stderr}`);

  // Без этой записи — отказ «координатор код не пишет»
  writeFileSync(join(hooksDir, "exclusions"), "");
  const rFail = doCommit(repo, e, "src/b.ts");
  assert.equal(rFail.status, 1);
  assert.match(rFail.stderr, /координатор код не пишет/);
});

test("§24.4 (6.11): установка не стирает существующие исключения (байт-в-байт без --exclude, слияние с --exclude)", async () => {
  const { base, hooksDir } = await setupHooksEnv("test-6-11-");
  const origContent = "# Service exclusions\n/tmp/\n/home/ubuntu/kb/\n";
  writeFileSync(join(hooksDir, "exclusions"), origContent);

  const prevGcfg = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
  try {
    // hooks install без --exclude -> файл байт-в-байт прежний
    await installHooks({ hooksDir });
    assert.equal(readFileSync(join(hooksDir, "exclusions"), "utf8"), origContent);

    // --exclude <X>/ -> прежние строки на месте и в том же порядке, <X>/ дописан
    const extra = join(base, "extra") + "/";
    await installHooks({ hooksDir, exclude: [extra] });
    const content2 = readFileSync(join(hooksDir, "exclusions"), "utf8");
    assert.equal(content2, origContent + extra + "\n");

    // Повтор с тем же <X>/ дубля не даёт
    await installHooks({ hooksDir, exclude: [extra] });
    assert.equal(readFileSync(join(hooksDir, "exclusions"), "utf8"), content2);

    // То же для install.mjs
    const extra2 = join(base, "extra2") + "/";
    const resMjs = spawnSync("node", ["hooks/install.mjs", "--hooks-dir", hooksDir, "--exclude", extra2], {
      cwd: PLUGIN_DIR,
      env: { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig") },
      encoding: "utf8",
    });
    assert.equal(resMjs.status, 0, resMjs.stderr);
    const content3 = readFileSync(join(hooksDir, "exclusions"), "utf8");
    assert.equal(content3, content2 + extra2 + "\n");
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prevGcfg;
  }
});

test("§24.4 (6.12): exclusion-covers-project при попытке исключить управляемый проект; doctor код 2", async () => {
  const { base, hooksDir } = await setupHooksEnv("test-6-12-");
  const managedRepo = join(base, "managed", "repo");
  initTestRepo(managedRepo, "main");
  writeFileSync(join(hooksDir, "exclusions"), "");

  const prevGcfg = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
  try {
    // hooks install с exclude, покрывающим managedRepo
    await assert.rejects(
      async () => {
        await installHooks({
          hooksDir,
          exclude: [join(base, "managed") + "/"],
          releaseConfig: {
            projects: {
              proj_m: { checks: [] },
            },
          },
          projectsList: [
            { id: "proj_m", sources: [{ type: "local_path", path: managedRepo, isDefault: true }] },
          ],
        });
      },
      (err: any) => {
        assert.equal(err.code, "exclusion-covers-project");
        return true;
      },
    );
    // Проверяем, что projects.json сохранён до отказа (§24.4 п.5 шаг 1)
    assert.ok(existsSync(join(hooksDir, "projects.json")), "projects.json должен сохраняться до отказа");
    const savedProjects = JSON.parse(readFileSync(join(hooksDir, "projects.json"), "utf8"));
    assert.deepEqual(savedProjects, [realpathSync(join(managedRepo, ".git"))]);
    assert.equal(readFileSync(join(hooksDir, "exclusions"), "utf8"), "");

    // install.mjs с уже записанным projects.json
    const resMjs = spawnSync("node", ["hooks/install.mjs", "--hooks-dir", hooksDir, "--exclude", join(base, "managed") + "/"], {
      cwd: PLUGIN_DIR,
      env: { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig") },
      encoding: "utf8",
    });
    assert.equal(resMjs.status, 1);
    assert.match(resMjs.stderr, /exclusion-covers-project/);
    assert.equal(readFileSync(join(hooksDir, "exclusions"), "utf8"), "");

    // Существующая запись в exclusions не срывает установку, но даёт предупреждение (§24.4 п.5)
    writeFileSync(join(hooksDir, "exclusions"), join(base, "managed") + "/\n");
    const resWarn = await installHooks({
      hooksDir,
      releaseConfig: {
        projects: { proj_m: { checks: [] } },
      },
      projectsList: [
        { id: "proj_m", sources: [{ type: "local_path", path: managedRepo, isDefault: true }] },
      ],
    });
    assert.equal(resWarn.ok, true);
    assert.ok(resWarn.warnings && resWarn.warnings.length > 0);
    assert.match(resWarn.message, /предупреждение: существующее исключение/);

    // Запись, уже лежащая в exclusions -> doctor код 2
    const doc = await runHooksDoctor({ hooksDir, repo: managedRepo });
    assert.equal(doc.ok, false);
    assert.equal(doc.code, 2);
    assert.ok(doc.issues.some((i) => i.type === "exclusion-covers-project"));
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prevGcfg;
  }
});

test("§24.4 (6.14): сбор реестра projects.json (local_path missing, broken git, async sync)", async () => {
  const base = makeTempDir("test-6-14-");
  const repo1 = join(base, "repo1");
  initTestRepo(repo1, "main");

  // (а) Настройка с двумя проектами: у одного repo, у другого пути нет
  const resA = await collectProjectsRegistry(
    {
      projects: {
        p1: { checks: [] },
        p2: { checks: [] },
      },
    },
    {
      projectsList: [
        { id: "p1", sources: [{ type: "local_path", path: repo1, isDefault: true }] },
        { id: "p2", sources: [{ type: "local_path", path: join(base, "nonexistent"), isDefault: true }] },
      ],
    },
  );
  assert.equal(resA.ok, true);
  assert.deepEqual(resA.registry, [realpathSync(join(repo1, ".git"))]);

  // Запуск из worktree того же репозитория даёт ту же запись
  const wt1 = join(base, "repo1-wt");
  execFileSync("git", ["-C", repo1, "commit", "-q", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", repo1, "worktree", "add", wt1, "-b", "wt1-branch"]);
  const resWt = await collectProjectsRegistry(
    { projects: { p1: { checks: [] } } },
    {
      projectsList: [
        { id: "p1", sources: [{ type: "local_path", path: wt1, isDefault: true }] },
      ],
    },
  );
  assert.equal(resWt.ok, true);
  assert.deepEqual(resWt.registry, [realpathSync(join(repo1, ".git"))]);

  // Вызов реального обработчика CLI hooks install (проверка реальной связки cmdRunner)
  const cliHooksDir = join(base, "cli-hooks");
  const hostA = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-cli-test-"),
    settings: {
      policy: '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
      release: JSON.stringify({
        commitIdentity: "Agent <agent@x.io>",
        projects: {
          p1: { checks: [] },
          p2: { checks: [] },
        },
      }),
    },
  });
  await createPlugin(hostA.bb, {
    bbCli: {
      run: async (args: string[]) => {
        if (args[0] === "project" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              { id: "p1", sources: [{ type: "local_path", path: repo1, isDefault: true }] },
              { id: "p2", sources: [{ type: "local_path", path: join(base, "nonexistent"), isDefault: true }] },
            ]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });
  const prevGcfgA = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig-cli");
  try {
    const cliRes = await hostA.harness.runCli(["hooks", "install", "--hooks-dir", cliHooksDir, "--confirm"], {});
    assert.equal(cliRes.exitCode, 0, `CLI hooks install failed: ${cliRes.stderr || cliRes.stdout}`);
    assert.ok(existsSync(join(cliHooksDir, "projects.json")));
    const cliSavedProjects = JSON.parse(readFileSync(join(cliHooksDir, "projects.json"), "utf8"));
    assert.deepEqual(cliSavedProjects, [realpathSync(join(repo1, ".git"))]);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prevGcfgA;
  }

  // (б) local_path существует, но не git-репозиторий -> projects-registry-failed
  const notRepo = join(base, "not-repo");
  mkdirSync(notRepo);
  const hooksDir = join(base, "hooks");
  await assert.rejects(
    async () => {
      await installHooks({
        hooksDir,
        releaseConfig: {
          projects: {
            p_bad: { checks: [] },
          },
        },
        projectsList: [
          { id: "p_bad", sources: [{ type: "local_path", path: notRepo, isDefault: true }] },
        ],
      });
    },
    (err: any) => {
      assert.equal(err.code, "projects-registry-failed");
      assert.match(err.message, /p_bad/);
      assert.match(err.message, /not a git repository|не git-репозиторий/i);
      return true;
    },
  );
  // В hooksDir ничего не записано
  assert.equal(existsSync(hooksDir), false);

  // (в) Асинхронный сбор при createPlugin (syncHookRegistries):
  // 1) Ошибка логируется в mock bb.log.warn, прежний файл на месте
  const hooksDir2 = join(base, "hooks2");
  mkdirSync(hooksDir2);
  writeFileSync(join(hooksDir2, "projects.json"), JSON.stringify(["old-entry"]));

  const prevHooksDirEnv = process.env.ORCHESTRATOR_HOOKS_DIR;
  process.env.ORCHESTRATOR_HOOKS_DIR = hooksDir2;

  try {
    const warnMessages: string[] = [];
    const hostBad = createFakePluginHost({
      pluginId: "orchestrator",
      dataDir: makeTempDir("orch-bad-sync-"),
      settings: {
        policy: '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
        release: JSON.stringify({
          commitIdentity: "Agent <agent@x.io>",
          projects: {
            p_bad: { checks: [] },
          },
        }),
      },
    });
    const origWarn = hostBad.bb.log.warn;
    hostBad.bb.log.warn = (msg: string) => {
      warnMessages.push(msg);
      origWarn(msg);
    };

    await createPlugin(hostBad.bb, {
      bbCli: {
        run: async (args: string[]) => {
          if (args[0] === "project" && args[1] === "list") {
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                { id: "p_bad", sources: [{ type: "local_path", path: notRepo, isDefault: true }] },
              ]),
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });

    // Ожидаем завершения асинхронного вызова syncProjectsRegistry
    for (let i = 0; i < 20; i++) {
      if (warnMessages.some((w) => w.includes("projects.json") && w.includes("p_bad"))) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.ok(
      warnMessages.some((w) => w.includes("projects.json") && w.includes("p_bad")),
      `expected warning in bb.log.warn, got: ${JSON.stringify(warnMessages)}`,
    );
    assert.equal(readFileSync(join(hooksDir2, "projects.json"), "utf8"), JSON.stringify(["old-entry"]));

    // 2) Успешный асинхронный сбор: запись projects.json создаётся корректно
    const hooksDirOk = join(base, "hooks-ok");
    mkdirSync(hooksDirOk);
    process.env.ORCHESTRATOR_HOOKS_DIR = hooksDirOk;

    const hostOk = createFakePluginHost({
      pluginId: "orchestrator",
      dataDir: makeTempDir("orch-ok-sync-"),
      settings: {
        policy: '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
        release: JSON.stringify({
          commitIdentity: "Agent <agent@x.io>",
          projects: {
            p1: { checks: [] },
          },
        }),
      },
    });

    const warnMessagesOk: string[] = [];
    const origWarnOk = hostOk.bb.log.warn;
    hostOk.bb.log.warn = (msg: string) => {
      warnMessagesOk.push(msg);
      origWarnOk(msg);
    };

    await createPlugin(hostOk.bb, {
      bbCli: {
        run: async (args: string[]) => {
          if (args[0] === "project" && args[1] === "list") {
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                { id: "p1", sources: [{ type: "local_path", path: repo1, isDefault: true }] },
              ]),
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });

    // Ожидаем завершения асинхронного вызова syncProjectsRegistry
    for (let i = 0; i < 20; i++) {
      if (existsSync(join(hooksDirOk, "projects.json"))) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.ok(
      existsSync(join(hooksDirOk, "projects.json")),
      "projects.json должен быть записан syncProjectsRegistry",
    );
    const okProjects = JSON.parse(readFileSync(join(hooksDirOk, "projects.json"), "utf8"));
    assert.deepEqual(okProjects, [realpathSync(join(repo1, ".git"))]);
  } finally {
    process.env.ORCHESTRATOR_HOOKS_DIR = prevHooksDirEnv;
  }
});
