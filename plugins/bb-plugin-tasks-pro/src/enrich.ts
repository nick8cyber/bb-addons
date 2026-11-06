/**
 * Read-only SQLite enrichment for Tasks Pro.
 *
 * The builtin tasks plugin keeps its data in `<dataDir>/plugins/tasks/data.db`
 * (WAL mode, so parallel readers are safe). A single GROUP BY pass over
 * `comments` yields per-task `completedAt` / `lastStatusChangeAt` /
 * `commentCount`; a second GROUP BY over `task_threads` yields `threadCount`.
 *
 * Degrades silently: a missing DB or a drifted schema returns `null`, and the
 * UI simply drops the completed/last-status/comment/thread columns.
 */
import Database from "better-sqlite3";

export interface TaskEnrichment {
  completedAt: string | null;
  lastStatusChangeAt: string | null;
  commentCount: number;
  threadCount: number;
}

/** Comment bodies end the status transition, e.g. "by agent (thr_…)" or "· dispatched to swe2". */
const STATUS_CHANGE_RE = /^Status changed to (.+?)(?:\s(?:by|·)\s|$)/;
const COMPLETED_TARGETS = new Set(["Done", "Canceled"]);

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

interface ThreadCountRow {
  task_id: string;
  thread_count: number;
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

const THREAD_COUNT_SQL = `
  SELECT task_id, COUNT(*) AS thread_count
  FROM task_threads
  GROUP BY task_id
`;

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
    const threads = db.prepare(THREAD_COUNT_SQL).all() as ThreadCountRow[];
    const result = new Map<string, TaskEnrichment>();
    for (const row of rows) {
      result.set(row.task_id, {
        completedAt: row.completed_at,
        lastStatusChangeAt: row.last_status_change_at,
        commentCount: row.comment_count,
        threadCount: 0,
      });
    }
    for (const row of threads) {
      const entry = result.get(row.task_id);
      if (entry) entry.threadCount = row.thread_count;
      else {
        result.set(row.task_id, {
          completedAt: null,
          lastStatusChangeAt: null,
          commentCount: 0,
          threadCount: row.thread_count,
        });
      }
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
