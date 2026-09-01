/**
 * Proves the steer path the bridge declares (`steerMode: "queue"`), at no
 * quota cost. One session, one turn held mid-stream by the fake agy, and two
 * steers sent while that turn is provably still running:
 *
 *   turn/steer while a turn is live  -> accepted, never refused
 *   the accepted steer               -> the next turn, announced only when it
 *                                       reaches the head of the queue
 *   the child's stdin               -> one line per turn, in order, and the
 *                                       steer's line only after the held
 *                                       turn's `result`
 *   turn/steer for a settled turn    -> NO_ACTIVE_TURN + `staleTurn`
 *
 * Usage: node harness-steer.mjs
 */
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createBridgeDeltaEventCollector } from "@get-bb/plugin-sdk/provider-bridge/testing";

const root = mkdtempSync(join(tmpdir(), "agy-steer-"));
const transcript = join(root, "stdin.ndjson");
const release = join(root, "release");
writeFileSync(transcript, "");
const shim = join(root, "agy-shim");
const fake = new URL("./fake-agy.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_FAKE_TRANSCRIPT = transcript;
process.env.AGY_FAKE_RELEASE = release;

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
const say = (...a) => originalWrite(`${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THREAD = "t_steer";
const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));
const pol = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const options = { model: "fake-model", ...pol };
const responseFor = (id) => messages.find((m) => m.id === id);
const notifications = () =>
  messages.filter((m) => m.method === "thread/delta" && m.params.threadId === THREAD);
const deltas = () => notifications().flatMap((m) => m.params.deltas);
const kinds = (kind) => deltas().filter((d) => d.kind === kind);
const childLines = () =>
  readFileSync(transcript, "utf8").split("\n").filter((l) => l.trim().length > 0);

const results = [];
const check = (id, ok, detail = "") =>
  results.push({ id, status: ok ? "pass" : "FAIL", detail });

/** Wait, but let the report speak: a queue that never drains IS the finding. */
async function waitAtMost(predicate, ms) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await sleep(25);
  }
}

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      process.stdout.write = originalWrite;
      say(`\n!!! timeout waiting for ${label}; captured traffic:`);
      for (const m of messages) say(JSON.stringify(m).slice(0, 300));
      process.exit(2);
    }
    await sleep(25);
  }
}

// --- handshake: the capability under test --------------------------------
send({
  jsonrpc: "2.0",
  id: "init",
  method: "initialize",
  params: { protocolVersion: 2, grammarVersions: [3, 3], client: { name: "steer-harness", version: "1" } },
});
check(
  "handshake/steer-mode-queue",
  responseFor("init")?.result?.capabilities?.steerMode === "queue",
  JSON.stringify(responseFor("init")?.result?.capabilities?.steerMode),
);

// --- a session with one turn that will not settle on its own -------------
send({
  jsonrpc: "2.0",
  id: "start",
  method: "thread/start",
  params: { threadId: THREAD, cwd: root, options, instructionMode: "append" },
});
await waitFor(() => responseFor("start") !== undefined, 15_000, "thread/start");
const providerThreadId = responseFor("start")?.result?.providerThreadId;

send({
  jsonrpc: "2.0",
  id: "turn1",
  method: "turn/start",
  params: {
    threadId: THREAD,
    providerThreadId,
    input: [{ type: "text", text: "[[hold]] count to four", mentions: [] }],
    clientRequestId: "creq_aaaaaaaaaa",
    options,
  },
});
// The held turn has streamed text and cannot settle until this harness lets
// it: everything below steers a turn that is unmistakably running.
await waitFor(() => kinds("item.textDelta").length > 0, 15_000, "first turn streaming");
const liveTurnId = kinds("turn.open")[0]?.providerTurnId;

// --- two steers, both while that turn is live ----------------------------
const steer = (id, clientRequestId, text, expectedTurnId) =>
  send({
    jsonrpc: "2.0",
    id,
    method: "turn/steer",
    params: {
      threadId: THREAD,
      providerThreadId,
      input: [{ type: "text", text, mentions: [] }],
      clientRequestId,
      expectedTurnId,
      options,
    },
  });

steer("steer1", "creq_bbbbbbbbbb", "actually stop at two", liveTurnId);
check(
  "steer/accepted-while-active",
  responseFor("steer1")?.result !== undefined &&
    responseFor("steer1")?.error === undefined,
  JSON.stringify(responseFor("steer1")),
);
steer("steer2", "creq_cccccccccc", "and then say bye", liveTurnId);
check(
  "steer/second-steer-also-queues",
  responseFor("steer2")?.result !== undefined,
  JSON.stringify(responseFor("steer2")),
);

// Give a broken bridge every chance to leak the queued work early.
await sleep(300);
check(
  "steer/not-started-before-its-turn",
  kinds("turn.open").length === 1 &&
    kinds("turn.boundary").length === 0 &&
    kinds("input.accepted").every((d) => d.clientRequestId === "creq_aaaaaaaaaa"),
  `${kinds("turn.open").length} turn.open, ${kinds("input.accepted").length} input.accepted`,
);
check(
  "steer/not-handed-to-agy-before-its-turn",
  childLines().length === 1,
  `${childLines().length} lines on the child's stdin: ${JSON.stringify(childLines())}`,
);

// --- let the held turn finish and watch the queue drain -----------------
writeFileSync(release, "go");
await waitAtMost(() => kinds("turn.boundary").length === 3, 20_000);
await sleep(100);

const opens = kinds("turn.open");
const boundaries = kinds("turn.boundary");
const accepted = kinds("input.accepted");
const all = deltas();
const indexOf = (predicate) => all.findIndex(predicate);

check(
  "turn/three-turns-one-session",
  boundaries.length === 3 &&
    boundaries.every((b) => b.status === "completed") &&
    new Set(boundaries.map((b) => b.providerTurnId)).size === 3,
  JSON.stringify(boundaries.map((b) => [b.status, b.providerTurnId])),
);
check(
  "steer/runs-after-the-turn-it-steered",
  boundaries[0]?.providerTurnId === liveTurnId &&
    opens.length === 3 &&
    opens[1]?.providerTurnId === boundaries[1]?.providerTurnId &&
    indexOf((d) => d.kind === "turn.boundary" && d.providerTurnId === liveTurnId) <
      indexOf((d) => d.kind === "turn.open" && d.providerTurnId === opens[1]?.providerTurnId),
  JSON.stringify(opens.map((o) => o.providerTurnId)),
);
check(
  "steer/accepted-input-names-its-own-turn",
  accepted.length === 3 &&
    accepted[1]?.clientRequestId === "creq_bbbbbbbbbb" &&
    accepted[1]?.providerTurnId === opens[1]?.providerTurnId &&
    accepted[2]?.clientRequestId === "creq_cccccccccc" &&
    accepted[2]?.providerTurnId === opens[2]?.providerTurnId,
  JSON.stringify(accepted.map((a) => [a.clientRequestId, a.providerTurnId])),
);
const sent = childLines().map((line) => JSON.parse(line).message.content);
check(
  "steer/one-line-per-turn-in-order",
  sent.length === 3 &&
    sent[0].includes("[[hold]]") &&
    sent[1] === "actually stop at two" &&
    sent[2] === "and then say bye",
  JSON.stringify(sent),
);
check(
  "steer/steered-text-is-what-agy-got",
  sent.every((text) => text.trim().length > 0),
  "",
);
let schemaValid = true;
try {
  const collector = experimental_createBridgeDeltaEventCollector("agy");
  for (const message of notifications()) {
    collector.assembleMessage(message);
  }
} catch (error) {
  schemaValid = false;
  say(String(error));
}
check("deltas/schema-valid", schemaValid);

// --- a steer for a turn that is gone is still refused, typed ------------
steer("steer3", "creq_dddddddddd", "too late", liveTurnId);
const stale = responseFor("steer3")?.error;
check(
  "steer/stale-turn-refused",
  stale?.code === -32001 &&
    stale?.data?.recovery?.kind === "staleTurn" &&
    stale?.data?.recovery?.retryable === false,
  JSON.stringify(stale),
);
send({
  jsonrpc: "2.0",
  id: "steer4",
  method: "turn/steer",
  params: {
    threadId: "t_does_not_exist",
    providerThreadId,
    input: [{ type: "text", text: "nobody home", mentions: [] }],
    clientRequestId: "creq_eeeeeeeeee",
    expectedTurnId: liveTurnId,
    options,
  },
});
check(
  "steer/unknown-thread-refused",
  responseFor("steer4")?.error?.code === -32001 &&
    responseFor("steer4")?.error?.data?.recovery?.kind === "staleTurn",
  JSON.stringify(responseFor("steer4")?.error?.code),
);

send({
  jsonrpc: "2.0",
  id: "stop",
  method: "thread/stop",
  params: { threadId: THREAD, providerThreadId, intent: "release", activeTurnId: null },
});
bridge.onClose?.();
process.stdout.write = originalWrite;

say("==== queued-steer report ====");
for (const r of results) {
  say(`${r.status.padEnd(4)} ${r.id.padEnd(38)} ${r.detail}`);
}
const bad = results.filter((r) => r.status !== "pass").length;
say(`\n${results.length - bad}/${results.length} passed`);
if (!existsSync(release)) say("(the held turn was never released — that is a bug in this harness)");
process.exit(bad === 0 ? 0 : 1);
