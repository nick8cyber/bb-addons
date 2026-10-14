import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { TimestampReader } from "./timeline";

const requestSchema = z.object({
  threadId: z.string().min(1).max(100),
  rowIds: z.array(z.string().min(1).max(1_024)).min(1).max(512),
}).strict().refine(
  ({ threadId, rowIds }) => rowIds.every((id) => id.startsWith(`${threadId}:`)),
  "Rows must belong to their requested thread",
);

export const rpcContract = defineRpcContract({
  messageTimes: {
    input: z.object({
      requests: z.array(requestSchema).min(1).max(8).refine(
        (requests) => new Set(requests.map((request) => request.threadId)).size === requests.length,
        "Thread requests must be unique",
      ),
    }).strict(),
    output: z.object({
      messages: z.array(z.object({
        id: z.string(),
        createdAt: z.number(),
        role: z.enum(["user", "assistant"]),
      })),
      pendingThreadIds: z.array(z.string()),
      failedThreadIds: z.array(z.string()),
      unavailableIds: z.array(z.string()),
    }),
  },
});

export default function plugin(bb: BbPluginApi): void {
  const controller = new AbortController();
  const reader = new TimestampReader(async (args) =>
    bb.sdk.threads.timeline({ ...args, signal: controller.signal }),
  );

  bb.rpc.register(rpcContract, {
    async messageTimes({ requests }) {
      const results = await Promise.allSettled(requests.map((request) => reader.read(request)));
      const messages = [];
      const pendingThreadIds: string[] = [];
      const failedThreadIds: string[] = [];
      const unavailableIds: string[] = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        if (result.status === "rejected") {
          const threadId = requests[index]!.threadId;
          failedThreadIds.push(threadId);
          bb.log.warn(`Timestamp lookup failed for ${threadId}: ${String(result.reason)}`);
          continue;
        }
        messages.push(...result.value.messages);
        unavailableIds.push(...result.value.unavailableIds);
        if (result.value.pending) pendingThreadIds.push(requests[index]!.threadId);
      }
      return { messages, pendingThreadIds, failedThreadIds, unavailableIds };
    },
  });

  bb.onDispose(() => {
    controller.abort();
    reader.clear();
  });
}
