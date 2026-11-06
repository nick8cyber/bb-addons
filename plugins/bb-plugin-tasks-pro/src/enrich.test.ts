import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readEnrichment } from "./enrich";

const dir = mkdtempSync(join(tmpdir(), "tasks-pro-enrich-"));
const dbPath = join(dir, "data.db");

function seed(path: string, schema = true) {
  const db = new Database(path);
  if (schema) {
    db.exec(`
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        author_name TEXT NOT NULL,
        preset_name TEXT,
        thread_id TEXT,
        body TEXT NOT NULL,
        notified_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE task_threads (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        preset_name TEXT NOT NULL,
        title TEXT NOT NULL,
        live_status TEXT NOT NULL,
        attached_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
  return db;
}

const insert = (db: Database.Database) => {
  const stmt = db.prepare(
    `INSERT INTO comments (id, task_id, kind, author_name, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return (...args: string[]) => stmt.run(...args);
};

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readEnrichment", () => {
  it("derives completedAt, lastStatusChangeAt, commentCount, threadCount", () => {
    const db = seed(dbPath);
    const add = insert(db);
    add("c1", "t1", "system", "sys", "Status changed to In Progress by agent (thr_a)", "2026-10-01T10:00:00Z");
    add("c2", "t1", "user", "me", "looks good", "2026-10-02T10:00:00Z");
    add("c3", "t1", "system", "sys", "Status changed to Done by agent (thr_b)", "2026-10-05T10:00:00Z");
    add("c4", "t1", "system", "sys", "Status changed to In Review by agent (thr_c)", "2026-10-06T10:00:00Z");
    add("c5", "t2", "system", "sys", "Status changed to Canceled by agent (thr_d)", "2026-10-03T10:00:00Z");
    add("c6", "t2", "agent", "ag", "working on it", "2026-10-04T10:00:00Z");
    db.prepare(
      `INSERT INTO task_threads (id, task_id, thread_id, preset_name, title, live_status, attached_at, updated_at)
       VALUES ('tt1', 't1', 'thr_a', 'p', 'x', 'working', '', '')`,
    ).run();
    db.prepare(
      `INSERT INTO task_threads (id, task_id, thread_id, preset_name, title, live_status, attached_at, updated_at)
       VALUES ('tt2', 't1', 'thr_b', 'p', 'y', 'completed', '', '')`,
    ).run();
    db.close();

    const result = readEnrichment(dbPath);
    expect(result).not.toBeNull();
    const t1 = result!.get("t1")!;
    // reopening after Done still keeps the Done transition's timestamp
    expect(t1.completedAt).toBe("2026-10-05T10:00:00Z");
    expect(t1.lastStatusChangeAt).toBe("2026-10-06T10:00:00Z");
    expect(t1.commentCount).toBe(4);
    expect(t1.threadCount).toBe(2);
    const t2 = result!.get("t2")!;
    expect(t2.completedAt).toBe("2026-10-03T10:00:00Z");
    expect(t2.threadCount).toBe(0);
  });

  it("returns null for a missing database", () => {
    expect(readEnrichment(join(dir, "nope.db"))).toBeNull();
  });

  it("returns null when the schema drifted", () => {
    const drifted = join(dir, "drifted.db");
    seed(drifted, false).close();
    expect(readEnrichment(drifted)).toBeNull();
  });
});
