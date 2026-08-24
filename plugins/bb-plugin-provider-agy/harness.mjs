/**
 * Offline harness: drives the BUILT bridge artifact (dist/host.js) in-process
 * through the protocol rules the v1 conformance kit checks, plus one real agy
 * turn. The published SDK 0.4.8 does not ship the conformance kit (it lands in
 * 0.4.16 as @get-bb/plugin-sdk/provider-bridge/testing), so the scenarios are
 * reimplemented here against the same rule names.
 *
 * Usage: node harness.mjs <model>
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const results = [];
const check = (id, ok, detail = "") =>
  results.push({ id, status: ok ? "pass" : "FAIL", detail });

const responseFor = (id) => messages.find((m) => m.id === id);
const events = () =>
  messages.filter((m) => m.method === "thread/event").map((m) => m.params);
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
  params: { protocolVersion: 1, client: { name: "harness", version: "1.0.0" } },
});
const handshake = responseFor("init")?.result;
check(
  "handshake/initialize",
  handshake?.protocolVersion === 1 && handshake?.capabilities !== undefined,
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
const firstEventIndex = messages.findIndex((m) => m.method === "thread/event");
check(
  "ordering/identity-precedes-events",
  identityIndex !== -1 && (firstEventIndex === -1 || identityIndex < firstEventIndex),
  `identity@${identityIndex} firstEvent@${firstEventIndex}`,
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
  (m) => m.method === "thread/event" && m.params.event.type === "turn/completed",
  120_000,
  "turn/completed",
);

const turnEvents = events().map((p) => p.event);
const accepted = turnEvents.find((e) => e.type === "turn/input/accepted");
const started = turnEvents.find((e) => e.type === "turn/started");
const completed = turnEvents.find((e) => e.type === "turn/completed");
check(
  "turn/lifecycle",
  accepted?.clientRequestId === "creq_abcdefghij" &&
    started !== undefined &&
    completed?.status === "completed" &&
    accepted.scope.turnId === completed.scope.turnId,
  `accepted=${Boolean(accepted)} started=${Boolean(started)} status=${completed?.status}`,
);

const itemStartedIdx = turnEvents.findIndex((e) => e.type === "item/started");
const firstDeltaIdx = turnEvents.findIndex(
  (e) => e.type === "item/agentMessage/delta",
);
const deltas = turnEvents.filter((e) => e.type === "item/agentMessage/delta");
check(
  "item/opens-before-delta",
  itemStartedIdx !== -1 && firstDeltaIdx > itemStartedIdx,
  `started@${itemStartedIdx} delta@${firstDeltaIdx}`,
);
check(
  "stream/deltas-arrive",
  deltas.length > 0,
  `${deltas.length} deltas: ${JSON.stringify(deltas.map((d) => d.delta))}`,
);
const finalItem = turnEvents.findLast?.((e) => e.type === "item/completed");
check(
  "item/settles-with-text",
  typeof finalItem?.item?.text === "string" && finalItem.item.text.length > 0,
  JSON.stringify(finalItem?.item?.text),
);
const usageEvent = turnEvents.find((e) => e.type === "thread/tokenUsage/updated");
check(
  "usage/reported",
  usageEvent?.tokenUsage?.total?.totalTokens > 0,
  JSON.stringify(usageEvent?.tokenUsage?.total),
);
check(
  "events/schema-valid",
  turnEvents.every((e) => typeof e.type === "string" && typeof e.threadId === "string"),
);

// --- steer refusal --------------------------------------------------------
send({
  jsonrpc: "2.0",
  id: "steer",
  method: "turn/steer",
  params: {
    threadId,
    providerThreadId,
    input: [{ type: "text", text: "nope", mentions: [] }],
    clientRequestId: "creq_bcdefghijk",
    expectedTurnId: completed?.scope?.turnId ?? "x",
    options,
  },
});
check(
  "steer/typed-refusal",
  responseFor("steer")?.error?.code === -32001,
  JSON.stringify(responseFor("steer")?.error?.code),
);

// --- release stop fabricates nothing -------------------------------------
const beforeStop = events().length;
send({
  jsonrpc: "2.0",
  id: "stop",
  method: "thread/stop",
  params: { threadId, providerThreadId, intent: "release", activeTurnId: null },
});
const afterStop = events().slice(beforeStop).map((p) => p.event);
check(
  "stop/release-not-interrupted",
  responseFor("stop")?.result !== undefined &&
    !afterStop.some(
      (e) => e.type === "turn/completed" && e.status === "interrupted",
    ),
  JSON.stringify(afterStop.map((e) => e.type)),
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
  say(`${r.status.padEnd(4)} ${r.id.padEnd
    ? r.id.padEnd(34) : r.id}  ${r.detail}`);
}
const failed = results.filter((r) => r.status !== "pass");
say(`\n${results.length - failed.length}/${results.length} passed`);
say("\n---- final assistant text ----");
say(String(finalItem?.item?.text ?? "(none)"));
process.exit(failed.length === 0 ? 0 : 1);
