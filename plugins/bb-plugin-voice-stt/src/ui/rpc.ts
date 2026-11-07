/**
 * RPC-клиент фронтенда voice-stt — тот же транспорт, что у live-call
 * (src/ui/rpc.ts): POST в /api/v1/plugins/<id>/rpc/<method>, точка внедрения
 * для тестов через setCustomRpcHandler.
 */

export const RPC_ENDPOINT = "/api/v1/plugins/voice-stt/rpc";

export interface LiveTokenResult {
  token: string;
}

export type LiveFallbackResult =
  | { ok: true; text: string; engine: string }
  | { ok: false; code: string; message: string };

type RpcHandler = (method: string, input: object) => Promise<unknown>;
let customRpcHandler: RpcHandler | null = null;

export function setCustomRpcHandler(handler: RpcHandler | null): void {
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
  const body = (await response.json()) as {
    ok: boolean;
    result?: Output;
    error?: { message?: string };
  };
  if (!body.ok) throw new Error(body.error?.message ?? "запрос не удался");
  return body.result as Output;
}
