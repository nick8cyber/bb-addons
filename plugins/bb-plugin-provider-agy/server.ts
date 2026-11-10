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
      // agy executes a standalone "/compact" user turn in stream-json as its
      // own compaction: the model summarizes the conversation and the stored
      // context shrinks — verified live against agy 1.2.8, where the turn
      // after "/compact" cost a 4k input slice against ~62k before it. The
      // bridge forwards turn prompts verbatim, so bb's built-in compact
      // command lands on agy as-is.
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      // The ACP transport speaks session/set_mode and
      // --dangerously-skip-permissions, so the whole ladder is honest now.
      permissionModes: [
        "full",
        "default",
        "accept-edits",
        "plan",
      ] as ("full" | "default" | "accept-edits" | "plan")[] as never,
      // agy's own ladder; the model list encodes the effort in the model id.
      reasoningLevels: ["low", "medium", "high"],
    },
    // What bb says when a host has no working agy. The CLI has no `login`
    // subcommand: running `agy` once is the sign-in, because that is what
    // opens the browser flow (over SSH it prints a URL and takes a pasted
    // code instead). Both hints name the machine on purpose — the credential
    // lives on the host that runs the turn, not in bb.
    strings: {
      signInHint:
        "Run `agy` once on the machine to sign in with a Google account that has Antigravity access.",
      expiredHint:
        "agy's sign-in is no longer valid. Run `agy` on the machine to sign in again.",
      installUrl: "https://antigravity.google/docs/cli/getting-started",
    },
    composerActions: [],
    // The daemon hands this to the ACP wrapper on every thread-bound
    // request; the wrapper rewrites acpLaunchSpec per session (account
    // pool, shim, proxies) before delegating to the generic bridge.
    experimental_bridgeOptions: {
      acpLaunchSpec: {
        displayName: "Antigravity (agy)",
        command: "agy",
        args: ["acp"],
        env: {},
      },
      acpDialect: "generic",
    },
  });
}
