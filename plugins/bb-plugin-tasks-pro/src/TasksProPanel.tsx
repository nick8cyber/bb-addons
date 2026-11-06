/** Tasks Pro main panel: toolbar, table/board views, drawer, saved views. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useRealtimeConnectionState,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type {
  CatalogData,
  Contract,
  EnrichedTask,
  SavedViewData,
} from "./app-types";
import type { GroupKey, Query, SortKey } from "./query";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  PRIORITY_ORDER,
} from "./query";
import type { TaskPriority, TaskStatus } from "./tasks-contract";
import { DateRangeSelect, Dropdown, MultiSelect, SimpleSelect } from "./controls";
import { TaskTable } from "./TaskTable";
import { TaskBoard } from "./TaskBoard";
import { TaskDrawer } from "./TaskDrawer";

const GROUP_OPTIONS: { value: GroupKey; label: string }[] = [
  { value: "none", label: "No grouping" },
  { value: "status", label: "Group: Status" },
  { value: "priority", label: "Group: Priority" },
  { value: "project", label: "Group: Project" },
  { value: "folder", label: "Group: Folder" },
  { value: "dueBucket", label: "Group: Due" },
  { value: "label", label: "Group: Label" },
  { value: "parent", label: "Group: Parent" },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function TasksProPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<Contract>();

  // ---- data ----
  const [catalog, setCatalog] = useState<CatalogData | null>(null);
  const [views, setViews] = useState<SavedViewData[]>([]);
  const [tasks, setTasks] = useState<EnrichedTask[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- ui state ----
  const [viewMode, setViewMode] = useState<"table" | "board">("table");
  const [filters, setFilters] = useState<Query>({});
  const [sort, setSort] = useState<SortKey[]>([]);
  const [group, setGroup] = useState<GroupKey>("none");
  const [searchText, setSearchText] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const debouncedSearch = useDebounced(searchText, 300);

  const effectiveQuery = useMemo<Query>(
    () => ({
      ...filters,
      sort: sort.length > 0 ? sort : undefined,
      group,
      search: debouncedSearch.trim() === "" ? undefined : debouncedSearch.trim(),
    }),
    [filters, sort, group, debouncedSearch],
  );
  const effectiveQueryJson = JSON.stringify(effectiveQuery);

  const loadCatalog = useCallback(
    async (force: boolean) => {
      try {
        const result = await rpc.call("getCatalog", { refresh: force });
        setCatalog(result);
      } catch (e) {
        setCatalog({
          available: false,
          projects: [],
          folders: [],
          labelsByProject: {},
        });
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    },
    [rpc],
  );

  const loadViews = useCallback(async () => {
    try {
      const result = await rpc.call("listViews", null);
      setViews(result.views);
    } catch {
      // views are optional; keep the panel working without them
    }
  }, [rpc]);

  const loadTasks = useCallback(
    async (query: Query, force: boolean) => {
      try {
        const result = await rpc.call("queryTasks", {
          ...query,
          ...(force ? { refresh: true } : {}),
        });
        setTasks(result.tasks);
        setTotal(result.total);
        setLoadError(null);
      } catch (e) {
        setTasks([]);
        setTotal(0);
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [rpc],
  );

  // Initial + query-change load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const q = JSON.parse(effectiveQueryJson) as Query;
      if (cancelled) return;
      await loadTasks(q, false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveQueryJson, tick]);

  useEffect(() => {
    void loadCatalog(false);
    void loadViews();
  }, [loadCatalog, loadViews]);

  // Refresh on window focus and realtime reconnect.
  useEffect(() => {
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection !== "connected") {
      wasConnected.current = false;
      return;
    }
    if (wasConnected.current) return;
    wasConnected.current = true;
    setTick((t) => t + 1);
  }, [connection]);

  const refresh = useCallback(() => {
    const q = JSON.parse(effectiveQueryJson) as Query;
    void loadTasks(q, true);
    void loadCatalog(true);
  }, [effectiveQueryJson, loadTasks, loadCatalog]);

  // ---- state helpers ----

  const patchFilters = useCallback((patch: Partial<Query>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setActiveViewId(null);
  }, []);

  const onSortClick = useCallback((key: string, shift: boolean) => {
    setSort((prev) => {
      setActiveViewId(null);
      if (shift) {
        const i = prev.findIndex((s) => s.key === key);
        if (i === -1) return [...prev, { key, dir: "asc" }];
        const next = [...prev];
        next[i] = { key, dir: prev[i].dir === "asc" ? "desc" : "asc" };
        return next;
      }
      const dir =
        prev.length === 1 && prev[0].key === key && prev[0].dir === "asc"
          ? "desc"
          : "asc";
      return [{ key, dir }];
    });
  }, []);

  const toggleGroup = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const applyView = useCallback(
    (view: SavedViewData) => {
      const { sort: vs, group: vg, search: vsrch, ...rest } = view.query;
      setFilters(rest);
      setSort(vs ?? []);
      setGroup(vg ?? "none");
      setSearchText(vsrch ?? "");
      setViewMode(view.view);
      setActiveViewId(view.id);
      setCollapsed(new Set());
    },
    [],
  );

  const saveCurrentView = useCallback(
    async (name: string) => {
      const q = JSON.parse(effectiveQueryJson) as Query;
      await rpc.call("saveView", {
        name,
        view: viewMode,
        query: q,
      });
      await loadViews();
    },
    [rpc, effectiveQueryJson, viewMode, loadViews],
  );

  const deleteView = useCallback(
    async (id: string) => {
      await rpc.call("deleteView", { id });
      if (activeViewId === id) setActiveViewId(null);
      await loadViews();
    },
    [rpc, activeViewId, loadViews],
  );

  // ---- filter option lists ----

  const projectOptions = useMemo(
    () =>
      (catalog?.projects ?? []).map((p) => ({
        value: p.id,
        label: p.name,
        hint: p.prefix,
      })),
    [catalog],
  );
  const folderOptions = useMemo(
    () =>
      (catalog?.folders ?? []).map((f) => ({ value: f.id, label: f.name })),
    [catalog],
  );
  const labelOptions = useMemo(() => {
    const projectName = new Map(
      (catalog?.projects ?? []).map((p) => [p.id, p.prefix]),
    );
    return Object.values(catalog?.labelsByProject ?? {})
      .flat()
      .map((l) => ({
        value: l.id,
        label: l.name,
        hint: projectName.get(l.projectId),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [catalog]);
  const statusOptions = STATUS_ORDER.map((s: TaskStatus) => ({
    value: s,
    label: STATUS_LABEL[s],
  }));
  const priorityOptions = PRIORITY_ORDER.map((p: TaskPriority) => ({
    value: p,
    label: PRIORITY_LABEL[p],
  }));

  // ---- render ----

  if (catalog !== null && !catalog.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-8 text-center">
        <div className="text-sm font-medium">Tasks plugin unavailable</div>
        <div className="max-w-md text-xs text-muted-foreground">
          Tasks Pro reads data from the builtin <code>tasks</code> plugin.
          Enable it in Plugins, then reopen this panel.
        </div>
        <button
          type="button"
          onClick={() => void loadCatalog(true)}
          className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-background text-foreground">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <input
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              setActiveViewId(null);
            }}
            placeholder="Search tasks…"
            className="h-8 w-52 rounded-md border border-border bg-card px-2.5 text-xs outline-none focus:border-primary"
          />
          <MultiSelect
            label="Projects"
            options={projectOptions}
            values={filters.projectIds}
            onChange={(v) => patchFilters({ projectIds: v })}
          />
          <MultiSelect
            label="Folders"
            options={folderOptions}
            values={filters.folderIds}
            onChange={(v) => patchFilters({ folderIds: v })}
          />
          <MultiSelect
            label="Status"
            options={statusOptions}
            values={filters.statuses}
            onChange={(v) =>
              patchFilters({ statuses: v as TaskStatus[] | undefined })
            }
          />
          <MultiSelect
            label="Priority"
            options={priorityOptions}
            values={filters.priorities}
            onChange={(v) =>
              patchFilters({ priorities: v as TaskPriority[] | undefined })
            }
          />
          <MultiSelect
            label="Labels"
            options={labelOptions}
            values={filters.labelIds}
            onChange={(v) => patchFilters({ labelIds: v })}
          />
          <DateRangeSelect
            label="Due"
            value={filters.due}
            onChange={(v) => patchFilters({ due: v })}
          />
          <Dropdown label="More" active={moreActive(filters)}>
            {() => (
              <div className="w-72 space-y-2 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Created</span>
                  <DateRangeSelect
                    label="Created"
                    allowOverdue={false}
                    value={filters.created}
                    onChange={(v) => patchFilters({ created: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Updated</span>
                  <DateRangeSelect
                    label="Updated"
                    allowOverdue={false}
                    value={filters.updated}
                    onChange={(v) => patchFilters({ updated: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Completed
                  </span>
                  <SimpleSelect
                    options={[
                      { value: "any", label: "Any" },
                      { value: "notCompleted", label: "Not completed" },
                      { value: "today", label: "Today" },
                      { value: "last7d", label: "Last 7 days" },
                      { value: "last30d", label: "Last 30 days" },
                      { value: "none", label: "No completion date" },
                    ]}
                    value={completedSelectValue(filters.completed)}
                    onChange={(v) =>
                      patchFilters({ completed: completedFromSelect(v) })
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Threads</span>
                  <SimpleSelect
                    options={[
                      { value: "", label: "Any" },
                      { value: "active", label: "Active" },
                      { value: "any", label: "Has threads" },
                      { value: "none", label: "No threads" },
                    ]}
                    value={filters.threads ?? ""}
                    onChange={(v) =>
                      patchFilters({
                        threads: (v || undefined) as Query["threads"],
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Depth</span>
                  <SimpleSelect
                    options={[
                      { value: "all", label: "All" },
                      { value: "top", label: "Top-level" },
                      { value: "subtasks", label: "Subtasks" },
                    ]}
                    value={filters.depth ?? "all"}
                    onChange={(v) =>
                      patchFilters({ depth: v as Query["depth"] })
                    }
                  />
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={filters.attachments === true}
                    onChange={(e) =>
                      patchFilters({
                        attachments: e.target.checked ? true : undefined,
                      })
                    }
                    className="size-3.5 accent-primary"
                  />
                  Has attachments
                </label>
              </div>
            )}
          </Dropdown>
          <button
            type="button"
            onClick={clearAll}
            className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Clear
          </button>
          <div className="mx-1 h-5 w-px bg-border" />
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            {(["table", "board"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`h-8 px-2.5 text-xs font-medium ${
                  viewMode === mode
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-foreground hover:bg-accent"
                }`}
              >
                {mode === "table" ? "Table" : "Kanban"}
              </button>
            ))}
          </div>
          {viewMode === "table" ? (
            <SimpleSelect
              options={GROUP_OPTIONS}
              value={group}
              onChange={(v) => {
                setGroup(v);
                setActiveViewId(null);
              }}
            />
          ) : null}
          <Dropdown
            label={
              activeViewId
                ? (views.find((v) => v.id === activeViewId)?.name ?? "Views")
                : "Views"
            }
            active={activeViewId !== null}
          >
            {(close) => (
              <div className="w-64 p-1">
                {views.map((v) => (
                  <div
                    key={v.id}
                    className="group flex items-center rounded px-1 hover:bg-accent"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        applyView(v);
                        close();
                      }}
                      className="min-w-0 flex-1 truncate px-1 py-1.5 text-left text-xs"
                    >
                      {v.name}
                      {v.builtin ? (
                        <span className="ml-1 text-[9px] text-muted-foreground">
                          preset
                        </span>
                      ) : null}
                    </button>
                    {!v.builtin ? (
                      <button
                        type="button"
                        aria-label={`Delete ${v.name}`}
                        onClick={() => void deleteView(v.id)}
                        className="hidden rounded px-1.5 py-0.5 text-muted-foreground hover:text-destructive group-hover:block"
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const name = window.prompt("View name");
                    if (name?.trim()) void saveCurrentView(name.trim());
                  }}
                  className="mt-1 w-full rounded border-t border-border px-2 py-1.5 text-left text-xs text-primary hover:bg-accent"
                >
                  Save current view…
                </button>
              </div>
            )}
          </Dropdown>
          <button
            type="button"
            onClick={refresh}
            title="Refresh"
            className="ml-auto inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent"
          >
            ⟳ Refresh
          </button>
          <span className="text-xs text-muted-foreground">
            {loading ? "…" : `${tasks.length} of ${total}`}
          </span>
        </div>

        {/* content */}
        {loadError ? (
          <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            {loadError}
          </div>
        ) : null}
        {loading && tasks.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            Loading tasks…
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-muted-foreground">
            <div className="text-sm">No tasks match</div>
            <div className="text-xs">
              Adjust filters or{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={clearAll}
              >
                clear them
              </button>
              .
            </div>
          </div>
        ) : viewMode === "table" ? (
          <TaskTable
            tasks={tasks}
            sort={sort}
            group={group}
            collapsed={collapsed}
            onSortClick={onSortClick}
            onToggleGroup={toggleGroup}
            onSelect={(t) => setSelectedTaskId(t.id)}
            now={new Date()}
          />
        ) : (
          <TaskBoard tasks={tasks} onSelect={(t) => setSelectedTaskId(t.id)} />
        )}
      </div>
      {selectedTaskId !== null ? (
        <TaskDrawer
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
          onOpenTask={(id) => setSelectedTaskId(id)}
        />
      ) : null}
    </div>
  );

  function clearAll() {
    setFilters({});
    setSort([]);
    setGroup("none");
    setSearchText("");
    setActiveViewId(null);
  }
}

function moreActive(q: Query): boolean {
  return (
    q.created !== undefined ||
    q.updated !== undefined ||
    q.completed !== undefined ||
    q.threads !== undefined ||
    q.attachments === true ||
    (q.depth !== undefined && q.depth !== "all")
  );
}

type CompletedSelectValue =
  | "any"
  | "notCompleted"
  | "today"
  | "last7d"
  | "last30d"
  | "none";

function completedSelectValue(
  v: Query["completed"],
): CompletedSelectValue {
  if (v === undefined) return "any";
  if (v === "notCompleted") return "notCompleted";
  switch (v.kind) {
    case "today":
    case "last7d":
    case "last30d":
    case "none":
      return v.kind;
    default:
      return "any";
  }
}

function completedFromSelect(
  v: CompletedSelectValue,
): Query["completed"] {
  if (v === "any") return undefined;
  if (v === "notCompleted") return "notCompleted";
  return { kind: v };
}
