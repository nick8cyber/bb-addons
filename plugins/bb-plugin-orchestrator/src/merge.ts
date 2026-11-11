/**
 * `merge` — §14 (+ §16.2/§16.6): merge a finished round's result into the
 * coordinator's worktree. Only the delegation's own coordinator may call it;
 * the target copy is that thread's environment. Refusals carry codes:
 * `dirty-result`, `protected-branch`, `stale-result`, `not-done`,
 * `no-result`, `no-environment`, `dirty-coordinator`, `detached-head`,
 * `unknown-branch`, `result-missing`, `merge-in-progress`.
 *
 * Order: row checks → coordinator environment → copy lock → clean copy +
 * on-branch → target branch (`--into` or current, not protected) →
 * §16.2 stale check (result_sha vs the executor copy's HEAD) →
 * `git cat-file -e` → `git merge --no-ff --no-edit -m "merge <KEY> r<N>
 * (<sha7>)" <result_sha>` under the repo's configured identity (never
 * `--author`/`-c user.*`/`--no-verify`). A conflict aborts back to a clean
 * copy (`merge_status = conflict`), tells the coordinator one line, and —
 * when the `mergeAutofix` setting is on and `--no-autofix` was not given —
 * delegates a fix round (same task and level, `--from result_sha`) and
 * records `fix-delegated`. `--dry-run` runs the checks and
 * `git merge-tree --write-tree` only; the copy is not touched.
 *
 * git operations run off the `delegate` queue (§16.8): the per-copy lock
 * is the §14 check-4 guard, the autofix delegation itself goes through
 * `delegate`, which is queued internally.
 */
import { OrchestratorError } from "./errors.js";
import { runChecked, type BbCli } from "./bb-cli.js";
import type { DelegationRow, DelegationStore } from "./store.js";

/**
 * §14 check 3 — protected branches refuse `merge` (code goes out through
 * `release` instead). Default list per spec; TODO(PLUG-174): read the
 * `janitor.protectedBranches` setting once the janitor config lands.
 */
export const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "dev"] as const;

export interface MergeGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
  git(repo: string, args: string[]): Promise<MergeGitResult>;
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
  protectedBranches?: readonly string[];
  /** §16.6 `mergeAutofix` setting — off by default (report only). */
  mergeAutofix?: () => boolean;
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

/** §14 check 4: one merge per coordinator copy at a time, per process. */
const copyLocks = new Set<string>();

export async function runMerge(
  params: MergeParams,
  deps: MergeDeps,
): Promise<MergeOutcome | MergeDryRunOutcome> {
  const { store } = deps;
  const ref = params.ref.trim();

  const row = /^\d+$/.test(ref)
    ? store.get(Number(ref))
    : store.latestDoneResultByTask(ref);
  if (!row) {
    throw new OrchestratorError(
      "not-found",
      `no mergeable delegation for "${params.ref}"`,
      "`bb orchestrator status` lists delegations; a task key resolves to its latest done delegation with a result",
    );
  }
  if (params.callerThreadId !== row.coordinator_thread_id) {
    throw new OrchestratorError(
      "not-a-coordinator",
      `thread ${params.callerThreadId} is not the coordinator of delegation ${row.id}`,
      "only the delegating coordinator may merge its result",
    );
  }

  // §14 check 1: the round finished with a usable, committed result.
  if (row.status !== "done") {
    throw new OrchestratorError(
      "not-done",
      `delegation ${row.id} is ${row.status}, not done`,
      "merge works on finished rounds — see `bb orchestrator status`",
    );
  }
  const resultSha = row.result_sha;
  if (!resultSha) {
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
  const git = (args: string[]) => deps.git(repo, args);
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

  if (copyLocks.has(repo)) {
    throw new OrchestratorError(
      "merge-in-progress",
      `a merge is already running in ${repo}`,
    );
  }
  copyLocks.add(repo);
  try {
    // §14 check 2: the coordinator copy is clean and sits on a branch.
    const porcelain = await gitText(["status", "--porcelain"]);
    if (porcelain.trim()) {
      throw new OrchestratorError(
        "dirty-coordinator",
        "копия координатора грязная (незакоммиченные правки)",
        "закоммить или уберите изменения и повторите",
      );
    }
    let currentBranch: string;
    try {
      currentBranch = (
        await gitText(["symbolic-ref", "--short", "HEAD"])
      ).trim();
    } catch {
      throw new OrchestratorError(
        "detached-head",
        "копия координатора на отсоединённом HEAD — ветки нет",
        "перейдите на ветку (git switch <branch>) и повторите",
      );
    }

    // §14 check 3: the merge target is `--into` or the current branch, and
    // never a protected branch — those are `release` territory.
    const into = (params.into ?? "").trim() || currentBranch;
    const protectedBranches =
      deps.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
    if (protectedBranches.includes(into)) {
      throw new OrchestratorError(
        "protected-branch",
        `вливание в защищённую ветку ${into} запрещено`,
        "в защищённые ветки код уходит только через `bb orchestrator release`",
      );
    }
    if (into !== currentBranch) {
      const verify = await git([
        "rev-parse",
        "--verify",
        "--quiet",
        `${into}^{commit}`,
      ]);
      if (verify.exitCode !== 0) {
        throw new OrchestratorError(
          "unknown-branch",
          `ветка-приёмник ${into} не существует`,
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
    if (params.dryRun) {
      const probe = await git([
        "merge-tree",
        "--write-tree",
        "--name-only",
        into,
        resultSha,
      ]);
      const lines = probe.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      return {
        ok: true,
        dryRun: true,
        delegationId: row.id,
        taskKey: row.task_key,
        round: row.round,
        into,
        wouldConflict: probe.exitCode !== 0,
        conflictFiles: probe.exitCode !== 0 ? lines.slice(1) : [],
      };
    }

    // Move the clean copy onto the target branch — only now, so refused
    // calls leave the copy untouched.
    if (into !== currentBranch) {
      await gitText(["checkout", into]);
    }
    const targetTip = (await gitText(["rev-parse", "HEAD"])).trim();
    const mergeRes = await git([
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      `merge ${row.task_key} r${row.round} (${sha7(resultSha)})`,
      resultSha,
    ]);

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

    // Failure: a merge in progress means conflicts; anything else is a
    // git error — record `failed` and surface it.
    const mergeHead = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (mergeHead.exitCode !== 0) {
      store.setMergeStatus(row.id, "failed");
      throw new OrchestratorError(
        "git-failed",
        `git merge failed (exit ${mergeRes.exitCode}): ${
          (mergeRes.stderr || mergeRes.stdout).trim() || "no output"
        }`,
      );
    }
    const conflictFiles = (
      await gitText(["diff", "--name-only", "--diff-filter=U"]).catch(
        () => "",
      )
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    await git(["merge", "--abort"]);
    const stillMerging = await git([
      "rev-parse",
      "-q",
      "--verify",
      "MERGE_HEAD",
    ]);
    if (stillMerging.exitCode === 0) {
      store.setMergeStatus(row.id, "failed");
      throw new OrchestratorError(
        "git-failed",
        "git merge --abort did not return the copy to a clean state",
        `копия ${repo} посреди слияния — разберите вручную`,
      );
    }

    store.setMergeStatus(row.id, "conflict");
    const base = {
      ok: true as const,
      delegationId: row.id,
      taskKey: row.task_key,
      round: row.round,
      into,
      conflictFiles,
    };

    // §16.6: autofix needs the `mergeAutofix` setting AND no --no-autofix.
    const autofix = (deps.mergeAutofix?.() ?? false) && !params.noAutofix;
    if (!autofix) {
      await notifyCoordinator(
        row,
        `${row.task_key}: вливание захода ${row.round} в ${into} — конфликт` +
          `${conflictFiles.length ? ` (${conflictFiles.slice(0, 10).join(", ")})` : ""}. ` +
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
    copyLocks.delete(repo);
  }
}

/**
 * §16.2: compare the recorded `result_sha` to the executor copy's HEAD.
 * The env comes from `result_env_id`, else the executor thread's
 * environment. An unreadable or gone copy cannot be written to either —
 * the check is skipped, not failed.
 */
async function checkStaleResult(
  row: DelegationRow,
  resultSha: string,
  deps: MergeDeps,
): Promise<void> {
  try {
    const env = row.result_env_id
      ? await deps.environmentById?.(row.result_env_id)
      : row.thread_id
        ? await deps.environment(row.thread_id)
        : null;
    if (!env?.path) return;
    const head = await deps.git(env.path, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0) return;
    if (head.stdout.trim() !== resultSha) {
      throw new OrchestratorError(
        "stale-result",
        `итог захода устарел: HEAD копии исполнителя ${head.stdout.trim().slice(0, 7)} ≠ записанного ${sha7(resultSha)}`,
        "исполнитель продолжил работу после done — дождитесь done нового захода или проверьте копию",
      );
    }
  } catch (e) {
    if (e instanceof OrchestratorError) throw e;
    deps.log?.warn?.(`orchestrator: stale-result check skipped: ${message(e)}`);
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
