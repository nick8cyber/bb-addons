import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const DEFAULT_SETTINGS_PATH = "/home/ubuntu/.claude/settings.json";
const DEFAULT_SWITCH_SCRIPT = "/home/ubuntu/.local/bin/claude-key";
const SWITCH_TIMEOUT_MS = 10_000;

const statusOutputSchema = z.object({
  enabled: z.boolean(),
  settingsReadable: z.boolean(),
});

export const claudeKeyContract = defineRpcContract({
  "claudeKey.status": {
    experimental_description:
      "Read whether Claude Code is switched to the Anthropic Console API key: true when apiKeyHelper is present in ~/.claude/settings.json. The file is the source of truth; the helper value is never returned.",
    input: z.object({}).strict(),
    output: statusOutputSchema,
  },
  "claudeKey.set": {
    experimental_description:
      "Switch Claude Code between subscription OAuth and the Console API key by running ~/.local/bin/claude-key on|off. Returns the state re-read from settings.json. Errors are sanitized: helper path, key material and process output are never exposed.",
    input: z.object({ enabled: z.boolean() }).strict(),
    output: statusOutputSchema,
  },
});

export interface ClaudeKeyDeps {
  settingsPath: string;
  switchScript: string;
  run: (script: string, args: string[]) => Promise<void>;
}

export interface ClaudeKeyState {
  enabled: boolean;
  settingsReadable: boolean;
}

export const claudeKeyDefaults: ClaudeKeyDeps = {
  settingsPath: DEFAULT_SETTINGS_PATH,
  switchScript: DEFAULT_SWITCH_SCRIPT,
  run: async (script, args) => {
    await promisify(execFile)(script, args, { timeout: SWITCH_TIMEOUT_MS });
  },
};

export async function readClaudeKeyState(settingsPath: string): Promise<ClaudeKeyState> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch {
    return { enabled: false, settingsReadable: false };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const enabled =
      typeof parsed === "object" && parsed !== null && "apiKeyHelper" in parsed;
    return { enabled, settingsReadable: true };
  } catch {
    return { enabled: false, settingsReadable: false };
  }
}

export function createClaudeKeyHandlers(deps: ClaudeKeyDeps = claudeKeyDefaults) {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job);
    queue = next.catch(() => {});
    return next;
  };

  const status = async (): Promise<ClaudeKeyState> =>
    enqueue(() => readClaudeKeyState(deps.settingsPath));

  const set = async ({ enabled }: { enabled: boolean }): Promise<ClaudeKeyState> =>
    enqueue(async () => {
      const current = await readClaudeKeyState(deps.settingsPath);
      if (current.enabled !== enabled) {
        try {
          await deps.run(deps.switchScript, [enabled ? "on" : "off"]);
        } catch {
          throw new Error("claude-key switch failed");
        }
      }
      return readClaudeKeyState(deps.settingsPath);
    });

  return { status, set };
}

export function registerClaudeKey(bb: BbPluginApi, deps: ClaudeKeyDeps = claudeKeyDefaults) {
  const handlers = createClaudeKeyHandlers(deps);
  bb.rpc.register(claudeKeyContract, {
    "claudeKey.status": handlers.status,
    "claudeKey.set": handlers.set,
  });
}
