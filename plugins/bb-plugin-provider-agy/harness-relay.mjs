/**
 * Proves the cliproxy relay wiring, no network at all: with a relay key in
 * the environment the bridge must run every agy child inside its relay home
 * (settings.json flipping agy to Gemini-API mode) with GEMINI_API_KEY and
 * GOOGLE_GEMINI_BASE_URL laid over the child env — and with AGY_CLIPROXY=0
 * it must not touch the child env at all. The fake shim records the env it
 * was spawned with (see AGY_FAKE_RECORD_ENV in fake-agy-errors.mjs).
 *
 * Usage: node harness-relay.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agy-relay-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });
const shim = join(root, "agy-shim");
const fake = new URL("./fake-agy-errors.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_FAKE_RECORD_ENV = "HOME,GEMINI_API_KEY,GOOGLE_GEMINI_BASE_URL";
process.env.AGY_CLIPROXY_URL = "http://127.0.0.1:8317";
process.env.AGY_CLIPROXY_API_KEY = "relay-test-key";
process.env.AGY_AUTO_RETRY_MAX = "0";

const say = (...a) => process.stdout.write(`${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readEnvs = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l); } catch { return {}; }
    })
    .filter((o) => o.__env !== undefined)
    .map((o) => o.__env);

const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));
const pol = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const options = { model: "fake-model", ...pol };

let nextId = 10;

async function runTurn(threadId, clientReq) {
  const transcript = join(root, `stdin-${threadId}.ndjson`);
  writeFileSync(transcript, "");
  process.env.AGY_FAKE_TRANSCRIPT = transcript;
  process.env.AGY_FAKE_ERROR_MODE = "succeed";
  send({ jsonrpc: "2.0", id: nextId++, method: "thread/start", params: { threadId, cwd: workspace, options, instructionMode: "append" } });
  send({ jsonrpc: "2.0", id: nextId++, method: "turn/start", params: { threadId, providerThreadId: "fake-conv-errors", input: [{ type: "text", text: clientReq, mentions: [] }], clientRequestId: clientReq, options } });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (readEnvs(transcript).length >= 1) break;
    if (Date.now() > deadline) {
      say(`!!! timeout: fake never ran for ${threadId}`);
      process.exit(2);
    }
    await sleep(100);
  }
  await sleep(200);
  send({ jsonrpc: "2.0", id: nextId++, method: "thread/stop", params: { threadId, providerThreadId: "fake-conv-errors", intent: "release", activeTurnId: null } });
  return transcript;
}

// Relay mode: the overlay must reach the child.
const relayTranscript = await runTurn("t-relay", "creq_zyxwvutsra");
const relayEnv = readEnvs(relayTranscript)[0];
const settingsPath = join(root, "cliproxy-home", ".gemini", "antigravity-cli", "settings.json");
let settings = null;
try {
  settings = JSON.parse(readFileSync(settingsPath, "utf8"));
} catch {}

// Direct mode: the kill switch must leave the child env untouched.
process.env.AGY_CLIPROXY = "0";
const directTranscript = await runTurn("t-direct", "creq_zyxwvutsrb");
const directEnv = readEnvs(directTranscript)[0];

const checks = [
  ["relay/home-is-relay-home", relayEnv?.HOME === join(root, "cliproxy-home"), String(relayEnv?.HOME ?? "")],
  ["relay/key-passed-to-child", relayEnv?.GEMINI_API_KEY === "relay-test-key", String(relayEnv?.GEMINI_API_KEY ?? "")],
  ["relay/base-url-passed-to-child", relayEnv?.GOOGLE_GEMINI_BASE_URL === "http://127.0.0.1:8317", String(relayEnv?.GOOGLE_GEMINI_BASE_URL ?? "")],
  ["relay/settings-flip-gemini-mode", settings?.modelProvider === "gemini", JSON.stringify(settings)],
  ["direct/no-key-on-child-env", directEnv?.GEMINI_API_KEY === null, String(directEnv?.GEMINI_API_KEY ?? "")],
  ["direct/no-base-url-on-child-env", directEnv?.GOOGLE_GEMINI_BASE_URL === null, String(directEnv?.GOOGLE_GEMINI_BASE_URL ?? "")],
  ["direct/real-home-preserved", typeof directEnv?.HOME === "string" && !directEnv.HOME.includes("cliproxy-home"), String(directEnv?.HOME ?? "")],
];

say("==== cliproxy relay report ====");
let bad = 0;
for (const [id, ok, detail] of checks) {
  say(`${ok ? "pass" : "FAIL"} ${id.padEnd(34)} ${detail}`);
  if (!ok) bad += 1;
}
say(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);
