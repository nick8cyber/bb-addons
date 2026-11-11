/**
 * Runner for the `bb` CLI: `bb tasks dispatch`, `bb thread update`,
 * `bb thread options`, `bb tasks preset`, `bb tasks comment`. The binary is
 * `BB_CLI` when set, else `bb` on PATH (spec §4).
 *
 * The interface is a seam for tests — the plugin never shells out directly
 * elsewhere, so tests inject a fake runner.
 */
import { execFile } from "node:child_process";
import { OrchestratorError } from "./errors.js";

export interface BbCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * The process was killed by the timeout. Dispatch treats this differently
   * from an explicit CLI failure: the thread may already exist (§4 step 3).
   */
  timedOut?: boolean;
}

export interface BbCli {
  run(args: string[], opts?: { timeoutMs?: number }): Promise<BbCliResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export function createBbCli(bin: string = process.env.BB_CLI ?? "bb"): BbCli {
  return {
    run: (args, opts) =>
      new Promise<BbCliResult>((resolve) => {
        execFile(
          bin,
          args,
          {
            timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
          },
          (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
              resolve({
                exitCode: 127,
                stdout: "",
                stderr: `bb CLI not found: ${bin}`,
              });
              return;
            }
            const timedOut = Boolean(error?.killed);
            resolve({
              exitCode:
                typeof error?.code === "number" ? error.code : error ? 1 : 0,
              stdout: String(stdout),
              stderr: timedOut
                ? `timed out after ${opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms\n${String(stderr)}`
                : String(stderr),
              ...(timedOut ? { timedOut } : {}),
            });
          },
        );
      }),
  };
}

const label = (args: readonly string[]) => `bb ${args.join(" ")}`;

/** Run a CLI command whose failure is an error; returns stdout/stderr. */
export async function runChecked(
  cli: BbCli,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<BbCliResult> {
  const res = await cli.run(args, opts);
  if (res.exitCode !== 0) {
    throw new OrchestratorError(
      "bb-cli-failed",
      `${label(args)} failed (exit ${res.exitCode}): ${
        res.stderr.trim() || res.stdout.trim() || "no output"
      }`,
    );
  }
  return res;
}

/** Run a `--json` CLI command and parse stdout. */
export async function runJson<T>(
  cli: BbCli,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<T> {
  const res = await runChecked(cli, args, opts);
  const text = res.stdout.trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OrchestratorError(
      "bb-cli-output",
      `${label(args)} did not return JSON: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * §2.3: preset name/id → `modelId` from `bb tasks preset list --json` —
 * the model-matching source for a one-off preset's quota groups. An
 * unreadable list degrades to an empty map (name-only matching).
 */
export async function presetModelMap(
  cli: BbCli,
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  try {
    const res = await runJson<{
      presets?: { id?: string; name?: string; modelId?: string | null }[];
    }>(cli, ["tasks", "preset", "list", "--json"], { timeoutMs: 15_000 });
    for (const p of res.presets ?? []) {
      for (const key of [p.name, p.id]) {
        if (typeof key === "string") map.set(key, p.modelId ?? null);
      }
    }
  } catch {
    // degrade: no model data → name-only quota matching
  }
  return map;
}
