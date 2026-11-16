import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClaudeKeyHandlers,
  readClaudeKeyState,
  type ClaudeKeyDeps,
} from "./claude-key";

let dir: string;
let settingsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-key-test-"));
  settingsPath = join(dir, "settings.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(run: ClaudeKeyDeps["run"]): ClaudeKeyDeps {
  return { settingsPath, switchScript: "/nonexistent/claude-key", run };
}

describe("readClaudeKeyState", () => {
  it("reports enabled when apiKeyHelper key is present", async () => {
    await writeFile(settingsPath, JSON.stringify({ apiKeyHelper: "/path/to/helper.sh", theme: "dark" }));
    expect(await readClaudeKeyState(settingsPath)).toEqual({ enabled: true, settingsReadable: true });
  });

  it("reports disabled when apiKeyHelper is absent", async () => {
    await writeFile(settingsPath, JSON.stringify({ theme: "dark", hooks: {} }));
    expect(await readClaudeKeyState(settingsPath)).toEqual({ enabled: false, settingsReadable: true });
  });

  it("reports enabled even when apiKeyHelper is null", async () => {
    await writeFile(settingsPath, JSON.stringify({ apiKeyHelper: null }));
    expect(await readClaudeKeyState(settingsPath)).toEqual({ enabled: true, settingsReadable: true });
  });

  it("reports unreadable when file is missing", async () => {
    expect(await readClaudeKeyState(settingsPath)).toEqual({ enabled: false, settingsReadable: false });
  });

  it("reports unreadable on invalid JSON", async () => {
    await writeFile(settingsPath, "{ not json");
    expect(await readClaudeKeyState(settingsPath)).toEqual({ enabled: false, settingsReadable: false });
  });
});

describe("claudeKey.set", () => {
  it("runs the switch script when desired state differs", async () => {
    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }));
    const run = vi.fn(async (_script: string, args: string[]) => {
      await writeFile(settingsPath, JSON.stringify({ apiKeyHelper: "/h", theme: "dark" }));
      expect(args).toEqual(["on"]);
    });
    const h = createClaudeKeyHandlers(deps(run));
    expect(await h.set({ enabled: true })).toEqual({ enabled: true, settingsReadable: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not run the script when already in desired state", async () => {
    await writeFile(settingsPath, JSON.stringify({ apiKeyHelper: "/h" }));
    const run = vi.fn(async () => {});
    const h = createClaudeKeyHandlers(deps(run));
    expect(await h.set({ enabled: true })).toEqual({ enabled: true, settingsReadable: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("serializes concurrent sets and runs the script once", async () => {
    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }));
    const run = vi.fn(async (_s: string, args: string[]) => {
      await new Promise((r) => setTimeout(r, 20));
      const current = JSON.parse(await readFile(settingsPath, "utf8"));
      if (args[0] === "on") current.apiKeyHelper = "/h"; else delete current.apiKeyHelper;
      await writeFile(settingsPath, JSON.stringify(current));
    });
    const h = createClaudeKeyHandlers(deps(run));
    const [a, b] = await Promise.all([h.set({ enabled: true }), h.set({ enabled: true })]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(a.enabled).toBe(true);
    expect(b.enabled).toBe(true);
  });

  it("surfaces a sanitized error when the script fails and keeps real state", async () => {
    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }));
    const run = vi.fn(async () => {
      throw new Error("exit 1: sk-ant-secret leaked in stderr");
    });
    const h = createClaudeKeyHandlers(deps(run));
    await expect(h.set({ enabled: true })).rejects.toThrowError(/^claude-key switch failed$/);
    expect(await h.status()).toEqual({ enabled: false, settingsReadable: true });
  });

  it("does not leak process output or helper paths in thrown errors", async () => {
    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }));
    const run = vi.fn(async () => {
      const err = new Error("Command failed: /x/claude-key on\nsk-ant-api03-leak") as Error & { stderr?: string };
      err.stderr = "sk-ant-api03-leak";
      throw err;
    });
    const h = createClaudeKeyHandlers(deps(run));
    const err = await h.set({ enabled: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(JSON.stringify(err)).not.toContain("sk-ant");
    expect((err as { stderr?: string }).stderr).toBeUndefined();
  });
});
