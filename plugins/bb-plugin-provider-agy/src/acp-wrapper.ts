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
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountByLabel,
  accountsEnabled,
  conversationAccount,
  ineligibleBreakerMax,
  ineligibleBreakerWindowMs,
  ineligibleCooldownMs,
  isAccountIneligible,
  listAccounts,
  loadLedger,
  markAccountCooldown,
  markAccountUse,
  pickAccount,
  rememberConversation,
  saveLedger,
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
import { parseAgyModelsOutput, resolveAgyCommand } from "./agy-cli.js";

type JsonRpcId = string | number;
interface ProviderBridgeContext {
  pluginId: string;
  dataDir: string;
  tempDir: string;
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

function sendResult(id: JsonRpcId, result: unknown): void {
  writeOutbound({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
  writeOutbound({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  writeOutbound({ jsonrpc: "2.0", method, params });
}

function emitDeltas(threadId: string, ...deltas: Record<string, unknown>[]): void {
  if (deltas.length === 0) {
    return;
  }
  sendNotification("thread/delta", { threadId, deltas });
}

function feedLine(message: Record<string, unknown>): void {
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
        emitUsage(session, event.usage);
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

function emitUsage(session: WSession, usage: AcpUsage): void {
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
  emitDeltas(session.threadId, {
    kind: "usage",
    total,
    last,
    modelContextWindow: contextWindowSize(session.model),
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
  rotationCause: "quota" | "ineligible" | null;
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
}

const sessions = new Map<string, WSession>();

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
  };
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

const SHIM_SCRIPT = (() => {
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
})();

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

function shimEnvFor(session: WSession): Record<string, string> {
  return {
    AGY_SHIM_REAL_BIN: resolveAgyCommand(process.env),
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
function buildLaunch(session: WSession): void {
  session.nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  session.controlFile = join(
    shimDir(),
    `ctl-${session.threadId}-${session.nonce}.ndjson`,
  );
  ensureShimDir();
  const env = shimEnvFor(session);
  const args: string[] = [SHIM_SCRIPT, "acp"];
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
      supportedLevels: ["low", "medium", "high"],
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
}

/** providerOptions payload the bridge sees for this session right now. */
function providerOptionsFor(session: WSession): Record<string, unknown> {
  return { acpLaunchSpec: session.launchSpec, acpDialect: "generic" };
}

function filterEnvVars(
  envVars: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(optionsRecord(envVars))) {
    if (PROTECTED_CHILD_ENV.has(key) || typeof value !== "string") {
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
    envVars: filterEnvVars(options.envVars ?? session.envVars),
  };
}

/** The launch env for `agy models` / cold ACP probes: first pooled account. */
function maintenanceEnvAndArgs(): {
  env: Record<string, string>;
  args: string[];
} {
  const env: Record<string, string> = {};
  const args: string[] = [];
  if (dataDir !== "" && accountsEnabled(process.env)) {
    const ledger = loadLedger(dataDir);
    const account = pickAccount(ledger, listAccounts(dataDir));
    if (account !== null) {
      args.push("--gemini-dir", join(account.home, ".gemini"));
      if (account.proxy !== null) {
        env.HTTPS_PROXY = account.proxy;
        env.https_proxy = account.proxy;
        env.HTTP_PROXY = account.proxy;
        env.http_proxy = account.proxy;
      }
      return { env, args };
    }
  }
  if (dataDir !== "") {
    const relay = resolveCliproxyRelay(dataDir);
    if (relay !== null) {
      args.push("--gemini-dir", join(relay.home, ".gemini"));
      env.GEMINI_API_KEY = relay.apiKey;
      env.GOOGLE_GEMINI_BASE_URL = relay.baseUrl;
    }
  }
  return { env, args };
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

function buildModelListResult(): {
  models: Record<string, unknown>[];
  selectedOnlyModels: string[];
} {
  const raw = modelCatalog?.raw ?? [];
  const families = new Map<
    string,
    { displayName: string; variants: Map<string, string> }
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
      };
      families.set(family, fam);
    }
    fam.variants.set(effort, entry.id);
  }
  const flash = [...families.keys()].filter((id) => id.includes("flash"));
  const defaultFamily =
    flash.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ??
    families.keys().next().value ??
    "";
  const models = [...families.entries()].map(([id, fam]) => {
    const efforts = [...fam.variants.keys()].sort(
      (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
    );
    return {
      id,
      model: id,
      displayName: fam.displayName,
      description: "",
      supportedReasoningEfforts: efforts.map((effort) => ({
        reasoningEffort: effort,
        description: `${effort.charAt(0).toUpperCase()}${effort.slice(1)} reasoning effort`,
      })),
      defaultReasoningEffort: fam.variants.has("medium")
        ? "medium"
        : (efforts[0] ?? "medium"),
      isDefault: id === defaultFamily,
    };
  });
  return { models, selectedOnlyModels: [] };
}

function queryAgyModels(): Promise<{ id: string; displayName: string }[]> {
  return new Promise((resolve) => {
    const { env, args } = maintenanceEnvAndArgs();
    let child;
    try {
      child = spawn(
        resolveAgyCommand(process.env),
        [...args, "models"],
        { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      resolve([]);
      return;
    }
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
      resolve(parseAgyModelsOutput(stdout));
    });
  });
}

/**
 * Cold-path discovery against a live `agy acp`: session/new's configOptions
 * name the selectable model values when `agy models` cannot answer.
 */
function queryAcpSessionModels(): Promise<{ id: string; displayName: string }[]> {
  return new Promise((resolve) => {
    const { env, args } = maintenanceEnvAndArgs();
    let child;
    try {
      child = spawn(process.execPath, [SHIM_SCRIPT, "acp", ...args], {
        env: {
          ...process.env,
          ...env,
          AGY_SHIM_REAL_BIN: resolveAgyCommand(process.env),
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
    const pending = new Map<number, (result: unknown) => void>();
    let nextId = 1;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve([]);
    }, 15_000);
    const send = (method: string, params: Record<string, unknown>) =>
      new Promise<unknown>((res, rej) => {
        const id = nextId++;
        pending.set(id, res);
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
          const msg = JSON.parse(line) as { id?: number; result?: unknown };
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            pending.get(msg.id)?.(msg.result);
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
        const session = (await send("session/new", {
          cwd: process.cwd(),
          mcpServers: [],
        })) as {
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
        child.kill("SIGKILL");
      }
    })();
  });
}

function handleModelList(id: JsonRpcId): void {
  if (!modelCacheStale()) {
    sendResult(id, buildModelListResult());
    return;
  }
  void (async () => {
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
          resetsAtMs,
        },
      ],
      reachedReason: reason,
      overageStatus: null,
      overageReason: null,
    },
  });
  session.rateLimitsBlocked = status === "blocked";
}

function clearRateLimit(session: WSession): void {
  if (session.rateLimitsBlocked) {
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
    if (session.stopped || session.bridgeTurnBusy || session.queue.length === 0) {
      return;
    }
    const head = session.queue[0];
    // Daemon turns wait out rotations and the compaction automaton; internal
    // turns ARE the automaton and always drain.
    if (head.kind === "daemon" && (session.rotating || session.compact !== null)) {
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
      if (head.consumeClientRequestId !== undefined) {
        emitDeltas(session.threadId, {
          kind: "input.accepted",
          clientRequestId: head.consumeClientRequestId,
        });
      }
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
): { account: { label: string; home: string; proxy: string | null } | null } {
  if (dataDir === "" || !accountsEnabled(process.env)) {
    return { account: null };
  }
  const ledger = loadLedger(dataDir);
  const accounts = listAccounts(dataDir);
  const candidate = pickAccount(ledger, accounts, exclude);
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
 * Book the failure on the session's account: quota cools it (reset text or
 * the default 30m), an eligibility refusal parks it for the long cooldown —
 * unless the breaker sees a wave of parkings and suspects the egress.
 */
function coolSessionAccount(
  session: WSession,
  cause: "quota" | "ineligible",
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
  if (cause === "ineligible") {
    const windowMs = ineligibleBreakerWindowMs();
    const parkedCount = Object.values(ledger.accounts).filter(
      (entry) =>
        typeof entry.ineligibleAtMs === "number" &&
        entry.ineligibleAtMs > now - windowMs &&
        entry.ineligibleAtMs <= now,
    ).length;
    if (parkedCount >= ineligibleBreakerMax()) {
      log(
        `thread ${session.threadId}: ineligible breaker open (${parkedCount} parked in ${windowMs / 60_000}m); not parking ${session.accountLabel}`,
      );
      return "breaker";
    }
    const location =
      /not currently available in your location/iu.test(message) &&
      !/verify your account|https:\/\/accounts\.google\.com\//iu.test(message);
    markAccountCooldown(
      ledger,
      session.accountLabel,
      now + ineligibleCooldownMs(location),
      message,
    );
    ledger.accounts[session.accountLabel].ineligibleAtMs = now;
    saveLedger(dataDir, ledger);
    log(
      `thread ${session.threadId}: account ${session.accountLabel} parked (${location ? "location" : "verification required"})`,
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
  cause: "quota" | "ineligible",
  message: string,
): "rotate" | "wait" | "fail" {
  const cooled = coolSessionAccount(session, cause, message);
  if (cooled === "breaker") {
    return "fail";
  }
  const { account } = freeSibling(session, session.accountLabel);
  if (account !== null) {
    return "rotate";
  }
  if (cause === "ineligible") {
    return "fail"; // eligibility never waits: rotate or fail
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
  const ends = Object.values(ledger.accounts)
    .map((entry) => entry.cooldownUntilMs)
    .filter((ms) => ms > Date.now());
  return ends.length > 0 ? Math.min(...ends) : null;
}

/**
 * The failure reaches the daemon: a provider.error carrying the native
 * errorInfo provider-retry reads, the blocked rateLimits snapshot, and — for
 * a turn the daemon still holds open — the failed boundary that closes it.
 */
function failOut(session: WSession, message: string): void {
  if (session.pendingConsume !== null) {
    sendError(session.pendingConsume.requestId, -32000, message);
    session.pendingConsume = null;
  }
  const info = nativeErrorInfo(message);
  emitDeltas(session.threadId, {
    kind: "provider.error",
    message,
    ...(info === undefined ? {} : { errorInfo: info, category: info.category }),
    settlesTurn: true,
  });
  if (session.daemonTurnOpen) {
    emitDeltas(session.threadId, {
      kind: "turn.boundary",
      status: "failed",
      error: { message },
    });
    session.daemonTurnOpen = false;
  }
  if (classifyError(message) === "rate-limit") {
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
  cause: "quota" | "ineligible",
  message: string,
): void {
  const { account } = freeSibling(session, session.accountLabel);
  if (account === null) {
    log(
      `thread ${session.threadId}: rotation found no free sibling; failing out`,
    );
    failOut(session, message);
    return;
  }
  session.rotating = true;
  session.rotationCause = cause;
  session.accountLabel = account.label;
  if (dataDir !== "") {
    const ledger = loadLedger(dataDir);
    markAccountUse(ledger, account.label);
    saveLedger(dataDir, ledger);
  }
  buildLaunch(session);
  log(
    `thread ${session.threadId}: rotating to account ${account.label} (${cause})`,
  );
  void synthThreadStart(session).then(({ ok, error }) => {
    if (ok) {
      // Only now is the generic bridge's session registered — inject the
      // queued handoff turn.
      drainQueue(session);
      return;
    }
    log(
      `thread ${session.threadId}: rotation session failed to start: ${JSON.stringify(error)?.slice(0, 300)}`,
    );
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
  cause: "quota" | "ineligible",
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
    startRotation(session, cause, message);
  }, waitMs);
  session.waitTimer.unref?.();
  log(
    `thread ${session.threadId}: whole pool cooling; internal retry in ${Math.round(waitMs / 1000)}s (attempt ${session.autoRetryCount}/${quotaRetryMaxAttempts()})`,
  );
}

/** The quota/eligibility error now decides the open turn's fate. */
function handleClassifiedError(
  session: WSession,
  cause: "quota" | "ineligible",
  message: string,
): void {
  const plan = planRotation(session, cause, message);
  switch (plan) {
    case "rotate":
      startRotation(session, cause, message);
      return;
    case "wait":
      scheduleWaitRetry(session, cause, message);
      return;
    case "fail":
      failOut(session, message);
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
  void synthThreadStart(session).then(({ ok }) => {
    if (!ok) {
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
  void internalRequest("thread/resume", params).then(() => {
    session.compact = null;
    drainQueue(session);
  });
  log(
    `thread ${session.threadId}: compaction fallback restores conversation ${compact.oldProviderThreadId}`,
  );
}

// ---------------------------------------------------------------------------
// Outbound interception
// ---------------------------------------------------------------------------

/** interaction/request ids in flight, by request id → threadId. */
const pendingInteractions = new Map<JsonRpcId, string>();

function resolveInteractions(threadId: string): void {
  for (const [id, owner] of [...pendingInteractions.entries()]) {
    if (owner !== threadId) {
      continue;
    }
    pendingInteractions.delete(id);
    // A synthesized deny settles the bridge's sendRuntimeRequest promise,
    // which lets the ACP permission responder answer the agent's request.
    feedLine({ jsonrpc: "2.0", id, result: { decision: "deny" } });
    log(`thread ${threadId}: resolved hanging interaction ${String(id)}`);
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
      reason:
        session.rotationCause === "ineligible"
          ? "this account failed Google's Antigravity eligibility check; the turn is being re-run on another account, so the conversation context does not carry over"
          : "the quota window closed on this account; the turn is being re-run on another account, so the conversation context does not carry over",
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
  if (category !== "rate-limit" && !isAccountIneligible(text)) {
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
  handleClassifiedError(
    session,
    category === "rate-limit" ? "quota" : "ineligible",
    text,
  );
  return "drop";
}

function onTurnBoundary(session: WSession, delta: Record<string, unknown>): void {
  const status = typeof delta.status === "string" ? delta.status : "failed";
  session.bridgeTurnBusy = false;
  session.daemonTurnOpen = false;
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

function processDeltaLine(
  threadId: string,
  deltas: Record<string, unknown>[],
): Record<string, unknown>[] {
  const session = sessions.get(threadId);
  if (session === undefined) {
    return deltas;
  }
  drainShimEvents();
  const out: Record<string, unknown>[] = [];
  for (const delta of deltas) {
    switch (delta.kind) {
      case "turn.open": {
        session.bridgeTurnBusy = true;
        if (session.suppressOpenNext) {
          session.suppressOpenNext = false;
          continue;
        }
        session.daemonTurnOpen = true;
        out.push(delta);
        continue;
      }
      case "turn.boundary": {
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
          delta.channel === "agentMessage" &&
          typeof delta.text === "string"
        ) {
          if (session.compact?.collecting) {
            session.compact.summaryBuf += delta.text;
          }
          session.recentAssistantText = (
            session.recentAssistantText + delta.text
          ).slice(-HANDOFF_STREAMED_TEXT_CAP);
        }
        out.push(delta);
        continue;
      }
      case "item.open": {
        const item = optionsRecord(delta.item);
        if (item.type === "compaction") {
          session.compactInFlight = true;
        }
        out.push(delta);
        continue;
      }
      case "session.reset": {
        session.recentAssistantText = "";
        out.push(delta);
        continue;
      }
      case "provider.error": {
        if (onProviderErrorDelta(session, delta) === "drop") {
          continue;
        }
        // A pass-through quota error carries the native errorInfo the
        // generic bridge never sets (spec §3).
        const info = nativeErrorInfo(
          typeof delta.message === "string" ? delta.message : "",
        );
        if (info !== undefined && delta.errorInfo === undefined) {
          out.push({ ...delta, errorInfo: info, category: info.category });
          if (info.category === "rate-limit") {
            emitRateLimits(
              session,
              "blocked",
              quotaResetAtMs(
                typeof delta.message === "string" ? delta.message : "",
              ) ?? nearestCooldownEnd(session),
              typeof delta.message === "string" ? delta.message : null,
            );
          }
        } else {
          out.push(delta);
        }
        continue;
      }
      default: {
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
    rawWrite(`${line}\n`);
    return;
  }
  // Outbound requests (the bridge asks the daemon: interaction/request etc.).
  if (msg.method === "interaction/request" && msg.id !== undefined) {
    const params = optionsRecord(msg.params);
    if (typeof params.threadId === "string") {
      pendingInteractions.set(msg.id as JsonRpcId, params.threadId);
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

function poolPickAccount(session: WSession): void {
  if (dataDir === "" || !accountsEnabled(process.env)) {
    session.accountLabel = null;
    return;
  }
  const ledger = loadLedger(dataDir);
  const picked = pickAccount(ledger, listAccounts(dataDir));
  session.accountLabel = picked?.label ?? null;
  if (picked !== null) {
    markAccountUse(ledger, picked.label);
    saveLedger(dataDir, ledger);
    log(
      `thread ${session.threadId}: pinned to account ${picked.label} (proxy ${picked.proxy !== null ? "yes" : "no"})`,
    );
  }
}

function discardSession(session: WSession): void {
  session.stopped = true;
  if (session.waitTimer !== null) {
    clearTimeout(session.waitTimer);
    session.waitTimer = null;
  }
  for (const queued of session.queue.splice(0)) {
    if (queued.kind === "daemon") {
      sendError(queued.requestId, -32000, "thread stopped");
    }
  }
  resolveInteractions(session.threadId);
  sessions.delete(session.threadId);
}

function handleThreadStart(id: JsonRpcId, params: Record<string, unknown>): void {
  const threadId = params.threadId;
  const cwd = params.cwd;
  if (typeof threadId !== "string" || typeof cwd !== "string") {
    feedLine({ jsonrpc: "2.0", id, method: "thread/start", params });
    return;
  }
  const existing = sessions.get(threadId);
  if (existing !== undefined) {
    discardSession(existing);
  }
  const session = newSession(threadId, cwd);
  sessions.set(threadId, session);
  session.baseParams = { ...params };
  delete session.baseParams.options;
  session.baseOptions = optionsRecord(params.options);
  session.envVars = filterEnvVars(session.baseOptions.envVars);
  poolPickAccount(session);
  const declared =
    typeof session.baseOptions.permissionMode === "string"
      ? session.baseOptions.permissionMode
      : "full";
  session.declaredMode = declared;
  session.agyMode = mapPermissionMode(declared).agy;
  buildLaunch(session);
  params.options = rewriteOptions(session, { ...session.baseOptions });
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
  const existing = sessions.get(threadId);
  if (existing !== undefined) {
    discardSession(existing);
  }
  const session = newSession(threadId, cwd);
  sessions.set(threadId, session);
  session.baseParams = { ...params };
  delete session.baseParams.options;
  session.baseOptions = optionsRecord(params.options);
  session.envVars = filterEnvVars(session.baseOptions.envVars);
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
  if (!cooled || dataDir === "" || !accountsEnabled(process.env)) {
    buildLaunch(session);
    params.options = rewriteOptions(session, { ...session.baseOptions });
    log(
      `thread ${threadId}: resuming ${providerThreadId} on account ${session.accountLabel ?? "direct"}`,
    );
    feedLine({ jsonrpc: "2.0", id, method: "thread/resume", params });
    return;
  }
  // The owner is cooling: the resume becomes a fresh thread on a free
  // sibling, and the first turn rides a handoff prompt (spec §7).
  const { account } = freeSibling(session, session.accountLabel);
  log(
    `thread ${threadId}: resume owner ${session.accountLabel} cools until ${new Date(untilMs).toISOString()}; sibling ${account?.label ?? "none"}`,
  );
  if (account === null) {
    buildLaunch(session);
    params.options = rewriteOptions(session, { ...session.baseOptions });
    feedLine({ jsonrpc: "2.0", id, method: "thread/resume", params });
    return;
  }
  session.needsHandoff = true;
  session.rotating = true; // hold daemon turns until the sibling is up
  session.accountLabel = account.label;
  const ledger = loadLedger(dataDir);
  markAccountUse(ledger, account.label);
  saveLedger(dataDir, ledger);
  buildLaunch(session);
  const startParams = {
    ...session.baseParams,
    threadId,
    cwd,
    options: rewriteOptions(session, { ...session.baseOptions }),
  };
  delete (startParams as { providerThreadId?: unknown }).providerThreadId;
  void internalRequest("thread/start", startParams).then(({ ok, error }) => {
    session.rotating = false;
    if (!ok) {
      session.needsHandoff = false;
      sendError(
        id,
        -32000,
        `agy could not start on the resume sibling: ${JSON.stringify(error)?.slice(0, 300)}`,
      );
      return;
    }
    sendNotification("session/replaced", {
      threadId,
      providerThreadId: session.providerThreadId,
      reason:
        `resumed conversation ${providerThreadId} belongs to an account in quota cooldown; ` +
        `resumed on free sibling ${account.label} instead, so the conversation context does not carry over`,
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

function handleTurnStart(id: JsonRpcId, params: Record<string, unknown>): void {
  const threadId = params.threadId;
  if (typeof threadId !== "string") {
    feedLine({ jsonrpc: "2.0", id, method: "turn/start", params });
    return;
  }
  const session = sessions.get(threadId);
  if (session === undefined) {
    feedLine({ jsonrpc: "2.0", id, method: "turn/start", params });
    return;
  }
  drainShimEvents();
  // §7: a turn on a cooled account rotates first, then replays as handoff.
  if (!session.rotating && !session.stopped) {
    const { cooled } = sessionAccountCooled(session);
    if (cooled) {
      log(
        `thread ${threadId}: turn/start on cooled account ${session.accountLabel}; rotating first`,
      );
      const queued: QueuedDaemonTurn = { kind: "daemon", requestId: id, params };
      session.pendingConsume = queued;
      startRotation(session, "quota", "account in quota cooldown");
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
  if (session === undefined) {
    feedLine({ jsonrpc: "2.0", id, method: "turn/steer", params });
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
          ? sessions.get(params.threadId)
          : undefined;
      if (session !== undefined) {
        discardSession(session);
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
    ensureStarted();
    loadModelDiskCache();
    log(`acp wrapper started (dataDir=${context.dataDir})`);
  },
  handleLine,
  onClose: () => {
    for (const session of sessions.values()) {
      if (session.waitTimer !== null) {
        clearTimeout(session.waitTimer);
      }
    }
    return acpBridge.onClose?.();
  },
  onSigterm: () => acpBridge.onSigterm?.(),
  onSigint: () => acpBridge.onSigint?.(),
};
