/**
 * Read-only SQLite enrichment for Tasks Pro.
 *
 * The builtin tasks plugin keeps its data in `<dataDir>/plugins/tasks/data.db`
 * (WAL mode, so parallel readers are safe). Its own `listTaskCardMeta` RPC
 * covers only top-level tasks, so threads/attachments for subtasks come from
 * here too — one pass over `comments` for status/comment counts, one over
 * `task_threads` for thread counts and active-thread rows, one over
 * `attachments` for counts (mirroring the builtin: task-level attachments
 * only, comment attachments excluded).
 *
 * Degrades silently: a missing DB or a drifted schema returns `null`, and the
 * UI falls back to the cardMeta fields it has.
 */
import Database from "better-sqlite3";
import type { TaskThread, ThreadLiveStatus } from "./tasks-contract";

export interface TaskEnrichment {
  completedAt: string | null;
  lastStatusChangeAt: string | null;
  commentCount: number;
  /** Every attached thread (any liveStatus). */
  threadCount: number;
  /** Attached threads whose liveStatus is starting|working, newest first. */
  activeThreads: TaskThread[];
  /** Task-level attachments (comment attachments excluded, like cardMeta). */
  attachmentCount: number;
}

/** Comment bodies end the status transition, e.g. "by agent (thr_…)" or "· dispatched to swe2". */
const STATUS_CHANGE_RE = /^Status changed to (.+?)(?:\s(?:by|·)\s|$)/;
const COMPLETED_TARGETS = new Set(["Done", "Canceled"]);
const ACTIVE_LIVE_STATUSES = new Set<ThreadLiveStatus>([
  "starting",
  "working",
]);

/**
 * The target status of a system "Status changed to X" comment, or null when
 * the body is not a status change.
 */
export function parseStatusTarget(body: string): string | null {
  const match = STATUS_CHANGE_RE.exec(body);
  return match ? match[1] : null;
}

/** True for system comments that moved the task to Done or Canceled. */
export function isCompletionBody(body: string): boolean {
  const target = parseStatusTarget(body);
  return target !== null && COMPLETED_TARGETS.has(target);
}

interface EnrichmentRow {
  task_id: string;
  completed_at: string | null;
  last_status_change_at: string | null;
  comment_count: number;
}

interface TaskThreadRow {
  id: string;
  task_id: string;
  thread_id: string;
  preset_name: string;
  title: string;
  live_status: string;
  attached_at: string;
  updated_at: string;
}

interface AttachmentCountRow {
  task_id: string;
  attachment_count: number;
}

const ENRICH_SQL = `
  SELECT
    task_id,
    MAX(CASE WHEN body LIKE 'Status changed to Done%' OR body LIKE 'Status changed to Canceled%' THEN created_at END) AS completed_at,
    MAX(CASE WHEN body LIKE 'Status changed to %' THEN created_at END) AS last_status_change_at,
    COUNT(*) AS comment_count
  FROM comments
  GROUP BY task_id
`;

const THREADS_SQL = `
  SELECT id, task_id, thread_id, preset_name, title, live_status, attached_at, updated_at
  FROM task_threads
  ORDER BY task_id, attached_at DESC, id DESC
`;

const ATTACHMENTS_SQL = `
  SELECT task_id, COUNT(*) AS attachment_count
  FROM attachments
  WHERE task_id IS NOT NULL
  GROUP BY task_id
`;

const LIVE_STATUS: ReadonlySet<string> = new Set([
  "starting",
  "working",
  "idle",
  "completed",
  "failed",
]);

function toTaskThread(row: TaskThreadRow): TaskThread | null {
  if (!LIVE_STATUS.has(row.live_status)) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    threadId: row.thread_id,
    presetName: row.preset_name,
    title: row.title,
    liveStatus: row.live_status as ThreadLiveStatus,
    attachedAt: row.attached_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Open the tasks database read-only and extract per-task enrichment rows.
 * Returns `null` on any failure (missing file, schema drift, locked handle);
 * callers treat `null` as "enrichment unavailable".
 */
export function readEnrichment(
  dbPath: string,
): Map<string, TaskEnrichment> | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: 2000,
    });
    const rows = db.prepare(ENRICH_SQL).all() as EnrichmentRow[];
    const threads = db.prepare(THREADS_SQL).all() as TaskThreadRow[];
    const attachments = db
      .prepare(ATTACHMENTS_SQL)
      .all() as AttachmentCountRow[];
    const result = new Map<string, TaskEnrichment>();
    const entry = (taskId: string) => {
      let e = result.get(taskId);
      if (e === undefined) {
        e = {
          completedAt: null,
          lastStatusChangeAt: null,
          commentCount: 0,
          threadCount: 0,
          activeThreads: [],
          attachmentCount: 0,
        };
        result.set(taskId, e);
      }
      return e;
    };
    for (const row of rows) {
      const e = entry(row.task_id);
      e.completedAt = row.completed_at;
      e.lastStatusChangeAt = row.last_status_change_at;
      e.commentCount = row.comment_count;
    }
    for (const row of threads) {
      const thread = toTaskThread(row);
      if (thread === null) continue;
      const e = entry(row.task_id);
      e.threadCount += 1;
      if (ACTIVE_LIVE_STATUSES.has(thread.liveStatus)) {
        e.activeThreads.push(thread);
      }
    }
    for (const row of attachments) {
      entry(row.task_id).attachmentCount = row.attachment_count;
    }
    return result;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // best effort only
    }
  }
}
