import type { BbPluginApi } from "@get-bb/plugin-sdk";
import providerUsagePlugin from "./dist/provider-usage-base.js";
import { registerCreditRetry } from "./credit-retry";
import { registerClaudeKey } from "./claude-key";

export { providerUsageRpcContract } from "./dist/provider-usage-base.js";
export { claudeKeyContract } from "./claude-key";

export default async function plugin(bb: BbPluginApi) {
  await providerUsagePlugin(bb);
  registerCreditRetry(bb);
  registerClaudeKey(bb);
}
