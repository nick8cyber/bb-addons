/**
 * Провайдер Devin (SWE-2) для bb — объявление. Исполнение — ACP-мост в host.ts.
 *
 * Чем отличается от custom agent во встроенном provider-acp: мост знает
 * диалект "devin" (src/devin-dialect.js) — субагенты Devin (`run_subagent`)
 * приходят в bb элементами `delegation`, как у Cursor и Claude: видны внутри
 * треда со статусом, отдельных тредов не плодят.
 *
 * id остаётся "acp-devin": на нём существующие треды и пресеты раздачи
 * (swe2-wt, swe2-review). Поэтому из настройки provider-acp customAgents
 * запись "devin" должна быть убрана — два провайдера с одним id bb не примет.
 *
 * Поля повторяют acpProviderDeclaration() встроенного provider-acp (bb 0.48.1).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Devin CLI: ~/.local/bin (официальный установщик, самообновление) или
 * /usr/local/bin (общая копия для второго инстанса без своего установщика).
 * Иначе — "devin" из PATH.
 */
const DEVIN_BIN =
  [join(homedir(), ".local", "bin", "devin"), "/usr/local/bin/devin"].find((p) => existsSync(p)) ?? "devin";

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    subagentsDisabled: {
      type: "boolean",
      label: "Disable provider subagents",
      description:
        "Prevent Devin from starting native subagents (run_subagent, read_subagent) so agents use bb for delegation. Applies by managing subagents_enabled in the Devin user config — the only lever devin acp reads; the prior value is restored when the setting is turned off.",
      default: false,
    },
    memoryEnabled: {
      type: "boolean",
      label: "Devin native memory",
      description:
        "Reserved toggle — this devin acp exposes no local memory lever (Memory Drive/notes are cloud-side, not gated by user config), so the setting only plumbs the decision through for a future lever.",
      default: true,
    },
  });
  bb.providers.register({
    id: "acp-devin",
    displayName: "Devin",
    family: "acp",
    icon: "./icons/devin.svg",
    strings: {
      signInHint: "Run `devin auth login` on the machine to sign in.",
      expiredHint: "Your Devin session expired. Run `devin auth login`, then reload.",
      installUrl: "https://docs.devin.ai/cli",
    },
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    experimental_nativeSkillRoots: {
      user: [".config/devin/skills", ".config/cognition/skills", ".agents/skills"],
      project: [".devin/skills", ".cognition/skills", ".agents/skills"],
    },
    experimental_bridgeOptions: {
      acpDialect: "devin",
      acpLaunchSpec: {
        displayName: "Devin",
        command: DEVIN_BIN,
        args: ["acp", "--model", "swe-2"],
        env: {},
        permissionCli: {
          full: ["--permission-mode", "dangerous"],
          workspaceWrite: ["--permission-mode", "accept-edits"],
          insertAfterArgs: 0,
        },
        nativeSkillRoots: {
          user: [".config/devin/skills", ".config/cognition/skills", ".agents/skills"],
          project: [".devin/skills", ".cognition/skills", ".agents/skills"],
        },
      },
    },
    models: { scope: "host" },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    composerActions: [],
    // Central provider knob, same contract as codex/claude-code/agy: bb's
    // "Disable provider subagents" setting reaches the host wrapper as
    // options.providerOptions.providerSubagentsEnabled; the wrapper applies it
    // to subagents_enabled in the Devin user config.
    deriveProviderOptions: (ctx) => ({
      providerSubagentsEnabled: ctx.settings.subagentsDisabled !== true,
      providerMemoryEnabled: ctx.settings.memoryEnabled !== false,
    }),
  });
}
