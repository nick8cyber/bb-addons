import type { BbPluginApi } from "@get-bb/plugin-sdk";
import providerUsagePlugin from "./dist/provider-usage-base.js";
import { registerCreditRetry } from "./credit-retry";

export { providerUsageRpcContract } from "./dist/provider-usage-base.js";

export default async function plugin(bb: BbPluginApi) {
  await providerUsagePlugin(bb);
  registerCreditRetry(bb);
}
