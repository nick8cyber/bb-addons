/**
 * The `agy` provider bridge: Antigravity's CLI as a first-class bb provider,
 * speaking the bb Provider Bridge Protocol natively (line-delimited JSON-RPC
 * 2.0 on stdin/stdout, protocol version 1, `thread/event` grammar — the
 * version bb 0.39 runs).
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
 * - Ids: every turn and item id is minted here, with per-process entropy, and
 *   item ids are scoped by their turn — never an agy identifier.
 * - Grammar: every accepted turn settles exactly once; every item emits
 *   `item/started` before any delta; `thread/identity` precedes the thread's
 *   first event; a `release` stop fabricates no interruption.
 * - Child processes: finalize on `close`, not `exit`; a stale child's output
 *   can never reach a fresh session (`generation` is checked in every
 *   callback); the child's env is derived from this process's, not inherited
 *   implicitly.
 */
import {
  type PromptInput,
  type ThreadEvent,
  type ThreadEventTokenUsageBreakdown,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
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
import { appendFileSync } from "node:fs";
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
   * Set once this conversation has produced an artifact-shaped
   * `write_to_file`; every later turn then carries WRITE_GUARDRAIL so the
   * model does not repeat it. Off by default: a session that never hit the
   * bug pays nothing and is never told about a field it was not using.
   */
  writeGuardrail: boolean;
}

const sessions = new Map<string, Session>();

function emit(session: Session, event: ThreadEvent): void {
  notify(BRIDGE_NOTIFICATION_METHODS.threadEvent, {
    threadId: session.threadId,
    event,
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

/** The fields every provider event on this session carries. */
function base(session: Session): {
  threadId: string;
  providerThreadId: string;
} {
  return {
    threadId: session.threadId,
    // Only reachable once identity is known: nothing is emitted before that.
    providerThreadId: session.providerThreadId ?? "",
  };
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
  for (const [key, value] of Object.entries(args.envVars ?? {})) {
    env[key] = value;
  }
  log(
    `spawning ${command} ${spawnArgs.map((a) => JSON.stringify(a)).join(" ")} (cwd ${session.cwd})`,
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

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const text = chunk.trim();
    if (text.length > 0) {
      session.lastStderr = text.slice(0, 2000);
      log(`agy stderr (${session.threadId}): ${text}`);
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
    failSession(
      session,
      `agy exited (code ${String(code)}, signal ${String(signal)})${
        session.lastStderr === null ? "" : `: ${session.lastStderr}`
      }`,
    );
  });
}

/**
 * The child is gone or unusable: settle everything in flight as failed so no
 * accepted turn is left without a terminal state, then release identity
 * waiters so a pending thread/start cannot hang.
 */
function failSession(session: Session, message: string): void {
  log(`session ${session.threadId} failed: ${message}`);
  session.lastFailure = message;
  if (session.providerThreadId !== null) {
    emit(session, {
      type: "provider/error",
      ...base(session),
      message,
      // A session-level failure is not one turn's fault: thread scope.
      scope: { kind: "thread" },
    });
  }
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
    emit(session, {
      type: "turn/completed",
      ...base(session),
      status: "failed",
      error: { message },
      scope: { kind: "turn", turnId: turn.turnId },
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
      providerRaw(session, "unknown", event.payload);
    }
  }
}

/**
 * Identity precedes traffic. A resumed session already knows its id and only
 * confirms it here; a fresh one learns it from `init` and only then may drain
 * the turns that were waiting for a session to exist.
 */
function adoptIdentity(session: Session, conversationId: string | null): void {
  if (conversationId === null) {
    return;
  }
  const isNew = session.providerThreadId !== conversationId;
  session.providerThreadId = conversationId;
  if (isNew) {
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: session.threadId,
      providerThreadId: conversationId,
      sessionRestorable: true,
    });
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
    emit(session, {
      type: "item/started",
      ...base(session),
      item: { type: "agentMessage", id: item.itemId, text: "" },
      scope: { kind: "turn", turnId: turn.turnId },
    });
  }
  if (event.textDelta !== null && event.textDelta.length > 0) {
    turn.producedText = true;
    item.text += event.textDelta;
    emit(session, {
      type: "item/agentMessage/delta",
      ...base(session),
      itemId: item.itemId,
      delta: event.textDelta,
      scope: { kind: "turn", turnId: turn.turnId },
    });
  }
  if (event.state === "DONE") {
    emit(session, {
      type: "item/completed",
      ...base(session),
      item: { type: "agentMessage", id: item.itemId, text: item.text },
      scope: { kind: "turn", turnId: turn.turnId },
    });
    turn.items.delete(stepIndex);
  }
}

function closeOpenItems(session: Session, turn: Turn): void {
  for (const [stepIndex, item] of [...turn.items]) {
    emit(session, {
      type: "item/completed",
      ...base(session),
      item: { type: "agentMessage", id: item.itemId, text: item.text },
      scope: { kind: "turn", turnId: turn.turnId },
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
  if (child === null || session.turns.length > 0) {
    // With another turn already queued behind this one, agy has its stdin
    // line and will answer it first: a nudge appended now would be matched
    // against the wrong turn. Fail honestly instead of mis-threading.
    return false;
  }
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
  const turn = session.turns.shift();
  if (turn === undefined) {
    // agy reports a rejected session (a bad flag combination, a model it will
    // not run) as an ERROR result with an empty conversation id, before any
    // turn exists. Reporting that as droppable noise is how a dead session
    // looks healthy — it is a session failure and must say so.
    if (event.status !== null && event.status !== "SUCCESS") {
      failSession(session, event.error ?? `agy refused the session (${event.status})`);
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
    emit(session, {
      type: "thread/tokenUsage/updated",
      ...base(session),
      tokenUsage: { total, last, modelContextWindow: null },
      scope: { kind: "turn", turnId: turn.turnId },
    });
  }

  // A non-SUCCESS status whose error is verbatim a tool error the agent then
  // recovered from is agy talking about a step, not about the turn: the turn
  // ran to its response and the files are on disk. Failing it would end the
  // thread on work that succeeded, so it settles as completed and the tool
  // error stays visible as the `provider/raw` step that carried it.
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
      turn.artifactRetries > 0);
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
      `turn ${turn.turnId}: agy reported a recovered tool error as the turn's ` +
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
    emit(session, {
      type: "provider/error",
      ...base(session),
      message,
      scope: { kind: "turn", turnId: turn.turnId },
    });
    emit(session, {
      type: "turn/completed",
      ...base(session),
      status: "failed",
      error: { message },
      scope: { kind: "turn", turnId: turn.turnId },
    });
  } else {
    emit(session, {
      type: "turn/completed",
      ...base(session),
      status: "completed",
      scope: { kind: "turn", turnId: turn.turnId },
    });
  }
  // The next queued turn is now the live one.
  const next = session.turns[0];
  if (next !== undefined && !next.started) {
    emitTurnStarted(session, next);
  }
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function emitTurnStarted(session: Session, turn: Turn): void {
  turn.started = true;
  if (turn.clientRequestId !== undefined) {
    emit(session, {
      type: "turn/input/accepted",
      ...base(session),
      clientRequestId: turn.clientRequestId,
      scope: { kind: "turn", turnId: turn.turnId },
    });
  }
  emit(session, {
    type: "turn/started",
    ...base(session),
    scope: { kind: "turn", turnId: turn.turnId },
  });
}

/**
 * Hand a turn to the child. agy consumes one line per turn strictly in
 * order, so the queue position is the truth about which turn its events
 * belong to; only the head has been announced as started.
 */
function enqueueTurn(session: Session, turn: Turn): void {
  if (session.child === null && session.providerThreadId !== null) {
    // The child died (agy crash, its own timeout, an OOM kill) but the
    // conversation is on disk. Rebuild it against the same conversation and
    // say so: a silent replacement is the #1268 incident.
    log(`rebuilding agy child for thread ${session.threadId}`);
    startChild({
      session,
      model: session.spawnConfig.model,
      reasoningLevel: session.spawnConfig.reasoningLevel,
      conversationId: session.providerThreadId,
      envVars: session.spawnConfig.envVars,
    });
    notify(BRIDGE_NOTIFICATION_METHODS.sessionReplaced, {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      reason: "the agy process was gone and has been restarted",
      contextLost: false,
    });
  }
  const child = session.child;
  if (child === null || session.providerThreadId === null) {
    session.pending.push(turn);
    return;
  }
  const wasIdle = session.turns.length === 0;
  session.turns.push(turn);
  if (wasIdle) {
    emitTurnStarted(session, turn);
  }
  child.stdin.write(
    agyUserMessageLine(
      session.writeGuardrail
        ? `${WRITE_GUARDRAIL}\n\n${turn.prompt}`
        : turn.prompt,
    ),
  );
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
    const child = spawn(resolveAgyCommand(process.env), ["models"], {
      env: withoutBridgeRuntimeEnv(process.env),
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
      writeGuardrail: false,
    };
    sessions.set(data.threadId, session);
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
      writeGuardrail: false,
    };
    sessions.set(data.threadId, session);
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
    // agy's stream-json has no way to inject into a running turn: each line
    // is a turn and the next one is read only after the current one settles.
    // The typed refusal is honest, and the runtime turns the steer into a
    // fresh turn — which agy will run next, in order.
    respondError(
      id,
      BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
      `agy cannot steer a running turn (expected ${parsed.data.expectedTurnId})`,
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
        emit(session, {
          type: "turn/completed",
          ...base(session),
          status: "interrupted",
          scope: { kind: "turn", turnId: turn.turnId },
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
    log(
      `bridge started for plugin ${context.pluginId}; agy=${resolveAgyCommand(
        process.env,
      )} HOME=${process.env.HOME ?? "<unset>"} PATH=${process.env.PATH ?? "<unset>"}`,
    );
  },
  onClose: shutdown,
  onSigterm: shutdown,
  onSigint: shutdown,
});
