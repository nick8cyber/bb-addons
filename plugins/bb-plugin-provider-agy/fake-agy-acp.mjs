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
 *                           | "unknown-model" | "unknown-model-once" | "tos-disabled" | "tos-once"
 *   AGY_FAKE_QUOTA_MSG      quota error text (must carry "Resets in …")
 *   AGY_FAKE_RELEASE        a [[hold]] prompt finishes when this file exists
 *   AGY_FAKE_COMPACT_MODE   "fail" makes a standalone "/compact" prompt error
 *   AGY_FAKE_SUMMARY_MODE   "empty"|"fail" — the summary prompt's outcome
 *
 * Prompt markers: [[quota]] (prompt errors with quota text), [[hold]],
 * [[artifact]] (tool_call_update with artifact-path refusal), [[askperm]]
 * (session/request_permission that hangs until answered), [[die]] (exit),
 * [[unknown-model]] (prompt errors "Unknown model ID"), [[tos]] (prompt
 * errors with the Terms-of-Service disable text).
 *
 * Per-account model catalogs (spec §2.3): control key or env
 * `modelsByLabel` / `AGY_FAKE_MODELS_BY_LABEL` maps a label to
 * [["id","displayName"],...] entries. `agy --gemini-dir <home>/.gemini
 * models` prints them as TSV, session/new|load advertises them as the
 * model config option, and — when a label has an explicit entry —
 * session/set_config_option|set_model for a value outside the catalog
 * fails "Unknown model ID" the way real agy does.
 */
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const argv = process.argv.slice(2);
const geminiDir = argv.includes("--gemini-dir") ? argv[argv.indexOf("--gemini-dir") + 1] : null;
// `agy models` (no --gemini-dir) is addressed through HOME — the account
// homes live under a directory named `accounts`, everything else is direct.
const homeLabel = geminiDir
  ? basename(dirname(geminiDir))
  : basename(dirname(process.env.HOME ?? "")) === "accounts"
    ? basename(process.env.HOME)
    : "direct";
const modesByLabel = JSON.parse(process.env.AGY_FAKE_MODE_BY_LABEL ?? "{}");
const modeEnv = modesByLabel[homeLabel] ?? process.env.AGY_FAKE_ERROR_MODE ?? "ok";
// Dynamic modes ride a control file (children keep their spawn env):
// {"modeByLabel": {"a2": "quota-always"}, "compactMode": "fail", "summaryMode": "empty",
//  "startFailByLabel": {"m1": "validation"|"tos"|"generic"}, "loadFailByLabel": {"m1": ...}}
const controlFile = process.env.AGY_FAKE_CONTROL ?? null;
function control() {
  if (controlFile === null) return {};
  try { return JSON.parse(readFileSync(controlFile, "utf8")); } catch { return {}; }
}
// Sequential per-label failures — {"startFailByLabel": {"a1": ["generic","tos"]}}
// consumes one entry per answered request. Consumption is written back to the
// control file because every launch is a fresh fake process.
function takeFail(kind, label) {
  if (controlFile === null) return null;
  const c = control();
  const spec = c[kind]?.[label];
  if (spec === undefined) return null;
  if (!Array.isArray(spec)) return spec;
  if (spec.length === 0) return null;
  const value = spec[0];
  try {
    writeFileSync(controlFile, JSON.stringify({ ...c, [kind]: { ...c[kind], [label]: spec.slice(1) } }));
  } catch {}
  return value;
}
const transcript = process.env.AGY_FAKE_TRANSCRIPT ?? null;
const recordEnv = (process.env.AGY_FAKE_RECORD_ENV ?? "").split(",").filter(Boolean);
const releaseFile = process.env.AGY_FAKE_RELEASE ?? null;
const compactModeEnv = process.env.AGY_FAKE_COMPACT_MODE ?? "ok";
const summaryModeEnv = process.env.AGY_FAKE_SUMMARY_MODE ?? "ok";
const quotaMsg =
  process.env.AGY_FAKE_QUOTA_MSG ??
  "Quota exhausted for this account; retry later. Resets in 0h0m4s.";
const ineligibleMsg = "This account is not eligible for Antigravity. Verify your account. https://accounts.google.com/v3/signin/continue?fake=acp";

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

// Per-account model catalogs (spec §2.3): a label with an explicit entry
// serves exactly those ids — `agy models` prints them and model-set calls
// outside the list are refused with "Unknown model ID". Without an entry
// the fake stays permissive: everything is accepted.
const defaultCatalog = [{ id: "fake-model", displayName: "Fake Model" }];
function modelsByLabelMap() {
  const byLabel = control().modelsByLabel ?? JSON.parse(process.env.AGY_FAKE_MODELS_BY_LABEL ?? "null");
  return typeof byLabel === "object" && byLabel !== null ? byLabel : null;
}
function catalogFor(label) {
  const byLabel = modelsByLabelMap();
  if (byLabel !== null && Array.isArray(byLabel[label])) {
    return byLabel[label].map((e) =>
      Array.isArray(e)
        ? { id: e[0], displayName: e[1] ?? e[0] }
        : { id: e.id, displayName: e.displayName ?? e.id });
  }
  const tsv = control().modelsOut ?? process.env.AGY_FAKE_MODELS_OUT;
  if (typeof tsv === "string" && tsv.length > 0) {
    return tsv.split("\n").filter((l) => l.includes("\t")).map((l) => {
      const [id, ...rest] = l.split("\t");
      return { id, displayName: rest.join("\t") || id };
    });
  }
  return defaultCatalog;
}
function modelRefused(label, value) {
  const byLabel = modelsByLabelMap();
  if (byLabel === null || !Array.isArray(byLabel[label])) return false;
  return !catalogFor(label).some((e) => e.id === value);
}

// `agy models`: the account's catalog as TSV, one "id\tdisplayName" line
// per entry. Like real agy, --gemini-dir is only valid on `agy acp` —
// `--gemini-dir … models` prints usage to stderr and exits 2.
if (argv.includes("models")) {
  if (geminiDir !== null) {
    process.stderr.write(
      "usage: agy [-p <prompt>]\n" +
        "       agy models\n" +
        "       agy acp [--gemini-dir <dir>]\n" +
        "agy: --gemini-dir is only valid with the acp subcommand\n",
    );
    process.exit(2);
  }
  record({ __models: true });
  const fail = control().modelsFailByLabel ?? {};
  if (fail[homeLabel] !== undefined) {
    process.stderr.write(`agy models: ${fail[homeLabel]}\n`);
    process.exit(3);
  }
  for (const entry of catalogFor(homeLabel)) {
    process.stdout.write(`${entry.id}\t${entry.displayName}\n`);
  }
  process.exit(0);
}

const configOptionsFor = () => [
  { id: "model", category: "model", type: "select",
    currentValue: catalogFor(homeLabel)[0]?.id ?? "fake-model",
    options: catalogFor(homeLabel).map((e) => ({ value: e.id, name: e.displayName })) },
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
  if (text.includes("[[unknown-model]]") || mode === "unknown-model" || (mode === "unknown-model-once" && once("um"))) {
    out({ jsonrpc: "2.0", id, error: { code: -32000, message: `Unknown model ID: "${catalogFor(homeLabel)[0]?.id ?? "fake-model"}"` } });
    return;
  }
  if (text.includes("[[tos]]") || mode === "tos-disabled" || (mode === "tos-once" && once("tos"))) {
    out({ jsonrpc: "2.0", id, error: { code: 403, message: "This service has been disabled in this account for violation of Terms of Service." } });
    return;
  }
  // §2.3 п.11: real agy reports 403 VALIDATION_REQUIRED as ordinary agent
  // text ("⚠ Verification Required") and still closes the turn cleanly —
  // the wrapper must swallow it, park the account and move the thread.
  if (text.includes("[[validation]]") || mode === "validation" || (mode === "validation-once" && once("val"))) {
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "⚠ Verification Required" } });
    out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usage() } });
    return;
  }
  // §2.3 п.13: real agy reports an exhausted quota window the same way —
  // one line of agent text with the reset countdown, turn closed cleanly.
  if (text.includes("[[quota-text]]") || mode === "quota-text" || (mode === "quota-text-once" && once("qt"))) {
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 127h43m16s.\n" } });
    out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usage() } });
    return;
  }
  // §2.3 п.11 (ревизия 13.1): the same refusal as a hard 403 — arrives as
  // a JSON-RPC error (session/prompt or session/new), not agent text.
  if (text.includes("[[validation-error]]") || mode === "validation-error" || (mode === "validation-error-once" && once("ve"))) {
    out({ jsonrpc: "2.0", id, error: { code: 403, message: "PERMISSION_DENIED: VALIDATION_REQUIRED — Verify your account to continue" } });
    return;
  }
  // §2.3 п.11 (ревизия 13.1): the marker as the turn's SECOND agent text
  // segment — ordinary prose, a tool call (which closes the first text
  // stream), then "⚠ Verification Required" on the same agent message.
  if (mode === "validation-second-segment") {
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working on it" } });
    upd({ sessionUpdate: "tool_call", toolCallId: "tc-vseg", title: "run_command", kind: "execute", status: "in_progress", rawInput: { command: "ls" } });
    upd({ sessionUpdate: "tool_call_update", toolCallId: "tc-vseg", status: "completed", rawOutput: "ok" });
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "⚠ Verification Required" } });
    out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usage() } });
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
// Lifecycle (spec §12.4): die with the owner — stdin EOF, a signal, or a
// reparented ppid (owner died, init/systemd adopted us) all end the fake.
const ownerPpid = process.ppid;
setInterval(() => {
  if (process.ppid !== ownerPpid) process.exit(0);
}, 1_500).unref();
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => process.exit(0));
}
const rlFake = createInterface({ input: process.stdin, crlfDelay: Infinity });
rlFake.on("close", () => process.exit(0));
rlFake.on("line", (line) => {
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
    case "session/new": {
      const startFail = takeFail("startFailByLabel", homeLabel);
      if (startFail === "validation") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: 403, message: "PERMISSION_DENIED: VALIDATION_REQUIRED — Verify your account to continue" } });
        return;
      }
      if (startFail === "tos") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: 403, message: "This service has been disabled in this account for violation of Terms of Service." } });
        return;
      }
      if (startFail) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `injected session/new failure (${startFail})` } });
        return;
      }
      if ((control().modeByLabel?.[homeLabel] ?? control().errorMode ?? modeEnv) === "validation-error") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: 403, message: "PERMISSION_DENIED: VALIDATION_REQUIRED — Verify your account to continue" } });
        return;
      }
      sessionId = `fake-acp-${++sessionCounter}-${homeLabel}`;
      out({ jsonrpc: "2.0", id: msg.id, result: { sessionId, configOptions: configOptionsFor(), modes } });
      return;
    }
    case "session/load": {
      const loadFail = takeFail("loadFailByLabel", homeLabel);
      if (loadFail === "validation") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: 403, message: "PERMISSION_DENIED: VALIDATION_REQUIRED — Verify your account to continue" } });
        return;
      }
      if (loadFail === "tos") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: 403, message: "This service has been disabled in this account for violation of Terms of Service." } });
        return;
      }
      if (loadFail) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `injected session/load failure (${loadFail})` } });
        return;
      }
      if (typeof p.sessionId !== "string" || !p.sessionId.startsWith("fake-")) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `no such session ${p.sessionId}` } });
        return;
      }
      sessionId = p.sessionId;
      out({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptionsFor(), modes } });
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
    case "session/set_model": {
      const configId = msg.method === "session/set_config_option" ? p.configId : "model";
      const value =
        msg.method === "session/set_config_option"
          ? p.value
          : (p.modelId ?? p.model ?? p.value);
      if (configId === "model" && typeof value === "string" && modelRefused(homeLabel, value)) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Unknown model ID: "${value}"` } });
        return;
      }
      out({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptionsFor() } });
      return;
    }
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
