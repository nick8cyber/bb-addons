// Fixture ACP server for PLUG-371 tests: the real acp-server.mjs wired to a
// scripted fake web driver instead of gemini-driver.js. Pass
// --bb-thread-id=<id> in argv (picked up by acp-server.mjs at import time)
// plus FAKE_BB_THREAD_JSON + BB_CLI for the bound task path.
//
// Driver behavior is selected via env:
//   WG_FAKE_SCENARIO  ok | stall-then-ok | stall-late | tool-then-stall
//   WG_FAKE_DELAY_MS  generation sleep inside sendPrompt (honours request.signal)
//   WG_FAKE_LOG       JSONL file, one entry per sendPrompt call (accountId, convId)

import { appendFileSync } from "node:fs";

const logFile = process.env.WG_FAKE_LOG;
const log = (entry) => {
  if (!logFile) return;
  try {
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch {}
};

let callNo = 0;
const stalledError = () => {
  const e = new Error("generation stalled — no progress for 2s");
  e.code = "WEB_GEMINI_STALLED";
  return e;
};
const abortableSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });

const fakeDriver = {
  getPlaywright: () => ({
    chromium: {
      connectOverCDP: async () => {
        throw new Error("fixture: no CDP endpoint");
      },
    },
  }),
  async sendPrompt(request) {
    callNo += 1;
    const n = callNo;
    log({
      n,
      accountId: request.accountId ?? request.backend?.id ?? null,
      convId: request.convId ?? null,
    });
    const scenario = process.env.WG_FAKE_SCENARIO || "ok";
    const delayMs = Number(process.env.WG_FAKE_DELAY_MS || 0);
    request.onSubmitted?.();
    if (delayMs > 0) await abortableSleep(delayMs, request.signal);
    if (scenario === "stall-then-ok" && n === 1) throw stalledError();
    if (scenario === "stall-late") throw stalledError();
    if (scenario === "tool-then-stall") {
      if (n === 1) return { text: '<tool name="list_dir" path="."/>', convId: "conv-fixture" };
      throw stalledError();
    }
    return { text: "FIXTURE FINAL ANSWER", convId: request.convId ?? "conv-fixture" };
  },
};

const { startServer } = await import("../../acp-server.mjs");
startServer({ webDriver: fakeDriver });
