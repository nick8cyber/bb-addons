#!/usr/bin/env node
/**
 * A stand-in for `agy acp`: a newline-JSON-RPC ACP server on stdin/stdout,
 * driven entirely by env + prompt markers so the wrapper's whole automaton
 * is testable with no network and no Google account.
 *
 * Env:
 *   AGY_FAKE_TRANSCRIPT     append every inbound JSON-RPC line here (NDJSON)
 *   AGY_FAKE_RECORD_ENV     comma-separated env names recorded into transcript
 *   AGY_FAKE_MODE_BY_LABEL  JSON {"<homeLabel>": "<mode>"} — the label is the
 *                           basename of the --gemini-dir's parent dir
 *   AGY_FAKE_ERROR_MODE     fallback mode: "ok" | "quota-once" | "quota-always" | "ineligible"
 *   AGY_FAKE_QUOTA_MSG      quota error text (must carry "Resets in …")
 *   AGY_FAKE_RELEASE        a [[hold]] prompt finishes when this file exists
 *   AGY_FAKE_COMPACT_MODE   "fail" makes a standalone "/compact" prompt error
 *   AGY_FAKE_SUMMARY_MODE   "empty"|"fail" — the summary prompt's outcome
 *
 * Prompt markers: [[quota]] (prompt errors with quota text), [[hold]],
 * [[artifact]] (tool_call_update with artifact-path refusal), [[askperm]]
 * (session/request_permission that hangs until answered), [[die]] (exit).
 */
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const argv = process.argv.slice(2);
const geminiDir = argv.includes("--gemini-dir") ? argv[argv.indexOf("--gemini-dir") + 1] : null;
const homeLabel = geminiDir ? basename(dirname(geminiDir)) : "direct";
const modesByLabel = JSON.parse(process.env.AGY_FAKE_MODE_BY_LABEL ?? "{}");
const modeEnv = modesByLabel[homeLabel] ?? process.env.AGY_FAKE_ERROR_MODE ?? "ok";
// Dynamic modes ride a control file (children keep their spawn env):
// {"modeByLabel": {"a2": "quota-always"}, "compactMode": "fail", "summaryMode": "empty"}
const controlFile = process.env.AGY_FAKE_CONTROL ?? null;
function control() {
  if (controlFile === null) return {};
  try { return JSON.parse(readFileSync(controlFile, "utf8")); } catch { return {}; }
}
const transcript = process.env.AGY_FAKE_TRANSCRIPT ?? null;
const recordEnv = (process.env.AGY_FAKE_RECORD_ENV ?? "").split(",").filter(Boolean);
const releaseFile = process.env.AGY_FAKE_RELEASE ?? null;
const compactModeEnv = process.env.AGY_FAKE_COMPACT_MODE ?? "ok";
const summaryModeEnv = process.env.AGY_FAKE_SUMMARY_MODE ?? "ok";
const quotaMsg =
  process.env.AGY_FAKE_QUOTA_MSG ??
  "Quota exhausted for this account; retry later. Resets in 0h0m4s.";
const ineligibleMsg = "This account is not eligible for Antigravity. Verify your account.";

const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envRecord = {};
for (const k of recordEnv) envRecord[k] = process.env[k] ?? null;

let sessionCounter = 0;
let sessionId = null;
let seq = 0;
const record = (obj) => {
  if (transcript) appendFileSync(transcript, `${JSON.stringify({ home: homeLabel, __env: envRecord, ...obj })}\n`);
};

const configOptions = [
  { id: "model", category: "model", type: "select", currentValue: "fake-model",
    options: [{ value: "fake-model", name: "Fake Model" }] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: "medium",
    options: [{ value: "low", name: "low" }, { value: "medium", name: "medium" }, { value: "high", name: "high" }] },
];
const modes = {
  availableModes: [
    { id: "default", name: "Default" }, { id: "auto_edit", name: "Auto Edit" },
    { id: "yolo", name: "Yolo" }, { id: "plan", name: "Plan" },
  ],
  currentModeId: "default",
};

function sentinel(name) {
  return join(geminiDir ?? "/tmp", `.fake-acp-${name}`);
}
function once(name) {
  const f = sentinel(name);
  if (existsSync(f)) return false;
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, "1"); } catch {}
  return true;
}

let usageTotal = 0;
async function runPrompt(id, text) {
  const ctl = control();
  const mode = ctl.modeByLabel?.[homeLabel] ?? ctl.errorMode ?? modeEnv;
  const compactMode = ctl.compactMode ?? compactModeEnv;
  const summaryMode = ctl.summaryMode ?? summaryModeEnv;
  const replayable = ["agent_message_chunk","agent_thought_chunk","user_message_chunk","tool_call","tool_call_update","plan"];
  const upd = (update, record = true) => {
    if (record && replayable.includes(update.sessionUpdate)) replayed.push(update);
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  };
  if (text.includes("[[die]]")) {
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "bye" } });
    out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usage() } });
    await sleep(30);
    process.exit(0);
  }
  if (text.trimStart().startsWith("[[quota]]") || mode === "quota-always" || (mode === "quota-once" && once("q"))) {
    out({ jsonrpc: "2.0", id, error: { code: 429, message: quotaMsg } });
    return;
  }
  if (mode === "ineligible" && once("inel")) {
    out({ jsonrpc: "2.0", id, error: { code: 403, message: ineligibleMsg } });
    return;
  }
  if (mode === "auth-dead") {
    out({ jsonrpc: "2.0", id, error: { code: 401, message: "Authentication required" } });
    return;
  }
  if (/^\s*\/compact\s*$/u.test(text) && compactMode === "fail") {
    out({ jsonrpc: "2.0", id, error: { code: 500, message: "API error (attempt 1): INTERNAL (code 500): cannot compact" } });
    return;
  }
  if (text.startsWith("[compaction-fallback]") && summaryMode === "fail") {
    out({ jsonrpc: "2.0", id, error: { code: 500, message: "API error (attempt 1): INTERNAL (code 500): summary failed" } });
    return;
  }
  if (text.includes("[[askperm]]")) {
    const rid = `perm-${++seq}`;
    out({ jsonrpc: "2.0", id: rid, method: "session/request_permission",
      params: { sessionId, toolCall: { toolCallId: "tc-1", title: "run it" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } });
    pendingPerm.set(rid, () => finish());
    return; // answered when the permission response arrives
  }
  await finish();
  async function finish() {
    upd({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    upd({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `thinking about: ${text.slice(-40)}` } });
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer to ${text.slice(-60)}` } });
    if (text.includes("[[artifact]]")) {
      upd({ sessionUpdate: "tool_call", toolCallId: "tc-art", title: "write_to_file", kind: "edit", status: "in_progress" });
      upd({ sessionUpdate: "tool_call_update", toolCallId: "tc-art", status: "failed",
        content: [{ type: "content", content: { type: "text", text: `${process.cwd()}/out.txt is not a valid artifact path; artifacts must be in ~/.gemini/antigravity-cli/brain/x/` } }] });
    }
    if (text.includes("[[tool]]")) {
      upd({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run_command", kind: "execute", status: "in_progress", rawInput: { command: "ls" } });
      upd({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "ok" });
    }
    if (text.includes("[[hold]]")) {
      const deadline = Date.now() + 30_000;
      for (;;) { if (releaseFile && existsSync(releaseFile)) break; if (Date.now() > deadline) break; await sleep(20); }
    }
    if (summaryMode === "empty" && text.startsWith("[compaction-fallback]")) {
      // empty summary reply
    } else {
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " done" } });
    }
    out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usage() } });
  }
  function usage() {
    usageTotal += 100;
    return { inputTokens: usageTotal, outputTokens: 10, thoughtTokens: 5, cachedReadTokens: 40, totalTokens: usageTotal + 55 };
  }
}

const replayed = [];
const pendingPerm = new Map();
let cancelled = false;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  record(msg);
  if (pendingPerm.has(msg.id)) { pendingPerm.get(msg.id)(); pendingPerm.delete(msg.id); return; }
  if (msg.method === undefined) return;
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, sessionCapabilities: {} },
        authMethods: [] } });
      return;
    case "session/new":
      sessionId = `fake-acp-${++sessionCounter}-${homeLabel}`;
      out({ jsonrpc: "2.0", id: msg.id, result: { sessionId, configOptions, modes } });
      return;
    case "session/load": {
      if (typeof p.sessionId !== "string" || !p.sessionId.startsWith("fake-")) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `no such session ${p.sessionId}` } });
        return;
      }
      sessionId = p.sessionId;
      out({ jsonrpc: "2.0", id: msg.id, result: { configOptions, modes } });
      // Real agy answers session/load mid-replay: the stored history keeps
      // streaming as session/update notifications after the response.
      const replay = replayed.splice(0);
      setImmediate(() => { for (const u of replay) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } }); });
      return;
    }
    case "session/set_mode":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "session/set_config_option":
    case "session/set_model":
      out({ jsonrpc: "2.0", id: msg.id, result: { configOptions } });
      return;
    case "session/prompt": {
      const text = (p.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      cancelled = false;
      void runPrompt(msg.id, text);
      return;
    }
    case "session/cancel":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "authenticate":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    default:
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
  }
});
