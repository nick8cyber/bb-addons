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
  showEnvironment(envId: string): Promise<CoordinatorEnvDto | null>;
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

/** §16.9 п.2: expendable build artifacts, anything else ignored is
 * `untracked-ignored`. */
const EXPENDABLE_IGNORED = /^(?:dist|node_modules|coverage|\.cache)(?:\/|$)/;
const UNFINISHED_OPS = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

  const envGone = (env: CoordinatorEnvDto | null): boolean => {
    if (!env) return true;
    if (env.status === "destroyed") return true;
    const phase = env.lifecycle?.phase;
    return phase === "teardown" || phase === "destroyed";
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
    if (!(await gitOk(worktreePath, ["fetch", "origin", target]))) {
      throw new OrchestratorError(
        "remote-unavailable",
        `git fetch origin ${target} failed in ${worktreePath}`,
      );
    }
    const ahead = await gitOut(worktreePath, [
      "log",
      "--format=%H",
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
   * §13.5 п.1: lazy registration for a chat-created coordinator thread.
   * Only `thread_roles.role = 'orchestrator'` qualifies; the env must be
   * a provisioned managed worktree (path + branch resolved). Async —
   * never inside the synchronous `message.dispatch` pass. Returns the
   * row when a binding exists/was created, else `null`.
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
    const env = await deps.showEnvironment(environmentId);
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
    const baseSha = env.mergeBaseBranch
      ? (await gitOut(env.path, [
          "merge-base",
          "HEAD",
          env.mergeBaseBranch.startsWith("origin/")
            ? env.mergeBaseBranch
            : `origin/${env.mergeBaseBranch}`,
        ]))?.trim()
      : undefined;
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
        // The merge-base of HEAD vs origin/<target> is on origin by
        // construction — the publish check is meaningful only for a
        // base the caller pins explicitly (§13.5 п.2).
        { skipBaseCheck: true },
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
   * The commit check here is ancestry-only (`rev-list --not
   * --remotes=origin`): patch-id equivalence is a later stage, so a
   * squash/rebase-merged copy conservatively stays `unpushed-commits`
   * — the «kept (squash)» outcome §16.9 п.2 prescribes anyway.
   */
  const evaluate = async (
    binding: CoordinatorWorktreeRow,
  ): Promise<Admission> => {
    const env = await deps.showEnvironment(binding.env_id);
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
    const unconfirmed = await gitOut(path, [
      "rev-list",
      "--count",
      tipSha ?? "HEAD",
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
   * the binding goes back to `active` under a new generation. */
  const onThreadUnarchived = async (
    thread: CoordinatorThreadDto,
  ): Promise<void> => {
    const b = deps.store.byThread(thread.id);
    if (!b || b.state === "removed") return;
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
