/**
 * The plugin's single `bb.host` artifact. It exports the provider bridge the
 * daemon's bridge bootstrap imports and drives in its own process. Nothing
 * else lives here — this plugin has no host RPC entry.
 *
 * Transport switch: the ACP wrapper (generic `agy acp` bridge + proprietary
 * pool/recovery layer) is the default; `AGY_TRANSPORT=stream-json` pins the
 * previous stream-json bridge for one release as a no-deploy rollback.
 */
import { experimental_providerBridge as acpBridge } from "./src/acp-wrapper.js";
import { experimental_providerBridge as streamJsonBridge } from "./src/provider-bridge.js";

export const experimental_providerBridge =
  process.env.AGY_TRANSPORT === "stream-json" ? streamJsonBridge : acpBridge;
