/**
 * PLUG-58 proof: rotation that no longer depends on "Resets in", the
 * exit-before-result path, the every-spawn cooldown guard, and the
 * compact handoff. Three pool accounts (a1/a2/a3), no network.
 *
 * Phase A (t-bare, pool-bare-once): the first child refuses with a BARE 429
 * (no countdown) via an ERROR result. The bridge must cool a1 for the
 * 30-minute default and rotate to a2, whose retry carries a handoff prompt
 * (tag + goal + git diff --stat) instead of the bare prompt.
 *
 * Phase B (t-exit, pool-exit-once): the first child dies BEFORE any result,
 * leaving only a bare-429 stderr banner. The close handler must route into
 * the same rotation — one failed boundary, no raw "exited" banner, retry
 * completes on the sibling.
 *
 * Phase D (t-trailing, pool-exit-trailing): the same death, but a trailing
 * non-quota stderr line buries the banner (lastStderr no longer names the
 * quota). The close handler must still rotate via the recorded error text —
 * same assertions as Phase B.
 *
 * Phase C (t-rebuild, succeed): a healthy turn streams an answer; the
 * pinned account is then cooled by hand and the child idles out. The next
 * turn's rebuild must NOT restart on the dead HOME — it rotates to a free
 * sibling fresh, and the re-homed turn carries a handoff that includes the
 * previously streamed text.
 *
 * Usage: node harness-rotation.mjs
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const BARE =
  "⚠ Rate limit reached (429): slow down and try again later.";
const HANDOFF_TAG = "[quota-rotation-handoff]";

const say = (...a) => process.stdout.write(`${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  execSync("git --version", { stdio: "ignore" });
} catch {
  say("!!! git is required for the handoff diff --stat proof");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "agy-rotation-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });
// A git repo with an uncommitted change, so the handoff's diff --stat has
// something to name.
execSync("git init -q", { cwd: workspace });
writeFileSync(join(workspace, "file.txt"), "v1\n");
execSync("git add file.txt", { cwd: workspace });
execSync(
  'git -c user.email=t@t -c user.name=t commit -qm init',
  { cwd: workspace },
);
writeFileSync(join(workspace, "file.txt"), "v2\n");

const shim = join(root, "agy-shim");
const fake = new URL("./fake-agy-errors.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_FAKE_RECORD_ENV = "HOME,HTTPS_PROXY";
process.env.AGY_FAKE_TRANSCRIPT = join(root, "stdin.ndjson");
process.env.AGY_CLIPROXY = "0";
process.env.AGY_IDLE_KILL_MS = "1500";
for (const name of ["AGY_LOCATION_COOLDOWN_MS", "AGY_INELIGIBLE_BREAKER_WINDOW_MS", "AGY_INELIGIBLE_BREAKER_MAX", "AGY_FAKE_MODE_BY_LABEL"]) {
  delete process.env[name];
}

for (const label of ["a1", "a2", "a3"]) {
  const cli = join(root, "accounts", label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}

const transcriptLines = () =>
  readFileSync(join(root, "stdin.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
const spawns = () => transcriptLines().filter((o) => o.__env !== undefined);
const userPrompts = () =>
  transcriptLines()
    .filter((o) => o.event === "user")
    .map((o) => o.message?.content ?? "");
const homeLabel = (home) =>
  home === null || home === undefined ? "?" : home.split("/").pop();

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

const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
let activeBridge = bridge;
const send = (m) => activeBridge.handleLine(JSON.stringify(m));
const pol = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};
const options = { model: "fake-model", ...pol };

const boundaries = (threadId) =>
  messages
    .filter((m) => m.method === "thread/delta" && m.params.threadId === threadId)
    .flatMap((m) => m.params.deltas)
    .filter((d) => d.kind === "turn.boundary");
const replacedFor = (threadId) =>
  messages.filter(
    (m) => m.method === "session/replaced" && m.params.threadId === threadId,
  );
const errorsFor = (threadId) =>
  messages
    .filter((m) => m.method === "thread/delta" && m.params.threadId === threadId)
    .flatMap((m) => m.params.deltas)
    .filter((d) => d.kind === "provider.error");

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      process.stdout.write = originalWrite;
      say(`!!! timeout: ${label}`);
      for (const m of messages) say(JSON.stringify(m).slice(0, 260));
      process.exit(2);
    }
    await sleep(50);
  }
}

let nextId = 100;
let creqSeq = 0;
const CREQ_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const creq = () => {
  creqSeq += 1;
  let suffix = "";
  let n = creqSeq;
  for (let i = 0; i < 10; i += 1) {
    suffix += CREQ_ALPHABET[n % CREQ_ALPHABET.length];
    n = Math.floor(n / CREQ_ALPHABET.length);
  }
  return `creq_${suffix}`;
};

async function startThread(threadId, input) {
  send({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: 2,
      grammarVersions: [3, 3],
      client: { name: "fake", version: "1" },
    },
  });
  const startId = nextId++;
  send({
    jsonrpc: "2.0",
    id: startId,
    method: "thread/start",
    params: { threadId, cwd: workspace, options, instructionMode: "append",
      ...(input === undefined ? {} : { input: [{ type: "text", text: input, mentions: [] }] }),
    },
  });
  await waitFor(
    () => messages.some((m) => m.id === startId),
    15_000,
    `${threadId}: thread/start`,
  );
  return messages.find((m) => m.id === startId);
}

async function turn(threadId, text, ordinal) {
  send({
    jsonrpc: "2.0",
    id: nextId++,
    method: "turn/start",
    params: {
      threadId,
      providerThreadId: "fake-conv-rotation",
      input: [{ type: "text", text, mentions: [] }],
      clientRequestId: creq(),
      options,
    },
  });
  await waitFor(
    () => boundaries(threadId).length >= ordinal,
    30_000,
    `${threadId}: turn ${ordinal}`,
  );
}

function stop(threadId) {
  send({
    jsonrpc: "2.0",
    id: nextId++,
    method: "thread/stop",
    params: {
      threadId,
      providerThreadId: "fake-conv-rotation",
      intent: "release",
      activeTurnId: null,
    },
  });
}

const readLedger = () =>
  JSON.parse(readFileSync(join(root, "accounts-state.json"), "utf8"));

// ---- Phase A: bare 429 via ERROR result → default-cooldown rotation + handoff
process.env.AGY_FAKE_ERROR_MODE = "pool-bare-once";
process.env.AGY_FAKE_ONCE_FILE = join(root, ".bare-once-done");
await startThread("t-bare");
await turn("t-bare", "summarize file.txt", 2);
await sleep(200);
const spawnsA = spawns();
const ledgerA = readLedger();
const handoffA = userPrompts()[1] ?? "";
const a1CooldownFromNowMin =
  ((ledgerA.accounts.a1?.cooldownUntilMs ?? 0) - Date.now()) / 60000;
stop("t-bare");

// ---- Phase B: exit before result with bare 429 on stderr → same rotation
process.env.AGY_FAKE_ERROR_MODE = "pool-exit-once";
process.env.AGY_FAKE_ONCE_FILE = join(root, ".exit-once-done");
const spawnsBeforeB = spawns().length;
await startThread("t-exit");
await turn("t-exit", "hello", 2);
await sleep(200);
const spawnsB = spawns().slice(spawnsBeforeB);
stop("t-exit");

// ---- Phase D: 429 banner buried under trailing chatter → still rotates
process.env.AGY_FAKE_ERROR_MODE = "pool-exit-trailing";
process.env.AGY_FAKE_ONCE_FILE = join(root, ".exit-trailing-once-done");
{
  // Phases A/B cooled two accounts for 30m; free them so this phase owns a
  // start account plus one free sibling to rotate to.
  const ledger = readLedger();
  for (const label of ["a1", "a2", "a3"]) {
    if (ledger.accounts[label] === undefined) {
      ledger.accounts[label] = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null };
    }
    ledger.accounts[label].cooldownUntilMs = 0;
  }
  writeFileSync(join(root, "accounts-state.json"), `${JSON.stringify(ledger, null, 1)}\n`);
}
const spawnsBeforeD = spawns().length;
await startThread("t-trailing");
await turn("t-trailing", "hello trailing", 2);
await sleep(200);
const spawnsD = spawns().slice(spawnsBeforeD);
stop("t-trailing");

// ---- Phase C: rebuild on a cooled account rotates instead of restarting dead
process.env.AGY_FAKE_ERROR_MODE = "succeed";
await startThread("t-rebuild");
await turn("t-rebuild", "one", 1);
await sleep(200);
const pinnedHome = spawns()[spawns().length - 1]?.__env?.HOME ?? "";
const pinnedLabel = homeLabel(pinnedHome);
const spawnsBeforeC2 = spawns().length;
{
  // Free the siblings (phases A/B cooled a1/a3 for 30m), then cool the
  // pinned account: the rebuild must rotate instead of restarting dead.
  const ledger = readLedger();
  for (const label of ["a1", "a2", "a3"]) {
    if (ledger.accounts[label] === undefined) {
      ledger.accounts[label] = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null };
    }
    ledger.accounts[label].cooldownUntilMs = 0;
  }
  ledger.accounts[pinnedLabel].cooldownUntilMs = Date.now() + 3_600_000;
  ledger.accounts[pinnedLabel].lastError = "test-injected cooldown";
  writeFileSync(join(root, "accounts-state.json"), `${JSON.stringify(ledger, null, 1)}\n`);
}
await sleep(2_500); // past the 1.5s idle kill: the child is gone
await turn("t-rebuild", "two", 2);
await sleep(200);
const spawnsC2 = spawns().slice(spawnsBeforeC2);
const handoffC = userPrompts()[userPrompts().length - 1] ?? "";
stop("t-rebuild");

// ---- PLUG-63: account eligibility is separate from quota and its budgets.
const eligibilityChecks = [];
const check = (id, ok, detail = "") => eligibilityChecks.push([id, ok, detail]);
const VERIFY_URL = "https://accounts.google.com/v3/signin/continue?plt=fake-verification&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini";
const resetPool = () => {
  const ledger = readLedger();
  for (const label of ["a1", "a2", "a3"]) {
    ledger.accounts[label] = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null };
  }
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(ledger));
};
const bridgeLog = () => readFileSync(join(root, "bridge.log"), "utf8");
const waitBoundaries = (id, count) => waitFor(() => boundaries(id).length >= count, 15_000, `${id}: ${count} boundaries`);
const statuses = (id) => boundaries(id).map((b) => b.status).join(",");
process.env.AGY_IDLE_KILL_MS = "0";
process.env.AGY_AUTO_RETRY_MAX = "0";
process.env.AGY_AUTO_RETRY_MAX_WAIT_MS = "1";
delete process.env.AGY_INELIGIBLE_COOLDOWN_MS;
process.env.FAKE_INELIGIBLE_LABEL = "a1";
process.env.AGY_FAKE_ERROR_MODE = "ineligible";
resetPool();
let spawnOffset = spawns().length;
let promptOffset = userPrompts().length;
const beforeIneligible = Date.now();
const firstEligibility = await startThread("t-ineligible-first", "original first prompt");
await waitBoundaries("t-ineligible-first", 2);
let observed = spawns().slice(spawnOffset);
let badAccount = readLedger().accounts.a1;
check("ineligible/first-turn-recovers", !firstEligibility.error && statuses("t-ineligible-first") === "failed,completed", statuses("t-ineligible-first"));
check("ineligible/sibling-fresh-conversation", observed.length === 2 && homeLabel(observed[0].__env.HOME) === "a1" && homeLabel(observed[1].__env.HOME) === "a2" && !observed[1].__argv.includes("--conversation"));
check("ineligible/24h-cooldown", badAccount.cooldownUntilMs >= beforeIneligible + 86_400_000 && badAccount.cooldownUntilMs <= Date.now() + 86_400_000);
check("ineligible/ledger-retains-full-url", badAccount.lastError.includes("not eligible for Antigravity") && badAccount.lastError.includes(VERIFY_URL));
check("ineligible/original-prompt-without-context", userPrompts().slice(promptOffset).join("|") === "original first prompt" && replacedFor("t-ineligible-first").length === 0);
check("ineligible/no-quota-budget-or-snapshot", bridgeLog().split("\n").some((l) => l.includes("ineligible on the session's account; rotating to account a2 in 1s") && l.includes("autoRetryCount=0")) && !messages.some((m) => m.method === "thread/delta" && m.params.threadId === "t-ineligible-first" && m.params.deltas.some((d) => d.kind === "provider.rateLimits")));
check("ineligible/native-401", errorsFor("t-ineligible-first").some((e) => e.errorInfo?.category === "unauthorized" && e.errorInfo?.httpStatusCode === 401));
check("ineligible/parking-and-url-log", bridgeLog().includes("account a1 is not eligible for Antigravity (verification required); parked for 24h, rotating to a2") && bridgeLog().split("\n").some((l) => l.endsWith(`[provider-agy] ${VERIFY_URL}`)));
stop("t-ineligible-first");

{
  // Without cooldown filtering, a1 MUST win LRU selection in the next thread.
  const ledger = readLedger();
  ledger.accounts.a1.lastUsedMs = 0;
  ledger.accounts.a2.lastUsedMs = Date.now();
  ledger.accounts.a3.lastUsedMs = Date.now();
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(ledger));
}
spawnOffset = spawns().length;
await startThread("t-ineligible-next");
await turn("t-ineligible-next", "new thread", 1);
check("ineligible/new-thread-skips-parked", spawns().slice(spawnOffset).length === 1 && homeLabel(spawns()[spawnOffset].__env.HOME) !== "a1" && statuses("t-ineligible-next") === "completed");
stop("t-ineligible-next");

// A real location refusal has no verification URL, but parks and rotates too.
resetPool();
process.env.AGY_FAKE_ERROR_MODE = "ineligible-location";
spawnOffset = spawns().length;
promptOffset = userPrompts().length;
const locationLogOffset = bridgeLog().length;
const beforeLocation = Date.now();
const locationMessage = "error: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.";
const locationResponse = await startThread("t-ineligible-location", "location retry prompt");
await waitBoundaries("t-ineligible-location", 2);
const locationSpawns = spawns().slice(spawnOffset);
const locationAccount = readLedger().accounts.a1;
const locationLog = bridgeLog().slice(locationLogOffset);
check("location/rotates-fresh-and-completes",
  !locationResponse.error && statuses("t-ineligible-location") === "failed,completed" &&
  locationSpawns.length === 2 && homeLabel(locationSpawns[0].__env.HOME) === "a1" &&
  homeLabel(locationSpawns[1].__env.HOME) === "a2" && !locationSpawns[1].__argv.includes("--conversation"));
check("location/2h-cooldown-and-original-error",
  locationAccount.cooldownUntilMs >= beforeLocation + 7_200_000 &&
  locationAccount.cooldownUntilMs <= Date.now() + 7_200_000 && locationAccount.lastError === locationMessage);
check("location/log-reason-without-verification-url",
  locationLog.includes("account a1 is not eligible for Antigravity (location); parked for 2h, rotating to a2") &&
  !locationLog.includes("verification required") && !locationLog.includes("accounts.google.com"));
check("location/original-prompt-no-context-loss",
  userPrompts().slice(promptOffset).join("|") === "location retry prompt" && replacedFor("t-ineligible-location").length === 0);
check("location/native-401-without-url",
  errorsFor("t-ineligible-location").some((e) => e.message === locationMessage && e.errorInfo?.httpStatusCode === 401 && e.errorInfo?.category === "unauthorized"));
stop("t-ineligible-location");
process.env.AGY_FAKE_ERROR_MODE = "ineligible";

// An existing conversation must get a handoff; queued inputs follow the retry.
resetPool();
process.env.FAKE_INELIGIBLE_AFTER_TURN = "2";
await startThread("t-ineligible-context");
await turn("t-ineligible-context", "first successful turn", 1);
spawnOffset = spawns().length;
promptOffset = userPrompts().length;
const head = turn("t-ineligible-context", "continue file.txt", 4);
const follower = turn("t-ineligible-context", "queued follower", 4);
await Promise.all([head, follower]);
const contextPrompts = userPrompts().slice(promptOffset);
const contextReplacement = replacedFor("t-ineligible-context");
check("ineligible/context-handoff", contextPrompts.length === 3 && contextPrompts[1].includes(HANDOFF_TAG) && contextPrompts[1].includes("continue file.txt") && contextPrompts[1].includes("answered 1") && contextPrompts[1].includes("file.txt"));
check("ineligible/context-replacement-reason", contextReplacement.length === 1 && contextReplacement[0].params.contextLost === true && contextReplacement[0].params.reason === "this account failed Google's Antigravity eligibility check; the turn is being re-run on another account, so the conversation context does not carry over");
check("ineligible/queued-follower-order", contextPrompts[2] === "queued follower" && statuses("t-ineligible-context") === "completed,failed,completed,completed", statuses("t-ineligible-context"));
check("ineligible/context-restart-fresh", spawns().length === spawnOffset + 1 && !spawns()[spawnOffset].__argv.includes("--conversation"));
stop("t-ineligible-context");
delete process.env.FAKE_INELIGIBLE_AFTER_TURN;

// The failed-result route recognizes the mixed-case verify-only phrase.
resetPool();
process.env.AGY_FAKE_ERROR_MODE = "ineligible-result";
await startThread("t-ineligible-result");
await turn("t-ineligible-result", "result failure", 2);
check("ineligible/result-verify-case-insensitive", statuses("t-ineligible-result") === "failed,completed" && readLedger().accounts.a1.cooldownUntilMs > Date.now() && errorsFor("t-ineligible-result").some((e) => e.message === "Please VERIFY YOUR ACCOUNT to continue." && e.errorInfo?.httpStatusCode === 401));
stop("t-ineligible-result");

resetPool();
process.env.AGY_FAKE_ERROR_MODE = "ineligible-result-not-eligible";
await startThread("t-ineligible-phrase");
await turn("t-ineligible-phrase", "first phrase only", 2);
check("ineligible/not-eligible-phrase-alone", statuses("t-ineligible-phrase") === "failed,completed" && errorsFor("t-ineligible-phrase").some((e) => e.message === "Your current account is NOT ELIGIBLE FOR ANTIGRAVITY." && e.errorInfo?.httpStatusCode === 401));
stop("t-ineligible-phrase");

resetPool();
process.env.AGY_FAKE_ERROR_MODE = "ineligible-noinit-result";
const noinitResult = await startThread("t-ineligible-noinit-result", "result before identity");
await waitBoundaries("t-ineligible-noinit-result", 2);
check("ineligible/result-before-init-recovers", !noinitResult.error && statuses("t-ineligible-noinit-result") === "failed,completed" && replacedFor("t-ineligible-noinit-result").length === 0);
stop("t-ineligible-noinit-result");

// Helpers for no-retry scenarios: a startup reply must retain the full URL.
async function expectStartupFailure(id, diagnostic) {
  const offset = spawns().length;
  const response = await startThread(id, "must fail honestly");
  await sleep(100);
  check(`${id}/fails-with-diagnostic`, response.error?.message.includes(diagnostic) === true, response.error?.message ?? "unexpected success");
  check(`${id}/no-rotation`, spawns().length === offset + 1 && replacedFor(id).length === 0);
  stop(id);
}

resetPool();
process.env.AGY_FAKE_ERROR_MODE = "ineligible";
renameSync(join(root, "accounts", "a2"), join(root, "held-a2"));
renameSync(join(root, "accounts", "a3"), join(root, "held-a3"));
const singleLogOffset = bridgeLog().length;
await expectStartupFailure("t-ineligible-single", VERIFY_URL);
check("ineligible/single-still-parked", readLedger().accounts.a1.cooldownUntilMs > Date.now() + 86_390_000);
check("ineligible/no-free-sibling-logs-parking", bridgeLog().slice(singleLogOffset).includes("parked for 24h; no free sibling, failing"));
renameSync(join(root, "held-a2"), join(root, "accounts", "a2"));
renameSync(join(root, "held-a3"), join(root, "accounts", "a3"));

resetPool();
process.env.AGY_INELIGIBLE_COOLDOWN_MS = "0";
await expectStartupFailure("t-ineligible-disabled", VERIFY_URL);
check("ineligible/disabled-does-not-park", readLedger().accounts.a1.cooldownUntilMs === 0);
delete process.env.AGY_INELIGIBLE_COOLDOWN_MS;

resetPool();
{
  const ledger = readLedger();
  ledger.accounts.a2.cooldownUntilMs = Date.now() + 3_600_000;
  ledger.accounts.a3.cooldownUntilMs = Date.now() + 3_600_000;
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(ledger));
}
await expectStartupFailure("t-ineligible-no-free-sibling", VERIFY_URL);

resetPool();
process.env.AGY_FAKE_ERROR_MODE = "network-eligibility";
await expectStartupFailure("t-network-eligibility", "SOCKS server failure");
check("network/no-cooldown-or-unauthorized", readLedger().accounts.a1.cooldownUntilMs === 0 && errorsFor("t-network-eligibility").every((e) => e.errorInfo?.category !== "unauthorized"));

resetPool();
process.env.FAKE_INELIGIBLE_AFTER_TURN = "2";
await startThread("t-network-context");
await turn("t-network-context", "working network", 1);
spawnOffset = spawns().length;
await turn("t-network-context", "network failure", 2);
check("network/existing-context-not-unauthorized", statuses("t-network-context") === "completed,failed" && errorsFor("t-network-context").some((e) => e.message.includes("SOCKS server failure")) && errorsFor("t-network-context").every((e) => e.errorInfo?.category !== "unauthorized") && readLedger().accounts.a1.cooldownUntilMs === 0 && replacedFor("t-network-context").length === 0 && spawns().length === spawnOffset);
stop("t-network-context");
delete process.env.FAKE_INELIGIBLE_AFTER_TURN;

resetPool();
process.env.AGY_FAKE_ERROR_MODE = "ineligible";
process.env.AGY_ACCOUNTS = "0";
// Fake only rejects a configured HOME suffix even in direct mode.
process.env.FAKE_INELIGIBLE_LABEL = homeLabel(process.env.HOME);
await expectStartupFailure("t-ineligible-no-pool", VERIFY_URL);
check("ineligible/no-pool-ledger-unchanged", Object.values(readLedger().accounts).every((a) => a.cooldownUntilMs === 0));
delete process.env.AGY_ACCOUNTS;
process.env.FAKE_INELIGIBLE_LABEL = "a1";

resetPool();
process.env.AGY_INELIGIBLE_COOLDOWN_MS = "7200000";
const customCooldownStart = Date.now();
await startThread("t-ineligible-custom", "custom cooldown");
await waitBoundaries("t-ineligible-custom", 2);
check("ineligible/dynamic-custom-cooldown", readLedger().accounts.a1.cooldownUntilMs >= customCooldownStart + 7_200_000 && readLedger().accounts.a1.cooldownUntilMs <= Date.now() + 7_200_000);
stop("t-ineligible-custom");
delete process.env.AGY_INELIGIBLE_COOLDOWN_MS;

// Review regressions ported from scratch/stale.mjs and scratch/cascade.mjs.
resetPool();
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a1: "ineligible", a2: "network-eligibility", a3: "network-eligibility" });
spawnOffset = spawns().length;
const staleReply = await startThread("t-review-stale", "must retain the current SOCKS diagnostic");
await sleep(200);
const staleLedger = readLedger();
check("stale/only-first-account-parked",
  staleLedger.accounts.a1.cooldownUntilMs > Date.now() &&
  staleLedger.accounts.a2.cooldownUntilMs === 0 && staleLedger.accounts.a3.cooldownUntilMs === 0 &&
  staleLedger.accounts.a2.lastError === null && staleLedger.accounts.a3.lastError === null);
check("stale/fails-on-socks-without-cascading",
  staleReply.error?.message.includes("SOCKS server failure") && !staleReply.error.message.includes("not eligible for Antigravity") &&
  spawns().length === spawnOffset + 2 && replacedFor("t-review-stale").length === 0);
stop("t-review-stale");

resetPool();
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a1: "pool-bare-once", a2: "ineligible", a3: "succeed" });
delete process.env.AGY_AUTO_RETRY_MAX_WAIT_MS; // quota leg needs its normal rotation cap
process.env.AGY_FAKE_ONCE_FILE = join(root, ".review-cascade-quota");
spawnOffset = spawns().length;
const cascadeLogOffset = bridgeLog().length;
await startThread("t-review-cascade");
await turn("t-review-cascade", "quota then eligibility", 3);
const cascadeLedger = readLedger();
check("cascade/quota-then-ineligible-then-success",
  statuses("t-review-cascade") === "failed,failed,completed" &&
  spawns().slice(spawnOffset).map((s) => homeLabel(s.__env.HOME)).join(",") === "a1,a2,a3");
check("cascade/second-account-24h-not-quota",
  cascadeLedger.accounts.a2.cooldownUntilMs > Date.now() + 86_390_000 &&
  cascadeLedger.accounts.a2.lastError.includes(VERIFY_URL) && !cascadeLedger.accounts.a2.lastError.includes("429") &&
  cascadeLedger.accounts.a1.ineligibleAtMs === undefined && cascadeLedger.accounts.a2.ineligibleAtMs > 0);
check("cascade/parking-log-names-second-account",
  bridgeLog().slice(cascadeLogOffset).includes("account a2 is not eligible for Antigravity (verification required); parked for 24h, rotating to a3"));
stop("t-review-cascade");
process.env.AGY_AUTO_RETRY_MAX_WAIT_MS = "1";
delete process.env.AGY_FAKE_MODE_BY_LABEL;

resetPool();
process.env.AGY_FAKE_ERROR_MODE = "ineligible-noisy-stderr";
const cleanBlockReply = await startThread("t-review-clean-block", "ignore earlier quota chatter");
await waitBoundaries("t-review-clean-block", 2);
const cleanBlock = readLedger().accounts.a1.lastError;
check("stderr/isolated-eligibility-block",
  !cleanBlockReply.error && cleanBlock.startsWith("error: Eligibility check failed:") &&
  cleanBlock.endsWith(VERIFY_URL) && !cleanBlock.includes("429") && !cleanBlock.includes("cleaning up") &&
  cleanBlock.includes("Additional account eligibility details from the backend.") && cleanBlock.split("\n").length === 5);
check("stderr/old-quota-does-not-reclassify-block",
  readLedger().accounts.a1.cooldownUntilMs > Date.now() + 86_390_000 &&
  errorsFor("t-review-clean-block").some((e) => e.message === cleanBlock && e.errorInfo?.category === "unauthorized"));
stop("t-review-clean-block");

resetPool();
process.env.AGY_FAKE_ERROR_MODE = "tool-ineligible";
spawnOffset = spawns().length;
await startThread("t-review-tool");
await turn("t-review-tool", "npm publish failure", 1);
await sleep(300); // include close after the failed tool result
check("tool/verify-text-does-not-park-or-rotate",
  statuses("t-review-tool") === "failed" && spawns().length === spawnOffset + 1 && replacedFor("t-review-tool").length === 0 &&
  Object.values(readLedger().accounts).every((e) => e.cooldownUntilMs === 0 && e.ineligibleAtMs === undefined));
check("tool/original-error-reaches-thread", errorsFor("t-review-tool").some((e) => e.message === "npm: verify your account to publish this package"));
stop("t-review-tool");

// Re-review repro stale429.mjs: completed stderr banners belong to that turn.
const FATAL = "fatal: backend stream reset by peer";
for (const mode of ["stale429", "stale-ineligible"]) {
  resetPool();
  process.env.AGY_FAKE_ERROR_MODE = mode;
  const id = `t-${mode}`;
  spawnOffset = spawns().length;
  await startThread(id);
  await turn(id, "first turn succeeds with an old stderr banner", 1);
  await sleep(200); // drain both stdout and stderr before the next turn
  const errorOffset = errorsFor(id).length;
  await turn(id, "second turn crashes before result", 2);
  await sleep(200);
  check(`${mode}/fatal-without-parking-or-rotation`,
    statuses(id) === "completed,failed" && spawns().length === spawnOffset + 1 && replacedFor(id).length === 0 &&
    Object.values(readLedger().accounts).every((e) => e.cooldownUntilMs === 0 && e.ineligibleAtMs === undefined));
  check(`${mode}/current-fatal-not-old-banner`,
    boundaries(id)[1]?.error?.message.includes(FATAL) &&
    errorsFor(id).slice(errorOffset).length > 0 && errorsFor(id).slice(errorOffset).every((e) => e.message.includes(FATAL)));
  stop(id);
}

// Review-3 repro race.mjs: a 429 banner trailing turn 1's result lands after
// queued turn 2 was written; turn 2's unrelated crash must not rotate.
{
  const savedMode = process.env.AGY_FAKE_ERROR_MODE;
  resetPool();
  process.env.AGY_FAKE_ERROR_MODE = "race429";
  spawnOffset = spawns().length;
  await startThread("t-race429");
  for (const text of ["turn one", "turn two queued behind it"]) {
    send({ jsonrpc: "2.0", id: nextId++, method: "turn/start", params: {
      threadId: "t-race429", providerThreadId: "fake-conv-rotation",
      input: [{ type: "text", text, mentions: [] }], clientRequestId: creq(), options,
    } });
  }
  await waitBoundaries("t-race429", 2);
  await sleep(200);
  check("race429/fatal-without-parking-or-rotation",
    statuses("t-race429") === "completed,failed" && spawns().length === spawnOffset + 1 && replacedFor("t-race429").length === 0 &&
    Object.values(readLedger().accounts).every((e) => e.cooldownUntilMs === 0 && e.ineligibleAtMs === undefined));
  check("race429/current-fatal-reaches-thread", boundaries("t-race429")[1]?.error?.message.includes(FATAL));
  stop("t-race429");
  if (savedMode === undefined) delete process.env.AGY_FAKE_ERROR_MODE; else process.env.AGY_FAKE_ERROR_MODE = savedMode;
}

// Re-review repro toolquota.mjs: only quota may fall back to stdout tool errors.
resetPool();
delete process.env.AGY_AUTO_RETRY_MAX_WAIT_MS;
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a1: "tool-quota-exit", a2: "succeed", a3: "succeed" });
spawnOffset = spawns().length;
await startThread("t-toolquota");
await turn("t-toolquota", "tool reports quota before child exits", 2);
check("toolquota/rotates-and-completes-like-main",
  statuses("t-toolquota") === "failed,completed" &&
  spawns().slice(spawnOffset).map((s) => homeLabel(s.__env.HOME)).join(",") === "a1,a2" &&
  replacedFor("t-toolquota")[0]?.params.contextLost === true);
check("toolquota/only-quota-cooldown",
  readLedger().accounts.a1.cooldownUntilMs > Date.now() + 1_790_000 &&
  readLedger().accounts.a1.cooldownUntilMs < Date.now() + 1_820_000 &&
  readLedger().accounts.a1.lastError === BARE && readLedger().accounts.a1.ineligibleAtMs === undefined);
await turn("t-toolquota", "second successful turn stays on sibling", 3);
check("toolquota/next-turn-keeps-sibling", spawns().length === spawnOffset + 2 && statuses("t-toolquota") === "failed,completed,completed");
stop("t-toolquota");
process.env.AGY_AUTO_RETRY_MAX_WAIT_MS = "1";
delete process.env.AGY_FAKE_MODE_BY_LABEL;

async function resumeThread(id, providerThreadId) {
  const requestId = nextId++;
  send({ jsonrpc: "2.0", id: requestId, method: "thread/resume", params: {
    threadId: id, providerThreadId, cwd: workspace, options, instructionMode: "append",
  } });
  await waitFor(() => messages.some((m) => m.id === requestId), 15_000, `${id}: resume`);
  return messages.find((m) => m.id === requestId);
}

// Re-review repro resume.mjs: park without work, rotate only on a later resume.
resetPool();
process.env.AGY_FAKE_ERROR_MODE = "succeed";
const resumeSeed = await startThread("t-resume-park-seed", "establish an account-owned conversation");
await waitBoundaries("t-resume-park-seed", 1);
const resumeConversation = resumeSeed.result.providerThreadId;
stop("t-resume-park-seed");
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a1: "ineligible", a2: "succeed", a3: "succeed" });
spawnOffset = spawns().length;
const resumeLogOffset = bridgeLog().length;
const failedResume = await resumeThread("t-resume-park", resumeConversation);
check("resume/no-turn-still-parks-account",
  failedResume.error?.message.includes(VERIFY_URL) && readLedger().accounts.a1.cooldownUntilMs > Date.now() + 86_390_000 &&
  readLedger().accounts.a1.ineligibleAtMs > 0 && readLedger().accounts.a1.lastError.includes(VERIFY_URL));
check("resume/no-work-does-not-rotate-or-invent-turns",
  spawns().length === spawnOffset + 1 && boundaries("t-resume-park").length === 0 && replacedFor("t-resume-park").length === 0 &&
  bridgeLog().slice(resumeLogOffset).includes("parked for 24h; no turn queued, failing"));
const nextResume = await resumeThread("t-resume-next", resumeConversation);
check("resume/next-attempt-skips-parked-account",
  !nextResume.error && spawns().length === spawnOffset + 2 && homeLabel(spawns().at(-1).__env.HOME) !== "a1" &&
  !spawns().at(-1).__argv.includes("--conversation") && replacedFor("t-resume-next")[0]?.params.contextLost === true);
check("resume/replacement-reason-names-eligibility",
  replacedFor("t-resume-next")[0]?.params.reason.includes("a1 is parked after failing Google's Antigravity eligibility check") &&
  !replacedFor("t-resume-next")[0]?.params.reason.includes("quota cooldown"));
stop("t-resume-next");

// Parking without work must obey the same breaker and log URL on its own line.
{
  const ledger = readLedger();
  ledger.conversations[resumeConversation] = "a1";
  ledger.accounts.a1.cooldownUntilMs = 0;
  ledger.accounts.a1.ineligibleAtMs = Date.now();
  for (const label of ["a2", "a3"]) ledger.accounts[label].ineligibleAtMs = Date.now();
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(ledger));
}
const resumeBreakerStamp = readLedger().accounts.a1.ineligibleAtMs;
const resumeBreakerLogOffset = bridgeLog().length;
const breakerResume = await resumeThread("t-resume-breaker", resumeConversation);
check("resume/breaker-keeps-no-work-refusal-unparked",
  breakerResume.error?.message.includes(VERIFY_URL) && readLedger().accounts.a1.cooldownUntilMs === 0 &&
  readLedger().accounts.a1.ineligibleAtMs === resumeBreakerStamp &&
  bridgeLog().slice(resumeBreakerLogOffset).includes("ineligible breaker open: 3 accounts parked"));
check("breaker/verification-url-on-own-line",
  bridgeLog().slice(resumeBreakerLogOffset).split("\n").some((line) => line.endsWith(`[provider-agy] ${VERIFY_URL}`)));
delete process.env.AGY_FAKE_MODE_BY_LABEL;

// Invalid explicit AGY_PATH must never fall back. Even a broken implementation
// can only find this executable fake canary, never the machine's real agy.
const fallbackHome = join(root, "fallback-home");
const fallbackDir = join(fallbackHome, ".local", "bin");
mkdirSync(fallbackDir, { recursive: true });
const fallbackAgy = join(fallbackDir, "agy");
writeFileSync(fallbackAgy, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(fallbackAgy, 0o755);
const nonExecutable = join(root, "not-executable-agy");
writeFileSync(nonExecutable, "#!/bin/sh\nexit 99\n", { mode: 0o644 });
const savedHome = process.env.HOME;
const savedPath = process.env.PATH;
process.env.HOME = fallbackHome;
process.env.PATH = fallbackDir;
process.env.AGY_FAKE_ERROR_MODE = "succeed";
for (const [name, path] of [["non-executable", nonExecutable], ["missing", join(root, "missing-agy")], ["directory", fallbackDir]]) {
  resetPool();
  process.env.AGY_PATH = path;
  spawnOffset = spawns().length;
  const reply = await startThread(`t-path-${name}`, "explicit invalid path must fail");
  check(`AGY_PATH/${name}-fails-without-fallback`,
    reply.error?.message === `AGY_PATH=${path} is not executable` && spawns().length === spawnOffset);
}
// A bad AGY_PATH at bridge start is logged, never thrown: start() runs
// outside any try in the SDK worker, so a throw would kill every thread.
{
  const probeDir = join(root, "start-probe");
  mkdirSync(probeDir, { recursive: true });
  process.env.AGY_PATH = nonExecutable;
  const probe = (await import(new URL("./dist/host.js?bad-agy-path-start", import.meta.url).href)).experimental_providerBridge;
  let threw = null;
  try {
    probe.start?.({ pluginId: "provider-agy", dataDir: probeDir, tempDir: probeDir });
  } catch (error) {
    threw = error;
  }
  const probeLog = readFileSync(join(probeDir, "bridge.log"), "utf8");
  check("AGY_PATH/bad-path-at-start-is-logged-not-thrown",
    threw === null && probeLog.includes(`bridge started for plugin provider-agy; agy=<error: AGY_PATH=${nonExecutable} is not executable>`));
  probe.onClose?.();
}

// Unset and empty both mean "not pinned": default lookup, which here can
// only find the fake canary.
for (const [name, value] of [["unset", undefined], ["empty", ""]]) {
  if (value === undefined) delete process.env.AGY_PATH; else process.env.AGY_PATH = value;
  resetPool();
  spawnOffset = spawns().length;
  await startThread(`t-path-${name}-default`, "default lookup uses only the fake canary");
  await waitBoundaries(`t-path-${name}-default`, 1);
  check(`AGY_PATH/${name}-allows-default-lookup`, spawns().length === spawnOffset + 1 && statuses(`t-path-${name}-default`) === "completed");
  stop(`t-path-${name}-default`);
}
process.env.AGY_PATH = shim;
if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;

// Each disable switch applies only to its own kind, and is read dynamically.
resetPool();
process.env.AGY_FAKE_ERROR_MODE = "ineligible-location";
process.env.AGY_LOCATION_COOLDOWN_MS = "0";
await expectStartupFailure("t-location-disabled", locationMessage);
check("location/disabled-does-not-park", readLedger().accounts.a1.cooldownUntilMs === 0 && readLedger().accounts.a1.ineligibleAtMs === undefined);
resetPool(); // exercise verification on a1, rather than the next LRU sibling
process.env.AGY_FAKE_ERROR_MODE = "ineligible";
await startThread("t-verify-location-disabled", "verification stays enabled");
await waitBoundaries("t-verify-location-disabled", 2);
check("location/switch-does-not-disable-verification", readLedger().accounts.a1.cooldownUntilMs > Date.now() + 86_390_000);
stop("t-verify-location-disabled");

resetPool();
process.env.AGY_LOCATION_COOLDOWN_MS = "3600000";
process.env.AGY_INELIGIBLE_COOLDOWN_MS = "0";
process.env.AGY_FAKE_ERROR_MODE = "ineligible-location";
const locationCustomAt = Date.now();
await startThread("t-location-custom", "location stays enabled");
await waitBoundaries("t-location-custom", 2);
check("location/custom-cooldown-independent-of-verification",
  readLedger().accounts.a1.cooldownUntilMs >= locationCustomAt + 3_600_000 &&
  readLedger().accounts.a1.cooldownUntilMs <= Date.now() + 3_600_000);
stop("t-location-custom");
delete process.env.AGY_LOCATION_COOLDOWN_MS;
delete process.env.AGY_INELIGIBLE_COOLDOWN_MS;

// Five accounts: three park; the fourth must fail even with a free fifth.
for (const label of ["a4", "a5"]) {
  const cli = join(root, "accounts", label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}
resetPool();
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a1: "ineligible", a2: "ineligible-location", a3: "ineligible", a4: "ineligible-location", a5: "succeed" });
spawnOffset = spawns().length;
const breakerLogOffset = bridgeLog().length;
const breakerReply = await startThread("t-breaker", "stop after three different accounts");
const breakerLedger = readLedger();
check("breaker/three-distinct-then-stop-before-free-fifth",
  breakerReply.error?.message === locationMessage && spawns().length === spawnOffset + 4 &&
  ["a1", "a2", "a3"].every((label) => breakerLedger.accounts[label].ineligibleAtMs > 0) &&
  breakerLedger.accounts.a4.cooldownUntilMs === 0 && breakerLedger.accounts.a4.ineligibleAtMs === undefined && breakerLedger.accounts.a5 === undefined);
check("breaker/logs-open-with-original-diagnostic",
  bridgeLog().slice(breakerLogOffset).includes("ineligible breaker open: 3 accounts parked in the last 10m — suspect egress/network, not parking a4"));
stop("t-breaker");

// Recreate the bridge module: persisted timestamps must still open the breaker.
{
  const ledger = readLedger();
  ledger.accounts.a4.lastUsedMs = 0;
  ledger.accounts.a5 = { cooldownUntilMs: 0, lastUsedMs: Date.now(), lastError: null };
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(ledger));
}
bridge.onClose?.();
activeBridge = (await import(new URL("./dist/host.js?breaker-restart", import.meta.url).href)).experimental_providerBridge;
activeBridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
spawnOffset = spawns().length;
const restartedBreakerReply = await startThread("t-breaker-restart", "timestamps survive restart");
check("breaker/persists-across-bridge-restart",
  restartedBreakerReply.error?.message === locationMessage && spawns().length === spawnOffset + 1 &&
  readLedger().accounts.a4.cooldownUntilMs === 0 && readLedger().accounts.a4.ineligibleAtMs === undefined);
stop("t-breaker-restart");

// Expired events do not count, even while those accounts remain on cooldown.
{
  const ledger = readLedger();
  for (const label of ["a1", "a2", "a3"]) ledger.accounts[label].ineligibleAtMs = Date.now() - 600_001;
  ledger.accounts.a4.lastUsedMs = 0;
  ledger.accounts.a5 = { cooldownUntilMs: 0, lastUsedMs: Date.now(), lastError: null };
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(ledger));
}
const outsideWindowReply = await startThread("t-breaker-outside-window", "old events do not block");
await waitBoundaries("t-breaker-outside-window", 2);
check("breaker/events-outside-window-allow-rotation",
  !outsideWindowReply.error && statuses("t-breaker-outside-window") === "failed,completed" &&
  readLedger().accounts.a4.ineligibleAtMs > Date.now() - 10_000 && readLedger().accounts.a4.cooldownUntilMs > Date.now() + 7_190_000);
stop("t-breaker-outside-window");

// Dynamic custom max/window and distinct counting (one label counts once).
{
  const ledger = readLedger();
  for (const label of ["a1", "a2", "a3", "a4", "a5"]) {
    ledger.accounts[label] = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null };
  }
  ledger.accounts.a2.ineligibleAtMs = Date.now() - 120_000;
  ledger.accounts.a3.ineligibleAtMs = Date.now() - 120_000;
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(ledger));
}
process.env.AGY_INELIGIBLE_BREAKER_WINDOW_MS = "60000";
process.env.AGY_INELIGIBLE_BREAKER_MAX = "2";
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a1: "ineligible", a2: "succeed" });
const customWindowReply = await startThread("t-breaker-custom-window", "two-minute events are outside custom window");
await waitBoundaries("t-breaker-custom-window", 2);
check("breaker/dynamic-window-and-distinct-label-count",
  !customWindowReply.error && readLedger().accounts.a1.ineligibleAtMs > 0);
stop("t-breaker-custom-window");
{
  const ledger = readLedger();
  ledger.accounts.a1.cooldownUntilMs = 0;
  ledger.accounts.a1.lastUsedMs = 0;
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(ledger));
}
const repeatedLabelReply = await startThread("t-breaker-repeated-label", "one account still counts once");
await waitBoundaries("t-breaker-repeated-label", 2);
check("breaker/repeated-label-is-not-a-second-account",
  !repeatedLabelReply.error && statuses("t-breaker-repeated-label") === "failed,completed");
stop("t-breaker-repeated-label");
{
  const ledger = readLedger();
  ledger.accounts.a1.cooldownUntilMs = 0;
  ledger.accounts.a1.lastUsedMs = 0;
  ledger.accounts.a2.ineligibleAtMs = Date.now();
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(ledger));
}
const stampBeforeBreaker = readLedger().accounts.a1.ineligibleAtMs;
const customMaxReply = await startThread("t-breaker-custom-max", "custom max two reached");
check("breaker/dynamic-max-blocks-next-parking",
  customMaxReply.error?.message.includes(VERIFY_URL) && readLedger().accounts.a1.cooldownUntilMs === 0 &&
  readLedger().accounts.a1.ineligibleAtMs === stampBeforeBreaker);
stop("t-breaker-custom-max");
delete process.env.AGY_INELIGIBLE_BREAKER_WINDOW_MS;
delete process.env.AGY_INELIGIBLE_BREAKER_MAX;
delete process.env.AGY_FAKE_MODE_BY_LABEL;

activeBridge.onClose?.();
// A separately imported bridge that never received start has no dataDir.
activeBridge = (await import(new URL("./dist/host.js?without-data-dir", import.meta.url).href)).experimental_providerBridge;
process.env.AGY_FAKE_ERROR_MODE = "ineligible";
process.env.FAKE_INELIGIBLE_LABEL = homeLabel(process.env.HOME);
await expectStartupFailure("t-ineligible-no-data-dir", VERIFY_URL);
activeBridge.onClose?.();
await sleep(100);
process.stdout.write = originalWrite;

const bsA = boundaries("t-bare");
const bsB = boundaries("t-exit");
const bsD = boundaries("t-trailing");
const bsC = boundaries("t-rebuild");
const repA = replacedFor("t-bare");
const repB = replacedFor("t-exit");
const repD = replacedFor("t-trailing");
const repC = replacedFor("t-rebuild");
const errB = errorsFor("t-exit");
const errD = errorsFor("t-trailing");

const checks = [
  ...eligibilityChecks,
  [
    "bare/result-rotates-without-resets-in",
    spawnsA.length === 2 &&
      homeLabel(spawnsA[0]?.__env?.HOME) === "a1" &&
      homeLabel(spawnsA[1]?.__env?.HOME) === "a2",
    JSON.stringify(spawnsA.map((s) => homeLabel(s?.__env?.HOME))),
  ],
  [
    "bare/failed-then-completed",
    bsA.length === 2 && bsA[0].status === "failed" && bsA[1].status === "completed",
    JSON.stringify(bsA.map((b) => b.status)),
  ],
  [
    "bare/default-30m-cooldown",
    a1CooldownFromNowMin > 25 && a1CooldownFromNowMin < 35,
    `${a1CooldownFromNowMin.toFixed(1)}m until a1 reopens`,
  ],
  [
    "bare/retry-carries-handoff",
    handoffA.includes(HANDOFF_TAG) &&
      handoffA.includes("summarize file.txt") &&
      handoffA.includes("file.txt") &&
      handoffA.length < 8000,
    `${handoffA.length} chars: ${handoffA.slice(0, 80)}…`,
  ],
  [
    "bare/replaced-context-lost",
    repA.length === 1 && repA[0].params.contextLost === true,
    JSON.stringify(repA.map((m) => m.params.contextLost)),
  ],
  [
    "exit/rotates-to-sibling-fresh",
    spawnsB.length === 2 &&
      spawnsB[0]?.__env?.HOME !== spawnsB[1]?.__env?.HOME &&
      spawnsB[1]?.__argv?.includes("--conversation") !== true,
    JSON.stringify(
      spawnsB.map((s) => ({
        home: homeLabel(s?.__env?.HOME),
        resumed: s?.__argv?.includes("--conversation") === true,
      })),
    ),
  ],
  [
    "exit/failed-then-completed",
    bsB.length === 2 && bsB[0].status === "failed" && bsB[1].status === "completed",
    JSON.stringify(bsB.map((b) => b.status)),
  ],
  [
    "exit/one-quota-error-no-exit-banner",
    errB.length === 1 &&
      errB[0].message === BARE &&
      errB.every((e) => !e.message.includes("exited")),
    JSON.stringify(errB.map((e) => e.message)),
  ],
  [
    "exit/replaced-context-lost",
    replacedFor("t-exit").length === 1 &&
      replacedFor("t-exit")[0].params.contextLost === true,
    JSON.stringify(replacedFor("t-exit").map((m) => m.params.contextLost)),
  ],
  [
    "trailing/rotates-despite-buried-banner",
    spawnsD.length === 2 &&
      spawnsD[0]?.__env?.HOME !== spawnsD[1]?.__env?.HOME &&
      spawnsD[1]?.__argv?.includes("--conversation") !== true,
    JSON.stringify(
      spawnsD.map((s) => ({
        home: homeLabel(s?.__env?.HOME),
        resumed: s?.__argv?.includes("--conversation") === true,
      })),
    ),
  ],
  [
    "trailing/failed-then-completed",
    bsD.length === 2 && bsD[0].status === "failed" && bsD[1].status === "completed",
    JSON.stringify(bsD.map((b) => b.status)),
  ],
  [
    "trailing/one-quota-error-no-exit-banner",
    errD.length === 1 &&
      errD[0].message === BARE &&
      errD.every((e) => !e.message.includes("exited")) &&
      errD.every((e) => !e.message.includes("cleaning up")),
    JSON.stringify(errD.map((e) => e.message)),
  ],
  [
    "trailing/replaced-context-lost",
    replacedFor("t-trailing").length === 1 &&
      replacedFor("t-trailing")[0].params.contextLost === true,
    JSON.stringify(replacedFor("t-trailing").map((m) => m.params.contextLost)),
  ],
  [
    "rebuild/rotates-off-cooled-account",
    spawnsC2.length === 1 &&
      homeLabel(spawnsC2[0]?.__env?.HOME) !== pinnedLabel &&
      spawnsC2[0]?.__argv?.includes("--conversation") !== true,
    `pinned=${pinnedLabel} rebuilt=${homeLabel(spawnsC2[0]?.__env?.HOME)}`,
  ],
  [
    "rebuild/second-turn-completes",
    bsC.length === 2 &&
      bsC[0].status === "completed" &&
      bsC[1].status === "completed",
    JSON.stringify(bsC.map((b) => b.status)),
  ],
  [
    "rebuild/replaced-context-lost",
    repC.length === 1 && repC[0].params.contextLost === true,
    JSON.stringify(repC.map((m) => m.params.contextLost)),
  ],
  [
    "rebuild/handoff-carries-streamed-text",
    handoffC.includes(HANDOFF_TAG) &&
      handoffC.includes("answered 1") &&
      handoffC.includes("file.txt"),
    `${handoffC.length} chars: ${handoffC.slice(0, 80)}…`,
  ],
];

say("==== quota-rotation report ====");
let bad = 0;
for (const [id, ok, detail] of checks) {
  say(`${ok ? "pass" : "FAIL"} ${id.padEnd(40)} ${detail}`);
  if (!ok) bad += 1;
}
say(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);
