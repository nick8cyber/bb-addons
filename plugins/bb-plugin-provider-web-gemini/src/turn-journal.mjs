import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

// §7.2: постоянный журнал внутреннего агента в state-каталоге провайдера
// (WEB_GEMINI_STATE_DIR), не в рабочей копии и не в репозитории.
//   inner-agent/sessions/<sessKey>.json   — запись сессии
//   inner-agent/turns/<sessKey>/turn-NNNN/{record.json,package.md,files/,exchanges.jsonl,answer.txt}
// sessKey = sha256(исходный ACP sessionId)[:32] — ключ устойчив к рестартам,
// транспортные алиасы перечислены в записи сессии.
const runFile = promisify(execFile);
export const JOURNAL_VERSION = 1;
const DEFAULT_RETENTION_MS = 86_400_000;
const DEFAULT_MAX_RECORDS = 200;
const digest = (data) => createHash("sha256").update(data).digest("hex");

export const journalPaths = (stateDir) => ({
  root: join(stateDir, "inner-agent"),
  sessions: join(stateDir, "inner-agent", "sessions"),
  turns: join(stateDir, "inner-agent", "turns"),
});

export const sessionKey = (sessionId) => digest(String(sessionId)).slice(0, 32);

function writeJsonAtomic(file, value) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw error;
  }
}

/* ---------- Отпечаток рабочей копии и HEAD (§7.2) ---------- */

// Канонический cwd + канонический git-dir конкретного worktree: один и тот же
// репозиторий в другом worktree даёт другой отпечаток, чужой тред в том же cwd —
// другой владелец записи.
export async function worktreeFingerprint(cwd) {
  const real = realpathSync(cwd);
  let gitDir = null;
  try {
    const { stdout } = await runFile("git", ["-C", real, "rev-parse", "--absolute-git-dir"], {
      timeout: 10_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    gitDir = realpathSync(stdout.trim());
  } catch {}
  return { cwd: real, gitDir };
}

export const fingerprintEqual = (a, b) =>
  Boolean(a && b && a.cwd === b.cwd && (a.gitDir ?? null) === (b.gitDir ?? null));

export async function headOf(cwd, signal) {
  try {
    const { stdout } = await runFile("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 10_000, signal });
    const sha = stdout.trim();
    let branch = null;
    try {
      const { stdout: ref } = await runFile("git", ["-C", cwd, "symbolic-ref", "-q", "--short", "HEAD"], {
        timeout: 10_000,
        signal,
      });
      branch = ref.trim() || null;
    } catch {}
    return /^[0-9a-f]{40}$/i.test(sha) ? { sha, branch } : null;
  } catch {
    return null;
  }
}

/* ---------- Записи сессий ---------- */

export function createSessionRecord(stateDir, fields) {
  const key = sessionKey(fields.sessionId);
  const now = Date.now();
  const record = {
    version: JOURNAL_VERSION,
    sessionId: fields.sessionId,
    aliases: [],
    threadId: fields.threadId ?? null,
    projectId: fields.projectId ?? null,
    fingerprint: fields.fingerprint ?? null,
    accessCeiling: fields.accessCeiling ?? "read-only",
    roots: Array.isArray(fields.roots) ? fields.roots : [],
    model: fields.model ?? "argon",
    thinking: fields.thinking ?? "medium",
    account: fields.account ?? "auto",
    convId: fields.convId ?? null,
    backendId: fields.backendId ?? null,
    lastTurnNo: 0,
    createdAt: now,
    updatedAt: now,
  };
  writeJsonAtomic(join(journalPaths(stateDir).sessions, key + ".json"), record);
  return { key, record };
}

export function saveSessionRecord(stateDir, entry, patch = null) {
  const record = patch ? Object.assign(entry.record, patch, { updatedAt: Date.now() }) : entry.record;
  record.updatedAt = Date.now();
  writeJsonAtomic(join(journalPaths(stateDir).sessions, entry.key + ".json"), record);
  return record;
}

export function listSessionRecords(stateDir) {
  const dir = journalPaths(stateDir).sessions;
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return out;
  }
  for (const name of names) {
    const key = name.slice(0, -".json".length);
    try {
      out.push({ key, record: JSON.parse(readFileSync(join(dir, name), "utf8")) });
    } catch {
      out.push({ key, record: null, corrupt: true });
    }
  }
  return out;
}

export function findSessionRecord(stateDir, sessionIdOrAlias) {
  for (const entry of listSessionRecords(stateDir)) {
    const record = entry.record;
    if (!record || record.version !== JOURNAL_VERSION) continue;
    if (record.sessionId === sessionIdOrAlias || (Array.isArray(record.aliases) && record.aliases.includes(sessionIdOrAlias))) {
      return entry;
    }
  }
  return null;
}

export function addSessionAlias(stateDir, entry, alias) {
  if (!alias || alias === entry.record.sessionId) return;
  if (!Array.isArray(entry.record.aliases)) entry.record.aliases = [];
  if (!entry.record.aliases.includes(alias)) {
    entry.record.aliases.push(alias);
    saveSessionRecord(stateDir, entry);
  }
}

/* ---------- Записи ходов ---------- */

const turnDirName = (turnNo) => "turn-" + String(turnNo).padStart(4, "0");
export const turnDir = (stateDir, sessKey, turnNo) =>
  join(journalPaths(stateDir).turns, sessKey, turnDirName(turnNo));

function readTurnRecord(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
  } catch {
    return null;
  }
}

export function listTurns(stateDir, sessKey) {
  const dir = join(journalPaths(stateDir).turns, sessKey);
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory() && /^turn-\d+$/.test(ent.name))
      .map((ent) => ent.name);
  } catch {
    return out;
  }
  for (const name of names) {
    const turnNo = Number(name.slice(5));
    const dirPath = join(dir, name);
    const record = readTurnRecord(dirPath);
    out.push({ turnNo, dir: dirPath, record, corrupt: record === null });
  }
  return out.sort((a, b) => a.turnNo - b.turnNo);
}

export function saveTurn(stateDir, sessKey, turn) {
  turn.updatedAt = Date.now();
  writeJsonAtomic(join(turnDir(stateDir, sessKey, turn.turnNo), "record.json"), turn);
  return turn;
}

// Ключ хода — исходный ID сессии + монотонный номер хода, выделенный до
// внешней работы. SHA-256 нормализованного входа распознаёт точный повтор.
export function createTurn(stateDir, entry, fields) {
  const turnNo = (entry.record.lastTurnNo || 0) + 1;
  const now = Date.now();
  const turn = {
    version: JOURNAL_VERSION,
    turnNo,
    sessionId: entry.record.sessionId,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    stage: "preflight",
    mode: fields.mode ?? "read-only",
    taskSha256: fields.inputSha256,
    attempts: [{ n: 1, inputSha256: fields.inputSha256, at: now }],
    head: fields.head ?? null,
    pin: fields.pin ?? null,
    expected: fields.expected ?? "text",
    verdict: fields.verdict ?? null,
    packageSha256: null,
    messageSha256: null,
    packageBytes: null,
    files: [],
    delivered: false,
    convId: null,
    backendId: null,
    exchanges: 0,
    budgets: { contextBytes: 0 },
    outcome: null,
    reason: null,
  };
  saveTurn(stateDir, entry.key, turn);
  saveSessionRecord(stateDir, entry, { lastTurnNo: turnNo });
  return turn;
}

export function addAttempt(stateDir, sessKey, turn, inputSha256) {
  turn.attempts.push({ n: turn.attempts.length + 1, inputSha256, at: Date.now() });
  saveTurn(stateDir, sessKey, turn);
}

// Сохраняет исходящий пакет целиком: текст сообщения и копии всех файлов —
// исходники в uploads/ подчиняются чистке, копии журнала хранятся до исхода.
export function stageTurnPackage(stateDir, sessKey, turn, packed) {
  const dir = turnDir(stateDir, sessKey, turn.turnNo);
  const filesDir = join(dir, "files");
  rmSync(filesDir, { recursive: true, force: true });
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const messagePath = join(dir, "package.md");
  const tmp = `${messagePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, packed.message, { mode: 0o600 });
  renameSync(tmp, messagePath);
  const seen = new Set();
  const files = [];
  for (const source of packed.files || []) {
    const name = basename(source);
    if (seen.has(name)) continue;
    seen.add(name);
    const dest = join(filesDir, name);
    copyFileSync(source, dest);
    const data = readFileSync(dest);
    files.push({ name, path: dest, origin: source, bytes: data.length, sha256: digest(data) });
  }
  turn.packageSha256 = packed.packageSha256;
  turn.messageSha256 = digest(packed.message);
  turn.packageBytes = Buffer.byteLength(packed.message) + files.reduce((total, file) => total + file.bytes, 0);
  turn.files = files;
  saveTurn(stateDir, sessKey, turn);
  return { messagePath, filesDir };
}

// Проверка целостности сохранённого пакета при продолжении (§7.3): версия
// записи и хэши сообщения и каждого вложения.
export function loadTurnPackage(stateDir, sessKey, turn) {
  if (!turn || turn.version !== JOURNAL_VERSION) {
    return { ok: false, reason: "unsupported journal schema version" };
  }
  const dir = turnDir(stateDir, sessKey, turn.turnNo);
  let message;
  try {
    message = readFileSync(join(dir, "package.md"), "utf8");
  } catch {
    return { ok: false, reason: "saved turn package is missing" };
  }
  if (turn.messageSha256 && digest(message) !== turn.messageSha256) {
    return { ok: false, reason: "saved turn package is corrupt" };
  }
  const files = [];
  for (const file of turn.files || []) {
    const path = join(dir, "files", file.name);
    let data;
    try {
      data = readFileSync(path);
    } catch {
      return { ok: false, reason: `saved package attachment ${file.name} is missing` };
    }
    if (digest(data) !== file.sha256) {
      return { ok: false, reason: `saved package attachment ${file.name} is corrupt` };
    }
    files.push(path);
  }
  return {
    ok: true,
    message,
    files,
    packageSha256: turn.packageSha256,
    totalBytes: Buffer.byteLength(message) + files.reduce((total, path) => total + statSync(path).size, 0),
  };
}

export function appendExchange(stateDir, sessKey, turn, entry) {
  const dir = turnDir(stateDir, sessKey, turn.turnNo);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, "exchanges.jsonl"), JSON.stringify({ at: Date.now(), ...entry }) + "\n", { mode: 0o600 });
  turn.exchanges = (turn.exchanges || 0) + 1;
}

export function readExchanges(stateDir, sessKey, turnNo) {
  try {
    return readFileSync(join(turnDir(stateDir, sessKey, turnNo), "exchanges.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function completeTurn(stateDir, sessKey, turn, { outcome, reason = null, answer = null }) {
  turn.outcome = outcome;
  turn.reason = reason;
  turn.completedAt = Date.now();
  if (typeof answer === "string" && answer) {
    const file = join(turnDir(stateDir, sessKey, turn.turnNo), "answer.txt");
    writeFileSync(file, answer, { mode: 0o600 });
  }
  saveTurn(stateDir, sessKey, turn);
}

export function unfinishedTurns(stateDir, sessKey) {
  return listTurns(stateDir, sessKey).filter((entry) => entry.corrupt || !entry.record.outcome);
}

/* ---------- Чистка журнала и защита ссылок активных ходов (§7.2) ---------- */

export function collectProtectedPaths(stateDir) {
  const protectedPaths = new Set();
  for (const entry of listSessionRecords(stateDir)) {
    for (const turn of unfinishedTurns(stateDir, entry.key)) {
      const dir = turn.dir;
      protectedPaths.add(join(dir, "package.md"));
      protectedPaths.add(join(dir, "exchanges.jsonl"));
      protectedPaths.add(join(dir, "answer.txt"));
      for (const file of turn.record?.files || []) {
        if (file.path) protectedPaths.add(file.path);
        if (file.origin) protectedPaths.add(file.origin);
      }
    }
  }
  return protectedPaths;
}

// Завершённые записи старше retentionMs удаляются вместе с данными ходов;
// незавершённые ходы защищены от чистки. Сверх maxRecords уходят самые старые
// сессии без незавершённых ходов. retentionFor(entry) может дать срок хранения
// по projectId записи (inner-agent.json state.retentionMs).
export function pruneJournal(stateDir, { retentionMs = DEFAULT_RETENTION_MS, maxRecords = DEFAULT_MAX_RECORDS, now = Date.now(), retentionFor = null } = {}) {
  const stats = { removedSessions: 0, keptActive: 0 };
  const survivors = [];
  const remove = (entry) => {
    try {
      rmSync(join(journalPaths(stateDir).sessions, entry.key + ".json"), { force: true });
      rmSync(join(journalPaths(stateDir).turns, entry.key), { recursive: true, force: true });
      stats.removedSessions += 1;
    } catch {}
  };
  for (const entry of listSessionRecords(stateDir)) {
    const active = unfinishedTurns(stateDir, entry.key).length > 0;
    if (active) {
      stats.keptActive += 1;
      survivors.push(entry);
      continue;
    }
    const updatedAt = entry.record?.updatedAt ?? 0;
    let ttl = retentionMs;
    try {
      ttl = retentionFor?.(entry) ?? retentionMs;
    } catch {}
    if (entry.corrupt || now - updatedAt > ttl) {
      remove(entry);
      continue;
    }
    survivors.push(entry);
  }
  const disposable = survivors
    .filter((entry) => unfinishedTurns(stateDir, entry.key).length === 0)
    .sort((a, b) => (a.record?.updatedAt ?? 0) - (b.record?.updatedAt ?? 0));
  while (survivors.length > maxRecords && disposable.length) {
    const oldest = disposable.shift();
    remove(oldest);
    survivors.splice(survivors.indexOf(oldest), 1);
  }
  return stats;
}

/* ---------- Распознавание продолжения (§7.3) ---------- */

const TASK_HEADER = /^#\s+[A-Z][A-Z0-9]{1,9}-\d+\s+·/m;
const CONTINUE_HINT = /продолж|continue|resume|прерван|оборвал|interrupt/i;

// Одиночное «продолжай» или напоминание BB о прерванном ходе: короткий текст
// без заголовка задачи. Полная задача так не распознаётся никогда.
export function isContinueText(text) {
  const value = String(text ?? "").trim();
  if (!value || value.length > 20_000 || TASK_HEADER.test(value)) return false;
  return CONTINUE_HINT.test(value);
}

export const serializeVerdict = (verdict) =>
  verdict ? [...verdict].map(([key, field]) => [key, { kind: field.kind, values: [...(field.values ?? [])] }]) : null;

export const deserializeVerdict = (data) =>
  Array.isArray(data) ? new Map(data.map(([key, field]) => [key, { kind: field.kind, values: field.values ?? [] }])) : null;
