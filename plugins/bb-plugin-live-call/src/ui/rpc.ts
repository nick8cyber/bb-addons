/**
 * RPC-клиент фронтенда live-call (контракт §15.8).
 */

export const RPC_ENDPOINT = "/api/v1/plugins/live-call/rpc";

export interface ProjectCallItem {
  projectId: string;
  title: string;
  state: "approved" | "pending" | "invalid" | "rejected";
  hash?: string;
  diff?: string[];
  error?: string;
}

export interface ProjectCallsListResult {
  projects: ProjectCallItem[];
}

export interface ProjectCallsApproveResult {
  ok: boolean;
  error?: string;
}

export interface ProjectCallsRejectResult {
  ok: boolean;
}

export interface CallTokenResult {
  token: string;
}

type RpcHandler = (method: string, input: object) => Promise<unknown>;
let customRpcHandler: RpcHandler | null = null;

export function setCustomRpcHandler(handler: RpcHandler | null) {
  customRpcHandler = handler;
}

export async function rpc<Output>(method: string, input: object = {}): Promise<Output> {
  if (customRpcHandler) {
    return (await customRpcHandler(method, input)) as Output;
  }
  const response = await fetch(`${RPC_ENDPOINT}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as { ok: boolean; result?: Output; error?: { message?: string } };
  if (!body.ok) throw new Error(body.error?.message ?? "запрос не удался");
  return body.result as Output;
}
