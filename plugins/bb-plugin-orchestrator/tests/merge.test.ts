import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS, type DelegationRow } from "../src/store.js";
import {
  runMerge,
  type MergeDeps,
  type MergeGitResult,
} from "../src/merge.js";
import { OrchestratorError } from "../src/errors.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";

const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

function gitR(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

function gitRes(repo: string, args: string[]): MergeGitResult {
  try {
    const out = execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
    });
    return { exitCode: 0, stdout: out, stderr: "" };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: x.status ?? 1,
      stdout: x.stdout ?? "",
      stderr: x.stderr ?? "",
    };
  }
}

interface Repos {
  base: string;
  coord: string;
  exec: string;
  resultSha: string;
}

/**
 * The coordinator's copy is a clone on branch `work`; the executor's copy
 * is a linked worktree on `bb/plug-1` — same object store, so the
 * coordinator's repo sees `resultSha` (as in a real bb git-worktree env).
 * `conflict: true` gives `work` a competing change to the same file.
 */
function makeRepos(opts: { conflict?: boolean } = {}): Repos {
  const base = mkdtempSync(join(tmpdir(), "merge-"));
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "--bare", remote]);
  const coord = join(base, "coord");
  execFileSync("git", ["init", "-b", "main", coord]);
  gitR(coord, ["config", "user.name", "Agent"]);
  gitR(coord, ["config", "user.email", "agent@x.io"]);
  writeFileSync(join(coord, "a.txt"), "one\n");
  gitR(coord, ["add", "."]);
  gitR(coord, ["commit", "-m", "base"]);
  gitR(coord, ["remote", "add", "origin", remote]);
  gitR(coord, ["push", "-u", "origin", "main"]);
  gitR(coord, ["checkout", "-b", "work"]);
  const exec = join(base, "exec");
  gitR(coord, ["worktree", "add", exec, "-b", "bb/plug-1"]);
  if (opts.conflict) {
    writeFileSync(join(coord, "f.txt"), "coordinator side\n");
    gitR(coord, ["add", "."]);
    gitR(coord, ["commit", "-m", "coord change"]);
  }
  writeFileSync(
    join(exec, "f.txt"),
    opts.conflict ? "executor side\n" : "feature\n",
  );
  gitR(exec, ["add", "."]);
  gitR(exec, ["commit", "-m", "feat"]);
  const resultSha = gitR(exec, ["rev-parse", "HEAD"]);
  return { base, coord, exec, resultSha };
}

function makeDeps(opts: {
  coord: string;
  exec?: string | null;
  mergeAutofix?: boolean;
  delegateFail?: Error;
}) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const row = store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "r",
    preset: "r",
    provider: "p",
  });
  store.setThreadInfo(row.id, "thr_exec");
  store.setStatus(row.id, "done");
  const comments: string[] = [];
  const sent: string[] = [];
  const delegated: {
    taskKey: string;
    level: string;
    from?: string;
    instructions?: string;
  }[] = [];
  const bbCli: BbCli = {
    run: async (args) => {
      if (args.join(" ").startsWith("tasks comment")) {
        comments.push(args[args.length - 1]!);
      }
      return ok();
    },
  };
  const deps: MergeDeps = {
    store,
    bbCli,
    git: async (repo, args) => gitRes(repo, args),
    environment: async (threadId) =>
      threadId === "thr_coord"
        ? { path: opts.coord }
        : opts.exec
          ? { path: opts.exec }
          : null,
    environmentById: async (envId) =>
      opts.exec && envId === "env_exec" ? { path: opts.exec } : null,
    threads: {
      send: async (a) => {
        sent.push((a.input[0] as { text: string }).text);
        return {};
      },
    },
    delegate: async (input) => {
      delegated.push(input);
      if (opts.delegateFail) throw opts.delegateFail;
      return { delegationId: 42, threadId: "thr_fix" };
    },
    mergeAutofix: () => opts.mergeAutofix ?? false,
  };
  return { deps, store, row, comments, sent, delegated };
}

function recordResult(
  store: DelegationStore,
  row: DelegationRow,
  sha: string,
  dirty = false,
) {
  store.setRoundResult(row.id, {
    envId: "env_exec",
    branch: "bb/plug-1",
    sha,
    commits: 1,
    dirty,
  });
}

const PARAMS = { ref: "PLUG-1", callerThreadId: "thr_coord" };

// ── §14: clean merge ──────────────────────────────────────────────────

test("clean merge: merge commit, record, task comment", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, store, row, comments } = makeDeps({ coord, exec });
  recordResult(store, row, resultSha);

  const res = await runMerge(PARAMS, deps);
  assert.ok("mergeStatus" in res && res.mergeStatus === "merged");
  assert.equal(res.into, "work");
  const head = gitR(coord, ["rev-parse", "HEAD"]);
  assert.equal(res.mergedSha, head);
  assert.match(
    gitR(coord, ["log", "-1", "--format=%s"]),
    new RegExp(`^merge PLUG-1 r1 \\(${resultSha.slice(0, 7)}\\)$`),
  );
  assert.ok(gitR(coord, ["cat-file", "-e", "HEAD:f.txt"]).length >= 0);
  const fresh = store.get(row.id)!;
  assert.equal(fresh.merge_status, "merged");
  assert.equal(fresh.merged_into, "work");
  assert.equal(fresh.merged_sha, head);
  assert.ok(fresh.merged_at != null);
  assert.deepEqual(comments, [
    `Влито в work (${head.slice(0, 7)})`,
  ]);
});

test("merge --into <branch>: checks out the target and merges there", async () => {
  const { coord, exec, resultSha } = makeRepos();
  gitR(coord, ["branch", "target"]);
  const { deps, store, row } = makeDeps({ coord, exec });
  recordResult(store, row, resultSha);

  const res = await runMerge(
    { ...PARAMS, into: "target" },
    deps,
  );
  assert.ok("mergeStatus" in res && res.mergeStatus === "merged");
  assert.equal(res.into, "target");
  assert.equal(gitR(coord, ["symbolic-ref", "--short", "HEAD"]), "target");
  assert.equal(store.get(row.id)!.merged_into, "target");
});

// ── §14 conflict: abort → clean copy; §16.6 mergeAutofix ──────────────

test("conflict + mergeAutofix: copy clean after abort, fix round delegated", async () => {
  const { coord, exec, resultSha } = makeRepos({ conflict: true });
  const tip = gitR(coord, ["rev-parse", "HEAD"]);
  const { deps, store, row, sent, delegated } = makeDeps({
    coord,
    exec,
    mergeAutofix: true,
  });
  recordResult(store, row, resultSha);

  const res = await runMerge(PARAMS, deps);
  assert.ok("mergeStatus" in res && res.mergeStatus === "fix-delegated");
  assert.equal(res.fixDelegationId, 42);
  assert.equal(res.fixThreadId, "thr_fix");
  // the copy returned to its pre-merge state
  assert.equal(gitR(coord, ["status", "--porcelain"]), "");
  assert.equal(gitR(coord, ["rev-parse", "HEAD"]), tip);
  assert.equal(gitRes(coord, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).exitCode, 1);
  assert.equal(store.get(row.id)!.merge_status, "fix-delegated");
  assert.equal(delegated.length, 1);
  assert.deepEqual(
    {
      taskKey: delegated[0]!.taskKey,
      level: delegated[0]!.level,
      from: delegated[0]!.from,
    },
    { taskKey: "PLUG-1", level: "complex", from: resultSha },
  );
  assert.match(
    delegated[0]!.instructions ?? "",
    new RegExp(`Влей work@${tip.slice(0, 7)} в свою ветку: git merge -m "merge ${tip.slice(0, 7)}" ${tip}`),
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /конфликт/);
  assert.match(sent[0]!, /#42/);
});

test("conflict + mergeAutofix off (default): report only, no delegation", async () => {
  const { coord, exec, resultSha } = makeRepos({ conflict: true });
  const tip = gitR(coord, ["rev-parse", "HEAD"]);
  const { deps, store, row, sent, delegated } = makeDeps({ coord, exec });
  recordResult(store, row, resultSha);

  const res = await runMerge(PARAMS, deps);
  assert.ok("mergeStatus" in res && res.mergeStatus === "conflict");
  assert.ok(res.conflictFiles!.includes("f.txt"));
  assert.equal(gitR(coord, ["status", "--porcelain"]), "");
  assert.equal(gitR(coord, ["rev-parse", "HEAD"]), tip);
  assert.equal(store.get(row.id)!.merge_status, "conflict");
  assert.equal(delegated.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /конфликт/);
});

test("conflict + --no-autofix beats the mergeAutofix setting", async () => {
  const { coord, exec, resultSha } = makeRepos({ conflict: true });
  const { deps, row, delegated } = makeDeps({
    coord,
    exec,
    mergeAutofix: true,
  });
  recordResult(deps.store, row, resultSha);

  const res = await runMerge({ ...PARAMS, noAutofix: true }, deps);
  assert.ok("mergeStatus" in res && res.mergeStatus === "conflict");
  assert.equal(delegated.length, 0);
});

test("conflict + autofix dispatch failure: conflict stays, error recorded", async () => {
  const { coord, exec, resultSha } = makeRepos({ conflict: true });
  const { deps, store, row, sent } = makeDeps({
    coord,
    exec,
    mergeAutofix: true,
    delegateFail: new OrchestratorError("route-unavailable", "no route"),
  });
  recordResult(store, row, resultSha);

  const res = await runMerge(PARAMS, deps);
  assert.ok("mergeStatus" in res && res.mergeStatus === "conflict");
  assert.match(res.warning ?? "", /autofix delegate failed/);
  assert.equal(store.get(row.id)!.merge_status, "conflict");
  assert.ok(store.findSetupError(store.get(row.id)!, "merge-autofix"));
  assert.match(sent[0]!, /не раздался/);
});

// ── §14 --dry-run ─────────────────────────────────────────────────────

test("--dry-run: predicts the conflict, copy untouched", async () => {
  const { coord, exec, resultSha } = makeRepos({ conflict: true });
  const tip = gitR(coord, ["rev-parse", "HEAD"]);
  const { deps, store, row, delegated } = makeDeps({
    coord,
    exec,
    mergeAutofix: true,
  });
  recordResult(store, row, resultSha);

  const res = await runMerge({ ...PARAMS, dryRun: true }, deps);
  assert.ok("dryRun" in res && res.dryRun === true);
  assert.equal(res.wouldConflict, true);
  assert.ok(res.conflictFiles.includes("f.txt"));
  assert.equal(gitR(coord, ["rev-parse", "HEAD"]), tip);
  assert.equal(gitR(coord, ["status", "--porcelain"]), "");
  assert.equal(gitR(coord, ["symbolic-ref", "--short", "HEAD"]), "work");
  assert.equal(store.get(row.id)!.merge_status, null);
  assert.equal(delegated.length, 0);
});

test("--dry-run on a clean merge: no conflict", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, store, row } = makeDeps({ coord, exec });
  recordResult(store, row, resultSha);
  const res = await runMerge({ ...PARAMS, dryRun: true }, deps);
  assert.ok("dryRun" in res && res.wouldConflict === false);
  assert.equal(store.get(row.id)!.merge_status, null);
});

// ── §14 refusals ──────────────────────────────────────────────────────

test("refusal: dirty-result when the executor left uncommitted work", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, row } = makeDeps({ coord, exec });
  recordResult(deps.store, row, resultSha, true);
  await assert.rejects(
    runMerge(PARAMS, deps),
    (e: unknown) => (e as OrchestratorError).code === "dirty-result",
  );
});

test("refusal: protected-branch for --into main and on a protected branch", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, row } = makeDeps({ coord, exec });
  recordResult(deps.store, row, resultSha);
  await assert.rejects(
    runMerge({ ...PARAMS, into: "main" }, deps),
    (e: unknown) => (e as OrchestratorError).code === "protected-branch",
  );
  // sitting on a protected branch is refused the same way
  gitR(coord, ["checkout", "main"]);
  await assert.rejects(
    runMerge(PARAMS, deps),
    (e: unknown) => (e as OrchestratorError).code === "protected-branch",
  );
});

test("refusal: dirty coordinator copy", async () => {
  const { coord, exec, resultSha } = makeRepos();
  writeFileSync(join(coord, "dirty.txt"), "x\n");
  const { deps, row } = makeDeps({ coord, exec });
  recordResult(deps.store, row, resultSha);
  await assert.rejects(
    runMerge(PARAMS, deps),
    (e: unknown) => (e as OrchestratorError).code === "dirty-coordinator",
  );
});

test("refusal: detached HEAD", async () => {
  const { coord, exec, resultSha } = makeRepos();
  gitR(coord, ["checkout", "--detach", "HEAD"]);
  const { deps, row } = makeDeps({ coord, exec });
  recordResult(deps.store, row, resultSha);
  await assert.rejects(
    runMerge(PARAMS, deps),
    (e: unknown) => (e as OrchestratorError).code === "detached-head",
  );
});

test("refusal: a foreign thread is not this delegation's coordinator", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, row } = makeDeps({ coord, exec });
  recordResult(deps.store, row, resultSha);
  await assert.rejects(
    runMerge({ ...PARAMS, callerThreadId: "thr_other" }, deps),
    (e: unknown) => (e as OrchestratorError).code === "not-a-coordinator",
  );
});

test("refusal: not-done / no-result / not-found", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, store, row } = makeDeps({ coord, exec });
  // not done yet — a delegation id reaches the row, a task key finds no
  // done-with-result delegation and is not-found (§14 «<KEY> — последнее
  // done-делегирование задачи с result_sha»).
  store.setStatus(row.id, "running");
  await assert.rejects(
    runMerge({ ...PARAMS, ref: String(row.id) }, deps),
    (e: unknown) => (e as OrchestratorError).code === "not-done",
  );
  await assert.rejects(
    runMerge(PARAMS, deps),
    (e: unknown) => (e as OrchestratorError).code === "not-found",
  );
  // done but no result recorded
  store.setStatus(row.id, "done");
  await assert.rejects(
    runMerge({ ...PARAMS, ref: String(row.id) }, deps),
    (e: unknown) => (e as OrchestratorError).code === "no-result",
  );
  recordResult(store, row, resultSha);
  await assert.rejects(
    runMerge({ ...PARAMS, ref: "PLUG-99" }, deps),
    (e: unknown) => (e as OrchestratorError).code === "not-found",
  );
  await assert.rejects(
    runMerge({ ...PARAMS, ref: "999" }, deps),
    (e: unknown) => (e as OrchestratorError).code === "not-found",
  );
});

test("refusal: unknown --into branch", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, row } = makeDeps({ coord, exec });
  recordResult(deps.store, row, resultSha);
  await assert.rejects(
    runMerge({ ...PARAMS, into: "no-such" }, deps),
    (e: unknown) => (e as OrchestratorError).code === "unknown-branch",
  );
});

// ── §16.2 stale-result / result presence ──────────────────────────────

test("§16.2: executor HEAD moved past result_sha — stale-result", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, row } = makeDeps({ coord, exec });
  recordResult(deps.store, row, resultSha);
  // the executor thread revived and committed again
  writeFileSync(join(exec, "more.txt"), "x\n");
  gitR(exec, ["add", "."]);
  gitR(exec, ["commit", "-m", "more"]);
  await assert.rejects(
    runMerge(PARAMS, deps),
    (e: unknown) => (e as OrchestratorError).code === "stale-result",
  );
});

test("result absent from the coordinator repo — result-missing", async () => {
  const { coord } = makeRepos();
  const { deps, row } = makeDeps({ coord, exec: null });
  recordResult(deps.store, row, "f".repeat(40));
  await assert.rejects(
    runMerge(PARAMS, deps),
    (e: unknown) => (e as OrchestratorError).code === "result-missing",
  );
});

// ── §14 check 4: one merge per copy ───────────────────────────────────

test("the copy lock refuses a second merge while one runs", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, row } = makeDeps({ coord, exec });
  recordResult(deps.store, row, resultSha);

  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  const realGit = deps.git;
  deps.git = async (repo, args) => {
    if (first && args[0] === "status") {
      first = false;
      await gate;
    }
    return realGit(repo, args);
  };

  const slow = runMerge(PARAMS, deps);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await assert.rejects(
    runMerge(PARAMS, deps),
    (e: unknown) => (e as OrchestratorError).code === "merge-in-progress",
  );
  release();
  const res = await slow;
  assert.ok("mergeStatus" in res && res.mergeStatus === "merged");
});

// ── delegation-id ref resolves the row directly ───────────────────────

test("merge by delegation id resolves the same row", async () => {
  const { coord, exec, resultSha } = makeRepos();
  const { deps, store, row } = makeDeps({ coord, exec });
  recordResult(store, row, resultSha);
  const res = await runMerge(
    { ...PARAMS, ref: String(row.id) },
    deps,
  );
  assert.ok("mergeStatus" in res && res.mergeStatus === "merged");
  assert.equal(res.delegationId, row.id);
});

