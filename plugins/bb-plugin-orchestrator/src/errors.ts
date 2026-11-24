/**
 * Structured plugin error: a stable `code` for agents and scripts, a
 * human-readable `message`, and an optional `hint` pointing at the fix.
 * There is no PluginCliError in the SDK, so the CLI layer formats these
 * itself (spec §6).
 */
export class OrchestratorError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    hint?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export interface ErrorBody {
  code: string;
  message: string;
  hint?: string;
  /** Structured caller context (e.g. the threadId/envId of a failed
   * coordinator worktree create) — rides into the `--json` error body. */
  details?: Record<string, unknown>;
}

export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof OrchestratorError) {
    const body: ErrorBody = { code: error.code, message: error.message };
    if (error.hint) body.hint = error.hint;
    if (error.details) body.details = error.details;
    return body;
  }
  return {
    code: "internal-error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** The §6 error payload for `--json` output and agent tools. */
export function errorJson(error: unknown): { ok: false; error: ErrorBody } {
  return { ok: false, error: toErrorBody(error) };
}
