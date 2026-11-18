import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveServerScript() {
  if (process.env.WEB_GEMINI_USE_BUNDLED === "1" || process.env.ARGON_USE_BUNDLED === "1") {
    return path.join(__dirname, "acp-server.mjs");
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
  return path.join(__dirname, "acp-server.mjs");
}

export default function plugin(bb) {
  const scriptPath = resolveServerScript();

  // Primary provider registration
  bb.providers.register({
    id: "acp-web-gemini",
    displayName: "Gemini (Web)",
    badgeLabel: "Gemini",
    byok: false,
    capabilities: {
      supportsCancel: true,
      supportsStreaming: true,
      reasoningLevels: ["low", "medium", "high"],
      permissionModes: ["full"],
      defaultPermissionMode: "full",
    },
    experimental_bridgeOptions: {
      acpDialect: "generic",
      acpLaunchSpec: {
        displayName: "Gemini (Web)",
        command: process.execPath,
        args: [scriptPath],
        env: {},
        permissionCli: {
          full: [],
        },
      },
    },
  });

  // Backward compatibility: register legacy acp-argon provider alias
  bb.providers.register({
    id: "acp-argon",
    displayName: "Gemini (Argon)",
    badgeLabel: "Argon",
    byok: false,
    capabilities: {
      supportsCancel: true,
      supportsStreaming: true,
      reasoningLevels: ["low", "medium", "high"],
      permissionModes: ["full"],
      defaultPermissionMode: "full",
    },
    experimental_bridgeOptions: {
      acpDialect: "generic",
      acpLaunchSpec: {
        displayName: "Gemini (Argon)",
        command: process.execPath,
        args: [scriptPath],
        env: {},
        permissionCli: {
          full: [],
        },
      },
    },
  });
}
