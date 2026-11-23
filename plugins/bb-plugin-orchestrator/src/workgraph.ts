/**
 * Orchestrator r34 task work graph (§27, §28, §32 and ADR-0032).
 * Slice 5a: task_queue, task_transitions, CAS transitions, workGraph modes,
 * queue CLI commands (enqueue, dequeue, defer, reject, resume, approve,
 * release-note, run-queue) and owner-only guards.
 */
import fs, { existsSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchestratorError } from "./errors.js";
import type { CmdRunner } from "./cmd.js";
import { createBbCli, type BbCli } from "./bb-cli.js";
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
import {
  ACTIVE_ALARM_NODES,
  PASSIVE_ALARM_STATUSES,
  normalizeTaskKey,
} from "./store.js";
import { verdictDetailsInBody } from "./release.js";
import {
  verifySpecBeforeCodeGate,
  resolveExecutorBaseSha,
  resolvePresetBaseBranch,
  resolveTaskSpecContract,
  parseContractFromText,
  type SpecContract,
} from "./spec-gate.js";
import {
  checkRouteLimits,
  type RouteLimitsCheckResult,
} from "./route-limits.js";
import {
  verifySpecReferences,
  type SpecReferenceCheckResult,
} from "./spec-check.js";
import type { PluginCliContext } from "@get-bb/plugin-sdk";
import type { T } from "./i18n/index.js";
import type { ResolvedProject } from "./release-config.js";
import {
  getNodeTimeoutSeconds,
  getNodeMaxRetries,
  type Policy,
  type PolicyChecksConfig,
} from "./policy.js";
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

import {
  type WorkGraphMode,
  normalizeWorkGraphMode,
  parseWorkGraphProjects,
  resolveWorkGraphMode,
  computeEffectiveWorkGraphMode,
  shouldShowApprovalMenu,
} from "./workgraph-mode.js";

export {
  type WorkGraphMode,
  normalizeWorkGraphMode,
  parseWorkGraphProjects,
  resolveWorkGraphMode,
  computeEffectiveWorkGraphMode,
  shouldShowApprovalMenu,
};

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
    if (pLevel?.role === "architect") return "architect";
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

export interface TaskTrackerResult {
  task?: {
    projectId?: string | null;
    project?: { id?: string | null; linkedBbProjectId?: string | null } | null;
    [key: string]: unknown;
  } | null;
  projectId?: string | null;
  project?: { id?: string | null; linkedBbProjectId?: string | null } | null;
  [key: string]: unknown;
}

export interface TaskTrackerLike {
  getTask(taskKey: string):
    | Promise<TaskTrackerResult | null>
    | TaskTrackerResult
    | null;
}

export type TaskTrackerOrOptions =
  | TaskTrackerLike
  | {
      tracker?: TaskTrackerLike | null;
      bbCli?: BbCli | null;
      cmd?: CmdRunner | null;
      onConflict?: "recover" | "refuse";
      log?: { warn?: (msg: string) => void };
    }
  | null;

function extractProjectIdFromRecord(res: any): string | null {
  if (!res || typeof res !== "object") return null;
  const taskObj = res.task ?? res;
  const projObj = res.project ?? taskObj.project;
  const pid =
    projObj?.linkedBbProjectId ??
    taskObj.projectId ??
    projObj?.id;
  if (typeof pid === "string" && pid.trim()) {
    return pid.trim();
  }
  return null;
}

/**
 * §32.2 п.2 (PLUG-361): Task Project Resolution strictly in order:
 * 1) task_queue: project_id column (or payload.project_id);
 * 2) delegations: project_id column from active or latest completed delegation;
 * 3) tracker: metadata query via tracker API bb tasks / tracker.getTask(taskKey) -> task.projectId.
 */
export async function resolveTaskProjectId(
  store: DelegationStore,
  taskKey: string,
  options?: TaskTrackerOrOptions,
): Promise<string | null> {
  const key = normalizeTaskKey(taskKey);

  // 1) task_queue: project_id column or payload.project_id
  const task = store.getTask(key);
  if (task) {
    if (task.project_id && task.project_id.trim()) {
      return task.project_id.trim();
    }
    const payload = parsePayload(task.payload);
    if (typeof payload.project_id === "string" && payload.project_id.trim()) {
      return payload.project_id.trim();
    }
  }

  // 2) delegations: active delegation in-flight strictly wins
  const active = store.activeByTaskKey?.(key);
  if (active?.project_id && active.project_id.trim()) {
    return active.project_id.trim();
  }

  // Check for historical completed delegation
  const done = store.latestDoneResultByTask?.(key);
  let donePid = done?.project_id?.trim();
  if (!donePid) {
    const all = store.delegationsByTask?.(key);
    if (all && all.length > 0) {
      for (const d of all) {
        if (d.status === "done" && d.project_id && d.project_id.trim()) {
          donePid = d.project_id.trim();
          break;
        }
      }
    }
  }

  // 3) tracker: metadata via tracker API bb tasks / tracker.getTask(taskKey)
  let tracker: TaskTrackerLike | undefined | null;
  let bbCli: BbCli | undefined | null;
  let cmd: CmdRunner | undefined | null;
  let onConflict: "recover" | "refuse" | undefined;
  let log: { warn?: (msg: string) => void } | undefined;
  if (options) {
    if ("getTask" in options && typeof (options as any).getTask === "function") {
      tracker = options as TaskTrackerLike;
    } else {
      const opts = options as {
        tracker?: TaskTrackerLike | null;
        bbCli?: BbCli | null;
        cmd?: CmdRunner | null;
        onConflict?: "recover" | "refuse";
        log?: { warn?: (msg: string) => void };
      };
      tracker = opts.tracker;
      bbCli = opts.bbCli;
      cmd = opts.cmd;
      onConflict = opts.onConflict;
      log = opts.log;
    }
  }

  let trackerPid: string | null = null;
  if (tracker) {
    try {
      const res = await tracker.getTask(key);
      trackerPid = extractProjectIdFromRecord(res);
    } catch {}
  } else if (bbCli) {
    try {
      const res = await bbCli.run(["tasks", "show", key, "--json"], { timeoutMs: 5000 });
      if (res.exitCode === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout);
        trackerPid = extractProjectIdFromRecord(parsed);
      }
    } catch {}
  } else if (cmd) {
    try {
      const res = await cmd.run("bb", ["tasks", "show", key, "--json"], { timeoutMs: 5000 });
      if (res.exitCode === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout);
        trackerPid = extractProjectIdFromRecord(parsed);
      }
    } catch {}
  } else if (typeof process !== "undefined" && process.env?.PATH) {
    try {
      const defaultCli = createBbCli();
      const res = await defaultCli.run(["tasks", "show", key, "--json"], { timeoutMs: 5000 });
      if (res.exitCode === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout);
        trackerPid = extractProjectIdFromRecord(parsed);
      }
    } catch {}
  }

  // Conflict handling: historical done delegation vs tracker
  if (trackerPid) {
    if (donePid && donePid !== trackerPid) {
      if (onConflict === "refuse") {
        throw new OrchestratorError(
          "task-project-conflict",
          `task-project-conflict: задача ${key} имеет проект ${donePid} в истории завершённых делегирований, но трекер задач указывает проект ${trackerPid}`,
          `Укажите проект задачи явно или поставьте задачу в очередь через bb orchestrator enqueue`,
        );
      }
      // Standard recovery: tracker is the authoritative system of record
      log?.warn?.(
        `orchestrator: task ${key} project conflict: historical delegation has ${donePid}, tracker has ${trackerPid}; recovering to tracker project ${trackerPid}`,
      );
      try {
        store.healTaskProject?.(key, trackerPid);
      } catch {}
    }
    return trackerPid;
  }

  if (donePid) {
    return donePid;
  }

  return null;
}

export interface DirectActionOptions {
  command?: "delegate" | "merge" | "release";
  level?: string;
  route?: string;
  actor?: string;
  policy?: Policy | null;
  projectId?: string | null;
  projectsMap?: Record<string, WorkGraphMode>;
  getWorkGraphMode?: (projectId?: string | null) => WorkGraphMode;
  tracker?: TaskTrackerLike | null;
  bbCli?: BbCli | null;
  cmd?: CmdRunner | null;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

/** §32 п.1 + §32.2 (PLUG-361): In strict mode, blocks direct delegate, merge, release. In shadow mode, logs mirror audit. In off mode, silent. */
export async function assertGraphAllowsDirectAction(
  store: DelegationStore,
  taskKey: string,
  mode: WorkGraphMode | ((projectId?: string | null) => WorkGraphMode),
  action?: DirectActionOptions,
): Promise<void> {
  const key = normalizeTaskKey(taskKey);

  // 1. Determine global mode
  const globalMode: WorkGraphMode =
    typeof mode === "function" ? mode(undefined) : normalizeWorkGraphMode(mode);

  // 2. Resolve task projectId using 3-step order
  const projectId = await resolveTaskProjectId(store, key, {
    tracker: action?.tracker,
    bbCli: action?.bbCli,
    cmd: action?.cmd,
  });

  let effectiveMode: WorkGraphMode;
  if (!projectId) {
    effectiveMode = globalMode;
    const warnMsg = `orchestrator: task ${key} project undetermined; falling back to global workGraph mode (${globalMode})`;
    if (action?.log?.warn) {
      action.log.warn(warnMsg);
    } else {
      console.warn(warnMsg);
    }
  } else {
    if (typeof mode === "function") {
      effectiveMode = mode(projectId);
    } else if (action?.getWorkGraphMode) {
      effectiveMode = action.getWorkGraphMode(projectId);
    } else if (action?.projectsMap) {
      effectiveMode = resolveWorkGraphMode(
        projectId,
        globalMode,
        action.projectsMap,
      );
    } else {
      effectiveMode = globalMode;
    }
  }

  // 3. Complete silence for 'off' mode: 0 transitions, recordShadowAction not called
  if (effectiveMode === "off") {
    return;
  }

  // 4. In shadow mode, mirror coordinator manual action
  if (effectiveMode === "shadow") {
    try {
      recordShadowAction(
        store,
        {
          command: action?.command ?? "delegate",
          taskKey: key,
          level: action?.level,
          route: action?.route,
          actor: action?.actor ?? "shadow:coordinator",
          policy: action?.policy,
        },
        effectiveMode,
      );
    } catch {}
    return;
  }

  // 5. In strict mode, block direct delegate, merge, release outside queue
  if (effectiveMode === "strict") {
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
    cmd?: CmdRunner;
    bbCli?: BbCli;
    ctx: PluginCliContext;
    workGraphMode: WorkGraphMode;
    projectId?: string | null;
    tracker?: TaskTrackerLike | null;
    repoRoot?: string;
    mergeBaseBranch?: string;
    now?: () => number;
    hasChecksCommands?: boolean;
    approvalMode?: "auto" | "manual" | null;
    policy?: Policy;
    log?: { warn?: (msg: string) => void };
    runTddCheck?: (
      task: TaskQueueRow,
      acceptanceSha: string | null,
    ) => Promise<TddVerificationResult>;
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

  // §29.2 п.1 + §29.4: flag --mode restricted to owner
  if (input.mode !== undefined) {
    if (input.mode !== "auto" && input.mode !== "manual") {
      throw new OrchestratorError(
        "invalid-arguments",
        "флаг --mode принимает только auto или manual",
      );
    }
    if (!isOwner) {
      throw new OrchestratorError(
        "permission-denied",
        "owner-only: --mode flag is restricted to owner",
      );
    }
  }

  // §29.3 + §29.4: --acceptance restricted to owner
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

  // §34.7 (ADR-0037): Canonical approvalMode name; confirmation_mode is deprecated
  if ((input as any).confirmation_mode !== undefined) {
    if (deps.log?.warn) {
      deps.log.warn(
        "[orchestrator] confirmation-mode-deprecated: use approvalMode (--mode) instead",
      );
    } else {
      console.warn(
        "[orchestrator] confirmation-mode-deprecated: use approvalMode (--mode) instead",
      );
    }
    if (
      !input.mode &&
      ((input as any).confirmation_mode === "auto" ||
        (input as any).confirmation_mode === "manual")
    ) {
      input.mode = (input as any).confirmation_mode;
    }
  }

  // §29.3: Confirmation mode resolution
  // 1) Explicit flag --mode auto|manual passed by human (owner)
  // 2) If orchestrator.approvalMode project setting is set (non-null 'auto' | 'manual'), apply to all tasks
  // 3) Fallback when approvalMode is null:
  //    - human without --mode: 'manual' for feature, 'auto' for fix/simple/docs/research
  //    - agent (BB_THREAD_ID present): 'manual' for feature, 'auto' for fix/simple/docs/research
  let confirmationMode: ConfirmationMode;
  if (isOwner && (input.mode === "auto" || input.mode === "manual")) {
    confirmationMode = input.mode;
  } else if (deps.approvalMode === "auto" || deps.approvalMode === "manual") {
    confirmationMode = deps.approvalMode;
  } else {
    confirmationMode = route === "feature" ? "manual" : "auto";
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
      let existingPayload: Record<string, unknown> = {};
      try {
        if (existing.payload) existingPayload = JSON.parse(existing.payload);
      } catch {}
      const gateStage = existingPayload.gate_stage;

      // §31.5: for feature route OR at owner_gate pre_release, acceptance contract is immutable
      if (acceptanceText) {
        if (existing.route === "feature" || gateStage === "pre_release") {
          throw new OrchestratorError(
            "acceptance-contract-immutable",
            existing.route === "feature"
              ? "для маршрута feature договор формируется и изменяется исключительно архитектором на узле design через reject --target design"
              : "договор приёмки неизменяем на этапе pre_release",
          );
        }
      }

      // Check exception for owner updating acceptance at owner_gate (§31.5, §32 п.2, §34.5)
      if (
        (existing.route === "fix" || existing.route === "simple") &&
        existing.node === "owner_gate" &&
        (existing.status === "waiting_approval" || existing.status === "deferred") &&
        gateStage !== "pre_release" &&
        acceptanceText
      ) {
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
            deps.store.updateTask(taskKey, {
              acceptance_sha: accSha,
              branch: existing.branch,
            });
          } catch (e: any) {
            throw new OrchestratorError(
              "git-failed",
              `не удалось закоммитить обновлённый договор приёмки: ${e?.message ?? e}`,
            );
          }
        }

        // §34.5 (ADR-0037): TDD fail-first verification on owner_gate upon enqueue --acceptance
        if (accSha) {
          const tdd = deps.runTddCheck
            ? await deps.runTddCheck(existing, accSha)
            : await runTddFailFirstVerification(
                { cmd: deps.cmd, repoRoot },
                { ...existing, acceptance_sha: accSha, payload: JSON.stringify(existingPayload) },
                accSha,
                DEFAULT_ALLOWED_RUNNERS,
                deps.policy?.checks,
              );

          if (tdd.notRun) {
            throw new OrchestratorError(
              "tdd-check-not-run",
              `проверка договора не смогла запуститься: ${tdd.output}`,
            );
          }

          if (!tdd.failedAsExpected) {
            const vacuousTr = resolveTransition({
              route: existing.route,
              node: "owner_gate",
              status: existing.status,
              event: {
                type: "acceptance_vacuous",
                reason:
                  "acceptance-contract-vacuous: договор приёмки уже полностью проходит на неизменённом коде",
              },
              mode: existing.confirmation_mode,
              counters: extractCounters(existing),
            });
            if (vacuousTr.allowed) {
              delete (existingPayload as any).queued_stalled;
              delete (existingPayload as any).queued_stalled_alarm_at;
              const updates: Partial<TaskQueueRow> = {
                acceptance_sha: accSha,
                deferred_by: null,
                deferred_reason: null,
                payload: JSON.stringify({
                  ...existingPayload,
                  ...(vacuousTr.action?.setPayload ?? {}),
                }),
              };
              if (vacuousTr.counterUpdates) {
                Object.assign(updates, vacuousTr.counterUpdates);
              }
              const res = deps.store.transitionTask(
                {
                  taskKey,
                  expectedNode: "owner_gate",
                  expectedStatus: existing.status,
                  toNode: vacuousTr.toNode,
                  toStatus: vacuousTr.toStatus,
                  actor: "machine:checks",
                  reason: vacuousTr.reason,
                  updates,
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
          }

          // §34.5 / Reviewer Б1-в: Record TDD verification outcome in task payload
          existingPayload.tdd_outcome = tdd.outcome;
          if (tdd.newTestFiles && tdd.newTestFiles.length > 0) {
            existingPayload.tdd_new_tests = tdd.newTestFiles;
          }
          if (tdd.commands && tdd.commands.length > 0) {
            existingPayload.tdd_commands = tdd.commands;
          }
          existingPayload.tdd_output = tdd.output;
          const checksRun = ((existingPayload.checks_run as Record<string, unknown>) || {});
          checksRun.tdd = {
            outcome: tdd.outcome,
            new_tests: tdd.newTestFiles ?? [],
            commands: tdd.commands ?? [],
            output: tdd.output,
          };
          existingPayload.checks_run = checksRun;
        }

        delete existingPayload.vacuous_contract;

        const resolution = resolveTransition({
          route: existing.route,
          node: "owner_gate",
          status: existing.status,
          event: {
            type: "owner_enqueue_acceptance",
            isOwner: true,
            acceptanceText,
          },
          mode: existing.confirmation_mode,
          counters: extractCounters(existing),
          gateStage:
            gateStage === "pre_code" || gateStage === "pre_release"
              ? gateStage
              : undefined,
        });
        if (!resolution.allowed) {
          throw new OrchestratorError(
            resolution.errorCode ?? "transition-failed",
            resolution.errorMessage ?? resolution.reason,
          );
        }

        const res = deps.store.transitionTask(
          {
            taskKey,
            expectedNode: "owner_gate",
            expectedStatus: existing.status,
            toNode: resolution.toNode,
            toStatus: resolution.toStatus,
            actor: "owner",
            reason: resolution.reason,
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
      if (deps.cmd) {
        await checkAndPrepareTaskBranch(
          deps.cmd,
          deps.repoRoot ?? process.cwd(),
          branch,
          taskKey,
          deps.mergeBaseBranch ?? "main",
          Boolean(input.forceResetBranch),
          prNumber,
        );
      }
    }
  }

  const dependsOn = input.dependsOn
    ? input.dependsOn.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const payload = acceptanceText ? JSON.stringify({ acceptance_text: acceptanceText }) : null;

  const queueStallMinutes =
    deps.policy?.timing?.queueStallMinutes ?? 30;
  const initialNodeAlarmAt = now + queueStallMinutes * 60_000;

  const targetProjectId =
    (deps.projectId && deps.projectId.trim()) ||
    (await resolveTaskProjectId(deps.store, taskKey, {
      bbCli: deps.bbCli,
      cmd: deps.cmd,
      tracker: deps.tracker,
    })) ||
    (deps.ctx.projectId && deps.ctx.projectId.trim()) ||
    "";

  if (existing) {
    // Reissue / reset
    const task = deps.store.resetTaskForEnqueue(
      {
        taskKey,
        projectId: targetProjectId || existing.project_id,
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
    deps.store.updateTask(taskKey, { node_alarm_at: initialNodeAlarmAt });
    task.node_alarm_at = initialNodeAlarmAt;
    return { ok: true, task, reissued: true };
  }

  // New task insert
  const task = deps.store.insertTask(
    {
      taskKey,
      projectId: targetProjectId,
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
  deps.store.updateTask(taskKey, { node_alarm_at: initialNodeAlarmAt });
  task.node_alarm_at = initialNodeAlarmAt;
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
        interaction_id: null,
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
    let gateStage: "pre_code" | "pre_release" | undefined;
    try {
      if (task.payload) {
        const p = JSON.parse(task.payload);
        if (p.gate_stage === "pre_code" || p.gate_stage === "pre_release") {
          gateStage = p.gate_stage;
        }
      }
    } catch {}

    const tgt = target as TaskNode | undefined;
    const resolution = resolveTransition({
      route: task.route,
      node: "owner_gate",
      status: task.status,
      event: { type: "owner_reject", isOwner: true, target: tgt, reason: reason! },
      mode: task.confirmation_mode,
      counters: extractCounters(task),
      gateStage,
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

    const updates: Partial<TaskQueueRow> = {
      payload: JSON.stringify(rejectPayload),
      interaction_id: null,
    };
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
    if (resolution.toNode === "spec" || resolution.toNode === "design" || target === "spec" || target === "design") {
      deps.store.revokeSpecContractApproval(key, now);
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
    if (resolution.toNode === "spec" || resolution.toNode === "design") {
      deps.store.revokeSpecContractApproval(key, now);
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
    dispatchNode?: (
      task: TaskQueueRow,
      node: TaskNode,
    ) => Promise<{ ok: boolean; delegationId?: number; error?: string } | void>;
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
      if (res.task && resolution.action?.dispatchNode && deps.dispatchNode) {
        await deps.dispatchNode(res.task, resolution.action.dispatchNode);
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
    if (res.task && resolution.action?.dispatchNode && deps.dispatchNode) {
      await deps.dispatchNode(res.task, resolution.action.dispatchNode);
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
    if (res.task && resolution.action?.dispatchNode && deps.dispatchNode) {
      await deps.dispatchNode(res.task, resolution.action.dispatchNode);
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
      event: { type: "resume", isOwner: true, prevStatus },
      mode: task.confirmation_mode,
      counters: extractCounters(task),
    });

    const res = deps.store.transitionTask(
      {
        taskKey: key,
        expectedNode: task.node,
        expectedStatus: "deferred",
        toNode: resolution.toNode,
        toStatus: resolution.toStatus,
        actor: "owner",
        reason: "resume",
        now,
        updates: {
          deferred_by: null,
          deferred_reason: null,
          payload: JSON.stringify(parsedPayload),
          interaction_id: null,
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
    if (res.task && resolution.action?.dispatchNode && deps.dispatchNode) {
      await deps.dispatchNode(res.task, resolution.action.dispatchNode);
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

  let gateStage: "pre_code" | "pre_release" | undefined;
  let payloadObj: Record<string, unknown> = {};
  try {
    if (task.payload) {
      payloadObj = JSON.parse(task.payload);
      if (payloadObj.gate_stage === "pre_code" || payloadObj.gate_stage === "pre_release") {
        gateStage = payloadObj.gate_stage as "pre_code" | "pre_release";
      }
    }
  } catch {}

  // §34.5 (ADR-0037): Reject approval if acceptance contract is vacuous
  if (gateStage === "pre_code" && payloadObj.vacuous_contract) {
    throw new OrchestratorError(
      "acceptance-contract-vacuous",
      "договор приёмки уже полностью проходит на неизменённом коде (acceptance-contract-vacuous); обновите договор через enqueue --acceptance перед одобрением",
    );
  }

  const resolution = resolveTransition({
    route: task.route,
    node: task.node,
    status: task.status,
    event: { type: "owner_approve", isOwner: isOwnerCalling(deps.ctx), comment },
    mode: task.confirmation_mode,
    counters: extractCounters(task),
    gateStage,
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

  let approvedContract = resolveTaskSpecContract(key, deps.store, payloadObj, { task: res.task! });
  if (
    !approvedContract ||
    !approvedContract.specPath ||
    approvedContract.specPath.includes("/acceptance/")
  ) {
    const targetSha = res.task?.spec_sha ?? task.spec_sha;
    const proj = task.project_id && (deps as any).resolveProject
      ? await Promise.resolve((deps as any).resolveProject(task.project_id)).catch(() => null)
      : (deps as any).project ?? null;
    const repoRoot = deps.ctx?.cwd ?? proj?.repoPath ?? proj?.repoRoot ?? process.cwd();
    if (targetSha && !targetSha.startsWith("sha-") && repoRoot) {
      try {
        const cmdRunner = (deps as any).cmd ?? {
          run: async (file: string, args: string[], opts?: any) => {
            const { execFileSync } = await import("node:child_process");
            try {
              const stdout = execFileSync(file, args, { cwd: opts?.cwd, encoding: "utf8" });
              return { exitCode: 0, stdout, stderr: "" };
            } catch (e: any) {
              return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
            }
          },
        };
        const diffRes = await cmdRunner.run(
          "git",
          ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", targetSha],
          { cwd: repoRoot },
        );
        if (diffRes.exitCode === 0) {
          const files = diffRes.stdout.split("\n").map((s: string) => s.trim()).filter(Boolean);
          const specFiles = files.filter(
            (f: string) => f.startsWith("docs/specs/") && f.endsWith(".md") && !f.includes("/acceptance/"),
          );
          if (specFiles.length === 0) {
            specFiles.push(...files.filter((f: string) => f.startsWith("docs/") && f.endsWith(".md") && !f.startsWith("docs/adr/")));
          }
          const adrFiles = files.filter((f: string) => f.startsWith("docs/adr/") && f.endsWith(".md"));
          const isArch = Boolean(adrFiles.length > 0 || approvedContract?.isArchitectural);
          if (specFiles.length > 0 || adrFiles.length > 0) {
            approvedContract = {
              ...(approvedContract ?? { kind: "behavior_change" }),
              specPath: specFiles.join(", ") || approvedContract?.specPath,
              specSha: targetSha,
              adrPath: adrFiles.join(", ") || approvedContract?.adrPath,
              isArchitectural: isArch,
            };
          }
        }
      } catch {}
    }
  }

  if (approvedContract) {
    if (approvedContract.kind === "mechanical") {
      const approvalId = `appr:${task.project_id ?? "proj"}:${key}:mech:${now}`;
      deps.store.saveSpecContract(
        {
          ...approvedContract,
          taskKey: key,
          projectId: task.project_id ?? undefined,
          approvalId,
        },
        now,
      );
      payloadObj.approval_id = approvalId;
      deps.store.updateTask(key, { payload: JSON.stringify(payloadObj) });
    } else {
      let specSha: string | undefined =
        (res.task!.spec_sha ||
        task.spec_sha ||
        approvedContract.specSha ||
        (payloadObj?.spec_sha ?? payloadObj?.specSha) ||
        task.acceptance_sha) as string | undefined;
      if (!specSha || specSha === "base") {
        const tRepo = (deps as any).resolveTaskRepoContext
          ? await Promise.resolve((deps as any).resolveTaskRepoContext(task)).catch(() => null)
          : null;
        const proj = task.project_id && (deps as any).resolveProject
          ? await Promise.resolve((deps as any).resolveProject(task.project_id)).catch(() => null)
          : (deps as any).project ?? null;
        const repoRoot = tRepo?.repoRoot ?? proj?.repoPath ?? proj?.repoRoot ?? deps.ctx?.cwd;
        const cmdRunner = (deps as any).cmd ?? (deps.ctx as any)?.cmd;
        if (cmdRunner && repoRoot) {
          try {
            const r = await cmdRunner.run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
            if (r.exitCode === 0 && r.stdout.trim().length === 40) {
              specSha = r.stdout.trim();
            }
          } catch {}
        }
      }
      if (!specSha || specSha === "base") {
        const cmdRunner = (deps as any).cmd ?? (deps.ctx as any)?.cmd;
        if (!cmdRunner || deps.workGraphMode === "shadow") {
          specSha = `sha-${key.toLowerCase()}-${now}`;
        } else {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: не удалось определить коммит спецификации (spec_sha) для задачи ${key}`,
          );
        }
      }
      const approvalId = `appr:${task.project_id ?? "proj"}:${key}:${specSha}:${now}`;
      deps.store.saveSpecContract(
        {
          ...approvedContract,
          taskKey: key,
          projectId: task.project_id ?? undefined,
          specSha,
          isArchitectural: approvedContract.isArchitectural,
          approvalId,
        },
        now,
      );
      payloadObj.approval_id = approvalId;
      payloadObj.spec_sha = specSha;
      if (approvedContract.specPath) {
        payloadObj.spec_path = approvedContract.specPath;
      }
      if (approvedContract.adrPath) {
        payloadObj.adr_path = approvedContract.adrPath;
      }
      payloadObj.is_architectural = approvedContract.isArchitectural;
      deps.store.updateTask(key, { payload: JSON.stringify(payloadObj) });
    }
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

export const BARE_CHECK_RUNNERS = new Set([
  "npm test",
  "npm run test",
  "npm run test:*",
  "npm run lint",
  "pytest",
  "cargo test",
  "go test",
  "go test ./...",
]);

export const TEST_FILTER_FLAGS = new Set([
  "-k",
  "-t",
  "--test-name-pattern",
  "--testNamePattern",
  "-run",
  "--run",
  "--test",
  "--filter",
  "--testPathPattern",
  "-g",
  "--grep",
]);

export const ALLOWED_CONTRACT_FLAGS = new Set([
  "--",
  "-k",
  "-t",
  "--test-name-pattern",
  "--testNamePattern",
  "-run",
  "--run",
  "--test",
  "--filter",
  "--testPathPattern",
  "-g",
  "--grep",
  "-v",
  "-q",
  "--silent",
  "--bail",
  "-s",
  "--nocapture",
  "--release",
  "--no-coverage",
]);

export const FLAGS_WITH_VALUES = new Set([
  "-n",
  "--maxfail",
  "--jobs",
  "-j",
  "-p",
  "-c",
  "-o",
  "--config",
  "--test-concurrency",
  "--timeout",
  "--target",
  "--workers",
  "--retries",
  "-k",
  "-t",
  "--test-name-pattern",
  "--testNamePattern",
  "-run",
  "--run",
  "--test",
  "--filter",
  "--testPathPattern",
  "-g",
  "--grep",
  "--tb",
  "--features",
  "--package",
  "--bin",
  "--example",
  "--bench",
  "--profile",
  "--override-ini",
]);

export function splitRunnerPrefix(parts: string[]): {
  binary: string;
  prefixArgs: string[];
  restArgs: string[];
} {
  if (parts.length === 0) {
    return { binary: "", prefixArgs: [], restArgs: [] };
  }

  // npm commands: npm test, npm run test, npm run test:*
  if (parts[0] === "npm") {
    const ddIdx = parts.indexOf("--");
    if (ddIdx !== -1) {
      return {
        binary: "npm",
        prefixArgs: parts.slice(1, ddIdx + 1),
        restArgs: parts.slice(ddIdx + 1),
      };
    }
    if (parts[1] === "run") {
      return {
        binary: "npm",
        prefixArgs: parts.slice(1, 3),
        restArgs: parts.slice(3),
      };
    }
    if (parts[1] === "test") {
      return {
        binary: "npm",
        prefixArgs: ["test"],
        restArgs: parts.slice(2),
      };
    }
  }

  // cargo test
  if (parts[0] === "cargo" && parts[1] === "test") {
    return {
      binary: "cargo",
      prefixArgs: ["test"],
      restArgs: parts.slice(2),
    };
  }

  // go test
  if (parts[0] === "go" && parts[1] === "test") {
    return {
      binary: "go",
      prefixArgs: ["test"],
      restArgs: parts.slice(2),
    };
  }

  // node --test
  if (parts[0] === "node" && parts[1] === "--test") {
    return {
      binary: "node",
      prefixArgs: ["--test"],
      restArgs: parts.slice(2),
    };
  }

  // python / python3 -m pytest
  if (
    (parts[0] === "python" || parts[0] === "python3") &&
    parts[1] === "-m" &&
    parts[2] === "pytest"
  ) {
    return {
      binary: parts[0],
      prefixArgs: ["-m", "pytest"],
      restArgs: parts.slice(3),
    };
  }

  // pytest
  if (parts[0] === "pytest") {
    return {
      binary: "pytest",
      prefixArgs: [],
      restArgs: parts.slice(1),
    };
  }

  return {
    binary: parts[0],
    prefixArgs: [],
    restArgs: parts.slice(1),
  };
}

export function reorderFilterFlagsForNode(tokens: string[]): string[] {
  const filterFlags: string[] = [];
  const otherTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--") {
      otherTokens.push(...tokens.slice(i));
      break;
    }
    const flagName = tok.split("=")[0];
    if (TEST_FILTER_FLAGS.has(flagName)) {
      filterFlags.push(tok);
      if (
        !tok.includes("=") &&
        i + 1 < tokens.length &&
        !tokens[i + 1].startsWith("-")
      ) {
        filterFlags.push(tokens[++i]);
      }
    } else {
      otherTokens.push(tok);
    }
  }
  return [...filterFlags, ...otherTokens];
}

export const reorderFlagsBeforeFiles = reorderFilterFlagsForNode;

export function hasTestFilter(cmdStr: string): boolean {
  const parts = cmdStr.trim().split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--") continue;
    const flagName = part.split("=")[0];
    if (TEST_FILTER_FLAGS.has(flagName)) return true;
    if (part.includes("::")) return true;
  }
  return false;
}

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

  // §31.3: Forbidden flags: -exec, --import, -o, --pdb, --run-command, --script-shell, etc.
  const forbiddenFlags = [
    "-exec",
    "--import",
    "-o",
    "--pdb",
    "--run-command",
    "--script-shell",
    "--shell",
    "--toolchain",
    "--wrapper",
  ];
  const parts = trimmed.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    for (const ff of forbiddenFlags) {
      if (p === ff || p.startsWith(ff + "=")) {
        return {
          valid: false,
          reason: `checks-refused: forbidden-flag (${p} is not allowed in checks)`,
        };
      }
    }
    // Specially check cargo dangerous config options (wrapper, runner, linker)
    if (p === "--config" || p.startsWith("--config=")) {
      const configVal = p.startsWith("--config=")
        ? p.slice("--config=".length)
        : (parts[i + 1] ?? "");
      if (
        /(?:rustc-wrapper|target\..*\.runner|target\..*\.linker|build\.rustflags)/i.test(
          configVal,
        )
      ) {
        return {
          valid: false,
          reason: `checks-refused: forbidden-flag (${p} is not allowed in checks)`,
        };
      }
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

  const { binary, prefixArgs, restArgs } = splitRunnerPrefix(parts);
  let args: string[];
  const isNodeTest =
    (binary === "node" && prefixArgs.includes("--test")) ||
    (binary === "npm" && prefixArgs.includes("--"));

  if (isNodeTest) {
    const reordered = reorderFilterFlagsForNode(restArgs);
    args = [...prefixArgs, ...reordered];
  } else {
    args = parts.slice(1);
  }
  return { valid: true, binary, args };
}

export const DEFAULT_ALLOWED_ENV_VARS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "TMPDIR",
  "NODE_ENV",
  "CI",
];

export const FORBIDDEN_EXTRA_ENV_PATTERN =
  /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

export function buildChecksEnvironment(
  extraEnvVars: string[] = [],
  allowedEnvVars: readonly string[] = DEFAULT_ALLOWED_ENV_VARS,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  for (const k of [...allowedEnvVars, ...extraEnvVars]) {
    if (FORBIDDEN_EXTRA_ENV_PATTERN.test(k)) {
      throw new OrchestratorError(
        "checks-invalid-env",
        `checks environment variable contains forbidden secret keyword: "${k}"`,
      );
    }
  }
  const allowedSet = new Set([...allowedEnvVars, ...extraEnvVars]);
  const env: NodeJS.ProcessEnv = {};
  for (const k of allowedSet) {
    if (sourceEnv[k] !== undefined) {
      env[k] = sourceEnv[k];
    }
  }
  return env;
}

export async function executeChecks(
  deps: { cmd?: CmdRunner; repoRoot?: string; worktreeDir?: string },
  task: TaskQueueRow,
  allowedRunners: readonly string[] = DEFAULT_ALLOWED_RUNNERS,
  checksConfig?: PolicyChecksConfig,
  overrideCommands?: string[],
): Promise<{ ok: boolean; exitCode: number; output?: string; notRun?: boolean; acceptanceVerified?: boolean }> {
  let payloadObj: Record<string, unknown> = {};
  if (task.payload) {
    try {
      payloadObj = JSON.parse(task.payload);
    } catch {}
  }

  let commands: string[] = [];
  const isOverride = Array.isArray(overrideCommands) && overrideCommands.length > 0;
  if (isOverride) {
    commands = overrideCommands!;
  } else if (Array.isArray(payloadObj.checks_commands) && payloadObj.checks_commands.length > 0) {
    commands = [...(payloadObj.checks_commands as string[])];
  } else if (typeof payloadObj.test_command === "string") {
    commands = [payloadObj.test_command];
  } else if (Array.isArray(checksConfig?.commands) && checksConfig.commands.length > 0) {
    commands = [...checksConfig.commands];
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

  // §34.5 (ADR-0037, Reviewer Б1-в): Post-code checks must also verify acceptance contract commands!
  let contractCommands: string[] = [];
  if (!isOverride) {
    if (Array.isArray(payloadObj.tdd_commands) && payloadObj.tdd_commands.length > 0) {
      contractCommands = payloadObj.tdd_commands as string[];
    } else if (task.acceptance_sha && deps.cmd && deps.repoRoot) {
      try {
        const normKey = normalizeTaskKey(task.task_key).toUpperCase();
        const showRes = await deps.cmd.run("git", [
          "-C",
          deps.repoRoot,
          "show",
          `${task.acceptance_sha}:docs/specs/acceptance/${normKey}.md`,
        ]);
        if (showRes.exitCode === 0 && showRes.stdout) {
          contractCommands = extractAcceptanceCommands(showRes.stdout, allowedRunners);
        }
      } catch {}
    }
  }

  // §31.3 / §34.5 (Reviewer Б1-в-1 / Б8): Machine checks on code phase must run in an isolated worktree on result_sha
  const targetSha =
    (typeof payloadObj.result_sha === "string" ? payloadObj.result_sha : null) ||
    (task.branch ? `refs/heads/${task.branch}` : null);

  let tmpWorktree: string | null = null;
  let workRoot = deps.worktreeDir ?? deps.repoRoot ?? process.cwd();

  if (!deps.worktreeDir && targetSha && deps.cmd && deps.repoRoot) {
    try {
      const headRes = await deps.cmd.run("git", ["-C", deps.repoRoot, "rev-parse", "HEAD"]);
      const targetRes = await deps.cmd.run("git", ["-C", deps.repoRoot, "rev-parse", targetSha]);
      const currentHead = headRes.exitCode === 0 ? headRes.stdout.trim() : null;
      const targetCommit = targetRes.exitCode === 0 ? targetRes.stdout.trim() : targetSha;

      if (currentHead && targetCommit && currentHead !== targetCommit) {
        const tmp = fs.mkdtempSync(
          path.join(os.tmpdir(), `bb-chk-${normalizeTaskKey(task.task_key)}-`),
        );
        const addRes = await deps.cmd.run("git", [
          "-C",
          deps.repoRoot,
          "worktree",
          "add",
          "--detach",
          tmp,
          targetSha,
        ]);
        if (addRes.exitCode === 0) {
          tmpWorktree = tmp;
          workRoot = tmp;
          const nmRepo = path.join(deps.repoRoot, "node_modules");
          const nmTmp = path.join(tmp, "node_modules");
          if (fs.existsSync(nmRepo) && !fs.existsSync(nmTmp)) {
            try {
              fs.symlinkSync(nmRepo, nmTmp, "junction");
            } catch {}
          }
        } else {
          try {
            fs.rmSync(tmp, { recursive: true, force: true });
          } catch {}
          return {
            ok: false,
            exitCode: 1,
            notRun: true,
            output: `checks-not-run: failed to create isolated worktree for checks at ${targetSha}: ${addRes.stderr || addRes.stdout}`,
          };
        }
      }
    } catch (err: any) {
      return {
        ok: false,
        exitCode: 1,
        notRun: true,
        output: `checks-not-run: failed to setup isolated checks worktree: ${err?.message ?? err}`,
      };
    }
  }

  try {
    // Verify that all test files referenced in contractCommands exist in workRoot
    if (contractCommands.length > 0 && workRoot) {
      for (const cmdStr of contractCommands) {
        const tokens = cmdStr.split(/\s+/).slice(1);
        for (let i = 0; i < tokens.length; i++) {
          const tok = tokens[i];
          if (tok === "--") continue;
          if (tok.startsWith("-")) {
            const flagName = tok.split("=")[0];
            if (
              !tok.includes("=") &&
              FLAGS_WITH_VALUES.has(flagName) &&
              i + 1 < tokens.length &&
              !tokens[i + 1].startsWith("-")
            ) {
              i++;
            }
            continue;
          }
          if (/^\d+$/.test(tok) || tok === "true" || tok === "false") continue;
          const cleanPath = tok.split("::")[0];
          if (
            cleanPath === "./..." ||
            cleanPath === "..." ||
            cleanPath === "." ||
            cleanPath.endsWith("/...") ||
            cleanPath.includes("*")
          ) {
            continue;
          }
          if (
            cleanPath.includes("/") ||
            /\.(?:[tj]sx?|py|go|rs|c|cpp|h)$/i.test(cleanPath)
          ) {
            const resolved = path.resolve(workRoot, cleanPath);
            if (!fs.existsSync(resolved)) {
              return {
                ok: false,
                exitCode: 1,
                output: `checks-failed: acceptance test file "${cleanPath}" was not created by executor`,
              };
            }
          }
        }
        if (!commands.includes(cmdStr)) {
          commands.push(cmdStr);
        }
      }
    }

    let timeoutSeconds = 600;
    if (typeof payloadObj.checks_timeout_seconds === "number") {
      timeoutSeconds = payloadObj.checks_timeout_seconds;
    } else if (checksConfig?.timeout_seconds !== undefined) {
      timeoutSeconds = checksConfig.timeout_seconds;
    }
    timeoutSeconds = Math.max(30, Math.min(3600, timeoutSeconds));

    const extraEnv = Array.isArray(payloadObj.checks_extra_env)
      ? (payloadObj.checks_extra_env as string[])
      : checksConfig?.extraEnvVars ?? [];
    const allowedEnv = checksConfig?.allowedEnvVars ?? DEFAULT_ALLOWED_ENV_VARS;
    let env: NodeJS.ProcessEnv;
    try {
      env = buildChecksEnvironment(extraEnv, allowedEnv);
    } catch (e: any) {
      return {
        ok: false,
        exitCode: 1,
        notRun: true,
        output: `checks-invalid-env: ${e?.message ?? e}`,
      };
    }

    let lastOutput = "";
    for (const cmdStr of commands) {
      const val = validateCheckCommand(cmdStr, allowedRunners);
      if (!val.valid) {
        return { ok: false, exitCode: 1, notRun: true, output: val.reason };
      }

      if (deps.cmd && workRoot) {
        const res = await deps.cmd.run(val.binary!, val.args!, {
          cwd: workRoot,
          timeoutMs: timeoutSeconds * 1000,
          env,
          cleanEnv: true,
        });
        lastOutput = (res.stdout || res.stderr).trim();
        if (res.exitCode !== 0) {
          return {
            ok: false,
            exitCode: res.exitCode,
            output:
              (res.stderr || res.stdout).trim() ||
              `test failed with exit code ${res.exitCode}`,
          };
        }

        // §34.5 (Reviewer Б1-в-2): For acceptance contract commands, 0 matching tests is a failure!
        if (contractCommands.includes(cmdStr)) {
          if (didFilterMatchZeroTests(lastOutput)) {
            return {
              ok: false,
              exitCode: 1,
              output: `checks-failed: acceptance test command "${cmdStr}" matched 0 tests (test was not created or executed)`,
            };
          }
        }
      }
    }

    return {
      ok: true,
      exitCode: 0,
      output: lastOutput || "checks passed",
      acceptanceVerified: contractCommands.length > 0,
    };
  } finally {
    if (tmpWorktree && deps.cmd && deps.repoRoot) {
      await deps.cmd
        .run("git", ["-C", deps.repoRoot, "worktree", "remove", "--force", tmpWorktree])
        .catch(() => {});
      try {
        fs.rmSync(tmpWorktree, { recursive: true, force: true });
      } catch {}
    }
  }
}

export function validateContractCommand(
  cmdStr: string,
  allowedRunners: readonly string[] = DEFAULT_ALLOWED_RUNNERS,
): { valid: boolean; binary?: string; args?: string[]; reason?: string } {
  const baseVal = validateCheckCommand(cmdStr, allowedRunners);
  if (!baseVal.valid) {
    return baseVal;
  }

  const parts = cmdStr.trim().split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--") continue;
    if (part.startsWith("-")) {
      const flagName = part.split("=")[0];
      if (!ALLOWED_CONTRACT_FLAGS.has(flagName)) {
        return {
          valid: false,
          reason: `contract-refused: forbidden-flag (${flagName} is not permitted in acceptance contract command)`,
        };
      }
    }
  }

  return baseVal;
}

export function isTestFilePath(name: string): boolean {
  const trimmed = name.trim();
  const clean = trimmed.replace(/\s+\([\d.]+m?s\)$/, "").trim();
  return (
    /[/\\]/.test(clean) &&
    /\.(?:[cm]?[jt]sx?|json)$/i.test(clean)
  );
}

export function hasPositiveTestPassCount(output?: string): boolean {
  if (!output) return false;

  // 1. Pytest / Jest / Vitest: "1 passed", "2 passed", etc. (where number > 0)
  if (/\b[1-9]\d*\s+passed\b/i.test(output)) return true;

  // 2. Cargo: "test result: ok. 1 passed"
  if (/test result:\s*ok\.\s*[1-9]\d*\s+passed/i.test(output)) return true;

  // 3. Go: "--- PASS: TestName" or "ok <pkg> <dur>" WITHOUT "[no tests to run]"
  if (/---\s*PASS:\s+\S+/i.test(output)) return true;
  const goOkLines = output.match(/^[ \t]*ok\s+\S+\s+[\d.]+s.*$/gm);
  if (goOkLines && goOkLines.some((line) => !line.includes("[no tests to run]"))) {
    return true;
  }

  // 4. Node / TAP: check for passed tests whose names are NOT test file path wrappers!
  // Spec reporter checkmarks: "✔ <test_name>"
  const checkMatches = output.match(/^[ \t]*[✔✓]\s+(.+)$/gm);
  if (checkMatches) {
    for (const m of checkMatches) {
      const rawName = m.replace(/^[ \t]*[✔✓]\s+/, "").replace(/\s+\([\d.]+m?s\)$/, "").trim();
      if (!isTestFilePath(rawName)) {
        return true;
      }
    }
  }

  // TAP reporter: "ok <N> - <test_name>"
  const tapMatches = output.match(/^[ \t]*ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/gm);
  if (tapMatches) {
    for (const m of tapMatches) {
      const rawName = m.replace(/^[ \t]*ok\s+\d+\s+-\s+/, "").replace(/\s+#.*$/, "").trim();
      if (!isTestFilePath(rawName)) {
        return true;
      }
    }
  }

  return false;
}

export function didFilterMatchZeroTests(output?: string): boolean {
  if (!output) return false;
  // If positive passed tests were detected, tests DID run!
  if (hasPositiveTestPassCount(output)) return false;

  // Node 22 spec reporter: checkmark lines exist, but ALL of them are file paths!
  const checkMatches = output.match(/^[ \t]*[✔✓]\s+(.+)$/gm);
  if (checkMatches && checkMatches.length > 0) {
    const allFilePaths = checkMatches.every((m) =>
      isTestFilePath(m.replace(/^[ \t]*[✔✓]\s+/, "")),
    );
    if (allFilePaths) return true;
  }

  // TAP 13: 1..0 plan
  if (/\b1\.\.0\b/.test(output)) return true;

  // Standard runner zero-match indicators
  if (/no tests found/i.test(output)) return true;
  if (/ran 0 test suites/i.test(output)) return true;
  if (/0\s+passed,\s*0\s+total/i.test(output)) return true;
  if (/\b0\s+tests?\s+passed\b.*\b0\s+total\b/i.test(output)) return true;
  if (/total:\s*0/i.test(output) && /passed:\s*0/i.test(output)) return true;
  if (/(?:#|ℹ)\s*tests\s+0\b/i.test(output)) return true;
  if (/(?:#|ℹ)\s*pass\s+0\b.*(?:#|ℹ)\s*fail\s+0\b/i.test(output)) return true;
  if (/collected 0 items/i.test(output)) return true;
  if (/no tests ran/i.test(output)) return true;
  if (/no tests collected/i.test(output)) return true;
  if (/running 0 tests/i.test(output)) return true;
  if (/0 passed;\s*0 failed;\s*0 ignored/i.test(output)) return true;
  if (/warning: no tests to run/i.test(output)) return true;
  if (/\[no tests to run\]/i.test(output)) return true;
  if (/\[no test files\]/i.test(output)) return true;

  return false;
}

export function isTargetedCheckCommand(
  cmdStr: string,
  allowedRunners: readonly string[] = DEFAULT_ALLOWED_RUNNERS,
): boolean {
  const trimmed = cmdStr.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;

  // Lint is never an acceptance/TDD test runner
  if (/^npm\s+run\s+lint\b/.test(trimmed)) return false;

  let matchedPrefix = "";
  for (const runner of allowedRunners) {
    if (runner.endsWith("*")) {
      const p = runner.slice(0, -1);
      if (trimmed.startsWith(p)) {
        const nextSpace = trimmed.indexOf(" ", p.length);
        matchedPrefix = nextSpace === -1 ? trimmed : trimmed.slice(0, nextSpace);
        break;
      }
    } else {
      if (trimmed === runner || trimmed.startsWith(runner + " ")) {
        matchedPrefix = runner;
        break;
      }
    }
  }

  if (!matchedPrefix) {
    const firstWord = trimmed.split(/\s+/)[0];
    if (allowedRunners.includes(firstWord)) {
      matchedPrefix = firstWord;
    } else {
      return false;
    }
  }

  const remainder = trimmed.slice(matchedPrefix.length).trim();
  if (!remainder) {
    return false;
  }

  const tokens = remainder.split(/\s+/).filter(Boolean);
  let hasFilter = false;
  let hasPathOrTarget = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--") continue;

    if (tok.startsWith("-")) {
      const flagName = tok.split("=")[0];
      if (TEST_FILTER_FLAGS.has(flagName)) {
        hasFilter = true;
        break;
      }
      if (!tok.includes("=") && FLAGS_WITH_VALUES.has(flagName)) {
        i++;
      }
      continue;
    }

    if (/^\d+$/.test(tok) || tok === "true" || tok === "false") {
      continue;
    }

    const clean = tok.split("::")[0];
    if (
      clean.includes("/") ||
      clean.includes("\\") ||
      tok.includes("::") ||
      /\.(?:[tj]sx?|py|go|rs)$/i.test(clean) ||
      /^(?:test_|.+_test)/i.test(clean) ||
      clean === "./..." ||
      clean === "..."
    ) {
      hasPathOrTarget = true;
      break;
    }
  }

  return hasFilter || hasPathOrTarget;
}

export function extractAcceptanceCommands(
  markdownText: string,
  allowedRunners: readonly string[] = DEFAULT_ALLOWED_RUNNERS,
): string[] {
  const commands: string[] = [];

  // 1. Check YAML frontmatter strictly for tdd_commands
  const frontmatterMatch = markdownText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const lines = fm.split("\n");
    let inTdd = false;
    for (const l of lines) {
      const trimmed = l.trim();
      const inlineMatch = trimmed.match(/^tdd_commands:\s*\[(.*)\]\s*$/);
      if (inlineMatch) {
        const items = inlineMatch[1].split(",");
        for (const item of items) {
          const cmdCandidate = item.trim().replace(/^["']|["']$/g, "").trim();
          if (cmdCandidate) {
            const val = validateContractCommand(cmdCandidate, allowedRunners);
            if (val.valid && isTargetedCheckCommand(cmdCandidate, allowedRunners) && !commands.includes(cmdCandidate)) {
              commands.push(cmdCandidate);
            }
          }
        }
        inTdd = false;
        continue;
      }

      if (/^tdd_commands:/.test(trimmed)) {
        inTdd = true;
        continue;
      }
      if (inTdd) {
        if (/^[a-zA-Z0-9_]+:/.test(trimmed)) {
          inTdd = false;
          continue;
        }
        if (trimmed.startsWith("-")) {
          const cmdCandidate = trimmed.replace(/^-\s*/, "").replace(/^["']|["']$/g, "").trim();
          if (cmdCandidate) {
            const val = validateContractCommand(cmdCandidate, allowedRunners);
            if (val.valid && isTargetedCheckCommand(cmdCandidate, allowedRunners) && !commands.includes(cmdCandidate)) {
              commands.push(cmdCandidate);
            }
          }
        }
      }
    }
  }

  // 2. Check dedicated sections with code blocks (bash / sh)
  const lines = markdownText.split("\n");
  let inDedicatedSection = false;
  let inCodeBlock = false;
  let codeBlockLang = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Strictly: ## Тесты договора приёмки | ## Acceptance Tests | ## Команды верификации
    if (/^##\s+(?:тест[ыа]\s+договора(?:\s+при[её]мки)?|acceptance\s+tests?|команд[ыа]\s+верификации)\s*$/i.test(trimmed)) {
      inDedicatedSection = true;
      continue;
    } else if (/^#{1,2}\s+/.test(trimmed) && inDedicatedSection) {
      // H1 or H2 closes the dedicated section; H3 (###) does NOT
      inDedicatedSection = false;
    }

    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        inCodeBlock = false;
        codeBlockLang = "";
      } else {
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim().toLowerCase();
      }
      continue;
    }

    if (inCodeBlock && inDedicatedSection) {
      const isAllowedScriptBlock = codeBlockLang === "bash" || codeBlockLang === "sh";
      if (isAllowedScriptBlock) {
        if (trimmed && !trimmed.startsWith("#")) {
          const val = validateContractCommand(trimmed, allowedRunners);
          if (val.valid && isTargetedCheckCommand(trimmed, allowedRunners) && !commands.includes(trimmed)) {
            commands.push(trimmed);
          }
        }
      }
    }
  }

  return commands;
}

export type TddVerificationOutcome =
  | "red_confirmed"
  | "skipped_new_test"
  | "skipped_no_commands"
  | "vacuous"
  | "not_run";

export interface TddVerificationResult {
  ok: boolean;
  failedAsExpected: boolean;
  outcome?: TddVerificationOutcome;
  notRun?: boolean;
  output?: string;
  newTestFiles?: string[];
  commands?: string[];
}

export async function runTddFailFirstVerification(
  deps: { cmd?: CmdRunner; repoRoot?: string },
  task: TaskQueueRow,
  acceptanceSha: string | null,
  allowedRunners: readonly string[] = DEFAULT_ALLOWED_RUNNERS,
  checksConfig?: PolicyChecksConfig,
): Promise<TddVerificationResult> {
  // §34.5 / Reviewer Б2: without acceptance_sha, no verification
  if (!acceptanceSha) {
    return {
      ok: true,
      failedAsExpected: true,
      outcome: "skipped_no_commands",
      output: "tdd check skipped: no acceptance sha",
    };
  }

  let payloadObj: Record<string, unknown> = {};
  if (task.payload) {
    try {
      payloadObj = JSON.parse(task.payload);
    } catch {}
  }
  if (payloadObj.skip_tdd_check) {
    return {
      ok: true,
      failedAsExpected: true,
      outcome: "skipped_no_commands",
      output: "tdd check skipped by configuration",
    };
  }
  if (payloadObj.mock_acceptance_vacuous) {
    return {
      ok: true,
      failedAsExpected: false,
      outcome: "vacuous",
      output:
        "acceptance-contract-vacuous: договор приёмки уже полностью проходит на неизменённом коде",
    };
  }
  if (payloadObj.mock_acceptance_red) {
    return {
      ok: true,
      failedAsExpected: true,
      outcome: "red_confirmed",
      output: "tdd fail-first verified: tests failed on base commit as expected",
    };
  }

  // 1. Explicit commands from payload (prioritize tdd_commands)
  let commands: string[] | undefined =
    Array.isArray(payloadObj.tdd_commands) && payloadObj.tdd_commands.length > 0
      ? (payloadObj.tdd_commands as string[])
      : undefined;

  // 2. Extract from acceptance contract markdown on acceptanceSha
  if (!commands && deps.cmd && deps.repoRoot) {
    try {
      const normKey = normalizeTaskKey(task.task_key).toUpperCase();
      const showRes = await deps.cmd.run("git", [
        "-C",
        deps.repoRoot,
        "show",
        `${acceptanceSha}:docs/specs/acceptance/${normKey}.md`,
      ]);
      if (showRes.exitCode === 0 && showRes.stdout) {
        const extracted = extractAcceptanceCommands(showRes.stdout, allowedRunners);
        if (extracted.length > 0) {
          commands = extracted;
        }
      }
    } catch {}
  }

  // §34.5 / Reviewer Б1: if contract has no explicit test items in dedicated block, skip check.
  // Never run bare runners or entire project test suite on base code!
  if (!commands || commands.length === 0) {
    return {
      ok: true,
      failedAsExpected: true,
      outcome: "skipped_no_commands",
      output: "tdd check skipped: no explicit acceptance test commands configured",
    };
  }

  if (!deps.cmd || !deps.repoRoot) {
    return {
      ok: true,
      failedAsExpected: true,
      outcome: "skipped_no_commands",
      output: "tdd check skipped: no cmd runner",
    };
  }

  // §34.5 (ADR-0037): Run checks in an isolated worktree at acceptanceSha
  let tmpDir: string | null = null;
  try {
    try {
      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `bb-tdd-${task.task_key}-`),
      );
    } catch (e: any) {
      return {
        ok: false,
        failedAsExpected: false,
        notRun: true,
        outcome: "not_run",
        commands,
        output: `mkdtemp failed: ${e?.message ?? e}`,
      };
    }

    const addRes = await deps.cmd.run("git", [
      "-C",
      deps.repoRoot,
      "worktree",
      "add",
      "--detach",
      tmpDir,
      acceptanceSha,
    ]);
    if (addRes.exitCode !== 0) {
      return {
        ok: false,
        failedAsExpected: false,
        notRun: true,
        outcome: "not_run",
        commands,
        output: `git worktree add failed: ${addRes.stderr}`,
      };
    }

    // Classify commands into runnable (targeting existing tests) vs new test files
    const runnableCommands: string[] = [];
    const newTestFiles: string[] = [];

    for (const cmdStr of commands) {
      const tokens = cmdStr.split(/\s+/).slice(1);
      const fileCandidates: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok === "--") continue;
        if (tok.startsWith("-")) {
          const flagName = tok.split("=")[0];
          if (!tok.includes("=") && FLAGS_WITH_VALUES.has(flagName) && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
            i++;
          }
          continue;
        }
        if (/^\d+$/.test(tok) || tok === "true" || tok === "false") continue;
        const cleanPath = tok.split("::")[0];
        if (
          cleanPath === "./..." ||
          cleanPath === "..." ||
          cleanPath === "." ||
          cleanPath.endsWith("/...") ||
          cleanPath.includes("*")
        ) {
          continue;
        }
        if (
          cleanPath.includes("/") ||
          /\.(?:[tj]sx?|py|go|rs|c|cpp|h)$/i.test(cleanPath)
        ) {
          fileCandidates.push(cleanPath);
        }
      }

      if (fileCandidates.length > 0) {
        let allFilesNew = true;
        for (const fc of fileCandidates) {
          const resolvedPath = path.resolve(tmpDir, fc);
          if (fs.existsSync(resolvedPath)) {
            allFilesNew = false;
          } else {
            if (!newTestFiles.includes(fc)) {
              newTestFiles.push(fc);
            }
          }
        }
        if (allFilesNew) {
          // This command targets a new test file not yet created on acceptance_sha
          continue;
        }
      }

      runnableCommands.push(cmdStr);
    }

    // If all commands target new test files, skip verification with failedAsExpected: true
    if (runnableCommands.length === 0) {
      return {
        ok: true,
        failedAsExpected: true,
        outcome: "skipped_new_test",
        newTestFiles,
        commands,
        output: `tdd check skipped: new test file(s) to be created during code phase (${newTestFiles.join(", ")})`,
      };
    }

    const nmRepo = path.join(deps.repoRoot, "node_modules");
    const nmTmp = path.join(tmpDir, "node_modules");
    if (fs.existsSync(nmRepo) && !fs.existsSync(nmTmp)) {
      try {
        fs.symlinkSync(nmRepo, nmTmp, "junction");
      } catch {}
    }

    // Run each runnable command individually (Reviewer Б1-а-3)
    let confirmedRed = false;
    let skippedNewTest = false;
    let notRunFailure: {
      ok: false;
      failedAsExpected: false;
      notRun: true;
      outcome: "not_run";
      commands: string[];
      output: string;
    } | null = null;

    for (const cmdStr of runnableCommands) {
      const { binary } = splitRunnerPrefix(cmdStr.trim().split(/\s+/));
      const isPytest = binary === "pytest" || binary === "python" || binary === "python3";
      const singleRes = await executeChecks(
        { cmd: deps.cmd, repoRoot: tmpDir, worktreeDir: tmpDir },
        task,
        allowedRunners,
        checksConfig,
        [cmdStr],
      );

      if (singleRes.notRun) {
        notRunFailure = {
          ok: false,
          failedAsExpected: false,
          notRun: true,
          outcome: "not_run",
          commands,
          output: `tdd check not run: ${singleRes.output}`,
        };
        break;
      }

      const isPytestNoTests = isPytest && singleRes.exitCode === 5;
      const isZeroMatchingTests = didFilterMatchZeroTests(singleRes.output);

      // §34.5 (Reviewer Б3 / Б4):
      // If command failed (exitCode !== 0):
      //   - pytest exit code 5 means no tests collected -> skipped_new_test
      //   - other non-zero exit codes mean test failed on base commit as expected for TDD! -> confirmedRed = true
      // If command succeeded (exitCode === 0):
      //   - if zero matching tests confirmed (isZeroMatchingTests) -> skipped_new_test
      //   - otherwise, existing tests passed on base commit (do NOT mark skippedNewTest, contract may be vacuous)
      if (singleRes.exitCode !== 0) {
        if (isPytestNoTests) {
          skippedNewTest = true;
        } else {
          confirmedRed = true;
        }
      } else {
        if (isZeroMatchingTests) {
          skippedNewTest = true;
        }
      }
    }

    if (notRunFailure) {
      return notRunFailure;
    }

    if (confirmedRed) {
      return {
        ok: true,
        failedAsExpected: true,
        outcome: "red_confirmed",
        newTestFiles,
        commands,
        output: `tdd fail-first verified: tests failed on base commit as expected`,
      };
    }

    if (skippedNewTest || newTestFiles.length > 0) {
      const details =
        newTestFiles.length > 0
          ? `new test file(s) to be created during code phase (${newTestFiles.join(", ")})`
          : `new test case to be created during code phase (0 tests matched on base commit)`;
      return {
        ok: true,
        failedAsExpected: true,
        outcome: "skipped_new_test",
        newTestFiles,
        commands,
        output: `tdd check skipped: ${details}`,
      };
    }

    return {
      ok: true,
      failedAsExpected: false,
      outcome: "vacuous",
      commands,
      output:
        "acceptance-contract-vacuous: договор приёмки уже полностью проходит на неизменённом коде",
    };
  } finally {
    if (tmpDir) {
      try {
        await deps.cmd.run("git", [
          "-C",
          deps.repoRoot,
          "worktree",
          "remove",
          "--force",
          tmpDir,
        ]);
      } catch {}
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export function formatDesignCheckPacket(params: {
  taskKey: string;
  acceptanceText: string;
  netDiff: string;
  checksRunJson?: string;
  reviewVerdict?: string;
  reviewComments?: string;
}): string {
  return [
    `# Входные материалы проверки архитектуры и договора приёмки (${params.taskKey})`,
    "",
    "## 1. Договор приёмки",
    params.acceptanceText,
    "",
    "## 2. Нетто-дифф реализации",
    "```diff",
    params.netDiff,
    "```",
    "",
    "## 3. Протокол машинных проверок",
    "```json",
    params.checksRunJson ?? "{}",
    "```",
    "",
    "## 4. Отчёт код-ревью",
    `Вердикт: ${params.reviewVerdict ?? "OK"}`,
    params.reviewComments ?? "Замечаний нет.",
    "",
    "---",
    'Верни вердикт строгим JSON последней строкой: {"verdict":"OK"|"CHANGES","blockers":N,"target":"code"|"design"}',
  ].join("\n");
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
    if (res.exitCode !== 0) {
      // §31.4: git diff failure must not fail-open (tampered = true)
      return true;
    }
    if (res.stdout.trim().length > 0) {
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

  // §34.5 (Reviewer Non-blocker 5): If contract blob on parentSha is identical, reuse parentSha without creating duplicate commit
  const existingBlobRes = await cmd.run(
    "git",
    ["rev-parse", `${parentSha}:${relPath}`],
    { cwd: repoRoot },
  );
  if (
    existingBlobRes.exitCode === 0 &&
    existingBlobRes.stdout.trim() === blobSha
  ) {
    return parentSha;
  }

  const tempIndex = path.join(
    repoRoot,
    `.git/index_acc_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  );
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    const readTreeRes = await cmd.run("git", ["read-tree", `${parentSha}^{tree}`], {
      cwd: repoRoot,
      env,
    });
    if (readTreeRes.exitCode !== 0) {
      throw new OrchestratorError(
        "git-failed",
        `git read-tree failed: ${readTreeRes.stderr || readTreeRes.stdout}`,
      );
    }
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
  workGraphProjects?: Record<string, WorkGraphMode>;
  getWorkGraphMode?: (projectId?: string | null) => WorkGraphMode;
  autoAdvance?: boolean;
  maxActiveTasks?: number;
  repoRoot?: string;
  mergeBaseBranch?: string;
  resolveTaskRepoContext?: (
    task: TaskQueueRow,
  ) =>
    | Promise<{ repoRoot: string; mergeBaseBranch: string } | null>
    | { repoRoot: string; mergeBaseBranch: string }
    | null;
  cmd?: CmdRunner;
  bbCli?: BbCli;
  t?: T;
  now?: () => number;
  policy?: Policy | null;
  project?: ResolvedProject | null;
  resolveProject?: (
    projectId: string,
  ) => Promise<ResolvedProject | null> | ResolvedProject | null;
  getThread?: (threadId: string) => Promise<{ status?: string } | null>;
  stopThread?: (threadId: string) => Promise<void>;
  dispatchNode?: (
    task: TaskQueueRow,
    node: TaskNode,
  ) => Promise<{ ok: boolean; delegationId?: number; error?: string } | void>;
  runChecks?: (
    task: TaskQueueRow,
  ) => Promise<{ ok: boolean; exitCode: number; output?: string; notRun?: boolean; acceptanceVerified?: boolean }>;
  runTddCheck?: (
    task: TaskQueueRow,
    acceptanceSha: string | null,
  ) => Promise<TddVerificationResult>;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
  requestOwnerGateInteraction?: (
    task: TaskQueueRow,
    gateStage: "pre_code" | "pre_release",
  ) => Promise<string | void>;
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
  checkRouteLimits?: (
    task: TaskQueueRow,
    resultSha: string,
  ) => Promise<RouteLimitsCheckResult>;
  verifySpecReferences?: (
    task: TaskQueueRow,
    specSha: string,
    mergeBaseBranch: string,
  ) => Promise<SpecReferenceCheckResult>;
  checkPrStatus?: (
    task: TaskQueueRow,
  ) => Promise<{
    state: "MERGED" | "CLOSED" | "CHANGES_REQUESTED" | "OPEN";
    mergeCommit?: string;
    error?: string;
  }>;
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

async function advancePrOpenTask(
  task: TaskQueueRow,
  deps: RunQueueDeps,
  transitions: TaskTransitionRow[],
  now: number,
): Promise<boolean> {
  let prState: {
    state: "MERGED" | "CLOSED" | "CHANGES_REQUESTED" | "OPEN";
    mergeCommit?: string;
  } | null = null;

  if (deps.checkPrStatus) {
    prState = await deps.checkPrStatus(task);
  } else {
    const payload = parsePayload(task.payload);
    if (typeof payload.pr_status === "string") {
      const s = payload.pr_status.toUpperCase();
      prState = {
        state: (s === "MERGED" || s === "CLOSED" || s === "CHANGES_REQUESTED" ? s : "OPEN") as any,
        mergeCommit: typeof payload.pr_merge_sha === "string" ? payload.pr_merge_sha : undefined,
      };
    } else if (payload.pr_changes_requested === true) {
      prState = { state: "CHANGES_REQUESTED" };
    } else {
      const rel =
        deps.store.activeReleaseByTask(task.task_key) ??
        deps.store.latestReleaseByTask(task.task_key);
      if (rel) {
        if (rel.pr_state === "merged" || rel.pr_state === "merging") {
          prState = { state: "MERGED", mergeCommit: rel.pr_merge_sha ?? undefined };
        } else if (rel.pr_state === "closed" || rel.pr_state === "closed_final") {
          prState = { state: "CLOSED" };
        }
      }
    }
  }

  if (!prState || prState.state === "OPEN") {
    return false;
  }

  let event: TransitionEvent | null = null;
  if (prState.state === "MERGED") {
    event = { type: "pr_merged" };
  } else if (prState.state === "CHANGES_REQUESTED") {
    event = { type: "pr_changes_requested" };
  } else if (prState.state === "CLOSED") {
    event = { type: "pr_closed" };
  }

  if (!event) return false;

  const resolution = resolveTransition({
    route: task.route,
    node: "release",
    status: "pr_open",
    event,
    mode: task.confirmation_mode,
    counters: extractCounters(task),
  });

  if (!resolution.allowed) return false;

  const payload = parsePayload(task.payload);
  const updates: Partial<TaskQueueRow> = {};
  if (resolution.counterUpdates) {
    Object.assign(updates, resolution.counterUpdates);
  }
  if (prState.mergeCommit) {
    updates.result_sha = prState.mergeCommit;
  }
  if (prState.state === "CLOSED") {
    updates.payload = JSON.stringify({
      ...payload,
      stalled_reason: "pr_closed",
      pr_status: null,
    });
  } else if (prState.state === "CHANGES_REQUESTED") {
    updates.payload = JSON.stringify({
      ...payload,
      pr_changes_requested: false,
      pr_status: null,
      code_done: false,
      spec_done: false,
    });
  }

  const tr = deps.store.transitionTask(
    {
      taskKey: task.task_key,
      expectedNode: "release",
      expectedStatus: "pr_open",
      toNode: resolution.toNode,
      toStatus: resolution.toStatus,
      actor: "run-queue",
      reason: resolution.reason,
      updates: Object.keys(updates).length > 0 ? updates : undefined,
      timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
    },
    now,
  );

  if (tr.ok && tr.task) {
    const logged = deps.store.listTransitions(task.task_key).at(-1);
    if (logged) transitions.push(logged);
    if (resolution.toStatus === "done" && deps.bbCli) {
      try {
        await deps.bbCli.run(["tasks", "update", task.task_key, "--status", "done"]);
      } catch {}
    }
    if (resolution.action?.dispatchNode) {
      await deps.dispatchNode?.(tr.task, resolution.action.dispatchNode);
    }
    return true;
  }

  return false;
}

export async function runRunQueue(
  deps: RunQueueDeps,
): Promise<RunQueueResult> {
  const getTaskMode = (projectId?: string | null): WorkGraphMode => {
    if (deps.getWorkGraphMode) return deps.getWorkGraphMode(projectId);
    return resolveWorkGraphMode(
      projectId,
      deps.workGraphMode,
      deps.workGraphProjects,
    );
  };

  const hasActiveProject = Object.values(deps.workGraphProjects ?? {}).some(
    (m) => m === "shadow" || m === "strict",
  );
  if (deps.workGraphMode === "off" && !hasActiveProject) {
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
    deps.workGraphMode === "strict" ||
    deps.autoAdvance === true ||
    Object.values(deps.workGraphProjects ?? {}).some((m) => m === "strict");
  let progressed = true;
  let iterations = 0;

  if (shouldAdvance) {
    while (progressed && iterations < 25) {
      iterations++;
      progressed = false;
      const now = deps.now ? deps.now() : Date.now();

      // ── 1. Advance active running tasks ───────────────────────────────
      const activeTasks = deps.store.listActiveTasks();
      for (const task of activeTasks) {
        const taskMode = getTaskMode(task.project_id);
        if (taskMode === "off") continue;
        if (taskMode === "shadow" && !deps.autoAdvance) continue;
        try {
          const taskRepo = deps.resolveTaskRepoContext
            ? await deps.resolveTaskRepoContext(task)
            : { repoRoot, mergeBaseBranch };
          if (!taskRepo?.repoRoot) {
            const warnMsg = `orchestrator: task ${task.task_key} repo context unavailable for project ${task.project_id ?? "unknown"}; skipping git steps`;
            if (deps.log?.warn) deps.log.warn(warnMsg);
            else console.warn(warnMsg);
            continue;
          }
          const taskRepoRoot = taskRepo.repoRoot;
          const taskMergeBase = taskRepo.mergeBaseBranch ?? mergeBaseBranch;
          const advanced = await advanceActiveTask(
            task,
            deps,
            taskRepoRoot,
            taskMergeBase,
            transitions,
          );
          if (advanced) {
            progressed = true;
            advancedCount++;
          }
        } catch (e) {
          if ((e as any)?.code === "spec-gate-violation") {
            deps.log?.warn?.(`orchestrator: task ${task.task_key} failed spec-before-code gate: ${(e as any).message}`);
          }
        }
      }

      // ── 1b. Request interaction for tasks waiting at owner_gate ─────────
      if (deps.requestOwnerGateInteraction) {
        const waitingTasks = deps.store.listWaitingApprovalTasks();
        for (const task of waitingTasks) {
          const taskMode = getTaskMode(task.project_id);
          if (taskMode === "off") continue;
          if (taskMode === "shadow" && !deps.autoAdvance) continue;
          if (!task.interaction_id) {
            try {
              const payload = parsePayload(task.payload);
              const stage =
                (payload.gate_stage as "pre_code" | "pre_release") ||
                "pre_code";
              const interactionId = await deps.requestOwnerGateInteraction(
                task,
                stage,
              );
              if (interactionId) {
                deps.store.transitionTask(
                  {
                    taskKey: task.task_key,
                    expectedNode: "owner_gate",
                    expectedStatus: "waiting_approval",
                    toNode: "owner_gate",
                    toStatus: "waiting_approval",
                    actor: "run-queue",
                    reason: "interaction_requested",
                    updates: { interaction_id: interactionId },
                  },
                  deps.now ? deps.now() : Date.now(),
                );
              }
            } catch {}
          }
        }
      }

      // ── 1c. §34.4 (ADR-0037): Queue stall alarm for tasks stuck in queued ─────────
      const allQueued = deps.store.listQueuedTasks();
      const queueStallMinutes =
        deps.policy?.timing?.queueStallMinutes ?? 30;
      for (const qt of allQueued) {
        const taskMode = getTaskMode(qt.project_id);
        if (taskMode === "off") continue;
        if (taskMode === "shadow" && !deps.autoAdvance) continue;
        if (qt.node_alarm_at !== null && now >= qt.node_alarm_at) {
          const elapsedSeconds = Math.max(
            0,
            Math.round((now - (qt.entered_at ?? now)) / 1000),
          );
          deps.store.recordTaskEvent(
            "task.alarm_triggered",
            {
              task: qt.task_key,
              taskKey: qt.task_key,
              node: qt.node,
              reason: "queued-stalled",
              elapsedSeconds,
            },
            now,
          );
          const p = parsePayload(qt.payload);
          p.queued_stalled = true;
          const nextAlarm = now + queueStallMinutes * 60_000;
          deps.store.updateTask(qt.task_key, {
            node_alarm_at: nextAlarm,
            payload: JSON.stringify(p),
          });
          qt.node_alarm_at = nextAlarm;
          qt.payload = JSON.stringify(p);

          if (qt.coordinator_thread_id && deps.bbCli) {
            await deps.bbCli
              .run([
                "thread",
                "tell",
                qt.coordinator_thread_id,
                `Внимание: задача ${qt.task_key} ожидает запуска более ${queueStallMinutes} минут. Проверьте статус службы run-queue`,
              ])
              .catch(() => {});
          }
        }
      }

      // ── 1d. Advance tasks waiting in release (pr_open) ─────────
      const prOpenTasks = deps.store.listPrOpenTasks ? deps.store.listPrOpenTasks() : [];
      for (const pt of prOpenTasks) {
        const taskMode = getTaskMode(pt.project_id);
        if (taskMode === "off") continue;
        if (taskMode === "shadow" && !deps.autoAdvance) continue;
        try {
          const advanced = await advancePrOpenTask(
            pt,
            deps,
            transitions,
            now,
          );
          if (advanced) {
            progressed = true;
            advancedCount++;
          }
        } catch (e) {
          if ((e as any)?.code === "spec-gate-violation") {
            deps.log?.warn?.(`orchestrator: task ${pt.task_key} failed spec-before-code gate: ${(e as any).message}`);
          }
        }
      }

      // ── 2. Take queued tasks ──────────────────────────────────────────
      const currentActive = deps.store.listActiveTasks().filter((t) => {
        const m = getTaskMode(t.project_id);
        return m === "strict" || (m === "shadow" && deps.autoAdvance);
      }).length;
      let availableSlots = maxActiveTasks - currentActive;

      if (availableSlots > 0) {
        const queuedTasks = deps.store.listQueuedTasks();
        for (const t of queuedTasks) {
          if (availableSlots <= 0) break;
          const taskMode = getTaskMode(t.project_id);
          if (taskMode === "off") continue;
          if (taskMode === "shadow" && !deps.autoAdvance) continue;

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
            const taskRepo = deps.resolveTaskRepoContext
              ? await deps.resolveTaskRepoContext(t)
              : { repoRoot, mergeBaseBranch };
            if (!taskRepo?.repoRoot) {
              const warnMsg = `orchestrator: task ${t.task_key} repo context unavailable for project ${t.project_id ?? "unknown"}; skipping git steps`;
              if (deps.log?.warn) deps.log.warn(warnMsg);
              else console.warn(warnMsg);
              continue;
            }
            const taskRepoRoot = taskRepo.repoRoot;
            const taskMergeBase = taskRepo.mergeBaseBranch ?? mergeBaseBranch;
            const started = await startQueuedTask(
              t,
              deps,
              taskRepoRoot,
              taskMergeBase,
              transitions,
            );
            if (started) {
              progressed = true;
              advancedCount++;
              availableSlots--;
            }
          } catch (e) {
            if ((e as any)?.code === "spec-gate-violation") throw e;
          }
        }
      }
    }
  }

  const finalQueued = deps.store.listQueuedTasks();
  const finalActive = deps.store.listActiveTasks();

  const nonOffQueued = finalQueued.filter(
    (t) => getTaskMode(t.project_id) !== "off",
  );
  const nonOffActive = finalActive.filter(
    (t) => getTaskMode(t.project_id) !== "off",
  );

  let readyCount = 0;
  for (const t of nonOffQueued) {
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
  const hasShadowTasks =
    deps.workGraphMode === "shadow" ||
    Object.values(deps.workGraphProjects ?? {}).some((m) => m === "shadow") ||
    finalQueued.some((t) => getTaskMode(t.project_id) === "shadow") ||
    finalActive.some((t) => getTaskMode(t.project_id) === "shadow");
  if (hasShadowTasks && !deps.autoAdvance) {
    // 1. Evaluate queued tasks: start -> <target_node>
    for (const t of finalQueued) {
      if (getTaskMode(t.project_id) !== "shadow") continue;
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

        if (res.allowed && res.toNode === "code") {
          try {
            const tRepo = deps.resolveTaskRepoContext ? await Promise.resolve(deps.resolveTaskRepoContext(t)).catch(() => null) : null;
            const proj = t.project_id && deps.resolveProject ? await Promise.resolve(deps.resolveProject(t.project_id)).catch(() => null) : (deps.project ?? null);
            const tPreset = deps.policy?.routes?.[t.route]?.preset;
            const presetBaseBranch = await resolvePresetBaseBranch(tPreset, {
              bbCli: deps.bbCli,
              policy: deps.policy,
            });
            const effectiveRepo = tRepo?.repoRoot ?? repoRoot;
            let executorBaseSha: string | undefined;
            if (deps.cmd && effectiveRepo) {
              executorBaseSha = await resolveExecutorBaseSha({
                cmd: deps.cmd,
                repoRoot: effectiveRepo,
                baseBranch: presetBaseBranch ?? (proj as any)?.baseBranch ?? tRepo?.mergeBaseBranch,
              });
            }
            await verifySpecBeforeCodeGate({
              taskKey: t.task_key,
              store: deps.store,
              cmd: deps.cmd,
              repoRoot: effectiveRepo,
              baseSha: executorBaseSha,
              workGraphMode: getTaskMode(t.project_id),
              policy: deps.policy,
              project: proj,
              task: t,
              payload,
            });
          } catch (err: any) {
            if (err?.code === "spec-gate-violation") {
              const blockedEval = {
                command: "run-queue",
                evaluated_at: Date.now(),
                would_transition: shadowEval.would_transition,
                would_reject: "spec-gate-violation",
                would_block: { reason: "spec-gate-violation" },
                note: "вычислено, но не подключено",
                current_node: t.node,
                current_status: t.status,
              };
              deps.store.updateTask(t.task_key, {
                payload: JSON.stringify({
                  ...payload,
                  shadow_eval: blockedEval,
                }),
              });
            }
          }
        }
      } catch (e) {
        // Continue loop in shadow evaluation
      }
    }

    // 2. Evaluate active tasks: would advance based on completed delegations or state
    for (const t of finalActive) {
      if (getTaskMode(t.project_id) !== "shadow") continue;
      try {
        const payload = parsePayload(t.payload);
        const delegations = deps.store.delegationsByTask(t.task_key);
        const latestDel = getActiveDelegationForTask(t, delegations, deps.store);
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

        if (t.node === "code" || wouldTrans?.to_node === "code") {
          try {
            const tRepo = deps.resolveTaskRepoContext ? await Promise.resolve(deps.resolveTaskRepoContext(t)).catch(() => null) : null;
            const proj = t.project_id && deps.resolveProject ? await Promise.resolve(deps.resolveProject(t.project_id)).catch(() => null) : (deps.project ?? null);
            const tPreset = deps.policy?.routes?.[t.route]?.preset;
            const presetBaseBranch = await resolvePresetBaseBranch(tPreset, {
              bbCli: deps.bbCli,
              policy: deps.policy,
            });
            const effectiveRepo = tRepo?.repoRoot ?? repoRoot;
            let executorBaseSha: string | undefined;
            if (deps.cmd && effectiveRepo) {
              executorBaseSha = await resolveExecutorBaseSha({
                cmd: deps.cmd,
                repoRoot: effectiveRepo,
                baseBranch: presetBaseBranch ?? (proj as any)?.baseBranch ?? tRepo?.mergeBaseBranch,
              });
            }
            await verifySpecBeforeCodeGate({
              taskKey: t.task_key,
              store: deps.store,
              cmd: deps.cmd,
              repoRoot: effectiveRepo,
              baseSha: executorBaseSha,
              workGraphMode: getTaskMode(t.project_id),
              policy: deps.policy,
              project: proj,
              task: t,
              payload,
            });
          } catch (err: any) {
            if (err?.code === "spec-gate-violation") {
              const blockedEval = {
                command: "run-queue",
                evaluated_at: Date.now(),
                would_transition: wouldTrans,
                would_reject: "spec-gate-violation",
                would_block: { reason: "spec-gate-violation" },
                note: "вычислено, но не подключено",
                current_node: t.node,
                current_status: t.status,
              };
              deps.store.updateTask(t.task_key, {
                payload: JSON.stringify({
                  ...payload,
                  shadow_eval: blockedEval,
                }),
              });
            }
          }
        }
      } catch (e) {
        // Continue loop in shadow evaluation
      }
    }
  }

  return {
    ok: true,
    activeCount: nonOffActive.length,
    queuedCount: nonOffQueued.length,
    readyCount,
    advancedCount,
    tasks: nonOffQueued,
    transitions,
  };
}

async function dispatchTaskNode(
  deps: RunQueueDeps,
  task: TaskQueueRow,
  node: TaskNode,
  repoRoot: string,
): Promise<void> {
  if (node === "code") {
    const taskMode = deps.getWorkGraphMode?.(task.project_id) ?? deps.workGraphMode ?? "off";
    const proj = task.project_id && deps.resolveProject
      ? await Promise.resolve(deps.resolveProject(task.project_id)).catch(() => null)
      : (deps.project ?? null);
    let executorBaseSha: string | undefined;
    let presetBaseBranch: string | null = null;
    if (deps.cmd && repoRoot) {
      const presetName = deps.policy?.routes?.[task.route]?.preset;
      presetBaseBranch = await resolvePresetBaseBranch(presetName, {
        bbCli: deps.bbCli,
        policy: deps.policy,
      });
      try {
        executorBaseSha = await resolveExecutorBaseSha({
          cmd: deps.cmd,
          repoRoot,
          baseBranch: presetBaseBranch ?? (proj as any)?.baseBranch,
        });
      } catch {}
    }
    await verifySpecBeforeCodeGate({
      taskKey: task.task_key,
      store: deps.store,
      cmd: deps.cmd,
      repoRoot,
      baseSha: executorBaseSha,
      workGraphMode: taskMode,
      policy: deps.policy,
      project: proj,
      task,
    });
  }
  await deps.dispatchNode?.(task, node);
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
  const now = deps.now ? deps.now() : Date.now();

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
          const branchHead = revBranch.stdout.trim();
          let isOnlyAcceptanceCommit = false;
          if (task.acceptance_sha && branchHead) {
            if (branchHead === task.acceptance_sha) {
              isOnlyAcceptanceCommit = true;
            } else {
              const diffRes = await deps.cmd.run(
                "git",
                ["diff", "--quiet", task.acceptance_sha, branchHead],
                { cwd: repoRoot },
              );
              if (diffRes.exitCode === 0) {
                isOnlyAcceptanceCommit = true;
              }
            }
          }
          if (!isOnlyAcceptanceCommit) {
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
          const reason = `git-failed: не удалось создать ветку ${branch}: ${branchRes.stderr.trim()}`;
          const failTr = resolveTransition({
            route: task.route,
            node: "start",
            status: "queued",
            event: { type: "git_failure", reason, gitError: reason },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
          if (!failTr.allowed) {
            throw new OrchestratorError(
              failTr.errorCode ?? "invalid-transition",
              failTr.errorMessage ?? failTr.reason,
            );
          }
          deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "start",
            expectedStatus: "queued",
            toNode: failTr.toNode,
            toStatus: failTr.toStatus,
            actor: "run-queue",
            reason: failTr.reason,
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
    const accText = payload.acceptance_text ?? null;
    if (accText && branch) {
      if (!deps.cmd) {
        const reason = "git-failed: missing cmd runner for acceptance commit";
        const failTr = resolveTransition({
          route: task.route,
          node: "start",
          status: "queued",
          event: { type: "git_failure", reason },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!failTr.allowed) {
          throw new OrchestratorError(
            failTr.errorCode ?? "invalid-transition",
            failTr.errorMessage ?? failTr.reason,
          );
        }
        deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "start",
          expectedStatus: "queued",
          toNode: failTr.toNode,
          toStatus: failTr.toStatus,
          actor: "run-queue",
          reason: failTr.reason,
        });
        return false;
      }
      try {
        acceptanceSha = await commitAcceptanceContract(
          deps.cmd,
          repoRoot,
          branch,
          task.task_key,
          String(accText),
        );
      } catch (e: any) {
        const reason = `git-failed: ${e?.message ?? e}`;
        const failTr = resolveTransition({
          route: task.route,
          node: "start",
          status: "queued",
          event: { type: "git_failure", reason },
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!failTr.allowed) {
          throw new OrchestratorError(
            failTr.errorCode ?? "invalid-transition",
            failTr.errorMessage ?? failTr.reason,
          );
        }
        deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "start",
          expectedStatus: "queued",
          toNode: failTr.toNode,
          toStatus: failTr.toStatus,
          actor: "run-queue",
          reason: failTr.reason,
        });
        return false;
      }
    }
  } else if (task.route === "docs") {
    acceptanceSha = null;
  }

  const cleanedPayload = { ...payload };
  delete (cleanedPayload as any).queued_stalled;
  if (resolution.action?.setPayload) {
    Object.assign(cleanedPayload, resolution.action.setPayload);
  }

  let startReason = resolution.reason;

  // §34.5 (ADR-0037): TDD Fail-First Verification for fix/simple routes (both auto and manual)
  if ((task.route === "fix" || task.route === "simple") && acceptanceSha) {
    const tdd = deps.runTddCheck
      ? await deps.runTddCheck(task, acceptanceSha)
      : await runTddFailFirstVerification(
          { cmd: deps.cmd, repoRoot },
          task,
          acceptanceSha,
          DEFAULT_ALLOWED_RUNNERS,
          deps.policy?.checks,
        );
    if (tdd.notRun) {
      deps.log?.warn?.(
        `[orchestrator] tdd fail-first check not run for ${task.task_key}: ${tdd.output}`,
      );
      const failTr = resolveTransition({
        route: task.route,
        node: "start",
        status: "queued",
        event: {
          type: "git_failure",
          reason: `tdd-check-not-run: ${tdd.output}`,
        },
        mode: task.confirmation_mode,
        counters: extractCounters(task),
      });
      if (failTr.allowed) {
        deps.store.transitionTask(
          {
            taskKey: task.task_key,
            expectedNode: "start",
            expectedStatus: "queued",
            toNode: failTr.toNode,
            toStatus: failTr.toStatus,
            actor: "machine:checks",
            reason: failTr.reason,
            updates: {
              branch,
              acceptance_sha: acceptanceSha,
            },
            now,
          },
          now,
        );
      }
      return false;
    }
    if (!tdd.failedAsExpected) {
      const vacuousTr = resolveTransition({
        route: task.route,
        node: "start",
        status: "queued",
        event: {
          type: "acceptance_vacuous",
          reason:
            "acceptance-contract-vacuous: договор приёмки уже полностью проходит на неизменённом коде",
        },
        mode: task.confirmation_mode,
        counters: extractCounters(task),
      });
      if (vacuousTr.allowed) {
        delete (payload as any).queued_stalled;
        delete (payload as any).queued_stalled_alarm_at;
        const updates: Partial<TaskQueueRow> = {
          branch,
          acceptance_sha: acceptanceSha,
          payload: JSON.stringify({
            ...payload,
            ...(vacuousTr.action?.setPayload ?? {}),
          }),
        };
        if (vacuousTr.counterUpdates) {
          Object.assign(updates, vacuousTr.counterUpdates);
        }
        const vtr = deps.store.transitionTask(
          {
            taskKey: task.task_key,
            expectedNode: "start",
            expectedStatus: "queued",
            toNode: vacuousTr.toNode,
            toStatus: vacuousTr.toStatus,
            actor: "machine:checks",
            reason: vacuousTr.reason,
            updates,
            timeoutSeconds: getNodeTimeoutSeconds(
              deps.policy,
              vacuousTr.toNode,
            ),
          },
          now,
        );
        if (vtr.ok && vtr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (vacuousTr.action?.dispatchNode) {
            await dispatchTaskNode(
              deps,
              vtr.task,
              vacuousTr.action.dispatchNode,
              repoRoot,
            );
          }
          return true;
        }
        return false;
      }
    }

    // §34.5 / Reviewer Б1-в: Record TDD verification outcome in task payload
    cleanedPayload.tdd_outcome = tdd.outcome;
    if (tdd.newTestFiles && tdd.newTestFiles.length > 0) {
      cleanedPayload.tdd_new_tests = tdd.newTestFiles;
    }
    if (tdd.commands && tdd.commands.length > 0) {
      cleanedPayload.tdd_commands = tdd.commands;
    }
    cleanedPayload.tdd_output = tdd.output;
    const checksRun = ((cleanedPayload.checks_run as Record<string, unknown>) || {});
    checksRun.tdd = {
      outcome: tdd.outcome,
      new_tests: tdd.newTestFiles ?? [],
      commands: tdd.commands ?? [],
      output: tdd.output,
    };
    cleanedPayload.checks_run = checksRun;
    if (tdd.outcome === "skipped_new_test") {
      startReason = `${resolution.reason} [tdd: skipped_new_test (${(tdd.newTestFiles ?? []).join(", ")})]`;
    }
  }

  // §31.9: For routes without owner gate (auto mode for fix/simple), persist contract with approvalId
  // ONLY if explicit and valid acceptance contract text was provided
  if (
    (task.route === "fix" || task.route === "simple") &&
    task.confirmation_mode === "auto"
  ) {
    const existingContract = deps.store.getSpecContract(task.task_key);
    if (!existingContract?.approval_id && payload.acceptance_text) {
      const parsed = parseContractFromText(String(payload.acceptance_text));
      if (parsed) {
        const isMechanicalValid = parsed.kind === "mechanical" && Boolean(parsed.mechanicalBasis && parsed.mechanicalBasis.trim());
        const isBugfixValid = parsed.kind === "bugfix" && Boolean(parsed.specPath || parsed.specSection);
        const isBehaviorValid = parsed.kind === "behavior_change" && Boolean(parsed.specPath);
        if (isMechanicalValid) {
          const approvalId = `appr:${task.project_id ?? "proj"}:${normKey}:mech:${now}`;
          deps.store.saveSpecContract(
            {
              ...parsed,
              taskKey: task.task_key,
              projectId: task.project_id ?? undefined,
              approvalId,
            },
            now,
          );
          cleanedPayload.approval_id = approvalId;
        } else if (isBugfixValid || isBehaviorValid) {
          const specSha = parsed.specSha || acceptanceSha;
          if (specSha && specSha !== "base") {
            const approvalId = `appr:${task.project_id ?? "proj"}:${normKey}:${specSha}:${now}`;
            deps.store.saveSpecContract(
              {
                ...parsed,
                taskKey: task.task_key,
                projectId: task.project_id ?? undefined,
                specSha,
                approvalId,
              },
              now,
            );
            cleanedPayload.approval_id = approvalId;
          }
        }
      }
    }
  }

  // §31.9: verify spec-before-code gate BEFORE transitioning to code
  if (resolution.toNode === "code" || resolution.action?.dispatchNode === "code") {
    const taskMode =
      deps.getWorkGraphMode?.(task.project_id) ??
      resolveWorkGraphMode(
        task.project_id,
        deps.workGraphMode,
        deps.workGraphProjects,
      );
    const proj = task.project_id && deps.resolveProject
      ? await Promise.resolve(deps.resolveProject(task.project_id)).catch(() => null)
      : (deps.project ?? null);
    let executorBaseSha: string | undefined;
    let presetBaseBranch: string | null = null;
    if (deps.cmd && repoRoot) {
      const presetName = deps.policy?.routes?.[task.route]?.preset;
      presetBaseBranch = await resolvePresetBaseBranch(presetName, {
        bbCli: deps.bbCli,
        policy: deps.policy,
      });
      try {
        executorBaseSha = await resolveExecutorBaseSha({
          cmd: deps.cmd,
          repoRoot,
          baseBranch: presetBaseBranch ?? (proj as any)?.baseBranch,
        });
      } catch {}
    }
    try {
      await verifySpecBeforeCodeGate({
        taskKey: task.task_key,
        store: deps.store,
        cmd: deps.cmd,
        repoRoot,
        baseSha: executorBaseSha,
        baseBranchName: presetBaseBranch ?? (proj as any)?.baseBranch,
        workGraphMode: taskMode,
        policy: deps.policy,
        project: proj,
        task: { ...task, payload: JSON.stringify(cleanedPayload), acceptance_sha: acceptanceSha },
        payload: cleanedPayload,
      });
    } catch (gateErr: any) {
      if (gateErr?.code === "spec-gate-violation") {
        if (taskMode === "shadow") {
          const blockedEval = {
            command: "run-queue",
            evaluated_at: now,
            would_reject: "spec-gate-violation",
            would_block: { reason: gateErr.message },
            current_node: task.node,
            current_status: task.status,
          };
          cleanedPayload.shadow_eval = blockedEval;
          deps.store.updateTask(task.task_key, {
            payload: JSON.stringify(cleanedPayload),
          });
          return false;
        } else {
          deps.log?.warn?.(`orchestrator: task ${task.task_key} refused by spec gate: ${gateErr.message}`);
          const prevGateErr = (cleanedPayload as any)?.spec_gate_error;
          cleanedPayload.spec_gate_error = gateErr.message;
          deps.store.updateTask(task.task_key, {
            payload: JSON.stringify(cleanedPayload),
          });
          if (prevGateErr !== gateErr.message && task.coordinator_thread_id && deps.bbCli) {
            deps.bbCli.run([
              "thread",
              "tell",
              task.coordinator_thread_id,
              `[orchestrator] Задача ${task.task_key} не может быть запущена: ${gateErr.message}`,
            ]).catch(() => {});
          }
          return false;
        }
      } else {
        throw gateErr;
      }
    }
  }

  const tr = deps.store.transitionTask({
    taskKey: task.task_key,
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: resolution.toNode,
    toStatus: resolution.toStatus,
    actor: "run-queue",
    reason: startReason,
    updates: {
      branch,
      acceptance_sha: acceptanceSha,
      payload: JSON.stringify(cleanedPayload),
    },
    timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
  }, now);

  if (tr.ok && tr.task) {
    const logged = deps.store.listTransitions(task.task_key).at(-1);
    if (logged) transitions.push(logged);
    if (resolution.toStatus === "running" && resolution.action?.dispatchNode) {
      await dispatchTaskNode(deps, tr.task, resolution.action.dispatchNode, repoRoot);
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
  store?: DelegationStore,
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
  // Anchor check: latest delegation must not predate when the task entered the current node.
  // Priority: 1) payload.node_entered_at, 2) task_transitions to_node = task.node, 3) task.entered_at.
  let nodeEnteredAt: number | undefined;
  if (typeof payload.node_entered_at === "number" && payload.node_entered_at > 0) {
    nodeEnteredAt = payload.node_entered_at;
  } else if (store) {
    nodeEnteredAt = store.getNodeEntryTime(task.task_key, task.node);
  }
  if (nodeEnteredAt === undefined || nodeEnteredAt <= 0) {
    nodeEnteredAt = task.entered_at;
  }
  if (nodeEnteredAt > 0 && latest.created_at < nodeEnteredAt - 50) {
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

/** §28.2: Отображение сбоя / таймаута узла в событие матрицы переходов. */
export function getFailEventForNode(node: TaskNode, reason: string): TransitionEvent | null {
  switch (node) {
    case "design":
      return { type: "design_failed", exhausted: true, reason };
    case "spec":
      return { type: "spec_failed", exhausted: true, reason };
    case "spec_review":
      return { type: "spec_review_failed", exhausted: true, reason };
    case "code":
      return { type: "code_failed", exhausted: true, reason };
    case "checks":
      return { type: "checks_result", notRun: true, exitCode: 1, output: reason };
    case "review":
      return { type: "review_failed", exhausted: true, reason };
    case "design_check":
      return { type: "design_check_failed", exhausted: true, reason };
    case "release":
      return { type: "release_failed_script", reason };
    case "research":
      return { type: "research_failed", exhausted: true, reason };
    default:
      return null;
  }
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
  const latestDelegation = getActiveDelegationForTask(task, delegations, deps.store);
  const now = deps.now ? deps.now() : Date.now();

  // §28.2 п. 5: Сброс будильника узла при получении нового доказательства:
  // 1) Новый коммит в ветке задачи task.branch
  if (task.status === "running" && ACTIVE_ALARM_NODES.has(task.node) && task.branch && deps.cmd) {
    try {
      const rev = await deps.cmd.run("git", ["rev-parse", `refs/heads/${task.branch}`], { cwd: repoRoot });
      if (rev.exitCode === 0) {
        const currentSha = rev.stdout.trim();
        const lastSha = typeof payload.last_alarm_branch_sha === "string" ? payload.last_alarm_branch_sha : null;
        if (lastSha === null) {
          payload.last_alarm_branch_sha = currentSha;
          deps.store.updateTask(task.task_key, {
            payload: JSON.stringify(payload),
          });
          task.payload = JSON.stringify(payload);
        } else if (currentSha !== lastSha) {
          payload.last_alarm_branch_sha = currentSha;
          payload.alarm_count = 0;
          const timeoutSeconds = getNodeTimeoutSeconds(deps.policy, task.node);
          const nextAlarm = now + timeoutSeconds * 1000;
          deps.store.updateTask(task.task_key, {
            node_alarm_at: nextAlarm,
            payload: JSON.stringify(payload),
          });
          task.node_alarm_at = nextAlarm;
          task.payload = JSON.stringify(payload);
        }
      }
    } catch {}
  }

  // 2) Запись вердикта ревью для коммита этой задачи
  if (
    task.status === "running" &&
    (task.node === "review" || task.node === "spec_review" || task.node === "design_check")
  ) {
    const currentVerdict =
      task.node === "review"
        ? (typeof payload.review_verdict === "string" ? payload.review_verdict : null)
        : task.node === "spec_review"
        ? (typeof payload.spec_review_verdict === "string" ? payload.spec_review_verdict : null)
        : task.node === "design_check"
        ? (typeof payload.design_check_verdict === "string" ? payload.design_check_verdict : null)
        : null;
    if (currentVerdict) {
      const verdictKey = `${task.node}:${latestDelegation?.id ?? 0}:${currentVerdict}`;
      const lastVerdict = typeof payload.last_alarm_verdict === "string" ? payload.last_alarm_verdict : null;
      if (lastVerdict !== verdictKey) {
        payload.last_alarm_verdict = verdictKey;
        payload.alarm_count = 0;
        const timeoutSeconds = getNodeTimeoutSeconds(deps.policy, task.node);
        const nextAlarm = now + timeoutSeconds * 1000;
        deps.store.updateTask(task.task_key, {
          node_alarm_at: nextAlarm,
          payload: JSON.stringify(payload),
        });
        task.node_alarm_at = nextAlarm;
        task.payload = JSON.stringify(payload);
      }
    }
  }

  // §28.2 п. 5: Срабатывание будильника узла (node_alarm_at)
  if (
    task.node_alarm_at !== null &&
    now >= task.node_alarm_at &&
    task.status === "running" &&
    ACTIVE_ALARM_NODES.has(task.node)
  ) {
    const timeoutSeconds = getNodeTimeoutSeconds(deps.policy, task.node);
    const alarmCount = typeof payload.alarm_count === "number" ? payload.alarm_count : 0;
    const elapsedSeconds = Math.max(0, Math.round((now - (task.entered_at ?? now)) / 1000));

    const isDelegationNode = task.node !== "checks" && task.node !== "release";
    const threadId = isDelegationNode ? latestDelegation?.thread_id : null;

    let isThreadRunning = false;
    if (threadId && deps.getThread) {
      try {
        const th = await deps.getThread(threadId);
        if (
          th &&
          (th.status === "active" ||
            th.status === "starting" ||
            th.status === "pending")
        ) {
          isThreadRunning = true;
        }
      } catch {}
    }

    if (alarmCount === 0) {
      // 1-е срабатывание (1x timeout): повторный пинг исполнителя узла
      if (threadId && deps.bbCli) {
        await deps.bbCli
          .run([
            "thread",
            "tell",
            threadId,
            `Напоминание будильника: превышено время ожидания на узле ${task.node} (${timeoutSeconds}с). Сдай результат.`,
          ])
          .catch(() => {});
      }
      deps.store.recordTaskEvent(
        "task.alarm_triggered",
        {
          task: task.task_key,
          taskKey: task.task_key,
          node: task.node,
          elapsedSeconds,
          alarmCount: 1,
          threadRunning: isThreadRunning,
        },
        now,
      );
      payload.alarm_count = 1;
      const nextAlarm = now + timeoutSeconds * 1000;
      deps.store.updateTask(task.task_key, {
        node_alarm_at: nextAlarm,
        payload: JSON.stringify(payload),
      });
      task.node_alarm_at = nextAlarm;
      task.payload = JSON.stringify(payload);
      return true;
    } else if (alarmCount === 1 && isThreadRunning && elapsedSeconds < 3 * timeoutSeconds) {
      // 2-е срабатывание (2x timeout), но исполнитель в активном выполнении хода: даём до 3× timeout_seconds
      if (threadId && deps.bbCli) {
        await deps.bbCli
          .run([
            "thread",
            "tell",
            threadId,
            `Напоминание будильника: превышено расчетное время на узле ${task.node} (${timeoutSeconds * 2}с). Заверши ход или сдай результат.`,
          ])
          .catch(() => {});
      }
      deps.store.recordTaskEvent(
        "task.alarm_triggered",
        {
          task: task.task_key,
          taskKey: task.task_key,
          node: task.node,
          elapsedSeconds,
          alarmCount: 2,
          threadRunning: true,
        },
        now,
      );
      payload.alarm_count = 2;
      const nextAlarm = now + timeoutSeconds * 1000;
      deps.store.updateTask(task.task_key, {
        node_alarm_at: nextAlarm,
        payload: JSON.stringify(payload),
      });
      task.node_alarm_at = nextAlarm;
      task.payload = JSON.stringify(payload);
      return true;
    } else {
      // Остановка треда и перевод в stalled (предел времени превышен)
      if (threadId) {
        if (deps.stopThread) {
          await deps.stopThread(threadId).catch(() => {});
        } else if (deps.bbCli) {
          await deps.bbCli.run(["thread", "stop", threadId]).catch(() => {});
        }
      }
      deps.store.recordTaskEvent(
        "task.alarm_triggered",
        {
          task: task.task_key,
          taskKey: task.task_key,
          node: task.node,
          elapsedSeconds,
          alarmCount: alarmCount + 1,
          outcome: "stalled",
        },
        now,
      );

      const maxSec = (alarmCount >= 2 || isThreadRunning) ? timeoutSeconds * 3 : timeoutSeconds * 2;
      const failReason = `node-alarm-timeout: узел ${task.node} превысил предельное время ожидания (${maxSec}с)`;
      const failEvent = getFailEventForNode(task.node, failReason);
      if (failEvent) {
        const resolution = resolveTransition({
          route: task.route,
          node: task.node,
          status: "running",
          event: failEvent,
          mode: task.confirmation_mode,
          counters: extractCounters(task),
        });
        if (!resolution.allowed) {
          throw new OrchestratorError(
            resolution.errorCode ?? "invalid-transition",
            resolution.errorMessage ?? resolution.reason,
          );
        }

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
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
            node_alarm_at: null,
            payload: JSON.stringify({
              ...payload,
              alarm_count: 0,
              consumed_delegations: consumed,
            }),
          },
        }, now);
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          return true;
        }
      }
    }
  }

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
            const reason = "git-failed: missing cmd runner for acceptance commit";
            const failTr = resolveTransition({
              route: task.route,
              node: "design",
              status: "running",
              event: { type: "git_failure", reason },
              mode: task.confirmation_mode,
              counters: extractCounters(task),
            });
            if (!failTr.allowed) {
              throw new OrchestratorError(
                failTr.errorCode ?? "invalid-transition",
                failTr.errorMessage ?? failTr.reason,
              );
            }
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design",
              expectedStatus: "running",
              toNode: failTr.toNode,
              toStatus: failTr.toStatus,
              actor: "run-queue",
              reason: failTr.reason,
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
            const reason = `git-failed: ${e?.message ?? e}`;
            const failTr = resolveTransition({
              route: task.route,
              node: "design",
              status: "running",
              event: { type: "git_failure", reason },
              mode: task.confirmation_mode,
              counters: extractCounters(task),
            });
            if (!failTr.allowed) {
              throw new OrchestratorError(
                failTr.errorCode ?? "invalid-transition",
                failTr.errorMessage ?? failTr.reason,
              );
            }
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design",
              expectedStatus: "running",
              toNode: failTr.toNode,
              toStatus: failTr.toStatus,
              actor: "run-queue",
              reason: failTr.reason,
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

        const archRoute =
          latestDelegation?.route ?? payload.design_architect_route ?? null;
        const archProvider =
          latestDelegation?.provider ??
          payload.design_architect_provider ??
          null;
        const archModel =
          (typeof archRoute === "string" && deps.policy?.routes[archRoute]?.model) ? deps.policy.routes[archRoute].model : payload.design_architect_model ?? null;

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
              ...(resolution.action?.setPayload ?? {}),
              design_done: false,
              acceptance_text: contractText,
              design_architect_route: archRoute,
              design_architect_provider: archProvider,
              design_architect_model: archModel,
              consumed_delegations: consumed,
              nudge_count: 0,
              last_nudge_at: null,
            }),
          },
          timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
        }, now);
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await dispatchTaskNode(deps, tr.task, resolution.action.dispatchNode, repoRoot);
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
          const reason = `design-no-report: exhausted ${nudgeCount} nudges without acceptance contract`;
          const tr = resolveTransition({
            route: task.route,
            node: "design",
            status: "running",
            event: {
              type: "design_question_or_no_report",
              exhausted: true,
              nudgeCount,
              reason,
            },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
          if (!tr.allowed) {
            throw new OrchestratorError(
              tr.errorCode ?? "invalid-transition",
              tr.errorMessage ?? tr.reason,
            );
          }
          deps.store.transitionTask({
            taskKey: task.task_key,
            expectedNode: "design",
            expectedStatus: "running",
            toNode: tr.toNode,
            toStatus: tr.toStatus,
            actor: "run-queue",
            reason: tr.reason,
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
              `Сдай архитектурное решение и текст договора приёмки для docs/specs/acceptance/${task.task_key}.md`,
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
            const reason = `spec-no-report: exhausted ${nudgeCount} nudges without commit`;
            const tr = resolveTransition({
              route: task.route,
              node: "spec",
              status: "running",
              event: {
                type: "spec_question_or_no_report",
                exhausted: true,
                nudgeCount,
                reason,
              },
              mode: task.confirmation_mode,
              counters: extractCounters(task),
            });
            if (!tr.allowed) {
              throw new OrchestratorError(
                tr.errorCode ?? "invalid-transition",
                tr.errorMessage ?? tr.reason,
              );
            }
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec",
              expectedStatus: "running",
              toNode: tr.toNode,
              toStatus: tr.toStatus,
              actor: "run-queue",
              reason: tr.reason,
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
        let detectedSpecFiles: string[] = [];
        let detectedAdrFiles: string[] = [];
        if (deps.cmd && specSha && !specSha.startsWith("sha-")) {
          try {
            let branchRes = await deps.cmd.run(
              "git",
              ["diff", "--name-only", `${mergeBaseBranch}...${specSha}`],
              { cwd: repoRoot },
            );
            if (branchRes.exitCode !== 0) {
              branchRes = await deps.cmd.run(
                "git",
                ["diff", "--name-only", `${specSha}~1`, specSha],
                { cwd: repoRoot },
              );
            }
            if (branchRes.exitCode !== 0) {
              branchRes = await deps.cmd.run(
                "git",
                ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", specSha],
                { cwd: repoRoot },
              );
            }
            if (branchRes.exitCode === 0) {
              const files = branchRes.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
              filesOutsideDocs = files.some(
                (f) => !f.startsWith("docs/") && !f.endsWith(".md"),
              );
              detectedSpecFiles = files.filter(
                (f) => f.startsWith("docs/specs/") && f.endsWith(".md") && !f.includes("/acceptance/"),
              );
              if (detectedSpecFiles.length === 0) {
                detectedSpecFiles = files.filter(
                  (f) => f.startsWith("docs/") && f.endsWith(".md") && !f.startsWith("docs/adr/"),
                );
              }
              detectedAdrFiles = files.filter(
                (f) => f.startsWith("docs/adr/") && f.endsWith(".md"),
              );
            }
            if (detectedSpecFiles.length === 0 && detectedAdrFiles.length === 0) {
              const treeRes = await deps.cmd.run(
                "git",
                ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", specSha],
                { cwd: repoRoot },
              );
              if (treeRes.exitCode === 0) {
                const files = treeRes.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
                detectedSpecFiles = files.filter(
                  (f) => f.startsWith("docs/specs/") && f.endsWith(".md") && !f.includes("/acceptance/"),
                );
                if (detectedSpecFiles.length === 0) {
                  detectedSpecFiles = files.filter(
                    (f) => f.startsWith("docs/") && f.endsWith(".md") && !f.startsWith("docs/adr/"),
                  );
                }
                detectedAdrFiles = files.filter(
                  (f) => f.startsWith("docs/adr/") && f.endsWith(".md"),
                );
              }
            }
          } catch {}
        }

        let specRefCheck: SpecReferenceCheckResult = { valid: true };
        if (deps.verifySpecReferences) {
          specRefCheck = await deps.verifySpecReferences(task, specSha, mergeBaseBranch);
        } else if (deps.cmd && specSha && !specSha.startsWith("sha-")) {
          try {
            specRefCheck = await verifySpecReferences(
              { cmd: deps.cmd, repoRoot },
              task,
              specSha,
              mergeBaseBranch,
            );
          } catch (err: any) {
            specRefCheck = { valid: false, notRun: true, reason: err?.message };
          }
        }

        if (specRefCheck.notRun) {
          return false;
        }

        let resolution: TransitionResolution;
        if (!specRefCheck.valid) {
          resolution = resolveTransition({
            route: task.route,
            node: "spec",
            status: "running",
            event: {
              type: "spec_invalid_reference",
              invalidCodebaseReference: true,
              specSha,
              reason: specRefCheck.reason,
            },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
        } else {
          resolution = resolveTransition({
            route: task.route,
            node: "spec",
            status: "running",
            event: {
              type: "spec_delivered",
              specSha,
              acceptanceTampered: tampered,
              filesOutsideDocs,
              invalidCodebaseReference: false,
            },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
        }
        if (!resolution.allowed) return false;

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
          consumed.push(latestDelegation.id);
        }

        const specRoute =
          latestDelegation?.route ?? payload.last_executor_route ?? null;
        const specProvider =
          latestDelegation?.provider ??
          payload.last_executor_provider ??
          null;
        const specModel =
          (typeof specRoute === "string" && deps.policy?.routes[specRoute]?.model)
            ? deps.policy.routes[specRoute].model
            : (latestDelegation as any)?.model ?? payload.last_executor_model ?? null;

        const updates: Partial<TaskQueueRow> = {
          spec_sha: specSha,
          payload: JSON.stringify({
            ...payload,
            ...(resolution.action?.setPayload ?? {}),
            spec_sha: specSha,
            ...(detectedSpecFiles.length > 0 ? { spec_path: detectedSpecFiles.join(", ") } : {}),
            ...(detectedAdrFiles.length > 0 ? { adr_path: detectedAdrFiles.join(", ") } : {}),
            is_architectural: detectedAdrFiles.length > 0,
            last_executor_route: specRoute,
            last_executor_provider: specProvider,
            last_executor_model: specModel,
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
          timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
        }, now);
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await dispatchTaskNode(deps, tr.task, resolution.action.dispatchNode, repoRoot);
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
            const reason = `no-verdict: exhausted ${nudgeCount} spec_review nudges`;
            const tr = resolveTransition({
              route: task.route,
              node: "spec_review",
              status: "running",
              event: {
                type: "spec_review_question_or_no_verdict",
                exhausted: true,
                nudgeCount,
                reason,
              },
              mode: task.confirmation_mode,
              counters: extractCounters(task),
            });
            if (!tr.allowed) {
              throw new OrchestratorError(
                tr.errorCode ?? "invalid-transition",
                tr.errorMessage ?? tr.reason,
              );
            }
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "spec_review",
              expectedStatus: "running",
              toNode: tr.toNode,
              toStatus: tr.toStatus,
              actor: "run-queue",
              reason: tr.reason,
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

        let tddOutcome: TddVerificationOutcome | undefined;
        let tddNewTests: string[] | undefined;
        let tddCommands: string[] | undefined;
        let tddOutput: string | undefined;

        // §34.5 (ADR-0037): TDD Fail-First Verification for feature route
        if (verdict === "OK" && task.acceptance_sha) {
          const tdd = deps.runTddCheck
            ? await deps.runTddCheck(task, task.acceptance_sha)
            : await runTddFailFirstVerification(
                { cmd: deps.cmd, repoRoot },
                task,
                task.acceptance_sha,
                DEFAULT_ALLOWED_RUNNERS,
                deps.policy?.checks,
              );
          if (tdd.notRun) {
            deps.log?.warn?.(
              `[orchestrator] tdd fail-first check not run for ${task.task_key}: ${tdd.output}`,
            );
            const failTr = resolveTransition({
              route: task.route,
              node: "spec_review",
              status: "running",
              event: {
                type: "spec_review_failed",
                exhausted: true,
                reason: `tdd-check-not-run: ${tdd.output}`,
              },
              mode: task.confirmation_mode,
              counters: extractCounters(task),
            });
            if (failTr.allowed) {
              deps.store.transitionTask(
                {
                  taskKey: task.task_key,
                  expectedNode: "spec_review",
                  expectedStatus: "running",
                  toNode: failTr.toNode,
                  toStatus: failTr.toStatus,
                  actor: "machine:checks",
                  reason: failTr.reason,
                  now,
                },
                now,
              );
              return false;
            }
          }
          if (!tdd.failedAsExpected) {
            const vacuousTr = resolveTransition({
              route: task.route,
              node: "spec_review",
              status: "running",
              event: {
                type: "acceptance_vacuous",
                reason:
                  "acceptance-contract-vacuous: договор приёмки не содержит падающих тестов; требуется доработка архитектором на узле design",
              },
              mode: task.confirmation_mode,
              counters: extractCounters(task),
            });
            if (vacuousTr.allowed) {
              const updates: Partial<TaskQueueRow> = {
                payload: JSON.stringify({
                  ...payload,
                  vacuous_contract: true,
                  spec_review_verdict: null,
                  spec_review_blockers: null,
                  consumed_delegations: consumed,
                  nudge_count: 0,
                  last_nudge_at: null,
                }),
              };
              if (vacuousTr.counterUpdates) {
                Object.assign(updates, vacuousTr.counterUpdates);
              }
              const vtr = deps.store.transitionTask(
                {
                  taskKey: task.task_key,
                  expectedNode: "spec_review",
                  expectedStatus: "running",
                  toNode: vacuousTr.toNode,
                  toStatus: vacuousTr.toStatus,
                  actor: "machine:checks",
                  reason: vacuousTr.reason,
                  updates,
                  timeoutSeconds: getNodeTimeoutSeconds(
                    deps.policy,
                    vacuousTr.toNode,
                  ),
                },
                now,
              );
              if (vtr.ok && vtr.task) {
                const logged = deps.store.listTransitions(task.task_key).at(-1);
                if (logged) transitions.push(logged);
                if (vacuousTr.action?.dispatchNode) {
                  await dispatchTaskNode(
                    deps,
                    vtr.task,
                    vacuousTr.action.dispatchNode,
                    repoRoot,
                  );
                }
                return true;
              }
              return false;
            }
          }

          tddOutcome = tdd.outcome;
          tddNewTests = tdd.newTestFiles;
          tddCommands = tdd.commands;
          tddOutput = tdd.output;
        }

        const checksRun = ((payload.checks_run as Record<string, unknown>) || {});
        if (tddOutcome) {
          checksRun.tdd = {
            outcome: tddOutcome,
            new_tests: tddNewTests ?? [],
            commands: tddCommands ?? [],
            output: tddOutput,
          };
        }

        const updates: Partial<TaskQueueRow> = {
          payload: JSON.stringify({
            ...payload,
            ...(resolution.action?.setPayload ?? {}),
            tdd_outcome: tddOutcome ?? payload.tdd_outcome,
            tdd_new_tests: tddNewTests ?? payload.tdd_new_tests,
            tdd_commands: tddCommands ?? payload.tdd_commands,
            tdd_output: tddOutput ?? payload.tdd_output,
            checks_run: Object.keys(checksRun).length > 0 ? checksRun : payload.checks_run,
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

        const transReason =
          tddOutcome === "skipped_new_test"
            ? `${resolution.reason} [tdd: skipped_new_test (${(tddNewTests ?? []).join(", ")})]`
            : resolution.reason;

        const tr = deps.store.transitionTask({
          taskKey: task.task_key,
          expectedNode: "spec_review",
          expectedStatus: "running",
          toNode: resolution.toNode,
          toStatus: resolution.toStatus,
          actor: "run-queue",
          reason: transReason,
          updates: Object.keys(updates).length > 0 ? updates : undefined,
          timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
        }, now);
        if (tr.ok && tr.task) {
          if (verdict === "OK" && blockers === 0) {
            if (task.confirmation_mode === "auto") {
              const approvedContract = resolveTaskSpecContract(task.task_key, deps.store, payload, { task: tr.task });
              if (approvedContract) {
                const specSha =
                  tr.task?.spec_sha ||
                  task.spec_sha ||
                  approvedContract.specSha ||
                  ((payload as any)?.spec_sha ?? (payload as any)?.specSha) ||
                  task.acceptance_sha;
                if (specSha && specSha !== "base") {
                  const approvalId = `appr:${task.project_id ?? "proj"}:${normKey}:${specSha}:${now}`;
                  deps.store.saveSpecContract(
                    {
                      ...approvedContract,
                      taskKey: task.task_key,
                      projectId: task.project_id ?? undefined,
                      specSha,
                      approvalId,
                    },
                    now,
                  );
                }
              }
            }
          } else if (verdict === "CHANGES") {
            if (resolution.toNode === "spec" || resolution.toNode === "design") {
              deps.store.revokeSpecContractApproval(task.task_key, now);
            }
          }
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await dispatchTaskNode(deps, tr.task, resolution.action.dispatchNode, repoRoot);
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
            const reason = `code-no-commits: exhausted ${nudgeCount} nudges without commits`;
            const tr = resolveTransition({
              route: task.route,
              node: "code",
              status: "running",
              event: {
                type: "code_question_or_no_report",
                exhausted: true,
                nudgeCount,
                reason,
              },
              mode: task.confirmation_mode,
              counters: extractCounters(task),
            });
            if (!tr.allowed) {
              throw new OrchestratorError(
                tr.errorCode ?? "invalid-transition",
                tr.errorMessage ?? tr.reason,
              );
            }
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "code",
              expectedStatus: "running",
              toNode: tr.toNode,
              toStatus: tr.toStatus,
              actor: "run-queue",
              reason: tr.reason,
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

        let routeLimitRes: RouteLimitsCheckResult = { violated: false };
        if (deps.checkRouteLimits) {
          routeLimitRes = await deps.checkRouteLimits(task, resultSha);
        } else if (
          deps.cmd &&
          resultSha &&
          !resultSha.startsWith("sha-") &&
          (task.route === "fix" || task.route === "simple")
        ) {
          try {
            routeLimitRes = await checkRouteLimits(
              { cmd: deps.cmd, repoRoot },
              task,
              resultSha,
              deps.policy?.routeLimits,
            );
          } catch {}
        }

        let resolution: TransitionResolution;
        if (routeLimitRes.violated) {
          resolution = resolveTransition({
            route: task.route,
            node: "code",
            status: "running",
            event: {
              type: "code_route_violation",
              routeViolation: true,
              resultSha,
              reason: routeLimitRes.reason,
            },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
        } else {
          resolution = resolveTransition({
            route: task.route,
            node: "code",
            status: "running",
            event: {
              type: "code_delivered",
              resultSha,
              commits,
              noCode: Boolean(payload.no_code),
              acceptanceTampered: tampered,
              routeViolation: false,
            },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
        }
        if (!resolution.allowed) return false;

        const consumed = Array.isArray(payload.consumed_delegations)
          ? [...(payload.consumed_delegations as number[])]
          : [];
        if (latestDelegation && !consumed.includes(latestDelegation.id)) {
          consumed.push(latestDelegation.id);
        }

        const execRoute =
          latestDelegation?.route ?? payload.last_executor_route ?? null;
        const execProvider =
          latestDelegation?.provider ??
          payload.last_executor_provider ??
          null;
        const execModel =
          (typeof execRoute === "string" && deps.policy?.routes[execRoute]?.model)
            ? deps.policy.routes[execRoute].model
            : (latestDelegation as any)?.model ?? payload.last_executor_model ?? null;

        const updates: Partial<TaskQueueRow> = {
          result_sha: resultSha,
          payload: JSON.stringify({
            ...payload,
            ...(resolution.action?.setPayload ?? {}),
            last_executor_route: execRoute,
            last_executor_provider: execProvider,
            last_executor_model: execModel,
            code_done: false,
            result_commits: null,
            acceptance_tampered: false,
            consumed_delegations: consumed,
            nudge_count: 0,
            last_nudge_at: null,
          }),
        };
        if (
          resolution.ruleId === "rule-32-code-route-violation" ||
          resolution.action?.setPayload?.route_escalated === "feature"
        ) {
          updates.route = "feature";
          updates.code_attempts = 0;
          updates.check_attempts = 0;
          updates.code_review_rounds = 0;
          updates.design_check_rounds = 0;
        }
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
          timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
        }, now);
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await dispatchTaskNode(deps, tr.task, resolution.action.dispatchNode, repoRoot);
          }
          return true;
        }
      }
      return false;
    }

    case "checks": {
      const checkResult = deps.runChecks
        ? await deps.runChecks(task)
        : await executeChecks(
            { cmd: deps.cmd, repoRoot },
            task,
            DEFAULT_ALLOWED_RUNNERS,
            deps.policy?.checks,
          );

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

      const existingChecksRun = ((payload.checks_run as Record<string, unknown>) || {});
      const checksRun = {
        ...existingChecksRun,
        ok: checkResult.ok,
        exitCode: checkResult.exitCode,
        output: checkResult.output,
        acceptance_verified: checkResult.acceptanceVerified,
        tdd: existingChecksRun.tdd ?? (payload.tdd_outcome ? {
          outcome: payload.tdd_outcome,
          new_tests: payload.tdd_new_tests,
          commands: payload.tdd_commands,
          output: payload.tdd_output,
        } : undefined),
      };

      const updates: Partial<TaskQueueRow> = {
        payload: JSON.stringify({
          ...payload,
          ...(resolution.action?.setPayload ?? {}),
          checks_run: checksRun,
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
        timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
      }, now);
      if (tr.ok && tr.task) {
        const logged = deps.store.listTransitions(task.task_key).at(-1);
        if (logged) transitions.push(logged);
        if (resolution.action?.dispatchNode) {
          await dispatchTaskNode(deps, tr.task, resolution.action.dispatchNode, repoRoot);
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
            const reason = `no-verdict: exhausted ${nudgeCount} review nudges`;
            const tr = resolveTransition({
              route: task.route,
              node: "review",
              status: "running",
              event: {
                type: "review_question_or_no_verdict",
                exhausted: true,
                nudgeCount,
                reason,
              },
              mode: task.confirmation_mode,
              counters: extractCounters(task),
            });
            if (!tr.allowed) {
              throw new OrchestratorError(
                tr.errorCode ?? "invalid-transition",
                tr.errorMessage ?? tr.reason,
              );
            }
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "review",
              expectedStatus: "running",
              toNode: tr.toNode,
              toStatus: tr.toStatus,
              actor: "run-queue",
              reason: tr.reason,
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

        let designCheckPacket: string | undefined;
        if (resolution.toNode === "design_check") {
          let acceptanceText = (payload.acceptance_text as string) ?? "";
          if (deps.cmd && repoRoot && task.acceptance_sha) {
            try {
              const showRes = await deps.cmd.run("git", [
                "-C",
                repoRoot,
                "show",
                `${task.acceptance_sha}:docs/specs/acceptance/${task.task_key}.md`,
              ]);
              if (showRes.exitCode === 0 && showRes.stdout) {
                acceptanceText = showRes.stdout;
              }
            } catch {}
          }
          let netDiff = (payload.net_diff as string) ?? "";
          const rSha = task.result_sha || latestDelegation?.result_sha;
          if (deps.cmd && repoRoot && task.acceptance_sha && rSha) {
            try {
              const diffRes = await deps.cmd.run("git", [
                "-C",
                repoRoot,
                "diff",
                `${task.acceptance_sha}..${rSha}`,
              ]);
              if (diffRes.exitCode === 0) {
                netDiff = diffRes.stdout;
              }
            } catch {}
          }
          const checksRunJson =
            (typeof payload.checks_output === "string" ? payload.checks_output : null) ??
            (typeof payload.checks_result_json === "string" ? payload.checks_result_json : null) ??
            JSON.stringify({ ok: true, exitCode: 0 });

          designCheckPacket = formatDesignCheckPacket({
            taskKey: task.task_key,
            acceptanceText,
            netDiff,
            checksRunJson,
            reviewVerdict: verdict,
            reviewComments:
              (typeof payload.review_comments === "string" ? payload.review_comments : undefined) ??
              (latestDelegation ? `Auditor verdict: ${verdict}` : undefined),
          });
        }

        const updates: Partial<TaskQueueRow> = {
          payload: JSON.stringify({
            ...payload,
            ...(resolution.action?.setPayload ?? {}),
            ...(designCheckPacket ? { design_check_packet: designCheckPacket } : {}),
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
          timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
        }, now);
        if (tr.ok && tr.task) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await dispatchTaskNode(deps, tr.task, resolution.action.dispatchNode, repoRoot);
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
          if (parsed.target === "design" || parsed.target === "code") {
            target = parsed.target;
          }
        } else {
          const lastNudge = typeof payload.last_nudge_at === "number" ? payload.last_nudge_at : 0;
          const nudgeCount = typeof payload.nudge_count === "number" ? payload.nudge_count : 0;
          const now = Date.now();

          if (nudgeCount > 0 && now - lastNudge < 60_000) {
            return false;
          }

          if (nudgeCount >= 3) {
            const reason = `no-verdict: exhausted ${nudgeCount} design_check nudges`;
            const tr = resolveTransition({
              route: task.route,
              node: "design_check",
              status: "running",
              event: {
                type: "design_check_question_or_no_verdict",
                exhausted: true,
                nudgeCount,
                reason,
              },
              mode: task.confirmation_mode,
              counters: extractCounters(task),
            });
            if (!tr.allowed) {
              throw new OrchestratorError(
                tr.errorCode ?? "invalid-transition",
                tr.errorMessage ?? tr.reason,
              );
            }
            deps.store.transitionTask({
              taskKey: task.task_key,
              expectedNode: "design_check",
              expectedStatus: "running",
              toNode: tr.toNode,
              toStatus: tr.toStatus,
              actor: "run-queue",
              reason: tr.reason,
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
                  'Заверши вердиктом: закончи строкой JSON {"verdict":"OK"|"CHANGES","blockers":<n>,"target":"code"|"design"}',
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
            ...(resolution.action?.setPayload ?? {}),
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
          timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
        }, now);
        if (tr.ok && tr.task) {
          if (verdict === "OK" && blockers === 0) {
            if (task.confirmation_mode === "auto") {
              const approvedContract = resolveTaskSpecContract(task.task_key, deps.store, payload, { task: tr.task });
              if (approvedContract) {
                const specSha =
                  tr.task?.spec_sha ||
                  task.spec_sha ||
                  approvedContract.specSha ||
                  ((payload as any)?.spec_sha ?? (payload as any)?.specSha) ||
                  task.acceptance_sha;
                if (specSha && specSha !== "base") {
                  const approvalId = `appr:${task.project_id ?? "proj"}:${normKey}:${specSha}:${now}`;
                  deps.store.saveSpecContract(
                    {
                      ...approvedContract,
                      taskKey: task.task_key,
                      projectId: task.project_id ?? undefined,
                      specSha,
                      approvalId,
                    },
                    now,
                  );
                }
              }
            }
          } else if (verdict === "CHANGES") {
            if (resolution.toNode === "spec" || resolution.toNode === "design") {
              deps.store.revokeSpecContractApproval(task.task_key, now);
            }
          }
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          if (resolution.action?.dispatchNode) {
            await dispatchTaskNode(deps, tr.task, resolution.action.dispatchNode, repoRoot);
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
          timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
        }, now);
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
            await dispatchTaskNode(deps, tr.task, resolution.action.dispatchNode, repoRoot);
          }
          return true;
        }
      }
      return false;
    }

    case "research": {
      if (
        latestDelegation?.status === "done" ||
        payload.research_done === true ||
        (latestDelegation && latestDelegation.status !== "running")
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
            : null) ||
          (payload.research_done === true ? "done" : null) ||
          (latestDelegation?.status === "done" && !latestDelegation.thread_id
            ? "done"
            : null);

        if (!report) {
          const lastNudge =
            typeof payload.last_nudge_at === "number" ? payload.last_nudge_at : 0;
          const nudgeCount =
            typeof payload.nudge_count === "number" ? payload.nudge_count : 0;
          if (nudgeCount > 0 && nudgeCount < 3 && now - lastNudge < 60_000) {
            return false;
          }
          const exhausted = nudgeCount >= 3;
          const resolution = resolveTransition({
            route: task.route,
            node: "research",
            status: "running",
            event: {
              type: "research_question_or_no_report",
              nudgeCount,
              exhausted,
              reason: exhausted
                ? "research-no-report: exhausted nudges (3) -> stalled"
                : "question without report: stay in research, nudge",
            },
            mode: task.confirmation_mode,
            counters: extractCounters(task),
          });
          if (!resolution.allowed) return false;

          if (latestDelegation?.thread_id && deps.bbCli && !exhausted) {
            await deps.bbCli
              .run([
                "thread",
                "tell",
                latestDelegation.thread_id,
                "Предоставь отчёт исследования или зафиксируй результаты в задаче.",
              ])
              .catch(() => {});
          }

          const tr = deps.store.transitionTask(
            {
              taskKey: task.task_key,
              expectedNode: "research",
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
              timeoutSeconds: getNodeTimeoutSeconds(
                deps.policy,
                resolution.toNode,
              ),
            },
            now,
          );
          if (tr.ok) {
            const logged = deps.store.listTransitions(task.task_key).at(-1);
            if (logged) transitions.push(logged);
            return true;
          }
          return false;
        }

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
          timeoutSeconds: getNodeTimeoutSeconds(deps.policy, resolution.toNode),
        }, now);
        if (tr.ok) {
          const logged = deps.store.listTransitions(task.task_key).at(-1);
          if (logged) transitions.push(logged);
          return true;
        }
      }
      return false;
    }

    case "owner_gate": {
      return false;
    }

    default:
      return false;
  }
}
