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
  pickBackendFromState,
  getAccountPriority,
  getAccountTier,
  MODELS,
  slog,
  reapOrphanAcpServers,
  checkStaleCode,
  isBbSystemInstructionsBlock,
} from "../acp-server.mjs";

const require = createRequire(import.meta.url);
const driver = require("../src/gemini-driver.js");
const usageLimitsModule = require("../src/usage-limits.js");
const {
  selectModelAndThinking,
  ModelUnavailable,
  RESET_REGEX_EXTENDED,
  waitForHistoryStabilization,
  findTurnTarget,
  parseUsageLimits,
  extractWrbFrames,
  updateAccountUsage,
  readAccountsUsage,
  captureUsageLimits,
  sendPrompt,
  _setDriverHooks,
  menuItemHasLockIcon,
  upsellDialogConfirmsLock,
  markVisibleDialogs,
} = driver;
const { withUsageLock, KNOWN_CANDIDATE_RPCIDS } = usageLimitsModule;

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

  // Model locked (paid upgrade required): rotatable, zero cooldown, records lockedModel
  const errCarbonLocked = new ModelUnavailable("model", "carbon locked: paid upgrade required");
  errCarbonLocked.isLocked = true;
  errCarbonLocked.lockedModel = "carbon";
  const cCarbonLocked = classifyFailure(errCarbonLocked);
  assert.equal(cCarbonLocked.category, "model-locked");
  assert.equal(cCarbonLocked.rotatable, true);
  assert.equal(cCarbonLocked.cooldownMs, 0);
  assert.equal(cCarbonLocked.lockedModel, "carbon");
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

  // Test locked Carbon model (lock icon) rejection without clicking
  let clickedLocked = false;
  const mockPageLocked = {
    $: async () => null,
    $$: async () => [
      {
        innerText: async () => "Самые сложные задачи\n4 Carbon",
        evaluate: async (fn) => {
          const fakeEl = {
            querySelectorAll: () => [
              {
                innerText: "lock",
                getAttribute: () => "lock",
                className: "mat-icon",
              },
            ],
            hasAttribute: () => false,
            getAttribute: () => null,
            classList: { contains: () => false },
          };
          try {
            return fn(fakeEl);
          } catch {
            return false;
          }
        },
        click: async () => {
          clickedLocked = true;
        },
      },
    ],
    waitForSelector: async () => ({
      innerText: async () => "Hydrogen",
      getAttribute: () => "Hydrogen",
      click: async () => {},
    }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };

  await assert.rejects(
    async () => {
      await selectModelAndThinking(mockPageLocked, "carbon", null, true);
    },
    (err) => {
      assert.ok(err instanceof ModelUnavailable);
      assert.equal(err.isLocked, true);
      assert.equal(err.lockedModel, "carbon");
      assert.match(err.message, /carbon locked: paid upgrade required/i);
      return true;
    }
  );
  assert.equal(clickedLocked, false, "Locked model item must not be clicked");

  // Test resolveModelId for aliases and official labels
  const { resolveModelId } = await import("../acp-server.mjs");
  assert.equal(resolveModelId("argon"), "argon");
  assert.equal(resolveModelId("Gemini 4 Argon"), "argon");
  assert.equal(resolveModelId("carbon"), "carbon");
  assert.equal(resolveModelId("Gemini 4 Carbon"), "carbon");
  assert.equal(resolveModelId("hydrogen"), "hydrogen");
  assert.equal(resolveModelId("Gemini 4 Hydrogen"), "hydrogen");
  assert.equal(resolveModelId("pro"), "pro");
  assert.equal(resolveModelId("Gemini 3.1 Pro"), "pro");
  assert.equal(resolveModelId("flash-lite"), "flash-lite");
  assert.equal(resolveModelId("Gemini 3.5 Flash-Lite"), "flash-lite");
  assert.equal(resolveModelId("fast"), "flash-lite");
  assert.equal(resolveModelId("flash"), "flash-lite");
  assert.equal(resolveModelId("unknown-xyz"), null);

  // Test successful selection of argon in Russian UI
  let clickedArgon = false;
  const mockPageArgon = {
    $: async () => null,
    $$: async () => [
      {
        innerText: async () => "Код и анализ\n4 Argon",
        evaluate: async () => false,
        click: async () => { clickedArgon = true; },
      },
    ],
    evaluate: async () => false,
    waitForSelector: async () => ({
      innerText: async () => "3.5 Flash-Lite",
      getAttribute: async () => "3.5 Flash-Lite",
      click: async () => {},
    }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };
  await selectModelAndThinking(mockPageArgon, "argon", null, true);
  assert.equal(clickedArgon, true, "Argon in Russian UI must be clicked when requested");

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
  assert.ok(sessionId.startsWith(`argon-${serverProc.pid}-`));
  sendReq({ jsonrpc: "2.0", id: 22, method: "session/new", params: { cwd: "/tmp" } });
  const r22 = await waitForResponse(22);
  assert.ok(r22.result.sessionId.startsWith(`argon-${serverProc.pid}-`));
  assert.notEqual(r22.result.sessionId, sessionId);
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
  assert.ok(modelIds.includes("carbon"));
  assert.ok(modelIds.includes("hydrogen"));
  assert.ok(modelIds.includes("pro"));
  assert.ok(modelIds.includes("flash-lite"));
  assert.equal(
    r2.result.models.availableModels.find((m) => m.modelId === "argon")?.name,
    "Gemini 4 Argon"
  );
  assert.equal(
    r2.result.models.availableModels.find((m) => m.modelId === "carbon")?.name,
    "Gemini 4 Carbon"
  );
  assert.equal(
    r2.result.models.availableModels.find((m) => m.modelId === "hydrogen")?.name,
    "Gemini 4 Hydrogen"
  );
  assert.equal(
    r2.result.models.availableModels.find((m) => m.modelId === "flash-lite")?.name,
    "Gemini 3.5 Flash-Lite"
  );
  const proModel = r2.result.models.availableModels.find((m) => m.modelId === "pro");
  assert.equal(proModel?.name, "Gemini 3.1 Pro");
  assert.equal(
    MODELS.find((m) => m.value === "pro")?.name,
    "Gemini 3.1 Pro"
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

  // Verify non-argon/non-carbon model updates thought_level to high cleanly
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
  const thoughtOpt402 = r402.result.configOptions.find((o) => o.id === "thought_level");
  assert.equal(thoughtOpt402?.currentValue, "high", "thought_level must update to high");

  // Verify carbon model supports custom thought_level without model overwrite
  sendReq({
    jsonrpc: "2.0",
    id: 403,
    method: "session/set_model",
    params: { sessionId, modelId: "carbon" },
  });
  const r403 = await waitForResponse(403);
  const modelOpt403 = r403.result.configOptions.find((o) => o.id === "model");
  assert.equal(modelOpt403?.currentValue, "carbon");

  sendReq({
    jsonrpc: "2.0",
    id: 404,
    method: "session/set_config_option",
    params: { sessionId, configId: "thought_level", value: "low" },
  });
  const r404 = await waitForResponse(404);
  const modelOpt404 = r404.result.configOptions.find((o) => o.id === "model");
  const thoughtOpt404 = r404.result.configOptions.find((o) => o.id === "thought_level");
  assert.equal(modelOpt404?.currentValue, "carbon", "Carbon model must be preserved when thought_level changes");
  assert.equal(thoughtOpt404?.currentValue, "low", "Carbon thought_level must update to low");

  // Reset back to argon for the rest of the test
  sendReq({
    jsonrpc: "2.0",
    id: 405,
    method: "session/set_model",
    params: { sessionId, modelId: "argon" },
  });
  await waitForResponse(405);

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
  const r2 = await waitForResponse(2);
  const sessionId = r2.result.sessionId;
  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId,
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

test("9. Smart model routing: pickBackendFromState prioritizes pro accounts for argon and ultra for carbon", () => {
  const testBackends = [
    { id: "pro-1", priority: 10, tier: "pro", cdp: "9222" },
    { id: "pro-2", priority: 10, tier: "pro", cdp: "9223" },
    { id: "ultra-1", priority: 10, tier: "ultra", cdp: "9224" },
  ];

  const fakeState = {
    accounts: {
      "pro-1": {
        cooldownUntilMs: 0,
        lastUsedMs: 100,
        lastError: null,
        lockedModels: ["carbon"],
      },
      "pro-2": {
        cooldownUntilMs: 0,
        lastUsedMs: 200,
        lastError: null,
        lockedModels: ["carbon"],
      },
      "ultra-1": {
        cooldownUntilMs: 0,
        lastUsedMs: 50,
        lastError: null,
      },
    },
    leases: {},
  };

  // For argon: pro accounts (pro-1, pro-2) are prioritized over ultra (ultra-1) to reserve ultra for carbon!
  // Between pro-1 (100) and pro-2 (200), pro-1 is least recently used
  const argonPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "argon", testBackends);
  assert.ok(argonPick.backend, "Should pick a backend for argon");
  assert.equal(argonPick.backend.id, "pro-1", "Argon should pick pro tier account first");

  // When pro-1 is busy, argon picks pro-2 (the remaining pro account)
  fakeState.accounts["pro-1"].inUseUntilMs = Date.now() + 60000;
  fakeState.accounts["pro-1"].owner = "other-process";
  const argonPick2 = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "argon", testBackends);
  assert.ok(argonPick2.backend, "Should pick pro-2 for argon when pro-1 is busy");
  assert.equal(argonPick2.backend.id, "pro-2");

  // When both pro accounts are busy, argon falls back to ultra (ultra-1)
  fakeState.accounts["pro-2"].inUseUntilMs = Date.now() + 60000;
  fakeState.accounts["pro-2"].owner = "other-process";
  const argonPick3 = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "argon", testBackends);
  assert.ok(argonPick3.backend, "Should fall back to ultra account for argon when all pro accounts are busy");
  assert.equal(argonPick3.backend.id, "ultra-1");

  // Reset pro accounts
  fakeState.accounts["pro-1"].inUseUntilMs = 0;
  fakeState.accounts["pro-1"].owner = null;
  fakeState.accounts["pro-2"].inUseUntilMs = 0;
  fakeState.accounts["pro-2"].owner = null;

  // When requesting carbon: only ultra accounts (ultra-1) are eligible.
  // pro-1 and pro-2 are skipped (pro tier and locked).
  // If ultra-1 is leased, it returns busyUntil
  fakeState.accounts["ultra-1"].inUseUntilMs = Date.now() + 60000;
  fakeState.accounts["ultra-1"].owner = "other-process";
  const carbonBusy = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "carbon", testBackends);
  assert.ok(carbonBusy.busyUntil, "Should return busyUntil for carbon when only ultra-1 supports it and is busy");

  // Release ultra-1: carbon immediately routes to ultra-1
  fakeState.accounts["ultra-1"].inUseUntilMs = 0;
  fakeState.accounts["ultra-1"].owner = null;
  const carbonPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "carbon", testBackends);
  assert.ok(carbonPick.backend, "Should pick ultra-1 for carbon");
  assert.equal(carbonPick.backend.id, "ultra-1");

  // If ultra-1 also gets carbon locked (e.g. lock icon detected, downgraded to pro), pickBackendFromState returns none
  fakeState.accounts["ultra-1"].lockedModels = ["carbon"];
  const nonePick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "carbon", testBackends);
  assert.equal(nonePick.none, true, "Must return none when all candidates have carbon locked");

  // Priority tests:
  // 1. Equal priority (all 10): "при прочих равных" Pro accounts are preferred for Argon over Ultra (Ultra in end)
  fakeState.accounts["ultra-1"].lockedModels = [];
  fakeState.accounts["ultra-1"].priority = 10;
  fakeState.accounts["pro-1"].priority = 10;
  fakeState.accounts["pro-2"].priority = 10;
  fakeState.accounts["ultra-1"].lastUsedMs = 10; // ultra-1 has lowest lastUsedMs
  fakeState.accounts["pro-1"].lastUsedMs = 100;
  fakeState.accounts["pro-2"].lastUsedMs = 200;
  const equalPrioPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "argon", testBackends);
  assert.equal(equalPrioPick.backend.id, "pro-1", "Equal priority should still prioritize pro account over ultra for argon");

  // 2. Explicit priority ladder: higher priority picked first regardless of lastUsedMs
  fakeState.accounts["pro-2"].priority = 20; // pro-2 has priority 20
  const higherPrioPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "argon", testBackends);
  assert.equal(higherPrioPick.backend.id, "pro-2", "Priority 20 must beat priority 10");

  // 3. Priority 0: account is disabled and never picked
  fakeState.accounts["pro-2"].priority = 0;
  fakeState.accounts["pro-1"].priority = 0;
  // Now only ultra-1 is left (> 0)
  const onlyUltraPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "argon", testBackends);
  assert.equal(onlyUltraPick.backend.id, "ultra-1", "Priority 0 accounts must be ignored, picking remaining account");

  fakeState.accounts["ultra-1"].priority = 0;
  const zeroPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "argon", testBackends);
  assert.equal(zeroPick.none, true, "When all accounts have priority 0, pickBackendFromState returns none");
});

test("10. acp-server slog and lifecycle guards, driver :visible and RU selectors", async () => {
  // 1. slog writes to acp-server.log under STATE_DIR
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon-slog-test-")));
  process.env.ARGON_STATE_DIR = tmpDir;
  slog("test:stage", { foo: "bar" });
  const logFile = path.join(tmpDir, "acp-server.log");
  assert.ok(fs.existsSync(logFile), "acp-server.log must be created");
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.match(logContent, /test:stage \{"foo":"bar"\}/);

  // 2. reapOrphanAcpServers safely executes on linux
  const reaped = reapOrphanAcpServers();
  assert.equal(typeof reaped, "number");

  // 3. Driver :visible and RU selectors
  const driverSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "src/gemini-driver.js"), "utf8");
  assert.ok(
    driverSrc.includes("gem-menu-item[data-mode-id]:visible"),
    "driver must prioritize gem-menu-item[data-mode-id]:visible in openMenu / isMenuOpen"
  );
  assert.ok(
    driverSrc.includes("local-images-files-uploader-button"),
    "driver must check local-images-files-uploader-button first in attachFile"
  );
  assert.ok(
    driverSrc.includes("Загрузить файлы"),
    "driver must support RU 'Загрузить файлы' in attachFile"
  );
  assert.ok(
    driverSrc.includes("Удалить"),
    "driver must support RU 'Удалить' in delete conversation"
  );
});

test("11. parseUsageLimits parses batchexecute wrb.fr frames and handles self-healing recipe rpcid", () => {
  // 0. Verify candidate rpcids list
  assert.ok(Array.isArray(KNOWN_CANDIDATE_RPCIDS), "KNOWN_CANDIDATE_RPCIDS must be an array");
  assert.ok(KNOWN_CANDIDATE_RPCIDS.includes("jSf9Qc"), "KNOWN_CANDIDATE_RPCIDS must contain default rpcid jSf9Qc");
  assert.ok(KNOWN_CANDIDATE_RPCIDS.includes("kAb7Z"), "KNOWN_CANDIDATE_RPCIDS must contain candidate kAb7Z");

  // 1. Standard fixture with default rpcid jSf9Qc
  const snippetStandard = `)]}'\n\n162\n[["wrb.fr","jSf9Qc","[null,[[1,0.25,1,[[1763350000,0]]],[2,0.6,2,[[1763950000,0]]]]]",null,null,null,"generic"]]\n`;
  const resStandard = parseUsageLimits(snippetStandard);
  assert.ok(resStandard !== null);
  assert.equal(resStandard.workingRpcid, "jSf9Qc");
  assert.deepEqual(resStandard.daily, { percent: 25, resetEpochSec: 1763350000 });
  assert.deepEqual(resStandard.weekly, { percent: 60, resetEpochSec: 1763950000 });

  // 2. Self-healing recipe with alternative rpcid
  const snippetHealed = `)]}'\n\n162\n[["wrb.fr","kAb7Z","[null,[[1,0.12,1,[[1763354000,0]]],[2,0.85,2,[[1763954000,0]]]]]",null,null,null,"generic"]]\n`;
  const resHealed = parseUsageLimits(snippetHealed);
  assert.ok(resHealed !== null);
  assert.equal(resHealed.workingRpcid, "kAb7Z");
  assert.deepEqual(resHealed.daily, { percent: 12, resetEpochSec: 1763354000 });
  assert.deepEqual(resHealed.weekly, { percent: 85, resetEpochSec: 1763954000 });

  // 3. Over-quota usage (> 1.0, e.g. 1.25 -> 125%)
  const snippetOverQuota = `)]}'\n[["wrb.fr","jSf9Qc","[null,[[1,1.25,1,[[1763350000,0]]],[2,0.5,2,[[1763950000,0]]]]]",null,null,null,"generic"]]`;
  const resOverQuota = parseUsageLimits(snippetOverQuota);
  assert.equal(resOverQuota.daily.percent, 125);

  // 4. Multiple envelopes, metrics in second frame
  const snippetMulti = `)]}'\n\n40\n[["wrb.fr","otherRpc","[null]",null,null,null,"generic"]]\n162\n[["wrb.fr","jSf9Qc","[null,[[1,0.3,1,[[1763350000,0]]],[2,0.7,2,[[1763950000,0]]]]]",null,null,null,"generic"]]\n`;
  const resMulti = parseUsageLimits(snippetMulti);
  assert.ok(resMulti !== null);
  assert.equal(resMulti.workingRpcid, "jSf9Qc");
  assert.equal(resMulti.daily.percent, 30);
  assert.equal(resMulti.weekly.percent, 70);

  // 5. Invalid / non-metric inputs
  assert.equal(parseUsageLimits(""), null);
  assert.equal(parseUsageLimits(")]}'\n"), null);
  assert.equal(parseUsageLimits(")]}'\n40\n[[\"di\",45]]\n"), null);
  assert.equal(parseUsageLimits("invalid non-json text"), null);
});

test("12. accounts-usage.json multi-process merge logic and atomic file updates", async () => {
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "usage-merge-test-")));

  // Initial write for acc1
  const u1 = {
    daily: { percent: 15, resetEpochSec: 1763350000 },
    weekly: { percent: 45, resetEpochSec: 1763950000 },
    tier: "pro",
  };
  const r1 = { rpcid: "jSf9Qc", args: "[]" };
  const d1 = await updateAccountUsage(tmpDir, "acc1", u1, r1);

  assert.ok(d1.accounts.acc1);
  assert.deepEqual(d1.accounts.acc1.daily, u1.daily);
  assert.deepEqual(d1.accounts.acc1.weekly, u1.weekly);
  assert.equal(d1.accounts.acc1.tier, "pro");
  assert.equal(d1.accounts.acc1.stale, false);
  assert.equal(d1.recipe.rpcid, "jSf9Qc");

  // Subsequent write for acc2 (multi-process pool simulation: does NOT overwrite acc1)
  const u2 = {
    daily: { percent: 50, resetEpochSec: 1763360000 },
    weekly: { percent: 80, resetEpochSec: 1763960000 },
    tier: "ultra",
  };
  const d2 = await updateAccountUsage(tmpDir, "acc2", u2, r1);

  assert.ok(d2.accounts.acc1, "acc1 must be preserved when acc2 is updated");
  assert.ok(d2.accounts.acc2, "acc2 must be present");
  assert.equal(d2.accounts.acc1.tier, "pro");
  assert.equal(d2.accounts.acc2.tier, "ultra");

  // Read back via readAccountsUsage
  const onDisk = readAccountsUsage(tmpDir);
  assert.equal(Object.keys(onDisk.accounts).length, 2);
  assert.equal(onDisk.recipe.rpcid, "jSf9Qc");

  // Update recipe self-healing: rpcid changes to kAb7Z
  const r2 = { rpcid: "kAb7Z", args: "[]" };
  const d3 = await updateAccountUsage(tmpDir, "acc1", { ...u1, daily: { percent: 20, resetEpochSec: 1763351000 } }, r2);
  assert.equal(d3.recipe.rpcid, "kAb7Z");
  assert.equal(d3.accounts.acc1.daily.percent, 20);
  assert.equal(d3.accounts.acc2.daily.percent, 50);

  // Partial merge: update with only weekly record preserves existing daily and protects ultra tier
  const uPart = {
    daily: null,
    weekly: { percent: 90, resetEpochSec: 1763990000 },
    tier: "pro", // acc2 was previously ultra; DOM miss should not downgrade
  };
  const d4 = await updateAccountUsage(tmpDir, "acc2", uPart, r2);
  assert.equal(d4.accounts.acc2.daily.percent, 50, "Existing daily metric must be preserved on partial update");
  assert.equal(d4.accounts.acc2.weekly.percent, 90, "Weekly metric must be updated");
  assert.equal(d4.accounts.acc2.tier, "ultra", "Ultra tier must NOT be downgraded to pro on fallback tier");

  // Lock token race prevention: lock is only unlinked if token matches
  const customLock = path.join(tmpDir, "race-test.lock");
  await withUsageLock(customLock, async () => {
    assert.ok(fs.existsSync(customLock));
    // Simulate another process stealing the lock and putting its own token
    fs.writeFileSync(customLock, "foreign-pid:99999:other-token");
  });
  // The foreign token lock must NOT have been unlinked by the original holder's finally block
  assert.ok(fs.existsSync(customLock), "Foreign lock token must NOT be deleted by a prior lock holder");
  assert.equal(fs.readFileSync(customLock, "utf8").trim(), "foreign-pid:99999:other-token");
  fs.unlinkSync(customLock);

  // Concurrency test: simulate 10 parallel updates across different accounts
  const promises = [];
  for (let i = 0; i < 10; i++) {
    const accId = `worker-${i}`;
    promises.push(
      updateAccountUsage(tmpDir, accId, {
        daily: { percent: i * 10, resetEpochSec: 1763350000 + i },
        weekly: { percent: i * 10, resetEpochSec: 1763950000 + i },
        tier: i % 2 === 0 ? "ultra" : "pro",
      }, r2)
    );
  }
  await Promise.all(promises);

  const finalCheck = readAccountsUsage(tmpDir);
  assert.ok(finalCheck.accounts.acc1);
  assert.ok(finalCheck.accounts.acc2);
  for (let i = 0; i < 10; i++) {
    assert.ok(finalCheck.accounts[`worker-${i}`], `worker-${i} must exist after concurrent updates`);
  }
});

test("13. captureUsageLimits domain gating, evaluate execution, and throttling", async () => {
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "usage-capture-test-")));

  // 1. Tab not on gemini.google.com -> skips evaluate and returns null
  let evalCalled = false;
  const mockBlankPage = {
    url: () => "about:blank",
    evaluate: async () => {
      evalCalled = true;
      return {};
    },
  };
  const blankRes = await captureUsageLimits(mockBlankPage, { stateDir: tmpDir, accountId: "test-acc-1" });
  assert.equal(blankRes, null);
  assert.equal(evalCalled, false, "evaluate must NOT be called when url is about:blank");

  // 2. Tab on gemini.google.com -> executes evaluate and captures usage
  const mockGeminiPage = {
    url: () => "https://gemini.google.com/app",
    evaluate: async () => {
      evalCalled = true;
      return {
        text: `)]}'\n[["wrb.fr","jSf9Qc","[null,[[1,0.35,1,[[1763350000,0]]],[2,0.75,2,[[1763950000,0]]]]]",null,null,null,"generic"]]`,
        domTier: "ultra",
      };
    },
  };

  const capRes = await captureUsageLimits(mockGeminiPage, {
    stateDir: tmpDir,
    accountId: "test-acc-1",
    force: true,
  });
  assert.ok(capRes !== null);
  assert.equal(evalCalled, true);
  assert.equal(capRes.accounts["test-acc-1"].daily.percent, 35);
  assert.equal(capRes.accounts["test-acc-1"].weekly.percent, 75);
  assert.equal(capRes.accounts["test-acc-1"].tier, "ultra");

  // 3. Throttling: second call without force within ARGON_USAGE_REFRESH_MS returns null
  evalCalled = false;
  const throttledRes = await captureUsageLimits(mockGeminiPage, {
    stateDir: tmpDir,
    accountId: "test-acc-1",
    force: false,
  });
  assert.equal(throttledRes, null, "Call within refresh interval must be throttled");
  assert.equal(evalCalled, false, "evaluate must NOT be called when throttled");

  // 4. Force bypasses throttle
  const forcedRes = await captureUsageLimits(mockGeminiPage, {
    stateDir: tmpDir,
    accountId: "test-acc-1",
    force: true,
  });
  assert.ok(forcedRes !== null, "force: true must bypass throttle");
  assert.equal(evalCalled, true);

  // 5. Candidate rpcid batching & self-healing in evaluate
  let receivedEvalArgs = null;
  const mockCandidatesPage = {
    url: () => "https://gemini.google.com/app",
    evaluate: async (fn, arg) => {
      receivedEvalArgs = arg;
      return {
        text: `)]}'\n[["wrb.fr","kAb7Z","[null,[[1,0.4,1,[[1763350000,0]]],[2,0.8,2,[[1763950000,0]]]]]",null,null,null,"generic"]]`,
        domTier: "ultra",
      };
    },
  };
  const candRes = await captureUsageLimits(mockCandidatesPage, {
    stateDir: tmpDir,
    accountId: "test-cand",
    force: true,
  });
  assert.ok(candRes !== null);
  assert.ok(Array.isArray(receivedEvalArgs.candidates), "evaluate must receive candidates array");
  assert.ok(receivedEvalArgs.candidates.includes("jSf9Qc"), "candidates must contain jSf9Qc");
  assert.ok(receivedEvalArgs.candidates.includes("kAb7Z"), "candidates must contain kAb7Z");
  assert.equal(candRes.recipe.rpcid, "kAb7Z", "Recipe must be healed to kAb7Z from candidate frame");

  // 6. Evaluate rejection / timeout handling (returns null, does not throw)
  const mockErrPage = {
    url: () => "https://gemini.google.com/app",
    evaluate: async () => {
      throw new Error("CDP evaluate execution failed: page closed");
    },
  };
  const errRes = await captureUsageLimits(mockErrPage, {
    stateDir: tmpDir,
    accountId: "test-err",
    force: true,
  });
  assert.equal(errRes, null, "Evaluate error must return null without throwing");
});

test("14. sendPrompt signature, opts hygiene, mock integration with captureUsageLimits, and backend.tier propagation", async () => {
  const driverSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "src/gemini-driver.js"), "utf8");

  // 1. Smoke checks: sendPrompt signature and opts.* hygiene
  assert.ok(driverSrc.includes("backend = null"), "sendPrompt must accept backend parameter");
  assert.ok(driverSrc.includes("accountId = null"), "sendPrompt must accept accountId parameter");
  assert.ok(driverSrc.includes("tier = null"), "sendPrompt must accept tier parameter");
  assert.ok(driverSrc.includes("stateDir = null"), "sendPrompt must accept stateDir parameter");

  const sendPromptMatch = driverSrc.match(/async function sendPrompt\(\{[\s\S]*?\}\) \{([\s\S]*?)\nasync function dismissOverlays/);
  assert.ok(sendPromptMatch, "sendPrompt function body must be found");
  const sendPromptBody = sendPromptMatch[1];
  assert.equal(sendPromptBody.includes("opts."), false, "sendPrompt body must not contain opts.* references");

  // 2. Integration test: sendPrompt with mock dependencies reaches captureUsageLimits
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "sendprompt-usage-test-")));
  let closedBrowser = false;
  let parkedBlank = false;

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({
      close: async () => { closedBrowser = true; },
    }),
    getGeminiPage: async () => ({
      url: () => "https://gemini.google.com/app",
      goto: async (url) => { if (url === "about:blank") parkedBlank = true; },
      evaluate: async () => ({
        text: `)]}'\n[["wrb.fr","jSf9Qc","[null,[[1,0.35,1,[[1763350000,0]]],[2,0.75,2,[[1763950000,0]]]]]",null,null,null,"generic"]]`,
        domTier: "ultra",
      }),
    }),
    runTurn: async () => ({
      text: "Integration test reply text",
      convId: "conv-int-test-1",
    }),
  });

  try {
    const res = await sendPrompt({
      prompt: "hello test",
      backend: { id: "test-pool-acc", tier: "ultra" },
      accountId: "test-pool-acc",
      tier: "ultra",
      stateDir: tmpDir,
    });

    assert.equal(String(res), "Integration test reply text");
    assert.equal(res.convId, "conv-int-test-1");
    assert.equal(closedBrowser, true, "Browser must be closed in finally");
    assert.equal(parkedBlank, true, "Tab must be parked on about:blank in finally");

    const usageData = readAccountsUsage(tmpDir);
    assert.ok(usageData.accounts["test-pool-acc"], "accounts-usage.json must record test-pool-acc");
    assert.equal(usageData.accounts["test-pool-acc"].daily.percent, 35);
    assert.equal(usageData.accounts["test-pool-acc"].weekly.percent, 75);
    assert.equal(usageData.accounts["test-pool-acc"].tier, "ultra");
  } finally {
    _setDriverHooks(null);
  }

  // 3. Tier propagation in loadBackends from pool.json and fallbacks
  const poolTmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "backends-tier-test-")));
  const poolFile = path.join(poolTmpDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        { id: "acc-ultra", cdpPort: 9223, tier: "ultra" },
        { id: "acc-pro", cdpPort: 9224, tier: "pro" },
        { id: "acc-notier", cdpPort: 9225 },
      ],
    })
  );

  const backends = loadBackends(poolTmpDir, poolFile);
  const byId = new Map(backends.map((b) => [b.id, b]));
  assert.equal(byId.get("acc-ultra")?.tier, "ultra");
  assert.equal(byId.get("acc-pro")?.tier, "pro");
  assert.equal(byId.get("acc-notier")?.tier, null);

  // Fallback compatibility accounts/<label>/backend.json
  const fallbackAccountsDir = path.join(poolTmpDir, "accounts", "acc-compat");
  fs.mkdirSync(fallbackAccountsDir, { recursive: true });
  fs.writeFileSync(
    path.join(fallbackAccountsDir, "backend.json"),
    JSON.stringify({ cdp: 9226, tier: "ultra" })
  );
  const fallbackBackends = loadBackends(poolTmpDir, path.join(poolTmpDir, "no-pool.json"));
  const fallbackById = new Map(fallbackBackends.map((b) => [b.id, b]));
  assert.equal(fallbackById.get("acc-compat")?.tier, "ultra");

  // 4. Rate-limit / failed turn: captureUsageLimits executes in finally before parking
  const failedTurnTmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "sendprompt-failed-test-")));
  let failedParkedBlank = false;
  let failedClosedBrowser = false;

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({
      close: async () => { failedClosedBrowser = true; },
    }),
    getGeminiPage: async () => ({
      url: () => "https://gemini.google.com/app",
      goto: async (url) => { if (url === "about:blank") failedParkedBlank = true; },
      evaluate: async () => ({
        text: `)]}'\n[["wrb.fr","jSf9Qc","[null,[[1,0.99,1,[[1763350000,0]]],[2,0.95,2,[[1763950000,0]]]]]",null,null,null,"generic"]]`,
        domTier: "pro",
      }),
    }),
    runTurn: async () => {
      const err = new ModelUnavailable("thinking", "high thinking level is rate-limited (Limit resets 2:19 AM)");
      throw err;
    },
  });

  try {
    await assert.rejects(
      async () => {
        await sendPrompt({
          prompt: "test rate-limited prompt",
          backend: { id: "rate-limited-acc", tier: "pro" },
          accountId: "rate-limited-acc",
          tier: "pro",
          stateDir: failedTurnTmpDir,
        });
      },
      (err) => {
        assert.ok(err instanceof ModelUnavailable);
        assert.ok(err.message.includes("rate-limited"));
        return true;
      }
    );

    assert.equal(failedParkedBlank, true, "Tab must be parked on about:blank even when turn failed");
    assert.equal(failedClosedBrowser, true, "Browser must be closed in finally even when turn failed");

    const failedUsageData = readAccountsUsage(failedTurnTmpDir);
    assert.ok(failedUsageData.accounts["rate-limited-acc"], "accounts-usage.json must record rate-limited account in finally");
    assert.equal(failedUsageData.accounts["rate-limited-acc"].daily.percent, 99);
    assert.equal(failedUsageData.accounts["rate-limited-acc"].weekly.percent, 95);
  } finally {
    _setDriverHooks(null);
  }

  // 5. Hung captureUsageLimits timeout: ARGON_USAGE_TIMEOUT_MS ensures prompt does not hang
  const timeoutTmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "sendprompt-timeout-test-")));
  process.env.ARGON_USAGE_TIMEOUT_MS = "50";

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({
      close: async () => {},
    }),
    getGeminiPage: async () => ({
      url: () => "https://gemini.google.com/app",
      goto: async () => {},
      evaluate: async () => new Promise((resolve) => setTimeout(resolve, 5000)),
    }),
    runTurn: async () => ({
      text: "Prompt finished before hung usage capture",
      convId: "conv-timeout-1",
    }),
  });

  try {
    const res = await sendPrompt({
      prompt: "test prompt with slow limits capture",
      backend: { id: "timeout-acc", tier: "pro" },
      accountId: "timeout-acc",
      tier: "pro",
      stateDir: timeoutTmpDir,
    });
    assert.equal(String(res), "Prompt finished before hung usage capture");
  } finally {
    delete process.env.ARGON_USAGE_TIMEOUT_MS;
    _setDriverHooks(null);
  }
});

test("15. PLUG-280 model↔account selector filtering and incompatibility resets", async () => {
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon-compat-test-")));
  const poolFile = path.join(tmpDir, "pool.json");
  const statePath = path.join(tmpDir, "accounts-state.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        { id: "pro-1", email: "pro1@example.com", profileDir: path.join(tmpDir, "p1"), cdpPort: 9222, priority: 10, tier: "pro" },
        { id: "ultra-1", email: "ultra1@example.com", profileDir: path.join(tmpDir, "p2"), cdpPort: 9223, priority: 10, tier: "ultra" },
        { id: "ultra-2", email: "ultra2@example.com", profileDir: path.join(tmpDir, "p3"), cdpPort: 9224, priority: 10, tier: "ultra" },
      ],
    })
  );

  const serverProc = spawnServer({
    ...process.env,
    ARGON_FAKE: "1",
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

  const optById = (r, id) => r.result.configOptions.find((o) => o.id === id);
  const values = (o) => (o?.options || []).map((x) => x.value);
  const writeState = (accounts) =>
    fs.writeFileSync(statePath, JSON.stringify({ accounts, leases: {} }) + "\n");

  sendReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await waitForResponse(1);
  sendReq({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
  const r2 = await waitForResponse(2);
  const sessionId = r2.result.sessionId;

  // Baseline: model argon is supported everywhere — all accounts listed, all 5 models.
  assert.deepEqual(values(optById(r2, "account")), ["auto", "pro-1", "ultra-1", "ultra-2"]);
  assert.equal(optById(r2, "account").currentValue, "auto");
  assert.deepEqual(values(optById(r2, "model")), ["argon", "carbon", "hydrogen", "pro", "flash-lite"]);

  // Case 1: carbon + exactly one capable ultra (ultra-2 has carbon locked)
  // → account list [auto, ultra-1], currentValue "ultra-1" (single-capable rule).
  writeState({ "ultra-2": { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, lockedModels: ["carbon"] } });
  sendReq({ jsonrpc: "2.0", id: 3, method: "session/set_model", params: { sessionId, modelId: "carbon" } });
  const r3 = await waitForResponse(3);
  assert.deepEqual(values(optById(r3, "account")), ["auto", "ultra-1"], "Only the carbon-capable ultra account must be listed");
  assert.equal(optById(r3, "account").currentValue, "ultra-1", "Single capable account must surface as currentValue");
  assert.ok(values(optById(r3, "model")).includes("carbon"), "auto union must keep carbon while one ultra supports it");

  // Case 2: carbon + two capable ultras → currentValue "auto".
  writeState({});
  sendReq({ jsonrpc: "2.0", id: 4, method: "session/set_config_option", params: { sessionId, configId: "thought_level", value: "medium" } });
  const r4 = await waitForResponse(4);
  assert.deepEqual(values(optById(r4, "account")), ["auto", "ultra-1", "ultra-2"], "pro-1 must be filtered out for carbon");
  assert.equal(optById(r4, "account").currentValue, "auto");

  // Case 5 (runs before 3 to observe the reset): picking a pro account while
  // the model is carbon resets s.model to the "argon" default.
  sendReq({ jsonrpc: "2.0", id: 5, method: "session/set_config_option", params: { sessionId, configId: "account", value: "pro-1" } });
  const r5 = await waitForResponse(5);
  assert.equal(optById(r5, "model").currentValue, "argon", "Incompatible model must reset to argon on account change");
  assert.equal(optById(r5, "account").currentValue, "pro-1");
  assert.deepEqual(values(optById(r5, "account")), ["auto", "pro-1", "ultra-1", "ultra-2"]);

  // Case 3: with a pro account selected, carbon is gone from the model list.
  assert.ok(!values(optById(r5, "model")).includes("carbon"), "carbon must be filtered out on a pro account");
  assert.ok(values(optById(r5, "model")).includes("argon"));

  // Case 6: ultra account selected → all 5 models visible.
  sendReq({ jsonrpc: "2.0", id: 6, method: "session/set_config_option", params: { sessionId, configId: "account", value: "ultra-1" } });
  const r6 = await waitForResponse(6);
  assert.deepEqual(values(optById(r6, "model")), ["argon", "carbon", "hydrogen", "pro", "flash-lite"], "Ultra account must see all models");
  assert.equal(optById(r6, "account").currentValue, "ultra-1");

  // Case 4: switching to carbon while a pro account is explicitly selected
  // resets s.account to "auto" (plus backend/convId).
  sendReq({ jsonrpc: "2.0", id: 7, method: "session/set_config_option", params: { sessionId, configId: "account", value: "pro-1" } });
  await waitForResponse(7);
  sendReq({ jsonrpc: "2.0", id: 8, method: "session/set_model", params: { sessionId, modelId: "carbon" } });
  const r8 = await waitForResponse(8);
  assert.ok(values(optById(r8, "model")).includes("carbon"), "carbon in the union model list proves the account fell back to auto");
  assert.deepEqual(values(optById(r8, "account")), ["auto", "ultra-1", "ultra-2"]);
  assert.equal(optById(r8, "account").currentValue, "auto");

  // Case 7: lockedModels excludes a model from both axes. pro-1 gets hydrogen
  // locked → hydrogen drops out of its model list; pro-1 drops out of the
  // account list while hydrogen is selected.
  writeState({ "pro-1": { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, lockedModels: ["hydrogen"] } });
  sendReq({ jsonrpc: "2.0", id: 9, method: "session/set_model", params: { sessionId, modelId: "hydrogen" } });
  const r9 = await waitForResponse(9);
  assert.ok(!values(optById(r9, "account")).includes("pro-1"), "Account with hydrogen locked must be filtered out");
  assert.deepEqual(values(optById(r9, "account")), ["auto", "ultra-1", "ultra-2"]);
  sendReq({ jsonrpc: "2.0", id: 10, method: "session/set_config_option", params: { sessionId, configId: "account", value: "pro-1" } });
  const r10 = await waitForResponse(10);
  assert.equal(optById(r10, "model").currentValue, "argon", "Locked model must reset to argon");
  assert.ok(!values(optById(r10, "model")).includes("hydrogen"), "lockedModels entry must hide the model");
  assert.ok(!values(optById(r10, "model")).includes("carbon"), "pro tier must still hide carbon");

  serverProc.stdin.end();
  await new Promise((resolve) => serverProc.on("exit", resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("16. PLUG-282: exact lock predicate, upsell CTA gate, and ops unlock", async () => {
  // --- lock-icon predicate on DOM fixtures ---
  const icon = (props = {}) => ({
    offsetParent: {},
    innerText: "",
    className: "",
    getAttribute: () => null,
    ...props,
  });
  const item = (icons) => ({ querySelectorAll: () => icons });

  // Real lock badge → locked (each detection channel).
  assert.equal(menuItemHasLockIcon(item([icon({ innerText: "lock" })])), true, "innerText 'lock'");
  assert.equal(
    menuItemHasLockIcon(item([icon({ getAttribute: (n) => (n === "data-mat-icon-name" ? "lock" : null) })])),
    true,
    "data-mat-icon-name 'lock'"
  );
  assert.equal(
    menuItemHasLockIcon(item([icon({ getAttribute: (n) => (n === "aria-label" ? "Lock" : null) })])),
    true,
    "aria-label 'lock'"
  );
  assert.equal(menuItemHasLockIcon(item([icon({ className: "gem-icon lock" })])), true, "class token 'lock'");
  assert.equal(menuItemHasLockIcon(item([icon({ className: "mat-icon lock-filled" })])), true, "class token 'lock-filled'");

  // Substring traps → NOT locked (the 16.11 false-positive paths).
  assert.equal(menuItemHasLockIcon(item([icon({ className: "mat-icon unlock" })])), false, "'unlock' class");
  assert.equal(menuItemHasLockIcon(item([icon({ className: "mat-icon lock_open" })])), false, "'lock_open' class");
  assert.equal(menuItemHasLockIcon(item([icon({ className: "mat-icon-lock-reset" })])), false, "'mat-icon-lock-reset' class");
  assert.equal(menuItemHasLockIcon(item([icon({ innerText: "lock_open" })])), false, "innerText 'lock_open'");
  assert.equal(
    menuItemHasLockIcon(item([icon({ getAttribute: (n) => (n === "aria-label" ? "unlock" : null) })])),
    false,
    "aria-label 'unlock'"
  );

  // Hidden badge and no-icon items → NOT locked.
  assert.equal(menuItemHasLockIcon(item([icon({ innerText: "lock", offsetParent: null })])), false, "hidden icon");
  assert.equal(menuItemHasLockIcon(item([])), false, "no icons");

  // --- upsell dialog predicate: lock only with an explicit plan-change CTA ---
  const btn = (text, onClick) => ({ innerText: text, click: onClick || (() => {}) });
  const dlg = (buttons, { visible = true, attrs = {} } = {}) => ({
    offsetParent: visible ? {} : null,
    querySelectorAll: () => buttons,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => {
      attrs[n] = v;
    },
  });
  const doc = (dialogs) => ({ querySelectorAll: () => dialogs });

  // Promo popup with price text but no plan-change CTA → NOT a lock, untouched.
  let promoDismissed = false;
  assert.equal(
    upsellDialogConfirmsLock(
      doc([dlg([btn("Попробуйте Pro — 999 ₽/мес"), btn("Не сейчас", () => { promoDismissed = true; })])])
    ),
    false,
    "Promo dialog with price text must not count as a lock"
  );
  assert.equal(promoDismissed, false, "Promo dialog must not be auto-dismissed as a lock");
  assert.equal(
    upsellDialogConfirmsLock(doc([dlg([btn("Подробнее"), btn("Закрыть")])])),
    false,
    "Informational dialog is not a lock"
  );

  // Real upsell with plan-change CTA → lock; the negative button is clicked.
  let dismissed = false;
  assert.equal(
    upsellDialogConfirmsLock(doc([dlg([btn("Сменить план"), btn("Не сейчас", () => { dismissed = true; })])])),
    true,
    "Dialog with 'Сменить план' CTA confirms the lock"
  );
  assert.equal(dismissed, true, "Lock dialog must be dismissed via the negative button");
  assert.equal(
    upsellDialogConfirmsLock(doc([dlg([btn("Сменить план")], { visible: false })])),
    false,
    "Hidden dialog is ignored"
  );

  // Direct-response gate: dialogs already open before the click are marked by
  // markVisibleDialogs and skipped — only a dialog appearing as the click's
  // own response counts (the reviewer's "Upgrade promo" residual FP path).
  const preDlg = dlg([btn("Upgrade"), btn("Не сейчас")]);
  const preDoc = doc([preDlg]);
  assert.equal(markVisibleDialogs(preDoc), 1, "visible pre-click dialog is marked");
  assert.equal(preDlg.getAttribute("data-argon-pre-click"), "1");
  assert.equal(
    upsellDialogConfirmsLock(preDoc),
    false,
    "Pre-existing dialog with a plan CTA is not a click response"
  );
  assert.equal(
    markVisibleDialogs(doc([dlg([btn("Сменить план")], { visible: false })])),
    0,
    "Hidden dialog is not marked — showing it after the click IS a response"
  );
  {
    const savedDoc = globalThis.document;
    delete globalThis.document;
    try {
      assert.equal(markVisibleDialogs(), 0, "No-arg call without a document returns 0, not a crash");
    } finally {
      if (savedDoc === undefined) delete globalThis.document;
      else globalThis.document = savedDoc;
    }
  }

  // Real Playwright calls page.evaluate(fn) with NO argument — the function
  // must take the page's `document` itself, not crash on `undefined`.
  const savedDocument = globalThis.document;
  delete globalThis.document;
  try {
    assert.equal(
      upsellDialogConfirmsLock(),
      false,
      "No-arg call (real page.evaluate path) without a document must return false, not throw"
    );
    globalThis.document = doc([dlg([btn("Сменить план")])]);
    assert.equal(
      upsellDialogConfirmsLock(),
      true,
      "No-arg call must read the dialog from globalThis.document"
    );
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  }

  // --- selectModelAndThinking end-to-end on the same fixtures ---
  const unlockedItemEl = {
    querySelectorAll: () => [icon({ className: "mat-icon unlock" })],
    hasAttribute: () => false,
    getAttribute: () => null,
    classList: { contains: () => false },
  };
  let clickedUnlock = false;
  const mockPageUnlock = {
    $: async () => null,
    $$: async () => [
      {
        innerText: async () => "Код и анализ\n4 Argon",
        evaluate: async (fn) => fn(unlockedItemEl),
        click: async () => { clickedUnlock = true; },
      },
    ],
    evaluate: async () => false,
    waitForSelector: (() => {
      let n = 0;
      return async () => {
        n += 1;
        // First read: another model selected, so the item must be clicked.
        const label = n === 1 ? "3.5 Flash-Lite" : "4 Argon";
        return {
          innerText: async () => label,
          getAttribute: async () => label,
          click: async () => {},
        };
      };
    })(),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };
  await selectModelAndThinking(mockPageUnlock, "argon", null, true);
  assert.equal(clickedUnlock, true, "Item with an 'unlock' class icon must be clicked, not locked");

  // Promo dialog after a click, model not reflected in the picker yet →
  // no lock, no throw.
  let clickedPromo = false;
  const promoDoc = doc([dlg([btn("Попробуйте Ultra — 1999 ₽/мес"), btn("Не сейчас")])]);
  // page.evaluate mocks call fn() with NO args — like real Playwright — and
  // the page `document` is provided via globalThis, as in the browser.
  const mockPagePromo = {
    $: async () => null,
    $$: async () => [
      {
        innerText: async () => "Код и анализ\n4 Argon",
        evaluate: async (fn) =>
          fn({
            querySelectorAll: () => [],
            hasAttribute: () => false,
            getAttribute: () => null,
            classList: { contains: () => false },
          }),
        click: async () => { clickedPromo = true; },
      },
    ],
    evaluate: async (fn) => fn(),
    waitForSelector: async () => ({
      innerText: async () => "3.5 Flash-Lite",
      getAttribute: async () => "3.5 Flash-Lite",
      click: async () => {},
    }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };
  globalThis.document = promoDoc;
  try {
    await selectModelAndThinking(mockPagePromo, "argon", null, true);
  } finally {
    delete globalThis.document;
  }
  assert.equal(clickedPromo, true, "Promo popup after click must not mark the model locked");

  // Plan-change dialog appearing AS the click's response, model not
  // selected → locked. The dialog is pushed into the live doc on click.
  const upsellDialogs = [];
  const upsellDoc = doc(upsellDialogs);
  const mockPageUpsell = {
    ...mockPagePromo,
    $$: async () => [
      {
        innerText: async () => "Код и анализ\n4 Argon",
        evaluate: async (fn) =>
          fn({
            querySelectorAll: () => [],
            hasAttribute: () => false,
            getAttribute: () => null,
            classList: { contains: () => false },
          }),
        click: async () => {
          upsellDialogs.push(dlg([btn("Сменить план"), btn("Не сейчас")]));
        },
      },
    ],
    evaluate: async (fn) => fn(),
  };
  globalThis.document = upsellDoc;
  try {
    await assert.rejects(
      async () => selectModelAndThinking(mockPageUpsell, "argon", null, true),
      (err) => {
        assert.ok(err instanceof ModelUnavailable);
        assert.equal(err.isLocked, true);
        assert.equal(err.lockedModel, "argon");
        return true;
      }
    );
  } finally {
    delete globalThis.document;
  }

  // Promo dialog with a plan CTA that was ALREADY open before the click →
  // marked and skipped; not a click response, so no lock even though the
  // model did not get selected.
  const preDialogs = [dlg([btn("Upgrade"), btn("Не сейчас")])];
  const mockPagePre = {
    ...mockPageUpsell,
    $$: async () => [
      {
        innerText: async () => "Код и анализ\n4 Argon",
        evaluate: async (fn) =>
          fn({
            querySelectorAll: () => [],
            hasAttribute: () => false,
            getAttribute: () => null,
            classList: { contains: () => false },
          }),
        click: async () => {},
      },
    ],
  };
  globalThis.document = doc(preDialogs);
  try {
    await selectModelAndThinking(mockPagePre, "argon", null, true);
  } finally {
    delete globalThis.document;
  }
  assert.equal(
    preDialogs[0].getAttribute("data-argon-pre-click"),
    "1",
    "Pre-existing upsell-looking dialog must be marked and ignored"
  );

  // Model actually selected — an upsell-looking popup alongside is not a
  // lock. First picker read returns the old model (forces the click); the
  // post-click read returns the requested one.
  let pickerCalls = 0;
  const mockPageSelected = {
    ...mockPageUpsell,
    evaluate: async (fn) => fn(),
    waitForSelector: async () => {
      pickerCalls += 1;
      const label = pickerCalls === 1 ? "3.5 Flash-Lite" : "4 Argon";
      return {
        innerText: async () => label,
        getAttribute: async () => label,
        click: async () => {},
      };
    },
  };
  globalThis.document = upsellDoc;
  try {
    await selectModelAndThinking(mockPageSelected, "argon", null, true);
  } finally {
    delete globalThis.document;
  }
  assert.ok(pickerCalls > 1, "post-click picker re-check must have run");

  // --- ops: `node acp-server.mjs unlock <id|all> [model]` clears lockedModels ---
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon-unlock-")));
  const statePath = path.join(tmpDir, "accounts-state.json");
  const writeUnlockState = () =>
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        accounts: {
          "ultra-1": {
            cooldownUntilMs: 123,
            lastUsedMs: 1,
            lastError: null,
            lockedModels: ["carbon"],
            tier: "pro",
            parkedReason: "model-unavailable",
          },
          "pro-1": { cooldownUntilMs: 0, lastUsedMs: 2, lastError: null, lockedModels: ["argon", "hydrogen"] },
        },
        leases: {},
      }) + "\n"
    );
  const unlockEnv = { ...process.env, ARGON_STATE_DIR: tmpDir, ARGON_BACKENDS: "[]" };
  const runUnlock = (args) =>
    execSync(`node acp-server.mjs unlock ${args}`, { cwd: PLUGIN_ROOT, env: unlockEnv, stdio: "pipe" });
  const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));

  writeUnlockState();
  runUnlock("pro-1 argon");
  let st = readState();
  assert.deepEqual(st.accounts["pro-1"].lockedModels, ["hydrogen"], "unlock <id> <model> removes only that model");
  assert.deepEqual(st.accounts["ultra-1"].lockedModels, ["carbon"], "unlock <id> leaves other accounts untouched");

  runUnlock("ultra-1");
  st = readState();
  assert.deepEqual(st.accounts["ultra-1"].lockedModels, [], "unlock <id> clears all lockedModels");
  assert.equal("tier" in st.accounts["ultra-1"], false, "carbon unlock must restore the pool-configured tier");
  assert.equal(st.accounts["ultra-1"].cooldownUntilMs, 123, "unlock must not touch cooldown");
  assert.equal(st.accounts["ultra-1"].parkedReason, "model-unavailable", "unlock must not touch parkedReason");

  runUnlock("all");
  st = readState();
  assert.deepEqual(st.accounts["pro-1"].lockedModels, [], "unlock all clears every account");
});

test("17. PLUG-285: bb <system_instructions> blocks stripped from session/prompt", async () => {
  // Predicate: only a text block whose text STARTS with the marker is bb
  // context; marker inside user text and non-text blocks are untouched.
  assert.equal(
    isBbSystemInstructionsBlock({ type: "text", text: "<system_instructions>\nctx\n</system_instructions>" }),
    true
  );
  assert.equal(
    isBbSystemInstructionsBlock({ type: "text", text: "  \n<system_instructions>x</system_instructions>" }),
    true,
    "leading whitespace before the marker still marks the block"
  );
  assert.equal(
    isBbSystemInstructionsBlock({ type: "text", text: "расскажи про <system_instructions> тег" }),
    false,
    "marker inside user text must not mark the block"
  );
  assert.equal(
    isBbSystemInstructionsBlock({ type: "resource", resource: { text: "<system_instructions>x" } }),
    false,
    "non-text blocks are never stripped"
  );
  assert.equal(isBbSystemInstructionsBlock({ type: "text" }), false);
  assert.equal(isBbSystemInstructionsBlock(null), false);

  // Server path (FAKE): the joined prompt reaching the driver contains only
  // the user text — the ~29KB bb context block is dropped before the join.
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon-strip-test-")));
  const poolFile = path.join(tmpDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        {
          id: "fake-acc-strip",
          email: "strip@example.com",
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

  // Contract: prompt = bb <system_instructions> block + user block (+ a
  // resource block that must pass through untouched) → the driver-facing
  // text is only the user's.
  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "<system_instructions>\nBBCTX_SECRET_MARKER agent context, no tools\n</system_instructions>",
        },
        { type: "text", text: "Найди новости про <system_instructions> тег" },
        { type: "resource", resource: { uri: "file:///tmp/notes.txt", text: "res" } },
      ],
    },
  });
  const r3 = await waitForResponse(3);
  assert.equal(r3.result?.stopReason, "end_turn");

  const chunk = lines.find(
    (l) => l.method === "session/update" && l.params?.update?.sessionUpdate === "agent_message_chunk"
  );
  assert.ok(chunk, "FAKE echo chunk must be emitted");
  const echo = String(chunk.params.update.text ?? chunk.params.update.content?.text ?? "");
  assert.ok(echo.includes("FAKE_ARGON_ECHO"), "echo prefix expected");
  assert.ok(echo.includes("Найди новости"), "user text must reach the driver");
  assert.ok(
    echo.includes("<system_instructions>"),
    "marker inside user text must be preserved, not cut"
  );
  assert.equal(
    echo.includes("BBCTX_SECRET_MARKER"),
    false,
    "bb system_instructions block must not reach the driver"
  );

  // Edge case: prompt containing ONLY the bb context block → empty text →
  // immediate end_turn without touching accounts (same as blank prompt).
  sendReq({
    jsonrpc: "2.0",
    id: 4,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "<system_instructions>\nonly context\n</system_instructions>" }],
    },
  });
  const r4 = await waitForResponse(4);
  assert.equal(r4.result?.stopReason, "end_turn");
  assert.equal(
    lines.filter(
      (l) => l.method === "session/update" && l.params?.update?.sessionUpdate === "agent_message_chunk"
    ).length,
    1,
    "context-only prompt must not produce a second echo chunk"
  );

  serverProc.stdin.end();
  await new Promise((resolve) => serverProc.on("exit", resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
