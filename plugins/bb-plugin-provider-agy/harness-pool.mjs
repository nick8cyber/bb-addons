/**
 * Proves the account pool, no network at all. Three pool accounts, each of
 * which refuses its first request (per-home sentinel in fake-agy-errors.mjs
 * pool-retry mode) and works afterwards; a2 carries a `proxy` file. The
 * expected ride: the first turn lands on a1 and fails with the quota text,
 * the bridge cools a1 and rotates to a2 (fresh conversation, contextLost,
 * the account's HTTPS_PROXY in the child env), a2 refuses too (its own
 * first request), the bridge rotates to a3, which answers. Then a second
 * turn on the same session runs on the SAME live child — sticky, no new
 * spawn, resumed conversation.
 *
 * Usage: node harness-pool.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agy-pool-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });
const shim = join(root, "agy-shim");
const fake = new URL("./fake-agy-errors.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_FAKE_RECORD_ENV = "HOME,HTTPS_PROXY";
process.env.AGY_FAKE_TRANSCRIPT = join(root, "envlog.ndjson");
process.env.AGY_CLIPROXY = "0";
process.env.AGY_AUTO_RETRY_MAX = "1";
process.env.AGY_FAKE_ERROR_MODE = "pool-retry";

// The pool: a2 is the one with an egress proxy.
for (const label of ["a1", "a2", "a3"]) {
  const cli = join(root, "accounts", label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}
writeFileSync(join(root, "accounts", "a2", "proxy"), "http://proxy-a2:9\n");

const readEnvs = () =>
  readFileSync(join(root, "envlog.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l); } catch { return {}; }
    })
    .filter((o) => o.__env !== undefined);

const say = (...a) => process.stdout.write(`${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    try { messages.push(JSON.parse(line)); } catch { messages.push({ __nonJson: line }); }
  }
  return true;
};

const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));
const pol = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const options = { model: "fake-model", ...pol };

const boundaries = (threadId) =>
  messages
    .filter((m) => m.method === "thread/delta" && m.params.threadId === threadId)
    .flatMap((m) => m.params.deltas)
    .filter((d) => d.kind === "turn.boundary");
const replaced = () =>
  messages.filter((m) => m.method === "session/replaced" && m.params.threadId === "t-pool");

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      process.stdout.write = originalWrite;
      say(`!!! timeout: ${label}`);
      for (const m of messages) say(JSON.stringify(m).slice(0, 260));
      process.exit(2);
    }
    await sleep(50);
  }
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, grammarVersions: [3, 3], client: { name: "fake", version: "1" } } });
send({
  jsonrpc: "2.0", id: 2, method: "thread/start",
  params: { threadId: "t-pool", cwd: workspace, options, instructionMode: "append" },
});
send({
  jsonrpc: "2.0", id: 3, method: "turn/start",
  params: {
    threadId: "t-pool", providerThreadId: "fake-conv-pool",
    input: [{ type: "text", text: "one", mentions: [] }],
    clientRequestId: "creq_zyxwvutsra", options,
  },
});
await waitFor(() => boundaries("t-pool").length >= 4 && boundaries("t-pool")[3].status === "completed", 40_000, "rotation completes");
await sleep(200);

// Turn two: the same session, same (alive) child, no new spawn, no rotation.
send({
  jsonrpc: "2.0", id: 4, method: "turn/start",
  params: {
    threadId: "t-pool", providerThreadId: "fake-conv-pool",
    input: [{ type: "text", text: "two", mentions: [] }],
    clientRequestId: "creq_zyxwvutsrb", options,
  },
});
await waitFor(() => boundaries("t-pool").length >= 5, 15_000, "second turn settles");
await sleep(200);
send({ jsonrpc: "2.0", id: 5, method: "thread/stop", params: { threadId: "t-pool", providerThreadId: "fake-conv-pool", intent: "release", activeTurnId: null } });
await sleep(100);
process.stdout.write = originalWrite;

const envs = readEnvs();
const bs = boundaries("t-pool");
const ledger = JSON.parse(readFileSync(join(root, "accounts-state.json"), "utf8"));
const replacedList = replaced();

const checks = [
  ["pool/homes-visited-in-order", envs.length === 4 && ["a1", "a2", "a3", "a3"].every((l, i) => envs[i]?.__env?.HOME === join(root, "accounts", l)), JSON.stringify(envs.map((e) => e?.__env?.HOME))],
  ["pool/failures-then-completion", bs.length === 5 && bs.slice(0, 3).every((b) => b.status === "failed") && bs[3].status === "completed" && bs[4].status === "completed", JSON.stringify(bs.map((b) => b.status))],
  ["pool/proxy-follows-account", envs[1]?.__env?.HTTPS_PROXY === "http://proxy-a2:9" && envs[0]?.__env?.HTTPS_PROXY == null && envs[2]?.__env?.HTTPS_PROXY == null && envs[3]?.__env?.HTTPS_PROXY == null, JSON.stringify(envs.map((e) => e?.__env?.HTTPS_PROXY))],
  ["pool/rotations-fresh-resume-last", envs[1]?.__argv?.includes("--conversation") !== true && envs[2]?.__argv?.includes("--conversation") !== true && envs[3]?.__argv?.includes("--conversation") === true, JSON.stringify([envs[1]?.__argv?.includes("--conversation"), envs[2]?.__argv?.includes("--conversation"), envs[3]?.__argv?.includes("--conversation")])],
  ["pool/replaced-announced-thrice", replacedList.length === 3 && replacedList[0].params.contextLost === true && replacedList[1].params.contextLost === true && replacedList[2].params.contextLost === false, JSON.stringify(replacedList.map((m) => m.params.contextLost))],
  ["pool/cooldowns-recorded", (ledger.accounts.a1?.cooldownUntilMs ?? 0) > 0 && (ledger.accounts.a2?.cooldownUntilMs ?? 0) > 0 && (ledger.accounts.a3?.cooldownUntilMs ?? 0) > 0, JSON.stringify(ledger.accounts)],
  ["pool/conversation-mapped-to-a3", ledger.conversations["fake-conv-errors"] === "a3", JSON.stringify(ledger.conversations)],
  ["pool/sticky-second-turn-no-respawn", envs.length === 4, `${envs.length} spawns for two turns`],
];

say("==== account pool report ====");
let bad = 0;
for (const [id, ok, detail] of checks) {
  say(`${ok ? "pass" : "FAIL"} ${id.padEnd(36)} ${detail}`);
  if (!ok) bad += 1;
}
say(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);
