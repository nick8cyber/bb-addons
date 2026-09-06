/**
 * Proves the rebuild path — the one the bridge takes when agy is gone but its
 * conversation is not — at no quota cost. One session, a first turn whose
 * child exits the moment it has answered ([[die]]), and a second turn that
 * can only run if the bridge rebuilds:
 *
 *   the replacement is announced   -> `session/replaced`, before anything the
 *                                     new child says
 *   the new provider session       -> `thread/identity` + `session.reset`,
 *                                     even though the conversation id is the
 *                                     same one
 *   the second turn's deltas       -> all of them after that reset, never in
 *                                     the id space the runtime just dropped
 *   usage after the rebuild        -> counted from the new child's own zero
 *
 * Usage: node harness-rebuild.mjs
 */
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createBridgeDeltaEventCollector } from "@get-bb/plugin-sdk/provider-bridge/testing";

const root = mkdtempSync(join(tmpdir(), "agy-rebuild-"));
const transcript = join(root, "stdin.ndjson");
writeFileSync(transcript, "");
const shim = join(root, "agy-shim");
const fake = new URL("./fake-agy.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
// hermetic: the host may or may not have an agent-proxy core to auto-detect
process.env.AGY_CLIPROXY = "0";
process.env.AGY_FAKE_TRANSCRIPT = transcript;

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

const THREAD = "t_rebuild";
const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));
const pol = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const options = { model: "fake-model", ...pol };
const responseFor = (id) => messages.find((m) => m.id === id);
const forThread = (m) => m.params?.threadId === THREAD;
const notifications = () =>
  messages.filter((m) => m.method === "thread/delta" && forThread(m));
const deltas = () => notifications().flatMap((m) => m.params.deltas);
const kinds = (kind) => deltas().filter((d) => d.kind === kind);
const childLines = () =>
  readFileSync(transcript, "utf8").split("\n").filter((l) => l.trim().length > 0);

/**
 * One timeline of everything the bridge said about this thread — notifications
 * and deltas in the order they went out. Ordering is the whole finding here,
 * so the two streams have to be compared in one sequence, not separately.
 */
const timeline = () => {
  const events = [];
  for (const m of messages) {
    if (m.method === undefined || !forThread(m)) continue;
    if (m.method === "thread/delta") {
      for (const d of m.params.deltas) events.push({ what: d.kind, delta: d });
      continue;
    }
    events.push({ what: m.method, params: m.params });
  }
  return events;
};
const firstIndex = (what) => timeline().findIndex((e) => e.what === what);
const lastIndex = (what) => timeline().findLastIndex((e) => e.what === what);
const countOf = (what) => timeline().filter((e) => e.what === what).length;

const results = [];
const check = (id, ok, detail = "") =>
  results.push({ id, status: ok ? "pass" : "FAIL", detail });

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

send({
  jsonrpc: "2.0",
  id: "init",
  method: "initialize",
  params: { protocolVersion: 2, grammarVersions: [3, 3], client: { name: "rebuild-harness", version: "1" } },
});

// --- a session whose child will not survive its first turn ---------------
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
    input: [{ type: "text", text: "[[die]] answer and then crash", mentions: [] }],
    clientRequestId: "creq_aaaaaaaaaa",
    options,
  },
});
await waitFor(() => kinds("turn.boundary").length === 1, 15_000, "the first turn settling");
const firstBoundary = kinds("turn.boundary")[0];
// The child is on its way out; the bridge learns that from `close`.
await waitFor(() => kinds("provider.error").length === 1, 15_000, "the child's death");
const notificationsBeforeRebuild = countOf("session/replaced");
check(
  "first-turn/completed-before-the-crash",
  firstBoundary?.status === "completed",
  JSON.stringify([firstBoundary?.status, firstBoundary?.error?.message].filter(Boolean)),
);
check(
  "crash/no-replacement-announced-yet",
  notificationsBeforeRebuild === 0,
  `${notificationsBeforeRebuild} session/replaced before any new turn`,
);

// --- the turn that can only run on a rebuilt child -----------------------
send({
  jsonrpc: "2.0",
  id: "turn2",
  method: "turn/start",
  params: {
    threadId: THREAD,
    providerThreadId,
    input: [{ type: "text", text: "still there?", mentions: [] }],
    clientRequestId: "creq_bbbbbbbbbb",
    options,
  },
});
await waitFor(() => kinds("turn.boundary").length === 2, 20_000, "the rebuilt turn settling");
await sleep(100);

const replaced = timeline().find((e) => e.what === "session/replaced")?.params;
check(
  "rebuild/announced-as-a-replacement",
  countOf("session/replaced") === 1 &&
    replaced?.providerThreadId === providerThreadId &&
    replaced?.contextLost === false &&
    typeof replaced?.reason === "string" &&
    replaced.reason.length > 0,
  JSON.stringify(replaced),
);
check(
  "rebuild/session-reset-emitted",
  countOf("session.reset") === 2,
  `${countOf("session.reset")} session.reset (one per provider session)`,
);
check(
  "rebuild/identity-reannounced",
  countOf("thread/identity") === 2 &&
    timeline()
      .filter((e) => e.what === "thread/identity")
      .every((e) => e.params.providerThreadId === providerThreadId),
  `${countOf("thread/identity")} thread/identity`,
);
check(
  "rebuild/order-replaced-identity-reset",
  firstIndex("session/replaced") < lastIndex("thread/identity") &&
    lastIndex("thread/identity") < lastIndex("session.reset"),
  JSON.stringify([
    firstIndex("session/replaced"),
    lastIndex("thread/identity"),
    lastIndex("session.reset"),
  ]),
);
// The point of the reset: nothing the replacement child says may precede it,
// or the runtime assembles the new session's items into the id space it is
// about to drop. `resetAt` is the SECOND reset — the rebuilt session's own.
const resetAt = timeline().map((e, index) => ({ ...e, index }))
  .filter((e) => e.what === "session.reset")[1]?.index ?? Number.MAX_SAFE_INTEGER;
const afterTheCrash = timeline()
  .map((e, index) => ({ ...e, index }))
  .filter((e) => e.index > firstIndex("provider.error"));
check(
  "rebuild/no-delta-from-the-new-child-before-the-reset",
  kinds("turn.open").length === 2 &&
    afterTheCrash
      .filter((e) => e.delta !== undefined && e.what !== "session.reset")
      .every((e) => e.index > resetAt),
  JSON.stringify(afterTheCrash.map((e) => e.what)),
);
const second = kinds("turn.boundary")[1];
check(
  "rebuild/second-turn-completes",
  second?.status === "completed" && second.providerTurnId !== firstBoundary?.providerTurnId,
  JSON.stringify([second?.status, second?.providerTurnId]),
);
const settled = kinds("item.textClose").at(-1) ?? kinds("item.close").at(-1);
check(
  "rebuild/answer-survives-the-restart",
  kinds("item.textDelta").filter((d) => d.text.length > 0).length >= 8,
  `${kinds("item.textDelta").length} text deltas across both turns`,
);
check(
  "rebuild/child-restarted-on-the-same-conversation",
  childLines().length === 2 &&
    JSON.parse(childLines()[1]).message.content === "still there?",
  JSON.stringify(childLines().map((l) => JSON.parse(l).message.content)),
);
const usage = kinds("usage");
check(
  "rebuild/usage-counted-from-the-new-child",
  usage.length === 2 &&
    usage[1].last.totalTokens === usage[1].total.totalTokens &&
    usage[1].last.totalTokens > 0,
  JSON.stringify(usage.map((u) => [u.total.totalTokens, u.last.totalTokens])),
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
check("deltas/schema-valid", schemaValid, settled === undefined ? "no item settled" : "");

send({
  jsonrpc: "2.0",
  id: "stop",
  method: "thread/stop",
  params: { threadId: THREAD, providerThreadId, intent: "release", activeTurnId: null },
});
bridge.onClose?.();
process.stdout.write = originalWrite;

say("==== rebuild report ====");
for (const r of results) {
  say(`${r.status.padEnd(4)} ${r.id.padEnd(52)} ${r.detail}`);
}
const bad = results.filter((r) => r.status !== "pass").length;
say(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad === 0 ? 0 : 1);
