import { useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  experimental_useSidebarThreadSplit,
  useBbNavigate,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
  PluginSidebarThreadActions,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Icon } from "./components/ui/icon";
import type { IconName } from "./components/ui/icon";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";
import {
  groupSidebarThreads,
  threadDisplayTitle,
  type GroupingGroup,
  type GroupingRow,
} from "./lib/thread-groups";

const KNOWN_INDICATORS = new Set([
  "background-agent",
  "background-command",
  "draft",
  "goal",
  "plan-mode",
  "runtime",
  "unread-error",
  "unread-success",
  "waiting-for-input",
  "workflow",
  "working-draft",
]);

function IndicatorDot({
  indicator,
  label,
}: {
  indicator: string;
  label: string | null;
}) {
  if (indicator === "none" || !KNOWN_INDICATORS.has(indicator)) {
    return null;
  }
  return (
    <span
      role={label === null ? undefined : "img"}
      aria-label={label ?? undefined}
      className={cn(
        "size-2 shrink-0 rounded-full",
        indicator === "unread-error"
          ? "bg-destructive"
          : indicator === "waiting-for-input"
            ? "bg-sidebar-primary"
            : "bg-muted-foreground/60",
      )}
    />
  );
}

function InlineRenameInput({
  initialValue,
  onSave,
  onCancel,
}: {
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (save) {
      const trimmed = value.trim();
      if (trimmed !== "") {
        onSave(trimmed);
        return;
      }
    }
    onCancel();
  };

  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className="h-6 min-w-0 flex-1 px-1.5 py-0 text-xs"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => {
        finish(false);
      }}
    />
  );
}

/** Same shape as bb's native "Copy thread link": the personal project
 *  hosts its threads at `/threads/<id>`, every other project nests them. */
function threadLinkHref(
  thread: PluginSidebarThread,
  projects: readonly PluginSidebarProject[],
): string {
  const isPersonal = projects.some(
    (p) => p.id === thread.projectId && p.isPersonal,
  );
  const path = isPersonal
    ? `/threads/${thread.id}`
    : `/projects/${thread.projectId}/threads/${thread.id}`;
  return new URL(path, window.location.origin).toString();
}

function ThreadMenuItems({
  menuType,
  thread,
  projects,
  isAvailable,
  actions,
  onRename,
}: {
  menuType: "context" | "dropdown";
  thread: PluginSidebarThread;
  projects: readonly PluginSidebarProject[];
  isAvailable: boolean;
  actions: PluginSidebarThreadActions;
  onRename: () => void;
}) {
  const items: Array<{
    key: string;
    label: string;
    icon: IconName;
    destructive?: boolean;
    onSelect: () => void;
  }> = [
    ...(isAvailable
      ? [
          {
            key: "split",
            label: "Open in split",
            icon: "Columns2" as const,
            onSelect: () => actions.open(thread.id, { split: true }),
          },
        ]
      : []),
    {
      key: "copy-link",
      label: "Copy thread link",
      icon: "Copy" as const,
      onSelect: () => {
        navigator.clipboard
          .writeText(threadLinkHref(thread, projects))
          .then(() => toast.success("Thread link copied"))
          .catch(() => toast.error("Failed to copy thread link"));
      },
    },
    {
      key: "pin",
      label: thread.isPinned ? "Unpin" : "Pin",
      icon: thread.isPinned ? "PinOff" : "Pin",
      onSelect: () => {
        void actions.setPinned(thread.id, !thread.isPinned);
      },
    },
    {
      key: "read",
      label: thread.isUnread ? "Mark as read" : "Mark as unread",
      icon: thread.isUnread ? "MailOpen" : "Mail",
      onSelect: () => {
        void actions.setRead(thread.id, thread.isUnread);
      },
    },
    {
      key: "rename",
      label: "Rename",
      icon: "Edit",
      onSelect: onRename,
    },
    {
      key: "archive",
      label: "Archive",
      icon: "Archive",
      onSelect: () => {
        actions.archive(thread.id);
      },
    },
    {
      key: "delete",
      label: "Delete",
      icon: "Trash2",
      destructive: true,
      onSelect: () => {
        actions.requestDelete(thread.id);
      },
    },
  ];

  return (
    <>
      {items.map((item) => {
        if (menuType === "context") {
          return (
            <ContextMenuItem
              key={item.key}
              onSelect={item.onSelect}
              className={
                item.destructive
                  ? "text-destructive focus:bg-destructive/15 focus:text-destructive"
                  : undefined
              }
            >
              <Icon name={item.icon} className="size-4" />
              <span>{item.label}</span>
            </ContextMenuItem>
          );
        }
        return (
          <DropdownMenuItem
            key={item.key}
            onSelect={item.onSelect}
            variant={item.destructive ? "destructive" : "default"}
          >
            <Icon name={item.icon} className="size-4" />
            <span>{item.label}</span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** bb's own rows keep quick actions hidden until the row is hovered or
 *  focused, and always visible on touch. */
function hoverActionClassName(isCompactViewport: boolean): string {
  return cn(
    "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100",
    isCompactViewport ? "opacity-100" : "opacity-0",
  );
}

function ThreadRow({
  row,
  projects,
  activeThreadId,
  isCompactViewport,
  showBranchName,
  onNavigate,
  actions,
  renamingThreadId,
  setRenamingThreadId,
}: {
  row: GroupingRow<PluginSidebarThread>;
  projects: readonly PluginSidebarProject[];
  activeThreadId: string | null;
  isCompactViewport: boolean;
  showBranchName: boolean;
  onNavigate: () => void;
  actions: PluginSidebarThreadActions;
  renamingThreadId: string | null;
  setRenamingThreadId: (id: string | null) => void;
}) {
  const { thread, depth } = row;
  const { splitProps, isAvailable } = experimental_useSidebarThreadSplit(
    thread.id,
  );
  const isRenaming = renamingThreadId === thread.id;
  const isActive = thread.id === activeThreadId;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (isRenaming) return;
    const isSplit = (e.metaKey || e.ctrlKey) && isAvailable;
    if (isSplit) {
      e.preventDefault();
      actions.open(thread.id, { split: true });
    } else {
      e.preventDefault();
      actions.open(thread.id);
      onNavigate();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLAnchorElement>) => {
    if (isRenaming) return;
    if (e.key === "Enter") {
      const isSplit = (e.metaKey || e.ctrlKey) && isAvailable;
      if (isSplit) {
        e.preventDefault();
        actions.open(thread.id, { split: true });
      } else {
        e.preventDefault();
        actions.open(thread.id);
        onNavigate();
      }
    }
  };

  const displayTitle = threadDisplayTitle(thread, "New thread");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <a
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          tabIndex={0}
          aria-current={isActive ? "page" : undefined}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          className={cn(
            "group/row relative flex h-7 items-center gap-1.5 rounded-md pr-1.5 text-sm select-none cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
            isActive
              ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
              : "text-sidebar-foreground hover:bg-sidebar-accent/60",
          )}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          {...splitProps}
        >
          <IndicatorDot
            indicator={thread.indicator}
            label={thread.indicatorLabel}
          />

          {isRenaming ? (
            <InlineRenameInput
              initialValue={displayTitle}
              onSave={(newTitle) => {
                void actions.rename(thread.id, newTitle);
                setRenamingThreadId(null);
              }}
              onCancel={() => {
                setRenamingThreadId(null);
              }}
            />
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                thread.isUnread
                  ? "font-semibold text-sidebar-foreground"
                  : undefined,
              )}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setRenamingThreadId(thread.id);
              }}
            >
              {displayTitle}
            </span>
          )}

          {showBranchName && !isRenaming && thread.environment?.branchName ? (
            <span className="flex max-w-[100px] shrink-0 items-center gap-0.5 truncate text-[11px] text-muted-foreground">
              <Icon name="GitBranch" className="size-3 shrink-0" />
              <span className="truncate">{thread.environment.branchName}</span>
            </span>
          ) : null}

          {!isRenaming && thread.isPinned ? (
            <Icon
              name="Pin"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : null}

          {!isRenaming ? (
            <button
              type="button"
              aria-label={`Archive ${displayTitle}`}
              title="Archive"
              className={hoverActionClassName(isCompactViewport)}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                actions.archive(thread.id);
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
            >
              <Icon name="Archive" className="size-3.5" />
            </button>
          ) : null}

          {!isRenaming ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Thread actions"
                  className={hoverActionClassName(isCompactViewport)}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <Icon name="MoreHorizontal" className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <ThreadMenuItems
                  menuType="dropdown"
                  thread={thread}
                  projects={projects}
                  isAvailable={isAvailable}
                  actions={actions}
                  onRename={() => setRenamingThreadId(thread.id)}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </a>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ThreadMenuItems
          menuType="context"
          thread={thread}
          projects={projects}
          isAvailable={isAvailable}
          actions={actions}
          onRename={() => setRenamingThreadId(thread.id)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CollapsedThreadList({
  activeThreadId,
  isCompactViewport,
  onNavigate,
  Original,
}: PluginThreadListProps) {
  const { status, threads, projects } = experimental_useSidebarThreads();
  const actions = experimental_useSidebarThreadActions();
  const navigate = useBbNavigate();
  const { values } = useSettings();

  const raw = values?.visibleThreads;
  const limit =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0
      ? Math.floor(raw)
      : 5;
  const keepAttention = values?.keepAttention !== false;
  const showBranchName = values?.showBranchName === true;
  const showThreadCount = values?.showThreadCount === true;

  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [foldedProjectIds, setFoldedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  // Project drag-and-drop: the frontend sidebar API has no reorder action, so
  // the move goes to this plugin's backend, which owns `bb.sdk.projects`.
  const rpc = useRpc<typeof rpcContract>();
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<{
    projectId: string;
    edge: "after" | "before";
  } | null>(null);

  const moveProject = (
    movedProjectId: string,
    targetProjectId: string,
    edge: "after" | "before",
  ) => {
    const rest = projects.filter((p) => p.id !== movedProjectId);
    const at = rest.findIndex((p) => p.id === targetProjectId);
    if (at === -1) {
      return;
    }
    const insertAt = edge === "before" ? at : at + 1;
    const previous = rest[insertAt - 1] ?? null;
    const next = rest[insertAt] ?? null;
    void rpc.call("reorder_project", {
      projectId: movedProjectId,
      previousProjectId: previous === null ? null : previous.id,
      nextProjectId: next === null ? null : next.id,
    });
  };

  const groups: readonly GroupingGroup<PluginSidebarThread>[] = useMemo(
    () =>
      groupSidebarThreads<PluginSidebarThread>({
        threads,
        projects,
        activeThreadId,
        limit,
        keepAttention,
        expandedGroupKeys,
        foldedProjectIds,
      }),
    [
      threads,
      projects,
      activeThreadId,
      limit,
      keepAttention,
      expandedGroupKeys,
      foldedProjectIds,
    ],
  );

  const toggleFold = (projectId: string) => {
    setFoldedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const toggleExpand = (groupKey: string) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  if (values?.useCollapsedList === false) {
    return <Original />;
  }

  if (status === "loading") {
    return (
      <div role="status" className="px-3 py-2 text-xs text-muted-foreground">
        Loading threads…
      </div>
    );
  }

  if (status === "error") {
    return <Original />;
  }

  if (groups.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        No threads yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-1">
      {groups.map((group: GroupingGroup<PluginSidebarThread>) => (
        <div key={group.key} className="flex flex-col gap-0.5">
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", group.projectId);
              setDraggingProjectId(group.projectId);
            }}
            onDragEnd={() => {
              setDraggingProjectId(null);
              setDropTarget(null);
            }}
            onDragOver={(e) => {
              if (
                draggingProjectId === null ||
                draggingProjectId === group.projectId
              ) {
                return;
              }
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const box = e.currentTarget.getBoundingClientRect();
              setDropTarget({
                projectId: group.projectId,
                edge:
                  e.clientY - box.top > box.height / 2 ? "after" : "before",
              });
            }}
            onDragLeave={() => {
              setDropTarget((prev) =>
                prev?.projectId === group.projectId ? null : prev,
              );
            }}
            onDrop={(e) => {
              e.preventDefault();
              const moved = draggingProjectId;
              const target = dropTarget;
              setDraggingProjectId(null);
              setDropTarget(null);
              if (moved === null || target === null || moved === group.projectId) {
                return;
              }
              moveProject(moved, target.projectId, target.edge);
            }}
            className={cn(
              "group/header flex h-6 cursor-grab items-center gap-1 rounded-md px-1 text-xs font-medium text-sidebar-foreground/75",
              draggingProjectId === group.projectId && "opacity-50",
              dropTarget?.projectId === group.projectId &&
                (dropTarget.edge === "before"
                  ? "border-t border-sidebar-primary"
                  : "border-b border-sidebar-primary"),
            )}
          >
            <button
              type="button"
              aria-expanded={!group.isFolded}
              aria-label={
                group.isFolded
                  ? `Expand ${group.projectName}`
                  : `Collapse ${group.projectName}`
              }
              onClick={() => toggleFold(group.projectId)}
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Icon
                name={group.isFolded ? "ChevronRight" : "ChevronDown"}
                className="size-3.5 shrink-0"
              />
            </button>
            <button
              type="button"
              onClick={() => {
                navigate.toProject(group.projectId);
                onNavigate();
              }}
              className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-foreground"
            >
              {group.projectName}
            </button>
            {showThreadCount ? (
              <span className="shrink-0 text-[11px] text-muted-foreground/70">
                {group.rootCount}
              </span>
            ) : null}
            <button
              type="button"
              aria-label={`New thread in ${group.projectName}`}
              title={`New thread in ${group.projectName}`}
              onClick={() => {
                actions.openNewThread({
                  projectId: group.projectId,
                  focusPrompt: true,
                });
                onNavigate();
              }}
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Icon name="Plus" className="size-3.5" />
            </button>
          </div>

          {!group.isFolded && (
            <div className="flex flex-col gap-0.5">
              {group.rows.map((row: GroupingRow<PluginSidebarThread>) => (
                <ThreadRow
                  key={row.thread.id}
                  row={row}
                  projects={projects}
                  activeThreadId={activeThreadId}
                  isCompactViewport={isCompactViewport}
                  showBranchName={showBranchName}
                  onNavigate={onNavigate}
                  actions={actions}
                  renamingThreadId={renamingThreadId}
                  setRenamingThreadId={setRenamingThreadId}
                />
              ))}

              {(group.hiddenCount > 0 || group.isExpanded) && (
                <button
                  type="button"
                  aria-expanded={group.isExpanded}
                  onClick={() => toggleExpand(group.key)}
                  className="flex h-6 w-full cursor-pointer items-center rounded-md pl-2 text-left text-[11px] text-sidebar-foreground/55 hover:text-sidebar-foreground"
                >
                  {group.isExpanded
                    ? "Show less"
                    : `Show more (${group.hiddenCount})`}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "collapsed",
    title: "Collapsed thread list",
    description:
      "Показывает первые N чатов проекта, остальные — под «Show more».",
    component: CollapsedThreadList,
  });
});
