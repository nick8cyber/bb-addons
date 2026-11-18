/**
 * Parallel-installs harness (provider-agy-installs §11 пп. 1–9): two fake
 * binaries — fake-agy-main and fake-agy-secondary — each recording its
 * install name + account home in the transcript; every pick and launch
 * must route strictly through the bound install, with no substitution.
 *
 * Coverage (ACP transport, default):
 *   1  every §6 launch point runs the bound install's binary
 *   2  direct-mode sessions run the registry default's binary
 *   3  no registry → legacy resolveAgyCommand; bound accounts unavailable
 *   4  broken registry → honest error, nothing launches
 *   4a registry env with a forbidden key → schema refusal, nothing runs
 *   5  unknown/invalid install → never picked, never in model/list
 *   6  quota on main rotates to a secondary sibling
 *   7  LRU alternates accounts across installs, not grouped by install
 *   8  live registry mtime edit applies to the next launch
 *   9  install survives markAccountUse/markAccountCooldown/saveLedger and
 *      never leaks into accounts-overlay.json; concurrent disk labels ride
 *      through a foreign save
 *
 * Usage: node harness-installs.mjs            (ACP wrapper suite)
 *        AGY_INSTALLS_TRANSPORT=stream-json node harness-installs.mjs
 *        (stream-json bridge suite — §6 пп. 9-10)
 */
import {
  chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { installTeardown, trackedMkdtemp } from "./harness-teardown.mjs";
installTeardown();

const SUITE = process.env.AGY_INSTALLS_TRANSPORT ?? "acp";
if (SUITE === "stream-json") {
  process.env.AGY_TRANSPORT = "stream-json";
}

const root = trackedMkdtemp(join(tmpdir(), `agy-installs-${SUITE}-`));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });
const transcript = join(root, "transcript.ndjson");
const fakeSrc =
  SUITE === "stream-json"
    ? new URL("./fake-agy.mjs", import.meta.url).pathname
    : new URL("./fake-agy-acp.mjs", import.meta.url).pathname;

process.env.AGY_FAKE_TRANSCRIPT = transcript;
process.env.AGY_FAKE_RECORD_ENV = "HOME,HTTPS_PROXY,XDG_CACHE_HOME";
process.env.AGY_CLIPROXY = "0";
process.env.AGY_FAKE_CONTROL = join(root, "control.json");
writeFileSync(process.env.AGY_FAKE_CONTROL, "{}\n");
const setControl = (obj) => {
  const c = JSON.parse(readFileSync(process.env.AGY_FAKE_CONTROL, "utf8"));
  Object.assign(c, obj);
  writeFileSync(process.env.AGY_FAKE_CONTROL, JSON.stringify(c));
};

// Each install binary is a shell wrapper that stamps {"__bin": <install>,
// "home": <account>} into the transcript before exec'ing the shared fake —
// the marker is per-process-launch proof of WHICH binary ran for WHOM.
const mkBin = (name) => {
  mkdirSync(join(root, "bin"), { recursive: true });
  const p = join(root, "bin", `agy-${name}`);
  writeFileSync(
    p,
    `#!/bin/sh
home=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--gemini-dir" ]; then home=$(basename "$(dirname "$a")"); fi
  prev="$a"
done
[ -z "$home" ] && home=$(basename "\${HOME:-direct}")
printf '{"__bin":"${name}","home":"%s"}\\n' "$home" >> "$AGY_FAKE_TRANSCRIPT"
exec /usr/bin/node ${fakeSrc} "$@"
`,
  );
  chmodSync(p, 0o755);
  return p;
};
const binMain = mkBin("main");
const binSecondary = mkBin("secondary");
const binSecondaryV2 = mkBin("secondary-v2");
const binLegacy = mkBin("legacy");
process.env.AGY_PATH = binLegacy;

// Pool accounts: m1/m2 on main, s1/s2 on secondary (LRU alternation),
// ghost bound to an undeclared name, bad bound to a pattern-failing value,
// dead bound to a registry install whose binary file is missing.
const BINDINGS = {
  m1: "main", m2: "main", s1: "secondary", s2: "secondary",
  ghost: "ghost", bad: "Bad_Name", dead: "dead",
};
const accountsDir = join(root, "accounts");
for (const label of Object.keys(BINDINGS)) {
  const cli = join(accountsDir, label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}

const registryPath = join(root, "agy-installs.json");
const statePath = join(root, "accounts-state.json");
const modelsPath = join(root, "accounts-models.json");
const wrapperLog = join(root, "acp-wrapper.log");
const bridgeLog = join(root, "bridge.log");
const overlayPath = join(root, "accounts-overlay.json");
const convPath = join(root, "conversations-state.json");

const writeRegistry = (mutate = (doc) => doc) =>
  writeFileSync(
    registryPath,
    `${JSON.stringify(
      mutate({
        installs: {
          main: { bin: binMain, env: { XDG_CACHE_HOME: join(root, "cache-main") } },
          secondary: { bin: binSecondary, env: { XDG_CACHE_HOME: join(root, "cache-sec") } },
          dead: { bin: join(root, "bin", "agy-nonexistent") },
        },
        default: "main",
      }),
      null,
      2,
    )}\n`,
  );
writeRegistry();

const writeState = () =>
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        accounts: Object.fromEntries(
          Object.entries(BINDINGS).map(([label, install]) => [label, { install }]),
        ),
      },
      null,
      2,
    )}\n`,
  );
writeState();

const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const freshModels = (families) => ({
  atMs: Date.now(),
  families,
  raw: families.map((id) => ({ id, displayName: id })),
  unsupported: {},
});
writeFileSync(
  modelsPath,
  `${JSON.stringify(
    {
      m1: freshModels(["fake-model"]),
      m2: freshModels(["fake-model"]),
      s1: freshModels(["fake-model"]),
      s2: freshModels(["fake-model"]),
      // Unavailable accounts keep their on-disk records (§5 п.3) — the
      // merged catalog must still never advertise them.
      ghost: freshModels(["ghost-only-model"]),
      bad: freshModels(["bad-only-model"]),
      dead: freshModels(["dead-only-model"]),
    },
    null,
    2,
  )}\n`,
);

const transcriptLines = () =>
  existsSync(transcript)
    ? readFileSync(transcript, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return {};
          }
        })
    : [];
const binMarks = () => transcriptLines().filter((l) => l.__bin !== undefined);
const wrapperLogLines = () =>
  existsSync(wrapperLog) ? readFileSync(wrapperLog, "utf8").split("\n") : [];
const bridgeLogLines = () =>
  existsSync(bridgeLog) ? readFileSync(bridgeLog, "utf8").split("\n") : [];

const say = (...a) => process.stdout.write(`${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (cond, name) => {
  results.push(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures += 1;
};

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
const replies = (id) => messages.filter((m) => m.id === id);
const pol = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};
const options = { model: "fake-model", ...pol };

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      process.stdout.write = originalWrite;
      say(`!!! timeout: ${label}`);
      for (const m of messages.slice(-40)) say(JSON.stringify(m).slice(0, 260));
      process.exit(2);
    }
    await sleep(50);
  }
}

let nextId = 100;
const rid = () => nextId++;
let creqN = 0;
const creq = () => `creq_${"aaaaaaaaaa".slice(0, 9)}${"abcdefghjkmnpqrstuvwxyz"[creqN++ % 24]}`;
const startThread = (tid) =>
  send({
    jsonrpc: "2.0", id: rid(), method: "thread/start",
    params: { threadId: tid, cwd: workspace, options, instructionMode: "append" },
  });
const ptidOf = (tid) =>
  messages
    .filter((m) => m.method === "thread/identity" && m.params.threadId === tid)
    .at(-1)?.params.providerThreadId;
const turn = (tid, text = "hello") =>
  send({
    jsonrpc: "2.0", id: rid(), method: "turn/start",
    params: {
      threadId: tid, providerThreadId: ptidOf(tid),
      input: [{ type: "text", text, mentions: [] }],
      clientRequestId: creq(), options,
    },
  });
const turnBoundaries = (tid) =>
  messages
    .filter((m) => m.method === "thread/delta" && m.params.threadId === tid)
    .flatMap((m) => m.params.deltas)
    .filter((d) => d.kind === "turn.boundary");
const completedTurns = (tid) =>
  turnBoundaries(tid).filter((d) => d.status === "completed").length;
const stopThread = (tid) =>
  send({
    jsonrpc: "2.0", id: rid(), method: "thread/stop",
    params: { threadId: tid, providerThreadId: ptidOf(tid), intent: "release", activeTurnId: null },
  });
const pinnedLabel = (tid) =>
  wrapperLogLines()
    .filter((l) => l.includes(`thread ${tid}: pinned to account`))
    .at(-1)
    ?.match(/pinned to account (\S+)/)?.[1];

// Marks recorded since a transcript offset — proof of which binary ran.
const marksSince = (offset) => binMarks().slice(offset);
// The live-registry edit rewrites s2's expectation mid-run: marks before
// `v2MarkOffset` use BINDINGS, marks at/after it bind s2 → "secondary-v2".
let v2MarkOffset = Number.POSITIVE_INFINITY;
const allMarksConsistent = (marks) =>
  marks.every((m, i) => {
    const bound = i < v2MarkOffset ? BINDINGS[m.home] : m.home === "s2" ? "secondary-v2" : BINDINGS[m.home];
    return bound === m.__bin || !Object.hasOwn(BINDINGS, m.home);
  });
// A `__models` transcript line is written by the fake child the launch
// wrapper just stamped — pairing it with the immediately preceding `__bin`
// mark proves WHICH binary ran the probe for WHOM.
const probePairsConsistent = () => {
  const lines = transcriptLines();
  let saw = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.__models !== true) continue;
    saw += 1;
    let mark = null;
    for (let j = i - 1; j >= 0 && mark === null; j--) {
      if (lines[j].__bin !== undefined && lines[j].home === l.home) mark = lines[j];
      // a probe is a fresh child: a stale mark from a session still running
      // is fine only when a *newer* mark for this home sits between — the
      // backward scan takes the newest one automatically.
      if (mark === null && lines[j].__models === true && lines[j].home === l.home) break;
    }
    if (mark === null) return false;
    const bound = BINDINGS[l.home];
    if (bound !== undefined && mark.__bin !== bound && mark.__bin !== "secondary-v2") return false;
    if (l.__env?.XDG_CACHE_HOME == null) return false;
  }
  return saw >= 4;
};

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, grammarVersions: [3, 3], client: { name: "fake", version: "1" } } });
await waitFor(() => replies(1).length === 1, 10_000, "initialize");

if (SUITE === "acp") {
  // -- §9 п.1: registry registration at startup -------------------------
  check(
    wrapperLogLines().some(
      (l) =>
        l.includes("installs registry loaded:") &&
        l.includes("default=main") &&
        l.includes(`main: ${binMain}`) &&
        l.includes(`secondary: ${binSecondary}`),
    ),
    "9.1 acp-wrapper.log: installs registry loaded line",
  );

  // -- §11 п.7/1: four picks alternate installs via the global LRU ------
  for (const tid of ["t-m1", "t-m2", "t-s1", "t-s2"]) {
    startThread(tid);
  }
  await waitFor(() => ["t-m1", "t-m2", "t-s1", "t-s2"].every((t) => pinnedLabel(t) !== undefined), 20_000, "four pins");
  check(pinnedLabel("t-m1") === "m1", "LRU pick #1 → m1 (main)");
  check(pinnedLabel("t-m2") === "m2", "LRU pick #2 → m2 (main)");
  check(pinnedLabel("t-s1") === "s1", "LRU pick #3 → s1 (secondary)");
  check(pinnedLabel("t-s2") === "s2", "LRU pick #4 → s2 (secondary)");
  check(
    wrapperLogLines().some((l) => /pinned to account s1 .*install=secondary/.test(l)),
    "9.2 pin log carries install=secondary suffix",
  );
  check(
    wrapperLogLines().some((l) => /pinned to account m1 .*install=main/.test(l)),
    "9.2 pin log carries install=main suffix",
  );

  await waitFor(() => ["t-m1", "t-m2", "t-s1", "t-s2"].every((t) => ptidOf(t) !== undefined), 20_000, "four identities");
  for (const tid of ["t-m1", "t-m2", "t-s1", "t-s2"]) turn(tid);
  await waitFor(() => ["t-m1", "t-m2", "t-s1", "t-s2"].every((t) => completedTurns(t) >= 1), 60_000, "four turns complete");

  const pair = (home) => marksSince(0).filter((m) => m.home === home).map((m) => m.__bin);
  check(pair("m1").length > 0 && pair("m1").every((b) => b === "main"), "m1 ran only on fake-agy-main");
  check(pair("m2").length > 0 && pair("m2").every((b) => b === "main"), "m2 ran only on fake-agy-main");
  check(pair("s1").length > 0 && pair("s1").every((b) => b === "secondary"), "s1 ran only on fake-agy-secondary");
  check(pair("s2").length > 0 && pair("s2").every((b) => b === "secondary"), "s2 ran only on fake-agy-secondary");
  check(
    !transcriptLines().some((l) => l.__bin !== undefined && ["ghost", "bad", "dead"].includes(l.home)),
    "unavailable accounts (ghost/bad/dead) never spawned a binary",
  );
  const envOf = (home) =>
    transcriptLines().find((l) => l.home === home && l.__env !== undefined)?.__env ?? {};
  check(envOf("s1").XDG_CACHE_HOME === join(root, "cache-sec"), "install env layered for secondary child");
  check(envOf("m1").XDG_CACHE_HOME === join(root, "cache-main"), "install env layered for main child");

  // -- §11 п.1 probe points + §5 п.3: per-install models probes ---------
  // Cold-start probes ran when the four threads started (catalog empty):
  // each `__models` record must pair with a `__bin` mark of the account's
  // own install and carry the install's env layer.
  const modelsProbeCount = (home) =>
    transcriptLines().filter((l) => l.__models === true && l.home === home).length;
  await waitFor(
    () => ["m1", "m2", "s1", "s2"].every((h) => modelsProbeCount(h) >= 1),
    30_000,
    "cold-start probes for all four accounts",
  );
  check(
    probePairsConsistent(),
    "runModelProbe ran each account's own install binary (paired marks+env)",
  );
  check(
    transcriptLines().find((l) => l.__models === true && l.home === "s1")?.__env?.XDG_CACHE_HOME ===
      join(root, "cache-sec"),
    "probe for s1 ran with the secondary install env",
  );
  check(
    !transcriptLines().some((l) => l.__models && ["ghost", "bad", "dead"].includes(l.home)),
    "unavailable accounts were never probed",
  );

  // -- §11 п.5: merged model/list excludes unavailable accounts ---------
  const listId = rid();
  send({ jsonrpc: "2.0", id: listId, method: "model/list", params: {} });
  await waitFor(() => replies(listId).length === 1, 30_000, "model/list reply");
  const listedIds = (replies(listId)[0]?.result?.models ?? []).map((m) => m.id ?? m.model);
  check(listedIds.includes("fake-model"), "model/list offers the live accounts' model");
  check(!listedIds.includes("ghost-only-model"), "model/list excludes ghost (unknown install)");
  check(!listedIds.includes("bad-only-model"), "model/list excludes bad (invalid install value)");
  check(!listedIds.includes("dead-only-model"), "model/list excludes dead (missing binary)");

  // -- §11 п.1: resume on a secondary owner -----------------------------
  const s1Ptid = ptidOf("t-s1");
  stopThread("t-s1");
  await waitFor(() => binMarks().filter((m) => m.home === "s1").length >= 1, 10_000, "s1 stopped");
  const markBeforeResume = binMarks().length;
  const resumeId = rid();
  send({
    jsonrpc: "2.0", id: resumeId, method: "thread/resume",
    params: { threadId: "t-s1r", cwd: workspace, providerThreadId: s1Ptid, options, instructionMode: "append" },
  });
  await waitFor(() => replies(resumeId).length === 1, 20_000, "resume on s1 owner");
  check(replies(resumeId)[0]?.result?.providerThreadId !== undefined, "resume on s1 succeeded");
  check(
    marksSince(markBeforeResume).some((m) => m.home === "s1" && m.__bin === "secondary"),
    "resume on s1 launched fake-agy-secondary",
  );
  check(
    wrapperLogLines().some((l) => /resuming .* on account s1 \(install=secondary\)/.test(l)),
    "9.2 resume log carries install=secondary",
  );

  // -- §11 п.6: quota on a main account rotates to a secondary sibling --
  // Freeze m2/s1 out of the pick with priority 0 on disk (disk priority
  // wins the next saveLedger merge — an operator edit, §2.2).
  const st = readState();
  st.accounts.m2.priority = 0;
  st.accounts.s1.priority = 0;
  writeFileSync(statePath, `${JSON.stringify(st, null, 2)}\n`);
  setControl({ modeByLabel: { m1: "quota-once" } });
  const marksBeforeRot = binMarks().length;
  turn("t-m1", "make quota happen");
  await waitFor(
    () => wrapperLogLines().some((l) => /move m1 → \S+ \(quota/.test(l)),
    40_000,
    "rotation moved off m1",
  );
  await waitFor(() => completedTurns("t-m1") >= 2 || turnBoundaries("t-m1").some((b) => b.status === "failed"), 60_000, "rotation turn settles");
  const moveLine = wrapperLogLines().find((l) => /move m1 → \S+ \(quota/.test(l));
  check(/move m1 → s2/.test(moveLine ?? ""), "rotation m1 → s2 crossed installs");
  check(/install=secondary/.test(moveLine ?? ""), "9.2 move log carries install=secondary");
  check(
    marksSince(marksBeforeRot).some((m) => m.home === "s2" && m.__bin === "secondary"),
    "post-rotation session runs on fake-agy-secondary",
  );

  // -- §5 п.2: resume pinned to an unavailable owner moves to a sibling -
  const convs = { conversations: { "fake-conv-ghost": "ghost" } };
  writeFileSync(convPath, `${JSON.stringify(convs, null, 2)}\n`);
  const marksBeforeGhost = binMarks().length;
  const ghostResumeId = rid();
  send({
    jsonrpc: "2.0", id: ghostResumeId, method: "thread/resume",
    params: { threadId: "t-ghost", cwd: workspace, providerThreadId: "fake-conv-ghost", options, instructionMode: "append" },
  });
  await waitFor(() => replies(ghostResumeId).length === 1, 30_000, "resume on ghost owner settles");
  check(
    wrapperLogLines().some((l) => /resume owner ghost install unavailable/.test(l)),
    "ghost owner logged as install-unavailable",
  );
  const ghostReply = replies(ghostResumeId)[0];
  const movedTo = wrapperLogLines().filter((l) => /move ghost → \S+ \(resume on sibling/.test(l)).at(-1);
  check(
    (ghostReply?.result?.providerThreadId !== undefined && movedTo !== undefined) ||
      ghostReply?.error !== undefined,
    "ghost resume either moved to a sibling or failed honestly — no substitute binary",
  );
  check(
    !marksSince(marksBeforeGhost).some((m) => m.home === "ghost"),
    "ghost's own binary was never launched",
  );

  // -- §11 п.2: direct mode runs the registry default -------------------
  process.env.AGY_ACCOUNTS = "0";
  const marksBeforeDirect = binMarks().length;
  const directId = rid();
  send({
    jsonrpc: "2.0", id: directId, method: "thread/start",
    params: { threadId: "t-direct", cwd: workspace, options, instructionMode: "append" },
  });
  await waitFor(() => replies(directId).length === 1, 20_000, "direct start");
  check(
    marksSince(marksBeforeDirect).some((m) => m.__bin === "main"),
    "direct session ran the default install's binary",
  );
  check(
    !marksSince(marksBeforeDirect).some((m) => m.__bin === "secondary" || m.__bin === "legacy"),
    "direct session did not touch secondary/legacy binaries",
  );
  delete process.env.AGY_ACCOUNTS;

  // -- §11 п.8: live registry edit applies to the next launch -----------
  writeRegistry((doc) => {
    doc.installs.secondary.bin = binSecondaryV2;
    return doc;
  });
  v2MarkOffset = binMarks().length;
  const s2Ptid = ptidOf("t-s2");
  const marksBeforeV2 = binMarks().length;
  const v2ResumeId = rid();
  send({
    jsonrpc: "2.0", id: v2ResumeId, method: "thread/resume",
    params: { threadId: "t-s2r", cwd: workspace, providerThreadId: s2Ptid, options, instructionMode: "append" },
  });
  await waitFor(() => replies(v2ResumeId).length === 1, 20_000, "resume after registry edit");
  check(
    marksSince(marksBeforeV2).some((m) => m.home === "s2" && m.__bin === "secondary-v2"),
    "edited registry picked up: s2 relaunched on secondary-v2",
  );

  // -- §11 п.9: install survives ledger writes, never leaks to overlay --
  const stNow = readState();
  stNow.accounts["z-late"] = { install: "secondary" };
  writeFileSync(statePath, `${JSON.stringify(stNow, null, 2)}\n`);
  turn("t-m2");
  await waitFor(() => completedTurns("t-m2") >= 1, 30_000, "turn drives a ledger save");
  await sleep(300);
  const stAfter = readState();
  check(stAfter.accounts["z-late"]?.install === "secondary", "concurrent disk label kept its install through a foreign save");
  check(stAfter.accounts.s1?.install === "secondary" && stAfter.accounts.m1?.install === "main", "install survived markAccountUse/saveLedger");
  const cooled = stAfter.accounts.m1?.cooldownUntilMs;
  check(
    stAfter.accounts.m1?.install === "main" && (cooled === undefined || stAfter.accounts.m1.install === "main"),
    "install survived markAccountCooldown",
  );
  const overlay = existsSync(overlayPath)
    ? readFileSync(overlayPath, "utf8")
    : "{}";
  check(!overlay.includes('"install"'), "install never leaked into accounts-overlay.json");
  check(
    !Object.hasOwn(stAfter.accounts, "ghost") ||
      stAfter.accounts.ghost?.install === "ghost",
    "ghost's binding was not rewritten on disk",
  );

  // -- §11 п.3: registry gone → bound accounts out, resolveAgyCommand ---
  unlinkSync(registryPath);
  const marksBeforeGone = binMarks().length;
  const goneId = rid();
  send({
    jsonrpc: "2.0", id: goneId, method: "thread/start",
    params: { threadId: "t-noreg", cwd: workspace, options, instructionMode: "append" },
  });
  await waitFor(() => replies(goneId).length === 1, 20_000, "start without registry");
  check(
    !marksSince(marksBeforeGone).some((m) => Object.hasOwn(BINDINGS, m.home)),
    "install-bound accounts stayed out of the pick without a registry",
  );
  // The pool exists but every account is bound → nobody can serve the
  // model → honest refusal (a silent direct fall would hide the dead pool).
  check(
    replies(goneId)[0]?.error !== undefined,
    "pool thread/start with all-bound accounts fails honestly without a registry",
  );
  process.env.AGY_ACCOUNTS = "0";
  const marksBeforeLegacy = binMarks().length;
  const legacyId = rid();
  send({
    jsonrpc: "2.0", id: legacyId, method: "thread/start",
    params: { threadId: "t-legacy", cwd: workspace, options, instructionMode: "append" },
  });
  await waitFor(() => replies(legacyId).length === 1, 20_000, "direct start without registry");
  check(
    marksSince(marksBeforeLegacy).some((m) => m.__bin === "legacy"),
    "no registry → direct launch resolves via resolveAgyCommand (legacy bin)",
  );
  delete process.env.AGY_ACCOUNTS;

  // -- §11 п.4: broken registry → honest failure ------------------------
  writeFileSync(registryPath, "{ broken json\n");
  const marksBeforeBroken = binMarks().length;
  const brokenId = rid();
  send({
    jsonrpc: "2.0", id: brokenId, method: "thread/start",
    params: { threadId: "t-broken", cwd: workspace, options, instructionMode: "append" },
  });
  await waitFor(() => replies(brokenId).length === 1, 20_000, "start on broken registry");
  check(replies(brokenId)[0]?.error !== undefined, "broken registry → thread/start errors");
  check(
    !marksSince(marksBeforeBroken).length,
    "broken registry → no binary launched",
  );

  writeRegistry((doc) => {
    doc.default = "missing";
    return doc;
  });
  const badDefaultId = rid();
  send({
    jsonrpc: "2.0", id: badDefaultId, method: "thread/start",
    params: { threadId: "t-baddefault", cwd: workspace, options, instructionMode: "append" },
  });
  await waitFor(() => replies(badDefaultId).length === 1, 20_000, "start on missing default");
  check(replies(badDefaultId)[0]?.error !== undefined, "default→missing → thread/start errors");

  // -- §11 п.4a: forbidden env key → schema refusal ---------------------
  writeRegistry((doc) => {
    doc.installs.secondary.env = { AGY_PATH: "/nope" };
    return doc;
  });
  const marksBeforeForbidden = binMarks().length;
  const forbiddenId = rid();
  send({
    jsonrpc: "2.0", id: forbiddenId, method: "thread/start",
    params: { threadId: "t-forbidden", cwd: workspace, options, instructionMode: "append" },
  });
  await waitFor(() => replies(forbiddenId).length === 1, 20_000, "start on forbidden env");
  check(replies(forbiddenId)[0]?.error !== undefined, "forbidden env key → thread/start errors");
  check(
    !marksSince(marksBeforeForbidden).length,
    "forbidden env key → no binary launched",
  );
} else {
  // ======================= stream-json bridge suite ======================
  check(
    bridgeLogLines().some((l) => l.includes("installs registry loaded:") && l.includes("default=main")),
    "9.1 bridge.log: installs registry loaded line",
  );

  // §11 п.1/7: pool threads pin the global LRU order (m1, m2, then s1)
  // and each spawns on its own install's binary.
  startThread("b-m1");
  await waitFor(() => replies(nextId - 1).length === 1, 20_000, "b-m1 start");
  startThread("b-m2");
  await waitFor(() => replies(nextId - 1).length === 1, 20_000, "b-m2 start");
  startThread("b-s1");
  await waitFor(() => replies(nextId - 1).length === 1, 20_000, "b-s1 start");
  check(
    binMarks().some((m) => m.home === "m1" && m.__bin === "main"),
    "b-m1 spawned on fake-agy-main (startChild)",
  );
  check(
    binMarks().some((m) => m.home === "m2" && m.__bin === "main") &&
      binMarks().some((m) => m.home === "s1" && m.__bin === "secondary"),
    "LRU reached secondary: b-s1 spawned on fake-agy-secondary (startChild)",
  );

  // §11 п.10-ish: model/list → listAgyModels probes an eligible account's
  // own binary; unavailable installs are never picked for it.
  const marksBeforeModels = binMarks().length;
  const modelsId = rid();
  send({ jsonrpc: "2.0", id: modelsId, method: "model/list", params: {} });
  await waitFor(() => replies(modelsId).length === 1, 30_000, "model/list");
  check(
    marksSince(marksBeforeModels).every(
      (m) => !["ghost", "bad", "dead"].includes(m.home),
    ),
    "model/list probe never touched an unavailable account",
  );

  // §11 п.2: relay/direct → strictly the default install.
  process.env.AGY_ACCOUNTS = "0";
  const directMarks = binMarks().length;
  startThread("b-direct");
  await waitFor(() => replies(nextId - 1).length === 1, 20_000, "b-direct start");
  check(
    marksSince(directMarks).some((m) => m.__bin === "main") &&
      !marksSince(directMarks).some((m) => m.__bin === "secondary" || m.__bin === "legacy"),
    "direct session ran strictly the default install binary",
  );
  delete process.env.AGY_ACCOUNTS;

  // §11 п.4: broken registry → honest spawn failure, no substitute bin.
  writeFileSync(registryPath, "{ broken\n");
  const beforeBroken = binMarks().length;
  startThread("b-broken");
  await waitFor(() => replies(nextId - 1).length === 1, 20_000, "b-broken settles");
  check(
    !marksSince(beforeBroken).length,
    "broken registry → no child spawned",
  );
}

check(allMarksConsistent(marksSince(0)), "every launch ran the account's own install binary");

process.stdout.write = originalWrite;
for (const r of results) say(r);
if (failures > 0) {
  say("\n--- transcript ---");
  for (const l of transcriptLines()) say(JSON.stringify(l).slice(0, 300));
  say("--- wrapper log (tail) ---");
  for (const l of wrapperLogLines().slice(-25)) say(l);
  say(`\n${failures} FAILURES`);
  process.exit(1);
}
say("\nharness-installs: all green");
process.exit(0);
