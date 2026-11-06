/**
 * Zod schemas mirroring the builtin `tasks` plugin RPC outputs (bb-app 0.48.1,
 * server/dist/builtin-plugins/tasks/dist/server.js). Passed to
 * `bb.sdk.plugins.callRpc` as `outputSchema`.
 *
 * Objects are intentionally non-strict: unknown keys are stripped, so additive
 * changes upstream keep working; a renamed or removed field we read fails
 * validation loudly — fix the schema, not the logic.
 */
import { z } from "zod";

export const taskStatusSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
]);
export const taskPrioritySchema = z.enum([
  "urgent",
  "high",
  "medium",
  "low",
  "none",
]);
export const threadLiveStatusSchema = z.enum([
  "starting",
  "working",
  "idle",
  "completed",
  "failed",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type ThreadLiveStatus = z.infer<typeof threadLiveStatusSchema>;

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  number: z.number().int().positive(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  dueDate: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labelIds: z.array(z.string()),
});

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  nextTaskNumber: z.number().int(),
  color: z.string(),
  folderId: z.string().nullable(),
  linkedBbProjectId: z.string().nullable(),
  createdAt: z.string(),
});

export const folderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentFolderId: z.string().nullable(),
  createdAt: z.string(),
});

export const labelSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string(),
});

export const commentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(["user", "agent", "system"]),
  authorName: z.string(),
  presetName: z.string().nullable(),
  threadId: z.string().nullable(),
  body: z.string(),
  notifiedCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  threadTitle: z.string().nullable().optional(),
});

export const taskThreadSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  threadId: z.string(),
  presetName: z.string(),
  title: z.string(),
  liveStatus: threadLiveStatusSchema,
  attachedAt: z.string(),
  updatedAt: z.string(),
});

export const taskPullRequestSchema = z.object({
  url: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  updatedAt: z.string(),
  threadIds: z.array(z.string()),
});

export const taskCardMetaSchema = z.object({
  taskId: z.string(),
  attachmentCount: z.number().int().nonnegative(),
  activeThreads: z.array(taskThreadSchema),
});

// ---- method outputs ----

export const listAllTasksOutput = z.object({ tasks: z.array(taskSchema) });
export const listProjectsOutput = z.object({
  projects: z.array(projectSchema),
});
export const listFoldersOutput = z.object({ folders: z.array(folderSchema) });
export const labelsByProjectOutput = z.record(
  z.string(),
  z.array(labelSchema),
);
export const getTaskOutput = z.object({ task: taskSchema.nullable() });
export const listCommentsOutput = z.object({
  comments: z.array(commentSchema),
});
export const listTaskThreadsOutput = z.object({
  taskThreads: z.array(taskThreadSchema),
});
export const listTaskCardMetaOutput = z.object({
  cards: z.array(taskCardMetaSchema),
});
export const listTaskPullRequestsOutput = z.object({
  pullRequests: z.array(taskPullRequestSchema),
  unavailableThreadIds: z.array(z.string()),
});

export type Task = z.infer<typeof taskSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Folder = z.infer<typeof folderSchema>;
export type Label = z.infer<typeof labelSchema>;
export type TaskComment = z.infer<typeof commentSchema>;
export type TaskThread = z.infer<typeof taskThreadSchema>;
export type TaskPullRequest = z.infer<typeof taskPullRequestSchema>;
export type TaskCardMeta = z.infer<typeof taskCardMetaSchema>;
