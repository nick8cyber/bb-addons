/**
 * Управление жизненным циклом тредов звонков (контракт §13).
 * Закрытие ходов, перехват 409 с очередью, аварийная остановка через sdk.threads.stop.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CallStore } from "./call-store.js";
import { toArray } from "./tools.js";

export interface SockLike {
  send(data: string): void;
}

export interface ThreadManagerOptions {
  sdk: BbPluginApi["sdk"];
  store: CallStore;
  bridgeOwner: Map<string, SockLike>;
  turnClosedWaiters: Map<string, () => void>;
  log?: { info(s: string): void; warn(s: string): void; error(s: string): void };
}

export function createCallThreadManager(opts: ThreadManagerOptions) {
  const { sdk, store, bridgeOwner, turnClosedWaiters, log } = opts;
  const advanceQueues = new Map<string, string[]>();
  const advanceProcessing = new Set<string>();
  const endedThreads = new Set<string>();

  const processAdvanceQueue = async (threadId: string): Promise<void> => {
    if (endedThreads.has(threadId)) {
      advanceQueues.delete(threadId);
      return;
    }
    if (advanceProcessing.has(threadId)) return;
    const queue = advanceQueues.get(threadId);
    if (!queue || queue.length === 0) return;

    advanceProcessing.add(threadId);
    try {
      while (queue.length > 0) {
        if (endedThreads.has(threadId)) {
          queue.length = 0;
          advanceQueues.delete(threadId);
          break;
        }
        const utterance = queue[0];
        try {
          const owner = bridgeOwner.get(threadId);
          if (owner) {
            const closed = new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 3000);
              turnClosedWaiters.set(threadId, () => {
                clearTimeout(timer);
                turnClosedWaiters.delete(threadId);
                resolve();
              });
            });
            owner.send(JSON.stringify({ type: "end", threadId }));
            await closed;
          }

          if (endedThreads.has(threadId)) {
            queue.length = 0;
            advanceQueues.delete(threadId);
            break;
          }

          await sdk.threads.send({
            threadId,
            mode: "start",
            input: [{ type: "text", text: utterance, mentions: [] }],
          } as never);

          queue.shift();
        } catch (e: unknown) {
          if (endedThreads.has(threadId)) {
            queue.length = 0;
            advanceQueues.delete(threadId);
            break;
          }
          const msg = String((e as { message?: unknown })?.message ?? e);
          const status = (e as { status?: unknown })?.status;
          if (status === 409 || msg.includes("409") || msg.includes("already active")) {
            log?.warn(`advanceCallThread 409 for ${threadId}: turn is active, utterance queued`);
            setTimeout(() => {
              if (!endedThreads.has(threadId)) {
                void processAdvanceQueue(threadId);
              }
            }, 1500);
            break;
          } else {
            log?.error(`advanceCallThread error for ${threadId}: ${msg}`);
            queue.shift();
          }
        }
      }
    } catch (e) {
      log?.error(`processAdvanceQueue error for ${threadId}: ${String(e)}`);
    } finally {
      advanceProcessing.delete(threadId);
    }
  };

  const advanceCallThread = async (threadId: string, utterance: string): Promise<void> => {
    if (endedThreads.has(threadId)) return;
    try {
      let q = advanceQueues.get(threadId);
      if (!q) {
        q = [];
        advanceQueues.set(threadId, q);
      }
      q.push(utterance);
      await processAdvanceQueue(threadId);
    } catch (e) {
      log?.error(`advanceCallThread uncaught error suppressed for ${threadId}: ${String(e)}`);
    }
  };

  const sayCallThread = async (threadId: string, text: string): Promise<void> => {
    if (endedThreads.has(threadId)) return;
    try {
      const owner = bridgeOwner.get(threadId);
      owner?.send(JSON.stringify({ type: "say", threadId, text }));
    } catch (e) {
      log?.warn(`sayCallThread error suppressed for ${threadId}: ${String(e)}`);
    }
  };

  const endCallThread = async (threadId: string, summary: string, callId?: string): Promise<void> => {
    endedThreads.add(threadId);
    advanceQueues.delete(threadId);
    let closed = false;
    const owner = bridgeOwner.get(threadId);
    if (owner) {
      try {
        owner.send(JSON.stringify({ type: "say", threadId, text: summary }));
        const waitClosed = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          turnClosedWaiters.set(threadId, () => {
            clearTimeout(timer);
            turnClosedWaiters.delete(threadId);
            resolve();
          });
        });
        owner.send(JSON.stringify({ type: "end", threadId }));
        await waitClosed;
        const t = (await sdk.threads.get({ threadId }).catch(() => null)) as unknown as { thread?: { status?: string }; status?: string } | null;
        const st = t?.thread?.status ?? t?.status;
        if (st && st !== "active" && st !== "starting") {
          closed = true;
        }
      } catch (e) {
        log?.warn(`endCallThread bridge error for ${threadId}: ${String(e)}`);
      }
    }

    if (!closed) {
      try {
        const t = (await sdk.threads.get({ threadId }).catch(() => null)) as unknown as { thread?: { status?: string }; status?: string } | null;
        const st = t?.thread?.status ?? t?.status;
        if (!st || st === "active" || st === "starting") {
          log?.info(`endCallThread fallback: stopping thread ${threadId} (status: ${st ?? "unknown"}) via sdk.threads.stop`);
          await sdk.threads.stop({ threadId });
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const check = (await sdk.threads.get({ threadId }).catch(() => null)) as unknown as { thread?: { status?: string }; status?: string } | null;
            const curSt = check?.thread?.status ?? check?.status;
            if (curSt && curSt !== "active" && curSt !== "starting") {
              break;
            }
          }
        }
        closed = true;
      } catch (e) {
        log?.error(`endCallThread fallback stop failed for ${threadId}: ${String(e)}`);
        if (callId) {
          store.event(callId, "thread_close_failed", { threadId, error: String(e) });
        }
        throw e;
      }
    }
  };

  return {
    advanceCallThread,
    sayCallThread,
    endCallThread,
    processAdvanceQueue,
    getQueue: (threadId: string) => advanceQueues.get(threadId) ?? [],
  };
}

export async function closeStaleCallThreads(
  store: CallStore,
  sdk: BbPluginApi["sdk"],
  callsProjectId?: string | null,
  log?: { info(s: string): void; warn(s: string): void },
): Promise<string[]> {
  const staleThreadIds = store.closeStale();
  const stopped = new Set<string>();

  for (const threadId of staleThreadIds) {
    try {
      const t = (await sdk.threads.get({ threadId }).catch(() => null)) as unknown as { thread?: { status?: string }; status?: string } | null;
      const st = t?.thread?.status ?? t?.status;
      if (st === "active" || st === "starting") {
        log?.info(`closeStaleCallThreads: stopping stale thread ${threadId} (status: ${st})`);
        await sdk.threads.stop({ threadId });
        stopped.add(threadId);
      }
    } catch (e) {
      log?.warn(`closeStaleCallThreads error stopping ${threadId}: ${String(e)}`);
    }
  }

  // Также проверяем проект «Звонки», если id известен
  if (callsProjectId) {
    try {
      const listArea = sdk.threads as unknown as { list(a: { projectId: string }): Promise<unknown> };
      if (typeof listArea?.list === "function") {
        const res = await listArea.list({ projectId: callsProjectId });
        const items = toArray(res);
        for (const item of items) {
          const threadId = String(item.id ?? "");
          const st = String(item.status ?? "");
          if (threadId && (st === "active" || st === "starting") && !stopped.has(threadId)) {
            log?.info(`closeStaleCallThreads: stopping orphaned active thread in calls project: ${threadId}`);
            await sdk.threads.stop({ threadId }).catch(() => {});
            stopped.add(threadId);
          }
        }
      }
    } catch (e) {
      log?.warn(`closeStaleCallThreads scan calls project error: ${String(e)}`);
    }
  }

  return Array.from(stopped);
}
