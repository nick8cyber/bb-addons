/**
 * `merge` — §14 (+ §16.2/§16.6): merge a finished round's result into the
 * coordinator's worktree. Only the delegation's own coordinator may call it;
 * the target copy is that thread's environment. Refusals carry codes:
 * `dirty-result`, `protected-branch`, `stale-result`, `stale-check-failed`,
 * `not-done`, `no-result`, `no-environment`, `dirty-coordinator`,
 * `detached-head`, `unknown-branch`, `result-missing`, `merge-in-progress`,
 * `already-merged`, `fix-delegated`, `merge-hook-failed`, `copy-not-restored`,
 * `copy-busy`, `nothing-to-merge`.
 *
 * Order: row checks (done, result, `merged`/`fix-delegated` repeats) →
 * coordinator environment → copy lock (a lock file in the copy's git dir,
 * §14 check 4) → the row checks REPEAT under the lock (the row may have
 * changed while the call waited) → no unfinished merge/cherry-pick/
 * revert/rebase in the copy (`copy-busy`) → clean copy + on-branch →
 * target branch (`--into`, local branch only, never protected) → §16.2
 * stale check (result_sha vs the executor copy's HEAD; a confirmed-deleted
 * copy — 404 — skips it) → `git cat-file -e` → `git merge --no-ff --no-edit
 * -m "merge <KEY> r<N> (<sha7>)" <result_sha>` under the repo's configured
 * identity (never `--author`/`-c user.*`/`--no-verify`), with a ~10 min
 * ceiling for hooks. A conflict aborts back to a clean copy
 * (`merge_status = conflict`), tells the coordinator one line, and — when
 * the `mergeAutofix` setting is on and `--no-autofix` was not given —
 * delegates a fix round (same task and level, `--from result_sha`) and
 * records `fix-delegated`. A merge that stops without conflicted files
 * (hook refusal, timeout) is `merge-hook-failed` — no fix round. Whatever
 * failed, the copy must return to its original branch and HEAD with a
 * clean status, else `copy-not-restored`. The lock file records that
 * original branch and HEAD: a stale lock (dead owner) breaks only after
 * the copy is restored to them, and the break is an atomic rename — only
 * one process ever steals the file. `--dry-run` runs the checks and
 * `git merge-tree --write-tree refs/heads/<into> <sha>` only (exit 0
 * clean, 1 conflict, anything else is `git-failed`); the copy is not
 * touched.
 *
 * git operations run off the `delegate` queue (§16.8): the autofix
 * delegation itself goes through `delegate`, which is queued internally.
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OrchestratorError } from "./errors.js";
import { runChecked, type BbCli } from "./bb-cli.js";
import type { DelegationRow, DelegationStore } from "./store.js";

/**
 * §14 check 3 — protected branches refuse `merge` (code goes out through
 * `release` instead). The effective list comes from the janitor
 * `protectedBranches` setting via `MergeDeps.protectedBranches` (§17.3);
 * this constant is only the fallback when the setting is unset.
 */
export const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "dev"] as const;

/** §14: merge hooks may run test suites — well above cmd's 60 s default. */
const MERGE_TIMEOUT_MS = 10 * 60_000;

/** §14 check 4: lock file inside the copy's git dir (per-worktree).
 * §16.6: `release` takes the same lock when it works inside the
 * coordinator's copy (merged_into publication). */
export const MERGE_LOCK_NAME = "orchestrator-merge.lock";

export interface MergeGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `git` inside a worktree — shared by `merge` and `release`. */
export type MergeGit = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<MergeGitResult>;

export interface MergeParams {
  /** Task key (latest `done` delegation with a result) or delegation id. */
  ref: string;
  into?: string;
  noAutofix?: boolean;
  dryRun?: boolean;
  /** The calling thread — must equal the delegation's coordinator. */
  callerThreadId: string;
}

export interface MergeDeps {
  store: DelegationStore;
  bbCli: BbCli;
  /** `git` inside a worktree; returns exit/stdout/stderr, never throws. */
  git(
    repo: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<MergeGitResult>;
  /** A thread's environment (SDK or `bb environment show`). */
  environment(threadId: string): Promise<{ path?: string | null } | null>;
  /** An environment by id — the §16.2 stale check on `result_env_id`. */
  environmentById?(envId: string): Promise<{ path?: string | null } | null>;
  threads: {
    send(args: {
      threadId: string;
      mode: "queue-if-active";
      input: unknown[];
    }): Promise<unknown>;
  };
  /** The §14 conflict-fix round: same task/level, `--from result_sha`. */
  delegate(input: {
    taskKey: string;
    level: string;
    from?: string;
    instructions?: string;
  }): Promise<{ delegationId: number; threadId: string | null }>;
  /**
   * §17.2 (e2e 1): force the delegation's bookkeeping up to date before
   * judging `done` — BB's outcome notice reaches the coordinator seconds
   * before the watchdog writes the status, and a `merge` issued on that
   * notice must re-check a fresh row instead of answering `not-found`.
   */
  syncRow?(row: DelegationRow): Promise<void>;
  /**
   * §17.2 r26 (PLUG-211 Б3): which levels count as the executor whose
   * NEWEST delegation a task ref is judged by — review and release-audit
   * rows share the task's delegation list but are never merge targets.
   * Absent dep = every level counts.
   */
  isExecutorLevel?(level: string): boolean;
  protectedBranches?: readonly string[];
  /** §16.6 `mergeAutofix` setting — off by default (report only). */
  mergeAutofix?: () => boolean;
  /** §16.6 `threadIds` of the project's release config: `false` → the
   * merge message drops the task key (`merge r<N> (<sha7>)`). Default
   * on when unset. §6 (r7): the settings project is resolved by the
   * repository (`repoPath`), `projectId` is only the fallback. */
  releaseThreadIds?: (
    repoPath: string,
    projectId: string | null,
  ) => boolean | Promise<boolean>;
  log?: { warn?(message: string): void };
}

export interface MergeDryRunOutcome {
  ok: true;
  dryRun: true;
  delegationId: number;
  taskKey: string;
  round: number;
  into: string;
  wouldConflict: boolean;
  conflictFiles: string[];
}

export interface MergeOutcome {
  ok: true;
  delegationId: number;
  taskKey: string;
  round: number;
  into: string;
  mergeStatus: "merged" | "conflict" | "fix-delegated";
  mergedSha?: string;
  conflictFiles?: string[];
  fixDelegationId?: number;
  fixThreadId?: string | null;
  warning?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sha7 = (sha: string) => sha.slice(0, 7);

type Git = MergeGit;

/**
 * §14 check 1 + repeat calls, as a reusable unit: they run before the
 * copy lock AND again under it — the row may have changed while the
 * call waited (`merged`/`fix-delegated` are terminal for `merge`; the
 * fix round's own row is what gets merged next).
 */
function assertMergeableRow(row: DelegationRow): string {
  if (row.status !== "done") {
    throw new OrchestratorError(
      "not-done",
      `delegation ${row.id} is ${row.status}, not done`,
      "merge works on finished rounds — see `bb orchestrator status`",
    );
  }
  // §4.1 r28.1: a «задача без кода» round that produced no commits has
  // nothing to merge — the refusal comes before the result checks.
  if (row.no_code === 1 && (row.result_commits ?? 0) === 0) {
    throw new OrchestratorError(
      "nothing-to-merge",
      "задача без кода: вливать нечего",
    );
  }
  if (!row.result_sha) {
    throw new OrchestratorError(
      "no-result",
      `delegation ${row.id} has no recorded round result`,
      "the watchdog could not read the executor worktree — check setup_errors in `bb orchestrator show`",
    );
  }
  if (row.result_dirty === 1) {
    throw new OrchestratorError(
      "dirty-result",
      "исполнитель не закоммитил: копия захода грязная",
      "доработка — новым заходом: `bb orchestrator delegate <KEY> --level <уровень>`",
    );
  }
  if (row.merge_status === "merged") {
    throw new OrchestratorError(
      "already-merged",
      `делегирование ${row.id} уже влито в ${row.merged_into ?? "?"} (${row.merged_sha ? sha7(row.merged_sha) : "?"})`,
    );
  }
  if (row.merge_status === "fix-delegated") {
    throw new OrchestratorError(
      "fix-delegated",
      `по делегированию ${row.id} уже раздан заход разбора конфликта`,
      "дождитесь его done и влейте его итог: `bb orchestrator merge <id захода разбора>`",
    );
  }
  return row.result_sha;
}

export async function runMerge(
  params: MergeParams,
  deps: MergeDeps,
): Promise<MergeOutcome | MergeDryRunOutcome> {
  const { store } = deps;
  const ref = params.ref.trim();

  const numeric = /^\d+$/.test(ref);
  let row = numeric
    ? store.get(Number(ref))
    : store.latestDoneResultByTask(ref);
  if (!numeric) {
    // §17.2 (e2e 1 + PLUG-211 Б3): a task ref is judged by the NEWEST
    // executor delegation of any round — BB's outcome notice reaches the
    // coordinator seconds before the watchdog writes `done`, and a merge
    // issued on that notice must sync/answer by the newest round, not
    // echo the previous one's record (`already-merged` of round 1 while
    // round 2 still runs, or round 1's result after round 2 finished).
    const latest = store
      .delegationsByTask(ref)
      .find((r) => deps.isExecutorLevel?.(r.level) ?? true);
    if (latest) {
      let fresh = latest;
      if (
        (latest.status === "dispatching" || latest.status === "running") &&
        deps.syncRow
      ) {
        await deps.syncRow(latest).catch(() => {});
        fresh = store.get(latest.id) ?? latest;
      }
      if (fresh.status === "done") {
        row = fresh;
      } else if (fresh.status !== "cancelled") {
        // §17.2 (PLUG-215 С1): the newest round failed/stalled/quota or
        // is still dispatching/running — its predecessor's result is NOT
        // merged silently (review may have rejected that round, and a
        // `stalled` round can still revive to `done`, §16.2). The
        // refusal names `merge <id>` for the previous round; only a
        // `cancelled` newest round — one the coordinator retracted — falls
        // back on its own.
        const inflight =
          fresh.status === "dispatching" || fresh.status === "running";
        throw new OrchestratorError(
          "not-done",
          inflight
            ? `делегирование ${fresh.id} ещё ${fresh.status}, итога нет`
            : `заход ${fresh.id} завершился ${fresh.status}, итога нет`,
          row && row.id !== fresh.id
            ? `прошлый итог — \`bb orchestrator merge ${row.id}\``
            : "merge works on finished rounds — see `bb orchestrator status`",
        );
      }
      // `cancelled` newest round: the newest FINISHED round stays the
      // merge target — `row` from latestDoneResultByTask above.
    }
  }
  if (!row) {
    const latest = numeric
      ? undefined
      : store.delegationsByTask(ref)[0];
    if (latest) {
      throw new OrchestratorError(
        "not-done",
        `делегирование ${latest.id} ещё ${latest.status}, итога нет`,
        "merge works on finished rounds — see `bb orchestrator status`",
      );
    }
    throw new OrchestratorError(
      "not-found",
      `no mergeable delegation for "${params.ref}"`,
      "`bb orchestrator status` lists delegations; a task key resolves to its latest done delegation with a result",
    );
  }
  // §17.2 (e2e 1): a numeric ref to a still-`running` row gets the same
  // sync-and-recheck before the `not-done` verdict.
  if (row.status === "running" && deps.syncRow) {
    await deps.syncRow(row).catch(() => {});
    row = store.get(row.id) ?? row;
  }
  if (params.callerThreadId !== row.coordinator_thread_id) {
    throw new OrchestratorError(
      "not-a-coordinator",
      `thread ${params.callerThreadId} is not the coordinator of delegation ${row.id}`,
      "only the delegating coordinator may merge its result",
    );
  }
  const resultSha = assertMergeableRow(row);

  const env = await deps
    .environment(params.callerThreadId)
    .catch((e: unknown) => {
      throw new OrchestratorError(
        "environment-failed",
        `cannot read the coordinator environment: ${message(e)}`,
      );
    });
  if (!env?.path) {
    throw new OrchestratorError(
      "no-environment",
      `coordinator thread ${params.callerThreadId} has no worktree`,
      "merge runs inside the coordinator thread's environment",
    );
  }
  const repo = env.path;
  const git: Git = (args, opts) => deps.git(repo, args, opts);
  const gitText = async (args: string[]): Promise<string> => {
    const r = await git(args);
    if (r.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `git ${args.join(" ")} failed (exit ${r.exitCode}): ${
          (r.stderr || r.stdout).trim() || "no output"
        }`,
      );
    }
    return r.stdout;
  };

  const gitDir = (await gitText(["rev-parse", "--absolute-git-dir"])).trim();
  const lockPath = join(gitDir, MERGE_LOCK_NAME);
  const releaseLock = await acquireCopyLock(git, repo, lockPath);
  try {
    // §14: the row is re-read under the lock — a concurrent merge may
    // have finished (merged), delegated a fix round, or the round result
    // may have been recomputed while this call waited.
    const fresh = store.get(row.id);
    if (!fresh) {
      throw new OrchestratorError(
        "not-found",
        `делегирование ${row.id} исчезло из хранилища`,
      );
    }
    const freshSha = assertMergeableRow(fresh);
    if (freshSha !== resultSha) {
      throw new OrchestratorError(
        "stale-result",
        `итог делегирования ${row.id} изменился: ${sha7(freshSha)} ≠ записанного ${sha7(resultSha)}`,
        "вливать нужно новый итог — повторите `bb orchestrator merge`",
      );
    }
    row = fresh;

    // §14 check 2: no unfinished merge/cherry-pick/revert/rebase in the
    // coordinator copy. `merge --no-commit` leaves a clean status, so the
    // git-dir markers are checked before --porcelain.
    const busy = COPY_BUSY_MARKERS.filter((n) =>
      existsSync(join(gitDir, n)),
    );
    if (busy.length > 0) {
      throw new OrchestratorError(
        "copy-busy",
        `в копии координатора незавершённая операция (${busy.join(", ")})`,
        "завершите или отмените её (git merge|cherry-pick|revert|rebase --abort) и повторите",
      );
    }
    // The coordinator copy is clean and sits on a branch.
    const porcelain = await gitText(["status", "--porcelain"]);
    if (porcelain.trim()) {
      throw new OrchestratorError(
        "dirty-coordinator",
        "копия координатора грязная (незакоммиченные правки)",
        "закоммить или уберите изменения и повторите",
      );
    }
    // `--short` shortens ambiguously (a tag `work` turns `work` into
    // `heads/work`) — the full ref keeps the branch name exact, so the
    // protected-branch check and `refs/heads/<into>` cannot be shadowed.
    let currentBranch: string;
    try {
      const headRef = (await gitText(["symbolic-ref", "HEAD"])).trim();
      currentBranch = headRef.startsWith("refs/heads/")
        ? headRef.slice("refs/heads/".length)
        : headRef;
      if (!currentBranch) throw new Error("empty HEAD ref");
    } catch {
      throw new OrchestratorError(
        "detached-head",
        "копия координатора на отсоединённом HEAD — ветки нет",
        "перейдите на ветку (git switch <branch>) и повторите",
      );
    }
    // §14: the lock file carries the copy's original state — if this
    // process dies mid-merge, a stale-lock breaker restores the copy to
    // this branch and HEAD before removing the lock.
    const originalHead = (await gitText(["rev-parse", "HEAD"])).trim();
    recordLockState(lockPath, currentBranch, originalHead);

    // §14 check 3: the merge target is `--into` or the current branch.
    // `--into` must name a LOCAL branch — `check-ref-format --branch`
    // validates the name, `show-ref --verify refs/heads/<name>` proves it
    // is a local branch (ref forms, tags and SHAs are refused). The
    // protected list sees the normalized name.
    let into = currentBranch;
    if (params.into?.trim()) {
      const fmt = await git([
        "check-ref-format",
        "--branch",
        params.into.trim(),
      ]);
      let normalized = fmt.exitCode === 0 ? fmt.stdout.trim() : "";
      if (normalized.startsWith("refs/heads/")) {
        normalized = normalized.slice("refs/heads/".length);
      }
      if (!normalized) {
        throw new OrchestratorError(
          "unknown-branch",
          `ветка-приёмник ${params.into.trim()} — не имя локальной ветки`,
        );
      }
      into = normalized;
    }
    const protectedBranches =
      deps.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
    if (protectedBranches.includes(into)) {
      throw new OrchestratorError(
        "protected-branch",
        `вливание в защищённую ветку ${into} запрещено`,
        "в защищённые ветки код уходит только через `bb orchestrator release`",
      );
    }
    if (params.into?.trim()) {
      const local = await git([
        "show-ref",
        "--verify",
        `refs/heads/${into}`,
      ]);
      if (local.exitCode !== 0) {
        throw new OrchestratorError(
          "unknown-branch",
          `ветка-приёмник ${into} — не локальная ветка копии`,
        );
      }
    }

    // §16.2: the recorded result must still be the executor copy's HEAD —
    // a revived thread that kept working makes the snapshot stale.
    await checkStaleResult(row, resultSha, deps);

    // The result must exist in the coordinator's repository (executor
    // worktrees share the object store; a foreign repo would not see it).
    const object = await git(["cat-file", "-e", resultSha]);
    if (object.exitCode !== 0) {
      throw new OrchestratorError(
        "result-missing",
        `коммит итога ${sha7(resultSha)} отсутствует в репозитории копии координатора`,
        "копия исполнителя и копия координатора должны быть worktree одного репозитория",
      );
    }

    // §14 `--dry-run`: checks + merge-tree only; the copy is not touched.
    // `refs/heads/<into>` — a bare name is ambiguous with a tag. Exit 1
    // is a conflict; any other non-zero exit is a git failure, not a
    // conflict prediction.
    if (params.dryRun) {
      // §17.4 (мелко 11): the plugin's git floor is 2.39
      // (`merge-tree --write-tree` is 2.38, `patch-id --verbatim`
      // 2.39) — below it the dry-run refuses with a hint instead of a
      // bare `git: 'merge-tree' is not a git command`.
      const ver = await git(["--version"]);
      const vm = /git version (\d+)\.(\d+)/.exec(ver.stdout);
      if (
        ver.exitCode !== 0 ||
        !vm ||
        Number(vm[1]) < 2 ||
        (Number(vm[1]) === 2 && Number(vm[2]) < 39)
      ) {
        throw new OrchestratorError(
          "unsupported-git",
          `merge --dry-run требует git ≥ 2.39 (merge-tree --write-tree)` +
            (vm ? `, найден ${vm[1]}.${vm[2]}` : " — `git --version` не прочитан"),
          "обновите git на машине копии",
        );
      }
      const probe = await git([
        "merge-tree",
        "--write-tree",
        "--name-only",
        `refs/heads/${into}`,
        resultSha,
      ]);
      if (probe.exitCode !== 0 && probe.exitCode !== 1) {
        throw new OrchestratorError(
          "git-failed",
          `git merge-tree failed (exit ${probe.exitCode}): ` +
            `${(probe.stderr || probe.stdout).trim() || "no output"}`,
        );
      }
      // merge-tree output: the tree oid, then conflicted file names up
      // to the first blank line; informational messages follow it and
      // are not file names.
      const conflictFiles: string[] = [];
      for (const line of probe.stdout.split("\n").slice(1)) {
        if (!line.trim()) break;
        conflictFiles.push(line.trim());
      }
      return {
        ok: true,
        dryRun: true,
        delegationId: row.id,
        taskKey: row.task_key,
        round: row.round,
        into,
        wouldConflict: probe.exitCode === 1,
        conflictFiles: probe.exitCode === 1 ? conflictFiles : [],
      };
    }

    // Move the clean copy onto the target branch — only now, so refused
    // calls leave the copy untouched. `git switch` takes a branch name
    // only — a tag or ref form cannot shadow `into`.
    let conflictFiles: string[] | null = null;
    let failure: OrchestratorError | null = null;
    let targetTip = "";
    try {
      if (into !== currentBranch) {
        await gitText(["switch", into]);
      }
      targetTip = (await gitText(["rev-parse", "HEAD"])).trim();
      // §16.6 `threadIds`: off → the merge message drops the task key
      // (`merge r<N> (<sha7>)`) so a public-facing release scan never
      // trips over the pipeline's own commit.
      const mergeMessage = ((await deps.releaseThreadIds?.(
        repo,
        row.project_id,
      )) ?? true)
        ? `merge ${row.task_key} r${row.round} (${sha7(resultSha)})`
        : `merge r${row.round} (${sha7(resultSha)})`;
      const mergeRes = await git(
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          mergeMessage,
          resultSha,
        ],
        { timeoutMs: MERGE_TIMEOUT_MS },
      );

      if (mergeRes.exitCode === 0) {
        const mergedSha = (await gitText(["rev-parse", "HEAD"])).trim();
        store.setMerged(row.id, { into, sha: mergedSha });
        await comment(row, `Влито в ${into} (${sha7(mergedSha)})`, deps);
        return {
          ok: true,
          delegationId: row.id,
          taskKey: row.task_key,
          round: row.round,
          into,
          mergeStatus: "merged",
          mergedSha,
        };
      }

      // Failure: conflicted files mean a real conflict; a merge that
      // stopped without any (hook refusal, timeout) is `merge-hook-failed`
      // and gets no fix round (§14).
      const unmerged = await unmergedFiles(git);
      if (unmerged.length > 0) {
        conflictFiles = unmerged;
      } else {
        failure = new OrchestratorError(
          "merge-hook-failed",
          `git merge не завершился без конфликтных файлов` +
            ` (отказ хука или таймаут, exit ${mergeRes.exitCode}): ` +
            `${(mergeRes.stderr || mergeRes.stdout).trim() || "no output"}`,
        );
      }
    } catch (e) {
      failure =
        e instanceof OrchestratorError
          ? e
          : new OrchestratorError("git-failed", message(e));
    }

    // §14: whatever failed, the copy returns to the original branch and
    // HEAD with a clean status — abort a dangling merge, switch back.
    const restoreError = await restoreCopy(
      git,
      currentBranch,
      originalHead,
    );
    if (restoreError) {
      store.setMergeStatus(row.id, "failed");
      throw new OrchestratorError(
        "copy-not-restored",
        `копия координатора не вернулась в исходное состояние: ${restoreError}`,
        `копия ${repo} — разберите вручную, там могло остаться незавершённое слияние`,
      );
    }
    if (failure) {
      store.setMergeStatus(row.id, "failed");
      throw failure;
    }

    store.setMergeStatus(row.id, "conflict");
    const base = {
      ok: true as const,
      delegationId: row.id,
      taskKey: row.task_key,
      round: row.round,
      into,
      conflictFiles: conflictFiles ?? [],
    };

    // §16.6: autofix needs the `mergeAutofix` setting AND no --no-autofix.
    const autofix = (deps.mergeAutofix?.() ?? false) && !params.noAutofix;
    if (!autofix) {
      await notifyCoordinator(
        row,
        `${row.task_key}: вливание захода ${row.round} в ${into} — конфликт` +
          `${base.conflictFiles.length ? ` (${base.conflictFiles.slice(0, 10).join(", ")})` : ""}. ` +
          `Разбор — вручную или новым заходом delegate (--from ${sha7(resultSha)})`,
        deps,
      );
      return { ...base, mergeStatus: "conflict" };
    }

    // §14 autofix: a fix round on the same task and level continues from
    // the conflicted result; its instructions name the target tip to
    // merge — with an explicit `-m`, no branch names (§16.6).
    const fixInstructions =
      `Влей ${into}@${sha7(targetTip)} в свою ветку:` +
      ` git merge -m "merge ${sha7(targetTip)}" ${targetTip};` +
      ` разреши конфликты по смыслу обеих сторон, прогони тесты, закоммить;` +
      ` в отчёте — какие файлы и как сведены`;
    try {
      const fix = await deps.delegate({
        taskKey: row.task_key,
        level: row.level,
        from: resultSha,
        instructions: fixInstructions,
      });
      store.setMergeStatus(row.id, "fix-delegated");
      await notifyCoordinator(
        row,
        `${row.task_key}: вливание захода ${row.round} в ${into} — конфликт;` +
          ` раздан заход разбора #${fix.delegationId}` +
          ` (тред ${fix.threadId ?? "—"})`,
        deps,
      );
      return {
        ...base,
        mergeStatus: "fix-delegated",
        fixDelegationId: fix.delegationId,
        fixThreadId: fix.threadId,
      };
    } catch (e) {
      const msg = message(e);
      store.addSetupError(row.id, "merge-autofix", msg);
      await notifyCoordinator(
        row,
        `${row.task_key}: вливание захода ${row.round} в ${into} — конфликт;` +
          ` автозаход разбора не раздался: ${msg.slice(0, 200)}`,
        deps,
      );
      return {
        ...base,
        mergeStatus: "conflict",
        warning: `autofix delegate failed: ${msg}`,
      };
    }
  } finally {
    releaseLock();
  }
}

/**
 * §14: the coordinator copy must come back to `branch` at `head` with a
 * clean `git status` after any failed merge. `head = null` skips the
 * tip check — §16.6 release: when the copy already sat on the published
 * branch, its tip legitimately advanced (the sync merge is real work),
 * so only the branch and a clean status are verified. Returns a
 * description of what is still wrong, or null when the copy is restored.
 */
export async function restoreCopy(
  git: Git,
  branch: string,
  head: string | null,
): Promise<string | null> {
  const merging = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (merging.exitCode === 0) {
    const abort = await git(["merge", "--abort"]);
    if (abort.exitCode !== 0) {
      return (
        `git merge --abort: ` +
        `${(abort.stderr || abort.stdout).trim() || "no output"}`
      );
    }
  }
  const onBranch = await git(["symbolic-ref", "HEAD"]);
  const onName =
    onBranch.exitCode === 0
      ? onBranch.stdout.trim().replace(/^refs\/heads\//, "")
      : "";
  if (onName !== branch) {
    const sw = await git(["switch", branch]);
    if (sw.exitCode !== 0) {
      return (
        `git switch ${branch}: ` +
        `${(sw.stderr || sw.stdout).trim() || "no output"}`
      );
    }
  }
  const status = await git(["status", "--porcelain"]);
  if (status.exitCode !== 0) {
    return (
      `git status: ` +
      `${(status.stderr || status.stdout).trim() || "no output"}`
    );
  }
  if (status.stdout.trim()) {
    const lines = status.stdout.trim().split("\n").slice(0, 5).join("; ");
    return `копия грязная: ${lines}`;
  }
  if (head !== null) {
    const tip = await git(["rev-parse", "HEAD"]);
    if (tip.exitCode !== 0 || tip.stdout.trim() !== head) {
      return `HEAD ${tip.stdout.trim() || "?"} ≠ ${sha7(head)}`;
    }
  }
  return null;
}

/** Conflicted (unmerged) paths of an in-progress merge; empty on error. */
async function unmergedFiles(git: Git): Promise<string[]> {
  const r = await git(["diff", "--name-only", "--diff-filter=U"]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** §14 check 2: git-dir markers of an unfinished operation (`copy-busy`). */
export const COPY_BUSY_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
] as const;

interface LockInfo {
  pid: number;
  branch: string | null;
  head: string | null;
}

/** `pid\ntime\nbranch\nhead` — branch/head are empty until recorded. */
function parseLock(content: string): LockInfo | null {
  const [pidText, , branch, head] = content.split("\n");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, branch: branch || null, head: head || null };
}

/**
 * §14: once the copy's original state is known it goes into our lock —
 * a stale-lock breaker restores the copy to it before removing the lock.
 */
export function recordLockState(
  lockPath: string,
  branch: string,
  head: string | null,
): void {
  try {
    writeFileSync(
      lockPath,
      `${process.pid}\n${new Date().toISOString()}\n${branch}\n${head ?? ""}\n`,
    );
  } catch {
    /* the lock exists; recording state is best-effort */
  }
}

/**
 * §14 check 4: one merge per coordinator copy — a lock file in the
 * copy's own git dir (`--absolute-git-dir` is per-worktree), so the
 * guard holds across processes, not just in plugin memory. A lock whose
 * owner pid is dead is stale: the breaker first restores the copy to
 * the branch/HEAD the owner recorded, then steals the file with an
 * atomic rename — `renameSync` succeeds for exactly one process. The
 * stolen content is verified: a file that is not the vetted stale lock
 * belongs to a new owner and is put back.
 */
export async function acquireCopyLock(
  git: Git,
  repo: string,
  lockPath: string,
): Promise<() => void> {
  const inProgress = () =>
    new OrchestratorError(
      "merge-in-progress",
      `a merge is already running in ${repo} (lock ${lockPath})`,
    );
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      writeFileSync(
        lockPath,
        `${process.pid}\n${new Date().toISOString()}\n`,
        { flag: "wx" },
      );
      return () => {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          /* releasing the lock is best-effort */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new OrchestratorError(
          "git-failed",
          `cannot create merge lock ${lockPath}: ${message(e)}`,
        );
      }
    }
    let content: string;
    try {
      content = readFileSync(lockPath, "utf8");
    } catch {
      continue; // vanished between create and read — retry
    }
    const info = parseLock(content);
    if (!info || pidAlive(info.pid)) {
      throw inProgress();
    }
    // §14: a dead owner's lock breaks only after the copy is restored
    // to the recorded state (a crash may have left it mid-merge or on
    // the target branch). Nothing recorded → the owner died before
    // touching the copy — nothing to restore. A recorded branch with an
    // empty head means the tip was allowed to move (§16.6 release on the
    // published branch): restore branch+clean only, or the stale lock
    // would wedge the copy on a HEAD it can never return to (PLUG-191).
    if (info.branch) {
      const restoreError = await restoreCopy(git, info.branch, info.head);
      if (restoreError) {
        throw new OrchestratorError(
          "copy-not-restored",
          `старая блокировка ${lockPath}: копия не возвращена к ` +
            `${info.branch}${info.head ? `@${sha7(info.head)}` : ""}: ${restoreError}`,
          `копия ${repo} — разберите вручную, там могло остаться незавершённое слияние`,
        );
      }
    }
    const stolen = `${lockPath}.stolen-${process.pid}-${attempt}`;
    try {
      renameSync(lockPath, stolen);
    } catch {
      continue; // another breaker won or the owner released — retry
    }
    let stolenContent: string | null = null;
    try {
      stolenContent = readFileSync(stolen, "utf8");
    } catch {
      /* unreadable — treated as not ours */
    }
    if (stolenContent !== content) {
      try {
        renameSync(stolen, lockPath);
      } catch {
        /* a third party already claimed the path — leave it */
      }
      throw inProgress();
    }
    rmSync(stolen, { force: true });
  }
  throw inProgress();
}

/**
 * §14: the executor copy is confirmed deleted — `bb environment show`
 * answers `HTTP 404 environment_not_found`, a removed thread `thread not
 * found`. A gone copy's result can no longer change, so the §16.2 check
 * is skipped. Any other lookup error is `stale-check-failed`.
 */
export function isEnvironmentGone(e: unknown): boolean {
  return /environment_not_found|thread not found|HTTP 404/i.test(
    message(e),
  );
}

/**
 * §16.2: compare the recorded `result_sha` to the executor copy's HEAD.
 * The env comes from `result_env_id`, else the executor thread's
 * environment. A copy confirmed gone (no env record, no path, 404) skips
 * the check; a copy that cannot be read refuses `stale-check-failed`.
 */
async function checkStaleResult(
  row: DelegationRow,
  resultSha: string,
  deps: MergeDeps,
): Promise<void> {
  const lookup = row.result_env_id
    ? () => deps.environmentById?.(row.result_env_id as string)
    : row.thread_id
      ? () => deps.environment(row.thread_id as string)
      : null;
  if (!lookup) return;
  let env: { path?: string | null } | null;
  try {
    env = (await lookup()) ?? null;
  } catch (e) {
    if (isEnvironmentGone(e)) return;
    throw new OrchestratorError(
      "stale-check-failed",
      `не удалось прочитать копию исполнителя: ${message(e)}`,
    );
  }
  if (!env?.path) return;
  const head = await deps.git(env.path, ["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) {
    throw new OrchestratorError(
      "stale-check-failed",
      `не удалось прочитать HEAD копии исполнителя ${env.path}: ` +
        `${(head.stderr || head.stdout).trim() || "no output"}`,
    );
  }
  if (head.stdout.trim() !== resultSha) {
    throw new OrchestratorError(
      "stale-result",
      `итог захода устарел: HEAD копии исполнителя ${head.stdout.trim().slice(0, 7)} ≠ записанного ${sha7(resultSha)}`,
      "исполнитель продолжил работу после done — дождитесь done нового захода или проверьте копию",
    );
  }
}

/** `[orchestrator] …` to the delegation's coordinator (§5.4 transport). */
async function notifyCoordinator(
  row: DelegationRow,
  text: string,
  deps: MergeDeps,
): Promise<void> {
  try {
    await deps.threads.send({
      threadId: row.coordinator_thread_id,
      mode: "queue-if-active",
      input: [{ type: "text", text: `[orchestrator] ${text}`, mentions: [] }],
    });
  } catch (e) {
    deps.log?.warn?.(
      `orchestrator: notify ${row.coordinator_thread_id}: ${message(e)}`,
    );
  }
}

async function comment(
  row: DelegationRow,
  text: string,
  deps: MergeDeps,
): Promise<void> {
  try {
    await runChecked(deps.bbCli, [
      "tasks",
      "comment",
      row.task_key,
      "--body",
      text,
    ]);
  } catch (e) {
    deps.log?.warn?.(
      `orchestrator: comment on ${row.task_key}: ${message(e)}`,
    );
  }
}
