/**
 * The key-reader scripts referenced from models.json.
 *
 * Each one prints a single token on stdout and nothing else. They read the
 * credential store the corresponding CLI already maintains, so the token is
 * never copied: rotate it in opencode or kilo and the next pi session picks
 * the new value up on its own.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ZEN_READER = `// Prints the OpenCode Zen API token. Written by bb-plugin-pi-gateways.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const store = join(homedir(), ".local", "share", "opencode", "auth.json");
let token;
try {
  token = JSON.parse(readFileSync(store, "utf8"))?.opencode?.key;
} catch {
  process.exit(1);
}
if (typeof token !== "string" || token.length === 0) process.exit(1);
process.stdout.write(token);
`;

const KILO_READER = `// Prints the current Kilo Code OAuth access token. Written by bb-plugin-pi-gateways.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const db = join(homedir(), ".local", "share", "kilo", "kilo.db");
const QUERY = "select value from credential where integration_id = 'kilo' limit 1";

async function viaNodeSqlite() {
  // Node's own driver, when this runtime has it. Read-only: never take a write
  // lock on a database the kilo CLI may be using.
  const { DatabaseSync } = await import("node:sqlite");
  const handle = new DatabaseSync(db, { readOnly: true });
  try {
    return handle.prepare(QUERY).get()?.value;
  } finally {
    handle.close();
  }
}

function viaSqliteCli() {
  return execFileSync("sqlite3", [\`file:\${db}?mode=ro\`, QUERY], { encoding: "utf8" }).trim();
}

let raw;
try {
  raw = await viaNodeSqlite();
} catch {
  try {
    raw = viaSqliteCli();
  } catch {
    process.exit(1);
  }
}

let token;
try {
  token = raw ? JSON.parse(raw).access : undefined;
} catch {
  process.exit(1);
}
if (typeof token !== "string" || token.length === 0) process.exit(1);
process.stdout.write(token);
`;

const SOURCES: Record<string, string> = {
  "read-zen.mjs": ZEN_READER,
  "read-kilo.mjs": KILO_READER,
};

/**
 * Write the readers into the plugin's persistent host directory and return
 * absolute paths. Rewritten on every refresh so a plugin update ships fixes.
 */
export function installReaders(dataDir: string): Record<string, string> {
  const dir = join(dataDir, "readers");
  mkdirSync(dir, { recursive: true });
  const paths: Record<string, string> = {};
  for (const [name, source] of Object.entries(SOURCES)) {
    const path = join(dir, name);
    writeFileSync(path, source, { mode: 0o700 });
    chmodSync(path, 0o700);
    paths[name] = path;
  }
  return paths;
}
