'use strict';
// Managed browser groups (PLUG-374): every chrome/xvfb-run process group the
// driver launches gets a marker file under <stateDir>/browser-groups/<port>.json
// recording the group identity (pgid + leader starttime) and a verifiable
// owner (pid + owner starttime). Reapers in acp-server.mjs use these markers to
// tear down groups whose owner died while holding no lease and no live CDP
// clients. Groups without a marker (externally launched chrome) are never
// touched.

const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveStateDir(explicit) {
  if (explicit) return explicit;
  if (process.env.WEB_GEMINI_STATE_DIR) return process.env.WEB_GEMINI_STATE_DIR;
  if (process.env.ARGON_STATE_DIR) return process.env.ARGON_STATE_DIR;
  const gem = path.join(os.homedir(), '.bb', 'plugins', 'provider-web-gemini');
  const arg = path.join(os.homedir(), '.bb', 'plugins', 'provider-argon');
  if (fs.existsSync(gem)) return gem;
  if (fs.existsSync(arg)) return arg;
  return gem;
}

const groupsDir = (stateDir) => path.join(resolveStateDir(stateDir), 'browser-groups');
const markerPath = (stateDir, port) => path.join(groupsDir(stateDir), `${port}.json`);

function readProcStat(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces/parens — fields after the last ')' start at
    // field 3 (state); index 19 is starttime (field 22), index 2 is pgrp.
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (rest.length < 20) return null;
    return { state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]), startTime: Number(rest[19]) };
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function writeMarker(stateDir, meta) {
  const dir = groupsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = markerPath(stateDir, meta.port);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

function readMarker(stateDir, port) {
  try {
    const meta = JSON.parse(fs.readFileSync(markerPath(stateDir, port), 'utf8'));
    return meta && meta.pgid ? meta : null;
  } catch {
    return null;
  }
}

function removeMarker(stateDir, port) {
  try {
    fs.unlinkSync(markerPath(stateDir, port));
  } catch {}
}

function listMarkers(stateDir) {
  const dir = groupsDir(stateDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (meta && meta.pgid && meta.port) out.push(meta);
    } catch {}
  }
  return out;
}

// Written by the driver right after a successful launch. owner = the process
// that manages the group (the ACP server); pid+starttime together give a
// verifiable identity that survives pid reuse.
function recordGroup({ stateDir, port, pgid, mode, userDataDir, profileDir }) {
  if (!port || !pgid) return null;
  const meta = {
    version: 1,
    port: String(port),
    pgid: Number(pgid),
    pgidStartTime: readProcStat(pgid)?.startTime ?? null,
    ownerPid: process.pid,
    ownerStartTime: readProcStat(process.pid)?.startTime ?? null,
    mode: mode || null,
    userDataDir: userDataDir || null,
    profileDir: profileDir || null,
    launchedMs: Date.now(),
  };
  try {
    writeMarker(stateDir, meta);
    return meta;
  } catch {
    return null;
  }
}

// The current lease holder adopts a group launched by an earlier owner — the
// marker then points at a live verifiable owner instead of a dead one.
function adoptGroup(stateDir, port, meta = null) {
  meta = meta || readMarker(stateDir, port);
  if (!meta) return null;
  if (meta.ownerPid === process.pid) return meta;
  meta.ownerPid = process.pid;
  meta.ownerStartTime = readProcStat(process.pid)?.startTime ?? meta.ownerStartTime;
  try {
    writeMarker(stateDir, meta);
  } catch {}
  return meta;
}

function ownerAlive(meta) {
  if (!meta || !meta.ownerPid) return false;
  const st = readProcStat(meta.ownerPid);
  if (st) return meta.ownerStartTime == null || st.startTime === meta.ownerStartTime;
  return isPidAlive(meta.ownerPid);
}

function cmdlineMatchesPort(pid, port) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return new RegExp(`--remote-debugging-port=${port}(?![0-9])`).test(cmd);
  } catch {
    return false;
  }
}

// The pgid may outlive the group leader (e.g. xvfb-run exits while Xvfb and
// chrome stay). Check the leader first, then scan /proc for any member of the
// group still carrying our port flag — reparented members (ppid 1 or
// user-systemd) are found the same way.
function groupAliveMatches(meta) {
  if (!meta || !meta.pgid) return false;
  const leader = readProcStat(meta.pgid);
  if (leader && leader.pgrp === meta.pgid) {
    if (meta.pgidStartTime == null || leader.startTime === meta.pgidStartTime) {
      if (cmdlineMatchesPort(meta.pgid, meta.port)) return true;
    }
  }
  if (process.platform !== 'linux') return false;
  try {
    for (const ent of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = Number(ent);
      if (pid === meta.pgid) continue;
      const st = readProcStat(pid);
      if (st && st.pgrp === meta.pgid && cmdlineMatchesPort(pid, meta.port)) return true;
    }
  } catch {}
  return false;
}

function groupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Socket inodes owned by pid — used to exclude our own CDP connection when the
// deciding check runs before the process exits (clean shutdown path).
function socketInodesOf(pid) {
  const set = new Set();
  if (process.platform !== 'linux') return set;
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      try {
        const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m) set.add(m[1]);
      } catch {}
    }
  } catch {}
  return set;
}

// Live CDP clients = ESTABLISHED tcp connections to the debugging port.
// LISTEN is not a client; TIME_WAIT remnants don't count either.
function hasLiveCdpClients(port, { ignoreInodes = null } = {}) {
  if (process.platform !== 'linux') return false;
  const hex = Number(port).toString(16).toUpperCase().padStart(4, '0');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let data;
    try {
      data = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of data.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== '01') continue;
      const localPort = cols[1].split(':').pop();
      const remPort = cols[2].split(':').pop();
      if (localPort !== hex && remPort !== hex) continue;
      if (ignoreInodes && ignoreInodes.has(cols[9])) continue;
      return true;
    }
  }
  return false;
}

// Send a signal to the whole group only after re-verifying the marker still
// points at a chrome group with our port — protects against pgid reuse.
function signalGroup(meta, sig) {
  if (!groupAliveMatches(meta)) return false;
  try {
    process.kill(-meta.pgid, sig);
    return true;
  } catch {
    return false;
  }
}

// SIGTERM, short grace, SIGKILL — kills the whole detached group including
// Xvfb (children keep the leader's pgid). Async: callers hold no locks here.
async function killGroup(meta, { graceMs = 1200, stepMs = 100 } = {}) {
  const termSent = signalGroup(meta, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (groupExists(meta.pgid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (groupExists(meta.pgid)) signalGroup(meta, 'SIGKILL');
  // A second may pass before the group fully disappears; the caller decides
  // whether to drop the marker — the group is already doomed either way.
  return termSent || groupExists(meta.pgid);
}

module.exports = {
  resolveStateDir,
  groupsDir,
  markerPath,
  readProcStat,
  isPidAlive,
  writeMarker,
  readMarker,
  removeMarker,
  listMarkers,
  recordGroup,
  adoptGroup,
  ownerAlive,
  cmdlineMatchesPort,
  groupAliveMatches,
  groupExists,
  socketInodesOf,
  hasLiveCdpClients,
  signalGroup,
  killGroup,
};
