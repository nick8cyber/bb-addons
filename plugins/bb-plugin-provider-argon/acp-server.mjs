#!/usr/bin/env node
/**
 * acp-argon — ACP (JSON-RPC stdio) bridge to Google Gemini web client.
 * Wraps the patched google-gemini-cli driver (CDP + headless Chromium).
 *
 * Conforms strictly to docs/specs/provider-argon.md and ADR 0027.
 */
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import * as webTools from "./src/web-tools.mjs";
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
  writeFileSync,
  appendFileSync,
  constants,
} from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "package.json"));

// Diagnostics must stay off stdout — it is the JSON-RPC channel.
console.log = console.error;

const FAKE = process.env.ARGON_FAKE === "1";
const HEADLESS = process.env.ARGON_HEADLESS || process.env.GEMINI_HEADLESS || null;

const STATE_DIR = process.env.ARGON_STATE_DIR || join(homedir(), ".bb", "plugins", "provider-argon");
const POOL_FILE = process.env.ARGON_POOL_FILE || join(STATE_DIR, "pool.json");
const LEDGER_FILE = join(STATE_DIR, "accounts-state.json");
const LOCK_FILE = join(STATE_DIR, "accounts-state.json.lock");
const LOCK_STALE_MS = 5000;
const LEASE_TTL_MS = 10 * 60_000;
const SEND_DEADLINE_MS = Number(process.env.ARGON_SEND_DEADLINE_MS) || 1_200_000;

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
            priority: Number.isInteger(acc.priority) ? acc.priority : 10,
            tier: acc.tier && acc.tier.toLowerCase() === "ultra" ? "ultra" : "pro",
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
            priority: Number.isInteger(b.priority) ? b.priority : 10,
            tier: b.tier && b.tier.toLowerCase() === "ultra" ? "ultra" : "pro",
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
              priority: Number.isInteger(b.priority) ? b.priority : 10,
              tier: b.tier && b.tier.toLowerCase() === "ultra" ? "ultra" : "pro",
            });
          } catch {}
        }
      }
    } catch {}
  }

  // 4. Env ARGON_BACKENDS
  try {
    const arr = JSON.parse(process.env.ARGON_BACKENDS || "");
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
            priority: Number.isInteger(b.priority) ? b.priority : 10,
            tier: b.tier && b.tier.toLowerCase() === "ultra" ? "ultra" : "pro",
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
      priority: 10,
      tier: "pro",
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

function acquireLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
      closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(LOCK_FILE); } catch {}
          continue;
        }
      } catch {}
      const start = Date.now();
      while (Date.now() - start < 40) {}
    }
  }
  throw new Error("accounts-state lock held for over 10s");
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {}
}

function loadState() {
  let state = { accounts: Object.create(null), leases: Object.create(null) };
  try {
    if (existsSync(LEDGER_FILE)) {
      const raw = JSON.parse(readFileSync(LEDGER_FILE, "utf8"));
      state.accounts = Object.assign(Object.create(null), raw.accounts || {});
      state.leases = Object.assign(Object.create(null), raw.leases || {});
      if (raw.breaker) state.breaker = raw.breaker;
    }
  } catch (e) {
    if (e.code !== "ENOENT" && existsSync(LEDGER_FILE)) {
      try { renameSync(LEDGER_FILE, `${LEDGER_FILE}.corrupt-${Date.now()}`); } catch {}
    }
  }

  // Prune expired or dead leases
  const now = Date.now();
  for (const [id, lease] of Object.entries(state.leases)) {
    if (!lease || now - (lease.acquiredMs || 0) >= LEASE_TTL_MS || !isPidAlive(lease.pid)) {
      delete state.leases[id];
    }
  }

  return state;
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${LEDGER_FILE}.${process.pid}.${Date.now()}.tmp`;
  const data = {
    accounts: state.accounts || {},
    leases: state.leases || {},
  };
  if (state.breaker) data.breaker = state.breaker;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, LEDGER_FILE);
}

export function withStateLock(fn) {
  acquireLock();
  try {
    const state = loadState();
    const result = fn(state);
    saveState(state);
    return result;
  } finally {
    releaseLock();
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

export function pickBackendFromState(state, excludeId, owner, now, requestedModel = null, backends = BACKENDS) {
  const isLeased = (b) => {
    const l = state.leases && state.leases[b.id];
    if (l && l.pid !== process.pid && now - (l.acquiredMs || 0) < LEASE_TTL_MS && isPidAlive(l.pid)) {
      return l.acquiredMs + LEASE_TTL_MS;
    }
    const e = accEntry(state, b.id);
    return e && (e.inUseUntilMs ?? 0) > now && e.owner !== owner ? e.inUseUntilMs : 0;
  };

  const req = requestedModel ? requestedModel.toLowerCase() : null;
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
  state.leases[b.id] = { pid: process.pid, acquiredMs: now };
}

/* ---------- parse reset time (§3.3) ---------- */
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

/* ---------- classify failure (§3.3) ---------- */
// PLUG-281: prompt-size guard. Unset → 100KB (the observed insertText hang
// threshold); ARGON_MAX_PROMPT_BYTES=N overrides; non-positive → no limit.
function argonMaxPromptBytes() {
  const raw = process.env.ARGON_MAX_PROMPT_BYTES;
  if (raw == null || raw === "") return 100 * 1024;
  const v = Number(raw);
  // NaN/garbage → default; non-positive → explicit "no limit".
  return Number.isFinite(v) ? (v > 0 ? v : Number.POSITIVE_INFINITY) : 100 * 1024;
}

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

  // 2. transient (including timeout cap)
  if (
    /generation still running after (?:540|900|\d+)s cap|stream_timeout|argon_stream_timeout|hung page|stalled generation/i.test(
      message
    ) ||
    (err && err.code === "ARGON_STREAM_TIMEOUT")
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
    const lockedModel = (
      err?.lockedModel ||
      (message.match(/^(\w+)\s+locked/i)?.[1] || "carbon")
    ).toLowerCase();
    return {
      category: "model-locked",
      cooldownMs: 0,
      untilMs: 0,
      rotatable: true,
      parkedReason: null,
      lockedModel,
    };
  }

  // 5. model-unavailable
  if (
    (err && err.code === "ARGON_MODEL_UNAVAILABLE") ||
    /modelunavailable|model is unavailable|not available for this account|недоступна/i.test(message)
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

async function settleBackend(backendId, sessionId, untilMs, message, parkedReason, lockedModel = null) {
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
      if (!Array.isArray(e.lockedModels)) e.lockedModels = [];
      if (!e.lockedModels.includes(lockedModel)) {
        e.lockedModels.push(lockedModel);
      }
      if (lockedModel === "carbon") {
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
  });
}

let driver = null;
function getDriver() {
  if (!driver) driver = require("./src/gemini-driver.js");
  return driver;
}

const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stage log: every prompt transition lands here so a silent hang shows its
// exact stage (bindBackend wait, driver call, streaming) — postmortem 17.11.
export const slog = (stage, extra) => {
  try {
    const dir = process.env.ARGON_STATE_DIR || STATE_DIR;
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

// Parent-death watchdog: reparented onto init/systemd means bridge parent died
const ownerPpid = process.ppid;
const ppidWatch = setInterval(() => {
  if (process.ppid !== ownerPpid || process.ppid === 1) {
    slog("process:reparented-exit", { ownerPpid, currentPpid: process.ppid });
    void cleanShutdown();
    return;
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
  { value: "argon", name: "Gemini 4 Argon" },
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
  if (v.includes("argon")) return "argon";
  if (v.includes("hydrogen")) return "hydrogen";
  if (v.includes("pro")) return "pro";
  const exact = MODELS.find((m) => m.value === v || m.name.toLowerCase() === v);
  if (exact) return exact.value;
  return null;
}

function configOptionsFor(s, backends = BACKENDS) {
  const normalizedLevel = normalizeThinking(s.thinking);
  const opts = [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: s.model,
      options: MODELS.map((m) => ({ value: m.value, name: m.name })),
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
    opts.push({
      id: "account",
      category: "account",
      type: "select",
      currentValue: s.account || "auto",
      options: [{ value: "auto", name: "auto" }, ...backends.map((b) => ({ value: b.id, name: b.id }))],
    });
  }
  return opts;
}

const modes = {
  availableModes: [{ id: "default", name: "Default" }],
  currentModeId: "default",
};

/* ---------- global prompt queue ---------- */
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
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
async function bindBackend(s, sessionId) {
  const owner = `${process.pid}:${sessionId}`;
  const reqModel = s.model ? s.model.toLowerCase() : null;

  if (s.account && s.account !== "auto") {
    const b = BACKENDS.find((x) => x.id === s.account);
    if (!b) {
      return { error: `unknown account "${s.account}" — pool has: ${BACKENDS.map((x) => x.id).join(", ")}` };
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

      if (cool <= now && !busy && !isLocked) {
        acquireInState(state, s.backend, owner, now);
        return { backend: s.backend };
      }
      const prev = s.backend.id;
      if (s.convId) {
        if (busy) return { busyUntil: l.acquiredMs + LEASE_TTL_MS, account: prev };
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
      if (r.none) {
        return { error: reqModel === "carbon" ? "no accounts in pool with Carbon available" : "all accounts are in cooldown or busy and no sibling is free" };
      }
      return { error: `account "${prev}" is in cooldown until ${new Date(cool).toISOString()} and no sibling is free` };
    }

    const r = pickBackendFromState(state, null, owner, now, reqModel);
    if (r.backend) {
      acquireInState(state, r.backend, owner, now);
      return { backend: r.backend };
    }
    if (r.busyUntil) return { busyUntil: r.busyUntil };
    if (r.none) {
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
    model: "argon",
    thinking: "thinking",
    convId: null,
    account: "auto",
    backend: null,
  };
  sessions.set(sessionId, s);
  const upd = (update) =>
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

  const gen = (s.gen || 0) + 1;
  s.gen = gen;
  s.activeGen = gen;
  s.cancelled = false;

  try {
    // PLUG-281: >~100KB prompts hang execCommand('insertText') in the driver
    // and used to surface as model-unavailable — fail fast BEFORE any
    // lease/park, but inside try so the client gets a -32000, not a dead
    // server (throw above try → void runPrompt() → unhandled rejection).
    const maxPromptBytes = argonMaxPromptBytes();
    if (Buffer.byteLength(text || "", "utf8") > maxPromptBytes) {
      const err = new Error(
        `prompt too large: ${Buffer.byteLength(text || "", "utf8")} bytes > ARGON_MAX_PROMPT_BYTES (${maxPromptBytes})`
      );
      err.code = "ARGON_PROMPT_TOO_LARGE";
      throw err;
    }
    slog("prompt:enqueue", { sessionId, chars: text.length, model: s.model });
    const result = await enqueue(async () => {
      if (s.cancelled) return { cancelled: true };
      slog("prompt:dequeue", { sessionId });

      if (FAKE) {
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
          const chunkText = "FAKE_ARGON_ECHO: " + text.slice(0, 80);
          upd({
            sessionUpdate: "agent_message_chunk",
            text: chunkText,
            content: { type: "text", text: chunkText },
          });
          const delayMs = Number(process.env.ARGON_FAKE_DELAY_MS) || 0;
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
      const waitDeadline = Date.now() + 130_000;
      const turnDeadline = Date.now() + SEND_DEADLINE_MS;
      let attempts = 0;
      let lastErr = null;
      let streamedAny = false;

      // §5 web-gemini-tools: первое сообщение нового разговора несёт
      // системную шапку инструментов и упакованные материалы (дифф, файлы,
      // треды, задачи). У существующего разговора (s.convId) текст идёт как есть.
      const packed = s.convId
        ? { message: text }
        : webTools.packFirstMessage({
            text,
            cwd: s.cwd,
            resourceLinks: attachments.resourceLinks ?? [],
            embeddedResources: attachments.embeddedResources ?? [],
          });

      while (true) {
        if (s.cancelled) return { cancelled: true };
        const bound = await bindBackend(s, sessionId);
        if (bound.error) {
          slog("bind:error", { sessionId, error: bound.error });
          throw new Error(bound.error);
        }
        if (bound.busyUntil) {
          if (s.cancelled) return { cancelled: true };
          if (Date.now() >= waitDeadline) {
            throw new Error(`account "${bound.account || "picked"}" is busy until ${new Date(bound.busyUntil).toISOString()}`);
          }
          slog("bind:busy", { sessionId, account: bound.account, busyUntil: new Date(bound.busyUntil).toISOString() });
          const wakeAt = Math.min(Date.now() + Math.max(bound.busyUntil - Date.now() + 500, 3000), Date.now() + 15_000);
          while (!s.cancelled && Date.now() < wakeAt) await sleep(500);
          continue;
        }
        if (s.cancelled) {
          if (bound.backend) await releaseLease(bound.backend.id);
          return { cancelled: true };
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

        const mappedThinking = normalizeThinking(s.thinking);
        const attempt = (async () => {
          try {
            const driverMod = getDriver();
            // §3 Tool Loop: все раунды — в том же convId на том же бэкенде,
            // лиз удерживается до конца хода.
            const sendOnce = async (message) => {
              slog("driver:send", {
                sessionId,
                account: backend.id,
                model: s.model,
                thinking: mappedThinking,
                chars: message.length,
                convId: s.convId || null,
              });
              const res = await driverMod.sendPrompt({
                prompt: message,
                model: s.model,
                thinking: mappedThinking,
                convId: s.convId,
                isNewChat: !s.convId,
                headless: HEADLESS,
                profile: backend.profileDir || backend.profile || backend.id,
                cdpPort: backend.cdp,
                strict: true,
                strictModel: true,
                signal: abortCtrl.signal,
                shouldCancel: () => s.cancelled || abortCtrl.signal.aborted || s.activeGen !== gen,
                onChunk: (c) => {
                  if (c && !s.cancelled && s.activeGen === gen) {
                    streamedAny = true;
                    upd({
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: c },
                    });
                  }
                },
              });
              if (res && res.convId) {
                s.convId = res.convId;
              }
              slog("driver:done", { sessionId, convId: s.convId || null, streamedAny });
              return res;
            };
            let toolSeq = 0;
            const loop = await webTools.runToolLoop({
              firstMessage: s.convId ? text : packed.message,
              send: sendOnce,
              execute: (call) => webTools.executeTool(call, { cwd: s.cwd }),
              onToolStart: (call) => {
                const toolCallId = `argtool-${++toolSeq}`;
                upd({
                  sessionUpdate: "tool_call",
                  toolCallId,
                  title: webTools.toolTitle(call),
                  kind: webTools.toolKind(call.name),
                  status: "in_progress",
                  rawInput: { name: call.name, args: call.args },
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
              maxRounds: webTools.MAX_TOOL_ROUNDS,
              isCancelled: () => s.cancelled || abortCtrl.signal.aborted,
            });
            if (loop.cancelled) {
              const e = new Error("prompt cancelled by user");
              e.code = "ARGON_CANCELLED";
              throw e;
            }
            return loop.lastRes ?? { text: loop.finalText };
          } finally {
            clearInterval(renew);
          }
        })();
        activeAttempt = attempt;

        const remaining = turnDeadline - Date.now();
        if (remaining <= 0) {
          await releaseLease(backend.id);
          activeBackendId = null;
          activeAbort = null;
          activeAttempt = null;
          activePromptSessionId = null;
          throw new Error(`turn exceeded ${SEND_DEADLINE_MS / 60000}min deadline`);
        }

        const deadlineP = new Promise((res) => {
          const t = setTimeout(() => res("deadline"), remaining);
          t.unref?.();
        });

        const outcome = await Promise.race([
          attempt.then(() => "done", () => "failed"),
          new Promise((res) => {
            s._cancelRes = () => res("cancelled");
          }),
          deadlineP,
        ]);
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
          throw new Error(`turn exceeded ${SEND_DEADLINE_MS / 60000}min deadline`);
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
            error: err && err.message ? String(err.message).slice(0, 300) : String(err),
            code: err && err.code,
          });
          if (err && err.code === "ARGON_CANCELLED") {
            await releaseLease(backend.id);
            activeBackendId = null;
            activeAbort = null;
            activeAttempt = null;
            activePromptSessionId = null;
            return { cancelled: true };
          }
          const hint = await probeAuthHint(backend);
          const cls = classifyFailure(err, hint);
          const cooled = await settleBackend(backend.id, sessionId, cls.untilMs, hint || err.message, cls.parkedReason, cls.lockedModel);
          activeBackendId = null;
          activeAbort = null;
          activeAttempt = null;
          activePromptSessionId = null;
          attempts += 1;

          const canRotate =
            s.account === "auto" &&
            attempts < maxAttempts &&
            cls.rotatable &&
            !s.convId &&
            !streamedAny &&
            cooled !== "breaker";

          if (!canRotate) {
            if (hint) err.authHint = hint;
            throw err;
          }
          s.backend = null;
        }
      }
      throw lastErr;
    });

    if (!isExiting) {
      const isCancelled = Boolean(result && (result.cancelled || result.stopReason === "cancelled"));
      out({
        jsonrpc: "2.0",
        id,
        result: { stopReason: isCancelled ? "cancelled" : "end_turn" },
      });
    }
    if (s.activeGen === gen) s.activeGen = null;
  } catch (err) {
    if (s.activeGen === gen) s.activeGen = null;
    if (!isExiting) {
      const hint = FAKE ? null : (err.authHint ?? (s.backend ? await probeAuthHint(s.backend) : null));
      const msg = hint ? `${hint}\n\n(driver error: ${err.message})` : `Gemini web driver error: ${err.message}`;
      out({ jsonrpc: "2.0", id, error: { code: -32000, message: msg } });
    }
  }
}

/* ---------- shutdown handlers ---------- */
let isExiting = false;
async function cleanShutdown() {
  if (isExiting) return;
  isExiting = true;
  clearInterval(ppidWatch);
  try {
    if (activeAbort) {
      activeAbort.abort();
    }
    if (activeAttempt) {
      await Promise.race([
        activeAttempt.catch(() => {}),
        sleep(12_000),
      ]);
    }
    if (activeBackendId) {
      await releaseLease(activeBackendId);
      activeBackendId = null;
    }
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => { void cleanShutdown(); });
process.on("SIGINT", () => { void cleanShutdown(); });

/* ---------- JSON-RPC request dispatcher ---------- */
export function dispatch(msg) {
  const p = msg.params ?? {};
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === "session/cancel") {
      const s = sessions.get(p.sessionId);
      if (s) {
        s.cancelled = true;
        s._cancelRes?.();
        if (activePromptSessionId === s.id && activeAbort) {
          activeAbort.abort();
        }
      }
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
          agentInfo: { name: "argon-gemini", version: "0.2.0" },
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            sessionCapabilities: {},
          },
          authMethods: [],
        },
      });
      return;

    case "session/new": {
      const sessionId = `argon-${++sessionCounter}`;
      const s = {
        id: sessionId,
        cwd: p.cwd || null,
        model: "argon",
        thinking: "medium",
        convId: null,
        account: "auto",
        backend: null,
      };
      sessions.set(sessionId, s);
      out({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId,
          models: {
            availableModels: MODELS.map((m) => ({ modelId: m.value, name: m.name })),
            currentModelId: s.model,
          },
          configOptions: configOptionsFor(s, BACKENDS),
          modes,
        },
      });
      return;
    }

    case "session/load": {
      const sessionId = p.sessionId || `argon-${++sessionCounter}`;
      let s = sessions.get(sessionId);
      if (!s) {
        s = {
          id: sessionId,
          cwd: p.cwd || null,
          model: "argon",
          thinking: "medium",
          convId: null,
          account: "auto",
          backend: null,
        };
        sessions.set(sessionId, s);
      }
      out({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId,
          models: {
            availableModels: MODELS.map((m) => ({ modelId: m.value, name: m.name })),
            currentModelId: s.model,
          },
          configOptions: configOptionsFor(s, BACKENDS),
          modes,
        },
      });
      return;
    }

    case "session/set_mode":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;

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
      } else if (cid === "account") {
        if (val !== "auto" && !BACKENDS.some((b) => b.id === val)) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown account "${val}"` } });
          return;
        }
        if (val !== s.account) {
          s.account = val;
          s.backend = null;
          s.convId = null;
        }
      } else {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown config option "${cid}"` } });
        return;
      }
      out({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptionsFor(s, BACKENDS) } });
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
      out({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptionsFor(s, BACKENDS) } });
      return;
    }

    case "session/prompt": {
      if (!sessions.has(p.sessionId)) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown session "${p.sessionId}"` } });
        return;
      }
      if (!Array.isArray(p.prompt)) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "prompt must be an array of blocks" } });
        return;
      }
      const text = p.prompt
        .filter((b) => b && b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("\n");
      if (!text.trim()) {
        out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        return;
      }
      // §5: приложенные ресурсы ACP (embeddedContext) — file:// ссылки и
      // встроенные текстовые ресурсы идут во вложения первого сообщения.
      const resourceLinks = p.prompt.filter(
        (b) => b && b.type === "resource_link" && typeof b.uri === "string",
      );
      const embeddedResources = p.prompt.filter(
        (b) => b && b.type === "resource" && b.resource && typeof b.resource.text === "string",
      );
      void runPrompt(msg.id, p.sessionId, text, { resourceLinks, embeddedResources });
      return;
    }

    case "session/cancel": {
      const s = sessions.get(p.sessionId);
      if (s) {
        s.cancelled = true;
        s._cancelRes?.();
        if (activePromptSessionId === s.id && activeAbort) {
          activeAbort.abort();
        }
      }
      out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
      return;
    }

    case "authenticate":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;

    default:
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
  }
}

/* ---------- CLI entrypoint ---------- */
export function startServer() {
  reapOrphanAcpServers();
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

const isMain =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("/acp-server.mjs"));

if (isMain) {
  startServer();
}
