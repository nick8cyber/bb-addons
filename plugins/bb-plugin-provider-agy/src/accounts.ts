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

/**
 * Instance-local state (spec section 2.1, ADR-0025): accounts-state.json is
 * the SHARED pool file - an infra keeper one-way syncs it from the owner
 * instance and would erase anything a satellite wrote. State that belongs
 * to this instance lives in two sibling files the keeper never touches:
 *
 *   conversations-state.json   providerThreadId -> accountLabel pins
 *   accounts-overlay.json      shadow of marks this instance set, each with
 *                              its own writtenMs; applies while
 *                              writtenMs >= shared.lastUsedMs
 */
const SHARED_STATE_FILE = "accounts-state.json";
const CONVERSATIONS_STATE_FILE = "conversations-state.json";
const ACCOUNTS_OVERLAY_FILE = "accounts-overlay.json";

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
  /**
   * Labels this instance mutated since load — never persisted. saveLedger
   * copies only these entries into accounts-overlay.json; without it a
   * merged load could not tell our own marks from shared ones.
   */
  dirtyLabels?: Set<string>;
  /**
   * Conversation ids this instance pinned since load — never persisted.
   * saveLedger re-writes only these keys over the on-disk map, so a stale
   * snapshot cannot resurrect a neighbour's re-pin; pin-only saves also
   * leave the overlay file (and its writtenMs stamps) untouched.
   */
  dirtyPins?: Set<string>;
  /**
   * Freshness baseline per label for saveLedger's string-field merge —
   * never persisted. Seeded from the overlay record's writtenMs at load
   * and re-stamped to the written writtenMs on save, so a later save is
   * not shadowed by this instance's own write. Helpers that mutate
   * parkedReason/lastError bump it to the mutation time, which is what
   * lets an on-disk neighbour record win the string fields only when it
   * post-dates our snapshot.
   */
  overlayStamps?: Map<string, number>;
}

/** Overlay record: one account mark plus when this instance wrote it. */
interface OverlayEntry extends AccountLedgerEntry {
  writtenMs: number;
}

interface OverlayFile {
  accounts: Record<string, OverlayEntry>;
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

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * Effective view over shared + instance-local files:
 * - conversations = union(legacy shared field, conversations-state.json),
 *   local wins; legacy pins migrate eagerly so a first shared save cannot
 *   erase them before this instance ever wrote.
 * - accounts = merge(shared, overlay): cooldownUntilMs/lastUsedMs/
 *   ineligibleAtMs take the max of both sides (the mass-parking breaker
 *   must see the freshest stamp), parkedReason/lastError come from the
 *   fresher side — a null there is a value, not an absence; an overlay
 *   record applies while writtenMs >= shared.lastUsedMs (fresh shared
 *   activity lifts the whole shadow, which is how an owner-side unpark
 *   arrives).
 */
export function loadLedger(dataDir: string): AccountsLedger {
  const shared =
    readJsonFile<Partial<AccountsLedger>>(
      join(dataDir, SHARED_STATE_FILE),
    ) ?? {};
  const sharedAccounts = shared.accounts ?? {};
  const legacyConversations = shared.conversations ?? {};

  const localPath = join(dataDir, CONVERSATIONS_STATE_FILE);
  let local = readJsonFile<{ conversations?: Record<string, string> }>(
    localPath,
  );
  const localConversations = local?.conversations ?? {};
  if (
    Object.keys(legacyConversations).some(
      (key) => !(key in localConversations),
    )
  ) {
    // Eager migration: the next keeper sync would erase shared pins this
    // instance still needs; persist them locally on first sight. Fires on
    // a missing, broken or empty local file alike — anything that leaves
    // a legacy pin uncovered.
    const migrated = { ...legacyConversations, ...localConversations };
    try {
      writeJsonAtomic(localPath, { conversations: migrated });
      local = { conversations: migrated };
    } catch {
      // Read-only dir or a race on the temp name: the union below still
      // returns the pins; they persist on the next successful save.
    }
  }
  const conversations = {
    ...legacyConversations,
    ...(local?.conversations ?? {}),
  };

  const overlay =
    readJsonFile<Partial<OverlayFile>>(
      join(dataDir, ACCOUNTS_OVERLAY_FILE),
    )?.accounts ?? {};
  const accounts: Record<string, AccountLedgerEntry> = {};
  const overlayStamps = new Map<string, number>();
  for (const label of new Set([
    ...Object.keys(sharedAccounts),
    ...Object.keys(overlay),
  ])) {
    const s = sharedAccounts[label];
    const o = overlay[label];
    if (o !== undefined) {
      overlayStamps.set(label, o.writtenMs ?? 0);
    }
    if (o !== undefined && (o.writtenMs ?? 0) >= (s?.lastUsedMs ?? 0)) {
      const ineligibleAtMs = Math.max(
        s?.ineligibleAtMs ?? 0,
        o.ineligibleAtMs ?? 0,
      );
      // parkedReason falls back to the shared side: an applied shadow
      // that never carried the field should not hide the diagnostic the
      // shared file still has.
      const parkedReason = o.parkedReason ?? s?.parkedReason;
      accounts[label] = {
        cooldownUntilMs: Math.max(s?.cooldownUntilMs ?? 0, o.cooldownUntilMs ?? 0),
        lastUsedMs: Math.max(s?.lastUsedMs ?? 0, o.lastUsedMs ?? 0),
        lastError: o.lastError ?? null,
        ...(ineligibleAtMs > 0 ? { ineligibleAtMs } : {}),
        ...(parkedReason !== undefined ? { parkedReason } : {}),
      };
    } else if (s !== undefined) {
      accounts[label] = s;
    }
  }
  return { accounts, conversations, dirtyLabels: new Set(), overlayStamps };
}

/**
 * Persist order is local files first, shared last: a crash between them
 * leaves the old shared file beside newer local data, and the read union
 * loses nothing. The shared file gets only `accounts` — the conversations
 * field leaves it on first save.
 */
export function saveLedger(dataDir: string, ledger: AccountsLedger): void {
  // Merge-on-save for pins, by dirty keys only: parallel wrappers of this
  // instance race load-modify-save, so re-read the file and overwrite just
  // the keys this ledger pinned — a stale snapshot must not resurrect a
  // neighbour's re-pin. Keys absent on disk (e.g. legacy pins whose eager
  // migration failed at load) cannot clobber anything, so they join too.
  const conversationsPath = join(dataDir, CONVERSATIONS_STATE_FILE);
  const diskConversations =
    readJsonFile<{ conversations?: Record<string, string> }>(
      conversationsPath,
    )?.conversations ?? {};
  const pinKeys = new Set(ledger.dirtyPins ?? []);
  for (const key of Object.keys(ledger.conversations)) {
    if (!(key in diskConversations)) {
      pinKeys.add(key);
    }
  }
  if (pinKeys.size > 0) {
    const mergedConversations = { ...diskConversations };
    for (const key of pinKeys) {
      const label = ledger.conversations[key];
      if (label !== undefined) {
        mergedConversations[key] = label;
      }
    }
    writeJsonAtomic(conversationsPath, {
      conversations: mergedConversations,
    });
  }

  // Ghost detection runs unconditionally, before ANY shared write: a
  // ghost is a label absent from both the on-disk shared accounts and
  // the accounts/ directory — a stale overlay shadow that must never
  // reach the shared file (it syncs onward from there). A pin-only save
  // would otherwise leak it, since a ghost still sits in ledger.accounts
  // once its overlay record applied on load. The check reads the shared
  // file on disk, not the merged view.
  const sharedPath = join(dataDir, SHARED_STATE_FILE);
  const diskSharedAccounts =
    readJsonFile<Partial<AccountsLedger>>(sharedPath)?.accounts ?? {};
  // Object.hasOwn, not `in`: the map is a JSON.parse result, so labels
  // like "constructor" or "toString" would otherwise pass as present via
  // the prototype chain and never be seen as ghosts. A label carrying
  // path separators or ".." can never be an account home — it is a ghost
  // outright, and probing the filesystem for it would read outside
  // dataDir. When the shared file itself is broken the map reads as zero
  // accounts: labels that exist only there (a removed account still on
  // cooldown) are then all judged ghosts and purged — the torn-write
  // class of failure, bounded in ADR-0025 "Границы".
  const isGhostLabel = (label: string): boolean =>
    !Object.hasOwn(diskSharedAccounts, label) &&
    (label.includes("/") ||
      label.includes("\\") ||
      label.includes("..") ||
      !existsSync(join(accountsDir(dataDir), label)));

  // Overlay is written only for labels this instance dirtied; a save done
  // purely for a conversation pin leaves the file (and its writtenMs)
  // untouched. The disk merge is per FIELD of the same label, not whole
  // record by writtenMs: a fresh stamp with stale contents would erase a
  // neighbour wrapper's cooldown. Numbers take the max of both sides —
  // marks only grow locally — parkedReason/lastError come from the fresher
  // side: the disk record when its writtenMs beats the stamp loadLedger
  // recorded (a neighbour wrote after our snapshot), our record otherwise.
  // Helpers re-stamp when they mutate strings, so our own fresh mark is
  // not shadowed by an older neighbour write; absent writtenMs counts as
  // 0, so a hand-edited overlay does not wedge updates. lastError always
  // serializes, a fresh-side null is a value, not an absence. The disk
  // record joins the merge only while its shadow still applies — a lifted
  // shadow (writtenMs behind the shared lastUsedMs re-read above) would
  // otherwise resurrect its cooldown, ineligible stamp and strings under
  // a fresh writtenMs. Dead shadows are purged before the merge so they
  // cannot linger and sync onward.
  if (ledger.dirtyLabels !== undefined && ledger.dirtyLabels.size > 0) {
    const overlayPath = join(dataDir, ACCOUNTS_OVERLAY_FILE);
    const onDisk =
      readJsonFile<Partial<OverlayFile>>(overlayPath)?.accounts ?? {};
    const merged: Record<string, OverlayEntry> = { ...onDisk };
    const now = Date.now();
    // A lifted shadow (writtenMs behind the shared lastUsedMs re-read
    // above) is purged before the merge: left in, it would resurrect its
    // cooldown, ineligible stamp and strings under a fresh writtenMs.
    for (const label of Object.keys(merged)) {
      if (
        (merged[label].writtenMs ?? 0) <
        (diskSharedAccounts[label]?.lastUsedMs ?? 0)
      ) {
        delete merged[label];
      }
    }
    for (const label of ledger.dirtyLabels) {
      const entry = ledger.accounts[label];
      if (entry === undefined) {
        continue;
      }
      const disk = merged[label];
      const diskWrittenMs = disk?.writtenMs ?? 0;
      // Same applicability rule loadLedger uses: the shadow lives while
      // writtenMs >= shared.lastUsedMs. A dead disk record contributes
      // nothing — not to max(), not to freshSide.
      const diskEntry =
        disk !== undefined &&
        diskWrittenMs >= (diskSharedAccounts[label]?.lastUsedMs ?? 0)
          ? disk
          : undefined;
      const stamp = ledger.overlayStamps?.get(label) ?? 0;
      const freshSide: AccountLedgerEntry =
        diskEntry !== undefined && diskWrittenMs > stamp
          ? diskEntry
          : entry;
      const ineligibleAtMs = Math.max(
        entry.ineligibleAtMs ?? 0,
        diskEntry?.ineligibleAtMs ?? 0,
      );
      merged[label] = {
        cooldownUntilMs: Math.max(
          entry.cooldownUntilMs ?? 0,
          diskEntry?.cooldownUntilMs ?? 0,
        ),
        lastUsedMs: Math.max(
          entry.lastUsedMs ?? 0,
          diskEntry?.lastUsedMs ?? 0,
        ),
        lastError: freshSide.lastError ?? null,
        ...(ineligibleAtMs > 0 ? { ineligibleAtMs } : {}),
        ...(freshSide.parkedReason !== undefined
          ? { parkedReason: freshSide.parkedReason }
          : {}),
        writtenMs: Math.max(now, diskEntry?.writtenMs ?? 0),
      };
      (ledger.overlayStamps ??= new Map()).set(
        label,
        merged[label].writtenMs,
      );
    }
    for (const label of Object.keys(merged)) {
      if (isGhostLabel(label)) {
        delete merged[label];
      }
    }
    writeJsonAtomic(overlayPath, { accounts: merged });
  }

  writeJsonAtomic(sharedPath, {
    accounts: Object.fromEntries(
      Object.entries(ledger.accounts).filter(
        ([label]) => !isGhostLabel(label),
      ),
    ),
  });
}

function ledgerEntry(
  ledger: AccountsLedger,
  label: string,
): AccountLedgerEntry {
  return (ledger.accounts[label] ??= {
    cooldownUntilMs: 0,
    lastUsedMs: 0,
    lastError: null,
  });
}

function markDirty(ledger: AccountsLedger, label: string): void {
  (ledger.dirtyLabels ??= new Set()).add(label);
}

/**
 * Re-stamp a label after a helper writes its string fields: saveLedger
 * hands parkedReason/lastError to whichever side is fresher by
 * overlayStamps, so a neighbour's older overlay record must not shadow
 * the mark this instance just made. Helpers that touch only numbers
 * (markAccountUse) leave the stamp alone — a stale numeric-only save
 * then yields the strings to a fresher on-disk record.
 */
function stampStrings(ledger: AccountsLedger, label: string): void {
  (ledger.overlayStamps ??= new Map()).set(label, Date.now());
}

export function markAccountUse(
  ledger: AccountsLedger,
  label: string,
): void {
  ledgerEntry(ledger, label).lastUsedMs = Date.now();
  markDirty(ledger, label);
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
  stampStrings(ledger, label);
  markDirty(ledger, label);
}

/**
 * Park an account after an eligibility/auth refusal: stamps ineligibleAtMs
 * (the cross-session breaker counts it) and, when the cause is finer than
 * eligibility, parkedReason. Direct field writes are forbidden — without
 * this helper the mark never reaches accounts-overlay.json and the next
 * keeper sync erases it.
 */
export function markAccountIneligible(
  ledger: AccountsLedger,
  label: string,
  options: { parkedReason?: AccountLedgerEntry["parkedReason"] } = {},
): void {
  const entry = ledgerEntry(ledger, label);
  entry.ineligibleAtMs = Date.now();
  if (options.parkedReason !== undefined) {
    entry.parkedReason = options.parkedReason;
    stampStrings(ledger, label);
  }
  markDirty(ledger, label);
}

export function rememberConversation(
  ledger: AccountsLedger,
  providerThreadId: string,
  label: string,
): void {
  ledger.conversations[providerThreadId] = label;
  (ledger.dirtyPins ??= new Set()).add(providerThreadId);
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
