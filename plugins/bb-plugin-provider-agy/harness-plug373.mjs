/**
 * PLUG-373: the empty-spawn blind zone. Two deaths that used to leave a
 * hanging, unanswered daemon request and an empty acp-wrapper.log:
 *
 *   A) A shim whose child dies before session init while the generic bridge
 *      still holds the resume open (fake agy hangs forever; a forged
 *      shim-shutdown side-channel event plays the child's early exit). The
 *      pending request must get an honest -32000 with the stderr tail, and
 *      the bridge's own late answer must be swallowed, never duplicated.
 *   B) A real early exit: the fake agy writes a license-style line to stderr
 *      and exits 1 on `acp`. Whichever layer answers first, the daemon sees
 *      exactly one error response, the journal carries the shim-down line,
 *      and the child's stderr is readable in the per-spawn file.
 *   C) The request-receipt journal line: every lifecycle request logs
 *      `request <method> id=.. thread=..` before any handling — a line that
 *      separates "never reached the wrapper" from "died inside it".
 *
 * Usage: node harness-plug373.mjs
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTeardown, trackedMkdtemp } from "./harness-teardown.mjs";
installTeardown();

const root = trackedMkdtemp(join(tmpdir(), "agy-plug373-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });

// Fake A: hangs forever — the bridge's resume stays open so the forged
// shim-shutdown event is the only thing that can answer it.
const fakeHang = join(root, "agy-hang");
writeFileSync(
  fakeHang,
  `#!/bin/sh\nexec /usr/bin/node -e "process.stdin.on('data',()=>{});setInterval(()=>{},1e5)"\n`,
);
chmodSync(fakeHang, 0o755);
// Fake B: license/quota-style early exit — the production failure shape.
const fakeDie = join(root, "agy-die");
writeFileSync(
  fakeDie,
  `#!/bin/sh\necho "fake-license-error: quota exhausted; upgrade your subscription" >&2\nexit 1\n`,
);
chmodSync(fakeDie, 0o755);

process.env.AGY_PATH = fakeHang;
process.env.AGY_CLIPROXY = "0";
process.env.AGY_ACCOUNTS = "0"; // direct mode — the pool is not under test
delete process.env.AGY_TRANSPORT; // ACP wrapper is the default transport

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
const options = { model: "fake-model", permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const replies = (id) => messages.filter((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
const logText = () =>
  existsSync(join(root, "acp-wrapper.log")) ? readFileSync(join(root, "acp-wrapper.log"), "utf8") : "";
const shimDirFiles = () =>
  existsSync(join(root, "acp-shim")) ? readdirSync(join(root, "acp-shim")) : [];
const nonceOf = (threadId) => {
  const ctl = shimDirFiles().find((f) => f.startsWith(`ctl-${threadId}-`) && f.endsWith(".ndjson"));
  return ctl ? ctl.slice(`ctl-${threadId}-`.length, -".ndjson".length) : null;
};

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
      for (const m of messages.slice(-30)) say(JSON.stringify(m).slice(0, 300));
      say("--- acp-wrapper.log ---");
      say(logText());
      process.exit(2);
    }
    await sleep(25);
  }
}

// --- C: receipt line for a request that can never spawn ------------------
send({
  jsonrpc: "2.0",
  id: "ghost",
  method: "turn/start",
  params: {
    threadId: "t_ghost",
    input: [{ type: "text", text: "hello", mentions: [] }],
    options,
  },
});
await waitFor(() => replies("ghost").length === 1, 15_000, "unknown-thread turn/start answered");
check(
  "receipt/request-logged",
  /request turn\/start id=ghost thread=t_ghost/.test(logText()),
  "",
);
check(
  "ghost/honest-error",
  replies("ghost")[0]?.error !== undefined &&
    String(replies("ghost")[0].error.message).includes("no live session"),
  JSON.stringify(replies("ghost")[0]?.error).slice(0, 200),
);

// --- A: forged early death while the bridge still waits ------------------
send({
  jsonrpc: "2.0",
  id: "r1",
  method: "thread/resume",
  params: {
    threadId: "t_die",
    cwd: workspace,
    providerThreadId: "prov_hang",
    options,
    instructionMode: "append",
  },
});
check(
  "receipt/resume-logged",
  /request thread\/resume id=r1 thread=t_die resume=prov_hang/.test(logText()),
  "",
);
await waitFor(() => nonceOf("t_die") !== null, 15_000, "shim launch (control file)");
await waitFor(() => replies("r1").length === 0, 3_000, "resume stays open on the hung fake");
check("hang/resume-still-pending", replies("r1").length === 0, "hung fake must not answer");

// Play the child's early exit through the real side channel.
appendFileSync(
  join(root, "acp-shim", "events.ndjson"),
  `${JSON.stringify({
    nonce: nonceOf("t_die"),
    threadId: "t_die",
    t: "shim-shutdown",
    reason: "child-close",
    exit: 1,
    sessionId: null,
    spawnError: null,
    stderr: "Individual quota reached. fake early exit.",
  })}\n`,
);
await waitFor(() => replies("r1").length === 1, 15_000, "synthesized early-exit error");
const r1 = replies("r1")[0];
check(
  "early-exit/error-delivered",
  r1?.error !== undefined &&
    /exited before the session was ready/.test(String(r1.error.message)) &&
    /quota/.test(String(r1.error.message)),
  JSON.stringify(r1?.error).slice(0, 300),
);
await waitFor(() => /shim down on thread t_die: child-close exit=1/.test(logText()), 10_000, "shim-down journal line");
check(
  "early-exit/journal-lines",
  /answered with early-exit error/.test(logText()) &&
    /Individual quota reached/.test(logText()),
  "",
);

// The bridge's own answer for r1 arrives when the hung shim is stopped —
// it must be swallowed, not sent as a second response.
send({
  jsonrpc: "2.0",
  id: "stop1",
  method: "thread/stop",
  params: { threadId: "t_die", providerThreadId: "prov_hang", intent: "release", activeTurnId: null },
});
await sleep(3_000);
check(
  "early-exit/no-duplicate-answer",
  replies("r1").length === 1,
  `${replies("r1").length} answers for r1`,
);
check(
  "early-exit/late-answer-swallowed",
  /swallowed (duplicate resume answer|late bridge answer)/.test(logText()) ||
    replies("r1").length === 1,
  "",
);

// --- B: a real early exit — stderr file + one honest error ---------------
process.env.AGY_PATH = fakeDie;
send({
  jsonrpc: "2.0",
  id: "r2",
  method: "thread/resume",
  params: {
    threadId: "t_die2",
    cwd: workspace,
    providerThreadId: "prov_die",
    options,
    instructionMode: "append",
  },
});
await waitFor(() => replies("r2").length === 1, 20_000, "real early-exit answered");
const r2 = replies("r2")[0];
check(
  "real-exit/error-not-empty",
  r2?.error !== undefined && String(r2.error.message).trim().length > 0,
  JSON.stringify(r2?.error).slice(0, 300),
);
await sleep(3_000);
check(
  "real-exit/no-duplicate-answer",
  replies("r2").length === 1,
  `${replies("r2").length} answers for r2`,
);
await waitFor(
  () => shimDirFiles().some((f) => f.startsWith("stderr-t_die2-") && f.endsWith(".log")),
  10_000,
  "per-spawn stderr file",
);
const stderrFile = shimDirFiles().find((f) => f.startsWith("stderr-t_die2-") && f.endsWith(".log"));
const stderrText = stderrFile ? readFileSync(join(root, "acp-shim", stderrFile), "utf8") : "";
check(
  "real-exit/stderr-captured",
  /fake-license-error/.test(stderrText),
  stderrFile ?? "no stderr file",
);
await waitFor(
  () => /shim down on thread t_die2: child-close exit=1/.test(logText()),
  10_000,
  "shim-down journal line for the real exit",
);
check(
  "real-exit/journal-stderr-tail",
  /fake-license-error/.test(logText()),
  "",
);

send({
  jsonrpc: "2.0",
  id: "stop2",
  method: "thread/stop",
  params: { threadId: "t_die2", providerThreadId: "prov_die", intent: "release", activeTurnId: null },
});
bridge.onClose?.();
process.stdout.write = originalWrite;

say("==== plug-373 early-exit report ====");
for (const r of results) {
  say(`${r.status.padEnd(4)} ${r.id.padEnd(42)} ${r.detail}`);
}
const bad = results.filter((r) => r.status !== "pass").length;
say(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad === 0 ? 0 : 1);
