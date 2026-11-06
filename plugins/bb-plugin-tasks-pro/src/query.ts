/**
 * Pure query engine for Tasks Pro: filtering, search, multi-key sorting and
 * grouping over enriched tasks. No IO — every function is deterministic given
 * its arguments and `now`, which keeps the whole engine unit-testable.
 */
import type {
  Folder,
  Label,
  Project,
  Task,
  TaskPriority,
  TaskStatus,
  TaskThread,
} from "./tasks-contract";

export type DateRange =
  | { kind: "today" | "last7d" | "last30d" }
  | { kind: "overdue" | "none" }
  | { kind: "range"; from: string; to: string };

export interface SortKey {
  key: string;
  dir: "asc" | "desc";
}

export type GroupKey =
  | "status"
  | "priority"
  | "project"
  | "folder"
  | "dueBucket"
  | "label"
  | "parent"
  | "none";

export interface Query {
  projectIds?: string[];
  folderIds?: string[];
  statuses?: TaskStatus[];
  priorities?: TaskPriority[];
  labelIds?: string[];
  due?: DateRange;
  created?: DateRange;
  updated?: DateRange;
  completed?: DateRange | "notCompleted";
  threads?: "active" | "any" | "none";
  attachments?: boolean;
  depth?: "top" | "subtasks" | "all";
  search?: string;
  sort?: SortKey[];
  group?: GroupKey;
}

export type EnrichedTask = Omit<Task, "description"> & {
  /** Only present inside the server query pipeline; stripped from list RPC. */
  description?: string;
  project: Project | null;
  folder: Folder | null;
  labels: Label[];
  parent: { id: string; key: string; title: string } | null;
  completedAt: string | null;
  lastStatusChangeAt: string | null;
  /** null when the tasks SQLite database is unavailable. */
  commentCount: number | null;
  attachmentCount: number;
  activeThreads: TaskThread[];
  /** All attached threads (any liveStatus) — null without the SQLite read. */
  threadCount: number | null;
};

export const STATUS_ORDER: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
];
export const PRIORITY_ORDER: readonly TaskPriority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};
export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

const COMPLETED_STATUSES = new Set<TaskStatus>(["done", "canceled"]);
const ACTIVE_THREAD_STATUSES = new Set(["starting", "working"]);

export function isCompleted(task: Pick<Task, "status">): boolean {
  return COMPLETED_STATUSES.has(task.status);
}

// ---------------------------------------------------------------------------
// Dates

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar date `YYYY-MM-DD` of a `Date`. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Calendar date `YYYY-MM-DD` of a stored value: `YYYY-MM-DD` strings pass
 * through (due dates are calendar dates), ISO timestamps convert to local
 * date.
 */
export function valueDate(value: string): string {
  return value.length === 10 ? value : localDate(new Date(value));
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

/** `value` ISO/`YYYY-MM-DD` string (or null) against a DateRange. */
export function matchesDateRange(
  value: string | null,
  range: DateRange,
  now: Date,
  opts?: { isDue?: boolean; completed?: boolean },
): boolean {
  if (range.kind === "none") return value === null;
  if (range.kind === "overdue") {
    // Only meaningful for due dates; a completed task is never overdue.
    if (value === null || opts?.completed === true) return false;
    return valueDate(value) < localDate(now);
  }
  if (value === null) return false;
  const day = valueDate(value);
  const today = localDate(now);
  switch (range.kind) {
    case "today":
      return day === today;
    case "last7d":
      return opts?.isDue
        ? day >= today && day <= addDays(today, 6)
        : day >= addDays(today, -6) && day <= today;
    case "last30d":
      return opts?.isDue
        ? day >= today && day <= addDays(today, 29)
        : day >= addDays(today, -29) && day <= today;
    case "range":
      // Empty bounds are open: {from:"", to:"2026-01-01"} means "up to".
      if (range.from !== "" && day < range.from) return false;
      if (range.to !== "" && day > range.to) return false;
      return true;
  }
}

export type DueBucket = "overdue" | "today" | "thisWeek" | "later" | "none";

export function dueBucketOf(task: EnrichedTask, now: Date): DueBucket {
  if (task.dueDate === null || isCompleted(task)) return "none";
  const today = localDate(now);
  if (task.dueDate < today) return "overdue";
  if (task.dueDate === today) return "today";
  return task.dueDate <= addDays(today, 7) ? "thisWeek" : "later";
}

export const DUE_BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  thisWeek: "This week",
  later: "Later",
  none: "No due date",
};
export const DUE_BUCKET_ORDER: readonly DueBucket[] = [
  "overdue",
  "today",
  "thisWeek",
  "later",
  "none",
];

// ---------------------------------------------------------------------------
// Enrichment join (pure — the server supplies the raw pieces)

export interface EnrichSources {
  projectById: Map<string, Project>;
  folderById: Map<string, Folder>;
  labelById: Map<string, Label>;
  taskById: Map<string, Task>;
  cardByTaskId: Map<
    string,
    { attachmentCount: number; activeThreads: TaskThread[] }
  >;
  /**
   * task_id → sqlite-derived columns; empty when the DB is unavailable.
   * Covers every task including subtasks (cardMeta is top-level only), so it
   * wins for threads/attachments whenever present.
   */
  sqliteByTaskId: Map<
    string,
    {
      completedAt: string | null;
      lastStatusChangeAt: string | null;
      commentCount: number;
      threadCount: number;
      activeThreads: TaskThread[];
      attachmentCount: number;
    }
  >;
  sqliteAvailable: boolean;
}

export function buildEnriched(
  tasks: readonly Task[],
  sources: EnrichSources,
): EnrichedTask[] {
  return tasks.map((task) => {
    const card = sources.cardByTaskId.get(task.id);
    const sql = sources.sqliteByTaskId.get(task.id);
    const parent =
      task.parentTaskId === null
        ? null
        : sources.taskById.get(task.parentTaskId);
    return {
      ...task,
      project: sources.projectById.get(task.projectId) ?? null,
      folder: (() => {
        const folderId = sources.projectById.get(task.projectId)?.folderId;
        return folderId ? (sources.folderById.get(folderId) ?? null) : null;
      })(),
      labels: task.labelIds
        .map((id) => sources.labelById.get(id))
        .filter((l): l is Label => l !== undefined),
      parent:
        parent == null
          ? task.parentTaskId === null
            ? null
            : { id: task.parentTaskId, key: task.parentTaskId, title: "" }
          : { id: parent.id, key: parent.key, title: parent.title },
      completedAt: sql?.completedAt ?? null,
      lastStatusChangeAt: sql?.lastStatusChangeAt ?? null,
      commentCount: sources.sqliteAvailable ? (sql?.commentCount ?? 0) : null,
      // SQLite covers every task (subtasks included); cardMeta is top-level
      // only, so it stays the fallback for when the DB read failed.
      attachmentCount: sql?.attachmentCount ?? card?.attachmentCount ?? 0,
      activeThreads: sql?.activeThreads ?? card?.activeThreads ?? [],
      threadCount: sources.sqliteAvailable ? (sql?.threadCount ?? 0) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Filters — AND between groups, OR inside each multi-select

export function applyFilters(
  tasks: readonly EnrichedTask[],
  q: Query,
  now: Date,
): EnrichedTask[] {
  return tasks.filter((task) => {
    if (q.projectIds?.length && !q.projectIds.includes(task.projectId)) {
      return false;
    }
    if (q.folderIds?.length) {
      const folderId = task.project?.folderId ?? null;
      if (folderId === null || !q.folderIds.includes(folderId)) return false;
    }
    if (q.statuses?.length && !q.statuses.includes(task.status)) return false;
    if (q.priorities?.length && !q.priorities.includes(task.priority)) {
      return false;
    }
    if (
      q.labelIds?.length &&
      !task.labelIds.some((id) => q.labelIds!.includes(id))
    ) {
      return false;
    }
    if (
      q.due &&
      !matchesDateRange(task.dueDate, q.due, now, {
        isDue: true,
        completed: isCompleted(task),
      })
    ) {
      return false;
    }
    if (q.created && !matchesDateRange(task.createdAt, q.created, now)) {
      return false;
    }
    if (q.updated && !matchesDateRange(task.updatedAt, q.updated, now)) {
      return false;
    }
    if (q.completed !== undefined) {
      if (q.completed === "notCompleted") {
        if (isCompleted(task)) return false;
      } else if (!matchesDateRange(task.completedAt, q.completed, now)) {
        return false;
      }
    }
    if (q.threads === "active") {
      if (!task.activeThreads.some((t) => ACTIVE_THREAD_STATUSES.has(t.liveStatus))) {
        return false;
      }
    } else if (q.threads === "any" || q.threads === "none") {
      const count =
        task.threadCount === null
          ? task.activeThreads.length
          : task.threadCount;
      if (q.threads === "any" ? count === 0 : count > 0) return false;
    }
    if (q.attachments === true && task.attachmentCount === 0) return false;
    if (q.depth === "top" && task.parentTaskId !== null) return false;
    if (q.depth === "subtasks" && task.parentTaskId === null) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Search — space-separated tokens, AND, case-insensitive

export function applySearch(
  tasks: readonly EnrichedTask[],
  q: Query,
): EnrichedTask[] {
  const tokens = (q.search ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [...tasks];
  return tasks.filter((task) => {
    const haystack = [
      task.title,
      task.key,
      String(task.number),
      task.description ?? "",
      task.project?.name ?? "",
      task.project?.prefix ?? "",
      ...task.labels.map((l) => l.name),
    ]
      .join("\n")
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

// ---------------------------------------------------------------------------
// Sort — stable multi-key; date fields sort null-last regardless of direction

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function cmpNullable(
  a: string | number | null,
  b: string | number | null,
  dir: "asc" | "desc",
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cmp =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : collator.compare(String(a), String(b));
  return dir === "desc" ? -cmp : cmp;
}

function sortField(task: EnrichedTask, key: string): string | number | null {
  switch (key) {
    case "manual":
    case "position":
      return task.position;
    case "key":
      // "PREFIX-N" sorts project prefix first, then the task number.
      return `${task.project?.prefix ?? task.key.split("-")[0]}\n${String(task.number).padStart(12, "0")}`;
    case "number":
      return task.number;
    case "title":
      return task.title;
    case "project":
      return task.project?.name ?? null;
    case "folder":
      return task.project?.folderId ?? null;
    case "status":
      return STATUS_ORDER.indexOf(task.status);
    case "priority":
      return PRIORITY_ORDER.indexOf(task.priority);
    case "due":
      return task.dueDate;
    case "created":
      return task.createdAt;
    case "updated":
      return task.updatedAt;
    case "completed":
      return task.completedAt;
    case "lastStatusChange":
      return task.lastStatusChangeAt;
    case "comments":
      return task.commentCount;
    case "threads":
      return task.threadCount ?? task.activeThreads.length;
    case "attachments":
      return task.attachmentCount;
    default:
      return null;
  }
}

export function applySort(
  tasks: readonly EnrichedTask[],
  keys: readonly SortKey[] | undefined,
): EnrichedTask[] {
  const active = (keys ?? []).filter(
    (k) => k.dir === "asc" || k.dir === "desc",
  );
  const sorted = [...tasks];
  if (active.length === 0) return sorted;
  sorted.sort((a, b) => {
    for (const { key, dir } of active) {
      const cmp = cmpNullable(sortField(a, key), sortField(b, key), dir);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
  return sorted;
}

// ---------------------------------------------------------------------------
// Group — sections with header and count

export interface TaskGroup {
  id: string;
  label: string;
  count: number;
  tasks: EnrichedTask[];
}

function groupByOrdered(
  tasks: readonly EnrichedTask[],
  keyOf: (t: EnrichedTask) => string,
  labelOf: (id: string, sample: EnrichedTask | undefined) => string,
  order: (a: string, b: string) => number,
): TaskGroup[] {
  const buckets = new Map<string, EnrichedTask[]>();
  for (const task of tasks) {
    const id = keyOf(task);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(task);
    else buckets.set(id, [task]);
  }
  const ids = [...buckets.keys()].sort(order);
  return ids.map((id) => {
    const groupTasks = buckets.get(id)!;
    return {
      id,
      label: labelOf(id, groupTasks[0]),
      count: groupTasks.length,
      tasks: groupTasks,
    };
  });
}

export function applyGroup(
  tasks: readonly EnrichedTask[],
  group: GroupKey | undefined,
  now: Date,
): TaskGroup[] {
  const key = group ?? "none";
  if (key === "none") {
    return [{ id: "all", label: "All tasks", count: tasks.length, tasks: [...tasks] }];
  }
  switch (key) {
    case "status":
      return groupByOrdered(
        tasks,
        (t) => t.status,
        (id) => STATUS_LABEL[id as TaskStatus] ?? id,
        (a, b) =>
          STATUS_ORDER.indexOf(a as TaskStatus) -
          STATUS_ORDER.indexOf(b as TaskStatus),
      );
    case "priority":
      return groupByOrdered(
        tasks,
        (t) => t.priority,
        (id) => PRIORITY_LABEL[id as TaskPriority] ?? id,
        (a, b) =>
          PRIORITY_ORDER.indexOf(a as TaskPriority) -
          PRIORITY_ORDER.indexOf(b as TaskPriority),
      );
    case "project":
      return groupByOrdered(
        tasks,
        (t) => t.projectId,
        (_id, sample) =>
          sample?.project
            ? `${sample.project.name} (${sample.project.prefix})`
            : "Unknown project",
        collator.compare,
      );
    case "folder":
      return groupByOrdered(
        tasks,
        (t) => t.project?.folderId ?? "",
        (id, sample) =>
          id === "" ? "No folder" : (sample?.folder?.name ?? id),
        (a, b) => (a === "" ? 1 : b === "" ? -1 : collator.compare(a, b)),
      );
    case "dueBucket":
      return groupByOrdered(
        tasks,
        (t) => dueBucketOf(t, now),
        (id) => DUE_BUCKET_LABEL[id as DueBucket] ?? id,
        (a, b) =>
          DUE_BUCKET_ORDER.indexOf(a as DueBucket) -
          DUE_BUCKET_ORDER.indexOf(b as DueBucket),
      );
    case "label": {
      // A task with several labels appears in each label's section.
      const buckets = new Map<string, { label: string; tasks: EnrichedTask[] }>();
      const unlabeled: EnrichedTask[] = [];
      for (const task of tasks) {
        if (task.labels.length === 0) {
          unlabeled.push(task);
          continue;
        }
        for (const label of task.labels) {
          const bucket = buckets.get(label.id);
          if (bucket) bucket.tasks.push(task);
          else buckets.set(label.id, { label: label.name, tasks: [task] });
        }
      }
      const groups = [...buckets.entries()]
        .sort((a, b) => collator.compare(a[1].label, b[1].label))
        .map(([id, b]) => ({ id, label: b.label, count: b.tasks.length, tasks: b.tasks }));
      if (unlabeled.length > 0) {
        groups.push({
          id: "__none__",
          label: "No label",
          count: unlabeled.length,
          tasks: unlabeled,
        });
      }
      return groups;
    }
    case "parent":
      return groupByOrdered(
        tasks,
        (t) => t.parentTaskId ?? "",
        (id, sample) => {
          if (id === "") return "No parent";
          const p = sample?.parent;
          return p ? `${p.key}${p.title ? ` · ${p.title}` : ""}` : id;
        },
        (a, b) => (a === "" ? 1 : b === "" ? -1 : collator.compare(a, b)),
      );
  }
}
