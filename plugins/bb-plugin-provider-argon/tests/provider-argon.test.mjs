import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";

import {
  parseResetTimeMs,
  classifyFailure,
  loadBackends,
  withStateLock,
  MODELS,
} from "../acp-server.mjs";

const require = createRequire(import.meta.url);
const driver = require("../src/gemini-driver.js");
const {
  selectModelAndThinking,
  ModelUnavailable,
  RESET_REGEX_EXTENDED,
  waitForHistoryStabilization,
  findTurnTarget,
} = driver;

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Fixture lifecycle (same contract as provider-agy §12.4): fixture servers
// die with the test process — detached gives each its own group so the exit
// teardown can take the whole tree — and mkdtemp dirs are removed.
const spawnedServers = [];
const tmpDirs = [];
function trackTmpDir(dir) {
  tmpDirs.push(dir);
  return dir;
}
function spawnServer(env) {
  const proc = spawn("node", ["acp-server.mjs"], {
    cwd: PLUGIN_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  spawnedServers.push(proc);
  return proc;
}
process.on("exit", () => {
  for (const proc of spawnedServers) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  }
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test("1. Syntax and hygiene checks across plugin files", () => {
  function getFiles(dir) {
    const res = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        res.push(...getFiles(full));
      } else {
        res.push(full);
      }
    }
    return res;
  }

  const allFiles = getFiles(PLUGIN_ROOT);
  const jsFiles = allFiles.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));

  for (const jsFile of jsFiles) {
    assert.doesNotThrow(() => {
      execSync(`node --check "${jsFile}"`, { stdio: "pipe" });
    }, `Syntax error in ${path.relative(PLUGIN_ROOT, jsFile)}`);
  }

  // Check forbidden substrings in all files (dynamically constructed to avoid self-match)
  const forbiddenSubstrings = ["/" + "home/", "/" + "opt/", "t" + "hr_", "p" + "roj_", "e" + "nv_"];
  for (const file of allFiles) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const sub of forbiddenSubstrings) {
      assert.equal(
        content.includes(sub),
        false,
        `File ${path.relative(PLUGIN_ROOT, file)} contains forbidden substring "${sub}"`
      );
    }

    // Check for real personal email addresses (allow example.com, @get-bb, @zahed)
    const emails = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    for (const em of emails) {
      assert.match(
        em,
        /@(?:example\.com|example\.org|users\.noreply\.github\.com)$/,
        `File ${path.relative(PLUGIN_ROOT, file)} contains non-example email: ${em}`
      );
    }
  }
});

test("2. parseResetTimeMs parses English and Russian quota reset formats", () => {
  const baseNow = new Date("2026-11-16T00:00:00.000Z").getTime();

  // English 12h
  const t1 = parseResetTimeMs("Limit resets 2:19 AM", baseNow);
  assert.ok(t1 !== null);
  const d1 = new Date(t1 - 2 * 60_000);
  assert.equal(d1.getHours(), 2);
  assert.equal(d1.getMinutes(), 19);

  // English with Month & Date
  const t2 = parseResetTimeMs("Limit resets Oct 15, 2:19 AM", baseNow);
  assert.ok(t2 !== null);
  const d2 = new Date(t2 - 2 * 60_000);
  assert.equal(d2.getMonth(), 9); // Oct is 9
  assert.equal(d2.getDate(), 15);
  assert.equal(d2.getHours(), 2);
  assert.equal(d2.getMinutes(), 19);

  // English with tomorrow
  const t3 = parseResetTimeMs("Limit resets tomorrow at 11:00 AM", baseNow);
  assert.ok(t3 !== null);
  const d3 = new Date(t3 - 2 * 60_000);
  assert.equal(d3.getHours(), 11);
  assert.equal(d3.getMinutes(), 0);

  // Russian format
  const t4 = parseResetTimeMs("Лимит обновится в 14:30", baseNow);
  assert.ok(t4 !== null);
  const d4 = new Date(t4 - 2 * 60_000);
  assert.equal(d4.getHours(), 14);
  assert.equal(d4.getMinutes(), 30);

  // Russian format with tomorrow
  const t5 = parseResetTimeMs("Лимит сбросится завтра в 09:15", baseNow);
  assert.ok(t5 !== null);
  const d5 = new Date(t5 - 2 * 60_000);
  assert.equal(d5.getHours(), 9);
  assert.equal(d5.getMinutes(), 15);

  // Year rollover: base date in December, reset in January
  const decNow = new Date("2026-12-25T10:00:00.000Z").getTime();
  const tYear = parseResetTimeMs("Limit resets Jan 2, 2:19 AM", decNow);
  assert.ok(tYear !== null);
  const dYear = new Date(tYear - 2 * 60_000);
  assert.equal(dYear.getFullYear(), 2027);
  assert.equal(dYear.getMonth(), 0); // Jan is 0
  assert.equal(dYear.getDate(), 2);
  assert.equal(dYear.getHours(), 2);
  assert.equal(dYear.getMinutes(), 19);

  // Past date within 30 days (today 1 minute ago) must NOT roll over to next year
  const pastMinuteNow = new Date("2026-11-16T02:20:00.000Z").getTime();
  const tPastMinute = parseResetTimeMs("Limit resets Nov 16, 2:19 AM", pastMinuteNow);
  assert.ok(tPastMinute !== null);
  const dPastMinute = new Date(tPastMinute - 2 * 60_000);
  assert.equal(dPastMinute.getFullYear(), 2026, "Must not advance year for recent time today");
  assert.equal(dPastMinute.getMonth(), 10);
  assert.equal(dPastMinute.getDate(), 16);
  assert.equal(dPastMinute.getHours(), 2);
  assert.equal(dPastMinute.getMinutes(), 19);
  // Cooldown from this reset time must be <= 2 minutes (or 0)
  const diffCooldown = Math.max(0, tPastMinute - pastMinuteNow);
  assert.ok(diffCooldown <= 2 * 60_000, `Cooldown must be <= 2 minutes, got ${diffCooldown}ms`);

  // Unrelated string
  assert.equal(parseResetTimeMs("Everything is normal"), null);
});

test("3. classifyFailure correctly classifies errors", () => {
  // rate-limit from limit reset message
  const c1 = classifyFailure(new Error("Limit resets 2:19 AM"));
  assert.equal(c1.category, "rate-limit");
  assert.equal(c1.rotatable, true);
  assert.ok(c1.cooldownMs > 0);

  // rate-limit cooldown capped at 7 days
  const cFar = classifyFailure(new Error("Limit resets Dec 30, 10:00 AM"));
  assert.ok(cFar.cooldownMs <= 7 * 86_400_000, "Cooldown must be capped at 7 days");

  // rate-limit from thinking level
  const c2 = classifyFailure(new Error("Thinking level is rate-limited"));
  assert.equal(c2.category, "rate-limit");
  assert.equal(c2.rotatable, true);

  // model-unavailable
  const c3 = classifyFailure(new Error("model is unavailable"));
  assert.equal(c3.category, "model-unavailable");
  assert.equal(c3.rotatable, true);
  assert.equal(c3.cooldownMs, 6 * 3600_000);

  // transient stream timeout (540s and 900s caps)
  const c4 = classifyFailure(new Error("generation still running after 540s cap — answer truncated"));
  assert.equal(c4.category, "transient");
  assert.equal(c4.rotatable, true);
  assert.equal(c4.cooldownMs, 0);

  const c4b = classifyFailure(new Error("generation still running after 900s cap — answer truncated"));
  assert.equal(c4b.category, "transient");
  assert.equal(c4b.rotatable, true);
  assert.equal(c4b.cooldownMs, 0);

  // auth-dead
  const c5 = classifyFailure(new Error("not logged in"));
  assert.equal(c5.category, "auth-dead");
  assert.equal(c5.rotatable, true);
  assert.equal(c5.cooldownMs, 7 * 24 * 3600_000);

  // ModelUnavailable('thinking', ...) instances
  const errThinkingRateLimited = new ModelUnavailable(
    "thinking",
    "high thinking level is rate-limited (Limit resets 2:19 AM)"
  );
  const cThinkingRL = classifyFailure(errThinkingRateLimited);
  assert.equal(cThinkingRL.category, "rate-limit");
  assert.equal(cThinkingRL.rotatable, true);
  assert.ok(cThinkingRL.cooldownMs > 0);

  const errThinkingNotFound = new ModelUnavailable("thinking", "not found in model menu");
  const cThinkingNF = classifyFailure(errThinkingNotFound);
  assert.equal(cThinkingNF.category, "model-unavailable");
  assert.equal(cThinkingNF.rotatable, true);
  assert.equal(cThinkingNF.cooldownMs, 6 * 3600_000);
});

test("4. gemini-driver strict selectModelAndThinking and no fallback", async () => {
  // Source check: no responses[responses.length - 1] fallback
  const driverSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "src/gemini-driver.js"), "utf8");
  assert.equal(
    driverSrc.includes("responses[responses.length - 1]"),
    false,
    "gemini-driver.js must not fallback to responses[responses.length - 1]"
  );
  assert.ok(
    driverSrc.includes("const target = responses[idx];"),
    "gemini-driver.js must use responses[idx]"
  );
  assert.ok(
    driverSrc.includes("function findTurnTarget(doc, idx, promptPrefix)"),
    "gemini-driver.js must define findTurnTarget"
  );

  // Mock page for selectModelAndThinking
  const mockPage = {
    $: async (sel) => {
      if (sel.includes("thinking_level")) {
        return {
          hover: async () => {},
          getAttribute: async (attr) => (attr === "aria-expanded" ? "true" : "sub1"),
          click: async () => {},
        };
      }
      return null;
    },
    $$: async () => {
      return [
        {
          innerText: async () => "Thinking\nLimit resets 2:19 AM",
          evaluate: async () => true, // isDisabled = true
          click: async () => {},
        },
      ];
    },
    waitForSelector: async () => ({
      innerText: async () => "Fast",
      getAttribute: async () => "Fast",
      click: async () => {},
    }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };

  await assert.rejects(
    async () => {
      await selectModelAndThinking(mockPage, null, "thinking", true);
    },
    (err) => {
      assert.ok(err instanceof ModelUnavailable);
      assert.match(err.message, /thinking level is rate-limited/i);
      return true;
    }
  );

  // Verification that target is validated after last user-query with promptPrefix
  assert.ok(
    driverSrc.includes("queries[queries.length - 1]"),
    "gemini-driver.js must check last user-query"
  );
  assert.ok(
    driverSrc.includes("promptPrefix"),
    "gemini-driver.js must check promptPrefix"
  );
  assert.ok(
    driverSrc.includes("DOCUMENT_POSITION_FOLLOWING"),
    "gemini-driver.js must verify responses[idx] follows user-query"
  );

  // Mock page for waitForHistoryStabilization with asynchronous progressive history loading
  let historyCalls = 0;
  const mockPageAsync = {
    $$: async (sel) => {
      if (sel === "model-response") {
        historyCalls++;
        // Simulate async DOM loading:
        // call 1: []
        // call 2: [{}]
        // call 3: [{}, {}]
        // call 4: [{}, {}] -> 1st match with previous
        // call 5: [{}, {}] -> 2nd match with previous -> stable!
        if (historyCalls === 1) return [];
        if (historyCalls === 2) return [{}];
        return [{}, {}];
      }
      return [];
    },
    waitForTimeout: async () => {},
  };

  const stabilizedCount = await waitForHistoryStabilization(mockPageAsync, "conv-12345678", {
    intervalMs: 5,
  });
  assert.equal(stabilizedCount, 2, "Must stabilize at 2 model-responses");
  assert.ok(historyCalls >= 5, "Must take multiple measurements to confirm stability");

  // waitForHistoryStabilization stabilizes even when count === 0
  let emptyCalls = 0;
  const mockEmptyPage = {
    $$: async () => {
      emptyCalls++;
      return [];
    },
    waitForTimeout: async () => {},
  };
  const emptyCount = await waitForHistoryStabilization(mockEmptyPage, "conv-empty", {
    intervalMs: 5,
    ceilingMs: 10000,
  });
  assert.equal(emptyCount, 0, "Must stabilize at 0 model-responses");
  assert.ok(emptyCalls >= 3, "Must take at least 2 stable measurements before stabilizing at 0");

  // For a new chat (no convId), it must return immediately on the first query
  let newChatCalls = 0;
  const mockNewChatPage = {
    $$: async () => {
      newChatCalls++;
      return [{}, {}, {}];
    },
    waitForTimeout: async () => {},
  };
  const newChatCount = await waitForHistoryStabilization(mockNewChatPage, null);
  assert.equal(newChatCount, 3);
  assert.equal(newChatCalls, 1, "Must return immediately without waiting when convId is null");

  // Mock DOM test: old query + old response, new query with promptPrefix, but no new model-response yet
  const NODE_FOLLOWING = 4;
  const NODE_PRECEDING = 2;

  const nodeQuery0 = {
    id: "query-0",
    innerText: "Old user question",
    compareDocumentPosition(other) {
      if (other.id === "resp-0" || other.id === "query-1" || other.id === "resp-1") return NODE_FOLLOWING;
      return 0;
    },
  };

  const nodeResp0 = {
    id: "resp-0",
    innerText: "Old model response",
    querySelector(sel) {
      if (sel === "message-content") return { innerText: "Old model response" };
      return null;
    },
    compareDocumentPosition(other) {
      if (other.id === "query-0") return NODE_PRECEDING;
      if (other.id === "query-1" || other.id === "resp-1") return NODE_FOLLOWING;
      return 0;
    },
  };

  const nodeQuery1 = {
    id: "query-1",
    innerText: "New user prompt for turn 2",
    compareDocumentPosition(other) {
      if (other.id === "query-0" || other.id === "resp-0") return NODE_PRECEDING;
      if (other.id === "resp-1") return NODE_FOLLOWING;
      return 0;
    },
  };

  const nodeResp1 = {
    id: "resp-1",
    innerText: "New model response for turn 2",
    querySelector(sel) {
      if (sel === "message-content") return { innerText: "New model response for turn 2" };
      return null;
    },
    compareDocumentPosition(other) {
      if (other.id === "query-0" || other.id === "resp-0" || other.id === "query-1") return NODE_PRECEDING;
      return 0;
    },
  };

  // State 1: only query0, resp0 and query1 exist in DOM (model-response 1 has not appeared yet)
  const mockDocBeforeResp = {
    querySelectorAll(sel) {
      if (sel === "user-query") return [nodeQuery0, nodeQuery1];
      if (sel === "model-response") return [nodeResp0];
      return [];
    },
  };

  const testPrefix = "New user prompt";

  // Check turn target at index 1: must be null (resp1 not in DOM)
  const targetNewTurn = findTurnTarget(mockDocBeforeResp, 1, testPrefix);
  assert.equal(targetNewTurn, null, "Turn 1 target must be null when model-response[1] has not appeared yet");

  // Check if someone checked index 0 or fallback: old response must NOT be accepted as new response
  const targetOldFallback = findTurnTarget(mockDocBeforeResp, 0, testPrefix);
  assert.equal(
    targetOldFallback,
    null,
    "Old model-response[0] must not be accepted because it precedes the last user-query"
  );

  // State 2: resp1 appears in DOM following query1
  const mockDocWithResp = {
    querySelectorAll(sel) {
      if (sel === "user-query") return [nodeQuery0, nodeQuery1];
      if (sel === "model-response") return [nodeResp0, nodeResp1];
      return [];
    },
  };

  const targetSuccess = findTurnTarget(mockDocWithResp, 1, testPrefix);
  assert.equal(targetSuccess, nodeResp1, "Turn 1 target must correctly resolve to nodeResp1 when it appears");

  // Multiline prompt test with multiple spaces, tabs, and newlines
  const nodeQueryMultiline = {
    id: "query-multi",
    innerText: "   First line of query \n\n  second line   with   spaces\nthird line   ",
    compareDocumentPosition(other) {
      if (other.id === "resp-multi") return NODE_FOLLOWING;
      return NODE_PRECEDING;
    },
  };

  const nodeRespMultiline = {
    id: "resp-multi",
    innerText: "Multiline model answer",
    compareDocumentPosition(other) {
      if (other.id === "query-multi") return NODE_PRECEDING;
      return 0;
    },
  };

  const mockDocMultiline = {
    querySelectorAll(sel) {
      if (sel === "user-query") return [nodeQueryMultiline];
      if (sel === "model-response") return [nodeRespMultiline];
      return [];
    },
  };

  const multilinePrompt = "\n\n   First   line of query\n\tsecond   line with spaces\nthird line and more details...";
  const targetMultiline = findTurnTarget(mockDocMultiline, 0, multilinePrompt);
  assert.equal(
    targetMultiline,
    nodeRespMultiline,
    "findTurnTarget must correctly match when query and prompt contain newlines and multiple spaces"
  );

  const targetMismatch = findTurnTarget(mockDocMultiline, 0, "Different \n\n prompt   content");
  assert.equal(targetMismatch, null, "findTurnTarget must return null for non-matching multiline prompt");

  const slicedPrefix = multilinePrompt.replace(/\s+/g, " ").trim().slice(0, 40);
  const targetSliced = findTurnTarget(mockDocMultiline, 0, slicedPrefix);
  assert.equal(
    targetSliced,
    nodeRespMultiline,
    "findTurnTarget must correctly match when given 40-char sliced promptPrefix"
  );
});

test("5. Full JSON-RPC cycle of acp-server.mjs in ARGON_FAKE=1 mode with lease retention and selective cancel", async () => {
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon-test-state-")));
  const poolFile = path.join(tmpDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        {
          id: "fake-acc-1",
          email: "fake1@example.com",
          profileDir: path.join(tmpDir, "p1"),
          cdpPort: 9222,
          priority: 10,
        },
      ],
    })
  );

  const serverProc = spawnServer({
    ...process.env,
    ARGON_FAKE: "1",
    ARGON_FAKE_DELAY_MS: "300",
    ARGON_STATE_DIR: tmpDir,
    ARGON_POOL_FILE: poolFile,
  });

  const lines = [];
  serverProc.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) {
        try {
          lines.push(JSON.parse(line.trim()));
        } catch {}
      }
    }
  });

  function sendReq(req) {
    serverProc.stdin.write(JSON.stringify(req) + "\n");
  }

  async function waitForResponse(id, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.id === id);
      if (idx >= 0) {
        return lines.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for response id=${id}`);
  }

  async function waitForNotification(method, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.method === method);
      if (idx >= 0) {
        return lines.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for notification ${method}`);
  }

  // 1. initialize
  sendReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const r1 = await waitForResponse(1);
  assert.equal(r1.result.agentInfo.name, "argon-gemini");
  assert.equal(r1.result.agentInfo.version, "0.2.0");
  assert.equal(r1.result.agentCapabilities.loadSession, false);

  // 2. session/new
  sendReq({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
  const r2 = await waitForResponse(2);
  const sessionId = r2.result.sessionId;
  assert.ok(sessionId.startsWith("argon-"));
  assert.ok(Array.isArray(r2.result.models.availableModels));
  assert.ok(r2.result.models.availableModels.length > 0);
  for (const m of r2.result.models.availableModels) {
    assert.equal(typeof m, "object");
    assert.ok(m !== null);
    assert.equal(typeof m.modelId, "string");
    assert.ok(m.modelId.length > 0);
    assert.equal(typeof m.name, "string");
    assert.ok(m.name.length > 0);
  }
  const modelIds = r2.result.models.availableModels.map((m) => m.modelId);
  assert.ok(modelIds.includes("argon"));
  assert.ok(modelIds.includes("pro"));
  const proModel = r2.result.models.availableModels.find((m) => m.modelId === "pro");
  assert.equal(proModel?.name, "Gemini 3.1 Pro (старая 3.1, не рекомендуется)");
  assert.equal(
    MODELS.find((m) => m.value === "pro")?.name,
    "Gemini 3.1 Pro (старая 3.1, не рекомендуется)"
  );

  // 2b. session/load also returns availableModels as { modelId, name } objects
  sendReq({ jsonrpc: "2.0", id: 21, method: "session/load", params: { sessionId } });
  const r21 = await waitForResponse(21);
  assert.equal(r21.result.sessionId, sessionId);
  assert.ok(Array.isArray(r21.result.models.availableModels));
  for (const m of r21.result.models.availableModels) {
    assert.equal(typeof m, "object");
    assert.ok(m !== null);
    assert.equal(typeof m.modelId, "string");
    assert.ok(m.modelId.length > 0);
    assert.equal(typeof m.name, "string");
    assert.ok(m.name.length > 0);
  }
  const loadModelIds = r21.result.models.availableModels.map((m) => m.modelId);
  assert.ok(loadModelIds.includes("argon"));
  assert.ok(loadModelIds.includes("pro"));

  // 3. session/set_model
  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/set_model",
    params: { sessionId, modelId: "argon" },
  });
  const r3 = await waitForResponse(3);
  assert.ok(r3.result.configOptions);

  // 4. session/set_config_option
  sendReq({
    jsonrpc: "2.0",
    id: 4,
    method: "session/set_config_option",
    params: { sessionId, configId: "thought_level", value: "high" },
  });
  const r4 = await waitForResponse(4);
  assert.ok(r4.result.configOptions);
  const modelOpt4 = r4.result.configOptions.find((o) => o.id === "model");
  assert.equal(modelOpt4?.currentValue, "argon", "Model must remain 'argon' when thought_level changes on argon model");

  // Verify non-argon model updates to pro when thought_level is set to high
  sendReq({
    jsonrpc: "2.0",
    id: 401,
    method: "session/set_model",
    params: { sessionId, modelId: "fast" },
  });
  await waitForResponse(401);

  sendReq({
    jsonrpc: "2.0",
    id: 402,
    method: "session/set_config_option",
    params: { sessionId, configId: "thought_level", value: "high" },
  });
  const r402 = await waitForResponse(402);
  const modelOpt402 = r402.result.configOptions.find((o) => o.id === "model");
  assert.equal(modelOpt402?.currentValue, "pro", "Model must update to 'pro' when thought_level is high and s.model !== 'argon'");

  // Reset back to argon for the rest of the test
  sendReq({
    jsonrpc: "2.0",
    id: 403,
    method: "session/set_model",
    params: { sessionId, modelId: "argon" },
  });
  await waitForResponse(403);

  // 5. session/prompt (streaming with lease retention check during execution)
  sendReq({
    jsonrpc: "2.0",
    id: 5,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Hello from test suite" }],
    },
  });

  const update = await waitForNotification("session/update");
  assert.equal(update.params.sessionId, sessionId);
  assert.ok(
    update.params.update?.content?.text?.includes("FAKE_ARGON_ECHO") ||
    update.params.update?.text?.includes("FAKE_ARGON_ECHO")
  );

  // Verify lease is actively held while execution is delayed
  const statePath = path.join(tmpDir, "accounts-state.json");
  assert.ok(fs.existsSync(statePath), "accounts-state.json must exist during execution");
  const stDuring = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(stDuring.leases && stDuring.leases["fake-acc-1"], "Lease must be held during prompt execution");
  assert.equal(stDuring.leases["fake-acc-1"].pid, serverProc.pid);

  const r5 = await waitForResponse(5);
  assert.equal(r5.result.stopReason, "end_turn");

  // Verify lease released after prompt completes
  const stAfter = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(stAfter.leases || {}, {}, "Lease must be released after completion");

  // 6. Selective cancel: cancelling a different session ID does NOT cancel the running prompt
  sendReq({
    jsonrpc: "2.0",
    id: 6,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Prompt to test selective cancel" }],
    },
  });
  await waitForNotification("session/update");

  // Send cancel for a non-matching session
  sendReq({
    jsonrpc: "2.0",
    id: 7,
    method: "session/cancel",
    params: { sessionId: "non-existent-session" },
  });
  const r7 = await waitForResponse(7);
  assert.equal(r7.result.stopReason, "cancelled");

  // Prompt 6 must complete normally with end_turn because non-matching cancel was ignored
  const r6 = await waitForResponse(6);
  assert.equal(r6.result.stopReason, "end_turn");

  // 7. Matching session/cancel returns stopReason: "cancelled"
  sendReq({
    jsonrpc: "2.0",
    id: 8,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Prompt to be cancelled" }],
    },
  });
  await waitForNotification("session/update");

  sendReq({
    jsonrpc: "2.0",
    id: 9,
    method: "session/cancel",
    params: { sessionId },
  });
  const r9 = await waitForResponse(9);
  assert.equal(r9.result.stopReason, "cancelled");

  const r8 = await waitForResponse(8);
  assert.equal(r8.result.stopReason, "cancelled");

  const stCancel = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(stCancel.leases || {}, {}, "Leases must be empty after cancel");

  // 8. Normal exit of test 5 server
  serverProc.stdin.end();
  await new Promise((resolve) => serverProc.on("exit", resolve));

  if (fs.existsSync(statePath)) {
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(st.leases || {}, {}, "Leases must be empty after closing stdin");
  }

  // Cleanup tmpDir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("6. Automatic lease release upon SIGTERM during prompt execution", async () => {
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon-term-test-")));
  const poolFile = path.join(tmpDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        {
          id: "fake-acc-term",
          email: "term@example.com",
          profileDir: path.join(tmpDir, "p1"),
          cdpPort: 9222,
          priority: 10,
        },
      ],
    })
  );

  const serverProc = spawnServer({
    ...process.env,
    ARGON_FAKE: "1",
    ARGON_FAKE_DELAY_MS: "1200",
    ARGON_STATE_DIR: tmpDir,
    ARGON_POOL_FILE: poolFile,
  });

  const lines = [];
  serverProc.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) {
        try {
          lines.push(JSON.parse(line.trim()));
        } catch {}
      }
    }
  });

  function sendReq(req) {
    serverProc.stdin.write(JSON.stringify(req) + "\n");
  }

  async function waitForNotification(method, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.method === method);
      if (idx >= 0) {
        return lines.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for notification ${method}`);
  }

  sendReq({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  sendReq({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: "/tmp" },
  });
  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId: "argon-1",
      prompt: [{ type: "text", text: "Long turn before term" }],
    },
  });

  // Wait until prompt starts and emits chunk
  await waitForNotification("session/update");

  // Verify lease is held
  const statePath = path.join(tmpDir, "accounts-state.json");
  assert.ok(fs.existsSync(statePath));
  const stBefore = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(stBefore.leases && stBefore.leases["fake-acc-term"], "Lease must be held during execution before SIGTERM");
  assert.equal(stBefore.leases["fake-acc-term"].pid, serverProc.pid);

  // Send SIGTERM
  serverProc.kill("SIGTERM");
  await new Promise((resolve) => serverProc.on("exit", resolve));

  if (fs.existsSync(statePath)) {
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(st.leases || {}, {}, "Leases must be empty after SIGTERM");
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("7. Close stdin during active prompt with ARGON_FAKE_DELAY_MS=10000 releases lease swiftly", async () => {
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon-stdin-delay-test-")));
  const poolFile = path.join(tmpDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        {
          id: "fake-acc-stdin",
          email: "fakestdin@example.com",
          profileDir: path.join(tmpDir, "p1"),
          cdpPort: 9222,
          priority: 10,
        },
      ],
    })
  );

  const serverProc = spawnServer({
    ...process.env,
    ARGON_FAKE: "1",
    ARGON_FAKE_DELAY_MS: "10000",
    ARGON_STATE_DIR: tmpDir,
    ARGON_POOL_FILE: poolFile,
  });

  const lines = [];
  serverProc.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) {
        try {
          lines.push(JSON.parse(line.trim()));
        } catch {}
      }
    }
  });

  function sendReq(req) {
    serverProc.stdin.write(JSON.stringify(req) + "\n");
  }

  async function waitForResponse(id, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.id === id);
      if (idx >= 0) {
        return lines.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for response id=${id}`);
  }

  async function waitForNotification(method, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.method === method);
      if (idx >= 0) {
        return lines.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for notification ${method}`);
  }

  // 1. initialize
  sendReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await waitForResponse(1);

  // 2. session/new
  sendReq({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
  const r2 = await waitForResponse(2);
  const sessionId = r2.result.sessionId;

  // 3. session/prompt (long running with 10s delay)
  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Long turn prompt for stdin close test" }],
    },
  });

  // Wait for chunk notification to ensure prompt is actively running
  await waitForNotification("session/update");

  // Verify lease is actively held
  const statePath = path.join(tmpDir, "accounts-state.json");
  assert.ok(fs.existsSync(statePath));
  const stDuring = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(
    stDuring.leases && stDuring.leases["fake-acc-stdin"],
    "Lease must be held during prompt execution before stdin close"
  );
  assert.equal(stDuring.leases["fake-acc-stdin"].pid, serverProc.pid);

  // Close stdin during execution
  const closeStartTime = Date.now();
  serverProc.stdin.end();

  await new Promise((resolve) => serverProc.on("exit", resolve));
  const exitDuration = Date.now() - closeStartTime;

  assert.ok(
    exitDuration < 3000,
    `Server must exit faster than 3000ms upon stdin close (took ${exitDuration}ms)`
  );

  if (fs.existsSync(statePath)) {
    const stAfter = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(stAfter.leases || {}, {}, "Lease must be released after stdin close");
  }

  // Verify that response with stopReason 'end_turn' was NOT sent
  const endTurnMsg = lines.find((l) => l.result?.stopReason === "end_turn");
  assert.equal(endTurnMsg, undefined, "Response with stopReason 'end_turn' must not be sent on stdin close");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("8. PLUG-281 prompt-size guard: driver boundary and immediate -32000 before any lease", async () => {
  // Driver boundary: sendPrompt must reject before ensureChrome/CDP —
  // every send to Gemini passes through it (incl. packed/tool-loop messages).
  const prevEnv = process.env.ARGON_MAX_PROMPT_BYTES;
  process.env.ARGON_MAX_PROMPT_BYTES = "100";
  try {
    await assert.rejects(driver.sendPrompt({ prompt: "x".repeat(200) }), (err) => {
      assert.equal(err.code, "ARGON_PROMPT_TOO_LARGE");
      assert.equal(
        err.message,
        "prompt too large: 200 bytes exceeds limit 100 bytes (ARGON_MAX_PROMPT_BYTES). Shrink the request and retry."
      );
      return true;
    });
  } finally {
    if (prevEnv === undefined) delete process.env.ARGON_MAX_PROMPT_BYTES;
    else process.env.ARGON_MAX_PROMPT_BYTES = prevEnv;
  }

  // Server boundary: synchronous refusal in dispatch — no queue, no account
  // selection, no lease, no state file on disk.
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon-guard-test-")));
  const poolFile = path.join(tmpDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        {
          id: "fake-acc-guard",
          email: "guard@example.com",
          profileDir: path.join(tmpDir, "p1"),
          cdpPort: 9222,
          priority: 10,
        },
      ],
    })
  );

  const serverProc = spawnServer({
    ...process.env,
    ARGON_FAKE: "1",
    ARGON_MAX_PROMPT_BYTES: "100",
    ARGON_STATE_DIR: tmpDir,
    ARGON_POOL_FILE: poolFile,
  });

  const lines = [];
  serverProc.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) {
        try {
          lines.push(JSON.parse(line.trim()));
        } catch {}
      }
    }
  });

  function sendReq(req) {
    serverProc.stdin.write(JSON.stringify(req) + "\n");
  }

  async function waitForResponse(id, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.id === id);
      if (idx >= 0) {
        return lines.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for response id=${id}`);
  }

  sendReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await waitForResponse(1);
  sendReq({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
  const r2 = await waitForResponse(2);
  const sessionId = r2.result.sessionId;

  // 200 bytes > limit 100 → immediate error with exact contract message.
  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "x".repeat(200) }] },
  });
  const r3 = await waitForResponse(3);
  assert.equal(r3.error?.code, -32000);
  assert.equal(
    r3.error?.message,
    "prompt too large: 200 bytes exceeds limit 100 bytes (ARGON_MAX_PROMPT_BYTES). Shrink the request and retry."
  );

  // UTF-8 is measured in bytes, not characters: 60 × 'й' = 120 bytes > 100.
  sendReq({
    jsonrpc: "2.0",
    id: 31,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "й".repeat(60) }] },
  });
  const r31 = await waitForResponse(31);
  assert.equal(r31.error?.code, -32000);
  assert.match(r31.error?.message, /^prompt too large: 120 bytes exceeds limit 100 bytes/);

  // No lease taken, no account touched: the state file is only written by
  // bindBackend/withStateLock, which the refusal never reaches.
  const statePath = path.join(tmpDir, "accounts-state.json");
  assert.equal(fs.existsSync(statePath), false, "Oversized prompt must not create leases/state");

  // Under the limit passes through to the normal (FAKE) path.
  sendReq({
    jsonrpc: "2.0",
    id: 4,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "short ok" }] },
  });
  const r4 = await waitForResponse(4);
  assert.equal(r4.result?.stopReason, "end_turn");

  serverProc.stdin.end();
  await new Promise((resolve) => serverProc.on("exit", resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
