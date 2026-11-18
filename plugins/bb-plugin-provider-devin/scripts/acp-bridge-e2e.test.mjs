// scripts/acp-bridge-e2e.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

const workerEntryPath = resolve(
  import.meta.dirname,
  "../node_modules/@get-bb/plugin-sdk/dist/provider-bridge-worker-entry.mjs"
);
const hostModulePath = resolve(import.meta.dirname, "../host.ts");

class BridgeTestHarness {
  constructor(testDir, fakeAgentScript, envOverrides = {}) {
    this.testDir = testDir;
    this.fakeAgentPath = join(testDir, "fake-devin.mjs");
    writeFileSync(this.fakeAgentPath, fakeAgentScript, { mode: 0o755 });

    this.stateDir = join(testDir, "state");
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });

    this.requestId = 1;
    this.pendingRequests = new Map();
    this.receivedLines = [];
    this.receivedDeltas = [];
    this.receivedNotifications = [];

    this.env = {
      ...process.env,
      BB_DEVIN_BIN: this.fakeAgentPath,
      BB_DEVIN_STATE_DIR: this.stateDir,
      BB_DEVIN_LLM_IDLE_MS: "120",
      BB_DEVIN_CANCEL_GRACE_MS: "80",
      BB_DEVIN_OPEN_WORK_MAX_MS: "200",
      ...envOverrides,
    };
    if ("BB_DEVIN_BIN" in envOverrides && envOverrides.BB_DEVIN_BIN === undefined) {
      delete this.env.BB_DEVIN_BIN;
    }

    this.process = spawn("node", ["--experimental-strip-types", workerEntryPath, hostModulePath, "acp-devin", testDir], {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = readline.createInterface({ input: this.process.stdout, terminal: false });
    this.rl.on("line", (line) => {
      this.receivedLines.push(line);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            res(msg.result);
          }
        }
        if (msg.method) {
          this.receivedNotifications.push(msg);
          if (msg.method === "thread/delta" && Array.isArray(msg.params?.deltas)) {
            this.receivedDeltas.push(...msg.params.deltas);
          }
        }
      } catch {}
    });

    this.process.stderr.on("data", () => {});
  }

  send(method, params) {
    const id = this.requestId++;
    return new Promise((res, rej) => {
      this.pendingRequests.set(id, { resolve: res, reject: rej });
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  configureSkills(roots = [{ id: "root-1", path: this.testDir, skills: [{ name: "test-skill", description: "Test skill" }] }]) {
    return this.send("skills/configure", { roots });
  }

  startThread(threadId = "thr_test1", permissionMode = "accept-edits", command = this.fakeAgentPath, instructions = undefined) {
    const isFull = permissionMode === "full";
    return this.send("thread/start", {
      threadId,
      cwd: this.testDir,
      instructionMode: "replace",
      ...(instructions !== undefined ? { instructions } : {}),
      options: {
        permissionMode,
        permissionScope: isFull ? "full" : "workspace",
        approvalReviewer: isFull ? null : "user",
        permissionEscalation: isFull ? null : "ask",
        providerOptions: {
          acpDialect: "devin",
          acpLaunchSpec: {
            displayName: "Devin",
            command,
            args: [],
            env: {},
          },
        },
      },
    });
  }

  resumeThread(threadId = "thr_test1", providerThreadId = "sess-1", permissionMode = "accept-edits", command = this.fakeAgentPath, extraOptions = {}) {
    const isFull = permissionMode === "full";
    const { providerOptions, ...restExtra } = extraOptions;
    return this.send("thread/resume", {
      threadId,
      providerThreadId,
      cwd: this.testDir,
      instructionMode: "replace",
      options: {
        permissionMode,
        permissionScope: isFull ? "full" : "workspace",
        approvalReviewer: isFull ? null : "user",
        permissionEscalation: isFull ? null : "ask",
        ...restExtra,
        providerOptions: {
          acpDialect: "devin",
          acpLaunchSpec: {
            displayName: "Devin",
            command,
            args: [],
            env: {},
          },
          ...(extraOptions.model ? { acpModelSelection: { kind: "native" } } : {}),
          ...providerOptions,
        },
      },
    });
  }

  startTurn(threadId = "thr_test1", text = "hello", clientRequestId = "creq_23456789ab", permissionMode = "accept-edits", command = this.fakeAgentPath) {
    const isFull = permissionMode === "full";
    return this.send("turn/start", {
      threadId,
      providerThreadId: "sess-1",
      clientRequestId,
      input: [{ type: "text", text }],
      options: {
        permissionMode,
        permissionScope: isFull ? "full" : "workspace",
        approvalReviewer: isFull ? null : "user",
        permissionEscalation: isFull ? null : "ask",
        providerOptions: {
          acpDialect: "devin",
          acpLaunchSpec: {
            displayName: "Devin",
            command,
            args: [],
            env: {},
          },
        },
      },
    });
  }

  steerTurn(threadId = "thr_test1", text = "steer", clientRequestId = "creq_3456789abc", permissionMode = "accept-edits", command = this.fakeAgentPath) {
    return this.send("turn/steer", {
      threadId,
      providerThreadId: "sess-1",
      expectedTurnId: "turn-1",
      clientRequestId,
      input: [{ type: "text", text }],
      options: {
        permissionMode,
        permissionScope: "workspace",
        approvalReviewer: "user",
        permissionEscalation: "ask",
        providerOptions: {
          acpDialect: "devin",
          acpLaunchSpec: {
            displayName: "Devin",
            command,
            args: [],
            env: {},
          },
        },
      },
    });
  }

  async waitForDelta(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = this.receivedDeltas.find(predicate);
      if (match) return match;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timeout waiting for delta matching predicate after ${timeoutMs}ms`);
  }

  async waitForNotification(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = this.receivedNotifications.find(predicate);
      if (match) return match;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timeout waiting for notification matching predicate after ${timeoutMs}ms`);
  }

  async cleanup() {
    this.process.kill();
    try {
      rmSync(this.testDir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 50));
      try {
        rmSync(this.testDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

// -------------------------------------------------------------------------------------
// Scenario 1: Long open tool_call longer than BB_DEVIN_LLM_IDLE_MS succeeds without devinIdleTimer
// -------------------------------------------------------------------------------------
test("1. long open tool_call longer than BB_DEVIN_LLM_IDLE_MS succeeds without devinIdleTimer", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-1-"));
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: { prompt: { image: false }, session: { load: true, resume: true } } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Running build", status: "pending" } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }, 180);
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_OPEN_WORK_MAX_MS: "500",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "build");
    const boundary = await harness.waitForDelta((d) => d.kind === "turn.boundary" && d.status === "completed");
    assert.ok(boundary);
    assert.ok(harness.receivedDeltas.some((d) => d.kind === "item.textDelta" && d.text === "done"));
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 2: Hanging open tool_call triggers BB_DEVIN_OPEN_WORK_MAX_MS
// -------------------------------------------------------------------------------------
test("2. hanging open tool_call triggers BB_DEVIN_OPEN_WORK_MAX_MS", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-2-"));
  const attemptFile = join(tmp, "attempt.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";
let lastPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: { prompt: { image: false }, session: { load: true, resume: true } } } });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call_2", status: "failed" } } });
    if (lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    if (count === 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call", toolCallId: "call_2", title: "Hanging tool", status: "pending" } } });
    } else {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "recovered after open work watchdog" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "300",
    BB_DEVIN_OPEN_WORK_MAX_MS: "150",
    BB_DEVIN_CANCEL_GRACE_MS: "100",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "run tool");
    const delta = await harness.waitForDelta(
      (d) => d.kind === "item.textDelta" && d.text === "recovered after open work watchdog",
      3000
    );
    assert.ok(delta);
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 3: Hanging session/prompt with queued soft notice followed by hard steer:
// executes hard steer first without duplicate input.accepted, then soft notice
// -------------------------------------------------------------------------------------
test("3. hanging prompt with soft notice and hard steer executes hard steer first", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-3-"));
  const attemptFile = join(tmp, "attempt.txt");
  const logFile = join(tmp, "prompts.log");

  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";
const logFile = "${logFile}";
let lastPromptId = null;
let cancelCount = 0;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: { prompt: { image: false }, session: { load: true, resume: true } } } });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    cancelCount++;
    if (cancelCount >= 2 && lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    const text = (msg.params.prompt || []).map(b => b.text || "").join("");
    fs.appendFileSync(logFile, text + "\\n---\\n");

    if (count === 1) {
      // First attempt hangs until watchdog cancel
    } else {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply to: " + text } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "140",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "original input", "creq_23456789aa");
    await harness.steerTurn("thr_test1", "[bb system] notice", "creq_23456789ab");
    await harness.steerTurn("thr_test1", "urgent hard steer", "creq_23456789ac");

    await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text?.includes("reply to: urgent hard steer"), 3000);
    await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text?.includes("reply to: [bb system] notice"), 3000);

    const acceptedCount = harness.receivedDeltas.filter(
      (d) => d.kind === "input.accepted" && d.clientRequestId === "creq_23456789aa"
    ).length;
    assert.equal(acceptedCount, 1);
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 4: Agent returns stopReason: cancelled on session/cancel -> recovery runs
// -------------------------------------------------------------------------------------
test("4. watchdog session/cancel with stopReason: cancelled recovers cleanly", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-4-"));
  const attemptFile = join(tmp, "attempt.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";
let lastPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: { prompt: { image: false }, session: { load: true, resume: true } } } });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" } } });
    if (lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    if (count === 1) {
      // Hang until cancel
    } else {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "recovered" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "prompt 1");
    const delta = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text === "recovered", 3000);
    assert.ok(delta);
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 5: Agent ignores cancel, sends tool_call_update completed and hangs:
// devinGraceTimer restarts, kills process, and recovers via Step 1
// -------------------------------------------------------------------------------------
test("5. ignored cancel with tool_call_update completed restarts grace timer and kills", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-5-"));
  const attemptFile = join(tmp, "attempt.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: { prompt: { image: false }, session: { load: true, resume: true } } } });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    // Ignore cancel, send completed tool call, and hang
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" } } });
  } else if (msg.method === "session/prompt") {
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    if (count === 1) {
      // Hang
    } else {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "rebuilt after grace kill" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "prompt 1");
    const delta = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text === "rebuilt after grace kill", 3000);
    assert.ok(delta);
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 6: Process crash during devinGraceTimer does not emit false error or session.reset
// -------------------------------------------------------------------------------------
test("6. crash during grace timer does not emit false error and recovers cleanly", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-6-"));
  const attemptFile = join(tmp, "attempt.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: { prompt: { image: false }, session: { load: true, resume: true } } } });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    // Crash spontaneously during grace
    setTimeout(() => { process.exit(1); }, 20);
  } else if (msg.method === "session/prompt") {
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    if (count === 1) {
      // Hang
    } else {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "rebuilt after crash" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_CANCEL_GRACE_MS: "150",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "prompt 1");
    const delta = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text === "rebuilt after crash", 3000);
    assert.ok(delta);

    // Verify no unexpected session.reset was emitted during recovery
    const resets = harness.receivedDeltas.filter((d) => d.kind === "session.reset");
    assert.equal(resets.length, 1);
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 7: session/load with 2 user_message_chunk chunks sends [bb recovery]
// -------------------------------------------------------------------------------------
test("7. session/load with replayed chunks sends bb recovery notice without TypeError", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-7-"));
  const attemptFile = join(tmp, "attempt.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/load" || msg.method === "session/resume") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "my test " } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "prompt" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "usage_update", used: 100 } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "cancelled" } } });
  } else if (msg.method === "session/prompt") {
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    if (count === 1) {
      // Hang until cancel and grace kill
    } else {
      const receivedPromptText = (msg.params.prompt || []).map(b => b.text || "").join("");
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "recovered: " + receivedPromptText } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.configureSkills();
    await harness.startThread();
    await harness.startTurn("thr_test1", "my test prompt");
    const delta = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text?.includes("Предыдущий ответ прервался"), 3500);
    assert.ok(delta);
    assert.ok(delta.text.includes("[bb recovery]"));
    assert.ok(!delta.text.includes("my test prompt"), "original prompt must not be resent when recovery notice matches");
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 8: Process spawn failure during recovery emits single error and drops queue
// -------------------------------------------------------------------------------------
test("8. spawn failure during recovery emits single error without loop", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-8-"));
  const spawnCountFile = join(tmp, "spawns.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const spawnCountFile = ${JSON.stringify(spawnCountFile)};
let count = 0;
try {
  count = parseInt(fs.readFileSync(spawnCountFile, "utf8").trim() || "0", 10);
} catch {}
count += 1;
fs.writeFileSync(spawnCountFile, String(count));

if (count > 1) {
  // Fail spawn/startup on recovery attempt
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

let lastPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: { prompt: { image: false }, session: { load: true, resume: true } } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    if (lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "prompt 1");
    const err = await harness.waitForNotification((n) => n.method === "error", 3000);
    assert.ok(err);
    const totalSpawns = parseInt(readFileSync(spawnCountFile, "utf8").trim(), 10);
    assert.equal(totalSpawns, 2, "exactly 2 spawn attempts: initial spawn and exactly 1 failed recovery spawn");
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 9: Consecutive stalls transition to Step 2 (wedged-sessions.json + session/new)
// -------------------------------------------------------------------------------------
test("9. consecutive stalls write to wedged-sessions.json and activate Step 2", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-9-"));
  const attemptFile = join(tmp, "attempt.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";
let lastPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/new") {
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    const sessId = count >= 2 ? "sess-2" : "sess-1";
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sessId, configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    if (lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    if (count <= 2) {
      // First two prompts stall and trigger watchdog cancel
    } else {
      // Third attempt (on Step 2 fresh session) succeeds
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "step 2 success" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "prompt 1");
    const delta = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text === "step 2 success", 4000);
    assert.ok(delta);

    const wedgedFile = join(tmp, "state", "wedged-sessions.json");
    assert.ok(existsSync(wedgedFile));
    const wedged = JSON.parse(readFileSync(wedgedFile, "utf8"));
    assert.ok(Array.isArray(wedged));
    assert.ok(wedged.includes("sess-1"));
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 10: 3 stalls in one turn hit MAX_TURN_RECYCLES=2 error, next turn recovers
// -------------------------------------------------------------------------------------
test("10. 3 stalls in one turn stop with max recycles error, next turn recovers", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-10-"));
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

let lastPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: { prompt: { image: false }, session: { load: true, resume: true } } } });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    if (lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    const text = (msg.params.prompt || []).map(b => b.text || "").join("");
    if (text.includes("turn 2")) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "turn 2 reply" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else {
      // All prompts in turn 1 stall
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "100",
    BB_DEVIN_CANCEL_GRACE_MS: "60",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "turn 1 prompt", "creq_23456789aa");
    const err = await harness.waitForNotification(
      (n) => n.method === "error" && n.params?.message?.includes("max turn recycles exceeded"),
      4000
    );
    assert.ok(err);

    await harness.startTurn("thr_test1", "turn 2 prompt", "creq_23456789bb");
    const delta = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text === "turn 2 reply", 3000);
    assert.ok(delta);
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 11: After normal completion no watchdog timer remains active
// -------------------------------------------------------------------------------------
test("11. after normal completion no watchdog timer remains active", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-11-"));
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, capabilities: { prompt: { image: false }, session: { load: true, resume: true } } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "quick reply" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript);
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "ping");
    await harness.waitForDelta((d) => d.kind === "turn.boundary" && d.status === "completed");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!harness.receivedDeltas.some((d) => d.kind === "turn.boundary" && d.status === "cancelled"));
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 12: Watchdog triggers cancel even when agent streams heartbeat usage_updates
// -------------------------------------------------------------------------------------
test("12. watchdog recovers when agent sends heartbeat usage_update during hang", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-12-"));
  const attemptFile = join(tmp, "attempt.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";
let heartbeat = null;
let lastPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    if (heartbeat) clearInterval(heartbeat);
    if (lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    if (count === 1) {
      // Stream usage_update every 30ms while hanging
      heartbeat = setInterval(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "usage_update", used: 100 } } });
      }, 30);
    } else {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "recovered after usage heartbeat" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "150",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "prompt with heartbeat");
    const delta = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text === "recovered after usage heartbeat", 4000);
    assert.ok(delta);
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 13: thread/resume with full permissionMode preserves returned bypass configOptions
// -------------------------------------------------------------------------------------
test("13. thread/resume with permissionMode: full preserves returned bypass configOptions", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-13-"));
  const callsFile = join(tmp, "set-config-calls.jsonl");
  const fakeScript = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

let lastModeSetByClient = "accept-edits";

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, resumeSession: true } } });
  } else if (msg.method === "session/load" || msg.method === "session/resume") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      sessionId: "sess-1",
      models: { currentModelId: "swe-2", availableModels: [{ modelId: "swe-2" }, { modelId: "swe-1.5" }] },
      configOptions: [
        { id: "mode", category: "mode", type: "select", options: [{ value: "bypass" }, { value: "accept-edits" }], currentValue: "accept-edits" },
        { id: "model", category: "model", type: "select", options: [{ value: "swe-2" }, { value: "swe-1.5" }], currentValue: "swe-2" }
      ]
    } });
  } else if (msg.method === "session/set_config_option") {
    fs.appendFileSync("${callsFile}", JSON.stringify(msg.params) + "\\n");
    if (msg.params.configId === "mode") {
      lastModeSetByClient = msg.params.value;
      send({ jsonrpc: "2.0", id: msg.id, result: {
        configOptions: [
          { id: "mode", category: "mode", type: "select", options: [{ value: "bypass" }, { value: "accept-edits" }], currentValue: msg.params.value },
          { id: "model", category: "model", type: "select", options: [{ value: "swe-2" }, { value: "swe-1.5" }], currentValue: "swe-2" }
        ]
      } });
    } else if (msg.params.configId === "model") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        configOptions: [
          { id: "mode", category: "mode", type: "select", options: [{ value: "bypass" }, { value: "accept-edits" }], currentValue: lastModeSetByClient },
          { id: "model", category: "model", type: "select", options: [{ value: "swe-2" }, { value: "swe-1.5" }], currentValue: msg.params.value }
        ]
      } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript);
  try {
    const res = await harness.resumeThread("thr_test1", "sess-1", "full", harness.fakeAgentPath, { model: "swe-1.5" });
    assert.ok(res);

    const setConfigCalls = readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const modeCall = setConfigCalls.find((c) => c.configId === "mode" && c.value === "bypass");
    const modelCall = setConfigCalls.find((c) => c.configId === "model" && c.value === "swe-1.5");
    assert.ok(modeCall, "session/set_config_option was called for mode === bypass");
    assert.ok(modelCall, "session/set_config_option was called for model === swe-1.5");

    const delta = await harness.waitForDelta(
      (d) => d.kind === "extension.state" && d.extensionKind === "bb/session-options" && d.payload?.options?.some((o) => o.id === "mode" && o.value === "bypass"),
      3000
    );
    assert.ok(delta, "bb/session-options state delta published mode with value bypass");
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 14: Replay with leading <system_instructions> strips instructions and sends [bb recovery]
// -------------------------------------------------------------------------------------
test("14. replay with leading system_instructions strips instructions and sends bb recovery without duplicating prompt", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-14-"));
  const attemptFile = join(tmp, "attempt.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";
let lastPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/load") {
    // Replay emits user_message_chunk with leading system_instructions and prompt 1
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "<system_instructions>\\nSystem rules\\n</system_instructions>\\n\\nprompt 1" }
    } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    if (lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    if (count === 1) {
      // Hang on attempt 1
    } else {
      const receivedPromptText = (msg.params.prompt || []).map(b => b.text || "").join("");
      const isRecovery = receivedPromptText.includes("[bb recovery]");
      const repeatsOriginal = receivedPromptText.includes("prompt 1");
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ isRecovery, repeatsOriginal }) } }
      } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.configureSkills();
    await harness.startThread("thr_test1", "accept-edits", harness.fakeAgentPath, "System rules");
    await harness.startTurn("thr_test1", "prompt 1");
    const delta = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text?.includes("isRecovery"), 4000);
    assert.ok(delta);
    const parsed = JSON.parse(delta.text);
    assert.equal(parsed.isRecovery, true, "must receive [bb recovery]");
    assert.equal(parsed.repeatsOriginal, false, "must NOT repeat prompt 1");
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 15: session/load without any user_message_chunk replays full original prompt without TypeError
// -------------------------------------------------------------------------------------
test("15. session/load without user_message_chunk replays full original prompt without TypeError", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-15-"));
  const attemptFile = join(tmp, "attempt.txt");
  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const attemptFile = "${attemptFile}";
let lastPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/load") {
    // 0 user_message_chunk emitted
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    if (lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    let count = 0;
    try { count = parseInt(fs.readFileSync(attemptFile, "utf8"), 10); } catch {}
    count++;
    fs.writeFileSync(attemptFile, String(count));

    if (count === 1) {
      // Hang on attempt 1
    } else {
      const receivedPromptText = (msg.params.prompt || []).map(b => b.text || "").join("");
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "recovered full: " + receivedPromptText } }
      } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.startThread();
    await harness.startTurn("thr_test1", "prompt 1");
    const delta = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text?.includes("recovered full: prompt 1"), 4000);
    assert.ok(delta);
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 16: Hot swap of binary via resolveDevinBin on Stage 1 recovery and between normal turns
// -------------------------------------------------------------------------------------
test("16. hot swap of binary via resolveDevinBin on Stage 1 recovery and between normal turns", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-16-"));
  const localBinDir = join(tmp, ".local", "bin");
  const versionsDir = join(tmp, ".local", "share", "devin", "cli", "_versions");
  mkdirSync(localBinDir, { recursive: true });
  mkdirSync(join(versionsDir, "3000.12.57", "bin"), { recursive: true });
  mkdirSync(join(versionsDir, "3000.12.55", "bin"), { recursive: true });

  const bin57 = join(versionsDir, "3000.12.57", "bin", "devin");
  const bin55 = join(versionsDir, "3000.12.55", "bin", "devin");
  const bin56 = join(versionsDir, "3000.12.56", "bin", "devin");
  const binC = join(tmp, "healthy-devin-c");
  const activeDevin = join(localBinDir, "devin");
  const hangMarker = join(tmp, "bin55-hung.txt");

  const makeScript = (label, shouldHangFirstPrompt = false) => `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

let promptCount = 0;
let lastPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "session/cancel") {
    if (lastPromptId !== null) {
      send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    promptCount++;
    if (${shouldHangFirstPrompt} && promptCount === 1) {
      try { fs.writeFileSync("${hangMarker}", "hanging"); } catch {}
      // Hang on prompt 1
    } else {
      const text = (msg.params.prompt || []).map(b => b.text || "").join("");
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "${label}: " + text } }
      } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
  writeFileSync(bin57, makeScript("BIN_57", false), { mode: 0o755 });
  writeFileSync(bin55, makeScript("BIN_55", true), { mode: 0o755 });
  symlinkSync(bin57, activeDevin);

  const harness = new BridgeTestHarness(tmp, makeScript("FALLBACK", false), {
    HOME: tmp,
    BB_DEVIN_USR_LOCAL_BIN: "",
    BB_DEVIN_BIN: undefined,
    BB_DEVIN_LLM_IDLE_MS: "120",
    BB_DEVIN_CANCEL_GRACE_MS: "80",
  });
  try {
    await harness.startThread();

    // (1) Stage 1 recovery test:
    // ~/.local/bin/devin -> 3000.12.57 (rejected), initially rolls back to 3000.12.55.
    // bin55 hangs on prompt 1. While hanging, 3000.12.56 appears in _versions.
    // Stage 1 recovery picks 3000.12.56 as newest healthy version.
    await harness.startTurn("thr_test1", "turn 1 prompt", "creq_23456789ab");
    for (let i = 0; i < 50 && !existsSync(hangMarker); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    mkdirSync(join(versionsDir, "3000.12.56", "bin"), { recursive: true });
    writeFileSync(bin56, makeScript("BIN_56", false), { mode: 0o755 });

    const delta1 = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text?.includes("BIN_56:"), 4000);
    assert.ok(delta1, "Stage 1 recovery successfully switched to BIN_56");

    // (2) Between normal turns test:
    // Switch ~/.local/bin/devin to healthy binC.
    // reconcileExecutionSettings restarts process with binC.
    writeFileSync(binC, makeScript("BIN_C", false), { mode: 0o755 });
    unlinkSync(activeDevin);
    symlinkSync(binC, activeDevin);

    await harness.startTurn("thr_test1", "turn 2 prompt", "creq_23456789ac");
    const delta2 = await harness.waitForDelta((d) => d.kind === "item.textDelta" && d.text?.includes("BIN_C:"), 4000);
    assert.ok(delta2, "Turn 2 via reconcileExecutionSettings restarted on BIN_C");
  } finally {
    await harness.cleanup();
  }
});

// -------------------------------------------------------------------------------------
// Scenario 17: explicit thread/resume for wedged session skips session/load and creates fresh session via session/new
// -------------------------------------------------------------------------------------
test("17. explicit thread/resume for wedged session skips session/load and creates fresh session via session/new", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "devin-e2e-17-"));
  const callsFile = join(tmp, "calls.json");
  writeFileSync(callsFile, JSON.stringify({ load: 0, resume: 0, new: 0 }));

  const stateDir = join(tmp, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const wedgedFile = join(stateDir, "wedged-sessions.json");
  writeFileSync(wedgedFile, JSON.stringify(["sess-wedged"]) + "\n", { mode: 0o600 });

  const fakeScript = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const callsFile = "${callsFile}";
function record(method) {
  const calls = JSON.parse(fs.readFileSync(callsFile, "utf8"));
  if (method === "session/load") calls.load++;
  if (method === "session/resume") calls.resume++;
  if (method === "session/new") calls.new++;
  fs.writeFileSync(callsFile, JSON.stringify(calls));
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, resumeSession: true } } });
  } else if (msg.method === "session/load" || msg.method === "session/resume") {
    record(msg.method);
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/new") {
    record(msg.method);
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-fresh", configOptions: [{ id: "mode", category: "mode", type: "select", options: [{ value: "accept-edits" }], currentValue: "accept-edits" }] } });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
});
`;
  const harness = new BridgeTestHarness(tmp, fakeScript, {
    BB_DEVIN_STATE_DIR: stateDir,
  });
  try {
    const res = await harness.resumeThread("thr_test1", "sess-wedged");
    assert.equal(res.providerThreadId, "sess-fresh", "must return fresh session ID");

    const calls = JSON.parse(readFileSync(callsFile, "utf8"));
    assert.equal(calls.load, 0, "session/load must not be called (0 calls)");
    assert.equal(calls.resume, 0, "session/resume must not be called (0 calls)");
    assert.equal(calls.new, 1, "session/new must be called exactly once");
  } finally {
    await harness.cleanup();
  }
});
