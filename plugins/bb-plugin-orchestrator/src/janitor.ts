/**
 * §15 janitor — background cleanup of merged executor copies, their
 * branches and threads (ADR-0024, owner decision 11.11). Deletes only
 * what is provably merged on `origin` and clean; unmerged or dirty copies
 * are only reported.
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
  statSync,
} from "node:fs";
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
const CLEANUP_TIMEOUT_MS = 120_000;
/** §15 cond 4: threads in these statuses keep their copy. */
const BLOCKING_THREAD_STATUSES = new Set(["active", "pending"]);
const BRANCH_PREFIX = "bb/";

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
  /** §15 cond 5 seam — default scans `/proc/<pid>/cwd` of the current user. */
  hasProcessIn?: (path: string) => Promise<boolean>;
}

interface EnvDto {
  id: string;
  projectId?: string | null;
  path?: string | null;
  branchName?: string | null;
  mergeBaseBranch?: string | null;
  status?: string | null;
  environmentProviderId?: string | null;
  managed?: boolean;
  createdAt?: number | null;
  updatedAt?: number | null;
}

interface EnvThreadDto {
  id: string;
  status?: string | null;
  archivedAt?: number | null;
  updatedAt?: number | null;
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
): Promise<string | null> {
  const res = await cmd.run("git", ["-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
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
 * `realpath`.
 */
export function defaultHasProcessIn(root: string): boolean {
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
    return false;
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
): { worktrees: { path: string; branch: string | null }[] } {
  const worktrees: { path: string; branch: string | null }[] = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null };
      worktrees.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return { worktrees };
}

export function createJanitor(deps: JanitorDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? {};
  const hasProcessIn =
    deps.hasProcessIn ?? (async (p: string) => defaultHasProcessIn(p));
  // §15: «--dry-run и mode: report в базу ничего не пишут, кроме отчёта
  // прогона». The merged-sighting streak and the daily-notify watermark
  // still work inside such runs — kept in memory only, per process.
  const firstSeenMem = new Map<string, number>();
  const notifyMem = new Map<string, number>();

  const listEnvironments = async (): Promise<EnvDto[]> =>
    runJson<EnvDto[]>(deps.bbCli, ["environment", "list", "--json"], {
      timeoutMs: 60_000,
    });

  const envThreads = async (envId: string): Promise<EnvThreadDto[] | null> => {
    try {
      return await runJson<EnvThreadDto[]>(
        deps.bbCli,
        [
          "thread",
          "list",
          "--environment",
          envId,
          "--include-archived",
          "--include-hidden",
          "--json",
        ],
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
   * §15 cond 2: the copy's own commits — commits of its branch after
   * the branch's creation point. The branch reflog's oldest entry
   * («branch: Created from …») names the sha the branch started at;
   * `rev-list <sha>..<branch>` counts everything it gained since. With
   * no reflog (expired, or `ref` unborn), the env's `createdAt` is
   * compared against commit times (`--max-age`). No data at all → no
   * own commits, per spec.
   */
  const countOwnCommits = async (
    env: EnvDto,
    path: string,
    ownBranch: string | undefined,
  ): Promise<number> => {
    const ref = ownBranch?.trim() || env.branchName?.trim() || "HEAD";
    const reflog = await gitOut(deps.cmd, path, [
      "reflog",
      "show",
      ref,
      "--format=%H %gs",
    ]);
    if (reflog) {
      const oldest = reflog
        .trim()
        .split("\n")
        .filter(Boolean)
        .pop();
      if (oldest && /Created from /.test(oldest)) {
        const creationSha = oldest.slice(0, oldest.indexOf(" "));
        if (/^[0-9a-f]{40}$/i.test(creationSha)) {
          const count = (
            await gitOut(deps.cmd, path, [
              "rev-list",
              "--count",
              `${creationSha}..${ref}`,
            ])
          )?.trim();
          if (count) return Number(count) || 0;
        }
      }
    }
    const createdAt = env.createdAt;
    if (typeof createdAt === "number" && createdAt > 0) {
      const count = (
        await gitOut(deps.cmd, path, [
          "rev-list",
          "--count",
          ref,
          `--max-age=${Math.floor(createdAt / 1000)}`,
        ])
      )?.trim();
      if (count) return Number(count) || 0;
    }
    return 0;
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
    };
    const apply = effective.enabled && effective.mode === "apply" && !opts.dryRun;
    summary.applied = apply;

    const runId = deps.janitor.startRun(at);
    summary.runId = runId;

    const finish = (error?: string) => {
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
      await runBody(effective, apply, summary);
      // A --dry-run preview never writes to the coordinator either.
      if (!opts.dryRun) await notifyCoordinators(summary, apply);
      finish();
    } catch (e) {
      const text = message(e);
      summary.errors.push(text);
      finish(text);
    }
    return summary;
  };

  const runBody = async (
    cfg: JanitorConfig,
    apply: boolean,
    summary: JanitorRunSummary,
  ): Promise<void> => {
    const at = now();
    const exclude = new Set(cfg.excludeProjects);
    const envs = (await listEnvironments()).filter(
      (e) =>
        e.managed === true &&
        e.environmentProviderId === "git-worktree" &&
        e.status === "ready" &&
        typeof e.path === "string" &&
        e.path.length > 0 &&
        !exclude.has(e.projectId ?? ""),
    );

    const delegatedThreads = new Set(
      deps.store
        .listActive()
        .map((r) => r.thread_id)
        .filter((t): t is string => typeof t === "string"),
    );

    // Group copies by repository: one `git fetch --prune origin` per repo
    // per run; a failed fetch skips the repo entirely (§15).
    const repos = new Map<string, { root: string; envs: EnvDto[] }>();
    for (const env of envs) {
      const common = await gitOut(deps.cmd, env.path!, [
        "rev-parse",
        "--git-common-dir",
      ]);
      if (common === null) {
        keep(summary, "not-a-repo");
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

    const reportedNow: { env: EnvDto; reason: string; threadId: string | null }[] =
      [];

    for (const { root, envs: repoEnvs } of repos.values()) {
      const fetched = await gitOk(deps.cmd, root, [
        "fetch",
        "--prune",
        "origin",
      ]);
      if (!fetched) {
        keep(summary, "fetch-failed", repoEnvs.length);
        // The run never saw these copies merged, so their «влита» streak
        // cannot count this pass — the clock pauses and restarts on the
        // next verified-merged run.
        for (const env of repoEnvs) {
          if (apply) {
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
        }
        continue;
      }

      const protectedTargets: string[] = [];
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
          protectedTargets.push(ref);
        }
      }

      const worktreeText =
        (await gitOut(deps.cmd, root, ["worktree", "list", "--porcelain"])) ??
        "";
      const { worktrees } = parseWorktreeList(worktreeText);
      const checkedOut = new Set(
        worktrees.map((w) => w.branch).filter((b): b is string => !!b),
      );

      // Local branch names feed the «ветки без копий» sweep below; the
      // per-copy merge check (§15) only needs each copy's own branch.
      // `ancestorCache` carries positive results between copies.
      const localBranches: { name: string }[] = (
        (await gitOut(deps.cmd, root, [
          "for-each-ref",
          "refs/heads",
          "--format=%(refname:short)",
        ])) ?? ""
      )
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => ({ name: l }));
      const ancestorCache = new Map<string, boolean>();

      let pruned = false;
      for (const env of repoEnvs) {
        if (
          await evalEnv(
            cfg,
            apply,
            summary,
            env,
            root,
            protectedTargets,
            ancestorCache,
            checkedOut,
            delegatedThreads,
            reportedNow,
          )
        ) {
          pruned = true;
        }
      }

      // «Ветки без копий»: local `bb/` branches merged on origin and not
      // checked out anywhere are deleted (apply mode only); people's other
      // branches are never touched. The occupancy list is refreshed when
      // this run already removed copies — their branches left the
      // worktree list with them.
      let openBranches = checkedOut;
      if (apply && summary.removedCopies > 0) {
        await gitOk(deps.cmd, root, ["worktree", "prune"]);
        const fresh = parseWorktreeList(
          (await gitOut(deps.cmd, root, [
            "worktree",
            "list",
            "--porcelain",
          ])) ?? "",
        );
        openBranches = new Set(
          fresh.worktrees
            .map((w) => w.branch)
            .filter((b): b is string => !!b),
        );
      }
      for (const { name: branch } of localBranches) {
        if (!branch.startsWith(BRANCH_PREFIX)) continue;
        if (cfg.protectedBranches.includes(branch)) continue;
        if (openBranches.has(branch)) continue;
        let merged = protectedTargets.length > 0;
        if (merged) {
          merged = false;
          for (const t of protectedTargets) {
            if (
              await gitOk(deps.cmd, root, [
                "merge-base",
                "--is-ancestor",
                branch,
                t,
              ])
            ) {
              merged = true;
              break;
            }
          }
        }
        if (!merged) continue;
        summary.orphanBranches += 1;
        if (apply && cfg.deleteBranches) {
          if (await gitOk(deps.cmd, root, ["branch", "-D", branch])) {
            summary.removedBranches += 1;
          } else {
            keep(summary, "branch-delete-failed");
          }
        }
      }
      if (apply && (pruned || summary.removedBranches > 0)) {
        await gitOk(deps.cmd, root, ["worktree", "prune"]);
      }
    }

    // «Отчёт, без удаления» (§15): abandoned copies collected this run —
    // also used by the daily coordinator message below.
    for (const { env, reason, threadId } of reportedNow) {
      const item = deps.janitor.item(env.id);
      summary.reported.push({
        envId: env.id,
        projectId: env.projectId ?? null,
        path: env.path ?? null,
        branch: env.branchName ?? item?.branch ?? null,
        threadId: item?.thread_id ?? threadId,
        reason,
      });
    }
  };

  const evalEnv = async (
    cfg: JanitorConfig,
    apply: boolean,
    summary: JanitorRunSummary,
    env: EnvDto,
    repoRoot: string,
    protectedTargets: string[],
    ancestorCache: Map<string, boolean>,
    checkedOut: Set<string>,
    delegatedThreads: Set<string>,
    reportedNow: { env: EnvDto; reason: string; threadId: string | null }[],
  ): Promise<boolean> => {
    const at = now();
    const path = env.path!;
    // §15: report-mode and --dry-run passes write nothing to the db —
    // only janitor_runs (the run's own report). The merged-sighting
    // streak then lives in `firstSeenMem` for this process.
    const persist = apply;
    const prev = deps.janitor.item(env.id);
    const upsert = (
      state: JanitorItemState,
      reason: string,
      extra: {
        firstSeenAt?: number | null;
        removedAt?: number | null;
        sizeKb?: number | null;
      } = {},
    ) =>
      deps.janitor.upsertItem(
        env.id,
        {
          projectId: env.projectId ?? null,
          path,
          branch: env.branchName ?? null,
          threadId,
          state,
          reason,
          ...(extra.firstSeenAt !== undefined
            ? { firstSeenAt: extra.firstSeenAt }
            : {}),
          ...(extra.removedAt !== undefined
            ? { removedAt: extra.removedAt }
            : {}),
          ...(extra.sizeKb !== undefined ? { sizeKb: extra.sizeKb } : {}),
        },
        at,
      );

    const threads = await envThreads(env.id);
    const liveThreads = (threads ?? []).filter((t) => !t.archivedAt);
    const threadId =
      liveThreads.find((t) => delegatedThreads.has(t.id))?.id ??
      liveThreads[0]?.id ??
      threads?.[0]?.id ??
      prev?.thread_id ??
      null;
    // «Тред простаивает» — idleness is the threads', not the env record's:
    // env.updatedAt moves on lifecycle events, not user work. An env
    // without threads falls back to its own updatedAt.
    const lastActivity = (threads ?? []).length
      ? Math.max(...(threads ?? []).map((t) => t.updatedAt ?? 0))
      : (env.updatedAt ?? 0);
    const abandoned = at - lastActivity > cfg.abandonedAfterMs;
    const allArchived = (threads ?? []).length > 0 && liveThreads.length === 0;

    const fail = (state: JanitorItemState, reason: string): false => {
      if (persist) upsert(state, reason, { firstSeenAt: null });
      else firstSeenMem.delete(env.id);
      keep(summary, reason);
      if (state === "reported") reportedNow.push({ env, reason, threadId });
      return false;
    };

    if (!existsSync(path)) {
      return fail("kept", "missing-path");
    }

    // ── merge check (§15): HEAD and the copy's own branch on origin ──
    const head = (
      await gitOut(deps.cmd, path, ["rev-parse", "--verify", "HEAD"])
    )?.trim();
    if (!head) return fail("kept", "no-head");
    const ownBranch = (
      await gitOut(deps.cmd, path, ["branch", "--show-current"])
    )?.trim();

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

    // §15: HEAD plus the env's own branch (`branchName`) when it exists
    // and is not the checked-out one — an executor who switched the
    // copy to another branch still loses nothing unmerged. Other local
    // branches of the shared repository are not the copy's and are not
    // checked here.
    const shas = [head];
    const envBranch = env.branchName?.trim();
    if (envBranch && envBranch !== ownBranch) {
      const sha = (
        await gitOut(deps.cmd, repoRoot, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${envBranch}`,
        ])
      )?.trim();
      if (sha) shas.push(sha);
    }
    const targets = await targetRefs(env, repoRoot, protectedTargets);
    let merged = targets.length > 0;
    if (merged) {
      for (const sha of new Set(shas)) {
        let ok = ancestorCache.get(sha) === true;
        if (!ok) {
          for (const t of targets) {
            if (
              await gitOk(deps.cmd, repoRoot, [
                "merge-base",
                "--is-ancestor",
                sha,
                t,
              ])
            ) {
              ok = true;
              break;
            }
          }
          // Only positive results are shared: a miss here may still be an
          // ancestor of another env's mergeBaseBranch.
          if (ok) ancestorCache.set(sha, true);
        }
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
      return fail(
        reason.startsWith("abandoned") ? "reported" : "kept",
        reason,
      );
    }

    // The copy stays merged from the first run that saw it so; an
    // unmerged sighting between runs resets the clock via `fail` above.
    const firstSeenAt =
      prev?.first_seen_at ?? firstSeenMem.get(env.id) ?? at;
    if (!persist) firstSeenMem.set(env.id, firstSeenAt);

    // §15 cond 2: own commits are the copy's branch commits after its
    // creation point — not «HEAD differs from the base tip». A copy at
    // (or behind) the tip with no commits only looks merged; it goes
    // once its thread idles past abandonedAfter, not on a fresh thread.
    const ownWork = (await countOwnCommits(env, path, ownBranch)) > 0;

    const threadsUnknown = threads === null;
    const threadsBlocking = liveThreads.some((t) =>
      BLOCKING_THREAD_STATUSES.has(t.status ?? ""),
    );
    let interactionsPending = false;
    for (const t of liveThreads) {
      if (await hasPendingInteraction(t.id)) {
        interactionsPending = true;
        break;
      }
    }
    const delegated = liveThreads.some((t) => delegatedThreads.has(t.id));
    const processInside = await hasProcessIn(path);

    let reason: string | null = null;
    if (at - firstSeenAt < cfg.afterMergeMs) reason = "merged-wait";
    else if (!ownWork && !abandoned) reason = "no-commits-fresh";
    else if (statusFailed) reason = "status-failed";
    else if (dirty) reason = abandoned ? "abandoned-dirty" : "dirty";
    else if (unfinished) reason = "unfinished-op";
    else if (threadsUnknown) reason = "threads-unknown";
    else if (threadsBlocking) reason = "threads-active";
    else if (interactionsPending) reason = "interactions-pending";
    else if (delegated) reason = "delegation-active";
    else if (processInside) reason = "process-inside";

    if (reason !== null) {
      const reported = reason.startsWith("abandoned");
      if (persist) upsert(reported ? "reported" : "kept", reason, { firstSeenAt });
      keep(summary, reason);
      if (reported) reportedNow.push({ env, reason, threadId });
      return false;
    }

    // Fully eligible: merged for afterMerge, own work or idle thread,
    // clean, no live thread/process.
    summary.ready += 1;
    if (!apply) {
      keep(summary, "merged-ready");
      return false;
    }

    const sizeText = await deps.cmd.run("du", ["-sk", path], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const sizeKb =
      sizeText.exitCode === 0
        ? Number(sizeText.stdout.split(/\s+/)[0]) || 0
        : 0;

    // §15 action: archive the env's threads, then `bb environment
    // cleanup`. A failed archive rolls back the threads already
    // archived and leaves the copy alone; a refused cleanup unarchives
    // the threads back.
    const archivedNow: string[] = [];
    let archiveFailed = false;
    for (const t of liveThreads) {
      const res = await deps.bbCli.run(["thread", "archive", t.id]);
      if (res.exitCode === 0) {
        archivedNow.push(t.id);
      } else {
        archiveFailed = true;
        break;
      }
    }
    if (archiveFailed) {
      for (const t of archivedNow) {
        await deps.bbCli.run(["thread", "unarchive", t]);
      }
      upsert("kept", "archive-failed", { firstSeenAt });
      keep(summary, "archive-failed");
      return false;
    }
    const cleanup = await deps.bbCli.run(
      ["environment", "cleanup", env.id],
      { timeoutMs: CLEANUP_TIMEOUT_MS },
    );
    if (cleanup.exitCode !== 0) {
      for (const t of archivedNow) {
        await deps.bbCli.run(["thread", "unarchive", t]);
      }
      const stderr = (cleanup.stderr || cleanup.stdout).trim().slice(0, 120);
      upsert("kept", `cleanup-refused${stderr ? `: ${stderr}` : ""}`, {
        firstSeenAt,
      });
      keep(summary, "cleanup-refused");
      return false;
    }

    summary.removedCopies += 1;
    summary.archivedThreads += archivedNow.length;
    summary.freedKb += sizeKb;
    upsert("removed", "removed", {
      firstSeenAt,
      removedAt: at,
      sizeKb,
    });

    // The copy's own branch — captured before the cleanup removed the
    // worktree. The checked-out branch wins over the env record: an
    // executor that switched branches still loses nothing unmerged.
    const branch = ownBranch || env.branchName?.trim();
    if (cfg.deleteBranches && branch) {
      await gitOk(deps.cmd, repoRoot, ["worktree", "prune"]);
      const fresh = parseWorktreeList(
        (await gitOut(deps.cmd, repoRoot, [
          "worktree",
          "list",
          "--porcelain",
        ])) ?? "",
      );
      const stillOpen = new Set(
        fresh.worktrees.map((w) => w.branch).filter((b): b is string => !!b),
      );
      if (
        !cfg.protectedBranches.includes(branch) &&
        !stillOpen.has(branch) &&
        (await gitOk(deps.cmd, repoRoot, ["branch", "-D", branch]))
      ) {
        summary.removedBranches += 1;
      }
    }
    return true;
  };

  /** §15: at most one «брошено» message per coordinator per day, listing
   * the envs of his delegations. Other threads are never written to. */
  const notifyCoordinators = async (
    summary: JanitorRunSummary,
    persist: boolean,
  ): Promise<void> => {
    if (!summary.reported.length) return;
    const byCoordinator = new Map<string, JanitorReportedItem[]>();
    for (const item of summary.reported) {
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
                `[orchestrator] уборщик: брошено ${items.length} ` +
                `копий${more ? ` (всего)` : ""}: ${list}${more} — ` +
                `разбор: bb orchestrator janitor report`,
              mentions: [],
            },
          ],
        });
        notifyMem.set(coordinator, now());
        if (persist) deps.janitor.setMeta(key, String(now()));
      } catch (e) {
        log.warn?.(`orchestrator janitor: notify ${coordinator}: ${message(e)}`);
      }
    }
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

  return { run, report };
}
