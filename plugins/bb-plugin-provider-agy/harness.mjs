/**
 * Offline harness: drives the BUILT bridge artifact (dist/host.js) in-process
 * through the protocol-v2/thread-delta rules, plus one real agy turn.
 *
 * Usage: node harness.mjs <model>
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createBridgeDeltaEventCollector } from "@get-bb/plugin-sdk/provider-bridge/testing";

const MODEL = process.argv[2] ?? "gemini-3.5-flash-low";
const workspace = mkdtempSync(join(tmpdir(), "agy-conformance-"));

// --- capture the bridge's stdout ------------------------------------------
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
    try {
      messages.push(JSON.parse(line));
    } catch {
      messages.push({ __nonJson: line });
    }
  }
  return true;
};
const say = (...args) => originalWrite(`${args.join(" ")}\n`);

const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: workspace, tempDir: workspace });

const send = (message) => bridge.handleLine(JSON.stringify(message));
const sendRaw = (line) => bridge.handleLine(line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = messages.find(predicate);
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) {
      process.stdout.write = originalWrite;
      say(`\n!!! timeout waiting for ${label}; captured traffic:`);
      for (const m of messages) say(JSON.stringify(m).slice(0, 300));
      process.exit(2);
    }
    await sleep(100);
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(100);
  }
  return predicate();
}

const results = [];
const check = (id, ok, detail = "") =>
  results.push({ id, status: ok ? "pass" : "FAIL", detail });
/** A rule this run could not put in a position to observe (see steering). */
const skip = (id, detail) => results.push({ id, status: "skip", detail });

const responseFor = (id) => messages.find((m) => m.id === id);
const deltaNotifications = (threadId) =>
  messages
    .filter(
      (m) =>
        m.method === "thread/delta" &&
        (threadId === undefined || m.params.threadId === threadId),
    );
const deltas = (threadId) =>
  deltaNotifications(threadId).flatMap((m) => m.params.deltas);
const notifications = (method) => messages.filter((m) => m.method === method);

const permissionPolicy = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};
const options = { model: MODEL, ...permissionPolicy };

// --- rpc hygiene ----------------------------------------------------------
send({ jsonrpc: "2.0", id: "h1", method: "definitely/not/a/method", params: {} });
check(
  "rpc/unknown-method",
  responseFor("h1")?.error?.code === -32601,
  JSON.stringify(responseFor("h1")),
);

send({ jsonrpc: "2.0", id: "h2", method: "thread/start", params: { threadId: "" } });
check(
  "rpc/invalid-params",
  responseFor("h2")?.error?.code === -32602 &&
    Array.isArray(responseFor("h2")?.error?.data),
  JSON.stringify(responseFor("h2")?.error?.code),
);

const beforeGarbage = messages.length;
sendRaw("this is not json at all");
sendRaw('{"jsonrpc":"2.0","id":"stray","result":{}}');
check(
  "rpc/non-json-ignored",
  messages.length === beforeGarbage,
  `${messages.length - beforeGarbage} unexpected writes`,
);
check("rpc/response-not-request", messages.length === beforeGarbage);

// --- handshake ------------------------------------------------------------
send({
  jsonrpc: "2.0",
  id: "init",
  method: "initialize",
  params: {
    protocolVersion: 2,
    grammarVersions: [3, 3],
    client: { name: "harness", version: "1.0.0" },
  },
});
const handshake = responseFor("init")?.result;
check(
  "handshake/initialize",
  handshake?.protocolVersion === 2 &&
    JSON.stringify(handshake?.capabilities?.grammarVersions) === "[3,3]",
  JSON.stringify(handshake),
);

// --- model list -----------------------------------------------------------
send({ jsonrpc: "2.0", id: "models", method: "model/list", params: { cwd: workspace } });
await waitFor((m) => m.id === "models", 40_000, "model/list response").catch(() => {});
const modelList = responseFor("models")?.result;
check(
  "model/list",
  Array.isArray(modelList?.models) && modelList.models.length > 0,
  `${modelList?.models?.length ?? 0} models, first=${modelList?.models?.[0]?.id}`,
);

// --- session start + one real turn ---------------------------------------
const threadId = "thr_harness_1";
send({
  jsonrpc: "2.0",
  id: "start",
  method: "thread/start",
  params: {
    threadId,
    cwd: workspace,
    options,
    instructionMode: "append",
  },
});
const startResponse = await waitFor((m) => m.id === "start", 90_000, "thread/start response");
const providerThreadId = startResponse?.result?.providerThreadId;
check(
  "session/start-identity",
  typeof providerThreadId === "string" && providerThreadId.length > 0,
  JSON.stringify(startResponse),
);

const identityIndex = messages.findIndex((m) => m.method === "thread/identity");
const firstDeltaIndex = messages.findIndex((m) => m.method === "thread/delta");
check(
  "ordering/identity-precedes-deltas",
  identityIndex !== -1 && (firstDeltaIndex === -1 || identityIndex < firstDeltaIndex),
  `identity@${identityIndex} firstDelta@${firstDeltaIndex}`,
);
check(
  "session/reset-first",
  deltas(threadId)[0]?.kind === "session.reset",
  JSON.stringify(deltas(threadId)[0]),
);

send({
  jsonrpc: "2.0",
  id: "turn",
  method: "turn/start",
  params: {
    threadId,
    providerThreadId,
    input: [{ type: "text", text: "say hi in one word", mentions: [] }],
    clientRequestId: "creq_abcdefghij",
    options,
  },
});
await waitFor(
  (m) =>
    m.method === "thread/delta" &&
    m.params.threadId === threadId &&
    m.params.deltas.some((delta) => delta.kind === "turn.boundary"),
  120_000,
  "turn/completed",
);

const turnDeltas = deltas(threadId);
const accepted = turnDeltas.find((delta) => delta.kind === "input.accepted");
const started = turnDeltas.find((delta) => delta.kind === "turn.open");
const completed = turnDeltas.find((delta) => delta.kind === "turn.boundary");
const acceptedIdx = turnDeltas.findIndex(
  (delta) => delta.kind === "input.accepted",
);
const startedIdx = turnDeltas.findIndex((delta) => delta.kind === "turn.open");
check(
  "turn/lifecycle",
  accepted?.clientRequestId === "creq_abcdefghij" &&
    started !== undefined &&
    startedIdx !== -1 &&
    acceptedIdx > startedIdx &&
    completed?.status === "completed" &&
    accepted.providerTurnId === completed.providerTurnId,
  `accepted=${Boolean(accepted)} started=${Boolean(started)} order=${startedIdx}<${acceptedIdx} status=${completed?.status}`,
);

const itemStartedIdx = turnDeltas.findIndex((delta) => delta.kind === "item.open");
const firstDeltaIdx = turnDeltas.findIndex(
  (delta) => delta.kind === "item.textDelta",
);
const textDeltas = turnDeltas.filter((delta) => delta.kind === "item.textDelta");
check(
  "item/opens-before-delta",
  itemStartedIdx !== -1 && firstDeltaIdx > itemStartedIdx,
  `started@${itemStartedIdx} delta@${firstDeltaIdx}`,
);
check(
  "stream/deltas-arrive",
  textDeltas.length > 0,
  `${textDeltas.length} deltas: ${JSON.stringify(textDeltas.map((d) => d.text))}`,
);
const finalItem = turnDeltas.findLast?.((delta) => delta.kind === "item.close");
check(
  "item/settles-with-text",
  typeof finalItem?.item?.text === "string" && finalItem.item.text.length > 0,
  JSON.stringify(finalItem?.item?.text),
);
const usageEvent = turnDeltas.find((delta) => delta.kind === "usage");
check(
  "usage/reported",
  usageEvent?.total?.totalTokens > 0,
  JSON.stringify(usageEvent?.total),
);
let deltasAreSchemaValid = true;
try {
  const collector = experimental_createBridgeDeltaEventCollector("agy");
  for (const message of deltaNotifications(threadId)) {
    collector.assembleMessage(message);
  }
} catch {
  deltasAreSchemaValid = false;
}
check(
  "deltas/schema-valid",
  deltasAreSchemaValid,
);

// --- steering: queued while live, refused when stale ----------------------
// The bridge declares `steerMode: "queue"`, so a steer aimed at a running turn
// must be ACCEPTED and become the next turn. Nothing here fakes the timing:
// the steer goes out while the second turn is still streaming.
const beforeSteer = deltas(threadId).length;
const since = () => deltas(threadId).slice(beforeSteer);
send({
  jsonrpc: "2.0",
  id: "turn2",
  method: "turn/start",
  params: {
    threadId,
    providerThreadId,
    input: [
      {
        type: "text",
        text: "count from 1 to 40, one number per line, nothing else",
        mentions: [],
      },
    ],
    clientRequestId: "creq_bcdefghijk",
    options,
  },
});
// `turn.open` is the moment the turn is live. Waiting for streamed text
// instead would be too late: agy 1.1.23 flushes a whole answer in one
// `agent_response` delta at DONE, so the first delta and the turn's `result`
// arrive together and there is no live turn left to steer.
await waitUntil(() => since().some((d) => d.kind === "turn.open"), 30_000);
const liveTurnId = since().find((d) => d.kind === "turn.open")?.providerTurnId;
const alreadySettled = since().some((d) => d.kind === "turn.boundary");
send({
  jsonrpc: "2.0",
  id: "steer",
  method: "turn/steer",
  params: {
    threadId,
    providerThreadId,
    input: [{ type: "text", text: "stop counting and say STOPPED", mentions: [] }],
    clientRequestId: "creq_cdefghijkm",
    expectedTurnId: liveTurnId ?? "x",
    options,
  },
});
if (alreadySettled) {
  // A turn short enough to finish inside one poll is not a steerable turn;
  // reporting a stale steer as a steer failure would be a lie about the rule.
  // harness-steer.mjs proves this deterministically against the fake.
  const detail = "the steered turn settled before the steer went out";
  skip("steer/queued-while-active", detail);
  skip("steer/runs-after-the-turn-it-steered", detail);
} else {
  const queued =
    responseFor("steer")?.result !== undefined &&
    responseFor("steer")?.error === undefined;
  check("steer/queued-while-active", queued, JSON.stringify(responseFor("steer")));
  // A refused steer produces no second turn, so wait for what this run can
  // still reach rather than stalling on a turn that will never open.
  await waitUntil(
    () =>
      since().filter((d) => d.kind === "turn.boundary").length >=
      (queued ? 2 : 1),
    180_000,
  );
  const steerOpen = since().filter((d) => d.kind === "turn.open")[1];
  const firstBoundaryIdx = since().findIndex((d) => d.kind === "turn.boundary");
  const steerOpenIdx = since().findIndex(
    (d) => d.kind === "turn.open" && d.providerTurnId === steerOpen?.providerTurnId,
  );
  const steerAccepted = since().find(
    (d) => d.kind === "input.accepted" && d.clientRequestId === "creq_cdefghijkm",
  );
  check(
    "steer/runs-after-the-turn-it-steered",
    steerOpen !== undefined &&
      steerOpen.providerTurnId !== liveTurnId &&
      firstBoundaryIdx !== -1 &&
      firstBoundaryIdx < steerOpenIdx &&
      steerAccepted?.providerTurnId === steerOpen.providerTurnId,
    `live=${liveTurnId} steerTurn=${steerOpen?.providerTurnId} boundary@${firstBoundaryIdx} open@${steerOpenIdx}`,
  );
}
send({
  jsonrpc: "2.0",
  id: "stale",
  method: "turn/steer",
  params: {
    threadId,
    providerThreadId,
    input: [{ type: "text", text: "too late", mentions: [] }],
    clientRequestId: "creq_defghijkmn",
    expectedTurnId: completed?.providerTurnId ?? "x",
    options,
  },
});
check(
  "steer/stale-turn-refused",
  responseFor("stale")?.error?.code === -32001 &&
    responseFor("stale")?.error?.data?.recovery?.kind === "staleTurn",
  JSON.stringify(responseFor("stale")?.error),
);

// --- release stop fabricates nothing -------------------------------------
const beforeStop = deltas(threadId).length;
send({
  jsonrpc: "2.0",
  id: "stop",
  method: "thread/stop",
  params: { threadId, providerThreadId, intent: "release", activeTurnId: null },
});
const afterStop = deltas(threadId).slice(beforeStop);
check(
  "stop/release-not-interrupted",
  responseFor("stop")?.result !== undefined &&
    !afterStop.some(
      (delta) => delta.kind === "turn.boundary" && delta.status === "interrupted",
    ),
  JSON.stringify(afterStop.map((delta) => delta.kind)),
);

// --- resume the same agy conversation ------------------------------------
send({
  jsonrpc: "2.0",
  id: "resume",
  method: "thread/resume",
  params: {
    threadId,
    providerThreadId,
    cwd: workspace,
    options,
    instructionMode: "append",
  },
});
const resumeResponse = await waitFor((m) => m.id === "resume", 90_000, "thread/resume").catch(
  () => undefined,
);
check(
  "session/resume",
  resumeResponse?.result?.providerThreadId === providerThreadId,
  JSON.stringify(resumeResponse),
);

send({
  jsonrpc: "2.0",
  id: "stop2",
  method: "thread/stop",
  params: { threadId, providerThreadId, intent: "release", activeTurnId: null },
});

bridge.onClose?.();
process.stdout.write = originalWrite;

say("\n==== harness report ====");
for (const r of results) {
  say(`${r.status.padEnd(4)} ${r.id.padEnd(34)}  ${r.detail}`);
}
const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "skip");
say(
  `\n${results.length - failed.length - skipped.length}/${
    results.length - skipped.length
  } passed${skipped.length === 0 ? "" : `, ${skipped.length} skipped`}`,
);
say("\n---- final assistant text ----");
say(String(finalItem?.item?.text ?? "(none)"));
process.exit(failed.length === 0 ? 0 : 1);
