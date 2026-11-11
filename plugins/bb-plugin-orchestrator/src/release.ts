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
import { join } from "node:path";
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
  EMPTY_TREE_SHA,
  formatFinding,
  maskSecrets,
  type CommitMeta,
  type ScanFinding,
} from "./scan.js";
import {
  resolveProject,
  type ReleaseConfigLoad,
  type ResolvedProject,
} from "./release-config.js";
import {
  levelRole,
  pickRoute,
  type Policy,
  type PolicyLoad,
} from "./policy.js";
import type { DelegationRow, DelegationStore, ReleaseRow } from "./store.js";
import { runChecked, runJson, type BbCli } from "./bb-cli.js";
import type { CmdRunner } from "./cmd.js";
import { isCoordinator, type ExecutorProbes, type ThreadFacts } from "./agent-config.js";
import { dispatchToRoute, type DispatchStepsDeps } from "./delegate.js";
import type { WatchdogThreadEvent } from "./watchdog.js";

const AUDIT_LEVEL = "release-audit";
const TOKEN_TTL_MS = 5 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const PACKET_DIFF_CAP = 200_000;
const ZERO_SHA = "0000000000000000000000000000000000000000";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Deps & small types ────────────────────────────────────────────────

export interface ReleaseThreadDto {
  id: string;
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
  events: {
    list(args: {
      threadId: string;
      order?: "desc" | "asc";
      limit?: string;
      types?: readonly string[];
    }): Promise<WatchdogThreadEvent[]>;
  };
}

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
export function reviewVerdictOk(body: string): boolean {
  let verdict: unknown;
  let blockers: unknown;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    let parsed: { verdict?: unknown; blockers?: unknown };
    try {
      parsed = JSON.parse(line) as { verdict?: unknown; blockers?: unknown };
    } catch {
      continue;
    }
    if (parsed.verdict !== "OK" && parsed.verdict !== "CHANGES") continue;
    verdict = parsed.verdict;
    blockers = parsed.blockers;
  }
  // §16.7 (PLUG-186): the verdict line carries `blockers` — a missing
  // field is not an OK.
  return verdict === "OK" && blockers === 0;
}

function reviewVerdict(
  show: TaskShow,
  delegation: DelegationRow,
): "ok" | "missing" | "not-ok" {
  const comments = (show.comments ?? [])
    .filter((c) => c.kind === "agent" && c.threadId === delegation.thread_id)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const last = comments.at(-1);
  if (!last?.body) return "missing";
  return reviewVerdictOk(last.body) ? "ok" : "not-ok";
}

/** §2 step 1 — everything the pipeline refuses on, as one list. */
async function acceptTask(
  input: ReleaseInput,
  deps: ReleaseDeps,
): Promise<{
  taskKey: string;
  title: string;
  executor: DelegationRow;
  project: ResolvedProject;
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

  const review = deps.store
    .delegationsByTask(key)
    .find((d) => roleOf(d.level) === "auditor");
  if (!review) {
    missing.push("нет ревью аудиторского уровня");
  } else if (review.status !== "done") {
    missing.push(
      `последнее ревью уровня ${review.level} в статусе ${review.status}`,
    );
  } else {
    if (executor && review.created_at < executor.created_at) {
      missing.push("последнее ревью старше последнего исполнения");
    }
    const v = reviewVerdict(show, review);
    if (v === "missing") {
      missing.push("вердикт ревью не найден в комментариях задачи");
    } else if (v === "not-ok") {
      missing.push("последнее ревью — вердикт не «OK» (§16.7 JSON)");
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
    project: resolveProject(
      deps.loadReleaseConfig().config!,
      executor!.project_id ?? input.caller.projectId,
    ),
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
): Promise<{ baseSha: string; remoteBaseSha: string | null }> {
  const dirty = await git(deps, repo, ["status", "--porcelain"]);
  if (dirty) {
    throw new OrchestratorError(
      "release-refused",
      "в рабочей копии есть незакоммиченные изменения — release отклонён",
      "закоммить или убрать изменения и повторить",
    );
  }
  await git(deps, repo, ["fetch", "origin"], { timeoutMs: 180_000 });
  const target = `origin/${project.target.branch}`;
  const remoteBaseSha = (await gitRefExists(deps, repo, target))
    ? await git(deps, repo, ["rev-parse", target])
    : null;
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
    }
  }
  const baseSha = remoteBaseSha
    ? await git(deps, repo, ["merge-base", target, "HEAD"])
    : EMPTY_TREE_SHA;
  return { baseSha, remoteBaseSha };
}

// ── Step 3: проверки проекта ───────────────────────────────────────────

async function runProjectChecks(
  deps: ReleaseDeps,
  repo: string,
  checks: readonly string[],
): Promise<void> {
  for (const check of checks) {
    const res = await deps.cmd.run("sh", ["-c", check], {
      cwd: repo,
      timeoutMs: CHECK_TIMEOUT_MS,
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

/** The plugin's own hook source — `hooks/pre-push` next to `src/`. */
const PLUGIN_HOOK = fileURLToPath(
  new URL("../hooks/pre-push", import.meta.url),
);

/**
 * §16.6 (PLUG-189): a plugin update changes the hook but the installed
 * copy in `hooksDir` does not follow — a stale hook may reject every
 * push («no marker» for the new token file names). Release compares the
 * installed hook byte-for-byte with the plugin's and refuses early with
 * a reinstall hint. A missing hook is not an error: the gate is a
 * forgetfulness guard, an absent guard simply does not fire.
 */
function assertInstalledHookFresh(deps: ReleaseDeps): void {
  let installed: Buffer;
  let current: Buffer;
  try {
    installed = readFileSync(join(deps.hooksDir(), "pre-push"));
  } catch {
    return;
  }
  try {
    current = readFileSync(PLUGIN_HOOK);
  } catch {
    return; // plugin source unreadable — nothing to compare against
  }
  if (!installed.equals(current)) {
    throw new OrchestratorError(
      "hook-stale",
      "установленный общий pre-push хук устарел — версия плагина новее",
      `переустановите хук: node ${join(
        fileURLToPath(new URL("..", import.meta.url)),
        "hooks",
        "install.mjs",
      )}`,
    );
  }
}

// ── Notify / comment helpers ───────────────────────────────────────────

async function notifyCoordinator(
  deps: ReleaseDeps,
  row: ReleaseRow,
  text: string,
): Promise<void> {
  try {
    await deps.threads.send({
      threadId: row.coordinator_thread_id,
      mode: "queue-if-active",
      input: [{ type: "text", text: `[orchestrator] ${text}`, mentions: [] }],
    });
  } catch (e) {
    deps.log?.warn?.(`orchestrator: release notify: ${message(e)}`);
  }
}

async function commentOnTask(
  deps: ReleaseDeps,
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

const report = async (
  deps: ReleaseDeps,
  row: ReleaseRow,
  text: string,
) => {
  await notifyCoordinator(deps, row, text);
  await commentOnTask(deps, row.task_key, text);
};

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
  const { taskKey, title, executor, project } = await acceptTask(input, deps);
  if (project.excluded) {
    throw new OrchestratorError(
      "release-excluded",
      `проект ${executor.project_id ?? input.caller.projectId} исключён из release (excluded: true)`,
    );
  }
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
  }
  // §16.6 (PLUG-189): a merged result publishes from the COORDINATOR's
  // copy — under the same per-copy lock `merge` takes (§14 check 4: one
  // merge/release per copy at a time), with the busy/clean checks BEFORE
  // `git switch` and the copy restored to its original branch in
  // `finally`. The executor's own worktree needs no lock.
  const coordinatorCopy = executor.merge_status === "merged";
  if (!coordinatorCopy) {
    const onBranch = await git(
      deps,
      repo,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { allowFail: true },
    );
    if (onBranch !== branch) {
      await git(deps, repo, ["switch", branch]);
    }
    return runReleaseSteps(
      {
        taskKey,
        title,
        executor,
        project,
        repo,
        branch,
        policyLoad: policyLoad as PolicyLoad & { policy: Policy },
      },
      input,
      deps,
    );
  }
  const mgit: MergeGit = (args, opts) =>
    deps.cmd.run("git", ["-C", repo, ...args], {
      timeoutMs: opts?.timeoutMs ?? 120_000,
    });
  const gitDir = await git(deps, repo, ["rev-parse", "--absolute-git-dir"]);
  const lockPath = join(gitDir, MERGE_LOCK_NAME);
  const releaseLock = await acquireCopyLock(mgit, repo, lockPath);
  let copyToRestore: { branch: string; head: string | null } | null = null;
  try {
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
    recordLockState(lockPath, currentBranch, originalHead);
    // When the copy already sits on the published branch its tip
    // legitimately advances (the sync merge is real work) — then the
    // restore checks branch+clean only (`restoreCopy` head=null).
    copyToRestore = {
      branch: currentBranch,
      head: currentBranch === branch ? null : originalHead,
    };
    if (currentBranch !== branch) {
      await git(deps, repo, ["switch", branch]);
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
  },
  input: ReleaseInput,
  deps: ReleaseDeps,
): Promise<ReleaseResult> {
  const { taskKey, title, executor, project, repo, branch, policyLoad } = ctx;

  // Step 2 — sync по режиму проекта.
  const { baseSha, remoteBaseSha } = await syncBranch(
    deps,
    repo,
    branch,
    project,
  );

  // Step 3 — проверки проекта.
  await runProjectChecks(deps, repo, project.checks);

  // §3 --no-docs → Docs-not-needed trailer (before sha capture).
  if (input.noDocs) {
    await applyDocsTrailer(deps, repo, input.noDocs);
  }
  const headSha = await git(deps, repo, ["rev-parse", "HEAD"]);

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

  // Release row + audit packet + dispatch.
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
    });
  } catch (e) {
    if (/UNIQUE constraint/.test(message(e))) {
      throw new OrchestratorError(
        "release-in-progress",
        `по задаче ${taskKey} уже идёт выкладка`,
      );
    }
    throw e;
  }
  deps.store.updateRelease(release.id, {
    headSha,
    remoteBaseSha,
  });

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

  try {
    const route = pickRoute(policyLoad.policy, AUDIT_LEVEL, {
      unavailableRoutes: new Set(policyLoad.unavailableRoutes),
      heldGroups: deps.store.heldGroups(deps.now?.() ?? Date.now()),
    });
    const auditRow = deps.store.insert({
      taskKey,
      projectId: executor.project_id ?? input.caller.projectId,
      coordinatorThreadId: input.caller.threadId,
      level: AUDIT_LEVEL,
      route: route.name,
      preset: route.route.preset,
      provider: route.route.provider,
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
    const res = await dispatchToRoute(
      auditRow,
      { instructions: auditInstructions },
      deps.stepsDeps,
    );
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
    };
  } catch (e) {
    // An explicit dispatch refusal: the audit never started — the release
    // is failed, the task goes back to the coordinator with the reason.
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

/**
 * Driven from the watchdog beats: for every `auditing` release, look at
 * the latest `release-audit` delegation — `done` means the verdict is in
 * the thread journal; a terminal non-done status with no newer active
 * delegation means the chain is exhausted (§3).
 */
export async function pumpReleases(deps: ReleaseDeps): Promise<PumpSummary> {
  const s: PumpSummary = { scanning: 0, published: 0, rejected: 0, failed: 0 };
  for (const row of deps.store.releasesByStatuses(["auditing", "publishing"])) {
    s.scanning++;
    try {
      if (row.status === "auditing") {
        const delegation = deps.store.latestDelegationByTaskAndLevel(
          row.task_key,
          AUDIT_LEVEL,
        );
        if (!delegation || delegation.status === "dispatching" || delegation.status === "running") {
          continue;
        }
        if (delegation.status !== "done") {
          deps.store.updateRelease(row.id, {
            status: "failed",
            error: `аудит завершился исходом ${delegation.status}`,
          });
          s.failed++;
          await report(
            deps,
            row,
            `выкладка ${row.task_key} остановлена: проверяющий агент ` +
              `завершился исходом ${delegation.status} — ` +
              (delegation.status === "cancelled"
                ? "аудит отменён, выкладки нет"
                : `цепочка ${AUDIT_LEVEL} исчерпана, выкладки нет`),
          );
          continue;
        }
        const text = delegation.thread_id
          ? await lastAgentMessage(deps, delegation.thread_id)
          : null;
        const verdict = parseAuditVerdict(text ?? "");
        if (verdict.verdict === "REJECT") {
          deps.store.updateRelease(row.id, {
            status: "rejected",
            error: verdict.unparseable
              ? "ответ аудитора не парсится"
              : "REJECT",
          });
          s.rejected++;
          const list = verdict.findings
            .slice(0, 15)
            .map(
              (f) =>
                `- ${maskSecrets(f.file ?? "?")}${f.line != null ? `:${f.line}` : ""} ` +
                `${maskSecrets(f.category ?? "")}: ${maskSecrets(f.problem ?? "")}` +
                (f.fix ? ` → ${maskSecrets(f.fix)}` : ""),
            )
            .join("\n");
          await report(
            deps,
            row,
            `аудит выкладки ${row.task_key}: REJECT` +
              (verdict.unparseable ? " (ответ не парсится)" : "") +
              `\n${list || "- без находок в ответе"}`,
          );
          continue;
        }
        deps.store.updateRelease(row.id, { status: "publishing" });
      }
      // publishing (fresh or a retry after a crash mid-publish).
      await publishRelease(deps, deps.store.getRelease(row.id) ?? row, s);
    } catch (e) {
      deps.store.updateRelease(row.id, {
        status: "failed",
        error: message(e).slice(0, 400),
      });
      s.failed++;
      await report(
        deps,
        row,
        `выкладка ${row.task_key} упала на публикации: ${message(e)}`,
      );
    }
  }
  return s;
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
 * line CI/CD relies on). */
function projectThreadIds(deps: ReleaseDeps, projectId: string): boolean {
  const cfg = deps.loadReleaseConfig();
  if (!cfg.config) return true;
  return resolveProject(cfg.config, projectId).threadIds;
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
    await postCheck(deps, row, headSha, row.target_branch, null);
    deps.store.updateRelease(row.id, { status: "published" });
    s.published++;
    await commentOnTask(
      deps,
      row.task_key,
      `выложено: ${headSha.slice(0, 10)} в ${row.target_branch}` +
        (row.kb_note ? `\nKB-заметка: ${row.kb_note}` : "") +
        (row.no_kb_reason ? `\nKB не требуется: ${row.no_kb_reason}` : ""),
    );
    return;
  }

  // action=pr — §16.6 `threadIds`: the «Источник: bb тред thr_…» line is
  // written only while the project allows thread ids. With it off the
  // local executor branch name (`bb/<key>-…-thr_…`) must not reach the
  // remote either — the published branch is a neutral `release/<sha7>`,
  // and the PR body carries neither «Источник» nor «Задача: <KEY>».
  const threadIds = projectThreadIds(deps, row.project_id);
  const remoteBranch = threadIds
    ? row.branch
    : `release/${headSha.slice(0, 7)}`;
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
  deps.store.updateRelease(row.id, { publishedSha: headSha });
  let prUrl = existing?.url ?? null;
  if (!existing) {
    const task = await runJson<TaskShow>(deps.bbCli, [
      "tasks",
      "show",
      row.task_key,
      "--json",
    ]).catch(() => null);
    const title = task?.task?.title ?? row.task_key;
    const created = await ghJson<{ url?: string }>(deps, repo, [
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
    prUrl = created.url ?? null;
  }
  deps.store.updateRelease(row.id, { prUrl });
  await runChecked(deps.bbCli, [
    "tasks",
    "update",
    row.task_key,
    "--status",
    "in_review",
  ]).catch((e) => deps.log?.warn?.(`release task status: ${message(e)}`));
  await postCheck(deps, row, headSha, remoteBranch, prUrl);
  deps.store.updateRelease(row.id, { status: "published" });
  s.published++;
  await commentOnTask(
    deps,
    row.task_key,
    `выложено: ${headSha.slice(0, 10)}, ветка ${remoteBranch}` +
      (prUrl ? ` / PR ${prUrl}` : "") +
      (row.kb_note ? `\nKB-заметка: ${row.kb_note}` : "") +
      (row.no_kb_reason ? `\nKB не требуется: ${row.no_kb_reason}` : ""),
  );
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
): Promise<void> {
  row = deps.store.getRelease(row.id) ?? row;
  const repo = row.repo_path;
  try {
    await git(deps, repo, ["fetch", "origin"], { timeoutMs: 180_000 });
  } catch (e) {
    await notifyCoordinator(
      deps,
      row,
      `пост-проверка ${row.task_key}: fetch не удался — ${message(e)}`,
    );
    return;
  }
  const messages: string[] = [];

  if (row.target_action === "push") {
    const target = `origin/${row.target_branch}`;
    // What landed between the recorded remote base and now — every sha
    // that is neither ours nor another release's is «выложено в обход».
    const base = row.remote_base_sha ?? null;
    if (base && base !== ZERO_SHA) {
      const extra = await git(deps, repo, [
        "rev-list",
        `${base}..${target}`,
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
  if (scanBase && scanBase !== pushedSha) {
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
      const leaks = { machine: "block" as const, bbIds: "block" as const, allow: [] };
      const findings = await machineScan(deps.cmd, {
        repoPath: repo,
        baseSha: scanBase,
        headSha: pushedSha,
        commits,
        added,
        patches,
        leaks,
        hostname: deps.hostname ?? osHostname(),
        threadIds: projectThreadIds(deps, row.project_id),
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

  if (messages.length) {
    await notifyCoordinator(
      deps,
      row,
      `пост-проверка ${row.task_key}:\n${messages.join("\n")}`,
    );
  }
}
