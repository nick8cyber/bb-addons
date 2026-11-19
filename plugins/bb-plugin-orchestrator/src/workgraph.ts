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
  DelegationRow,
  TaskLevel,
  TaskNode,
  TaskQueueRow,
  TaskRoute,
  TaskStatus,
  TaskTransitionRow,
} from "./store.js";
import { normalizeTaskKey } from "./store.js";
import { verdictDetailsInBody } from "./release.js";
import type { PluginCliContext } from "@get-bb/plugin-sdk";
import type { T } from "./i18n/index.js";
import type { Policy } from "./policy.js";
import {
  TRANSITION_TABLE,
  resolveTransition,
  extractCounters,
  type TransitionCounters,
  type TransitionEvent,
  type TransitionInput,
  type TransitionResolution,
  type TransitionRule,
} from "./transition-matrix.js";

export {
  TRANSITION_TABLE,
  resolveTransition,
  extractCounters,
  type TransitionCounters,
  type TransitionEvent,
  type TransitionInput,
  type TransitionResolution,
  type TransitionRule,
};

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

export interface ShadowActionParams {
  command: "delegate" | "merge" | "release";
  taskKey: string;
  level?: string;
  route?: string;
  actor?: string;
  policy?: Policy | null;
}

/** Resolves the effective role for a level against policy or conventions (§2.3 / §27.3). */
export function resolveLevelRoleForWorkGraph(
  levelName: string | undefined,
  policy?: Policy | null,
): "executor" | "auditor" | "architect" | "researcher" | "spec" | "unknown" {
  if (!levelName) return "unknown";
  if (levelName === "architect") return "architect";
  if (levelName === "spec") return "spec";
  if (levelName === "research") return "researcher";

  if (policy) {
    const pLevel = policy.levels[levelName];
    if (pLevel?.role === "auditor") return "auditor";
    if (pLevel?.role === "researcher") return "researcher";
    if (pLevel?.role === "executor") return "executor";

    if (policy.reviewByLevel) {
      if (Object.values(policy.reviewByLevel).includes(levelName)) {
        return "auditor";
      }
    }
  }

  // Fallback heuristics when policy level has no explicit role
  if (
    levelName === "review" ||
    levelName.startsWith("review-") ||
    levelName.endsWith("-review") ||
    levelName.includes("review")
  ) {
    return "auditor";
  }
  return "executor";
}

/** Matches task node against level and policy role (§27.3 / §32). */
export function matchesNodeLevel(
  node: TaskNode,
  levelName: string | undefined,
  policy?: Policy | null,
): boolean {
  if (!levelName) return false;
  const role = resolveLevelRoleForWorkGraph(levelName, policy);

  switch (node) {
    case "code":
      return (
        role === "executor" &&
        levelName !== "architect" &&
        levelName !== "spec" &&
        levelName !== "research"
      );
    case "review":
    case "spec_review":
      return role === "auditor";
    case "design":
    case "design_check":
      return levelName === "architect" || role === "architect";
    case "spec":
      return levelName === "spec";
    case "research":
      return levelName === "research" || role === "researcher";
    default:
      return false;
  }
}

/** §32 (Б4): In shadow mode, mirror manual coordinator actions and log shadow_eval. */
export function recordShadowAction(
  store: DelegationStore,
  params: ShadowActionParams,
  mode: WorkGraphMode,
): void {
  if (mode !== "shadow") return;
  try {
    const key = normalizeTaskKey(params.taskKey);
    const task = store.getTask(key);
    const actor = params.actor ?? "shadow:coordinator";

    if (!task) {
      // §32 (Б4): For un-enqueued tasks, log service transition with 'none' sentinels
      store.insertTransition({
        taskKey: key,
        fromNode: "none",
        toNode: "none",
        fromStatus: "none",
        toStatus: "none",
        actor: "shadow:coordinator",
        reason: "task-not-enqueued",
        payload: JSON.stringify({
          event: "manual_command",
          command: params.command,
          would_reject: "graph-required",
          would_block: { reason: "graph-required" },
        }),
      });
      return;
    }

    // §32 (Б4): For enqueued tasks, evaluate whether the action would be allowed or rejected
    const payload = parsePayload(task.payload);
    let wouldAllow: string | undefined;
    let wouldReject: string | undefined;

    if (params.command === "delegate") {
      const level = params.level ?? "";
      if (matchesNodeLevel(task.node, level, params.policy)) {
        wouldAllow = "delegate";
      } else {
        wouldReject = `invalid_node: expected ${task.node}, got delegate level ${level}`;
      }
    } else if (params.command === "merge") {
      if (task.node === "code") {
        wouldAllow = "merge";
      } else {
        wouldReject = `invalid_node: merge called while at node ${task.node}`;
      }
    } else if (params.command === "release") {
      if (task.node === "release" && task.status === "running") {
        wouldAllow = "release";
      } else {
        wouldReject = `node-not-release: release called while at ${task.node}:${task.status}`;
      }
    }

    const shadowEval = {
      command: params.command,
      evaluated_at: Date.now(),
      would_allow: wouldAllow,
      would_reject: wouldReject,
      would_block: wouldReject ? { reason: wouldReject } : undefined,
      current_node: task.node,
      current_status: task.status,
    };

    store.insertTransition({
      taskKey: key,
      fromNode: task.node,
      toNode: task.node,
      fromStatus: task.status,
      toStatus: task.status,
      actor,
      reason: `shadow-mirror:${params.command}`,
      payload: JSON.stringify({
        event: "manual_command",
        command: params.command,
        shadow_eval: shadowEval,
      }),
    });

    store.updateTask(key, {
      payload: JSON.stringify({
        ...payload,
        shadow_eval: shadowEval,
      }),
    });
  } catch {
    // Silent isolation: shadow mode audit must never break manual coordinator actions
  }
}

/** §32 п.1: In strict mode, blocks direct delegate, merge, release. In shadow mode, logs mirror audit. */
export function assertGraphAllowsDirectAction(
  store: DelegationStore,
  taskKey: string,
  mode: WorkGraphMode,
  action?: {
    command: "delegate" | "merge" | "release";
    level?: string;
    route?: string;
    actor?: string;
    policy?: Policy | null;
  },
): void {
  if (mode === "shadow") {
    try {
      recordShadowAction(
        store,
        {
          command: action?.command ?? "delegate",
          taskKey,
          level: action?.level,
          route: action?.route,
          actor: action?.actor ?? "shadow:coordinator",
          policy: action?.policy,
        },
        mode,
      );
    } catch {}
    return;
  }
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

  const repoRoot = deps.ctx?.cwd ?? process.cwd();

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

    const candidatePath = path.resolve(repoRoot, raw);
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

        let accSha = existing.acceptance_sha;
        if (existing.branch && deps.cmd) {
          try {
            accSha = await commitAcceptanceContract(
              deps.cmd,
              repoRoot,
              existing.branch,
              taskKey,
              acceptanceText,
            );
          } catch (e: any) {
            throw new OrchestratorError(
              "git-failed",
              `не удалось закоммитить обновлённый договор приёмки: ${e?.message ?? e}`,
            );
          }
        }

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
              acceptance_sha: accSha,
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
  const resolution = resolveTransition({
    route: task.route,
    node: task.node,
    status: task.status,
    event: { type: "dequeue", isOwner: isOwnerCalling(deps.ctx), reason },
    mode: task.confirmation_mode,
    counters: extractCounters(task),
  });
  if (!resolution.allowed) {
    throw new OrchestratorError(
      resolution.errorCode ?? "invalid-status",
      `задача ${key} уже завершена или отменена (status=${task.status})`,
    );
  }

  if (resolution.action?.archiveBranch) {
    await archiveAndCleanupTaskBranch(deps.cmd, deps.repoRoot, task.branch, key);
  }

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
      toNode: resolution.toNode,
      toStatus: resolution.toStatus,
      actor: "owner",
      reason: resolution.reason,
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
  const resolution = resolveTransition({
    route: task.route,
    node: task.node,
    status: task.status,
    event: { type: "owner_defer", isOwner: isOwnerCalling(deps.ctx), reason },
    mode: task.confirmation_mode,
    counters: extractCounters(task),
  });
  if (!resolution.allowed) {
    if (task.status === "deferred") {
      throw new OrchestratorError(
        "invalid-status",
        `задача ${key} уже отложена (status=deferred)`,
      );
    }
    throw new OrchestratorError(
      resolution.errorCode ?? "invalid-status",
      `задача ${key} уже завершена или отменена (status=${task.status})`,
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
      toNode: resolution.toNode,
      toStatus: resolution.toStatus,
      actor: "owner",
      reason: resolution.reason,
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
    const tgt = target as TaskNode | undefined;
    const resolution = resolveTransition({
      route: task.route,
      node: "owner_gate",
      status: task.status,
      event: { type: "owner_reject", isOwner: true, target: tgt, reason: reason! },
      mode: task.confirmation_mode,
      counters: extractCounters(task),
    });

    if (!resolution.allowed) {
      if (resolution.errorCode === "target-invalid") {
        throw new OrchestratorError("target-invalid", resolution.errorMessage!);
      }
      throw new OrchestratorError(
        resolution.errorCode ?? "invalid-status",
        resolution.errorMessage ?? "reject failed",
      );
    }

    let rejectPayload: Record<string, unknown> = {};
    try {
      if (task.payload) rejectPayload = JSON.parse(task.payload);
    } catch {}
    delete rejectPayload.previous_status;

    const updates: Partial<TaskQueueRow> = { payload: JSON.stringify(rejectPayload) };
    if (resolution.toStatus === "deferred") {
      updates.deferred_by = "owner";
      updates.deferred_reason = reason ?? "rejected at owner_gate";
    }

    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: "owner_gate",
        expectedStatus: task.status,
        toNode: resolution.toNode,
        toStatus: resolution.toStatus,
        actor: "owner",
        reason: reason ?? "rejected",
        now,
        updates,
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
    const resolution = resolveTransition({
      route: task.route,
      node: "code",
      status: task.status,
      event: { type: "code_reject", reason: reason!, isOwnerOrCoordinator: true },
      mode: task.confirmation_mode,
      counters: extractCounters(task),
    });

    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: "code",
        expectedStatus: task.status,
        toNode: resolution.toNode,
        toStatus: resolution.toStatus,
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
      let isPrClosed = false;
      if (task.payload) {
        try {
          const p = JSON.parse(task.payload);
          isPrClosed = p.stalled_reason === "pr_closed";
        } catch {}
      }
      const resolution = resolveTransition({
        route: task.route,
        node: task.node,
        status: "stalled",
        event: {
          type: "resume",
          target: target as TaskNode,
          isOwner: true,
          prClosedReason: isPrClosed,
        },
        mode: task.confirmation_mode,
        counters: extractCounters(task),
      });

      if (!resolution.allowed) {
        if (task.node !== "release") {
          throw new OrchestratorError(
            "target-invalid",
            `цель --target не поддерживается для узла ${task.node} в статусе stalled`,
          );
        }
        if (!isPrClosed) {
          throw new OrchestratorError(
            "target-invalid",
            `цель --target в release/stalled допустима только при причине стола pr_closed (§28.1 строки 56-57)`,
          );
        }
        throw new OrchestratorError(
          "target-invalid",
          task.route === "docs"
            ? `недопустимая цель ${target} для возобновления docs из release/stalled`
            : `недопустимая цель ${target} для возобновления из release/stalled`,
        );
      }

      const updates: Partial<TaskQueueRow> = {};
      if (resolution.counterUpdates) {
        Object.assign(updates, resolution.counterUpdates);
      }

      const res = deps.store.transitionTask(
        {
          taskKey: key,
          expectedNode: task.node,
          expectedStatus: "stalled",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "owner",
          reason: `resume-to-${target}`,
          now,
          updates: Object.keys(updates).length > 0 ? updates : undefined,
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

    const resolution = resolveTransition({
      route: task.route,
      node: task.node,
      status: "stalled",
      event: { type: "resume" },
      mode: task.confirmation_mode,
      counters: extractCounters(task),
    });

    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: task.node,
        expectedStatus: "stalled",
        toNode: resolution.toNode,
        toStatus: resolution.toStatus,
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

    const resolution = resolveTransition({
      route: task.route,
      node: task.node,
      status: "blocked",
      event: {
        type: "resume",
        target: tgt,
        isOwner: true,
      },
      mode: task.confirmation_mode,
      counters: extractCounters(task),
    });

    if (!resolution.allowed) {
      throw new OrchestratorError(
        resolution.errorCode ?? "target-invalid",
        resolution.errorMessage ?? `цель ${tgt} недопустима для маршрута ${task.route}`,
      );
    }

    const updates: Partial<TaskQueueRow> = {};
    if (resolution.counterUpdates) {
      Object.assign(updates, resolution.counterUpdates);
    }

    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: task.node,
        expectedStatus: "blocked",
        toNode: resolution.toNode,
        toStatus: resolution.toStatus,
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

    const resolution = resolveTransition({
      route: task.route,
      node: task.node,
      status: "deferred",
      event: { type: "resume", isOwner: true },
      mode: task.confirmation_mode,
      counters: extractCounters(task),
    });

    let toStatus: TaskStatus = resolution.toStatus;
    if (task.node === "start") {
      toStatus = "queued";
    } else if (task.node === "release") {
      if (prevStatus === "waiting_release_note" || prevStatus === "pr_open") {
        toStatus = prevStatus as TaskStatus;
      }
    }

    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: task.node,
        expectedStatus: "deferred",
        toNode: resolution.toNode,
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

  const resolution = resolveTransition({
    route: task.route,
    node: task.node,
    status: task.status,
    event: { type: "owner_approve", isOwner: isOwnerCalling(deps.ctx), comment },
    mode: task.confirmation_mode,
    counters: extractCounters(task),
  });

  if (!resolution.allowed) {
    if (resolution.errorCode === "permission-denied") {
      throw new OrchestratorError("permission-denied", resolution.errorMessage ?? "owner-only");
    }
    throw new OrchestratorError(
      "invalid-status",
      `task is not waiting for approval (current: node=${task.node}, status=${task.status})`,
    );
  }

  const now = deps.now ? deps.now() : Date.now();
  const res = deps.store.transitionTask(
    {
      taskKey: key,
      expectedNode: task.node,
      expectedStatus: task.status,
      toNode: resolution.toNode,
      toStatus: resolution.toStatus,
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

  if (!note || note.trim().length === 0) {
    throw new OrchestratorError(
      "invalid-arguments",
      "заметка релиза не может быть пустой",
    );
  }

  const resolution = resolveTransition({
    route: task.route,
    node: task.node,
    status: task.status,
    event: { type: "release_note_provided", note: note.trim() },
    mode: task.confirmation_mode,
    counters: extractCounters(task),
  });

  if (!resolution.allowed) {
    throw new OrchestratorError(
      "invalid-status",
      `task is not waiting for release note (current: node=${task.node}, status=${task.status})`,
    );
  }

  const now = deps.now ? deps.now() : Date.now();
  const isOwner = isOwnerCalling(deps.ctx);
  const res = deps.store.transitionTask(
    {
      taskKey: key,
      expectedNode: "release",
      expectedStatus: "waiting_release_note",
      toNode: resolution.toNode,
      toStatus: resolution.toStatus,
      actor: isOwner ? "owner" : "coordinator",
      reason: resolution.reason,
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
  const forbiddenFlags = ["-exec", "--import", "-o", "--pdb", "--run-command"];
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
        try {
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
        } catch {}
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

          try {
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
          } catch {}
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

  // §32 (Б4 / 5в): In shadow mode without autoAdvance, record simulated evaluation
  if (deps.workGraphMode === "shadow" && !shouldAdvance) {
    // 1. Evaluate queued tasks: start -> <target_node>
    for (const t of finalQueued) {
      try {
        const payload = parsePayload(t.payload);
        const res = resolveTransition({
          route: t.route,
          node: "start",
          status: "queued",
          event: { type: "queue_take" },
          mode: t.confirmation_mode,
          counters: extractCounters(t),
        });
        const shadowEval = {
          command: "run-queue",
          evaluated_at: Date.now(),
          would_transition: res.allowed
            ? {
                from_node: "start",
                to_node: res.toNode,
                to_status: res.toStatus,
                event: "queue_take",
              }
            : undefined,
          note: "вычислено, но не подключено",
          current_node: t.node,
          current_status: t.status,
        };
        deps.store.updateTask(t.task_key, {
          payload: JSON.stringify({
            ...payload,
            shadow_eval: shadowEval,
          }),
        });
      } catch {}
    }

    // 2. Evaluate active tasks: would advance based on completed delegations or state
    for (const t of finalActive) {
      try {
        const payload = parsePayload(t.payload);
        const delegations = deps.store.delegationsByTask(t.task_key);
        const latestDel = getActiveDelegationForTask(t, delegations);
        let wouldTrans:
          | { from_node: string; to_node: string; to_status: string; event: string }
          | undefined;

        if (
          latestDel &&
          (latestDel.status === "stalled" ||
            latestDel.status === "failed" ||
            latestDel.status === "quota" ||
            latestDel.status === "cancelled")
        ) {
          const failEvent: TransitionEvent = {
            type: `${t.node}_failed` as any,
            exhausted: true,
            reason: latestDel.status,
          };
          const res = resolveTransition({
            route: t.route,
            node: t.node,
            status: "running",
            event: failEvent,
            mode: t.confirmation_mode,
            counters: extractCounters(t),
          });
          if (res.allowed) {
            wouldTrans = {
              from_node: t.node,
              to_node: res.toNode,
              to_status: res.toStatus,
              event: `${t.node}_failed`,
            };
          }
        } else if (
          latestDel?.status === "done" ||
          payload[`${t.node}_done`] === true
        ) {
          let event: TransitionEvent | null = null;
          if (t.node === "code") {
            event = {
              type: "code_delivered",
              resultSha:
                latestDel?.result_sha ??
                (payload.result_sha as string) ??
                "sha-code",
              commits:
                typeof latestDel?.result_commits === "number"
                  ? latestDel.result_commits
                  : typeof payload.result_commits === "number"
                    ? payload.result_commits
                    : 1,
              noCode: false,
            };
          } else if (t.node === "spec") {
            event = {
              type: "spec_delivered",
              specSha:
                latestDel?.result_sha ??
                (payload.spec_sha as string) ??
                "sha-spec",
            };
          } else if (t.node === "design") {
            event = {
              type: "design_delivered",
              acceptanceText:
                (payload.acceptance_text as string) ?? "acceptance text",
            };
          } else if (t.node === "review") {
            event = {
              type: "review_verdict",
              verdict: "OK",
              blockers: 0,
            };
          } else if (t.node === "spec_review") {
            event = {
              type: "spec_review_verdict",
              verdict: "OK",
              blockers: 0,
            };
          } else if (t.node === "design_check") {
            event = {
              type: "design_check_verdict",
              verdict: "OK",
              blockers: 0,
            };
          } else if (t.node === "research") {
            event = {
              type: "research_delivered",
              report: (payload.research_report as string) ?? "done",
            };
          }

          if (event) {
            const res = resolveTransition({
              route: t.route,
              node: t.node,
              status: "running",
              event,
              mode: t.confirmation_mode,
              counters: extractCounters(t),
            });
            if (res.allowed) {
              wouldTrans = {
                from_node: t.node,
                to_node: res.toNode,
                to_status: res.toStatus,
                event: event.type,
              };
            }
          }
        }

        const shadowEval = {
          command: "run-queue",
          evaluated_at: Date.now(),
          would_transition: wouldTrans,
          note: "вычислено, но не подключено",
          current_node: t.node,
          current_status: t.status,
        };
        deps.store.updateTask(t.task_key, {
          payload: JSON.stringify({
            ...payload,
            shadow_eval: shadowEval,
          }),
        });
      } catch {}
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
          const resolution = resolveTransition({
            route: task.route,
            node: "start",
            status: "queued",
            event: { type: "queue_take", branchExistsWithCommits: true, branch },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "start",
            expectedStatus: "queued",
            toNode: resolution.toNode,
            toStatus: resolution.toStatus,
            actor: "run-queue",
            reason: resolution.reason,
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
        const branchRes = await deps.cmd.run("git", ["branch", branch, baseRef], { cwd: repoRoot });
        if (branchRes.exitCode !== 0) {
          deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "start",
            expectedStatus: "queued",
            toNode: "start",
            toStatus: "stalled",
            actor: "run-queue",
            reason: `git-failed: не удалось создать ветку ${branch}: ${branchRes.stderr.trim()}`,
          });
          return false;
        }
      }
    }
  }

  const resolution = resolveTransition({
    route: task.route,
    node: "start",
    status: "queued",
    event: { type: "queue_take" },
    mode: task.confirmation_mode,
    counters: extractCounters(task),
  });

  if (!resolution.allowed) {
    return false;
  }

  let acceptanceSha: string | null = task.acceptance_sha;
  if (resolution.action?.commitAcceptance) {
    if (payload.acceptance_text && branch) {
      if (!deps.cmd) {
        deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "start",
          expectedStatus: "queued",
          toNode: "start",
          toStatus: "stalled",
          actor: "run-queue",
          reason: "git-failed: missing cmd runner for acceptance commit",
        });
        return false;
      }
      try {
        acceptanceSha = await commitAcceptanceContract(
          deps.cmd,
          repoRoot,
          branch,
          task.task_key,
          String(payload.acceptance_text),
        );
      } catch (e: any) {
        deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "start",
          expectedStatus: "queued",
          toNode: "start",
          toStatus: "stalled",
          actor: "run-queue",
          reason: `git-failed: ${e?.message ?? e}`,
        });
        return false;
      }
    }
  } else if (task.route === "docs") {
    acceptanceSha = null;
  }

  const tr = deps.store.transitionTask({
    taskKey: task.task_key,
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: resolution.toNode,
    toStatus: resolution.toStatus,
    actor: "run-queue",
    reason: resolution.reason,
    updates: {
      branch,
      acceptance_sha: acceptanceSha,
    },
  });

  if (tr.ok && tr.task) {
    const logged = deps.store.listTransitions(task.task_key).at(-1);
    if (logged) transitions.push(logged);
    if (resolution.toStatus === "running" && resolution.action?.dispatchNode) {
      await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
    }
    return true;
  }

  return false;
}

export function parseVerdictDetailsFromText(body: string): {
  verdict: "OK" | "CHANGES";
  blockers: number;
  target?: "code" | "design";
} | null {
  let result: {
    verdict: "OK" | "CHANGES";
    blockers: number;
    target?: "code" | "design";
  } | null = null;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    let parsed: { verdict?: unknown; blockers?: unknown; target?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && (parsed.verdict === "OK" || parsed.verdict === "CHANGES")) {
      const v = parsed.verdict as "OK" | "CHANGES";
      // §16.7: the verdict line carries `blockers` — a missing field is not an OK.
      const b =
        typeof parsed.blockers === "number"
          ? parsed.blockers
          : 1;
      let t: "code" | "design" | undefined;
      if (parsed.target === "design" || parsed.target === "code") {
        t = parsed.target;
      }
      result = { verdict: v, blockers: b, target: t };
    }
  }
  return result;
}

export async function extractReportFromDelegation(
  taskKey: string,
  delegation: DelegationRow,
  bbCli?: BbCli,
): Promise<string | null> {
  if (!bbCli || !delegation.thread_id) return null;

  // 1. Check task comments from this delegation thread
  try {
    const showRes = await bbCli.run(["tasks", "show", taskKey, "--json"]);
    if (showRes.exitCode === 0 && showRes.stdout) {
      const show = JSON.parse(showRes.stdout) as {
        comments?: {
          kind?: string;
          threadId?: string | null;
          body?: string;
          createdAt?: string;
        }[];
      };
      const comments = (show.comments ?? [])
        .filter(
          (c) =>
            c.kind === "agent" &&
            c.threadId === delegation.thread_id &&
            typeof c.body === "string" &&
            c.body.trim().length > 0,
        )
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      for (let i = comments.length - 1; i >= 0; i--) {
        const body = comments[i]?.body;
        if (body && body.trim()) {
          const text = body.trim();
          if (!parseVerdictDetailsFromText(text)) {
            return text;
          }
        }
      }
    }
  } catch {}

  // 2. Fallback to thread output
  try {
    const threadRes = await bbCli.run([
      "thread",
      "output",
      delegation.thread_id,
      "--json",
    ]);
    if (threadRes.exitCode === 0 && threadRes.stdout) {
      const th = JSON.parse(threadRes.stdout) as {
        output?: string | null;
      };
      if (th.output && th.output.trim()) {
        const text = th.output.trim();
        if (!parseVerdictDetailsFromText(text)) {
          return text;
        }
      }
    }
  } catch {}

  return null;
}

function getActiveDelegationForTask(
  task: TaskQueueRow,
  delegations: DelegationRow[],
): DelegationRow | undefined {
  if (delegations.length === 0) return undefined;
  const payload = parsePayload(task.payload);
  const consumed = Array.isArray(payload.consumed_delegations)
    ? (payload.consumed_delegations as number[])
    : [];
  // delegationsByTask returns ORDER BY id DESC (newest first).
  const latest = delegations[0];
  if (!latest) return undefined;
  if (consumed.includes(latest.id)) {
    return undefined;
  }
  // If the latest delegation was created before the task entered the current node,
  // it belongs to an earlier node/attempt and must not be used.
  if (task.entered_at > 0 && latest.created_at < task.entered_at - 50) {
    return undefined;
  }
  return latest;
}

async function extractVerdictFromDelegation(
  taskKey: string,
  delegation: DelegationRow,
  bbCli?: BbCli,
): Promise<{ verdict: "OK" | "CHANGES"; blockers: number; target?: "code" | "design" } | null> {
  if (!bbCli || !delegation.thread_id) return null;

  // 1. Check task comments (only agent comments from this delegation thread)
  try {
    const showRes = await bbCli.run(["tasks", "show", taskKey, "--json"]);
    if (showRes.exitCode === 0 && showRes.stdout) {
      const show = JSON.parse(showRes.stdout) as {
        comments?: {
          kind?: string;
          threadId?: string | null;
          body?: string;
          createdAt?: string;
        }[];
      };
      const comments = (show.comments ?? [])
        .filter(
          (c) =>
            c.kind === "agent" &&
            c.threadId === delegation.thread_id &&
            typeof c.body === "string",
        )
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      for (let i = comments.length - 1; i >= 0; i--) {
        const body = comments[i]?.body;
        if (body) {
          const parsed = parseVerdictDetailsFromText(body);
          if (parsed) return parsed;
        }
      }
    }
  } catch {}

  // 2. §17.3 fallback: reviewer thread's last output (`bb thread output <thread_id> --json`)
  try {
    const threadRes = await bbCli.run(["thread", "output", delegation.thread_id, "--json"]);
    if (threadRes.exitCode === 0 && threadRes.stdout) {
      const th = JSON.parse(threadRes.stdout) as {
        output?: string | null;
      };
      if (th.output) {
        const parsed = parseVerdictDetailsFromText(th.output);
        if (parsed) return parsed;
      }
    }
  } catch {}

  return null;
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
  const latestDelegation = getActiveDelegationForTask(task, delegations);

  if (
    latestDelegation &&
    (latestDelegation.status === "stalled" ||
      latestDelegation.status === "failed" ||
      latestDelegation.status === "quota" ||
      latestDelegation.status === "cancelled")
  ) {
    let failEvent: TransitionEvent | null = null;
    switch (task.node) {
      case "design":
        failEvent = { type: "design_failed", exhausted: true, reason: latestDelegation.status };
        break;
      case "spec":
        failEvent = { type: "spec_failed", exhausted: true, reason: latestDelegation.status };
        break;
      case "spec_review":
        failEvent = { type: "spec_review_failed", exhausted: true, reason: latestDelegation.status };
        break;
      case "code":
        failEvent = { type: "code_failed", exhausted: true, reason: latestDelegation.status };
        break;
      case "review":
        failEvent = { type: "review_failed", exhausted: true, reason: latestDelegation.status };
        break;
      case "design_check":
        failEvent = { type: "design_check_failed", exhausted: true, reason: latestDelegation.status };
        break;
      case "research":
        failEvent = { type: "research_failed", exhausted: true, reason: latestDelegation.status };
        break;
      default:
        failEvent = null;
        break;
    }
    if (!failEvent) return false;

    const resolution = resolveTransition({
      route: task.route,
      node: task.node,
      status: "running",
      event: failEvent,
      mode: task.confirmation_mode,
      counters: extractCounters(task),
    });
    if (!resolution.allowed) return false;
    if (resolution.toNode === task.node && resolution.toStatus === task.status) {
      return false;
    }

    const consumed = Array.isArray(payload.consumed_delegations)
      ? [...(payload.consumed_delegations as number[])]
      : [];
    if (!consumed.includes(latestDelegation.id)) {
      consumed.push(latestDelegation.id);
    }

    const tr = deps.store.transitionTask({
      taskKey: task.task_key,
      expectedNode: task.node,
      expectedStatus: "running",
      toNode: resolution.toNode,
      toStatus: resolution.toStatus,
      actor: "run-queue",
      reason: resolution.reason,
      updates: {
        payload: JSON.stringify({
          ...payload,
          consumed_delegations: consumed,
        }),
      },
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
      if (latestDelegation?.status === "done") {
        contractText = await extractReportFromDelegation(
          task.task_key,
          latestDelegation,
          deps.bbCli,
        );
      }
      if (
        !latestDelegation &&
        !contractText &&
        typeof payload.acceptance_text === "string" &&
        payload.acceptance_text.trim()
      ) {
        contractText = payload.acceptance_text.trim();
      }

      if (contractText && (latestDelegation?.status === "done" || payload.design_done === true)) {
        const resolution = resolveTransition({
          route: task.route,
          node: "design",
          status: "running",
          event: { type: "design_delivered", acceptanceText: contractText },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) return false;

        let accSha = task.acceptance_sha || null;
        if (task.branch) {
          if (!deps.cmd) {
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design",
              expectedStatus: "running",
              toNode: "design",
              toStatus: "stalled",
              actor: "run-queue",
              reason: "git-failed: missing cmd runner for acceptance commit",
            });
            return false;
          }
          try {
            accSha = await commitAcceptanceContract(
              deps.cmd,
              repoRoot,
              task.branch,
              task.task_key,
              contractText,
            );
          } catch (e: any) {
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design",
              expectedStatus: "running",
              toNode: "design",
              toStatus: "stalled",
              actor: "run-queue",
              reason: `git-failed: ${e?.message ?? e}`,
            });
            return false;
          }
        }

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
          consumed.push(latestDelegation.id);
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "design",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: resolution.reason,
          updates: {
            acceptance_sha: accSha,
            payload: JSON.stringify({
              ...payload,
              design_done: false,
              acceptance_text: contractText,
              consumed_delegations: consumed,
              nudge_count: 0,
              last_nudge_at: null,
            }),
          },
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
          }
          return true;
        }
      } else if (latestDelegation?.status === "done" && !contractText) {
        const lastNudge = typeof payload.last_nudge_at === "number" ? payload.last_nudge_at : 0;
        const nudgeCount = typeof payload.nudge_count === "number" ? payload.nudge_count : 0;
        const now = Date.now();

        if (nudgeCount > 0 && now - lastNudge < 60_000) {
          return false;
        }

        if (nudgeCount >= 3) {
          deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "design",
            expectedStatus: "running",
            toNode: "design",
            toStatus: "stalled",
            actor: "run-queue",
            reason: `design-no-report: exhausted ${nudgeCount} nudges without acceptance contract`,
          });
          return false;
        }

        const resolution = resolveTransition({
          route: task.route,
          node: "design",
          status: "running",
          event: { type: "design_question_or_no_report" },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) return false;
        if (latestDelegation?.thread_id && deps.bbCli) {
          await deps.bbCli
            .run([
              "thread",
              "tell",
              latestDelegation.thread_id,
              "Сдай архитектурное решение и текст договора приёмки для docs/specs/acceptance/<KEY>.md",
            ])
            .catch(() => {});
        }
        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "design",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: resolution.reason,
          updates: {
            payload: JSON.stringify({
              ...payload,
              nudge_count: nudgeCount + 1,
              last_nudge_at: now,
            }),
          },
        });
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
        }
        return false;
      }
      return false;
    }

    case "spec": {
      if (latestDelegation?.status === "done" || payload.spec_done === true) {
        const specSha =
          latestDelegation?.result_sha ||
          (typeof payload.spec_sha === "string" ? payload.spec_sha : null) ||
          (!latestDelegation && payload.spec_done ? `sha-spec-${normKey.toLowerCase()}` : null);

        if (!specSha) {
          const lastNudge = typeof payload.last_nudge_at === "number" ? payload.last_nudge_at : 0;
          const nudgeCount = typeof payload.nudge_count === "number" ? payload.nudge_count : 0;
          const now = Date.now();

          if (nudgeCount > 0 && now - lastNudge < 60_000) {
            return false;
          }

          if (nudgeCount >= 3) {
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec",
              expectedStatus: "running",
              toNode: "spec",
              toStatus: "stalled",
              actor: "run-queue",
              reason: `spec-no-report: exhausted ${nudgeCount} nudges without commit`,
            });
            return false;
          }

          const resolution = resolveTransition({
            route: task.route,
            node: "spec",
            status: "running",
            event: { type: "spec_question_or_no_report" },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
          if (!resolution.allowed) return false;
          if (latestDelegation?.thread_id && deps.bbCli) {
            await deps.bbCli
              .run([
                "thread",
                "tell",
                latestDelegation.thread_id,
                "Заверши сдачей коммита документации в docs/ в ветку задачи.",
              ])
              .catch(() => {});
          }
          const updates: Partial<TaskQueueRow> = {
            payload: JSON.stringify({
              ...payload,
              nudge_count: nudgeCount + 1,
              last_nudge_at: now,
            }),
          };
          if (resolution.counterUpdates) {
            Object.assign(updates, resolution.counterUpdates);
          }
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "spec",
            expectedStatus: "running",
            toNode: resolution.toNode,
            toStatus: resolution.toStatus,
            actor: "run-queue",
            reason: resolution.reason,
            updates,
          });
          if (tr.ok) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
          }
          return false;
        }

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

        let filesOutsideDocs = false;
        if (deps.cmd && specSha && !specSha.startsWith("sha-")) {
          try {
            let diffRes = await deps.cmd.run(
              "git",
              ["diff", "--name-only", `${mergeBaseBranch}...${specSha}`],
              { cwd: repoRoot },
            );
            if (diffRes.exitCode !== 0) {
              diffRes = await deps.cmd.run(
                "git",
                ["diff", "--name-only", `${specSha}~1`, specSha],
                { cwd: repoRoot },
              );
            }
            if (diffRes.exitCode === 0) {
              const files = diffRes.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
              filesOutsideDocs = files.some(
                (f) => !f.startsWith("docs/") && !f.endsWith(".md"),
              );
            }
          } catch {}
        }

        const resolution = resolveTransition({
          route: task.route,
          node: "spec",
          status: "running",
          event: {
            type: "spec_delivered",
            specSha,
            acceptanceTampered: tampered,
            filesOutsideDocs,
          },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) return false;

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
          consumed.push(latestDelegation.id);
        }

        const updates: Partial<TaskQueueRow> = {
          spec_sha: specSha,
          payload: JSON.stringify({
            ...payload,
            spec_done: false,
            consumed_delegations: consumed,
            nudge_count: 0,
            last_nudge_at: null,
          }),
        };
        if (resolution.counterUpdates) {
          Object.assign(updates, resolution.counterUpdates);
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "spec",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: resolution.reason,
          updates,
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
          }
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
        const parsed = await extractVerdictFromDelegation(
          task.task_key,
          latestDelegation,
          deps.bbCli,
        );
        if (parsed) {
          verdict = parsed.verdict;
          blockers = parsed.blockers;
        } else {
          const lastNudge = typeof payload.last_nudge_at === "number" ? payload.last_nudge_at : 0;
          const nudgeCount = typeof payload.nudge_count === "number" ? payload.nudge_count : 0;
          const now = Date.now();

          if (nudgeCount > 0 && now - lastNudge < 60_000) {
            return false;
          }

          if (nudgeCount >= 3) {
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec_review",
              expectedStatus: "running",
              toNode: "spec_review",
              toStatus: "stalled",
              actor: "run-queue",
              reason: `no-verdict: exhausted ${nudgeCount} spec_review nudges`,
            });
            return false;
          }

          const resolution = resolveTransition({
            route: task.route,
            node: "spec_review",
            status: "running",
            event: { type: "spec_review_question_or_no_verdict" },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
          if (resolution.allowed) {
            if (latestDelegation?.thread_id && deps.bbCli) {
              await deps.bbCli
                .run([
                  "thread",
                  "tell",
                  latestDelegation.thread_id,
                  'Заверши вердиктом: закончи строкой JSON {"verdict":"OK"|"CHANGES","blockers":<n>}',
                ])
                .catch(() => {});
            }
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec_review",
              expectedStatus: "running",
              toNode: resolution.toNode,
              toStatus: resolution.toStatus,
              actor: "run-queue",
              reason: resolution.reason,
              updates: {
                payload: JSON.stringify({
                  ...payload,
                  nudge_count: nudgeCount + 1,
                  last_nudge_at: now,
                }),
              },
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
            }
          }
          return false;
        }
      }

      if (verdict) {
        const resolution = resolveTransition({
          route: task.route,
          node: "spec_review",
          status: "running",
          event: { type: "spec_review_verdict", verdict, blockers },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) return false;

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
          consumed.push(latestDelegation.id);
        }

        const updates: Partial<TaskQueueRow> = {
          payload: JSON.stringify({
            ...payload,
            spec_review_verdict: null,
            spec_review_blockers: null,
            consumed_delegations: consumed,
            nudge_count: 0,
            last_nudge_at: null,
          }),
        };
        if (resolution.counterUpdates) {
          Object.assign(updates, resolution.counterUpdates);
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "spec_review",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: resolution.reason,
          updates: Object.keys(updates).length > 0 ? updates : undefined,
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
          }
          return true;
        }
      }
      return false;
    }

    case "code": {
      if (latestDelegation?.status === "done" || payload.code_done === true) {
        const resultSha =
          latestDelegation?.result_sha ||
          (typeof payload.result_sha === "string" ? payload.result_sha : null) ||
          (!latestDelegation && payload.code_done ? `sha-code-${normKey.toLowerCase()}` : null);

        if (!resultSha) {
          const lastNudge = typeof payload.last_nudge_at === "number" ? payload.last_nudge_at : 0;
          const nudgeCount = typeof payload.nudge_count === "number" ? payload.nudge_count : 0;
          const now = Date.now();

          if (nudgeCount > 0 && now - lastNudge < 60_000) {
            return false;
          }

          if (nudgeCount >= 3) {
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "code",
              expectedStatus: "running",
              toNode: "code",
              toStatus: "stalled",
              actor: "run-queue",
              reason: `code-no-commits: exhausted ${nudgeCount} nudges without commits`,
            });
            return false;
          }

          const resolution = resolveTransition({
            route: task.route,
            node: "code",
            status: "running",
            event: { type: "code_question_or_no_report" },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
          if (!resolution.allowed) return false;
          if (latestDelegation?.thread_id && deps.bbCli) {
            await deps.bbCli
              .run([
                "thread",
                "tell",
                latestDelegation.thread_id,
                "Заверши сдачей артефакта с коммитом в ветку задачи.",
              ])
              .catch(() => {});
          }
          const tr = deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "code",
            expectedStatus: "running",
            toNode: resolution.toNode,
            toStatus: resolution.toStatus,
            actor: "run-queue",
            reason: resolution.reason,
            updates: {
              payload: JSON.stringify({
                ...payload,
                nudge_count: nudgeCount + 1,
                last_nudge_at: now,
              }),
            },
          });
          if (tr.ok) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
          }
          return false;
        }

        const commits =
          latestDelegation?.result_commits ??
          (typeof payload.result_commits === "number"
            ? payload.result_commits
            : 0);

        const tampered = deps.checkAcceptanceTampered
          ? await deps.checkAcceptanceTampered(task, resultSha)
          : await checkAcceptanceTampered(
              { cmd: deps.cmd, repoRoot },
              task,
              resultSha,
            );

        const resolution = resolveTransition({
          route: task.route,
          node: "code",
          status: "running",
          event: {
            type: "code_delivered",
            resultSha,
            commits,
            noCode: Boolean(payload.no_code),
            acceptanceTampered: tampered,
          },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) return false;

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
          consumed.push(latestDelegation.id);
        }

        const updates: Partial<TaskQueueRow> = {
          result_sha: resultSha,
          payload: JSON.stringify({
            ...payload,
            code_done: false,
            result_commits: null,
            acceptance_tampered: false,
            consumed_delegations: consumed,
            nudge_count: 0,
            last_nudge_at: null,
          }),
        };
        if (resolution.counterUpdates) {
          Object.assign(updates, resolution.counterUpdates);
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "code",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: resolution.reason,
          updates,
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
          }
          return true;
        }
      }
      return false;
    }

    case "checks": {
      const checkResult = deps.runChecks
        ? await deps.runChecks(task)
        : await executeChecks({ cmd: deps.cmd, repoRoot }, task);

      const resolution = resolveTransition({
        route: task.route,
        node: "checks",
        status: "running",
        event: {
          type: "checks_result",
          exitCode: checkResult.exitCode,
          notRun: checkResult.notRun,
          output: checkResult.output,
        },
        mode: task.confirmation_mode,
        counters: extractCounters(task),
      });
      if (!resolution.allowed) return false;

      const updates: Partial<TaskQueueRow> = {
        payload: JSON.stringify({
          ...payload,
          code_done: false,
          checks_fail: false,
        }),
      };
      if (resolution.counterUpdates) {
        Object.assign(updates, resolution.counterUpdates);
      }

      const tr = deps.store.transitionTask({
        taskKey: task.task_key,
        expectedNode: "checks",
        expectedStatus: "running",
        toNode: resolution.toNode,
        toStatus: resolution.toStatus,
        actor: "run-queue",
        reason: resolution.reason,
        updates,
      });
      if (tr.ok && tr.task) {
        const logged = deps.store.listTransitions(task.task_key).at(-1);
        if (logged) transitions.push(logged);
        if (resolution.action?.dispatchNode) {
          await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
        }
        return true;
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
        const parsed = await extractVerdictFromDelegation(
          task.task_key,
          latestDelegation,
          deps.bbCli,
        );
        if (parsed) {
          verdict = parsed.verdict;
          blockers = parsed.blockers;
        } else {
          const lastNudge = typeof payload.last_nudge_at === "number" ? payload.last_nudge_at : 0;
          const nudgeCount = typeof payload.nudge_count === "number" ? payload.nudge_count : 0;
          const now = Date.now();

          if (nudgeCount > 0 && now - lastNudge < 60_000) {
            return false;
          }

          if (nudgeCount >= 3) {
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "review",
              expectedStatus: "running",
              toNode: "review",
              toStatus: "stalled",
              actor: "run-queue",
              reason: `no-verdict: exhausted ${nudgeCount} review nudges`,
            });
            return false;
          }

          const resolution = resolveTransition({
            route: task.route,
            node: "review",
            status: "running",
            event: { type: "review_question_or_no_verdict" },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
          if (resolution.allowed) {
            if (latestDelegation?.thread_id && deps.bbCli) {
              await deps.bbCli
                .run([
                  "thread",
                  "tell",
                  latestDelegation.thread_id,
                  'Заверши вердиктом: закончи строкой JSON {"verdict":"OK"|"CHANGES","blockers":<n>}',
                ])
                .catch(() => {});
            }
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "review",
              expectedStatus: "running",
              toNode: resolution.toNode,
              toStatus: resolution.toStatus,
              actor: "run-queue",
              reason: resolution.reason,
              updates: {
                payload: JSON.stringify({
                  ...payload,
                  nudge_count: nudgeCount + 1,
                  last_nudge_at: now,
                }),
              },
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
            }
          }
          return false;
        }
      }

      if (verdict) {
        const resolution = resolveTransition({
          route: task.route,
          node: "review",
          status: "running",
          event: { type: "review_verdict", verdict, blockers },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) return false;

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
          consumed.push(latestDelegation.id);
        }

        const updates: Partial<TaskQueueRow> = {
          payload: JSON.stringify({
            ...payload,
            review_verdict: null,
            review_blockers: null,
            consumed_delegations: consumed,
            nudge_count: 0,
            last_nudge_at: null,
          }),
        };
        if (resolution.counterUpdates) {
          Object.assign(updates, resolution.counterUpdates);
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "review",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: resolution.reason,
          updates: Object.keys(updates).length > 0 ? updates : undefined,
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
          }
          return true;
        }
      }
      return false;
    }

    case "design_check": {
      let verdict: "OK" | "CHANGES" | null = null;
      let target: "code" | "design" = "code";
      let blockers = 0;
      if (typeof payload.design_check_verdict === "string") {
        verdict =
          payload.design_check_verdict === "CHANGES" ? "CHANGES" : "OK";
        if (payload.design_check_target === "design") target = "design";
        blockers = Number(payload.design_check_blockers) || 0;
      } else if (latestDelegation?.status === "done") {
        const parsed = await extractVerdictFromDelegation(
          task.task_key,
          latestDelegation,
          deps.bbCli,
        );
        if (parsed) {
          verdict = parsed.verdict;
          blockers = parsed.blockers;
          if (parsed.target === "design") target = "design";
        } else {
          const lastNudge = typeof payload.last_nudge_at === "number" ? payload.last_nudge_at : 0;
          const nudgeCount = typeof payload.nudge_count === "number" ? payload.nudge_count : 0;
          const now = Date.now();

          if (nudgeCount > 0 && now - lastNudge < 60_000) {
            return false;
          }

          if (nudgeCount >= 3) {
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design_check",
              expectedStatus: "running",
              toNode: "design_check",
              toStatus: "stalled",
              actor: "run-queue",
              reason: `no-verdict: exhausted ${nudgeCount} design_check nudges`,
            });
            return false;
          }

          const resolution = resolveTransition({
            route: task.route,
            node: "design_check",
            status: "running",
            event: { type: "design_check_question_or_no_verdict" },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
          if (resolution.allowed) {
            if (latestDelegation?.thread_id && deps.bbCli) {
              await deps.bbCli
                .run([
                  "thread",
                  "tell",
                  latestDelegation.thread_id,
                  'Заверши вердиктом: закончи строкой JSON {"verdict":"OK"|"CHANGES","blockers":<n>}',
                ])
                .catch(() => {});
            }
            const tr = deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design_check",
              expectedStatus: "running",
              toNode: resolution.toNode,
              toStatus: resolution.toStatus,
              actor: "run-queue",
              reason: resolution.reason,
              updates: {
                payload: JSON.stringify({
                  ...payload,
                  nudge_count: nudgeCount + 1,
                  last_nudge_at: now,
                }),
              },
            });
            if (tr.ok) {
              const logged = deps.store.listTransitions(task.task_key).at(-1);
              if (logged) transitions.push(logged);
            }
          }
          return false;
        }
      }

      if (verdict) {
        const resolution = resolveTransition({
          route: task.route,
          node: "design_check",
          status: "running",
          event: { type: "design_check_verdict", verdict, blockers, target },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) return false;

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
          consumed.push(latestDelegation.id);
        }

        const updates: Partial<TaskQueueRow> = {
          payload: JSON.stringify({
            ...payload,
            design_check_verdict: null,
            design_check_blockers: null,
            design_check_target: null,
            consumed_delegations: consumed,
            nudge_count: 0,
            last_nudge_at: null,
          }),
        };
        if (resolution.counterUpdates) {
          Object.assign(updates, resolution.counterUpdates);
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "design_check",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: resolution.reason,
          updates: Object.keys(updates).length > 0 ? updates : undefined,
        });
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
          }
          return true;
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

      if (relStatus) {
        let event: TransitionEvent;
        if (relStatus === "published") {
          event = { type: "release_published", prMode: false };
        } else if (relStatus === "pr_open") {
          event = { type: "release_published", prMode: true };
        } else if (relStatus === "failed") {
          event = {
            type: "release_failed_checks_conflict_reject",
            reason: relError ?? "publish failed",
          };
        } else if (relStatus === "stalled") {
          if (relError?.includes("uncommitted-kb")) {
            event = { type: "release_refused_kb" };
          } else if (relError?.includes("unmerged-ui")) {
            event = { type: "release_refused_ui" };
          } else {
            event = { type: "release_failed_script", reason: relError };
          }
        } else {
          event = { type: "release_waiting_note" };
        }

        const resolution = resolveTransition({
          route: task.route,
          node: "release",
          status: "running",
          event,
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) return false;

        const updates: Partial<TaskQueueRow> = {};
        if (resolution.counterUpdates) {
          Object.assign(updates, resolution.counterUpdates);
        }
        if (pubSha) {
          updates.result_sha = pubSha;
        }
        if (relStatus === "failed") {
          updates.payload = JSON.stringify({
            ...payload,
            code_done: false,
            release_status: null,
          });
        }

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "release",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: resolution.reason,
          updates: Object.keys(updates).length > 0 ? updates : undefined,
        });
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.toStatus === "done" && deps.bbCli) {
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
          if (resolution.action?.dispatchNode && tr.task) {
            await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
          }
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
        const report =
          (latestDelegation
            ? await extractReportFromDelegation(
                task.task_key,
                latestDelegation,
                deps.bbCli,
              )
            : null) ||
          (typeof payload.research_report === "string"
            ? payload.research_report
            : "done");

        const resolution = resolveTransition({
          route: task.route,
          node: "research",
          status: "running",
          event: { type: "research_delivered", report },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) return false;

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
          consumed.push(latestDelegation.id);
        }

        const updates: Partial<TaskQueueRow> = {
          payload: JSON.stringify({
            ...payload,
            research_report: report,
            consumed_delegations: consumed,
          }),
        };

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "research",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: resolution.reason,
          updates,
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
