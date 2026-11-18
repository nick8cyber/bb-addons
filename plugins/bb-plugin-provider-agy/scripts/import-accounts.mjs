#!/usr/bin/env node
/**
 * Imports Google (Antigravity) refresh grants into the provider's account
 * pool — one agy HOME per account, ready for the bridge to pick up.
 *
 * Sources:
 *   --opencode                       every account from the opencode
 *                                    antigravity plugin's accounts file
 *   --cliproxy [dir]                 every antigravity-*.json from a
 *                                    CLIProxyAPI auth dir (default: the
 *                                    agent-proxy plugin's auth dir)
 *   --file <path> --label <label>    one token file (agy format, or any
 *                                    JSON with a refresh_token field)
 *
 * Install binding (provider-agy-installs §4.3):
 *   --install <name>                 bind every imported account to the
 *                                    registry install <name> ("default"
 *                                    or the registry's default name leave
 *                                    no field — the main install)
 *   --rebind --label <l> --install <n>
 *                                    re-point an existing account at the
 *                                    install <n>; affects future launches
 *                                    only, never running sessions
 *
 * Labels default to the account email (cliproxy/opencode) or the file stem.
 * An existing account home is left untouched unless --overwrite is given.
 * After importing, drop a `proxy` file into accounts/<label>/ (one proxy
 * URL) to give that account its own egress IP.
 *
 * Usage: node scripts/import-accounts.mjs [--opencode | --cliproxy [dir] |
 *         --file <path> --label <label>] [--install <name>] [--overwrite]
 *         [--data-dir <dir>]
 *        node scripts/import-accounts.mjs --rebind --label <l> --install <n>
 *         [--data-dir <dir>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  accountsStatePath,
  isSatellite,
  readAccountsState,
  readInstallsRegistry,
  resolveInstallArg,
  writeJsonAtomic,
} from "./install-lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dataDir =
  value("--data-dir") ??
  join(homedir(), ".bb", "plugins", "provider-agy", "bridge-data");
const overwrite = flag("--overwrite");
const installArg = value("--install");
const rebind = flag("--rebind");

const fail = (message) => {
  console.error(`import-accounts: ${message}`);
  process.exit(1);
};

// §4.3: imports and rebinds touch the shared accounts-state.json — that is
// owner-only; on a satellite the keeper sync would wipe the binding.
if (isSatellite(dataDir)) {
  fail(
    `this host is a pool satellite (${join(dataDir, "pool-satellite")} exists); ` +
      `run the import on the pool owner — a local binding would be wiped by the keeper sync`,
  );
}

const registry = readInstallsRegistry(dataDir);
if (registry.state === "broken") {
  fail(`installs registry is invalid: ${registry.reason}`);
}
const binding = resolveInstallArg(registry, installArg);
if (!binding.ok) {
  fail(binding.reason);
}

const statePath = accountsStatePath(dataDir);
const writeBinding = (label, field) => {
  const state = readAccountsState(dataDir);
  if (!Object.hasOwn(state.accounts, label)) {
    state.accounts[label] = {};
  }
  if (field === null) {
    delete state.accounts[label].install;
  } else {
    state.accounts[label].install = field;
  }
  writeJsonAtomic(statePath, state);
};

// §4.3 rebind: atomic temp+rename rewrite of the shared file; "default"
// removes the property. New launches only — running sessions keep the
// binary they started on.
if (rebind) {
  const label = value("--label");
  if (typeof label !== "string" || label.length === 0) {
    fail("--rebind requires --label <label>");
  }
  if (installArg === undefined) {
    fail("--rebind requires --install <name>");
  }
  const state = readAccountsState(dataDir);
  if (
    !Object.hasOwn(state.accounts, label) &&
    !existsSync(join(dataDir, "accounts", label))
  ) {
    fail(`label ${label} is not a pool account`);
  }
  writeBinding(label, binding.field);
  const onDisk = readAccountsState(dataDir).accounts[label]?.install;
  const recorded = onDisk ?? "default";
  if ((onDisk ?? null) !== binding.field) {
    fail(`rebind did not survive the write to accounts-state.json (read back ${JSON.stringify(onDisk)})`);
  }
  console.log(`OK   ${label} -> install ${installArg} (recorded: ${recorded})`);
  console.log("running sessions keep their current binary; the next launch uses the new install");
  process.exit(0);
}

function refreshTokenOf(record) {
  if (typeof record === "string") {
    const parsed = JSON.parse(record);
    return parsed?.token?.refresh_token ?? parsed?.refresh_token ?? null;
  }
  return record?.token?.refresh_token ?? record?.refresh_token ?? null;
}

/** The agy credential shape; the access token is left stale on purpose —
 * agy refreshes it from the refresh token on first use. `home` is the
 * staging dir when a binding must land before the account is visible. */
function writeAccountHome(label, refreshToken, home = null) {
  if (
    !/^[A-Za-z0-9._@+-]+$/u.test(label) ||
    label === "." ||
    label === ".."
  ) {
    throw new Error(`unsafe account label: ${label}`);
  }
  const cliDir = join(home ?? join(dataDir, "accounts", label), ".gemini", "antigravity-cli");
  mkdirSync(cliDir, { recursive: true });
  const token = {
    auth_method: "consumer",
    token: {
      access_token: "",
      token_type: "Bearer",
      refresh_token: refreshToken,
      expiry: "2000-01-01T00:00:00Z",
    },
  };
  writeFileSync(join(cliDir, "antigravity-oauth-token"), `${JSON.stringify(token)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

const jobs = [];
if (flag("--opencode")) {
  const path = join(homedir(), ".config", "opencode", "antigravity-accounts.json");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  for (const a of parsed.accounts ?? []) {
    jobs.push([a.email, a.refreshToken]);
  }
} else if (flag("--cliproxy")) {
  const dir =
    value("--cliproxy") ??
    join(homedir(), ".bb", "plugins", "agent-proxy", "core", "auth");
  for (const f of readdirSync(dir).filter(
    (f) => f.startsWith("antigravity-") && f.endsWith(".json"),
  )) {
    const record = JSON.parse(readFileSync(join(dir, f), "utf8"));
    jobs.push([record.email ?? basename(f, ".json"), record.refresh_token, record.proxy_url]);
  }
} else if (flag("--file")) {
  const path = value("--file");
  if (!path) {
    console.log("--file requires a path");
    process.exit(1);
  }
  const label = value("--label") ?? basename(path).replace(/\.[a-z]+$/iu, "");
  const raw = readFileSync(path, "utf8");
  jobs.push([label, refreshTokenOf(raw), undefined]);
} else {
  console.log(
    "nothing to do: pass --opencode, --cliproxy [dir], or --file <path> --label <label>",
  );
  process.exit(1);
}

/**
 * §4.3 staged import for a bound account: token files land in a staging
 * dir outside accounts/, the binding is written atomically, the rename
 * makes the account visible, and the binding is re-verified from disk —
 * rewritten up to 3 times when a concurrent save wipes it, then rolled
 * back (a bound account left unbound would run the wrong binary).
 */
function importBoundAccount(label, refreshToken) {
  const stagingDir = join(dataDir, `.import-${label}`);
  const accountDir = join(dataDir, "accounts", label);
  rmSync(stagingDir, { recursive: true, force: true });
  try {
    writeAccountHome(label, refreshToken, stagingDir);
    writeBinding(label, binding.field);
    if (readAccountsState(dataDir).accounts[label]?.install !== binding.field) {
      rmSync(stagingDir, { recursive: true, force: true });
      return "binding write did not survive (pre-rename)";
    }
    if (existsSync(accountDir)) {
      rmSync(accountDir, { recursive: true, force: true });
    }
    renameSync(stagingDir, accountDir);
    let bound = readAccountsState(dataDir).accounts[label]?.install === binding.field;
    for (let attempt = 0; !bound && attempt < 3; attempt += 1) {
      writeBinding(label, binding.field);
      bound = readAccountsState(dataDir).accounts[label]?.install === binding.field;
    }
    if (!bound) {
      rmSync(accountDir, { recursive: true, force: true });
      const state = readAccountsState(dataDir);
      delete state.accounts[label];
      try {
        writeJsonAtomic(statePath, state);
      } catch {}
      return "binding lost to concurrent accounts-state.json writes; account rolled back";
    }
    return null;
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true });
    return e.message;
  }
}

let done = 0;
for (const [label, refreshToken, proxy] of jobs) {
  if (!refreshToken) {
    console.log(`FAIL ${label}: no refresh token in the record`);
    continue;
  }
  try {
    const tokenPath = join(
      dataDir,
      "accounts",
      label,
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token",
    );
    if (existsSync(tokenPath) && !overwrite) {
      console.log(`     ${label} -> skip (exists)`);
      if (proxy) {
        writeFileSync(join(dataDir, "accounts", label, "proxy"), `${proxy.trim()}\n`, { encoding: "utf8", mode: 0o600 });
      }
      continue;
    }
    if (binding.field !== null) {
      const error = importBoundAccount(label, refreshToken);
      if (error !== null) {
        console.log(`FAIL ${label}: ${error}`);
        continue;
      }
    } else {
      writeAccountHome(label, refreshToken);
    }
    if (proxy) {
      writeFileSync(join(dataDir, "accounts", label, "proxy"), `${proxy.trim()}\n`, { encoding: "utf8", mode: 0o600 });
    }
    console.log(`OK   ${label} -> accounts/${label}${binding.field !== null ? ` (install=${binding.field})` : ""}`);
    done += 1;
  } catch (e) {
    console.log(`FAIL ${label}: ${e.message}`);
  }
}
console.log(`\n${done} imported into ${join(dataDir, "accounts")}`);
console.log(
  "give an account its own egress IP:  echo 'socks5://user:pass@host:port' > accounts/<label>/proxy",
);
