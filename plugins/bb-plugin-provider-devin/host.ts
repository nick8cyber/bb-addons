/**
 * bb.host артефакт: ACP-мост bb с диалектом Devin. Копия моста собирается
 * скриптом scripts/vendor-acp-bridge.mjs из @get-bb/plugin-sdk (npm run vendor).
 *
 * Обёртка вокруг вендорного моста добавляет один перехват: центральная
 * настройка bb `subagentsDisabled` (та же, что у codex/claude-code/agy)
 * доезжает сюда как options.providerOptions.providerSubagentsEnabled на
 * thread/start|resume|fork — и применяется к `subagents_enabled` в юзерском
 * конфиге Devin (единственный рычаг: `devin acp` читает только его). Запрет —
 * стемп `false` с запоминанием прошлого значения в dataDir; включение —
 * восстановление. Конфиг пользователя с его `subagents_enabled:false`
 * (devin-hooks/install.py) не трогаем: стемпить нечего, откатывать нечего.
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_acpProviderBridge as inner } from "./src/vendor/acp-bridge.js";
import { applyDisabled, applyRestore, parseSubagentsEnabled } from "./src/subagent-gate.mjs";

let dataDir = "";
const DEVIN_CONFIG = join(homedir(), ".config", "devin", "config.json");
const gateStatePath = () => join(dataDir, "subagents-gate.json");

function log(message: string) {
  if (dataDir === "") return;
  try {
    appendFileSync(join(dataDir, "subagents-gate.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function readGateState() {
  try {
    const parsed = JSON.parse(readFileSync(gateStatePath(), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * enabled=false → stamp `subagents_enabled:false` (записываем prior один раз).
 * enabled=true  → откат ровно нашего стемпа; чужой конфиг не трогаем.
 */
function applySubagentGate(enabled: boolean) {
  const state = readGateState();
  let text = "";
  try {
    text = readFileSync(DEVIN_CONFIG, "utf8");
  } catch {}
  if (!enabled) {
    if (parseSubagentsEnabled(text) === false) return; // уже выключено — не наш стемп
    if (state === null) {
      try {
        writeFileSync(gateStatePath(), JSON.stringify({ prior: parseSubagentsEnabled(text) }));
      } catch {}
    }
    const next = applyDisabled(text);
    if (next !== text) {
      writeFileSync(DEVIN_CONFIG, next);
      log("subagents_enabled=false applied (bb central setting)");
    }
    return;
  }
  if (state === null) return; // мы не стемпили — чужой выбор уважаем
  const next = applyRestore(text, state.prior ?? null);
  if (next !== text) {
    writeFileSync(DEVIN_CONFIG, next);
    log(`subagents_enabled restored (prior=${JSON.stringify(state.prior ?? null)})`);
  }
  try {
    rmSync(gateStatePath(), { force: true });
  } catch {}
}

const GATE_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);

export const experimental_providerBridge = {
  ...inner,
  start(context: { pluginId: string; dataDir: string; tempDir: string }) {
    dataDir = context.dataDir ?? "";
    inner.start?.(context);
  },
  handleLine(line: string) {
    try {
      const msg = JSON.parse(line);
      if (msg !== null && typeof msg === "object" && GATE_METHODS.has(msg.method)) {
        const enabled = msg.params?.options?.providerOptions?.providerSubagentsEnabled;
        if (typeof enabled === "boolean") applySubagentGate(enabled);
      }
    } catch {}
    inner.handleLine(line);
  },
};
