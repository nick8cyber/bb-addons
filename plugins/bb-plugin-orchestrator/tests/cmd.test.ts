import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCmd } from "../src/cmd.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmd-"));
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Agent"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "agent@x.io"]);
  writeFileSync(join(dir, "f.txt"), "x\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
  return dir;
}

function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const saved = new Map<string, string | undefined>(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// Every janitor/rescue git probe goes through this runner. An
// inherited GIT_DIR/GIT_WORK_TREE (a hook exporting them, a script
// under `git -c`) would retarget `git -C <copy>` at the wrong
// repository — the scrub removes them (PLUG-204).
test("git calls run with a scrubbed GIT_* environment", async () => {
  const dir = makeRepo();
  await withEnv(
    {
      GIT_DIR: join(dir, "no-such.git"),
      GIT_WORK_TREE: join(dir, "elsewhere"),
      GIT_INDEX_FILE: join(dir, "bogus-index"),
      GIT_COMMON_DIR: join(dir, "no-common"),
      GIT_OBJECT_DIRECTORY: join(dir, "no-objects"),
      GIT_NAMESPACE: "bogus",
    },
    async () => {
      const res = await createCmd().run("git", [
        "-C",
        dir,
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
      assert.equal(res.exitCode, 0, res.stderr);
      assert.match(res.stdout.trim(), /^[0-9a-f]{40}$/);
    },
  );
});

// An explicit opts.env still wins — the rescue snapshot drives a
// temporary index through GIT_INDEX_FILE.
test("an explicit opts.env GIT_* passes through", async () => {
  const dir = makeRepo();
  const tmpIndex = join(dir, "rescue-index");
  const res = await createCmd().run(
    "git",
    ["-C", dir, "read-tree", "--empty"],
    { env: { GIT_INDEX_FILE: tmpIndex } },
  );
  assert.equal(res.exitCode, 0, res.stderr);
  assert.ok(existsSync(tmpIndex));
});

// Non-git commands keep the inherited environment untouched.
test("non-git commands inherit GIT_* unchanged", async () => {
  await withEnv({ GIT_DIR: "/tmp/somewhere" }, async () => {
    const res = await createCmd().run("printenv", ["GIT_DIR"]);
    assert.equal(res.stdout.trim(), "/tmp/somewhere");
  });
});


// §17.4 (мелко 13): every janitor/rescue parse of git output assumes
// the default path rendering — user config must not leak in.
test("git invocations force stable path rendering (-c core.quotePath/mnemonicPrefix)", async () => {
  const dir = makeRepo();
  execFileSync("git", ["-C", dir, "config", "core.quotePath", "true"]);
  execFileSync("git", ["-C", dir, "config", "diff.mnemonicPrefix", "true"]);
  writeFileSync(join(dir, "файл.txt"), "x\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "add cyrillic"]);
  const ls = await createCmd().run("git", ["-C", dir, "ls-files"]);
  assert.equal(ls.exitCode, 0);
  // without the -c overrides this would be octal-escaped "\321\204…"
  assert.ok(ls.stdout.includes("файл.txt"), ls.stdout);
  writeFileSync(join(dir, "f.txt"), "changed\n");
  const diff = await createCmd().run("git", ["-C", dir, "diff"]);
  assert.equal(diff.exitCode, 0);
  // mnemonicPrefix would render i//w// instead of a//b/
  assert.ok(diff.stdout.includes("--- a/f.txt"), diff.stdout);
  assert.ok(diff.stdout.includes("+++ b/f.txt"), diff.stdout);
});
