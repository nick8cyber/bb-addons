/** App-side types inferred from the server's RPC contract. */
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";

export type Contract = typeof rpcContract;
export type CatalogData = PluginRpcResult<Contract["getCatalog"]>;
export type QueryResult = PluginRpcResult<Contract["queryTasks"]>;
export type DetailResult = PluginRpcResult<Contract["getTaskDetail"]>;
export type ViewsResult = PluginRpcResult<Contract["listViews"]>;
export type EnrichedTask = QueryResult["tasks"][number];
export type DetailTask = NonNullable<DetailResult["task"]>;
export type SavedViewData = ViewsResult["views"][number];
