// Add an account to the argon rotation pool (agy-parity: pool = dir of accounts).
// usage: node scripts/pool-add.mjs <label> <cdp-port> [priority] [email] [tier]
//   <label>   = pool id AND chrome profile id (~/.config/google-chrome-<label>)
//   <tier>    = "pro" (default) or "ultra"
// Steps it does: write $ARGON_STATE_DIR/accounts/<label>/backend.json and pool.json,
// spawn the account's chrome under xvfb on <cdp-port>. Then run scripts/glogin.mjs
// <email> <secrets.env> with GEMINI_CDP_PORT=<port> to sign in.
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const driver = require(new URL("../src/gemini-driver.js", import.meta.url).pathname);

const [label, port, prio, email, tier] = process.argv.slice(2);
if (!label || !port) {
  console.error("usage: node scripts/pool-add.mjs <label> <cdp-port> [priority] [email] [tier]");
  process.exit(2);
}
const STATE_DIR = process.env.ARGON_STATE_DIR || join(homedir(), ".bb", "plugins", "provider-argon");
const dir = join(STATE_DIR, "accounts", label);
fs.mkdirSync(dir, { recursive: true });
const backend = { profile: label, cdp: String(port) };
if (prio !== undefined) backend.priority = parseInt(prio, 10);
if (email) backend.email = email;
if (tier) backend.tier = tier.toLowerCase() === "ultra" ? "ultra" : "pro";
fs.writeFileSync(join(dir, "backend.json"), JSON.stringify(backend, null, 2) + "\n");
console.log(`pool entry: ${dir}/backend.json ->`, JSON.stringify(backend));

// Also update pool.json for §3.1 compliance
const POOL_FILE = process.env.ARGON_POOL_FILE || join(STATE_DIR, "pool.json");
try {
  let pool = { accounts: [] };
  if (fs.existsSync(POOL_FILE)) {
    try {
      pool = JSON.parse(fs.readFileSync(POOL_FILE, "utf8"));
      if (!Array.isArray(pool.accounts)) pool.accounts = [];
    } catch {}
  }
  const idx = pool.accounts.findIndex((a) => a.id === label);
  const accountEntry = {
    id: label,
    email: email || `${label}@example.com`,
    profileDir: `~/.config/google-chrome-${label}`,
    cdpPort: Number(port),
    priority: backend.priority ?? 10,
    tier: tier && tier.toLowerCase() === "ultra" ? "ultra" : "pro",
  };
  if (idx >= 0) {
    pool.accounts[idx] = accountEntry;
  } else {
    pool.accounts.push(accountEntry);
  }
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2) + "\n");
  console.log(`updated ${POOL_FILE}`);
} catch (e) {
  console.warn(`warning: could not update pool.json: ${e.message}`);
}

// Spawn chrome so glogin can connect over CDP right away.
const chromeCandidates = [
  process.env.GEMINI_CHROME_BIN,
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);
process.env.GEMINI_CHROME_BIN = chromeCandidates.find((c) => fs.existsSync(c)) || "google-chrome";
driver.setCdpPort(String(port));
await driver.ensureChrome({ headless: "xvfb", profile: label });
console.log(`chrome up on :${port} (profile ${label}). Next:`);
console.log(`  GEMINI_CDP_PORT=${port} GEMINI_PROFILE=${label} node scripts/glogin.mjs <email> <secrets.env>`);
