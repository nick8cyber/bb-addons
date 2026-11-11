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
import { appendFileSync, existsSync, readFileSync, watch } from "node:fs";
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

if (REAL_BIN.length === 0) {
  process.stderr.write("acp-shim: AGY_SHIM_REAL_BIN is not set\n");
  process.exit(2);
}

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

const child = spawn(REAL_BIN, process.argv.slice(2), {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
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
    setTimeout(() => sendSetMode(mode), SET_MODE_SETTLE_MS).unref?.();
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
if (CONTROL_FILE !== null) {
  try {
    // fs.watch throws ENOENT synchronously on a missing file and the catch
    // would swallow it — the file must exist before the watch registers.
    if (!existsSync(CONTROL_FILE)) appendFileSync(CONTROL_FILE, "");
    watch(CONTROL_FILE, () => {
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
          DISABLE_SUBAGENTS &&
          (msg.method === "session/new" || msg.method === "session/load") &&
          msg.params !== null &&
          typeof msg.params === "object"
        ) {
          msg.params.disableBuiltInTools = SUBAGENT_TOOLS_DISABLED;
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
rlIn.on("close", () => {
  acceptingClientInput = false;
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  const t = setTimeout(() => {
    if (!child.killed) child.kill("SIGTERM");
  }, 2500);
  t.unref?.();
});

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
  if (err?.code === "EPIPE") {
    acceptingClientInput = false;
    if (!child.killed) child.kill("SIGTERM");
    process.exitCode = 0;
  }
});

child.on("error", (err) => {
  acceptingClientInput = false;
  process.stderr.write(`acp-shim: failed to spawn ${REAL_BIN}: ${err.message}\n`);
});
child.on("close", (code, signal) => {
  acceptingClientInput = false;
  rlIn.close();
  process.exitCode = code ?? (signal ? 128 : 1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
