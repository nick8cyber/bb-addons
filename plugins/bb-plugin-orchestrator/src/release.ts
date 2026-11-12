/**
 * `release` — deterministic publication pipeline (spec
 * orchestrator-release §1–§7). Steps 1–4 run inside the command call and
 * any failure is a refusal; step 5 (the release auditor) is dispatched as
 * a `release-audit` delegation and the command answers immediately;
 * `pumpReleases` — driven from the watchdog beats — reads the auditor's
 * strict JSON verdict and runs steps 6–7 after APPROVE.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { appendFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { hostname as osHostname } from "node:os";
import { fileURLToPath } from "node:url";
import { OrchestratorError } from "./errors.js";
import {
  acquireCopyLock,
  restoreCopy,
  recordLockState,
  COPY_BUSY_MARKERS,
  MERGE_LOCK_NAME,
  type MergeGit,
} from "./merge.js";
import {
  machineScan,
  parseAddedLines,
  hasBbIds,
  EMPTY_TREE_SHA,
  formatFinding,
  maskSecrets,
  type CommitMeta,
  type ScanFinding,
} from "./scan.js";
import {
  DEFAULT_TIMING,
  resolveProject,
  type ReleaseConfig,
  type ReleaseConfigLoad,
  type ResolvedProject,
  type ResolvedPostPublishCommand,
  type ResolvedTiming,
} from "./release-config.js";
import {
  globMatch,
  maskCommandOutput,
  type CommandRunner,
} from "./commands.js";
import {
  levelRole,
  pickRoute,
  type Policy,
  type PolicyLoad,
} from "./policy.js";
import { ACTIVE_STATUSES } from "./store.js";
import type {
  CommandRunRow,
  DelegationRow,
  DelegationStore,
  ReleaseRow,
} from "./store.js";
import { runChecked, runJson, type BbCli } from "./bb-cli.js";
import type { CmdRunner } from "./cmd.js";
import { isCoordinator, type ExecutorProbes, type ThreadFacts } from "./agent-config.js";
import { dispatchToRoute, type DispatchStepsDeps } from "./delegate.js";
import type { WatchdogThreadEvent } from "./watchdog.js";

const AUDIT_LEVEL = "release-audit";
const TOKEN_TTL_MS = 5 * 60 * 1000;
// §17.3 (ревью PLUG-217): a queued client/turn/requested on a
// confirmed-stopped executor thread counts as a live turn only
// while it is this fresh — a request that never reached
// turn/started would otherwise refuse every release forever.
const STALE_TURN_REQUEST_MS = 2 * 60 * 1000;
/** §17.3: how long a release row may sit in `auditing` without its
 * audit delegation before the pump calls it dead (sync + checks +
 * dispatch window, with margin). */
const PACKET_DIFF_CAP = 200_000;
const ZERO_SHA = "0000000000000000000000000000000000000000";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Deps & small types ────────────────────────────────────────────────

export interface ReleaseThreadDto {
  id: string;
  /** §17.3 (ревью PLUG-216 п.2): the turn gate's primary signal —
   * `idle`/`error` mean no turn is in flight (the watchdog's §16.5
   * stop-confirm reads the same two). */
  status?: string | null;
  environmentPath?: string | null;
  environmentBranchName?: string | null;
  projectId?: string;
  parentThreadId?: string | null;
  title?: string | null;
  titleFallback?: string | null;
  originPluginId?: string | null;
}

export interface ReleaseThreads {
  get(args: { threadId: string }): Promise<ReleaseThreadDto>;
  send(args: {
    threadId: string;
    mode: "queue-if-active";
    input: unknown[];
  }): Promise<unknown>;
  /** §17.3 (мелко 5): the thread's last output — the review verdict's
   * fallback source when the task carries no verdict comment. */
  output(args: { threadId: string }): Promise<{ output?: string | null } | null>;
  events: {
    list(args: {
      threadId: string;
      order?: "desc" | "asc";
      limit?: string;
      types?: readonly string[];
    }): Promise<WatchdogThreadEvent[]>;
  };
}

/** PLUG-229: an SDK thread carries `environmentId`, never
 * `environmentPath`/`environmentBranchName` — release reads those for
 * the executor's copy (and the coordinator's on a merged round, §14).
 * This wraps the SDK `threads.get` and fills them from
 * `bb environment show` (the same source `environmentOf` uses). A
 * failed show leaves them null, so release refuses with its honest
 * "no copy" error exactly like a thread without an environment. */
export const releaseThreadsGet =
  (
    sdkGet: (a: { threadId: string }) => Promise<unknown>,
    environmentFacts: (envId: string) => Promise<{
      path?: string | null;
      branchName?: string | null;
    }>,
  ): ReleaseThreads["get"] =>
  async (a) => {
    const t = (await sdkGet(a)) as ReleaseThreadDto & {
      environmentId?: string | null;
    };
    if (
      t.environmentId &&
      (t.environmentPath == null || t.environmentBranchName == null)
    ) {
      let environmentPath: string | null = null;
      let environmentBranchName: string | null = null;
      try {
        const env = await environmentFacts(t.environmentId);
        environmentPath = env.path ?? null;
        environmentBranchName = env.branchName ?? null;
      } catch {
        // show failed → null fields → the step-1 "no copy" refusal.
      }
      return { ...t, environmentPath, environmentBranchName };
    }
    return t;
  };

export interface ReleaseDeps {
  store: DelegationStore;
  bbCli: BbCli;
  cmd: CmdRunner;
  threads: ReleaseThreads;
  /** The §4.3–4.6 dispatch steps deps (audit dispatch shares them). */
  stepsDeps: DispatchStepsDeps;
  loadPolicy(): Promise<PolicyLoad>;
  loadReleaseConfig(): ReleaseConfigLoad;
  probes: ExecutorProbes;
  /** §5 token dir — where the shared pre-push hook looks for
   * `push-token.json`. Lazy: the server data dir is bind-gated. */
  hooksDir(): string;
  /** Directory for audit packet files the auditor reads. */
  packetDir(): string;
  /** §17.3 (С1): the delegate queue — release itself runs outside it;
   * only the audit dispatch is serialized against other dispatches. */
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  /** §18.2 (PLUG-245): общий запускатель журнальных команд. */
  commandRunner?: CommandRunner;
  /** §18.2: срок хранения записей журнала, дни (default 30). */
  commandRetentionDays?: () => number;
  /** PLUG-245 Б2: токен владельца замка копии postPublish — экземпляр
   * плагина, не pid: после перезагрузки плагина в том же процессе старый
   * замок чужой и ломается без restoreCopy. */
  instanceId?: string;
  /** §6 (r8): this machine's bb hostId — a project source counts only
   * when its path's hostId is this host. */
  localHostId?: () => string | Promise<string>;
  hostname?: string;
  now?: () => number;
  log?: {
    info?(m: string): void;
    warn?(m: string): void;
    error?(m: string): void;
  };
}

interface TaskShow {
  task?: { id?: string; key?: string; title?: string; status?: string };
  comments?: {
    id?: string;
    kind?: string;
    threadId?: string | null;
    body?: string;
    createdAt?: string;
  }[];
}

export interface ReleaseInput {
  taskKey: string;
  caller: ThreadFacts;
  noDocs?: string;
  kb?: string;
  noKb?: string;
}

export interface ReleaseResult {
  ok: true;
  releaseId: number;
  taskKey: string;
  status: "auditing";
  auditThreadId: string | null;
  warnings: ScanFinding[];
  /** §6 (r7): the bb project whose settings the release used — the
   * project's own entry in the release config. */
  settingsProjectId: string;
  /** §6 (r7): the delegation's project (`executor.project_id`) — named
   * alongside the settings project in the output. */
  delegationProjectId: string;
}

// ── Git helpers ────────────────────────────────────────────────────────

async function git(
  deps: ReleaseDeps,
  repo: string,
  args: string[],
  opts: { allowFail?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const res = await deps.cmd.run("git", ["-C", repo, ...args], {
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  if (res.exitCode !== 0 && !opts.allowFail) {
    throw new OrchestratorError(
      "git-failed",
      `git ${args.join(" ")} failed (exit ${res.exitCode}): ${
        res.stderr.trim() || res.stdout.trim() || "no output"
      }`,
    );
  }
  return res.stdout.trim();
}

/** §17.3 (ревью PLUG-216 Б1): the stable patch-id of one commit — a
 * rebase rewrite changes the sha but keeps the diff, a foreign commit's
 * id never matches the pre-rebase set. Empty diffs (merge commits,
 * empty commits) yield no id. */
async function patchId(
  deps: ReleaseDeps,
  repo: string,
  sha: string,
): Promise<string | null> {
  const diff = await deps.cmd.run(
    "git",
    ["-C", repo, "show", "--format=", sha],
    { timeoutMs: 30_000 },
  );
  if (diff.exitCode !== 0) return null;
  const id = await deps.cmd.run(
    "git",
    ["-C", repo, "patch-id", "--stable"],
    { timeoutMs: 30_000, stdin: diff.stdout },
  );
  if (id.exitCode !== 0) return null;
  return id.stdout.trim().split(/\s+/)[0] || null;
}

/**
 * §17.3 (ревью PLUG-217): identity of a patch-id-less commit —
 * author + message. A rebase keeps or drops empty-diff commits, so a
 * post-rebase commit without a patch-id must match one of the
 * pre-rebase ones by identity, not just by head count.
 */
async function emptyCommitKey(
  deps: ReleaseDeps,
  repo: string,
  sha: string,
): Promise<string> {
  return git(deps, repo, [
    "log",
    "-1",
    "--format=%an%x00%ae%x00%B",
    sha,
  ]);
}

// ── Step 0 (r8): проект настройки по репозиторию, падает закрыто ──────

interface BbProjectListItem {
  id?: string;
  gitRemoteUrl?: string | null;
  sources?: {
    type?: string;
    path?: string | null;
    isDefault?: boolean;
    hostId?: string | null;
  }[];
}

/** §6 (r8) п.1: the main checkout dir is the `worktree` line of the
 * FIRST record of `git worktree list --porcelain`; a record with the
 * `bare` marker is not a match (null). */
function mainWorktreeDir(porcelain: string): string | null {
  const first = porcelain.split(/\r?\n\r?\n/)[0] ?? "";
  if (first.split("\n").some((l) => l.trim() === "bare")) return null;
  const wt = first.split("\n").find((l) => l.startsWith("worktree "));
  return wt ? wt.slice("worktree ".length).trim() || null : null;
}

/** §6 (r8) п.3: a remote url reduced to `host/path` — the scheme and
 * `git@host:` forms both lose their transport, userinfo and port are
 * dropped, the host is lowercased, `.git` and trailing slashes go away.
 * A local path (no host) normalizes to null. */
export function normalizeGitRemoteUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let host = "";
  let path = "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    try {
      const u = new URL(s);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else {
    const m = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(s);
    if (!m) return null;
    host = m[1]!;
    path = m[2]!;
  }
  host = host.toLowerCase();
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return host && path ? `${host}/${path}` : null;
}

/**
 * §6 (r8): which project's settings a release runs under — the bb
 * project of the REPOSITORY, resolved once on step 1 and recorded in
 * the release row. The main checkout dir of the executor's copy (first
 * `git worktree list` record, compared by realpath) decides; with no
 * path match the copy's `origin` is compared against project
 * `gitRemoteUrl`s — such a candidate counts only with an explicit
 * `projects` entry and a path that exists on this machine. One
 * candidate wins; several resolve to the delegation's project when it
 * is among them, else `release-settings-ambiguous`; none —
 * `release-settings-unknown`. Any git/`bb project list`/realpath
 * failure refuses the same way — the gate fails CLOSED, never silently
 * substituting the delegation project (ADR-0018, дополнение r8). The
 * remote url never reaches messages (it may carry a token).
 */
export async function settingsProjectId(
  deps: Pick<ReleaseDeps, "cmd" | "bbCli" | "localHostId">,
  repo: string,
  delegationProjectId: string,
  config: ReleaseConfig | null,
): Promise<string> {
  const unknown = (why: string) =>
    new OrchestratorError(
      "release-settings-unknown",
      `проект настройки не определён (${why}); ` +
        `проект делегирования ${delegationProjectId}`,
      "привяжите bb-проект к репозиторию копии (§6) и повторите",
    );

  const wt = await deps.cmd.run(
    "git",
    ["-C", repo, "worktree", "list", "--porcelain"],
    { timeoutMs: 30_000 },
  );
  if (wt.exitCode !== 0) {
    throw unknown(`git worktree list завершился с кодом ${wt.exitCode}`);
  }
  // §6 п.1: a bare first record is no match — the main dir is unset.
  const mainDir = mainWorktreeDir(wt.stdout);

  const listRes = await deps.bbCli.run(["project", "list", "--json"], {
    timeoutMs: 15_000,
  });
  if (listRes.exitCode !== 0) {
    throw unknown(`bb project list завершился с кодом ${listRes.exitCode}`);
  }
  let projects: BbProjectListItem[];
  try {
    const parsed: unknown = JSON.parse(listRes.stdout);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    projects = parsed as BbProjectListItem[];
  } catch {
    throw unknown("bb project list вернул JSON неожиданной формы");
  }

  const localHost = deps.localHostId
    ? String((await deps.localHostId()) ?? "")
    : "";
  // §6 п.2: the project's MAIN path on THIS host — the default
  // local_path source whose hostId is this host (an unset hostId is a
  // pre-hostfield record). Secondary sources never count.
  const mainPathOf = (p: BbProjectListItem): string | null => {
    for (const s of p.sources ?? []) {
      if (s.type !== "local_path" || !s.path || s.isDefault !== true) continue;
      if (s.hostId && s.hostId !== localHost) continue;
      return s.path;
    }
    return null;
  };

  const candidates = new Set<string>();
  if (mainDir) {
    let root: string;
    try {
      root = await realpath(mainDir);
    } catch {
      throw unknown("realpath основного каталога копии не удался");
    }
    for (const p of projects) {
      if (!p.id) continue;
      const mainPath = mainPathOf(p);
      if (!mainPath) continue;
      try {
        if ((await realpath(mainPath)) === root) candidates.add(p.id);
      } catch {
        // §6 п.2: a path missing on this machine is no candidate
        // and no error.
      }
    }
  }

  // §6 п.3: only with NO path candidates — the copy's `origin` against
  // normalized project gitRemoteUrls.
  if (!candidates.size) {
    const remote = await deps.cmd.run(
      "git",
      ["-C", repo, "remote", "get-url", "origin"],
      { timeoutMs: 30_000 },
    );
    if (remote.exitCode !== 0) {
      throw unknown(`git remote get-url завершился с кодом ${remote.exitCode}`);
    }
    const want = normalizeGitRemoteUrl(remote.stdout);
    if (want) {
      for (const p of projects) {
        // an explicit `projects` entry is required (§6 п.3)
        if (!p.id || !config?.projects?.[p.id]) continue;
        const their = p.gitRemoteUrl
          ? normalizeGitRemoteUrl(p.gitRemoteUrl)
          : null;
        if (!their || their !== want) continue;
        const mainPath = mainPathOf(p);
        if (!mainPath || !existsSync(mainPath)) continue;
        candidates.add(p.id);
      }
    }
  }

  // §6 п.4: one candidate → it; several → the delegation's project if
  // among them, else ambiguous; none → unknown.
  if (candidates.size === 1) return [...candidates][0]!;
  if (candidates.size > 1) {
    if (candidates.has(delegationProjectId)) return delegationProjectId;
    throw new OrchestratorError(
      "release-settings-ambiguous",
      `репозиторий копии совпадает с несколькими bb-проектами ` +
        `(${[...candidates].sort().join(", ")}), проект делегирования ` +
        `${delegationProjectId} не среди них`,
      "оставьте один bb-проект на этот репозиторий (§6) и повторите",
    );
  }
  throw unknown("ни один bb-проект не совпал с репозиторием копии");
}

// ── Step 1: приёмка ────────────────────────────────────────────────────

const TASK_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;

async function resolveTask(
  deps: ReleaseDeps,
  input: string,
): Promise<{ key: string; show: TaskShow }> {
  let key = input.trim();
  const show = await runJson<TaskShow>(deps.bbCli, [
    "tasks",
    "show",
    key,
    "--json",
  ]).catch((e) => {
    throw new OrchestratorError(
      "task-not-found",
      `cannot resolve task "${input}": ${message(e)}`,
    );
  });
  if (show.task?.key) key = show.task.key;
  if (!TASK_KEY_RE.test(key)) {
    throw new OrchestratorError(
      "task-not-found",
      `cannot resolve task "${input}" to a key`,
    );
  }
  return { key: key.toUpperCase(), show };
}

/** Step-1 review verdict (§16.7 r25): the auditor ends its report with a
 * strict JSON line `{"verdict":"OK"|"CHANGES","blockers":<n>}`. Release
 * reads that line — prose «ОК» markers no longer count, and a report
 * without the line is not accepted. Scans the report for JSON lines and
 * judges by the last one. */
/** §17 r31: the strict JSON verdict line of a reviewer report —
 * "ok"/"not-ok" by the last verdict line, null when the body carries no
 * verdict line at all ("нет вердикта" is not "не ОК"). */
export function verdictInBody(body: string): "ok" | "not-ok" | null {
  let verdict: unknown;
  let blockers: unknown;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    // §16.7/r31: только отдельная строка-JSON — хвост после прозы
    // вердиктом не считается (ревью PLUG-244 заход 1, Н8).
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    let parsed: { verdict?: unknown; blockers?: unknown };
    try {
      parsed = JSON.parse(line) as {
        verdict?: unknown;
        blockers?: unknown;
      };
    } catch {
      continue;
    }
    if (parsed.verdict !== "OK" && parsed.verdict !== "CHANGES") continue;
    verdict = parsed.verdict;
    blockers = parsed.blockers;
  }
  if (verdict === undefined) return null;
  // §16.7 (PLUG-186): the verdict line carries `blockers` — a missing
  // field is not an OK.
  return verdict === "OK" && blockers === 0 ? "ok" : "not-ok";
}

export function reviewVerdictOk(body: string): boolean {
  return verdictInBody(body) === "ok";
}

async function reviewVerdict(
  deps: ReleaseDeps,
  show: TaskShow,
  delegation: DelegationRow,
): Promise<"ok" | "missing" | "not-ok"> {
  const comments = (show.comments ?? [])
    .filter((c) => c.kind === "agent" && c.threadId === delegation.thread_id)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const last = comments.at(-1);
  // §17 r31: a verdict line in the last agent comment decides; a
  // comment WITHOUT the JSON line falls through to the thread's last
  // message instead of counting "not OK".
  if (last?.body) {
    const v = verdictInBody(last.body);
    if (v) return v;
  }
  // §17.3 (мелко 5): no verdict comment — the reviewer's own thread
  // output is the fallback source (a report sent as the final message
  // without a task comment still counts).
  if (delegation.thread_id) {
    try {
      const res = await deps.threads.output({
        threadId: delegation.thread_id,
      });
      const out = res?.output;
      if (out) {
        const v = verdictInBody(out);
        if (v) return v;
      }
    } catch {
      // an unreadable thread output counts as no verdict
    }
  }
  return "missing";
}

/** §2 step 1 — everything the pipeline refuses on, as one list. */
async function acceptTask(
  input: ReleaseInput,
  deps: ReleaseDeps,
): Promise<{
  taskKey: string;
  title: string;
  executor: DelegationRow;
}> {
  const { key, show } = await resolveTask(deps, input.taskKey);
  const missing: string[] = [];

  // §2.3 r24: levels carry a `role` — executors do the work, auditor
  // levels (any name) review it; release-audit stays its own thing.
  const policy = (await deps.loadPolicy()).policy;
  const roleOf = (level: string) =>
    level === AUDIT_LEVEL ? "release-audit" : levelRole(policy, level);

  const executor = deps.store
    .delegationsByTask(key)
    .find((d) => roleOf(d.level) === "executor" && d.status === "done");
  if (!executor) missing.push("нет делегирования в статусе done");
  // §4.1 r28.1: a «задача без кода» round that produced no commits has
  // nothing to publish — a hard refusal before the sha/review gate.
  if (
    executor &&
    executor.no_code === 1 &&
    (executor.result_commits ?? 0) === 0
  ) {
    throw new OrchestratorError(
      "release-refused",
      `release ${key}: задача без кода: вливать нечего`,
    );
  }

  // §17.3 (Б4): the review gate is bound to the published sha — a
  // plain executor result needs an OK review on its `result_sha`
  // («Проверяемый итог: коммит <sha>» rides in the review's
  // `continue_from`). A merged result's gate needs the branch tip, so
  // it lives in `reviewGate` at the start of the pipeline (tip review OR
  // per-delegation `merged_sha` reviews, §17.3 по ревью PLUG-210).
  const requiredSha = executor
    ? executor.merge_status === "merged"
      ? executor.merged_sha
      : executor.result_sha
    : null;
  if (executor && !requiredSha) {
    missing.push(
      "итог делегирования без зафиксированного sha — ревью не привязать",
    );
  } else if (executor && executor.merge_status !== "merged") {
    const review = deps.store
      .delegationsByTask(key)
      .find(
        (d) =>
          roleOf(d.level) === "auditor" && d.continue_from === requiredSha,
      );
    if (!review) {
      missing.push(
        `нет ревью аудиторского уровня на публикуемый итог ` +
          `${requiredSha!.slice(0, 7)}`,
      );
    } else if (review.status !== "done") {
      missing.push(
        `ревью на ${requiredSha!.slice(0, 7)} (уровень ${review.level}) ` +
          `в статусе ${review.status}`,
      );
    } else {
      const v = await reviewVerdict(deps, show, review);
      if (v === "missing") {
        missing.push("вердикт ревью не найден ни в комментариях, ни в итоге треда");
      } else if (v === "not-ok") {
        missing.push("последнее ревью — вердикт не «OK» (§16.7 JSON)");
      }
    }
  }

  if (executor && executor.coordinator_thread_id !== input.caller.threadId) {
    missing.push(
      "вызывающий тред — не координатор этого делегирования",
    );
  }
  if (missing.length) {
    throw new OrchestratorError(
      "release-refused",
      `release ${key}: приёмка не пройдена — ${missing.join("; ")}`,
    );
  }
  return {
    taskKey: key,
    title: show.task?.title ?? key,
    executor: executor!,
  };
}

// ── Step 2: ветка / sync ───────────────────────────────────────────────

async function gitRefExists(
  deps: ReleaseDeps,
  repo: string,
  ref: string,
): Promise<boolean> {
  const res = await deps.cmd.run(
    "git",
    ["-C", repo, "rev-parse", "--verify", "--quiet", ref],
    { timeoutMs: 30_000 },
  );
  return res.exitCode === 0;
}

async function syncBranch(
  deps: ReleaseDeps,
  repo: string,
  branch: string,
  project: ResolvedProject,
  ctx: { taskKey: string; expectedSha: string },
): Promise<{
  baseSha: string;
  remoteBaseSha: string | null;
  postSyncSha: string;
  /** §17.3 (ревью PLUG-216 Б1): only the commits the pipeline itself
   * created during the sync — the merge commit, or the rewritten
   * commits a rebase produced (matched by patch-id). Never the whole
   * `expectedSha..HEAD` range: a foreign commit in it stays foreign. */
  pipelineShas: string[];
}> {
  const dirty = await git(deps, repo, ["status", "--porcelain"]);
  if (dirty) {
    throw new OrchestratorError(
      "release-refused",
      "в рабочей копии есть незакоммиченные изменения — release отклонён",
      "закоммить или убрать изменения и повторить",
    );
  }
  await git(deps, repo, ["fetch", "origin"], { timeoutMs: 180_000 });
  // §17.3 (ревью PLUG-216 Б1): the step-1 gate vetted `expectedSha` —
  // between it and this fetch (the tasks show, the release row, up to
  // 180 s of network) a revived executor can land a commit no review
  // covers. Re-verify the tip BEFORE the pipeline mutates it.
  const fetchedHead = await git(deps, repo, ["rev-parse", "HEAD"]);
  if (fetchedHead !== ctx.expectedSha) {
    const extra = (
      await git(deps, repo, [
        "rev-list",
        `${ctx.expectedSha}..${fetchedHead}`,
      ])
    )
      .split("\n")
      .filter(Boolean);
    throw new OrchestratorError(
      "unreviewed-commits",
      `release ${ctx.taskKey}: во время sync на ветку ${branch} легли ` +
        `коммиты сверх проверенной вершины ${ctx.expectedSha.slice(0, 7)}` +
        (extra.length
          ? `: ${extra.map((x) => x.slice(0, 7)).join(", ")}`
          : ` (вершина ${fetchedHead.slice(0, 7)})`),
      "ревью покрывает вершину на момент гейта — повторите release, когда исполнитель остановлен",
    );
  }
  const target = `origin/${project.target.branch}`;
  const remoteBaseSha = (await gitRefExists(deps, repo, target))
    ? await git(deps, repo, ["rev-parse", target])
    : null;
  const pipelineShas: string[] = [];
  let verifiedTip = ctx.expectedSha;
  if (remoteBaseSha) {
    if (project.sync === "rebase") {
      // §2: rebase only for never-pushed branches.
      const remote = await git(
        deps,
        repo,
        ["ls-remote", "--heads", "origin", branch],
        { timeoutMs: 60_000 },
      );
      if (remote.trim()) {
        throw new OrchestratorError(
          "release-refused",
          `ветка ${branch} уже запушена — sync=rebase запрещён`,
          'переведите проект на sync="merge" или заведите новую ветку',
        );
      }
      // §17.3 (ревью PLUG-216 Б1): before the rebase, the patch-ids of
      // the range it will rewrite — after it, every commit over the
      // remote base must be one of those rewrites, or it is foreign.
      const preShas = (
        await git(deps, repo, [
          "rev-list",
          `${remoteBaseSha}..${ctx.expectedSha}`,
        ])
      )
        .split("\n")
        .filter(Boolean);
      const preIds = new Set<string>();
      const preNoId = new Map<string, number>();
      for (const sha of preShas) {
        const id = await patchId(deps, repo, sha);
        if (id) preIds.add(id);
        else {
          const key = await emptyCommitKey(deps, repo, sha);
          preNoId.set(key, (preNoId.get(key) ?? 0) + 1);
        }
      }
      const res = await deps.cmd.run(
        "git",
        ["-C", repo, "rebase", target],
        { timeoutMs: 300_000 },
      );
      if (res.exitCode !== 0) {
        await git(deps, repo, ["rebase", "--abort"], { allowFail: true });
        throw new OrchestratorError(
          "release-refused",
          `rebase на ${target}: конфликт — сведи вручную`,
        );
      }
      const preShaSet = new Set(preShas);
      const head = await git(deps, repo, ["rev-parse", "HEAD"]);
      const postShas = (
        await git(deps, repo, ["rev-list", `${remoteBaseSha}..${head}`])
      )
        .split("\n")
        .filter(Boolean);
      const foreign: string[] = [];
      for (const sha of postShas) {
        const id = await patchId(deps, repo, sha);
        if (id && preIds.has(id)) continue;
        // an empty-diff commit carries no patch-id — allow it only if
        // the pre-rebase range had the same author+message commit (a
        // rebase drops or keeps them, but never creates new ones).
        if (!id) {
          const key = await emptyCommitKey(deps, repo, sha);
          const left = preNoId.get(key) ?? 0;
          if (left > 0) {
            preNoId.set(key, left - 1);
            continue;
          }
        }
        foreign.push(sha);
      }
      if (foreign.length) {
        throw new OrchestratorError(
          "unreviewed-commits",
          `release ${ctx.taskKey}: после rebase на ветке ${branch} ` +
            `коммиты вне проверенного диапазона: ` +
            foreign.map((x) => x.slice(0, 7)).join(", "),
          "повторите release, когда исполнитель остановлен",
        );
      }
      // only genuinely rewritten commits are pipeline-made — an
      // unchanged sha (no-op rebase) is the executor's own work.
      pipelineShas.push(...postShas.filter((x) => !preShaSet.has(x)));
      verifiedTip = head;
    } else {
      // §16.6: an explicit `-m` — the default merge message embeds the
      // source and target branch names, which the leak scan must not see.
      const res = await deps.cmd.run(
        "git",
        [
          "-C",
          repo,
          "merge",
          "-m",
          `merge ${remoteBaseSha.slice(0, 7)}`,
          target,
        ],
        { timeoutMs: 300_000 },
      );
      if (res.exitCode !== 0) {
        await git(deps, repo, ["merge", "--abort"], { allowFail: true });
        throw new OrchestratorError(
          "release-refused",
          `merge ${target}: конфликт — сведи вручную`,
        );
      }
      // §17.3 (ревью PLUG-216 Б1): the only tips the sync may leave are
      // the pipeline's own merge commit (first parent the vetted tip,
      // second the remote base), a fast-forward onto the remote base,
      // or the unchanged `expectedSha`. Anything else is foreign work
      // landed mid-sync.
      const head = await git(deps, repo, ["rev-parse", "HEAD"]);
      if (head !== ctx.expectedSha) {
        const parents = (
          await git(deps, repo, ["rev-list", "--parents", "-n", "1", head])
        )
          .trim()
          .split(/\s+/);
        const isPipelineMerge =
          parents.length === 3 &&
          parents[1] === ctx.expectedSha &&
          parents[2] === remoteBaseSha;
        const isFastForward =
          head === remoteBaseSha &&
          (await isAncestor(deps, repo, ctx.expectedSha, remoteBaseSha));
        if (isPipelineMerge) {
          pipelineShas.push(head);
        }
        if (!isPipelineMerge && !isFastForward) {
          const extra = (
            await git(deps, repo, [
              "rev-list",
              `${ctx.expectedSha}..${head}`,
              "--not",
              remoteBaseSha,
            ])
          )
            .split("\n")
            .filter(Boolean);
          throw new OrchestratorError(
            "unreviewed-commits",
            `release ${ctx.taskKey}: во время sync на ветку ${branch} ` +
              `легли коммиты сверх проверенной вершины ` +
              `${ctx.expectedSha.slice(0, 7)}: ` +
              (extra.length
                ? extra.map((x) => x.slice(0, 7)).join(", ")
                : head.slice(0, 7)),
            "повторите release, когда исполнитель остановлен",
          );
        }
        verifiedTip = head;
      } else {
        verifiedTip = ctx.expectedSha;
      }
    }
  }
  // §17.3 (ревью PLUG-216 Б1): the post-sync tip is the one sync itself
  // verified — not a fresh `rev-parse` whose tiny gap would let a commit
  // slipped in between pass the checks-window comparison below.
  const postSyncSha = verifiedTip;
  const baseSha = remoteBaseSha
    ? await git(deps, repo, ["merge-base", target, "HEAD"])
    : EMPTY_TREE_SHA;
  return { baseSha, remoteBaseSha, postSyncSha, pipelineShas };
}

// ── Step 3: проверки проекта ───────────────────────────────────────────

async function runProjectChecks(
  deps: ReleaseDeps,
  repo: string,
  checks: readonly string[],
  checksMinutes: number,
): Promise<void> {
  for (const check of checks) {
    const res = await deps.cmd.run("sh", ["-c", check], {
      cwd: repo,
      timeoutMs: checksMinutes * 60_000,
    });
    if (res.exitCode !== 0) {
      const tail = (res.stderr + "\n" + res.stdout).trim().split("\n");
      throw new OrchestratorError(
        "release-refused",
        `проверка проекта упала: ${check} (exit ${res.exitCode})\n` +
          tail.slice(-20).join("\n"),
      );
    }
  }
}

// ── Docs-not-needed trailer (§3) ──────────────────────────────────────

const DOCS_TRAILER_RE = /^Docs-not-needed\s*:/im;

async function applyDocsTrailer(
  deps: ReleaseDeps,
  repo: string,
  reason: string,
): Promise<void> {
  const body = await git(deps, repo, ["log", "-1", "--format=%B"]);
  if (DOCS_TRAILER_RE.test(body)) return;
  // An already-published HEAD may not be amended (no force-push ever) —
  // the trailer lands in an empty commit instead.
  const published = await git(
    deps,
    repo,
    ["branch", "-r", "--contains", "HEAD"],
    { allowFail: true },
  );
  const trailer = `Docs-not-needed: ${reason}`;
  if (published.trim()) {
    await git(deps, repo, [
      "commit",
      "--allow-empty",
      "-m",
      "release: документы не требуются",
      "-m",
      trailer,
    ]);
  } else {
    await git(deps, repo, [
      "commit",
      "--amend",
      "-m",
      body,
      "-m",
      trailer,
    ]);
  }
}

// ── Commit metadata + diff ─────────────────────────────────────────────

async function commitRange(
  deps: ReleaseDeps,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<CommitMeta[]> {
  const raw = await git(deps, repo, [
    "log",
    "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e",
    `${baseSha}..${headSha}`,
  ]);
  const out: CommitMeta[] = [];
  for (const rec of raw.split("\x1e")) {
    const fields = rec.replace(/^\n+/, "").split("\x1f");
    if (fields.length < 6 || !fields[0]) continue;
    const [sha, an, ae, cn, ce, ...bodyParts] = fields;
    out.push({
      sha: sha!,
      authorName: an ?? "",
      authorEmail: ae ?? "",
      committerName: cn ?? "",
      committerEmail: ce ?? "",
      body: bodyParts.join("\x1f"),
    });
  }
  return out;
}

async function allowedAuthor(
  deps: ReleaseDeps,
  repo: string,
  identity: string | undefined,
): Promise<{ name: string; email: string } | undefined> {
  if (!identity) return undefined;
  if (identity !== "repo") {
    const m = /^([^\n<>]+?)\s*<([^\s<>]+@[^\s<>]+)>\s*$/.exec(identity);
    return m ? { name: m[1]!, email: m[2]! } : undefined;
  }
  const name = await git(deps, repo, ["config", "user.name"], {
    allowFail: true,
  });
  const email = await git(deps, repo, ["config", "user.email"], {
    allowFail: true,
  });
  if (!name.trim() || !email.trim()) return undefined;
  return { name: name.trim(), email: email.trim() };
}

// ── Step 5: audit packet + verdict ─────────────────────────────────────

/** Docs the auditor checks (§6 `docsMap`): the union of map entries whose
 * path prefix covers a changed file; without a map — the repo's whole
 * `docs/` + `README*` + ADR. */
export function docsForChanges(
  changed: readonly string[],
  docsMap: Record<string, string[]>,
): string[] | null {
  const keys = Object.keys(docsMap);
  if (!keys.length) return null;
  const docs = new Set<string>();
  for (const [prefix, list] of Object.entries(docsMap)) {
    if (changed.some((f) => f.startsWith(prefix))) {
      for (const d of list) docs.add(d);
    }
  }
  return [...docs].sort();
}

export interface AuditVerdict {
  verdict: "APPROVE" | "REJECT";
  findings: {
    category?: string;
    file?: string;
    line?: number;
    problem?: string;
    fix?: string;
  }[];
  /** True when the agent's answer did not parse — counts as REJECT (§3). */
  unparseable: boolean;
}

/** §3: the auditor answers strict JSON; fences or prose around it are
 * tolerated on extraction, an unparseable verdict is a REJECT. */
export function parseAuditVerdict(text: string): AuditVerdict {
  const fail = (): AuditVerdict => ({
    verdict: "REJECT",
    findings: [
      {
        category: "verdict",
        problem: "ответ проверяющего агента не парсится как строгий JSON",
        fix: "перезапустить аудит или проверить вручную",
      },
    ],
    unparseable: true,
  });
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end <= start) return fail();
    try {
      parsed = JSON.parse(t.slice(start, end + 1));
    } catch {
      return fail();
    }
  }
  const v = (parsed as { verdict?: unknown; findings?: unknown }) ?? {};
  if (v.verdict !== "APPROVE" && v.verdict !== "REJECT") return fail();
  // Findings come straight from the agent — coerce optional fields to
  // their reported types so downstream code (maskSecrets, formatting)
  // never crashes on e.g. a numeric category.
  const findings = (
    Array.isArray(v.findings) ? (v.findings as Record<string, unknown>[]) : []
  ).map((f) => ({
    category: f?.category == null ? undefined : String(f.category),
    file: f?.file == null ? undefined : String(f.file),
    line: Number.isFinite(Number(f?.line)) ? Number(f.line) : undefined,
    problem: f?.problem == null ? undefined : String(f.problem),
    fix: f?.fix == null ? undefined : String(f.fix),
  }));
  return { verdict: v.verdict, findings, unparseable: false };
}

/** The auditor's last message — `item/completed` agentMessage text. */
async function lastAgentMessage(
  deps: ReleaseDeps,
  threadId: string,
): Promise<string | null> {
  const events = await deps.threads.events.list({
    threadId,
    order: "desc",
    limit: "50",
    types: ["item/completed"],
  });
  for (const ev of events) {
    const item = (ev.data ?? {}) as {
      item?: { type?: unknown; text?: unknown };
    };
    if (item.item?.type === "agentMessage" && typeof item.item.text === "string") {
      return item.item.text;
    }
  }
  return null;
}

// ── §5 one-time push token ─────────────────────────────────────────────

/**
 * The shared pre-push hook lets a push through only with a one-time token
 * the plugin writes for this exact branch+commit: a `push-token-<id>.json`
 * file, mode 0600, in a 0700 dir — a file, not an agent env var (§5).
 * §16.6: the token binds the target BRANCH and the SHA, and every release
 * run writes its own file — two parallel releases never clobber each
 * other's marker. The hook scans the dir for the matching token.
 */
export function writePushToken(
  hooksDir: string,
  sha: string,
  branch: string,
  now = Date.now(),
): string {
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  chmodSync(hooksDir, 0o700);
  const token = randomBytes(24).toString("hex");
  const file = join(hooksDir, `push-token-${token.slice(0, 16)}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      token,
      sha,
      branch,
      expiresAt: now + TOKEN_TTL_MS,
    }),
    { mode: 0o600 },
  );
  return file;
}

export function clearPushToken(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort cleanup; the TTL bounds a stale token anyway
  }
}

/** The plugin's own hook source — `hooks/` next to `src/`. */
const PLUGIN_HOOKS_DIR = fileURLToPath(new URL("../hooks", import.meta.url));
const PLUGIN_HOOK = join(PLUGIN_HOOKS_DIR, "pre-push");

/** §17.3 (Б2): standard names the installer covers — shared with
 * `hooks/install.mjs`, which reads the same `hook-names` file. */
function standardHookNames(): string[] {
  try {
    return readFileSync(join(PLUGIN_HOOKS_DIR, "hook-names"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return ["pre-push"];
  }
}

/**
 * §16.6 (PLUG-189): a plugin update changes the hook but the installed
 * copy in `hooksDir` does not follow — a stale hook may reject every
 * push («no marker» for the new token file names). Release compares the
 * installed hook byte-for-byte with the plugin's and refuses early with
 * a reinstall hint. A missing hook is not an error: the gate is a
 * forgetfulness guard, an absent guard simply does not fire.
 */
function assertInstalledHookFresh(deps: ReleaseDeps): void {
  // §17.3 (Б2): the installer writes a wrapper under EVERY standard
  // name — `pre-push` is the gate, the rest are copies of `chain`. A
  // stale or missing file of any kind leaves local hooks silently
  // disabled; missing files count only when at least one wrapper exists
  // (no hooks installed at all = no guard, not an error).
  const dir = deps.hooksDir();
  const names = standardHookNames();
  const stale: string[] = [];
  const missing: string[] = [];
  let present = 0;
  for (const name of names) {
    let installed: Buffer;
    try {
      installed = readFileSync(join(dir, name));
    } catch {
      missing.push(name);
      continue;
    }
    present++;
    let current: Buffer;
    try {
      current = readFileSync(
        join(PLUGIN_HOOKS_DIR, name === "pre-push" ? "pre-push" : "chain"),
      );
    } catch {
      continue;
    }
    if (!installed.equals(current)) stale.push(name);
  }
  // §17.3 (ревью PLUG-214): `push-to-checkout` is retired — a leftover
  // wrapper still disables git's built-in worktree update on
  // updateInstead pushes. Its presence alone is a stale install.
  if (existsSync(join(dir, "push-to-checkout"))) {
    stale.push("push-to-checkout");
  }
  // §17.3 (ревью PLUG-210): a partial install (e.g. a pre-r26 one with
  // `pre-push` only) leaves every OTHER local hook dead — that is a
  // stale install, not «guard absent».
  const problems = [
    ...stale,
    ...(present > 0 && missing.length
      ? [`нет обёрток: ${missing.join(", ")}`]
      : []),
  ];
  if (problems.length) {
    throw new OrchestratorError(
      "hook-stale",
      `установленные общие хуки устарели или неполные ` +
        `(${problems.join(", ")})`,
      `переустановите хуки: node ${join(
        PLUGIN_HOOKS_DIR,
        "install.mjs",
      )} --hooks-dir ${deps.hooksDir()}`,
    );
  }
}

// ── Notify / comment helpers ───────────────────────────────────────────

async function commentOnTask(
  deps: { bbCli: BbCli; log?: { warn?(m: string): void } },
  taskKey: string,
  text: string,
): Promise<void> {
  try {
    await runChecked(deps.bbCli, [
      "tasks",
      "comment",
      taskKey,
      "--body",
      text,
    ]);
  } catch (e) {
    deps.log?.warn?.(`orchestrator: release comment: ${message(e)}`);
  }
}

// ── runRelease: steps 1–5 dispatch ─────────────────────────────────────

/**
 * The `bb orchestrator release` entry: caller gate → приёмка → sync →
 * project checks → machine scan → audit dispatch. Throws
 * `OrchestratorError` on any step failure — the task stays with the
 * coordinator. Returns as soon as the audit thread is dispatched.
 */
export async function runRelease(
  input: ReleaseInput,
  deps: ReleaseDeps,
): Promise<ReleaseResult> {
  if (!isCoordinator(input.caller, deps.probes)) {
    throw new OrchestratorError(
      "not-a-coordinator",
      `thread ${input.caller.threadId} is not a coordinator`,
      "release is only available to coordinator threads",
    );
  }

  const cfg = deps.loadReleaseConfig();
  if (cfg.empty) {
    throw new OrchestratorError(
      "release-disabled",
      "настройка release не задана",
      "задайте `bb plugin config orchestrator set release '<json>'` (§6)",
    );
  }
  if (!cfg.config) {
    const first = cfg.errors[0];
    throw new OrchestratorError(
      "release-config-invalid",
      `release config: ${first ? `${first.path}: ${first.message}` : "invalid"}`,
      "исправьте настройку `release` и выполните `bb plugin reload orchestrator`",
    );
  }

  // orchestrator §2 rev 20: the release-audit level must exist up front —
  // the checking agent is part of the pipeline, not an optional extra.
  const policyLoad = await deps.loadPolicy();
  if (!policyLoad.policy) {
    const first = policyLoad.errors[0];
    throw new OrchestratorError(
      "policy-invalid",
      `policy is not usable: ${first ? `${first.path}: ${first.message}` : "empty"}`,
    );
  }
  if (!policyLoad.policy.levels[AUDIT_LEVEL]) {
    throw new OrchestratorError(
      "release-level-missing",
      `уровень "${AUDIT_LEVEL}" не задан в политике`,
      "добавьте уровень release-audit с цепочкой маршрутов в policy (§3)",
    );
  }

  // §16.6 (PLUG-189): a stale installed hook would refuse the §5 push
  // («no marker» for the new token file names) — refuse early with a
  // reinstall hint instead.
  assertInstalledHookFresh(deps);

  // Step 1 — приёмка.
  const { taskKey, title, executor } = await acceptTask(input, deps);
  if (deps.store.activeReleaseByTask(taskKey)) {
    throw new OrchestratorError(
      "release-in-progress",
      `по задаче ${taskKey} уже идёт выкладка`,
    );
  }
  // §16.6: publish the branch that holds the task's result — a merged
  // round lives on `merged_into` in the coordinator's copy; anything else
  // still sits on the executor's own branch.
  let repo: string | null;
  let branch: string | null;
  if (executor.merge_status === "merged") {
    if (!executor.merged_into) {
      throw new OrchestratorError(
        "release-refused",
        "делегирование помечено merged, но ветка merged_into не записана",
      );
    }
    const coordThread = await deps.threads.get({
      threadId: input.caller.threadId,
    });
    repo = coordThread.environmentPath ?? null;
    branch = executor.merged_into;
    if (!repo) {
      throw new OrchestratorError(
        "release-refused",
        "итог влит в копию координатора, но у вызывающего треда нет рабочей копии",
      );
    }
  } else {
    if (!executor.thread_id) {
      throw new OrchestratorError(
        "release-refused",
        "у делегирования нет треда исполнителя — рабочая копия не найдена",
      );
    }
    const execThread = await deps.threads.get({
      threadId: executor.thread_id,
    });
    repo = execThread.environmentPath ?? null;
    branch = execThread.environmentBranchName ?? null;
    if (!repo || !branch) {
      throw new OrchestratorError(
        "release-refused",
        "у исполнителя нет рабочей копии (environmentPath/environmentBranchName пусты)",
      );
    }
    // §17.3 (ревью PLUG-214): a running executor turn can commit onto
    // the branch while the pipeline's checks hold it — refuse at step 1
    // instead of publishing work no review covered.
    if (await executorTurnActive(deps, executor.thread_id)) {
      throw new OrchestratorError(
        "release-refused",
        `release ${taskKey}: у треда исполнителя идёт ход — ` +
          `его новые коммиты не покрыты ревью итога`,
        "дождитесь завершения хода исполнителя и повторите",
      );
    }
  }
  // §6 (r7): the settings project is the REPOSITORY's bb project — a
  // delegation dispatched from a parent project whose root sits above
  // the repo must not pick up the parent's settings. The merged and
  // executor copies are worktrees of one repo, so either copy's
  // `--git-common-dir` lands on the same main checkout.
  const delegationProjectId = executor.project_id ?? input.caller.projectId;
  const settingsProject = await settingsProjectId(
    deps,
    repo,
    delegationProjectId,
    cfg.config,
  );
  const project = resolveProject(cfg.config!, settingsProject);
  if (project.excluded) {
    throw new OrchestratorError(
      "release-excluded",
      `проект настройки ${settingsProject} исключён из release ` +
        `(excluded: true); проект делегирования ${delegationProjectId}`,
    );
  }
  // §16.6 (PLUG-189): a merged result publishes from the COORDINATOR's
  // copy — under the same per-copy lock `merge` takes (§14 check 4: one
  // merge/release per copy at a time), with the busy/clean checks BEFORE
  // `git switch` and the copy restored to its original branch in
  // `finally`. PLUG-191: the executor's own worktree takes the same
  // lock — two parallel release runs of one task would otherwise race
  // `git merge`/`--amend`/`git switch` in the same directory. It records
  // NO state and is never restored: unlike the coordinator's, this copy
  // is not required clean up front, so a restore would either mask the
  // real error over pre-existing dirt or wedge a dirty worktree's lock.
  const coordinatorCopy = executor.merge_status === "merged";
  const mgit: MergeGit = (args, opts) =>
    deps.cmd.run("git", ["-C", repo, ...args], {
      timeoutMs: opts?.timeoutMs ?? 120_000,
    });
  const gitDir = await git(deps, repo, ["rev-parse", "--absolute-git-dir"]);
  const lockPath = join(gitDir, MERGE_LOCK_NAME);
  const releaseLock = await acquireCopyLock(mgit, repo, lockPath);
  let copyToRestore: { branch: string; head: string | null } | null = null;
  try {
    if (coordinatorCopy) {
      const busy = COPY_BUSY_MARKERS.filter((n) =>
        existsSync(join(gitDir, n)),
      );
      if (busy.length) {
        throw new OrchestratorError(
          "copy-busy",
          `в копии координатора незавершённая операция (${busy.join(", ")})`,
          "завершите или отмените её (git merge|cherry-pick|revert|rebase --abort) и повторите",
        );
      }
      // §16.6: a dirty coordinator copy refuses BEFORE the switch —
      // uncommitted work must not travel onto merged_into.
      const porcelain = await git(deps, repo, ["status", "--porcelain"]);
      if (porcelain.trim()) {
        throw new OrchestratorError(
          "dirty-coordinator",
          "копия координатора грязная (незакоммиченные правки)",
          "закоммить или уберите изменения и повторите",
        );
      }
      const headRef = await git(deps, repo, ["symbolic-ref", "HEAD"], {
        allowFail: true,
      });
      const currentBranch = headRef.startsWith("refs/heads/")
        ? headRef.slice("refs/heads/".length)
        : "";
      if (!currentBranch) {
        throw new OrchestratorError(
          "detached-head",
          "копия координатора на отсоединённом HEAD — ветки нет",
          "перейдите на ветку (git switch <branch>) и повторите",
        );
      }
      const originalHead = await git(deps, repo, ["rev-parse", "HEAD"]);
      // §16.6 (PLUG-191): when the copy already sits on the published
      // branch its tip legitimately advances (the sync merge is real
      // work) — record an EMPTY head so this run's restore AND a
      // stale-lock breaker check branch+clean only. A recorded HEAD the
      // copy can never return to would wedge the lock forever.
      const restoreHead = currentBranch === branch ? null : originalHead;
      recordLockState(lockPath, currentBranch, restoreHead);
      copyToRestore = { branch: currentBranch, head: restoreHead };
      if (currentBranch !== branch) {
        await git(deps, repo, ["switch", branch]);
      }
    } else {
      const onBranch = await git(
        deps,
        repo,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        { allowFail: true },
      );
      if (onBranch !== branch) {
        await git(deps, repo, ["switch", branch]);
      }
    }
    return await runReleaseSteps(
      {
        taskKey,
        title,
        executor,
        project,
        repo,
        branch,
        policyLoad: policyLoad as PolicyLoad & { policy: Policy },
        settingsProjectId: settingsProject,
        delegationProjectId,
      },
      input,
      deps,
    );
  } finally {
    // §16.6: after the run (success or refusal) the coordinator copy
    // returns to its original branch with a clean status.
    const restoreError = copyToRestore
      ? await restoreCopy(mgit, copyToRestore.branch, copyToRestore.head)
      : null;
    releaseLock();
    if (restoreError) {
      throw new OrchestratorError(
        "copy-not-restored",
        `копия координатора не вернулась в исходное состояние: ${restoreError}`,
        `копия ${repo} — разберите вручную, там могло остаться незавершённое слияние`,
      );
    }
  }
}

// ── Step 1 (продолжение): гейт ревью по публикуемым SHA (§17.3) ──────

async function shaExists(
  deps: ReleaseDeps,
  repo: string,
  sha: string,
): Promise<boolean> {
  const res = await deps.cmd.run("git", ["-C", repo, "cat-file", "-e", sha], {
    timeoutMs: 30_000,
  });
  return res.exitCode === 0;
}

async function isAncestor(
  deps: ReleaseDeps,
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const res = await deps.cmd.run(
    "git",
    ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant],
    { timeoutMs: 30_000 },
  );
  return res.exitCode === 0;
}

/** §17.3 (ревью PLUG-214): first parent of `sha` — the review gate
 * descends through the pipeline's own commits; null for a root. */
async function firstParent(
  deps: ReleaseDeps,
  repo: string,
  sha: string,
): Promise<string | null> {
  const line = await git(deps, repo, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    sha,
  ]);
  return line.split(/\s+/)[1] ?? null;
}

/**
 * §17.3 (ревью PLUG-214): on the executor-branch path an in-flight turn
 * of the executor's thread refuses the release at step 1 — a commit it
 * lands while the pipeline runs would publish unreviewed. A queued
 * request counts as active too.
 *
 * §17.3 (ревью PLUG-216 п.2): the thread status is the PRIMARY signal —
 * a turn that died on `provider/error` without `turn/completed` leaves
 * `turn/started` newest in the journal and would refuse every retry
 * forever. The watchdog's stop-confirm (§16.5) reads `idle`/`error` as
 * "no turn". The journal is the second signal: on a stopped thread it
 * still sees a queued `client/turn/requested` the status does not show,
 * and with no readable status it keeps the old newest-event heuristic.
 */
async function executorTurnActive(
  deps: ReleaseDeps,
  threadId: string,
): Promise<boolean> {
  let stopped = false;
  try {
    const t = await deps.threads.get({ threadId });
    if (t.status && t.status !== "idle" && t.status !== "error") {
      return true;
    }
    stopped = t.status === "idle" || t.status === "error";
  } catch (e) {
    deps.log?.warn?.(
      `orchestrator: executor turn status ${threadId}: ${message(e)}`,
    );
  }
  try {
    const events = await deps.threads.events.list({
      threadId,
      order: "desc",
      limit: "20",
      types: [
        "turn/started",
        "turn/completed",
        "turn.failed",
        "turn/failed",
        "client/turn/requested",
      ],
    });
    const newest = events[0];
    // a confirmed-stopped thread: only a queued request can still start
    // a turn — a stale `turn/started` means the turn died unreported.
    // §17.3 (ревью PLUG-217): and only a FRESH one — the list is desc,
    // so a request heading it is already newer than any completed
    // turn; the 2-minute window is what lets a request that never
    // reached `turn/started` (provider dead, client gone) stop
    // refusing every release, which the gate exists to avoid.
    if (stopped) {
      if (newest?.type !== "client/turn/requested") return false;
      return (
        (deps.now?.() ?? Date.now()) - newest.createdAt <=
          STALE_TURN_REQUEST_MS
      );
    }
    return (
      newest?.type === "turn/started" ||
      newest?.type === "client/turn/requested"
    );
  } catch (e) {
    deps.log?.warn?.(
      `orchestrator: executor turn check ${threadId}: ${message(e)}`,
    );
    return false;
  }
}

/** Verdict of the review bound to `sha` under `taskKey` (§16.7). */
async function okReviewOn(
  deps: ReleaseDeps,
  policy: Policy,
  taskKey: string,
  sha: string,
): Promise<DelegationRow | undefined> {
  const review = deps.store
    .delegationsByTask(taskKey)
    .find(
      (d) =>
        levelRole(policy, d.level) === "auditor" &&
        d.status === "done" &&
        d.continue_from === sha,
    );
  if (!review) return undefined;
  const show = await runJson<TaskShow>(deps.bbCli, [
    "tasks",
    "show",
    taskKey,
    "--json",
  ]).catch(() => ({ comments: [] }) as TaskShow);
  return (await reviewVerdict(deps, show, review)) === "ok"
    ? review
    : undefined;
}

/**
 * §17.3 (Б4, по ревью PLUG-210): the review gate is part of step 1 —
 * it runs BEFORE the pipeline mutates the branch (sync merge, checks,
 * docs trailer), so a refusal costs seconds, not a full check run.
 *
 * Executor branch: the tip must equal the reviewed `result_sha` modulo
 * the pipeline's own commits (a retry after a mid-run refusal has the
 * sync merge / docs trailer of the failed run on top — recorded in
 * `releases.pipeline_shas`, not foreign work).
 *
 * `merged_into` branch: an OK review on the TIP covers everything under
 * it (coordinator commits included — documents are the coordinator's
 * per release §1). Without one, every merged delegation whose
 * `merged_sha` sits on the tip but not on a published ref needs an OK
 * review on that `merged_sha`, and no commit may remain unexplained.
 */
async function reviewGate(
  deps: ReleaseDeps,
  ctx: {
    taskKey: string;
    executor: DelegationRow;
    project: ResolvedProject;
    repo: string;
    branch: string;
    tipSha: string;
    policy: Policy;
    /** The released project — merged-delegation rows are scoped to it
     * (ревью PLUG-214 мелко). */
    projectId: string | null;
  },
): Promise<void> {
  const { taskKey, executor, project, repo, branch, tipSha, policy } = ctx;
  const pipeline = deps.store.pipelineShasForRepo(repo);
  const projectId = executor.project_id ?? ctx.projectId;

  if (executor.merge_status !== "merged") {
    const need = executor.result_sha!;
    if (!(await shaExists(deps, repo, need))) {
      throw new OrchestratorError(
        "release-refused",
        `release ${taskKey}: итог делегирования ${need.slice(0, 7)} ` +
          `отсутствует в копии ${repo}`,
      );
    }
    // «Опубликовано» — the same notRefs the merged path builds below:
    // the remote target plus every published tip recorded for this
    // copy. A sync merge now records ONLY its own merge commit in
    // pipeline_shas (ревью PLUG-216 Б1), so the origin range it pulled
    // in is excused by remote reachability instead — and a fast-forward
    // sync leaves the gate satisfied outright.
    const notRefs: string[] = [];
    const target = `origin/${project.target.branch}`;
    if (await gitRefExists(deps, repo, target)) notRefs.push(target);
    for (const sha of deps.store.publishedShasForRepo(repo)) {
      if (await shaExists(deps, repo, sha)) notRefs.push(sha);
    }
    const extra = (
      await git(deps, repo, [
        "rev-list",
        tipSha,
        "--not",
        need,
        ...notRefs,
      ])
    )
      .split("\n")
      .filter(Boolean)
      .filter((s) => !pipeline.has(s));
    if (extra.length) {
      throw new OrchestratorError(
        "unreviewed-commits",
        `release ${taskKey}: ветка ${branch} содержит коммиты сверх ` +
          `проверенного итога ${need.slice(0, 7)}: ` +
          extra.map((s) => s.slice(0, 7)).join(", "),
        "верните ветку к result_sha или раздайте ревью на новый итог",
      );
    }
    return;
  }

  // merged_into: an OK review on the tip covers everything below it —
  // and an OK review UNDER the tip counts when only the pipeline's own
  // commits separate it from the tip (ревью PLUG-214: a retry after a
  // mid-run refusal carries the failed run's sync merge on top, so the
  // reviewed tip is one first-parent step down).
  let candidate: string | null = tipSha;
  const seen = new Set<string>();
  while (candidate && !seen.has(candidate)) {
    seen.add(candidate);
    const tipReview = deps.store
      .delegationsByContinueFrom(candidate)
      .find(
        (d) =>
          levelRole(policy, d.level) === "auditor" && d.status === "done",
      );
    if (tipReview) {
      const tShow = await runJson<TaskShow>(deps.bbCli, [
        "tasks",
        "show",
        tipReview.task_key,
        "--json",
      ]).catch(() => ({ comments: [] }) as TaskShow);
      if ((await reviewVerdict(deps, tShow, tipReview)) === "ok") return;
    }
    if (!pipeline.has(candidate)) break;
    candidate = await firstParent(deps, repo, candidate);
  }

  // «Опубликовано» — reachable from the remote target or from a tip a
  // past release already pushed (`--not` refs; missing objects skipped).
  const notRefs: string[] = [];
  const target = `origin/${project.target.branch}`;
  if (await gitRefExists(deps, repo, target)) notRefs.push(target);
  for (const sha of deps.store.publishedShasForRepo(repo)) {
    if (await shaExists(deps, repo, sha)) notRefs.push(sha);
  }

  // Recorded merges that still need a review: the merge commit is on
  // the published tip AND unreachable from the published refs. A
  // recorded `merged_sha` absent from the copy is a clear refusal, not
  // a bare `rev-list` error.
  const unpublished: DelegationRow[] = [];
  for (const row of deps.store.mergedDelegationsInto(branch, projectId)) {
    if (!row.merged_sha) continue;
    if (!(await shaExists(deps, repo, row.merged_sha))) {
      throw new OrchestratorError(
        "release-refused",
        `release ${taskKey}: коммит слияния ` +
          `${row.merged_sha.slice(0, 7)} (${row.task_key}) отсутствует ` +
          `в копии ${repo}`,
        "восстановите коммит слияния или поправьте запись merge",
      );
    }
    if (!(await isAncestor(deps, repo, row.merged_sha, tipSha))) continue;
    if (notRefs.length) {
      const covered = await deps.cmd.run(
        "git",
        [
          "-C",
          repo,
          "rev-list",
          "--count",
          row.merged_sha,
          "--not",
          ...notRefs,
        ],
        { timeoutMs: 60_000 },
      );
      if (covered.exitCode === 0 && Number(covered.stdout.trim()) === 0) {
        continue; // already on a published ref
      }
    }
    unpublished.push(row);
  }

  // Every commit in the publish range must be explained: reachable from
  // neither the published refs nor an unpublished merge — and not one
  // of the pipeline's own recorded commits.
  const foreign = (
    await git(deps, repo, [
      "rev-list",
      tipSha,
      "--not",
      ...notRefs,
      ...unpublished.map((r) => r.merged_sha!),
    ])
  )
    .split("\n")
    .filter(Boolean)
    .filter((s) => !pipeline.has(s));
  if (foreign.length) {
    throw new OrchestratorError(
      "unreviewed-commits",
      `release ${taskKey}: в диапазоне ${branch} коммиты без влитого ` +
        `делегирования: ${foreign.map((s) => s.slice(0, 7)).join(", ")}`,
      `ревью всей вершины покрывает их: bb orchestrator delegate ` +
        `${taskKey} --level <уровень аудита> --from ${tipSha}`,
    );
  }

  for (const row of unpublished) {
    const label = `${row.task_key} → ${row.merged_sha!.slice(0, 7)}`;
    const hint =
      `раздайте ревью на влитый итог: bb orchestrator delegate ` +
      `${row.task_key} --level <уровень аудита> --from ${row.merged_sha}`;
    const rReview = deps.store
      .delegationsByTask(row.task_key)
      .find(
        (d) =>
          levelRole(policy, d.level) === "auditor" &&
          d.continue_from === row.merged_sha,
      );
    if (!rReview) {
      throw new OrchestratorError(
        "unreviewed-commits",
        `release ${taskKey}: нет ревью на влитый итог ${label}`,
        hint,
      );
    }
    if (rReview.status !== "done") {
      throw new OrchestratorError(
        "unreviewed-commits",
        `release ${taskKey}: ревью на ${label} в статусе ${rReview.status}`,
        hint,
      );
    }
    const rShow = await runJson<TaskShow>(deps.bbCli, [
      "tasks",
      "show",
      row.task_key,
      "--json",
    ]).catch(() => ({ comments: [] }) as TaskShow);
    const v = await reviewVerdict(deps, rShow, rReview);
    if (v !== "ok") {
      throw new OrchestratorError(
        "unreviewed-commits",
        `release ${taskKey}: вердикт ревью на ${label} ` +
          (v === "missing" ? "не найден" : "не «OK»"),
        hint,
      );
    }
  }
}

// ── Steps 2–5: sync → checks → scan → audit dispatch ──────────────────

async function runReleaseSteps(
  ctx: {
    taskKey: string;
    title: string;
    executor: DelegationRow;
    project: ResolvedProject;
    repo: string;
    branch: string;
    /** Already null-checked in `runRelease` — `policy` is present. */
    policyLoad: PolicyLoad & { policy: Policy };
    /** §6 (r7): the resolved settings project — reported in the result. */
    settingsProjectId: string;
    delegationProjectId: string;
  },
  input: ReleaseInput,
  deps: ReleaseDeps,
): Promise<ReleaseResult> {
  const { taskKey, title, executor, project, repo, branch, policyLoad } = ctx;

  // Step 1 (продолжение приёмки) — гейт ревью по публикуемым SHA до
  // действий конвейера (§17.3, ревью PLUG-210 Б1/Б4): свежие refs origin
  // нужны для сверки «опубликовано», а отказ обходится секундами, а не
  // полным прогоном sync + проверок.
  await git(deps, repo, ["fetch", "origin"], { timeoutMs: 180_000 });
  const preSyncSha = await git(deps, repo, ["rev-parse", "HEAD"]);

  // §17.3 (ревью PLUG-214): the fast-forward gate against the task's
  // previous published tip belongs to step 1 — refusing here costs
  // seconds, not a full check run and an audit. A published sha absent
  // from this copy gets its own clear refusal, not a bare is-ancestor
  // failure.
  const prevPublished = deps.store.lastPublishedSha(taskKey);
  if (prevPublished && prevPublished !== preSyncSha) {
    if (!(await shaExists(deps, repo, prevPublished))) {
      throw new OrchestratorError(
        "release-refused",
        `release ${taskKey}: прошлая опубликованная вершина ` +
          `${prevPublished.slice(0, 8)} отсутствует в копии ${repo}`,
        "новый заход продолжает от published_sha — повторите из копии, где этот коммит есть",
      );
    }
    if (!(await isAncestor(deps, repo, prevPublished, preSyncSha))) {
      throw new OrchestratorError(
        "release-refused",
        `ветка публикации не fast-forward от ${prevPublished.slice(0, 8)} ` +
          `— новый заход должен продолжать от published_sha`,
      );
    }
  }

  await reviewGate(deps, {
    taskKey,
    executor,
    project,
    repo,
    branch,
    tipSha: preSyncSha,
    policy: policyLoad.policy,
    projectId: executor.project_id ?? input.caller.projectId,
  });

  // §2 r10 п.0: target identity = the repo's MAIN worktree dir
  // (realpath of the first `git worktree list` record) + target branch —
  // different tasks share the repo via different executor copies, so
  // `repo_path` cannot be the key. The guarded insert below checks and
  // writes in one transaction.
  const mainDir =
    mainWorktreeDir(
      await git(deps, repo, ["worktree", "list", "--porcelain"], {
        allowFail: true,
      }),
    ) ?? repo;
  const repoRoot = await realpath(mainDir).catch(() => mainDir);
  // Pre-r10 rows lack repo_root — backfill so the same-target gate
  // sees them (a gone copy simply stays NULL).
  for (const r of deps.store.releasesMissingRepoRoot()) {
    try {
      const md =
        mainWorktreeDir(
          await git(deps, r.repo_path, ["worktree", "list", "--porcelain"], {
            allowFail: true,
          }),
        ) ?? r.repo_path;
      deps.store.setReleaseRepoRoot(
        r.id,
        await realpath(md).catch(() => md),
      );
    } catch {
      // copy is gone — leave NULL, the row is not a same-target match
    }
  }

  // The release row exists BEFORE the pipeline mutates the branch — its
  // `pipeline_shas` record survives a mid-run refusal, so the next run's
  // gate does not call the pipeline's own commits foreign.
  let release: ReleaseRow;
  try {
    release = deps.store.insertRelease({
      taskKey,
      projectId: executor.project_id ?? input.caller.projectId,
      coordinatorThreadId: input.caller.threadId,
      repoPath: repo,
      branch,
      targetAction: project.target.action,
      targetBranch: project.target.branch,
      noDocsReason: input.noDocs ?? null,
      kbNote: input.kb ?? null,
      noKbReason: input.noKb ?? null,
      settingsProjectId: ctx.settingsProjectId,
      repoRoot,
    });
  } catch (e) {
    if (e instanceof OrchestratorError) throw e;
    if (/UNIQUE constraint/.test(message(e))) {
      throw new OrchestratorError(
        "release-in-progress",
        `по задаче ${taskKey} уже идёт выкладка`,
      );
    }
    throw e;
  }

  try {
    // Step 2 — sync по режиму проекта.
    // §16.6 (PLUG-194): a §14-merged result is synced by MERGE only —
    // `git rebase` flattens merge commits, silently dropping the
    // conflict-resolution edits that exist only in them.
    const { baseSha, remoteBaseSha, postSyncSha, pipelineShas } =
      await syncBranch(
        deps,
        repo,
        branch,
        executor.merge_status === "merged"
          ? { ...project, sync: "merge" }
          : project,
        { taskKey, expectedSha: preSyncSha },
      );
    deps.store.addReleasePipelineShas(release.id, pipelineShas);
    // §17.3 (ревью PLUG-214): the tip the gate vetted — the checks
    // window (up to CHECK_TIMEOUT_MS) is long enough for a revived
    // executor to land a commit on the branch; only this sha may stand
    // when the checks finish.

    // Step 3 — проверки проекта.
    await runProjectChecks(deps, repo, project.checks, project.timing.checksMinutes);

    const afterChecksSha = await git(deps, repo, ["rev-parse", "HEAD"]);
    if (afterChecksSha !== postSyncSha) {
      const extra = (
        await git(deps, repo, [
          "rev-list",
          `${postSyncSha}..${afterChecksSha}`,
        ])
      )
        .split("\n")
        .filter(Boolean);
      throw new OrchestratorError(
        "unreviewed-commits",
        `release ${taskKey}: во время проверок на ветку ${branch} легли ` +
          `коммиты сверх проверенной вершины: ` +
          extra.map((s) => s.slice(0, 7)).join(", "),
        "ревью покрывает вершину после sync — повторите release, когда исполнитель остановлен",
      );
    }

    // §3 --no-docs → Docs-not-needed trailer (before sha capture).
    // §17.3 (ревью PLUG-216 Б1): the window between the checks check
    // and the trailer is guarded the same way — the tip must still be
    // the post-sync one.
    const preTrailerSha = await git(deps, repo, ["rev-parse", "HEAD"]);
    if (preTrailerSha !== postSyncSha) {
      const extra = (
        await git(deps, repo, [
          "rev-list",
          `${postSyncSha}..${preTrailerSha}`,
        ])
      )
        .split("\n")
        .filter(Boolean);
      throw new OrchestratorError(
        "unreviewed-commits",
        `release ${taskKey}: после проверок на ветку ${branch} легли ` +
          `коммиты сверх проверенной вершины: ` +
          extra.map((x) => x.slice(0, 7)).join(", "),
        "повторите release, когда исполнитель остановлен",
      );
    }
    let trailerTip: string | null = null;
    if (input.noDocs) {
      await applyDocsTrailer(deps, repo, input.noDocs);
      // Only the pipeline's own trailer commit lands in pipeline_shas:
      // an amend and an empty trailer commit both carry the SAME tree
      // as preTrailerSha — a tip with a real diff, or more than one new
      // commit, is foreign work.
      trailerTip = await git(deps, repo, ["rev-parse", "HEAD"]);
      if (trailerTip !== preTrailerSha) {
        const sameTree =
          (await git(deps, repo, ["diff", preTrailerSha, trailerTip])) ===
          "";
        const count = Number(
          await git(deps, repo, [
            "rev-list",
            "--count",
            `${preTrailerSha}..${trailerTip}`,
          ]),
        );
        if (!sameTree || count !== 1) {
          throw new OrchestratorError(
            "unreviewed-commits",
            `release ${taskKey}: во время записи трейлера на ветку ` +
              `${branch} легли чужие коммиты (вершина ` +
              `${trailerTip.slice(0, 7)})`,
            "повторите release, когда исполнитель остановлен",
          );
        }
        deps.store.addReleasePipelineShas(release.id, [trailerTip]);
      }
    }
    // §17.3 (ревью PLUG-217 Б1): the audited/published tip is the one
    // already verified — a fresh rev-parse here would let a commit
    // slipped into the gap go to the auditor unreviewed.
    const headSha =
      trailerTip !== null && trailerTip !== preTrailerSha
        ? trailerTip
        : preTrailerSha;
    deps.store.updateRelease(release.id, { headSha, remoteBaseSha });

    // Step 4 — машинный скан категорий 1–4.
    // §16.6 (PLUG-189): --no-color/--no-ext-diff — a `color.ui=always`
    // config or an external diff driver would silently break the parser.
    const commits = await commitRange(deps, repo, baseSha, headSha);
    const added = parseAddedLines(
      await git(deps, repo, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--unified=0",
        baseSha,
        headSha,
      ]),
    );
    // §16.6: scan the patch of EVERY commit in the range — a leak added
    // and removed inside it escapes the range diff. `--cc` gives merge
    // commits their conflict-resolution patch.
    const patches = parseAddedLines(
      await git(deps, repo, [
        "log",
        "-p",
        "--cc",
        "--no-color",
        "--no-ext-diff",
        "--unified=0",
        `${baseSha}..${headSha}`,
      ]),
    );
    const allowed = await allowedAuthor(deps, repo, project.commitIdentity);
    const findings = await machineScan(deps.cmd, {
      repoPath: repo,
      baseSha,
      headSha,
      commits,
      added,
      patches,
      leaks: project.leaks,
      allowedAuthor: allowed,
      hostname: deps.hostname ?? osHostname(),
      threadIds: project.threadIds,
      allowedTrailers: project.allowedTrailers,
      allowedEmails: project.allowedEmails,
    });
    const blockers = findings.filter((f) => f.severity === "block");
    const warnings = findings.filter((f) => f.severity === "warn");
    if (blockers.length) {
      throw new OrchestratorError(
        "release-refused",
        `release ${taskKey}: машинный скан нашёл ${blockers.length} блокирующих находок:\n` +
          blockers.slice(0, 20).map((f) => `- ${formatFinding(f)}`).join("\n"),
      );
    }

    const packetPath = await writeAuditPacket(deps, {
      release,
      taskTitle: title,
      commits,
      changed: await git(deps, repo, [
        "diff",
        "--name-only",
        baseSha,
        headSha,
      ]).then((t) => t.split("\n").filter(Boolean)),
      diff: await git(deps, repo, ["diff", baseSha, headSha]),
      docs: docsForChanges(
        (
          await git(deps, repo, ["diff", "--name-only", baseSha, headSha])
        )
          .split("\n")
          .filter(Boolean),
        project.docsMap,
      ),
      findings,
      noDocs: input.noDocs,
      kb: input.kb,
      noKb: input.noKb,
      baseSha,
      headSha,
    });

    const route = pickRoute(policyLoad.policy, AUDIT_LEVEL, {
      unavailableRoutes: new Set(policyLoad.unavailableRoutes),
      heldGroups: deps.store.heldGroups(deps.now?.() ?? Date.now()),
    });
    const auditInstructions =
      `Выкладка задачи ${taskKey}: аудит релиза (шаг 5 конвейера). ` +
      `Вход аудита — файл ${packetPath}, прочитай его целиком. ` +
      // §16.6: the auditor checks the exact commit — after the run the
      // coordinator's copy is restored to its original branch, so a
      // branch name could point at the wrong tree.
      `Репозиторий для проверки: ${repo} (коммит ${headSha} — проверяй его, ` +
      `ветка копии после выкладки может отличаться). ` +
      `Итог — ОДНО сообщение строгим JSON {"verdict":"APPROVE"|"REJECT","findings":[…]} без пояснений; ` +
      `находки — без значений секретов (маскируй).`;
    // §17.3 (С1): only the audit dispatch is serialized on the delegate
    // queue — release itself runs outside it (the `bb orchestrator
    // release` CLI does not enqueue), so a release invoked while a
    // dispatch is in flight never deadlocks on its own queue. The audit
    // row INSERT rides inside too (ревью PLUG-210 мелко 9): else a long
    // queue leaves a `dispatching` row the watchdog's 5-minute sweep
    // could claim before it was ever dispatched.
    const { auditRow, res } = await deps.enqueue(async () => {
      const auditRow = deps.store.insert({
        taskKey,
        projectId: executor.project_id ?? input.caller.projectId,
        coordinatorThreadId: input.caller.threadId,
        level: AUDIT_LEVEL,
        route: route.name,
        preset: route.route.preset,
        provider: route.route.provider,
      });
      const res = await dispatchToRoute(
        auditRow,
        {
          instructions: auditInstructions,
          // §17.2 (PLUG-211 С4): a caller-initiated dispatch owns the
          // refusal comment.
          commentOnRefusal: true,
        },
        deps.stepsDeps,
      );
      return { auditRow, res };
    });
    deps.store.updateRelease(release.id, {
      auditDelegationId: auditRow.id,
    });
    release = deps.store.getRelease(release.id) ?? release;
    return {
      ok: true,
      releaseId: release.id,
      taskKey,
      status: "auditing",
      auditThreadId: res.threadId,
      warnings,
      settingsProjectId: ctx.settingsProjectId,
      delegationProjectId: ctx.delegationProjectId,
    };
  } catch (e) {
    // Any post-insert failure — sync conflict, a check, the scan, a
    // dispatch refusal — ends the release; the row still carries the
    // recorded `pipeline_shas` for the next run's gate.
    deps.store.updateRelease(release.id, {
      status: "failed",
      error: message(e).slice(0, 400),
    });
    throw e;
  }
}

// ── Audit packet (§3 input) ────────────────────────────────────────────

async function writeAuditPacket(
  deps: ReleaseDeps,
  input: {
    release: ReleaseRow;
    taskTitle: string;
    commits: CommitMeta[];
    changed: string[];
    diff: string;
    docs: string[] | null;
    findings: ScanFinding[];
    noDocs?: string;
    kb?: string;
    noKb?: string;
    baseSha: string;
    headSha: string;
  },
): Promise<string> {
  const dir = deps.packetDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `release-${input.release.id}-audit.md`);
  const r = input.release;
  const truncated =
    input.diff.length > PACKET_DIFF_CAP
      ? input.diff.slice(0, PACKET_DIFF_CAP) +
        `\n\n[… diff truncated at ${PACKET_DIFF_CAP} chars …]`
      : input.diff;
  const body = [
    `# Аудит выкладки ${r.task_key}`,
    "",
    `- Задача: ${r.task_key} — ${input.taskTitle}`,
    `- Репозиторий (рабочая копия с итогом задачи): ${r.repo_path}`,
    `- Ветка: ${r.branch} → ${r.target_action} в ${r.target_branch}`,
    `- Диапазон: ${input.baseSha}..${input.headSha}`,
    input.noDocs ? `- --no-docs: ${input.noDocs}` : null,
    input.kb ? `- --kb: ${input.kb}` : null,
    input.noKb ? `- --no-kb: ${input.noKb}` : null,
    "",
    "## Коммиты",
    "",
    ...input.commits.map(
      (c) =>
        `- ${c.sha} author=${c.authorName} <${c.authorEmail}> ` +
        `committer=${c.committerName} <${c.committerEmail}>\n` +
        c.body
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
    ),
    "",
    "## Связанные документы для проверки актуальности",
    "",
    input.docs === null
      ? "- карты нет: проверяй все документы репозитория (docs/, README*, ADR)"
      : input.docs.length
        ? input.docs.map((d) => `- ${d}`).join("\n")
        : "- затронутых документов по карте нет",
    "",
    "## Находки машинного скана (шаг 4)",
    "",
    input.findings.length
      ? input.findings.map((f) => `- ${formatFinding(f)}`).join("\n")
      : "- нет",
    "",
    "## Дифф выкладки",
    "",
    "```diff",
    truncated,
    "```",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  appendFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  return path;
}

// ── pump: verdict → publish → post-check (steps 5–7, фон) ─────────────

export interface PumpSummary {
  scanning: number;
  published: number;
  rejected: number;
  failed: number;
}

/** §2 r10 п.4: the audit gets 30 minutes from the FIRST audit dispatch
 * of this release — reissues are inside the budget, not an extension. */

/** §2 r10 п.3: how often a tracked PR is polled (`gh pr view`). */
/** §2 r10 п.3: 72 h — closed-wait window and the stale mark. */

/** The deps subset a release-notice delivery needs — pumpReleases and
 * the r31 watchdog share it. */
export interface ReleaseNoticeDeps {
  store: DelegationStore;
  threads: {
    send(args: {
      threadId: string;
      mode: "queue-if-active";
      input: unknown[];
    }): Promise<unknown>;
  };
  bbCli: BbCli;
  log?: { warn?(m: string): void };
}

/** §2 r10 п.5: the outcome line is SAVED first (`notice_text`) and only
 * then sent — a tick retry resends the stored text, never reruns the
 * work that produced it. The send itself runs under a claim captured
 * before `threads.send` and confirmed after — a stale claim (2 min,
 * the claimResultDelivery protocol) is retaken by the next tick. A
 * gone coordinator thread is not an eternal retry: the text lands as
 * a task comment and the notice is confirmed (spec п.5). */
/** §2 r10 п.5 (ревью PLUG-244 заход 4, Н5): «тред не найден» — только
 * по коду ошибки SDK (`experimental_PluginRpcCallError.code ===
 * "not_found"`), не по тексту сообщения: ENOTFOUND/DNS и чужой 404 —
 * временный сбой с обычным повтором, а не комментарий в задачу. */
function isThreadGoneError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "not_found"
  );
}

export async function deliverReleaseNotice(
  deps: ReleaseNoticeDeps,
  row: ReleaseRow,
): Promise<boolean> {
  if (!deps.store.claimReleaseNotify(row.id)) return false;
  const text = deps.store.getRelease(row.id)?.notice_text;
  if (text == null) {
    deps.store.releaseReleaseNotify(row.id);
    return false;
  }
  try {
    await deps.threads.send({
      threadId: row.coordinator_thread_id,
      mode: "queue-if-active",
      input: [
        { type: "text", text: `[orchestrator] ${text}`, mentions: [] },
      ],
    });
  } catch (e) {
    if (isThreadGoneError(e)) {
      await commentOnTask(deps, row.task_key, text);
      deps.store.confirmReleaseNotify(row.id, text);
      return true;
    }
    deps.store.releaseReleaseNotify(row.id);
    deps.log?.warn?.(`orchestrator: release notify: ${message(e)}`);
    return false;
  }
  await commentOnTask(deps, row.task_key, text);
  deps.store.confirmReleaseNotify(row.id, text);
  return true;
}

/**
 * Driven from the watchdog beats: for every `auditing` release, look at
 * the latest `release-audit` delegation — `done` means the verdict is in
 * the thread journal; a terminal non-done status with no newer active
 * delegation means the chain is exhausted (§3).
 */
export async function pumpReleases(deps: ReleaseDeps): Promise<PumpSummary> {
  const s: PumpSummary = { scanning: 0, published: 0, rejected: 0, failed: 0 };
  // §2 r10 п.5: rows with a saved but undelivered outcome line — the
  // досмотр resends ONLY the stored text (no post-check, no postPublish,
  // no automation create — a send failure must not rerun the work every
  // 5 s, ревью PLUG-244 заход 2 Б1). A published row WITHOUT a saved
  // line crashed before it was assembled — the work reruns here.
  for (const row of deps.store.pendingReleaseNotices()) {
    try {
      const fresh = deps.store.getRelease(row.id) ?? row;
      if (fresh.notice_kind === "self-reload" && fresh.notice_text != null) {
        // ревью PLUG-244 заход 4 (Н2): крах между сохранением строки и
        // `automation create` — автоматизации может не быть. create
        // повторно не выполняем (спека п.5): сохранённая строка уходит
        // обычной отправкой с пометкой «автоматизация не подтверждена».
        deps.store.setReleaseNotice(
          fresh.id,
          "published",
          `${fresh.notice_text}\nперезагрузи orchestrator вручную: ` +
            `автоматизация не подтверждена`,
        );
      }
      if (fresh.notice_text != null) {
        await deliverReleaseNotice(
          deps,
          deps.store.getRelease(row.id) ?? fresh,
        );
      } else if (fresh.status === "published") {
        await finishPublished(deps, fresh, null);
      }
    } catch (e) {
      deps.log?.warn?.(
        `orchestrator release: досмотр ${row.task_key}: ${message(e)}`,
      );
    }
  }
  for (const row of deps.store.releasesByStatuses(["auditing", "publishing"])) {
    s.scanning++;
    try {
      if (row.status === "auditing") {
        // §17.3 (ревью PLUG-210): the release row is inserted BEFORE the
        // audit dispatch — a fresh row without `audit_delegation_id` is
        // mid-pipeline, not a verdict (an older audit delegation's
        // verdict must never be read for it). A row still without the
        // audit after the pipeline's own timeout means the run died —
        // mark it failed so a retry is not blocked forever.
        if (!row.audit_delegation_id) {
          const age = (deps.now?.() ?? Date.now()) - row.created_at;
          if (age > (await releaseTiming(deps, row)).prepareMinutes * 60_000) {
            if (
              deps.store.transitionReleaseStatus(
                row.id,
                ["auditing"],
                "failed",
                "выкладка остановилась до раздачи аудита",
                {
                  kind: "failed",
                  text:
                    `выкладка ${row.task_key} остановлена до раздачи ` +
                    `аудита — повторите release`,
                },
              )
            ) {
              s.failed++;
              await deliverReleaseNotice(deps, row);
            }
          }
          continue;
        }
        const delegation = deps.store.latestDelegationByTaskAndLevel(
          row.task_key,
          AUDIT_LEVEL,
        );
        if (!delegation || delegation.status === "dispatching" || delegation.status === "running") {
          // §2 r10 п.4: 30 min from the FIRST audit dispatch — the root
          // of the reissue chain (audit_delegation_id names it), not the
          // latest row.
          const root =
            (row.audit_delegation_id
              ? deps.store.get(row.audit_delegation_id)
              : null) ??
            delegation ??
            row;
          const auditT = await releaseTiming(deps, row);
          if (
            (deps.now?.() ?? Date.now()) - root.created_at >
            auditT.auditTimeoutMinutes * 60_000
          ) {
            if (
              deps.store.transitionReleaseStatus(
                row.id,
                ["auditing"],
                "failed",
                `аудит не завершился за ${auditT.auditTimeoutMinutes} мин`,
                {
                  kind: "failed",
                  text:
                    `выкладка ${row.task_key} остановлена: аудит не ` +
                    `завершился за ${auditT.auditTimeoutMinutes} мин — ` +
                    `повторите release`,
                },
              )
            ) {
              s.failed++;
              if (delegation?.thread_id) {
                await deps.stepsDeps.threads
                  .stop({ threadId: delegation.thread_id })
                  .catch((e) =>
                    deps.log?.warn?.(
                      `orchestrator release: auditor stop: ${message(e)}`,
                    ),
                  );
              }
              await deliverReleaseNotice(deps, row);
            }
          }
          continue;
        }
        if (delegation.status !== "done") {
          if (
            deps.store.transitionReleaseStatus(
              row.id,
              ["auditing"],
              "failed",
              `аудит завершился исходом ${delegation.status}`,
              {
                kind: "failed",
                text:
                  `выкладка ${row.task_key} остановлена: проверяющий ` +
                  `агент завершился исходом ${delegation.status} — ` +
                  (delegation.status === "cancelled"
                    ? "аудит отменён, выкладки нет"
                    : `цепочка ${AUDIT_LEVEL} исчерпана, выкладки нет`),
              },
            )
          ) {
            s.failed++;
            await deliverReleaseNotice(deps, row);
          }
          continue;
        }
        const text = delegation.thread_id
          ? await lastAgentMessage(deps, delegation.thread_id)
          : null;
        const verdict = parseAuditVerdict(text ?? "");
        if (verdict.verdict === "REJECT") {
          const list = verdict.findings
            .slice(0, 15)
            .map(
              (f) =>
                `- ${maskSecrets(f.file ?? "?")}${f.line != null ? `:${f.line}` : ""} ` +
                `${maskSecrets(f.category ?? "")}: ${maskSecrets(f.problem ?? "")}` +
                (f.fix ? ` → ${maskSecrets(f.fix)}` : ""),
            )
            .join("\n");
          if (
            deps.store.transitionReleaseStatus(
              row.id,
              ["auditing"],
              "rejected",
              verdict.unparseable ? "ответ аудитора не парсится" : "REJECT",
              {
                kind: "rejected",
                text:
                  `аудит выкладки ${row.task_key}: REJECT` +
                  (verdict.unparseable ? " (ответ не парсится)" : "") +
                  `\n${list || "- без находок в ответе"}`,
              },
            )
          ) {
            s.rejected++;
            await deliverReleaseNotice(deps, row);
          }
          continue;
        }
        deps.store.updateRelease(row.id, { status: "publishing" });
      }
      // publishing (fresh or a retry after a crash mid-publish).
      await publishRelease(deps, deps.store.getRelease(row.id) ?? row, s);
    } catch (e) {
      const cur = deps.store.getRelease(row.id) ?? row;
      // Уже конечная запись (успела опубликоваться или её отклонил
      // сторож) — строка принадлежит тому, кто перевёл статус.
      if (
        deps.store.transitionReleaseStatus(
          cur.id,
          ["auditing", "publishing"],
          "failed",
          message(e).slice(0, 400),
          {
            kind: "failed",
            text: `выкладка ${row.task_key} упала на публикации: ${message(e)}`,
          },
        )
      ) {
        s.failed++;
        await deliverReleaseNotice(deps, cur);
      }
    }
  }
  await prWatch(deps);
  // §2 п.6 (r11): влитый PR — postPublish `on: merged` до строки «влит»;
  // журнальные команды в полёте — такт уходит, досмотр следующим.
  for (const row of deps.store.releasesByPrState("merging")) {
    try {
      const fresh = deps.store.getRelease(row.id) ?? row;
      const ppMarker = POSTPUBLISH_META(fresh.id);
      let ppMeta: PostPublishMeta = {};
      try {
        ppMeta = JSON.parse(
          deps.store.metaGet(ppMarker) ?? "{}",
        ) as PostPublishMeta;
      } catch {
        ppMeta = {};
      }
      if (fresh.notice_text != null || ppMeta.finish != null) {
        // Итог уже собран: строка в пути у досмотра либо доставлена и
        // стёрта confirm'ом — метка finish переживает оба состояния.
        // Добиваем только застрявший pr_state (рестарт между
        // сохранением строки и переходом): postPublish и дубль строки
        // не пересобираем.
        deps.store.transitionPrState(fresh.id, ["merging"], "merged");
        deps.store.metaDelete(ppMarker);
        continue;
      }
      const pp = await runPostPublishGuarded(deps, fresh, "pr.merged");
      if (!pp.done) continue;
      // Замок копии не переживает итог postPublish — в том числе при
      // раннем done внутри runPostPublish (идемпотентно).
      releasePostPublishLock(fresh.id);
      const sha7 = (fresh.pr_merge_sha ?? "").slice(0, 7);
      const parts = [
        `PR влит ${fresh.task_key}: ${fresh.pr_url}` +
          (sha7 ? ` → ${sha7}` : ""),
      ];
      if (pp.summary) parts.push(pp.summary);
      const line = parts.join("\n");
      // Метка «итог собран» — до перехода в merged: досмотр доставит
      // строку и сотрёт notice_text confirm'ом; без метки следующий
      // такт пересобрал бы итог и слал дубль.
      const finishMeta = JSON.stringify({ ...ppMeta, finish: line });
      if (pp.selfReload) {
        deps.store.setReleaseNoticeWithMeta(
          fresh.id,
          "self-reload",
          line,
          ppMarker,
          finishMeta,
        );
        deps.store.transitionPrState(fresh.id, ["merging"], "merged");
        if (!deps.store.claimReleaseNotify(fresh.id)) {
          deps.store.metaDelete(ppMarker);
          continue;
        }
        const createErr = await createSelfReloadAutomation(
          deps,
          fresh,
          line,
          pp.selfReload,
        );
        if (createErr == null) {
          deps.commandRunner?.holdForSelfReload();
          await commentOnTask(deps, fresh.task_key, line);
          deps.store.confirmReleaseNotify(fresh.id, line);
          deps.store.metaDelete(ppMarker);
          continue;
        }
        deps.store.releaseReleaseNotify(fresh.id);
        deps.store.setReleaseNotice(
          fresh.id,
          "pr",
          `${line}\nперезагрузи orchestrator вручную: ${createErr}`,
        );
      } else {
        // §2 п.6: строка собрана и сохранена — затем запись уходит в
        // merged (рестарт между ними досматривается без повтора).
        deps.store.setReleaseNoticeWithMeta(
          fresh.id,
          "pr",
          line,
          ppMarker,
          finishMeta,
        );
        deps.store.transitionPrState(fresh.id, ["merging"], "merged");
      }
      deps.store.metaDelete(ppMarker);
      await deliverReleaseNotice(deps, fresh);
    } catch (e) {
      deps.log?.warn?.(
        `orchestrator release: PR merged ${row.task_key}: ${message(e)}`,
      );
    }
  }
  // §18.2: чистка журнала и запуск очереди — каждый такт.
  const retentionDays = deps.commandRetentionDays?.() ?? 30;
  deps.store.pruneCommandRuns(
    (deps.now?.() ?? Date.now()) - retentionDays * 86_400_000,
  );
  await deps.commandRunner?.pump();
  return s;
}

/**
 * §2 r10 п.3: track every published row's PR to a terminal outcome —
 * one tracking record per pr_url (the newest; older rows go
 * `superseded`). `gh pr view` every 5 min; MERGED → «PR влит» + task
 * done; CLOSED → «PR закрыт без влития» + 72 h more for a reopen-merge;
 * 72 h open → one «PR висит 72 ч» line; 3 gh failures in a row → one
 * «слежение невозможно». Every line is claimed by the conditional
 * pr_state transition, not by notified_at.
 */
async function prWatch(deps: ReleaseDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  for (const row of deps.store.trackedPrReleases()) {
    const prUrl = row.pr_url;
    if (!prUrl) continue;
    try {
      const newest = deps.store.latestReleaseByPrUrl(prUrl);
      if (newest && newest.id !== row.id) {
        deps.store.transitionPrState(row.id, ["open", "closed"], "superseded");
        continue;
      }
      // ревью PLUG-244 заход 4 (Н1): у записи недоставленная строка —
      // PR-переход откладывается, иначе setReleaseNotice затёр бы её
      // до доставки; досмотр донесёт текст, переход сделает следующий
      // такт.
      if (row.notice_text != null) continue;
      const t = await releaseTiming(deps, row);
      if (
        row.pr_checked_at &&
        now - row.pr_checked_at < t.prPollMinutes * 60_000
      ) {
        continue;
      }
      const res = await deps.cmd.run(
        "gh",
        ["pr", "view", prUrl, "--json", "state,mergedAt,mergeCommit"],
        { timeoutMs: t.prCommandTimeoutSec * 1000 },
      );
      if (res.exitCode !== 0) {
        deps.store.recordPrCheck(row.id, true, now);
        const fresh = deps.store.getRelease(row.id);
        if ((fresh?.pr_error_count ?? 0) >= t.prErrorLimit) {
          if (
            deps.store.transitionPrState(row.id, ["open", "closed"], "error")
          ) {
            deps.store.setReleaseNotice(
              row.id,
              "pr",
              `слежение за PR ${row.task_key} невозможно: gh pr view ` +
                `${prUrl}: ` +
                `${maskCommandOutput(res.stderr || res.stdout).slice(0, 200)}`,
            );
            await deliverReleaseNotice(deps, row);
          }
        }
        continue;
      }
      let view: {
        state?: string;
        mergedAt?: string | null;
        mergeCommit?: { oid?: string } | null;
      };
      try {
        view = JSON.parse(res.stdout) as typeof view;
      } catch {
        deps.store.recordPrCheck(row.id, true, now);
        continue;
      }
      deps.store.recordPrCheck(row.id, false, now);
      const state = (view.state ?? "").toUpperCase();
      if (state === "MERGED") {
        // §2 п.6 (r11): «merging» — postPublish `on: merged` идёт до
        // строки «PR влит … → sha7»; без настроенного postPublish насос
        // переводит в «merged» и собирает строку тем же тактом.
        if (
          deps.store.transitionPrState(row.id, ["open", "closed"], "merging")
        ) {
          deps.store.setPrMergeSha(row.id, view.mergeCommit?.oid ?? null);
          await runChecked(deps.bbCli, [
            "tasks", "update", row.task_key, "--status", "done",
          ]).catch((e) =>
            deps.log?.warn?.(`release task status: ${message(e)}`),
          );
        }
        continue;
      }
      if (row.pr_state === "closed") {
        if (state === "OPEN") {
          deps.store.transitionPrState(row.id, ["closed"], "open", {
            prClosedAt: null,
          });
          continue;
        }
        if (
          row.pr_closed_at &&
          now - row.pr_closed_at >= t.prReopenWatchHours * 3_600_000
        ) {
          deps.store.transitionPrState(row.id, ["closed"], "closed_final");
        }
        continue;
      }
      // pr_state === 'open'
      if (state === "CLOSED") {
        if (
          deps.store.transitionPrState(row.id, ["open"], "closed", {
            prClosedAt: now,
          })
        ) {
          deps.store.setReleaseNotice(
            row.id,
            "pr",
            `PR закрыт без влития ${row.task_key}: ${prUrl}`,
          );
          await deliverReleaseNotice(deps, row);
        }
        continue;
      }
      // still open — 72 h from the PR's publish (updated_at is frozen
      // for tracked rows: pr-watch writes do not bump it). «Дальше
      // молча» — флаг, не состояние: опрос до MERGED/CLOSED идёт дальше
      // (ревью PLUG-244 заход 1, Б5).
      if (
        !row.pr_stale_notified &&
        now - row.updated_at >= t.prStaleHours * 3_600_000
      ) {
        if (deps.store.markPrStaleNotified(row.id)) {
          deps.store.setReleaseNotice(
            row.id,
            "pr",
            `PR висит ${t.prStaleHours} ч ${row.task_key}: ${prUrl}`,
          );
          await deliverReleaseNotice(deps, row);
        }
      }
    } catch (e) {
      deps.log?.warn?.(
        `orchestrator release: PR watch ${row.task_key}: ${message(e)}`,
      );
    }
  }
}

// ── Step 6: публикация ─────────────────────────────────────────────────

interface GhPr {
  number?: number;
  url?: string;
  body?: string;
  headRefName?: string;
  baseRefName?: string;
}

const SOURCE_RE = /Источник:\s*bb тред\s+(thr_[a-z0-9]+)/i;

async function ghJson<T>(
  deps: ReleaseDeps,
  repo: string,
  args: string[],
): Promise<T> {
  const res = await deps.cmd.run("gh", args, { cwd: repo, timeoutMs: 60_000 });
  if (res.exitCode !== 0) {
    throw new OrchestratorError(
      "gh-failed",
      `gh ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 300)}`,
    );
  }
  return JSON.parse(res.stdout) as T;
}

/** §17.3 (Б1): `gh pr create` prints the PR URL as plain text on
 * stdout — it is NOT JSON. Read the first URL-looking token. */
async function ghText(
  deps: ReleaseDeps,
  repo: string,
  args: string[],
): Promise<string> {
  const res = await deps.cmd.run("gh", args, { cwd: repo, timeoutMs: 60_000 });
  if (res.exitCode !== 0) {
    throw new OrchestratorError(
      "gh-failed",
      `gh ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 300)}`,
    );
  }
  return res.stdout;
}

const GH_PR_URL_RE = /https?:\/\/\S+/;

/**
 * §5: write the one-time token for `branch`+`sha`, run `git push` (the
 * shared pre-push hook validates branch+sha+expiry and consumes the
 * file), then clean up whatever the hook did not consume (push refused
 * by the remote, or no hook installed).
 */
async function pushWithToken(
  deps: ReleaseDeps,
  repo: string,
  sha: string,
  branch: string,
  refspec: string,
): Promise<void> {
  const file = writePushToken(deps.hooksDir(), sha, branch, deps.now?.());
  try {
    await git(deps, repo, ["push", "origin", refspec], {
      timeoutMs: 300_000,
    });
  } finally {
    clearPushToken(file);
  }
}

/** The project's `threadIds` at publish time (§16.6; default `true` —
 * a broken config at pump time must not silently drop the contract
 * line CI/CD relies on). §6 (r7): the settings project is resolved by
 * the released repository, `row.project_id` is only the fallback. */
async function projectThreadIds(
  deps: ReleaseDeps,
  row: ReleaseRow,
): Promise<boolean> {
  const cfg = deps.loadReleaseConfig();
  if (!cfg.config) return true;
  // §6 (r8) п.6: the recorded settings project wins; pre-r8 rows
  // resolve anew (a resolver error refuses the publish).
  const id =
    row.settings_project_id ??
    (await settingsProjectId(
      deps,
      row.repo_path,
      row.project_id,
      cfg.config,
    ));
  return resolveProject(cfg.config, id).threadIds;
}

async function publishRelease(
  deps: ReleaseDeps,
  row: ReleaseRow,
  s: PumpSummary,
): Promise<void> {
  const repo = row.repo_path;
  const headSha = row.head_sha ?? (await git(deps, repo, ["rev-parse", "HEAD"]));

  if (row.target_action === "push") {
    if (!row.remote_base_sha) {
      deps.store.updateRelease(row.id, {
        remoteBaseSha: (await gitRefExists(
          deps,
          repo,
          `origin/${row.target_branch}`,
        ))
          ? await git(deps, repo, ["rev-parse", `origin/${row.target_branch}`])
          : ZERO_SHA,
      });
    }
    await pushWithToken(
      deps,
      repo,
      headSha,
      row.target_branch,
      `${headSha}:refs/heads/${row.target_branch}`,
    );
    deps.store.updateRelease(row.id, { publishedSha: headSha });
    await runChecked(deps.bbCli, [
      "tasks",
      "update",
      row.task_key,
      "--status",
      "done",
    ]).catch((e) => deps.log?.warn?.(`release task status: ${message(e)}`));
    deps.store.updateRelease(row.id, { status: "published" });
    s.published++;
    // §2 r10 п.1: ONE outcome line — post-check findings and the
    // postPublish result are folded into it (finishPublished).
    await finishPublished(deps, deps.store.getRelease(row.id) ?? row, null);
    return;
  }

  // action=pr — §16.6 `threadIds`: the «Источник: bb тред thr_…» line is
  // written only while the project allows thread ids. With it off the
  // local executor branch name (`bb/<key>-…-thr_…`) must not reach the
  // remote either — the published branch is a neutral `release/<sha7>`
  // recorded at the FIRST release of the task and reused by repeats
  // (one branch and one PR per task, §16.6), and the PR body carries
  // neither «Источник» nor «Задача: <KEY>».
  const threadIds = await projectThreadIds(deps, row);
  // §16.6 (PLUG-194): a publish-branch name is written and reused only
  // in the `release/…` form — an executor branch name recorded while
  // threadIds was on must not be published after it flips off.
  const isPublishName = (b: string | null | undefined): b is string =>
    typeof b === "string" && b.startsWith("release/");
  // §17.3 (С4): a repeat release continues the SAME publication branch —
  // the name recorded at the first release wins over the branch the new
  // round happens to sit on, so the same PR is updated. A recorded
  // executor-branch name is reused only while `threadIds` is on (a flip
  // to off must not publish a `thr_…` name — PLUG-194).
  const recorded = row.publish_branch ?? deps.store.lastPublishBranch(row.task_key);
  const remoteBranch = threadIds
    ? (recorded ?? row.branch)
    : ([recorded].find(isPublishName) ?? `release/${headSha.slice(0, 7)}`);
  // §17.3 (С4): the reused branch fast-forwards from `published_sha` —
  // the new round continued from it (delegate continue point), so a
  // non-ancestor published tip means somebody rewrote the branch. The
  // baseline is the task's PREVIOUS published release — this row's
  // `published_sha` is still empty on a fresh run (ревью PLUG-210 мелко).
  const prevPublished =
    row.published_sha ?? deps.store.lastPublishedSha(row.task_key);
  if (prevPublished && prevPublished !== headSha) {
    const ff = await git(deps, repo, [
      "merge-base",
      "--is-ancestor",
      prevPublished,
      headSha,
    ])
      .then(() => true)
      .catch(() => false);
    if (!ff) {
      throw new OrchestratorError(
        "release-refused",
        `ветка публикации не fast-forward от ${prevPublished.slice(0, 8)} ` +
          `— новый заход должен продолжать от published_sha`,
      );
    }
  }
  const prs = await ghJson<GhPr[]>(deps, repo, [
    "pr",
    "list",
    "--head",
    remoteBranch,
    "--state",
    "open",
    "--json",
    "number,url,body,headRefName,baseRefName",
    "--limit",
    "20",
  ]);
  const existing = prs.find(
    (p) =>
      p.headRefName === remoteBranch && p.baseRefName === row.target_branch,
  );
  if (existing) {
    const src = SOURCE_RE.exec(existing.body ?? "")?.[1];
    const foreign =
      src !== undefined
        ? src !== row.coordinator_thread_id
        : threadIds
          ? true // our PRs always carry «Источник» — none means foreign
          : !existing.url ||
            !deps.store.prWasReleased(
              existing.url,
              row.coordinator_thread_id,
            );
    if (foreign) {
      throw new OrchestratorError(
        "release-refused",
        `PR ${existing.url} у ветки ${remoteBranch} создан не этим release ` +
          `(Источник: ${src ?? "нет"}) — release в чужую ветку PR не пишет`,
      );
    }
  }
  await pushWithToken(
    deps,
    repo,
    headSha,
    remoteBranch,
    `${headSha}:refs/heads/${remoteBranch}`,
  );
  deps.store.updateRelease(row.id, {
    publishedSha: headSha,
    // §17.3 (С4): the publication branch name is always recorded — the
    // repeat release reuses it (an executor-branch name only while
    // `threadIds` stays on, see the reuse check above).
    publishBranch: remoteBranch,
  });
  let prUrl = existing?.url ?? null;
  if (!existing) {
    // §16.6: with thread ids off the PR title never carries the task's
    // title or key — the HEAD commit subject when it is free of bb
    // identifiers (`thr_…`, tracker keys), else `release <sha7>`
    // (PLUG-194).
    const subject = threadIds
      ? null
      : await git(deps, repo, ["log", "-1", "--format=%s", headSha], {
          allowFail: true,
        });
    const title = threadIds
      ? ((
          await runJson<TaskShow>(deps.bbCli, [
            "tasks",
            "show",
            row.task_key,
            "--json",
          ]).catch(() => null)
        )?.task?.title ?? row.task_key)
      : subject && !hasBbIds(subject)
        ? subject
        : `release ${headSha.slice(0, 7)}`;
    const created = await ghText(deps, repo, [
      "pr",
      "create",
      "--base",
      row.target_branch,
      "--head",
      remoteBranch,
      "--title",
      title,
      "--body",
      threadIds
        ? `Источник: bb тред ${row.coordinator_thread_id}\n\n` +
          `Задача: ${row.task_key}`
        : "",
    ]);
    prUrl = GH_PR_URL_RE.exec(created)?.[0] ?? null;
  }
  deps.store.updateRelease(row.id, { prUrl });
  // §2 r10 п.3: this row tracks the PR; older published rows on the
  // same URL step aside (one tracking record per pr_url).
  deps.store.initPrTracking(row.id);
  if (prUrl) deps.store.supersedePrRows(prUrl, row.id);
  await runChecked(deps.bbCli, [
    "tasks",
    "update",
    row.task_key,
    "--status",
    "in_review",
  ]).catch((e) => deps.log?.warn?.(`release task status: ${message(e)}`));
  deps.store.updateRelease(row.id, { status: "published" });
  s.published++;
  await finishPublished(
    deps,
    deps.store.getRelease(row.id) ?? row,
    existing !== undefined,
  );
}

/** §2 r10 п.1: the ONE outcome line — success fact, post-check
 * findings and the postPublish result in the same message, sent under
 * the notified_at claim. `prExisted` null → the досмотр tick recomputes
 * it («PR обновлён» needs the pre-existing-PR fact). */
async function finishPublished(
  deps: ReleaseDeps,
  row: ReleaseRow,
  prExisted: boolean | null,
): Promise<void> {
  const fresh = deps.store.getRelease(row.id) ?? row;
  const headSha = fresh.published_sha ?? fresh.head_sha ?? "";
  const pushedBranch =
    fresh.target_action === "push"
      ? fresh.target_branch
      : (fresh.publish_branch ?? fresh.branch);
  // §2 п.6 (r11): postPublish — до сбора строки и до пост-проверки;
  // журнальные команды в полёте → такт уходит, работа досматривается
  // следующим проходом (строка ещё не сохранена).
  let selfReload: { rootDir: string; expectedSha: string } | null = null;
  let ppSummary: string | null = null;
  {
    const pp = await runPostPublishGuarded(
      deps,
      fresh,
      "release.published",
    );
    if (!pp.done) return;
    // Замок копии не переживает итог postPublish — в том числе при
    // раннем done внутри runPostPublish (идемпотентно).
    releasePostPublishLock(fresh.id);
    ppSummary = pp.summary;
    selfReload = pp.selfReload;
  }
  const checks = await postCheck(
    deps,
    fresh,
    headSha,
    pushedBranch,
    fresh.pr_url,
  ).catch((e) => [`пост-проверка не удалась: ${message(e)}`]);
  const parts: string[] = [];
  if (fresh.target_action === "push") {
    parts.push(
      `выложено ${fresh.task_key}: ${headSha.slice(0, 7)} в ` +
        `${fresh.target_branch}; задача done`,
    );
  } else {
    const existed =
      prExisted ??
      (fresh.pr_url
        ? deps.store.otherReleaseByPrUrl(fresh.pr_url, fresh.id)
        : false);
    parts.push(
      `${existed ? "PR обновлён" : "PR открыт"} ${fresh.task_key}: ` +
        `${fresh.pr_url ?? "—"}; слежу до влития`,
    );
  }
  if (fresh.kb_note) parts.push(`KB-заметка: ${fresh.kb_note}`);
  if (fresh.no_kb_reason) parts.push(`KB не требуется: ${fresh.no_kb_reason}`);
  for (const m of checks) parts.push(`пост-проверка: ${m}`);
  if (ppSummary) parts.push(ppSummary);
  const line = parts.join("\n");
  // §2 r10 п.5: работа выполнена и текст собран — сначала строка
  // сохраняется в записи, метка base снимается (повтор такта уже не
  // гоняет работу), затем отправка сохранённого текста.
  deps.store.setReleaseNotice(
    fresh.id,
    selfReload ? "self-reload" : "published",
    line,
  );
  deps.store.metaDelete(POSTPUBLISH_META(fresh.id));
  if (selfReload) {
    // §6 r10: the plugin cannot reload ITSELF — a one-shot bb
    // automation reloads orchestrator and delivers the outcome line
    // (the claim is captured BEFORE `automation create`, confirmed
    // after its success — the create IS the delivery, spec п.5).
    if (!deps.store.claimReleaseNotify(fresh.id)) return;
    const createErr = await createSelfReloadAutomation(
      deps,
      fresh,
      line,
      selfReload,
    );
    if (createErr == null) {
      // §18.2: новые queued не стартуют в умирающем процессе.
      deps.commandRunner?.holdForSelfReload();
      // §2 шаг 6: комментарий «выложено» в задачу пишет сам плагин —
      // скрипт доносит итоговую строку только до треда координатора.
      await commentOnTask(deps, fresh.task_key, line);
      deps.store.confirmReleaseNotify(fresh.id, line);
      return;
    }
    // create упал — захват снимается и уходит обычная строка п.1 с
    // «перезагрузи orchestrator вручную: <ошибка>» (спека §2 п.2).
    deps.store.releaseReleaseNotify(fresh.id);
    deps.store.setReleaseNotice(
      fresh.id,
      "published",
      `${line}\nперезагрузи orchestrator вручную: ${createErr}`,
    );
    await deliverReleaseNotice(deps, fresh);
    return;
  }
  await deliverReleaseNotice(deps, fresh);
}

// ── postPublish (§6 r10, push only) ───────────────────────────────────

interface PostPublishResult {
  /** false — журнальные команды в полёте (queued/running) или замок
   * занят: насос не блокируется, итог собирает следующий такт. */
  done: boolean;
  summary: string | null;
  selfReload: { rootDir: string; expectedSha: string } | null;
}

const POSTPUBLISH_META = (id: number) => `release-pp:${id}`;

/** §6 r11: замок копии держится весь postPublish — в том числе пока
 * журнальные команды ждут/работают (карта по release id, переживает
 * такты внутри процесса; файл — между процессами). */
const postPublishLocks = new Map<number, () => void>();

const releasePostPublishLock = (id: number): void => {
  postPublishLocks.get(id)?.();
  postPublishLocks.delete(id);
};

/** Остановка плагина: все замки копий postPublish снимаются (PLUG-245
 * Б2 — замок не переживает экземпляр). */
export function releaseAllPostPublishLocks(): void {
  for (const release of postPublishLocks.values()) release();
  postPublishLocks.clear();
}

/** §18.5 + PLUG-245 заход 3 (Б2): срок шагов postPublish — только на
 * ОЖИДАНИЕ (замок копии, очередь команд, удержание перезагрузки);
 * умолчание — timing.postPublishWaitMinutes (30 мин). Пока команда
 * выкладки запущена, итог не отдаётся и замок держится — её
 * ограничивает только свой timeoutSec (до 3600 с). Экспортируется для
 * тестов как дефолт срока. */
export const POSTPUBLISH_MAX_MS = 30 * 60 * 1000;

/** §18.2: «<name>: ok» / «<name>: пропущена — <reason>» / … — один
 * формат для строки итога и для строки истёкшего ожидания (заход 4). */
const commandRunBit = (name: string, r: CommandRunRow): string => {
  switch (r.status) {
    case "ok":
      return `${name}: ok`;
    case "skipped":
      // §18.2: «<name>: нет checkout» — без «пропущена —».
      return r.output_tail === "нет checkout"
        ? `${name}: нет checkout`
        : `${name}: пропущена — ${r.output_tail}`;
    case "timeout":
      return `${name}: таймаут`;
    case "interrupted":
      return `${name}: прервана перезапуском`;
    default:
      return (
        `${name}: упала (код ${r.exit_code ?? "?"})` +
        (r.output_tail ? `: ${r.output_tail}` : "")
      );
  }
};

/** Состояние копии в plugin_meta: base пишется один раз, результат ff
 * мемоизируется (поздний сбой fetch не отменяет уже сделанный ff). */
interface PostPublishMeta {
  startedAt?: number;
  /** §18.5: начало ТЕКУЩЕГО ожидания (замок/очередь/удержание);
   * обнуляется, пока идёт running команда этой выкладки. */
  waitSince?: number;
  base?: string;
  copy?: { head: string; changed: string[] };
  pub?: string[] | null;
  /** Собранная итоговая строка postPublish — переживает стирание
   * notice_text confirm'ом досмотра, чтобы merging-такт не
   * пересобирал итог и не слал дубль после краха. */
  finish?: string;
}

// §6 r11: манифест зависимостей считается строго в rootDir плагина или
// в корне копии — вложенные package.json (фикстуры) не триггерят.
const LOCKFILE_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "go.sum",
  "composer.lock",
]);

/** §18.5: эффективные таймауты записи выкладки — проект из настройки,
 * иначе дефолты §18.5. */
async function releaseTiming(
  deps: ReleaseDeps,
  row: ReleaseRow,
): Promise<ResolvedTiming> {
  const cfg = deps.loadReleaseConfig().config;
  if (!cfg) return DEFAULT_TIMING;
  let pid = row.settings_project_id;
  if (!pid) {
    try {
      pid = await settingsProjectId(deps, row.repo_path, row.project_id, cfg);
    } catch {
      return DEFAULT_TIMING;
    }
  }
  return resolveProject(cfg, pid).timing;
}

/** §6 r11: пути, изменённые выкладкой remote_base_sha..published_sha в
 * основном каталоге — материал для `when` (glob ANY). Диапазон не
 * вычислился → null → все команды идут (§6 r11). */
async function publishedChangedPaths(
  deps: ReleaseDeps,
  row: ReleaseRow,
  mainDir: string,
): Promise<string[] | null> {
  const base = row.remote_base_sha;
  const head = row.published_sha ?? row.head_sha;
  if (!base || !head || base === EMPTY_TREE_SHA) return null;
  const res = await deps.cmd
    .run("git", ["-C", mainDir, "diff", "--name-only", `${base}..${head}`], {
      timeoutMs: 60_000,
    })
    .catch(() => null);
  if (!res || res.exitCode !== 0) return null;
  return res.stdout.split("\n").filter(Boolean);
}

/** §18.5 (ревью заход 6): бросок из runPostPublish при ЖИВОЙ команде
 * выкладки — замок и итог держатся (pending, ошибка в журнал плагина),
 * повтор следующим тактом; журнал не прочитан — консервативно то же.
 * Без running — как раньше: итог «postPublish: <ошибка>», замок снят. */
async function runPostPublishGuarded(
  deps: ReleaseDeps,
  row: ReleaseRow,
  event: "release.published" | "pr.merged",
): Promise<PostPublishResult> {
  try {
    return await runPostPublish(deps, row, event);
  } catch (e) {
    let running = true;
    try {
      running = deps.store
        .commandRunsByGroup(`pp:${row.id}`)
        .some((r) => r.status === "running");
    } catch {
      // журнал не прочитан — считаем команду живой, замок и итог держим
    }
    if (running) {
      deps.log?.warn?.(
        `orchestrator: postPublish ${row.task_key}: ${message(e)}`,
      );
      return { done: false, summary: null, selfReload: null };
    }
    releasePostPublishLock(row.id);
    return {
      done: true,
      summary: `postPublish: ${message(e)}`,
      selfReload: null,
    };
  }
}

/**
 * §6 r11 (PLUG-245): послевыкладочные шаги — обновление настроенной
 * копии (опционально), произвольные команды через общий запускатель
 * (журнал command_runs, событие ORCH_EVENT), перезагрузка плагинов по
 * реестру установленных (любая раскладка: rootDir записи внутри копии +
 * изменённые файлы под ним). Всё resumable: base в plugin_meta,
 * состояние команд в журнале — повтор такта работу не дублирует.
 */
async function runPostPublish(
  deps: ReleaseDeps,
  row: ReleaseRow,
  event: "release.published" | "pr.merged",
): Promise<PostPublishResult> {
  const groupKey = `pp:${row.id}`;
  const done = (summary: string | null = null): PostPublishResult => {
    // PLUG-245 заход 4 (ревью Б1): любой done снимает замок копии.
    // Ранние выходы (нет настроек, проект не определён, `on` не совпал)
    // иначе оставляют замок от прошлого такта навсегда — с замком по
    // экземпляру следующие выкладки его уже не ломают. Идемпотентно.
    releasePostPublishLock(row.id);
    return { done: true, summary, selfReload: null };
  };
  const pending: PostPublishResult = {
    done: false,
    summary: null,
    selfReload: null,
  };
  // §18.5 (ревью заход 4): ранние выходы смотрят журнал группы — пока
  // команда выкладки запущена, итог не отдаётся и замок держится даже
  // при сломанной/убранной настройке; ждущие queued переводятся в
  // skipped, чтобы pump их не запустил после ушедшего итога.
  const earlyDone = (
    summary: string | null = null,
  ): PostPublishResult => {
    const rows = deps.store.commandRunsByGroup(groupKey);
    if (rows.some((r) => r.status === "running")) return pending;
    const at = deps.now?.() ?? Date.now();
    for (const r of rows) {
      if (r.status === "queued") {
        deps.store.skipQueuedCommandRun(r.id, "настройка сменилась", at);
      }
    }
    return done(summary);
  };
  const cfg = deps.loadReleaseConfig().config;
  if (!cfg) return earlyDone();
  const fail = (msg: string): PostPublishResult =>
    earlyDone(`postPublish: ${msg}`);
  // §6 (r8) п.6: записанный проект настройки; у pre-r8 записей после
  // публикации postPublish пропускается с причиной — публикация валидна.
  let projectId: string;
  try {
    projectId =
      row.settings_project_id ??
      (await settingsProjectId(
        deps,
        row.repo_path,
        row.project_id,
        cfg,
      ));
  } catch (e) {
    deps.log?.warn?.(
      `orchestrator: postPublish settings project: ${message(e)}`,
    );
    return fail("проект настройки не определён");
  }
  const project = resolveProject(cfg, projectId);
  const pp = project.postPublish;
  const want = event === "pr.merged" ? "merged" : "published";
  if (!pp || pp.on !== want) return earlyDone();
  const now = deps.now?.() ?? Date.now();
  const mainDir =
    row.repo_root ??
    (await realpath(row.repo_path).catch(() => row.repo_path));
  const pushedBranch =
    row.target_action === "push"
      ? row.target_branch
      : (row.publish_branch ?? row.branch);
  const cmdEnv = {
    ORCH_EVENT: event,
    ORCH_TASK: row.task_key,
    ORCH_SHA:
      (event === "pr.merged" ? row.pr_merge_sha : row.published_sha) ??
      row.published_sha ??
      row.head_sha ??
      "",
    ORCH_BRANCH: pushedBranch,
    ORCH_TARGET: row.target_branch,
    ORCH_REPO_DIR: mainDir,
  };
  const specOf = (c: ResolvedPostPublishCommand, cwd: string) => ({
    source: "postPublish",
    runKey: `${groupKey}:${c.name}`,
    groupKey,
    name: c.name,
    argv: c.argv,
    cwd,
    env: cmdEnv,
    timeoutSec: c.timeoutSec ?? project.timing.commandTimeoutSec,
  });
  // §18.2: cwd без значения — checkout, если он настроен, иначе
  // каталог репозитория; относительный путь — от каталога репозитория
  // (не от cwd процесса bb).
  const cmdCwd = (c: ResolvedPostPublishCommand): string => {
    if (c.cwd === "checkout") return pp.checkout ?? mainDir;
    if (c.cwd === undefined) return pp.checkout ?? mainDir;
    return isAbsolute(c.cwd) ? c.cwd : join(mainDir, c.cwd);
  };

  // ── метка состояния postPublish (переживает такты и рестарты) ──
  const markerKey = POSTPUBLISH_META(row.id);
  let meta: PostPublishMeta = {};
  try {
    meta = JSON.parse(
      deps.store.metaGet(markerKey) ?? "{}",
    ) as PostPublishMeta;
  } catch {
    meta = {};
  }
  if (meta.startedAt === undefined) {
    meta.startedAt = now;
    deps.store.metaSet(markerKey, JSON.stringify(meta));
  }
  const saveMeta = () =>
    deps.store.metaSet(markerKey, JSON.stringify(meta));

  // §18.5 (заход 3 Б2): срок — только на ожидание. Пока у выкладки
  // есть running команда — итог не отдаётся и замок держится (её
  // ограничивает свой timeoutSec); счётчик ожидания обнуляется.
  const groupRuns = deps.store.commandRunsByGroup(groupKey);
  const waitMs =
    (project.timing.postPublishWaitMinutes ??
      POSTPUBLISH_MAX_MS / 60_000) * 60_000;
  if (groupRuns.some((r) => r.status === "running")) {
    if (meta.waitSince !== undefined) {
      delete meta.waitSince;
      saveMeta();
    }
  } else {
    meta.waitSince ??= now;
    if (now - meta.waitSince >= waitMs) {
      const waiting =
        pp.checkout && !postPublishLocks.has(row.id)
          ? "замка копии"
          : groupRuns.some((r) => r.status === "queued")
            ? "очереди команд"
            : "завершения шагов";
      // Уже сделанное не теряем: итог копии и завершённые команды идут
      // в строку рядом с «не дождались <чего>» (заход 4, ревью).
      const bits: string[] = [];
      if (pp.checkout) {
        bits.push(meta.copy ? "копия обновлена" : "копия не обновлена");
      }
      for (const c of pp.commands) {
        const r = deps.store.commandRunByKey(`${groupKey}:${c.name}`);
        if (r && r.status !== "queued" && r.status !== "running") {
          bits.push(commandRunBit(c.name, r));
        }
      }
      for (const c of pp.commands) {
        deps.store.markCommandRunSkipped(
          specOf(c, cmdCwd(c)),
          `не дождались ${waiting}`,
          now,
        );
      }
      releasePostPublishLock(row.id);
      return fail([...bits, `не дождались ${waiting}`].join("; "));
    }
    saveMeta();
  }

  // ── копия: тот же репозиторий → ветка → замок → fetch → base → ff ──
  let copyOk = false;
  let copyErr: string | null = null;
  let newHead = "";
  let copyChanged: string[] = [];
  const co = pp.checkout;
  const gitOut = async (args: string[]) =>
    (
      await deps.cmd.run("git", ["-C", co!, ...args], {
        timeoutMs: 120_000,
      })
    ).stdout.trim();
  const coGit: MergeGit = (args, opts) =>
    deps.cmd
      .run("git", ["-C", co!, ...args], {
        timeoutMs: opts?.timeoutMs ?? 120_000,
      })
      .then((r) => ({
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
      }));
  // §18.5: замок копии держится весь postPublish — и по командам в
  // полёте (их cwd по умолчанию — копия), и по перезагрузке. Мапа
  // in-memory: после рестарта замок перевооружается, протухший замок
  // умершего экземпляра ломается по владельцу (PLUG-245 Б2).
  const ensureCopyLock = async (): Promise<boolean> => {
    if (!co || postPublishLocks.has(row.id)) return true;
    // §18.5: флаг «остановлен» — идущий такт новых замков не берёт.
    if (deps.commandRunner?.isStopped?.()) return false;
    const gitDir = await gitOut(["rev-parse", "--absolute-git-dir"]).catch(
      () => "",
    );
    const lockPath = join(gitDir || join(co, ".git"), MERGE_LOCK_NAME);
    try {
      const release = await acquireCopyLock(coGit, co, lockPath, {
        owner: deps.instanceId ?? `postPublish:${process.pid}`,
      });
      // §18.5 (заход 4): stop мог прийти, пока ждали acquire — такой
      // замок не числится в карте и не снимется stopAll, отпускаем сразу.
      if (deps.commandRunner?.isStopped?.()) {
        release();
        return false;
      }
      postPublishLocks.set(row.id, release);
      return true;
    } catch (e) {
      // §6 r11: копия занята merge — такт уходит, команды ждут.
      deps.log?.warn?.(
        `orchestrator: postPublish lock ${row.task_key}: ${message(e)}`,
      );
      return false;
    }
  };
  if (co) {
    if (meta.copy) {
      // ff уже сделан прошлым тактом — поздний сбой fetch его не
      // отменяет и повторного прогона нет (ревью: fetch/ff/diff каждые
      // 5 с, пока команды в полёте).
      copyOk = true;
      newHead = meta.copy.head;
      copyChanged = meta.copy.changed;
    } else {
      // §6 r11: сначала «тот же репозиторий» — замок чужой копии не
      // берём (ревью: замок до проверки origin).
      const coOriginRaw = await gitOut(["remote", "get-url", "origin"]).catch(
        () => "",
      );
      const repoOriginRaw = await git(
        deps,
        row.repo_path,
        ["remote", "get-url", "origin"],
        { allowFail: true },
      );
      const coNorm = normalizeGitRemoteUrl(coOriginRaw);
      const repoNorm = normalizeGitRemoteUrl(repoOriginRaw);
      const sameRepo =
        coNorm != null && repoNorm != null
          ? coNorm === repoNorm
          : (coOriginRaw !== "" && coOriginRaw === repoOriginRaw) ||
            (coNorm == null &&
              repoNorm == null &&
              (await realpath(coOriginRaw).catch(() => coOriginRaw)) ===
                (await realpath(repoOriginRaw).catch(() => repoOriginRaw)));
      if (!sameRepo) {
        copyErr = "другой репозиторий — не обновлена";
      } else {
        const curBranch = await gitOut([
          "symbolic-ref",
          "--short",
          "-q",
          "HEAD",
        ]).catch(() => "");
        if (curBranch !== pp.branch) {
          copyErr = `копия не на ${pp.branch} — не обновлена`;
        } else {
          // §18.5: команды с cwd:checkout держат замок на копию весь
          // postPublish. Владелец — экземпляр плагина (не pid), состояние
          // branch/head не записывается: протухший замок умершего
          // экземпляра ломается без restoreCopy (PLUG-245 Б2).
          if (!(await ensureCopyLock())) return pending;
          let base = meta.base;
          if (!base) {
            base = await gitOut(["rev-parse", "HEAD"]).catch(() => "");
            if (base) {
              meta.base = base;
              saveMeta();
            }
          }
          const fetchRes = await deps.cmd.run(
            "git",
            ["-C", co, "fetch", "origin"],
            { timeoutMs: 180_000 },
          );
          if (fetchRes.exitCode !== 0) {
            copyErr =
              `fetch не удался: ` +
              `${maskCommandOutput(fetchRes.stderr || "")}`;
          } else {
            const ffRes = await deps.cmd.run(
              "git",
              ["-C", co, "merge", "--ff-only", `origin/${row.target_branch}`],
              { timeoutMs: 120_000 },
            );
            if (ffRes.exitCode !== 0) {
              copyErr =
                `ff не прошёл ` +
                `(${maskCommandOutput(ffRes.stderr || ffRes.stdout || "")})`;
            } else {
              copyOk = true;
              newHead = await gitOut(["rev-parse", "HEAD"]).catch(() => "");
              copyChanged = base
                ? (
                    await gitOut([
                      "diff",
                      "--name-only",
                      `${base}..${newHead}`,
                    ]).catch(() => "")
                  )
                    .split("\n")
                    .filter(Boolean)
                : [];
              meta.copy = { head: newHead, changed: copyChanged };
              saveMeta();
            }
          }
        }
      }
    }
  }

  // ── постановка команд: следующая — только после итога предыдущей ──
  // (PLUG-245 Б1: очередь всех сразу обгоняла stopOnFail между тактами
  // и после рестарта; журнал run_key остаётся идемпотентным).
  const pubPaths =
    meta.pub !== undefined
      ? meta.pub
      : await publishedChangedPaths(deps, row, mainDir);
  if (meta.pub === undefined) {
    meta.pub = pubPaths;
    saveMeta();
  }
  // §18.2: stopOnFail — исход «не ok» обязательной команды пропускает
  // все поздние; «не прошла <имя>» — по имени остановившей. Пропуск по
  // `when` («нет изменений») — не сбой и цепочку не останавливает.
  const SKIP_WHEN = "нет изменений по when";
  const stopsChain = (status: string, tail: string | null): boolean =>
    status !== "ok" && !(status === "skipped" && tail === SKIP_WHEN);
  let stopper: string | null = null;
  let earlierInFlight = false;
  for (const c of pp.commands) {
    const runKey = `${groupKey}:${c.name}`;
    const r = deps.store.commandRunByKey(runKey);
    if (r && r.status !== "queued" && r.status !== "running") {
      if (
        stopper === null &&
        c.stopOnFail &&
        stopsChain(r.status, r.output_tail)
      ) {
        stopper = c.name;
      }
      continue;
    }
    if (stopper !== null) {
      deps.store.markCommandRunSkipped(
        specOf(c, cmdCwd(c)),
        `не прошла ${stopper}`,
        now,
      );
      continue;
    }
    if (earlierInFlight) continue; // ждёт итога предыдущей — не ставим
    if (r) {
      earlierInFlight = true;
      continue;
    }
    let reason: string | null = null;
    // §6 r11 (заход 3 Б3): «копия не обновлена» — по ФАКТИЧЕСКОМУ cwd:
    // явный "checkout" или cwd по умолчанию при заданном checkout
    // (иначе команда выполнилась бы в необновлённой/чужой копии).
    if (c.cwd === "checkout" && !co) {
      reason = "нет checkout";
    } else if (
      co &&
      !copyOk &&
      (c.cwd === "checkout" || c.cwd === undefined)
    ) {
      reason = "копия не обновлена";
    }
    if (
      !reason &&
      c.when?.length &&
      pubPaths !== null &&
      !c.when.some((w) => pubPaths.some((p) => globMatch(w, p)))
    ) {
      reason = SKIP_WHEN;
    }
    if (reason) {
      deps.store.markCommandRunSkipped(specOf(c, cmdCwd(c)), reason, now);
      if (c.stopOnFail && reason !== SKIP_WHEN) stopper = c.name;
    } else {
      deps.store.enqueueCommandRun(specOf(c, cmdCwd(c)), now);
      earlierInFlight = true;
    }
  }
  const rowsByCmd = pp.commands.map(
    (c) => [c, deps.store.commandRunByKey(`${groupKey}:${c.name}`)] as const,
  );
  if (
    rowsByCmd.some(
      ([, r]) => !r || r.status === "queued" || r.status === "running",
    )
  ) {
    // Команды в полёте — замок копии держим и после рестарта (их cwd по
    // умолчанию — копия); занят merge — ждём следующего такта.
    if (!(await ensureCopyLock())) return pending;
    await deps.commandRunner?.pump();
    return pending;
  }
  const bits: string[] = [];
  if (co) {
    bits.push(copyOk ? "копия обновлена" : (copyErr ?? "копия не обновлена"));
  }
  for (const [c, r] of rowsByCmd) {
    if (!r) continue;
    bits.push(commandRunBit(c.name, r));
  }

  // ── перезагрузка плагинов (r11: любая раскладка, по реестру) ──
  let selfReload: { rootDir: string; expectedSha: string } | null = null;
  if (co && copyOk && !stopper) {
    // Перезагрузка — под тем же замком копии, что и ff (§18.5).
    if (!(await ensureCopyLock())) return pending;
    if (!pp.reloadPlugins) {
      bits.push("перезагрузка плагинов выключена");
    } else {
      const installsDepsOk = rowsByCmd.some(
        ([c, r]) => c.installsDeps && r?.status === "ok",
      );
      const list = await runJson<unknown>(deps.bbCli, [
        "plugin",
        "list",
        "--json",
      ]).catch(() => null);
      const entries = (Array.isArray(list)
        ? list
        : ((list as { plugins?: unknown[] })?.plugins ?? [])) as {
        id?: string;
        name?: string;
        rootDir?: string;
        dir?: string;
        path?: string;
      }[];
      let providersByPlugin: Map<string, Set<string>> | null | undefined;
      const providerIdsOf = async (
        id: string,
      ): Promise<Set<string> | null> => {
        if (providersByPlugin === undefined) {
          providersByPlugin = null;
          const pl = await runJson<unknown>(deps.bbCli, [
            "provider",
            "list",
            "--json",
          ]).catch(() => null);
          if (pl != null) {
            providersByPlugin = new Map();
            const ps = (Array.isArray(pl)
              ? pl
              : ((pl as { providers?: unknown[] })?.providers ?? [])) as {
              id?: string;
              pluginId?: string;
            }[];
            for (const p of ps) {
              if (!p.id || !p.pluginId) continue;
              const bucket =
                providersByPlugin.get(p.pluginId) ?? new Set<string>();
              bucket.add(p.id);
              providersByPlugin.set(p.pluginId, bucket);
            }
          }
        }
        if (providersByPlugin == null) return null;
        return providersByPlugin.get(id) ?? new Set();
      };
      const coReal = await realpath(co).catch(() => co);
      const running = deps.store.listByStatuses(ACTIVE_STATUSES);
      const reloaded: string[] = [];
      const skipped: string[] = [];
      // §6 r11: кандидат — плагин, чей rootDir лежит внутри копии и у
      // которого есть изменённые файлы base..HEAD под ним. Корень копии
      // = rootDir → любой diff триггерит. Пути вне rootDir — молча.
      for (const e of entries) {
        const id = e.id;
        const root = e.rootDir ?? e.dir ?? e.path;
        if (!id || !root) continue;
        const rootReal = await realpath(root).catch(() => root);
        const rel = relative(coReal, rootReal);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        const prefix = rel === "" ? "" : `${rel}/`;
        const touched = copyChanged.filter(
          (p) => prefix === "" || p.startsWith(prefix),
        );
        if (!touched.length) continue;
        // Манифест зависимостей строго в rootDir плагина или в корне
        // копии — вложенные package.json (фикстуры) не считаются.
        const depsTouched =
          touched.some((p) =>
            LOCKFILE_NAMES.has(p.slice(prefix.length)),
          ) ||
          copyChanged.some(
            (p) => !p.includes("/") && LOCKFILE_NAMES.has(p),
          );
        if (depsTouched && !installsDepsOk) {
          skipped.push(
            `${id}: изменены зависимости — переустанови их и ` +
              `перезагрузи вручную`,
          );
          continue;
        }
        const pids = await providerIdsOf(id);
        if (pids == null) {
          skipped.push(
            `${id}: реестр провайдеров не прочитан — перезагрузи вручную`,
          );
          continue;
        }
        if (pids.size > 0 && running.some((d) => pids.has(d.provider))) {
          skipped.push(`${id}: идут ходы — перезагрузи позже`);
          continue;
        }
        if (id === "orchestrator") {
          // §6 r11: самоперезагрузка — когда в журнале нет running.
          if (deps.store.runningCommandRuns().length > 0) {
            skipped.push(
              "orchestrator: идут команды — перезагрузи позже",
            );
            continue;
          }
          selfReload = { rootDir: rootReal, expectedSha: newHead };
          continue;
        }
        const r = await deps.bbCli.run(["plugin", "reload", id]);
        if (r.exitCode !== 0) {
          skipped.push(
            `${id}: перезагрузка не удалась: ` +
              `${(r.stderr || r.stdout || "").trim().slice(0, 120)}`,
          );
        } else {
          reloaded.push(id);
        }
      }
      if (reloaded.length) bits.push(`перезагружено: ${reloaded.join(", ")}`);
      if (skipped.length) bits.push(`пропущено: ${skipped.join(", ")}`);
      if (selfReload) {
        bits.push("orchestrator перезагружается автоматизацией");
      }
      if (!reloaded.length && !skipped.length && !selfReload) {
        bits.push("плагины не менялись");
      }
    }
  }
  releasePostPublishLock(row.id);
  if (!bits.length) return { done: true, summary: null, selfReload };
  return {
    done: true,
    summary: `postPublish: ${bits.join("; ")}`,
    selfReload,
  };
}

/**
 * §6 r10: a one-shot script automation reloads the orchestrator plugin
 * (it cannot reload itself), then waits up to 3 min for `bb orchestrator
 * status` and the checkout HEAD == the expected sha, and delivers the
 * outcome line via `bb thread tell`. Returns null when `bb automation
 * create` succeeded, else the error text for «перезагрузи orchestrator
 * вручную: <ошибка>» (спека §2 п.2).
 */
async function createSelfReloadAutomation(
  deps: ReleaseDeps,
  row: ReleaseRow,
  line: string,
  selfReload: { rootDir: string; expectedSha: string },
): Promise<string | null> {
  // §6 r11: значения в скрипт — base64, не интерполяцией в shell.
  const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");
  const dec = (v: string) => `$(printf %s '${b64(v)}' | base64 -d)`;
  const script = [
    "#!/bin/sh",
    `COORD=${dec(row.coordinator_thread_id)}`,
    `EXPECTED=${dec(selfReload.expectedSha)}`,
    `ROOT=${dec(selfReload.rootDir)}`,
    `TEXT=${dec(`[orchestrator] ${line}`)}`,
    "sleep 15",
    "bb plugin reload orchestrator >/dev/null 2>&1 || true",
    "i=0",
    "while [ $i -lt 16 ]; do",
    "  sleep 10",
    "  i=$((i+1))",
    '  cur=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo "?")',
    '  if bb orchestrator status >/dev/null 2>&1 && [ "$cur" = "$EXPECTED" ]; then',
    '    bb thread tell "$COORD" --mode queue "$TEXT; перезагружено: orchestrator" >/dev/null 2>&1 || true',
    "    exit 0",
    "  fi",
    "done",
    'last=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo "?")',
    'bb thread tell "$COORD" --mode queue "$TEXT; orchestrator после перезагрузки не поднялся / копия на $last, ожидался $EXPECTED" >/dev/null 2>&1 || true',
  ].join("\n");
  // §6 r10: автоматизация — в проекте КООРДИНАТОРА
  // (`--project <проект координатора>`), не делегирования.
  const coordProject =
    (await deps.threads
      .get({ threadId: row.coordinator_thread_id })
      .then((t) => t.projectId)
      .catch(() => undefined)) ?? row.project_id;
  const res = await deps.bbCli.run([
    "automation",
    "create",
    "--in",
    "1m",
    // `--name` обязателен (bb automation create --help), `--timeout` —
    // скрипт спит 15 с и ждёт до ~3 мин, дефолтные 120 с его резали;
    // `--interpreter sh` — тело на POSIX sh (ревью PLUG-244 заход 1, Б1).
    "--name",
    `release ${row.task_key} reload`,
    "--script",
    script,
    "--interpreter",
    "sh",
    "--timeout",
    "5m",
    "--project",
    coordProject,
  ]);
  if (res.exitCode !== 0) {
    const err = (res.stderr || res.stdout || `exit ${res.exitCode}`)
      .trim()
      .slice(0, 200);
    deps.log?.warn?.(`orchestrator release: automation create: ${err}`);
    return err || `exit ${res.exitCode}`;
  }
  return null;
}

// ── Step 7: пост-проверка ──────────────────────────────────────────────

/**
 * §2 step 7: re-scan what actually landed on the remote (or the PR
 * branch) — a leak that slipped is reported to the coordinator only
 * (§8.2). «Выложено в обход»: for `push`, commits in the target branch
 * that carry no release record; for `pr`, only our own branch/PR is
 * checked — other people's PRs are legitimate by spec.
 */
async function postCheck(
  deps: ReleaseDeps,
  row: ReleaseRow,
  pushedSha: string,
  /** The remote branch the push actually wrote (§16.6: `release/<sha7>`
   * when the project's `threadIds` is off). */
  pushedBranch: string,
  prUrl: string | null,
): Promise<string[]> {
  row = deps.store.getRelease(row.id) ?? row;
  const repo = row.repo_path;
  const messages: string[] = [];
  try {
    await git(deps, repo, ["fetch", "origin"], { timeoutMs: 180_000 });
  } catch (e) {
    // §2 r10 п.1: the post-check failure is reported inside the same
    // outcome line, not as a message of its own.
    messages.push(`fetch не удался — ${message(e)}`);
    return messages;
  }

  if (row.target_action === "push") {
    const target = `origin/${row.target_branch}`;
    // What landed between the recorded remote base and now — every sha
    // that is neither ours nor another release's is «выложено в обход».
    const base = row.remote_base_sha ?? null;
    if (base && base !== ZERO_SHA) {
      // §17.3 (С5): what landed on the remote outside the pushed
      // history — `rev-list <target> --not <pushedSha>`; another
      // release's own commits don't count as «выложено в обход».
      const extra = await git(deps, repo, [
        "rev-list",
        target,
        "--not",
        pushedSha,
      ]).catch(() => "");
      const unknown = extra
        .split("\n")
        .filter(Boolean)
        .filter((sha) => sha !== pushedSha && !deps.store.shaWasReleased(sha));
      if (unknown.length) {
        messages.push(
          `в ${row.target_branch} легли коммиты вне release: ` +
            unknown.slice(0, 5).map((s) => s.slice(0, 8)).join(", "),
        );
      }
    }
    const remoteHead = await git(deps, repo, ["rev-parse", target]).catch(
      () => "",
    );
    const landed = await git(deps, repo, [
      "merge-base",
      "--is-ancestor",
      pushedSha,
      target,
    ]).then(() => true).catch(() => false);
    if (!landed) {
      messages.push(
        `выложенный ${pushedSha.slice(0, 8)} не предок ${target} ` +
          `(remote head ${remoteHead.slice(0, 8)})`,
      );
    }
  } else {
    const remote = `origin/${pushedBranch}`;
    const remoteSha = await git(deps, repo, ["rev-parse", remote]).catch(
      () => "",
    );
    if (remoteSha !== pushedSha) {
      messages.push(
        `удалённая ветка ${remote} указывает на ${remoteSha.slice(0, 8)}, ` +
          `выкладывали ${pushedSha.slice(0, 8)}`,
      );
    }
    if (!prUrl) {
      messages.push(
        `PR ветки ${pushedBranch} → ${row.target_branch} не найден`,
      );
    }
  }

  // Re-scan what landed — the same categories against the remote range.
  const scanBase = row.remote_base_sha && row.remote_base_sha !== ZERO_SHA
    ? row.remote_base_sha
    : null;
  // §2 шаг 7 (r8): a skipped rescan is a line to the coordinator, not
  // silence — the first release onto a new branch has no remote base.
  if (!scanBase) {
    messages.push(
      "скан пропущен, нет базы удалённого диапазона " +
        "(первая выкладка в новую ветку)",
    );
  } else if (scanBase === pushedSha) {
    messages.push("скан пропущен, удалённый диапазон пуст");
  } else {
    try {
      const commits = await commitRange(
        deps,
        repo,
        scanBase,
        pushedSha,
      );
      const added = parseAddedLines(
        await git(deps, repo, [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--unified=0",
          scanBase,
          pushedSha,
        ]),
      );
      const patches = parseAddedLines(
        await git(deps, repo, [
          "log",
          "-p",
          "--cc",
          "--no-color",
          "--no-ext-diff",
          "--unified=0",
          `${scanBase}..${pushedSha}`,
        ]),
      );
      const cfg = deps.loadReleaseConfig().config;
      // §2 шаг 7: the same project rules as step 4 — the repo's project
      // settings (leaks, commitIdentity, threadIds, allowlists). Without
      // a release config the previous strict defaults apply.
      const proj: Pick<
        ResolvedProject,
        | "leaks"
        | "commitIdentity"
        | "threadIds"
        | "allowedTrailers"
        | "allowedEmails"
      > = cfg
        ? resolveProject(
            cfg,
            // §6 (r8) п.6: the recorded settings project wins; pre-r8
            // rows resolve anew (an error here is reported below).
            row.settings_project_id ??
              (await settingsProjectId(
                deps,
                row.repo_path,
                row.project_id,
                cfg,
              )),
          )
        : {
            leaks: { machine: "block", bbIds: "block", allow: [] },
            threadIds: true,
            allowedTrailers: [],
            allowedEmails: [],
          };
      const findings = await machineScan(deps.cmd, {
        repoPath: repo,
        baseSha: scanBase,
        headSha: pushedSha,
        commits,
        added,
        patches,
        leaks: proj.leaks,
        allowedAuthor: await allowedAuthor(deps, repo, proj.commitIdentity),
        hostname: deps.hostname ?? osHostname(),
        threadIds: proj.threadIds,
        allowedTrailers: proj.allowedTrailers,
        allowedEmails: proj.allowedEmails,
      });
      const blockers = findings.filter((f) => f.severity === "block");
      if (blockers.length) {
        messages.push(
          `повторный скан удалённого диапазона нашёл находки:\n` +
            blockers.slice(0, 10).map((f) => `- ${formatFinding(f)}`).join("\n"),
        );
      }
    } catch (e) {
      messages.push(`повторный скан не удался: ${message(e)}`);
    }
  }

  return messages;
}
