/**
 * Orchestrator r34 task work graph (§27, §28, §32 and ADR-0032).
 * Slice 5a: task_queue, task_transitions, CAS transitions, workGraph modes,
 * queue CLI commands (enqueue, dequeue, defer, reject, resume, approve,
 * release-note, run-queue) and owner-only guards.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { OrchestratorError } from "./errors.js";
import type { CmdRunner } from "./cmd.js";
import type { BbCli } from "./bb-cli.js";
import type {
  ConfirmationMode,
  DelegationStore,
  TaskLevel,
  TaskNode,
  TaskQueueRow,
  TaskRoute,
  TaskStatus,
  TaskTransitionRow,
} from "./store.js";
import { normalizeTaskKey } from "./store.js";
import type { PluginCliContext } from "@get-bb/plugin-sdk";
import type { T } from "./i18n/index.js";

export type WorkGraphMode = "off" | "shadow" | "strict";

/** Validates and normalizes workGraph mode setting. */
export function normalizeWorkGraphMode(mode: string | undefined): WorkGraphMode {
  const m = (mode ?? "off").toLowerCase().trim();
  if (m === "shadow" || m === "strict") return m;
  return "off";
}

/** §27.1: Computes deterministic branch name `bb/<KEY>-<slug>`. */
export function computeTaskBranch(
  taskKey: string,
  route: TaskRoute,
  title?: string,
): string | null {
  if (route === "research") return null;
  const keyLower = normalizeTaskKey(taskKey).toLowerCase();
  let slug = "";
  if (title) {
    slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug.length > 30) {
      slug = slug.slice(0, 30).replace(/-+$/, "");
    }
  }
  if (!slug) {
    slug = route;
  }
  return `bb/${keyLower}-${slug}`;
}

/** §29.3: Check if the caller is an owner (human), not an agent thread. */
export function isOwnerCalling(
  ctx?: PluginCliContext | { threadId?: string },
): boolean {
  if (ctx?.threadId && ctx.threadId.trim().length > 0) return false;
  if (process.env.BB_THREAD_ID && process.env.BB_THREAD_ID.trim().length > 0) {
    return false;
  }
  return true;
}

/** §29.3: Enforce owner-only execution. */
export function assertOwnerOnly(
  ctx?: PluginCliContext | { threadId?: string },
  message = "owner-only",
): void {
  if (!isOwnerCalling(ctx)) {
    throw new OrchestratorError("permission-denied", message);
  }
}

/** §32 п.1: In strict mode, blocks direct delegate, merge, release. */
export function assertGraphAllowsDirectAction(
  store: DelegationStore,
  taskKey: string,
  mode: WorkGraphMode,
): void {
  if (mode !== "strict") return;
  const key = normalizeTaskKey(taskKey);
  const task = store.getTask(key);
  if (!task) {
    throw new OrchestratorError(
      "graph-required",
      `задача ${key} не зарегистрирована в очереди графа; поставь задачу через bb orchestrator enqueue ${key}`,
    );
  }
  if (task.status === "done") {
    throw new OrchestratorError(
      "graph-managed",
      `задача ${key} завершена (done); для повторной доработки выполни bb orchestrator enqueue ${key}`,
    );
  }
  throw new OrchestratorError(
    "graph-managed",
    `задача ${key} управляется графом (текущее состояние: node=${task.node}, status=${task.status}). Прямой вызов запрещён; продвижение выполняется конвейером run-queue`,
  );
}

/** §32 п.2: Checks branch clean / merged state, or archives on force reset. */
export async function checkAndPrepareTaskBranch(
  cmd: CmdRunner,
  repoRoot: string,
  branch: string,
  taskKey: string,
  mergeBaseBranch: string,
  forceResetBranch: boolean,
  prNumber?: number,
): Promise<{ ok: boolean; action: string }> {
  const normKey = normalizeTaskKey(taskKey).toUpperCase();
  const localRes = await cmd.run(
    "git",
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    { cwd: repoRoot },
  );
  const localExists = localRes.exitCode === 0;
  const localSha = localExists ? localRes.stdout.trim() : null;

  const lsRemote = await cmd.run(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd: repoRoot },
  );
  if (lsRemote.exitCode !== 0) {
    throw new OrchestratorError(
      "git-failed",
      `не удалось проверить удалённую ветку origin/${branch}: ${lsRemote.stderr}`,
    );
  }
  const remoteExists = lsRemote.stdout.trim().length > 0;
  let remoteSha: string | null = null;

  if (!localExists && !remoteExists) {
    return { ok: true, action: "clean" };
  }

  if (remoteExists) {
    const fetchRes = await cmd.run(
      "git",
      ["fetch", "origin", `refs/heads/${branch}`],
      { cwd: repoRoot },
    );
    if (fetchRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `не удалось выполнить fetch для ветки origin/${branch}: ${fetchRes.stderr}`,
      );
    }
    const revRemote = await cmd.run(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
      { cwd: repoRoot },
    );
    if (revRemote.exitCode === 0 && revRemote.stdout.trim()) {
      remoteSha = revRemote.stdout.trim();
    } else {
      remoteSha = lsRemote.stdout.trim().split(/\s+/)[0] ?? null;
    }
    if (!remoteSha) {
      throw new OrchestratorError(
        "git-failed",
        `не удалось определить sha удалённой ветки origin/${branch}`,
      );
    }
  }

  // Check if tips are ancestors of origin/<mergeBaseBranch> or confirmed via PR (§32 п.2)
  const targetRef = `origin/${mergeBaseBranch}`;
  const targetCheck = await cmd.run(
    "git",
    ["rev-parse", "--verify", targetRef],
    { cwd: repoRoot },
  );
  if (targetCheck.exitCode !== 0) {
    throw new OrchestratorError(
      "git-failed",
      `базовая ветка ${targetRef} не найдена в репозитории`,
    );
  }

  const isShaMerged = async (sha: string): Promise<boolean> => {
    // Condition a: sha is an ancestor of origin/<mergeBaseBranch>
    const anc = await cmd.run(
      "git",
      ["merge-base", "--is-ancestor", sha, targetRef],
      { cwd: repoRoot },
    );
    if (anc.exitCode === 0) {
      return true;
    }

    // Condition b: found PR for this branch (by prNumber or head branch) with state === MERGED (§32 п.2)
    let prData: { state?: string; mergedAt?: string | null; headRefOid?: string } | null = null;
    if (prNumber) {
      const prRes = await cmd.run(
        "gh",
        ["pr", "view", String(prNumber), "--json", "state,mergedAt,headRefOid"],
        { cwd: repoRoot },
      );
      if (prRes.exitCode === 0) {
        try {
          prData = JSON.parse(prRes.stdout);
        } catch {}
      }
    }
    if (!prData) {
      const listRes = await cmd.run(
        "gh",
        [
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "all",
          "--limit",
          "1",
          "--json",
          "state,mergedAt,headRefOid",
        ],
        { cwd: repoRoot },
      );
      if (listRes.exitCode === 0) {
        try {
          const arr = JSON.parse(listRes.stdout);
          if (Array.isArray(arr) && arr.length > 0) {
            prData = arr[0];
          }
        } catch {}
      }
    }

    if (
      prData &&
      (prData.state?.toUpperCase() === "MERGED" || Boolean(prData.mergedAt))
    ) {
      const headOid = prData.headRefOid;
      if (headOid) {
        if (sha === headOid) return true;
        const prAnc = await cmd.run(
          "git",
          ["merge-base", "--is-ancestor", sha, headOid],
          { cwd: repoRoot },
        );
        if (prAnc.exitCode === 0) return true;
      }
    }

    return false;
  };

  let localMerged = true;
  if (localExists && localSha) {
    localMerged = await isShaMerged(localSha);
  }

  let remoteMerged = true;
  if (remoteExists && remoteSha) {
    remoteMerged = await isShaMerged(remoteSha);
  }

  if (localMerged && remoteMerged) {
    if (localExists) {
      const del = await cmd.run("git", ["branch", "-D", branch], { cwd: repoRoot });
      if (del.exitCode !== 0) {
        throw new OrchestratorError(
          "git-failed",
          `не удалось удалить локальную ветку ${branch}: ${del.stderr}`,
        );
      }
    }
    if (remoteExists) {
      const delRemote = await cmd.run(
        "git",
        ["push", "origin", "--delete", branch],
        { cwd: repoRoot },
      );
      if (delRemote.exitCode !== 0) {
        throw new OrchestratorError(
          "git-failed",
          `не удалось удалить ветку в origin: ${delRemote.stderr}`,
        );
      }
    }
    return { ok: true, action: "deleted-merged" };
  }

  if (!forceResetBranch) {
    throw new OrchestratorError(
      "unmerged-branch-exists",
      `прошлая ветка задачи ${branch} не влита в целевую ветку; укажи флаг --force-reset-branch для принудительного архивирования и пересоздания`,
    );
  }

  const ts = Date.now();
  if (localExists && localSha) {
    const tagRes = await cmd.run(
      "git",
      ["tag", `archive/${normKey}-force-reset-${ts}`, localSha],
      { cwd: repoRoot },
    );
    if (tagRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `не удалось создать архивный тег для ветки ${branch}: ${tagRes.stderr}`,
      );
    }
    const delRes = await cmd.run("git", ["branch", "-D", branch], { cwd: repoRoot });
    if (delRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `не удалось удалить локальную ветку ${branch}: ${delRes.stderr}`,
      );
    }
  }

  if (remoteExists && remoteSha) {
    const remoteDiffers =
      !localSha ||
      (
        await cmd.run(
          "git",
          ["merge-base", "--is-ancestor", remoteSha, localSha],
          { cwd: repoRoot },
        )
      ).exitCode !== 0;

    if (remoteDiffers) {
      const remTag = await cmd.run(
        "git",
        [
          "tag",
          `archive/${normKey}-remote-force-reset-${ts}`,
          remoteSha,
        ],
        { cwd: repoRoot },
      );
      if (remTag.exitCode !== 0) {
        throw new OrchestratorError(
          "git-failed",
          `не удалось создать архивный тег для удалённой ветки ${branch}: ${remTag.stderr}`,
        );
      }
    }
    const pushDel = await cmd.run(
      "git",
      ["push", "origin", "--delete", branch],
      { cwd: repoRoot },
    );
    if (pushDel.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `не удалось удалить удалённую ветку ${branch}: ${pushDel.stderr}`,
      );
    }
  }

  return { ok: true, action: "force-reset-archived" };
}

/** §28.1: Archives branch to tag and deletes it for dequeue. */
export async function archiveAndCleanupTaskBranch(
  cmd: CmdRunner,
  repoRoot: string,
  branch: string | null,
  taskKey: string,
): Promise<void> {
  if (!branch) return;
  const normKey = normalizeTaskKey(taskKey).toUpperCase();
  const ts = Date.now();

  const localRes = await cmd.run(
    "git",
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    { cwd: repoRoot },
  );
  if (localRes.exitCode === 0) {
    const localSha = localRes.stdout.trim();
    const tagRes = await cmd.run(
      "git",
      ["tag", `archive/${normKey}-cancelled-${ts}`, localSha],
      { cwd: repoRoot },
    );
    if (tagRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `не удалось создать архивный тег для ветки ${branch}: ${tagRes.stderr}`,
      );
    }
    const delRes = await cmd.run("git", ["branch", "-D", branch], { cwd: repoRoot });
    if (delRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `не удалось удалить локальную ветку ${branch}: ${delRes.stderr}`,
      );
    }
  }

  const lsRemote = await cmd.run(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd: repoRoot },
  );
  if (lsRemote.exitCode !== 0) {
    throw new OrchestratorError(
      "git-failed",
      `не удалось проверить удалённую ветку origin/${branch}: ${lsRemote.stderr}`,
    );
  }
  if (lsRemote.stdout.trim().length > 0) {
    const fetchRes = await cmd.run(
      "git",
      ["fetch", "origin", `refs/heads/${branch}`],
      { cwd: repoRoot },
    );
    if (fetchRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `не удалось выполнить fetch для ветки origin/${branch}: ${fetchRes.stderr}`,
      );
    }
    const revRemote = await cmd.run(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
      { cwd: repoRoot },
    );
    const remoteSha =
      (revRemote.exitCode === 0 ? revRemote.stdout.trim() : null) ||
      lsRemote.stdout.trim().split(/\s+/)[0];
    if (remoteSha) {
      const remTag = await cmd.run(
        "git",
        [
          "tag",
          `archive/${normKey}-remote-cancelled-${ts}`,
          remoteSha,
        ],
        { cwd: repoRoot },
      );
      if (remTag.exitCode !== 0) {
        throw new OrchestratorError(
          "git-failed",
          `не удалось создать архивный тег для удалённой ветки ${branch}: ${remTag.stderr}`,
        );
      }
      const pushDel = await cmd.run(
        "git",
        ["push", "origin", "--delete", branch],
        { cwd: repoRoot },
      );
      if (pushDel.exitCode !== 0) {
        throw new OrchestratorError(
          "git-failed",
          `не удалось удалить удалённую ветку ${branch}: ${pushDel.stderr}`,
        );
      }
    }
  }

  await cmd
    .run("git", ["worktree", "remove", "--force", `wt/release/${taskKey}`], {
      cwd: repoRoot,
    })
    .catch(() => {});
  await cmd
    .run("git", ["worktree", "remove", "--force", `wt/sync/${taskKey}`], {
      cwd: repoRoot,
    })
    .catch(() => {});
}

// ── Command Handlers ──────────────────────────────────────────────────

export interface EnqueueCommandInput {
  taskKey: string;
  priority?: number;
  mode?: string;
  route?: string;
  level?: string;
  acceptance?: string;
  releaseNote?: string;
  dependsOn?: string;
  forceResetBranch?: boolean;
}

export async function runEnqueue(
  input: EnqueueCommandInput,
  deps: {
    store: DelegationStore;
    cmd: CmdRunner;
    bbCli?: BbCli;
    ctx: PluginCliContext;
    workGraphMode: WorkGraphMode;
    repoRoot: string;
    mergeBaseBranch: string;
    now?: () => number;
    hasChecksCommands?: boolean;
  },
): Promise<{ ok: boolean; task: TaskQueueRow; reissued?: boolean }> {
  if (deps.workGraphMode === "off") {
    throw new OrchestratorError(
      "graph-disabled",
      "управление графом отключено (настройка workGraph: off); установи orchestrator.workGraph в shadow или strict",
    );
  }

  const isOwner = isOwnerCalling(deps.ctx);
  const now = deps.now ? deps.now() : Date.now();
  const taskKey = normalizeTaskKey(input.taskKey);
  if (!taskKey) {
    throw new OrchestratorError(
      "invalid-arguments",
      "укажи ключ задачи: bb orchestrator enqueue <KEY> ...",
    );
  }

  // §29.2 п.1: flag --mode restricted to owner
  if (!isOwner && input.mode !== undefined) {
    throw new OrchestratorError(
      "permission-denied",
      "owner-only (--mode flag is restricted to owner)",
    );
  }

  // §29.3: --acceptance restricted to owner
  if (!isOwner && input.acceptance !== undefined) {
    throw new OrchestratorError("permission-denied", "owner-only");
  }

  const validRoutes = ["feature", "fix", "docs", "simple", "research"];
  const route = (input.route ?? "feature") as TaskRoute;
  if (!validRoutes.includes(route)) {
    throw new OrchestratorError(
      "invalid-arguments",
      `недопустимый маршрут: ${input.route} (разрешены: ${validRoutes.join(", ")})`,
    );
  }

  // Priority validation
  let priority = 100;
  if (input.priority !== undefined) {
    if (typeof input.priority !== "number" || isNaN(input.priority)) {
      throw new OrchestratorError(
        "invalid-arguments",
        `некорректный приоритет: ${input.priority} (должно быть число)`,
      );
    }
    priority = input.priority;
  }

  // Route & level validation (§27.2)
  let level = input.level as TaskLevel | undefined;
  if (!level) {
    if (route === "docs") level = "spec";
    else if (route === "research") level = "research";
    else level = "complex";
  }

  const validLevels = [
    "complex",
    "medium",
    "simple",
    "spec",
    "research",
    "architect",
  ];
  if (!validLevels.includes(level)) {
    throw new OrchestratorError(
      "invalid-arguments",
      `недопустимый уровень: ${input.level} (разрешены: ${validLevels.join(", ")})`,
    );
  }

  if (["feature", "fix", "simple"].includes(route)) {
    if (level === "spec" || level === "architect" || level === "research") {
      throw new OrchestratorError(
        "invalid-level",
        "узел code требует уровня с инструментами написания кода (роль executor)",
      );
    }
  }

  if (
    route === "docs" &&
    (level === "complex" || level === "architect" || level === "research")
  ) {
    throw new OrchestratorError(
      "invalid-level",
      `маршрут docs не поддерживает уровень ${level}`,
    );
  }

  if (route === "research" && level !== "research") {
    throw new OrchestratorError(
      "invalid-level",
      "маршрут research поддерживает только уровень research",
    );
  }

  // Confirmation mode
  let confirmationMode: ConfirmationMode;
  if (isOwner) {
    if (input.mode === "auto" || input.mode === "manual") {
      confirmationMode = input.mode;
    } else {
      confirmationMode = route === "feature" ? "manual" : "auto";
    }
  } else {
    // Agent calling
    if (["fix", "simple", "docs"].includes(route)) {
      confirmationMode = "manual";
    } else if (route === "feature") {
      confirmationMode = "manual";
    } else {
      confirmationMode = "auto";
    }
  }

  // Acceptance contract reading
  let acceptanceText: string | null = null;
  if (input.acceptance) {
    const raw = input.acceptance.trim();
    const looksLikePath =
      !raw.includes("\n") &&
      (raw.startsWith("./") ||
        raw.startsWith("../") ||
        raw.startsWith("/") ||
        raw.startsWith("~/") ||
        /\.(md|txt|markdown|rst)$/i.test(raw));

    const candidatePath = path.resolve(deps.ctx?.cwd ?? process.cwd(), raw);
    if (existsSync(candidatePath)) {
      try {
        acceptanceText = readFileSync(candidatePath, "utf8");
      } catch (err) {
        throw new OrchestratorError(
          "acceptance-missing",
          `не удалось прочитать файл договора приёмки ${raw}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (looksLikePath) {
      throw new OrchestratorError(
        "acceptance-missing",
        `файл договора приёмки не найден: ${raw}`,
      );
    } else {
      acceptanceText = input.acceptance;
    }
  }

  const existing = deps.store.getTask(taskKey);
  if (existing) {
    if (existing.status !== "done" && existing.status !== "cancelled") {
      // Check exception for owner updating acceptance at owner_gate (§31.5, §32 п.2)
      if (
        (existing.route === "fix" || existing.route === "simple") &&
        existing.node === "owner_gate" &&
        (existing.status === "waiting_approval" || existing.status === "deferred") &&
        acceptanceText
      ) {
        let existingPayload: Record<string, unknown> = {};
        try {
          if (existing.payload) existingPayload = JSON.parse(existing.payload);
        } catch {}
        existingPayload.acceptance_text = acceptanceText;
        delete existingPayload.previous_status;
        const res = deps.store.transitionTask(
          {
            taskKey,
            expectedNode: "owner_gate",
            expectedStatus: existing.status,
            toNode: "owner_gate",
            toStatus: "waiting_approval",
            actor: "owner",
            reason: "update-acceptance",
            updates: {
              payload: JSON.stringify(existingPayload),
              deferred_by: null,
              deferred_reason: null,
            },
            now,
          },
          now,
        );
        if (!res.ok) {
          throw new OrchestratorError(
            "transition-failed",
            "не удалось обновить договор приёмки",
          );
        }
        return { ok: true, task: res.task! };
      }

      if (existing.route === "feature" && input.acceptance !== undefined) {
        throw new OrchestratorError(
          "acceptance-contract-immutable",
          "для маршрута feature договор формируется и изменяется исключительно архитектором на узле design через reject --target design",
        );
      }

      throw new OrchestratorError(
        "task-already-enqueued",
        `задача ${taskKey} уже находится в очереди (текущее состояние: node=${existing.node}, status=${existing.status}); повторная постановка допустима только после завершения (status=done) либо отмены (status=cancelled)`,
      );
    }
  }

  // §31: acceptance-missing check for fix/simple routes on both new and re-enqueued tasks
  if (
    ["fix", "simple"].includes(route) &&
    !acceptanceText &&
    !deps.hasChecksCommands
  ) {
    throw new OrchestratorError(
      "acceptance-missing",
      "укажи --acceptance или настрой checks.commands проекта",
    );
  }

  // Branch calculation & git check
  let branch: string | null = null;
  if (route !== "research") {
    if (existing?.branch) {
      branch = existing.branch;
    } else {
      let taskTitle: string | undefined;
      if (deps.bbCli) {
        try {
          const res = await deps.bbCli.run(["tasks", "show", taskKey, "--json"]);
          if (res.exitCode === 0) {
            const data = JSON.parse(res.stdout);
            taskTitle = data.task?.title ?? data.title;
          }
        } catch {}
      }
      branch = computeTaskBranch(taskKey, route, taskTitle);
    }

    if (branch) {
      let prNumber: number | undefined;
      if (existing?.payload) {
        try {
          const p = JSON.parse(existing.payload);
          if (typeof p.pr_number === "number") prNumber = p.pr_number;
        } catch {}
      }
      await checkAndPrepareTaskBranch(
        deps.cmd,
        deps.repoRoot,
        branch,
        taskKey,
        deps.mergeBaseBranch,
        Boolean(input.forceResetBranch),
        prNumber,
      );
    }
  }

  const dependsOn = input.dependsOn
    ? input.dependsOn.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const payload = acceptanceText ? JSON.stringify({ acceptance_text: acceptanceText }) : null;

  if (existing) {
    // Reissue / reset
    const task = deps.store.resetTaskForEnqueue(
      {
        taskKey,
        route,
        level,
        priority,
        dependsOn,
        confirmationMode,
        branch,
        releaseNote: input.releaseNote ?? null,
        payload,
        actor: isOwner ? "owner" : "coordinator",
      },
      now,
    );
    return { ok: true, task, reissued: true };
  }

  // New task insert
  const task = deps.store.insertTask(
    {
      taskKey,
      projectId: deps.ctx.projectId ?? "default",
      coordinatorThreadId: deps.ctx.threadId ?? "",
      route,
      level,
      priority,
      dependsOn,
      confirmationMode,
      branch,
      releaseNote: input.releaseNote ?? null,
      payload,
      actor: isOwner ? "owner" : "coordinator",
    },
    now,
  );
  return { ok: true, task };
}

export async function runDequeue(
  taskKey: string,
  reason: string | undefined,
  deps: {
    store: DelegationStore;
    cmd: CmdRunner;
    ctx: PluginCliContext;
    workGraphMode: WorkGraphMode;
    repoRoot: string;
    now?: () => number;
  },
): Promise<{ ok: boolean; task: TaskQueueRow }> {
  assertOwnerOnly(deps.ctx);
  if (deps.workGraphMode === "off") {
    throw new OrchestratorError(
      "graph-disabled",
      "управление графом отключено (настройка workGraph: off); установи orchestrator.workGraph в shadow или strict",
    );
  }

  const key = normalizeTaskKey(taskKey);
  const task = deps.store.getTask(key);
  if (!task) {
    throw new OrchestratorError(
      "task-not-found",
      `задача ${key} не найдена в очереди`,
    );
  }
  if (task.status === "done" || task.status === "cancelled") {
    throw new OrchestratorError(
      "invalid-status",
      `задача ${key} уже завершена или отменена (status=${task.status})`,
    );
  }

  await archiveAndCleanupTaskBranch(deps.cmd, deps.repoRoot, task.branch, key);

  let payloadObj: Record<string, unknown> = {};
  try {
    if (task.payload) payloadObj = JSON.parse(task.payload);
  } catch {}
  payloadObj.cancelled_reason = reason ?? "dequeue";

  const now = deps.now ? deps.now() : Date.now();
  const res = deps.store.transitionTask(
    {
      taskKey: key,
      expectedNode: task.node,
      expectedStatus: task.status,
      toNode: task.node,
      toStatus: "cancelled",
      actor: "owner",
      reason: reason ?? "dequeue",
      now,
      updates: { payload: JSON.stringify(payloadObj) },
    },
    now,
  );
  if (!res.ok) {
    throw new OrchestratorError(
      "transition-failed",
      `не удалось отменить задачу ${key}: конфликт CAS`,
    );
  }

  return { ok: true, task: res.task! };
}

export async function runDefer(
  taskKey: string,
  reason: string | undefined,
  deps: {
    store: DelegationStore;
    ctx: PluginCliContext;
    workGraphMode: WorkGraphMode;
    now?: () => number;
  },
): Promise<{ ok: boolean; task: TaskQueueRow }> {
  assertOwnerOnly(deps.ctx);
  if (deps.workGraphMode === "off") {
    throw new OrchestratorError(
      "graph-disabled",
      "управление графом отключено (настройка workGraph: off); установи orchestrator.workGraph в shadow или strict",
    );
  }
  if (!reason || reason.trim().length === 0) {
    throw new OrchestratorError(
      "invalid-arguments",
      "укажи причину: bb orchestrator defer <KEY> --reason <причина>",
    );
  }

  const key = normalizeTaskKey(taskKey);
  const task = deps.store.getTask(key);
  if (!task) {
    throw new OrchestratorError(
      "task-not-found",
      `задача ${key} не найдена в очереди`,
    );
  }
  if (task.status === "done" || task.status === "cancelled") {
    throw new OrchestratorError(
      "invalid-status",
      `задача ${key} уже завершена или отменена (status=${task.status})`,
    );
  }
  if (task.status === "deferred") {
    throw new OrchestratorError(
      "invalid-status",
      `задача ${key} уже отложена (status=deferred)`,
    );
  }

  const now = deps.now ? deps.now() : Date.now();
  let existingPayload: Record<string, unknown> = {};
  try {
    if (task.payload) existingPayload = JSON.parse(task.payload);
  } catch {}
  existingPayload.previous_status = task.status;

  const res = deps.store.transitionTask(
    {
      taskKey: key,
      expectedNode: task.node,
      expectedStatus: task.status,
      toNode: task.node,
      toStatus: "deferred",
      actor: "owner",
      reason,
      now,
      updates: {
        deferred_by: "owner",
        deferred_reason: reason,
        payload: JSON.stringify(existingPayload),
      },
    },
    now,
  );
  if (!res.ok) {
    throw new OrchestratorError(
      "transition-failed",
      `не удалось отложить задачу ${key}: конфликт CAS`,
    );
  }

  return { ok: true, task: res.task! };
}

export async function runReject(
  taskKey: string,
  target: string | undefined,
  reason: string | undefined,
  deps: {
    store: DelegationStore;
    ctx: PluginCliContext;
    workGraphMode: WorkGraphMode;
    now?: () => number;
  },
): Promise<{ ok: boolean; task: TaskQueueRow }> {
  if (deps.workGraphMode === "off") {
    throw new OrchestratorError(
      "graph-disabled",
      "управление графом отключено (настройка workGraph: off); установи orchestrator.workGraph в shadow или strict",
    );
  }
  if (!reason || reason.trim().length === 0) {
    throw new OrchestratorError(
      "missing-reason",
      "укажи причину отклонения: bb orchestrator reject <KEY> --reason <причина>",
    );
  }

  const key = normalizeTaskKey(taskKey);
  const task = deps.store.getTask(key);
  if (!task) {
    throw new OrchestratorError(
      "task-not-found",
      `задача ${key} не найдена в очереди`,
    );
  }

  if (task.status === "blocked" || task.status === "deferred") {
    throw new OrchestratorError(
      "invalid-status",
      "при статусе blocked или deferred вызов reject строго запрещён: вывод из blocked разрешён исключительно владельцу через команду resume",
    );
  }

  const now = deps.now ? deps.now() : Date.now();
  const isOwner = isOwnerCalling(deps.ctx);

  if (task.node === "owner_gate") {
    assertOwnerOnly(deps.ctx);
    if (task.route === "feature") {
      const tgt = (target ?? "spec") as TaskNode;
      if (tgt !== "spec" && tgt !== "design") {
        throw new OrchestratorError(
          "target-invalid",
          `недопустимая цель ${target} для маршрута feature (разрешены: spec, design)`,
        );
      }
      const res = deps.store.transitionTask(
        {
          taskKey: key,
          expectedNode: "owner_gate",
          expectedStatus: task.status,
          toNode: tgt,
          toStatus: "running",
          actor: "owner",
          reason: reason ?? "rejected",
          now,
        },
        now,
      );
      if (!res.ok) {
        throw new OrchestratorError(
          "transition-failed",
          `не удалось отклонить задачу ${key}: конфликт CAS`,
        );
      }
      return { ok: true, task: res.task! };
    }

    if (task.route === "docs") {
      const tgt = (target ?? "spec") as TaskNode;
      if (tgt !== "spec") {
        throw new OrchestratorError(
          "target-invalid",
          `недопустимая цель ${target} для маршрута docs (разрешено только: spec)`,
        );
      }
      const res = deps.store.transitionTask(
        {
          taskKey: key,
          expectedNode: "owner_gate",
          expectedStatus: task.status,
          toNode: "spec",
          toStatus: "running",
          actor: "owner",
          reason: reason ?? "rejected",
          now,
        },
        now,
      );
      if (!res.ok) {
        throw new OrchestratorError(
          "transition-failed",
          `не удалось отклонить задачу ${key}: конфликт CAS`,
        );
      }
      return { ok: true, task: res.task! };
    }

    if (task.route === "fix" || task.route === "simple") {
      if (target !== undefined) {
        throw new OrchestratorError(
          "target-invalid",
          "для маршрутов fix и simple цель --target не поддерживается",
        );
      }
      let rejectPayload: Record<string, unknown> = {};
      try {
        if (task.payload) rejectPayload = JSON.parse(task.payload);
      } catch {}
      delete rejectPayload.previous_status;

      const res = deps.store.transitionTask(
        {
          taskKey: key,
          expectedNode: "owner_gate",
          expectedStatus: task.status,
          toNode: "owner_gate",
          toStatus: "deferred",
          actor: "owner",
          reason: reason ?? "rejected",
          now,
          updates: {
            deferred_by: "owner",
            deferred_reason: reason ?? "rejected at owner_gate",
            payload: JSON.stringify(rejectPayload),
          },
        },
        now,
      );
      if (!res.ok) {
        throw new OrchestratorError(
          "transition-failed",
          `не удалось отклонить задачу ${key}: конфликт CAS`,
        );
      }
      return { ok: true, task: res.task! };
    }
  }

  if (task.node === "code") {
    if (task.status !== "running" && task.status !== "stalled") {
      throw new OrchestratorError(
        "invalid-status",
        `возврат узла code возможен только в статусе running или stalled (current: ${task.status})`,
      );
    }
    if (target && target !== "code") {
      throw new OrchestratorError(
        "target-invalid",
        `недопустимая цель ${target} для узла code`,
      );
    }
    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: "code",
        expectedStatus: task.status,
        toNode: "code",
        toStatus: "running",
        actor: isOwner ? "owner" : "coordinator",
        reason: reason ?? "rejected",
        now,
      },
      now,
    );
    if (!res.ok) {
      throw new OrchestratorError(
        "transition-failed",
        `не удалось отклонить задачу ${key}: конфликт CAS`,
      );
    }
    return { ok: true, task: res.task! };
  }

  throw new OrchestratorError(
    "invalid-status",
    `команда reject недопустима для узла ${task.node} в статусе ${task.status}`,
  );
}

export async function runResume(
  taskKey: string,
  target: string | undefined,
  deps: {
    store: DelegationStore;
    ctx: PluginCliContext;
    workGraphMode: WorkGraphMode;
    now?: () => number;
    reopen?: boolean;
    cmd?: CmdRunner;
    repoRoot?: string;
  },
): Promise<{ ok: boolean; task: TaskQueueRow }> {
  if (deps.workGraphMode === "off") {
    throw new OrchestratorError(
      "graph-disabled",
      "управление графом отключено (настройка workGraph: off); установи orchestrator.workGraph в shadow или strict",
    );
  }

  const key = normalizeTaskKey(taskKey);
  const task = deps.store.getTask(key);
  if (!task) {
    throw new OrchestratorError(
      "task-not-found",
      `задача ${key} не найдена в очереди`,
    );
  }

  const now = deps.now ? deps.now() : Date.now();
  const isOwner = isOwnerCalling(deps.ctx);

  if (task.status === "stalled") {
    if (deps.reopen && deps.cmd && deps.repoRoot) {
      let prNum: number | undefined;
      if (task.payload) {
        try {
          const p = JSON.parse(task.payload);
          if (typeof p.pr_number === "number") prNum = p.pr_number;
        } catch {}
      }
      if (prNum) {
        await deps.cmd
          .run("gh", ["pr", "reopen", String(prNum)], { cwd: deps.repoRoot })
          .catch(() => {});
      }
    }

    if (target !== undefined) {
      assertOwnerOnly(deps.ctx);
      if (task.node === "release") {
        if (["feature", "fix", "simple"].includes(task.route)) {
          if (target !== "code") {
            throw new OrchestratorError(
              "target-invalid",
              `недопустимая цель ${target} для возобновления из release/stalled`,
            );
          }
          const res = deps.store.transitionTask(
            {
              taskKey: key,
              expectedNode: "release",
              expectedStatus: "stalled",
              toNode: "code",
              toStatus: "running",
              actor: "owner",
              reason: "resume-to-code",
              now,
              updates: {
                code_attempts: 0,
                check_attempts: 0,
                code_review_rounds: 0,
                design_check_rounds: 0,
                release_attempts: 0,
              },
            },
            now,
          );
          if (!res.ok) {
            throw new OrchestratorError(
              "transition-failed",
              `не удалось возобновить задачу ${key}: конфликт CAS`,
            );
          }
          return { ok: true, task: res.task! };
        }
        if (task.route === "docs") {
          if (target !== "spec") {
            throw new OrchestratorError(
              "target-invalid",
              `недопустимая цель ${target} для возобновления docs из release/stalled`,
            );
          }
          const res = deps.store.transitionTask(
            {
              taskKey: key,
              expectedNode: "release",
              expectedStatus: "stalled",
              toNode: "spec",
              toStatus: "running",
              actor: "owner",
              reason: "resume-to-spec",
              now,
              updates: {
                spec_attempts: 0,
                spec_review_rounds: 0,
                release_attempts: 0,
              },
            },
            now,
          );
          if (!res.ok) {
            throw new OrchestratorError(
              "transition-failed",
              `не удалось возобновить задачу ${key}: конфликт CAS`,
            );
          }
          return { ok: true, task: res.task! };
        }
      }
      throw new OrchestratorError(
        "target-invalid",
        `цель --target не поддерживается для узла ${task.node} в статусе stalled`,
      );
    }

    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: task.node,
        expectedStatus: "stalled",
        toNode: task.node,
        toStatus: "running",
        actor: isOwner ? "owner" : "coordinator",
        reason: "resume",
        now,
      },
      now,
    );
    if (!res.ok) {
      throw new OrchestratorError(
        "transition-failed",
        `не удалось возобновить задачу ${key}: конфликт CAS`,
      );
    }
    return { ok: true, task: res.task! };
  }

  if (task.status === "blocked") {
    assertOwnerOnly(deps.ctx);

    const validTargetsByRoute: Record<string, string[]> = {
      feature: ["code", "spec", "design", "release"],
      fix: ["code", "release"],
      simple: ["code", "release"],
      docs: ["spec", "release"],
      research: ["research"],
    };

    let tgt: TaskNode;
    if (target) {
      const allowed = validTargetsByRoute[task.route] ?? [];
      if (!allowed.includes(target)) {
        throw new OrchestratorError(
          "target-invalid",
          `цель ${target} недопустима для маршрута ${task.route}`,
        );
      }
      tgt = target as TaskNode;
    } else {
      if (task.node === "checks" || task.node === "review" || task.node === "code") tgt = "code";
      else if (task.node === "spec_review" || task.node === "spec") tgt = "spec";
      else if (task.node === "design_check" || task.node === "design") tgt = "design";
      else if (task.node === "release") tgt = "release";
      else tgt = (validTargetsByRoute[task.route]?.[0] as TaskNode) ?? "code";
    }

    const allowed = validTargetsByRoute[task.route] ?? [];
    if (!allowed.includes(tgt)) {
      throw new OrchestratorError(
        "target-invalid",
        `цель ${tgt} недопустима для маршрута ${task.route}`,
      );
    }

    if (tgt === "release" && task.node !== "release") {
      throw new OrchestratorError(
        "target-invalid",
        "cannot resume to release from unreviewed or unverified code",
      );
    }

    const updates: Partial<TaskQueueRow> = {};
    if (tgt === "design") {
      updates.design_check_rounds = 0;
      updates.spec_attempts = 0;
      updates.spec_review_rounds = 0;
      updates.code_attempts = 0;
      updates.check_attempts = 0;
      updates.code_review_rounds = 0;
      updates.release_attempts = 0;
    } else if (tgt === "spec") {
      updates.spec_attempts = 0;
      updates.spec_review_rounds = 0;
      updates.code_attempts = 0;
      updates.check_attempts = 0;
      updates.code_review_rounds = 0;
      updates.design_check_rounds = 0;
      updates.release_attempts = 0;
    } else if (tgt === "code") {
      updates.code_attempts = 0;
      updates.check_attempts = 0;
      updates.code_review_rounds = 0;
      updates.design_check_rounds = 0;
      updates.release_attempts = 0;
    } else if (tgt === "release") {
      updates.release_attempts = 0;
    }

    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: task.node,
        expectedStatus: "blocked",
        toNode: tgt,
        toStatus: "running",
        actor: "owner",
        reason: "resume",
        now,
        updates,
      },
      now,
    );
    if (!res.ok) {
      throw new OrchestratorError(
        "transition-failed",
        `не удалось возобновить задачу ${key}: конфликт CAS`,
      );
    }
    return { ok: true, task: res.task! };
  }

  if (task.status === "deferred") {
    assertOwnerOnly(deps.ctx);
    let parsedPayload: Record<string, unknown> = {};
    let prevStatus = "";
    try {
      if (task.payload) {
        parsedPayload = JSON.parse(task.payload);
        if (typeof parsedPayload.previous_status === "string") {
          prevStatus = parsedPayload.previous_status;
        }
      }
    } catch {}
    delete parsedPayload.previous_status;

    let toStatus: TaskStatus = "running";
    if (task.node === "start") {
      toStatus = "queued";
    } else if (task.node === "owner_gate") {
      toStatus = "waiting_approval";
    } else if (task.node === "release") {
      if (prevStatus === "waiting_release_note" || prevStatus === "pr_open") {
        toStatus = prevStatus as TaskStatus;
      } else {
        toStatus = "running";
      }
    } else {
      toStatus = "running";
    }

    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: task.node,
        expectedStatus: "deferred",
        toNode: task.node,
        toStatus,
        actor: "owner",
        reason: "resume",
        now,
        updates: {
          deferred_by: null,
          deferred_reason: null,
          payload: JSON.stringify(parsedPayload),
        },
      },
      now,
    );
    if (!res.ok) {
      throw new OrchestratorError(
        "transition-failed",
        `не удалось возобновить задачу ${key}: конфликт CAS`,
      );
    }
    return { ok: true, task: res.task! };
  }

  throw new OrchestratorError(
    "invalid-status",
    `задача ${key} не находится в состоянии stalled, blocked или deferred (current: status=${task.status})`,
  );
}

export async function runApprove(
  taskKey: string,
  comment: string | undefined,
  deps: {
    store: DelegationStore;
    ctx: PluginCliContext;
    workGraphMode: WorkGraphMode;
    now?: () => number;
  },
): Promise<{ ok: boolean; task: TaskQueueRow }> {
  assertOwnerOnly(deps.ctx);
  if (deps.workGraphMode === "off") {
    throw new OrchestratorError(
      "graph-disabled",
      "управление графом отключено (настройка workGraph: off); установи orchestrator.workGraph в shadow или strict",
    );
  }

  const key = normalizeTaskKey(taskKey);
  const task = deps.store.getTask(key);
  if (!task) {
    throw new OrchestratorError(
      "task-not-found",
      `задача ${key} не найдена в очереди`,
    );
  }

  if (task.node !== "owner_gate" || task.status !== "waiting_approval") {
    throw new OrchestratorError(
      "invalid-status",
      `task is not waiting for approval (current: node=${task.node}, status=${task.status})`,
    );
  }

  const toNode: TaskNode = task.route === "docs" ? "release" : "code";
  const now = deps.now ? deps.now() : Date.now();
  const res = deps.store.transitionTask(
    {
      taskKey: key,
      expectedNode: "owner_gate",
      expectedStatus: "waiting_approval",
      toNode,
      toStatus: "running",
      actor: "owner",
      reason: comment || "approved",
      now,
    },
    now,
  );
  if (!res.ok) {
    throw new OrchestratorError(
      "transition-failed",
      `не удалось одобрить задачу ${key}: конфликт CAS`,
    );
  }

  return { ok: true, task: res.task! };
}

export async function runReleaseNote(
  taskKey: string,
  note: string | undefined,
  deps: {
    store: DelegationStore;
    ctx: PluginCliContext;
    workGraphMode: WorkGraphMode;
    now?: () => number;
  },
): Promise<{ ok: boolean; task: TaskQueueRow }> {
  if (deps.workGraphMode === "off") {
    throw new OrchestratorError(
      "graph-disabled",
      "управление графом отключено (настройка workGraph: off); установи orchestrator.workGraph в shadow или strict",
    );
  }

  const key = normalizeTaskKey(taskKey);
  const task = deps.store.getTask(key);
  if (!task) {
    throw new OrchestratorError(
      "task-not-found",
      `задача ${key} не найдена в очереди`,
    );
  }

  if (task.status !== "waiting_release_note") {
    throw new OrchestratorError(
      "invalid-status",
      `task is not waiting for release note (current: node=${task.node}, status=${task.status})`,
    );
  }

  if (!note || note.trim().length === 0) {
    throw new OrchestratorError(
      "invalid-arguments",
      "заметка релиза не может быть пустой",
    );
  }

  const now = deps.now ? deps.now() : Date.now();
  const isOwner = isOwnerCalling(deps.ctx);
  const res = deps.store.transitionTask(
    {
      taskKey: key,
      expectedNode: "release",
      expectedStatus: "waiting_release_note",
      toNode: "release",
      toStatus: "running",
      actor: isOwner ? "owner" : "coordinator",
      reason: "release-note",
      now,
      updates: { release_note: note.trim() },
    },
    now,
  );
  if (!res.ok) {
    throw new OrchestratorError(
      "transition-failed",
      `не удалось сохранить release note для задачи ${key}: конфликт CAS`,
    );
  }

  return { ok: true, task: res.task! };
}

// ── §28 / §31 (r34, ADR-0032): run-queue auto-transitions & checks ─────────

export const DEFAULT_ALLOWED_RUNNERS: readonly string[] = [
  "npm test",
  "npm run test",
  "npm run test:*",
  "npm run lint",
  "pytest",
  "cargo test",
  "go test ./...",
];

export function validateCheckCommand(
  rawCmd: string,
  allowedRunners: readonly string[] = DEFAULT_ALLOWED_RUNNERS,
): { valid: boolean; reason?: string; binary?: string; args?: string[] } {
  const trimmed = rawCmd.trim();
  if (!trimmed) {
    return { valid: false, reason: "empty-command" };
  }

  // §31.3: Shell metacharacters forbidden
  if (/[;&|`$()<>]/.test(trimmed)) {
    return {
      valid: false,
      reason:
        "checks-refused: forbidden-command (shell metacharacters not allowed)",
    };
  }

  // §31.3: Forbidden download/arbitrary execution utilities
  const forbiddenBinaries = [
    "npx",
    "npm exec",
    "npm x",
    "npm init",
    "npm install",
    "npm i",
    "go run",
    "go install",
    "go get",
    "cargo install",
    "curl",
    "wget",
    "bash",
    "sh",
  ];
  for (const fb of forbiddenBinaries) {
    if (trimmed === fb || trimmed.startsWith(fb + " ")) {
      return {
        valid: false,
        reason: `checks-refused: forbidden-command (${fb} is not allowed in checks)`,
      };
    }
  }

  // §31.3: Forbidden flags: -exec, --import, -o, --pdb, --run-command
  const forbiddenFlags = ["-exec", "--import", "--pdb", "--run-command"];
  const parts = trimmed.split(/\s+/);
  for (const p of parts) {
    if (forbiddenFlags.includes(p)) {
      return {
        valid: false,
        reason: `checks-refused: forbidden-flag (${p} is not allowed in checks)`,
      };
    }
  }

  // Check prefix against allowedRunners
  const matchesRunner = allowedRunners.some((runner) => {
    if (runner.endsWith("*")) {
      const prefix = runner.slice(0, -1);
      return trimmed.startsWith(prefix);
    }
    return trimmed === runner || trimmed.startsWith(runner + " ");
  });

  if (!matchesRunner) {
    return {
      valid: false,
      reason: `checks-refused: forbidden-command (${trimmed} does not match allowed runners)`,
    };
  }

  const binary = parts[0]!;
  const args = parts.slice(1);
  return { valid: true, binary, args };
}

export async function executeChecks(
  deps: { cmd?: CmdRunner; repoRoot?: string },
  task: TaskQueueRow,
  allowedRunners: readonly string[] = DEFAULT_ALLOWED_RUNNERS,
): Promise<{ ok: boolean; exitCode: number; output?: string; notRun?: boolean }> {
  let payloadObj: Record<string, unknown> = {};
  if (task.payload) {
    try {
      payloadObj = JSON.parse(task.payload);
    } catch {}
  }

  let commands: string[] = [];
  if (Array.isArray(payloadObj.checks_commands)) {
    commands = payloadObj.checks_commands as string[];
  } else if (typeof payloadObj.test_command === "string") {
    commands = [payloadObj.test_command];
  } else if (payloadObj.checks_fail) {
    return {
      ok: false,
      exitCode: 1,
      output: String(payloadObj.checks_fail_output ?? "test failed"),
    };
  } else if (payloadObj.checks_not_run) {
    return {
      ok: false,
      exitCode: 1,
      notRun: true,
      output: "checks-refused: command not run",
    };
  } else {
    commands = ["npm test"];
  }

  for (const cmdStr of commands) {
    const val = validateCheckCommand(cmdStr, allowedRunners);
    if (!val.valid) {
      return { ok: false, exitCode: 1, notRun: true, output: val.reason };
    }

    if (deps.cmd && deps.repoRoot) {
      const res = await deps.cmd.run(val.binary!, val.args!, {
        cwd: deps.repoRoot,
      });
      if (res.exitCode !== 0) {
        return {
          ok: false,
          exitCode: res.exitCode,
          output:
            (res.stderr || res.stdout).trim() ||
            `test failed with exit code ${res.exitCode}`,
        };
      }
    }
  }

  return { ok: true, exitCode: 0, output: "checks passed" };
}

export async function checkAcceptanceTampered(
  deps: { cmd?: CmdRunner; repoRoot?: string },
  task: TaskQueueRow,
  resultSha: string,
): Promise<boolean> {
  let payloadObj: Record<string, unknown> = {};
  if (task.payload) {
    try {
      payloadObj = JSON.parse(task.payload);
    } catch {}
  }
  if (payloadObj.acceptance_tampered === true) {
    return true;
  }
  if (!task.acceptance_sha) {
    return false;
  }
  if (deps.cmd && deps.repoRoot) {
    const normKey = normalizeTaskKey(task.task_key).toUpperCase();
    const res = await deps.cmd.run(
      "git",
      [
        "diff",
        "--name-only",
        `${task.acceptance_sha}..${resultSha}`,
        "--",
        `docs/specs/acceptance/${normKey}.md`,
      ],
      { cwd: deps.repoRoot },
    );
    if (res.exitCode === 0 && res.stdout.trim().length > 0) {
      return true;
    }
  }
  return false;
}

export async function commitAcceptanceContract(
  cmd: CmdRunner,
  repoRoot: string,
  branch: string,
  taskKey: string,
  content: string,
): Promise<string> {
  const normKey = normalizeTaskKey(taskKey).toUpperCase();
  const relPath = `docs/specs/acceptance/${normKey}.md`;

  const hashRes = await cmd.run("git", ["hash-object", "-w", "--stdin"], {
    cwd: repoRoot,
    stdin: content,
  });
  if (hashRes.exitCode !== 0) {
    throw new OrchestratorError(
      "git-failed",
      `git hash-object failed: ${hashRes.stderr}`,
    );
  }
  const blobSha = hashRes.stdout.trim();

  const parentRes = await cmd.run(
    "git",
    ["rev-parse", `refs/heads/${branch}`],
    { cwd: repoRoot },
  );
  if (parentRes.exitCode !== 0) {
    throw new OrchestratorError(
      "git-failed",
      `branch refs/heads/${branch} not found: ${parentRes.stderr}`,
    );
  }
  const parentSha = parentRes.stdout.trim();

  const tempIndex = path.join(
    repoRoot,
    `.git/index_acc_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  );
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    await cmd.run("git", ["read-tree", `${parentSha}^{tree}`], {
      cwd: repoRoot,
      env,
    });
    const updateRes = await cmd.run(
      "git",
      ["update-index", "--add", "--cacheinfo", "100644", blobSha, relPath],
      { cwd: repoRoot, env },
    );
    if (updateRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `git update-index failed: ${updateRes.stderr}`,
      );
    }
    const writeTreeRes = await cmd.run("git", ["write-tree"], {
      cwd: repoRoot,
      env,
    });
    if (writeTreeRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `git write-tree failed: ${writeTreeRes.stderr}`,
      );
    }
    const treeSha = writeTreeRes.stdout.trim();

    const commitMsg = `docs: договор приёмки ${normKey} (§31)`;
    const commitRes = await cmd.run(
      "git",
      ["commit-tree", treeSha, "-p", parentSha, "-m", commitMsg],
      { cwd: repoRoot, env },
    );
    if (commitRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `git commit-tree failed: ${commitRes.stderr}`,
      );
    }
    const commitSha = commitRes.stdout.trim();

    const updateRefRes = await cmd.run(
      "git",
      ["update-ref", `refs/heads/${branch}`, commitSha, parentSha],
      { cwd: repoRoot, env },
    );
    if (updateRefRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `git update-ref failed: ${updateRefRes.stderr}`,
      );
    }

    return commitSha;
  } finally {
    try {
      if (existsSync(tempIndex)) unlinkSync(tempIndex);
    } catch {}
  }
}

function parsePayload(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export interface RunQueueDeps {
  store: DelegationStore;
  workGraphMode: WorkGraphMode;
  autoAdvance?: boolean;
  maxActiveTasks?: number;
  repoRoot?: string;
  mergeBaseBranch?: string;
  cmd?: CmdRunner;
  bbCli?: BbCli;
  t?: T;
  dispatchNode?: (
    task: TaskQueueRow,
    node: TaskNode,
  ) => Promise<{ ok: boolean; delegationId?: number; error?: string } | void>;
  runChecks?: (
    task: TaskQueueRow,
  ) => Promise<{ ok: boolean; exitCode: number; output?: string; notRun?: boolean }>;
  runReleaseStep?: (
    task: TaskQueueRow,
  ) => Promise<{
    status: "published" | "pr_open" | "failed" | "waiting_release_note" | "stalled";
    publishedSha?: string;
    error?: string;
  }>;
  checkAcceptanceTampered?: (
    task: TaskQueueRow,
    resultSha: string,
  ) => Promise<boolean>;
}

export interface RunQueueResult {
  ok: boolean;
  activeCount: number;
  queuedCount: number;
  readyCount: number;
  advancedCount: number;
  tasks: TaskQueueRow[];
  transitions: TaskTransitionRow[];
}

export async function runRunQueue(
  deps: RunQueueDeps,
): Promise<RunQueueResult> {
  if (deps.workGraphMode === "off") {
    throw new OrchestratorError(
      "graph-disabled",
      "управление графом отключено (настройка workGraph: off); установи orchestrator.workGraph в shadow или strict",
    );
  }

  const maxActiveTasks = Math.max(1, deps.maxActiveTasks ?? 1);
  const repoRoot = deps.repoRoot ?? process.cwd();
  const mergeBaseBranch = deps.mergeBaseBranch ?? "main";
  const transitions: TaskTransitionRow[] = [];
  let advancedCount = 0;

  const shouldAdvance =
    deps.workGraphMode === "strict" || deps.autoAdvance === true;
  let progressed = true;
  let iterations = 0;

  if (shouldAdvance) {
    while (progressed && iterations < 25) {
      iterations++;
      progressed = false;

      // ── 1. Advance active running tasks ───────────────────────────────
      const activeTasks = deps.store.listActiveTasks();
      for (const task of activeTasks) {
        const advanced = await advanceActiveTask(
          task,
          deps,
          repoRoot,
          mergeBaseBranch,
          transitions,
        );
        if (advanced) {
          progressed = true;
          advancedCount++;
        }
      }

      // ── 2. Take queued tasks ──────────────────────────────────────────
      const currentActive = deps.store.listActiveTasks().length;
      let availableSlots = maxActiveTasks - currentActive;

      if (availableSlots > 0) {
        const queuedTasks = deps.store.listQueuedTasks();
        for (const t of queuedTasks) {
          if (availableSlots <= 0) break;

          let depsSatisfied = true;
          if (t.depends_on) {
            try {
              const arr = JSON.parse(t.depends_on) as string[];
              for (const depKey of arr) {
                const depTask = deps.store.getTask(depKey);
                if (!depTask || depTask.status !== "done") {
                  depsSatisfied = false;
                  break;
                }
              }
            } catch {
              depsSatisfied = false;
            }
          }
          if (!depsSatisfied) continue;

          const started = await startQueuedTask(
            t,
            deps,
            repoRoot,
            mergeBaseBranch,
            transitions,
          );
          if (started) {
            progressed = true;
            advancedCount++;
            availableSlots--;
          }
        }
      }
    }
  }

  const finalQueued = deps.store.listQueuedTasks();
  const finalActive = deps.store.listActiveTasks();

  let readyCount = 0;
  for (const t of finalQueued) {
    let depsSatisfied = true;
    if (t.depends_on) {
      try {
        const arr = JSON.parse(t.depends_on) as string[];
        for (const depKey of arr) {
          const depTask = deps.store.getTask(depKey);
          if (!depTask || depTask.status !== "done") {
            depsSatisfied = false;
            break;
          }
        }
      } catch {
        depsSatisfied = false;
      }
    }
    if (depsSatisfied) {
      readyCount++;
    }
  }

  return {
    ok: true,
    activeCount: finalActive.length,
    queuedCount: finalQueued.length,
    readyCount,
    advancedCount,
    tasks: finalQueued,
    transitions,
  };
}

async function startQueuedTask(
  task: TaskQueueRow,
  deps: RunQueueDeps,
  repoRoot: string,
  mergeBaseBranch: string,
  transitions: TaskTransitionRow[],
): Promise<boolean> {
  const normKey = normalizeTaskKey(task.task_key);
  const payload = parsePayload(task.payload);

  let branch = task.branch;
  if (task.route !== "research") {
    if (!branch) {
      branch = computeTaskBranch(task.task_key, task.route);
    }
    if (deps.cmd && branch) {
      const targetRef = `origin/${mergeBaseBranch}`;
      const revBranch = await deps.cmd.run(
        "git",
        ["rev-parse", "--verify", `refs/heads/${branch}`],
        { cwd: repoRoot },
      );
      if (revBranch.exitCode === 0) {
        let baseToCheck = targetRef;
        const revTarget = await deps.cmd.run(
          "git",
          ["rev-parse", "--verify", targetRef],
          { cwd: repoRoot },
        );
        if (revTarget.exitCode !== 0) {
          baseToCheck = mergeBaseBranch;
        }

        const isAncestorRes = await deps.cmd.run(
          "git",
          ["merge-base", "--is-ancestor", `refs/heads/${branch}`, baseToCheck],
          { cwd: repoRoot },
        );
        if (isAncestorRes.exitCode !== 0) {
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "start",
            expectedStatus: "queued",
            toNode: "start",
            toStatus: "stalled",
            actor: "run-queue",
            reason: `stalled: branch-exists: ветка ${branch} уже существует и содержит коммиты; проверь состояние ветки или выполни dequeue`,
            updates: { branch },
          });
          if (tr.ok) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
            return true;
          }
          return false;
        }
      } else {
        let baseRef = targetRef;
        const revTarget = await deps.cmd.run(
          "git",
          ["rev-parse", "--verify", targetRef],
          { cwd: repoRoot },
        );
        if (revTarget.exitCode !== 0) {
          baseRef = mergeBaseBranch;
        }
        await deps.cmd.run("git", ["branch", branch, baseRef], { cwd: repoRoot });
      }
    }
  }

  let targetNode: TaskNode = "code";
  let targetStatus: TaskStatus = "running";
  let acceptanceSha: string | null = task.acceptance_sha;

  if (task.route === "feature") {
    targetNode = "design";
    targetStatus = "running";
  } else if (task.route === "docs") {
    targetNode = "spec";
    targetStatus = "running";
    acceptanceSha = null;
  } else if (task.route === "fix" || task.route === "simple") {
    if (task.confirmation_mode === "manual") {
      targetNode = "owner_gate";
      targetStatus = "waiting_approval";
    } else {
      targetNode = "code";
      targetStatus = "running";
    }
    if (payload.acceptance_text && branch && deps.cmd) {
      try {
        acceptanceSha = await commitAcceptanceContract(
          deps.cmd,
          repoRoot,
          branch,
          task.task_key,
          String(payload.acceptance_text),
        );
      } catch {
        acceptanceSha = `sha-acc-${normKey.toLowerCase()}`;
      }
    } else if (payload.acceptance_text && !acceptanceSha) {
      acceptanceSha = `sha-acc-${normKey.toLowerCase()}`;
    }
  } else if (task.route === "research") {
    targetNode = "research";
    targetStatus = "running";
  }

  const tr = deps.store.transitionTask({
    taskKey: task.task_key,
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: targetNode,
    toStatus: targetStatus,
    actor: "run-queue",
    reason: `task taken from queue -> ${targetNode} (${targetStatus})`,
    updates: {
      branch,
      acceptance_sha: acceptanceSha,
    },
  });

  if (tr.ok && tr.task) {
    const logged = deps.store.listTransitions(task.task_key).at(-1);
    if (logged) transitions.push(logged);
    if (targetStatus === "running") {
      await deps.dispatchNode?.(tr.task, targetNode);
    }
    return true;
  }

  return false;
}

async function advanceActiveTask(
  task: TaskQueueRow,
  deps: RunQueueDeps,
  repoRoot: string,
  mergeBaseBranch: string,
  transitions: TaskTransitionRow[],
): Promise<boolean> {
  const normKey = normalizeTaskKey(task.task_key);
  const payload = parsePayload(task.payload);
  const delegations = deps.store.delegationsByTask(task.task_key);
  const latestDelegation = delegations.at(-1);

  if (
    latestDelegation &&
    (latestDelegation.status === "stalled" || latestDelegation.status === "failed")
  ) {
    const tr = deps.store.transitionTask({
      taskKey: task.task_key,
      expectedNode: task.node,
      expectedStatus: "running",
      toNode: task.node,
      toStatus: "stalled",
      actor: "run-queue",
      reason: `delegation exhausted level chain: status=${latestDelegation.status}`,
    });
    if (tr.ok) {
      const logged = deps.store.listTransitions(task.task_key).at(-1);
      if (logged) transitions.push(logged);
      return true;
    }
    return false;
  }

  switch (task.node) {
    case "design": {
      let contractText: string | null = null;
      if (typeof payload.acceptance_text === "string") {
        contractText = payload.acceptance_text;
      } else if (latestDelegation?.status === "done") {
        contractText = `Acceptance contract for ${normKey}`;
      }
      if (contractText && (latestDelegation?.status === "done" || payload.design_done === true)) {
        let accSha = task.acceptance_sha || null;
        if (deps.cmd && task.branch) {
          try {
            accSha = await commitAcceptanceContract(
              deps.cmd,
              repoRoot,
              task.branch,
              task.task_key,
              contractText,
            );
          } catch {
            accSha = `sha-acc-${normKey.toLowerCase()}`;
          }
        }
        if (!accSha || !accSha.trim()) {
          accSha = `sha-acc-${normKey.toLowerCase()}`;
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "design",
          expectedStatus: "running",
          toNode: "spec",
          toStatus: "running",
          actor: "run-queue",
          reason: "architect delivered acceptance contract -> spec",
          updates: {
            acceptance_sha: accSha,
            payload: JSON.stringify({ ...payload, design_done: false }),
          },
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          await deps.dispatchNode?.(tr.task, "spec");
          return true;
        }
      }
      return false;
    }

    case "spec": {
      if (latestDelegation?.status === "done" || payload.spec_done === true) {
        const specSha =
          latestDelegation?.result_sha ||
          (payload.spec_sha as string) ||
          `sha-spec-${normKey.toLowerCase()}`;

        let tampered = false;
        if (task.route === "feature" && task.acceptance_sha) {
          tampered = deps.checkAcceptanceTampered
            ? await deps.checkAcceptanceTampered(task, specSha)
            : await checkAcceptanceTampered(
                { cmd: deps.cmd, repoRoot },
                task,
                specSha,
              );
        }

        if (tampered) {
          const nextAttempts = task.spec_attempts + 1;
          if (nextAttempts >= 3) {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec",
              expectedStatus: "running",
              toNode: "spec",
              toStatus: "blocked",
              actor: "run-queue",
              reason:
                "spec-refused: acceptance-contract-modified (attempts limit reached: 3/3)",
              updates: { spec_attempts: nextAttempts },
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              return true;
            }
          } else {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec",
              expectedStatus: "running",
              toNode: "spec",
              toStatus: "running",
              actor: "run-queue",
              reason: `spec-refused: acceptance-contract-modified (attempt ${nextAttempts}/3)`,
              updates: { spec_attempts: nextAttempts },
            });
            if (tr.ok && tr.task) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              await deps.dispatchNode?.(tr.task, "spec");
              return true;
            }
          }
          return false;
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "spec",
          expectedStatus: "running",
          toNode: "spec_review",
          toStatus: "running",
          actor: "run-queue",
          reason: "spec commit delivered -> spec_review",
          updates: { spec_sha: specSha },
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          await deps.dispatchNode?.(tr.task, "spec_review");
          return true;
        }
      }
      return false;
    }

    case "spec_review": {
      let verdict: "OK" | "CHANGES" | null = null;
      let blockers = 0;
      if (typeof payload.spec_review_verdict === "string") {
        verdict = payload.spec_review_verdict === "CHANGES" ? "CHANGES" : "OK";
        blockers = Number(payload.spec_review_blockers) || 0;
      } else if (latestDelegation?.status === "done") {
        verdict = "OK";
      }

      if (verdict) {
        if (verdict === "OK" && blockers === 0) {
          if (task.confirmation_mode === "manual") {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec_review",
              expectedStatus: "running",
              toNode: "owner_gate",
              toStatus: "waiting_approval",
              actor: "run-queue",
              reason: "spec review passed OK -> owner_gate (manual mode)",
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              return true;
            }
          } else {
            const nextNode: TaskNode =
              task.route === "docs" ? "release" : "code";
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec_review",
              expectedStatus: "running",
              toNode: nextNode,
              toStatus: "running",
              actor: "run-queue",
              reason: `spec review passed OK -> ${nextNode} (auto mode)`,
            });
            if (tr.ok && tr.task) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              if (nextNode === "code") {
                await deps.dispatchNode?.(tr.task, "code");
              }
              return true;
            }
          }
        } else {
          const nextRounds = task.spec_review_rounds + 1;
          if (nextRounds >= 3) {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec_review",
              expectedStatus: "running",
              toNode: "spec_review",
              toStatus: "blocked",
              actor: "run-queue",
              reason: `spec review requested changes (round limit reached: ${nextRounds}/3)`,
              updates: { spec_review_rounds: nextRounds },
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              return true;
            }
          } else {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec_review",
              expectedStatus: "running",
              toNode: "spec",
              toStatus: "running",
              actor: "run-queue",
              reason: `spec review requested changes (round ${nextRounds}/3: return to spec)`,
              updates: { spec_review_rounds: nextRounds },
            });
            if (tr.ok && tr.task) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              await deps.dispatchNode?.(tr.task, "spec");
              return true;
            }
          }
        }
      }
      return false;
    }

    case "code": {
      if (latestDelegation?.status === "done" || payload.code_done === true) {
        const resultSha =
          latestDelegation?.result_sha ||
          (payload.result_sha as string) ||
          `sha-code-${normKey.toLowerCase()}`;
        const commits =
          latestDelegation?.result_commits ??
          (typeof payload.result_commits === "number"
            ? payload.result_commits
            : 1);

        if (commits === 0 && !payload.no_code) {
          const nextAttempts = task.code_attempts + 1;
          if (nextAttempts >= 3) {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "code",
              expectedStatus: "running",
              toNode: "code",
              toStatus: "blocked",
              actor: "run-queue",
              reason: "code-refused: no-commits (attempts limit reached: 3/3)",
              updates: {
                code_attempts: nextAttempts,
                payload: JSON.stringify({
                  ...payload,
                  code_done: false,
                  result_commits: null,
                }),
              },
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              return true;
            }
          } else {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "code",
              expectedStatus: "running",
              toNode: "code",
              toStatus: "running",
              actor: "run-queue",
              reason: `code-refused: no-commits (attempt ${nextAttempts}/3)`,
              updates: {
                code_attempts: nextAttempts,
                payload: JSON.stringify({
                  ...payload,
                  code_done: false,
                  result_commits: null,
                }),
              },
            });
            if (tr.ok && tr.task) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              await deps.dispatchNode?.(tr.task, "code");
              return true;
            }
          }
          return false;
        }

        const tampered = deps.checkAcceptanceTampered
          ? await deps.checkAcceptanceTampered(task, resultSha)
          : await checkAcceptanceTampered(
              { cmd: deps.cmd, repoRoot },
              task,
              resultSha,
            );

        if (tampered) {
          const nextAttempts = task.code_attempts + 1;
          if (nextAttempts >= 3) {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "code",
              expectedStatus: "running",
              toNode: "code",
              toStatus: "blocked",
              actor: "run-queue",
              reason:
                "acceptance-contract-tampered (attempts limit reached: 3/3)",
              updates: {
                code_attempts: nextAttempts,
                payload: JSON.stringify({
                  ...payload,
                  code_done: false,
                  acceptance_tampered: false,
                }),
              },
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              return true;
            }
          } else {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "code",
              expectedStatus: "running",
              toNode: "code",
              toStatus: "running",
              actor: "run-queue",
              reason: `acceptance-contract-tampered (attempt ${nextAttempts}/3)`,
              updates: {
                code_attempts: nextAttempts,
                payload: JSON.stringify({
                  ...payload,
                  code_done: false,
                  acceptance_tampered: false,
                }),
              },
            });
            if (tr.ok && tr.task) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              await deps.dispatchNode?.(tr.task, "code");
              return true;
            }
          }
          return false;
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "code",
          expectedStatus: "running",
          toNode: "checks",
          toStatus: "running",
          actor: "run-queue",
          reason:
            "code delivered (commits > 0, contract untampered) -> checks",
          updates: {
            result_sha: resultSha,
            payload: JSON.stringify({ ...payload, code_done: false }),
          },
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          return true;
        }
      }
      return false;
    }

    case "checks": {
      const checkResult = deps.runChecks
        ? await deps.runChecks(task)
        : await executeChecks({ cmd: deps.cmd, repoRoot }, task);

      if (checkResult.notRun) {
        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "checks",
          expectedStatus: "running",
          toNode: "checks",
          toStatus: "stalled",
          actor: "run-queue",
          reason:
            checkResult.output ||
            "checks stalled: not_run or forbidden command",
        });
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          return true;
        }
      } else if (checkResult.exitCode !== 0) {
        const nextAttempts = task.check_attempts + 1;
        if (nextAttempts >= 3) {
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "checks",
            expectedStatus: "running",
            toNode: "checks",
            toStatus: "blocked",
            actor: "run-queue",
            reason: `checks failed: exit ${checkResult.exitCode} (attempts limit reached: ${nextAttempts}/3)`,
            updates: {
              check_attempts: nextAttempts,
              payload: JSON.stringify({
                ...payload,
                code_done: false,
                checks_fail: false,
              }),
            },
          });
          if (tr.ok) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
            return true;
          }
        } else {
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "checks",
            expectedStatus: "running",
            toNode: "code",
            toStatus: "running",
            actor: "run-queue",
            reason: `checks failed: exit ${checkResult.exitCode} (attempt ${nextAttempts}/3, returning to code)`,
            updates: {
              check_attempts: nextAttempts,
              payload: JSON.stringify({
                ...payload,
                code_done: false,
                checks_fail: false,
              }),
            },
          });
          if (tr.ok && tr.task) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
            await deps.dispatchNode?.(tr.task, "code");
            return true;
          }
        }
      } else {
        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "checks",
          expectedStatus: "running",
          toNode: "review",
          toStatus: "running",
          actor: "run-queue",
          reason: "all checks passed (exit 0) -> review",
          updates: { check_attempts: 0 },
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          await deps.dispatchNode?.(tr.task, "review");
          return true;
        }
      }
      return false;
    }

    case "review": {
      let verdict: "OK" | "CHANGES" | null = null;
      let blockers = 0;
      if (typeof payload.review_verdict === "string") {
        verdict = payload.review_verdict === "CHANGES" ? "CHANGES" : "OK";
        blockers = Number(payload.review_blockers) || 0;
      } else if (latestDelegation?.status === "done") {
        verdict = "OK";
      }

      if (verdict) {
        if (verdict === "OK" && blockers === 0) {
          const targetNode: TaskNode =
            task.route === "feature" ? "design_check" : "release";
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "review",
            expectedStatus: "running",
            toNode: targetNode,
            toStatus: "running",
            actor: "run-queue",
            reason: `code review passed OK -> ${targetNode}`,
          });
          if (tr.ok && tr.task) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
            if (targetNode === "design_check") {
              await deps.dispatchNode?.(tr.task, "design_check");
            }
            return true;
          }
        } else {
          const nextRounds = task.code_review_rounds + 1;
          if (nextRounds >= 3) {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "review",
              expectedStatus: "running",
              toNode: "review",
              toStatus: "blocked",
              actor: "run-queue",
              reason: `code review requested changes (round limit reached: ${nextRounds}/3)`,
              updates: { code_review_rounds: nextRounds },
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              return true;
            }
          } else {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "review",
              expectedStatus: "running",
              toNode: "code",
              toStatus: "running",
              actor: "run-queue",
              reason: `code review requested changes (round ${nextRounds}/3: return to code)`,
              updates: { code_review_rounds: nextRounds },
            });
            if (tr.ok && tr.task) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              await deps.dispatchNode?.(tr.task, "code");
              return true;
            }
          }
        }
      }
      return false;
    }

    case "design_check": {
      let verdict: "OK" | "CHANGES" | null = null;
      let target: "code" | "design" = "code";
      if (typeof payload.design_check_verdict === "string") {
        verdict =
          payload.design_check_verdict === "CHANGES" ? "CHANGES" : "OK";
        if (payload.design_check_target === "design") target = "design";
      } else if (latestDelegation?.status === "done") {
        verdict = "OK";
      }

      if (verdict) {
        if (verdict === "OK") {
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "design_check",
            expectedStatus: "running",
            toNode: "release",
            toStatus: "running",
            actor: "run-queue",
            reason: "design_check passed OK -> release",
          });
          if (tr.ok && tr.task) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
            return true;
          }
        } else {
          const nextRounds = task.design_check_rounds + 1;
          if (nextRounds >= 3) {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design_check",
              expectedStatus: "running",
              toNode: "design_check",
              toStatus: "blocked",
              actor: "run-queue",
              reason: `design_check rejected (round limit reached: ${nextRounds}/3)`,
              updates: { design_check_rounds: nextRounds },
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              return true;
            }
          } else if (target === "design") {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design_check",
              expectedStatus: "running",
              toNode: "design",
              toStatus: "running",
              actor: "run-queue",
              reason: `design_check requested redesign (round ${nextRounds}/3)`,
              updates: {
                design_check_rounds: nextRounds,
                spec_attempts: 0,
                spec_review_rounds: 0,
                code_attempts: 0,
                check_attempts: 0,
                code_review_rounds: 0,
              },
            });
            if (tr.ok && tr.task) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              await deps.dispatchNode?.(tr.task, "design");
              return true;
            }
          } else {
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design_check",
              expectedStatus: "running",
              toNode: "code",
              toStatus: "running",
              actor: "run-queue",
              reason: `design_check requested code changes (round ${nextRounds}/3)`,
              updates: { design_check_rounds: nextRounds },
            });
            if (tr.ok && tr.task) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
              await deps.dispatchNode?.(tr.task, "code");
              return true;
            }
          }
        }
      }
      return false;
    }

    case "release": {
      let relStatus:
        | "published"
        | "pr_open"
        | "failed"
        | "waiting_release_note"
        | "stalled"
        | null = null;
      let pubSha: string | undefined;
      let relError: string | undefined;

      if (deps.runReleaseStep) {
        const res = await deps.runReleaseStep(task);
        relStatus = res.status;
        pubSha = res.publishedSha;
        relError = res.error;
      } else if (payload.release_status) {
        relStatus = payload.release_status as any;
        pubSha = payload.published_sha as string | undefined;
        relError = payload.release_error as string | undefined;
      } else {
        const releaseRow =
          deps.store.activeReleaseByTask(task.task_key) ??
          deps.store.latestReleaseByTask(task.task_key);
        if (releaseRow) {
          if (releaseRow.status === "published") {
            relStatus =
              releaseRow.target_action === "pr" ? "pr_open" : "published";
            pubSha = releaseRow.published_sha ?? undefined;
          } else if (releaseRow.status === "failed") {
            relStatus = "failed";
            relError = releaseRow.error ?? undefined;
          } else if (releaseRow.status === "rejected") {
            if (
              releaseRow.error?.includes("uncommitted-kb") ||
              releaseRow.error?.includes("unmerged-ui")
            ) {
              relStatus = "stalled";
              relError = releaseRow.error;
            } else {
              relStatus = "failed";
              relError = releaseRow.error ?? undefined;
            }
          }
        }
      }

      if (relStatus === "published") {
        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "release",
          expectedStatus: "running",
          toNode: "release",
          toStatus: "done",
          actor: "run-queue",
          reason: "release published successfully -> task done",
          updates: { result_sha: pubSha ?? task.result_sha },
        });
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (deps.bbCli) {
            try {
              await deps.bbCli.run([
                "tasks",
                "update",
                task.task_key,
                "--status",
                "done",
              ]);
            } catch {}
          }
          return true;
        }
      } else if (relStatus === "pr_open") {
        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "release",
          expectedStatus: "running",
          toNode: "release",
          toStatus: "pr_open",
          actor: "run-queue",
          reason: "PR opened for release",
        });
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          return true;
        }
      } else if (relStatus === "failed") {
        const nextAttempts = task.release_attempts + 1;
        if (nextAttempts >= 3) {
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "release",
            expectedStatus: "running",
            toNode: "release",
            toStatus: "blocked",
            actor: "run-queue",
            reason: `release failed: ${relError ?? "publish failed"} (attempts limit reached: ${nextAttempts}/3)`,
            updates: {
              release_attempts: nextAttempts,
              payload: JSON.stringify({
                ...payload,
                code_done: false,
                release_status: null,
              }),
            },
          });
          if (tr.ok) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
            return true;
          }
        } else {
          const retNode: TaskNode =
            task.route === "docs" ? "spec" : "code";
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "release",
            expectedStatus: "running",
            toNode: retNode,
            toStatus: "running",
            actor: "run-queue",
            reason: `release failed (attempt ${nextAttempts}/3: return to ${retNode})`,
            updates: {
              release_attempts: nextAttempts,
              payload: JSON.stringify({
                ...payload,
                code_done: false,
                release_status: null,
              }),
            },
          });
          if (tr.ok && tr.task) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
            await deps.dispatchNode?.(tr.task, retNode);
            return true;
          }
        }
      } else if (relStatus === "stalled") {
        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "release",
          expectedStatus: "running",
          toNode: "release",
          toStatus: "stalled",
          actor: "run-queue",
          reason: relError || "release stalled: uncommitted-kb or unmerged-ui",
        });
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          return true;
        }
      } else if (relStatus === "waiting_release_note") {
        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "release",
          expectedStatus: "running",
          toNode: "release",
          toStatus: "waiting_release_note",
          actor: "run-queue",
          reason: "release waiting for release note",
        });
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          return true;
        }
      }
      return false;
    }

    case "research": {
      if (
        latestDelegation?.status === "done" ||
        payload.research_done === true
      ) {
        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "research",
          expectedStatus: "running",
          toNode: "research",
          toStatus: "done",
          actor: "run-queue",
          reason: "research report completed -> task done",
        });
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          return true;
        }
      }
      return false;
    }

    default:
      return false;
  }
}
