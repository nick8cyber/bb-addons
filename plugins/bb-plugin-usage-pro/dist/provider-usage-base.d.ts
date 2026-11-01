import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CollectorOptions } from "../collector-adapter";

export type { CollectorOptions };
export function createProviderUsagePlugin(
  options?: CollectorOptions
): (bb: BbPluginApi) => Promise<void>;

export default function plugin(
  bb: BbPluginApi,
  options?: CollectorOptions
): Promise<void>;

export const providerUsageRpcContract: unknown;
