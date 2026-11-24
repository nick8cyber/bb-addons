/**
 * §32.5 (PLUG-398, ADR-0041): наблюдатель-сверка режима `shadow`.
 *
 * - приём ручной раздачи в очередь (`shadow:adopt`, §32.5.1);
 * - оценка действия координатора по событию графа и следование зеркала
 *   в фактический узел (`shadow:follow`, §32.5.2–§32.5.3);
 * - синхронизация конечных статусов с трекером (`shadow:sync`, §32.5.4);
 * - отчёт сверки и критерий готовности к `strict` (§32.5.5).
 *
 * Матрица §28.1 не дублируется: граф «успешных» переходов строится пробами
 * чистой функции `resolveTransition` для каждого маршрута и режима.
 */
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
import {
  resolveTransition,
  type TransitionCounters,
  type TransitionEvent,
} from "./transition-matrix.js";
import type { Policy } from "./policy.js";
import type { WorkGraphMode } from "./workgraph-mode.js";
import type { WorkGraphOverride } from "./workgraph-mode.js";

export const SHADOW_ADOPT_ORIGIN = "shadow-adopt";
export const SHADOW_RECONCILE_STARTED_EVENT = "shadow-reconcile-started";

export type ShadowVerdictClass =
  | "match"
  | "repeat"
  | "skip"
  | "graph-only"
  | "unmapped";

export type ReviewStage = "spec_review" | "review" | "design_check";

export type LevelRole =
  | "executor"
  | "auditor"
  | "architect"
  | "researcher"
  | "spec";

export type ShadowAction =
  | {
      command: "delegate";
      level: string;
      /** вид ревью §31.9: `spec_review` или ревью кода */
      reviewKind?: "spec_review" | "review" | null;
      delegationId?: number | null;
    }
  | { command: "approve" }
  | { command: "merge"; delegationId?: number | null }
  | {
      command: "release";
      outcome: "published" | "pr_open" | "auditing" | "refused";
      releaseId?: number | null;
    };

export interface MirrorState {
  dispatched: boolean;
  last_verdict: Partial<Record<ReviewStage, "OK" | "CHANGES">>;
}

export interface ShadowVerdict {
  verdict: Exclude<ShadowVerdictClass, "graph-only">;
  /** правило таблицы классов / правило пропуска */
  rule: string;
  expected_node?: TaskNode | null;
  expected_gate?: "pre_code" | "pre_release";
  detail?: string;
  /** машинные узлы между текущим и фактическим (строки `graph-only`) */
  graph_only: TaskNode[];
}

type Log = { warn?: (msg: string) => void; info?: (msg: string) => void };

// ── helpers ─────────────────────────────────────────────────────────────

export function parseTaskPayload(
  raw: string | null | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function isShadowAdopted(task: Pick<TaskQueueRow, "payload"> | null | undefined): boolean {
  if (!task) return false;
  return parseTaskPayload(task.payload).origin === SHADOW_ADOPT_ORIGIN;
}

export function readMirror(payload: Record<string, unknown>): MirrorState {
  const m = payload.mirror;
  if (m && typeof m === "object" && !Array.isArray(m)) {
    const obj = m as Record<string, unknown>;
    const lv =
      obj.last_verdict && typeof obj.last_verdict === "object"
        ? (obj.last_verdict as MirrorState["last_verdict"])
        : {};
    return { dispatched: obj.dispatched === true, last_verdict: { ...lv } };
  }
  return { dispatched: false, last_verdict: {} };
}

/** Роль уровня по политике (§2.3, §27.3) — без импорта workgraph.ts. */
export function levelRole(level: string, policy?: Policy | null): LevelRole {
  if (level === "architect") return "architect";
  if (level === "spec") return "spec";
  if (level === "research") return "researcher";
  const pl = policy?.levels?.[level];
  if (pl?.role === "architect") return "architect";
  if (pl?.role === "auditor") return "auditor";
  if (pl?.role === "researcher") return "researcher";
  if (pl?.role === "executor") return "executor";
  if (policy?.reviewByLevel && Object.values(policy.reviewByLevel).includes(level)) {
    return "auditor";
  }
  if (level.includes("review") || level === "audit") return "auditor";
  return "executor";
}

const TASK_LEVELS = new Set<TaskLevel>([
  "complex",
  "medium",
  "simple",
  "spec",
  "research",
  "architect",
]);

/** §32.5.1 п. 2: уровень ревью → уровень исполнения обратным поиском reviewByLevel. */
export function reverseReviewLevel(
  reviewLevel: string,
  policy?: Policy | null,
): TaskLevel | null {
  const map = policy?.reviewByLevel ?? {};
  for (const exec of ["complex", "medium", "simple"] as const) {
    if (map[exec] === reviewLevel) return exec;
  }
  for (const [exec, rev] of Object.entries(map)) {
    if (rev === reviewLevel && TASK_LEVELS.has(exec as TaskLevel)) {
      return exec as TaskLevel;
    }
  }
  return null;
}

function routeForLevel(level: TaskLevel): TaskRoute {
  if (level === "research") return "research";
  if (level === "simple") return "simple";
  return "feature";
}

/** §32.5.1 п. 2: `route` и `level` принятой записи. */
export function deriveAdoptRouteLevel(input: {
  level: string;
  role: LevelRole;
  reviewKind?: "spec_review" | "review" | null;
  noCode?: boolean;
  docsOnlyRange?: boolean;
  trackerRoute?: string | null;
  policy?: Policy | null;
}): { route: TaskRoute; level: TaskLevel } {
  let level: TaskLevel;
  let route: TaskRoute;
  if (input.role === "auditor") {
    level = reverseReviewLevel(input.level, input.policy) ?? "complex";
    if (input.reviewKind === "spec_review") {
      route = input.docsOnlyRange && input.noCode ? "docs" : "feature";
    } else {
      const rev = reverseReviewLevel(input.level, input.policy);
      route = rev === "simple" ? "simple" : "feature";
    }
  } else {
    level = TASK_LEVELS.has(input.level as TaskLevel)
      ? (input.level as TaskLevel)
      : input.role === "architect"
        ? "architect"
        : input.role === "researcher"
          ? "research"
          : input.role === "spec"
            ? "spec"
            : "complex";
    route = routeForLevel(level);
  }
  const tr = typeof input.trackerRoute === "string" ? input.trackerRoute.trim() : "";
  if (tr === "feature" || tr === "fix" || tr === "docs" || tr === "simple" || tr === "research") {
    route = tr;
  }
  return { route, level };
}

const PRE_CODE_NODES = new Set<TaskNode>(["start", "design", "spec", "spec_review"]);
const POST_CODE_NODES = new Set<TaskNode>(["code", "checks", "review", "design_check"]);
const CODE_ROUTES = new Set<TaskRoute>(["feature", "fix", "simple"]);
const MACHINE_NODES = new Set<TaskNode>(["checks", "design_check"]);

/** Этап ревью, чей вердикт «текущий» для узла (правило пропуска 5). */
export function stageOfNode(node: TaskNode): ReviewStage | null {
  if (node === "spec" || node === "spec_review") return "spec_review";
  if (node === "code" || node === "checks" || node === "review") return "review";
  if (node === "design_check") return "design_check";
  return null;
}

// ── §32.5.2: «ручное действие → фактический узел/статус» ────────────────

export function mapActionToTarget(
  task: Pick<TaskQueueRow, "route" | "node">,
  action: ShadowAction,
  policy?: Policy | null,
): { node: TaskNode; status: TaskStatus } | null {
  switch (action.command) {
    case "delegate": {
      const role = levelRole(action.level, policy);
      if (role === "architect") return { node: "design", status: "running" };
      if (role === "spec") return { node: "spec", status: "running" };
      if (role === "researcher") return { node: "research", status: "running" };
      if (role === "auditor") {
        return action.reviewKind === "spec_review"
          ? { node: "spec_review", status: "running" }
          : { node: "review", status: "running" };
      }
      return { node: "code", status: "running" };
    }
    case "approve": {
      if (CODE_ROUTES.has(task.route) && PRE_CODE_NODES.has(task.node)) {
        return { node: "code", status: "running" };
      }
      if (
        (task.route === "docs" && (task.node === "spec" || task.node === "spec_review")) ||
        (CODE_ROUTES.has(task.route) && POST_CODE_NODES.has(task.node))
      ) {
        return { node: "release", status: "running" };
      }
      return null;
    }
    case "merge":
      return { node: "release", status: "running" };
    case "release":
      return action.outcome === "published"
        ? { node: "release", status: "done" }
        : null;
  }
}

// ── граф успешных переходов §28.1 (пробы resolveTransition) ─────────────

interface GraphEdge {
  from: TaskNode;
  to: TaskNode;
  event: string;
  verdict?: "OK" | "CHANGES";
  gate?: "pre_code" | "pre_release";
  success: boolean;
}

const ALL_NODES: TaskNode[] = [
  "start",
  "design",
  "spec",
  "spec_review",
  "owner_gate",
  "code",
  "checks",
  "review",
  "design_check",
  "release",
  "research",
];

const ZERO: TransitionCounters = {
  spec_attempts: 0,
  spec_review_rounds: 0,
  code_attempts: 0,
  check_attempts: 0,
  code_review_rounds: 0,
  design_check_rounds: 0,
  release_attempts: 0,
};

interface Probe {
  event: TransitionEvent;
  verdict?: "OK" | "CHANGES";
  gate?: "pre_code" | "pre_release";
  success: boolean;
}

const PROBES: Probe[] = [
  { event: { type: "queue_take" }, success: true },
  { event: { type: "design_delivered", acceptanceText: "acceptance" }, success: true },
  { event: { type: "spec_delivered", specSha: "probe" }, success: true },
  { event: { type: "spec_review_verdict", verdict: "OK", blockers: 0 }, verdict: "OK", success: true },
  { event: { type: "spec_review_verdict", verdict: "CHANGES", blockers: 1 }, verdict: "CHANGES", success: false },
  { event: { type: "owner_approve", isOwner: true }, gate: "pre_code", success: true },
  { event: { type: "owner_approve", isOwner: true }, gate: "pre_release", success: true },
  { event: { type: "code_delivered", resultSha: "probe", commits: 1 }, success: true },
  { event: { type: "checks_result", exitCode: 0 }, success: true },
  { event: { type: "checks_result", exitCode: 1 }, success: false },
  { event: { type: "review_verdict", verdict: "OK", blockers: 0 }, verdict: "OK", success: true },
  { event: { type: "review_verdict", verdict: "CHANGES", blockers: 1 }, verdict: "CHANGES", success: false },
  { event: { type: "design_check_verdict", verdict: "OK", blockers: 0 }, verdict: "OK", success: true },
  { event: { type: "design_check_verdict", verdict: "CHANGES", blockers: 1, target: "code" }, verdict: "CHANGES", success: false },
  { event: { type: "design_check_verdict", verdict: "CHANGES", blockers: 1, target: "design" }, verdict: "CHANGES", success: false },
  { event: { type: "release_published", prMode: false }, success: true },
  { event: { type: "research_delivered", report: "probe" }, success: true },
];

const graphCache = new Map<string, GraphEdge[]>();

/** Рёбра матрицы §28.1 между разными узлами для маршрута и режима. */
export function matrixEdges(route: TaskRoute, mode: ConfirmationMode): GraphEdge[] {
  const cacheKey = `${route}:${mode}`;
  const hit = graphCache.get(cacheKey);
  if (hit) return hit;
  const edges: GraphEdge[] = [];
  for (const node of ALL_NODES) {
    const status: TaskStatus =
      node === "start" ? "queued" : node === "owner_gate" ? "waiting_approval" : "running";
    for (const p of PROBES) {
      let res;
      try {
        res = resolveTransition({
          route,
          node,
          status,
          event: p.event,
          mode,
          counters: ZERO,
          gateStage: p.gate,
        });
      } catch {
        continue;
      }
      if (!res?.allowed || res.toNode === node) continue;
      if (res.toStatus === "blocked" || res.toStatus === "stalled" || res.toStatus === "cancelled") {
        continue;
      }
      if (
        edges.some(
          (e) => e.from === node && e.to === res.toNode && e.event === p.event.type && e.verdict === p.verdict && e.gate === p.gate,
        )
      ) {
        continue;
      }
      edges.push({
        from: node,
        to: res.toNode,
        event: p.event.type,
        verdict: p.verdict,
        gate: p.gate,
        success: p.success,
      });
    }
  }
  graphCache.set(cacheKey, edges);
  return edges;
}

/** Ожидаемый следующий узел матрицы из текущего (успешный путь). */
export function expectedNextNode(
  route: TaskRoute,
  mode: ConfirmationMode,
  node: TaskNode,
): TaskNode | null {
  const e = matrixEdges(route, mode).find((x) => x.from === node && x.success);
  return e?.to ?? null;
}

/**
 * §32.5.3 правило 3: путь матрицы из текущего узла в фактический с учётом
 * машинных узлов (`checks`, `design_check` — пройдены, `graph-only`) и
 * шлюза владельца (только для `approve`). Первый шаг из узла ревью
 * требует, чтобы последний вердикт этапа совпадал с ребром.
 * Возвращает промежуточные узлы пути или null.
 */
export function findMatrixPath(input: {
  route: TaskRoute;
  mode: ConfirmationMode;
  from: TaskNode;
  to: TaskNode;
  approve: boolean;
  lastVerdict: MirrorState["last_verdict"];
}): TaskNode[] | null {
  const edges = matrixEdges(input.route, input.mode);
  const allowedMid = new Set<TaskNode>(MACHINE_NODES);
  if (input.approve) allowedMid.add("owner_gate");
  const targetGate = input.to === "code" ? "pre_code" : "pre_release";
  type State = { node: TaskNode; path: TaskNode[] };
  const queue: State[] = [{ node: input.from, path: [] }];
  const seen = new Set<TaskNode>([input.from]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.from !== cur.node) continue;
      const first = cur.node === input.from;
      if (first) {
        if (e.verdict) {
          const stage = stageOfNode(cur.node);
          const lv = stage ? input.lastVerdict[stage] : undefined;
          if (lv !== e.verdict) continue;
        }
        if (e.event === "owner_approve" && !input.approve) continue;
      } else {
        // машинные узлы и шлюз проходятся только успешным исходом
        if (!e.success) continue;
      }
      if (e.event === "owner_approve" && e.gate !== targetGate) continue;
      if (e.to === input.to) return cur.path;
      if (!allowedMid.has(e.to) || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push({ node: e.to, path: [...cur.path, e.to] });
    }
  }
  return null;
}

// ── §32.5.3: классы вердикта ─────────────────────────────────────────────

function roundCapExceeded(
  task: TaskQueueRow,
  action: ShadowAction,
  target: { node: TaskNode },
  mirror: MirrorState,
): boolean {
  const cur = task.node;
  const tgt = target.node;
  const same = cur === tgt;
  if (action.command === "delegate") {
    if (tgt === "review" && task.code_review_rounds >= 3) return true;
    if (tgt === "spec_review" && task.spec_review_rounds >= 3) return true;
    if (!same && tgt === "code" && cur === "review" && task.code_review_rounds >= 3) return true;
    if (!same && tgt === "spec" && cur === "spec_review" && task.spec_review_rounds >= 3) return true;
    if (!same && tgt === "design" && cur === "design_check" && task.design_check_rounds >= 3) return true;
    if (same && mirror.dispatched) {
      if (tgt === "code" && task.code_attempts >= 3) return true;
      if (tgt === "spec" && task.spec_attempts >= 3) return true;
    }
  }
  if (action.command === "merge" && same && mirror.dispatched && task.release_attempts >= 3) {
    return true;
  }
  return false;
}

/** Классифицирует ручное действие против ТЕКУЩЕГО состояния записи. */
export function classifyShadowAction(
  task: TaskQueueRow,
  action: ShadowAction,
  target: { node: TaskNode; status: TaskStatus } | null,
): ShadowVerdict {
  if (!target) {
    return {
      verdict: "unmapped",
      rule: "1",
      expected_node: expectedNextNode(task.route, task.confirmation_mode, task.node),
      detail: "no-table-row",
      graph_only: [],
    };
  }
  const payload = parseTaskPayload(task.payload);
  const mirror = readMirror(payload);
  const lv = mirror.last_verdict;
  const cur = task.node;
  const tgt = target.node;
  const entry = cur !== tgt;
  const manual = task.confirmation_mode === "manual";
  const codeDispatch = action.command === "delegate" && tgt === "code";
  const isMergeOrPublish =
    action.command === "merge" ||
    (action.command === "release" && action.outcome === "published");
  const skip = (
    rule: string,
    detail: string,
    expected: TaskNode | null,
    gate?: "pre_code" | "pre_release",
  ): ShadowVerdict => ({
    verdict: "skip",
    rule,
    detail,
    expected_node: expected,
    ...(gate ? { expected_gate: gate } : {}),
    graph_only: [],
  });

  // правила пропуска 1–6
  if (codeDispatch && task.route === "feature" && PRE_CODE_NODES.has(cur) && lv.spec_review !== "OK") {
    return skip("skip-1", "spec-review-not-accepted", "spec_review");
  }
  if (manual && codeDispatch && CODE_ROUTES.has(task.route) && PRE_CODE_NODES.has(cur)) {
    return skip("skip-2", "owner-approval-missing", "owner_gate", "pre_code");
  }
  if (action.command === "merge" && CODE_ROUTES.has(task.route) && cur !== "release" && lv.review !== "OK") {
    return skip("skip-3", "code-review-not-accepted", "review");
  }
  if (manual && isMergeOrPublish && cur !== "release") {
    return skip("skip-4", "owner-approval-missing", "owner_gate", "pre_release");
  }
  if (action.command === "approve") {
    const fixStartException =
      (task.route === "fix" || task.route === "simple") && cur === "start" && tgt === "code";
    const stage = stageOfNode(cur);
    if (!fixStartException && (!stage || lv[stage] !== "OK")) {
      return skip(
        "skip-5",
        "approve-without-accepted-review",
        stage ?? expectedNextNode(task.route, task.confirmation_mode, cur),
      );
    }
  }
  if (roundCapExceeded(task, action, target, mirror)) {
    return skip("skip-6", "round-cap-exceeded", null);
  }

  // match 3: переход матрицы с машинными узлами
  if (entry) {
    const path = findMatrixPath({
      route: task.route,
      mode: task.confirmation_mode,
      from: cur,
      to: tgt,
      approve: action.command === "approve",
      lastVerdict: lv,
    });
    if (path) {
      return {
        verdict: "match",
        rule: "3",
        graph_only: path.filter((n) => MACHINE_NODES.has(n)),
      };
    }
  } else {
    if (action.command === "delegate") {
      return mirror.dispatched
        ? { verdict: "repeat", rule: "6", graph_only: [] }
        : { verdict: "match", rule: "4", graph_only: [] };
    }
    if (action.command === "merge" && cur === "release" && task.status === "running") {
      return mirror.dispatched
        ? { verdict: "repeat", rule: "6", graph_only: [] }
        : { verdict: "match", rule: "4a", graph_only: [] };
    }
    if (
      action.command === "release" &&
      action.outcome === "published" &&
      cur === "release" &&
      (task.status === "running" || task.status === "pr_open")
    ) {
      return { verdict: "match", rule: "4b", graph_only: [] };
    }
  }
  if (
    action.command === "release" &&
    action.outcome === "published" &&
    cur === "release" &&
    (task.status === "running" || task.status === "pr_open")
  ) {
    return { verdict: "match", rule: "4b", graph_only: [] };
  }
  // замыкающее правило 7
  return skip(
    "skip-7",
    "matrix-violation",
    expectedNextNode(task.route, task.confirmation_mode, cur),
  );
}

// ── §32.5.2: следование зеркала ─────────────────────────────────────────

export interface FollowResult {
  ok: boolean;
  verdict?: ShadowVerdict;
  transitionId?: number;
  task?: TaskQueueRow | null;
}

function nextMirror(
  task: TaskQueueRow,
  action: ShadowAction,
  target: { node: TaskNode },
): MirrorState {
  const mirror = readMirror(parseTaskPayload(task.payload));
  const lv = { ...mirror.last_verdict };
  const entering = task.node !== target.node;
  if (entering) {
    if (target.node === "spec" && lv.spec_review === "CHANGES") delete lv.spec_review;
    if (target.node === "code") {
      if (lv.review === "CHANGES") delete lv.review;
      if (lv.design_check === "CHANGES") delete lv.design_check;
    }
    if (target.node === "design" && lv.design_check === "CHANGES") delete lv.design_check;
    // новый круг ревью — прежний вердикт этапа больше не текущий
    if (target.node === "spec_review") delete lv.spec_review;
    if (target.node === "review") delete lv.review;
  }
  const dispatched =
    action.command === "approve"
      ? false
      : action.command === "delegate" || action.command === "merge"
        ? true
        : mirror.dispatched;
  return { dispatched, last_verdict: lv };
}

function counterUpdates(
  task: TaskQueueRow,
  action: ShadowAction,
  target: { node: TaskNode },
  mirror: MirrorState,
): Partial<TaskQueueRow> {
  const same = task.node === target.node;
  if (action.command === "delegate" && same && mirror.dispatched) {
    if (target.node === "code") return { code_attempts: task.code_attempts + 1 };
    if (target.node === "spec") return { spec_attempts: task.spec_attempts + 1 };
  }
  return {};
}

/**
 * §32.5.2: оценка + следование в одной транзакции. Пишет строку
 * `shadow:follow` с `payload.verdict` и строки `graph-only` с тем же
 * `transition_id`.
 */
export function shadowFollow(
  store: DelegationStore,
  taskKey: string,
  action: ShadowAction,
  opts: { policy?: Policy | null; now?: number } = {},
): FollowResult {
  const key = normalizeTaskKey(taskKey);
  return store.inTransaction(() => {
    const task = store.getTask(key);
    if (!task) return { ok: false };
    const now = opts.now ?? Date.now();
    const target = mapActionToTarget(task, action, opts.policy);
    const verdict = classifyShadowAction(task, action, target);
    const delegationId =
      action.command === "delegate" || action.command === "merge"
        ? (action.delegationId ?? null)
        : null;
    const detail =
      verdict.verdict === "skip" || verdict.verdict === "unmapped"
        ? {
            expected_node: verdict.expected_node ?? null,
            ...(verdict.expected_gate ? { expected_gate: verdict.expected_gate } : {}),
            actual_node: target?.node ?? null,
            current_node: task.node,
            delegation_id: delegationId,
            reason: verdict.detail,
          }
        : undefined;
    const transitionPayload = {
      event: "manual_command",
      command: action.command,
      ...(action.command === "release" ? { outcome: action.outcome } : {}),
      verdict: verdict.verdict,
      rule: verdict.rule,
      ...(detail ? { verdict_detail: detail } : {}),
      delegation_id: delegationId,
      graph_only: verdict.graph_only,
    };
    if (!target) {
      // unmapped: узел не двигается — строка оценки без перехода
      const id = store.insertTransition({
        taskKey: key,
        fromNode: task.node,
        toNode: task.node,
        fromStatus: task.status,
        toStatus: task.status,
        actor: "shadow:follow",
        reason: `shadow-follow:${action.command}`,
        payload: JSON.stringify(transitionPayload),
        createdAt: now,
      });
      return { ok: true, verdict, transitionId: id, task };
    }
    const payload = parseTaskPayload(task.payload);
    const prevMirror = readMirror(payload);
    const mirror = nextMirror(task, action, target);
    const updates: Partial<TaskQueueRow> = {
      ...counterUpdates(task, action, target, prevMirror),
      payload: JSON.stringify({ ...payload, mirror }),
    };
    const tr = store.transitionTask(
      {
        taskKey: key,
        expectedNode: task.node,
        expectedStatus: task.status,
        toNode: target.node,
        toStatus: target.status,
        actor: "shadow:follow",
        reason: `shadow-follow:${action.command}`,
        transitionPayload: JSON.stringify(transitionPayload),
        updates,
      },
      now,
    );
    if (!tr.ok) return { ok: false, verdict };
    for (const node of verdict.graph_only) {
      store.insertTransition({
        taskKey: key,
        fromNode: node,
        toNode: node,
        fromStatus: "running",
        toStatus: "running",
        actor: "shadow:follow",
        reason: `shadow-graph-only:${node}`,
        payload: JSON.stringify({
          event: "machine_node",
          command: action.command,
          verdict: "graph-only",
          node,
          transition_id: tr.transitionId,
        }),
        createdAt: now,
      });
    }
    return { ok: true, verdict, transitionId: tr.transitionId, task: tr.task };
  });
}

// ── §32.5.1: приём ──────────────────────────────────────────────────────

export interface AdoptInput {
  taskKey: string;
  projectId: string;
  coordinatorThreadId: string;
  level: string;
  reviewKind?: "spec_review" | "review" | null;
  noCode?: boolean;
  docsOnlyRange?: boolean;
  delegationId?: number | null;
  branch?: string | null;
  trackerRoute?: string | null;
  approvalMode?: "auto" | "manual" | null;
  policy?: Policy | null;
  now?: number;
}

export function shadowAdopt(store: DelegationStore, input: AdoptInput): TaskQueueRow | null {
  const role = levelRole(input.level, input.policy);
  const { route, level } = deriveAdoptRouteLevel({
    level: input.level,
    role,
    reviewKind: input.reviewKind,
    noCode: input.noCode,
    docsOnlyRange: input.docsOnlyRange,
    trackerRoute: input.trackerRoute,
    policy: input.policy,
  });
  const target = mapActionToTarget(
    { route, node: "start" },
    { command: "delegate", level: input.level, reviewKind: input.reviewKind },
    input.policy,
  )!;
  // §29.3: режим одобрения задачи — настройка approvalMode, иначе по маршруту
  const confirmationMode: ConfirmationMode =
    input.approvalMode === "auto" || input.approvalMode === "manual"
      ? input.approvalMode
      : route === "feature"
        ? "manual"
        : "auto";
  const payload = {
    origin: SHADOW_ADOPT_ORIGIN,
    adopted_delegation_id: input.delegationId ?? null,
    project_id: input.projectId,
    mirror: { dispatched: true, last_verdict: {} } satisfies MirrorState,
  };
  return store.adoptTask(
    {
      taskKey: input.taskKey,
      projectId: input.projectId,
      coordinatorThreadId: input.coordinatorThreadId,
      route,
      level,
      node: target.node,
      status: target.status,
      confirmationMode,
      branch: route === "research" ? null : (input.branch ?? null),
      payload: JSON.stringify(payload),
      command: "delegate",
      transitionPayload: JSON.stringify({
        event: "manual_command",
        command: "delegate",
        level: input.level,
        delegation_id: input.delegationId ?? null,
      }),
    },
    input.now ?? Date.now(),
  );
}

/** §32.5.1 п. 6 / §32.1: служебная запись о действии вне очереди. */
export function recordTaskNotEnqueued(
  store: DelegationStore,
  taskKey: string,
  command: string,
  projectId?: string | null,
  now?: number,
): void {
  store.insertTransition({
    taskKey: normalizeTaskKey(taskKey),
    fromNode: "none",
    toNode: "none",
    fromStatus: "none",
    toStatus: "none",
    actor: "shadow:coordinator",
    reason: "task-not-enqueued",
    payload: JSON.stringify({
      event: "manual_command",
      command,
      would_reject: "graph-required",
      would_block: { reason: "graph-required" },
      ...(projectId ? { project_id: projectId } : {}),
    }),
    ...(now !== undefined ? { createdAt: now } : {}),
  });
}

/** Ручная раздача: приём или следование. Только `shadow`; release-audit и помощники — молчание. */
export function shadowObserveDelegate(
  store: DelegationStore,
  input: AdoptInput & { mode: WorkGraphMode | null | undefined },
): { kind: "adopted" | "followed" | "not-enqueued" | "silent"; verdict?: ShadowVerdict } {
  if (input.mode !== "shadow") return { kind: "silent" };
  if (input.level === "release-audit") return { kind: "silent" };
  const key = normalizeTaskKey(input.taskKey);
  const task = store.getTask(key);
  if (!task || task.status === "done" || task.status === "cancelled") {
    if (!input.projectId) {
      recordTaskNotEnqueued(store, key, "delegate", null, input.now);
      return { kind: "not-enqueued" };
    }
    const adopted = shadowAdopt(store, input);
    return adopted ? { kind: "adopted" } : { kind: "silent" };
  }
  const res = shadowFollow(
    store,
    key,
    {
      command: "delegate",
      level: input.level,
      reviewKind: input.reviewKind,
      delegationId: input.delegationId ?? null,
    },
    { policy: input.policy, now: input.now },
  );
  return { kind: "followed", verdict: res.verdict };
}

/** Ручной merge: следование для задачи в очереди, иначе `task-not-enqueued`. */
export function shadowObserveMerge(
  store: DelegationStore,
  input: {
    taskKey: string;
    projectId?: string | null;
    delegationId?: number | null;
    mode: WorkGraphMode | null | undefined;
    policy?: Policy | null;
    now?: number;
  },
): { kind: "followed" | "not-enqueued" | "silent"; verdict?: ShadowVerdict } {
  if (input.mode !== "shadow") return { kind: "silent" };
  const key = normalizeTaskKey(input.taskKey);
  const task = store.getTask(key);
  if (!task) {
    recordTaskNotEnqueued(store, key, "merge", input.projectId, input.now);
    return { kind: "not-enqueued" };
  }
  if (task.status === "done" || task.status === "cancelled") return { kind: "silent" };
  const res = shadowFollow(
    store,
    key,
    { command: "merge", delegationId: input.delegationId ?? null },
    { policy: input.policy, now: input.now },
  );
  return { kind: "followed", verdict: res.verdict };
}

/**
 * Исход выкладки (§32.5.2): `published` — класс и следование в
 * `release/done`; `pr_open`/`auditing`/отказ — события конвейера без класса.
 */
export function shadowObserveRelease(
  store: DelegationStore,
  input: {
    taskKey: string;
    outcome: "published" | "pr_open" | "auditing" | "refused";
    releaseId?: number | null;
    mode: WorkGraphMode | null | undefined;
    policy?: Policy | null;
    now?: number;
  },
): { kind: "followed" | "event" | "silent"; verdict?: ShadowVerdict } {
  if (input.mode !== "shadow") return { kind: "silent" };
  const key = normalizeTaskKey(input.taskKey);
  const task = store.getTask(key);
  if (!task || task.status === "done" || task.status === "cancelled") {
    return { kind: "silent" };
  }
  if (input.outcome === "published") {
    const res = shadowFollow(
      store,
      key,
      { command: "release", outcome: "published", releaseId: input.releaseId ?? null },
      { policy: input.policy, now: input.now },
    );
    return { kind: "followed", verdict: res.verdict };
  }
  if (task.node !== "release") return { kind: "silent" };
  const now = input.now ?? Date.now();
  const toStatus: TaskStatus = input.outcome === "pr_open" ? "pr_open" : "running";
  const updates: Partial<TaskQueueRow> =
    input.outcome === "refused" ? { release_attempts: task.release_attempts + 1 } : {};
  if (toStatus === task.status && input.outcome !== "refused") return { kind: "event" };
  store.transitionTask(
    {
      taskKey: key,
      expectedNode: task.node,
      expectedStatus: task.status,
      toNode: "release",
      toStatus,
      actor: "shadow:follow",
      reason: `shadow-release:${input.outcome}`,
      transitionPayload: JSON.stringify({
        event: "release_pipeline",
        outcome: input.outcome,
        release_id: input.releaseId ?? null,
      }),
      updates,
    },
    now,
  );
  return { kind: "event" };
}

/**
 * §32.5.2: отказ выкладки после вставки строки `releases` уже учтён
 * событием `release.failed`/`release.rejected` (наблюдатель store) — путь
 * CLI не должен считать его второй раз. `releaseIdBefore` — id последней
 * строки выкладки задачи до запуска.
 */
export function releaseRefusalCountedByEvent(
  store: DelegationStore,
  taskKey: string,
  releaseIdBefore: number,
): boolean {
  const rel = store.latestReleaseByTask(taskKey);
  return (
    rel != null &&
    rel.id > releaseIdBefore &&
    (rel.status === "failed" || rel.status === "rejected")
  );
}

/**
 * События без действия координатора (§32.5.2): итог ревью обновляет
 * `payload.mirror.last_verdict` и счётчики кругов; узел не двигается,
 * класса нет. Сдача исполнителя заполняет фактическую ветку записи.
 */
export function shadowObserveStoreEvent(
  store: DelegationStore,
  kind: string,
  doc: Record<string, unknown>,
  deps: {
    getMode: (projectId?: string | null) => WorkGraphMode;
    policy?: () => Policy | null | undefined;
    now?: () => number;
  },
): void {
  const taskKey = typeof doc.task === "string" ? doc.task : null;
  if (!taskKey) return;
  const task = store.getTask(taskKey);
  if (!task) return;
  if (deps.getMode(task.project_id) !== "shadow") return;
  if (task.status === "done" || task.status === "cancelled") return;
  const policy = deps.policy?.() ?? null;
  const now = deps.now?.() ?? Date.now();

  if (kind === "review.verdict") {
    const delegationId = typeof doc.delegationId === "number" ? doc.delegationId : null;
    const row = delegationId !== null ? store.get(delegationId) : undefined;
    const level = typeof doc.level === "string" ? doc.level : (row?.level ?? "");
    // §32.5.1: release-audit — служебный шаг выкладки, не ревью задачи
    if (level === "release-audit") return;
    let stage: ReviewStage = "review";
    const role = levelRole(level, policy);
    if (role === "architect") stage = "design_check";
    else {
      const attachKind = (() => {
        try {
          return row?.attach ? (JSON.parse(row.attach) as { kind?: string }).kind : undefined;
        } catch {
          return undefined;
        }
      })();
      if (attachKind === "spec_review") stage = "spec_review";
      else if (task.node === "spec_review" || task.node === "spec") stage = "spec_review";
    }
    const blockers = typeof doc.blockers === "number" ? doc.blockers : null;
    const verdict: "OK" | "CHANGES" =
      doc.verdict === "OK" && (blockers === null || blockers === 0) ? "OK" : "CHANGES";
    const payload = parseTaskPayload(task.payload);
    const mirror = readMirror(payload);
    mirror.last_verdict[stage] = verdict;
    const updates: Partial<TaskQueueRow> = {
      payload: JSON.stringify({ ...payload, mirror }),
    };
    if (verdict === "CHANGES") {
      if (stage === "spec_review") updates.spec_review_rounds = task.spec_review_rounds + 1;
      if (stage === "review") updates.code_review_rounds = task.code_review_rounds + 1;
      if (stage === "design_check") updates.design_check_rounds = task.design_check_rounds + 1;
    }
    store.updateTask(task.task_key, updates, now);
    return;
  }
  if (kind === "delegation.done" || kind === "delegation.result") {
    // §32.5.1 п. 2: фактическая ветка раздачи. Итог круга (`result_branch`)
    // пишется после delegation.done — основной сигнал `delegation.result`.
    if (task.branch || task.route === "research") return;
    const delegationId = typeof doc.delegationId === "number" ? doc.delegationId : null;
    const row = delegationId !== null ? store.get(delegationId) : undefined;
    const role = row ? levelRole(row.level, policy) : null;
    if (row?.result_branch && role !== "auditor" && role !== "researcher") {
      store.updateTask(task.task_key, { branch: row.result_branch }, now);
    }
    return;
  }
  if (kind === "release.published") {
    // PR-выкладка: «published» конвейера = PR открыт; push — публикация.
    const releaseId = typeof doc.releaseId === "number" ? doc.releaseId : null;
    const rel = releaseId !== null ? store.getRelease(releaseId) : undefined;
    const outcome = rel?.target_action === "pr" ? "pr_open" : "published";
    shadowObserveRelease(store, {
      taskKey,
      outcome,
      releaseId,
      mode: "shadow",
      policy,
      now,
    });
    return;
  }
  if (kind === "pr.merged") {
    const releaseId = typeof doc.releaseId === "number" ? doc.releaseId : null;
    shadowObserveRelease(store, {
      taskKey,
      outcome: "published",
      releaseId,
      mode: "shadow",
      policy,
      now,
    });
    return;
  }
  if (kind === "release.rejected" || kind === "release.failed") {
    const releaseId = typeof doc.releaseId === "number" ? doc.releaseId : null;
    shadowObserveRelease(store, {
      taskKey,
      outcome: "refused",
      releaseId,
      mode: "shadow",
      policy,
      now,
    });
  }
}

// ── §32.5.4: синхронизация конечных статусов ────────────────────────────

export type TrackerStatusFn = (taskKey: string) => Promise<string | null | undefined>;

export function normalizeTrackerStatus(raw: unknown): "done" | "cancelled" | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "done") return "done";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  return null;
}

export async function syncShadowTerminalStatuses(
  store: DelegationStore,
  deps: {
    getMode: (projectId?: string | null) => WorkGraphMode;
    getTrackerStatus: TrackerStatusFn;
    now?: () => number;
    log?: Log;
    /** минимальный интервал между запросами трекера по одной задаче */
    minIntervalMs?: number;
    lastChecked?: Map<string, number>;
  },
): Promise<{ checked: number; synced: { taskKey: string; status: "done" | "cancelled" }[] }> {
  const synced: { taskKey: string; status: "done" | "cancelled" }[] = [];
  let checked = 0;
  for (const task of store.listAllTasks()) {
    if (task.status === "done" || task.status === "cancelled") continue;
    if (deps.getMode(task.project_id) !== "shadow") continue;
    const now = deps.now?.() ?? Date.now();
    if (deps.minIntervalMs && deps.lastChecked) {
      const last = deps.lastChecked.get(task.task_key);
      if (last !== undefined && now - last < deps.minIntervalMs) continue;
      deps.lastChecked.set(task.task_key, now);
    }
    let raw: string | null | undefined;
    try {
      raw = await deps.getTrackerStatus(task.task_key);
    } catch (e) {
      deps.log?.warn?.(`orchestrator: shadow-sync ${task.task_key}: ${String(e)}`);
      continue;
    }
    checked++;
    const terminal = normalizeTrackerStatus(raw);
    if (!terminal) continue;
    const fresh = store.getTask(task.task_key);
    if (!fresh || fresh.status === "done" || fresh.status === "cancelled") continue;
    const tr = store.transitionTask(
      {
        taskKey: fresh.task_key,
        expectedNode: fresh.node,
        expectedStatus: fresh.status,
        toNode: fresh.node,
        toStatus: terminal,
        actor: "shadow:sync",
        reason: `tracker-terminal:${String(raw).trim().toLowerCase()}`,
        transitionPayload: JSON.stringify({ event: "tracker_sync", tracker_status: raw }),
      },
      now,
    );
    if (tr.ok) synced.push({ taskKey: fresh.task_key, status: terminal });
  }
  return { checked, synced };
}

/** `bb tasks show <KEY> --json` → статус задачи трекера. */
export function trackerStatusViaCli(cli: {
  run(args: string[], opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string }>;
}): TrackerStatusFn {
  return async (taskKey) => {
    const res = await cli.run(["tasks", "show", taskKey, "--json"], { timeoutMs: 10_000 });
    if (res.exitCode !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout) as { task?: { status?: string }; status?: string };
    return parsed.task?.status ?? parsed.status ?? null;
  };
}

/** Маршрут задачи из трекера (`payload.route`), если он задан. */
export async function trackerRouteViaCli(
  cli: {
    run(args: string[], opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string }>;
  } | null | undefined,
  taskKey: string,
): Promise<string | null> {
  if (!cli) return null;
  try {
    const res = await cli.run(["tasks", "show", taskKey, "--json"], { timeoutMs: 10_000 });
    if (res.exitCode !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout) as {
      task?: { payload?: unknown; route?: unknown };
    };
    let p = parsed.task?.payload;
    if (typeof p === "string") {
      try {
        p = JSON.parse(p);
      } catch {
        p = null;
      }
    }
    const fromPayload =
      p && typeof p === "object" ? (p as { route?: unknown }).route : undefined;
    const r = fromPayload ?? parsed.task?.route;
    return typeof r === "string" && r.trim() ? r.trim() : null;
  } catch {
    return null;
  }
}

/** §32.5.4 п. 3: однократная стартовая метка и синхронизация. */
export async function ensureShadowReconcileStarted(
  store: DelegationStore,
  deps: Parameters<typeof syncShadowTerminalStatuses>[1],
): Promise<{ started: boolean; at: number }> {
  const existing = store.listEvents(SHADOW_RECONCILE_STARTED_EVENT);
  if (existing.length > 0) {
    return { started: false, at: existing[0]!.created_at };
  }
  const at = deps.now?.() ?? Date.now();
  store.recordTaskEvent(SHADOW_RECONCILE_STARTED_EVENT, { timestamp: at }, at);
  await syncShadowTerminalStatuses(store, { ...deps, minIntervalMs: undefined });
  return { started: true, at };
}

export function shadowReconcileStartedAt(store: DelegationStore): number | null {
  const ev = store.listEvents(SHADOW_RECONCILE_STARTED_EVENT);
  return ev.length ? ev[0]!.created_at : null;
}

// ── §32.5.5: отчёт сверки ───────────────────────────────────────────────

export interface ShadowReportEntry {
  taskKey: string;
  verdict: "skip" | "unmapped";
  command: string;
  detail: Record<string, unknown> | null;
  at: number;
  transitionId: number;
}

export interface ShadowProjectReport {
  projectId: string;
  mode: WorkGraphMode | "unknown";
  tasks: number;
  fullCycles: number;
  classes: Record<ShadowVerdictClass, number>;
  shares: Record<"match" | "repeat" | "skip" | "unmapped", number>;
  manualActions: number;
  adopted: number;
  taskNotEnqueued: number;
  taskNotEnqueuedShare: number;
  primaryRatio: number | null;
  skips: ShadowReportEntry[];
  unmapped: ShadowReportEntry[];
  windowHours: number;
  criteria: {
    window48h: boolean;
    cycles3: boolean;
    unmappedZero: boolean;
    notEnqueuedMax5pct: boolean;
    primaryRatio90pct: boolean;
    skipsReviewed: "manual" | "none";
  };
  readyForStrict: boolean;
}

export interface ShadowReport {
  since: number;
  generatedAt: number;
  synced: { taskKey: string; status: "done" | "cancelled" }[];
  projects: ShadowProjectReport[];
  overrides: {
    projectId: string;
    mode: WorkGraphMode;
    permanent: boolean;
    until?: string;
    reason?: string;
    expired?: boolean;
  }[];
}

function emptyClasses(): Record<ShadowVerdictClass, number> {
  return { match: 0, repeat: 0, skip: 0, "graph-only": 0, unmapped: 0 };
}

export function buildShadowReport(
  store: DelegationStore,
  opts: {
    since?: number | null;
    projectId?: string | null;
    now?: number;
    getMode?: (projectId?: string | null) => WorkGraphMode;
    overrides?: Record<string, WorkGraphOverride>;
    synced?: { taskKey: string; status: "done" | "cancelled" }[];
  } = {},
): ShadowReport {
  const now = opts.now ?? Date.now();
  const since = opts.since ?? shadowReconcileStartedAt(store) ?? 0;
  const rows = store.listTransitionsSince(since);
  const projectOfTask = new Map<string, string>();
  for (const t of store.listAllTasks()) projectOfTask.set(t.task_key, t.project_id);

  type Acc = {
    tasks: Set<string>;
    classes: Record<ShadowVerdictClass, number>;
    adopted: number;
    tne: number;
    skips: ShadowReportEntry[];
    unmapped: ShadowReportEntry[];
    cycles: number;
  };
  const acc = new Map<string, Acc>();
  const get = (pid: string): Acc => {
    let a = acc.get(pid);
    if (!a) {
      a = {
        tasks: new Set(),
        classes: emptyClasses(),
        adopted: 0,
        tne: 0,
        skips: [],
        unmapped: [],
        cycles: 0,
      };
      acc.set(pid, a);
    }
    return a;
  };
  // полный цикл: вход в spec_review или code, затем release/done
  const cycleOpen = new Map<string, boolean>();

  for (const r of rows) {
    const payload = parseTaskPayload(r.payload);
    let pid = projectOfTask.get(r.task_key);
    if (!pid && typeof payload.project_id === "string") pid = payload.project_id;
    pid = pid ?? "(unknown)";
    if (opts.projectId && pid !== opts.projectId) continue;
    const a = get(pid);
    if (r.reason === "task-not-enqueued") {
      a.tne++;
      continue;
    }
    if (r.actor === "shadow:adopt") {
      a.adopted++;
      a.tasks.add(r.task_key);
      if (r.to_node === "spec_review" || r.to_node === "code") cycleOpen.set(r.task_key, true);
      continue;
    }
    if (r.actor === "shadow:follow") {
      a.tasks.add(r.task_key);
      const v = payload.verdict;
      if (v === "match" || v === "repeat" || v === "skip" || v === "unmapped" || v === "graph-only") {
        a.classes[v]++;
        if (v === "skip" || v === "unmapped") {
          const entry: ShadowReportEntry = {
            taskKey: r.task_key,
            verdict: v,
            command: String(payload.command ?? ""),
            detail:
              payload.verdict_detail && typeof payload.verdict_detail === "object"
                ? (payload.verdict_detail as Record<string, unknown>)
                : null,
            at: r.created_at,
            transitionId: r.id,
          };
          (v === "skip" ? a.skips : a.unmapped).push(entry);
        }
      }
      if (r.from_node !== r.to_node && (r.to_node === "spec_review" || r.to_node === "code")) {
        cycleOpen.set(r.task_key, true);
      }
      if (r.to_node === "release" && r.to_status === "done" && r.from_status !== "done") {
        if (cycleOpen.get(r.task_key)) a.cycles++;
        cycleOpen.set(r.task_key, false);
      }
      continue;
    }
    if (r.actor === "shadow:sync") {
      a.tasks.add(r.task_key);
    }
  }

  const windowHours = Math.max(0, (now - since) / 3_600_000);
  const projects: ShadowProjectReport[] = [];
  for (const [pid, a] of [...acc.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const c = a.classes;
    const primary = c.match + c.repeat + c.skip + c.unmapped;
    const manualActions = primary + a.adopted + a.tne;
    const share = (n: number) => (primary > 0 ? n / primary : 0);
    const tneShare = manualActions > 0 ? a.tne / manualActions : 0;
    const ratio = primary > 0 ? (c.match + c.repeat) / primary : null;
    const criteria = {
      window48h: windowHours >= 48,
      cycles3: a.cycles >= 3,
      unmappedZero: c.unmapped === 0,
      notEnqueuedMax5pct: tneShare <= 0.05,
      primaryRatio90pct: ratio !== null && ratio >= 0.9,
      skipsReviewed: (c.skip > 0 ? "manual" : "none") as "manual" | "none",
    };
    projects.push({
      projectId: pid,
      mode: opts.getMode ? opts.getMode(pid === "(unknown)" ? null : pid) : "unknown",
      tasks: a.tasks.size,
      fullCycles: a.cycles,
      classes: { ...c },
      shares: {
        match: share(c.match),
        repeat: share(c.repeat),
        skip: share(c.skip),
        unmapped: share(c.unmapped),
      },
      manualActions,
      adopted: a.adopted,
      taskNotEnqueued: a.tne,
      taskNotEnqueuedShare: tneShare,
      primaryRatio: ratio,
      skips: a.skips,
      unmapped: a.unmapped,
      windowHours,
      criteria,
      readyForStrict:
        criteria.window48h &&
        criteria.cycles3 &&
        criteria.unmappedZero &&
        criteria.notEnqueuedMax5pct &&
        criteria.primaryRatio90pct,
    });
  }

  const overrides: ShadowReport["overrides"] = [];
  for (const [pid, o] of Object.entries(opts.overrides ?? {})) {
    if (opts.projectId && pid !== opts.projectId) continue;
    overrides.push({
      projectId: pid,
      mode: o.mode,
      permanent: o.until === undefined,
      ...(o.until !== undefined ? { until: new Date(o.until).toISOString() } : {}),
      ...(o.reason ? { reason: o.reason } : {}),
      ...(o.until !== undefined && o.until <= now ? { expired: true } : {}),
    });
  }

  return { since, generatedAt: now, synced: opts.synced ?? [], projects, overrides };
}

/** Текстовый вид отчёта для CLI без --json. */
export function formatShadowReport(report: ShadowReport): string {
  const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  const lines: string[] = [];
  lines.push(`shadow-report since ${new Date(report.since).toISOString()}`);
  if (report.synced.length) {
    lines.push(`synced: ${report.synced.map((s) => `${s.taskKey}→${s.status}`).join(", ")}`);
  }
  for (const p of report.projects) {
    const c = p.classes;
    lines.push(
      `\n${p.projectId} (${p.mode}): tasks ${p.tasks}, full cycles ${p.fullCycles}, window ${p.windowHours.toFixed(1)} h`,
    );
    lines.push(
      `  match ${c.match} (${pct(p.shares.match)}), repeat ${c.repeat} (${pct(p.shares.repeat)}), skip ${c.skip} (${pct(p.shares.skip)}), unmapped ${c.unmapped} (${pct(p.shares.unmapped)}), graph-only ${c["graph-only"]}`,
    );
    lines.push(
      `  adopted ${p.adopted}, task-not-enqueued ${p.taskNotEnqueued} (${pct(p.taskNotEnqueuedShare)}), (match+repeat)/primary ${pct(p.primaryRatio)}`,
    );
    lines.push(
      `  ready for strict: ${p.readyForStrict ? "yes (by numbers; every skip must be reviewed; switch — owner's word)" : "no"}`,
    );
    for (const s of [...p.skips, ...p.unmapped]) {
      const d = s.detail ?? {};
      lines.push(
        `  - ${s.verdict} ${s.taskKey} ${s.command}: expected ${String(d.expected_node ?? "—")}${d.expected_gate ? ` (${String(d.expected_gate)})` : ""}, actual ${String(d.actual_node ?? "—")}, ${String(d.reason ?? "")}`,
      );
    }
  }
  if (report.overrides.length) {
    lines.push("\nworkGraphProjects overrides:");
    for (const o of report.overrides) {
      lines.push(
        `  ${o.projectId}: ${o.mode} ${o.permanent ? "permanent" : `until ${o.until}`}${o.reason ? ` — ${o.reason}` : ""}${o.expired ? " (expired)" : ""}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

export type { TaskTransitionRow };
