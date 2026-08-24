/**
 * The plugin's single `bb.host` artifact. It exports the provider bridge the
 * daemon's bridge bootstrap imports and drives in its own process. Nothing
 * else lives here — this plugin has no host RPC entry.
 */
export { experimental_providerBridge } from "./src/provider-bridge.js";
