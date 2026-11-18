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
  /**
   * Numeric pool priority: integer >= 0, default 10.
   * 0 = disabled from rotation (never picked).
   * Shared-owned field: lives in accounts-state.json only, ignored by overlay.
   */
  priority?: number;
  /**
   * Install binding (provider-agy-installs §3): the name this account's
   * binary comes from, resolved through the instance-local
   * agy-installs.json. Shared-owned exactly like priority — disk wins on
   * save, absent means the registry's default install, and a value that
   * fails the install-name pattern counts as an unknown install (the
   * account is locally unavailable, never silently rebound to default).
   */
  install?: string;
}

export const DEFAULT_ACCOUNT_PRIORITY = 10;

/**
 * Returns account priority: integer >= 0, default 10 if missing, not an integer, or < 0.
 */
export function accountPriority(entry: AccountLedgerEntry | undefined): number {
  const p = entry?.priority;
  if (typeof p === "number" && Number.isInteger(p) && p >= 0) {
    return p;
  }
  return DEFAULT_ACCOUNT_PRIORITY;
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
 * Set an own enumerable property on an object without invoking prototype
 * setters (e.g. `__proto__`). Standard dynamic assignment `obj[k] = v`
 * triggers Object.prototype.__proto__ setter, poisoning the prototype
 * instead of storing an own property.
 */
function setOwn<T extends object, K extends PropertyKey, V>(
  obj: T,
  key: K,
  val: V,
): void {
  Object.defineProperty(obj, key, {
    value: val,
    writable: true,
    enumerable: true,
    configurable: true,
  });
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
      (key) => !Object.hasOwn(localConversations, key),
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
    const s = Object.hasOwn(sharedAccounts, label)
      ? sharedAccounts[label]
      : undefined;
    const o = Object.hasOwn(overlay, label) ? overlay[label] : undefined;
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
      setOwn(accounts, label, {
        cooldownUntilMs: Math.max(s?.cooldownUntilMs ?? 0, o.cooldownUntilMs ?? 0),
        lastUsedMs: Math.max(s?.lastUsedMs ?? 0, o.lastUsedMs ?? 0),
        lastError: o.lastError ?? null,
        ...(ineligibleAtMs > 0 ? { ineligibleAtMs } : {}),
        ...(parkedReason !== undefined ? { parkedReason } : {}),
        ...(s?.priority !== undefined ? { priority: s.priority } : {}),
        ...(s?.install !== undefined ? { install: s.install } : {}),
      });
    } else if (s !== undefined) {
      setOwn(accounts, label, s);
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
    if (!Object.hasOwn(diskConversations, key)) {
      pinKeys.add(key);
    }
  }
  if (pinKeys.size > 0) {
    const mergedConversations = { ...diskConversations };
    for (const key of pinKeys) {
      const label = Object.hasOwn(ledger.conversations, key)
        ? ledger.conversations[key]
        : undefined;
      if (label !== undefined) {
        setOwn(mergedConversations, key, label);
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
  // the prototype chain and never be seen as ghosts. An empty label,
  // path separators or ".." can never be an account home — it is a ghost
  // outright, and probing the filesystem for it would read dataDir or
  // outside it. When the shared file itself is broken the map reads as
  // zero accounts: labels that exist only there (a removed account still on
  // cooldown) are then all judged ghosts and purged — the torn-write
  // class of failure, bounded in ADR-0025 "Границы".
  const isGhostLabel = (label: string): boolean =>
    !Object.hasOwn(diskSharedAccounts, label) &&
    (!label ||
      label === "." ||
      label === ".." ||
      label.includes("/") ||
      label.includes("\\") ||
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
      const mergedEntry = Object.hasOwn(merged, label)
        ? merged[label]
        : undefined;
      const diskShared = Object.hasOwn(diskSharedAccounts, label)
        ? diskSharedAccounts[label]
        : undefined;
      if (
        (mergedEntry?.writtenMs ?? 0) <
        (diskShared?.lastUsedMs ?? 0)
      ) {
        delete merged[label];
      }
    }
    for (const label of ledger.dirtyLabels) {
      const entry = Object.hasOwn(ledger.accounts, label)
        ? ledger.accounts[label]
        : undefined;
      if (entry === undefined) {
        continue;
      }
      const disk = Object.hasOwn(merged, label) ? merged[label] : undefined;
      const diskWrittenMs = disk?.writtenMs ?? 0;
      // Same applicability rule loadLedger uses: the shadow lives while
      // writtenMs >= shared.lastUsedMs. A dead disk record contributes
      // nothing — not to max(), not to freshSide.
      const diskShared = Object.hasOwn(diskSharedAccounts, label)
        ? diskSharedAccounts[label]
        : undefined;
      const diskEntry =
        disk !== undefined &&
        diskWrittenMs >= (diskShared?.lastUsedMs ?? 0)
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
      const writtenMs = Math.max(now, diskEntry?.writtenMs ?? 0);
      setOwn(merged, label, {
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
        writtenMs,
      });
      (ledger.overlayStamps ??= new Map()).set(
        label,
        writtenMs,
      );
    }
    for (const label of Object.keys(merged)) {
      if (isGhostLabel(label)) {
        delete merged[label];
      }
    }
    writeJsonAtomic(overlayPath, { accounts: merged });
  }

  // §3 п.1 (provider-agy-installs): labels present on disk but absent from
  // this ledger's snapshot — an account added concurrently between
  // loadLedger and saveLedger — ride through verbatim: a stale memory
  // snapshot must not drop the record together with its install binding.
  const diskOnlyLabels = Object.entries(diskSharedAccounts).filter(
    ([label]) => !Object.hasOwn(ledger.accounts, label),
  );
  writeJsonAtomic(sharedPath, {
    accounts: Object.fromEntries([
      ...diskOnlyLabels,
      ...Object.entries(ledger.accounts)
        .filter(([label]) => !isGhostLabel(label))
        .map(([label, entry]) => {
          const hasDisk = Object.hasOwn(diskSharedAccounts, label);
          const diskPriority = hasDisk
            ? diskSharedAccounts[label]?.priority
            : undefined;
          const diskInstall = hasDisk
            ? diskSharedAccounts[label]?.install
            : undefined;
          const priority = hasDisk ? diskPriority : entry.priority;
          const install = hasDisk ? diskInstall : entry.install;
          if (hasDisk) {
            if (diskPriority !== undefined) {
              entry.priority = diskPriority;
            } else {
              delete entry.priority;
            }
            if (diskInstall !== undefined) {
              entry.install = diskInstall;
            } else {
              delete entry.install;
            }
          }
          const {
            priority: _stalePriority,
            install: _staleInstall,
            ...rest
          } = entry;
          return [
            label,
            {
              ...rest,
              ...(priority !== undefined ? { priority } : {}),
              ...(install !== undefined ? { install } : {}),
            },
          ];
        }),
    ]),
  });
}

function ledgerEntry(
  ledger: AccountsLedger,
  label: string,
): AccountLedgerEntry {
  let entry = Object.hasOwn(ledger.accounts, label)
    ? ledger.accounts[label]
    : undefined;
  if (entry === undefined) {
    entry = {
      cooldownUntilMs: 0,
      lastUsedMs: 0,
      lastError: null,
    };
    setOwn(ledger.accounts, label, entry);
  }
  return entry;
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
  setOwn(ledger.conversations, providerThreadId, label);
  (ledger.dirtyPins ??= new Set()).add(providerThreadId);
}

export function conversationAccount(
  ledger: AccountsLedger,
  providerThreadId: string,
): string | null {
  return (
    (Object.hasOwn(ledger.conversations, providerThreadId)
      ? ledger.conversations[providerThreadId]
      : undefined) ?? null
  );
}

/**
 * Pick the account a session should run on (§2.2, model-aware per §2.3):
 * - Candidates: not excludeLabel, priority > 0 (priority 0 is never picked),
 *   never parked (any parkedReason), and suitable for `options.family`
 *   when one is given.
 * - Suitability: an account whose fresh catalog lacks the family — or whose
 *   unsupported mark for it is still fresh — is out. An account without a
 *   catalog record counts as suitable but is only picked while no AVAILABLE
 *   account has a catalog that names the family.
 * - Choose highest priority among available accounts (cooldownUntilMs <= now).
 * - Within that tier: LRU by lastUsedMs, tie-break label.
 * - When every candidate is cooling down: fallback to the account whose window
 *   opens first within the highest present tier (priority 0 not included).
 * - When all candidates have priority 0: returns null.
 */
export function pickAccount(
  ledger: AccountsLedger,
  accounts: AccountHome[],
  excludeLabel?: string | null,
  options?: {
    /** Model family the session needs, already effort-stripped. */
    family?: string | null;
    /** Fresh per-account catalogs from loadAccountModels. */
    models?: AccountModelCatalog;
    nowMs?: number;
    /**
     * Local availability gate (provider-agy-installs §5 п.2): the only
     * place the install binding matters — a label this predicate rejects
     * never becomes a candidate, exactly like a parked account.
     */
    locallyAvailable?: (label: string) => boolean;
  },
): AccountHome | null {
  const now = options?.nowMs ?? Date.now();
  const family = options?.family ?? null;
  const models = options?.models ?? {};
  const locallyAvailable = options?.locallyAvailable;
  const entryOf = (label: string): AccountLedgerEntry | undefined =>
    Object.hasOwn(ledger.accounts, label) ? ledger.accounts[label] : undefined;
  const priorityOf = (a: AccountHome): number =>
    accountPriority(entryOf(a.label));
  const cooldown = (a: AccountHome): number =>
    entryOf(a.label)?.cooldownUntilMs ?? 0;
  const stateOf = (a: AccountHome): AccountModelState =>
    family === null
      ? "supports"
      : accountModelState(
          Object.hasOwn(models, a.label) ? models[a.label] : undefined,
          family,
          now,
        );

  let candidates = accounts.filter(
    (a) =>
      a.label !== excludeLabel &&
      priorityOf(a) > 0 &&
      entryOf(a.label)?.parkedReason === undefined &&
      (locallyAvailable === undefined || locallyAvailable(a.label)) &&
      stateOf(a) !== "unsupported",
  );
  if (candidates.length === 0) {
    return null;
  }
  if (family !== null) {
    // A catalog-less account counts as suitable only when no available
    // account carries the family in its own catalog (§2.3).
    const knownSupport = candidates.filter((a) => stateOf(a) === "supports");
    if (knownSupport.some((a) => cooldown(a) <= now)) {
      candidates = knownSupport;
    }
  }

  const available = candidates.filter((a) => cooldown(a) <= now);
  if (available.length > 0) {
    const maxPriority = Math.max(...available.map(priorityOf));
    const tier = available.filter((a) => priorityOf(a) === maxPriority);
    tier.sort(
      (a, b) =>
        (entryOf(a.label)?.lastUsedMs ?? 0) -
          (entryOf(b.label)?.lastUsedMs ?? 0) ||
        a.label.localeCompare(b.label),
    );
    return tier[0];
  }

  // All candidates are cooling down: fallback to the account whose window
  // opens first within the highest present tier.
  const maxPriority = Math.max(...candidates.map(priorityOf));
  const tier = candidates.filter((a) => priorityOf(a) === maxPriority);
  tier.sort(
    (a, b) =>
      cooldown(a) - cooldown(b) ||
      (entryOf(a.label)?.lastUsedMs ?? 0) -
        (entryOf(b.label)?.lastUsedMs ?? 0) ||
      a.label.localeCompare(b.label),
  );
  return tier[0];
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
 * egress looks guilty, not the accounts, so no more parking. tos-disabled
 * and validation-required parkings are the account's own ban/verification
 * (§2.3 пп. 7, 11): they neither feed the count nor are held back by an
 * open breaker. */
export function checkIneligibleBreaker(ledger: AccountsLedger, nowMs = Date.now()): boolean {
  const windowMs = ineligibleBreakerWindowMs();
  const parkedCount = Object.values(ledger.accounts).filter(
    (entry) =>
      entry.parkedReason !== "tos-disabled" &&
      entry.parkedReason !== "validation-required" &&
      typeof entry.ineligibleAtMs === "number" &&
      entry.ineligibleAtMs > nowMs - windowMs &&
      entry.ineligibleAtMs <= nowMs,
  ).length;
  return parkedCount >= ineligibleBreakerMax();
}

// ---------------------------------------------------------------------------
// Terms-of-Service parking (spec §2.3). Distinct from eligibility/auth-dead:
// Google disabled the account itself, so there is no automatic retry and no
// cooldown clock — the account is excluded from selection until an operator
// manually clears the mark.
// ---------------------------------------------------------------------------

/**
 * Signature of a Google ToS account disable
 * ("This service has been disabled in this account for violation of Terms
 * of Service"). Kept here with the other failure signatures so the
 * stream-json and ACP paths classify it identically.
 */
const TOS_DISABLED_PATTERN =
  /disabled in this account for violation of terms of service/iu;

export function isTosDisabled(message: string): boolean {
  return TOS_DISABLED_PATTERN.test(message);
}

/**
 * Signature of Google's 403 PERMISSION_DENIED / VALIDATION_REQUIRED
 * ("Verify your account to continue"): the account itself needs a manual
 * verification in a browser — not quota, not ToS, not auth-dead, and not
 * plain eligibility (it parks permanently like tos-disabled, §2.3 п.11).
 * agy reports it two ways: the 403 reason in its log and the literal
 * "⚠ Verification Required" inside the agent message text.
 */
const VALIDATION_REQUIRED_PATTERN =
  /validation_required|verify your account to continue|⚠\s*verification required/iu;

export function isValidationRequired(message: string): boolean {
  return VALIDATION_REQUIRED_PATTERN.test(message);
}

/**
 * §2.3 п.11 (ревизия 13.1): inside streamed agent output only the exact
 * agy form counts — a message whose trimmed content IS the
 * "⚠ Verification Required" marker and nothing substantial after it.
 * Ordinary prose mentioning these words (a quote, a discussion of the
 * error itself) never triggers parking; the wide VALIDATION_REQUIRED
 * pattern above stays reserved for real error strings.
 */
const AGENT_VALIDATION_MESSAGE_PATTERN =
  /^⚠\s*Verification Required\.?\s*$/iu;

export function isAgentValidationMessage(text: string): boolean {
  return AGENT_VALIDATION_MESSAGE_PATTERN.test(text.trim());
}

/**
 * The far-future stamp a tos-disabled parking puts on cooldownUntilMs:
 * effectively permanent, but still readable by every "is this account in
 * cooldown" check that predates the mark.
 */
export const TOS_DISABLED_COOLDOWN_UNTIL_MS = 8_640_000_000_000_000;

/**
 * The account refused the requested model — "Unknown model ID" on
 * session/set_config_option|set_model or on session/prompt, and the
 * "not available for the current authentication method" variant. Not
 * quota: the refusal marks the family unsupported for that account in
 * accounts-models.json instead of cooling the whole account.
 */
const MODEL_REFUSAL_PATTERN =
  /unknown model id|not available for the current authentication method/iu;

export function isModelRefusal(message: string): boolean {
  return MODEL_REFUSAL_PATTERN.test(message);
}

// ---------------------------------------------------------------------------
// Per-account model catalog (spec §2.3, ADR-0030). accounts-models.json is
// instance-local (the keeper syncs accounts-state.json only): each record
// is what `agy --gemini-dir <home>/.gemini models` answered for that
// account, plus negative knowledge from in-flight refusals.
// ---------------------------------------------------------------------------

const ACCOUNTS_MODELS_FILE = "accounts-models.json";

/** Same lifetime as the merged provider model cache: six hours. */
export const ACCOUNT_MODELS_TTL_MS = 6 * 60 * 60 * 1000;

export interface AccountModelRecord {
  /** What `agy models` printed for this account. */
  raw: { id: string; displayName: string }[];
  /** Model families (effort suffix stripped) the account offers. */
  families: string[];
  /** family -> atMs of the latest in-flight refusal; fresh marks exclude. */
  unsupported: Record<string, number>;
  /** When the record was last (re)written. */
  atMs: number;
}

export type AccountModelCatalog = Record<string, AccountModelRecord>;

export type AccountModelState = "supports" | "unsupported" | "unknown";

const MODEL_EFFORT_SUFFIX =
  /-(none|low|medium|high|xhigh|ultra|ultracode|max)$/u;

/** The family a model id belongs to: the id minus an effort suffix (§8). */
export function modelFamilyOf(model: string): string {
  const base = model.replace(MODEL_EFFORT_SUFFIX, "");
  return base.length > 0 ? base : model;
}

/**
 * Per-account model records keyed by label. A record older than the
 * six-hour TTL is STILL returned (§2.3 п.1): it stays valid for selection
 * until a successful poll replaces it — callers that schedule refreshes
 * compare `atMs` themselves. Unsupported marks past the TTL are pruned;
 * each mark has its own lifetime (see accountModelState).
 */
export function loadAccountModels(dataDir: string): AccountModelCatalog {
  const parsed =
    readJsonFile<{ accounts?: AccountModelCatalog }>(
      join(dataDir, ACCOUNTS_MODELS_FILE),
    )?.accounts ?? {};
  const now = Date.now();
  const out: AccountModelCatalog = {};
  for (const [label, rec] of Object.entries(parsed)) {
    if (
      rec === null ||
      typeof rec !== "object" ||
      !Array.isArray(rec.raw) ||
      !Array.isArray(rec.families) ||
      typeof rec.atMs !== "number"
    ) {
      continue;
    }
    const unsupported: Record<string, number> = {};
    for (const [family, atMs] of Object.entries(rec.unsupported ?? {})) {
      if (typeof atMs === "number" && now - atMs <= ACCOUNT_MODELS_TTL_MS) {
        setOwn(unsupported, family, atMs);
      }
    }
    setOwn(out, label, {
      raw: rec.raw.filter(
        (e): e is { id: string; displayName: string } =>
          typeof e === "object" && e !== null && typeof e.id === "string",
      ).map((e) => ({
        id: e.id,
        displayName:
          typeof e.displayName === "string" ? e.displayName : e.id,
      })),
      families: rec.families.filter((f): f is string => typeof f === "string"),
      unsupported,
      atMs: rec.atMs,
    });
  }
  return out;
}

function writeAccountModels(
  dataDir: string,
  mutate: (accounts: AccountModelCatalog) => void,
): void {
  const path = join(dataDir, ACCOUNTS_MODELS_FILE);
  const accounts = { ...(readJsonFile<{ accounts?: AccountModelCatalog }>(path)?.accounts ?? {}) };
  mutate(accounts);
  try {
    writeJsonAtomic(path, { accounts });
  } catch {
    // Instance-local file: a write failure must never take the bridge down.
  }
}

/**
 * Merge-on-save a fresh poll for one account: raw/families/atMs are
 * authoritative for the label, but the unsupported marks union with what
 * sits on disk — a parallel wrapper's in-flight refusal must survive.
 * Callers pass a non-empty raw only: an empty or failed poll never
 * overwrites a previous valid record.
 */
export function saveAccountModelRecord(
  dataDir: string,
  label: string,
  raw: { id: string; displayName: string }[],
): void {
  writeAccountModels(dataDir, (accounts) => {
    const previous = Object.hasOwn(accounts, label) ? accounts[label] : undefined;
    setOwn(accounts, label, {
      raw,
      families: [...new Set(raw.map((e) => modelFamilyOf(e.id)))],
      unsupported: { ...(previous?.unsupported ?? {}) },
      atMs: Date.now(),
    });
  });
}

/**
 * An in-flight refusal says this account does not serve the family —
 * persist it so the next pick (this rotation included) skips the account
 * for that family. The mark survives later poll writes
 * (saveAccountModelRecord unions it), and a never-polled account gets a
 * raw-empty record that still reads as "unknown" for every other family.
 */
export function markAccountModelUnsupported(
  dataDir: string,
  label: string,
  family: string,
): void {
  writeAccountModels(dataDir, (accounts) => {
    const previous = Object.hasOwn(accounts, label) ? accounts[label] : undefined;
    const unsupported = { ...(previous?.unsupported ?? {}) };
    setOwn(unsupported, family, Date.now());
    setOwn(accounts, label, {
      raw: previous?.raw ?? [],
      families: previous?.families ?? [],
      unsupported,
      // A refusal is negative knowledge, not a fresh poll: re-stamping
      // Date.now() would validate a stale record for another TTL and
      // silence the refresh queue. A never-polled account gets atMs 0 —
      // stale on arrival, so the lazy probe still runs (§2.3 п.1).
      atMs: previous?.atMs ?? 0,
    });
  });
}

/**
 * An account's standing for a model family:
 * - "supports": a live catalog names the family and no fresh refusal mark
 *   contradicts it;
 * - "unsupported": a fresh unsupported mark, or the family is absent from
 *   a catalog that did answer (`raw` non-empty);
 * - "unknown": never polled, or the record carries refusal marks only.
 */
export function accountModelState(
  record: AccountModelRecord | undefined,
  family: string,
  nowMs: number,
): AccountModelState {
  if (record === undefined) {
    return "unknown";
  }
  const marked = Object.hasOwn(record.unsupported, family)
    ? record.unsupported[family]
    : undefined;
  if (typeof marked === "number" && nowMs - marked <= ACCOUNT_MODELS_TTL_MS) {
    return "unsupported";
  }
  if (record.families.includes(family)) {
    return "supports";
  }
  return record.raw.length > 0 ? "unsupported" : "unknown";
}
