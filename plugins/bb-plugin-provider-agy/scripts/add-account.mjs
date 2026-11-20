#!/usr/bin/env node
/**
 * Adds an account to the provider pool through the native sign-in flow
 * (spec provider-agy-installs §4.1–4.2). One command for both installs —
 * the `--install` flag is the only difference:
 *
 *   node scripts/add-account.mjs --label <метка>
 *   node scripts/add-account.mjs --label <метка> --install <имя>
 *
 * Run it on the pool OWNER instance, in an interactive terminal: the
 * script stages the home outside accounts/ (so the pool cannot see a
 * half-bound account), runs `agy` with HOME=<staging> for the native
 * Google sign-in, writes the `install` binding atomically, and only then
 * renames the home into accounts/. The binding is re-verified from disk
 * after the rename and rewritten up to 3 times when a concurrent save
 * wipes it; exhausting the retries rolls the account directory back.
 *
 * Usage: node scripts/add-account.mjs --label <label> [--install <name>]
 *        [--bin <path>] [--data-dir <dir>]
 */
import { accessSync, constants, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  accountsStatePath,
  checkpoint,
  defaultInstallBin,
  isSatellite,
  readAccountsState,
  readInstallsRegistry,
  resolveInstallArg,
  writeJsonAtomic,
} from "./install-lib.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dataDir =
  value("--data-dir") ??
  join(homedir(), ".bb", "plugins", "provider-agy", "bridge-data");
const label = value("--label");
const installArg = value("--install");
const binOverride = value("--bin");

const fail = (message) => {
  console.error(`add-account: ${message}`);
  process.exit(1);
};

if (
  typeof label !== "string" ||
  !/^[A-Za-z0-9._@+-]+$/u.test(label) ||
  label === "." ||
  label === ".."
) {
  fail("--label is required and must match ^[A-Za-z0-9._@+-]+$");
}

// §4.1: shared-file writes are owner-only — a satellite's accounts-state
// edits are wiped by the keeper sync within ~30 s.
if (isSatellite(dataDir)) {
  fail(
    `this host is a pool satellite (${join(dataDir, "pool-satellite")} exists); ` +
      `run add-account on the pool owner — a local binding would be wiped by the keeper sync`,
  );
}

const registry = readInstallsRegistry(dataDir);
if (registry.state === "broken") {
  fail(`installs registry is invalid: ${registry.reason}`);
}

// Step 1 (§4.1): label must be free, and --install must name a registry
// entry — before anything is written.
const accountDir = join(dataDir, "accounts", label);
const statePath = accountsStatePath(dataDir);
const stateBefore = readAccountsState(dataDir);
if (existsSync(accountDir) || Object.hasOwn(stateBefore.accounts, label)) {
  fail(`label ${label} is already taken (accounts/${label} or an accounts-state.json entry exists)`);
}
const binding = resolveInstallArg(registry, installArg);
if (!binding.ok) {
  fail(binding.reason);
}

// Step 3: the login binary — the bound install's bin, else the registry
// default's, else (no registry) today's resolution: the same order
// resolveAgyCommand(process.env) applies — AGY_PATH, ~/.local/bin/agy,
// then `agy` on PATH.
const isExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const resolveLegacyBin = () => {
  const pinned = process.env.AGY_PATH;
  if (pinned !== undefined && pinned.length > 0) {
    if (!isExecutable(pinned)) {
      fail(`AGY_PATH=${pinned} is not executable`);
    }
    return pinned;
  }
  const home = process.env.HOME;
  if (home !== undefined && home.length > 0) {
    const local = join(home, ".local", "bin", "agy");
    if (isExecutable(local)) {
      return local;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length > 0 && isExecutable(join(dir, "agy"))) {
      return join(dir, "agy");
    }
  }
  return "agy";
};
const loginBin =
  binOverride ??
  (binding.ok && binding.field !== null
    ? binding.bin
    : (defaultInstallBin(registry)?.bin ?? resolveLegacyBin()));
const installEnv =
  binding.field !== null
    ? (binding.env ?? {})
    : (defaultInstallBin(registry)?.env ?? {});

// Step 2: the staging home lives outside accounts/ — listAccounts only
// sees token files under accounts/, so the account stays invisible to the
// pool until the final rename.
const stagingDir = join(dataDir, `.add-account-${label}`);
if (existsSync(stagingDir)) {
  rmSync(stagingDir, { recursive: true, force: true });
}

const cleanup = () => {
  rmSync(stagingDir, { recursive: true, force: true });
};

console.log(`signing in ${label} with ${loginBin} (HOME=${stagingDir})`);
if (installArg !== undefined) {
  console.log(`bound install: ${installArg === "default" ? "(default install)" : installArg}`);
}
const login = spawnSync(loginBin, [], {
  stdio: "inherit",
  // provider-agy-acp §2.3 п.14: the sign-in must land in the account's own
  // token file, not in the machine-wide OS keyring (macOS Keychain would
  // otherwise swallow it and overwrite the owner's personal agy login).
  // agy picks the file store when it sees an SSH session.
  env: {
    ...process.env,
    ...installEnv,
    ...(process.env.AGY_KEYRING === "1"
      ? {}
      : { SSH_CONNECTION: process.env.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0" }),
    HOME: stagingDir,
  },
});
if (login.status !== 0) {
  cleanup();
  fail(`agy sign-in did not finish (exit ${login.status ?? "signal"}); staging removed, nothing written`);
}

const tokenPath = join(
  stagingDir,
  ".gemini",
  "antigravity-cli",
  "antigravity-oauth-token",
);
if (!existsSync(tokenPath)) {
  cleanup();
  fail(`no credential at ${tokenPath} after sign-in; staging removed, nothing written`);
}
checkpoint("staged");

// Steps 4–5: while the home is still staged, write the binding; after the
// rename re-read the shared file and rewrite up to 3 times when a
// concurrent saveLedger snapshot wiped the fresh label.
const writeBinding = () => {
  const state = readAccountsState(dataDir);
  if (!Object.hasOwn(state.accounts, label)) {
    state.accounts[label] = {};
  }
  state.accounts[label].install = binding.field;
  writeJsonAtomic(statePath, state);
};
const bindingOnDisk = () =>
  readAccountsState(dataDir).accounts[label]?.install === binding.field;

if (binding.field !== null) {
  try {
    writeBinding();
  } catch (error) {
    cleanup();
    fail(`could not write the install binding: ${error.message}; staging removed, nothing written`);
  }
  checkpoint("bound");
  if (!bindingOnDisk()) {
    cleanup();
    fail(`install binding did not survive the write to accounts-state.json; staging removed`);
  }
}
checkpoint("pre-rename");

try {
  renameSync(stagingDir, accountDir);
} catch (error) {
  cleanup();
  fail(`could not move staging into accounts/: ${error.message}`);
}
checkpoint("post-rename");

if (binding.field !== null) {
  let bound = bindingOnDisk();
  let lost;
  try {
    for (let attempt = 0; !bound && attempt < 3; attempt += 1) {
      writeBinding();
      checkpoint(`rewrite-${attempt + 1}`);
      bound = bindingOnDisk();
    }
  } catch (error) {
    // §11 п.10в: the exit states are exactly "bound and verified" or
    // "rolled back" — an io error mid-verification may not leave a
    // visible account without its binding either.
    lost = error;
  }
  if (!bound) {
    // Rollback (§4.1 step 5): an account left in accounts/ without its
    // binding would run on the default install's binary — exactly the
    // cross-install launch the contract forbids.
    rmSync(accountDir, { recursive: true, force: true });
    const state = readAccountsState(dataDir);
    delete state.accounts[label];
    try {
      writeJsonAtomic(statePath, state);
    } catch {}
    checkpoint("rolled-back");
    fail(
      lost !== undefined
        ? `install binding could not be verified (${lost.message}); ` +
            `the account directory was rolled back — retry add-account from scratch`
        : `install binding was lost to concurrent accounts-state.json writes 3 times; ` +
            `the account directory was rolled back — retry add-account from scratch`,
    );
  }
}

checkpoint("done");
console.log(
  `OK   ${label} -> accounts/${label}` +
    (binding.field !== null ? ` (install=${binding.field})` : ""),
);
console.log(
  "give the account its own egress IP:  echo 'socks5://user:pass@host:port' > accounts/<label>/proxy",
);
