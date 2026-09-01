/**
 * Typed fetch wrapper for this plugin's own RPC surface.
 *
 * `useRpc()` is a hook, and the message button is a plain `run` callback with
 * no component around it, so both halves of the frontend go through this
 * instead — one code path, callable from anywhere.
 */
export const PLUGIN_RPC_ENDPOINT = "/api/v1/plugins/speak/rpc";

type RpcEnvelope<T> = { ok: true; result: T } | { ok: false; error: unknown };

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "the request failed";
}

export async function rpc<Output>(
  method: string,
  input: object | null = {},
): Promise<Output> {
  let response: Response;
  try {
    response = await fetch(`${PLUGIN_RPC_ENDPOINT}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new Error(
      `bb server unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let body: RpcEnvelope<Output> | undefined;
  try {
    body = (await response.json()) as RpcEnvelope<Output>;
  } catch {
    throw new Error(`bad response from ${method} (HTTP ${response.status})`);
  }
  if (!body?.ok) throw new Error(messageOf(body ? body.error : undefined));
  return body.result;
}
