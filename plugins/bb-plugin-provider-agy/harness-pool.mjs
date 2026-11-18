/**
 * Proves the account pool, no network at all. Three pool accounts, each of
 * which refuses its first request (per-home sentinel in fake-agy-errors.mjs
 * pool-retry mode) and works afterwards; a2 carries a `proxy` file. The
 * expected ride: the first turn lands on a1 and fails with the quota text,
 * the bridge cools a1 and rotates to a2 (fresh conversation, contextLost,
 * the account's HTTPS_PROXY in the child env), a2 refuses too (its own
 * first request), the bridge rotates to a3, which answers. Then a second
 * turn on the same session runs on the SAME live child — sticky, no new
 * spawn, resumed conversation.
 *
 * Usage: node harness-pool.mjs
 */
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTeardown, trackedMkdtemp } from "./harness-teardown.mjs";
installTeardown();

const root = trackedMkdtemp(join(tmpdir(), "agy-pool-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });
const shim = join(root, "agy-shim");
const fake = new URL("./fake-agy-errors.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_FAKE_RECORD_ENV = "HOME,HTTPS_PROXY";
process.env.AGY_FAKE_TRANSCRIPT = join(root, "envlog.ndjson");
process.env.AGY_CLIPROXY = "0";
process.env.AGY_AUTO_RETRY_MAX = "1";
process.env.AGY_FAKE_ERROR_MODE = "pool-retry";
process.env.AGY_IDLE_KILL_MS = "1500";
process.env.AGY_TRANSPORT ??= "stream-json";

// The pool: a2 is the one with an egress proxy.
for (const label of ["a1", "a2", "a3"]) {
  const cli = join(root, "accounts", label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}
writeFileSync(join(root, "accounts", "a2", "proxy"), "http://proxy-a2:9\n");

const readEnvs = () =>
  readFileSync(join(root, "envlog.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l); } catch { return {}; }
    })
    .filter((o) => o.__env !== undefined);

const say = (...a) => process.stdout.write(`${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));
const pol = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const options = { model: "fake-model", ...pol };

const boundaries = (threadId) =>
  messages
    .filter((m) => m.method === "thread/delta" && m.params.threadId === threadId)
    .flatMap((m) => m.params.deltas)
    .filter((d) => d.kind === "turn.boundary");
const replaced = () =>
  messages.filter((m) => m.method === "session/replaced" && m.params.threadId === "t-pool");

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

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, grammarVersions: [3, 3], client: { name: "fake", version: "1" } } });
send({
  jsonrpc: "2.0", id: 2, method: "thread/start",
  params: { threadId: "t-pool", cwd: workspace, options, instructionMode: "append" },
});
send({
  jsonrpc: "2.0", id: 3, method: "turn/start",
  params: {
    threadId: "t-pool", providerThreadId: "fake-conv-pool",
    input: [{ type: "text", text: "one", mentions: [] }],
    clientRequestId: "creq_zyxwvutsra", options,
  },
});
await waitFor(() => boundaries("t-pool").length >= 4 && boundaries("t-pool")[3].status === "completed", 40_000, "rotation completes");
await sleep(200);

// Turn two arrives after the idle sweep has released the child: the bridge
// must rebuild the SAME account's home with --conversation (opencode-style
// sleep/restore) and complete on it.
await sleep(3_000);
const spawnsBeforeTurnTwo = readEnvs().length;
send({
  jsonrpc: "2.0", id: 4, method: "turn/start",
  params: {
    threadId: "t-pool", providerThreadId: "fake-conv-pool",
    input: [{ type: "text", text: "two", mentions: [] }],
    clientRequestId: "creq_zyxwvutsrb", options,
  },
});
await waitFor(() => boundaries("t-pool").length >= 5, 15_000, "second turn settles");
await sleep(200);
send({ jsonrpc: "2.0", id: 5, method: "thread/stop", params: { threadId: "t-pool", providerThreadId: "fake-conv-pool", intent: "release", activeTurnId: null } });
await sleep(100);

// ---- ACP phase (spec §2.3): per-account model catalogs in
// accounts-models.json, model-aware account selection, merged model/list.
// m1 (priority 10) carries the common models, m2 (priority 5) is the only
// pro-model account, m3 is priority 0 — never polled, never picked.
const acpChecks = [];
const acpCheck = (id, ok, detail = "") => acpChecks.push([id, ok, detail]);
const acpData = join(root, "acp-data");
for (const label of ["m1", "m2", "m3"]) {
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
process.env.AGY_IDLE_KILL_MS = "0";
process.env.AGY_FAKE_TRANSCRIPT = join(root, "acp-stdin.ndjson");
process.env.AGY_FAKE_CONTROL = join(root, "acp-control.json");
writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify({ accounts: {
  m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
  m2: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 5 },
  m3: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 0 },
} }, null, 1));
writeFileSync(process.env.AGY_FAKE_CONTROL, JSON.stringify({ modelsByLabel: {
  m1: [["fake-model", "Fake Model"], ["shared-model", "Shared Model"]],
  m2: [["fake-model", "Fake Model"], ["shared-model", "Shared Model"], ["pro-model", "Pro Model"]],
  m3: [["pro-model", "Pro Model"]],
} }, null, 1));

const acpTranscript = () =>
  (existsSync(process.env.AGY_FAKE_TRANSCRIPT)
    ? readFileSync(process.env.AGY_FAKE_TRANSCRIPT, "utf8")
    : "")
    .split("\n").filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const acpNews = (label) => acpTranscript().filter((l) => l.method === "session/new" && l.home === label).length;
const acpProbes = (label) => acpTranscript().filter((l) => l.__models === true && l.home === label).length;
const acpReply = (id) => messages.find((m) => m.id === id);
const readAcpModels = () => {
  try {
    return JSON.parse(readFileSync(join(acpData, "accounts-models.json"), "utf8")).accounts ?? {};
  } catch { return {}; }
};
const writeAcpLedger = (accounts) => {
  writeFileSync(join(acpData, "accounts-state.json"), JSON.stringify({ accounts }, null, 1));
  try { unlinkSync(join(acpData, "accounts-overlay.json")); } catch { /* absent */ }
  try { unlinkSync(join(acpData, "conversations-state.json")); } catch { /* absent */ }
};

// NOTE: never call acpBridge.onClose() — the embedded generic bridge's
// onClose ends with process.exit(0) (it owns the process in production).
const acpBridge = (await import(
  new URL("./dist/host.js?acp-pool", import.meta.url).href
)).experimental_providerBridge;
acpBridge.start?.({ pluginId: "provider-agy", dataDir: acpData, tempDir: acpData });
const sendAcp = (m) => acpBridge.handleLine(JSON.stringify(m));
let acpId = 200;
const acpStart = async (threadId, model) => {
  const id = acpId++;
  sendAcp({ jsonrpc: "2.0", id, method: "thread/start",
    params: { threadId, cwd: workspace, options: { model, ...pol }, instructionMode: "append" } });
  await waitFor(() => acpReply(id) !== undefined, 15_000, `${threadId}: start`);
  return acpReply(id);
};

// Before any catalog exists every account is a candidate: the unpolled
// pick takes m1 (priority 10), whose session refuses pro-model at session
// build; the wrapper marks m1's family unsupported and re-drives on m2.
const early = await acpStart("t-pro-early", "pro-model");
await sleep(200);
acpCheck("models/start-refusal-retries-suitable",
  !early.error && acpNews("m1") === 1 && acpNews("m2") === 1,
  `news m1=${acpNews("m1")} m2=${acpNews("m2")} err=${early.error?.message ?? "none"}`);
acpCheck("models/refusal-marked-unsupported",
  (readAcpModels().m1?.unsupported?.["pro-model"] ?? 0) > 0,
  JSON.stringify(readAcpModels().m1?.unsupported ?? null));

// model/list merges the per-account catalogs the lazy poll just wrote.
const listId = acpId++;
sendAcp({ jsonrpc: "2.0", id: listId, method: "model/list", params: {} });
await waitFor(() => acpReply(listId) !== undefined, 20_000, "acp model/list");
const listed = acpReply(listId)?.result?.models ?? [];
acpCheck("models/per-account-catalog-file",
  (readAcpModels().m1?.families ?? []).includes("shared-model") &&
  (readAcpModels().m2?.families ?? []).includes("pro-model") &&
  readAcpModels().m3 === undefined,
  JSON.stringify(Object.fromEntries(Object.entries(readAcpModels()).map(([k, v]) => [k, v.families]))));
acpCheck("models/priority-zero-never-polled",
  acpProbes("m1") >= 1 && acpProbes("m2") >= 1 && acpProbes("m3") === 0,
  `probes m1=${acpProbes("m1")} m2=${acpProbes("m2")} m3=${acpProbes("m3")}`);
acpCheck("models/list-merges-union",
  ["fake-model", "shared-model", "pro-model"].every((mid) => listed.some((m) => m.id === mid)),
  JSON.stringify(listed.map((m) => m.id)));

// shared-model sits in both catalogs: priority decides (m1 over m2) and a
// cooldown shifts the next pick to m2, exactly as before revision 10.
const sh1 = await acpStart("t-shared-1", "shared-model");
const newsAfterSh1 = { m1: acpNews("m1"), m2: acpNews("m2") };
acpCheck("models/common-model-picks-priority",
  !sh1.error && newsAfterSh1.m1 === 2 && newsAfterSh1.m2 === 1,
  `news m1=${newsAfterSh1.m1} m2=${newsAfterSh1.m2}`);
writeAcpLedger({
  m1: { cooldownUntilMs: Date.now() + 3_600_000, lastUsedMs: Date.now(), lastError: "test cooldown", priority: 10 },
  m2: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 5 },
  m3: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 0 },
});
const sh2 = await acpStart("t-shared-2", "shared-model");
acpCheck("models/common-model-cooldown-falls-to-sibling",
  !sh2.error && acpNews("m2") === newsAfterSh1.m2 + 1 && acpNews("m1") === newsAfterSh1.m1,
  `news m1=${acpNews("m1")} m2=${acpNews("m2")}`);
writeAcpLedger({
  m1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
  m2: { cooldownUntilMs: 0, lastUsedMs: Date.now(), lastError: null, priority: 5 },
  m3: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 0 },
});
const sh3 = await acpStart("t-shared-3", "shared-model");
acpCheck("models/common-model-uncooled-returns-to-priority",
  !sh3.error && acpNews("m1") === newsAfterSh1.m1 + 1,
  `news m1=${acpNews("m1")} m2=${acpNews("m2")}`);

// A model no account offers fails honestly — no spawn, no rotation.
const newsBeforeGhost = acpNews("m1") + acpNews("m2") + acpNews("m3");
const ghost = await acpStart("t-ghost", "ghost-model");
acpCheck("models/unoffered-fails-honestly",
  ghost.error?.message === "model ghost-model is not offered by any pool account" &&
  acpNews("m1") + acpNews("m2") + acpNews("m3") === newsBeforeGhost,
  ghost.error?.message ?? "unexpected success");

for (const tid of ["t-pro-early", "t-shared-1", "t-shared-2", "t-shared-3"]) {
  sendAcp({ jsonrpc: "2.0", id: acpId++, method: "thread/stop", params: { threadId: tid, intent: "release", activeTurnId: null } });
}

process.stdout.write = originalWrite;

const envs = readEnvs();
const bs = boundaries("t-pool");
const ledger = (() => {
  const shared = JSON.parse(readFileSync(join(root, "accounts-state.json"), "utf8"));
  let local = {};
  try {
    local = JSON.parse(readFileSync(join(root, "conversations-state.json"), "utf8")).conversations ?? {};
  } catch { /* no local file yet */ }
  return { ...shared, conversations: { ...(shared.conversations ?? {}), ...local } };
})();
const replacedList = replaced();

const { pickAccount, accountPriority } = await import(
  new URL("./src/accounts.ts", import.meta.url).href
);
const prioTestHomes = [
  { label: "prio-low", home: join(root, "accounts", "a1"), proxy: null },
  { label: "prio-high", home: join(root, "accounts", "a2"), proxy: null },
  { label: "prio-zero", home: join(root, "accounts", "a3"), proxy: null },
];
const prioTestLedger = {
  accounts: {
    "prio-low": { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
    "prio-high": { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 20 },
    "prio-zero": { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 0 },
  },
  conversations: {},
};
const prioPickedHigh = pickAccount(prioTestLedger, prioTestHomes);
prioTestLedger.accounts["prio-high"].cooldownUntilMs = Date.now() + 60_000;
const prioPickedLow = pickAccount(prioTestLedger, prioTestHomes);
prioTestLedger.accounts["prio-low"].cooldownUntilMs = Date.now() + 60_000;
const prioFallbackHigh = pickAccount(prioTestLedger, prioTestHomes);
const prioZeroOnly = pickAccount(
  { accounts: { z: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 0 } }, conversations: {} },
  [{ label: "z", home: "", proxy: null }],
);

// pickAccount's model filtering itself (spec §2.3): sole supporter beats
// priority, catalog-less accounts only fill in when no supporter is free,
// fresh unsupported marks exclude, and no catalog is the old behaviour.
const mkRec = (families) => ({
  raw: families.map((f) => ({ id: f, displayName: f })),
  families, unsupported: {}, atMs: Date.now(),
});
const mHomes = [
  { label: "m-a", home: "", proxy: null },
  { label: "m-b", home: "", proxy: null },
  { label: "m-c", home: "", proxy: null },
];
const mLedger = { accounts: {
  "m-a": { cooldownUntilMs: 0, lastUsedMs: 100, lastError: null, priority: 5 },
  "m-b": { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null, priority: 10 },
  "m-c": { cooldownUntilMs: 0, lastUsedMs: 50, lastError: null, priority: 10 },
}, conversations: {} };
const mLedgerCooled = { accounts: {
  "m-a": { cooldownUntilMs: 0, lastUsedMs: 100, lastError: null, priority: 5 },
  "m-b": { cooldownUntilMs: Date.now() + 60_000, lastUsedMs: 0, lastError: null, priority: 10 },
  "m-c": { cooldownUntilMs: 0, lastUsedMs: 50, lastError: null, priority: 10 },
}, conversations: {} };
acpCheck("models/pick-sole-supporter-beats-priority",
  pickAccount(mLedger, mHomes, null, { family: "pro", models: { "m-a": mkRec(["pro"]) } })?.label === "m-a",
  pickAccount(mLedger, mHomes, null, { family: "pro", models: { "m-a": mkRec(["pro"]) } })?.label ?? "none");
acpCheck("models/unpolled-yields-to-known-support",
  pickAccount(mLedger, mHomes, null, { family: "pro", models: { "m-b": mkRec(["pro"]) } })?.label === "m-b",
  "expected m-b");
acpCheck("models/unpolled-fills-when-supporters-cooled",
  pickAccount(mLedgerCooled, mHomes, null, { family: "pro", models: { "m-b": mkRec(["pro"]) } })?.label === "m-c",
  "expected m-c");
acpCheck("models/fresh-unsupported-mark-excludes",
  pickAccount(mLedger, mHomes, null, { family: "pro", models: { "m-b": { ...mkRec(["pro"]), unsupported: { pro: Date.now() } } } })?.label === "m-c",
  "expected m-c");
acpCheck("models/no-catalog-is-legacy-behaviour",
  pickAccount(mLedger, mHomes, null, { family: "pro", models: {} })?.label === "m-b",
  "expected m-b");

const checks = [
  ...acpChecks,
  ["pool/homes-visited-in-order", envs.length === 5 && ["a1", "a2", "a3", "a3", "a3"].every((l, i) => envs[i]?.__env?.HOME === join(root, "accounts", l)), JSON.stringify(envs.map((e) => e?.__env?.HOME))],
  ["pool/failures-then-completion", bs.length === 5 && bs.slice(0, 3).every((b) => b.status === "failed") && bs[3].status === "completed" && bs[4].status === "completed", JSON.stringify(bs.map((b) => b.status))],
  ["pool/proxy-follows-account", envs[1]?.__env?.HTTPS_PROXY === "http://proxy-a2:9" && envs[0]?.__env?.HTTPS_PROXY == null && envs[2]?.__env?.HTTPS_PROXY == null && envs[3]?.__env?.HTTPS_PROXY == null, JSON.stringify(envs.map((e) => e?.__env?.HTTPS_PROXY))],
  ["pool/rotations-fresh-resume-last", envs[1]?.__argv?.includes("--conversation") !== true && envs[2]?.__argv?.includes("--conversation") !== true && envs[3]?.__argv?.includes("--conversation") === true, JSON.stringify([envs[1]?.__argv?.includes("--conversation"), envs[2]?.__argv?.includes("--conversation"), envs[3]?.__argv?.includes("--conversation")])],
  ["pool/replaced-announced-four-times", replacedList.length === 4 && replacedList[0].params.contextLost === true && replacedList[1].params.contextLost === true && replacedList[2].params.contextLost === false && replacedList[3].params.contextLost === false, JSON.stringify(replacedList.map((m) => m.params.contextLost))],
  ["pool/cooldowns-recorded", (ledger.accounts.a1?.cooldownUntilMs ?? 0) > 0 && (ledger.accounts.a2?.cooldownUntilMs ?? 0) > 0 && (ledger.accounts.a3?.cooldownUntilMs ?? 0) > 0, JSON.stringify(ledger.accounts)],
  ["pool/conversation-mapped-to-a3", ledger.conversations["fake-conv-errors"] === "a3", JSON.stringify(ledger.conversations)],
  ["pool/idle-released-the-child", spawnsBeforeTurnTwo === 4, `${spawnsBeforeTurnTwo} spawns before the idle gap`],
  ["pool/idle-restore-same-home-resume", envs.length === 5 && envs[4]?.__env?.HOME === join(root, "accounts", "a3") && envs[4]?.__argv?.includes("--conversation") === true, JSON.stringify(envs[4] ?? {})],
  ["pool/priority-tier-high-over-low", prioPickedHigh?.label === "prio-high", prioPickedHigh?.label ?? "none"],
  ["pool/priority-cooldown-yields-to-lower", prioPickedLow?.label === "prio-low", prioPickedLow?.label ?? "none"],
  ["pool/priority-all-cooling-fallback-highest-tier", prioFallbackHigh?.label === "prio-high", prioFallbackHigh?.label ?? "none"],
  ["pool/priority-zero-never-picked-null", prioZeroOnly === null, String(prioZeroOnly)],
  ["pool/priority-backward-compat-default-10",
    accountPriority(ledger.accounts.a1) === 10 &&
    (ledger.accounts.a1?.priority ?? undefined) === undefined,
    `a1 priority default: ${accountPriority(ledger.accounts.a1)}`],
];

say("==== account pool report ====");
let bad = 0;
for (const [id, ok, detail] of checks) {
  say(`${ok ? "pass" : "FAIL"} ${id.padEnd(36)} ${detail}`);
  if (!ok) bad += 1;
}
say(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);
