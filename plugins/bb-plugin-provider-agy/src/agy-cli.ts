/**
 * Everything that knows the `agy` command line and its NDJSON dialect.
 *
 * The dialect was confirmed against agy 1.1.19 by driving the binary
 * directly (see README):
 *
 *   OUT  {"event":"init","conversation_id":"…","init":{model,cwd,tools,permission_mode}}
 *   OUT  {"event":"step_update","step_update":{conversation_id,step_index,state,
 *          step_type,text_delta?,usage?,duration_seconds?}}
 *   OUT  {"event":"result","result":{conversation_id,status,response,num_turns,
 *          usage,duration_seconds,error?}}
 *   IN   {"event":"user","message":{"role":"user","content":"…"}}
 *
 * The discriminator is `event` in BOTH directions — this is agy's own
 * dialect, not the Claude Code SDK shape it superficially resembles. `state`
 * is `ACTIVE` while a step streams and `DONE` when it settles; `text_delta`
 * is incremental (append, never a cumulative snapshot). `result.usage` is
 * cumulative for the whole conversation, while a step's `usage` is that
 * turn's.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Reasoning levels bb may send, folded onto agy's three efforts. */
export function agyEffort(reasoningLevel: string | undefined): string | null {
  switch (reasoningLevel) {
    case "none":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "ultra":
    case "ultracode":
    case "max":
      return "high";
    default:
      return null;
  }
}

/**
 * Where the agy binary lives. `AGY_PATH` wins (a host can pin a build), then
 * the installer's own location, then PATH. Returning a bare "agy" as the last
 * resort keeps the failure legible: the spawn error names the command.
 */
export function resolveAgyCommand(env: NodeJS.ProcessEnv): string {
  const pinned = env.AGY_PATH;
  if (pinned !== undefined && pinned.length > 0 && isExecutable(pinned)) {
    return pinned;
  }
  const home = env.HOME;
  if (home !== undefined && home.length > 0) {
    const installed = join(home, ".local", "bin", "agy");
    if (isExecutable(installed)) {
      return installed;
    }
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = join(dir, "agy");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return "agy";
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface AgySpawnArgsInput {
  model: string | undefined;
  reasoningLevel: string | undefined;
  /** Resume an existing agy conversation instead of starting a new one. */
  conversationId: string | undefined;
  /**
   * Absolute directories agy may edit. The thread's cwd belongs here: agy
   * does NOT infer its workspace from the process cwd (see agySpawnArgs).
   */
  addDirs?: readonly string[] | undefined;
}

/**
 * The session argv.
 *
 * `--print` REQUIRES a value: `agy --print --output-format stream-json` eats
 * the next flag as the prompt. `--print=` (explicitly empty) plus
 * `--input-format stream-json` is what opens a session that waits for NDJSON
 * lines on stdin and runs one turn per line.
 *
 * Phase one is `--dangerously-skip-permissions`: agy's stream-json has no
 * back channel for tool approvals (no control_request/control_response in the
 * binary), so the only honest permission mode this bridge can offer is
 * "full".
 *
 * `--add-dir` is what makes the thread's directory writable, and it is NOT
 * optional. agy takes its workspace from the flag, never from the process
 * cwd: spawned in a directory it was not given, it still answers and still
 * writes files, but into
 * `~/.gemini/antigravity-cli/{scratch,brain}/…` instead of the project — and
 * a write_to_file aimed at a real path fails the turn with
 * `<path> is not a valid artifact path; artifacts must be in
 * ~/.gemini/antigravity-cli/brain/<conversation>/`. Confirmed against agy
 * 1.1.19: the same prompt writes to `~/.gemini/…/scratch/hello/hello.txt`
 * without the flag and to the cwd with it.
 */
export function agySpawnArgs(input: AgySpawnArgsInput): string[] {
  const args = [
    "--print=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    // A session lives as long as the thread does; the 5m default would kill
    // it while the user is reading.
    "--print-timeout",
    "24h",
  ];
  if (input.model !== undefined && input.model.length > 0) {
    args.push("--model", input.model);
  }
  // agy's model ids already carry the effort ("gemini-3.7-flash-high"), and
  // passing both is a hard error: `invalid model selection (--model … --effort
  // …)`, exit 1 before any output. So `--effort` is only for a session that
  // named no model at all.
  const effort = agyEffort(input.reasoningLevel);
  if (effort !== null && !modelCarriesEffort(input.model)) {
    args.push("--effort", effort);
  }
  if (input.conversationId !== undefined && input.conversationId.length > 0) {
    args.push("--conversation", input.conversationId);
  }
  for (const dir of dedupe(input.addDirs)) {
    args.push("--add-dir", dir);
  }
  return args;
}

/** Non-empty directories, each named once, in the order given. */
function dedupe(dirs: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs ?? []) {
    if (dir.length === 0 || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

/** True when the model id already names an effort, making `--effort` illegal. */
export function modelCarriesEffort(model: string | undefined): boolean {
  if (model === undefined) {
    return false;
  }
  return /-(?:low|medium|high)$/u.test(model);
}

/** One NDJSON line agy sends us, narrowed just enough to act on. */
export type AgyEvent =
  | { event: "init"; conversationId: string | null; model: string | null }
  | {
      event: "step_update";
      conversationId: string | null;
      stepIndex: number | null;
      stepType: string | null;
      state: string | null;
      textDelta: string | null;
      usage: AgyUsage | null;
      /** `tool_info.name` on a `tool` step. */
      toolName: string | null;
      /** `tool_info.error.message` on a `tool` step that failed. */
      toolError: string | null;
    }
  | {
      event: "result";
      conversationId: string | null;
      status: string | null;
      response: string | null;
      error: string | null;
      usage: AgyUsage | null;
    }
  | { event: "unknown"; payload: unknown };

export interface AgyUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usage(value: unknown): AgyUsage | null {
  const bag = record(value);
  if (bag === null) {
    return null;
  }
  return {
    inputTokens: num(bag.input_tokens),
    outputTokens: num(bag.output_tokens),
    thinkingTokens: num(bag.thinking_tokens),
    cacheReadTokens: num(bag.cache_read_tokens),
    totalTokens: num(bag.total_tokens),
  };
}

/**
 * Lenient at the edge: an unparseable or unrecognized line becomes
 * `unknown` and travels as a droppable `provider/raw` diagnostic rather than
 * poisoning the stream.
 */
export function parseAgyLine(line: string): AgyEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { event: "unknown", payload: line };
  }
  const message = record(parsed);
  if (message === null) {
    return { event: "unknown", payload: parsed };
  }
  const kind = str(message.event);
  if (kind === "init") {
    const init = record(message.init) ?? {};
    return {
      event: "init",
      conversationId: str(message.conversation_id) ?? str(init.conversation_id),
      model: str(init.model),
    };
  }
  if (kind === "step_update") {
    const step = record(message.step_update);
    if (step === null) {
      return { event: "unknown", payload: parsed };
    }
    const toolInfo = record(step.tool_info) ?? {};
    const toolError = record(toolInfo.error) ?? {};
    return {
      event: "step_update",
      conversationId: str(step.conversation_id),
      stepIndex:
        typeof step.step_index === "number" ? step.step_index : null,
      stepType: str(step.step_type),
      state: str(step.state),
      textDelta: typeof step.text_delta === "string" ? step.text_delta : null,
      usage: usage(step.usage),
      toolName: str(step.tool_name) ?? str(toolInfo.name),
      toolError: str(toolError.message),
    };
  }
  if (kind === "result") {
    const result = record(message.result);
    if (result === null) {
      return { event: "unknown", payload: parsed };
    }
    return {
      event: "result",
      conversationId: str(result.conversation_id),
      status: str(result.status),
      response: typeof result.response === "string" ? result.response : null,
      error: str(result.error),
      usage: usage(result.usage),
    };
  }
  return { event: "unknown", payload: parsed };
}

/** The one input line shape agy accepts (see the module comment). */
export function agyUserMessageLine(text: string): string {
  return `${JSON.stringify({
    event: "user",
    message: { role: "user", content: text },
  })}\n`;
}

/**
 * Step types that are bookkeeping, not content. Everything else that is not
 * `agent_response` is reported as an unknown-coverage diagnostic, so a new
 * agy step type shows up in debug UI instead of vanishing.
 */
export const AGY_NOISE_STEP_TYPES = new Set(["user_input", "checkpoint"]);

/** `agy models` prints "id<TAB>Display Name" lines after a status line. */
export function parseAgyModelsOutput(
  stdout: string,
): { id: string; displayName: string }[] {
  const models: { id: string; displayName: string }[] = [];
  for (const raw of stdout.split("\n")) {
    const tab = raw.indexOf("\t");
    if (tab <= 0) {
      continue;
    }
    const id = raw.slice(0, tab).trim();
    const displayName = raw.slice(tab + 1).trim();
    if (id.length === 0 || displayName.length === 0 || id.includes(" ")) {
      continue;
    }
    models.push({ id, displayName });
  }
  return models;
}
