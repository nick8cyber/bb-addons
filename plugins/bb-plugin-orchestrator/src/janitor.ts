/**
 * §15/§16 janitor — background cleanup of merged executor copies, their
 * branches and threads (ADR-0024, owner decision 11.11). Removes only
 * what is provably merged on `origin` and clean; unmerged or dirty copies
 * are only reported.
 *
 * §16.3: threads are removed by archiving only (`bb environment cleanup`
 * is never called — BB frees the copy once every thread of the env is
 * archived). Before archiving, the full cascade — children and hidden
 * forks recursively — is built and conditions 1–5 are checked for every
 * env of the cascade; condition 4 covers every non-archived cascade
 * member — including members with no env of their own — and every live
 * thread of those envs (`idle`/`error` only, `queuedWork = none`, no
 * active delegation, no pending request). `scope` picks the
 * candidates: `workers` (default) covers dispatch threads
 * (`originPluginId=tasks`) and threads with a parent; `all` also covers
 * root chats. A `bb/` branch is deleted only on a later run, once its
 * copy no longer exists. Squash/rebase merges get a second mergedness
 * signal — content equality: `git merge-tree --write-tree <target>
 * <sha>` reproducing `<target>^{tree}` proves the merge adds nothing
 * (multi-commit squashes and merge-commit resolution edits included).
 * Own commits are the *reachable* commits of the copy's branch:
 * `rev-list --count <«Created from»>..<tip>` (PLUG-195: strictly from
 * the creation entry — no reflog-type parsing). «Ничего не
 * теряется»: every commit the copy's HEAD or its branch ever pointed
 * at (the whole `git log -g`) is an ancestor of a remote target,
 * patch-equivalent to a commit on it, or carries content already on a
 * target — the `merge-tree` sign checked for EACH reflog commit itself
 * (PLUG-197: «A + revert A» nets to origin, but A's content never
 * reached it — such a copy stays). One that is neither
 * (a `reset`-orphaned or detached commit, an unpublished pre-amend
 * version) keeps the copy (`unpushed-commits`), or reports it once
 * abandoned. The rule is re-run immediately before archiving, and for
 * a copy-less `bb/` branch — over the branch's own reflog before
 * `branch -D` (`branch-unpushed`), since deleting the branch erases it.
 *
 * §16.4: on `thread.archived` of an executor whose copy is still dirty,
 * the state is saved into `refs/orchestrator/rescue/<thr>` (stash object
 * including untracked files via a temporary index and
 * `--pathspec-from-file`) — unconditionally, even with the janitor
 * disabled — and the coordinator gets a restore command into a *new*
 * worktree, plus a line when the snapshot is incomplete. The janitor
 * never deletes refs under `refs/orchestrator/`.
 *
 * «Влитая копия»: the copy's HEAD and the copy's own branch (the env's
 * `branchName`, when it exists and differs from the checked-out one)
 * are ancestors of remote-tracking refs only — `origin/<protected>` or
 * the env's `mergeBaseBranch` resolved under `refs/remotes/origin/` —
 * checked right after this run's successful `git fetch` (a failed
 * fetch skips the whole repository). Local-only merges never count.
 * Other local branches are shared repo-wide and do not belong to the
 * copy — an unmerged foreign branch never blocks a copy's removal.
 */
import {
  existsSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runJson, type BbCli } from "./bb-cli.js";
import type { CmdRunner } from "./cmd.js";
import type { JanitorConfig, JanitorConfigLoad } from "./janitor-config.js";
import type {
  DelegationStore,
  JanitorItemState,
  JanitorRunRow,
  JanitorStore,
} from "./store.js";

const DAY_MS = 24 * 60 * 60_000;
const GIT_TIMEOUT_MS = 30_000;
/**
 * §15 cond 4 (ревизия 25): only `idle`/`error` threads are quiescent.
 * `active`, `pending`, `starting`, `stopping` and every unknown status
 * keep the copy.
 */
const QUIESCENT_THREAD_STATUSES = new Set(["idle", "error"]);
const BRANCH_PREFIX = "bb/";
/**
 * Kept-reasons meaning «could not evaluate», not a real env state —
 * they never clear the announced-abandoned list (§15, PLUG-192): a
 * transient failure must not cause the same env to be announced again.
 */
const TRANSIENT_KEEPS = new Set([
  "fetch-failed",
  "threads-unknown",
  "not-a-repo",
  "missing-path",
  "no-head",
  "status-failed",
  "unfinished-unknown",
  "unpushed-unknown",
  "archive-failed",
  "cascade-env-external",
  "interactions-pending",
]);

export interface JanitorLog {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface JanitorThreads {
  send(args: {
    threadId: string;
    mode: "queue-if-active";
    input: unknown[];
  }): Promise<unknown>;
}

export interface JanitorDeps {
  store: DelegationStore;
  janitor: JanitorStore;
  bbCli: BbCli;
  cmd: CmdRunner;
  threads: JanitorThreads;
  loadConfig(): JanitorConfigLoad | Promise<JanitorConfigLoad>;
  now?: () => number;
  log?: JanitorLog;
  /**
   * §15 cond 5 seam — default scans `/proc/<pid>/cwd` of the current
   * user. `null` means the check cannot prove anything (no `/proc`,
   * e.g. macOS) — the copy is then kept with `process-unknown`.
   */
  hasProcessIn?: (path: string) => Promise<boolean | null>;
  /**
   * §15 «что смотрит»: id of the host this bb runs on. Envs advertising a
   * different `hostId` are skipped entirely — their copies are
   * unreachable to `git -C` anyway. An empty answer cannot prove
   * remoteness, so nothing is filtered then.
   */
  localHostId?: () => string | Promise<string>;
}

interface EnvDto {
  id: string;
  projectId?: string | null;
  hostId?: string | null;
  path?: string | null;
  branchName?: string | null;
  mergeBaseBranch?: string | null;
  status?: string | null;
  environmentProviderId?: string | null;
  managed?: boolean;
  createdAt?: number | null;
  updatedAt?: number | null;
}

interface ThreadDto {
  id: string;
  status?: string | null;
  /** §15 cond 4: anything but `none` keeps the copy. */
  queuedWork?: string | null;
  /** `bb thread list` precomputes this; absent on older BB → CLI fallback. */
  hasPendingInteraction?: boolean | null;
  archivedAt?: number | null;
  updatedAt?: number | null;
  environmentId?: string | null;
  parentThreadId?: string | null;
  sourceThreadId?: string | null;
  originPluginId?: string | null;
}

export interface JanitorRunOptions {
  /** `--dry-run`: a report-mode pass even under `mode: "apply"`. */
  dryRun?: boolean;
}

export interface JanitorReportedItem {
  envId: string;
  projectId: string | null;
  path: string | null;
  branch: string | null;
  threadId: string | null;
  reason: string;
  /** §16.3: true when this env was not already reported as abandoned. */
  isNew?: boolean;
}

export interface JanitorRunSummary {
  /** True when the run deleted (apply mode and not --dry-run). */
  applied: boolean;
  skipped?: "disabled" | "invalid-config";
  removedCopies: number;
  removedBranches: number;
  archivedThreads: number;
  freedKb: number;
  /** Copies eligible for removal (in report mode — would remove). */
  ready: number;
  /** `bb/` branches without a copy, merged (deleted when applied). */
  orphanBranches: number;
  kept: Record<string, number>;
  reported: JanitorReportedItem[];
  errors: string[];
  runId?: number;
}

export interface JanitorReport {
  config: JanitorConfig | null;
  configErrors: { path: string; message: string }[];
  lastRun: JanitorRunRow | undefined;
  items: ReturnType<JanitorStore["items"]>;
  abandoned: JanitorReportedItem[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function gitOut(
  cmd: CmdRunner,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const res = await cmd.run("git", ["-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  });
  return res.exitCode === 0 ? res.stdout : null;
}

async function gitOk(
  cmd: CmdRunner,
  cwd: string,
  args: string[],
): Promise<boolean> {
  const res = await cmd.run("git", ["-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return res.exitCode === 0;
}

/**
 * §15 cond 5: a live process whose cwd sits inside the copy blocks
 * removal. Only same-uid processes count — the owner is read from
 * `/proc/<pid>` itself (the `cwd` link's stat reports the *directory's*
 * owner, not the process's). `env.path` may contain symlinks while
 * `/proc/<pid>/cwd` is always canonical, so paths are compared after
 * `realpath`. A platform without `/proc` (macOS) cannot prove the
 * negative — `null` keeps the copy (`process-unknown`).
 */
export function defaultHasProcessIn(root: string): boolean | null {
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // path vanished between checks — no process can sit inside it
    return false;
  }
  const roots = [realRoot, root];
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return null;
  }
  for (const pid of pids) {
    try {
      if (uid >= 0) {
        const st = statSync(`/proc/${pid}`);
        if (st.uid !== uid) continue;
      }
      const target = readlinkSync(`/proc/${pid}/cwd`);
      for (const r of roots) {
        const prefix = r.endsWith("/") ? r : `${r}/`;
        if (target === r || target.startsWith(prefix)) return true;
      }
    } catch {
      // the process exited or the cwd is unreadable — not ours
    }
  }
  return false;
}

/** `git worktree list --porcelain` → branches checked out per worktree. */
function parseWorktreeList(
  text: string,
): { worktrees: { path: string; branch: string | null; prunable: boolean }[] } {
  const worktrees: {
    path: string;
    branch: string | null;
    prunable: boolean;
  }[] = [];
  let cur: {
    path: string;
    branch: string | null;
    prunable: boolean;
  } | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = {
        path: line.slice("worktree ".length),
        branch: null,
        prunable: false,
      };
      worktrees.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (cur && line.startsWith("prunable")) {
      cur.prunable = true;
    }
  }
  return { worktrees };
}

export function createJanitor(deps: JanitorDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? {};
  const hasProcessIn =
    deps.hasProcessIn ?? (async (p: string) => defaultHasProcessIn(p));
  // §15 (ревизия 25): «--dry-run и mode: report не ставят first_seen_at
  // и не меняют состояние копий; служебные отметки отчёта (janitor_meta)
  // пишутся». The merged-sighting streak and the daily-notify watermark
  // also work inside such runs — mirrored in memory per process so the
  // DB is not required for a coherent preview.
  const firstSeenMem = new Map<string, number>();
  const notifyMem = new Map<string, number>();
  // §16.3: «newly abandoned» tracking for report-mode runs — the DB is
  // not written, so the previous reported state lives in memory.
  const reportedMem = new Set<string>();
  // ...and the same for «already announced»: a daily-watermark-suppressed
  // env stays unannounced and is retried on a later run.
  const announcedMem = new Set<string>();

  const listEnvironments = async (): Promise<EnvDto[]> =>
    runJson<EnvDto[]>(deps.bbCli, ["environment", "list", "--json"], {
      timeoutMs: 60_000,
    });

  /**
   * §16.3: one global list per run builds the cascade graph (children via
   * `parentThreadId`, hidden forks via `sourceThreadId`) and feeds every
   * env's thread checks. A failed list means nothing about threads is
   * provable — every env reports `threads-unknown`.
   */
  const listThreads = async (): Promise<ThreadDto[] | null> => {
    try {
      return await runJson<ThreadDto[]>(
        deps.bbCli,
        [
          "thread",
          "list",
          "--include-archived",
          "--include-hidden",
          "--json",
        ],
        { timeoutMs: 60_000 },
      );
    } catch {
      return null;
    }
  };

  const showEnvironment = async (envId: string): Promise<EnvDto | null> => {
    try {
      return await runJson<EnvDto>(
        deps.bbCli,
        ["environment", "show", envId, "--json"],
      );
    } catch {
      return null;
    }
  };

  /**
   * §15 cond 4: a request waiting on the thread blocks removal.
   * `bb thread interactions list` returns only awaiting requests; the
   * status check is a guard in case resolved history ever leaks in —
   * then only `pending`/`resolving` count. Items without a `status`
   * field are awaiting by contract.
   */
  const hasPendingInteraction = async (threadId: string): Promise<boolean> => {
    try {
      const list = await runJson<unknown[]>(
        deps.bbCli,
        ["thread", "interactions", "list", threadId, "--json"],
      );
      if (!Array.isArray(list)) return false;
      return list.some((i) => {
        const status = (i as { status?: unknown } | null)?.status;
        return (
          status === undefined || status === "pending" || status === "resolving"
        );
      });
    } catch {
      // Cannot prove there is no pending request — assume there is one.
      return true;
    }
  };

  const keep = (
    summary: JanitorRunSummary,
    reason: string,
    n = 1,
  ) => {
    summary.kept[reason] = (summary.kept[reason] ?? 0) + n;
  };

  /**
   * Refs the copy's commits must be ancestors of: `origin/<protected>`
   * for every protected branch present on the remote, plus the env's
   * `mergeBaseBranch` taken strictly as a remote-tracking ref. A merge
   * into a local branch (§14, `bb orchestrator merge`) is not «влита»
   * until it reaches origin; bare SHAs and local-only names resolve to
   * nothing under `refs/remotes/origin/` and are ignored.
   */
  const targetRefs = async (
    env: EnvDto,
    repoDir: string,
    protectedTargets: string[],
  ): Promise<string[]> => {
    const targets = [...protectedTargets];
    const mbb = env.mergeBaseBranch?.trim();
    if (mbb) {
      const ref = mbb.startsWith("origin/")
        ? `refs/remotes/${mbb}`
        : `refs/remotes/origin/${mbb}`;
      if (
        await gitOk(deps.cmd, repoDir, [
          "rev-parse",
          "--verify",
          "--quiet",
          ref,
        ])
      ) {
        targets.push(ref);
      }
    }
    return [...new Set(targets)];
  };

  /**
   * §16.3 cond 2 (ревизия 25): the copy's own commits — only *reachable*
   * ones, `rev-list --count <start>..<tip>` of the copy's branch where
   * <start> is strictly the position of the reflog «Created from» entry
   * (PLUG-195: no reflog-type parsing — a `pull` or `Fast-forward`
   * record can never hide the count). No reflog, or no creation entry
   * in it → no own commits: undercounting only keeps a copy longer,
   * the «nothing lost» check below protects the commits themselves.
   */
  const countOwnCommits = async (
    env: EnvDto,
    path: string,
    ownBranch: string | undefined,
  ): Promise<number> => {
    const ref = ownBranch?.trim() || env.branchName?.trim();
    if (!ref) return 0;
    const reflog = await gitOut(deps.cmd, path, [
      "log",
      "-g",
      "--format=%H%x00%gs",
      `refs/heads/${ref}`,
    ]);
    if (!reflog) return 0;
    let base: string | undefined;
    for (const line of reflog.split("\n")) {
      const sep = line.indexOf("\0");
      if (sep < 0) continue;
      // newest → oldest: the first «Created from» is the latest
      // (re)creation point of the branch.
      if (/Created from/.test(line.slice(sep + 1))) {
        base = line.slice(0, sep);
        break;
      }
    }
    if (!base) return 0;
    const n = (
      await gitOut(deps.cmd, path, [
        "rev-list",
        "--count",
        `${base}..${ref}`,
      ])
    )?.trim();
    return Number(n) || 0;
  };

  /**
   * §16.3 «влита», the content sign: `git merge-tree --write-tree
   * <target> <sha>` reproducing `<target>^{tree}` proves merging <sha>
   * into the target adds nothing — every change of <sha> is already
   * there (a multi-commit squash, a rebase-published tip). A failed or
   * conflicting merge-tree proves nothing and never counts.
   */
  const mergeTreeEquals = async (
    repoRoot: string,
    target: string,
    sha: string,
  ): Promise<boolean> => {
    const mergedTree = (
      await gitOut(deps.cmd, repoRoot, [
        "merge-tree",
        "--write-tree",
        target,
        sha,
      ])
    )
      ?.split("\n")[0]
      ?.trim();
    if (!mergedTree) return false;
    const targetTree = (
      await gitOut(deps.cmd, repoRoot, ["rev-parse", `${target}^{tree}`])
    )?.trim();
    return !!targetTree && mergedTree === targetTree;
  };

  /**
   * §16.3 «влита»: a sha is merged into a remote-tracking target when it
   * is an ancestor — or when its whole content already sits on the
   * target (`mergeTreeEquals`, the second mergedness sign in place of
   * `git cherry`, so a squash of two or more commits counts too).
   */
  const shaMergedIn = async (
    repoRoot: string,
    sha: string,
    targets: string[],
  ): Promise<boolean> => {
    for (const t of targets) {
      if (
        await gitOk(deps.cmd, repoRoot, ["merge-base", "--is-ancestor", sha, t])
      ) {
        return true;
      }
      if (await mergeTreeEquals(repoRoot, t, sha)) return true;
    }
    return false;
  };

  /**
   * §16.3 «ничего не теряется», the patch-id sign: every commit <sha>
   * adds over the target is `patch-id --stable`-equivalent to a commit
   * on it (`git cherry` prints only «-» lines — amend/rebase of already
   * published work). A merge commit has no patch-id and can never match
   * — its unique resolution content is covered by the anchor-content
   * sign instead; a failed cherry proves nothing.
   */
  const patchEquivalent = async (
    repoRoot: string,
    sha: string,
    targets: string[],
  ): Promise<boolean> => {
    const merge = (
      await gitOut(deps.cmd, repoRoot, [
        "rev-list",
        "-1",
        "--min-parents=2",
        sha,
      ])
    )?.trim();
    if (merge) return false;
    for (const t of targets) {
      const cherry = await gitOut(deps.cmd, repoRoot, ["cherry", t, sha]);
      if (
        cherry !== null &&
        !cherry.split("\n").some((l) => l.startsWith("+"))
      ) {
        return true;
      }
    }
    return false;
  };

  /**
   * §16.3 (ревизия 25) «ничего не теряется»: every commit the given
   * reflogs (`git log -g --format=%H <ref>`, whole history) ever
   * pointed at must be safe — an ancestor of a remote target,
   * patch-equivalent to a commit on it, or carrying content already on
   * a target. The content sign is checked for EACH pending commit
   * itself (PLUG-197): `merge-tree --write-tree <target> <sha>`
   * reproducing `<target>^{tree}` proves THIS commit's content is on
   * origin. A whole-tip check cannot clear the middle commits — «A +
   * revert A» nets to origin while A's content never reached it, and a
   * squash that rewrote an earlier commit's lines leaves that commit
   * without a counterpart; both stay («брошено» when abandoned, never
   * a silent removal). «ok» — the reflogs hold nothing unpublished;
   * «lost» — at least one commit (a `reset`-orphan, a detached-HEAD
   * commit, an unpublished pre-amend version) would die with the ref;
   * «unknown» — a reflog or the reachability scan could not be read,
   * so nothing is proven and the ref stays.
   */
  const reflogPositionsSafe = async (
    cwd: string,
    refs: string[],
    repoRoot: string,
    targets: string[],
  ): Promise<"ok" | "lost" | "unknown"> => {
    const shas = new Set<string>();
    for (const ref of refs) {
      const out = await gitOut(deps.cmd, cwd, [
        "log",
        "-g",
        "--format=%H",
        ref,
      ]);
      if (out === null) return "unknown";
      for (const l of out.split("\n")) {
        const s = l.trim();
        if (s) shas.add(s);
      }
    }
    // Positions already reachable from a target are proven published —
    // drop them in one rev-list pass, then check the remainder.
    const pending = new Set<string>();
    const list = [...shas];
    for (let i = 0; i < list.length; i += 200) {
      const out = await gitOut(deps.cmd, repoRoot, [
        "rev-list",
        ...list.slice(i, i + 200),
        "--not",
        ...targets,
      ]);
      if (out === null) return "unknown";
      for (const l of out.split("\n")) {
        const s = l.trim();
        if (s && shas.has(s)) pending.add(s);
      }
    }
    if (!pending.size) return "ok";
    // `<target>^{tree}` is resolved once per target, not per commit.
    const targetTrees = new Map<string, string | null>();
    const ownContentOn = async (t: string, sha: string) => {
      let tt = targetTrees.get(t);
      if (tt === undefined) {
        tt =
          (
            await gitOut(deps.cmd, repoRoot, [
              "rev-parse",
              `${t}^{tree}`,
            ])
          )?.trim() ?? null;
        targetTrees.set(t, tt);
      }
      if (!tt) return false;
      const mergedTree = (
        await gitOut(deps.cmd, repoRoot, [
          "merge-tree",
          "--write-tree",
          t,
          sha,
        ])
      )
        ?.split("\n")[0]
        ?.trim();
      return !!mergedTree && mergedTree === tt;
    };
    for (const sha of pending) {
      if (await patchEquivalent(repoRoot, sha, targets)) continue;
      let own = false;
      for (const t of targets) {
        if (await ownContentOn(t, sha)) {
          own = true;
          break;
        }
      }
      if (own) continue;
      return "lost";
    }
    return "ok";
  };

  /**
   * «Ничего не теряется» for a working copy: the whole reflog of the
   * copy's HEAD (per-worktree) and of the copy's own branches —
   * `branchName` plus the checked-out one when it differs. The repo's
   * other branches are never scanned — that would multiply every
   * copy's git calls by the branch count.
   */
  const nothingLost = async (
    env: EnvDto,
    path: string,
    ownBranch: string | undefined,
    repoRoot: string,
    targets: string[],
  ): Promise<"ok" | "lost" | "unknown"> => {
    const refs = ["HEAD"];
    for (const b of [env.branchName?.trim(), ownBranch?.trim()]) {
      if (!b) continue;
      const ref = `refs/heads/${b}`;
      if (refs.includes(ref)) continue;
      // A branch that does not exist has no positions to protect.
      if (
        await gitOk(deps.cmd, path, [
          "rev-parse",
          "--verify",
          "--quiet",
          ref,
        ])
      ) {
        refs.push(ref);
      }
    }
    return reflogPositionsSafe(path, refs, repoRoot, targets);
  };

  const run = async (
    opts: JanitorRunOptions = {},
  ): Promise<JanitorRunSummary> => {
    const at = now();
    const summary: JanitorRunSummary = {
      applied: false,
      removedCopies: 0,
      removedBranches: 0,
      archivedThreads: 0,
      freedKb: 0,
      ready: 0,
      orphanBranches: 0,
      kept: {},
      reported: [],
      errors: [],
    };

    const cfgLoad = await deps.loadConfig();
    if (cfgLoad.errors.length) {
      for (const e of cfgLoad.errors) {
        log.warn?.(`orchestrator janitor: ${e.path}: ${e.message}`);
      }
      summary.skipped = "invalid-config";
      summary.errors = cfgLoad.errors.map((e) => `${e.path}: ${e.message}`);
      return summary;
    }
    const cfg = cfgLoad.config;
    // A --dry-run pass reads everything and writes nothing, so it is
    // allowed even while the janitor is disabled — that is how the user
    // previews what enabling it would do (§6 janitor run --dry-run).
    if (!cfg?.enabled && !opts.dryRun) {
      summary.skipped = "disabled";
      return summary;
    }
    const effective: JanitorConfig = cfg ?? {
      enabled: false,
      mode: "report",
      afterMergeMs: 10 * 3_600_000,
      abandonedAfterMs: 10 * 86_400_000,
      intervalMinutes: 60,
      excludeProjects: [],
      protectedBranches: ["main", "master", "dev"],
      deleteBranches: false,
      scope: "workers",
    };
    const apply = effective.enabled && effective.mode === "apply" && !opts.dryRun;
    summary.applied = apply;

    // §15: «--dry-run ничего не пишет и ничего не отправляет» — no run
    // row, no janitor_meta marks, no coordinator messages; the pass is
    // a pure preview. In-memory streak mirrors still advance so
    // repeated dry-runs of one process behave like real runs.
    const dry = opts.dryRun === true;
    const runId = dry ? undefined : deps.janitor.startRun(at);
    summary.runId = runId;

    const finish = (error?: string) => {
      if (runId !== undefined) {
        deps.janitor.finishRun(
          runId,
          {
            removed: summary.removedCopies + summary.removedBranches,
            kept: Object.values(summary.kept).reduce((a, b) => a + b, 0),
            freedKb: summary.freedKb,
            error: error ?? null,
          },
          now(),
        );
      }
      const keptText = Object.entries(summary.kept)
        .map(([r, n]) => `${r}=${n}`)
        .join(" ");
      log.info?.(
        `[orchestrator] janitor: removed ${summary.removedCopies} copies, ` +
          `${summary.removedBranches} branches, ${summary.archivedThreads} threads, ` +
          `freed ${Math.round(summary.freedKb / 1024)} MB` +
          (keptText ? `; kept: ${keptText}` : "") +
          (error ? `; error: ${error}` : ""),
      );
    };

    try {
      const ctx = await runBody(effective, apply, summary, dry);
      // The daily «брошено» message is report output — it goes out in
      // report and apply modes (never on --dry-run), with the
      // janitor_meta marks persisted so a restart cannot resend it.
      if (!dry) await notifyCoordinators(summary, ctx);
      finish();
    } catch (e) {
      const text = message(e);
      summary.errors.push(text);
      finish(text);
    }
    return summary;
  };

  /** Run output the notify step needs (§15, PLUG-192). */
  interface RunContext {
    /**
     * Envs that got a definite, non-transient outcome this run — only
     * those may leave the announced-abandoned list. Transient results
     * (`fetch-failed`, `threads-unknown`, `not-a-repo`, `missing-path`,
     * a failed `git status`/reflog/probe, a failed archive) leave it
     * untouched, so a flapping run cannot cause a repeat announcement.
     */
    definite: Set<string>;
    /** Every env id BB reported — an id absent here no longer exists. */
    allEnvIds: Set<string>;
  }
  const runBody = async (
    cfg: JanitorConfig,
    apply: boolean,
    summary: JanitorRunSummary,
    dry: boolean,
  ): Promise<RunContext> => {
    const ctx: RunContext = {
      definite: new Set(),
      allEnvIds: new Set(),
    };
    const at = now();
    const persist = apply;
    const exclude = new Set(cfg.excludeProjects);
    const localHost = deps.localHostId
      ? String((await deps.localHostId()) ?? "")
      : "";
    const allEnvs = await listEnvironments();
    for (const e of allEnvs) ctx.allEnvIds.add(e.id);
    // `bb/` branches belonging to envs the janitor must not touch —
    // excluded projects, and envs of other machines — stay out of the
    // branch sweep even when the repo itself is in scope.
    const excludedBranches = new Set(
      allEnvs
        .filter(
          (e) =>
            exclude.has(e.projectId ?? "") ||
            (!!localHost && !!e.hostId && e.hostId !== localHost),
        )
        .map((e) => e.branchName?.trim())
        .filter((b): b is string => !!b),
    );
    const envs = allEnvs.filter(
      (e) =>
        e.managed === true &&
        e.environmentProviderId === "git-worktree" &&
        e.status === "ready" &&
        typeof e.path === "string" &&
        e.path.length > 0 &&
        !exclude.has(e.projectId ?? "") &&
        // Envs of other machines are unreachable to `git -C` — without
        // the filter they only collect bogus `not-a-repo` rows.
        (!localHost || !e.hostId || e.hostId === localHost),
    );
    const envById = new Map(envs.map((e) => [e.id, e]));

    const activeDelegations = (): Set<string> =>
      new Set(
        deps.store
          .listActive()
          .map((r) => r.thread_id)
          .filter((t): t is string => typeof t === "string"),
      );
    const delegatedThreads = activeDelegations();

    // §16.3: one global thread list builds the cascade graph — children
    // via `parentThreadId`, hidden forks via `sourceThreadId`. The graph
    // is rebuilt right before archiving (§15 «Действие»): the run-start
    // snapshot is stale by then.
    interface ThreadGraph {
      all: ThreadDto[] | null;
      byId: Map<string, ThreadDto>;
      byEnv: Map<string, ThreadDto[]>;
      childrenOf: Map<string, ThreadDto[]>;
    }
    const fetchGraph = async (): Promise<ThreadGraph> => {
      const all = await listThreads();
      const g: ThreadGraph = {
        all,
        byId: new Map(),
        byEnv: new Map(),
        childrenOf: new Map(),
      };
      for (const t of all ?? []) {
        g.byId.set(t.id, t);
        if (t.environmentId) {
          const list = g.byEnv.get(t.environmentId) ?? [];
          list.push(t);
          g.byEnv.set(t.environmentId, list);
        }
        for (const p of [t.parentThreadId, t.sourceThreadId]) {
          if (p) {
            const list = g.childrenOf.get(p) ?? [];
            list.push(t);
            g.childrenOf.set(p, list);
          }
        }
      }
      return g;
    };
    const graph = await fetchGraph();
    /**
     * The freshest thread list seen this run — refreshed by every
     * pre-archive re-read, so the post-archive «remaining» check below
     * counts threads that appeared mid-run (PLUG-192: a brand-new env
     * thread outside the archived cascade still holds the copy).
     */
    let latestGraph = graph;
    const liveThreadsOf = (
      envId: string,
      g?: ThreadGraph,
    ): ThreadDto[] =>
      ((g ?? latestGraph).byEnv.get(envId) ?? []).filter(
        (t) => !t.archivedAt && !archivedNow.has(t.id),
      );

    const pickThreadId = (env: EnvDto): string | null => {
      const list = latestGraph.byEnv.get(env.id) ?? [];
      const live = list.filter((t) => !t.archivedAt);
      return (
        live.find((t) => delegatedThreads.has(t.id))?.id ??
        live[0]?.id ??
        list[0]?.id ??
        deps.janitor.item(env.id)?.thread_id ??
        null
      );
    };

    // Group copies by repository: one `git fetch --prune origin` per repo
    // per run; a failed fetch skips the repo's copies (mergedness is
    // provable only against fresh remote-tracking refs).
    interface RepoInfo {
      root: string;
      /** Shared git dir — branch reflogs (and their mtimes) live here. */
      commonDir: string;
      fetched: boolean;
      protectedTargets: string[];
      localBranches: string[];
      openBranches: Set<string>;
      /** `git worktree list` failed — the sweep cannot prove openness. */
      worktreeListFailed: boolean;
    }
    const repos = new Map<string, { root: string; envs: EnvDto[] }>();
    const repoByEnv = new Map<string, RepoInfo | null>();
    for (const env of envs) {
      const common = await gitOut(deps.cmd, env.path!, [
        "rev-parse",
        "--git-common-dir",
      ]);
      if (common === null) {
        repoByEnv.set(env.id, null);
        continue;
      }
      const commonDir = isAbsolute(common.trim())
        ? common.trim()
        : join(env.path!, common.trim());
      const root =
        basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
      const slot = repos.get(commonDir) ?? { root, envs: [] };
      slot.envs.push(env);
      repos.set(commonDir, slot);
    }

    // §16.3: the branch sweep deletes `bb/` branches on a *later* run,
    // once the copy is gone — but with all copies gone the env list can
    // no longer discover the repo. Previously seen roots are kept in
    // `janitor_meta` (§7) exactly for this.
    try {
      const seen = JSON.parse(deps.janitor.meta("repoRoots") ?? "[]") as {
        common: string;
        root: string;
      }[];
      for (const r of seen) {
        if (!repos.has(r.common) && existsSync(r.root)) {
          repos.set(r.common, { root: r.root, envs: [] });
        }
      }
    } catch {
      // a corrupt meta value just means fewer sweep candidates
    }

    const resetStreak = (env: EnvDto) => {
      if (persist) {
        const prev = deps.janitor.item(env.id);
        if (prev?.first_seen_at != null) {
          deps.janitor.upsertItem(
            env.id,
            {
              projectId: env.projectId ?? null,
              path: env.path ?? null,
              branch: env.branchName ?? null,
              state: prev.state,
              firstSeenAt: null,
            },
            now(),
          );
        }
      } else {
        firstSeenMem.delete(env.id);
      }
    };

    const repoInfos: RepoInfo[] = [];
    const seenRoots: { common: string; root: string }[] = [];
    for (const [commonDir, { root, envs: repoEnvs }] of repos) {
      const info: RepoInfo = {
        root,
        commonDir,
        fetched: await gitOk(deps.cmd, root, ["fetch", "--prune", "origin"]),
        protectedTargets: [],
        localBranches: [],
        openBranches: new Set(),
        worktreeListFailed: false,
      };
      if (!info.fetched) {
        // The run never saw these copies merged, so their «влита» streak
        // cannot count this pass — the clock pauses and restarts on the
        // next verified-merged run.
        for (const env of repoEnvs) resetStreak(env);
      } else {
        for (const b of cfg.protectedBranches) {
          const ref = `refs/remotes/origin/${b}`;
          if (
            await gitOk(deps.cmd, root, [
              "rev-parse",
              "--verify",
              "--quiet",
              ref,
            ])
          ) {
            info.protectedTargets.push(ref);
          }
        }
        // A copy BB deleted externally leaves a stale worktree entry
        // that still marks its branch «checked out» — prune it (apply
        // only; report mode reads the `prunable` flag instead).
        if (apply) await gitOk(deps.cmd, root, ["worktree", "prune"]);
        const worktreeList = await gitOut(deps.cmd, root, [
          "worktree",
          "list",
          "--porcelain",
        ]);
        info.worktreeListFailed = worktreeList === null;
        info.openBranches = new Set(
          parseWorktreeList(worktreeList ?? "")
            .worktrees
            // A copy whose directory BB already deleted lingers as a
            // `prunable` entry (or is simply missing from disk) — its
            // branch is not «открыта ни в одной копии» (§15).
            .filter((w) => !w.prunable && existsSync(w.path))
            .map((w) => w.branch)
            .filter((b): b is string => !!b),
        );
        info.localBranches = (
          (await gitOut(deps.cmd, root, [
            "for-each-ref",
            "refs/heads",
            "--format=%(refname:short)",
          ])) ?? ""
        )
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      }
      for (const env of repoEnvs) repoByEnv.set(env.id, info);
      repoInfos.push(info);
      seenRoots.push({ common: commonDir, root });
    }
    // Service state, not an item row: written by report and apply
    // modes (§15 — the branch sweep needs the roots of copies that are
    // already gone, whatever mode deletes them). --dry-run writes
    // nothing.
    if (!dry) {
      deps.janitor.setMeta(
        "repoRoots",
        JSON.stringify(seenRoots.slice(-500)),
      );
    }

    const reportedNow: {
      env: EnvDto;
      reason: string;
      threadId: string | null;
      isNew: boolean;
    }[] = [];
    const archivedNow = new Set<string>();
    const processedThreads = new Set<string>();
    const envBlocked = new Map<string, string>();
    const ancestorCache = new Map<string, boolean>();

    const markReported = (env: EnvDto, reason: string) => {
      const prevReported = persist
        ? deps.janitor.item(env.id)?.state === "reported"
        : reportedMem.has(env.id);
      reportedMem.add(env.id);
      if (!persist) firstSeenMem.delete(env.id);
      reportedNow.push({
        env,
        reason,
        threadId: pickThreadId(env),
        isNew: !prevReported,
      });
      keep(summary, reason);
      if (persist) {
        deps.janitor.upsertItem(
          env.id,
          {
            projectId: env.projectId ?? null,
            path: env.path ?? null,
            branch: env.branchName ?? null,
            threadId: pickThreadId(env),
            state: "reported",
            reason,
            firstSeenAt: null,
          },
          at,
        );
      }
    };

    const writeKept = (
      env: EnvDto,
      reason: string,
      firstSeenAt?: number | null,
    ) => {
      reportedMem.delete(env.id);
      // The in-memory streak resets only on an unmerged sighting —
      // post-merge keeps («merged-wait» & co.) let it mature.
      if (!persist && firstSeenAt == null) firstSeenMem.delete(env.id);
      keep(summary, reason);
      if (persist) {
        deps.janitor.upsertItem(
          env.id,
          {
            projectId: env.projectId ?? null,
            path: env.path ?? null,
            branch: env.branchName ?? null,
            threadId: pickThreadId(env),
            state: "kept",
            reason,
            ...(firstSeenAt !== undefined ? { firstSeenAt } : {}),
          },
          at,
        );
      }
    };

    interface EnvFacts {
      ready: boolean;
      reason: string;
      reported: boolean;
      firstSeenAt: number | null;
      /** HEAD at the run-start evaluation — re-verified before archive. */
      headSha?: string;
    }
    const factsCache = new Map<string, EnvFacts>();
    const envFacts = async (env: EnvDto): Promise<EnvFacts> => {
      const hit = factsCache.get(env.id);
      if (hit) return hit;
      const f = await computeFacts(env);
      factsCache.set(env.id, f);
      return f;
    };

    const computeFacts = async (env: EnvDto): Promise<EnvFacts> => {
      const bad = (reason: string, reported = false): EnvFacts => ({
        ready: false,
        reason,
        reported,
        firstSeenAt: null,
      });
      const repo = repoByEnv.get(env.id);
      if (repo === null || repo === undefined) return bad("not-a-repo");
      if (!repo.fetched) return bad("fetch-failed");
      // Thread state feeds «заброшена» and «все в архиве» — without the
      // list neither is provable, so nothing about the env is.
      if (graph.all === null) return bad("threads-unknown");
      const path = env.path!;
      if (!existsSync(path)) return bad("missing-path");
      const head = (
        await gitOut(deps.cmd, path, ["rev-parse", "--verify", "HEAD"])
      )?.trim();
      if (!head) return bad("no-head");

      // §15 cond 3 facts are computed up front: they decide the abandoned
      // reason for unmerged copies too («грязное с тем же простоем»). The
      // flags override repo config like status.showUntrackedFiles=no —
      // hiding an untracked file must never pass as «clean». A failed or
      // timed-out status means cleanliness is unproven, not proven.
      const statusText = await gitOut(deps.cmd, path, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
      const statusFailed = statusText === null;
      const dirty = statusText !== null && statusText.trim().length > 0;
      const gitDirRaw = await gitOut(deps.cmd, path, [
        "rev-parse",
        "--git-dir",
      ]);
      // A failed git-dir probe means unfinished-op state is unproven —
      // the copy is kept (`unfinished-unknown`), never silently passed.
      const gitDirFailed = gitDirRaw === null;
      const gitDir = gitDirRaw
        ? isAbsolute(gitDirRaw.trim())
          ? gitDirRaw.trim()
          : join(path, gitDirRaw.trim())
        : null;
      const unfinished =
        !!gitDir &&
        (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD", "REVERT_HEAD"].some(
          (f) => existsSync(join(gitDir, f)),
        ) ||
          existsSync(join(gitDir, "rebase-merge")) ||
          existsSync(join(gitDir, "rebase-apply")));

      const ownBranch = (
        await gitOut(deps.cmd, path, ["branch", "--show-current"])
      )?.trim();

      const envThreadList = graph.byEnv.get(env.id) ?? [];
      const liveThreads = envThreadList.filter((t) => !t.archivedAt);
      // «Тред простаивает» — idleness is the threads', not the env
      // record's: env.updatedAt moves on lifecycle events, not user work.
      const lastActivity = envThreadList.length
        ? Math.max(...envThreadList.map((t) => t.updatedAt ?? 0))
        : (env.updatedAt ?? 0);
      const abandoned = at - lastActivity > cfg.abandonedAfterMs;
      const allArchived = envThreadList.length > 0 && liveThreads.length === 0;

      // §16.3 cond 1: HEAD plus the env's own branch (`branchName`) when
      // it exists and is not the checked-out one — ancestor of a remote
      // target or fully patch-equivalent to it (`git cherry`).
      const shas = [head];
      const envBranch = env.branchName?.trim();
      if (envBranch && envBranch !== ownBranch) {
        const sha = (
          await gitOut(deps.cmd, repo.root, [
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${envBranch}`,
          ])
        )?.trim();
        if (sha) shas.push(sha);
      }
      const targets = await targetRefs(env, repo.root, repo.protectedTargets);
      let merged = targets.length > 0;
      if (merged) {
        for (const sha of new Set(shas)) {
          let ok = ancestorCache.get(sha) === true;
          if (!ok) ok = await shaMergedIn(repo.root, sha, targets);
          // Only positive results are shared: a miss here may still be
          // an ancestor of another env's mergeBaseBranch.
          if (ok) ancestorCache.set(sha, true);
          if (!ok) {
            merged = false;
            break;
          }
        }
      }

      if (!merged) {
        const reason = allArchived
          ? "abandoned-archived"
          : !abandoned
            ? "not-merged"
            : dirty || unfinished
              ? "abandoned-dirty"
              : "abandoned-unmerged";
        return bad(reason, reason.startsWith("abandoned"));
      }

      // The copy stays merged from the first run that saw it so; an
      // unmerged sighting between runs resets the clock above.
      const prev = deps.janitor.item(env.id);
      const firstSeenAt =
        prev?.first_seen_at ?? firstSeenMem.get(env.id) ?? at;
      if (!persist) firstSeenMem.set(env.id, firstSeenAt);
      const after = (reason: string, reported = false): EnvFacts => ({
        ready: false,
        reason,
        reported,
        firstSeenAt,
      });
      if (at - firstSeenAt < cfg.afterMergeMs) return after("merged-wait");

      // §16.3 cond 2: own commits are the copy's branch commits after its
      // creation point — a copy at (or behind) the tip with no commits
      // only looks merged; it goes once its thread idles past
      // abandonedAfter, not on a fresh thread.
      const ownWork = (await countOwnCommits(env, path, ownBranch)) > 0;
      if (!ownWork && !abandoned) return after("no-commits-fresh");
      if (statusFailed) return after("status-failed");
      if (dirty)
        return after(abandoned ? "abandoned-dirty" : "dirty", abandoned);
      if (unfinished) return after("unfinished-op");
      if (gitDirFailed) return after("unfinished-unknown");
      // §16.3 (ревизия 25, главное условие): «ничего не теряется» —
      // every commit the copy's HEAD or its own branch ever pointed at
      // must already sit on a remote target: as an ancestor, as a
      // patch-equivalent (amend/rebase of published work), or by its
      // own content (`merge-tree` per commit — a multi-commit squash).
      // A commit that is neither — one orphaned by `reset`, made on a
      // detached HEAD, an unpublished pre-amend version, an «A» in a
      // net-zero «A + revert A» — keeps the copy; once the thread
      // idles past `abandonedAfter` it goes to the «брошено» report.
      // The whole reflogs are read (no entry cap), but only the
      // copy's own: HEAD is per-worktree, plus `branchName` and the
      // checked-out branch when they exist — the repo's other
      // branches are never scanned.
      const lost = await nothingLost(
        env,
        path,
        ownBranch,
        repo.root,
        targets,
      );
      if (lost === "unknown") return after("unpushed-unknown");
      if (lost === "lost") {
        return abandoned
          ? after("abandoned-unpushed", true)
          : after("unpushed-commits");
      }
      const proc = await hasProcessIn(path);
      if (proc === null) return after("process-unknown");
      if (proc) return after("process-inside");
      return {
        ready: true,
        reason: "ready",
        reported: false,
        firstSeenAt,
        headSha: head,
      };
    };

    // §16.3: candidates are dispatch threads (`originPluginId=tasks`) and
    // threads with a parent — or, under `scope: "all"`, every unarchived
    // thread of a managed env. A candidate is a cascade root unless an
    // unarchived candidate ancestor already covers it.
    const isCandidate = (t: ThreadDto): boolean =>
      !t.archivedAt &&
      !archivedNow.has(t.id) &&
      !processedThreads.has(t.id) &&
      !!t.environmentId &&
      envById.has(t.environmentId) &&
      (cfg.scope === "all" ||
        t.originPluginId === "tasks" ||
        !!t.parentThreadId);

    const hasCandidateAncestor = (t: ThreadDto): boolean => {
      const seen = new Set<string>();
      let cur: ThreadDto | undefined = t;
      while (cur) {
        const pid = cur.parentThreadId ?? cur.sourceThreadId;
        if (!pid || seen.has(pid)) return false;
        seen.add(pid);
        const p = graph.byId.get(pid);
        if (!p) return false;
        if (!p.archivedAt && isCandidate(p)) return true;
        cur = p;
      }
      return false;
    };
    const isCascadeRoot = (t: ThreadDto): boolean =>
      isCandidate(t) && !hasCandidateAncestor(t);

    const cascadeOf = (
      g: ThreadGraph,
      root: ThreadDto,
    ): ThreadDto[] => {
      const out: ThreadDto[] = [];
      const seen = new Set<string>([root.id]);
      const queue = [root];
      while (queue.length) {
        const t = queue.shift()!;
        out.push(t);
        for (const c of g.childrenOf.get(t.id) ?? []) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            queue.push(c);
          }
        }
      }
      return out;
    };

    const blame = (env: EnvDto, reason: string, blameEnvId: string | null) =>
      envBlocked.set(
        env.id,
        !blameEnvId || blameEnvId === env.id ? reason : `cascade:${reason}`,
      );

    /**
     * §15 cond 4 (ревизия 25): the quiescence set is every non-archived
     * cascade member — *including members with no env of their own* — and
     * every live thread of each member env (they share the copy; a
     * blocking thread outside the cascade still blocks the archive).
     */
    const cond4Threads = (
      members: ThreadDto[],
      memberEnvs: Map<string, EnvDto>,
      g: ThreadGraph,
    ): { thread: ThreadDto; env: string | null }[] => {
      const out: { thread: ThreadDto; env: string | null }[] = [];
      const seen = new Set<string>();
      for (const t of members) {
        seen.add(t.id);
        out.push({ thread: t, env: t.environmentId ?? null });
      }
      for (const e of memberEnvs.values()) {
        for (const t of liveThreadsOf(e.id, g)) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          out.push({ thread: t, env: e.id });
        }
      }
      return out;
    };
    const checkCond4 = async (
      list: { thread: ThreadDto; env: string | null }[],
      delegated: Set<string>,
    ): Promise<{ reason: string; env: string | null } | null> => {
      for (const { thread: t, env } of list) {
        if (!QUIESCENT_THREAD_STATUSES.has(t.status ?? "")) {
          return { reason: "threads-active", env };
        }
        if (t.queuedWork !== "none") {
          return { reason: "queued-work", env };
        }
        if (delegated.has(t.id)) {
          return { reason: "delegation-active", env };
        }
      }
      for (const { thread: t, env } of list) {
        const pending =
          typeof t.hasPendingInteraction === "boolean"
            ? t.hasPendingInteraction
            : await hasPendingInteraction(t.id);
        if (pending) return { reason: "interactions-pending", env };
      }
      return null;
    };

    /**
     * §16.3: evaluate one cascade — every unarchived member's env must
     * pass conditions 1–5 and no member may have a blocking status, an
     * active delegation or a pending request. A pass archives all
     * members (children first, the root last); a failed archive rolls
     * the already-archived members back. `bb environment cleanup` is
     * never called — BB frees the copy once every env thread is archived.
     */
    const evalCascade = async (root: ThreadDto): Promise<void> => {
      const members = cascadeOf(graph, root).filter(
        (t) => !t.archivedAt && !archivedNow.has(t.id),
      );
      for (const t of members) processedThreads.add(t.id);
      const memberEnvs = new Map<string, EnvDto>();
      const note = (reason: string, blameEnvId: string | null) => {
        for (const e of memberEnvs.values()) blame(e, reason, blameEnvId);
      };
      let external = false;
      for (const t of members) {
        const eid = t.environmentId;
        if (!eid) continue;
        const e = envById.get(eid);
        if (!e) {
          external = true;
          break;
        }
        memberEnvs.set(eid, e);
      }
      if (external) {
        // A cascade member lives in an env outside the managed set — its
        // copy cannot be verified, so the whole cascade stays.
        note("cascade-env-external", null);
        return;
      }
      const blocked = await checkCond4(
        cond4Threads(members, memberEnvs, graph),
        delegatedThreads,
      );
      if (blocked) {
        note(blocked.reason, blocked.env);
        return;
      }
      for (const e of memberEnvs.values()) {
        const f = await envFacts(e);
        if (!f.ready) {
          note(f.reason, e.id);
          return;
        }
      }
      if (!apply) return; // report mode: counted via «ready» below

      // §15 «Действие»: the run-start snapshot is minutes old by now —
      // re-read the cascade's threads and repeat `git status` on every
      // member copy before archiving. The cascade itself is rebuilt: a
      // child spawned meanwhile rides BB's own cascade archive, so it
      // must face the same checks (or the whole archive is off).
      const fresh = await fetchGraph();
      latestGraph = fresh;
      const freshRoot = fresh.all === null ? undefined : fresh.byId.get(root.id);
      if (!freshRoot || freshRoot.archivedAt || archivedNow.has(root.id)) {
        note("threads-unknown", null);
        return;
      }
      const freshMembers = cascadeOf(fresh, freshRoot).filter(
        (t) => !t.archivedAt && !archivedNow.has(t.id),
      );
      for (const t of freshMembers) processedThreads.add(t.id);
      const freshEnvs = new Map<string, EnvDto>();
      let externalFresh = false;
      for (const t of freshMembers) {
        const eid = t.environmentId;
        if (!eid) continue;
        const e = envById.get(eid);
        if (!e) {
          externalFresh = true;
          break;
        }
        freshEnvs.set(eid, e);
      }
      if (externalFresh) {
        note("cascade-env-external", null);
        return;
      }
      const blockedFresh = await checkCond4(
        cond4Threads(freshMembers, freshEnvs, fresh),
        activeDelegations(),
      );
      if (blockedFresh) {
        note(blockedFresh.reason, blockedFresh.env);
        return;
      }
      for (const e of freshEnvs.values()) {
        const f = await envFacts(e);
        if (!f.ready) {
          note(f.reason, e.id);
          return;
        }
      }
      for (const e of freshEnvs.values()) {
        const st = await gitOut(deps.cmd, e.path!, [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ]);
        if (st === null) {
          note("status-failed", e.id);
          return;
        }
        if (st.trim()) {
          note("dirty", e.id);
          return;
        }
        // §15 «Действие»: HEAD is re-verified against the run-start
        // snapshot — a commit landed meanwhile cancels the archive;
        // the env is re-evaluated on the next run.
        const f = await envFacts(e);
        const head = (
          await gitOut(deps.cmd, e.path!, ["rev-parse", "--verify", "HEAD"])
        )?.trim();
        if (!head || head !== f.headSha) {
          note("head-changed", e.id);
          return;
        }
        // §16.3: «ничего не теряется» is re-run, not only the HEAD
        // compare — a commit plus `reset` between the snapshot and now
        // keeps HEAD identical while the reflog gained an unpublished
        // commit (PLUG-195).
        const repo = repoByEnv.get(e.id);
        if (!repo || !repo.fetched) {
          note("fetch-failed", e.id);
          return;
        }
        const ownBranch = (
          await gitOut(deps.cmd, e.path!, ["branch", "--show-current"])
        )?.trim();
        const targets = await targetRefs(
          e,
          repo.root,
          repo.protectedTargets,
        );
        const lost = await nothingLost(
          e,
          e.path!,
          ownBranch,
          repo.root,
          targets,
        );
        if (lost !== "ok") {
          note(lost === "lost" ? "unpushed-commits" : "unpushed-unknown", e.id);
          return;
        }
        // §15 «Действие» (PLUG-197): a process may have cd'ed into the
        // copy after the run-start probe — re-check before archiving.
        const proc = await hasProcessIn(e.path!);
        if (proc === null) {
          note("process-unknown", e.id);
          return;
        }
        if (proc) {
          note("process-inside", e.id);
          return;
        }
      }

      const done: string[] = [];
      for (const t of [...freshMembers].reverse()) {
        const res = await deps.bbCli.run(["thread", "archive", t.id]);
        if (res.exitCode !== 0) {
          // §15: a failed archive rolls the members already archived
          // back and leaves every copy of the cascade alone.
          for (const u of done) {
            const back = await deps.bbCli.run(["thread", "unarchive", u]);
            if (back.exitCode !== 0) {
              log.warn?.(
                `orchestrator janitor: unarchive ${u} failed: ` +
                  (back.stderr.trim() || `exit ${back.exitCode}`),
              );
            }
          }
          note("archive-failed", root.environmentId ?? null);
          return;
        }
        done.push(t.id);
        archivedNow.add(t.id);
        summary.archivedThreads += 1;
      }
    };

    // Drive every candidate root once. Cascades partition the unarchived
    // forest (each thread has at most one topmost ancestor), so env
    // iteration order does not matter.
    for (const env of envs) {
      if (!(await envFacts(env)).ready) continue;
      for (const t of graph.byEnv.get(env.id) ?? []) {
        if (isCascadeRoot(t)) await evalCascade(t);
      }
    }

    // Per-env outcomes. `definite` records envs whose outcome is a real
    // evaluation (not a transient failure) — only they may leave the
    // announced-abandoned list in the notify step.
    const settle = (env: EnvDto, reason: string) => {
      if (!TRANSIENT_KEEPS.has(reason.replace(/^cascade:/, ""))) {
        ctx.definite.add(env.id);
      }
    };
    for (const env of envs) {
      const facts = await envFacts(env);
      if (!facts.ready) {
        if (facts.reason === "fetch-failed") {
          // The streak reset already wrote the row — overwriting it
          // would lose the previous reason («merged-wait») that explains
          // the paused clock.
          keep(summary, facts.reason);
          continue;
        }
        if (facts.reported) {
          markReported(env, facts.reason);
        } else {
          writeKept(env, facts.reason, facts.firstSeenAt);
        }
        settle(env, facts.reason);
        continue;
      }
      const envThreadList = latestGraph.byEnv.get(env.id) ?? [];
      const blocked = envBlocked.get(env.id);
      // Threads that stayed out of every evaluated cascade — out-of-scope
      // root chats under `scope: workers`, or members of a cascade that
      // already failed (they stay `processed` but unarchived).
      const unhandled = envThreadList.filter(
        (t) => !t.archivedAt && !processedThreads.has(t.id) && !archivedNow.has(t.id),
      );
      if (envThreadList.length === 0) {
        writeKept(env, "no-threads", facts.firstSeenAt);
        settle(env, "no-threads");
        continue;
      }
      if (unhandled.length > 0 || blocked) {
        writeKept(
          env,
          blocked ?? "threads-remaining",
          facts.firstSeenAt,
        );
        settle(env, blocked ?? "threads-remaining");
        continue;
      }
      const remaining = liveThreadsOf(env.id);
      if (!apply || remaining.length > 0) {
        // Report mode (nothing is archived) — «готова к удалению».
        summary.ready += 1;
        writeKept(env, blocked ?? "merged-ready", facts.firstSeenAt);
        settle(env, blocked ?? "merged-ready");
        continue;
      }
      {
        // §16.3: every thread of the env is archived — BB frees the copy
        // itself (deferred branch deletion happens in the sweep below
        // once the worktree is actually gone).
        const sizeText = await deps.cmd.run("du", ["-sk", env.path!], {
          timeoutMs: GIT_TIMEOUT_MS,
        });
        const sizeKb =
          sizeText.exitCode === 0
            ? Number(sizeText.stdout.split(/\s+/)[0]) || 0
            : 0;
        summary.removedCopies += 1;
        summary.ready += 1;
        summary.freedKb += sizeKb;
        reportedMem.delete(env.id);
        deps.janitor.upsertItem(
          env.id,
          {
            projectId: env.projectId ?? null,
            path: env.path ?? null,
            branch: env.branchName ?? null,
            threadId: pickThreadId(env),
            state: "removed",
            reason: "removed",
            firstSeenAt: facts.firstSeenAt,
            removedAt: at,
            sizeKb,
          },
          at,
        );
        ctx.definite.add(env.id);
      }
    }

    // «Ветки без копий»: local `bb/` branches merged on origin (ancestor
    // or content-equal) and not checked out anywhere are deleted (apply
    // mode only) — on a *later* run than the copy's own archiving, once
    // BB has freed the worktree. `branch -D` erases the branch's own
    // reflog, where a `reset`-orphaned commit may have its only
    // reference — so the «nothing lost» rule is re-checked over that
    // reflog first (§15, PLUG-195); a failure keeps the branch
    // (`branch-unpushed`, idle over `abandonedAfter` → the «брошено»
    // report). People's other branches and rescue refs under
    // `refs/orchestrator/` are never touched (§16).
    const reportedBranches: {
      name: string;
      envId: string;
      projectId: string | null;
      threadId: string | null;
      isNew: boolean;
    }[] = [];
    for (const {
      fetched,
      root,
      commonDir,
      protectedTargets,
      localBranches,
      openBranches,
      worktreeListFailed,
    } of repoInfos) {
      // A failed `worktree list` cannot prove a branch is open nowhere —
      // `branch -D` would refuse anyway, but the sweep skips entirely.
      if (!fetched || worktreeListFailed) continue;
      // PLUG-197 PX6: every branch row of THIS repo is a definite
      // outcome — the sweep either evaluates the branch or proves it
      // gone. Rows of unswept repos stay unproven and keep their
      // «брошено» announcement.
      for (const b of localBranches) {
        ctx.definite.add(`branch:${commonDir}:${b}`);
      }
      // Ledger rows of branches no longer in THIS repo are closed — a
      // manually deleted branch must not linger in the abandoned list.
      // Rows are keyed `branch:<commonDir>:<name>`, so one repo never
      // closes another's namesake (PLUG-197 PX5).
      const prefix = `branch:${commonDir}:`;
      const present = new Set(localBranches);
      for (const i of deps.janitor.items()) {
        if (
          i.env_id.startsWith(prefix) &&
          !present.has(i.env_id.slice(prefix.length))
        ) {
          ctx.definite.add(i.env_id);
          if (persist) {
            deps.janitor.upsertItem(
              i.env_id,
              { state: "removed", reason: "removed" },
              at,
            );
          }
        }
      }
      for (const branch of localBranches) {
        if (!branch.startsWith(BRANCH_PREFIX)) continue;
        if (cfg.protectedBranches.includes(branch)) continue;
        if (excludedBranches.has(branch)) continue;
        if (openBranches.has(branch)) continue;
        if (!(await shaMergedIn(root, branch, protectedTargets))) continue;
        // §15 «Ветки без копий»: every position of the branch's own
        // reflog must be safe before `branch -D` erases it — checked
        // per commit (PLUG-197: «A + revert A» nets to origin, but A
        // never reached it).
        const tip = (
          await gitOut(deps.cmd, root, [
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${branch}`,
          ])
        )?.trim();
        const safe = tip
          ? await reflogPositionsSafe(
              root,
              [`refs/heads/${branch}`],
              root,
              protectedTargets,
            )
          : "unknown";
        const envId = `branch:${commonDir}:${branch}`;
        if (safe !== "ok") {
          keep(summary, "branch-unpushed");
          // Idleness is the reflog's last write; no reflog file means
          // nothing to erase and no provable age (kept, not reported).
          let lastActivity = 0;
          try {
            lastActivity = statSync(
              join(commonDir, "logs", "refs", "heads", branch),
            ).mtimeMs;
          } catch {
            // no reflog file → no provable idle time
          }
          const abandoned =
            lastActivity > 0 && at - lastActivity > cfg.abandonedAfterMs;
          const prevItem = deps.janitor.item(envId);
          const prevReported = persist
            ? prevItem?.state === "reported"
            : reportedMem.has(envId);
          if (abandoned) {
            reportedMem.add(envId);
            // Attribution: the env that last owned the branch, when the
            // ledger still has it — its thread points at the
            // coordinator for the daily message.
            const owner = deps.janitor
              .items()
              .find((i) => i.branch === branch && i.env_id !== envId);
            reportedBranches.push({
              name: branch,
              envId,
              projectId: owner?.project_id ?? prevItem?.project_id ?? null,
              threadId: owner?.thread_id ?? prevItem?.thread_id ?? null,
              isNew: !prevReported,
            });
          } else {
            reportedMem.delete(envId);
          }
          if (persist) {
            deps.janitor.upsertItem(
              envId,
              {
                branch,
                state: abandoned ? "reported" : "kept",
                reason: "branch-unpushed",
                firstSeenAt: null,
              },
              at,
            );
          }
          continue;
        }
        reportedMem.delete(envId);
        summary.orphanBranches += 1;
        if (apply && cfg.deleteBranches) {
          if (await gitOk(deps.cmd, root, ["branch", "-D", branch])) {
            summary.removedBranches += 1;
          } else {
            keep(summary, "branch-delete-failed");
          }
        }
        // The branch is gone or provably safe — a stale «брошено» row
        // for it closes either way.
        if (persist && deps.janitor.item(envId)) {
          deps.janitor.upsertItem(
            envId,
            {
              state:
                apply && cfg.deleteBranches ? "removed" : "kept",
              reason:
                apply && cfg.deleteBranches ? "removed" : "merged-ready",
              removedAt: apply && cfg.deleteBranches ? at : null,
            },
            at,
          );
        }
      }
      if (apply && (summary.removedCopies > 0 || summary.removedBranches > 0)) {
        await gitOk(deps.cmd, root, ["worktree", "prune"]);
      }
    }

    // Pre-PX5 rows used the bare `branch:<name>` key — no repo in it.
    // They close only when NO swept repo still has the branch: a
    // namesake anywhere keeps the row (and the announcement) alive.
    {
      const stillPresent = new Set(
        repoInfos
          .filter((r) => r.fetched && !r.worktreeListFailed)
          .flatMap((r) => r.localBranches),
      );
      for (const i of deps.janitor.items()) {
        if (!i.env_id.startsWith("branch:")) continue;
        const rest = i.env_id.slice("branch:".length);
        // New-format rows carry `:<commonDir>:` (an absolute path or a
        // `:` inside) — they are owned by their repo's sweep above.
        if (rest.startsWith("/") || rest.includes(":")) continue;
        if (stillPresent.has(rest)) continue;
        ctx.definite.add(i.env_id);
        if (persist) {
          deps.janitor.upsertItem(
            i.env_id,
            { state: "removed", reason: "removed" },
            at,
          );
        }
      }
    }

    // «Отчёт, без удаления»: abandoned copies collected this run — also
    // used by the coordinator message below (§16.3: only *new* ones).
    for (const { env, reason, threadId, isNew } of reportedNow) {
      const item = deps.janitor.item(env.id);
      summary.reported.push({
        envId: env.id,
        projectId: env.projectId ?? null,
        path: env.path ?? null,
        branch: env.branchName ?? item?.branch ?? null,
        threadId: item?.thread_id ?? threadId,
        reason,
        isNew,
      });
    }
    // «Ветки без копий» abandoned entries collected by the sweep — the
    // pseudo env id `branch:<commonDir>:<name>` keeps them out of real
    // env rows.
    for (const b of reportedBranches) {
      summary.reported.push({
        envId: b.envId,
        projectId: b.projectId,
        path: null,
        branch: b.name,
        threadId: b.threadId,
        reason: "branch-unpushed",
        isNew: b.isNew,
      });
    }
    return ctx;
  };
  /** §16.3: at most one «брошено» message per coordinator per day, and
   * only while *newly* abandoned envs appear. Announcement state is
   * tracked separately from the reported ledger — an env suppressed by
   * the daily watermark stays unannounced and joins the next day's
   * message rather than being dropped. Other threads are never
   * written to. The watermark and the announced set live in
   * `janitor_meta` (service state — written in report mode too, so a
   * plugin restart cannot resend a message early); item rows stay
   * apply-only. */
  const notifyCoordinators = async (
    summary: JanitorRunSummary,
    ctx: { definite: Set<string>; allEnvIds: Set<string> },
  ): Promise<void> => {
    let announced: Set<string>;
    try {
      announced = new Set([
        ...announcedMem,
        ...(JSON.parse(
          deps.janitor.meta("announcedAbandoned") ?? "[]",
        ) as string[]),
      ]);
    } catch {
      announced = new Set(announcedMem);
    }
    // §15: a copy that stopped being abandoned leaves the announced
    // list — but only when this run *proved* it (a definite outcome or
    // the env gone entirely). Transient failures (a failed fetch, an
    // unreadable thread list, a missing path) leave the list
    // untouched — otherwise the next run would re-announce the same
    // envs and the once-a-day limit would be broken (PLUG-192).
    const current = new Set(summary.reported.map((i) => i.envId));
    for (const id of [...announced]) {
      // A `branch:<commonDir>:<name>` id is never an env — «gone from
      // allEnvIds» cannot clear it. It drops only on a run that really
      // swept its repo (PLUG-197 PX6: a failed fetch must not cause a
      // repeat announcement).
      const proven = id.startsWith("branch:")
        ? ctx.definite.has(id)
        : ctx.definite.has(id) || !ctx.allEnvIds.has(id);
      if (!current.has(id) && proven) {
        announced.delete(id);
        announcedMem.delete(id);
      }
    }
    const persistAnnounced = () =>
      deps.janitor.setMeta(
        "announcedAbandoned",
        JSON.stringify([...announced].slice(-2000)),
      );
    if (!summary.reported.length) {
      persistAnnounced();
      return;
    }
    const fresh = summary.reported.filter((i) => !announced.has(i.envId));
    if (!fresh.length) {
      persistAnnounced();
      return;
    }
    const byCoordinator = new Map<string, JanitorReportedItem[]>();
    for (const item of fresh) {
      const tid = item.threadId;
      const coordinator = tid
        ? deps.store.byThreadId(tid)?.coordinator_thread_id
        : undefined;
      if (!coordinator) continue;
      const list = byCoordinator.get(coordinator) ?? [];
      list.push(item);
      byCoordinator.set(coordinator, list);
    }
    for (const [coordinator, items] of byCoordinator) {
      const key = `dailyNotify:${coordinator}`;
      const last = Math.max(
        Number(deps.janitor.meta(key) ?? 0),
        notifyMem.get(coordinator) ?? 0,
      );
      if (now() - last < DAY_MS) continue;
      const list = items
        .slice(0, 8)
        .map((i) => i.branch ?? i.path ?? i.envId)
        .join(", ");
      const more =
        items.length > 8 ? ` и ещё ${items.length - 8}` : "";
      try {
        await deps.threads.send({
          threadId: coordinator,
          mode: "queue-if-active",
          input: [
            {
              type: "text",
              text:
                `[orchestrator] уборщик: новых брошенных ` +
                `${items.length} копий: ${list}${more} — ` +
                `разбор: bb orchestrator janitor report`,
              mentions: [],
            },
          ],
        });
        notifyMem.set(coordinator, now());
        for (const item of items) {
          announced.add(item.envId);
          announcedMem.add(item.envId);
        }
        deps.janitor.setMeta(key, String(now()));
        persistAnnounced();
      } catch (e) {
        log.warn?.(`orchestrator janitor: notify ${coordinator}: ${message(e)}`);
      }
    }
  };

  /**
   * §16.4: build the rescue commit for a dirty copy whose thread was
   * just archived. Tracked/staged state comes from `git stash create`;
   * untracked files go through a temporary index into a third-parent
   * commit — the resulting ref is a standard stash object restorable by
   * `git stash apply`. The untracked list can run to tens of thousands
   * of paths: it is fed via `--pathspec-from-file` (a NUL-separated temp
   * file), never argv. `partial` marks a best-effort snapshot — some
   * content could not be saved and the coordinator is told so.
   */
  const rescueCommit = async (
    path: string,
    threadId: string,
  ): Promise<{ sha: string | null; partial: boolean }> => {
    const head = (
      await gitOut(deps.cmd, path, ["rev-parse", "--verify", "HEAD"])
    )?.trim();
    if (!head) return { sha: null, partial: false };
    const w = (
      await gitOut(deps.cmd, path, ["stash", "create"])
    )?.trim() || null;
    const untracked =
      (await gitOut(deps.cmd, path, [
        "ls-files",
        "-z",
        "-o",
        "--exclude-standard",
      ])) ?? "";
    const uFiles = untracked.split("\0").filter(Boolean);
    if (!uFiles.length) return { sha: w, partial: false };
    const tag = `${process.pid}-${threadId}-${now()}`;
    const tmpIndex = join(tmpdir(), `jan-rescue-${tag}`);
    const tmpPaths = join(tmpdir(), `jan-rescue-paths-${tag}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    const partialW = { sha: w, partial: true };
    try {
      writeFileSync(tmpPaths, uFiles.join("\0"));
      const ready = await gitOut(deps.cmd, path, ["read-tree", "--empty"], env);
      const added =
        ready === null
          ? null
          : await gitOut(
              deps.cmd,
              path,
              [
                "add",
                `--pathspec-from-file=${tmpPaths}`,
                "--pathspec-file-nul",
              ],
              env,
            );
      if (added === null) return partialW;
      const uTree = (
        await gitOut(deps.cmd, path, ["write-tree"], env)
      )?.trim();
      if (!uTree) return partialW;
      const uSha = (
        await gitOut(deps.cmd, path, [
          "commit-tree",
          uTree,
          "-m",
          `orchestrator rescue (untracked) ${threadId}`,
        ])
      )?.trim();
      if (!uSha) return partialW;
      if (!w) {
        // Only untracked work: build a stash-shaped commit so the same
        // `git stash apply` restore command works — index commit first,
        // then the stash head with the untracked commit as third parent.
        const iTree = (
          await gitOut(deps.cmd, path, ["write-tree"])
        )?.trim();
        if (!iTree) return { sha: uSha, partial: true };
        const iSha = (
          await gitOut(deps.cmd, path, [
            "commit-tree",
            iTree,
            "-p",
            head,
            "-m",
            `orchestrator rescue (index) ${threadId}`,
          ])
        )?.trim();
        return {
          sha:
            (
              await gitOut(deps.cmd, path, [
                "commit-tree",
                iTree,
                "-p",
                head,
                "-p",
                iSha ?? head,
                "-p",
                uSha,
                "-m",
                `orchestrator rescue ${threadId}`,
              ])
            )?.trim() ?? uSha,
          partial: false,
        };
      }
      const wTree = (
        await gitOut(deps.cmd, path, ["rev-parse", `${w}^{tree}`])
      )?.trim();
      const wIndex = (
        await gitOut(deps.cmd, path, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${w}^2`,
        ])
      )?.trim();
      if (!wTree || !wIndex) return partialW;
      return {
        sha:
          (
            await gitOut(deps.cmd, path, [
              "commit-tree",
              wTree,
              "-p",
              head,
              "-p",
              wIndex,
              "-p",
              uSha,
              "-m",
              `orchestrator rescue ${threadId}`,
            ])
          )?.trim() ?? w,
        partial: false,
      };
    } finally {
      for (const f of [tmpIndex, tmpPaths]) {
        try {
          rmSync(f, { force: true });
        } catch {
          // temp file removal failed — harmless
        }
      }
    }
  };

  /**
   * §16.4: `thread.archived` for an executor thread — while BB still
   * holds the copy (the ~5-minute window), a dirty state is committed
   * to `refs/orchestrator/rescue/<thread>` and the coordinator gets a
   * restore command into a *new* worktree (never the main checkout,
   * where somebody else's work may be in flight). Rescue is
   * unconditional: it does not depend on `janitor.enabled` or a valid
   * config — a user who keeps the janitor off still gets the safety
   * net. Clean copies and non-executor threads are no-ops; the janitor
   * never deletes refs under `refs/orchestrator/`.
   */
  const onThreadArchived = async (thread: {
    id: string;
    environmentId?: string | null;
    parentThreadId?: string | null;
    sourceThreadId?: string | null;
    originPluginId?: string | null;
  }): Promise<void> => {
    // Scope check when the event carries the fields; absent fields mean
    // «unknown» — rescuing a dirty copy is harmless, so proceed.
    const fieldsKnown =
      thread.originPluginId !== undefined ||
      thread.parentThreadId !== undefined ||
      thread.sourceThreadId !== undefined;
    const worker =
      thread.originPluginId === "tasks" ||
      !!thread.parentThreadId ||
      !!thread.sourceThreadId;
    if (fieldsKnown && !worker) return;
    const envId = thread.environmentId;
    if (!envId) return;
    const env = await showEnvironment(envId);
    const path = env?.path;
    if (!path || !existsSync(path)) return;
    const statusText = await gitOut(deps.cmd, path, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (statusText === null || !statusText.trim()) return;
    const coordinator =
      deps.store.byThreadId(thread.id)?.coordinator_thread_id ??
      thread.parentThreadId ??
      null;
    const tellCoordinator = async (text: string) => {
      if (!coordinator) return;
      try {
        await deps.threads.send({
          threadId: coordinator,
          mode: "queue-if-active",
          input: [{ type: "text", text, mentions: [] }],
        });
      } catch (e) {
        log.warn?.(
          `orchestrator janitor: rescue notify ${coordinator}: ${message(e)}`,
        );
      }
    };
    const { sha, partial } = await rescueCommit(path, thread.id);
    const ref = `refs/orchestrator/rescue/${thread.id}`;
    if (
      !sha ||
      !(await gitOk(deps.cmd, path, ["update-ref", ref, sha]))
    ) {
      // The archive still happens — without the line the work is gone
      // silently (PLUG-185): a failed or partial rescue is reported.
      await tellCoordinator(
        `[orchestrator] исполнитель ${thread.id} заархивирован ` +
          `с несохранённой работой, снимок НЕ удался — копия ${path} ` +
          `уходит под уборку BB, проверь вручную`,
      );
      return;
    }
    const common = (
      await gitOut(deps.cmd, path, ["rev-parse", "--git-common-dir"])
    )?.trim();
    const commonDir = common
      ? isAbsolute(common)
        ? common
        : join(path, common)
      : path;
    const repoRoot =
      basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
    const rescueDir = join(
      dirname(repoRoot),
      `${basename(repoRoot)}-rescue-${thread.id}`,
    );
    await tellCoordinator(
      `[orchestrator] исполнитель ${thread.id} заархивирован ` +
        `с несохранённой работой` +
        (partial
          ? " (снимок неполный — часть файлов не сохранилась)"
          : "") +
        ` — снимок: ${ref}. ` +
        `Восстановление в новую копию: git -C ${repoRoot} worktree add ` +
        `${rescueDir} ${ref}^1 && git -C ${rescueDir} stash apply ${ref}`,
    );
  };

  const report = async (): Promise<JanitorReport> => {
    const cfgLoad = await deps.loadConfig();
    const items = deps.janitor.items();
    return {
      config: cfgLoad.config,
      configErrors: cfgLoad.errors,
      lastRun: deps.janitor.latestRun(),
      items,
      abandoned: items
        .filter((i) => i.state === "reported")
        .map((i) => ({
          envId: i.env_id,
          projectId: i.project_id,
          path: i.path,
          branch: i.branch,
          threadId: i.thread_id,
          reason: i.reason ?? "",
        })),
    };
  };

  return { run, report, onThreadArchived };
}
