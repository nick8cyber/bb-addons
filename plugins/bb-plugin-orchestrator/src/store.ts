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
  // §5.3 `interrupted` outcome: how many times the watchdog already asked
  // the executor to resume after a non-manual interruption.
  `ALTER TABLE delegations ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0`,
  // §7 retry limit: consecutive failed retries of one reconcile action
  // (unconfirmed stop, reissue dispatch with an unknown outcome).
  `ALTER TABLE delegations ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`,
  // §7/§13.2: the new-chat window's current role pick per project, and the
  // decided role per thread (source of truth for §3 and §13).
  `CREATE TABLE IF NOT EXISTS pending_roles (
    project_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS thread_roles (
    thread_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('hook','delegate'))
  )`,
  // orchestrator-release §2: one release pipeline run per task at a time;
  // published rows double as the step-7 «выложено в обход» reference.
  `CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key TEXT NOT NULL,
    project_id TEXT NOT NULL,
    coordinator_thread_id TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    target_action TEXT NOT NULL CHECK (target_action IN ('push','pr')),
    target_branch TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'auditing','rejected','publishing','published','failed'
    )),
    head_sha TEXT,
    published_sha TEXT,
    remote_base_sha TEXT,
    audit_delegation_id INTEGER,
    no_docs_reason TEXT,
    kb_note TEXT,
    no_kb_reason TEXT,
    pr_url TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS releases_active_task_idx
    ON releases(task_key) WHERE status IN ('auditing','publishing')`,
  `CREATE INDEX IF NOT EXISTS releases_task_idx ON releases(task_key)`,
  // §7 rev 23 (ADR-0024): rounds — every dispatch gets `round` and an
  // optional `continue_from`; `result_*` — the round's outcome read from
  // the executor's worktree at `done` (§4.1); `merge_*` — the §14 merge
  // step's record, filled by the merge task. One migration statement per
  // column (SQLite has no multi-column ALTER); exec'd as one migration.
  `ALTER TABLE delegations ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE delegations ADD COLUMN continue_from TEXT;
   ALTER TABLE delegations ADD COLUMN result_branch TEXT;
   ALTER TABLE delegations ADD COLUMN result_sha TEXT;
   ALTER TABLE delegations ADD COLUMN result_commits INTEGER;
   ALTER TABLE delegations ADD COLUMN result_dirty INTEGER;
   ALTER TABLE delegations ADD COLUMN result_env_id TEXT;
   ALTER TABLE delegations ADD COLUMN merge_status TEXT;
   ALTER TABLE delegations ADD COLUMN merged_into TEXT;
   ALTER TABLE delegations ADD COLUMN merged_sha TEXT;
   ALTER TABLE delegations ADD COLUMN merged_at INTEGER`,
  // §2.3 r24 (PLUG-182): the dispatch used an explicit `--route`/`--preset`
  // — its §5.4 reissue restarts the level chain from the beginning.
  `ALTER TABLE delegations ADD COLUMN explicit_route INTEGER NOT NULL DEFAULT 0`,
  // §16.6 (PLUG-191): with `threadIds` off the remote branch is a neutral
  // `release/<sha7>` recorded at the first release and reused by repeats
  // — one branch and one PR per task.
  `ALTER TABLE releases ADD COLUMN publish_branch TEXT`,
  // §7 rev 24/25: `result_notified_at`/`result_notice` — the §16.5 result
  // delivery's record (`plugin` when the plugin message went out, NULL
  // notice when the coordinator was already gone); `revived_count` —
  // §16.2, how often a finished delegation came back to `running`;
  // `last_response_at` — §16.5 `idleSeconds`, the newest response-event
  // time of the current turn. `plugin_meta` — key/value service state
  // (the post-compaction reminder's per-coordinator cursor).
  `ALTER TABLE delegations ADD COLUMN result_notified_at INTEGER;
   ALTER TABLE delegations ADD COLUMN result_notice TEXT;
   ALTER TABLE delegations ADD COLUMN revived_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE delegations ADD COLUMN last_response_at INTEGER;
   CREATE TABLE IF NOT EXISTS plugin_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // §7 rev 25 rollout: delegations finished BEFORE the §16.5 delivery
  // columns existed already reached the coordinator through BB's own
  // parent notifications — they are marked `legacy` so the first
  // reconcile does not re-send every stale result (PLUG-184 B1). The
  // marker covers EVERY terminal status: it doubles as the rollout
  // last_seq-sync scope — only rows already terminal at the migration
  // may be force-advanced (PLUG-193 #4; a row closed after the rollout
  // keeps its live cursor for the §16.2 wake rule).
  `UPDATE delegations SET result_notified_at = CAST(strftime('%s','now') AS INTEGER) * 1000,
     result_notice = 'legacy'
   WHERE status IN ('done','cancelled','failed','stalled','quota','reissued')
     AND result_notified_at IS NULL`,
  // §15 janitor, one migration: the per-env ledger (`first_seen_at` is the
  // first run the copy was seen merged — «влита» state), the run log, and
  // a small key-value table (daily coordinator-notify watermark).
  `CREATE TABLE IF NOT EXISTS janitor_items (
    env_id TEXT PRIMARY KEY,
    project_id TEXT,
    thread_id TEXT,
    path TEXT,
    branch TEXT,
    state TEXT NOT NULL CHECK (state IN ('removed','kept','reported')),
    reason TEXT,
    size_kb INTEGER,
    first_seen_at INTEGER,
    last_checked_at INTEGER,
    removed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS janitor_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    removed INTEGER NOT NULL DEFAULT 0,
    kept INTEGER NOT NULL DEFAULT 0,
    freed_kb INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS janitor_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
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
  resume_count: number;
  retry_count: number;
  round: number;
  continue_from: string | null;
  result_branch: string | null;
  result_sha: string | null;
  result_commits: number | null;
  result_dirty: number | null;
  result_env_id: string | null;
  merge_status: string | null;
  merged_into: string | null;
  merged_sha: string | null;
  merged_at: number | null;
  /** §2.3: the dispatch named an explicit `--route`/`--preset` (reissue
   * restarts the chain from its beginning). */
  explicit_route: number;
  result_notified_at: number | null;
  result_notice: string | null;
  revived_count: number;
  last_response_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface RouteHoldRow {
  quota_group: string;
  until: number;
  reason: string;
}

export interface PendingRoleRow {
  project_id: string;
  role: string;
  updated_at: number;
}

export type ReleaseStatus =
  | "auditing"
  | "rejected"
  | "publishing"
  | "published"
  | "failed";

export interface ReleaseRow {
  id: number;
  task_key: string;
  project_id: string;
  coordinator_thread_id: string;
  repo_path: string;
  branch: string;
  target_action: "push" | "pr";
  target_branch: string;
  status: ReleaseStatus;
  head_sha: string | null;
  published_sha: string | null;
  remote_base_sha: string | null;
  audit_delegation_id: number | null;
  no_docs_reason: string | null;
  kb_note: string | null;
  no_kb_reason: string | null;
  pr_url: string | null;
  publish_branch: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export type ThreadRoleSource = "hook" | "delegate";

export interface ThreadRoleRow {
  thread_id: string;
  role: string;
  decided_at: number;
  source: ThreadRoleSource;
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
    round?: number;
    continueFrom?: string | null;
    /** §2.3: set when the dispatch named an explicit `--route`/`--preset`. */
    explicitRoute?: boolean;
  }): DelegationRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO delegations (
          task_key, task_id, project_id, coordinator_thread_id, level, route,
          preset, provider, status, round, continue_from, explicit_route,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?)`,
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
        input.round ?? 1,
        input.continueFrom ?? null,
        input.explicitRoute ? 1 : 0,
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
    // One (step, message) pair is stored once — retries must not pile
    // up identical entries.
    errors = errors.filter(
      (e) => !(e?.step === step && e?.message === message),
    );
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

  /** §5.3: a non-manual interruption ends the current turn — clear both
   * markers so `done` cannot latch and a later idle is not misread. */
  clearTurn(id: number): void {
    this.db
      .prepare(
        `UPDATE delegations SET turn_started_at = NULL, first_response_at = NULL,
         updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  /** §5.3 `interrupted`: one resume has been issued. */
  bumpResume(id: number): void {
    this.db
      .prepare(
        `UPDATE delegations SET resume_count = resume_count + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  /** §16.5: latest response-event time of the current turn (idleSeconds). */
  setLastResponse(id: number, at: number): void {
    this.db
      .prepare(
        `UPDATE delegations
         SET last_response_at = MAX(COALESCE(last_response_at, -1), ?),
         updated_at = ? WHERE id = ?`,
      )
      .run(at, Date.now(), id);
  }

  /**
   * §16.5: the coordinator was told (or could not be told — a gone
   * coordinator records `result_notified_at` with a NULL `result_notice`
   * so the delivery does not rescan forever).
   */
  setResultNotified(id: number, notice: "bb" | "plugin" | "legacy" | null): void {
    this.db
      .prepare(
        `UPDATE delegations SET result_notified_at = ?, result_notice = ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), notice, Date.now(), id);
  }

  /**
   * §16.2: a `turn/started` on a finished delegation revives it — back to
   * `running`, `revived_count += 1`, and the delivery record cleared so
   * the next `done`/`cancelled` notifies again. The check for another
   * ACTIVE delegation of the same task runs inside the transaction —
   * otherwise the partial unique index throws mid-handler (PLUG-184).
   * Returns false when a sibling already owns the task.
   */
  revive(id: number): boolean {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (!row) return false;
      const other = this.db
        .prepare(
          `SELECT 1 AS x FROM delegations
           WHERE task_key = ? AND id <> ?
             AND status IN ('dispatching','running') LIMIT 1`,
        )
        .get(row.task_key, id) as { x: number } | undefined;
      if (other) return false;
      this.db
        .prepare(
          `UPDATE delegations SET status = 'running',
           revived_count = revived_count + 1,
           result_notified_at = NULL, result_notice = NULL,
           first_response_at = NULL, last_response_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), id);
      // §16.5: the next `done` re-opens BB's grace window — a stale
      // `result-window` marker would skip it and send over BB's notice.
      try {
        const errors = (
          JSON.parse(row.setup_errors) as { step?: string }[]
        ).filter((e) => e?.step !== "result-window");
        this.db
          .prepare(
            `UPDATE delegations SET setup_errors = ? WHERE id = ?`,
          )
          .run(JSON.stringify(errors), id);
      } catch {
        // A corrupt setup_errors stays as is — the window gate tolerates
        // a stale marker (its timestamp is old, i.e. already elapsed).
      }
      return true;
    })();
  }

  /**
   * §16.2: only the task's NEWEST delegation may revive — a row with a
   * bigger id is a past round that must never work again.
   */
  hasNewerForTask(taskKey: string, id: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 AS x FROM delegations
           WHERE task_key = ? AND id > ? LIMIT 1`,
        )
        .get(taskKey, id) !== undefined
    );
  }

  /**
   * §16.5 exactly-once (PLUG-184): the in-flight delivery marker —
   * `UPDATE … WHERE` is atomic, so a second caller (event vs reconcile
   * pass, or a second plugin process) sees the claim and leaves.
   * `updated_at` doubles as the claim's time: a crash mid-delivery
   * leaves the `-1` until it goes stale — the same predicate that
   * `listPendingResult` rescans lets the claim be TAKEN again after
   * two minutes, so a killed send cannot lose the result (PLUG-190).
   */
  claimResultDelivery(id: number): boolean {
    const staleBefore = Date.now() - 120_000;
    const info = this.db
      .prepare(
        `UPDATE delegations SET result_notified_at = -1, updated_at = ?
         WHERE id = ? AND (
           result_notified_at IS NULL
           OR (result_notified_at = -1 AND updated_at < ?)
         )`,
      )
      .run(Date.now(), id, staleBefore);
    return info.changes > 0;
  }

  /** A claimed delivery failed before the send — release it for a retry. */
  releaseResultClaim(id: number): void {
    this.db
      .prepare(
        `UPDATE delegations SET result_notified_at = NULL
         WHERE id = ? AND result_notified_at = -1`,
      )
      .run(id);
  }

  /** §16.5: `done`/`cancelled` rows whose result was not delivered yet —
   * plus claims that went stale (a crash mid-delivery). */
  listPendingResult(): DelegationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE status IN ('done','cancelled') AND (
           result_notified_at IS NULL
           OR (result_notified_at = -1 AND updated_at < ?)
         )
         ORDER BY id`,
      )
      .all(Date.now() - 120_000) as DelegationRow[];
  }

  /** §16.5 rollout (PLUG-193 #4): rows already terminal when the
   * delivery migration ran — the last_seq sync scope. A row closed
   * after the rollout (`result_notice` unset/'plugin'/'bb') is never
   * force-advanced: its post-cursor turns are real and go through the
   * §16.2 wake rule. */
  listLegacyTerminal(): DelegationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE result_notice = 'legacy' AND thread_id IS NOT NULL
         ORDER BY id`,
      )
      .all() as DelegationRow[];
  }

  /** Terminal rows that still name a thread — the §16.2 wake scan
   * scope (PLUG-193 #3; a stale cursor would let a HISTORICAL turn
   * revive or suppress them, PLUG-190). */
  listTerminalWithThread(): DelegationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE status NOT IN ('dispatching','running')
           AND thread_id IS NOT NULL
         ORDER BY id`,
      )
      .all() as DelegationRow[];
  }

  /** Distinct coordinator threads the store knows — the §16.5 reminder's scope. */
  coordinatorThreadIds(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT coordinator_thread_id AS t FROM delegations`)
      .all() as { t: string }[];
    return rows.map((r) => r.t);
  }

  /** `plugin_meta` — durable service cursors (post-compaction reminder). */
  metaGet(key: string): string | undefined {
    return (
      this.db.prepare(`SELECT value FROM plugin_meta WHERE key = ?`).get(key) as
        | { value: string }
        | undefined
    )?.value;
  }

  metaSet(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO plugin_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** §7 retry limit: another failed retry of the same action. */
  bumpRetry(id: number): void {
    this.db
      .prepare(
        `UPDATE delegations SET retry_count = retry_count + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  /**
   * §7 retry limit: the action finally succeeded — reset the counter and
   * drop the remembered `retry-last-error` step alongside it.
   */
  resetRetry(id: number): void {
    this.clearSetupError(id, "retry-last-error");
    this.db
      .prepare(
        `UPDATE delegations SET retry_count = 0, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  /** One setup_errors entry by step name, or undefined. */
  findSetupError(
    row: DelegationRow,
    step: string,
  ): { step: string; message: string } | undefined {
    try {
      const parsed = JSON.parse(row.setup_errors) as {
        step?: string;
        message?: string;
      }[];
      if (!Array.isArray(parsed)) return undefined;
      const hit = parsed.filter((e) => e?.step === step).at(-1);
      return hit && typeof hit.message === "string"
        ? { step, message: hit.message }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Rows in any of the given statuses, oldest first. */
  listByStatuses(statuses: readonly string[]): DelegationRow[] {
    if (!statuses.length) return [];
    const marks = statuses.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM delegations WHERE status IN (${marks}) ORDER BY id`,
      )
      .all(...statuses) as DelegationRow[];
  }

  /**
   * Routes an automatic reissue already sent this task to (§5.4): a route
   * may be picked at most once per task — but only auto-reissues count,
   * routes of manual delegations stay eligible.
   */
  routesUsedByTask(taskKey: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT route FROM delegations
         WHERE task_key = ? AND reissue_of IS NOT NULL`,
      )
      .all(normalizeTaskKey(taskKey)) as { route: string }[];
    return new Set(rows.map((r) => r.route));
  }

  /**
   * §5.4 reissue in one transaction: the old row moves to `reissued` and a
   * new `dispatching` row with `reissue_of` is inserted atomically, so a
   * service restart mid-reissue cannot leave a duplicate. Returns the new
   * row, or undefined when the old row already left `stalled`/`quota`/
   * `failed`. The reissue retries the SAME round (§4.1 r23): it inherits
   * `round` and `continue_from`, so a later manual delegate is the next
   * round, not the reissue.
   */
  reissue(
    id: number,
    next: { route: string; preset: string; provider: string },
  ): DelegationRow | undefined {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (
        !row ||
        (row.status !== "stalled" &&
          row.status !== "quota" &&
          row.status !== "failed")
      ) {
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
            route, preset, provider, status, reissue_of, round, continue_from,
            explicit_route, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?, ?)`,
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
          row.round,
          row.continue_from,
          // §5.4 (PLUG-186): an explicit --route/--preset lineage keeps
          // restarting the chain and skipping every used route — the
          // flag must reach each reissue, not just the first one.
          row.explicit_route,
          now,
          now,
        );
      return this.get(Number(info.lastInsertRowid));
    })();
  }

  /**
   * §4.1: the next round number for a task — one above the highest round
   * the task already has.
   */
  nextRound(taskKey: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(round), 0) + 1 AS n FROM delegations
         WHERE task_key = ?`,
      )
      .get(normalizeTaskKey(taskKey)) as { n: number };
    return row.n;
  }

  /**
   * §4.1: the newest delegation of the task with a recorded round result —
   * the SHA the next round continues from.
   */
  latestResultByTask(taskKey: string): DelegationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE task_key = ? AND result_sha IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(normalizeTaskKey(taskKey)) as DelegationRow | undefined;
  }

  /**
   * §4.1: the recorded result a `continue_from` sha points at — its branch
   * and the round that produced it — for the «Заход N» / «Проверяемый
   * итог» instruction texts. Null when the ref names no recorded result
   * (e.g. an arbitrary `--from` commit).
   */
  resultRefForSha(
    taskKey: string,
    sha: string,
  ): { branch: string | null; round: number } | null {
    const row = this.db
      .prepare(
        `SELECT result_branch, round FROM delegations
         WHERE task_key = ? AND result_sha = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(normalizeTaskKey(taskKey), sha) as
      | { result_branch: string | null; round: number }
      | undefined;
    return row ? { branch: row.result_branch, round: row.round } : null;
  }

  /** §4.1: record the executor worktree's state at `done`. */
  setRoundResult(
    id: number,
    result: {
      envId?: string | null;
      branch: string | null;
      sha: string;
      commits: number | null;
      dirty: boolean;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE delegations SET result_env_id = ?, result_branch = ?,
         result_sha = ?, result_commits = ?, result_dirty = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        result.envId ?? null,
        result.branch,
        result.sha,
        result.commits,
        result.dirty ? 1 : 0,
        Date.now(),
        id,
      );
  }

  /**
   * §14: the newest `done` delegation of the task with a recorded round
   * result — the row `merge <KEY>` targets.
   */
  latestDoneResultByTask(taskKey: string): DelegationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE task_key = ? AND status = 'done' AND result_sha IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(normalizeTaskKey(taskKey)) as DelegationRow | undefined;
  }

  /** §14: the merge landed — record target branch, merge commit, time. */
  setMerged(id: number, merged: { into: string; sha: string }): void {
    this.db
      .prepare(
        `UPDATE delegations SET merge_status = 'merged', merged_into = ?,
         merged_sha = ?, merged_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(merged.into, merged.sha, Date.now(), Date.now(), id);
  }

  /** §14: a merge outcome that produced no merge commit. */
  setMergeStatus(
    id: number,
    status: "conflict" | "fix-delegated" | "failed",
  ): void {
    this.db
      .prepare(
        `UPDATE delegations SET merge_status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, Date.now(), id);
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

  /** Quota groups and route names currently on hold (`route_holds.until` in the future). */
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

  // ── Roles (§13.2) ─────────────────────────────────────────────────

  /** The new-chat window's remembered pick for one project. */
  pendingRole(projectId: string): string | undefined {
    return (
      this.db
        .prepare(`SELECT role FROM pending_roles WHERE project_id = ?`)
        .get(projectId) as { role: string } | undefined
    )?.role;
  }

  /** Current selection wins: the row stores only the latest pick. */
  setPendingRole(projectId: string, role: string): void {
    this.db
      .prepare(
        `INSERT INTO pending_roles (project_id, role, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           role = excluded.role, updated_at = excluded.updated_at`,
      )
      .run(projectId, role, Date.now());
  }

  /** The decided role of a thread, when the hook or delegate recorded it. */
  threadRole(threadId: string): ThreadRoleRow | undefined {
    return this.db
      .prepare(`SELECT * FROM thread_roles WHERE thread_id = ?`)
      .get(threadId) as ThreadRoleRow | undefined;
  }

  /**
   * §13.2: record the decision once — or correct it. The delegate path
   * upserts because the hook may already have written `executor` from the
   * title alone before the delegation row existed (§4 step 4).
   */
  setThreadRole(
    threadId: string,
    role: string,
    source: ThreadRoleSource,
  ): void {
    this.db
      .prepare(
        `INSERT INTO thread_roles (thread_id, role, decided_at, source)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           role = excluded.role,
           decided_at = excluded.decided_at,
           source = excluded.source`,
      )
      .run(threadId, role, Date.now(), source);
  }

  // ── Releases (orchestrator-release §2/§7) ─────────────────────────

  insertRelease(input: {
    taskKey: string;
    projectId: string;
    coordinatorThreadId: string;
    repoPath: string;
    branch: string;
    targetAction: "push" | "pr";
    targetBranch: string;
    noDocsReason?: string | null;
    kbNote?: string | null;
    noKbReason?: string | null;
  }): ReleaseRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO releases (
          task_key, project_id, coordinator_thread_id, repo_path, branch,
          target_action, target_branch, status, no_docs_reason, kb_note,
          no_kb_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'auditing', ?, ?, ?, ?, ?)`,
      )
      .run(
        normalizeTaskKey(input.taskKey),
        input.projectId,
        input.coordinatorThreadId,
        input.repoPath,
        input.branch,
        input.targetAction,
        input.targetBranch,
        input.noDocsReason ?? null,
        input.kbNote ?? null,
        input.noKbReason ?? null,
        now,
        now,
      );
    return this.getRelease(Number(info.lastInsertRowid))!;
  }

  getRelease(id: number): ReleaseRow | undefined {
    return this.db
      .prepare(`SELECT * FROM releases WHERE id = ?`)
      .get(id) as ReleaseRow | undefined;
  }

  latestReleaseByTask(taskKey: string): ReleaseRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM releases WHERE task_key = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(normalizeTaskKey(taskKey)) as ReleaseRow | undefined;
  }

  activeReleaseByTask(taskKey: string): ReleaseRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM releases WHERE task_key = ?
         AND status IN ('auditing','publishing')`,
      )
      .get(normalizeTaskKey(taskKey)) as ReleaseRow | undefined;
  }

  releasesByStatuses(statuses: readonly string[]): ReleaseRow[] {
    if (!statuses.length) return [];
    const marks = statuses.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM releases WHERE status IN (${marks}) ORDER BY id`,
      )
      .all(...statuses) as ReleaseRow[];
  }

  updateRelease(
    id: number,
    fields: {
      status?: ReleaseStatus;
      headSha?: string | null;
      publishedSha?: string | null;
      remoteBaseSha?: string | null;
      auditDelegationId?: number | null;
      prUrl?: string | null;
      publishBranch?: string | null;
      error?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    const map: Record<string, string> = {
      status: "status",
      headSha: "head_sha",
      publishedSha: "published_sha",
      remoteBaseSha: "remote_base_sha",
      auditDelegationId: "audit_delegation_id",
      prUrl: "pr_url",
      publishBranch: "publish_branch",
      error: "error",
    };
    for (const [key, col] of Object.entries(map)) {
      if (key in fields) {
        sets.push(`${col} = ?`);
        args.push((fields as Record<string, unknown>)[key]);
      }
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    args.push(Date.now(), id);
    this.db
      .prepare(`UPDATE releases SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args);
  }

  /**
   * §2.3 r24: all delegations of the task, newest first — the caller
   * filters by level role (the policy decides which levels audit) or
   * status. Used by reviewByLevel mapping and release acceptance.
   */
  delegationsByTask(taskKey: string): DelegationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delegations WHERE task_key = ? ORDER BY id DESC`,
      )
      .all(normalizeTaskKey(taskKey)) as DelegationRow[];
  }

  /** Latest release-audit delegation of a task (§3): the chain reissue
   * inserts newer rows, so "the audit's delegation" is always the newest
   * `release-audit` row for the task key. */
  latestDelegationByTaskAndLevel(
    taskKey: string,
    level: string,
  ): DelegationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM delegations WHERE task_key = ? AND level = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(normalizeTaskKey(taskKey), level) as
      | DelegationRow
      | undefined;
  }

  /** §16.6: is this PR URL one the release pipeline itself created FOR
   * THIS COORDINATOR? With `threadIds` off our PRs carry no «Источник»
   * marker, so a repeat release may write only into a PR this
   * coordinator's release recorded here — a PR another coordinator's
   * release created is still foreign (PLUG-189). */
  prWasReleased(url: string, coordinatorThreadId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 AS x FROM releases
           WHERE pr_url = ? AND coordinator_thread_id = ? LIMIT 1`,
        )
        .get(url, coordinatorThreadId) !== undefined
    );
  }

  /** §16.6 (PLUG-191): the neutral `release/<sha7>` branch name this
   * task's FIRST published release wrote — repeat releases reuse it so
   * the task keeps one remote branch and one PR. PLUG-194: only
   * `release/…` names count — rows written while `threadIds` was on may
   * still hold the executor's branch, which must never be reused. */
  releasePublishBranch(taskKey: string): string | null {
    const row = this.db
      .prepare(
        `SELECT publish_branch FROM releases
         WHERE task_key = ? AND publish_branch LIKE 'release/%'
         ORDER BY id ASC LIMIT 1`,
      )
      .get(normalizeTaskKey(taskKey)) as
      | { publish_branch: string }
      | undefined;
    return row?.publish_branch ?? null;
  }

  /** §2 step 7 «выложено в обход»: is this sha a commit release pushed? */
  shaWasReleased(sha: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 AS x FROM releases
           WHERE status = 'published'
             AND (head_sha = ? OR published_sha = ?) LIMIT 1`,
        )
        .get(sha, sha) !== undefined
    );
  }
}


// ── Janitor (§15) ────────────────────────────────────────────────────

export type JanitorItemState = "removed" | "kept" | "reported";

export interface JanitorItemRow {
  env_id: string;
  project_id: string | null;
  thread_id: string | null;
  path: string | null;
  branch: string | null;
  state: JanitorItemState;
  reason: string | null;
  size_kb: number | null;
  /** First run the copy was seen merged (resets when the sighting breaks). */
  first_seen_at: number | null;
  last_checked_at: number | null;
  removed_at: number | null;
}

export interface JanitorRunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  removed: number;
  kept: number;
  freed_kb: number;
  error: string | null;
}

export class JanitorStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  item(envId: string): JanitorItemRow | undefined {
    return this.db
      .prepare(`SELECT * FROM janitor_items WHERE env_id = ?`)
      .get(envId) as JanitorItemRow | undefined;
  }

  items(): JanitorItemRow[] {
    return this.db
      .prepare(`SELECT * FROM janitor_items ORDER BY last_checked_at DESC`)
      .all() as JanitorItemRow[];
  }

  /**
   * Upsert the per-env ledger row. `first_seen_at` is managed by the
   * caller (merged-sighting clock, §15); every write stamps
   * `last_checked_at`.
   */
  upsertItem(
    envId: string,
    fields: {
      projectId?: string | null;
      threadId?: string | null;
      path?: string | null;
      branch?: string | null;
      state: JanitorItemState;
      reason?: string | null;
      sizeKb?: number | null;
      firstSeenAt?: number | null;
      removedAt?: number | null;
    },
    at: number,
  ): void {
    const prev = this.item(envId);
    const next = {
      project_id: fields.projectId ?? prev?.project_id ?? null,
      thread_id: fields.threadId ?? prev?.thread_id ?? null,
      path: fields.path ?? prev?.path ?? null,
      branch: fields.branch ?? prev?.branch ?? null,
      state: fields.state,
      reason:
        fields.reason !== undefined ? fields.reason : (prev?.reason ?? null),
      size_kb:
        fields.sizeKb !== undefined ? fields.sizeKb : (prev?.size_kb ?? null),
      first_seen_at:
        fields.firstSeenAt !== undefined
          ? fields.firstSeenAt
          : (prev?.first_seen_at ?? null),
      removed_at:
        fields.removedAt !== undefined
          ? fields.removedAt
          : (prev?.removed_at ?? null),
    };
    this.db
      .prepare(
        `INSERT INTO janitor_items (
          env_id, project_id, thread_id, path, branch, state, reason,
          size_kb, first_seen_at, last_checked_at, removed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(env_id) DO UPDATE SET
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          path = excluded.path,
          branch = excluded.branch,
          state = excluded.state,
          reason = excluded.reason,
          size_kb = excluded.size_kb,
          first_seen_at = excluded.first_seen_at,
          last_checked_at = excluded.last_checked_at,
          removed_at = excluded.removed_at`,
      )
      .run(
        envId,
        next.project_id,
        next.thread_id,
        next.path,
        next.branch,
        next.state,
        next.reason,
        next.size_kb,
        next.first_seen_at,
        at,
        next.removed_at,
      );
  }

  /** Forget an env row entirely (env disappeared and nothing to report). */
  removeItem(envId: string): void {
    this.db.prepare(`DELETE FROM janitor_items WHERE env_id = ?`).run(envId);
  }

  startRun(at: number): number {
    const info = this.db
      .prepare(`INSERT INTO janitor_runs (started_at) VALUES (?)`)
      .run(at);
    return Number(info.lastInsertRowid);
  }

  finishRun(
    id: number,
    result: {
      removed: number;
      kept: number;
      freedKb: number;
      error?: string | null;
    },
    at: number,
  ): void {
    this.db
      .prepare(
        `UPDATE janitor_runs SET finished_at = ?, removed = ?, kept = ?,
         freed_kb = ?, error = ? WHERE id = ?`,
      )
      .run(
        at,
        result.removed,
        result.kept,
        result.freedKb,
        result.error ?? null,
        id,
      );
  }

  latestRun(): JanitorRunRow | undefined {
    return this.db
      .prepare(`SELECT * FROM janitor_runs ORDER BY id DESC LIMIT 1`)
      .get() as JanitorRunRow | undefined;
  }

  meta(key: string): string | undefined {
    return (
      this.db.prepare(`SELECT value FROM janitor_meta WHERE key = ?`).get(key) as
        | { value: string }
        | undefined
    )?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO janitor_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}
