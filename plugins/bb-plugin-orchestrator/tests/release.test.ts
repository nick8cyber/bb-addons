import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import {
  parseReleaseConfig,
  resolveProject,
  isCommitIdentity,
} from "../src/release-config.js";
import {
  isAllowed,
  maskSecrets,
  parseAddedLines,
  hasBbIds,
  machineScan,
  runGitleaks,
} from "../src/scan.js";
import {
  parseAuditVerdict,
  reviewVerdictOk,
  docsForChanges,
  runRelease,
  pumpReleases,
  writePushToken,
  type ReleaseDeps,
} from "../src/release.js";
import { parsePolicy } from "../src/policy.js";
import { OrchestratorError } from "../src/errors.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { CmdRunner } from "../src/cmd.js";
import type { ThreadFacts } from "../src/agent-config.js";

const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });
const COORD: ThreadFacts = {
  threadId: "thr_coord",
  parentThreadId: null,
  title: "coord",
  originPluginId: null,
  projectId: "proj_main",
};

const RELEASE_CFG = JSON.stringify({
  commitIdentity: "Agent <agent@x.io>",
  defaults: { target: { action: "push", branch: "main" }, checks: [] },
  projects: { proj_main: {} },
});

const POLICY = JSON.stringify({
  version: 1,
  levels: { "release-audit": { chain: ["ra"], autoFallback: true } },
  routes: { ra: { preset: "ra", provider: "p" } },
});

// ── release-config ─────────────────────────────────────────────────────

test("release config: empty = disabled, invalid JSON = error", () => {
  assert.equal(parseReleaseConfig("").empty, true);
  assert.equal(parseReleaseConfig("{bad").errors.length > 0, true);
  const c = parseReleaseConfig(RELEASE_CFG);
  assert.equal(c.errors.length, 0);
  assert.equal(c.config!.commitIdentity, "Agent <agent@x.io>");
});

test("release config: project fields override defaults and top identity", () => {
  const c = parseReleaseConfig(
    JSON.stringify({
      commitIdentity: "Top <t@x.io>",
      defaults: {
        target: { action: "push", branch: "main" },
        checks: ["a"],
        public: false,
        sync: "merge",
      },
      projects: {
        proj_b: {
          target: { action: "pr", branch: "dev" },
          sync: "rebase",
          commitIdentity: "repo",
          checks: ["make lint"],
          leaks: { machine: "warn", bbIds: "warn", allow: ["docs/PLAN.md"] },
          public: true,
        },
        proj_c: { excluded: true },
      },
    }),
  ).config!;
  const b = resolveProject(c, "proj_b");
  assert.deepEqual(b.target, { action: "pr", branch: "dev" });
  assert.equal(b.sync, "rebase");
  assert.equal(b.commitIdentity, "repo");
  assert.deepEqual(b.checks, ["make lint"]);
  assert.equal(resolveProject(c, "proj_c").excluded, true);
  const d = resolveProject(c, "proj_z");
  assert.deepEqual(d.target, { action: "push", branch: "main" });
  assert.equal(d.leaks.machine, "warn");
  assert.equal(b.leaks.machine, "warn"); // explicit wins over public default
  assert.equal(resolveProject({ ...c, projects: { p: { public: true } } }, "p").leaks.bbIds, "block");
});

test("release config: validation errors carry paths", () => {
  const l = parseReleaseConfig(
    JSON.stringify({
      commitIdentity: "bad",
      projects: { p: { target: { action: "x", branch: "m" }, sync: "ff" } },
    }),
  );
  assert.ok(l.errors.some((e) => e.path === "commitIdentity"));
  assert.ok(l.errors.some((e) => e.path === "projects.p.target.action"));
  assert.ok(l.errors.some((e) => e.path === "projects.p.sync"));
  assert.equal(isCommitIdentity("repo"), true);
  assert.equal(isCommitIdentity("N <n@e.io>"), true);
  assert.equal(isCommitIdentity("no email"), false);
});

// ── scan helpers ───────────────────────────────────────────────────────

test("isAllowed: prefix dir, glob, exact", () => {
  assert.equal(isAllowed("docs/PLAN.md", ["docs/PLAN.md"]), true);
  assert.equal(isAllowed("docs/a/b.md", ["docs/"]), true);
  assert.equal(isAllowed("docs/a/b.md", ["docs/*.md"]), false);
  assert.equal(isAllowed("docs/a/b.md", ["docs/**"]), true);
  assert.equal(isAllowed("src/x.ts", ["docs/"]), false);
});

test("maskSecrets hides values", () => {
  const masked = maskSecrets("token ghp_abcdefghij123456 and PrivateKey = abc123xyz");
  assert.ok(!masked.includes("abcdefghij123456"));
  assert.ok(!masked.includes("abc123xyz"));
  assert.match(masked, /\*\*\*/);
});

test("parseAddedLines tracks file+line of + lines", () => {
  const diff = [
    "diff --git a/f.ts b/f.ts",
    "+++ b/f.ts",
    "@@ -2,0 +3,2 @@",
    "+one",
    "+two",
    "+++ b/g.ts",
    "@@ -0,0 +1 @@",
    "+three",
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [
    { file: "f.ts", line: 3, text: "one" },
    { file: "f.ts", line: 4, text: "two" },
    { file: "g.ts", line: 1, text: "three" },
  ]);
});

const LEAKS = { machine: "block" as const, bbIds: "warn" as const, allow: [] };

const SCAN_BASE = {
  repoPath: "/r",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  commits: [
    {
      sha: "b".repeat(40),
      authorName: "Wrong",
      authorEmail: "w@x.io",
      committerName: "Agent",
      committerEmail: "agent@x.io",
      body: "feat: x\n\nBB-Thread: thr_abc1234567\nCo-Authored-By: bot <b@x>",
    },
  ],
  added: [
    { file: "f.ts", line: 1, text: 'const d = "/home/u/secrets/"' },
    { file: "f.ts", line: 2, text: "see thr_abc1234567" },
    { file: "allow/x.md", line: 1, text: "thr_abc1234567" },
    { file: ".env", line: 1, text: "X=1" },
  ],
  leaks: { ...LEAKS, allow: ["allow/"] },
  allowedAuthor: { name: "Agent", email: "agent@x.io" },
};

const GL_EMPTY: CmdRunner = {
  run: async (file) =>
    file === "gitleaks" ? { exitCode: 7, stdout: "[]", stderr: "" } : ok(),
};

test("machine scan: categories 1-3 always; threadIds on → thr_ exempt (§16.6)", async () => {
  const findings = await machineScan(GL_EMPTY, SCAN_BASE);
  const cat = (n: number) => findings.filter((f) => f.category === n);
  assert.ok(cat(1).some((f) => f.rule === "secret-file" && f.file === ".env"));
  assert.ok(cat(2).some((f) => f.rule === "commit-identity"));
  assert.ok(cat(2).some((f) => f.rule === "foreign-bot-trailer"));
  assert.ok(cat(3).some((f) => f.rule === "home-path"));
  // §16.6 default: thr_ ids are anonymized — no bb-thread-id finding
  // anywhere (diff, allow-listed file or BB-Thread trailer).
  assert.ok(!findings.some((f) => f.rule === "bb-thread-id"));
});

test("machine scan: threadIds off → thr_ a finding incl. BB-Thread trailer", async () => {
  const findings = await machineScan(GL_EMPTY, {
    ...SCAN_BASE,
    threadIds: false,
  });
  const cat = (n: number) => findings.filter((f) => f.category === n);
  // thr_ in the diff is cat 4 (warn) and, with the exemption off, even
  // the BB-Thread trailer line counts — file:null findings exist.
  assert.ok(cat(4).some((f) => f.file === "f.ts"));
  assert.ok(cat(4).some((f) => f.file === null));
  assert.ok(!cat(4).some((f) => f.file === "allow/x.md"));
});

test("gitleaks missing → gitleaks-missing with hint", async () => {
  await assert.rejects(
    runGitleaks(
      { run: async () => ({ exitCode: 127, stdout: "", stderr: "no" }) },
      "/r",
      "a",
      "b",
    ),
    (e: unknown) => (e as OrchestratorError).code === "gitleaks-missing",
  );
});

// ── verdict parsing ────────────────────────────────────────────────────

test("parseAuditVerdict: strict json, fenced, garbage → REJECT", () => {
  assert.deepEqual(
    parseAuditVerdict('{"verdict":"APPROVE","findings":[]}'),
    { verdict: "APPROVE", findings: [], unparseable: false },
  );
  assert.equal(
    parseAuditVerdict('ok:\n```json\n{"verdict":"REJECT","findings":[{"problem":"x"}]}\n```').verdict,
    "REJECT",
  );
  const bad = parseAuditVerdict("I think it is fine");
  assert.equal(bad.verdict, "REJECT");
  assert.equal(bad.unparseable, true);
});

test("reviewVerdictOk: §16.7 strict JSON verdict line", () => {
  // The report ends with {"verdict":"OK"|"CHANGES","blockers":<n>} —
  // prose «ОК» alone no longer counts.
  assert.equal(reviewVerdictOk("ОК. Замечаний нет."), false);
  assert.equal(
    reviewVerdictOk('Замечаний нет\n{"verdict":"OK","blockers":0}'),
    true,
  );
  assert.equal(
    reviewVerdictOk('Итог\n{"verdict":"CHANGES","blockers":2}'),
    false,
  );
  // OK with open blockers is not accepted.
  assert.equal(
    reviewVerdictOk('{"verdict":"OK","blockers":1}'),
    false,
  );
  // PLUG-186: `blockers` is required — an OK without it (or with a
  // non-number) is not accepted.
  assert.equal(reviewVerdictOk('{"verdict":"OK"}'), false);
  assert.equal(reviewVerdictOk('{"verdict":"OK","blockers":"0"}'), false);
  // Last JSON verdict line wins.
  assert.equal(
    reviewVerdictOk(
      '{"verdict":"CHANGES","blockers":1}\n…\n{"verdict":"OK","blockers":0}',
    ),
    true,
  );
});

test("docsForChanges: map prefixes → docs, no map → null", () => {
  assert.deepEqual(
    docsForChanges(["plugins/foo/a.ts"], {
      "plugins/foo/": ["docs/specs/foo.md"],
    }),
    ["docs/specs/foo.md"],
  );
  assert.equal(docsForChanges(["x"], {}), null);
  assert.deepEqual(docsForChanges(["z"], { "plugins/foo/": ["d.md"] }), []);
});

// ── pipeline: runRelease / pumpReleases with a real temp repo ─────────

function gitR(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): { repo: string; remote: string; seed: string } {
  const base = mkdtempSync(join(tmpdir(), "rel-"));
  const remote = join(base, "remote.git");
  const repo = join(base, "wt");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", repo]);
  gitR(repo, ["config", "user.name", "Agent"]);
  gitR(repo, ["config", "user.email", "agent@x.io"]);
  gitR(repo, ["checkout", "-b", "feat-x"]);
  writeFileSync(join(repo, "f.txt"), "hello\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: x"]);
  gitR(repo, ["remote", "add", "origin", remote]);
  // main exists on remote with an older root commit
  execFileSync("git", ["init", join(base, "seed")]);
  const seed = join(base, "seed");
  gitR(seed, ["config", "user.name", "Agent"]);
  gitR(seed, ["config", "user.email", "agent@x.io"]);
  gitR(seed, ["checkout", "-b", "main"]);
  writeFileSync(join(seed, "base.txt"), "base\n");
  gitR(seed, ["add", "."]);
  gitR(seed, ["commit", "-m", "chore: base"]);
  gitR(seed, ["remote", "add", "origin", remote]);
  gitR(seed, ["push", "origin", "main"]);
  gitR(repo, ["fetch", "origin"]);
  // Give the feature branch a real merge-base with main.
  gitR(repo, ["rebase", "origin/main"]);
  return { repo, remote, seed };
}

function makeDeps(repo: string, overrides: Partial<{
  policyText: string;
  releaseText: string;
  comments: unknown[];
  dispatchFail: boolean;
  auditVerdict: string;
  auditStatus: string;
  reviewLevel: string;
  coordPath: string;
  ghCalls: string[][];
  /** Open PRs `gh pr list` reports — a thunk so tests can flip the
   * answer between release rounds. */
  ghPrList: () => unknown[];
  /** §17.3 (мелко 5): the reviewer thread's final output — the verdict
   * fallback when the task carries no verdict comment. */
  reviewThreadOutput: string | null;
  /** §17.3 (ревью PLUG-214): the executor thread's events — the step-1
   * check refuses while a turn is in flight. */
  execEvents: () => unknown[];
}> = {}) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  // executor done + review done-OK — §17.3 (Б4): the review is bound to
  // the round's result sha via `continue_from`. The gate runs
  // `git cat-file -e` on it — a real repo needs a real commit.
  let RESULT_SHA = "f".repeat(40);
  try {
    RESULT_SHA = gitR(repo, ["rev-parse", "HEAD"]);
  } catch { /* fake path — the fake sha stands */ }
  const exec = store.insert({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", level: "complex",
    route: "c", preset: "c", provider: "p",
  });
  store.setThreadInfo(exec.id, "thr_exec");
  store.setStatus(exec.id, "done");
  store.setRoundResult(exec.id, {
    branch: "feat-x", sha: RESULT_SHA, commits: 1, dirty: false,
  });
  const rev = store.insert({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: overrides.reviewLevel ?? "review",
    route: "r", preset: "r", provider: "p",
    continueFrom: RESULT_SHA,
  });
  store.setThreadInfo(rev.id, "thr_rev");
  store.setStatus(rev.id, "done");
  /** Re-bind a review's sha — merged tests point it at `merged_sha`. */
  const bindReview = (sha: string, id = rev.id) =>
    db.prepare("UPDATE delegations SET continue_from = ? WHERE id = ?")
      .run(sha, id);
  const calls: string[][] = [];
  const comments: string[] = [];
  const sent: string[] = [];
  const bbCli: BbCli = {
    run: async (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key.startsWith("tasks show"))
        return ok(JSON.stringify({
          task: { key: args[2] ?? "PLUG-1", title: "do x", status: "in_review" },
          comments: overrides.comments ?? [
            {
              kind: "agent",
              threadId: "thr_rev",
              body: 'ОК, замечаний нет\n{"verdict":"OK","blockers":0}',
              createdAt: "2026-01-01",
            },
          ],
        }));
      if (key.startsWith("tasks comment")) {
        comments.push(args[args.length - 1]!);
        return ok();
      }
      if (key.startsWith("tasks dispatch"))
        return overrides.dispatchFail
          ? { exitCode: 1, stdout: "", stderr: "boom" }
          : ok(JSON.stringify({ threadId: "thr_audit" }));
      if (key.startsWith("tasks preset show"))
        return ok(JSON.stringify({ preset: { permissionMode: "auto" } }));
      if (key.startsWith("thread options"))
        return ok(JSON.stringify({ options: [] }));
      return ok();
    },
  };
  const threads = {
    get: async ({ threadId }: { threadId: string }) =>
      threadId === "thr_exec"
        ? { id: threadId, environmentPath: repo, environmentBranchName: "feat-x", parentThreadId: null }
        : threadId === "thr_coord" && overrides.coordPath
          ? { id: threadId, environmentPath: overrides.coordPath, environmentBranchName: null, parentThreadId: null }
          : { id: threadId, parentThreadId: null, title: null, originPluginId: null, projectId: "proj_main" },
    send: async (a: { threadId: string; input: unknown[] }) => {
      sent.push((a.input[0] as { text: string }).text);
      return {};
    },
    events: {
      list: async (a: { threadId?: string }) =>
        a?.threadId === "thr_exec" && overrides.execEvents !== undefined
          ? overrides.execEvents()
          : overrides.auditVerdict !== undefined
            ? [{
                seq: 9, type: "item/completed", createdAt: 1,
                data: { item: { type: "agentMessage", text: overrides.auditVerdict } },
              }]
            : [],
    },
    output: async ({ threadId }: { threadId: string }) =>
      threadId === "thr_rev"
        ? { output: overrides.reviewThreadOutput ?? null }
        : { output: null },
  };
  const tmp = mkdtempSync(join(tmpdir(), "hooks-"));
  const deps = {
    store, bbCli, threads: threads as never,
    cmd: { run: async (file: string, args: string[], o?: { cwd?: string }) => {
      if (file === "gitleaks") return { exitCode: 0, stdout: "", stderr: "" };
      if (file === "gh") {
        overrides.ghCalls?.push(args);
        if (args[0] === "pr" && args[1] === "list")
          return {
            exitCode: 0,
            stdout: JSON.stringify(overrides.ghPrList?.() ?? []),
            stderr: "",
          };
        // §17.3 (Б1): `gh pr create` prints the URL as plain text, not
        // JSON — the mock returns the real output format.
        if (args[0] === "pr" && args[1] === "create")
          return {
            exitCode: 0,
            stdout: "https://example.test/pr/7\n",
            stderr: "",
          };
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      try {
        const out = execFileSync(file, args, {
          cwd: o?.cwd, encoding: "utf8",
        });
        return { exitCode: 0, stdout: out, stderr: "" };
      } catch (e: unknown) {
        const x = e as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: x.status ?? 1, stdout: x.stdout ?? "", stderr: x.stderr ?? "" };
      }
    } } as CmdRunner,
    stepsDeps: {
      store, bbCli,
      threads: {
        update: async () => ({}),
        stop: async () => ({}),
        updatePluginMetadata: async () => ({}),
      },
    },
    loadPolicy: async () => parsePolicy(overrides.policyText ?? POLICY),
    loadReleaseConfig: () =>
      parseReleaseConfig(overrides.releaseText ?? RELEASE_CFG),
    probes: {
      delegationByThreadId: (id: string) => store.byThreadId(id),
      hasFreshDispatching: () => false,
      roleByThreadId: (id: string) =>
        id === "thr_coord" ? "orchestrator" : undefined,
    },
    hooksDir: () => tmp,
    packetDir: () => mkdtempSync(join(tmpdir(), "pkt-")),
    enqueue: <T>(f: () => Promise<T>) => f(),
    log: {},
  } satisfies ReleaseDeps;
  return { deps, store, calls, comments, sent, tmp, exec, rev, bindReview };
}

test("release: refuses without release config / level / coordinator", async () => {
  const { deps } = makeDeps("/tmp/none");
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD, }, { ...deps, loadReleaseConfig: () => parseReleaseConfig("") }),
    (e: unknown) => (e as OrchestratorError).code === "release-disabled",
  );
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, {
      ...deps,
      loadPolicy: async () =>
        parsePolicy(JSON.stringify({ version: 1, levels: { simple: { chain: ["s"] } }, routes: { s: { preset: "s", provider: "p" } } })),
    }),
    (e: unknown) => (e as OrchestratorError).code === "release-level-missing",
  );
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: { ...COORD, threadId: "thr_other", parentThreadId: "p" } }, deps),
    (e: unknown) => (e as OrchestratorError).code === "not-a-coordinator",
  );
});

test("release happy path: приёмка → sync → скан → аудит раздан", async () => {
  const { repo } = makeRepo();
  // branch off main so merge-base exists
  const { deps, store, calls } = makeDeps(repo);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
  const row = store.getRelease(res.releaseId)!;
  assert.equal(row.status, "auditing");
  assert.equal(row.target_action, "push");
  assert.ok(calls.some((c) => c.join(" ").startsWith("tasks dispatch PLUG-1")));
  const audit = store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!;
  assert.equal(audit.status, "running");
  assert.equal(store.threadRole("thr_audit")?.role, "release-auditor");
});

test("release: scan finding (cat 2 identity) refuses before audit", async () => {
  const { repo } = makeRepo();
  const { deps, store, calls } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "Other <o@x.io>",
      defaults: { target: { action: "push", branch: "main" } },
    }),
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /commit-identity|личность/.test((e as OrchestratorError).message),
  );
  assert.ok(!calls.some((c) => c.join(" ").startsWith("tasks dispatch")));
  assert.equal(store.releasesByStatuses(["auditing"]).length, 0);
});

test("release: dirty worktree refuses (step 2)", async () => {
  const { repo } = makeRepo();
  writeFileSync(join(repo, "dirty.txt"), "x");
  const { deps } = makeDeps(repo);
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => /незакоммиченные/.test((e as OrchestratorError).message),
  );
});

test("release: not-OK review refuses at step 1", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo, {
    comments: [
      {
        kind: "agent",
        threadId: "thr_rev",
        body: 'ЕСТЬ ЗАМЕЧАНИЯ: …\n{"verdict":"CHANGES","blockers":2}',
        createdAt: "x",
      },
    ],
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => /не «OK»/.test((e as OrchestratorError).message),
  );
});

test("pump: REJECT verdict → rejected + coordinator message", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"REJECT","findings":[{"file":"f.ts","line":1,"problem":"leak ghp_abcdef123456","fix":"remove"}]}',
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const audit = store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!;
  store.setStatus(audit.id, "done");
  const s = await pumpReleases(deps);
  assert.equal(s.rejected, 1);
  assert.equal(store.list()[0] && store.releasesByStatuses(["rejected"]).length, 1);
  assert.ok(sent.some((m) => m.includes("REJECT")));
  assert.ok(!sent.some((m) => m.includes("ghp_abcdef123456"))); // masked
});

test("pump: APPROVE → push to target, token consumed, task done", async () => {
  const { repo, remote } = makeRepo();
  const { deps, store, calls, tmp } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const audit = store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!;
  store.setStatus(audit.id, "done");
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  const rel = store.releasesByStatuses(["published"])[0]!;
  // remote actually received the commit
  const remoteLog = execFileSync("git", ["--git-dir", remote, "log", "--format=%H", "-1", "main"], { encoding: "utf8" }).trim();
  assert.equal(remoteLog, rel.head_sha);
  assert.ok(calls.some((c) => c.join(" ").includes("--status done")));
});

test("pump: audit chain exhausted → failed + message", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo);
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const audit = store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!;
  store.setStatus(audit.id, "failed");
  const s = await pumpReleases(deps);
  assert.equal(s.failed, 1);
  assert.ok(sent.some((m) => /исчерпана/.test(m)));
});

test("push token file: branch+sha+expiry, one file per run (§16.6)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tok-"));
  const file = writePushToken(dir, "abc123", "main");
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(data.sha, "abc123");
  assert.equal(data.branch, "main");
  assert.ok(data.expiresAt > Date.now());
  assert.match(file, /push-token-[0-9a-f]+\.json$/);
  // two runs — two files, nothing clobbered
  const file2 = writePushToken(dir, "def456", "dev");
  assert.notEqual(file, file2);
  assert.ok(readFileSync(file, "utf8").includes("abc123"));
});

// ── review findings 1–9 ────────────────────────────────────────────────

test("f1: allow does NOT suppress categories 1-2", async () => {
  const cmd: CmdRunner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  const findings = await machineScan(cmd, {
    repoPath: "/r", baseSha: "a".repeat(40), headSha: "b".repeat(40),
    commits: [],
    added: [
      { file: "docs/PLAN.md", line: 1, text: "vless://srv/x y@gmail.com" },
      { file: "docs/PLAN.md", line: 2, text: "thr_abc1234567" },
    ],
    leaks: { machine: "block", bbIds: "warn", allow: ["docs/"] },
  });
  assert.ok(findings.some((f) => f.category === 1));
  assert.ok(findings.some((f) => f.category === 2 && f.rule === "personal-email"));
  assert.ok(!findings.some((f) => f.category === 4));
});

test("f2: maskSecrets applied to fix and file fields", async () => {
  const { repo } = makeRepo();
  const { deps, sent, store } = makeDeps(repo, {
    auditVerdict: '{"verdict":"REJECT","findings":[{"file":"f ghp_abcdef1234567890","problem":"p sk-abcdefghijklmnop1234","fix":"use ghp_abcdef1234567890"}]}',
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  store.setStatus(store.latestDelegationByTaskAndLevel("PLUG-1","release-audit")!.id, "done");
  await pumpReleases(deps);
  assert.ok(sent.length && !sent.some((m) => m.includes("ghp_abcdef1234567890") || m.includes("sk-abcdefghijklmnop1234")));
});

test("f3: gitInstructions + roles forbid bypass flags", async () => {
  const { DEFAULT_GIT_INSTRUCTIONS } = await import("../src/instructions.js");
  assert.match(DEFAULT_GIT_INSTRUCTIONS, /--no-verify/);
  assert.match(DEFAULT_GIT_INSTRUCTIONS, /core\.hooksPath/);

});

test("f8: shaWasReleased counts only published releases", () => {
  const { store } = makeDeps("/tmp/x");
  const r = store.insertRelease({
    taskKey: "PLUG-9", projectId: "p", coordinatorThreadId: "t",
    repoPath: "/r", branch: "b", targetAction: "push", targetBranch: "main",
  });
  store.updateRelease(r.id, { headSha: "abc", status: "rejected" });
  assert.equal(store.shaWasReleased("abc"), false);
  store.updateRelease(r.id, { status: "published", publishedSha: "abc" });
  assert.equal(store.shaWasReleased("abc"), true);
});

test("f9: task-key template flags PLUG-123, not UTF-8", async () => {
  const cmd: CmdRunner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  const findings = await machineScan(cmd, {
    repoPath: "/r", baseSha: "a".repeat(40), headSha: "b".repeat(40),
    commits: [],
    added: [
      { file: "a.md", line: 1, text: "see PLUG-123" },
      { file: "b.md", line: 1, text: 'charset="UTF-8"' },
    ],
    leaks: { machine: "block", bbIds: "warn", allow: [] },
    // §16.6: the template itself is tested — `threadIds` off, else
    // task-key is exempt like `thr_…` (PLUG-189).
    threadIds: false,
  });
  const keys = findings.filter((f) => f.rule === "task-key");
  assert.equal(keys.length, 1);
  assert.equal(keys[0]!.file, "a.md");
});

// ── N1: non-string verdict finding fields → rejected, not failed ──────

test("N1: parseAuditVerdict coerces numeric/missing finding fields", () => {
  const v = parseAuditVerdict(
    '{"verdict":"REJECT","findings":[{"category":2,"file":123,"line":"x","problem":"leak","fix":42},{"problem":"g"}],"extra":true}',
  );
  assert.equal(v.verdict, "REJECT");
  assert.equal(v.unparseable, false);
  assert.equal(v.findings.length, 2);
  const f = v.findings[0]!;
  assert.strictEqual(f.category, "2");
  assert.strictEqual(f.file, "123");
  assert.equal(f.line, undefined); // "x" is not finite
  assert.strictEqual(f.fix, "42");
  // findings not an array → empty list, still parses
  const v2 = parseAuditVerdict('{"verdict":"REJECT","findings":"oops"}');
  assert.equal(v2.verdict, "REJECT");
  assert.equal(v2.findings.length, 0);
});

test("N1: pump on non-string verdict fields → rejected, no exception", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict:
      '{"verdict":"REJECT","findings":[{"category":2,"file":123,"line":"x","problem":"leak ghp_abcdef1234567890","fix":42}]}',
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s = await pumpReleases(deps);
  assert.equal(s.rejected, 1);
  assert.equal(s.failed, 0);
  assert.equal(store.releasesByStatuses(["rejected"]).length, 1);
  assert.equal(store.releasesByStatuses(["failed"]).length, 0);
  assert.ok(sent.some((m) => m.includes("REJECT")));
  // still masked even through coercion
  assert.ok(!sent.some((m) => m.includes("ghp_abcdef1234567890")));
});


// ── §2.3 r24: reviews on any auditor-role level count at step 1 ──────

test("release step 1: a review on an arbitrary auditor level counts", async () => {
  const { repo } = makeRepo();
  const policy = JSON.stringify({
    version: 1,
    levels: {
      "release-audit": { chain: ["ra"], autoFallback: true },
      "review-mid": { role: "auditor", chain: ["ra"] },
      complex: { chain: ["ra"] },
    },
    routes: { ra: { preset: "ra", provider: "p" } },
  });
  const { deps } = makeDeps(repo, {
    policyText: policy,
    reviewLevel: "review-mid",
  });
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

test("release step 1: auditor-level rows never count as executor work", async () => {
  const { repo } = makeRepo();
  // "complex" is declared auditor here — its done row must not satisfy
  // the executor requirement.
  const policy = JSON.stringify({
    version: 1,
    levels: {
      "release-audit": { chain: ["ra"], autoFallback: true },
      complex: { role: "auditor", chain: ["ra"] },
    },
    routes: { ra: { preset: "ra", provider: "p" } },
  });
  const { deps } = makeDeps(repo, { policyText: policy });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      /нет делегирования/.test((e as OrchestratorError).message),
  );
});

// ── §16.6 r25: publishable branch, -m, per-commit scan, threadIds ──────

test("release: merged round publishes merged_into from coordinator copy", async () => {
  const { remote } = makeRepo();
  const base = mkdtempSync(join(tmpdir(), "rel-coord-"));
  const coord = join(base, "coord");
  execFileSync("git", ["clone", "--branch", "main", remote, coord]);
  gitR(coord, ["config", "user.name", "Agent"]);
  gitR(coord, ["config", "user.email", "agent@x.io"]);
  gitR(coord, ["checkout", "-b", "work"]);
  writeFileSync(join(coord, "merged.txt"), "merged\n");
  gitR(coord, ["add", "."]);
  gitR(coord, ["commit", "-m", "feat: merged result"]);
  // Executor env deliberately absent — a merged result must come from
  // the coordinator's copy, not the executor's.
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  const mergedSha = gitR(coord, ["rev-parse", "HEAD"]);
  store.setMerged(exec.id, {
    into: "work",
    sha: mergedSha,
  });
  bindReview(mergedSha);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const row = store.getRelease(res.releaseId)!;
  assert.equal(row.branch, "work");
  assert.equal(row.repo_path, coord);
  assert.equal(res.status, "auditing");
});

test("release: sync merge message carries no branch names or ids (§16.6)", async () => {
  const { repo, seed } = makeRepo();
  // Advance main so the sync step must create a merge commit.
  writeFileSync(join(seed, "new.txt"), "new\n");
  gitR(seed, ["add", "."]);
  gitR(seed, ["commit", "-m", "chore: more"]);
  gitR(seed, ["push", "origin", "main"]);
  const { deps } = makeDeps(repo);
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const msg = gitR(repo, ["log", "-1", "--format=%B"]);
  assert.match(msg, /^merge [0-9a-f]{7}\s*$/);
  assert.ok(!/feat-x|origin\/main|thr_/.test(msg));
});

test("release: leak added and removed inside the range is still caught (§16.6)", async () => {
  const { repo } = makeRepo();
  writeFileSync(join(repo, "leak.txt"), "path /home/someone/secret\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "wip: leak"]);
  execFileSync("rm", [join(repo, "leak.txt")]);
  gitR(repo, ["add", "-A"]);
  gitR(repo, ["commit", "-m", "wip: cleanup"]);
  const { deps } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "push", branch: "main" },
        leaks: { machine: "block" },
      },
    }),
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /привязка|home-path/.test((e as OrchestratorError).message),
  );
});

test("release config: threadIds parses, defaults true, validates (§16.6)", () => {
  const c = parseReleaseConfig(
    JSON.stringify({
      defaults: { threadIds: false },
      projects: { p1: { threadIds: true }, p2: {} },
    }),
  );
  assert.equal(c.errors.length, 0);
  assert.equal(resolveProject(c.config!, "p1").threadIds, true);
  assert.equal(resolveProject(c.config!, "p2").threadIds, false);
  assert.equal(resolveProject(c.config!, "unknown").threadIds, false);
  const bad = parseReleaseConfig(
    JSON.stringify({ projects: { p: { threadIds: "yes" } } }),
  );
  assert.ok(bad.errors.some((e) => e.path === "projects.p.threadIds"));
});

test("pump: «Источник» line follows threadIds; repeat release on own PR (§16.6)", async () => {
  const publish = async (threadIds: boolean) => {
    const { repo } = makeRepo();
    const ghCalls: string[][] = [];
    const { deps, store } = makeDeps(repo, {
      ghCalls,
      auditVerdict: '{"verdict":"APPROVE","findings":[]}',
      releaseText: JSON.stringify({
        commitIdentity: "Agent <agent@x.io>",
        defaults: {
          target: { action: "pr", branch: "main" },
          threadIds,
        },
      }),
    });
    await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
    const audit = store.latestDelegationByTaskAndLevel(
      "PLUG-1",
      "release-audit",
    )!;
    store.setStatus(audit.id, "done");
    const s = await pumpReleases(deps);
    assert.equal(s.published, 1);
    const create = ghCalls.find(
      (a) => a[0] === "pr" && a[1] === "create",
    )!;
    return {
      body: create[create.indexOf("--body") + 1]!,
      head: create[create.indexOf("--head") + 1]!,
      args: create,
    };
  };
  const on = await publish(true);
  assert.match(on.body, /Источник: bb тред thr_coord/);
  assert.match(on.body, /Задача: PLUG-1/);
  assert.equal(on.head, "feat-x"); // local executor branch published as-is
  const off = await publish(false);
  // §16.6: with threadIds off nothing bb-identifiable reaches the remote
  // — no «Источник», no «Задача: <KEY>», a neutral release/<sha7> head.
  assert.doesNotMatch(off.body, /Источник|Задача/);
  assert.match(off.head, /^release\/[0-9a-f]{7}$/);
});

// ── §16.6 (PLUG-189): coordinator-copy lock/restore, neutral publish ──

/** A coordinator copy: clone on `main`, task result committed on `work`
 * (the merged_into branch). */
function makeMergedCoordinatorCopy(): {
  coord: string;
  workTip: string;
  seed: string;
} {
  const { remote, seed } = makeRepo();
  const base = mkdtempSync(join(tmpdir(), "rel-coord-"));
  const coord = join(base, "coord");
  execFileSync("git", ["clone", "--branch", "main", remote, coord]);
  gitR(coord, ["config", "user.name", "Agent"]);
  gitR(coord, ["config", "user.email", "agent@x.io"]);
  gitR(coord, ["checkout", "-b", "work"]);
  writeFileSync(join(coord, "merged.txt"), "merged\n");
  gitR(coord, ["add", "."]);
  gitR(coord, ["commit", "-m", "feat: merged result"]);
  const workTip = gitR(coord, ["rev-parse", "HEAD"]);
  // The coordinator's own position — another branch with its own commit.
  gitR(coord, ["checkout", "-b", "work-2"]);
  writeFileSync(join(coord, "own.txt"), "own\n");
  gitR(coord, ["add", "."]);
  gitR(coord, ["commit", "-m", "coord own work"]);
  return { coord, workTip, seed };
}

test("release (merged): copy restored to original branch+HEAD, lock gone", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  const originalHead = gitR(coord, ["rev-parse", "HEAD"]);
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
  // §16.6: the copy is back on work-2 at its original commit, clean.
  assert.equal(gitR(coord, ["symbolic-ref", "--short", "HEAD"]), "work-2");
  assert.equal(gitR(coord, ["rev-parse", "HEAD"]), originalHead);
  assert.equal(gitR(coord, ["status", "--porcelain"]), "");
  const gitDir = gitR(coord, ["rev-parse", "--absolute-git-dir"]);
  assert.equal(
    existsSync(join(gitDir, "orchestrator-merge.lock")),
    false,
  );
});

test("release (merged): dirty copy refuses BEFORE the switch", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  writeFileSync(join(coord, "dirty.txt"), "x"); // uncommitted
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => (e as OrchestratorError).code === "dirty-coordinator",
  );
  // The dirty copy was never moved onto `work`.
  assert.equal(gitR(coord, ["symbolic-ref", "--short", "HEAD"]), "work-2");
});

test("release (merged): same lock as merge — held lock refuses", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  const gitDir = gitR(coord, ["rev-parse", "--absolute-git-dir"]);
  // A live lock (this process stands in for a running merge/release).
  writeFileSync(
    join(gitDir, "orchestrator-merge.lock"),
    `${process.pid}\n${new Date().toISOString()}\n`,
  );
  try {
    await assert.rejects(
      runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
      (e: unknown) =>
        (e as OrchestratorError).code === "merge-in-progress",
    );
    assert.equal(
      gitR(coord, ["symbolic-ref", "--short", "HEAD"]),
      "work-2",
    );
  } finally {
    execFileSync("rm", ["-f", join(gitDir, "orchestrator-merge.lock")]);
  }
});

test("release (merged): restore failure → copy-not-restored", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  const realRun = deps.cmd.run;
  deps.cmd = {
    run: async (file, args, o) => {
      const res = await realRun(file, args, o);
      // Once the pipeline moves the copy onto `work`, `work-2` is
      // deleted behind its back — the restore switch must fail.
      if (file === "git" && args[2] === "switch" && args[3] === "work") {
        gitR(coord, ["branch", "-D", "work-2"]);
      }
      return res;
    },
  };
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => (e as OrchestratorError).code === "copy-not-restored",
  );
});

test("release: audit instructions bind the sha, not the copy's branch", async () => {
  const { repo } = makeRepo();
  const { deps, store, calls } = makeDeps(repo);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const headSha = store.getRelease(res.releaseId)!.head_sha!;
  const dispatch = calls.find(
    (c) => c[0] === "tasks" && c[1] === "dispatch",
  )!;
  const instructions = dispatch[dispatch.indexOf("--instructions") + 1]!;
  assert.ok(instructions.includes(headSha));
});

test("release: stale installed hook refuses with reinstall hint", async () => {
  const { repo } = makeRepo();
  const { deps, tmp } = makeDeps(repo);
  writeFileSync(join(tmp, "pre-push"), "#!/bin/sh\n# outdated hook\n");
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "hook-stale" &&
      /install\.mjs/.test((e as OrchestratorError).hint ?? ""),
  );
});

/** Install the full wrapper set into `dir` — pre-push is the gate,
 * every other name is a byte-copy of `chain` (what install.mjs does). */
function installAllWrappers(dir: string) {
  const src = new URL("../hooks", import.meta.url).pathname;
  const names = readFileSync(join(src, "hook-names"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const n of names) {
    cpSync(join(src, n === "pre-push" ? "pre-push" : "chain"), join(dir, n));
  }
  return names;
}

test("release: up-to-date installed hook passes the freshness check", async () => {
  const { repo } = makeRepo();
  const { deps, tmp } = makeDeps(repo);
  installAllWrappers(tmp);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

test("§17.3 (ревью PLUG-210): a missing wrapper is stale — a partial install refuses", async () => {
  const { repo } = makeRepo();
  const { deps, tmp } = makeDeps(repo);
  // a pre-r26 install: real pre-push, none of the other wrappers
  cpSync(
    new URL("../hooks/pre-push", import.meta.url).pathname,
    join(tmp, "pre-push"),
  );
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "hook-stale" &&
      /install\.mjs/.test((e as OrchestratorError).hint ?? ""),
  );
});

test("machine scan: threadIds governs task-key too (§16.6)", async () => {
  const input = {
    ...SCAN_BASE,
    commits: [
      {
        sha: "b".repeat(40),
        authorName: "Agent",
        authorEmail: "agent@x.io",
        committerName: "Agent",
        committerEmail: "agent@x.io",
        body: "merge PLUG-1 r2 (abc1234)",
      },
    ],
    added: [
      { file: "m.ts", line: 1, text: "note: merge PLUG-1 r2 (abc1234)" },
    ],
  };
  // The pipeline's own merge commit (§14) is not a finding while
  // threadIds is on.
  const on = await machineScan(GL_EMPTY, input);
  assert.ok(!on.some((f) => f.rule === "task-key"));
  const off = await machineScan(GL_EMPTY, { ...input, threadIds: false });
  assert.ok(off.some((f) => f.rule === "task-key"));
});

test("parseAddedLines: combined @@@ hunks — only all-+ columns scan", () => {
  const diff = [
    "diff --combined f.ts",
    "index 1111111,2222222..3333333",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@@ -1,3 -1,3 +1,4 @@@",
    "++added-by-merge",
    " -not-in-result",
    "+ already-in-parent1",
    "  context-line",
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [
    { file: "f.ts", line: 1, text: "added-by-merge" },
  ]);
});

test("f7: prWasReleased is scoped to the coordinator", () => {
  const { store } = makeDeps("/tmp/x");
  const r = store.insertRelease({
    taskKey: "PLUG-9",
    projectId: "p",
    coordinatorThreadId: "thr_a",
    repoPath: "/r",
    branch: "b",
    targetAction: "pr",
    targetBranch: "main",
  });
  store.updateRelease(r.id, { prUrl: "https://x.test/pr/1" });
  assert.equal(store.prWasReleased("https://x.test/pr/1", "thr_a"), true);
  assert.equal(store.prWasReleased("https://x.test/pr/1", "thr_b"), false);
});

// ── §16.6 (PLUG-191): hunk counting, neutral title, stable branch ─────

test("parseAddedLines: +++ inside a hunk is content, not a file header", () => {
  // PLUG-191 finding 2: an added line `++ /dev/null` prints as
  // `+++ /dev/null`; the old parser read it as a deleted-file header and
  // dropped the rest of the file. The hunk's own `+N,M` count bounds it.
  const diff = [
    "diff --git a/g.txt b/g.txt",
    "--- a/g.txt",
    "+++ b/g.txt",
    "@@ -0,0 +1,3 @@",
    "+++ /dev/null",
    "+++ b/docs/PLAN.md",
    "+/home/after/z",
    "diff --git a/h.txt b/h.txt",
    "+++ b/h.txt",
    "@@ -0,0 +1 @@",
    "+x",
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [
    { file: "g.txt", line: 1, text: "++ /dev/null" },
    { file: "g.txt", line: 2, text: "++ b/docs/PLAN.md" },
    { file: "g.txt", line: 3, text: "/home/after/z" },
    { file: "h.txt", line: 1, text: "x" },
  ]);
});

test("pump: threadIds=false — PR title is the HEAD subject, never a task key", async () => {
  const { repo } = makeRepo();
  const ghCalls: string[][] = [];
  const { deps, store } = makeDeps(repo, {
    ghCalls,
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "pr", branch: "main" },
        threadIds: false,
      },
    }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  const create = ghCalls.find((a) => a[0] === "pr" && a[1] === "create")!;
  const title = create[create.indexOf("--title") + 1]!;
  // §16.6: HEAD-commit subject — never the tracker title («do x») or key.
  assert.equal(title, gitR(repo, ["log", "-1", "--format=%s"]));
  assert.notEqual(title, "do x");
  assert.doesNotMatch(title, /[A-Z][A-Z0-9]+-\d+/);
});

test("pump: threadIds=false — repeat release reuses the first release/<sha7>", async () => {
  const { repo, remote } = makeRepo();
  const ghCalls: string[][] = [];
  const { deps, store, exec, bindReview } = makeDeps(repo, {
    ghCalls,
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "pr", branch: "main" },
        threadIds: false,
      },
    }),
  });
  const round = async () => {
    await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
    store.setStatus(
      store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
      "done",
    );
    const s = await pumpReleases(deps);
    assert.equal(s.published, 1);
  };
  await round();
  const create = ghCalls.find((a) => a[0] === "pr" && a[1] === "create")!;
  const branch = create[create.indexOf("--head") + 1]!;
  assert.match(branch, /^release\/[0-9a-f]{7}$/);
  assert.equal(
    store.releasesByStatuses(["published"])[0]!.publish_branch,
    branch,
  );
  // A repeat release has a DIFFERENT head — the branch must stay the
  // recorded one anyway (§16.6: one branch and one PR per task). The
  // §17.3 gate binds it as the round's reviewed result.
  writeFileSync(join(repo, "more.txt"), "more\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: more"]);
  const newHead = gitR(repo, ["rev-parse", "HEAD"]);
  store.setRoundResult(exec.id, {
    branch: "feat-x", sha: newHead, commits: 2, dirty: false,
  });
  bindReview(newHead);
  assert.notEqual(newHead.slice(0, 7), branch.slice("release/".length));
  await round();
  const remoteTip = execFileSync(
    "git",
    ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`],
    { encoding: "utf8" },
  ).trim();
  const rows = store.releasesByStatuses(["published"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.publish_branch, branch);
  assert.equal(remoteTip, rows[1]!.head_sha);
});

test("release (merged): a failing project check restores the copy (PLUG-191)", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  const originalHead = gitR(coord, ["rev-parse", "HEAD"]); // work-2 tip
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "push", branch: "main" },
        checks: ["exit 1"],
      },
    }),
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => /проверка проекта упала/.test((e as Error).message),
  );
  // the copy went back to work-2 at its commit, clean, lock released
  assert.equal(gitR(coord, ["symbolic-ref", "--short", "HEAD"]), "work-2");
  assert.equal(gitR(coord, ["rev-parse", "HEAD"]), originalHead);
  assert.equal(gitR(coord, ["status", "--porcelain"]), "");
  const gitDir = gitR(coord, ["rev-parse", "--absolute-git-dir"]);
  assert.equal(existsSync(join(gitDir, "orchestrator-merge.lock")), false);
});

/** A deferred gate: `entered` fires when the wrapped git call starts,
 * `open` releases it. Used to hold a release mid-run inside the lock. */
function fetchGate(deps: { cmd: CmdRunner }) {
  let open!: () => void;
  let mark!: () => void;
  const entered = new Promise<void>((r) => {
    mark = r;
  });
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let once = true;
  const realRun = deps.cmd.run;
  deps.cmd = {
    run: async (file, args, o) => {
      if (once && file === "git" && args[2] === "fetch") {
        once = false;
        mark();
        await gate;
      }
      return realRun(file, args, o);
    },
  };
  return { entered, open };
}

test("release: two parallel runs in the executor worktree — second refused", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo);
  const gate = fetchGate(deps);
  const slow = runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await gate.entered;
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => (e as OrchestratorError).code === "merge-in-progress",
  );
  gate.open();
  assert.equal((await slow).status, "auditing");
});

test("release (merged): two releases of different tasks into one coordinator copy", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  // A second task whose round was also merged into the same copy.
  const exec2 = store.insert({
    taskKey: "PLUG-2",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "c",
    preset: "c",
    provider: "p",
  });
  store.setThreadInfo(exec2.id, "thr_exec");
  store.setStatus(exec2.id, "done");
  store.setMerged(exec2.id, { into: "work", sha: workTip });
  const rev2 = store.insert({
    taskKey: "PLUG-2",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "r",
    preset: "r",
    provider: "p",
  });
  store.setThreadInfo(rev2.id, "thr_rev");
  store.setStatus(rev2.id, "done");
  bindReview(workTip, rev2.id);
  const gate = fetchGate(deps);
  const slow = runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await gate.entered;
  await assert.rejects(
    runRelease({ taskKey: "PLUG-2", caller: COORD }, deps),
    (e: unknown) => (e as OrchestratorError).code === "merge-in-progress",
  );
  gate.open();
  assert.equal((await slow).status, "auditing");
  // the first release's copy came back to its own branch
  assert.equal(gitR(coord, ["symbolic-ref", "--short", "HEAD"]), "work-2");
});

test("release (merged): lock records EMPTY head on the publish branch (PLUG-191)", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  // The copy already sits on merged_into — the sync merge legitimately
  // moves its tip, so the lock must not pin a HEAD it can never match.
  gitR(coord, ["checkout", "work"]);
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  const gitDir = gitR(coord, ["rev-parse", "--absolute-git-dir"]);
  const lock = join(gitDir, "orchestrator-merge.lock");
  const gate = fetchGate(deps);
  const pending = runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await gate.entered;
  const recorded = readFileSync(lock, "utf8").split("\n");
  assert.equal(recorded[2], "work");
  assert.equal(recorded[3], ""); // branch+clean only on restore
  gate.open();
  assert.equal((await pending).status, "auditing");
  assert.equal(gitR(coord, ["symbolic-ref", "--short", "HEAD"]), "work");
  assert.equal(existsSync(lock), false);
});

// ── §16.6 (PLUG-194): release/… names only, neutral title, merged sync ──

test("hasBbIds: thr_ and task-key hit, plain subject does not (PLUG-194)", () => {
  assert.equal(hasBbIds("fix: rework (PLUG-187)"), true);
  assert.equal(hasBbIds("wip: notes for thr_abc1234567"), true);
  assert.equal(hasBbIds("see proj_abc1234567"), true);
  assert.equal(hasBbIds('charset="UTF-8"'), false);
  assert.equal(hasBbIds("feat: add a thing"), false);
});

test("pump: threadIds true→false — the executor branch is never published (PLUG-194)", async () => {
  const { repo } = makeRepo();
  const ghCalls: string[][] = [];
  let threadIds = true;
  const { deps, store, exec, bindReview } = makeDeps(repo, {
    ghCalls,
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
  });
  deps.loadReleaseConfig = () =>
    parseReleaseConfig(
      JSON.stringify({
        commitIdentity: "Agent <agent@x.io>",
        defaults: { target: { action: "pr", branch: "main" }, threadIds },
      }),
    );
  const round = async () => {
    await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
    store.setStatus(
      store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
      "done",
    );
    const s = await pumpReleases(deps);
    assert.equal(s.published, 1);
  };
  await round();
  // §17.3 (С4): the publish branch IS recorded so the repeat release
  // reuses it — but an executor-branch name is only reusable while
  // threadIds stays on; `releasePublishBranch` keeps yielding only
  // `release/…` names.
  const first = store.releasesByStatuses(["published"])[0]!;
  assert.equal(first.publish_branch, "feat-x");
  // the reuse filter takes only `release/…` names — `feat-x` recorded
  // while threadIds was on must never be reused (PLUG-194).
  assert.equal(store.lastPublishBranch("PLUG-1"), "feat-x");
  // The project flips to no-ids: the next release publishes a neutral
  // release/<sha7>, not `feat-x`.
  threadIds = false;
  writeFileSync(join(repo, "more.txt"), "more\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: more"]);
  // §17.3 gate: the new round's tip is the reviewed result.
  const tip = gitR(repo, ["rev-parse", "HEAD"]);
  store.setRoundResult(exec.id, {
    branch: "feat-x", sha: tip, commits: 2, dirty: false,
  });
  bindReview(tip);
  await round();
  const creates = ghCalls.filter((a) => a[0] === "pr" && a[1] === "create");
  assert.equal(creates.length, 2);
  assert.equal(creates[0]![creates[0]!.indexOf("--head") + 1], "feat-x");
  const second = creates[1]![creates[1]!.indexOf("--head") + 1]!;
  assert.match(second, /^release\/[0-9a-f]{7}$/);
  assert.equal(
    store.releasesByStatuses(["published"])[1]!.publish_branch,
    second,
  );
});

test("pump: threadIds=false — HEAD subject with a task key → release <sha7> (PLUG-194)", async () => {
  const { repo } = makeRepo();
  const ghCalls: string[][] = [];
  // §16.6: the subject carries a tracker key — under bbIds=warn it is
  // only a warning, yet the PR title must stay neutral.
  gitR(repo, ["commit", "--amend", "-m", "fix: rework (PLUG-1)"]);
  const { deps, store } = makeDeps(repo, {
    ghCalls,
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "pr", branch: "main" },
        threadIds: false,
      },
    }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  const create = ghCalls.find((a) => a[0] === "pr" && a[1] === "create")!;
  assert.match(
    create[create.indexOf("--title") + 1]!,
    /^release [0-9a-f]{7}$/,
  );
});

test("release (merged): sync=rebase never applies — merge keeps the resolution (PLUG-194)", async () => {
  const { remote, seed } = makeRepo();
  const base = mkdtempSync(join(tmpdir(), "rel-coord-"));
  const coord = join(base, "coord");
  execFileSync("git", ["clone", "--branch", "main", remote, coord]);
  gitR(coord, ["config", "user.name", "Agent"]);
  gitR(coord, ["config", "user.email", "agent@x.io"]);
  gitR(coord, ["checkout", "-b", "work"]);
  // A §14 merge commit whose conflict resolution exists only in it —
  // `git rebase` would flatten it away.
  writeFileSync(join(coord, "res.txt"), "base\n");
  gitR(coord, ["add", "."]);
  gitR(coord, ["commit", "-m", "feat: result"]);
  gitR(coord, ["checkout", "-b", "side"]);
  writeFileSync(join(coord, "res.txt"), "side\n");
  gitR(coord, ["commit", "-am", "side edit"]);
  gitR(coord, ["checkout", "work"]);
  writeFileSync(join(coord, "res.txt"), "work\n");
  gitR(coord, ["commit", "-am", "work edit"]);
  try {
    execFileSync("git", ["-C", coord, "merge", "-m", "merge r1", "side"]);
  } catch {
    // expected conflict — resolve it with content unique to the merge
  }
  writeFileSync(join(coord, "res.txt"), "RESOLVED-ONLY-IN-MERGE\n");
  gitR(coord, ["add", "res.txt"]);
  gitR(coord, ["commit", "-m", "merge r1"]);
  const workTip = gitR(coord, ["rev-parse", "HEAD"]);
  gitR(coord, ["checkout", "-b", "work-2"]);
  // Advance origin/main so the sync step actually runs.
  writeFileSync(join(seed, "new.txt"), "new\n");
  gitR(seed, ["add", "."]);
  gitR(seed, ["commit", "-m", "chore: more"]);
  gitR(seed, ["push", "origin", "main"]);
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "push", branch: "main" },
        sync: "rebase",
      },
    }),
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  const subcommands: string[] = [];
  const realRun = deps.cmd.run;
  deps.cmd = {
    run: async (file, args, o) => {
      if (file === "git" && args[0] === "-C") subcommands.push(args[2]!);
      return realRun(file, args, o);
    },
  };
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
  // §16.6: a §14-merged result is synced by merge only.
  assert.ok(subcommands.includes("merge"));
  assert.ok(!subcommands.includes("rebase"));
  // The §14 merge commit is still in `work` and its resolution survived.
  execFileSync("git", [
    "-C",
    coord,
    "merge-base",
    "--is-ancestor",
    workTip,
    "work",
  ]);
  assert.match(
    execFileSync("git", ["-C", coord, "show", "work:res.txt"], {
      encoding: "utf8",
    }),
    /RESOLVED-ONLY-IN-MERGE/,
  );
  // The coordinator copy returned to its own branch, lock released.
  assert.equal(gitR(coord, ["symbolic-ref", "--short", "HEAD"]), "work-2");
});

// ── §17.3 r26: очередь, SHA-гейт ревью, PR текстом, rev-list ──────────

test("§17.3 С1: only the audit dispatch goes through the delegate queue", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo);
  let enqueued = 0;
  deps.enqueue = async <T,>(f: () => Promise<T>) => {
    enqueued++;
    return f();
  };
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
  // the outer release never enqueues — exactly the one audit dispatch does
  assert.equal(enqueued, 1);
});

test("§17.3 Б4: a review bound to a stale sha does not satisfy the gate", async () => {
  const { repo } = makeRepo();
  const { deps, bindReview } = makeDeps(repo);
  // a review of an older round — not of the result being published
  bindReview("0".repeat(40));
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      /нет ревью.*публикуемый итог/.test((e as OrchestratorError).message),
  );
});

test("§17.3 Б4: merged — a commit outside the merged shas is unreviewed-commits", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  // a coordinator commit on `work` that no merged delegation explains
  gitR(coord, ["checkout", "work"]);
  writeFileSync(join(coord, "sneaky.txt"), "x\n");
  gitR(coord, ["add", "."]);
  gitR(coord, ["commit", "-m", "coord: unreviewed"]);
  gitR(coord, ["checkout", "work-2"]);
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => (e as OrchestratorError).code === "unreviewed-commits",
  );
});

test("§17.3 Б4: merged — every merged delegation needs an OK review on its merged_sha", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  // a second task's result merged into the same branch
  gitR(coord, ["checkout", "work"]);
  writeFileSync(join(coord, "task2.txt"), "x\n");
  gitR(coord, ["add", "."]);
  gitR(coord, ["commit", "-m", "feat: task2 result"]);
  const sha2 = gitR(coord, ["rev-parse", "HEAD"]);
  gitR(coord, ["checkout", "work-2"]);
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  const exec2 = store.insert({
    taskKey: "PLUG-2",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "c",
    preset: "c",
    provider: "p",
  });
  store.setThreadInfo(exec2.id, "thr_exec2");
  store.setStatus(exec2.id, "done");
  store.setMerged(exec2.id, { into: "work", sha: sha2 });
  const rev2 = store.insert({
    taskKey: "PLUG-2",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "r",
    preset: "r",
    provider: "p",
  });
  store.setThreadInfo(rev2.id, "thr_rev2");
  store.setStatus(rev2.id, "done");
  // PLUG-2's review is bound to an older sha — not its merged result
  bindReview("0".repeat(40), rev2.id);
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => /нет ревью на влитый итог/.test((e as OrchestratorError).message),
  );
});

test("§17.3 Б1: gh pr create URL is read from plain-text stdout", async () => {
  const { repo } = makeRepo();
  const { deps, store } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "pr", branch: "main" } },
    }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  // the mock returns gh's real output format — a bare URL, no JSON
  assert.equal(
    store.releasesByStatuses(["published"])[0]!.pr_url,
    "https://example.test/pr/7",
  );
});

test("§17.3 С4: repeat release reuses the recorded branch and the existing PR", async () => {
  const { repo } = makeRepo();
  const ghCalls: string[][] = [];
  let prs: unknown[] = [];
  const { deps, store, exec, bindReview } = makeDeps(repo, {
    ghCalls,
    ghPrList: () => prs,
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "pr", branch: "main" },
        threadIds: false,
      },
    }),
  });
  const round = async () => {
    await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
    store.setStatus(
      store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
      "done",
    );
    const s = await pumpReleases(deps);
    assert.equal(s.published, 1);
  };
  await round();
  const branch =
    store.releasesByStatuses(["published"])[0]!.publish_branch!;
  assert.match(branch, /^release\/[0-9a-f]{7}$/);
  // GitHub now reports the PR round 1 created.
  prs = [
    {
      url: "https://example.test/pr/7",
      body: "",
      headRefName: branch,
      baseRefName: "main",
    },
  ];
  // a new round fast-forwards from the published tip — and the gate
  // reviews the new tip as the round's result
  writeFileSync(join(repo, "more.txt"), "more\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: more"]);
  const tip2 = gitR(repo, ["rev-parse", "HEAD"]);
  store.setRoundResult(exec.id, {
    branch: "feat-x", sha: tip2, commits: 2, dirty: false,
  });
  bindReview(tip2);
  await round();
  const creates = ghCalls.filter((a) => a[0] === "pr" && a[1] === "create");
  assert.equal(creates.length, 1); // one PR per task, ever
  const rows = store.releasesByStatuses(["published"]);
  assert.equal(rows[1]!.publish_branch, branch);
  assert.equal(rows[1]!.pr_url, "https://example.test/pr/7");
});

test("§17.3 С5: post-check reports commits landed outside the pushed range", async () => {
  const { repo, seed } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
  });
  let pushedSeen = false;
  let injected = false;
  const realRun = deps.cmd.run;
  deps.cmd = {
    run: async (file, args, o) => {
      const res = await realRun(file, args, o);
      if (file === "git" && args.includes("push")) pushedSeen = true;
      // a foreign commit lands on origin/main between push and post-check
      if (
        pushedSeen &&
        !injected &&
        file === "git" &&
        args.includes("fetch")
      ) {
        injected = true;
        // the release push already moved main — fast-forward the seed
        // first so the foreign commit lands ON TOP of it
        gitR(seed, ["pull", "--ff-only", "origin", "main"]);
        writeFileSync(join(seed, "foreign.txt"), "x\n");
        gitR(seed, ["add", "."]);
        gitR(seed, ["commit", "-m", "chore: foreign"]);
        gitR(seed, ["push", "origin", "main"]);
        await realRun("git", ["-C", repo, "fetch", "origin"], o);
      }
      return res;
    },
  };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  assert.ok(
    sent.some((m) => /коммиты вне release/.test(m)),
    `expected «выложено в обход» notice, got: ${JSON.stringify(sent)}`,
  );
});

test("§17.3 С6: allowedTrailers/allowedEmails parse and exempt matching findings", async () => {
  const cfg = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        allowedTrailers: ["co-authored-by"],
        allowedEmails: ["dev@gmail.com", "@corp.io"],
      },
    }),
  );
  assert.equal(cfg.errors.length, 0);
  const p = resolveProject(cfg.config!, "x");
  assert.deepEqual(p.allowedTrailers, ["co-authored-by"]);
  assert.deepEqual(p.allowedEmails, ["dev@gmail.com", "@corp.io"]);
  const bad = parseReleaseConfig(
    JSON.stringify({ projects: { p: { allowedEmails: "x@y.z" } } }),
  );
  assert.ok(bad.errors.some((e) => e.path === "projects.p.allowedEmails"));

  const meta = {
    sha: "b".repeat(40),
    authorName: "Agent",
    authorEmail: "agent@x.io",
    committerName: "Agent",
    committerEmail: "agent@x.io",
    body: "feat: x\n\nCo-Authored-By: helper <h@x.io>",
  };
  const base = {
    repoPath: "/r",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    commits: [meta],
    added: [{ file: "f.ts", line: 1, text: "contact dev@gmail.com" }],
    leaks: LEAKS,
    allowedAuthor: { name: "Agent", email: "agent@x.io" },
  };
  const strict = await machineScan(GL_EMPTY, base);
  assert.ok(strict.some((f) => f.rule === "foreign-bot-trailer"));
  assert.ok(strict.some((f) => f.rule === "personal-email"));
  const allowed = await machineScan(GL_EMPTY, {
    ...base,
    allowedTrailers: ["Co-Authored-By"],
    allowedEmails: ["dev@gmail.com"],
  });
  assert.ok(!allowed.some((f) => f.rule === "foreign-bot-trailer"));
  assert.ok(!allowed.some((f) => f.rule === "personal-email"));
  // a different personal address still blocks
  const other = await machineScan(GL_EMPTY, {
    ...base,
    added: [{ file: "f.ts", line: 1, text: "other@gmail.com" }],
    allowedEmails: ["dev@gmail.com"],
  });
  assert.ok(other.some((f) => f.rule === "personal-email"));
  // a domain entry exempts any address on it
  const dom = await machineScan(GL_EMPTY, {
    ...base,
    added: [{ file: "f.ts", line: 1, text: "anyone@gmail.com" }],
    allowedEmails: ["gmail.com"],
  });
  assert.ok(!dom.some((f) => f.rule === "personal-email"));
});

test("§17.3 мелко5: review verdict falls back to the reviewer thread's output", async () => {
  const { repo } = makeRepo();
  const okCase = makeDeps(repo, {
    comments: [], // no verdict comment on the task
    reviewThreadOutput: 'итог ревью\n{"verdict":"OK","blockers":0}',
  });
  const res = await runRelease(
    { taskKey: "PLUG-1", caller: COORD },
    okCase.deps,
  );
  assert.equal(res.status, "auditing");

  const badCase = makeDeps(repo, {
    comments: [],
    reviewThreadOutput: 'итог: {"verdict":"CHANGES","blockers":3}',
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, badCase.deps),
    (e: unknown) => /не «OK»/.test((e as OrchestratorError).message),
  );
});

// ── ревью PLUG-210: ретрай после отказа, гейт вершины, очередь ─────

test("PLUG-210 Б1: retry after a post-sync REJECT — pipeline commits are not foreign", async () => {
  const { repo, seed } = makeRepo();
  const { deps, store } = makeDeps(repo, {
    auditVerdict:
      '{"verdict":"REJECT","findings":[{"file":"f.ts","line":1,"problem":"p","fix":"x"}]}',
  });
  // advance main so the sync step creates a merge commit — the
  // pipeline's own work on top of the reviewed result
  writeFileSync(join(seed, "adv.txt"), "adv\n");
  gitR(seed, ["add", "."]);
  gitR(seed, ["commit", "-m", "chore: advance"]);
  gitR(seed, ["push", "origin", "main"]);

  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const afterSync = gitR(repo, ["rev-parse", "HEAD"]);
  // the sync created a real merge commit on top of the reviewed result
  assert.equal(
    gitR(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ").length,
    3,
  );
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s1 = await pumpReleases(deps);
  assert.equal(s1.rejected, 1);
  // the sync merge landed in releases.pipeline_shas
  const row = store.releasesByStatuses(["rejected"])[0]!;
  const recorded = JSON.parse(row.pipeline_shas ?? "[]") as string[];
  assert.ok(recorded.includes(afterSync));

  // second run: review still bound to result_sha; the recorded pipeline
  // commit on top is not foreign work — the run reaches auditing again.
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

test("PLUG-210 Б2: executor tip above result_sha → unreviewed-commits with the sha", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo);
  writeFileSync(join(repo, "extra.txt"), "x\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: unreviewed"]);
  const extra = gitR(repo, ["rev-parse", "HEAD"]);
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "unreviewed-commits" &&
      (e as OrchestratorError).message.includes(extra.slice(0, 7)),
  );
});

test("PLUG-210 Б4: merged — an OK review on the branch tip covers coordinator commits", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  // a coordinator docs commit on `work` — covered by a whole-tip review
  gitR(coord, ["checkout", "work"]);
  writeFileSync(join(coord, "docs-note.md"), "docs\n");
  gitR(coord, ["add", "."]);
  gitR(coord, ["commit", "-m", "docs: coordinator edits"]);
  const tip = gitR(coord, ["rev-parse", "HEAD"]);
  gitR(coord, ["checkout", "work-2"]);
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  const tipRev = store.insert({
    taskKey: "PLUG-9",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "r",
    preset: "r",
    provider: "p",
  });
  // the verdict comment the mock serves carries threadId "thr_rev"
  store.setThreadInfo(tipRev.id, "thr_rev");
  store.setStatus(tipRev.id, "done");
  bindReview(tip, tipRev.id);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

test("PLUG-210: merged — a merged_sha absent from the copy is a clear refusal", async () => {
  const { coord } = makeMergedCoordinatorCopy();
  const { deps, store, exec } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: "d".repeat(40) });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /отсутствует в копии/.test((e as OrchestratorError).message),
  );
});

test("PLUG-210 мелко9: the audit row is inserted inside the delegate queue", async () => {
  const { repo } = makeRepo();
  const { deps, store } = makeDeps(repo);
  let before: unknown;
  let after: unknown;
  deps.enqueue = async <T,>(f: () => Promise<T>) => {
    // the watchdog must never observe a `dispatching` audit row before
    // its dispatch actually ran — the insert rides inside the queue.
    before = store.latestDelegationByTaskAndLevel(
      "PLUG-1",
      "release-audit",
    );
    const r = await f();
    after = store.latestDelegationByTaskAndLevel(
      "PLUG-1",
      "release-audit",
    );
    return r;
  };
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
  assert.equal(before, undefined);
  assert.ok(after);
});

test("PLUG-210 мелко: continuePoint picks by ancestry, not timestamps", async () => {
  const { store } = makeDeps("/tmp/x");
  const r = store.insertRelease({
    taskKey: "PLUG-1",
    projectId: "p",
    coordinatorThreadId: "t",
    repoPath: "/r",
    branch: "b",
    targetAction: "push",
    targetBranch: "main",
  });
  store.updateRelease(r.id, {
    status: "published",
    publishedSha: "e".repeat(40),
  });
  // result_sha is NOT an ancestor of the published tip → the new round
  // continues from the result, not from an unrelated published sha.
  assert.equal(
    await store.continuePoint("PLUG-1", async () => false),
    "f".repeat(40),
  );
  // the published tip CONTAINS the result → continue from it
  // (it carries the sync merge + docs trailer).
  assert.equal(
    await store.continuePoint("PLUG-1", async () => true),
    "e".repeat(40),
  );
});

// ── ревью PLUG-214: вершина после проверок, ревью ниже вершины ────────

test("PLUG-214 Б1: a commit landed during project checks → unreviewed-commits", async () => {
  const { repo } = makeRepo();
  const { deps, store } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "push", branch: "main" },
        // the «оживление после ревью» scenario: while the check runs,
        // something commits onto the branch behind the pipeline's back
        checks: ["git commit --allow-empty -m mid-check"],
      },
    }),
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "unreviewed-commits" &&
      /во время проверок/.test((e as OrchestratorError).message),
  );
  // refused mid-run — the release row is closed, the audit never ran
  assert.equal(store.releasesByStatuses(["failed"]).length, 1);
});

test("PLUG-214 Б1: an in-flight executor turn refuses at step 1", async () => {
  const { repo } = makeRepo();
  let events: unknown[] = [
    { seq: 5, type: "turn/started", createdAt: 2, data: {} },
    { seq: 4, type: "turn/completed", createdAt: 1, data: {} },
  ];
  const { deps } = makeDeps(repo, { execEvents: () => events });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /идёт ход/.test((e as OrchestratorError).message),
  );
  // a queued request counts as an active turn too
  events = [
    { seq: 6, type: "client/turn/requested", createdAt: 3, data: {} },
    { seq: 4, type: "turn/completed", createdAt: 1, data: {} },
  ];
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => (e as OrchestratorError).code === "release-refused",
  );
  // the newest verdict event is a completion — no turn in flight
  events = [
    { seq: 7, type: "turn/completed", createdAt: 4, data: {} },
    { seq: 5, type: "turn/started", createdAt: 2, data: {} },
  ];
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

test("PLUG-214 Б2: merged — a review below the tip counts when only pipeline commits intervene", async () => {
  const { coord, workTip, seed } = makeMergedCoordinatorCopy();
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
    auditVerdict:
      '{"verdict":"REJECT","findings":[{"file":"f","line":1,"problem":"p","fix":"x"}]}',
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  // the OK review of the whole tip — the sha it is bound to is the
  // branch tip AT REVIEW TIME
  bindReview(workTip);
  // advance origin/main so the sync step adds a pipeline merge on top
  writeFileSync(join(seed, "adv.txt"), "adv\n");
  gitR(seed, ["add", "."]);
  gitR(seed, ["commit", "-m", "chore: advance"]);
  gitR(seed, ["push", "origin", "main"]);

  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const syncTip = gitR(coord, ["rev-parse", "work"]);
  assert.notEqual(syncTip, workTip); // the pipeline's own merge on top
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s1 = await pumpReleases(deps);
  assert.equal(s1.rejected, 1);

  // run 2: the tip is the failed run's sync merge; the review sits
  // below it with only pipeline_shas between — the gate must accept.
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

test("PLUG-214 мелко: merged delegations are scoped to the released project", async () => {
  const { coord, workTip } = makeMergedCoordinatorCopy();
  const { deps, store, exec, bindReview } = makeDeps("/nonexistent-exec", {
    coordPath: coord,
  });
  store.setMerged(exec.id, { into: "work", sha: workTip });
  bindReview(workTip);
  // another project's row with the same merged_into — its merge commit
  // does not even exist in this copy; it must not block the gate
  const other = store.insert({
    taskKey: "PLUG-7",
    projectId: "proj_other",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "c",
    preset: "c",
    provider: "p",
  });
  store.setStatus(other.id, "done");
  store.setMerged(other.id, { into: "work", sha: "e".repeat(40) });
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

test("PLUG-214 мелко: the fast-forward gate fires at step 1 — «нет в копии» is its own refusal", async () => {
  const { repo } = makeRepo();
  const { deps, store } = makeDeps(repo);
  const r1 = store.insertRelease({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    repoPath: repo,
    branch: "feat-x",
    targetAction: "push",
    targetBranch: "main",
  });
  // a published sha this copy never saw — not a bare is-ancestor error
  store.updateRelease(r1.id, {
    status: "published",
    publishedSha: "d".repeat(40),
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /отсутствует в копии/.test((e as OrchestratorError).message),
  );
  // an existing commit that is not an ancestor — «не fast-forward»
  gitR(repo, ["checkout", "-b", "side"]);
  writeFileSync(join(repo, "side.txt"), "s\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "side work"]);
  const sideSha = gitR(repo, ["rev-parse", "HEAD"]);
  gitR(repo, ["checkout", "feat-x"]);
  store.updateRelease(r1.id, { publishedSha: sideSha });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /не fast-forward/.test((e as OrchestratorError).message),
  );
  // an ancestor published tip passes the gate
  store.updateRelease(r1.id, {
    publishedSha: gitR(repo, ["rev-parse", "HEAD~"]),
  });
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

test("PLUG-214 Б3: a leftover push-to-checkout wrapper is a stale install", async () => {
  const { repo } = makeRepo();
  const { deps, tmp } = makeDeps(repo);
  installAllWrappers(tmp);
  // a pre-r26-fix install left the retired wrapper — it still breaks
  // updateInstead pushes, so its presence alone is «stale»
  writeFileSync(join(tmp, "push-to-checkout"), "#!/bin/sh\n# retired\n");
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "hook-stale" &&
      /install\.mjs/.test((e as OrchestratorError).hint ?? ""),
  );
});
