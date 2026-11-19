import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveServerScript({ requireWriteSupport = false } = {}) {
  const adjacent = path.join(__dirname, "acp-server.mjs");
  const bundled = fs.existsSync(adjacent) ? adjacent : path.resolve(__dirname, "..", "acp-server.mjs");
  if (process.env.WEB_GEMINI_USE_BUNDLED === "1" || process.env.ARGON_USE_BUNDLED === "1") {
    return bundled;
  }
  const candidates = [
    process.env.WEB_GEMINI_DIR || process.env.ARGON_DIR,
    path.join(os.homedir(), ".local/share/web-gemini"),
    path.join(os.homedir(), ".local/share/argon-gemini"),
  ];
  for (const dir of candidates.filter(Boolean)) {
    const script = path.join(dir, "acp-server.mjs");
    if (fs.existsSync(script) && (!requireWriteSupport || fs.existsSync(path.join(dir, "src/worktree-writer.mjs")))) return script;
  }
  return bundled;
}

export default function plugin(bb) {
  const scriptPath = resolveServerScript();
  // Both permissions on a BB thread must share the same journal protocol,
  // including after a restart with a lower launch ceiling.
  const boundScript = resolveServerScript({ requireWriteSupport: true });
  for (const [id, displayName, badgeLabel] of [
    ["acp-web-gemini", "Gemini (Web)", "Gemini"],
    ["acp-argon", "Gemini (Argon)", "Argon"],
  ]) {
    const acpLaunchSpec = {
      displayName,
      command: process.execPath,
      args: [scriptPath],
      env: {},
      permissionCli: {
        insertAfterArgs: 1,
        full: ["--session-access=read-only"],
        workspaceWrite: ["--session-access=write"],
      },
    };
    bb.providers.register({
      id, displayName, badgeLabel, byok: false,
      composerActions: [],
      capabilities: {
        supportsCancel: true,
        supportsStreaming: true,
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        fork: "none",
        reasoningLevels: ["low", "medium", "high"],
        permissionModes: ["full", "accept-edits"],
        defaultPermissionMode: "full",
      },
      experimental_bridgeOptions: { acpDialect: "generic", acpLaunchSpec },
      deriveProviderOptions: ({ threadId }) => threadId ? {
        acpLaunchSpec: { ...acpLaunchSpec, args: [boundScript, "--bb-thread-id=" + threadId] },
      } : {},
    });
  }
}
