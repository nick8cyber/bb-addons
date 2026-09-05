/**
 * Proves error text reaches the thread through every channel agy can carry
 * it — a failed tool step, a stderr banner, a turn-less ERROR result at
 * session start, and (residue) agy re-attaching a conversation's earlier
 * frozen quota rejection to later turns that actually answer — at no quota
 * cost. Five threads, five shapes (see fake-agy-errors.mjs).
 *
 * Usage: node harness-errors.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agy-errors-"));
const transcript = join(root, "stdin.ndjson");
writeFileSync(transcript, "");
const shim = join(root, "agy-shim");
const fake = new URL("./fake-agy-errors.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_FAKE_TRANSCRIPT = transcript;
const workspace = (mode) => {
  const dir = join(root, `ws-${mode}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const QUOTA =
  "⚠ Individual quota reached. Please upgrade your subscription to " +
  "increase your limits. Resets in 8m11s.";
const FRESH_QUOTA =
  "⚠ Individual quota reached. Please upgrade your subscription to " +
  "increase your limits. Resets in 4m2s.";

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

const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));
const pol = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const options = { model: "fake-model", ...pol };
const deltas = (threadId) =>
  messages
    .filter((m) => m.method === "thread/delta" && m.params.threadId === threadId)
    .flatMap((m) => m.params.deltas);
const errors = (threadId) =>
  deltas(threadId).filter((delta) => delta.kind === "provider.error");
const completed = (threadId) =>
  deltas(threadId).filter((delta) => delta.kind === "turn.boundary");

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      process.stdout.write = originalWrite;
      say(`!!! timeout: ${label}`);
      for (const m of messages) say(JSON.stringify(m).slice(0, 300));
      process.exit(2);
    }
    await sleep(50);
  }
}

let nextId = 10;
let creqSeq = 0;

async function start(mode) {
  const threadId = `t-${mode}`;
  send({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: 2, grammarVersions: [3, 3], client: { name: "fake", version: "1" } } });
  const startId = nextId++;
  process.env.AGY_FAKE_ERROR_MODE = mode;
  send({ jsonrpc: "2.0", id: startId, method: "thread/start", params: { threadId, cwd: workspace(mode), options, instructionMode: "append" } });
  await waitFor(() => messages.some((m) => m.id === startId), 15_000, `${mode}: thread/start`);
  return { threadId, startId, startMsg: messages.find((m) => m.id === startId) };
}

async function turn(threadId, text, ordinal) {
  const id = nextId++;
  send({
    jsonrpc: "2.0", id, method: "turn/start",
    params: {
      threadId, providerThreadId: "fake-conv-errors",
      input: [{ type: "text", text, mentions: [] }],
      clientRequestId: `creq_${"zyxwvutsrq".slice(0, 9)}${"zyxwvutsrq"[creqSeq++]}`,
      options,
    },
  });
  await waitFor(() => completed(threadId).length >= ordinal, 15_000, `${threadId}: turn ${ordinal}`);
}

function stop(threadId) {
  send({ jsonrpc: "2.0", id: nextId++, method: "thread/stop", params: { threadId, providerThreadId: "fake-conv-errors", intent: "release", activeTurnId: null } });
}

// tool mode: a failed tool step inside two turns that both succeed.
const tool = await start("tool");
await turn(tool.threadId, "one", 1);
await turn(tool.threadId, "two", 2);
stop(tool.threadId);

// stderr mode: the banner plus a benign warning on stderr, turn succeeds.
const stderr = await start("stderr");
await turn(stderr.threadId, "say hello", 1);
stop(stderr.threadId);

// noinit modes: the session is refused before any init, twice.
const noinit = await start("noinit-error");
const noinitNull = await start("noinit-error-null-status");

// residue mode: the genuine quota hit, then agy re-attaching the frozen text
// to answering turns, then a new countdown that must fail honestly.
const residue = await start("residue");
await turn(residue.threadId, "one", 1);
await turn(residue.threadId, "two", 2);
await turn(residue.threadId, "three", 3);
await turn(residue.threadId, "four", 4);
stop(residue.threadId);

bridge.onClose?.();
process.stdout.write = originalWrite;

const toolErrors = errors(tool.threadId);
const stderrErrors = errors(stderr.threadId);
const residueErrors = errors(residue.threadId);
const residueBoundaries = completed(residue.threadId);

const checks = [
  ["tool/step-error-reaches-thread", toolErrors.length === 2 && toolErrors.every((e) => e.message === QUOTA), JSON.stringify(toolErrors.map((e) => e.message)).slice(0, 120)],
  ["tool/error-is-thread-scoped", toolErrors.length === 2 && toolErrors.every((e) => e.threadScoped === true), ""],
  ["tool/error-categorized-rate-limit", toolErrors.length === 2 && toolErrors.every((e) => e.category === "rate-limit"), JSON.stringify(toolErrors[0]?.category ?? "")],
  ["tool/exactly-one-report-per-turn", toolErrors.length === 2, `${toolErrors.length} error rows for a twice-repeated step error over two turns`],
  ["tool/reported-again-on-the-next-turn", toolErrors.length === 2, `${toolErrors.length} error rows; the per-turn dedup must not cross turns`],
  ["tool/turns-complete-despite-the-error", completed(tool.threadId).length === 2 && completed(tool.threadId).every((t) => t.status === "completed"), JSON.stringify(completed(tool.threadId).map((t) => t.status))],
  ["stderr/banner-reaches-thread", stderrErrors.length === 1 && stderrErrors[0].message === QUOTA, JSON.stringify(stderrErrors.map((e) => e.message)).slice(0, 120)],
  ["stderr/error-scoped-and-categorized", stderrErrors.length === 1 && stderrErrors[0].threadScoped === true && stderrErrors[0].category === "rate-limit", ""],
  ["stderr/warning-line-is-not-a-thread-error", stderrErrors.length === 1, `${stderrErrors.length} error rows; the warning: line must add none`],
  ["stderr/turn-completes", completed(stderr.threadId).length === 1 && completed(stderr.threadId)[0].status === "completed", JSON.stringify(completed(stderr.threadId).map((t) => t.status))],
  ["noinit/session-refused-naming-the-cause", noinit.startMsg?.error !== undefined && typeof noinit.startMsg.error.message === "string" && noinit.startMsg.error.message.includes("shots fired"), JSON.stringify(noinit.startMsg?.error?.message ?? "").slice(0, 120)],
  ["noinit/nothing-emitted-before-identity", messages.filter((m) => m.method === "thread/delta" && m.params.threadId === noinit.threadId).length === 0, ""],
  ["noinit-null-status/session-refused-naming-the-cause", noinitNull.startMsg?.error !== undefined && typeof noinitNull.startMsg.error.message === "string" && noinitNull.startMsg.error.message.includes("shots fired"), JSON.stringify(noinitNull.startMsg?.error?.message ?? "").slice(0, 120)],
  ["all/no-start-failure-leaks-deltas", messages.filter((m) => m.method === "thread/delta" && (m.params.threadId === noinit.threadId || m.params.threadId === noinitNull.threadId)).length === 0, ""],
  ["residue/genuine-hit-surfaced-exactly-once", residueErrors.filter((e) => e.message === QUOTA).length === 1, JSON.stringify(residueErrors.map((e) => e.message))],
  ["residue/answering-turns-recover", residueBoundaries.length === 4 && residueBoundaries[1].status === "completed" && residueBoundaries[2].status === "completed", JSON.stringify(residueBoundaries.map((b) => b.status))],
  ["residue/its-first-turn-still-failed", residueBoundaries[0]?.status === "failed", JSON.stringify(residueBoundaries[0]?.status ?? "")],
  ["residue/a-fresh-countdown-still-fails-and-surfaces", residueBoundaries[3]?.status === "failed" && residueErrors.filter((e) => e.message === FRESH_QUOTA).length === 1, JSON.stringify(residueBoundaries[3] ?? "")],
];

say("==== error-surfacing report ====");
for (const [id, ok, detail] of checks) say(`${ok ? "pass" : "FAIL"} ${id.padEnd(42)} ${detail}`);
const bad = checks.filter(([, ok]) => !ok).length;
say(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);