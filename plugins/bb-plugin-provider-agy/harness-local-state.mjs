/**
 * Instance-local state harness — spec §2.1 test block in §11 п.2.
 *
 * Part A drives src/accounts.ts directly: pin migration and union,
 * overlay merge/drop rules, dirtyLabels discipline, merge-on-save between
 * two writers of the same instance.
 *
 * Part B drives the built dist/host.js once per transport (ACP default,
 * then AGY_TRANSPORT=stream-json — the bundle re-evaluates the transport
 * pick on a fresh import URL): a conversation pin survives a keeper-style
 * rewrite of accounts-state.json, and a locally-set cooldown keeps a
 * pinned resume off the dead HOME until it expires.
 *
 * Usage: node --experimental-strip-types harness-local-state.mjs
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const say = (...a) => process.stderr.write(`${a.join(" ")}\n`);
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push([name, ok]);
  say(`${ok ? "pass" : "FAIL"} ${name} ${detail}`);
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);

// ===========================================================================
// Part A — ledger mechanics on the source module.
// ===========================================================================
const acct = await import(new URL("./src/accounts.ts", import.meta.url).href);
const {
  loadLedger,
  saveLedger,
  rememberConversation,
  conversationAccount,
  markAccountUse,
  markAccountCooldown,
  markAccountIneligible,
  pickAccount,
} = acct;

const rootA = mkdtempSync(join(tmpdir(), "agy-localstate-"));
// Real pool labels always have accounts/<label>/ homes — overlay records
// for labels absent from BOTH the shared file and accounts/ are ghosts
// and get cleaned on save.
for (const label of ["a1", "a2", "a3"]) {
  mkdirSync(join(rootA, "accounts", label), { recursive: true });
}
const sharedPath = join(rootA, "accounts-state.json");
const convPath = join(rootA, "conversations-state.json");
const overlayPath = join(rootA, "accounts-overlay.json");
writeJson(sharedPath, {
  accounts: {
    a1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null },
  },
  conversations: { "legacy-pin": "a1" },
});

// A1: legacy shared pins migrate eagerly — the local file appears on load,
// before this instance ever saved.
const l1 = loadLedger(rootA);
check(
  "localstate/legacy-pin-eager-migration",
  existsSync(convPath) &&
    readJson(convPath)?.conversations?.["legacy-pin"] === "a1" &&
    l1.conversations["legacy-pin"] === "a1",
  JSON.stringify(readJson(convPath)),
);

// A2: save persists pins locally and the shared file loses the field.
saveLedger(rootA, l1);
check(
  "localstate/save-drops-shared-conversations",
  readJson(sharedPath)?.conversations === undefined &&
    readJson(convPath)?.conversations?.["legacy-pin"] === "a1",
  JSON.stringify(Object.keys(readJson(sharedPath) ?? {})),
);

// A3: a keeper-style rewrite of the shared file (no conversations, no
// marks) cannot erase the pin.
writeJson(sharedPath, { accounts: {} });
check(
  "localstate/pin-survives-keeper-rewrite",
  conversationAccount(loadLedger(rootA), "legacy-pin") === "a1",
  "",
);

// A4: helper-set marks land in the overlay with writtenMs, and survive the
// next shared rewrite — quota cooldown, use stamp and a parking alike.
const l2 = loadLedger(rootA);
markAccountCooldown(l2, "a1", Date.now() + 3_600_000, "quota 429");
markAccountUse(l2, "a2");
markAccountIneligible(l2, "a3", { parkedReason: "auth-dead" });
saveLedger(rootA, l2);
const overlay1 = readJson(overlayPath);
check(
  "localstate/helper-marks-reach-overlay",
  (overlay1?.accounts?.a1?.cooldownUntilMs ?? 0) > Date.now() &&
    typeof overlay1?.accounts?.a1?.writtenMs === "number" &&
    (overlay1?.accounts?.a2?.lastUsedMs ?? 0) > 0 &&
    (overlay1?.accounts?.a3?.ineligibleAtMs ?? 0) > 0 &&
    overlay1?.accounts?.a3?.parkedReason === "auth-dead",
  JSON.stringify(overlay1),
);
writeJson(sharedPath, { accounts: {} }); // keeper wipes every mark
const l3 = loadLedger(rootA);
check(
  "localstate/overlay-survives-keeper-rewrite",
  (l3.accounts.a1?.cooldownUntilMs ?? 0) > Date.now() &&
    (l3.accounts.a2?.lastUsedMs ?? 0) > 0 &&
    (l3.accounts.a3?.ineligibleAtMs ?? 0) > 0 &&
    l3.accounts.a3?.parkedReason === "auth-dead",
  JSON.stringify(l3.accounts),
);

// A5: shared side fresher than the shadow lifts it whole — numbers merge
// by max only while the shadow applies.
const freshMs = Date.now() + 60_000;
writeJson(sharedPath, {
  accounts: {
    a1: { cooldownUntilMs: 0, lastUsedMs: freshMs, lastError: null },
    a2: { cooldownUntilMs: 0, lastUsedMs: freshMs, lastError: null },
    a3: { cooldownUntilMs: 0, lastUsedMs: freshMs, lastError: null },
  },
});
const l4 = loadLedger(rootA);
check(
  "localstate/fresh-shared-lastused-drops-shadow",
  l4.accounts.a1?.cooldownUntilMs === 0 &&
    (l4.accounts.a3?.ineligibleAtMs ?? undefined) === undefined &&
    l4.accounts.a3?.parkedReason === undefined &&
    l4.accounts.a2?.lastUsedMs === freshMs,
  JSON.stringify(l4.accounts),
);

// A6: while the shadow applies, numeric fields take the max of both sides —
// a fresher shared cooldown is not masked by an older overlay one.
{
  const sh = readJson(sharedPath);
  sh.accounts.a1 = {
    cooldownUntilMs: Date.now() + 7_200_000,
    lastUsedMs: 0, // older than the shadow's writtenMs
    lastError: null,
  };
  writeJson(sharedPath, sh);
  const merged = loadLedger(rootA).accounts.a1;
  check(
    "localstate/numeric-fields-merge-max",
    (merged?.cooldownUntilMs ?? 0) > Date.now() + 7_190_000 &&
      merged?.lastError === "quota 429",
    JSON.stringify(merged),
  );
}

// A7: dirtyLabels discipline — a direct field write never reaches the
// overlay, so the next keeper wipe erases it (why helpers are mandatory).
{
  const l = loadLedger(rootA);
  l.accounts.a1.cooldownUntilMs = Date.now() + 9_999_000;
  saveLedger(rootA, l);
  const ov = readJson(overlayPath)?.accounts?.a1;
  check(
    "localstate/direct-write-skips-overlay",
    (ov?.cooldownUntilMs ?? 0) < Date.now() + 7_300_000,
    `overlay a1 cooldown=${ov?.cooldownUntilMs}`,
  );
}

// A8: a save carrying only a conversation pin does not bump overlay
// writtenMs (no idle writes on the shadow file).
{
  const before = readJson(overlayPath)?.accounts?.a1?.writtenMs ?? null;
  const l = loadLedger(rootA);
  rememberConversation(l, "pin-only", "a1");
  await new Promise((r) => setTimeout(r, 15));
  saveLedger(rootA, l);
  const after = readJson(overlayPath)?.accounts?.a1?.writtenMs ?? null;
  check(
    "localstate/pin-only-save-keeps-writtenms",
    before === after && readJson(convPath)?.conversations?.["pin-only"] === "a1",
    `writtenMs ${before} -> ${after}`,
  );
}

// A9: two parallel writers of one instance merge on save — pins union,
// overlay records merge per label.
{
  const w1 = loadLedger(rootA);
  const w2 = loadLedger(rootA);
  rememberConversation(w1, "conv-w1", "a1");
  markAccountCooldown(w1, "a1", Date.now() + 5_000, "w1 mark");
  saveLedger(rootA, w1);
  rememberConversation(w2, "conv-w2", "a2");
  markAccountCooldown(w2, "a2", Date.now() + 5_000, "w2 mark");
  saveLedger(rootA, w2); // stale view, must not lose w1's work
  const conv = readJson(convPath)?.conversations ?? {};
  const ov = readJson(overlayPath)?.accounts ?? {};
  const merged = loadLedger(rootA);
  check(
    "localstate/two-writers-merge-on-save",
    conv["conv-w1"] === "a1" &&
      conv["conv-w2"] === "a2" &&
      ov.a1 !== undefined &&
      ov.a2 !== undefined &&
      merged.conversations["conv-w1"] === "a1" &&
      merged.conversations["conv-w2"] === "a2",
    JSON.stringify({ conv, ov: Object.keys(ov) }),
  );
}

// A10: same-label overlay race — two parallel ledgers dirty the SAME
// label; the per-field disk merge keeps each side's fields: w1's cooldown
// survives w2's stale snapshot, and w2's fresher strings win (its null
// lastError is a value, not an absence).
{
  const race = mkdtempSync(join(tmpdir(), "agy-localstate-race-"));
  writeJson(join(race, "accounts-state.json"), {
    accounts: {
      a1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null },
    },
  });
  const w1 = loadLedger(race);
  const w2 = loadLedger(race); // stale snapshot from the same load point
  const cooldownUntil = Date.now() + 5_000;
  markAccountCooldown(w1, "a1", cooldownUntil, "w1 429");
  saveLedger(race, w1);
  markAccountIneligible(w2, "a1", { parkedReason: "auth-dead" });
  saveLedger(race, w2); // carries neither w1's cooldown nor its error
  const a1 = readJson(join(race, "accounts-overlay.json"))?.accounts?.a1;
  check(
    "localstate/same-label-overlay-race-field-merge",
    (a1?.cooldownUntilMs ?? 0) >= cooldownUntil &&
      (a1?.ineligibleAtMs ?? 0) > 0 &&
      a1?.parkedReason === "auth-dead" &&
      a1?.lastError === null,
    JSON.stringify(a1),
  );
}

// A11: re-pin race — a stale ledger must not write a neighbour's re-pin
// back: save pushes only dirtyPins keys over the disk map.
{
  const repin = mkdtempSync(join(tmpdir(), "agy-localstate-repin-"));
  writeJson(join(repin, "accounts-state.json"), { accounts: {} });
  const w1 = loadLedger(repin);
  rememberConversation(w1, "conv", "a1");
  saveLedger(repin, w1); // disk: conv -> a1
  const w3 = loadLedger(repin);
  const w4 = loadLedger(repin); // both snapshots see conv -> a1
  rememberConversation(w3, "conv", "a2");
  saveLedger(repin, w3); // disk: conv -> a2
  rememberConversation(w4, "other", "a1");
  saveLedger(repin, w4); // w4's stale conv -> a1 must not come back
  const conv =
    readJson(join(repin, "conversations-state.json"))?.conversations ?? {};
  check(
    "localstate/stale-ledger-keeps-neighbour-repin",
    conv["conv"] === "a2" && conv["other"] === "a1",
    JSON.stringify(conv),
  );
}

// A12: broken JSON in each of the three files — load treats each as empty
// instead of throwing.
{
  const broken = mkdtempSync(join(tmpdir(), "agy-localstate-broken-"));
  writeFileSync(join(broken, "accounts-state.json"), "{ nope");
  writeFileSync(join(broken, "conversations-state.json"), "%%%");
  writeFileSync(join(broken, "accounts-overlay.json"), "not json");
  let brokenLoad = null;
  try {
    brokenLoad = loadLedger(broken);
  } catch (e) {
    brokenLoad = e;
  }
  check(
    "localstate/broken-json-files-load-empty",
    !(brokenLoad instanceof Error) &&
      Object.keys(brokenLoad?.accounts ?? { x: 1 }).length === 0 &&
      Object.keys(brokenLoad?.conversations ?? { x: 1 }).length === 0,
    brokenLoad instanceof Error ? String(brokenLoad) : "ok",
  );
}

// A13: the shadow dies by untilMs too — an expired overlay cooldown stops
// masking the account; expiry is decided against `now` at use.
{
  const exp = mkdtempSync(join(tmpdir(), "agy-localstate-exp-"));
  writeJson(join(exp, "accounts-state.json"), {
    accounts: {
      a1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null },
    },
  });
  writeJson(join(exp, "accounts-overlay.json"), {
    accounts: {
      a1: {
        cooldownUntilMs: Date.now() - 1_000,
        lastUsedMs: 0,
        lastError: "old 429",
        writtenMs: Date.now(),
      },
    },
  });
  const l = loadLedger(exp);
  const pick = pickAccount(l, [{ label: "a1", home: "/x", proxy: null }]);
  check(
    "localstate/expired-shadow-cools-off",
    (l.accounts.a1?.cooldownUntilMs ?? Infinity) <= Date.now() &&
      pick?.label === "a1",
    JSON.stringify(l.accounts.a1),
  );
}

// A14: ghost cleanup — an overlay record for a label absent from both the
// shared file and accounts/ is dropped on the next dirty save and does
// not leak into the shared write; a label with an accounts/ dir survives.
{
  const ghost = mkdtempSync(join(tmpdir(), "agy-localstate-ghost-"));
  mkdirSync(join(ghost, "accounts", "a1"), { recursive: true });
  mkdirSync(join(ghost, "accounts", "dirkept"), { recursive: true });
  writeJson(join(ghost, "accounts-state.json"), {
    accounts: {
      a1: { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null },
    },
  });
  writeJson(join(ghost, "accounts-overlay.json"), {
    accounts: {
      ghost: {
        cooldownUntilMs: 0, lastUsedMs: 1, lastError: null, writtenMs: 1,
      },
      dirkept: {
        cooldownUntilMs: 0, lastUsedMs: 1, lastError: null, writtenMs: 1,
      },
    },
  });
  const l = loadLedger(ghost);
  markAccountCooldown(l, "a1", Date.now() + 5_000, "touch");
  saveLedger(ghost, l);
  const ov = readJson(join(ghost, "accounts-overlay.json"))?.accounts ?? {};
  const sh = readJson(join(ghost, "accounts-state.json"))?.accounts ?? {};
  check(
    "localstate/ghost-records-cleaned-on-save",
    ov.ghost === undefined &&
      ov.dirkept !== undefined &&
      ov.a1 !== undefined &&
      sh.ghost === undefined,
    JSON.stringify({ ov: Object.keys(ov), sh: Object.keys(sh) }),
  );
}

// A15: eager migration fires on a broken local file — legacy shared pins
// are rewritten locally even though conversations-state.json exists.
{
  const em = mkdtempSync(join(tmpdir(), "agy-localstate-eager-"));
  writeJson(join(em, "accounts-state.json"), {
    accounts: {},
    conversations: { "leg-1": "a1" },
  });
  writeFileSync(join(em, "conversations-state.json"), "%%%broken");
  const l = loadLedger(em);
  check(
    "localstate/eager-migration-on-broken-local",
    l.conversations["leg-1"] === "a1" &&
      readJson(join(em, "conversations-state.json"))?.conversations?.[
        "leg-1"
      ] === "a1",
    JSON.stringify(readJson(join(em, "conversations-state.json"))),
  );
}

// A16: writtenMs == shared.lastUsedMs boundary — the shadow still applies
// (equal stamps are deliberate: only strictly fresher shared lifts it);
// ineligibleAtMs merges by max, here won by the shared side.
{
  const bnd = mkdtempSync(join(tmpdir(), "agy-localstate-bound-"));
  const T = Date.now();
  writeJson(join(bnd, "accounts-state.json"), {
    accounts: {
      a1: {
        cooldownUntilMs: 0, lastUsedMs: T, lastError: "shared",
        ineligibleAtMs: 200,
      },
    },
  });
  writeJson(join(bnd, "accounts-overlay.json"), {
    accounts: {
      a1: {
        cooldownUntilMs: T + 5_000, lastUsedMs: 0,
        lastError: null, parkedReason: "auth-dead",
        ineligibleAtMs: 123, writtenMs: T,
      },
    },
  });
  const a1 = loadLedger(bnd).accounts.a1;
  check(
    "localstate/shadow-boundary-writtenms-eq-lastused",
    a1?.cooldownUntilMs === T + 5_000 &&
      a1?.lastUsedMs === T &&
      a1?.ineligibleAtMs === 200 &&
      a1?.parkedReason === "auth-dead" &&
      a1?.lastError === null,
    JSON.stringify(a1),
  );
}

// ===========================================================================
// Part B — end-to-end on the built bridge, once per transport.
// ===========================================================================
const workspace = join(rootA, "ws");
mkdirSync(workspace, { recursive: true });
const options = {
  model: "fake-model",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

async function bridgeRun(transport) {
  const root = mkdtempSync(join(tmpdir(), `agy-localstate-${transport}-`));
  const transcriptPath = join(root, "transcript.ndjson");
  const shim = join(root, "agy-bin");
  if (transport === "acp") {
    const fake = new URL("./fake-agy-acp.mjs", import.meta.url).pathname;
    writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
    process.env.AGY_FAKE_CONTROL = join(root, "control.json");
    writeFileSync(process.env.AGY_FAKE_CONTROL, "{}\n");
    process.env.AGY_IDLE_KILL_MS = "0";
  } else {
    const fake = new URL("./fake-agy-errors.mjs", import.meta.url).pathname;
    writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
    process.env.AGY_TRANSPORT = "stream-json";
    process.env.AGY_FAKE_ERROR_MODE = "succeed";
    process.env.AGY_IDLE_KILL_MS = "1200"; // children die between phases
  }
  chmodSync(shim, 0o755);
  process.env.AGY_PATH = shim;
  process.env.AGY_CLIPROXY = "0";
  process.env.AGY_FAKE_TRANSCRIPT = transcriptPath;
  process.env.AGY_FAKE_RECORD_ENV = "HOME";
  process.env.AGY_AUTO_RETRY_MAX = "0";
  process.env.AGY_AUTO_RETRY_MAX_WAIT_MS = "1";

  for (const label of ["a1", "a2", "a3"]) {
    const cli = join(root, "accounts", label, ".gemini", "antigravity-cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
  }

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
    new URL(`./dist/host.js?localstate-${transport}`, import.meta.url).href
  );
  bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
  const send = (m) => bridge.handleLine(JSON.stringify(m));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const replies = (id) =>
    messages.filter((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
  const boundaries = (tid) =>
    messages
      .filter((m) => m.method === "thread/delta" && m.params.threadId === tid)
      .flatMap((m) => m.params.deltas)
      .filter((d) => d.kind === "turn.boundary");
  async function waitFor(pred, ms, label) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (pred()) return;
      if (Date.now() > deadline) {
        process.stdout.write = originalWrite;
        say(`!!! timeout: ${label}`);
        for (const m of messages.slice(-30)) say(JSON.stringify(m).slice(0, 260));
        process.exit(2);
      }
      await sleep(40);
    }
  }
  const transcriptLines = () =>
    existsSync(transcriptPath)
      ? readFileSync(transcriptPath, "utf8")
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
  // Labels, not paths: ACP transcript `home` is the label; stream-json
  // spawn lines carry the full HOME path.
  const homeLabelOf = (l) =>
    transport === "acp" ? l.home : (l.__env?.HOME ?? "").split("/").pop();
  const loadLabels = () =>
    transport === "acp"
      ? transcriptLines().filter((l) => l.method === "session/load").map(homeLabelOf)
      : transcriptLines()
          .filter((l) => l.__env !== undefined && l.__argv?.includes("--conversation"))
          .map(homeLabelOf);
  const freshLabels = () =>
    transport === "acp"
      ? transcriptLines().filter((l) => l.method === "session/new").map(homeLabelOf)
      : transcriptLines()
          .filter((l) => l.__env !== undefined && !l.__argv?.includes("--conversation"))
          .map(homeLabelOf);

  send({ jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: 2, client: { name: "harness", version: "1" }, grammarVersions: [2, 3] } });

  // B1: a thread lands on a pool account; its pin goes to the local file.
  send({ jsonrpc: "2.0", id: 1, method: "thread/start",
    params: { threadId: "t1", cwd: workspace, options, instructionMode: "append" } });
  await waitFor(() => replies(1).length === 1 && replies(1)[0].result?.providerThreadId, 20000, `${transport}: t1 start`);
  const ptid = replies(1)[0].result.providerThreadId;
  const ownerLabel = readJson(join(root, "conversations-state.json"))?.conversations?.[ptid];
  check(
    `${transport}/pin-in-local-file`,
    typeof ownerLabel === "string" &&
      (readJson(join(root, "accounts-state.json"))?.conversations?.[ptid] ?? null) === null,
    `owner=${ownerLabel} ptid=${ptid}`,
  );

  // B2: keeper-style rewrite (shared now carries only plain marks — no
  // conversations). Resume still finds the owner and loads on its HOME.
  const wipedAccounts = {};
  for (const l of ["a1", "a2", "a3"]) {
    wipedAccounts[l] = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null };
  }
  writeJson(join(root, "accounts-state.json"), { accounts: wipedAccounts });
  const loadsBefore = loadLabels().length;
  send({ jsonrpc: "2.0", id: 2, method: "thread/resume",
    params: { threadId: "t2", cwd: workspace, providerThreadId: ptid, options, instructionMode: "append" } });
  await waitFor(() => replies(2).length === 1, 25000, `${transport}: t2 resume`);
  await waitFor(
    () => loadLabels().length > loadsBefore || replies(2)[0].error !== undefined,
    25000,
    `${transport}: t2 loads on owner`,
  );
  check(
    `${transport}/resume-finds-owner-after-keeper-rewrite`,
    replies(2)[0].error === undefined && loadLabels().includes(ownerLabel),
    `loads=${JSON.stringify(loadLabels())} owner=${ownerLabel} err=${JSON.stringify(replies(2)[0].error)}`,
  );

  // B3: park the owner through a real refusal on this instance, wipe the
  // shared file again, and a pinned resume must rotate to a sibling —
  // the overlay shadow carries the parking across the keeper sync.
  if (transport === "acp") {
    // The live a1 session refuses its next prompt; the wrapper parks it
    // and replays the turn on a sibling.
    const c = JSON.parse(readFileSync(process.env.AGY_FAKE_CONTROL, "utf8"));
    c.modeByLabel = { [ownerLabel]: "ineligible" };
    writeFileSync(process.env.AGY_FAKE_CONTROL, JSON.stringify(c));
    send({ jsonrpc: "2.0", id: 3, method: "turn/start",
      params: { threadId: "t2", providerThreadId: ptid,
        input: [{ type: "text", text: "park me", mentions: [] }],
        clientRequestId: "creq_abcdehjkmn", options } });
    await waitFor(
      () => boundaries("t2").length >= 1 && boundaries("t2").at(-1).status === "completed",
      40000,
      "acp: parked turn replays on sibling",
    );
    const c2 = JSON.parse(readFileSync(process.env.AGY_FAKE_CONTROL, "utf8"));
    c2.modeByLabel = {};
    writeFileSync(process.env.AGY_FAKE_CONTROL, JSON.stringify(c2));
  } else {
    // The a1 child is idle-killed (1.2s); the resume respawns it, and the
    // fake now exits with the eligibility refusal before init.
    process.env.AGY_FAKE_MODE_BY_LABEL = JSON.stringify({ [ownerLabel]: "ineligible" });
    await sleep(2000);
    send({ jsonrpc: "2.0", id: 3, method: "thread/resume",
      params: { threadId: "t3", cwd: workspace, providerThreadId: ptid, options, instructionMode: "append" } });
    await waitFor(
      () => replies(3).length === 1 && replies(3)[0].error !== undefined,
      25000,
      "stream-json: resume parks and fails",
    );
    check(
      `${transport}/resume-parks-then-fails`,
      `${replies(3)[0].error?.message ?? ""}`.includes("accounts.google.com"),
      JSON.stringify(replies(3)[0].error),
    );
    delete process.env.AGY_FAKE_MODE_BY_LABEL;
  }
  await sleep(300);
  const overlay = readJson(join(root, "accounts-overlay.json"));
  check(
    `${transport}/ineligible-mark-in-overlay`,
    (overlay?.accounts?.[ownerLabel]?.ineligibleAtMs ?? 0) > 0 &&
      (overlay?.accounts?.[ownerLabel]?.cooldownUntilMs ?? 0) > Date.now(),
    JSON.stringify(overlay?.accounts?.[ownerLabel] ?? null),
  );
  writeJson(join(root, "accounts-state.json"), { accounts: wipedAccounts });
  // A second conversation pinned to the owner: the rotation below repins
  // ptid onto the sibling (same conversation id answer on every HOME), so
  // the parked-owner + shadow-lift resumes ride this stable pin instead.
  const ghostPtid = "fake-ghost-conv";
  const convFile = readJson(join(root, "conversations-state.json")) ?? { conversations: {} };
  convFile.conversations[ghostPtid] = ownerLabel;
  writeJson(join(root, "conversations-state.json"), convFile);
  const loadsBefore4 = loadLabels().length;
  const freshBefore4 = freshLabels().length;
  send({ jsonrpc: "2.0", id: 4, method: "thread/resume",
    params: { threadId: "t4", cwd: workspace, providerThreadId: ghostPtid, options, instructionMode: "append" } });
  await waitFor(() => replies(4).length === 1, 25000, `${transport}: t4 resume`);
  await sleep(300);
  const newOwnerLoads = loadLabels().slice(loadsBefore4).filter((h) => h === ownerLabel);
  const newFresh = freshLabels().slice(freshBefore4);
  check(
    `${transport}/parked-owner-rotates-not-reloads`,
    newOwnerLoads.length === 0 && newFresh.some((h) => h && h !== ownerLabel),
    `ownerLoads=${newOwnerLoads.length} fresh=${JSON.stringify(newFresh)} err=${JSON.stringify(replies(4)[0]?.error)}`,
  );

  // B4: a fresh shared lastUsedMs lifts the shadow — the next resume lands
  // back on the owner (the unpark protocol from the README).
  const revived = { accounts: {} };
  for (const l of ["a1", "a2", "a3"]) {
    revived.accounts[l] = { cooldownUntilMs: 0, lastUsedMs: Date.now(), lastError: null };
  }
  writeJson(join(root, "accounts-state.json"), revived);
  const loadsBefore5 = loadLabels().length;
  send({ jsonrpc: "2.0", id: 5, method: "thread/resume",
    params: { threadId: "t5", cwd: workspace, providerThreadId: ghostPtid, options, instructionMode: "append" } });
  await waitFor(() => replies(5).length === 1, 25000, `${transport}: t5 resume`);
  await waitFor(
    () => loadLabels().slice(loadsBefore5).includes(ownerLabel) ||
      replies(5)[0].error !== undefined,
    25000,
    `${transport}: t5 loads on revived owner`,
  );
  check(
    `${transport}/fresh-shared-lifts-shadow`,
    replies(5)[0].error === undefined &&
      loadLabels().slice(loadsBefore5).includes(ownerLabel),
    `loads=${JSON.stringify(loadLabels().slice(loadsBefore5))} err=${JSON.stringify(replies(5)[0]?.error)}`,
  );

  process.stdout.write = originalWrite;
  if (transport === "acp") delete process.env.AGY_FAKE_CONTROL;
  delete process.env.AGY_FAKE_MODE_BY_LABEL;
  delete process.env.AGY_TRANSPORT;

}

const only = process.env.HARNESS_TRANSPORT ?? "both";
if (only === "acp" || only === "both") await bridgeRun("acp");
if (only === "stream-json" || only === "both") await bridgeRun("stream-json");

say(`\n${checks.filter(([, ok]) => ok).length}/${checks.length} passed`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
