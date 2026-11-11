import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import Database from "better-sqlite3";
import { DelegationStore, JanitorStore, MIGRATIONS } from "../src/store.js";
import { parseJanitorConfig } from "../src/janitor-config.js";
import {
  createJanitor,
  defaultHasProcessIn,
  type JanitorDeps,
} from "../src/janitor.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { CmdRunner } from "../src/cmd.js";

const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): BbCliResult => ({
  exitCode: 1,
  stdout: "",
  stderr,
});

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

/** Real runner: executes git/du against the temp repos. */
const realCmd: CmdRunner = {
  run: async (file, args, o) => {
    try {
      const out = execFileSync(file, args, {
        cwd: o?.cwd,
        env: o?.env ? { ...process.env, ...o.env } : undefined,
        encoding: "utf8",
      });
      return { exitCode: 0, stdout: out, stderr: "" };
    } catch (e: unknown) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return {
        exitCode: x.status ?? 1,
        stdout: x.stdout ?? "",
        stderr: x.stderr ?? "",
      };
    }
  },
};

interface EnvSpec {
  id: string;
  path: string;
  branchName: string;
  projectId: string;
  mergeBaseBranch: string;
  createdAt?: number;
}

interface ThreadSpec {
  id: string;
  status: string;
  archivedAt: number | null;
  updatedAt: number;
  environmentId?: string | null;
  parentThreadId?: string | null;
  sourceThreadId?: string | null;
  originPluginId?: string | null;
  visibility?: string | null;
}

const CFG = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    enabled: true,
    mode: "apply",
    afterMerge: "15m",
    abandonedAfter: "1d",
    intervalMinutes: 15,
    protectedBranches: ["main"],
    ...over,
  });

/** A repo: bare origin + one checkout on `main`, envs are its worktrees. */
function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), "jan-"));
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, ["config", "user.name", "Agent"]);
  git(repo, ["config", "user.email", "agent@x.io"]);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "chore: base"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { base, origin, repo };
}

function addEnv(
  repo: string,
  base: string,
  name: string,
  over: Partial<EnvSpec> = {},
): EnvSpec {
  const path = join(base, "envs", name);
  mkdirSync(join(base, "envs"), { recursive: true });
  git(repo, ["worktree", "add", path, "-b", `bb/${name}`]);
  return {
    id: `env_${name}`,
    path,
    branchName: `bb/${name}`,
    projectId: "proj_1",
    mergeBaseBranch: "origin/main",
    ...over,
  };
}

function commitIn(path: string, file: string, msg: string) {
  writeFileSync(join(path, file), `${msg}\n`);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", msg]);
}

/** A branch whose tip is a commit origin has never seen (unmerged). */
function unmergedBranch(repo: string, name: string) {
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const sha = git(repo, [
    "commit-tree",
    tree,
    "-p",
    "HEAD",
    "-m",
    `wip: ${name}`,
  ]);
  git(repo, ["branch", name, sha]);
}

/** env work lands on origin/main: push the branch, merge it, push main. */
function mergeEnv(repo: string, env: EnvSpec) {
  git(env.path, ["push", "-u", "origin", env.branchName]);
  git(repo, ["merge", "--no-ff", "--no-edit", env.branchName]);
  git(repo, ["push", "origin", "main"]);
}

function envJson(e: EnvSpec, updatedAt: number) {
  return {
    id: e.id,
    projectId: e.projectId,
    path: e.path,
    branchName: e.branchName,
    mergeBaseBranch: e.mergeBaseBranch,
    createdAt: e.createdAt ?? updatedAt,
    managed: true,
    environmentProviderId: "git-worktree",
    status: "ready",
    updatedAt,
  };
}

function makeWorld(opts: {
  envs: EnvSpec[];
  threads?: Record<string, ThreadSpec[]>;
  extraThreads?: ThreadSpec[];
  interactions?: Record<string, unknown[]>;
  cleanupFailFor?: Set<string>;
  archiveFailFor?: Set<string>;
  clock?: { t: number };
  config?: string;
  hasProcessIn?: (path: string) => Promise<boolean>;
  cmd?: CmdRunner;
}) {
  const clock = opts.clock ?? { t: Date.now() };
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const janitor = new JanitorStore(db);
  const threads = opts.threads ?? {};
  const interactions = opts.interactions ?? {};
  const archivedCalls: string[] = [];
  const unarchivedCalls: string[] = [];
  const cleanedUp: string[] = [];
  const sent: { threadId: string; text: string }[] = [];

  const bbCli: BbCli = {
    run: async (args) => {
      const key = args.join(" ");
      if (key.startsWith("environment list")) {
        return ok(
          JSON.stringify(opts.envs.map((e) => envJson(e, clock.t))),
        );
      }
      if (key.startsWith("thread list")) {
        if (args.includes("--environment")) {
          const envId = args[args.indexOf("--environment") + 1]!;
          return ok(JSON.stringify(threads[envId] ?? []));
        }
        // global list (§16.3) — env-attached + cross-env extras
        const all = Object.entries(threads).flatMap(([envId, list]) =>
          list.map((t) => ({ environmentId: envId, ...t })),
        );
        return ok(
          JSON.stringify([...all, ...(opts.extraThreads ?? [])]),
        );
      }
      if (key.startsWith("environment show")) {
        const envId = args[args.indexOf("show") + 1]!;
        const env = opts.envs.find((e) => e.id === envId);
        return env
          ? ok(JSON.stringify(envJson(env, clock.t)))
          : fail("no such environment");
      }
      if (key.startsWith("thread interactions")) {
        const tid = args[args.indexOf("list") + 1]!;
        return ok(JSON.stringify(interactions[tid] ?? []));
      }
      if (key.startsWith("thread archive")) {
        const tid = args[2]!;
        if (opts.archiveFailFor?.has(tid)) return fail("cannot archive");
        archivedCalls.push(tid);
        return ok();
      }
      if (key.startsWith("thread unarchive")) {
        const tid = args[2]!;
        unarchivedCalls.push(tid);
        return ok();
      }
      if (key.startsWith("environment cleanup")) {
        const envId = args[2]!;
        if (opts.cleanupFailFor?.has(envId)) return fail("refused");
        cleanedUp.push(envId);
        const env = opts.envs.find((e) => e.id === envId);
        if (env) rmSync(env.path, { recursive: true, force: true });
        return ok();
      }
      return ok();
    },
  };

  const deps: JanitorDeps = {
    store,
    janitor,
    bbCli,
    cmd: opts.cmd ?? realCmd,
    threads: {
      send: async (a) => {
        sent.push({
          threadId: a.threadId,
          text: (a.input[0] as { text: string }).text,
        });
        return {};
      },
    },
    loadConfig: () => parseJanitorConfig(opts.config ?? CFG()),
    now: () => clock.t,
    log: {},
    hasProcessIn: opts.hasProcessIn ?? (async () => false),
  };
  return {
    deps,
    store,
    janitor,
    clock,
    // live references — tests can add envs/threads between runs
    envSpecs: opts.envs,
    threadSpecs: threads,
    archivedCalls,
    unarchivedCalls,
    cleanedUp,
    sent,
    jan: createJanitor(deps),
  };
}

// a worker thread (§16.3 scope): has a parent, like a dispatch child
const idle = (clock: { t: number }, envId: string): ThreadSpec => ({
  id: `thr_${envId}`,
  status: "idle",
  archivedAt: null,
  updatedAt: clock.t - 60_000,
  parentThreadId: "thr_coord",
});

// ── config ───────────────────────────────────────────────────────────

test("janitor config: empty/disabled default, validation errors", () => {
  assert.equal(parseJanitorConfig("").config, null);
  assert.equal(parseJanitorConfig('{"enabled": false}').config, null);
  const c = parseJanitorConfig(CFG()).config!;
  assert.equal(c.enabled, true);
  assert.equal(c.mode, "apply");
  assert.equal(c.afterMergeMs, 15 * 60_000);
  assert.equal(c.abandonedAfterMs, 24 * 60 * 60_000);
  assert.deepEqual(c.protectedBranches, ["main"]);
  const bad = parseJanitorConfig(
    JSON.stringify({ enabled: true, afterMerge: "1m", intervalMinutes: 5 }),
  );
  assert.ok(bad.config === null);
  assert.ok(bad.errors.some((e) => e.path === "afterMerge"));
  assert.ok(bad.errors.some((e) => e.path === "intervalMinutes"));
  assert.equal(parseJanitorConfig("{oops").config, null);
  assert.ok(parseJanitorConfig("{oops").errors.length > 0);
  // §15: mode missing or invalid → report, never an error
  assert.equal(
    parseJanitorConfig(JSON.stringify({ enabled: true })).config!.mode,
    "report",
  );
  assert.equal(
    parseJanitorConfig(JSON.stringify({ enabled: true, mode: "x" })).config!
      .mode,
    "report",
  );
  // unknown keys are a validation error — the janitor stays off
  const unknown = parseJanitorConfig(
    JSON.stringify({ enabled: true, mode: "apply", bogus: 1 }),
  );
  assert.equal(unknown.config, null);
  assert.ok(unknown.errors.some((e) => e.path === "bogus"));
  const typo = parseJanitorConfig(JSON.stringify({ enable: true }));
  assert.ok(typo.errors.some((e) => e.path === "enable"));
});

// ── runs against temp repos ──────────────────────────────────────────

test("merged clean copy older than afterMerge is removed with branch and thread", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  // first pass: marks the copy merged (afterMerge clock starts)
  let res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "merged-wait");
  // second pass after afterMerge — §16.3: archive-only. BB frees the
  // copy itself ~5 min later; the branch goes on a *later* run.
  w.clock.t += 16 * 60_000;
  res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
  assert.equal(res.archivedThreads, 1);
  assert.equal(res.removedBranches, 0);
  assert.deepEqual(w.cleanedUp, []); // environment cleanup is never called
  assert.deepEqual(w.archivedCalls, [`thr_${env.id}`]);
  assert.ok(existsSync(env.path));
  assert.equal(w.janitor.item(env.id)!.state, "removed");
  // BB removes the worktree; the next run's sweep deletes the branch
  git(repo, ["worktree", "remove", "--force", env.path]);
  res = await w.jan.run();
  assert.equal(res.removedBranches, 1);
  assert.throws(() => git(repo, ["rev-parse", "--verify", env.branchName]));
  const run = w.janitor.latestRun()!;
  assert.equal(run.removed, 1);
  assert.ok(run.finished_at !== null);
});

test("merged copy younger than afterMerge stays", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 5 * 60_000; // < 15m
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(w.janitor.item(env.id)!.reason, "merged-wait");
});

test("merged only locally (not on origin) stays", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  // merged into local main but never pushed; mergeBaseBranch names the
  // bare local branch — §15 counts only origin/* refs
  env.mergeBaseBranch = "main";
  git(repo, ["merge", "--no-ff", "--no-edit", env.branchName]);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  const item = w.janitor.item(env.id)!;
  assert.equal(item.reason, "not-merged");
  assert.equal(item.first_seen_at, null);
});

test("a bare SHA mergeBaseBranch is ignored — no origin branch, no merge", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  // the work IS on origin/main, but the only plausible target is the
  // env's mergeBaseBranch — a raw sha, which resolves to nothing under
  // refs/remotes/origin/ (protectedBranches point at a missing branch)
  env.mergeBaseBranch = git(repo, ["rev-parse", "origin/main"]);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    config: CFG({ protectedBranches: ["nominal"] }),
  });
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "not-merged");
});

test("a foreign unmerged bb/ branch does not block the copy", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  // a side branch nobody merged — checked out nowhere, not on origin;
  // local branches are repo-shared, so it is not the copy's business
  unmergedBranch(repo, "bb/loose");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
  // BB frees the copy later; the janitor only archived the thread
  assert.deepEqual(w.archivedCalls, [`thr_${env.id}`]);
  assert.equal(w.janitor.item(env.id)!.state, "removed");
  // the unmerged branch itself survives — only merged bb/ are swept
  git(repo, ["rev-parse", "--verify", "bb/loose"]);
});

test("the copy's own unmerged branch keeps the copy", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  // the executor switched the copy to another merged branch, while
  // env.branchName (bb/a) was moved onto a commit origin never saw —
  // the copy must stay so that work is not lost
  git(env.path, ["checkout", "-b", "bb/other"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const sha = git(repo, [
    "commit-tree",
    tree,
    "-p",
    "HEAD",
    "-m",
    "wip: moved bb/a",
  ]);
  git(repo, ["branch", "-f", env.branchName, sha]);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(w.janitor.item(env.id)!.reason, "not-merged");
});

test("dirty / untracked / unfinished-merge copies stay", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  // dirty tracked file
  writeFileSync(join(env.path, "f.txt"), "dirty\n");
  let res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "dirty");
  // untracked file counts as dirty too
  git(env.path, ["checkout", "--", "f.txt"]);
  writeFileSync(join(env.path, "untracked.txt"), "x\n");
  res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "dirty");
  // an in-progress merge blocks removal even when the tree is clean —
  // MERGE_HEAD lives in the worktree's own git dir
  rmSync(join(env.path, "untracked.txt"));
  const gd0 = git(env.path, ["rev-parse", "--git-dir"]);
  const gd = gd0.startsWith("/") ? gd0 : join(env.path, gd0);
  writeFileSync(join(gd, "MERGE_HEAD"), `${"0".repeat(40)}\n`);
  res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "unfinished-op");
});

test("status.showUntrackedFiles=no cannot hide an untracked file", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  // repo-level config hides untracked files from a bare `git status
  // --porcelain` — the janitor's flags must override it
  git(repo, ["config", "status.showUntrackedFiles", "no"]);
  writeFileSync(join(env.path, "notes.txt"), "x\n");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(w.janitor.item(env.id)!.reason, "dirty");
});

test("a failed git status keeps the copy (cleanliness unproven)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const statusFails: CmdRunner = {
    run: async (file, args, o) =>
      file === "git" && args[2] === "status"
        ? fail("status boom")
        : realCmd.run(file, args, o),
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    cmd: statusFails,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(w.janitor.item(env.id)!.reason, "status-failed");
});

test("copy without own commits younger than abandonedAfter stays", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a"); // branch at origin/main tip, no commits
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(w.janitor.item(env.id)!.reason, "no-commits-fresh");
});

test("origin moved ahead but the copy has no commits — fresh thread keeps it", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a"); // bb/a at the old origin/main tip
  // origin/main moved forward — the copy is still merged (an ancestor)
  // yet has zero own commits
  commitIn(repo, "g.txt", "feat: ahead");
  git(repo, ["push", "origin", "main"]);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(w.janitor.item(env.id)!.reason, "no-commits-fresh");
});

test("same setup with an abandoned thread is removed", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(repo, "g.txt", "feat: ahead");
  git(repo, ["push", "origin", "main"]);
  const clock = { t: Date.now() };
  const w = makeWorld({
    envs: [env],
    threads: {
      [env.id]: [
        {
          id: "thr_a",
          status: "idle",
          archivedAt: null,
          updatedAt: clock.t - 2 * 24 * 60 * 60_000,
          parentThreadId: "thr_coord",
        },
      ],
    },
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
  assert.equal(w.janitor.item(env.id)!.state, "removed");
});

test("no reflog → no own commits, even when the branch gained commits after createdAt (§16.3)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  // no reflog data at all → §16.3 assumes zero own commits; env.createdAt
  // is NOT consulted (coordinator override of the §15 fallback)
  git(repo, ["reflog", "expire", "--expire=now", env.branchName]);
  const now = Date.now();
  const w = makeWorld({
    envs: [{ ...env, createdAt: now - 3_600_000 }],
    threads: { [env.id]: [idle({ t: now }, env.id)] },
    clock: { t: now },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "no-commits-fresh");
});

test("active thread or pending interaction keeps the copy", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const clock = { t: Date.now() };
  const t1: ThreadSpec = {
    id: "thr_a",
    status: "active",
    archivedAt: null,
    updatedAt: clock.t,
    parentThreadId: "thr_coord",
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [t1] },
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  let res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "threads-active");
  // idle thread with a pending request — also kept
  t1.status = "idle";
  const w2 = makeWorld({
    envs: [env],
    threads: { [env.id]: [t1] },
    interactions: { thr_a: [{ id: "int_1", status: "pending" }] },
    clock,
  });
  await w2.jan.run();
  w2.clock.t += 16 * 60_000;
  res = await w2.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w2.janitor.item(env.id)!.reason, "interactions-pending");
  // a resolved interaction is history, not a pending request — if the
  // list ever returns it, it must not block the copy
  const w3 = makeWorld({
    envs: [env],
    threads: { [env.id]: [t1] },
    interactions: {
      thr_a: [
        { id: "int_1", status: "resolved" },
        { id: "int_2", status: "interrupted" },
      ],
    },
    clock,
  });
  await w3.jan.run();
  w3.clock.t += 16 * 60_000;
  res = await w3.jan.run();
  assert.equal(res.removedCopies, 1);
});

test("a delegation in dispatching/running keeps the env", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const d = w.store.insert({
    taskKey: "PLUG-9",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  w.store.setThreadInfo(d.id, `thr_${env.id}`);
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "delegation-active");
});

test("defaultHasProcessIn matches a live process through a symlinked path", async (t) => {
  if (!existsSync("/proc")) return t.skip("/proc not available");
  const dir = mkdtempSync(join(tmpdir(), "jan-proc-"));
  const real = join(dir, "real");
  mkdirSync(real);
  const link = join(dir, "link");
  symlinkSync(real, link);
  // the kernel resolves the cwd symlink — /proc/<pid>/cwd shows `real`;
  // env.path handed to the janitor may be the `link` spelling
  const child = spawn("sleep", ["30"], { cwd: link, stdio: "ignore" });
  try {
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      found = defaultHasProcessIn(link) && defaultHasProcessIn(real);
      if (!found) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(found, "process with cwd inside the copy not detected");
    mkdirSync(join(dir, "empty"));
    assert.equal(defaultHasProcessIn(join(dir, "empty")), false);
  } finally {
    child.kill("SIGKILL");
  }
});

test("a failed fetch skips the whole repository", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  // break origin: fetch --prune fails now
  git(repo, ["remote", "set-url", "origin", join(base, "gone.git")]);
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(res.kept["fetch-failed"], 1);
  assert.ok(existsSync(env.path));
  // the merge streak pauses: the run never saw the copy merged
  assert.equal(w.janitor.item(env.id)!.reason, "merged-wait");
  assert.equal(w.janitor.item(env.id)!.first_seen_at, null);
  // fetch works again → a fresh merged-wait streak restarts
  git(repo, ["remote", "set-url", "origin", join(base, "origin.git")]);
  const res2 = await w.jan.run();
  assert.equal(res2.kept["merged-wait"], 1);
  assert.equal(w.janitor.item(env.id)!.first_seen_at, w.clock.t);
});

test("a failed thread archive rolls the cascade back", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const clock = { t: Date.now() };
  // one cascade: root thr_a1, child thr_a2 — children archive first;
  // the root's failure restores the child (§15/§16.3)
  const root: ThreadSpec = {
    id: "thr_a1",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: "thr_coord",
  };
  const child: ThreadSpec = { ...root, id: "thr_a2", parentThreadId: "thr_a1" };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [root, child] },
    archiveFailFor: new Set(["thr_a1"]),
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, ["thr_a2"]); // thr_a1 refused — not recorded
  assert.deepEqual(w.unarchivedCalls, ["thr_a2"]);
  assert.deepEqual(w.cleanedUp, []);
  assert.ok(existsSync(env.path));
  assert.equal(w.janitor.item(env.id)!.reason, "archive-failed");
});

test("removal is archive-only — `bb environment cleanup` is never called (§16.3)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    cleanupFailFor: new Set([env.id]), // would fail if ever invoked
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
  assert.deepEqual(w.archivedCalls, [`thr_${env.id}`]);
  assert.deepEqual(w.unarchivedCalls, []);
  assert.deepEqual(w.cleanedUp, []);
  // BB has not freed the copy yet — the janitor never deletes it
  assert.ok(existsSync(env.path));
  assert.equal(w.janitor.item(env.id)!.state, "removed");
});

test("report mode deletes nothing and writes only the run row", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    config: CFG({ mode: "report" }),
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.applied, false);
  assert.equal(res.removedCopies, 0);
  // the merged-sighting streak matures in memory: the second report
  // pass sees the copy eligible — yet nothing reached the db
  assert.equal(res.ready, 1);
  assert.ok(existsSync(env.path));
  git(repo, ["rev-parse", "--verify", env.branchName]);
  assert.equal(w.janitor.item(env.id), undefined);
  assert.ok(w.janitor.latestRun());
});

test("a --dry-run pass under apply mode writes only the run row", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  let res = await w.jan.run({ dryRun: true });
  assert.equal(res.ready, 0);
  w.clock.t += 16 * 60_000;
  res = await w.jan.run({ dryRun: true });
  assert.equal(res.ready, 1);
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  // the dry-run preview must not pre-arm the afterMerge clock: no
  // first_seen_at, no item row at all
  assert.equal(w.janitor.item(env.id), undefined);
  assert.ok(w.janitor.latestRun());
});

test("protected and non-bb/ branches are never deleted", async () => {
  const { repo, base } = makeRepo();
  // a merged bb/ branch without a copy → deleted by the sweep
  git(repo, ["branch", "bb/done-old"]);
  git(repo, ["branch", "-f", "bb/done-old", "main"]);
  // a merged non-bb/ branch → stays
  git(repo, ["branch", "people/keep"]);
  // an unmerged bb/ branch → stays (foreign to the copy, so the copy
  // is still cleaned up)
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  unmergedBranch(repo, "bb/wip");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
  git(repo, ["rev-parse", "--verify", "people/keep"]);
  git(repo, ["rev-parse", "--verify", "bb/wip"]);
  assert.throws(() => git(repo, ["rev-parse", "--verify", "bb/done-old"]));
});

test("unmerged copy idle over abandonedAfter is reported, coordinator notified once a day", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work"); // never pushed/merged
  const clock = { t: Date.now() };
  const staleThread: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 2 * 24 * 60 * 60_000,
    parentThreadId: "thr_coord",
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [staleThread] },
    clock,
  });
  const d = w.store.insert({
    taskKey: "PLUG-7",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  w.store.setThreadInfo(d.id, "thr_a");
  w.store.setStatus(d.id, "done");
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(res.reported.length, 1);
  assert.equal(res.reported[0]!.reason, "abandoned-unmerged");
  assert.equal(res.reported[0]!.isNew, true);
  assert.equal(w.janitor.item(env.id)!.state, "reported");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]!.threadId, "thr_coord");
  assert.match(w.sent[0]!.text, /\[orchestrator\] уборщик: новых брошенных 1/);
  // §16.3: an env already reported is not re-announced — not same-day,
  // not next day either
  w.clock.t += 60_000;
  const res2 = await w.jan.run();
  assert.equal(res2.reported.length, 1);
  assert.equal(res2.reported[0]!.isNew, false);
  assert.equal(w.sent.length, 1);
  w.clock.t += 24 * 60 * 60_000;
  await w.jan.run();
  assert.equal(w.sent.length, 1);
  // a *new* abandoned env is announced — and only it
  const env2 = addEnv(repo, base, "b");
  commitIn(env2.path, "z.txt", "feat: other work");
  w.envSpecs.push(env2);
  w.threadSpecs[env2.id] = [
    { ...staleThread, id: "thr_b" },
  ];
  const d2 = w.store.insert({
    taskKey: "PLUG-7b",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  w.store.setThreadInfo(d2.id, "thr_b");
  w.store.setStatus(d2.id, "done");
  await w.jan.run();
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1]!.text, /новых брошенных 1/);
  assert.match(w.sent[1]!.text, /bb\/b/);
  assert.ok(!w.sent[1]!.text.includes("bb/a"), "old env not re-announced");
  // the report exposes the abandoned list
  const rep = await w.jan.report();
  assert.equal(rep.abandoned.length, 2);
});

test("report mode still notifies once a day — watermark in memory, not db", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work"); // never pushed/merged
  const clock = { t: Date.now() };
  const staleThread: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 2 * 24 * 60 * 60_000,
    parentThreadId: "thr_coord",
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [staleThread] },
    clock,
    config: CFG({ mode: "report" }),
  });
  const d = w.store.insert({
    taskKey: "PLUG-8",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  w.store.setThreadInfo(d.id, "thr_a");
  w.store.setStatus(d.id, "done");
  let res = await w.jan.run();
  assert.equal(res.reported.length, 1);
  assert.equal(w.sent.length, 1);
  // report mode writes nothing to the db: no item row, no notify meta
  assert.equal(w.janitor.item(env.id), undefined);
  assert.equal(w.janitor.meta("dailyNotify:thr_coord"), undefined);
  // same-day dedup and §16.3 new-only dedup both hold — in memory
  w.clock.t += 60_000;
  res = await w.jan.run();
  assert.equal(res.reported.length, 1);
  assert.equal(res.reported[0]!.isNew, false);
  assert.equal(w.sent.length, 1);
  w.clock.t += 24 * 60 * 60_000;
  await w.jan.run();
  assert.equal(w.sent.length, 1); // already reported — not re-announced
});

test("disabled janitor is a no-op; env in excludeProjects is ignored", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  const w = makeWorld({ envs: [env], config: '{"enabled": false}' });
  const res = await w.jan.run();
  assert.equal(res.skipped, "disabled");
  assert.equal(w.janitor.item(env.id), undefined);
  const w2 = makeWorld({
    envs: [env],
    config: CFG({ excludeProjects: ["proj_1"] }),
  });
  const res2 = await w2.jan.run();
  assert.equal(w2.janitor.item(env.id), undefined);
  assert.equal(res2.removedCopies, 0);
});

test("env whose threads are all archived with unmerged branch is reported", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  const clock = { t: Date.now() };
  const w = makeWorld({
    envs: [env],
    threads: {
      [env.id]: [
        {
          id: "thr_a",
          status: "idle",
          archivedAt: clock.t - 3 * 24 * 60 * 60_000,
          updatedAt: clock.t - 3 * 24 * 60 * 60_000,
        },
      ],
    },
    clock,
  });
  const res = await w.jan.run();
  assert.equal(res.reported[0]!.reason, "abandoned-archived");
  assert.equal(w.janitor.item(env.id)!.state, "reported");
});

// ── §16.3 scope & cascade ────────────────────────────────────────────

test("scope workers skips root chats; scope all removes them", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const clock = { t: Date.now() };
  // a root chat: no parent, no dispatch origin — not a worker (§16.3)
  const rootChat: ThreadSpec = {
    id: "thr_chat",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: null,
    originPluginId: null,
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [rootChat] },
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  let res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.equal(w.janitor.item(env.id)!.reason, "threads-remaining");

  const w2 = makeWorld({
    envs: [env],
    threads: { [env.id]: [rootChat] },
    clock,
    config: CFG({ scope: "all" }),
  });
  await w2.jan.run();
  w2.clock.t += 16 * 60_000;
  res = await w2.jan.run();
  assert.equal(res.removedCopies, 1);
  assert.deepEqual(w2.archivedCalls, ["thr_chat"]);
});

test("cascade: a dirty child env blocks archiving the whole tree", async () => {
  const { repo, base } = makeRepo();
  const envA = addEnv(repo, base, "a");
  const envB = addEnv(repo, base, "b");
  commitIn(envA.path, "wa.txt", "feat: a");
  commitIn(envB.path, "wb.txt", "feat: b");
  mergeEnv(repo, envA);
  mergeEnv(repo, envB);
  const clock = { t: Date.now() };
  const rootT: ThreadSpec = {
    id: "thr_p",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: "thr_coord",
  };
  const childT: ThreadSpec = { ...rootT, id: "thr_c", parentThreadId: "thr_p" };
  writeFileSync(join(envB.path, "dirty.txt"), "x\n"); // child env dirty
  const w = makeWorld({
    envs: [envA, envB],
    threads: { [envA.id]: [rootT], [envB.id]: [childT] },
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.equal(w.janitor.item(envB.id)!.reason, "dirty");
  assert.equal(w.janitor.item(envA.id)!.reason, "cascade:dirty");

  // clean the child env → the whole cascade archives on the next run
  rmSync(join(envB.path, "dirty.txt"));
  const res2 = await w.jan.run();
  assert.equal(res2.removedCopies, 2);
  assert.deepEqual(w.archivedCalls, ["thr_c", "thr_p"]);
  assert.equal(w.janitor.item(envA.id)!.state, "removed");
  assert.equal(w.janitor.item(envB.id)!.state, "removed");
});

test("cascade: a hidden fork (sourceThreadId) is part of the cascade", async () => {
  const { repo, base } = makeRepo();
  const envA = addEnv(repo, base, "a");
  const envB = addEnv(repo, base, "b");
  commitIn(envA.path, "wa.txt", "feat: a");
  commitIn(envB.path, "wb.txt", "feat: b");
  mergeEnv(repo, envA);
  mergeEnv(repo, envB);
  const clock = { t: Date.now() };
  const rootT: ThreadSpec = {
    id: "thr_p",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: "thr_coord",
  };
  // hidden fork of thr_p living in envB — linked via sourceThreadId
  const forkT: ThreadSpec = {
    id: "thr_fork",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    sourceThreadId: "thr_p",
    visibility: "hidden",
  };
  const w = makeWorld({
    envs: [envA, envB],
    threads: { [envA.id]: [rootT], [envB.id]: [forkT] },
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 2);
  assert.deepEqual(w.archivedCalls.sort(), ["thr_fork", "thr_p"].sort());
});

test("cascade: a child's pending interaction blocks the parent", async () => {
  const { repo, base } = makeRepo();
  const envA = addEnv(repo, base, "a");
  const envB = addEnv(repo, base, "b");
  commitIn(envA.path, "wa.txt", "feat: a");
  commitIn(envB.path, "wb.txt", "feat: b");
  mergeEnv(repo, envA);
  mergeEnv(repo, envB);
  const clock = { t: Date.now() };
  const rootT: ThreadSpec = {
    id: "thr_p",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: "thr_coord",
  };
  const childT: ThreadSpec = { ...rootT, id: "thr_c", parentThreadId: "thr_p" };
  const w = makeWorld({
    envs: [envA, envB],
    threads: { [envA.id]: [rootT], [envB.id]: [childT] },
    interactions: { thr_c: [{ id: "int_1", status: "pending" }] },
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.equal(
    w.janitor.item(envA.id)!.reason,
    "cascade:interactions-pending",
  );
});

test("squash-equivalent branch is «влита» via git cherry (§16.3)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  // squash-merge on main: same diff, a different sha — bb/a is not an
  // ancestor of origin/main, but `git cherry` shows only «-» lines
  writeFileSync(join(repo, "w.txt"), "feat: work\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: work (squashed)"]);
  git(repo, ["push", "origin", "main"]);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
  assert.equal(w.janitor.item(env.id)!.state, "removed");
});

test("orphan bb/ branch merged only via cherry is swept", async () => {
  const { repo, base } = makeRepo();
  // a squash-merged bb/ branch, checked out nowhere
  git(repo, ["checkout", "-b", "bb/squashed"]);
  writeFileSync(join(repo, "s.txt"), "feat: squash\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: squash"]);
  git(repo, ["checkout", "main"]);
  writeFileSync(join(repo, "s.txt"), "feat: squash\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: squash (applied)"]);
  git(repo, ["push", "origin", "main"]);
  const env = addEnv(repo, base, "a");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const res = await w.jan.run();
  assert.equal(res.orphanBranches, 1);
  assert.equal(res.removedBranches, 1);
  assert.throws(() => git(repo, ["rev-parse", "--verify", "bb/squashed"]));
});

test("rescue refs under refs/orchestrator/ are never touched", async () => {
  const { repo, base } = makeRepo();
  const keep = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/orchestrator/rescue/thr_keep", keep]);
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  await w.jan.run();
  assert.equal(
    git(repo, ["rev-parse", "refs/orchestrator/rescue/thr_keep"]),
    keep,
  );
});

test("env with no threads at all is kept, not removed", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({ envs: [env], threads: {} });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "no-threads");
});

// ── §16.4 rescue refs ────────────────────────────────────────────────

test("archived executor with a dirty copy gets a rescue ref + coordinator line", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  writeFileSync(join(env.path, "f.txt"), "dirty\n"); // modified tracked
  writeFileSync(join(env.path, "new.txt"), "untracked\n"); // untracked
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.onThreadArchived({
    id: "thr_w",
    environmentId: env.id,
    parentThreadId: "thr_coord",
  });
  const ref = "refs/orchestrator/rescue/thr_w";
  const sha = git(repo, ["rev-parse", "--verify", ref]);
  assert.match(sha, /^[0-9a-f]{40}$/);
  // the ref is a real stash object — `git stash apply` restores both
  // the tracked edit and the untracked file
  git(repo, ["stash", "apply", ref]);
  assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "dirty\n");
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "untracked\n");
  // coordinator got the restore command
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]!.threadId, "thr_coord");
  assert.match(w.sent[0]!.text, new RegExp(`stash apply ${ref}`));
});

test("rescue with only untracked files still restores them via stash apply", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  writeFileSync(join(env.path, "notes.txt"), "draft\n");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.onThreadArchived({
    id: "thr_u",
    environmentId: env.id,
    parentThreadId: "thr_coord",
  });
  const ref = "refs/orchestrator/rescue/thr_u";
  git(repo, ["rev-parse", "--verify", ref]);
  git(repo, ["stash", "apply", ref]);
  assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "draft\n");
});

test("rescue no-ops: clean copy, root chat, already-freed copy, no coordinator", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a"); // clean
  const dirty = addEnv(repo, base, "d");
  writeFileSync(join(dirty.path, "x.txt"), "x\n");
  const gone = addEnv(repo, base, "g");
  git(repo, ["worktree", "remove", "--force", gone.path]);
  const w = makeWorld({
    envs: [env, dirty, gone],
    threads: {},
  });
  const head = git(repo, ["rev-parse", "HEAD"]);
  await w.jan.onThreadArchived({
    id: "thr_clean",
    environmentId: env.id,
    parentThreadId: "thr_coord",
  });
  await w.jan.onThreadArchived({
    id: "thr_chat", // root chat — not an executor
    environmentId: dirty.id,
    parentThreadId: null,
    originPluginId: null,
  });
  await w.jan.onThreadArchived({
    id: "thr_gone", // BB already freed the copy — outside the window
    environmentId: gone.id,
    parentThreadId: "thr_coord",
  });
  await w.jan.onThreadArchived({
    id: "thr_orphan", // dirty but no coordinator anywhere
    environmentId: dirty.id,
  });
  assert.equal(
    git(repo, ["rev-parse", "HEAD"]),
    head,
    "no commits leaked into the repo",
  );
  assert.throws(() =>
    git(repo, ["rev-parse", "--verify", "refs/orchestrator/rescue/thr_clean"]),
  );
  assert.throws(() =>
    git(repo, ["rev-parse", "--verify", "refs/orchestrator/rescue/thr_chat"]),
  );
  assert.throws(() =>
    git(repo, ["rev-parse", "--verify", "refs/orchestrator/rescue/thr_gone"]),
  );
  // the orphan's work is still rescued; only the notification is skipped
  git(repo, ["rev-parse", "--verify", "refs/orchestrator/rescue/thr_orphan"]);
  assert.equal(w.sent.length, 0);
});
