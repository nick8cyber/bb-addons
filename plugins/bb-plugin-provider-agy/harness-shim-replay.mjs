// Direct stdio test of src/acp-shim.mjs replay suppression over fake-agy-acp.
// Drives RAW ACP (no bb bridge): the bb bridge always wraps prompts in
// instruction text (tail >= 16), so the short-prompt positional boundary
// (prompt <16 normalized chars, e.g. "ok") is only reachable at this level.
// Run: node harness-shim-replay.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shim = join(here, "src", "acp-shim.mjs");
const fake = join(here, "fake-agy-acp.mjs");

const tmp = mkdtempSync(join(tmpdir(), "shimreplay-"));
const bin = join(tmp, "fake-bin.sh");
writeFileSync(bin, `#!/bin/sh\nexec /usr/bin/node "${fake}" "$@"\n`);
chmodSync(bin, 0o755);
const eventsFile = join(tmp, "events.ndjson");
writeFileSync(eventsFile, "");

const child = spawn("/usr/bin/node", [shim, "acp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    AGY_SHIM_REAL_BIN: bin,
    AGY_SHIM_EVENTS: eventsFile,
    AGY_SHIM_THREAD_ID: "shim-replay-test",
    AGY_DISABLE_SUBAGENTS: "0",
  },
});

const received = [];
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on("line", (l) => {
  try { received.push(JSON.parse(l)); } catch { /* relay junk is fine */ }
});
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const replies = (id) => received.filter((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
const updTexts = () => received
  .filter((m) => m.method === "session/update")
  .map((m) => m.params?.update?.content?.text)
  .filter((t) => typeof t === "string");

async function waitFor(pred, ms, label) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) {
      console.log(`TIMEOUT: ${label}`);
      for (const m of received.slice(-15)) console.log(JSON.stringify(m).slice(0, 200));
      child.kill("SIGKILL");
      process.exit(2);
    }
    await sleep(30);
  }
}

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  passed += ok ? 1 : 0; failed += ok ? 0 : 1;
  console.log(`${ok ? "pass" : "FAIL"} ${name} ${detail}`);
};

// --- build a two-turn history ---------------------------------------------
send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: tmp, mcpServers: [] } });
await waitFor(() => replies(1).length === 1, 10000, "session/new");
const sessionId = replies(1)[0].result.sessionId;

send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "first turn about elephants" }] } });
await waitFor(() => replies(2).length === 1, 15000, "prompt 2");
send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "second turn about giraffes" }] } });
await waitFor(() => replies(3).length === 1, 15000, "prompt 3");

// --- resume: replay streams AFTER the load response ------------------------
send({ jsonrpc: "2.0", id: 4, method: "session/load", params: { sessionId, cwd: tmp, mcpServers: [] } });
await waitFor(() => replies(4).length === 1, 10000, "session/load");
await sleep(400); // let the fake finish its post-response replay stream
const markAfterLoad = received.length;

// --- short prompt: tail "ok" is 2 chars -> positional boundary -------------
send({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "ok" }] } });
await waitFor(() => replies(5).length === 1, 30000, "short prompt");
await sleep(200);

const postLoadTexts = updTexts().slice(0); // all forwarded update texts
const postLoadNew = received.slice(markAfterLoad)
  .filter((m) => m.method === "session/update")
  .map((m) => m.params?.update?.content?.text)
  .filter((t) => typeof t === "string");

// The live turn's own answer must arrive — a missed boundary would eat it.
const liveAnswer = postLoadNew.some((t) => t.includes("answer to ok"));
check("short/live-answer-flows", liveAnswer, JSON.stringify(postLoadNew.slice(0, 6)));

// Replayed history must not reach the client: no forwarded text may carry the
// old turns' content (live chunks of the new turn are legitimately forwarded).
const leaked = postLoadNew.filter((t) => t.includes("elephants") || t.includes("giraffes"));
check("short/no-replay-text-leaked", leaked.length === 0, `leaked=${leaked.length}`);

// Events side-channel recorded how the boundary resolved.
const evs = existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const replayEv = evs.filter((e) => e.t === "replay-end" || e.t === "replay-abort");
check("short/boundary-event", replayEv.length >= 1, JSON.stringify(replayEv));
check("short/drops-recorded", replayEv.some((e) => (e.dropped ?? 0) > 0), JSON.stringify(replayEv.map((e) => e.dropped)));

// --- control: a long prompt still uses the content boundary ----------------
send({ jsonrpc: "2.0", id: 6, method: "session/load", params: { sessionId, cwd: tmp, mcpServers: [] } });
await waitFor(() => replies(6).length === 1, 10000, "session/load 2");
await sleep(400);
const mark2 = received.length;
send({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "now a longer prompt about capybaras" }] } });
await waitFor(() => replies(7).length === 1, 30000, "long prompt");
await sleep(200);
const post2 = received.slice(mark2)
  .filter((m) => m.method === "session/update")
  .map((m) => m.params?.update);
const post2texts = post2.map((u) => u?.content?.text).filter((t) => typeof t === "string");
check("long/live-answer-flows", post2texts.some((t) => t.includes("capybaras")), JSON.stringify(post2texts.slice(0, 6)));
// With a content boundary, replayed old answers are dropped — "elephants"
// (first turn's answer text) must not reappear after the second load.
check("long/old-answer-suppressed", !post2texts.some((t) => t.includes("elephants")), `found=${post2texts.filter((t) => t.includes("elephants")).length}`);

console.log(`\n${passed}/${passed + failed} passed`);
child.kill("SIGTERM");
process.exit(failed === 0 ? 0 : 1);
