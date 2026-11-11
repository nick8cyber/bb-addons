/**
 * Generic process runner for the release pipeline: `git`, `gh`,
 * `gitleaks` and `sh -c` check commands in the task's worktree. Same seam
 * idea as `bb-cli.ts` — the plugin never shells out directly elsewhere,
 * so tests inject a fake runner (or point a real one at a temp repo).
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { BbCliResult } from "./bb-cli.js";

export interface CmdRunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Extra environment (merged over `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Fed to the child's stdin (closed afterwards). */
  stdin?: string;
}

export interface CmdRunner {
  run(
    file: string,
    args: string[],
    opts?: CmdRunOptions,
  ): Promise<BbCliResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * `process.env` minus every `GIT_*` variable. A stray inherited
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR`/
 * `GIT_NAMESPACE`/`GIT_OBJECT_DIRECTORY` (a hook exporting them, a
 * script run under `git -c`, a `git rebase` exec) retargets every
 * `git -C <copy>` probe at the wrong repository — status, reflog and
 * mergedness checks would pass against foreign state and a copy with
 * unpublished work could be dropped (PLUG-204). Inheritance-only:
 * an explicit `opts.env` (the rescue snapshot's temporary
 * `GIT_INDEX_FILE`) is merged afterwards and still wins.
 */
const envWithoutGit = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("GIT_")) delete env[k];
  }
  return env;
};

export function createCmd(): CmdRunner {
  return {
    run: (file, args, opts) =>
      new Promise<BbCliResult>((resolve) => {
        const child = execFile(
          file,
          // §17.4 (мелко 11): every `git` call gets neutral path
          // rendering — a user's `core.quotePath`/`diff.mnemonicPrefix`
          // config must not mangle paths the plugin parses (`ls-files`,
          // `status`, `worktree list`, merge-tree conflicts).
          basename(file) === "git"
            ? [
                "-c",
                "core.quotePath=false",
                "-c",
                "diff.mnemonicPrefix=false",
                ...args,
              ]
            : args,
          {
            cwd: opts?.cwd,
            env:
              basename(file) === "git"
                ? { ...envWithoutGit(), ...opts?.env }
                : opts?.env
                  ? { ...process.env, ...opts.env }
                  : undefined,
            timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
          },
          (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
              resolve({
                exitCode: 127,
                stdout: "",
                stderr: `command not found: ${file}`,
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
        if (opts?.stdin === undefined) {
          child.stdin?.end();
        } else {
          // a dead child may close the pipe early — not a run error
          child.stdin?.on("error", () => {});
          child.stdin?.end(opts.stdin);
        }
      }),
  };
}
