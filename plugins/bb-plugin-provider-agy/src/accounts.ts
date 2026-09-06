/**
 * The account pool: per-account agy homes, so every Google account runs as
 * its own native Antigravity CLI install — its own token, its own
 * installation id, optionally its own egress IP — with no shared state for
 * parallel threads to race on. agy rewrites its token file on refresh, which
 * is exactly why the pool is a directory of homes and not one swapped file.
 *
 * Layout under the plugin data dir:
 *
 *   accounts/<label>/.gemini/antigravity-cli/antigravity-oauth-token   the credential
 *   accounts/<label>/proxy                                             optional: one proxy URL line
 *
 * Selection is sticky per session (a conversation belongs to the account
 * that created it) with cooldowns on quota failures; the ledger survives
 * bridge restarts in accounts-state.json.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface AccountHome {
  label: string;
  home: string;
  /** One-line proxy URL from the account's `proxy` file, or null. */
  proxy: string | null;
}

export interface AccountLedgerEntry {
  cooldownUntilMs: number;
  lastUsedMs: number;
  lastError: string | null;
}

export interface AccountsLedger {
  accounts: Record<string, AccountLedgerEntry>;
  /** Which account owns which agy conversation, so a resume lands home. */
  conversations: Record<string, string>;
}

export function accountsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.AGY_ACCOUNTS !== "0";
}

export function accountsDir(dataDir: string): string {
  return join(dataDir, "accounts");
}

/** Accounts with a live token file, label = directory name. */
export function listAccounts(dataDir: string): AccountHome[] {
  const dir = accountsDir(dataDir);
  let labels: string[];
  try {
    labels = readdirSync(dir).filter((l) =>
      existsSync(join(dir, l, ".gemini", "antigravity-cli", "antigravity-oauth-token")),
    );
  } catch {
    return [];
  }
  return labels.map((label) => {
    const home = join(dir, label);
    let proxy: string | null = null;
    try {
      const raw = readFileSync(join(home, "proxy"), "utf8").trim();
      proxy = raw.length > 0 ? raw : null;
    } catch {
      // No proxy file: the account egresses from the host, like direct mode.
    }
    return { label, home, proxy };
  });
}

export function loadLedger(dataDir: string): AccountsLedger {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dataDir, "accounts-state.json"), "utf8"),
    ) as Partial<AccountsLedger>;
    return {
      accounts: parsed.accounts ?? {},
      conversations: parsed.conversations ?? {},
    };
  } catch {
    return { accounts: {}, conversations: {} };
  }
}

export function saveLedger(dataDir: string, ledger: AccountsLedger): void {
  const tmp = join(dataDir, `accounts-state.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 1)}\n`, "utf8");
  renameSync(tmp, join(dataDir, "accounts-state.json"));
}

export function ledgerEntry(
  ledger: AccountsLedger,
  label: string,
): AccountLedgerEntry {
  return (ledger.accounts[label] ??= {
    cooldownUntilMs: 0,
    lastUsedMs: 0,
    lastError: null,
  });
}

export function markAccountUse(
  ledger: AccountsLedger,
  label: string,
): void {
  ledgerEntry(ledger, label).lastUsedMs = Date.now();
}

export function markAccountCooldown(
  ledger: AccountsLedger,
  label: string,
  untilMs: number,
  message: string,
): void {
  const entry = ledgerEntry(ledger, label);
  entry.cooldownUntilMs = Math.max(entry.cooldownUntilMs, untilMs);
  entry.lastError = message;
}

export function rememberConversation(
  ledger: AccountsLedger,
  providerThreadId: string,
  label: string,
): void {
  ledger.conversations[providerThreadId] = label;
}

export function conversationAccount(
  ledger: AccountsLedger,
  providerThreadId: string,
): string | null {
  return ledger.conversations[providerThreadId] ?? null;
}

/**
 * Pick the account a session should run on: not cooling, least recently
 * used, never the excluded one (the account that just burnt). When every
 * account is cooling, the one whose window opens first is still returned —
 * a rough estimate beats refusing to spawn.
 */
export function pickAccount(
  ledger: AccountsLedger,
  accounts: AccountHome[],
  excludeLabel?: string | null,
): AccountHome | null {
  const now = Date.now();
  const candidates = accounts.filter((a) => a.label !== excludeLabel);
  if (candidates.length === 0) {
    return null;
  }
  const cooldown = (a: AccountHome): number =>
    ledger.accounts[a.label]?.cooldownUntilMs ?? 0;
  const available = candidates.filter((a) => cooldown(a) <= now);
  const pool = available.length > 0 ? available : candidates;
  pool.sort(
    (a, b) =>
      cooldown(a) - cooldown(b) ||
      (ledger.accounts[a.label]?.lastUsedMs ?? 0) -
        (ledger.accounts[b.label]?.lastUsedMs ?? 0) ||
      a.label.localeCompare(b.label),
  );
  return pool[0];
}

export function accountByLabel(
  accounts: AccountHome[],
  label: string | null | undefined,
): AccountHome | null {
  if (!label) {
    return null;
  }
  return accounts.find((a) => a.label === label) ?? null;
}

/**
 * Create one pool entry from a Google OAuth refresh grant (the shape the
 * opencode antigravity plugin and cliproxy auth files both carry). The
 * access token is left empty with a stale expiry: agy refreshes it from the
 * refresh token on first use.
 */
export function writeAccountHome(
  dataDir: string,
  label: string,
  refreshToken: string,
  accessToken = "",
): string {
  if (
    !/^[A-Za-z0-9._@+-]+$/u.test(label) ||
    label === "." ||
    label === ".."
  ) {
    throw new Error(`unsafe account label: ${label}`);
  }
  const home = join(accountsDir(dataDir), label);
  const cliDir = join(home, ".gemini", "antigravity-cli");
  mkdirSync(cliDir, { recursive: true });
  const token = {
    auth_method: "consumer",
    token: {
      access_token: accessToken,
      token_type: "Bearer",
      refresh_token: refreshToken,
      expiry: "2000-01-01T00:00:00Z",
    },
  };
  writeFileSync(join(cliDir, "antigravity-oauth-token"), `${JSON.stringify(token)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return home;
}
