/**
 * Orchestrator r34 task work graph (§27, §28, §32 and ADR-0032).
 * Slice 5a: task_queue, task_transitions, CAS transitions, workGraph modes,
 * queue CLI commands (enqueue, dequeue, defer, reject, resume, approve,
 * release-note, run-queue) and owner-only guards.
 */
import { existsSync, readFileSync } from "node:fs";
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
): Promise<{ ok: boolean; action: string }> {
  const normKey = normalizeTaskKey(taskKey).toLowerCase();
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
  const remoteExists =
    lsRemote.exitCode === 0 && lsRemote.stdout.trim().length > 0;
  let remoteSha: string | null = remoteExists
    ? lsRemote.stdout.trim().split(/\s+/)[0] ?? null
    : null;

  if (!localExists && !remoteExists) {
    return { ok: true, action: "clean" };
  }

  if (remoteExists) {
    await cmd.run("git", ["fetch", "origin", `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    const revRemote = await cmd.run(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
      { cwd: repoRoot },
    );
    if (revRemote.exitCode === 0 && revRemote.stdout.trim()) {
      remoteSha = revRemote.stdout.trim();
    }
  }

  // Check if tips are ancestors of origin/<mergeBaseBranch>
  let targetRef = `origin/${mergeBaseBranch}`;
  const targetCheck = await cmd.run(
    "git",
    ["rev-parse", "--verify", targetRef],
    { cwd: repoRoot },
  );
  if (targetCheck.exitCode !== 0) {
    targetRef = mergeBaseBranch;
  }

  let localMerged = true;
  if (localExists && localSha) {
    const r = await cmd.run(
      "git",
      ["merge-base", "--is-ancestor", localSha, targetRef],
      { cwd: repoRoot },
    );
    localMerged = r.exitCode === 0;
  }

  let remoteMerged = true;
  if (remoteExists && remoteSha) {
    const r = await cmd.run(
      "git",
      ["merge-base", "--is-ancestor", remoteSha, targetRef],
      { cwd: repoRoot },
    );
    remoteMerged = r.exitCode === 0;
  }

  if (localMerged && remoteMerged) {
    if (localExists) {
      await cmd.run("git", ["branch", "-D", branch], { cwd: repoRoot });
    }
    if (remoteExists) {
      await cmd
        .run("git", ["push", "origin", "--delete", branch], { cwd: repoRoot })
        .catch(() => {});
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
    await cmd.run(
      "git",
      ["tag", `refs/tags/archive/${normKey}-force-reset-${ts}`, `refs/heads/${branch}`],
      { cwd: repoRoot },
    );
    await cmd.run("git", ["branch", "-D", branch], { cwd: repoRoot });
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
      await cmd.run(
        "git",
        [
          "tag",
          `refs/tags/archive/${normKey}-remote-force-reset-${ts}`,
          remoteSha,
        ],
        { cwd: repoRoot },
      );
    }
    await cmd
      .run("git", ["push", "origin", "--delete", branch], { cwd: repoRoot })
      .catch(() => {});
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
  const normKey = normalizeTaskKey(taskKey).toLowerCase();
  const ts = Date.now();

  const localRes = await cmd.run(
    "git",
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    { cwd: repoRoot },
  );
  if (localRes.exitCode === 0) {
    await cmd.run(
      "git",
      ["tag", `refs/tags/archive/${normKey}-cancelled-${ts}`, `refs/heads/${branch}`],
      { cwd: repoRoot },
    );
    await cmd.run("git", ["branch", "-D", branch], { cwd: repoRoot });
  }

  const lsRemote = await cmd.run(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd: repoRoot },
  );
  if (lsRemote.exitCode === 0 && lsRemote.stdout.trim().length > 0) {
    await cmd.run("git", ["fetch", "origin", `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    const revRemote = await cmd.run(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
      { cwd: repoRoot },
    );
    const remoteSha =
      (revRemote.exitCode === 0 ? revRemote.stdout.trim() : null) ||
      lsRemote.stdout.trim().split(/\s+/)[0];
    if (remoteSha) {
      await cmd.run(
        "git",
        [
          "tag",
          `refs/tags/archive/${normKey}-remote-cancelled-${ts}`,
          remoteSha,
        ],
        { cwd: repoRoot },
      );
      await cmd
        .run("git", ["push", "origin", "--delete", branch], { cwd: repoRoot })
        .catch(() => {});
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

  // Route & level validation (§27.2)
  let level = input.level as TaskLevel | undefined;
  if (!level) {
    if (route === "docs") level = "spec";
    else if (route === "research") level = "research";
    else level = "complex";
  }

  if (["feature", "fix", "simple"].includes(route)) {
    if (level === "spec" || level === "architect") {
      throw new OrchestratorError(
        "invalid-level",
        "узел code требует уровня с инструментами написания кода (роль executor)",
      );
    }
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
    if (existsSync(input.acceptance)) {
      try {
        acceptanceText = readFileSync(input.acceptance, "utf8");
      } catch {
        acceptanceText = input.acceptance;
      }
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
        deps.store.updateTask(
          taskKey,
          {
            payload: JSON.stringify(existingPayload),
            status: "waiting_approval",
          },
          now,
        );
        deps.store.transitionTask(
          {
            taskKey,
            expectedNode: "owner_gate",
            expectedStatus: existing.status,
            toNode: "owner_gate",
            toStatus: "waiting_approval",
            actor: "owner",
            reason: "update-acceptance",
            now,
          },
          now,
        );
        return { ok: true, task: deps.store.getTask(taskKey)! };
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
  } else {
    // New task: acceptance missing check for fix/simple (§31)
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
      await checkAndPrepareTaskBranch(
        deps.cmd,
        deps.repoRoot,
        branch,
        taskKey,
        deps.mergeBaseBranch,
        Boolean(input.forceResetBranch),
      );
    }
  }

  const priority = input.priority !== undefined ? Number(input.priority) : 100;
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

  const now = deps.now ? deps.now() : Date.now();
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
      },
    },
    now,
  );

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
      return { ok: true, task: res.task! };
    }

    if (task.route === "fix" || task.route === "simple") {
      if (target !== undefined) {
        throw new OrchestratorError(
          "target-invalid",
          "для маршрутов fix и simple цель --target не поддерживается",
        );
      }
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
          },
        },
        now,
      );
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
      if (task.node === "checks" || task.node === "review") tgt = "code";
      else if (task.node === "spec_review") tgt = "spec";
      else if (task.node === "design_check") tgt = "design";
      else if (task.node === "release") tgt = "release";
      else tgt = "code";
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
    return { ok: true, task: res.task! };
  }

  if (task.status === "deferred") {
    assertOwnerOnly(deps.ctx);
    const toStatus = task.node === "owner_gate" ? "waiting_approval" : "running";
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
        },
      },
      now,
    );
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

  return { ok: true, task: res.task! };
}

export async function runRunQueue(
  deps: {
    store: DelegationStore;
    workGraphMode: WorkGraphMode;
  },
): Promise<{
  ok: boolean;
  activeCount: number;
  queuedCount: number;
  tasks: TaskQueueRow[];
  readyCount: number;
}> {
  if (deps.workGraphMode === "off") {
    throw new OrchestratorError(
      "graph-disabled",
      "управление графом отключено (настройка workGraph: off); установи orchestrator.workGraph в shadow или strict",
    );
  }

  const queued = deps.store.listQueuedTasks();
  const active = deps.store.listActiveTasks();

  let readyCount = 0;
  for (const t of queued) {
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
    activeCount: active.length,
    queuedCount: queued.length,
    readyCount,
    tasks: queued,
  };
}
