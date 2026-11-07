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
import { homedir } from "node:os";
import { join } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Devin CLI ставится в ~/.local/bin (официальный установщик). */
const DEVIN_BIN = join(homedir(), ".local", "bin", "devin");

export default function plugin(bb: BbPluginApi) {
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
  });
}
