/**
 * bb.host артефакт: ACP-мост bb с диалектом Devin. Копия моста собирается
 * скриптом scripts/vendor-acp-bridge.mjs из @get-bb/plugin-sdk (npm run vendor).
 */
export { experimental_acpProviderBridge as experimental_providerBridge } from "./src/vendor/acp-bridge.js";
