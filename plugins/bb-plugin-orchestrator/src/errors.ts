/**
 * Structured plugin error: a stable `code` for agents and scripts, a
 * human-readable `message`, and an optional `hint` pointing at the fix.
 * There is no PluginCliError in the SDK, so the CLI layer formats these
 * itself (spec §6).
 */
export class OrchestratorError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
    this.hint = hint;
  }
}

export interface ErrorBody {
  code: string;
  message: string;
  hint?: string;
}

export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof OrchestratorError) {
    const body: ErrorBody = { code: error.code, message: error.message };
    if (error.hint) body.hint = error.hint;
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
