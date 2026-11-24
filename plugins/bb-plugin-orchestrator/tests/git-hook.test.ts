import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp.js";
import { writePushToken } from "../src/release.js";
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
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function makeEnv(withLocalHook = false) {
  const base = makeTempDir("hookenv-");
  const hooksDir = join(base, "global-hooks");
  const repo = join(base, "repo");
  mkdirSync(hooksDir, { recursive: true });
  cpSync(HOOK_SRC, join(hooksDir, "pre-push"));
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

test("§17.3 / §24.1: hook-names covers every githooks(5) name (exactly 23 names)", () => {
  const names = new Set(
    readFileSync(NAMES_SRC, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  assert.equal(names.size, 23);
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
  const env = { ...process.env, GIT_DIR: join(repo, ".git") };
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
