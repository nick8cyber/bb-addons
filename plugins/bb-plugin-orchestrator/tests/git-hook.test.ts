import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePushToken } from "../src/release.js";

const HOOK_SRC = new URL("../hooks/pre-push", import.meta.url).pathname;
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function makeEnv(withLocalHook = false) {
  const base = mkdtempSync(join(tmpdir(), "hookenv-"));
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
  const root = mkdtempSync(join(tmpdir(), "inv-"));
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
const CHAIN_SRC = new URL("../hooks/chain", import.meta.url).pathname;
const NAMES_SRC = new URL("../hooks/hook-names", import.meta.url).pathname;

test("Б2/мелко9: installer covers every standard hook name; shared token dir", () => {
  const root = mkdtempSync(join(tmpdir(), "install-"));
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
  const chainSrc = readFileSync(CHAIN_SRC, "utf8");
  for (const n of names) {
    const f = join(gd, n);
    assert.ok(existsSync(f), `${n} installed`);
    // pre-push carries the gate; every other name is the chain wrapper
    assert.equal(readFileSync(f, "utf8"), n === "pre-push" ? gateSrc : chainSrc);
  }
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

test("§17.3: hook-names covers every githooks(5) name incl. server side", () => {
  const names = new Set(
    readFileSync(NAMES_SRC, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
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
    "fsmonitor-watchman", "p4-pre-submit", "post-index-change",
  ]) {
    assert.ok(names.has(n), `hook-names missing ${n}`);
  }
  assert.ok(
    !names.has("push-to-checkout"),
    "push-to-checkout must never be wrapped",
  );
});

test("§17.3 (PLUG-210): installer takes the token dir from `bb orchestrator hooks-dir`", () => {
  const root = mkdtempSync(join(tmpdir(), "install-dir-"));
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
  const root = mkdtempSync(join(tmpdir(), "install-retire-"));
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
  const root = mkdtempSync(join(tmpdir(), "install-nodir-"));
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
  const root = mkdtempSync(join(tmpdir(), "install-hp-"));
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
