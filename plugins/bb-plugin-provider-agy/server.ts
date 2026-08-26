/**
 * The `agy` provider declaration — metadata only. The implementation is the
 * bridge in src/provider-bridge.ts, shipped in this plugin's `bb.host`
 * artifact; a declaration without one is refused, because the picker entry
 * would exist and no turn on it could run.
 *
 * Every fact here is a pre-session one the picker and the routes need before
 * a bridge exists. Session behaviour (session restore, fork, where approval
 * is enforced) is reported by the bridge at `initialize`, where it cannot
 * drift from what the code does.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.providers.register({
    id: "agy",
    displayName: "Antigravity (agy)",
    // A plugin-relative .svg path, which bb serves to clients as
    // `/api/v1/system/providers/agy/logo`. A named host glyph ("Zap") carries
    // no bytes, so it produces no logoUrl at all and the picker falls back to
    // a letter tile — which is exactly what it was doing. app.tsx registers
    // the same mark inline for the theme-aware path.
    icon: "./icons/agy.svg",
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsWorkflows: false,
      // agy's stream-json has no approval back channel, so the only mode the
      // bridge can honestly run is the unrestricted one.
      permissionModes: ["full"],
      // agy's own ladder; the model list encodes the effort in the model id.
      reasoningLevels: ["low", "medium", "high"],
    },
    composerActions: [],
  });
}
