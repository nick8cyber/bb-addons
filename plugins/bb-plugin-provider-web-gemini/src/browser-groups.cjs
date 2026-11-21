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
//
// Boot knowledge itself is tri-state (заход 5): on non-Linux platforms
// /proc does not exist and scoping simply does not apply, but on Linux an
// UNREADABLE boot_id is a broken-proc state — the marker may be ours or
// foreign and we cannot tell. That case fails closed (identity
// 'boot-unknown'): no signals, no adoption, no marker deletion.
//
// Every marker write/delete runs under a per-port kernel lock
// (<groupsDir>/<port>.lock held via flock(2) on an open fd): the
// read-verify-write and read-verify-unlink sections of
// recordGroup/adoptGroup/reaper/driver-stop are serialized across
// processes, so a marker written by a concurrent launch or adoption cannot
// be clobbered by a teardown that verified against an older snapshot
// (заход 5). The lock is owned by the open file description — the kernel
// releases it when the holder's last fd closes, including on death, so no
// stale-steal is ever needed and a paused holder's lock is never taken
// away (заход 6). On Linux a missing or failing `flock` fails closed
// (заход 7): every locked section refuses with BG_LOCK_UNAVAILABLE —
// the in-process fallback is only ever used where boot scoping is 'off'.

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
const markerLockPath = (stateDir, port) => path.join(groupsDir(stateDir), `${port}.lock`);

// A `reaping` mark stays authoritative only briefly — long enough to cover a
// SIGTERM grace + escalation check, short enough that a reaper dying
// mid-teardown releases the port quickly.
const REAPING_TTL_MS = 30_000;

const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

// Boot knowledge is tri-state:
//   'off'      — non-Linux: /proc (and boot_id) does not exist, so boot
//                scoping does not apply at all;
//   'unknown'  — Linux but boot_id unreadable (EACCES, broken /proc in a
//                sandbox): FAIL CLOSED. A marker may be ours or foreign;
//                nothing may be signaled, adopted, or deleted on it;
//   <uuid>     — the id of the boot this process runs under
//                (/proc/sys/kernel/random/boot_id is a fresh random UUID
//                per boot, separating markers across reboots with no
//                reliance on clock state).
function bootState() {
  if (process.platform !== 'linux') return 'off';
  try {
    return fs.readFileSync(BOOT_ID_PATH, 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// The boot id string, or null when scoping does not apply / cannot be
// determined. Markers stamped while boot is 'unknown' carry bootId:null —
// once boot_id is readable again they classify as boot-unrecorded stale.
function currentBootId() {
  const s = bootState();
  return s === 'off' || s === 'unknown' ? null : s;
}

// Tri-state boot check:
//   true  — the marker verifiably belongs to this boot (or the platform
//           has no boot scoping at all);
//   false — the marker is verifiably foreign (other boot or no bootId);
//   null  — indeterminate: Linux, but boot_id unreadable. Callers must
//           treat this as fail-closed, exactly like false for signaling
//           and adoption, and must NOT remove the marker either.
function markerMatchesBoot(meta) {
  const s = bootState();
  if (s === 'off') return true;
  if (s === 'unknown') return null;
  return Boolean(meta && meta.bootId && meta.bootId === s);
}

function isReaping(meta, now = Date.now()) {
  // A reaping mark from a verifiably foreign boot describes a teardown that
  // can no longer be in flight — it authorizes nothing and holds nothing
  // busy. An indeterminate boot keeps the mark: a teardown that may still
  // be running is allowed to hold its port briefly (TTL-bounded), though
  // it can never authorize a signal — groupAliveMatches gates that first.
  if (markerMatchesBoot(meta) === false) return false;
  const r = meta && meta.reaping;
  return Boolean(r && Number.isFinite(r.sinceMs) && now - r.sinceMs < REAPING_TTL_MS);
}

// Drop our own reaping flag after a vetoed escalation — only when the marker
// still carries the exact mark this teardown wrote (by + sinceMs identity).
function clearReaping(stateDir, port, expected) {
  withMarkerLock(stateDir, port, () => {
    const cur = readMarker(stateDir, port);
    if (!cur || !cur.reaping) return;
    if (expected && (cur.reaping.by !== expected.by || cur.reaping.sinceMs !== expected.sinceMs)) return;
    delete cur.reaping;
    try {
      writeMarkerUnlocked(stateDir, cur);
    } catch {}
  });
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

// --- per-port marker lock (заход 5, flock — заход 6) ---
// Kernel lock on the lockfile's open file description: `flock -x -w T <fd>`
// applied to an fd we keep open. flock(2) locks live on the description,
// not the calling process — the helper exits immediately and our fd keeps
// the lock; closeSync (or our death) releases it. A paused-but-alive
// holder simply keeps its lock — there is no steal and no
// release-the-successor's-lock window. Every writer — recordGroup,
// adoptGroup, clearReaping, reaper branches, driver stop — runs its
// read-verify-write / read-verify-unlink section under it.
// The lockfile is NEVER unlinked: deleting it would let a waiter parked on
// the old inode and a creator of a fresh file lock different objects.
// Readers (readMarker/listMarkers/isReaping) stay lock-free: single-file
// rename writes are atomic.

const MARKER_LOCK_WAIT_MS = Number(process.env.BG_MARKER_LOCK_WAIT_MS) || 10_000;

// Lock files this process already holds (path -> fd, or null on non-Linux
// where flock does not exist and only the in-process reentrancy guard
// applies — the same axis as boot scoping 'off'). On Linux the kernel lock
// is MANDATORY: without a working flock there is no cross-process
// serialization, so marker writes/removals and the teardown signal path
// FAIL CLOSED (заход 7) instead of silently degrading to the Map — a
// second process would otherwise enter the section concurrently with a
// live kernel-lock holder. Same-process reentrancy: a locked writeMarker
// inside a withMarkerLock section must not re-acquire.
const heldMarkerLocks = new Map();

// Sleep without burning CPU — works on the main thread in Node.
const lockSpin = (() => {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  return (ms) => Atomics.wait(buf, 0, 0, ms);
})();

let flockAvailable;
function flockBin() {
  if (flockAvailable === undefined) {
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync('flock', ['--version'], { stdio: 'ignore' });
      flockAvailable = !r.error && r.status === 0;
    } catch {
      flockAvailable = false;
    }
  }
  return flockAvailable ? 'flock' : null;
}

// Fail-closed refusal on Linux (заход 7): the error carries a machine-
// readable code and the reason so every caller — reaper, stopChrome,
// adopt/record — propagates it into its own diagnostics (slog / thrown
// launch error) instead of the section silently running unsynchronized.
function markerLockUnavailable(reason) {
  const err = new Error(`browser-group marker lock unavailable on linux: ${reason}`);
  err.code = 'BG_LOCK_UNAVAILABLE';
  return err;
}

function acquireMarkerLock(stateDir, port) {
  const p = markerLockPath(stateDir, port);
  if (heldMarkerLocks.has(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const bin = flockBin();
  if (!bin) {
    // Non-Linux (bootState 'off' axis): no flock exists at all, degrade to
    // the in-process guard. Linux: refuse — no serialization, no section.
    if (process.platform === 'linux') throw markerLockUnavailable('flock not found on PATH');
    heldMarkerLocks.set(p, null);
    return;
  }
  const { spawnSync } = require('child_process');
  // The lock file persists forever — we only ever lock the description.
  const fd = fs.openSync(p, 'a');
  // stdio[3] hands the child a dup of our fd — same open file description,
  // so the flock(2) lock the child takes stays held by OUR fd after the
  // child exits (kernel auto-release on close/death — no stale-steal).
  const res = spawnSync(bin, ['-x', '-w', String(Math.ceil(MARKER_LOCK_WAIT_MS / 1000)), '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
    timeout: MARKER_LOCK_WAIT_MS + 10_000,
  });
  if (res.error && process.platform === 'linux') {
    try { fs.closeSync(fd); } catch {}
    if (res.error.code === 'ENOENT') flockAvailable = false; // binary vanished mid-run
    throw markerLockUnavailable(`flock spawn failed: ${res.error.code || res.error.message || res.error}`);
  }
  if (res.error && res.error.code === 'ENOENT') {
    flockAvailable = false; // binary vanished mid-run — degrade to reentrancy
    try { fs.closeSync(fd); } catch {}
    heldMarkerLocks.set(p, null);
    return;
  }
  if (res.error || res.status !== 0) {
    try { fs.closeSync(fd); } catch {}
    throw new Error(`browser-group marker lock held: ${p}`);
  }
  heldMarkerLocks.set(p, fd);
}

function releaseMarkerLock(stateDir, port) {
  const p = markerLockPath(stateDir, port);
  const fd = heldMarkerLocks.get(p);
  heldMarkerLocks.delete(p);
  if (fd != null) {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

// Serialize a synchronous marker section per port. fn must be synchronous —
// the lock is never held across an await (async phases like the SIGTERM
// grace happen outside it).
function withMarkerLock(stateDir, port, fn) {
  const p = markerLockPath(stateDir, port);
  if (heldMarkerLocks.has(p)) return fn(); // already inside our own section
  acquireMarkerLock(stateDir, port);
  try {
    return fn();
  } finally {
    releaseMarkerLock(stateDir, port);
  }
}

function writeMarkerUnlocked(stateDir, meta) {
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

function writeMarker(stateDir, meta) {
  withMarkerLock(stateDir, meta.port, () => writeMarkerUnlocked(stateDir, meta));
}

function readMarker(stateDir, port) {
  try {
    const meta = JSON.parse(fs.readFileSync(markerPath(stateDir, port), 'utf8'));
    return meta && meta.pgid ? meta : null;
  } catch {
    return null;
  }
}

function removeMarkerUnlocked(stateDir, port) {
  try {
    fs.unlinkSync(markerPath(stateDir, port));
  } catch {}
}

function removeMarker(stateDir, port) {
  withMarkerLock(stateDir, port, () => removeMarkerUnlocked(stateDir, port));
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
  // A group that cannot be marked is a group reapers will never manage —
  // surface the failure (marker lock unavailable, fs error) instead of
  // silently leaving an unmanaged browser running (fail-closed, заход 7).
  writeMarker(stateDir, meta);
  return meta;
}

// The current lease holder adopts a group launched by an earlier owner — the
// marker then points at a live verifiable owner instead of a dead one. A
// fresh `reaping` mark refuses adoption: the group is being torn down.
function adoptGroup(stateDir, port, meta = null) {
  // Lock and marker-write failures propagate (заход 7): an adoption that
  // could not run under the kernel lock or could not be persisted must not
  // pretend to have happened — the caller sees and records the refusal.
  // Declines inside the section still return null.
  return withMarkerLock(stateDir, port, () => {
    // The freshest on-disk marker wins over a caller-supplied copy.
    meta = readMarker(stateDir, port) || meta;
    if (!meta) return null;
    // A stale-boot marker names a group that died with the previous boot —
    // whatever now matches its pgid is foreign and must never be adopted.
    // An indeterminate boot (markerMatchesBoot → null) fails closed too.
    if (!markerMatchesBoot(meta)) return null;
    if (isReaping(meta)) return null;
    if (meta.ownerPid === process.pid) return meta;
    meta.ownerPid = process.pid;
    meta.ownerStartTime = readProcStat(process.pid)?.startTime ?? meta.ownerStartTime;
    meta.adoptedMs = Date.now(); // covers the adopt→connect window like a launch
    delete meta.reaping; // drop a stale mark left by a reaper that died mid-teardown
    delete meta.doubt; // a fresh owner means the doubtful episode is over
    writeMarkerUnlocked(stateDir, meta);
    return meta;
  });
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
//   'boot-unknown' — Linux, but boot_id is unreadable: the marker's boot
//                cannot be verified at all — it may be ours. Fail closed:
//                no signals, no adoption, no marker deletion (заход 5).
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
  const boot = markerMatchesBoot(meta);
  if (boot === false) {
    return why('stale-boot', meta.bootId ? 'boot-mismatch' : 'boot-unrecorded');
  }
  if (boot === null) return why('boot-unknown', 'boot-unreadable');
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

// --- shared safe teardown (заход 6) ---
// One pipeline for both the acp-server reaper and the driver's stopChrome:
// decision + `reaping` mark + SIGTERM run inside outerLock → markerLock;
// the grace wait runs unlocked; SIGKILL escalation re-verifies under the
// same locks. Lock order is always outer → marker.
//
//   withOuterLock(fn) — serializes the lease check against lease writers
//     (acp-server wraps the accounts-ledger lock; the driver uses
//     withLedgerLock). Default: no outer lock.
//   busy(meta, now)  — caller gate inside the locked section (a live lease
//     on the port); returns a reason string to veto, null to proceed.
//   ownOnly          — only a marker we own may be torn down (clean
//     shutdown); also skips the live-owner startup grace.
//   ignoreInodes     — socket inodes excluded from the CDP-client check
//     (the caller's own playwright connections).
//   ownerGraceMs     — a young/recently-adopted group under a live owner is
//     still launching: busy, never signaled.
//
// Returns { status, reason?, marked? }:
//   'torn-down' — the group was verified ours, signaled, and the marker
//                 removed; 'absent' — no (matching) marker or the group is
//                 already gone (dead/stale-boot marker cleaned); 'busy' —
//                 gated by reaping/owner-grace/lease/CDP — retry later;
//   'skipped'   — refused (not ours to touch, identity unverifiable, or
//                 nothing signalable) — the marker is left alone.
const DEFAULT_OWNER_GRACE_MS = 60_000;

async function teardownGroup({
  stateDir,
  port,
  meta = null,
  withOuterLock = null,
  busy = null,
  ownOnly = false,
  ignoreInodes = null,
  ownerGraceMs = 0,
  graceMs = 1200,
  stepMs = 100,
} = {}) {
  const outer = withOuterLock || ((fn) => fn());
  const phase = outer(() => withMarkerLock(stateDir, port, () => {
    const now = Date.now();
    // Re-read under the locks — a caller-supplied snapshot predates them.
    const cur = readMarker(stateDir, port);
    if (!cur) return { status: 'absent' };
    if (meta && cur.pgid !== meta.pgid) return { status: 'absent', reason: 'marker-changed' };
    if (ownOnly && cur.ownerPid !== process.pid) return { status: 'skipped', reason: 'not-owner' };
    // A fresh reaping mark means a teardown is already in flight (marks are
    // only ever written under these locks, so ours cannot be fresh here).
    if (isReaping(cur, now)) return { status: 'busy', reason: 'reaping' };
    // A live FOREIGN owner may be mid-launch or mid-adoption — the marker
    // is written before CDP readiness/client connect — so young or
    // freshly-adopted groups get a startup grace; a dead owner or an old
    // idle group (no lease, no clients) is fair game (contract §2). Our own
    // marker needs no grace here: an own group mid-launch is already
    // protected by the lease gate (bindBackend takes the lease before the
    // driver spawns), and an explicit owner-driven stop must not wait it
    // out (заход 6).
    if (ownerAlive(cur) && !ownOnly && ownerGraceMs > 0 && cur.ownerPid !== process.pid) {
      const young = Number.isFinite(cur.launchedMs) && now - cur.launchedMs < ownerGraceMs;
      const adopted = Number.isFinite(cur.adoptedMs) && now - cur.adoptedMs < ownerGraceMs;
      if (young || adopted) return { status: 'busy', reason: 'owner-starting' };
    }
    if (busy) {
      const reason = busy(cur, now);
      if (reason) return { status: 'busy', reason: String(reason) };
    }
    if (hasLiveCdpClients(cur.port, { ignoreInodes })) return { status: 'busy', reason: 'cdp-clients' };
    const identity = identifyGroup(cur);
    if (identity === 'dead' || identity === 'stale-boot') {
      // Nothing live of ours to signal — the marker is the only residue
      // (dead: group gone; stale-boot: it died with its boot and any group
      // matching the recorded pgid is foreign — only the marker is ours
      // to clean).
      removeMarkerUnlocked(stateDir, port);
      return { status: 'absent', reason: identity };
    }
    if (identity !== 'matched' && identity !== 'leftover') {
      return { status: 'skipped', reason: identity };
    }
    const marked = { ...cur, reaping: { by: process.pid, sinceMs: now } };
    writeMarkerUnlocked(stateDir, marked);
    if (!signalGroup(marked, 'SIGTERM')) {
      writeMarkerUnlocked(stateDir, cur); // nothing signaled — unmark
      return { status: 'skipped', reason: 'signal-failed' };
    }
    return { status: 'signaled', marked };
  }));
  if (phase.status !== 'signaled') return phase;
  const marked = phase.marked;

  if (!(await waitGroupGone(marked.pgid, { graceMs, stepMs }))) {
    // Grace expired — re-verify under the same locks before escalating:
    // the reaping mark kept leases out, but anything that slipped through
    // (a rewritten marker, a live lease, a connected CDP client, or a
    // group identity that no longer matches) vetoes the SIGKILL.
    const killed = outer(() => withMarkerLock(stateDir, port, () => {
      const now = Date.now();
      const cur = readMarker(stateDir, port);
      if (!cur || cur.pgid !== marked.pgid) return false;
      if (cur.ownerPid !== marked.ownerPid || cur.ownerStartTime !== marked.ownerStartTime) return false;
      if (cur.reaping?.by !== process.pid || cur.reaping?.sinceMs !== marked.reaping.sinceMs) return false;
      if (busy && busy(cur, now)) return false;
      if (hasLiveCdpClients(cur.port, { ignoreInodes })) return false;
      if (!groupAliveMatches(cur)) return false;
      return signalGroup(cur, 'SIGKILL');
    }));
    if (!killed) {
      clearReaping(stateDir, port, marked.reaping);
      return { status: 'busy', reason: 'escalation-vetoed' };
    }
  }
  // A fresh owner may have adopted the marker while the group was dying —
  // only remove it if it still describes what we tore down; check+unlink
  // is one serialized section.
  withMarkerLock(stateDir, port, () => {
    const cur = readMarker(stateDir, port);
    if (cur && cur.pgid === marked.pgid && cur.ownerPid === marked.ownerPid) {
      removeMarkerUnlocked(stateDir, port);
    }
  });
  return { status: 'torn-down' };
}

// --- accounts-ledger lock + lease gate for non-ACP callers (заход 6) ---
// The driver must serialize its lease check + reaping mark against lease
// writers exactly like the reaper. acp-server's ledger lock is an O_EXCL
// lockfile at <ledger>.lock — the same primitive and the same path are
// used here so old and new processes still exclude each other (flock and
// O_EXCL do not interoperate; a rolling upgrade must not mix them).
const LEDGER_LOCK_STALE_MS = 5000; // mirrors acp-server LOCK_STALE_MS
const LEDGER_LOCK_WAIT_MS = 10_000; // mirrors acp-server deadline
const LEASE_TTL_MS = 10 * 60_000; // mirrors acp-server LEASE_TTL_MS

const ledgerPathFor = (stateDir) => path.join(resolveStateDir(stateDir), 'accounts-state.json');
const ledgerLockPathFor = (stateDir) => `${ledgerPathFor(stateDir)}.lock`;

function withLedgerLock(stateDir, fn) {
  const p = ledgerLockPathFor(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(p, 'wx');
      try {
        fs.closeSync(fd);
      } catch {}
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs > LEDGER_LOCK_STALE_MS) {
          try {
            fs.unlinkSync(p);
          } catch {}
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error(`accounts-ledger lock held: ${p}`);
      lockSpin(40);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

function readLedger(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPathFor(stateDir), 'utf8'));
  } catch {
    return null;
  }
}

// A live lease recorded against this port's CDP endpoint. Leases written
// before the `cdp` field existed cannot be mapped — treat them as possibly
// this port's (conservative; they expire within one TTL).
function leaseBusyOnPort(ledger, port, now, { ttlMs = LEASE_TTL_MS, excludePid = null } = {}) {
  for (const l of Object.values((ledger && ledger.leases) || {})) {
    if (!l) continue;
    if (excludePid != null && l.pid === excludePid) continue;
    if (!Number.isFinite(l.acquiredMs) || now - l.acquiredMs >= ttlMs) continue;
    if (!isPidAlive(l.pid)) continue;
    if (l.cdp != null && String(l.cdp) !== String(port)) continue;
    return true;
  }
  return false;
}

module.exports = {
  resolveStateDir,
  groupsDir,
  markerPath,
  markerLockPath,
  withMarkerLock,
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
  teardownGroup,
  DEFAULT_OWNER_GRACE_MS,
  LEASE_TTL_MS,
  ledgerPathFor,
  ledgerLockPathFor,
  withLedgerLock,
  readLedger,
  leaseBusyOnPort,
};
