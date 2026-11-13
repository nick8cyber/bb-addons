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
 * copy no longer exists. «Влита» is ancestry or `git cherry` with no
 * «+» (patch-id equivalence — a squash of several commits is not
 * recognized; such copies only go to the report).
 * Own commits are the *reachable* commits of the copy's branch:
 * `rev-list --count <«Created from»>..<tip>` (PLUG-195: strictly from
 * the creation entry — no reflog-type parsing). «Ничего не
 * теряется»: every commit the copy's HEAD or its branch ever pointed
 * at (the whole `git log -g`, plus the copy-scoped `refs/worktree/*`
 * and `refs/bisect/*` with their reflogs, PLUG-202/203) — and every
 * ancestor of those positions not on origin — is an ancestor of a
 * remote target or patch-equivalent (`patch-id --verbatim`, the
 * commit itself, `rev-list --no-walk`; an empty commit only as an
 * ancestor). `--stable` normalizes whitespace — a tab-vs-spaces
 * patch collides (PLUG-202) — so `git cherry` only pre-filters and
 * the verdict is the verbatim id.
 * The merge-tree content sign is NOT used for removal (PLUG-201):
 * merge drivers fake it — a configured `ours`, the built-in `union`
 * from `.gitattributes`, a driver name with `=` that `-c` cannot
 * express — three confirmed losses in a row. A commit that is neither
 * (a `reset`-orphaned or detached commit, an unpublished pre-amend
 * version, an «A» in a net-zero «A + revert A») keeps the copy
 * (`unpushed-commits`), or reports it once abandoned. The rule is
 * re-run immediately before archiving — together with the
 * unfinished merge/rebase/cherry-pick check — and for a copy-less
 * `bb/` branch — over the branch's own reflog before `update-ref -d`
 * against the verified tip (`branch-unpushed`), since deleting the
 * branch erases it. The content sign survives ONLY as a report
 * flag: a copy whose branch `git merge-tree --write-tree` (run with
 * attributes disabled — `--attr-source=<empty tree>` plus
 * `-c core.attributesFile=/dev/null`, so no merge driver can run)
 * reproduces the target tree while its commits failed is reported
 * «похоже, влито squash — проверьте и удалите вручную»
 * (`squash-suspect`), never removed. A copy carrying submodules
 * (`.gitmodules`, `$GIT_DIR/modules` or a gitlink `160000` index
 * entry, PLUG-203) is never removed — their objects live inside the
 * copy's git dir and no origin check covers them. The same holds for
 * nested git storage found by a full filesystem walk of the copy
 * (any `.git` below the root or a bare `HEAD`+`objects/`+`refs/`
 * layout, ignored directories included; `nested-repo`). `git
 * worktree prune` is never invoked — it erases the HEAD reflog of a
 * manually deleted copy, the last pointer to its commits (PLUG-203).
 *
 * §16.4: on `thread.archived` AND `thread.deleted` (r29) of an executor
 * whose copy is still dirty, the state is saved into
 * `refs/orchestrator/rescue/<thr>` (`-<N>` for a changed repeat
 * snapshot — trees `^{tree}`/`^2^{tree}`/`^3^{tree}` are compared and an
 * identical snapshot writes nothing) via a stash object including
 * untracked files (temporary index + `--pathspec-from-file`) —
 * unconditionally, even with the janitor disabled — and the
 * coordinator gets a restore command into a *new* worktree, plus a
 * line when the snapshot is incomplete or failed (`снимок НЕ удался
 * (<шаг>: <ошибка>)`). Silence only when another live thread shares
 * the env; a gone copy is journal-only. The ref is created atomically
 * (`update-ref <ref> <sha> ""`), rescues of one thread are serialized
 * by an in-plugin queue, and every attempt lands in the
 * `janitor_rescues` table that `janitor report` reads. The janitor
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
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runJson, type BbCli } from "./bb-cli.js";
import { T_RU, type T } from "./i18n/index.js";
import type { CmdRunner } from "./cmd.js";
import type { JanitorConfig, JanitorConfigLoad } from "./janitor-config.js";
import type {
  DelegationStore,
  JanitorItemState,
  JanitorRescueRow,
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
  "submodules-unknown",
  "nested-unknown",
  "hidden-unknown",
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
  /**
   * §17.4 (С7): paged SDK `threads.list` — the janitor reads every
   * thread (live, archived, hidden) in bounded pages instead of one
   * `bb thread list --json` dump that stops fitting the CLI buffer at
   * ~5700 threads. Absent on older wiring → the CLI list is the
   * fallback.
   */
  list?(args: {
    includeHidden?: boolean;
    archived?: boolean;
    limit?: number;
    offset?: number;
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
  /** §18.1: the language catalog (defaults to T_RU). */
  t?: T;
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
  /**
   * §17.4 (мелко 8): env lifecycle — a `ready` env already under
   * teardown/retire (`phase` ≠ `active`) is being destroyed by BB
   * itself; its missing directory is not user-actionable. Absent on
   * older BB → treated as `active`.
   */
  lifecycle?: { phase?: string | null } | null;
}

interface ThreadDto {
  id: string;
  status?: string | null;
  /** §17.4 (PLUG-219): a thread created mid-listing is excused from the
   * two-pass comparison (it can legitimately appear in one pass only). */
  createdAt?: number | null;
  /** §15 cond 4: anything but `none` keeps the copy. */
  queuedWork?: string | null;
  /** `bb thread list` precomputes this; absent on older BB → CLI fallback. */
  hasPendingInteraction?: boolean | null;
  archivedAt?: number | null;
  /** §16.4 r29: soft-deleted threads may still be reported by some BB
   * versions — a set `deletedAt` counts as not-live. */
  deletedAt?: number | null;
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
  /** §17.4 (PLUG-218): the ledger's `tip_sha`, when the row carries one. */
  tipSha?: string | null;
  /** §16.3: true when this env was not already reported as abandoned. */
  isNew?: boolean;
}

/** §17.4 (ревью PLUG-218): one removal of the run — the SHAs that make
 * `git branch <name> <sha>` restore possible (recover until gc). */
export interface JanitorRemovedItem {
  envId: string;
  branch: string | null;
  /** Git common dir of the repo the branch lives(d) in. */
  repo: string | null;
  /** Branch tip; for a copy — its own-branch tip, else HEAD. */
  tipSha: string | null;
  /** Copy HEAD at archive — copies only. */
  headSha: string | null;
}

export interface JanitorRunSummary {
  /** True when the run deleted (apply mode and not --dry-run). */
  applied: boolean;
  skipped?: "disabled" | "invalid-config" | "unsupported-git";
  removedCopies: number;
  removedBranches: number;
  archivedThreads: number;
  freedKb: number;
  /** Copies eligible for removal (in report mode — would remove). */
  ready: number;
  /**
   * §17.4 (С9): the ready copies themselves — «готова к удалению»
   * (what `apply` would remove), listed by `janitor run` and persisted
   * as ledger rows in report mode so `janitor report` can show them.
   */
  readyItems: JanitorReportedItem[];
  /** §17.4 (PLUG-218): what was actually removed this run, with SHAs —
   * `janitor run --json` prints it. */
  removedItems: JanitorRemovedItem[];
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
  /** §17.4 (С9): ledger rows marked «готова к удалению». */
  ready: JanitorReportedItem[];
  /** §16.4 r29 (PLUG-240): the rescue ledger — every snapshot attempt
   * (and failure), read from the plugin store so saved work without a
   * reachable coordinator is still findable. */
  rescues: JanitorRescueRow[];
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

/** §16.4 r29: full result — failure lines carry the step's stderr. */
async function gitRes(
  cmd: CmdRunner,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const res = await cmd.run("git", ["-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  });
  return { code: res.exitCode, stdout: res.stdout, stderr: res.stderr };
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
  const t = deps.t ?? T_RU;
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
   * §17.4 (С7): the SDK list is paged — a single CLI dump stops fitting
   * its buffer at ~5700 threads and silently turned every env into
   * `threads-unknown`. Omitted `archived` returns live and archived
   * threads (the `--include-archived` semantic); deleted are always
   * excluded server-side. The one-shot CLI list stays as the fallback
   * when no SDK seam is wired.
   */
  const THREADS_PAGE = 200;
  const listThreads = async (): Promise<ThreadDto[] | null> => {
    // §17.4 (PLUG-213): offset paging races the server's ordering
    // (`projectId ASC`, pinned first, `createdAt DESC`, `id DESC`):
    // deleting or (un)pinning a thread on an already-read page shifts
    // later rows up and one is never read — a full-looking list with a
    // hole in it. `threads.count` cannot bracket the traversal: the
    // SDK wrapper drops `includeArchived`/`includeHidden` (live
    // measure 504 counted vs 2400 paged rows), so the whole list is
    // read TWICE and the deduplicated id sets compared. Different
    // sets → the pair is repeated once; still different → «список не
    // доказан» (threads-unknown) with the sizes and the differing ids
    // in the plugin journal. Without the seam the atomic one-shot CLI
    // list is the fallback.
    if (deps.threads.list) {
      const pass = async (): Promise<Map<string, ThreadDto> | null> => {
        const byId = new Map<string, ThreadDto>();
        for (let offset = 0; ; offset += THREADS_PAGE) {
          const page = await deps.threads.list!({
            includeHidden: true,
            limit: THREADS_PAGE,
            offset,
          });
          if (!Array.isArray(page)) return null;
          for (const t of page as ThreadDto[]) {
            if (t && typeof t.id === "string" && !byId.has(t.id)) {
              byId.set(t.id, t);
            }
          }
          if (page.length < THREADS_PAGE) break;
        }
        return byId;
      };
      const sample = (ids: string[]) =>
        ids.slice(0, 10).join(",") +
        (ids.length > 10 ? ` +${ids.length - 10} more` : "");
      let lastIssue = "no pass completed";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // §17.4 (ревью PLUG-218): a thread created after the first
          // pass began can legitimately sit in only one of the two
          // sets — it is excused from the comparison (a missing
          // createdAt cannot prove newness, so it still counts), yet
          // it joins the proven list via the union of both passes.
          const firstStartedAt = now();
          const first = await pass();
          if (first === null) {
            lastIssue = "a page was not an array";
            continue;
          }
          const second = await pass();
          if (second === null) {
            lastIssue = "a page was not an array";
            continue;
          }
          const bornDuring = (t: ThreadDto | undefined) =>
            t?.createdAt != null && t.createdAt > firstStartedAt;
          const onlyFirst = [...first.keys()].filter(
            (id) => !second.has(id) && !bornDuring(first.get(id)),
          );
          const onlySecond = [...second.keys()].filter(
            (id) => !first.has(id) && !bornDuring(second.get(id)),
          );
          if (onlyFirst.length === 0 && onlySecond.length === 0) {
            return [...new Map([...first, ...second]).values()];
          }
          lastIssue =
            `pass sets differ (${first.size} vs ${second.size} ids; ` +
            `only-in-first: ${sample(onlyFirst) || "none"}; ` +
            `only-in-second: ${sample(onlySecond) || "none"})`;
        } catch (e) {
          // a page call threw — the retry pair may still succeed
          lastIssue = `a page call failed: ${message(e)}`;
        }
      }
      deps.log?.warn?.(
        `orchestrator janitor: thread list unproven — ${lastIssue}`,
      );
      return null;
    }
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
      // newest → oldest: the first «branch: Created from» is the
      // latest (re)creation point of the branch. Anchored to the %gs
      // prefix — a commit message starting with «Created from» («commit:
      // Created from …») must not pose as a creation entry (PLUG-204).
      if (/^branch: Created from\b/.test(line.slice(sep + 1))) {
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

  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  /**
   * §16.3 «ничего не теряется»: an empty commit (`--allow-empty` —
   * its tree equals a parent's, or the empty tree at the root) has no
   * content of its own, so the content sign must never clear it: such
   * a commit is safe only as an origin ancestor or by patch-id —
   * otherwise work that exists solely as a commit message would
   * vanish with the ref (PLUG-198). An unproven answer counts as
   * non-empty — the content check then decides on its own.
   */
  const commitContentless = async (
    repoRoot: string,
    sha: string,
  ): Promise<boolean> => {
    const line = (
      await gitOut(deps.cmd, repoRoot, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        sha,
      ])
    )?.trim();
    const tree = (
      await gitOut(deps.cmd, repoRoot, ["rev-parse", `${sha}^{tree}`])
    )?.trim();
    if (!line || !tree) return false;
    const parents = line.split(/\s+/).slice(1);
    for (const p of parents.length ? parents : [EMPTY_TREE]) {
      const pt = (
        await gitOut(deps.cmd, repoRoot, ["rev-parse", `${p}^{tree}`])
      )?.trim();
      if (pt && pt === tree) return true;
    }
    return false;
  };

  /**
   * §17.4 (мелко 11): the plugin's git floor — `patch-id --verbatim`
   * (2.39; `merge-tree --write-tree` is 2.38). Below it the janitor
   * refuses the run with a hint rather than evaluate on a git whose
   * «ничего не теряется» probe does not exist. `null` — the version
   * could not be read, also a refusal (the floor is unverifiable).
   */
  const MIN_GIT: readonly [number, number] = [2, 39];
  let gitVersionCached: { major: number; minor: number } | null | undefined;
  const gitVersion = async (): Promise<{
    major: number;
    minor: number;
  } | null> => {
    if (gitVersionCached !== undefined) return gitVersionCached;
    const res = await deps.cmd.run("git", ["--version"], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const m = /git version (\d+)\.(\d+)/.exec(res.stdout);
    gitVersionCached =
      res.exitCode === 0 && m
        ? { major: Number(m[1]), minor: Number(m[2]) }
        : null;
    return gitVersionCached;
  };
  const gitSupported = async (): Promise<boolean> => {
    const v = await gitVersion();
    return (
      !!v && (v.major > MIN_GIT[0] || (v.major === MIN_GIT[0] && v.minor >= MIN_GIT[1]))
    );
  };

  /**
   * §16.3 squash flag needs `--attr-source` — git ≥ 2.40 (PLUG-202).
   * Parsed once per janitor instance; an older git only loses the
   * flag (one journal line), never the run.
   */
  let attrSourceCached: boolean | undefined;
  const attrSource = async (): Promise<boolean> => {
    if (attrSourceCached !== undefined) return attrSourceCached;
    const v = await gitVersion();
    attrSourceCached =
      !!v && (v.major > 2 || (v.major === 2 && v.minor >= 40));
    if (!attrSourceCached) {
      log.warn?.(t("jn.attrSourceWarn"));
    }
    return attrSourceCached;
  };

  /**
   * §16.3 the report flag, the ONLY surviving use of the content sign
   * (PLUG-201): `git merge-tree --write-tree <target> <sha>`
   * reproducing `<target>^{tree}` proves merging <sha> adds nothing —
   * «похоже, влито squash». The sign is never trusted for removal, so
   * merge drivers cannot fake a deletion; still, it runs with
   * attributes fully disabled (`--attr-source=<empty tree>` +
   * `-c core.attributesFile=/dev/null`) so the flag itself is honest:
   * no `.gitattributes` driver (`ours`, `union`, a name `-c` cannot
   * express) can bend the merge result. A failed or conflicting
   * merge-tree proves nothing and never flags.
   */
  const mergeTreeEquals = async (
    repoRoot: string,
    target: string,
    sha: string,
  ): Promise<boolean> => {
    // PLUG-202: `--attr-source` needs git ≥ 2.40 — without it the flag
    // is skipped (one journal line above), never an error.
    if (!(await attrSource())) return false;
    const mergedTree = (
      await gitOut(deps.cmd, repoRoot, [
        `--attr-source=${EMPTY_TREE}`,
        "-c",
        "core.attributesFile=/dev/null",
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
   * §16.3 the report flag: true when any given tip merges into any
   * target as a no-op (`mergeTreeEquals`) — «похоже, влито squash».
   * Ancestor tips are skipped: their no-op merge is trivially true
   * and the flag would fire on every kept copy, not only on the
   * squash suspects it is meant for.
   */
  const contentSquashedOn = async (
    repoRoot: string,
    shas: string[],
    targets: string[],
  ): Promise<boolean> => {
    for (const sha of shas) {
      for (const t of targets) {
        if (
          await gitOk(deps.cmd, repoRoot, [
            "merge-base",
            "--is-ancestor",
            sha,
            t,
          ])
        ) {
          continue;
        }
        if (await mergeTreeEquals(repoRoot, t, sha)) return true;
      }
    }
    return false;
  };

  /**
   * §16.3 «влита»: a sha is merged into a remote-tracking target when
   * it is an ancestor or patch-equivalent to a commit on it (`git
   * cherry` prints only «-» lines). A multi-commit squash is neither —
   * such copies are not merged and go to the report instead.
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
    }
    return patchEquivalent(repoRoot, sha, targets);
  };

  /**
   * §16.3 «ничего не теряется», the patch-id sign (PLUG-202): <sha> is
   * equivalent to a commit on the target only when their `patch-id
   * --verbatim` ids match — exact bytes, whitespace included
   * (`--stable` normalizes it: a «spaces → tab» patch collides with
   * «spaces → two spaces» and the tab was lost). `git cherry` stays as
   * a hint only: a «+» means no stable-id match, hence no verbatim
   * one either, so the expensive diff scan can be skipped. A merge
   * commit has no patch-id and can never match; a failed probe proves
   * nothing.
   */
  const patchIdOf = async (
    repoRoot: string,
    spec: string,
  ): Promise<string | null> => {
    const diff = await gitOut(deps.cmd, repoRoot, [
      "log",
      "-p",
      "--no-merges",
      "-n",
      "1",
      spec,
    ]);
    if (diff === null) return null;
    const res = await deps.cmd.run(
      "git",
      ["-C", repoRoot, "patch-id", "--verbatim"],
      { timeoutMs: GIT_TIMEOUT_MS, stdin: diff },
    );
    if (res.exitCode !== 0) return null;
    return res.stdout.split("\n")[0]?.split(/\s+/)[0]?.trim() || null;
  };

  /**
   * Verbatim patch-ids of the non-merge commits in <range>. Kept
   * bounded — a match outside the window is missed, which only keeps
   * the copy (the safe direction). The `commit <sha>` headers of the
   * default log format split the stream into one patch per commit.
   */
  const patchIdsIn = async (
    repoRoot: string,
    range: string,
  ): Promise<Set<string> | null> => {
    const diff = await gitOut(deps.cmd, repoRoot, [
      "log",
      "-p",
      "--no-merges",
      "--max-count=500",
      range,
    ]);
    if (diff === null) return null;
    const res = await deps.cmd.run(
      "git",
      ["-C", repoRoot, "patch-id", "--verbatim"],
      { timeoutMs: GIT_TIMEOUT_MS, stdin: diff },
    );
    if (res.exitCode !== 0) return null;
    const ids = new Set<string>();
    for (const l of res.stdout.split("\n")) {
      const id = l.split(/\s+/)[0]?.trim();
      if (id) ids.add(id);
    }
    return ids;
  };

  const patchEquivalent = async (
    repoRoot: string,
    sha: string,
    targets: string[],
  ): Promise<boolean> => {
    // §16.3 (PLUG-199): only <sha> itself is checked for being a merge
    // — a bare walk would find ANY merge on its history and disable
    // the patch-id sign in every repo that has one.
    const merge = (
      await gitOut(deps.cmd, repoRoot, [
        "rev-list",
        "--no-walk",
        "--min-parents=2",
        sha,
      ])
    )?.trim();
    if (merge) return false;
    // The verbatim id is computed lazily — the cherry hint ends the
    // common «truly unpushed» case without a single diff scan.
    let id: string | null | undefined;
    const ownId = async () =>
      id !== undefined ? id : (id = await patchIdOf(repoRoot, sha));
    for (const t of targets) {
      // Hint only (PLUG-202): a «+» line proves no stable-id match —
      // and verbatim ⊆ stable, so no verbatim match either. «-» or a
      // failed cherry decide nothing; verbatim does.
      const cherry = await gitOut(deps.cmd, repoRoot, ["cherry", t, sha]);
      if (
        cherry !== null &&
        cherry.split("\n").some((l) => l.startsWith("+"))
      ) {
        continue;
      }
      if (!(await ownId())) continue;
      const ids = await patchIdsIn(repoRoot, `${sha}..${t}`);
      if (ids?.has(id!)) return true;
    }
    return false;
  };

  /**
   * §16.3 (ревизия 25) «ничего не теряется»: every commit the given
   * reflogs (`git log -g --format=%H <ref>`, whole history) ever
   * pointed at — plus the tips themselves — and every ancestor of
   * those positions must be safe: reachable from a remote target
   * (`rev-list <positions> --not <targets>` proves ancestry) or
   * patch-equivalent to a commit on one (`git patch-id --verbatim`;
   * the `git cherry` «+» line is only a fast-path hint to skip the
   * diff scan, «-» or a failed cherry decides nothing). Ancestors are
   * checked too (PLUG-198): a reflog may lose a position
   * (`reflog expire`, `pull --ff-only` records only the landing tip,
   * a ref with no reflog) while the commit stays reachable — «A +
   * revert A» then leaves A, whose content never reached origin,
   * visible only as an ancestor. The equivalence sign is checked for
   * EACH pending commit itself: a whole-tip check cannot clear the
   * middle commits — «A + revert A» nets to origin while A's content
   * never reached it, and a squash that rewrote an earlier commit's
   * lines leaves that commit without a counterpart; both stay
   * («брошено» when abandoned, never a silent removal). The
   * `merge-tree` content sign is deliberately NOT used (PLUG-201):
   * merge drivers (`ours`, built-in `union`, names with `=`) fake it.
   * An empty commit has no diff to match — it counts as «lost»
   * (message-only work must not vanish silently). «ok» — the reflogs
   * hold nothing unpublished; «lost» — at least one commit (a
   * `reset`-orphan, a detached-HEAD commit, an unpublished pre-amend
   * version) would die with the ref; «unknown» — a reflog or the
   * reachability scan could not be read, so nothing is proven and the
   * ref stays.
   */
  const reflogPositionsSafe = async (
    cwd: string,
    refs: string[],
    repoRoot: string,
    targets: string[],
    extraTips: string[] = [],
  ): Promise<"ok" | "lost" | "unknown"> => {
    const shas = new Set<string>(extraTips);
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
      // The tip is a position of its own (PLUG-198): its reflog entry
      // may be gone — expired by `git gc` (`gc.reflogExpire`), never
      // recorded (`pull --ff-only` logs only the landing position), or
      // the ref may have no reflog at all — while every ancestor it
      // reaches must still be proven safe.
      const tip = (
        await gitOut(deps.cmd, cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          ref,
        ])
      )?.trim();
      if (!tip) return "unknown";
      shas.add(tip);
    }
    // Every commit reachable from the positions but not from a remote
    // target must prove itself — not just the positions themselves
    // (PLUG-198): «A + revert A» nets to origin while A, an ancestor
    // that was never a position (or no longer is, after
    // `reflog expire`), carried content origin never saw.
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
        if (s) pending.add(s);
      }
    }
    if (!pending.size) return "ok";
    // §16.3 (PLUG-201): ancestry already excluded the target's own
    // commits — a pending one is safe ONLY as a patch-equivalent
    // (`git cherry` «-», the commit itself, `--no-walk`). The
    // merge-tree content sign is not trusted here: merge drivers
    // (`ours`, built-in `union`, names with `=`) fake it — three
    // confirmed losses in a row.
    for (const sha of pending) {
      // §16.3: an empty commit (`--allow-empty`) has no content to find
      // on a target — safe only by ancestry (already excluded) or by
      // patch-id (PLUG-198).
      if (await commitContentless(repoRoot, sha)) return "lost";
      if (await patchEquivalent(repoRoot, sha, targets)) continue;
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
    // §16.3 (PLUG-202/203): copy-scoped refs — `refs/worktree/*` and
    // `refs/bisect/*` live in the worktree's own git dir and die with
    // it. Their reflogs are read like HEAD's — under
    // `core.logAllRefUpdates=always` a moved-away position is
    // protected too; a ref without a reflog contributes its tip only
    // (`log -g` is empty). An unreadable listing proves nothing →
    // «unknown».
    const extra = await gitOut(deps.cmd, path, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/worktree/",
      "refs/bisect/",
    ]);
    if (extra === null) return "unknown";
    for (const r of extra
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      if (!refs.includes(r)) refs.push(r);
    }
    return reflogPositionsSafe(path, refs, repoRoot, targets);
  };

  /**
   * §15 п.3 (PLUG-202): tracked files carrying `skip-worktree` or
   * `assume-unchanged` (`git ls-files -v` — tag `S` or a lowercase
   * letter) are invisible to `git status`, so a dirty one must be
   * found by comparing the disk content (`git hash-object`) to the
   * index blob. A flagged file missing on disk (sparse-checkout out
   * of the cone) is skipped; a probe failure returns null — nothing
   * is proven (`hidden-unknown`).
   */
  const hiddenChangedFiles = async (
    path: string,
  ): Promise<string[] | null> => {
    const verbose = await gitOut(deps.cmd, path, ["ls-files", "-v", "-z"]);
    if (verbose === null) return null;
    const flagged: string[] = [];
    for (const rec of verbose.split("\0")) {
      if (!rec) continue;
      const tag = rec[0]!;
      if (tag === "S" || (tag >= "a" && tag <= "z")) {
        flagged.push(rec.slice(2));
      }
    }
    if (!flagged.length) return [];
    const staged = await gitOut(deps.cmd, path, ["ls-files", "-s", "-z"]);
    if (staged === null) return null;
    const indexSha = new Map<string, string>();
    for (const rec of staged.split("\0")) {
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      indexSha.set(rec.slice(tab + 1), rec.slice(0, tab).split(/\s+/)[1]!);
    }
    const changed: string[] = [];
    for (const f of flagged) {
      if (!existsSync(join(path, f))) continue;
      const idx = indexSha.get(f);
      if (!idx) return null; // flagged but not in the index — unproven
      const h = (
        await gitOut(deps.cmd, path, ["hash-object", "--", f])
      )?.trim();
      if (!h || h !== idx) changed.push(f);
    }
    return changed;
  };

  /** `child` strictly inside `parent`, compared after `realpath`. */
  const pathInside = (parent: string, child: string): boolean => {
    let rp = parent;
    let rc = child;
    try {
      rp = realpathSync(parent);
    } catch {
      // keep the raw path — the copy was verified to exist already
    }
    try {
      rc = realpathSync(child);
    } catch {
      // vanished between the listing and now — not provably outside
      return true;
    }
    const prefix = rp.endsWith("/") ? rp : `${rp}/`;
    return rc.startsWith(prefix);
  };

  /**
   * §15 п.3 (PLUG-203, грубое правило): nested git storage anywhere
   * under the copy means commits no origin check can see. The whole
   * copy is walked on the filesystem — `git status` never sees an
   * ignored bare clone — including ignored and untracked directories;
   * symlinks are never followed. A `.git` entry (file or directory)
   * below the root, or a directory with bare-storage structure
   * (`HEAD` + `objects/` + `refs/`), keeps the copy (`nested-repo`).
   * The copy's own `.git` at the root — a file for a linked worktree,
   * a directory for a main checkout — is skipped whole. A failed
   * read, a walk past depth 20 or the time budget proves nothing →
   * null (`nested-unknown`), the copy stays.
   * §17.4 (С8): the walk is async — sync `readdirSync` over a whole
   * copy blocked the server process for up to the 20 s budget (the
   * plugin shares it, twice per copy). Each directory yields to the
   * event loop; the budget, depth cap and `nested-unknown` verdict are
   * unchanged.
   */
  const NESTED_SCAN_MS = 20_000;
  const NESTED_MAX_DEPTH = 20;
  const nestedStorageIn = async (
    path: string,
  ): Promise<boolean | null> => {
    const deadline = Date.now() + NESTED_SCAN_MS;
    const walk = async (dir: string, depth: number): Promise<boolean | null> => {
      if (depth > NESTED_MAX_DEPTH || Date.now() > deadline) return null;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      // Yield — the plugin runs inside the BB server process.
      await new Promise((r) => setImmediate(r));
      let bareHead = false;
      let bareObjects = false;
      let bareRefs = false;
      for (const e of entries) {
        if (e.name === "HEAD" && !e.isDirectory()) bareHead = true;
        else if (e.name === "objects" && e.isDirectory()) bareObjects = true;
        else if (e.name === "refs" && e.isDirectory()) bareRefs = true;
      }
      if (bareHead && bareObjects && bareRefs) return true;
      for (const e of entries) {
        if (e.name === ".git") {
          // The copy's own `.git` at the root is its own storage, not
          // a nested repository — it is not entered either.
          if (depth === 0) continue;
          return true;
        }
        if (!e.isDirectory()) continue;
        const found = await walk(join(dir, e.name), depth + 1);
        if (found !== false) return found;
      }
      return false;
    };
    return walk(path, 0);
  };

  /**
   * §16.3 (PLUG-199): submodule objects live in the copy's own git dir
   * (`$GIT_DIR/modules/<name>` — inside `<common>/worktrees/<id>/` for a
   * linked worktree) and die with it, outside every origin check — a
   * copy carrying submodules is never removed. Presence is proven by
   * `.gitmodules` at the copy root or a `modules/` dir under the
   * worktree's git dir; a failed `--git-dir` probe proves nothing —
   * `null` keeps the copy.
   */
  const copyHasSubmodules = async (
    path: string,
    gitDir?: string | null,
  ): Promise<boolean | null> => {
    if (existsSync(join(path, ".gitmodules"))) return true;
    // §15 п.3 (PLUG-203 G1): a nested repo committed as a gitlink
    // without `.gitmodules` (`git clone` + `git add`) leaves a
    // mode-160000 index entry — the nested objects die with the copy
    // exactly like a registered submodule's.
    const staged = await gitOut(deps.cmd, path, ["ls-files", "-s"]);
    if (staged === null) return null;
    if (staged.split("\n").some((l) => l.startsWith("160000 "))) {
      return true;
    }
    let dir = gitDir;
    if (dir === undefined) {
      const raw = await gitOut(deps.cmd, path, [
        "rev-parse",
        "--git-dir",
      ]);
      if (raw === null) return null;
      dir = raw.trim();
      if (dir && !isAbsolute(dir)) dir = join(path, dir);
    }
    if (!dir) return null;
    return existsSync(join(dir, "modules"));
  };

  /**
   * §15 cond 3: an unfinished merge, rebase or cherry-pick keeps the
   * copy — the sentinel files live under the copy's git dir
   * (`MERGE_HEAD` & co., `rebase-merge/`, `rebase-apply/`). Re-run
   * right before archiving too (PLUG-201): the run-start verdict is
   * minutes old by then. A failed `--git-dir` probe proves nothing —
   * `null` keeps the copy (`unfinished-unknown`).
   */
  const unfinishedOp = async (
    path: string,
    gitDir?: string | null,
  ): Promise<boolean | null> => {
    let dir = gitDir;
    if (dir === undefined) {
      const raw = await gitOut(deps.cmd, path, [
        "rev-parse",
        "--git-dir",
      ]);
      if (raw === null) return null;
      dir = raw.trim();
      if (dir && !isAbsolute(dir)) dir = join(path, dir);
    }
    if (!dir) return null;
    return (
      ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD", "REVERT_HEAD"].some(
        (f) => existsSync(join(dir, f)),
      ) ||
      existsSync(join(dir, "rebase-merge")) ||
      existsSync(join(dir, "rebase-apply"))
    );
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
      readyItems: [],
      removedItems: [],
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

    // §17.4 (мелко 11, PLUG-212): below the git floor the «ничего не
    // теряется» probe (`patch-id --verbatim`) does not exist — refuse
    // the whole pass with a hint rather than collect misleading
    // verdicts. The refusal is still a RECORDED run: the row carries
    // the error so `janitor report` shows it, and `janitor run` exits
    // non-zero (a silent skip looked like a healthy pass).
    const gv = await gitVersion();
    if (!(await gitSupported())) {
      const text = t("jn.unsupportedGit", {
        maj: MIN_GIT[0],
        min: MIN_GIT[1],
        found: gv
          ? t("jn.foundVersion", { v: `${gv.major}.${gv.minor}` })
          : t("jn.versionFailed"),
      });
      summary.skipped = "unsupported-git";
      summary.errors.push(text);
      log.warn?.(`orchestrator janitor: ${text}`);
      finish(text);
      return summary;
    }

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
    // §17.4 (С9): item rows are written in report mode too — otherwise
    // `janitor report` has nothing to show (the audit's «посмотри отчёт»
    // was an empty ledger). Only `first_seen_at` stays apply-only
    // (§15: report mode never arms the merged clock); --dry-run still
    // writes nothing.
    const ledger = !dry;
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
      /** Live (non-prunable, existing) worktree paths of the repo. */
      worktreePaths: string[];
      /** `git worktree list` failed — the sweep cannot prove openness. */
      worktreeListFailed: boolean;
    }
    const repos = new Map<string, { root: string; envs: EnvDto[] }>();
    const repoByEnv = new Map<string, RepoInfo | null>();
    for (const env of envs) {
      // §17.4 (мелко 8): a gone directory is `missing-dir`, not
      // «not-a-repo» — skip the repo probe, `computeFacts` reports it.
      if (!existsSync(env.path!)) {
        repoByEnv.set(env.id, null);
        continue;
      }
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
        worktreePaths: [],
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
        // §15 «Действие» (PLUG-203): `git worktree prune` is never
        // called — it erases the `.git/worktrees/<id>/HEAD` reflog of a
        // manually deleted copy, the last pointer to its commits. The
        // `prunable` flag is honored instead: such entries are neither
        // live copies nor «открыта» branches (git's own expiry reaps
        // the metadata later).
        const worktreeList = await gitOut(deps.cmd, root, [
          "worktree",
          "list",
          "--porcelain",
        ]);
        info.worktreeListFailed = worktreeList === null;
        const liveWorktrees = parseWorktreeList(worktreeList ?? "")
          .worktrees
          // A copy whose directory BB already deleted lingers as a
          // `prunable` entry (or is simply missing from disk) — its
          // branch is not «открыта ни в одной копии» (§15).
          .filter((w) => !w.prunable && existsSync(w.path));
        info.worktreePaths = liveWorktrees.map((w) => w.path);
        info.openBranches = new Set(
          liveWorktrees
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
    // §17.4 (ревью PLUG-219, PLUG-220): the SHAs journaled and stamped
    // into the ledger BEFORE a copy's threads are archived — the settle
    // write below reuses them, so what the journal said matches what
    // the row keeps even if the branch moved in between.
    const preArchiveShas = new Map<
      string,
      { tipSha: string | null; headSha: string | null }
    >();

    const markReported = (env: EnvDto, reason: string) => {
      const prevReported = ledger
        ? deps.janitor.item(env.id)?.state === "reported"
        : reportedMem.has(env.id);
      reportedMem.add(env.id);
      reportedNow.push({
        env,
        reason,
        threadId: pickThreadId(env),
        isNew: !prevReported,
      });
      keep(summary, reason);
      if (ledger) {
        deps.janitor.upsertItem(
          env.id,
          {
            projectId: env.projectId ?? null,
            path: env.path ?? null,
            branch: env.branchName ?? null,
            threadId: pickThreadId(env),
            state: "reported",
            reason,
            // PLUG-199: firstSeenAt is NOT cleared — a «reported»
            // spell must not restart the merged streak (no
            // merged-wait ↔ reported flip).
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
      if (ledger) {
        deps.janitor.upsertItem(
          env.id,
          {
            projectId: env.projectId ?? null,
            path: env.path ?? null,
            branch: env.branchName ?? null,
            threadId: pickThreadId(env),
            state: "kept",
            reason,
            // §15: only an apply run may stamp the merged clock — in
            // report mode the field is omitted and the previous value
            // (or none) survives.
            ...(persist && firstSeenAt !== undefined
              ? { firstSeenAt }
              : {}),
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
      const path = env.path!;
      // §17.4 (мелко 8): a `ready` env whose directory is gone is not
      // «not-a-repo» — BB lost the copy (вживую 307 of 787). Separate
      // reason `missing-dir`; its thread goes to the report when
      // nothing hangs on it — no live children, no active delegation —
      // there is nothing to delete, the user decides about the stale
      // records. An env already under teardown/retire
      // (`lifecycle.phase` ≠ `active`) is being destroyed by BB
      // itself — kept, not reported.
      // The missing-dir verdict is only provable for a copy on THIS
      // filesystem: an env advertising a foreign `hostId` while the
      // local host is unknown may have its directory on that host —
      // it keeps the old bogus `not-a-repo` instead.
      if (!existsSync(path) && (!env.hostId || env.hostId === localHost)) {
        const phase = env.lifecycle?.phase;
        const destroying = phase != null && phase !== "active";
        const threadsClear =
          graph.all !== null &&
          (graph.byEnv.get(env.id) ?? [])
            .filter((t) => !t.archivedAt)
            .every(
              (t) =>
                !delegatedThreads.has(t.id) &&
                (graph.childrenOf.get(t.id) ?? []).every(
                  (c) => !!c.archivedAt,
                ),
            );
        return bad("missing-dir", !destroying && threadsClear);
      }
      const repo = repoByEnv.get(env.id);
      if (repo === null || repo === undefined) return bad("not-a-repo");
      if (!repo.fetched) return bad("fetch-failed");
      // Thread state feeds «заброшена» и «все в архиве» — without the
      // list neither is provable, so nothing about the env is.
      if (graph.all === null) return bad("threads-unknown");
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
      const gitDir = gitDirRaw
        ? isAbsolute(gitDirRaw.trim())
          ? gitDirRaw.trim()
          : join(path, gitDirRaw.trim())
        : null;
      const unfinished = gitDir ? await unfinishedOp(path, gitDir) : null;

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
            : dirty || unfinished === true
              ? "abandoned-dirty"
              : "abandoned-unmerged";
        // §16.3 (PLUG-201): a tip whose merge into a target is a no-op
        // is «похоже, влито squash» — the multi-commit squash `git
        // cherry` cannot see. The content sign never decides removal;
        // it only flags the copy for a manual check in the report.
        if (
          (reason === "not-merged" || reason === "abandoned-unmerged") &&
          (await contentSquashedOn(repo.root, shas, targets))
        ) {
          return bad("squash-suspect", true);
        }
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
      if (unfinished === null) return after("unfinished-unknown");
      if (unfinished) return after("unfinished-op");
      // §15 п.3 (PLUG-202/203): ignored files are recoverable — nested
      // git storage is not. A live `worktree list` entry inside the
      // copy, a gitlink (160000) or submodule metadata, or any `.git`/
      // bare structure the filesystem walk finds keeps the copy; a
      // failed probe proves nothing.
      if (repo.worktreeListFailed) return after("nested-unknown");
      if (repo.worktreePaths.some((w) => pathInside(path, w))) {
        return after(
          abandoned ? "abandoned-nested-worktree" : "nested-worktree",
          abandoned,
        );
      }
      // §16.3 (PLUG-199/203): a copy with submodules — `.gitmodules`,
      // `$GIT_DIR/modules` or a gitlink index entry — is never
      // removed: their objects die with the copy's git dir and no
      // origin check covers them.
      const submodules = await copyHasSubmodules(path, gitDir);
      if (submodules === null) return after("submodules-unknown");
      if (submodules) {
        return after(
          abandoned ? "abandoned-submodules" : "has-submodules",
          abandoned,
        );
      }
      const nested = await nestedStorageIn(path);
      if (nested === null) return after("nested-unknown");
      if (nested) {
        return after(
          abandoned ? "abandoned-nested-repo" : "nested-repo",
          abandoned,
        );
      }
      // §15 п.3 (PLUG-202): `skip-worktree`/`assume-unchanged` edits
      // are invisible to `git status` — flagged files whose disk
      // content differs from the index keep the copy.
      const hidden = await hiddenChangedFiles(path);
      if (hidden === null) return after("hidden-unknown");
      if (hidden.length) {
        return after(
          abandoned ? "abandoned-hidden-changes" : "hidden-changes",
          abandoned,
        );
      }
      // §16.3 (ревизия 25, главное условие): «ничего не теряется» —
      // every commit the copy's HEAD or its own branch ever pointed at
      // must already sit on a remote target: as an ancestor or as a
      // patch-equivalent (amend/rebase/cherry-pick of published work).
      // The merge-tree content sign is no longer trusted here
      // (PLUG-201) — a commit that is neither — one orphaned by
      // `reset`, made on a detached HEAD, an unpublished pre-amend
      // version, an «A» in a net-zero «A + revert A» — keeps the copy;
      // once the thread idles past `abandonedAfter` it goes to the
      // «брошено» report.
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
        // §16.3 (PLUG-201): commits failed but the branch still merges
        // as a no-op — «похоже, влито squash»: report flag only.
        if (await contentSquashedOn(repo.root, shas, targets)) {
          return after("squash-suspect", true);
        }
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
        // §4 r30 д: own-spawn executors carry `orchestrator`.
        t.originPluginId === "tasks" ||
        t.originPluginId === "orchestrator" ||
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
        // §16.3 (PLUG-201): an unfinished merge/rebase/cherry-pick may
        // have started after the run-start probe — `git status` alone
        // does not always surface it (a clean merge-in-progress is
        // quiet), so the sentinel files are re-checked before the
        // archive too.
        const unfin = await unfinishedOp(e.path!);
        if (unfin !== false) {
          note(unfin === null ? "unfinished-unknown" : "unfinished-op", e.id);
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
        // §16.3 (PLUG-199): a submodule initialised after the snapshot
        // still blocks the archive — the check is re-run, not cached.
        const sub = await copyHasSubmodules(e.path!);
        if (sub !== false) {
          note(sub === null ? "submodules-unknown" : "has-submodules", e.id);
          return;
        }
        // §15 п.3 (PLUG-202): a nested worktree, an embedded `.git` or
        // a hidden-flagged edit may have appeared since the run-start
        // snapshot — the nested checks are re-run on the FRESH worktree
        // list, not the one cached at fetch time.
        const freshWtl = await gitOut(deps.cmd, repo.root, [
          "worktree",
          "list",
          "--porcelain",
        ]);
        if (freshWtl === null) {
          note("nested-unknown", e.id);
          return;
        }
        const freshWtPaths = parseWorktreeList(freshWtl)
          .worktrees.filter((w) => !w.prunable && existsSync(w.path))
          .map((w) => w.path);
        if (freshWtPaths.some((w) => pathInside(e.path!, w))) {
          note("nested-worktree", e.id);
          return;
        }
        const nRepo = await nestedStorageIn(e.path!);
        if (nRepo !== false) {
          note(nRepo === null ? "nested-unknown" : "nested-repo", e.id);
          return;
        }
        const hid = await hiddenChangedFiles(e.path!);
        if (hid === null || hid.length) {
          note(hid === null ? "hidden-unknown" : "hidden-changes", e.id);
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

      // §17.4 (ревью PLUG-219, PLUG-220): every member env's branch tip
      // and HEAD go to the journal and the ledger BEFORE the first
      // `thread archive` — BB frees the copy on archive, so a crash or
      // an exception between the archive and the settle write below
      // would lose both SHAs (on the next run the env is already gone
      // and the row never appears). The row sits at «removing»; the
      // settle write flips it to «removed», a rolled-back archive to
      // «archive-failed» (`tip_sha` survives either way).
      for (const e of freshEnvs.values()) {
        const f = await envFacts(e);
        const eRepo = repoByEnv.get(e.id);
        const eBranch = e.branchName?.trim();
        const eTip = eBranch
          ? (
              await gitOut(deps.cmd, eRepo?.root ?? e.path!, [
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/heads/${eBranch}`,
              ])
            )?.trim() || null
          : null;
        const copyTip = eTip ?? f.headSha ?? null;
        log.info?.(
          `orchestrator janitor: removing copy ` +
            `${eRepo?.commonDir ?? e.path}:${eBranch ?? "-"} ` +
            `at ${copyTip ?? "-"} head ${f.headSha ?? "-"}`,
        );
        preArchiveShas.set(e.id, {
          tipSha: copyTip,
          headSha: f.headSha ?? null,
        });
        if (ledger) {
          deps.janitor.upsertItem(
            e.id,
            {
              projectId: e.projectId ?? null,
              path: e.path ?? null,
              branch: e.branchName ?? null,
              threadId: pickThreadId(e),
              state: "kept",
              reason: "removing",
              tipSha: copyTip,
            },
            at,
          );
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
            } else {
              // The thread is live again — a stale id in `archivedNow`
              // would let the settle below write «removed» for an env
              // (blamed only via the run-start member set) whose threads
              // are alive (PLUG-204).
              archivedNow.delete(u);
              summary.archivedThreads -= 1;
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
      // §17.4 (ревью PLUG-221): a «removing copy» journal line needs
      // its pair when the run keeps the copy — otherwise the journal
      // claims «removing» for a copy that is still there (a failed
      // archive, a thread outside the cascade holding the copy).
      const pre = preArchiveShas.get(env.id);
      if (pre) {
        log.info?.(
          `orchestrator janitor: kept copy ` +
            `${repoByEnv.get(env.id)?.commonDir ?? env.path}:` +
            `${env.branchName?.trim() ?? "-"} ` +
            `at ${pre.tipSha ?? "-"} (removal cancelled: ${reason})`,
        );
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
      if (!apply) {
        // Report mode (nothing is archived) — «готова к удалению».
        // §17.4 (С9): the item itself, not only the count — `janitor
        // run` prints the list and `janitor report` reads the rows.
        summary.ready += 1;
        summary.readyItems.push({
          envId: env.id,
          projectId: env.projectId ?? null,
          path: env.path ?? null,
          branch: env.branchName ?? null,
          threadId: pickThreadId(env),
          reason: "merged-ready",
        });
        writeKept(env, "merged-ready", facts.firstSeenAt);
        settle(env, "merged-ready");
        continue;
      }
      if (remaining.length > 0) {
        // §17.4 (С9, PLUG-212): apply leaves the copy — live threads
        // (a brand-new env thread outside the archived cascade,
        // PLUG-192) still hold it. Not «готова к удалению»: kept with
        // its own reason, like the unhandled-threads case above.
        writeKept(env, "threads-remaining", facts.firstSeenAt);
        settle(env, "threads-remaining");
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
        // §17.4 (ревью PLUG-218/220): recoverability — the copy's HEAD
        // and its branch tip were journaled and stamped BEFORE the
        // archive (a copy whose threads were already archived before
        // this run never saw that write — its tip is resolved here);
        // the settle write only flips the row to «removed» so the
        // branch restores with `git branch <name> <sha>` while gc
        // keeps the objects.
        const pre = preArchiveShas.get(env.id);
        const repo = repoByEnv.get(env.id);
        const envBranch = env.branchName?.trim();
        const branchTip = pre
          ? pre.tipSha
          : envBranch
            ? (
                await gitOut(deps.cmd, repo?.root ?? env.path!, [
                  "rev-parse",
                  "--verify",
                  "--quiet",
                  `refs/heads/${envBranch}`,
                ])
              )?.trim() || null
            : null;
        const copyTip = pre?.tipSha ?? branchTip ?? facts.headSha ?? null;
        const headSha = pre?.headSha ?? facts.headSha ?? null;
        log.info?.(
          `orchestrator janitor: removed copy ` +
            `${repo?.commonDir ?? env.path}:${envBranch ?? "-"} ` +
            `at ${copyTip ?? "-"} head ${headSha ?? "-"}`,
        );
        summary.removedItems.push({
          envId: env.id,
          branch: env.branchName ?? null,
          repo: repo?.commonDir ?? null,
          tipSha: copyTip,
          headSha,
        });
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
            tipSha: copyTip,
          },
          at,
        );
        ctx.definite.add(env.id);
      }
    }

    // §17.4 (ревью PLUG-221, PLUG-227): a copy row still sitting at «removing»
    // whose env BB no longer lists closes as «removed» — a crash
    // between the archive and the settle write left it dangling and the
    // per-env pass above never reaches a gone env (the same closing the
    // branch sweep below gives deleted branches). `tip_sha` stays
    // (`fields ?? prev`), so `report --json` now shows the removal SHA.
    for (const i of deps.janitor.items()) {
      if (
        i.state === "kept" &&
        i.reason === "removing" &&
        !i.env_id.startsWith("branch:") &&
        !ctx.allEnvIds.has(i.env_id)
      ) {
        ctx.definite.add(i.env_id);
        if (ledger) {
          deps.janitor.upsertItem(
            i.env_id,
            { state: "removed", reason: "removed", removedAt: at },
            at,
          );
        }
        let repoCommon: string | null = null;
        if (i.path) {
          const match = repoInfos.find(
            (r) =>
              i.path === r.root ||
              i.path!.startsWith(r.root + "/") ||
              i.path === r.commonDir ||
              i.path!.startsWith(r.commonDir + "/"),
          );
          if (match) repoCommon = match.commonDir;
        }
        if (!repoCommon && seenRoots.length === 1) {
          repoCommon = seenRoots[0].common;
        }
        const repoLabel = repoCommon ?? i.path ?? i.env_id;
        log.info?.(
          `orchestrator janitor: removed copy ` +
            `${repoLabel}:${i.branch ?? "-"} ` +
            `at ${i.tip_sha ?? "-"} (env gone)`,
        );
        summary.removedItems.push({
          envId: i.env_id,
          branch: i.branch ?? null,
          repo: repoCommon,
          tipSha: i.tip_sha ?? null,
          headSha: null,
        });
        summary.removedCopies += 1;
      }
    }

    // «Ветки без копий»: local `bb/` branches merged on origin (ancestor
    // or patch-equivalent) and not checked out anywhere are deleted
    // (apply mode only) — on a *later* run than the copy's own
    // archiving, once BB has freed the worktree. Deleting a branch
    // erases its own reflog, where a `reset`-orphaned commit may have
    // its only reference — so the «nothing lost» rule is re-checked
    // over that reflog first (§15, PLUG-195); a failure — or no merge
    // at all — keeps the branch (`branch-unpushed`, idle over
    // `abandonedAfter` → the «брошено» report). People's other
    // branches and rescue refs under `refs/orchestrator/` are never
    // touched (§16).
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
      // the sweep skips entirely rather than delete on a guess.
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
      // closes another's namesake (PLUG-197 PX5). §17.4 (PLUG-212):
      // closed under `ledger` like every other row — in report mode
      // too, or the gone branch hangs as «готова» forever.
      const prefix = `branch:${commonDir}:`;
      const present = new Set(localBranches);
      for (const i of deps.janitor.items()) {
        if (
          i.env_id.startsWith(prefix) &&
          !present.has(i.env_id.slice(prefix.length))
        ) {
          ctx.definite.add(i.env_id);
          if (ledger) {
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
        const merged = await shaMergedIn(root, branch, protectedTargets);
        // §16.3: a branch that is not «влита» can never pass «ничего
        // не теряется» — its tip alone is unpublished work — so it
        // stays (`branch-unpushed`), reported once its reflog idles
        // past `abandonedAfter`.
        const tip = merged
          ? (
              await gitOut(deps.cmd, root, [
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/heads/${branch}`,
              ])
            )?.trim()
          : null;
        // §15 «Ветки без копий»: every position of the branch's own
        // reflog must be safe before the delete erases it — checked
        // per commit (PLUG-197: «A + revert A» nets to origin, but A
        // never reached it).
        const safe = !merged
          ? ("lost" as const)
          : tip
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
          const prevReported = ledger
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
          if (ledger) {
            deps.janitor.upsertItem(
              envId,
              {
                branch,
                state: abandoned ? "reported" : "kept",
                reason: "branch-unpushed",
              },
              at,
            );
          }
          continue;
        }
        reportedMem.delete(envId);
        // §16.3 (PLUG-203): openness was proven by the run-start
        // `worktree list`, minutes stale by now — re-read it
        // immediately before the delete; a branch checked out in a new
        // copy meanwhile (e.g. `bb thread restore-environment`) must
        // not be deleted from under it. A failed re-list proves
        // nothing → the branch stays.
        let openedNow = false;
        let relistFailed = false;
        if (apply && cfg.deleteBranches) {
          const freshWtl = await gitOut(deps.cmd, root, [
            "worktree",
            "list",
            "--porcelain",
          ]);
          if (freshWtl === null) {
            relistFailed = true;
          } else {
            openedNow = parseWorktreeList(freshWtl)
              .worktrees.filter((w) => !w.prunable && existsSync(w.path))
              .some((w) => w.branch === branch);
          }
        }
        if (openedNow || relistFailed) {
          keep(summary, openedNow ? "branch-open" : "branch-delete-failed");
          continue;
        }
        summary.orphanBranches += 1;
        // §17.4 (С9, PLUG-212): a merged copy-less `bb/` branch is
        // «готова к удалению» only when `apply` would truly delete it —
        // `deleteBranches: true`. With the flag off the sweep never
        // removes it: `branch-kept-config`, never `merged-ready`.
        const branchOwner =
          deps.janitor.item(envId) ??
          deps.janitor
            .items()
            .find((i) => i.branch === branch && i.env_id !== envId);
        const willDelete = apply && cfg.deleteBranches;
        if (cfg.deleteBranches && !willDelete) {
          // A report-mode pass under a deleteBranches config — the
          // apply run would delete this branch.
          summary.readyItems.push({
            envId,
            projectId: branchOwner?.project_id ?? null,
            path: null,
            branch,
            threadId: branchOwner?.thread_id ?? null,
            reason: "merged-ready",
          });
        }
        if (!cfg.deleteBranches) keep(summary, "branch-kept-config");
        let deleted = false;
        if (willDelete) {
          // §17.4 (ревью PLUG-219, PLUG-220): the tip is journaled and
          // stamped into the ledger BEFORE `update-ref -d` — a crash
          // between the delete and the «removed» write below would take
          // the SHA with it (deleting a branch erases its own reflog,
          // the SHA's last reference). The row sits at «removing»;
          // success flips it to «removed», a refused delete to
          // «branch-delete-failed» (`tip_sha` survives either way).
          log.info?.(
            `orchestrator janitor: removing branch ` +
              `${commonDir}:${branch} at ${tip}`,
          );
          if (ledger) {
            deps.janitor.upsertItem(
              envId,
              {
                projectId: branchOwner?.project_id ?? null,
                threadId: branchOwner?.thread_id ?? null,
                branch,
                state: "kept",
                reason: "removing",
                tipSha: tip ?? null,
              },
              at,
            );
          }
          // §15/§16.3 (PLUG-199): delete atomically against the tip the
          // checks above verified — `branch -D` removes whatever the
          // ref points at NOW, so a mid-run `branch -f` would slip an
          // unverified position under the delete.
          if (
            await gitOk(deps.cmd, root, [
              "update-ref",
              "-d",
              `refs/heads/${branch}`,
              tip!,
            ])
          ) {
            summary.removedBranches += 1;
            deleted = true;
            // §17.4 (ревью PLUG-218): the deleted tip goes to the
            // plugin journal (and the ledger row below) — restore with
            // `git branch <name> <sha>` while gc keeps the objects.
            log.info?.(
              `orchestrator janitor: removed branch ` +
                `${commonDir}:${branch} at ${tip}`,
            );
            summary.removedItems.push({
              envId,
              branch,
              repo: commonDir,
              tipSha: tip ?? null,
              headSha: null,
            });
          } else {
            keep(summary, "branch-delete-failed");
          }
        }
        // The branch is gone or provably safe — a stale «брошено» row
        // for it closes either way. §17.4 (С9): the row is written in
        // report mode too — `janitor report` lists it as «готова к
        // удалению» (`merged-ready`) only when `deleteBranches` is on;
        // otherwise `branch-kept-config` (PLUG-212). A refused
        // `update-ref -d` leaves the branch alive — the row is `kept`
        // with `branch-delete-failed`, never `removed` (PLUG-213).
        if (ledger) {
          deps.janitor.upsertItem(
            envId,
            {
              projectId: branchOwner?.project_id ?? null,
              threadId: branchOwner?.thread_id ?? null,
              branch,
              state: deleted ? "removed" : "kept",
              reason: deleted
                ? "removed"
                : willDelete
                  ? "branch-delete-failed"
                  : cfg.deleteBranches
                    ? "merged-ready"
                    : "branch-kept-config",
              removedAt: deleted ? at : null,
              tipSha: deleted ? tip : null,
            },
            at,
          );
        }
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
        if (ledger) {
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
      // §15 «Ветки без копий» (PLUG-202): abandoned copy-less `bb/`
      // branches go into the message as a count with the first 10 —
      // the full list lives in `janitor report`.
      const copies = items.filter((i) => !i.envId.startsWith("branch:"));
      const branches = items.filter((i) => i.envId.startsWith("branch:"));
      const parts: string[] = [];
      if (copies.length) {
        const list = copies
          .slice(0, 8)
          .map(
            (i) =>
              (i.branch ?? i.path ?? i.envId) +
              // §16.3: «похоже, влито squash» — the manual-check flag.
              (i.reason === "squash-suspect" ? " (squash?)" : ""),
          )
          .join(", ");
        parts.push(
          t("jn.newAbandonedCopies", { n: copies.length, list }) +
            (copies.length > 8
              ? t("jn.andMore", { n: copies.length - 8 })
              : ""),
        );
      }
      if (branches.length) {
        const names = branches
          .slice(0, 10)
          .map((b) => b.branch ?? b.envId)
          .join(", ");
        parts.push(
          t("jn.abandonedBranches", { n: branches.length, names }) +
            (branches.length > 10
              ? t("jn.andMore", { n: branches.length - 10 })
              : ""),
        );
      }
      try {
        await deps.threads.send({
          threadId: coordinator,
          mode: "queue-if-active",
          input: [
            {
              type: "text",
              text:
                t("jn.notify", { parts: parts.join("; ") }),
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
  ): Promise<{
    sha: string | null;
    partial: boolean;
    /** §16.4 r29 п.5: the failing step and its error for the
     * «снимок НЕ удался (<шаг>: <ошибка>)» coordinator line. */
    step?: string;
    error?: string;
  }> => {
    const headRes = await gitRes(deps.cmd, path, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const head = headRes.code === 0 ? headRes.stdout.trim() : "";
    if (!head) {
      return {
        sha: null,
        partial: false,
        step: "rev-parse HEAD",
        error: headRes.stderr.trim() || `exit ${headRes.code}`,
      };
    }
    const stashRes = await gitRes(deps.cmd, path, ["stash", "create"]);
    if (stashRes.code !== 0) {
      return {
        sha: null,
        partial: false,
        step: "stash create",
        error: stashRes.stderr.trim() || `exit ${stashRes.code}`,
      };
    }
    const w = stashRes.stdout.trim() || null;
    const untracked =
      (await gitOut(deps.cmd, path, [
        "ls-files",
        "-z",
        "-o",
        "--exclude-standard",
      ])) ?? "";
    // §15 п.3 (PLUG-202): `skip-worktree`/`assume-unchanged` edits are
    // invisible to `stash create` too — flagged-and-changed files ride
    // the untracked commit so their content survives. A failed probe
    // marks the snapshot partial rather than silently skipping them.
    const hidden = await hiddenChangedFiles(path);
    const uFiles = [
      ...new Set([
        ...untracked.split("\0").filter(Boolean),
        ...(hidden ?? []),
      ]),
    ];
    if (!uFiles.length) {
      return w === null && hidden !== null && !hidden.length
        ? {
            sha: null,
            partial: false,
            step: "snapshot",
            error: "nothing to save",
          }
        : { sha: w, partial: hidden === null };
    }
    // §16.4 r29 п.4: the temporary index lives in a unique mkdtemp
    // directory, not a pid+time name (a concurrent rescue of the same
    // copy cannot collide with itself).
    const tmpDir = mkdtempSync(join(tmpdir(), "jan-rescue-"));
    const tmpIndex = join(tmpDir, "index");
    const tmpPaths = join(tmpDir, "paths");
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
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // temp dir removal failed — harmless
      }
    }
  };

  const RESCUE_PREFIX = "refs/orchestrator/rescue/";
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** §16.4 r29 п.3: the snapshot number of a thread's rescue ref —
   * `refs/orchestrator/rescue/<id>` counts as 1, `<id>-N` as N; 0 for
   * anything else under the prefix. */
  const rescueN = (base: string, ref: string): number => {
    if (ref === base) return 1;
    const m = new RegExp(`^${escapeRe(base)}-(\\d+)$`).exec(ref);
    return m ? Number(m[1]) : 0;
  };

  /** §16.4 r29 п.3: all saved snapshots of a thread, oldest first —
   * `refs/orchestrator/rescue/<id>` counts as N=1, `<id>-N` as N. */
  const listRescueRefs = async (
    path: string,
    threadId: string,
  ): Promise<string[]> => {
    const out = await gitOut(deps.cmd, path, [
      "for-each-ref",
      "--format=%(refname)",
      RESCUE_PREFIX.replace(/\/$/, ""),
    ]);
    if (!out) return [];
    const base = `${RESCUE_PREFIX}${threadId}`;
    return out
      .split("\n")
      .map((r) => r.trim())
      .filter((r) => rescueN(base, r) > 0)
      .sort((a, b) => rescueN(base, a) - rescueN(base, b));
  };

  /** The three trees that define a snapshot's content
   * (`<rev>^{tree}`, `^2^{tree}`, `^3^{tree}` — worktree, index,
   * untracked); null when even the main tree cannot be resolved. */
  const snapshotTrees = async (
    path: string,
    rev: string,
  ): Promise<string | null> => {
    const parts: string[] = [];
    for (const spec of ["^{tree}", "^2^{tree}", "^3^{tree}"]) {
      const t =
        (
          await gitOut(deps.cmd, path, [
            "rev-parse",
            "--verify",
            "--quiet",
            `${rev}${spec}`,
          ])
        )?.trim() ?? "";
      parts.push(t);
    }
    return parts[0] ? parts.join(" ") : null;
  };

  /** §16.4 r29 п.3: unproven sameness counts as different — a repeated
   * snapshot is cheaper than lost work. */
  const sameSnapshot = async (
    path: string,
    a: string,
    b: string,
  ): Promise<boolean> => {
    const ta = await snapshotTrees(path, a);
    const tb = await snapshotTrees(path, b);
    return ta !== null && ta === tb;
  };

  /**
   * §16.4: `thread.archived` AND `thread.deleted` (r29) for an executor
   * thread — while BB still holds the copy (the ~5-minute window after
   * the first of the two events), a dirty state is committed to
   * `refs/orchestrator/rescue/<thread>` (`-<N>` for a changed repeat
   * snapshot) and the coordinator gets a restore command into a *new*
   * worktree (never the main checkout, where somebody else's work may
   * be in flight). Rescue is unconditional: it does not depend on
   * `janitor.enabled` or a valid config — a user who keeps the janitor
   * off still gets the safety net. Clean copies and non-executor
   * threads are no-ops; the janitor never deletes refs under
   * `refs/orchestrator/`.
   *
   * r29 п.2: the env phase is NOT checked (a still-active turn keeps
   * `phase=active` although BB retires the copy); silence only when
   * another LIVE thread shares the env — BB keeps a shared env. An
   * unproven thread list means rescue, a gone copy/env means silence
   * (journal only). r29 п.3: a snapshot identical to the latest saved
   * one writes no ref and sends no line. r29 п.4: the ref is created
   * atomically (`update-ref <ref> <sha> ""`), and rescues of one
   * thread are serialized by an in-plugin queue.
   */
  const rescueOnGone = async (
    thread: {
      id: string;
      environmentId?: string | null;
      parentThreadId?: string | null;
      sourceThreadId?: string | null;
      originPluginId?: string | null;
    },
    cause: "archived" | "deleted",
  ): Promise<void> => {
    const reasonWord =
      cause === "deleted"
        ? t("jn.reasonDeleted")
        : t("jn.reasonArchived");
    // Scope check when the event carries the fields; absent fields mean
    // «unknown» — rescuing a dirty copy is harmless, so proceed.
    const fieldsKnown =
      thread.originPluginId !== undefined ||
      thread.parentThreadId !== undefined ||
      thread.sourceThreadId !== undefined;
    const worker =
      // §4 r30 д: own-spawn executors carry `orchestrator`.
      thread.originPluginId === "tasks" ||
      thread.originPluginId === "orchestrator" ||
      !!thread.parentThreadId ||
      !!thread.sourceThreadId;
    if (fieldsKnown && !worker) return;
    const envId = thread.environmentId;
    if (!envId) return;
    const env = await showEnvironment(envId);
    const path = env?.path;
    if (!path || !existsSync(path)) {
      // §16.4 r29 п.2: the copy/env is already gone (BB retired it
      // after an earlier archive) — silence, journal only.
      log.info?.(
        `orchestrator janitor: rescue ${thread.id} (${cause}): ` +
          `env ${envId} copy already gone`,
      );
      return;
    }
    const statusText = await gitOut(deps.cmd, path, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (statusText === null) return;
    // §15 п.3 (PLUG-202): a copy whose only changes hide behind
    // `skip-worktree`/`assume-unchanged` looks clean to `git status`
    // but still holds work — rescue it the same way.
    if (!statusText.trim()) {
      const hidden = await hiddenChangedFiles(path);
      if (!hidden?.length) return;
    }
    // §16.4 r29 п.2: another LIVE thread of the same env (not
    // archived, not deleted, not the event's own) keeps the env — BB
    // does not retire a shared copy, so nothing is at risk. The same
    // env-thread list the janitor itself uses; an unproven list means
    // rescue rather than silence.
    // §16.4 r29 п.2: «живой» only when the DTO proves it — a missing
    // `archivedAt` cannot prove «не в архиве» (нет поля → спасать,
    // ревью PLUG-240). `deletedAt` absent is the norm — deleted
    // threads are excluded from the list server-side; only a set one
    // disqualifies.
    const liveThread = (t: ThreadDto) =>
      t.archivedAt === null && !t.deletedAt;
    const threadsNow = await listThreads();
    if (
      threadsNow !== null &&
      threadsNow.some(
        (t) =>
          t.environmentId === envId &&
          t.id !== thread.id &&
          liveThread(t),
      )
    ) {
      return;
    }
    const coordinator =
      deps.store.byThreadId(thread.id)?.coordinator_thread_id ??
      thread.parentThreadId ??
      null;
    // §16.4 r29 п.6: the coordinator may be deleted by the same
    // cascade (r27 makes executors its children) — a proven-absent
    // coordinator or a failed send lands in the plugin journal (warn)
    // and the rescue table, so saved work is never lost silently.
    const coordGone =
      coordinator !== null &&
      threadsNow !== null &&
      !threadsNow.some((t) => t.id === coordinator && liveThread(t));
    let sendError: string | null = null;
    const sendLine = async (text: string): Promise<boolean> => {
      if (!coordinator) return false;
      try {
        await deps.threads.send({
          threadId: coordinator,
          mode: "queue-if-active",
          input: [{ type: "text", text, mentions: [] }],
        });
        return true;
      } catch (e) {
        sendError = message(e);
        return false;
      }
    };
    const record = (r: {
      ref: string | null;
      repoRoot: string | null;
      notified: boolean;
      error?: string | null;
    }) => {
      try {
        deps.janitor.addRescue(
          {
            threadId: thread.id,
            ref: r.ref,
            repoRoot: r.repoRoot,
            // §7: the ledger `reason` is a machine contract
            // («заархивирован|удалён») — never the translated word.
            reason: cause === "deleted" ? "удалён" : "заархивирован",
            notified: r.notified,
            error: r.error ?? null,
          },
          now(),
        );
      } catch (e) {
        log.warn?.(
          `orchestrator janitor: rescue record ${thread.id}: ${message(e)}`,
        );
      }
      if (!r.notified) {
        log.warn?.(
          `orchestrator janitor: rescue ${thread.id}: ` +
            t("jn.rescueNotDelivered", {
              id: thread.id,
              reason:
                coordinator === null
                  ? t("jn.coordUnknown")
                  : coordGone
                    ? t("jn.coordDeleted", { id: coordinator })
                    : t("jn.lineNotDelivered", { id: coordinator }),
              err:
                coordinator !== null && !coordGone && sendError
                  ? ` (${sendError})`
                  : "",
              ref: r.ref ?? t("jn.snapFailed"),
              path,
            }),
        );
      }
    };
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
    // POSIX single-quoting — the hint is a copy-paste shell command and
    // a repo path may contain spaces (PLUG-204).
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const failLine = (step: string, error: string) =>
      t("jn.failLine", {
        id: thread.id,
        reason: reasonWord,
        step,
        error,
        path,
      });
    const snap = await rescueCommit(path, thread.id);
    if (!snap.sha) {
      const step = snap.step ?? "snapshot";
      const error = snap.error ?? "unknown";
      const delivered = await sendLine(failLine(step, error));
      record({
        ref: null,
        repoRoot,
        notified: delivered && !coordGone,
        error: `${step}: ${error}`,
      });
      return;
    }
    const refBase = `${RESCUE_PREFIX}${thread.id}`;
    const existing = await listRescueRefs(path, thread.id);
    const latest = existing[existing.length - 1];
    if (latest && (await sameSnapshot(path, snap.sha, latest))) {
      // §16.4 r29 п.3: same content already saved — no ref, no line.
      log.info?.(
        `orchestrator janitor: rescue ${thread.id}: ` +
          `snapshot unchanged — already saved at ${latest}`,
      );
      return;
    }
    // §16.4 r29 п.4: atomic create — `update-ref <ref> <sha> ""`
    // writes only when the ref is absent; a lost race (or a stale
    // candidate from listRescueRefs) is not a failure: compare with
    // the occupying ref, identical → done, different → try N+1.
    // §16.4 r29 п.3: the new ref is <id>-<maxN+1>, never a filled
    // hole (ревью PLUG-240) — a freed number reused later would
    // sit below the newest snapshot the п.3 comparison runs against.
    const maxN = existing.reduce(
      (m, r) => Math.max(m, rescueN(refBase, r)),
      0,
    );
    let n = Math.max(1, maxN);
    let candidate = maxN === 0 ? refBase : `${refBase}-${maxN + 1}`;
    let ref: string | null = null;
    let updateErr: string | null = null;
    for (let attempt = 0; attempt < 64; attempt++) {
      const r = await gitRes(deps.cmd, path, [
        "update-ref",
        candidate,
        snap.sha,
        "",
      ]);
      if (r.code === 0) {
        ref = candidate;
        break;
      }
      const occupied = (
        await gitOut(deps.cmd, path, [
          "rev-parse",
          "--verify",
          "--quiet",
          candidate,
        ])
      )?.trim();
      if (!occupied) {
        updateErr = r.stderr.trim() || `exit ${r.code}`;
        break;
      }
      if (await sameSnapshot(path, snap.sha, candidate)) {
        log.info?.(
          `orchestrator janitor: rescue ${thread.id}: ` +
            `snapshot unchanged — already saved at ${candidate}`,
        );
        return;
      }
      candidate = `${refBase}-${++n}`;
    }
    if (!ref) {
      const error = updateErr ?? "no free ref name";
      const delivered = await sendLine(failLine("update-ref", error));
      record({
        ref: null,
        repoRoot,
        notified: delivered && !coordGone,
        error: `update-ref: ${error}`,
      });
      return;
    }
    // §16.4 r29 п.3: a repeat snapshot restores into its own
    // `<repo>-rescue-<id>-<N>` directory so it cannot collide with an
    // already-restored first snapshot.
    const suffix = ref === refBase ? "" : ref.slice(refBase.length);
    const rescueDir = join(
      dirname(repoRoot),
      `${basename(repoRoot)}-rescue-${thread.id}${suffix}`,
    );
    const delivered = await sendLine(
      t("jn.rescueLine", {
        id: thread.id,
        reason: reasonWord,
        partial: snap.partial ? t("jn.partialSuffix") : "",
        ref,
        repo: q(repoRoot),
        dir: q(rescueDir),
      }),
    );
    record({ ref, repoRoot, notified: delivered && !coordGone });
  };

  /** §16.4 r29 п.4: rescue calls for one thread run one at a time —
   * a cascade (archive → delete, coordinator + children deleted
   * together) cannot interleave two snapshots of the same copy. */
  const rescueQueue = new Map<string, Promise<void>>();
  const onThreadGone = (
    thread: {
      id: string;
      environmentId?: string | null;
      parentThreadId?: string | null;
      sourceThreadId?: string | null;
      originPluginId?: string | null;
    },
    cause: "archived" | "deleted",
  ): Promise<void> => {
    const prev = rescueQueue.get(thread.id) ?? Promise.resolve();
    const next = prev
      .then(() => rescueOnGone(thread, cause))
      .catch((e) =>
        log.warn?.(
          `orchestrator janitor: rescue ${thread.id}: ${message(e)}`,
        ),
      );
    rescueQueue.set(thread.id, next);
    return next.finally(() => {
      if (rescueQueue.get(thread.id) === next) {
        rescueQueue.delete(thread.id);
      }
    });
  };
  const onThreadArchived = (thread: {
    id: string;
    environmentId?: string | null;
    parentThreadId?: string | null;
    sourceThreadId?: string | null;
    originPluginId?: string | null;
  }) => onThreadGone(thread, "archived");
  const onThreadDeleted = (thread: {
    id: string;
    environmentId?: string | null;
    parentThreadId?: string | null;
    sourceThreadId?: string | null;
    originPluginId?: string | null;
  }) => onThreadGone(thread, "deleted");

  const report = async (): Promise<JanitorReport> => {
    const cfgLoad = await deps.loadConfig();
    const items = deps.janitor.items();
    const lastRun = deps.janitor.latestRun();
    // §17.4 (С9, PLUG-212): the report lists rows of the LAST run —
    // a row not refreshed by it (the env was deleted outside the
    // janitor, moved under an excluded project, or its verdict
    // changed) no longer claims «готова» or «брошено».
    const since = lastRun?.started_at ?? Number.NEGATIVE_INFINITY;
    const lastRunRow = (i: { last_checked_at: number | null }) =>
      i.last_checked_at != null && i.last_checked_at >= since;
    // §17.4 (ревью PLUG-220): `tip_sha` is a removal record — the
    // report shows it only on `removed` rows; a live row may still
    // carry an old deletion's SHA (`fields ?? prev` never erases) and
    // must not advertise it.
    const shownSha = (i: { state: string; tip_sha: string | null }) =>
      i.state === "removed" ? i.tip_sha : null;
    return {
      config: cfgLoad.config,
      configErrors: cfgLoad.errors,
      lastRun,
      items: items.map((i) =>
        i.state === "removed" ? i : { ...i, tip_sha: null },
      ),
      abandoned: items
        .filter((i) => i.state === "reported" && lastRunRow(i))
        .map((i) => ({
          envId: i.env_id,
          projectId: i.project_id,
          path: i.path,
          branch: i.branch,
          threadId: i.thread_id,
          reason: i.reason ?? "",
          tipSha: shownSha(i),
        })),
      // §17.4 (С9): «готова к удалению» rows — what `apply` would
      // remove. Written by report-mode and apply passes alike, so the
      // report answers «что удалится» in either mode.
      ready: items
        .filter(
          (i) =>
            i.state !== "removed" &&
            i.reason === "merged-ready" &&
            lastRunRow(i),
        )
        .map((i) => ({
          envId: i.env_id,
          projectId: i.project_id,
          path: i.path,
          branch: i.branch,
          threadId: i.thread_id,
          reason: i.reason ?? "",
          tipSha: shownSha(i),
        })),
      rescues: deps.janitor.rescues(),
    };
  };

  return { run, report, onThreadArchived, onThreadDeleted };
}
