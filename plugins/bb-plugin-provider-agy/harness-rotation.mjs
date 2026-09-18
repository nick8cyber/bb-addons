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
const send = (m) => bridge.handleLine(JSON.stringify(m));
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

async function startThread(threadId) {
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
    params: { threadId, cwd: workspace, options, instructionMode: "append" },
  });
  await waitFor(
    () => messages.some((m) => m.id === startId),
    15_000,
    `${threadId}: thread/start`,
  );
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

bridge.onClose?.();
await sleep(100);
process.stdout.write = originalWrite;

const bsA = boundaries("t-bare");
const bsB = boundaries("t-exit");
const bsC = boundaries("t-rebuild");
const repA = replacedFor("t-bare");
const repB = replacedFor("t-exit");
const repC = replacedFor("t-rebuild");
const errB = errorsFor("t-exit");

const checks = [
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
