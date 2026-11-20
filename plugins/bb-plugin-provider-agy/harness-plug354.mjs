/**
 * Test harness for PLUG-354 (Revision 19):
 * Suppression of agy service line "⚠ The stream was interrupted. Please continue the task you were working on."
 *
 * Verifies all requirements of docs/specs/provider-agy-acp.md §2.3 п. 15 and §11 п. 8.
 *
 * Usage: node harness-plug354.mjs
 */
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTeardown, trackedMkdtemp } from "./harness-teardown.mjs";

installTeardown();

const {
  AGENT_INTERRUPTED_MESSAGE_PATTERN,
  isAgentInterruptedMessage,
  AGENT_INTERRUPTED_PREFIX_PATTERN,
  isAgentMarkerCandidate,
} = await import(new URL("./src/accounts.ts", import.meta.url).href);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push([name, Boolean(ok), detail]);
  const status = ok ? "pass" : "FAIL";
  process.stderr.write(`${status} ${name} ${detail}\n`);
};

// ============================================================================
// PART 1: Unit tests for patterns and candidate detector
// ============================================================================
{
  // 1. Full message pattern & isAgentInterruptedMessage
  check("unit/pattern-compiled", AGENT_INTERRUPTED_MESSAGE_PATTERN instanceof RegExp);
  const rawMsg = "⚠ The stream was interrupted. Please continue the task you were working on.";
  check("unit/matches-canonical", isAgentInterruptedMessage(rawMsg));
  check("unit/matches-with-leading-trailing-newlines", isAgentInterruptedMessage(`\n${rawMsg}\n`));
  check("unit/matches-with-fe0f", isAgentInterruptedMessage("⚠️ The stream was interrupted. Please continue the task you were working on."));
  check("unit/matches-without-trailing-dot", isAgentInterruptedMessage("⚠ The stream was interrupted. Please continue the task you were working on"));
  check("unit/matches-with-extra-whitespace", isAgentInterruptedMessage("   ⚠   The stream was interrupted.   Please continue the task you were working on.   "));
  
  // Negative checks: must NOT match plain text without ⚠
  check("unit/rejects-no-symbol", !isAgentInterruptedMessage("The stream was interrupted. Please continue the task you were working on."));
  check("unit/rejects-partial", !isAgentInterruptedMessage("⚠ The stream was interrupted."));
  check("unit/rejects-multiline-prose", !isAgentInterruptedMessage(`${rawMsg}\nHere is model response`));
  check("unit/rejects-random-text", !isAgentInterruptedMessage("⚠ Note: something happened"));

  // 2. Prefix pattern character-by-character
  check("unit/prefix-compiled", AGENT_INTERRUPTED_PREFIX_PATTERN instanceof RegExp);
  check("unit/prefix-symbol-only", AGENT_INTERRUPTED_PREFIX_PATTERN.test("⚠ "));
  check("unit/prefix-symbol-fe0f", AGENT_INTERRUPTED_PREFIX_PATTERN.test("⚠️ "));
  check("unit/prefix-symbol-t", AGENT_INTERRUPTED_PREFIX_PATTERN.test("⚠ T"));
  check("unit/prefix-symbol-the", AGENT_INTERRUPTED_PREFIX_PATTERN.test("⚠ The "));
  check("unit/prefix-mid-sentence", AGENT_INTERRUPTED_PREFIX_PATTERN.test("⚠ The stream was interrupted. Please cont"));
  check("unit/prefix-near-end", AGENT_INTERRUPTED_PREFIX_PATTERN.test("⚠ The stream was interrupted. Please continue the task you were working on."));
  check("unit/prefix-rejects-divergence", !AGENT_INTERRUPTED_PREFIX_PATTERN.test("⚠ The stream was closed"));
  check("unit/prefix-rejects-other-marker", !AGENT_INTERRUPTED_PREFIX_PATTERN.test("⚠ Individual quota"));

  // Verify all progressive prefixes match
  const fullText = "⚠ The stream was interrupted. Please continue the task you were working on.";
  let allPrefixesMatch = true;
  for (let i = 2; i <= fullText.length; i++) {
    const sub = fullText.slice(0, i);
    if (!AGENT_INTERRUPTED_PREFIX_PATTERN.test(sub)) {
      allPrefixesMatch = false;
      check(`unit/prefix-at-char-${i}`, false, `failed on: "${sub}"`);
      break;
    }
  }
  if (allPrefixesMatch) {
    check("unit/all-79-prefixes-match", true);
  }

  // 3. isAgentMarkerCandidate
  check("unit/candidate-empty", isAgentMarkerCandidate("") === true);
  check("unit/candidate-whitespace-newlines", isAgentMarkerCandidate("\n  \n") === true);
  check("unit/candidate-prefix", isAgentMarkerCandidate("⚠ The stream was inter") === true);
  check("unit/candidate-full", isAgentMarkerCandidate(rawMsg) === true);
  check("unit/candidate-divergence", isAgentMarkerCandidate("⚠ Note: here is normal answer") === false);
  check("unit/candidate-multiline-divergence", isAgentMarkerCandidate("⚠ The stream was\nnot broken") === false);
}

// ============================================================================
// PART 2: Integration tests driving ACP bridge
// ============================================================================
const root = trackedMkdtemp(join(tmpdir(), "agy-plug354-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });
const shim = join(root, "agy-bin");
const fake = new URL("./fake-agy-acp.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_CLIPROXY = "0";
process.env.AGY_FAKE_TRANSCRIPT = join(root, "transcript.ndjson");
process.env.AGY_FAKE_CONTROL = join(root, "control.json");
writeFileSync(process.env.AGY_FAKE_CONTROL, "{}\n");

// Create pool accounts a1..a2
for (const label of ["a1", "a2"]) {
  const cli = join(root, "accounts", label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}

const ledger = () => {
  let shared = { accounts: {}, conversations: {} };
  try {
    shared = JSON.parse(readFileSync(join(root, "accounts-state.json"), "utf8"));
  } catch {}
  return shared;
};

const writeShared = (l) => {
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(l));
  try { unlinkSync(join(root, "accounts-overlay.json")); } catch {}
  try { unlinkSync(join(root, "conversations-state.json")); } catch {}
};

const resetAcpPool = () => {
  const l = ledger();
  for (const a of ["a1", "a2"]) {
    l.accounts[a] = { cooldownUntilMs: 0, lastUsedMs: a === "a1" ? 0 : 1_700_000_000_000, lastError: null };
    delete l.accounts[a].parkedReason;
    delete l.accounts[a].ineligibleAtMs;
  }
  writeShared(l);
};

const bridgeLog = () =>
  existsSync(join(root, "acp-wrapper.log"))
    ? readFileSync(join(root, "acp-wrapper.log"), "utf8")
    : "";

const messages = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

let tail = "";
process.stdout.write = (chunk) => {
  tail += typeof chunk === "string" ? chunk : chunk.toString();
  for (;;) {
    const nl = tail.indexOf("\n");
    if (nl === -1) break;
    const line = tail.slice(0, nl);
    tail = tail.slice(nl + 1);
    if (line.trim().length === 0) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      messages.push({ __nonJson: line });
    }
  }
  return true;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { experimental_providerBridge: bridge } = await import(new URL("./dist/host.js", import.meta.url).href);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));

const options = {
  model: "fake-model",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
let creqN = 0;
const creq = () => {
  let n = ++creqN;
  let s = "";
  for (let i = 0; i < 10; i++) {
    s += ALPHABET[n % ALPHABET.length];
    n = Math.floor(n / ALPHABET.length) + (i + 1);
  }
  return `creq_${s}`;
};

const replies = (id) => messages.filter((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
const deltasFor = (threadId) =>
  messages
    .filter((m) => m.method === "thread/delta" && m.params?.threadId === threadId)
    .flatMap((m) => m.params.deltas ?? []);

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      originalStderrWrite(`\n!!! timeout: ${label}\n`);
      for (const m of messages.slice(-30)) {
        originalStderrWrite(JSON.stringify(m).slice(0, 300) + "\n");
      }
      process.exit(2);
    }
    await sleep(40);
  }
}

const start = (id, tid, customOpts = options) =>
  send({ jsonrpc: "2.0", id, method: "thread/start", params: { threadId: tid, cwd: workspace, options: customOpts, instructionMode: "append" } });

// Initialize bridge
send({
  jsonrpc: "2.0",
  id: "init",
  method: "initialize",
  params: { protocolVersion: 2, grammarVersions: [3, 3], client: { name: "plug354-harness", version: "1" } },
});
await waitFor(() => replies("init").length === 1, 10000, "initialize");
check("integration/init-ok", replies("init")[0]?.result !== undefined);

// ----------------------------------------------------------------------------
// Test 1: [[interrupted-chunked-tool]]
// Service string arrives chunked with \n, tool execution follows, continued=yes.
// ----------------------------------------------------------------------------
resetAcpPool();
const T1 = "t1_chunked_tool";
start(101, T1);
await waitFor(() => replies(101).length === 1, 20000, "t1-start");
const ptid1 = replies(101)[0]?.result?.providerThreadId;

send({
  jsonrpc: "2.0",
  id: 102,
  method: "turn/start",
  params: { threadId: T1, providerThreadId: ptid1, clientRequestId: creq(), input: [{ type: "text", text: "Please do work [[interrupted-chunked-tool]]" }], options },
});

await waitFor(() => deltasFor(T1).some((d) => d.kind === "turn.boundary"), 20000, "t1 turn boundary");

{
  const deltas = deltasFor(T1);
  const textDeltas = deltas.filter((d) => d.kind === "item.textDelta" && d.channel === "agentMessage").map((d) => d.text);
  const allText = textDeltas.join("");
  check("t1/interrupted-string-not-in-deltas", !allText.includes("stream was interrupted"), `got: "${allText}"`);
  const hasToolCall = deltas.some((d) => d.kind === "toolCall" || (d.kind === "item.open" && (d.item?.type === "command" || d.item?.type === "toolCall")));
  check("t1/tool-call-executed", hasToolCall);
  check("t1/tool-result-followed", allText.includes("All done after tool."));
  const boundary = deltas.find((d) => d.kind === "turn.boundary");
  check("t1/boundary-completed", boundary?.status === "completed");
  const logFound = bridgeLog().includes(`suppress interrupted stream: thread=${T1} continued=yes`);
  check("t1/audit-log-continued-yes", logFound, `log: ${bridgeLog()}`);
}

// ----------------------------------------------------------------------------
// Test 2: [[interrupted-same-segment-prose]]
// Service string followed by reasoning and normal prose in same segment, continued=yes.
// ----------------------------------------------------------------------------
const T2 = "t2_same_segment_prose";
start(201, T2);
await waitFor(() => replies(201).length === 1, 20000, "t2-start");
const ptid2 = replies(201)[0]?.result?.providerThreadId;

send({
  jsonrpc: "2.0",
  id: 202,
  method: "turn/start",
  params: { threadId: T2, providerThreadId: ptid2, clientRequestId: creq(), input: [{ type: "text", text: "Run [[interrupted-same-segment-prose]]" }], options },
});

await waitFor(() => deltasFor(T2).some((d) => d.kind === "turn.boundary"), 20000, "t2 turn boundary");

{
  const deltas = deltasFor(T2);
  const textDeltas = deltas.filter((d) => d.kind === "item.textDelta" && d.channel === "agentMessage").map((d) => d.text);
  const allText = textDeltas.join("");
  check("t2/interrupted-string-not-in-deltas", !allText.includes("stream was interrupted"), `got: "${allText}"`);
  check("t2/continuation-prose-delivered", allText.includes("Continuing with task execution now."));
  const boundary = deltas.find((d) => d.kind === "turn.boundary");
  check("t2/boundary-completed", boundary?.status === "completed");
  const logFound = bridgeLog().includes(`suppress interrupted stream: thread=${T2} continued=yes`);
  check("t2/audit-log-continued-yes", logFound);
}

// ----------------------------------------------------------------------------
// Test 3: [[interrupted-glued-chunk]]
// Candidate buffered, completed in glued chunk with continuation prose on next line.
// ----------------------------------------------------------------------------
const T3 = "t3_glued_chunk";
start(301, T3);
await waitFor(() => replies(301).length === 1, 20000, "t3-start");
const ptid3 = replies(301)[0]?.result?.providerThreadId;

send({
  jsonrpc: "2.0",
  id: 302,
  method: "turn/start",
  params: { threadId: T3, providerThreadId: ptid3, clientRequestId: creq(), input: [{ type: "text", text: "Run [[interrupted-glued-chunk]]" }], options },
});

await waitFor(() => deltasFor(T3).some((d) => d.kind === "turn.boundary"), 20000, "t3 turn boundary");

{
  const deltas = deltasFor(T3);
  const textDeltas = deltas.filter((d) => d.kind === "item.textDelta" && d.channel === "agentMessage").map((d) => d.text);
  const allText = textDeltas.join("");
  check("t3/interrupted-string-not-in-deltas", !allText.includes("stream was interrupted"), `got: "${allText}"`);
  check("t3/glued-tail-delivered", allText.includes("And here is the actual response glued directly."));
  const logFound = bridgeLog().includes(`suppress interrupted stream: thread=${T3} continued=yes`);
  check("t3/audit-log-continued-yes", logFound);
}

// ----------------------------------------------------------------------------
// Test 4: [[interrupted-steer-buffered]]
// Full string held in candidate buffer; steer arrives -> buffer dropped without leaking.
// ----------------------------------------------------------------------------
const T4 = "t4_steer_buffered";
start(401, T4);
await waitFor(() => replies(401).length === 1, 20000, "t4-start");
const ptid4 = replies(401)[0]?.result?.providerThreadId;

send({
  jsonrpc: "2.0",
  id: 402,
  method: "turn/start",
  params: { threadId: T4, providerThreadId: ptid4, clientRequestId: creq(), input: [{ type: "text", text: "Hold [[interrupted-steer-buffered]]" }], options },
});

// Wait for prompt to reach fake agy and buffer the message
await sleep(150);

// Now send steer
send({
  jsonrpc: "2.0",
  id: 403,
  method: "turn/steer",
  params: {
    threadId: T4,
    providerThreadId: ptid4,
    clientRequestId: creq(),
    expectedTurnId: "any",
    input: [{ type: "text", text: "STEER-ANSWER: now do this instead" }],
    options,
  },
});

await waitFor(() => deltasFor(T4).some((d) => d.kind === "turn.boundary"), 20000, "t4 turn boundary");

{
  const deltas = deltasFor(T4);
  const textDeltas = deltas.filter((d) => d.kind === "item.textDelta" && d.channel === "agentMessage").map((d) => d.text);
  const allText = textDeltas.join("");
  check("t4/interrupted-string-not-leaked-on-steer", !allText.includes("stream was interrupted"), `got: "${allText}"`);
  const logFound = bridgeLog().includes(`suppress interrupted stream: thread=${T4} continued=aborted`);
  check("t4/audit-log-continued-aborted", logFound);
}

// ----------------------------------------------------------------------------
// Test 5: [[interrupted-no-continuation]]
// Turn ends immediately after service message without continuation -> continued=no.
// ----------------------------------------------------------------------------
const T5 = "t5_no_continuation";
start(501, T5);
await waitFor(() => replies(501).length === 1, 20000, "t5-start");
const ptid5 = replies(501)[0]?.result?.providerThreadId;

send({
  jsonrpc: "2.0",
  id: 502,
  method: "turn/start",
  params: { threadId: T5, providerThreadId: ptid5, clientRequestId: creq(), input: [{ type: "text", text: "End [[interrupted-no-continuation]]" }], options },
});

await waitFor(() => deltasFor(T5).some((d) => d.kind === "turn.boundary"), 20000, "t5 turn boundary");

{
  const deltas = deltasFor(T5);
  const textDeltas = deltas.filter((d) => d.kind === "item.textDelta" && d.channel === "agentMessage").map((d) => d.text);
  const allText = textDeltas.join("");
  check("t5/interrupted-string-not-in-deltas", !allText.includes("stream was interrupted"), `got: "${allText}"`);
  const boundary = deltas.find((d) => d.kind === "turn.boundary");
  check("t5/boundary-completed", boundary?.status === "completed");
  const logFound = bridgeLog().includes(`suppress interrupted stream: thread=${T5} continued=no`);
  check("t5/audit-log-continued-no", logFound);
}

// ----------------------------------------------------------------------------
// Test 6: [[interrupted-prose-visible]]
// Ordinary prose mentioning the words (e.g. quote / analysis) must NOT be suppressed.
// ----------------------------------------------------------------------------
const T6 = "t6_prose_visible";
start(601, T6);
await waitFor(() => replies(601).length === 1, 20000, "t6-start");
const ptid6 = replies(601)[0]?.result?.providerThreadId;

send({
  jsonrpc: "2.0",
  id: 602,
  method: "turn/start",
  params: { threadId: T6, providerThreadId: ptid6, clientRequestId: creq(), input: [{ type: "text", text: "Explain [[interrupted-prose-visible]]" }], options },
});

await waitFor(() => deltasFor(T6).some((d) => d.kind === "turn.boundary"), 20000, "t6 turn boundary");

{
  const deltas = deltasFor(T6);
  const textDeltas = deltas.filter((d) => d.kind === "item.textDelta" && d.channel === "agentMessage").map((d) => d.text);
  const allText = textDeltas.join("");
  check("t6/ordinary-prose-delivered", allText.includes("Analysis:\n⚠ The stream was interrupted."), `got: "${allText}"`);
  check("t6/quote-tail-delivered", allText.includes("This was a quote from the log."));
}

// ----------------------------------------------------------------------------
// Test 7: [[interrupted-preserve-prior-text]]
// Prior text before interruption in same segment is preserved and closed cleanly.
// ----------------------------------------------------------------------------
const T7 = "t7_prior_text";
start(701, T7);
await waitFor(() => replies(701).length === 1, 20000, "t7-start");
const ptid7 = replies(701)[0]?.result?.providerThreadId;

send({
  jsonrpc: "2.0",
  id: 702,
  method: "turn/start",
  params: { threadId: T7, providerThreadId: ptid7, clientRequestId: creq(), input: [{ type: "text", text: "Run [[interrupted-preserve-prior-text]]" }], options },
});

await waitFor(() => deltasFor(T7).some((d) => d.kind === "turn.boundary"), 20000, "t7 turn boundary");

{
  const deltas = deltasFor(T7);
  const textDeltas = deltas.filter((d) => d.kind === "item.textDelta" && d.channel === "agentMessage").map((d) => d.text);
  const allText = textDeltas.join("");
  check("t7/prior-text-preserved", allText.includes("Prior text before steer."), `got: "${allText}"`);
  check("t7/interrupted-string-not-in-deltas", !allText.includes("stream was interrupted"), `got: "${allText}"`);
  check("t7/has-text-close", deltas.some((d) => d.kind === "item.textClose" && d.channel === "agentMessage"));
}

// ----------------------------------------------------------------------------
// Test 8: Pool state and accounts ledger unaffected
// ----------------------------------------------------------------------------
{
  const currentLedger = ledger();
  const a1 = currentLedger.accounts?.a1;
  const a2 = currentLedger.accounts?.a2;
  check("ledger/a1-no-cooldown", a1?.cooldownUntilMs === 0, `cooldown: ${a1?.cooldownUntilMs}`);
  check("ledger/a1-not-parked", a1?.parkedReason === undefined);
  check("ledger/a2-no-cooldown", a2?.cooldownUntilMs === 0);
  check("ledger/a2-not-parked", a2?.parkedReason === undefined);
}

// Clean shutdown
bridge.onClose?.();
process.stdout.write = originalWrite;
process.stderr.write = originalStderrWrite;

const failed = checks.filter((c) => !c[1]);
originalStderrWrite(`\n==== PLUG-354 HARNESS SUMMARY: ${checks.length - failed.length}/${checks.length} passed ====\n`);
if (failed.length > 0) {
  originalStderrWrite(`FAILED CHECKS:\n${failed.map((c) => ` - ${c[0]}: ${c[2]}`).join("\n")}\n`);
  process.exit(1);
}
process.exit(0);
