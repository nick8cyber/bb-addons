#!/usr/bin/env node
/**
 * acp-web-gemini (legacy alias acp-argon) — ACP (JSON-RPC stdio) bridge to Google Gemini web client.
 * Wraps the patched google-gemini-cli driver (CDP + headless Chromium).
 *
 * Conforms strictly to docs/specs/provider-argon.md and ADR 0027.
 */
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as webTools from "./src/web-tools.mjs";
import { checkedAnswer, collectTask, collectTaskAttachments, filterServiceLines, formatTaskToolResult, loadSettings, packTask, prepareTask, SEARCH_DIRECTIVE, taskInstruction, taskThread, taskTool } from "./src/inner-context.mjs";
import { gatherAgentContext } from "./src/fast-agent.mjs";
import { collectDiff } from "./src/review-git.mjs";
import * as journal from "./src/turn-journal.mjs";
import fileEnvelope from "./src/file-envelope.cjs";
import { resultPaths, WorktreeWriter } from "./src/worktree-writer.mjs";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  realpathSync,
  writeFileSync,
  appendFileSync,
  constants,
} from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "package.json"));
const browserGroups = require("./src/browser-groups.cjs");

// Diagnostics must stay off stdout — it is the JSON-RPC channel.
console.log = console.error;

const FAKE = process.env.WEB_GEMINI_FAKE === "1" || process.env.ARGON_FAKE === "1";
// Привязка к BB-треду приходит двумя каналами: argv `--bb-thread-id=`
// (запуск через deriveProviderOptions плагина) и env BB_THREAD_ID —
// единственный канал для `customAgents` provider-acp, чей argv статичен.
// В обоих случаях id проверяется через `bb thread show` до доверия.
const BB_THREAD_ARG = process.argv.find((arg) => arg.startsWith("--bb-thread-id=")) ??
  (process.env.BB_THREAD_ID ? "--bb-thread-id=" + process.env.BB_THREAD_ID : undefined);
const BB_THREAD_ID = BB_THREAD_ARG?.slice("--bb-thread-id=".length);
const SESSION_ACCESS = process.argv.find((arg) => arg.startsWith("--session-access="))?.split("=")[1];
const WRITE_LAUNCH = SESSION_ACCESS === "write" && Boolean(BB_THREAD_ID);
const FILE_CAPTURE_MARKER_BYTES = 64;
const WRITE_REFUSED = "full grants read-only access; use accept-edits and a dedicated managed BB worktree for file output";
const HEADLESS = process.env.WEB_GEMINI_HEADLESS || process.env.ARGON_HEADLESS || process.env.GEMINI_HEADLESS || null;

function resolveDefaultStateDir() {
  const geminiDir = join(homedir(), ".bb", "plugins", "provider-web-gemini");
  const argonDir = join(homedir(), ".bb", "plugins", "provider-argon");
  if (existsSync(geminiDir)) return geminiDir;
  if (existsSync(argonDir)) return argonDir;
  return geminiDir;
}

const STATE_DIR = process.env.WEB_GEMINI_STATE_DIR || process.env.ARGON_STATE_DIR || resolveDefaultStateDir();
const POOL_FILE = process.env.WEB_GEMINI_POOL_FILE || process.env.ARGON_POOL_FILE || join(STATE_DIR, "pool.json");
const LEDGER_FILE = join(STATE_DIR, "accounts-state.json");
const LOCK_FILE = join(STATE_DIR, "accounts-state.json.lock");
const LOCK_STALE_MS = 5000;
const LEASE_TTL_MS = 10 * 60_000;
// A marked group younger than this with a live foreign owner is treated as
// still launching (recordGroup precedes CDP readiness) — idle-reap skips it.
const GROUP_STARTUP_GRACE_MS = 60_000;
// 20 minutes (prevents timeout of long deep reviews on neon high).
const SEND_DEADLINE_MS = Number(process.env.WEB_GEMINI_SEND_DEADLINE_MS || process.env.ARGON_SEND_DEADLINE_MS) || 1_200_000;
// PLUG-371: абсолютный потолок хода — отдельный щедрый env (дефолт 4ч), только как страховка от вечного цикла.
const rawSessionCapMs = Number(process.env.WEB_GEMINI_SESSION_CAP_MS || process.env.ARGON_SESSION_CAP_MS);
const SESSION_CAP_MS = Number.isFinite(rawSessionCapMs) && rawSessionCapMs > 0 ? rawSessionCapMs : 4 * 3600_000;

// PLUG-291: каталоги веб-вложений (исходящие uploads, входящие downloads) и
// их чистка при старте — TTL 24ч и не более 20 файлов на каталог.
export const UPLOADS_DIR = join(STATE_DIR, "uploads");
export const DOWNLOADS_DIR = join(STATE_DIR, "downloads");
export const writeSpillPackage = webTools.writeSpillPackage;
const FILES_MAX_AGE_MS = 24 * 3600_000;
const FILES_KEEP_COUNT = 20;
const numEnv = (names, dflt) => {
  for (const name of [].concat(names)) {
    const v = Number(process.env[name]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return dflt;
};
const argonMaxUploadBytes = () => numEnv(["WEB_GEMINI_MAX_UPLOAD_BYTES", "ARGON_MAX_UPLOAD_BYTES"], 25 * 1024 * 1024);
const argonMaxUploadCount = () => Math.floor(numEnv(["WEB_GEMINI_MAX_UPLOAD_COUNT", "ARGON_MAX_UPLOAD_COUNT"], 5));

/* ---------- account pool loading (§3.1) ---------- */
export function loadBackends(stateDir = STATE_DIR, poolFile = POOL_FILE) {
  const byId = new Map();

  // 1. Primary: pool.json
  try {
    if (existsSync(poolFile)) {
      const data = JSON.parse(readFileSync(poolFile, "utf8"));
      if (Array.isArray(data.accounts)) {
        for (const acc of data.accounts) {
          if (!acc.id) continue;
          let profileDir = acc.profileDir || "";
          if (profileDir.startsWith("~/")) {
            profileDir = join(homedir(), profileDir.slice(2));
          } else if (profileDir.startsWith("~")) {
            profileDir = join(homedir(), profileDir.slice(1));
          }
          const cdp = String(acc.cdpPort ?? acc.cdp ?? 9222);
          if (!/^\d{2,5}$/.test(cdp)) continue;
          byId.set(acc.id, {
            id: acc.id,
            email: acc.email || `${acc.id}@example.com`,
            profileDir,
            profile: acc.profile || acc.id,
            cdp,
            tier: acc.tier || null,
            priority: Number.isInteger(acc.priority) ? acc.priority : 10,
          });
        }
      }
    }
  } catch {}

  // 2. Fallback / compatibility: $stateDir/accounts/<label>/backend.json
  const poolDir = join(stateDir, "accounts");
  try {
    if (existsSync(poolDir)) {
      for (const ent of readdirSync(poolDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (byId.has(ent.name)) continue;
        try {
          const b = JSON.parse(readFileSync(join(poolDir, ent.name, "backend.json"), "utf8"));
          const cdp = String(b.cdp ?? b.cdpPort ?? "");
          if (!/^\d{2,5}$/.test(cdp)) continue;
          let profileDir = b.profileDir || "";
          if (profileDir.startsWith("~/")) {
            profileDir = join(homedir(), profileDir.slice(2));
          } else if (profileDir.startsWith("~")) {
            profileDir = join(homedir(), profileDir.slice(1));
          }
          byId.set(ent.name, {
            id: ent.name,
            email: b.email || `${ent.name}@example.com`,
            profileDir,
            profile: b.profile || ent.name,
            cdp,
            tier: b.tier || null,
            priority: Number.isInteger(b.priority) ? b.priority : 10,
          });
        } catch {}
      }
    }
  } catch {}

  // 3. Migration fallback: ~/.config/argon-acp/accounts/*/backend.json if pool is empty
  if (byId.size === 0) {
    const legacyDir = join(homedir(), ".config", "argon-acp", "accounts");
    try {
      if (existsSync(legacyDir)) {
        for (const ent of readdirSync(legacyDir, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          if (byId.has(ent.name)) continue;
          try {
            const b = JSON.parse(readFileSync(join(legacyDir, ent.name, "backend.json"), "utf8"));
            const cdp = String(b.cdp ?? b.cdpPort ?? "");
            if (!/^\d{2,5}$/.test(cdp)) continue;
            let profileDir = b.profileDir || "";
            if (!profileDir && b.profile) {
              profileDir = join(homedir(), ".config", `google-chrome-${b.profile}`);
            } else if (profileDir.startsWith("~/")) {
              profileDir = join(homedir(), profileDir.slice(2));
            } else if (profileDir.startsWith("~")) {
              profileDir = join(homedir(), profileDir.slice(1));
            }
            byId.set(ent.name, {
              id: ent.name,
              email: b.email || `${ent.name}@example.com`,
              profileDir,
              profile: b.profile || ent.name,
              cdp,
              tier: b.tier || null,
              priority: Number.isInteger(b.priority) ? b.priority : 10,
            });
          } catch {}
        }
      }
    } catch {}
  }

  // 4. Env WEB_GEMINI_BACKENDS / ARGON_BACKENDS
  try {
    const rawBackends = process.env.WEB_GEMINI_BACKENDS || process.env.ARGON_BACKENDS || "";
    const arr = JSON.parse(rawBackends);
    if (Array.isArray(arr)) {
      for (const [i, b] of arr.entries()) {
        const id = b.id || `env-${i + 1}`;
        const cdp = String(b.cdp ?? b.cdpPort ?? 9222);
        if (!/^\d{2,5}$/.test(cdp)) continue;
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            email: b.email || `${id}@example.com`,
            profileDir: b.profileDir || "",
            profile: b.profile || null,
            cdp,
            tier: b.tier || null,
            priority: Number.isInteger(b.priority) ? b.priority : 10,
          });
        }
      }
    }
  } catch {}

  // 5. Default fallback single profile
  if (byId.size === 0) {
    const envCdp = process.env.GEMINI_CDP_PORT || "9222";
    const envProfile =
      process.env.GEMINI_PROFILE_DIR || process.env.GEMINI_PROFILE || join(homedir(), ".gemini-cli-profile");
    byId.set("default", {
      id: "default",
      email: "default@example.com",
      profileDir: envProfile,
      profile: "default",
      cdp: /^\d{2,5}$/.test(envCdp) ? envCdp : "9222",
      tier: process.env.GEMINI_TIER || null,
      priority: 10,
    });
  }

  return [...byId.values()];
}

export let BACKENDS = loadBackends();
export function refreshBackends() {
  BACKENDS = loadBackends();
  return BACKENDS;
}
const cdpUrlOf = (b) => `http://localhost:${b.cdp}`;

/* ---------- state lock and ledger: accounts-state.json (§3.1-§3.2) ---------- */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function acquireLock(lockPath = LOCK_FILE) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
      closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {}
      const start = Date.now();
      while (Date.now() - start < 40) {}
    }
  }
  throw new Error("accounts-state lock held for over 10s");
}

function releaseLock(lockPath = LOCK_FILE) {
  try {
    unlinkSync(lockPath);
  } catch {}
}

export function loadState(ledgerPath = LEDGER_FILE) {
  let state = { accounts: Object.create(null), leases: Object.create(null) };
  try {
    if (existsSync(ledgerPath)) {
      const raw = JSON.parse(readFileSync(ledgerPath, "utf8"));
      state.accounts = Object.assign(Object.create(null), raw.accounts || {});
      for (const acc of Object.values(state.accounts)) {
        if (acc && Array.isArray(acc.lockedModels)) {
          acc.lockedModels = [...new Set(acc.lockedModels.map((m) => resolveModelId(m) || m))];
        }
      }
      state.leases = Object.assign(Object.create(null), raw.leases || {});
      if (raw.breaker) state.breaker = raw.breaker;
    }
  } catch (e) {
    if (e.code !== "ENOENT" && existsSync(ledgerPath)) {
      try { renameSync(ledgerPath, `${ledgerPath}.corrupt-${Date.now()}`); } catch {}
    }
  }

  // Prune expired or dead leases
  const now = Date.now();
  for (const [id, lease] of Object.entries(state.leases)) {
    if (!lease || now - (lease.acquiredMs || 0) >= LEASE_TTL_MS || !isPidAlive(lease.pid)) {
      delete state.leases[id];
      // The lease and account reservation are written together. A crashed
      // provider leaves both behind, including before the first convId exists.
      const account = state.accounts[id];
      if (lease && account?.owner?.startsWith(`${lease.pid}:`)) {
        account.inUseUntilMs = 0;
        account.owner = null;
      }
    }
  }

  return state;
}

function saveState(state, ledgerPath = LEDGER_FILE) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const tmp = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
  const data = {
    accounts: state.accounts || {},
    leases: state.leases || {},
  };
  if (state.breaker) data.breaker = state.breaker;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, ledgerPath);
}

export function withStateLock(fn, ledgerPath = LEDGER_FILE, lockPath = LOCK_FILE) {
  acquireLock(lockPath);
  try {
    const state = loadState(ledgerPath);
    const result = fn(state);
    saveState(state, ledgerPath);
    return result;
  } finally {
    releaseLock(lockPath);
  }
}

export async function releaseLease(backendId) {
  if (!backendId) return;
  try {
    withStateLock((state) => {
      if (state.leases && state.leases[backendId]) {
        if (state.leases[backendId].pid === process.pid) {
          delete state.leases[backendId];
        }
      }
      const acc = state.accounts[backendId];
      if (acc && acc.owner && acc.owner.startsWith(`${process.pid}:`)) {
        acc.inUseUntilMs = 0;
        acc.owner = null;
      }
    });
  } catch {}
}

const accEntry = (state, id) =>
  Object.hasOwn(state.accounts, id) ? state.accounts[id] : undefined;
const accEnsure = (state, id) => {
  if (!Object.hasOwn(state.accounts, id) || typeof state.accounts[id] !== "object" || state.accounts[id] === null) {
    state.accounts[id] = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null };
  }
  return state.accounts[id];
};

export function getAccountTier(b, state) {
  if (!b) return "pro";
  const e = accEntry(state, b.id);
  if (e?.lockedModels && e.lockedModels.includes("carbon")) {
    return "pro";
  }
  if (e?.tier) {
    return e.tier.toLowerCase() === "ultra" ? "ultra" : "pro";
  }
  if (b?.tier) {
    return b.tier.toLowerCase() === "ultra" ? "ultra" : "pro";
  }
  return "pro";
}

export function getAccountPriority(b, state) {
  if (!b) return 10;
  const e = accEntry(state, b.id);
  if (typeof e?.priority === "number" && Number.isInteger(e.priority) && e.priority >= 0) {
    return e.priority;
  }
  if (typeof b?.priority === "number" && Number.isInteger(b.priority) && b.priority >= 0) {
    return b.priority;
  }
  return 10;
}

function leasedUntil(state, b, owner, now) {
  const l = state.leases && state.leases[b.id];
  if (l && l.pid !== process.pid && now - (l.acquiredMs || 0) < LEASE_TTL_MS && isPidAlive(l.pid)) {
    return l.acquiredMs + LEASE_TTL_MS;
  }
  const e = accEntry(state, b.id);
  return e && (e.inUseUntilMs ?? 0) > now && e.owner !== owner ? e.inUseUntilMs : 0;
}

// A port whose browser-group marker is flagged `reaping` is off-limits for
// new leases while the mark is fresh — the teardown owner frees it shortly.
function reapingBusyUntil(stateDir, port, now) {
  const meta = browserGroups.readMarker(stateDir, port);
  return browserGroups.isReaping(meta, now) ? meta.reaping.sinceMs + browserGroups.REAPING_TTL_MS : 0;
}

export function pickBackendFromState(state, excludeId, owner, now, requestedModel = null, backends = BACKENDS, stateDir = STATE_DIR) {
  const isLeased = (b) => Math.max(leasedUntil(state, b, owner, now), reapingBusyUntil(stateDir, b.cdp, now));

  const req = requestedModel ? (resolveModelId(requestedModel) || requestedModel.toLowerCase()) : null;
  const candidates = backends.filter((b) => {
    const prio = getAccountPriority(b, state);
    if (b.id === excludeId || prio <= 0) return false;
    const tier = getAccountTier(b, state);
    if (req === "carbon" && tier !== "ultra") return false;
    if (req) {
      const e = accEntry(state, b.id);
      if (e?.lockedModels && e.lockedModels.includes(req)) {
        return false;
      }
    }
    return true;
  });
  if (candidates.length === 0) return { none: true };

  const free = candidates.filter(
    (b) => (accEntry(state, b.id)?.cooldownUntilMs ?? 0) <= now && isLeased(b) === 0
  );
  if (free.length === 0) {
    const maxCandidatePrio = Math.max(...candidates.map((b) => getAccountPriority(b, state)));
    const topCandidates = candidates.filter((b) => getAccountPriority(b, state) === maxCandidatePrio);
    const soonest = Math.min(
      ...topCandidates.map((b) => {
        const freeAt = Math.max(isLeased(b), accEntry(state, b.id)?.cooldownUntilMs ?? 0);
        return freeAt > now ? freeAt : Infinity;
      })
    );
    if (!Number.isFinite(soonest)) return { none: true };
    return soonest <= now + LEASE_TTL_MS + 10_000
      ? { busyUntil: soonest }
      : { cooledUntil: soonest };
  }

  // Pick highest priority tier first
  const maxP = Math.max(...free.map((b) => getAccountPriority(b, state)));
  const topTier = free.filter((b) => getAccountPriority(b, state) === maxP);

  // When not requesting carbon, "all other things being equal" (equal priorities):
  // prefer Pro accounts first to reserve Ultra accounts for Carbon
  let eligibleTier = topTier;
  if (req !== "carbon") {
    const proAccounts = topTier.filter((b) => getAccountTier(b, state) === "pro");
    if (proAccounts.length > 0) {
      eligibleTier = proAccounts;
    }
  }

  // Within the eligible tier: LRU by lastUsedMs, tie-break by ID
  eligibleTier.sort(
    (a, b) =>
      (accEntry(state, a.id)?.lastUsedMs ?? 0) - (accEntry(state, b.id)?.lastUsedMs ?? 0) ||
      a.id.localeCompare(b.id)
  );
  return { backend: eligibleTier[0] };
}

function acquireInState(state, b, owner, now) {
  const e = accEnsure(state, b.id);
  e.lastUsedMs = now;
  e.inUseUntilMs = now + LEASE_TTL_MS;
  e.owner = owner;
  e.parkedReason = null;
  // `cdp` lets non-ACP readers (the driver's stopChrome teardown) map the
  // lease to a browser-group port without loading the backend pool.
  state.leases[b.id] = { pid: process.pid, acquiredMs: now, cdp: b.cdp };
  // PLUG-374: the lease holder owns the browser group on this port — under
  // the same lock, so reapers always see a live verifiable owner. A refusal
  // (marker lock unavailable) must be recorded, not swallowed (заход 7).
  try {
    browserGroups.adoptGroup(STATE_DIR, b.cdp);
  } catch (e) {
    slog("lease:adopt-group-error", { cdp: b.cdp, error: String(e) });
  }
}

/* ---------- parse reset time (§3.4) ---------- */
export function parseResetTimeMs(msg, nowMs = Date.now()) {
  const str = String(msg || "");
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  // English format
  const enMatch = str.match(
    /Limit resets (?:on\s+)?(?:([A-Za-z]+)\s+(\d{1,2}),?\s+|tomorrow\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i
  );
  if (enMatch) {
    const monthStr = enMatch[1];
    const dayStr = enMatch[2];
    let hour = parseInt(enMatch[3], 10);
    const minute = enMatch[4] ? parseInt(enMatch[4], 10) : 0;
    const ampm = enMatch[5]?.toUpperCase();

    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;

    const d = new Date(nowMs);
    d.setSeconds(0, 0);
    d.setHours(hour, minute, 0, 0);

    if (monthStr && dayStr) {
      const mIdx = monthNames.findIndex((m) => monthStr.toLowerCase().startsWith(m));
      if (mIdx >= 0) {
        d.setMonth(mIdx, parseInt(dayStr, 10));
        if (nowMs - d.getTime() > 30 * 86_400_000) {
          d.setFullYear(d.getFullYear() + 1);
        }
      }
    } else if (/tomorrow/i.test(enMatch[0])) {
      d.setDate(d.getDate() + 1);
    } else {
      if (d.getTime() <= nowMs) {
        d.setDate(d.getDate() + 1);
      }
    }
    return d.getTime() + 2 * 60_000;
  }

  // Russian format
  const ruMatch = str.match(/(?:Лимит\s+)?(?:обновится|сбросится)[^0-9]*(\d{1,2}):(\d{2})/i);
  if (ruMatch) {
    let hour = parseInt(ruMatch[1], 10);
    const minute = parseInt(ruMatch[2], 10);
    const d = new Date(nowMs);
    d.setSeconds(0, 0);
    d.setHours(hour, minute, 0, 0);

    if (/завтра/i.test(str)) {
      d.setDate(d.getDate() + 1);
    } else if (d.getTime() <= nowMs) {
      d.setDate(d.getDate() + 1);
    }
    return d.getTime() + 2 * 60_000;
  }

  return null;
}

/* ---------- prompt-size guard (PLUG-281, §2.2/§4.1) ---------- */
// Unset → 100000 (below the observed ~120KB insertText hang);
// WEB_GEMINI_MAX_PROMPT_BYTES or ARGON_MAX_PROMPT_BYTES=N overrides; non-positive → no limit.
export function webGeminiMaxPromptBytes() {
  const raw = process.env.WEB_GEMINI_MAX_PROMPT_BYTES ?? process.env.ARGON_MAX_PROMPT_BYTES;
  if (raw == null || raw === "") return 100_000;
  const v = Number(raw);
  // NaN/garbage → default; non-positive → explicit "no limit".
  return Number.isFinite(v) ? (v > 0 ? v : Number.POSITIVE_INFINITY) : 100_000;
}

// Central outbound-text check applied to every send to Gemini (§2.2):
// session/prompt text here, and the driver repeats it at the last boundary
// before page work so internal sends (packed/tool-loop messages) are covered.
export function promptTooLargeError(text) {
  const bytes = Buffer.byteLength(text || "", "utf8");
  const limit = webGeminiMaxPromptBytes();
  if (bytes <= limit) return null;
  const err = new Error(
    `prompt too large: ${bytes} bytes exceeds limit ${limit} bytes (WEB_GEMINI_MAX_PROMPT_BYTES). Shrink the request and retry.`
  );
  err.code = "WEB_GEMINI_PROMPT_TOO_LARGE";
  return err;
}

/* ---------- bb <system_instructions> strip (PLUG-285, §2.2) ---------- */
// bb кладёт свой агентский контекст (~29 КБ инструкций плагинов, манифеста
// инструментов и навыков) первым текст-блоком session/prompt. Веб-Gemini
// читал его как «нет инструментов и сети» и отказывался работать
// (инциденты 16.11). Блок, чей текст начинается с маркера
// `<system_instructions>`, — целиком bb-инъекция и вырезается до склейки;
// упоминание метки внутри пользовательского текста блок не портит.
const BB_SYSTEM_INSTRUCTIONS_MARKER = "<system_instructions>";
export function isBbSystemInstructionsBlock(block) {
  return Boolean(
    block &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trimStart().startsWith(BB_SYSTEM_INSTRUCTIONS_MARKER)
  );
}

/* ---------- PLUG-291: пользовательские файлы-вложения ---------- */

// Чистка каталогов uploads/downloads при старте: файлы старше maxAgeMs и
// сверх keep последних по mtime удаляются.
export function pruneDir(dir, { maxAgeMs = FILES_MAX_AGE_MS, keep = FILES_KEEP_COUNT, protectedPaths = null } = {}) {
  let removed = 0;
  try {
    if (!existsSync(dir)) return { removed };
    const now = Date.now();
    const ents = readdirSync(dir)
      .map((n) => {
        try {
          return { n, st: statSync(join(dir, n)) };
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.st.isFile() && !(protectedPaths && protectedPaths.has(join(dir, e.n))))
      .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
    let remaining = ents.length;
    for (const e of ents) {
      if (now - e.st.mtimeMs > maxAgeMs || remaining > keep) {
        try {
          unlinkSync(join(dir, e.n));
          removed += 1;
          remaining -= 1;
        } catch {}
      }
    }
  } catch {}
  return { removed };
}

// Корни, в пределах которых разрешена отправка локальных файлов в Gemini:
// cwd сессии + additionalDirectories/roots из session/new|load.
function uploadRootsFor(s) {
  const roots = [];
  const extra = s && Array.isArray(s.roots) ? s.roots : [];
  for (const r of [s && s.cwd, ...extra]) {
    if (typeof r !== "string" || !r.trim()) continue;
    try {
      roots.push(realpathSync(r));
    } catch {}
  }
  return roots;
}

// additionalDirectories/roots из params session/new|load → список каталогов.
// Принимаются строки и объекты { uri: "file://…" }.
function dirRootsFrom(p) {
  const list = [];
  const raw = p
    ? Array.isArray(p.additionalDirectories)
      ? p.additionalDirectories
      : Array.isArray(p.roots)
        ? p.roots
        : []
    : [];
  for (const r of raw) {
    if (typeof r === "string" && r.trim()) {
      list.push(r);
      continue;
    }
    const uri = r && typeof r.uri === "string" ? r.uri : "";
    if (uri.startsWith("file://")) {
      try {
        list.push(decodeURIComponent(new URL(uri).pathname));
      } catch {}
    }
  }
  return list;
}

/**
 * Собрать локальные файлы-вложения из блоков ACP-промпта. Берутся
 * resource_link с uri=file://… и блоки image/localFile/localImage с полем
 * path; URL и не-файловые ресурсы не загружаются. Каждый путь проверяется:
 * существует, обычный файл, ≤ WEB_GEMINI_MAX_UPLOAD_BYTES, внутри корней сессии,
 * не в чёрном списке чувствительных файлов. Ошибка → { error } —
 * session/prompt отвечает JSON-RPC -32602.
 */
export function collectUploadFiles(promptBlocks, s) {
  const cands = [];
  for (const b of promptBlocks || []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "resource_link" && typeof b.uri === "string") {
      if (!b.uri.startsWith("file://")) continue;
      let p;
      try {
        p = decodeURIComponent(new URL(b.uri).pathname);
      } catch {
        continue;
      }
      cands.push(p);
    } else if (
      (b.type === "localFile" || b.type === "localImage" || b.type === "image") &&
      typeof b.path === "string" &&
      b.path.trim()
    ) {
      cands.push(b.path);
    }
  }
  const maxCount = argonMaxUploadCount();
  const maxBytes = argonMaxUploadBytes();
  const roots = uploadRootsFor(s);
  // Относительные path из блоков (image/localFile) резолвятся от cwd
  // сессии, а не от process.cwd() сервера.
  const base = (s && typeof s.cwd === "string" && s.cwd.trim()) || ".";
  const out = [];
  const seen = new Set();
  for (const raw of cands) {
    const abs = resolve(base, raw);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return { error: `upload file not found: ${raw}` };
    }
    if (!st.isFile()) return { error: `upload path is not a file: ${raw}` };
    if (st.size > maxBytes) {
      return {
        error: `upload file too large: ${raw} (${st.size} bytes exceeds limit ${maxBytes} bytes)`,
      };
    }
    let real;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
    const root = roots.find((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep));
    if (!root) return { error: `upload file outside session roots: ${raw}` };
    const rel = relative(root, real);
    if (webTools.isSensitivePath(rel)) {
      return { error: `upload denied to sensitive file: ${rel}` };
    }
    if (seen.has(real)) continue;
    seen.add(real);
    // Лимит считается по уникальным файлам после дедупликации:
    // N блоков на один и тот же файл — это один файл.
    if (out.length >= maxCount) {
      return {
        error: `too many upload files: exceeds limit ${maxCount} (WEB_GEMINI_MAX_UPLOAD_COUNT)`,
      };
    }
    out.push(real);
  }
  return { files: out };
}

/* ---------- classify failure (§3.4) ---------- */

// PLUG-286: driver/page faults — selector and navigation timeouts, page
// crashes, CDP/network drops — are transient browser-session failures, never
// DOM proof that the model is missing. They are rotatable so the turn
// retries on the next account inside the deadline, and parkedReason stays
// null so a repeat surfaces to the caller without parking the account
// (previously such errors could land on 6h model-unavailable).
const DRIVER_TRANSIENT_RE =
  /timeout|timed out|waiting for selector|waiting failed|target (?:closed|crashed|destroyed)|session closed|protocol error|websocket|connection (?:closed|refused|reset)|net::err_|navigation (?:failed|timeout)|frame (?:was )?detached|execution context (?:was destroyed|is not available)|inspected target navigated|browser (?:has been |was )?closed|page crashed|econnrefused|econnreset|socket hang up|failed to become ready|did not start within/i;

export function classifyFailure(err, authHint = null) {
  const message = (err?.message || String(err || "")).trim();

  // 1. auth-dead
  if (
    authHint ||
    /not logged in|sign[- ]in|войти|check login status|auth_required|not authenticated/i.test(message)
  ) {
    return {
      category: "auth-dead",
      cooldownMs: 7 * 24 * 3600_000,
      untilMs: Date.now() + 7 * 24 * 3600_000,
      rotatable: true,
      parkedReason: "auth-dead",
    };
  }

  // 2. transient (stream caps + driver/page faults, PLUG-286, PLUG-371)
  if (
    /generation still running after (?:540|900|\d+)s cap|stream_timeout|argon_stream_timeout|web_gemini_stream_timeout|hung page|stalled generation|generation stalled/i.test(
      message
    ) ||
    (err && (err.code === "WEB_GEMINI_STREAM_TIMEOUT" || err.code === "ARGON_STREAM_TIMEOUT" || err.code === "WEB_GEMINI_STALLED" || err.code === "ARGON_STALLED" || err.name === "TimeoutError")) ||
    DRIVER_TRANSIENT_RE.test(message)
  ) {
    return {
      category: "transient",
      cooldownMs: 0,
      untilMs: 0,
      rotatable: true,
      parkedReason: null,
    };
  }

  // 3. rate-limit
  const parsedReset = parseResetTimeMs(message);
  if (
    parsedReset !== null ||
    /rate-limit|rate limit|quota|limit resets|thinking level unavailable|thinking level is rate-limited|try again later|too many requests|лимит|повторите попытку позже/i.test(
      message
    )
  ) {
    const now = Date.now();
    let untilMs = parsedReset ?? now + 30 * 60_000;
    let cooldownMs = Math.max(0, untilMs - now);
    cooldownMs = Math.min(cooldownMs, 7 * 86_400_000);
    untilMs = now + cooldownMs;
    return {
      category: "rate-limit",
      cooldownMs,
      untilMs,
      rotatable: true,
      parkedReason: null,
    };
  }

  // 4. model-locked (specific model requires subscription / has lock icon)
  if (
    (err && (err.isLocked || err.code === "ARGON_MODEL_LOCKED")) ||
    /locked:\s*paid upgrade required|paid upgrade required/i.test(message)
  ) {
    const rawLocked =
      err?.lockedModel ||
      (message.match(/^(\w+)\s+locked/i)?.[1] || "carbon");
    const lockedModel = (resolveModelId(rawLocked) || String(rawLocked).toLowerCase());
    return {
      category: "model-locked",
      cooldownMs: 0,
      untilMs: 0,
      rotatable: true,
      parkedReason: null,
      lockedModel,
    };
  }

  // 5. model-unavailable — DOM proof only (PLUG-286): the driver raises
  // ModelUnavailable (code) solely on proven absence — item missing from the
  // picker, level disabled/locked, upsell dialog confirmed by the §3.4
  // predicate. The text branch is a fallback for those same errors: a bare
  // "недоступна" without model context (e.g. a nav-error page) is not proof
  // and falls through to default transient.
  if (
    (err && (err.code === "WEB_GEMINI_MODEL_UNAVAILABLE" || err.code === "ARGON_MODEL_UNAVAILABLE")) ||
    /(?:model|thinking)[- ]?unavailable|model is unavailable|not available for this account|модел\w*[^.\n]{0,40}недоступн|недоступн\w*[^.\n]{0,40}модел|недоступн\w* для (?:этого|вашего) аккаунта/i.test(
      message
    )
  ) {
    return {
      category: "model-unavailable",
      cooldownMs: 6 * 3600_000,
      untilMs: Date.now() + 6 * 3600_000,
      rotatable: true,
      parkedReason: "model-unavailable",
    };
  }

  // 6. default transient
  return {
    category: "transient",
    cooldownMs: 0,
    untilMs: 0,
    rotatable: false,
    parkedReason: null,
  };
}

export async function settleBackend(backendId, sessionId, untilMs, message, parkedReason, lockedModel = null, ledgerPath = LEDGER_FILE, lockPath = LOCK_FILE) {
  const owner = `${process.pid}:${sessionId}`;
  return withStateLock((state) => {
    if (state.leases && state.leases[backendId] && state.leases[backendId].pid === process.pid) {
      delete state.leases[backendId];
    }
    const e = accEnsure(state, backendId);
    if (e.owner === owner) {
      e.inUseUntilMs = 0;
      e.owner = null;
    }
    e.lastError = String(message).slice(0, 500);
    if (lockedModel) {
      const canonical = resolveModelId(lockedModel) || String(lockedModel).toLowerCase();
      if (!Array.isArray(e.lockedModels)) e.lockedModels = [];
      if (!e.lockedModels.includes(canonical)) {
        e.lockedModels.push(canonical);
      }
      if (canonical === "carbon") {
        e.tier = "pro";
      }
    }
    if (parkedReason) {
      const enabled = BACKENDS.filter((b) => getAccountPriority(b, state) > 0).length;
      const parked = Object.entries(state.accounts).filter(
        ([k, v]) =>
          k !== backendId &&
          v.parkedReason &&
          (v.cooldownUntilMs ?? 0) > Date.now() &&
          BACKENDS.some((b) => b.id === k && getAccountPriority(b, state) > 0)
      ).length;
      if (enabled > 1 && parked >= enabled - 1) {
        state.breaker = { at: Date.now(), reason: parkedReason, account: backendId };
        return "breaker";
      }
      e.parkedReason = parkedReason;
    }
    if (untilMs > 0) e.cooldownUntilMs = Math.max(e.cooldownUntilMs ?? 0, untilMs);
    return "cooled";
  }, ledgerPath, lockPath);
}

let driver = null;
function getDriver() {
  if (!driver) driver = require("./src/gemini-driver.js");
  return driver;
}

async function fakeTaskReply({ onSubmitted, convId, signal }) {
  onSubmitted?.();
  const wait = Number(process.env.WEB_GEMINI_FAKE_DELAY_MS || process.env.ARGON_FAKE_DELAY_MS) || 0;
  if (wait > 0) await delay(wait, null, { signal });
  return { convId: convId ?? "fake-task", text: 'FAKE_WEB_GEMINI_TASK\n{"verdict":"OK","blockers":0}' };
}

const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stage log: every prompt transition lands here so a silent hang shows its
// exact stage (bindBackend wait, driver call, streaming) — postmortem 17.11.
export const slog = (stage, extra) => {
  try {
    const dir = process.env.WEB_GEMINI_STATE_DIR || process.env.ARGON_STATE_DIR || STATE_DIR;
    appendFileSync(
      join(dir, "acp-server.log"),
      `${new Date().toISOString()} pid=${process.pid} ${stage}${extra ? " " + JSON.stringify(extra) : ""}\n`
    );
  } catch {}
};

// --- process lifecycle & orphan reaper (PLUG-278 / PLUG-274 postmortem) ---
const serverFilePath = fileURLToPath(import.meta.url);
let startupMtime = 0;
try {
  startupMtime = statSync(serverFilePath).mtimeMs;
} catch {}

export function checkStaleCode() {
  if (startupMtime <= 0) return false;
  try {
    const curMtime = statSync(serverFilePath).mtimeMs;
    if (curMtime > startupMtime) {
      slog("server:stale-code-exit", { startupMtime, curMtime });
      void cleanShutdown();
      return true;
    }
  } catch {}
  return false;
}

export function reapOrphanAcpServers() {
  if (process.platform !== "linux") return 0;
  let reaped = 0;
  try {
    const entries = readdirSync("/proc");
    const myPid = process.pid;
    for (const ent of entries) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = Number(ent);
      if (pid === myPid) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmdline.includes("acp-server.mjs")) continue;
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const match = stat.match(/\)\s+[RSDZTW]\s+(\d+)/);
        if (!match) continue;
        const ppid = Number(match[1]);
        if (ppid === 1) {
          slog("reaper:killing-orphan", { pid });
          try {
            process.kill(pid, "SIGTERM");
            reaped++;
          } catch {}
        }
      } catch {}
    }
  } catch (e) {
    slog("reaper:error", { error: String(e) });
  }
  return reaped;
}

// --- managed browser groups (PLUG-374) ---
const backendsOnPort = (port, backends) =>
  backends.filter((b) => String(b.cdp) === String(port));

function hasLiveLeaseForPort(state, port, backends, now) {
  for (const b of backendsOnPort(port, backends)) {
    const l = state.leases && state.leases[b.id];
    if (l && now - (l.acquiredMs || 0) < LEASE_TTL_MS && isPidAlive(l.pid)) return true;
  }
  return false;
}

// The teardown itself is the shared browser-groups pipeline (заход 6):
// decision, `reaping` mark, AND first signal inside the ledger lock AND the
// per-port marker lock: no fresh lease and no concurrent marker write
// (adoption, fresh launch, another reaper) can land between the checks and
// SIGTERM, and the fresh mark keeps leases/adoptions out for the whole grace
// window — the teardown can never race a lease someone just took (§3, з.5).
// Lock order is always ledger → marker; nothing holding the marker lock ever
// waits on the ledger.
async function teardownMarkedGroup(meta, { stateDir, ledgerPath, lockPath, backends, ownOnly = false, ignoreInodes = null }) {
  const withOuterLock = (fn) => {
    acquireLock(lockPath);
    try {
      return fn();
    } finally {
      releaseLock(lockPath);
    }
  };
  const busy = (cur, now) => {
    const state = loadState(ledgerPath);
    return hasLiveLeaseForPort(state, cur.port, backends, now) ? "lease" : null;
  };
  const res = await browserGroups.teardownGroup({
    stateDir,
    port: meta.port,
    meta,
    withOuterLock,
    busy,
    ownOnly,
    ignoreInodes,
    ownerGraceMs: GROUP_STARTUP_GRACE_MS,
  });
  return res.status === "torn-down";
}

export async function reapOrphanBrowserGroups({ stateDir = STATE_DIR, ledgerPath = LEDGER_FILE, lockPath = LOCK_FILE, backends = BACKENDS } = {}) {
  if (process.platform !== "linux") return 0;
  let reaped = 0;
  for (const meta of browserGroups.listMarkers(stateDir)) {
    try {
      const diag = {};
      const identity = browserGroups.identifyGroup(meta, diag);
      if (identity === "boot-unknown") {
        // The marker's boot cannot be verified — it may be ours. Fail
        // closed: no signals, no adoption, no marker deletion (заход 5).
        slog("reaper:browser-group-boot-unknown", { port: meta.port, pgid: meta.pgid, reason: diag.reason });
        continue;
      }
      if (identity === "dead") {
        // Verify-and-unlink under the per-port lock: a marker rewritten
        // meanwhile (fresh launch or adoption on the port) survives.
        browserGroups.withMarkerLock(stateDir, meta.port, () => {
          const cur = browserGroups.readMarker(stateDir, meta.port);
          if (!cur || cur.pgid !== meta.pgid) return;
          if (browserGroups.isReaping(cur)) return; // in-flight teardown owns it
          if (browserGroups.identifyGroup(cur) !== "dead") return;
          browserGroups.removeMarker(stateDir, meta.port);
        });
        continue;
      }
      if (identity === "stale-boot") {
        // The marker describes a group that died with a previous boot — its
        // pgid may now name a foreign group, so only the stale marker is
        // cleaned; processes are never touched (заход 4). Re-verify under
        // the marker lock so a marker rewritten meanwhile (fresh launch on
        // the port) is never lost; 'null' (boot turned indeterminate) and
        // 'true' (rewritten for this boot) both keep the marker (заход 5).
        browserGroups.withMarkerLock(stateDir, meta.port, () => {
          const cur = browserGroups.readMarker(stateDir, meta.port);
          if (!cur || cur.pgid !== meta.pgid) return;
          if (browserGroups.markerMatchesBoot(cur) !== false) return;
          browserGroups.removeMarker(stateDir, meta.port);
        });
        slog("reaper:browser-group-stale", { port: meta.port, pgid: meta.pgid, reason: diag.reason });
        continue;
      }
      if (identity === "doubtful") {
        // Members survive that cannot be attributed to our browser stack —
        // leave the group alone and keep the marker (annotated with the
        // reason) for the next pass. The annotate is serialized: a rewrite
        // since the snapshot is re-verified, not clobbered.
        browserGroups.withMarkerLock(stateDir, meta.port, () => {
          const cur = browserGroups.readMarker(stateDir, meta.port);
          if (!cur || cur.pgid !== meta.pgid) return;
          if (browserGroups.isReaping(cur)) return; // a teardown is in flight
          const reDiag = {};
          if (browserGroups.identifyGroup(cur, reDiag) !== "doubtful") return;
          const reason = reDiag.reason || diag.reason || "unidentified";
          cur.doubt = { reason, sinceMs: cur.doubt?.reason === reason ? cur.doubt.sinceMs : Date.now() };
          try {
            browserGroups.writeMarker(stateDir, cur);
          } catch {}
        });
        slog("reaper:browser-group-doubtful", { port: meta.port, pgid: meta.pgid, ownerPid: meta.ownerPid, reason: diag.reason });
        continue;
      }
      if (await teardownMarkedGroup(meta, { stateDir, ledgerPath, lockPath, backends })) {
        reaped++;
        slog("reaper:browser-group", { port: meta.port, pgid: meta.pgid, ownerPid: meta.ownerPid });
      }
    } catch (e) {
      slog("reaper:browser-group-error", { port: meta && meta.port, error: String(e) });
    }
  }
  return reaped;
}

// Clean shutdown path: tear down groups this process owns — unless someone
// else meanwhile leased the port or external CDP clients are still attached.
// Our own CDP sockets are excluded: the playwright connection outlives the
// last prompt and would otherwise mask the group as busy.
export async function cleanupOwnBrowserGroups({ stateDir = STATE_DIR, ledgerPath = LEDGER_FILE, lockPath = LOCK_FILE, backends = BACKENDS } = {}) {
  if (process.platform !== "linux") return 0;
  const ownInodes = browserGroups.socketInodesOf(process.pid);
  let cleaned = 0;
  for (const meta of browserGroups.listMarkers(stateDir)) {
    try {
      if (meta.ownerPid !== process.pid) continue;
      if (await teardownMarkedGroup(meta, { stateDir, ledgerPath, lockPath, backends, ownOnly: true, ignoreInodes: ownInodes })) {
        cleaned++;
        slog("shutdown:browser-group", { port: meta.port, pgid: meta.pgid });
      }
    } catch (e) {
      slog("shutdown:browser-group-error", { port: meta && meta.port, error: String(e) });
    }
  }
  return cleaned;
}

// Parent-death watchdog: reparented onto init/systemd means bridge parent died
const ownerPpid = process.ppid;
let ppidWatchTicks = 0;
const ppidWatch = setInterval(() => {
  if (process.ppid !== ownerPpid || process.ppid === 1) {
    slog("process:reparented-exit", { ownerPpid, currentPpid: process.ppid });
    void cleanShutdown();
    return;
  }
  if (++ppidWatchTicks % 12 === 0) {
    void reapOrphanBrowserGroups().catch(() => {});
  }
  if (!activePromptSessionId) {
    checkStaleCode();
  }
}, 5_000);
ppidWatch.unref?.();

/* ---------- session state ---------- */
const sessions = new Map();
let sessionCounter = 0;

export function normalizeThinking(val) {
  const v = String(val || "").toLowerCase();
  if (v === "fast" || v === "low") return "low";
  if (v === "pro" || v === "high") return "high";
  return "medium";
}

export const MODELS = [
  { value: "neon", name: "Gemini 4 Neon" },
  { value: "carbon", name: "Gemini 4 Carbon" },
  { value: "hydrogen", name: "Gemini 4 Hydrogen" },
  { value: "pro", name: "Gemini 3.1 Pro" },
  { value: "flash-lite", name: "Gemini 3.5 Flash-Lite" },
];

export function resolveModelId(val) {
  if (!val || typeof val !== "string") return null;
  const v = val.toLowerCase().trim();
  if (v === "fast" || v === "flash" || v === "lite" || v.includes("flash-lite") || v.includes("flash")) return "flash-lite";
  if (v.includes("carbon")) return "carbon";
  if (v.includes("argon") || v.includes("neon")) return "neon";
  if (v.includes("hydrogen")) return "hydrogen";
  if (v.includes("pro")) return "pro";
  const exact = MODELS.find((m) => m.value === v || m.name.toLowerCase() === v);
  if (exact) return exact.value;
  return null;
}

// PLUG-280 §2.1: model↔account compatibility predicate — mirrors the
// runtime checks in pickBackendFromState and bindBackend (lockedModels in
// accounts-state.json + carbon requires the ultra tier).
export function modelSupportedOnAccount(model, b, state) {
  const req = model ? (resolveModelId(model) || String(model).toLowerCase()) : null;
  if (!req || !b) return true;
  const st = state || { accounts: Object.create(null) };
  const e = accEntry(st, b.id);
  if (e?.lockedModels && e.lockedModels.includes(req)) return false;
  if (req === "carbon" && getAccountTier(b, st) !== "ultra") return false;
  return true;
}

// The user's intent is the value just picked; the other axis falls back to
// its default when the combination became incompatible.
function resetAccountForModel(s, backends = BACKENDS) {
  if (!s.account || s.account === "auto") return;
  const b = backends.find((x) => x.id === s.account);
  if (b && !modelSupportedOnAccount(s.model, b, loadState())) {
    s.account = "auto";
    s.backend = null;
    s.convId = null;
  }
}

function resetModelForAccount(s, backends = BACKENDS) {
  if (!s.account || s.account === "auto") return;
  const b = backends.find((x) => x.id === s.account);
  if (b && !modelSupportedOnAccount(s.model, b, loadState())) {
    s.model = "neon";
  }
}

export function configOptionsFor(s, backends = BACKENDS, state = null) {
  const normalizedLevel = normalizeThinking(s.thinking);
  const st = state || { accounts: Object.create(null) };
  const explicit =
    s.account && s.account !== "auto"
      ? backends.find((b) => b.id === s.account) || null
      : null;
  const opts = [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: s.model,
      options: MODELS.filter((m) =>
        explicit
          ? modelSupportedOnAccount(m.value, explicit, st)
          : backends.length === 0 ||
            backends.some((b) => modelSupportedOnAccount(m.value, b, st))
      ).map((m) => ({ value: m.value, name: m.name })),
    },
    {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: normalizedLevel,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];
  if (backends.length > 1) {
    const capable = backends.filter((b) => modelSupportedOnAccount(s.model, b, st));
    let currentAccount = "auto";
    if (explicit && modelSupportedOnAccount(s.model, explicit, st)) {
      currentAccount = explicit.id;
    } else if (capable.length === 1) {
      currentAccount = capable[0].id;
    }
    opts.push({
      id: "account",
      category: "account",
      type: "select",
      currentValue: currentAccount,
      options: [
        { value: "auto", name: "auto" },
        ...capable.map((b) => ({ value: b.id, name: b.id })),
      ],
    });
  }
  return opts;
}

function canWrite(session) {
  const owner = session.thread?.thread;
  const worktree = session.thread?.environment;
  if (!WRITE_LAUNCH || owner?.id !== BB_THREAD_ID || worktree?.managed !== true ||
      worktree.isWorktree !== true || worktree.isGitRepo !== true || !worktree.branchName ||
      (owner.environmentId && worktree.id !== owner.environmentId) ||
      (worktree.projectId && worktree.projectId !== owner.projectId) || !isAbsolute(session.cwd ?? "")) return false;
  try { return realpathSync(session.cwd) === realpathSync(worktree.path); }
  catch { return false; }
}

function sessionMode(session) {
  return canWrite(session) && (session.mode ?? "write") === "write" ? "write" : "read-only";
}

/* ---------- global prompt queue ---------- */
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

class TaskTurnError extends Error {}
// BB's host projector can coalesce updates within 500 ms of opening or
// updating the same item and drop a coalesced update when the item closes.
const BB_PROGRESS_WINDOW_MS = 600;

function turnError(id, outcome, reason, stage = "preflight") {
  slog("task:error", { outcome, reason, stage });
  out({ jsonrpc: "2.0", id, error: {
    code: -32000, message: "[web-gemini:" + outcome + "] " + reason, data: { outcome, reason, stage },
  } });
}

export function createTaskTurn(sessionId) {
  const controller = new AbortController();
  const started = Date.now();
  const sessionCapAt = started + SESSION_CAP_MS;
  let deadline = started + SEND_DEADLINE_MS;
  const toolCallId = "gemini-turn-" + randomUUID();
  const update = (fields) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { toolCallId, ...fields } } });
  let stage = "preflight";
  let interval;
  let closed = false;
  let lastUpdateAt = started;
  let sentOutsideOpenWindow = false;
  let wake;
  const aborted = new Promise((resolve) => { wake = resolve; });
  const stop = (reason) => {
    if (closed || controller.signal.aborted) return;
    controller.abort(reason);
    wake({ cancelled: true });
  };
  let timer;
  let deadlineWatch = null;
  const setDeadline = (value) => {
    deadline = value;
    clearTimeout(timer);
    const remaining = deadline - Date.now();
    if (remaining <= 0) stop("deadline exceeded");
    else {
      timer = setTimeout(() => stop("deadline exceeded"), remaining);
      timer.unref();
    }
    deadlineWatch?.(deadline);
  };
  setDeadline(deadline);
  const progress = (status, message) => {
    if (status === "in_progress") {
      lastUpdateAt = Date.now();
      sentOutsideOpenWindow ||= lastUpdateAt - started >= BB_PROGRESS_WINDOW_MS;
    }
    update({
      sessionUpdate: "tool_call_update", status, content: [{ type: "content", content: {
        type: "text", text: message ?? (stage + " · " + Math.floor((Date.now() - started) / 1000) + "s"),
      } }],
    });
  };
  update({ sessionUpdate: "tool_call", title: "Gemini task", kind: "other", status: "in_progress" });
  progress("in_progress");
  const turn = {
    get stage() { return stage; },
    get deadline() { return deadline; },
    get started() { return started; },
    get sessionCapAt() { return sessionCapAt; },
    setDeadline, signal: controller.signal, aborted, stop, ownedFiles: [],
    pinnedSha: null,
    packageSha256: null,
    get onDeadlineChange() { return deadlineWatch; },
    set onDeadlineChange(fn) { deadlineWatch = typeof fn === "function" ? fn : null; },
    ping(next, extra) {
      if (closed || controller.signal.aborted) return;
      const prevStage = stage;
      stage = typeof next === "object" ? next.stage : next;
      const data = typeof next === "object" ? next : (extra ? { stage, ...extra } : { stage });
      slog("task:stage", { sessionId, ...data });
      // PLUG-371: дедлайн пересчитывается только при смене стадии — heartbeat
      // ping той же стадии не должен сдвигать фазовый лимит. На время
      // генерации действует потолок сессии, при выходе из неё и на
      // verify/commit возвращается окно SEND_DEADLINE_MS.
      if (stage !== prevStage) {
        if (stage === "generation") {
          setDeadline(sessionCapAt);
        } else if (prevStage === "generation" || stage === "verify" || stage === "commit") {
          setDeadline(Math.min(Date.now() + SEND_DEADLINE_MS, sessionCapAt));
        }
      }
      if (turn.journal && turn.journal.turn.stage !== stage) {
        turn.journal.turn.stage = stage;
        try {
          journal.saveTurn(STATE_DIR, turn.journal.sessKey, turn.journal.turn);
        } catch {}
      }
      progress("in_progress");
    },
    heartbeat(ms) {
      clearInterval(interval);
      interval = setInterval(() => turn.ping(stage), ms);
      interval.unref();
    },
    async finish(outcome, reason = "", answerText = null) {
      if (closed) return;
      if (turn.journal) {
        try {
          journal.completeTurn(STATE_DIR, turn.journal.sessKey, turn.journal.turn, { outcome, reason: reason || null, answer: answerText });
        } catch (error) {
          slog("task:journal-error", { sessionId, code: error?.code });
          if (outcome === "passed") throw new TaskTurnError("could not save the final task result");
        }
      }
      closed = true;
      clearInterval(interval);
      clearTimeout(timer);
      slog("task:outcome", {
        sessionId,
        outcome,
        reason: reason || null,
        stage,
        pinnedSha: turn.pinnedSha ?? null,
        packageSha256: turn.packageSha256 ?? null,
      });
      const result = "[web-gemini:" + outcome + "]" + (reason ? " " + reason : "");
      if (outcome === "failed" && controller.signal.reason === "cancelled") {
        progress("in_progress", result);
        await sleep(BB_PROGRESS_WINDOW_MS);
        progress("in_progress", result);
      } else if (outcome === "passed" && !sentOutsideOpenWindow) {
        await sleep(Math.max(0, Math.min(lastUpdateAt + BB_PROGRESS_WINDOW_MS, deadline) - Date.now()));
        progress("in_progress");
      }
      progress(outcome === "passed" ? "completed" : "failed", result);
      for (const file of turn.ownedFiles) {
        try { unlinkSync(file); } catch {}
      }
    },
  };
  turn.heartbeat(15_000);
  return turn;
}

function cancelSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.cancelled = true;
  s.activeTask?.stop("cancelled");
  s._cancelRes?.();
  if (sessions.get(activePromptSessionId) === s) activeAbort?.abort();
}

/* ---------- auth probe on error path ---------- */
async function probeAuthHint(backend) {
  try {
    const pw = getDriver().getPlaywright();
    const browser = await pw.chromium.connectOverCDP(cdpUrlOf(backend));
    try {
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          if (!p.url().includes("gemini.google.com") && !p.url().includes("accounts.google")) continue;
          const st = await p
            .evaluate(() => {
              const onLogin = location.hostname === "accounts.google.com";
              const onApp = location.pathname.startsWith("/app");
              const editor = !!document.querySelector('div[contenteditable="true"][role="textbox"]');
              const cta = [...document.querySelectorAll("a,button")]
                .filter((e) => e.offsetParent !== null)
                .some((e) => /^\s*(sign in|войти)\s*$/i.test((e.innerText || "").trim()));
              return { onLogin, onApp, editor, cta };
            })
            .catch(() => null);
          if (st && !st.editor && (st.onLogin || (st.cta && st.onApp))) {
            return "Gemini web session is NOT authenticated. Complete Google login first.";
          }
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
  } catch {}
  return null;
}

/* ---------- backend binding ---------- */
async function bindBackend(s, sessionId, profile = s, { allowSameBackend = false, excludeId = null } = {}) {
  const owner = `${process.pid}:${sessionId}`;
  const reqModel = profile.model
    ? (resolveModelId(profile.model) || profile.model.toLowerCase())
    : null;

  if (profile.account && profile.account !== "auto") {
    const b = BACKENDS.find((x) => x.id === profile.account);
    if (!b) {
      return { error: `unknown account "${profile.account}" — pool has: ${BACKENDS.map((x) => x.id).join(", ")}` };
    }
    const st = withStateLock((state) => {
      const now = Date.now();
      const e = accEntry(state, b.id);
      const tier = getAccountTier(b, state);
      if (reqModel === "carbon" && tier !== "ultra") {
        return { error: `account "${b.id}" has ${tier} tier and does not support Carbon (Ultra tier required)` };
      }
      if (reqModel && e?.lockedModels?.includes(reqModel)) {
        return { error: `account "${b.id}" does not support model "${reqModel}" (locked: paid upgrade required)` };
      }
      const cool = e?.cooldownUntilMs ?? 0;
      if (cool > now) {
        return { error: `account "${b.id}" is in cooldown until ${new Date(cool).toISOString()}` };
      }
      const activeLease = state.leases && state.leases[b.id];
      if (activeLease && activeLease.pid !== process.pid && now - (activeLease.acquiredMs || 0) < LEASE_TTL_MS && isPidAlive(activeLease.pid)) {
        return { busyUntil: activeLease.acquiredMs + LEASE_TTL_MS, account: b.id };
      }
      const reapUntil = reapingBusyUntil(STATE_DIR, b.cdp, now);
      if (reapUntil > now) return { busyUntil: reapUntil, account: b.id };
      acquireInState(state, b, owner, now);
      return { ok: true };
    });
    if (st.ok) {
      s.backend = b;
      return { backend: b };
    }
    return st;
  }

  const st = withStateLock((state) => {
    const now = Date.now();
    if (s.backend) {
      const e = accEntry(state, s.backend.id);
      const tier = getAccountTier(s.backend, state);
      const isLocked = (reqModel && e?.lockedModels?.includes(reqModel)) || (reqModel === "carbon" && tier !== "ultra");
      const cool = e?.cooldownUntilMs ?? 0;
      const l = state.leases && state.leases[s.backend.id];
      const busy = l && l.pid !== process.pid && now - (l.acquiredMs || 0) < LEASE_TTL_MS && isPidAlive(l.pid);
      const reapUntil = reapingBusyUntil(STATE_DIR, s.backend.cdp, now);
      const reaping = reapUntil > now;

      if (cool <= now && !busy && !isLocked && !reaping) {
        acquireInState(state, s.backend, owner, now);
        return { backend: s.backend };
      }
      const prev = s.backend.id;
      if (s.convId) {
        if (busy) return { busyUntil: l.acquiredMs + LEASE_TTL_MS, account: prev };
        if (reaping) return { busyUntil: reapUntil, account: prev };
        if (isLocked) return { error: `account "${prev}" does not support model "${reqModel}" (tier: ${tier}); this conversation is pinned to it` };
        return { error: `account "${prev}" is in cooldown until ${new Date(cool).toISOString()}; this conversation is pinned to it` };
      }
      const r = pickBackendFromState(state, prev, owner, now, reqModel);
      if (r.backend) {
        acquireInState(state, r.backend, owner, now);
        return { backend: r.backend };
      }
      if (r.busyUntil) return { busyUntil: r.busyUntil };
      if (busy) return { busyUntil: l.acquiredMs + LEASE_TTL_MS, account: prev };
      if (reaping) return { busyUntil: reapUntil, account: prev };
      if (r.none) {
        if (allowSameBackend) {
          const same = BACKENDS.find((b) => b.id === prev);
          const coolUntil = accEntry(state, prev)?.cooldownUntilMs ?? 0;
          if (same && !isLocked && coolUntil <= now && leasedUntil(state, same, owner, now) === 0) {
            acquireInState(state, same, owner, now);
            return { backend: same };
          }
        }
        return { error: reqModel === "carbon" ? "no accounts in pool with Carbon available" : "all accounts are in cooldown or busy and no sibling is free" };
      }
      return { error: `account "${prev}" is in cooldown until ${new Date(cool).toISOString()} and no sibling is free` };
    }

    const r = pickBackendFromState(state, excludeId, owner, now, reqModel);
    if (r.backend) {
      acquireInState(state, r.backend, owner, now);
      return { backend: r.backend };
    }
    if (r.busyUntil) return { busyUntil: r.busyUntil };
    if (r.none) {
      // PLUG-371: ретрай стола — исключённый аккаунт возвращаем только когда
      // свободных соседей в пуле совсем нет.
      if (allowSameBackend && excludeId) {
        const same = BACKENDS.find((b) => b.id === excludeId);
        const e = same ? accEntry(state, same.id) : null;
        const tier = same ? getAccountTier(same, state) : null;
        const sameLocked = Boolean(same) && (
          (reqModel && e?.lockedModels?.includes(reqModel)) ||
          (reqModel === "carbon" && tier !== "ultra")
        );
        if (same && !sameLocked && (e?.cooldownUntilMs ?? 0) <= now && leasedUntil(state, same, owner, now) === 0) {
          acquireInState(state, same, owner, now);
          return { backend: same };
        }
      }
      return { error: reqModel === "carbon" ? "no accounts in pool with Carbon available" : "account pool is empty (no enabled backends)" };
    }
    if (r.cooledUntil) {
      const brk = state.breaker ? ` (breaker: ${state.breaker.reason} on ${state.breaker.account})` : "";
      return { error: `all accounts are in cooldown; nearest reopen ${new Date(r.cooledUntil).toISOString()}${brk}` };
    }
    return { error: "account pool is empty (no enabled backends)" };
  });

  if (st.backend) s.backend = st.backend;
  return st;
}

/* ---------- prompt execution ---------- */
let activeBackendId = null;
let activeAbort = null;
let activeAttempt = null;
let activePromptSessionId = null;

async function runPrompt(id, sessionId, text, attachments = {}) {
  const s = sessions.get(sessionId) ?? {
    model: "neon",
    thinking: "thinking",
    convId: null,
    account: "auto",
    backend: null,
  };
  sessions.set(sessionId, s);
  const upd = (update) =>
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  const { task, context } = attachments;
  const tj = task?.journal;
  const profile = tj?.turn.profile ?? s;
  if (profile?.model) {
    profile.model = resolveModelId(profile.model) || profile.model.toLowerCase();
  }
  if (s.model) {
    s.model = resolveModelId(s.model) || s.model.toLowerCase();
  }
  const budgets = tj?.turn.budgets;
  const maxContextBytes = budgets?.maxTotalBytes ?? context?.settings.maxTotalBytes;
  const maxToolRounds = budgets?.maxToolRounds ?? webTools.MAX_TOOL_ROUNDS;
  const maxRepairRounds = budgets?.maxRepairRounds ?? context?.settings.maxRepairRounds;
  const write = context?.write;
  const writer = context?.writer;

  const persistJournal = (write = () => journal.saveTurn(STATE_DIR, tj.sessKey, tj.turn)) => {
    try {
      write();
    } catch (error) {
      slog("task:journal-error", { sessionId, code: error?.code });
      throw new TaskTurnError("could not update task journal");
    }
  };
  const recordExchange = (entry) => persistJournal(() => journal.appendExchange(STATE_DIR, tj.sessKey, tj.turn, entry));
  // PLUG-351: исход первого файлового ответа учитывается один раз на ход —
  // конверты после запросов исправления в счётчик не входят.
  const recordFirstResponse = (result) => {
    if (!tj?.turn || tj.turn.firstFileResponse) return;
    persistJournal(() => journal.recordFirstFileResponse(STATE_DIR, tj.sessKey, tj.turn,
      { format: fileEnvelope.FORMAT, ...result }));
  };

  const gen = (s.gen || 0) + 1;
  s.gen = gen;
  s.activeGen = gen;
  s.cancelled = false;

  // PLUG-291: локальные файлы-вложения текущего промпта (уже провалидированы
  // в session/prompt через collectUploadFiles) + собранные файлы Gemini.
  const uploadFiles = Array.isArray(attachments.uploadFiles) ? attachments.uploadFiles.slice() : [];
  const turnFiles = [];
  const seenFilePaths = new Set();
  const emitGenerated = (res) => {
    for (const f of (res && res.files) || []) {
      if (!f || !f.path || seenFilePaths.has(f.path)) continue;
      seenFilePaths.add(f.path);
      turnFiles.push(f);
      upd({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "resource_link",
          uri: pathToFileURL(f.path).href,
          name: f.name || basename(f.path),
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
        },
      });
    }
    for (const sk of (res && res.skippedDownloads) || []) {
      upd({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n\n[Файл Gemini пропущен: ${sk.name} — ${sk.reason}]` },
      });
    }
  };

  try {
    // PLUG-281: >~100KB prompts hang execCommand('insertText') in the driver
    // and used to surface as model-unavailable — fail fast BEFORE any
    // lease/park, but inside try so the client gets a -32000, not a dead
    // server (throw above try → void runPrompt() → unhandled rejection).
    const earlyTooLarge = task ? null : promptTooLargeError(text);
    if (earlyTooLarge) throw earlyTooLarge;
    slog("prompt:enqueue", { sessionId, chars: text.length, model: s.model });
    task?.ping("queue");
    let inQueue = true;
    const queued = enqueue(async () => {
      inQueue = false;
      if (s.cancelled || task?.signal.aborted) return { cancelled: true };
      slog("prompt:dequeue", { sessionId });

      if (FAKE && !task) {
        const bound = await bindBackend(s, sessionId);
        if (bound.error) throw new Error(bound.error);
        const backend = bound.backend || BACKENDS[0];
        activeBackendId = backend.id;
        activePromptSessionId = sessionId;
        const abortCtrl = new AbortController();
        activeAbort = {
          abort: () => {
            s.cancelled = true;
            abortCtrl.abort();
          },
        };
        const fakeAttempt = (async () => {
          const chunkText = "FAKE_WEB_GEMINI_ECHO: " + text.slice(0, 80);
          upd({
            sessionUpdate: "agent_message_chunk",
            text: chunkText,
            content: { type: "text", text: chunkText },
          });
          const delayMs = Number(process.env.WEB_GEMINI_FAKE_DELAY_MS || process.env.ARGON_FAKE_DELAY_MS) || 0;
          if (delayMs > 0) {
            const start = Date.now();
            while (Date.now() - start < delayMs) {
              if (s.cancelled || abortCtrl.signal.aborted) break;
              await sleep(20);
            }
          }
          const isCancelled = s.cancelled || abortCtrl.signal.aborted;
          return { cancelled: isCancelled, stopReason: isCancelled ? "cancelled" : "end_turn" };
        })();
        activeAttempt = fakeAttempt;
        try {
          const res = await fakeAttempt;
          return res;
        } finally {
          await releaseLease(backend.id);
          activeBackendId = null;
          activeAbort = null;
          activeAttempt = null;
          activePromptSessionId = null;
        }
      }

      const maxAttempts = Math.min(BACKENDS.length, 3);
      const turnStarted = task?.started ?? Date.now();
      const turnDeadline = task?.deadline ?? (turnStarted + SEND_DEADLINE_MS);
      const sessionCapAt = task?.sessionCapAt ?? (turnStarted + SESSION_CAP_MS);
      const waitDeadline = Math.min(Date.now() + 130_000, turnDeadline);
      let attempts = 0;
      let stallRetries = 0;
      let excludeBackendId = null;
      let lastErr = null;
      let streamedAny = false;

      // §5 web-gemini-tools: первое сообщение нового разговора несёт
      // системную шапку инструментов и упакованные материалы (дифф, файлы,
      // треды, задачи). У существующего разговора (s.convId) текст идёт как есть.
      let collected;
      let packed;
      let messageLimit = webTools.effectiveMessageBytes() - (write ? FILE_CAPTURE_MARKER_BYTES : 0);
      let packageOptions;

      // §7.3: состояние продолжения хода. resumedConv — ход продолжается в
      // прежнем разговоре (первая отправка — напоминание, не пакет);
      // конвертация в повторную доставку одноразовая (resumeFallbackDone).
      let resumedConv = Boolean(task?.resume?.convId);
      let convVerify = resumedConv;
      let resumeFallbackDone = false;
      // Повторная доставка «продолжай»: сохранённый пакет целиком + обмены
      // хода + поручение. При переполнении лимита пакет+обмены уходят
      // spill-файлом, поручение обязано поместиться (§5.2).
      const buildRedelivery = (instruction) => {
        const stored = task.resume.pkg;
        const isLight = context.research && !write;
        let prior;
        try {
          prior = journal.readExchanges(STATE_DIR, tj.sessKey, tj.turn.turnNo)
            .map((entry) => isLight ? context.settings.maskResearch(entry.text, context.key) : context.settings.mask(entry.text))
            .filter(Boolean).join("\n");
        } catch {
          throw new TaskTurnError("recovery: saved exchange log is missing or corrupt");
        }
        if (task.resume.exact && !prior && Buffer.byteLength(stored.message) <= messageLimit) return stored;
        const heading = isLight ? "\n\n" : "\n\n=== Продолжение прерванного хода / Resumed turn ===\n";
        const tail = isLight ? (instruction ? "\n\n" + instruction : "") : ("=== Поручение / Instruction ===\n" + instruction);
        let extraFiles = [];
        let message = stored.message + heading + (prior ? prior + "\n\n" : "") + tail;
        if (Buffer.byteLength(message) > messageLimit) {
          const spill = webTools.writeSpillPackage(UPLOADS_DIR, randomUUID(), stored.message + heading + prior);
          task.ownedFiles.push(spill.pkgPath);
          extraFiles = [spill.pkgPath];
          message = isLight
            ? (SEARCH_DIRECTIVE + "\n\nRead the entire task in the attached " + spill.pkgName + "." + (instruction ? "\n\n" + instruction : ""))
            : ("Resume the interrupted task: the complete saved package and prior tool results are in the attached " +
              spill.pkgName + ".\n\n" + tail);
        }
        if (Buffer.byteLength(message) > messageLimit) {
          throw new TaskTurnError("recovery: saved instruction does not fit the web textbox limit");
        }
        const fileBytes = [...stored.files, ...extraFiles].reduce((total, path) => {
          try { return total + statSync(path).size; } catch { return total; }
        }, 0);
        const totalBytes = Buffer.byteLength(message) + fileBytes;
        return { message, files: [...stored.files, ...extraFiles], packageSha256: stored.packageSha256, totalBytes };
      };
      const redeliveryPackage = () => buildRedelivery(task.resume.instruction);
      // Конвертация продолжения в повторную доставку: разговор недоступен —
      // новый чат получает сохранённый пакет (§7.3), не пустой промпт.
      const switchToRedelivery = (reason) => {
        resumeFallbackDone = true;
        resumedConv = false;
        convVerify = false;
        s.convId = null;
        s.backend = null;
        task.resume.convId = null;
        tj.turn.convId = null;
        persistJournal();
        packed = redeliveryPackage();
        slog("task:resume-redeliver", { sessionId, turnNo: task.journal?.turn?.turnNo, reason });
      };

      if (task) {
        task.ping("collect");
        try {
          if (task.resume) {
            // §7.3: продолжение хода — пакет берётся из записи журнала
            // (целостность проверена loadTurnPackage); diff для инструментов
            // перечитывается по записанному в ходе закреплённому SHA.
            collected = { reviewDiff: null };
            if (context.pin) {
              const diffs = await collectDiff(context.root, context.pin, context.settings.maxTotalBytes, task.signal);
              collected.reviewDiff = diffs.length ? Object.freeze({ stat: diffs[0].stat, patch: diffs[0].patch }) : null;
            }
            if (!resumedConv) packed = redeliveryPackage();
            task.packageSha256 = task.resume.pkg.packageSha256;
            slog("task:package-resume", { sessionId, packageSha256: task.packageSha256, turnNo: tj.turn.turnNo });
          } else {
            packageOptions = { ...taskAttachmentOptions(s, task), limit: messageLimit, reserveBytes: write ? FILE_CAPTURE_MARKER_BYTES : 0, isFirstTurn: !s.convId };
            const materials = attachments.materials ?? await collectTaskAttachments(context, attachments.blocks, packageOptions);
            tj.turn.taskSha256 = taskInputSha256(tj.turn.inputBlocksSha256, materials);
            tj.turn.attempts[0].inputSha256 = tj.turn.taskSha256;
            collected = await collectTask(context, attachments.blocks, materials, packageOptions);
            packed = packTask(context, collected, packageOptions);
            // PLUG-384: публичный research без локального инвентаря —
            // быстрый агент по дереву не запускается.
            if (context.settings.innerAgent && (context.root || context.pin) && !context.research) {
              const agent = await gatherAgentContext(context, collected.core, {
                signal: task.signal,
                maxExtraBytes: context.settings.maxTotalBytes - packed.totalBytes - packageOptions.reserveBytes,
                onStage: (stage, extra) => task.ping(stage, extra),
                onToolStart: (name) => {
                  const toolCallId = "gemini-fast-" + randomUUID();
                  upd({ sessionUpdate: "tool_call", toolCallId, title: "Fast agent · " + name,
                    kind: webTools.toolKind(name), status: "in_progress" });
                  return toolCallId;
                },
                onToolEnd: (toolCallId, ok) => {
                  upd({ sessionUpdate: "tool_call_update", toolCallId, status: ok ? "completed" : "failed" });
                },
              });
              if (agent.supplements.length || agent.omitted.length || agent.gateway) {
                collected = { ...collected, agent };
                packed = packTask(context, collected, packageOptions);
                if (packed.agentDeliveryLimited) task.ping("fast_agent_delivery_limit");
              }
              if (agent.failover && agent.gateway) {
                slog("task:fast-agent-failover", { sessionId, gateway: agent.gateway, index: agent.gatewayIndex });
                if (task.journal) {
                  task.journal.turn.fastAgentGateway = agent.gateway;
                  try {
                    journal.saveTurn(STATE_DIR, task.journal.sessKey, task.journal.turn);
                  } catch {}
                }
              }
            }
            task.packageSha256 = packed.packageSha256;
            // §7.2: пакет сохраняется в журнал до доставки — повторная
            // доставка после рестарта шлёт именно его, а не пустой промпт.
            if (task.journal) {
              journal.stageTurnPackage(STATE_DIR, task.journal.sessKey, task.journal.turn, packed);
            }
            slog("task:package", { sessionId, packageSha256: packed.packageSha256, totalBytes: packed.totalBytes });
          }
        } catch (error) {
          if (task.signal.aborted) return { cancelled: true };
          const reason = error.code ? "could not read or stage mandatory task materials" : error.message;
          throw new TaskTurnError(context.settings.mask(reason));
        }
      } else {
        packed = s.convId
          ? { message: text }
          : webTools.packFirstMessage({
            text,
            cwd: s.cwd,
            embeddedResources: attachments.embeddedResources ?? [],
            // PLUG-291: материалы сверх лимита первого сообщения уходят
            // .md-файлом в uploads/ и прикладываются как веб-вложение.
            spillDir: UPLOADS_DIR,
            spillId: sessionId,
            repo: Boolean(s.cwd),
          });
      }
      // Spill-пакет идёт сверх WEB_GEMINI_MAX_UPLOAD_COUNT и без проверки
      // WEB_GEMINI_MAX_UPLOAD_BYTES: это наш сгенерированный .md с материалами
      // задачи, его доставка обязательна; лимиты выше — про пользовательские
      // пути на валидации collectUploadFiles.
      if (packed?.spilledFile) uploadFiles.push(packed.spilledFile);

      while (true) {
        if (s.cancelled || task?.signal.aborted) return { cancelled: true };
        const bound = await bindBackend(s, sessionId, profile, { allowSameBackend: stallRetries > 0, excludeId: excludeBackendId });
        if (bound.error) {
          if (task?.resume?.convId && s.convId && !resumeFallbackDone) {
            // Прежний backend недоступен — повторная доставка в новый чат.
            switchToRedelivery("backend-unavailable");
            continue;
          }
          slog("bind:error", { sessionId, error: bound.error });
          throw new Error(bound.error);
        }
        if (bound.busyUntil) {
          task?.ping("queue");
          if (s.cancelled || task?.signal.aborted) return { cancelled: true };
          if (Date.now() >= waitDeadline) {
            throw new Error(`account "${bound.account || "picked"}" is busy until ${new Date(bound.busyUntil).toISOString()}`);
          }
          slog("bind:busy", { sessionId, account: bound.account, busyUntil: new Date(bound.busyUntil).toISOString() });
          const wakeAt = Math.min(Date.now() + Math.max(bound.busyUntil - Date.now() + 500, 3000), Date.now() + 15_000);
          while (!s.cancelled && !task?.signal.aborted && Date.now() < wakeAt) await sleep(500);
          continue;
        }
        if (s.cancelled || task?.signal.aborted || Date.now() >= turnDeadline) {
          if (bound.backend) await releaseLease(bound.backend.id);
          if (s.cancelled || task?.signal.aborted) return { cancelled: true };
          throw new TaskTurnError("deadline exceeded");
        }

        const backend = bound.backend;
        activeBackendId = backend.id;
        activePromptSessionId = sessionId;
        const abortCtrl = new AbortController();
        activeAbort = { abort: () => abortCtrl.abort() };

        const renew = setInterval(() => {
          try {
            withStateLock((state) => {
              if (state.leases && state.leases[backend.id] && state.leases[backend.id].pid === process.pid) {
                state.leases[backend.id].acquiredMs = Date.now();
              }
            });
          } catch {}
        }, 60_000);
        renew.unref?.();

        const mappedThinking = normalizeThinking(profile.thinking);
        const attempt = (async () => {
          try {
            const sendWebPrompt = task && FAKE ? fakeTaskReply : getDriver().sendPrompt;
            // PLUG-291: пользовательские файлы идут веб-вложениями первой
            // отправкой попытки (перед вставкой текста, без insertText);
            // при ротации на новый чат файлы прикладываются заново.
            let filesPending = task ? (resumedConv ? null : [...packed.files]) : uploadFiles.length ? uploadFiles.slice() : null;
            let delivered = resumedConv;
            const toolLimit = Math.min(webTools.MAX_TOOL_RESULT_BYTES, webTools.effectiveMessageBytes());
            const contract = task ? taskInstruction(context) : "";
            // §3 Tool Loop: все раунды — в том же convId на том же бэкенде,
            // лиз удерживается до конца хода.
            const sendOnce = async (message, canRepack = true) => {
              const originalMessage = message;
              let outboundBytes = 0;
              if (task) {
                if (task.signal.aborted) throw Object.assign(new Error("prompt cancelled"), { code: "ARGON_CANCELLED" });
                if (delivered && !s.convId) throw new TaskTurnError("web conversation identity is missing for the follow-up");
                outboundBytes = delivered ? Buffer.byteLength(message) : packed.totalBytes;
                if (delivered && Buffer.byteLength(message) > messageLimit) {
                  if (outboundBytes > maxContextBytes - budgets.contextBytes) throw new TaskTurnError("tool follow-up exceeds remaining context budget");
                  let spill;
                  try {
                    spill = webTools.writeSpillPackage(UPLOADS_DIR, randomUUID(), message);
                  } catch {
                    throw new TaskTurnError("could not stage complete tool results");
                  }
                  task.ownedFiles.push(spill.pkgPath);
                  filesPending = [spill.pkgPath];
                  message = "Read the complete tool results and instructions in " + spill.pkgName + ".";
                  outboundBytes += Buffer.byteLength(message);
                }
                if (outboundBytes > maxContextBytes - budgets.contextBytes) {
                  throw new TaskTurnError(task.resume
                    ? "recovery: saved task context exceeds remaining byte budget"
                    : "outgoing task context exceeds byte budget");
                }
              }
              // PLUG-281/§4.1: каждый уходящий в Gemini текст (первое
              // упакованное сообщение, блоки результатов инструментов,
              // принудительный финал) проверяется до отправки — это ошибка
              // вызывающего, драйвер повторяет проверку последним рубежом.
              let fileCapture;
              if (write) {
                const marker = "BBG_DELIVERY_" + randomBytes(16).toString("hex");
                const prefix = marker + "\n\n";
                if (outboundBytes + Buffer.byteLength(prefix) > maxContextBytes - budgets.contextBytes) {
                  throw new TaskTurnError("outgoing file response instructions exceed the context budget");
                }
                outboundBytes += Buffer.byteLength(prefix);
                message = prefix + message;
                fileCapture = { nonce: write.nonce, marker };
              }
              const tooLargeMsg = promptTooLargeError(message);
              if (tooLargeMsg) throw tooLargeMsg;
              if (task) {
                // Charge before the driver can submit. A crash during generation
                // must not let the next attempt spend the same budget again.
                budgets.contextBytes += outboundBytes;
                persistJournal();
                task.ping("delivery");
              }
              slog("driver:send", {
                sessionId,
                account: backend.id,
                model: profile.model,
                thinking: mappedThinking,
                chars: message.length,
                convId: s.convId || null,
              });
              const request = {
                prompt: message,
                model: profile.model,
                thinking: mappedThinking,
                convId: s.convId,
                isNewChat: !s.convId,
                headless: HEADLESS,
                profile: backend.profileDir || backend.profile || backend.id,
                cdpPort: backend.cdp,
                strict: true,
                strictModel: true,
                signal: abortCtrl.signal,
                files: filesPending,
                sessionId,
                downloadsDir: task ? null : DOWNLOADS_DIR,
                requireFullDelivery: Boolean(task),
                onSubmitted: task ? () => task.ping("generation") : null,
                shouldCancel: () => s.cancelled || abortCtrl.signal.aborted || task?.signal.aborted || s.activeGen !== gen,
                backend: backend,
                accountId: backend.id,
                tier: backend.tier,
                stateDir: STATE_DIR,
                // §7.3: проверяемое восстановление — драйвер подтверждает,
                // что страница осталась тем же разговором.
                verifyConversation: convVerify,
                ...(fileCapture ? { fileCapture } : {}),
                onChunk: task ? null : (c) => {
                  if (c && !s.cancelled && s.activeGen === gen) {
                    streamedAny = true;
                    upd({
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: c },
                    });
                  }
                },
              };
              let res;
              try {
                res = await sendWebPrompt(request);
              } catch (error) {
                if (task && (error.code === "WEB_GEMINI_STALLED" || error.code === "ARGON_STALLED" || /generation stalled|stalled generation/i.test(error?.message || ""))) {
                  budgets.contextBytes = Math.max(0, budgets.contextBytes - outboundBytes);
                  persistJournal();
                }
                // §7.3: сохранённый разговор недоступен (редирект на новый
                // чат) — одноразовая конвертация в повторную доставку
                // сохранённого пакета с обменами хода.
                if (task && resumedConv && error.code === "WEB_GEMINI_CONVERSATION_LOST" && !resumeFallbackDone) {
                  budgets.contextBytes -= outboundBytes;
                  switchToRedelivery("conversation-lost");
                  delivered = false;
                  filesPending = [...packed.files];
                  task.ping("delivery");
                  return sendOnce(packed.message, false);
                }
                if (task && error.code === "WEB_GEMINI_PROMPT_TOO_LARGE") {
                  // The driver reports maxlength before uploading anything.
                  budgets.contextBytes -= outboundBytes;
                  persistJournal();
                }
                const smallerLimit = error?.maxPromptBytes - (write ? FILE_CAPTURE_MARKER_BYTES : 0);
                if (!task || !canRepack || error.code !== "WEB_GEMINI_PROMPT_TOO_LARGE" ||
                    !Number.isSafeInteger(smallerLimit) || smallerLimit <= 0 ||
                    smallerLimit >= messageLimit) throw error;
                messageLimit = smallerLimit;
                if (!delivered) {
                  try {
                    if (task.resume) {
                      // Повторная доставка собирается из сохранённого пакета —
                      // перепаковывается под новый лимит только её обёртка.
                      packed = redeliveryPackage();
                    } else {
                      packed = packTask(context, collected, { ...packageOptions, limit: messageLimit });
                      if (packed.agentDeliveryLimited) task.ping("fast_agent_delivery_limit");
                      if (task.journal) {
                        journal.stageTurnPackage(STATE_DIR, task.journal.sessKey, task.journal.turn, packed);
                      }
                    }
                    task.packageSha256 = packed.packageSha256;
                    slog("task:package", { sessionId, packageSha256: packed.packageSha256, totalBytes: packed.totalBytes });
                  } catch {
                    throw new TaskTurnError("mandatory task context could not be delivered within the web textbox limit");
                  }
                }
                filesPending = delivered ? null : [...packed.files];
                return sendOnce(delivered ? originalMessage : packed.message, false);
              }
              filesPending = null;
              if (task) delivered = true;
              convVerify = false;
              if (res && res.convId) {
                s.convId = res.convId;
                s.backend = backend;
              }
              if (tj && res) {
                const reply = res.rawText?.trim() ? res.rawText : res.text;
                if (reply && (!write || fileEnvelope.isFileToolReply(reply))) {
                  recordExchange({ kind: "reply", text: context.settings.mask(reply) });
                }
                tj.turn.delivered = true;
                if (res.convId) {
                  tj.turn.convId = res.convId;
                  tj.turn.backendId = backend.id;
                }
                persistJournal();
                if (res.convId) persistJournal(() => journal.saveSessionRecord(STATE_DIR, tj.entry, { convId: res.convId, backendId: backend.id }));
              }
              if (!task) emitGenerated(res);
              slog("driver:done", { sessionId, convId: s.convId || null, streamedAny });
              return res;
            };
            let loop;
            if (task && context.research && !write) {
              const firstMessage = resumedConv ? [task.resume.instruction, write ? contract : ""].filter(Boolean).join("\n\n") : packed.message;
              const res = await sendOnce(firstMessage);
              const raw = typeof res?.rawText === "string" && res.rawText.trim() ? res.rawText : null;
              loop = { cancelled: false, forcedFinal: false, finalText: String(raw ?? res?.text ?? res ?? ""), rounds: 1, executed: [], lastRes: res };
            } else {
              let toolSeq = 0;
              loop = await webTools.runToolLoop({
                firstMessage: task ? (resumedConv ? [task.resume.instruction, write ? contract : ""].filter(Boolean).join("\n\n") : packed.message)
                  : s.convId ? text : packed.message,
                send: sendOnce,
                execute: (call) => task ? taskTool(context, collected, call, toolLimit, task.signal) : webTools.executeTool(call, { cwd: s.cwd }),
                onToolRound: task ? (_round, forcedFinal) => {
                  if (!forcedFinal) {
                    budgets.toolRounds = (budgets.toolRounds ?? 0) + 1;
                    persistJournal();
                  }
                  task.ping("request_more");
                } : null,
                ...(task ? {
                  formatResult: (call, result) => {
                    const formatted = formatTaskToolResult(context, call, result);
                    recordExchange({ kind: "tool-result", name: call.name, ok: result.ok !== false, text: formatted });
                    return formatted;
                  },
                } : {}),
                ...(write ? { toolText: (text) => fileEnvelope.isFileToolReply(text) ? text : "" } : {}),
                onToolStart: (call) => {
                  const toolCallId = task ? "gemini-read-" + randomUUID() : "argtool-" + (++toolSeq);
                  upd({
                    sessionUpdate: "tool_call",
                    toolCallId,
                    title: task ? context.settings.mask(webTools.toolTitle(call)) : webTools.toolTitle(call),
                    kind: webTools.toolKind(call.name),
                    status: "in_progress",
                    ...(task ? {} : { rawInput: { name: call.name, args: call.args } }),
                  });
                  return toolCallId;
                },
                onToolEnd: (toolCallId, call, r) => {
                  upd({
                    sessionUpdate: "tool_call_update",
                    toolCallId,
                    status: r.ok ? "completed" : "failed",
                    content: [
                      {
                        type: "content",
                        content: { type: "text", text: String(r.output ?? "").slice(0, 2000) },
                      },
                    ],
                  });
                },
                maxRounds: Math.max(0, maxToolRounds - (budgets?.toolRounds ?? 0)),
                isCancelled: () => s.cancelled || abortCtrl.signal.aborted || task?.signal.aborted,
              });
            }
            if (loop.cancelled) {
              const e = new Error("prompt cancelled by user");
              e.code = "ARGON_CANCELLED";
              throw e;
            }
            if (task) {
              let candidate = loop.lastRes;
              for (;;) {
                task.ping("verify");
                let final;
                if (write) {
                  const capture = candidate?.fileResponse;
                  const checked = fileEnvelope.verifyFileResponse(capture, write.nonce);
                  if (checked.plan) {
                    try {
                      const { files, commitMessage } = checked.plan;
                      if ([commitMessage, ...files.flatMap(({ path, content }) => [path, content ?? ""])]
                        .some((value) => context.settings.maskResponse(value) !== value)) {
                        const denied = new Error("file response contains material prohibited for publication");
                        denied.prohibited = true;
                        throw denied;
                      }
                      await writer.plan(context.writeHead, checked.plan, write.allowedPaths, new Map(write.bases));
                    } catch (error) {
                      if (error.writeEnv) {
                        // Эксплуатационный сбой среды записи: ответ модели ни при
                        // чём и запрос исправления его не исправит — ход
                        // завершается ошибкой, в счётчик идёт отдельный код.
                        slog("task:write-env", { sessionId, error: String(error.message ?? error).slice(0, 300) });
                        recordFirstResponse({ outcome: "rejected", code: "write-env" });
                        throw new TaskTurnError("write environment failed: " + context.settings.mask(error.message));
                      }
                      checked.repair = error.code ? "file plan could not be verified" : context.settings.mask(error.message);
                      checked.code = error.prohibited ? "prohibited-content" : error.code ? "plan-error" : "plan-verify";
                    }
                    if (!checked.repair) {
                      recordFirstResponse({ outcome: "accepted" });
                      task.signal.throwIfAborted();
                      persistJournal(() => journal.stageFileResponse(STATE_DIR, tj.sessKey, tj.turn, capture, checked.plan));
                      return { envelope: checked.plan };
                    }
                  }
                  final = { repair: checked.repair ?? checked.recapture, plan: checked.plan };
                  recordFirstResponse({ outcome: "rejected", code: checked.code ?? "unknown" });
                } else final = checkedAnswer(context, candidate);
                if (final.text !== undefined) return { text: final.text };
                if (final.denied) throw new TaskTurnError(final.denied);
                if ((budgets.repairRounds ?? 0) >= maxRepairRounds) throw new TaskTurnError(final.repair);
                task.ping("request_more");
                const repairMessage = "Correct the previous reply. " + final.repair + ". " +
                  (write ? fileRepairInstruction(context, candidate, final.plan)
                    : "Return the complete publishable final answer without tool calls or file envelopes.\n") + contract;
                budgets.repairRounds = (budgets.repairRounds ?? 0) + 1;
                persistJournal();
                recordExchange({ kind: "repair", text: repairMessage });
                candidate = await sendOnce(repairMessage);
              }
            }
            // PLUG-291: текстовая строка-указатель на скачанные файлы —
            // resource_link-чанки уже отправлены выше, здесь видимая
            // человеку сводка со ссылками file://.
            if (turnFiles.length) {
              const links = turnFiles
                .map((f) => `[${f.name || basename(f.path)}](${pathToFileURL(f.path).href})`)
                .join(" · ");
              upd({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `\n\nФайлы Gemini: ${links}` },
              });
            }
            return loop.lastRes ?? { text: loop.finalText };
          } finally {
            clearInterval(renew);
          }
        })();
        activeAttempt = attempt;

        // PLUG-371: дедлайн попытки следует за task.deadline — при переходе в
        // generation он растёт до потолка сессии, при выходе обратно сжимается
        // до фазового окна (task.onDeadlineChange из createTaskTurn).
        let attemptDeadlineIsCap = false;
        let resolveDeadline;
        const deadlineP = new Promise((res) => { resolveDeadline = res; });
        let deadlineTimer;
        const armAttemptDeadline = () => {
          clearTimeout(deadlineTimer);
          const limit = task ? task.deadline : turnDeadline;
          attemptDeadlineIsCap = limit >= sessionCapAt;
          const rem = limit - Date.now();
          if (rem <= 0) {
            resolveDeadline("deadline");
            return;
          }
          deadlineTimer = setTimeout(() => resolveDeadline("deadline"), rem);
          deadlineTimer.unref?.();
        };
        if (task) task.onDeadlineChange = armAttemptDeadline;
        armAttemptDeadline();

        const outcome = await Promise.race([
          attempt.then(() => "done", () => "failed"),
          new Promise((res) => {
            s._cancelRes = () => res("cancelled");
          }),
          deadlineP,
        ]);
        clearTimeout(deadlineTimer);
        if (task) task.onDeadlineChange = null;
        s._cancelRes = null;

        if (outcome === "cancelled") {
          abortCtrl.abort();
          if (s.activeGen === gen) s.cancelled = true;
          await Promise.race([attempt.catch(() => {}), sleep(15_000)]);
          await releaseLease(backend.id);
          activeBackendId = null;
          activeAbort = null;
          activeAttempt = null;
          activePromptSessionId = null;
          return { cancelled: true };
        }
        if (outcome === "deadline") {
          abortCtrl.abort();
          await Promise.race([attempt.catch(() => {}), sleep(15_000)]);
          await releaseLease(backend.id);
          activeBackendId = null;
          activeAbort = null;
          activeAttempt = null;
          activePromptSessionId = null;
          throw new Error(`turn exceeded ${attemptDeadlineIsCap ? `${SESSION_CAP_MS / 3600000}h session cap` : `${SEND_DEADLINE_MS / 60000}min deadline`}`);
        }

        try {
          const r = await attempt;
          await releaseLease(backend.id);
          activeBackendId = null;
          activeAbort = null;
          activeAttempt = null;
          activePromptSessionId = null;
          return r;
        } catch (err) {
          lastErr = err;
          slog("driver:error", {
            sessionId,
            account: backend.id,
            error: task ? "task request failed" : (err?.message ? String(err.message).slice(0, 300) : String(err)),
            code: err && err.code,
          });
          if (err && (err.code === "WEB_GEMINI_CANCELLED" || err.code === "ARGON_CANCELLED")) {
            await releaseLease(backend.id);
            activeBackendId = null;
            activeAbort = null;
            activeAttempt = null;
            activePromptSessionId = null;
            return { cancelled: true };
          }
          // PLUG-281: oversized prompt is the caller's error, not the
          // account's — release the lease, never probe/rotate/cool down.
          if (err instanceof TaskTurnError || (err && ["WEB_GEMINI_PROMPT_TOO_LARGE", "ARGON_PROMPT_TOO_LARGE", "WEB_GEMINI_DELIVERY_FAILED"].includes(err.code))) {
            await releaseLease(backend.id);
            activeBackendId = null;
            activeAbort = null;
            activeAttempt = null;
            activePromptSessionId = null;
            if (task && !(err instanceof TaskTurnError)) throw new TaskTurnError("mandatory task context could not be delivered to the web model");
            throw err;
          }
          const hint = await (task ? Promise.race([probeAuthHint(backend), task.aborted.then(() => null)]) : probeAuthHint(backend));
          const cls = classifyFailure(err, hint);
          const cooled = await settleBackend(backend.id, sessionId, cls.untilMs, task ? "task request failed" : hint || err.message, cls.parkedReason, cls.lockedModel);
          activeBackendId = null;
          activeAbort = null;
          activeAttempt = null;
          activePromptSessionId = null;
          attempts += 1;

          const isStalled = Boolean(
            err && (err.code === "WEB_GEMINI_STALLED" || err.code === "ARGON_STALLED" || /generation stalled|stalled generation/i.test(err.message || ""))
          );

          // PLUG-371: один авторетрай в рамках хода при stalled, если остаётся >25% бюджета SEND_DEADLINE.
          // При s.convId ретрай запрещён — рестарт tool-loop ушёл бы в чужой начатый разговор.
          const remainingPhaseBudget = (turnStarted + SEND_DEADLINE_MS) - Date.now();
          const hasStallBudget = remainingPhaseBudget > 0.25 * SEND_DEADLINE_MS;
          const canStallRetry = isStalled && stallRetries < 1 && hasStallBudget && !streamedAny && !s.convId && cooled !== "breaker";

          const canRotate =
            (canStallRetry || (
              !isStalled &&
              profile.account === "auto" &&
              attempts < maxAttempts &&
              cls.rotatable &&
              !s.convId
            )) &&
            !streamedAny &&
            cooled !== "breaker";

          if (isStalled) {
            if (canStallRetry) {
              stallRetries += 1;
              excludeBackendId = backend.id;
              slog("task:stall-retry", { sessionId, attempt: attempts, remainingBudget: remainingPhaseBudget });
            } else {
              if (hint) err.authHint = hint;
              throw err;
            }
          } else if (!canRotate) {
            if (hint) err.authHint = hint;
            throw err;
          }
          s.backend = null;
        }
      }
      throw lastErr;
    });
    let result = task
      ? await Promise.race([queued, task.aborted.then((value) => inQueue ? value : queued)])
      : await queued;

    if (!isExiting) {
      const isCancelled = Boolean(result && (result.cancelled || result.stopReason === "cancelled"));
      if (task) {
        if (task.signal.reason === "deadline exceeded") throw new TaskTurnError("deadline exceeded");
        if (isCancelled || task.signal.aborted) await task.finish("failed", "cancelled");
        else {
          if (result.envelope) {
            try {
              task.applying = writer.apply({
                head: context.writeHead, envelope: result.envelope, allowedPaths: write.allowedPaths,
                issuedBases: new Map(write.bases), owner: { sessKey: tj.sessKey, turnNo: tj.turn.turnNo },
                signal: task.signal, progress: (stage) => task.ping(stage),
                checkpoint: (owner, receipt) => {
                  journal.checkpointWrite(STATE_DIR, owner, receipt);
                  if (receipt) tj.turn.commit = receipt;
                  else delete tj.turn.commit;
                },
              });
              const sha = await task.applying;
              result = { text: writeResult(context.writeHead.branch, sha) };
            } catch (error) {
              if (task.signal.reason === "cancelled" && !error.message?.startsWith("recovery_required:")) {
                await task.finish("failed", "cancelled");
                out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
                return;
              }
              throw new TaskTurnError(context.settings.mask(error.code ? "file transaction failed" : error.message ?? String(error)));
            } finally {
              task.applying = null;
            }
          }
          await task.finish("passed", "", result.text);
          upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.text } });
        }
      }
      out({
        jsonrpc: "2.0",
        id,
        result: {
          stopReason: isCancelled || (task?.signal.aborted && !tj?.turn.commit) ? "cancelled" : "end_turn",
          ...(turnFiles.length
            ? {
                attachments: turnFiles.map((f) => ({
                  type: "resource_link",
                  uri: pathToFileURL(f.path).href,
                  name: f.name || basename(f.path),
                  ...(f.mimeType ? { mimeType: f.mimeType } : {}),
                })),
              }
            : {}),
        },
      });
    }
    if (s.activeGen === gen) s.activeGen = null;
  } catch (err) {
    if (s.activeGen === gen) s.activeGen = null;
    if (!isExiting) {
      // PLUG-281: caller-side refusal — report verbatim, no driver framing.
      if (task) {
        const isStalled = Boolean(
          err && (err.code === "WEB_GEMINI_STALLED" || err.code === "ARGON_STALLED" || /generation stalled|stalled generation/i.test(err.message || ""))
        );
        const reason = task.signal.reason === "deadline exceeded" && !err.message?.startsWith("recovery_required:") ? "deadline exceeded" :
          isStalled ? "stalled" :
          err instanceof TaskTurnError ? err.message : "web model request failed at " + task.stage;
        if (tj && reason.startsWith("recovery_required:")) tj.turn.recoveryRequired = true;
        await task.finish("failed", reason);
        turnError(id, "failed", reason, task.stage);
      } else if (err && (err.code === "WEB_GEMINI_PROMPT_TOO_LARGE" || err.code === "ARGON_PROMPT_TOO_LARGE")) {
        out({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } });
      } else {
        const hint = FAKE ? null : (err.authHint ?? (s.backend ? await probeAuthHint(s.backend) : null));
        const msg = hint ? `${hint}\n\n(driver error: ${err.message})` : `Gemini web driver error: ${err.message}`;
        out({ jsonrpc: "2.0", id, error: { code: -32000, message: msg } });
      }
    }
  } finally {
    if (task && s.activeTask === task) s.activeTask = null;
  }
}

/* ---------- shutdown handlers ---------- */
let isExiting = false;
async function cleanShutdown() {
  if (isExiting) return;
  isExiting = true;
  clearInterval(ppidWatch);
  try {
    const tasks = [...new Set([...sessions.values()].map((session) => session.activeTask).filter(Boolean))];
    for (const task of tasks) task.stop("cancelled");
    if (activeAbort) {
      activeAbort.abort();
    }
    const pending = [activeAttempt, ...tasks.map((task) => task.applying)].filter(Boolean);
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        sleep(12_000),
      ]);
    }
    if (activeBackendId) {
      await releaseLease(activeBackendId);
      activeBackendId = null;
    }
    await cleanupOwnBrowserGroups();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => { void cleanShutdown(); });
process.on("SIGINT", () => { void cleanShutdown(); });

/* ---------- JSON-RPC request dispatcher ---------- */
async function sendSession(id, sessionId, session) {
  if (BB_THREAD_ARG) {
    session.thread ??= await taskThread(BB_THREAD_ID).catch(() => null);
  }
  out({
    jsonrpc: "2.0",
    id,
    result: {
      sessionId,
      models: {
        availableModels: MODELS.map((m) => ({ modelId: m.value, name: m.name })),
        currentModelId: session.model,
      },
      configOptions: configOptionsFor(session, BACKENDS, loadState()),
      modes: {
        availableModes: [
          { id: "read-only", name: "Read only" },
          ...(canWrite(session) ? [{ id: "write", name: "Write files and commit" }] : []),
        ],
        currentModeId: sessionMode(session),
      },
    },
  });
}

/* ---------- §7.2/§7.3: постоянный журнал хода и продолжение ---------- */

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function normalizeInput(value) {
  if (Array.isArray(value)) return value.map(normalizeInput);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeInput(value[key])]));
  }
  return value;
}

const taskInputSha256 = (inputBlocksSha256, materials) => sha256(JSON.stringify([
  inputBlocksSha256, materials.map(({ text, ...material }) => ({ ...material, sha256: sha256(text) })),
]));

function taskAttachmentOptions(session, task) {
  return {
    signal: task.signal,
    maxUploadBytes: argonMaxUploadBytes(),
    maxUploadCount: argonMaxUploadCount(),
    validateUploads: (blocks) => collectUploadFiles(blocks, session),
    spillDir: UPLOADS_DIR,
    ownedFiles: task.ownedFiles,
  };
}

// Запись сессии просрочена по state.retentionMs её проекта (§9): продолжать
// по ней нельзя — молчаливая выдача новой пустой сессии запрещена.
function sessionRecordExpired(record) {
  return Date.now() - (record?.updatedAt || 0) > loadSettingsRetention(record?.projectId) &&
    !journal.unfinishedTurns(STATE_DIR, journal.sessionKey(record.sessionId)).some((turn) => turn.record?.write);
}

function taskSessionsForWorktree(fingerprint) {
  if (!fingerprint) return [];
  return journal.listSessionRecords(STATE_DIR).filter((entry) =>
    entry.record?.version === journal.JOURNAL_VERSION &&
    entry.record.threadId === BB_THREAD_ID && journal.fingerprintEqual(entry.record.fingerprint, fingerprint));
}

function loadSettingsRetention(projectId) {
  try {
    return loadSettings(STATE_DIR, projectId).stateRetentionMs;
  } catch {
    return 86_400_000;
  }
}

// Разговор можно восстановить только на прежнем backend: запись должна
// указывать живой аккаунт пула вне cooldown. Смена backend — повторная
// доставка пакета в новый чат (§7.3), а не продолжение convId.
function convBackendUsable(backendId) {
  const b = BACKENDS.find((x) => x.id === backendId);
  if (!b) return false;
  try {
    const state = loadState();
    return (accEntry(state, b.id)?.cooldownUntilMs ?? 0) <= Date.now();
  } catch {
    return false;
  }
}

// План хода до внешней работы: запись сессии, монотонный номер хода, точный
// повтор/«продолжай» незавершённого хода либо новая запись. Возвращает
// { kind: "fresh"|"resume" } либо { errorOutcome, reason }.
const writeResult = (branch, sha) => "Branch: " + branch + "\nCommit: " + sha;

function fileRepairInstruction(context, candidate, plan) {
  const capture = candidate?.fileResponse;
  const channels = [capture?.rpc, capture?.dom].map((channel) =>
    typeof channel?.text === "string" ? Buffer.byteLength(channel.text) + " bytes" : "unavailable");
  const files = plan?.files.map(({ path, operation, baseSha256 }) => ({ path, operation, baseSha256 }));
  const summary = context.settings.mask(JSON.stringify({ history: channels[0], dom: channels[1], ...(files ? { files } : {}) }));
  return "Return the entire file envelope: the BBG-<nonce>-ENVELOPE line, the one-line META JSON, raw file content " +
    "between the FILE-NN-BEGIN and FILE-NN-END marker lines without escaping, and BBG-<nonce>-CLOSE, all inside a " +
    "single Markdown fence. Previous response summary " + summary + "\n";
}

async function planTaskTurn({ session, sessionId, blocks, text, prepare, task }) {
  const inputSha256 = sha256(JSON.stringify(normalizeInput(blocks)));
  const isContinue = blocks.every((block) => block.type === "text") && journal.isContinueText(text);
  const saved = session.journal ?? journal.findSessionRecord(STATE_DIR, sessionId);
  // PLUG-384: флаг research живёт в записи сессии — следующий ход видит
  // его в prepareTask и после рестарта провайдера, без маркера в тексте.
  if (saved) session.journal = saved;
  const last = saved ? journal.listTurns(STATE_DIR, saved.key).at(-1) : null;
  if (last?.corrupt || (last && last.record.version !== journal.JOURNAL_VERSION)) {
    return { errorOutcome: "failed", reason: "recovery: saved turn journal is corrupt or has an unsupported version" };
  }
  const committed = last?.record.commit ? last.record : null;
  const unfinished = last && !last.record.outcome && !committed ? last.record : null;
  const retryable = unfinished ?? (last?.record.outcome === "failed" && last.record.packageSha256 ? last.record : null);
  if (isContinue && !retryable && !committed) {
    return { errorOutcome: "not_started", reason: "a bare continue has no saved task package to resume" };
  }
  const exactCandidate = retryable?.mode === "write" ? retryable : unfinished;
  const sameBlocks = exactCandidate?.inputBlocksSha256 === inputSha256;
  const replay = committed && (isContinue || committed.inputBlocksSha256 === inputSha256) ? committed : null;
  const candidate = replay ?? (isContinue ? retryable : sameBlocks ? exactCandidate : null);
  let context = await prepare(candidate);
  let materials;
  if (candidate) {
    let fingerprint = inputSha256;
    let exact = false;
    if (!isContinue && candidate.taskSha256) {
      materials = await collectTaskAttachments(context, blocks, taskAttachmentOptions(session, task));
      fingerprint = taskInputSha256(inputSha256, materials);
      exact = fingerprint === candidate.taskSha256;
    }
    if (isContinue || exact || !candidate.taskSha256) {
      if (replay) return { kind: "committed", sessKey: saved.key, turn: replay, context };
      if (candidate.mode === "write" && task.mode !== "write") {
        return { errorOutcome: "not_started", reason: "accept-edits is required to resume the saved file task" };
      }
      const pkg = journal.loadTurnPackage(STATE_DIR, saved.key, candidate);
      if (!pkg.ok) {
        journal.completeTurn(STATE_DIR, saved.key, candidate, { outcome: "failed", reason: "recovery: " + pkg.reason });
        return { errorOutcome: "failed", reason: "recovery: " + pkg.reason };
      }
      journal.addAttempt(STATE_DIR, saved.key, candidate, fingerprint);
      session.journal = saved;
      return { kind: "resume", sessKey: saved.key, turn: candidate, pkg, exact, context };
    }
    context = await prepare();
    if (context.pin?.sha !== candidate.pin?.sha) materials = undefined;
  }
  if (unfinished && !unfinished.inputBlocksSha256 && unfinished.taskSha256 === sha256(text)) {
    return { errorOutcome: "not_started", reason: "recovery: legacy task input fingerprint is incomplete; send a bare continue to resume" };
  }
  if (unfinished) {
    journal.completeTurn(STATE_DIR, saved.key, unfinished, { outcome: "failed", reason: "superseded by a new task input" });
    session.convId = null;
    session.backend = null;
  }
  let entry = saved;
  if (!entry) {
    entry = journal.createSessionRecord(STATE_DIR, {
      sessionId,
      threadId: session.thread.thread.id,
      projectId: session.thread.thread.projectId,
      fingerprint: await journal.worktreeFingerprint(context.cwd),
      accessCeiling: canWrite(session) ? "write" : "read-only",
      accessMode: task.mode,
      roots: session.roots,
      model: session.model,
      thinking: session.thinking,
      account: session.account,
      research: context.research,
    });
  }
  session.journal = entry;
  const head = context.writeHead ?? await journal.headOf(context.root ?? context.cwd, task.signal);
  task.signal.throwIfAborted();
  const turn = journal.createTurn(STATE_DIR, entry, {
    inputSha256,
    previousTurnNo: last?.turnNo,
    mode: task.mode,
    profile: { model: session.model, thinking: session.thinking, account: session.account },
    deadlineAt: task.deadline,
    budgetLimits: {
      maxTotalBytes: context.settings.maxTotalBytes,
      maxToolRounds: webTools.MAX_TOOL_ROUNDS,
      maxRepairRounds: context.settings.maxRepairRounds,
    },
    head,
    pin: context.pin,
    expected: context.write ? "files" : context.verdict ? "verdict" : "text",
    verdict: journal.serializeVerdict(context.verdict),
    write: context.write,
  });
  return { kind: "fresh", sessKey: entry.key, turn, context, materials };
}

async function runBoundPrompt(msg, session) {
  if (session.activeTask) {
    turnError(msg.id, "not_started", "session already has an active task turn");
    return;
  }
  const { sessionId, prompt } = msg.params;
  const task = createTaskTurn(sessionId);
  session.activeTask = task;
  let writer;
  try {
    task.signal.throwIfAborted();
    let thread = session.thread;
    if (!thread && BB_THREAD_ARG) {
      thread = session.thread = await taskThread(BB_THREAD_ID, task.signal).catch(() => null);
    }
    if (!thread) throw new TaskTurnError("could not verify trusted BB thread metadata");
    if (WRITE_LAUNCH && !canWrite(session)) throw new TaskTurnError(WRITE_REFUSED);
    task.mode = sessionMode(session);
    if (!Array.isArray(prompt)) throw new TaskTurnError("prompt must be an array of blocks");
    const system = isBbSystemInstructionsBlock(prompt[0]) ? prompt[0].text : null;
    const blocks = prompt.filter((block) => block && !isBbSystemInstructionsBlock(block));
    const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n");
    if (task.mode === "write" || session.journal?.record.accessCeiling === "write") {
      writer = new WorktreeWriter(realpathSync(session.cwd), STATE_DIR, thread.environment);
      await writer.lock(task.signal);
      // A transport may have opened before the previous writer created its
      // session record. Resolve the same owner again while holding the lock.
      const matches = taskSessionsForWorktree(writer.fingerprint);
      if (matches.length > 1) throw new TaskTurnError("ambiguous saved session records for this thread and directory");
      if (matches.length === 1) {
        const [entry] = matches;
        if (entry.record.projectId !== thread.thread.projectId || sessionRecordExpired(entry.record)) {
          throw new TaskTurnError("saved worktree session is expired or belongs to a different project");
        }
        journal.addSessionAlias(STATE_DIR, entry, sessionId);
        if (!session.journal && !session.mode && entry.record.accessMode !== "write") {
          task.mode = session.mode = "read-only";
        }
        session.journal = entry;
      }
      task.ping("restore");
      try {
        await writer.recover((owner, receipt) => journal.checkpointWrite(STATE_DIR, owner, receipt));
      } catch (cause) {
        const error = new TaskTurnError(cause.message);
        error.outcome = "failed";
        throw error;
      }
      task.ping("preflight");
    }
    const prepare = async (savedTurn) => {
      const context = await prepareTask({
        text, system, session, thread, stateDir: STATE_DIR, signal: task.signal,
        onSettings: (settings) => task.heartbeat(settings.progressIntervalMs), savedTurn,
      });
      if ((savedTurn?.mode ?? task.mode) !== "write" || savedTurn?.commit || task.mode !== "write") return context;
      const writeHead = await writer.prepare();
      if (savedTurn && (savedTurn.head?.sha !== writeHead.sha || savedTurn.head?.branch !== writeHead.branch)) {
        throw new TaskTurnError("saved file task has a different base commit");
      }
      const write = savedTurn?.write ?? { nonce: randomBytes(16).toString("hex"), allowedPaths: resultPaths(text), bases: [] };
      if (write.allowedPaths?.some((path) => context.settings.mask(path) !== path)) {
        throw new TaskTurnError("result files section contains a protected path");
      }
      return { ...context, verdict: null, write, writeHead, writer };
    };
    // §7.2: номер хода и запись журнала выделяются до внешней работы;
    // точный повтор/«продолжай» незавершённого хода продолжает его по §7.3.
    const plan = await planTaskTurn({ session, sessionId, blocks, text, prepare, task });
    if (plan.errorOutcome) {
      const planError = new TaskTurnError(plan.reason);
      planError.outcome = plan.errorOutcome;
      throw planError;
    }
    task.journal = { sessKey: plan.sessKey, turn: plan.turn, entry: session.journal };
    const { context, turn } = plan;
    task.mode = context.write ? "write" : "read-only";
    if (plan.kind === "committed") {
      task.ping("verify");
      try {
        if (!writer) throw new Error("saved worktree identity is unavailable");
        await writer.verifyCommit(turn.commit, turn.commit.sha);
      } catch (error) {
        task.journal = null;
        const failure = new TaskTurnError("recovery_required: " + error.message);
        failure.outcome = "failed";
        throw failure;
      }
      const answer = writeResult(turn.commit.head.branch, turn.commit.sha);
      await task.finish("passed", "", answer);
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer },
      } } });
      out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (!context.write) writer?.close();
    task.pinnedSha = context.pin?.sha ?? null;
    if (context.pin) slog("task:pinned-sha", { sessionId, sha: context.pin.sha, base: context.pin.base });
    if (plan.kind === "resume") {
      // Earlier journal records have the starting timestamp and bytes spent,
      // before deadline and limit snapshots were added.
      task.setDeadline(turn.deadlineAt ?? turn.createdAt + SEND_DEADLINE_MS);
      // convId восстанавливается только на прежнем backend вне cooldown;
      // иначе ход получает повторную доставку сохранённого пакета в новый чат.
      const useConv = Boolean(plan.turn.convId) && convBackendUsable(plan.turn.backendId);
      const isLightResearch = context.research && !context.write;
      task.resume = {
        convId: useConv ? turn.convId : null, pkg: plan.pkg, exact: plan.exact,
        instruction: plan.exact
          ? (isLightResearch ? "Продолжай выполнение задачи." : "Continue the original task from the saved package.")
          : (isLightResearch ? context.settings.maskResearch(filterServiceLines(text), context.key) : context.settings.mask(text)),
      };
      session.convId = task.resume.convId;
      session.backend = useConv ? BACKENDS.find((b) => b.id === turn.backendId) : null;
      slog("task:resume", { sessionId, turnNo: plan.turn.turnNo, attempt: plan.turn.attempts?.at(-1)?.n, convId: useConv ? plan.turn.convId : null });
    }
    if (Date.now() >= task.deadline) task.stop("deadline exceeded");
    task.signal.throwIfAborted();
    await runPrompt(msg.id, sessionId, text, { task, context, blocks, materials: plan.materials });
  } catch (error) {
    const outcome = error.outcome ?? (task.journal ? "failed" : "not_started");
    const reason = task.signal.reason ?? (error.code ? "invalid task input or working directory" : error.message);
    await task.finish(outcome, reason);
    turnError(msg.id, outcome, reason);
  } finally {
    writer?.close();
    if (session.activeTask === task) session.activeTask = null;
  }
}

// Восстановление сессии из записи журнала в живую сессию (§7.2/§7.3).
// Проверки: версия записи, владелец (BB thread), отпечаток каталога
// (session cwd или roots), потолок прав, срок хранения. При отказе —
// not_started с причиной; пустой чат никогда не создаётся.
function restoreSessionFromRecord(requestedId, entry, cwd) {
  const s = sessions.get(entry.record.sessionId) ?? {
    id: requestedId,
    cwd: cwd || null,
    roots: Array.isArray(entry.record.roots) ? entry.record.roots : [],
    model: resolveModelId(entry.record.model) ?? "neon",
    thinking: entry.record.thinking ?? "medium",
    convId: entry.record.convId ?? null,
    account: entry.record.account ?? "auto",
    backend: BACKENDS.find((b) => b.id === entry.record.backendId) ?? null,
    journal: entry,
    mode: WRITE_LAUNCH && entry.record.accessMode === "write" ? "write" : "read-only",
  };
  journal.addSessionAlias(STATE_DIR, s.journal ?? entry, requestedId);
  sessions.set(requestedId, s);
  sessions.set(entry.record.sessionId, s);
  for (const alias of entry.record.aliases ?? []) sessions.set(alias, s);
  return s;
}

// Проверка записи сессии против запроса session/load (§9): владелец, каталог,
// потолок прав, срок хранения. null — запись пригодна; строка — причина отказа.
async function validateSessionRecord(entry, cwd) {
  const record = entry.record;
  if (!record || record.version !== journal.JOURNAL_VERSION) {
    return "saved session record is corrupt or has an unsupported version";
  }
  if (!BB_THREAD_ID || !record.threadId) {
    return "saved session owner thread could not be verified";
  }
  if (record.threadId !== BB_THREAD_ID) {
    return "saved session belongs to a different owner thread";
  }
  const thread = await taskThread(BB_THREAD_ID).catch(() => null);
  if (!thread || (record.projectId && thread.thread.projectId !== record.projectId)) {
    return "saved session owner thread could not be verified";
  }
  const fp = cwd ? await journal.worktreeFingerprint(cwd).catch(() => null) : null;
  if (!journal.fingerprintEqual(fp, record.fingerprint)) {
    return "saved session belongs to a different working directory";
  }
  if (!["read-only", "write"].includes(record.accessCeiling)) return "invalid saved session access for the read-only ceiling or accept-edits launch";
  if (sessionRecordExpired(record)) {
    return "saved session record is expired";
  }
  return null;
}

// §7.2: профиль записи сессии (модель/thinking/аккаунт) персистится —
// восстановление после рестарта продолжает с теми же параметрами.
function persistSessionProfile(s) {
  if (!s?.journal) return;
  try {
    journal.saveSessionRecord(STATE_DIR, s.journal, { model: s.model, thinking: s.thinking, account: s.account });
  } catch {}
}

// §7.2: session/new — резервный путь восстановления. Если для этого
// BB-треда и каталога уже есть ровно одна запись журнала, новая сессия
// становится алиасом к ней, а не пустым чатом.
async function handleSessionNew(msg, p) {
  const uniq = `${process.pid}-${Date.now().toString(36)}-${++sessionCounter}`;
  const sessionId = `web-gemini-${uniq}`;
  if (BB_THREAD_ID) {
    const fp = p.cwd ? await journal.worktreeFingerprint(p.cwd).catch(() => null) : null;
    const candidates = taskSessionsForWorktree(fp);
    if (candidates.length > 1) {
      turnError(msg.id, "not_started", "ambiguous saved session records for this thread and directory");
      return;
    }
    if (candidates.length === 1) {
      const entry = candidates[0];
      const rejection = await validateSessionRecord(entry, p.cwd);
      if (rejection) {
        turnError(msg.id, "not_started", rejection);
        return;
      }
      const s = restoreSessionFromRecord(sessionId, entry, p.cwd);
      sessions.set(`argon-${uniq}`, s);
      slog("session:new-alias", { sessionId, restored: entry.record.sessionId });
      void sendSession(msg.id, sessionId, s);
      return;
    }
  }
  const s = {
    id: sessionId,
    cwd: p.cwd || null,
    roots: dirRootsFrom(p),
    model: "neon",
    thinking: "medium",
    convId: null,
    account: "auto",
    backend: null,
  };
  sessions.set(sessionId, s);
  sessions.set(`argon-${uniq}`, s);
  void sendSession(msg.id, sessionId, s);
}

// §7.2/§9: session/load — восстановление по идентификатору сессии или алиасу.
async function handleSessionLoad(msg, p) {
  const sessionId = p.sessionId;
  const live = sessions.get(sessionId);
  if (live && !live.journal) {
    void sendSession(msg.id, sessionId, live);
    return;
  }
  if (sessionId) {
    const entry = journal.findSessionRecord(STATE_DIR, sessionId);
    if (!entry) {
      turnError(msg.id, "not_started", `unknown saved session "${sessionId}"`);
      return;
    }
    const rejection = await validateSessionRecord(entry, p.cwd);
    if (rejection) {
      turnError(msg.id, "not_started", rejection);
      return;
    }
    const s = live ?? restoreSessionFromRecord(sessionId, entry, p.cwd);
    slog("session:load", { sessionId, restored: entry.record.sessionId, convId: s.convId });
    void sendSession(msg.id, sessionId, s);
    return;
  }
  // Без sessionId — как раньше: новая чат-сессия.
  const newId = `web-gemini-${process.pid}-${Date.now().toString(36)}-${++sessionCounter}`;
  const s = {
    id: newId,
    cwd: p.cwd || null,
    roots: dirRootsFrom(p),
    model: "neon",
    thinking: "medium",
    convId: null,
    account: "auto",
    backend: null,
  };
  sessions.set(newId, s);
  sessions.set(`argon-${newId.slice("web-gemini-".length)}`, s);
  void sendSession(msg.id, newId, s);
}

export function dispatch(msg) {
  const p = msg.params ?? {};
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === "session/cancel") {
      cancelSession(p.sessionId);
    }
    return;
  }

  switch (msg.method) {
    case "initialize":
      out({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: p.protocolVersion ?? 1,
          agentInfo: { name: "web-gemini", version: "0.2.0" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            sessionCapabilities: {},
          },
          authMethods: [],
        },
      });
      return;

    case "session/new": {
      void handleSessionNew(msg, p);
      return;
    }

    case "session/load": {
      void handleSessionLoad(msg, p);
      return;
    }

    case "session/set_mode": {
      const s = sessions.get(p.sessionId);
      if (!s) turnError(msg.id, "not_started", "unknown session");
      else if (p.modeId !== "read-only" && (p.modeId !== "write" || !canWrite(s))) {
        turnError(msg.id, "not_started", WRITE_REFUSED);
      } else {
        if (p.modeId === "read-only" && s.activeTask?.mode === "write") cancelSession(p.sessionId);
        s.mode = p.modeId;
        if (s.journal) journal.saveSessionRecord(STATE_DIR, s.journal, {
          accessMode: s.mode,
          ...(s.mode === "write" ? { accessCeiling: "write" } : {}),
        });
        out({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
      return;
    }

    case "session/set_config_option": {
      const s = sessions.get(p.sessionId);
      if (!s) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown session "${p.sessionId}"` } });
        return;
      }
      const cid = p.configId ?? p.id ?? p.optionId;
      const val = p.value;
      if (cid === "thought_level" || cid === "thinking") {
        if (val === "low" || val === "fast") {
          s.thinking = "low";
        } else if (val === "medium" || val === "thinking") {
          s.thinking = "medium";
        } else if (val === "high" || val === "pro") {
          s.thinking = "high";
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown thought_level "${val}"` } });
          return;
        }
      } else if (cid === "model") {
        const targetModel = resolveModelId(val);
        if (!targetModel) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown model "${val}"` } });
          return;
        }
        s.model = targetModel;
        if (!s.thinking) s.thinking = "medium";
        resetAccountForModel(s);
      } else if (cid === "account") {
        if (val !== "auto" && !BACKENDS.some((b) => b.id === val)) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown account "${val}"` } });
          return;
        }
        if (val !== s.account) {
          s.account = val;
          s.backend = null;
          s.convId = null;
          resetModelForAccount(s);
        }
      } else {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown config option "${cid}"` } });
        return;
      }
      persistSessionProfile(s);
      out({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptionsFor(s, BACKENDS, loadState()) } });
      return;
    }

    case "session/set_model": {
      const s = sessions.get(p.sessionId);
      if (!s) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown session "${p.sessionId}"` } });
        return;
      }
      const rawVal = p.modelId ?? p.value;
      const val = resolveModelId(rawVal);
      if (!val) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `unknown model "${typeof rawVal === "string" ? rawVal : JSON.stringify(rawVal)}"` },
        });
        return;
      }
      s.model = val;
      if (!s.thinking) s.thinking = "medium";
      resetAccountForModel(s);
      persistSessionProfile(s);
      out({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptionsFor(s, BACKENDS, loadState()) } });
      return;
    }

    case "session/prompt": {
      const sess = sessions.get(p.sessionId);
      if (!sess) {
        if (BB_THREAD_ARG) turnError(msg.id, "not_started", "unknown session");
        else out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown session "${p.sessionId}"` } });
        return;
      }
      if (BB_THREAD_ARG && (WRITE_LAUNCH || sess.journal || !sess.thread || sess.thread.thread.originPluginId)) void runBoundPrompt(msg, sess);
      else if (SESSION_ACCESS === "write") turnError(msg.id, "not_started", WRITE_REFUSED);
      else dispatchPrompt(msg, sess);
      return;
    }

    case "session/cancel":
      cancelSession(p.sessionId);
      out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
      return;

    case "authenticate":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;

    default:
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown " + msg.method } });
  }
}

function dispatchPrompt(msg, sess) {
  const p = msg.params;
  if (!Array.isArray(p.prompt)) {
    out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "prompt must be an array of blocks" } });
    return;
  }
  // PLUG-285: блоки с агентским контекстом bb (<system_instructions>…)
  // отбрасываются целиком, до склейки — до драйвера доходит только
  // текст пользователя. Ресурсы и не-text блоки не затрагиваются.
  let text = p.prompt
    .filter((b) => b && b.type === "text" && !isBbSystemInstructionsBlock(b))
    .map((b) => String(b.text ?? ""))
    .join("\n");
  if (!text.trim()) {
    out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
  // PLUG-281 / PLUG-303 (r22, §2.2 п.2): гард размера промпта и перелив текста в файл.
  // При превышении лимита исходный текст атомарно переливается в uploads/pkg-<sessionId>-prompt-<ts>.md
  // и уходит веб-вложением сверх лимитов пользовательских файлов, а текст заменяется на указатель.
  // При ошибке записи файла возвращается прежний JSON-RPC -32000.
  const extraUploadFiles = [];
  const tooLarge = promptTooLargeError(text);
  if (tooLarge) {
    try {
      const { pkgName, pkgPath } = webTools.writeSpillPackage(
        UPLOADS_DIR,
        `${p.sessionId}-prompt`,
        text,
      );
      extraUploadFiles.push(pkgPath);
      text = `[Задача передана файлом-вложением «${pkgName}» — изучи его целиком и выполни.]`;
      slog("prompt:spill-prompt", { sessionId: p.sessionId, pkgName, bytes: Buffer.byteLength(text, "utf8") });
    } catch (err) {
      slog("prompt:spill-error", { sessionId: p.sessionId, error: err?.message });
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: tooLarge.message } });
      return;
    }
  }
  // §5 + PLUG-291: приложенные ресурсы ACP (embeddedContext) —
  // встроенные текстовые ресурсы идут во вложения первого сообщения.
  // resource_link обрабатывается только как file:// (collectUploadFiles
  // ниже) — URL и не-файловые ссылки в материалы не вкладываются.
  const embeddedResources = p.prompt.filter(
    (b) => b && b.type === "resource" && b.resource && typeof b.resource.text === "string",
  );
  // PLUG-291: локальные файлы-вложения (file://, image/localFile path)
  // валидируются синхронно по корням сессии и лимитам — ошибка идёт
  // JSON-RPC error, валидные пути уходят драйверу веб-вложениями.
  const upload = collectUploadFiles(p.prompt, sess);
  if (upload.error) {
    out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: upload.error } });
    return;
  }
  void runPrompt(msg.id, p.sessionId, text, {
    embeddedResources,
    uploadFiles: [...upload.files, ...extraUploadFiles],
  });
}

/* ---------- CLI entrypoint ---------- */
export function startServer({ webDriver } = {}) {
  if (webDriver) driver = webDriver;
  reapOrphanAcpServers();
  void reapOrphanBrowserGroups().catch((e) => slog("reaper:browser-groups-error", { error: String(e) }));
  // §7.2/§9: чистка журнала (TTL/лимит записей) до чистки вложений — файлы,
  // нужные восстановлению активных ходов, защищены от pruneDir.
  try {
    journal.pruneJournal(STATE_DIR, {
      retentionFor: (entry) => loadSettingsRetention(entry.record?.projectId),
    });
  } catch (error) {
    slog("journal:prune-error", { error: String(error?.message || error) });
  }
  // PLUG-291: чистка каталогов веб-вложений при старте (TTL 24ч, ≤20 файлов).
  pruneDir(UPLOADS_DIR, { protectedPaths: journal.collectProtectedPaths(STATE_DIR) });
  pruneDir(DOWNLOADS_DIR);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (msg.method === undefined) return;
    if (typeof msg.method !== "string") {
      if (msg.id !== undefined && msg.id !== null) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "invalid request: method must be a string" } });
      }
      return;
    }
    try {
      dispatch(msg);
    } catch (e) {
      if (msg.id !== undefined && msg.id !== null) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `internal error: ${e.message}` } });
      }
      console.error(`[argon] dispatch error: ${e.stack || e}`);
    }
  });

  rl.on("close", () => {
    void cleanShutdown();
  });
}

// Ops unpark subcommand
if (process.argv[2] === "unpark") {
  const target = process.argv[3] || "all";
  withStateLock((state) => {
    const ids = target === "all" ? Object.keys(state.accounts) : [target];
    for (const id of ids) {
      const e = accEntry(state, id);
      if (e) {
        e.parkedReason = null;
        e.cooldownUntilMs = 0;
      }
    }
    delete state.breaker;
    console.error(`unparked: ${ids.join(", ") || "(none)"}`);
  });
  process.exit(0);
}

// Ops unlock subcommand: `node acp-server.mjs unlock <id|all> [model]`.
// Clears lockedModels entries recorded by the lock detector — PLUG-282:
// false-positive locks previously had no CLI undo, only manual state edits.
// Removing "carbon" also drops the persisted tier downgrade so
// getAccountTier falls back to the pool-configured tier again.
if (process.argv[2] === "unlock") {
  const target = process.argv[3] || "all";
  const model = process.argv[4]
    ? resolveModelId(process.argv[4]) || process.argv[4].toLowerCase()
    : null;
  withStateLock((state) => {
    const ids = target === "all" ? Object.keys(state.accounts) : [target];
    for (const id of ids) {
      const e = accEntry(state, id);
      if (!e || !Array.isArray(e.lockedModels) || e.lockedModels.length === 0) continue;
      const hadCarbon = e.lockedModels.includes("carbon");
      e.lockedModels = model ? e.lockedModels.filter((x) => x !== model) : [];
      if (hadCarbon && !e.lockedModels.includes("carbon")) delete e.tier;
    }
    console.error(`unlocked: ${ids.join(", ") || "(none)"}${model ? ` model=${model}` : ""}`);
  });
  process.exit(0);
}

const isMain =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("/acp-server.mjs"));

if (isMain) {
  startServer();
}
