/**
 * SQLite storage (spec §7): `delegations` and `route_holds`, additive-only
 * migrations applied through `bb.storage.migrate`. `pending_roles` and
 * `thread_roles` are added by the roles task (PLUG-141), after these.
 */
import type { Database } from "better-sqlite3";
import { OrchestratorError } from "./errors.js";
import type { EventHookSetting } from "./events.js";
import { T_RU, type T } from "./i18n/index.js";

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
  // §17.3 (ревью PLUG-210): `pipeline_shas` — JSON-массив SHA коммитов,
  // которые создал сам конвейер выкладки на публикуемой ветке (синк-
  // слияние, трейлер --no-docs). Гейт ревью не считает их чужими, в том
  // числе на повторном запуске после отказа.
  `ALTER TABLE releases ADD COLUMN pipeline_shas TEXT`,
  // §17.4 (ревью PLUG-218): `tip_sha` — вершина удаляемого (ветка —
  // её tip, копия — tip её ветки; HEAD копии уходит в журнал и
  // `run --json`). Восстановление ветки: `git branch <ветка> <sha>`,
  // пока gc не убрал объекты (ADR-0024 «Восстановимость»).
  `ALTER TABLE janitor_items ADD COLUMN tip_sha TEXT`,
  // orchestrator-release §6 (r8, PLUG-231): проект настройки выкладки,
  // определённый один раз на шаге 1 — шаги 6–7 и повторные заходы той же
  // выкладки берут его из записи и заново не ищут.
  `ALTER TABLE releases ADD COLUMN settings_project_id TEXT`,
  // §4.1 r28 (PLUG-237): «задача без кода» — делегирование, не требующее
  // коммитов. Наследуется перевыпуском (§5.4); новый delegate без флага
  // — снова обычная раздача.
  `ALTER TABLE delegations ADD COLUMN no_code INTEGER NOT NULL DEFAULT 0`,
  // §16.4 r29 (PLUG-240): журнал спасений — каждая попытка снимка
  // грязной копии (и сбой) строкой: тред, ref, корень репозитория,
  // причина, время и дошла ли строка координатору. `janitor report`
  // читает её, не обходя репозитории, — спасённое без адресата не
  // теряется.
  `CREATE TABLE IF NOT EXISTS janitor_rescues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    ref TEXT,
    repo_root TEXT,
    reason TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL
  )`,
  // orchestrator-release §7 (r10): `notified_at` — итоговая строка п.1
  // отправлена (захват -1 до отправки, stale 2 мин); `repo_root` —
  // realpath основного каталога репозитория, идентичность цели п.0;
  // `pr_*` — слежение за PR п.3 (одна запись на pr_url, 72 ч,
  // счётчик сбоев gh). В delegations `verdict_*` — напоминание
  // ревьюеру/аудитору без вердикта (§17 r31).
  `ALTER TABLE releases ADD COLUMN notified_at INTEGER`,
  `ALTER TABLE releases ADD COLUMN repo_root TEXT`,
  `ALTER TABLE releases ADD COLUMN pr_state TEXT`,
  `ALTER TABLE releases ADD COLUMN pr_checked_at INTEGER`,
  `ALTER TABLE releases ADD COLUMN pr_closed_at INTEGER`,
  `ALTER TABLE releases ADD COLUMN pr_stale_notified INTEGER`,
  `ALTER TABLE releases ADD COLUMN pr_error_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE delegations ADD COLUMN verdict_nudged_at INTEGER`,
  `ALTER TABLE delegations ADD COLUMN verdict_nudge_seq INTEGER`,
  `UPDATE releases SET notified_at = CAST(strftime('%s','now') AS INTEGER)*1000
   WHERE status IN ('published','rejected','failed') AND notified_at IS NULL`,
  `UPDATE releases SET pr_state = 'legacy'
   WHERE pr_url IS NOT NULL AND pr_state IS NULL`,
  // orchestrator-release §2 п.5 (r10): итоговая строка собирается один
  // раз и хранится до доставки (`notice_text`, `notice_kind`) — повтор
  // такта только переотправляет сохранённый текст, работу п.2 и
  // пост-проверку заново не выполняет.
  `ALTER TABLE releases ADD COLUMN notice_text TEXT`,
  `ALTER TABLE releases ADD COLUMN notice_kind TEXT`,
  // orchestrator §18.2 (r32, PLUG-245): журнал запускаемых команд —
  // queued переживает рестарт, running сверяется по pid + proc_start,
  // живая группа убивается до пометки interrupted. argv/cwd/env/stdin
  // хранятся в строке, чтобы запись queued запускалась после рестарта
  // без перечитывания конфига.
  `CREATE TABLE command_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    run_key TEXT NOT NULL UNIQUE,
    group_key TEXT,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    argv TEXT,
    cwd TEXT,
    env TEXT,
    stdin TEXT,
    timeout_sec INTEGER,
    pid INTEGER,
    pgid INTEGER,
    proc_start TEXT,
    exit_code INTEGER,
    output_tail TEXT,
    queued_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER
  )`,
  `CREATE INDEX command_runs_status ON command_runs(status)`,
  `CREATE INDEX command_runs_group ON command_runs(group_key)`,
  // orchestrator-release §2 п.6 (r11): merge-коммит PR для строки «влит → sha7».
  `ALTER TABLE releases ADD COLUMN pr_merge_sha TEXT`,
  // orchestrator §18.5 (r32, PLUG-246): таблица событий — запись идёт в
  // той же транзакции, что и переход, и там же сопоставляется с хуками
  // (queued в command_runs); позже событие хукам не сопоставляется.
  // verdict_event_at — отметка «review.verdict уже порождён» (один раз
  // на делегирование). notify_on_fail — флаг хука на момент постановки.
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `ALTER TABLE delegations ADD COLUMN verdict_event_at INTEGER`,
  `ALTER TABLE command_runs ADD COLUMN notify_on_fail INTEGER NOT NULL DEFAULT 0`,
  // orchestrator §19.4 (r33, PLUG-267): helpers — plugin-created worker
  // threads. The r33 migration also wipes `pending_roles` (the pre-r33
  // window wrote `orchestrator` on open — indistinguishable from a user
  // pick) and stamps `migration-r33`, the §19.3.6 fallback cutoff.
  `CREATE TABLE IF NOT EXISTS helpers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_thread_id TEXT NOT NULL,
    caller_delegation_id INTEGER,
    coordinator_thread_id TEXT NOT NULL,
    thread_id TEXT,
    project_id TEXT,
    preset TEXT NOT NULL,
    route TEXT,
    level TEXT,
    title TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'dispatching','running','done','failed','stalled','quota','cancelled'
    )),
    resume_count INTEGER NOT NULL DEFAULT 0,
    turn_started_at INTEGER,
    last_seq INTEGER,
    notified_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS helpers_thread_idx ON helpers(thread_id)`,
  `CREATE INDEX IF NOT EXISTS helpers_caller_idx
    ON helpers(caller_thread_id, status)`,
  `CREATE INDEX IF NOT EXISTS helpers_delegation_idx
    ON helpers(caller_delegation_id)`,
  // §19.3.6: a configure-time age probe — the hook records every seen
  // thread's `createdAt` (the configure context carries none), so a
  // role-less thread is told "old" (pre-r33 → §3 fallback) from "new"
  // (the hook should have written a role → `none` + a journal warning).
  `CREATE TABLE IF NOT EXISTS thread_facts (
    thread_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  `DELETE FROM pending_roles`,
  `INSERT OR REPLACE INTO plugin_meta (key, value)
   VALUES ('migration-r33',
     CAST(CAST(strftime('%s','now') AS INTEGER) * 1000 AS TEXT))`,
  // §19.6 (r33): the once-archived mark — the 24 h cleanup pass selects
  // terminal helpers without it instead of re-archiving every minute.
  `ALTER TABLE helpers ADD COLUMN archived_at INTEGER`,
  // §25 (r33.4, PLUG-283): the owner's in-window role pick writes
  // `thread_roles.source = 'owner'` — SQLite cannot widen a CHECK, so
  // the table is recreated; old rows move over untouched. Must stay at
  // index 52 — live DBs already recorded its statement hash.
  `CREATE TABLE thread_roles_owner (
    thread_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('hook','delegate','owner'))
  );
  INSERT INTO thread_roles_owner (thread_id, role, decided_at, source)
    SELECT thread_id, role, decided_at, source FROM thread_roles;
  DROP TABLE thread_roles;
  ALTER TABLE thread_roles_owner RENAME TO thread_roles`,
  // §20.2 (r33): a busy `maxActive` route parks the delegation
  // `dispatching` with `queued_at` set — the watchdog retries in
  // `queued_at` order until `routeBusyWaitSeconds` runs out. `attach`
  // holds the dispatch's packet spec as JSON
  // (`{"paths":[…],"from":…}`) so a reissue rebuilds the same packet.
  `ALTER TABLE delegations ADD COLUMN queued_at INTEGER`,
  `ALTER TABLE delegations ADD COLUMN attach TEXT`,
  // §24.2 (r33.5): staged executor results per plugin — the release
  // gate's record of in-review rounds whose UI commits a release would
  // silently revert (`ui_touched`/`ui_files` feed the unmerged-ui
  // refusal); `releases.dropped_unmerged_reason` carries the
  // `--force-drop-unmerged` reason.
  `CREATE TABLE IF NOT EXISTS plugin_staged_features (
    task_key TEXT PRIMARY KEY,
    project_id TEXT,
    plugin_name TEXT NOT NULL,
    branch_name TEXT,
    result_sha TEXT NOT NULL,
    ui_touched INTEGER NOT NULL DEFAULT 0,
    ui_files TEXT,
    status TEXT NOT NULL CHECK (status IN ('in_review', 'merged', 'dropped')),
    dropped_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS plugin_staged_features_plugin_idx
    ON plugin_staged_features(plugin_name, status);
  ALTER TABLE releases ADD COLUMN dropped_unmerged_reason TEXT`,
  // §5.6 (r33.11): the coordinator watchdog's per-coordinator state —
  // survives a plugin restart so the idle countdown continues on real
  // time. `idle_since` anchors the CURRENT quiet epoch (NULL while the
  // coordinator is active or has running executors); `nudge_count` and
  // `escalated_at` persist across epochs until a productive action.
  `CREATE TABLE IF NOT EXISTS coordinator_watchdog_state (
    coordinator_thread_id TEXT PRIMARY KEY,
    idle_since INTEGER,
    nudge_count INTEGER NOT NULL DEFAULT 0,
    last_nudge_at INTEGER,
    escalated_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  // §27.1 (r34, PLUG-309): task_queue and task_transitions for work graph
  `CREATE TABLE IF NOT EXISTS task_queue (
    task_key TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    coordinator_thread_id TEXT NOT NULL,
    route TEXT NOT NULL CHECK(route IN ('feature', 'fix', 'docs', 'simple', 'research')),
    level TEXT NOT NULL CHECK(level IN ('complex', 'medium', 'simple', 'spec', 'research', 'architect')),
    node TEXT NOT NULL CHECK(node IN (
      'start', 'design', 'spec', 'spec_review', 'owner_gate', 'code', 'checks',
      'review', 'design_check', 'release', 'research'
    )),
    status TEXT NOT NULL CHECK(status IN (
      'queued', 'running', 'waiting_approval', 'waiting_release_note',
      'pr_open', 'blocked', 'stalled', 'deferred', 'done', 'cancelled'
    )),
    priority INTEGER NOT NULL DEFAULT 100,
    depends_on TEXT DEFAULT NULL,
    confirmation_mode TEXT NOT NULL DEFAULT 'manual' CHECK(confirmation_mode IN ('auto', 'manual')),
    branch TEXT DEFAULT NULL,
    interaction_id TEXT DEFAULT NULL,
    spec_sha TEXT DEFAULT NULL,
    acceptance_sha TEXT DEFAULT NULL,
    result_sha TEXT DEFAULT NULL,
    release_note TEXT DEFAULT NULL,
    spec_attempts INTEGER NOT NULL DEFAULT 0,
    spec_review_rounds INTEGER NOT NULL DEFAULT 0,
    code_attempts INTEGER NOT NULL DEFAULT 0,
    check_attempts INTEGER NOT NULL DEFAULT 0,
    code_review_rounds INTEGER NOT NULL DEFAULT 0,
    design_check_rounds INTEGER NOT NULL DEFAULT 0,
    release_attempts INTEGER NOT NULL DEFAULT 0,
    entered_at INTEGER NOT NULL,
    deadline_at INTEGER DEFAULT NULL,
    node_alarm_at INTEGER DEFAULT NULL,
    deferred_by TEXT DEFAULT NULL,
    deferred_reason TEXT DEFAULT NULL,
    payload TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key TEXT NOT NULL,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_transitions_task ON task_transitions(task_key, created_at)`,
  // §5.6 (r34.1, PLUG-317): the coordinator watchdog must not act on
  // history — `finished_at` marks when a delegation went terminal (the
  // migration backfills it from `updated_at` for terminal rows only),
  // and `last_activity_at` records the coordinator's last owner turn or
  // productive action (0 = not yet resolved). The watchdog state table
  // is reset on upgrade: rows are lazily recreated on the next
  // coordinatorPass and `last_activity_at` is restored via the journal
  // back-scan (coordinatorFindLastUserTurn).
  `ALTER TABLE delegations ADD COLUMN finished_at INTEGER DEFAULT NULL;
   UPDATE delegations SET finished_at = updated_at
     WHERE status IN ('done','failed','stalled','quota','cancelled')
       AND finished_at IS NULL;
   ALTER TABLE coordinator_watchdog_state ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;
   DELETE FROM coordinator_watchdog_state`,
];

export type CommandRunStatus =
  | "queued"
  | "running"
  | "ok"
  | "failed"
  | "timeout"
  | "interrupted"
  | "skipped";

/** §18.2 (r32): запись журнала одного запуска команды. */
export interface CommandRunRow {
  id: number;
  /** postPublish | eventHook | prProvider — источник команды. */
  source: string;
  run_key: string;
  /** Одна running на group_key — команды одной выкладки последовательны. */
  group_key: string | null;
  name: string;
  status: CommandRunStatus;
  argv: string | null;
  cwd: string | null;
  env: string | null;
  stdin: string | null;
  timeout_sec: number | null;
  pid: number | null;
  pgid: number | null;
  /** /proc/<pid>/stat starttime — отличие «наш лидер» от чужого pid. */
  proc_start: string | null;
  exit_code: number | null;
  output_tail: string | null;
  /** §18.5: флаг notifyOnFail хука на момент постановки (0/1). */
  notify_on_fail: number;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface CommandRunSpec {
  source: string;
  runKey: string;
  groupKey?: string;
  name: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutSec?: number;
  /** §18.5: у хуков — флаг notifyOnFail на момент постановки. */
  notifyOnFail?: boolean;
}

/** §18.5: запись таблицы событий — payload это JSON события v1
 * (тот же документ, что уходит хуку в stdin). */
export interface EventRow {
  id: number;
  kind: string;
  payload: string;
  created_at: number;
}

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
  /** §4.1 r28: «задача без кода» — коммитов не ждём, коммиты — находка. */
  no_code: number;
  /** §17 r31: ревьюер/аудитор завершил ход без вердикта — напоминание
   * отправлено (время и seq журнала на момент отправки). */
  verdict_nudged_at: number | null;
  verdict_nudge_seq: number | null;
  /** §18.5: событие review.verdict уже порождено (один раз на
   * делегирование — оживший тред повторяет delegation.done, но не
   * review.verdict). */
  verdict_event_at: number | null;
  /** §20.2 (r33): parked behind a busy `maxActive` route — the watchdog
   * retries in `queued_at` order; null when not queued. */
  queued_at: number | null;
  /** §20.2 (r33): the dispatch's packet spec JSON
   * (`{"paths":string[],"from":string|null}`) — `--attach` files and the
   * explicit `--from` ref, inherited by reissues. */
  attach: string | null;
  /** §5.6 (r34.1): immutable timestamp of the terminal transition
   * (done/failed/stalled/quota/cancelled); NULL on revive to `running`.
   * The coordinator watchdog ignores rows finished before
   * `coordinator_watchdog_installed_at`. */
  finished_at: number | null;
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
  /** §17.3: JSON-массив SHA, созданных конвейером на этой выкладке. */
  pipeline_shas: string | null;
  /** §6 (r8): проект настройки, записанный на шаге 1. */
  settings_project_id: string | null;
  /** §2 r10 п.5: итоговая строка п.1 отправлена; отрицательное —
   * захват до отправки (минус время захвата, stale 2 мин). */
  notified_at: number | null;
  /** §2 r10 п.5: итоговая строка, собранная до отправки — повтор такта
   * переотправляет её, не повторяя работу. */
  notice_text: string | null;
  notice_kind: string | null;
  /** §2 r10 п.0: realpath основного каталога репозитория — идентичность
   * цели вместе с target_branch. */
  repo_root: string | null;
  /** §2 r10 п.3: open | closed | merged | error | legacy |
   * superseded | closed_final — «72 ч» это флаг pr_stale_notified,
   * не состояние (опрос до MERGED/CLOSED продолжается молча). */
  pr_state: string | null;
  pr_checked_at: number | null;
  pr_closed_at: number | null;
  pr_stale_notified: number | null;
  pr_error_count: number;
  /** §2 п.6 (r11): merge-коммит влитого PR — строка «влит → sha7». */
  pr_merge_sha: string | null;
  /** §24.2 (r33.5): причина `--force-drop-unmerged` — выкладка прошла
   * поверх незамерженных UI-фич того же плагина. */
  dropped_unmerged_reason: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export type ThreadRoleSource = "hook" | "delegate" | "owner";

export interface ThreadRoleRow {
  thread_id: string;
  role: string;
  decided_at: number;
  source: ThreadRoleSource;
}

/** §5.6 (r33.11): the coordinator watchdog row — one per thread with the
 * confirmed `orchestrator` role. */
export interface CoordinatorWatchdogRow {
  coordinator_thread_id: string;
  /** Start of the current quiet idle epoch, or NULL while the thread is
   * active / has running executors / has no pending work. */
  idle_since: number | null;
  /** Nudges sent since the last productive action. */
  nudge_count: number;
  last_nudge_at: number | null;
  /** Owner escalation time — afterwards the watchdog waits silently. */
  escalated_at: number | null;
  /** §5.6 (r34.1): last owner turn or productive action of the
   * coordinator (0 = not resolved yet — the watchdog restores it via a
   * journal back-scan). A thread quiet longer than
   * `coordinatorMaxThreadAgeHours` is never woken. */
  last_activity_at: number;
  updated_at: number;
}

export type StagedFeatureStatus = "in_review" | "merged" | "dropped";

/** §24.2 (r33.5): one task's staged plugin work — which plugin the
 * round's commits touched and whether UI files were among them. The
 * release gate reads `in_review` rows with `ui_touched = 1` whose
 * `result_sha` is not an ancestor of the published HEAD. */
export interface StagedFeatureRow {
  task_key: string;
  project_id: string | null;
  plugin_name: string;
  branch_name: string | null;
  result_sha: string;
  ui_touched: number;
  /** JSON-массив путей интерфейса из диффа захода. */
  ui_files: string | null;
  status: StagedFeatureStatus;
  dropped_reason: string | null;
  created_at: number;
  updated_at: number;
}

/** §19.1/§19.4: helper statuses — no `reissued` (helpers are never
 * reissued) and no separate `unavailable` (a route failure is `failed`). */
export type HelperStatus =
  | "dispatching"
  | "running"
  | "done"
  | "failed"
  | "stalled"
  | "quota"
  | "cancelled";

export const HELPER_ACTIVE_STATUSES: readonly HelperStatus[] = [
  "dispatching",
  "running",
];

/** §19.4: the helpers row — a plugin-created worker thread bound to its
 * caller (and to the caller's delegation when the caller is an executor). */
export interface HelperRow {
  id: number;
  caller_thread_id: string;
  caller_delegation_id: number | null;
  coordinator_thread_id: string;
  thread_id: string | null;
  project_id: string | null;
  preset: string;
  route: string | null;
  level: string | null;
  title: string | null;
  status: HelperStatus;
  resume_count: number;
  turn_started_at: number | null;
  last_seq: number | null;
  notified_at: number | null;
  /** §19.6: set once the janitor pass archived the terminal thread. */
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SetupError {
  step: string;
  message: string;
}

// ── §27.1 / §28.1 (r34, PLUG-309): task work-graph types ─────────────

export type TaskRoute = "feature" | "fix" | "docs" | "simple" | "research";
export type TaskLevel =
  | "complex"
  | "medium"
  | "simple"
  | "spec"
  | "research"
  | "architect";
export type TaskNode =
  | "start"
  | "design"
  | "spec"
  | "spec_review"
  | "owner_gate"
  | "code"
  | "checks"
  | "review"
  | "design_check"
  | "release"
  | "research";
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_release_note"
  | "pr_open"
  | "blocked"
  | "stalled"
  | "deferred"
  | "done"
  | "cancelled";
export type ConfirmationMode = "auto" | "manual";

/** §28.2 п. 5: Будильник узла взводится ТОЛЬКО на активных рабочих узлах. */
export const ACTIVE_ALARM_NODES = new Set<TaskNode>([
  "design",
  "spec",
  "spec_review",
  "code",
  "checks",
  "review",
  "design_check",
  "release",
  "research",
]);

/** §28.2 п. 5: Пассивные состояния ожидания будильник НЕ взводят (node_alarm_at = NULL). */
export const PASSIVE_ALARM_STATUSES = new Set<TaskStatus>([
  "waiting_approval",
  "waiting_release_note",
  "pr_open",
  "deferred",
  "blocked",
  "done",
  "stalled",
  "cancelled",
]);

export interface TaskQueueRow {
  task_key: string;
  project_id: string;
  coordinator_thread_id: string;
  route: TaskRoute;
  level: TaskLevel;
  node: TaskNode;
  status: TaskStatus;
  priority: number;
  depends_on: string | null;
  confirmation_mode: ConfirmationMode;
  branch: string | null;
  interaction_id: string | null;
  spec_sha: string | null;
  acceptance_sha: string | null;
  result_sha: string | null;
  release_note: string | null;
  spec_attempts: number;
  spec_review_rounds: number;
  code_attempts: number;
  check_attempts: number;
  code_review_rounds: number;
  design_check_rounds: number;
  release_attempts: number;
  entered_at: number;
  deadline_at: number | null;
  node_alarm_at: number | null;
  deferred_by: string | null;
  deferred_reason: string | null;
  payload: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskTransitionRow {
  id: number;
  task_key: string;
  from_node: TaskNode;
  to_node: TaskNode;
  from_status: TaskStatus;
  to_status: TaskStatus;
  actor: string;
  reason: string;
  payload: string | null;
  created_at: number;
}

export interface TransitionTaskInput {
  taskKey: string;
  expectedNode: TaskNode;
  expectedStatus: TaskStatus;
  toNode: TaskNode;
  toStatus: TaskStatus;
  actor: string;
  reason: string;
  now?: number;
  updates?: Partial<Omit<TaskQueueRow, "task_key" | "created_at">>;
  transitionPayload?: string | null;
  /** §28.2 п. 3: таймаут узла в секундах для взвода будильника node_alarm_at */
  timeoutSeconds?: number;
}

export interface TransitionTaskResult {
  ok: boolean;
  conflict?: boolean;
  task?: TaskQueueRow;
  transitionId?: number;
}

/** Task keys are case-insensitive in bb; store them uppercased so the
 * partial unique index actually sees "plug-1" and "PLUG-1" as one task. */
export const normalizeTaskKey = (key: string) => key.trim().toUpperCase();

export class DelegationStore {
  private readonly db: Database;

  /** §18.5: действующие хуки событий и каталог их запуска — назначает
   * сервер после разбора настройки `eventHooks`; провайдер синхронный
   * (сопоставление — внутри транзакции перехода). null — хуков нет,
   * события в таблицу пишутся всё равно. */
  eventHooksProvider:
    | (() => { hooks: EventHookSetting[]; cwd: string } | null)
    | null = null;

  /** §19.1 (r33): the server wires the helper cascade here — every
   * delegation that leaves the active statuses cancels its helpers
   * (`done`/`reissued` fire as no-ops when no helper is left). */
  onDelegationFinished?: (id: number, status: DelegationStatus) => void;

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
    /** §4.1 r28: «задача без кода» (`delegate --no-code`). */
    noCode?: boolean;
    /** §20.2 (r33): the packet spec JSON — `{"paths","from"}`. */
    attach?: string | null;
  }): DelegationRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO delegations (
          task_key, task_id, project_id, coordinator_thread_id, level, route,
          preset, provider, status, round, continue_from, explicit_route,
          no_code, attach, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?, ?, ?)`,
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
        input.noCode ? 1 : 0,
        input.attach ?? null,
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
        `UPDATE delegations SET thread_id = ?, task_id = COALESCE(?, task_id),
           queued_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(threadId, taskId ?? null, Date.now(), id);
  }

  setStatus(id: number, status: DelegationStatus): void {
    this.db.transaction(() => {
      const at = Date.now();
      this.db
        .prepare(
          `UPDATE delegations SET status = ?, updated_at = ?,
           finished_at = CASE
             WHEN ? IN ('done','failed','stalled','quota','cancelled') THEN ?
             WHEN ? = 'running' THEN NULL
             ELSE finished_at END
           WHERE id = ?`,
        )
        .run(status, at, status, at, status, id);
      const row = this.get(id);
      if (row) this.emitDelegationTransition(row, status, at);
    })();
    if (status !== "dispatching" && status !== "running") {
      this.onDelegationFinished?.(id, status);
    }
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
    /** §18.5: у делегирования ревью — прочитанный вердикт (r31) для
     * события review.verdict в той же транзакции. */
    opts?: { reviewVerdict?: { verdict: string; blockers: number | null } },
  ): boolean {
    const moved = this.db.transaction(() => {
      const at = Date.now();
      const info = this.db
        .prepare(
          `UPDATE delegations SET status = ?, updated_at = ?,
           finished_at = CASE
             WHEN ? IN ('done','failed','stalled','quota','cancelled') THEN ?
             WHEN ? = 'running' THEN NULL
             ELSE finished_at END
           WHERE id = ? AND status = ?`,
        )
        .run(to, at, to, at, to, id, from);
      if (info.changes === 0) return false;
      const row = this.get(id);
      if (row) this.emitDelegationTransition(row, to, at, opts);
      return true;
    })();
    if (moved && to !== "dispatching" && to !== "running") {
      this.onDelegationFinished?.(id, to);
    }
    return moved;
  }

  /**
   * §20.2 (r33): park/unpark a `dispatching` row behind a busy
   * `maxActive` route — `queued_at` keeps the first-come order across
   * retries (a re-check does not re-stamp).
   */
  setQueuedAt(id: number, at: number | null): void {
    this.db
      .prepare(
        `UPDATE delegations SET queued_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(at, Date.now(), id);
  }

  /**
   * §20.2 (r33): a skipped or timed-out tool-less route hands the SAME
   * dispatching row to the next chain route — only while the row is
   * still `dispatching` with no thread (the route is not yet burned).
   * `explicit_route` drops with the caller's pick: the new route is
   * plugin-chosen, so a later advance/reissue walks the chain from
   * its position instead of restarting into the burned route.
   */
  updateRoute(
    id: number,
    next: { route: string; preset: string; provider: string },
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE delegations SET route = ?, preset = ?, provider = ?,
           queued_at = NULL, explicit_route = 0, updated_at = ?
         WHERE id = ? AND status = 'dispatching' AND thread_id IS NULL`,
      )
      .run(next.route, next.preset, next.provider, Date.now(), id);
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
   * so the delivery does not rescan forever). §25.6: `self-cancel` —
   * the coordinator's own `cancel` needs no result delivery at all.
   */
  setResultNotified(
    id: number,
    notice: "bb" | "plugin" | "legacy" | "self-cancel" | null,
  ): void {
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
           first_response_at = NULL, last_response_at = NULL,
           finished_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), id);
      // §16.5: the next `done` re-opens BB's grace window — a stale
      // `result-window` marker would skip it and send over BB's notice.
      // A stale `coordinator-cancel` (PLUG-224) would keep «без отчёта»
      // wrongly suppressed on the new round.
      try {
        const errors = (
          JSON.parse(row.setup_errors) as { step?: string }[]
        ).filter(
          (e) =>
            e?.step !== "result-window" && e?.step !== "coordinator-cancel",
        );
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

  /** §17.2 (мелко 6): coordinator threads that still own an ACTIVE
   * delegation — the post-compaction reminder polls only these, not the
   * whole history of coordinators every minute. */
  activeCoordinatorThreadIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT coordinator_thread_id AS t FROM delegations
         WHERE status IN ('dispatching','running')`,
      )
      .all() as { t: string }[];
    return rows.map((r) => r.t);
  }

  /** §17.2 (мелко 6): status counts of ONE coordinator's delegations —
   * the reminder names only its own rows, not global totals. */
  countsByStatusForCoordinator(
    coordinatorThreadId: string,
  ): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM delegations
         WHERE coordinator_thread_id = ? GROUP BY status`,
      )
      .all(coordinatorThreadId) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
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

  /** §19.1: drop every setup_errors entry of a step — the
   * `helpers-pending` mark is consumed when the wait ends. */
  removeSetupErrors(id: number, step: string): void {
    const row = this.get(id);
    if (!row) return;
    let errors: SetupError[] = [];
    try {
      const parsed = JSON.parse(row.setup_errors) as unknown;
      if (Array.isArray(parsed)) errors = parsed as SetupError[];
    } catch {
      return;
    }
    const next = errors.filter((e) => e?.step !== step);
    if (next.length === errors.length) return;
    this.db
      .prepare(
        `UPDATE delegations SET setup_errors = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(next), Date.now(), id);
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
   * routes of manual delegations stay eligible. §17.2 (мелко 4): the
   * budget is per ROUND — a later round's chain may re-walk routes an
   * earlier round already burned, so callers pass the current `round`.
   */
  routesUsedByTask(taskKey: string, round?: number): Set<string> {
    const key = normalizeTaskKey(taskKey);
    const rows = (
      round === undefined
        ? this.db
            .prepare(
              `SELECT DISTINCT route FROM delegations
               WHERE task_key = ? AND reissue_of IS NOT NULL`,
            )
            .all(key)
        : this.db
            .prepare(
              `SELECT DISTINCT route FROM delegations
               WHERE task_key = ? AND reissue_of IS NOT NULL AND round = ?`,
            )
            .all(key, round)
    ) as { route: string }[];
    return new Set(rows.map((r) => r.route));
  }

  /**
   * §17.2 r26 (PLUG-211 С2/мелко 2): the auto-reissue budget's «заход» is
   * one reissue CHAIN — the root dispatch (`reissue_of` NULL) plus every
   * row reissued from it. Round numbers are no longer one-per-chain:
   * review and release-audit dispatches share the executor's round space
   * but form their own chains, so their route reserve counts separately
   * and never eats the executor round's budget (or vice versa).
   * `reissuesOnly` mirrors `routesUsedByTask` — only routes an
   * auto-reissue already burned; without it every route of the chain
   * counts (the explicit --route/--preset restart rule).
   */
  chainUsedRoutes(
    row: DelegationRow,
    opts: { reissuesOnly?: boolean } = {},
  ): Set<string> {
    const rows = this.delegationsByTask(row.task_key);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const rootOf = (r: DelegationRow): number => {
      let cur = r;
      const seen = new Set<number>();
      while (cur.reissue_of != null && !seen.has(cur.reissue_of)) {
        seen.add(cur.reissue_of);
        const prev = byId.get(cur.reissue_of);
        if (!prev) break;
        cur = prev;
      }
      return cur.id;
    };
    const root = rootOf(row);
    return new Set(
      rows
        .filter((r) => !opts.reissuesOnly || r.reissue_of != null)
        .filter((r) => rootOf(r) === root)
        .map((r) => r.route),
    );
  }

  /** Rows whose `setup_errors` carry an entry for `step` — the §7 scans
   * (e.g. `notify-muted` marks needing the `auto` restore, §17.2 r26). */
  listBySetupError(step: string): DelegationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delegations WHERE setup_errors LIKE ? ORDER BY id`,
      )
      .all(`%"step":"${step}"%`) as DelegationRow[];
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
    const next_ = this.db.transaction(() => {
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
            explicit_route, no_code, attach, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // §4.1 r28: a reissue is the same dispatch — the «без кода»
          // mark inherits with the round fields.
          row.no_code,
          // §20.2: the packet spec survives the reissue — the tool-less
          // route's material is rebuilt from the same spec.
          row.attach,
          now,
          now,
        );
      return this.get(Number(info.lastInsertRowid));
    })();
    if (next_ !== undefined) this.onDelegationFinished?.(id, "reissued");
    return next_;
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

  /** §4.1: record the executor worktree's state at `done`. §17.2 (С3):
   * a CHANGED `result_sha` — a revived thread that committed more —
   * voids the recorded merge: the new commits were never merged, so
   * `merge` must no longer answer `already-merged` and `release` must
   * not publish the stale `merged_into` range. */
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
    const prev = this.get(id);
    const shaChanged = prev != null && prev.result_sha !== result.sha;
    this.db
      .prepare(
        `UPDATE delegations SET result_env_id = ?, result_branch = ?,
         result_sha = ?, result_commits = ?, result_dirty = ?,
         merge_status = CASE WHEN ? THEN NULL ELSE merge_status END,
         merged_into = CASE WHEN ? THEN NULL ELSE merged_into END,
         merged_sha = CASE WHEN ? THEN NULL ELSE merged_sha END,
         merged_at = CASE WHEN ? THEN NULL ELSE merged_at END,
         updated_at = ?
         WHERE id = ?`,
      )
      .run(
        result.envId ?? null,
        result.branch,
        result.sha,
        result.commits,
        result.dirty ? 1 : 0,
        shaChanged ? 1 : 0,
        shaChanged ? 1 : 0,
        shaChanged ? 1 : 0,
        shaChanged ? 1 : 0,
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

  /** All recorded thread roles, optionally filtered — the §17.1 r26
   * migration's scope (hook-written `orchestrator` rows). */
  listThreadRoles(
    filter: { role?: string; source?: ThreadRoleSource } = {},
  ): ThreadRoleRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.role) {
      where.push("role = ?");
      args.push(filter.role);
    }
    if (filter.source) {
      where.push("source = ?");
      args.push(filter.source);
    }
    return this.db
      .prepare(
        `SELECT * FROM thread_roles` +
          (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
          ` ORDER BY thread_id`,
      )
      .all(...args) as ThreadRoleRow[];
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

  // ── Coordinator watchdog (§5.6, r33.11) ──────────────────────────

  /** Threads whose decided role is `orchestrator` — the watchdog's scope. */
  orchestratorThreadIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id AS t FROM thread_roles WHERE role = 'orchestrator'`,
      )
      .all() as { t: string }[];
    return rows.map((r) => r.t);
  }

  coordinatorWatchdogGet(
    coordinatorThreadId: string,
  ): CoordinatorWatchdogRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM coordinator_watchdog_state
         WHERE coordinator_thread_id = ?`,
      )
      .get(coordinatorThreadId) as CoordinatorWatchdogRow | undefined;
  }

  coordinatorWatchdogList(): CoordinatorWatchdogRow[] {
    return this.db
      .prepare(
        `SELECT * FROM coordinator_watchdog_state
         ORDER BY coordinator_thread_id`,
      )
      .all() as CoordinatorWatchdogRow[];
  }

  /** Get-or-create the row with a zeroed schedule. */
  coordinatorWatchdogEnsure(
    coordinatorThreadId: string,
  ): CoordinatorWatchdogRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO coordinator_watchdog_state
           (coordinator_thread_id, updated_at) VALUES (?, ?)`,
      )
      .run(coordinatorThreadId, Date.now());
    return this.coordinatorWatchdogGet(coordinatorThreadId)!;
  }

  /** Partial update — every listed key is written verbatim (NULL too). */
  coordinatorWatchdogPatch(
    coordinatorThreadId: string,
    patch: {
      idle_since?: number | null;
      nudge_count?: number;
      last_nudge_at?: number | null;
      escalated_at?: number | null;
      last_activity_at?: number;
    },
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const key of [
      "idle_since",
      "nudge_count",
      "last_nudge_at",
      "escalated_at",
      "last_activity_at",
    ] as const) {
      if (key in patch) {
        sets.push(`${key} = ?`);
        args.push(patch[key]);
      }
    }
    if (!sets.length) return;
    this.coordinatorWatchdogEnsure(coordinatorThreadId);
    this.db
      .prepare(
        `UPDATE coordinator_watchdog_state
         SET ${sets.join(", ")}, updated_at = ?
         WHERE coordinator_thread_id = ?`,
      )
      .run(...args, Date.now(), coordinatorThreadId);
  }

  /** §5.6 п.4: a productive action or cleared queue — the schedule,
   * the escalation wait and the idle anchor all restart from zero, and
   * `last_activity_at` is unconditionally refreshed (a reset trigger
   * IS coordinator activity). */
  coordinatorWatchdogReset(coordinatorThreadId: string): void {
    this.coordinatorWatchdogPatch(coordinatorThreadId, {
      idle_since: null,
      nudge_count: 0,
      last_nudge_at: null,
      escalated_at: null,
      last_activity_at: Date.now(),
    });
  }

  coordinatorWatchdogDelete(coordinatorThreadId: string): void {
    this.db
      .prepare(
        `DELETE FROM coordinator_watchdog_state
         WHERE coordinator_thread_id = ?`,
      )
      .run(coordinatorThreadId);
  }

  /**
   * §5.6 п.1а–б: tasks waiting on THIS coordinator — per task, its NEWEST
   * delegation is `done` and not landed (`merge_status IS NULL` or a
   * failed `conflict`/`failed` merge), or sits in a terminal
   * `failed`/`stalled`/`quota` without a later round. Rows whose staged
   * feature the owner explicitly dropped (`--force-drop-unmerged`) are
   * settled and skipped.
   * §5.6 (r34.1): only rows finished at or after `installedAt`
   * (`coordinator_watchdog_installed_at`) count — history before the
   * watchdog's epoch never enters the pending list; `merged`/
   * `merged-upstream` rows never qualify (the merge_status filters).
   */
  private coordinatorPendingSelect(columns: string): string {
    return `SELECT ${columns} FROM delegations d
         WHERE d.coordinator_thread_id = ?
           AND d.id = (
             SELECT MAX(id) FROM delegations WHERE task_key = d.task_key
           )
           AND (
             (d.status = 'done' AND (
               d.merge_status IS NULL
               OR d.merge_status IN ('conflict', 'failed')
             ) AND NOT (d.no_code = 1 AND COALESCE(d.result_commits, 0) = 0))
             OR d.status IN ('failed', 'stalled', 'quota')
           )
           AND d.finished_at >= ?
           AND d.task_key NOT IN (
             SELECT task_key FROM plugin_staged_features
             WHERE status = 'dropped'
           )
           AND d.task_key NOT IN (
             SELECT task_key FROM releases
             WHERE status IN ('auditing', 'publishing', 'published')
           )
         ORDER BY d.updated_at`;
  }

  coordinatorPendingTasks(
    coordinatorThreadId: string,
    installedAt = 0,
  ): { task_key: string; status: string; updated_at: number }[] {
    return this.db
      .prepare(
        this.coordinatorPendingSelect("d.task_key, d.status, d.updated_at"),
      )
      .all(coordinatorThreadId, installedAt) as {
      task_key: string;
      status: string;
      updated_at: number;
    }[];
  }

  /** §5.6 (r34.1): the same pending set as full rows — the 60 s
   * `reconcileUpstreamPass` reads result_sha/commits/project from them. */
  coordinatorPendingDelegations(
    coordinatorThreadId: string,
    installedAt = 0,
  ): DelegationRow[] {
    return this.db
      .prepare(this.coordinatorPendingSelect("d.*"))
      .all(coordinatorThreadId, installedAt) as DelegationRow[];
  }

  /** §5.6 п.9 (r34.1): `reconcileHistoryOnce` — every `done` row with a
   * recorded result and no landed merge status, WITHOUT the
   * `finished_at` epoch filter: historical rows get their
   * `merged-upstream` mark here once, so `bb orchestrator status`
   * stops showing them as unmerged. */
  doneDelegationsForReconcile(): DelegationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE status = 'done'
           AND result_sha IS NOT NULL
           AND COALESCE(result_commits, 0) > 0
           AND (merge_status IS NULL
             OR merge_status IN ('conflict', 'failed'))
         ORDER BY id`,
      )
      .all() as DelegationRow[];
  }

  /**
   * §5.6 (r34.1): the upstream-merge mark — atomic on purpose: the
   * WHERE still requires the same `result_sha` and an unmerged status,
   * so a fresh round or a local `merge` landing between the check and
   * the write can never be overwritten.
   */
  markMergedUpstream(
    id: number,
    resultSha: string,
    mergedInto: string,
    upstreamSha: string,
  ): boolean {
    const now = Date.now();
    const info = this.db
      .prepare(
        `UPDATE delegations SET merge_status = 'merged-upstream',
         merged_into = ?, merged_sha = ?, merged_at = ?, updated_at = ?
         WHERE id = ? AND status = 'done' AND result_sha = ?
           AND (merge_status IS NULL
             OR merge_status IN ('conflict', 'failed'))`,
      )
      .run(mergedInto, upstreamSha, now, now, id, resultSha);
    return info.changes > 0;
  }

  /** §5.6 (r34): with the work graph on, task_queue owns its tasks —
   * the watchdog wakes the coordinator only for these queue states. */
  taskQueueWatchKeys(coordinatorThreadId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT task_key AS k FROM task_queue
         WHERE coordinator_thread_id = ?
           AND status IN ('blocked', 'stalled', 'waiting_release_note')`,
      )
      .all(coordinatorThreadId) as { k: string }[];
    return rows.map((r) => r.k);
  }

  /** §5.6 (r34): keys registered in the task queue — excluded from the
   * delegation-based pending set while the graph drives them. */
  taskQueueKeys(coordinatorThreadId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT task_key AS k FROM task_queue
         WHERE coordinator_thread_id = ?`,
      )
      .all(coordinatorThreadId) as { k: string }[];
    return new Set(rows.map((r) => r.k));
  }

  /** §5.6 п.1: the coordinator still owns a working executor — while it
   * runs, sleeping is the contract, not a stall. */
  hasActiveForCoordinator(coordinatorThreadId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 AS x FROM delegations
           WHERE coordinator_thread_id = ?
             AND status IN ('dispatching','running') LIMIT 1`,
        )
        .get(coordinatorThreadId) !== undefined
    );
  }

  // ── Helpers (§19.1/§19.4, r33) ─────────────────────────────────

  /**
   * §19.1: the limit check and the row insert are ONE transaction —
   * two parallel `helper` calls cannot both pass the cap. `perCaller`
   * is `helpers.maxActive`; `maxActive` is the policy's
   * `limits.maxActive`, shared with delegations.
   */
  insertHelperChecked(
    input: {
      callerThreadId: string;
      callerDelegationId?: number | null;
      coordinatorThreadId: string;
      projectId?: string | null;
      preset: string;
      route?: string | null;
      level?: string | null;
      title?: string | null;
    },
    caps: {
      /** `helpers.maxActive` — active helpers of THIS caller (§19.1:
       * the helpers setting is a per-caller cap). */
      perCaller: number;
      /** `limits.maxActive` — helpers count together with delegations
       * (ADR r33: «помощники в общем пределе политики»). */
      sharedMax?: number;
    },
  ): HelperRow {
    return this.db.transaction(() => {
      const ownActive = this.activeHelpersByCaller(
        input.callerThreadId,
      ).length;
      if (ownActive >= caps.perCaller) {
        throw new OrchestratorError(
          "helper-limit",
          `active helpers ${ownActive}/${caps.perCaller}`,
        );
      }
      const helpersActive = this.helperActiveCount();
      if (caps.sharedMax !== undefined) {
        const shared = this.activeCount() + helpersActive;
        if (shared >= caps.sharedMax) {
          throw new OrchestratorError(
            "limit",
            `active delegations and helpers ${shared}/${caps.sharedMax}`,
          );
        }
      }
      const now = Date.now();
      const info = this.db
        .prepare(
          `INSERT INTO helpers (
            caller_thread_id, caller_delegation_id, coordinator_thread_id,
            project_id, preset, route, level, title, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)`,
        )
        .run(
          input.callerThreadId,
          input.callerDelegationId ?? null,
          input.coordinatorThreadId,
          input.projectId ?? null,
          input.preset,
          input.route ?? null,
          input.level ?? null,
          input.title ?? null,
          now,
          now,
        );
      return this.helper(Number(info.lastInsertRowid))!;
    })();
  }

  helper(id: number): HelperRow | undefined {
    return this.db.prepare(`SELECT * FROM helpers WHERE id = ?`).get(id) as
      | HelperRow
      | undefined;
  }

  helperByThreadId(threadId: string): HelperRow | undefined {
    return this.db
      .prepare(`SELECT * FROM helpers WHERE thread_id = ?`)
      .get(threadId) as HelperRow | undefined;
  }

  /** §19.6 status block + §19.1 merges/cancels — filtered listing. */
  listHelpers(
    filter: {
      coordinatorThreadId?: string;
      callerThreadId?: string;
      limit?: number;
    } = {},
  ): HelperRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.coordinatorThreadId) {
      where.push("coordinator_thread_id = ?");
      args.push(filter.coordinatorThreadId);
    }
    if (filter.callerThreadId) {
      where.push("caller_thread_id = ?");
      args.push(filter.callerThreadId);
    }
    return this.db
      .prepare(
        `SELECT * FROM helpers` +
          (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
          ` ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, filter.limit ?? 50) as HelperRow[];
  }

  listActiveHelpers(): HelperRow[] {
    return this.db
      .prepare(
        `SELECT * FROM helpers WHERE status IN ('dispatching','running')
         ORDER BY id`,
      )
      .all() as HelperRow[];
  }

  helperActiveCount(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) n FROM helpers
           WHERE status IN ('dispatching','running')`,
        )
        .get() as { n: number }
    ).n;
  }

  /** The caller's active helpers — the §19.1 `helper-limit` input and
   * the archive/delete cascade's target list. */
  activeHelpersByCaller(callerThreadId: string): HelperRow[] {
    return this.db
      .prepare(
        `SELECT * FROM helpers WHERE caller_thread_id = ?
         AND status IN ('dispatching','running') ORDER BY id`,
      )
      .all(callerThreadId) as HelperRow[];
  }

  /** §19.1: active helpers of one delegation — the done/merge gate and
   * the caller-delegation cascade. */
  activeHelpersByDelegation(delegationId: number): HelperRow[] {
    return this.db
      .prepare(
        `SELECT * FROM helpers WHERE caller_delegation_id = ?
         AND status IN ('dispatching','running') ORDER BY id`,
      )
      .all(delegationId) as HelperRow[];
  }

  /** Active helpers whose CALLER is this thread — the caller archive /
   * delete cascade (any caller: root chat or delegation executor). */
  activeHelpersByThreadCaller(callerThreadId: string): HelperRow[] {
    return this.activeHelpersByCaller(callerThreadId);
  }

  setHelperThread(id: number, threadId: string): void {
    this.db
      .prepare(
        `UPDATE helpers SET thread_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(threadId, Date.now(), id);
  }

  /**
   * §21.4 (r33 ревью 2): a packet skip inside a tool-less helper moves
   * the SAME dispatching row to the next chain route — helpers never
   * queue; the row's preset/route must match where it actually spawns
   * (the shared `quotaGroup` busy count reads them).
   */
  updateHelperRoute(
    id: number,
    next: { route: string; preset: string },
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE helpers SET route = ?, preset = ?, updated_at = ?
         WHERE id = ? AND status = 'dispatching' AND thread_id IS NULL`,
      )
      .run(next.route, next.preset, Date.now(), id);
    return info.changes > 0;
  }

  setHelperStatus(id: number, status: HelperStatus): void {
    this.db
      .prepare(`UPDATE helpers SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  /** §5.3 ordering for helpers too — status first, `threads.stop` after:
   * an own stop must never read as an external interrupt. */
  setHelperStatusIf(
    id: number,
    from: HelperStatus,
    to: HelperStatus,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE helpers SET status = ?, updated_at = ?
           WHERE id = ? AND status = ?`,
        )
        .run(to, Date.now(), id, from).changes > 0
    );
  }

  bumpHelperResume(id: number): void {
    this.db
      .prepare(
        `UPDATE helpers SET resume_count = resume_count + 1,
         updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  /** §19.1 (Argon): a running helper's silence clock follows its last
   * journal event — a direct write, not `COALESCE`: a stale spawn-time
   * stamp would mark a busy helper stalled. */
  setHelperTurnStarted(id: number, at: number): void {
    this.db
      .prepare(
        `UPDATE helpers SET turn_started_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(at, Date.now(), id);
  }

  /** §19.1: the atomic terminal flip — a racing finish/cancel loses to
   * whoever committed first. Returns true when the row moved. */
  setHelperTerminal(id: number, to: HelperStatus): boolean {
    return (
      this.db
        .prepare(
          `UPDATE helpers SET status = ?, updated_at = ?
           WHERE id = ? AND status IN ('dispatching','running')`,
        )
        .run(to, Date.now(), id).changes > 0
    );
  }

  /** §19.1: the once-per-outcome line mark — atomic so a racing
   * notification path cannot double-send. */
  setHelperNotifiedIf(id: number, at: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE helpers SET notified_at = ?, updated_at = ?
           WHERE id = ? AND notified_at IS NULL`,
        )
        .run(at, Date.now(), id).changes > 0
    );
  }

  /** Dispatching and cancelled rows still lacking `thread_id` — the
   * reconcile's relink scope: a cancelled row's surfaced child is
   * still found and stopped (§19.1: «отмена до thread_id»). */
  listUnlinkedHelpers(): HelperRow[] {
    return this.db
      .prepare(
        `SELECT * FROM helpers WHERE thread_id IS NULL
         AND status IN ('dispatching','cancelled') ORDER BY id`,
      )
      .all() as HelperRow[];
  }

  /** §19.6: terminal helpers past the archive age whose thread has not
   * been archived yet — the marked `archived_at` keeps the janitor
   * pass from re-archiving the same row every minute. */
  listHelpersForArchive(olderThan: number): HelperRow[] {
    return this.db
      .prepare(
        `SELECT * FROM helpers WHERE thread_id IS NOT NULL
         AND status NOT IN ('dispatching','running')
         AND archived_at IS NULL AND updated_at < ? ORDER BY id`,
      )
      .all(olderThan) as HelperRow[];
  }

  markHelperArchived(id: number): void {
    this.db
      .prepare(`UPDATE helpers SET archived_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  clearHelperTurn(id: number): void {
    this.db
      .prepare(
        `UPDATE helpers SET turn_started_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  advanceHelperLastSeq(id: number, seq: number): void {
    this.db
      .prepare(
        `UPDATE helpers SET last_seq = MAX(COALESCE(last_seq, -1), ?),
         updated_at = ? WHERE id = ?`,
      )
      .run(seq, Date.now(), id);
  }

  /** §19.1: `notified_at` doubles as the once-per-outcome line mark —
   * a restart re-evaluates the outcome without duplicating the line. */
  setHelperNotified(id: number, at: number): void {
    this.db
      .prepare(`UPDATE helpers SET notified_at = ?, updated_at = ? WHERE id = ?`)
      .run(at, Date.now(), id);
  }

  // ── thread_facts (§19.3.6) ──────────────────────────────────────────

  /** The hook records every thread it sees with its `createdAt` — the
   * sync `configure` has no age fact of its own. */
  noteThreadSeen(threadId: string, createdAt: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_facts (thread_id, created_at)
         VALUES (?, ?)`,
      )
      .run(threadId, createdAt);
  }

  threadCreatedAt(threadId: string): number | undefined {
    return (
      this.db
        .prepare(`SELECT created_at FROM thread_facts WHERE thread_id = ?`)
        .get(threadId) as { created_at: number } | undefined
    )?.created_at;
  }

  // ── Manual role writes (§19.4) ──────────────────────────────────────

  /** §19.4: `role set … none` — the manual write is distinguishable from
   * a dispatch's: `thread_roles` keeps `source = delegate` and the §18.5
   * events table gets `role.manual` (who, when, the replaced role).
   * §25 (r33.4): the owner's in-window pick passes `source = "owner"`. */
  setRoleManual(
    threadId: string,
    role: string,
    actor: string,
    source: "delegate" | "owner" = "delegate",
  ): void {
    const previous = this.threadRole(threadId)?.role ?? null;
    const at = Date.now();
    this.db.transaction(() => {
      this.setThreadRole(threadId, role, source);
      this.emitEvent(
        "role.manual",
        { thread: threadId, role, previous, actor },
        at,
      );
    })();
  }

  /** §19.4: the `role set … none` refusal input — every way this thread
   * participates in an active delegation or helper. */
  activeRoleParticipation(threadId: string): {
    executorDelegation: number | null;
    coordinatorDelegation: number | null;
    helperThread: number | null;
    helperCaller: number | null;
    helperCoordinator: number | null;
  } {
    const one = (sql: string) =>
      (
        this.db.prepare(sql).get(threadId) as { id: number } | undefined
      )?.id ?? null;
    return {
      executorDelegation: one(
        `SELECT id FROM delegations WHERE thread_id = ?
         AND status IN ('dispatching','running') LIMIT 1`,
      ),
      coordinatorDelegation: one(
        `SELECT id FROM delegations WHERE coordinator_thread_id = ?
         AND status IN ('dispatching','running') LIMIT 1`,
      ),
      helperThread: one(
        `SELECT id FROM helpers WHERE thread_id = ?
         AND status IN ('dispatching','running') LIMIT 1`,
      ),
      helperCaller: one(
        `SELECT id FROM helpers WHERE caller_thread_id = ?
         AND status IN ('dispatching','running') LIMIT 1`,
      ),
      helperCoordinator: one(
        `SELECT id FROM helpers WHERE coordinator_thread_id = ?
         AND status IN ('dispatching','running') LIMIT 1`,
      ),
    };
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
    /** §6 (r8): resolved on step 1; absent only on pre-r8 rows. */
    settingsProjectId?: string | null;
    /** §2 r10 п.0: realpath основного каталога репозитория. С ним
     * вставка атомарно отказывает, когда в ту же цель (repo_root +
     * target_branch) уже идёт auditing/publishing выкладка. */
    repoRoot?: string | null;
  }, t: T = T_RU): ReleaseRow {
    const now = Date.now();
    const insert = this.db.transaction((): ReleaseRow => {
      if (input.repoRoot) {
        const busy = this.db
          .prepare(
            `SELECT id, task_key FROM releases
             WHERE status IN ('auditing','publishing')
               AND target_branch = ? AND repo_root = ? LIMIT 1`,
          )
          .get(input.targetBranch, input.repoRoot) as
          | { id: number; task_key: string }
          | undefined;
        if (busy) {
          throw new OrchestratorError(
            "release-target-busy",
            t("store.busyTarget", {
              target: input.targetBranch,
              busyKey: busy.task_key,
            }),
          );
        }
      }
      const info = this.db
        .prepare(
          `INSERT INTO releases (
            task_key, project_id, coordinator_thread_id, repo_path, branch,
            target_action, target_branch, status, no_docs_reason, kb_note,
            no_kb_reason, settings_project_id, repo_root, created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'auditing', ?, ?, ?, ?, ?, ?, ?)`,
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
          input.settingsProjectId ?? null,
          input.repoRoot ?? null,
          now,
          now,
        );
      return this.getRelease(Number(info.lastInsertRowid))!;
    });
    return insert();
  }

  /** §2 r10 п.0: активные выкладки без записанного repo_root — строки
   * до r10; вызывающий вычисляет корень и дозаписывает, чтобы гейт одной
   * выкладки в цель их тоже видел. */
  releasesMissingRepoRoot(): ReleaseRow[] {
    return this.db
      .prepare(
        `SELECT * FROM releases
         WHERE status IN ('auditing','publishing') AND repo_root IS NULL
         ORDER BY id`,
      )
      .all() as ReleaseRow[];
  }

  setReleaseRepoRoot(id: number, repoRoot: string): void {
    this.db
      .prepare(`UPDATE releases SET repo_root = ? WHERE id = ?`)
      .run(repoRoot, id);
  }

  /** §2 r10 п.5: итоговая строка собрана — сохранить ДО отправки;
   * повтор такта только переотправляет этот текст. notified_at
   * сбрасывается: новая строка считается недоставленной. updated_at
   * НЕ двигаем — у отслеживаемых PR он остаётся моментом публикации
   * (база «72 ч» п.3). */
  setReleaseNotice(id: number, kind: string, text: string): void {
    this.db
      .prepare(
        `UPDATE releases SET notice_text = ?, notice_kind = ?,
           notified_at = NULL
         WHERE id = ?`,
      )
      .run(text, kind, id);
  }

  /** Итоговая строка + метка postPublish `finish` — одной транзакцией:
   * крах между записью строки и меткой оставил бы merging-запись без
   * признака «итог собран», и такт пересобрал бы дубль (PLUG-245 Б6). */
  setReleaseNoticeWithMeta(
    id: number,
    kind: string,
    text: string,
    metaKey: string,
    metaValue: string,
  ): void {
    this.db.transaction(() => {
      this.setReleaseNotice(id, kind, text);
      this.metaSet(metaKey, metaValue);
    })();
  }

  /** §2 r10 п.5: захват отправки — минус время захвата, протокол
   * claimResultDelivery (PLUG-190): захват старше 2 мин перехватывается
   * следующим тактом, лучше редкий дубль, чем потеря. Значение -1 от
   * кода до этой ревизии читается как давно устаревший захват.
   * updated_at не двигаем — он база «72 ч» п.3. */
  claimReleaseNotify(id: number): boolean {
    const now = Date.now();
    const staleAfter = -(now - 120_000);
    const info = this.db
      .prepare(
        `UPDATE releases SET notified_at = ?
         WHERE id = ? AND (
           notified_at IS NULL
           OR (notified_at < 0 AND notified_at >= ?)
         )`,
      )
      .run(-now, id, staleAfter);
    return info.changes > 0;
  }

  /** Доставка подтверждена — отметка и снятие сохранённой строки.
   * Условие на текст: если за время отправки записана СЛЕДУЮЩАЯ строка,
   * она не подтверждается и не стирается — её доставит досмотр. */
  confirmReleaseNotify(id: number, text: string): void {
    this.db
      .prepare(
        `UPDATE releases SET notified_at = ?,
           notice_text = NULL, notice_kind = NULL
         WHERE id = ? AND notice_text = ?`,
      )
      .run(Date.now(), id, text);
  }

  releaseReleaseNotify(id: number): void {
    this.db
      .prepare(
        `UPDATE releases SET notified_at = NULL
         WHERE id = ? AND notified_at < 0`,
      )
      .run(id);
  }

  /** §2 r10 п.5: записи с недоставленной итоговой строкой — досмотр
   * конвейера (включая устаревшие захваты). Сохранённая строка —
   * переотправка; published-запись БЕЗ строки — крах до её сохранения,
   * работа и текст собираются заново. */
  pendingReleaseNotices(): ReleaseRow[] {
    return this.db
      .prepare(
        `SELECT * FROM releases
         WHERE (
             notice_text IS NOT NULL OR status = 'published'
           ) AND (
             notified_at IS NULL
             OR (notified_at < 0 AND notified_at >= ?)
           )
         ORDER BY id`,
      )
      .all(-(Date.now() - 120_000)) as ReleaseRow[];
  }

  /** §2 r10 п.3: запись только что получила pr_url — начинаем следить.
   * Повторная инициализация (retry после сбоя) состояние не трогает. */
  initPrTracking(id: number): void {
    this.db
      .prepare(
        `UPDATE releases SET pr_state = 'open'
         WHERE id = ? AND pr_url IS NOT NULL AND pr_state IS NULL`,
      )
      .run(id);
  }

  /** §2 r10 п.3: записи выкладок, по которым идёт слежение за PR. */
  trackedPrReleases(): ReleaseRow[] {
    return this.db
      .prepare(
        `SELECT * FROM releases
         WHERE status = 'published' AND pr_url IS NOT NULL
           AND pr_state IN ('open','closed')
         ORDER BY id`,
      )
      .all() as ReleaseRow[];
  }

  /** §2 r10 п.3: одна запись на pr_url — трекинг ведёт новейшая. */
  latestReleaseByPrUrl(prUrl: string): ReleaseRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM releases WHERE pr_url = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(prUrl) as ReleaseRow | undefined;
  }

  /** Условный переход pr_state — охрана строк п.3: UPDATE не сработал,
   * значит строку уже отправил другой такт. updated_at НЕ двигаем —
   * он остаётся моментом публикации PR (база для 72-часового stale). */
  transitionPrState(
    id: number,
    from: readonly string[],
    to: string,
    fields?: {
      prCheckedAt?: number | null;
      prClosedAt?: number | null;
      prStaleNotified?: number | null;
      prErrorCount?: number;
    },
  ): boolean {
    return this.db.transaction(() => {
      const sets = ["pr_state = ?"];
      const args: unknown[] = [to];
      const map: Record<string, string> = {
        prCheckedAt: "pr_checked_at",
        prClosedAt: "pr_closed_at",
        prStaleNotified: "pr_stale_notified",
        prErrorCount: "pr_error_count",
      };
      for (const [key, col] of Object.entries(map)) {
        if (fields && key in fields) {
          sets.push(`${col} = ?`);
          args.push((fields as Record<string, unknown>)[key]);
        }
      }
      const marks = from.map(() => "?").join(",");
      const info = this.db
        .prepare(
          `UPDATE releases SET ${sets.join(", ")}
           WHERE id = ? AND pr_state IN (${marks})`,
        )
        .run(...args, id, ...from);
      if (info.changes === 0) return false;
      // §18.5: событие PR — в той же транзакции, что и переход.
      const row = this.getRelease(id);
      if (row) this.emitPrTransition(row, to, Date.now());
      return true;
    })();
  }

  /** §2 r10 п.3: «PR висит 72 ч» — флаг, не состояние: после строки
   * опрос продолжается молча до MERGED/CLOSED («дальше молча»).
   * Условный UPDATE — одна строка на все такты. */
  markPrStaleNotified(id: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE releases SET pr_stale_notified = 1
         WHERE id = ? AND pr_state = 'open' AND pr_stale_notified IS NULL`,
      )
      .run(id);
    return info.changes > 0;
  }

  /** Такт gh прошёл без смены состояния — отметка проверки и счётчик
   * ошибок (updated_at не двигаем: база 72 ч для п.3). */
  recordPrCheck(id: number, error: boolean, at = Date.now()): void {
    this.db
      .prepare(
        `UPDATE releases SET pr_checked_at = ?,
           pr_error_count = CASE WHEN ? THEN pr_error_count + 1 ELSE 0 END
         WHERE id = ?`,
      )
      .run(at, error ? 1 : 0, id);
  }

  /** §2 r10 п.3: старые записи с тем же pr_url слежение не ведут —
   * треком является новейшая. */
  supersedePrRows(prUrl: string, keepId: number): void {
    this.db
      .prepare(
        `UPDATE releases SET pr_state = 'superseded'
         WHERE pr_url = ? AND id != ?
           AND pr_state IN ('open','closed','stale','error')`,
      )
      .run(prUrl, keepId);
  }

  /** «PR обновлён» при досмотре: выложенная запись с тем же pr_url
   * была и раньше. */
  otherReleaseByPrUrl(prUrl: string, excludeId: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM releases
           WHERE pr_url = ? AND id != ? AND status = 'published' LIMIT 1`,
        )
        .get(prUrl, excludeId) !== undefined
    );
  }

  metaDelete(key: string): void {
    this.db.prepare(`DELETE FROM plugin_meta WHERE key = ?`).run(key);
  }

  /** §17 r31: напоминание ревьюеру без вердикта — время и seq журнала
   * на момент отправки (второй промах считается только по ходу,
   * начавшемуся позже). */
  setVerdictNudge(id: number, nudgeSeq: number): void {
    this.db
      .prepare(
        `UPDATE delegations SET verdict_nudged_at = ?,
           verdict_nudge_seq = ?, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), nudgeSeq, Date.now(), id);
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
      droppedUnmergedReason?: string | null;
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
      droppedUnmergedReason: "dropped_unmerged_reason",
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
    this.db.transaction(() => {
      // §18.5: терминальный статус через updateRelease (публикация в
      // release.ts идёт этим методом) — событие в той же транзакции,
      // но только при реальном переходе, не при повторной записи.
      const prev = this.getRelease(id);
      this.db
        .prepare(`UPDATE releases SET ${sets.join(", ")} WHERE id = ?`)
        .run(...args);
      if (fields.status && prev && prev.status !== fields.status) {
        const row = this.getRelease(id);
        if (row) this.emitReleaseTransition(row, fields.status, Date.now());
      }
    })();
  }

  /** Условный перевод статуса выкладки — тот же приём, что setStatusIf:
   * кто первый перевёл, тот и владеет строкой об исходе (r31: сторож
   * отклоняет «аудит без вердикта» до done делегирования, чтобы насос
   * не успел отклонить своей строкой). `notice` — итоговая строка п.5:
   * пишется в той же записи, что и переход, — между «статус конечный» и
   * «строка сохранена» окна нет. */
  transitionReleaseStatus(
    id: number,
    from: readonly ReleaseStatus[],
    to: ReleaseStatus,
    error?: string,
    notice?: { kind: string; text: string },
  ): boolean {
    return this.db.transaction(() => {
      const at = Date.now();
      const marks = from.map(() => "?").join(",");
      const sets = "status = ?, error = ?, updated_at = ?";
      const args: unknown[] = [to, error ?? null, at];
      const noticeSet = notice
        ? ", notice_text = ?, notice_kind = ?, notified_at = NULL"
        : "";
      if (notice) args.push(notice.text, notice.kind);
      const info = this.db
        .prepare(
          `UPDATE releases SET ${sets}${noticeSet}
           WHERE id = ? AND status IN (${marks})`,
        )
        .run(...args, id, ...from);
      if (info.changes === 0) return false;
      // §18.5: событие выкладки — в той же транзакции, что и переход.
      const row = this.getRelease(id);
      if (row) this.emitReleaseTransition(row, to, at);
      return true;
    })();
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

  /**
   * §15 (r33.7): «копия/тред → задача» индекс всех делегирований — для
   * `task-merged` в уборщике и автоочистки копий задачи. Одна выборка за
   * прогон вместо запроса на каждую среду.
   */
  delegationTaskIndex(): {
    taskKey: string;
    threadId: string | null;
    envId: string | null;
    branch: string | null;
    status: string;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT task_key, thread_id, result_env_id, result_branch, status
           FROM delegations
           WHERE result_env_id IS NOT NULL OR thread_id IS NOT NULL
              OR result_branch IS NOT NULL`,
        )
        .all() as {
        task_key: string;
        thread_id: string | null;
        result_env_id: string | null;
        result_branch: string | null;
        status: string;
      }[]
    ).map((r) => ({
      taskKey: r.task_key,
      threadId: r.thread_id,
      envId: r.result_env_id,
      branch: r.result_branch,
      status: r.status,
    }));
  }

  /**
   * §15 (r33.7): последний подтверждённый релиз каждой задачи — ключ к
   * признанию копии «влитой по задаче» (`task-merged`) и к автоочистке
   * после выкладки. Только `published` с подтверждённым коммитом на
   * origin/<цель>: `published_sha` для push, `pr_merge_sha` для PR
   * (после squash-merge вершина ветки PR не предок целевой — берётся
   * коммит влития).
   */
  publishedReleases(): {
    taskKey: string;
    publishedSha: string;
    targetBranch: string;
    repoPath: string;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT task_key, COALESCE(pr_merge_sha, published_sha) AS published_sha,
                target_branch, repo_path
         FROM releases
         WHERE status = 'published'
           AND COALESCE(pr_merge_sha, published_sha) IS NOT NULL
         ORDER BY id`,
      )
      .all() as {
      task_key: string;
      published_sha: string;
      target_branch: string;
      repo_path: string;
    }[];
    // ORDER BY id ASC — последняя запись задачи перезаписывает прежние.
    const byTask = new Map<
      string,
      { taskKey: string; publishedSha: string; targetBranch: string; repoPath: string }
    >();
    for (const r of rows) {
      byTask.set(r.task_key, {
        taskKey: r.task_key,
        publishedSha: r.published_sha,
        targetBranch: r.target_branch,
        repoPath: r.repo_path,
      });
    }
    return [...byTask.values()];
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

  /** §16.6 + §18.3: is this PR URL one the release pipeline itself
   * created FOR THIS TASK by THIS COORDINATOR? With `threadIds` off —
   * or a template/provider without a thread marker — our PRs carry no
   * «Источник»/`BB-Thread:` marker, so a repeat release may write only
   * into a PR this coordinator's release of this task recorded here —
   * a PR another coordinator's release created is still foreign
   * (PLUG-189). */
  prWasReleased(
    url: string,
    coordinatorThreadId: string,
    taskKey: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 AS x FROM releases
           WHERE pr_url = ? AND coordinator_thread_id = ?
             AND task_key = ? LIMIT 1`,
        )
        .get(url, coordinatorThreadId, normalizeTaskKey(taskKey)) !==
        undefined
    );
  }

  /** §18.3 (command без `find`): pr_url прошлой выкладки этой задачи
   * на ту же ветку публикации — кандидат на переиспользование, если
   * `view` отвечает OPEN. */
  lastPrUrl(taskKey: string, publishBranch: string): string | null {
    const row = this.db
      .prepare(
        `SELECT pr_url FROM releases
         WHERE task_key = ? AND pr_url IS NOT NULL
           AND COALESCE(publish_branch, branch) = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(normalizeTaskKey(taskKey), publishBranch) as
      | { pr_url: string }
      | undefined;
    return row?.pr_url ?? null;
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

  /** §17.3 (С4): the newest publish branch name recorded for the task —
   * any form (`release/<sha7>` or the executor's own while `threadIds`
   * was on); the caller decides which forms are reusable. */
  lastPublishBranch(taskKey: string): string | null {
    const row = this.db
      .prepare(
        `SELECT publish_branch FROM releases
         WHERE task_key = ? AND publish_branch IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(normalizeTaskKey(taskKey)) as
      | { publish_branch: string }
      | undefined;
    return row?.publish_branch ?? null;
  }

  /** §17.3 (Б4): all delegations the §14 merge recorded into this branch
   * — every task's of THIS project, not only the released one (ревью
   * PLUG-214: a row from another project with the same `merged_into`,
   * or a stale row whose merge commit is gone, must not block the
   * gate with «отсутствует в копии»). */
  mergedDelegationsInto(
    branch: string,
    projectId: string | null,
  ): DelegationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE merge_status = 'merged' AND merged_into = ?
           AND project_id IS ?`,
      )
      .all(branch, projectId) as DelegationRow[];
  }

  /**
   * §17.3 (С4): the commit the task's next round continues from — the
   * newest `published_sha` when it CONTAINS the latest round result
   * (the published tip carries the sync merge and the docs trailer, so
   * a repeat release fast-forwards the same remote branch), else the
   * latest recorded `result_sha`. Ancestry, not timestamps, decides —
   * `updated_at` moves on late writes (ревью PLUG-210 мелко).
   * `isAncestor(repoPath, a, b)` reports `git merge-base
   * --is-ancestor a b`; without it the old timestamp heuristic is the
   * degraded fallback.
   */
  async continuePoint(
    taskKey: string,
    isAncestor?: (
      repoPath: string,
      ancestor: string,
      descendant: string,
    ) => Promise<boolean>,
  ): Promise<string | null> {
    const key = normalizeTaskKey(taskKey);
    const result = this.latestResultByTask(key);
    const release = this.db
      .prepare(
        `SELECT published_sha, repo_path, updated_at FROM releases
         WHERE task_key = ? AND status = 'published'
           AND published_sha IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(key) as
      | { published_sha: string; repo_path: string; updated_at: number }
      | undefined;
    if (release && result?.result_sha && isAncestor) {
      const publishedCovers = await isAncestor(
        release.repo_path,
        result.result_sha,
        release.published_sha,
      ).catch(() => false);
      return publishedCovers ? release.published_sha : result.result_sha;
    }
    if (release && (!result?.result_sha || !isAncestor)) {
      if (!result?.result_sha) return release.published_sha;
      if (release.updated_at >= result.updated_at) {
        return release.published_sha;
      }
    }
    return result?.result_sha ?? null;
  }

  /** §17.3: SHAs the pipeline itself created on this run's branch —
   * unioned into the row so a retry's review gate ignores them. */
  addReleasePipelineShas(id: number, shas: readonly string[]): void {
    if (!shas.length) return;
    const row = this.getRelease(id);
    if (!row) return;
    let cur: string[] = [];
    try {
      const parsed = JSON.parse(row.pipeline_shas ?? "[]") as unknown;
      if (Array.isArray(parsed)) {
        cur = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch { /* corrupt value — replaced below */ }
    this.db
      .prepare(
        `UPDATE releases SET pipeline_shas = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify([...new Set([...cur, ...shas])]), Date.now(), id);
  }

  /** §17.3: every sha the pipeline ever created in this repo — the
   * review gate's exclusion set (any run, any status). */
  pipelineShasForRepo(repoPath: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT pipeline_shas FROM releases
         WHERE repo_path = ? AND pipeline_shas IS NOT NULL`,
      )
      .all(repoPath) as { pipeline_shas: string }[];
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.pipeline_shas) as unknown;
        if (Array.isArray(parsed)) {
          for (const x of parsed) {
            if (typeof x === "string") out.add(x);
          }
        }
      } catch { /* ignore corrupt row */ }
    }
    return out;
  }

  /** §17.3: tips this repo's releases already pushed — «опубликовано»
   * for the gate's range regardless of the remote branch they hit. */
  publishedShasForRepo(repoPath: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT published_sha FROM releases
           WHERE repo_path = ? AND status = 'published'
             AND published_sha IS NOT NULL`,
        )
        .all(repoPath) as { published_sha: string }[]
    ).map((r) => r.published_sha);
  }

  /** §17.3 (С4): the task's newest pushed tip — the fast-forward
   * baseline a repeat release continues from (the CURRENT row's
   * published_sha is still empty at publish time). */
  lastPublishedSha(taskKey: string): string | null {
    const row = this.db
      .prepare(
        `SELECT published_sha FROM releases
         WHERE task_key = ? AND status = 'published'
           AND published_sha IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(normalizeTaskKey(taskKey)) as
      | { published_sha: string }
      | undefined;
    return row?.published_sha ?? null;
  }

  /** §17.3: delegations of ANY task bound to a sha via `continue_from`
   * — the tip-review lookup (a review covering a merged branch tip may
   * live under a different task). Newest first. */
  delegationsByContinueFrom(sha: string): DelegationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delegations WHERE continue_from = ?
         ORDER BY id DESC`,
      )
      .all(sha) as DelegationRow[];
  }
  /* §18.5 (r32, PLUG-246): события. Запись в `events` и сопоставление
   * с действующими хуками идут в ТОЙ ЖЕ транзакции, что породивший
   * переход: для подходящего хука — запись command_runs `queued`
   * (run_key — `event:<id>:<имя>`). Позже событие хукам не
   * сопоставляется: добавленный/переименованный после события хук по
   * нему не запускается. */

  /**
   * §18.5 / §28.2: Запись событий задач и графа (task.alarm_triggered, task.blocked, etc.)
   */
  recordTaskEvent(
    kind: string,
    fields: Record<string, unknown>,
    at: number = Date.now(),
  ): number {
    return this.emitEvent(kind, fields, at);
  }

  private emitEvent(
    kind: string,
    fields: Record<string, unknown>,
    at: number,
  ): number {
    const doc: Record<string, unknown> = {
      version: 1,
      event: kind,
      at,
      ...fields,
    };
    const info = this.db
      .prepare(
        `INSERT INTO events (kind, payload, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(kind, JSON.stringify(doc), at);
    const eventId = Number(info.lastInsertRowid);
    const ctx = this.eventHooksProvider?.();
    if (!ctx?.hooks.length) return eventId;
    for (const h of ctx.hooks) {
      if (!h.on.includes(kind)) continue;
      if (
        h.projects !== undefined &&
        (typeof doc.project !== "string" ||
          !h.projects.includes(doc.project))
      ) {
        continue;
      }
      this.enqueueCommandRun(
        {
          source: "hook",
          runKey: `event:${eventId}:${h.name}`,
          name: h.name,
          argv: h.run,
          cwd: ctx.cwd,
          env: {
            ORCH_EVENT: kind,
            ORCH_TASK: String(doc.task ?? ""),
            ORCH_PROJECT:
              typeof doc.project === "string" ? doc.project : "",
          },
          stdin: JSON.stringify(doc),
          timeoutSec: h.timeoutSec ?? 120,
          notifyOnFail: h.notifyOnFail ?? false,
        },
        at,
      );
    }
    return eventId;
  }

  /** §18.5 таблица переходов: делегирование → событие. `cancelled`,
   * `reissued` и промежуточные статусы — внутренние, событий нет;
   * `release-audit` не порождает delegation.done — его исход это
   * события выкладки. */
  private emitDelegationTransition(
    row: DelegationRow,
    to: DelegationStatus,
    at: number,
    opts?: { reviewVerdict?: { verdict: string; blockers: number | null } },
  ): void {
    const base = {
      task: row.task_key,
      project: row.project_id,
      coordinatorThreadId: row.coordinator_thread_id,
      delegationId: row.id,
      level: row.level,
      route: row.route,
      threadId: row.thread_id,
    };
    if (to === "done") {
      if (row.level !== "release-audit") {
        this.emitEvent("delegation.done", base, at);
      }
      // review.verdict — делегирование ревью, ушедшее в done с
      // прочитанным вердиктом (r31); один раз на делегирование —
      // отметка verdict_event_at в той же транзакции (оживлённый тред
      // повторяет delegation.done, но не review.verdict).
      if (opts?.reviewVerdict) {
        const claimed =
          this.db
            .prepare(
              `UPDATE delegations SET verdict_event_at = ?
               WHERE id = ? AND verdict_event_at IS NULL`,
            )
            .run(at, row.id).changes > 0;
        if (claimed) {
          this.emitEvent(
            "review.verdict",
            {
              ...base,
              verdict: opts.reviewVerdict.verdict,
              blockers: opts.reviewVerdict.blockers,
            },
            at,
          );
        }
      }
      return;
    }
    if (to === "failed") {
      this.emitEvent("delegation.failed", base, at);
      return;
    }
    if (to === "stalled" || to === "quota") {
      this.emitEvent("delegation.stalled", { ...base, reason: to }, at);
    }
  }

  private emitReleaseEvent(
    kind: string,
    row: ReleaseRow,
    at: number,
  ): void {
    this.emitEvent(
      kind,
      {
        task: row.task_key,
        // §18.5: у событий выкладки и PR — проект настройки выкладки.
        project: row.settings_project_id ?? row.project_id,
        coordinatorThreadId: row.coordinator_thread_id,
        releaseId: row.id,
        sha: row.pr_merge_sha ?? row.published_sha ?? row.head_sha,
        branch: row.publish_branch ?? row.branch,
        target: row.target_branch,
        prUrl: row.pr_url,
      },
      at,
    );
  }

  /** Статус выкладки → событие (§18.5). auditing/publishing —
   * промежуточные, событий нет. */
  private emitReleaseTransition(
    row: ReleaseRow,
    to: ReleaseStatus,
    at: number,
  ): void {
    const kind =
      to === "published"
        ? "release.published"
        : to === "rejected"
          ? "release.rejected"
          : to === "failed"
            ? "release.failed"
            : null;
    if (kind) this.emitReleaseEvent(kind, row, at);
  }

  /** pr_state → событие (§18.5): только merged/closed — open, merging,
   * superseded, error, closed_final — внутренние. */
  private emitPrTransition(row: ReleaseRow, to: string, at: number): void {
    const kind =
      to === "merged" ? "pr.merged" : to === "closed" ? "pr.closed" : null;
    if (kind) this.emitReleaseEvent(kind, row, at);
  }

  /** §18.5: событие по id — для строк notifyOnFail и тестов. */
  eventById(id: number): EventRow | undefined {
    return this.db
      .prepare(`SELECT * FROM events WHERE id = ?`)
      .get(id) as EventRow | undefined;
  }

  /** События по порядку записи (опционально — одного вида). */
  listEvents(kind?: string): EventRow[] {
    return (kind
      ? this.db
          .prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`)
          .all(kind)
      : this.db.prepare(`SELECT * FROM events ORDER BY id`).all()) as
      EventRow[];
  }

  /** §18.5: срок хранения events тот же, что у command_runs
   * (retentionDays). */
  pruneEvents(cutoff: number): number {
    return this.db
      .prepare(`DELETE FROM events WHERE created_at < ?`)
      .run(cutoff).changes;
  }

  /* §18.2 (r32, PLUG-245): журнал команд. run_key уникален — повторная
   * постановка той же команды выкладки после рестарта не дублирует её
   * (INSERT ON CONFLICT DO NOTHING + чтение существующей). */

  enqueueCommandRun(spec: CommandRunSpec, at: number): CommandRunRow {
    this.db
      .prepare(
        `INSERT INTO command_runs (
          source, run_key, group_key, name, status, argv, cwd, env,
          stdin, timeout_sec, notify_on_fail, queued_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_key) DO NOTHING`,
      )
      .run(
        spec.source,
        spec.runKey,
        spec.groupKey ?? null,
        spec.name,
        JSON.stringify(spec.argv),
        spec.cwd,
        spec.env ? JSON.stringify(spec.env) : null,
        spec.stdin ?? null,
        spec.timeoutSec ?? null,
        spec.notifyOnFail ? 1 : 0,
        at,
      );
    return this.db
      .prepare(`SELECT * FROM command_runs WHERE run_key = ?`)
      .get(spec.runKey) as CommandRunRow;
  }

  /** Терминальный skipped: создаёт запись, если её не было; ждущую
   * очередь переводит в skipped; running и терминальные не трогает. */
  markCommandRunSkipped(
    spec: CommandRunSpec,
    reason: string,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO command_runs (
          source, run_key, group_key, name, status, argv, cwd, env,
          stdin, timeout_sec, notify_on_fail, queued_at, finished_at,
          output_tail
        ) VALUES (?, ?, ?, ?, 'skipped', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_key) DO UPDATE SET
          status = 'skipped',
          finished_at = excluded.finished_at,
          output_tail = excluded.output_tail
        WHERE command_runs.status = 'queued'`,
      )
      .run(
        spec.source,
        spec.runKey,
        spec.groupKey ?? null,
        spec.name,
        JSON.stringify(spec.argv),
        spec.cwd,
        spec.env ? JSON.stringify(spec.env) : null,
        spec.stdin ?? null,
        spec.timeoutSec ?? null,
        spec.notifyOnFail ? 1 : 0,
        at,
        at,
        reason,
      );
  }

  /** §18.5 (заход 5): queued → skipped по существующей записи журнала —
   * ранний выход postPublish не собирает спеку (команды может уже не
   * быть в настройке). */
  skipQueuedCommandRun(id: number, reason: string, at: number): void {
    this.db
      .prepare(
        `UPDATE command_runs
         SET status = 'skipped', finished_at = ?, output_tail = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(at, reason, id);
  }

  commandRunByKey(runKey: string): CommandRunRow | undefined {
    return this.db
      .prepare(`SELECT * FROM command_runs WHERE run_key = ?`)
      .get(runKey) as CommandRunRow | undefined;
  }

  commandRunsByGroup(groupKey: string): CommandRunRow[] {
    return this.db
      .prepare(`SELECT * FROM command_runs WHERE group_key = ? ORDER BY id`)
      .all(groupKey) as CommandRunRow[];
  }

  queuedCommandRuns(): CommandRunRow[] {
    return this.db
      .prepare(`SELECT * FROM command_runs WHERE status = 'queued' ORDER BY id`)
      .all() as CommandRunRow[];
  }

  runningCommandRuns(): CommandRunRow[] {
    return this.db
      .prepare(`SELECT * FROM command_runs WHERE status = 'running' ORDER BY id`)
      .all() as CommandRunRow[];
  }

  /** Охрана «запущена один раз» (§18.2): queued → running один раз. */
  claimCommandRun(id: number, at: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE command_runs SET status = 'running', started_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(at, id).changes > 0
    );
  }

  attachCommandProcess(
    id: number,
    pid: number | null,
    pgid: number | null,
    procStart: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE command_runs SET pid = ?, pgid = ?, proc_start = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(pid, pgid, procStart, id);
  }

  finishCommandRun(
    id: number,
    status: CommandRunStatus,
    exitCode: number | null,
    outputTail: string | null,
    at: number,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE command_runs
           SET status = ?, exit_code = ?, output_tail = ?, finished_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(status, exitCode, outputTail, at, id).changes > 0
    );
  }

  interruptCommandRun(id: number, at: number): boolean {
    return this.finishCommandRun(id, "interrupted", null, null, at);
  }

  /** §18.2: чистка журнала старше retentionDays. */
  pruneCommandRuns(cutoff: number): number {
    return this.db
      .prepare(
        `DELETE FROM command_runs
         WHERE finished_at IS NOT NULL AND finished_at < ?`,
      )
      .run(cutoff).changes;
  }

  /** §2 п.6 (r11): merge-коммит влитого PR. */
  setPrMergeSha(id: number, sha: string | null): void {
    this.db
      .prepare(`UPDATE releases SET pr_merge_sha = ? WHERE id = ?`)
      .run(sha, id);
  }

  releasesByPrState(state: string): ReleaseRow[] {
    return this.db
      .prepare(`SELECT * FROM releases WHERE pr_state = ? ORDER BY id`)
      .all(state) as ReleaseRow[];
  }

  /** §24.2 (r33.5): record a finished round's staged plugin work. The
   * task_key is the primary key — a re-run refreshes the row's sha,
   * branch, plugin and UI flags. When updating an existing row, ui_files
   * are unioned and ui_touched remains true if either old or new touched UI. */
  recordStagedFeature(feature: {
    taskKey: string;
    projectId?: string | null;
    pluginName: string;
    branchName?: string | null;
    resultSha: string;
    uiTouched: boolean;
    uiFiles: string[];
    status?: StagedFeatureStatus;
    droppedReason?: string | null;
  }): void {
    const now = Date.now();
    const key = normalizeTaskKey(feature.taskKey);
    const existing = this.stagedFeature(key);
    let uiTouched = feature.uiTouched;
    let uiFiles = [...feature.uiFiles];
    if (existing) {
      if (existing.ui_touched === 1) {
        uiTouched = true;
      }
      try {
        const oldFiles = JSON.parse(existing.ui_files || "[]");
        if (Array.isArray(oldFiles)) {
          const set = new Set([...oldFiles, ...uiFiles]);
          uiFiles = Array.from(set);
        }
      } catch {
        // malformed old json — keep new files
      }
    }
    if (uiFiles.length > 0) {
      uiTouched = true;
    }
    this.db
      .prepare(
        `INSERT INTO plugin_staged_features (
          task_key, project_id, plugin_name, branch_name, result_sha,
          ui_touched, ui_files, status, dropped_reason, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_key) DO UPDATE SET
          project_id = excluded.project_id,
          plugin_name = excluded.plugin_name,
          branch_name = excluded.branch_name,
          result_sha = excluded.result_sha,
          ui_touched = excluded.ui_touched,
          ui_files = excluded.ui_files,
          status = excluded.status,
          dropped_reason = excluded.dropped_reason,
          updated_at = excluded.updated_at`,
      )
      .run(
        key,
        feature.projectId ?? null,
        feature.pluginName,
        feature.branchName ?? null,
        feature.resultSha,
        uiTouched ? 1 : 0,
        JSON.stringify(uiFiles),
        feature.status ?? "in_review",
        feature.droppedReason ?? null,
        now,
        now,
      );
  }

  /** §24.2: staged features of one plugin — the release gate reads
   * `status = 'in_review'`; callers may ask for another status. */
  stagedFeaturesForPlugin(
    pluginName: string,
    status?: string,
  ): StagedFeatureRow[] {
    return status === undefined
      ? (this.db
          .prepare(
            `SELECT * FROM plugin_staged_features
             WHERE plugin_name = ? ORDER BY task_key`,
          )
          .all(pluginName) as StagedFeatureRow[])
      : (this.db
          .prepare(
            `SELECT * FROM plugin_staged_features
             WHERE plugin_name = ? AND status = ? ORDER BY task_key`,
          )
          .all(pluginName, status) as StagedFeatureRow[]);
  }

  /** §24.2: `--force-drop-unmerged <причина>` — незамерженные строки
   * уходят в `dropped` с причиной. */
  markStagedFeaturesDropped(taskKeys: string[], reason: string): void {
    if (!taskKeys.length) return;
    const now = Date.now();
    const marks = taskKeys.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE plugin_staged_features
         SET status = 'dropped', dropped_reason = ?, updated_at = ?
         WHERE task_key IN (${marks}) AND status = 'in_review'`,
      )
      .run(
        reason,
        now,
        ...taskKeys.map((k) => normalizeTaskKey(k)),
      );
  }

  /** §24.2: the §14 merge landed — the staged row stops guarding. */
  markStagedFeatureMerged(taskKey: string): void {
    this.db
      .prepare(
        `UPDATE plugin_staged_features
         SET status = 'merged', updated_at = ? WHERE task_key = ?`,
      )
      .run(Date.now(), normalizeTaskKey(taskKey));
  }

  stagedFeature(taskKey: string): StagedFeatureRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM plugin_staged_features WHERE task_key = ?`,
        )
        .get(normalizeTaskKey(taskKey)) as StagedFeatureRow | undefined) ??
      null
    );
  }

  // ── §27.1 / §28.1 / §32 (r34, PLUG-309): task_queue and task_transitions ───

  getTask(taskKey: string): TaskQueueRow | null {
    const row = this.db
      .prepare(`SELECT * FROM task_queue WHERE task_key = ?`)
      .get(normalizeTaskKey(taskKey)) as TaskQueueRow | undefined;
    return row ?? null;
  }

  insertTask(
    input: {
      taskKey: string;
      projectId: string;
      coordinatorThreadId: string;
      route: TaskRoute;
      level: TaskLevel;
      priority?: number;
      dependsOn?: string[] | null;
      confirmationMode?: ConfirmationMode;
      branch?: string | null;
      releaseNote?: string | null;
      payload?: string | null;
      actor?: string;
    },
    now: number = Date.now(),
  ): TaskQueueRow {
    return this.db.transaction(() => {
      const key = normalizeTaskKey(input.taskKey);
      const priority = input.priority ?? 100;
      const confirmationMode = input.confirmationMode ?? "manual";
      const dependsOn =
        input.dependsOn && input.dependsOn.length > 0
          ? JSON.stringify(input.dependsOn.map(normalizeTaskKey))
          : null;

      this.db
        .prepare(
          `INSERT INTO task_queue (
            task_key, project_id, coordinator_thread_id, route, level,
            node, status, priority, depends_on, confirmation_mode, branch,
            release_note, payload, entered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'start', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          input.projectId,
          input.coordinatorThreadId,
          input.route,
          input.level,
          priority,
          dependsOn,
          confirmationMode,
          input.branch ?? null,
          input.releaseNote ?? null,
          input.payload ?? null,
          now,
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO task_transitions (
            task_key, from_node, to_node, from_status, to_status, actor, reason, payload, created_at
          ) VALUES (?, 'start', 'start', 'queued', 'queued', ?, 'enqueue', ?, ?)`,
        )
        .run(
          key,
          input.actor ?? "coordinator",
          input.payload ?? null,
          now,
        );

      return this.getTask(key)!;
    })();
  }

  resetTaskForEnqueue(
    input: {
      taskKey: string;
      projectId?: string;
      coordinatorThreadId?: string;
      route: TaskRoute;
      level: TaskLevel;
      priority?: number;
      dependsOn?: string[] | null;
      confirmationMode?: ConfirmationMode;
      branch?: string | null;
      releaseNote?: string | null;
      payload?: string | null;
      actor?: string;
    },
    now: number = Date.now(),
  ): TaskQueueRow {
    return this.db.transaction(() => {
      const key = normalizeTaskKey(input.taskKey);
      const existing = this.getTask(key);
      if (!existing) {
        throw new OrchestratorError("task-not-found", `task ${key} not found`);
      }
      const priority = input.priority ?? 100;
      const confirmationMode = input.confirmationMode ?? "manual";
      const dependsOn =
        input.dependsOn && input.dependsOn.length > 0
          ? JSON.stringify(input.dependsOn.map(normalizeTaskKey))
          : null;
      const branch = input.branch !== undefined ? input.branch : existing.branch;

      this.db
        .prepare(
          `UPDATE task_queue SET
            route = ?, level = ?, priority = ?, depends_on = ?, confirmation_mode = ?,
            branch = ?, release_note = ?, payload = ?,
            node = 'start', status = 'queued',
            spec_sha = NULL, acceptance_sha = NULL, result_sha = NULL, interaction_id = NULL,
            spec_attempts = 0, spec_review_rounds = 0, code_attempts = 0, check_attempts = 0,
            code_review_rounds = 0, design_check_rounds = 0, release_attempts = 0,
            deadline_at = NULL, node_alarm_at = NULL, deferred_by = NULL, deferred_reason = NULL,
            entered_at = ?, created_at = ?, updated_at = ?
          WHERE task_key = ?`,
        )
        .run(
          input.route,
          input.level,
          priority,
          dependsOn,
          confirmationMode,
          branch,
          input.releaseNote ?? null,
          input.payload ?? null,
          now,
          now,
          now,
          key,
        );

      this.db
        .prepare(
          `INSERT INTO task_transitions (
            task_key, from_node, to_node, from_status, to_status, actor, reason, payload, created_at
          ) VALUES (?, ?, 'start', ?, 'queued', ?, 'enqueue', ?, ?)`,
        )
        .run(
          key,
          existing.node,
          existing.status,
          input.actor ?? "coordinator",
          input.payload ?? null,
          now,
        );

      return this.getTask(key)!;
    })();
  }

  updateTask(
    taskKey: string,
    updates: Partial<TaskQueueRow>,
    now: number = Date.now(),
  ): void {
    const key = normalizeTaskKey(taskKey);
    const setClauses: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];
    for (const [k, v] of Object.entries(updates)) {
      if (k !== "task_key" && k !== "updated_at" && v !== undefined) {
        setClauses.push(`${k} = ?`);
        values.push(v);
      }
    }
    values.push(key);
    this.db
      .prepare(`UPDATE task_queue SET ${setClauses.join(", ")} WHERE task_key = ?`)
      .run(...values);
  }

  transitionTask(
    input: TransitionTaskInput,
    now: number = Date.now(),
  ): TransitionTaskResult {
    return this.db.transaction(() => {
      const key = normalizeTaskKey(input.taskKey);
      const existing = this.getTask(key);
      if (!existing) {
        return { ok: false, conflict: true };
      }
      if (
        existing.node !== input.expectedNode ||
        existing.status !== input.expectedStatus
      ) {
        return { ok: false, conflict: true, task: existing };
      }

      const setClauses: string[] = [
        "node = :toNode",
        "status = :toStatus",
        "updated_at = :now",
      ];
      const params: Record<string, unknown> = {
        taskKey: key,
        expectedNode: input.expectedNode,
        expectedStatus: input.expectedStatus,
        toNode: input.toNode,
        toStatus: input.toStatus,
        now,
      };

      if (
        input.updates?.entered_at === undefined &&
        (input.toNode !== input.expectedNode ||
          input.expectedStatus === "stalled" ||
          input.expectedStatus === "blocked")
      ) {
        setClauses.push("entered_at = :now");
      }

      // §28.2 п. 5: Будильник узла (node_alarm_at)
      if (input.updates?.node_alarm_at === undefined) {
        if (ACTIVE_ALARM_NODES.has(input.toNode) && input.toStatus === "running") {
          if (input.toNode !== existing.node || existing.status !== "running") {
            const timeoutSec = input.timeoutSeconds ?? 3600;
            setClauses.push("node_alarm_at = :auto_node_alarm_at");
            params.auto_node_alarm_at = now + timeoutSec * 1000;
          }
        } else if (
          !ACTIVE_ALARM_NODES.has(input.toNode) ||
          PASSIVE_ALARM_STATUSES.has(input.toStatus)
        ) {
          setClauses.push("node_alarm_at = NULL");
        }
      }

      if (input.updates) {
        for (const [k, v] of Object.entries(input.updates)) {
          if (v !== undefined) {
            setClauses.push(`${k} = :${k}`);
            params[k] = v;
          }
        }
      }

      const info = this.db
        .prepare(
          `UPDATE task_queue SET ${setClauses.join(", ")}
           WHERE task_key = :taskKey AND node = :expectedNode AND status = :expectedStatus`,
        )
        .run(params);

      if (info.changes === 0) {
        return {
          ok: false,
          conflict: true,
          task: this.getTask(key) ?? undefined,
        };
      }

      const transInfo = this.db
        .prepare(
          `INSERT INTO task_transitions (
            task_key, from_node, to_node, from_status, to_status, actor, reason, payload, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          input.expectedNode,
          input.toNode,
          input.expectedStatus,
          input.toStatus,
          input.actor,
          input.reason,
          input.transitionPayload ?? null,
          now,
        );

      const updated = this.getTask(key)!;
      return {
        ok: true,
        task: updated,
        transitionId: Number(transInfo.lastInsertRowid),
      };
    })();
  }

  listQueuedTasks(): TaskQueueRow[] {
    return this.db
      .prepare(
        `SELECT * FROM task_queue WHERE status = 'queued' ORDER BY priority DESC, created_at ASC`,
      )
      .all() as TaskQueueRow[];
  }

  listActiveTasks(): TaskQueueRow[] {
    return this.db
      .prepare(
        `SELECT * FROM task_queue WHERE status = 'running' ORDER BY priority DESC, created_at ASC`,
      )
      .all() as TaskQueueRow[];
  }

  listAllTasks(): TaskQueueRow[] {
    return this.db
      .prepare(
        `SELECT * FROM task_queue ORDER BY priority DESC, created_at ASC`,
      )
      .all() as TaskQueueRow[];
  }

  listTransitions(taskKey: string): TaskTransitionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM task_transitions WHERE task_key = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(normalizeTaskKey(taskKey)) as TaskTransitionRow[];
  }

  insertTransition(input: {
    taskKey: string;
    fromNode: string;
    toNode: string;
    fromStatus: string;
    toStatus: string;
    actor: string;
    reason: string;
    payload?: string | null;
    createdAt?: number;
  }): void {
    const key = normalizeTaskKey(input.taskKey);
    this.db
      .prepare(
        `INSERT INTO task_transitions (
          task_key, from_node, to_node, from_status, to_status, actor, reason, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        input.fromNode,
        input.toNode,
        input.fromStatus,
        input.toStatus,
        input.actor,
        input.reason,
        input.payload ?? null,
        input.createdAt ?? Date.now(),
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
  /** §17.4 (PLUG-218): tip of the removed branch (copies: own-branch
   * tip, else HEAD) — restore with `git branch <name> <sha>`. */
  tip_sha: string | null;
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

/** §16.4 r29 (PLUG-240): one rescue snapshot attempt — success rows
 * carry the ref, failures carry `error` and no ref. */
export interface JanitorRescueRow {
  id: number;
  thread_id: string;
  ref: string | null;
  repo_root: string | null;
  reason: string;
  notified: number;
  error: string | null;
  created_at: number;
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
      /** §17.4 (PLUG-218/220): stamped by the pre-delete «removing»
       * write and confirmed by «removed»; a later
       * «ветки больше нет» write never erases it (`fields ?? prev`). */
      tipSha?: string | null;
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
      tip_sha: fields.tipSha ?? prev?.tip_sha ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO janitor_items (
          env_id, project_id, thread_id, path, branch, state, reason,
          size_kb, first_seen_at, last_checked_at, removed_at, tip_sha
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          removed_at = excluded.removed_at,
          tip_sha = excluded.tip_sha`,
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
        next.tip_sha,
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

  /** §16.4 r29: append one rescue attempt to the ledger. */
  addRescue(
    r: {
      threadId: string;
      ref: string | null;
      repoRoot: string | null;
      reason: string;
      notified: boolean;
      error?: string | null;
    },
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO janitor_rescues (
          thread_id, ref, repo_root, reason, notified, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.threadId,
        r.ref,
        r.repoRoot,
        r.reason,
        r.notified ? 1 : 0,
        r.error ?? null,
        at,
      );
  }

  rescues(): JanitorRescueRow[] {
    return this.db
      .prepare(`SELECT * FROM janitor_rescues ORDER BY id`)
      .all() as JanitorRescueRow[];
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
