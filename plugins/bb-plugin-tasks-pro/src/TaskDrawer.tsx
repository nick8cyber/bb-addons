/** Read-only task detail drawer. */
import { useEffect, useState } from "react";
import {
  Markdown,
  UrlLink,
  experimental_useSidebarNavigation,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Contract, DetailResult, EnrichedTask } from "./app-types";
import { STATUS_LABEL } from "./query";
import {
  PriorityChip,
  StatusChip,
  formatDate,
  formatDateTime,
} from "./format";

const KIND_LABEL: Record<string, string> = {
  user: "You",
  agent: "Agent",
  system: "System",
};

export function TaskDrawer({
  taskId,
  onClose,
  onOpenTask,
}: {
  taskId: string;
  onClose(): void;
  onOpenTask(taskId: string): void;
}) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const nav = experimental_useSidebarNavigation();
  const [detail, setDetail] = useState<DetailResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    rpc
      .call("getTaskDetail", { taskId })
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, taskId]);

  const openInTasks = () => {
    nav.actions.activate("tasks/tasks", { target: "current" });
  };

  return (
    <aside className="flex w-96 max-w-full shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground">
          {detail?.task?.key ?? "…"}
        </span>
        {detail?.task ? <StatusChip status={detail.task.status} /> : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={openInTasks}
            className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-accent"
            title="Open this task in the builtin Tasks panel"
          >
            Open in Tasks
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </div>
        ) : detail === null ? (
          <div className="p-3 text-xs text-muted-foreground">Loading…</div>
        ) : !detail.available ? (
          <div className="p-3 text-xs text-muted-foreground">
            The builtin tasks plugin is unavailable.
          </div>
        ) : detail.task === null ? (
          <div className="p-3 text-xs text-muted-foreground">
            Task not found.
          </div>
        ) : (
          <DrawerBody
            detail={detail}
            onOpenTask={onOpenTask}
            onOpenThread={(id) => navigate.toThread(id)}
          />
        )}
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function DrawerBody({
  detail,
  onOpenTask,
  onOpenThread,
}: {
  detail: DetailResult;
  onOpenTask(taskId: string): void;
  onOpenThread(threadId: string): void;
}) {
  const task = detail.task as EnrichedTask;
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold leading-snug">{task.title}</h2>
      <div className="space-y-1.5">
        <Field label="Project">
          {task.project ? task.project.name : "—"}
          {task.folder ? ` · ${task.folder.name}` : ""}
        </Field>
        <Field label="Status">{STATUS_LABEL[task.status]}</Field>
        <Field label="Priority">
          <PriorityChip priority={task.priority} />
        </Field>
        <Field label="Labels">
          {task.labels.length === 0 ? (
            "—"
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
        </Field>
        <Field label="Due">{formatDate(task.dueDate)}</Field>
        {task.parent ? (
          <Field label="Parent">
            <button
              type="button"
              onClick={() => onOpenTask(task.parent!.id)}
              className="text-primary hover:underline"
            >
              {task.parent.key}
              {task.parent.title ? ` · ${task.parent.title}` : ""}
            </button>
          </Field>
        ) : null}
        <Field label="Created">{formatDateTime(task.createdAt)}</Field>
        <Field label="Updated">{formatDateTime(task.updatedAt)}</Field>
        <Field label="Completed">
          {task.completedAt ? formatDateTime(task.completedAt) : "—"}
        </Field>
        <Field label="Last status">
          {task.lastStatusChangeAt
            ? formatDateTime(task.lastStatusChangeAt)
            : "—"}
        </Field>
      </div>

      {task.description.trim() !== "" ? (
        <section>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Description
          </h3>
          <Markdown content={task.description} className="text-xs" />
        </section>
      ) : null}

      {detail.subtasks.length > 0 ? (
        <section>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Subtasks ({detail.subtasks.length})
          </h3>
          <ul className="space-y-1">
            {detail.subtasks.map((sub) => (
              <li key={sub.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask(sub.id)}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
                >
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {sub.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{sub.title}</span>
                  <StatusChip status={sub.status} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.threads.length > 0 ? (
        <section>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Threads ({detail.threads.length})
          </h3>
          <ul className="space-y-1">
            {detail.threads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onOpenThread(t.threadId)}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
                  title={`Open thread ${t.threadId}`}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      t.liveStatus === "starting" || t.liveStatus === "working"
                        ? "bg-blue-500"
                        : t.liveStatus === "failed"
                          ? "bg-red-500"
                          : "bg-muted-foreground"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {t.title || t.threadId}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t.liveStatus}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.pullRequests.length > 0 ? (
        <section>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Pull requests ({detail.pullRequests.length})
          </h3>
          <ul className="space-y-1">
            {detail.pullRequests.map((pr) => (
              <li key={pr.url} className="text-xs">
                <UrlLink href={pr.url} className="text-primary hover:underline">
                  #{pr.number} {pr.title}
                </UrlLink>
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {pr.state}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Comments ({detail.comments.length})
        </h3>
        {detail.comments.length === 0 ? (
          <div className="text-xs text-muted-foreground">No comments.</div>
        ) : (
          <ul className="space-y-2">
            {detail.comments.map((c) => (
              <li
                key={c.id}
                className="rounded-md border border-border bg-background p-2"
              >
                <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="font-medium">
                    {KIND_LABEL[c.kind] ?? c.kind}
                    {c.kind !== "system" && c.authorName !== ""
                      ? ` · ${c.authorName}`
                      : ""}
                  </span>
                  <span className="ml-auto">{formatDateTime(c.createdAt)}</span>
                </div>
                {c.kind === "system" ? (
                  <div className="text-xs text-muted-foreground italic">
                    {c.body}
                  </div>
                ) : (
                  <Markdown content={c.body} className="text-xs" />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
