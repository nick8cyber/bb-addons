/** Sortable, groupable task table. */
import { applyGroup, type EnrichedTask, type GroupKey, type SortKey } from "./query";
import { DueCell, PriorityChip, StatusChip, formatDate } from "./format";

interface Column {
  key: string;
  label: string;
  sortable: boolean;
  className?: string;
}

const COLUMNS: Column[] = [
  { key: "key", label: "Key", sortable: true },
  { key: "title", label: "Title", sortable: true },
  { key: "project", label: "Project", sortable: true },
  { key: "status", label: "Status", sortable: true },
  { key: "priority", label: "Priority", sortable: true },
  { key: "labels", label: "Labels", sortable: false },
  { key: "due", label: "Due", sortable: true },
  { key: "created", label: "Created", sortable: true },
  { key: "updated", label: "Updated", sortable: true },
  { key: "completed", label: "Completed", sortable: true },
  { key: "comments", label: "Cmts", sortable: true },
  { key: "threads", label: "Threads", sortable: true },
  { key: "attachments", label: "Att.", sortable: true },
];

function SortGlyph({ sort, column }: { sort: SortKey[]; column: string }) {
  const index = sort.findIndex((s) => s.key === column);
  if (index === -1) return null;
  return (
    <span className="ml-1 inline-flex items-center text-primary">
      {sort[index].dir === "asc" ? "↑" : "↓"}
      {sort.length > 1 ? (
        <sup className="ml-0.5 text-[9px]">{index + 1}</sup>
      ) : null}
    </span>
  );
}

export function TaskTable({
  tasks,
  sort,
  group,
  collapsed,
  onSortClick,
  onToggleGroup,
  onSelect,
  now,
}: {
  tasks: EnrichedTask[];
  sort: SortKey[];
  group: GroupKey;
  collapsed: ReadonlySet<string>;
  onSortClick(key: string, shift: boolean): void;
  onToggleGroup(id: string): void;
  onSelect(task: EnrichedTask): void;
  now: Date;
}) {
  const groups = applyGroup(tasks, group, now);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
          <tr className="border-b border-border text-left text-muted-foreground">
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={`px-2 py-2 font-medium whitespace-nowrap ${col.sortable ? "cursor-pointer select-none hover:text-foreground" : ""}`}
                onClick={
                  col.sortable
                    ? (e) => onSortClick(col.key, e.shiftKey)
                    : undefined
                }
                title={
                  col.sortable
                    ? "Click to sort · Shift+click to add sort key"
                    : undefined
                }
              >
                {col.label}
                {col.sortable ? <SortGlyph sort={sort} column={col.key} /> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupSection
              key={g.id}
              group={g}
              collapsed={collapsed.has(g.id)}
              onToggle={() => onToggleGroup(g.id)}
              onSelect={onSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupSection({
  group,
  collapsed,
  onToggle,
  onSelect,
}: {
  group: { id: string; label: string; count: number; tasks: EnrichedTask[] };
  collapsed: boolean;
  onToggle(): void;
  onSelect(task: EnrichedTask): void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border bg-muted/40 hover:bg-muted/70"
        onClick={onToggle}
      >
        <td colSpan={COLUMNS.length} className="px-2 py-1.5">
          <span className="inline-flex items-center gap-2 text-xs font-medium">
            <span aria-hidden className="text-[10px] text-muted-foreground">
              {collapsed ? "▸" : "▾"}
            </span>
            {group.label}
            <span className="text-muted-foreground">({group.count})</span>
          </span>
        </td>
      </tr>
      {collapsed
        ? null
        : group.tasks.map((task) => (
            <TaskRow key={task.id} task={task} onSelect={onSelect} />
          ))}
    </>
  );
}

function TaskRow({
  task,
  onSelect,
}: {
  task: EnrichedTask;
  onSelect(task: EnrichedTask): void;
}) {
  return (
    <tr
      className="cursor-pointer border-b border-border/60 hover:bg-accent/50"
      onClick={() => onSelect(task)}
    >
      <td className="px-2 py-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
        {task.key}
      </td>
      <td className="max-w-0 min-w-48 truncate px-2 py-1.5" title={task.title}>
        {task.parentTaskId !== null ? (
          <span className="mr-1 text-muted-foreground">↳</span>
        ) : null}
        {task.title}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {task.project ? (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[11px]"
            title={task.project.name}
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: task.project.color }}
            />
            {task.project.prefix}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-2 py-1.5">
        <StatusChip status={task.status} />
      </td>
      <td className="px-2 py-1.5">
        <PriorityChip priority={task.priority} />
      </td>
      <td className="max-w-40 truncate px-2 py-1.5">
        {task.labels.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {task.labels.map((l) => (
              <span
                key={l.id}
                className="rounded-full border border-border px-1.5 py-0.5 text-[10px]"
                style={{ borderColor: l.color }}
              >
                {l.name}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <DueCell task={task} />
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
        {formatDate(task.createdAt)}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
        {formatDate(task.updatedAt)}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
        {task.commentCount === null ? "—" : formatDate(task.completedAt)}
      </td>
      <td className="px-2 py-1.5 text-center text-muted-foreground">
        {task.commentCount ?? "—"}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {task.activeThreads.length > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
            ● {task.activeThreads.length}
            {task.threadCount !== null && task.threadCount > task.activeThreads.length
              ? `/${task.threadCount}`
              : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {task.threadCount ?? "—"}
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 text-center text-muted-foreground">
        {task.attachmentCount > 0 ? task.attachmentCount : "—"}
      </td>
    </tr>
  );
}
