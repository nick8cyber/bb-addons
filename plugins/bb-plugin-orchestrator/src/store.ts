/**
 * SQLite storage (spec §7): `delegations` and `route_holds`, additive-only
 * migrations applied through `bb.storage.migrate`. `pending_roles` and
 * `thread_roles` are added by the roles task (PLUG-141), after these.
 */
import type { Database } from "better-sqlite3";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS delegations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key TEXT NOT NULL,
    task_id TEXT,
    coordinator_thread_id TEXT NOT NULL,
    thread_id TEXT,
    level TEXT NOT NULL,
    route TEXT NOT NULL,
    preset TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'dispatching','running','done','failed','stalled','quota','reissued','cancelled'
    )),
    reissue_of INTEGER,
    turn_started_at INTEGER,
    first_response_at INTEGER,
    last_seq INTEGER,
    setup_errors TEXT NOT NULL DEFAULT '[]',
    last_approval_notified_at INTEGER,
    timeout_notified_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // One active delegation per task: the DB-level guard against double dispatch.
  `CREATE UNIQUE INDEX IF NOT EXISTS delegations_active_task_idx
    ON delegations(task_key) WHERE status IN ('dispatching','running')`,
  `CREATE INDEX IF NOT EXISTS delegations_thread_idx ON delegations(thread_id)`,
  `CREATE INDEX IF NOT EXISTS delegations_coordinator_idx
    ON delegations(coordinator_thread_id, status)`,
  `CREATE TABLE IF NOT EXISTS route_holds (
    quota_group TEXT PRIMARY KEY,
    until INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT ''
  )`,
  // §3: the fresh-dispatching executor marker is scoped to the thread's
  // bb project, so delegations record the coordinator's project.
  `ALTER TABLE delegations ADD COLUMN project_id TEXT`,
];

export const ACTIVE_STATUSES = ["dispatching", "running"] as const;

export type DelegationStatus =
  | "dispatching"
  | "running"
  | "done"
  | "failed"
  | "stalled"
  | "quota"
  | "reissued"
  | "cancelled";

export interface DelegationRow {
  id: number;
  task_key: string;
  task_id: string | null;
  project_id: string | null;
  coordinator_thread_id: string;
  thread_id: string | null;
  level: string;
  route: string;
  preset: string;
  provider: string;
  status: DelegationStatus;
  reissue_of: number | null;
  turn_started_at: number | null;
  first_response_at: number | null;
  last_seq: number | null;
  setup_errors: string;
  last_approval_notified_at: number | null;
  timeout_notified_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface RouteHoldRow {
  quota_group: string;
  until: number;
  reason: string;
}

interface SetupError {
  step: string;
  message: string;
}

/** Task keys are case-insensitive in bb; store them uppercased so the
 * partial unique index actually sees "plug-1" and "PLUG-1" as one task. */
export const normalizeTaskKey = (key: string) => key.trim().toUpperCase();

export class DelegationStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  insert(input: {
    taskKey: string;
    taskId?: string;
    projectId?: string;
    coordinatorThreadId: string;
    level: string;
    route: string;
    preset: string;
    provider: string;
  }): DelegationRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO delegations (
          task_key, task_id, project_id, coordinator_thread_id, level, route,
          preset, provider, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)`,
      )
      .run(
        normalizeTaskKey(input.taskKey),
        input.taskId ?? null,
        input.projectId ?? null,
        input.coordinatorThreadId,
        input.level,
        input.route,
        input.preset,
        input.provider,
        now,
        now,
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): DelegationRow | undefined {
    return this.db.prepare(`SELECT * FROM delegations WHERE id = ?`).get(id) as
      | DelegationRow
      | undefined;
  }

  byThreadId(threadId: string): DelegationRow | undefined {
    return this.db
      .prepare(`SELECT * FROM delegations WHERE thread_id = ? ORDER BY id DESC LIMIT 1`)
      .get(threadId) as DelegationRow | undefined;
  }

  activeByTaskKey(taskKey: string): DelegationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE task_key = ? AND status IN ('dispatching','running')`,
      )
      .get(normalizeTaskKey(taskKey)) as DelegationRow | undefined;
  }

  list(filter: { coordinatorThreadId?: string; status?: string } = {}): DelegationRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.coordinatorThreadId) {
      where.push(`coordinator_thread_id = ?`);
      args.push(filter.coordinatorThreadId);
    }
    if (filter.status) {
      where.push(`status = ?`);
      args.push(filter.status);
    }
    const sql =
      `SELECT * FROM delegations` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY id DESC`;
    return this.db.prepare(sql).all(...args) as DelegationRow[];
  }

  /** Counts per status, e.g. `{ running: 2, done: 4 }`. */
  countsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM delegations GROUP BY status`)
      .all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  activeCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM delegations WHERE status IN ('dispatching','running')`,
      )
      .get() as { n: number };
    return row.n;
  }

  activeCountByLevel(level: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM delegations
         WHERE level = ? AND status IN ('dispatching','running')`,
      )
      .get(level) as { n: number };
    return row.n;
  }

  /**
   * Executor heuristic (§3): a `dispatching` row with no `thread_id` younger
   * than `freshSince` in the same bb project means a dispatch is in flight
   * whose executor thread is not linked yet — a root thread in that window
   * may be that executor. A row the thread itself created does not count:
   * the dispatcher is the coordinator, not the executor.
   */
  hasFreshDispatching(
    freshSince: number,
    scope: { projectId: string; excludingThreadId: string },
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM delegations
         WHERE status = 'dispatching' AND thread_id IS NULL AND created_at > ?
           AND project_id IS ? AND coordinator_thread_id IS NOT ?
         LIMIT 1`,
      )
      .get(freshSince, scope.projectId, scope.excludingThreadId) as
      | { x: number }
      | undefined;
    return row !== undefined;
  }

  setThreadInfo(id: number, threadId: string, taskId?: string): void {
    this.db
      .prepare(
        `UPDATE delegations SET thread_id = ?, task_id = COALESCE(?, task_id), updated_at = ?
         WHERE id = ?`,
      )
      .run(threadId, taskId ?? null, Date.now(), id);
  }

  setStatus(id: number, status: DelegationStatus): void {
    this.db
      .prepare(`UPDATE delegations SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  /**
   * `UPDATE … SET status = to WHERE id = ? AND status = from` — the §4 step 6
   * guard: a delegation cancelled mid-dispatch is never flipped back to
   * `running`. Returns true when the row moved.
   */
  setStatusIf(
    id: number,
    from: DelegationStatus,
    to: DelegationStatus,
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE delegations SET status = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(to, Date.now(), id, from);
    return info.changes > 0;
  }

  addSetupError(id: number, step: string, message: string): void {
    const row = this.get(id);
    if (!row) return;
    let errors: SetupError[] = [];
    try {
      const parsed = JSON.parse(row.setup_errors) as unknown;
      if (Array.isArray(parsed)) errors = parsed as SetupError[];
    } catch {
      // A corrupt value is overwritten rather than grown.
    }
    errors.push({ step, message });
    this.db
      .prepare(`UPDATE delegations SET setup_errors = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(errors), Date.now(), id);
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM delegations WHERE id = ?`).run(id);
  }

  /** All active (`dispatching`/`running`) rows, oldest first. */
  listActive(): DelegationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE status IN ('dispatching','running') ORDER BY id`,
      )
      .all() as DelegationRow[];
  }

  /**
   * §5.1: a new executor turn opened the first-response window — record its
   * start and clear the per-turn response marker.
   */
  setTurnStarted(id: number, at: number): void {
    this.db
      .prepare(
        `UPDATE delegations SET turn_started_at = ?, first_response_at = NULL,
         updated_at = ? WHERE id = ?`,
      )
      .run(at, Date.now(), id);
  }

  /** First response event of the current turn; keeps the earliest value. */
  setFirstResponse(id: number, at: number): void {
    this.db
      .prepare(
        `UPDATE delegations
         SET first_response_at = COALESCE(first_response_at, ?), updated_at = ?
         WHERE id = ?`,
      )
      .run(at, Date.now(), id);
  }

  /** Event-stream cursor (§5.1): only ever moves forward. */
  advanceLastSeq(id: number, seq: number): void {
    this.db
      .prepare(
        `UPDATE delegations SET last_seq = MAX(COALESCE(last_seq, -1), ?),
         updated_at = ? WHERE id = ?`,
      )
      .run(seq, Date.now(), id);
  }

  setApprovalNotified(id: number, at: number): void {
    this.db
      .prepare(
        `UPDATE delegations SET last_approval_notified_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(at, Date.now(), id);
  }

  setTimeoutNotified(id: number, at: number): void {
    this.db
      .prepare(
        `UPDATE delegations SET timeout_notified_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(at, Date.now(), id);
  }

  /**
   * Routes this task has already run on (§5.4): a route may be picked by an
   * automatic reissue at most once per task, so every recorded row counts,
   * whatever its status.
   */
  routesUsedByTask(taskKey: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT DISTINCT route FROM delegations WHERE task_key = ?`)
      .all(normalizeTaskKey(taskKey)) as { route: string }[];
    return new Set(rows.map((r) => r.route));
  }

  /**
   * §5.4 reissue in one transaction: the old row moves to `reissued` and a
   * new `dispatching` row with `reissue_of` is inserted atomically, so a
   * service restart mid-reissue cannot leave a duplicate. Returns the new
   * row, or undefined when the old row already left `stalled`/`quota`.
   */
  reissue(
    id: number,
    next: { route: string; preset: string; provider: string },
  ): DelegationRow | undefined {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (!row || (row.status !== "stalled" && row.status !== "quota")) {
        return undefined;
      }
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE delegations SET status = 'reissued', updated_at = ? WHERE id = ?`,
        )
        .run(now, id);
      const info = this.db
        .prepare(
          `INSERT INTO delegations (
            task_key, task_id, project_id, coordinator_thread_id, level,
            route, preset, provider, status, reissue_of, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?)`,
        )
        .run(
          row.task_key,
          row.task_id,
          row.project_id,
          row.coordinator_thread_id,
          row.level,
          next.route,
          next.preset,
          next.provider,
          id,
          now,
          now,
        );
      return this.get(Number(info.lastInsertRowid));
    })();
  }

  /** Drop every `setup_errors` entry of one step — after a successful retry. */
  clearSetupError(id: number, step: string): void {
    const row = this.get(id);
    if (!row) return;
    let errors: SetupError[] = [];
    try {
      const parsed = JSON.parse(row.setup_errors) as unknown;
      if (Array.isArray(parsed)) errors = parsed as SetupError[];
    } catch {
      return;
    }
    const kept = errors.filter((e) => e?.step !== step);
    if (kept.length === errors.length) return;
    this.db
      .prepare(`UPDATE delegations SET setup_errors = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(kept), Date.now(), id);
  }

  /** Quota groups currently on hold (`route_holds.until` in the future). */
  heldGroups(now: number): Set<string> {
    const rows = this.db
      .prepare(`SELECT quota_group FROM route_holds WHERE until > ?`)
      .all(now) as { quota_group: string }[];
    return new Set(rows.map((r) => r.quota_group));
  }

  hold(group: string, until: number, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO route_holds (quota_group, until, reason) VALUES (?, ?, ?)
         ON CONFLICT(quota_group) DO UPDATE SET until = excluded.until, reason = excluded.reason`,
      )
      .run(group, until, reason);
  }

  holds(): RouteHoldRow[] {
    return this.db
      .prepare(`SELECT * FROM route_holds ORDER BY until DESC`)
      .all() as RouteHoldRow[];
  }
}
