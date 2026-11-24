/**
 * §13.5/§16.9 (r34.8, PLUG-392, ADR-0024): the coordinator worktree
 * lifecycle — registration of the durable env binding and the archive
 * admission check. BB itself has no env-removal veto for plugins
 * (§16.4 п.7; the only `experimental_hooks` decision is
 * `message.dispatch`), so the binding state is what every plugin-side
 * cleanup honours until BB grows the §16.9 п.2 hook.
 *
 * Retention on archive: the bound thread's archive opens a new
 * `archive_pending` decision generation; the admission check then
 * writes either `held` with a §16.9 п.3 reason or `remove_pending`
 * (admission granted — BB does the env removal itself). An unarchive
 * — or a newer check — bumps the generation and discards any verdict
 * written for the old one (CAS in `decide`), which is what makes
 * «разархивация отменяет уборку» true after a restart too.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { T_RU, type T } from "./i18n/index.js";
import type { CmdRunner } from "./cmd.js";
import { OrchestratorError } from "./errors.js";
import type { JanitorLog } from "./janitor.js";
import type {
  CoordinatorWorktreeBind,
  CoordinatorWorktreeRow,
  CoordinatorWorktreeStore,
} from "./store.js";

export interface CoordinatorThreadDto {
  id: string;
  environmentId?: string | null;
  projectId?: string | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
}

export interface CoordinatorEnvDto {
  id: string;
  projectId?: string | null;
  hostId?: string | null;
  path?: string | null;
  branchName?: string | null;
  mergeBaseBranch?: string | null;
  status?: string | null;
  environmentProviderId?: string | null;
  managed?: boolean;
  lifecycle?: { phase?: string | null } | null;
}

export interface CoordinatorWorktreesDeps {
  store: CoordinatorWorktreeStore;
  /** thread_roles lookup — §16.9 п.1 protects envs with a live
   * coordinator-role thread even before a binding exists. */
  threadRole(threadId: string): { role: string } | undefined;
  cmd: CmdRunner;
  /**
   * `bb environment show <id>` — `null` only when the env is
   * definitively gone; a transient lookup failure THROWS so callers
   * can keep the property instead of writing `env-removed` (§7:
   * «при ошибке разрешения среды имущество сохраняется»).
   */
  showEnvironment(envId: string): Promise<CoordinatorEnvDto | null>;
  /**
   * §13.5 п.2: the delegation index (`store.delegationTaskIndex`) —
   * an env serving a delegation is an executor round and can never
   * register as a coordinator integration copy. Needed here because
   * `result_env_id` lands only at round end: while a round is
   * `dispatching`/`running` the executor's own thread id and the env's
   * live threads are the only markers (`coordinator-worktree-required`).
   */
  delegationIndex?(): {
    threadId: string | null;
    envId: string | null;
    status: string;
  }[];
  /**
   * `bb thread show` — resolves the env of a thread when the event
   * payload did not carry one (`message.dispatched` ships only ids).
   */
  showThread?(threadId: string): Promise<CoordinatorThreadDto | null>;
  /** Live+archived threads of one env; `null` = cannot prove. */
  listEnvThreads(envId: string): Promise<CoordinatorThreadDto[] | null>;
  hasProcessIn?: (path: string) => Promise<boolean | null>;
  now?: () => number;
  log?: JanitorLog;
}

/** §16.9 п.2: expendable build artifacts — matched in ANY path
 * segment (`plugins/x/node_modules/` is expendable too); anything
 * else ignored is `untracked-ignored`. */
const EXPENDABLE_IGNORED =
  /(?:^|\/)(?:dist|node_modules|coverage|\.cache)(?:\/|$)/;
const UNFINISHED_OPS = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];
/** §16.3/§16.9 п.2: in-flight operations whose state lives as files
 * in the worktree's git dir, not as refs (`--verify` cannot see a
 * mid-`git bisect` or `rebase -i` run). */
const UNFINISHED_OP_PATHS = [
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * §7/§16.9: the `bb environment show <id> --json` verdict. `gone` is
 * ONLY the structured BB answer — exit 1 with
 * `{"ok":false,"error":{"code":"environment_not_found"}}` in stdout.
 * Any other failure (a missing bb binary — exit 127 «bb CLI not
 * found», another exit code, another error code, non-JSON text) is
 * transient: it must read as «cannot prove», never «env removed» —
 * `env-removed` has no way back.
 */
export function environmentShowVerdict(res: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): "ok" | "gone" | "failed" {
  if (res.exitCode === 0) return "ok";
  if (res.exitCode === 1) {
    try {
      const body = JSON.parse(res.stdout) as {
        error?: { code?: string };
      } | null;
      if (body?.error?.code === "environment_not_found") {
        return "gone";
      }
    } catch {
      // Not the structured answer — falls through to «failed».
    }
  }
  return "failed";
}

/**
 * §7/§16.9: the `bb environment show <id> --json` verdict — `gone` is
 * ONLY the structured BB answer — see `environmentShowVerdict` above.
 * §13.5: an env is gone once BB reports it destroyed or a teardown phase
 * owns it.
 */
const envGone = (env: CoordinatorEnvDto | null): boolean => {
  if (!env) return true;
  if (env.status === "destroyed") return true;
  const phase = env.lifecycle?.phase;
  return phase === "teardown" || phase === "destroyed";
};

export function createCoordinatorWorktrees(deps: CoordinatorWorktreesDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? {};

  const gitOut = async (
    cwd: string,
    args: string[],
  ): Promise<string | null> => {
    const res = await deps.cmd.run("git", ["-C", cwd, ...args], {
      timeoutMs: 60_000,
    });
    return res.exitCode === 0 ? res.stdout : null;
  };
  const gitOk = async (cwd: string, args: string[]): Promise<boolean> => {
    const res = await deps.cmd.run("git", ["-C", cwd, ...args], {
      timeoutMs: 60_000,
    });
    return res.exitCode === 0;
  };

  const isCoordinatorThread = (threadId: string): boolean =>
    deps.threadRole(threadId)?.role === "orchestrator";

  /**
   * §13.5 п.2: «is this env an executor-round env?» — three proofs.
   * 1. A recorded `result_env_id` of any delegation.
   * 2. The registering thread IS the executor of a round that is live
   *    (`dispatching`/`running` — `result_env_id` lands only at round
   *    end) or never had its env recorded; a promoted executor
   *    mid-round is refused exactly like its env.
   * 3. An env shared with a LIVE delegation thread — while the round
   *    runs, its env appears only through the thread itself.
   * A round already `done` with a recorded env refuses only by env
   * match, so an executor moved to a dedicated worktree afterwards
   * can still register. An unprovable env-thread list reads as «no
   * hit»: refusal is for proven executor envs, not suspicion.
   */
  const isDelegationEnv = async (
    envId: string,
    threadId?: string,
  ): Promise<boolean> => {
    const index = deps.delegationIndex?.() ?? [];
    const liveThreadIds = new Set<string>();
    for (const d of index) {
      if (d.envId != null && d.envId === envId) return true;
      if (
        threadId != null &&
        d.threadId === threadId &&
        (d.status === "dispatching" ||
          d.status === "running" ||
          d.envId == null)
      ) {
        return true;
      }
      if (
        d.threadId != null &&
        (d.status === "dispatching" || d.status === "running")
      ) {
        liveThreadIds.add(d.threadId);
      }
    }
    if (liveThreadIds.size === 0) return false;
    const envThreads = await deps.listEnvThreads(envId);
    return (
      envThreads?.some(
        (x) => !x.archivedAt && !x.deletedAt && liveThreadIds.has(x.id),
      ) ?? false
    );
  };

  /**
   * §13.5 п.2: `git fetch origin <target>` then require
   * `git log origin/<target>..<base_sha>` to be empty — a base the
   * local repo is ahead of is `base-unpublished`. The target defaults
   * to `origin/HEAD` when the caller did not pin one.
   */
  const checkBasePublished = async (
    worktreePath: string,
    baseSha: string,
    targetBranch?: string,
  ): Promise<void> => {
    const target =
      targetBranch ??
      (await gitOut(worktreePath, [
        "rev-parse",
        "--abbrev-ref",
        "refs/remotes/origin/HEAD",
      ]))?.trim().replace(/^origin\//, "");
    if (!target) return; // no remote HEAD — the check proves nothing
    if (!(await gitOk(worktreePath, ["fetch", "origin", "--", target]))) {
      throw new OrchestratorError(
        "remote-unavailable",
        `git fetch origin ${target} failed in ${worktreePath}`,
      );
    }
    const ahead = await gitOut(worktreePath, [
      "log",
      "--format=%H",
      "--end-of-options",
      `origin/${target}..${baseSha}`,
    ]);
    if (ahead === null) {
      throw new OrchestratorError(
        "remote-unavailable",
        `git log origin/${target}..${baseSha} failed in ${worktreePath}`,
      );
    }
    if (ahead.trim().length > 0) {
      throw new OrchestratorError(
        "base-unpublished",
        `локальная база опережает origin/${target}; ` +
          `создай копию от опубликованного коммита origin/${target}`,
      );
    }
  };

  /** §13.5 п.1-2: register the binding — see the store for rebind rules. */
  const register = async (
    bind: CoordinatorWorktreeBind,
    opts?: { targetBranch?: string; skipBaseCheck?: boolean },
  ): Promise<CoordinatorWorktreeRow> => {
    if (!opts?.skipBaseCheck && bind.baseSha && bind.worktreePath) {
      await checkBasePublished(
        bind.worktreePath,
        bind.baseSha,
        opts?.targetBranch,
      );
    }
    return deps.store.register(bind, now());
  };

  /**
   * §13.5 п.2: the env's actual base — the position of the branch's
   * «branch: Created from <sha>» reflog entry (newest → oldest, the
   * latest (re)creation point), like `countOwnCommits` in janitor.
   * `null` when the reflog holds no creation entry.
   */
  const createdFromBase = async (
    worktreePath: string,
    branch: string,
  ): Promise<string | null> => {
    const reflog = await gitOut(worktreePath, [
      "log",
      "-g",
      "--format=%H%x00%gs",
      `refs/heads/${branch}`,
    ]);
    if (reflog === null) return null;
    for (const line of reflog.split("\n")) {
      const sep = line.indexOf("\0");
      if (sep < 0) continue;
      if (/^branch: Created from\b/.test(line.slice(sep + 1))) {
        return line.slice(0, sep);
      }
    }
    return null;
  };

  /**
   * §13.5 п.1: lazy registration for a chat-created coordinator thread.
   * Only `thread_roles.role = 'orchestrator'` qualifies; the env must be
   * a provisioned managed worktree (path + branch resolved) that is NOT
   * an executor-round env. Async — never inside the synchronous
   * `message.dispatch` pass. Returns the row when a binding exists/was
   * created, else `null` (retried on the next event).
   */
  const ensureBinding = async (thread: {
    id: string;
    environmentId?: string | null;
    projectId?: string | null;
  }): Promise<CoordinatorWorktreeRow | null> => {
    const existing = deps.store.liveByThread(thread.id);
    if (existing) return existing;
    if (!isCoordinatorThread(thread.id)) return null;
    let environmentId = thread.environmentId;
    let projectId = thread.projectId;
    if (environmentId === undefined && deps.showThread) {
      const t = await deps.showThread(thread.id);
      environmentId = t?.environmentId;
      projectId = projectId ?? t?.projectId;
    }
    if (!environmentId) return null;
    // §13.5 п.2: an env already serving a delegation is an executor
    // round — a promoted coordinator needs a dedicated Worktree, so
    // registration refuses it (coordinator-worktree-required).
    if (await isDelegationEnv(environmentId, thread.id)) {
      log.warn?.(
        `orchestrator worktrees: thread ${thread.id} — ` +
          `coordinator-worktree-required: env ${environmentId} is a ` +
          `delegation round env; create a dedicated Worktree`,
      );
      return null;
    }
    let env: CoordinatorEnvDto | null;
    try {
      env = await deps.showEnvironment(environmentId);
    } catch (e) {
      // Transient resolution failure — property stays, retry later.
      log.warn?.(
        `orchestrator worktrees: showEnvironment ${environmentId}: ` +
          message(e),
      );
      return null;
    }
    if (!env || envGone(env)) return null;
    if (
      env.managed !== true ||
      env.status !== "ready" ||
      !env.path ||
      !env.branchName
    ) {
      // Still provisioning — retried on the next event or operation.
      return null;
    }
    projectId = projectId ?? env.projectId ?? null;
    if (!projectId) return null;
    const repoRoot = (
      await gitOut(env.path, ["rev-parse", "--git-common-dir"])
    )?.trim();
    if (!repoRoot) return null;
    // §13.5 п.2: the base is what the env was actually created from —
    // the reflog «Created from» entry, else the merge-base of HEAD
    // with origin/<target> (the real fork point; the CURRENT remote
    // tip is not proof of the creation base). Always on origin by
    // construction, so the publish check then proves nothing but
    // stays harmless; `null` when neither resolves.
    const createdFrom = await createdFromBase(env.path, env.branchName);
    const targetBranch = env.mergeBaseBranch?.replace(/^origin\//, "");
    const baseSha =
      createdFrom ??
      (await gitOut(env.path, [
        "merge-base",
        "HEAD",
        targetBranch ? `origin/${targetBranch}` : "origin/HEAD",
      ]))?.trim();
    const tipSha = (
      await gitOut(env.path, ["rev-parse", "--verify", "HEAD"])
    )?.trim();
    try {
      const row = await register(
        {
          projectId,
          coordinatorThreadId: thread.id,
          envId: env.id,
          hostId: env.hostId ?? null,
          repoRoot,
          worktreePath: env.path,
          branch: env.branchName,
          baseSha: baseSha ?? null,
          tipSha: tipSha ?? null,
        },
        { targetBranch },
      );
      log.info?.(
        `orchestrator worktrees: bound thread ${thread.id} ` +
          `to env ${env.id} (${env.branchName})`,
      );
      return row;
    } catch (e) {
      log.warn?.(
        `orchestrator worktrees: bind ${thread.id}→${env.id}: ${message(e)}`,
      );
      return null;
    }
  };

  type Admission =
    | { verdict: "remove_pending"; tipSha: string | null }
    | { verdict: "held"; reason: string; tipSha?: string | null }
    | { verdict: "pending" }; // unproven — stays archive_pending

  /**
   * §16.9 п.2: the pre-removal admission. Order mirrors the spec —
   * live threads, processes, clean tree/index, §16.3 commit safety.
   * The commit check covers EVERY position §16.3 lists — the whole
   * reflog of HEAD (a detached-HEAD or `reset`-orphaned commit lives
   * only there) and of the bound branch, their current tips, and the
   * copy-scoped `refs/worktree/*` / `refs/bisect/*` — `rev-list
   * <positions> --not --remotes=origin`. Ancestry-only for now:
   * patch-id equivalence is a later stage, so a squash/rebase-merged
   * copy conservatively stays `unpushed-commits` — as §16.9 п.2
   * prescribes for the current stage.
   */
  const evaluate = async (
    binding: CoordinatorWorktreeRow,
  ): Promise<Admission> => {
    let env: CoordinatorEnvDto | null;
    try {
      env = await deps.showEnvironment(binding.env_id);
    } catch {
      // «не найдено» is `null` — anything else proves nothing (§7).
      return { verdict: "pending" };
    }
    if (envGone(env)) {
      return { verdict: "held", reason: "env-removed" };
    }
    const threads = await deps.listEnvThreads(binding.env_id);
    if (threads === null) return { verdict: "pending" };
    const live = threads.filter((x) => !x.archivedAt && !x.deletedAt);
    if (live.some((x) => isCoordinatorThread(x.id))) {
      return { verdict: "held", reason: "coordinator-live" };
    }
    if (live.length > 0) {
      // A non-coordinator live thread holds the env physically — the
      // decision waits for its own archive/delete event.
      return { verdict: "pending" };
    }
    const path = binding.worktree_path ?? env?.path ?? null;
    if (!path || !existsSync(path)) {
      return { verdict: "held", reason: "env-removed" };
    }
    const proc = deps.hasProcessIn
      ? await deps.hasProcessIn(path)
      : null;
    if (proc === true) return { verdict: "held", reason: "active-processes" };
    if (proc === null) return { verdict: "pending" };
    for (const ref of UNFINISHED_OPS) {
      if (
        await gitOk(path, ["rev-parse", "--verify", "--quiet", ref])
      ) {
        return { verdict: "held", reason: "dirty-worktree" };
      }
    }
    for (const name of UNFINISHED_OP_PATHS) {
      const p = (
        await gitOut(path, ["rev-parse", "--git-path", name])
      )?.trim();
      if (!p) return { verdict: "pending" };
      if (existsSync(isAbsolute(p) ? p : join(path, p))) {
        return { verdict: "held", reason: "dirty-worktree" };
      }
    }
    const status = await gitOut(path, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--ignored=matching",
    ]);
    if (status === null) return { verdict: "pending" };
    let dirty = false;
    let strayIgnored = false;
    for (const line of status.split("\n")) {
      if (!line) continue;
      if (line.startsWith("!!")) {
        if (!EXPENDABLE_IGNORED.test(line.slice(3).trim())) {
          strayIgnored = true;
        }
        continue;
      }
      dirty = true;
    }
    if (dirty) return { verdict: "held", reason: "dirty-worktree" };
    if (strayIgnored) {
      return { verdict: "held", reason: "untracked-ignored" };
    }
    const tipSha = binding.branch
      ? (await gitOut(path, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${binding.branch}`,
        ]))?.trim() ?? null
      : (await gitOut(path, ["rev-parse", "--verify", "HEAD"]))?.trim() ??
        null;
    if (!(await gitOk(path, ["fetch", "origin"]))) {
      return { verdict: "held", reason: "remote-unavailable", tipSha };
    }
    // §16.3 «ничего не теряется»: positions = whole reflog of HEAD and
    // of the bound branch plus their tips and the copy-scoped refs —
    // a commit surviving only in a reflog (reset --hard, amend,
    // detached HEAD) must hold the copy exactly like a tip commit.
    const refs = ["HEAD"];
    if (binding.branch) {
      const ref = `refs/heads/${binding.branch}`;
      if (
        await gitOk(path, ["rev-parse", "--verify", "--quiet", ref])
      ) {
        refs.push(ref);
      }
      // A bound branch already deleted has no positions left to
      // protect — its recorded tip_sha still gates §16.9 п.4.
    }
    const extra = await gitOut(path, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/worktree/",
      "refs/bisect/",
    ]);
    if (extra === null) return { verdict: "pending" };
    for (const r of extra
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      if (!refs.includes(r)) refs.push(r);
    }
    const positions = new Set<string>();
    for (const ref of refs) {
      const log = await gitOut(path, [
        "log",
        "-g",
        "--format=%H",
        ref,
      ]);
      if (log === null) return { verdict: "pending" };
      for (const l of log.split("\n")) {
        const s = l.trim();
        if (s) positions.add(s);
      }
      // The tip is a position of its own (PLUG-198): its reflog entry
      // may be expired or never recorded.
      const tip = (
        await gitOut(path, [
          "rev-parse",
          "--verify",
          "--quiet",
          ref,
        ])
      )?.trim();
      if (!tip) return { verdict: "pending" };
      positions.add(tip);
    }
    const unconfirmed = await gitOut(path, [
      "rev-list",
      "--count",
      ...positions,
      "--not",
      "--remotes=origin",
    ]);
    if (unconfirmed === null) {
      return { verdict: "pending" };
    }
    if (Number(unconfirmed.trim()) > 0) {
      return { verdict: "held", reason: "unpushed-commits", tipSha };
    }
    return { verdict: "remove_pending", tipSha };
  };

  /**
   * Open a new decision generation and evaluate it. A verdict is
   * applied only when the generation still matches — an unarchive or
   * a fresher check supersedes it (§7 decision_generation).
   */
  const reevaluate = async (binding: CoordinatorWorktreeRow): Promise<void> => {
    const generation = deps.store.beginDecision(
      binding.id,
      "archive_pending",
      now(),
    );
    if (generation === null) return;
    const admission = await evaluate({ ...binding, decision_generation: generation });
    const at = now();
    if (admission.verdict === "remove_pending") {
      deps.store.decide(
        binding.id,
        generation,
        "remove_pending",
        null,
        at,
        admission.tipSha,
      );
      return;
    }
    if (admission.verdict === "held") {
      deps.store.decide(
        binding.id,
        generation,
        admission.reason === "env-removed" ? "env-removed" : "held",
        admission.reason === "env-removed" ? null : admission.reason,
        at,
        admission.tipSha,
      );
      return;
    }
    // pending — stays archive_pending under the open generation.
  };

  /**
   * §16.9 п.2/п.4: a coordinator thread's archive (or delete) starts
   * the admission check of its bound env. The same env's other
   * bindings are re-evaluated too — a sharing thread leaving can be
   * what unblocks them.
   */
  const onThreadGone = async (
    thread: CoordinatorThreadDto,
    _cause: "archived" | "deleted",
  ): Promise<void> => {
    let own = deps.store.byThread(thread.id);
    if (!own && isCoordinatorThread(thread.id)) {
      own = (await ensureBinding(thread)) ?? undefined;
    }
    const seen = new Set<number>();
    const rows = [own, ...(thread.environmentId ? [deps.store.byEnv(thread.environmentId)] : [])];
    for (const b of rows) {
      if (b && b.state !== "removed" && !seen.has(b.id)) {
        seen.add(b.id);
        await reevaluate(b);
      }
    }
  };

  const onThreadArchived = (thread: CoordinatorThreadDto) =>
    onThreadGone(thread, "archived");
  const onThreadDeleted = (thread: CoordinatorThreadDto) =>
    onThreadGone(thread, "deleted");

  /** §16.9 п.3: unarchive before removal cancels the admission —
   * the binding goes back to `active` under a new generation. A copy
   * already gone stays `env-removed`: reviving it would return a dead
   * binding from `ensureBinding` («возврат после уже завершённой
   * уборки требует новой копии»). */
  const onThreadUnarchived = async (
    thread: CoordinatorThreadDto,
  ): Promise<void> => {
    const b = deps.store.byThread(thread.id);
    if (!b || b.state === "removed" || b.state === "env-removed") return;
    if (b.state === "remove_pending") {
      // BB may have already retired the env — prove it lives before
      // reviving the binding.
      let env: CoordinatorEnvDto | null;
      try {
        env = await deps.showEnvironment(b.env_id);
      } catch {
        // Resolution failed — keep the property, retry on the next
        // event (§7).
        deps.store.setState(b.id, "held", "remote-unavailable", now());
        return;
      }
      if (envGone(env)) {
        deps.store.setState(b.id, "env-removed", null, now());
        return;
      }
    }
    deps.store.beginDecision(b.id, "active", now());
    deps.store.setState(b.id, "active", "coordinator-live", now());
  };

  /**
   * Lazy registration triggers (§13.5 п.1): `thread.active` and
   * `message.dispatched` — async, never the synchronous dispatch pass.
   */
  const onThreadActive = async (thread: {
    id: string;
    environmentId?: string | null;
    projectId?: string | null;
  }): Promise<void> => {
    await ensureBinding(thread);
  };

  /**
   * Reconcile bindings against the envs BB still reports — a vanished
   * env closes the binding `env-removed` (its branch stays protected
   * until the binding reaches `removed`, §7).
   */
  const reconcileEnvGone = (envIds: Set<string>): void => {
    for (const b of deps.store.envBindings()) {
      if (!envIds.has(b.env_id)) {
        deps.store.setState(b.id, "env-removed", null, now());
      }
    }
  };

  return {
    register,
    ensureBinding,
    onThreadActive,
    onThreadArchived,
    onThreadDeleted,
    onThreadUnarchived,
    reevaluate,
    reconcileEnvGone,
    isCoordinatorThread,
  };
}

// ── §13.5 п.1 (PLUG-406): `worktree create` — a fresh coordinator thread
// on a dedicated BB Worktree, provisioned, then bound (§7 → `active`).
const DEFAULT_PROVISION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** The managed-worktree spawn of the new coordinator thread — the
 * base is the immutable named SHA of the fresh `origin/<target>`
 * (`--base-branch <полный SHA свежего origin/<target>>`), the title
 * `coordinator` (§13.5: `bb/coordinator-<threadId>`). */
export interface CoordinatorWorktreeSpawnArgs {
  projectId: string;
  title: string;
  prompt: string;
  environment: {
    type: "host";
    hostId: string;
    workspace: {
      type: "managed-worktree";
      baseBranch: { kind: "named"; name: string };
    };
  };
}

export interface CoordinatorWorktreeCreateDeps {
  /** The bb project the new coordinator copy is created in. */
  projectId: string;
  /** The fresh published base — full SHA of `origin/<target>`. */
  baseSha: string;
  /**
   * §13.5: the published target branch the fresh base came from — the
   * `--target` flag, else the release-config target, else `main`. The
   * binding registers against THIS branch (`base-unpublished` compares
   * the copy with `origin/<target>` of it).
   */
  targetBranch?: string;
  /** Spawn seam — the SDK `threads.spawn` (managed-worktree env). */
  spawn: (
    args: CoordinatorWorktreeSpawnArgs,
  ) => Promise<{ id?: string | null; environmentId?: string | null }>;
  /** `bb environment show <id> --json` — `null` only when gone. */
  showEnvironment: (envId: string) => Promise<CoordinatorEnvDto | null>;
  /** §7 binding registration — writes the `active` row. */
  register: (
    bind: CoordinatorWorktreeBind,
    opts?: { targetBranch?: string; skipBaseCheck?: boolean },
  ) => Promise<CoordinatorWorktreeRow>;
  /** git seam — resolves the copy's repo root; absent → skipped. */
  cmd?: CmdRunner;
  /** The host the managed worktree is provisioned on. */
  hostId?: string;
  /** The seed prompt of the coordinator thread. */
  prompt?: string;
  /** Clock for tests. */
  now?: () => number;
  /** Provisioning wait budget in ms. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  log?: JanitorLog;
  t?: T;
}

export interface CoordinatorWorktreeCreateResult {
  threadId: string;
  envId: string;
  branch: string;
  worktreePath: string;
  baseSha: string;
}

/**
 * §13.5 п.1 (PLUG-406): `bb orchestrator worktree create` — spawn a new
 * coordinator thread on a dedicated BB Worktree, wait for the
 * provisioning to finish, register the binding (`active`). The copy is
 * based on the fresh `origin/<target>` SHA; a base the local repo is
 * ahead of refuses `base-unpublished` at registration.
 */
export async function createCoordinatorWorktree(
  deps: CoordinatorWorktreeCreateDeps,
): Promise<CoordinatorWorktreeCreateResult> {
  const t = deps.t ?? T_RU;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!deps.baseSha) {
    throw new OrchestratorError(
      "invalid-arguments",
      t("wt.baseMissing", { project: deps.projectId }),
      t("wt.baseMissingHint"),
    );
  }
  if (!deps.spawn) {
    throw new OrchestratorError(
      "invalid-arguments",
      t("wt.spawnMissing", { project: deps.projectId }),
    );
  }
  const spawned = await deps.spawn({
    projectId: deps.projectId,
    title: "coordinator",
    prompt: deps.prompt ?? "",
    environment: {
      type: "host",
      hostId: deps.hostId ?? "",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: deps.baseSha },
      },
    },
  });
  const threadId = spawned?.id ?? null;
  const envId = spawned?.environmentId ?? null;
  if (!threadId || !envId) {
    throw new OrchestratorError(
      "spawn-failed",
      t("wt.spawnNoThread", { threadId: threadId ?? "" }),
      t("wt.spawnNoThreadHint"),
    );
  }
  const deadline = now() + timeoutMs;
  let env: CoordinatorEnvDto | null | undefined;
  for (;;) {
    let next: CoordinatorEnvDto | null | undefined;
    let transient = false;
    try {
      next = await deps.showEnvironment(envId);
    } catch {
      // §7: a transient `bb environment show` failure keeps the
      // property — retry until the provisioning deadline instead of
      // aborting the wait.
      transient = true;
    }
    env = next;
    if (env) {
      if (env.status === "ready" && env.path && env.branchName) break;
      if (envGone(env)) {
        throw new OrchestratorError(
          "env-gone",
          t("wt.envGone", { envId, threadId }),
          t("wt.envGoneHint"),
          { threadId, envId },
        );
      }
    } else if (!transient) {
      // `null` — the structured BB answer: the env is definitively gone.
      throw new OrchestratorError(
        "env-gone",
        t("wt.envGone", { envId, threadId }),
        t("wt.envGoneHint"),
        { threadId, envId },
      );
    }
    if (now() >= deadline) {
      throw new OrchestratorError(
        "provisioning-timeout",
        t("wt.provisioningTimeout", { envId, threadId, timeoutMs }),
        t("wt.provisioningTimeoutHint"),
        { threadId, envId },
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const path = env!.path!;
  const branch = env!.branchName!;
  const repoRoot = deps.cmd
    ? (
        await deps.cmd.run("git", [
          "-C",
          path,
          "rev-parse",
          "--git-common-dir",
        ])
      ).stdout.trim() || null
    : null;
  const tipSha = deps.cmd
    ? (
        await deps.cmd.run("git", ["-C", path, "rev-parse", "--verify", "HEAD"])
      ).stdout.trim() || null
    : null;
  try {
    await deps.register(
      {
        projectId: deps.projectId,
        coordinatorThreadId: threadId,
        envId,
        hostId: env.hostId ?? null,
        repoRoot: repoRoot ?? null,
        worktreePath: path,
        branch,
        baseSha: deps.baseSha,
        tipSha: tipSha ?? null,
      },
      // The binding registers against the TARGET BRANCH the caller asked
      // for (`--target`, else the release-config target, else `main`) —
      // not the env's recorded merge-base guess.
      { targetBranch: deps.targetBranch },
    );
  } catch (e) {
    // The ids travel with the error — the caller (CLI / `--json`) must be
    // able to see which thread/env the failed round belonged to. A raw
    // failure (e.g. a SQLite error in the store) is wrapped into the same
    // structured error so its `details` survive to the CLI output.
    const err =
      e instanceof OrchestratorError
        ? e
        : new OrchestratorError(
            "internal-error",
            message(e),
            undefined,
            { threadId, envId },
          );
    throw new OrchestratorError(
      err.code,
      err.message,
      err.hint,
      { threadId, envId },
    );
  }
  return {
    threadId,
    envId,
    branch,
    worktreePath: path,
    baseSha: deps.baseSha,
  };
}
