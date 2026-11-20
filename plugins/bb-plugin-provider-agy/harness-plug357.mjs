/**
 * Regression harness for PLUG-357: fixes 5 blockers from Codex review.
 * 
 * Blocker 1: Compaction fallback refusal handling during summary (429 / quota text).
 * Blocker 2: Prefix buffering, held textClose, marker confirmation on turn.boundary.
 * Blocker 3: Direct mode 429 rate limit clamping (30m max) & immediate rejection of queued/incoming turns.
 * Blocker 4: SSH_CONNECTION filtering (pool drops user SSH_CONNECTION, direct preserves, AGY_KEYRING=1 preserves).
 * Blocker 5: listAgyModels install.env does not override pool file token marker.
 *
 * Usage: node harness-plug357.mjs
 */
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTeardown, trackedMkdtemp } from "./harness-teardown.mjs";

installTeardown();

const {
  AGENT_QUOTA_PREFIX_PATTERN,
  AGENT_VALIDATION_PREFIX_PATTERN,
  isAgentMarkerCandidate,
} = await import(new URL("./src/accounts.ts", import.meta.url).href);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push([name, Boolean(ok), detail]);
  const status = ok ? "pass" : "FAIL";
  process.stderr.write(`${status} ${name} ${detail}\n`);
};

// ============================================================================
// PART 1: Unit tests for regex & marker candidate patterns
// ============================================================================
{
  // Quota regex
  check("regex/quota-prefix-compiled", AGENT_QUOTA_PREFIX_PATTERN instanceof RegExp);
  check("regex/quota-prefix-matches-start", AGENT_QUOTA_PREFIX_PATTERN.test("⚠ "));
  check("regex/quota-prefix-matches-partial", AGENT_QUOTA_PREFIX_PATTERN.test("⚠ Individual qu"));
  check("regex/quota-prefix-matches-full", AGENT_QUOTA_PREFIX_PATTERN.test("⚠ Individual quota reached"));
  check("regex/quota-prefix-diverges-note", !AGENT_QUOTA_PREFIX_PATTERN.test("⚠ Note:"));

  // Validation regex
  check("regex/val-prefix-compiled", AGENT_VALIDATION_PREFIX_PATTERN instanceof RegExp);
  check("regex/val-prefix-matches-start", AGENT_VALIDATION_PREFIX_PATTERN.test("⚠ "));
  check("regex/val-prefix-matches-partial", AGENT_VALIDATION_PREFIX_PATTERN.test("⚠ Verification Re"));
  check("regex/val-prefix-matches-full", AGENT_VALIDATION_PREFIX_PATTERN.test("⚠ Verification Required"));
  check("regex/val-prefix-diverges-note", !AGENT_VALIDATION_PREFIX_PATTERN.test("⚠ Note:"));

  // isAgentMarkerCandidate
  check("candidate/empty-or-ws", isAgentMarkerCandidate("  \n  ") === true);
  check("candidate/quota-prefix", isAgentMarkerCandidate("⚠ Individ") === true);
  check("candidate/quota-full", isAgentMarkerCandidate("⚠ Individual quota reached. Resets in 12h.") === true);
  check("candidate/val-prefix", isAgentMarkerCandidate("⚠ Verif") === true);
  check("candidate/val-full", isAgentMarkerCandidate("⚠ Verification Required") === true);
  check("candidate/diverged", isAgentMarkerCandidate("⚠ Note: hello") === false);
  check("candidate/multiline-diverged", isAgentMarkerCandidate("⚠ Individual quota\nhello") === false);
}

// ============================================================================
// PART 2: Integration tests driving ACP bridge
// ============================================================================
const root = trackedMkdtemp(join(tmpdir(), "agy-plug357-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });
const shim = join(root, "agy-bin");
const fake = new URL("./fake-agy-acp.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_CLIPROXY = "0";
process.env.AGY_FAKE_TRANSCRIPT = join(root, "transcript.ndjson");
process.env.AGY_FAKE_RECORD_ENV = "HOME,HTTPS_PROXY,SSH_CONNECTION";
process.env.AGY_FAKE_QUOTA_MSG = "Quota exhausted; retry later. Resets in 127h43m16s.";
process.env.AGY_FAKE_CONTROL = join(root, "control.json");
writeFileSync(process.env.AGY_FAKE_CONTROL, "{}\n");
const setControl = (obj) => {
  const c = JSON.parse(readFileSync(process.env.AGY_FAKE_CONTROL, "utf8"));
  Object.assign(c, obj);
  writeFileSync(process.env.AGY_FAKE_CONTROL, JSON.stringify(c));
};

// Create pool accounts a1..a3
for (const label of ["a1", "a2", "a3"]) {
  const cli = join(root, "accounts", label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}

const transcriptLines = () =>
  existsSync(join(root, "transcript.ndjson"))
    ? readFileSync(join(root, "transcript.ndjson"), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return {};
          }
        })
    : [];
const prompts = (home) => transcriptLines().filter((l) => l.method === "session/prompt" && l.home === home);
const ptxt = (p) => (p?.params?.prompt ?? []).map((b) => b.text ?? "").join("\n");
const ledger = () => {
  let shared = { accounts: {}, conversations: {} };
  try {
    shared = JSON.parse(readFileSync(join(root, "accounts-state.json"), "utf8"));
  } catch {}
  let local = {};
  try {
    local = JSON.parse(readFileSync(join(root, "conversations-state.json"), "utf8")).conversations ?? {};
  } catch {}
  return { ...shared, accounts: shared.accounts ?? {}, conversations: { ...(shared.conversations ?? {}), ...local } };
};
const writeShared = (l) => {
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(l));
  try { unlinkSync(join(root, "accounts-overlay.json")); } catch {}
  try { unlinkSync(join(root, "conversations-state.json")); } catch {}
};
const resetAcpPool = () => {
  const l = ledger();
  for (const a of ["a1", "a2", "a3"]) {
    l.accounts[a] = { cooldownUntilMs: 0, lastUsedMs: a === "a1" ? 0 : 1_700_000_000_000, lastError: null };
    delete l.accounts[a].parkedReason;
    delete l.accounts[a].ineligibleAtMs;
  }
  writeShared(l);
};

const messages = [];
const originalWrite = process.stdout.write.bind(process.stdout);
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
let creqN = 0;
const creq = () => `creq_${"aaaaaaaaaa".slice(0, 9)}${"abcdefghjkmnpqrstuvwxyz"[creqN++ % 24]}`;
const deltas = (tid) => messages.filter((m) => m.method === "thread/delta" && m.params.threadId === tid).flatMap((m) => m.params.deltas);
const boundaries = (tid) => deltas(tid).filter((d) => d.kind === "turn.boundary");
const perrors = (tid) => deltas(tid).filter((d) => d.kind === "provider.error");
const rateLimits = (tid) => deltas(tid).filter((d) => d.kind === "provider.rateLimits");
const replies = (id) => messages.filter((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) {
      process.stderr.write(`!!! timeout: ${label}\n`);
      for (const m of messages.slice(-30)) process.stderr.write(JSON.stringify(m).slice(0, 300) + "\n");
      process.exit(2);
    }
    await sleep(40);
  }
}
const start = (id, tid, customOpts = options) =>
  send({ jsonrpc: "2.0", id, method: "thread/start", params: { threadId: tid, cwd: workspace, options: customOpts, instructionMode: "append" } });

// ----------------------------------------------------------------------------
// BLOCKER 1: Compaction fallback refusal handling during summary
// ----------------------------------------------------------------------------
// Test 1a: summaryMode: "quota" (HTTP 429 during summary)
{
  resetAcpPool();
  start(100, "t-b1-quota");
  await waitFor(() => replies(100).length === 1, 20000, "t-b1-quota start");
  const ptid = replies(100)[0].result.providerThreadId;

  // Initial turn so session has context to compact
  send({
    jsonrpc: "2.0",
    id: 99,
    method: "turn/start",
    params: {
      threadId: "t-b1-quota",
      providerThreadId: ptid,
      clientRequestId: creq(),
      options,
      input: [{ type: "text", text: "initial turn text", mentions: [] }],
    },
  });
  await waitFor(() => boundaries("t-b1-quota").length >= 1, 20000, "t-b1-quota initial turn");

  // Run /compact with fallback summary failing with quota 429
  setControl({ compactMode: "fail", summaryMode: "quota" });
  const compactMention = {
    start: 0,
    end: 8,
    resource: { kind: "command", trigger: "/", name: "compact", source: "command", origin: "builtin", label: "/compact", argumentHint: null },
  };
  send({
    jsonrpc: "2.0",
    id: 101,
    method: "turn/start",
    params: {
      threadId: "t-b1-quota",
      providerThreadId: ptid,
      clientRequestId: creq(),
      options,
      input: [{ type: "text", text: "/compact", mentions: [compactMention] }],
    },
  });

  await waitFor(() => boundaries("t-b1-quota").length >= 3, 30000, "t-b1-quota compact finished");
  const l = ledger();
  const a1Cooled = (l.accounts.a1?.cooldownUntilMs ?? 0) > Date.now();
  const transcript = transcriptLines();
  const phantomTurns = transcript.filter((t) => ptxt(t).includes("[quota-rotation-handoff]"));

  check("blocker1/summary-quota-429-cools-owner", a1Cooled, `cooldownUntilMs=${l.accounts.a1?.cooldownUntilMs}`);
  check("blocker1/summary-quota-429-no-phantom-turn", phantomTurns.length === 0, `phantomTurns=${phantomTurns.length}`);
  check("blocker1/summary-quota-429-compact-completed", boundaries("t-b1-quota").at(-1)?.status === "completed");
  setControl({ compactMode: "ok", summaryMode: "ok" });
}

// Test 1b: summaryMode: "quota-text" (refusal marker in text during summary)
{
  resetAcpPool();
  start(110, "t-b1-quotatext");
  await waitFor(() => replies(110).length === 1, 20000, "t-b1-quotatext start");
  const ptid = replies(110)[0].result.providerThreadId;

  // Initial turn so session has context to compact
  send({
    jsonrpc: "2.0",
    id: 109,
    method: "turn/start",
    params: {
      threadId: "t-b1-quotatext",
      providerThreadId: ptid,
      clientRequestId: creq(),
      options,
      input: [{ type: "text", text: "initial turn text", mentions: [] }],
    },
  });
  await waitFor(() => boundaries("t-b1-quotatext").length >= 1, 20000, "t-b1-quotatext initial turn");

  setControl({ compactMode: "fail", summaryMode: "quota-text" });
  const compactMention = {
    start: 0,
    end: 8,
    resource: { kind: "command", trigger: "/", name: "compact", source: "command", origin: "builtin", label: "/compact", argumentHint: null },
  };
  send({
    jsonrpc: "2.0",
    id: 111,
    method: "turn/start",
    params: {
      threadId: "t-b1-quotatext",
      providerThreadId: ptid,
      clientRequestId: creq(),
      options,
      input: [{ type: "text", text: "/compact", mentions: [compactMention] }],
    },
  });

  await waitFor(() => boundaries("t-b1-quotatext").length >= 3, 30000, "t-b1-quotatext compact finished");
  const l = ledger();
  const a1Cooled = (l.accounts.a1?.cooldownUntilMs ?? 0) > Date.now();
  const transcript = transcriptLines();
  const phantomTurns = transcript.filter((t) => ptxt(t).includes("[quota-rotation-handoff]"));

  check("blocker1/summary-quota-text-cools-owner", a1Cooled, `cooldownUntilMs=${l.accounts.a1?.cooldownUntilMs}`);
  check("blocker1/summary-quota-text-no-phantom-turn", phantomTurns.length === 0, `phantomTurns=${phantomTurns.length}`);
  check("blocker1/summary-quota-text-compact-completed", boundaries("t-b1-quotatext").at(-1)?.status === "completed");
  setControl({ compactMode: "ok", summaryMode: "ok" });
}

// ----------------------------------------------------------------------------
// BLOCKER 2: Prefix buffering & heldTextClose
// ----------------------------------------------------------------------------
// Test 2a: [[quota-chunked]] - candidate prefix never leaks to client deltas
{
  resetAcpPool();
  start(200, "t-b2-quota");
  await waitFor(() => replies(200).length === 1, 20000, "t-b2-quota start");
  const ptid = replies(200)[0].result.providerThreadId;

  send({
    jsonrpc: "2.0",
    id: 201,
    method: "turn/start",
    params: {
      threadId: "t-b2-quota",
      providerThreadId: ptid,
      clientRequestId: creq(),
      options,
      input: [{ type: "text", text: "[[quota-chunked]]", mentions: [] }],
    },
  });

  // Wait for retry completion on sibling a2
  await waitFor(() => boundaries("t-b2-quota").length >= 1, 30000, "t-b2-quota completed");
  const dList = deltas("t-b2-quota");
  const leakedQuotaText = dList.some(
    (d) =>
      d.kind === "text" ||
      (d.kind === "item.textDelta" && typeof d.text === "string" && (d.text.includes("Individual quota reached") || d.text.trim() === "⚠"))
  );
  check("blocker2/quota-chunked-no-leak", !leakedQuotaText, `deltas=${JSON.stringify(dList.map((d) => d.kind))}`);
  check("blocker2/quota-chunked-rotated", ledger().accounts.a1?.cooldownUntilMs > Date.now());
}

// Test 2b: [[validation-chunked]] - marker never leaks, account parked
{
  resetAcpPool();
  start(210, "t-b2-val");
  await waitFor(() => replies(210).length === 1, 20000, "t-b2-val start");
  const ptid = replies(210)[0].result.providerThreadId;

  send({
    jsonrpc: "2.0",
    id: 211,
    method: "turn/start",
    params: {
      threadId: "t-b2-val",
      providerThreadId: ptid,
      clientRequestId: creq(),
      options,
      input: [{ type: "text", text: "[[validation-chunked]]", mentions: [] }],
    },
  });

  await waitFor(() => boundaries("t-b2-val").length >= 1, 30000, "t-b2-val completed");
  const dList = deltas("t-b2-val");
  const leakedValText = dList.some(
    (d) =>
      d.kind === "text" ||
      (d.kind === "item.textDelta" && typeof d.text === "string" && (d.text.includes("Verification Required") || d.text.trim() === "⚠"))
  );
  check("blocker2/val-chunked-no-leak", !leakedValText);
  check("blocker2/val-chunked-parked", ledger().accounts.a1?.parkedReason === "validation-required");
}

// Test 2c: [[divergence-chunked]] - candidate prefix followed by normal text IS delivered
{
  resetAcpPool();
  start(220, "t-b2-div");
  await waitFor(() => replies(220).length === 1, 20000, "t-b2-div start");
  const ptid = replies(220)[0].result.providerThreadId;

  send({
    jsonrpc: "2.0",
    id: 221,
    method: "turn/start",
    params: {
      threadId: "t-b2-div",
      providerThreadId: ptid,
      clientRequestId: creq(),
      options,
      input: [{ type: "text", text: "[[divergence-chunked]]", mentions: [] }],
    },
  });

  await waitFor(() => boundaries("t-b2-div").length >= 1, 30000, "t-b2-div completed");
  const textDeltas = deltas("t-b2-div").filter((d) => d.kind === "item.textDelta").map((d) => d.text).join("");
  check("blocker2/divergence-flushed", textDeltas.includes("⚠ ") && textDeltas.includes("Note: here is normal answer"), `text=${textDeltas}`);
  check("blocker2/divergence-no-rotation", (ledger().accounts.a1?.cooldownUntilMs ?? 0) <= Date.now());
}

// Test 2d: [[quota-followed-by-tool]] - tool call flushes candidate buffer with textClose
{
  resetAcpPool();
  start(230, "t-b2-tool");
  await waitFor(() => replies(230).length === 1, 20000, "t-b2-tool start");
  const ptid = replies(230)[0].result.providerThreadId;

  send({
    jsonrpc: "2.0",
    id: 231,
    method: "turn/start",
    params: {
      threadId: "t-b2-tool",
      providerThreadId: ptid,
      clientRequestId: creq(),
      options,
      input: [{ type: "text", text: "[[quota-followed-by-tool]]", mentions: [] }],
    },
  });

  await waitFor(() => boundaries("t-b2-tool").length >= 1, 30000, "t-b2-tool completed");
  const dList = deltas("t-b2-tool");
  const hasToolCall = dList.some((d) => d.kind === "toolCall" || (d.kind === "item.open" && d.item?.type === "command"));
  const hasTextClose = dList.some((d) => d.kind === "item.textClose");
  check("blocker2/followed-by-tool-has-toolcall", hasToolCall && hasTextClose, `kinds=${dList.map((d) => d.kind).join(",")}`);
  check("blocker2/followed-by-tool-no-refusal", (ledger().accounts.a1?.cooldownUntilMs ?? 0) <= Date.now());
}

// ----------------------------------------------------------------------------
// BLOCKER 4: SSH_CONNECTION filtering
// ----------------------------------------------------------------------------
// Test 4a: Pool account drops options.envVars.SSH_CONNECTION
{
  resetAcpPool();
  const poolOpts = {
    ...options,
    envVars: { SSH_CONNECTION: "malicious-pool-ssh-conn" },
  };
  start(400, "t-b4-pool", poolOpts);
  await waitFor(() => replies(400).length === 1, 20000, "t-b4-pool start");
  const ptid = replies(400)[0].result.providerThreadId;

  send({
    jsonrpc: "2.0",
    id: 401,
    method: "turn/start",
    params: { threadId: "t-b4-pool", providerThreadId: ptid, clientRequestId: creq(), options: poolOpts, input: [{ type: "text", text: "hello", mentions: [] }] },
  });
  await waitFor(() => boundaries("t-b4-pool").length >= 1, 20000, "t-b4-pool completed");

  const lines = transcriptLines().filter((l) => l.home === "a1");
  const sshConns = lines.map((l) => l.__env?.SSH_CONNECTION);
  const dropped = sshConns.length > 0 && sshConns.every((c) => c !== "malicious-pool-ssh-conn");
  check("blocker4/pool-drops-ssh-connection", dropped, `sshConns=${JSON.stringify(sshConns)}`);
}

// ----------------------------------------------------------------------------
// BLOCKER 5: listAgyModels install.env does not override pool token marker
// ----------------------------------------------------------------------------
{
  const probeDir = trackedMkdtemp(join(tmpdir(), "agy-probe5-"));
  const cli = join(probeDir, "accounts", "p1", ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');

  // Configure agy-installs.json with an install trying to override SSH_CONNECTION
  writeFileSync(
    join(probeDir, "agy-installs.json"),
    JSON.stringify({
      installs: {
        "p1-install": {
          bin: shim,
          env: { SSH_CONNECTION: "install-ssh-override" },
        },
      },
      default: "p1-install",
    })
  );
  writeFileSync(
    join(probeDir, "accounts-state.json"),
    JSON.stringify({
      accounts: {
        p1: { install: "p1-install", cooldownUntilMs: 0, lastUsedMs: 0, lastError: null },
      },
    })
  );

  const probeBridge = (await import(new URL("./dist/host.js?plug357-probe5", import.meta.url).href)).experimental_providerBridge;
  probeBridge.start?.({ pluginId: "provider-agy", dataDir: probeDir, tempDir: probeDir });
  probeBridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 500, method: "model/list", params: {} }));
  await waitFor(() => messages.some((m) => m.id === 500), 20000, "probe model/list finished");

  const probeTranscript = transcriptLines();
  // Filter for launches in probeDir
  const probeLaunches = probeTranscript.filter((l) => l.home === "p1");
  const probeSsh = probeLaunches.map((l) => l.__env?.SSH_CONNECTION);
  check(
    "blocker5/list-models-install-env-marker-wins",
    probeSsh.length > 0 && probeSsh.every((s) => s === "127.0.0.1 0 127.0.0.1 0"),
    `probeSsh=${JSON.stringify(probeSsh)}`
  );
}

// ----------------------------------------------------------------------------
// BLOCKER 3: Direct mode 429 clamping to 30m max and rejection
// ----------------------------------------------------------------------------
{
  const directDir = trackedMkdtemp(join(tmpdir(), "agy-direct-"));
  const directWs = join(directDir, "ws");
  mkdirSync(directWs, { recursive: true });
  const directTranscript = join(directDir, "transcript.ndjson");

  // Run in direct mode (no accounts directory)
  const savedTranscript = process.env.AGY_FAKE_TRANSCRIPT;
  process.env.AGY_FAKE_TRANSCRIPT = directTranscript;
  process.env.AGY_ACCOUNTS = "0";

  const directBridge = (await import(new URL("./dist/host.js?plug357-direct", import.meta.url).href)).experimental_providerBridge;
  directBridge.start?.({ pluginId: "provider-agy", dataDir: directDir, tempDir: directDir });

  const directSend = (m) => directBridge.handleLine(JSON.stringify(m));

  const directOpts = {
    ...options,
    envVars: { SSH_CONNECTION: "direct-preserved-ssh" },
  };

  directSend({
    jsonrpc: "2.0",
    id: 300,
    method: "thread/start",
    params: { threadId: "t-b3-dir", cwd: directWs, options: directOpts, instructionMode: "append" },
  });
  await waitFor(() => replies(300).length === 1, 20000, "direct start");
  const ptid = replies(300)[0]?.result?.providerThreadId;

  // Initial turn so instructions are consumed and direct env is recorded
  directSend({
    jsonrpc: "2.0",
    id: 3001,
    method: "turn/start",
    params: { threadId: "t-b3-dir", providerThreadId: ptid, clientRequestId: creq(), options: directOpts, input: [{ type: "text", text: "initial direct turn", mentions: [] }] },
  });
  await waitFor(() => boundaries("t-b3-dir").length >= 1, 20000, "direct initial turn");

  // Blocker 4b: Check that direct mode preserves options.envVars.SSH_CONNECTION
  const directLines = existsSync(directTranscript)
    ? readFileSync(directTranscript, "utf8").split("\n").filter((l) => l.trim()).map(JSON.parse)
    : [];
  const directSsh = directLines[0]?.__env?.SSH_CONNECTION;
  check("blocker4/direct-preserves-ssh-connection", directSsh === "direct-preserved-ssh", `directSsh=${directSsh}`);

  // Send turn with quota failure (returns 127h countdown)
  directSend({
    jsonrpc: "2.0",
    id: 301,
    method: "turn/start",
    params: { threadId: "t-b3-dir", providerThreadId: ptid, clientRequestId: creq(), options: directOpts, input: [{ type: "text", text: "[[quota]]", mentions: [] }] },
  });

  await waitFor(
    () => rateLimits("t-b3-dir").length >= 1,
    20000,
    "rateLimits emitted"
  );

  const rlDelta = rateLimits("t-b3-dir")[0];

  // Clamped to at most 30 minutes (1800000 ms) from now
  const resetsAt = rlDelta?.rateLimits?.windows?.[0]?.resetsAtMs;
  const now = Date.now();
  const maxAllowed = now + 30 * 60 * 1000 + 5000;
  const isClamped = typeof resetsAt === "number" && resetsAt <= maxAllowed && resetsAt > now;
  check("blocker3/direct-rate-limits-clamped-30m", isClamped, `resetsAt=${resetsAt} diffMs=${resetsAt - now}`);

  // Immediate rejection of incoming turn before resetsAt with 429
  directSend({
    jsonrpc: "2.0",
    id: 302,
    method: "turn/start",
    params: { threadId: "t-b3-dir", providerThreadId: ptid, clientRequestId: creq(), options: directOpts, input: [{ type: "text", text: "second turn", mentions: [] }] },
  });
  await waitFor(() => replies(302).length === 1, 10000, "direct second turn rejected");
  const reply302 = replies(302)[0];
  check("blocker3/direct-incoming-rejected-429", reply302?.error?.message?.includes("Rate limit reached (429)"), reply302?.error?.message ?? "no error");

  process.env.AGY_FAKE_TRANSCRIPT = savedTranscript;
  delete process.env.AGY_ACCOUNTS;
}

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
process.stdout.write = originalWrite;
const passed = checks.filter(([, ok]) => ok).length;
process.stderr.write(`\n${passed}/${checks.length} passed\n`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
