import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import vm from "node:vm";
import { spawn, spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";

import {
  parseResetTimeMs,
  classifyFailure,
  loadBackends,
  withStateLock,
  loadState,
  modelSupportedOnAccount,
  pickBackendFromState,
  getAccountPriority,
  getAccountTier,
  MODELS,
  slog,
  reapOrphanAcpServers,
  checkStaleCode,
  isBbSystemInstructionsBlock,
  collectUploadFiles,
  pruneDir,
  settleBackend,
  createTaskTurn,
  reapOrphanBrowserGroups,
  cleanupOwnBrowserGroups,
  checkDialogWave,
  _resetDialogWaveHistory,
  getThoughtsLogPath,
  sanitizeUrl,
  sanitizeThoughtString,
  sanitizeThoughtPayload,
  appendThoughtLog,
  runPrompt,
  cancelSession,
  sessions,
  _setOutputHook,
} from "../acp-server.mjs";
import { checkedAnswer } from "../src/inner-context.mjs";

const require = createRequire(import.meta.url);
const driver = require("../src/gemini-driver.js");
const browserGroups = require("../src/browser-groups.cjs");
const usageLimitsModule = require("../src/usage-limits.js");
const {
  selectModelAndThinking,
  ModelUnavailable,
  RESET_REGEX_EXTENDED,
  waitForHistoryStabilization,
  findTurnTarget,
  checkTurnStatus,
  isTurnComplete,
  parseUsageLimits,
  extractWrbFrames,
  updateAccountUsage,
  readAccountsUsage,
  captureUsageLimits,
  sendPrompt,
  _setDriverHooks,
  attachFile,
  menuItemHasLockIcon,
  upsellDialogConfirmsLock,
  markVisibleDialogs,
  collectGeneratedFiles,
  findGeneratedFileCandidates,
  sanitizeDownloadName,
  isAllowedDownloadHost,
  downloadUrlHost,
  parseHNvQHb,
  unwrapUrl,
  isGoogleSearchUrl,
  dismissOverlays,
} = driver;
const { withUsageLock, KNOWN_CANDIDATE_RPCIDS } = usageLimitsModule;

// --- Shared mock-DOM helpers (turn-status tests: PLUG-304, PLUG-407) ---
const NODE_FOLLOWING = 4;
const NODE_PRECEDING = 2;

function createMockElement({
  id = "el",
  tagName = "div",
  innerText = "",
  attributes = {},
  children = [],
  preceding = [],
  following = [],
} = {}) {
  const el = {
    id,
    tagName: tagName.toUpperCase(),
    innerText,
    disabled: Boolean(attributes.disabled),
    parent: null,
    getAttribute(attr) {
      return attributes[attr] ?? null;
    },
    hasAttribute(attr) {
      return Object.prototype.hasOwnProperty.call(attributes, attr);
    },
    setAttribute(attr, val) {
      attributes[attr] = String(val);
    },
    removeAttribute(attr) {
      delete attributes[attr];
    },
    compareDocumentPosition(other) {
      if (following.includes(other.id)) return NODE_FOLLOWING;
      if (preceding.includes(other.id)) return NODE_PRECEDING;
      return 0;
    },
    querySelector(sel) {
      const matches = this.querySelectorAll(sel);
      return matches.length > 0 ? matches[0] : null;
    },
    querySelectorAll(sel) {
      const results = [];
      const check = (node) => {
        if (nodeMatchesSelector(node, sel)) results.push(node);
        for (const ch of node.children || []) {
          ch.parent = node;
          check(ch);
        }
      };
      for (const ch of this.children || []) {
        ch.parent = this;
        check(ch);
      }
      return results;
    },
    children,
  };
  for (const ch of children) ch.parent = el;
  return el;
}

function nodeMatchesSelector(node, selector) {
  const parts = selector.split(",").map((s) => s.trim());
  for (const part of parts) {
    if (matchSingle(node, part)) return true;
  }
  return false;
}

function matchSingle(node, sel) {
  sel = sel.replace(/\s+i(?=\])/g, "");
  if (sel.includes(" ")) {
    const subParts = sel.split(/\s+/);
    if (subParts.length >= 2) {
      const parentSel = subParts.slice(0, -1).join(" ");
      const childSel = subParts[subParts.length - 1];
      if (!matchSingle(node, childSel)) return false;
      let p = node.parent;
      while (p) {
        if (matchSingle(p, parentSel)) return true;
        p = p.parent;
      }
      return false;
    }
  }
  if (/^[a-z0-9_-]+$/i.test(sel)) {
    return node.tagName.toLowerCase() === sel.toLowerCase();
  }
  if (sel.startsWith(".")) {
    const cls = sel.slice(1).toLowerCase();
    const nodeClass = (node.getAttribute("class") || "").toLowerCase();
    return nodeClass.split(/\s+/).includes(cls);
  }
  const tagMatch = sel.match(/^([a-z0-9_-]+)?\[([^\]]+)\]/i);
  if (tagMatch) {
    const wantTag = tagMatch[1];
    if (wantTag && node.tagName.toLowerCase() !== wantTag.toLowerCase()) return false;
    const attrExpr = tagMatch[2];
    if (attrExpr.includes("*=")) {
      const [a, val] = attrExpr.split("*=");
      const cleanVal = val.replace(/["'\s]/g, "").replace(/\s*i$/, "").toLowerCase();
      const actual = node.getAttribute(a.trim());
      if (actual == null) return false;
      return actual.toLowerCase().includes(cleanVal);
    }
    if (attrExpr.includes("=")) {
      const [a, val] = attrExpr.split("=");
      const cleanVal = val.replace(/["']/g, "");
      return node.getAttribute(a.trim()) === cleanVal;
    }
    return node.getAttribute(attrExpr.trim()) !== null;
  }
  return false;
}

test("required attachment accepts a new visible chip when Send is enabled", async (t) => {
  const tmp = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-attachment-")));
  const name = "pkg-17b6d6ea-71e7-4eff-ab61-020cc8ff8cf9-1795070189688.md";
  const file = path.join(tmp, name);
  fs.writeFileSync(file, "context");
  const warn = t.mock.method(console, "warn", () => {});
  const chip = ({ label, aria, visible = true, children = [], wrapsComposer = false } = {}) => ({
    innerText: label,
    contains: () => wrapsComposer,
    getAttribute: (attr) => attr === "aria-label" ? aria : null,
    getClientRects: () => visible ? [{}] : [],
    querySelectorAll: () => children,
  });
  for (const [label, options] of [
    ["full", { label: name }],
    ["three dots", { label: "pkg-17b6d6...5070189688" }],
    ["ellipsis", { label: "pkg-17b6d6…5070189688" }],
    ["aria middle", { aria: "Remove " + name.slice(13, -13) }],
    ["unknown name", { label: "Attachment", warn: true }],
    ["stale chip only", { stale: true }],
    ["hidden chip", { visible: false }],
    ["disabled Send", { disabled: true }],
  ]) await t.test(label, async () => {
    warn.mock.resetCalls();
    const previews = options.stale ? [chip({ label: name })] : [];
    const input = { setInputFiles: async (selected) => {
      assert.equal(selected, file);
      if (!options.stale) previews.push(chip(options));
    } };
    const container = { querySelectorAll: () => [chip({ children: previews, wrapsComposer: true }), ...previews] };
    const document = {
      querySelector: (selector) => selector.includes("contenteditable")
        ? { closest: () => container } : { disabled: options.disabled, getAttribute: () => null },
    };
    const evaluate = (fn, arg) => {
      const previous = globalThis.document;
      globalThis.document = document;
      try {
        return fn(arg);
      } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
      }
    };
    const page = {
      $: async () => ({ click: async () => {} }),
      evaluate: async (fn, arg) => evaluate(fn, arg),
      waitForSelector: async () => input,
      waitForTimeout: async () => {},
      waitForFunction: async (fn, arg) => {
        const result = evaluate(fn, arg);
        if (!result) throw new Error("attachment visibility timed out");
        return { jsonValue: async () => result, dispose: async () => {} };
      },
    };
    const upload = attachFile(page, file, { required: true });
    if (options.stale || options.visible === false || options.disabled) {
      await assert.rejects(upload, /visibility timed out/);
    } else {
      await upload;
    }
    assert.equal(warn.mock.callCount(), options.warn ? 1 : 0);
  });
});

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
function spawnServer(env, script = "acp-server.mjs", scriptArgs = []) {
  // Наследованный BB_THREAD_ID (запуск тестов из bb-треда) не должен
  // превращать голый запуск в привязанный к чужому треду.
  const { BB_THREAD_ID: _inheritedThread, ...cleanEnv } = env;
  const proc = spawn("node", [script, ...scriptArgs], {
    cwd: PLUGIN_ROOT,
    env: cleanEnv,
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
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
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

  // Argon model locked resolves to canonical neon in classifyFailure
  const errArgonLocked = new ModelUnavailable("model", "argon locked: paid upgrade required");
  errArgonLocked.isLocked = true;
  errArgonLocked.lockedModel = "argon";
  const cArgonLocked = classifyFailure(errArgonLocked);
  assert.equal(cArgonLocked.category, "model-locked");
  assert.equal(cArgonLocked.rotatable, true);
  assert.equal(cArgonLocked.cooldownMs, 0);
  assert.equal(cArgonLocked.lockedModel, "neon", "classifyFailure must normalize lockedModel 'argon' to 'neon'");
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
    driverSrc.includes("responses[idx]"),
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

  // PLUG-324: Test ModelUnavailable on «Code & complex work | 4 Carbon» with upsell_* mode-id
  let clickedCarbonUpsell = false;
  const mockPageCarbonUpsell = {
    $: async () => null,
    $$: async () => [
      {
        innerText: async () => "Code & complex work | 4 Carbon",
        evaluate: async (fn) => {
          const fakeEl = {
            querySelectorAll: () => [],
            hasAttribute: () => false,
            getAttribute: (n) => (n === "data-mode-id" ? "upsell_MODE_CATEGORY_ULTRA" : null),
            classList: { contains: () => false },
          };
          try {
            return fn(fakeEl);
          } catch {
            return false;
          }
        },
        click: async () => {
          clickedCarbonUpsell = true;
        },
      },
    ],
    waitForSelector: async () => ({
      innerText: async () => "4 Hydrogen",
      getAttribute: async () => "4 Hydrogen",
      click: async () => {},
    }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };

  await assert.rejects(
    async () => {
      await selectModelAndThinking(mockPageCarbonUpsell, "carbon", null, true);
    },
    (err) => {
      assert.ok(err instanceof ModelUnavailable);
      assert.equal(err.isLocked, true);
      assert.equal(err.lockedModel, "carbon");
      assert.match(err.message, /carbon locked: paid upgrade required/i);
      return true;
    }
  );
  assert.equal(clickedCarbonUpsell, false, "Carbon item with upsell_* mode-id must not be clicked");

  // Test resolveModelId for aliases and official labels
  const { resolveModelId } = await import("../acp-server.mjs");
  assert.equal(resolveModelId("neon"), "neon");
  assert.equal(resolveModelId("Gemini 4 Neon"), "neon");
  assert.equal(resolveModelId("argon"), "neon");
  assert.equal(resolveModelId("Gemini 4 Argon"), "neon");
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

  // Test successful selection of neon with the legacy Russian UI label "4 Argon"
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
  await selectModelAndThinking(mockPageArgon, "neon", null, true);
  assert.equal(clickedArgon, true, "Legacy Argon in Russian UI must be clicked when neon is requested");

  // PLUG-324: Test successful selection of neon with picker item "Deeper analysis | 4 Neon"
  let clickedNeon = false;
  const mockPageNeon = {
    $: async () => null,
    $$: async () => [
      {
        innerText: async () => "Deeper analysis | 4 Neon",
        evaluate: async () => false,
        click: async () => { clickedNeon = true; },
      },
    ],
    evaluate: async () => false,
    waitForSelector: async () => ({
      innerText: async () => "4 Hydrogen",
      getAttribute: async () => "4 Hydrogen",
      click: async () => {},
    }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };
  await selectModelAndThinking(mockPageNeon, "neon", null, true);
  assert.equal(clickedNeon, true, "Picker item 'Deeper analysis | 4 Neon' must be clicked when requested model is neon");

  // PLUG-324: legacy argon alias still reaches the driver and selects Neon in the Russian UI
  let clickedNeonRu = false;
  const mockPageNeonRu = {
    $: async () => null,
    $$: async () => [
      {
        innerText: async () => "Глубокий анализ | 4 Neon",
        evaluate: async () => false,
        click: async () => { clickedNeonRu = true; },
      },
    ],
    evaluate: async () => false,
    waitForSelector: async () => ({
      innerText: async () => "4 Hydrogen",
      getAttribute: async () => "4 Hydrogen",
      click: async () => {},
    }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };
  await selectModelAndThinking(mockPageNeonRu, "argon", null, true);
  assert.equal(clickedNeonRu, true, "Legacy argon alias must select picker item 'Глубокий анализ | 4 Neon'");

  // PLUG-324: Test fallback path of getPickerButton when primary selector is not found
  // (a) Mock page whose waitForSelector returns null and evaluateHandle runs the regex
  // against a visible "Deeper analysis | 4 Neon" button in document.querySelectorAll.
  let clickedFallbackNeon = false;
  const mockFallbackNeonButton = {
    offsetParent: {}, // visible
    innerText: "4 Neon",
    getAttribute: (name) => (name === "aria-label" ? "Deeper analysis" : null),
  };
  const mockHiddenNeonButton = {
    offsetParent: null, // invisible, must be filtered out
    innerText: "Deeper analysis | 4 Neon",
    getAttribute: () => "Deeper analysis",
  };
  const mockOtherButton = {
    offsetParent: {},
    innerText: "Settings",
    getAttribute: () => "Settings",
  };

  const mockPageFallbackNeon = {
    $: async () => null,
    $$: async () => [],
    evaluate: async () => false,
    waitForSelector: async () => null, // primary picker button selector fails
    evaluateHandle: async (fn) => {
      const prevDoc = globalThis.document;
      try {
        globalThis.document = {
          querySelectorAll: () => [mockHiddenNeonButton, mockOtherButton, mockFallbackNeonButton],
        };
        const domEl = fn();
        if (!domEl) return { asElement: () => null };
        return {
          asElement: () => ({
            innerText: async () => domEl.innerText,
            getAttribute: async (name) => domEl.getAttribute(name),
            click: async () => { clickedFallbackNeon = true; },
          }),
        };
      } finally {
        globalThis.document = prevDoc;
      }
    },
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };

  // When fallback button already shows Neon / Deeper analysis, selectModelAndThinking recognizes neon is selected
  await selectModelAndThinking(mockPageFallbackNeon, "neon", null, true);

  // Test fallback button showing another model (Hydrogen) opening menu to select Neon
  let clickedMenuNeonFromFallback = false;
  const mockFallbackHydrogenButton = {
    offsetParent: {},
    innerText: "4 Hydrogen",
    getAttribute: (name) => (name === "aria-label" ? "Hydrogen" : null),
  };
  const mockPageFallbackHydrogen = {
    $: async () => null,
    $$: async () => [
      {
        innerText: async () => "Deeper analysis | 4 Neon",
        evaluate: async () => false,
        click: async () => { clickedMenuNeonFromFallback = true; },
      },
    ],
    evaluate: async () => false,
    waitForSelector: async (sel) => {
      if (typeof sel === "string" && sel.includes("gem-menu-item")) {
        return { innerText: async () => "" };
      }
      return null;
    },
    evaluateHandle: async (fn) => {
      const prevDoc = globalThis.document;
      try {
        globalThis.document = {
          querySelectorAll: () => [mockHiddenNeonButton, mockOtherButton, mockFallbackHydrogenButton],
        };
        const domEl = fn();
        if (!domEl) return { asElement: () => null };
        return {
          asElement: () => ({
            innerText: async () => domEl.innerText,
            getAttribute: async (name) => domEl.getAttribute(name),
            click: async () => {},
          }),
        };
      } finally {
        globalThis.document = prevDoc;
      }
    },
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };

  await selectModelAndThinking(mockPageFallbackHydrogen, "neon", null, true);
  assert.equal(clickedMenuNeonFromFallback, true, "Menu item Neon must be clicked after opening menu from fallback Hydrogen button");

  // Test fallback button failure when no button matches known model regex
  const mockPageFallbackFail = {
    $: async () => null,
    $$: async () => [],
    evaluate: async () => false,
    waitForSelector: async () => null,
    evaluateHandle: async (fn) => {
      const prevDoc = globalThis.document;
      try {
        globalThis.document = {
          querySelectorAll: () => [mockOtherButton],
        };
        const domEl = fn();
        if (!domEl) return { asElement: () => null };
        return {
          asElement: () => ({
            innerText: async () => domEl.innerText,
            getAttribute: async (name) => domEl.getAttribute(name),
            click: async () => {},
          }),
        };
      } finally {
        globalThis.document = prevDoc;
      }
    },
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };

  await assert.rejects(
    async () => selectModelAndThinking(mockPageFallbackFail, "neon", null, true),
    /Model picker button not found/,
    "When fallback button does not match known models regex, getPickerButton must throw"
  );

  // (b) Source assertion on getPickerButton fallback regex literal
  const pickerFallbackMatch = driverSrc.match(/getPickerButton[\s\S]*?const\s+re\s*=\s*\/([^/]+)\/i/);
  assert.ok(pickerFallbackMatch, "gemini-driver.js must have fallback regex in getPickerButton");
  const fallbackRegexBody = pickerFallbackMatch[1];
  assert.ok(
    fallbackRegexBody.includes("neon"),
    `getPickerButton fallback regex must include 'neon' (got: /${fallbackRegexBody}/i)`
  );
  assert.ok(
    fallbackRegexBody.includes("deeper analysis"),
    `getPickerButton fallback regex must include 'deeper analysis' (got: /${fallbackRegexBody}/i)`
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
  assert.ok(r1.result.agentInfo.name === "web-gemini" || r1.result.agentInfo.name === "argon-gemini");
  assert.equal(r1.result.agentInfo.version, "0.2.0");
  assert.equal(r1.result.agentCapabilities.loadSession, true);

  // 2. session/new
  sendReq({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
  const r2 = await waitForResponse(2);
  const sessionId = r2.result.sessionId;
  assert.ok(sessionId.startsWith(`web-gemini-${serverProc.pid}-`));
  sendReq({ jsonrpc: "2.0", id: 22, method: "session/new", params: { cwd: "/tmp" } });
  const r22 = await waitForResponse(22);
  assert.ok(r22.result.sessionId.startsWith(`web-gemini-${serverProc.pid}-`));
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
  assert.ok(modelIds.includes("neon"));
  assert.ok(!modelIds.includes("argon"), "argon is an alias, not an available model id");
  assert.ok(modelIds.includes("carbon"));
  assert.ok(modelIds.includes("hydrogen"));
  assert.ok(modelIds.includes("pro"));
  assert.ok(modelIds.includes("flash-lite"));
  assert.equal(
    r2.result.models.availableModels.find((m) => m.modelId === "neon")?.name,
    "Gemini 4 Neon"
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
  assert.ok(loadModelIds.includes("neon"));
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
  assert.equal(
    r3.result.configOptions.find((o) => o.id === "model")?.currentValue,
    "neon",
    "legacy argon modelId must resolve to neon"
  );

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
  assert.equal(modelOpt4?.currentValue, "neon", "Model must remain 'neon' when thought_level changes on neon model");

  // Verify non-neon/non-carbon model updates thought_level to high cleanly
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

  // Reset back to neon for the rest of the test
  sendReq({
    jsonrpc: "2.0",
    id: 405,
    method: "session/set_model",
    params: { sessionId, modelId: "neon" },
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
    update.params.update?.content?.text?.includes("FAKE_") ||
    update.params.update?.text?.includes("FAKE_")
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
test("8. PLUG-281/PLUG-303 prompt-size guard and spill (r22): driver boundary, prompt spill >limit, and -32000 on fs failure", async () => {
  // Driver boundary: sendPrompt must reject before ensureChrome/CDP —
  // every send to Gemini passes through it (incl. packed/tool-loop messages).
  const prevEnv = process.env.ARGON_MAX_PROMPT_BYTES;
  process.env.ARGON_MAX_PROMPT_BYTES = "100";
  try {
    await assert.rejects(driver.sendPrompt({ prompt: "x".repeat(200) }), (err) => {
      assert.equal(err.code, "WEB_GEMINI_PROMPT_TOO_LARGE");
      assert.equal(
        err.message,
        "prompt too large: 200 bytes exceeds limit 100 bytes (WEB_GEMINI_MAX_PROMPT_BYTES). Shrink the request and retry."
      );
      return true;
    });

    // UTF-8 is measured in bytes, not characters: 60 × 'й' = 120 bytes > 100.
    await assert.rejects(driver.sendPrompt({ prompt: "й".repeat(60) }), (err) => {
      assert.equal(err.code, "WEB_GEMINI_PROMPT_TOO_LARGE");
      assert.match(err.message, /^prompt too large: 120 bytes exceeds limit 100 bytes/);
      return true;
    });
  } finally {
    if (prevEnv === undefined) delete process.env.ARGON_MAX_PROMPT_BYTES;
    else process.env.ARGON_MAX_PROMPT_BYTES = prevEnv;
  }

  // Server boundary: prompt > limit spills to uploads/pkg-<sessionId>-prompt-<ts>.md
  // with short pointer message; fs write error falls back to immediate -32000;
  // prompt <= limit passes without spill (§2.2 п.2).
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
    ARGON_MAX_PROMPT_BYTES: "300",
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

  // 1) FS write error fallback: uploads dir is non-writable -> immediate -32000
  const uploadsDir = path.join(tmpDir, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.chmodSync(uploadsDir, 0o444);

  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "x".repeat(1000) }] },
  });
  const r3 = await waitForResponse(3);
  assert.equal(r3.error?.code, -32000);
  assert.equal(
    r3.error?.message,
    "prompt too large: 1000 bytes exceeds limit 300 bytes (WEB_GEMINI_MAX_PROMPT_BYTES). Shrink the request and retry."
  );

  // No lease taken, no account touched: state file is only written by bindBackend
  const statePath = path.join(tmpDir, "accounts-state.json");
  assert.equal(fs.existsSync(statePath), false, "FS write error refusal must not create leases/state");

  // Restore uploads permissions
  fs.chmodSync(uploadsDir, 0o777);

  // 2) Prompt > limit 300: 1000 bytes spills to uploads/pkg-<sessionId>-prompt-<ts>.md,
  // response has no error, upload file is created with full text, pointer is short.
  sendReq({
    jsonrpc: "2.0",
    id: 4,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "x".repeat(1000) }] },
  });
  const r4 = await waitForResponse(4);
  assert.equal(r4.error, undefined, "oversized prompt must spill to file without error");
  assert.equal(r4.result?.stopReason, "end_turn");

  const uploadEntries = fs.readdirSync(uploadsDir);
  const promptSpill = uploadEntries.find((f) => /^pkg-.*-prompt-\d+\.md$/.test(f));
  assert.ok(promptSpill, `expected pkg-*-prompt-*.md in uploads, got: ${JSON.stringify(uploadEntries)}`);
  assert.equal(fs.readFileSync(path.join(uploadsDir, promptSpill), "utf8"), "x".repeat(1000));

  // Pointer text was sent to FAKE generation and echoed (sliced to 80 chars in FAKE mode)
  const chunk = lines.find(
    (l) => l.method === "session/update" && l.params?.update?.sessionUpdate === "agent_message_chunk"
  );
  assert.ok(chunk, "must emit agent_message_chunk in FAKE mode");
  const echo = String(chunk.params.update.text ?? chunk.params.update.content?.text ?? "");
  assert.ok(
    echo.includes("[Задача передана файлом-вложением «" + promptSpill.slice(0, 30)),
    `expected pointer text in chunk, got: ${echo}`
  );

  // 3) UTF-8 prompt > limit (160 × 'й' = 320 bytes > 300) also spills without error
  sendReq({
    jsonrpc: "2.0",
    id: 5,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "й".repeat(160) }] },
  });
  const r5 = await waitForResponse(5);
  assert.equal(r5.error, undefined);
  assert.equal(r5.result?.stopReason, "end_turn");
  const uploadEntries2 = fs.readdirSync(uploadsDir);
  assert.equal(uploadEntries2.filter((f) => f.includes("-prompt-")).length, 2);

  // 4) Prompt <= limit passes through to normal path without spill
  sendReq({
    jsonrpc: "2.0",
    id: 6,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "short ok" }] },
  });
  const r6 = await waitForResponse(6);
  assert.equal(r6.result?.stopReason, "end_turn");
  const uploadEntries3 = fs.readdirSync(uploadsDir);
  assert.equal(
    uploadEntries3.filter((f) => f.includes("-prompt-")).length,
    2,
    "prompt <= limit must not create spill file"
  );

  serverProc.stdin.end();
  await new Promise((resolve) => serverProc.on("exit", resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});


test("9. Backward compatibility and web-gemini naming convention", async () => {
  const { resolveServerScript, default: plugin } = await import("../index.mjs");

  // Verify plugin registration registers both acp-web-gemini and acp-argon
  const registered = [];
  plugin({
    providers: {
      register(p) {
        registered.push(p);
      },
    },
  });
  assert.equal(registered.length, 2);
  const primary = registered.find((p) => p.id === "acp-web-gemini");
  assert.ok(primary, "Primary provider acp-web-gemini must be registered");
  assert.equal(primary.displayName, "Gemini (Web)");
  assert.equal(primary.badgeLabel, "Gemini");

  const legacy = registered.find((p) => p.id === "acp-argon");
  assert.ok(legacy, "Legacy provider acp-argon must be registered for backward compatibility");
  assert.equal(legacy.displayName, "Gemini (Argon)");

  // Test resolveServerScript with WEB_GEMINI_USE_BUNDLED
  const prevUse = process.env.WEB_GEMINI_USE_BUNDLED;
  try {
    process.env.WEB_GEMINI_USE_BUNDLED = "1";
    assert.equal(resolveServerScript(), path.resolve(PLUGIN_ROOT, "acp-server.mjs"));
  } finally {
    if (prevUse === undefined) delete process.env.WEB_GEMINI_USE_BUNDLED;
    else process.env.WEB_GEMINI_USE_BUNDLED = prevUse;
  }

  // Test acp-server.mjs with WEB_GEMINI_FAKE=1 and WEB_GEMINI_* environment
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-compat-test-")));
  const poolFile = path.join(tmpDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        {
          id: "compat-acc-1",
          email: "compat@example.com",
          profileDir: path.join(tmpDir, "p1"),
          cdpPort: 9222,
          priority: 1,
        },
      ],
    })
  );

  const serverProc = spawnServer({
    ...process.env,
    WEB_GEMINI_FAKE: "1",
    WEB_GEMINI_FAKE_DELAY_MS: "50",
    WEB_GEMINI_STATE_DIR: tmpDir,
    WEB_GEMINI_POOL_FILE: poolFile,
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
      if (idx >= 0) return lines.splice(idx, 1)[0];
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for response id=${id}`);
  }

  sendReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const r1 = await waitForResponse(1);
  assert.equal(r1.result.agentInfo.name, "web-gemini");

  sendReq({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
  const r2 = await waitForResponse(2);
  const sessionId = r2.result.sessionId;
  assert.ok(sessionId.startsWith("web-gemini-"));

  const legacySessionId = `argon-${sessionId.slice("web-gemini-".length)}`;
  sendReq({ jsonrpc: "2.0", id: 3, method: "session/set_model", params: { sessionId: legacySessionId, modelId: "carbon" } });
  const r3 = await waitForResponse(3);
  assert.ok(!r3.error, `legacy sessionId must be accepted: ${r3.error?.message}`);
  sendReq({ jsonrpc: "2.0", id: 4, method: "session/load", params: { sessionId } });
  const r4 = await waitForResponse(4);
  assert.equal(r4.result.models.currentModelId, "carbon");

  serverProc.stdin.end();
  await new Promise((resolve) => serverProc.on("exit", resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
test("10. Smart model routing: pickBackendFromState prioritizes pro accounts for neon and ultra for carbon", () => {
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

  // For neon: pro accounts (pro-1, pro-2) are prioritized over ultra (ultra-1) to reserve ultra for carbon!
  // Between pro-1 (100) and pro-2 (200), pro-1 is least recently used
  const neonPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "neon", testBackends);
  assert.ok(neonPick.backend, "Should pick a backend for neon");
  assert.equal(neonPick.backend.id, "pro-1", "Neon should pick pro tier account first");

  // When pro-1 is busy, neon picks pro-2 (the remaining pro account)
  fakeState.accounts["pro-1"].inUseUntilMs = Date.now() + 60000;
  fakeState.accounts["pro-1"].owner = "other-process";
  const neonPick2 = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "neon", testBackends);
  assert.ok(neonPick2.backend, "Should pick pro-2 for neon when pro-1 is busy");
  assert.equal(neonPick2.backend.id, "pro-2");

  // When both pro accounts are busy, neon falls back to ultra (ultra-1)
  fakeState.accounts["pro-2"].inUseUntilMs = Date.now() + 60000;
  fakeState.accounts["pro-2"].owner = "other-process";
  const neonPick3 = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "neon", testBackends);
  assert.ok(neonPick3.backend, "Should fall back to ultra account for neon when all pro accounts are busy");
  assert.equal(neonPick3.backend.id, "ultra-1");

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
  // 1. Equal priority (all 10): "при прочих равных" Pro accounts are preferred for neon over Ultra (Ultra in end)
  fakeState.accounts["ultra-1"].lockedModels = [];
  fakeState.accounts["ultra-1"].priority = 10;
  fakeState.accounts["pro-1"].priority = 10;
  fakeState.accounts["pro-2"].priority = 10;
  fakeState.accounts["ultra-1"].lastUsedMs = 10; // ultra-1 has lowest lastUsedMs
  fakeState.accounts["pro-1"].lastUsedMs = 100;
  fakeState.accounts["pro-2"].lastUsedMs = 200;
  const equalPrioPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "neon", testBackends);
  assert.equal(equalPrioPick.backend.id, "pro-1", "Equal priority should still prioritize pro account over ultra for neon");

  // 2. Explicit priority ladder: higher priority picked first regardless of lastUsedMs
  fakeState.accounts["pro-2"].priority = 20; // pro-2 has priority 20
  const higherPrioPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "neon", testBackends);
  assert.equal(higherPrioPick.backend.id, "pro-2", "Priority 20 must beat priority 10");

  // 3. Priority 0: account is disabled and never picked
  fakeState.accounts["pro-2"].priority = 0;
  fakeState.accounts["pro-1"].priority = 0;
  // Now only ultra-1 is left (> 0)
  const onlyUltraPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "neon", testBackends);
  assert.equal(onlyUltraPick.backend.id, "ultra-1", "Priority 0 accounts must be ignored, picking remaining account");

  fakeState.accounts["ultra-1"].priority = 0;
  const zeroPick = pickBackendFromState(fakeState, null, "test-owner", Date.now(), "neon", testBackends);
  assert.equal(zeroPick.none, true, "When all accounts have priority 0, pickBackendFromState returns none");
});

test("10b. legacy accounts-state.json with lockedModels:['argon'] normalizes to neon and blocks neon", async () => {
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-locked-state-")));
  const ledgerPath = path.join(tmpDir, "accounts-state.json");
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify({
      accounts: {
        "acc-legacy": {
          cooldownUntilMs: 0,
          lastUsedMs: 0,
          lastError: null,
          lockedModels: ["argon", "custom-unknown"],
        },
      },
      leases: {},
    })
  );

  const state = loadState(ledgerPath);
  assert.deepEqual(
    state.accounts["acc-legacy"].lockedModels,
    ["neon", "custom-unknown"],
    "argon in lockedModels must normalize to neon while preserving unknown models"
  );

  const backend = { id: "acc-legacy", priority: 10, tier: "pro", cdp: "9222" };
  assert.equal(
    modelSupportedOnAccount("neon", backend, state),
    false,
    "modelSupportedOnAccount must consider neon blocked when account had argon locked"
  );

  const pick = pickBackendFromState(state, null, "test-owner", Date.now(), "neon", [backend]);
  assert.equal(
    pick.none,
    true,
    "pickBackendFromState must consider neon blocked on the account"
  );

  assert.equal(
    modelSupportedOnAccount("argon", backend, state),
    false,
    "modelSupportedOnAccount must consider argon alias blocked when account had argon/neon locked"
  );
  const pickArgon = pickBackendFromState(state, null, "test-owner", Date.now(), "argon", [backend]);
  assert.equal(
    pickArgon.none,
    true,
    "pickBackendFromState with model:'argon' must be blocked when account has lockedModels containing neon"
  );

  const neonLockedState = {
    accounts: {
      "acc-neon": { lockedModels: ["neon"], priority: 10, tier: "pro" },
    },
    leases: {},
  };
  const neonLockedBackend = { id: "acc-neon", priority: 10, tier: "pro", cdp: "9222" };
  assert.equal(
    modelSupportedOnAccount("argon", neonLockedBackend, neonLockedState),
    false,
    "modelSupportedOnAccount('argon') must be blocked when lockedModels contains ['neon']"
  );
  const pickArgonFromNeonLock = pickBackendFromState(neonLockedState, null, "test-owner", Date.now(), "argon", [neonLockedBackend]);
  assert.equal(
    pickArgonFromNeonLock.none,
    true,
    "pickBackendFromState('argon') must be blocked when lockedModels contains ['neon']"
  );

  // (c) settleBackend with lockedModel: "argon" writes canonical "neon" to ledger
  const tmpSettleDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "settle-test-")));
  const settleLedger = path.join(tmpSettleDir, "accounts-state.json");
  const settleLock = path.join(tmpSettleDir, "accounts-state.json.lock");
  await settleBackend("acc-settle", "sess-test", 0, "test failure", null, "argon", settleLedger, settleLock);
  const settleState = loadState(settleLedger);
  assert.deepEqual(
    settleState.accounts["acc-settle"]?.lockedModels,
    ["neon"],
    "settleBackend with lockedModel:'argon' must write canonical 'neon' to accounts-state.json"
  );
});

test("11. acp-server slog and lifecycle guards, driver :visible and RU selectors", async () => {
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

test("12. parseUsageLimits parses batchexecute wrb.fr frames and handles self-healing recipe rpcid", () => {
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

test("13. accounts-usage.json multi-process merge logic and atomic file updates", async () => {
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

test("14. captureUsageLimits domain gating, evaluate execution, and throttling", async () => {
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

test("15. sendPrompt signature, opts hygiene, mock integration with captureUsageLimits, and backend.tier propagation", async () => {
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

test("16. PLUG-280 model↔account selector filtering and incompatibility resets", async () => {
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

  // Baseline: model neon is supported everywhere — all accounts listed, all 5 models.
  assert.deepEqual(values(optById(r2, "account")), ["auto", "pro-1", "ultra-1", "ultra-2"]);
  assert.equal(optById(r2, "account").currentValue, "auto");
  assert.deepEqual(values(optById(r2, "model")), ["neon", "carbon", "hydrogen", "pro", "flash-lite"]);

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
  // the model is carbon resets s.model to the "neon" default.
  sendReq({ jsonrpc: "2.0", id: 5, method: "session/set_config_option", params: { sessionId, configId: "account", value: "pro-1" } });
  const r5 = await waitForResponse(5);
  assert.equal(optById(r5, "model").currentValue, "neon", "Incompatible model must reset to neon on account change");
  assert.equal(optById(r5, "account").currentValue, "pro-1");
  assert.deepEqual(values(optById(r5, "account")), ["auto", "pro-1", "ultra-1", "ultra-2"]);

  // Case 3: with a pro account selected, carbon is gone from the model list.
  assert.ok(!values(optById(r5, "model")).includes("carbon"), "carbon must be filtered out on a pro account");
  assert.ok(values(optById(r5, "model")).includes("neon"));

  // Case 6: ultra account selected → all 5 models visible.
  sendReq({ jsonrpc: "2.0", id: 6, method: "session/set_config_option", params: { sessionId, configId: "account", value: "ultra-1" } });
  const r6 = await waitForResponse(6);
  assert.deepEqual(values(optById(r6, "model")), ["neon", "carbon", "hydrogen", "pro", "flash-lite"], "Ultra account must see all models");
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
  assert.equal(optById(r10, "model").currentValue, "neon", "Locked model must reset to neon");
  assert.ok(!values(optById(r10, "model")).includes("hydrogen"), "lockedModels entry must hide the model");
  assert.ok(!values(optById(r10, "model")).includes("carbon"), "pro tier must still hide carbon");

  serverProc.stdin.end();
  await new Promise((resolve) => serverProc.on("exit", resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("17. PLUG-282: exact lock predicate, upsell CTA gate, and ops unlock", async () => {
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

  // PLUG-324: data-mode-id upsell format (e.g. upsell_MODE_CATEGORY_ULTRA)
  assert.equal(
    menuItemHasLockIcon({
      getAttribute: (n) => (n === "data-mode-id" ? "upsell_MODE_CATEGORY_ULTRA" : null),
    }),
    true,
    "data-mode-id 'upsell_MODE_CATEGORY_ULTRA' must be locked"
  );
  assert.equal(
    menuItemHasLockIcon({
      getAttribute: (n) => (n === "data-mode-id" ? "upsell_PRO_PLUS" : null),
    }),
    true,
    "data-mode-id 'upsell_*' must be locked"
  );
  assert.equal(
    menuItemHasLockIcon({
      getAttribute: (n) => (n === "data-mode-id" ? "MODE_CATEGORY_NEON" : null),
    }),
    false,
    "data-mode-id without upsell prefix must not be locked"
  );
  assert.equal(
    menuItemHasLockIcon({
      getAttribute: (n) => (n === "data-mode-id" ? "mode_no_upsell" : null),
    }),
    false,
    "data-mode-id containing 'upsell' as substring must not be locked"
  );
  assert.equal(
    menuItemHasLockIcon({
      getAttribute: (n) => (n === "data-mode-id" ? "upselling_tier" : null),
    }),
    false,
    "data-mode-id with 'upsell' not followed by underscore must not be locked"
  );
  assert.equal(
    menuItemHasLockIcon({
      getAttribute: () => null,
      querySelector: () => ({ getAttribute: () => "upsell_MODE_CATEGORY_ULTRA" }),
      closest: () => ({ getAttribute: () => "upsell_MODE_CATEGORY_ULTRA" }),
    }),
    false,
    "descendant or ancestor data-mode-id must not lock the item (only own attribute)"
  );

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
  assert.equal(preDlg.getAttribute("data-web-gemini-pre-click"), "1");
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
  await selectModelAndThinking(mockPageUnlock, "neon", null, true);
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
    await selectModelAndThinking(mockPagePromo, "neon", null, true);
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
      async () => selectModelAndThinking(mockPageUpsell, "neon", null, true),
      (err) => {
        assert.ok(err instanceof ModelUnavailable);
        assert.equal(err.isLocked, true);
        assert.equal(err.lockedModel, "neon");
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
    await selectModelAndThinking(mockPagePre, "neon", null, true);
  } finally {
    delete globalThis.document;
  }
  assert.equal(
    preDialogs[0].getAttribute("data-web-gemini-pre-click"),
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
    await selectModelAndThinking(mockPageSelected, "neon", null, true);
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
          "pro-1": { cooldownUntilMs: 0, lastUsedMs: 2, lastError: null, lockedModels: ["neon", "hydrogen"] },
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
  assert.deepEqual(st.accounts["pro-1"].lockedModels, ["hydrogen"], "unlock <id> argon resolves alias and removes neon");
  assert.deepEqual(st.accounts["ultra-1"].lockedModels, ["carbon"], "unlock <id> leaves other accounts untouched");

  writeUnlockState();
  runUnlock("pro-1 neon");
  st = readState();
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

test("18. PLUG-285: bb <system_instructions> blocks stripped from session/prompt", async () => {
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
  assert.ok(echo.includes("FAKE_WEB_GEMINI_ECHO"), "echo prefix expected");
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

test("19. PLUG-286: driver/page failures are transient — never model-unavailable, never parked", () => {
  // The 6h-park symptom: waitForSelector timeout on a hung insert — a
  // driver transient, rotatable (retry on the next account inside the
  // deadline), parkedReason null so no account is ever parked.
  const selectorTimeout = classifyFailure(new Error("page.waitForSelector: Timeout 8000ms exceeded."));
  assert.equal(selectorTimeout.category, "transient");
  assert.equal(selectorTimeout.rotatable, true);
  assert.equal(selectorTimeout.parkedReason, null);
  assert.equal(selectorTimeout.cooldownMs, 0);

  // Playwright TimeoutError is caught by name even without a message match.
  const namedTimeout = new Error("waiting failed: frame detached");
  namedTimeout.name = "TimeoutError";
  const cNamed = classifyFailure(namedTimeout);
  assert.equal(cNamed.category, "transient");
  assert.equal(cNamed.parkedReason, null);

  // Page crash / CDP / navigation failures — the same transient class.
  for (const m of [
    "Target crashed",
    "Session closed. Most likely the page has been closed.",
    "Protocol error (Runtime.callFunctionOn): Session closed",
    "page.goto: net::ERR_CONNECTION_REFUSED at https://gemini.google.com/app",
    "Execution context was destroyed, most likely because of a navigation",
    "browser has been closed",
    "waiting for selector \"gem-menu-item\" failed: timeout 5000ms exceeded",
    "Chrome CDP failed to become ready on port 9222 within 15s (mode: headless)",
  ]) {
    const c = classifyFailure(new Error(m));
    assert.equal(c.category, "transient", `"${m}" must be transient, got ${c.category}`);
    assert.equal(c.rotatable, true, `"${m}" must be rotatable`);
    assert.equal(c.parkedReason, null, `"${m}" must not park`);
    assert.equal(c.cooldownMs, 0);
  }

  // A nav-error page text is NOT model proof: bare "недоступна" without
  // model context must not park 6h as model-unavailable.
  const navErr = classifyFailure(new Error("navigation failed: страница недоступна"));
  assert.notEqual(navErr.category, "model-unavailable");
  assert.equal(navErr.parkedReason, null);

  // DOM-proven signs still classify as before: upsell/lock → model-locked
  // (no park, lockedModels entry); missing item → model-unavailable + 6h.
  const locked = new ModelUnavailable("model", "neon locked: paid upgrade required");
  locked.isLocked = true;
  locked.lockedModel = "neon";
  const cLocked = classifyFailure(locked);
  assert.equal(cLocked.category, "model-locked");
  assert.equal(cLocked.parkedReason, null);

  const missing = new ModelUnavailable("model", "neon not in picker");
  const cMissing = classifyFailure(missing);
  assert.equal(cMissing.category, "model-unavailable");
  assert.equal(cMissing.parkedReason, "model-unavailable");
  assert.equal(cMissing.cooldownMs, 6 * 3600_000);

  const ruMissing = classifyFailure(new Error("модель временно недоступна для этого аккаунта"));
  assert.equal(ruMissing.category, "model-unavailable");
  assert.equal(ruMissing.cooldownMs, 6 * 3600_000);

  // transient-retry → repeat → error-to-caller: N identical driver failures
  // never produce parkedReason, so runPrompt rotates within maxAttempts and
  // then throws to the caller — the account stays unparked throughout.
  for (let i = 0; i < 5; i++) {
    const c = classifyFailure(new Error("page.waitForSelector: Timeout 8000ms exceeded."));
    assert.equal(c.parkedReason, null, `attempt ${i + 1} must not park`);
    assert.equal(c.untilMs, 0, `attempt ${i + 1} must not cool down`);
  }
});

test("19. PLUG-291: uploads/downloads — collectUploadFiles, pruneDir, spill hooks, collectGeneratedFiles", async () => {
  const tmpDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon-plug291-")));

  /* --- A. collectUploadFiles: приём, дедупликация, отказ по корням/чувствительности/лимитам --- */
  const cwd = path.join(tmpDir, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  const f1 = path.join(cwd, "audit.md");
  fs.writeFileSync(f1, "# audit\n");
  const f2 = path.join(cwd, "notes.txt");
  fs.writeFileSync(f2, "notes\n");
  const sess = { cwd, roots: [] };

  const ok = collectUploadFiles(
    [
      { type: "text", text: "посмотри файлы" },
      { type: "resource_link", uri: `file://${f1}` },
      { type: "resource_link", uri: "https://example.com/doc.md" }, // URL — не файл, игнор
      { type: "image", path: f2 },
      { type: "localFile", path: f1 }, // дубликат f1 — дедупликация по realpath
      { type: "resource", resource: { text: "embedded", uri: `file://${f1}` } }, // embedded — не upload
    ],
    sess
  );
  assert.ok(!ok.error, `unexpected error: ${ok.error}`);
  assert.deepEqual(ok.files, [fs.realpathSync(f1), fs.realpathSync(f2)]);

  // additionalDirectories/roots расширяют допустимые корни.
  const otherRoot = path.join(tmpDir, "other");
  fs.mkdirSync(otherRoot, { recursive: true });
  const fOther = path.join(otherRoot, "shared.txt");
  fs.writeFileSync(fOther, "shared\n");
  const okRoots = collectUploadFiles(
    [{ type: "resource_link", uri: `file://${fOther}` }],
    { cwd, roots: [otherRoot] }
  );
  assert.ok(!okRoots.error);
  assert.deepEqual(okRoots.files, [fs.realpathSync(fOther)]);
  const errRoots = collectUploadFiles(
    [{ type: "resource_link", uri: `file://${fOther}` }],
    sess // без roots — чужой каталог
  );
  assert.ok(errRoots.error && /outside session roots/.test(errRoots.error));

  // Файл за пределами корней → отказ.
  const outside = path.join(tmpDir, "outside.md");
  fs.writeFileSync(outside, "x");
  const errOut = collectUploadFiles([{ type: "resource_link", uri: `file://${outside}` }], sess);
  assert.ok(errOut.error && /outside session roots/.test(errOut.error));

  // Чувствительный файл внутри cwd → отказ.
  const envF = path.join(cwd, ".e" + "nv");
  fs.writeFileSync(envF, "SECRET=1\n");
  const errSens = collectUploadFiles([{ type: "resource_link", uri: `file://${envF}` }], sess);
  assert.ok(errSens.error && /sensitive/.test(errSens.error), `expected sensitive error, got ${errSens.error}`);

  // Несуществующий файл и каталог → отказ.
  const errMissing = collectUploadFiles(
    [{ type: "resource_link", uri: `file://${path.join(cwd, "nope.md")}` }],
    sess
  );
  assert.ok(errMissing.error && /not found/.test(errMissing.error));
  const errDir = collectUploadFiles([{ type: "resource_link", uri: `file://${cwd}` }], sess);
  assert.ok(errDir.error && /not a file/.test(errDir.error));

  // Лимит по количеству (дефолт 5): 6 файлов → отказ.
  const many = [];
  for (let i = 0; i < 6; i++) {
    const fp = path.join(cwd, `m${i}.txt`);
    fs.writeFileSync(fp, "m");
    many.push({ type: "resource_link", uri: `file://${fp}` });
  }
  const errMany = collectUploadFiles(many, sess);
  assert.ok(errMany.error && /too many upload files/.test(errMany.error));

  // Лимит — после дедупликации: 6 блоков на один файл не считаются 6 файлами.
  const dupMany = [];
  for (let i = 0; i < 6; i++) dupMany.push({ type: "resource_link", uri: `file://${f1}` });
  const okDup = collectUploadFiles(dupMany, sess);
  assert.ok(!okDup.error, `dup blocks must dedup before count limit: ${okDup.error}`);
  assert.deepEqual(okDup.files, [fs.realpathSync(f1)]);

  // Относительный path блока резолвится от cwd сессии, не от process.cwd().
  const okRel = collectUploadFiles([{ type: "localFile", path: "notes.txt" }], sess);
  assert.ok(!okRel.error, `relative path must resolve against session cwd: ${okRel.error}`);
  assert.deepEqual(okRel.files, [fs.realpathSync(f2)]);

  // Симлинк внутри cwd → наружу: realpath вне корней → отказ.
  const linkInside = path.join(cwd, "link-out.txt");
  try {
    fs.symlinkSync(outside, linkInside);
    const errLink = collectUploadFiles([{ type: "resource_link", uri: `file://${linkInside}` }], sess);
    assert.ok(errLink.error && /outside session roots/.test(errLink.error));
  } catch {
    // Файловая система без symlink — пропускаем проверку.
  }

  /* --- B. pruneDir: TTL и ограничение по числу файлов --- */
  const prDir = path.join(tmpDir, "prune");
  fs.mkdirSync(prDir, { recursive: true });
  for (let i = 0; i < 25; i++) {
    const fp = path.join(prDir, `f${String(i).padStart(2, "0")}.bin`);
    fs.writeFileSync(fp, "x");
    if (i < 3) {
      const old = new Date(Date.now() - 48 * 3600_000);
      fs.utimesSync(fp, old, old);
    }
  }
  const pr = pruneDir(prDir);
  assert.equal(fs.readdirSync(prDir).length, 20);
  assert.ok(pr.removed >= 5, `expected >=5 removed, got ${pr.removed}`);
  // Три самых старых точно удалены.
  for (const n of ["f00.bin", "f01.bin", "f02.bin"]) {
    assert.ok(!fs.existsSync(path.join(prDir, n)), `${n} must be pruned`);
  }
  const prEmpty = pruneDir(path.join(tmpDir, "no-such-dir"));
  assert.deepEqual(prEmpty, { removed: 0 });

  /* --- C. Санитизация имён и белый список доменов скачивания --- */
  const sanitized = sanitizeDownloadName('..\\evil/../../x.txt');
  assert.ok(!sanitized.includes("..") && !sanitized.includes("/") && !sanitized.includes("\\"));
  assert.equal(sanitizeDownloadName(""), "file");
  // '#' в имени ломал file:// URI в BB — sanitize вырезает (ревью PLUG-291).
  assert.ok(!sanitizeDownloadName("C# notes.md").includes("#"));
  assert.equal(downloadUrlHost("https://storage.googleapis.com/x/f.bin"), "storage.googleapis.com");
  assert.equal(downloadUrlHost("blob:https://gemini.google.com/uuid-1"), "gemini.google.com");
  assert.equal(downloadUrlHost("data:text/plain,hi"), null);
  assert.equal(isAllowedDownloadHost("gemini.google.com"), true);
  assert.equal(isAllowedDownloadHost("storage.googleapis.com"), true);
  assert.equal(isAllowedDownloadHost("googleusercontent.com"), true);
  assert.equal(isAllowedDownloadHost("lh3.googleusercontent.com"), true);
  assert.equal(isAllowedDownloadHost("googleapis.com"), true);
  assert.equal(isAllowedDownloadHost("evil.com"), false);
  assert.equal(isAllowedDownloadHost("google.com.evil.com"), false);
  assert.equal(isAllowedDownloadHost("googleapis.com.evil.com"), false);

  /* --- D. collectGeneratedFiles на мок-странице: прямой URL + download-event --- */
  const dlDir = path.join(tmpDir, "downloads");
  const linkBuf = Buffer.from("# report from gemini\n");
  const fakePage = {
    evaluate: async () => [
      {
        kind: "link",
        tag: "n0-0",
        href: "https://storage.googleapis.com/gemini-files/report.md",
        name: "report.md",
        canClick: false,
      },
      { kind: "click", tag: "n0-1", name: "Download" },
    ],
    context: () => ({
      request: {
        get: async (url) => ({
          ok: () => true,
          headers: () => ({
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": 'attachment; filename="report.md"',
          }),
          body: async () => linkBuf,
        }),
      },
    }),
    $: async () => ({ click: async () => {} }),
    waitForEvent: async (ev) => {
      assert.equal(ev, "download");
      return {
        suggestedFilename: () => "result.txt",
        saveAs: async (p) => fs.writeFileSync(p, "RESULT\n"),
      };
    },
  };
  const coll = await collectGeneratedFiles(fakePage, {
    dir: dlDir,
    sessionId: "sess-1",
    turnIndex: 0,
    promptPrefix: "q",
  });
  assert.equal(coll.files.length, 2, `expected 2 files, got ${JSON.stringify(coll)}`);
  assert.equal(coll.skipped.length, 0);
  const md = coll.files.find((f) => f.name === "report.md");
  assert.ok(md, "report.md must be downloaded");
  assert.equal(fs.readFileSync(md.path, "utf8"), linkBuf.toString());
  assert.equal(md.mimeType, "text/markdown");
  const txt = coll.files.find((f) => f.name === "result.txt");
  assert.ok(txt, "result.txt via download-event must be saved");
  assert.equal(fs.readFileSync(txt.path, "utf8"), "RESULT\n");
  // Атомарность: .part-остатков нет, имена в каталоге подписаны сессией.
  const dlEntries = fs.readdirSync(dlDir);
  assert.equal(dlEntries.length, 2);
  assert.ok(dlEntries.every((n) => !n.endsWith(".part")), "no .part leftovers");
  assert.ok(dlEntries.every((n) => n.startsWith("sess-1-")), "session tag prefix");

  // Нет кандидатов / evaluate бросил → пустой результат, без падений.
  const collNone = await collectGeneratedFiles({ evaluate: async () => [] }, { dir: dlDir });
  assert.deepEqual(collNone, { files: [], skipped: [] });
  const collErr = await collectGeneratedFiles(
    { evaluate: async () => { throw new Error("no dom"); } },
    { dir: dlDir }
  );
  assert.deepEqual(collErr, { files: [], skipped: [] });
  const collNoDir = await collectGeneratedFiles(fakePage, {});
  assert.deepEqual(collNoDir, { files: [], skipped: [] });

  /* --- E. sendPrompt: files → driverHooks.attachFile до хода; res.files/res.skippedDownloads --- */
  const hookTmp = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "sendprompt-files-")));
  const attachCalls = [];
  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => ({
      url: () => "https://gemini.google.com/app",
      goto: async () => {},
      evaluate: async () => null,
    }),
    attachFile: async (page, f) => {
      attachCalls.push(f);
    },
    runTurn: async () => ({
      text: "turn ok",
      convId: "conv-files-1",
      files: [{ path: path.join(hookTmp, "g.md"), name: "g.md", mimeType: "text/markdown" }],
      skippedDownloads: [{ name: "big.zip", reason: "too large" }],
    }),
  });
  try {
    const res = await sendPrompt({
      prompt: "hi",
      files: [f1, f2],
      stateDir: hookTmp,
      backend: { id: "files-acc", tier: null },
      accountId: "files-acc",
    });
    assert.deepEqual(attachCalls, [f1, f2], "attachFile must receive every file in order");
    assert.equal(res.convId, "conv-files-1");
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].name, "g.md");
    assert.equal(res.skippedDownloads[0].name, "big.zip");
  } finally {
    _setDriverHooks(null);
  }

  // attachFile вызывается строго до вставки текста — порядок в теле sendPrompt.
  const driverSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "src/gemini-driver.js"), "utf8");
  const spMatch = driverSrc.match(/async function sendPrompt\(\{[\s\S]*?\}\) \{([\s\S]*?)\nasync function \w+/);
  assert.ok(spMatch, "sendPrompt body must be found");
  const spBody = spMatch[1];
  const iAttach = spBody.indexOf("await upload();", spBody.indexOf("const textboxSelector"));
  const iStabilize = spBody.indexOf("waitForHistoryStabilization(page, convId");
  const iInsert = spBody.indexOf("execCommand('insertText'");
  assert.ok(iAttach > 0 && iStabilize > iAttach && iInsert > iAttach, "attach must precede text insert");

  /* --- F. JSON-RPC e2e (FAKE): file:// вне корней → -32602, внутри cwd → принят --- */
  const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "argon291-state-")));
  const poolFile = path.join(stateDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [{ id: "fake-acc", email: "f@x.com", profileDir: path.join(stateDir, "p"), cdpPort: 9222 }],
    })
  );
  const serverProc = spawnServer({
    ...process.env,
    ARGON_FAKE: "1",
    ARGON_STATE_DIR: stateDir,
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
  const sendReq = (req) => serverProc.stdin.write(JSON.stringify(req) + "\n");
  const waitForResponse = async (id, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.id === id);
      if (idx >= 0) return lines.splice(idx, 1)[0];
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`timeout id=${id}`);
  };
  sendReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await waitForResponse(1);
  sendReq({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd } });
  const r2 = await waitForResponse(2);
  const sessionId = r2.result.sessionId;

  // Файл внутри cwd — промпт принят, FAKE-ответ.
  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        { type: "text", text: "прочитай вложение" },
        { type: "resource_link", uri: `file://${f1}`, name: "audit.md" },
      ],
    },
  });
  const r3 = await waitForResponse(3);
  assert.ok(r3.result, `expected result, got ${JSON.stringify(r3)}`);
  assert.equal(r3.result.stopReason, "end_turn");

  // Файл вне корней — синхронная ошибка -32602 до очереди и лиза.
  sendReq({
    jsonrpc: "2.0",
    id: 4,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        { type: "text", text: "прочитай чужой файл" },
        { type: "resource_link", uri: `file://${outside}` },
      ],
    },
  });
  const r4 = await waitForResponse(4);
  assert.ok(r4.error, `expected error, got ${JSON.stringify(r4)}`);
  assert.equal(r4.error.code, -32602);
  assert.match(r4.error.message, /outside session roots/);

  // URL-ресурс (не файл) — не отклоняется и не загружается.
  sendReq({
    jsonrpc: "2.0",
    id: 5,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        { type: "text", text: "ссылка" },
        { type: "resource_link", uri: "https://example.com/a.md" },
      ],
    },
  });
  const r5 = await waitForResponse(5);
  assert.ok(r5.result, `expected result, got ${JSON.stringify(r5)}`);

  try {
    process.kill(-serverProc.pid, "SIGKILL");
  } catch {
    try {
      serverProc.kill("SIGKILL");
    } catch {}
  }
});

test("20. PLUG-304: turn completion predicate and thinking/pause guards", async () => {
  // --- Scenario 1 (PLUG-304 symptom): 42 chars in message-content + spinner (thinking) + no stop button ---
  const spinnerNode = createMockElement({ tagName: "mat-spinner", attributes: { class: "spinner" } });
  const mcThinking = createMockElement({
    tagName: "message-content",
    innerText: "Analyzing repository architecture and files", // 42 chars
  });
  const respThinking = createMockElement({
    id: "resp-0",
    tagName: "model-response",
    children: [mcThinking, spinnerNode],
    preceding: ["query-0"],
  });
  const queryNode = createMockElement({
    id: "query-0",
    tagName: "user-query",
    innerText: "Run security audit on repo",
    following: ["resp-0", "resp-1", "resp-2", "resp-busy"],
  });

  const docThinking = {
    querySelectorAll(sel) {
      if (sel === "model-response") return [respThinking];
      if (sel === "user-query") return [queryNode];
      return [];
    },
    querySelector(sel) {
      if (nodeMatchesSelector(respThinking, sel)) return respThinking;
      for (const ch of respThinking.children) {
        if (nodeMatchesSelector(ch, sel)) return ch;
      }
      return null;
    },
  };

  const statusThinking = checkTurnStatus(docThinking, 0, "Run security audit");
  assert.equal(statusThinking.targetFound, true, "Target must be found");
  assert.equal(statusThinking.hasStopButton, false, "Stop button is absent");
  assert.equal(statusThinking.isBusyOrThinking, true, "mat-spinner marks turn as busy/thinking");
  assert.equal(statusThinking.hasFinishedContent, true, "Text is present in message-content");
  assert.equal(statusThinking.hasActionButtons, false, "Action buttons absent during thinking");
  assert.equal(
    isTurnComplete(statusThinking, { stableMs: 1000 }),
    false,
    "Turn must NOT complete while thinking indicator is active even if stable for 1s"
  );

  // --- Scenario 2: Thinking indicator gone, but action buttons not yet rendered (pause/transition) ---
  respThinking.children = [mcThinking]; // remove spinner
  const statusPause = checkTurnStatus(docThinking, 0, "Run security audit");
  assert.equal(statusPause.isBusyOrThinking, false, "Spinner gone");
  assert.equal(statusPause.hasActionButtons, false, "Action buttons still absent");
  assert.equal(
    isTurnComplete(statusPause, { stableMs: 500 }),
    false,
    "Turn must NOT complete after 500ms when action buttons are absent"
  );
  assert.equal(
    isTurnComplete(statusPause, { stableMs: 2500 }),
    false,
    "Turn must NOT complete after 2.5s when action buttons are absent"
  );
  assert.equal(
    isTurnComplete(statusPause, { stableMs: 5000 }),
    true,
    "Fallback stability (5s) allows completion if action buttons never appear"
  );

  // --- Scenario 3: Completed response with action buttons (Copy / Good response) ---
  const copyBtn = createMockElement({
    tagName: "button",
    attributes: { "aria-label": "Copy message", "data-test-id": "copy-button" },
  });
  const feedbackContainer = createMockElement({
    tagName: "response-feedback",
    children: [copyBtn],
  });
  const mcCompleted = createMockElement({
    tagName: "message-content",
    innerText: "Full audit complete: 0 vulnerabilities found.",
  });
  const respCompleted = createMockElement({
    id: "resp-1",
    tagName: "model-response",
    children: [mcCompleted, feedbackContainer],
    preceding: ["query-0"],
  });

  const docCompleted = {
    querySelectorAll(sel) {
      if (sel === "model-response") return [respCompleted];
      if (sel === "user-query") return [queryNode];
      return [];
    },
    querySelector() {
      return null;
    },
  };

  const statusCompleted = checkTurnStatus(docCompleted, 0, "Run security audit");
  assert.equal(statusCompleted.hasActionButtons, true, "Copy button detected as action marker");
  assert.equal(statusCompleted.isBusyOrThinking, false);
  assert.equal(statusCompleted.hasStopButton, false);
  assert.equal(statusCompleted.hasFinishedContent, true);
  assert.equal(isTurnComplete(statusCompleted, { stableMs: 100 }), false, "Must wait for stable duration");
  assert.equal(isTurnComplete(statusCompleted, { stableMs: 500 }), true, "Completes promptly at 500ms");

  // --- Scenario 4: Avatar image before message-content exists ---
  const avatarImg = createMockElement({
    tagName: "img",
    attributes: { class: "avatar", src: "https://avatar.png" },
  });
  const respAvatarOnly = createMockElement({
    id: "resp-2",
    tagName: "model-response",
    children: [avatarImg],
    preceding: ["query-0"],
  });
  const docAvatar = {
    querySelectorAll(sel) {
      if (sel === "model-response") return [respAvatarOnly];
      if (sel === "user-query") return [queryNode];
      return [];
    },
    querySelector() {
      return null;
    },
  };
  const statusAvatar = checkTurnStatus(docAvatar, 0, "Run security audit");
  assert.equal(statusAvatar.hasFinishedContent, false, "Avatar img must NOT count as finished content");
  assert.equal(isTurnComplete(statusAvatar, { stableMs: 5000 }), false, "Must NOT complete without finished content");

  // --- Scenario 5: Stop button present ---
  const stopButtonEl = createMockElement({
    tagName: "button",
    attributes: { "aria-label": "Stop generating", "data-test-id": "stop-button" },
  });
  const docWithStop = {
    querySelectorAll(sel) {
      if (sel === "model-response") return [respCompleted];
      if (sel === "user-query") return [queryNode];
      return [];
    },
    querySelector(sel) {
      if (nodeMatchesSelector(stopButtonEl, sel)) return stopButtonEl;
      return null;
    },
  };
  const statusWithStop = checkTurnStatus(docWithStop, 0, "Run security audit");
  assert.equal(statusWithStop.hasStopButton, true, "Stop button detected");
  assert.equal(isTurnComplete(statusWithStop, { stableMs: 10000 }), false, "Must NOT complete while stop button exists");

  // --- Scenario 6: aria-busy, shimmer, thinking-indicator ---
  const respBusy = createMockElement({
    id: "resp-busy",
    tagName: "model-response",
    attributes: { "aria-busy": "true" },
    children: [mcThinking],
    preceding: ["query-0"],
  });
  const docBusy = {
    querySelectorAll(sel) {
      if (sel === "model-response") return [respBusy];
      if (sel === "user-query") return [queryNode];
      return [];
    },
    querySelector() {
      return null;
    },
  };
  const statusBusy = checkTurnStatus(docBusy, 0, "Run security audit");
  assert.equal(statusBusy.isBusyOrThinking, true, "aria-busy marks turn as busy");
  assert.equal(
    isTurnComplete(statusBusy, { stableMs: 10000 }),
    false,
    "aria-busy blocks completion even after 10s of textual stability"
  );

  // --- Scenario 6b: shimmer indicator via class substring (no stop button, 42-char text) ---
  const shimmerNode = createMockElement({
    tagName: "div",
    attributes: { class: "skeleton-shimmer" },
  });
  const mcShimmer = createMockElement({
    tagName: "message-content",
    innerText: "Analyzing repository architecture and files", // 42 chars
  });
  const respShimmer = createMockElement({
    id: "resp-shimmer",
    tagName: "model-response",
    children: [mcShimmer, shimmerNode],
    preceding: ["query-shimmer"],
  });
  const queryShimmer = createMockElement({
    id: "query-shimmer",
    tagName: "user-query",
    innerText: "Run security audit",
    following: ["resp-shimmer"],
  });
  const docShimmer = {
    querySelectorAll(sel) {
      if (sel === "model-response") return [respShimmer];
      if (sel === "user-query") return [queryShimmer];
      return [];
    },
    querySelector() {
      return null;
    },
  };
  const statusShimmer = checkTurnStatus(docShimmer, 0, "Run security audit");
  assert.equal(statusShimmer.targetFound, true, "Shimmer target must be found");
  assert.equal(statusShimmer.hasStopButton, false, "Stop button is absent during shimmer");
  assert.equal(statusShimmer.isBusyOrThinking, true, "shimmer class marks turn as busy");
  assert.equal(statusShimmer.hasFinishedContent, true, "42-char thinking fragment is present");
  assert.equal(
    isTurnComplete(statusShimmer, { stableMs: 10000 }),
    false,
    "Turn must NOT complete while shimmer indicator is active"
  );

  // --- Scenario 6c: thinking-indicator element (no stop button, 42-char text) ---
  const thinkingIndicatorNode = createMockElement({
    tagName: "thinking-indicator",
    attributes: { class: "thinking-indicator" },
  });
  const mcThinkingIndicator = createMockElement({
    tagName: "message-content",
    innerText: "Analyzing repository architecture and files", // 42 chars
  });
  const respThinkingIndicator = createMockElement({
    id: "resp-thinking-indicator",
    tagName: "model-response",
    children: [mcThinkingIndicator, thinkingIndicatorNode],
    preceding: ["query-thinking-indicator"],
  });
  const queryThinkingIndicator = createMockElement({
    id: "query-thinking-indicator",
    tagName: "user-query",
    innerText: "Run security audit",
    following: ["resp-thinking-indicator"],
  });
  const docThinkingIndicator = {
    querySelectorAll(sel) {
      if (sel === "model-response") return [respThinkingIndicator];
      if (sel === "user-query") return [queryThinkingIndicator];
      return [];
    },
    querySelector() {
      return null;
    },
  };
  const statusThinkingIndicator = checkTurnStatus(docThinkingIndicator, 0, "Run security audit");
  assert.equal(statusThinkingIndicator.targetFound, true, "thinking-indicator target must be found");
  assert.equal(statusThinkingIndicator.hasStopButton, false, "Stop button is absent during thinking-indicator");
  assert.equal(
    statusThinkingIndicator.isBusyOrThinking,
    true,
    "thinking-indicator element marks turn as busy"
  );
  assert.equal(statusThinkingIndicator.hasFinishedContent, true, "42-char thinking fragment is present");
  assert.equal(
    isTurnComplete(statusThinkingIndicator, { stableMs: 10000 }),
    false,
    "Turn must NOT complete while thinking-indicator is active"
  );

  // --- Scenario 7: Full integration test with sendPrompt simulating thinking phase ---
  let evalStep = 0;
  const streamedChunks = [];
  const mockPage = {
    url: () => (evalStep >= 3 ? "https://gemini.google.com/app/deadbeefcafef00d" : "https://gemini.google.com/app"),
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async () => null,
    $$: async () => [],
    evaluate: async (fn, arg) => {
      evalStep++;
      if (typeof fn === "function" && fn.toString().includes("maxLength")) {
        return null;
      }
      if (arg && arg.sel) {
        return true;
      }
      if (arg && arg.fnSrc && !arg.checkSrc) {
        return true;
      }
      if (arg && arg.checkSrc) {
        if (evalStep <= 4) {
          return {
            targetFound: true,
            hasStopButton: false,
            isBusyOrThinking: true,
            hasFinishedContent: true,
            hasActionButtons: false,
            currentText: { src: "mc", text: "Analyzing repository architecture and files" },
          };
        }
        return {
          targetFound: true,
          hasStopButton: false,
          isBusyOrThinking: false,
          hasFinishedContent: true,
          hasActionButtons: true,
          currentText: {
            src: "mc",
            text: "Full 11799 character completed response without early cutoff.",
          },
        };
      }
      return null;
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => mockPage,
  });

  try {
    const res = await sendPrompt({
      prompt: "Full audit prompt",
      isNewChat: true,
      onChunk: (c) => streamedChunks.push(c),
    });

    assert.equal(
      String(res),
      "Full 11799 character completed response without early cutoff.",
      "sendPrompt must return full completed response, not truncated 42-char thinking text"
    );
    assert.equal(res.convId, "deadbeefcafef00d", "sendPrompt must capture convId from url");
    assert.ok(streamedChunks.length > 0, "onChunk must have received stream chunks");
    assert.equal(
      streamedChunks.join(""),
      "Full 11799 character completed response without early cutoff.",
      "Streamed chunks must match full text"
    );
  } finally {
    _setDriverHooks(null);
  }

  // --- Scenario 8: stability threshold resets when answer text grows ---
  // Fake clock makes waitForTimeout advance Date.now deterministically, so a
  // stale stability window would finish the turn at the first text growth.
  const realDateNow = Date.now;
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  const growthTexts = [
    "Seed",
    "Seed",
    "Seed",
    "Seed and more",
    "Seed and more",
    "Seed and more still",
    "Seed and more still and",
    "Seed and more still and final",
  ];
  const finalGrowthText = growthTexts[growthTexts.length - 1];
  const lastGrowthPoll = growthTexts.length - 1;
  let growthPoll = 0;
  let lastGrowthAt = null;
  const growthChunks = [];
  const growthPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async () => {
      fakeNow += 200;
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async () => null,
    $$: async () => [],
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) {
        return null;
      }
      if (arg && arg.sel) {
        return true;
      }
      if (arg && arg.fnSrc && !arg.checkSrc) {
        return true;
      }
      if (arg && arg.checkSrc) {
        const poll = growthPoll++;
        const text = poll < growthTexts.length ? growthTexts[poll] : finalGrowthText;
        if (poll === lastGrowthPoll) lastGrowthAt = fakeNow;
        return {
          targetFound: true,
          hasStopButton: false,
          isBusyOrThinking: false,
          hasFinishedContent: true,
          hasActionButtons: true,
          currentText: { src: "mc", text },
        };
      }
      return null;
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => growthPage,
  });

  try {
    const res = await sendPrompt({
      prompt: "Stability reset audit",
      isNewChat: false,
      onChunk: (c) => growthChunks.push(c),
    });

    assert.equal(
      String(res),
      finalGrowthText,
      "Turn must not complete on a stale stability window while text is still growing"
    );
    assert.equal(
      growthChunks.join(""),
      finalGrowthText,
      "Every growth segment must stream as a chunk in order"
    );
    assert.ok(lastGrowthAt !== null, "Last text growth must be observed");
    assert.ok(
      fakeNow - lastGrowthAt >= 500,
      "Completion must wait the full 500ms stability window after the last growth"
    );
    assert.ok(
      growthPoll >= lastGrowthPoll + 3,
      "Driver must keep polling for at least 500ms after the last growth"
    );
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("33. PLUG-371: generation stall detection (no-progress), auto-retry, and session cap", async () => {
  // --- 1. classifyFailure: stalled generation classified as transient ---
  const errStalled = new Error("generation stalled — no progress for 120s");
  errStalled.code = "WEB_GEMINI_STALLED";
  const cStalled = classifyFailure(errStalled);
  assert.equal(cStalled.category, "transient", "WEB_GEMINI_STALLED must be classified as transient");
  assert.equal(cStalled.rotatable, true, "stalled failure must be rotatable");
  assert.equal(cStalled.cooldownMs, 0, "stalled failure must not cool down account");
  assert.equal(cStalled.parkedReason, null, "stalled failure must not park account");

  const errArgonStalled = new Error("stalled generation");
  errArgonStalled.code = "ARGON_STALLED";
  const cArgonStalled = classifyFailure(errArgonStalled);
  assert.equal(cArgonStalled.category, "transient");
  assert.equal(cArgonStalled.rotatable, true);

  const cMsgStalled = classifyFailure(new Error("web driver: stalled generation — aborting"));
  assert.equal(cMsgStalled.category, "transient");

  // --- 2. createTaskTurn: generation phase decouples deadline to sessionCapAt ---
  const turn = createTaskTurn("sess-plug371-turn");
  assert.ok(turn.started > 0);
  assert.equal(turn.sessionCapAt, turn.started + 4 * 3600_000, "sessionCapAt must be 4h (14400s) safety ceiling");
  assert.equal(turn.deadline, turn.started + 20 * 60_000, "Initial stage deadline must be SEND_DEADLINE_MS (20m)");

  // Ping generation stage: deadline expands to sessionCapAt
  turn.ping("generation");
  assert.equal(turn.deadline, turn.sessionCapAt, "Generation stage must decouple deadline to sessionCapAt (4h)");

  // Heartbeat ping of the SAME stage must not slide the deadline
  const genDeadline = turn.deadline;
  await new Promise((r) => setTimeout(r, 30));
  turn.ping("generation");
  assert.equal(turn.deadline, genDeadline, "Repeated ping of same stage must not move the deadline");

  // onDeadlineChange fires only when the deadline is re-armed
  let watchCalls = 0;
  turn.onDeadlineChange = () => { watchCalls += 1; };
  turn.ping("request_more");
  assert.ok(turn.deadline <= Date.now() + 20 * 60_000, "Leaving generation must restore the SEND_DEADLINE_MS window");
  assert.ok(turn.deadline < genDeadline, "Post-generation window must be below the session cap");
  assert.equal(watchCalls, 1, "Deadline change must notify the watcher exactly once");
  turn.ping("delivery");
  assert.equal(watchCalls, 1, "Transition between non-generation stages keeps the armed deadline");
  turn.onDeadlineChange = null;

  // Ping verify stage: deadline returns to bounded phase budget
  turn.ping("verify");
  assert.ok(turn.deadline <= Date.now() + 20 * 60_000, "Non-generation stage must be bounded by SEND_DEADLINE_MS");
  const verifyDeadline = turn.deadline;
  await new Promise((r) => setTimeout(r, 30));
  turn.ping("verify");
  assert.equal(turn.deadline, verifyDeadline, "Heartbeat ping on verify must not slide the deadline");

  // Task turn outcome recording for stalled
  await turn.finish("failed", "stalled");

  // --- 3. Driver boundary Scenario A: no text growth + stop button -> stalled ---
  let stopClicked = false;
  let fakeNowA = 1_000_000;
  let stallFirstPollAt = null;
  const realDateNow = Date.now;
  Date.now = () => fakeNowA;

  const stallPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNowA += ms;
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async (sel) => {
      if (sel && /stop/i.test(sel)) {
        return {
          click: async () => {
            stopClicked = true;
          },
          isDisabled: async () => false,
        };
      }
      return null;
    },
    $$: async () => [],
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        stallFirstPollAt ??= fakeNowA;
        return {
          targetFound: true,
          hasStopButton: true,
          isBusyOrThinking: false,
          hasFinishedContent: false,
          hasActionButtons: false,
          childCount: 1,
          currentText: { src: "mc", text: "Frozen partial response" },
        };
      }
      return null;
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => stallPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "Stall test prompt",
        isNewChat: false,
        stallMs: 600,
      }),
      (err) => {
        assert.equal(err.code, "WEB_GEMINI_STALLED", "Error code must be WEB_GEMINI_STALLED");
        assert.match(
          err.message,
          /generation stalled — no progress for/i,
          "Message must state generation stalled"
        );
        return true;
      }
    );
    assert.equal(stopClicked, true, "stopGeneration must be invoked to stop the hung generation");
    const stalledAfterMs = fakeNowA - stallFirstPollAt;
    assert.ok(
      stalledAfterMs >= 600 - 200 && stalledAfterMs <= 600 + 3 * 200,
      `stalled must fire at ~stallMs (600ms) from stream start, got ${stalledAfterMs}ms after first status poll`
    );
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }

  // --- 3b. Driver boundary Scenario D: stop button gone + no finished content -> stalled ---
  // Post-generation limbo must not hang up to the session cap.
  let fakeNowD = 1_000_000;
  let limboFirstPollAt = null;
  Date.now = () => fakeNowD;

  const limboPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNowD += ms;
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async () => null,
    $$: async () => [],
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        limboFirstPollAt ??= fakeNowD;
        return {
          targetFound: true,
          hasStopButton: false,
          isBusyOrThinking: false,
          hasFinishedContent: false,
          hasActionButtons: false,
          childCount: 1,
          targetTextLength: 0,
          currentText: { src: "raw", text: "" },
        };
      }
      return null;
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => limboPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "Post-generation limbo prompt",
        isNewChat: false,
        stallMs: 600,
      }),
      (err) => {
        assert.equal(err.code, "WEB_GEMINI_STALLED", "Limbo without content must fail fast as WEB_GEMINI_STALLED");
        return true;
      }
    );
    const limboMs = fakeNowD - limboFirstPollAt;
    assert.ok(
      limboMs >= 600 - 200 && limboMs <= 600 + 3 * 200,
      `limbo must fail fast at ~stallMs (600ms), got ${limboMs}ms after first status poll`
    );
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }

  // --- 4. Driver boundary Scenario B: slow text growth -> NOT stalled ---
  let fakeNowB = 1_000_000;
  Date.now = () => fakeNowB;
  let slowPoll = 0;

  const slowPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNowB += ms;
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async (sel) => {
      if (sel && /stop/i.test(sel) && slowPoll < 5) {
        return { click: async () => {}, isDisabled: async () => false };
      }
      return null;
    },
    $$: async () => [],
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        const p = Math.min(slowPoll++, 5);
        const text = "Incremental output chunk " + p;
        const isDone = p >= 5;
        return {
          targetFound: true,
          hasStopButton: !isDone,
          isBusyOrThinking: false,
          hasFinishedContent: true,
          hasActionButtons: isDone,
          childCount: p + 1,
          currentText: { src: "mc", text },
        };
      }
      return null;
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => slowPage,
  });

  try {
    const resSlow = await sendPrompt({
      prompt: "Slow progress prompt",
      isNewChat: false,
      stallMs: 500,
    });
    assert.equal(
      String(resSlow),
      "Incremental output chunk 5",
      "Turn must complete successfully when text grows slowly without hitting stallMs"
    );
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }

  // --- 5. Driver boundary Scenario C: continuous generation past 20 minutes (25 min simulated) ---
  let fakeNowC = 1_000_000;
  Date.now = () => fakeNowC;
  let longPoll = 0;

  const longPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      // Advance by 30 seconds of simulated time per poll while generating (total 50 polls = 1500s = 25m)
      fakeNowC += (longPoll <= 50 ? 30_000 : ms);
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async (sel) => {
      if (sel && /stop/i.test(sel) && longPoll < 50) {
        return { click: async () => {}, isDisabled: async () => false };
      }
      return null;
    },
    $$: async () => [],
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        const p = Math.min(longPoll++, 50);
        const isDone = p >= 50;
        return {
          targetFound: true,
          hasStopButton: !isDone,
          isBusyOrThinking: false,
          hasFinishedContent: true,
          hasActionButtons: isDone,
          childCount: p + 1,
          currentText: { src: "mc", text: "Long active generation token ".repeat(p + 1).trim() },
        };
      }
      return null;
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => longPage,
  });

  try {
    const resLong = await sendPrompt({
      prompt: "25-minute continuous generation prompt",
      isNewChat: false,
      stallMs: 60_000,
    });
    assert.ok(
      fakeNowC - 1_000_000 >= 1_500_000,
      "Simulated elapsed time must exceed 20-minute (1200s) former deadline (25 minutes reached)"
    );
    assert.ok(
      String(resLong).startsWith("Long active generation token"),
      "Continuous generation past 20 minutes must succeed without stall or deadline exceeded"
    );
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("34. PLUG-371 e2e: real runPrompt stall-retry, budget cutoff, rotation, and generation past SEND_DEADLINE", async (t) => {
  const fixtureScript = path.join("tests", "fixtures", "stall-server.mjs");
  const fakeBb = path.join(PLUGIN_ROOT, "tests", "fixtures", "fake-bb.sh");
  const threadId = "t" + "hr_fixture371";
  const projectId = "p" + "roj_fixture371";
  const envId = "e" + "nv_fixture371";
  const backendsEnv = JSON.stringify([
    { id: "acc-1", cdp: "9301" },
    { id: "acc-2", cdp: "9302" },
  ]);

  async function runFixture({ scenario, delayMs, sendDeadlineMs = 20000, sessionCapMs = 120000 }) {
    const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "wg-stall-state-")));
    const cwdDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "wg-stall-cwd-")));
    const logFile = path.join(stateDir, "driver-calls.jsonl");
    const threadDto = {
      thread: { id: threadId, projectId, environmentId: envId, originPluginId: "orchestrator" },
      environment: { id: envId, path: fs.realpathSync(cwdDir), projectId },
    };
    const serverProc = spawnServer({
      ...process.env,
      WEB_GEMINI_STATE_DIR: stateDir,
      WEB_GEMINI_BACKENDS: backendsEnv,
      WEB_GEMINI_SEND_DEADLINE_MS: String(sendDeadlineMs),
      WEB_GEMINI_SESSION_CAP_MS: String(sessionCapMs),
      WG_FAKE_SCENARIO: scenario,
      WG_FAKE_DELAY_MS: String(delayMs ?? 0),
      WG_FAKE_LOG: logFile,
      BB_CLI: fakeBb,
      FAKE_BB_THREAD_JSON: JSON.stringify(threadDto),
    }, fixtureScript, [`--bb-thread-id=${threadId}`]);

    const lines = [];
    let stderrBuf = "";
    serverProc.stdout.on("data", (data) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) {
          try {
            lines.push(JSON.parse(line.trim()));
          } catch {}
        }
      }
    });
    serverProc.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    const sendReq = (req) => serverProc.stdin.write(JSON.stringify(req) + "\n");
    const waitForResponse = async (id, timeoutMs = 30000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const idx = lines.findIndex((l) => l.id === id);
        if (idx >= 0) return lines.splice(idx, 1)[0];
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error(`Timeout waiting for response id=${id}\nstderr: ${stderrBuf.slice(-2000)}`);
    };

    sendReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await waitForResponse(1);
    sendReq({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: cwdDir } });
    const r2 = await waitForResponse(2, 15000);
    assert.ok(r2.result?.sessionId, `session/new must return a session: ${JSON.stringify(r2)} stderr: ${stderrBuf.slice(-2000)}`);
    const sessionId = r2.result.sessionId;
    sendReq({
      jsonrpc: "2.0", id: 3, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "run the stall scenario" }] },
    });
    const r3 = await waitForResponse(3, 90000);
    serverProc.kill("SIGTERM");
    const calls = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const serverLog = fs.existsSync(path.join(stateDir, "acp-server.log"))
      ? fs.readFileSync(path.join(stateDir, "acp-server.log"), "utf8")
      : "";
    return { response: r3, calls, serverLog, stderr: stderrBuf };
  }

  await t.test("stall with >25% phase budget retries once on a sibling account and passes", async () => {
    const { response, calls, serverLog } = await runFixture({ scenario: "stall-then-ok", sendDeadlineMs: 20000 });
    assert.equal(response.result?.stopReason, "end_turn", `turn must pass after stall retry: ${JSON.stringify(response)}`);
    assert.equal(calls.length, 2, "driver must be called exactly twice (initial attempt + stall retry)");
    assert.ok(calls[0].accountId && calls[1].accountId, "driver log must record the bound account per attempt");
    assert.notEqual(calls[0].accountId, calls[1].accountId, "stall retry must rotate to a different pool account");
    assert.match(serverLog, /task:stall-retry/, "stall retry must be logged");
    assert.match(serverLog, /task:outcome.*"outcome":"passed"/, "task outcome must be passed");
  });

  await t.test("stall with <=25% phase budget fails with reason stalled and no retry", async () => {
    const { response, calls, serverLog } = await runFixture({ scenario: "stall-late", delayMs: 9500, sendDeadlineMs: 12000 });
    assert.equal(response.error?.code, -32000, `turn must fail: ${JSON.stringify(response)}`);
    assert.match(response.error?.data?.reason, /^stalled\b/, `failure reason must be stalled: ${JSON.stringify(response)}`);
    assert.equal(calls.length, 1, "no retry once the phase budget is exhausted");
    assert.match(serverLog, /task:outcome.*"reason":"stalled/, "task:outcome must record reason stalled");
    assert.doesNotMatch(serverLog, /task:stall-retry/);
  });

  await t.test("generation running past SEND_DEADLINE succeeds under the session cap", async () => {
    const startedAt = Date.now();
    const { response, calls } = await runFixture({ scenario: "ok", delayMs: 6000, sendDeadlineMs: 3000, sessionCapMs: 60000 });
    const elapsed = Date.now() - startedAt;
    assert.equal(response.result?.stopReason, "end_turn", `generation past SEND_DEADLINE must pass: ${JSON.stringify(response)}`);
    assert.ok(elapsed >= 6000, `turn must not be cut at the ${3000}ms phase deadline (elapsed ${elapsed}ms)`);
    assert.equal(calls.length, 1);
  });

  await t.test("stall on a follow-up round with established convId never retries", async () => {
    const { response, calls, serverLog } = await runFixture({ scenario: "tool-then-stall", sendDeadlineMs: 20000 });
    assert.equal(response.error?.code, -32000, `turn must fail: ${JSON.stringify(response)}`);
    assert.match(response.error?.data?.reason, /^stalled\b/, `failure reason must be stalled: ${JSON.stringify(response)}`);
    assert.equal(calls.length, 2, "no stall retry once the conversation is bound to a backend (convId set)");
    assert.doesNotMatch(serverLog, /task:stall-retry/);
  });
});
test("21. PLUG-376: collectGeneratedFiles channels — fetch->blob, new tab, force-click, Drive gate", async () => {
  const dlDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "plug376-dl-")));
  const scanOf = (candidates, meta = {}) => ({ candidates, meta });
  const neverEvent = () => new Promise(() => {});

  /* --- A. fetch->blob: download-ивента нет, файл собран через blob-хук --- */
  const blobPayload = Buffer.from("PNG-BLOB-DATA");
  let blobReady = false;
  const blobPage = {
    evaluate: async (fn, arg) => {
      if (arg && arg.candSrc) {
        return scanOf([{ kind: "click", tag: "n0-0", name: "Скачать изображение" }]);
      }
      if (arg && typeof arg.url === "string" && arg.url.startsWith("blob:")) {
        return { b64: blobPayload.toString("base64"), mime: "image/png" };
      }
      if (arg && typeof arg.since === "number") {
        return blobReady ? [{ url: "blob:https://gemini.google.com/uuid-9", type: "image/png", ts: Date.now() }] : [];
      }
      return null;
    },
    $: async () => ({ click: async () => { blobReady = true; } }),
    context: () => ({ request: { get: async () => { throw new Error("must not fetch"); } } }),
    waitForEvent: neverEvent,
  };
  const collBlob = await collectGeneratedFiles(blobPage, { dir: dlDir, sessionId: "s-a" });
  assert.equal(collBlob.files.length, 1, `blob file expected, got ${JSON.stringify(collBlob)}`);
  assert.equal(collBlob.skipped.length, 0);
  assert.equal(fs.readFileSync(collBlob.files[0].path, "utf8"), "PNG-BLOB-DATA");
  assert.equal(collBlob.files[0].mimeType, "image/png");

  /* --- B. Новая вкладка: URL страницы стянут через request-контекст --- */
  let emitNewPage = null;
  let newPageClosed = false;
  const imgPayload = Buffer.from("FULL-SIZE-IMG");
  const newTabPage = {
    evaluate: async (fn, arg) => {
      if (arg && arg.candSrc) {
        return scanOf([{ kind: "click", tag: "n0-1", name: "Скачать изображение в полном размере" }]);
      }
      return null;
    },
    $: async () => ({ click: async () => { if (emitNewPage) await emitNewPage(); } }),
    context: () => ({
      once: (ev, fn) => {
        if (ev === "page") {
          emitNewPage = async () =>
            fn({
              url: () => "https://lh3.googleusercontent.com/full/img.png",
              waitForLoadState: async () => {},
              close: async () => { newPageClosed = true; },
            });
        }
      },
      request: {
        get: async (url) => {
          assert.equal(url, "https://lh3.googleusercontent.com/full/img.png");
          return {
            ok: () => true,
            headers: () => ({
              "content-disposition": 'attachment; filename="full.png"',
              "content-type": "image/png",
            }),
            body: async () => imgPayload,
          };
        },
      },
    }),
    waitForEvent: neverEvent,
  };
  const collTab = await collectGeneratedFiles(newTabPage, { dir: dlDir, sessionId: "s-b" });
  assert.equal(collTab.files.length, 1, `new-tab file expected, got ${JSON.stringify(collTab)}`);
  assert.equal(collTab.skipped.length, 0);
  assert.equal(collTab.files[0].name, "full.png");
  assert.equal(fs.readFileSync(collTab.files[0].path, "utf8"), "FULL-SIZE-IMG");
  assert.ok(newPageClosed, "opened tab must be closed");

  /* --- C. Нестабильный элемент: обычный click падает, force-путь срабатывает --- */
  let clickCalls = [];
  const forcePage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc ? scanOf([{ kind: "click", tag: "n0-2", name: "Скачать код" }]) : null,
    $: async () => ({
      scrollIntoViewIfNeeded: async () => {},
      click: async (opts) => {
        clickCalls.push(opts);
        if (!opts || opts.force !== true) throw new Error("element is not stable");
      },
      dispatchEvent: async () => {},
    }),
    context: () => ({ request: { get: async () => { throw new Error("must not fetch"); } } }),
    waitForEvent: async (ev) => {
      assert.equal(ev, "download");
      return {
        suggestedFilename: () => "code.html",
        url: () => "https://gemini.google.com/dl/code",
        saveAs: async (p) => fs.writeFileSync(p, "CODE-BODY"),
      };
    },
  };
  const collForce = await collectGeneratedFiles(forcePage, { dir: dlDir, sessionId: "s-c" });
  assert.equal(collForce.files.length, 1, `force-click file expected, got ${JSON.stringify(collForce)}`);
  assert.equal(collForce.skipped.length, 0);
  assert.equal(collForce.files[0].name, "code.html");
  assert.equal(fs.readFileSync(collForce.files[0].path, "utf8"), "CODE-BODY");
  assert.equal(clickCalls.length, 2, "plain click must fail, then force retry");
  assert.equal(clickCalls[1].force, true);

  /* --- D. Drive-гейт: новая вкладка на docs.google.com --- */
  let emitDocsPage = null;
  const docsTabPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc ? scanOf([{ kind: "click", tag: "n0-3", name: "Экспортировать" }]) : null,
    $: async () => ({ click: async () => { if (emitDocsPage) await emitDocsPage(); } }),
    context: () => ({
      once: (ev, fn) => {
        if (ev === "page") {
          emitDocsPage = async () =>
            fn({
              url: () => "https://docs.google.com/presentation/d/abc/edit",
              waitForLoadState: async () => {},
              close: async () => {},
            });
        }
      },
      request: { get: async () => { throw new Error("drive viewer must not be fetched"); } },
    }),
    waitForEvent: neverEvent,
  };
  const collDocs = await collectGeneratedFiles(docsTabPage, { dir: dlDir, sessionId: "s-d" });
  assert.equal(collDocs.files.length, 0);
  assert.equal(collDocs.skipped.length, 1);
  assert.match(collDocs.skipped[0].reason, /requires Google Drive integration/);

  /* --- E. Drive-гейт и неэкспортируемый контент из скана DOM --- */
  const gatePage = {
    evaluate: async () => scanOf([], { driveGate: true }),
    context: () => ({ request: { get: async () => ({}) } }),
  };
  const collGate = await collectGeneratedFiles(gatePage, { dir: dlDir, sessionId: "s-e" });
  assert.equal(collGate.files.length, 0);
  assert.deepEqual(collGate.skipped, [{ name: "generated file", reason: "requires Google Drive integration" }]);

  const asyncPage = {
    evaluate: async () => scanOf([], { nonExportable: true, mediaKind: "async media" }),
    context: () => ({ request: { get: async () => ({}) } }),
  };
  const collAsync = await collectGeneratedFiles(asyncPage, { dir: dlDir, sessionId: "s-e2" });
  assert.equal(collAsync.files.length, 0);
  assert.deepEqual(collAsync.skipped, [
    { name: "generated async media", reason: "файл не экспортируем в этом ходе" },
  ]);
});

test("22. PLUG-376 review fixes: response channel, host/redirect re-checks, about:blank tab, listener cleanup", async () => {
  const dlDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "plug376b-dl-")));
  const scanOf = (candidates, meta = {}) => ({ candidates, meta });
  const neverEvent = () => new Promise(() => {});

  /* --- F. Сетевой ответ-файл: body сохранён; чужой хост и телеметрия не побеждают --- */
  const respPayload = Buffer.from("RESP-FILE-BODY");
  let respFire = null;
  const respPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc ? scanOf([{ kind: "click", tag: "n0-4", name: "Экспортировать" }]) : null,
    $: async () => ({
      click: async () => {
        respFire({
          url: () => "https://evil.example.com/track.bin",
          status: () => 200,
          headers: () => ({ "content-type": "application/octet-stream" }),
          body: async () => Buffer.from("EVIL"),
        });
        respFire({
          url: () => "https://gemini.google.com/_/data/batchexecute",
          status: () => 200,
          headers: () => ({ "content-type": "application/octet-stream" }),
          body: async () => Buffer.from("RPC"),
        });
        respFire({
          url: () => "https://gemini.google.com/dl/report",
          status: () => 200,
          headers: () => ({
            "content-disposition": 'attachment; filename="report.csv"',
            "content-type": "text/csv",
          }),
          body: async () => respPayload,
        });
      },
    }),
    context: () => ({ request: { get: async () => { throw new Error("must not fetch"); } } }),
    on: (ev, fn) => {
      if (ev === "response") respFire = fn;
    },
    off: () => {},
    waitForEvent: neverEvent,
  };
  const collResp = await collectGeneratedFiles(respPage, { dir: dlDir, sessionId: "s-f" });
  assert.equal(collResp.files.length, 1, `response file expected, got ${JSON.stringify(collResp)}`);
  assert.equal(collResp.skipped.length, 0);
  assert.equal(collResp.files[0].name, "report.csv");
  assert.equal(fs.readFileSync(collResp.files[0].path, "utf8"), "RESP-FILE-BODY");

  /* --- G. Link на docs.google.com — Drive-гейт без запроса --- */
  const getCalls = [];
  const gateLinkPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc
        ? scanOf([
            { kind: "link", tag: "n0-5", href: "https://docs.google.com/document/d/x", name: "doc", canClick: false },
          ])
        : null,
    context: () => ({
      request: {
        get: async (u) => {
          getCalls.push(u);
          throw new Error("must not fetch drive viewer");
        },
      },
    }),
  };
  const collGateLink = await collectGeneratedFiles(gateLinkPage, { dir: dlDir, sessionId: "s-g" });
  assert.equal(collGateLink.files.length, 0);
  assert.deepEqual(collGateLink.skipped, [{ name: "doc", reason: "requires Google Drive integration" }]);
  assert.equal(getCalls.length, 0, "drive link must not be fetched");

  /* --- H. Link с редиректом на чужой хост — финальный URL проверяется --- */
  const redirPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc
        ? scanOf([
            { kind: "link", tag: "n0-6", href: "https://gemini.google.com/dl/x", name: "file.bin", canClick: false },
          ])
        : null,
    context: () => ({
      request: {
        get: async () => ({
          ok: () => true,
          url: () => "https://cdn.evil.example.com/f.bin",
          headers: () => ({ "content-type": "application/octet-stream" }),
          body: async () => Buffer.from("EVIL-REDIR"),
        }),
      },
    }),
  };
  const collRedir = await collectGeneratedFiles(redirPage, { dir: dlDir, sessionId: "s-h" });
  assert.equal(collRedir.files.length, 0);
  assert.equal(collRedir.skipped.length, 1);
  assert.match(collRedir.skipped[0].reason, /host not allowed \(cdn\.evil\.example\.com\)/);

  /* --- I. Новая вкладка about:blank → позже реальный URL: собираем --- */
  let emitTab = null;
  let tabClosed = false;
  const tabState = { url: "about:blank" };
  const blankTabPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc ? scanOf([{ kind: "click", tag: "n0-7", name: "Открыть файл" }]) : null,
    $: async () => ({
      click: async () => {
        if (emitTab) await emitTab();
        setTimeout(() => {
          tabState.url = "https://lh3.googleusercontent.com/doc.pdf";
        }, 150);
      },
    }),
    context: () => ({
      on: (ev, fn) => {
        if (ev === "page") {
          emitTab = async () =>
            fn({
              url: () => tabState.url,
              waitForLoadState: async () => {},
              close: async () => {
                tabClosed = true;
              },
            });
        }
      },
      off: () => {},
      request: {
        get: async (url) => ({
          ok: () => true,
          url: () => url,
          headers: () => ({ "content-type": "application/pdf" }),
          body: async () => Buffer.from("PDF-DATA"),
        }),
      },
    }),
    waitForEvent: neverEvent,
  };
  const collBlank = await collectGeneratedFiles(blankTabPage, { dir: dlDir, sessionId: "s-i" });
  assert.equal(collBlank.files.length, 1, `about:blank tab file expected, got ${JSON.stringify(collBlank)}`);
  assert.equal(collBlank.skipped.length, 0);
  assert.equal(fs.readFileSync(collBlank.files[0].path, "utf8"), "PDF-DATA");
  assert.ok(tabClosed, "opened tab must be closed");

  /* --- J. dispatchEvent-fallback: оба click падают, dispatch срабатывает --- */
  let dispatchUsed = false;
  let dlFireJ = null;
  const dlObjJ = {
    url: () => "https://gemini.google.com/dl/y",
    suggestedFilename: () => "disp.txt",
    saveAs: async (p) => fs.writeFileSync(p, "DISP-BODY"),
  };
  const dispPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc ? scanOf([{ kind: "click", tag: "n0-8", name: "Скачать" }]) : null,
    $: async () => ({
      scrollIntoViewIfNeeded: async () => {},
      click: async () => {
        throw new Error("element is not stable");
      },
      dispatchEvent: async () => {
        dispatchUsed = true;
        if (dlFireJ) dlFireJ(dlObjJ);
      },
    }),
    context: () => ({ request: { get: async () => { throw new Error("must not fetch"); } } }),
    on: (ev, fn) => {
      if (ev === "download") dlFireJ = fn;
    },
    off: () => {},
    waitForEvent: neverEvent,
  };
  const collDisp = await collectGeneratedFiles(dispPage, { dir: dlDir, sessionId: "s-j" });
  assert.equal(collDisp.files.length, 1, `dispatch file expected, got ${JSON.stringify(collDisp)}`);
  assert.equal(collDisp.files[0].name, "disp.txt");
  assert.ok(dispatchUsed, "dispatchEvent fallback must be used");

  /* --- K. Утечки нет: каждый кандидат снимает ctx 'page' и page-слушатели --- */
  const ctxOffCalls = [];
  const pageOffCalls = [];
  let dlFireK = null;
  const mkDl = (n) => ({
    url: () => "https://gemini.google.com/dl/z",
    suggestedFilename: () => n,
    saveAs: async (p) => fs.writeFileSync(p, `BODY-${n}`),
  });
  const leakPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc
        ? scanOf([
            { kind: "click", tag: "n0-9", name: "Скачать раз" },
            { kind: "click", tag: "n0-10", name: "Скачать два" },
          ])
        : null,
    $: async () => ({ click: async () => {} }),
    context: () => ({
      on: () => {},
      off: (ev) => {
        ctxOffCalls.push(ev);
      },
      request: { get: async () => { throw new Error("must not fetch"); } },
    }),
    on: (ev, fn) => {
      if (ev === "download") dlFireK = fn;
    },
    off: (ev) => {
      pageOffCalls.push(ev);
    },
    waitForEvent: neverEvent,
  };
  let kClicks = 0;
  leakPage.$ = async () => ({
    click: async () => {
      kClicks += 1;
      if (dlFireK) dlFireK(mkDl(`k${kClicks}.bin`));
    },
  });
  const collLeak = await collectGeneratedFiles(leakPage, { dir: dlDir, sessionId: "s-k" });
  assert.equal(collLeak.files.length, 2, `two files expected, got ${JSON.stringify(collLeak)}`);
  assert.deepEqual(ctxOffCalls, ["page", "page"], "ctx page listener must be removed per candidate");
  assert.ok(
    pageOffCalls.filter((e) => e === "download").length === 2 &&
      pageOffCalls.filter((e) => e === "response").length === 2,
    `page listeners must be removed per candidate, got ${JSON.stringify(pageOffCalls)}`
  );
});

test("23. PLUG-376 round 3: batchexecute/RPC & response.bin filtering, magic-bytes validation, and canvas fallback for images", async () => {
  const dlDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "plug376c-dl-")));
  const scanOf = (candidates, meta = {}) => ({ candidates, meta });
  const timeoutEvent = (ev, opts) =>
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), (opts && opts.timeout) || 50));

  /* --- A. Контракт 1 & 3: Content-Disposition attachment + image/png на batchexecute-URL с JSON-конвертом --- */
  let respFireA = null;
  const rpcPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc ? scanOf([{ kind: "click", tag: "n0-rpc", name: "Скачать" }]) : null,
    $: async () => ({
      click: async () => {
        if (respFireA) {
          respFireA({
            url: () => "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb",
            status: () => 200,
            headers: () => ({
              "content-disposition": 'attachment; filename="image.png"',
              "content-type": "image/png",
            }),
            body: async () => Buffer.from(")]}'\n1001\n[[\"wrb.fr\",null,null]]"),
          });
        }
      },
    }),
    context: () => ({ request: { get: async () => { throw new Error("must not fetch"); } } }),
    on: (ev, fn) => {
      if (ev === "response") respFireA = fn;
    },
    off: () => {},
    waitForEvent: timeoutEvent,
  };
  const collRpc = await collectGeneratedFiles(rpcPage, { dir: dlDir, sessionId: "s-rpc", clickWaitMs: 150 });
  assert.equal(collRpc.files.length, 0, `RPC response must not resolve as file: ${JSON.stringify(collRpc)}`);
  assert.equal(collRpc.skipped.length, 1);
  assert.match(collRpc.skipped[0].reason, /telemetry\/rpc/);

  /* --- B. response.bin как имя файла: служебный ответ отсекается наравне с batchexecute --- */
  let respFireB = null;
  const respBinPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc ? scanOf([{ kind: "click", tag: "n0-rbin", name: "Экспорт" }]) : null,
    $: async () => ({
      click: async () => {
        if (respFireB) {
          respFireB({
            url: () => "https://gemini.google.com/dl/file",
            status: () => 200,
            headers: () => ({
              "content-disposition": 'attachment; filename="response.bin"',
              "content-type": "application/octet-stream",
            }),
            body: async () => Buffer.from(")]}'\n1001\n[[\"wrb.fr\"]]"),
          });
        }
      },
    }),
    context: () => ({ request: { get: async () => { throw new Error("must not fetch"); } } }),
    on: (ev, fn) => {
      if (ev === "response") respFireB = fn;
    },
    off: () => {},
    waitForEvent: timeoutEvent,
  };
  const collRespBin = await collectGeneratedFiles(respBinPage, { dir: dlDir, sessionId: "s-rbin", clickWaitMs: 150 });
  assert.equal(collRespBin.files.length, 0);
  assert.equal(collRespBin.skipped.length, 1);
  assert.match(collRespBin.skipped[0].reason, /telemetry\/rpc/);

  /* --- C. Magic bytes & JSON-конверт: отказ при бинарном типе и JSON-конверте или битых байтах --- */
  let respFireC = null;
  const badMagicPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc ? scanOf([{ kind: "click", tag: "n0-magic", name: "Скачать изображение" }]) : null,
    $: async () => ({
      click: async () => {
        if (respFireC) {
          respFireC({
            url: () => "https://gemini.google.com/dl/photo.png",
            status: () => 200,
            headers: () => ({
              "content-type": "image/png",
            }),
            body: async () => Buffer.from("{\"error\": \"not an image\"}"),
          });
        }
      },
    }),
    context: () => ({ request: { get: async () => { throw new Error("must not fetch"); } } }),
    on: (ev, fn) => {
      if (ev === "response") respFireC = fn;
    },
    off: () => {},
    waitForEvent: timeoutEvent,
  };
  const collBadMagic = await collectGeneratedFiles(badMagicPage, { dir: dlDir, sessionId: "s-badmagic", clickWaitMs: 150 });
  assert.equal(collBadMagic.files.length, 0);
  assert.equal(collBadMagic.skipped.length, 1);
  assert.match(collBadMagic.skipped[0].reason, /telemetry\/rpc/);

  /* --- D. Валидный бинарный ответ: корректные magic bytes PNG принимаются --- */
  let respFireD = null;
  const validPngPayload = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("VALID_PNG_BODY"),
  ]);
  const validPngPage = {
    evaluate: async (fn, arg) =>
      arg && arg.candSrc ? scanOf([{ kind: "click", tag: "n0-vpng", name: "Скачать PNG" }]) : null,
    $: async () => ({
      click: async () => {
        if (respFireD) {
          respFireD({
            url: () => "https://gemini.google.com/dl/real.png",
            status: () => 200,
            headers: () => ({
              "content-disposition": 'attachment; filename="real.png"',
              "content-type": "image/png",
            }),
            body: async () => validPngPayload,
          });
        }
      },
    }),
    context: () => ({ request: { get: async () => { throw new Error("must not fetch"); } } }),
    on: (ev, fn) => {
      if (ev === "response") respFireD = fn;
    },
    off: () => {},
    waitForEvent: timeoutEvent,
  };
  const collValidPng = await collectGeneratedFiles(validPngPage, { dir: dlDir, sessionId: "s-vpng", clickWaitMs: 150 });
  assert.equal(collValidPng.files.length, 1);
  assert.equal(collValidPng.skipped.length, 0);
  assert.equal(collValidPng.files[0].name, "real.png");
  assert.deepEqual(fs.readFileSync(collValidPng.files[0].path), validPngPayload);

  /* --- E. Расширение захода 3: кандидат-картинка без событий → файл собран canvas-путём --- */
  const canvas1x1PngB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const canvasImgPayload = Buffer.from(canvas1x1PngB64, "base64");
  const canvasPage = {
    evaluate: async (fn, arg) => {
      if (arg && arg.candSrc) {
        return scanOf([{ kind: "click", tag: "n0-canvas", name: "Скачать в полном размере" }]);
      }
      if (arg && arg.tag === "n0-canvas") {
        return {
          dataUrl: `data:image/png;base64,${canvas1x1PngB64}`,
          alt: "generated preview",
        };
      }
      return null;
    },
    $: async () => ({
      click: async () => {
        // Клик по «Скачать в полном размере» в Imagen не порождает событий сети
      },
    }),
    context: () => ({ request: { get: async () => { throw new Error("must not fetch"); } } }),
    waitForEvent: timeoutEvent,
  };
  const collCanvas = await collectGeneratedFiles(canvasPage, { dir: dlDir, sessionId: "s-canvas", clickWaitMs: 150 });
  assert.equal(collCanvas.files.length, 1, `canvas fallback must collect image: ${JSON.stringify(collCanvas)}`);
  assert.equal(collCanvas.skipped.length, 0);
  assert.equal(collCanvas.files[0].mimeType, "image/png");
  assert.deepEqual(fs.readFileSync(collCanvas.files[0].path), canvasImgPayload);
});
/* ---------- PLUG-374: managed browser groups (chrome/xvfb lifecycle) ---------- */

test("24. browser-groups: marker/adopt/identity primitives", async () => {
  if (process.platform !== "linux") return;
  const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-units-")));

  // recordGroup captures a verifiable identity: pgid + leader starttime +
  // owner pid + owner starttime.
  const self = browserGroups.readProcStat(process.pid);
  const meta = browserGroups.recordGroup({ stateDir, port: "19401", pgid: process.pid, mode: "xvfb" });
  assert.equal(meta.ownerPid, process.pid);
  assert.equal(meta.ownerStartTime, self.startTime);
  assert.equal(meta.pgidStartTime, self.startTime);
  assert.ok(fs.existsSync(browserGroups.markerPath(stateDir, "19401")));

  // A dead owner pid fails ownerAlive even though a marker exists.
  const deadPid = spawnSync("true").pid;
  browserGroups.writeMarker(stateDir, {
    version: 1, port: "19402", pgid: process.pid, pgidStartTime: self.startTime,
    ownerPid: deadPid, ownerStartTime: 0, mode: "xvfb",
  });
  const dead = browserGroups.readMarker(stateDir, "19402");
  assert.equal(browserGroups.ownerAlive(dead), false);

  // adoptGroup re-points an orphaned marker at the current owner.
  const adopted = browserGroups.adoptGroup(stateDir, "19402");
  assert.equal(adopted.ownerPid, process.pid);
  assert.equal(browserGroups.ownerAlive(browserGroups.readMarker(stateDir, "19402")), true);

  // Adopting a port with no marker creates nothing (external chrome stays
  // unmanaged — never killed by reapers).
  assert.equal(browserGroups.adoptGroup(stateDir, "19403"), null);
  assert.equal(browserGroups.readMarker(stateDir, "19403"), null);

  // A fresh `reaping` mark refuses adoption — the group is being torn down.
  const deadPid2 = spawnSync("true").pid;
  browserGroups.writeMarker(stateDir, {
    version: 1, port: "19404", pgid: process.pid, pgidStartTime: self.startTime,
    ownerPid: deadPid2, ownerStartTime: 0, mode: "xvfb",
    reaping: { by: 424242, sinceMs: Date.now() },
  });
  assert.equal(browserGroups.adoptGroup(stateDir, "19404"), null, "fresh reaping mark must refuse adoption");
  assert.equal(browserGroups.isReaping(browserGroups.readMarker(stateDir, "19404")), true);

  // A stale mark (reaper died mid-teardown) does not block adoption — and the
  // adopting owner clears it.
  browserGroups.writeMarker(stateDir, {
    version: 1, port: "19404", pgid: process.pid, pgidStartTime: self.startTime,
    ownerPid: deadPid2, ownerStartTime: 0, mode: "xvfb",
    reaping: { by: 424242, sinceMs: Date.now() - browserGroups.REAPING_TTL_MS - 1 },
  });
  const adoptedStale = browserGroups.adoptGroup(stateDir, "19404");
  assert.equal(adoptedStale.ownerPid, process.pid);
  assert.equal(adoptedStale.reaping, undefined, "adoption clears a stale reaping mark");
});

test("25. browser-groups: orphan reap, lease/CDP preservation, reparented groups", async (t) => {
  if (process.platform !== "linux") return;
  const backendsFor = (port) => [{ id: "acc1", cdp: String(port) }];
  const groupPids = [];

  // Per-scenario state dir — the reaper scans every marker in the dir, so
  // leftover groups from an earlier scenario must not leak into the next one.
  const newState = () => {
    const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-reap-")));
    const ledgerPath = path.join(stateDir, "accounts-state.json");
    fs.writeFileSync(ledgerPath, JSON.stringify({ accounts: {}, leases: {} }));
    return { stateDir, ledgerPath, lockPath: `${ledgerPath}.lock` };
  };

  // Wait until the fixture has exec'd into its faux-chrome identity, not just
  // until /proc/<pid>/stat is readable.
  const waitChrome = async (pid, port) => {
    for (let i = 0; i < 60; i++) {
      if (browserGroups.cmdlineMatchesPort(pid, port)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  // A real detached process group whose leader cmdline carries the port flag —
  // the same shape xvfb-run/chrome groups have.
  const fakeChromeGroup = async (port) => {
    const proc = spawn("bash", ["-c", `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 600`], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    return proc.pid;
  };
  const markOrphan = (stateDir, port, pgid) =>
    browserGroups.writeMarker(stateDir, {
      version: 1, port: String(port), pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now(),
    });
  t.after(() => {
    for (const pgid of groupPids) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
    groupPids.length = 0;
  });

  // (a) crash death: dead owner + no lease + no clients → whole group reaped.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19411";
    const pgid = await fakeChromeGroup(port);
    markOrphan(stateDir, port, pgid);
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    assert.equal(n, 1, "orphan group must be reaped");
    assert.equal(browserGroups.groupMembers(pgid).length, 0, "process group must be dead");
    assert.equal(browserGroups.readMarker(stateDir, port), null, "marker must be removed");
    groupPids.splice(groupPids.indexOf(pgid), 1);
  }

  // (b) a live lease on the port's backend preserves the group.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19412";
    const pgid = await fakeChromeGroup(port);
    markOrphan(stateDir, port, pgid);
    const holder = spawn("sleep", ["60"], { stdio: "ignore" });
    t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
    fs.writeFileSync(ledgerPath, JSON.stringify({ accounts: {}, leases: { acc1: { pid: holder.pid, acquiredMs: Date.now() } } }));
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    assert.equal(n, 0, "group with a live lease must be preserved");
    assert.equal(browserGroups.groupExists(pgid), true);
  }

  // (c) a live CDP client without any lease preserves the group (flow case:
  // external tooling attached to the debugging port is not our kill decision).
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = 19413;
    const pgid = await fakeChromeGroup(port);
    markOrphan(stateDir, port, pgid);
    const listener = net.createServer();
    await new Promise((r) => listener.listen(port, "127.0.0.1", r));
    const client = net.connect(port, "127.0.0.1");
    await new Promise((r, j) => { client.once("connect", r); client.once("error", j); });
    t.after(() => { client.destroy(); if (listener.listening) listener.close(); });
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    assert.equal(n, 0, "group with a live CDP client must be preserved");
    assert.equal(browserGroups.groupExists(pgid), true);
    client.destroy();
    await new Promise((r) => listener.close(r));
  }

  // (d) group reparented to init/user-systemd (PPID ≠ 1 allowed) is still
  // reaped — identity is pgid-based, not ppid-based.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19414";
    execSync(
      `setsid bash -c 'exec -a "faux-chrome --remote-debugging-port=${port}" sleep 600' </dev/null >/dev/null 2>&1 &`,
      { encoding: "utf8" }
    );
    // $! names the setsid wrapper — the actual group leader is whichever
    // process ends up carrying the flag with pgrp === pid (setsid may fork).
    let pid = null;
    for (let i = 0; i < 80 && pid == null; i++) {
      try {
        for (const ent of fs.readdirSync("/proc")) {
          if (!/^\d+$/.test(ent)) continue;
          const p = Number(ent);
          const st = browserGroups.readProcStat(p);
          if (st && st.pgrp === p && browserGroups.cmdlineMatchesPort(p, port)) {
            pid = p;
            break;
          }
        }
      } catch {}
      if (pid == null) await new Promise((r) => setTimeout(r, 50));
    }
    assert.notEqual(pid, null, "flag-carrying group leader must appear");
    groupPids.push(pid);
    const st = browserGroups.readProcStat(pid);
    assert.equal(st.pgrp, pid, "setsid child must be its own group leader");
    assert.notEqual(st.ppid, process.pid, "fixture must already be reparented");
    markOrphan(stateDir, port, pid);
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    assert.equal(n, 1, "reparented orphan group must be reaped");
    assert.equal(browserGroups.groupMembers(pid).length, 0);
    groupPids.splice(groupPids.indexOf(pid), 1);
  }

  // (e) marker with no matching live group → marker removed, nothing killed.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19415";
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid: 2 ** 22, pgidStartTime: 0,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0,
    });
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    assert.equal(n, 0);
    assert.equal(browserGroups.readMarker(stateDir, port), null, "stale marker must be dropped");
  }

  // (f) idempotent: a second pass over an empty marker dir is a clean no-op.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor("19411") });
    assert.equal(n, 0);
  }

  // (g) TERM-grace race: while the reaping mark is fresh the backend refuses
  //     leases, and a lease + connected CDP client slipped in during the grace
  //     window vetoes the SIGKILL escalation — the group survives.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19416";
    // A SIGTERM-proof member carrying the port flag forces the escalation
    // path; the ready file proves the handler is installed before we reap.
    const readyFile = path.join(stateDir, "term-ready");
    const proc = spawn("bash", ["-c",
      `exec -a "faux-chrome --remote-debugging-port=${port}" "${process.execPath}" ` +
      `-e "process.on('SIGTERM',()=>{});require('fs').writeFileSync('${readyFile}','1');setInterval(()=>{},1e9)"`], {
      detached: true, stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    for (let i = 0; i < 80 && !fs.existsSync(readyFile); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fs.existsSync(readyFile), "TERM handler must be installed before teardown");
    markOrphan(stateDir, port, proc.pid);

    const reaper = reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    let marked = null;
    for (let i = 0; i < 80; i++) {
      marked = browserGroups.readMarker(stateDir, port);
      if (marked?.reaping) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(marked?.reaping, "marker must be flagged reaping once SIGTERM is sent");

    // Backend selection treats the reaping port as busy — no lease is written.
    const pick = withStateLock(
      (state) => pickBackendFromState(state, null, `${process.pid}:s`, Date.now(), null, backendsFor(port), stateDir),
      ledgerPath, lockPath
    );
    assert.equal(pick.backend, undefined, "reaping backend must not be leasable");
    assert.ok(pick.busyUntil, "reaping backend reports a busy-until");

    // Even a lease that slips past selection plus a live CDP client vetoes
    // the escalation — no SIGKILL reaches the group.
    const listener = net.createServer();
    await new Promise((r) => listener.listen(port, "127.0.0.1", r));
    const client = net.connect(port, "127.0.0.1");
    await new Promise((r, j) => { client.once("connect", r); client.once("error", j); });
    t.after(() => { client.destroy(); if (listener.listening) listener.close(); });
    fs.writeFileSync(ledgerPath, JSON.stringify({
      accounts: {}, leases: { acc1: { pid: process.pid, acquiredMs: Date.now() } },
    }));

    const n = await reaper;
    assert.equal(n, 0, "vetoed escalation must not count as reaped");
    assert.equal(browserGroups.isPidAlive(proc.pid), true, "TERM-proof member must survive — no SIGKILL");
    const after = browserGroups.readMarker(stateDir, port);
    assert.ok(after, "marker is kept for the now-leased group");
    assert.equal(after.reaping, undefined, "reaping mark cleared after the veto");
    client.destroy();
    await new Promise((r) => listener.close(r));
  }

  // (h) leftover identity: the flag-carrying leader is gone and only an
  //     attributable member (Xvfb) survives — the group is still reaped
  //     instead of leaking with a dropped marker.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19417";
    const proc = spawn("bash", ["-c",
      `bash -c 'exec -a "Xvfb :77 -screen 0 1280x1024x24" sleep 600' & ` +
      `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 2`], {
      detached: true, stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    markOrphan(stateDir, port, proc.pid);
    for (let i = 0; i < 80; i++) {
      const st = browserGroups.readProcStat(proc.pid);
      if (!st || st.state === "Z") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const leader = browserGroups.readProcStat(proc.pid);
    assert.ok(!leader || leader.state === "Z", "flag-carrying leader must have exited");
    assert.equal(browserGroups.groupExists(proc.pid), true, "Xvfb member outlives the leader");
    assert.equal(
      browserGroups.identifyGroup(browserGroups.readMarker(stateDir, port)),
      "leftover",
      "surviving Xvfb member must identify as ours"
    );
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    assert.equal(n, 1, "leftover-only group must still be reaped");
    assert.equal(browserGroups.groupMembers(proc.pid).length, 0);
    assert.equal(browserGroups.readMarker(stateDir, port), null, "marker must be removed");
    groupPids.splice(groupPids.indexOf(proc.pid), 1);
  }

  // (i) doubtful identity: a surviving member that cannot be attributed to
  //     the browser stack keeps the marker and the group untouched.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19418";
    const proc = spawn("bash", ["-c",
      `bash -c 'exec -a "stray-tool" sleep 600' & ` +
      `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 2`], {
      detached: true, stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    markOrphan(stateDir, port, proc.pid);
    for (let i = 0; i < 80; i++) {
      const st = browserGroups.readProcStat(proc.pid);
      if (!st || st.state === "Z") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(browserGroups.groupExists(proc.pid), true, "stray member outlives the leader");
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    assert.equal(n, 0, "unattributable leftover must not be killed");
    assert.equal(browserGroups.groupExists(proc.pid), true, "doubtful group is left alone");
    assert.ok(browserGroups.readMarker(stateDir, port), "doubtful marker is kept");
  }

  // (j) idle group with a LIVE foreign owner, no lease and no clients is
  //     reaped — a live owner alone does not preserve an idle group.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19419";
    const holder = spawn("sleep", ["60"], { stdio: "ignore" });
    t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
    const holderStat = browserGroups.readProcStat(holder.pid);
    const pgid = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      ownerPid: holder.pid, ownerStartTime: holderStat?.startTime ?? null,
      mode: "xvfb", launchedMs: Date.now() - 10 * 60_000,
    });
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    assert.equal(n, 1, "idle group under a live owner must be reaped");
    assert.equal(browserGroups.groupMembers(pgid).length, 0);
    groupPids.splice(groupPids.indexOf(pgid), 1);
  }

  // (k) a young group under a live owner sits inside its startup grace —
  //     markers are written before CDP readiness, so it is preserved.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19420";
    const holder = spawn("sleep", ["60"], { stdio: "ignore" });
    t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
    const holderStat = browserGroups.readProcStat(holder.pid);
    const pgid = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      ownerPid: holder.pid, ownerStartTime: holderStat?.startTime ?? null,
      mode: "xvfb", launchedMs: Date.now(),
    });
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: backendsFor(port) });
    assert.equal(n, 0, "young group under a live owner must be preserved");
    assert.equal(browserGroups.groupExists(pgid), true);
  }
});

test("26. browser-groups: clean-shutdown cleanup of own groups", async (t) => {
  if (process.platform !== "linux") return;
  const groupPids = [];
  const newState = () => {
    const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-shutdown-")));
    const ledgerPath = path.join(stateDir, "accounts-state.json");
    fs.writeFileSync(ledgerPath, JSON.stringify({ accounts: {}, leases: {} }));
    return { stateDir, ledgerPath, lockPath: `${ledgerPath}.lock` };
  };
  const waitChrome = async (pid, port) => {
    for (let i = 0; i < 60; i++) {
      if (browserGroups.cmdlineMatchesPort(pid, port)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const fakeChromeGroup = async (port) => {
    const proc = spawn("bash", ["-c", `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 600`], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    return proc.pid;
  };
  const markOwned = (stateDir, port, pgid) =>
    browserGroups.writeMarker(stateDir, {
      version: 1, port: String(port), pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      ownerPid: process.pid, ownerStartTime: browserGroups.readProcStat(process.pid)?.startTime ?? null,
      mode: "xvfb", launchedMs: Date.now(),
    });
  t.after(() => {
    for (const pgid of groupPids) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
  });

  // (a) normal exit path: our own idle group is torn down and marker removed.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19421";
    const pgid = await fakeChromeGroup(port);
    markOwned(stateDir, port, pgid);
    const n = await cleanupOwnBrowserGroups({
      stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }],
    });
    assert.equal(n, 1, "shutdown must tear down our own idle group");
    assert.equal(browserGroups.groupMembers(pgid).length, 0);
    assert.equal(browserGroups.readMarker(stateDir, port), null);
    groupPids.splice(groupPids.indexOf(pgid), 1);
  }

  // (b) an external CDP client (socket owned by ANOTHER pid — our own sockets
  // are excluded from the check) preserves the group on shutdown too.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = 19422;
    const pgid = await fakeChromeGroup(port);
    markOwned(stateDir, port, pgid);
    const listener = net.createServer();
    await new Promise((r) => listener.listen(port, "127.0.0.1", r));
    const clientProc = spawn(process.execPath, [
      "-e",
      `require("net").connect(${port},"127.0.0.1").on("connect",()=>setInterval(()=>{},1e9)).on("error",()=>process.exit(2))`,
    ], { stdio: "ignore" });
    t.after(() => { try { clientProc.kill("SIGKILL"); } catch {} if (listener.listening) listener.close(); });
    for (let i = 0; i < 60 && !browserGroups.hasLiveCdpClients(port); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(browserGroups.hasLiveCdpClients(port), true, "external CDP client must be visible");
    const n = await cleanupOwnBrowserGroups({
      stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: String(port) }],
    });
    assert.equal(n, 0, "group busy with an external client must be preserved");
    assert.equal(browserGroups.groupExists(pgid), true);
    clientProc.kill("SIGKILL");
    await new Promise((r) => listener.close(r));
  }
});

test("27. browser-groups: identity mismatch stays doubtful — no signal, marker kept", async (t) => {
  if (process.platform !== "linux") return;
  const groupPids = [];
  const newState = () => {
    const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-ident-")));
    const ledgerPath = path.join(stateDir, "accounts-state.json");
    fs.writeFileSync(ledgerPath, JSON.stringify({ accounts: {}, leases: {} }));
    return { stateDir, ledgerPath, lockPath: `${ledgerPath}.lock` };
  };
  const waitChrome = async (pid, port) => {
    for (let i = 0; i < 60; i++) {
      if (browserGroups.cmdlineMatchesPort(pid, port)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const fakeChromeGroup = async (port) => {
    const proc = spawn("bash", ["-c", `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 600`], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    return proc.pid;
  };
  t.after(() => {
    for (const pgid of groupPids) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
    groupPids.length = 0;
  });

  // (a) pgid reuse shape: same port flag and same pgid as the marker, but the
  //     live leader's starttime differs from the recorded one → the group is
  //     foreign, classified doubtful, and NOT signaled (PLUG-374 заход 3).
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19423";
    const pgid = await fakeChromeGroup(port);
    const recorded = browserGroups.readProcStat(pgid).startTime;
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid,
      pgidStartTime: recorded + 7,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
    const diag = {};
    assert.equal(
      browserGroups.identifyGroup(browserGroups.readMarker(stateDir, port), diag),
      "doubtful",
      "starttime mismatch must win over the port flag"
    );
    assert.equal(diag.reason, "leader-starttime-mismatch");
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
    assert.equal(n, 0, "foreign group must not be reaped");
    assert.equal(browserGroups.isPidAlive(pgid), true, "no SIGTERM may reach the foreign leader");
    const kept = browserGroups.readMarker(stateDir, port);
    assert.ok(kept, "doubtful marker is preserved");
    assert.equal(kept.doubt?.reason, "leader-starttime-mismatch", "marker carries the diagnosis");
  }

  // (b) leader missing and the survivors postdate the recorded launch: a
  //     foreign group reused the pgid after our marker was written — family
  //     cmdline alone must not confirm it.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19424";
    const proc = spawn("bash", ["-c",
      `bash -c 'exec -a "Xvfb :79 -screen 0 1280x1024x24" sleep 600' & ` +
      `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 2`], {
      detached: true, stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    for (let i = 0; i < 80; i++) {
      const st = browserGroups.readProcStat(proc.pid);
      if (!st || st.state === "Z") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const members = browserGroups.groupMembers(proc.pid);
    assert.equal(members.length, 1, "only the Xvfb member outlives the leader");
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid: proc.pid,
      // Recorded launch sits ~1000 s before the surviving member — the shape
      // of a pgid reused by a later, foreign group.
      pgidStartTime: members[0].startTime - 100_000,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
    const diag = {};
    assert.equal(
      browserGroups.identifyGroup(browserGroups.readMarker(stateDir, port), diag),
      "doubtful",
      "members postdating the recorded launch must not confirm the group"
    );
    assert.equal(diag.reason, "members-postdate-launch");
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
    assert.equal(n, 0);
    assert.equal(browserGroups.groupExists(proc.pid), true, "doubtful group is left alone");
    assert.equal(browserGroups.readMarker(stateDir, port)?.doubt?.reason, "members-postdate-launch");
  }

  // (c) a live leader with no recorded starttime is unverifiable → doubtful.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19425";
    const pgid = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid, pgidStartTime: null,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
    const diag = {};
    assert.equal(
      browserGroups.identifyGroup(browserGroups.readMarker(stateDir, port), diag),
      "doubtful"
    );
    assert.equal(diag.reason, "leader-starttime-unrecorded");
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
    assert.equal(n, 0);
    assert.equal(browserGroups.isPidAlive(pgid), true);
    assert.ok(browserGroups.readMarker(stateDir, port));
  }
});

test("28. browser-groups: stale-boot marker authorizes nothing — no signal, port free", async (t) => {
  if (process.platform !== "linux") return;
  const groupPids = [];
  const newState = () => {
    const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-boot-")));
    const ledgerPath = path.join(stateDir, "accounts-state.json");
    fs.writeFileSync(ledgerPath, JSON.stringify({ accounts: {}, leases: {} }));
    return { stateDir, ledgerPath, lockPath: `${ledgerPath}.lock` };
  };
  const waitChrome = async (pid, port) => {
    for (let i = 0; i < 60; i++) {
      if (browserGroups.cmdlineMatchesPort(pid, port)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const fakeChromeGroup = async (port) => {
    const proc = spawn("bash", ["-c", `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 600`], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    return proc.pid;
  };
  t.after(() => {
    for (const pgid of groupPids) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
    groupPids.length = 0;
  });

  const staleBoot = "00000000-0000-0000-0000-000000000000";
  assert.ok(browserGroups.currentBootId(), "boot_id must be readable on linux");
  assert.notEqual(staleBoot, browserGroups.currentBootId(), "fixture boot id must differ from the real one");

  // recordGroup stamps the marker with the current boot.
  {
    const { stateDir } = newState();
    const meta = browserGroups.recordGroup({ stateDir, port: "19426", pgid: process.pid });
    assert.equal(meta.bootId, browserGroups.currentBootId());
    assert.equal(browserGroups.markerMatchesBoot(browserGroups.readMarker(stateDir, "19426")), true);
  }

  // (a) reboot collision shape: stale-boot marker + a live foreign group
  //     whose pgid/starttime/port flag all match the recorded values →
  //     classified stale-boot, no signal, marker cleaned, group untouched.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19427";
    const pgid = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      bootId: staleBoot,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
    const diag = {};
    assert.equal(
      browserGroups.identifyGroup(browserGroups.readMarker(stateDir, port), diag),
      "stale-boot",
      "boot mismatch must precede PID/PGID/port interpretation"
    );
    assert.equal(diag.reason, "boot-mismatch");
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
    assert.equal(n, 0, "foreign group must not be reaped");
    assert.equal(browserGroups.isPidAlive(pgid), true, "no SIGTERM may reach the foreign group");
    assert.equal(browserGroups.readMarker(stateDir, port), null, "stale-boot marker is cleaned");
    // The port is free for a fresh lease.
    const pick = withStateLock(
      (state) => pickBackendFromState(state, null, `${process.pid}:s`, Date.now(), null, [{ id: "acc1", cdp: port }], stateDir),
      ledgerPath, lockPath
    );
    assert.equal(pick.backend?.id, "acc1", "port must be leasable once the stale marker is gone");
  }

  // (b) a stale-boot reaping mark holds nothing busy — backend selection
  //     leases the port even while the flag is fresh.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19428";
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid: 2 ** 22, pgidStartTime: 0,
      bootId: staleBoot,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      reaping: { by: 424242, sinceMs: Date.now() },
    });
    assert.equal(
      browserGroups.isReaping(browserGroups.readMarker(stateDir, port)),
      false,
      "stale-boot reaping mark must be inert"
    );
    const pick = withStateLock(
      (state) => pickBackendFromState(state, null, `${process.pid}:s`, Date.now(), null, [{ id: "acc1", cdp: port }], stateDir),
      ledgerPath, lockPath
    );
    assert.equal(pick.backend?.id, "acc1", "stale-boot mark must not hold the port busy");
  }

  // (c) a marker with no bootId at all authorizes nothing — same stale-boot
  //     classification, no signal, marker cleaned. The raw file is written
  //     directly: writeMarker auto-stamps a missing bootId.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19429";
    const pgid = await fakeChromeGroup(port);
    fs.mkdirSync(browserGroups.groupsDir(stateDir), { recursive: true });
    fs.writeFileSync(browserGroups.markerPath(stateDir, port), JSON.stringify({
      version: 1, port, pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    }));
    const diag = {};
    assert.equal(
      browserGroups.identifyGroup(browserGroups.readMarker(stateDir, port), diag),
      "stale-boot"
    );
    assert.equal(diag.reason, "boot-unrecorded");
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
    assert.equal(n, 0);
    assert.equal(browserGroups.isPidAlive(pgid), true, "no SIGTERM may reach the foreign group");
    assert.equal(browserGroups.readMarker(stateDir, port), null);
  }

  // (d) adoption refuses a stale-boot marker — reusing the port never claims
  //     the foreign group.
  {
    const { stateDir } = newState();
    const port = "19430";
    const pgid = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      bootId: staleBoot,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
    assert.equal(
      browserGroups.adoptGroup(stateDir, port),
      null,
      "stale-boot marker must refuse adoption"
    );
    const kept = browserGroups.readMarker(stateDir, port);
    assert.notEqual(kept.ownerPid, process.pid, "foreign marker is not re-owned");
    assert.equal(kept.bootId, staleBoot, "foreign bootId is preserved for the reaper's cleanup");
  }
});

test("29. browser-groups: unreadable boot_id fails closed — no signal, no adopt, marker kept", async (t) => {
  if (process.platform !== "linux") return;
  const groupPids = [];
  const newState = () => {
    const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-bootunk-")));
    const ledgerPath = path.join(stateDir, "accounts-state.json");
    fs.writeFileSync(ledgerPath, JSON.stringify({ accounts: {}, leases: {} }));
    return { stateDir, ledgerPath, lockPath: `${ledgerPath}.lock` };
  };
  const waitChrome = async (pid, port) => {
    for (let i = 0; i < 60; i++) {
      if (browserGroups.cmdlineMatchesPort(pid, port)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const fakeChromeGroup = async (port) => {
    const proc = spawn("bash", ["-c", `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 600`], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    return proc.pid;
  };
  t.after(() => {
    for (const pgid of groupPids) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
    groupPids.length = 0;
  });

  const staleBoot = "00000000-0000-0000-0000-000000000000";
  const realBoot = browserGroups.currentBootId();
  assert.ok(realBoot, "boot_id must be readable on linux");

  // Simulate EACCES on /proc/sys/kernel/random/boot_id — the shared fs
  // module is patched, so browser-groups sees the failure while every other
  // path is delegated untouched.
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, opts) {
    if (String(p) === "/proc/sys/kernel/random/boot_id") {
      const e = new Error("EACCES: permission denied, open '/proc/sys/kernel/random/boot_id'");
      e.code = "EACCES";
      throw e;
    }
    return realReadFileSync.call(this, p, opts);
  };
  try {
    // (a) a FOREIGN-boot marker under unreadable boot: without the
    //     fail-closed check this classified 'matched' and earned a SIGTERM.
    {
      const { stateDir, ledgerPath, lockPath } = newState();
      const port = "19431";
      const pgid = await fakeChromeGroup(port);
      browserGroups.writeMarker(stateDir, {
        version: 1, port, pgid,
        pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
        bootId: staleBoot,
        ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
        launchedMs: Date.now() - 10 * 60_000,
      });
      const meta = browserGroups.readMarker(stateDir, port);
      assert.equal(browserGroups.markerMatchesBoot(meta), null, "unreadable boot must be indeterminate");
      const diag = {};
      assert.equal(browserGroups.identifyGroup(meta, diag), "boot-unknown");
      assert.equal(diag.reason, "boot-unreadable");
      assert.equal(browserGroups.signalGroup(meta, "SIGTERM"), false, "no signal while boot is indeterminate");
      assert.equal(browserGroups.adoptGroup(stateDir, port), null, "no adoption while boot is indeterminate");
      const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
      assert.equal(n, 0);
      assert.equal(browserGroups.isPidAlive(pgid), true, "group untouched");
      assert.ok(browserGroups.readMarker(stateDir, port), "marker preserved — it may be ours");
    }

    // (b) an OUR-boot marker under unreadable boot: still boot-unknown —
    //     kept and unsignaled. This is the failure the blocker reported:
    //     EACCES degraded to 'matched' and the reaper killed our own group.
    {
      const { stateDir, ledgerPath, lockPath } = newState();
      const port = "19432";
      const pgid = await fakeChromeGroup(port);
      browserGroups.writeMarker(stateDir, {
        version: 1, port, pgid,
        pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
        bootId: realBoot,
        ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
        launchedMs: Date.now() - 10 * 60_000,
      });
      const meta = browserGroups.readMarker(stateDir, port);
      assert.equal(browserGroups.identifyGroup(meta), "boot-unknown", "our-boot marker is indeterminate too");
      // A fresh reaping mark stays busy — a maybe-running teardown keeps
      // its port for the TTL (fail closed), though it can never signal.
      assert.equal(
        browserGroups.isReaping({ ...meta, reaping: { by: 424242, sinceMs: Date.now() } }),
        true,
        "indeterminate boot must not release a fresh reaping mark"
      );
      const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
      assert.equal(n, 0, "maybe-ours group must survive while boot is unreadable");
      assert.equal(browserGroups.isPidAlive(pgid), true);
      assert.ok(browserGroups.readMarker(stateDir, port), "marker must not be deleted");
    }
  } finally {
    fs.readFileSync = realReadFileSync;
  }
});

test("30. browser-groups: marker lock serializes writers — a concurrent fresh marker survives", async (t) => {
  if (process.platform !== "linux") return;
  const groupPids = [];
  const modulePath = path.join(PLUGIN_ROOT, "src/browser-groups.cjs");
  const newState = () => {
    const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-lock-")));
    const ledgerPath = path.join(stateDir, "accounts-state.json");
    fs.writeFileSync(ledgerPath, JSON.stringify({ accounts: {}, leases: {} }));
    return { stateDir, ledgerPath, lockPath: `${ledgerPath}.lock` };
  };
  const waitChrome = async (pid, port) => {
    for (let i = 0; i < 60; i++) {
      if (browserGroups.cmdlineMatchesPort(pid, port)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const fakeChromeGroup = async (port) => {
    const proc = spawn("bash", ["-c", `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 600`], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    return proc.pid;
  };
  t.after(() => {
    for (const pgid of groupPids) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
    groupPids.length = 0;
  });

  const staleBoot = "00000000-0000-0000-0000-000000000000";
  const realBoot = browserGroups.currentBootId();
  assert.ok(realBoot, "boot_id must be readable on linux");

  // A child process playing a concurrent writer: it acquires the port's
  // marker lock, signals readiness, holds ~400 ms, then writes a FRESH
  // marker for a newly launched group — the exact interleave that used to
  // clobber markers between a reaper's re-read and unlink. The reaper's
  // verify+unlink must now be serialized behind the writer's section.
  const contendingWriter = ({ stateDir, port, m2 }) => {
    const readyFile = path.join(stateDir, `writer-ready-${port}`);
    const child = spawn(process.execPath, ["-e",
      'const bg = require(process.env.BG_MODULE);\n' +
      'const fs = require("fs");\n' +
      'bg.withMarkerLock(process.env.BG_STATE_DIR, process.env.BG_PORT, () => {\n' +
      '  fs.writeFileSync(process.env.BG_READY, "1");\n' +
      '  const end = Date.now() + 400; while (Date.now() < end) {}\n' +
      '  bg.writeMarker(process.env.BG_STATE_DIR, JSON.parse(process.env.BG_M2));\n' +
      '});',
    ], {
      stdio: "ignore",
      env: {
        ...process.env,
        BG_MODULE: modulePath,
        BG_STATE_DIR: stateDir,
        BG_PORT: String(port),
        BG_M2: JSON.stringify(m2),
        BG_READY: readyFile,
      },
    });
    t.after(() => { try { child.kill("SIGKILL"); } catch {} });
    return readyFile;
  };
  const waitFile = async (f) => {
    for (let i = 0; i < 100 && !fs.existsSync(f); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fs.existsSync(f), `contending writer did not signal ${f}`);
  };
  const freshMarkerFor = (port, pgid) => ({
    version: 1, port: String(port), pgid,
    pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
    bootId: realBoot,
    ownerPid: process.pid,
    ownerStartTime: browserGroups.readProcStat(process.pid)?.startTime ?? null,
    mode: "xvfb", launchedMs: Date.now(),
  });

  // (a) stale-boot branch: the snapshot names a foreign-boot group; a fresh
  //     marker lands while the reaper waits on the lock — it must survive.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19433";
    const pgid2 = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid: 2 ** 22, pgidStartTime: 0,
      bootId: staleBoot,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
    const readyFile = contendingWriter({ stateDir, port, m2: freshMarkerFor(port, pgid2) });
    await waitFile(readyFile);
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
    assert.equal(n, 0);
    const kept = browserGroups.readMarker(stateDir, port);
    assert.equal(kept?.pgid, pgid2, "fresh marker must survive the reaper's stale-boot cleanup");
    assert.equal(kept?.bootId, realBoot);
    assert.equal(browserGroups.isPidAlive(pgid2), true, "the new group is never touched");
  }

  // (b) dead branch: the old code unlinked the marker on the snapshot with
  //     no re-read at all — a fresh launch on the same port was deleted.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19434";
    const pgid2 = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid: 2 ** 22, pgidStartTime: 0,
      bootId: realBoot,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
    const readyFile = contendingWriter({ stateDir, port, m2: freshMarkerFor(port, pgid2) });
    await waitFile(readyFile);
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
    assert.equal(n, 0);
    const kept = browserGroups.readMarker(stateDir, port);
    assert.equal(kept?.pgid, pgid2, "fresh marker must survive the reaper's dead-marker cleanup");
    assert.equal(browserGroups.isPidAlive(pgid2), true);
  }

  // (c) doubtful branch: the annotate write must not clobber a fresh marker
  //     either — verify identity again inside the locked section.
  {
    const { stateDir, ledgerPath, lockPath } = newState();
    const port = "19435";
    const pgid1 = await fakeChromeGroup(port);
    const pgid2 = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid: pgid1,
      // starttime mismatch → the snapshot classifies 'doubtful'.
      pgidStartTime: (browserGroups.readProcStat(pgid1)?.startTime ?? 0) + 7,
      bootId: realBoot,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
    const diag = {};
    assert.equal(
      browserGroups.identifyGroup(browserGroups.readMarker(stateDir, port), diag),
      "doubtful",
      "fixture must classify doubtful before the race"
    );
    const readyFile = contendingWriter({ stateDir, port, m2: freshMarkerFor(port, pgid2) });
    await waitFile(readyFile);
    const n = await reapOrphanBrowserGroups({ stateDir, ledgerPath, lockPath, backends: [{ id: "acc1", cdp: port }] });
    assert.equal(n, 0);
    const kept = browserGroups.readMarker(stateDir, port);
    assert.equal(kept?.pgid, pgid2, "fresh marker must survive the doubtful annotate");
    assert.equal(kept?.doubt, undefined, "fresh marker must not carry a doubt annotation");
    assert.equal(browserGroups.isPidAlive(pgid2), true);
  }
});

test("31. browser-groups: kernel marker lock + unified stopChrome teardown (заход 6)", async (t) => {
  if (process.platform !== "linux") return;
  const groupPids = [];
  const modulePath = path.join(PLUGIN_ROOT, "src/browser-groups.cjs");
  const newState = () => {
    const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-z6-")));
    const ledgerPath = path.join(stateDir, "accounts-state.json");
    fs.writeFileSync(ledgerPath, JSON.stringify({ accounts: {}, leases: {} }));
    return { stateDir, ledgerPath };
  };
  const waitChrome = async (pid, port) => {
    for (let i = 0; i < 60; i++) {
      if (browserGroups.cmdlineMatchesPort(pid, port)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const fakeChromeGroup = async (port) => {
    const proc = spawn("bash", ["-c", `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 600`], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    groupPids.push(proc.pid);
    await waitChrome(proc.pid, port);
    return proc.pid;
  };
  const markOrphan = (stateDir, port, pgid) =>
    browserGroups.writeMarker(stateDir, {
      version: 1, port: String(port), pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
  const waitFile = async (f) => {
    for (let i = 0; i < 100 && !fs.existsSync(f); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fs.existsSync(f), `child did not signal ${f}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  t.after(() => {
    for (const pgid of groupPids) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
    groupPids.length = 0;
  });

  // (a) kernel release: a holder killed mid-section frees the lock — a
  //     successor acquires WITHOUT any steal and its marker survives.
  {
    const { stateDir } = newState();
    const port = "19501";
    const readyA = path.join(stateDir, "lock-a-ready");
    const doneB = path.join(stateDir, "lock-b-done");
    // Holder: enters the section, signals, then burns CPU for 60 s.
    const holder = spawn(process.execPath, ["-e",
      'const bg=require(process.env.BG_MODULE);const fs=require("fs");' +
      'bg.withMarkerLock(process.env.BG_STATE_DIR,process.env.BG_PORT,()=>{' +
      '  fs.writeFileSync(process.env.BG_READY,"1");' +
      '  const end=Date.now()+60000;while(Date.now()<end){}' +
      '});'], {
      stdio: "ignore",
      env: { ...process.env, BG_MODULE: modulePath, BG_STATE_DIR: stateDir, BG_PORT: port, BG_READY: readyA },
    });
    t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
    await waitFile(readyA);
    // Successor: acquires the same lock, writes a fresh marker, signals done.
    const m2 = {
      version: 1, port, pgid: process.pid,
      pgidStartTime: browserGroups.readProcStat(process.pid)?.startTime ?? null,
      ownerPid: process.pid, ownerStartTime: 0, mode: "xvfb", launchedMs: Date.now(),
    };
    const successor = spawn(process.execPath, ["-e",
      'const bg=require(process.env.BG_MODULE);const fs=require("fs");' +
      'bg.withMarkerLock(process.env.BG_STATE_DIR,process.env.BG_PORT,()=>{' +
      '  bg.writeMarker(process.env.BG_STATE_DIR,JSON.parse(process.env.BG_M2));' +
      '  fs.writeFileSync(process.env.BG_DONE,"1");' +
      '});'], {
      stdio: "ignore",
      env: {
        ...process.env, BG_MODULE: modulePath, BG_STATE_DIR: stateDir, BG_PORT: port,
        BG_M2: JSON.stringify(m2), BG_DONE: doneB,
      },
    });
    t.after(() => { try { successor.kill("SIGKILL"); } catch {} });
    await sleep(400);
    assert.equal(fs.existsSync(doneB), false, "a live holder's lock must not be stolen");
    holder.kill("SIGKILL"); // kernel auto-releases the dead holder's lock
    await waitFile(doneB);
    const kept = browserGroups.readMarker(stateDir, port);
    assert.equal(kept?.pgid, m2.pgid, "successor marker must survive after kernel release");
  }

  // (b) a paused-but-alive holder is never stolen: the contender times out.
  {
    const { stateDir } = newState();
    const port = "19502";
    const readyA = path.join(stateDir, "lock2-a-ready");
    const resultB = path.join(stateDir, "lock2-b-result");
    const holder = spawn(process.execPath, ["-e",
      'const bg=require(process.env.BG_MODULE);const fs=require("fs");' +
      'bg.withMarkerLock(process.env.BG_STATE_DIR,process.env.BG_PORT,()=>{' +
      '  fs.writeFileSync(process.env.BG_READY,"1");' +
      '  const end=Date.now()+60000;while(Date.now()<end){}' +
      '});'], {
      stdio: "ignore",
      env: { ...process.env, BG_MODULE: modulePath, BG_STATE_DIR: stateDir, BG_PORT: port, BG_READY: readyA },
    });
    t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
    await waitFile(readyA);
    const contender = spawn(process.execPath, ["-e",
      'const bg=require(process.env.BG_MODULE);const fs=require("fs");' +
      'try{bg.withMarkerLock(process.env.BG_STATE_DIR,process.env.BG_PORT,()=>{});' +
      '  fs.writeFileSync(process.env.BG_RES,"acquired");}catch(e){' +
      '  fs.writeFileSync(process.env.BG_RES,"timeout");}'], {
      stdio: "ignore",
      env: {
        ...process.env, BG_MODULE: modulePath, BG_STATE_DIR: stateDir, BG_PORT: port,
        BG_RES: resultB, BG_MARKER_LOCK_WAIT_MS: "1500",
      },
    });
    t.after(() => { try { contender.kill("SIGKILL"); } catch {} });
    await waitFile(resultB);
    assert.equal(fs.readFileSync(resultB, "utf8"), "timeout", "contender must wait out a live holder");
    assert.ok(fs.existsSync(browserGroups.markerLockPath(stateDir, port)), "lock file persists");
    assert.equal(browserGroups.isPidAlive(holder.pid), true, "holder is untouched");
    holder.kill("SIGKILL");
  }

  const realBoot = browserGroups.currentBootId();
  const ledgerFor = (stateDir, leases) =>
    fs.writeFileSync(browserGroups.ledgerPathFor(stateDir), JSON.stringify({ accounts: {}, leases }));

  // (c) stopChrome with a live foreign CDP client: busy, no signal.
  {
    const { stateDir } = newState();
    const port = 19503;
    const pgid = await fakeChromeGroup(port);
    markOrphan(stateDir, port, pgid);
    const listener = net.createServer();
    await new Promise((r) => listener.listen(port, "127.0.0.1", r));
    const clientProc = spawn(process.execPath, [
      "-e",
      `require("net").connect(${port},"127.0.0.1").on("connect",()=>setInterval(()=>{},1e9)).on("error",()=>process.exit(2))`,
    ], { stdio: "ignore" });
    t.after(() => { try { clientProc.kill("SIGKILL"); } catch {} if (listener.listening) listener.close(); });
    for (let i = 0; i < 60 && !browserGroups.hasLiveCdpClients(port); i++) await sleep(50);
    assert.equal(browserGroups.hasLiveCdpClients(port), true, "external CDP client must be visible");
    const res = await driver.stopChrome(port, stateDir, { busyWaitMs: 1500, pollMs: 150 });
    assert.equal(res.status, "busy");
    assert.equal(res.reason, "cdp-clients");
    assert.equal(browserGroups.groupExists(pgid), true, "busy group must not be signaled");
    assert.ok(browserGroups.readMarker(stateDir, String(port)), "marker is kept while busy");
    clientProc.kill("SIGKILL");
    await new Promise((r) => listener.close(r));
  }

  // (d) stopChrome with a live foreign lease: busy 'lease'; own-pid lease is
  //     not a veto (the bindBackend caller holds it during restart).
  {
    const { stateDir } = newState();
    const port = "19504";
    const pgid = await fakeChromeGroup(port);
    markOrphan(stateDir, port, pgid);
    const holder = spawn("sleep", ["60"], { stdio: "ignore" });
    t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
    ledgerFor(stateDir, { acc1: { pid: holder.pid, acquiredMs: Date.now(), cdp: String(port) } });
    let res = await driver.stopChrome(port, stateDir, { busyWaitMs: 1500, pollMs: 150 });
    assert.equal(res.status, "busy");
    assert.equal(res.reason, "lease");
    assert.equal(browserGroups.groupExists(pgid), true, "leased group must not be signaled");
    // Our own lease does not veto: once the foreign lease is gone and only
    // ours remains, the teardown proceeds.
    ledgerFor(stateDir, { acc1: { pid: process.pid, acquiredMs: Date.now(), cdp: String(port) } });
    res = await driver.stopChrome(port, stateDir, { busyWaitMs: 4000, pollMs: 100 });
    assert.equal(res.status, "torn-down");
    assert.equal(browserGroups.groupMembers(pgid).length, 0);
    assert.equal(browserGroups.readMarker(stateDir, port), null);
    groupPids.splice(groupPids.indexOf(pgid), 1);
  }

  // (e) stopChrome on a reaping port: retries while the mark is fresh and
  //     never signals; once the in-flight mark clears it finishes the
  //     teardown itself.
  {
    const { stateDir } = newState();
    const port = "19505";
    const pgid = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
      reaping: { by: 424242, sinceMs: Date.now() },
    });
    const p = driver.stopChrome(port, stateDir, { busyWaitMs: 6000, pollMs: 150 });
    await sleep(500);
    assert.equal(browserGroups.isPidAlive(pgid), true, "no signal while the port is reaping");
    // The in-flight teardown finishes — the mark clears; our retry must
    // complete the teardown instead of reporting busy forever.
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
    });
    const res = await p;
    assert.equal(res.status, "torn-down");
    assert.equal(browserGroups.groupMembers(pgid).length, 0);
    assert.equal(browserGroups.readMarker(stateDir, port), null);
    groupPids.splice(groupPids.indexOf(pgid), 1);
  }

  // (e2) a reaping mark that never clears → busy, still no signal.
  {
    const { stateDir } = newState();
    const port = "19506";
    const pgid = await fakeChromeGroup(port);
    browserGroups.writeMarker(stateDir, {
      version: 1, port, pgid,
      pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
      ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
      launchedMs: Date.now() - 10 * 60_000,
      reaping: { by: 424242, sinceMs: Date.now() },
    });
    const res = await driver.stopChrome(port, stateDir, { busyWaitMs: 1500, pollMs: 150 });
    assert.equal(res.status, "busy");
    assert.equal(res.reason, "reaping");
    assert.equal(browserGroups.groupExists(pgid), true, "reaping port must not be signaled");
  }

  // (f) unmanaged group: no marker → absent, and nothing is killed — the
  //     old global pkill-by-port-flag is gone from the automatic path.
  {
    const { stateDir } = newState();
    const port = "19507";
    const pgid = await fakeChromeGroup(port);
    const res = await driver.stopChrome(port, stateDir, { busyWaitMs: 1000, pollMs: 100 });
    assert.equal(res.status, "absent");
    assert.equal(browserGroups.isPidAlive(pgid), true, "unmarked chrome is never touched");
  }

  // (g) happy path: dead owner + no lease + no clients → torn down, marker
  //     removed.
  {
    const { stateDir } = newState();
    const port = "19508";
    const pgid = await fakeChromeGroup(port);
    markOrphan(stateDir, port, pgid);
    const res = await driver.stopChrome(port, stateDir, { busyWaitMs: 4000, pollMs: 100 });
    assert.equal(res.status, "torn-down");
    assert.equal(browserGroups.groupMembers(pgid).length, 0);
    assert.equal(browserGroups.readMarker(stateDir, port), null);
    groupPids.splice(groupPids.indexOf(pgid), 1);
  }
});

test("32. browser-groups: no flock on linux fails closed — no in-process degrade (заход 7)", async (t) => {
  if (process.platform !== "linux") return;
  // The fixture requires a healthy host: flock must exist HERE — the child
  // loses it only through a stripped PATH.
  assert.equal(
    spawnSync("flock", ["--version"], { stdio: "ignore" }).status,
    0,
    "fixture requires util-linux flock on this host"
  );
  const groupPids = [];
  const modulePath = path.join(PLUGIN_ROOT, "src/browser-groups.cjs");
  const stateDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-z7-")));
  fs.writeFileSync(path.join(stateDir, "accounts-state.json"), JSON.stringify({ accounts: {}, leases: {} }));
  const port = "19509";
  const proc = spawn("bash", ["-c", `exec -a "faux-chrome --remote-debugging-port=${port}" sleep 600`], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  groupPids.push(proc.pid);
  t.after(() => {
    for (const pgid of groupPids) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
    groupPids.length = 0;
  });
  for (let i = 0; i < 60 && !browserGroups.cmdlineMatchesPort(proc.pid, port); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const pgid = proc.pid;
  browserGroups.writeMarker(stateDir, {
    version: 1, port, pgid,
    pgidStartTime: browserGroups.readProcStat(pgid)?.startTime ?? null,
    ownerPid: spawnSync("true").pid, ownerStartTime: 0, mode: "xvfb",
    launchedMs: Date.now() - 10 * 60_000,
  });
  const before = fs.readFileSync(browserGroups.markerPath(stateDir, port), "utf8");

  const noFlockPath = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "bg374-nopath-")));
  const waitFile = async (f, what) => {
    for (let i = 0; i < 100 && (!fs.existsSync(f) || fs.statSync(f).size === 0); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fs.existsSync(f) && fs.statSync(f).size > 0, `child did not signal ${what}`);
  };
  const readyA = path.join(stateDir, "z7-holder-ready");
  const resB = path.join(stateDir, "z7-noflock-result.json");
  const enteredB = path.join(stateDir, "z7-noflock-entered");

  // A live holder (healthy PATH) parks inside the port's critical section.
  const holder = spawn(process.execPath, ["-e",
    'const bg=require(process.env.BG_MODULE);const fs=require("fs");' +
    'bg.withMarkerLock(process.env.BG_STATE_DIR,process.env.BG_PORT,()=>{' +
    '  fs.writeFileSync(process.env.BG_READY,"1");' +
    '  const end=Date.now()+60000;while(Date.now()<end){}' +
    '});'], {
    stdio: "ignore",
    env: { ...process.env, BG_MODULE: modulePath, BG_STATE_DIR: stateDir, BG_PORT: port, BG_READY: readyA },
  });
  t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
  await waitFile(readyA, "holder-ready");

  // The contender runs with a PATH that has no flock. Every serialized
  // operation — the lock itself, marker write/remove, adoption, record and
  // the whole teardown pipeline — must refuse with BG_LOCK_UNAVAILABLE
  // instead of degrading to the in-process map and entering concurrently
  // with the live kernel-lock holder.
  const m2 = JSON.stringify({
    version: 1, port, pgid: process.pid, ownerPid: process.pid,
    mode: "xvfb", launchedMs: Date.now(),
  });
  const contenderScript =
    'const bg=require(process.env.BG_MODULE);const fs=require("fs");\n' +
    '(async()=>{const out={};\n' +
    'const rec=(k,fn)=>{try{const v=fn();out[k]={ok:true,value:v==null?null:String(v)};}' +
    'catch(e){out[k]={ok:false,code:e&&e.code||null,msg:String(e&&e.message||e).slice(0,300)};}};\n' +
    'rec("lock",()=>bg.withMarkerLock(process.env.BG_STATE_DIR,process.env.BG_PORT,()=>{' +
    'fs.writeFileSync(process.env.BG_ENTERED,"1");return "entered";}));\n' +
    'rec("write",()=>{bg.writeMarker(process.env.BG_STATE_DIR,JSON.parse(process.env.BG_M2));return "wrote";});\n' +
    'rec("remove",()=>{bg.removeMarker(process.env.BG_STATE_DIR,process.env.BG_PORT);return "removed";});\n' +
    'rec("adopt",()=>{const r=bg.adoptGroup(process.env.BG_STATE_DIR,process.env.BG_PORT);return r?"adopted":"declined";});\n' +
    'rec("record",()=>{const r=bg.recordGroup({stateDir:process.env.BG_STATE_DIR,port:process.env.BG_PORT,pgid:process.pid});return r?"recorded":"skipped";});\n' +
    'try{const r=await bg.teardownGroup({stateDir:process.env.BG_STATE_DIR,port:process.env.BG_PORT});' +
    'out.teardown={ok:true,value:r.status};}catch(e){out.teardown={ok:false,code:e&&e.code||null,msg:String(e&&e.message||e).slice(0,300)};}\n' +
    'fs.writeFileSync(process.env.BG_RES,JSON.stringify(out));\n' +
    '})().catch((e)=>{try{fs.writeFileSync(process.env.BG_RES,"FATAL:"+String(e));}catch{}});\n';
  const contender = spawn(process.execPath, ["-e", contenderScript], {
    stdio: "ignore",
    env: {
      ...process.env,
      PATH: noFlockPath, // no util-linux flock on this PATH
      BG_MODULE: modulePath, BG_STATE_DIR: stateDir, BG_PORT: port,
      BG_M2: m2, BG_RES: resB, BG_ENTERED: enteredB,
    },
  });
  t.after(() => { try { contender.kill("SIGKILL"); } catch {} });
  await waitFile(resB, "contender result");

  const out = JSON.parse(fs.readFileSync(resB, "utf8"));
  for (const key of ["lock", "write", "remove", "adopt", "record", "teardown"]) {
    assert.equal(out[key]?.ok, false, `${key} must refuse without flock`);
    assert.equal(out[key]?.code, "BG_LOCK_UNAVAILABLE", `${key} refusal must carry the diagnostic code`);
    assert.match(out[key]?.msg || "", /flock/i, `${key} refusal must name the cause`);
  }
  assert.equal(fs.existsSync(enteredB), false, "the contender must never enter the critical section");
  assert.equal(
    fs.readFileSync(browserGroups.markerPath(stateDir, port), "utf8"),
    before,
    "marker must be untouched by refused writes"
  );
  assert.equal(browserGroups.isPidAlive(pgid), true, "no signal may escape the refused teardown");
  assert.equal(browserGroups.groupExists(pgid), true, "group alive — teardown never reached the signal path");
  assert.equal(browserGroups.isPidAlive(holder.pid), true, "holder untouched");
  holder.kill("SIGKILL");
});

test("35. PLUG-407: thinking/search progress extends stall, pending-response target, STALL_MS floors", async () => {
  const PROMPT = "Deep research the repository layout";
  const PREFIX = PROMPT.replace(/\s+/g, " ").trim().slice(0, 40);
  const ENV_KEYS = [
    "WEB_GEMINI_STALL_MS",
    "ARGON_STALL_MS",
    "WEB_GEMINI_SESSION_CAP_MS",
    "ARGON_SESSION_CAP_MS",
  ];
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const realDateNow = Date.now;
  const restoreAll = () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    Date.now = realDateNow;
    _setDriverHooks(null);
  };

  const stopBtnEl = () =>
    createMockElement({
      id: "stop-0",
      tagName: "button",
      attributes: { "aria-label": "Stop generating", "data-test-id": "stop-button" },
    });
  const uq = (following) =>
    createMockElement({ id: "q0", tagName: "user-query", innerText: PROMPT, following });
  const docOf = (children) => {
    const root = createMockElement({ id: "doc-root", tagName: "body", children });
    return {
      querySelectorAll(sel) {
        const res = root.querySelectorAll(sel);
        if (nodeMatchesSelector(root, sel)) res.unshift(root);
        return res;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
    };
  };
  const animatedThinking = (text = "Searching the web…") =>
    createMockElement({
      id: "an0",
      tagName: "div",
      innerText: text,
      attributes: { class: "animated-thinking-content" },
    });
  // PLUG-413: like the live DOM, the pending-response's innerText carries the
  // status chrome ("Searching the web…") — raw text that is NOT an answer.
  const thinkingDoc = ({ stop = true, text = "Searching the web…", spinner = false } = {}) =>
    docOf([
      uq(["p0", "r0"]),
      createMockElement({
        id: "p0",
        tagName: "pending-response",
        preceding: ["q0"],
        innerText: text,
        children: [
          ...(spinner ? [createMockElement({ id: "sp0", tagName: "mat-spinner" })] : []),
          createMockElement({
            id: "ov0",
            tagName: "thinking-overlay",
            children: [animatedThinking(text)],
          }),
        ],
      }),
      ...(stop ? [stopBtnEl()] : []),
    ]);
  const streamDoc = (text, { stop = true, done = false } = {}) =>
    docOf([
      uq(["p0", "r0"]),
      createMockElement({
        id: "r0",
        tagName: "model-response",
        preceding: ["q0"],
        innerText: text,
        children: [
          createMockElement({ id: "mc0", tagName: "message-content", innerText: text }),
          ...(done ? [createMockElement({ id: "fb0", tagName: "response-feedback" })] : []),
        ],
      }),
      ...(stop ? [stopBtnEl()] : []),
    ]);
  const frozenDoc = () => streamDoc("");

  // Harness: page-level evaluations run the REAL findTurnTarget /
  // checkTurnStatus against a mutable mock document.
  const harness = ({ advanceMs = 200 } = {}) => {
    const state = {
      doc: frozenDoc(),
      stopVisible: true,
      stopClicked: false,
      now: 1_000_000,
      poll: 0,
      firstStatusAt: null,
      onPoll: null,
    };
    Date.now = () => state.now;
    const page = {
      url: () => "https://gemini.google.com/app",
      goto: async () => {},
      waitForSelector: async () => ({
        click: async () => {},
        innerText: async () => "",
        getAttribute: async () => null,
      }),
      waitForTimeout: async () => {
        state.now += advanceMs;
      },
      keyboard: { press: async () => {}, insertText: async () => {} },
      $: async (sel) => {
        if (sel && /stop/i.test(sel) && state.stopVisible) {
          return {
            click: async () => {
              state.stopClicked = true;
            },
            isDisabled: async () => false,
          };
        }
        return null;
      },
      $$: async () => [],
      evaluate: async (fn, arg) => {
        const src = typeof fn === "function" ? fn.toString() : "";
        if (src.includes("maxLength")) return null;
        if (src.includes("Before you continue")) return "none";
        if (arg && arg.sel) return true;
        if (arg && arg.checkSrc) {
          state.firstStatusAt ??= state.now;
          const status = checkTurnStatus(state.doc, arg.idx, arg.promptPrefix);
          const p = state.poll++;
          state.onPoll?.(p, status);
          return status;
        }
        if (arg && arg.candSrc) {
          // collectGeneratedFiles scan: REAL findGeneratedFileCandidates.
          state.fileScans = (state.fileScans || 0) + 1;
          const target = findTurnTarget(state.doc, arg.idx, arg.promptPrefix);
          if (!target) return { candidates: [], meta: {} };
          return {
            candidates: findGeneratedFileCandidates(target, {
              detectOnly: arg.detectOnly,
              tagAttr: arg.tagAttr,
            }),
            meta: {},
          };
        }
        if (arg && arg.fnSrc) {
          const target = findTurnTarget(state.doc, arg.idx, arg.promptPrefix);
          if (src.includes("querySelector('message-content')")) {
            const mc = target && target.querySelector("message-content");
            return mc ? mc.innerText : null;
          }
          return target !== null || state.stopVisible;
        }
        return null;
      },
    };
    const drive = (args) => {
      _setDriverHooks({
        ensureChrome: async () => {},
        connectOverCDP: async () => ({ close: async () => {} }),
        getGeminiPage: async () => page,
      });
      return sendPrompt(args);
    };
    return { state, drive };
  };

  // Bound every negative scenario: a buggy non-stalling turn must exit via the
  // session cap quickly instead of looping forever.
  process.env.WEB_GEMINI_SESSION_CAP_MS = "20000";

  try {
    // --- 1. Active .animated-thinking-content + visible stop button: no stall ---
    {
      const st = checkTurnStatus(thinkingDoc(), 0, PREFIX);
      assert.equal(st.targetFound, true, "pending-response must be the turn target");
      assert.equal(
        st.hasActiveThinkingOrTool,
        true,
        ".animated-thinking-content with text must be an active indicator"
      );
      assert.equal(
        st.statusText,
        "Searching the web...",
        "statusText must carry normalized status text (ellipsis normalized)"
      );

      // Rule 2: a status phrase inside .tool-status counts as active too.
      const toolDoc = (text) =>
        docOf([
          uq(["p0"]),
          createMockElement({
            id: "p0",
            tagName: "pending-response",
            preceding: ["q0"],
            children: [
              createMockElement({
                id: "ts0",
                tagName: "div",
                innerText: text,
                attributes: { class: "tool-status" },
              }),
            ],
          }),
          stopBtnEl(),
        ]);
      assert.equal(
        checkTurnStatus(toolDoc("Ищу в интернете…"), 0, PREFIX).hasActiveThinkingOrTool,
        true,
        "status phrase in .tool-status must be active"
      );
      assert.equal(
        checkTurnStatus(toolDoc("Sources panel"), 0, PREFIX).hasActiveThinkingOrTool,
        false,
        ".tool-status without a status phrase must not be active"
      );

      const h = harness();
      h.state.doc = thinkingDoc();
      let thinkingSpanMs = null;
      const FINAL = "Part one. Part two. Part three. Final answer.";
      const grows = [
        "Part one. ",
        "Part one. Part two. ",
        "Part one. Part two. Part three. ",
      ];
      h.state.onPoll = (p) => {
        if (p < 3) return; // polls 0-3: still thinking (600ms+ > stallMs=300)
        if (p === 3) {
          thinkingSpanMs = h.state.now - h.state.firstStatusAt;
          h.state.doc = streamDoc(grows[0]);
          return;
        }
        if (p === 4) {
          h.state.doc = streamDoc(grows[1]);
          return;
        }
        if (p === 5) {
          h.state.doc = streamDoc(grows[2]);
          return;
        }
        h.state.doc = streamDoc(FINAL, { stop: false, done: true });
        h.state.stopVisible = false;
      };
      const res = await h.drive({ prompt: PROMPT, isNewChat: false, stallMs: 300 });
      assert.equal(String(res), FINAL, "turn must complete after the thinking phase");
      assert.ok(
        thinkingSpanMs !== null && thinkingSpanMs >= 600,
        `thinking phase must survive past stallMs=300 without stalling, got ${thinkingSpanMs}ms`
      );
    }

    // --- 2. Plain spinner is busy, not progress: still stalls at STALL_MS ---
    {
      const spinnerDoc = () =>
        docOf([
          uq(["r0"]),
          createMockElement({
            id: "r0",
            tagName: "model-response",
            preceding: ["q0"],
            innerText: "",
            children: [
              createMockElement({ id: "mc0", tagName: "message-content", innerText: "" }),
              createMockElement({ id: "sp0", tagName: "mat-spinner" }),
            ],
          }),
          stopBtnEl(),
        ]);
      const st = checkTurnStatus(spinnerDoc(), 0, PREFIX);
      assert.equal(st.isBusyOrThinking, true, "mat-spinner must count as busy");
      assert.equal(st.hasActiveThinkingOrTool, false, "mat-spinner must NOT be progress");

      const h = harness();
      h.state.doc = spinnerDoc();
      h.state.stopVisible = true;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, stallMs: 400 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
      const delta = h.state.now - h.state.firstStatusAt;
      assert.ok(
        delta >= 0 && delta <= 1000,
        `spinner-only turn must stall near stallMs=400, got ${delta}ms`
      );
      assert.equal(h.state.stopClicked, true, "stopGeneration must run on stall");
    }

    // --- 3. No stop button (awaitingContent): indicator must NOT extend the stall ---
    {
      const st = checkTurnStatus(thinkingDoc({ stop: false }), 0, PREFIX);
      assert.equal(st.hasStopButton, false);
      assert.equal(st.hasActiveThinkingOrTool, true);

      const h = harness();
      h.state.doc = thinkingDoc({ stop: false });
      h.state.stopVisible = false;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, stallMs: 400 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
      const delta = h.state.now - h.state.firstStatusAt;
      assert.ok(
        delta >= 0 && delta <= 1000,
        `awaitingContent turn must stall near stallMs=400 despite the indicator, got ${delta}ms`
      );
    }

    // --- 4. Static thinking-overlay > .thinking-container (no animated layer): stalls ---
    {
      const staticDoc = () =>
        docOf([
          uq(["p0"]),
          createMockElement({
            id: "p0",
            tagName: "pending-response",
            preceding: ["q0"],
            children: [
              createMockElement({
                id: "ov0",
                tagName: "thinking-overlay",
                children: [
                  createMockElement({
                    id: "tc0",
                    tagName: "div",
                    innerText: "Thinking…",
                    attributes: { class: "thinking-container" },
                  }),
                ],
              }),
            ],
          }),
          stopBtnEl(),
        ]);
      const st = checkTurnStatus(staticDoc(), 0, PREFIX);
      assert.equal(
        st.hasActiveThinkingOrTool,
        false,
        "static thinking-container without animated content must not be progress"
      );
      assert.equal(st.statusText, "Thinking...", "container text still enters statusText");

      const h = harness();
      h.state.doc = staticDoc();
      h.state.stopVisible = true;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, stallMs: 400 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
    }

    // --- 5. model-thoughts subtree isolation: animated layer inside it is excluded ---
    {
      const thoughtsDoc = () =>
        docOf([
          uq(["r0"]),
          createMockElement({
            id: "r0",
            tagName: "model-response",
            preceding: ["q0"],
            innerText: "Show thinking",
            children: [
              createMockElement({
                id: "mt0",
                tagName: "model-thoughts",
                innerText: "",
                children: [animatedThinking()],
              }),
            ],
          }),
          stopBtnEl(),
        ]);
      const st = checkTurnStatus(thoughtsDoc(), 0, PREFIX);
      assert.equal(
        st.hasActiveThinkingOrTool,
        false,
        "indicator inside model-thoughts must be excluded"
      );
      assert.equal(st.statusText, null, "model-thoughts text must not enter statusText");

      const h = harness();
      h.state.doc = thoughtsDoc();
      h.state.stopVisible = true;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, stallMs: 400 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
    }

    // --- 6. message-content subtree isolation: status phrase inside it is excluded ---
    {
      const mcStatusDoc = () =>
        docOf([
          uq(["r0"]),
          createMockElement({
            id: "r0",
            tagName: "model-response",
            preceding: ["q0"],
            innerText: "",
            children: [
              createMockElement({
                id: "mc0",
                tagName: "message-content",
                innerText: "",
                children: [
                  createMockElement({
                    id: "ts0",
                    tagName: "div",
                    innerText: "Поиск в интернете",
                    attributes: { class: "tool-status" },
                  }),
                ],
              }),
            ],
          }),
          stopBtnEl(),
        ]);
      const st = checkTurnStatus(mcStatusDoc(), 0, PREFIX);
      assert.equal(
        st.hasActiveThinkingOrTool,
        false,
        "status phrase inside message-content must be excluded"
      );
      assert.equal(st.statusText, null, "message-content text must not enter statusText");

      const h = harness();
      h.state.doc = mcStatusDoc();
      h.state.stopVisible = true;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, stallMs: 400 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
    }

    // --- 7a. Priority: model-response[idx] wins over pending-response ---
    {
      const doc = docOf([
        uq(["r0", "p0"]),
        createMockElement({
          id: "r0",
          tagName: "model-response",
          preceding: ["q0"],
          innerText: "answer",
        }),
        createMockElement({ id: "p0", tagName: "pending-response", preceding: ["q0"] }),
      ]);
      const t = findTurnTarget(doc, 0, PREFIX);
      assert.equal(t && t.id, "r0", "model-response[idx] must win over pending-response");
    }

    // --- 7b. Stale pending-response before lastQuery never becomes the target ---
    {
      const q1 = createMockElement({
        id: "q1",
        tagName: "user-query",
        innerText: PROMPT,
        preceding: ["q0", "r0", "p-old"],
        following: ["r1"],
      });
      const base = [
        createMockElement({
          id: "q0",
          tagName: "user-query",
          innerText: "Old question",
          following: ["r0", "p-old", "q1", "r1"],
        }),
        createMockElement({
          id: "r0",
          tagName: "model-response",
          preceding: ["q0"],
          following: ["p-old", "q1", "r1"],
        }),
        createMockElement({
          id: "p-old",
          tagName: "pending-response",
          preceding: ["q0", "r0"],
          following: ["q1", "r1"],
        }),
        q1,
      ];
      assert.equal(
        findTurnTarget(docOf(base), 1, PREFIX),
        null,
        "stale pending-response before lastQuery must not become the target"
      );
      const r1 = createMockElement({
        id: "r1",
        tagName: "model-response",
        preceding: ["q0", "r0", "p-old", "q1"],
      });
      const withR1 = docOf([...base, r1]);
      assert.equal(
        findTurnTarget(withR1, 1, PREFIX) && findTurnTarget(withR1, 1, PREFIX).id,
        "r1",
        "old pending-response must not shift the model-response index"
      );
    }

    // --- 7c. Turn starts on pending-response, finishes on model-response ---
    {
      const h = harness();
      h.state.doc = thinkingDoc();
      const FINAL = "Streamed answer from model-response.";
      const seen = [];
      h.state.onPoll = (p, status) => {
        seen.push(status);
        if (p < 2) return; // two thinking ticks on pending-response
        if (p === 2) {
          h.state.doc = streamDoc(FINAL);
          return;
        }
        h.state.doc = streamDoc(FINAL, { stop: false, done: true });
        h.state.stopVisible = false;
      };
      const res = await h.drive({ prompt: PROMPT, isNewChat: false, stallMs: 300 });
      assert.equal(String(res), FINAL, "text must come from the model-response");
      assert.equal(
        seen[0] && seen[0].targetFound,
        true,
        "pending-response phase must already report targetFound"
      );
      assert.equal(
        seen[0] && seen[0].hasActiveThinkingOrTool,
        true,
        "pending-response phase must report active thinking"
      );
    }

    // --- 8a. Explicit stallMs is unclamped — the thinking-high floor must not apply ---
    {
      const h = harness();
      // PLUG-413: for thinking: "high" a visible stop button excludes the stall
      // window — the stall requires a first poll without stop button and answer.
      h.state.doc = streamDoc("", { stop: false });
      h.state.stopVisible = false;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 300 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
      const delta = h.state.now - h.state.firstStatusAt;
      assert.ok(
        delta >= 0 && delta <= 600,
        `explicit stallMs=300 must hold even for thinking high, got ${delta}ms after first poll`
      );
    }

    // --- 8b. Invalid explicit stallMs falls back to env ---
    {
      process.env.WEB_GEMINI_STALL_MS = "700";
      const h = harness();
      h.state.doc = frozenDoc();
      h.state.stopVisible = true;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, stallMs: -1 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
      const delta = h.state.now - h.state.firstStatusAt;
      assert.ok(
        delta >= 400 && delta <= 900,
        `invalid stallMs must fall back to env 700ms, got ${delta}ms after first poll`
      );
      delete process.env.WEB_GEMINI_STALL_MS;
    }

    // --- 8c. thinking: "high" floor: STALL_MS = max(env, 600_000) ---
    {
      process.env.WEB_GEMINI_STALL_MS = "500";
      process.env.WEB_GEMINI_SESSION_CAP_MS = "3600000"; // cap must exceed the 600s floor
      const h = harness({ advanceMs: 60_000 }); // one fake minute per poll
      h.state.doc = streamDoc("", { stop: false });
      h.state.stopVisible = false;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high" }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
      const delta = h.state.now - h.state.firstStatusAt;
      assert.ok(
        delta >= 480_000 && delta <= 660_000,
        `thinking-high turn must stall near the 600s floor (env=500 ignored), got ${delta}ms after first poll`
      );
      delete process.env.WEB_GEMINI_STALL_MS;
      process.env.WEB_GEMINI_SESSION_CAP_MS = "20000";
    }

    // --- 8d. thinking: "high" with env > 600_000: env takes precedence ---
    {
      process.env.WEB_GEMINI_STALL_MS = "900000"; // 15 min
      process.env.WEB_GEMINI_SESSION_CAP_MS = "3600000";
      const h = harness({ advanceMs: 60_000 }); // one fake minute per poll
      h.state.doc = streamDoc("", { stop: false });
      h.state.stopVisible = false;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high" }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
      const delta = h.state.now - h.state.firstStatusAt;
      assert.ok(
        delta >= 840_000 && delta <= 960_000,
        `thinking-high turn must stall near the env 900s value (above 600s floor), got ${delta}ms after first poll`
      );
      delete process.env.WEB_GEMINI_STALL_MS;
      process.env.WEB_GEMINI_SESSION_CAP_MS = "20000";
    }

    // --- 9. PLUG-413 §2.3: thinking high — stop button is the only stall gate ---
    // Session cap for this block exceeds the poll interval many times over, so a
    // premature stall on the old code path is observable (not masked by the cap).
    const HIGH_CAP_MS = 20 * 60_000;
    const noTargetDoc = ({ stop = false } = {}) => docOf([uq([]), ...(stop ? [stopBtnEl()] : [])]);

    // (а) Stop visible 15+ min, DOM and text frozen — no stall; the turn runs to
    // the session cap (truncated-answer timeout), never WEB_GEMINI_STALLED.
    {
      process.env.WEB_GEMINI_SESSION_CAP_MS = String(HIGH_CAP_MS);
      const h = harness({ advanceMs: 60_000 }); // one fake minute per poll
      h.state.doc = streamDoc("");
      h.state.stopVisible = true;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 120_000 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STREAM_TIMEOUT", `stop visible must never stall, got ${err.code}`);
          return true;
        }
      );
      const span = h.state.now - h.state.firstStatusAt;
      assert.ok(span >= 15 * 60_000, `stop-visible turn must survive 15 min, got ${span}ms`);
      assert.ok(h.state.poll >= 15, `cap must exceed the poll interval (>=15 polls), got ${h.state.poll}`);
      process.env.WEB_GEMINI_SESSION_CAP_MS = "20000";
    }

    // (б) Stop disappears, no answer; spinner stays and statusText (domSig) changes
    // every poll; the pending-response carries raw "Searching the web…" text —
    // stalled on the first poll at stallMs after the stop vanished, not earlier.
    {
      process.env.WEB_GEMINI_SESSION_CAP_MS = String(HIGH_CAP_MS);
      const h = harness({ advanceMs: 200 });
      h.state.doc = thinkingDoc({ stop: false, spinner: true });
      h.state.stopVisible = true;
      let goneAt = null;
      h.state.onPoll = (p) => {
        h.state.doc = thinkingDoc({ stop: false, spinner: true, text: `Searching the web… step ${p}` });
        if (p === 3) {
          h.state.stopVisible = false;
          goneAt = h.state.now;
        }
      };
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 1000 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED");
          return true;
        }
      );
      const delta = h.state.now - goneAt;
      assert.ok(delta >= 1000 && delta < 1200, `stall must come at stallMs after stop vanished, got ${delta}ms`);
      process.env.WEB_GEMINI_SESSION_CAP_MS = "20000";
    }

    // (в) Stop never shown, target empty — stalled at stallMs from the first poll.
    {
      const h = harness({ advanceMs: 200 });
      h.state.doc = streamDoc("", { stop: false });
      h.state.stopVisible = false;
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 1000 }),
        (err) => err.code === "WEB_GEMINI_STALLED"
      );
      const delta = h.state.now - h.state.firstStatusAt;
      assert.ok(delta >= 1000 && delta < 1200, `stall must come at stallMs from the first poll, got ${delta}ms`);
    }

    // (г1) Target lost without an answer — stalled at stallMs.
    {
      const h = harness({ advanceMs: 200 });
      h.state.doc = noTargetDoc();
      // Stop is seen by the generation-start check only, then vanishes on poll 0.
      h.state.stopVisible = true;
      h.state.onPoll = (p) => {
        if (p === 0) h.state.stopVisible = false;
      };
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 1000 }),
        (err) => err.code === "WEB_GEMINI_STALLED"
      );
      const delta = h.state.now - h.state.firstStatusAt;
      assert.ok(delta >= 1000 && delta < 1200, `lost target must stall at stallMs, got ${delta}ms`);
    }

    // (г2) Target lost after message-content text was captured, no stop — the turn
    // completes with the captured answer right away (not at the session cap).
    {
      const h = harness({ advanceMs: 200 });
      h.state.doc = streamDoc("Captured answer.");
      h.state.stopVisible = true;
      h.state.onPoll = (p) => {
        if (p === 1) {
          h.state.doc = noTargetDoc();
          h.state.stopVisible = false;
        }
      };
      const res = await h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 5000 });
      assert.equal(String(res), "Captured answer.");
      const span = h.state.now - h.state.firstStatusAt;
      assert.ok(span < 2000, `lost target after the answer must finish immediately, got ${span}ms`);
    }

    // (г3) Raw pending-response text is not an answer: target lost after only
    // "Searching the web…" was seen, no stop — stall, never an "answer".
    {
      const h = harness({ advanceMs: 200 });
      h.state.doc = thinkingDoc({ stop: false });
      h.state.stopVisible = false;
      h.state.onPoll = (p) => {
        if (p === 1) h.state.doc = noTargetDoc();
      };
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 1000 }),
        (err) => err.code === "WEB_GEMINI_STALLED"
      );
    }

    // (г5) Target still found, but message-content empties after text was captured
    // under Stop, then Stop vanishes — stale captured text is not an answer
    // (§2.3 п.3: with the target found the answer is hasFinishedContent only):
    // stalled at stallMs after Stop vanished, not held until the session cap.
    {
      process.env.WEB_GEMINI_SESSION_CAP_MS = String(HIGH_CAP_MS);
      const h = harness({ advanceMs: 200 });
      h.state.doc = streamDoc("Answer text");
      h.state.stopVisible = true;
      let goneAt = null;
      h.state.onPoll = (p) => {
        if (p === 2) {
          h.state.doc = streamDoc("", { stop: false });
          h.state.stopVisible = false;
          goneAt = h.state.now;
        }
      };
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 1000 }),
        (err) => {
          assert.equal(err.code, "WEB_GEMINI_STALLED", `emptied message-content must stall, got ${err.code}`);
          return true;
        }
      );
      const delta = h.state.now - goneAt;
      assert.ok(delta >= 1000 && delta < 1400, `stall must come at stallMs after stop vanished, got ${delta}ms`);
      process.env.WEB_GEMINI_SESSION_CAP_MS = "20000";
    }

    // (г4) Brief target loss mid-stream while the stop button is visible must not
    // truncate the answer in any thinking mode — the full answer is returned.
    for (const thinking of ["low", "medium", "high"]) {
      const h = harness({ advanceMs: 200 });
      const FULL = "Partial head. And the full tail of the answer.";
      h.state.doc = streamDoc("Partial head.");
      h.state.stopVisible = true;
      h.state.onPoll = (p) => {
        if (p === 1) h.state.doc = noTargetDoc({ stop: true });
        if (p === 3) h.state.doc = streamDoc("Partial head. And the full");
        if (p === 4) h.state.doc = streamDoc(FULL);
        if (p === 5) {
          h.state.doc = streamDoc(FULL, { stop: false, done: true });
          h.state.stopVisible = false;
        }
      };
      const res = await h.drive({ prompt: PROMPT, isNewChat: false, thinking, stallMs: 5000 });
      assert.equal(String(res), FULL, `thinking ${thinking}: brief target loss with stop visible must not truncate`);
    }

    // (д) Stop vanishes, returns after half the window, vanishes again — a new full
    // window from the second disappearance (the first window is reset by Stop).
    {
      process.env.WEB_GEMINI_SESSION_CAP_MS = String(HIGH_CAP_MS);
      const h = harness({ advanceMs: 100 });
      h.state.doc = thinkingDoc({ stop: false });
      h.state.stopVisible = false;
      let secondGoneAt = null;
      h.state.onPoll = (p) => {
        if (p === 5) h.state.stopVisible = true; // half of the 1000ms window passed
        if (p === 7) {
          h.state.stopVisible = false;
          secondGoneAt = h.state.now;
        }
      };
      await assert.rejects(
        h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 1000 }),
        (err) => err.code === "WEB_GEMINI_STALLED"
      );
      const delta = h.state.now - secondGoneAt;
      assert.ok(
        delta >= 1000 && delta < 1100,
        `second window must be a full stallMs from the second disappearance, got ${delta}ms`
      );
      process.env.WEB_GEMINI_SESSION_CAP_MS = "20000";
    }

    // (е) Answer is only an image (no text) — completion, not stalled.
    {
      const h = harness({ advanceMs: 200 });
      h.state.doc = docOf([
        uq(["r0"]),
        createMockElement({
          id: "r0",
          tagName: "model-response",
          preceding: ["q0"],
          children: [
            createMockElement({ id: "mc0", tagName: "message-content", innerText: "" }),
            createMockElement({ id: "gi0", tagName: "generated-image" }),
            createMockElement({ id: "fb0", tagName: "response-feedback" }),
          ],
        }),
      ]);
      h.state.stopVisible = false;
      const res = await h.drive({ prompt: PROMPT, isNewChat: false, thinking: "high", stallMs: 1000 });
      assert.equal(String(res), "", "image-only answer completes with empty text");
      const span = h.state.now - h.state.firstStatusAt;
      assert.ok(span < 1000, `image-only answer must complete before the stall window, got ${span}ms`);
    }

    // (е2) Answer is only a generated file — a link with an empty download=""
    // attribute, no text, no "download" label, no file extension — completion by
    // §4.2 (one hasFinishedContent predicate), the file is detected by
    // collectGeneratedFiles, not stalled.
    {
      const fileDoc = () =>
        docOf([
          uq(["r0"]),
          createMockElement({
            id: "r0",
            tagName: "model-response",
            preceding: ["q0"],
            children: [
              createMockElement({
                id: "fl0",
                tagName: "a",
                innerText: "report",
                attributes: { href: "https://contribution.usercontent.google.com/file?id=abc", download: "" },
              }),
              createMockElement({ id: "fb0", tagName: "response-feedback" }),
            ],
          }),
        ]);
      const st = checkTurnStatus(fileDoc(), 0, PREFIX);
      assert.equal(st.hasFinishedContent, true, 'download="" link must count as finished content');
      const h = harness({ advanceMs: 200 });
      h.state.doc = fileDoc();
      h.state.stopVisible = false;
      const res = await h.drive({
        prompt: PROMPT,
        isNewChat: false,
        thinking: "high",
        stallMs: 2000,
        requireFullDelivery: true,
      });
      assert.equal(String(res), "", "file-only answer completes with empty text");
      assert.equal(res.hasGeneratedFile, true, "collectGeneratedFiles must detect the generated file");
      assert.ok(h.state.fileScans >= 1, "collectGeneratedFiles scan must run");
      const span = h.state.now - h.state.firstStatusAt;
      assert.ok(span < 2000, `file-only answer must complete before the stall window, got ${span}ms`);
    }
  } finally {
    restoreAll();
  }
});

test("36. PLUG-408: search metrics, hNvQHb parser, whitelist dialogs, wave protection, and thoughts streaming", async () => {
  // --- A. parseHNvQHb on fixtures: queries, status, source signatures, deduplication ---
  {
    const fixturePath = path.join(PLUGIN_ROOT, "tests", "fixtures", "hnvqhb-2026-11-24.json");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const res = parseHNvQHb(fixture, "r_c31b6777bc4b5ba9");

    assert.equal(res.status, 4, "Status must be max tool status 4");
    assert.deepEqual(
      res.queries,
      ["opencode-ai npm latest version release date", "opencode-ai package npmjs"],
      "Both queries must be extracted in order"
    );
    assert.equal(res.sources.length, 19, "Exactly 19 unique sources must be parsed");
    assert.equal(res.unknownRows.length, 0, "No unknown rows in fixture");

    // Verify all URLs are valid and not gstatic
    for (const s of res.sources) {
      assert.match(s.url, /^https?:\/\//, `Source URL must be valid HTTP(S): ${s.url}`);
      assert.equal(/gstatic\.com/i.test(s.url), false, `gstatic.com must be excluded: ${s.url}`);
      assert.ok(s.title && s.title.trim().length > 0, "Source title must be non-empty");
    }

    // Verify redirect unwrapping and search URL filtering
    assert.equal(
      unwrapUrl("https://www.google.com/url?q=https%3A%2F%2Fgithub.com%2Fopencode-ai&sa=U"),
      "https://github.com/opencode-ai"
    );
    assert.equal(
      unwrapUrl("https://www.google.com/url?q=javascript%3Aalert(1)"),
      null,
      "Non-HTTP(S) redirect must be rejected"
    );
    assert.equal(
      unwrapUrl("https://www.google.com/url?q=https%3A%2F%2Fencrypted-tbn0.gstatic.com%2Ffavicon&sa=U"),
      null,
      "gstatic redirect must be rejected"
    );
    assert.equal(isGoogleSearchUrl("https://www.google.com/search?q=test"), true);
    assert.equal(isGoogleSearchUrl("https://github.com/test"), false);

    // Citations require a non-empty snippet
    const mockNoSnippet = [
      [
        [
          ["c_test", "r_nosnippet1234567"],
          null,
          null,
          [
            [
              "https://example.com/article",
              "Article Title",
              "https://encrypted-tbn0.gstatic.com/favicon-tbn?q=tbn",
              "" // empty snippet!
            ]
          ]
        ]
      ]
    ];
    const resNoSnippet = parseHNvQHb(mockNoSnippet, "r_nosnippet1234567");
    assert.equal(resNoSnippet.sources.length, 0, "Citation without snippet must not be parsed as source");

    // Status 4 validation requires Google Search signature
    const mockBadStatus = [
      [
        [
          ["c_test", "r_badstatus1234567"],
          null,
          null,
          [
            [null, ["google", [null, null, "Not Search"], 4]]
          ]
        ]
      ]
    ];
    const resBadStatus = parseHNvQHb(mockBadStatus, "r_badstatus1234567");
    assert.equal(resBadStatus.status, null, "Status 4 without Google Search metadata must be rejected");

    // Numeric c_id must not crash .replace
    const mockNumCId = [
      [
        [
          [12345678, "r_numcid1234567890"],
          null,
          null,
          []
        ]
      ]
    ];
    const resNumCId = parseHNvQHb(mockNumCId, "r_numcid1234567890");
    assert.equal(resNumCId.convId, "12345678", "Numeric c_id must be parsed as string");
    assert.equal(resNumCId.status, null, "Turn found without search gives null status, not unbound");

    // Unknown source row with nested fields is captured
    const mockNestedUnknown = [
      [
        [
          ["c_test", "r_nestedunknown123"],
          null,
          null,
          [
            ["https://unknown.com/page", "Unknown Title", ["nested", "data"]]
          ]
        ]
      ]
    ];
    const resNestedUnknown = parseHNvQHb(mockNestedUnknown, "r_nestedunknown123");
    assert.equal(resNestedUnknown.unknownRows.length, 1, "Unknown row with nested fields must be captured");
  }

  // --- B. Turn isolation by responseId in multi-turn history ---
  {
    const multiPath = path.join(PLUGIN_ROOT, "tests", "fixtures", "hnvqhb-multi-turn-2026-11-24.json");
    const multiFixture = JSON.parse(fs.readFileSync(multiPath, "utf8"));

    const res1 = parseHNvQHb(multiFixture, "r_c31b6777bc4b5ba9");
    assert.equal(res1.status, 4);
    assert.equal(res1.queries.length, 2);
    assert.ok(res1.thoughtText && res1.thoughtText.length > 0, "Thought text must be extracted from hNvQHb");

    const resNone = parseHNvQHb(multiFixture, "r_nonexistent");
    assert.equal(resNone.status, "unbound");
    assert.equal(resNone.queries.length, 0);
    assert.equal(resNone.sources.length, 0);

    // Unknown source row logging detection
    const mockUnknown = [
      [
        [
          ["c_test", "r_test123456789012"],
          null,
          null,
          [
            [
              null,
              [
                ["https://unknown-service.com/page", "Unknown Service Title", 99999]
              ]
            ]
          ]
        ]
      ]
    ];
    const resUnknown = parseHNvQHb(mockUnknown, "r_test123456789012");
    assert.equal(resUnknown.unknownRows.length, 1);
  }

  // --- C. dismissOverlays whitelist, priority, input coverage, and errors ---
  {
    const shotDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "dialog-shots-")));

    // 1. Consent wall: exact Reject all vs partial reject
    let clicked = "";
    const pageConsent = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const bPartial = { offsetParent: {}, innerText: "Reject optional cookies", getAttribute: () => "Reject optional cookies", click: () => { clicked = "partial"; }, matches: () => false, closest: () => null };
        const bExact = { offsetParent: {}, innerText: "Reject all", getAttribute: () => "Reject all", click: () => { clicked = "exact"; }, matches: () => false, closest: () => null };
        const dlg = { offsetParent: {}, innerText: "Before you continue to Google", matches: () => false, closest: () => null, querySelectorAll: () => [bPartial, bExact] };
        global.document = { querySelectorAll: (sel) => sel.includes("mat-dialog-container") ? [dlg] : [], querySelector: () => null };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      waitForTimeout: async () => {},
    };
    await dismissOverlays(pageConsent, { isTurn: true, screenshotDir: shotDir });
    assert.equal(clicked, "exact", "Exact Reject all must be chosen first");

    // 2. Consent wall: Принять все when reject is absent
    let clickedAccept = false;
    const pageAccept = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const bAccept = { offsetParent: {}, innerText: "Принять все", getAttribute: () => "Принять все", click: () => { clickedAccept = true; }, matches: () => false, closest: () => null };
        const dlg = { offsetParent: {}, innerText: "До того как продолжить", matches: () => false, closest: () => null, querySelectorAll: () => [bAccept] };
        global.document = { querySelectorAll: (sel) => sel.includes("mat-dialog-container") ? [dlg] : [], querySelector: () => null };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      waitForTimeout: async () => {},
    };
    await dismissOverlays(pageAccept, { isTurn: true, screenshotDir: shotDir });
    assert.equal(clickedAccept, true, "Принять все must be clicked when no reject button");

    // 3. Consent wall without buttons -> WEB_GEMINI_DIALOG_UNCLOSED
    const pageUnclosedConsent = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const dlg = { offsetParent: {}, innerText: "Before you continue", matches: () => false, closest: () => null, querySelectorAll: () => [] };
        global.document = { querySelectorAll: (sel) => sel.includes("mat-dialog-container") ? [dlg] : [], querySelector: () => null };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      screenshot: async () => {},
      waitForTimeout: async () => {},
    };
    await assert.rejects(
      dismissOverlays(pageUnclosedConsent, { isTurn: true, screenshotDir: shotDir }),
      (err) => err.code === "WEB_GEMINI_DIALOG_UNCLOSED"
    );

    // 4. Banner "Use Gemini" / "Использовать Gemini" — substring "Do not use Gemini" must NOT be clicked
    let clickedWrongBanner = false;
    let clickedRightBanner = false;
    const pageBanner = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const wrongBtn = { offsetParent: {}, innerText: "Do not use Gemini", click: () => { clickedWrongBanner = true; } };
        const rightBtn = { offsetParent: {}, innerText: "Использовать Gemini", click: () => { clickedRightBanner = true; } };
        global.document = {
          querySelectorAll: (sel) => sel.includes("button") ? [wrongBtn, rightBtn] : [],
          querySelector: () => null,
        };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      waitForTimeout: async () => {},
    };
    await dismissOverlays(pageBanner, { isTurn: true, screenshotDir: shotDir });
    assert.equal(clickedWrongBanner, false, "Do not use Gemini must NOT be clicked");
    assert.equal(clickedRightBanner, true, "Exact Use Gemini banner button must be clicked");

    // 5. Paid upsell proposal with negative button
    let clickedNotNow = false;
    const pageUpsell = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const negBtn = { offsetParent: {}, innerText: "Не сейчас", getAttribute: () => "Не сейчас", click: () => { clickedNotNow = true; }, matches: () => false, closest: () => null };
        const dlg = { offsetParent: {}, innerText: "Смените план на Advanced: 1990 руб / мес", matches: () => false, closest: () => null, querySelectorAll: () => [negBtn] };
        global.document = { querySelectorAll: (sel) => sel.includes("mat-dialog-container") ? [dlg] : [], querySelector: () => null };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      waitForTimeout: async () => {},
    };
    await dismissOverlays(pageUpsell, { isTurn: true, screenshotDir: shotDir });
    assert.equal(clickedNotNow, true, "Negative button on upsell proposal must be clicked");

    // 6. Price promo without negative button NOT covering textbox is kept
    const pagePromoKept = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const dlg = { offsetParent: {}, innerText: "Get Gemini Advanced for $19.99/month", matches: () => false, closest: () => null, querySelectorAll: () => [], contains: () => false };
        const textbox = { getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 50 }) };
        global.document = {
          querySelectorAll: (sel) => sel.includes("mat-dialog-container") ? [dlg] : [],
          querySelector: (sel) => sel.includes("contenteditable") ? textbox : null,
          elementFromPoint: () => textbox,
        };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      waitForTimeout: async () => {},
    };
    await dismissOverlays(pagePromoKept, { isTurn: true, screenshotDir: shotDir });

    // 7. Price promo covering textbox throws WEB_GEMINI_DIALOG_UNCLOSED
    const pagePromoCovering = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const dlg = { offsetParent: {}, innerText: "Get Gemini Advanced for $19.99/month", matches: () => false, closest: () => null, querySelectorAll: () => [], contains: () => true };
        const textbox = { getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 50 }) };
        global.document = {
          querySelectorAll: (sel) => sel.includes("mat-dialog-container") ? [dlg] : [],
          querySelector: (sel) => sel.includes("contenteditable") ? textbox : null,
          elementFromPoint: () => dlg,
        };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      screenshot: async () => {},
      waitForTimeout: async () => {},
    };
    await assert.rejects(
      dismissOverlays(pagePromoCovering, { isTurn: true, screenshotDir: shotDir }),
      (err) => err.code === "WEB_GEMINI_DIALOG_UNCLOSED"
    );

    // 8. Unknown dialog during turn throws WEB_GEMINI_UNKNOWN_DIALOG
    const pageUnknownTurn = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const dlg = { offsetParent: {}, innerText: "Surprise Dialog With New UI", matches: () => false, closest: () => null, querySelectorAll: () => [] };
        global.document = { querySelectorAll: (sel) => sel.includes("mat-dialog-container") ? [dlg] : [], querySelector: () => null };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      screenshot: async () => {},
      waitForTimeout: async () => {},
    };
    await assert.rejects(
      dismissOverlays(pageUnknownTurn, { isTurn: true, screenshotDir: shotDir }),
      (err) => err.code === "WEB_GEMINI_UNKNOWN_DIALOG"
    );

    // 9. Unknown dialog outside turn does NOT throw
    let shotOutside = false;
    const pageUnknownOutside = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const dlg = { offsetParent: {}, innerText: "Surprise Dialog Outside Turn", matches: () => false, closest: () => null, querySelectorAll: () => [] };
        global.document = { querySelectorAll: (sel) => sel.includes("mat-dialog-container") ? [dlg] : [], querySelector: () => null };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      screenshot: async () => { shotOutside = true; },
      waitForTimeout: async () => {},
    };
    await dismissOverlays(pageUnknownOutside, { isTurn: false, screenshotDir: shotDir });
    assert.equal(shotOutside, true, "Screenshot must be taken outside turn without throwing");

    // 9b. Unclosed consent wall outside turn does NOT throw
    let shotUnclosedOutside = false;
    const pageUnclosedOutside = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const dlg = { offsetParent: {}, innerText: "Before you continue", matches: () => false, closest: () => null, querySelectorAll: () => [] };
        global.document = { querySelectorAll: (sel) => sel.includes("mat-dialog-container") ? [dlg] : [], querySelector: () => null };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      screenshot: async () => { shotUnclosedOutside = true; },
      waitForTimeout: async () => {},
    };
    await dismissOverlays(pageUnclosedOutside, { isTurn: false, screenshotDir: shotDir });
    assert.equal(shotUnclosedOutside, true, "Unclosed dialog outside turn must take screenshot without throwing");

    // 10. Backdrop covering input reloads page
    let reloadCount = 0;
    const pageBackdrop = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const backdrop = { offsetParent: {}, contains: () => true };
        const textbox = { getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 50 }) };
        global.document = {
          querySelectorAll: () => [],
          querySelector: (sel) => sel.includes("backdrop") ? (reloadCount === 0 ? backdrop : null) : textbox,
          elementFromPoint: () => backdrop,
        };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      reload: async () => { reloadCount++; },
      waitForTimeout: async () => {},
    };
    await dismissOverlays(pageBackdrop, { isTurn: true, screenshotDir: shotDir });
    assert.equal(reloadCount, 1, "Page must be reloaded once when backdrop covers input");

    const pageBackdropPersistent = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        const backdrop = { offsetParent: {}, contains: () => true };
        const textbox = { getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 50 }) };
        global.document = {
          querySelectorAll: () => [],
          querySelector: (sel) => sel.includes("backdrop") ? backdrop : textbox,
          elementFromPoint: () => backdrop,
        };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      reload: async () => {},
      waitForTimeout: async () => {},
    };
    const backdropOpts = { isTurn: true, screenshotDir: shotDir, allowReload: false, loggedBackdropCoversInput: false };
    await dismissOverlays(pageBackdropPersistent, backdropOpts);
    assert.equal(backdropOpts.loggedBackdropCoversInput, true, "loggedBackdropCoversInput must be set on backdrop-covers-input");
    // Call again with same opts in generation loop: loggedBackdropCoversInput remains true, logged once
    await dismissOverlays(pageBackdropPersistent, backdropOpts);
    assert.equal(backdropOpts.loggedBackdropCoversInput, true);

    // 11. Menus ([role="menu"], mat-menu-panel) must strictly NOT be treated as dialogs
    const menuEl = {
      offsetParent: {},
      innerText: "Menu Item 1\nMenu Item 2",
      matches: (s) => s.includes('role="menu"'),
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const paneWithMenu = {
      offsetParent: {},
      innerText: "Menu Item 1\nMenu Item 2",
      matches: () => false,
      closest: () => null,
      querySelector: (s) => s.includes('role="menu"') ? menuEl : null,
      querySelectorAll: () => [],
    };
    const pageMenu = {
      evaluate: async (fn) => {
        const origDoc = global.document;
        global.document = {
          querySelectorAll: (sel) => sel.includes(".cdk-overlay-pane") ? [paneWithMenu] : [],
          querySelector: () => null,
        };
        try { return await fn(); } finally { global.document = origDoc; }
      },
      waitForTimeout: async () => {},
    };
    let threwMenu = false;
    try {
      await dismissOverlays(pageMenu, { isTurn: true, screenshotDir: shotDir });
    } catch {
      threwMenu = true;
    }
    assert.equal(threwMenu, false, "Menu inside overlay pane must strictly NOT throw WEB_GEMINI_UNKNOWN_DIALOG");
  }

  // --- D. Failure classification and wave protection (cross-process file lock) ---
  {
    const errUnknown = new Error("unknown dialog: something new");
    errUnknown.code = "WEB_GEMINI_UNKNOWN_DIALOG";
    const clsU = classifyFailure(errUnknown);
    assert.equal(clsU.category, "unknown-dialog");
    assert.equal(clsU.cooldownMs, 900_000);
    assert.equal(clsU.rotatable, true);
    assert.equal(clsU.parkedReason, "unknown-dialog");

    const errUnclosed = new Error("WEB_GEMINI_DIALOG_UNCLOSED: unclosed dialog");
    errUnclosed.code = "WEB_GEMINI_DIALOG_UNCLOSED";
    const clsC = classifyFailure(errUnclosed);
    assert.equal(clsC.category, "unknown-dialog");

    const waveDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "wave-shared-")));
    _resetDialogWaveHistory(waveDir);
    const modalText = "Some completely unknown Google beta prompt";
    const now = Date.now();
    assert.equal(checkDialogWave(modalText, "acc_a", now, waveDir), false);
    assert.equal(checkDialogWave(modalText, "acc_b", now, waveDir), false);
    assert.equal(checkDialogWave(modalText, "acc_c", now, waveDir), true, "Wave triggered on 3rd distinct account");
    // 4th account stays wave protected without throwing
    assert.equal(checkDialogWave(modalText, "acc_d", now, waveDir), true);
    assert.equal(checkDialogWave("Different dialog", "acc_e", now, waveDir), false);

    // 31 minutes later: old accounts expired, new wave on 3 accounts warns again
    const later = now + 31 * 60_000;
    assert.equal(checkDialogWave(modalText, "acc_1", later, waveDir), false);
    assert.equal(checkDialogWave(modalText, "acc_2", later, waveDir), false);
    assert.equal(checkDialogWave(modalText, "acc_3", later, waveDir), true, "Wave triggered again after 30m window");
  }

  // --- E. Thoughts sanitization and thoughts.jsonl writer ---
  {
    const testDir = trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "thoughts-test-")));
    const logPath = path.join(testDir, "thoughts.jsonl");

    // Test secret stripping in strings: URLs, Authorization, Cookie, f.sid, and access_token
    const dirtyUrl = "https://admin:supersecret@example.com/api?access_token=tok999&f.sid=sessiontoken123&clean=true";
    const cleanUrl = sanitizeUrl(dirtyUrl);
    assert.equal(cleanUrl.includes("supersecret"), false, "Password in URL must be stripped");
    assert.equal(cleanUrl.includes("tok999"), false, "access_token in URL must be stripped");
    assert.equal(cleanUrl.includes("sessiontoken123"), false, "f.sid token must be stripped");
    assert.ok(cleanUrl.includes("https://example.com/api"));
    assert.ok(cleanUrl.includes("clean=true"));

    const authString = "Step info. Authorization: Bearer secret_bearer_token and Cookie: c1=xyz123; c2=second_pair_secret";
    const cleanAuth = sanitizeThoughtString(authString);
    assert.equal(cleanAuth.includes("secret_bearer_token"), false);
    assert.equal(cleanAuth.includes("xyz123"), false);
    assert.equal(cleanAuth.includes("second_pair_secret"), false, "Second cookie pair must be masked");
    assert.ok(cleanAuth.includes("Authorization: [REDACTED]"));
    assert.ok(cleanAuth.includes("Cookie: [REDACTED]"));

    // Test multi-chunk thought streaming with split Bearer and credentials via real runPrompt
    const thoughtUpdates = [];
    _setOutputHook((msg) => {
      if (msg?.params?.update) {
        thoughtUpdates.push(msg.params.update);
      }
    });
    _setDriverHooks({
      sendPrompt: async (req) => {
        // Stream chunk with partial Bearer header and secret across chunks
        req.onThoughtChunk("Step 1. Authorization: Bearer ");
        req.onThoughtChunk("secret_token_value_xyz123 then safe words");
        // Stream URL with userinfo credentials split across chunks
        req.onThoughtChunk("\nURL https://alice:s3cr3tPW");
        req.onThoughtChunk("@host.example.com/x and finish");
        // Stream long unbroken sequence > 512 chars with URL
        req.onThoughtChunk("\n" + "b".repeat(300) + "https://bob:p");
        req.onThoughtChunk("assw0rdSECRET".repeat(25));
        req.onThoughtChunk("@sub.example.com/y and final word");
        return {
          text: "Response text",
          convId: "c_thought_test",
        };
      },
    });
    try {
      await runPrompt(991, "s_thought_test", "test prompt");
      const thoughtChunks = thoughtUpdates
        .filter((u) => u.sessionUpdate === "agent_thought_chunk")
        .map((u) => u.content?.text || "");
      const fullThoughtText = thoughtChunks.join("");

      assert.ok(fullThoughtText.includes("Authorization: [REDACTED]"), "Authorization header must be redacted");
      assert.equal(fullThoughtText.includes("secret_token_value_xyz123"), false, "Split Bearer token value must NOT leak");
      assert.ok(fullThoughtText.includes("then safe words"), "Text following secret must not be lost");
      assert.equal(fullThoughtText.includes("s3cr3tPW"), false, "Userinfo password split across chunks must NOT leak");
      assert.ok(fullThoughtText.includes("https://host.example.com/x and finish"), "Sanitized URL and trailing text must be preserved");
      assert.equal(fullThoughtText.includes("assw0rdSECRET"), false, "Unbroken chunk > 512 URL password must NOT leak");
      assert.ok(fullThoughtText.includes("https://sub.example.com/y and final word"), "Preserved trailing URL and word after > 512 chars");
    } finally {
      _setDriverHooks(null);
      _setOutputHook(null);
    }

    // Test sanitizer rules order & patterns
    assert.equal(sanitizeThoughtString("Bearer: SECRETXYZ"), "Bearer: [REDACTED]");
    assert.equal(sanitizeThoughtString("bearer=SECRETXYZ"), "Bearer: [REDACTED]");
    assert.equal(sanitizeThoughtString("Bearer secret_tok_123"), "Bearer [REDACTED]");
    assert.equal(sanitizeThoughtString("api_key: SECRETXYZ"), "api_key: [REDACTED]");
    assert.equal(sanitizeThoughtString("token = SECRETXYZ"), "token=[REDACTED]");
    assert.equal(sanitizeThoughtString("?access_token=SECRETXYZ&other=1"), "?access_token=[REDACTED]&other=1");

    // Test that review verdict containing Cookie and Bearer text is NOT corrupted in task branch
    const rawVerdictJson = JSON.stringify({
      verdict: "CHANGES",
      findings: [{ text: "Header Cookie: sid=12345; session=abc and Bearer secret_tok" }],
      blockers: 1,
    });
    _setDriverHooks({
      sendPrompt: async (req) => {
        return {
          text: "Review analysis report.\n" + rawVerdictJson,
          convId: "c_verdict_test",
        };
      },
    });
    try {
      const verdictUpdates = [];
      _setOutputHook((msg) => {
        if (msg?.result?.stopReason || msg?.params?.update) verdictUpdates.push(msg);
      });
      const taskVerdict = {
        journal: {
          sessKey: "s_verdict_test",
          entry: { key: "s_verdict_test", record: {} },
          turn: {
            turnNo: 1,
            sendCount: 0,
            profile: { model: "neon" },
            budgets: { repairRounds: 0, toolRounds: 0 },
            attempts: [{ n: 1, inputSha256: "abc" }],
          },
        },
        signal: new AbortController().signal,
        aborted: new Promise(() => {}),
        finish: async () => {},
        ping: () => {},
        started: Date.now(),
        deadline: Date.now() + 60000,
        sessionCapAt: Date.now() + 60000,
        ownedFiles: [],
      };
      const contextVerdict = {
        text: "Review code and report verdict.",
        research: false,
        write: false,
        verdict: new Map(),
        key: "REV-1",
        root: null,
        cwd: testDir,
        pin: null,
        repoFiles: [],
        attachments: [],
        attachmentOmissions: [],
        settings: {
          mask: (s) => s,
          maskResponse: (s) => s,
          maskResearch: (s) => s,
          maxTotalBytes: 100000,
          maxRepairRounds: 1,
          innerAgent: false,
        },
      };
      await runPrompt(992, "s_verdict_test", "check code", {
        task: taskVerdict,
        context: contextVerdict,
        blocks: [],
        materials: [],
      });
      const msgChunk = verdictUpdates.find((m) => m?.params?.update?.sessionUpdate === "agent_message_chunk");
      assert.ok(msgChunk, "Should have received an agent_message_chunk update");
      const fullText = msgChunk.params.update.content.text;
      assert.ok(fullText.includes("Header Cookie: sid=12345; session=abc"), "Cookie text must be preserved verbatim in task verdict");
      assert.ok(fullText.includes("Bearer secret_tok"), "Bearer token in JSON verdict must not be corrupted by sanitizer");
      const lastLine = fullText.trim().split("\n").at(-1);
      const parsed = JSON.parse(lastLine);
      assert.equal(parsed.verdict, "CHANGES");
      assert.equal(parsed.blockers, 1);
      assert.equal(parsed.findings[0].text, "Header Cookie: sid=12345; session=abc and Bearer secret_tok");
    } finally {
      _setDriverHooks(null);
      _setOutputHook(null);
    }

    const rawPayload = {
      query: "test query",
      token: "secret-token",
      auth: "secret-auth",
      nested: {
        f_sid: "sid-123",
        status: "in_progress",
        url: "https://user:password@target.org/resource?access_token=secret_tok&sid=abc999",
      },
    };
    const cleaned = sanitizeThoughtPayload(rawPayload);
    assert.equal(cleaned.query, "test query");
    assert.equal(cleaned.token, undefined);
    assert.equal(cleaned.auth, undefined);
    assert.equal(cleaned.nested.f_sid, undefined);
    assert.equal(cleaned.nested.status, "in_progress");
    assert.equal(cleaned.nested.url.includes("password"), false);
    assert.equal(cleaned.nested.url.includes("secret_tok"), false);
    assert.equal(cleaned.nested.url.includes("abc999"), false);

    appendThoughtLog(logPath, "thought", { text: "Analyzing query\n" });
    appendThoughtLog(logPath, "tool_call", { toolCallId: "call_1", query: "test query" });
    appendThoughtLog(logPath, "tool_call_update", { toolCallId: "call_1", status: "completed" });

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].event, "thought");
    assert.equal(lines[1].event, "tool_call");
    assert.equal(lines[2].event, "tool_call_update");
  }

  // --- F. Search sources block appended strictly in research && !write && !verdict, with maskResponse ---
  {
    const candidateWithSources = {
      text: "Summary of research findings.",
      convId: "c_sources_test",
      search: {
        status: 4,
        queries: ["npm query"],
        sources: [
          { url: "https://user:pass@example.com/one?access_token=secret_tok_123&keep=1", title: "Page One" },
          { url: "https://example.com/two", title: "Page Two" },
        ],
      },
    };
    _setDriverHooks({
      sendPrompt: async () => candidateWithSources,
    });
    try {
      const researchUpdates = [];
      _setOutputHook((msg) => {
        if (msg?.result?.stopReason || msg?.params?.update) researchUpdates.push(msg);
      });
      const taskResearch = {
        journal: {
          sessKey: "s_sources_test",
          entry: { key: "s_sources_test", record: {} },
          turn: {
            turnNo: 1,
            sendCount: 0,
            profile: { model: "neon" },
            budgets: { repairRounds: 0, toolRounds: 0 },
            attempts: [{ n: 1, inputSha256: "abc" }],
          },
        },
        signal: new AbortController().signal,
        aborted: new Promise(() => {}),
        finish: async () => {},
        ping: () => {},
        started: Date.now(),
        deadline: Date.now() + 60000,
        sessionCapAt: Date.now() + 60000,
        ownedFiles: [],
      };
      const contextResearch = {
        text: "Research query.",
        research: true,
        write: false,
        verdict: null,
        key: "RES-1",
        root: null,
        cwd: os.tmpdir(),
        pin: null,
        repoFiles: [],
        attachments: [],
        attachmentOmissions: [],
        settings: {
          mask: (s) => s,
          maskResponse: (text) => text.replace(/example\.com/g, "[скрыто: domain]"),
          maskResearch: (s) => s,
          maxTotalBytes: 100000,
          maxRepairRounds: 1,
          innerAgent: false,
        },
      };
      await runPrompt(993, "s_sources_test", "research query", {
        task: taskResearch,
        context: contextResearch,
        blocks: [],
        materials: [],
      });
      const chunkMsg = researchUpdates.find((m) => m?.params?.update?.sessionUpdate === "agent_message_chunk");
      assert.ok(chunkMsg, "Must receive agent_message_chunk in research task");
      const formattedText = chunkMsg.params.update.content.text;
      assert.ok(formattedText.includes("### Источники поиска"), "Sources block must be appended in research mode");
      assert.equal(formattedText.includes("pass@"), false, "Credentials in source URL must be stripped");
      assert.equal(formattedText.includes("secret_tok_123"), false, "access_token in source URL must be stripped");
      assert.ok(formattedText.includes("keep=1"), "Legitimate parameters must be kept");
      assert.ok(formattedText.includes("[скрыто: domain]"), "maskResponse must be called on full research output with sources block");

      // In verdict mode: sources block NOT appended even if search sources exist
      const verdictUpdates2 = [];
      _setOutputHook((msg) => {
        if (msg?.result?.stopReason || msg?.params?.update) verdictUpdates2.push(msg);
      });
      const verdictResp = "Summary.\n" + JSON.stringify({ verdict: "OK", blockers: 0 });
      _setDriverHooks({
        sendPrompt: async () => ({
          text: verdictResp,
          convId: "c_verdict_sources_test",
          search: candidateWithSources.search,
        }),
      });
      const taskVerdict2 = {
        ...taskResearch,
        journal: {
          ...taskResearch.journal,
          sessKey: "s_verdict_sources_test",
          entry: { key: "s_verdict_sources_test", record: {} },
        },
      };
      const contextVerdict2 = {
        ...contextResearch,
        research: true,
        verdict: new Map(),
      };
      await runPrompt(994, "s_verdict_sources_test", "verdict query", {
        task: taskVerdict2,
        context: contextVerdict2,
        blocks: [],
        materials: [],
      });
      const chunkMsg2 = verdictUpdates2.find((m) => m?.params?.update?.sessionUpdate === "agent_message_chunk");
      assert.equal(chunkMsg2.params.update.content.text.includes("### Источники поиска"), false, "Sources block must not be appended when verdict is expected");
    } finally {
      _setDriverHooks(null);
      _setOutputHook(null);
    }
  }

  // --- G. DOM and model-thoughts isolation ---
  {
    const thoughtSpinner = {
      tagName: "mat-spinner",
      getAttribute: () => null,
      offsetParent: {},
      parentElement: null,
      parentNode: null,
    };
    const modelThoughts = {
      tagName: "model-thoughts",
      getAttribute: () => null,
      offsetParent: {},
      parentElement: null,
      parentNode: null,
      querySelectorAll: (sel) => [thoughtSpinner],
    };
    thoughtSpinner.parentElement = modelThoughts;
    thoughtSpinner.parentNode = modelThoughts;
    const targetEl = {
      tagName: "model-response",
      getAttribute: () => null,
      offsetParent: {},
      parentElement: null,
      parentNode: null,
      querySelectorAll: (sel) => sel.includes("spinner") ? [thoughtSpinner] : sel.includes("model-thoughts") ? [modelThoughts] : [],
      querySelector: (sel) => null,
      childNodes: [
        { nodeType: 3, nodeValue: "Direct text in target. " },
        modelThoughts,
        { nodeType: 3, nodeValue: "Second direct text." },
      ],
      innerText: "Direct text in target. Second direct text.",
    };
    modelThoughts.parentElement = targetEl;
    modelThoughts.parentNode = targetEl;

    const userQuery = {
      tagName: "user-query",
      innerText: "Test prompt",
      compareDocumentPosition: () => 4,
    };
    const mockDoc = {
      querySelectorAll: (sel) => {
        if (sel === "model-response") return [targetEl];
        if (sel === "user-query") return [userQuery];
        return [];
      },
      querySelector: (sel) => null,
    };
    const turnStatus = driver.checkTurnStatus(mockDoc, 0, "Test prompt");
    assert.equal(turnStatus.isBusyOrThinking, false, "Spinner inside model-thoughts must NOT set isBusyOrThinking");
    assert.ok(turnStatus.currentText.text.includes("Direct text in target"), "Direct text nodes must be preserved");
    assert.ok(turnStatus.currentText.text.includes("Second direct text"), "Second direct text node must be preserved");

    // Regression: serialized checkTurnStatus executed in separate JS context with NO global parentOf
    const fnSrc = driver.findTurnTarget.toString();
    const checkSrc = driver.checkTurnStatus.toString();
    const sandbox = {
      document: mockDoc,
      fnSrc,
      checkSrc,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    const isolatedStatus = vm.runInContext(`
      window.__webGeminiFindTurnTarget = eval('(' + fnSrc + ')');
      const checkFn = eval('(' + checkSrc + ')');
      checkFn(document, 0, "Test prompt");
    `, sandbox);
    assert.equal(isolatedStatus.targetFound, true, "Target must be found in isolated context");
    assert.equal(isolatedStatus.isBusyOrThinking, false, "Thoughts spinner must not set busy in isolated context");
  }

  // --- H. Integration with driver hooks in sendPrompt ---
  {
    const fixturePath = path.join(PLUGIN_ROOT, "tests", "fixtures", "hnvqhb-2026-11-24.json");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const thoughtChunksReceived = [];
    _setDriverHooks({
      ensureChrome: async () => {},
      getPlaywright: () => {},
      connectOverCDP: async () => ({ close: async () => {} }),
      getGeminiPage: async () => ({
        url: () => "https://gemini.google.com/app",
        goto: async () => {},
        on: () => {},
        off: () => {},
        evaluate: async () => null,
      }),
      runTurn: async () => ({
        text: "Response from Google search",
        convId: "c_test_conv",
        responseId: "r_c31b6777bc4b5ba9",
      }),
      fetchHNvQHb: async () => fixture,
    });
    try {
      const res = await sendPrompt({
        prompt: "opencode-ai latest version",
        isNewChat: false,
        onThoughtChunk: (chunk) => {
          thoughtChunksReceived.push(chunk);
        },
      });
      assert.equal(res.text, "Response from Google search");
      assert.equal(res.search?.status, 4);
      assert.equal(res.search?.queries?.length, 2);
      assert.equal(res.search?.sources?.length, 19);
      assert.ok(thoughtChunksReceived.length > 0, "Thoughts must be published to onThoughtChunk without ReferenceError");
    } finally {
      _setDriverHooks(null);
    }
  }

  // --- I. Unique toolCallId and cancellation guard for search cards ---
  {
    const capturedUpdates = [];
    _setOutputHook((msg) => {
      if (msg?.params?.update) capturedUpdates.push(msg.params.update);
    });

    let sendCount = 0;
    _setDriverHooks({
      sendPrompt: async (req) => {
        sendCount++;
        return {
          text: `Reply ${sendCount}`,
          convId: "c_search_session",
          search: {
            status: 4,
            queries: [`query for send ${sendCount}`],
            sources: [{ title: "Source 1", url: "https://example.com/1" }],
          },
        };
      },
    });

    try {
      // Send 1
      await runPrompt(1001, "s_search_cards_session", "Prompt 1");
      const toolCalls1 = capturedUpdates.filter((u) => u.sessionUpdate === "tool_call");
      assert.equal(toolCalls1.length, 1, "First prompt must emit one tool_call");
      const callId1 = toolCalls1[0].toolCallId;
      assert.ok(callId1.startsWith("call_c_search_session_"), `Expected toolCallId prefix, got ${callId1}`);

      // Send 2 on same session (e.g. repair or next turn)
      await runPrompt(1002, "s_search_cards_session", "Prompt 2");
      const toolCalls2 = capturedUpdates.filter((u) => u.sessionUpdate === "tool_call");
      assert.equal(toolCalls2.length, 2, "Second prompt must emit second tool_call");
      const callId2 = toolCalls2[1].toolCallId;
      assert.ok(callId2.startsWith("call_c_search_session_"), `Expected toolCallId prefix, got ${callId2}`);

      assert.notEqual(callId1, callId2, "toolCallId must be strictly unique across successive sends");

      // Cancellation guard: when session is cancelled before sendWebPrompt returns, zero tool_call emitted
      const cancelUpdates = [];
      _setOutputHook((msg) => {
        if (msg?.params?.update) cancelUpdates.push(msg.params.update);
      });
      _setDriverHooks({
        sendPrompt: async (req) => {
          // Cancel session during send
          cancelSession("s_cancel_test_session");
          return {
            text: "Cancelled reply",
            convId: "c_cancel_conv",
            search: {
              status: 4,
              queries: ["cancelled query"],
              sources: [],
            },
          };
        },
      });

      await runPrompt(1003, "s_cancel_test_session", "Prompt that gets cancelled");
      const cancelledToolCalls = cancelUpdates.filter((u) => u.sessionUpdate === "tool_call");
      assert.equal(cancelledToolCalls.length, 0, "No new tool call cards must open after cancellation");

      // Multi-round task tool loop emits unique toolCallId across rounds (§2.5 п.3)
      const capturedTaskUpdates = [];
      _setOutputHook((msg) => {
        if (msg?.params?.update) capturedTaskUpdates.push(msg.params.update);
      });
      let roundNum = 0;
      _setDriverHooks({
        sendPrompt: async (req) => {
          roundNum++;
          if (roundNum === 1) {
            return {
              text: 'Investigating files.\n<tool name="list_dir" path="."/>',
              convId: "c_task_multiround",
              search: {
                status: 4,
                queries: ["npm package metadata round 1"],
                sources: [{ title: "Source 1", url: "https://example.com/1" }],
              },
            };
          }
          return {
            text: "Final analysis complete without further tool calls.",
            convId: "c_task_multiround",
            search: {
              status: 4,
              queries: ["npm package metadata round 2"],
              sources: [{ title: "Source 2", url: "https://example.com/2" }],
            },
          };
        },
      });
      const taskMulti = {
        journal: {
          sessKey: "s_task_multiround",
          entry: { key: "s_task_multiround", record: {} },
          turn: {
            turnNo: 1,
            sendCount: 0,
            profile: { model: "neon" },
            budgets: { repairRounds: 0, toolRounds: 0 },
            attempts: [{ n: 1, inputSha256: "abc" }],
          },
        },
        signal: new AbortController().signal,
        aborted: new Promise(() => {}),
        finish: async () => {},
        ping: () => {},
        started: Date.now(),
        deadline: Date.now() + 60000,
        sessionCapAt: Date.now() + 60000,
        ownedFiles: [],
      };
      const contextMulti = {
        text: "Task with multi-round tool loop.",
        research: false,
        write: false,
        verdict: null,
        key: "TASK-MULTI",
        root: null,
        cwd: os.tmpdir(),
        pin: null,
        repoFiles: [],
        attachments: [],
        attachmentOmissions: [],
        settings: {
          mask: (s) => s,
          maskResponse: (s) => s,
          maskResearch: (s) => s,
          maxTotalBytes: 100000,
          maxRepairRounds: 1,
          innerAgent: false,
        },
      };
      await runPrompt(1005, "s_task_multiround", "run multi round", {
        task: taskMulti,
        context: contextMulti,
        blocks: [],
        materials: [],
      });
      const searchCards = capturedTaskUpdates.filter((u) => u.sessionUpdate === "tool_call" && u.kind === "search");
      assert.equal(searchCards.length, 2, "Must emit 2 search tool_calls across 2 rounds");
      const id1 = searchCards[0].toolCallId;
      const id2 = searchCards[1].toolCallId;
      assert.notEqual(id1, id2, "Search cards in round 1 and round 2 must have distinct toolCallIds");
      assert.ok(id1.includes("_1_0_1_0"), `Round 1 card should include turn_repair_send_q _1_0_1_0, got: ${id1}`);
      assert.ok(id2.includes("_1_0_2_0"), `Round 2 card should include turn_repair_send_q _1_0_2_0, got: ${id2}`);
    } finally {
      _setDriverHooks(null);
      _setOutputHook(null);
    }
  }
});
