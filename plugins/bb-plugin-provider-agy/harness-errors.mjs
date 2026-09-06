/**
 * Proves error text reaches the thread through every channel agy can carry
 * it — a failed tool step, a stderr banner, a turn-less ERROR result at
 * session start, (residue) agy re-attaching a conversation's earlier
 * frozen quota rejection to later turns that actually answer, and
 * (reject-then-exit) a genuine immediate reject whose ERROR result is
 * followed by the child exiting 1 without a raw exit banner added — plus the
 * quota auto-retry: a 2s-window reject whose queued re-run completes on a
 * rebuilt child (quota-retry), and a budget-exhaustion run where the retry
 * itself fails and settles honestly (quota-retry-always). Eight threads,
 * eight shapes (see fake-agy-errors.mjs).
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
// The quota auto-retry is OFF for the legacy scenarios: they prove the
// failure paths, and a scheduled re-run would sit behind a real timer. The
// dedicated quota-retry scenarios below re-enable it (short countdowns).
process.env.AGY_AUTO_RETRY_MAX = "0";
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
const QUOTA_SHORT =
  "⚠ Individual quota reached. Please upgrade your subscription to " +
  "increase your limits. Resets in 2s.";

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
const rateLimits = (threadId) =>
  deltas(threadId).filter((delta) => delta.kind === "provider.rateLimits");

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
// to answering turns; a no-reply turn with a new countdown must fail honestly,
// and a replying turn carrying that same new text must complete.
const residue = await start("residue");
await turn(residue.threadId, "one", 1);
await turn(residue.threadId, "two", 2);
await turn(residue.threadId, "three", 3);
await turn(residue.threadId, "four", 4);
await turn(residue.threadId, "five", 5);
stop(residue.threadId);

// reject-then-exit mode: the genuine immediate reject on a fresh child, where
// the child exits 1 right after its ERROR result -- the parsed quota text must
// be the only banner; the raw "agy exited" must not be layered on top of it.
// It also proves the native rate-limit snapshot: blocked with the "Resets in
// 8m11s." window opened onto the clock, then cleared once the account is
// plain old working again (the rebuild child answers a fresh turn).
const rejectExit = await start("reject-then-exit");
await turn(rejectExit.threadId, "one", 1);
await sleep(300);
process.env.AGY_FAKE_ERROR_MODE = "succeed";
await turn(rejectExit.threadId, "two", 2);
await sleep(200);
stop(rejectExit.threadId);

// quota-retry mode: the auto-retry itself. The first turn is refused with a
// 2s window and the child exits 1; the bridge must settle that turn failed,
// queue a retry turn behind the reset, sit out the window, rebuild the child
// on the SAME conversation (session/replaced, context intact), re-run the
// same prompt, and complete — one error row, blocked-then-allowed snapshots,
// and no raw exit banner anywhere.
delete process.env.AGY_AUTO_RETRY_MAX;
const retryCount = () =>
  messages.filter(
    (m) => m.method === "session/replaced" && m.params.threadId === "t-quota-retry",
  ).length;
const retry = await start("quota-retry");
{
  const id = nextId++;
  send({
    jsonrpc: "2.0", id, method: "turn/start",
    params: {
      threadId: retry.threadId, providerThreadId: "fake-conv-errors",
      input: [{ type: "text", text: "one", mentions: [] }],
      clientRequestId: `creq_${"zyxwvutsrq".slice(0, 9)}${"zyxwvutsrq"[creqSeq++ % 10]}`, options,
    },
  });
  await waitFor(
    () => {
      const bs = completed(retry.threadId);
      return bs.length >= 2 && bs[1].status === "completed";
    },
    30_000,
    "quota-retry: re-run completes",
  );
  await waitFor(() => retryCount() >= 1, 5_000, "quota-retry: session/replaced");
  await sleep(200);
  stop(retry.threadId);
}

// quota-retry-always mode: the budget path. Every child refuses, so the one
// permitted retry must run, fail, and settle honestly — no third child, no
// completed boundary, and the exit banner still suppressed.
process.env.AGY_AUTO_RETRY_MAX = "1";
const alwaysReplaced = () =>
  messages.filter(
    (m) =>
      m.method === "session/replaced" &&
      m.params.threadId === "t-quota-retry-always",
  ).length;
const always = await start("quota-retry-always");
{
  const id = nextId++;
  send({
    jsonrpc: "2.0", id, method: "turn/start",
    params: {
      threadId: always.threadId, providerThreadId: "fake-conv-errors",
      input: [{ type: "text", text: "one", mentions: [] }],
      clientRequestId: `creq_${"zyxwvutsrq".slice(0, 9)}${"zyxwvutsrq"[creqSeq++ % 10]}`, options,
    },
  });
  await waitFor(() => completed(always.threadId).length >= 2, 30_000, "quota-retry-always: both failures settle");
  await sleep(300);
  stop(always.threadId);
}

bridge.onClose?.();
process.stdout.write = originalWrite;

const toolErrors = errors(tool.threadId);
const stderrErrors = errors(stderr.threadId);
const residueErrors = errors(residue.threadId);
const residueBoundaries = completed(residue.threadId);
const rejectErrors = errors(rejectExit.threadId);
const rejectBoundaries = completed(rejectExit.threadId);
const rejectLimits = rateLimits(rejectExit.threadId);
const resetAt = rejectLimits[0]?.rateLimits?.windows?.[0]?.resetsAtMs ?? null;
const retryErrors = errors(retry.threadId);
const retryBoundaries = completed(retry.threadId);
const retryLimits = rateLimits(retry.threadId);
const alwaysErrors = errors(always.threadId);
const alwaysBoundaries = completed(always.threadId);
const retryRawExits = (tid) =>
  errors(tid).filter((e) => e.message.includes("exited"));

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
  ["residue/genuine-hit-surfaced-once", residueErrors.filter((e) => e.message === QUOTA).length === 1, JSON.stringify(residueErrors.map((e) => e.message))],
  ["residue/answering-turns-recover", residueBoundaries.length === 5 && residueBoundaries[1].status === "completed" && residueBoundaries[2].status === "completed", JSON.stringify(residueBoundaries.map((b) => b.status))],
  ["residue/its-first-turn-still-failed", residueBoundaries[0]?.status === "failed", JSON.stringify(residueBoundaries[0]?.status ?? "")],
  ["residue/no-reply-new-countdown-still-fails-and-surfaces", residueBoundaries[3]?.status === "failed" && residueErrors.filter((e) => e.message === FRESH_QUOTA).length === 1, JSON.stringify(residueBoundaries[3]?.error?.message ?? "")],
  ["residue/reply-with-the-new-text-completes", residueBoundaries[4]?.status === "completed" && residueErrors.filter((e) => e.message === FRESH_QUOTA).length === 1, JSON.stringify(residueBoundaries.map((b) => b.status))],
  ["reject-exit/parsed-quota-surfaced-once", rejectErrors.filter((e) => e.message === QUOTA).length === 1, JSON.stringify(rejectErrors.map((e) => e.message))],
  ["reject-exit/turn-failed-with-the-quota-text", rejectBoundaries[0]?.status === "failed" && rejectBoundaries[0]?.error?.message === QUOTA, JSON.stringify(rejectBoundaries[0] ?? "")],
  ["reject-exit/raw-exit-banner-suppressed", rejectErrors.filter((e) => e.message.includes("exited")).length === 0, JSON.stringify(rejectErrors.map((e) => e.message))],
  ["reject-exit/native-error-coded-429", rejectErrors.length === 1 && rejectErrors[0]?.errorInfo?.category === "rate-limit" && rejectErrors[0]?.errorInfo?.httpStatusCode === 429 && rejectErrors[0]?.errorInfo?.providerCode === null, JSON.stringify(rejectErrors[0]?.errorInfo ?? "")],
  ["reject-exit/blocked-snapshot-with-reset-time", rejectLimits.length === 2 && rejectLimits[0]?.rateLimits?.status === "blocked" && rejectLimits[0]?.rateLimits?.kind === "subscription-window" && rejectLimits[0]?.rateLimits?.reachedReason === QUOTA && resetAt !== null && resetAt > Date.now() - 60_000 && resetAt < Date.now() + 9 * 60_000, JSON.stringify(rejectLimits[0]?.rateLimits ?? "")],
  ["reject-exit/allowed-after-recovery", rejectLimits.length === 2 && rejectLimits[1]?.rateLimits?.status === "allowed" && rejectBoundaries[1]?.status === "completed", JSON.stringify(rejectLimits.map((r) => r?.rateLimits?.status))],
  ["retry/failed-turn-settles-honestly", retryBoundaries[0]?.status === "failed" && retryBoundaries[0]?.error?.message === QUOTA_SHORT, JSON.stringify(retryBoundaries[0] ?? "")],
  ["retry/re-run-completes", retryBoundaries.length === 2 && retryBoundaries[1]?.status === "completed", JSON.stringify(retryBoundaries.map((b) => b.status))],
  ["retry/session-replaced-before-the-spawn", retryCount() === 1, `${retryCount()} session/replaced`],
  ["retry/one-error-row-no-exit-banner", retryErrors.length === 1 && retryErrors[0].message === QUOTA_SHORT && retryRawExits(retry.threadId).length === 0, JSON.stringify(retryErrors.map((e) => e.message))],
  ["retry/blocked-then-allowed", retryLimits.length === 2 && retryLimits[0]?.rateLimits?.status === "blocked" && retryLimits[1]?.rateLimits?.status === "allowed", JSON.stringify(retryLimits.map((r) => r?.rateLimits?.status))],
  ["retry/same-prompt-re-run", messages.some((m) => m.method === "session/replaced" && m.params.threadId === retry.threadId), ""],
  ["always/second-attempt-fails-honestly", alwaysBoundaries.length === 2 && alwaysBoundaries[0]?.status === "failed" && alwaysBoundaries[1]?.status === "failed" && alwaysBoundaries[1]?.error?.message === QUOTA_SHORT, JSON.stringify(alwaysBoundaries.map((b) => b.status))],
  ["always/retry-ran-exactly-once", alwaysReplaced() === 1, `${alwaysReplaced()} session/replaced`],
  ["always/no-completed-boundary", alwaysBoundaries.every((b) => b.status === "failed"), JSON.stringify(alwaysBoundaries.map((b) => b.status))],
  ["always/no-exit-banner", alwaysErrors.length === 2 && alwaysErrors.every((e) => e.message === QUOTA_SHORT) && retryRawExits(always.threadId).length === 0, JSON.stringify(alwaysErrors.map((e) => e.message))],
];

say("==== error-surfacing report ====");
for (const [id, ok, detail] of checks) say(`${ok ? "pass" : "FAIL"} ${id.padEnd(42)} ${detail}`);
const bad = checks.filter(([, ok]) => !ok).length;
say(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);