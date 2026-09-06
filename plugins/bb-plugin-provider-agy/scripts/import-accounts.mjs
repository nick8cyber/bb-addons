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
 * Labels default to the account email (cliproxy/opencode) or the file stem.
 * An existing account home is left untouched unless --overwrite is given.
 * After importing, drop a `proxy` file into accounts/<label>/ (one proxy
 * URL) to give that account its own egress IP.
 *
 * Usage: node scripts/import-accounts.mjs [--opencode | --cliproxy [dir] |
 *         --file <path> --label <label>] [--overwrite] [--data-dir <dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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

function refreshTokenOf(record) {
  if (typeof record === "string") {
    const parsed = JSON.parse(record);
    return parsed?.token?.refresh_token ?? parsed?.refresh_token ?? null;
  }
  return record?.token?.refresh_token ?? record?.refresh_token ?? null;
}

/** The agy credential shape; the access token is left stale on purpose —
 * agy refreshes it from the refresh token on first use. */
function writeAccountHome(label, refreshToken) {
  if (!/^[A-Za-z0-9._@+-]+$/u.test(label)) {
    throw new Error(`unsafe account label: ${label}`);
  }
  const cliDir = join(dataDir, "accounts", label, ".gemini", "antigravity-cli");
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
    jobs.push([record.email ?? basename(f, ".json"), record.refresh_token]);
  }
} else if (flag("--file")) {
  const path = value("--file");
  const label = value("--label") ?? basename(path).replace(/\.[a-z]+$/iu, "");
  const raw = readFileSync(path, "utf8");
  jobs.push([label, refreshTokenOf(raw) ?? refreshTokenOf(JSON.parse(raw))]);
} else {
  console.log(
    "nothing to do: pass --opencode, --cliproxy [dir], or --file <path> --label <label>",
  );
  process.exit(1);
}

let done = 0;
for (const [label, refreshToken] of jobs) {
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
      continue;
    }
    writeAccountHome(label, refreshToken);
    console.log(`OK   ${label} -> accounts/${label}`);
    done += 1;
  } catch (e) {
    console.log(`FAIL ${label}: ${e.message}`);
  }
}
console.log(`\n${done} imported into ${join(dataDir, "accounts")}`);
console.log(
  "give an account its own egress IP:  echo 'socks5://user:pass@host:port' > accounts/<label>/proxy",
);
