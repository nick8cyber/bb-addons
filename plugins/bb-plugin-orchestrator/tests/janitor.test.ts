import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
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
  hostId?: string;
}

interface ThreadSpec {
  id: string;
  status: string;
  queuedWork?: string | null;
  hasPendingInteraction?: boolean;
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
  const file = `wip-${name.replace(/\//g, "-")}.txt`;
  writeFileSync(join(repo, file), "unpushed\n");
  git(repo, ["add", file]);
  const tree = git(repo, ["write-tree"]);
  const sha = git(repo, [
    "commit-tree",
    tree,
    "-p",
    "HEAD",
    "-m",
    `wip: ${name}`,
  ]);
  git(repo, ["branch", name, sha]);
  git(repo, ["reset", "-q", "HEAD"]);
  rmSync(join(repo, file));
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
    hostId: e.hostId ?? null,
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
  unarchiveFailFor?: Set<string>;
  clock?: { t: number };
  config?: string;
  hasProcessIn?: (path: string) => Promise<boolean | null>;
  localHostId?: string;
  cmd?: CmdRunner;
  /** Invoked on every `thread list` call (1-based) — lets a test change
   * thread or repo state between the run-start snapshot and the
   * pre-archive re-read (§15 «Действие», PLUG-188). */
  onThreadListCall?: (call: number) => void;
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
  const warns: string[] = [];

  let threadListCalls = 0;
  const bbCli: BbCli = {
    run: async (args) => {
      const key = args.join(" ");
      if (key.startsWith("environment list")) {
        return ok(
          JSON.stringify(opts.envs.map((e) => envJson(e, clock.t))),
        );
      }
      if (key.startsWith("thread list")) {
        threadListCalls += 1;
        opts.onThreadListCall?.(threadListCalls);
        if (args.includes("--environment")) {
          const envId = args[args.indexOf("--environment") + 1]!;
          return ok(JSON.stringify(threads[envId] ?? []));
        }
        // global list (§16.3) — env-attached + cross-env extras
        const all = Object.entries(threads).flatMap(([envId, list]) =>
          list.map((t) => ({
            environmentId: envId,
            queuedWork: "none",
            ...t,
          })),
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
        if (opts.unarchiveFailFor?.has(tid)) return fail("cannot unarchive");
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
    log: { warn: (m) => warns.push(m) },
    hasProcessIn: opts.hasProcessIn ?? (async () => false),
    localHostId: () => opts.localHostId ?? "",
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
    warns,
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
  // PLUG-185: a valid disabled document still yields a config — a
  // --dry-run preview must honor its excludeProjects/scope
  const off = parseJanitorConfig(
    '{"enabled": false, "excludeProjects": ["proj_x"], "scope": "all"}',
  ).config!;
  assert.equal(off.enabled, false);
  assert.deepEqual(off.excludeProjects, ["proj_x"]);
  assert.equal(off.scope, "all");
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
  // real content, so «влита» fails on every sign and the copy must
  // stay so that work is not lost
  git(env.path, ["checkout", "-b", "bb/other"]);
  unmergedBranch(repo, "scratch/wip");
  const sha = git(repo, ["rev-parse", "scratch/wip"]);
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
      found =
        defaultHasProcessIn(link) === true &&
        defaultHasProcessIn(real) === true;
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

test("report mode deletes nothing and writes no item rows", async () => {
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

test("a --dry-run pass under apply mode writes no item rows", async () => {
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
  // first_seen_at, no item row at all — but §15 (r25) has it write the
  // janitor_meta service marks (repoRoots and the notify bookkeeping)
  assert.equal(w.janitor.item(env.id), undefined);
  // §15: «--dry-run ничего не пишет» — no meta marks, no run row either
  assert.equal(w.janitor.meta("repoRoots"), undefined);
  assert.equal(w.janitor.latestRun(), undefined);
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

test("report mode still notifies once a day — watermark in janitor_meta (PLUG-185)", async () => {
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
  // report mode still writes no item row — but the notify watermark and
  // the announced set ARE service state: they go to janitor_meta so a
  // plugin restart cannot resend the same message early
  assert.equal(w.janitor.item(env.id), undefined);
  assert.equal(w.janitor.meta("dailyNotify:thr_coord"), String(w.clock.t));
  assert.match(
    w.janitor.meta("announcedAbandoned") ?? "",
    new RegExp(env.id),
  );
  // same-day dedup and §16.3 new-only dedup both hold
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

test("squash-equivalent branch is «влита» via patch-id (§16.3)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  // squash-merge on main: same diff, a different sha — bb/a is not an
  // ancestor of origin/main, but its single commit is patch-identical
  // to the squash commit (`git cherry` «-»)
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

test("orphan bb/ branch merged only by patch is swept", async () => {
  const { repo, base } = makeRepo();
  // a squash-merged bb/ branch, checked out nowhere — one commit, so
  // patch-id equivalence with the squash commit makes it «влита»
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
  // coordinator got the restore command — into a NEW worktree, never
  // the main checkout (PLUG-185): worktree add <dir> <ref>^1, then
  // stash apply inside it
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]!.threadId, "thr_coord");
  const m = /worktree add (\S+) \S+\^1 && git -C (\S+) stash apply \S+/.exec(
    w.sent[0]!.text,
  );
  assert.ok(m, `restore command missing: ${w.sent[0]!.text}`);
  const [, rescueDir] = m;
  assert.match(rescueDir, /rescue-thr_w$/);
  // the advertised command actually restores both kinds of work
  git(repo, ["worktree", "add", rescueDir!, `${ref}^1`]);
  git(rescueDir!, ["stash", "apply", ref]);
  assert.equal(readFileSync(join(rescueDir!, "f.txt"), "utf8"), "dirty\n");
  assert.equal(readFileSync(join(rescueDir!, "new.txt"), "utf8"), "untracked\n");
  git(repo, ["worktree", "remove", "--force", rescueDir!]);
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

// ── PLUG-185 review fixes ────────────────────────────────────────────

test("ff-only sync counts by the strict «Created from» formula — merged copy is removed (PLUG-195)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a"); // bb/a at the old origin tip
  // origin/main moves ahead; the copy fast-forwards — the standard
  // «fetch + ff-only base» first step. §16.3 (PLUG-195): own commits
  // are `rev-list --count <«Created from»>..<tip>` with no reflog-type
  // parsing — the commits arrived by the ff count too, so the copy no
  // longer waits for `abandonedAfter` (it is fully merged anyway).
  commitIn(repo, "g.txt", "feat: ahead");
  git(repo, ["push", "origin", "main"]);
  git(env.path, ["fetch", "origin"]);
  git(env.path, ["merge", "--ff-only", "origin/main"]);
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

test("a real commit in the copy counts as own work (PLUG-185 B1)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(repo, "g.txt", "feat: ahead");
  git(repo, ["push", "origin", "main"]);
  git(env.path, ["fetch", "origin"]);
  git(env.path, ["merge", "--ff-only", "origin/main"]);
  commitIn(env.path, "w.txt", "feat: work"); // reflog «commit: …»
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
});

test("starting/stopping/queued threads keep the copy (PLUG-185 B3)", async () => {
  for (const [status, queuedWork, reason] of [
    ["starting", "none", "threads-active"],
    ["stopping", "none", "threads-active"],
    ["pending", "none", "threads-active"],
    ["idle", "waiting", "queued-work"],
    ["error", "failed", "queued-work"],
  ] as const) {
    const { repo, base } = makeRepo();
    const env = addEnv(repo, base, "a");
    commitIn(env.path, "w.txt", "feat: work");
    mergeEnv(repo, env);
    const clock = { t: Date.now() };
    const w = makeWorld({
      envs: [env],
      threads: {
        [env.id]: [
          {
            id: "thr_a",
            status,
            queuedWork,
            archivedAt: null,
            updatedAt: clock.t - 60_000,
            parentThreadId: "thr_coord",
          },
        ],
      },
      clock,
    });
    await w.jan.run();
    w.clock.t += 16 * 60_000;
    const res = await w.jan.run();
    assert.equal(res.removedCopies, 0, `${status}/${queuedWork}`);
    assert.equal(
      w.janitor.item(env.id)!.reason,
      reason,
      `${status}/${queuedWork}`,
    );
    assert.deepEqual(w.archivedCalls, []);
  }
});

test("a blocking non-cascade thread of the same env blocks the cascade (PLUG-185 M4)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const clock = { t: Date.now() };
  const worker: ThreadSpec = {
    id: "thr_w",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: "thr_coord",
  };
  // a root chat in the same env — outside the workers-scope cascade,
  // but §15 cond 4 still counts it: active status blocks
  const chat: ThreadSpec = {
    id: "thr_chat",
    status: "active",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: null,
    originPluginId: null,
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [worker, chat] },
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  let res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "threads-active");
  // a queued message on the out-of-cascade thread also blocks
  chat.status = "idle";
  chat.queuedWork = "waiting";
  const w2 = makeWorld({
    envs: [env],
    threads: { [env.id]: [worker, chat] },
    clock,
  });
  await w2.jan.run();
  w2.clock.t += 16 * 60_000;
  res = await w2.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w2.janitor.item(env.id)!.reason, "queued-work");
  // and a pending request reported by the thread-list field (no CLI
  // fallback needed)
  chat.queuedWork = "none";
  chat.hasPendingInteraction = true;
  const w3 = makeWorld({
    envs: [env],
    threads: { [env.id]: [worker, chat] },
    clock,
  });
  await w3.jan.run();
  w3.clock.t += 16 * 60_000;
  res = await w3.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w3.janitor.item(env.id)!.reason, "interactions-pending");
});

test("no /proc → process-unknown keeps the copy (PLUG-185 M5)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    hasProcessIn: async () => null,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "process-unknown");
});

test("cherry-equivalent branch with merge-only content is NOT «влита» (PLUG-185 L8)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  // a side branch merged into bb/a with an extra resolution edit —
  // `git cherry` skips merge commits, so without the merge-tree guard
  // this content would be lost silently
  git(env.path, ["checkout", "-b", "bb/side"]);
  commitIn(env.path, "s.txt", "feat: side");
  git(env.path, ["checkout", env.branchName]);
  git(env.path, ["merge", "--no-ff", "--no-commit", "bb/side"]);
  writeFileSync(join(env.path, "m.txt"), "merge-only\n");
  git(env.path, ["add", "m.txt"]);
  git(env.path, ["commit", "-m", "merge: side + resolution edit"]);
  // origin/main gets patch-identical non-merge commits — every cherry
  // line is «-», yet merging bb/a still adds m.txt
  writeFileSync(join(repo, "w.txt"), "feat: work\n");
  writeFileSync(join(repo, "s.txt"), "feat: side\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: work + side (squashed)"]);
  git(repo, ["push", "origin", "main"]);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "not-merged");
  git(repo, ["rev-parse", "--verify", env.branchName]);
});

test("a failed git-dir probe keeps the copy — unfinished unknown (PLUG-185 L9)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const cmd: CmdRunner = {
    run: async (f, a, o) =>
      a.join(" ").includes("rev-parse --git-dir")
        ? fail("git-dir probe")
        : realCmd.run(f, a, o),
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    cmd,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "unfinished-unknown");
});

test("a failed worktree list skips the branch sweep (PLUG-185 L9)", async () => {
  const { repo, base } = makeRepo();
  git(repo, ["branch", "bb/gone"]); // merged orphan — would be swept
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const cmd: CmdRunner = {
    run: async (f, a, o) =>
      a.join(" ").includes("worktree list")
        ? fail("worktree list")
        : realCmd.run(f, a, o),
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    cmd,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1); // the copy still goes
  assert.equal(res.orphanBranches, 0);
  assert.equal(res.removedBranches, 0);
  git(repo, ["rev-parse", "--verify", "bb/gone"]);
});

test("a failed unarchive on rollback is logged, not swallowed (PLUG-185 L9)", async () => {
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
  const childT: ThreadSpec = {
    ...rootT,
    id: "thr_c",
    parentThreadId: "thr_p",
  };
  const w = makeWorld({
    envs: [envA, envB],
    threads: { [envA.id]: [rootT], [envB.id]: [childT] },
    archiveFailFor: new Set(["thr_p"]),
    unarchiveFailFor: new Set(["thr_c"]),
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(
    w.warns.some((m) => m.includes("unarchive thr_c")),
    `warns: ${w.warns.join(" | ")}`,
  );
});

test("commits reachable only from the copy's HEAD reflog keep it (PLUG-185 L10)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  // a commit on detached HEAD — unreachable from every ref, dies with
  // the copy
  git(env.path, ["checkout", "--detach", "HEAD"]);
  commitIn(env.path, "d.txt", "wip: detached");
  git(env.path, ["checkout", env.branchName]);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "unpushed-commits");
});

test("envs of other hosts are skipped entirely (PLUG-185 L11)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const remote: EnvSpec = {
    id: "env_remote",
    path: "/nonexistent/remote-copy",
    branchName: "bb/remote",
    projectId: "proj_1",
    mergeBaseBranch: "origin/main",
    hostId: "host_other",
  };
  // without a local host id the remote env is processed and only earns
  // a bogus not-a-repo row
  const w0 = makeWorld({
    envs: [env, remote],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const r0 = await w0.jan.run();
  assert.equal(r0.kept["not-a-repo"], 1);
  // with the local host known the remote env never enters the list
  const w = makeWorld({
    envs: [env, remote],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    localHostId: "host_local",
  });
  const res = await w.jan.run();
  assert.equal(res.kept["not-a-repo"] ?? 0, 0);
  assert.equal(w.janitor.item("env_remote"), undefined);
});

test("the branch sweep honors excludeProjects (PLUG-185 L11)", async () => {
  const { repo, base } = makeRepo();
  // two merged orphan bb/ branches — one belongs to an excluded env
  git(repo, ["branch", "bb/exc", "main"]);
  git(repo, ["branch", "bb/free", "main"]);
  const env = addEnv(repo, base, "a");
  const excluded: EnvSpec = {
    id: "env_x",
    path: "/nonexistent/x",
    branchName: "bb/exc",
    projectId: "proj_x",
    mergeBaseBranch: "origin/main",
  };
  const w = makeWorld({
    envs: [env, excluded],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    config: CFG({ excludeProjects: ["proj_x"] }),
  });
  const res = await w.jan.run();
  assert.equal(res.removedBranches, 1);
  git(repo, ["rev-parse", "--verify", "bb/exc"]); // survived
  assert.throws(() => git(repo, ["rev-parse", "--verify", "bb/free"]));
});

test("--dry-run honors the disabled janitor's excludeProjects and scope (PLUG-185 L12)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work"); // unmerged
  const clock = { t: Date.now() };
  const stale: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 2 * 24 * 60 * 60_000,
    parentThreadId: "thr_coord",
  };
  // excluded → the dry-run does not even look at the env
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [stale] },
    clock,
    config: '{"enabled": false, "excludeProjects": ["proj_1"]}',
  });
  const res = await w.jan.run({ dryRun: true });
  assert.deepEqual(res.kept, {});
  assert.equal(res.reported.length, 0);
  // not excluded → the same disabled-config dry-run reports it
  const w2 = makeWorld({
    envs: [env],
    threads: { [env.id]: [stale] },
    clock,
    config: '{"enabled": false, "abandonedAfter": "1d"}',
  });
  const res2 = await w2.jan.run({ dryRun: true });
  assert.equal(res2.reported.length, 1);
});

test("rescue fires with the janitor disabled or misconfigured (PLUG-185 B2)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  writeFileSync(join(env.path, "f.txt"), "dirty\n");
  for (const [tag, config] of [
    ["off", '{"enabled": false}'],
    ["bad", '{"enabled": true, "bogus": 1}'],
  ] as const) {
    const w = makeWorld({ envs: [env], threads: {}, config });
    await w.jan.onThreadArchived({
      id: `thr_${tag}`,
      environmentId: env.id,
      parentThreadId: "thr_coord",
    });
    git(repo, [
      "rev-parse",
      "--verify",
      `refs/orchestrator/rescue/thr_${tag}`,
    ]);
    assert.equal(w.sent.length, 1, tag);
  }
});

test("an incomplete or failed rescue tells the coordinator (PLUG-185 M7)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  writeFileSync(join(env.path, "f.txt"), "dirty\n"); // tracked edit
  writeFileSync(join(env.path, "n.txt"), "new\n"); // untracked
  // the untracked add fails → best-effort ref on `stash create`, flagged
  const partialCmd: CmdRunner = {
    run: async (f, a, o) =>
      a.includes("--pathspec-file-nul") ? fail("add") : realCmd.run(f, a, o),
  };
  const w = makeWorld({
    envs: [env],
    threads: {},
    cmd: partialCmd,
  });
  await w.jan.onThreadArchived({
    id: "thr_p",
    environmentId: env.id,
    parentThreadId: "thr_coord",
  });
  git(repo, ["rev-parse", "--verify", "refs/orchestrator/rescue/thr_p"]);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0]!.text, /неполн/);
  // nothing at all could be snapshotted → a failure line, no ref
  const env2 = addEnv(repo, base, "b");
  writeFileSync(join(env2.path, "f.txt"), "dirty\n");
  const failCmd: CmdRunner = {
    run: async (f, a, o) =>
      a.includes("stash") || a.includes("--pathspec-file-nul")
        ? fail("boom")
        : realCmd.run(f, a, o),
  };
  const w2 = makeWorld({ envs: [env2], threads: {}, cmd: failCmd });
  await w2.jan.onThreadArchived({
    id: "thr_f",
    environmentId: env2.id,
    parentThreadId: "thr_coord",
  });
  assert.throws(() =>
    git(repo, ["rev-parse", "--verify", "refs/orchestrator/rescue/thr_f"]),
  );
  assert.equal(w2.sent.length, 1);
  assert.match(w2.sent[0]!.text, /НЕ удался/);
});

// ── PLUG-188 review fixes ────────────────────────────────────────────

test("a commit-less rebase counts by the strict «Created from» formula — merged copy is removed (PLUG-195)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a"); // bb/a at the old origin tip
  // origin/main moves ahead; `git rebase origin/main` fast-forwards
  // bb/a — under the strict formula the foreign commits it lands on
  // count as own (no «rebase (finish) … onto» parsing, PLUG-195).
  commitIn(repo, "g.txt", "feat: ahead");
  git(repo, ["push", "origin", "main"]);
  git(env.path, ["fetch", "origin"]);
  git(env.path, ["rebase", "origin/main"]);
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

test("a rebase that replays commits counts them as own work (PLUG-188 B1)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  commitIn(repo, "g.txt", "feat: ahead"); // origin moves ahead
  git(repo, ["push", "origin", "main"]);
  git(env.path, ["fetch", "origin"]);
  git(env.path, ["rebase", "origin/main"]); // replays feat: work on top
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
});

test("cascade member without an env still faces cond 4 — an active child blocks the archive (PLUG-188 B2)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const clock = { t: Date.now() };
  const root: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: "thr_coord",
  };
  // a child thread with NO environment of its own — BB still archives
  // it together with the root, so its state must be verified (P3)
  const kid: ThreadSpec = {
    id: "thr_kid",
    status: "active",
    queuedWork: "waiting",
    hasPendingInteraction: false,
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    environmentId: null,
    parentThreadId: "thr_a",
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [root] },
    extraThreads: [kid],
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.equal(w.janitor.item(env.id)!.reason, "threads-active");
  // the same env-less child, quiescent — archives with the parent
  kid.status = "idle";
  kid.queuedWork = "none";
  const w2 = makeWorld({
    envs: [env],
    threads: { [env.id]: [root] },
    extraThreads: [kid],
    clock,
  });
  await w2.jan.run();
  w2.clock.t += 16 * 60_000;
  const res2 = await w2.jan.run();
  assert.equal(res2.removedCopies, 1);
  assert.deepEqual(w2.archivedCalls.sort(), ["thr_a", "thr_kid"].sort());
});

test("an unpublished pre-amend version keeps the copy — it is not on origin (PLUG-192 §16.3)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  // the amend changes the content, so the pre-amend commit's patch
  // never lands on origin — the copy cannot be proven loss-free and
  // stays («старая версия до amend, которой нет на origin»)
  writeFileSync(join(env.path, "w.txt"), "feat: work v2\n");
  git(env.path, ["add", "."]);
  git(env.path, ["commit", "--amend", "-m", "feat: work v2"]);
  mergeEnv(repo, env);
  const clock = { t: Date.now() };
  const w = makeWorld({
    envs: [env],
    threads: {
      [env.id]: [
        {
          id: "thr_a",
          status: "idle",
          archivedAt: null,
          updatedAt: clock.t - 30 * 24 * 60 * 60_000,
          parentThreadId: "thr_coord",
        },
      ],
    },
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported.length, 1);
  assert.equal(res.reported[0]!.reason, "abandoned-unpushed");
  assert.equal(w.janitor.item(env.id)!.state, "reported");
});

test("a pre-amend version whose patch reached origin is patch-equivalent — copy is removed (PLUG-192)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  // a message-only amend: the discarded commit's diff is identical to
  // the amended one that reaches origin — patch-id equivalence holds
  git(env.path, ["commit", "--amend", "-m", "feat: work (v2 msg)"]);
  mergeEnv(repo, env);
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

test("a real detached commit keeps a fresh copy and reports an abandoned one (PLUG-188 M3)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  git(env.path, ["checkout", "--detach", "HEAD"]);
  commitIn(env.path, "d.txt", "wip: detached");
  git(env.path, ["checkout", env.branchName]);
  const clock = { t: Date.now() };
  // abandoned thread → «брошено» report, not a silent keep
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
  await w.jan.run(); // first pass only starts the merged-streak
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(res.reported.length, 1);
  assert.equal(res.reported[0]!.reason, "abandoned-unpushed");
  assert.equal(w.janitor.item(env.id)!.state, "reported");
  // a fresh thread instead → kept, no report
  const w2 = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w2.jan.run();
  w2.clock.t += 16 * 60_000;
  const res2 = await w2.jan.run();
  assert.equal(res2.reported.length, 0);
  assert.equal(w2.janitor.item(env.id)!.reason, "unpushed-commits");
});

test("the whole HEAD reflog is scanned — a detached commit past the first 500 entries still counts (PLUG-188 L5)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  // an orphan commit object nobody references — with a file origin
  // lacks (an empty-diff commit would be content-equal, not lost)
  writeFileSync(join(repo, "detached.txt"), "wip\n");
  git(repo, ["add", "detached.txt"]);
  const orphan = git(repo, [
    "commit-tree",
    git(repo, ["write-tree"]),
    "-p",
    "HEAD",
    "-m",
    "wip: ancient detached",
  ]);
  git(repo, ["reset", "-q", "HEAD"]);
  rmSync(join(repo, "detached.txt"));
  const head = git(repo, ["rev-parse", "HEAD"]);
  // 600 newest reflog lines are non-commit noise; the detached commit
  // sits in the 601st (oldest) position — a 500-entry slice would miss it
  const lines = [
    ...Array.from({ length: 600 }, () => head),
    orphan,
  ];
  const reflogCmd: CmdRunner = {
    run: async (f, a, o) =>
      a[2] === "log" && a[3] === "-g" && a[5] === "HEAD"
        ? ok(lines.join("\n") + "\n")
        : realCmd.run(f, a, o),
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    cmd: reflogCmd,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "unpushed-commits");
});

test("a thread that comes alive between the snapshot and the archive re-check keeps the copy (PLUG-188 M4)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const clock = { t: Date.now() };
  const t1: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: "thr_coord",
  };
  // the second `thread list` — the pre-archive re-read — sees it active
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [t1] },
    clock,
    onThreadListCall: (n) => {
      if (n >= 2) t1.status = "active";
    },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.equal(w.janitor.item(env.id)!.reason, "threads-active");
});

test("a copy dirtied between the snapshot and the archive re-check is kept (PLUG-188 M4)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    onThreadListCall: (n) => {
      // dirtied after the run-start git status, before the archive
      if (n >= 2) writeFileSync(join(env.path, "late.txt"), "x\n");
    },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.equal(w.janitor.item(env.id)!.reason, "dirty");
});

test("a cascade member spawned between the snapshot and the re-read is checked and archived too (PLUG-188 M4)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const clock = { t: Date.now() };
  const root: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: "thr_coord",
  };
  const kid: ThreadSpec = {
    id: "thr_late",
    status: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    environmentId: env.id,
    parentThreadId: "thr_a",
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [root] },
    clock,
    onThreadListCall: (n) => {
      if (n >= 2) w.threadSpecs[env.id] = [root, kid];
    },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
  assert.deepEqual(w.archivedCalls.sort(), ["thr_a", "thr_late"].sort());
});

test("--dry-run writes nothing and sends nothing (PLUG-192 M3)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work"); // never merged
  const clock = { t: Date.now() };
  const stale: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 2 * 24 * 60 * 60_000,
    parentThreadId: "thr_coord",
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [stale] },
    clock,
    config: CFG({ mode: "report" }),
  });
  const d = w.store.insert({
    taskKey: "PLUG-9d",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  w.store.setThreadInfo(d.id, "thr_a");
  w.store.setStatus(d.id, "done");
  const res = await w.jan.run({ dryRun: true });
  // the preview still reports abandoned copies in its output…
  assert.equal(res.reported.length, 1);
  // …but §15 «--dry-run ничего не пишет и ничего не отправляет»: no
  // coordinator message, no janitor_meta marks, no item rows, no run row
  assert.equal(w.sent.length, 0);
  assert.equal(w.janitor.meta("dailyNotify:thr_coord"), undefined);
  assert.equal(w.janitor.meta("announcedAbandoned"), undefined);
  assert.equal(w.janitor.meta("repoRoots"), undefined);
  assert.equal(w.janitor.item(env.id), undefined);
  assert.equal(w.janitor.latestRun(), undefined);
  assert.equal(res.removedCopies, 0);
});

test("a branch checked out in a copy whose directory is already gone is NOT «open» (PLUG-188 L7)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  // BB deleted the copy's directory but left the worktree entry — the
  // branch shows in `worktree list` as prunable yet must not block
  // the sweep
  const stalePath = join(base, "envs", "stale");
  git(repo, ["worktree", "add", stalePath, "-b", "bb/stale"]);
  rmSync(stalePath, { recursive: true, force: true });
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const res = await w.jan.run();
  assert.equal(res.orphanBranches, 1);
  assert.equal(res.removedBranches, 1);
  assert.throws(() => git(repo, ["rev-parse", "--verify", "bb/stale"]));
});

test("an env that leaves «брошено» drops out of announcedAbandoned and is re-announced later (PLUG-188 L8)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work"); // never merged
  const clock = { t: Date.now() };
  const thread: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 2 * 24 * 60 * 60_000,
    parentThreadId: "thr_coord",
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [thread] },
    clock,
  });
  const d = w.store.insert({
    taskKey: "PLUG-9e",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  w.store.setThreadInfo(d.id, "thr_a");
  w.store.setStatus(d.id, "done");
  await w.jan.run();
  assert.equal(w.sent.length, 1);
  assert.match(
    w.janitor.meta("announcedAbandoned") ?? "",
    new RegExp(env.id),
  );
  // the env stops being abandoned — the announced list forgets it
  thread.updatedAt = clock.t;
  await w.jan.run();
  assert.ok(
    !(w.janitor.meta("announcedAbandoned") ?? "").includes(env.id),
  );
  // abandoned again → announced again (past the daily watermark)
  thread.updatedAt = clock.t - 2 * 24 * 60 * 60_000;
  w.clock.t += 25 * 60 * 60_000;
  await w.jan.run();
  assert.equal(w.sent.length, 2);
});

test("probe B: a commit discarded by reset --hard keeps the copy — reflog still holds it (PLUG-192 B1)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: unique work"); // never pushed
  // the commit survives only in the copy's reflogs — deleting the copy
  // would lose it
  git(env.path, ["reset", "--hard", "HEAD~1"]);
  const clock = { t: Date.now() };
  // abandoned thread → «брошено» report, not a silent removal
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
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported.length, 1);
  assert.equal(res.reported[0]!.reason, "abandoned-unpushed");
  assert.equal(w.janitor.item(env.id)!.state, "reported");
  // fresh thread → simply kept, no report
  const w2 = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w2.jan.run();
  w2.clock.t += 16 * 60_000;
  const res2 = await w2.jan.run();
  assert.equal(res2.removedCopies, 0);
  assert.equal(res2.reported.length, 0);
});

test("probe A: two rebases of published work — every reflog commit is on origin, copy is removed (PLUG-192 M2)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  git(env.path, ["push", "-u", "origin", env.branchName]); // v1 published
  // two upstream moves + two rebases — the pre-rebase versions are
  // already on origin, so nothing is lost
  commitIn(repo, "g.txt", "feat: ahead1");
  git(repo, ["push", "origin", "main"]);
  git(env.path, ["fetch", "origin"]);
  git(env.path, ["rebase", "origin/main"]);
  git(env.path, ["push", "-f", "origin", env.branchName]); // v2 published
  commitIn(repo, "h.txt", "feat: ahead2");
  git(repo, ["push", "origin", "main"]);
  git(env.path, ["fetch", "origin"]);
  git(env.path, ["rebase", "origin/main"]);
  git(env.path, ["push", "-f", "origin", env.branchName]); // v3 published
  git(repo, ["merge", "--no-ff", "--no-edit", env.branchName]);
  git(repo, ["push", "origin", "main"]);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 1);
  assert.equal(res.reported.length, 0);
  assert.equal(w.janitor.item(env.id)!.state, "removed");
});

test("announcedAbandoned survives a transient run failure — no re-announce (PLUG-192 M4)", async () => {
  const { repo, base, origin } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work"); // never merged
  const clock = { t: Date.now() };
  const stale: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 2 * 24 * 60 * 60_000,
    parentThreadId: "thr_coord",
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [stale] },
    clock,
  });
  const d = w.store.insert({
    taskKey: "PLUG-9f",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  w.store.setThreadInfo(d.id, "thr_a");
  w.store.setStatus(d.id, "done");
  await w.jan.run();
  assert.equal(w.sent.length, 1);
  assert.match(w.janitor.meta("announcedAbandoned") ?? "", new RegExp(env.id));
  // a transient fetch failure: the env is not evaluated this run, but
  // it must NOT drop out of the announced list
  git(repo, ["remote", "set-url", "origin", join(base, "gone.git")]);
  const res = await w.jan.run();
  assert.equal(res.reported.length, 0);
  assert.equal(res.kept["fetch-failed"], 1);
  assert.match(w.janitor.meta("announcedAbandoned") ?? "", new RegExp(env.id));
  // fetch recovers — the env is reported again but stays announced:
  // no second message, even past the daily watermark
  git(repo, ["remote", "set-url", "origin", origin]);
  w.clock.t += 25 * 60 * 60_000;
  const res2 = await w.jan.run();
  assert.equal(res2.reported.length, 1);
  assert.equal(w.sent.length, 1);
});

test("a copy whose HEAD moved between the snapshot and the archive is kept — head-changed (PLUG-192 L5)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    onThreadListCall: (n) => {
      // a commit lands after the run-start HEAD snapshot, on the
      // pre-archive re-read (list calls are cumulative across runs:
      // run 1 → #1, run 2 → #2 initial + #3 fresh) — the archive must
      // be cancelled
      if (n >= 3 && !existsSync(join(env.path, "late.txt"))) {
        commitIn(env.path, "late.txt", "feat: late");
      }
    },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.equal(w.janitor.item(env.id)!.reason, "head-changed");
});

test("an env thread created mid-run outside the cascade keeps the copy — fresh-graph remaining (PLUG-192 L6)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const clock = { t: Date.now() };
  const root: ThreadSpec = {
    id: "thr_a",
    status: "idle",
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    parentThreadId: "thr_coord",
  };
  // appears between the snapshot and the archive: not a cascade member
  // (no parent, not a dispatch thread) but it holds the same copy
  const late: ThreadSpec = {
    id: "thr_late",
    status: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    archivedAt: null,
    updatedAt: clock.t - 60_000,
    environmentId: env.id,
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [root] },
    clock,
    onThreadListCall: (n) => {
      // call #3 is run 2's pre-archive re-read — `late` is invisible
      // to the run-start snapshot and appears only in the fresh graph
      if (n >= 3) w.threadSpecs[env.id] = [root, late];
    },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, ["thr_a"]);
  assert.equal(w.janitor.item(env.id)!.reason, "threads-remaining");
});

test("an unreadable HEAD reflog keeps the copy — unpushed-unknown (PLUG-192)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const reflogFail: CmdRunner = {
    run: async (f, a, o) =>
      a[2] === "log" && a[3] === "-g" && a[5] === "HEAD"
        ? fail("reflog gone")
        : realCmd.run(f, a, o),
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    cmd: reflogFail,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.janitor.item(env.id)!.reason, "unpushed-unknown");
});

test("PROBE1: a reset-orphan in a copy-less bb/ branch's own reflog keeps it (PLUG-195)", async () => {
  const { repo, base } = makeRepo();
  // bb/o: commit U, then reset --hard — the tip is merged, but U lives
  // only in the branch reflog that `branch -D` would erase
  git(repo, ["checkout", "-b", "bb/o"]);
  writeFileSync(join(repo, "u.txt"), "unpushed\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: unpushed"]);
  const u = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["reset", "--hard", "HEAD~1"]);
  git(repo, ["checkout", "main"]);
  const env = addEnv(repo, base, "a");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const res = await w.jan.run();
  assert.equal(res.removedBranches, 0);
  assert.equal(res.orphanBranches, 0);
  assert.equal(res.kept["branch-unpushed"], 1);
  assert.equal(
    git(repo, ["rev-parse", "bb/o"]),
    git(repo, ["rev-parse", "main"]),
  );
  // U is still reachable from the branch reflog
  assert.ok(
    git(repo, ["log", "-g", "--format=%H", "refs/heads/bb/o"]).includes(u),
  );
});

test("a branch-unpushed orphan idle over abandonedAfter is reported (PLUG-195)", async () => {
  const { repo, base } = makeRepo();
  git(repo, ["checkout", "-b", "bb/o"]);
  writeFileSync(join(repo, "u.txt"), "unpushed\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: unpushed"]);
  git(repo, ["reset", "--hard", "HEAD~1"]);
  git(repo, ["checkout", "main"]);
  // age the branch reflog past abandonedAfter (1d in CFG)
  const stale = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  utimesSync(join(repo, ".git", "logs", "refs", "heads", "bb", "o"), stale, stale);
  const env = addEnv(repo, base, "a");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const res = await w.jan.run();
  assert.equal(res.kept["branch-unpushed"], 1);
  const item = res.reported.find((r) => r.branch === "bb/o");
  assert.ok(item);
  const key = `branch:${git(env.path, ["rev-parse", "--git-common-dir"])}:bb/o`;
  assert.equal(item.envId, key);
  assert.equal(item.reason, "branch-unpushed");
  assert.equal(w.janitor.item(key)!.state, "reported");
  // when the orphan commit is published the branch becomes sweepable
  // again and the «брошено» row closes
  const u = git(repo, ["rev-parse", "bb/o@{1}"]);
  git(repo, ["merge", "--ff-only", u]);
  git(repo, ["push", "origin", "main"]);
  const res2 = await w.jan.run();
  assert.equal(res2.removedBranches, 1);
  assert.equal(w.janitor.item(key)!.state, "removed");
  assert.throws(() => git(repo, ["rev-parse", "--verify", "bb/o"]));
});

test("U2: a squash of two or more commits stays — reported «похоже, влито squash» (PLUG-201)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w1.txt", "feat: part 1");
  commitIn(env.path, "w2.txt", "feat: part 2");
  // a single squash commit on main holds both changes — no commit of
  // bb/a is patch-equivalent (`git cherry` says «+»), so the copy is
  // never «влита»; merging it adds nothing, which earns the manual
  // flag in the report — removal is off the table (PLUG-201)
  writeFileSync(join(repo, "w1.txt"), "feat: part 1\n");
  writeFileSync(join(repo, "w2.txt"), "feat: part 2\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: squashed both parts"]);
  git(repo, ["push", "origin", "main"]);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.ok(existsSync(env.path));
  const item = res.reported.find((r) => r.envId === env.id);
  assert.ok(item);
  assert.equal(item.reason, "squash-suspect");
  assert.equal(w.janitor.item(env.id)!.state, "reported");
  git(repo, ["rev-parse", "--verify", env.branchName]);
});

test("PROBE3: a commit + reset between the snapshot and the archive keeps the copy (PLUG-195)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    onThreadListCall: (n) => {
      // call #2 is the pre-archive re-read: a process commits and
      // resets right before the archive — HEAD is unchanged and the
      // tree stays clean, but the reflog now holds an unpublished
      // commit that would die with the copy
      if (n === 2) {
        commitIn(env.path, "late.txt", "wip: late unpushed");
        git(env.path, ["reset", "--hard", "HEAD~1"]);
      }
    },
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.equal(w.janitor.item(env.id)!.reason, "unpushed-commits");
});

test("a pull-merge entry does not hide own commits — strict «Created from» count (PLUG-195)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  // origin/main moves ahead; `git pull` writes «pull origin main:
  // Merge made by the 'ort' strategy.» — a reflog record the old
  // type-parser mistook for a commit-less move (own commits = 0)
  commitIn(repo, "g.txt", "feat: ahead");
  git(repo, ["push", "origin", "main"]);
  git(env.path, ["pull", "--no-rebase", "--no-edit", "origin", "main"]);
  mergeEnv(repo, env);
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

test("PX1: a commit + its revert nets to origin — the commit itself never reached it, copy stays (PLUG-197)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "a.txt", "feat: A");
  const a = git(env.path, ["rev-parse", "HEAD"]);
  // «A + revert A» leaves the tip tree equal to origin — the tip
  // merges as a no-op, so the copy gets the «похоже, влито squash»
  // report flag, but A's content never reached origin and the copy
  // is never deleted (PLUG-201)
  git(env.path, ["revert", "--no-edit", "HEAD"]);
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
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported.length, 1);
  assert.equal(res.reported[0]!.reason, "squash-suspect");
  // A survives only in the copy's reflogs — it must be found there
  assert.ok(
    git(env.path, ["log", "-g", "--format=%H", "HEAD"]).includes(a),
  );
  // the branch is still checked out in the copy — it stays too
  git(repo, ["rev-parse", "--verify", env.branchName]);
});

test("PX2: the same on a detached HEAD — the branch has no own commits, the idle copy stays (PLUG-197)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  git(env.path, ["checkout", "--detach"]);
  commitIn(env.path, "a.txt", "feat: A");
  const a = git(env.path, ["rev-parse", "HEAD"]);
  git(env.path, ["revert", "--no-edit", "HEAD"]);
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
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported[0]!.reason, "squash-suspect");
  assert.ok(
    git(env.path, ["log", "-g", "--format=%H", "HEAD"]).includes(a),
  );
});

test("PX3: a merge that discarded its own change (-X theirs) keeps the copy (PLUG-197)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  writeFileSync(join(env.path, "f.txt"), "base\nmine\n");
  git(env.path, ["add", "."]);
  git(env.path, ["commit", "-m", "feat: A edits f.txt"]);
  const a = git(env.path, ["rev-parse", "HEAD"]);
  // origin moves ahead with a conflicting f.txt; the merge resolves
  // 100% «theirs», so the tip tree equals origin — but A's content is
  // on origin nowhere
  writeFileSync(join(repo, "f.txt"), "base\norigin\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: origin edits f.txt"]);
  git(repo, ["push", "origin", "main"]);
  git(env.path, ["fetch", "origin"]);
  git(env.path, ["merge", "-X", "theirs", "--no-edit", "origin/main"]);
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
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported[0]!.reason, "squash-suspect");
  assert.ok(
    git(env.path, ["log", "-g", "--format=%H", "HEAD"]).includes(a),
  );
});

test("PX4: a copy-less bb/ branch with «A + revert A» is not deleted (PLUG-197)", async () => {
  const { repo, base } = makeRepo();
  git(repo, ["checkout", "-b", "bb/o"]);
  writeFileSync(join(repo, "o.txt"), "unpushed\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: A"]);
  const a = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["revert", "--no-edit", "HEAD"]);
  git(repo, ["checkout", "main"]);
  // age the branch reflog past abandonedAfter — «брошено», not delete
  const stale = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  utimesSync(join(repo, ".git", "logs", "refs", "heads", "bb", "o"), stale, stale);
  const env = addEnv(repo, base, "a");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const res = await w.jan.run();
  assert.equal(res.removedBranches, 0);
  assert.equal(res.kept["branch-unpushed"], 1);
  const key = `branch:${git(env.path, ["rev-parse", "--git-common-dir"])}:bb/o`;
  const item = res.reported.find((r) => r.envId === key);
  assert.ok(item);
  assert.equal(item.reason, "branch-unpushed");
  git(repo, ["rev-parse", "--verify", "bb/o"]);
  assert.ok(
    git(repo, ["log", "-g", "--format=%H", "refs/heads/bb/o"]).includes(a),
  );
});

test("a squash that rewrote an earlier commit keeps the copy — «брошено» when idle (PLUG-197)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "s.txt", "feat: v1");
  const a = git(env.path, ["rev-parse", "HEAD"]);
  writeFileSync(join(env.path, "s.txt"), "feat: v2\n");
  git(env.path, ["add", "."]);
  git(env.path, ["commit", "-m", "feat: v2 rewrites v1"]);
  // the squash on origin holds only the final content: the tip merges
  // as a no-op («похоже, влито squash» — report flag), but A's own
  // content never reached origin and the copy is never deleted
  writeFileSync(join(repo, "s.txt"), "feat: v2\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: squashed v2 only"]);
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
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported[0]!.reason, "squash-suspect");
  assert.ok(
    git(env.path, ["log", "-g", "--format=%H", "HEAD"]).includes(a),
  );
});

test("PX5: one repo never closes another repo's «брошено» branch row — key is branch:<commonDir>:<name> (PLUG-197)", async () => {
  const r1 = makeRepo();
  const r2 = makeRepo();
  // repo1: abandoned unpushed orphan bb/o (reset-orphan, aged reflog)
  git(r1.repo, ["checkout", "-b", "bb/o"]);
  writeFileSync(join(r1.repo, "u.txt"), "unpushed\n");
  git(r1.repo, ["add", "."]);
  git(r1.repo, ["commit", "-m", "feat: unpushed"]);
  git(r1.repo, ["reset", "--hard", "HEAD~1"]);
  git(r1.repo, ["checkout", "main"]);
  const stale = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  utimesSync(
    join(r1.repo, ".git", "logs", "refs", "heads", "bb", "o"),
    stale,
    stale,
  );
  const e1 = addEnv(r1.repo, r1.base, "a");
  const e2 = addEnv(r2.repo, r2.base, "b");
  const w = makeWorld({
    envs: [e1, e2], // repo1 first — its row must survive repo2's sweep
    threads: {
      [e1.id]: [idle({ t: Date.now() }, e1.id)],
      [e2.id]: [idle({ t: Date.now() }, e2.id)],
    },
  });
  const res = await w.jan.run();
  const c1 = git(e1.path, ["rev-parse", "--git-common-dir"]);
  const key = `branch:${c1}:bb/o`;
  // old key `branch:bb/o` was closed by repo2's pass (no bb/o there)
  assert.equal(w.janitor.item(key)!.state, "reported");
  const item = res.reported.find((r) => r.envId === key);
  assert.ok(item);
  assert.equal(item.branch, "bb/o");
  // a namesake in another repo gets its own row, not a collision
  const key2 = `branch:${git(e2.path, ["rev-parse", "--git-common-dir"])}:bb/o`;
  assert.notEqual(key, key2);
});

test("PX6: an announced abandoned branch survives a fetch-failed run — no repeat message (PLUG-197)", async () => {
  const { repo, base, origin } = makeRepo();
  git(repo, ["checkout", "-b", "bb/o"]);
  writeFileSync(join(repo, "u.txt"), "unpushed\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: unpushed"]);
  git(repo, ["reset", "--hard", "HEAD~1"]);
  git(repo, ["checkout", "main"]);
  const stale = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  utimesSync(join(repo, ".git", "logs", "refs", "heads", "bb", "o"), stale, stale);
  const env = addEnv(repo, base, "a");
  const clock = { t: Date.now() };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: clock.t }, env.id)] },
    clock,
  });
  const key = `branch:${git(env.path, ["rev-parse", "--git-common-dir"])}:bb/o`;
  // attribution for the daily message: the row's thread → delegation
  w.janitor.upsertItem(key, { threadId: "thr_a", state: "kept" }, clock.t);
  const d = w.store.insert({
    taskKey: "PLUG-197",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  w.store.setThreadInfo(d.id, "thr_a");
  w.store.setStatus(d.id, "done");
  await w.jan.run();
  assert.equal(w.sent.length, 1);
  assert.match(w.janitor.meta("announcedAbandoned") ?? "", new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // fetch down: the repo is not swept — the branch row is unproven
  // this run and must stay announced
  git(repo, ["remote", "set-url", "origin", join(base, "gone.git")]);
  const res2 = await w.jan.run();
  assert.equal(res2.reported.length, 0);
  assert.match(w.janitor.meta("announcedAbandoned") ?? "", /bb\/o/);
  // fetch back, past the daily watermark: reported again, but no
  // second message — the announcement never dropped
  git(repo, ["remote", "set-url", "origin", origin]);
  w.clock.t += 25 * 60 * 60_000;
  const res3 = await w.jan.run();
  assert.equal(res3.reported.filter((r) => r.envId === key).length, 1);
  assert.equal(w.sent.length, 1);
});

test("a process entering the copy between the snapshot and the archive keeps it (PLUG-197)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "w.txt", "feat: work");
  mergeEnv(repo, env);
  let calls = 0;
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    // run 1 stops at the afterMerge gate before the probe; call 1 —
    // run-2 snapshot, call 2 — the pre-archive re-check: a process
    // cd'ed in meanwhile
    hasProcessIn: async () => ++calls > 1,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.deepEqual(w.archivedCalls, []);
  assert.equal(w.janitor.item(env.id)!.reason, "process-inside");
});

test("Q1: after reflog expiry «A + revert A» still keeps the copy — ancestors count (PLUG-198)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "a.txt", "feat: A");
  const a = git(env.path, ["rev-parse", "HEAD"]);
  git(env.path, ["revert", "--no-edit", "HEAD"]);
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
  // while the reflog still names A the verdict is already reported —
  // the tip nets to origin, so the flag is «похоже, влито squash»
  let res = await w.jan.run();
  assert.equal(res.reported[0]!.reason, "squash-suspect");
  // `gc.reflogExpire` (90d) erases every position — A is reachable
  // only as an ancestor of the tip; it must still block removal
  git(env.path, ["reflog", "expire", "--expire=now", "--all"]);
  // the «reported» row keeps firstSeenAt (PLUG-199) — no merged-wait ↔
  // reported streak flip; the verdict itself is unchanged
  w.clock.t += 16 * 60_000;
  res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  w.clock.t += 16 * 60_000;
  res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported[0]!.reason, "squash-suspect");
  assert.equal(res.removedBranches, 0);
  git(repo, ["rev-parse", "--verify", env.branchName]);
  assert.ok(git(env.path, ["rev-list", "HEAD"]).includes(a));
});

test("Q2: a copy-less bb/ branch without a reflog — «A + revert A» is not deleted (PLUG-198)", async () => {
  const { repo, base } = makeRepo();
  git(repo, ["checkout", "-b", "bb/o"]);
  writeFileSync(join(repo, "o.txt"), "unpushed\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: A"]);
  git(repo, ["revert", "--no-edit", "HEAD"]);
  git(repo, ["checkout", "main"]);
  // no reflog at all — the tip itself must stand in as a position
  git(repo, ["reflog", "expire", "--expire=now", "refs/heads/bb/o"]);
  rmSync(join(repo, ".git", "logs", "refs", "heads", "bb", "o"), {
    force: true,
  });
  const env = addEnv(repo, base, "a");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const res = await w.jan.run();
  assert.equal(res.removedBranches, 0);
  assert.equal(res.kept["branch-unpushed"], 1);
  git(repo, ["rev-parse", "--verify", "bb/o"]);
});

test("Q3: commits pulled --ff-only from a third clone keep the copy (PLUG-198)", async () => {
  const { repo, base, origin } = makeRepo();
  const env = addEnv(repo, base, "a");
  // a third clone holds X1 + «revert X1»; the copy fast-forwards to it —
  // the HEAD reflog records only the landing tip, X1 is never a
  // position, only an ancestor
  const clone = join(base, "clone3");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, ["config", "user.name", "Agent"]);
  git(clone, ["config", "user.email", "agent@x.io"]);
  // bare origin's HEAD is not main — the clone checks nothing out;
  // base the work on the fetched origin/main so ff is possible
  git(clone, ["checkout", "-b", "main", "origin/main"]);
  const cbranch = git(clone, ["symbolic-ref", "--short", "-q", "HEAD"]);
  commitIn(clone, "x.txt", "feat: X1");
  const x1 = git(clone, ["rev-parse", "HEAD"]);
  git(clone, ["revert", "--no-edit", "HEAD"]);
  git(env.path, ["pull", "--ff-only", clone, cbranch]);
  rmSync(clone, { recursive: true, force: true });
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
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported[0]!.reason, "squash-suspect");
  // X1 lives only on bb/a — the branch must stay too
  assert.equal(res.removedBranches, 0);
  assert.ok(git(env.path, ["rev-list", env.branchName]).includes(x1));
});

test("Q4: an empty commit has no content — the copy stays (PLUG-198)", async () => {
  const { repo, base } = makeRepo();
  const env = addEnv(repo, base, "a");
  git(env.path, ["commit", "--allow-empty", "-m", "chore: empty"]);
  const clock = { t: Date.now() };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: clock.t }, env.id)] },
    clock,
  });
  await w.jan.run();
  w.clock.t += 16 * 60_000;
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.ok(existsSync(env.path));
  // an empty commit merges as a no-op — the tip is merge-tree equal,
  // so the copy gets the «похоже, влито squash» flag; an empty
  // commit is safe only as an ancestor, so it is never deleted
  assert.equal(res.reported[0]!.reason, "squash-suspect");
});

// ── PLUG-199 ─────────────────────────────────────────────────────────

test("M1: a merge driver from repo config cannot fake the content sign — the copy stays (PLUG-199)", async () => {
  const { repo, base } = makeRepo();
  // `db.yml merge=ours` + a silent `true` driver: merge-tree reproduces
  // the target tree for ANY commit touching db.yml — the content sign
  // must run with every configured driver disabled
  writeFileSync(join(repo, ".gitattributes"), "db.yml merge=ours\n");
  writeFileSync(join(repo, "db.yml"), "db: base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "chore: attrs + db"]);
  git(repo, ["push", "origin", "main"]);
  git(repo, ["config", "merge.ours.driver", "true"]);
  const env = addEnv(repo, base, "a");
  writeFileSync(join(env.path, "db.yml"), "db: local\n");
  git(env.path, ["add", "db.yml"]);
  git(env.path, ["commit", "-m", "feat: A edits db.yml"]);
  const a = git(env.path, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "db.yml"), "db: origin\n");
  git(repo, ["add", "db.yml"]);
  git(repo, ["commit", "-m", "feat: origin edits db.yml"]);
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
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.archivedCalls.length, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported[0]!.reason, "abandoned-unmerged");
  // A is on no remote branch — a removal would have lost it
  assert.ok(!git(repo, ["branch", "-r", "--contains", a]).includes(a));
});

test("M1b: the same driver cannot fake a copy-less bb/ branch's safety — it stays (PLUG-199)", async () => {
  const { repo, base } = makeRepo();
  writeFileSync(join(repo, ".gitattributes"), "db.yml merge=ours\n");
  writeFileSync(join(repo, "db.yml"), "db: base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "chore: attrs + db"]);
  git(repo, ["config", "merge.ours.driver", "true"]);
  git(repo, ["checkout", "-b", "bb/o"]);
  writeFileSync(join(repo, "db.yml"), "db: local\n");
  git(repo, ["add", "db.yml"]);
  git(repo, ["commit", "-m", "feat: A"]);
  git(repo, ["checkout", "main"]);
  writeFileSync(join(repo, "db.yml"), "db: origin\n");
  git(repo, ["add", "db.yml"]);
  git(repo, ["commit", "-m", "feat: origin db"]);
  git(repo, ["push", "origin", "main"]);
  const env = addEnv(repo, base, "a");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const res = await w.jan.run();
  assert.equal(res.removedBranches, 0);
  git(repo, ["rev-parse", "--verify", "bb/o"]);
});

test("S1: a copy with a submodule is never removed — its objects live in the copy (PLUG-199)", async () => {
  const { repo, base } = makeRepo();
  const subSrc = join(base, "subsrc");
  execFileSync("git", ["init", "-q", "-b", "main", subSrc]);
  git(subSrc, ["config", "user.name", "Agent"]);
  git(subSrc, ["config", "user.email", "agent@x.io"]);
  writeFileSync(join(subSrc, "s.txt"), "s\n");
  git(subSrc, ["add", "."]);
  git(subSrc, ["commit", "-qm", "feat: sub"]);
  const env = addEnv(repo, base, "a");
  git(env.path, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    subSrc,
    "sub",
  ]);
  git(env.path, ["commit", "-qm", "feat: add submodule"]);
  mergeEnv(repo, env);
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
  assert.equal(res.removedCopies, 0);
  assert.equal(w.archivedCalls.length, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported[0]!.reason, "abandoned-submodules");
});

test("P4: a patch-equivalent commit clears «ничего не теряется» even with merges in history (PLUG-199)", async () => {
  const { repo, base } = makeRepo();
  // a --no-ff merge in origin's history — a bare rev-list walk used to
  // find it and disable the patch-id sign entirely
  git(repo, ["checkout", "-b", "side"]);
  commitIn(repo, "side.txt", "feat: side");
  git(repo, ["checkout", "main"]);
  commitIn(repo, "m.txt", "feat: main work");
  git(repo, ["merge", "--no-ff", "-m", "merge: side", "side"]);
  git(repo, ["push", "origin", "main"]);
  const env = addEnv(repo, base, "a");
  commitIn(env.path, "c.txt", "feat: C");
  const c = git(env.path, ["rev-parse", "HEAD"]);
  // C reaches origin only by patch — cherry-picked, then its lines
  // edited so merge-tree conflicts (no content equality, no ancestry)
  git(repo, ["cherry-pick", "-x", c]);
  writeFileSync(join(repo, "c.txt"), "feat: C\nedited\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fix: adjust C"]);
  git(repo, ["push", "origin", "main"]);
  // the copy's tip returns to its merge base — C lives on only in the
  // reflogs; the env is «влита», C must be proven by patch-id
  git(env.path, ["reset", "--hard", "HEAD~1"]);
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
  assert.deepEqual(w.archivedCalls, ["thr_a"]);
});

test("a branch moved between the check and the delete is not deleted — update-ref refuses (PLUG-199)", async () => {
  const { repo, base } = makeRepo();
  // bb/o at origin's tip — fully merged, safe to delete …
  const tip = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "bb/o", tip]);
  const env = addEnv(repo, base, "a");
  // … until a concurrent operator moves it between the janitor's
  // check and its `update-ref -d` — the delete must refuse
  const moved = git(repo, [
    "commit-tree",
    `${tip}^{tree}`,
    "-p",
    tip,
    "-m",
    "wip: moved",
  ]);
  const movingCmd: CmdRunner = {
    run: async (file, args, o) => {
      if (
        file === "git" &&
        args[0] === "-C" &&
        args[2] === "update-ref" &&
        args[3] === "-d" &&
        args[4] === "refs/heads/bb/o"
      ) {
        git(repo, ["branch", "-f", "bb/o", moved]);
      }
      return realCmd.run(file, args, o);
    },
  };
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
    cmd: movingCmd,
  });
  const res = await w.jan.run();
  assert.equal(res.removedBranches, 0);
  assert.equal(res.kept["branch-delete-failed"], 1);
  assert.equal(git(repo, ["rev-parse", "bb/o"]), moved);
});

// ── PLUG-201 ─────────────────────────────────────────────────────────

test("U1: a built-in union merge driver cannot fake removal — the copy stays (PLUG-201)", async () => {
  const { repo, base } = makeRepo();
  // `merge=union` needs no `merge.<name>.driver` config at all — the
  // old per-driver `-c` overrides could never reach it. Only dropping
  // the content sign from the removal path makes the copy safe.
  writeFileSync(join(repo, ".gitattributes"), "db.yml merge=union\n");
  writeFileSync(join(repo, "db.yml"), "db: base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "chore: attrs + db"]);
  git(repo, ["push", "origin", "main"]);
  const env = addEnv(repo, base, "a");
  writeFileSync(join(env.path, "db.yml"), "db: local\n");
  git(env.path, ["add", "db.yml"]);
  git(env.path, ["commit", "-m", "feat: A edits db.yml"]);
  const a = git(env.path, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "db.yml"), "db: origin\n");
  git(repo, ["add", "db.yml"]);
  git(repo, ["commit", "-m", "feat: origin edits db.yml"]);
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
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.archivedCalls.length, 0);
  assert.ok(existsSync(env.path));
  // the union merge would keep BOTH lines — never the target tree, so
  // no «похоже, влито squash» flag either: plain «брошено» unmerged
  assert.equal(res.reported[0]!.reason, "abandoned-unmerged");
  assert.ok(!git(repo, ["branch", "-r", "--contains", a]).includes(a));
});

test("U1b: the same for a copy-less bb/ branch — union cannot sweep it (PLUG-201)", async () => {
  const { repo, base } = makeRepo();
  writeFileSync(join(repo, ".gitattributes"), "db.yml merge=union\n");
  writeFileSync(join(repo, "db.yml"), "db: base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "chore: attrs + db"]);
  git(repo, ["checkout", "-b", "bb/o"]);
  writeFileSync(join(repo, "db.yml"), "db: local\n");
  git(repo, ["add", "db.yml"]);
  git(repo, ["commit", "-m", "feat: A"]);
  git(repo, ["checkout", "main"]);
  writeFileSync(join(repo, "db.yml"), "db: origin\n");
  git(repo, ["add", "db.yml"]);
  git(repo, ["commit", "-m", "feat: origin db"]);
  git(repo, ["push", "origin", "main"]);
  const env = addEnv(repo, base, "a");
  const w = makeWorld({
    envs: [env],
    threads: { [env.id]: [idle({ t: Date.now() }, env.id)] },
  });
  const res = await w.jan.run();
  assert.equal(res.removedBranches, 0);
  assert.equal(res.kept["branch-unpushed"], 1);
  git(repo, ["rev-parse", "--verify", "bb/o"]);
});

test("E1: a merge driver whose name holds «=» cannot fake removal (PLUG-201)", async () => {
  const { repo, base } = makeRepo();
  // `merge.we=ird.driver` is a real driver key, but `git -c` cannot
  // express it: `-c merge.we=ird.driver=false` splits at the FIRST
  // `=` and sets an unrelated key — the driver always ran. Attributes
  // disabled wholesale (`--attr-source`, `core.attributesFile`) is
  // the only override that reaches it.
  writeFileSync(join(repo, ".gitattributes"), "db.yml merge=we=ird\n");
  writeFileSync(join(repo, "db.yml"), "db: base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "chore: attrs + db"]);
  git(repo, ["push", "origin", "main"]);
  git(repo, ["config", "merge.we=ird.driver", "cp %A %O"]);
  const env = addEnv(repo, base, "a");
  writeFileSync(join(env.path, "db.yml"), "db: local\n");
  git(env.path, ["add", "db.yml"]);
  git(env.path, ["commit", "-m", "feat: A edits db.yml"]);
  const a = git(env.path, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "db.yml"), "db: origin\n");
  git(repo, ["add", "db.yml"]);
  git(repo, ["commit", "-m", "feat: origin edits db.yml"]);
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
  const res = await w.jan.run();
  assert.equal(res.removedCopies, 0);
  assert.equal(w.archivedCalls.length, 0);
  assert.ok(existsSync(env.path));
  assert.equal(res.reported[0]!.reason, "abandoned-unmerged");
  assert.ok(!git(repo, ["branch", "-r", "--contains", a]).includes(a));
});
