/** Small shared display helpers. */
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  type EnrichedTask,
} from "./query";
import type { TaskPriority, TaskStatus } from "./tasks-contract";

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.valueOf())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isDueOverdue(task: EnrichedTask): boolean {
  if (task.dueDate === null) return false;
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return (
    task.dueDate < todayStr &&
    task.status !== "done" &&
    task.status !== "canceled"
  );
}

export const STATUS_CHIP_CLASS: Record<TaskStatus, string> = {
  backlog: "bg-muted text-muted-foreground",
  todo: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  in_progress: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  in_review: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  canceled: "bg-muted text-muted-foreground line-through",
};

export const PRIORITY_CHIP_CLASS: Record<TaskPriority, string> = {
  urgent: "bg-red-500/15 text-red-600 dark:text-red-400",
  high: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  medium: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  low: "bg-muted text-muted-foreground",
  none: "bg-muted/50 text-muted-foreground",
};

export function StatusChip({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${STATUS_CHIP_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PriorityChip({ priority }: { priority: TaskPriority }) {
  if (priority === "none") return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${PRIORITY_CHIP_CLASS[priority]}`}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

export function DueCell({ task }: { task: EnrichedTask }) {
  if (task.dueDate === null)
    return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={`whitespace-nowrap ${isDueOverdue(task) ? "font-medium text-red-600 dark:text-red-400" : ""}`}
    >
      {formatDate(task.dueDate)}
    </span>
  );
}
