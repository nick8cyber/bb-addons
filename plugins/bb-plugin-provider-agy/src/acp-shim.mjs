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
    watch(CONTROL_FILE, () => {
      try { drainControlFile(); } catch {}
    });
  } catch {}
}

// --- stdin → child ---------------------------------------------------------

const rlIn = createInterface({ input: process.stdin, crlfDelay: Infinity });
rlIn.on("line", (line) => {
  if (!acceptingClientInput) return;
  if (line.trim().length > 0) {
    try {
      const msg = JSON.parse(line);
      if (msg && msg.method !== undefined && msg.id !== undefined) {
        pendingClientRequests.set(msg.id, {
          method: msg.method,
          sessionId: msg.params?.sessionId ?? null,
        });
      }
    } catch {}
  }
  writeChild(line);
});
rlIn.on("close", () => {
  acceptingClientInput = false;
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
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
              usage: msg.result?.usage ?? null,
              error: msg.error ? { code: msg.error.code ?? null, message: msg.error.message ?? String(msg.error) } : null,
            });
          } else if (
            req.method === "session/new" ||
            req.method === "session/load" ||
            req.method === "session/resume"
          ) {
            maybeApplyInitialMode(msg.result?.sessionId);
          }
        } else if (msg.method === "session/update") {
          const update = msg.params?.update;
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
