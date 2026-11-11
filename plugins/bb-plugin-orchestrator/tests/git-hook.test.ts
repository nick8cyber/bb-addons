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
  assert.match(st, /OK +local hook fires: plain/);
  assert.match(st, /OK +local hook fires: worktree/);
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
