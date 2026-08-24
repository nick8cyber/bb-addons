/**
 * Translation test with no quota cost: AGY_PATH points at fake-agy.mjs, which
 * replays the confirmed dialect with FOUR streamed chunks per turn. Proves the
 * bridge streams every chunk (a real one-token answer cannot show that), runs
 * two turns down one session, and accounts usage per turn.
 *
 * Usage: AGY_PATH=$PWD/fake-agy-shim node harness-fake.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = mkdtempSync(join(tmpdir(), "agy-fake-"));
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
const say = (...a) => originalWrite(`${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: workspace, tempDir: workspace });
const send = (m) => bridge.handleLine(JSON.stringify(m));
const pol = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};
const options = { model: "fake-model", ...pol };
const events = () =>
  messages.filter((m) => m.method === "thread/event").map((m) => m.params.event);

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (messages.some(predicate)) return;
    if (Date.now() > deadline) {
      process.stdout.write = originalWrite;
      say(`!!! timeout: ${label}`);
      for (const m of messages) say(JSON.stringify(m).slice(0, 300));
      process.exit(2);
    }
    await sleep(50);
  }
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, client: { name: "fake", version: "1" } } });
send({
  jsonrpc: "2.0",
  id: 2,
  method: "thread/start",
  params: { threadId: "t1", cwd: workspace, options, instructionMode: "append" },
});
await waitFor((m) => m.id === 2, 15_000, "thread/start");

for (const [id, creq] of [[3, "creq_aaaaaaaaaa"], [4, "creq_bbbbbbbbbb"]]) {
  send({
    jsonrpc: "2.0",
    id,
    method: "turn/start",
    params: {
      threadId: "t1",
      providerThreadId: "fake-conv-0001",
      input: [{ type: "text", text: "go", mentions: [] }],
      clientRequestId: creq,
      options,
    },
  });
  const want = id === 3 ? 1 : 2;
  await waitFor(
    (m) =>
      m.method === "thread/event" &&
      m.params.event.type === "turn/completed" &&
      events().filter((e) => e.type === "turn/completed").length >= want,
    15_000,
    `turn ${want} completed`,
  );
}

send({ jsonrpc: "2.0", id: 9, method: "thread/stop", params: { threadId: "t1", providerThreadId: "fake-conv-0001", intent: "release", activeTurnId: null } });
bridge.onClose?.();
process.stdout.write = originalWrite;

const all = events();
const deltas = all.filter((e) => e.type === "item/agentMessage/delta");
const settled = all.filter((e) => e.type === "item/completed");
const turns = all.filter((e) => e.type === "turn/completed");
const usage = all.filter((e) => e.type === "thread/tokenUsage/updated");
const starts = all.filter((e) => e.type === "item/started");

const checks = [
  ["stream/every-chunk-forwarded", deltas.length === 8, `${deltas.length} deltas: ${JSON.stringify(deltas.map((d) => d.delta))}`],
  ["stream/one-item-per-turn", starts.length === 2, `${starts.length} item/started`],
  ["item/settles-with-full-text", settled.every((e) => e.item.text === "alpha beta gamma delta"), JSON.stringify(settled.map((e) => e.item.text))],
  ["turn/two-turns-one-session", turns.length === 2 && new Set(turns.map((t) => t.scope.turnId)).size === 2, JSON.stringify(turns.map((t) => [t.status, t.scope.turnId]))],
  ["usage/total-cumulative", usage.length === 2 && usage[1].tokenUsage.total.totalTokens > usage[0].tokenUsage.total.totalTokens, JSON.stringify(usage.map((u) => u.tokenUsage.total.totalTokens))],
  ["usage/last-is-this-turn", usage.length === 2 && usage[1].tokenUsage.last.totalTokens < usage[1].tokenUsage.total.totalTokens, JSON.stringify(usage.map((u) => u.tokenUsage.last.totalTokens))],
  ["ordering/delta-before-settle", all.findIndex((e) => e.type === "item/agentMessage/delta") < all.findIndex((e) => e.type === "item/completed"), ""],
];

say("==== fake-agy translation report ====");
for (const [id, ok, detail] of checks) {
  say(`${ok ? "pass" : "FAIL"} ${id.padEnd(32)} ${detail}`);
}
const bad = checks.filter(([, ok]) => !ok).length;
say(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);
