import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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
  stats: join(stateDir, "inner-agent", "envelope-stats.json"),
});

export const sessionKey = (sessionId) => digest(String(sessionId)).slice(0, 32);

function writeAtomic(file, data, durable = false) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    if (durable) syncPath(tmp);
    renameSync(tmp, file);
    if (durable) syncPath(dirname(file));
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw error;
  }
}

function syncPath(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function writeJsonAtomic(file, value, durable) {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n", durable);
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
    accessMode: fields.accessMode ?? "read-only",
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

export function saveTurn(stateDir, sessKey, turn, durable = false) {
  turn.updatedAt = Date.now();
  writeJsonAtomic(join(turnDir(stateDir, sessKey, turn.turnNo), "record.json"), turn, durable);
  return turn;
}

// Ключ хода — исходный ID сессии + монотонный номер хода, выделенный до
// внешней работы. SHA-256 нормализованного входа распознаёт точный повтор.
export function createTurn(stateDir, entry, fields) {
  const turnNo = Math.max(entry.record.lastTurnNo || 0, fields.previousTurnNo || 0) + 1;
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
    profile: { model: entry.record.model, thinking: entry.record.thinking, account: entry.record.account, ...fields.profile },
    deadlineAt: fields.deadlineAt ?? null,
    inputBlocksSha256: fields.inputSha256,
    taskSha256: null,
    attempts: [{ n: 1, inputSha256: fields.inputSha256, at: now }],
    head: fields.head ?? null,
    pin: fields.pin ?? null,
    expected: fields.expected ?? "text",
    verdict: fields.verdict ?? null,
    ...(fields.write ? { write: fields.write } : {}),
    packageSha256: null,
    messageSha256: null,
    packageBytes: null,
    files: [],
    delivered: false,
    convId: null,
    backendId: null,
    budgets: { contextBytes: 0, toolRounds: 0, repairRounds: 0, ...fields.budgetLimits },
    outcome: null,
    reason: null,
  };
  saveTurn(stateDir, entry.key, turn);
  saveSessionRecord(stateDir, entry, { lastTurnNo: turnNo });
  return turn;
}

export function addAttempt(stateDir, sessKey, turn, inputSha256) {
  turn.attempts.push({ n: turn.attempts.length + 1, inputSha256, at: Date.now() });
  turn.completedAt = null;
  turn.outcome = null;
  turn.reason = null;
  turn.stage = "restore";
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
  writeAtomic(messagePath, packed.message);
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
  if (!turn.packageSha256 || !turn.messageSha256 || !Array.isArray(turn.files)) {
    return { ok: false, reason: "saved turn package is missing or was not fully staged" };
  }
  const dir = turnDir(stateDir, sessKey, turn.turnNo);
  let message;
  try {
    message = readFileSync(join(dir, "package.md"), "utf8");
  } catch {
    return { ok: false, reason: "saved turn package is missing" };
  }
  if (digest(message) !== turn.messageSha256) {
    return { ok: false, reason: "saved turn package is corrupt" };
  }
  const files = [];
  for (const file of turn.files) {
    if (typeof file?.name !== "string" || !file.name || basename(file.name) !== file.name || [".", ".."].includes(file.name)) {
      return { ok: false, reason: "saved package attachment record is invalid" };
    }
    const path = join(dir, "files", file.name);
    let data;
    try {
      data = readFileSync(path);
    } catch {
      return { ok: false, reason: `saved package attachment ${file.name} is missing` };
    }
    if (data.length !== file.bytes || digest(data) !== file.sha256) {
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
  const file = join(turnDir(stateDir, sessKey, turn.turnNo), "exchanges.jsonl");
  const previous = readExchangeLog(file);
  writeAtomic(file, previous + JSON.stringify({ at: Date.now(), ...entry }) + "\n");
}

function readExchangeLog(file) {
  try {
    const contents = readFileSync(file, "utf8");
    if (contents && !contents.endsWith("\n")) throw new Error("saved exchange log is incomplete");
    return contents;
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export function readExchanges(stateDir, sessKey, turnNo) {
  const file = join(turnDir(stateDir, sessKey, turnNo), "exchanges.jsonl");
  return readExchangeLog(file).split("\n").filter(Boolean).map((line) => {
    const entry = JSON.parse(line);
    if (typeof entry?.text !== "string") throw new Error("saved exchange log is invalid");
    return entry;
  });
}

export function completeTurn(stateDir, sessKey, turn, { outcome, reason = null, answer = null }) {
  turn.outcome = outcome;
  turn.reason = reason;
  turn.completedAt = Date.now();
  if (typeof answer === "string" && answer) {
    const file = join(turnDir(stateDir, sessKey, turn.turnNo), "answer.txt");
    writeAtomic(file, answer);
  }
  saveTurn(stateDir, sessKey, turn);
}

export function checkpointWrite(stateDir, { sessKey, turnNo }, commit) {
  if (!/^[a-f0-9]{32}$/.test(sessKey) || !Number.isSafeInteger(turnNo) || turnNo < 1) {
    throw new Error("invalid write journal identity");
  }
  const dir = turnDir(stateDir, sessKey, turnNo);
  const turn = readTurnRecord(dir);
  if (!turn?.write || turn.turnNo !== turnNo) throw new Error("write turn journal is unavailable");
  if (commit) turn.commit = commit;
  else delete turn.commit;
  delete turn.recoveryRequired;
  saveTurn(stateDir, sessKey, turn, true);
}

export function stageFileResponse(stateDir, sessKey, turn, capture, envelope) {
  const dir = join(turnDir(stateDir, sessKey, turn.turnNo), "file-response");
  writeAtomic(join(dir, "history.md.txt"), capture.rpc.text, true);
  writeAtomic(join(dir, "dom.json.txt"), capture.dom.text, true);
  for (const [i, file] of envelope.files.entries()) {
    if (file.operation !== "delete") writeAtomic(join(dir, "content-" + i), file.content, true);
  }
  writeJsonAtomic(join(dir, "manifest.json"), {
    messageId: capture.rpc.id, nonce: turn.write.nonce, commitMessage: envelope.commitMessage,
    files: envelope.files.map(({ path, operation, baseSha256, sha256 }) => ({ path, operation, baseSha256, sha256 })),
  }, true);
  syncPath(dirname(dir));
}

export function unfinishedTurns(stateDir, sessKey) {
  return listTurns(stateDir, sessKey).filter((entry) => entry.corrupt || !entry.record.outcome || entry.record.recoveryRequired);
}

/* ---------- Счётчик первых файловых ответов (PLUG-351) ---------- */

// Накопительный inner-agent/envelope-stats.json: доля отказов ПЕРВОГО файлового
// ответа веб-модели по кодам причин, набираемая на живой работе. Счётчики
// разнесены по формату конверта, чтобы смена формата не смешивала статистику.
const STATS_VERSION = 1;
export const envelopeStatsPath = (stateDir) => journalPaths(stateDir).stats;

export function envelopeStats(stateDir) {
  try {
    const stats = JSON.parse(readFileSync(envelopeStatsPath(stateDir), "utf8"));
    return stats?.version === STATS_VERSION ? stats : null;
  } catch {
    return null;
  }
}

// Чтение-изменение-запись накопительного файла сериализуется межпроцессным
// flock на соседнем envelope-stats.lock: ходы разных процессов провайдера на
// одном stateDir иначе теряли бы чужие обновления (устаревшее чтение плюс
// перезапись). Как и у блокировки рабочей копии, дочерний flock удерживает
// общее с родителем описание файла — после его выхода lock остаётся нашим до
// closeSync.
function updateEnvelopeStats(stateDir, format, outcome, code) {
  mkdirSync(journalPaths(stateDir).root, { recursive: true, mode: 0o700 });
  const fd = openSync(envelopeStatsPath(stateDir) + ".lock",
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const lock = spawnSync("flock", ["-w", "10", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    if (lock.error) throw lock.error;
    if (lock.status !== 0) throw new Error("could not lock the envelope stats file");
    const file = envelopeStatsPath(stateDir);
    let stats = envelopeStats(stateDir);
    if (stats === null) {
      stats = { version: STATS_VERSION, formats: {} };
      try {
        renameSync(file, file + ".corrupt");
      } catch {}
    }
    const slot = stats.formats[format] ??= { accepted: 0, rejected: 0, rejections: {} };
    slot.accepted ??= 0;
    slot.rejected ??= 0;
    slot.rejections ??= {};
    if (outcome === "accepted") slot.accepted += 1;
    else {
      slot.rejected += 1;
      const key = code ?? "unknown";
      slot.rejections[key] = (slot.rejections[key] ?? 0) + 1;
    }
    stats.updatedAt = Date.now();
    writeJsonAtomic(file, stats);
  } finally {
    closeSync(fd);
  }
}

// Исход первого ответа фиксируется один раз на ход: turn.firstFileResponse в
// записи журнала — защёлка, при продолжении после рестарта повторная проверка
// того же ответа в счётчик не идёт. Запись хода сохраняется до обновления
// накопительного файла, а сбой счётчика (недоступный flock, файловая ошибка)
// ход не роняет: статистика вспомогательная, этот ответ просто выпадает из неё.
export function recordFirstFileResponse(stateDir, sessKey, turn, { format, outcome, code = null }) {
  if (turn.firstFileResponse) return turn.firstFileResponse;
  turn.firstFileResponse = { format, outcome, code, at: Date.now() };
  saveTurn(stateDir, sessKey, turn);
  try {
    updateEnvelopeStats(stateDir, format, outcome, code);
  } catch {}
  return turn.firstFileResponse;
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

const BARE_CONTINUE = /^(?:продолжай(?: задачу)?|продолжи(?: задачу)?|continue(?: the task)?|resume(?: the task)?)[.!]?$/i;
// Stock watchdog messages from the orchestrator, including its transport prefix.
const INTERRUPTED = /^(?:ход прерван \([\s\S]{1,300}\), продолжай задачу|turn interrupted \([\s\S]{1,300}\), continue the task|ход оборвался ошибкой: [\s\S]{1,300}\. Продолжай задачу|the turn died on an error: [\s\S]{1,300}\. Continue the task)$/i;
const VERDICT_NUDGE = /^(?:заверши вердиктом: дождись проверок в этом же ходе \(не фоном\) и закончи строкой JSON|finish with a verdict: wait for the checks in this same turn \(not in the background\) and end with the JSON line) \{"verdict":(?:"OK"\|"CHANGES","blockers":N|"APPROVE"\|"REJECT","findings":\[…\])\}$/i;

export function isContinueText(text) {
  const value = String(text ?? "").trim();
  if (BARE_CONTINUE.test(value)) return true;
  const reminder = value.replace(/^\[orchestrator\]\s+/i, "");
  return INTERRUPTED.test(reminder) || VERDICT_NUDGE.test(reminder);
}

export const serializeVerdict = (verdict) =>
  verdict ? [...verdict].map(([key, field]) => [key, { kind: field.kind, values: [...(field.values ?? [])] }]) : null;

export const deserializeVerdict = (data) =>
  Array.isArray(data) ? new Map(data.map(([key, field]) => [key, { kind: field.kind, values: field.values ?? [] }])) : null;
