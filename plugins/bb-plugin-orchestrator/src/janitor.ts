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
 * env of the cascade. `scope` picks the candidates: `workers` (default)
 * covers dispatch threads (`originPluginId=tasks`) and threads with a
 * parent; `all` also covers root chats. A `bb/` branch is deleted only on
 * a later run, once its copy no longer exists. Squash/rebase merges get
 * a second mergedness signal: `git cherry origin/<base> <branch>` with no
 * `+` lines.
 *
 * §16.4: on `thread.archived` of an executor whose copy is still dirty,
 * the state is saved into `refs/orchestrator/rescue/<thr>` (stash object
 * including untracked files via a temporary index) and the coordinator
 * gets a restore command. The janitor never deletes refs under
 * `refs/orchestrator/`.
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

interface ThreadDto {
  id: string;
  status?: string | null;
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
   * §16.3 cond 2: the copy's own commits — commits of its branch after
   * the branch's creation point. The branch reflog's oldest entry
   * («branch: Created from …») names the sha the branch started at;
   * `rev-list <sha>..<branch>` counts everything it gained since. With
   * no reflog data at all → no own commits, per spec.
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
    return 0;
  };

  /**
   * §16.3 «влита»: a sha is merged into a remote-tracking target when it
   * is an ancestor — or when every commit it adds is patch-equivalent on
   * the target (`git cherry` prints only «-» lines, no «+»). Squash and
   * rebase merges leave the sha unreachable but equivalent; a failed
   * cherry proves nothing, so it never counts.
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
    const persist = apply;
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
    const envById = new Map(envs.map((e) => [e.id, e]));

    const delegatedThreads = new Set(
      deps.store
        .listActive()
        .map((r) => r.thread_id)
        .filter((t): t is string => typeof t === "string"),
    );

    // §16.3: one global thread list builds the cascade graph — children
    // via `parentThreadId`, hidden forks via `sourceThreadId`.
    const allThreads = await listThreads();
    const threadById = new Map<string, ThreadDto>();
    const threadsByEnv = new Map<string, ThreadDto[]>();
    const childrenOf = new Map<string, ThreadDto[]>();
    for (const t of allThreads ?? []) {
      threadById.set(t.id, t);
      if (t.environmentId) {
        const list = threadsByEnv.get(t.environmentId) ?? [];
        list.push(t);
        threadsByEnv.set(t.environmentId, list);
      }
      for (const p of [t.parentThreadId, t.sourceThreadId]) {
        if (p) {
          const list = childrenOf.get(p) ?? [];
          list.push(t);
          childrenOf.set(p, list);
        }
      }
    }
    const liveThreadsOf = (envId: string): ThreadDto[] =>
      (threadsByEnv.get(envId) ?? []).filter(
        (t) => !t.archivedAt && !archivedNow.has(t.id),
      );

    const pickThreadId = (env: EnvDto): string | null => {
      const list = threadsByEnv.get(env.id) ?? [];
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
      fetched: boolean;
      protectedTargets: string[];
      localBranches: string[];
      openBranches: Set<string>;
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
        fetched: await gitOk(deps.cmd, root, ["fetch", "--prune", "origin"]),
        protectedTargets: [],
        localBranches: [],
        openBranches: new Set(),
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
        info.openBranches = new Set(
          parseWorktreeList(
            (await gitOut(deps.cmd, root, [
              "worktree",
              "list",
              "--porcelain",
            ])) ?? "",
          )
            .worktrees.map((w) => w.branch)
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
    if (persist) {
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
      if (allThreads === null) return bad("threads-unknown");
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

      const envThreadList = threadsByEnv.get(env.id) ?? [];
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
      if (await hasProcessIn(path)) return after("process-inside");
      return { ready: true, reason: "ready", reported: false, firstSeenAt };
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
        const p = threadById.get(pid);
        if (!p) return false;
        if (!p.archivedAt && isCandidate(p)) return true;
        cur = p;
      }
      return false;
    };
    const isCascadeRoot = (t: ThreadDto): boolean =>
      isCandidate(t) && !hasCandidateAncestor(t);

    const cascadeOf = (root: ThreadDto): ThreadDto[] => {
      const out: ThreadDto[] = [];
      const seen = new Set<string>([root.id]);
      const queue = [root];
      while (queue.length) {
        const t = queue.shift()!;
        out.push(t);
        for (const c of childrenOf.get(t.id) ?? []) {
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
     * §16.3: evaluate one cascade — every unarchived member's env must
     * pass conditions 1–5 and no member may have a blocking status, an
     * active delegation or a pending request. A pass archives all
     * members (children first, the root last); a failed archive rolls
     * the already-archived members back. `bb environment cleanup` is
     * never called — BB frees the copy once every env thread is archived.
     */
    const evalCascade = async (root: ThreadDto): Promise<void> => {
      const members = cascadeOf(root).filter(
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
      for (const t of members) {
        if (BLOCKING_THREAD_STATUSES.has(t.status ?? "")) {
          note("threads-active", t.environmentId ?? null);
          return;
        }
        if (delegatedThreads.has(t.id)) {
          note("delegation-active", t.environmentId ?? null);
          return;
        }
      }
      for (const t of members) {
        if (await hasPendingInteraction(t.id)) {
          note("interactions-pending", t.environmentId ?? null);
          return;
        }
      }
      for (const e of memberEnvs.values()) {
        const f = await envFacts(e);
        if (!f.ready) {
          note(f.reason, e.id);
          return;
        }
      }
      if (!apply) return; // report mode: counted via «ready» below
      const done: string[] = [];
      for (const t of [...members].reverse()) {
        const res = await deps.bbCli.run(["thread", "archive", t.id]);
        if (res.exitCode !== 0) {
          // §15: a failed archive rolls the members already archived
          // back and leaves every copy of the cascade alone.
          for (const u of done) {
            await deps.bbCli.run(["thread", "unarchive", u]);
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
      for (const t of threadsByEnv.get(env.id) ?? []) {
        if (isCascadeRoot(t)) await evalCascade(t);
      }
    }

    // Per-env outcomes.
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
        continue;
      }
      const envThreadList = threadsByEnv.get(env.id) ?? [];
      const blocked = envBlocked.get(env.id);
      // Threads that stayed out of every evaluated cascade — out-of-scope
      // root chats under `scope: workers`, or members of a cascade that
      // already failed (they stay `processed` but unarchived).
      const unhandled = envThreadList.filter(
        (t) => !t.archivedAt && !processedThreads.has(t.id) && !archivedNow.has(t.id),
      );
      if (envThreadList.length === 0) {
        writeKept(env, "no-threads", facts.firstSeenAt);
        continue;
      }
      if (unhandled.length > 0 || blocked) {
        writeKept(
          env,
          blocked ?? "threads-remaining",
          facts.firstSeenAt,
        );
        continue;
      }
      const remaining = liveThreadsOf(env.id);
      if (!apply || remaining.length > 0) {
        // Report mode (nothing is archived) — «готова к удалению».
        summary.ready += 1;
        writeKept(env, blocked ?? "merged-ready", facts.firstSeenAt);
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
      }
    }

    // «Ветки без копий»: local `bb/` branches merged on origin (ancestor
    // or `git cherry`-equivalent) and not checked out anywhere are
    // deleted (apply mode only) — on a *later* run than the copy's own
    // archiving, once BB has freed the worktree. People's other branches
    // and rescue refs under `refs/orchestrator/` are never touched (§16).
    for (const { fetched, root, protectedTargets, localBranches, openBranches } of repoInfos) {
      if (!fetched) continue;
      for (const branch of localBranches) {
        if (!branch.startsWith(BRANCH_PREFIX)) continue;
        if (cfg.protectedBranches.includes(branch)) continue;
        if (openBranches.has(branch)) continue;
        if (!(await shaMergedIn(root, branch, protectedTargets))) continue;
        summary.orphanBranches += 1;
        if (apply && cfg.deleteBranches) {
          if (await gitOk(deps.cmd, root, ["branch", "-D", branch])) {
            summary.removedBranches += 1;
          } else {
            keep(summary, "branch-delete-failed");
          }
        }
      }
      if (apply && (summary.removedCopies > 0 || summary.removedBranches > 0)) {
        await gitOk(deps.cmd, root, ["worktree", "prune"]);
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
  };
  /** §16.3: at most one «брошено» message per coordinator per day, and
   * only while *newly* abandoned envs appear. Announcement state is
   * tracked separately from the reported ledger — an env suppressed by
   * the daily watermark stays unannounced and joins the next day's
   * message rather than being dropped. Other threads are never
   * written to. */
  const notifyCoordinators = async (
    summary: JanitorRunSummary,
    persist: boolean,
  ): Promise<void> => {
    if (!summary.reported.length) return;
    let announced = announcedMem;
    if (persist) {
      try {
        announced = new Set(
          JSON.parse(deps.janitor.meta("announcedAbandoned") ?? "[]"),
        );
      } catch {
        announced = new Set();
      }
    }
    const fresh = summary.reported.filter((i) => !announced.has(i.envId));
    if (!fresh.length) return;
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
        for (const item of items) announced.add(item.envId);
        if (persist) {
          deps.janitor.setMeta(key, String(now()));
          deps.janitor.setMeta(
            "announcedAbandoned",
            JSON.stringify([...announced].slice(-2000)),
          );
        }
      } catch (e) {
        log.warn?.(`orchestrator janitor: notify ${coordinator}: ${message(e)}`);
      }
    }
  };

  /**
   * §16.4: build the rescue commit for a dirty copy whose thread was
   * just archived. Tracked/staged state comes from `git stash create`;
   * untracked files go through a temporary index (empty index + `add`
   * of the untracked paths) into a third-parent commit — the resulting
   * ref is a standard stash object restorable by `git stash apply`.
   * Returns null when there is nothing to save.
   */
  const rescueCommit = async (
    path: string,
    threadId: string,
  ): Promise<string | null> => {
    const head = (
      await gitOut(deps.cmd, path, ["rev-parse", "--verify", "HEAD"])
    )?.trim();
    if (!head) return null;
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
    if (!uFiles.length) return w;
    const tmpIndex = join(
      tmpdir(),
      `jan-rescue-${process.pid}-${threadId}-${now()}`,
    );
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await gitOut(deps.cmd, path, ["read-tree", "--empty"], env);
      const added = await gitOut(
        deps.cmd,
        path,
        ["add", "--", ...uFiles],
        env,
      );
      if (added === null) return w;
      const uTree = (
        await gitOut(deps.cmd, path, ["write-tree"], env)
      )?.trim();
      if (!uTree) return w;
      const uSha = (
        await gitOut(deps.cmd, path, [
          "commit-tree",
          uTree,
          "-m",
          `orchestrator rescue (untracked) ${threadId}`,
        ])
      )?.trim();
      if (!uSha) return w;
      if (!w) {
        // Only untracked work: build a stash-shaped commit so the same
        // `git stash apply` restore command works — index commit first,
        // then the stash head with the untracked commit as third parent.
        const iTree = (
          await gitOut(deps.cmd, path, ["write-tree"])
        )?.trim();
        if (!iTree) return uSha;
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
        return (
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
          )?.trim() ?? uSha
        );
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
      if (!wTree || !wIndex) return w;
      return (
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
        )?.trim() ?? w
      );
    } finally {
      try {
        rmSync(tmpIndex, { force: true });
      } catch {
        // temp index removal failed — harmless
      }
    }
  };

  /**
   * §16.4: `thread.archived` for an executor thread — while BB still
   * holds the copy (the ~5-minute window), a dirty state is committed
   * to `refs/orchestrator/rescue/<thread>` and the coordinator gets the
   * restore command. Clean copies and non-executor threads are no-ops;
   * the janitor never deletes refs under `refs/orchestrator/`.
   */
  const onThreadArchived = async (thread: {
    id: string;
    environmentId?: string | null;
    parentThreadId?: string | null;
    sourceThreadId?: string | null;
    originPluginId?: string | null;
  }): Promise<void> => {
    const cfgLoad = await deps.loadConfig();
    if (cfgLoad.errors.length || !cfgLoad.config?.enabled) return;
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
    const sha = await rescueCommit(path, thread.id);
    if (!sha) return;
    const ref = `refs/orchestrator/rescue/${thread.id}`;
    if (!(await gitOk(deps.cmd, path, ["update-ref", ref, sha]))) return;
    const coordinator =
      deps.store.byThreadId(thread.id)?.coordinator_thread_id ??
      thread.parentThreadId ??
      null;
    if (!coordinator) return;
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
    try {
      await deps.threads.send({
        threadId: coordinator,
        mode: "queue-if-active",
        input: [
          {
            type: "text",
            text:
              `[orchestrator] исполнитель ${thread.id} заархивирован ` +
              `с несохранённой работой — снимок: ${ref}. ` +
              `Восстановление: git -C ${repoRoot} stash apply ${ref}`,
            mentions: [],
          },
        ],
      });
    } catch (e) {
      log.warn?.(
        `orchestrator janitor: rescue notify ${coordinator}: ${message(e)}`,
      );
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

  return { run, report, onThreadArchived };
}
