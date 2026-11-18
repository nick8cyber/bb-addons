import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

  // §27.1 (r34, PLUG-309): task_queue and task_transitions columns
  const taskQueueColumns = (db
    .prepare(`PRAGMA table_info(task_queue)`)
    .all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(taskQueueColumns.sort(), [
    "acceptance_sha",
    "branch",
    "check_attempts",
    "code_attempts",
    "code_review_rounds",
    "confirmation_mode",
    "coordinator_thread_id",
    "created_at",
    "deadline_at",
    "deferred_by",
    "deferred_reason",
    "depends_on",
    "design_check_rounds",
    "entered_at",
    "interaction_id",
    "level",
    "node",
    "node_alarm_at",
    "payload",
    "priority",
    "project_id",
    "release_attempts",
    "release_note",
    "result_sha",
    "route",
    "spec_attempts",
    "spec_review_rounds",
    "spec_sha",
    "status",
    "task_key",
    "updated_at",
  ]);

  const taskTransitionsColumns = (db
    .prepare(`PRAGMA table_info(task_transitions)`)
    .all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(taskTransitionsColumns.sort(), [
    "actor",
    "created_at",
    "from_node",
    "from_status",
    "id",
    "payload",
    "reason",
    "task_key",
    "to_node",
    "to_status",
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
  // §16.4 r29 (PLUG-240): the rescue ledger is appended right after
  // r28 (later revisions append their own migrations after both).
  assert.match(
    MIGRATIONS[r28 + 1]!,
    /janitor_rescues/,
    "the r29 rescue ledger follows r28",
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

/**
 * Pinned SHA-256 hashes of MIGRATIONS[0..54] (PLUG-283).
 *
 * `bb.storage.migrate` records statements by their sequential index and
 * checks their hash at startup. Shifting existing statements (or inserting
 * statements anywhere before the tail) breaks existing production databases
 * with `migration N does not match the recorded statement`.
 *
 * Migration 52 is `thread_roles_owner`, 53 is `queued_at`, 54 is `attach`.
 * Future migrations MUST only be appended to the end of MIGRATIONS.
 */
const EXPECTED_MIGRATION_HASHES_0_54: readonly string[] = [
  "10eefa3baf0eff5b1a0630500b1ca838380769fa0b89afb2e9d4342cffbb0a94", // 0: delegations
  "04ec499513aa3b5d24ebbdff3eca3909b5c9dcd910678d93d7137715a3c46c67", // 1: delegations_active_task_idx
  "cc316bc02450b233bf7c14582b9e894990f5f6de308fd36e8ddacecfafc1c86e", // 2: delegations_thread_idx
  "4917899ae5e0c1609aad444c56cbd39dc35c462de8044e05420e4d298e4ad744", // 3: delegations_coordinator_idx
  "0fb32b37859532360d207648e4530506eb8c744b213dc53b158c404e964fb9c9", // 4: route_holds
  "aaa8688da58142c5122fc50754fcd589918b2173f78a53a3915ace3d77de8fa0", // 5: project_id
  "0909b1d2b913e3b71e9ee5b073368fc03095ce4c29177c00168b1cfe45f05b58", // 6: resume_count
  "2a14de7aefaba3ae9b6038b05db82d38f03887ee5f01aaf26717322ee0084a2b", // 7: retry_count
  "dac08e5d20d8237840b8594265ea63ffdd0e11965b0669a93de092b7ce0de32d", // 8: pending_roles
  "64fbd979a0bc4284d248a334c26a74b4131a2e72c0f9b3b39564bc4725256746", // 9: thread_roles
  "6d760709a58637bcaeba31d7e86365920f98eefa816d7c5951be3e7385c0a3ed", // 10: releases
  "d6745a07548ffdbf4d9a403696d78861de0771365f91c66625e8cfcd0c11dfe9", // 11: releases_active_task_idx
  "dc01d7bc518cde13d5240a3552eea661e44bdd6956b02760d4ed327a59d60460", // 12: releases_task_idx
  "850eaf13258e637b5facb8688dd34c0f15c795a57b342238e825080938756ae4", // 13: delegations round
  "ff5b54f60d863708b5ef3e289bb544141251e0d76fbeeb1c5d9f0d99e79d68d6", // 14: delegations explicit_route
  "db8df86c48925e8caf8e2bee3de2abb8d9deb23bbfe225af24dec40246a151f5", // 15: releases publish_branch
  "adcf395d25b6a75cc548c5e7395703b3769e0114f427f4acfb228d1bdc711686", // 16: delegations result_notified_at
  "bda35d06c52895542e9509656a2a5dc18496564f96744a8367a9424a3048b2d4", // 17: delegations result_notified_at UPDATE
  "7ee35064399f8df9b32b283ac48b4543d9f001b268e286a105a5819c6e0679b4", // 18: janitor_items
  "15f2f4c9282baa4562e508299c4affd20649c6fcc4441c9a8d5c09a16903402d", // 19: releases pipeline_shas
  "ec249522c7201ecfde4a36421ce4e006dc91e9930415979df98d98659e2e34b0", // 20: janitor_items tip_sha
  "b4ca49dd9436996e9f9f98077b3a26d9841cecd1427280188a3d2457780ada6e", // 21: releases settings_project_id
  "e2d6f4a41a45c7a1f95f1c4b61799836fb9cf1d6de08bf369a9c7d1dc9771630", // 22: delegations no_code
  "67c2df9e79e7971789a2c3d953b3e1d026e1fce7983a369b4cbfab07c855ea36", // 23: janitor_rescues
  "42d5bc4bc02e4d40f055961c04a1f01f6065e94b9df2a4105aa85b16e15b6b31", // 24: releases notified_at
  "0a2ed5096b77e87e678cde71d9e4b7af8e3671ea3fcfc2232e29e46523ea66d7", // 25: releases repo_root
  "ea291e7446ba07565b1f1d6a8c2f8a790d3fa15803ee9a3cc02aff87fd6d7c6b", // 26: releases pr_state
  "d7ec7f9b056d6490d0c9939918bc7bdbb1d18da8423c3b7278a1c526253887a5", // 27: releases pr_checked_at
  "60df4e20bbf4067ec2a2df1abe994161b363089d3a59307f002f5c7da1ffe13e", // 28: releases pr_closed_at
  "c56c173f2b9448c90f3358a9a6647ca4f860533e4e0c7afaef1f070e4794ab0a", // 29: releases pr_stale_notified
  "b32ee5e42228b383e793dd89341075b96a422c5403887c113ecfecb3062160b3", // 30: releases pr_error_count
  "edb64b6bfc970aaafa78db0d7304c8c42c543de37787a0513d7013da2fff8893", // 31: delegations verdict_nudged_at
  "f0c9672b46c9695c711a1ef5f0cfa43539e72d2262f28562536a716bd8957a11", // 32: delegations verdict_nudge_seq
  "133923ac3c62dab48c27e50f65d4e208397ce157d45bf75b250d7ba88cad0c7f", // 33: releases notified_at UPDATE
  "430b66d6fe1af0051a2746aa8862c77f39020c9a2d2492e435c06e599957eeb1", // 34: releases pr_state UPDATE
  "c4ef801b459772c6909b59e156548c2875c58806fea825b1f9e7e862ca0284dd", // 35: releases notice_text
  "a5ecac82f903382cb7552b491bedbe080b5b821179617773780bb0d52651ff3f", // 36: releases notice_kind
  "74f539b51f85a27ca92a5cefaf2ba2db9cac996616d17690205206ef96c219ae", // 37: command_runs
  "3e57a121a236b2c4c8bc3214fbe6a2af7de2786b66aba6560cbf00f8aab73aa8", // 38: command_runs_status
  "083502331e894a0bbf2cbe9ae63fd73de456877f5f9a04a7e0f542e8c544fb37", // 39: command_runs_group
  "25b664d4a18ec9ae83520969915aabb61aa6584f774aee715a860510434fe149", // 40: releases pr_merge_sha
  "0ead389cef034fabbf71a4dcd8a71a8c97d678572b5ec75dc4e536a2852ff8bb", // 41: events
  "ba43965f6a1929e45f6269b214f68d3f44939d7a5d6689eeee87715754a03e7b", // 42: delegations verdict_event_at
  "8ba7403654be41b56c94b56b8a24d6ea0ecf739a78587934402883d1722f6b2d", // 43: command_runs notify_on_fail
  "2f5495ac30eee7a497f28438ae48c73439e32aabfcc7d93d9ea4bcc55efe4fa4", // 44: helpers
  "ee11e72cb8a455e06e151a19428705a60d4edca1bb2511b64fe10d36dbb102e2", // 45: helpers_thread_idx
  "dceeb2299abdf1a980f7ead1ad74e585c433023cb94eaa1fe462ea61ddc7ecb5", // 46: helpers_caller_idx
  "7e67bbaf2b9e279c99c978fef90cfa44f9c4649bdd520d4f4d162d29b4054490", // 47: helpers_delegation_idx
  "b370c36e89447775571bc5fa9827824938dcf46c4c35bcd4f060edd6692b4ac0", // 48: thread_facts
  "fa7fe5201923080a69a675803e8e3d5e69b3c7914d9ac1eb5f512188499a0b42", // 49: DELETE FROM pending_roles
  "560a3e16d0e2b24bd32aa6e4b54d9f5f3a48b600c8eca8cc12368ffc3dc61d72", // 50: migration-r33
  "414327bf939a4b1eee75f02883a35e1fe2f13be8f33bea036039f76c515befb8", // 51: helpers archived_at
  "1e5d55759fec361d4329a7724e60feed21ef38c2f7845db7174ce6b3314845b0", // 52: thread_roles_owner (PLUG-283 fix)
  "1fbab8797d97860cce32cf6e0902200eabcc69bb0522ea70d91adcb110e16c3e", // 53: queued_at
  "16d38186e522513d01981bd9fb2d3265de10f481022dabea0f1de5e0bb308f82", // 54: attach
];

test("§5.6 (r34.1): migration backfills finished_at for terminal rows, adds last_activity_at, wipes coordinator_watchdog_state", () => {
  const db = new Database(":memory:");
  const r341 = MIGRATIONS.findIndex((m) =>
    m.includes("ADD COLUMN finished_at"),
  );
  assert.ok(r341 > 0, "r34.1 migration found");
  for (const m of MIGRATIONS.slice(0, r341)) db.exec(m);
  const ins = db.prepare(
    `INSERT INTO delegations (
      task_key, coordinator_thread_id, level, route, preset, provider,
      status, created_at, updated_at
    ) VALUES (?, 'thr_c', 'simple', 'simple', 'simple', 'p', ?, 1, ?)`,
  );
  ins.run("PLUG-1", "done", 200);
  ins.run("PLUG-2", "running", 300);
  db.prepare(
    `INSERT INTO coordinator_watchdog_state (
      coordinator_thread_id, idle_since, nudge_count, last_nudge_at,
      escalated_at, updated_at
    ) VALUES ('thr_c', 1, 2, 3, 4, 5)`,
  ).run();
  db.exec(MIGRATIONS[r341]!);
  const done = db
    .prepare(`SELECT finished_at f FROM delegations WHERE task_key = 'PLUG-1'`)
    .get() as { f: number | null };
  assert.equal(
    done.f,
    200,
    "terminal rows get finished_at = updated_at — staying out of the watchdog epoch",
  );
  const running = db
    .prepare(`SELECT finished_at f FROM delegations WHERE task_key = 'PLUG-2'`)
    .get() as { f: number | null };
  assert.equal(running.f, null, "live rows keep finished_at NULL");
  const cols = (db
    .prepare(`PRAGMA table_info(coordinator_watchdog_state)`)
    .all() as { name: string }[]).map((c) => c.name);
  assert.ok(
    cols.includes("last_activity_at"),
    "last_activity_at added (DEFAULT 0)",
  );
  const left = db
    .prepare(`SELECT COUNT(*) c FROM coordinator_watchdog_state`)
    .get() as { c: number };
  assert.equal(left.c, 0, "DELETE FROM coordinator_watchdog_state ran");
});

test("migrations 0..54 immutable SHA-256 hash guard (anti-shift, PLUG-283)", () => {
  assert.ok(
    MIGRATIONS.length >= EXPECTED_MIGRATION_HASHES_0_54.length,
    `MIGRATIONS has ${MIGRATIONS.length} entries, expected at least ${EXPECTED_MIGRATION_HASHES_0_54.length}`,
  );
  for (let i = 0; i < EXPECTED_MIGRATION_HASHES_0_54.length; i++) {
    const actualHash = createHash("sha256").update(MIGRATIONS[i]!).digest("hex");
    assert.equal(
      actualHash,
      EXPECTED_MIGRATION_HASHES_0_54[i],
      `MIGRATIONS[${i}] SHA-256 changed or shifted! Expected ${EXPECTED_MIGRATION_HASHES_0_54[i]}, got ${actualHash}.\nStatement: ${MIGRATIONS[i]}`,
    );
  }
  assert.match(
    MIGRATIONS[52]!,
    /thread_roles_owner/,
    "migration 52 must be thread_roles_owner",
  );
  assert.match(
    MIGRATIONS[53]!,
    /queued_at/,
    "migration 53 must be queued_at",
  );
  assert.match(
    MIGRATIONS[54]!,
    /attach/,
    "migration 54 must be attach",
  );
});
