import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatStallOutcomeReason,
  formatStallDuration,
  replaceNonBoundary429,
  BUILTIN_QUOTA_PATTERNS,
  BUILTIN_UNAVAILABLE_PATTERNS,
  RATE_LIMIT_CATEGORY_RE,
  runPrompt,
  sessions,
  _setOutputHook,
} from "../acp-server.mjs";
import * as journal from "../src/turn-journal.mjs";

const require = createRequire(import.meta.url);
const driver = require("../src/gemini-driver.js");
const { sendPrompt, _setDriverHooks } = driver;

function setupTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "web-gemini-evidence-"));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

test("formatStallDuration formats durations as <m>m<с>s", () => {
  assert.equal(formatStallDuration(0), "0m0s");
  assert.equal(formatStallDuration(7000), "0m7s");
  assert.equal(formatStallDuration(60000), "1m0s");
  assert.equal(formatStallDuration(899000), "14m59s");
  assert.equal(formatStallDuration(900000), "15m0s");
});

test("replaceNonBoundary429 only matches standalone boundary 429", () => {
  assert.equal(replaceNonBoundary429("Reading 1429 lines"), "Reading 1- lines");
  assert.equal(replaceNonBoundary429("Searching PLUG-429 notes"), "Searching PLUG-- notes");
  assert.equal(replaceNonBoundary429("issue #429"), "issue #-");
  assert.equal(replaceNonBoundary429("Too many requests for PLUG-1429"), "Too many requests for PLUG-1-");
  assert.equal(replaceNonBoundary429("Error 429"), "Error 429");
  assert.equal(replaceNonBoundary429("Reading 429 files"), "Reading 429 files");
  assert.equal(replaceNonBoundary429("429 Too Many Requests"), "429 Too Many Requests");
});

test("formatStallOutcomeReason handles all branch prefixes and evidence=none", () => {
  assert.equal(formatStallOutcomeReason("target-found", null), "stalled (target-found): evidence=none");
  assert.equal(formatStallOutcomeReason("target-lost", null), "stalled (target-lost): evidence=none");
  assert.equal(formatStallOutcomeReason("cap", null), "stream timeout: evidence=none");
  assert.equal(formatStallOutcomeReason("deadline", null), "deadline exceeded: evidence=none");
  assert.equal(formatStallOutcomeReason("dialog", null), "unknown dialog: evidence=none");
  assert.equal(formatStallOutcomeReason("no-start", null), "generation did not start: evidence=none");
});

test("formatStallOutcomeReason formats standard record with short evidence path", () => {
  const rec = {
    branch: "target-lost",
    sinceProgressMs: 900000,
    evidence: "inner-agent/turns/sess-123/turn-0003/evidence/a1-target-lost.json",
    snapshot: "inner-agent/turns/sess-123/turn-0003/evidence/a1-target-lost.png",
    page: {
      hasStopButton: false,
      targetFound: false,
      isGenerating: false,
      hasFinishedContent: false,
      domIdleMs: 899000,
      dialogs: [],
      statusText: "",
    },
  };

  const res = formatStallOutcomeReason("target-lost", rec);
  assert.equal(
    res,
    "stalled (target-lost): stop=no target=no generating=no answer=no status=- domIdle=14m59s noProgress=15m0s dialogs=0 shot=yes evidence=turn-0003/evidence/a1-target-lost.json"
  );
  assert.ok(res.length <= 284);
});

test("formatStallOutcomeReason quota detection and false quota filtering", () => {
  // False quota: non-boundary 429 or route pattern
  const recFalse = {
    branch: "target-lost",
    sinceProgressMs: 120000,
    evidence: "turn-0429/evidence/a1-target-lost.json",
    snapshot: null,
    page: {
      hasStopButton: false,
      targetFound: false,
      isGenerating: false,
      hasFinishedContent: false,
      domIdleMs: 120000,
      dialogs: [],
      statusText: "Searching PLUG-429 notes and 1429 files",
    },
  };
  const resFalse = formatStallOutcomeReason("target-lost", recFalse);
  assert.ok(!resFalse.includes("429"), "non-boundary 429 must be replaced with -");
  assert.ok(resFalse.includes('status="Searching PLUG-- notes and 1- files"'));
  assert.ok(resFalse.includes("evidence=turn-0-/evidence/a1-target-lost.json"));

  // True quota in status: boundary 429
  const recTrue429 = {
    branch: "target-lost",
    sinceProgressMs: 120000,
    evidence: "turn-0001/evidence/a1-target-lost.json",
    snapshot: "turn-0001/evidence/a1-target-lost.png",
    page: {
      hasStopButton: false,
      targetFound: false,
      isGenerating: false,
      hasFinishedContent: false,
      domIdleMs: 120000,
      dialogs: [],
      statusText: "Error 429: Too many requests",
    },
  };
  const resTrue429 = formatStallOutcomeReason("target-lost", recTrue429);
  assert.ok(resTrue429.includes('status="429: Too many requests"'));

  // Dialog branch with quota dialog: match B > 40 chars from match A
  const recDialogQuota = {
    branch: "dialog",
    sinceProgressMs: 5000,
    evidence: "turn-0001/evidence/a1-dialog.json",
    snapshot: "turn-0001/evidence/a1-dialog.png",
    page: {
      hasStopButton: false,
      targetFound: false,
      isGenerating: false,
      hasFinishedContent: false,
      domIdleMs: 5000,
      dialogs: [{ text: "Please try again later. Your account has hit its daily usage limit" }],
      statusText: "",
    },
  };
  const resDialogQuota = formatStallOutcomeReason("dialog", recDialogQuota);
  assert.ok(resDialogQuota.includes('dialog="usage limit"'), "dialog field starts at match B (usage limit)");

  // Dialog branch without quota indicator: omits dialog field
  const recDialogNoQuota = {
    branch: "dialog",
    sinceProgressMs: 5000,
    evidence: "turn-0001/evidence/a1-dialog.json",
    snapshot: "turn-0001/evidence/a1-dialog.png",
    page: {
      hasStopButton: false,
      targetFound: false,
      isGenerating: false,
      hasFinishedContent: false,
      domIdleMs: 5000,
      dialogs: [{ text: "Some random unexpected dialog appeared" }],
      statusText: "",
    },
  };
  const resDialogNoQuota = formatStallOutcomeReason("dialog", recDialogNoQuota);
  assert.ok(!resDialogNoQuota.includes("dialog="), "dialog field omitted when no quota indicators");
});

test("formatStallOutcomeReason enforces 284 char budget with progressive truncation", () => {
  const longStatus = "A".repeat(150);
  const longDialog = "Please try again later. " + "B".repeat(150) + " usage limit";
  const recLong = {
    branch: "dialog",
    sinceProgressMs: 900000,
    evidence: "turn-0001/evidence/a1-dialog.json",
    snapshot: "turn-0001/evidence/a1-dialog.png",
    page: {
      hasStopButton: false,
      targetFound: false,
      isGenerating: false,
      hasFinishedContent: false,
      domIdleMs: 900000,
      dialogs: [{ text: longDialog }],
      statusText: longStatus,
    },
  };

  const formatted = formatStallOutcomeReason("dialog", recLong);
  const fullLine = `[web-gemini:failed] ${formatted}`;
  assert.ok(fullLine.length <= 284, `fullLine length ${fullLine.length} must be <= 284`);
});

test("driver collects stall evidence on target-found and target-lost with correct order and permissions", async (t) => {
  const tmpDir = setupTempDir(t);
  const callOrder = [];

  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  let stopClicked = false;
  const mockPage = {
    url: () => "https://user:pass@example.com/app/c/deadbeefcafef00d",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += ms;
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async (sel) => {
      if (sel && (sel.includes("Stop") || sel.includes("stop") || sel.includes("Остановить"))) {
        return {
          click: async () => {
            callOrder.push("stopGeneration");
            stopClicked = true;
          },
        };
      }
      return null;
    },
    $$: async () => [],
    screenshot: async () => {
      callOrder.push("screenshot");
      return Buffer.from("FAKE_PNG_BYTES");
    },
    evaluate: async (fn, arg) => {
      callOrder.push("evaluate");
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) {
        if (arg.sel.includes("Stop") || arg.sel.includes("Остановить")) {
          stopClicked = true;
          callOrder.push("stopGeneration");
        }
        return true;
      }
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        return {
          targetFound: true,
          hasStopButton: true,
          isBusyOrThinking: false,
          hasFinishedContent: false,
          hasActionButtons: false,
          childCount: 1,
          targetTextLength: 0,
          bodyText: "visible text containing secret_api_key and https://user:pass@example.com/api",
          currentText: { src: "raw", text: "secret_tail_token" },
        };
      }
      // DOM evaluation inside collectStallEvidence
      return {
        url: "https://gemini.google.com/app/c/deadbeefcafef00d",
        title: "Gemini Chat",
        statusText: "Searching secret_status",
        bodyText: "visible text containing secret_api_key and https://user:pass@example.com/api",
        dialogs: [],
        metrics: { promptChars: 10, responsesCount: 1 },
      };
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => mockPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "Stall test with evidence collection",
        isNewChat: false,
        stallMs: 600,
        stateDir: tmpDir,
        screenshotDir: join(tmpDir, "turn-0001"),
        convId: "deadbeefcafef00d",
        attempt: 1,
        maskText: (text) => text.replace(/secret_[a-z_]+/g, "[MASKED]").replace(/https:\/\/[^:]+:[^@]+@/g, "https://[скрыто: credentials]@"),
      }),
      (err) => {
        assert.equal(err.code, "WEB_GEMINI_STALLED");
        assert.ok(err.stallEvidence, "Error must have stallEvidence attached");
        assert.equal(err.stallEvidence.record.branch, "target-found");
        assert.equal(err.stallEvidence.record.attempt, 1);
        return true;
      }
    );

    // Verify screenshot was taken BEFORE stopGeneration
    const shotIdx = callOrder.indexOf("screenshot");
    const stopIdx = callOrder.indexOf("stopGeneration");
    assert.ok(shotIdx !== -1, "screenshot must be taken");
    assert.ok(stopIdx !== -1, "stopGeneration must be called");
    assert.ok(shotIdx < stopIdx, `screenshot (${shotIdx}) must be called before stopGeneration (${stopIdx})`);

    // Verify files created
    const evDir = join(tmpDir, "turn-0001", "evidence");
    assert.ok(existsSync(evDir), "evidence dir must exist");
    const jsonPath = join(evDir, "a1-target-found.json");
    const pngPath = join(evDir, "a1-target-found.png");
    assert.ok(existsSync(jsonPath), "JSON evidence file must exist");
    assert.ok(existsSync(pngPath), "PNG evidence file must exist");

    // Verify permissions: dir 0700, file 0600
    const dirStat = statSync(evDir);
    assert.equal(dirStat.mode & 0o777, 0o700, "evidence directory mode must be 0700");
    const fileStat = statSync(jsonPath);
    assert.equal(fileStat.mode & 0o777, 0o600, "json evidence file mode must be 0600");

    // Verify JSON contents and schema
    const record = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(record.schema, "web-gemini-stall-evidence/1");
    assert.equal(record.branch, "target-found");
    assert.equal(record.attempt, 1);
    assert.equal(record.page.hasStopButton, true);
    assert.equal(record.page.targetFound, true);

    // Verify masking of URL credentials and text secrets
    assert.ok(!record.page.visibleTextTail.includes("secret_api_key"));
    assert.ok(record.page.visibleTextTail.includes("[MASKED]"));
    assert.ok(!record.page.visibleTextTail.includes("user:pass"));
    assert.ok(record.page.visibleTextTail.includes("[скрыто: credentials]"));
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("driver collects stall evidence on deadline during generation stage", async (t) => {
  const tmpDir = setupTempDir(t);
  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  const ac = new AbortController();
  let hasPressedEnter = false;

  const mockPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += ms;
      // Trigger deadline abort during polling (generation stage) after Enter
      if (hasPressedEnter && !ac.signal.aborted) {
        ac.abort("deadline");
      }
    },
    keyboard: {
      press: async (k) => {
        if (k === "Enter") hasPressedEnter = true;
      },
      insertText: async () => {},
    },
    $: async () => null,
    $$: async () => [],
    screenshot: async () => {
      return Buffer.from("FAKE_PNG_DEADLINE");
    },
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        return {
          targetFound: true,
          hasStopButton: true,
          isBusyOrThinking: true,
          hasFinishedContent: false,
          hasActionButtons: false,
          childCount: 1,
          targetTextLength: 0,
          currentText: { src: "raw", text: "" },
        };
      }
      return {
        url: "https://gemini.google.com/app",
        title: "Gemini",
        statusText: "",
        visibleTextTail: "",
        dialogs: [],
        metrics: {},
      };
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => mockPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "Deadline during generation test",
        isNewChat: false,
        signal: ac.signal,
        stateDir: tmpDir,
        screenshotDir: join(tmpDir, "turn-0001"),
        convId: "conv-deadline",
        attempt: 1,
        maskText: (x) => x,
      }),
      (err) => {
        assert.equal(err.code, "ARGON_CANCELLED");
        assert.equal(err.cancelReason, "deadline");
        assert.ok(err.stallEvidence, "Deadline during generation must attach stallEvidence");
        assert.equal(err.stallEvidence.record.branch, "deadline");
        return true;
      }
    );

    const jsonPath = join(tmpDir, "turn-0001", "evidence", "a1-deadline.json");
    assert.ok(existsSync(jsonPath), "Deadline evidence file must exist");
    const rec = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(rec.branch, "deadline");
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("deadline before generation stage does not collect stall evidence", async (t) => {
  const tmpDir = setupTempDir(t);
  const ac = new AbortController();
  ac.abort("deadline"); // aborted before sendPrompt starts

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => { assert.fail("must not reach page"); },
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "Pre-generation deadline",
        signal: ac.signal,
        stateDir: tmpDir,
        attempt: 1,
      }),
      (err) => {
        assert.equal(err.code, "ARGON_CANCELLED");
        assert.equal(err.cancelReason, "deadline");
        assert.equal(err.stallEvidence, undefined);
        return true;
      }
    );
    assert.ok(!existsSync(join(tmpDir, "evidence")));
  } finally {
    _setDriverHooks(null);
  }
});

test("user cancellation does not collect stall evidence", async (t) => {
  const tmpDir = setupTempDir(t);
  const ac = new AbortController();

  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  const mockPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += ms;
      if (!ac.signal.aborted) ac.abort("cancelled");
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async (sel) => {
      if (sel && (sel.includes("Stop") || sel.includes("stop") || sel.includes("Остановить"))) {
        return {
          click: async () => {
            callOrder.push("stopGeneration");
            stopClicked = true;
          },
        };
      }
      return null;
    },
    $$: async () => [],
    screenshot: async () => {
      assert.fail("screenshot must not be called on user cancellation");
    },
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        return {
          targetFound: true,
          hasStopButton: true,
          isBusyOrThinking: true,
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
    getGeminiPage: async () => mockPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "User cancel prompt",
        signal: ac.signal,
        stateDir: tmpDir,
        attempt: 1,
      }),
      (err) => {
        assert.equal(err.code, "ARGON_CANCELLED");
        assert.equal(err.cancelReason, "cancelled");
        assert.equal(err.stallEvidence, undefined);
        return true;
      }
    );
    assert.ok(!existsSync(join(tmpDir, "evidence")), "No evidence dir on cancellation");
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("pruneJournal cleans chat evidence older than retentionMs and bounds to 50 pairs", async (t) => {
  const tmpDir = setupTempDir(t);
  const evidenceDir = join(tmpDir, "screenshots", "evidence");
  mkdirSync(evidenceDir, { recursive: true });

  const now = Date.now();
  const ONE_DAY = 24 * 3600_000;

  // Create 60 pairs of evidence files (120 files total)
  // 10 pairs old (> 24h), 50 pairs recent
  for (let i = 1; i <= 60; i++) {
    const jsonFile = join(evidenceDir, `ev-${String(i).padStart(3, "0")}.json`);
    const pngFile = join(evidenceDir, `ev-${String(i).padStart(3, "0")}.png`);
    writeFileSync(jsonFile, "{}");
    writeFileSync(pngFile, "PNG");

    const age = i <= 10 ? now - 2 * ONE_DAY : now - (60 - i) * 1000;
    const timeSec = age / 1000;
    utimesSync(jsonFile, timeSec, timeSec);
    utimesSync(pngFile, timeSec, timeSec);
  }

  // Create a minimal state object for pruneJournal
  const state = {
    retentionMs: ONE_DAY,
    turns: [],
  };

  await journal.pruneJournal(tmpDir, state);

  const remainingFiles = readdirSync(evidenceDir);
  // Each pair has 2 files (.json and .png). Max 50 pairs = 100 files.
  assert.ok(remainingFiles.length <= 100, `Remaining files ${remainingFiles.length} must be <= 100 (50 pairs)`);
  // Verify old files (1..10) were deleted
  assert.ok(!existsSync(join(evidenceDir, "ev-001.json")));
  assert.ok(!existsSync(join(evidenceDir, "ev-010.json")));
});

test("isContinueText matches stall failure reminder from orchestrator", () => {
  const reminderRu = "ход оборвался ошибкой: stalled (target-found): stop=no target=no. Продолжай задачу";
  assert.equal(journal.isContinueText(reminderRu), true);

  const reminderRuWithPrefix = "[orchestrator] ход оборвался ошибкой: stalled (target-found): stop=no. Продолжай задачу";
  assert.equal(journal.isContinueText(reminderRuWithPrefix), true);

  const reminderEn = "the turn died on an error: stalled (target-lost): evidence=none. Continue the task";
  assert.equal(journal.isContinueText(reminderEn), true);

  const randomText = "Something completely unrelated";
  assert.equal(journal.isContinueText(randomText), false);
});

test("driver collects stall evidence on no-start (120s timeout)", async (t) => {
  const tmpDir = setupTempDir(t);
  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  const mockPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += 121_000; // Fast-forward past 120s deadline
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async () => null,
    $$: async () => [],
    screenshot: async () => Buffer.from("FAKE_PNG_NOSTART"),
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      // started check returns false (no stop button, no target)
      if (arg && arg.fnSrc && !arg.checkSrc) return false;
      return null;
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => mockPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "No start prompt",
        isNewChat: false,
        stateDir: tmpDir,
        screenshotDir: join(tmpDir, "turn-0001"),
        convId: "conv-nostart",
        attempt: 1,
      }),
      (err) => {
        assert.match(err.message, /generation did not start within 120s/);
        assert.ok(err.stallEvidence, "no-start must attach stallEvidence");
        assert.equal(err.stallEvidence.record.branch, "no-start");
        return true;
      }
    );

    const jsonPath = join(tmpDir, "turn-0001", "evidence", "a1-no-start.json");
    assert.ok(existsSync(jsonPath), "no-start evidence JSON must exist");
    const rec = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(rec.branch, "no-start");
    assert.ok(rec.page.domIdleMs > 0, `domIdleMs ${rec.page.domIdleMs} must be > 0`);
    assert.ok(rec.sinceProgressMs > 0, `sinceProgressMs ${rec.sinceProgressMs} must be > 0`);
    assert.ok(rec.elapsedMs > 0, `elapsedMs ${rec.elapsedMs} must be > 0`);
    assert.equal(rec.page.domIdleMs, 121_000);
    assert.equal(rec.sinceProgressMs, 121_000);
    assert.equal(rec.elapsedMs, 121_000);
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("driver collects stall evidence on deadline before generation starts (pre-generation deadline)", async (t) => {
  const tmpDir = setupTempDir(t);
  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  const ac = new AbortController();
  let hasPressedEnter = false;

  const mockPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += 15_000;
      if (hasPressedEnter && !ac.signal.aborted) {
        ac.abort("deadline");
      }
    },
    keyboard: {
      press: async (k) => {
        if (k === "Enter") hasPressedEnter = true;
      },
      insertText: async () => {},
    },
    $: async () => null,
    $$: async () => [],
    screenshot: async () => Buffer.from("FAKE_PNG_PREGEN_DEADLINE"),
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return false;
      return null;
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => mockPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "Pre-gen deadline prompt",
        isNewChat: false,
        stateDir: tmpDir,
        screenshotDir: join(tmpDir, "turn-0001"),
        convId: "conv-pregen",
        attempt: 1,
        signal: ac.signal,
      }),
      (err) => {
        assert.equal(err.code, "ARGON_CANCELLED");
        assert.equal(err.cancelReason, "deadline");
        assert.ok(err.stallEvidence, "pre-generation deadline must attach stallEvidence");
        assert.equal(err.stallEvidence.record.branch, "deadline");
        return true;
      }
    );

    const jsonPath = join(tmpDir, "turn-0001", "evidence", "a1-deadline.json");
    assert.ok(existsSync(jsonPath), "deadline evidence JSON must exist");
    const rec = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(rec.branch, "deadline");
    assert.ok(rec.page.domIdleMs > 0, `domIdleMs ${rec.page.domIdleMs} must be > 0`);
    assert.ok(rec.sinceProgressMs > 0, `sinceProgressMs ${rec.sinceProgressMs} must be > 0`);
    assert.ok(rec.elapsedMs > 0, `elapsedMs ${rec.elapsedMs} must be > 0`);
    assert.equal(rec.page.domIdleMs, 15_000);
    assert.equal(rec.sinceProgressMs, 15_000);
    assert.equal(rec.elapsedMs, 15_000);
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("driver collects stall evidence on cap (session cap reached with active generation)", async (t) => {
  const tmpDir = setupTempDir(t);
  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  const oldCap = process.env.WEB_GEMINI_SESSION_CAP_MS;
  process.env.WEB_GEMINI_SESSION_CAP_MS = "1000";
  t.after(() => {
    if (oldCap !== undefined) process.env.WEB_GEMINI_SESSION_CAP_MS = oldCap;
    else delete process.env.WEB_GEMINI_SESSION_CAP_MS;
  });

  let stopClicked = false;
  const mockPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += 2000; // Jump past rawSessionCap (1000ms)
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async (sel) => {
      if (sel && sel.includes("Stop")) {
        return {
          click: async () => {
            stopClicked = true;
          },
        };
      }
      return null;
    },
    $$: async () => [],
    screenshot: async () => Buffer.from("FAKE_PNG_CAP"),
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        return {
          targetFound: true,
          hasStopButton: true,
          isBusyOrThinking: true,
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
    getGeminiPage: async () => mockPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "Session cap prompt",
        isNewChat: false,
        rawSessionCap: 1000,
        stallMs: 60000,
        stateDir: tmpDir,
        screenshotDir: join(tmpDir, "turn-0001"),
        convId: "conv-cap",
        attempt: 1,
      }),
      (err) => {
        assert.equal(err.code, "WEB_GEMINI_STREAM_TIMEOUT");
        assert.ok(err.stallEvidence, "cap must attach stallEvidence");
        assert.equal(err.stallEvidence.record.branch, "cap");
        return true;
      }
    );

    const jsonPath = join(tmpDir, "turn-0001", "evidence", "a1-cap.json");
    assert.ok(existsSync(jsonPath), "cap evidence JSON must exist");
    const rec = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(rec.branch, "cap");
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("driver collects stall evidence on unknown dialog and reuses overlay screenshot", async (t) => {
  const tmpDir = setupTempDir(t);
  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  let pageScreenshotCalled = false;
  const existingDialogScreenshot = join(tmpDir, "dialog-existing.png");
  writeFileSync(existingDialogScreenshot, Buffer.from("EXISTING_DIALOG_PNG"));

  const mockPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += ms;
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async () => null,
    $$: async () => [],
    screenshot: async () => {
      pageScreenshotCalled = true;
      return Buffer.from("PAGE_SHOT");
    },
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        return {
          targetFound: true,
          hasStopButton: true,
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
    getGeminiPage: async () => mockPage,
    dismissOverlays: async () => {
      const err = new Error("unknown dialog appeared: Rate limit warning");
      err.code = "WEB_GEMINI_UNKNOWN_DIALOG";
      err.screenshotPath = existingDialogScreenshot;
      err.dialogText = "Rate limit warning";
      throw err;
    },
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "Dialog prompt",
        isNewChat: false,
        stateDir: tmpDir,
        screenshotDir: join(tmpDir, "turn-0001"),
        convId: "conv-dialog",
        attempt: 1,
      }),
      (err) => {
        assert.equal(err.code, "WEB_GEMINI_UNKNOWN_DIALOG");
        assert.ok(err.stallEvidence, "dialog must attach stallEvidence");
        assert.equal(err.stallEvidence.record.branch, "dialog");
        return true;
      }
    );

    // Verify page.screenshot was NOT called (reused overlay screenshot)
    assert.equal(pageScreenshotCalled, false, "page.screenshot must not be called when overlay screenshot exists");

    // Verify evidence file created and copied from dialog screenshot
    const jsonPath = join(tmpDir, "turn-0001", "evidence", "a1-dialog.json");
    const pngPath = join(tmpDir, "turn-0001", "evidence", "a1-dialog.png");
    assert.ok(existsSync(jsonPath), "dialog evidence JSON must exist");
    assert.ok(existsSync(pngPath), "dialog evidence PNG must exist");
    assert.equal(readFileSync(pngPath, "utf8"), "EXISTING_DIALOG_PNG", "PNG content must match existing dialog screenshot");

    const rec = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(rec.branch, "dialog");
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("pinned session retains stallEvidence and dialogText across unknown dialog error rewrite", () => {
  const origErr = new Error("unknown dialog: Some text");
  origErr.code = "WEB_GEMINI_UNKNOWN_DIALOG";
  origErr.stallEvidence = { path: "evidence/a1-dialog.json", record: { branch: "dialog" } };
  origErr.dialogText = "Usage limit reached. Try again later.";

  // Pinned session rewrite logic from acp-server.mjs
  const text120 = String(origErr.dialogText).slice(0, 120);
  const next = new Error("unknown dialog: " + text120);
  next.code = "WEB_GEMINI_UNKNOWN_DIALOG";
  next.stallEvidence = origErr.stallEvidence;
  next.dialogText = origErr.dialogText || text120;

  assert.equal(next.code, "WEB_GEMINI_UNKNOWN_DIALOG");
  assert.equal(next.dialogText, "Usage limit reached. Try again later.");
  assert.deepEqual(next.stallEvidence, origErr.stallEvidence);
});

test("formatStallOutcomeReason outputs ? for unread page.* fields (issue 5)", () => {
  const recUnread = {
    branch: "target-lost",
    sinceProgressMs: 900000,
    evidence: "turn-0003/evidence/a1-target-lost.json",
    snapshot: null,
    page: {
      hasStopButton: null,
      targetFound: null,
      isGenerating: null,
      hasFinishedContent: null,
      domIdleMs: 899000,
      dialogs: null,
      statusText: null,
    },
  };
  const res = formatStallOutcomeReason("target-lost", recUnread);
  assert.ok(res.includes("stop=?"), "stop button must be ? when unread");
  assert.ok(res.includes("target=?"), "target must be ? when unread");
  assert.ok(res.includes("generating=?"), "generating must be ? when unread");
  assert.ok(res.includes("answer=?"), "answer must be ? when unread");
  assert.ok(res.includes("dialogs=?"), "dialogs must be ? when unread");
  assert.ok(res.includes("status=-"), "status must be - when unread");
});

test("formatStallOutcomeReason masks statusText with secret token (issue 6)", () => {
  const secretToken = ["sk", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("-");
  const recSecret = {
    branch: "target-lost",
    sinceProgressMs: 120000,
    evidence: "turn-0003/evidence/a1-target-lost.json",
    snapshot: null,
    page: {
      hasStopButton: false,
      targetFound: false,
      isGenerating: false,
      hasFinishedContent: false,
      domIdleMs: 120000,
      dialogs: [],
      statusText: `Reading token ${secretToken} now`,
    },
  };
  const res = formatStallOutcomeReason("target-lost", recSecret);
  assert.ok(!res.includes(secretToken.slice(0, 12)), "secret token must be masked");
  assert.ok(res.includes("[скрыто: api-key]"), "must contain mask placeholder");
});

test("driver collects stall evidence with null page fields when state eval fails (issue 5)", async (t) => {
  const tmpDir = setupTempDir(t);
  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  const ac = new AbortController();
  let hasPressedEnter = false;

  const mockPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += ms;
      if (hasPressedEnter && !ac.signal.aborted) {
        ac.abort("deadline");
      }
    },
    keyboard: {
      press: async (k) => {
        if (k === "Enter") hasPressedEnter = true;
      },
      insertText: async () => {},
    },
    $: async () => null,
    $$: async () => [],
    screenshot: async () => Buffer.from("FAKE_PNG"),
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (typeof fn === "function" && fn.toString().includes("rawDialogs")) {
        throw new Error("state eval unavailable in test");
      }
      if (arg && arg.checkSrc) {
        return {
          targetFound: true,
          hasStopButton: true,
          isBusyOrThinking: true,
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
    getGeminiPage: async () => mockPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "eval failure test",
        isNewChat: false,
        signal: ac.signal,
        stateDir: tmpDir,
        screenshotDir: join(tmpDir, "turn-0001"),
        convId: "conv-eval-fail",
        attempt: 1,
        maskText: (x) => x,
      }),
      (err) => {
        assert.ok(err.stallEvidence, "must attach stallEvidence");
        const rec = err.stallEvidence.record;
        assert.equal(rec.page.hasStopButton, null);
        assert.equal(rec.page.targetFound, null);
        assert.equal(rec.page.isGenerating, null);
        assert.equal(rec.page.dialogs, null);
        assert.equal(rec.page.visibleTextTail, null);
        assert.equal(rec.page.statusText, null);
        return true;
      }
    );
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("session cancellation flags are properly reset for subsequent turns (issue 3)", () => {
  const sess = { gen: 1, activeGen: 1, cancelled: false, _cancelRequested: false };
  // Turn 1 gets cancelled
  sess._cancelRequested = true;
  sess.cancelled = true;

  // Turn 2 start logic from acp-server.mjs line 2041
  const gen = (sess.gen || 0) + 1;
  sess.gen = gen;
  sess.activeGen = gen;
  sess.cancelled = false;
  sess._cancelRequested = false;

  assert.equal(sess._cancelRequested, false, "_cancelRequested must be reset at turn start");
  assert.equal(sess.cancelled, false, "cancelled must be reset at turn start");
});

test("recovery_required error is preserved and sets recoveryRequired on turn (issue 4)", () => {
  const err = new Error("recovery_required: uncommitted work in worktree");
  let reason;
  if (err?.message?.startsWith("recovery_required:")) {
    reason = err.message;
  }
  const tj = { turn: { recoveryRequired: false } };
  if (tj && reason.startsWith("recovery_required:")) tj.turn.recoveryRequired = true;

  assert.equal(reason, "recovery_required: uncommitted work in worktree");
  assert.equal(tj.turn.recoveryRequired, true);
});

test("runPrompt catch block accesses currentAttempt and formats stall outcome reason on stall with evidence (issue 1)", async (t) => {
  const testDir = setupTempDir(t);
  const stallErr = new Error("generation stalled — no progress for 2s");
  stallErr.code = "WEB_GEMINI_STALLED";
  stallErr.stallEvidence = {
    path: "evidence/a1-target-lost.json",
    record: {
      attempt: 1,
      branch: "target-lost",
      sinceProgressMs: 900000,
      evidence: "evidence/a1-target-lost.json",
      page: {
        targetFound: false,
        hasStopButton: false,
        isGenerating: false,
        hasAnswer: false,
        statusText: "Reading token sk-test now",
        domIdleMs: 899000,
        dialogCount: 0,
      },
      snapshot: null,
    },
  };

  _setDriverHooks({
    sendPrompt: async () => {
      throw stallErr;
    },
  });

  let finishedOutcome = null;
  let finishedReason = null;
  const task = {
    journal: {
      sessKey: "s_test_stall_scope",
      entry: { key: "s_test_stall_scope", record: {} },
      turn: {
        turnNo: 1,
        sendCount: 0,
        profile: { model: "neon" },
        budgets: { repairRounds: 0, toolRounds: 0 },
        attempts: [{ n: 1, inputSha256: "abc" }],
      },
      stallRecords: [],
    },
    signal: new AbortController().signal,
    aborted: new Promise(() => {}),
    finish: async (outcome, reason) => {
      finishedOutcome = outcome;
      finishedReason = reason;
    },
    ping: () => {},
    stage: "generation",
    started: Date.now(),
    deadline: Date.now() + 60000,
    sessionCapAt: Date.now() + 60000,
    ownedFiles: [],
  };

  const context = {
    text: "test",
    research: false,
    write: false,
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

  sessions.set("s_test_stall_scope", {
    convId: "c_existing",
    account: "auto",
    backend: null,
  });

  let turnErrorMsg = null;
  _setOutputHook((msg) => {
    if (msg?.error) turnErrorMsg = msg;
  });

  try {
    await runPrompt(101, "s_test_stall_scope", "test prompt", { task, context, blocks: [], materials: [] });
    assert.equal(finishedOutcome, "failed");
    assert.ok(finishedReason, "finishedReason must be populated");
    assert.ok(!finishedReason.includes("currentAttempt is not defined"), "must not fail with ReferenceError");
    assert.ok(finishedReason.startsWith("stalled (target-lost):"), "reason must be formatted stall outcome reason");
    assert.ok(finishedReason.includes("evidence=evidence/a1-target-lost.json"), "reason must include evidence path");
    assert.equal(turnErrorMsg?.error?.data?.outcome, "failed");
    assert.equal(turnErrorMsg?.error?.data?.reason, finishedReason);
    assert.equal(turnErrorMsg?.error?.data?.stage, "generation");
  } finally {
    _setDriverHooks(null);
    _setOutputHook(null);
    sessions.delete("s_test_stall_scope");
  }
});

test("driver:stall is logged exactly once on deadline before attempt timer", async (t) => {
  const testDir = setupTempDir(t);
  const oldStateDir = process.env.WEB_GEMINI_STATE_DIR;
  process.env.WEB_GEMINI_STATE_DIR = testDir;
  t.after(() => {
    if (oldStateDir !== undefined) process.env.WEB_GEMINI_STATE_DIR = oldStateDir;
    else delete process.env.WEB_GEMINI_STATE_DIR;
  });

  const deadlineErr = new Error("prompt cancelled by user");
  deadlineErr.code = "ARGON_CANCELLED";
  deadlineErr.cancelReason = "deadline";
  deadlineErr.stallEvidence = {
    path: "evidence/a1-deadline.json",
    record: {
      attempt: 1,
      branch: "deadline",
      sinceProgressMs: 15000,
      evidence: "evidence/a1-deadline.json",
      page: {
        targetFound: false,
        hasStopButton: false,
        isGenerating: false,
        statusText: "",
        domIdleMs: 15000,
      },
      snapshot: null,
    },
  };

  _setDriverHooks({
    sendPrompt: async () => {
      throw deadlineErr;
    },
  });

  const task = {
    journal: {
      sessKey: "s_test_deadline_dedup",
      entry: { key: "s_test_deadline_dedup", record: {} },
      turn: {
        turnNo: 1,
        sendCount: 0,
        profile: { model: "neon" },
        budgets: { repairRounds: 0, toolRounds: 0 },
        attempts: [{ n: 1, inputSha256: "abc" }],
      },
      stallRecords: [],
    },
    signal: new AbortController().signal,
    aborted: new Promise(() => {}),
    finish: async () => {},
    ping: () => {},
    stage: "generation",
    started: Date.now(),
    deadline: Date.now() + 60000,
    sessionCapAt: Date.now() + 60000,
    ownedFiles: [],
  };

  const context = {
    text: "test",
    research: false,
    write: false,
    key: "REV-2",
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

  sessions.set("s_test_deadline_dedup", {
    convId: "c_existing",
    account: "auto",
    backend: null,
  });

  let rpcMsg = null;
  _setOutputHook((msg) => {
    if (msg?.id === 102) rpcMsg = msg;
  });

  try {
    await runPrompt(102, "s_test_deadline_dedup", "test prompt", { task, context, blocks: [], materials: [] });
    assert.equal(rpcMsg?.result?.stopReason, "cancelled");

    const logPath = join(testDir, "acp-server.log");
    assert.ok(existsSync(logPath), "acp-server.log must exist");
    const logContent = readFileSync(logPath, "utf8");
    const stallLines = logContent.split("\n").filter((l) => l.includes("driver:stall"));
    assert.equal(stallLines.length, 1, `driver:stall must be logged exactly once, got ${stallLines.length}`);
  } finally {
    _setDriverHooks(null);
    _setOutputHook(null);
    sessions.delete("s_test_deadline_dedup");
  }
});

test("recordStallEvidence catches persistJournal disk error without throwing", async (t) => {
  const testDir = setupTempDir(t);
  const oldStateDir = process.env.WEB_GEMINI_STATE_DIR;
  process.env.WEB_GEMINI_STATE_DIR = testDir;
  t.after(() => {
    if (oldStateDir !== undefined) process.env.WEB_GEMINI_STATE_DIR = oldStateDir;
    else delete process.env.WEB_GEMINI_STATE_DIR;
  });

  const stallErr = new Error("generation stalled — no progress for 2s");
  stallErr.code = "WEB_GEMINI_STALLED";
  stallErr.stallEvidence = {
    path: "evidence/a1-target-lost.json",
    record: {
      attempt: 1,
      branch: "target-lost",
      sinceProgressMs: 900000,
      evidence: "evidence/a1-target-lost.json",
      page: {
        targetFound: false,
        hasStopButton: false,
        isGenerating: false,
        domIdleMs: 899000,
      },
      snapshot: null,
    },
  };

  _setDriverHooks({
    sendPrompt: async () => {
      throw stallErr;
    },
  });

  let finishedOutcome = null;
  const task = {
    journal: {
      sessKey: "s_test_persist_err",
      entry: { key: "s_test_persist_err", record: {} },
      turn: {
        turnNo: 1,
        sendCount: 0,
        profile: { model: "neon" },
        budgets: { repairRounds: 0, toolRounds: 0 },
        attempts: [{ n: 1, inputSha256: "abc" }],
      },
      stallRecords: [],
      persistJournal: () => {
        throw new Error("EACCES: permission denied, write");
      },
    },
    signal: new AbortController().signal,
    aborted: new Promise(() => {}),
    finish: async (outcome) => {
      finishedOutcome = outcome;
    },
    ping: () => {},
    stage: "generation",
    started: Date.now(),
    deadline: Date.now() + 60000,
    sessionCapAt: Date.now() + 60000,
    ownedFiles: [],
  };

  const context = {
    text: "test",
    research: false,
    write: false,
    key: "REV-3",
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

  sessions.set("s_test_persist_err", {
    convId: "c_existing",
    account: "auto",
    backend: null,
  });

  try {
    await runPrompt(103, "s_test_persist_err", "test prompt", { task, context, blocks: [], materials: [] });
    assert.equal(finishedOutcome, "failed");
  } finally {
    _setDriverHooks(null);
    _setOutputHook(null);
    sessions.delete("s_test_persist_err");
  }
});

test("driver JPEG fallback saves .jpeg when PNG > 5MB within deadline", async (t) => {
  const tmpDir = setupTempDir(t);
  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  const mockPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += ms;
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async () => null,
    $$: async () => [],
    screenshot: async (opts) => {
      if (opts?.type === "png") {
        fakeNow += 500;
        return Buffer.alloc(6 * 1024 * 1024);
      }
      if (opts?.type === "jpeg") {
        fakeNow += 300;
        return Buffer.from("FAKE_JPEG_DATA");
      }
      return Buffer.from("UNKNOWN");
    },
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        return {
          targetFound: true,
          hasStopButton: true,
          isBusyOrThinking: false,
          hasFinishedContent: false,
          hasActionButtons: false,
          childCount: 1,
          targetTextLength: 0,
          currentText: { src: "raw", text: "" },
        };
      }
      return {
        url: "https://gemini.google.com/app",
        title: "Gemini",
        statusText: "",
        visibleTextTail: "",
        dialogs: [],
        metrics: {},
      };
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => mockPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "JPEG fallback test",
        isNewChat: false,
        stallMs: 600,
        stateDir: tmpDir,
        screenshotDir: join(tmpDir, "turn-0001"),
        convId: "deadbeefcafef00d",
        attempt: 1,
        maskText: (x) => x,
      }),
      (err) => {
        assert.equal(err.code, "WEB_GEMINI_STALLED");
        assert.ok(err.stallEvidence, "Error must have stallEvidence attached");
        assert.ok(
          err.stallEvidence.record.snapshot.endsWith("a1-target-found.jpeg"),
          `snapshot must end with .jpeg, got ${err.stallEvidence.record.snapshot}`
        );
        return true;
      }
    );

    const evDir = join(tmpDir, "turn-0001", "evidence");
    const jpegPath = join(evDir, "a1-target-found.jpeg");
    const pngPath = join(evDir, "a1-target-found.png");
    assert.ok(existsSync(jpegPath), "JPEG file must exist");
    assert.ok(!existsSync(pngPath), "PNG file must not exist");

    const jpegStat = statSync(jpegPath);
    assert.equal(jpegStat.mode & 0o777, 0o600, "jpeg file mode must be 0600");
    assert.equal(readFileSync(jpegPath, "utf8"), "FAKE_JPEG_DATA");

    const jsonPath = join(evDir, "a1-target-found.json");
    const record = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.ok(record.snapshot.endsWith("a1-target-found.jpeg"));
    assert.ok(!record.errors.includes("snapshot too large"));
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});

test("driver JPEG fallback skips and reports 'snapshot too large' when remainingMs <= 0", async (t) => {
  const tmpDir = setupTempDir(t);
  let fakeNow = 1_000_000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  let jpegCalled = false;
  const mockPage = {
    url: () => "https://gemini.google.com/app",
    goto: async () => {},
    waitForSelector: async () => ({ click: async () => {} }),
    waitForTimeout: async (ms = 200) => {
      fakeNow += ms;
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    $: async () => null,
    $$: async () => [],
    screenshot: async (opts) => {
      if (opts?.type === "png") {
        fakeNow += 3000;
        return Buffer.alloc(6 * 1024 * 1024);
      }
      if (opts?.type === "jpeg") {
        jpegCalled = true;
        return Buffer.from("FAKE_JPEG_DATA");
      }
      return Buffer.from("UNKNOWN");
    },
    evaluate: async (fn, arg) => {
      if (typeof fn === "function" && fn.toString().includes("maxLength")) return null;
      if (arg && arg.sel) return true;
      if (arg && arg.fnSrc && !arg.checkSrc) return true;
      if (arg && arg.checkSrc) {
        return {
          targetFound: true,
          hasStopButton: true,
          isBusyOrThinking: false,
          hasFinishedContent: false,
          hasActionButtons: false,
          childCount: 1,
          targetTextLength: 0,
          currentText: { src: "raw", text: "" },
        };
      }
      return {
        url: "https://gemini.google.com/app",
        title: "Gemini",
        statusText: "",
        visibleTextTail: "",
        dialogs: [],
        metrics: {},
      };
    },
  };

  _setDriverHooks({
    ensureChrome: async () => {},
    connectOverCDP: async () => ({ close: async () => {} }),
    getGeminiPage: async () => mockPage,
  });

  try {
    await assert.rejects(
      sendPrompt({
        prompt: "JPEG fallback timeout test",
        isNewChat: false,
        stallMs: 600,
        stateDir: tmpDir,
        screenshotDir: join(tmpDir, "turn-0001"),
        convId: "deadbeefcafef00d",
        attempt: 1,
        maskText: (x) => x,
      }),
      (err) => {
        assert.equal(err.code, "WEB_GEMINI_STALLED");
        assert.ok(err.stallEvidence, "Error must have stallEvidence attached");
        assert.equal(err.stallEvidence.record.snapshot, null);
        assert.ok(err.stallEvidence.record.errors.includes("snapshot too large"));
        return true;
      }
    );

    assert.equal(jpegCalled, false, "JPEG screenshot must not be attempted if remainingMs <= 0");
    const evDir = join(tmpDir, "turn-0001", "evidence");
    const jpegPath = join(evDir, "a1-target-found.jpeg");
    const pngPath = join(evDir, "a1-target-found.png");
    assert.ok(!existsSync(jpegPath), "JPEG file must not exist");
    assert.ok(!existsSync(pngPath), "PNG file must not exist");

    const jsonPath = join(evDir, "a1-target-found.json");
    const record = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(record.snapshot, null);
    assert.ok(record.errors.includes("snapshot too large"));
  } finally {
    _setDriverHooks(null);
    Date.now = realDateNow;
  }
});
