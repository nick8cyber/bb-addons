import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";

test("migrations create the §7 schema", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);

  const columns = (db
    .prepare(`PRAGMA table_info(delegations)`)
    .all() as { name: string }[]).map((c) => c.name);
  for (const col of [
    "id",
    "task_key",
    "task_id",
    "project_id",
    "coordinator_thread_id",
    "thread_id",
    "level",
    "route",
    "preset",
    "provider",
    "status",
    "reissue_of",
    "turn_started_at",
    "first_response_at",
    "last_seq",
    "setup_errors",
    "last_approval_notified_at",
    "timeout_notified_at",
    "no_code",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(columns.includes(col), `missing column ${col}`);
  }

  const holdColumns = (db
    .prepare(`PRAGMA table_info(route_holds)`)
    .all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(holdColumns.sort(), ["quota_group", "reason", "until"]);

  const itemColumns = (db
    .prepare(`PRAGMA table_info(janitor_items)`)
    .all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(itemColumns.sort(), [
    "branch",
    "env_id",
    "first_seen_at",
    "last_checked_at",
    "path",
    "project_id",
    "reason",
    "removed_at",
    "size_kb",
    "state",
    "thread_id",
    "tip_sha",
  ]);

  const runColumns = (db
    .prepare(`PRAGMA table_info(janitor_runs)`)
    .all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(runColumns.sort(), [
    "error",
    "finished_at",
    "freed_kb",
    "id",
    "kept",
    "removed",
    "started_at",
  ]);
});

test("the partial unique index allows one active row per task", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const input = {
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_c",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "p",
  };
  const row = store.insert(input);
  assert.throws(() => store.insert(input), /UNIQUE/);
  // A finished row frees the key; a second active one is refused.
  store.setStatus(row.id, "done");
  store.insert(input);
  assert.throws(() => store.insert(input), /UNIQUE/);
});

test("hasFreshDispatching scopes by project, owner, thread_id, and age", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const now = Date.now();
  const fresh = now - 60_000;
  const stale = now - 3 * 60_000;

  const insert = (opts: {
    projectId?: string;
    coordinator?: string;
    threadId?: string;
    createdAt?: number;
  }) => {
    const row = store.insert({
      taskKey: `T-${Math.random().toString(36).slice(2, 8)}`,
      projectId: opts.projectId,
      coordinatorThreadId: opts.coordinator ?? "thr_other",
      level: "simple",
      route: "r",
      preset: "p",
      provider: "p",
    });
    if (opts.threadId) store.setThreadInfo(row.id, opts.threadId);
    if (opts.createdAt) {
      db.prepare(`UPDATE delegations SET created_at = ? WHERE id = ?`).run(
        opts.createdAt,
        row.id,
      );
    }
    return row;
  };
  const probe = (projectId: string, threadId = "thr_candidate") =>
    store.hasFreshDispatching(now - 2 * 60_000, {
      projectId,
      excludingThreadId: threadId,
    });

  // same project, another coordinator's dispatch → executor marker
  insert({ projectId: "proj_a", createdAt: fresh });
  assert.equal(probe("proj_a"), true);
  // different project → not an executor marker
  assert.equal(probe("proj_b"), false);
  // a fresh dispatch this thread itself created → still a coordinator
  insert({ projectId: "proj_c", coordinator: "thr_candidate", createdAt: fresh });
  assert.equal(probe("proj_c"), false);
  // stale dispatching (>2 min) → no marker
  assert.equal(probe("proj_d"), false);
  insert({ projectId: "proj_d", createdAt: stale });
  assert.equal(probe("proj_d"), false);
  // linked thread_id → window closed
  insert({ projectId: "proj_e", createdAt: fresh, threadId: "thr_exec" });
  assert.equal(probe("proj_e"), false);
  // a row without project_id never matches a project scope
  insert({ createdAt: fresh });
  assert.equal(probe("proj_f"), false);
});

test("the r23 migration adds round/result/merge columns to an existing db", () => {
  const db = new Database(":memory:");
  // a database that predates r23: every migration before the multi-
  // column delegations ALTER (it is no longer the last statement —
  // later revisions append more migrations after it).
  const r23 = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN round"));
  assert.ok(r23 > 0, "r23 migration found");
  for (const m of MIGRATIONS.slice(0, r23)) db.exec(m);
  db.prepare(
    `INSERT INTO delegations (
      task_key, coordinator_thread_id, level, route, preset, provider,
      status, created_at, updated_at
    ) VALUES ('PLUG-0', 'thr_c', 'simple', 'simple', 'simple', 'p', 'done', 1, 1)`,
  ).run();
  db.exec(MIGRATIONS[r23]!);
  const columns = (db
    .prepare(`PRAGMA table_info(delegations)`)
    .all() as { name: string }[]).map((c) => c.name);
  for (const col of [
    "round",
    "continue_from",
    "result_branch",
    "result_sha",
    "result_commits",
    "result_dirty",
    "result_env_id",
    "merge_status",
    "merged_into",
    "merged_sha",
    "merged_at",
  ]) {
    assert.ok(columns.includes(col), `missing column ${col}`);
  }
  const row = db
    .prepare(`SELECT round, continue_from FROM delegations WHERE task_key = 'PLUG-0'`)
    .get() as { round: number; continue_from: string | null };
  assert.equal(row.round, 1);
  assert.equal(row.continue_from, null);
});

test("the r28 migration adds no_code to an existing db, defaulting 0", () => {
  const db = new Database(":memory:");
  const r28 = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN no_code"));
  assert.ok(r28 > 0, "r28 migration found");
  // §16.4 r29 (PLUG-240): the rescue ledger is appended after r28.
  assert.equal(r28, MIGRATIONS.length - 2, "r28 precedes the r29 rescue ledger");
  assert.match(
    MIGRATIONS.at(-1)!,
    /janitor_rescues/,
    "the r29 rescue ledger is the last migration",
  );
  for (const m of MIGRATIONS.slice(0, r28)) db.exec(m);
  db.prepare(
    `INSERT INTO delegations (
      task_key, coordinator_thread_id, level, route, preset, provider,
      status, created_at, updated_at
    ) VALUES ('PLUG-0', 'thr_c', 'simple', 'simple', 'simple', 'p', 'done', 1, 1)`,
  ).run();
  db.exec(MIGRATIONS[r28]!);
  const columns = (db
    .prepare(`PRAGMA table_info(delegations)`)
    .all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("no_code"), "missing column no_code");
  const row = db
    .prepare(`SELECT no_code FROM delegations WHERE task_key = 'PLUG-0'`)
    .get() as { no_code: number };
  assert.equal(row.no_code, 0, "existing rows are ordinary dispatches");
});

test("the r24/25 migrations apply on a base that recorded main's 0–15", async () => {
  // The live plugin DB recorded main's MIGRATIONS[0..15] — #14 is
  // `explicit_route`, #15 is `publish_branch` (§16.6, PLUG-191). The
  // §16.5 columns and the legacy UPDATE are #16/#17 and must come AFTER,
  // or the SDK's statement-hash check aborts the plugin at startup
  // (PLUG-190, re-checked PLUG-196).
  const { createHash } = await import("node:crypto");
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  assert.match(MIGRATIONS[14]!, /explicit_route/, "migration 14 is main's explicit_route");
  assert.match(MIGRATIONS[15]!, /publish_branch/, "migration 15 is main's publish_branch");
  assert.match(MIGRATIONS[16]!, /result_notified_at/, "the §16.5 columns come after");
  assert.match(MIGRATIONS[17]!, /result_notice = 'legacy'/, "the legacy UPDATE is last");

  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE _bb_migrations (
      id INTEGER PRIMARY KEY, applied_at INTEGER, statement_hash TEXT
    )`,
  );
  // Verbatim SDK runPluginStorageMigrations (0.4.87): recorded hashes
  // must match, unrecorded statements apply in order.
  const migrate = (statements: string[]) => {
    const rows = db
      .prepare(`SELECT id, statement_hash FROM _bb_migrations ORDER BY id`)
      .all() as { id: number; statement_hash: string | null }[];
    const applied = new Map(rows.map((r) => [r.id, r.statement_hash]));
    statements.map(hash).forEach((sh, i) => {
      const rec = applied.get(i);
      if (rec != null && rec !== sh) {
        throw new Error(`migration ${i} does not match the recorded statement`);
      }
    });
    db.transaction(() => {
      statements.forEach((s, i) => {
        if (applied.has(i)) return;
        db.exec(s);
        db.prepare(
          `INSERT INTO _bb_migrations (id, applied_at, statement_hash)
           VALUES (?,?,?)`,
        ).run(i, Date.now(), hash(s));
      });
    })();
  };
  // The base recorded main's list — our 0–15 are byte-identical to it.
  migrate(MIGRATIONS.slice(0, 16));
  db.prepare(
    `INSERT INTO delegations (
      task_key, coordinator_thread_id, level, route, preset, provider,
      status, created_at, updated_at
    ) VALUES ('PLUG-0', 'thr_c', 'simple', 'simple', 'simple', 'p', 'done', 1, 1),
             ('PLUG-1', 'thr_c', 'simple', 'simple', 'simple', 'p', 'failed', 1, 1),
             ('PLUG-2', 'thr_c', 'simple', 'simple', 'simple', 'p', 'running', 1, 1)`,
  ).run();
  migrate([...MIGRATIONS]); // must not throw "does not match"
  const recorded = db
    .prepare(`SELECT count(*) n FROM _bb_migrations`)
    .get() as { n: number };
  assert.equal(recorded.n, MIGRATIONS.length);
  // PLUG-193 #4: EVERY row terminal at the migration is marked — the
  // `legacy` notice doubles as the last_seq-sync scope.
  const notices = db
    .prepare(`SELECT task_key, result_notice FROM delegations ORDER BY task_key`)
    .all() as { task_key: string; result_notice: string | null }[];
  assert.deepEqual(notices, [
    { task_key: "PLUG-0", result_notice: "legacy" },
    { task_key: "PLUG-1", result_notice: "legacy" },
    { task_key: "PLUG-2", result_notice: null },
  ]);
});
