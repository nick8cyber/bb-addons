/**
 * CallStore: транскрипт и итог звонка в SQLite плагина (контракт §9).
 * bb.storage.database() — собственная база плагина; миграции append-only.
 */
import type Database from "better-sqlite3";

export interface CallRow {
  id: string;
  threadId: string | null;
  startedAt: number;
  endedAt: number | null;
  modeHistory: string;
  keySwitches: number;
  endReason: string | null;
}

export interface CallEventRow {
  callId: string;
  seq: number;
  ts: number;
  kind: string;
  payload: string;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    thread_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    mode_history TEXT NOT NULL DEFAULT '[]',
    key_switches INTEGER NOT NULL DEFAULT 0,
    end_reason TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS call_events (
    call_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (call_id, seq)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events (call_id, seq);`,
  // Своя память голосового агента: предпочтения владельца для звонков. Не общая память BB —
  // её читают все агенты всех проектов (приёмка 03.11: remember писал в --scope global).
  `CREATE TABLE IF NOT EXISTS voice_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
];

const RETENTION_DAYS = 90;

export class CallStore {
  private seq = 0;

  constructor(private db: Database.Database) {
    for (const statement of MIGRATIONS) {
      this.db.exec(statement);
    }
  }

  startCall(id: string, startedAt = Date.now(), threadId: string | null = null): void {
    this.db
      .prepare("INSERT OR REPLACE INTO calls (id, thread_id, started_at) VALUES (?, ?, ?)")
      .run(id, threadId, startedAt);
    this.seq = 0;
  }

  setThread(callId: string, threadId: string): void {
    this.db.prepare("UPDATE calls SET thread_id = ? WHERE id = ?").run(threadId, callId);
  }

  /** Звонки, оставшиеся «идущими» после перезагрузки плагина или сервера, — закрыть. Возвращает thread_id незакрытых звонков. */
  closeStale(reason = "restart", endedAt = Date.now()): string[] {
    const rows = this.db
      .prepare("SELECT id, thread_id as threadId FROM calls WHERE ended_at IS NULL")
      .all() as Array<{ id: string; threadId: string | null }>;
    this.db.prepare("UPDATE calls SET ended_at = ?, end_reason = ? WHERE ended_at IS NULL").run(endedAt, reason);
    return rows.map((r) => r.threadId).filter((t): t is string => Boolean(t));
  }

  /** Память голосового агента: добавить запись (без дублей). */
  addMemory(text: string, at = Date.now()): { id: number; duplicate: boolean } {
    const clean = text.trim().slice(0, 600);
    const dup = this.db.prepare("SELECT id FROM voice_memory WHERE text = ?").get(clean) as { id: number } | undefined;
    if (dup) return { id: dup.id, duplicate: true };
    const r = this.db.prepare("INSERT INTO voice_memory (text, created_at) VALUES (?, ?)").run(clean, at);
    return { id: Number(r.lastInsertRowid), duplicate: false };
  }

  /** Последние записи памяти голосового агента (для системной инструкции звонка). */
  listMemory(limit = 40): Array<{ id: number; text: string; createdAt: number }> {
    return this.db
      .prepare("SELECT id, text, created_at AS createdAt FROM voice_memory ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ id: number; text: string; createdAt: number }>;
  }

  forgetMemory(id: number): boolean {
    return this.db.prepare("DELETE FROM voice_memory WHERE id = ?").run(id).changes > 0;
  }

  endCall(callId: string, reason: string, endedAt = Date.now()): void {
    this.db
      .prepare("UPDATE calls SET ended_at = ?, end_reason = ? WHERE id = ?")
      .run(endedAt, reason, callId);
  }

  setModeHistory(callId: string, history: string[]): void {
    this.db.prepare("UPDATE calls SET mode_history = ? WHERE id = ?").run(JSON.stringify(history), callId);
  }

  incKeySwitches(callId: string): void {
    this.db.prepare("UPDATE calls SET key_switches = key_switches + 1 WHERE id = ?").run(callId);
  }

  event(callId: string, kind: string, payload: unknown, ts = Date.now()): void {
    this.seq += 1;
    this.db
      .prepare("INSERT INTO call_events (call_id, seq, ts, kind, payload) VALUES (?, ?, ?, ?, ?)")
      .run(callId, this.seq, ts, kind, JSON.stringify(payload ?? null));
  }

  calls(limit = 20): CallRow[] {
    return this.db
      .prepare(
        "SELECT id, thread_id AS threadId, started_at AS startedAt, ended_at AS endedAt, mode_history AS modeHistory, key_switches AS keySwitches, end_reason AS endReason FROM calls ORDER BY started_at DESC LIMIT ?",
      )
      .all(limit) as unknown as CallRow[];
  }

  transcript(callId: string): CallEventRow[] {
    return this.db
      .prepare(
        "SELECT call_id AS callId, seq, ts, kind, payload FROM call_events WHERE call_id = ? ORDER BY seq",
      )
      .all(callId) as unknown as CallEventRow[];
  }

  /** Ротация: звонки старше 90 дней удаляются (контракт §9). */
  rotate(now = Date.now()): number {
    const cutoff = now - RETENTION_DAYS * 24 * 3600 * 1000;
    const old = this.db.prepare("SELECT id FROM calls WHERE started_at < ?").all(cutoff) as Array<{ id: string }>;
    for (const c of old) {
      this.db.prepare("DELETE FROM call_events WHERE call_id = ?").run(c.id);
      this.db.prepare("DELETE FROM calls WHERE id = ?").run(c.id);
    }
    return old.length;
  }
}
