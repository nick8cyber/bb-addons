/** Kanban board grouped by workflow status. Read-only: no drag-and-drop. */
import {
  STATUS_LABEL,
  STATUS_ORDER,
  type EnrichedTask,
} from "./query";
import { DueCell, PriorityChip } from "./format";

export function TaskBoard({
  tasks,
  onSelect,
}: {
  tasks: EnrichedTask[];
  onSelect(task: EnrichedTask): void;
}) {
  const columns = STATUS_ORDER.map((status) => ({
    status,
    tasks: tasks.filter((t) => t.status === status),
  }));
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
      {columns.map(({ status, tasks: columnTasks }) => (
        <div
          key={status}
          className="flex w-64 shrink-0 flex-col rounded-lg border border-border bg-muted/30"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-semibold">{STATUS_LABEL[status]}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {columnTasks.length}
            </span>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {columnTasks.map((task) => (
              <BoardCard key={task.id} task={task} onSelect={onSelect} />
            ))}
            {columnTasks.length === 0 ? (
              <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                No tasks
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function BoardCard({
  task,
  onSelect,
}: {
  task: EnrichedTask;
  onSelect(task: EnrichedTask): void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(task)}
      className="block w-full rounded-md border border-border bg-card p-2.5 text-left shadow-sm hover:border-primary/50 hover:shadow"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {task.key}
        </span>
        {task.project ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: task.project.color }}
            />
            {task.project.prefix}
          </span>
        ) : null}
      </div>
      <div className="mt-1 line-clamp-2 text-xs font-medium">
        {task.parentTaskId !== null ? (
          <span className="mr-1 text-muted-foreground">↳</span>
        ) : null}
        {task.title}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <PriorityChip priority={task.priority} />
        <span className="ml-auto text-[10px]">
          <DueCell task={task} />
        </span>
      </div>
      {task.labels.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <span
              key={l.id}
              className="rounded-full border border-border px-1.5 py-0.5 text-[9px]"
              style={{ borderColor: l.color }}
            >
              {l.name}
            </span>
          ))}
        </div>
      ) : null}
      {task.activeThreads.length > 0 || task.attachmentCount > 0 ? (
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          {task.activeThreads.length > 0 ? (
            <span className="text-blue-600 dark:text-blue-400">
              ● {task.activeThreads.length} thread
              {task.activeThreads.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {task.attachmentCount > 0 ? (
            <span>{task.attachmentCount} att.</span>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}
