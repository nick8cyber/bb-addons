/**
 * Operator-commands harness (provider-agy-installs §11 пп. 10–11): runs
 * scripts/add-account.mjs and scripts/import-accounts.mjs as child
 * processes against fake install binaries and drives the managed stop
 * points (AGY_FAKE_CHECKPOINT_DIR, install-lib checkpoint()) to land a
 * concurrent accounts-state.json overwrite exactly inside the
 * "binding write → re-read" window the spec makes deterministic.
 *
 * Coverage:
 *   §11 п.10 add-account.mjs
 *     - --install secondary → login ran the secondary binary, the binding
 *       is on disk before the account ever appears in accounts/
 *     - no flag / --install default / --install <default name> → login
 *       ran the default binary, no install field is written
 *     - unknown name, pattern-failing name, missing registry, broken
 *       registry, taken label → refusal, nothing written
 *     - pool-satellite marker → refusal, nothing written
 *     - no registry and no flag → legacy resolveAgyCommand order
 *       (AGY_PATH wins)
 *     - checkpoint invariant: accounts/<label> is never present without
 *       its binding on disk at any stop point; on the wipe path the
 *       visible-without-binding window exists only until the rewrite
 *       lands, and exhausting 3 rewrites rolls the account back
 *   §11 п.11 import-accounts.mjs
 *     - --install stages the same way; unknown name / missing registry /
 *       satellite → refusal, the shared file byte-identical
 *     - wipe-once path recovers on the first rewrite; exhaustion rolls
 *       the staged account back
 *     - --install into a pre-existing home (proxy file, no token) merges
 *       the token in atomically and keeps the files already placed;
 *       rollback out of it removes only the merged token — the same
 *       files survive the rollback
 *     - --rebind rewrites the binding atomically, "default" removes the
 *       field; unknown name / unknown label / satellite → refusal
 *     (the "running session is not restarted" half lives in
 *      harness-installs.mjs, which owns a live pool)
 *
 * Mutations this kills: a binding written before the name check, a login
 * straight into accounts/ with the field written afterwards, a missing
 * rewrite/rollback, and any satellite write — each fails a checkpoint or
 * a refusal assert.
 *
 * Usage: node harness-installs-commands.mjs
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTeardown, trackedMkdtemp } from "./harness-teardown.mjs";
installTeardown();

const root = trackedMkdtemp(join(tmpdir(), "agy-install-commands-"));
const pluginDir = new URL(".", import.meta.url).pathname;
const addAccount = join(pluginDir, "scripts", "add-account.mjs");
const importAccounts = join(pluginDir, "scripts", "import-accounts.mjs");
const transcript = join(root, "transcript.ndjson");
process.env.AGY_FAKE_TRANSCRIPT = transcript;

// A fake install binary: stamps which binary ran for whom, then performs
// the part of a native sign-in the script waits on — the oauth token file
// inside the staged HOME.
const mkBin = (name) => {
  mkdirSync(join(root, "bin"), { recursive: true });
  const p = join(root, "bin", `agy-${name}`);
  writeFileSync(
    p,
    `#!/bin/sh
printf '{"__bin":"${name}","home":"%s"}\\n' "$(basename "\${HOME:-none}")" >> "$AGY_FAKE_TRANSCRIPT"
mkdir -p "$HOME/.gemini/antigravity-cli"
printf '{"auth_method":"consumer","token":{"refresh_token":"rt-${name}"}}\\n' > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
exit 0
`,
  );
  chmodSync(p, 0o755);
  return p;
};
const binMain = mkBin("main");
const binSecondary = mkBin("secondary");
const binLegacy = mkBin("legacy");

const dataDir = join(root, "data");
mkdirSync(join(dataDir, "accounts"), { recursive: true });
const statePath = join(dataDir, "accounts-state.json");
const registryPath = join(dataDir, "agy-installs.json");
writeFileSync(
  registryPath,
  `${JSON.stringify(
    {
      installs: {
        main: { bin: binMain },
        secondary: { bin: binSecondary },
      },
      default: "main",
    },
    null,
    2,
  )}\n`,
);
writeFileSync(statePath, '{"accounts":{}}\n');

// A second data dir with NO registry — the legacy-resolution path, and
// a third wearing the pool-satellite marker.
const noregDir = join(root, "data-noreg");
mkdirSync(join(noregDir, "accounts"), { recursive: true });
writeFileSync(join(noregDir, "accounts-state.json"), '{"accounts":{}}\n');
const satDir = join(root, "data-sat");
mkdirSync(join(satDir, "accounts"), { recursive: true });
writeFileSync(join(satDir, "accounts-state.json"), '{"accounts":{"sat-a":{"install":"secondary"}}}\n');
writeFileSync(
  join(satDir, "agy-installs.json"),
  readFileSync(registryPath),
);
writeFileSync(join(satDir, "pool-satellite"), "");
mkdirSync(join(satDir, "accounts", "sat-a", ".gemini", "antigravity-cli"), { recursive: true });
writeFileSync(
  join(satDir, "accounts", "sat-a", ".gemini", "antigravity-cli", "antigravity-oauth-token"),
  '{"auth_method":"consumer"}\n',
);

const say = (...a) => process.stdout.write(`${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (cond, name) => {
  results.push(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures += 1;
};

const readState = (dir = dataDir) =>
  JSON.parse(readFileSync(join(dir, "accounts-state.json"), "utf8"));
const stateBytes = (dir = dataDir) =>
  readFileSync(join(dir, "accounts-state.json"), "utf8");
const accountDirOf = (dir, label) => join(dir, "accounts", label);
const installOf = (dir, label) => readState(dir).accounts[label]?.install;
const transcriptLines = () =>
  existsSync(transcript)
    ? readFileSync(transcript, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    : [];
const lastMark = () => transcriptLines().at(-1) ?? {};

// The keeper-sync/saveLedger foreign writer the spec races: drop the
// label from the shared file entirely (a snapshot that predates it).
const wipeLabel = (dir, label) => {
  const st = readState(dir);
  delete st.accounts[label];
  writeFileSync(join(dir, "accounts-state.json"), `${JSON.stringify(st, null, 2)}\n`);
};

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      say(`!!! timeout: ${label}`);
      process.exit(2);
    }
    await sleep(25);
  }
}

let runN = 0;
/**
 * Spawn a script and walk its checkpoints. `steps` lists {name, act} —
 * the hold file for each is planted before the spawn, the act callback
 * fires while the child sits inside the checkpoint, and removing the
 * hold releases it.
 */
async function runScript(script, args, steps = [], env = {}) {
  runN += 1;
  const cpDir = join(root, "cps", `run-${runN}`);
  mkdirSync(cpDir, { recursive: true });
  for (const s of steps) {
    writeFileSync(join(cpDir, `cp-${s.name}.hold`), "");
  }
  const child = spawn("node", [script, ...args], {
    env: { ...process.env, AGY_FAKE_CHECKPOINT_DIR: cpDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => child.on("exit", r));
  for (const s of steps) {
    const marker = join(cpDir, `cp-${s.name}`);
    const winner = await Promise.race([
      waitFor(() => existsSync(marker), 15_000, `${s.name} checkpoint`).then(() => "cp"),
      exited.then(() => "exit"),
    ]);
    if (winner === "exit" && !existsSync(marker)) {
      say(`!!! child exited before checkpoint ${s.name}: ${err.trim()}`);
      process.exit(2);
    }
    s.act?.();
    rmSync(join(cpDir, `cp-${s.name}.hold`), { force: true });
  }
  const code = await exited;
  return { code, out, err };
}

/** A script run expected to refuse: non-zero exit, nothing written. */
async function expectRefusal(script, args, name, dir = dataDir, env = {}) {
  const before = stateBytes(dir);
  const r = await runScript(script, args, [], env);
  check(r.code !== 0, `${name}: exits non-zero`);
  check(stateBytes(dir) === before, `${name}: accounts-state.json untouched`);
  return r;
}

const stagingOf = (dir, label, kind) => join(dir, `.${kind}-${label}`);
const tokenOf = (home) =>
  join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
// §11 п.10(а): at every checkpoint of the happy path the label must be
// either still staged (invisible) or already bound — never visible and
// unbound at once.
const invariantHold = (dir, label, kind) => () => {
  const visible = existsSync(accountDirOf(dir, label));
  const bound = installOf(dir, label) !== undefined;
  check(!visible || bound, `checkpoint: ${label} never visible without its binding`);
};

// -- §11 п.10: --install secondary — happy path, every checkpoint ------
const a1steps = ["staged", "bound", "pre-rename", "post-rename", "done"].map(
  (name) => ({ name, act: invariantHold(dataDir, "a1", "add-account") }),
);
a1steps[0].act = () => {
  check(
    existsSync(tokenOf(stagingOf(dataDir, "a1", "add-account"))),
    "staged: login token written under staging, not accounts/",
  );
  check(!existsSync(accountDirOf(dataDir, "a1")), "staged: account still invisible to the pool");
};
a1steps[3].act = () => {
  check(existsSync(tokenOf(accountDirOf(dataDir, "a1"))), "post-rename: account visible in accounts/");
  check(installOf(dataDir, "a1") === "secondary", "post-rename: binding already on disk");
};
let r = await runScript(
  addAccount,
  ["--label", "a1", "--install", "secondary", "--data-dir", dataDir],
  a1steps,
);
check(r.code === 0, "add --install secondary exits 0");
check(lastMark().__bin === "secondary", "login ran the secondary install binary");
check(lastMark().home === ".add-account-a1", "login ran with HOME=staging");
check(installOf(dataDir, "a1") === "secondary", "a1 bound to secondary on disk");

// -- §11 п.10: no flag → default binary, no field -----------------------
r = await runScript(
  addAccount,
  ["--label", "a2", "--data-dir", dataDir],
  [
    {
      name: "post-rename",
      act: () =>
        check(
          existsSync(accountDirOf(dataDir, "a2")) &&
            installOf(dataDir, "a2") === undefined,
          "no flag: account visible with no install field anywhere",
        ),
    },
    { name: "done" },
  ],
);
check(r.code === 0, "add without --install exits 0");
check(lastMark().__bin === "main", "no flag: login ran the registry default binary");

// --install default and --install <default name> both mean "main" — the
// field is never written.
for (const [label, name] of [
  ["a3", "default"],
  ["a4", "main"],
]) {
  r = await runScript(addAccount, [
    "--label", label, "--install", name, "--data-dir", dataDir,
  ]);
  check(r.code === 0, `--install ${name} exits 0`);
  check(
    installOf(dataDir, label) === undefined && lastMark().__bin === "main",
    `--install ${name}: no field written, default binary used`,
  );
}

// -- §11 п.10: refusals write nothing ----------------------------------
await expectRefusal(
  addAccount,
  ["--label", "b1", "--install", "nope", "--data-dir", dataDir],
  "--install unknown name",
);
check(
  !existsSync(accountDirOf(dataDir, "b1")) &&
    !existsSync(stagingOf(dataDir, "b1", "add-account")),
  "unknown install: no directory left behind",
);
await expectRefusal(
  addAccount,
  ["--label", "b2", "--install", "Bad_Name", "--data-dir", dataDir],
  "--install pattern-failing name",
);
await expectRefusal(
  addAccount,
  ["--label", "a1", "--install", "secondary", "--data-dir", dataDir],
  "label already taken",
);
{
  writeFileSync(registryPath, "{ broken json\n");
  const rr = await runScript(addAccount, [
    "--label", "b3", "--install", "secondary", "--data-dir", dataDir,
  ]);
  check(rr.code !== 0, "broken registry → refusal");
  writeFileSync(
    registryPath,
    `${JSON.stringify(
      {
        installs: {
          main: { bin: binMain },
          secondary: { bin: binSecondary },
        },
        default: "main",
      },
      null,
      2,
    )}\n`,
  );
}

// Satellite: the marker refuses before anything else.
{
  const before = stateBytes(satDir);
  const rr = await runScript(addAccount, [
    "--label", "sat-b", "--install", "secondary", "--data-dir", satDir,
  ]);
  check(rr.code !== 0, "satellite: add-account refuses");
  check(stateBytes(satDir) === before, "satellite: shared file byte-identical");
  check(
    !existsSync(accountDirOf(satDir, "sat-b")) &&
      !existsSync(stagingOf(satDir, "sat-b", "add-account")),
    "satellite: nothing staged either",
  );
}

// No registry at all: --install refuses, no flag resolves the legacy
// way — AGY_PATH first, exactly like resolveAgyCommand(process.env).
await expectRefusal(
  addAccount,
  ["--label", "n1", "--install", "secondary", "--data-dir", noregDir],
  "--install with no registry",
  noregDir,
);
r = await runScript(
  addAccount,
  ["--label", "n2", "--data-dir", noregDir],
  [],
  { AGY_PATH: binLegacy },
);
check(r.code === 0, "no registry, no flag: add exits 0");
check(
  lastMark().__bin === "legacy",
  "no registry: login ran the AGY_PATH binary (resolveAgyCommand order)",
);
check(
  readState(noregDir).accounts.n2 === undefined,
  "no registry: nothing written to the shared file",
);

// -- §11 п.10в: wipe at post-rename — one rewrite recovers -------------
// The hold lands the foreign overwrite between the script's binding
// write and its post-rename re-read; the label then sits visible but
// unbound until rewrite-1 lands — the only window the spec allows.
r = await runScript(
  addAccount,
  ["--label", "a5", "--install", "secondary", "--data-dir", dataDir],
  [
    {
      name: "post-rename",
      act: () => wipeLabel(dataDir, "a5"),
    },
    {
      // Reaching this checkpoint proves the wipe was seen: the binding
      // write has just landed again, the re-read is still ahead.
      name: "rewrite-1",
      act: () =>
        check(
          existsSync(accountDirOf(dataDir, "a5")) &&
            installOf(dataDir, "a5") === "secondary",
          "wipe window: rewrite-1 re-landed the binding before its re-read",
        ),
    },
    { name: "done" },
  ],
);
check(r.code === 0, "wipe once: retry recovered, exit 0");
check(installOf(dataDir, "a5") === "secondary", "wipe once: binding restored on disk");

// -- §11 п.10: exhausted rewrites roll the account back ----------------
r = await runScript(
  addAccount,
  ["--label", "a6", "--install", "secondary", "--data-dir", dataDir],
  [
    { name: "post-rename", act: () => wipeLabel(dataDir, "a6") },
    { name: "rewrite-1", act: () => wipeLabel(dataDir, "a6") },
    { name: "rewrite-2", act: () => wipeLabel(dataDir, "a6") },
    { name: "rewrite-3", act: () => wipeLabel(dataDir, "a6") },
    {
      name: "rolled-back",
      act: () => {
        check(
          !existsSync(accountDirOf(dataDir, "a6")),
          "exhausted: account directory rolled back",
        );
        check(
          readState(dataDir).accounts.a6 === undefined,
          "exhausted: shared-file entry removed too",
        );
      },
    },
  ],
);
check(r.code !== 0, "exhausted rewrites: command fails");
check(
  !existsSync(accountDirOf(dataDir, "a6")),
  "exhausted: no visible-without-binding account left behind",
);

// -- §11 п.11: import --install — staged, bound, renamed ---------------
const tokenFile = join(root, "grant-i1.json");
writeFileSync(tokenFile, '{"refresh_token":"rt-i1"}\n');
r = await runScript(
  importAccounts,
  ["--file", tokenFile, "--label", "i1", "--install", "secondary", "--data-dir", dataDir],
  [
    {
      name: "staged",
      act: () => {
        check(
          existsSync(tokenOf(stagingOf(dataDir, "i1", "import"))),
          "import staged: token files land outside accounts/",
        );
        check(!existsSync(accountDirOf(dataDir, "i1")), "import staged: invisible to the pool");
      },
    },
    {
      name: "post-rename",
      act: () =>
        check(
          existsSync(accountDirOf(dataDir, "i1")) &&
            installOf(dataDir, "i1") === "secondary",
          "import: visible only with the binding on disk",
        ),
    },
    { name: "done" },
  ],
);
check(r.code === 0, "import --install secondary exits 0");
check(installOf(dataDir, "i1") === "secondary", "import wrote install=secondary");

r = await runScript(importAccounts, [
  "--file", tokenFile, "--label", "i2", "--data-dir", dataDir,
]);
check(r.code === 0 && installOf(dataDir, "i2") === undefined, "import without --install: no field");

// Refusals: unknown name, missing registry, satellite (--install AND
// --rebind) — the shared file stays byte-identical.
await expectRefusal(
  importAccounts,
  ["--file", tokenFile, "--label", "i3", "--install", "nope", "--data-dir", dataDir],
  "import --install unknown name",
);
check(!existsSync(accountDirOf(dataDir, "i3")), "import refusal: no directory created");
await expectRefusal(
  importAccounts,
  ["--file", tokenFile, "--label", "i4", "--install", "secondary", "--data-dir", noregDir],
  "import --install with no registry",
  noregDir,
);
{
  const before = stateBytes(satDir);
  const r1 = await runScript(importAccounts, [
    "--file", tokenFile, "--label", "sat-i", "--install", "secondary", "--data-dir", satDir,
  ]);
  check(r1.code !== 0, "satellite: import --install refuses");
  const r2 = await runScript(importAccounts, [
    "--rebind", "--label", "sat-a", "--install", "main", "--data-dir", satDir,
  ]);
  check(r2.code !== 0, "satellite: --rebind refuses");
  check(stateBytes(satDir) === before, "satellite: shared file byte-identical after both refusals");
}

// Wipe once → first rewrite recovers; exhausted → the staged import
// rolls back out of accounts/.
r = await runScript(
  importAccounts,
  ["--file", tokenFile, "--label", "i5", "--install", "secondary", "--data-dir", dataDir],
  [
    { name: "post-rename", act: () => wipeLabel(dataDir, "i5") },
    { name: "rewrite-1" },
    { name: "done" },
  ],
);
check(r.code === 0 && installOf(dataDir, "i5") === "secondary", "import wipe once: rewrite recovered");

r = await runScript(
  importAccounts,
  ["--file", tokenFile, "--label", "i6", "--install", "secondary", "--data-dir", dataDir],
  [
    { name: "post-rename", act: () => wipeLabel(dataDir, "i6") },
    { name: "rewrite-1", act: () => wipeLabel(dataDir, "i6") },
    { name: "rewrite-2", act: () => wipeLabel(dataDir, "i6") },
    { name: "rewrite-3", act: () => wipeLabel(dataDir, "i6") },
    { name: "rolled-back" },
  ],
);
check(r.code === 0, "import exhausted: script reports the failure and continues");
check(
  !existsSync(accountDirOf(dataDir, "i6")) &&
    readState(dataDir).accounts.i6 === undefined,
  "import exhausted: rolled back out of accounts/ and the shared file",
);
check(r.out.includes("FAIL i6"), "import exhausted: the label failed loudly");

// A bound import into a home the operator started early (a `proxy` file,
// no token yet): the token merges in atomically — never visible before
// the binding, and the files already placed are kept, exactly like the
// unbound import path treats an existing home.
mkdirSync(accountDirOf(dataDir, "i8"), { recursive: true });
writeFileSync(join(accountDirOf(dataDir, "i8"), "proxy"), "socks5://h:1\n");
r = await runScript(
  importAccounts,
  ["--file", tokenFile, "--label", "i8", "--install", "secondary", "--data-dir", dataDir],
  [
    {
      name: "pre-rename",
      act: () =>
        check(
          !existsSync(tokenOf(accountDirOf(dataDir, "i8"))) &&
            existsSync(join(accountDirOf(dataDir, "i8"), "proxy")),
          "existing home: still invisible at pre-rename, files intact",
        ),
    },
    {
      name: "post-rename",
      act: () =>
        check(
          existsSync(tokenOf(accountDirOf(dataDir, "i8"))) &&
            installOf(dataDir, "i8") === "secondary",
          "existing home: visible only with the binding on disk",
        ),
    },
    { name: "done" },
  ],
);
check(r.code === 0 && installOf(dataDir, "i8") === "secondary", "import into existing home: bound");
check(
  readFileSync(join(accountDirOf(dataDir, "i8"), "proxy"), "utf8") === "socks5://h:1\n",
  "import into existing home: pre-placed proxy file kept",
);

// Rollback out of a pre-existing home removes only the token the import
// merged — the operator's own files survive the rollback too.
mkdirSync(accountDirOf(dataDir, "i9"), { recursive: true });
writeFileSync(join(accountDirOf(dataDir, "i9"), "proxy"), "socks5://h:9\n");
r = await runScript(
  importAccounts,
  ["--file", tokenFile, "--label", "i9", "--install", "secondary", "--data-dir", dataDir],
  [
    { name: "post-rename", act: () => wipeLabel(dataDir, "i9") },
    { name: "rewrite-1", act: () => wipeLabel(dataDir, "i9") },
    { name: "rewrite-2", act: () => wipeLabel(dataDir, "i9") },
    { name: "rewrite-3", act: () => wipeLabel(dataDir, "i9") },
    { name: "rolled-back" },
  ],
);
check(r.code === 0, "existing-home exhausted: script reports the failure and continues");
check(
  !existsSync(tokenOf(accountDirOf(dataDir, "i9"))),
  "existing-home rollback: merged token removed — invisible to the pool",
);
check(
  readFileSync(join(accountDirOf(dataDir, "i9"), "proxy"), "utf8") === "socks5://h:9\n",
  "existing-home rollback: pre-placed proxy file kept",
);
check(
  readState(dataDir).accounts.i9 === undefined,
  "existing-home rollback: shared-file entry removed",
);
check(
  !existsSync(stagingOf(dataDir, "i9", "import")),
  "existing-home rollback: staging cleaned",
);

// -- §11 п.11: --rebind — atomic rewrite, "default" removes the field ---
r = await runScript(importAccounts, [
  "--rebind", "--label", "i1", "--install", "main", "--data-dir", dataDir,
]);
check(r.code === 0, "rebind to default exits 0");
check(
  installOf(dataDir, "i1") === undefined &&
    Object.hasOwn(readState(dataDir).accounts, "i1"),
  "rebind to default removed the install field, kept the entry",
);
r = await runScript(importAccounts, [
  "--rebind", "--label", "i1", "--install", "secondary", "--data-dir", dataDir,
]);
check(r.code === 0 && installOf(dataDir, "i1") === "secondary", "rebind back to secondary");
await expectRefusal(
  importAccounts,
  ["--rebind", "--label", "i1", "--install", "nope", "--data-dir", dataDir],
  "rebind to unknown install",
);
await expectRefusal(
  importAccounts,
  ["--rebind", "--label", "no-such", "--install", "secondary", "--data-dir", dataDir],
  "rebind of a non-account label",
);
// A label that exists only as a home directory still binds.
mkdirSync(join(accountDirOf(dataDir, "i7"), ".gemini", "antigravity-cli"), { recursive: true });
writeFileSync(tokenOf(accountDirOf(dataDir, "i7")), '{"auth_method":"consumer"}\n');
r = await runScript(importAccounts, [
  "--rebind", "--label", "i7", "--install", "secondary", "--data-dir", dataDir,
]);
check(
  r.code === 0 && installOf(dataDir, "i7") === "secondary",
  "rebind creates the shared-file entry for a dir-only account",
);

process.stdout.write("");
for (const line of results) say(line);
if (failures > 0) {
  say(`\n${failures} FAILURES`);
  process.exit(1);
}
say("\nharness-installs-commands: all green");
process.exit(0);
