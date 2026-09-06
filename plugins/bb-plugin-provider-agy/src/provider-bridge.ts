/**
 * The `agy` provider bridge: Antigravity's CLI as a first-class bb provider,
 * speaking the bb Provider Bridge Protocol natively (line-delimited JSON-RPC
 * 2.0 on stdin/stdout, protocol version 2, `thread/delta` grammar.
 *
 * Topology: one bridge process serves every thread on this provider, and each
 * thread owns one `agy` child held open in stream-json mode. A turn is one
 * NDJSON line written to that child's stdin; agy answers with a run of
 * `step_update` events and exactly one `result`, which is this bridge's turn
 * boundary.
 *
 * What the protocol demands and where it is honoured:
 * - Hygiene: unknown method → METHOD_NOT_FOUND, invalid params →
 *   INVALID_PARAMS with the issues, non-JSON and response-shaped lines
 *   ignored without taking the bridge down.
 * - Ids: provider turn and item ids are minted here, with per-process entropy,
 *   and the runtime maps them into its own canonical id space.
 * - Grammar: every accepted turn settles exactly once; every item opens before
 *   any text delta; `thread/identity` and `session.reset` precede the thread's
 *   first delta; a `release` stop fabricates no interruption.
 * - Steering: `steerMode: "queue"`. agy cannot inject into a running turn, so
 *   an accepted `turn/steer` becomes the next turn in this bridge's own queue
 *   — never a dropped request. Only a steer that names a turn the session is
 *   no longer running is refused, with the `staleTurn` hint the runtime keys
 *   on.
 * - Child processes: finalize on `close`, not `exit`; a stale child's output
 *   can never reach a fresh session (`generation` is checked in every
 *   callback); the child's env is derived from this process's, not inherited
 *   implicitly.
 */
import {
  type PromptInput,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGY_NOISE_STEP_TYPES,
  type AgyUsage,
  agySpawnArgs,
  agyUserMessageLine,
  parseAgyLine,
  parseAgyModelsOutput,
  resolveAgyCommand,
} from "./agy-cli.js";
import {
  accountByLabel,
  accountsEnabled,
  listAccounts,
  loadLedger,
  markAccountCooldown,
  markAccountUse,
  pickAccount,
  rememberConversation,
  conversationAccount,
  saveLedger,
  type AccountHome,
  type AccountsLedger,
} from "./accounts.js";

// ---------------------------------------------------------------------------
// Wire plumbing. One stdout writer, protocol traffic only — a stray log line
// on stdout is invisible to the runtime's reader and a debugging sinkhole, so
// everything diagnostic goes to stderr.
// ---------------------------------------------------------------------------

type JsonRpcId = string | number;

function writeMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function respondResult(id: JsonRpcId, result: unknown): void {
  writeMessage({ id, result });
}

function respondError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): void {
  writeMessage({
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

function notify(method: string, params: Record<string, unknown>): void {
  writeMessage({ method, params });
}

/**
 * Diagnostics. The daemon does not capture a bridge's stderr anywhere, so the
 * bridge keeps its own log in the plugin's dataDir — without it, "agy did not
 * report a conversation id" is an unfalsifiable claim.
 */
let logFile: string | null = null;

function log(message: string): void {
  const line = `${new Date().toISOString()} [provider-agy] ${message}\n`;
  process.stderr.write(line);
  if (logFile !== null) {
    try {
      appendFileSync(logFile, line);
    } catch {
      // A log that cannot be written must never break a turn.
    }
  }
}

/**
 * A `turn/steer` that names a turn this session is not running any more. The
 * typed `staleTurn` hint is what the runtime keys on — it drops the steer
 * instead of pattern-matching error text — and `retryable: false` says a
 * second attempt would be just as stale.
 */
function refuseStaleSteer(id: JsonRpcId, message: string): void {
  respondError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, message, {
    recovery: { kind: "staleTurn", message, retryable: false },
  });
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  respondError(
    id,
    BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
    `Invalid params for ${method}`,
    issues,
  );
}

// ---------------------------------------------------------------------------
// Minted ids. Per-process entropy plus a monotonic counter, so ids never
// collide across bridge restarts or session resumes (#1224).
// ---------------------------------------------------------------------------

const instanceNonce = randomUUID().replaceAll("-", "").slice(0, 12);
let turnCounter = 0;

function mintTurnId(): string {
  turnCounter += 1;
  return `turn_agy_${instanceNonce}_${turnCounter}`;
}

const ZERO_USAGE: ThreadEventTokenUsageBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

function toBreakdown(usage: AgyUsage): ThreadEventTokenUsageBreakdown {
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.thinkingTokens,
  };
}

/** agy reports cumulative session usage; bb wants this turn's slice too. */
function subtractUsage(
  total: ThreadEventTokenUsageBreakdown,
  previous: ThreadEventTokenUsageBreakdown,
): ThreadEventTokenUsageBreakdown {
  const nonNegative = (value: number): number => (value > 0 ? value : 0);
  return {
    totalTokens: nonNegative(total.totalTokens - previous.totalTokens),
    inputTokens: nonNegative(total.inputTokens - previous.inputTokens),
    cachedInputTokens: nonNegative(
      total.cachedInputTokens - previous.cachedInputTokens,
    ),
    outputTokens: nonNegative(total.outputTokens - previous.outputTokens),
    reasoningOutputTokens: nonNegative(
      total.reasoningOutputTokens - previous.reasoningOutputTokens,
    ),
  };
}

// ---------------------------------------------------------------------------
// Sessions and turns
// ---------------------------------------------------------------------------

interface OpenItem {
  itemId: string;
  text: string;
}

interface Turn {
  turnId: string;
  /** Absent for the first turn carried on thread/start. */
  clientRequestId: string | undefined;
  prompt: string;
  /** Emitted once the turn reaches the head of the queue. */
  started: boolean;
  /** agy step_index → the assistant-message item that step streams into. */
  items: Map<number, OpenItem>;
  itemOrdinal: number;
  /**
   * Tool-step errors seen in this turn, verbatim. agy's `result.error` is the
   * last one of these even when the agent retried and finished the work, so
   * the set is what tells a recovered hiccup from a dead turn.
   */
  toolErrors: Set<string>;
  /** A tool step settled after one of `toolErrors` — the agent recovered. */
  toolRecovered: boolean;
  /**
   * How many times this turn was re-driven after agy refused a `write_to_file`
   * as an artifact write (see ARTIFACT_PATH_REFUSAL).
   */
  artifactRetries: number;
  /**
   * The turn streamed assistant text. An artifact refusal on a turn that
   * answered is agy talking about one rejected tool call, not about the turn.
   */
  producedText: boolean;
  /**
   * The turn's agent_response step ran to DONE with text on the wire. A
   * `result` whose status is ERROR on top of a completed reply is agy's
   * conversation-level baggage (the quota-rejection text it re-attaches to
   * every later turn, reproduced live on conversation 44069b14), not a dead
   * turn: the content actually streamed, so the turn settles completed on it.
   * A turn whose reply never completed still fails honestly.
   */
  responseCompleted: boolean;
}

/** What a child was spawned with, kept so a dead one can be rebuilt. */
interface SpawnConfig {
  model: string | undefined;
  reasoningLevel: string | undefined;
  envVars: Record<string, string> | undefined;
}

interface Session {
  threadId: string;
  /** agy's conversation id; null until the child's `init` event arrives. */
  providerThreadId: string | null;
  cwd: string;
  child: ChildProcessWithoutNullStreams | null;
  /** Bumped on every child construction; stale callbacks check it (#1402). */
  generation: number;
  /**
   * Whether the CURRENT child has announced itself (`thread/identity` +
   * `session.reset`). Cleared by every child construction, including a
   * rebuild onto the same conversation: the id may be unchanged, but the
   * provider session behind it is new, and the runtime's assembler keeps
   * item/turn maps and open streams until the reset says otherwise. Nothing
   * from a child may be emitted before its own announcement.
   */
  identityAnnounced: boolean;
  /** agy runs one turn per stdin line, in order, so a FIFO is exact. */
  turns: Turn[];
  usageTotal: ThreadEventTokenUsageBreakdown;
  /** Turn text waiting for the child's `init`. */
  pending: Turn[];
  /** Resolved once `init` names the conversation, or the child dies first. */
  identityWaiters: ((providerThreadId: string | null) => void)[];
  stopping: boolean;
  spawnConfig: SpawnConfig;
  /** Why the child died, so a rejected thread/start can say what happened. */
  lastFailure: string | null;
  /** agy's own last words, which usually name the real cause. */
  lastStderr: string | null;
  /**
   * The last error text surfaced to the thread as a `provider.error`, so a
   * tool error, an ERROR result and a stderr banner all carrying the same
   * message do not become three identical error rows. Reset on every
   * `turn.open` so a genuinely new occurrence on a later turn still shows.
   */
  lastReportedError: string | null;
  /**
   * The last result settled this session's live turn as failed (turned
   * boundary "failed" with the parsed message). A non-zero child exit right
   * after that — in the immediate-reject shapes agy's own ERROR result is
   * precisely what makes it exit 1 — is the tail of that already-explained
   * failure, not a new one, so the raw `agy exited (code 1, signal null)`
   * banner is suppressed instead of layered over the actionable text.
   */
  lastTurnFailed: boolean;
  /**
   * Whether the thread currently shows agy's quota as blocked via
   * `provider/rateLimits/updated`. Cleared by a later turn settling
   * completed, so the reader sees the window reopen instead of a stale
   * block that never goes away.
   */
  rateLimitsBlocked: boolean;
  /**
   * Set once this conversation has produced an artifact-shaped
   * `write_to_file`; every later turn then carries WRITE_GUARDRAIL so the
   * model does not repeat it. Off by default: a session that never hit the
   * bug pays nothing and is never told about a field it was not using.
   */
  writeGuardrail: boolean;
  /**
   * How many quota auto-retries this session has already run. Reset when a
   * turn plainly completes, so one burnt window does not spend the budget of
   * the next one.
   */
  autoRetryCount: number;
  /**
   * The pending quota-retry timer, while one is scheduled. While it is set
   * the failed turn is already settled, a retry turn waits in `pending`, and
   * the session is between children: no raw exit banner may fire, no new
   * turn may spawn a child into the still-dead window, and stopping the
   * thread clears it.
   */
  autoRetryTimer: NodeJS.Timeout | null;
  /**
   * The pool account this session is pinned to, or null when the pool is
   * empty/disabled and the session runs on the relay home or the real one.
   * Sticky for the session's lifetime: a conversation belongs to the account
   * that created it, so only an explicit quota rotation moves it.
   */
  accountLabel: string | null;
  /**
   * Set when the queued quota retry re-runs on a DIFFERENT account: the
   * conversation cannot follow, so the wake rebuilds without
   * `--conversation` and announces the replacement with `contextLost: true`.
   */
  retryFreshConversation: boolean;
  /**
   * Last time the session did anything (a turn arrived, a result settled,
   * the child announced itself). The idle sweep releases children that have
   * been idle past AGY_IDLE_KILL_MS — the conversation stays on disk and
   * the next turn rebuilds the child against it, opencode-style.
   */
  lastActivityAt: number;
}

const sessions = new Map<string, Session>();

function emitDeltas(session: Session, ...deltas: ThreadDelta[]): void {
  notify(THREAD_DELTA_NOTIFICATION_METHOD, {
    threadId: session.threadId,
    deltas,
  });
}

function providerRaw(
  session: Session,
  coverage: "noise" | "unknown",
  payload: unknown,
): void {
  notify(BRIDGE_NOTIFICATION_METHODS.providerRaw, {
    threadId: session.threadId,
    coverage,
    payload,
  });
}

/**
 * agy reports real failures in far more places than its `result.error`: a
 * backend rejection (quota, auth, overload) shows up as a failed `tool` step,
 * a stderr banner, a turn-less ERROR result before `init`, or even a stdout
 * line that is not JSON at all. Each channel used to be handled only for its
 * own bookkeeping — a tool error was remembered, stderr was logged, a null
 * status was dropped as noise — so the reader of the thread could end up with
 * nothing but a failed turn and no idea why. This is the single path that
 * turns error text from ANY of those channels into a thread-visible
 * `provider.error`. It is thread-scoped (it never touches turn accounting),
 * dedupes the same text within one turn, and honours the dialect's own rule
 * that nothing may be emitted before the child announced its identity — until
 * then the text has already been recorded on the session, which is what the
 * `thread/start` / `thread/resume` error path surfaces.
 */
const ACTIONABLE_ERROR =
  /(?:error|fail|quota|limit|exceed|overload|unavail|busy|refus|denied|denial|reject|reset|resets in|unexpected|invalid|401|403|429|resource exhausted|⚠)/iu;

/** Lines agy prints while it is still running normally, not failures. */
const BENIGN_STDERR = /^warning[: ]/iu;

function classifyError(message: string):
  | "rate-limit"
  | "unauthorized"
  | "billing"
  | "overloaded"
  | undefined {
  const text = message.toLowerCase();
  if (
    /\bquota\b|rate.?limit|resets? in|resource exhausted|\b429\b|try again later/u.test(
      text,
    )
  ) {
    return "rate-limit";
  }
  if (
    /unauthori|not authorized|sign in|logged in|login|\b401\b|\b403\b|token/u.test(
      text,
    )
  ) {
    return "unauthorized";
  }
  if (
    /upgrade your subscription|increase your limits|billing|payment|credits?/u.test(
      text,
    )
  ) {
    return "billing";
  }
  if (/overloaded|busy|temporar|degenerat|can't satisfy|no capacity/u.test(text)) {
    return "overloaded";
  }
  return undefined;
}

/** The HTTP code bb's native `errorInfo` can hang on a classified message. */
function httpStatusCodeFor(
  category: ReturnType<typeof classifyError>,
): number | null {
  switch (category) {
    case "rate-limit":
      return 429;
    case "unauthorized":
      return 401;
    case "billing":
      return 402;
    case "overloaded":
      return 503;
    default:
      return null;
  }
}

/** The native `errorInfo` a provider.error should carry, when it can. */
function nativeErrorInfo(
  message: string,
): Extract<ThreadDelta, { kind: "provider.error" }>["errorInfo"] {
  const category = classifyError(message);
  if (category === undefined) {
    return undefined;
  }
  return {
    category,
    providerCode: null,
    httpStatusCode: httpStatusCodeFor(category),
  };
}

/**
 * agy's quota messages say when the window reopens: "Resets in 1h13m29s.",
 * "Resets in 47m42s.", "Resets in 8m11s.". bb's native rate-limit snapshot
 * takes that as a clock time.
 */
const RESETS_IN = /resets? in (?:(\d+)h)?(?:(\d+)m)?(\d+)s?\b/iu;

function quotaResetAtMs(message: string): number | null {
  const m = RESETS_IN.exec(message);
  if (m === null) {
    return null;
  }
  const h = m[1] === undefined ? 0 : Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const s = Number(m[3]);
  if (h === 0 && min === 0 && s === 0) {
    return null;
  }
  return Date.now() + (h * 3600 + min * 60 + s) * 1000;
}

/**
 * Tell bb natively that agy's quota is spent. The runtime stores
 * `provider/rateLimits/updated` as thread state (latest snapshot wins) —
 * that is what makes the provider read as "blocked by a subscription window
 * until T" instead of just carrying an error string with nothing to key off.
 * The blocked label is cleared (see clearRateLimit) once a turn plainly
 * succeeds again.
 */
function emitRateLimitBlocked(session: Session, message: string): void {
  session.rateLimitsBlocked = true;
  emitDeltas(session, {
    kind: "provider.rateLimits",
    rateLimits: {
      providerId: "agy",
      status: "blocked",
      kind: "subscription-window",
      windows: [
        {
          providerKey: null,
          label: "Gemini individual quota",
          status: "blocked",
          resetsAtMs: quotaResetAtMs(message),
        },
      ],
      reachedReason: message,
      overageStatus: null,
      overageReason: null,
    },
  });
}

/** Clear the blocked snapshot once the account is plainly working again. */
function clearRateLimit(session: Session): void {
  if (!session.rateLimitsBlocked) {
    return;
  }
  session.rateLimitsBlocked = false;
  emitDeltas(session, {
    kind: "provider.rateLimits",
    rateLimits: {
      providerId: "agy",
      status: "allowed",
      kind: "subscription-window",
      windows: [
        {
          providerKey: null,
          label: "Gemini individual quota",
          status: "allowed",
          resetsAtMs: null,
        },
      ],
      reachedReason: null,
      overageStatus: null,
      overageReason: null,
    },
  });
}

/** Surface classification only after identity; nothing pre-identity may go out. */
function maybeEmitRateLimitBlocked(session: Session, message: string): void {
  if (session.providerThreadId === null || !session.identityAnnounced) {
    return;
  }
  if (classifyError(message) === "rate-limit") {
    emitRateLimitBlocked(session, message);
  }
}

// ---------------------------------------------------------------------------
// Quota auto-retry
// ---------------------------------------------------------------------------

/** Land this long after the stated reset, so the reopened window is real. */
const QUOTA_RETRY_JITTER_MS = 5_000;
/**
 * agy's individual window runs about 50 minutes ("Resets in 49m10s"); a wait
 * past this cap fails the turn the old way instead of holding the thread for
 * a window nobody asked to sit through. `AGY_AUTO_RETRY_MAX_WAIT_MS` overrides.
 */
const DEFAULT_QUOTA_RETRY_MAX_WAIT_MS = 3_300_000;
/** Retries per session (not per turn); `AGY_AUTO_RETRY_MAX` overrides. */
const DEFAULT_QUOTA_RETRY_MAX = 2;

function quotaRetryMaxAttempts(): number {
  const raw = Number(process.env.AGY_AUTO_RETRY_MAX);
  return Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_QUOTA_RETRY_MAX;
}

function quotaRetryMaxWaitMs(): number {
  const raw = Number(process.env.AGY_AUTO_RETRY_MAX_WAIT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_QUOTA_RETRY_MAX_WAIT_MS;
}

function clearQuotaRetryTimer(session: Session): void {
  if (session.autoRetryTimer !== null) {
    clearTimeout(session.autoRetryTimer);
    session.autoRetryTimer = null;
  }
}

/**
 * A dead quota does not have to end the thread's work. When agy names the
 * minute the window reopens and that minute is close enough, a retry turn
 * carrying the same prompt is queued behind a timer. Call this after the
 * failed turn has been settled: the reader keeps the honest failure (the
 * quota text and the blocked snapshot), and the retry runs later as its own
 * turn. When the timer fires, the child is rebuilt against the same
 * conversation — the standard rebuild path — and the retry turn re-runs on
 * it as an ordinary first-turn-shaped turn (no input/accepted: the original
 * input was accepted once, on the turn that failed).
 *
 * Returns true when the retry was queued.
 */
function scheduleQuotaRetry(
  session: Session,
  failedTurn: Turn,
  message: string,
): boolean {
  if (classifyError(message) !== "rate-limit") {
    return false;
  }
  const resetAtMs = quotaResetAtMs(message);
  if (resetAtMs === null) {
    return false;
  }
  // Pool first: cool the burnt account down and, when a sibling is healthy,
  // rotate to it NOW — sitting out the window is only for a pool with
  // nothing left. A rotation starts a fresh conversation: the old one
  // belongs to the burnt account and cannot follow.
  let switchTo: AccountHome | null = null;
  if (
    cliproxyRelayDataDir !== null &&
    accountsEnabled(process.env) &&
    session.accountLabel !== null
  ) {
    const ledger = loadLedger(cliproxyRelayDataDir);
    markAccountCooldown(
      ledger,
      session.accountLabel,
      resetAtMs + QUOTA_RETRY_JITTER_MS,
      message,
    );
    const accounts = listAccounts(cliproxyRelayDataDir);
    const candidate = pickAccount(ledger, accounts, session.accountLabel);
    if (
      candidate !== null &&
      (ledger.accounts[candidate.label]?.cooldownUntilMs ?? 0) <= Date.now()
    ) {
      switchTo = candidate;
    }
    saveLedger(cliproxyRelayDataDir, ledger);
  }
  const maxAttempts = quotaRetryMaxAttempts();
  if (switchTo === null && session.autoRetryCount >= maxAttempts) {
    log(
      `turn ${failedTurn.turnId}: quota retry budget spent (${session.autoRetryCount}/${maxAttempts}); failing`,
    );
    return false;
  }
  const waitMs =
    switchTo !== null
      ? 1_000
      : Math.max(resetAtMs + QUOTA_RETRY_JITTER_MS - Date.now(), 1_000);
  if (waitMs > quotaRetryMaxWaitMs()) {
    log(
      `turn ${failedTurn.turnId}: quota reopens in ${Math.round(waitMs / 1000)}s, past the ${Math.round(quotaRetryMaxWaitMs() / 1000)}s auto-retry cap; failing`,
    );
    return false;
  }
  // The budget counts WINDOW WAITS, not rotations: a rotation is bounded by
  // the pool itself (each switch cools one account) and should never be
  // throttled by a counter meant for sitting on one's hands.
  if (switchTo === null) {
    session.autoRetryCount += 1;
  }
  const retryTurn = createTurn({
    prompt: failedTurn.prompt,
    clientRequestId: undefined,
  });
  session.pending.push(retryTurn);
  // Turns already queued behind the failed one ride the same closed window:
  // move them into `pending` so the wake re-runs everything in order on the
  // rebuilt child, instead of writing them into a child that is mid-exit.
  while (session.turns.length > 0) {
    session.pending.push(session.turns.shift() as Turn);
  }
  if (switchTo !== null) {
    session.accountLabel = switchTo.label;
    session.retryFreshConversation = true;
  }
  const attempt = session.autoRetryCount;
  session.autoRetryTimer = setTimeout(() => {
    wakeQuotaRetry(session, attempt, waitMs, switchTo !== null);
  }, waitMs);
  session.autoRetryTimer.unref();
  log(
    switchTo !== null
      ? `turn ${failedTurn.turnId}: quota on the session's account; rotating to account ${switchTo.label} in ${Math.round(waitMs / 1000)}s (turn ${retryTurn.turnId}, fresh conversation)`
      : `turn ${failedTurn.turnId}: quota until ${new Date(resetAtMs).toISOString()}; ` +
        `retry ${attempt}/${maxAttempts} queued as turn ${retryTurn.turnId} in ${Math.round(waitMs / 1000)}s`,
  );
  return true;
}

/** The window reopened (or a sibling account took over): rebuild the child
 * and let `drainPending` run the queued retry turn plus anything behind it. */
function wakeQuotaRetry(
  session: Session,
  attempt: number,
  waitMs: number,
  freshConversation: boolean,
): void {
  session.autoRetryTimer = null;
  // The session may have been stopped, or replaced by a fresh thread/start,
  // while the timer slept; a stale wake owns nothing.
  if (sessions.get(session.threadId) !== session) {
    return;
  }
  if (session.stopping || session.providerThreadId === null) {
    return;
  }
  if (session.pending.length === 0) {
    return;
  }
  log(
    freshConversation
      ? `quota retry ${attempt}: rotating to account ${session.accountLabel ?? "?"} after ${Math.round(waitMs / 1000)}s; rebuilding agy for thread ${session.threadId} on a fresh conversation`
      : `quota retry ${attempt}: window reopened after ${Math.round(waitMs / 1000)}s; rebuilding agy for thread ${session.threadId}`,
  );
  notify(BRIDGE_NOTIFICATION_METHODS.sessionReplaced, {
    threadId: session.threadId,
    providerThreadId: session.providerThreadId,
    reason: freshConversation
      ? "the quota window closed on this account; the turn is being re-run on another account, so the conversation context does not carry over"
      : "the quota window reopened; the turn is being re-run on the resumed conversation",
    contextLost: freshConversation,
  });
  startChild({
    session,
    model: session.spawnConfig.model,
    reasoningLevel: session.spawnConfig.reasoningLevel,
    conversationId: freshConversation ? undefined : session.providerThreadId,
    envVars: session.spawnConfig.envVars,
  });
}

function reportError(
  session: Session,
  message: string,
  source: string,
): void {
  // agy may paint its banner with ANSI SGR colours even off a tty; the thread
  // should see the words, not the paint.
  const text = message.replace(/\u001b\[[0-9;]*m/gu, "").trim();
  if (text.length === 0) {
    return;
  }
  // agy's own stream-input warnings are it explaining its own protocol back
  // to us; they live in the bridge log, not the thread.
  if (BENIGN_STDERR.test(text)) {
    log(`stderr (${session.threadId}) is process chatter, not a thread error: ${text}`);
    return;
  }
  if (!ACTIONABLE_ERROR.test(text)) {
    return;
  }
  // Identity first: the runtime drops anything emitted before the child
  // announced itself (threadIdentity + session.reset). Until then the text
  // has already been recorded on the session and reaches the thread through
  // the start/resume reply instead.
  if (session.providerThreadId === null || !session.identityAnnounced) {
    return;
  }
  if (session.lastReportedError === text) {
    return;
  }
  session.lastReportedError = text;
  const category = classifyError(text);
  log(
    `reporting error from ${source} for thread ${session.threadId}: ${text}`,
  );
  emitDeltas(session, {
    kind: "provider.error",
    message: text,
    threadScoped: true,
    ...(category === undefined
      ? {}
      : {
          category,
          errorInfo: {
            category,
            providerCode: null,
            httpStatusCode: httpStatusCodeFor(category),
          },
        }),
  });
  maybeEmitRateLimitBlocked(session, text);
}

function promptText(input: readonly PromptInput[]): string {
  const parts: string[] = [];
  for (const item of input) {
    if (item.type === "text") {
      parts.push(item.text);
      continue;
    }
    // agy's stream-json input carries text only; a path is the most useful
    // thing we can say about an attachment without inventing a shape.
    if (item.type === "localImage" || item.type === "localFile") {
      parts.push(item.path);
      continue;
    }
    if (item.type === "image") {
      parts.push(item.url);
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cliproxy relay mode
// ---------------------------------------------------------------------------

/**
 * When an agent-proxy core (CLIProxyAPI) is reachable, the child does not have
 * to talk to Antigravity with its own single HOME credential: agy runs in its
 * Gemini-API mode pointed at the local core, and the CORE owns the accounts
 * (its auth dir), the rotation, the quota cooldowns and the per-credential
 * `proxy_url` egress — many accounts, many IPs, nothing keyed to this HOME.
 *
 * Detection, in order: `AGY_CLIPROXY=0` forces direct mode; `AGY_CLIPROXY_API_KEY`
 * names the key outright; otherwise the agent-proxy plugin's managed config
 * (`~/.bb/plugins/agent-proxy/core/config.yaml`, the only place its local API
 * keys live) is read for its first `api-keys:` entry. Resolved once at start.
 */
interface CliproxyRelay {
  baseUrl: string;
  apiKey: string;
  home: string;
}

let cliproxyRelayDataDir: string | null = null;
let cliproxyRelay: CliproxyRelay | null = null;
let cliproxyRelaySignature = "";

function firstListedApiKey(yaml: string): string | null {
  const m = /^api-keys?:\s*\n\s*-\s+(\S+)/m.exec(yaml);
  return m === null ? null : (m[1] ?? null);
}

function resolveCliproxyRelay(dataDir: string): CliproxyRelay | null {
  if (process.env.AGY_CLIPROXY === "0") {
    return null;
  }
  const baseUrl = (
    process.env.AGY_CLIPROXY_URL ?? "http://127.0.0.1:8317"
  ).replace(/\/+$/u, "");
  let apiKey = process.env.AGY_CLIPROXY_API_KEY;
  if ((apiKey ?? "").length === 0) {
    apiKey = undefined;
    const managedConfig = join(
      process.env.HOME ?? "",
      ".bb",
      "plugins",
      "agent-proxy",
      "core",
      "config.yaml",
    );
    try {
      const yaml = readFileSync(managedConfig, "utf8");
      apiKey = firstListedApiKey(yaml) ?? undefined;
    } catch {
      return null;
    }
  }
  if ((apiKey ?? "").length === 0) {
    return null;
  }
  // agy reads its provider switch from the HOME-scoped settings file; the
  // relay home carries nothing else — no token, nothing to rotate.
  const home = join(dataDir, "cliproxy-home");
  const settingsDir = join(home, ".gemini", "antigravity-cli");
  try {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      `${JSON.stringify({ modelProvider: "gemini" })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    return null;
  }
  return { baseUrl, apiKey: apiKey as string, home };
}

/** The relay env laid over a child's environment, or nothing in direct mode.
 * Re-resolved per spawn: a key added to the managed config, or the
 * AGY_CLIPROXY=0 kill switch, reaches new children without a plugin reload. */
function cliproxyChildEnvOverlay(): Record<string, string> {
  if (cliproxyRelayDataDir === null) {
    return {};
  }
  const relay = resolveCliproxyRelay(cliproxyRelayDataDir);
  const signature = relay === null ? "off" : `${relay.baseUrl}:${relay.home}`;
  if (signature !== cliproxyRelaySignature) {
    log(
      relay === null
        ? "cliproxy relay off: direct Antigravity mode"
        : `cliproxy relay on: ${relay.baseUrl}`,
    );
    cliproxyRelaySignature = signature;
  }
  cliproxyRelay = relay;
  if (relay === null) {
    return {};
  }
  return {
    HOME: relay.home,
    GEMINI_API_KEY: relay.apiKey,
    GOOGLE_GEMINI_BASE_URL: relay.baseUrl,
  };
}

/**
 * The account-pool overlay, and the first word on where a child lives: when
 * the pool has accounts, every session is pinned to one and runs agy as a
 * native Antigravity install in that account's own HOME — its own token, its
 * own installation id, its own egress (`HTTPS_PROXY` from the account's
 * `proxy` file). Only when the pool yields nothing do the cliproxy relay and
 * then the real HOME get their turn. `AGY_ACCOUNTS=0` skips the pool.
 */
function childEnvOverlay(session: Session): Record<string, string> {
  if (cliproxyRelayDataDir !== null && accountsEnabled(process.env)) {
    const accounts = listAccounts(cliproxyRelayDataDir);
    if (accounts.length > 0) {
      if (session.accountLabel === null) {
        const ledger = loadLedger(cliproxyRelayDataDir);
        session.accountLabel = pickAccount(ledger, accounts)?.label ?? null;
      }
      const account = accountByLabel(accounts, session.accountLabel);
      if (account !== null) {
        const overlay: Record<string, string> = { HOME: account.home };
        if (account.proxy !== null) {
          overlay.HTTPS_PROXY = account.proxy;
          overlay.https_proxy = account.proxy;
          overlay.HTTP_PROXY = account.proxy;
          overlay.http_proxy = account.proxy;
        }
        return overlay;
      }
    }
  }
  return cliproxyChildEnvOverlay();
}

// ---------------------------------------------------------------------------
// The agy child
// ---------------------------------------------------------------------------

interface StartChildArgs {
  session: Session;
  model: string | undefined;
  reasoningLevel: string | undefined;
  conversationId: string | undefined;
  envVars: Record<string, string> | undefined;
}

function startChild(args: StartChildArgs): void {
  const { session } = args;
  session.spawnConfig = {
    model: args.model,
    reasoningLevel: args.reasoningLevel,
    envVars: args.envVars,
  };
  session.generation += 1;
  // A new provider session starts unannounced, and its usage baseline starts
  // at zero: agy counts tokens cumulatively per process, so a rebuilt child
  // counts from zero again and a carried-over baseline would clamp every
  // later turn's `last` to nothing. Both are the `session.reset` boundary.
  session.identityAnnounced = false;
  session.usageTotal = ZERO_USAGE;
  const generation = session.generation;
  const command = resolveAgyCommand(process.env);
  const spawnArgs = agySpawnArgs({
    model: args.model,
    reasoningLevel: args.reasoningLevel,
    conversationId: args.conversationId,
    // The thread's directory has to be named on the command line, not just
    // handed to spawn as cwd: agy's workspace comes from --add-dir alone.
    addDirs: [session.cwd],
  });
  // The child's environment is constructed, never implicitly inherited
  // (#1366, #1545): this process's env minus the runtime's own markers, plus
  // the session's declared passthrough.
  const env = withoutBridgeRuntimeEnv(process.env);
  for (const [key, value] of Object.entries(childEnvOverlay(session))) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(args.envVars ?? {})) {
    env[key] = value;
  }
  log(
    `spawning ${command} ${spawnArgs.map((a) => JSON.stringify(a)).join(" ")} (cwd ${session.cwd}, HOME ${env.HOME ?? "<unset>"}${session.accountLabel ? `, account ${session.accountLabel}` : ""})`,
  );
  const child = spawn(command, spawnArgs, {
    cwd: session.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  session.child = child;

  let stdoutTail = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (session.generation !== generation) {
      return;
    }
    stdoutTail += chunk;
    for (;;) {
      const newline = stdoutTail.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = stdoutTail.slice(0, newline).trim();
      stdoutTail = stdoutTail.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      handleAgyLine(session, generation, line);
    }
  });

  // agy's stderr is where its banners live (the ⚠ quota notice, auth
  // failures, API rejections) and "data" can split them across chunks, so it
  // is reassembled line by line: the last complete line becomes the session's
  // last words for the exit message, and every error-looking line is also
  // surfaced to the thread as a scoped provider.error, not just logged.
  child.stderr.setEncoding("utf8");
  let stderrTail = "";
  child.stderr.on("data", (chunk: string) => {
    if (session.generation !== generation) {
      return;
    }
    stderrTail += chunk;
    for (;;) {
      const newline = stderrTail.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = stderrTail.slice(0, newline).trim();
      stderrTail = stderrTail.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      session.lastStderr = line.slice(0, 2000);
      log(`agy stderr (${session.threadId}): ${line}`);
      reportError(session, line, "agy stderr");
    }
    // A trailing line with no newline is kept for the exit message even
    // though it never completes on its own.
    if (stderrTail.trim().length > 0) {
      session.lastStderr = stderrTail.slice(0, 2000);
    }
  });

  child.on("error", (error: Error) => {
    if (session.generation !== generation) {
      return;
    }
    failSession(session, `agy could not be started: ${error.message}`);
  });

  // Finalize on close, not exit: exit can fire while stdout still holds the
  // lines that explain why the turn ended (#1402).
  child.on("close", (code, signal) => {
    if (session.generation !== generation) {
      return;
    }
    session.child = null;
    if (session.stopping) {
      return;
    }
    if (session.autoRetryTimer !== null) {
      // A quota retry owns the story now: the failed turn is settled, the
      // retry turn is queued, and the code-1 exit is the quota tail this
      // feature exists to sit out. Neither the raw exit banner nor a session
      // failure may land on work that is scheduled, not lost.
      return;
    }
    const detail = session.lastStderr === null ? "" : `: ${session.lastStderr}`;
    const message = `agy exited (code ${String(code)}, signal ${String(
      signal,
    )})${detail}`;
    const explained =
      code !== 0 &&
      session.lastTurnFailed &&
      session.lastReportedError !== null &&
      session.lastReportedError !== message;
    failSession(session, message, { surfaceError: !explained });
  });
}

/**
 * The child is gone or unusable: settle everything in flight as failed so no
 * accepted turn is left without a terminal state, then release identity
 * waiters so a pending thread/start cannot hang.
 *
 * `surfaceError: false` skips the provider.error delta but still records the
 * failure and settles turns: used when the exit that triggered this was the
 * ordinary tail of a turn that already failed with a parsed, surfaced message
 * (an ERROR result whose own text was delivered), so the raw exit would only
 * bury the actionable text in the reader's error list.
 */
function failSession(
  session: Session,
  message: string,
  opts: { surfaceError?: boolean } = {},
): void {
  const surfaceError = opts.surfaceError ?? true;
  log(`session ${session.threadId} failed: ${message}`);
  // A session failure is the verdict, whatever retry was pending: settle
  // everything failed (including the queued retry turn) and stop the timer.
  clearQuotaRetryTimer(session);
  session.lastFailure = message;
  if (surfaceError && session.providerThreadId !== null) {
    emitDeltas(session, {
      kind: "provider.error",
      message,
      threadScoped: true,
      ...(nativeErrorInfo(message) === undefined
        ? {}
        : { errorInfo: nativeErrorInfo(message) }),
    });
  }
  maybeEmitRateLimitBlocked(session, message);
  const turns = [...session.turns, ...session.pending];
  session.turns = [];
  session.pending = [];
  for (const turn of turns) {
    if (session.providerThreadId === null) {
      continue;
    }
    if (!turn.started) {
      emitTurnStarted(session, turn);
    }
    closeOpenItems(session, turn);
    emitDeltas(session, {
      kind: "turn.boundary",
      providerTurnId: turn.turnId,
      status: "failed",
      error: { message },
    });
  }
  const waiters = session.identityWaiters;
  session.identityWaiters = [];
  for (const waiter of waiters) {
    waiter(session.providerThreadId);
  }
}

// ---------------------------------------------------------------------------
// agy dialect → bb thread events
// ---------------------------------------------------------------------------

function handleAgyLine(
  session: Session,
  generation: number,
  line: string,
): void {
  const event = parseAgyLine(line);
  if (session.generation !== generation) {
    return;
  }
  switch (event.event) {
    case "init": {
      adoptIdentity(session, event.conversationId);
      return;
    }
    case "step_update": {
      handleStepUpdate(session, event);
      return;
    }
    case "result": {
      handleResult(session, event);
      return;
    }
    default: {
      // A line the dialect parser did not recognize is also the one place agy
      // reports a startup failure, so it is logged as well as forwarded.
      log(`agy said something unrecognized: ${JSON.stringify(event.payload).slice(0, 500)}`);
      if (
        typeof event.payload === "string" &&
        ACTIONABLE_ERROR.test(event.payload)
      ) {
        reportError(session, event.payload, "agy stdout");
      }
      providerRaw(session, "unknown", event.payload);
    }
  }
}

/**
 * Identity precedes traffic. A fresh session learns its id from `init`; a
 * resumed or rebuilt one confirms the id it already carried. Either way this
 * is the child's announcement, and it is made once per child: the id being
 * unchanged does not make the provider session behind it the same one, so a
 * rebuild resets the id space too. Only after it may the turns that were
 * waiting for a session to exist be drained.
 */
function adoptIdentity(session: Session, conversationId: string | null): void {
  if (conversationId === null) {
    return;
  }
  session.lastActivityAt = Date.now();
  const announce =
    !session.identityAnnounced || session.providerThreadId !== conversationId;
  session.providerThreadId = conversationId;
  if (announce) {
    session.identityAnnounced = true;
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: session.threadId,
      providerThreadId: conversationId,
      sessionRestorable: true,
    });
    emitDeltas(session, { kind: "session.reset" });
  }
  if (cliproxyRelayDataDir !== null && session.accountLabel !== null) {
    const ledger = loadLedger(cliproxyRelayDataDir);
    rememberConversation(ledger, conversationId, session.accountLabel);
    markAccountUse(ledger, session.accountLabel);
    saveLedger(cliproxyRelayDataDir, ledger);
  }
  const waiters = session.identityWaiters;
  session.identityWaiters = [];
  for (const waiter of waiters) {
    waiter(conversationId);
  }
  drainPending(session);
}

function drainPending(session: Session): void {
  if (session.providerThreadId === null || session.child === null) {
    return;
  }
  const pending = session.pending;
  session.pending = [];
  for (const turn of pending) {
    enqueueTurn(session, turn);
  }
}

function handleStepUpdate(
  session: Session,
  event: Extract<ReturnType<typeof parseAgyLine>, { event: "step_update" }>,
): void {
  const turn = session.turns[0];
  if (turn === undefined) {
    // A step with no accepted turn to hang it on: droppable diagnostics
    // rather than a fabricated turn (the protocol forbids inventing one).
    providerRaw(session, "noise", event);
    return;
  }
  const stepType = event.stepType ?? "";
  if (stepType !== "agent_response") {
    if (stepType === "tool") {
      // agy 1.1.19 reports a turn's last tool error as the turn's own error,
      // even when the model retried the call and the work landed (a
      // write_to_file whose first call comes back
      // "not a valid artifact path" and whose second call writes the file).
      // Remembering the tool errors and whether a later tool step settled is
      // what lets handleResult tell that apart from a turn that really died.
      if (event.state === "ERROR" && event.toolError !== null) {
        turn.toolErrors.add(event.toolError);
        // The error is recorded above for the recovered-step judgement and
        // surfaced here, so the reader sees a tool step fail even when the
        // turn itself recovers and settles completed.
        reportError(session, event.toolError, "agy tool step");
      } else if (event.state === "DONE" && turn.toolErrors.size > 0) {
        turn.toolRecovered = true;
      }
    }
    providerRaw(
      session,
      AGY_NOISE_STEP_TYPES.has(stepType) ? "noise" : "unknown",
      event,
    );
    return;
  }
  const stepIndex = event.stepIndex ?? 0;
  let item = turn.items.get(stepIndex);
  if (item === undefined) {
    turn.itemOrdinal += 1;
    item = { itemId: `${turn.turnId}_item_${turn.itemOrdinal}`, text: "" };
    turn.items.set(stepIndex, item);
    // Every item's first event is item/started — agy streams delta-first, so
    // the opening event is synthesized here.
    emitDeltas(session, {
      kind: "item.open",
      providerTurnId: turn.turnId,
      key: { providerItemId: item.itemId },
      item: { type: "agentMessage", text: "" },
    });
  }
  if (event.textDelta !== null && event.textDelta.length > 0) {
    turn.producedText = true;
    item.text += event.textDelta;
    emitDeltas(session, {
      kind: "item.textDelta",
      providerTurnId: turn.turnId,
      key: { providerItemId: item.itemId },
      channel: "agentMessage",
      text: event.textDelta,
    });
  }
  if (event.state === "DONE") {
    if (turn.producedText) {
      turn.responseCompleted = true;
    }
    emitDeltas(session, {
      kind: "item.close",
      providerTurnId: turn.turnId,
      key: { providerItemId: item.itemId },
      item: { type: "agentMessage", text: item.text },
      status: "completed",
    });
    turn.items.delete(stepIndex);
  }
}

function closeOpenItems(session: Session, turn: Turn): void {
  for (const [stepIndex, item] of [...turn.items]) {
    emitDeltas(session, {
      kind: "item.close",
      providerTurnId: turn.turnId,
      key: { providerItemId: item.itemId },
      item: { type: "agentMessage", text: item.text },
      status: "completed",
    });
    turn.items.delete(stepIndex);
  }
}

/**
 * agy's `write_to_file` is two tools behind one name. With
 * `TargetFile`/`CodeContent` it writes into the workspace; the moment the
 * model also emits `ArtifactMetadata`, agy's permission converter validates
 * `TargetFile` against the conversation's artifact directory and the turn dies
 * before the tool ever runs:
 *
 *   declaring permissions: cortex tool write_to_file: convert tool call for
 *   permissions: model output error: invalid tool call error (invalid_args)
 *   <project path> is not a valid artifact path; artifacts must be in
 *   ~/.gemini/antigravity-cli/brain/<conversation>/
 *
 * Confirmed on thread thr_54vswmyikz / conversation 693cd8c3: the refused call
 * carried `ArtifactMetadata` plus a perfectly good absolute `TargetFile` under
 * the project root, and the same model writes the same file happily when the
 * field is absent. It is not about `--add-dir`, the cwd, a worktree, or the
 * file being new — both were right in that thread. And the model does not
 * learn: three consecutive user turns produced the identical refusal.
 *
 * There is no back channel to fix the tool call, so the bridge does the only
 * thing it can: re-drive the turn with the field named, and keep naming it for
 * the rest of the session.
 */
const ARTIFACT_PATH_REFUSAL = /is not a valid artifact path/u;

/**
 * Re-drives per turn. One, not more: the re-drive exists to make the model
 * LOOK at the file, and measured against agy 1.1.19 the refusal comes back on
 * the re-drive too (the rejected call is replayed while permissions are
 * declared) even when the model answers correctly. A second re-drive buys
 * another refusal and another slice of the quota.
 */
const MAX_ARTIFACT_RETRIES = 1;

/**
 * Sent as its own turn to unstick a refused write.
 *
 * It leads with "check the file", not "write it again", because the refused
 * call is usually a duplicate: measured twice against agy 1.1.19 (files
 * Qux.tsx and Quux.tsx under a probe workspace), the model wrote the file
 * correctly and THEN emitted the artifact-shaped call that killed the turn —
 * the work was already on disk. Telling it to check first lets the turn finish
 * on the truth instead of rewriting a file that is already right, and it still
 * names the working call shape for the case where nothing landed.
 */
function writeRetryNudge(path: string | null): string {
  const target = path === null ? "the file it was writing" : path;
  return (
    `Your last write_to_file was rejected before it ran: the call carried an ` +
    `ArtifactMetadata field, so agy validated TargetFile against the artifact ` +
    `brain directory instead of the workspace. Look at ${target} on disk now. ` +
    `If it already has the content you intended, say so in one line and stop. ` +
    `If it does not, write it with write_to_file carrying only TargetFile, ` +
    `CodeContent, Overwrite and Description — no ArtifactMetadata — or with ` +
    `replace_file_content. Do not ask for confirmation.`
  );
}

/** The path agy named in the refusal, so the nudge can point at it. */
function artifactRefusalPath(message: string | null): string | null {
  const match = /(\S+) is not a valid artifact path/u.exec(message ?? "");
  return match?.[1] ?? null;
}

/** Prefixed to later turns of a session that already hit the refusal. */
const WRITE_GUARDRAIL =
  "[workspace rule] When you write files with write_to_file, never include " +
  "ArtifactMetadata: this session is editing a real workspace, and that field " +
  "makes agy reject the call as an artifact write.";

function isArtifactPathRefusal(message: string | null): boolean {
  return message !== null && ARTIFACT_PATH_REFUSAL.test(message);
}

/**
 * Put the refused turn back at the head of the queue and drive it again. The
 * turn keeps its id and its clientRequestId, so bb sees one turn that took a
 * little longer rather than a failure followed by a mystery turn.
 */
function retryArtifactRefusal(
  session: Session,
  turn: Turn,
  refusalPath: string | null,
): boolean {
  const child = session.child;
  if (child === null) {
    return false;
  }
  // Queued turns behind this one are safe: the bridge holds their text until
  // they reach the head (see enqueueTurn), so the nudge written now is the
  // only line agy has and it can only be matched against this turn.
  turn.artifactRetries += 1;
  session.writeGuardrail = true;
  session.turns.unshift(turn);
  log(
    `turn ${turn.turnId}: agy refused a write_to_file as an artifact write; ` +
      `re-driving it (attempt ${turn.artifactRetries} of ${MAX_ARTIFACT_RETRIES})`,
  );
  child.stdin.write(agyUserMessageLine(writeRetryNudge(refusalPath)));
  return true;
}

/** One `result` per input line: this bridge's turn boundary. */
function handleResult(
  session: Session,
  event: Extract<ReturnType<typeof parseAgyLine>, { event: "result" }>,
): void {
  session.lastActivityAt = Date.now();
  const turn = session.turns.shift();
  if (turn === undefined) {
    // agy reports a rejected session (a bad flag combination, a model it will
    // not run, a dead quota) as an ERROR result with an empty conversation id,
    // before any turn exists. Reporting that as droppable noise is how a dead
    // session looks healthy — it is a session failure and must say so. The
    // error may arrive with a status agy left null, so a present error alone
    // is enough to fail the session rather than vanish.
    if (
      event.error !== null ||
      (event.status !== null && event.status !== "SUCCESS")
    ) {
      failSession(
        session,
        event.error ??
          `agy refused the session (${event.status ?? "unknown status"})`,
      );
      return;
    }
    providerRaw(session, "noise", event);
    return;
  }
  if (!turn.started) {
    emitTurnStarted(session, turn);
  }
  closeOpenItems(session, turn);

  if (event.usage !== null) {
    // agy's result usage is cumulative for the conversation, so the running
    // total is what it reports and this turn's slice is the difference.
    const total = toBreakdown(event.usage);
    const last = subtractUsage(total, session.usageTotal);
    session.usageTotal = total;
    emitDeltas(session, {
      kind: "usage",
      providerTurnId: turn.turnId,
      total,
      last,
      modelContextWindow: null,
    });
  }

  // A non-SUCCESS status whose error is verbatim a tool error the agent then
  // recovered from is agy talking about a step, not about the turn: the turn
  // ran to its response and the files are on disk. Failing it would end the
  // thread on work that succeeded, so it settles as completed and the tool
  // error stays visible as the `provider/raw` step that carried it.
  //
  // agy 1.1.27 defect: once a conversation has been rejected for quota, the
  // CLI re-attaches THAT verbatim error -- frozen "Resets in X" and all -- to
  // the result of every later turn in the same conversation, even when the
  // model just answered (reproduced live on conversation 44069b14: its real
  // 1h13m29s quota text replayed over a "pong" that answered fine hours after
  // the window opened; the db shows the very first reject in that
  // conversation also landed only after several completed assistant items).
  // The discriminator is not the text but the reply: a turn whose agent
  // response ran to DONE streamed real content, and an ERROR result on top of
  // it is conversation baggage. Settling it completed on that content keeps
  // the thread alive; the model actually said its piece. A turn whose reply
  // never completed still fails honestly, new text or not.
  const staleResidue =
    event.error !== null &&
    turn.responseCompleted &&
    !turn.toolErrors.has(event.error) &&
    !isArtifactPathRefusal(event.error);
  const recovered =
    (event.error !== null &&
      turn.toolErrors.has(event.error) &&
      turn.toolRecovered) ||
    // An artifact refusal on a turn that streamed an answer: agy ran the turn
    // to its response and is reporting one rejected tool call as the turn's
    // status. Measured on agy 1.1.19 (conversation c1c61bae): the re-driven
    // turn answered "the file already contains the intended content", the file
    // on disk was correct, and the result still came back ERROR with this
    // refusal. Failing that kills a live thread over work that is done - and
    // it is what killed thr_54vswmyikz three turns running.
    (isArtifactPathRefusal(event.error) &&
      turn.producedText &&
      turn.artifactRetries > 0) ||
    // An ERROR result on top of a completed agent response: the reply
    // streamed, the error is agy's conversation baggage.
    staleResidue;
  const failed =
    event.status !== null && event.status !== "SUCCESS" && !recovered;
  if (
    failed &&
    isArtifactPathRefusal(event.error) &&
    turn.artifactRetries < MAX_ARTIFACT_RETRIES &&
    retryArtifactRefusal(session, turn, artifactRefusalPath(event.error))
  ) {
    // The turn is live again: no turn/completed, and the next `result`
    // settles it. Items opened before the refusal are already closed.
    return;
  }
  if (recovered) {
    log(
      staleResidue
        ? `turn ${turn.turnId}: agy tagged a completed reply's result as ` +
            `ERROR (${event.error ?? ""}); settling it as completed on the ` +
            `content that streamed`
        : `turn ${turn.turnId}: agy reported a recovered tool error as the turn's ` +
          `status; settling it as completed (${event.error ?? ""})`,
    );
  }
  if (failed) {
    let message = event.error ?? `agy turn ended with status ${
      event.status ?? "unknown"
    }`;
    if (isArtifactPathRefusal(event.error)) {
      // Only reachable when the turn produced no text at all: a turn that
      // answered settles as completed above.
      // Exhausted the re-drives. Say what happened in words the reader can
      // act on, and do not claim the work is undone: the refused call is
      // often a duplicate of a write that already landed.
      message +=
        ` — agy refused its own write_to_file call because the call carried` +
        ` an ArtifactMetadata field (an agy bug, not a permission and not a` +
        ` workspace problem). The bridge re-drove the turn and it still` +
        ` produced no answer. Check the file named above on disk: a write` +
        ` earlier in the same turn may have already landed.`;
    }
    // A failed turn whose message was already surfaced as a thread error
    // (a tool step or stderr banner carrying the same text) does not need a
    // second, turn-scoped copy of it: the boundary below still names the
    // error, and the reader has already been told once.
    const alreadyShown = message === session.lastReportedError;
    if (!alreadyShown) {
      session.lastReportedError = message;
      emitDeltas(session, {
        kind: "provider.error",
        providerTurnId: turn.turnId,
        message,
        settlesTurn: false,
        ...(nativeErrorInfo(message) === undefined
          ? {}
          : { errorInfo: nativeErrorInfo(message) }),
      });
    }
    maybeEmitRateLimitBlocked(session, message);
    emitDeltas(session, {
      kind: "turn.boundary",
      providerTurnId: turn.turnId,
      status: "failed",
      error: { message },
    });
    session.lastTurnFailed = true;
    // The failure is out; if agy named a near-enough reset, queue the same
    // prompt to re-run when the window reopens instead of leaving the thread
    // dead until a human retries it.
    scheduleQuotaRetry(session, turn, message);
  } else {
    emitDeltas(session, {
      kind: "turn.boundary",
      providerTurnId: turn.turnId,
      status: "completed",
    });
    session.lastTurnFailed = false;
    session.autoRetryCount = 0;
    clearRateLimit(session);
  }
  // The next queued turn is now the live one: it is announced and only now
  // handed to agy, so a queued turn (a steer, or a second turn/start) cannot
  // race the one that was running.
  const next = session.turns[0];
  if (next !== undefined && !next.started) {
    emitTurnStarted(session, next);
    writeTurn(session, next);
  }
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function emitTurnStarted(session: Session, turn: Turn): void {
  turn.started = true;
  // A new turn may legitimately meet the same quota notice again; the dedup
  // is a per-turn guard against three channels telling the same story, not a
  // lifetime mute.
  session.lastReportedError = null;
  session.lastTurnFailed = false;
  const deltas: ThreadDelta[] = [
    {
      kind: "turn.open",
      providerTurnId: turn.turnId,
    },
  ];
  if (turn.clientRequestId !== undefined) {
    deltas.push({
      kind: "input.accepted",
      clientRequestId: turn.clientRequestId,
      providerTurnId: turn.turnId,
    });
  }
  emitDeltas(session, ...deltas);
}

/**
 * Write one turn's text to the child. Called for the head of the queue only:
 * the bridge, not the child's stdin buffer, is what decides which turn is
 * live, so a queued turn's text is held here until the turn ahead of it
 * settles. That is what makes `steerMode: "queue"` exact rather than a bet on
 * how agy buffers its input.
 */
function writeTurn(session: Session, turn: Turn): void {
  const child = session.child;
  if (child === null) {
    return;
  }
  child.stdin.write(
    agyUserMessageLine(
      session.writeGuardrail
        ? `${WRITE_GUARDRAIL}\n\n${turn.prompt}`
        : turn.prompt,
    ),
  );
}

/**
 * Hand a turn to the child, or queue it. agy consumes one line per turn
 * strictly in order, so the queue position is the truth about which turn its
 * events belong to; only the head is announced as started and only the head
 * has been written.
 */
function enqueueTurn(session: Session, turn: Turn): void {
  session.lastActivityAt = Date.now();
  if (session.autoRetryTimer !== null) {
    // A quota retry is pending and owns the next child: queue behind it, so
    // the FIFO stays exact and no rebuild spawns a child into the window
    // that is still closed. The wake rebuild serves the whole queue.
    session.pending.push(turn);
    return;
  }
  if (session.child === null && session.providerThreadId !== null) {
    // The child died (agy crash, its own timeout, an OOM kill) but the
    // conversation is on disk. Rebuild it against the same conversation and
    // say so: a silent replacement is the #1268 incident. The notification
    // goes out before the spawn, so nothing the replacement says can precede
    // the announcement that it exists.
    log(`rebuilding agy child for thread ${session.threadId}`);
    notify(BRIDGE_NOTIFICATION_METHODS.sessionReplaced, {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      reason: "the agy process was gone and is being restarted",
      contextLost: false,
    });
    startChild({
      session,
      model: session.spawnConfig.model,
      reasoningLevel: session.spawnConfig.reasoningLevel,
      conversationId: session.providerThreadId,
      envVars: session.spawnConfig.envVars,
    });
  }
  const child = session.child;
  // A child that has not announced itself yet owns nothing: its turns wait in
  // `pending` until `init` brings `thread/identity` and `session.reset`, so a
  // turn is never opened in an id space the runtime is about to drop.
  if (
    child === null ||
    session.providerThreadId === null ||
    !session.identityAnnounced
  ) {
    session.pending.push(turn);
    return;
  }
  const wasIdle = session.turns.length === 0;
  session.turns.push(turn);
  if (wasIdle) {
    emitTurnStarted(session, turn);
    writeTurn(session, turn);
  }
}

function createTurn(args: {
  prompt: string;
  clientRequestId: string | undefined;
}): Turn {
  return {
    turnId: mintTurnId(),
    clientRequestId: args.clientRequestId,
    prompt: args.prompt,
    started: false,
    items: new Map(),
    itemOrdinal: 0,
    toolErrors: new Set<string>(),
    toolRecovered: false,
    artifactRetries: 0,
    producedText: false,
    responseCompleted: false,
  };
}

// ---------------------------------------------------------------------------
// Model list — agy 1.1.19 has no `--output-format json` on its subcommands
// (the changelog promises one; the binary rejects the flag), so the text
// listing is parsed. One malformed row drops that row, not the listing.
// ---------------------------------------------------------------------------

let cachedModels: { id: string; displayName: string }[] | null = null;

function listAgyModels(): Promise<{ id: string; displayName: string }[]> {
  if (cachedModels !== null) {
    return Promise.resolve(cachedModels);
  }
  return new Promise((resolve) => {
    const env = withoutBridgeRuntimeEnv(process.env);
    // The catalog is account-independent enough; whichever home the pool or
    // the relay offers first reads it, so a pooled host lists what its own
    // accounts can actually serve.
    if (cliproxyRelayDataDir !== null && accountsEnabled(process.env)) {
      const ledger = loadLedger(cliproxyRelayDataDir);
      const account = pickAccount(ledger, listAccounts(cliproxyRelayDataDir));
      if (account !== null) {
        env.HOME = account.home;
        if (account.proxy !== null) {
          env.HTTPS_PROXY = account.proxy;
          env.https_proxy = account.proxy;
        }
      }
    }
    if (env.HOME === process.env.HOME) {
      for (const [key, value] of Object.entries(cliproxyChildEnvOverlay())) {
        env[key] = value;
      }
    }
    const child = spawn(resolveAgyCommand(process.env), ["models"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const models = parseAgyModelsOutput(stdout);
      if (models.length > 0) {
        cachedModels = models;
      }
      resolve(models);
    });
  });
}

// ---------------------------------------------------------------------------
// Request handlers, keyed by the protocol's own method vocabulary so the
// dispatch table cannot drift from the schemas. A vocabulary method with no
// handler answers -32601, which is correct: this bridge advertises no
// capability that would make the runtime send one.
// ---------------------------------------------------------------------------

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    respondResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        // `agy --conversation <id>` re-attaches a released session.
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        // agy's stream-json carries no approval channel, so the bridge runs
        // it with permissions skipped and bb's runtime owns policy.
        approvalEnforcedBy: "runtime",
        grammarVersions: [
          THREAD_DELTA_GRAMMAR_V3,
          THREAD_DELTA_GRAMMAR_V3,
        ],
        steerMode: "queue",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    void listAgyModels().then((models) => {
      respondResult(id, {
        models: models.map((model, index) => ({
          id: model.id,
          model: model.id,
          displayName: model.displayName,
          description: "",
          // agy encodes effort in the model id itself (…-high/-medium/-low),
          // so there is no separate per-model reasoning ladder to report.
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: index === 0,
        })),
        selectedOnlyModels: [],
      });
    });
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadStart,
        parsed.error.issues,
      );
      return;
    }
    const data = parsed.data;
    const session: Session = {
      threadId: data.threadId,
      providerThreadId: null,
      cwd: data.cwd,
      child: null,
      generation: 0,
      identityAnnounced: false,
      turns: [],
      usageTotal: ZERO_USAGE,
      pending: [],
      identityWaiters: [],
      stopping: false,
      spawnConfig: {
        model: undefined,
        reasoningLevel: undefined,
        envVars: undefined,
      },
      lastFailure: null,
      lastStderr: null,
      lastReportedError: null,
      lastTurnFailed: false,
      rateLimitsBlocked: false,
      writeGuardrail: false,
      autoRetryCount: 0,
      autoRetryTimer: null,
      accountLabel: null,
      retryFreshConversation: false,
      lastActivityAt: Date.now(),
    };
    sessions.set(data.threadId, session);
    if (accountsEnabled(process.env) && cliproxyRelayDataDir !== null) {
      session.accountLabel =
        pickAccount(loadLedger(cliproxyRelayDataDir), listAccounts(cliproxyRelayDataDir))?.label ??
        null;
    }
    if (data.input !== undefined && data.input.length > 0) {
      // The first turn carries no clientRequestId — only turn/start and
      // turn/steer do — so it emits no turn/input/accepted.
      session.pending.push(
        createTurn({
          prompt: promptText(data.input),
          clientRequestId: undefined,
        }),
      );
    }
    startChild({
      session,
      model: data.options.model,
      reasoningLevel: data.options.reasoningLevel,
      conversationId: undefined,
      envVars: data.options.envVars,
    });
    // The response waits for agy's `init`: providerThreadId is required on it
    // and agy is the only thing that can name the conversation.
    awaitIdentity(session, (providerThreadId) => {
      if (providerThreadId === null) {
        sessions.delete(data.threadId);
        respondError(
          id,
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          session.lastFailure ??
            "agy did not report a conversation id within 60s",
        );
        return;
      }
      respondResult(id, { providerThreadId, sessionRestorable: true });
    });
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadResume,
        parsed.error.issues,
      );
      return;
    }
    const data = parsed.data;
    const session: Session = {
      threadId: data.threadId,
      providerThreadId: null,
      cwd: data.cwd,
      child: null,
      generation: 0,
      identityAnnounced: false,
      turns: [],
      usageTotal: ZERO_USAGE,
      pending: [],
      identityWaiters: [],
      stopping: false,
      spawnConfig: {
        model: undefined,
        reasoningLevel: undefined,
        envVars: undefined,
      },
      lastFailure: null,
      lastStderr: null,
      lastReportedError: null,
      lastTurnFailed: false,
      rateLimitsBlocked: false,
      writeGuardrail: false,
      autoRetryCount: 0,
      autoRetryTimer: null,
      accountLabel: null,
      retryFreshConversation: false,
      lastActivityAt: Date.now(),
    };
    sessions.set(data.threadId, session);
    if (cliproxyRelayDataDir !== null) {
      session.accountLabel = conversationAccount(
        loadLedger(cliproxyRelayDataDir),
        data.providerThreadId,
      );
    }
    startChild({
      session,
      model: data.options.model,
      reasoningLevel: data.options.reasoningLevel,
      conversationId: data.providerThreadId,
      envVars: data.options.envVars,
    });
    awaitIdentity(session, (providerThreadId) => {
      if (providerThreadId === null) {
        sessions.delete(data.threadId);
        respondError(
          id,
          BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
          `agy could not resume conversation ${data.providerThreadId}: ${
            session.lastFailure ?? "no conversation id within 60s"
          }`,
        );
        return;
      }
      respondResult(id, { providerThreadId, sessionRestorable: true });
    });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const data = parsed.data;
    const session = sessions.get(data.threadId);
    if (session === undefined) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `No session for thread ${data.threadId}; send thread/start or thread/resume first`,
      );
      return;
    }
    respondResult(id, {});
    enqueueTurn(
      session,
      createTurn({
        prompt: promptText(data.input),
        clientRequestId: data.clientRequestId,
      }),
    );
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    const data = parsed.data;
    const session = sessions.get(data.threadId);
    if (session === undefined) {
      // No session at all: the steer cannot be delivered and cannot be
      // queued, so it is stale by definition.
      refuseStaleSteer(
        id,
        `No session for thread ${data.threadId}; nothing to steer`,
      );
      return;
    }
    // A steer names the turn the client believes is running. If that turn has
    // already settled, the steer is about a turn that no longer exists: the
    // runtime drops it on the `staleTurn` hint rather than letting it land as
    // an answer to something else. A turn that is still queued counts as live
    // — two steers in a row are ordinary.
    const live =
      session.turns.some((queued) => queued.turnId === data.expectedTurnId) ||
      session.pending.some((queued) => queued.turnId === data.expectedTurnId);
    if (!live) {
      refuseStaleSteer(
        id,
        `turn ${data.expectedTurnId} is not live on thread ${data.threadId}`,
      );
      return;
    }
    // steerMode is `queue`: agy's stream-json cannot inject into a running
    // turn (each line IS a turn), so the steer is accepted and becomes the
    // next turn of this session. Refusing it here is what used to lose the
    // request outright (#PLUG-26); accepting it is what the declared
    // capability promises. The turn is announced (`turn.open` +
    // `input.accepted`) and handed to agy only when it reaches the head, so
    // the steer runs strictly after the turn it was aimed at.
    respondResult(id, {});
    log(
      `thread ${data.threadId}: steer for turn ${data.expectedTurnId} queued ` +
        `as the next turn`,
    );
    enqueueTurn(
      session,
      createTurn({
        prompt: promptText(data.input),
        clientRequestId: data.clientRequestId,
      }),
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const data = parsed.data;
    const session = sessions.get(data.threadId);
    if (session === undefined) {
      respondResult(id, {});
      return;
    }
    session.stopping = true;
    if (data.intent === "interrupt") {
      // Everything owed for this thread must be on the wire before the
      // response: the runtime detaches the thread the moment it is answered.
      const turns = [...session.turns, ...session.pending];
      session.turns = [];
      session.pending = [];
      for (const turn of turns) {
        if (session.providerThreadId === null) {
          continue;
        }
        if (!turn.started) {
          emitTurnStarted(session, turn);
        }
        closeOpenItems(session, turn);
        emitDeltas(session, {
          kind: "turn.boundary",
          providerTurnId: turn.turnId,
          status: "interrupted",
        });
      }
    }
    // `release` fabricates nothing (#1584): the session is simply detached.
    // The agy conversation stays on disk either way, so a later resume works.
    killChild(session);
    sessions.delete(data.threadId);
    respondResult(id, {});
  },
};

function killChild(session: Session): void {
  clearQuotaRetryTimer(session);
  const child = session.child;
  session.child = null;
  session.generation += 1;
  if (child === null) {
    return;
  }
  try {
    child.stdin.end();
  } catch {
    // The pipe may already be gone; the signal below is what matters.
  }
  child.kill("SIGTERM");
  const grace = setTimeout(() => {
    child.kill("SIGKILL");
  }, 3_000);
  grace.unref();
}

// ---------------------------------------------------------------------------
// Idle sweep — opencode-style: release the child after a quiet period, keep
// the session, rebuild on demand.
// ---------------------------------------------------------------------------

/**
 * Idle children cost ~200 MB of RSS each while doing nothing. After
 * AGY_IDLE_KILL_MS (default 30 minutes, 0 disables) without any turn, the
 * sweep SIGTERMs the child exactly like a thread stop would — but keeps the
 * session: the conversation is on disk, and the next `turn/start` hits the
 * ordinary rebuild path (session/replaced + identity + `--conversation`) and
 * continues as if nothing had slept. Busy sessions — turns queued, a retry
 * pending, a child still announcing itself — are skipped.
 */
const IDLE_SWEEP_INTERVAL_MS = 1_000;
const DEFAULT_IDLE_KILL_MS = 1_800_000;

function idleKillMs(): number {
  const raw = Number(process.env.AGY_IDLE_KILL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IDLE_KILL_MS;
}

function sweepIdleSessions(): void {
  const idleMs = idleKillMs();
  if (idleMs <= 0) {
    return;
  }
  const now = Date.now();
  for (const session of sessions.values()) {
    if (
      session.child === null ||
      session.stopping ||
      session.providerThreadId === null ||
      session.autoRetryTimer !== null ||
      session.turns.length > 0 ||
      session.pending.length > 0
    ) {
      continue;
    }
    if (now - session.lastActivityAt < idleMs) {
      continue;
    }
    log(
      `session ${session.threadId} idle for ${Math.round((now - session.lastActivityAt) / 1000)}s: ` +
        `releasing the agy child (conversation ${session.providerThreadId} stays; the next turn rebuilds it)`,
    );
    killChild(session);
  }
}

let idleSweep: NodeJS.Timeout | null = null;

function armIdleSweep(): void {
  if (idleSweep !== null) {
    return;
  }
  idleSweep = setInterval(sweepIdleSessions, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref();
}

function awaitIdentity(
  session: Session,
  settle: (providerThreadId: string | null) => void,
): void {
  if (session.providerThreadId !== null) {
    settle(session.providerThreadId);
    return;
  }
  let done = false;
  const once = (providerThreadId: string | null): void => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    settle(providerThreadId);
  };
  const timer = setTimeout(() => {
    once(session.providerThreadId);
  }, 60_000);
  timer.unref();
  session.identityWaiters.push(once);
}

// ---------------------------------------------------------------------------
// Line handling. Exported so a harness can drive the bridge in-process.
// ---------------------------------------------------------------------------

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    // A non-JSON line is ignored; the bridge stays alive.
    return;
  }
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return;
  }
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  // Request vs response is discriminated on the presence of `method`, never
  // on result shape: a response-shaped line is not treated as a request.
  if (typeof method !== "string") {
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    // Notification: unknown ones are ignored by design.
    return;
  }
  const handler = handlers[method];
  if (handler === undefined) {
    respondError(
      id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    );
    return;
  }
  try {
    handler(id, params);
  } catch (error) {
    // A throwing handler answers an error instead of taking the bridge down.
    respondError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function shutdown(): void {
  for (const session of sessions.values()) {
    session.stopping = true;
    killChild(session);
  }
  sessions.clear();
}

/**
 * The bridge surface the plugin's host artifact exports. The daemon-side
 * bootstrap imports the artifact, finds this export, and owns the process:
 * argv, the plugin-scoped directories, stdin framing, and signals. Importing
 * this module starts nothing.
 */
export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    logFile = join(context.dataDir, "bridge.log");
    cliproxyRelayDataDir = context.dataDir;
    armIdleSweep();
    const relayOn = Object.keys(cliproxyChildEnvOverlay()).length > 0;
    log(
      `bridge started for plugin ${context.pluginId}; agy=${resolveAgyCommand(
        process.env,
      )} HOME=${process.env.HOME ?? "<unset>"} PATH=${process.env.PATH ?? "<unset>"}${relayOn ? "" : "; direct mode"}`,
    );
  },
  onClose: shutdown,
  onSigterm: shutdown,
  onSigint: shutdown,
});
