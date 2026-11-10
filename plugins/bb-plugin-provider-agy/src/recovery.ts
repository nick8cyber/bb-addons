/**
 * Everything the ACP wrapper carries over from the stream-json bridge
 * verbatim: the error taxonomy (quota vs auth vs billing vs overloaded vs
 * Google's own 5xx), the quota countdown parser, the rotation handoff and
 * compaction-fallback prompt builders, the artifact-write refusal handling,
 * and the cliproxy relay resolution. These functions are transport-agnostic —
 * the stream-json bridge keeps its own copies because it stays a self-
 * contained rollback path behind AGY_TRANSPORT=stream-json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAccountIneligible } from "./accounts.js";

// ---------------------------------------------------------------------------
// Error classification (carried verbatim)
// ---------------------------------------------------------------------------

export function classifyError(
  message: string,
  opts: { toolError?: boolean } = {},
):
  | "rate-limit"
  | "unauthorized"
  | "billing"
  | "overloaded"
  | "internal"
  | undefined {
  const text = message.toLowerCase();
  if (
    /\bquota\b|rate.?limit|resets? in|resource exhausted|\b429\b|try again later/u.test(
      text,
    )
  ) {
    return "rate-limit";
  }
  const billing =
    /upgrade your subscription|increase your limits|billing|payment|credits?/u;
  const overloaded =
    /overloaded|busy|temporar|degenerat|can't satisfy|no capacity/u;
  // Google's own server-side failure, in agy's own framing only ("API error
  // (attempt 1): INTERNAL (code 500): …", also inside its AGY_ERROR JSON):
  // transient, so it must reach bb as `internal` + the HTTP code — what bb's
  // provider-retry needs to re-run the turn by itself. Never for a tool
  // step's error (a command's "504" re-run as a whole turn would repeat the
  // commands), and never when the text also names a cause that must not be
  // retried this way (eligibility, auth, billing) or a faster one
  // (overloaded). Checked before the generic `token` match below, which
  // would otherwise swallow agy's JSON tail.
  if (
    !opts.toolError &&
    serverErrorCode(message) !== null &&
    !isAccountIneligible(message) &&
    !/unauthori|not authorized|invalid token|sign in|logged in|login|\b401\b|\b403\b/u.test(text) &&
    !billing.test(text) &&
    !overloaded.test(text)
  ) {
    return "internal";
  }
  if (
    isAccountIneligible(message) ||
    /unauthori|not authorized|sign in|logged in|login|\b401\b|\b403\b|token/u.test(
      text,
    )
  ) {
    return "unauthorized";
  }
  if (billing.test(text)) {
    return "billing";
  }
  if (overloaded.test(text)) {
    return "overloaded";
  }
  return undefined;
}

/**
 * The 5xx code of a Google server-side failure reported in agy's own
 * "API error (attempt N): … (code 50x)" framing, or null. Bare phrases such
 * as "deadline exceeded" or "gateway timeout" are deliberately not enough:
 * they are just as likely a tool's or a fetched page's own text.
 */
export function serverErrorCode(message: string): number | null {
  const framed = /api error \(attempt \d+\):[^\n]*?\(code (50[0234])\)/iu.exec(message);
  return framed === null ? null : Number(framed[1]);
}

/** The HTTP code bb's native `errorInfo` can hang on a classified message. */
export function httpStatusCodeFor(
  category: ReturnType<typeof classifyError>,
  message = "",
): number | null {
  switch (category) {
    case "internal":
      return serverErrorCode(message) ?? 500;
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

export interface AgyErrorInfo {
  category: NonNullable<ReturnType<typeof classifyError>>;
  providerCode: null;
  httpStatusCode: number | null;
}

/** The native `errorInfo` a provider.error should carry, when it can. */
export function nativeErrorInfo(
  message: string,
  toolError = false,
): AgyErrorInfo | undefined {
  const category = classifyError(message, { toolError });
  if (category === undefined) {
    return undefined;
  }
  return {
    category,
    providerCode: null,
    httpStatusCode: httpStatusCodeFor(category, message),
  };
}

/**
 * agy's quota messages say when the window reopens: "Resets in 1h13m29s.",
 * "Resets in 47m42s.", "Resets in 8m11s.". bb's native rate-limit snapshot
 * takes that as a clock time.
 */
const RESETS_IN = /resets? in (?:(\d+)h)?(?:(\d+)m)?(\d+)s?\b/iu;

export function quotaResetAtMs(message: string): number | null {
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

// ---------------------------------------------------------------------------
// Quota auto-retry budget (envs keep their stream-json meanings)
// ---------------------------------------------------------------------------

/** Land this long after the stated reset, so the reopened window is real. */
export const QUOTA_RETRY_JITTER_MS = 5_000;
/**
 * agy's individual window runs about 50 minutes ("Resets in 49m10s"); a wait
 * past this cap fails the turn the old way instead of holding the thread for
 * a window nobody asked to sit through. `AGY_AUTO_RETRY_MAX_WAIT_MS` overrides.
 */
const DEFAULT_QUOTA_RETRY_MAX_WAIT_MS = 3_300_000;
/** Retries per session (not per turn); `AGY_AUTO_RETRY_MAX` overrides. */
const DEFAULT_QUOTA_RETRY_MAX = 2;

export function quotaRetryMaxAttempts(): number {
  const raw = Number(process.env.AGY_AUTO_RETRY_MAX);
  return Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_QUOTA_RETRY_MAX;
}

export function quotaRetryMaxWaitMs(): number {
  const raw = Number(process.env.AGY_AUTO_RETRY_MAX_WAIT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_QUOTA_RETRY_MAX_WAIT_MS;
}

/**
 * Cooldown booked on the burnt account when a classified rate-limit names
 * no reset countdown: without a "Resets in …" to parse, the window is
 * assumed to be agy's usual ~50-minute individual one, so half of that.
 */
export const DEFAULT_QUOTA_COOLDOWN_MS = 1_800_000;

// ---------------------------------------------------------------------------
// Rotation handoff prompt
// ---------------------------------------------------------------------------

/** Sliding window of streamed assistant text kept for the rotation handoff. */
export const HANDOFF_STREAMED_TEXT_CAP = 4_000;

/** Marker so harnesses (and readers) can tell a handoff prompt apart. */
export const HANDOFF_TAG = "[quota-rotation-handoff]";

/**
 * `git diff HEAD --stat` for the handoff, or null when git cannot say (not
 * a repo, no binary, no commits yet, timeout). HEAD (not bare `diff`) so
 * staged changes are included. Stat names only, never content — and capped.
 */
export function gitDiffStat(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "diff", "HEAD", "--stat"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return out.trim().slice(0, 1500);
  } catch {
    return null;
  }
}

/**
 * Compact handoff for a turn re-run on a fresh account: the old
 * conversation is gone, so the retry carries what the bridge actually
 * knows — the interrupted prompt, the assistant text already streamed this
 * session, and the working-tree stat. Bounded (~8 KB); never the history.
 */
export function buildQuotaHandoffPrompt(args: {
  prompt: string;
  recentAssistantText: string;
  cwd: string;
  queuedFollowers: number;
}): string {
  // A cascaded rotation re-runs a turn whose prompt is already a handoff:
  // strip the previous marker prefix so tags never nest.
  let goalSource = args.prompt;
  while (goalSource.startsWith(HANDOFF_TAG)) {
    goalSource = goalSource.slice(HANDOFF_TAG.length).trimStart();
  }
  const goal = goalSource.slice(0, 2000);
  const streamed =
    args.recentAssistantText.length > 0
      ? args.recentAssistantText.slice(-HANDOFF_STREAMED_TEXT_CAP)
      : "(nothing streamed yet)";
  const stat = gitDiffStat(args.cwd);
  const tree =
    stat === null
      ? "(git unavailable or not a repo)"
      : stat.length === 0
        ? "(clean)"
        : stat;
  const followers =
    args.queuedFollowers > 0
      ? ` ${args.queuedFollowers} more queued turn(s) will follow with their original prompts.`
      : "";
  return (
    `${HANDOFF_TAG} your previous conversation is gone — quota rotation ` +
    `moved this thread to a different account with NO history. ` +
    `Do not ask for confirmation; continue the work below.\n` +
    `GOAL (the interrupted turn's original prompt):\n${goal}\n` +
    `WHAT WAS ALREADY DONE (partial assistant output streamed before the quota hit):\n${streamed}\n` +
    `WORKING-TREE STATE (git diff --stat in ${args.cwd}):\n${tree}\n` +
    `NEXT STEP: continue from the state above without redoing completed work.${followers}`
  );
}

// ---------------------------------------------------------------------------
// Compaction fallback prompts (ADR-0003, carried verbatim)
// ---------------------------------------------------------------------------

export const COMPACT_FALLBACK_TAG = "[compaction-fallback]";
export const COMPACT_HANDOFF_TAG = "[compaction-handoff]";
export const COMPACT_SUMMARY_CAP = 20_000;
export const COMPACT_SEED_MAX_ATTEMPTS = 2;

export function compactFallbackEnabled(): boolean {
  return process.env.AGY_COMPACT_FALLBACK !== "0";
}

export function compactSummaryPrompt(): string {
  return (
    `${COMPACT_FALLBACK_TAG} Compacting this conversation failed, ` +
    `so it will be continued in a NEW conversation that starts from your summary ` +
    `alone. Write that summary now as your reply — do not call tools and do not ` +
    `change files. Use the language of this conversation. Cover: the overall goal ` +
    `and the standing instructions you follow (and which files hold them); what is ` +
    `done, with exact file paths, branches, commits, PR/issue numbers and commands ` +
    `that matter; decisions and constraints; what is in progress and the exact next ` +
    `steps; anything you must not forget. Be complete but concise (at most about ` +
    `1500 words).`
  );
}

/**
 * How the agent on the fresh conversation can read the old one back: bb
 * passes BB_THREAD_ID / BB_CLI to agy, and this bb thread's own history (user
 * messages and the agent's replies, newest first) is one command away.
 */
export function threadHistoryHint(threadId: string): string {
  // Bounded on purpose: `--all` on a long thread is megabytes, which would
  // refill the fresh conversation with exactly what compaction removed.
  return (
    `\`timeout 60 bb thread messages ${threadId} --limit 30\` ` +
    `(newest first; at most \`--limit 100\`; one message with its tool details: ` +
    `\`--message <seq> --format verbose\`; never \`--all\`; if \`bb\` is not on ` +
    `PATH use "$BB_CLI")`
  );
}

export function compactSeedPrompt(summary: string, threadId: string): string {
  return (
    `${COMPACT_HANDOFF_TAG} This is a fresh conversation: the previous one could ` +
    `not be compacted, so the bridge replaced it. Below is your own summary of ` +
    `everything so far — treat it as your memory and continue from it. Do not ` +
    `call tools in this turn: reply only with "OK". Later, before acting, re-read ` +
    `the instruction files it names; if you then need a detail the summary leaves ` +
    `out, look it up in this thread's history — ${threadHistoryHint(threadId)} — as ` +
    `reference only, never as a list of things to redo.\n\n` +
    `${summary.slice(0, COMPACT_SUMMARY_CAP)}`
  );
}

/** Variant A: no summary from the agent, so the bridge writes the memo. */
export function compactMemoPrompt(args: {
  recentAssistantText: string;
  cwd: string;
  threadId: string;
}): string {
  const streamed =
    args.recentAssistantText.length > 0
      ? args.recentAssistantText.slice(-HANDOFF_STREAMED_TEXT_CAP)
      : "(nothing streamed)";
  const stat = gitDiffStat(args.cwd);
  const tree =
    stat === null
      ? "(git unavailable or not a repo)"
      : stat.length === 0
        ? "(clean)"
        : stat;
  return (
    `${COMPACT_HANDOFF_TAG} This is a fresh conversation: the previous one could ` +
    `not be compacted and the agent could not summarize it either, so the bridge ` +
    `replaced it with NO history. Restore your context NOW, in this turn, before ` +
    `anything else: read this thread's history — ${threadHistoryHint(args.threadId)} — ` +
    `until you know the goal, your standing instructions, what is done and what is ` +
    `next; then re-read the instruction and briefing files it names. This turn is ` +
    `READ-ONLY: only \`bb thread messages\` and reading files — no git, ssh, ` +
    `deploys or other network actions, no file changes, no messages to other ` +
    `threads. The history is reference, not a to-do list: carry out nothing from ` +
    `it until the user's next message. Then reply with one short line: what you ` +
    `are working on and the next step.\n` +
    `LAST ASSISTANT OUTPUT (before the replacement):\n${streamed}\n` +
    `WORKING-TREE STATE (git diff --stat in ${args.cwd}):\n${tree}`
  );
}

// ---------------------------------------------------------------------------
// Artifact-write refusal (ArtifactMetadata bug, carried verbatim)
// ---------------------------------------------------------------------------

export const ARTIFACT_PATH_REFUSAL = /is not a valid artifact path/u;

/**
 * Re-drives per turn. One, not more: the re-drive exists to make the model
 * LOOK at the file, and measured against agy 1.1.19 the refusal comes back on
 * the re-drive too (the rejected call is replayed while permissions are
 * declared) even when the model answers correctly. A second re-drive buys
 * another refusal and another slice of the quota.
 */
export const MAX_ARTIFACT_RETRIES = 1;

export function writeRetryNudge(path: string | null): string {
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
export function artifactRefusalPath(message: string | null): string | null {
  const match = /(\S+) is not a valid artifact path/u.exec(message ?? "");
  return match?.[1] ?? null;
}

/** Session instructions get this so the model never emits ArtifactMetadata. */
export const WRITE_GUARDRAIL =
  "[workspace rule] When you write files with write_to_file, never include " +
  "ArtifactMetadata: this session is editing a real workspace, and that field " +
  "makes agy reject the call as an artifact write.";

export function isArtifactPathRefusal(message: string | null): boolean {
  return message !== null && ARTIFACT_PATH_REFUSAL.test(message);
}

// ---------------------------------------------------------------------------
// Cliproxy relay mode (carried verbatim; HOME → --gemini-dir under ACP)
// ---------------------------------------------------------------------------

export interface CliproxyRelay {
  baseUrl: string;
  apiKey: string;
  home: string;
}

function firstListedApiKey(yaml: string): string | null {
  const m = /^api-keys?:\s*\n\s*-\s+(\S+)/m.exec(yaml);
  return m === null ? null : m[1].replace(/^["']|["']$/gu, "");
}

export function resolveCliproxyRelay(dataDir: string): CliproxyRelay | null {
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
  // agy reads its provider switch from the home-scoped settings file; the
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

/** Overlay keys a session's envVars passthrough may not override. */
export const PROTECTED_CHILD_ENV = new Set([
  "HOME",
  "GEMINI_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
]);

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * `result.usage` of an ACP `session/prompt` response (agy 1.5.3). Unlike the
 * stream-json dialect these are camelCase and per-turn.
 */
export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface TokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export const ZERO_USAGE: TokenBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

export function acpUsageToBreakdown(usage: AcpUsage): TokenBreakdown {
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: 0,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.thoughtTokens,
  };
}

/**
 * Context-window size by model family, in tokens. agy never reports the
 * window itself, so every size here is an estimate — enough for the thread's
 * usage meter, never a billing claim. Unknown families stay null rather than
 * invented: the meter then shows usage without a denominator.
 */
export function contextWindowSize(model: string | undefined): number | null {
  if (model === undefined) {
    return null;
  }
  if (/gemini/i.test(model)) {
    return 1_000_000;
  }
  return null;
}
