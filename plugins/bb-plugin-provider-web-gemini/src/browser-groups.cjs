'use strict';
// Managed browser groups (PLUG-374): every chrome/xvfb-run process group the
// driver launches gets a marker file under <stateDir>/browser-groups/<port>.json
// recording the group identity (pgid + leader starttime) and a verifiable
// owner (pid + owner starttime). Reapers in acp-server.mjs use these markers to
// tear down groups that hold no lease and no live CDP clients — whether the
// owner died or the group simply went idle. Groups without a marker
// (externally launched chrome) are never touched.
//
// A marker flagged `reaping` is mid-teardown: backend selection refuses new
// leases/adoptions for its port while the flag is fresh, so the SIGTERM→grace→
// SIGKILL sequence cannot race a brand-new lease (contract §3).
//
// Boot scoping: pgid and starttime are per-boot values that repeat after a
// reboot, while markers on disk survive one. Every marker records the boot
// it was written in (boot_id); a marker with an absent or foreign bootId can
// never authorize signals and must not hold its port busy — the pgid it
// names may now belong to a foreign group. Reapers may clean such stale
// markers; the processes under them are never ours to touch (заход 4).

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

// A `reaping` mark stays authoritative only briefly — long enough to cover a
// SIGTERM grace + escalation check, short enough that a reaper dying
// mid-teardown releases the port quickly.
const REAPING_TTL_MS = 30_000;

// The boot this process runs under — /proc/sys/kernel/random/boot_id is a
// fresh random UUID per boot, so it separates markers across reboots with no
// reliance on clock state.
function currentBootId() {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// True only when the marker was written in this boot. Off Linux (or when
// boot_id is unreadable) there is nothing to compare — no scoping.
function markerMatchesBoot(meta) {
  const boot = currentBootId();
  if (!boot) return true;
  return Boolean(meta && meta.bootId && meta.bootId === boot);
}

function isReaping(meta, now = Date.now()) {
  // A reaping mark from a previous boot describes a teardown that can no
  // longer be in flight — it authorizes nothing and holds nothing busy.
  if (!markerMatchesBoot(meta)) return false;
  const r = meta && meta.reaping;
  return Boolean(r && Number.isFinite(r.sinceMs) && now - r.sinceMs < REAPING_TTL_MS);
}

// Drop our own reaping flag after a vetoed escalation — only when the marker
// still carries the exact mark this teardown wrote (by + sinceMs identity).
function clearReaping(stateDir, port, expected) {
  const cur = readMarker(stateDir, port);
  if (!cur || !cur.reaping) return;
  if (expected && (cur.reaping.by !== expected.by || cur.reaping.sinceMs !== expected.sinceMs)) return;
  delete cur.reaping;
  try {
    writeMarker(stateDir, cur);
  } catch {}
}

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
  // Every marker is boot-scoped: an explicit bootId (replay of an older meta,
  // or a deliberately foreign one) is preserved; a missing one is stamped
  // with the boot this write happens under.
  if (meta.bootId == null) meta.bootId = currentBootId();
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
    bootId: currentBootId(),
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
// marker then points at a live verifiable owner instead of a dead one. A
// fresh `reaping` mark refuses adoption: the group is being torn down.
function adoptGroup(stateDir, port, meta = null) {
  meta = meta || readMarker(stateDir, port);
  if (!meta) return null;
  // A stale-boot marker names a group that died with the previous boot —
  // whatever now matches its pgid is foreign and must never be adopted.
  if (!markerMatchesBoot(meta)) return null;
  if (isReaping(meta)) return null;
  if (meta.ownerPid === process.pid) return meta;
  meta.ownerPid = process.pid;
  meta.ownerStartTime = readProcStat(process.pid)?.startTime ?? meta.ownerStartTime;
  meta.adoptedMs = Date.now(); // covers the adopt→connect window like a launch
  delete meta.reaping; // drop a stale mark left by a reaper that died mid-teardown
  delete meta.doubt; // a fresh owner means the doubtful episode is over
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

function portFlagInCmdline(cmdline, port) {
  return new RegExp(`--remote-debugging-port=${port}(?![0-9])`).test(cmdline);
}

function cmdlineMatchesPort(pid, port) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return portFlagInCmdline(cmd, port);
  } catch {
    return false;
  }
}

// Live non-zombie members of a process group — reparented members (ppid 1 or
// user-systemd) are found the same way since only pgrp matters.
function groupMembers(pgid) {
  const out = [];
  if (process.platform !== 'linux') return out;
  try {
    for (const ent of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue;
      const st = readProcStat(Number(ent));
      if (!st || st.pgrp !== pgid || st.state === 'Z') continue;
      let cmdline = '';
      try {
        cmdline = fs.readFileSync(`/proc/${ent}/cmdline`, 'utf8').replace(/\0/g, ' ');
      } catch {}
      out.push({ pid: Number(ent), startTime: st.startTime, cmdline });
    }
  } catch {}
  return out;
}

// Our groups only ever contain the xvfb-run/chrome/Xvfb family. A leftover
// member is attributed to us when its cmdline matches that family and it did
// not start before the recorded group leader — the combination a foreign
// process group reusing our pgid cannot realistically satisfy.
const GROUP_MEMBER_CMDLINE = /xvfb|chrome|chromium|crashpad/i;

function memberLooksOurs(m, meta) {
  if (!GROUP_MEMBER_CMDLINE.test(m.cmdline)) return false;
  if (meta.pgidStartTime != null && m.startTime != null && m.startTime < meta.pgidStartTime) {
    return false;
  }
  return true;
}

// Surviving members of a leaderless group must sit inside the recorded
// launch burst — startTime is in USER_HZ jiffies (~100/s), so ~30 s covers
// even a slow xvfb-run→Xvfb→chrome spawn while exposing a foreign group
// that reused our pgid long after the recorded start.
const MEMBER_LAUNCH_WINDOW_JIFFIES = 3000;

// Verifiable identity of the group behind a marker:
//   'dead'     — no members left; ours is gone
//   'matched'  — a member still carries our remote-debugging-port flag
//   'leftover' — no flag carrier remains (chrome and the leader exited, e.g.
//                only Xvfb survives) but every remaining member is
//                attributable to our browser stack
//   'doubtful' — members exist that cannot be attributed to us, a live
//                leader carries a starttime different from the recorded one,
//                or leaderless survivors postdate the recorded launch (the
//                pgid may have been reused by a foreign group); the caller
//                must keep the marker and leave the group alone
//   'stale-boot' — the marker predates the current boot (or carries no
//                bootId): the pgid/starttime it records belong to processes
//                that died with that boot, so any live group matching them
//                is foreign; the caller must never signal it and may drop
//                the stale marker
//
// Boot scope is checked BEFORE any PID/PGID/port interpretation: those
// fields are per-boot values and a stale marker must not even reach them.
// Identity is checked BEFORE the port flag: --remote-debugging-port in a
// cmdline is only an attribute of an already-confirmed group — a foreign
// group that reused our pgid may carry the very same flag. When `diag` is
// given, diag.reason receives a short machine-readable cause.
function identifyGroup(meta, diag = null) {
  const why = (identity, reason) => {
    if (diag) diag.reason = reason;
    return identity;
  };
  if (!meta || !meta.pgid) return why('dead', 'no-pgid');
  if (!markerMatchesBoot(meta)) {
    return why('stale-boot', meta.bootId ? 'boot-mismatch' : 'boot-unrecorded');
  }
  if (process.platform !== 'linux') {
    return groupExists(meta.pgid) ? why('doubtful', 'non-linux') : why('dead', 'no-members');
  }
  const members = groupMembers(meta.pgid);
  if (members.length === 0) return why('dead', 'no-members');
  const leader = members.find((m) => m.pid === meta.pgid);
  if (leader) {
    // A live leader must carry the recorded starttime — pgid reuse leaves a
    // mismatch here regardless of any port flag its members may carry.
    if (meta.pgidStartTime == null) return why('doubtful', 'leader-starttime-unrecorded');
    if (leader.startTime !== meta.pgidStartTime) return why('doubtful', 'leader-starttime-mismatch');
    if (members.some((m) => portFlagInCmdline(m.cmdline, meta.port))) return why('matched', 'port-flag');
    return members.every((m) => memberLooksOurs(m, meta))
      ? why('leftover', 'attributable-members')
      : why('doubtful', 'unattributed-members');
  }
  // Leader gone: survivors must prove they still belong to the recorded
  // launch — every member attributable to the browser stack AND the earliest
  // survivor inside the launch burst. A foreign group that reused the pgid
  // after our recorded start fails the window even when every member wears
  // a chrome-family cmdline.
  if (meta.pgidStartTime == null) return why('doubtful', 'starttime-unrecorded');
  if (!members.every((m) => memberLooksOurs(m, meta))) return why('doubtful', 'unattributed-members');
  const earliest = Math.min(...members.map((m) => m.startTime ?? Infinity));
  if (earliest - meta.pgidStartTime > MEMBER_LAUNCH_WINDOW_JIFFIES) {
    return why('doubtful', 'members-postdate-launch');
  }
  return members.some((m) => portFlagInCmdline(m.cmdline, meta.port))
    ? why('matched', 'port-flag')
    : why('leftover', 'attributable-members');
}

// The group is verified as ours: either a member still carries the port flag,
// or only attributable leftovers (e.g. a lone Xvfb) survive the leader.
function groupAliveMatches(meta) {
  const identity = identifyGroup(meta);
  return identity === 'matched' || identity === 'leftover';
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
// points at an identifiable group of ours — protects against pgid reuse.
function signalGroup(meta, sig) {
  if (!groupAliveMatches(meta)) return false;
  try {
    process.kill(-meta.pgid, sig);
    return true;
  } catch {
    return false;
  }
}

// Live (non-zombie) membership — a group reduced to zombies is done for all
// signaling purposes even while kill(-pgid, 0) still answers.
function groupHasMembers(pgid) {
  if (process.platform !== 'linux') return groupExists(pgid);
  return groupMembers(pgid).length > 0;
}

// Poll until no member of the group remains (grace window for SIGTERM).
async function waitGroupGone(pgid, { graceMs = 1200, stepMs = 100 } = {}) {
  const deadline = Date.now() + graceMs;
  while (groupHasMembers(pgid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return !groupHasMembers(pgid);
}

// SIGTERM, short grace, SIGKILL — kills the whole detached group including
// Xvfb (children keep the leader's pgid). Async: callers hold no locks here.
async function killGroup(meta, { graceMs = 1200, stepMs = 100 } = {}) {
  const termSent = signalGroup(meta, 'SIGTERM');
  const gone = await waitGroupGone(meta.pgid, { graceMs, stepMs });
  if (!gone) signalGroup(meta, 'SIGKILL');
  // A second may pass before the group fully disappears; the caller decides
  // whether to drop the marker — the group is already doomed either way.
  return termSent || !gone;
}

module.exports = {
  resolveStateDir,
  groupsDir,
  markerPath,
  REAPING_TTL_MS,
  currentBootId,
  markerMatchesBoot,
  readProcStat,
  isPidAlive,
  writeMarker,
  readMarker,
  removeMarker,
  listMarkers,
  recordGroup,
  adoptGroup,
  isReaping,
  clearReaping,
  ownerAlive,
  portFlagInCmdline,
  cmdlineMatchesPort,
  groupMembers,
  identifyGroup,
  groupAliveMatches,
  groupExists,
  socketInodesOf,
  hasLiveCdpClients,
  signalGroup,
  waitGroupGone,
  killGroup,
};
