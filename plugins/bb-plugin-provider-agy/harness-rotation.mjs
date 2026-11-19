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
  existsSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { installTeardown, trackedMkdtemp } from "./harness-teardown.mjs";
installTeardown();

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

const root = trackedMkdtemp(join(tmpdir(), "agy-rotation-"));
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
process.env.AGY_TRANSPORT ??= "stream-json";
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

const readLedger = () => {
  const shared = JSON.parse(readFileSync(join(root, "accounts-state.json"), "utf8"));
  let local = {};
  try {
    local = JSON.parse(readFileSync(join(root, "conversations-state.json"), "utf8")).conversations ?? {};
  } catch { /* no local file yet */ }
  return { ...shared, conversations: { ...(shared.conversations ?? {}), ...local } };
};
// Writes below act as operator/keeper truth on the shared file; dropping the
// instance-local files keeps them deterministic (the overlay shadow would
// otherwise keep stale marks alive until fresher shared.lastUsedMs, and a
// local pin would shadow the conversations written here — covered separately).
const writeLedger = (ledger, pretty = false) => {
  writeFileSync(
    join(root, "accounts-state.json"),
    pretty ? `${JSON.stringify(ledger, null, 1)}\n` : JSON.stringify(ledger),
  );
  try { unlinkSync(join(root, "accounts-overlay.json")); } catch { /* absent */ }
  try { unlinkSync(join(root, "conversations-state.json")); } catch { /* absent */ }
};

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
  writeLedger(ledger, true);
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
  writeLedger(ledger, true);
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
  writeLedger(ledger);
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
// PLUG-332 (ревизия 15): a refusal carrying a verification URL parks
// permanently as validation-required — parkedReason + ineligibleAtMs +
// lastError, and NO cooldownUntilMs; the mark itself bars selection.
check("ineligible/validation-required-park", badAccount.parkedReason === "validation-required" && badAccount.ineligibleAtMs >= beforeIneligible && (badAccount.cooldownUntilMs ?? 0) <= Date.now());
check("ineligible/ledger-retains-full-url", badAccount.lastError.includes("not eligible for Antigravity") && badAccount.lastError.includes(VERIFY_URL));
check("ineligible/original-prompt-without-context", userPrompts().slice(promptOffset).join("|") === "original first prompt" && replacedFor("t-ineligible-first").length === 0);
check("ineligible/no-quota-budget-or-snapshot", bridgeLog().split("\n").some((l) => l.includes("ineligible on the session's account; rotating to account a2 in 1s") && l.includes("autoRetryCount=0")) && !messages.some((m) => m.method === "thread/delta" && m.params.threadId === "t-ineligible-first" && m.params.deltas.some((d) => d.kind === "provider.rateLimits")));
check("ineligible/native-401", errorsFor("t-ineligible-first").some((e) => e.errorInfo?.category === "unauthorized" && e.errorInfo?.httpStatusCode === 401));
check("ineligible/parking-and-url-log", bridgeLog().includes("account a1 is not eligible for Antigravity (verification required); parked permanently (validation-required; manual unpark required), rotating to a2") && bridgeLog().split("\n").some((l) => l.endsWith(`[provider-agy] ${VERIFY_URL}`)));
stop("t-ineligible-first");

{
  // Without cooldown filtering, a1 MUST win LRU selection in the next thread.
  const ledger = readLedger();
  ledger.accounts.a1.lastUsedMs = 0;
  ledger.accounts.a2.lastUsedMs = Date.now();
  ledger.accounts.a3.lastUsedMs = Date.now();
  writeLedger(ledger);
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

// Compaction fallback: "/compact" dies to Google's 500, the bridge asks the
// agent for its own summary on the same conversation, then seeds a fresh
// conversation with it; a turn queued behind "/compact" runs after, there.
{
  const saved = { mode: process.env.AGY_FAKE_ERROR_MODE, label: process.env.FAKE_INELIGIBLE_LABEL };
  delete process.env.FAKE_INELIGIBLE_LABEL;
  process.env.AGY_FAKE_ERROR_MODE = "compact-fail";
  process.env.AGY_FAKE_FRESH_IDS = "1";
  const identities = (id) => messages.filter((m) => m.method === "thread/identity" && m.params.threadId === id).map((m) => m.params.providerThreadId);
  const runFallback = async (id, summaryMode) => {
    resetPool();
    process.env.AGY_FAKE_SUMMARY_MODE = summaryMode;
    await startThread(id);
    await turn(id, "first successful turn", 1);
    const so = spawns().length;
    const po = userPrompts().length;
    send({ jsonrpc: "2.0", id: nextId++, method: "turn/start", params: { threadId: id, providerThreadId: "fake-conv-rotation",
      input: [{ type: "text", text: "/compact", mentions: [] }], clientRequestId: creq(), options } });
    await turn(id, "queued user turn", 5);
    return { prompts: userPrompts().slice(po), spawns: spawns().slice(so) };
  };

  const ok = await runFallback("t-cf-ok", "ok");
  check("compact-fallback/sequence", statuses("t-cf-ok") === "completed,failed,completed,completed,completed", statuses("t-cf-ok"));
  check("compact-fallback/prompts-in-order",
    ok.prompts.length === 4 && ok.prompts[0] === "/compact" && ok.prompts[1].startsWith("[compaction-fallback]") &&
    ok.prompts[2].startsWith("[compaction-handoff]") && ok.prompts[2].includes("SUMMARY-OF-WORK: goal G; done D; next N") &&
    ok.prompts[3] === "queued user turn", JSON.stringify(ok.prompts.map((p) => p.slice(0, 40))));
  check("compact-fallback/summary-on-same-then-fresh-conversation",
    ok.spawns.length === 2 && ok.spawns[0].__argv.includes("--conversation") && !ok.spawns[1].__argv.includes("--conversation"),
    JSON.stringify(ok.spawns.map((x) => x.__argv.includes("--conversation"))));
  const ids = identities("t-cf-ok");
  check("compact-fallback/thread-moves-to-new-conversation", ids.length >= 2 && ids.at(-1) !== ids[0], JSON.stringify(ids));
  const rep = replacedFor("t-cf-ok");
  check("compact-fallback/replaced-notices", rep.length === 2 && rep[0].params.contextLost === false && rep[1].params.contextLost === true &&
    rep[1].params.reason.includes("agent's own summary"), JSON.stringify(rep.map((m) => m.params.contextLost)));
  check("compact-fallback/no-auto-retry-tags", errorsFor("t-cf-ok").length > 0 && errorsFor("t-cf-ok").every((e) => e.errorInfo?.category !== "internal" && e.category !== "internal"),
    JSON.stringify(errorsFor("t-cf-ok").map((e) => e.errorInfo ?? null)));
  stop("t-cf-ok");

  const failed = await runFallback("t-cf-fail", "fail");
  check("compact-fallback/summary-fails-memo-seed", statuses("t-cf-fail") === "completed,failed,failed,completed,completed" &&
    failed.prompts[2]?.startsWith("[compaction-handoff]") && failed.prompts[2].includes("could not summarize") &&
    failed.prompts[2].includes("LAST ASSISTANT OUTPUT") && failed.prompts[3] === "queued user turn",
    statuses("t-cf-fail") + " " + JSON.stringify(failed.prompts.map((p) => p.slice(0, 40))));
  check("compact-fallback/memo-on-fresh-conversation", failed.spawns.length === 2 && !failed.spawns[1].__argv.includes("--conversation"));
  check("compact-fallback/memo-tells-agent-to-read-thread-history",
    failed.prompts[2]?.includes("timeout 60 bb thread messages t-cf-fail --limit 30") && failed.prompts[2].includes("Restore your context NOW") &&
    failed.prompts[2].includes("$BB_CLI") && failed.prompts[2].includes("READ-ONLY") && failed.prompts[2].includes("not a to-do list") &&
    failed.prompts[2].includes("never `--all`") && failed.prompts[2].split("--all").length === 2, (failed.prompts[2] ?? "").slice(0, 400));
  check("compact-fallback/summary-seed-points-to-thread-history",
    ok.prompts[2]?.includes("timeout 60 bb thread messages t-cf-ok --limit 30") && ok.prompts[2].includes("Do not call tools in this turn") &&
    !ok.prompts[2].includes("Restore your context NOW"), (ok.prompts[2] ?? "").slice(0, 400));
  stop("t-cf-fail");

  const empty = await runFallback("t-cf-empty", "empty");
  check("compact-fallback/empty-summary-memo-seed", statuses("t-cf-empty") === "completed,failed,completed,completed,completed" &&
    empty.prompts[2]?.includes("could not summarize"), statuses("t-cf-empty"));
  stop("t-cf-empty");

  // A /compact refused for billing is not Google failing to compact.
  process.env.AGY_FAKE_COMPACT_MODE = "billing";
  resetPool();
  await startThread("t-cf-billing");
  await turn("t-cf-billing", "first successful turn", 1);
  const billPrompts = userPrompts().length;
  await turn("t-cf-billing", "/compact", 2);
  await sleep(1500);
  check("compact-fallback/billing-stays-failed", statuses("t-cf-billing") === "completed,failed" && userPrompts().length === billPrompts + 1,
    statuses("t-cf-billing"));
  stop("t-cf-billing");

  // 503 "overloaded" on /compact: the fallback runs, bb's auto-retry tag is dropped.
  process.env.AGY_FAKE_COMPACT_MODE = "overloaded";
  await runFallback("t-cf-overloaded", "ok");
  check("compact-fallback/overloaded-not-tagged-and-handled",
    statuses("t-cf-overloaded") === "completed,failed,completed,completed,completed" &&
    errorsFor("t-cf-overloaded").every((e) => e.errorInfo?.category !== "overloaded" && e.category !== "overloaded"),
    statuses("t-cf-overloaded") + " " + JSON.stringify(errorsFor("t-cf-overloaded").map((e) => e.errorInfo ?? null)));
  stop("t-cf-overloaded");
  delete process.env.AGY_FAKE_COMPACT_MODE;

  // Quota on the summary step (as a result, and as an exit before one): the
  // account is parked and the memo seed opens a fresh conversation on a sibling.
  const savedWait = process.env.AGY_AUTO_RETRY_MAX_WAIT_MS;
  delete process.env.AGY_AUTO_RETRY_MAX_WAIT_MS;
  for (const summaryMode of ["quota", "quota-exit"]) {
    const id = `t-cf-${summaryMode}`;
    const r = await runFallback(id, summaryMode);
    check(`compact-fallback/${summaryMode}-on-summary-memo-on-sibling`,
      statuses(id) === "completed,failed,failed,completed,completed" &&
      r.prompts[2]?.startsWith("[compaction-handoff]") && r.prompts[2].includes("could not summarize") &&
      r.prompts[3] === "queued user turn" &&
      r.spawns.length === 2 && homeLabel(r.spawns[1].__env.HOME) !== homeLabel(r.spawns[0].__env.HOME) &&
      !r.spawns[1].__argv.includes("--conversation") && readLedger().accounts[homeLabel(r.spawns[0].__env.HOME)].cooldownUntilMs > Date.now(),
      statuses(id) + " " + JSON.stringify(r.prompts.map((p) => p.slice(0, 30))) + " " + JSON.stringify(r.spawns.map((x) => homeLabel(x.__env.HOME))));
    stop(id);
  }
  process.env.AGY_AUTO_RETRY_MAX_WAIT_MS = savedWait;

  // A seed that fails twice: the thread goes back to its old conversation,
  // and the queued turn lands there — never in an empty one.
  process.env.AGY_FAKE_SEED_MODE = "fail";
  resetPool();
  process.env.AGY_FAKE_SUMMARY_MODE = "ok";
  await startThread("t-cf-restore");
  await turn("t-cf-restore", "first successful turn", 1);
  const oldConv = identities("t-cf-restore")[0];
  const rso = spawns().length;
  send({ jsonrpc: "2.0", id: nextId++, method: "turn/start", params: { threadId: "t-cf-restore", providerThreadId: "fake-conv-rotation",
    input: [{ type: "text", text: "/compact", mentions: [] }], clientRequestId: creq(), options } });
  await turn("t-cf-restore", "queued user turn", 6);
  const rs = spawns().slice(rso);
  check("compact-fallback/seed-fails-twice-back-to-old-conversation",
    statuses("t-cf-restore") === "completed,failed,completed,failed,failed,completed" &&
    rs.length === 4 && rs[3].__argv.includes("--conversation") && rs[3].__argv[rs[3].__argv.indexOf("--conversation") + 1] === oldConv &&
    identities("t-cf-restore").at(-1) === oldConv && userPrompts().at(-1) === "queued user turn",
    statuses("t-cf-restore") + " " + JSON.stringify(rs.map((x) => x.__argv.includes("--conversation"))));
  check("compact-fallback/restore-notice", replacedFor("t-cf-restore").at(-1)?.params.reason.includes("goes back to its previous") === true &&
    replacedFor("t-cf-restore").at(-1)?.params.contextLost === false);
  stop("t-cf-restore");
  delete process.env.AGY_FAKE_SEED_MODE;

  // Quota on the seed BEFORE its init, no free sibling: the same-account retry
  // must still open a FRESH conversation, never resume the old one.
  {
    resetPool();
    process.env.AGY_FAKE_SUMMARY_MODE = "ok";
    const savedMax = process.env.AGY_AUTO_RETRY_MAX;
    const savedWait = process.env.AGY_AUTO_RETRY_MAX_WAIT_MS;
    process.env.AGY_AUTO_RETRY_MAX = "1";
    delete process.env.AGY_AUTO_RETRY_MAX_WAIT_MS;
    await startThread("t-cf-seedquota");
    await turn("t-cf-seedquota", "first successful turn", 1);
    const oldConv = identities("t-cf-seedquota")[0];
    const pinned = homeLabel(spawns().at(-1).__env.HOME);
    const ledger = readLedger();
    for (const label of ["a1", "a2", "a3"]) {
      if (label !== pinned) ledger.accounts[label] = { cooldownUntilMs: Date.now() + 3_600_000, lastUsedMs: 0, lastError: null };
    }
    writeLedger(ledger);
    const arm = join(root, "preinit-arm");
    writeFileSync(arm, "x");
    process.env.AGY_FAKE_PREINIT_ARM = arm;
    const so = spawns().length;
    send({ jsonrpc: "2.0", id: nextId++, method: "turn/start", params: { threadId: "t-cf-seedquota", providerThreadId: "fake-conv-rotation",
      input: [{ type: "text", text: "/compact", mentions: [] }], clientRequestId: creq(), options } });
    await turn("t-cf-seedquota", "queued user turn", 6);
    const sq = spawns().slice(so);
    check("compact-fallback/seed-quota-before-init-still-fresh",
      statuses("t-cf-seedquota") === "completed,failed,completed,failed,completed,completed" &&
      sq.length === 3 && sq.slice(1).every((x) => !x.__argv.includes("--conversation")) &&
      identities("t-cf-seedquota").at(-1) !== oldConv && userPrompts().at(-1) === "queued user turn",
      statuses("t-cf-seedquota") + " " + JSON.stringify(sq.map((x) => x.__argv.includes("--conversation"))) + " " + JSON.stringify(identities("t-cf-seedquota")));
    stop("t-cf-seedquota");
    delete process.env.AGY_FAKE_PREINIT_ARM;
    process.env.AGY_AUTO_RETRY_MAX = savedMax;
    process.env.AGY_AUTO_RETRY_MAX_WAIT_MS = savedWait;
  }

  // thread/stop inside the 1 s window: nothing more is spawned.
  resetPool();
  await startThread("t-cf-stop");
  await turn("t-cf-stop", "first successful turn", 1);
  await turn("t-cf-stop", "/compact", 2);
  const stopSpawns = spawns().length;
  stop("t-cf-stop");
  await sleep(1800);
  check("compact-fallback/stop-in-window-cancels", spawns().length === stopSpawns && statuses("t-cf-stop") === "completed,failed",
    `${spawns().length - stopSpawns} extra spawns; ${statuses("t-cf-stop")}`);

  // AGY_COMPACT_FALLBACK=0: the failed compaction just stays failed.
  resetPool();
  process.env.AGY_COMPACT_FALLBACK = "0";
  await startThread("t-cf-off");
  await turn("t-cf-off", "first successful turn", 1);
  const offPrompts = userPrompts().length;
  await turn("t-cf-off", "/compact", 2);
  await sleep(1500);
  check("compact-fallback/disabled-keeps-old-behaviour", statuses("t-cf-off") === "completed,failed" && userPrompts().length === offPrompts + 1,
    statuses("t-cf-off"));
  stop("t-cf-off");
  delete process.env.AGY_COMPACT_FALLBACK;
  delete process.env.AGY_FAKE_SUMMARY_MODE;
  delete process.env.AGY_FAKE_FRESH_IDS;
  process.env.AGY_FAKE_ERROR_MODE = saved.mode;
  process.env.FAKE_INELIGIBLE_LABEL = saved.label;
}

// A "/compact" that hits the refusal is re-run verbatim on the sibling —
// never wrapped in a work handoff ("continue the work" for the agent).
resetPool();
process.env.FAKE_INELIGIBLE_AFTER_TURN = "2";
await startThread("t-ineligible-compact");
await turn("t-ineligible-compact", "first successful turn", 1);
promptOffset = userPrompts().length;
await turn("t-ineligible-compact", "/compact", 3);
const compactPrompts = userPrompts().slice(promptOffset);
check("ineligible/compact-rerun-verbatim",
  compactPrompts.length === 2 && compactPrompts.every((p) => p === "/compact") &&
  statuses("t-ineligible-compact") === "completed,failed,completed", JSON.stringify(compactPrompts).slice(0, 160) + " " + statuses("t-ineligible-compact"));
stop("t-ineligible-compact");

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
check("ineligible/result-verify-case-insensitive", statuses("t-ineligible-result") === "failed,completed" && readLedger().accounts.a1.parkedReason === "validation-required" && errorsFor("t-ineligible-result").some((e) => e.message === "Please VERIFY YOUR ACCOUNT to continue." && e.errorInfo?.httpStatusCode === 401));
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
check("ineligible/single-still-parked", readLedger().accounts.a1.parkedReason === "validation-required" && (readLedger().accounts.a1.cooldownUntilMs ?? 0) <= Date.now());
check("ineligible/no-free-sibling-logs-parking", bridgeLog().slice(singleLogOffset).includes("parked permanently (validation-required; manual unpark required); no free sibling, failing"));
renameSync(join(root, "held-a2"), join(root, "accounts", "a2"));
renameSync(join(root, "held-a3"), join(root, "accounts", "a3"));

resetPool();
// PLUG-332: AGY_INELIGIBLE_COOLDOWN_MS no longer gates eligibility
// refusals — a verify-link refusal still parks permanently even at 0 and
// the turn rotates to a free sibling.
process.env.AGY_INELIGIBLE_COOLDOWN_MS = "0";
await startThread("t-ineligible-disabled", "verify park ignores the legacy env");
await waitBoundaries("t-ineligible-disabled", 2);
check("ineligible/verify-park-not-env-gated",
  statuses("t-ineligible-disabled") === "failed,completed" &&
  readLedger().accounts.a1.parkedReason === "validation-required" &&
  (readLedger().accounts.a1.cooldownUntilMs ?? 0) <= Date.now());
stop("t-ineligible-disabled");
delete process.env.AGY_INELIGIBLE_COOLDOWN_MS;

resetPool();
{
  const ledger = readLedger();
  ledger.accounts.a2.cooldownUntilMs = Date.now() + 3_600_000;
  ledger.accounts.a3.cooldownUntilMs = Date.now() + 3_600_000;
  writeLedger(ledger);
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

// Review regressions ported from scratch/stale.mjs and scratch/cascade.mjs.
resetPool();
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a1: "ineligible", a2: "network-eligibility", a3: "network-eligibility" });
spawnOffset = spawns().length;
const staleReply = await startThread("t-review-stale", "must retain the current SOCKS diagnostic");
await sleep(200);
const staleLedger = readLedger();
check("stale/only-first-account-parked",
  staleLedger.accounts.a1.parkedReason === "validation-required" &&
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
check("cascade/second-account-validation-not-quota",
  cascadeLedger.accounts.a2.parkedReason === "validation-required" &&
  cascadeLedger.accounts.a2.lastError.includes(VERIFY_URL) && !cascadeLedger.accounts.a2.lastError.includes("429") &&
  cascadeLedger.accounts.a1.ineligibleAtMs === undefined && cascadeLedger.accounts.a2.ineligibleAtMs > 0);
check("cascade/parking-log-names-second-account",
  bridgeLog().slice(cascadeLogOffset).includes("account a2 is not eligible for Antigravity (verification required); parked permanently (validation-required; manual unpark required), rotating to a3"));
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
  readLedger().accounts.a1.parkedReason === "validation-required" &&
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
  failedResume.error?.message.includes(VERIFY_URL) && readLedger().accounts.a1.parkedReason === "validation-required" &&
  readLedger().accounts.a1.ineligibleAtMs > 0 && readLedger().accounts.a1.lastError.includes(VERIFY_URL));
check("resume/no-work-does-not-rotate-or-invent-turns",
  spawns().length === spawnOffset + 1 && boundaries("t-resume-park").length === 0 && replacedFor("t-resume-park").length === 0 &&
  bridgeLog().slice(resumeLogOffset).includes("parked permanently (validation-required; manual unpark required); no turn queued, failing"));
const nextResume = await resumeThread("t-resume-next", resumeConversation);
check("resume/next-attempt-skips-parked-account",
  !nextResume.error && spawns().length === spawnOffset + 2 && homeLabel(spawns().at(-1).__env.HOME) !== "a1" &&
  !spawns().at(-1).__argv.includes("--conversation") && replacedFor("t-resume-next")[0]?.params.contextLost === true);
check("resume/replacement-reason-names-eligibility",
  replacedFor("t-resume-next")[0]?.params.reason.includes("a1 needs Google account verification") &&
  !replacedFor("t-resume-next")[0]?.params.reason.includes("quota cooldown"));
stop("t-resume-next");

// Parking without work must obey the same breaker and log URL on its own line.
{
  const ledger = readLedger();
  ledger.conversations[resumeConversation] = "a1";
  ledger.accounts.a1.cooldownUntilMs = 0;
  // A verify-parked entry never counts toward the breaker — clear the
  // leftover mark so this seed contributes like an ordinary mark.
  delete ledger.accounts.a1.parkedReason;
  ledger.accounts.a1.ineligibleAtMs = Date.now();
  for (const label of ["a2", "a3"]) ledger.accounts[label].ineligibleAtMs = Date.now();
  writeLedger(ledger);
}
const resumeBreakerStamp = readLedger().accounts.a1.ineligibleAtMs;
const resumeBreakerLogOffset = bridgeLog().length;
const breakerResume = await resumeThread("t-resume-breaker", resumeConversation);
check("resume/breaker-keeps-no-work-refusal-unparked",
  breakerResume.error?.message.includes(VERIFY_URL) && readLedger().accounts.a1.cooldownUntilMs === 0 &&
  readLedger().accounts.a1.ineligibleAtMs === resumeBreakerStamp &&
  bridgeLog().slice(resumeBreakerLogOffset).includes("ineligible breaker open — suspect egress/network, not parking a1"));
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
check("location/switch-does-not-disable-verification", readLedger().accounts.a1.parkedReason === "validation-required");
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
// PLUG-332: validation-required marks never count toward the breaker —
// three counted refusals need three non-verify marks, so all five modes
// here are location refusals.
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a1: "ineligible-location", a2: "ineligible-location", a3: "ineligible-location", a4: "ineligible-location", a5: "succeed" });
spawnOffset = spawns().length;
const breakerLogOffset = bridgeLog().length;
const breakerReply = await startThread("t-breaker", "stop after three different accounts");
const breakerLedger = readLedger();
check("breaker/three-distinct-then-stop-before-free-fifth",
  breakerReply.error?.message === locationMessage && spawns().length === spawnOffset + 4 &&
  ["a1", "a2", "a3"].every((label) => breakerLedger.accounts[label].ineligibleAtMs > 0) &&
  breakerLedger.accounts.a4.cooldownUntilMs === 0 && breakerLedger.accounts.a4.ineligibleAtMs === undefined && breakerLedger.accounts.a5 === undefined);
check("breaker/logs-open-with-original-diagnostic",
  bridgeLog().slice(breakerLogOffset).includes("ineligible breaker open — suspect egress/network, not parking a4"));
stop("t-breaker");

// PLUG-332: two fresh verify-parks contribute nothing — the next location
// refusal still parks instead of hitting the breaker.
resetPool();
{
  const ledger = readLedger();
  for (const label of ["a1", "a2"]) {
    ledger.accounts[label] = {
      cooldownUntilMs: 0, lastUsedMs: 0, lastError: "old refusal",
      ineligibleAtMs: Date.now(), parkedReason: "validation-required",
    };
  }
  writeLedger(ledger);
}
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a3: "ineligible-location", a4: "succeed", a5: "succeed" });
await startThread("t-breaker-verify-not-counted", "verify marks are outside the breaker");
await waitBoundaries("t-breaker-verify-not-counted", 2);
check("breaker/validation-required-marks-not-counted",
  statuses("t-breaker-verify-not-counted") === "failed,completed" &&
  readLedger().accounts.a3.ineligibleAtMs > Date.now() - 10_000 &&
  readLedger().accounts.a3.cooldownUntilMs > Date.now() + 7_190_000);
stop("t-breaker-verify-not-counted");

// Recreate the bridge module: persisted timestamps must still open the breaker.
{
  const ledger = readLedger();
  const nowMs = Date.now();
  // a1/a2 still carry verify-marks from the previous test — clear
  // parkedReason so their stamps count again, and push them behind a4's
  // LRU slot so it stays the first pick.
  for (const label of ["a1", "a2"]) {
    delete ledger.accounts[label].parkedReason;
    ledger.accounts[label].ineligibleAtMs = nowMs;
    // Keep them off the pick list: counted by the breaker, yet a4 stays
    // the first pick and they remain unpickable for the next scenario.
    ledger.accounts[label].cooldownUntilMs = nowMs + 3_600_000;
  }
  ledger.accounts.a4.lastUsedMs = 0;
  ledger.accounts.a5 = { cooldownUntilMs: 0, lastUsedMs: Date.now(), lastError: null };
  writeLedger(ledger);
}
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a4: "ineligible-location" });
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
  writeLedger(ledger);
}
process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ a4: "ineligible-location", a5: "succeed" });
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
  writeLedger(ledger);
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
  delete ledger.accounts.a1.parkedReason;
  writeLedger(ledger);
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
  delete ledger.accounts.a1.parkedReason;
  ledger.accounts.a2.ineligibleAtMs = Date.now();
  writeLedger(ledger);
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

// ---- PLUG-306 (ревизия 14): a parkedReason account is never launched ------
// parkedReason alone (cooldown already 0) makes the home banned: resume,
// the enqueueTurn rebuild and the compaction restore all move to a free
// sibling — or fail honestly when none exists. The fake never sees a spawn
// on the parked HOME.
{
  const parkedEntry = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: "tos",
    ineligibleAtMs: 1, parkedReason: "tos-disabled" };
  const parkOwner = (label, conv) => {
    const ledger = readLedger();
    for (const l of ["a1", "a2", "a3"]) {
      ledger.accounts[l] = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null };
      delete ledger.accounts[l].parkedReason;
      delete ledger.accounts[l].ineligibleAtMs;
    }
    if (conv !== undefined) ledger.conversations[conv] = label;
    ledger.accounts[label] = { ...parkedEntry };
    writeLedger(ledger);
  };
  const parkAll = (conv) => {
    const ledger = readLedger();
    for (const l of readdirSync(join(root, "accounts"))) {
      ledger.accounts[l] = { ...parkedEntry };
    }
    if (conv !== undefined) ledger.conversations[conv] = "a1";
    writeLedger(ledger);
  };
  const cfIdentities = (id) => messages
    .filter((m) => m.method === "thread/identity" && m.params.threadId === id)
    .map((m) => m.params.providerThreadId);
  process.env.AGY_FAKE_ERROR_MODE = "succeed";

  // P1: resume whose owner carries parkedReason → fresh spawn on a sibling,
  // honest contextLost notice; the parked HOME is never spawned.
  parkOwner("a1", "fake-conv-park");
  const parkSpawnBase = spawns().length;
  const parkResume = await resumeThread("t-resume-parked-sib", "fake-conv-park");
  const parkSpawn = spawns().at(-1);
  check("parked/resume-rotates-to-sibling",
    !parkResume.error && spawns().length === parkSpawnBase + 1 &&
    homeLabel(parkSpawn?.__env?.HOME) !== "a1" &&
    !parkSpawn?.__argv?.includes("--conversation") &&
    replacedFor("t-resume-parked-sib").some((m) => m.params.contextLost === true &&
      typeof m.params.reason === "string" && m.params.reason.includes("disabled by Google")),
    parkResume?.error?.message ?? `spawn=${homeLabel(parkSpawn?.__env?.HOME)}`);
  stop("t-resume-parked-sib");

  // P2: resume whose owner is parked and every sibling is parked too →
  // honest SESSION_NOT_RESTORABLE, zero spawns.
  parkAll("fake-conv-park");
  const deadSpawnBase = spawns().length;
  const deadResume = await resumeThread("t-resume-parked-dead", "fake-conv-park");
  check("parked/resume-all-parked-fails",
    deadResume?.error !== undefined && /parked/iu.test(deadResume.error.message ?? "") &&
    spawns().length === deadSpawnBase,
    deadResume?.error?.message ?? "unexpected success");
  resetPool();

  // P3: enqueueTurn rebuild on a parked pin — the child idles out, the next
  // turn must spawn on a sibling, never restart on the banned HOME.
  process.env.AGY_IDLE_KILL_MS = "1500";
  resetPool();
  await startThread("t-rebuild-parked");
  await turn("t-rebuild-parked", "one", 1);
  const rebuildOwner = homeLabel(spawns().at(-1)?.__env?.HOME);
  {
    const ledger = readLedger();
    ledger.accounts[rebuildOwner] = { ...parkedEntry };
    writeLedger(ledger);
  }
  await sleep(2_500); // past the idle kill: the child is gone
  const rebuildSpawnBase = spawns().length;
  await turn("t-rebuild-parked", "two", 2);
  check("parked/rebuild-rotates-to-sibling",
    statuses("t-rebuild-parked") === "completed,completed" &&
    spawns().length === rebuildSpawnBase + 1 &&
    homeLabel(spawns().at(-1)?.__env?.HOME) !== rebuildOwner &&
    replacedFor("t-rebuild-parked").some((m) => m.params.contextLost === true),
    `${statuses("t-rebuild-parked")} owner=${rebuildOwner} spawn=${homeLabel(spawns().at(-1)?.__env?.HOME)}`);
  stop("t-rebuild-parked");

  // P4: the same rebuild with every account parked → the queued turn fails
  // honestly instead of respawning on the banned HOME.
  resetPool();
  await startThread("t-rebuild-dead");
  await turn("t-rebuild-dead", "one", 1);
  {
    const ledger = readLedger();
    for (const l of readdirSync(join(root, "accounts"))) {
      ledger.accounts[l] = { ...parkedEntry };
    }
    writeLedger(ledger);
  }
  await sleep(2_500);
  const deadSpawnBase2 = spawns().length;
  await turn("t-rebuild-dead", "two", 2);
  const deadTurnErr = boundaries("t-rebuild-dead").at(-1)?.error?.message ?? "";
  check("parked/rebuild-all-parked-fails",
    statuses("t-rebuild-dead") === "completed,failed" &&
    spawns().length === deadSpawnBase2 &&
    (/parked/iu.test(deadTurnErr) || errorsFor("t-rebuild-dead").some((e) => /parked/iu.test(e.message ?? ""))),
    `${statuses("t-rebuild-dead")} err=${deadTurnErr.slice(0, 120)}`);
  stop("t-rebuild-dead");
  process.env.AGY_IDLE_KILL_MS = "0";

  // P5: compaction restore on a parked owner — seed fails twice, then the
  // restore must open a FRESH conversation on a free sibling; resuming the
  // old conversation would mean launching agy on the banned HOME.
  resetPool();
  process.env.AGY_FAKE_ERROR_MODE = "compact-fail";
  process.env.AGY_FAKE_SUMMARY_MODE = "ok";
  process.env.AGY_FAKE_SEED_MODE = "fail";
  process.env.AGY_FAKE_FRESH_IDS = "1";
  await startThread("t-cf-parked");
  await turn("t-cf-parked", "first successful turn", 1);
  const cfOwner = homeLabel(spawns().at(-1)?.__env?.HOME);
  const cfOldConv = cfIdentities("t-cf-parked").at(-1);
  {
    const ledger = readLedger();
    ledger.accounts[cfOwner] = { ...parkedEntry };
    writeLedger(ledger);
  }
  const cfSpawnBase = spawns().length;
  send({ jsonrpc: "2.0", id: nextId++, method: "turn/start", params: { threadId: "t-cf-parked", providerThreadId: "fake-conv-rotation",
    input: [{ type: "text", text: "/compact", mentions: [] }], clientRequestId: creq(), options } });
  // Queued behind the whole compact chain; lands on the restore's sibling.
  await turn("t-cf-parked", "queued user turn", 6);
  const cfSpawns = spawns().slice(cfSpawnBase);
  const cfLast = cfSpawns.at(-1);
  check("parked/compact-restore-moves-to-sibling-fresh",
    statuses("t-cf-parked") === "completed,failed,completed,failed,failed,completed" &&
    cfLast !== undefined && homeLabel(cfLast.__env?.HOME) !== cfOwner &&
    !cfLast.__argv?.includes("--conversation") &&
    cfIdentities("t-cf-parked").at(-1) !== cfOldConv,
    `${statuses("t-cf-parked")} owner=${cfOwner} last=${homeLabel(cfLast?.__env?.HOME)} ` +
      `argv=${JSON.stringify(cfLast?.__argv?.includes("--conversation"))}`);
  check("parked/compact-restore-notice-honest",
    replacedFor("t-cf-parked").at(-1)?.params.contextLost === true &&
    /parked/iu.test(replacedFor("t-cf-parked").at(-1)?.params.reason ?? ""),
    JSON.stringify(replacedFor("t-cf-parked").map((m) => m.params.contextLost)));
  stop("t-cf-parked");
  delete process.env.AGY_FAKE_SEED_MODE;
  delete process.env.AGY_FAKE_SUMMARY_MODE;
  delete process.env.AGY_FAKE_FRESH_IDS;
  delete process.env.AGY_FAKE_COMPACT_MODE;
  process.env.AGY_FAKE_ERROR_MODE = "succeed";
  resetPool();
}

activeBridge.onClose?.();
// A separately imported bridge that never received start has no dataDir.
activeBridge = (await import(new URL("./dist/host.js?without-data-dir", import.meta.url).href)).experimental_providerBridge;
process.env.AGY_FAKE_ERROR_MODE = "ineligible";
process.env.FAKE_INELIGIBLE_LABEL = homeLabel(process.env.HOME);
await expectStartupFailure("t-ineligible-no-data-dir", VERIFY_URL);
activeBridge.onClose?.();
await sleep(100);

// ---- PLUG-301 ACP phase (spec §2.3): model-aware selection drives
// rotation — quota waits on the only carrier, model changes and in-flight
// refusals rotate to a suitable sibling, tos-disabled parks the account
// forever, and stale catalog entries are marked unsupported on refusal.
{
  const acpData = join(root, "acp-data");
  for (const label of ["m1", "m2", "m3", "m4"]) {
    const cli = join(acpData, "accounts", label, ".gemini", "antigravity-cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
  }
  const acpShim = join(root, "agy-acp-shim");
  const acpFake = new URL("./fake-agy-acp.mjs", import.meta.url).pathname;
  writeFileSync(acpShim, `#!/bin/sh\nexec /usr/bin/node ${acpFake} "$@"\n`);
  chmodSync(acpShim, 0o755);
  process.env.AGY_PATH = acpShim;
  delete process.env.AGY_TRANSPORT;
  delete process.env.AGY_FAKE_ERROR_MODE;
  delete process.env.AGY_FAKE_MODE_BY_LABEL;
  delete process.env.AGY_FAKE_SUMMARY_MODE;
  delete process.env.AGY_FAKE_COMPACT_MODE;
  delete process.env.AGY_FAKE_SEED_MODE;
  delete process.env.FAKE_INELIGIBLE_LABEL;
  process.env.AGY_IDLE_KILL_MS = "0";
  process.env.AGY_AUTO_RETRY_MAX = "2";
  process.env.AGY_AUTO_RETRY_MAX_WAIT_MS = "30000";
  process.env.AGY_FAKE_QUOTA_MSG = "Quota exhausted for this account; retry later. Resets in 0h0m3s.";
  process.env.AGY_FAKE_TRANSCRIPT = join(root, "acp-stdin.ndjson");
  process.env.AGY_FAKE_CONTROL = join(root, "acp-control.json");
  const acpControl = { modelsByLabel: {
    m1: [["fake-model", "Fake Model"]],
    m2: [["fake-model", "Fake Model"], ["pro-model", "Pro Model"], ["solo-model", "Solo Model"]],
    m3: [["fake-model", "Fake Model"], ["pro-model", "Pro Model"]],
    m4: [["fake-model", "Fake Model"]],
  } };
  const writeAcpControl = () =>
    writeFileSync(process.env.AGY_FAKE_CONTROL, JSON.stringify(acpControl, null, 1));
  writeAcpControl();
  writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify({ accounts: {} }, null, 1));

  const acpTranscript = () =>
    (existsSync(process.env.AGY_FAKE_TRANSCRIPT)
      ? readFileSync(process.env.AGY_FAKE_TRANSCRIPT, "utf8")
      : "")
      .split("\n").filter((l) => l.trim().length > 0)
      .map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const acpNews = (label) => acpTranscript().filter((l) => l.method === "session/new" && l.home === label).length;
  const readAcpLedger = () => {
    const shared = JSON.parse(readFileSync(join(acpData, "accounts-state.json"), "utf8"));
    let local = {};
    try {
      local = JSON.parse(readFileSync(join(acpData, "conversations-state.json"), "utf8")).conversations ?? {};
    } catch { /* absent */ }
    return { ...shared, conversations: { ...(shared.conversations ?? {}), ...local } };
  };
  const writeAcpLedger = (ledger) => {
    writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify(ledger));
    try { unlinkSync(join(acpData, "accounts-overlay.json")); } catch { /* absent */ }
    try { unlinkSync(join(acpData, "conversations-state.json")); } catch { /* absent */ }
  };
  const readAcpModels = () => {
    try {
      return JSON.parse(readFileSync(join(acpData, "accounts-models.json"), "utf8")).accounts ?? {};
    } catch { return {}; }
  };
  const writeAcpModels = (accounts) =>
    writeFileSync(join(acpData, "accounts-models.json"), JSON.stringify({ accounts }, null, 1));
  // Set lastUsed so `winner` wins the LRU pick; the tos-disabled cooldown
  // is preserved so the parked-account checks stay valid.
  const favor = (winner) => {
    const ledger = readAcpLedger();
    for (const label of ["m1", "m2", "m3", "m4"]) {
      const entry = ledger.accounts[label] ?? { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null };
      if (entry.parkedReason !== "tos-disabled") entry.cooldownUntilMs = 0;
      entry.lastUsedMs = label === winner ? 0 : 1_700_000_000_000;
      ledger.accounts[label] = entry;
    }
    writeAcpLedger(ledger);
  };
  const newsSnapshot = () => ({ m1: acpNews("m1"), m2: acpNews("m2"), m3: acpNews("m3"), m4: acpNews("m4") });

  activeBridge = (await import(
    new URL("./dist/host.js?acp-rotation", import.meta.url).href
  )).experimental_providerBridge;
  activeBridge.start?.({ pluginId: "provider-agy", dataDir: acpData, tempDir: acpData });
  const acpThreads = new Map();
  const startModel = async (threadId, model) => {
    const startId = nextId++;
    send({ jsonrpc: "2.0", id: startId, method: "thread/start",
      params: { threadId, cwd: workspace, options: { model, ...pol }, instructionMode: "append" } });
    await waitFor(() => messages.some((m) => m.id === startId), 15_000, `${threadId}: start`);
    const reply = messages.find((m) => m.id === startId);
    if (typeof reply?.result?.providerThreadId === "string") {
      acpThreads.set(threadId, reply.result.providerThreadId);
    }
    return reply;
  };
  const turnModel = async (threadId, text, model, ordinal = 1) => {
    send({ jsonrpc: "2.0", id: nextId++, method: "turn/start",
      params: { threadId, providerThreadId: acpThreads.get(threadId),
        input: [{ type: "text", text, mentions: [] }], clientRequestId: creq(),
        options: { model, ...pol } } });
    await waitFor(() => boundaries(threadId).length >= ordinal, 30_000, `${threadId}: turn`);
  };
  // Populate accounts-models.json with one model/list (lazy per-account poll).
  const listId = nextId++;
  send({ jsonrpc: "2.0", id: listId, method: "model/list", params: {} });
  await waitFor(() => messages.some((m) => m.id === listId), 20_000, "acp model/list");
  check("models/per-account-catalogs-persist",
    ["m1", "m2", "m3", "m4"].every((l) => Array.isArray(readAcpModels()[l]?.families)) &&
    readAcpModels().m2.families.includes("solo-model") &&
    !readAcpModels().m1.families.includes("pro-model"),
    JSON.stringify(Object.fromEntries(Object.entries(readAcpModels()).map(([k, v]) => [k, v.families]))));

  // A. Quota on the only solo-model carrier: no suitable sibling exists, so
  // the wrapper waits out the reset and replays the turn on the same account.
  // quota-once is a per-home sentinel: the replayed prompt succeeds.
  acpControl.modeByLabel = { m2: "quota-once" };
  writeAcpControl();
  favor("m2");
  const newsA = newsSnapshot();
  await startModel("t-model-quota", "solo-model");
  await turnModel("t-model-quota", "wait on the only carrier", "solo-model");
  await sleep(300);
  const spawnedA = acpTranscript().filter((l) => l.method === "session/new").map((l) => l.home);
  check("models/quota-waits-on-the-only-carrier",
    statuses("t-model-quota") === "completed" &&
    acpNews("m2") === newsA.m2 + 2 &&
    acpNews("m1") === newsA.m1 && acpNews("m3") === newsA.m3 && acpNews("m4") === newsA.m4,
    `${statuses("t-model-quota")} homes=${JSON.stringify(spawnedA)}`);

  // The same model with the carrier cooled for an hour: honest failure and
  // a blocked rateLimits named by that account's cooldown end.
  {
    const ledger = readAcpLedger();
    ledger.accounts.m2.cooldownUntilMs = Date.now() + 3_600_000;
    ledger.accounts.m2.lastError = "test-injected solo cooldown";
    writeAcpLedger(ledger);
  }
  const resetsAt = Date.now() + 3_600_000;
  await startModel("t-model-blocked", "solo-model");
  const blockTurnId = nextId++;
  send({ jsonrpc: "2.0", id: blockTurnId, method: "turn/start",
    params: { threadId: "t-model-blocked", providerThreadId: acpThreads.get("t-model-blocked"),
      input: [{ type: "text", text: "still blocked", mentions: [] }],
      clientRequestId: creq(), options: { model: "solo-model", ...pol } } });
  await waitFor(() => messages.some((m) => m.id === blockTurnId), 15_000, "t-model-blocked: turn reply");
  const blockReply = messages.find((m) => m.id === blockTurnId);
  const blockedDelta = messages.find((m) => m.method === "thread/delta"
    && m.params?.threadId === "t-model-blocked"
    && (m.params.deltas ?? []).some((d) => d.kind === "provider.rateLimits" && d.rateLimits?.status === "blocked"));
  const blockedWindow = (blockedDelta?.params?.deltas ?? [])
    .find((d) => d.kind === "provider.rateLimits")?.rateLimits?.windows?.[0];
  check("models/blocked-ratelimits-name-carrier-reset",
    blockReply?.error?.message === "account in quota cooldown" &&
    typeof blockedWindow?.resetsAtMs === "number" &&
    Math.abs(blockedWindow.resetsAtMs - resetsAt) < 15_000,
    `err=${blockReply?.error?.message ?? "none"} resetsAt=${blockedWindow?.resetsAtMs ?? "none"}`);
  writeAcpLedger(readAcpLedger()); // keep entries; drop per-instance pins
  acpControl.modeByLabel = {};
  writeAcpControl();

  // B. A turn-level model change the pinned account cannot serve rotates to
  // a suitable sibling — without recording any cooldown on the old one.
  {
    const ledger = readAcpLedger();
    ledger.accounts.m2.cooldownUntilMs = 0;
    ledger.accounts.m2.lastError = null;
    writeAcpLedger(ledger);
  }
  favor("m1");
  const newsB = newsSnapshot();
  await startModel("t-model-change", "fake-model");
  await turnModel("t-model-change", "switch this thread to pro-model", "pro-model");
  await sleep(200);
  check("models/turn-start-model-change-rotates",
    statuses("t-model-change") === "completed" &&
    acpNews("m1") === newsB.m1 + 1 &&
    (acpNews("m2") === newsB.m2 + 1 || acpNews("m3") === newsB.m3 + 1) &&
    acpNews("m4") === newsB.m4 &&
    replacedFor("t-model-change").some((m) =>
      typeof m.params?.reason === "string" && m.params.reason.includes("does not offer the selected model")),
    `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsB)}`);
  check("models/rotation-takes-no-cooldown",
    (readAcpLedger().accounts.m1?.cooldownUntilMs ?? 0) === 0 &&
    readAcpLedger().accounts.m1?.parkedReason === undefined,
    JSON.stringify(readAcpLedger().accounts.m1 ?? null));

  // C. An in-flight "Unknown model ID" on m2 marks the family unsupported
  // and replays the turn on a suitable sibling. unknown-model-once is a
  // per-home sentinel, so the handoff's replay on m3 answers normally.
  acpControl.modeByLabel = { m2: "unknown-model-once" };
  writeAcpControl();
  favor("m2");
  const newsC = newsSnapshot();
  await startModel("t-model-inflight", "pro-model");
  await turnModel("t-model-inflight", "hits mid-flight", "pro-model");
  await sleep(200);
  check("models/inflight-refusal-marks-unsupported",
    (readAcpModels().m2?.unsupported?.["pro-model"] ?? 0) > 0,
    JSON.stringify(readAcpModels().m2?.unsupported ?? null));
  check("models/inflight-refusal-rotates-suitable",
    statuses("t-model-inflight") === "completed" &&
    acpNews("m3") === newsC.m3 + 1 &&
    acpNews("m1") === newsC.m1 && acpNews("m4") === newsC.m4,
    `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsC)}`);

  // C2. The same in-flight refusal, but the only other suitable carrier
  // is cooling: §2.3 п.5 wants the whole-pool-cooled branch — rateLimits
  // blocked to the carrier's resetsAt — not the false "not offered".
  // m2's pro-model mark from case C is lifted and replaced by a 1h
  // cooldown, so m3 is the only live carrier when its turn refuses. The
  // whole catalog is restored afterwards so later cases see case C's
  // world (m2 marked, m3 free).
  const modelsBeforeC2 = readAcpModels();
  favor("m3");
  {
    const models = readAcpModels();
    delete models.m2?.unsupported?.["pro-model"];
    writeAcpModels(models);
  }
  {
    const ledger = readAcpLedger();
    ledger.accounts.m2.cooldownUntilMs = Date.now() + 3_600_000;
    ledger.accounts.m2.lastError = "test-injected pro cooldown";
    writeAcpLedger(ledger);
  }
  const proCooldownEnd = readAcpLedger().accounts.m2.cooldownUntilMs;
  acpControl.modeByLabel = { m3: "unknown-model-once" };
  writeAcpControl();
  const newsC2 = newsSnapshot();
  await startModel("t-model-cooled", "pro-model");
  const cooledTurnId = nextId++;
  send({ jsonrpc: "2.0", id: cooledTurnId, method: "turn/start",
    params: { threadId: "t-model-cooled", providerThreadId: acpThreads.get("t-model-cooled"),
      input: [{ type: "text", text: "carrier cooling", mentions: [] }],
      clientRequestId: creq(), options: { model: "pro-model", ...pol } } });
  await waitFor(() => boundaries("t-model-cooled").length >= 1, 30_000, "t-model-cooled: failed turn");
  await sleep(200);
  const cooledBlocked = messages.find((m) => m.method === "thread/delta"
    && m.params?.threadId === "t-model-cooled"
    && (m.params.deltas ?? []).some((d) => d.kind === "provider.rateLimits" && d.rateLimits?.status === "blocked"));
  const cooledWindow = (cooledBlocked?.params?.deltas ?? [])
    .find((d) => d.kind === "provider.rateLimits")?.rateLimits?.windows?.[0];
  const cooledErr = errorsFor("t-model-cooled").at(-1);
  check("models/cooled-carrier-emits-ratelimits",
    boundaries("t-model-cooled").at(-1)?.status === "failed" &&
    typeof cooledWindow?.resetsAtMs === "number" &&
    Math.abs(cooledWindow.resetsAtMs - proCooldownEnd) < 15_000 &&
    cooledErr?.errorInfo?.category === "rate-limit" &&
    !String(cooledErr?.message ?? "").includes("is not offered by any pool account"),
    `resetsAt=${cooledWindow?.resetsAtMs ?? "none"} err=${String(cooledErr?.message ?? "").slice(0, 120)}`);
  check("models/cooled-carrier-no-sibling-spawned",
    acpNews("m3") === newsC2.m3 + 1 && acpNews("m2") === newsC2.m2,
    `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsC2)}`);
  writeAcpModels(modelsBeforeC2);
  {
    const ledger = readAcpLedger();
    ledger.accounts.m2.cooldownUntilMs = 0;
    ledger.accounts.m2.lastError = null;
    writeAcpLedger(ledger);
  }
  acpControl.modeByLabel = {};
  writeAcpControl();

  // D. A model no account offers fails honestly — nothing is spawned.
  const newsD = newsSnapshot();
  const ghostReply = await startModel("t-model-nowhere", "ghost-model");
  check("models/unoffered-model-fails-honestly",
    ghostReply.error?.message === "model ghost-model is not offered by any pool account" &&
    acpNews("m1") === newsD.m1 && acpNews("m2") === newsD.m2 &&
    acpNews("m3") === newsD.m3 && acpNews("m4") === newsD.m4 &&
    replacedFor("t-model-nowhere").length === 0,
    ghostReply.error?.message ?? "unexpected success");

  // E. tos-disabled: parked until a manual clear, never picked again.
  // tos-once is a per-home sentinel — the sibling's replay answers normally.
  acpControl.modeByLabel = { m1: "tos-once" };
  writeAcpControl();
  favor("m1");
  const newsE = newsSnapshot();
  await startModel("t-tos", "fake-model");
  await turnModel("t-tos", "disable the account", "fake-model");
  await sleep(200);
  const tosEntry = readAcpLedger().accounts.m1 ?? {};
  check("models/tos-parks-account-permanently",
    tosEntry.parkedReason === "tos-disabled" &&
    (tosEntry.ineligibleAtMs ?? 0) > 0 &&
    tosEntry.cooldownUntilMs > Date.now() + 365 * 24 * 3_600_000 &&
    statuses("t-tos") === "completed" &&
    (acpNews("m2") === newsE.m2 + 1 || acpNews("m3") === newsE.m3 + 1 || acpNews("m4") === newsE.m4 + 1),
    JSON.stringify(tosEntry));
  favor("m1"); // tos cooldown survives favor(); LRU favours m1 anyway
  const newsE2 = newsSnapshot();
  await startModel("t-tos-next", "fake-model");
  check("models/tos-account-never-repicked",
    acpNews("m1") === newsE2.m1 &&
    (acpNews("m2") === newsE2.m2 + 1 || acpNews("m3") === newsE2.m3 + 1 || acpNews("m4") === newsE2.m4 + 1),
    `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsE2)}`);

  // F. Resume on an owner that does not offer the requested model becomes a
  // fresh start on a suitable sibling — the owner is never spawned.
  favor("m1");
  const ownerReply = await startModel("t-resume-owner", "fake-model");
  const ownerConv = ownerReply.result?.providerThreadId;
  stop("t-resume-owner");
  await sleep(100);
  const newsF = newsSnapshot();
  const resumeId = nextId++;
  send({ jsonrpc: "2.0", id: resumeId, method: "thread/resume",
    params: { threadId: "t-resume-unfit", providerThreadId: ownerConv, cwd: workspace,
      options: { model: "pro-model", ...pol }, instructionMode: "append" } });
  await waitFor(() => messages.some((m) => m.id === resumeId), 15_000, "t-resume-unfit: resume");
  const resumeReply = messages.find((m) => m.id === resumeId);
  check("models/resume-unfit-owner-moves-to-sibling",
    !resumeReply?.error &&
    acpNews("m1") === newsF.m1 &&
    (acpNews("m2") === newsF.m2 + 1 || acpNews("m3") === newsF.m3 + 1) &&
    replacedFor("t-resume-unfit").some((m) =>
      typeof m.params?.reason === "string" && m.params.reason.includes("does not offer the selected model")),
    resumeReply?.error?.message ?? `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsF)}`);

  // G. A stale catalog entry (m4 claims pro-model the fake does not have)
  // is refused at session build, marked unsupported and retried on a
  // suitable sibling.
  const seeded = readAcpModels();
  seeded.m4 = {
    raw: [{ id: "fake-model", displayName: "Fake Model" }, { id: "pro-model", displayName: "Pro Model" }],
    families: ["fake-model", "pro-model"],
    unsupported: {},
    atMs: Date.now(),
  };
  writeAcpModels(seeded);
  favor("m4");
  const newsG = newsSnapshot();
  const staleReply = await startModel("t-model-stale", "pro-model");
  await sleep(200);
  check("models/stale-catalog-retries-suitable",
    !staleReply?.error &&
    acpNews("m4") === newsG.m4 + 1 &&
    (acpNews("m2") === newsG.m2 + 1 || acpNews("m3") === newsG.m3 + 1) &&
    (readAcpModels().m4?.unsupported?.["pro-model"] ?? 0) > 0,
    staleReply?.error?.message ?? `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsG)}`);

  // H. §2.3 п.7 — "parked" is parkedReason alone, never "parked and still
  // cooling": every launch path treats the owner as untouchable even when
  // cooldownUntilMs already expired (parkedReason has no expiry — only an
  // operator clears it). The ledger is written directly so the
  // conversation pin (the resume's owner lookup) survives in
  // conversations-state.json.
  favor("m4");
  const parkedOwnerStart = await startModel("t-parked-owner", "fake-model");
  const parkedOwnerConv = parkedOwnerStart.result?.providerThreadId;
  stop("t-parked-owner");
  await sleep(100);
  const parkedEntry = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: "tos", ineligibleAtMs: 1, parkedReason: "tos-disabled" };
  // H1: no free sibling — honest parked-pool error, zero launches.
  writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify({ accounts: {
    m1: { ...parkedEntry }, m2: { ...parkedEntry }, m3: { ...parkedEntry }, m4: { ...parkedEntry },
  } }, null, 1));
  const newsH = newsSnapshot();
  const loadsBeforeH = acpTranscript().filter((l) => l.method === "session/load").length;
  const parkedResumeId = nextId++;
  send({ jsonrpc: "2.0", id: parkedResumeId, method: "thread/resume",
    params: { threadId: "t-resume-parked", providerThreadId: parkedOwnerConv, cwd: workspace,
      options: { model: "fake-model", ...pol }, instructionMode: "append" } });
  await waitFor(() => messages.some((m) => m.id === parkedResumeId), 15_000, "t-resume-parked: resume");
  const parkedResumeReply = messages.find((m) => m.id === parkedResumeId);
  check("models/resume-parked-owner-fails-honestly",
    parkedResumeReply?.error !== undefined && /parked/iu.test(parkedResumeReply.error.message ?? ""),
    parkedResumeReply?.error?.message ?? "unexpected success");
  check("models/resume-parked-owner-no-launch",
    acpNews("m1") + acpNews("m2") + acpNews("m3") + acpNews("m4") ===
      newsH.m1 + newsH.m2 + newsH.m3 + newsH.m4 &&
    acpTranscript().filter((l) => l.method === "session/load").length === loadsBeforeH,
    `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsH)} ` +
      `loads=${acpTranscript().filter((l) => l.method === "session/load").length} before=${loadsBeforeH}`);

  // H2: one free sibling — the resume leaves the banned owner for it.
  writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify({ accounts: {
    m1: { ...parkedEntry }, m2: { ...parkedEntry }, m4: { ...parkedEntry },
    m3: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null },
  } }, null, 1));
  const newsH2 = newsSnapshot();
  const sibResumeId = nextId++;
  send({ jsonrpc: "2.0", id: sibResumeId, method: "thread/resume",
    params: { threadId: "t-resume-parked-sib", providerThreadId: parkedOwnerConv, cwd: workspace,
      options: { model: "fake-model", ...pol }, instructionMode: "append" } });
  await waitFor(() => messages.some((m) => m.id === sibResumeId), 15_000, "t-resume-parked-sib: resume");
  const sibResumeReply = messages.find((m) => m.id === sibResumeId);
  check("models/resume-parked-owner-uses-sibling",
    !sibResumeReply?.error &&
    acpNews("m3") === newsH2.m3 + 1 &&
    acpNews("m4") === newsH2.m4 &&
    acpTranscript().filter((l) => l.method === "session/load").length === loadsBeforeH &&
    replacedFor("t-resume-parked-sib").some((m) =>
      typeof m.params?.reason === "string" && m.params.reason.includes("disabled by Google")),
    sibResumeReply?.error?.message ?? `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsH2)}`);

  // H3: a turn on a session whose owner is parked — cooldown expired —
  // rotates to the sibling instead of replaying on the banned home.
  writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify({ accounts: {
    m1: { ...parkedEntry }, m2: { ...parkedEntry },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null },
    m4: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null },
  } }, null, 1));
  await startModel("t-turn-parked", "fake-model");
  await turnModel("t-turn-parked", "first on m4", "fake-model");
  const newsH3 = newsSnapshot();
  writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify({ accounts: {
    m1: { ...parkedEntry }, m2: { ...parkedEntry },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null },
    m4: { ...parkedEntry },
  } }, null, 1));
  await turnModel("t-turn-parked", "must leave the parked owner", "fake-model", 2);
  await sleep(200);
  check("models/turn-on-parked-owner-rotates",
    statuses("t-turn-parked") === "completed,completed" &&
    acpNews("m3") === newsH3.m3 + 1 &&
    acpNews("m4") === newsH3.m4 &&
    replacedFor("t-turn-parked").some((m) =>
      typeof m.params?.reason === "string" && m.params.reason.includes("disabled by Google")),
    `${statuses("t-turn-parked")} news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsH3)}`);

  // H4 (E2E C6): a queued turn whose rotation finds every sibling parked
  // fails on the turn/start reply alone — no provider.error delta repeats
  // the same text in the thread.
  const errsBeforeH4 = errorsFor("t-turn-parked").length;
  writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify({ accounts: {
    m1: { ...parkedEntry }, m2: { ...parkedEntry },
    m3: { ...parkedEntry }, m4: { ...parkedEntry },
  } }, null, 1));
  const dupTurnId = nextId++;
  send({ jsonrpc: "2.0", id: dupTurnId, method: "turn/start",
    params: { threadId: "t-turn-parked", providerThreadId: acpThreads.get("t-turn-parked"),
      input: [{ type: "text", text: "every sibling is parked", mentions: [] }],
      clientRequestId: creq(), options: { model: "fake-model", ...pol } } });
  await waitFor(() => messages.some((m) => m.id === dupTurnId), 15_000, "t-turn-parked: parked turn reply");
  await sleep(200);
  const dupReply = messages.find((m) => m.id === dupTurnId);
  check("models/turn-refusal-single-error",
    typeof dupReply?.error?.message === "string" &&
    dupReply.error.message.includes("disabled by Google") &&
    errorsFor("t-turn-parked").length === errsBeforeH4,
    `err=${dupReply?.error?.message ?? "none"} deltas=${errorsFor("t-turn-parked").length}`);

  const acpProbes = (label) =>
    acpTranscript().filter((l) => l.__models === true && l.home === label).length;
  const freshRecord = (ids) => ({
    raw: ids.map((id) => ({ id, displayName: id })),
    families: ids,
    unsupported: {},
    atMs: Date.now(),
  });

  // I+J. §2.3 п.9 cold start — on FRESH bridge instances: the probe
  // throttle lives in module memory, so a bridge that already polled every
  // label in the lazy-poll case cannot show the wait-and-probe path again.
  // Each variant gets its own dataDir and import query (fresh module
  // state). The model lives only on m4 — the JUNIOR tier (priority 5, vs
  // the senior m1–m3 at 10): without the probe wait the pick falls back
  // to the highest-priority guess and lands on m1.
  const coldStartRun = async (threadId, dataDirName, seedModels, seedLedger) => {
    const dir = join(root, dataDirName);
    for (const label of ["m1", "m2", "m3", "m4"]) {
      const cli = join(dir, "accounts", label, ".gemini", "antigravity-cli");
      mkdirSync(cli, { recursive: true });
      writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
    }
    writeFileSync(join(dir, "accounts-state.json"), JSON.stringify(seedLedger ?? { accounts: {
      m1: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
      m2: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
      m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
      m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 5 },
    } }, null, 1));
    if (seedModels !== null) {
      writeFileSync(join(dir, "accounts-models.json"), JSON.stringify({ accounts: seedModels }, null, 1));
    }
    const bridge = (await import(
      new URL(`./dist/host.js?${dataDirName}`, import.meta.url).href
    )).experimental_providerBridge;
    bridge.start?.({ pluginId: "provider-agy", dataDir: dir, tempDir: dir });
    const prev = activeBridge;
    activeBridge = bridge;
    const news = newsSnapshot();
    const probes = { m1: acpProbes("m1"), m2: acpProbes("m2"), m3: acpProbes("m3"), m4: acpProbes("m4") };
    const reply = await startModel(threadId, "cold-model");
    await sleep(200);
    activeBridge = prev;
    return { reply, news, probes };
  };
  const coldStartCheck = (tag, run, probeLabels) => check(tag,
    !run.reply?.error &&
    acpNews("m4") === run.news.m4 + 1 &&
    acpNews("m1") === run.news.m1 && acpNews("m2") === run.news.m2 &&
    acpNews("m3") === run.news.m3 &&
    probeLabels.every((l) => acpProbes(l) > run.probes[l]),
    run.reply?.error?.message ??
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(run.news)} ` +
      `probes m1=${acpProbes("m1")}/${run.probes.m1} m3=${acpProbes("m3")}/${run.probes.m3} ` +
      `m4=${acpProbes("m4")}/${run.probes.m4}`);
  acpControl.modeByLabel = {};
  acpControl.modelsByLabel = {
    m1: [["fake-model", "Fake Model"]],
    m2: [["fake-model", "Fake Model"]],
    m3: [["fake-model", "Fake Model"]],
    m4: [["fake-model", "Fake Model"], ["cold-model", "Cold Model"]],
  };
  writeAcpControl();
  // I: no accounts-models.json at all — every account recordless.
  coldStartCheck("models/cold-start-waits-catalogs",
    await coldStartRun("t-cold-start", "acp-cold1", null),
    ["m1", "m2", "m3", "m4"]);
  // J: every record is raw:[]/families:[] — "unknown", probed alike.
  coldStartCheck("models/empty-record-is-probed",
    await coldStartRun("t-cold-empty", "acp-cold2",
      Object.fromEntries(["m1", "m2", "m3", "m4"].map((l) =>
        [l, { raw: [], families: [], unsupported: {}, atMs: 0 }]))),
    ["m1", "m2", "m3", "m4"]);
  // N: §2.3 п.9 (ревизия 13.1) — only TWO unknown accounts: their probes
  // launch immediately (≤2 slots) and are already stamped by the time the
  // wait decision runs — the pick must still wait for them instead of
  // guessing m3 by LRU.
  coldStartCheck("models/cold-start-few-unknowns",
    await coldStartRun("t-cold-few", "acp-cold3",
      {
        m1: freshRecord(["fake-model"]),
        m2: freshRecord(["fake-model"]),
      },
      { accounts: {
        m1: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
        m2: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
        m3: { cooldownUntilMs: 0, lastUsedMs: 100, lastError: null, priority: 10 },
        m4: { cooldownUntilMs: 0, lastUsedMs: 500, lastError: null, priority: 10 },
      } }),
    ["m3", "m4"]);

  // K. §2.3 п.10 session-build refusal: records claim pro on m1/m2/m4
  // (fresh) and m3 (STALE — exactly the guess the fresh-only filter must
  // reject, LRU-first among siblings) while the fake serves it nowhere —
  // exactly ONE hop (m1 → m2), then the honest "not offered". m3's and
  // m4's spawns stay untouched.
  writeAcpModels({
    m1: freshRecord(["fake-model", "pro-model"]),
    m2: freshRecord(["fake-model", "pro-model"]),
    m3: { ...freshRecord(["fake-model", "pro-model"]), atMs: Date.now() - 7 * 3_600_000 },
    m4: freshRecord(["fake-model", "pro-model"]),
  });
  acpControl.modelsByLabel = {
    m1: [["fake-model", "Fake Model"]],
    m2: [["fake-model", "Fake Model"]],
    m3: [["fake-model", "Fake Model"]],
    m4: [["fake-model", "Fake Model"]],
  };
  acpControl.modeByLabel = {};
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 100, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 500, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  const newsK = newsSnapshot();
  const capReply = await startModel("t-model-cap", "pro-model");
  await sleep(300);
  check("models/refusal-moves-once-then-fails",
    typeof capReply?.error?.message === "string" &&
    capReply.error.message.includes("not offered") &&
    acpNews("m1") === newsK.m1 + 1 &&
    acpNews("m2") === newsK.m2 + 1 &&
    acpNews("m3") === newsK.m3 &&
    acpNews("m4") === newsK.m4 &&
    (readAcpModels().m1?.unsupported?.["pro-model"] ?? 0) > 0 &&
    (readAcpModels().m2?.unsupported?.["pro-model"] ?? 0) > 0 &&
    (readAcpModels().m3?.unsupported?.["pro-model"] ?? 0) === 0,
    `reply=${JSON.stringify(capReply?.error ?? capReply?.result ?? null)} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsK)}`);

  // L. §2.3 п.10 in-flight refusal: the session starts fine, the turn
  // refuses the model — again at most one move before the honest failure.
  writeAcpModels({
    m1: freshRecord(["fake-model", "pro-model"]),
    m2: freshRecord(["fake-model", "pro-model"]),
    m3: { ...freshRecord(["fake-model", "pro-model"]), atMs: Date.now() - 7 * 3_600_000 },
    m4: freshRecord(["fake-model", "pro-model"]),
  });
  acpControl.modelsByLabel = {
    m1: [["fake-model", "Fake Model"], ["pro-model", "Pro Model"]],
    m2: [["fake-model", "Fake Model"]],
    m3: [["fake-model", "Fake Model"]],
    m4: [["fake-model", "Fake Model"]],
  };
  acpControl.modeByLabel = { m1: "unknown-model-once" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 100, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 500, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  const newsL = newsSnapshot();
  await startModel("t-model-inflight-cap", "pro-model");
  await turnModel("t-model-inflight-cap", "model refused mid-flight", "pro-model");
  await sleep(400);
  const capErr = messages.some((m) => m.method === "thread/delta" &&
    m.params?.threadId === "t-model-inflight-cap" &&
    (m.params?.deltas ?? []).some((d) =>
      typeof d.message === "string" && d.message.includes("not offered")));
  check("models/inflight-refusal-moves-once",
    capErr &&
    acpNews("m1") === newsL.m1 + 1 &&
    acpNews("m2") === newsL.m2 + 1 &&
    acpNews("m3") === newsL.m3 &&
    acpNews("m4") === newsL.m4 &&
    (readAcpModels().m1?.unsupported?.["pro-model"] ?? 0) > 0 &&
    (readAcpModels().m2?.unsupported?.["pro-model"] ?? 0) > 0,
    `capErr=${capErr} news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsL)}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // M. §2.3 п.11: VALIDATION_REQUIRED arrives as ordinary agent text —
  // swallowed before the user sees it, account parked without expiry,
  // thread re-run on a sibling; the wrapper log journals the move.
  writeAcpModels({
    m1: freshRecord(["fake-model"]),
    m2: freshRecord(["fake-model"]),
    m3: freshRecord(["fake-model"]),
    m4: freshRecord(["fake-model"]),
  });
  acpControl.modeByLabel = { m1: "validation" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  const newsM = newsSnapshot();
  await startModel("t-validation", "fake-model");
  await turnModel("t-validation", "verify me", "fake-model");
  await sleep(400);
  const valEntry = readAcpLedger().accounts.m1 ?? {};
  const valSawText = messages.some((m) => m.method === "thread/delta" &&
    (m.params?.deltas ?? []).some((d) =>
      typeof d.text === "string" && d.text.includes("Verification Required")));
  check("models/validation-parks-and-moves",
    valEntry.parkedReason === "validation-required" &&
    (valEntry.cooldownUntilMs ?? 0) > Date.now() + 365 * 24 * 3_600_000 &&
    !valSawText &&
    statuses("t-validation") === "completed" &&
    acpNews("m1") === newsM.m1 + 1 &&
    acpNews("m2") + acpNews("m3") + acpNews("m4") ===
      newsM.m2 + newsM.m3 + newsM.m4 + 1,
    `entry=${JSON.stringify(valEntry)} sawText=${valSawText} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsM)}`);
  const wrapLog = readFileSync(join(acpData, "acp-wrapper.log"), "utf8");
  check("models/move-journal-lines",
    wrapLog.includes("parked (validation-required") &&
    /move m1 → m[234] \(validation-required\)/u.test(wrapLog),
    "acp-wrapper.log lacks the move/park journal lines");

  // Manual unpark revives the account (§2.3 п.11: operator clears the mark).
  {
    const ledger = readAcpLedger();
    delete ledger.accounts.m1.parkedReason;
    delete ledger.accounts.m1.ineligibleAtMs;
    ledger.accounts.m1.cooldownUntilMs = 0;
    ledger.accounts.m1.lastUsedMs = 0;
    ledger.accounts.m1.lastError = null;
    writeAcpLedger(ledger);
  }
  const newsM2 = newsSnapshot();
  await startModel("t-unparked", "fake-model");
  await sleep(200);
  check("models/validation-manual-unpark",
    acpNews("m1") === newsM2.m1 + 1,
    `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsM2)}`);

  // No free sibling → honest "needs Google account verification", still no
  // ⚠ text and no launch anywhere else.
  acpControl.modeByLabel = { m1: "validation" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { ...parkedEntry }, m3: { ...parkedEntry }, m4: { ...parkedEntry },
  } });
  const newsM3 = newsSnapshot();
  await startModel("t-validation-fail", "fake-model");
  await turnModel("t-validation-fail", "verify me again", "fake-model");
  await sleep(400);
  const vFailErr = messages.some((m) => m.method === "thread/delta" &&
    m.params?.threadId === "t-validation-fail" &&
    (m.params?.deltas ?? []).some((d) =>
      typeof d.message === "string" && d.message.includes("needs Google account verification")));
  const vFailSawText = messages.some((m) => m.method === "thread/delta" &&
    m.params?.threadId === "t-validation-fail" &&
    (m.params?.deltas ?? []).some((d) =>
      typeof d.text === "string" && d.text.includes("Verification Required")));
  check("models/validation-no-sibling-fails",
    vFailErr && !vFailSawText &&
    boundaries("t-validation-fail").at(-1)?.status === "failed" &&
    acpNews("m2") + acpNews("m3") + acpNews("m4") ===
      newsM3.m2 + newsM3.m3 + newsM3.m4,
    `vFailErr=${vFailErr} sawText=${vFailSawText} ` +
      `boundaries=${statuses("t-validation-fail")} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsM3)}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // O. §2.3 п.11 (ревизия 13.1): the marker tokens inside ORDINARY agent
  // prose never park — only the exact whole-message "⚠ Verification
  // Required" does. The fake echoes the prompt tail, so the tokens sit
  // mid-message.
  writeAcpModels({
    m1: freshRecord(["fake-model"]),
    m2: freshRecord(["fake-model"]),
    m3: freshRecord(["fake-model"]),
    m4: freshRecord(["fake-model"]),
  });
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  await startModel("t-validation-prose", "fake-model");
  await turnModel("t-validation-prose", "please explain VALIDATION_REQUIRED today", "fake-model");
  await turnModel("t-validation-prose", "what does verify your account to continue mean", "fake-model", 2);
  await turnModel("t-validation-prose", "the log showed ⚠ Verification Required and then nothing", "fake-model", 3);
  // The token now lives in recentAssistantText — the NEXT turn must not
  // trip on the previous turn's tail (ревизия 13.1).
  await turnModel("t-validation-prose", "and one ordinary follow-up", "fake-model", 4);
  await sleep(300);
  const proseEntry = readAcpLedger().accounts.m1 ?? {};
  const proseSaw = messages.some((m) => m.method === "thread/delta" &&
    m.params?.threadId === "t-validation-prose" &&
    (m.params?.deltas ?? []).some((d) =>
      typeof d.text === "string" && d.text.includes("VALIDATION_REQUIRED")));
  check("models/validation-prose-not-parked",
    proseEntry.parkedReason === undefined &&
    (proseEntry.cooldownUntilMs ?? 0) <= Date.now() &&
    statuses("t-validation-prose") === "completed,completed,completed,completed" &&
    proseSaw,
    `entry=${JSON.stringify(proseEntry)} saw=${proseSaw} ` +
      `statuses=${statuses("t-validation-prose")}`);

  // O2. §2.3 п.13: the quota window reported as ordinary agent text —
  // swallowed, the account cooled until the stated reset (~127h, far past
  // the wait cap), the turn re-run on a sibling.
  const quotaSaw = (id) => messages.some((m) => m.method === "thread/delta" &&
    m.params?.threadId === id &&
    JSON.stringify(m.params?.deltas ?? []).includes("Individual quota reached"));
  const freshFour = () => ({
    m1: freshRecord(["fake-model"]),
    m2: freshRecord(["fake-model"]),
    m3: freshRecord(["fake-model"]),
    m4: freshRecord(["fake-model"]),
  });
  writeAcpModels(freshFour());
  acpControl.modeByLabel = { m1: "quota-text" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  const newsO2 = newsSnapshot();
  const o2LogOffset = readFileSync(join(acpData, "acp-wrapper.log"), "utf8").length;
  await startModel("t-quota-text", "fake-model");
  await turnModel("t-quota-text", "burn the window", "fake-model");
  await sleep(400);
  const qtEntry = readAcpLedger().accounts.m1 ?? {};
  const qtCoolH = ((qtEntry.cooldownUntilMs ?? 0) - Date.now()) / 3_600_000;
  check("models/quota-text-cools-and-moves",
    qtEntry.parkedReason === undefined &&
    qtCoolH > 127 && qtCoolH < 128 &&
    String(qtEntry.lastError ?? "").includes("Individual quota reached") &&
    !quotaSaw("t-quota-text") &&
    statuses("t-quota-text") === "completed" &&
    acpNews("m1") === newsO2.m1 + 1 &&
    acpNews("m2") + acpNews("m3") + acpNews("m4") ===
      newsO2.m2 + newsO2.m3 + newsO2.m4 + 1,
    `entry=${JSON.stringify(qtEntry)} coolH=${qtCoolH} saw=${quotaSaw("t-quota-text")} ` +
      `statuses=${statuses("t-quota-text")} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsO2)}`);
  check("models/quota-text-journal-lines",
    /move m1 → m[234] \(quota\)/u.test(
      readFileSync(join(acpData, "acp-wrapper.log"), "utf8").slice(o2LogOffset)),
    "acp-wrapper.log lacks the quota move line");

  // No free sibling → the honest rate-limit failure (errorInfo 429 for
  // provider-retry), still no ⚠ text shown as the model's answer item.
  acpControl.modeByLabel = { m1: "quota-text" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { ...parkedEntry }, m3: { ...parkedEntry }, m4: { ...parkedEntry },
  } });
  const newsO3 = newsSnapshot();
  await startModel("t-quota-text-fail", "fake-model");
  await turnModel("t-quota-text-fail", "burn it again", "fake-model");
  await sleep(400);
  const qtFailErr = messages.some((m) => m.method === "thread/delta" &&
    m.params?.threadId === "t-quota-text-fail" &&
    (m.params?.deltas ?? []).some((d) => d.kind === "provider.error" &&
      d.errorInfo?.category === "rate-limit" && d.errorInfo?.httpStatusCode === 429));
  const qtFailText = messages.some((m) => m.method === "thread/delta" &&
    m.params?.threadId === "t-quota-text-fail" &&
    (m.params?.deltas ?? []).some((d) =>
      typeof d.text === "string" && d.text.includes("Individual quota reached")));
  check("models/quota-text-no-sibling-fails",
    qtFailErr && !qtFailText &&
    boundaries("t-quota-text-fail").at(-1)?.status === "failed" &&
    acpNews("m2") + acpNews("m3") + acpNews("m4") ===
      newsO3.m2 + newsO3.m3 + newsO3.m4,
    `err=${qtFailErr} text=${qtFailText} boundaries=${statuses("t-quota-text-fail")} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsO3)}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // Ordinary prose that mentions the marker mid-message never cools.
  writeAcpModels(freshFour());
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  await startModel("t-quota-prose", "fake-model");
  await turnModel("t-quota-prose", "the log showed ⚠ Individual quota reached. Resets in 5h1m1s. what now", "fake-model");
  await turnModel("t-quota-prose", "and one ordinary follow-up", "fake-model", 2);
  await sleep(300);
  const qpEntry = readAcpLedger().accounts.m1 ?? {};
  check("models/quota-prose-not-cooled",
    (qpEntry.cooldownUntilMs ?? 0) <= Date.now() &&
    statuses("t-quota-prose") === "completed,completed" &&
    quotaSaw("t-quota-prose"),
    `entry=${JSON.stringify(qpEntry)} saw=${quotaSaw("t-quota-prose")} ` +
      `statuses=${statuses("t-quota-prose")}`);

  // Q. §2.3 п.11 (ревизия 13.1): VALIDATION_REQUIRED on the INTERNAL
  // thread/start of a rotation sibling parks it permanently — not the
  // generic 60-second "session start failed" cooldown.
  acpControl.modeByLabel = { m1: "quota-once", m2: "validation-error" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 500, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  const newsQ = newsSnapshot();
  await startModel("t-sibling-validation", "fake-model");
  await turnModel("t-sibling-validation", "trip quota then refuse the sibling", "fake-model");
  await sleep(400);
  const qEntry = readAcpLedger().accounts.m2 ?? {};
  check("models/sibling-validation-parks-too",
    qEntry.parkedReason === "validation-required" &&
    (qEntry.cooldownUntilMs ?? 0) > Date.now() + 365 * 24 * 3_600_000 &&
    statuses("t-sibling-validation") === "completed" &&
    acpNews("m3") === newsQ.m3 + 1,
    `entry=${JSON.stringify(qEntry)} statuses=${statuses("t-sibling-validation")} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsQ)}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // R. §2.3 п.11: the eligibility-shaped "Verify your account to continue"
  // text classifies as validation-required — permanent parking, not the
  // 24 h ineligible cooldown (куратор принял замечание 4). The "-once"
  // mode fails only the prompt, so the session starts normally first.
  acpControl.modeByLabel = { m1: "validation-error-once" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  await startModel("t-eligible-text", "fake-model");
  await turnModel("t-eligible-text", "verify me via eligibility text", "fake-model");
  await sleep(400);
  const rEntry = readAcpLedger().accounts.m1 ?? {};
  check("models/eligibility-text-is-validation",
    rEntry.parkedReason === "validation-required" &&
    (rEntry.cooldownUntilMs ?? 0) > Date.now() + 365 * 24 * 3_600_000 &&
    statuses("t-eligible-text") === "completed",
    `entry=${JSON.stringify(rEntry)} statuses=${statuses("t-eligible-text")}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // S. §2.3 п.11: client thread/start hits VALIDATION_REQUIRED on m1's
  // session/new AND on the retry sibling's internal start — both park.
  acpControl.modeByLabel = { m1: "validation-error", m2: "validation-error" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 500, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  const newsS = newsSnapshot();
  const sReply = await startModel("t-start-validation", "fake-model");
  await sleep(300);
  const sLedger = readAcpLedger().accounts;
  check("models/start-validation-parks-chain",
    !sReply?.error &&
    sLedger.m1?.parkedReason === "validation-required" &&
    sLedger.m2?.parkedReason === "validation-required" &&
    acpNews("m3") === newsS.m3 + 1,
    `reply=${JSON.stringify(sReply?.error ?? null)} ` +
      `parked m1=${sLedger.m1?.parkedReason} m2=${sLedger.m2?.parkedReason} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsS)}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // R2. §2.3 п.11 (ревизия 15, PLUG-332): an eligibility refusal carrying
  // a verify request/link — "Verify your account." plus an
  // accounts.google.com URL, WITHOUT the strict validation markers —
  // parks permanently as validation-required: parkedReason + ineligibleAtMs
  // + lastError, and NO cooldownUntilMs. The turn rotates to a sibling.
  acpControl.modeByLabel = { m1: "ineligible" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  await startModel("t-verify-link", "fake-model");
  await turnModel("t-verify-link", "verify me via a link", "fake-model");
  await sleep(400);
  const r2Entry = readAcpLedger().accounts.m1 ?? {};
  check("models/verify-link-is-validation-no-cooldown",
    r2Entry.parkedReason === "validation-required" &&
    (r2Entry.ineligibleAtMs ?? 0) > 0 &&
    (r2Entry.cooldownUntilMs ?? 0) <= Date.now() &&
    (r2Entry.lastError ?? "").includes("accounts.google.com") &&
    statuses("t-verify-link") === "completed",
    `entry=${JSON.stringify(r2Entry)} statuses=${statuses("t-verify-link")}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // T. §2.3 п.11: the resume-on-sibling internal start refuses with
  // VALIDATION_REQUIRED too — park that sibling, land on the next one.
  acpControl.modeByLabel = {};
  writeAcpControl();
  favor("m4");
  const resValStart = await startModel("t-res-validation", "fake-model");
  const resValConv = resValStart.result?.providerThreadId;
  stop("t-res-validation");
  await sleep(100);
  acpControl.modeByLabel = { m2: "validation-error" };
  writeAcpControl();
  writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 500, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1000, lastError: null, priority: 10 },
    m4: { ...parkedEntry, parkedReason: "tos-disabled" },
  } }, null, 1));
  const newsT = newsSnapshot();
  const resValId = nextId++;
  send({ jsonrpc: "2.0", id: resValId, method: "thread/resume",
    params: { threadId: "t-res-validation", providerThreadId: resValConv, cwd: workspace,
      options: { model: "fake-model", ...pol }, instructionMode: "append" } });
  await waitFor(() => messages.some((m) => m.id === resValId), 15_000, "t-res-validation: resume");
  const resValReply = messages.find((m) => m.id === resValId);
  await sleep(300);
  const tEntry = readAcpLedger().accounts.m2 ?? {};
  check("models/resume-sibling-validation-parks",
    !resValReply?.error &&
    tEntry.parkedReason === "validation-required" &&
    acpNews("m3") === newsT.m3 + 1 &&
    replacedFor("t-res-validation").length >= 1,
    `reply=${JSON.stringify(resValReply?.error ?? null)} entry=${JSON.stringify(tEntry)} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsT)}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // U. §2.3 п.11 (ревизия 13.1): the sibling reached by the model-refusal
  // retry refuses its internal thread/start with VALIDATION_REQUIRED —
  // same parkedCause classification as every other internal start, not a
  // bare error to the caller. m1's record lies about pro-model so the
  // pick trusts it; m2's mode fails session/new with the 403.
  writeAcpModels({
    m1: freshRecord(["fake-model", "pro-model"]),
    m2: freshRecord(["fake-model", "pro-model"]),
    m3: freshRecord(["fake-model", "pro-model"]),
    m4: freshRecord(["fake-model"]),
  });
  acpControl.modelsByLabel = {
    m1: [["fake-model", "Fake Model"]],
    m2: [["fake-model", "Fake Model"], ["pro-model", "Pro Model"]],
    m3: [["fake-model", "Fake Model"], ["pro-model", "Pro Model"]],
    m4: [["fake-model", "Fake Model"]],
  };
  acpControl.modeByLabel = { m2: "validation-error" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 100, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  const newsU = newsSnapshot();
  const uReply = await startModel("t-retry-validation", "pro-model");
  await sleep(400);
  const uLedger = readAcpLedger().accounts;
  const uLog = readFileSync(join(acpData, "acp-wrapper.log"), "utf8");
  check("models/retry-sibling-validation-parks",
    !uReply?.error &&
    uLedger.m2?.parkedReason === "validation-required" &&
    (uLedger.m2?.cooldownUntilMs ?? 0) > Date.now() + 365 * 24 * 3_600_000 &&
    (readAcpModels().m1?.unsupported?.["pro-model"] ?? 0) > 0 &&
    acpNews("m3") === newsU.m3 + 1 &&
    uLog.includes("move m1 → m2 (model refusal)") &&
    uLog.includes("move m2 → m3 (validation-required)"),
    `reply=${JSON.stringify(uReply?.error ?? null)} ` +
      `parked m2=${uLedger.m2?.parkedReason} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsU)}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // V. §2.3 п.11 (ревизия 13.1): the marker arriving as the turn's SECOND
  // agent text segment — prose, a tool call closing the first stream
  // (item.textClose), then "⚠ Verification Required" — still parks and is
  // still swallowed; the earlier prose reaches the user normally.
  writeAcpModels({
    m1: freshRecord(["fake-model"]),
    m2: freshRecord(["fake-model"]),
    m3: freshRecord(["fake-model"]),
    m4: freshRecord(["fake-model"]),
  });
  acpControl.modeByLabel = { m1: "validation-second-segment" };
  writeAcpControl();
  writeAcpLedger({ accounts: {
    m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    m2: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m3: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 1_700_000_000_000, lastError: null, priority: 10 },
  } });
  await startModel("t-validation-segment", "fake-model");
  await turnModel("t-validation-segment", "second segment marker", "fake-model");
  await sleep(400);
  const vSegEntry = readAcpLedger().accounts.m1 ?? {};
  const vSegSawMarker = messages.some((m) => m.method === "thread/delta" &&
    m.params?.threadId === "t-validation-segment" &&
    (m.params?.deltas ?? []).some((d) =>
      typeof d.text === "string" && d.text.includes("Verification Required")));
  const vSegSawProse = messages.some((m) => m.method === "thread/delta" &&
    m.params?.threadId === "t-validation-segment" &&
    (m.params?.deltas ?? []).some((d) =>
      typeof d.text === "string" && d.text.includes("working on it")));
  check("models/validation-second-segment-parks",
    vSegEntry.parkedReason === "validation-required" &&
    !vSegSawMarker && vSegSawProse &&
    statuses("t-validation-segment") === "completed",
    `entry=${JSON.stringify(vSegEntry)} marker=${vSegSawMarker} ` +
      `prose=${vSegSawProse} statuses=${statuses("t-validation-segment")}`);
  acpControl.modeByLabel = {};
  writeAcpControl();

  // W. §2.3 п.11: turn/start on an owner parked validation-required — the
  // rotation cause and the session/replaced reason speak of account
  // verification, not the eligibility fallback.
  writeAcpLedger({ accounts: {
    m1: { ...parkedEntry }, m2: { ...parkedEntry },
    m3: { cooldownUntilMs: 0, lastUsedMs: 500, lastError: null, priority: 10 },
    m4: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
  } });
  await startModel("t-turn-validation-owner", "fake-model");
  writeAcpLedger({ accounts: {
    m1: { ...parkedEntry }, m2: { ...parkedEntry },
    m3: { cooldownUntilMs: 0, lastUsedMs: 500, lastError: null, priority: 10 },
    m4: { ...parkedEntry, parkedReason: "validation-required" },
  } });
  const newsW = newsSnapshot();
  await turnModel("t-turn-validation-owner", "leave the verification-parked owner", "fake-model");
  await sleep(300);
  const wReasons = replacedFor("t-turn-validation-owner")
    .map((r) => (typeof r?.params?.reason === "string" ? r.params.reason : ""));
  check("models/turn-validation-owner-reason",
    wReasons.some((r) => r.includes("verification")) &&
    !wReasons.some((r) => r.includes("eligibility")) &&
    acpNews("m3") === newsW.m3 + 1 &&
    acpNews("m4") === newsW.m4,
    `reasons=${JSON.stringify(wReasons)} ` +
      `news=${JSON.stringify(newsSnapshot())} before=${JSON.stringify(newsW)}`);

  // NOTE: never call activeBridge.onClose() here — the embedded generic
  // bridge's onClose ends with process.exit(0) and would skip the report.
  await sleep(100);
}
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
