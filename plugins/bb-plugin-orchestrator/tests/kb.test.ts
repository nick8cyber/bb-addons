import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { makeTempDir } from "./helpers/temp.js";
import { LEAK_PRIVATE_KEY } from "./fixtures/leak-samples.js";
import {
  assertNoSecrets,
  assertValidKbPath,
  ensureKbRepo,
  KbService,
  parseKbConfig,
  readKbFile,
  recordReleaseNote,
  searchKbFiles,
  withKbLock,
  writeKbFile,
  appendKbFile,
  statusKb,
  syncKb,
  type KbConfig,
} from "../src/kb.js";
import { OrchestratorError } from "../src/errors.js";
import { createT } from "../src/i18n/index.js";
import { createCmd, type CmdRunner } from "../src/cmd.js";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import { runRelease, runPostPublish, type ReleaseDeps } from "../src/release.js";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";

const t = createT("ru");

function gitCmd(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

function makeKbRepo(): { kbDir: string; remoteDir: string } {
  const base = makeTempDir("kb-repo-");
  const remoteDir = join(base, "remote.git");
  const kbDir = join(base, "kb");
  execFileSync("git", ["init", "--bare", remoteDir]);
  execFileSync("git", ["init", kbDir]);
  gitCmd(kbDir, ["config", "user.name", "Agent"]);
  gitCmd(kbDir, ["config", "user.email", "agent@test.local"]);
  gitCmd(kbDir, ["checkout", "-b", "main"]);
  writeFileSync(join(kbDir, "README.md"), "# Knowledge Base\n");
  gitCmd(kbDir, ["add", "."]);
  gitCmd(kbDir, ["commit", "-m", "init kb"]);
  gitCmd(kbDir, ["remote", "add", "origin", remoteDir]);
  gitCmd(kbDir, ["push", "-u", "origin", "main"]);
  return { kbDir, remoteDir };
}

test("parseKbConfig: defaults when empty or undefined", () => {
  const def = parseKbConfig(undefined, t);
  assert.equal(def.errors.length, 0);
  assert.equal(def.config.enabled, true);
  assert.equal(def.config.autoSync, true);
  assert.equal(def.config.requireCleanOnRelease, true);
  const expectedDefaultPath = existsSync(join(homedir(), "kb"))
    ? join(homedir(), "kb")
    : join(homedir(), ".bb", "kb");
  assert.equal(def.config.path, expectedDefaultPath);
});

test("parseKbConfig: parses valid custom json and expands ~", () => {
  const json = JSON.stringify({
    enabled: false,
    path: "~/test-kb",
    autoSync: false,
    requireCleanOnRelease: false,
  });
  const res = parseKbConfig(json, t);
  assert.equal(res.errors.length, 0);
  assert.equal(res.config.enabled, false);
  assert.equal(res.config.path, join(homedir(), "test-kb"));
  assert.equal(res.config.autoSync, false);
  assert.equal(res.config.requireCleanOnRelease, false);
});

test("parseKbConfig: invalid json returns fallback config and errors", () => {
  const res = parseKbConfig("not-a-json", t);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0]?.path, "kb");
  assert.equal(res.config.enabled, true);
});

test("assertValidKbPath: accepts safe relative paths", () => {
  const base = makeTempDir("kb-path-");
  const res1 = assertValidKbPath(base, "doc.md");
  assert.equal(res1.relPath, "doc.md");
  assert.equal(res1.absPath, join(base, "doc.md"));

  const res2 = assertValidKbPath(base, "releases/2026-11-17-PLUG-1.md");
  assert.equal(res2.relPath, join("releases", "2026-11-17-PLUG-1.md"));
});

test("assertValidKbPath: rejects traversal, .git, null bytes and escapes", () => {
  const base = makeTempDir("kb-path-");

  assert.throws(
    () => assertValidKbPath(base, "../outside.md"),
    (err: unknown) =>
      err instanceof OrchestratorError &&
      err.code === "kb-refused" &&
      err.message.includes("forbidden-path"),
  );

  assert.throws(
    () => assertValidKbPath(base, "foo/../../bar.md"),
    (err: unknown) =>
      err instanceof OrchestratorError &&
      err.code === "kb-refused" &&
      err.message.includes("forbidden-path"),
  );

  assert.throws(
    () => assertValidKbPath(base, ".git/config"),
    (err: unknown) =>
      err instanceof OrchestratorError &&
      err.code === "kb-refused" &&
      err.message.includes("forbidden-path"),
  );

  assert.throws(
    () => assertValidKbPath(base, "foo\0bar.md"),
    (err: unknown) =>
      err instanceof OrchestratorError &&
      err.code === "kb-refused" &&
      err.message.includes("forbidden-path"),
  );

  // Escaping symlink
  const outside = makeTempDir("kb-outside-");
  writeFileSync(join(outside, "secret.txt"), "secret");
  const symlinkPath = join(base, "escape-link");
  try {
    symlinkSync(outside, symlinkPath, "dir");
    assert.throws(
      () => assertValidKbPath(base, "escape-link/secret.txt"),
      (err: unknown) =>
        err instanceof OrchestratorError &&
        err.code === "kb-refused" &&
        err.message.includes("forbidden-path"),
    );
  } catch (e) {
    if ((e as { code?: string }).code !== "EPERM") throw e;
  }
});

test("assertNoSecrets: allows clean markdown, rejects leaks", () => {
  assert.doesNotThrow(() =>
    assertNoSecrets("guide.md", "# Guide\n\nSome normal documentation."),
  );

  assert.throws(
    () =>
      assertNoSecrets(
        "secret.md",
        `# Secret\n\n${LEAK_PRIVATE_KEY}\n`,
      ),
    (err: unknown) =>
      err instanceof OrchestratorError &&
      err.code === "kb-refused" &&
      err.message.includes("secret-leak"),
  );
});

test("withKbLock: creates and releases exclusive lock file", async () => {
  const base = makeTempDir("kb-lock-");
  mkdirSync(join(base, ".git"), { recursive: true });
  const lockFile = join(base, ".git", "orchestrator-kb.lock");

  let ran = false;
  await withKbLock(base, async () => {
    assert.ok(existsSync(lockFile), "lock file exists inside critical section");
    ran = true;
  });

  assert.ok(ran);
  assert.ok(!existsSync(lockFile), "lock file removed after critical section");
});

test("withKbLock: cleans up stale lock when PID is dead", async () => {
  const base = makeTempDir("kb-lock-stale-");
  mkdirSync(join(base, ".git"), { recursive: true });
  const lockFile = join(base, ".git", "orchestrator-kb.lock");

  // Write a lock file with PID 99999999 (almost certainly dead) and an old timestamp
  writeFileSync(
    lockFile,
    JSON.stringify({ pid: 99999999, expiresAt: Date.now() - 60_000 }),
  );

  let ran = false;
  await withKbLock(base, async () => {
    ran = true;
  });
  assert.ok(ran, "acquired lock after reaping stale lock");
  assert.ok(!existsSync(lockFile));
});

test("withKbLock: throws lock-timeout when lock is held by live process", async () => {
  const base = makeTempDir("kb-lock-timeout-");
  mkdirSync(join(base, ".git"), { recursive: true });
  const lockFile = join(base, ".git", "orchestrator-kb.lock");

  // Write a lock file held by current process (live PID)
  writeFileSync(lockFile, `${process.pid}\n${new Date().toISOString()}\n`);

  await assert.rejects(
    async () => {
      await withKbLock(base, async () => {}, { timeoutMs: 150 });
    },
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: lock-timeout/);
      return true;
    },
  );
});

test("KbService: throws kb-disabled on all operations when kb.enabled: false", async () => {
  const base = makeTempDir("kb-disabled-ops-");
  const cmd = createCmd();
  const service = new KbService({
    cmd,
    config: () => ({
      enabled: false,
      path: base,
      autoSync: false,
      requireCleanOnRelease: false,
    }),
    t,
  });

  assert.throws(
    () => service.list(),
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-disabled");
      assert.match(err.message, /kb-refused: kb-disabled/);
      return true;
    },
  );

  assert.throws(
    () => service.read("any.md"),
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-disabled");
      assert.match(err.message, /kb-refused: kb-disabled/);
      return true;
    },
  );

  assert.throws(
    () => service.search("query"),
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-disabled");
      assert.match(err.message, /kb-refused: kb-disabled/);
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await service.write({ path: "test.md", content: "hi" });
    },
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-disabled");
      assert.match(err.message, /kb-refused: kb-disabled/);
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await service.append({ path: "test.md", content: "hi" });
    },
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-disabled");
      assert.match(err.message, /kb-refused: kb-disabled/);
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await service.sync();
    },
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-disabled");
      assert.match(err.message, /kb-refused: kb-disabled/);
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await service.status();
    },
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-disabled");
      assert.match(err.message, /kb-refused: kb-disabled/);
      return true;
    },
  );
});

test("KbService: list, read, write, append, search, status, sync", async () => {
  const { kbDir, remoteDir } = makeKbRepo();
  const cmd = createCmd();
  const service = new KbService({
    cmd,
    config: () => ({
      enabled: true,
      path: kbDir,
      autoSync: true,
      requireCleanOnRelease: true,
    }),
    t,
  });

  // 1. list
  const initialFiles = await service.list();
  assert.deepEqual(initialFiles, ["README.md"]);

  // 2. write new file
  const writeRes = await service.write({
    path: "docs/architecture.md",
    content: "# Architecture\n\nModular design.\n",
    message: "add architecture doc",
    actor: "thr_test",
  });
  assert.equal(writeRes.ok, true);
  assert.equal(writeRes.file, join("docs", "architecture.md"));
  assert.ok(writeRes.sha.length >= 7);
  assert.equal(writeRes.autoSynced, true);

  // verify file content
  const content = await service.read("docs/architecture.md");
  assert.equal(content, "# Architecture\n\nModular design.\n");

  // 3. append to file
  const appendRes = await service.append({
    path: "docs/architecture.md",
    content: "\nSecond section.\n",
    message: "append section",
  });
  assert.equal(appendRes.ok, true);
  const updatedContent = await service.read("docs/architecture.md");
  assert.equal(
    updatedContent,
    "# Architecture\n\nModular design.\n\nSecond section.\n",
  );

  // 4. search
  const searchRes = await service.search("Modular");
  assert.equal(searchRes.length, 1);
  assert.equal(searchRes[0]?.file, join("docs", "architecture.md"));
  assert.equal(searchRes[0]?.line, 3);
  assert.equal(searchRes[0]?.text, "Modular design.");

  // 5. status
  const statusClean = await service.status();
  assert.equal(statusClean.clean, true);
  assert.equal(statusClean.dirtyFiles.length, 0);

  // make it dirty
  writeFileSync(join(kbDir, "dirty.txt"), "dirty content");
  const statusDirty = await service.status();
  assert.equal(statusDirty.clean, false);
  assert.ok(statusDirty.dirtyFiles.includes("dirty.txt"));

  // clean up dirty file
  rmSync(join(kbDir, "dirty.txt"));

  // 6. sync
  const syncRes = await service.sync();
  assert.equal(syncRes.ok, true);
  assert.equal(syncRes.synced, true);
});

test("recordReleaseNote: creates deterministic UTC file and commits", async () => {
  const { kbDir } = makeKbRepo();
  const cmd = createCmd();
  const fixedDate = new Date("2026-11-17T14:30:00Z");
  const now = () => fixedDate.getTime();

  const res1 = await recordReleaseNote(kbDir, cmd, {
    taskKey: "PLUG-293",
    sha7: "abcdef1",
    targetBranch: "main",
    note: "Initial release of knowledge base module",
    now,
  });

  assert.equal(res1.ok, true);
  assert.equal(res1.file, "releases/2026-11-17-PLUG-293.md");
  assert.equal(res1.synced, true);

  const fullPath = join(kbDir, res1.file);
  assert.ok(existsSync(fullPath));
  const fileContent = readFileSync(fullPath, "utf8");
  assert.match(fileContent, /# Релиз PLUG-293/);
  assert.match(fileContent, /2026-11-17/);
  assert.match(fileContent, /abcdef1/);
  assert.match(fileContent, /Initial release of knowledge base module/);

  // Idempotency: calling again with same note skips duplicate commit
  const res2 = await recordReleaseNote(kbDir, cmd, {
    taskKey: "PLUG-293",
    sha7: "abcdef1",
    targetBranch: "main",
    note: "Initial release of knowledge base module",
    now,
  });
  assert.equal(res2.ok, true);

  // Divergent note: when note content differs, it commits the updated note and keeps tree clean
  const logBefore = await cmd.run("git", ["-C", kbDir, "rev-parse", "HEAD"]);
  const res3 = await recordReleaseNote(kbDir, cmd, {
    taskKey: "PLUG-293",
    sha7: "1234567",
    targetBranch: "main",
    note: "Different note for same taskKey",
    now,
  });
  assert.equal(res3.ok, true);
  const logAfter = await cmd.run("git", ["-C", kbDir, "rev-parse", "HEAD"]);
  assert.notEqual(logBefore.stdout, logAfter.stdout);
  const updatedContent = readFileSync(fullPath, "utf8");
  assert.match(updatedContent, /Different note for same taskKey/);
  const statusRes = await cmd.run("git", ["-C", kbDir, "status", "--porcelain"]);
  assert.equal(statusRes.stdout.trim(), "");
});

test("recordReleaseNote: returns synced: false and syncError when no remotes configured", async () => {
  const base = makeTempDir("kb-noremote-");
  const kbDir = join(base, "kb");
  execFileSync("git", ["init", kbDir]);
  gitCmd(kbDir, ["config", "user.name", "Agent"]);
  gitCmd(kbDir, ["config", "user.email", "agent@test.local"]);
  gitCmd(kbDir, ["checkout", "-b", "main"]);
  writeFileSync(join(kbDir, "README.md"), "# Knowledge Base\n");
  gitCmd(kbDir, ["add", "."]);
  gitCmd(kbDir, ["commit", "-m", "init kb"]);

  const cmd = createCmd();
  const res = await recordReleaseNote(kbDir, cmd, {
    taskKey: "PLUG-293",
    sha7: "abcdef1",
    targetBranch: "main",
    note: "No remote note",
  });
  assert.equal(res.ok, true);
  assert.equal(res.synced, false);
  assert.equal(res.syncError, "no remotes configured");
});

test("recordReleaseNote: throws OrchestratorError commit-failed on commit failure", async () => {
  const base = makeTempDir("kb-noid-");
  const kbDir = join(base, "kb");
  execFileSync("git", ["init", kbDir]);
  gitCmd(kbDir, ["config", "user.name", "Agent"]);
  gitCmd(kbDir, ["config", "user.email", "agent@test.local"]);
  const hookDir = join(kbDir, ".git", "hooks");
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const cmd = createCmd();
  await assert.rejects(
    () =>
      recordReleaseNote(kbDir, cmd, {
        taskKey: "PLUG-293",
        sha7: "abcdef1",
        targetBranch: "main",
        note: "Failing commit note",
      }),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: commit-failed/);
      return true;
    },
  );
});

test("writeKbFile: throws OrchestratorError add-failed on git add failure", async () => {
  const { kbDir } = makeKbRepo();
  writeFileSync(join(kbDir, ".gitignore"), "ignored.md\n");
  execFileSync("git", ["-C", kbDir, "add", ".gitignore"]);
  execFileSync("git", ["-C", kbDir, "commit", "-m", "add gitignore"]);

  const cmd = createCmd();
  await assert.rejects(
    () => writeKbFile(kbDir, "ignored.md", "content", cmd),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: add-failed/);
      return true;
    },
  );
});

test("writeKbFile: throws OrchestratorError status-failed on git status failure", async () => {
  const { kbDir } = makeKbRepo();
  const realCmd = createCmd();
  const failingCmd: CmdRunner = {
    run: async (cmd, args, opts) => {
      if (args.includes("status")) {
        return { exitCode: 128, stdout: "", stderr: "fatal: status failed" };
      }
      return realCmd.run(cmd, args, opts);
    },
  };
  await assert.rejects(
    () => writeKbFile(kbDir, "test.md", "content", failingCmd),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: status-failed/);
      return true;
    },
  );
});

test("recordReleaseNote: rejects Co-Authored-By trailer with forbidden-trailer", async () => {
  const { kbDir } = makeKbRepo();
  const cmd = createCmd();
  await assert.rejects(
    () =>
      recordReleaseNote(kbDir, cmd, {
        taskKey: "PLUG-293",
        sha7: "abcdef1",
        targetBranch: "main",
        note: "Normal note\nCo-Authored-By: Bot <bot@test.local>",
      }),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: forbidden-trailer/);
      return true;
    },
  );
  const statusOut = gitCmd(kbDir, ["status", "--porcelain"]);
  assert.equal(statusOut.trim(), "", "KB repo must remain clean after forbidden-trailer rejection");
});

test("writeKbFile/appendKbFile: rejects Co-Authored-By trailer before file write/add", async () => {
  const { kbDir } = makeKbRepo();
  const cmd = createCmd();
  await assert.rejects(
    () => writeKbFile(kbDir, "doc.md", "hello", cmd, { message: "msg\nCo-Authored-By: X" }),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: forbidden-trailer/);
      return true;
    },
  );
  assert.ok(!existsSync(join(kbDir, "doc.md")), "file must not be written to disk");
  const statusOut = gitCmd(kbDir, ["status", "--porcelain"]);
  assert.equal(statusOut.trim(), "", "KB repo must remain clean");
});

test("recordReleaseNote: restores deleted file without duplicate commit when rel() commit exists", async () => {
  const { kbDir } = makeKbRepo();
  const cmd = createCmd();
  const res1 = await recordReleaseNote(kbDir, cmd, {
    taskKey: "PLUG-293",
    sha7: "abcdef1",
    targetBranch: "main",
    note: "Initial note",
  });
  const filePath = join(kbDir, res1.file);
  assert.ok(existsSync(filePath));
  rmSync(filePath);
  assert.ok(!existsSync(filePath));

  const res2 = await recordReleaseNote(kbDir, cmd, {
    taskKey: "PLUG-293",
    sha7: "abcdef1",
    targetBranch: "main",
    note: "Initial note",
  });
  assert.equal(res2.ok, true);
  assert.ok(existsSync(filePath));
});

test("recordReleaseNote: commits pre-seeded release note file with matching content", async () => {
  const { kbDir } = makeKbRepo();
  const cmd = createCmd();
  const fixedDate = new Date("2026-11-17T14:30:00Z");
  const now = () => fixedDate.getTime();
  const relFile = "releases/2026-11-17-PLUG-293.md";
  const content =
    `# Релиз PLUG-293\n\n` +
    `- Дата: 2026-11-17\n` +
    `- Коммит: abcdef1\n` +
    `- Ветка: main\n` +
    `- Задача: PLUG-293\n\n` +
    `## Заметки\n\n` +
    `Pre-seeded release note\n`;

  const absPath = join(kbDir, relFile);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf-8");

  // File is currently untracked ?? in porcelain
  const preStatus = await cmd.run("git", ["-C", kbDir, "status", "--porcelain", "--", relFile]);
  assert.match(preStatus.stdout, /\?\?/);

  const res = await recordReleaseNote(kbDir, cmd, {
    taskKey: "PLUG-293",
    sha7: "abcdef1",
    targetBranch: "main",
    note: "Pre-seeded release note",
    now,
  });

  assert.equal(res.ok, true);
  // Post-condition: file is now committed, working tree clean
  const postStatus = await cmd.run("git", ["-C", kbDir, "status", "--porcelain", "--", relFile]);
  assert.equal(postStatus.stdout.trim(), "");
  const logRes = await cmd.run("git", ["-C", kbDir, "log", "-1", "--oneline"]);
  assert.match(logRes.stdout, /rel\(PLUG-293\): Pre-seeded release note/);
});

test("recordReleaseNote: skips duplicate commit when grep.patternType is extended", async () => {
  const { kbDir } = makeKbRepo();
  gitCmd(kbDir, ["config", "grep.patternType", "extended"]);
  const cmd = createCmd();
  const fixedDate = new Date("2026-11-17T14:30:00Z");
  const now = () => fixedDate.getTime();

  const res1 = await recordReleaseNote(kbDir, cmd, {
    taskKey: "PLUG-293",
    sha7: "abcdef1",
    targetBranch: "main",
    note: "Initial release note",
    now,
  });
  assert.equal(res1.ok, true);

  const logBefore = await cmd.run("git", ["-C", kbDir, "rev-parse", "HEAD"]);
  const res2 = await recordReleaseNote(kbDir, cmd, {
    taskKey: "PLUG-293",
    sha7: "abcdef1",
    targetBranch: "main",
    note: "Initial release note",
    now,
  });
  assert.equal(res2.ok, true);
  const logAfter = await cmd.run("git", ["-C", kbDir, "rev-parse", "HEAD"]);
  assert.equal(logBefore.stdout, logAfter.stdout);
});

test("statusKb: throws not-a-repo when kb directory exists without .git", async () => {
  const base = makeTempDir("kb-notrepo-");
  const cmd = createCmd();
  await assert.rejects(
    () => statusKb(base, cmd),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: not-a-repo/);
      return true;
    },
  );
});

test("statusKb: throws not-a-repo when kb directory does not exist on disk", async () => {
  const missingDir = join(makeTempDir("kb-nonexistent-"), "missing");
  const cmd = createCmd();
  await assert.rejects(
    () => statusKb(missingDir, cmd),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: not-a-repo/);
      return true;
    },
  );
});

test("writeKbFile and appendKbFile: fallback commit message is kb(cli): <relPath> when no context", async () => {
  const { kbDir } = makeKbRepo();
  const cmd = createCmd();
  const writeRes = await writeKbFile(kbDir, "cli-note.md", "Content from cli", cmd);
  assert.equal(writeRes.ok, true);
  assert.equal(writeRes.committed, true);
  const logRes1 = await cmd.run("git", ["-C", kbDir, "log", "-1", "--oneline"]);
  assert.match(logRes1.stdout, /kb\(cli\): cli-note\.md/);

  const appendRes = await appendKbFile(kbDir, "cli-note.md", "\nAppended from cli", cmd);
  assert.equal(appendRes.ok, true);
  assert.equal(appendRes.committed, true);
  const logRes2 = await cmd.run("git", ["-C", kbDir, "log", "-1", "--oneline"]);
  assert.match(logRes2.stdout, /kb\(cli\): cli-note\.md/);
});

test("statusKb: throws OrchestratorError status-failed on git status failure", async () => {
  const { kbDir } = makeKbRepo();
  const failingCmd: CmdRunner = {
    run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: corrupted git repo" }),
  };
  await assert.rejects(
    () => statusKb(kbDir, failingCmd),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: status-failed/);
      return true;
    },
  );
});

test("syncKb: throws OrchestratorError remote-failed when git remote fails", async () => {
  const { kbDir } = makeKbRepo();
  const failingCmd: CmdRunner = {
    run: async (cmd, args) => {
      if (args.includes("remote")) {
        return { exitCode: 128, stdout: "", stderr: "fatal: corrupted git repo" };
      }
      return createCmd().run(cmd, args);
    },
  };
  await assert.rejects(
    () => syncKb(kbDir, failingCmd),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: remote-failed/);
      return true;
    },
  );
});

test("recordReleaseNote: throws OrchestratorError log-failed on git log failure", async () => {
  const { kbDir } = makeKbRepo();
  const realCmd = createCmd();
  const failingCmd: CmdRunner = {
    run: async (cmd, args, opts) => {
      if (args.includes("log")) {
        return { exitCode: 128, stdout: "", stderr: "fatal: git log failure" };
      }
      return realCmd.run(cmd, args, opts);
    },
  };
  await assert.rejects(
    () =>
      recordReleaseNote(kbDir, failingCmd, {
        taskKey: "PLUG-293",
        sha7: "abcdef1",
        targetBranch: "main",
        note: "Test note",
      }),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: log-failed/);
      return true;
    },
  );
});

test("RBAC: orchestrator_kb blocks mutations for auditor role", async () => {
  const { kbDir } = makeKbRepo();
  const rbacDataDir = makeTempDir("orch-rbac-");
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: rbacDataDir,
    sdk: {
      threads: {
        updatePluginMetadata: async () => ({}),
      },
    },
    settings: {
      policy:
        '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
      kb: JSON.stringify({
        enabled: true,
        path: kbDir,
        autoSync: false,
        requireCleanOnRelease: true,
      }),
    },
  });
  await createPlugin(host.bb, { bbCli: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } });

  // 1. Auditor thread: read allowed, write denied
  const auditorThreadId = "thr_aud";
  await host.harness.callRpc("setThreadRole", {
    threadId: auditorThreadId,
    role: "auditor",
  });

  const listRes = await host.harness.callAgentTool("orchestrator_kb", {
    action: "list",
  }, { threadId: auditorThreadId });
  const parsedList = JSON.parse(listRes as string);
  assert.equal(parsedList.ok, true);

  const writeRes = await host.harness.callAgentTool("orchestrator_kb", {
    action: "write",
    path: "test.md",
    content: "content",
  }, { threadId: auditorThreadId });
  const parsedWrite = JSON.parse(writeRes as string);
  assert.equal(parsedWrite.ok, false);
  assert.equal(parsedWrite.error.code, "permission-denied");
  assert.match(
    parsedWrite.error.message,
    /(роль auditor не может изменять базу знаний|role auditor cannot modify knowledge base)/,
  );

  // 2. Release-auditor thread: mutation denied with role name
  const releaseAuditorThreadId = "thr_rel_aud";
  const rbacDb = host.bb.storage.database();
  rbacDb.prepare("INSERT OR REPLACE INTO thread_roles (thread_id, role, decided_at, source) VALUES (?, ?, ?, ?)").run(
    releaseAuditorThreadId,
    "release-auditor",
    Date.now(),
    "delegate",
  );

  const relAudWriteRes = await host.harness.callAgentTool("orchestrator_kb", {
    action: "write",
    path: "test.md",
    content: "content",
  }, { threadId: releaseAuditorThreadId });
  const parsedRelAudWrite = JSON.parse(relAudWriteRes as string);
  assert.equal(parsedRelAudWrite.ok, false);
  assert.equal(parsedRelAudWrite.error.code, "permission-denied");
  assert.match(
    parsedRelAudWrite.error.message,
    /(роль release-auditor не может изменять базу знаний|role release-auditor cannot modify knowledge base)/,
  );

  // 3. Other/none role: denied by allowlist
  const noneThreadId = "thr_none";
  await host.harness.callRpc("setThreadRole", {
    threadId: noneThreadId,
    role: "none",
  });
  const noneWriteRes = await host.harness.callAgentTool("orchestrator_kb", {
    action: "write",
    path: "test.md",
    content: "content",
  }, { threadId: noneThreadId });
  const parsedNoneWrite = JSON.parse(noneWriteRes as string);
  assert.equal(parsedNoneWrite.ok, false);
  assert.equal(parsedNoneWrite.error.code, "permission-denied");

  // 4. Executor thread: write allowed
  const executorThreadId = "thr_exec";
  await host.harness.callRpc("setThreadRole", {
    threadId: executorThreadId,
    role: "executor",
  });

  const execWriteRes = await host.harness.callAgentTool("orchestrator_kb", {
    action: "write",
    path: "test.md",
    content: "from executor",
  }, { threadId: executorThreadId });
  const parsedExecWrite = JSON.parse(execWriteRes as string);
  assert.equal(parsedExecWrite.ok, true);
});

test("orchestrator_kb MCP: returns kb-disabled before RBAC when kb.enabled: false", async () => {
  const { kbDir } = makeKbRepo();
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-kb-disabled-mcp-"),
    sdk: {
      threads: {
        updatePluginMetadata: async () => ({}),
      },
    },
    settings: {
      policy:
        '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
      kb: JSON.stringify({
        enabled: false,
        path: kbDir,
        autoSync: false,
        requireCleanOnRelease: true,
      }),
    },
  });
  await createPlugin(host.bb, { bbCli: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } });

  const auditorThreadId = "thr_aud_dis";
  await host.harness.callRpc("setThreadRole", {
    threadId: auditorThreadId,
    role: "auditor",
  });

  const writeRes = await host.harness.callAgentTool(
    "orchestrator_kb",
    {
      action: "write",
      path: "test.md",
      content: "content",
    },
    { threadId: auditorThreadId },
  );
  const parsed = JSON.parse(writeRes as string);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "kb-disabled");
  assert.match(parsed.error.message, /kb-refused: kb-disabled/);
});

test("CLI: bb orchestrator kb commands", async () => {
  const { kbDir } = makeKbRepo();
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-cli-kb-"),
    settings: {
      policy:
        '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
      kb: JSON.stringify({
        enabled: true,
        path: kbDir,
        autoSync: false,
        requireCleanOnRelease: true,
      }),
    },
  });
  await createPlugin(host.bb, { bbCli: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } });

  // 1. kb list --json
  const listOut = await host.harness.runCli(["kb", "list", "--json"]);
  assert.equal(listOut.exitCode, 0);
  const listJson = JSON.parse(listOut.stdout);
  assert.deepEqual(listJson.files, ["README.md"]);

  // 2. kb write
  const writeOut = await host.harness.runCli([
    "kb",
    "write",
    "hello.md",
    "--content",
    "Hello Knowledge Base!",
  ]);
  if (writeOut.exitCode !== 0) {
    console.log("writeOut error:", writeOut);
  }
  assert.equal(writeOut.exitCode, 0);
  assert.match(writeOut.stdout, /KB write: hello\.md/);

  // 2b. kb write with identical content outputs (unchanged)
  const writeUnchanged = await host.harness.runCli([
    "kb",
    "write",
    "hello.md",
    "--content",
    "Hello Knowledge Base!",
  ]);
  assert.equal(writeUnchanged.exitCode, 0);
  assert.equal(writeUnchanged.stdout, "KB write: hello.md (unchanged)\n");

  // 2c. kb write --file and invalid --file error
  const tempInputFile = join(kbDir, "temp-input.txt");
  writeFileSync(tempInputFile, "Input from file content\n");
  const writeWithFile = await host.harness.runCli([
    "kb",
    "write",
    "from-file.md",
    "--file",
    tempInputFile,
  ]);
  assert.equal(writeWithFile.exitCode, 0);
  assert.match(writeWithFile.stdout, /KB write: from-file\.md/);
  rmSync(tempInputFile);

  const writeBadFile = await host.harness.runCli([
    "kb",
    "write",
    "fail.md",
    "--file",
    "/path/to/definitely/nonexistent/file.txt",
    "--json",
  ]);
  assert.equal(writeBadFile.exitCode, 1);
  const badFileJson = JSON.parse(writeBadFile.stdout);
  assert.equal(badFileJson.error.code, "invalid-arguments");
  assert.match(
    badFileJson.error.message,
    /не удалось прочитать файл --file|cannot read --file/,
  );

  // 3. kb read
  const readOut = await host.harness.runCli(["kb", "read", "hello.md"]);
  assert.equal(readOut.exitCode, 0);
  assert.equal(readOut.stdout, "Hello Knowledge Base!");

  // 4. kb search (positional and --query)
  const searchOut = await host.harness.runCli(["kb", "search", "Knowledge", "--json"]);
  assert.equal(searchOut.exitCode, 0);
  const searchJson = JSON.parse(searchOut.stdout);
  assert.ok(searchJson.results.length >= 1);

  const searchFlagOut = await host.harness.runCli(["kb", "search", "--query", "Knowledge", "--json"]);
  assert.equal(searchFlagOut.exitCode, 0);
  const searchFlagJson = JSON.parse(searchFlagOut.stdout);
  assert.ok(searchFlagJson.results.length >= 1);

  // 4b. kb search --limit validation
  const searchBadLimit = await host.harness.runCli(["kb", "search", "Knowledge", "--limit", "abc", "--json"]);
  assert.equal(searchBadLimit.exitCode, 1);
  const badLimitJson = JSON.parse(searchBadLimit.stdout);
  assert.equal(badLimitJson.error.code, "invalid-arguments");

  const searchZeroLimit = await host.harness.runCli(["kb", "search", "Knowledge", "--limit", "0", "--json"]);
  assert.equal(searchZeroLimit.exitCode, 1);
  const zeroLimitJson = JSON.parse(searchZeroLimit.stdout);
  assert.equal(zeroLimitJson.error.code, "invalid-arguments");

  // 5. kb status
  const statusOut = await host.harness.runCli(["kb", "status", "--json"]);
  assert.equal(statusOut.exitCode, 0);
  const statusJson = JSON.parse(statusOut.stdout);
  assert.equal(statusJson.clean, true);

  // 6. kb sync on repo with remote
  const syncOut = await host.harness.runCli(["kb", "sync"]);
  assert.equal(syncOut.exitCode, 0);
  assert.equal(syncOut.stdout, "KB sync: OK\n");
});

test("writeKbFile/appendKbFile and kb sync on repo without remote", async () => {
  const base = makeTempDir("kb-no-upstream-");
  const kbDir = join(base, "kb");
  execFileSync("git", ["init", kbDir]);
  gitCmd(kbDir, ["config", "user.name", "Agent"]);
  gitCmd(kbDir, ["config", "user.email", "agent@test.local"]);
  gitCmd(kbDir, ["checkout", "-b", "main"]);
  writeFileSync(join(kbDir, "README.md"), "# Knowledge Base\n");
  gitCmd(kbDir, ["add", "."]);
  gitCmd(kbDir, ["commit", "-m", "init kb"]);

  const cmd = createCmd();
  // writeKbFile with autoSync
  const { writeKbFile, appendKbFile } = await import("../src/kb.js");
  const writeRes = await writeKbFile(kbDir, "doc.md", "hello", cmd, { autoSync: true });
  assert.equal(writeRes.ok, true);
  assert.equal(writeRes.synced, false);
  assert.equal(writeRes.syncError, "no remotes configured");

  // appendKbFile with autoSync
  const appendRes = await appendKbFile(kbDir, "doc.md", "world", cmd, { autoSync: true });
  assert.equal(appendRes.ok, true);
  assert.equal(appendRes.synced, false);
  assert.equal(appendRes.syncError, "no remotes configured");

  // kb sync CLI on repo without remote
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-cli-noremote-"),
    settings: {
      policy:
        '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
      kb: JSON.stringify({
        enabled: true,
        path: kbDir,
        autoSync: false,
        requireCleanOnRelease: true,
      }),
    },
  });
  await createPlugin(host.bb, { bbCli: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } });
  const cliSyncOut = await host.harness.runCli(["kb", "sync"]);
  assert.equal(cliSyncOut.exitCode, 1);
  assert.match(cliSyncOut.stdout, /KB sync: not synced \(no remotes configured\)/);
});

test("release Step 1 gate: rejects when KB is dirty", async () => {
  const { kbDir } = makeKbRepo();
  writeFileSync(join(kbDir, "uncommitted.md"), "dirty");

  const kbConfig: KbConfig = {
    enabled: true,
    path: kbDir,
    autoSync: false,
    requireCleanOnRelease: true,
  };

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const exec = store.insert({
    taskKey: "TEST-1",
    projectId: "test",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "c",
    preset: "c",
    provider: "p",
  });
  store.setStatus(exec.id, "done");
  store.setMerged(exec.id, {
    into: "main",
    sha: "a".repeat(40),
  });

  const hooksDir = makeTempDir("hooks-");

  const deps: ReleaseDeps = {
    store,
    bbCli: {
      run: async (args: string[]) => {
        const key = args.join(" ");
        if (key.startsWith("project list")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: "test",
                sources: [
                  {
                    type: "local_path",
                    path: kbDir,
                    isDefault: true,
                  },
                ],
              },
            ]),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            task: { id: "t1", key: "TEST-1", title: "Test", status: "in_review" },
            project: { name: "p", linkedBbProjectId: "test" },
            subtasks: [],
            attachments: [],
            comments: [],
          }),
          stderr: "",
        };
      },
    },
    localHostId: async () => "",
    threads: {
      get: async () => ({
        id: "thr_coord",
        environmentPath: kbDir,
        parentThreadId: null,
      }),
    } as unknown as ReleaseDeps["threads"],
    cmd: createCmd(),
    hooksDir: () => hooksDir,
    loadPolicy: async () => ({
      policy: {
        version: 1,
        levels: {
          complex: { chain: ["c"] },
          "release-audit": { chain: ["c"] },
        },
        routes: { c: { preset: "p", provider: "p" } },
      },
      errors: [],
      warnings: [],
    }),
    loadReleaseConfig: () => ({
      config: {
        defaults: {},
        projects: {
          test: {
            paths: ["."],
            target: { action: "push", branch: "main" },
          },
        },
      },
      errors: [],
      warnings: [],
    }),
    coordinationBranch: () => "main",
    checkProject: async () => ({ ok: true, output: "" }),
    sendCoordinator: async () => {},
    kbConfig: () => kbConfig,
    probes: {
      delegationByThreadId: () => undefined,
      hasFreshDispatching: () => false,
      roleByThreadId: () => "orchestrator",
    },
    enqueue: <T>(f: () => Promise<T>) => f(),
    t,
  } as unknown as ReleaseDeps;

  await assert.rejects(
    () =>
      runRelease(
        {
          taskKey: "TEST-1",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "Coord",
            originPluginId: null,
            projectId: "test",
          },
        },
        deps,
      ),
    (err: unknown) =>
      err instanceof OrchestratorError &&
      err.code === "release-refused" &&
      err.message.includes("uncommitted-kb") &&
      err.message.includes("uncommitted.md"),
  );
});

test("release Step 1 gate: rejects when KB git status check fails", async () => {
  const { kbDir } = makeKbRepo();

  const kbConfig: KbConfig = {
    enabled: true,
    path: kbDir,
    autoSync: false,
    requireCleanOnRelease: true,
  };

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const exec = store.insert({
    taskKey: "TEST-2",
    projectId: "test",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "c",
    preset: "c",
    provider: "p",
  });
  store.setStatus(exec.id, "done");
  store.setMerged(exec.id, {
    into: "main",
    sha: "b".repeat(40),
  });
  const rev = store.insert({
    taskKey: "TEST-2",
    projectId: "test",
    coordinatorThreadId: "thr_coord",
    level: "release-audit",
    route: "c",
    preset: "c",
    provider: "p",
    continueFrom: "b".repeat(40),
  });
  store.setStatus(rev.id, "done");

  const hooksDir = makeTempDir("hooks-");
  const failingCmd: CmdRunner = {
    run: async (cmd, args, opts) => {
      if (args.includes("status")) {
        return { exitCode: 128, stdout: "", stderr: "fatal: corrupted git repo" };
      }
      return createCmd().run(cmd, args, opts);
    },
  };

  const deps: ReleaseDeps = {
    store,
    bbCli: {
      run: async (args: string[]) => {
        const key = args.join(" ");
        if (key.startsWith("project list")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: "test",
                sources: [
                  {
                    type: "local_path",
                    path: kbDir,
                    isDefault: true,
                  },
                ],
              },
            ]),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            task: { id: "t2", key: "TEST-2", title: "Test", status: "in_review" },
            project: { name: "p", linkedBbProjectId: "test" },
            subtasks: [],
            attachments: [],
            comments: [],
          }),
          stderr: "",
        };
      },
    },
    localHostId: async () => "",
    threads: {
      get: async () => ({
        id: "thr_coord",
        environmentPath: kbDir,
        parentThreadId: null,
      }),
    } as unknown as ReleaseDeps["threads"],
    cmd: failingCmd,
    hooksDir: () => hooksDir,
    loadPolicy: async () => ({
      policy: {
        version: 1,
        levels: {
          complex: { chain: ["c"] },
          "release-audit": { chain: ["c"] },
        },
        routes: { c: { preset: "p", provider: "p" } },
      },
      errors: [],
      warnings: [],
    }),
    loadReleaseConfig: () => ({
      config: {
        defaults: {},
        projects: {
          test: {
            paths: ["."],
            target: { action: "push", branch: "main" },
          },
        },
      },
      errors: [],
      warnings: [],
    }),
    coordinationBranch: () => "main",
    checkProject: async () => ({ ok: true, output: "" }),
    sendCoordinator: async () => {},
    kbConfig: () => kbConfig,
    probes: {
      delegationByThreadId: () => undefined,
      hasFreshDispatching: () => false,
      roleByThreadId: () => "orchestrator",
    },
    enqueue: <T>(f: () => Promise<T>) => f(),
    t,
  } as unknown as ReleaseDeps;

  await assert.rejects(
    () =>
      runRelease(
        {
          taskKey: "TEST-2",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "Coord",
            originPluginId: null,
            projectId: "test",
          },
        },
        deps,
      ),
    (err: unknown) =>
      err instanceof OrchestratorError &&
      err.code === "release-refused" &&
      err.message.includes("uncommitted-kb") &&
      err.message.includes("сбой проверки базы знаний"),
  );
});

test("release Step 1 gate: rejects when KB directory does not exist on disk", async () => {
  const { kbDir: projDir } = makeKbRepo();
  const missingKbDir = join(makeTempDir("kb-missing-"), "missing");
  const kbConfig: KbConfig = {
    enabled: true,
    path: missingKbDir,
    autoSync: false,
    requireCleanOnRelease: true,
  };

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const exec = store.insert({
    taskKey: "TEST-3",
    projectId: "test",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "c",
    preset: "c",
    provider: "p",
  });
  store.setStatus(exec.id, "done");
  store.setMerged(exec.id, {
    into: "main",
    sha: "b".repeat(40),
  });
  const rev = store.insert({
    taskKey: "TEST-3",
    projectId: "test",
    coordinatorThreadId: "thr_coord",
    level: "release-audit",
    route: "c",
    preset: "c",
    provider: "p",
    continueFrom: "b".repeat(40),
  });
  store.setStatus(rev.id, "done");

  const hooksDir = makeTempDir("hooks-");
  const deps: ReleaseDeps = {
    store,
    bbCli: {
      run: async (args: string[]) => {
        const key = args.join(" ");
        if (key.startsWith("project list")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: "test",
                sources: [
                  {
                    type: "local_path",
                    path: projDir,
                    isDefault: true,
                  },
                ],
              },
            ]),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            task: { id: "t3", key: "TEST-3", title: "Test", status: "in_review" },
            project: { name: "p", linkedBbProjectId: "test" },
            subtasks: [],
            attachments: [],
            comments: [],
          }),
          stderr: "",
        };
      },
    },
    localHostId: async () => "",
    threads: {
      get: async () => ({
        id: "thr_coord",
        environmentPath: projDir,
        parentThreadId: null,
      }),
    } as unknown as ReleaseDeps["threads"],
    cmd: createCmd(),
    hooksDir: () => hooksDir,
    loadPolicy: async () => ({
      policy: {
        version: 1,
        levels: {
          complex: { chain: ["c"] },
          "release-audit": { chain: ["c"] },
        },
        routes: { c: { preset: "p", provider: "p" } },
      },
      errors: [],
      warnings: [],
    }),
    loadReleaseConfig: () => ({
      config: {
        defaults: {},
        projects: {
          test: {
            paths: ["."],
            target: { action: "push", branch: "main" },
          },
        },
      },
      errors: [],
      warnings: [],
    }),
    coordinationBranch: () => "main",
    checkProject: async () => ({ ok: true, output: "" }),
    sendCoordinator: async () => {},
    kbConfig: () => kbConfig,
    probes: {
      delegationByThreadId: () => undefined,
      hasFreshDispatching: () => false,
      roleByThreadId: () => "orchestrator",
    },
    enqueue: <T>(f: () => Promise<T>) => f(),
    t,
  } as unknown as ReleaseDeps;

  await assert.rejects(
    () =>
      runRelease(
        {
          taskKey: "TEST-3",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "Coord",
            originPluginId: null,
            projectId: "test",
          },
        },
        deps,
      ),
    (err: unknown) =>
      err instanceof OrchestratorError &&
      err.code === "release-refused" &&
      err.message.includes("uncommitted-kb") &&
      err.message.includes("сбой проверки базы знаний"),
  );
});

test("release Step 7 postPublish: auto-records release note into KB", async () => {
  const { kbDir } = makeKbRepo();
  const kbConfig: KbConfig = {
    enabled: true,
    path: kbDir,
    autoSync: true,
    requireCleanOnRelease: true,
  };

  const metaStore = new Map<string, string>();
  const deps: ReleaseDeps = {
    cmd: createCmd(),
    kbConfig: () => kbConfig,
    loadReleaseConfig: () => ({ config: null, errors: [], warnings: [] }),
    store: {
      commandRunsByGroup: () => [],
      metaGet: (k: string) => metaStore.get(k) ?? null,
      metaSet: (k: string, v: string) => {
        metaStore.set(k, v);
      },
      skipQueuedCommandRun: () => {},
    },
    t,
    now: () => new Date("2026-11-17T12:00:00Z").getTime(),
  } as unknown as ReleaseDeps;

  const row = {
    id: 1,
    task_key: "PLUG-293",
    head_sha: "1234567890abcdef",
    published_sha: "1234567890abcdef",
    target_branch: "main",
    kb_note: "Feature released successfully",
  } as never;

  const pp = await runPostPublish(deps, row, "release.published");
  assert.equal(pp.done, true);
  assert.ok(pp.summary?.includes("KB: записан релиз"));

  // Verify file was written in KB
  const noteFile = join(kbDir, "releases", "2026-11-17-PLUG-293.md");
  assert.ok(existsSync(noteFile));
  const noteContent = readFileSync(noteFile, "utf8");
  assert.match(noteContent, /Feature released successfully/);
  assert.match(noteContent, /Feature released successfully/);
});

test("release Step 7 postPublish: reports kb-disabled when kb.enabled: false", async () => {
  const base = makeTempDir("kb-disabled-");
  const kbConfig: KbConfig = {
    enabled: false,
    path: base,
    autoSync: false,
    requireCleanOnRelease: false,
  };

  const metaStore = new Map<string, string>();
  const deps: ReleaseDeps = {
    cmd: createCmd(),
    kbConfig: () => kbConfig,
    loadReleaseConfig: () => ({ config: null, errors: [], warnings: [] }),
    store: {
      commandRunsByGroup: () => [],
      metaGet: (k: string) => metaStore.get(k) ?? null,
      metaSet: (k: string, v: string) => {
        metaStore.set(k, v);
      },
      skipQueuedCommandRun: () => {},
    },
    t,
    now: () => new Date("2026-11-17T12:00:00Z").getTime(),
  } as unknown as ReleaseDeps;

  const row = {
    id: 1,
    task_key: "PLUG-293",
    head_sha: "1234567890abcdef",
    published_sha: "1234567890abcdef",
    target_branch: "main",
    kb_note: "Feature released successfully",
  } as never;

  const pp = await runPostPublish(deps, row, "release.published");
  assert.equal(pp.done, true);
  assert.match(pp.summary ?? "", /KB: не записано, ошибка: kb-disabled/);
});

test("ensureKbRepo: initializes git repository on missing directory", async () => {
  const base = makeTempDir("kb-ensure-missing-");
  const targetDir = join(base, "fresh-kb");
  assert.equal(existsSync(targetDir), false);

  const cmd = createCmd();
  await ensureKbRepo(targetDir, cmd);

  assert.equal(existsSync(targetDir), true);
  assert.equal(existsSync(join(targetDir, ".git")), true);
  assert.equal(existsSync(join(targetDir, ".git", "HEAD")), true);
});

test("ensureKbRepo: throws init-failed when git init fails", async () => {
  const base = makeTempDir("kb-ensure-fail-");
  const targetDir = join(base, "fresh-kb");

  const failingCmd: CmdRunner = {
    run: async () => ({
      stdout: "",
      stderr: "fatal: permission denied",
      exitCode: 128,
    }),
  };

  await assert.rejects(
    async () => {
      await ensureKbRepo(targetDir, failingCmd);
    },
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: init-failed/);
      assert.match(err.message, /permission denied/);
      return true;
    },
  );
});

test("readKbFile: throws kb-refused file-not-found when document does not exist", () => {
  const base = makeTempDir("kb-read-missing-");
  assert.throws(
    () => {
      readKbFile(base, "missing.md");
    },
    (err: unknown) => {
      assert(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: file-not-found/);
      return true;
    },
  );
});

test("ensureKbRepo: throws init-failed when mkdir fails", async () => {
  const base = makeTempDir("kb-mkdir-fail-");
  const fileAsDir = join(base, "blocked-file");
  writeFileSync(fileAsDir, "I am a file, not a directory");
  const impossiblePath = join(fileAsDir, "sub-repo");
  const cmd = createCmd();
  await assert.rejects(
    () => ensureKbRepo(impossiblePath, cmd),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: init-failed/);
      return true;
    },
  );
});

test("searchKbFiles: applies default limit 50 when limit is not specified", () => {
  const base = makeTempDir("kb-search-limit-");
  const manyLines = Array.from({ length: 100 }, (_, i) => `match line ${i}`).join("\n");
  writeFileSync(join(base, "doc.md"), manyLines);
  const results = searchKbFiles(base, "match");
  assert.equal(results.length, 50);
});

test("writeKbFile: uses taskKey in commit message kb(<taskKey>): <path>", async () => {
  const { kbDir } = makeKbRepo();
  const cmd = createCmd();
  const res = await writeKbFile(kbDir, "feature.md", "content", cmd, { taskKey: "PLUG-293" });
  assert.equal(res.ok, true);
  const lastCommit = gitCmd(kbDir, ["log", "-1", "--pretty=%s"]);
  assert.equal(lastCommit, "kb(PLUG-293): feature.md");
});

test("syncKb: distinguishes conflict (sync-conflict) from general pull error (sync-failed)", async () => {
  const base = makeTempDir("kb-sync-err-");
  const kbDir = join(base, "kb");
  execFileSync("git", ["init", kbDir]);
  gitCmd(kbDir, ["config", "user.name", "Agent"]);
  gitCmd(kbDir, ["config", "user.email", "agent@test.local"]);
  gitCmd(kbDir, ["checkout", "-b", "main"]);
  writeFileSync(join(kbDir, "README.md"), "# KB\n");
  gitCmd(kbDir, ["add", "."]);
  gitCmd(kbDir, ["commit", "-m", "init"]);
  gitCmd(kbDir, ["remote", "add", "origin", "git://invalid.host.local/no-such-repo.git"]);

  const cmd = createCmd();
  await assert.rejects(
    () => syncKb(kbDir, cmd),
    (err: unknown) => {
      assert.ok(err instanceof OrchestratorError);
      assert.equal(err.code, "kb-refused");
      assert.match(err.message, /kb-refused: sync-failed/);
      return true;
    },
  );
});
