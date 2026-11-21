/**
 * PLUG-373: the empty-spawn blind zone, pass 2 — the early-exit contract
 * against the REAL failure shapes:
 *
 *   C)  Request-receipt journal: every lifecycle request logs
 *       `request <method> id=.. thread=..` before any handling.
 *   A)  Real early exit (direct): fake agy writes a license line to stderr
 *       and exits 1 on `acp`. The generic bridge answers inside the grace
 *       window — the daemon must see the BRIDGE's error (stderr tail
 *       included), not the synthesized "exited before the session was
 *       ready" text, exactly once; the per-spawn stderr file survives.
 *   B)  Synthesis fallback (direct): a forged shim-shutdown event with a
 *       still-pending request and a hung fake (bridge never answers on its
 *       own). After the grace window the wrapper synthesizes -32000 with
 *       the stderr tail; the bridge's late answer is swallowed.
 *   D)  Pool classification (the pass-1 blocker): account p1 dies at spawn
 *       with "Verify your account to continue" on stderr. The bridge's
 *       answer inside grace must drive the refusal classification —
 *       p1 parks (validation-required) and the thread lands on sibling p2.
 *   E)  stderr-file lifecycle: a stale stderr-*.log is swept at bridge
 *       start; a live shim's own file is deleted on orderly shutdown
 *       (stdin-eof) but kept on child-close (direct shim spawn, no bridge).
 *   F)  macOS stderr race (pool): the bridge's in-window answer carries a
 *       bare exit error — the refusal text survives only in the shutdown
 *       event's tail. The glued classification must still park q1
 *       (validation-required) and land the thread on q2.
 *
 * Usage: node harness-plug373.mjs
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTeardown, trackedMkdtemp } from "./harness-teardown.mjs";
installTeardown();

const root = trackedMkdtemp(join(tmpdir(), "agy-plug373-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });

// Direct-mode fakes: one hangs forever, one dies with a license-style line.
const fakeHang = join(root, "agy-hang");
writeFileSync(
  fakeHang,
  `#!/bin/sh\nexec /usr/bin/node -e "process.stdin.on('data',()=>{});setInterval(()=>{},1e5)"\n`,
);
chmodSync(fakeHang, 0o755);
const fakeDie = join(root, "agy-die");
writeFileSync(
  fakeDie,
  `#!/bin/sh\necho "fake-license-error: quota exhausted; upgrade your subscription" >&2\nexit 1\n`,
);
chmodSync(fakeDie, 0o755);

process.env.AGY_PATH = fakeDie;
process.env.AGY_CLIPROXY = "0";
process.env.AGY_ACCOUNTS = "0"; // direct mode — phase 1
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
const shimDirFiles = (dir = root) =>
  existsSync(join(dir, "acp-shim")) ? readdirSync(join(dir, "acp-shim")) : [];
const nonceOf = (threadId, dir = root) => {
  const ctl = shimDirFiles(dir).find((f) => f.startsWith(`ctl-${threadId}-`) && f.endsWith(".ndjson"));
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

// --- A: real early exit — the bridge's own answer must win the grace -----
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
check(
  "receipt/resume-logged",
  /request thread\/resume id=r2 thread=t_die2 resume=prov_die/.test(logText()),
  "",
);
await waitFor(() => replies("r2").length === 1, 20_000, "real early-exit answered");
const r2 = replies("r2")[0];
check(
  "real-exit/error-not-empty",
  r2?.error !== undefined && String(r2.error.message).trim().length > 0,
  JSON.stringify(r2?.error).slice(0, 300),
);
// The bridge answered inside the grace window: its own error text (with the
// child's stderr tail) reached the daemon — NOT the synthesized placeholder.
check(
  "real-exit/bridge-answer-wins",
  r2?.error !== undefined &&
    /fake-license-error/.test(String(r2.error.message)) &&
    !/exited before the session was ready/.test(String(r2.error.message)),
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
  "real-exit/grace-armed",
  /open after shim child-close/.test(logText()),
  "",
);

send({
  jsonrpc: "2.0",
  id: "stop2",
  method: "thread/stop",
  params: { threadId: "t_die2", providerThreadId: "prov_die", intent: "release", activeTurnId: null },
});

// --- B: grace expiry — synthesized error + swallowed late answer ---------
process.env.AGY_PATH = fakeHang;
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
await waitFor(() => nonceOf("t_die") !== null, 15_000, "shim launch (control file)");
await waitFor(() => replies("r1").length === 0, 3_000, "resume stays open on the hung fake");
check("hang/resume-still-pending", replies("r1").length === 0, "hung fake must not answer");

// Forge the child's early exit on the real side channel; the bridge itself
// stays alive on the hung shim, so nothing answers within the grace window.
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
await waitFor(() => replies("r1").length === 1, 15_000, "synthesized early-exit error after grace");
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
  /answered with early-exit error after grace/.test(logText()) &&
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
  /swallowed (duplicate resume answer|late bridge answer)/.test(logText()),
  logText().match(/swallowed[^\n]*/)?.[0] ?? "no swallowed journal line",
);
// NOTE: never call bridge.onClose() — the embedded generic bridge's onClose
// ends with process.exit(0) and would eat the report.

// --- D: pool — spawn-time "Verify your account" death parks p1, moves p2 --
const acpData = join(root, "pool373");
const pol = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
for (const label of ["p1", "p2"]) {
  const cli = join(acpData, "accounts", label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}
// p1 dies at spawn with the eligibility-verification refusal on stderr —
// the "Verification Required" family the reviewer saw leak past the
// classification on the synthesized path.
writeFileSync(
  join(acpData, "accounts", "p1", ".gemini", ".fake-acp-early-exit"),
  "error: Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue.\n" +
    "Please verify your account in your browser to continue:\n" +
    "https://accounts.google.com/v3/signin/continue?plt=fake-plug373\n",
);
writeFileSync(
  join(acpData, "accounts-state.json"),
  JSON.stringify({ accounts: {
    p1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    p2: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 5 },
  } }, null, 1),
);
// Fresh catalog records for both — no cold-start probe wait.
writeFileSync(
  join(acpData, "accounts-models.json"),
  JSON.stringify({ accounts: {
    p1: { raw: [{ id: "fake-model", displayName: "Fake Model" }], families: ["fake-model"], unsupported: {}, atMs: Date.now() },
    p2: { raw: [{ id: "fake-model", displayName: "Fake Model" }], families: ["fake-model"], unsupported: {}, atMs: Date.now() },
  } }, null, 1),
);
const acpShim = join(root, "agy-acp-shim");
const acpFake = new URL("./fake-agy-acp.mjs", import.meta.url).pathname;
writeFileSync(acpShim, `#!/bin/sh\nexec /usr/bin/node ${acpFake} "$@"\n`);
chmodSync(acpShim, 0o755);
process.env.AGY_PATH = acpShim;
process.env.AGY_ACCOUNTS = "1";
process.env.AGY_FAKE_TRANSCRIPT = join(root, "pool-stdin.ndjson");
process.env.AGY_FAKE_CONTROL = join(root, "pool-control.json");
writeFileSync(process.env.AGY_FAKE_CONTROL, JSON.stringify({ modelsByLabel: {
  p1: [["fake-model", "Fake Model"]],
  p2: [["fake-model", "Fake Model"]],
} }, null, 1));

// Stale stderr file: the start() sweep must remove it (48h TTL).
mkdirSync(join(acpData, "acp-shim"), { recursive: true });
const staleLog = join(acpData, "acp-shim", "stderr-staletest-deadbeef.log");
writeFileSync(staleLog, "old stderr from a dead spawn\n");
const oldTime = new Date(Date.now() - 49 * 3_600_000);
utimesSync(staleLog, oldTime, oldTime);
const freshLog = join(acpData, "acp-shim", "stderr-freshtest-cafebabe.log");
writeFileSync(freshLog, "recent stderr — must survive the sweep\n");

const poolBridge = (await import(
  new URL("./dist/host.js?pool373", import.meta.url).href
)).experimental_providerBridge;
poolBridge.start?.({ pluginId: "provider-agy", dataDir: acpData, tempDir: acpData });
const sendPool = (m) => poolBridge.handleLine(JSON.stringify(m));
const poolLogText = () =>
  existsSync(join(acpData, "acp-wrapper.log")) ? readFileSync(join(acpData, "acp-wrapper.log"), "utf8") : "";

check(
  "stderr-sweep/stale-removed",
  !existsSync(staleLog) && existsSync(freshLog),
  `stale=${existsSync(staleLog)} fresh=${existsSync(freshLog)}`,
);

sendPool({
  jsonrpc: "2.0",
  id: "pool1",
  method: "thread/start",
  params: { threadId: "t_pool373", cwd: workspace, options: { model: "fake-model", ...pol }, instructionMode: "append" },
});
// The thread lands on the sibling — a successful result, not the dead
// account's raw exit error.
await waitFor(() => replies("pool1").length === 1, 30_000, "pool thread/start answered");
const p1Reply = replies("pool1")[0];
check(
  "pool/lands-on-sibling",
  p1Reply?.result !== undefined,
  JSON.stringify(p1Reply).slice(0, 300),
);
// The bridge's in-grace error text drove the classification: p1 parked.
const ledgerAfter = () => {
  try {
    return JSON.parse(readFileSync(join(acpData, "accounts-state.json"), "utf8")).accounts ?? {};
  } catch { return {}; }
};
await waitFor(
  () => ledgerAfter().p1?.parkedReason !== undefined || replies("pool1").length === 1,
  10_000,
  "p1 parked",
);
check(
  "pool/p1-parked-validation",
  ledgerAfter().p1?.parkedReason === "validation-required",
  JSON.stringify(ledgerAfter().p1).slice(0, 200),
);
await waitFor(
  () => /shim down on thread t_pool373: child-close/.test(poolLogText()),
  10_000,
  "pool shim-down journal",
);
check(
  "pool/move-journal",
  /move p1 → p2/.test(poolLogText()) || /p1.*→.*p2/.test(poolLogText()),
  "",
);
await waitFor(
  () => shimDirFiles(acpData).some((f) => f.startsWith("stderr-t_pool373-") && f.endsWith(".log")),
  10_000,
  "pool stderr file",
);
const poolStderr = shimDirFiles(acpData).find((f) => f.startsWith("stderr-t_pool373-") && f.endsWith(".log"));
check(
  "pool/stderr-captured",
  poolStderr !== undefined &&
    /Verify your account/.test(readFileSync(join(acpData, "acp-shim", poolStderr), "utf8")),
  poolStderr ?? "no stderr file",
);

// --- F: macOS stderr race — bridge answer sans refusal + event tail -----
// The shim's last stderr write can lose the process.exit race, so the
// bridge's in-window answer carries a bare exit error while the refusal
// text survives only in the shim-shutdown event's tail (earlyExit.message).
// The classification must run on the glue of both. Fake: q1 dies SILENTLY
// after 2 s (no stderr at all); a forged shutdown event with the refusal
// tail arms the window first.
const acpData2 = join(root, "pool373b");
for (const label of ["q1", "q2"]) {
  const cli = join(acpData2, "accounts", label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}
writeFileSync(
  join(acpData2, "accounts", "q1", ".gemini", ".fake-acp-silent-exit"),
  "2000",
);
writeFileSync(
  join(acpData2, "accounts-state.json"),
  JSON.stringify({ accounts: {
    q1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    q2: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 5 },
  } }, null, 1),
);
writeFileSync(
  join(acpData2, "accounts-models.json"),
  JSON.stringify({ accounts: {
    q1: { raw: [{ id: "fake-model", displayName: "Fake Model" }], families: ["fake-model"], unsupported: {}, atMs: Date.now() },
    q2: { raw: [{ id: "fake-model", displayName: "Fake Model" }], families: ["fake-model"], unsupported: {}, atMs: Date.now() },
  } }, null, 1),
);
mkdirSync(join(acpData2, "acp-shim"), { recursive: true });
const poolBridge2 = (await import(
  new URL("./dist/host.js?pool373b", import.meta.url).href
)).experimental_providerBridge;
poolBridge2.start?.({ pluginId: "provider-agy", dataDir: acpData2, tempDir: acpData2 });
const sendPool2 = (m) => poolBridge2.handleLine(JSON.stringify(m));
const pool2LogText = () =>
  existsSync(join(acpData2, "acp-wrapper.log")) ? readFileSync(join(acpData2, "acp-wrapper.log"), "utf8") : "";
const ledger2 = () => {
  try {
    return JSON.parse(readFileSync(join(acpData2, "accounts-state.json"), "utf8")).accounts ?? {};
  } catch { return {}; }
};

sendPool2({
  jsonrpc: "2.0",
  id: "poolB",
  method: "thread/start",
  params: { threadId: "t_pool373b", cwd: workspace, options: { model: "fake-model", ...pol }, instructionMode: "append" },
});
// The forged event must precede the real silent death (~2 s): its stderr
// tail is what the armed earlyExit.message will carry.
await waitFor(() => nonceOf("t_pool373b", acpData2) !== null, 15_000, "pool373b shim launch");
appendFileSync(
  join(acpData2, "acp-shim", "events.ndjson"),
  `${JSON.stringify({
    nonce: nonceOf("t_pool373b", acpData2),
    threadId: "t_pool373b",
    t: "shim-shutdown",
    reason: "child-close",
    exit: 1,
    sessionId: null,
    spawnError: null,
    stderr: "error: Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue.",
  })}\n`,
);
// The real child then dies silently: the bridge answers inside the window
// with a refusal-less exit error — parking must still happen via the glue.
await waitFor(() => replies("poolB").length === 1, 30_000, "pool373b thread/start answered");
check(
  "pool-grace/lands-on-sibling",
  replies("poolB")[0]?.result !== undefined,
  JSON.stringify(replies("poolB")[0]).slice(0, 300),
);
await waitFor(
  () => ledger2().q1?.parkedReason !== undefined || replies("poolB").length === 1,
  10_000,
  "q1 parked via glued classification",
);
check(
  "pool-grace/q1-parked-validation",
  ledger2().q1?.parkedReason === "validation-required",
  JSON.stringify(ledger2().q1).slice(0, 200),
);
check(
  "pool-grace/bridge-answer-won-window",
  !/answered with early-exit error after grace/.test(pool2LogText()),
  "synthesis would mean the bridge answer lost the window — the glue path was not exercised",
);
check(
  "pool-grace/grace-armed",
  /open after shim child-close/.test(pool2LogText()),
  "",
);

// --- E: shim-level stderr lifecycle (direct spawn, no bridge) ------------
const shimBin = join(root, "acp-shim.mjs");
const eDir = join(root, "shimtest");
mkdirSync(eDir, { recursive: true });
const eventsFile = join(eDir, "events.ndjson");
writeFileSync(eventsFile, "");
// Orderly: child writes a banner and keeps ticking to stderr — a write in
// the ~6 s shutdown grace must NOT recreate the file the shim just removed.
const bannerFake = join(root, "agy-banner");
writeFileSync(
  bannerFake,
  `#!/bin/sh\nexec /usr/bin/node -e "process.stderr.write('banner-alive\\n');setInterval(()=>{try{process.stderr.write('tick\\n')}catch{}},150);process.stdin.on('data',()=>{})"\n`,
);
chmodSync(bannerFake, 0o755);
const orderly = spawn(process.execPath, [shimBin, "acp"], {
  env: {
    ...process.env,
    AGY_SHIM_REAL_BIN: bannerFake,
    AGY_SHIM_EVENTS: eventsFile,
    AGY_SHIM_CONTROL: join(eDir, "ctl1.ndjson"),
    AGY_SHIM_THREAD_ID: "t_ord",
    AGY_SHIM_NONCE: "ordn",
    AGY_SHIM_SET_MODE: "",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
orderly.stderr.resume();
orderly.stdout.resume();
await waitFor(
  () => existsSync(join(eDir, "stderr-t_ord-ordn.log")),
  10_000,
  "orderly stderr file created",
);
orderly.stdin.end();
await waitFor(() => orderly.exitCode !== null, 10_000, "orderly shim exits");
check(
  "stderr-lifecycle/orderly-deleted",
  !existsSync(join(eDir, "stderr-t_ord-ordn.log")),
  "stdin-eof must remove its own stderr file",
);
// Abnormal: child exits 1 → child-close → file kept for postmortem.
const dying = spawn(process.execPath, [shimBin, "acp"], {
  env: {
    ...process.env,
    AGY_SHIM_REAL_BIN: fakeDie,
    AGY_SHIM_EVENTS: eventsFile,
    AGY_SHIM_CONTROL: join(eDir, "ctl2.ndjson"),
    AGY_SHIM_THREAD_ID: "t_dye",
    AGY_SHIM_NONCE: "dyen",
    AGY_SHIM_SET_MODE: "",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
dying.stderr.resume();
dying.stdout.resume();
await waitFor(() => dying.exitCode !== null, 15_000, "dying shim exits");
const keptFile = join(eDir, "stderr-t_dye-dyen.log");
check(
  "stderr-lifecycle/child-close-kept",
  existsSync(keptFile) && /fake-license-error/.test(readFileSync(keptFile, "utf8")),
  existsSync(keptFile) ? "kept" : "missing",
);

say("==== plug-373 early-exit report ====");
for (const r of results) {
  say(`${r.status.padEnd(4)} ${r.id.padEnd(42)} ${r.detail}`);
}
const bad = results.filter((r) => r.status !== "pass").length;
say(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad === 0 ? 0 : 1);
