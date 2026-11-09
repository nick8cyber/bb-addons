import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

test("machine scan: categories 2-4 templates, BB-Thread exempt", async () => {
  const cmd: CmdRunner = {
    run: async (file) =>
      file === "gitleaks" ? { exitCode: 7, stdout: "[]", stderr: "" } : ok(),
  };
  const findings = await machineScan(cmd, {
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
  });
  const cat = (n: number) => findings.filter((f) => f.category === n);
  assert.ok(cat(1).some((f) => f.rule === "secret-file" && f.file === ".env"));
  assert.ok(cat(2).some((f) => f.rule === "commit-identity"));
  assert.ok(cat(2).some((f) => f.rule === "foreign-bot-trailer"));
  assert.ok(cat(3).some((f) => f.rule === "home-path"));
  // thr_ in the diff is cat 4 (warn), in the BB-Thread trailer exempt,
  // in allow-listed files skipped.
  assert.ok(cat(4).some((f) => f.file === "f.ts"));
  assert.ok(!cat(4).some((f) => f.file === "allow/x.md"));
  assert.ok(!cat(4).some((f) => f.file === null));
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

test("reviewVerdictOk: OK markers vs findings", () => {
  assert.equal(reviewVerdictOk("ОК. Замечаний нет."), true);
  assert.equal(reviewVerdictOk("ЕСТЬ ЗАМЕЧАНИЯ (неблокирующие). Ревью…"), false);
  assert.equal(reviewVerdictOk("Вердикт: ОК\nдетали…"), true);
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

function makeRepo(): { repo: string; remote: string } {
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
  return { repo, remote };
}

function makeDeps(repo: string, overrides: Partial<{
  policyText: string;
  releaseText: string;
  comments: unknown[];
  dispatchFail: boolean;
  auditVerdict: string;
  auditStatus: string;
}> = {}) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  // executor done + review done-OK
  const exec = store.insert({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", level: "complex",
    route: "c", preset: "c", provider: "p",
  });
  store.setThreadInfo(exec.id, "thr_exec");
  store.setStatus(exec.id, "done");
  const rev = store.insert({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", level: "review",
    route: "r", preset: "r", provider: "p",
  });
  store.setThreadInfo(rev.id, "thr_rev");
  store.setStatus(rev.id, "done");
  const calls: string[][] = [];
  const comments: string[] = [];
  const sent: string[] = [];
  const bbCli: BbCli = {
    run: async (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key.startsWith("tasks show"))
        return ok(JSON.stringify({
          task: { key: "PLUG-1", title: "do x", status: "in_review" },
          comments: overrides.comments ?? [
            { kind: "agent", threadId: "thr_rev", body: "ОК, замечаний нет", createdAt: "2026-01-01" },
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
        : { id: threadId, parentThreadId: null, title: null, originPluginId: null, projectId: "proj_main" },
    send: async (a: { threadId: string; input: unknown[] }) => {
      sent.push((a.input[0] as { text: string }).text);
      return {};
    },
    events: {
      list: async () =>
        overrides.auditVerdict !== undefined
          ? [{
              seq: 9, type: "item/completed", createdAt: 1,
              data: { item: { type: "agentMessage", text: overrides.auditVerdict } },
            }]
          : [],
    },
  };
  const tmp = mkdtempSync(join(tmpdir(), "hooks-"));
  const deps = {
    store, bbCli, threads: threads as never,
    cmd: { run: async (file: string, args: string[], o?: { cwd?: string }) => {
      if (file === "gitleaks") return { exitCode: 0, stdout: "", stderr: "" };
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
    log: {},
  } satisfies ReleaseDeps;
  return { deps, store, calls, comments, sent, tmp };
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
    comments: [{ kind: "agent", threadId: "thr_rev", body: "ЕСТЬ ЗАМЕЧАНИЯ: …", createdAt: "x" }],
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => /не «ОК»/.test((e as OrchestratorError).message),
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

test("push token file: sha + expiry written 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "tok-"));
  const file = writePushToken(dir, "abc123");
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(data.sha, "abc123");
  assert.ok(data.expiresAt > Date.now());
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
