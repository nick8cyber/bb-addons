/**
 * bb-plugin-tasks-pro — backend entry.
 *
 * Read-only advanced task browser. Reads come from the builtin `tasks`
 * plugin's RPC (`bb.sdk.plugins.callRpc`, batched + TTL-cached) plus a
 * read-only SQLite enrichment pass over `<dataDir>/plugins/tasks/data.db`
 * (completedAt / lastStatusChangeAt / commentCount / threadCount). No
 * mutations anywhere: no write RPC to tasks, no writes to its database.
 */
import { join } from "node:path";
import {
  defineRpcContract,
  type BbPluginApi,
  type JsonValue,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { readEnrichment } from "./src/enrich";
import {
  applyFilters,
  applySearch,
  applySort,
  buildEnriched,
  type EnrichedTask,
} from "./src/query";
import {
  commentSchema,
  folderSchema,
  getTaskOutput,
  labelSchema,
  labelsByProjectOutput,
  listAllTasksOutput,
  listCommentsOutput,
  listFoldersOutput,
  listProjectsOutput,
  listTaskCardMetaOutput,
  listTaskPullRequestsOutput,
  listTaskThreadsOutput,
  projectSchema,
  taskPrioritySchema,
  taskPullRequestSchema,
  taskSchema,
  taskStatusSchema,
  taskThreadSchema,
  type Folder,
  type Label,
  type Project,
  type Task,
  type TaskCardMeta,
} from "./src/tasks-contract";
import { DEFAULT_VIEWS } from "./src/views";

const TASKS_PLUGIN_ID = "tasks";
/** callRpc fails at ~75s; keep the expensive catalog between calls. */
const CATALOG_TTL_MS = 60_000;
const SNAPSHOT_TTL_MS = 15_000;
/** labelsByProject accepts at most 500 keys per call. */
const LABELS_CHUNK = 500;
const VIEWS_KV_KEY = "views";

// ---------------------------------------------------------------------------
// Own RPC contract

const dateRangeSchema = z.union([
  z.object({ kind: z.enum(["today", "last7d", "last30d"]) }).strict(),
  z.object({ kind: z.enum(["overdue", "none"]) }).strict(),
  z
    .object({ kind: z.literal("range"), from: z.string(), to: z.string() })
    .strict(),
]);

const sortKeySchema = z
  .object({ key: z.string(), dir: z.enum(["asc", "desc"]) })
  .strict();

const groupKeySchema = z.enum([
  "status",
  "priority",
  "project",
  "folder",
  "dueBucket",
  "label",
  "parent",
  "none",
]);

const queryInputSchema = z
  .object({
    projectIds: z.array(z.string()).optional(),
    folderIds: z.array(z.string()).optional(),
    statuses: z.array(taskStatusSchema).optional(),
    priorities: z.array(taskPrioritySchema).optional(),
    labelIds: z.array(z.string()).optional(),
    due: dateRangeSchema.optional(),
    created: dateRangeSchema.optional(),
    updated: dateRangeSchema.optional(),
    completed: z.union([dateRangeSchema, z.literal("notCompleted")]).optional(),
    threads: z.enum(["active", "any", "none"]).optional(),
    attachments: z.boolean().optional(),
    depth: z.enum(["top", "subtasks", "all"]).optional(),
    search: z.string().optional(),
    sort: z.array(sortKeySchema).optional(),
    group: groupKeySchema.optional(),
    /** Bypass the snapshot cache (manual refresh). */
    refresh: z.boolean().optional(),
  })
  .strict();

const enrichedTaskSchema = taskSchema.extend({
  project: projectSchema.nullable(),
  folder: folderSchema.nullable(),
  labels: z.array(labelSchema),
  parent: z
    .object({ id: z.string(), key: z.string(), title: z.string() })
    .strict()
    .nullable(),
  completedAt: z.string().nullable(),
  lastStatusChangeAt: z.string().nullable(),
  commentCount: z.number().nullable(),
  attachmentCount: z.number(),
  activeThreads: z.array(taskThreadSchema),
  threadCount: z.number().nullable(),
});

const listTaskSchema = enrichedTaskSchema.omit({ description: true });

const savedViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    builtin: z.boolean(),
    view: z.enum(["table", "board"]),
    query: queryInputSchema,
  })
  .strict();

const saveViewInputSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
    view: z.enum(["table", "board"]),
    query: queryInputSchema,
  })
  .strict();

export const rpcContract = defineRpcContract({
  getCatalog: {
    input: z.object({ refresh: z.boolean().optional() }).strict(),
    output: z
      .object({
        available: z.boolean(),
        projects: z.array(projectSchema),
        folders: z.array(folderSchema),
        labelsByProject: z.record(z.string(), z.array(labelSchema)),
      })
      .strict(),
  },
  queryTasks: {
    input: queryInputSchema,
    output: z
      .object({
        available: z.boolean(),
        tasks: z.array(listTaskSchema),
        total: z.number(),
      })
      .strict(),
  },
  getTaskDetail: {
    input: z.object({ taskId: z.string() }).strict(),
    output: z
      .object({
        available: z.boolean(),
        task: enrichedTaskSchema.nullable(),
        subtasks: z.array(enrichedTaskSchema),
        comments: z.array(commentSchema),
        threads: z.array(taskThreadSchema),
        pullRequests: z.array(taskPullRequestSchema),
        unavailableThreadIds: z.array(z.string()),
      })
      .strict(),
  },
  listViews: {
    input: z.null(),
    output: z.object({ views: z.array(savedViewSchema) }).strict(),
  },
  saveView: {
    input: saveViewInputSchema,
    output: z.object({ view: savedViewSchema }).strict(),
  },
  deleteView: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
});

// ---------------------------------------------------------------------------
// Caches

interface Catalog {
  projects: Project[];
  folders: Folder[];
  labelsByProject: Record<string, Label[]>;
}

interface Snapshot {
  tasks: Task[];
  cards: Map<string, TaskCardMeta>;
}

export default async function plugin(bb: BbPluginApi) {
  let catalogCache: { at: number; value: Catalog } | null = null;
  let snapshotCache: { at: number; value: Snapshot } | null = null;

  async function callTasks<T>(
    method: string,
    input: JsonValue | undefined,
    outputSchema: z.ZodType<T>,
  ): Promise<T> {
    // bb.sdk is bind-gated; reading it inside handlers keeps the factory safe
    // in isolated harnesses.
    return bb.sdk.plugins.callRpc<T>({
      pluginId: TASKS_PLUGIN_ID,
      method,
      input,
      outputSchema,
    });
  }

  async function loadCatalog(refresh: boolean): Promise<Catalog> {
    if (
      !refresh &&
      catalogCache !== null &&
      Date.now() - catalogCache.at < CATALOG_TTL_MS
    ) {
      return catalogCache.value;
    }
    const [{ projects }, { folders }] = await Promise.all([
      callTasks("listProjects", {}, listProjectsOutput),
      callTasks("listFolders", null, listFoldersOutput),
    ]);
    const labelsByProject: Record<string, Label[]> = {};
    for (let i = 0; i < projects.length; i += LABELS_CHUNK) {
      const keys = projects.slice(i, i + LABELS_CHUNK).map((p) => p.id);
      if (keys.length === 0) continue;
      const labels = await callTasks(
        "labelsByProject",
        { keys },
        labelsByProjectOutput,
      );
      Object.assign(labelsByProject, labels);
    }
    const value: Catalog = { projects, folders, labelsByProject };
    catalogCache = { at: Date.now(), value };
    return value;
  }

  async function loadSnapshot(refresh: boolean): Promise<Snapshot> {
    if (
      !refresh &&
      snapshotCache !== null &&
      Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS
    ) {
      return snapshotCache.value;
    }
    const [{ tasks }, { cards }] = await Promise.all([
      callTasks("listAllTasks", {}, listAllTasksOutput),
      callTasks("listTaskCardMeta", {}, listTaskCardMetaOutput),
    ]);
    const value: Snapshot = {
      tasks,
      cards: new Map(cards.map((c) => [c.taskId, c])),
    };
    snapshotCache = { at: Date.now(), value };
    return value;
  }

  function enrichTasks(
    tasks: readonly Task[],
    catalog: Catalog,
    snapshot: Snapshot,
  ): EnrichedTask[] {
    const sqlite = readEnrichment(
      join(bb.server.experimental_dataDir, "plugins", "tasks", "data.db"),
    );
    return buildEnriched(tasks, {
      projectById: new Map(catalog.projects.map((p) => [p.id, p])),
      folderById: new Map(catalog.folders.map((f) => [f.id, f])),
      labelById: new Map(
        Object.values(catalog.labelsByProject)
          .flat()
          .map((l) => [l.id, l]),
      ),
      taskById: new Map(snapshot.tasks.map((t) => [t.id, t])),
      cardByTaskId: snapshot.cards,
      sqliteByTaskId: sqlite ?? new Map(),
      sqliteAvailable: sqlite !== null,
    });
  }

  async function loadEnriched(refresh: boolean): Promise<EnrichedTask[]> {
    const [catalog, snapshot] = await Promise.all([
      loadCatalog(refresh),
      loadSnapshot(refresh),
    ]);
    return enrichTasks(snapshot.tasks, catalog, snapshot);
  }

  bb.rpc.register(rpcContract, {
    async getCatalog(input) {
      try {
        const catalog = await loadCatalog(input.refresh === true);
        return { available: true, ...catalog };
      } catch (error) {
        bb.log.warn(`tasks plugin unreachable: ${String(error)}`);
        return {
          available: false,
          projects: [],
          folders: [],
          labelsByProject: {},
        };
      }
    },

    async queryTasks(q) {
      try {
        const enriched = await loadEnriched(q.refresh === true);
        const filtered = applySearch(
          applyFilters(enriched, q, new Date()),
          q,
        );
        const sorted = applySort(filtered, q.sort);
        return {
          available: true,
          tasks: sorted.map(({ description: _description, ...task }) => task),
          total: enriched.length,
        };
      } catch (error) {
        bb.log.warn(`tasks query failed: ${String(error)}`);
        return { available: false, tasks: [], total: 0 };
      }
    },

    async getTaskDetail({ taskId }) {
      try {
        const [catalog, snapshot, detail, comments, threads, pullRequests] =
          await Promise.all([
            loadCatalog(false),
            loadSnapshot(false),
            callTasks("getTask", { taskId }, getTaskOutput),
            callTasks("listComments", { taskId }, listCommentsOutput),
            callTasks("listTaskThreads", { taskId }, listTaskThreadsOutput),
            callTasks(
              "listTaskPullRequests",
              { taskId },
              listTaskPullRequestsOutput,
            ),
          ]);
        const { tasks: subtasks } = await callTasks(
          "listAllTasks",
          { parentTaskId: taskId },
          listAllTasksOutput,
        );
        const task = detail.task
          ? enrichTasks([detail.task], catalog, snapshot)[0]
          : null;
        return {
          available: true,
          task: task ?? null,
          subtasks: enrichTasks(subtasks, catalog, snapshot),
          comments: comments.comments,
          threads: threads.taskThreads,
          pullRequests: pullRequests.pullRequests,
          unavailableThreadIds: pullRequests.unavailableThreadIds,
        };
      } catch (error) {
        bb.log.warn(`task detail failed: ${String(error)}`);
        return {
          available: false,
          task: null,
          subtasks: [],
          comments: [],
          threads: [],
          pullRequests: [],
          unavailableThreadIds: [],
        };
      }
    },

    async listViews() {
      const stored =
        (await bb.storage.kv.get<unknown[]>(VIEWS_KV_KEY)) ?? [];
      const custom = stored
        .map((v) => savedViewSchema.safeParse(v))
        .filter((r) => r.success)
        .map((r) => r.data);
      return { views: [...DEFAULT_VIEWS, ...custom] };
    },

    async saveView(input) {
      const id = input.id ?? `view_${crypto.randomUUID()}`;
      if (id.startsWith("builtin:")) {
        throw new Error("builtin views cannot be overwritten");
      }
      const view = {
        id,
        name: input.name,
        builtin: false,
        view: input.view,
        query: input.query,
      };
      const stored =
        (await bb.storage.kv.get<unknown[]>(VIEWS_KV_KEY)) ?? [];
      const rest = stored.filter(
        (v): v is { id: string } =>
          typeof v === "object" && v !== null && "id" in v && v.id !== id,
      );
      await bb.storage.kv.set(VIEWS_KV_KEY, [...rest, view]);
      return { view };
    },

    async deleteView({ id }) {
      if (id.startsWith("builtin:")) {
        throw new Error("builtin views cannot be deleted");
      }
      const stored =
        (await bb.storage.kv.get<unknown[]>(VIEWS_KV_KEY)) ?? [];
      await bb.storage.kv.set(
        VIEWS_KV_KEY,
        stored.filter(
          (v) =>
            !(typeof v === "object" && v !== null && "id" in v && v.id === id),
        ),
      );
      return { deleted: true };
    },
  });

  bb.log.info("bb-plugin-tasks-pro loaded");
}
