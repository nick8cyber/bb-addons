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
  /** Last eligibility parking, persisted for the cross-session breaker. */
  ineligibleAtMs?: number;
  /** Why the account is parked, when the cause is finer than eligibility. */
  parkedReason?: "auth-dead" | string;
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

// ---------------------------------------------------------------------------
// Eligibility parking. agy refuses accounts that fail Google's Antigravity
// eligibility check (region or verification); such an account is parked for a
// long cooldown, and a breaker stops mass-parking when the real cause is the
// egress, not the accounts.
// ---------------------------------------------------------------------------

/** A network failure during the eligibility check alone is not an auth failure. */
export function isAccountIneligible(message: string): boolean {
  return /not eligible for Antigravity|verify your account/iu.test(message);
}

/**
 * Signatures of a dead Google sign-in: the account's OAuth session was
 * revoked or expired and every session request fails auth_required (agy
 * logs "Silent sign-in failed" / "not logged into Antigravity" alongside).
 * Not quota, not eligibility — the account is parked until re-login.
 */
const AUTH_DEAD_PATTERN =
  /auth_required|authentication required|silent sign-in failed|not logged into antigravity|error getting token source/iu;

export function isAuthDead(message: string): boolean {
  return AUTH_DEAD_PATTERN.test(message);
}

/** Extract one eligibility diagnostic, excluding earlier quota/tool chatter. */
export function ineligibleStderrBlock(stderr: string): string | null {
  const lines = stderr.replace(/\u001b\[[0-9;]*m/gu, "")
    .split(/\r?\n/u).map((line) => line.trim());
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/Eligibility check failed/iu.test(lines[index]) ||
        (start === -1 && isAccountIneligible(lines[index]))) {
      start = index;
    }
  }
  if (start === -1) return null;
  const tail = lines.slice(start);
  let end = tail.findIndex((line) => /https:\/\/accounts\.google\.com\//u.test(line));
  if (end === -1) {
    // Location has no URL. End at the last eligibility instruction, not at
    // unrelated shutdown chatter; preserve intermediate diagnostic lines.
    end = 0;
    tail.forEach((line, index) => {
      if (isAccountIneligible(line) || /^Alternatively,/iu.test(line)) end = index;
    });
  }
  const message = tail.slice(0, end + 1).join("\n");
  return isAccountIneligible(message) ? message : null;
}

/** Read per failure so operators can disable parking without a bridge restart. */
export function ineligibleCooldownMs(location: boolean): number {
  const variable = location ? "AGY_LOCATION_COOLDOWN_MS" : "AGY_INELIGIBLE_COOLDOWN_MS";
  const raw = Number(process.env[variable]);
  return Number.isFinite(raw) && raw >= 0 ? raw : (location ? 7_200_000 : 86_400_000);
}

export function ineligibleBreakerWindowMs(): number {
  const raw = Number(process.env.AGY_INELIGIBLE_BREAKER_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
}

export function ineligibleBreakerMax(): number {
  const raw = Number(process.env.AGY_INELIGIBLE_BREAKER_MAX);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
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

/** True when too many accounts were parked inside the breaker window — the
 * egress looks guilty, not the accounts, so no more parking. */
export function checkIneligibleBreaker(ledger: AccountsLedger, nowMs = Date.now()): boolean {
  const windowMs = ineligibleBreakerWindowMs();
  const parkedCount = Object.values(ledger.accounts).filter(
    (entry) =>
      typeof entry.ineligibleAtMs === "number" &&
      entry.ineligibleAtMs > nowMs - windowMs &&
      entry.ineligibleAtMs <= nowMs,
  ).length;
  return parkedCount >= ineligibleBreakerMax();
}
