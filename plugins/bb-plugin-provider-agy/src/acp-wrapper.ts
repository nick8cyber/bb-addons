/**
 * The `agy` ACP transport: `experimental_providerBridge` wrapped around the
 * SDK's `experimental_acpProviderBridge` (generic ACP bridge). The generic
 * bridge owns the ACP wire — initialize, session/new|load, session/prompt,
 * session/update translation, permissions, steer. This wrapper owns
 * everything proprietary the spec keeps on our side:
 *
 *   - account pool via `--gemini-dir <account-home>/.gemini` injected into
 *     each session's acpLaunchSpec (the only isolation flag; HOME untouched),
 *     proxy via launch env, sticky owner through accounts-state.json;
 *   - quota/eligibility rotation: the prompt error is suppressed so the
 *     daemon's turn stays open, a sibling session is synthesized
 *     (thread/start → sessionReplaced → handoff turn), and the queue of
 *     turns lives here because the generic queue does not survive a prompt
 *     failure;
 *   - usage per turn: the stdio shim (src/acp-shim.mjs) sniffs the
 *     session/prompt response on the private pipe into a side-channel file;
 *   - compaction fallback (ADR-0003), ArtifactMetadata guardrail+nudge,
 *     pending interaction resolution on session release, model list with
 *     effort mapping, permission-mode → session/set_mode via the shim.
 *
 * Boundary interception is bidirectional: inbound lines are rewritten and
 * delegated through `acpBridge.handleLine`, outbound lines are intercepted
 * by patching `process.stdout.write` (the SDK resolves it per call, so a
 * patch installed before the first write sees every byte the bridge emits).
 */
import { experimental_acpProviderBridge as acpBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { ACP_SHIM_SOURCE_B64 } from "./acp-shim-source.js";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_MODELS_TTL_MS,
  TOS_DISABLED_COOLDOWN_UNTIL_MS,
  accountByLabel,
  accountModelState,
  accountPriority,
  accountsEnabled,
  conversationAccount,
  checkIneligibleBreaker,
  hasVerificationRequest,
  ineligibleCooldownMs,
  isAccountIneligible,
  isAgentInterruptedMessage,
  isAgentQuotaMessage,
  isAgentValidationMessage,
  isAgentMarkerCandidate,
  isAuthDead,
  isModelRefusal,
  isTosDisabled,
  isValidationRequired,
  listAccounts,
  loadAccountModels,
  loadLedger,
  markAccountCooldown,
  markAccountIneligible,
  markAccountModelUnsupported,
  markAccountUse,
  pickAccount,
  rememberConversation,
  saveAccountModelRecord,
  saveLedger,
  type AccountHome,
  type AccountModelCatalog,
  type AccountsLedger,
} from "./accounts.js";
import {
  ARTIFACT_PATH_REFUSAL,
  COMPACT_SEED_MAX_ATTEMPTS,
  DEFAULT_QUOTA_COOLDOWN_MS,
  HANDOFF_STREAMED_TEXT_CAP,
  MAX_ARTIFACT_RETRIES,
  PROTECTED_CHILD_ENV,
  QUOTA_RETRY_JITTER_MS,
  WRITE_GUARDRAIL,
  ZERO_USAGE,
  acpUsageToBreakdown,
  artifactRefusalPath,
  buildQuotaHandoffPrompt,
  classifyError,
  compactFallbackEnabled,
  compactMemoPrompt,
  compactSeedPrompt,
  compactSummaryPrompt,
  contextWindowSize,
  nativeErrorInfo,
  quotaResetAtMs,
  quotaRetryMaxAttempts,
  quotaRetryMaxWaitMs,
  resolveCliproxyRelay,
  writeRetryNudge,
  type AcpUsage,
  type TokenBreakdown,
} from "./recovery.js";
import {
  fileTokenStorageEnv,
  parseAgyModelsOutput,
  resolveAgyCommand,
} from "./agy-cli.js";
import {
  INSTALL_NAME_RE,
  installsRegistry,
  registryLogLine,
  resolveInstall,
  type InstallResolution,
} from "./installs.js";

type JsonRpcId = string | number;
interface ProviderBridgeContext {
  pluginId: string;
  dataDir: string;
  tempDir: string;
}

// ---------------------------------------------------------------------------
// Parallel installs (provider-agy-installs): the registry at
// <dataDir>/agy-installs.json binds each account's `install` field to a
// binary — strictly, no substitution (§5).
// ---------------------------------------------------------------------------

/** One locally-unavailable warning per account per 5 minutes (§5 п.2). */
const installUnavailableLoggedAt = new Map<string, number>();

function noteInstallUnavailable(label: string, reason: string): void {
  const now = Date.now();
  if (now - (installUnavailableLoggedAt.get(label) ?? 0) < 5 * 60_000) {
    return;
  }
  installUnavailableLoggedAt.set(label, now);
  log(`account ${label} install unavailable on this host: ${reason}`);
}

/**
 * The §5 п.2 availability gate for pickAccount and the catalog paths: an
 * account whose install cannot run here is out, exactly like a parked one.
 * With no registry and no bindings this predicate costs one stat and
 * always passes — the no-registry path stays byte-identical.
 */
function locallyAvailable(ledger: AccountsLedger, label: string): boolean {
  if (dataDir === "") {
    return true;
  }
  const entry = Object.hasOwn(ledger.accounts, label)
    ? ledger.accounts[label]
    : undefined;
  const resolution = resolveInstall(dataDir, entry?.install);
  if (
    resolution.kind === "unavailable" ||
    resolution.kind === "broken"
  ) {
    noteInstallUnavailable(label, resolution.reason);
    return false;
  }
  return true;
}

/**
 * The install a session's binary comes from. `undefined` install means the
 * registry default (or the implicit resolveAgyCommand without a registry).
 */
function sessionInstall(session: WSession): InstallResolution {
  if (dataDir === "") {
    return { kind: "legacy" };
  }
  const install =
    session.accountLabel !== null
      ? (() => {
          const accounts = loadLedger(dataDir).accounts;
          return Object.hasOwn(accounts, session.accountLabel as string)
            ? accounts[session.accountLabel as string]?.install
            : undefined;
        })()
      : undefined;
  return resolveInstall(dataDir, install);
}

/**
 * The install name a journal line names (§9 п.2): the account's binding
 * when it is a valid name, else the registry default — or null outside
 * registry mode, where lines keep their old shape byte-for-byte.
 */
function installNameFor(label: string | null): string | null {
  if (dataDir === "") {
    return null;
  }
  const state = installsRegistry(dataDir);
  if (state.kind !== "ok") {
    return null;
  }
  if (label !== null) {
    const accounts = loadLedger(dataDir).accounts;
    const raw = Object.hasOwn(accounts, label)
      ? accounts[label]?.install
      : undefined;
    if (typeof raw === "string" && INSTALL_NAME_RE.test(raw)) {
      return raw;
    }
  }
  return state.registry.default;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

let dataDir = "";
let logFile = "";

function log(message: string): void {
  if (logFile === "") {
    return;
  }
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics must never take the bridge down.
  }
}

// process.stdout.write is the bridge's only outbound channel. The SDK binds
// `(line) => process.stdout.write(line)` so this patch sees every line the
// generic bridge emits; lines we do not suppress go to `rawWrite`.
type WriteFn = (
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | ((err?: Error | null) => void),
  callback?: (err?: Error | null) => void,
) => boolean;

let rawWrite: WriteFn = process.stdout.write.bind(process.stdout) as WriteFn;
let outBuffer = "";
let patched = false;

function patchStdout(): void {
  if (patched) {
    return;
  }
  patched = true;
  rawWrite = process.stdout.write.bind(process.stdout) as WriteFn;
  process.stdout.write = function patchedWrite(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean {
    const cb = typeof encoding === "function" ? encoding : callback;
    try {
      outBuffer += typeof chunk === "string" ? chunk : chunk.toString();
      for (;;) {
        const nl = outBuffer.indexOf("\n");
        if (nl === -1) {
          break;
        }
        const line = outBuffer.slice(0, nl);
        outBuffer = outBuffer.slice(nl + 1);
        if (line.trim().length > 0) {
          interceptOutbound(line);
        }
      }
    } catch (error) {
      log(`outbound interceptor failed open: ${String(error)}`);
    }
    cb?.();
    return true;
  } as typeof process.stdout.write;
}

/** Write one message the daemon is meant to see (passthrough + synthesized). */
function writeOutbound(message: Record<string, unknown>): void {
  rawWrite(`${JSON.stringify(message)}\n`);
}

/**
 * Daemon-visible terminal answers captured for wrapper-driven requests: an
 * internal id registered here still runs the WHOLE normal handler (pool
 * picks, retries, sibling transforms — only the final response is diverted
 * to the waiter instead of the wire). The unknown-session restore
 * (PLUG-310) re-drives the daemon's own thread/resume end-to-end this way.
 */
const internalAnswers = new Map<
  JsonRpcId,
  (ok: boolean, result: unknown, error: unknown) => void
>();

function sendResult(id: JsonRpcId, result: unknown): void {
  const sink = internalAnswers.get(id);
  if (sink !== undefined) {
    internalAnswers.delete(id);
    sink(true, result, undefined);
    return;
  }
  writeOutbound({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
  const sink = internalAnswers.get(id);
  if (sink !== undefined) {
    internalAnswers.delete(id);
    sink(false, undefined, { code, message });
    return;
  }
  writeOutbound({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  log(`emit ${method} threadId=${String(params.threadId ?? "")}`);
  writeOutbound({ jsonrpc: "2.0", method, params });
}

function emitDeltas(threadId: string, ...deltas: Record<string, unknown>[]): void {
  if (deltas.length === 0) {
    return;
  }
  sendNotification("thread/delta", { threadId, deltas });
}

/**
 * The env keys acp-shim.mjs reads at startup (it exits 2 when REAL_BIN is
 * absent). Kept in sync with src/acp-shim.mjs's prologue.
 */
const REQUIRED_SHIM_ENV = [
  "AGY_SHIM_REAL_BIN",
  "AGY_SHIM_EVENTS",
  "AGY_SHIM_CONTROL",
  "AGY_SHIM_THREAD_ID",
  "AGY_SHIM_NONCE",
  "AGY_SHIM_SET_MODE",
] as const;

/**
 * PLUG-310 belt: a request must NEVER carry our shim spec without its
 * AGY_SHIM_* env — the bridge merges launchSpec.env into the child env at
 * spawn AND at every reconcile-driven rebuild, so an env-less spec makes
 * the shim exit 2 ("AGY_SHIM_REAL_BIN is not set"). A spec on a known
 * session is topped up from session.launchEnv; an env-less spec on an
 * unknown thread gets a minimal synthesized set so the shim at least runs
 * (its events are ignored — the nonce is not ours).
 */
function completeShimLaunchEnv(message: Record<string, unknown>): void {
  const params = optionsRecord(message.params);
  const options = optionsRecord(params.options);
  const providerOptions = optionsRecord(options.providerOptions);
  const spec = providerOptions.acpLaunchSpec;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return;
  }
  const rec = spec as Record<string, unknown>;
  // Only OUR shim spec — a static/foreign spec (command "agy" from the
  // server's bridgeOptions) stays untouched.
  if (rec.command !== process.execPath) {
    return;
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(optionsRecord(rec.env))) {
    if (typeof v === "string") {
      env[k] = v;
    }
  }
  if (
    REQUIRED_SHIM_ENV.every((k) => typeof env[k] === "string") &&
    env.AGY_SHIM_REAL_BIN !== "" &&
    env.AGY_SHIM_THREAD_ID !== ""
  ) {
    return;
  }
  const session =
    typeof params.threadId === "string"
      ? sessions.get(params.threadId)
      : undefined;
  if (session !== undefined && Object.keys(session.launchEnv).length > 0) {
    rec.env = { ...env, ...session.launchEnv };
  } else {
    // §6 п.2 (provider-agy-installs): the defensive fill answers the
    // binary the thread's account is bound to — for a known account with
    // an unavailable install that is "" (an honest launch failure), never
    // a silent default substitution. An unknown thread resolves through
    // the registry default, not the implicit binary.
    const realBin = (() => {
      const r =
        dataDir === ""
          ? ({ kind: "legacy" } as InstallResolution)
          : session === undefined
            ? resolveInstall(dataDir, undefined)
            : sessionInstall(session);
      return r.kind === "bin"
        ? r.bin
        : r.kind === "legacy"
          ? resolveAgyCommand(process.env)
          : "";
    })();
    const fill: Record<string, string> = {
      AGY_SHIM_REAL_BIN: realBin,
      AGY_SHIM_EVENTS: dataDir !== "" ? eventsFilePath() : "",
      AGY_SHIM_CONTROL: "",
      AGY_SHIM_THREAD_ID:
        typeof params.threadId === "string" ? params.threadId : "",
      AGY_SHIM_NONCE: "",
      AGY_SHIM_SET_MODE: "",
    };
    const merged: Record<string, string> = {
      ...shimRuntimeEnv(),
      ...fill,
      ...env,
    };
    for (const k of REQUIRED_SHIM_ENV) {
      if (typeof merged[k] !== "string") {
        merged[k] = fill[k];
      }
    }
    if (merged.AGY_SHIM_REAL_BIN === "") {
      merged.AGY_SHIM_REAL_BIN = fill.AGY_SHIM_REAL_BIN;
    }
    if (merged.AGY_SHIM_THREAD_ID === "") {
      merged.AGY_SHIM_THREAD_ID = fill.AGY_SHIM_THREAD_ID;
    }
    rec.env = merged;
  }
  log(
    `thread ${String(params.threadId ?? "?")}: ${String(message.method)} carried a shim launch spec without AGY_SHIM_* — completed defensively`,
  );
}

function feedLine(message: Record<string, unknown>): void {
  completeShimLaunchEnv(message);
  acpBridge.handleLine(JSON.stringify(message));
}

function optionsRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Shim side channel (dataDir/acp-shim/events.ndjson, appended by every shim)
// ---------------------------------------------------------------------------

let eventsFd: number | null = null;
let eventsOffset = 0;
let eventsTail = "";

function shimDir(): string {
  return join(dataDir, "acp-shim");
}

function eventsFilePath(): string {
  return join(shimDir(), "events.ndjson");
}

function ensureShimDir(): void {
  try {
    mkdirSync(shimDir(), { recursive: true });
  } catch {
    // The first spawn fails anyway if the data dir is unusable.
  }
}

interface ShimEvent {
  nonce: string | null;
  threadId: string | null;
  t: string;
  sessionId?: string | null;
  usage?: AcpUsage | null;
  toolCalls?: number;
  error?: { code: number | null; message: string } | null;
  text?: string;
}

/**
 * Read everything the shims appended since the last drain. Called at the top
 * of every intercepted outbound line: the shim writes its event BEFORE it
 * relays the line that produced it, so an event is always visible here
 * before the boundary traffic it can trigger.
 */
function drainShimEvents(): void {
  if (dataDir === "") {
    return;
  }
  try {
    if (eventsFd === null) {
      const file = eventsFilePath();
      if (!existsSync(file)) {
        return;
      }
      eventsFd = openSync(file, "r");
      eventsOffset = 0;
    }
    const buf = Buffer.alloc(1 << 20);
    const read = readSync(eventsFd, buf, 0, buf.length, eventsOffset);
    if (read <= 0) {
      return;
    }
    eventsOffset += read;
    eventsTail += buf.subarray(0, read).toString("utf8");
    for (;;) {
      const nl = eventsTail.indexOf("\n");
      if (nl === -1) {
        break;
      }
      const line = eventsTail.slice(0, nl);
      eventsTail = eventsTail.slice(nl + 1);
      if (line.trim().length === 0) {
        continue;
      }
      try {
        handleShimEvent(JSON.parse(line) as ShimEvent);
      } catch (error) {
        log(`shim event dropped: ${String(error)}`);
      }
    }
  } catch (error) {
    log(`shim events drain failed: ${String(error)}`);
  }
}

function handleShimEvent(event: ShimEvent): void {
  const threadId = event.threadId;
  if (threadId === null) {
    return;
  }
  const session = sessions.get(threadId);
  if (session === undefined || session.nonce !== event.nonce) {
    return; // stale shim of a released construction
  }
  switch (event.t) {
    case "prompt-result": {
      if (event.error) {
        const message = event.error.message;
        log(
          `shim: session/prompt error on thread ${threadId}: ${message.slice(0, 200)}`,
        );
        session.armedError = { message, atMs: Date.now(), handled: false };
      }
      if (event.usage) {
        emitUsage(session, event.usage, event.toolCalls ?? 0);
      }
      return;
    }
    case "tool-refusal": {
      const text = event.text ?? "";
      if (
        ARTIFACT_PATH_REFUSAL.test(text) &&
        session.artifactRetries < MAX_ARTIFACT_RETRIES &&
        !session.artifactNudgeQueued
      ) {
        session.artifactNudgeQueued = true;
        session.artifactRetries += 1;
        const path = artifactRefusalPath(text);
        log(
          `thread ${threadId}: artifact-path refusal seen by shim; queuing write retry nudge`,
        );
        session.queue.unshift({
          kind: "internal",
          tag: "artifact-nudge",
          input: [{ type: "text", text: writeRetryNudge(path) }],
          suppressOpen: false,
          suppressAccepted: true,
          onSettled: null,
        });
        drainQueue(session);
      }
      return;
    }
    default:
      return;
  }
}

function emitUsage(session: WSession, usage: AcpUsage, toolCalls = 0): void {
  const last = acpUsageToBreakdown(usage);
  const total: TokenBreakdown = {
    totalTokens: session.usageTotal.totalTokens + last.totalTokens,
    inputTokens: session.usageTotal.inputTokens + last.inputTokens,
    cachedInputTokens:
      session.usageTotal.cachedInputTokens + last.cachedInputTokens,
    outputTokens: session.usageTotal.outputTokens + last.outputTokens,
    reasoningOutputTokens:
      session.usageTotal.reasoningOutputTokens + last.reasoningOutputTokens,
  };
  session.usageTotal = total;
  const window = contextWindowSize(session.model);
  emitDeltas(session.threadId, {
    kind: "usage",
    total,
    last,
    modelContextWindow: window,
  });
  // The thread's context meter needs a contextWindow delta, not just the
  // usage row — without it bb shows "Context usage is not available yet".
  // agy's result.usage aggregates EVERY model call of the turn: each call
  // re-reads ~the whole cached prefix, so input+cachedRead of a multi-step
  // turn is N× the real window (a 15-call turn read "3m / 1m"). Estimate the
  // live edge as per-call average input + the turn's generated tokens:
  // used ≈ (input + cachedRead)/steps + output + thought. Model calls that
  // carry no tool_call (summarization, steering) are not in `steps`, so an
  // edge turn can overshoot the window — cap it: >100% of the window is
  // impossible by definition and renders as a saturated "100" meter.
  const steps = 1 + Math.max(0, toolCalls);
  const rawUsed = Math.round(
    ((usage.inputTokens ?? 0) + (usage.cachedReadTokens ?? 0)) / steps +
      (usage.outputTokens ?? 0) +
      (usage.thoughtTokens ?? 0),
  );
  const usedTokens = window === null ? rawUsed : Math.min(rawUsed, window);
  emitDeltas(session.threadId, {
    kind: "contextWindow",
    attach: "currentOrLast",
    estimated: true,
    used: usedTokens,
    size: window,
    ...(window === null || session.providerThreadId === null
      ? {}
      : {
          snapshot: {
            autoCompactAtTokens: null,
            capturedAt: new Date().toISOString(),
            categories: [],
            contextWindowTokens: window,
            estimated: true,
            model: session.model ?? "unknown",
            providerSessionId: session.providerThreadId,
            providerTurnId: null,
            usedTokens,
          },
        }),
  });
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface ArmedError {
  message: string;
  atMs: number;
  handled: boolean;
}

/**
 * Why the automaton replaced the session's account. "model" is the §2.3
 * in-flight refusal or model switch: not quota, so nothing is cooled —
 * the family is marked unsupported for the account instead. "tos-disabled"
 * is permanent parking until a manual unpark.
 */
type RotationCause =
  | "quota"
  | "ineligible"
  | "auth-dead"
  | "tos-disabled"
  | "validation-required"
  | "model";

interface QueuedDaemonTurn {
  kind: "daemon";
  requestId: JsonRpcId;
  params: Record<string, unknown>;
}

interface QueuedInternalTurn {
  kind: "internal";
  tag: "handoff" | "compact-summary" | "compact-seed" | "artifact-nudge";
  input: { type: string; text: string }[];
  /** The daemon's turn is still open: hide this turn's open boundary. */
  suppressOpen: boolean;
  suppressAccepted: boolean;
  /** A daemon turn consumed by this replay: owed accepted+result now. */
  consumeRequestId?: JsonRpcId;
  consumeClientRequestId?: string;
  onSettled: ((session: WSession, status: string) => void) | null;
}

type QueuedTurn = QueuedDaemonTurn | QueuedInternalTurn;

interface CompactFallback {
  stage: "summary" | "seed" | "restore";
  summaryBuf: string;
  collecting: boolean;
  seedAttempts: number;
  oldProviderThreadId: string | null;
  seedPromptText: string;
}

interface WSession {
  threadId: string;
  cwd: string;
  providerThreadId: string | null;
  accountLabel: string | null;
  /** Construction nonce: the env that tells this session's shim apart. */
  nonce: string;
  controlFile: string;
  launchSpec: Record<string, unknown>;
  launchEnv: Record<string, string>;
  /** options.envVars after PROTECTED filtering at construction. */
  envVars: Record<string, string>;
  baseOptions: Record<string, unknown>;
  baseParams: Record<string, unknown>;
  declaredMode: string | null;
  agyMode: string | null;
  model: string | undefined;
  reasoningLevel: string | undefined;
  rotating: boolean;
  /** Session is being rebuilt from a thread record (unknown-session
   * restore): every queued turn waits until the resume resolves. */
  restoring: boolean;
  rotationCause: RotationCause | null;
  armedError: ArmedError | null;
  waitTimer: NodeJS.Timeout | null;
  waitUntilMs: number;
  queue: QueuedTurn[];
  /** A prompt is open inside the generic bridge (seen turn.open). */
  bridgeTurnBusy: boolean;
  /** The daemon's turn is open from its point of view. */
  daemonTurnOpen: boolean;
  suppressOpenNext: boolean;
  suppressAcceptedNext: boolean;
  /** Swallow the next `error` notification for this thread. */
  suppressErrorNotify: boolean;
  /** The prompt text of the currently open / last delegated turn. */
  lastTurnPrompt: string | null;
  /** The daemon turn a cooldown-triggered rotation replays as handoff. */
  pendingConsume: QueuedDaemonTurn | null;
  settledInternal: QueuedInternalTurn["onSettled"];
  recentAssistantText: string;
  usageTotal: TokenBreakdown;
  rateLimitsBlocked: boolean;
  artifactRetries: number;
  artifactNudgeQueued: boolean;
  compactInFlight: boolean;
  compact: CompactFallback | null;
  needsHandoff: boolean;
  autoRetryCount: number;
  stopped: boolean;
  /** §2.3 п.11: a VALIDATION_REQUIRED answer surfaced as agent text — the
   * turn must not deliver it, its boundary becomes a parking+rotation. */
  validationRefusal: boolean;
  /** §2.3 п.13: the swallowed "⚠ Individual quota reached…" text, or null. */
  quotaRefusalText: string | null;
  /** §2.3 п.11 (ревизия 13.1): text of the CURRENT agent message — the
   * strict marker match runs only against this, never against the
   * cross-turn recentAssistantText tail. */
  agentMessageText: string;
  /** §2.3 п.10: families this session already moved once for — a second
   * refusal for the same family fails honestly instead of chaining. */
  modelRefusalMoved: Set<string>;
  /** §2.3 п.13 (ревизия 18): candidate buffer holding agentMessage deltas while matching prefix/marker */
  candidateBuffer: Record<string, unknown>[];
  /** §2.3 п.13 (ревизия 18): held item.textClose event awaiting turn.boundary confirmation */
  heldTextClose: Record<string, unknown> | null;
  /** §2.3 п.13 (ревизия 18): effective resetsAtMs for rateLimitsBlocked */
  blockedResetsAtMs: number | null;
  /** §2.3 п.13 (ревизия 18): unblock timer for direct/relay mode rateLimitsBlocked */
  unblockTimer: NodeJS.Timeout | null;
  /** §2.3 п.13 (ревизия 18): true if at least one agentMessage text delta has been sent to client in current segment */
  streamedAgentMessage: boolean;
  /** §2.3 п.15 (ревизия 19): true if agy interrupted stream message was suppressed and continuation is pending */
  interruptedPending: boolean;
}

const sessions = new Map<string, WSession>();
const stoppingSessions = new Map<string, WSession>();

function newSession(threadId: string, cwd: string): WSession {
  return {
    threadId,
    cwd,
    providerThreadId: null,
    accountLabel: null,
    nonce: "",
    controlFile: "",
    launchSpec: {},
    launchEnv: {},
    envVars: {},
    baseOptions: {},
    baseParams: {},
    declaredMode: null,
    agyMode: null,
    model: undefined,
    reasoningLevel: undefined,
    rotating: false,
    restoring: false,
    rotationCause: null,
    armedError: null,
    waitTimer: null,
    waitUntilMs: 0,
    queue: [],
    bridgeTurnBusy: false,
    daemonTurnOpen: false,
    suppressOpenNext: false,
    suppressAcceptedNext: false,
    suppressErrorNotify: false,
    lastTurnPrompt: null,
    pendingConsume: null,
    settledInternal: null,
    recentAssistantText: "",
    usageTotal: { ...ZERO_USAGE },
    rateLimitsBlocked: false,
    artifactRetries: 0,
    artifactNudgeQueued: false,
    compactInFlight: false,
    compact: null,
    needsHandoff: false,
    autoRetryCount: 0,
    stopped: false,
    validationRefusal: false,
    quotaRefusalText: null,
    agentMessageText: "",
    modelRefusalMoved: new Set<string>(),
    candidateBuffer: [],
    heldTextClose: null,
    blockedResetsAtMs: null,
    unblockTimer: null,
    streamedAgentMessage: false,
    interruptedPending: false,
  };
}

// ---------------------------------------------------------------------------
// Thread records (dataDir/threads-state.json): bbThreadId -> {cwd,
// providerThreadId}. Outlives a wrapper restart — the unknown-session
// restore (PLUG-310) rebuilds a session from this when a turn arrives for a
// thread the wrapper no longer has in memory.
// ---------------------------------------------------------------------------

const THREADS_STATE_FILE = "threads-state.json";
/** §12.6 (ревизия 14): the file is bounded — evict beyond this count. */
const THREADS_STATE_MAX_RECORDS = 2_000;

interface ThreadRecord {
  cwd: string;
  providerThreadId: string | null;
  /** Last write time; a record without it counts as the oldest on evict. */
  atMs?: number;
}

function loadThreadRecords(): Record<string, ThreadRecord> {
  if (dataDir === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(
      readFileSync(join(dataDir, THREADS_STATE_FILE), "utf8"),
    ) as {
      threads?: Record<
        string,
        { cwd?: unknown; providerThreadId?: unknown; atMs?: unknown }
      >;
    };
    const out: Record<string, ThreadRecord> = {};
    for (const [tid, rec] of Object.entries(parsed.threads ?? {})) {
      if (typeof rec?.cwd === "string" && rec.cwd.length > 0) {
        out[tid] = {
          cwd: rec.cwd,
          providerThreadId:
            typeof rec.providerThreadId === "string"
              ? rec.providerThreadId
              : null,
          ...(typeof rec.atMs === "number" ? { atMs: rec.atMs } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeThreadRecords(records: Record<string, ThreadRecord>): void {
  if (dataDir === "") {
    return;
  }
  // §12.6 (ревизия 14): bound the file — over the cap, the oldest records
  // by atMs are evicted first; a record without atMs counts as the oldest.
  const keys = Object.keys(records);
  if (keys.length > THREADS_STATE_MAX_RECORDS) {
    const byAge = keys
      .map((key) => ({ key, atMs: records[key]?.atMs ?? 0 }))
      .sort((a, b) => a.atMs - b.atMs);
    for (const { key } of byAge.slice(
      0,
      keys.length - THREADS_STATE_MAX_RECORDS,
    )) {
      delete records[key];
    }
  }
  const target = join(dataDir, THREADS_STATE_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify({ threads: records }, null, 1)}\n`,
      "utf8",
    );
    renameSync(tmp, target);
  } catch {
    // Best-effort bookkeeping: a lost record only means a later restore
    // cannot happen — never a wrong session.
  }
}

function rememberThreadRecord(
  threadId: string,
  cwd: string,
  providerThreadId: string | null,
): void {
  const records = loadThreadRecords();
  records[threadId] = {
    cwd,
    providerThreadId:
      providerThreadId ?? records[threadId]?.providerThreadId ?? null,
    atMs: Date.now(),
  };
  writeThreadRecords(records);
}

function threadRecord(threadId: string): ThreadRecord | null {
  return loadThreadRecords()[threadId] ?? null;
}

function forgetThreadRecord(threadId: string): void {
  const records = loadThreadRecords();
  if (Object.hasOwn(records, threadId)) {
    delete records[threadId];
    writeThreadRecords(records);
  }
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

interface PromptItem {
  type?: string;
  text?: string;
  path?: string;
  url?: string;
}

function promptText(input: readonly PromptItem[] | undefined): string {
  const parts: string[] = [];
  for (const item of input ?? []) {
    if (item.type === "text") {
      parts.push(item.text ?? "");
      continue;
    }
    if (item.type === "localImage" || item.type === "localFile") {
      parts.push(item.path ?? "");
      continue;
    }
    if (item.type === "image") {
      parts.push(item.url ?? "");
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Launch spec
// ---------------------------------------------------------------------------

/**
 * Where the shim lives at runtime. The host artifact is a single bundled
 * file — no sidecar ships — so the shim source travels as base64 inside it
 * and is materialized into the provider dataDir (rewritten whenever the
 * embedded bytes differ). Dev checkouts fall back to src/acp-shim.mjs.
 */
let materializedShimPath: string | null = null;

function materializeShim(): string {
  if (dataDir !== "") {
    const target = join(dataDir, "acp-shim.mjs");
    try {
      const bytes = Buffer.from(ACP_SHIM_SOURCE_B64, "base64");
      const existing = existsSync(target)
        ? readFileSync(target)
        : null;
      if (existing === null || !existing.equals(bytes)) {
        writeFileSync(target, bytes);
      }
      try {
        chmodSync(target, 0o755);
      } catch {
        // Mode is cosmetic: the child runs through process.execPath anyway.
      }
      materializedShimPath = target;
      return target;
    } catch (error) {
      log(`shim materialization failed: ${String(error)}`);
    }
  }
  // Dev fallback: run straight from the source tree.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "acp-shim.mjs"),
    join(here, "src", "acp-shim.mjs"),
    join(here, "..", "src", "acp-shim.mjs"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return join(here, "acp-shim.mjs");
}

// ---------------------------------------------------------------------------
// Orphan-shim reaper and graceful process-tree kills (spec §12.3, the
// defense-in-depth half of incident 16.11 — the shim's own §12.2 lifecycle is
// the primary fix; this reaps shims that outlived their bridge worker anyway
// and sweeps stale harness tmp roots).
// ---------------------------------------------------------------------------

const REAPER_TERM_GRACE_MS = 9_000;
const STALE_SHIM_TMP_MS = 60 * 60_000;
const PROC_DESCENDANT_CAP = 512;
const PROC_FD_SCAN_CAP = 200_000;

function readProcText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Direct + transitive children of pid, read BEFORE the pid is killed —
 * afterwards they re-parent and the tree becomes invisible (the same orphan
 * class this reaper exists to remove). */
function procDescendants(pid: number): number[] {
  const seen = new Set<number>([pid]);
  const queue = [pid];
  const out: number[] = [];
  while (queue.length > 0 && out.length < PROC_DESCENDANT_CAP) {
    const cur = queue.shift() as number;
    let tids: string[] = [];
    try {
      tids = readdirSync(`/proc/${cur}/task`);
    } catch {
      continue;
    }
    for (const tid of tids) {
      const text = readProcText(`/proc/${cur}/task/${tid}/children`);
      if (text === null) continue;
      for (const tok of text.trim().split(/\s+/)) {
        const child = Number(tok);
        if (!Number.isInteger(child) || child <= 0 || seen.has(child)) {
          continue;
        }
        seen.add(child);
        out.push(child);
        queue.push(child);
      }
    }
  }
  return out;
}

function procPpid(pid: number): number | null {
  const status = readProcText(`/proc/${pid}/status`);
  const match = status?.match(/^PPid:\s*(\d+)$/m);
  return match ? Number(match[1]) : null;
}

function procComm(pid: number): string | null {
  const comm = readProcText(`/proc/${pid}/comm`);
  return comm === null ? null : comm.trim();
}

/** argv[0] must be the node interpreter itself (or the host's own runtime —
 * desktop bb runs the shim on its Electron binary, spec §12.5) and argv[1]
 * the shim — a `vim`/`grep acp-shim.mjs` cmdline must never earn a kill
 * (spec §12.3). */
function isAcpShimProcess(pid: number): boolean {
  let raw: Buffer;
  try {
    raw = readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return false;
  }
  const argv = raw
    .toString("utf8")
    .split("\0")
    .filter((part) => part.length > 0);
  if (argv.length < 2) {
    return false;
  }
  if (
    !/^node(js)?$/.test(basename(argv[0])) &&
    argv[0] !== process.execPath
  ) {
    return false;
  }
  return basename(argv[1]) === "acp-shim.mjs";
}

/** Orphan = reparented: straight to PID 1, or adopted by a systemd
 * (user-)instance/subreaper — no resolve of the foreign pid needed. */
function isOrphanProcess(pid: number): boolean {
  const ppid = procPpid(pid);
  if (ppid === null) {
    return false;
  }
  return ppid === 1 || procComm(ppid) === "systemd";
}

function reapOrphanShim(pid: number): void {
  const environ = readProcText(`/proc/${pid}/environ`);
  const threadId =
    environ
      ?.split("\0")
      .find((kv) => kv.startsWith("AGY_SHIM_THREAD_ID="))
      ?.slice("AGY_SHIM_THREAD_ID=".length) ?? "?";
  let ageS = -1;
  try {
    ageS = Math.round((Date.now() - statSync(`/proc/${pid}`).mtimeMs) / 1000);
  } catch {}
  log(`reaper: orphan acp-shim pid=${pid} thread=${threadId} age=${ageS}s TERM`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  // The TERM grace lets a current shim run its own §12.2 shutdown (it
  // group-kills agy acp itself); an old shim at least forwards it. On KILL
  // the shim's children are taken down explicitly — collect them BEFORE the
  // kill or agy's tree re-orphans, the same leak class this removes.
  const killTimer = setTimeout(() => {
    const descendants = procDescendants(pid);
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    for (const descendant of descendants) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {}
    }
    log(
      `reaper: orphan acp-shim pid=${pid} KILL sent (+${descendants.length} descendants)`,
    );
  }, REAPER_TERM_GRACE_MS);
  killTimer.unref?.();
}

/** TERM → grace → KILL ladder for the maintenance probes — the bare
 * child.kill("SIGKILL") they used left `agy acp` behind on stdin EOF. */
function killProcessTreeGracefully(child: ChildProcess): void {
  const pid = child.pid;
  try {
    child.kill("SIGTERM");
  } catch {}
  if (pid === undefined) {
    return;
  }
  const killTimer = setTimeout(() => {
    const descendants = procDescendants(pid);
    try {
      child.kill("SIGKILL");
    } catch {}
    for (const descendant of descendants) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {}
    }
  }, REAPER_TERM_GRACE_MS);
  killTimer.unref?.();
}

function newestMtimeMs(dir: string, budget: { left: number }): number {
  let newest = 0;
  if (budget.left <= 0) {
    return newest;
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return newest;
  }
  for (const name of names) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    if (st.isDirectory()) {
      const nested = newestMtimeMs(path, budget);
      if (nested > newest) newest = nested;
    }
  }
  return newest;
}

export function procSession(pid: string): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const idx = stat.lastIndexOf(")");
  if (idx === -1) return null;
  const fields = stat.substring(idx + 2).split(" ");
  return fields[3] || null;
}

export type ProcAccessOutcome = "skipProcess" | "reference" | "dead";

/** Classifies an unreadable same-uid process (cwd/fd error) per spec §12.3(c) rev 9.
 * Only ENOENT/ESRCH means the process exited (dead, not a reference).
 * EPERM/EACCES is resolved by session: foreign session daemons (setsid, dumpable=0)
 * with a known session differing from ours are skipped. Same-uid processes in our own session,
 * or when our own session cannot be determined, conservatively count as a reference (fail-close).
 * Any other cwd/fd error (or missing error code) is conservatively treated as a reference.
 * When reading /proc/<pid>/stat, only ENOENT/ESRCH means the process exited (dead).
 * Any other stat read error (EPERM/EACCES) or unparseable stat is conservatively treated
 * as a reference. */
export function classifyUnreadableProcess(
  pid: string,
  error: unknown,
  ourSession: string | null,
): ProcAccessOutcome {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ESRCH") {
    return "dead"; // Process exited during readlink/readdir — not a reference
  }
  if (code !== "EPERM" && code !== "EACCES") {
    return "reference"; // EIO, ENOMEM, or missing/unknown error code — fail-close: conservative reference
  }
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    const statCode = (err as NodeJS.ErrnoException | undefined)?.code;
    if (statCode === "ENOENT" || statCode === "ESRCH") {
      return "dead"; // Process exited during stat — not a reference
    }
    // Any other read error on stat (EPERM, EACCES, etc.) — fail-close: conservative reference
    return "reference";
  }
  const idx = stat.lastIndexOf(")");
  if (idx === -1) {
    return "reference"; // Unparseable stat — conservative reference
  }
  const fields = stat.substring(idx + 2).split(" ");
  const session = fields[3] || null;
  if (session === null) {
    return "reference"; // Missing session field — conservative reference
  }
  if (ourSession === null || session === ourSession) {
    return "reference"; // Our session unknown or same-uid process in our own session
  }
  return "skipProcess"; // Known foreign-session daemon
}

/** Every filesystem target visible in /proc — cwd and fd symlinks of processes
 * belonging to our uid. Foreign processes are skipped without reading cwd/fd
 * (mkdtemp roots are 0700 so foreign uids cannot enter them, per spec §12.3(c) rev 9).
 * Unreadable same-uid processes (EPERM/EACCES) are resolved by session via /proc/<pid>/stat:
 * foreign session daemons (dumpable=0) in a known different session are skipped, while
 * same-uid processes in our own session (or when session cannot be determined) conservatively
 * count as a reference and return null. Returns null on scan budget overflow or when our
 * own session cannot be determined. */
export function procVisibleTargets(): Set<string> | null {
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return null;
  }
  const myUid = typeof process.getuid === "function" ? process.getuid() : -1;
  const ourSession = procSession("self");
  if (ourSession === null) {
    return null;
  }
  const targets = new Set<string>();
  let scanned = 0;
  for (const pid of pids) {
    let st;
    try {
      st = statSync(`/proc/${pid}`);
    } catch {
      continue; // raced exit before stat — not a reference
    }
    if (st.uid !== myUid) {
      // 0700 mkdtemp roots cannot be accessed by foreign uids; skip without reading
      continue;
    }
    try {
      targets.add(readlinkSync(`/proc/${pid}/cwd`));
    } catch (error) {
      const outcome = classifyUnreadableProcess(pid, error, ourSession);
      if (outcome === "reference") return null;
      continue; // skipProcess or dead: do not scan fds
    }
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch (error) {
      const outcome = classifyUnreadableProcess(pid, error, ourSession);
      if (outcome === "reference") return null;
      continue; // skipProcess or dead
    }
    for (const fd of fds) {
      scanned += 1;
      if (scanned > PROC_FD_SCAN_CAP) return null;
      try {
        targets.add(readlinkSync(`/proc/${pid}/fd/${fd}`));
      } catch (error) {
        // fd churn between readdir and readlink is normal — but only
        // ENOENT/ESRCH mean the fd vanished; anything else (e.g. EACCES
        // when dumpable drops mid-scan) is classified per spec §12.3(c).
        const outcome = classifyUnreadableProcess(pid, error, ourSession);
        if (outcome === "reference") return null;
      }
    }
  }
  return targets;
}

/** Leftover `<os.tmpdir()>/agy-acp-*` roots of dead harnesses. A dir is
 * removed only when it is not this instance's own dataDir/shimDir (or their
 * ancestor), carries no file younger than an hour, and no live process
 * references it — all three, per spec §12.3. */
export function sweepStaleShimTmpDirs(): void {
  let names: string[] = [];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  const candidates = names
    .filter((name) => name.startsWith("agy-acp-"))
    .map((name) => join(tmpdir(), name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  if (candidates.length === 0) {
    return;
  }
  const targets = procVisibleTargets();
  for (const dir of candidates) {
    try {
      const resolved = resolve(dir);
      const own =
        [dataDir, shimDir()]
          .filter((base) => base !== "")
          .map((base) => resolve(base))
          .some(
            (base) => resolved === base || base.startsWith(resolved + sep),
          );
      if (own) continue;
      const budget = { left: 10_000 };
      if (Date.now() - newestMtimeMs(dir, budget) < STALE_SHIM_TMP_MS) {
        continue;
      }
      if (
        targets === null ||
        [...targets].some(
          (t) => t === resolved || t.startsWith(resolved + sep),
        )
      ) {
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
      log(`reaper: removed stale shim tmp dir ${dir}`);
    } catch {
      // A dir that resists any check is left for the next pass.
    }
  }
}

/** Defense in depth: shims orphaned onto init/systemd are reaped here even
 * though the shim's own lifecycle is the primary fix. No-op outside Linux;
 * any scan failure degrades to log+skip — start()/onClose() never fall. */
function reapOrphanShims(): void {
  if (process.platform !== "linux") {
    return;
  }
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!isAcpShimProcess(pid) || !isOrphanProcess(pid)) continue;
      reapOrphanShim(pid);
    }
    sweepStaleShimTmpDirs();
  } catch (error) {
    log(`reaper: scan failed: ${String(error)}`);
  }
}

/**
 * Declared bb permission mode → boundary policy quadruple + agy
 * session/set_mode id. The boundary discriminated union knows only
 * accept-edits | auto | full, each with its own scope/reviewer/escalation
 * companions — so the whole policy is rewritten, not just the mode key.
 */
function mapPermissionMode(mode: string | undefined | null): {
  policy: {
    permissionMode: "full" | "auto" | "accept-edits";
    permissionScope: "full" | "workspace";
    approvalReviewer: "user" | "automatic" | null;
    permissionEscalation: "ask" | "deny" | null;
  };
  agy: string | null;
} {
  switch (mode) {
    case "full":
      return {
        policy: {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        agy: "yolo",
      };
    case "plan":
      return {
        policy: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
        },
        agy: "plan",
      };
    case "default":
      return {
        policy: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
        },
        agy: "default",
      };
    case "auto":
      return {
        policy: {
          permissionMode: "auto",
          permissionScope: "workspace",
          approvalReviewer: "automatic",
          permissionEscalation: "ask",
        },
        agy: "yolo",
      };
    case "accept-edits":
    case "workspace-write":
      return {
        policy: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
        },
        agy: "auto_edit",
      };
    default:
      return {
        policy: {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        agy: "yolo",
      };
  }
}

const EFFORT_SUFFIX = /-(none|low|medium|high|xhigh|ultra|ultracode|max)$/u;

interface ModelCatalog {
  raw: { id: string; displayName: string }[];
  atMs: number;
}

let modelCatalog: ModelCatalog | null = null;
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const modelDiskCachePath = (): string => join(dataDir, "acp-models-cache.json");

function modelCacheStale(): boolean {
  return (
    modelCatalog === null ||
    Date.now() - modelCatalog.atMs > MODEL_CACHE_TTL_MS
  );
}

function loadModelDiskCache(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(modelDiskCachePath(), "utf8")) as {
      raw?: { id: string; displayName: string }[];
      atMs?: number;
    };
    if (Array.isArray(parsed.raw) && parsed.raw.length > 0) {
      modelCatalog = { raw: parsed.raw, atMs: parsed.atMs ?? 0 };
      return true;
    }
  } catch {
    // Cold start with no cache.
  }
  return false;
}

function saveModelDiskCache(): void {
  if (modelCatalog === null || dataDir === "") {
    return;
  }
  try {
    writeFileSync(
      modelDiskCachePath(),
      `${JSON.stringify({ raw: modelCatalog.raw, atMs: modelCatalog.atMs })}\n`,
      "utf8",
    );
  } catch {
    // Cache is an optimization.
  }
}

/** Split `<model>-<effort>` into family + effort, or null when no suffix. */
function splitModelEffort(model: string): {
  model: string;
  effort: string;
} | null {
  const match = EFFORT_SUFFIX.exec(model);
  if (match === null) {
    return null;
  }
  const base = model.slice(0, match.index);
  return base.length > 0 ? { model: base, effort: match[1] } : null;
}

/**
 * Where an inbound model choice lands on the wire: the family goes to the
 * session's model config option, the effort to `thought_level` — per spec §8
 * ("gemini-3.8-flash + supportedReasoningEfforts → session/set_config_option").
 * An explicit options.reasoningLevel is the fallback when the id is bare.
 */
function resolveModelSelection(
  model: string | undefined,
  reasoningLevel: string | undefined,
): { modelId: string | undefined; reasoningLevel: string | undefined } {
  if (model === undefined || model.length === 0 || model === "acp-default") {
    return { modelId: undefined, reasoningLevel };
  }
  const split = splitModelEffort(model);
  if (split !== null) {
    return { modelId: split.model, reasoningLevel: split.effort };
  }
  return { modelId: model, reasoningLevel };
}

/**
 * The shim is JS and runs on the host's own runtime (process.execPath). In
 * desktop bb that is the Electron app binary, which acts as Node only with
 * ELECTRON_RUN_AS_NODE=1 — and the SDK bridge strips that from the child env
 * (withoutBridgeRuntimeEnv). Without it bb.app boots as the app and exits 0
 * before ACP initialize (spec §12.5). Server bb runs on node: env unchanged.
 */
function shimRuntimeEnv(): Record<string, string> {
  return process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
}

function shimEnvFor(
  session: WSession,
  realBin: string,
): Record<string, string> {
  return {
    ...shimRuntimeEnv(),
    AGY_SHIM_REAL_BIN: realBin,
    AGY_SHIM_EVENTS: eventsFilePath(),
    AGY_SHIM_CONTROL: session.controlFile,
    AGY_SHIM_THREAD_ID: session.threadId,
    AGY_SHIM_NONCE: session.nonce,
    AGY_SHIM_SET_MODE: session.agyMode ?? "",
  };
}

/**
 * Build this session's acpLaunchSpec. `--gemini-dir <account-home>/.gemini`
 * (absolute) is the only isolation flag; proxy rides the env; the cliproxy
 * relay contributes its api env + own gemini dir. Direct mode gets neither —
 * agy then defaults to the real HOME's ~/.gemini.
 */
/**
 * bb owns every subagent — agy must not run its own invoke_subagent/swarm/
 * boost invisibly inside a thread. The hard lever is the shim's
 * disableBuiltInTools injection on session/new|load; this stamps the same
 * intent into the account home's settings.json (antigravityConfig is the
 * UserConfig section) as a second layer for paths that carry no session
 * params. Additive merge: other keys are preserved; both casings are
 * written because the reader is unknown (protojson accepts both).
 */
function providerSettings(
  subagentsEnabled: boolean,
  memoryEnabled: boolean,
): Record<string, unknown> {
  return {
    antigravityConfig: {
      subagentsConfig: { enabled: subagentsEnabled },
      boostCommandDisabled: !subagentsEnabled,
      memoryConfig: { enabled: memoryEnabled },
    },
    antigravity_config: {
      subagents_config: { enabled: subagentsEnabled },
      boost_command_disabled: !subagentsEnabled,
      memory_config: { enabled: memoryEnabled },
    },
  };
}

/**
 * Whether agy may spawn native subagents for this session. Resolution order:
 * `AGY_DISABLE_SUBAGENTS` env override ("0" allows, anything else forbids) >
 * `providerOptions.providerSubagentsEnabled` derived by the server from the
 * `subagentsDisabled` plugin setting > default OFF (bb owns every subagent).
 */
function subagentsEnabledFor(session: WSession): boolean {
  const override = process.env.AGY_DISABLE_SUBAGENTS;
  if (override !== undefined && override !== "") {
    return override === "0";
  }
  const derived = optionsRecord(session.baseOptions.providerOptions)
    .providerSubagentsEnabled;
  if (typeof derived === "boolean") {
    return derived;
  }
  return false;
}

/**
 * Whether agy may use its native memory tools for this session. Same
 * resolution ladder as subagents: `AGY_DISABLE_MEMORY` env ("0" allows) >
 * `providerOptions.providerMemoryEnabled` from the `memoryEnabled` plugin
 * setting > default OFF (bb does not run hidden provider memory).
 */
function memoryEnabledFor(session: WSession): boolean {
  const override = process.env.AGY_DISABLE_MEMORY;
  if (override !== undefined && override !== "") {
    return override === "0";
  }
  const derived = optionsRecord(session.baseOptions.providerOptions)
    .providerMemoryEnabled;
  if (typeof derived === "boolean") {
    return derived;
  }
  return false;
}

function stampProviderConfig(
  geminiDir: string,
  subagentsEnabled: boolean,
  memoryEnabled: boolean,
): void {
  const file = join(geminiDir, "settings.json");
  try {
    let doc: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or unparsable: a malformed file would fail agy on load, so
      // leave a broken one alone rather than making the session unbootable.
      if (existsSync(file)) {
        return;
      }
    }
    for (const [section, fields] of Object.entries(
      providerSettings(subagentsEnabled, memoryEnabled),
    )) {
      const existing =
        doc[section] !== null &&
        typeof doc[section] === "object" &&
        !Array.isArray(doc[section])
          ? (doc[section] as Record<string, unknown>)
          : {};
      doc[section] = deepMergeSettings(
        existing,
        fields as Record<string, unknown>,
      );
    }
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

function deepMergeSettings(
  existing: Record<string, unknown>,
  ours: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...ours };
  for (const [k, v] of Object.entries(existing)) {
    if (
      k in ours &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof ours[k] === "object" &&
      ours[k] !== null &&
      !Array.isArray(ours[k])
    ) {
      out[k] = deepMergeSettings(
        v as Record<string, unknown>,
        ours[k] as Record<string, unknown>,
      );
    } else if (!(k in ours)) {
      out[k] = v;
    }
    // Our key wins when present — that is the point of the stamp.
  }
  return out;
}

/**
 * Build this session's launch spec. Returns null on success; on a locally
 * unavailable install (or a broken registry) returns the §5 п.2 reason
 * instead of a spec — the caller answers honestly and no binary launches.
 * The spawn still re-checks the file at exec time: a registry edit between
 * pick and launch loses to the same strict check here.
 */
function buildLaunch(session: WSession): string | null {
  session.nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  session.controlFile = join(
    shimDir(),
    `ctl-${session.threadId}-${session.nonce}.ndjson`,
  );
  ensureShimDir();
  // The shim fs.watch()es this file: it must exist before the shim starts or
  // the watch silently never registers (ENOENT swallowed by catch).
  try {
    appendFileSync(session.controlFile, "");
  } catch {}
  const resolution = sessionInstall(session);
  if (
    resolution.kind === "unavailable" ||
    resolution.kind === "broken"
  ) {
    return resolution.reason;
  }
  const realBin =
    resolution.kind === "bin"
      ? resolution.bin
      : resolveAgyCommand(process.env);
  // §8: the install's env rides as the first layer — the account's proxy
  // and the relay's api keys still override it below, and the schema
  // forbids install env from carrying any of those keys anyway.
  const env = {
    ...(resolution.kind === "bin" ? resolution.env : {}),
    ...shimEnvFor(session, realBin),
  };
  const subagentsOn = subagentsEnabledFor(session);
  env.AGY_DISABLE_SUBAGENTS = subagentsOn ? "0" : "1";
  const memoryOn = memoryEnabledFor(session);
  env.AGY_DISABLE_MEMORY = memoryOn ? "0" : "1";
  const args: string[] = [materializeShim(), "acp"];
  let relayHome: string | null = null;
  if (dataDir !== "") {
    const relay = resolveCliproxyRelay(dataDir);
    if (relay !== null) {
      relayHome = relay.home;
      env.GEMINI_API_KEY = relay.apiKey;
      env.GOOGLE_GEMINI_BASE_URL = relay.baseUrl;
    }
  }
  let geminiDir: string | null = null;
  if (session.accountLabel !== null && dataDir !== "") {
    const account = accountByLabel(
      listAccounts(dataDir),
      session.accountLabel,
    );
    if (account !== null) {
      geminiDir = join(account.home, ".gemini");
      // §2.3 п.14: the pool account's token is its own file, never the
      // machine-wide OS keyring.
      Object.assign(env, fileTokenStorageEnv(process.env));
      if (account.proxy !== null) {
        env.HTTPS_PROXY = account.proxy;
        env.https_proxy = account.proxy;
        env.HTTP_PROXY = account.proxy;
        env.http_proxy = account.proxy;
      }
    } else {
      log(
        `thread ${session.threadId}: account ${session.accountLabel} left the pool; relay/direct`,
      );
    }
  }
  if (geminiDir === null && relayHome !== null) {
    geminiDir = join(relayHome, ".gemini");
  }
  if (geminiDir !== null) {
    stampProviderConfig(geminiDir, subagentsOn, memoryOn);
    args.push("--gemini-dir", geminiDir);
  }
  session.launchEnv = env;
  session.launchSpec = {
    displayName: "Antigravity (agy)",
    command: process.execPath,
    args,
    env,
    permissionCli: {
      full: ["--dangerously-skip-permissions"],
      insertAfterArgs: 2,
    },
    nativeReasoning: {
      configId: "thought_level",
      supportedLevels: THOUGHT_LEVELS,
      defaultLevel: "medium",
      levelValues: {
        none: "low",
        xhigh: "high",
        ultra: "high",
        ultracode: "high",
        max: "high",
      },
    },
  };
  return null;
}

/** providerOptions payload the bridge sees for this session right now. */
function providerOptionsFor(session: WSession): Record<string, unknown> {
  return { acpLaunchSpec: session.launchSpec, acpDialect: "generic" };
}

function filterEnvVars(
  envVars: unknown,
  isPoolAccount = false,
): Record<string, string> {
  const out: Record<string, string> = {};
  const dropSsh = isPoolAccount && process.env.AGY_KEYRING !== "1";
  for (const [key, value] of Object.entries(optionsRecord(envVars))) {
    if (
      PROTECTED_CHILD_ENV.has(key) ||
      (dropSsh && key === "SSH_CONNECTION") ||
      typeof value !== "string"
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Rewrite a thread-bound request's options for the bridge: our launch spec,
 * a boundary-legal permissionMode (the declared mode rides the shim env /
 * control file instead), filtered envVars, resolved model selection, and the
 * ArtifactMetadata guardrail in the session instructions.
 */
function rewriteOptions(
  session: WSession,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const declared =
    typeof options.permissionMode === "string"
      ? options.permissionMode
      : (session.declaredMode ?? "full");
  const mapped = mapPermissionMode(declared);
  if (
    session.declaredMode !== null &&
    declared !== session.declaredMode &&
    session.controlFile !== ""
  ) {
    // Live mode change: the session is not rebuilt for it — session/set_mode
    // lands through the shim's control file.
    try {
      appendFileSync(
        session.controlFile,
        `${JSON.stringify({ cmd: "set_mode", mode: mapped.agy })}\n`,
      );
      log(
        `thread ${session.threadId}: permission mode ${session.declaredMode} → ${declared} (session/set_mode ${mapped.agy ?? "?"})`,
      );
    } catch {
      // The shim dies with its session anyway.
    }
  }
  session.declaredMode = declared;
  session.agyMode = mapped.agy;
  const selection = resolveModelSelection(
    typeof options.model === "string" ? options.model : undefined,
    typeof options.reasoningLevel === "string"
      ? options.reasoningLevel
      : undefined,
  );
  session.model = selection.modelId ?? session.model;
  session.reasoningLevel = selection.reasoningLevel ?? session.reasoningLevel;
  const providerOptions = {
    ...optionsRecord(options.providerOptions),
    ...providerOptionsFor(session),
  };
  const instructions =
    typeof options.instructions === "string" ? options.instructions : "";
  return {
    ...options,
    ...selection.modelId !== undefined ? { model: selection.modelId } : {},
    ...selection.reasoningLevel !== undefined
      ? { reasoningLevel: selection.reasoningLevel }
      : {},
    permissionMode: mapped.policy.permissionMode,
    permissionScope: mapped.policy.permissionScope,
    approvalReviewer: mapped.policy.approvalReviewer,
    permissionEscalation:
      mapped.policy.permissionMode === "full"
        ? null
        : options.permissionEscalation === "deny"
          ? "deny"
          : "ask",
    providerOptions,
    instructions: instructions.includes(WRITE_GUARDRAIL)
      ? instructions
      : `${instructions}${instructions.length > 0 ? "\n\n" : ""}${WRITE_GUARDRAIL}`,
    envVars: filterEnvVars(
      options.envVars ?? session.envVars,
      session.accountLabel !== null,
    ),
  };
}

/**
 * The launch env for `agy models` / cold ACP probes: first pooled account.
 * `bin` is the picked account's install binary (null when the only usable
 * resolution is blocked — §5 п.2), `blockReason` its log text.
 */
function maintenanceEnvAndArgs(): {
  env: Record<string, string>;
  args: string[];
  home: string | null;
  /** Pool label the pick landed on, or null on relay/direct. */
  label: string | null;
  bin: string | null;
  blockReason: string | null;
} {
  const env: Record<string, string> = {};
  const args: string[] = [];
  if (dataDir !== "" && accountsEnabled(process.env)) {
    const ledger = loadLedger(dataDir);
    const account = pickAccount(ledger, listAccounts(dataDir), null, {
      locallyAvailable: (label) => locallyAvailable(ledger, label),
    });
    if (account !== null) {
      // The pick passed the §5 gate, so a non-bin resolution here is only
      // the registry/bin racing the pick — still answered honestly.
      const resolution = resolveInstall(
        dataDir,
        ledger.accounts[account.label]?.install,
      );
      if (
        resolution.kind === "unavailable" ||
        resolution.kind === "broken"
      ) {
        return {
          env,
          args,
          home: null,
          label: account.label,
          bin: null,
          blockReason: resolution.reason,
        };
      }
      if (resolution.kind === "bin") {
        for (const [key, value] of Object.entries(resolution.env)) {
          env[key] = value;
        }
      }
      args.push("--gemini-dir", join(account.home, ".gemini"));
      Object.assign(env, fileTokenStorageEnv(process.env)); // §2.3 п.14
      if (account.proxy !== null) {
        env.HTTPS_PROXY = account.proxy;
        env.https_proxy = account.proxy;
        env.HTTP_PROXY = account.proxy;
        env.http_proxy = account.proxy;
      }
      return {
        env,
        args,
        home: account.home,
        label: account.label,
        bin:
          resolution.kind === "bin"
            ? resolution.bin
            : resolveAgyCommand(process.env),
        blockReason: null,
      };
    }
  }
  if (dataDir !== "") {
    const relay = resolveCliproxyRelay(dataDir);
    if (relay !== null) {
      const resolution = resolveInstall(dataDir, undefined);
      if (
        resolution.kind === "unavailable" ||
        resolution.kind === "broken"
      ) {
        return {
          env,
          args,
          home: null,
          label: null,
          bin: null,
          blockReason: resolution.reason,
        };
      }
      if (resolution.kind === "bin") {
        for (const [key, value] of Object.entries(resolution.env)) {
          env[key] = value;
        }
      }
      args.push("--gemini-dir", join(relay.home, ".gemini"));
      env.GEMINI_API_KEY = relay.apiKey;
      env.GOOGLE_GEMINI_BASE_URL = relay.baseUrl;
      // The relay home holds the Gemini-API settings flip — without it
      // `agy models` would run on the user's real Antigravity account.
      return {
        env,
        args,
        home: relay.home,
        label: null,
        bin:
          resolution.kind === "bin"
            ? resolution.bin
            : resolveAgyCommand(process.env),
        blockReason: null,
      };
    }
    const resolution = resolveInstall(dataDir, undefined);
    if (
      resolution.kind === "unavailable" ||
      resolution.kind === "broken"
    ) {
      return {
        env,
        args,
        home: null,
        label: null,
        bin: null,
        blockReason: resolution.reason,
      };
    }
    if (resolution.kind === "bin") {
      for (const [key, value] of Object.entries(resolution.env)) {
        env[key] = value;
      }
      return {
        env,
        args,
        home: null,
        label: null,
        bin: resolution.bin,
        blockReason: null,
      };
    }
  }
  return {
    env,
    args,
    home: null,
    label: null,
    bin: resolveAgyCommand(process.env),
    blockReason: null,
  };
}

// ---------------------------------------------------------------------------
// Model list
// ---------------------------------------------------------------------------

const EFFORT_ORDER = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "ultracode",
  "max",
];

/** Levels `thought_level` accepts — shared with nativeReasoning in the launch spec. */
const THOUGHT_LEVELS = ["low", "medium", "high"];

function buildModelListResult(): {
  models: Record<string, unknown>[];
  selectedOnlyModels: string[];
} {
  const raw = modelCatalog?.raw ?? [];
  const families = new Map<
    string,
    { displayName: string; variants: Map<string, string>; explicit: boolean }
  >();
  for (const entry of raw) {
    const split = splitModelEffort(entry.id);
    const family = split?.model ?? entry.id;
    const effort = split?.effort ?? "medium";
    let fam = families.get(family);
    if (fam === undefined) {
      fam = {
        displayName:
          split === null
            ? entry.displayName
            : entry.displayName.replace(/\s*\([^)]*\)\s*$/u, "") || family,
        variants: new Map(),
        explicit: false,
      };
      families.set(family, fam);
    }
    fam.variants.set(effort, entry.id);
    if (split !== null) {
      fam.explicit = true;
    }
  }
  const flash = [...families.keys()].filter((id) => id.includes("flash"));
  const defaultFamily =
    flash.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ??
    families.keys().next().value ??
    "";
  const models = [...families.entries()].map(([id, fam]) => {
    // `agy models` now reports bare family ids — without a `<model>-<effort>`
    // suffix there is no per-id ladder to parse, so the family offers the
    // standard thought_level ladder instead of collapsing to medium only.
    const efforts = fam.explicit
      ? [...fam.variants.keys()].sort(
          (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
        )
      : THOUGHT_LEVELS;
    return {
      id,
      model: id,
      displayName: fam.displayName,
      description: "",
      supportedReasoningEfforts: efforts.map((effort) => ({
        reasoningEffort: effort,
        description: `${effort.charAt(0).toUpperCase()}${effort.slice(1)} reasoning effort`,
      })),
      defaultReasoningEffort: efforts.includes("medium")
        ? "medium"
        : (efforts[0] ?? "medium"),
      isDefault: id === defaultFamily,
    };
  });
  return { models, selectedOnlyModels: [] };
}

function queryAgyModels(): Promise<{ id: string; displayName: string }[]> {
  return new Promise((resolve) => {
    // §2.3 п.1 (ревизия 13.2): `agy models` takes no --gemini-dir — the
    // account is addressed through HOME, like the per-account probes.
    const { env, home, bin, blockReason } = maintenanceEnvAndArgs();
    if (bin === null) {
      log(`models query skipped: ${blockReason ?? "install unavailable"}`);
      resolve([]);
      return;
    }
    let child;
    try {
      child = spawn(
        bin,
        ["models"],
        {
          env: {
            ...process.env,
            ...env,
            ...(home !== null ? { HOME: home } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      resolve([]);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killProcessTreeGracefully(child);
    }, 30_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 400) {
        stderr += chunk;
      }
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      log(`models query failed: ${err.message}`);
      resolve([]);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const raw = parseAgyModelsOutput(stdout);
      if (raw.length === 0) {
        log(
          `models query failed: exit ${code ?? "signal"}` +
            (stderr.trim() !== "" ? ` — ${probeStderrTail(stderr)}` : ""),
        );
      }
      resolve(raw);
    });
  });
}

/**
 * Cold-path discovery against a live `agy acp`: session/new's configOptions
 * name the selectable model values when `agy models` cannot answer.
 */
function queryAcpSessionModels(): Promise<{ id: string; displayName: string }[]> {
  return new Promise((resolve) => {
    const { env, args, label, bin, blockReason } = maintenanceEnvAndArgs();
    if (bin === null) {
      log(`acp models query skipped: ${blockReason ?? "install unavailable"}`);
      resolve([]);
      return;
    }
    let child;
    try {
      child = spawn(process.execPath, [materializeShim(), "acp", ...args], {
        env: {
          ...process.env,
          ...env,
          ...shimRuntimeEnv(),
          AGY_SHIM_REAL_BIN: bin,
          AGY_SHIM_EVENTS: eventsFilePath(),
          AGY_SHIM_CONTROL: join(shimDir(), "ctl-models.ndjson"),
          AGY_SHIM_THREAD_ID: "__models__",
          AGY_SHIM_NONCE: "models",
          AGY_SHIM_SET_MODE: "",
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve([]);
      return;
    }
    let tail = "";
    const pending = new Map<
      number,
      (result: unknown, error: unknown) => void
    >();
    let nextId = 1;
    const timer = setTimeout(() => {
      killProcessTreeGracefully(child);
      resolve([]);
    }, 15_000);
    const send = (method: string, params: Record<string, unknown>) =>
      new Promise<{ result: unknown; error: unknown }>((res, rej) => {
        const id = nextId++;
        pending.set(id, (result, error) => res({ result, error }));
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
        setTimeout(() => rej(new Error("timeout")), 14_000).unref?.();
      });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      tail += chunk;
      for (;;) {
        const nl = tail.indexOf("\n");
        if (nl === -1) {
          break;
        }
        const line = tail.slice(0, nl);
        tail = tail.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: unknown;
          };
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            pending.get(msg.id)?.(msg.result, msg.error);
            pending.delete(msg.id);
          }
        } catch {
          // Non-JSON noise.
        }
      }
    });
    void (async () => {
      try {
        await send("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "bb", version: "1" },
        });
        const newResp = await send("session/new", {
          cwd: process.cwd(),
          mcpServers: [],
        });
        // §2.3 п.11 (ревизия 14): the probe reads session/new's error — a
        // VALIDATION_REQUIRED/ToS refusal parks the maintenance pick; the
        // probe reports nothing (the §8 cache fallback covers the list).
        if (newResp.error !== undefined && newResp.error !== null) {
          const errorText = errorMessageOf(newResp.error);
          const parkedCause = parkedCauseOf(errorText);
          if (dataDir !== "" && label !== null && parkedCause !== null) {
            parkAccountPermanently(
              label,
              parkedCause,
              errorText.slice(0, 300),
            );
            log(
              `models probe: account ${label} parked (${parkedCause}) on session/new refusal${parkedCause === "validation-required" ? "; owner verifies the account in a browser: https://support.google.com/accounts/answer/185833" : ""}`,
            );
          } else if (
            dataDir !== "" &&
            label !== null &&
            isAccountIneligible(errorText)
          ) {
            // §2.3 п.11 (ревизия 15): the eligibility family splits the
            // same way here — a verify request/link parks permanently as
            // validation-required (no cooldownUntilMs), any other refusal
            // cools for the 2h location window; the mass-park breaker is
            // checked first.
            const ledger = loadLedger(dataDir);
            if (checkIneligibleBreaker(ledger, Date.now())) {
              log(
                `models probe: ineligible breaker open; not parking ${label}`,
              );
            } else if (hasVerificationRequest(errorText)) {
              markAccountIneligible(ledger, label, {
                parkedReason: "validation-required",
                lastError: errorText.slice(0, 300),
              });
              saveLedger(dataDir, ledger);
              log(
                `models probe: account ${label} parked (validation-required) on session/new refusal; owner verifies the account in a browser: https://support.google.com/accounts/answer/185833`,
              );
            } else {
              markAccountCooldown(
                ledger,
                label,
                Date.now() + ineligibleCooldownMs(true),
                errorText.slice(0, 300),
              );
              markAccountIneligible(ledger, label);
              saveLedger(dataDir, ledger);
              log(
                `models probe: account ${label} cooled 2h (location) on session/new refusal`,
              );
            }
          }
          resolve([]);
          return;
        }
        const session = newResp.result as {
          configOptions?: {
            id?: string;
            options?: { value?: string; name?: string }[];
          }[];
        } | null;
        const options =
          session?.configOptions?.find((c) => c.id === "model")?.options ?? [];
        resolve(
          options
            .filter((o) => typeof o.value === "string" && o.value.length > 0)
            .map((o) => ({
              id: o.value as string,
              displayName: (o.name as string) ?? (o.value as string),
            })),
        );
      } catch {
        resolve([]);
      } finally {
        clearTimeout(timer);
        killProcessTreeGracefully(child);
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Per-account model catalog (spec §2.3, ADR-0030)
// ---------------------------------------------------------------------------

/** Never more than two `agy models` children at once (§2.3). */
const MAX_MODEL_PROBES = 2;
/**
 * One probe attempt per label per interval (§2.3 п.1): a failed or empty
 * poll must not respawn `agy models` on every catalog read.
 */
const MODEL_PROBE_MIN_INTERVAL_MS = 30 * 60 * 1000;
const modelProbeLastAtMs = new Map<string, number>();
const modelProbes = {
  running: 0,
  queued: new Set<string>(),
  waiters: [] as (() => void)[],
};

/**
 * Load the per-account catalog and lazily (re)poll eligible accounts whose
 * record is missing or stale. Records outlive the TTL for selection —
 * staleness only queues a probe. Never polled (§2.3 п.1): priority 0
 * accounts, parked accounts (any parkedReason), and accounts cooling down
 * past the record's whole TTL. A failed probe does not requeue the label
 * until MODEL_PROBE_MIN_INTERVAL_MS has passed.
 */
function accountModelCatalog(): AccountModelCatalog {
  if (dataDir === "" || !accountsEnabled(process.env)) {
    return {};
  }
  const catalog = loadAccountModels(dataDir);
  const ledger = loadLedger(dataDir);
  const now = Date.now();
  for (const account of listAccounts(dataDir)) {
    const entry = ledger.accounts[account.label];
    if (accountPriority(entry) <= 0) {
      continue;
    }
    if (entry?.parkedReason !== undefined) {
      continue;
    }
    // §5 п.3: an account whose install cannot run here is never probed.
    if (!locallyAvailable(ledger, account.label)) {
      continue;
    }
    if ((entry?.cooldownUntilMs ?? 0) - now > ACCOUNT_MODELS_TTL_MS) {
      continue;
    }
    const record = Object.hasOwn(catalog, account.label)
      ? catalog[account.label]
      : undefined;
    if (record !== undefined && now - record.atMs <= ACCOUNT_MODELS_TTL_MS) {
      continue;
    }
    const lastProbe = modelProbeLastAtMs.get(account.label) ?? 0;
    if (now - lastProbe < MODEL_PROBE_MIN_INTERVAL_MS) {
      continue;
    }
    queueModelProbe(account);
  }
  return catalog;
}

function queueModelProbe(account: AccountHome): void {
  if (modelProbes.queued.has(account.label)) {
    return;
  }
  modelProbes.queued.add(account.label);
  pumpModelProbes();
}

function pumpModelProbes(): void {
  while (modelProbes.running < MAX_MODEL_PROBES && modelProbes.queued.size > 0) {
    const label = modelProbes.queued.values().next().value;
    if (label === undefined) {
      break;
    }
    modelProbes.queued.delete(label);
    const account = accountByLabel(listAccounts(dataDir), label);
    if (account === null) {
      continue;
    }
    modelProbes.running += 1;
    runModelProbe(account, () => {
      modelProbes.running -= 1;
      pumpModelProbes();
      if (modelProbes.running === 0 && modelProbes.queued.size === 0) {
        for (const waiter of modelProbes.waiters.splice(0)) {
          waiter();
        }
      }
    });
  }
}

/** Strip token-looking runs from probe stderr before it hits the log. */
function probeStderrTail(stderr: string): string {
  return stderr
    .slice(0, 200)
    .replace(/[A-Za-z0-9_\-.+~]{24,}/gu, "<redacted>")
    .trim();
}

function runModelProbe(account: AccountHome, done: () => void): void {
  modelProbeLastAtMs.set(account.label, Date.now());
  // §6 п.6: the probe runs the account's own install binary — never the
  // default's — and an unavailable install does not spawn at all (§5 п.3).
  const resolution =
    dataDir !== ""
      ? resolveInstall(
          dataDir,
          loadLedger(dataDir).accounts[account.label]?.install,
        )
      : ({ kind: "legacy" } as InstallResolution);
  if (
    resolution.kind === "unavailable" ||
    resolution.kind === "broken"
  ) {
    noteInstallUnavailable(account.label, resolution.reason);
    done();
    return;
  }
  const bin =
    resolution.kind === "bin"
      ? resolution.bin
      : resolveAgyCommand(process.env);
  let child: ChildProcess;
  try {
    // §2.3 п.1 (ревизия 13.2): --gemini-dir exists only on `agy acp`;
    // `agy models` is addressed through the account's HOME (plus its proxy).
    child = spawn(
      bin,
      ["models"],
      {
        env: {
          ...process.env,
          ...(resolution.kind === "bin" ? resolution.env : {}),
          ...fileTokenStorageEnv(process.env), // §2.3 п.14
          HOME: account.home,
          ...(account.proxy !== null
            ? {
                HTTPS_PROXY: account.proxy,
                https_proxy: account.proxy,
                HTTP_PROXY: account.proxy,
                http_proxy: account.proxy,
              }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    log(`models probe for ${account.label} failed: spawn error`);
    done();
    return;
  }
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    killProcessTreeGracefully(child);
  }, 30_000);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 400) {
      stderr += chunk;
    }
  });
  child.on("error", (err: Error) => {
    clearTimeout(timer);
    log(`models probe for ${account.label} failed: ${err.message}`);
    done();
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    const raw = parseAgyModelsOutput(stdout);
    // An empty or failed answer never overwrites a previous valid record.
    if (raw.length > 0) {
      saveAccountModelRecord(dataDir, account.label, raw);
      log(`models catalog for ${account.label}: ${raw.length} entries`);
    } else {
      log(
        `models probe for ${account.label} failed: exit ${code ?? "signal"}` +
          (stderr.trim() !== "" ? ` — ${probeStderrTail(stderr)}` : ""),
      );
    }
    done();
  });
}

/** Wait for the refresh round a caller triggered to land on disk. */
function waitModelProbes(): Promise<void> {
  if (modelProbes.running === 0 && modelProbes.queued.size === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    modelProbes.waiters.push(resolve);
  });
}

/** §2.3 п.9: a cold-start pick waits on catalog probes at most this long. */
const MODEL_PICK_PROBE_WAIT_MS = 30_000;

/** waitModelProbes with the §2.3 п.9 overall cap. */
function waitModelProbesBounded(): Promise<void> {
  return Promise.race([
    waitModelProbes(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, MODEL_PICK_PROBE_WAIT_MS);
      timer.unref?.();
    }),
  ]).then(() => undefined);
}

/**
 * §2.3 пп. 9–10: queue an `agy models` probe for one account when the
 * per-label throttle allows — used for accounts a refusal just disproved
 * and for cold-start picks over record-less/empty catalogs. The §2.3 п.1
 * exclusions apply: never a parked account.
 */
function maybeProbeCatalog(label: string): void {
  if (dataDir === "" || !accountsEnabled(process.env)) {
    return;
  }
  const now = Date.now();
  if (now - (modelProbeLastAtMs.get(label) ?? 0) < MODEL_PROBE_MIN_INTERVAL_MS) {
    return;
  }
  const ledger = loadLedger(dataDir);
  if (ledger.accounts[label]?.parkedReason !== undefined) {
    return;
  }
  if (!locallyAvailable(ledger, label)) {
    return;
  }
  const account = accountByLabel(listAccounts(dataDir), label);
  if (account !== null) {
    queueModelProbe(account);
  }
}

/**
 * §2.3 п.9 cold start: no probe-eligible account's record names the family
 * while at least one has no usable record (absent or families: []) — the
 * pick must wait for `agy models` answers instead of guessing. Returns
 * true when probes worth waiting on were queued.
 */
function coldStartNeedsProbes(family: string): boolean {
  if (dataDir === "" || !accountsEnabled(process.env)) {
    return false;
  }
  const ledger = loadLedger(dataDir);
  const catalog = accountModelCatalog();
  const now = Date.now();
  let supporter = false;
  let waitWorthy = false;
  for (const account of listAccounts(dataDir)) {
    const entry = ledger.accounts[account.label];
    if (accountPriority(entry) <= 0) {
      continue;
    }
    if (entry?.parkedReason !== undefined) {
      continue;
    }
    if (!locallyAvailable(ledger, account.label)) {
      continue;
    }
    if ((entry?.cooldownUntilMs ?? 0) - now > ACCOUNT_MODELS_TTL_MS) {
      continue;
    }
    const record = Object.hasOwn(catalog, account.label)
      ? catalog[account.label]
      : undefined;
    if (record !== undefined && record.families.includes(family)) {
      supporter = true;
      continue;
    }
    // A record with no families is "unknown" (e.g. refusal marks on a
    // virgin account): it must be probed like a missing one — and the
    // pick waits on its probe whether it is queued, already running, or
    // just throttled out (§2.3 п.9, ревизия 13.1). waitModelProbes
    // resolves instantly when nothing is actually in flight, so a
    // throttled unknown costs no real wait.
    if (record === undefined || record.families.length === 0) {
      waitWorthy = true;
      if (now - (modelProbeLastAtMs.get(account.label) ?? 0) >= MODEL_PROBE_MIN_INTERVAL_MS) {
        queueModelProbe(account);
      }
    }
  }
  return !supporter && waitWorthy;
}

/**
 * The union of every eligible account's `raw` catalog — deduped by id,
 * first displayName wins (§2.3) — or null while no account catalog record
 * exists at all, which keeps the legacy cold fallback alive.
 */
async function mergedAccountCatalog(): Promise<
  { id: string; displayName: string }[] | null
> {
  if (dataDir === "" || !accountsEnabled(process.env)) {
    return null;
  }
  accountModelCatalog(); // kick the lazy refresh
  await waitModelProbes();
  const fresh = loadAccountModels(dataDir);
  const ledger = loadLedger(dataDir);
  const eligible = listAccounts(dataDir)
    .filter(
      (a) =>
        accountPriority(ledger.accounts[a.label]) > 0 &&
        ledger.accounts[a.label]?.parkedReason === undefined &&
        locallyAvailable(ledger, a.label),
    )
    .sort((a, b) => a.label.localeCompare(b.label));
  const seen = new Set<string>();
  const merged: { id: string; displayName: string }[] = [];
  for (const account of eligible) {
    const record = Object.hasOwn(fresh, account.label)
      ? fresh[account.label]
      : undefined;
    if (record === undefined) {
      continue;
    }
    for (const entry of record.raw) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        merged.push(entry);
      }
    }
  }
  return merged.length > 0 ? merged : null;
}

/**
 * Can any eligible account serve the family right now? Catalog-less
 * accounts count — only a fresh catalog that lacks the family (or a fresh
 * refusal mark) disqualifies.
 */
function poolOffersModel(
  ledger: AccountsLedger,
  accounts: AccountHome[],
  catalog: AccountModelCatalog,
  family: string,
): boolean {
  const now = Date.now();
  return accounts.some(
    (a) =>
      accountPriority(ledger.accounts[a.label]) > 0 &&
      ledger.accounts[a.label]?.parkedReason === undefined &&
      locallyAvailable(ledger, a.label) &&
      accountModelState(
        Object.hasOwn(catalog, a.label) ? catalog[a.label] : undefined,
        family,
        now,
      ) !== "unsupported",
  );
}

function handleModelList(id: JsonRpcId): void {
  if (!modelCacheStale()) {
    sendResult(id, buildModelListResult());
    return;
  }
  void (async () => {
    // §2.3: the provider's model list is the union of the per-account
    // catalogs; the single-account probe stays as the cold fallback while
    // no account catalog exists.
    const merged = await mergedAccountCatalog();
    if (merged !== null) {
      modelCatalog = { raw: merged, atMs: Date.now() };
      saveModelDiskCache();
      sendResult(id, buildModelListResult());
      return;
    }
    let raw = await queryAgyModels();
    if (raw.length === 0) {
      raw = await queryAcpSessionModels();
    }
    if (raw.length > 0) {
      modelCatalog = { raw, atMs: Date.now() };
      saveModelDiskCache();
    } else if (modelCatalog === null) {
      // Nothing to serve and nothing cached: report one honest default.
      modelCatalog = {
        raw: [{ id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" }],
        atMs: Date.now(),
      };
    }
    sendResult(id, buildModelListResult());
  })().catch((error: unknown) => {
    sendError(id, -32000, error instanceof Error ? error.message : String(error));
  });
}

// ---------------------------------------------------------------------------
// Internal requests (synthesized thread/start, turn/start, resolutions)
// ---------------------------------------------------------------------------

let internalIdCounter = 0;
const internalWaiters = new Map<
  number,
  (ok: boolean, result: unknown, error: unknown) => void
>();

function internalRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result: unknown; error: unknown }> {
  internalIdCounter -= 1;
  const id = internalIdCounter;
  return new Promise((resolve) => {
    internalWaiters.set(id, (ok, result, error) => {
      resolve({ ok, result, error });
    });
    feedLine({ jsonrpc: "2.0", id, method, params });
  });
}

// ---------------------------------------------------------------------------
// Rate-limit snapshots
// ---------------------------------------------------------------------------

function emitRateLimits(
  session: WSession,
  status: "blocked" | "allowed",
  resetsAtMs: number | null,
  reason: string | null,
): void {
  let effectiveResetsAtMs = resetsAtMs;
  if (status === "blocked" && session.accountLabel === null) {
    // §2.3 п.13 (ревизия 18): direct mode & relay: clamp to DEFAULT_QUOTA_COOLDOWN_MS
    const maxResetsAt = Date.now() + DEFAULT_QUOTA_COOLDOWN_MS;
    effectiveResetsAtMs =
      resetsAtMs !== null
        ? Math.min(resetsAtMs, maxResetsAt)
        : maxResetsAt;
  }
  emitDeltas(session.threadId, {
    kind: "provider.rateLimits",
    rateLimits: {
      providerId: "agy",
      status,
      kind: "subscription-window",
      windows: [
        {
          providerKey: null,
          label: "Gemini individual quota",
          status,
          resetsAtMs: effectiveResetsAtMs,
        },
      ],
      reachedReason: reason,
      overageStatus: null,
      overageReason: null,
    },
  });
  session.rateLimitsBlocked = status === "blocked";
  session.blockedResetsAtMs = status === "blocked" ? effectiveResetsAtMs : null;

  if (status === "blocked" && session.accountLabel === null) {
    // §2.3 п.13 (ревизия 18): all daemon turns currently in session.queue
    // immediately fail with honest rate-limit refusal (HTTP 429, settlesTurn: true)
    const retryMsg =
      reason ?? "⚠ Rate limit reached (429): slow down and try again later.";
    const info = {
      category: "rate-limit" as const,
      providerCode: null,
      httpStatusCode: 429,
    };
    const remaining: QueuedTurn[] = [];
    for (const item of session.queue) {
      if (item.kind === "daemon") {
        emitDeltas(session.threadId, {
          kind: "provider.error",
          message: retryMsg,
          errorInfo: info,
          category: info.category,
          settlesTurn: true,
        });
        sendError(item.requestId, -32000, retryMsg);
      } else {
        remaining.push(item);
      }
    }
    session.queue = remaining;

    if (session.unblockTimer !== null) {
      clearTimeout(session.unblockTimer);
      session.unblockTimer = null;
    }
    const delay = Math.max(
      0,
      (effectiveResetsAtMs ?? Date.now() + DEFAULT_QUOTA_COOLDOWN_MS) -
        Date.now(),
    );
    session.unblockTimer = setTimeout(() => {
      session.unblockTimer = null;
      if (session.stopped || sessions.get(session.threadId) !== session) {
        return;
      }
      session.rateLimitsBlocked = false;
      session.blockedResetsAtMs = null;
      emitRateLimits(session, "allowed", null, null);
      drainQueue(session);
    }, delay);
    session.unblockTimer.unref?.();
  } else if (status === "allowed") {
    if (session.unblockTimer !== null) {
      clearTimeout(session.unblockTimer);
      session.unblockTimer = null;
    }
  }
}

function clearRateLimit(session: WSession): void {
  if (session.rateLimitsBlocked) {
    if (session.unblockTimer !== null) {
      clearTimeout(session.unblockTimer);
      session.unblockTimer = null;
    }
    session.rateLimitsBlocked = false;
    session.blockedResetsAtMs = null;
    emitRateLimits(session, "allowed", null, null);
  }
}

// ---------------------------------------------------------------------------
// Turn queue: the generic bridge runs one prompt per session at a time; the
// wrapper serializes daemon turns and its own synthesized turns here.
// ---------------------------------------------------------------------------

function enqueueDaemonTurn(
  session: WSession,
  requestId: JsonRpcId,
  params: Record<string, unknown>,
): void {
  session.queue.push({ kind: "daemon", requestId, params });
}

function drainQueue(session: WSession): void {
  for (;;) {
    if (
      session.stopped ||
      session.bridgeTurnBusy ||
      session.restoring ||
      session.queue.length === 0
    ) {
      return;
    }
    const head = session.queue[0];
    // Daemon turns wait out rotations and the compaction automaton; internal
    // turns ARE the automaton and always drain.
    if (
      head.kind === "daemon" &&
      (session.rotating || session.compact !== null || session.rateLimitsBlocked)
    ) {
      return;
    }
    session.queue.shift();
    if (head.kind === "daemon") {
      const params = head.params;
      params.options = rewriteOptions(session, optionsRecord(params.options));
      session.lastTurnPrompt = promptText(params.input as PromptItem[]);
      feedLine({
        jsonrpc: "2.0",
        id: head.requestId,
        method: "turn/start",
        params,
      });
      // The bridge answers this request id itself when the prompt is accepted.
      return;
    }
    // Internal turn: minted request id, response swallowed; its boundary
    // drives the next automaton step via onSettled.
    internalIdCounter -= 1;
    const id = internalIdCounter;
    const params: Record<string, unknown> = {
      threadId: session.threadId,
      input: head.input,
      options: {
        providerOptions: providerOptionsFor(session),
        envVars: session.envVars,
        ...mapPermissionMode(session.declaredMode).policy,
      },
    };
    internalWaiters.set(id, (ok, _r, error) => {
      if (!ok) {
        log(
          `internal turn/start rejected for ${session.threadId} (${head.tag}): ${JSON.stringify(error)?.slice(0, 400)}`,
        );
      }
    });
    params.providerThreadId = session.providerThreadId ?? session.threadId;
    params.clientRequestId = `creq_zzzzzzzz${"23456789abcdefghjkmnpqrstuvwxyz"[-id % 24]}${"23456789abcdefghjkmnpqrstuvwxyz"[-id % 23]}`;
    if (head.suppressOpen) {
      session.suppressOpenNext = true;
    }
    if (head.suppressAccepted) {
      session.suppressAcceptedNext = true;
    }
    session.settledInternal = head.onSettled;
    if (head.consumeRequestId !== undefined) {
      sendResult(head.consumeRequestId, { threadId: session.threadId });
    }
    if (head.consumeClientRequestId !== undefined) {
      emitDeltas(session.threadId, {
        kind: "input.accepted",
        clientRequestId: head.consumeClientRequestId,
      });
    }
    log(
      `injecting internal turn ${head.tag} on ${session.threadId} (queue left ${session.queue.length})`,
    );
    feedLine({ jsonrpc: "2.0", id, method: "turn/start", params });
    return;
  }
}

// ---------------------------------------------------------------------------
// Rotation automaton (spec §3)
// ---------------------------------------------------------------------------

function sessionAccountCooled(
  session: WSession,
): { cooled: boolean; untilMs: number } {
  if (
    dataDir === "" ||
    !accountsEnabled(process.env) ||
    session.accountLabel === null
  ) {
    return { cooled: false, untilMs: 0 };
  }
  const ledger = loadLedger(dataDir);
  const untilMs = ledger.accounts[session.accountLabel]?.cooldownUntilMs ?? 0;
  return { cooled: untilMs > Date.now(), untilMs };
}

function freeSibling(
  session: WSession,
  exclude: string | null,
  options: { freshModelOnly?: boolean } = {},
): { account: { label: string; home: string; proxy: string | null } | null } {
  if (dataDir === "" || !accountsEnabled(process.env)) {
    return { account: null };
  }
  const ledger = loadLedger(dataDir);
  let accounts = listAccounts(dataDir);
  if (options.freshModelOnly === true && session.model !== undefined) {
    // §2.3 п.10: a move after a model refusal may land only on an account
    // whose FRESH catalog names the family — stale records and unpolled
    // accounts are exactly the guesses that chained the live incident.
    const now = Date.now();
    const catalog = loadAccountModels(dataDir);
    accounts = accounts.filter((a) => {
      const record = Object.hasOwn(catalog, a.label)
        ? catalog[a.label]
        : undefined;
      return (
        record !== undefined &&
        now - record.atMs <= ACCOUNT_MODELS_TTL_MS &&
        accountModelState(record, session.model as string, now) === "supports"
      );
    });
  }
  // §2.3: a sibling must also offer the session's model family — the
  // catalog drives the filter, an unpolled account only counts as a
  // last resort behind known supporters.
  const candidate = pickAccount(ledger, accounts, exclude, {
    family: session.model ?? null,
    models: accountModelCatalog(),
    locallyAvailable: (label) => locallyAvailable(ledger, label),
  });
  if (candidate === null) {
    return { account: null };
  }
  const until = ledger.accounts[candidate.label]?.cooldownUntilMs ?? 0;
  if (until > Date.now()) {
    return { account: null };
  }
  return { account: candidate };
}

/**
 * Permanent parking for a bare pool label (§2.3 пп. 7, 11): far-future
 * cooldown + parkedReason, manual operator unpark only. Session-bound
 * callers go through coolSessionAccount for the thread-tagged log line;
 * session-less paths (the models probe) call this directly.
 */
function parkAccountPermanently(
  label: string,
  cause: "tos-disabled" | "validation-required",
  message: string,
): void {
  if (dataDir === "") {
    return;
  }
  const ledger = loadLedger(dataDir);
  markAccountCooldown(ledger, label, TOS_DISABLED_COOLDOWN_UNTIL_MS, message);
  markAccountIneligible(ledger, label, { parkedReason: cause });
  saveLedger(dataDir, ledger);
}

/**
 * Book the failure on the session's account: quota cools it (reset text or
 * the default 30m), an eligibility refusal parks it for the long cooldown —
 * unless the breaker sees a wave of parkings and suspects the egress. A
 * tos-disabled refusal parks permanently (manual unpark only, no breaker);
 * a model refusal needs nothing here — its mark already lives in
 * accounts-models.json.
 */
function coolSessionAccount(
  session: WSession,
  cause: RotationCause,
  message: string,
): "cooled" | "breaker" | "none" {
  if (
    dataDir === "" ||
    !accountsEnabled(process.env) ||
    session.accountLabel === null
  ) {
    return "none";
  }
  const ledger = loadLedger(dataDir);
  const now = Date.now();
  if (cause === "model") {
    return "none";
  }
  if (cause === "tos-disabled" || cause === "validation-required") {
    // Permanent parking: no retry timer, no breaker — only a manual
    // operator unpark brings this account back (§2.3 пп. 7, 11).
    parkAccountPermanently(session.accountLabel, cause, message);
    log(
      cause === "validation-required"
        ? `thread ${session.threadId}: account ${session.accountLabel} parked (validation-required; manual unpark required); owner verifies the account in a browser: https://support.google.com/accounts/answer/185833`
        : `thread ${session.threadId}: account ${session.accountLabel} parked (tos-disabled; manual unpark required)`,
    );
    return "cooled";
  }
  if (cause === "ineligible" || cause === "auth-dead") {
    if (checkIneligibleBreaker(ledger, now)) {
      log(
        `thread ${session.threadId}: ${cause} breaker open; not parking ${session.accountLabel}`,
      );
      return "breaker";
    }
    // §2.3 п.11 (ревизия 15, решение владельца 19.11): a refusal asking the
    // owner to verify the account — "verify your account" (with or without
    // "to continue") or an accounts.google.com link — parks permanently as
    // validation-required: parkedReason + ineligibleAtMs + lastError, with
    // NO cooldownUntilMs — the parked mark alone keeps it out of selection.
    if (cause === "ineligible" && hasVerificationRequest(message)) {
      markAccountIneligible(ledger, session.accountLabel, {
        parkedReason: "validation-required",
        lastError: message.slice(0, 300),
      });
      saveLedger(dataDir, ledger);
      log(
        `thread ${session.threadId}: account ${session.accountLabel} parked (validation-required; manual unpark required); owner verifies the account in a browser: https://support.google.com/accounts/answer/185833`,
      );
      return "cooled";
    }
    // Every other eligibility refusal (region or generic, no verification
    // request/link) takes the short 2h cooldown; auth-dead keeps 24h.
    const location = cause === "ineligible";
    markAccountCooldown(
      ledger,
      session.accountLabel,
      now + ineligibleCooldownMs(location),
      message,
    );
    markAccountIneligible(ledger, session.accountLabel, {
      ...(cause === "auth-dead" ? { parkedReason: "auth-dead" } : {}),
    });
    saveLedger(dataDir, ledger);
    log(
      `thread ${session.threadId}: account ${session.accountLabel} parked (${cause === "auth-dead" ? "auth-dead" : "location"})`,
    );
    return "cooled";
  }
  const resetAt = quotaResetAtMs(message) ?? now + DEFAULT_QUOTA_COOLDOWN_MS;
  markAccountCooldown(
    ledger,
    session.accountLabel,
    resetAt + QUOTA_RETRY_JITTER_MS,
    message,
  );
  saveLedger(dataDir, ledger);
  log(
    `thread ${session.threadId}: account ${session.accountLabel} cooled until ${new Date(resetAt + QUOTA_RETRY_JITTER_MS).toISOString()}`,
  );
  return "cooled";
}

/**
 * Decide what a quota/eligibility failure does to the still-open daemon
 * turn: rotate now on a free sibling, wait inside for a reopening window, or
 * let the failure reach the daemon (provider-retry reads the errorInfo).
 */
function planRotation(
  session: WSession,
  cause: RotationCause,
  message: string,
): "rotate" | "wait" | "fail" {
  const cooled = coolSessionAccount(session, cause, message);
  if (cooled === "breaker") {
    return "fail";
  }
  // §2.3 п.10: one move for a model refusal, and only onto a fresh-catalog
  // supporter — the second refusal for the same family fails honestly.
  if (
    cause === "model" &&
    session.model !== undefined &&
    session.modelRefusalMoved.has(session.model)
  ) {
    return "fail";
  }
  const { account } = freeSibling(session, session.accountLabel, {
    freshModelOnly: cause === "model",
  });
  if (account !== null) {
    return "rotate";
  }
  if (cause !== "quota") {
    // Dead causes never wait on a cooldown clock: rotate or fail. A model
    // refusal fails honestly — the session's model decides which accounts
    // could ever be siblings, so waiting cannot help.
    return "fail";
  }
  const resetAt = quotaResetAtMs(message);
  const waitMs =
    resetAt === null
      ? Number.POSITIVE_INFINITY // no clock to wait on honestly
      : Math.max(resetAt + QUOTA_RETRY_JITTER_MS - Date.now(), 1_000);
  if (
    session.autoRetryCount < quotaRetryMaxAttempts() &&
    waitMs <= quotaRetryMaxWaitMs()
  ) {
    session.autoRetryCount += 1;
    session.waitUntilMs = waitMs;
    return "wait";
  }
  return "fail";
}

function nearestCooldownEnd(session: WSession): number | null {
  if (dataDir === "") {
    return null;
  }
  const ledger = loadLedger(dataDir);
  // §2.3: the reported resetsAt is computed over accounts that could serve
  // the session's model — a cooled account without the family must not
  // pull the estimate early.
  const catalog = accountModelCatalog();
  const family = session.model;
  const now = Date.now();
  const ends = listAccounts(dataDir)
    .filter(
      (a) =>
        accountPriority(ledger.accounts[a.label]) > 0 &&
        ledger.accounts[a.label]?.parkedReason === undefined &&
        locallyAvailable(ledger, a.label),
    )
    .filter(
      (a) =>
        family === undefined ||
        accountModelState(
          Object.hasOwn(catalog, a.label) ? catalog[a.label] : undefined,
          family,
          now,
        ) !== "unsupported",
    )
    .map((a) => ledger.accounts[a.label]?.cooldownUntilMs ?? 0)
    .filter((ms) => ms > now);
  return ends.length > 0 ? Math.min(...ends) : null;
}

/**
 * The failure reaches the daemon: a provider.error carrying the native
 * errorInfo provider-retry reads, the blocked rateLimits snapshot, and — for
 * a turn the daemon still holds open — the failed boundary that closes it.
 */
function failOut(
  session: WSession,
  message: string,
  options: { blockedUntilMs?: number } = {},
): void {
  resolveInteractions(session.threadId);
  const pending = session.pendingConsume;
  if (pending !== null) {
    sendError(pending.requestId, -32000, message);
    session.pendingConsume = null;
  }
  const info =
    options.blockedUntilMs !== undefined
      ? { category: "rate-limit" as const, providerCode: null, httpStatusCode: 429 }
      : nativeErrorInfo(message);
  // A refusal answered on the turn/start request already surfaces as
  // "Command turn.submit failed" — a provider.error delta would print the
  // same text a second time (E2E C6). Rate-limit refusals still emit it:
  // provider-retry reads the errorInfo from the delta, not the reply.
  const retrySignal =
    options.blockedUntilMs !== undefined || info?.category === "rate-limit";
  if (!(pending !== null && !session.daemonTurnOpen && !retrySignal)) {
    emitDeltas(session.threadId, {
      kind: "provider.error",
      message,
      ...(info === undefined ? {} : { errorInfo: info, category: info.category }),
      settlesTurn: true,
    });
  }
  if (session.daemonTurnOpen) {
    emitDeltas(session.threadId, {
      kind: "turn.boundary",
      status: "failed",
      error: { message },
    });
    session.daemonTurnOpen = false;
  }
  if (options.blockedUntilMs !== undefined) {
    emitRateLimits(session, "blocked", options.blockedUntilMs, message);
  } else if (classifyError(message) === "rate-limit") {
    emitRateLimits(
      session,
      "blocked",
      quotaResetAtMs(message) ?? nearestCooldownEnd(session),
      message,
    );
  }
  session.rotating = false;
  session.rotationCause = null;
  drainQueue(session);
}

/**
 * §2.3 п.5: a model failure ends two ways. No pool account can serve the
 * family → the honest "not offered" refusal, no cooldowns, no rotation.
 * Suitable carriers exist but every one is cooling → the §3
 * whole-pool-cooled branch: provider.error carrying rate-limit errorInfo
 * and rateLimits blocked until the nearest suitable resetsAt, so
 * provider-retry waits the window out and re-runs the turn.
 */
function failOutModel(session: WSession, message: string): void {
  const resetsAt = nearestCooldownEnd(session);
  if (resetsAt === null) {
    failOut(
      session,
      `model ${session.model ?? "?"} is not offered by any pool account`,
    );
    return;
  }
  failOut(
    session,
    `model ${session.model ?? "?"} is cooling on every pool account that offers it; ` +
      `earliest window reopens at ${new Date(resetsAt).toISOString()} (${message})`,
    { blockedUntilMs: resetsAt },
  );
}

/** Synthesize thread/start for the session's current account. */
function synthThreadStart(session: WSession): Promise<{
  ok: boolean;
  result: unknown;
  error: unknown;
}> {
  const params = {
    ...session.baseParams,
    threadId: session.threadId,
    cwd: session.cwd,
    options: rewriteOptions(session, { ...session.baseOptions }),
  };
  delete (params as { providerThreadId?: unknown }).providerThreadId;
  return internalRequest("thread/start", params);
}

/**
 * Drive the rotation: a fresh session on the sibling, sessionReplaced, then
 * the handoff turn carrying the interrupted prompt.
 */
function startRotation(
  session: WSession,
  cause: RotationCause,
  message: string,
  allowSameAccount = false,
): void {
  // The dying session's pending permission dialogs would hang in the UI
  // forever — resolve them before the session is released or replaced.
  resolveInteractions(session.threadId);
  // A quota-wait retry may land back on the session's own account: that is
  // the window it waited on — every other caller rotates OFF it (§2.3).
  const { account } = freeSibling(
    session,
    allowSameAccount ? null : session.accountLabel,
    { freshModelOnly: cause === "model" },
  );
  if (account === null) {
    log(
      `thread ${session.threadId}: rotation found no free sibling; failing out`,
    );
    if (cause === "model") {
      // §2.3 п.10: nothing fresh-catalogued carries the family — probe the
      // refuser so the next pick knows better, then fail honestly.
      if (session.accountLabel !== null) {
        maybeProbeCatalog(session.accountLabel);
      }
      failOutModel(session, message);
    } else {
      failOut(session, poolExhaustedText(cause, message));
    }
    return;
  }
  session.rotating = true;
  session.rotationCause = cause;
  if (cause === "model" && session.model !== undefined) {
    session.modelRefusalMoved.add(session.model);
  }
  const movedFrom = session.accountLabel;
  session.accountLabel = account.label;
  session.envVars = filterEnvVars(
    session.baseOptions.envVars,
    session.accountLabel !== null,
  );
  if (dataDir !== "") {
    const ledger = loadLedger(dataDir);
    markAccountUse(ledger, account.label);
    saveLedger(dataDir, ledger);
  }
  const launchError = buildLaunch(session);
  // §2.3 п.12: every move is journaled — thread, from → to, reason.
  const moveInstall = installNameFor(account.label);
  log(
    `thread ${session.threadId}: move ${movedFrom ?? "none"} → ${account.label} (${cause}${moveInstall !== null ? `, install=${moveInstall}` : ""})`,
  );
  if (launchError !== null) {
    // The sibling's install went unavailable between pick and launch:
    // §5 п.2 forbids the substitute binary — drop this sibling and let
    // the automaton pick the next candidate (locallyAvailable already
    // excludes it, so the retry cannot loop on the same account).
    log(
      `thread ${session.threadId}: sibling ${account.label} cannot launch: ${launchError}`,
    );
    startRotation(session, cause, message);
    return;
  }
  void synthThreadStart(session).then(({ ok, error }) => {
    if (ok) {
      // Only now is the generic bridge's session registered — inject the
      // queued handoff turn.
      drainQueue(session);
      return;
    }
    const errorText = errorMessageOf(error);
    log(
      `thread ${session.threadId}: rotation session failed to start: ${errorText.slice(0, 300)}`,
    );
    // A model refusal disproves the sibling's catalog record: mark the
    // family unsupported. For the "model" cause this was the one allowed
    // move (§2.3 п.10) — probe the refuser and fail honestly instead of
    // chaining to the next guess.
    if (
      dataDir !== "" &&
      session.model !== undefined &&
      isModelRefusal(errorText)
    ) {
      markAccountModelUnsupported(dataDir, account.label, session.model);
      if (cause === "model") {
        maybeProbeCatalog(account.label);
        failOutModel(session, message);
        return;
      }
      startRotation(session, cause, message);
      return;
    }
    // §2.3 п.11 (ревизия 13.1): a sibling answering the internal start
    // with VALIDATION_REQUIRED/ToS parks permanently — never the 60 s
    // blind cooldown — and the rotation moves to the next free one. The
    // same split covers the eligibility family (ревизия 15).
    const parkedCause = internalRefusalCauseOf(errorText);
    if (dataDir !== "" && parkedCause !== null) {
      coolSessionAccount(session, parkedCause, errorText.slice(0, 300));
      startRotation(session, cause, message);
      return;
    }
    // Park this sibling briefly and try the next; give up into failOut.
    if (dataDir !== "") {
      const ledger = loadLedger(dataDir);
      markAccountCooldown(
        ledger,
        account.label,
        Date.now() + 60_000,
        "session start failed",
      );
      saveLedger(dataDir, ledger);
    }
    startRotation(session, cause, message);
  });
}

function scheduleWaitRetry(
  session: WSession,
  cause: RotationCause,
  message: string,
): void {
  const waitMs = session.waitUntilMs;
  session.rotating = true;
  session.rotationCause = cause;
  session.waitTimer = setTimeout(() => {
    session.waitTimer = null;
    if (session.stopped || sessions.get(session.threadId) !== session) {
      return;
    }
    log(`thread ${session.threadId}: quota wait elapsed; retrying rotation`);
    session.rotating = false;
    startRotation(session, cause, message, true);
  }, waitMs);
  session.waitTimer.unref?.();
  log(
    `thread ${session.threadId}: whole pool cooling; internal retry in ${Math.round(waitMs / 1000)}s (attempt ${session.autoRetryCount}/${quotaRetryMaxAttempts()})`,
  );
}

/** The classified error now decides the open turn's fate. */
function poolExhaustedText(cause: RotationCause, message: string): string {
  return cause === "auth-dead"
    ? `${message} — every pool account lost its Google sign-in; re-authenticate one and retry`
    : message;
}

function handleCompactClassifiedError(
  session: WSession,
  cause: RotationCause,
  message: string,
): void {
  const compact = session.compact;
  if (compact === null) {
    return;
  }
  // §2.3 п.13 (ревизия 18): if refusal hits at compact-summary stage,
  // prepare seed prompt from partial summaryBuf (if non-empty) or memo prompt.
  if (compact.stage === "summary") {
    const summary = compact.summaryBuf.trim();
    const usable = summary.length > 0;
    compact.collecting = false;
    compact.seedPromptText = usable
      ? compactSeedPrompt(summary, session.threadId)
      : compactMemoPrompt({
          recentAssistantText: session.recentAssistantText,
          cwd: session.cwd,
          threadId: session.threadId,
        });
  }

  const plan = planRotation(session, cause, message);
  switch (plan) {
    case "rotate": {
      if (compact.seedAttempts >= COMPACT_SEED_MAX_ATTEMPTS) {
        session.compact = null;
        session.settledInternal = null;
        failOut(session, poolExhaustedText(cause, message));
        return;
      }
      const { account } = freeSibling(session, session.accountLabel);
      if (account !== null) {
        const movedFrom = session.accountLabel;
        session.accountLabel = account.label;
        session.envVars = filterEnvVars(
          session.baseOptions.envVars,
          session.accountLabel !== null,
        );
        if (dataDir !== "") {
          const ledger = loadLedger(dataDir);
          markAccountUse(ledger, account.label);
          saveLedger(dataDir, ledger);
        }
        buildLaunch(session);
        log(
          `thread ${session.threadId}: move ${movedFrom ?? "none"} → ${account.label} (compaction ${cause})`,
        );
        runCompactSeed(session);
      } else {
        session.compact = null;
        session.settledInternal = null;
        failOut(
          session,
          cause === "validation-required"
            ? `account ${session.accountLabel ?? "?"} needs Google account verification and no free pool account can take over the compaction fallback`
            : cause === "tos-disabled"
              ? `account ${session.accountLabel ?? "?"} was disabled by Google (Terms of Service) and no free pool account can take over the compaction fallback`
              : poolExhaustedText(cause, message),
        );
      }
      return;
    }
    case "wait": {
      session.settledInternal = null;
      const waitMs = session.waitUntilMs;
      session.waitTimer = setTimeout(() => {
        session.waitTimer = null;
        if (session.stopped || sessions.get(session.threadId) !== session) {
          return;
        }
        log(
          `thread ${session.threadId}: compaction wait elapsed; running compact seed on cooled account`,
        );
        if (session.compact !== null) {
          buildLaunch(session);
          runCompactSeed(session);
        } else {
          drainQueue(session);
        }
      }, waitMs);
      session.waitTimer.unref?.();
      log(
        `thread ${session.threadId}: whole pool cooling during compaction; seed retry in ${Math.round(waitMs / 1000)}s (attempt ${session.autoRetryCount}/${quotaRetryMaxAttempts()})`,
      );
      return;
    }
    case "fail": {
      session.compact = null;
      session.settledInternal = null;
      failOut(
        session,
        cause === "validation-required"
          ? `account ${session.accountLabel ?? "?"} needs Google account verification and no free pool account can take over the compaction fallback`
          : cause === "tos-disabled"
            ? `account ${session.accountLabel ?? "?"} was disabled by Google (Terms of Service) and no free pool account can take over the compaction fallback`
            : poolExhaustedText(cause, message),
      );
      return;
    }
  }
}

function handleClassifiedError(
  session: WSession,
  cause: RotationCause,
  message: string,
): void {
  if (session.compact !== null) {
    handleCompactClassifiedError(session, cause, message);
    return;
  }
  const plan = planRotation(session, cause, message);
  switch (plan) {
    case "rotate":
      startRotation(session, cause, message);
      return;
    case "wait":
      scheduleWaitRetry(session, cause, message);
      return;
    case "fail":
      if (cause === "model") {
        // §2.3 п.10: no fresh supporter to move to — re-poll the refuser's
        // catalog (throttle permitting) so the next pick knows better.
        if (session.accountLabel !== null) {
          maybeProbeCatalog(session.accountLabel);
        }
        failOutModel(session, message);
      } else {
        failOut(session, poolExhaustedText(cause, message));
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// Handoff: the rotation's replay turn
// ---------------------------------------------------------------------------

function queueHandoffTurn(session: WSession, consume?: QueuedDaemonTurn): void {
  const daemonOpen = session.daemonTurnOpen;
  const prompt =
    consume !== undefined
      ? promptText(consume.params.input as PromptItem[] | undefined)
      : (session.lastTurnPrompt ?? "");
  const text = buildQuotaHandoffPrompt({
    prompt,
    recentAssistantText: session.recentAssistantText,
    cwd: session.cwd,
    queuedFollowers: session.queue.length,
  });
  session.queue.unshift({
    kind: "internal",
    tag: "handoff",
    input: [{ type: "text", text }],
    suppressOpen: daemonOpen,
    suppressAccepted: true,
    consumeRequestId: consume?.requestId,
    consumeClientRequestId:
      typeof consume?.params.clientRequestId === "string"
        ? consume.params.clientRequestId
        : undefined,
    onSettled: (s, status) => {
      if (status === "completed") {
        s.autoRetryCount = 0;
        clearRateLimit(s);
      }
      s.rotating = false;
      s.rotationCause = null;
      drainQueue(s);
    },
  });
}

// ---------------------------------------------------------------------------
// Compaction fallback (ADR-0003 in the wrapper)
// ---------------------------------------------------------------------------

function startCompactFallback(session: WSession): void {
  if (!compactFallbackEnabled()) {
    return;
  }
  session.compact = {
    stage: "summary",
    summaryBuf: "",
    collecting: true,
    seedAttempts: 0,
    oldProviderThreadId: session.providerThreadId,
    seedPromptText: "",
  };
  session.queue.unshift({
    kind: "internal",
    tag: "compact-summary",
    input: [{ type: "text", text: compactSummaryPrompt() }],
    suppressOpen: false,
    suppressAccepted: true,
    onSettled: (s, status) => {
      const summary = s.compact?.summaryBuf.trim() ?? "";
      const usable = status === "completed" && summary.length > 0;
      if (s.compact !== null) {
        s.compact.collecting = false;
        s.compact.seedPromptText = usable
          ? compactSeedPrompt(summary, s.threadId)
          : compactMemoPrompt({
              recentAssistantText: s.recentAssistantText,
              cwd: s.cwd,
              threadId: s.threadId,
            });
      }
      runCompactSeed(s);
    },
  });
  log(
    `thread ${session.threadId}: compaction failed; asking the agent for its own summary`,
  );
  drainQueue(session);
}

function runCompactSeed(session: WSession): void {
  const compact = session.compact;
  if (compact === null) {
    return;
  }
  compact.stage = "seed";
  compact.seedAttempts += 1;
  sendNotification("session/replaced", {
    threadId: session.threadId,
    providerThreadId: null,
    reason:
      "agy could not compact this conversation; the thread continues on a fresh conversation that starts from the agent's own summary of the old one",
    contextLost: true,
  });
  void synthThreadStart(session).then(({ ok, error }) => {
    if (!ok) {
      const errorText = errorMessageOf(error);
      // §2.3 п.11 (ревизия 14): the internal start reads its error — a
      // VALIDATION_REQUIRED/ToS refusal parks the account and moves the
      // compaction to a sibling; staying on the dead session is not an
      // option.
      const parkedCause =
        dataDir !== "" ? internalRefusalCauseOf(errorText) : null;
      if (parkedCause !== null) {
        compactParked(session, parkedCause, errorText);
        return;
      }
      if (classifyError(errorText) === "rate-limit") {
        handleCompactClassifiedError(session, "quota", errorText);
        return;
      }
      compactRestore(session);
      return;
    }
    session.queue.unshift({
      kind: "internal",
      tag: "compact-seed",
      input: [{ type: "text", text: compact.seedPromptText }],
      suppressOpen: false,
      suppressAccepted: true,
      onSettled: (s, status) => {
        if (status === "completed") {
          s.compact = null;
          drainQueue(s);
          return;
        }
        const armed = s.armedError;
        const errText = armed !== null && !armed.handled ? armed.message : "";
        const parkedCause = parkedCauseOf(errText);
        if (parkedCause !== null) {
          compactParked(s, parkedCause, errText);
          return;
        }
        if (
          classifyError(errText) === "rate-limit" ||
          isAgentQuotaMessage(s.agentMessageText)
        ) {
          handleCompactClassifiedError(s, "quota", errText);
          return;
        }
        if (
          s.compact !== null &&
          s.compact.seedAttempts < COMPACT_SEED_MAX_ATTEMPTS
        ) {
          log(
            `thread ${s.threadId}: compact seed failed; retrying fresh conversation (${s.compact.seedAttempts}/${COMPACT_SEED_MAX_ATTEMPTS})`,
          );
          runCompactSeed(s);
          return;
        }
        compactRestore(s);
      },
    });
    drainQueue(session);
  });
}

function compactRestore(session: WSession): void {
  const compact = session.compact;
  if (compact === null || compact.oldProviderThreadId === null) {
    session.compact = null;
    drainQueue(session);
    return;
  }
  compact.stage = "restore";
  sendNotification("session/replaced", {
    threadId: session.threadId,
    providerThreadId: compact.oldProviderThreadId,
    reason:
      "the compaction fallback could not open a fresh conversation; the thread goes back to its previous, uncompacted conversation",
    contextLost: false,
  });
  const params = {
    ...session.baseParams,
    threadId: session.threadId,
    cwd: session.cwd,
    providerThreadId: compact.oldProviderThreadId,
    options: rewriteOptions(session, { ...session.baseOptions }),
  };
  void internalRequest("thread/resume", params).then(({ ok, error }) => {
    if (!ok) {
      const errorText = errorMessageOf(error);
      // §2.3 п.11 (ревизия 14): the restore reads its error too — the
      // account answering VALIDATION_REQUIRED/ToS parks, and the thread
      // continues on a sibling or fails honestly, never silently parked
      // on a dead session.
      const parkedCause =
        dataDir !== "" ? internalRefusalCauseOf(errorText) : null;
      if (parkedCause !== null) {
        compactParked(session, parkedCause, errorText);
        return;
      }
      if (classifyError(errorText) === "rate-limit") {
        handleCompactClassifiedError(session, "quota", errorText);
        return;
      }
      log(
        `thread ${session.threadId}: compaction restore failed: ${errorText.slice(0, 300)}`,
      );
    }
    session.compact = null;
    drainQueue(session);
  });
  log(
    `thread ${session.threadId}: compaction fallback restores conversation ${compact.oldProviderThreadId}`,
  );
}

/**
 * §2.3 п.11 (ревизия 14): a compaction internal start/resume answered
 * with a parked cause (VALIDATION_REQUIRED/ToS). The account parks for
 * good; the thread continues on a free sibling — the seed stage re-runs
 * there, which is the best context the fallback can still offer — or
 * fails honestly when no sibling is free. The dead session is never kept.
 */
function compactParked(
  session: WSession,
  cause: "validation-required" | "tos-disabled" | "ineligible",
  errorText: string,
): void {
  coolSessionAccount(session, cause, errorText.slice(0, 300));
  const { account } = freeSibling(session, session.accountLabel);
  if (account === null) {
    const owner = session.accountLabel;
    session.compact = null;
    failOut(
      session,
      cause === "validation-required"
        ? `account ${owner ?? "?"} needs Google account verification and no free pool account can take over the compaction fallback`
        : cause === "tos-disabled"
          ? `account ${owner ?? "?"} was disabled by Google (Terms of Service) and no free pool account can take over the compaction fallback`
          : `account ${owner ?? "?"} failed Google's Antigravity eligibility check and no free pool account can take over the compaction fallback`,
    );
    return;
  }
  const movedFrom = session.accountLabel;
  session.accountLabel = account.label;
  session.envVars = filterEnvVars(
    session.baseOptions.envVars,
    session.accountLabel !== null,
  );
  const ledger = loadLedger(dataDir);
  markAccountUse(ledger, account.label);
  saveLedger(dataDir, ledger);
  buildLaunch(session);
  log(
    `thread ${session.threadId}: move ${movedFrom ?? "none"} → ${account.label} (${cause})`,
  );
  if (session.compact === null) {
    drainQueue(session);
    return;
  }
  runCompactSeed(session);
}

// ---------------------------------------------------------------------------
// Outbound interception
// ---------------------------------------------------------------------------

/** interaction/request ids in flight: request id → thread + payload. */
const pendingInteractions = new Map<
  JsonRpcId,
  { threadId: string; payload: Record<string, unknown> }
>();

function resolveInteractions(threadId: string): void {
  for (const [id, record] of [...pendingInteractions.entries()]) {
    if (record.threadId !== threadId) {
      continue;
    }
    pendingInteractions.delete(id);
    // The generic bridge kills the agent process and runs its own
    // cancelPendingPermissions — answering the agent is pointless. What IS
    // needed is the client's dialog: emit the lifecycle event that closes it.
    const payload = { ...record.payload };
    delete payload.availableDecisions;
    sendNotification("provider/raw", {
      threadId,
      raw: {
        jsonrpc: "2.0",
        method: "system/interaction/lifecycle",
        params: {
          threadId,
          interaction: {
            id: String(id),
            status: "cancelled",
            statusReason: "Session released",
            origin: {
              kind: "provider",
              providerId: "agy",
              providerRequestId: String(id),
            },
            payload,
            resolution: null,
          },
        },
      },
    });
    log(`thread ${threadId}: resolved hanging interaction ${String(id)}`);
  }
}

function errorMessageOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return typeof error === "string" ? error : (JSON.stringify(error) ?? "");
}

function rotationReason(cause: RotationCause): string {
  switch (cause) {
    case "ineligible":
      return "this account failed Google's Antigravity eligibility check; the turn is being re-run on another account, so the conversation context does not carry over";
    case "auth-dead":
      return "the session's account lost its Google sign-in (auth_required); the turn is being re-run on another account, so the conversation context does not carry over";
    case "tos-disabled":
      return "the session's account was disabled by Google (Terms of Service); the turn is being re-run on another account, so the conversation context does not carry over";
    case "validation-required":
      return "the session's account needs Google account verification; the turn is being re-run on another account, so the conversation context does not carry over";
    case "model":
      return "the session's account does not offer the selected model; the turn is being re-run on another account, so the conversation context does not carry over";
    case "quota":
      return "the quota window closed on this account; the turn is being re-run on another account, so the conversation context does not carry over";
  }
}

function onThreadIdentity(params: Record<string, unknown>): void {
  const threadId = params.threadId;
  const providerThreadId = params.providerThreadId;
  if (typeof threadId !== "string") {
    return;
  }
  const session = sessions.get(threadId);
  if (session === undefined) {
    return;
  }
  session.providerThreadId =
    typeof providerThreadId === "string" ? providerThreadId : null;
  rememberThreadRecord(threadId, session.cwd, session.providerThreadId);
  if (
    session.providerThreadId !== null &&
    session.accountLabel !== null &&
    dataDir !== ""
  ) {
    const ledger = loadLedger(dataDir);
    rememberConversation(
      ledger,
      session.providerThreadId,
      session.accountLabel,
    );
    saveLedger(dataDir, ledger);
  }
  if (session.rotating && session.rotationCause !== null) {
    sendNotification("session/replaced", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      reason: rotationReason(session.rotationCause),
      contextLost: true,
    });
    // The failed turn (or the daemon turn that triggered the rotation) is
    // replayed as the handoff.
    const consumed = session.pendingConsume;
    session.pendingConsume = null;
    queueHandoffTurn(session, consumed ?? undefined);
    // No drainQueue here: the generic session is still being registered
    // (we are inside its threadIdentity notification); the internal
    // thread/start response drains the queue.
  }
}

/**
 * §2.3 п.11: the swallowed "⚠ Verification Required" turn ends here —
 * park the owner and rotate to a sibling (or fail honestly) exactly like
 * a classified refusal. daemonTurnOpen stays set so failOut can still
 * close the client-visible turn with a failed boundary.
 */
function onValidationRefusalBoundary(session: WSession): void {
  session.bridgeTurnBusy = false;
  session.suppressOpenNext = false;
  session.suppressAcceptedNext = false;
  session.settledInternal = null;
  log(
    `thread ${session.threadId}: agent text carried VALIDATION_REQUIRED on ${session.accountLabel ?? "?"}; parking and rotating`,
  );
  handleClassifiedError(
    session,
    "validation-required",
    `account ${session.accountLabel ?? "?"} needs Google account verification`,
  );
}

/**
 * §2.3 п.13: the swallowed "⚠ Individual quota reached…" turn ends here —
 * the account is cooled until the stated reset and the turn re-runs on a
 * sibling (or waits / fails honestly), exactly like a quota provider.error.
 */
function onQuotaRefusalBoundary(session: WSession, text: string): void {
  session.bridgeTurnBusy = false;
  session.suppressOpenNext = false;
  session.suppressAcceptedNext = false;
  session.settledInternal = null;
  log(
    `thread ${session.threadId}: agent text carried a quota refusal on ${session.accountLabel ?? "?"}; cooling and rotating`,
  );
  handleClassifiedError(session, "quota", text);
}

function onProviderErrorDelta(
  session: WSession | undefined,
  delta: Record<string, unknown>,
): "pass" | "drop" {
  if (session === undefined) {
    return "pass";
  }
  const armed = session.armedError;
  const armedText =
    armed !== null && !armed.handled && Date.now() - armed.atMs < 60_000
      ? armed.message
      : null;
  const text =
    armedText ??
    (typeof delta.message === "string" ? delta.message : "") +
      (typeof delta.detail === "string" ? `\n${delta.detail}` : "");
  const category = classifyError(text);
  if (
    category !== "rate-limit" &&
    !isAccountIneligible(text) &&
    !isAuthDead(text) &&
    !isTosDisabled(text) &&
    !isModelRefusal(text) &&
    !isValidationRequired(text)
  ) {
    // Consumed once for classification: leaving it armed would let this old
    // error text shadow the classification of later boundaries for 60s.
    if (armed !== null) {
      armed.handled = true;
    }
    return "pass";
  }
  if (armed !== null) {
    armed.handled = true;
  }
  // The failed prompt is dead on the bridge side; without this the wrapper
  // would hold the queue forever waiting for a boundary that never comes.
  session.bridgeTurnBusy = false;
  session.suppressOpenNext = false;
  session.suppressAcceptedNext = false;
  session.settledInternal = null;
  // Suppress the boundary error and run the automaton. When the plan is
  // "fail" the honest error still goes out — as failOut's own delta — so
  // this generic one is dropped either way, along with the trailing
  // `error` notification it travels with.
  session.suppressErrorNotify = true;
  const cause: RotationCause = isTosDisabled(text)
    ? "tos-disabled"
    : category === "rate-limit"
      ? "quota"
      : isValidationRequired(text)
        ? "validation-required"
        : isAuthDead(text)
          ? "auth-dead"
          : isModelRefusal(text)
            ? "model"
            : "ineligible";
  if (
    cause === "model" &&
    dataDir !== "" &&
    session.accountLabel !== null &&
    session.model !== undefined
  ) {
    // The in-flight refusal marks the family on this account; the rotation
    // (and every later pick) now skips it for that model (§2.3).
    markAccountModelUnsupported(
      dataDir,
      session.accountLabel,
      session.model,
    );
  }
  handleClassifiedError(session, cause, text);
  return "drop";
}

function onTurnBoundary(session: WSession, delta: Record<string, unknown>): void {
  const status = typeof delta.status === "string" ? delta.status : "failed";
  session.bridgeTurnBusy = false;
  session.daemonTurnOpen = false;
  session.artifactRetries = 0;
  session.artifactNudgeQueued = false;
  const settled = session.settledInternal;
  session.settledInternal = null;
  if (status === "completed") {
    session.autoRetryCount = 0;
    clearRateLimit(session);
  }
  const wasCompactInFlight = session.compactInFlight;
  session.compactInFlight = false;
  // Post-boundary work runs on a microtask: the bridge emits this delta
  // BEFORE it releases activePromptKind (finishCompaction / runTurn
  // finally), so a turn injected in the same tick gets "already active".
  queueMicrotask(() => {
    if (sessions.get(session.threadId) !== session) {
      return;
    }
    if (settled !== null) {
      settled(session, status);
      return;
    }
    if (
      wasCompactInFlight &&
      status === "failed" &&
      !session.rotating &&
      compactFallbackEnabled()
    ) {
      const message =
        typeof delta.error === "object" && delta.error !== null
          ? String((delta.error as { message?: unknown }).message ?? "")
          : "";
      const category = classifyError(message);
      // Billing and auth are not "Google cannot compact"; quota rides rotation.
      if (
        category !== "billing" &&
        category !== "unauthorized" &&
        category !== "rate-limit"
      ) {
        startCompactFallback(session);
        return;
      }
    }
    drainQueue(session);
  });
}

function resolveInterruptedPending(
  session: WSession,
  continued: "yes" | "no" | "aborted",
): void {
  if (!session.interruptedPending) {
    return;
  }
  session.interruptedPending = false;
  log(
    `suppress interrupted stream: thread=${session.threadId} continued=${continued}`,
  );
}

function flushCandidateBuffer(
  session: WSession,
  out: Record<string, unknown>[],
): void {
  if (isAgentInterruptedMessage(session.agentMessageText)) {
    session.candidateBuffer = [];
    session.heldTextClose = null;
    session.agentMessageText = "";
    session.interruptedPending = true;
    return;
  }
  for (const b of session.candidateBuffer) {
    if (session.compact?.collecting && typeof b.text === "string") {
      session.compact.summaryBuf += b.text;
    }
    if (typeof b.text === "string") {
      session.recentAssistantText = (
        session.recentAssistantText + b.text
      ).slice(-HANDOFF_STREAMED_TEXT_CAP);
    }
    out.push(b);
    session.streamedAgentMessage = true;
  }
  session.candidateBuffer = [];
  if (session.heldTextClose !== null) {
    out.push(session.heldTextClose);
    session.heldTextClose = null;
    session.agentMessageText = "";
    session.streamedAgentMessage = false;
  }
}

function processDeltaLine(
  threadId: string,
  deltas: Record<string, unknown>[],
): Record<string, unknown>[] {
  const session = sessions.get(threadId) ?? stoppingSessions.get(threadId);
  if (session === undefined) {
    return deltas;
  }
  drainShimEvents();
  const out: Record<string, unknown>[] = [];
  for (const delta of deltas) {
    switch (delta.kind) {
      case "turn.open": {
        session.interruptedPending = false;
        session.bridgeTurnBusy = true;
        session.streamedAgentMessage = false;
        session.agentMessageText = "";
        session.quotaRefusalText = null;
        session.validationRefusal = false;
        session.candidateBuffer = [];
        session.heldTextClose = null;
        if (session.suppressOpenNext) {
          session.suppressOpenNext = false;
          continue;
        }
        session.daemonTurnOpen = true;
        out.push(delta);
        continue;
      }
      case "turn.boundary": {
        if (isAgentInterruptedMessage(session.agentMessageText)) {
          session.candidateBuffer = [];
          session.heldTextClose = null;
          session.agentMessageText = "";
          session.interruptedPending = true;
        }
        if (session.interruptedPending) {
          resolveInterruptedPending(session, "no");
        }
        // §2.3 п.11 & п.13 (ревизия 18): if candidate buffer or current text matched
        // a full validation or quota refusal, the marker is confirmed at boundary
        const isVal = isAgentValidationMessage(session.agentMessageText);
        const isQuota = isAgentQuotaMessage(session.agentMessageText);
        if (isVal) {
          session.candidateBuffer = [];
          session.heldTextClose = null;
          session.agentMessageText = "";
          onValidationRefusalBoundary(session);
          continue;
        }
        if (isQuota) {
          const refusal = session.agentMessageText.trim();
          session.candidateBuffer = [];
          session.heldTextClose = null;
          session.agentMessageText = "";
          onQuotaRefusalBoundary(session, refusal);
          continue;
        }
        session.streamedAgentMessage = false;
        if (session.stopped) {
          stoppingSessions.delete(session.threadId);
        }
        flushCandidateBuffer(session, out);
        session.agentMessageText = "";
        out.push(delta);
        onTurnBoundary(session, delta);
        continue;
      }
      case "input.accepted": {
        if (session.suppressAcceptedNext) {
          session.suppressAcceptedNext = false;
          continue;
        }
        out.push(delta);
        continue;
      }
      case "item.textDelta": {
        if (
          session.interruptedPending &&
          delta.channel !== "agentMessage" &&
          typeof delta.text === "string" &&
          /\S/.test(delta.text)
        ) {
          resolveInterruptedPending(session, "yes");
        }
        if (
          delta.channel === "agentMessage" &&
          typeof delta.text === "string"
        ) {
          if (session.heldTextClose !== null) {
            flushCandidateBuffer(session, out);
            session.agentMessageText = "";
          }
          const candidateText = session.agentMessageText + delta.text;
          if (isAgentMarkerCandidate(candidateText)) {
            session.agentMessageText = candidateText;
            session.candidateBuffer.push(delta);
            continue;
          }
          // Point 0: divergence (§2.3 п. 15, ревизия 19)
          const trimmedLeading = candidateText.trimStart();
          const firstNl = trimmedLeading.indexOf("\n");
          if (
            firstNl !== -1 &&
            isAgentInterruptedMessage(trimmedLeading.slice(0, firstNl))
          ) {
            session.candidateBuffer = [];
            session.heldTextClose = null;
            session.interruptedPending = true;
            const rest = trimmedLeading.slice(firstNl + 1);
            if (rest.length > 0) {
              const restDelta = { ...delta, text: rest };
              session.agentMessageText = rest;
              out.push(restDelta);
              session.streamedAgentMessage = true;
              if (session.compact?.collecting) {
                session.compact.summaryBuf += rest;
              }
              session.recentAssistantText = (
                session.recentAssistantText + rest
              ).slice(-HANDOFF_STREAMED_TEXT_CAP);
              if (session.interruptedPending && /\S/.test(rest)) {
                resolveInterruptedPending(session, "yes");
              }
            } else {
              session.agentMessageText = "";
            }
            continue;
          } else if (isAgentInterruptedMessage(session.agentMessageText)) {
            session.candidateBuffer = [];
            session.heldTextClose = null;
            session.agentMessageText = "";
            session.interruptedPending = true;
            if (isAgentMarkerCandidate(delta.text)) {
              session.agentMessageText = delta.text;
              session.candidateBuffer.push(delta);
              continue;
            }
            session.agentMessageText = delta.text;
            session.streamedAgentMessage = true;
            if (session.compact?.collecting) {
              session.compact.summaryBuf += delta.text;
            }
            session.recentAssistantText = (
              session.recentAssistantText + delta.text
            ).slice(-HANDOFF_STREAMED_TEXT_CAP);
            out.push(delta);
            if (session.interruptedPending && /\S/.test(delta.text)) {
              resolveInterruptedPending(session, "yes");
            }
            continue;
          }
          // Default divergence: flush buffered candidate chunks and process normally
          flushCandidateBuffer(session, out);
          session.agentMessageText = candidateText;
          session.streamedAgentMessage = true;
          if (session.compact?.collecting) {
            session.compact.summaryBuf += delta.text;
          }
          session.recentAssistantText = (
            session.recentAssistantText + delta.text
          ).slice(-HANDOFF_STREAMED_TEXT_CAP);
          if (session.interruptedPending && /\S/.test(delta.text)) {
            resolveInterruptedPending(session, "yes");
          }
        }
        out.push(delta);
        continue;
      }
      case "item.open": {
        const item = optionsRecord(delta.item);
        if (item.type === "compaction") {
          session.compactInFlight = true;
        }
        if (isAgentInterruptedMessage(session.agentMessageText)) {
          session.candidateBuffer = [];
          session.heldTextClose = null;
          session.agentMessageText = "";
          session.interruptedPending = true;
        } else if (
          session.heldTextClose !== null ||
          session.candidateBuffer.length > 0
        ) {
          flushCandidateBuffer(session, out);
        }
        if (session.interruptedPending && item.type !== "agentMessage") {
          resolveInterruptedPending(session, "yes");
        }
        session.agentMessageText = "";
        out.push(delta);
        continue;
      }
      case "item.textClose": {
        if (delta.channel === "agentMessage") {
          if (session.stopped && !session.streamedAgentMessage) {
            session.heldTextClose = null;
            continue;
          }
          if (isAgentInterruptedMessage(session.agentMessageText)) {
            session.candidateBuffer = [];
            session.heldTextClose = null;
            session.agentMessageText = "";
            session.streamedAgentMessage = false;
            session.interruptedPending = true;
            out.push(delta);
            continue;
          }
          if (
            isAgentQuotaMessage(session.agentMessageText) ||
            isAgentValidationMessage(session.agentMessageText)
          ) {
            session.heldTextClose = delta;
            continue;
          }
          flushCandidateBuffer(session, out);
          session.agentMessageText = "";
          session.streamedAgentMessage = false;
        }
        out.push(delta);
        continue;
      }
      case "item.close": {
        const item = optionsRecord(delta.item);
        if (item.type === "agentMessage") {
          if (session.stopped && !session.streamedAgentMessage) {
            session.heldTextClose = null;
            continue;
          }
          if (isAgentInterruptedMessage(session.agentMessageText)) {
            session.candidateBuffer = [];
            session.heldTextClose = null;
            session.agentMessageText = "";
            session.streamedAgentMessage = false;
            session.interruptedPending = true;
            out.push(delta);
            continue;
          }
          if (
            isAgentQuotaMessage(session.agentMessageText) ||
            isAgentValidationMessage(session.agentMessageText)
          ) {
            session.heldTextClose = delta;
            continue;
          }
          flushCandidateBuffer(session, out);
          session.agentMessageText = "";
          session.streamedAgentMessage = false;
        } else {
          if (isAgentInterruptedMessage(session.agentMessageText)) {
            session.candidateBuffer = [];
            session.heldTextClose = null;
            session.agentMessageText = "";
            session.interruptedPending = true;
          } else if (
            session.heldTextClose !== null ||
            session.candidateBuffer.length > 0
          ) {
            flushCandidateBuffer(session, out);
          }
          if (session.interruptedPending && item.type !== "agentMessage") {
            resolveInterruptedPending(session, "yes");
          }
          session.agentMessageText = "";
        }
        out.push(delta);
        continue;
      }
      case "session.reset": {
        if (session.interruptedPending) {
          resolveInterruptedPending(session, "aborted");
        }
        session.recentAssistantText = "";
        session.candidateBuffer = [];
        session.heldTextClose = null;
        out.push(delta);
        continue;
      }
      case "provider.error": {
        if (onProviderErrorDelta(session, delta) === "drop") {
          continue;
        }
        // A pass-through quota error carries the native errorInfo the
        // generic bridge never sets (spec §3).
        const errText =
          typeof delta.detail === "string" && delta.detail.length > 0
            ? delta.detail
            : typeof delta.message === "string"
              ? delta.message
              : "";
        const info = nativeErrorInfo(errText);
        if (info !== undefined && delta.errorInfo === undefined) {
          out.push({ ...delta, errorInfo: info, category: info.category });
          if (info.category === "rate-limit") {
            emitRateLimits(
              session,
              "blocked",
              quotaResetAtMs(errText) ?? nearestCooldownEnd(session),
              errText,
            );
          }
        } else {
          out.push(delta);
        }
        continue;
      }
      default: {
        if (delta.kind === "toolCall" || delta.kind === "commandExecution") {
          if (isAgentInterruptedMessage(session.agentMessageText)) {
            session.candidateBuffer = [];
            session.heldTextClose = null;
            session.agentMessageText = "";
            session.interruptedPending = true;
          } else if (
            session.heldTextClose !== null ||
            session.candidateBuffer.length > 0
          ) {
            flushCandidateBuffer(session, out);
          }
          if (session.interruptedPending) {
            resolveInterruptedPending(session, "yes");
          }
          session.agentMessageText = "";
        }
        out.push(delta);
        continue;
      }
    }
  }
  return out;
}

function interceptOutbound(line: string): void {
  drainShimEvents();
  let msg: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      msg = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: pass through untouched.
  }
  if (msg === null) {
    rawWrite(`${line}\n`);
    return;
  }
  // JSON-RPC response.
  if (
    msg.method === undefined &&
    msg.id !== undefined &&
    ("result" in msg || "error" in msg)
  ) {
    if (typeof msg.id === "number") {
      const waiter = internalWaiters.get(msg.id);
      if (waiter !== undefined) {
        internalWaiters.delete(msg.id);
        waiter("error" in msg ? false : true, msg.result, msg.error);
        return;
      }
    }
    const sink = internalAnswers.get(msg.id as JsonRpcId);
    const pending = pendingDaemonSessions.get(msg.id as JsonRpcId);
    if (pending === undefined) {
      if (sink !== undefined) {
        internalAnswers.delete(msg.id as JsonRpcId);
        sink(!("error" in msg), msg.result, msg.error);
        return;
      }
      rawWrite(`${line}\n`);
      return;
    }
    pendingDaemonSessions.delete(msg.id as JsonRpcId);
    const errorText = "error" in msg ? errorMessageOf(msg.error) : null;
    if (
      errorText !== null &&
      isModelRefusal(errorText) &&
      pending.session.accountLabel !== null &&
      pending.session.model !== undefined &&
      dataDir !== ""
    ) {
      // The picked account's catalog claimed the family — the refusal
      // disproves it (§2.3). Mark and re-drive on the next suitable
      // sibling; the daemon sees only the final answer.
      retryDaemonSession(msg.id as JsonRpcId, pending, msg);
      return;
    }
    const parkedCause =
      errorText !== null &&
      pending.session.accountLabel !== null &&
      dataDir !== ""
        ? internalRefusalCauseOf(errorText)
        : null;
    if (parkedCause !== null) {
      // §2.3 п.11 (ревизия 15): a parking refusal (VALIDATION_REQUIRED/ToS
      // or the eligibility family) at session build parks the account —
      // the thread moves to a sibling or fails honestly.
      retryDaemonSessionParked(
        msg.id as JsonRpcId,
        pending,
        parkedCause,
        errorText ?? undefined,
      );
      return;
    }
    if (sink !== undefined) {
      internalAnswers.delete(msg.id as JsonRpcId);
      sink(errorText === null, msg.result, msg.error);
      return;
    }
    rawWrite(`${line}\n`);
    return;
  }
  // Outbound requests (the bridge asks the daemon: interaction/request etc.).
  if (msg.method === "interaction/request" && msg.id !== undefined) {
    const params = optionsRecord(msg.params);
    if (typeof params.threadId === "string") {
      pendingInteractions.set(msg.id as JsonRpcId, {
        threadId: params.threadId,
        payload: optionsRecord(params.payload),
      });
    }
    rawWrite(`${line}\n`);
    return;
  }
  switch (msg.method) {
    case "thread/delta": {
      const params = optionsRecord(msg.params);
      const threadId = params.threadId;
      if (typeof threadId !== "string" || !Array.isArray(params.deltas)) {
        rawWrite(`${line}\n`);
        return;
      }
      const filtered = processDeltaLine(
        threadId,
        params.deltas as Record<string, unknown>[],
      );
      if (filtered.length === 0) {
        return;
      }
      writeOutbound({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: { ...params, deltas: filtered },
      });
      return;
    }
    case "thread/identity": {
      onThreadIdentity(optionsRecord(msg.params));
      rawWrite(`${line}\n`);
      return;
    }
    case "error": {
      const params = optionsRecord(msg.params);
      const session =
        typeof params.threadId === "string"
          ? sessions.get(params.threadId)
          : undefined;
      if (session?.suppressErrorNotify) {
        session.suppressErrorNotify = false;
        return;
      }
      const message = typeof params.message === "string" ? params.message : "";
      const category = classifyError(message);
      if (
        session !== undefined &&
        (session.daemonTurnOpen ||
          session.bridgeTurnBusy ||
          session.compact !== null) &&
        (category === "rate-limit" ||
          isTosDisabled(message) ||
          isValidationRequired(message) ||
          isAuthDead(message) ||
          isAccountIneligible(message) ||
          isModelRefusal(message))
      ) {
        session.bridgeTurnBusy = false;
        session.settledInternal = null;
        const cause: RotationCause = isTosDisabled(message)
          ? "tos-disabled"
          : category === "rate-limit"
            ? "quota"
            : isValidationRequired(message)
              ? "validation-required"
              : isAuthDead(message)
                ? "auth-dead"
                : isModelRefusal(message)
                  ? "model"
                  : "ineligible";
        if (
          cause === "model" &&
          dataDir !== "" &&
          session.accountLabel !== null &&
          session.model !== undefined
        ) {
          markAccountModelUnsupported(
            dataDir,
            session.accountLabel,
            session.model,
          );
        }
        handleClassifiedError(session, cause, message);
        return;
      }
      rawWrite(`${line}\n`);
      return;
    }
    default: {
      rawWrite(`${line}\n`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound dispatch
// ---------------------------------------------------------------------------

/**
 * Daemon-bound thread/start|thread/resume requests we forwarded: when the
 * picked account refuses the model at session build (a stale catalog
 * record — set_config_option/set_model or session/load says
 * "Unknown model ID"), the wrapper marks the family unsupported and drives
 * the same request on the next suitable sibling. The daemon only ever sees
 * the final answer.
 */
interface PendingDaemonSession {
  session: WSession;
  kind: "start" | "resume";
  params: Record<string, unknown>;
}
const pendingDaemonSessions = new Map<JsonRpcId, PendingDaemonSession>();

function poolPickAccount(
  session: WSession,
): "picked" | "direct" | "unoffered" | "parked" {
  if (dataDir === "" || !accountsEnabled(process.env)) {
    session.accountLabel = null;
    return "direct";
  }
  const ledger = loadLedger(dataDir);
  const accounts = listAccounts(dataDir);
  const catalog = accountModelCatalog();
  const picked = pickAccount(ledger, accounts, null, {
    family: session.model ?? null,
    models: catalog,
    locallyAvailable: (label) => locallyAvailable(ledger, label),
  });
  session.accountLabel = picked?.label ?? null;
  if (picked === null) {
    // §2.3 п.7: with every pool account parked (any parkedReason), even a
    // model-less request must fail honestly — a silent direct-mode fall
    // onto the default HOME would hide the parked pool.
    const eligible = accounts.filter(
      (a) => accountPriority(ledger.accounts[a.label]) > 0,
    );
    if (
      eligible.length > 0 &&
      eligible.every(
        (a) => ledger.accounts[a.label]?.parkedReason !== undefined,
      )
    ) {
      return "parked";
    }
    // §2.3: when every eligible account's catalog says it cannot serve the
    // model, fail honestly instead of landing on an account without it.
    if (
      session.model !== undefined &&
      accounts.length > 0 &&
      !poolOffersModel(ledger, accounts, catalog, session.model)
    ) {
      return "unoffered";
    }
    return "direct";
  }
  markAccountUse(ledger, picked.label);
  saveLedger(dataDir, ledger);
  const pinnedInstall = installNameFor(picked.label);
  log(
    `thread ${session.threadId}: pinned to account ${picked.label} (model ${session.model ?? "default"}, proxy ${picked.proxy !== null ? "yes" : "no"}${pinnedInstall !== null ? `, install=${pinnedInstall}` : ""})`,
  );
  return "picked";
}

/**
 * The session's owner cannot serve the requested model: resume becomes a
 * fresh thread on a free sibling — the same transform the cooled-owner
 * path runs — with session/replaced carrying the model reason.
 */
function resumeOnSibling(
  session: WSession,
  id: JsonRpcId,
  providerThreadId: string,
  account: AccountHome,
  reason: string,
): void {
  session.needsHandoff = true;
  session.rotating = true; // hold daemon turns until the sibling is up
  const siblingInstall = installNameFor(account.label);
  log(
    `thread ${session.threadId}: move ${session.accountLabel ?? "none"} → ${account.label} (resume on sibling${siblingInstall !== null ? `, install=${siblingInstall}` : ""})`,
  );
  session.accountLabel = account.label;
  session.envVars = filterEnvVars(
    session.baseOptions.envVars,
    session.accountLabel !== null,
  );
  const ledger = loadLedger(dataDir);
  markAccountUse(ledger, account.label);
  saveLedger(dataDir, ledger);
  const launchError = buildLaunch(session);
  if (launchError !== null) {
    // §5 п.2: the sibling's install cannot run here — no substitution.
    // Move on to the next free sibling; the failed one is out of
    // locallyAvailable, so the search cannot loop back to it.
    log(
      `thread ${session.threadId}: resume sibling ${account.label} cannot launch: ${launchError}`,
    );
    const { account: next } = freeSibling(session, account.label);
    if (next === null) {
      session.rotating = false;
      session.needsHandoff = false;
      sendError(
        id,
        -32000,
        `agy could not start on the resume sibling: ${launchError}`,
      );
      return;
    }
    resumeOnSibling(
      session,
      id,
      providerThreadId,
      next,
      `resumed conversation ${providerThreadId} belongs to an account whose install is unavailable (${launchError}); ` +
        `resumed on free sibling ${next.label} instead, so the conversation context does not carry over`,
    );
    return;
  }
  const startParams = {
    ...session.baseParams,
    threadId: session.threadId,
    cwd: session.cwd,
    options: rewriteOptions(session, { ...session.baseOptions }),
  };
  delete (startParams as { providerThreadId?: unknown }).providerThreadId;
  void internalRequest("thread/start", startParams).then(({ ok, error }) => {
    session.rotating = false;
    if (!ok) {
      session.needsHandoff = false;
      const errorText = errorMessageOf(error);
      // §2.3 п.10: the sibling's own model refusal means the fresh record
      // lied — mark it, probe it, and answer honestly; no third hop.
      if (
        dataDir !== "" &&
        session.model !== undefined &&
        isModelRefusal(errorText)
      ) {
        markAccountModelUnsupported(dataDir, account.label, session.model);
        maybeProbeCatalog(account.label);
        // §2.3 п.12 (ревизия 14): the no-carrier refusal is journaled —
        // thread, model, reason.
        log(
          `thread ${session.threadId}: thread/resume refused (model ${session.model ?? "default"}): model ${session.model} is not offered by any pool account`,
        );
        sendError(
          id,
          -32000,
          `model ${session.model} is not offered by any pool account`,
        );
        return;
      }
      // §2.3 п.11 (ревизия 13.1): the sibling itself refuses with
      // VALIDATION_REQUIRED/ToS — park it permanently and try the next
      // free account instead of a bare error.
      const parkedCause = internalRefusalCauseOf(errorText);
      if (dataDir !== "" && parkedCause !== null) {
        coolSessionAccount(session, parkedCause, errorText.slice(0, 300));
        const { account: next } = freeSibling(session, account.label);
        if (next === null) {
          const honest =
            parkedCause === "validation-required"
              ? `account ${account.label} needs Google account verification`
              : parkedCause === "tos-disabled"
                ? `account ${account.label} was disabled by Google (Terms of Service)`
                : `account ${account.label} failed Google's Antigravity eligibility check`;
          // §2.3 п.12 (ревизия 14): journal the refusal — thread, model,
          // reason.
          log(
            `thread ${session.threadId}: thread/resume refused (model ${session.model ?? "default"}): ${honest}`,
          );
          sendError(id, -32000, honest);
          return;
        }
        resumeOnSibling(
          session,
          id,
          providerThreadId,
          next,
          `account ${account.label} is parked (${parkedCause}); resumed on free sibling ${next.label} instead, so the conversation context does not carry over`,
        );
        return;
      }
      // §2.3 п.12 (ревизия 14): journal the refusal — thread, model,
      // reason.
      log(
        `thread ${session.threadId}: thread/resume refused (model ${session.model ?? "default"}): agy could not start on the resume sibling: ${errorText.slice(0, 300)}`,
      );
      sendError(
        id,
        -32000,
        `agy could not start on the resume sibling: ${errorText.slice(0, 300)}`,
      );
      return;
    }
    sendNotification("session/replaced", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      reason,
      contextLost: true,
    });
    // The thread/start response doubles as the resume answer.
    sendResult(id, {
      providerThreadId: session.providerThreadId,
      sessionRestorable: true,
    });
    drainQueue(session);
  });
}

/**
 * The parking classes an error string can carry: VALIDATION_REQUIRED or
 * the eligibility "Verify your account to continue" (both permanent
 * validation parking) and a Terms-of-Service disable. One classifier for
 * every internal start path so none of them invents its own list.
 */
function parkedCauseOf(
  errorText: string,
): "validation-required" | "tos-disabled" | null {
  return isValidationRequired(errorText)
    ? "validation-required"
    : isTosDisabled(errorText)
      ? "tos-disabled"
      : null;
}

/**
 * The refusal cause an internal start/resume error can carry (§2.3 п.11,
 * ревизия 15): the strict parked causes, or the eligibility family — its
 * verify-request/link variant parks permanently inside coolSessionAccount
 * while the rest takes the 2h location cooldown, all under the same
 * breaker, exactly like the daemon-facing path.
 */
function internalRefusalCauseOf(
  errorText: string,
): "validation-required" | "tos-disabled" | "ineligible" | null {
  return (
    parkedCauseOf(errorText) ??
    (isAccountIneligible(errorText) ? "ineligible" : null)
  );
}

/**
 * A delegated thread/start|resume failed with a model refusal: the
 * account's catalog record lied. Mark the family unsupported, then — for
 * a start — re-drive the request on the next suitable sibling until one
 * accepts or the pool runs out; for a resume the sibling transform opens
 * a fresh thread instead (the conversation cannot move).
 */
function retryDaemonSession(
  id: JsonRpcId,
  pending: PendingDaemonSession,
  refusalMessage: Record<string, unknown>,
): void {
  const { session } = pending;
  markAccountModelUnsupported(
    dataDir,
    session.accountLabel as string,
    session.model as string,
  );
  const family = session.model;
  const honestUnoffered = (): void => {
    if (session.accountLabel !== null) {
      maybeProbeCatalog(session.accountLabel);
    }
    // §2.3 п.12 (ревизия 14): the no-carrier refusal is journaled —
    // thread, model, reason.
    log(
      `thread ${session.threadId}: ${pending.kind === "resume" ? "thread/resume" : "thread/start"} refused (model ${family ?? "default"}): model ${family ?? "?"} is not offered by any pool account`,
    );
    sendError(
      id,
      -32000,
      `model ${family ?? "?"} is not offered by any pool account`,
    );
  };
  if (pending.kind === "resume") {
    const providerThreadId =
      typeof pending.params.providerThreadId === "string"
        ? pending.params.providerThreadId
        : session.providerThreadId ?? "";
    // §2.3 п.10: the one allowed hop lands only on a fresh-catalog
    // supporter — no fresh supporter, no move.
    const { account } = freeSibling(session, session.accountLabel, {
      freshModelOnly: true,
    });
    if (account === null) {
      honestUnoffered();
      return;
    }
    if (family !== undefined) {
      session.modelRefusalMoved.add(family);
    }
    resumeOnSibling(
      session,
      id,
      providerThreadId,
      account,
      `resumed conversation ${providerThreadId} belongs to an account that does not offer the selected model; resumed on free sibling ${account.label} instead, so the conversation context does not carry over`,
    );
    return;
  }
  const retry = (): void => {
    if (family !== undefined && session.modelRefusalMoved.has(family)) {
      // §2.3 п.10: the move was already spent — a second refusal for the
      // same family ends honestly, never chains to the next guess.
      honestUnoffered();
      return;
    }
    const { account } = freeSibling(session, session.accountLabel, {
      freshModelOnly: true,
    });
    if (account === null) {
      // No fresh-catalog supporter: the honest refusal stands.
      honestUnoffered();
      return;
    }
    if (family !== undefined) {
      session.modelRefusalMoved.add(family);
    }
    const movedFrom = session.accountLabel;
    session.accountLabel = account.label;
    const ledger = loadLedger(dataDir);
    markAccountUse(ledger, account.label);
    saveLedger(dataDir, ledger);
    const launchError = buildLaunch(session);
    const refusalInstall = installNameFor(account.label);
    log(
      `thread ${session.threadId}: move ${movedFrom ?? "none"} → ${account.label} (model refusal${refusalInstall !== null ? `, install=${refusalInstall}` : ""})`,
    );
    if (launchError !== null) {
      // §5 п.2: this sibling cannot launch — no substitute binary. The
      // spent-move marker belongs to a move that never ran, so release it
      // and let retry pick the next fresh supporter (the failed account
      // is already out of locallyAvailable).
      log(
        `thread ${session.threadId}: sibling ${account.label} cannot launch: ${launchError}`,
      );
      if (family !== undefined) {
        session.modelRefusalMoved.delete(family);
      }
      retry();
      return;
    }
    const params = {
      ...pending.params,
      options: rewriteOptions(session, { ...session.baseOptions }),
    };
    delete (params as { providerThreadId?: unknown }).providerThreadId;
    void internalRequest("thread/start", params).then(
      ({ ok, result, error }) => {
        if (ok) {
          sendResult(id, result);
          return;
        }
        const errorText = errorMessageOf(error);
        if (isModelRefusal(errorText) && session.model !== undefined) {
          markAccountModelUnsupported(dataDir, account.label, session.model);
          maybeProbeCatalog(account.label);
          honestUnoffered();
          return;
        }
        // §2.3 п.11 (ревизия 15): the sibling refuses the internal start
        // with VALIDATION_REQUIRED/ToS or an eligibility refusal — park it
        // and keep driving on the next free account, exactly like the
        // other internal-start paths.
        const parkedCause = internalRefusalCauseOf(errorText);
        if (dataDir !== "" && parkedCause !== null) {
          retryDaemonSessionParked(id, pending, parkedCause, errorText);
          return;
        }
        sendError(id, -32000, errorText);
      },
    );
  };
  retry();
}

/**
 * §2.3 п.11: a pending session that answered 403 VALIDATION_REQUIRED —
 * park the account (permanent, manual unpark only) and drive the request
 * on a sibling, or answer "account <label> needs Google account
 * verification" when none is free.
 */
function retryDaemonSessionParked(
  id: JsonRpcId,
  pending: PendingDaemonSession,
  cause:
    | "validation-required"
    | "tos-disabled"
    | "ineligible" = "validation-required",
  errorText?: string,
): void {
  const { session } = pending;
  const owner = session.accountLabel;
  const honest =
    cause === "validation-required"
      ? `account ${owner ?? "?"} needs Google account verification`
      : cause === "tos-disabled"
        ? `account ${owner ?? "?"} was disabled by Google (Terms of Service)`
        : `account ${owner ?? "?"} failed Google's Antigravity eligibility check`;
  // The ledger mark wants the refusal text (it feeds the verify-request
  // split and lastError); the caller-facing answer stays honest-only.
  coolSessionAccount(session, cause, (errorText ?? honest).slice(0, 300));
  let { account } = freeSibling(session, owner);
  if (account === null) {
    // §2.3 п.12 (ревизия 14): journal the refusal — thread, model, reason.
    log(
      `thread ${session.threadId}: ${pending.kind === "resume" ? "thread/resume" : "thread/start"} refused (model ${session.model ?? "default"}): ${honest}`,
    );
    sendError(id, -32000, honest);
    return;
  }
  if (pending.kind === "resume") {
    const providerThreadId =
      typeof pending.params.providerThreadId === "string"
        ? pending.params.providerThreadId
        : session.providerThreadId ?? "";
    resumeOnSibling(
      session,
      id,
      providerThreadId,
      account,
      `resumed conversation ${providerThreadId} belongs to an account that ${cause === "validation-required" ? "needs Google account verification" : "was disabled by Google (Terms of Service)"}; resumed on free sibling ${account.label} instead, so the conversation context does not carry over`,
    );
    return;
  }
  const movedFrom = session.accountLabel;
  for (;;) {
    session.accountLabel = account.label;
    const ledger = loadLedger(dataDir);
    markAccountUse(ledger, account.label);
    saveLedger(dataDir, ledger);
    const launchError = buildLaunch(session);
    const parkedMoveInstall = installNameFor(account.label);
    log(
      `thread ${session.threadId}: move ${movedFrom ?? "none"} → ${account.label} (${cause}${parkedMoveInstall !== null ? `, install=${parkedMoveInstall}` : ""})`,
    );
    if (launchError === null) {
      break;
    }
    // §5 п.2: no substitute binary — keep driving on the next free
    // sibling; this one is already excluded by locallyAvailable, and
    // re-parking it would write a false parkedReason, so the search here
    // is inline rather than a recursion into the parking path.
    log(
      `thread ${session.threadId}: sibling ${account.label} cannot launch: ${launchError}`,
    );
    const { account: next } = freeSibling(session, account.label);
    if (next === null) {
      sendError(id, -32000, honest);
      return;
    }
    account = next;
  }
  const params = {
    ...pending.params,
    options: rewriteOptions(session, { ...session.baseOptions }),
  };
  delete (params as { providerThreadId?: unknown }).providerThreadId;
  void internalRequest("thread/start", params).then(({ ok, result, error }) => {
    if (ok) {
      sendResult(id, result);
      return;
    }
    // §2.3 п.11 (ревизия 15): the sibling refuses the internal start
    // the same way — park it too and drive the request on the next free
    // account; only a non-parking error reaches the caller verbatim.
    const errorText = errorMessageOf(error);
    const parkedCause = internalRefusalCauseOf(errorText);
    if (dataDir !== "" && parkedCause !== null) {
      retryDaemonSessionParked(id, pending, parkedCause, errorText);
      return;
    }
    sendError(id, -32000, errorText);
  });
}

function discardSession(session: WSession): void {
  session.stopped = true;
  if (session.waitTimer !== null) {
    clearTimeout(session.waitTimer);
    session.waitTimer = null;
  }
  if (session.unblockTimer !== null) {
    clearTimeout(session.unblockTimer);
    session.unblockTimer = null;
  }
  if (session.interruptedPending) {
    resolveInterruptedPending(session, "aborted");
  }
  session.candidateBuffer = [];
  session.heldTextClose = null;
  session.agentMessageText = "";
  session.quotaRefusalText = null;
  session.validationRefusal = false;
  for (const queued of session.queue.splice(0)) {
    if (queued.kind === "daemon") {
      sendError(queued.requestId, -32000, "thread stopped");
    }
  }
  for (const [id, pending] of pendingDaemonSessions) {
    if (pending.session === session) {
      pendingDaemonSessions.delete(id);
    }
  }
  resolveInteractions(session.threadId);
  sessions.delete(session.threadId);
  stoppingSessions.set(session.threadId, session);
  const timer = setTimeout(() => {
    if (stoppingSessions.get(session.threadId) === session) {
      stoppingSessions.delete(session.threadId);
    }
  }, 10000);
  timer.unref?.();
  // The thread record survives discard: it is the rebuild source for
  // unknown-session turns after a wrapper restart or a transient resume
  // failure. Only an explicit thread/discard forgets it.
}

function handleThreadStart(id: JsonRpcId, params: Record<string, unknown>): void {
  const threadId = params.threadId;
  const cwd = params.cwd;
  if (typeof threadId !== "string" || typeof cwd !== "string") {
    feedLine({ jsonrpc: "2.0", id, method: "thread/start", params });
    return;
  }
  stoppingSessions.delete(threadId);
  const existing = sessions.get(threadId);
  if (existing !== undefined) {
    discardSession(existing);
  }
  const session = newSession(threadId, cwd);
  sessions.set(threadId, session);
  rememberThreadRecord(threadId, cwd, null);
  session.baseParams = { ...params };
  delete session.baseParams.options;
  session.baseOptions = optionsRecord(params.options);
  session.envVars = filterEnvVars(session.baseOptions.envVars);
  // §2.3: the model is parsed BEFORE the account pick — the family decides
  // which accounts are candidates for this thread at all.
  const earlySelection = resolveModelSelection(
    typeof session.baseOptions.model === "string"
      ? session.baseOptions.model
      : undefined,
    typeof session.baseOptions.reasoningLevel === "string"
      ? session.baseOptions.reasoningLevel
      : undefined,
  );
  session.model = earlySelection.modelId ?? session.model;
  session.reasoningLevel =
    earlySelection.reasoningLevel ?? session.reasoningLevel;
  if (session.model !== undefined && coldStartNeedsProbes(session.model)) {
    // §2.3 п.9: catalogs first, pick second — the request waits on the
    // probe round (≤30 s) instead of spraying sessions across guesses.
    log(
      `thread ${threadId}: cold start — no account catalog names ${session.model}; waiting on agy models probes`,
    );
    void waitModelProbesBounded().then(() => {
      if (sessions.get(threadId) !== session || session.stopped) {
        return;
      }
      finishThreadStart(session, id, params);
    });
    return;
  }
  finishThreadStart(session, id, params);
}

function finishThreadStart(
  session: WSession,
  id: JsonRpcId,
  params: Record<string, unknown>,
): void {
  const poolPick = poolPickAccount(session);
  if (poolPick === "unoffered" || poolPick === "parked") {
    const reason =
      poolPick === "unoffered"
        ? `model ${session.model ?? "?"} is not offered by any pool account`
        : "every pool account is parked; clear a parkedReason in accounts-state.json and retry";
    // §2.3 п.12 (ревизия 14): a thread/start refused before any account
    // pick is journaled too — thread, model, reason.
    log(
      `thread ${session.threadId}: thread/start refused (model ${session.model ?? "default"}): ${reason}`,
    );
    sendError(id, -32000, reason);
    discardSession(session);
    return;
  }
  session.envVars = filterEnvVars(
    session.baseOptions.envVars,
    session.accountLabel !== null,
  );
  const declared =
    typeof session.baseOptions.permissionMode === "string"
      ? session.baseOptions.permissionMode
      : "full";
  session.declaredMode = declared;
  session.agyMode = mapPermissionMode(declared).agy;
  const launchError = buildLaunch(session);
  if (launchError !== null) {
    // §5 п.2: an install that cannot run answers honestly — never a
    // silent substitute binary (a bound account, or a direct/relay
    // session whose default install is missing).
    sendError(id, -32000, `agy cannot launch: ${launchError}`);
    discardSession(session);
    return;
  }
  params.options = rewriteOptions(session, { ...session.baseOptions });
  pendingDaemonSessions.set(id, { session, kind: "start", params });
  feedLine({ jsonrpc: "2.0", id, method: "thread/start", params });
}

function handleThreadResume(id: JsonRpcId, params: Record<string, unknown>): void {
  const threadId = params.threadId;
  const cwd = params.cwd;
  const providerThreadId = params.providerThreadId;
  if (
    typeof threadId !== "string" ||
    typeof cwd !== "string" ||
    typeof providerThreadId !== "string"
  ) {
    feedLine({ jsonrpc: "2.0", id, method: "thread/resume", params });
    return;
  }
  stoppingSessions.delete(threadId);
  const existing = sessions.get(threadId);
  if (existing !== undefined) {
    discardSession(existing);
  }
  const session = newSession(threadId, cwd);
  sessions.set(threadId, session);
  rememberThreadRecord(threadId, cwd, providerThreadId);
  session.baseParams = { ...params };
  delete session.baseParams.options;
  session.baseOptions = optionsRecord(params.options);
  session.envVars = filterEnvVars(session.baseOptions.envVars);
  const resumeSelection = resolveModelSelection(
    typeof session.baseOptions.model === "string"
      ? session.baseOptions.model
      : undefined,
    typeof session.baseOptions.reasoningLevel === "string"
      ? session.baseOptions.reasoningLevel
      : undefined,
  );
  session.model = resumeSelection.modelId ?? session.model;
  session.reasoningLevel =
    resumeSelection.reasoningLevel ?? session.reasoningLevel;
  // Sticky owner: the conversation belongs to the account that made it.
  if (dataDir !== "" && accountsEnabled(process.env)) {
    session.accountLabel = conversationAccount(
      loadLedger(dataDir),
      providerThreadId,
    );
  }
  const declared =
    typeof session.baseOptions.permissionMode === "string"
      ? session.baseOptions.permissionMode
      : "full";
  session.declaredMode = declared;
  session.agyMode = mapPermissionMode(declared).agy;
  const { cooled, untilMs } = sessionAccountCooled(session);
  // §2.3: an owner whose catalog lacks the requested model is unfit for
  // this resume, exactly like a cooled one — the sibling transform below.
  const catalog = accountModelCatalog();
  const ownerUnfit =
    session.model !== undefined &&
    session.accountLabel !== null &&
    accountModelState(
      Object.hasOwn(catalog, session.accountLabel)
        ? catalog[session.accountLabel]
        : undefined,
      session.model,
      Date.now(),
    ) === "unsupported";
  const ledger = loadLedger(dataDir);
  // §2.3 п.7: a parked owner is out on parkedReason alone — an expired
  // cooldown must not resurrect a banned home.
  const ownerParkedReason =
    session.accountLabel !== null
      ? ledger.accounts[session.accountLabel]?.parkedReason
      : undefined;
  // §5 п.2: an owner bound to an install this host cannot run is equally
  // unfit — the sibling transform below, or an honest error naming the
  // install and its binary path when no sibling is free.
  const ownerInstallReason =
    session.accountLabel !== null && dataDir !== ""
      ? (() => {
          const r = resolveInstall(
            dataDir,
            ledger.accounts[session.accountLabel as string]?.install,
          );
          return r.kind === "unavailable" || r.kind === "broken"
            ? r.reason
            : null;
        })()
      : null;
  if (
    (!cooled &&
      !ownerUnfit &&
      ownerParkedReason === undefined &&
      ownerInstallReason === null) ||
    dataDir === "" ||
    !accountsEnabled(process.env)
  ) {
    session.envVars = filterEnvVars(
      session.baseOptions.envVars,
      session.accountLabel !== null,
    );
    const launchError = buildLaunch(session);
    if (launchError !== null) {
      sendError(id, -32000, `agy cannot launch: ${launchError}`);
      discardSession(session);
      return;
    }
    params.options = rewriteOptions(session, { ...session.baseOptions });
    const resumeInstall = installNameFor(session.accountLabel);
    log(
      `thread ${threadId}: resuming ${providerThreadId} on account ${session.accountLabel ?? "direct"}${resumeInstall !== null ? ` (install=${resumeInstall})` : ""}`,
    );
    pendingDaemonSessions.set(id, { session, kind: "resume", params });
    feedLine({ jsonrpc: "2.0", id, method: "thread/resume", params });
    return;
  }
  // The owner is cooling, parked, or cannot serve the model: the resume
  // becomes a fresh thread on a free sibling, and the first turn rides a
  // handoff prompt (spec §7 / §2.3).
  const { account } = freeSibling(session, session.accountLabel);
  log(
    `thread ${threadId}: resume owner ${session.accountLabel} ${ownerParkedReason !== undefined ? `parked (${ownerParkedReason})` : ownerInstallReason !== null ? `install unavailable (${ownerInstallReason})` : ownerUnfit ? `does not offer ${session.model ?? "?"}` : `cools until ${new Date(untilMs).toISOString()}`}; sibling ${account?.label ?? "none"}`,
  );
  if (account === null) {
    // §5 п.2: an install-bound owner with no free sibling fails with the
    // install name and binary path — resuming it on another install's
    // binary is the substitution the contract forbids.
    if (ownerInstallReason !== null) {
      sendError(
        id,
        -32000,
        `account ${session.accountLabel} cannot run on this host: ${ownerInstallReason}`,
      );
      discardSession(session);
      return;
    }
    // §2.3 п.7: a parked owner is never touched — with no free sibling the
    // resume fails honestly instead of launching agy on the banned home.
    if (ownerParkedReason !== undefined) {
      const eligible = listAccounts(dataDir).filter(
        (a) => accountPriority(ledger.accounts[a.label]) > 0,
      );
      sendError(
        id,
        -32000,
        eligible.length > 0 &&
          eligible.every(
            (a) => ledger.accounts[a.label]?.parkedReason !== undefined,
          )
          ? "every pool account is parked; clear a parkedReason in accounts-state.json and retry"
          : `account ${session.accountLabel} is parked (${ownerParkedReason}); unpark it in accounts-state.json and retry`,
      );
      discardSession(session);
      return;
    }
    const launchError = buildLaunch(session);
    if (launchError !== null) {
      sendError(id, -32000, `agy cannot launch: ${launchError}`);
      discardSession(session);
      return;
    }
    params.options = rewriteOptions(session, { ...session.baseOptions });
    pendingDaemonSessions.set(id, { session, kind: "resume", params });
    feedLine({ jsonrpc: "2.0", id, method: "thread/resume", params });
    return;
  }
  resumeOnSibling(
    session,
    id,
    providerThreadId,
    account,
    ownerUnfit
      ? `resumed conversation ${providerThreadId} belongs to an account that does not offer the selected model; ` +
          `resumed on free sibling ${account.label} instead, so the conversation context does not carry over`
      : ownerParkedReason === "auth-dead"
        ? `resumed conversation ${providerThreadId} belongs to an account that lost its Google sign-in (auth_required); ` +
          `resumed on free sibling ${account.label} instead, so the conversation context does not carry over`
        : ownerParkedReason === "tos-disabled"
          ? `resumed conversation ${providerThreadId} belongs to an account disabled by Google (Terms of Service); ` +
            `resumed on free sibling ${account.label} instead, so the conversation context does not carry over`
          : ownerParkedReason === "validation-required"
            ? `resumed conversation ${providerThreadId} belongs to an account that needs Google account verification; ` +
              `resumed on free sibling ${account.label} instead, so the conversation context does not carry over`
            : `resumed conversation ${providerThreadId} belongs to an account in quota cooldown; ` +
              `resumed on free sibling ${account.label} instead, so the conversation context does not carry over`,
  );
}

/**
 * A turn arrived for a thread the wrapper does not know (typically a
 * wrapper restart: the daemon still owns the thread). Rebuild the session
 * through the NORMAL resume path — pool pin lookup, cooling checks,
 * buildLaunch, rewriteOptions, sibling transforms — by re-driving the
 * daemon's own thread/resume on an internal id whose terminal answer is
 * captured instead of reaching the wire. The original request waits in the
 * session queue and drains once the session is live; on failure the daemon
 * gets the resume's real error. Forwarding raw was the PLUG-310 bug: the
 * bridge either answered "No active ACP session" or launched the shim
 * without AGY_SHIM_* env.
 */
function restoreUnknownSession(
  id: JsonRpcId,
  method: "turn/start" | "turn/steer",
  params: Record<string, unknown>,
): void {
  const threadId = params.threadId as string;
  const record = threadRecord(threadId);
  const providerThreadId =
    typeof params.providerThreadId === "string" &&
    params.providerThreadId.length > 0
      ? params.providerThreadId
      : (record?.providerThreadId ?? null);
  const cwd =
    typeof params.cwd === "string" && params.cwd.length > 0
      ? params.cwd
      : (record?.cwd ?? null);
  if (cwd === null || providerThreadId === null) {
    sendError(
      id,
      -32000,
      `agy: no live session for thread ${threadId} and no recorded conversation to rebuild it from`,
    );
    return;
  }
  log(
    `thread ${threadId}: ${method} for an unknown session — rebuilding via thread/resume first`,
  );
  internalIdCounter -= 1;
  const rid = internalIdCounter;
  const done = new Promise<{ ok: boolean; error: unknown }>((resolve) => {
    internalAnswers.set(rid, (ok, _result, error) => {
      resolve({ ok, error });
    });
    try {
      handleThreadResume(rid, {
        threadId,
        cwd,
        providerThreadId,
        options: optionsRecord(params.options),
        instructionMode: params.instructionMode ?? "append",
      });
    } catch (error) {
      // §12.6 (ревизия 14): a synchronous throw inside the internal resume
      // must not leak the waiter slot or reject the executor — the daemon's
      // request gets the honest -32000 from `done` below instead.
      internalAnswers.delete(rid);
      resolve({ ok: false, error });
    }
  });
  const session = sessions.get(threadId);
  let queuedTurn: QueuedDaemonTurn | null = null;
  if (session !== undefined) {
    session.restoring = true;
    // A steered input becomes a fresh turn on the rebuilt session — the
    // daemon's request is answered when the bridge accepts it (or never
    // runs and answers with the resume error).
    queuedTurn = { kind: "daemon", requestId: id, params };
    session.queue.push(queuedTurn);
  }
  void done.then(({ ok, error }) => {
    // A racing restore or an explicit discard may have replaced our
    // session: touching the new one's restoring flag or queue would
    // corrupt its own rebuild, and our queued turn was already answered
    // with "thread stopped" when the old session went away.
    const s = sessions.get(threadId);
    if (s !== undefined && s !== session) {
      return;
    }
    if (ok && s !== undefined && !s.stopped) {
      s.restoring = false;
      drainQueue(s);
      return;
    }
    const errorText = ok
      ? `agy: rebuild for thread ${threadId} ended without a session`
      : errorMessageOf(error).slice(0, 300);
    if (s !== undefined) {
      // The real resume error beats discardSession's generic
      // "thread stopped" for the request that caused the rebuild.
      if (queuedTurn !== null && s.queue.includes(queuedTurn)) {
        s.queue.splice(s.queue.indexOf(queuedTurn), 1);
        sendError(id, -32000, errorText);
      }
      discardSession(s);
      return;
    }
    if (queuedTurn === null) {
      // The resume never produced a session — the request was never
      // queued anywhere, so answer it directly.
      sendError(id, -32000, errorText);
    }
  });
}

function handleTurnStart(id: JsonRpcId, params: Record<string, unknown>): void {
  const threadId = params.threadId;
  if (typeof threadId !== "string") {
    feedLine({ jsonrpc: "2.0", id, method: "turn/start", params });
    return;
  }
  const session = sessions.get(threadId);
  if (session === undefined || session.stopped) {
    restoreUnknownSession(id, "turn/start", params);
    return;
  }
  drainShimEvents();
  if (session.rateLimitsBlocked) {
    const resetsAt = session.blockedResetsAtMs ?? nearestCooldownEnd(session);
    if (resetsAt !== null && Date.now() >= resetsAt) {
      session.rateLimitsBlocked = false;
      session.blockedResetsAtMs = null;
      if (session.unblockTimer !== null) {
        clearTimeout(session.unblockTimer);
        session.unblockTimer = null;
      }
      emitRateLimits(session, "allowed", null, null);
      drainQueue(session);
    }
  }
  if (session.rateLimitsBlocked && session.accountLabel === null) {
    // §2.3 п.13 (ревизия 18): incoming turn in direct/relay mode before resetsAt is immediately rejected with 429
    const retryMsg =
      "⚠ Rate limit reached (429): slow down and try again later.";
    const info = {
      category: "rate-limit" as const,
      providerCode: null,
      httpStatusCode: 429,
    };
    emitDeltas(session.threadId, {
      kind: "provider.error",
      message: retryMsg,
      errorInfo: info,
      category: info.category,
      settlesTurn: true,
    });
    sendError(id, -32000, retryMsg);
    return;
  }
  const turnOptions = optionsRecord(params.options);
  const incoming = resolveModelSelection(
    typeof turnOptions.model === "string" ? turnOptions.model : undefined,
    typeof turnOptions.reasoningLevel === "string"
      ? turnOptions.reasoningLevel
      : undefined,
  );
  if (incoming.modelId !== undefined && incoming.modelId !== session.model) {
    // The new model rides every later session build (rotation included)
    // via baseOptions — the generic bridge only applies it at session
    // construction.
    session.model = incoming.modelId;
    session.baseOptions = { ...session.baseOptions, model: turnOptions.model };
  }
  // §7: a turn on a cooled account rotates first, then replays as handoff;
  // §2.3: a turn whose options name a model the session's account does not
  // offer rotates the same way, with the "model" cause. A restoring session
  // already ran those checks inside its rebuild — turns just queue on it.
  if (
    !session.rotating &&
    !session.stopped &&
    !session.restoring &&
    session.compact === null
  ) {
    const { cooled } = sessionAccountCooled(session);
    // §2.3 п.7: parked counts on parkedReason alone — an expired cooldown
    // must not let a turn through to a banned home.
    const ownerEntry =
      dataDir !== "" && session.accountLabel !== null
        ? loadLedger(dataDir).accounts[session.accountLabel]
        : undefined;
    if (cooled || ownerEntry?.parkedReason !== undefined) {
      log(
        `thread ${threadId}: turn/start on ${ownerEntry?.parkedReason !== undefined ? `parked account ${session.accountLabel} (${ownerEntry.parkedReason})` : `cooled account ${session.accountLabel}`}; rotating first`,
      );
      const queued: QueuedDaemonTurn = { kind: "daemon", requestId: id, params };
      session.pendingConsume = queued;
      const cause: RotationCause =
        ownerEntry?.parkedReason === "auth-dead"
          ? "auth-dead"
          : ownerEntry?.parkedReason === "tos-disabled"
            ? "tos-disabled"
            : ownerEntry?.parkedReason === "validation-required"
              ? "validation-required"
              : ownerEntry?.ineligibleAtMs !== undefined
                ? "ineligible"
                : "quota";
      startRotation(
        session,
        cause,
        cause === "auth-dead"
          ? "account lost its Google sign-in (auth_required)"
          : cause === "tos-disabled"
            ? "account disabled by Google (Terms of Service)"
            : cause === "validation-required"
              ? "account needs Google account verification"
              : cause === "ineligible"
                ? "account parked after eligibility refusal"
                : "account in quota cooldown",
      );
      return;
    }
    const catalog = accountModelCatalog();
    if (
      session.model !== undefined &&
      session.accountLabel !== null &&
      dataDir !== "" &&
      accountsEnabled(process.env) &&
      accountModelState(
        Object.hasOwn(catalog, session.accountLabel)
          ? catalog[session.accountLabel]
          : undefined,
        session.model,
        Date.now(),
      ) === "unsupported"
    ) {
      log(
        `thread ${threadId}: account ${session.accountLabel} does not offer ${session.model}; rotating first`,
      );
      const queued: QueuedDaemonTurn = { kind: "daemon", requestId: id, params };
      session.pendingConsume = queued;
      startRotation(
        session,
        "model",
        `model ${session.model} is not offered by account ${session.accountLabel}`,
      );
      return;
    }
  }
  if (session.needsHandoff) {
    session.needsHandoff = false;
    const text = buildQuotaHandoffPrompt({
      prompt: promptText(params.input as PromptItem[] | undefined),
      recentAssistantText: session.recentAssistantText,
      cwd: session.cwd,
      queuedFollowers: session.queue.length,
    });
    params.input = [{ type: "text", text }];
  }
  enqueueDaemonTurn(session, id, params);
  drainQueue(session);
}

function handleTurnSteer(id: JsonRpcId, params: Record<string, unknown>): void {
  const threadId = params.threadId;
  const session =
    typeof threadId === "string" ? sessions.get(threadId) : undefined;
  if (session === undefined || session.stopped) {
    if (typeof threadId === "string") {
      restoreUnknownSession(id, "turn/steer", params);
      return;
    }
    feedLine({ jsonrpc: "2.0", id, method: "turn/steer", params });
    return;
  }
  // §2.3 п.13 (ревизия 18) & п.15 (ревизия 19): on turn/steer, any unconfirmed candidate buffer
  // is immediately flushed to client, and detector state is reset to pristine.
  // Full interrupted message is absorbed without leaking to client.
  if (isAgentInterruptedMessage(session.agentMessageText)) {
    session.candidateBuffer = [];
    session.heldTextClose = null;
    session.agentMessageText = "";
    session.interruptedPending = true;
    resolveInterruptedPending(session, "aborted");
  } else if (session.candidateBuffer.length > 0) {
    for (const b of session.candidateBuffer) {
      if (session.compact?.collecting && typeof b.text === "string") {
        session.compact.summaryBuf += b.text;
      }
      if (typeof b.text === "string") {
        session.recentAssistantText = (
          session.recentAssistantText + b.text
        ).slice(-HANDOFF_STREAMED_TEXT_CAP);
      }
      emitDeltas(session.threadId, b);
      session.streamedAgentMessage = true;
    }
    session.candidateBuffer = [];
  }
  if (session.heldTextClose !== null) {
    emitDeltas(session.threadId, session.heldTextClose);
    session.heldTextClose = null;
  }
  if (session.interruptedPending) {
    resolveInterruptedPending(session, "aborted");
  }
  session.agentMessageText = "";
  session.quotaRefusalText = null;
  session.validationRefusal = false;
  if (session.restoring) {
    // The rebuild lands the steered input as a fresh turn afterwards.
    enqueueDaemonTurn(session, id, params);
    drainQueue(session);
    return;
  }
  if (session.rotating && !session.bridgeTurnBusy) {
    // Nothing for the steer to land on yet: it becomes a queued turn that
    // runs on the new session right after the handoff. The request is
    // answered now; the turn's own accepted arrives when it is injected.
    sendResult(id, { threadId });
    session.queue.push({
      kind: "internal",
      tag: "artifact-nudge", // plain internal turn; tag is cosmetic
      input:
        (params.input as { type: string; text: string }[] | undefined) ?? [],
      suppressOpen: false,
      suppressAccepted: true,
      consumeClientRequestId:
        typeof params.clientRequestId === "string"
          ? params.clientRequestId
          : undefined,
      onSettled: null,
    });
    return;
  }
  // PLUG-310: a raw steer rides queuedInputs into the bridge's reconcile
  // carrying the daemon's static launch spec (env:{}) — the rebuilt session
  // then spawns the shim WITHOUT AGY_SHIM_* and it exits 2.
  params.options = rewriteOptions(session, optionsRecord(params.options));
  feedLine({ jsonrpc: "2.0", id, method: "turn/steer", params });
}

function handleThreadStop(id: JsonRpcId, params: Record<string, unknown>): void {
  const threadId = params.threadId;
  const session =
    typeof threadId === "string" ? sessions.get(threadId) : undefined;
  feedLine({ jsonrpc: "2.0", id, method: "thread/stop", params });
  if (session !== undefined) {
    discardSession(session);
  }
}

function handleLine(line: string): void {
  ensureStarted();
  let msg: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      msg = parsed as Record<string, unknown>;
    }
  } catch {
    msg = null;
  }
  if (msg === null) {
    acpBridge.handleLine(line);
    return;
  }
  // A daemon JSON-RPC response (answers to runtime requests like
  // interaction/request) flows straight through.
  if (
    msg.method === undefined &&
    msg.id !== undefined &&
    ("result" in msg || "error" in msg)
  ) {
    if (pendingInteractions.has(msg.id as JsonRpcId)) {
      pendingInteractions.delete(msg.id as JsonRpcId);
    }
    acpBridge.handleLine(line);
    return;
  }
  const params = optionsRecord(msg.params);
  switch (msg.method) {
    case "model/list":
      handleModelList(msg.id as JsonRpcId);
      return;
    case "thread/start":
      handleThreadStart(msg.id as JsonRpcId, params);
      return;
    case "thread/resume":
      handleThreadResume(msg.id as JsonRpcId, params);
      return;
    case "turn/start":
      handleTurnStart(msg.id as JsonRpcId, params);
      return;
    case "turn/steer":
      handleTurnSteer(msg.id as JsonRpcId, params);
      return;
    case "thread/stop":
      handleThreadStop(msg.id as JsonRpcId, params);
      return;
    case "thread/discard": {
      const session =
        typeof params.threadId === "string"
          ? (sessions.get(params.threadId) ?? stoppingSessions.get(params.threadId))
          : undefined;
      if (session !== undefined) {
        discardSession(session);
      }
      if (typeof params.threadId === "string") {
        stoppingSessions.delete(params.threadId);
        forgetThreadRecord(params.threadId);
      }
      acpBridge.handleLine(line);
      return;
    }
    default:
      acpBridge.handleLine(line);
      return;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let ensured = false;
function ensureStarted(): void {
  if (ensured) {
    return;
  }
  ensured = true;
  patchStdout();
}

export const experimental_providerBridge = {
  experimental_apiVersion: 1 as const,
  start(context: ProviderBridgeContext): void {
    dataDir = context.dataDir;
    logFile = join(context.dataDir, "acp-wrapper.log");
    ensureShimDir();
    // Events older than this wrapper instance belong to dead sessions and
    // would re-emit stale usage/errors into live threads — skip to EOF once,
    // before any session of this instance can produce events.
    try {
      const file = eventsFilePath();
      if (existsSync(file)) {
        eventsFd = openSync(file, "r");
        eventsOffset = fstatSync(eventsFd).size;
      }
    } catch {}
    ensureStarted();
    loadModelDiskCache();
    log(`acp wrapper started (dataDir=${context.dataDir})`);
    // §9 п.1 (provider-agy-installs): registry registration at startup —
    // names and binary paths; version reporting waits on §13 п.1.
    log(registryLogLine(dataDir));
    // Defense-in-depth sweep (spec §12.3): orphans of dead workers and stale
    // harness tmp roots. Best-effort — never lets a scan failure break start.
    reapOrphanShims();
  },
  handleLine,
  onClose: () => {
    for (const session of [...sessions.values(), ...stoppingSessions.values()]) {
      if (session.waitTimer !== null) {
        clearTimeout(session.waitTimer);
      }
      if (session.unblockTimer !== null) {
        clearTimeout(session.unblockTimer);
      }
    }
    reapOrphanShims();
    return acpBridge.onClose?.();
  },
  onSigterm: () => acpBridge.onSigterm?.(),
  onSigint: () => acpBridge.onSigint?.(),
};
