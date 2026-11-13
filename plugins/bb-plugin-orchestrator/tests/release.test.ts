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
  commitIdentityMissing,
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
import { createCommandRunner, type SpawnedCommand } from "../src/commands.js";
import { acquireCopyLock } from "../src/merge.js";
import {
  parseAuditVerdict,
  reviewVerdictOk,
  docsForChanges,
  releaseThreadsGet,
  runRelease,
  pumpReleases,
  releaseAllPostPublishLocks,
  POSTPUBLISH_MAX_MS,
  writePushToken,
  settingsProjectId,
  type ReleaseDeps,
  type ReleaseThreads,
} from "../src/release.js";
import {
  GLUED_PATH_LINE,
  LEAK_HOME_PATH,
  LEAK_USERS_PATH,
  MIXED_PATH_LINE,
  SAFE_HOME_PATH,
  SAFE_USERS_PATH,
} from "./fixtures/leak-samples.js";
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

const LEAKS = {
  machine: "block" as const,
  bbIds: "warn" as const,
  trailers: "block" as const,
  allow: [],
};

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
    { file: "f.ts", line: 1, text: `const d = "${LEAK_HOME_PATH}"` },
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
  // Ревью PLUG-244 заход 1 (Н8): JSON-хвост после прозы в той же строке
  // вердиктом НЕ считается — только отдельная строка-JSON.
  assert.equal(
    reviewVerdictOk('итог: {"verdict":"OK","blockers":0}'),
    false,
  );
  assert.equal(
    reviewVerdictOk('… {"verdict":"OK","blockers":0} …'),
    false,
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
  /** §18.3: ответ `gh` для команд вне встроенных заглушек (`auth
   * status` и пр.); undefined → стандартный `{}` с кодом 0. */
  ghFallback?: (
    args: string[],
  ) => { exitCode: number; stdout: string; stderr: string } | undefined;
  /** §17.3 (мелко 5): the reviewer thread's final output — the verdict
   * fallback when the task carries no verdict comment. */
  reviewThreadOutput: string | null;
  /** §17.3 (ревью PLUG-214): the executor thread's events — the step-1
   * check refuses while a turn is in flight. */
  execEvents: () => unknown[];
  /** §17.3 (ревью PLUG-216 п.2): the executor thread's status — the
   * primary turn signal; absent → the journal heuristic decides. */
  execStatus: string | null;
  /** §6 (r7): the executor copy path — a worktree path instead of the
   * main checkout exercises the settings-project resolution. */
  execPath: string;
  /** §6 (r7): the executor copy's branch (worktree copies cannot share
   * the main checkout's branch). */
  execBranch: string;
  /** §6 (r7/r8): what `bb project list --json` returns — absent, the
   * harness advertises the project that owns this repo (the r8
   * resolver needs SOME match — there is no delegation fallback). */
  projects?: unknown[];
  /** §6 (r8): `bb project list` exits non-zero — the resolver fails. */
  projectListFail?: boolean;
  /** §6 (r8): the local bb hostId — project sources on another hostId
   * never count as candidates. */
  localHostId?: string;
  /** §6 (r8): the delegation rows' `project_id` (default proj_main). */
  delegationProjectId?: string;
  /** §4.1 r28.1: mark the executor delegation «задача без кода». */
  execNoCode?: boolean;
  /** §4.1 r28.1: the executor round's own commit count (default 1). */
  execCommits?: number | null;
  /** r10 п.2: `bb plugin list --json` — установленные плагины
   * (rootDir → id) для postPublish. */
  pluginList?: () => unknown[];
  /** r10 п.2 (ревью Б2): `bb provider list --json` — реестр
   * провайдер→pluginId. */
  providerList?: () => unknown[];
  /** r10 п.2 (ревью Б2): `bb provider list` exits non-zero — реестр
   * не читается, консервативный пропуск. */
  providerListFail?: boolean;
  /** r10 п.2: `bb automation create` падает → строка «вручную». */
  automationCreateFail?: boolean;
  /** r10 п.2: `bb plugin reload` падает → «перезагрузка не удалась». */
  pluginReloadFail?: boolean;
  /** r10 п.5 (ревью Б4): первые N `threads.send` бросают. */
  sendFails?: number;
  /** r10 п.5 (ревью заход 4 Н5): ошибка, которой бросают первые N
   * send'ов (по умолчанию «send failed (test)»). */
  sendError?: () => Error;
  /** r10 п.5: тред координатора удалён — send всегда «not found». */
  sendThreadGone?: boolean;
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
    taskKey: "PLUG-1",
    projectId: overrides.delegationProjectId ?? "proj_main",
    coordinatorThreadId: "thr_coord", level: "complex",
    route: "c", preset: "c", provider: "p",
    noCode: overrides.execNoCode,
  });
  store.setThreadInfo(exec.id, "thr_exec");
  store.setStatus(exec.id, "done");
  store.setRoundResult(exec.id, {
    branch: "feat-x", sha: RESULT_SHA,
    commits: overrides.execCommits === undefined ? 1 : overrides.execCommits,
    dirty: false,
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
  /** §4 r30: recorded `threads.spawn` calls of the audit dispatch. */
  const spawnCalls: unknown[] = [];
  const comments: string[] = [];
  const sent: string[] = [];
  const bbCli: BbCli = {
    run: async (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key.startsWith("tasks show"))
        return ok(JSON.stringify({
          task: {
            id: "task-1",
            key: args[2] ?? "PLUG-1",
            title: "do x",
            status: "in_review",
          },
          project: { name: "p", linkedBbProjectId: "proj_bb" },
          subtasks: [],
          attachments: [],
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
      if (key.startsWith("thread show"))
        return ok(
          JSON.stringify({
            thread: {
              parentThreadId: "thr_coord",
              parentNotifications: "auto",
              visibility: "hidden",
            },
          }),
        );
      if (key.startsWith("tasks dispatch"))
        return overrides.dispatchFail
          ? { exitCode: 1, stdout: "", stderr: "boom" }
          : ok(JSON.stringify({ threadId: "thr_audit" }));
      if (key.startsWith("tasks preset show"))
        return ok(
          JSON.stringify({
            preset: {
              providerId: "p",
              modelId: "m1",
              reasoningLevel: "medium",
              permissionMode: "auto",
              environmentKind: "project-default",
            },
          }),
        );
      if (key.startsWith("thread options"))
        return ok(JSON.stringify({ options: [] }));
      if (key.startsWith("plugin reload"))
        return overrides.pluginReloadFail
          ? { exitCode: 1, stdout: "", stderr: "reload boom" }
          : ok();
      if (key.startsWith("plugin list"))
        return ok(JSON.stringify(overrides.pluginList?.() ?? []));
      if (key.startsWith("provider list"))
        return overrides.providerListFail
          ? { exitCode: 1, stdout: "", stderr: "provider list boom" }
          : ok(JSON.stringify(overrides.providerList?.() ?? []));
      if (key.startsWith("automation create"))
        return overrides.automationCreateFail
          ? { exitCode: 1, stdout: "", stderr: "automation boom" }
          : ok();
      if (key.startsWith("project list"))
        return overrides.projectListFail
          ? { exitCode: 1, stdout: "", stderr: "project list boom" }
          : ok(JSON.stringify(
              overrides.projects ?? [{
                id: "proj_main",
                sources: [{
                  type: "local_path",
                  path: overrides.coordPath ?? repo,
                  isDefault: true,
                }],
              }],
            ));
      return ok();
    },
  };
  let sendFailsLeft = overrides.sendFails ?? 0;
  const threads = {
    get: async ({ threadId }: { threadId: string }) =>
      threadId === "thr_exec"
        ? { id: threadId, status: overrides.execStatus ?? undefined, environmentPath: overrides.execPath ?? repo, environmentBranchName: overrides.execBranch ?? "feat-x", parentThreadId: null }
        : threadId === "thr_coord" && overrides.coordPath
          ? { id: threadId, environmentPath: overrides.coordPath, environmentBranchName: null, parentThreadId: null }
          : { id: threadId, parentThreadId: null, title: null, originPluginId: null, projectId: "proj_main" },
    send: async (a: { threadId: string; input: unknown[] }) => {
      if (overrides.sendThreadGone) {
        // ревью заход 4 (Н5): SDK отвечает PluginRpcCallError c
        // code "not_found" — текст сообщения роли не играет.
        throw Object.assign(
          new Error(`thread not found: ${a.threadId}`),
          { code: "not_found", status: 404 },
        );
      }
      if (sendFailsLeft > 0) {
        sendFailsLeft--;
        throw overrides.sendError?.() ?? new Error("send failed (test)");
      }
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
    cmd: { run: async (file: string, args: string[], o?: { cwd?: string; stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => {
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
        const fb = overrides.ghFallback?.(args);
        if (fb) return fb;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      try {
        const out = execFileSync(file, args, {
          cwd: o?.cwd, encoding: "utf8", input: o?.stdin,
          env: { ...process.env, ...(o?.env ?? {}) },
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
        spawn: async (a: unknown) => {
          spawnCalls.push(a);
          if (overrides.dispatchFail) {
            const e = new Error("HTTP 400: boom") as Error & {
              code: string | null;
              status: number;
            };
            e.code = "invalid_params";
            e.status = 400;
            throw e;
          }
          return { id: "thr_audit" };
        },
        list: async () => [],
        update: async () => ({}),
        stop: async () => ({}),
        updatePluginMetadata: async () => ({}),
      },
      primaryHostId: async () => "host_test",
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
    localHostId: async () => overrides.localHostId ?? "host_test",
    enqueue: <T>(f: () => Promise<T>) => f(),
    now: undefined as (() => number) | undefined,
    spawn: undefined as ReleaseDeps["spawn"],
    killGraceMs: undefined as ReleaseDeps["killGraceMs"],
    log: {},
  } satisfies ReleaseDeps;
  return { deps, store, calls, spawnCalls, comments, sent, tmp, exec, rev, bindReview, db };
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
  const { deps, store, spawnCalls } = makeDeps(repo);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
  const row = store.getRelease(res.releaseId)!;
  assert.equal(row.status, "auditing");
  assert.equal(row.target_action, "push");
  assert.equal(spawnCalls.length, 1, "audit dispatched via own spawn");
  const audit = store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!;
  assert.equal(audit.status, "running");
  assert.equal(store.threadRole("thr_audit")?.role, "release-auditor");
});

// ── PLUG-229: server-side threads.get (environmentId → env show) ─────

test("PLUG-229: SDK thread без envPath — копия из environment show", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo);
  const shown: string[] = [];
  // The real SDK thread carries `environmentId` only — the mocked
  // `environmentPath`/`environmentBranchName` hid the bug on live runs.
  const sdkGet = async ({ threadId }: { threadId: string }) =>
    threadId === "thr_exec"
      ? {
          id: threadId,
          status: "idle",
          environmentId: "env_exec",
          parentThreadId: null,
          title: null,
          originPluginId: null,
          projectId: "proj_main",
        }
      : {
          id: threadId,
          parentThreadId: null,
          title: null,
          originPluginId: null,
          projectId: "proj_main",
        };
  (deps.threads as ReleaseThreads).get = releaseThreadsGet(sdkGet, async (envId) => {
    shown.push(envId);
    return { path: repo, branchName: "feat-x" };
  });
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
  // Step 1's copy read + the §17.3 turn gate both go through the wrap.
  assert.deepEqual(shown, ["env_exec", "env_exec"]);
});

test("PLUG-229: без environmentId — прежний отказ «нет рабочей копии»", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo);
  (deps.threads as ReleaseThreads).get = releaseThreadsGet(
    async ({ threadId }: { threadId: string }) => ({ id: threadId }),
    async () => ({ path: repo, branchName: "feat-x" }),
  );
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /нет рабочей копии/.test((e as OrchestratorError).message),
  );
});

test("PLUG-229: ошибка environment show → поля null → тот же отказ", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo);
  (deps.threads as ReleaseThreads).get = releaseThreadsGet(
    async ({ threadId }: { threadId: string }) =>
      threadId === "thr_exec"
        ? { id: threadId, environmentId: "env_gone" }
        : { id: threadId },
    async () => {
      throw new Error("environment show: no such environment");
    },
  );
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => (e as OrchestratorError).code === "release-refused",
  );
});

test("release r7: настройка — по проекту репозитория копии исполнителя", async () => {
  const { repo } = makeRepo();
  // The executor copy is a linked worktree of the repo nested inside a
  // parent project's directory — the spec's own scenario.
  const wt = join(mkdtempSync(join(tmpdir(), "exec-")), "copy");
  gitR(repo, ["worktree", "add", "-b", "exec-copy", wt, "HEAD"]);
  const { deps } = makeDeps(repo, {
    execPath: wt,
    execBranch: "exec-copy",
    projects: [
      { id: "proj_par", sources: [{ type: "local_path", path: tmpdir(), isDefault: true }] },
      { id: "proj_repo", sources: [{ type: "local_path", path: repo, isDefault: true }] },
    ],
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: { proj_repo: {}, proj_main: { excluded: true } },
    }),
  });
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  // proj_main (the delegation project) is excluded — only the repo
  // project's settings let the release through.
  assert.equal(res.ok, true);
  assert.equal(res.settingsProjectId, "proj_repo");
  assert.equal(res.delegationProjectId, "proj_main");
});

test("release r7: excluded у проекта репозитория → отказ с обоими id", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo, {
    projects: [
      { id: "proj_repo", sources: [{ type: "local_path", path: repo, isDefault: true }] },
    ],
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: { proj_repo: { excluded: true }, proj_main: {} },
    }),
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => {
      const x = e as OrchestratorError;
      assert.equal(x.code, "release-excluded");
      assert.match(x.message, /proj_repo/);
      assert.match(x.message, /proj_main/);
      return true;
    },
  );
});

test("release r8: ни один проект не совпал → отказ, не проект делегирования", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo, {
    projects: [],
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: { proj_main: { target: { action: "push", branch: "dev" } } },
    }),
  });
  // §6 (r8): no path candidate and no origin match — the gate fails
  // closed, never substituting the delegation project.
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-settings-unknown",
  );
});

test("settingsProjectId r8: ошибка git → отказ, не проект делегирования", async () => {
  const cmd: CmdRunner = {
    run: async () => ({ exitCode: 1, stdout: "", stderr: "fatal" }),
  };
  const bbCli: BbCli = { run: async () => ok("[]") };
  await assert.rejects(
    settingsProjectId({ cmd, bbCli }, "/no/such/dir", "proj_main", null),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-settings-unknown",
  );
});

test("settingsProjectId: worktree → проект основного каталога репозитория", async () => {
  const { repo } = makeRepo();
  const wt = join(mkdtempSync(join(tmpdir(), "exec-")), "copy");
  gitR(repo, ["worktree", "add", "--detach", wt, "HEAD"]);
  const cmd: CmdRunner = {
    run: async (file, args, o) => {
      try {
        const out = execFileSync(file, args, {
          cwd: o?.cwd, encoding: "utf8", input: o?.stdin,
        });
        return { exitCode: 0, stdout: out, stderr: "" };
      } catch (e: unknown) {
        const x = e as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: x.status ?? 1, stdout: x.stdout ?? "", stderr: x.stderr ?? "" };
      }
    },
  };
  const bbCli: BbCli = {
    run: async () =>
      ok(JSON.stringify([
        { id: "proj_repo", sources: [{ type: "local_path", path: repo, isDefault: true }] },
      ])),
  };
  // resolving from the worktree copy finds the main checkout's project
  assert.equal(
    await settingsProjectId({ cmd, bbCli }, wt, "proj_main", null),
    "proj_repo",
  );
  // and from the checkout itself
  assert.equal(
    await settingsProjectId({ cmd, bbCli }, repo, "proj_main", null),
    "proj_repo",
  );
});

test("release: scan finding (cat 2 identity) refuses before audit", async () => {
  const { repo } = makeRepo();
  const { deps, store, calls, spawnCalls } = makeDeps(repo, {
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
  assert.equal(spawnCalls.length, 0, "no audit spawn either");
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
    leaks: {
      machine: "block",
      bbIds: "warn",
      trailers: "warn",
      allow: ["docs/"],
    },
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
    leaks: { machine: "block", bbIds: "warn", trailers: "warn", allow: [] },
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
  writeFileSync(join(repo, "leak.txt"), `path ${LEAK_HOME_PATH}\n`);
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
  // §18.6: тело по умолчанию — шаблон BB-Thread/BB-Task (прежний
  // «Источник»/«Задача» — явной настройкой prBody у установки автора).
  assert.match(on.body, /BB-Thread: thr_coord/);
  assert.match(on.body, /BB-Task: PLUG-1/);
  assert.equal(on.head, "feat-x"); // local executor branch published as-is
  const off = await publish(false);
  // §16.6: with threadIds off nothing bb-identifiable reaches the remote
  // — no thread/task markers, a neutral release/<sha7> head.
  assert.doesNotMatch(off.body, /Источник|Задача|BB-Thread|BB-Task/);
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
  const { deps, store, spawnCalls } = makeDeps(repo);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const headSha = store.getRelease(res.releaseId)!.head_sha!;
  // §4 r30: the sha-binding instructions ride inside the spawn prompt
  const prompt = (spawnCalls[0] as { prompt?: string }).prompt!;
  assert.ok(prompt.includes(headSha));
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

test("f7: prWasReleased is scoped to coordinator AND task (§18.3)", () => {
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
  assert.equal(
    store.prWasReleased("https://x.test/pr/1", "thr_a", "PLUG-9"),
    true,
  );
  assert.equal(
    store.prWasReleased("https://x.test/pr/1", "thr_b", "PLUG-9"),
    false,
  );
  // §18.3: «свой PR» — pr_url прошлых выкладок ЭТОЙ задачи этим
  // координатором; другая задача того же координатора — чужая.
  assert.equal(
    store.prWasReleased("https://x.test/pr/1", "thr_a", "PLUG-8"),
    false,
  );
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
    `+${LEAK_HOME_PATH}`,
    "diff --git a/h.txt b/h.txt",
    "+++ b/h.txt",
    "@@ -0,0 +1 @@",
    "+x",
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [
    { file: "g.txt", line: 1, text: "++ /dev/null" },
    { file: "g.txt", line: 2, text: "++ b/docs/PLAN.md" },
    { file: "g.txt", line: 3, text: LEAK_HOME_PATH },
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

test("§17.3 С6 (PLUG-224): allowedTrailers «name: value prefix», case-insensitive", async () => {
  const meta = (body: string) => ({
    sha: "b".repeat(40),
    authorName: "Agent",
    authorEmail: "agent@x.io",
    committerName: "Agent",
    committerEmail: "agent@x.io",
    body,
  });
  const base = {
    repoPath: "/r",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    added: [],
    leaks: LEAKS,
    allowedAuthor: { name: "Agent", email: "agent@x.io" },
  };
  const claude =
    "feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
  const devin = "feat: x\n\nCo-Authored-By: Devin <devin@x.io>";
  const scan = (body: string, allowedTrailers: string[]) =>
    machineScan(GL_EMPTY, {
      ...base,
      commits: [meta(body)],
      allowedTrailers,
    });
  // «name: prefix»: Claude's trailer passes, Devin's does not
  assert.ok(
    !(await scan(claude, ["Co-Authored-By: Claude"])).some(
      (f) => f.rule === "foreign-bot-trailer",
    ),
  );
  assert.ok(
    (await scan(devin, ["Co-Authored-By: Claude"])).some(
      (f) => f.rule === "foreign-bot-trailer",
    ),
  );
  // a bare name allows every value
  for (const body of [claude, devin]) {
    assert.ok(
      !(await scan(body, ["Co-Authored-By"])).some(
        (f) => f.rule === "foreign-bot-trailer",
      ),
    );
  }
  // name, prefix and trailer text all compare case-insensitively
  assert.ok(
    !(await scan("feat: x\n\nco-authored-by: CLAUDE Opus <c@x.io>", [
      "CO-AUTHORED-BY: claude",
    ])).some((f) => f.rule === "foreign-bot-trailer"),
  );

  // validation: an unknown name or an empty prefix is a config error
  for (const entry of ["Co-Authered-By", "Co-Authored-By:", "Unknown: x"]) {
    const bad = parseReleaseConfig(
      JSON.stringify({ defaults: { allowedTrailers: [entry] } }),
    );
    assert.ok(
      bad.errors.some((e) => e.path === "defaults.allowedTrailers[0]"),
      `expected a config error for ${entry}, got ${JSON.stringify(bad.errors)}`,
    );
  }
  const good = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        allowedTrailers: ["Co-Authored-By: Claude", "Signed-off-by"],
      },
    }),
  );
  assert.equal(good.errors.length, 0);
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
    reviewThreadOutput: 'итог ревью\n{"verdict":"CHANGES","blockers":3}',
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, badCase.deps),
    (e: unknown) => /не «OK»/.test((e as OrchestratorError).message),
  );

  // §17 r31 (ревью Н8): JSON внутри строки прозы — вердиктом не
  // считается вовсе (только отдельная строка), приёмка: «не найден».
  const proseCase = makeDeps(repo, {
    comments: [],
    reviewThreadOutput: 'итог: {"verdict":"CHANGES","blockers":3}',
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, proseCase.deps),
    (e: unknown) => /не найден/.test((e as OrchestratorError).message),
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

// ── ревью PLUG-216: fetch-окно sync, статус треда ───────────────────

test("PLUG-216 Б1: a commit landed during the sync fetch → unreviewed-commits, not in pipeline_shas", async () => {
  const { repo } = makeRepo();
  const { deps, store } = makeDeps(repo);
  let fetches = 0;
  let xSha = "";
  const realRun = deps.cmd.run;
  deps.cmd = {
    run: async (file, args, o) => {
      const res = await realRun(file, args, o);
      // «оживление после ревью» раньше: the step-1 fetch already ran —
      // during the sync's own fetch window the executor lands a commit
      // no review covers.
      if (file === "git" && args.includes("fetch") && ++fetches === 2) {
        writeFileSync(join(repo, "x-mid-fetch.txt"), "x\n");
        gitR(repo, ["add", "."]);
        gitR(repo, ["commit", "-m", "feat: mid-fetch"]);
        xSha = gitR(repo, ["rev-parse", "HEAD"]);
      }
      return res;
    },
  };
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "unreviewed-commits" &&
      /во время sync/.test((e as OrchestratorError).message) &&
      (e as OrchestratorError).message.includes(xSha.slice(0, 7)),
  );
  // the foreign commit must not land in pipeline_shas — on a retry the
  // gate still calls it foreign.
  const row = store.releasesByStatuses(["failed"])[0]!;
  const recorded = JSON.parse(row.pipeline_shas ?? "[]") as string[];
  assert.ok(!recorded.includes(xSha));
});

test("PLUG-216 Б1: pipeline_shas records only the pipeline's own sync merge", async () => {
  const { repo, seed } = makeRepo();
  const { deps, store } = makeDeps(repo, {
    auditVerdict: '{"verdict":"REJECT","findings":[]}',
  });
  // advance main — the sync merge pulls in the origin range too; only
  // the merge commit itself is pipeline-made.
  writeFileSync(join(seed, "adv.txt"), "adv\n");
  gitR(seed, ["add", "."]);
  gitR(seed, ["commit", "-m", "chore: advance"]);
  gitR(seed, ["push", "origin", "main"]);
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  const mergeTip = gitR(repo, ["rev-parse", "HEAD"]);
  const originTip = gitR(repo, ["rev-parse", "origin/main"]);
  const row = store.releasesByStatuses(["auditing"])[0]!;
  const recorded = JSON.parse(row.pipeline_shas ?? "[]") as string[];
  assert.deepEqual(recorded, [mergeTip]);
  assert.ok(!recorded.includes(originTip));
  // and a retry still passes the gate — the origin range is excused by
  // remote reachability, not by the pipeline set.
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s1 = await pumpReleases(deps);
  assert.equal(s1.rejected, 1);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

test("PLUG-216 Б1: rebase sync records the rewritten commits (patch-id), refuses foreign ones", async () => {
  const { repo, seed } = makeRepo();
  const { deps, store } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: { proj_main: { sync: "rebase" } },
    }),
  });
  // advance main — the rebase rewrites the branch commits on top of it
  writeFileSync(join(seed, "adv.txt"), "adv\n");
  gitR(seed, ["add", "."]);
  gitR(seed, ["commit", "-m", "chore: advance"]);
  gitR(seed, ["push", "origin", "main"]);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
  // the rewritten tip is recorded as pipeline-made — a retry's gate
  // must not call it foreign
  const tip = gitR(repo, ["rev-parse", "HEAD"]);
  const row = store.releasesByStatuses(["auditing"])[0]!;
  const recorded = JSON.parse(row.pipeline_shas ?? "[]") as string[];
  assert.ok(recorded.includes(tip), `tip ${tip} in ${recorded}`);

  // a foreign commit on the rebased tip has no matching patch-id —
  // sync refuses before it can land in pipeline_shas
  const { deps: deps2, store: store2 } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: { proj_main: { sync: "rebase" } },
    }),
  });
  const realRun = deps2.cmd.run;
  let xSha = "";
  deps2.cmd = {
    run: async (file, args, o) => {
      const res = await realRun(file, args, o);
      if (!xSha && file === "git" && args.includes("rebase")) {
        writeFileSync(join(repo, "x-mid-rebase.txt"), "x\n");
        gitR(repo, ["add", "."]);
        gitR(repo, ["commit", "-m", "feat: mid-rebase"]);
        xSha = gitR(repo, ["rev-parse", "HEAD"]);
      }
      return res;
    },
  };
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2),
    (e: unknown) =>
      (e as OrchestratorError).code === "unreviewed-commits" &&
      (e as OrchestratorError).message.includes(xSha.slice(0, 7)),
  );
  const failed = store2.releasesByStatuses(["failed"])[0]!;
  const rec2 = JSON.parse(failed.pipeline_shas ?? "[]") as string[];
  assert.ok(!rec2.includes(xSha));
});

test("PLUG-216 п.2: a turn ended on provider/error without turn/completed is not active", async () => {
  const { repo } = makeRepo();
  // the journal's newest event stays `turn/started` forever — the
  // status says the thread stopped, so the release must proceed.
  const idleCase = makeDeps(repo, {
    execStatus: "idle",
    execEvents: () => [
      { seq: 6, type: "turn/started", createdAt: 2, data: {} },
    ],
  });
  const res = await runRelease(
    { taskKey: "PLUG-1", caller: COORD },
    idleCase.deps,
  );
  assert.equal(res.status, "auditing");

  // a FRESH queued request on a stopped thread still counts as active
  const queuedCase = makeDeps(repo, {
    execStatus: "idle",
    execEvents: () => [
      {
        seq: 7,
        type: "client/turn/requested",
        createdAt: Date.now(),
        data: {},
      },
      { seq: 6, type: "turn/started", createdAt: Date.now() - 60_000, data: {} },
    ],
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, queuedCase.deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /идёт ход/.test((e as OrchestratorError).message),
  );

  // a live status refuses even when the journal tail looks finished
  const runningCase = makeDeps(repo, {
    execStatus: "running",
    execEvents: () => [
      { seq: 8, type: "turn/completed", createdAt: 4, data: {} },
      { seq: 6, type: "turn/started", createdAt: 2, data: {} },
    ],
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, runningCase.deps),
    (e: unknown) => (e as OrchestratorError).code === "release-refused",
  );

  // status unreadable → the journal heuristic decides, as before
  const legacyCase = makeDeps(repo, {
    execEvents: () => [
      { seq: 6, type: "turn/started", createdAt: 2, data: {} },
    ],
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, legacyCase.deps),
    (e: unknown) => (e as OrchestratorError).code === "release-refused",
  );
});

test("PLUG-217 Б1: a commit slipped in after the last tip check is not the audited head", async () => {
  const { repo } = makeRepo();
  const { deps, store } = makeDeps(repo);
  let fetches = 0;
  let tipReads = 0;
  let xSha = "";
  let verifiedSha = "";
  const realRun = deps.cmd.run;
  deps.cmd = {
    run: async (file, args, o) => {
      const res = await realRun(file, args, o);
      if (file === "git" && args.includes("fetch")) fetches++;
      // the 4th `rev-parse HEAD` after the sync's own fetch reads the
      // pre-trailer tip — the LAST verification the pipeline makes. A
      // commit landing right after it used to be picked up by a fresh
      // rev-parse and go to the auditor unreviewed.
      if (
        !xSha &&
        fetches === 2 &&
        file === "git" &&
        args.at(-2) === "rev-parse" &&
        args.at(-1) === "HEAD" &&
        ++tipReads === 4
      ) {
        verifiedSha = res.stdout.trim();
        writeFileSync(join(repo, "x-after-gate.txt"), "x\n");
        gitR(repo, ["add", "."]);
        gitR(repo, ["commit", "-m", "feat: after-gate"]);
        xSha = gitR(repo, ["rev-parse", "HEAD"]);
      }
      return res;
    },
  };
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.ok(xSha, "the injection never ran");
  assert.equal(res.status, "auditing");
  const row = store.releasesByStatuses(["auditing"])[0]!;
  // the audit is bound to the verified tip — X is neither recorded nor
  // pushed by the publish step (it pushes head_sha explicitly)
  assert.equal(row.head_sha, verifiedSha);
  assert.notEqual(row.head_sha, xSha);
});

test("PLUG-217 Б1: a commit slipped in before the docs trailer is refused", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo);
  const realRun = deps.cmd.run;
  let xSha = "";
  deps.cmd = {
    run: async (file, args, o) => {
      const res = await realRun(file, args, o);
      // `log -1 --format=%B` is the first call of applyDocsTrailer —
      // right after the pre-trailer tip read. A commit landing here
      // puts real diff between the checked tip and the trailer commit.
      if (
        !xSha &&
        file === "git" &&
        args.includes("log") &&
        args.includes("--format=%B")
      ) {
        writeFileSync(join(repo, "x-mid-trailer.txt"), "x\n");
        gitR(repo, ["add", "."]);
        gitR(repo, ["commit", "-m", "feat: mid-trailer"]);
        xSha = gitR(repo, ["rev-parse", "HEAD"]);
      }
      return res;
    },
  };
  await assert.rejects(
    runRelease(
      { taskKey: "PLUG-1", caller: COORD, noDocs: "no docs needed" },
      deps,
    ),
    (e: unknown) =>
      (e as OrchestratorError).code === "unreviewed-commits" &&
      /во время записи трейлера/.test((e as OrchestratorError).message),
  );
});

test("PLUG-217: a stale queued request on a stopped executor does not block release", async () => {
  const { repo } = makeRepo();
  // confirmed-idle thread; the newest journal event is a queued request
  // OLDER than the fresh window — a request that never reached
  // turn/started, not a live turn
  const stale = makeDeps(repo, {
    execStatus: "idle",
    execEvents: () => [
      {
        seq: 9,
        type: "client/turn/requested",
        createdAt: Date.now() - 10 * 60 * 1000,
        data: {},
      },
    ],
  });
  const res = await runRelease(
    { taskKey: "PLUG-1", caller: COORD },
    stale.deps,
  );
  assert.equal(res.status, "auditing");

  // a request that pre-dates the last completed turn is not a live turn
  // either even when it is still fresh — in a desc-ordered feed such a
  // request can never head the list: the fresher completion does
  const beforeDone = makeDeps(repo, {
    execStatus: "idle",
    execEvents: () => [
      {
        seq: 9,
        type: "turn/completed",
        createdAt: Date.now() - 10_000,
        data: {},
      },
      {
        seq: 8,
        type: "client/turn/requested",
        createdAt: Date.now() - 30_000,
        data: {},
      },
    ],
  });
  const res2 = await runRelease(
    { taskKey: "PLUG-1", caller: COORD },
    beforeDone.deps,
  );
  assert.equal(res2.status, "auditing");

  // a FRESH request newer than the last completion is a real queued turn
  const fresh = makeDeps(repo, {
    execStatus: "idle",
    execEvents: () => [
      {
        seq: 9,
        type: "client/turn/requested",
        createdAt: Date.now(),
        data: {},
      },
      {
        seq: 8,
        type: "turn/completed",
        createdAt: Date.now() - 60_000,
        data: {},
      },
    ],
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, fresh.deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /идёт ход/.test((e as OrchestratorError).message),
  );
});

test("PLUG-217: rebase — a foreign empty commit is not excused by the pre-range's empty slots", async () => {
  const { repo, seed } = makeRepo();
  // an empty-diff commit inside the range the rebase will rewrite — it
  // has no patch-id, and the rebase drops it, freeing a «slot» that the
  // old count matching would excuse ANY foreign empty commit with
  gitR(repo, ["commit", "--allow-empty", "-m", "chore: empty slot"]);
  const { deps, store } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: { proj_main: { sync: "rebase" } },
    }),
  });
  // advance main so the rebase actually rewrites the range
  writeFileSync(join(seed, "adv.txt"), "adv\n");
  gitR(seed, ["add", "."]);
  gitR(seed, ["commit", "-m", "chore: advance"]);
  gitR(seed, ["push", "origin", "main"]);
  const realRun = deps.cmd.run;
  let xSha = "";
  deps.cmd = {
    run: async (file, args, o) => {
      const res = await realRun(file, args, o);
      if (!xSha && file === "git" && args.includes("rebase")) {
        // a foreign EMPTY commit — no patch-id, different message: only
        // identity matching can call it foreign
        gitR(repo, ["commit", "--allow-empty", "-m", "feat: foreign empty"]);
        xSha = gitR(repo, ["rev-parse", "HEAD"]);
      }
      return res;
    },
  };
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "unreviewed-commits" &&
      (e as OrchestratorError).message.includes(xSha.slice(0, 7)),
  );
  const failed = store.releasesByStatuses(["failed"])[0]!;
  const rec = JSON.parse(failed.pipeline_shas ?? "[]") as string[];
  assert.ok(!rec.includes(xSha));
});

// ── PLUG-230: пост-проверка по правилам проекта (§2 шаг 7) ────────────

test("PLUG-230: пост-проверка — коммиты подписи commitIdentity «repo» без находок", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "repo",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: { proj_main: {} },
    }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  // every published commit is signed by the copy's own git config —
  // «repo» resolves to it and the rescan stays silent (the releaseId 1
  // false positive flagged them all «commitIdentity не задан»).
  assert.ok(
    !sent.some((m) => m.includes("пост-проверка")),
    `unexpected post-check message: ${JSON.stringify(sent)}`,
  );
});

test("PLUG-230: пост-проверка — чужой автор в выложенном диапазоне это находка", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "repo",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: { proj_main: {} },
    }),
  });
  // a commit signed by someone else inside the pushed range — the
  // release row is seeded mid-publish (past step 4) to reach step 7.
  writeFileSync(join(repo, "foreign.txt"), "x\n");
  gitR(repo, ["add", "."]);
  gitR(repo, [
    "-c", "user.name=Foreign", "-c", "user.email=foreign@x.io",
    "commit", "-m", "feat: foreign",
  ]);
  const headSha = gitR(repo, ["rev-parse", "HEAD"]);
  const r = store.insertRelease({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", repoPath: repo, branch: "feat-x",
    targetAction: "push", targetBranch: "main",
  });
  store.updateRelease(r.id, {
    status: "publishing",
    headSha,
    remoteBaseSha: gitR(repo, ["rev-parse", "origin/main"]),
  });
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  assert.ok(
    sent.some(
      (m) => m.includes("пост-проверка") && m.includes("личность автора"),
    ),
    `expected a commit-identity finding, got: ${JSON.stringify(sent)}`,
  );
});

test("PLUG-230: пост-проверка — leaks.allow проекта уважается", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "repo",
      defaults: {
        target: { action: "push", branch: "main" },
        checks: [],
        public: true,
        leaks: { allow: ["docs/"] },
      },
      projects: { proj_main: {} },
    }),
  });
  // the same positive sample under an allow-listed prefix and outside
  // it; a fixture-prefix path in a third file — only the unlisted
  // positive sample may surface in the rescan findings (§4 r8).
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "docs/plan.md"), `build in ${LEAK_HOME_PATH}\n`);
  writeFileSync(join(repo, "src/leak.txt"), `build in ${LEAK_HOME_PATH}\n`);
  writeFileSync(join(repo, "src/ok.txt"), `build in ${SAFE_HOME_PATH}\n`);
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "chore: paths"]);
  const headSha = gitR(repo, ["rev-parse", "HEAD"]);
  const r = store.insertRelease({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", repoPath: repo, branch: "feat-x",
    targetAction: "push", targetBranch: "main",
  });
  store.updateRelease(r.id, {
    status: "publishing",
    headSha,
    remoteBaseSha: gitR(repo, ["rev-parse", "origin/main"]),
  });
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  const msg = sent.find((m) => m.includes("повторный скан"));
  assert.ok(msg, `expected rescan findings, got: ${JSON.stringify(sent)}`);
  assert.ok(msg.includes("src/leak.txt"));
  assert.ok(!msg.includes("docs/plan.md"));
});

// ── §6 r8: проект настройки падает закрыто (PLUG-231) ────────────────

/** A cmd/bbCli/localHostId set for settingsProjectId unit tests —
 * real git passes through, `worktree list`/`remote get-url` and
 * `project list` are stubbed per test. */
function resolverDeps(opts: {
  projects?: unknown[];
  hostId?: string;
  projectList?: () => BbCliResult;
  worktreeList?: string;
  worktreeExit?: number;
  remoteUrl?: string;
}) {
  const cmd: CmdRunner = {
    run: async (file, args, o) => {
      if (file === "git" && args.includes("worktree")) {
        if (opts.worktreeList !== undefined || opts.worktreeExit !== undefined) {
          return {
            exitCode: opts.worktreeExit ?? 0,
            stdout: opts.worktreeList ?? "",
            stderr: "",
          };
        }
      }
      if (
        file === "git" &&
        args.includes("remote") &&
        opts.remoteUrl !== undefined
      ) {
        return { exitCode: 0, stdout: `${opts.remoteUrl}\n`, stderr: "" };
      }
      try {
        const out = execFileSync(file, args, {
          cwd: o?.cwd, encoding: "utf8", input: o?.stdin,
        });
        return { exitCode: 0, stdout: out, stderr: "" };
      } catch (e: unknown) {
        const x = e as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: x.status ?? 1, stdout: x.stdout ?? "", stderr: x.stderr ?? "" };
      }
    },
  };
  const bbCli: BbCli = {
    run: async () =>
      opts.projectList
        ? opts.projectList()
        : ok(JSON.stringify(opts.projects ?? [])),
  };
  return { cmd, bbCli, localHostId: () => opts.hostId ?? "host_test" };
}

test("settingsProjectId r8: сбой bb project list и мусорный JSON → отказ", async () => {
  const { repo } = makeRepo();
  for (const projectList of [
    () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
    () => ok("not json at all"),
    () => ok("{}"),
  ]) {
    await assert.rejects(
      settingsProjectId(resolverDeps({ projectList }), repo, "proj_main", null),
      (e: unknown) =>
        (e as OrchestratorError).code === "release-settings-unknown",
    );
  }
});

test("settingsProjectId r8: realpath основного каталога → отказ", async () => {
  await assert.rejects(
    settingsProjectId(
      resolverDeps({
        worktreeList: "worktree /gone/no-such-dir\nHEAD 0\ndetached\n",
      }),
      "/anywhere",
      "proj_main",
      null,
    ),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-settings-unknown",
  );
});

test("settingsProjectId r8: несуществующий и чужой-hostId пути — не кандидаты, не ошибка", async () => {
  const { repo } = makeRepo();
  const res = await settingsProjectId(
    resolverDeps({
      projects: [
        { id: "proj_gone", sources: [{ type: "local_path", path: "/gone/nope", isDefault: true }] },
        { id: "proj_far", sources: [{ type: "local_path", path: repo, isDefault: true, hostId: "host_other" }] },
        { id: "proj_main", sources: [{ type: "local_path", path: repo, isDefault: true }] },
      ],
    }),
    repo,
    "proj_del",
    null,
  );
  // only proj_main is a real candidate — no error, no ambiguity
  assert.equal(res, "proj_main");
});

test("settingsProjectId r8: второстепенный путь не делает кандидатом", async () => {
  const { repo } = makeRepo();
  const res = await settingsProjectId(
    resolverDeps({
      projects: [
        { id: "proj_sec", sources: [
          { type: "local_path", path: repo, isDefault: false },
          { type: "local_path", path: "/other/nope", isDefault: true },
        ] },
        { id: "proj_main", sources: [{ type: "local_path", path: repo, isDefault: true }] },
      ],
    }),
    repo,
    "proj_del",
    null,
  );
  // a secondary-source match must not join the candidate set — else
  // proj_sec + proj_main would be ambiguous, not proj_main.
  assert.equal(res, "proj_main");
});

test("settingsProjectId r8: несколько кандидатов → проект делегирования если среди них, иначе отказ", async () => {
  const { repo } = makeRepo();
  const projects = [
    { id: "proj_a", sources: [{ type: "local_path", path: repo, isDefault: true }] },
    { id: "proj_b", sources: [{ type: "local_path", path: repo, isDefault: true }] },
  ];
  assert.equal(
    await settingsProjectId(resolverDeps({ projects }), repo, "proj_a", null),
    "proj_a",
  );
  await assert.rejects(
    settingsProjectId(resolverDeps({ projects }), repo, "proj_del", null),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-settings-ambiguous",
  );
});

test("settingsProjectId r8: bare-копия — совпадение по origin с явной записью", async () => {
  const base = mkdtempSync(join(tmpdir(), "rel-bare-"));
  const bare = join(base, "bare.git");
  execFileSync("git", ["init", "--bare", bare]);
  const projDir = mkdtempSync(join(tmpdir(), "projdir-"));
  const cfg = parseReleaseConfig(
    JSON.stringify({
      defaults: { target: { action: "push", branch: "main" } },
      projects: { proj_o: {} },
    }),
  ).config!;
  const res = await settingsProjectId(
    resolverDeps({
      remoteUrl: "git@GH.Example:Team/Repo.git",
      projects: [
        {
          id: "proj_o",
          gitRemoteUrl: "https://u:t@gh.example:8443/Team/Repo.git",
          sources: [{ type: "local_path", path: projDir, isDefault: true }],
        },
      ],
    }),
    bare,
    "proj_del",
    cfg,
  );
  assert.equal(res, "proj_o");
});

test("settingsProjectId r8: совпадение по origin без явной записи и без пути → unknown", async () => {
  const base = mkdtempSync(join(tmpdir(), "rel-bare-"));
  const bare = join(base, "bare.git");
  execFileSync("git", ["init", "--bare", bare]);
  const cfg = parseReleaseConfig(
    JSON.stringify({
      defaults: { target: { action: "push", branch: "main" } },
      projects: {},
    }),
  ).config!;
  // no `projects.proj_o` entry → the origin candidate is dropped
  await assert.rejects(
    settingsProjectId(
      resolverDeps({
        remoteUrl: "git@gh.example:Team/Repo.git",
        projects: [
          {
            id: "proj_o",
            gitRemoteUrl: "https://gh.example/Team/Repo",
            sources: [{ type: "local_path", path: base, isDefault: true }],
          },
        ],
      }),
      bare,
      "proj_del",
      cfg,
    ),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-settings-unknown",
  );
  // an explicit entry but a path missing on this machine → dropped too
  const cfg2 = parseReleaseConfig(
    JSON.stringify({
      defaults: { target: { action: "push", branch: "main" } },
      projects: { proj_o: {} },
    }),
  ).config!;
  await assert.rejects(
    settingsProjectId(
      resolverDeps({
        remoteUrl: "git@gh.example:Team/Repo.git",
        projects: [
          {
            id: "proj_o",
            gitRemoteUrl: "https://gh.example/Team/Repo",
            sources: [{ type: "local_path", path: "/gone/nope", isDefault: true }],
          },
        ],
      }),
      bare,
      "proj_del",
      cfg2,
    ),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-settings-unknown",
  );
});

test("settingsProjectId r8: url origin не попадает в отказ", async () => {
  const secret = "sekret-token-xyz";
  await assert.rejects(
    settingsProjectId(
      resolverDeps({
        worktreeList: "worktree /gone/x\nbare\n",
        remoteUrl: `https://u:${secret}@h.example/o/r`,
        projects: [],
      }),
      "/anywhere",
      "proj_del",
      null,
    ),
    (e: unknown) => {
      const x = e as OrchestratorError;
      assert.equal(x.code, "release-settings-unknown");
      assert.ok(!x.message.includes(secret));
      assert.ok(!(x.hint ?? "").includes(secret));
      return true;
    },
  );
});

test("release r8: неоднозначные проекты → отказ release-settings-ambiguous", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo, {
    projects: [
      { id: "proj_a", sources: [{ type: "local_path", path: repo, isDefault: true }] },
      { id: "proj_b", sources: [{ type: "local_path", path: repo, isDefault: true }] },
    ],
  });
  // the delegation project (proj_main) is not among the candidates
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-settings-ambiguous",
  );
});

test("release r8: сбой git в копии → отказ release-settings-unknown", async () => {
  const { deps } = makeDeps("/gone/nope", {
    execPath: "/gone/nope",
    execBranch: "feat-x",
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-settings-unknown",
  );
});

test("release r8: settings_project_id пишется на шаге 1 и живёт в записи", async () => {
  const { repo } = makeRepo();
  const { deps, store } = makeDeps(repo);
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.settingsProjectId, "proj_main");
  assert.equal(
    store.getRelease(res.releaseId)!.settings_project_id,
    "proj_main",
  );
});

test("release r8: publish берёт проект из записи — сбой project list не страшен", async () => {
  const { repo } = makeRepo();
  const ghCalls: string[][] = [];
  const { deps, store, sent } = makeDeps(repo, {
    ghCalls,
    projectListFail: true,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "pr", branch: "main" }, checks: [] },
      projects: { proj_th: { threadIds: false }, proj_main: {} },
    }),
  });
  // a pre-resolved row (as step 1 left it): publish must read
  // settings_project_id and never call `project list` — a CLI failure
  // at step 6 must not change threadIds.
  writeFileSync(join(repo, "f2.txt"), "y\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: more"]);
  const headSha = gitR(repo, ["rev-parse", "HEAD"]);
  const r = store.insertRelease({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", repoPath: repo, branch: "feat-x",
    targetAction: "pr", targetBranch: "main",
    settingsProjectId: "proj_th",
  });
  store.updateRelease(r.id, {
    status: "publishing",
    headSha,
    remoteBaseSha: gitR(repo, ["rev-parse", "origin/main"]),
  });
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  const create = ghCalls.find((a) => a[0] === "pr" && a[1] === "create")!;
  // proj_th has threadIds off — the «Источник» line proves the
  // RECORDED project drove the publish, not proj_main's default.
  assert.equal(create[create.indexOf("--body") + 1], "");
  assert.ok(!sent.some((m) => m.includes("находк")), JSON.stringify(sent));
});

test("release r8: пост-проверка — пропуск скана это строка, а не молчание", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "newbr" }, checks: [] },
      projects: { proj_main: {} },
    }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  // first release onto a new branch: no remote base → the skipped
  // rescan is a coordinator line, not silence (§2 шаг 7, r8).
  assert.ok(
    sent.some(
      (m) => m.includes("пост-проверка") && m.includes("скан пропущен"),
    ),
    `expected the skip line, got: ${JSON.stringify(sent)}`,
  );
});

test("release r8: пост-проверка pr — commitIdentity repo + leaks.allow без находок", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "repo",
      defaults: {
        target: { action: "pr", branch: "main" },
        checks: [],
        leaks: { allow: ["docs/"] },
      },
      projects: { proj_main: {} },
    }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  store.setStatus(
    store.latestDelegationByTaskAndLevel("PLUG-1", "release-audit")!.id,
    "done",
  );
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  assert.ok(
    !sent.some((m) => m.includes("находк")),
    `unexpected findings, got: ${JSON.stringify(sent)}`,
  );
});

test("release r8: postPublish — старая запись решает проект заново, не делегирования", async () => {
  const { repo, seed } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    projects: [
      { id: "proj_repo", sources: [{ type: "local_path", path: repo, isDefault: true }] },
      { id: "proj_main", sources: [{ type: "local_path", path: "/gone/other", isDefault: true }] },
    ],
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_repo: {
          postPublish: { checkout: seed, branch: "main", reloadPlugins: false },
        },
        proj_main: {},
      },
    }),
  });
  // a PRE-R8 row: no settings_project_id — the resolver must run anew
  // (§6 п.6); a silent delegation fallback would find no postPublish.
  writeFileSync(join(repo, "f2.txt"), "y\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: more"]);
  const headSha = gitR(repo, ["rev-parse", "HEAD"]);
  const r = store.insertRelease({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", repoPath: repo, branch: "feat-x",
    targetAction: "push", targetBranch: "main",
  });
  store.updateRelease(r.id, {
    status: "publishing",
    headSha,
    remoteBaseSha: gitR(repo, ["rev-parse", "origin/main"]),
  });
  const s = await pumpReleases(deps);
  assert.equal(s.published, 1);
  // proj_repo (resolved anew) drove postPublish — the checkout caught
  // up with the pushed tip.
  assert.equal(gitR(seed, ["rev-parse", "HEAD"]), headSha);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /postPublish: копия обновлена/);
});

test("release r8: postPublish — сбой резолвера → строка, postPublish не выполняется", async () => {
  const { repo, seed } = makeRepo();
  const seedHead = gitR(seed, ["rev-parse", "HEAD"]);
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    projectListFail: true,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_main: {
          postPublish: { checkout: seed, branch: "main", reloadPlugins: false },
        },
      },
    }),
  });
  writeFileSync(join(repo, "f2.txt"), "y\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: more"]);
  const headSha = gitR(repo, ["rev-parse", "HEAD"]);
  const r = store.insertRelease({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", repoPath: repo, branch: "feat-x",
    targetAction: "push", targetBranch: "main",
  });
  store.updateRelease(r.id, {
    status: "publishing",
    headSha,
    remoteBaseSha: gitR(repo, ["rev-parse", "origin/main"]),
  });
  const s = await pumpReleases(deps);
  // the push itself still landed — only the settings resolution failed
  assert.equal(s.published, 1);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /postPublish: проект настройки не определён/);
  // fail closed: postPublish did NOT run even though the delegation
  // project carries a postPublish config.
  assert.equal(gitR(seed, ["rev-parse", "HEAD"]), seedHead);
});

test("machine scan r8: префиксы-фикстуры — не находки, и по каждому вхождению", async () => {
  const scan = (added: { file: string; line: number; text: string }[], body = "") =>
    machineScan(GL_EMPTY, {
      ...SCAN_BASE,
      commits: [{ ...SCAN_BASE.commits[0]!, body }],
      added,
    });
  // negative samples — silence in added lines and in commit text
  let f = await scan(
    [
      { file: "f.ts", line: 1, text: `x = ${SAFE_HOME_PATH}` },
      { file: "g.ts", line: 1, text: `y = ${SAFE_USERS_PATH}` },
    ],
    `note ${SAFE_HOME_PATH}`,
  );
  assert.ok(!f.some((x) => x.category === 3), JSON.stringify(f));
  // positive samples — a finding in added lines and in commit text
  f = await scan(
    [{ file: "f.ts", line: 1, text: `x = ${LEAK_HOME_PATH}` }],
    `see ${LEAK_USERS_PATH}`,
  );
  assert.ok(f.some((x) => x.category === 3 && x.file === "f.ts"));
  assert.ok(f.some((x) => x.category === 3 && x.file === null));
  // a fixture prefix next to a real path in one line — still a finding
  f = await scan(
    [{ file: "f.ts", line: 1, text: MIXED_PATH_LINE }],
    MIXED_PATH_LINE,
  );
  assert.ok(f.some((x) => x.category === 3 && x.file === "f.ts"));
  assert.ok(f.some((x) => x.category === 3 && x.file === null));
  // a fixture prefix GLUED to a real path with no separator — the
  // exempt match must not eat the real path's leading slash (ревью
  // PLUG-231 заход 2); a finding in added lines and in commit text
  f = await scan(
    [{ file: "f.ts", line: 1, text: `x = ${GLUED_PATH_LINE}` }],
    `see ${GLUED_PATH_LINE}`,
  );
  assert.ok(f.some((x) => x.category === 3 && x.file === "f.ts"));
  assert.ok(f.some((x) => x.category === 3 && x.file === null));
});

// ── §4.1 r28.1: «задача без кода» — вливать нечего ─────────────────────

test("§4.1 r28.1: no-code round with 0 commits — release отказывает «вливать нечего»", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo, { execNoCode: true, execCommits: 0 });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => {
      const err = e as OrchestratorError;
      assert.equal(err.code, "release-refused");
      assert.match(err.message, /задача без кода: вливать нечего/);
      return true;
    },
  );
});

test("§4.1 r28.1: no-code round без записанных коммитов — тот же отказ", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo, { execNoCode: true, execCommits: null });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /задача без кода: вливать нечего/.test((e as OrchestratorError).message),
  );
});

test("§4.1 r28.1: no-code round WITH commits — release идёт как обычно", async () => {
  const { repo } = makeRepo();
  const { deps } = makeDeps(repo, { execNoCode: true });
  // commits appeared anyway — the pipeline runs its normal gates
  const res = await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  assert.equal(res.status, "auditing");
});

// ── r10: детерминированная выкладка (§2 п.0–6) ─────────────────────────

const auditDone = async (
  deps: ReleaseDeps,
  store: DelegationStore,
  key = "PLUG-1",
) => {
  const audit = store.latestDelegationByTaskAndLevel(key, "release-audit")!;
  store.setStatus(audit.id, "done");
  return pumpReleases(deps);
};

test("r10 п.0: одна выкладка в цель — repo_root + target_branch", async () => {
  const { repo } = makeRepo();
  const { deps, store } = makeDeps(repo);
  const mainDir = execFileSync(
    "git", ["-C", repo, "worktree", "list", "--porcelain"],
    { encoding: "utf8" },
  ).split("\n").find((l) => l.startsWith("worktree "))!.slice(9);
  const root = execFileSync("realpath", [mainDir], { encoding: "utf8" }).trim();
  // другая задача уже выкладывается в ту же цель — через ДРУГУЮ копию
  store.insertRelease({
    taskKey: "PLUG-2", projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    repoPath: "/other/copy", branch: "b2",
    targetAction: "push", targetBranch: "main", repoRoot: root,
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) => /уже идёт выкладка/.test((e as OrchestratorError).message),
  );
  // атомарность — прямой второй insert той же цели тоже отказан
  assert.throws(
    () =>
      store.insertRelease({
        taskKey: "PLUG-3", projectId: "proj_main",
        coordinatorThreadId: "thr_coord", repoPath: "/c3", branch: "b",
        targetAction: "push", targetBranch: "main", repoRoot: root,
      }),
    /уже идёт выкладка/,
  );
  // другая цель (другая ветка) — не конфликт
  const ok = store.insertRelease({
    taskKey: "PLUG-4", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", repoPath: "/c4", branch: "b",
    targetAction: "push", targetBranch: "dev", repoRoot: root,
  });
  assert.equal(ok.status, "auditing");
});

test("r10 п.1: push — одна строка успеха, пост-проверка внутри неё", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const lines = sent.filter((m) => /выложено|пост-проверка/.test(m));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /выложено PLUG-1: [0-9a-f]{7} в main; задача done/);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.ok(rel.notified_at != null && rel.notified_at > 0);
});

test("r10 п.5: падение между публикацией и строкой — строка в следующем такте", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, db } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  // крах ДО сохранения строки: ни отметки, ни текста — досмотр
  // собирает строку заново (работа повторяется — сохранять нечего)
  db.prepare(
    `UPDATE releases SET notified_at = NULL, notice_text = NULL WHERE id = ?`,
  ).run(rel.id);
  sent.length = 0;
  await pumpReleases(deps);
  assert.ok(sent.some((m) => /выложено PLUG-1:/.test(m)), "досмотр дослал строку");
  assert.ok(sent.length > 0);
});

test("r10 п.2: postPublish — ff копии, перезагрузка изменённых плагинов", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "x.txt"), "1\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: plugin change"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
      { id: "otherplug", rootDir: join(seed, "plugins", "otherplug") },
    ],
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_main: {
          postPublish: { checkout: seed, branch: "main", reloadPlugins: true },
        },
      },
    }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  // копия догнала удалённую вершину
  const remoteTip = execFileSync(
    "git", ["-C", repo, "rev-parse", "origin/main"], { encoding: "utf8" },
  ).trim();
  assert.equal(gitR(seed, ["rev-parse", "HEAD"]), remoteTip);
  assert.ok(
    calls.some((c) => c.join(" ") === "plugin reload fakeplug"),
    "изменённый плагин перезагружен",
  );
  assert.ok(
    !calls.some((c) => c.join(" ") === "plugin reload otherplug"),
    "неизменённый плагин НЕ перезагружен",
  );
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /postPublish: копия обновлена; перезагружено: fakeplug/);
});

test("r10 п.2: postPublish — orchestrator перезагружает сам себя автоматизацией", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "bb-plugin-orchestrator", "src"), {
    recursive: true,
  });
  writeFileSync(join(repo, "plugins", "bb-plugin-orchestrator", "src", "x.ts"), "");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: orchestrator change"]);
  const { deps, store, sent, calls, comments } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    pluginList: () => [
      {
        id: "orchestrator",
        rootDir: join(seed, "plugins", "bb-plugin-orchestrator"),
      },
    ],
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_main: {
          postPublish: { checkout: seed, branch: "main", reloadPlugins: true },
        },
      },
    }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const auto = calls.find((c) => c[0] === "automation" && c[1] === "create");
  assert.ok(auto, "создана разовая автоматизация самоперезагрузки");
  // ревью Б1: --name обязателен, --timeout 5m (скрипт ждёт ~3 мин),
  // --interpreter sh; --project — проект координатора.
  const flag = (name: string) => auto![auto!.indexOf(name) + 1];
  assert.equal(flag("--name"), "release PLUG-1 reload");
  assert.equal(flag("--interpreter"), "sh");
  assert.equal(flag("--timeout"), "5m");
  assert.equal(flag("--project"), "proj_main");
  const script = flag("--script")!;
  assert.match(script, /bb plugin reload orchestrator/);
  // ревью заход 2: как у плагина — queue-if-active, не steer
  assert.match(script, /bb thread tell "\$COORD" --mode queue/);
  // r11: значения в скрипт — base64, не интерполяцией; декодируем TEXT.
  const b64 = /TEXT=\$\(printf %s '([A-Za-z0-9+/=]+)' \| base64 -d\)/.exec(
    script,
  )![1]!;
  assert.match(
    Buffer.from(b64, "base64").toString("utf8"),
    /\[orchestrator\] выложено PLUG-1/,
  );
  // строку итога шлёт автоматизация, не сам такт
  assert.ok(!sent.some((m) => /выложено PLUG-1/.test(m)));
  // §2 шаг 6: комментарий «выложено» в задачу пишет сам плагин
  assert.ok(comments.some((c) => /выложено PLUG-1/.test(c)));
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.ok(rel.notified_at != null && rel.notified_at > 0);
  // ревью Б3: после «перезапуска» такт конвейера молчит — запись уже
  // подтверждена и досмотр ничего не досылает.
  sent.length = 0;
  await pumpReleases(deps);
  await pumpReleases(deps);
  assert.equal(sent.length, 0);
});

const PR_CFG = JSON.stringify({
  commitIdentity: "Agent <agent@x.io>",
  defaults: { target: { action: "pr", branch: "main" }, threadIds: false },
});

const publishPr = async (deps: ReleaseDeps, store: DelegationStore) => {
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  return auditDone(deps, store);
};

const ghView = (
  deps: ReleaseDeps,
  view: string | { exitCode: number; stdout: string; stderr: string },
) => {
  const orig = deps.cmd.run;
  deps.cmd = {
    run: async (file, args, o) => {
      if (file === "gh" && args[0] === "pr" && args[1] === "view") {
        return typeof view === "string"
          ? { exitCode: 0, stdout: view, stderr: "" }
          : view;
      }
      return orig(file, args, o);
    },
  };
};

test("r10 п.1/п.3: PR открыт — строка «слежу до влития», MERGED → задача done", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CFG,
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(rel.pr_state, "open");
  assert.match(
    sent.find((m) => /PR открыт/.test(m))!,
    /PR открыт PLUG-1: https:\/\/example\.test\/pr\/7; слежу до влития/,
  );
  ghView(deps, JSON.stringify({
    state: "MERGED", mergedAt: "2026-01-01",
    mergeCommit: { oid: "abcdef1234567890" },
  }));
  sent.length = 0;
  now += 6 * 60 * 1000; // следующий такт сторожа — после интервала опроса
  await pumpReleases(deps);
  const rel2 = store.getRelease(rel.id)!;
  assert.equal(rel2.pr_state, "merged");
  assert.ok(sent.some((m) => /PR влит PLUG-1: .*→ abcdef1$/.test(m)));
  assert.ok(calls.some((c) => c.join(" ").includes("--status done")));
});

test("r10 п.3: PR закрыт без влития — строка, 72 ч досмотра, потом конец", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CFG,
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  ghView(deps, JSON.stringify({ state: "CLOSED" }));
  now += 6 * 60 * 1000;
  await pumpReleases(deps);
  let fresh = store.getRelease(rel.id)!;
  assert.equal(fresh.pr_state, "closed");
  assert.ok(sent.some((m) => /PR закрыт без влития/.test(m)));
  sent.length = 0;
  // 72 ч — переоткрытия не было, слежение закончено молча
  now += 73 * 60 * 60 * 1000;
  await pumpReleases(deps);
  fresh = store.getRelease(rel.id)!;
  assert.equal(fresh.pr_state, "closed_final");
  assert.equal(sent.length, 0);
});

test("r10 п.3: PR висит 72 ч — одна строка, опрос идёт дальше до исхода", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, db } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CFG,
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  db.prepare(`UPDATE releases SET updated_at = ?, pr_checked_at = NULL WHERE id = ?`)
    .run(Date.now() - 73 * 60 * 60 * 1000, rel.id);
  ghView(deps, JSON.stringify({ state: "OPEN" }));
  await pumpReleases(deps);
  let fresh = store.getRelease(rel.id)!;
  // ревью Б5: «дальше молча» — флаг, не состояние; запись остаётся open
  assert.equal(fresh.pr_state, "open");
  assert.equal(fresh.pr_stale_notified, 1);
  assert.equal(sent.filter((m) => /висит 72 ч/.test(m)).length, 1);
  sent.length = 0;
  // следующий такт всё ещё опрашивает — молча, второй строки нет
  now += 6 * 60 * 1000;
  await pumpReleases(deps);
  assert.equal(sent.length, 0);
  assert.equal(store.getRelease(rel.id)!.pr_state, "open");
  // а влитие на 73+ часу всё же ловится — задача done, строка «PR влит»
  ghView(deps, JSON.stringify({
    state: "MERGED", mergedAt: "2026-01-01",
    mergeCommit: { oid: "cafe1234567890" },
  }));
  now += 6 * 60 * 1000;
  await pumpReleases(deps);
  fresh = store.getRelease(rel.id)!;
  assert.equal(fresh.pr_state, "merged");
  assert.ok(sent.some((m) => /PR влит PLUG-1: .*→ cafe123$/.test(m)));
});

test("r10 п.3: три сбоя gh подряд — строка «слежение невозможно»", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CFG,
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  ghView(deps, { exitCode: 1, stdout: "", stderr: "gh boom" });
  for (let i = 0; i < 3; i++) {
    now += 6 * 60 * 1000;
    await pumpReleases(deps);
  }
  const fresh = store.getRelease(rel.id)!;
  assert.equal(fresh.pr_state, "error");
  assert.equal(sent.filter((m) => /слежение за PR/.test(m)).length, 1);
});

// ── §18.3/§18.6: prProvider, prBody, requireNote (PLUG-248) ─────────

test("§18.3 config: command требует create+view argv, find необязателен", () => {
  const noView = parseReleaseConfig(
    JSON.stringify({
      projects: { p: { prProvider: { type: "command", create: ["/x/c"] } } },
    }),
  );
  assert.ok(
    noView.errors.some((e) => e.path === "projects.p.prProvider.view"),
  );
  const badArgv = parseReleaseConfig(
    JSON.stringify({
      projects: {
        p: { prProvider: { type: "command", create: ["/x/c"], view: [] } },
      },
    }),
  );
  assert.ok(
    badArgv.errors.some((e) => e.path === "projects.p.prProvider.view"),
  );
  const good = parseReleaseConfig(
    JSON.stringify({
      projects: {
        p: {
          prProvider: {
            type: "command",
            create: ["/x/c"],
            view: ["/x/v"],
            find: ["/x/f"],
          },
        },
      },
    }),
  );
  assert.equal(good.errors.length, 0);
  const r = resolveProject(good.config!, "p");
  assert.equal(r.prProvider.type, "command");
  assert.deepEqual(r.prProvider.create, ["/x/c"]);
  assert.deepEqual(r.prProvider.find, ["/x/f"]);
  // github/none — argv-ключи игнорируются с предупреждением
  const w = parseReleaseConfig(
    JSON.stringify({
      projects: { p: { prProvider: { type: "none", create: ["/x"] } } },
    }),
  );
  assert.equal(w.errors.length, 0);
  assert.ok(w.warnings.some((x) => x.path === "projects.p.prProvider.create"));
  assert.equal(resolveProject(w.config!, "p").prProvider.type, "none");
});

test("§18.6 config: prBody/requireNote — дефолты и переопределение", () => {
  const d = resolveProject(parseReleaseConfig(RELEASE_CFG).config!, "proj_main");
  assert.equal(d.prBody, "BB-Thread: {thread}\n\nBB-Task: {task}");
  assert.equal(d.requireNote, false);
  const c = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        prBody: "Источник: bb тред {thread}\n\nЗадача: {task}",
        requireNote: true,
      },
      projects: { p: { requireNote: false } },
    }),
  );
  assert.equal(c.errors.length, 0);
  const r = resolveProject(c.config!, "p");
  assert.equal(r.requireNote, false, "ключ проекта перекрывает defaults");
  assert.match(r.prBody, /^Источник: bb тред \{thread\}/);
  const bad = parseReleaseConfig(
    JSON.stringify({ projects: { p: { prBody: 42, requireNote: "yes" } } }),
  );
  assert.ok(bad.errors.some((e) => e.path === "projects.p.prBody"));
  assert.ok(bad.errors.some((e) => e.path === "projects.p.requireNote"));
});

test("§18.3 п.0: gh не авторизован — отказ шага 1 до аудита", async () => {
  const { repo } = makeRepo();
  const { deps, store, spawnCalls } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "pr", branch: "main" } },
    }),
    ghFallback: (args) =>
      args[0] === "auth"
        ? { exitCode: 1, stdout: "", stderr: "not logged in" }
        : undefined,
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      (e as OrchestratorError).code === "release-refused" &&
      /провайдер PR недоступен/.test((e as OrchestratorError).message),
  );
  assert.equal(spawnCalls.length, 0, "аудит не раздавался");
  assert.equal(
    store.releasesByStatuses(["auditing", "publishing", "published"]).length,
    0,
  );
});

test("§18.3 п.0: command без исполняемого файла — отказ шага 1", async () => {
  const { repo } = makeRepo();
  const { deps, spawnCalls } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "pr", branch: "main" },
        prProvider: {
          type: "command",
          create: ["/definitely/missing/pr-create"],
          view: ["/definitely/missing/pr-view"],
        },
      },
    }),
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      /провайдер PR недоступен/.test((e as OrchestratorError).message) &&
      /create/.test((e as OrchestratorError).message),
  );
  assert.equal(spawnCalls.length, 0);
});

test("§18.6 requireNote: без --kb/--no-kb — отказ шага 1", async () => {
  const { repo } = makeRepo();
  const { deps, spawnCalls } = makeDeps(repo, {
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "push", branch: "main" },
        requireNote: true,
      },
    }),
  });
  await assert.rejects(
    runRelease({ taskKey: "PLUG-1", caller: COORD }, deps),
    (e: unknown) =>
      /нужна заметка: --kb <заметка> или --no-kb <причина>/.test(
        (e as OrchestratorError).message,
      ),
  );
  assert.equal(spawnCalls.length, 0);
  // с одним из флагов приёмка проходит
  const res = await runRelease(
    { taskKey: "PLUG-1", caller: COORD, noKb: "не требуется" },
    deps,
  );
  assert.equal(res.status, "auditing");
});

test("§18.3 none: ветка опубликована, PR открой вручную, слежения нет", async () => {
  const { repo } = makeRepo();
  const ghCalls: string[][] = [];
  const { deps, store, sent, calls } = makeDeps(repo, {
    ghCalls,
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "pr", branch: "main" },
        prProvider: { type: "none" },
      },
    }),
  });
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(rel.pr_url, null);
  assert.equal(rel.pr_state, null, "слежения нет");
  assert.equal(ghCalls.length, 0, "gh не вызывался вообще");
  assert.ok(
    sent.some((m) =>
      /ветка опубликована PLUG-1: feat-x; PR открой вручную/.test(m),
    ),
    JSON.stringify(sent),
  );
  assert.ok(!sent.some((m) => /слежу до влития/.test(m)));
  assert.ok(calls.some((c) => c.join(" ").includes("--status in_review")));
  // и следующий такт ничего не добавляет — досмотр молчит
  sent.length = 0;
  await pumpReleases(deps);
  assert.equal(sent.length, 0);
});

/** §18.3 command-провайдер: sh-скрипт в tmpdir — ответ и захват
 * env/stdin файлами рядом со скриптом ($DIR). */
const writePrTool = (dir: string, name: string, body: string): string => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nDIR=$(dirname "$0")\n${body}\n`, {
    mode: 0o755,
  });
  return p;
};

const PR_CMD_CFG = (create: string, view: string, find?: string) =>
  JSON.stringify({
    commitIdentity: "Agent <agent@x.io>",
    defaults: {
      target: { action: "pr", branch: "main" },
      prProvider: {
        type: "command",
        create: [create],
        view: [view],
        ...(find ? { find: [find] } : {}),
      },
    },
  });

test("§18.3 command: create (env+stdin) → слежение через view", async () => {
  const { repo } = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "prtool-"));
  const create = writePrTool(
    dir,
    "pr-create",
    `cat > "$DIR/stdin.txt"
env | grep '^ORCH_' | sort > "$DIR/env.txt"
echo "https://example.test/pr/9"`,
  );
  const view = writePrTool(dir, "pr-view", `cat "$DIR/view.json"`);
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "OPEN", mergeCommit: null }),
  );
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CMD_CFG(create, view),
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(rel.pr_url, "https://example.test/pr/9");
  assert.equal(rel.pr_state, "open");
  // §18.6: тело по умолчанию — BB-Thread/BB-Task — ушло в stdin
  assert.equal(
    readFileSync(join(dir, "stdin.txt"), "utf8"),
    "BB-Thread: thr_coord\n\nBB-Task: PLUG-1",
  );
  const env = readFileSync(join(dir, "env.txt"), "utf8");
  assert.match(env, /ORCH_BRANCH=feat-x/);
  assert.match(env, /ORCH_TARGET=main/);
  assert.match(env, /ORCH_TITLE=do x/);
  assert.ok(
    sent.some((m) =>
      /PR открыт PLUG-1: https:\/\/example\.test\/pr\/9/.test(m)
    ),
    JSON.stringify(sent),
  );
  // §18.3: слежение — через command.view
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "MERGED", mergeCommit: "cafe1234567" }),
  );
  now += 6 * 60 * 1000;
  sent.length = 0;
  await pumpReleases(deps);
  assert.equal(store.getRelease(rel.id)!.pr_state, "merged");
  assert.ok(sent.some((m) => /PR влит PLUG-1: .*→ cafe123/.test(m)));
  assert.ok(calls.some((c) => c.join(" ").includes("--status done")));
});

test("§18.3 command: find → «PR обновлён» без create", async () => {
  const { repo } = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "prtool-"));
  const create = writePrTool(
    dir,
    "pr-create",
    `echo x >> "$DIR/calls.txt"; cat "$DIR/url.txt"`,
  );
  const view = writePrTool(dir, "pr-view", `cat "$DIR/view.json"`);
  const find = writePrTool(
    dir,
    "pr-find",
    `cat "$DIR/find.txt" 2>/dev/null || true`,
  );
  writeFileSync(join(dir, "url.txt"), "https://example.test/pr/9\n");
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "OPEN", mergeCommit: null }),
  );
  writeFileSync(join(dir, "find.txt"), "");
  const { deps, store, sent, exec, bindReview } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CMD_CFG(create, view, find),
  });
  await publishPr(deps, store);
  const rel1 = store.releasesByStatuses(["published"])[0]!;
  assert.equal(rel1.pr_url, "https://example.test/pr/9");
  // повторная выкладка: find отвечает URL, записанным у этой задачи
  // этим координатором → «PR обновлён», create не вызывается
  writeFileSync(join(dir, "find.txt"), "https://example.test/pr/9\n");
  writeFileSync(join(repo, "more.txt"), "more\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: more"]);
  const tip2 = gitR(repo, ["rev-parse", "HEAD"]);
  store.setRoundResult(exec.id, {
    branch: "feat-x",
    sha: tip2,
    commits: 2,
    dirty: false,
  });
  bindReview(tip2);
  sent.length = 0;
  await publishPr(deps, store);
  const rels = store.releasesByStatuses(["published"]);
  assert.equal(rels.length, 2);
  assert.equal(rels[1]!.pr_url, "https://example.test/pr/9");
  assert.ok(
    sent.some((m) => /PR обновлён PLUG-1/.test(m)),
    JSON.stringify(sent),
  );
  assert.equal(
    readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n").length,
    1,
    "create вызывался один раз",
  );
});

test("§18.3 command: find вернул чужой PR — release в него не пишет", async () => {
  const { repo } = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "prtool-"));
  const create = writePrTool(dir, "pr-create", `echo "https://example.test/pr/9"`);
  const view = writePrTool(dir, "pr-view", `cat "$DIR/view.json"`);
  // URL никогда не был записан выкладкой этой задачи этим координатором
  const find = writePrTool(dir, "pr-find", `echo "https://example.test/pr/77"`);
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "OPEN", mergeCommit: null }),
  );
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CMD_CFG(create, view, find),
  });
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["failed"])[0]!;
  assert.match(rel.error ?? "", /создан не этим release/);
  assert.ok(sent.some((m) => /упала на публикации/.test(m)));
});

test("§18.3 command без find: view OPEN → переиспользование pr_url", async () => {
  const { repo } = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "prtool-"));
  const create = writePrTool(
    dir,
    "pr-create",
    `echo x >> "$DIR/calls.txt"; cat "$DIR/url.txt"`,
  );
  const view = writePrTool(dir, "pr-view", `cat "$DIR/view.json"`);
  writeFileSync(join(dir, "url.txt"), "https://example.test/pr/9\n");
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "OPEN", mergeCommit: null }),
  );
  const { deps, store, sent, exec, bindReview } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CMD_CFG(create, view),
  });
  await publishPr(deps, store);
  assert.equal(
    store.releasesByStatuses(["published"])[0]!.pr_url,
    "https://example.test/pr/9",
  );
  const nextRound = () => {
    writeFileSync(join(repo, `more-${Date.now()}-${Math.random()}.txt`), "m\n");
    gitR(repo, ["add", "."]);
    gitR(repo, ["commit", "-m", "feat: more"]);
    const tip = gitR(repo, ["rev-parse", "HEAD"]);
    store.setRoundResult(exec.id, {
      branch: "feat-x",
      sha: tip,
      commits: 2,
      dirty: false,
    });
    bindReview(tip);
  };
  // заход 2: view OPEN → pr_url переиспользуется, create не вызывается
  nextRound();
  sent.length = 0;
  await publishPr(deps, store);
  const rels = store.releasesByStatuses(["published"]);
  assert.equal(rels[1]!.pr_url, "https://example.test/pr/9");
  assert.ok(sent.some((m) => /PR обновлён PLUG-1/.test(m)));
  assert.equal(
    readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n").length,
    1,
  );
  // заход 3: view MERGED → новый PR через create
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "MERGED", mergeCommit: "abc1234" }),
  );
  writeFileSync(join(dir, "url.txt"), "https://example.test/pr/10\n");
  nextRound();
  sent.length = 0;
  await publishPr(deps, store);
  const rels3 = store.releasesByStatuses(["published"]);
  assert.equal(rels3[2]!.pr_url, "https://example.test/pr/10");
  assert.equal(
    readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n").length,
    2,
  );
  assert.ok(sent.some((m) => /PR открыт PLUG-1: https:\/\/example\.test\/pr\/10/.test(m)));
});

test("§18.3 command: create упал или не отдал URL → «PR не открыт»", async () => {
  const run = async (createBody: string) => {
    const { repo } = makeRepo();
    const dir = mkdtempSync(join(tmpdir(), "prtool-"));
    const create = writePrTool(dir, "pr-create", createBody);
    const view = writePrTool(dir, "pr-view", `cat "$DIR/view.json"`);
    writeFileSync(join(dir, "view.json"), "{}");
    const { deps, store, sent } = makeDeps(repo, {
      auditVerdict: '{"verdict":"APPROVE","findings":[]}',
      releaseText: PR_CMD_CFG(create, view),
    });
    await publishPr(deps, store);
    return { rel: store.releasesByStatuses(["failed"])[0]!, sent };
  };
  // ненулевой код — отказ, даже если URL напечатан
  const a = await run(`echo "https://example.test/pr/9"; exit 3`);
  assert.match(a.rel.error ?? "", /PR не открыт \(код 3\)/);
  // код 0, но URL нет — отказ «PR не открыт: <вывод>»
  const b = await run(`echo "nothing here"`);
  assert.match(b.rel.error ?? "", /PR не открыт: nothing here/);
});

test("§18.3 command: view сломан — prErrorLimit → «слежение невозможно»", async () => {
  const { repo } = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "prtool-"));
  const create = writePrTool(dir, "pr-create", `echo "https://example.test/pr/9"`);
  const view = writePrTool(dir, "pr-view", `cat "$DIR/view.json"`);
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "OPEN", mergeCommit: null }),
  );
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CMD_CFG(create, view),
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  // провайдер начал отвечать не-JSON — ошибка провайдера, не «open»
  writeFileSync(join(dir, "view.json"), "not-json{{{");
  for (let i = 0; i < 3; i++) {
    now += 6 * 60 * 1000;
    await pumpReleases(deps);
  }
  assert.equal(store.getRelease(rel.id)!.pr_state, "error");
  assert.equal(
    sent.filter((m) => /слежение за PR/.test(m)).length,
    1,
  );
});

test("§18.3: маркер BB-Thread узнаётся — свой → обновление, чужой → отказ", async () => {
  const run = async (body: string) => {
    const { repo } = makeRepo();
    const ghCalls: string[][] = [];
    const { deps, store, sent } = makeDeps(repo, {
      ghCalls,
      ghPrList: () => [
        {
          url: "https://example.test/pr/7",
          body,
          headRefName: "feat-x",
          baseRefName: "main",
        },
      ],
      auditVerdict: '{"verdict":"APPROVE","findings":[]}',
      releaseText: JSON.stringify({
        commitIdentity: "Agent <agent@x.io>",
        defaults: { target: { action: "pr", branch: "main" } },
      }),
    });
    await publishPr(deps, store);
    return { store, sent, ghCalls };
  };
  const own = await run("BB-Thread: thr_coord\n\nBB-Task: PLUG-1");
  const rel = own.store.releasesByStatuses(["published"])[0]!;
  assert.equal(rel.pr_url, "https://example.test/pr/7");
  assert.ok(own.sent.some((m) => /PR обновлён/.test(m)));
  assert.equal(
    own.ghCalls.filter((a) => a[1] === "create").length,
    0,
    "create не вызывался — PR уже наш",
  );
  const foreign = await run("BB-Thread: thr_other\n\nBB-Task: PLUG-2");
  const failed = foreign.store.releasesByStatuses(["failed"])[0]!;
  assert.match(failed.error ?? "", /создан не этим release/);
});

test("§18.3: шаблон без {thread} — «чей PR» по своим записям", async () => {
  const { repo } = makeRepo();
  let prs: unknown[] = [];
  const cfg = JSON.stringify({
    commitIdentity: "Agent <agent@x.io>",
    defaults: {
      target: { action: "pr", branch: "main" },
      prBody: "custom body without markers",
    },
  });
  const { deps, store, sent, exec, bindReview } = makeDeps(repo, {
    ghPrList: () => prs,
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: cfg,
  });
  await publishPr(deps, store);
  const rel1 = store.releasesByStatuses(["published"])[0]!;
  assert.equal(rel1.pr_url, "https://example.test/pr/7");
  // GitHub сообщает открытый PR без маркера — по записям он наш
  prs = [
    {
      url: "https://example.test/pr/7",
      body: "custom body without markers",
      headRefName: "feat-x",
      baseRefName: "main",
    },
  ];
  writeFileSync(join(repo, "more.txt"), "more\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: more"]);
  const tip2 = gitR(repo, ["rev-parse", "HEAD"]);
  store.setRoundResult(exec.id, {
    branch: "feat-x",
    sha: tip2,
    commits: 2,
    dirty: false,
  });
  bindReview(tip2);
  sent.length = 0;
  await publishPr(deps, store);
  assert.equal(
    store.releasesByStatuses(["published"])[1]!.pr_url,
    "https://example.test/pr/7",
  );
  assert.ok(sent.some((m) => /PR обновлён/.test(m)));
  // чужой PR без маркера — записей нет → release в него не пишет
  const { repo: repo2 } = makeRepo();
  const { deps: deps2, store: store2 } = makeDeps(repo2, {
    ghPrList: () => [
      {
        url: "https://example.test/pr/8",
        body: "custom body without markers",
        headRefName: "feat-x",
        baseRefName: "main",
      },
    ],
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: cfg,
  });
  await publishPr(deps2, store2);
  assert.match(
    store2.releasesByStatuses(["failed"])[0]!.error ?? "",
    /создан не этим release/,
  );
});

test("§18.6 prBody: дефолт, шаблон автора байт-в-байт, {title}, threadIds off — пусто", async () => {
  const bodyOf = async (extra: Record<string, unknown>) => {
    const { repo } = makeRepo();
    const ghCalls: string[][] = [];
    const { deps, store } = makeDeps(repo, {
      ghCalls,
      auditVerdict: '{"verdict":"APPROVE","findings":[]}',
      releaseText: JSON.stringify({
        commitIdentity: "Agent <agent@x.io>",
        defaults: { target: { action: "pr", branch: "main" }, ...extra },
      }),
    });
    await publishPr(deps, store);
    const create = ghCalls.find((a) => a[1] === "create")!;
    return create[create.indexOf("--body") + 1]!;
  };
  // дефолт §18.6
  assert.equal(await bodyOf({}), "BB-Thread: thr_coord\n\nBB-Task: PLUG-1");
  // живой шаблон установки автора — тело остаётся байт-в-байт как было
  assert.equal(
    await bodyOf({ prBody: "Источник: bb тред {thread}\n\nЗадача: {task}" }),
    "Источник: bb тред thr_coord\n\nЗадача: PLUG-1",
  );
  assert.equal(await bodyOf({ prBody: "{title} :: {task}" }), "do x :: PLUG-1");
  // threadIds: false — шаблон не применяется вовсе
  assert.equal(
    await bodyOf({ threadIds: false, prBody: "x {thread} {task}" }),
    "",
  );
});

test("§18.3 command: таймаут — SIGTERM группе → SIGKILL, такт не висит", async () => {
  const { repo } = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "prtool-"));
  const create = writePrTool(dir, "pr-create", `echo never`);
  const view = writePrTool(dir, "pr-view", `cat "$DIR/view.json"`);
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "OPEN", mergeCommit: null }),
  );
  const { deps, store } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "pr", branch: "main" },
        prProvider: { type: "command", create: [create], view: [view] },
        timing: { prCommandTimeoutSec: 5 },
      },
    }),
  });
  // запускатель §18.5: «процесс» игнорирует SIGTERM и умирает только по
  // SIGKILL — убийство идёт группой; без него зависший внук держал бы
  // такт на `close` бессрочно.
  const kills: string[] = [];
  deps.spawn = () => {
    let resolveDone!: (r: {
      code: number | null;
      signal: string | null;
      output: string;
      stdout: string;
      stderr: string;
    }) => void;
    const done = new Promise<{
      code: number | null;
      signal: string | null;
      output: string;
      stdout: string;
      stderr: string;
    }>((r) => (resolveDone = r));
    return {
      pid: 4242,
      pgid: 4242,
      done,
      killGroup: (sig: "SIGTERM" | "SIGKILL") => {
        kills.push(sig);
        if (sig === "SIGKILL") {
          resolveDone({
            code: null,
            signal: "SIGKILL",
            output: "",
            stdout: "",
            stderr: "",
          });
        }
      },
    };
  };
  deps.killGraceMs = 5;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["failed"])[0]!;
  assert.match(rel.error ?? "", /PR не открыт \(код 124\)/);
  assert.match(rel.error ?? "", /timed out/);
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
});

test("§18.3: свой шаблон с {thread} в другом виде — «чей PR» по записям", async () => {
  const { repo } = makeRepo();
  const cfg = JSON.stringify({
    commitIdentity: "Agent <agent@x.io>",
    defaults: {
      target: { action: "pr", branch: "main" },
      prBody: "Thread: {thread} · {task}",
    },
  });
  let prs: unknown[] = [];
  const { deps, store, sent, exec, bindReview } = makeDeps(repo, {
    ghPrList: () => prs,
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: cfg,
  });
  await publishPr(deps, store);
  assert.equal(
    store.releasesByStatuses(["published"])[0]!.pr_url,
    "https://example.test/pr/7",
  );
  // Тело PR — «Thread: thr_coord · PLUG-1»: разбираемого маркера
  // («Источник: bb тред» / «BB-Thread:») в нём нет, и отрендеренный
  // шаблон его не создаёт → «свой PR» по своим записям, а не «чужой»
  // из-за отсутствия маркера.
  prs = [
    {
      url: "https://example.test/pr/7",
      body: "Thread: thr_coord · PLUG-1",
      headRefName: "feat-x",
      baseRefName: "main",
    },
  ];
  writeFileSync(join(repo, "more.txt"), "more\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: more"]);
  const tip2 = gitR(repo, ["rev-parse", "HEAD"]);
  store.setRoundResult(exec.id, {
    branch: "feat-x",
    sha: tip2,
    commits: 2,
    dirty: false,
  });
  bindReview(tip2);
  sent.length = 0;
  await publishPr(deps, store);
  assert.equal(
    store.releasesByStatuses(["published"])[1]!.pr_url,
    "https://example.test/pr/7",
  );
  assert.ok(
    sent.some((m) => /PR обновлён/.test(m)),
    JSON.stringify(sent),
  );
  // чужой PR с такой же строкой (другой тред) — записей о нём нет →
  // release в него не пишет
  const { repo: repo2 } = makeRepo();
  const { deps: deps2, store: store2 } = makeDeps(repo2, {
    ghPrList: () => [
      {
        url: "https://example.test/pr/8",
        body: "Thread: thr_other · PLUG-9",
        headRefName: "feat-x",
        baseRefName: "main",
      },
    ],
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: cfg,
  });
  await publishPr(deps2, store2);
  assert.match(
    store2.releasesByStatuses(["failed"])[0]!.error ?? "",
    /создан не этим release/,
  );
});

test("§18.3 command без find: чужой pr_url (другой координатор) не переиспользуется", async () => {
  const { repo } = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "prtool-"));
  const create = writePrTool(
    dir,
    "pr-create",
    `echo x >> "$DIR/calls.txt"; cat "$DIR/url.txt"`,
  );
  const view = writePrTool(dir, "pr-view", `cat "$DIR/view.json"`);
  writeFileSync(join(dir, "url.txt"), "https://example.test/pr/9\n");
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "OPEN", mergeCommit: null }),
  );
  const { deps, store } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CMD_CFG(create, view),
  });
  // прошлая выкладка ЭТОЙ задачи на ту же ветку — но ДРУГИМ
  // координатором: её pr_url переиспользовать нельзя, новый create.
  const foreign = store.insertRelease({
    taskKey: "PLUG-1",
    projectId: "proj_main",
    coordinatorThreadId: "thr_other",
    repoPath: repo,
    branch: "feat-x",
    targetAction: "pr",
    targetBranch: "main",
  });
  store.updateRelease(foreign.id, {
    status: "published",
    prUrl: "https://example.test/pr/55",
    publishBranch: "feat-x",
  });
  await publishPr(deps, store);
  const rel = store
    .releasesByStatuses(["published"])
    .find((r) => r.coordinator_thread_id === "thr_coord")!;
  assert.equal(rel.pr_url, "https://example.test/pr/9");
  assert.equal(
    readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n").length,
    1,
    "create вызван — чужой pr_url не переиспользован",
  );
});

test("§18.3 command: URL с учётными данными — отказ, в записи не попадает", async () => {
  const { repo } = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "prtool-"));
  const create = writePrTool(
    dir,
    "pr-create",
    `echo "https://user:secret@example.test/pr/9"`,
  );
  const view = writePrTool(dir, "pr-view", `cat "$DIR/view.json"`);
  const find = writePrTool(
    dir,
    "pr-find",
    `echo "https://user:secret@example.test/pr/77"`,
  );
  writeFileSync(
    join(dir, "view.json"),
    JSON.stringify({ state: "OPEN", mergeCommit: null }),
  );
  // create печатает URL с userinfo — отказ, токен нигде не сохраняется
  const a = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CMD_CFG(create, view),
  });
  await publishPr(a.deps, a.store);
  const relA = a.store.releasesByStatuses(["failed"])[0]!;
  assert.match(relA.error ?? "", /URL с учётными данными/);
  assert.equal(relA.pr_url, null);
  assert.ok(!a.sent.some((m) => /secret/.test(m)), JSON.stringify(a.sent));
  // find печатает URL с userinfo — тот же отказ до обращения к записям
  const { repo: repo2 } = makeRepo();
  const b = makeDeps(repo2, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
    releaseText: PR_CMD_CFG(create, view, find),
  });
  await publishPr(b.deps, b.store);
  const relB = b.store.releasesByStatuses(["failed"])[0]!;
  assert.match(relB.error ?? "", /URL с учётными данными/);
  assert.equal(relB.pr_url, null);
  assert.ok(!b.sent.some((m) => /secret/.test(m)), JSON.stringify(b.sent));
});


test("r10 п.4: аудит не завершился за 30 мин — отказ и стоп треда", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, db } = makeDeps(repo, {
    auditVerdict: '{"verdict":"APPROVE","findings":[]}',
  });
  let now = 1_700_000_000_000;
  deps.now = () => now;
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  // аудит висит 31 минуту — делегирование осталось running
  db.prepare(`UPDATE delegations SET created_at = ? WHERE level = 'release-audit'`)
    .run(now - 31 * 60 * 1000);
  const s = await pumpReleases(deps);
  assert.equal(s.failed, 1);
  const rel = store.releasesByStatuses(["failed"])[0]!;
  assert.match(rel.error ?? "", /30 мин/);
  assert.ok(sent.some((m) => /аудит не завершился за 30 мин/.test(m)));
});

// ── ревью PLUG-244 заход 1 — дополненные тесты п.6 и r31 ──────────────

const PP_CFG = JSON.stringify({
  commitIdentity: "Agent <agent@x.io>",
  defaults: { target: { action: "push", branch: "main" }, checks: [] },
  projects: { proj_main: {} },
});
const ppCfg = (seed: string) =>
  JSON.stringify({
    commitIdentity: "Agent <agent@x.io>",
    defaults: { target: { action: "push", branch: "main" }, checks: [] },
    projects: {
      proj_main: {
        postPublish: { checkout: seed, branch: "main", reloadPlugins: true },
      },
    },
  });
const APPROVE = '{"verdict":"APPROVE","findings":[]}';

test("r10 п.5 (ревью Б4): сбой send снимает захват — досмотр досылает", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    sendFails: 1,
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  // отправка упала → захват снят, строка не потеряна
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(rel.notified_at, null);
  assert.ok(!sent.some((m) => /выложено PLUG-1:/.test(m)));
  await pumpReleases(deps);
  assert.ok(
    sent.some((m) => /выложено PLUG-1:/.test(m)),
    "досмотр дослал строку после сбоя send",
  );
  assert.ok(store.getRelease(rel.id)!.notified_at! > 0);
});

test("r10 п.5: устаревший захват (-1 старше 2 мин) перехватывается", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, db } = makeDeps(repo, {
    auditVerdict: APPROVE,
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  // имитация падения процесса посреди отправки: захват повис
  db.prepare(
    `UPDATE releases SET notified_at = -1, updated_at = ? WHERE id = ?`,
  ).run(Date.now() - 3 * 60 * 1000, rel.id);
  sent.length = 0;
  await pumpReleases(deps);
  assert.equal(sent.length, 1, "досмотр переслал строку ровно один раз");
  assert.match(sent[0]!, /выложено PLUG-1:/);
  assert.ok(store.getRelease(rel.id)!.notified_at! > 0);
});

test("r10: записи до миграции молчат — бэкфилл notified_at и pr_state legacy", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, db } = makeDeps(repo, {
    releaseText: PR_CFG,
  });
  // «старая» конечная запись — бэкфилл проставил notified_at
  const done = store.insertRelease({
    taskKey: "PLUG-8", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", repoPath: repo, branch: "b",
    targetAction: "push", targetBranch: "main",
  });
  store.updateRelease(done.id, { status: "published" });
  db.prepare(`UPDATE releases SET notified_at = ? WHERE id = ?`).run(
    Date.now(),
    done.id,
  );
  // «старый» PR — миграция разметила legacy, слежение его не ведёт
  const old = store.insertRelease({
    taskKey: "PLUG-9", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", repoPath: repo, branch: "b",
    targetAction: "pr", targetBranch: "main",
  });
  store.updateRelease(old.id, {
    status: "published",
    prUrl: "https://example.test/pr/1",
  });
  db.prepare(
    `UPDATE releases SET pr_state = 'legacy', notified_at = ? WHERE id = ?`,
  ).run(Date.now(), old.id);
  await pumpReleases(deps);
  await pumpReleases(deps);
  assert.equal(sent.length, 0, "старые записи не шлют строк");
});

test("r10 п.2: копия не на целевой ветке — причина в строке, перезагрузки нет", async () => {
  const { repo, seed } = makeRepo();
  gitR(seed, ["checkout", "-b", "side"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /копия не на main — не обновлена/);
  assert.ok(
    !calls.some((c) => c[0] === "plugin" && c[1] === "reload"),
    "перезагрузки не было",
  );
});

test("r10 п.2: чужой origin у копии — причина в строке, перезагрузки нет", async () => {
  const { repo, seed } = makeRepo();
  gitR(seed, ["remote", "set-url", "origin", "/nonexistent-remote.git"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /другой репозиторий — не обновлена/);
  assert.ok(
    !calls.some((c) => c[0] === "plugin" && c[1] === "reload"),
    "перезагрузки не было",
  );
});

test("r10 п.2: ff не прошёл — причина в строке, перезагрузки нет", async () => {
  const { repo, seed } = makeRepo();
  // у копии есть локальный коммит, которого нет в origin — расходятся
  writeFileSync(join(seed, "local.txt"), "local\n");
  gitR(seed, ["add", "."]);
  gitR(seed, ["commit", "-m", "local"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /ff не прошёл/);
  assert.ok(
    !calls.some((c) => c[0] === "plugin" && c[1] === "reload"),
    "перезагрузки не было",
  );
});

test("r10 п.2: плагины не менялись — копия обновлена, перезагрузок нет", async () => {
  const { repo, seed } = makeRepo(); // в диффе только f.txt — не plugins/
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /плагины не менялись/);
  assert.ok(
    !calls.some((c) => c[0] === "plugin" && c[1] === "reload"),
    "перезагрузок не было",
  );
});

test("r10 п.2: изменённый dist/ внутри плагина — ff и перезагрузка идут", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug", "dist"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "dist", "bundle.js"), "x\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "build: dist"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    calls.some((c) => c.join(" ") === "plugin reload fakeplug"),
    "изменённый dist/ перезагружает плагин",
  );
  assert.match(sent.find((m) => /выложено/.test(m))!, /перезагружено: fakeplug/);
});

test("r11: package.json у плагина — пропуск «переустанови и перезагрузи вручную»", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug"), { recursive: true });
  writeFileSync(
    join(repo, "plugins", "fakeplug", "package.json"),
    '{"name":"fakeplug"}\n',
  );
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "chore: manifest"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    !calls.some((c) => c.join(" ") === "plugin reload fakeplug"),
    "манифест изменён — перезагрузки нет",
  );
  assert.match(
    sent.find((m) => /выложено/.test(m))!,
    /пропущено: fakeplug: изменены зависимости — переустанови их и перезагрузи вручную/,
  );
});

test("r10 п.2 (ревью Б2): провайдер с ходами — пропуск по реестру acp-devin", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "bb-plugin-provider-devin", "src"), {
    recursive: true,
  });
  writeFileSync(join(repo, "plugins", "bb-plugin-provider-devin", "src", "x.ts"), "");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: devin provider"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      {
        id: "provider-devin",
        rootDir: join(seed, "plugins", "bb-plugin-provider-devin"),
      },
    ],
    providerList: () => [{ id: "acp-devin", pluginId: "provider-devin" }],
    releaseText: ppCfg(seed),
  });
  // идёт ход на реальном id провайдера этого плагина
  const run = store.insert({
    taskKey: "PLUG-2", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", level: "complex",
    route: "r", preset: "r", provider: "acp-devin",
  });
  store.setStatus(run.id, "running");
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    !calls.some((c) => c.join(" ") === "plugin reload provider-devin"),
    "провайдер с ходами не перезагружается",
  );
  assert.match(
    sent.find((m) => /выложено/.test(m))!,
    /пропущено: provider-devin: идут ходы — перезагрузи позже/,
  );
});

test("r10 п.2 (ревью Б2): ходы на ЧУЖОМ провайдере — плагин перезагружается", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "bb-plugin-provider-devin", "src"), {
    recursive: true,
  });
  writeFileSync(join(repo, "plugins", "bb-plugin-provider-devin", "src", "x.ts"), "");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: devin provider"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      {
        id: "provider-devin",
        rootDir: join(seed, "plugins", "bb-plugin-provider-devin"),
      },
    ],
    providerList: () => [{ id: "acp-devin", pluginId: "provider-devin" }],
    releaseText: ppCfg(seed),
  });
  // ход идёт на провайдере ДРУГОГО плагина — реестр различает
  const run = store.insert({
    taskKey: "PLUG-2", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", level: "complex",
    route: "r", preset: "r", provider: "agy",
  });
  store.setStatus(run.id, "running");
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    calls.some((c) => c.join(" ") === "plugin reload provider-devin"),
    "чужой провайдер занят — provider-devin всё же перезагружен",
  );
  assert.match(sent.find((m) => /выложено/.test(m))!, /перезагружено: provider-devin/);
});

test("r10 п.2 (ревью Б2): реестр не прочитан — provider-плагин пропускается даже без ходов", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "bb-plugin-provider-devin", "src"), {
    recursive: true,
  });
  writeFileSync(join(repo, "plugins", "bb-plugin-provider-devin", "src", "x.ts"), "");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: devin provider"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      {
        id: "provider-devin",
        rootDir: join(seed, "plugins", "bb-plugin-provider-devin"),
      },
    ],
    providerListFail: true,
    releaseText: ppCfg(seed),
  });
  // running-делегирований нет вовсе — пропуск всё равно обязателен
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    !calls.some((c) => c.join(" ") === "plugin reload provider-devin"),
    "реестр не прочитан — пропуск всех плагинов-провайдеров",
  );
  assert.match(
    sent.find((m) => /выложено/.test(m))!,
    /пропущено: provider-devin: реестр провайдеров не прочитан — перезагрузи вручную/,
  );
});

test("r10 п.2 (ревью Н6): плагин из другой копии — пропуск, reload по имени каталога нет", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "x.txt"), "1\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: plugin"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    // установлен из ДРУГОЙ копии — rootDir не внутри postPublish checkout
    pluginList: () => [
      { id: "fakeplug", rootDir: "/other/copy/plugins/fakeplug" },
    ],
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    !calls.some((c) => c[0] === "plugin" && c[1] === "reload"),
    "плагин другой копии не перезагружается",
  );
  // r11: rootDir вне копии — запись не кандидат, молча (изменённые пути
  // вне rootDir плагина — молча по спеке).
  assert.match(
    sent.find((m) => /выложено/.test(m))!,
    /плагины не менялись/,
  );
});

test("r10 п.2: automation create упал — плагин сам шлёт «вручную»", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "bb-plugin-orchestrator", "src"), {
    recursive: true,
  });
  writeFileSync(join(repo, "plugins", "bb-plugin-orchestrator", "src", "x.ts"), "");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: orchestrator"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      {
        id: "orchestrator",
        rootDir: join(seed, "plugins", "bb-plugin-orchestrator"),
      },
    ],
    automationCreateFail: true,
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    calls.some((c) => c[0] === "automation" && c[1] === "create"),
    "попытка create была",
  );
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /перезагрузи orchestrator вручную: automation boom/);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.ok(rel.notified_at != null && rel.notified_at > 0);
});

test("r10 п.3: закрыт → переоткрыт → влит — «PR влит» и задача done", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: PR_CFG,
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  ghView(deps, JSON.stringify({ state: "CLOSED" }));
  now += 6 * 60 * 1000;
  await pumpReleases(deps);
  assert.equal(store.getRelease(rel.id)!.pr_state, "closed");
  assert.ok(sent.some((m) => /PR закрыт без влития/.test(m)));
  sent.length = 0;
  // переоткрыт — молча возвращается в open
  ghView(deps, JSON.stringify({ state: "OPEN" }));
  now += 6 * 60 * 1000;
  await pumpReleases(deps);
  assert.equal(store.getRelease(rel.id)!.pr_state, "open");
  assert.equal(sent.length, 0);
  // и влит — финальная строка + задача done
  ghView(deps, JSON.stringify({
    state: "MERGED", mergedAt: "2026-01-01",
    mergeCommit: { oid: "deed1234567890" },
  }));
  now += 6 * 60 * 1000;
  await pumpReleases(deps);
  assert.equal(store.getRelease(rel.id)!.pr_state, "merged");
  assert.ok(sent.some((m) => /PR влит PLUG-1: .*→ deed123$/.test(m)));
  assert.ok(calls.some((c) => c.join(" ").includes("--status done")));
});

test("r10 п.3: две выкладки одного PR — следит только новейшая запись", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: PR_CFG,
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel1 = store.releasesByStatuses(["published"])[0]!;
  assert.equal(rel1.pr_state, "open");
  // вторая выкладка записала тот же pr_url — следящая запись одна
  const rel2 = store.insertRelease({
    taskKey: "PLUG-1", projectId: "proj_main",
    coordinatorThreadId: "thr_coord", repoPath: repo, branch: "b2",
    targetAction: "pr", targetBranch: "main",
  });
  store.updateRelease(rel2.id, {
    status: "published",
    prUrl: rel1.pr_url,
  });
  store.initPrTracking(rel2.id);
  ghView(deps, JSON.stringify({ state: "OPEN" }));
  now += 6 * 60 * 1000;
  await pumpReleases(deps);
  assert.equal(store.getRelease(rel1.id)!.pr_state, "superseded");
  const tracked = store.trackedPrReleases();
  assert.deepEqual(tracked.map((r) => r.id), [rel2.id]);
  assert.ok(!sent.some((m) => /PR влит|PR закрыт|висит 72 ч/.test(m)));
});


test("r10 п.5 (ревью заход 2 Б1): сбой send два такта — строка переотправлена, работа не повторена", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "x.txt"), "1\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: plugin change"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    releaseText: ppCfg(seed),
    sendFails: 2,
  });
  let repoFetches = 0, seedFetches = 0;
  const origRun = deps.cmd.run;
  deps.cmd = {
    run: async (f, a, o) => {
      if (f === "git" && a[0] === "-C" && a[2] === "fetch") {
        if (a[1] === repo) repoFetches++;
        if (a[1] === seed) seedFetches++;
      }
      return origRun(f, a, o);
    },
  };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  const reloads = () =>
    calls.filter((c) => c.join(" ") === "plugin reload fakeplug").length;
  const fetches = () => repoFetches + seedFetches;
  assert.equal(reloads(), 1, "перезагрузка выполнена при публикации");
  assert.equal(sent.length, 0, "первая отправка упала — строки нет");
  assert.match(rel.notice_text ?? "", /выложено PLUG-1:/);
  const fetchesAfterPublish = fetches();
  // два такта досмотра: вторая отправка тоже падает, третья проходит —
  // и ни разу не повторяются fetch/ff/reload/postCheck (Б1)
  await pumpReleases(deps);
  assert.equal(sent.length, 0);
  await pumpReleases(deps);
  assert.equal(sent.filter((m) => /выложено PLUG-1:/.test(m)).length, 1);
  assert.equal(reloads(), 1, "plugin reload вызван ровно один раз");
  assert.equal(fetches(), fetchesAfterPublish, "fetch не повторялся");
  assert.ok(store.getRelease(rel.id)!.notified_at! > 0);
});

test("r10 п.5: тред координатора удалён — текст комментарием в задачу, без повтора", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, comments } = makeDeps(repo, {
    auditVerdict: APPROVE,
    sendThreadGone: true,
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(sent.length, 0);
  assert.ok(
    comments.some((c) => /выложено PLUG-1:/.test(c)),
    "текст ушёл комментарием в задачу",
  );
  assert.ok(rel.notified_at! > 0, "подтверждено — вечного повтора нет");
  sent.length = 0;
  comments.length = 0;
  await pumpReleases(deps);
  assert.equal(sent.length + comments.length, 0, "досмотр молчит");
});

test("r10 п.5: отказ аудита при сбое send — переотправлен досмотром", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict:
      '{"verdict":"REJECT","findings":[{"file":"a.ts","line":1,"category":"leaks","problem":"x"}]}',
    sendFails: 1,
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const rel = store.releasesByStatuses(["rejected"])[0]!;
  assert.equal(sent.length, 0, "send упал — строка не ушла");
  assert.match(rel.notice_text ?? "", /REJECT/, "строка сохранена в записи");
  await pumpReleases(deps);
  assert.equal(
    sent.filter((m) => /аудит выкладки PLUG-1: REJECT/.test(m)).length,
    1,
  );
  assert.ok(store.getRelease(rel.id)!.notified_at! > 0);
});

test("r10 п.5 (ревью заход 4 Н5): ENOTFOUND — повтор, не комментарий в задачу", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, comments } = makeDeps(repo, {
    auditVerdict: APPROVE,
    sendFails: 1,
    // «тред не найден» решается по коду SDK, не по тексту: ENOTFOUND —
    // временный сбой, строка ждёт переотправки.
    sendError: () =>
      Object.assign(new Error("getaddrinfo ENOTFOUND bb.host"), {
        code: "ENOTFOUND",
      }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(sent.length, 0);
  assert.equal(rel.notified_at, null, "захват снят — строка ждёт повтора");
  assert.ok(
    !comments.some((c) => /выложено PLUG-1:/.test(c)),
    "временный сбой не уходит комментарием в задачу",
  );
  await pumpReleases(deps);
  assert.ok(sent.some((m) => /выложено PLUG-1:/.test(m)));
});

test("r10 п.5 (ревью заход 4 Н2): крах до automation create — досмотр шлёт «автоматизация не подтверждена», create не повторяется", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "bb-plugin-orchestrator", "src"), {
    recursive: true,
  });
  writeFileSync(join(repo, "plugins", "bb-plugin-orchestrator", "src", "x.ts"), "");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: orchestrator"]);
  const { deps, store, sent, calls, db } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      {
        id: "orchestrator",
        rootDir: join(seed, "plugins", "bb-plugin-orchestrator"),
      },
    ],
    releaseText: ppCfg(seed),
  });
  // крах между сохранением строки и automation create: сам вызов бросил
  const origRun = deps.bbCli.run;
  deps.bbCli = {
    run: async (args: string[]) => {
      if (args[0] === "automation" && args[1] === "create") {
        calls.push(args);
        throw new Error("process died");
      }
      return origRun(args);
    },
  };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(rel.notice_kind, "self-reload");
  assert.ok(
    rel.notified_at != null && rel.notified_at < 0,
    "захват остался висеть",
  );
  assert.ok(!sent.some((m) => /выложено/.test(m)), "строки нет");
  assert.equal(
    calls.filter((c) => c[0] === "automation" && c[1] === "create").length,
    1,
    "попытка create была одна",
  );
  // захват устарел (2 мин) — досмотр перехватывает запись
  db.prepare("UPDATE releases SET notified_at = -1 WHERE id = ?").run(rel.id);
  await pumpReleases(deps);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(
    line,
    /перезагрузи orchestrator вручную: автоматизация не подтверждена/,
  );
  assert.equal(
    calls.filter((c) => c[0] === "automation" && c[1] === "create").length,
    1,
    "automation create повторно не выполняется",
  );
  assert.ok(store.getRelease(rel.id)!.notified_at! > 0);
});

test("r10 п.3 (ревью заход 4 Н1): PR-переход ждёт доставки строки п.1", async () => {
  const { repo } = makeRepo();
  const ghCalls: string[][] = [];
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: PR_CFG,
    ghCalls,
    sendFails: 2,
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.match(rel.notice_text ?? "", /PR открыт/, "строка п.1 сохранена");
  ghView(deps, JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01", mergeCommit: { oid: "abc1234" } }));
  now += 6 * 60 * 1000;
  await pumpReleases(deps);
  // вторая отправка тоже упала — недоставленная строка не затирается:
  // gh даже не опрашивался, перехода нет, «PR влит» не ушёл
  assert.equal(sent.length, 0);
  assert.ok(
    !ghCalls.some((a) => a[0] === "pr" && a[1] === "view"),
    "gh pr view не вызывался, пока строка недоставлена",
  );
  assert.equal(store.getRelease(rel.id)!.pr_state, "open");
  // send починился — досмотр доносит п.1, затем обычный переход MERGED
  await pumpReleases(deps);
  assert.match(sent[0] ?? "", /PR открыт PLUG-1:/);
  assert.match(sent[1] ?? "", /PR влит PLUG-1:/);
  assert.equal(store.getRelease(rel.id)!.pr_state, "merged");
});

test("r10 п.2: plugin reload упал — «перезагрузка не удалась: <ошибка>»", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "x.txt"), "1\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: plugin change"]);
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    pluginReloadFail: true,
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.match(
    sent.find((m) => /выложено/.test(m))!,
    /пропущено: fakeplug: перезагрузка не удалась: reload boom/,
  );
});

// ── PLUG-245: postPublish r11 (§2 п.6), запускатель в конвейере ────────

/** Фейковый спаунер для депс — done резолвится из теста. */
function cmdFake() {
  const spawned: {
    spec: { argv: string[]; cwd: string; env: Record<string, string> };
    pid: number;
    kills: string[];
    resolve: (r: {
      code: number | null;
      signal: string | null;
      output: string;
    }) => void;
  }[] = [];
  let pid = 200;
  const spawner = (spec: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
  }): SpawnedCommand => {
    pid += 1;
    let resolve!: (r: {
      code: number | null;
      signal: string | null;
      output: string;
    }) => void;
    const done = new Promise<{
      code: number | null;
      signal: string | null;
      output: string;
    }>((r) => (resolve = r));
    const rec = { spec, pid, kills: [] as string[], resolve };
    spawned.push(rec);
    return {
      pid,
      pgid: pid,
      done,
      killGroup: (sig) => {
        rec.kills.push(sig);
      },
    };
  };
  return { spawner, spawned };
}

const cmdRunner = (store: DelegationStore, fake: ReturnType<typeof cmdFake>) =>
  createCommandRunner({
    store,
    spawn: fake.spawner,
    maxConcurrent: () => 4,
    procStart: () => "1",
    alive: () => false,
    killGraceMs: 1,
  });

test("§2 п.6 r11 (без prProvider): postPublish-команды через журнал — env, порядок, замок, итог", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_main: {
          // prProvider не задан вообще — r11 работает без него
          postPublish: {
            checkout: seed,
            branch: "main",
            on: "published",
            commands: [
              { name: "deploy", argv: ["/bin/true"], cwd: "checkout" },
              { name: "note", argv: ["echo", "hi"] },
            ],
          },
        },
      },
    }),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  // такт 1: журналная постановка, deploy стартовал, note ждёт группу
  assert.equal(fake.spawned.length, 1);
  const sp = fake.spawned[0];
  assert.equal(sp.spec.cwd, seed, "cwd:checkout — каталог копии");
  assert.equal(sp.spec.argv[0], "/bin/true");
  assert.equal(sp.spec.env.ORCH_EVENT, "release.published");
  assert.equal(sp.spec.env.ORCH_TASK, "PLUG-1");
  assert.match(sp.spec.env.ORCH_SHA, /^[0-9a-f]{40}$/);
  assert.equal(sp.spec.env.ORCH_TARGET, "main");
  // замок копии держится, пока команды в полёте
  const lock = join(seed, ".git", "orchestrator-merge.lock");
  assert.ok(existsSync(lock), "копия под замком на весь postPublish");
  const rel = store.releasesByStatuses(["published"])[0]!;
  // §18.2: следующая команда ставится только после итога предыдущей —
  // пока deploy в полёте, записи note ещё нет (защита stopOnFail).
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:note`),
    undefined,
    "вторая команда ждёт итога первой, а не очереди",
  );
  sp.resolve({ code: 0, signal: null, output: "ok" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.equal(fake.spawned.length, 2);
  fake.spawned[1].resolve({ code: 0, signal: null, output: "done" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(
    line,
    /postPublish: копия обновлена; deploy: ok; note: ok/,
  );
  assert.ok(!existsSync(lock), "замок снят после postPublish");
  assert.equal(store.commandRunByKey(`pp:${rel.id}:deploy`)!.status, "ok");
});

test("§2 п.6 r11: when-патчи и пропуски — «нет изменений по when», «нет checkout»", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_main: {
          postPublish: {
            commands: [
              { name: "docs", argv: ["x"], when: ["docs/**"] },
              { name: "cp", argv: ["y"], cwd: "checkout" },
              { name: "main", argv: ["z"] },
            ],
          },
        },
      },
    }),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  // только main идёт — docs по when не подошла, cp без checkout пропущена
  assert.equal(fake.spawned.length, 1);
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /docs: пропущена — нет изменений по when/);
  assert.match(line, /cp: нет checkout/);
  assert.match(line, /main: ok/);
});

test("§2 п.6 r11: stopOnFail — поздние пропущены «не прошла <имя>»", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_main: {
          postPublish: {
            commands: [
              { name: "must", argv: ["x"], stopOnFail: true },
              { name: "later", argv: ["y"] },
            ],
          },
        },
      },
    }),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  assert.equal(fake.spawned.length, 1);
  fake.spawned[0].resolve({ code: 2, signal: null, output: "boom" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.equal(fake.spawned.length, 1, "later не запускалась");
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /must: упала \(код 2\): boom/);
  assert.match(line, /later: пропущена — не прошла must/);
});

test("§2 п.6 r11: рестарт mid-command — interrupted без повтора", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_main: {
          postPublish: { commands: [{ name: "deploy", argv: ["x"] }] },
        },
      },
    }),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  assert.equal(fake.spawned.length, 1);
  // «рестарт»: новый процесс — recover журнала, группы нет → interrupted
  const runner2 = createCommandRunner({
    store, maxConcurrent: () => 4,
    procStart: () => "1", alive: () => false, killGraceMs: 1,
  });
  await runner2.recover();
  await pumpReleases({ ...deps2, commandRunner: runner2 });
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /deploy: прервана перезапуском/);
  assert.equal(fake.spawned.length, 1, "команда не запускалась повторно");
});

test("§2 п.6 r11 (заход 3 Б3): ff не прошёл — пропуск по фактическому cwd, явный cwd идёт", async () => {
  const { repo, seed } = makeRepo();
  // расходим копию: локальный коммит на main, которого нет на remote
  gitR(seed, ["commit", "--allow-empty", "-m", "local only"]);
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_main: {
          postPublish: {
            checkout: seed,
            branch: "main",
            commands: [
              { name: "cp", argv: ["x"], cwd: "checkout" },
              // cwd по умолчанию при заданном checkout — ТОЖЕ копия:
              // в необновлённой копии не выполняется
              { name: "def", argv: ["z"] },
              // другой явный cwd — выполняется (в каталоге репо)
              { name: "main", argv: ["y"], cwd: "." },
            ],
          },
        },
      },
    }),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  assert.equal(fake.spawned.length, 1, "только main с явным cwd идёт");
  assert.equal(
    fake.spawned[0].spec.cwd,
    repo,
    "явный cwd «.» — каталог репозитория, не копия",
  );
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /ff не прошёл/);
  assert.match(line, /cp: пропущена — копия не обновлена/);
  assert.match(line, /def: пропущена — копия не обновлена/);
  assert.match(line, /main: ok/);
  releaseAllPostPublishLocks();
});

test("§2 п.6 r11: PR влит → on:merged команды до строки «влит → sha7»", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "pr", branch: "main" }, threadIds: false },
      projects: {
        proj_main: {
          postPublish: {
            on: "merged",
            commands: [{ name: "after", argv: ["x"] }],
          },
        },
      },
    }),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  let now = Date.now();
  deps2.now = () => now;
  await publishPr(deps2, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  ghView(
    deps2,
    JSON.stringify({
      state: "MERGED",
      mergedAt: "2026-01-01",
      mergeCommit: { oid: "beef1234567890" },
    }),
  );
  sent.length = 0;
  now += 6 * 60 * 1000;
  await pumpReleases(deps2);
  // merging: команда в полёте — строка «влит» ещё не ушла
  assert.equal(store.getRelease(rel.id)!.pr_state, "merging");
  assert.equal(fake.spawned.length, 1);
  assert.equal(fake.spawned[0].spec.env.ORCH_EVENT, "pr.merged");
  assert.equal(fake.spawned[0].spec.env.ORCH_SHA, "beef1234567890");
  assert.ok(!sent.some((m) => /PR влит/.test(m)));
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.equal(store.getRelease(rel.id)!.pr_state, "merged");
  const line = sent.find((m) => /PR влит/.test(m))!;
  assert.match(line, /PR влит PLUG-1: .*→ beef123/);
  assert.match(line, /postPublish: after: ok/);
});

test("§18.5: timing.prStaleHours — число из настройки в строке", async () => {
  const { repo } = makeRepo();
  const { deps, store, sent, db } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: {
        target: { action: "pr", branch: "main" },
        threadIds: false,
        timing: { prStaleHours: 1 },
      },
    }),
  });
  let now = Date.now();
  deps.now = () => now;
  await publishPr(deps, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  db.prepare(
    `UPDATE releases SET updated_at = ?, pr_checked_at = NULL WHERE id = ?`,
  ).run(Date.now() - 2 * 60 * 60 * 1000, rel.id);
  ghView(deps, JSON.stringify({ state: "OPEN" }));
  await pumpReleases(deps);
  assert.equal(
    sent.filter((m) => /PR висит 1 ч/.test(m)).length,
    1,
    "число из timing попало в текст",
  );
});

test("§2 п.6 r11: самоперезагрузка — скрипт без интерполяции (base64)", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "bb-plugin-orchestrator", "src"), {
    recursive: true,
  });
  writeFileSync(join(repo, "plugins", "bb-plugin-orchestrator", "src", "x.ts"), "");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: orchestrator change"]);
  const { deps, store, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "orchestrator", rootDir: join(seed, "plugins", "bb-plugin-orchestrator") },
    ],
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "push", branch: "main" }, checks: [] },
      projects: {
        proj_main: {
          postPublish: { checkout: seed, branch: "main", reloadPlugins: true },
        },
      },
    }),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  const auto = calls.find((c) => c[0] === "automation" && c[1] === "create")!;
  const script = auto[auto.indexOf("--script") + 1]!;
  assert.match(script, /base64 -d/, "значения в скрипт — base64");
  assert.ok(!script.includes("thr_coord"), "id треда не интерполирован");
  assert.ok(!script.includes("выложено"), "текст строки не интерполирован");
});

// ── PLUG-245 заход 2: регрессии ревью ────────────────────────────────

const ppCfgCmds = (seed: string | null, commands: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    commitIdentity: "Agent <agent@x.io>",
    defaults: { target: { action: "push", branch: "main" }, checks: [] },
    projects: {
      proj_main: {
        postPublish: {
          ...(seed ? { checkout: seed, branch: "main" } : {}),
          ...extra,
          commands,
        },
      },
    },
  });

test("§18.2 (Б1): следующая команда не ставится, пока предыдущая в полёте", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(null, [
      { name: "a", run: ["x"] },
      { name: "b", run: ["y"] },
    ]),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(fake.spawned.length, 1, "стартовала только a");
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:b`),
    undefined,
    "b не в журнале, пока a в полёте — stopOnFail не обгоняется",
  );
  // «полёт между тактами»: ещё два такта — b всё так же не стартует
  await pumpReleases(deps2);
  await pumpReleases(deps2);
  assert.equal(fake.spawned.length, 1);
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.equal(fake.spawned.length, 2, "b стартовала после итога a");
});

test("§18.5 (Б1+Б6): stopOnFail через рестарт — прерванная считается не ok", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(null, [
      { name: "must", run: ["x"], stopOnFail: true },
      { name: "later", run: ["y"] },
      { name: "last", run: ["z"] },
    ]),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(fake.spawned.length, 1);
  // рестарт посреди must: группа мертва → interrupted, повтора нет
  const runner2 = createCommandRunner({
    store, maxConcurrent: () => 4,
    procStart: () => null, alive: () => false, killGraceMs: 1,
  });
  await runner2.recover();
  await pumpReleases({ ...deps2, commandRunner: runner2 });
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /must: прервана перезапуском/);
  assert.match(line, /later: пропущена — не прошла must/);
  assert.match(line, /last: пропущена — не прошла must/);
  assert.equal(fake.spawned.length, 1, "later/last не стартовали");
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:later`)!.status,
    "skipped",
  );
});

test("§18.5 (Б2): замок postPublish — владелец-экземпляр, снимается стопом и итогом", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(seed, [{ name: "a", run: ["x"] }]),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake), instanceId: "inst-1" };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const lock = join(seed, ".git", "orchestrator-merge.lock");
  assert.ok(existsSync(lock), "замок держится, пока команда в полёте");
  const content = readFileSync(lock, "utf8");
  assert.match(content, /inst-1/, "владелец — экземпляр плагина, не голый pid");
  assert.equal(content.split("\n")[2], "", "branch не записан — restoreCopy не нужен");
  // рестарт плагина: стоп снимает файл-замок
  releaseAllPostPublishLocks();
  assert.ok(!existsSync(lock), "stop снял замок экземпляра");
  // «мертвый» экземпляр оставил замок — новый ломает его без restoreCopy,
  // пока команда ещё в полёте (cwd по умолчанию — копия)
  writeFileSync(lock, `${process.pid}\n${new Date().toISOString()}\n\n\ninst-0\n`);
  const deps3 = { ...deps2, instanceId: "inst-2" };
  await pumpReleases(deps3);
  assert.match(
    readFileSync(lock, "utf8"),
    /inst-2/,
    "новый экземпляр перевооружил замок, сломав inst-0",
  );
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps3);
  assert.ok(!existsSync(lock), "замок снят по итогу postPublish");
});

test("§18.5 (заход 3 Б2): срок — только на ожидание: running дольше срока не прерывается", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(null, [
      { name: "a", run: ["x"] },
      { name: "b", run: ["y"] },
    ]),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  let now = Date.now();
  deps2.now = () => now;
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  assert.equal(fake.spawned.length, 1);
  const rel = store.releasesByStatuses(["published"])[0]!;
  // a бежит дольше postPublishWaitMinutes — итога нет, замок и журнал
  // не тронуты: её ограничивает только свой timeoutSec
  now += POSTPUBLISH_MAX_MS + 60_000;
  await pumpReleases(deps2);
  await pumpReleases(deps2);
  assert.ok(
    !sent.some((m) => /выложено/.test(m)),
    "итог не отдан, пока команда running",
  );
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:a`)!.status,
    "running",
    "running не тронута сроком",
  );
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:b`),
    undefined,
    "b не помечена «не дождались» — срок не действовал",
  );
  // a завершилась — счётчик ожидания обнуляется: b ставится и идёт
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.equal(
    fake.spawned.length,
    2,
    "b стартовала — после running бюджет ожидания свежий",
  );
  fake.spawned[1].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.ok(sent.some((m) => /выложено/.test(m)), "итог отдан по окончании");
});

test("§18.5 (заход 3 Б2): срок на ожидание в очереди — истёк → «не дождались очереди команд»", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(null, [{ name: "a", run: ["x"] }]),
  });
  // слотов нет — команда висит queued (ожидание очереди)
  const runner = createCommandRunner({
    store,
    spawn: fake.spawner,
    maxConcurrent: () => 0,
    procStart: () => "1",
    alive: () => false,
    killGraceMs: 1,
  });
  const deps2 = { ...deps, commandRunner: runner };
  let now = Date.now();
  deps2.now = () => now;
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:a`)!.status,
    "queued",
  );
  now += POSTPUBLISH_MAX_MS + 1;
  await pumpReleases(deps2);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /не дождались очереди команд/);
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:a`)!.status,
    "skipped",
  );
});

test("§18.5 (заход 4 Б1): истёкший срок — строка включает уже сделанное (копия, завершённые команды)", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(seed, [
      { name: "a", run: ["x"] },
      { name: "b", run: ["y"] },
    ]),
  });
  let slots = 4;
  const runner = createCommandRunner({
    store,
    spawn: fake.spawner,
    maxConcurrent: () => slots,
    procStart: () => "1",
    alive: () => false,
    killGraceMs: 1,
  });
  const deps2 = { ...deps, commandRunner: runner, instanceId: "inst-1" };
  let now = Date.now();
  deps2.now = () => now;
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const lock = join(seed, ".git", "orchestrator-merge.lock");
  assert.ok(existsSync(lock), "копия обновлена, замок держится — a в полёте");
  const rel = store.releasesByStatuses(["published"])[0]!;
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  // слотов больше нет — b встанет queued и не стартует
  slots = 0;
  await pumpReleases(deps2);
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:b`)!.status,
    "queued",
  );
  now += POSTPUBLISH_MAX_MS + 1;
  await pumpReleases(deps2);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(
    line,
    /postPublish: копия обновлена; a: ok; не дождались очереди команд/,
    "истёкшее ожидание не теряет уже сделанное",
  );
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:b`)!.status,
    "skipped",
  );
  assert.ok(!existsSync(lock), "замок снят по истёкшему сроку");
  releaseAllPostPublishLocks();
});

test("§18.5 (заход 5): ранний выход при running — замок и итог держатся, после resolve — done и замок снят", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(seed, [{ name: "a", run: ["x"] }]),
  });
  const deps2 = {
    ...deps,
    commandRunner: cmdRunner(store, fake),
    instanceId: "inst-1",
  };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const lock = join(seed, ".git", "orchestrator-merge.lock");
  assert.ok(existsSync(lock), "замок держится, пока команда в полёте");
  const rel = store.releasesByStatuses(["published"])[0]!;
  // Настройка сломана (cfg = null), но команда running: итог не
  // отдаётся и замок держится — merge в копию под живой командой не
  // заходит (§18.5, ревью заход 4).
  deps2.loadReleaseConfig = () => parseReleaseConfig("");
  await pumpReleases(deps2);
  assert.ok(existsSync(lock), "running → замок держится");
  assert.ok(
    !sent.some((m) => /выложено/.test(m)),
    "итог не отдан, пока команда running",
  );
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:a`)!.status,
    "running",
  );
  // merge берёт замок без owner → живой pid-замок уважается.
  await assert.rejects(
    acquireCopyLock(
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      seed,
      lock,
    ),
    /already running/,
    "merge в копию под живой командой не заходит",
  );
  // Команда завершилась — следующий такт отдаёт итог и снимает замок.
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.ok(!existsSync(lock), "замок снят после завершения команды");
  assert.ok(sent.some((m) => /выложено/.test(m)), "итог отдан");
  const release = await acquireCopyLock(
    async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    seed,
    lock,
    { owner: "other" },
  );
  release();
  releaseAllPostPublishLocks();
});

test("§18.5 (заход 5): ранний выход при queued — skipped «настройка сменилась», pump её не запускает", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(seed, [{ name: "a", run: ["x"] }]),
  });
  // слотов нет — команда висит queued
  let slots = 0;
  const runner = createCommandRunner({
    store,
    spawn: fake.spawner,
    maxConcurrent: () => slots,
    procStart: () => "1",
    alive: () => false,
    killGraceMs: 1,
  });
  const deps2 = { ...deps, commandRunner: runner, instanceId: "inst-1" };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const lock = join(seed, ".git", "orchestrator-merge.lock");
  assert.ok(existsSync(lock), "замок держится, пока команда ждёт слот");
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:a`)!.status,
    "queued",
  );
  // postPublish убрали из настройки → ранний done по `!pp`: queued
  // помечается skipped, замок снят, итог ушёл.
  deps2.loadReleaseConfig = () =>
    parseReleaseConfig(
      JSON.stringify({
        commitIdentity: "Agent <agent@x.io>",
        defaults: { target: { action: "push", branch: "main" }, checks: [] },
        projects: { proj_main: {} },
      }),
    );
  await pumpReleases(deps2);
  const run = store.commandRunByKey(`pp:${rel.id}:a`)!;
  assert.equal(run.status, "skipped");
  assert.equal(run.output_tail, "настройка сменилась");
  assert.ok(!existsSync(lock), "ранний done по `!pp` снял файл-замок");
  // Слоты появились — терминальная запись не стартует.
  slots = 4;
  await pumpReleases(deps2);
  assert.equal(fake.spawned.length, 0, "pump не запустил снятую с очереди");
  const release = await acquireCopyLock(
    async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    seed,
    lock,
    { owner: "other" },
  );
  release();
  releaseAllPostPublishLocks();
});

test("§18.5 (заход 6): бросок store при running — замок и итог держатся, после resolve — итог", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(seed, [{ name: "a", run: ["x"] }]),
  });
  const deps2 = {
    ...deps,
    commandRunner: cmdRunner(store, fake),
    instanceId: "inst-1",
  };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const lock = join(seed, ".git", "orchestrator-merge.lock");
  assert.ok(existsSync(lock), "команда в полёте — замок держится");
  const rel = store.releasesByStatuses(["published"])[0]!;
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:a`)!.status,
    "running",
  );
  // §18.5 (ревью заход 6): store кинул внутри runPostPublish — пока
  // команда running, замок не снимается и итог не отдаётся (повтор
  // следующим тактом), ошибка — только в журнал плагина.
  const origByKey = store.commandRunByKey.bind(store);
  store.commandRunByKey = () => {
    throw new Error("store down");
  };
  try {
    await pumpReleases(deps2);
  } finally {
    store.commandRunByKey = origByKey;
  }
  assert.ok(existsSync(lock), "бросок при running — замок на месте");
  assert.ok(
    !sent.some((m) => /выложено/.test(m)),
    "итог не отдан, пока команда running",
  );
  assert.equal(
    store.commandRunByKey(`pp:${rel.id}:a`)!.status,
    "running",
  );
  // Команда завершилась — следующий такт отдаёт итог и снимает замок.
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.ok(!existsSync(lock), "замок снят после завершения команды");
  assert.ok(sent.some((m) => /выложено/.test(m)), "итог отдан");
  releaseAllPostPublishLocks();
});

test("§18.5 (заход 4): stop во время acquire — замок отпускается сразу", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(seed, [{ name: "a", run: ["x"] }]),
  });
  const runner = cmdRunner(store, fake);
  // isStopped: первый вызов (до acquire) — false, дальше — true:
  // stop пришёл, пока ждали acquireCopyLock.
  let isStoppedCalls = 0;
  const deps2 = {
    ...deps,
    commandRunner: { ...runner, isStopped: () => ++isStoppedCalls > 1 },
    instanceId: "inst-1",
  };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const lock = join(seed, ".git", "orchestrator-merge.lock");
  assert.ok(!existsSync(lock), "замок, взятый после stop, отпущен сразу");
  assert.equal(
    fake.spawned.length,
    0,
    "команда не ставилась — такт ушёл в pending",
  );
  releaseAllPostPublishLocks();
});

test("§18.5 (заход 3 Б1): замок своего экземпляра занят — вторая выкладка ждёт, merge не заходит", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(seed, [{ name: "a", run: ["x"] }]),
  });
  const deps2 = {
    ...deps,
    commandRunner: cmdRunner(store, fake),
    instanceId: "inst-1",
  };
  let now = Date.now();
  deps2.now = () => now;
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  assert.equal(fake.spawned.length, 1, "команда A в полёте — замок у A");
  const lock = join(seed, ".git", "orchestrator-merge.lock");
  assert.ok(existsSync(lock));
  // merge в ту же копию не заходит, пока команда A идёт
  await assert.rejects(
    acquireCopyLock(
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      seed,
      lock,
    ),
    /already running/,
  );
  // вторая выкладка того же экземпляра в ту же цель (п.0 её уже не
  // держит — A published): её postPublish ждёт замок, не крадёт
  const root = execFileSync("realpath", [repo], {
    encoding: "utf8",
  }).trim();
  const relB = store.insertRelease({
    taskKey: "PLUG-2",
    projectId: "proj_main",
    coordinatorThreadId: "thr_coord",
    repoPath: repo,
    branch: "feat-x",
    targetAction: "push",
    targetBranch: "main",
    settingsProjectId: "proj_main",
    repoRoot: root,
  });
  store.updateRelease(relB.id, {
    status: "published",
    publishedSha: gitR(repo, ["rev-parse", "HEAD"]),
  });
  await pumpReleases(deps2);
  assert.equal(
    fake.spawned.length,
    1,
    "команда B не встала — замок своего экземпляра занят",
  );
  assert.equal(
    store.commandRunByKey(`pp:${relB.id}:a`),
    undefined,
    "B не дошла до постановки команд (под работающей A)",
  );
  assert.match(
    readFileSync(lock, "utf8"),
    /inst-1/,
    "замок A на месте",
  );
  // ждёт дольше срока ожидания → итог «не дождались замка копии»
  now += POSTPUBLISH_MAX_MS + 1;
  await pumpReleases(deps2);
  const line = sent.find((m) => /PLUG-2/.test(m))!;
  assert.match(line, /не дождались замка копии/);
  releaseAllPostPublishLocks();
});

test("§18.5 (заход 3): флаг «остановлен» — идущий такт не берёт замок заново", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(seed, [{ name: "a", run: ["x"] }]),
  });
  const runner = cmdRunner(store, fake);
  const deps2 = { ...deps, commandRunner: runner, instanceId: "inst-1" };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  const lock = join(seed, ".git", "orchestrator-merge.lock");
  assert.ok(existsSync(lock));
  // стоп плагина: записи interrupted, замки сняты
  await runner.stopAll();
  releaseAllPostPublishLocks();
  assert.ok(!existsSync(lock));
  // «идущий такт»: запись ещё published без строки — повторный прогон
  // не перевооружает замок и не запускает queued
  await pumpReleases(deps2);
  await pumpReleases(deps2);
  assert.ok(!existsSync(lock), "остановленный запускатель — замков нет");
  assert.equal(fake.spawned.length, 1, "новых запусков нет");
});

test("§18.2 (заход 3): пропуск по when — не сбой, stopOnFail-цепочку не останавливает", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(null, [
      { name: "docs", run: ["x"], when: ["docs/**"], stopOnFail: true },
      { name: "next", run: ["y"] },
    ]),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  assert.equal(
    fake.spawned.length,
    1,
    "next стартовала — when-пропуск docs не остановил цепочку",
  );
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /docs: пропущена — нет изменений по when/);
  assert.match(line, /next: ok/);
});

test("§18.2 (Б4): поле run, cwd по умолчанию — checkout, относительный cwd — от репозитория", async () => {
  const { repo, seed } = makeRepo();
  const fake = cmdFake();
  const { deps, store } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: ppCfgCmds(seed, [
      { name: "a", run: ["echo", "a"] },
      { name: "b", run: ["echo", "b"], cwd: "sub/dir" },
    ]),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  assert.equal(fake.spawned.length, 1);
  assert.equal(
    fake.spawned[0].spec.cwd,
    seed,
    "cwd без значения — checkout, а не каталог репозитория",
  );
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.equal(fake.spawned.length, 2);
  assert.equal(
    fake.spawned[1].spec.cwd,
    join(repo, "sub/dir"),
    "относительный cwd — от каталога репозитория",
  );
  releaseAllPostPublishLocks();
});

test("§2 п.6 r11 (Б6): плагин в корне репозитория и в packages/x — перезагрузка по rootDir", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "packages", "x"), { recursive: true });
  writeFileSync(join(repo, "packages", "x", "x.txt"), "1\n");
  writeFileSync(join(repo, "rootfile.txt"), "r\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: root+pkg plugin files"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "rootplug", rootDir: seed },
      { id: "pkgx", rootDir: join(seed, "packages", "x") },
    ],
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    calls.some((c) => c.join(" ") === "plugin reload rootplug"),
    "rootDir = корень копии — любой diff триггерит",
  );
  assert.ok(
    calls.some((c) => c.join(" ") === "plugin reload pkgx"),
    "packages/x тоже перезагружен",
  );
  assert.match(sent.find((m) => /выложено/.test(m))!, /перезагружено: rootplug, pkgx|перезагружено: pkgx, rootplug/);
});

test("§2 п.6 r11 (Б6): pnpm-lock.yaml в КОРНЕ копии — «изменены зависимости»", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "x.txt"), "1\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "chore: plugin + root lockfile"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    !calls.some((c) => c.join(" ") === "plugin reload fakeplug"),
    "корневой lockfile — перезагрузки нет",
  );
  assert.match(
    sent.find((m) => /выложено/.test(m))!,
    /пропущено: fakeplug: изменены зависимости/,
  );
});

test("§2 п.6 r11 (Б6): вложенный package.json (фикстура) зависимостями не считается", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug", "fixtures"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "fixtures", "package.json"), "{}\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "chore: fixture manifest"]);
  const { deps, store, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    calls.some((c) => c.join(" ") === "plugin reload fakeplug"),
    "фикстурный манифест — перезагрузка идёт",
  );
});

test("§2 п.6 r11 (Б6): installsDeps ok — перезагрузка при изменённом манифесте", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "package.json"), "{\"name\":\"x\"}\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "chore: manifest"]);
  const fake = cmdFake();
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    releaseText: ppCfgCmds(seed, [
      { name: "install", run: ["npm", "i"], installsDeps: true },
    ], { reloadPlugins: true }),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  assert.equal(fake.spawned.length, 1);
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.ok(
    calls.some((c) => c.join(" ") === "plugin reload fakeplug"),
    "installsDeps ok — перезагрузка идёт",
  );
  assert.match(sent.find((m) => /выложено/.test(m))!, /перезагружено: fakeplug/);
});

test("§2 п.6 r11 (Б6): реестр не прочитан — пропускаются ВСЕ плагины, не только провайдеры", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "fakeplug"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "x.txt"), "1\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: plugin"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    providerListFail: true,
    releaseText: ppCfg(seed),
  });
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    !calls.some((c) => c[0] === "plugin" && c[1] === "reload"),
    "реестр не прочитан — ни один плагин не перезагружен",
  );
  assert.match(
    sent.find((m) => /выложено/.test(m))!,
    /пропущено: fakeplug: реестр провайдеров не прочитан — перезагрузи вручную/,
  );
});

test("§2 п.6 r11 (Б3+Б6): самоперезагрузка при running-команде — «идут команды»", async () => {
  const { repo, seed } = makeRepo();
  mkdirSync(join(repo, "plugins", "bb-plugin-orchestrator"), { recursive: true });
  writeFileSync(join(repo, "plugins", "bb-plugin-orchestrator", "x.ts"), "x\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: orchestrator change"]);
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "orchestrator", rootDir: join(seed, "plugins", "bb-plugin-orchestrator") },
    ],
    releaseText: ppCfg(seed),
  });
  // в журнале — running команда ДРУГОЙ выкладки: самоперезагрузка ждёт
  const r = store.enqueueCommandRun({
    source: "postPublish",
    runKey: "pp:other:x",
    groupKey: "pp:other",
    name: "x",
    argv: ["sleep", "1"],
    cwd: "/tmp",
  }, 1);
  store.claimCommandRun(r.id, 2);
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps);
  await auditDone(deps, store);
  assert.ok(
    !calls.some((c) => c[0] === "automation" && c[1] === "create"),
    "автоматизация не ставилась — команды ещё идут",
  );
  assert.match(
    sent.find((m) => /выложено/.test(m))!,
    /пропущено: orchestrator: идут команды — перезагрузи позже/,
  );
});

test("§2 п.6 r11 (Б6): merged + рестарт между строкой и merged — одна строка «PR влит»", async () => {
  const { repo } = makeRepo();
  const fake = cmdFake();
  const { deps, store, sent, db } = makeDeps(repo, {
    auditVerdict: APPROVE,
    releaseText: JSON.stringify({
      commitIdentity: "Agent <agent@x.io>",
      defaults: { target: { action: "pr", branch: "main" }, threadIds: false },
      projects: {
        proj_main: {
          postPublish: { on: "merged", commands: [{ name: "after", run: ["x"] }] },
        },
      },
    }),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  let now = Date.now();
  deps2.now = () => now;
  await publishPr(deps2, store);
  const rel = store.releasesByStatuses(["published"])[0]!;
  ghView(deps2, JSON.stringify({
    state: "MERGED", mergedAt: "2026-01-01",
    mergeCommit: { oid: "beef1234567890" },
  }));
  now += 6 * 60 * 1000;
  await pumpReleases(deps2);
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  assert.equal(store.getRelease(rel.id)!.pr_state, "merged");
  const first = sent.filter((m) => /PR влит/.test(m));
  assert.equal(first.length, 1);
  // Реальное окно краха: строка и метка finish записаны одной
  // транзакцией, переход в merged не случился. Досмотр шлёт текст и
  // стирает notice_text — такт не должен пересобрать итог и слать дубль.
  const stored = first[0].replace("[orchestrator] ", "");
  db.prepare(
    "UPDATE releases SET pr_state = 'merging', notice_text = ?, " +
      "notice_kind = 'pr', notified_at = NULL WHERE id = ?",
  ).run(stored, rel.id);
  store.metaSet(
    `release-pp:${rel.id}`,
    JSON.stringify({ finish: stored }),
  );
  sent.length = 0;
  await pumpReleases(deps2);
  await pumpReleases(deps2);
  assert.equal(store.getRelease(rel.id)!.pr_state, "merged");
  const resent = sent.filter((m) => /PR влит/.test(m));
  assert.equal(
    resent.length,
    1,
    "строка «PR влит» доставлена ровно один раз, без пересборки итога",
  );
  assert.equal(resent[0], first[0], "ушёл сохранённый текст, не новый");
  assert.ok(
    store.commandRunByKey(`pp:${rel.id}:after`)!.status === "ok" &&
      fake.spawned.length === 1,
    "postPublish не перезапускался",
  );
});

test("§2 п.6 r11 (мелочь): сбой fetch в позднем такте не отменяет сделанный ff", async () => {
  const { repo, seed } = makeRepo();
  // Файл плагина — в публикуемом коммите: ff копии его принесёт.
  mkdirSync(join(repo, "plugins", "fakeplug"), { recursive: true });
  writeFileSync(join(repo, "plugins", "fakeplug", "x.txt"), "1\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "feat: plugin file"]);
  const fake = cmdFake();
  const { deps, store, sent, calls } = makeDeps(repo, {
    auditVerdict: APPROVE,
    pluginList: () => [
      { id: "fakeplug", rootDir: join(seed, "plugins", "fakeplug") },
    ],
    releaseText: ppCfgCmds(seed, [{ name: "a", run: ["x"] }], { reloadPlugins: true }),
  });
  const deps2 = { ...deps, commandRunner: cmdRunner(store, fake) };
  // первый такт делает ff; команда уходит в полёт
  await runRelease({ taskKey: "PLUG-1", caller: COORD }, deps2);
  await auditDone(deps2, store);
  assert.equal(fake.spawned.length, 1);
  // ломаем fetch копии — мемоизированный итог не пересчитывается
  const origRun = deps2.cmd.run;
  deps2.cmd = {
    run: async (file, args, o) => {
      if (file === "git" && args.includes("fetch")) {
        return { exitCode: 1, stdout: "", stderr: "fetch boom" };
      }
      return origRun(file, args, o);
    },
  };
  fake.spawned[0].resolve({ code: 0, signal: null, output: "" });
  await new Promise((r) => setImmediate(r));
  await pumpReleases(deps2);
  const line = sent.find((m) => /выложено/.test(m))!;
  assert.match(line, /копия обновлена/, "поздний сбой fetch не отменил ff");
  assert.ok(
    calls.some((c) => c.join(" ") === "plugin reload fakeplug"),
    "перезагрузка состоялась по мемоизированному итогу",
  );
});

// ── §18.6 (PLUG-249): leaks.trailers / commitIdentity defaults ─────────

test("§18.6: leaks.trailers — warn default, per-key merge, explicit block", () => {
  const c = parseReleaseConfig(
    JSON.stringify({
      defaults: {
        leaks: { machine: "block", trailers: "block", allow: ["docs/"] },
      },
      projects: { p1: { leaks: { bbIds: "warn" } } },
    }),
  ).config!;
  // per-key merge — the project's bbIds wins, every other key inherits
  const r = resolveProject(c, "p1");
  assert.equal(r.leaks.bbIds, "warn");
  assert.equal(r.leaks.machine, "block");
  assert.equal(r.leaks.trailers, "block");
  assert.deepEqual(r.leaks.allow, ["docs/"]);
  // no `trailers` anywhere → "warn" for a new installation — the
  // public/private strictness does NOT apply to trailers
  const c2 = parseReleaseConfig(
    JSON.stringify({ defaults: { public: true }, projects: { p: {} } }),
  ).config!;
  const r2 = resolveProject(c2, "p");
  assert.equal(r2.leaks.machine, "block");
  assert.equal(r2.leaks.trailers, "warn");
  // an invalid value is a config error with a path
  const bad = parseReleaseConfig(
    JSON.stringify({ defaults: { leaks: { trailers: "x" } } }),
  );
  assert.ok(
    bad.errors.some((e) => e.path === "defaults.leaks.trailers"),
    JSON.stringify(bad.errors),
  );
});

test("§18.6: commitIdentityMissing — no inheritable identity → missing", () => {
  const none = parseReleaseConfig(
    JSON.stringify({
      defaults: {},
      projects: { p: { commitIdentity: "A <a@x.io>" } },
    }),
  ).config!;
  // a project with its own identity covers only itself — the defaults
  // context (any unlisted project) still lacks one
  assert.equal(commitIdentityMissing(none), true);
  const top = parseReleaseConfig(
    JSON.stringify({ commitIdentity: "A <a@x.io>" }),
  ).config!;
  assert.equal(commitIdentityMissing(top), false);
  const inDefaults = parseReleaseConfig(
    JSON.stringify({ defaults: { commitIdentity: "A <a@x.io>" } }),
  ).config!;
  assert.equal(commitIdentityMissing(inDefaults), false);
});

test("§18.6: scan — missing commitIdentity warns; trailers follow leaks.trailers", async () => {
  const commit = {
    sha: "b".repeat(40),
    authorName: "Someone",
    authorEmail: "s@x.io",
    committerName: "Someone",
    committerEmail: "s@x.io",
    body: "feat: x\n\nCo-Authored-By: bot <b@x>",
  };
  const base = {
    repoPath: "/r",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    commits: [commit],
    added: [],
    leaks: {
      machine: "block" as const,
      bbIds: "warn" as const,
      trailers: "block" as const,
      allow: [],
    },
  };
  // no commitIdentity → the signature finding WARNS, never blocks
  const noId = await machineScan(GL_EMPTY, base);
  assert.equal(
    noId.find((f) => f.rule === "commit-identity")!.severity,
    "warn",
  );
  // trailers: "block" → the foreign-bot trailer finding blocks
  assert.equal(
    noId.find((f) => f.rule === "foreign-bot-trailer")!.severity,
    "block",
  );
  // trailers: "warn" → the same finding warns
  const trWarn = await machineScan(GL_EMPTY, {
    ...base,
    leaks: { ...base.leaks, trailers: "warn" as const },
  });
  assert.equal(
    trWarn.find((f) => f.rule === "foreign-bot-trailer")!.severity,
    "warn",
  );
  // allowedTrailers still exempts, whatever the strictness
  const exempt = await machineScan(GL_EMPTY, {
    ...base,
    allowedTrailers: ["Co-Authored-By"],
  });
  assert.ok(!exempt.some((f) => f.rule === "foreign-bot-trailer"));
  // configured identity + mismatching signature → blocks
  const withId = await machineScan(GL_EMPTY, {
    ...base,
    allowedAuthor: { name: "Agent", email: "agent@x.io" },
  });
  assert.equal(
    withId.find((f) => f.rule === "commit-identity")!.severity,
    "block",
  );
  // matching signature → no identity finding at all
  const okScan = await machineScan(GL_EMPTY, {
    ...base,
    commits: [
      {
        ...commit,
        authorName: "Agent",
        authorEmail: "agent@x.io",
        committerName: "Agent",
        committerEmail: "agent@x.io",
        body: "feat: x",
      },
    ],
    allowedAuthor: { name: "Agent", email: "agent@x.io" },
  });
  assert.ok(!okScan.some((f) => f.rule === "commit-identity"));
});
