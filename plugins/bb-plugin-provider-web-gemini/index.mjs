import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveServerScript() {
  const adjacent = path.join(__dirname, "acp-server.mjs");
  const bundled = fs.existsSync(adjacent) ? adjacent : path.resolve(__dirname, "..", "acp-server.mjs");
  if (process.env.WEB_GEMINI_USE_BUNDLED === "1" || process.env.ARGON_USE_BUNDLED === "1") {
    return bundled;
  }
  const customDir = process.env.WEB_GEMINI_DIR || process.env.ARGON_DIR;
  if (customDir) {
    const custom = path.join(customDir, "acp-server.mjs");
    if (fs.existsSync(custom)) return custom;
  }
  const external = path.join(os.homedir(), ".local/share/web-gemini", "acp-server.mjs");
  if (fs.existsSync(external)) {
    return external;
  }
  const legacyExternal = path.join(os.homedir(), ".local/share/argon-gemini", "acp-server.mjs");
  if (fs.existsSync(legacyExternal)) {
    return legacyExternal;
  }
  return bundled;
}

export default function plugin(bb) {
  const scriptPath = resolveServerScript();
  for (const [id, displayName, badgeLabel] of [
    ["acp-web-gemini", "Gemini (Web)", "Gemini"],
    ["acp-argon", "Gemini (Argon)", "Argon"],
  ]) {
    const acpLaunchSpec = {
      displayName,
      command: process.execPath,
      args: [scriptPath],
      env: {},
      permissionCli: { insertAfterArgs: 1, full: ["--session-access=read-only"] },
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
        permissionModes: ["full"],
        defaultPermissionMode: "full",
      },
      experimental_bridgeOptions: { acpDialect: "generic", acpLaunchSpec },
      deriveProviderOptions: ({ threadId }) => threadId ? {
        acpLaunchSpec: { ...acpLaunchSpec, args: [...acpLaunchSpec.args, "--bb-thread-id=" + threadId] },
      } : {},
    });
  }
}
