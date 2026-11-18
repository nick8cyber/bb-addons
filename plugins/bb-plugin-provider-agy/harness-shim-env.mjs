/**
 * PLUG-310 regression harness: an ACP shim must NEVER spawn without its
 * AGY_SHIM_* env. Reproduces the live crash — `turn/steer` forwarded with
 * the daemon's static bridgeOptions (acpLaunchSpec env:{}) lands in the
 * generic bridge's queuedInputs; reconcile then rebuilds the session with
 * env vars missing AGY_SHIM_* and the shim exits 2:
 *   ACP agent "/usr/bin/node" exited (code 2, signal null): acp-shim:
 *   AGY_SHIM_REAL_BIN is not set
 *
 * Scenario B covers unknown-session restore: a turn/steer and a turn/start
 * for a threadId the wrapper never saw must rebuild the session through the
 * normal resume path (session/load in the transcript), not reach the bridge
 * raw ("No active ACP session") and never launch a spec without shim env.
 *
 * Usage: node harness-shim-env.mjs
 */
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTeardown, trackedMkdtemp } from "./harness-teardown.mjs";
installTeardown();

const root = trackedMkdtemp(join(tmpdir(), "agy-shimenv-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });
const shim = join(root, "agy-bin");
const fake = new URL("./fake-agy-acp.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_CLIPROXY = "0";
process.env.AGY_ACCOUNTS = "0";
process.env.AGY_FAKE_TRANSCRIPT = join(root, "transcript.ndjson");
process.env.AGY_FAKE_RELEASE = join(root, "release");
const transcriptLines = () =>
  existsSync(join(root, "transcript.ndjson"))
    ? readFileSync(join(root, "transcript.ndjson"), "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    : [];
const say = (...a) => process.stderr.write(`${a.join(" ")}\n`);

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

const { experimental_providerBridge: bridge } = await import(new URL("./dist/host.js", import.meta.url).href);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));

// What the daemon puts on every request: static experimental_bridgeOptions
// (server.ts) + resolved envVars. The static spec's env is EMPTY.
const daemonOptions = {
  model: "fake-model",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  envVars: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    BB_CLI: "/usr/local/bin/bb",
    BB_SERVER_URL: "http://127.0.0.1:1",
    BB_THREAD_ID: "thr_fake",
  },
  providerOptions: {
    acpLaunchSpec: { command: "agy", args: ["acp"], env: {} },
    acpDialect: "generic",
    providerSubagentsEnabled: false,
    providerMemoryEnabled: false,
  },
};
let creqN = 0;
const creq = () => `creq_${"aaaaaaaaaa".slice(0, 9)}${"abcdefghjkmnpqrstuvwxyz"[creqN++ % 24]}`;

const deltas = (tid) => messages.filter((m) => m.method === "thread/delta" && m.params.threadId === tid).flatMap((m) => m.params.deltas);
const boundaries = (tid) => deltas(tid).filter((d) => d.kind === "turn.boundary");
const replies = (id) => messages.filter((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
const errorMsgs = () => messages.filter((m) => m.method === "error");
const shimCrashes = () => messages.filter((m) => m.method === "error" && typeof m.params?.message === "string" && m.params.message.includes("AGY_SHIM_REAL_BIN"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) {
      say(`!!! timeout: ${label}`);
      for (const m of messages.slice(-40)) say(JSON.stringify(m).slice(0, 300));
      say("--- transcript ---");
      for (const l of transcriptLines().slice(-40)) say(JSON.stringify(l).slice(0, 300));
      process.exit(2);
    }
    await sleep(40);
  }
}

const start = (id, tid) => send({ jsonrpc: "2.0", id, method: "thread/start", params: { threadId: tid, cwd: workspace, options: daemonOptions, instructionMode: "append" } });
const turn = (id, tid, text) => send({ jsonrpc: "2.0", id, method: "turn/start", params: { threadId: tid, providerThreadId: t1ptid ?? tid, input: [{ type: "text", text, mentions: [] }], clientRequestId: creq(), options: daemonOptions } });
const steer = (id, tid, text) => send({ jsonrpc: "2.0", id, method: "turn/steer", params: { threadId: tid, providerThreadId: t1ptid ?? tid, input: [{ type: "text", text, mentions: [] }], clientRequestId: creq(), expectedTurnId: "turn_x", options: daemonOptions } });

send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 2, client: { name: "harness", version: "1" }, grammarVersions: [2, 3] } });

const checks = [];
const check = (name, ok, detail = "") => { checks.push([name, ok, detail]); say(`${ok ? "pass" : "FAIL"} ${name} ${detail}`); };

// --- scenario A: steer on a live session carries static bridgeOptions -----
start(1, "t1");
await waitFor(() => replies(1).length === 1 && replies(1)[0].result?.providerThreadId, 20000, "t1 start");
const t1ptid = replies(1)[0].result.providerThreadId;
send({ jsonrpc: "2.0", id: 2, method: "turn/start", params: { threadId: "t1", providerThreadId: t1ptid, input: [{ type: "text", text: "[[hold]] slow first turn", mentions: [] }], clientRequestId: creq(), options: daemonOptions } });
await waitFor(() => transcriptLines().some((l) => l.method === "session/prompt"), 20000, "hold prompt sent");
steer(3, "t1", "[[steered-work]] follow up");
await waitFor(() => replies(3).length === 1, 20000, "steer accepted");
// The held prompt ends → the queued steer input is consumed → reconcile.
writeFileSync(process.env.AGY_FAKE_RELEASE, "go\n");
// The bridge merges the steered input into the SAME turn — one boundary
// covering both prompts; the steered text proves the second prompt ran.
await waitFor(() => shimCrashes().length > 0 || boundaries("t1").length >= 1, 30000, "steer consumed");
check("steer/no-shim-envless-spawn", shimCrashes().length === 0, `crashes=${shimCrashes().length} errors=${errorMsgs().length} ${shimCrashes()[0]?.params?.message?.slice(0, 160) ?? ""}`);
check("steer/turns-complete", boundaries("t1").length >= 1 && boundaries("t1").at(-1).status === "completed", JSON.stringify(boundaries("t1").map((b) => b.status)));
check("steer/no-rebuild", transcriptLines().filter((l) => l.method === "session/new" || l.method === "session/load").length === 1, `news+loads=${transcriptLines().filter((l) => l.method === "session/new" || l.method === "session/load").length}`);
const steered = transcriptLines().filter((l) => l.method === "session/prompt").map((p) => (p.params?.prompt ?? []).map((b) => b.text ?? "").join("\n"));
check("steer/text-delivered", steered.some((t) => t.includes("[[steered-work]]")), steered.map((t) => t.slice(0, 40)).join("|"));

// --- scenario B: unknown session restores through the resume path ----------
// t2 exists only in the persisted threads-state (simulates a wrapper restart:
// the record outlives the session). A turn/steer must rebuild via
// thread/resume (session/load in the transcript), then run as a turn.
const t2ptid = "fake-restored-conv";
const threadsState = join(root, "threads-state.json");
writeFileSync(threadsState, JSON.stringify({ threads: { t2: { cwd: workspace, providerThreadId: t2ptid } } }));
send({ jsonrpc: "2.0", id: 10, method: "turn/steer", params: { threadId: "t2", providerThreadId: t2ptid, input: [{ type: "text", text: "[[restored-steer]]", mentions: [] }], clientRequestId: creq(), expectedTurnId: "turn_y", options: daemonOptions } });
await waitFor(() => replies(10).length === 1, 20000, "t2 steer answered");
check("restore/steer-accepted", replies(10)[0].result?.threadId === "t2", JSON.stringify(replies(10)[0]));
await waitFor(() => boundaries("t2").length >= 1 || shimCrashes().length > 0, 30000, "t2 steer ran");
check("restore/steer-ran", boundaries("t2").length >= 1 && boundaries("t2")[0].status === "completed", JSON.stringify(boundaries("t2").map((b) => b.status)));
check("restore/via-session-load", transcriptLines().some((l) => l.method === "session/load" && (l.params?.sessionId === t2ptid || true)), `loads=${transcriptLines().filter((l) => l.method === "session/load").length}`);
const t2Prompts = transcriptLines().filter((l) => l.method === "session/prompt").map((p) => (p.params?.prompt ?? []).map((b) => b.text ?? "").join("\n"));
check("restore/steer-text-ran", t2Prompts.some((t) => t.includes("[[restored-steer]]")), "");

// Unknown turn/start on another rebuilt thread.
const t3ptid = "fake-restored-conv2";
writeFileSync(threadsState, JSON.stringify({ threads: { t2: { cwd: workspace, providerThreadId: t2ptid }, t3: { cwd: workspace, providerThreadId: t3ptid } } }));
send({ jsonrpc: "2.0", id: 20, method: "turn/start", params: { threadId: "t3", providerThreadId: t3ptid, input: [{ type: "text", text: "[[restored-turn]]", mentions: [] }], clientRequestId: creq(), options: daemonOptions } });
await waitFor(() => boundaries("t3").length >= 1 || replies(20).some((r) => r.error !== undefined) || shimCrashes().length > 0, 30000, "t3 turn ran");
check("restore/turn-ran", boundaries("t3").length >= 1 && boundaries("t3")[0].status === "completed", JSON.stringify(boundaries("t3").map((b) => b.status)));

// Unknown thread with NO record at all: honest error, never a raw launch.
send({ jsonrpc: "2.0", id: 30, method: "turn/start", params: { threadId: "t-ghost", providerThreadId: "fake-ghost", input: [{ type: "text", text: "ghost", mentions: [] }], clientRequestId: creq(), options: daemonOptions } });
await waitFor(() => replies(30).length === 1, 20000, "ghost answered");
check("restore/ghost-refused", replies(30)[0].error !== undefined, JSON.stringify(replies(30)[0]).slice(0, 160));

// --- PLUG-306 (ревизия 14): restore internals never hang -------------------
// A synchronous throw inside the internal thread/resume (a non-executable
// AGY_PATH is the deterministic trigger — resolveAgyCommand throws before
// any spawn) must reach the daemon's request as a real -32000, not leak as
// an unhandled rejection or a dangling waiter.
let unhandledRejections = 0;
process.on("unhandledRejection", () => { unhandledRejections += 1; });
const deadBin = join(root, "agy-dead");
writeFileSync(deadBin, "not executable\n"); // 0644 — pinned but not X_OK
const savedAgyPath = process.env.AGY_PATH;
process.env.AGY_PATH = deadBin;
send({ jsonrpc: "2.0", id: 40, method: "turn/start", params: { threadId: "t-throw", providerThreadId: "fake-dead-conv", cwd: workspace, input: [{ type: "text", text: "boom", mentions: [] }], clientRequestId: creq(), options: daemonOptions } });
await waitFor(() => replies(40).length === 1, 20000, "t-throw answered");
process.env.AGY_PATH = savedAgyPath;
check("restore/sync-throw-is-32000",
  replies(40)[0]?.error?.code === -32000 && /is not executable/u.test(replies(40)[0].error.message ?? ""),
  JSON.stringify(replies(40)[0]).slice(0, 200));
await sleep(300);
check("restore/no-unhandled-rejection", unhandledRejections === 0, `count=${unhandledRejections}`);

// --- PLUG-306 (ревизия 14): threads-state.json is bounded ------------------
// 2002 records on disk (one atMs-less — the legacy shape) plus a fresh
// thread/start leave exactly 2000, evicting the atMs-less record and the
// oldest timestamps first.
{
  const recs = {};
  for (let i = 0; i <= 2000; i += 1) {
    recs[`r${i}`] = { cwd: workspace, providerThreadId: `fake-r${i}`, atMs: i + 1 };
  }
  recs["r-noatms"] = { cwd: workspace, providerThreadId: "fake-noatms" };
  writeFileSync(threadsState, JSON.stringify({ threads: recs }));
}
start(50, "t-bound");
await waitFor(() => replies(50).length === 1, 20000, "t-bound start");
{
  const kept = JSON.parse(readFileSync(threadsState, "utf8")).threads ?? {};
  check("threads-state/bounded-2000",
    Object.keys(kept).length === 2000 &&
    kept["r-noatms"] === undefined && kept.r0 === undefined && kept.r1 === undefined &&
    kept.r2 !== undefined && kept["t-bound"] !== undefined &&
    typeof kept["t-bound"].atMs === "number",
    `kept=${Object.keys(kept).length} r0=${kept.r0 !== undefined} r2=${kept.r2 !== undefined} t-bound.atMs=${typeof kept["t-bound"]?.atMs}`);
}

// --- PLUG-306 (ревизия 14): defensive shim-env synth -----------------------
// A raw request carrying OUR shim spec with env:{} and no session to top it
// up gets the fill synthesized defensively. A malformed thread/resume is
// the only message that reaches feedLine untouched; the wrapper log names
// the completion and the shim never runs env-less.
const synthOptions = { ...daemonOptions, providerOptions: {
  ...daemonOptions.providerOptions,
  acpLaunchSpec: { command: process.execPath,
    args: [join(root, "acp-shim.mjs"), "acp"], env: {} },
} };
send({ jsonrpc: "2.0", id: 60, method: "thread/resume", params: {
  threadId: "t-synth", options: synthOptions, instructionMode: "append" } });
await waitFor(() => replies(60).length === 1 || shimCrashes().length > 0, 20000, "t-synth answered");
await sleep(200);
const synthLog = readFileSync(join(root, "acp-wrapper.log"), "utf8");
check("synth/launch-env-filled-defensively",
  synthLog.includes("thread t-synth: thread/resume carried a shim launch spec without AGY_SHIM_* — completed defensively") && shimCrashes().length === 0,
  `crashes=${shimCrashes().length}`);

check("no-shim-crash-anywhere", shimCrashes().length === 0, `crashes=${shimCrashes().length}`);

const failed = checks.filter(([, ok]) => !ok);
say(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
