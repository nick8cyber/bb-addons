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
  // a database that predates r23: every migration but the last
  for (const m of MIGRATIONS.slice(0, -1)) db.exec(m);
  db.prepare(
    `INSERT INTO delegations (
      task_key, coordinator_thread_id, level, route, preset, provider,
      status, created_at, updated_at
    ) VALUES ('PLUG-0', 'thr_c', 'simple', 'simple', 'simple', 'p', 'done', 1, 1)`,
  ).run();
  db.exec(MIGRATIONS[MIGRATIONS.length - 1]!);
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
