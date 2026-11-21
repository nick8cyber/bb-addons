#!/usr/bin/env node
/**
 * acp-shim — transparent NDJSON relay between bb's generic ACP bridge and a
 * real `agy acp` process. Spawned as:
 *
 *   node acp-shim.mjs <agy args...>   (e.g. "acp", "--gemini-dir", <dir>)
 *
 * IMPORTANT: this file rides inside the host bundle as base64
 * (src/acp-shim-source.ts) and is materialized to <dataDir>/acp-shim.mjs at
 * bridge start. After ANY edit, regenerate:
 *
 *   node scripts/gen-acp-shim-source.mjs
 *
 * It relays stdin → child stdin and child stdout → stdout untouched, and in
 * parallel sniffs the JSON-RPC traffic for things the generic bridge cannot
 * see (they never reach the daemon boundary):
 *
 *   - `session/prompt` responses: `result.usage` and the error text — appended
 *     to $AGY_SHIM_EVENTS as `{"t":"prompt-result",...}` BEFORE the line is
 *     relayed, so the wrapper always sees the event first;
 *   - `session/update` notifications whose `tool_call_update` carries a
 *     refusal text (the ArtifactMetadata "is not a valid artifact path"
 *     refusal) — appended as `{"t":"tool-refusal",...}`;
  *   - `session/new` / `session/load` requests: `disableBuiltInTools` is
 *     injected (bb owns all subagents — agy must not spawn its own ones);
 *   - `session/new` / `session/load` responses: the session id is remembered;
 *     when $AGY_SHIM_SET_MODE names a session mode, the shim then issues its
 *     own `session/set_mode` (ids from a private high range, responses
 *     swallowed) so the generic bridge never sees them;
 *   - $AGY_SHIM_CONTROL (NDJSON append file): each `{"cmd":"set_mode","mode":
 *     "<id>"}` line triggers another `session/set_mode` on the live session.
 *
 * Env: AGY_SHIM_REAL_BIN (required, the real agy binary), AGY_SHIM_EVENTS,
 * AGY_SHIM_CONTROL, AGY_SHIM_THREAD_ID, AGY_SHIM_NONCE, AGY_SHIM_SET_MODE.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  watch,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const REAL_BIN = process.env.AGY_SHIM_REAL_BIN ?? "";
const EVENTS_FILE = process.env.AGY_SHIM_EVENTS ?? null;
const CONTROL_FILE = process.env.AGY_SHIM_CONTROL ?? null;
const THREAD_ID = process.env.AGY_SHIM_THREAD_ID ?? null;
const NONCE = process.env.AGY_SHIM_NONCE ?? null;
const INITIAL_MODE = process.env.AGY_SHIM_SET_MODE ?? "";
const SHIM_ID_BASE = 1_000_000_000;
const SET_MODE_SETTLE_MS = 400;
// Built-in tools that let agy spawn its own agents invisibly to bb: every
// subagent must be a bb thread, so these names are injected into
// session/new|load params.disableBuiltInTools. Extra names are harmless —
// the agent filters the list against its own tool registry.
// AGY_DISABLE_SUBAGENTS=0 opts out (env relayed to the child as-is).
const SUBAGENT_TOOLS_DISABLED = [
  "invoke_subagent",
  "manage_subagents",
  "define_subagent",
  "browser_subagent",
  "run_subagent",
  "native_swarm",
  "manage_swarm",
  "boost",
];
const DISABLE_SUBAGENTS = process.env.AGY_DISABLE_SUBAGENTS !== "0";
// agy's native memory (memory/retrieve_memory/disable_memory plus a few
// speculative names — the agent filters unknown ones out of
// disableBuiltInTools) is invisible to bb, so it rides the same injection.
// AGY_DISABLE_MEMORY=0 opts back in.
const MEMORY_TOOLS_DISABLED = [
  "memory",
  "retrieve_memory",
  "disable_memory",
  "update_memory",
  "save_memory",
  "write_memory",
];
const DISABLE_MEMORY = process.env.AGY_DISABLE_MEMORY !== "0";

function emitEvent(fields) {
  if (EVENTS_FILE === null) return;
  try {
    appendFileSync(
      EVENTS_FILE,
      `${JSON.stringify({ nonce: NONCE, threadId: THREAD_ID, ...fields })}\n`,
    );
  } catch {
    // The side channel is best-effort; the relay itself must never die on it.
  }
}

// Per-spawn stderr capture (PLUG-373): the child's stderr used to ride
// "inherit" — whoever spawned the shim (the generic bridge) kept at most a
// tail for its own exit error, so an agy that died before session init left
// no readable record. Every stderr byte now lands in a sibling file of the
// events side channel, and the shutdown event carries the tail.
const STDERR_FILE =
  EVENTS_FILE !== null
    ? join(
        dirname(EVENTS_FILE),
        `stderr-${THREAD_ID ?? "unknown"}-${NONCE ?? "nononce"}.log`,
      )
    : null;
const STDERR_FILE_CAP = 256 * 1024;
const STDERR_TAIL_CAP = 4000;
let stderrFileBytes = 0;
let stderrFileCapped = false;
let stderrTail = "";

function appendStderrFile(chunk) {
  if (STDERR_FILE === null) return;
  try {
    if (stderrFileBytes >= STDERR_FILE_CAP) {
      if (!stderrFileCapped) {
        stderrFileCapped = true;
        appendFileSync(STDERR_FILE, "\n[acp-shim: stderr log capped]\n");
      }
      return;
    }
    appendFileSync(STDERR_FILE, chunk);
    stderrFileBytes += chunk.length;
  } catch {
    // Diagnostics never take the relay down.
  }
}

// The shim's own diagnostics go where the child's stderr goes: the per-spawn
// file AND our real stderr (a spawning peer may still pipe it).
function shimDiag(text) {
  const line = `acp-shim: ${text}\n`;
  appendStderrFile(line);
  stderrTail = (stderrTail + line).slice(-STDERR_TAIL_CAP);
  try {
    process.stderr.write(line);
  } catch {}
}

if (REAL_BIN.length === 0) {
  shimDiag("AGY_SHIM_REAL_BIN is not set");
  emitEvent({ t: "shim-shutdown", reason: "no-real-bin" });
  process.exit(2);
}

// Desktop bb runs this shim on its Electron binary with ELECTRON_RUN_AS_NODE=1
// (spec §12.5); agy and its node children must not inherit that mode.
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(REAL_BIN, process.argv.slice(2), {
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
  // Own process group: shutdown kills the whole agy tree with kill(-pid)
  // instead of orphaning agy's node grandchildren on the init system
  // (incident 16.11: 432 shim orphans, 6.1 GB RSS — spec §12.2.2).
  detached: true,
});

// Child stderr: per-spawn file + bounded tail for the shutdown event +
// passthrough to our own stderr (what "inherit" used to give the spawner).
let spawnErrorMessage = null;
child.stderr?.setEncoding("utf8");
child.stderr?.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP);
  appendStderrFile(chunk);
  try {
    process.stderr.write(chunk);
  } catch {}
});

let sessionId = null;
let shimId = SHIM_ID_BASE;

// --- session/load replay suppression --------------------------------------
// agy answers session/load in the middle of its conversation replay: the
// whole history (user/agent/thought chunks, tool calls) keeps streaming after
// the response, through the idle window and into the next prompt — past the
// generic bridge's session.loading gate, so replayed items render as the new
// turn's output (old answers glued ahead of live text, stale thinking after).
// The replay ends exactly when the conversation stream reaches the live edge:
// the user-message echo of the current session/prompt. Until that echo, every
// replayable update is dropped here, before the bridge can translate it.
const REPLAYABLE_KINDS = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);
let suppressReplay = false;
let promptTailNorm = null; // normalized tail of the pending prompt's user text
let boundaryArmed = false;
let droppedReplay = 0;
let echoBuf = ""; // normalized user-echo text accumulated while awaiting the boundary
let userEchoSeen = false; // positional boundary mode: a user chunk has arrived since the prompt
let shortTailMode = false; // prompt tail too short for content matching (<16 chars)
let replayFallbackTimer = null; // bounds the damage if no user echo ever arrives
let replayDeadline = 0; // hard ceiling: a live turn's chunks are drops too, so
// Live tool_call counts per in-flight prompt — agy's result.usage aggregates
// every model call of the turn, so the wrapper needs the step count to
// estimate the real context size (each call re-reads ~the whole cached
// prefix). Keyed by request id, NOT a single counter: a queued follow-up
// prompt (artifact nudge) can reach the wire before the previous result, and
// a naive reset would zero the previous turn's count mid-flight.
const promptToolCalls = new Map();
let activePromptId = null;
// activity alone must not keep the gate shut forever.
// A missed boundary must not eat a live turn: if the echo never comes, stop
// suppressing once the stream goes quiet, and never past REPLAY_DEADLINE_MS.
const REPLAY_BOUNDARY_TIMEOUT_MS = 20_000;
const REPLAY_DEADLINE_MS = 90_000;

function clearReplayTimer() {
  if (replayFallbackTimer !== null) {
    clearTimeout(replayFallbackTimer);
    replayFallbackTimer = null;
  }
}

// The fallback is a QUIET-stream detector, not a fixed deadline: every dropped
// replay update re-arms it, so a long replay stays suppressed to its end, but
// 20s of silence without the boundary echo means "no echo is coming" and the
// live turn must be let through.
function armReplayFallback() {
  clearReplayTimer();
  replayFallbackTimer = setTimeout(() => {
    replayFallbackTimer = null;
    if (suppressReplay) {
      suppressReplay = false;
      emitEvent({ t: "replay-abort", dropped: droppedReplay, reason: "boundary-quiet" });
    }
  }, REPLAY_BOUNDARY_TIMEOUT_MS);
  replayFallbackTimer.unref?.();
}

function normalizeText(t) {
  return String(t).replace(/\s+/g, " ").trim();
}
function promptTextTail(params) {
  const items = Array.isArray(params?.prompt) ? params.prompt : [];
  const joined = items
    .filter((i) => i && i.type === "text" && typeof i.text === "string")
    .map((i) => i.text)
    .join("\n");
  const n = normalizeText(joined);
  return n.length === 0 ? null : n.slice(-160);
}
let modeApplied = INITIAL_MODE.length === 0;
let modeSettleTimer = null;
const ownRequestIds = new Set();
/** client request id → {method, sessionId} for sniffing prompt responses. */
const pendingClientRequests = new Map();
/** sessionIds already mode-set this construction. */
const modesApplied = new Set();
let acceptingClientInput = true;

function writeChild(line) {
  try {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(`${line}\n`);
    }
  } catch {}
}

function sendSetMode(mode) {
  if (sessionId === null || typeof mode !== "string" || mode.length === 0) {
    return;
  }
  const id = ++shimId;
  ownRequestIds.add(id);
  writeChild(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/set_mode",
      params: { sessionId, modeId: mode },
    }),
  );
}

function maybeApplyInitialMode(newSessionId) {
  if (typeof newSessionId !== "string" || newSessionId.length === 0) return;
  sessionId = newSessionId;
  if (!modeApplied && !modesApplied.has(newSessionId)) {
    modesApplied.add(newSessionId);
    modeApplied = true;
    // Apply after the session settles: the agent may answer set_mode more
    // reliably right after session/new|load than in the same tick.
    const mode = INITIAL_MODE;
    modeSettleTimer = setTimeout(() => {
      modeSettleTimer = null;
      sendSetMode(mode);
    }, SET_MODE_SETTLE_MS);
    modeSettleTimer.unref?.();
  }
}

// --- control file: appended lines drive live session/set_mode -------------
// The whole file is re-read on every watch tick and skipped by line count;
// it stays a handful of lines for the life of a session.
let controlSeenLines = 0;
function drainControlFile() {
  if (CONTROL_FILE === null) return;
  let text;
  try {
    text = readFileSync(CONTROL_FILE, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= controlSeenLines) return;
  for (const line of lines.slice(controlSeenLines)) {
    try {
      const cmd = JSON.parse(line);
      if (cmd && cmd.cmd === "set_mode" && typeof cmd.mode === "string") {
        sendSetMode(cmd.mode);
      }
    } catch {}
  }
  controlSeenLines = lines.length;
}
let controlWatcher = null;
if (CONTROL_FILE !== null) {
  try {
    // fs.watch throws ENOENT synchronously on a missing file and the catch
    // would swallow it — the file must exist before the watch registers.
    if (!existsSync(CONTROL_FILE)) appendFileSync(CONTROL_FILE, "");
    controlWatcher = watch(CONTROL_FILE, () => {
      try { drainControlFile(); } catch {}
    });
  } catch {}
}

// --- stdin → child ---------------------------------------------------------

const rlIn = createInterface({ input: process.stdin, crlfDelay: Infinity });
rlIn.on("line", (line) => {
  drainControlFile();
  if (!acceptingClientInput) return;
  if (line.trim().length > 0) {
    try {
      const msg = JSON.parse(line);
      if (msg && msg.method !== undefined && msg.id !== undefined) {
        pendingClientRequests.set(msg.id, {
          method: msg.method,
          sessionId: msg.params?.sessionId ?? null,
        });
        if (
          (DISABLE_SUBAGENTS || DISABLE_MEMORY) &&
          (msg.method === "session/new" || msg.method === "session/load") &&
          msg.params !== null &&
          typeof msg.params === "object"
        ) {
          const disabled = [];
          if (DISABLE_SUBAGENTS) disabled.push(...SUBAGENT_TOOLS_DISABLED);
          if (DISABLE_MEMORY) disabled.push(...MEMORY_TOOLS_DISABLED);
          msg.params.disableBuiltInTools = disabled;
          line = JSON.stringify(msg);
        }
        if (msg.method === "session/load" || msg.method === "session/fork") {
          suppressReplay = true;
          promptTailNorm = null;
          boundaryArmed = false;
          droppedReplay = 0;
          echoBuf = "";
          userEchoSeen = false;
        } else if (msg.method === "session/prompt") {
          // A second prompt before the boundary echo means it was missed —
          // better to leak leftover replay than to drop a live turn.
          if (suppressReplay && boundaryArmed) {
            suppressReplay = false;
            emitEvent({ t: "replay-abort", dropped: droppedReplay, reason: "reprompt" });
          }
          promptTailNorm = promptTextTail(msg.params);
          boundaryArmed = true;
          echoBuf = "";
          promptToolCalls.set(msg.id, 0);
          activePromptId = msg.id;
          userEchoSeen = false;
          // A tiny prompt ("ok", "yes") can never satisfy the content match —
          // any same word in old history would also match. Fall back to the
          // positional boundary instead of eating the live turn to deadline.
          shortTailMode = promptTailNorm === null || promptTailNorm.length < 16;
          replayDeadline = Date.now() + REPLAY_DEADLINE_MS;
          if (suppressReplay) armReplayFallback();
        } else if (msg.method === "session/new") {
          suppressReplay = false;
          clearReplayTimer();
        }
      }
    } catch {}
  }
  writeChild(line);
});
rlIn.on("close", () => shutdown("stdin-eof"));

// --- child → stdout --------------------------------------------------------

const rlOut = createInterface({ input: child.stdout, crlfDelay: Infinity });
rlOut.on("line", (line) => {
  let handled = null;
  if (line.trim().length > 0) {
    try {
      const msg = JSON.parse(line);
      if (msg && typeof msg === "object") {
        if (ownRequestIds.has(msg.id)) {
          ownRequestIds.delete(msg.id);
          return; // swallowed: shim-private request
        }
        const isResponse =
          msg.method === undefined &&
          ("result" in msg || "error" in msg) &&
          pendingClientRequests.has(msg.id);
        if (isResponse) {
          const req = pendingClientRequests.get(msg.id);
          pendingClientRequests.delete(msg.id);
          if (req.method === "session/prompt") {
            emitEvent({
              t: "prompt-result",
              sessionId: req.sessionId ?? sessionId,
              toolCalls: promptToolCalls.get(msg.id) ?? 0,
              usage: msg.result?.usage ?? null,
              error: msg.error ? { code: msg.error.code ?? null, message: msg.error.message ?? String(msg.error) } : null,
            });
            promptToolCalls.delete(msg.id);
            if (activePromptId === msg.id) {
              const keys = [...promptToolCalls.keys()];
              activePromptId = keys.length === 0 ? null : keys[keys.length - 1];
            }
          } else if (
            req.method === "session/new" ||
            req.method === "session/load" ||
            req.method === "session/resume"
          ) {
            if (req.method === "session/load" && msg.error && suppressReplay) {
              // A failed load starts no replay; holding the gate would eat the
              // next live turn if the bridge retries with session/new late.
              suppressReplay = false;
              clearReplayTimer();
              emitEvent({ t: "replay-abort", dropped: droppedReplay, reason: "load-error" });
            }
            maybeApplyInitialMode(msg.result?.sessionId);
          }
        } else if (msg.method === "session/update") {
          const update = msg.params?.update;
          const kind = update?.sessionUpdate;
          if (suppressReplay && REPLAYABLE_KINDS.has(kind)) {
            const ct = update?.content;
            const text = typeof ct?.text === "string" ? normalizeText(ct.text) : "";
            let isBoundary = false;
            if (kind === "user_message_chunk" && boundaryArmed) {
              if (shortTailMode) {
                userEchoSeen = true;
              } else if (promptTailNorm !== null && text.length > 0) {
                // The echo may arrive chunked; accumulate it and compare tails.
                // The shorter side must carry 16+ real chars so a stray "yes"
                // or "ok" in old history cannot pose as the boundary.
                echoBuf = echoBuf.length === 0 ? text : `${echoBuf} ${text}`;
                const shorter = echoBuf.length <= promptTailNorm.length ? echoBuf : promptTailNorm;
                isBoundary =
                  shorter.length >= 16 &&
                  (echoBuf.endsWith(promptTailNorm) || promptTailNorm.endsWith(echoBuf));
              }
            } else if (boundaryArmed && shortTailMode && userEchoSeen) {
              // Conversation order guarantees everything after the user-echo
              // run is live: replayed items all precede the new echo.
              isBoundary = true;
            }
            if (isBoundary) {
              suppressReplay = false;
              clearReplayTimer();
              emitEvent({ t: "replay-end", dropped: droppedReplay });
            } else if (boundaryArmed && Date.now() > replayDeadline) {
              // Suppression has outlived any plausible replay: what is flowing
              // now is the live turn — stop dropping it.
              suppressReplay = false;
              clearReplayTimer();
              emitEvent({ t: "replay-abort", dropped: droppedReplay, reason: "boundary-deadline" });
            } else {
              droppedReplay += 1;
              if (boundaryArmed) armReplayFallback(); // still replaying: keep the gate shut
              return; // replayed history: swallowed, never reaches the bridge
            }
          }
          if (kind === "tool_call" && activePromptId !== null && promptToolCalls.has(activePromptId)) {
            promptToolCalls.set(activePromptId, promptToolCalls.get(activePromptId) + 1);
          }
          if (update?.sessionUpdate === "tool_call_update") {
            const texts = [];
            if (typeof update.title === "string") texts.push(update.title);
            for (const c of update.content ?? []) {
              if (c?.type === "content" && typeof c?.content?.text === "string") {
                texts.push(c.content.text);
              }
            }
            if (typeof update.rawOutput === "string") texts.push(update.rawOutput);
            const hit = texts.find((t) => /is not a valid artifact path/u.test(t));
            if (hit !== undefined) {
              emitEvent({
                t: "tool-refusal",
                sessionId: msg.params?.sessionId ?? sessionId,
                text: hit.slice(0, 2000),
              });
            }
          }
        }
      }
    } catch {
      // Unparseable lines are relayed as-is; JSON-RPC peers ignore junk.
    }
  }
  // The event (if any) is already on disk: the wrapper reads it before this
  // line can produce the corresponding boundary traffic.
  process.stdout.write(`${line}\n`);
});

child.stdin.on("error", () => { acceptingClientInput = false; });
child.stdout.on("error", () => {});
process.stdin.on("error", () => {});
process.stdout.on("error", (err) => {
  if (err?.code === "EPIPE") shutdown("epipe");
});

child.on("error", (err) => {
  acceptingClientInput = false;
  spawnErrorMessage = `failed to spawn ${REAL_BIN}: ${err.message}`;
  shimDiag(spawnErrorMessage);
});
child.on("close", (code, signal) => {
  childClosed = true;
  childCloseExitCode = code ?? (signal ? 128 : 1);
  shutdown("child-close");
});

// --- lifecycle: die with the owner (spec §12.1–12.2) ------------------------
// Every trigger below means the bridge side is gone or ordered us down:
// stdin EOF, a reparented ppid (the bridge worker died and init/systemd
// adopted us — PR_SET_PDEATHSIG has no portable Node binding), a signal, the
// child's own close, or EPIPE on the relay back. Shutdown kills the child's
// whole process group — agy spawns a small forest of node grandchildren that
// a plain child.kill() would orphan on the init system — then removes the
// private control file and exits explicitly instead of waiting for the
// event loop to drain (fs.watch and pending timers can outlive every
// trigger — that is how the 16.11 orphans stayed alive for days).
const SHUTDOWN_STDIN_GRACE_MS = 2_000;
const SHUTDOWN_TERM_GRACE_MS = 4_000;
const SHUTDOWN_DEADLINE_MS = 8_000;
let shuttingDown = false;
let childClosed = false;
let childCloseExitCode = null;

function killChildGroup(signal) {
  // detached makes the child a process-group leader; kill(-pid) reaches
  // `agy acp` and every grandchild it spawned. ESRCH means the group is
  // already gone — the fallback direct kill then simply no-ops too.
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {}
  try {
    child.kill(signal);
  } catch {}
}

function finishShutdown(code) {
  // Explicit exit — never wait for the loop to drain (spec §12.2.4).
  process.exit(code);
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  acceptingClientInput = false;
  emitEvent({
    t: "shim-shutdown",
    reason,
    exit: reason === "child-close" ? childCloseExitCode : null,
    sessionId,
    spawnError: spawnErrorMessage,
    stderr: stderrTail.trim() !== "" ? stderrTail.slice(-1500) : null,
  });
  try {
    rlIn.close();
  } catch {}
  if (controlWatcher !== null) {
    try {
      controlWatcher.close();
    } catch {}
    controlWatcher = null;
  }
  clearReplayTimer();
  if (modeSettleTimer !== null) {
    clearTimeout(modeSettleTimer);
    modeSettleTimer = null;
  }
  clearInterval(ppidWatch);
  // The control file is private to this shim (covers ctl-models.ndjson of
  // the maintenance shim too); the shared data dir is left alone.
  if (CONTROL_FILE !== null) {
    try {
      unlinkSync(CONTROL_FILE);
    } catch {}
  }
  const exitCode = reason === "child-close" ? (childCloseExitCode ?? 1) : 0;
  if (childClosed) {
    finishShutdown(exitCode);
    return;
  }
  try {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end();
    }
  } catch {}
  // stdin.end → grace ~2 s → SIGTERM on the group → ~4 s → SIGKILL on the
  // group; the deadline is insurance only and deliberately NOT unref'd —
  // the loop must be gone by ~8 s no matter what still holds it (§12.2).
  const termTimer = setTimeout(
    () => killChildGroup("SIGTERM"),
    SHUTDOWN_STDIN_GRACE_MS,
  );
  const killTimer = setTimeout(() => {
    killChildGroup("SIGKILL");
    finishShutdown(exitCode);
  }, SHUTDOWN_STDIN_GRACE_MS + SHUTDOWN_TERM_GRACE_MS);
  const deadline = setTimeout(
    () => finishShutdown(exitCode),
    SHUTDOWN_DEADLINE_MS,
  );
  child.once("close", () => {
    clearTimeout(termTimer);
    clearTimeout(killTimer);
    clearTimeout(deadline);
    finishShutdown(exitCode);
  });
}

// Parent-death watchdog: a reparented ppid means the bridge worker is gone.
const ownerPpid = process.ppid;
const ppidWatch = setInterval(() => {
  if (process.ppid !== ownerPpid) shutdown("parent-death");
}, 1_500);
ppidWatch.unref();

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown(`sig-${signal.toLowerCase()}`));
}
