import { defineRpcContract, type BbPluginApi, type PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DELAYS_MINUTES = [15, 30, 60, 120] as const;
const availabilityMethod = "provider-retry.v1.availability";
const availabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-routed") }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("blocked"), retryAt: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("unavailable"), reason: z.enum(["no-enabled-account", "authentication", "reset-unknown", "source-unavailable"]) }),
]);
const diagnosticSchema = z.object({
  requestId: z.string(), attemptNumber: z.number().int(), recordedAt: z.number(),
  outcome: z.enum(["scheduled", "declined"]), reason: z.string(), sendAt: z.number().nullable(),
});
type Diagnostic = z.infer<typeof diagnosticSchema>;
interface SavedState { seen: string[]; last: Diagnostic }
export const creditRetryContract = defineRpcContract({
  "creditRetry.status": {
    experimental_description: "Read the bounded Codex workspace-member credit retry policy and last scheduling decision for a thread.",
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ enabled: z.boolean(), delaysMinutes: z.array(z.number()), last: diagnosticSchema.nullable() }),
  },
});

export function isWorkspaceCreditFailure(event: PluginTurnFailedEvent): boolean {
  return event.errorInfo?.category === "rate-limit"
    && event.rateLimits?.providerId === "codex"
    && event.rateLimits.status === "blocked"
    && event.rateLimits.kind === "credits"
    && event.rateLimits.reachedReason === "workspace_member_credits_depleted";
}

export function creditRetryAt(attemptNumber: number, now: number, random: number): number | null {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > DELAYS_MINUTES.length) return null;
  return now + DELAYS_MINUTES[attemptNumber - 1]! * 60_000 + Math.floor(Math.max(0, Math.min(random, 1)) * 30_000);
}

export function registerCreditRetry(bb: BbPluginApi) {
  let disposed = false;
  const inFlight = new Set<string>();
  const stateKey = (threadId: string) => "credit-retry:" + threadId;
  bb.onDispose(() => { disposed = true; });
  bb.rpc.register(creditRetryContract, {
    "creditRetry.status": async ({ threadId }) => ({
      enabled: !disposed, delaysMinutes: [...DELAYS_MINUTES],
      last: (await bb.storage.kv.get<SavedState>(stateKey(threadId)))?.last ?? null,
    }),
  });
  bb.events.on("turn.failed", async event => {
    if (disposed || !isWorkspaceCreditFailure(event) || inFlight.has(event.threadId)) return;
    inFlight.add(event.threadId);
    try {
      const key = stateKey(event.threadId);
      const token = event.requestId + ":" + event.attemptNumber;
      const saved = await bb.storage.kv.get<SavedState>(key);
      if (saved?.seen.includes(token)) return; // Cancellation/reload must not resurrect this attempt.
      const record = async (outcome: Diagnostic["outcome"], reason: string, sendAt: number | null = null) => {
        if (disposed) return;
        await bb.storage.kv.set(key, {
          seen: outcome === "scheduled" ? [...(saved?.seen ?? []), token].slice(-32) : saved?.seen ?? [],
          last: { requestId: event.requestId, attemptNumber: event.attemptNumber, recordedAt: Date.now(), outcome, reason, sendAt },
        } satisfies SavedState);
      };
      const sendAt = creditRetryAt(event.attemptNumber, Date.now(), Math.random());
      if (sendAt === null) { await record("declined", "attempts-exhausted"); return; }

      // The builtin owns every routed request. Never bypass a pool's authentication/availability.
      const sources = await bb.sdk.plugins.experimental_discoverRpc({ method: availabilityMethod });
      for (const source of sources) {
        let availability;
        try {
          availability = await bb.sdk.plugins.callRpc({
            pluginId: source.pluginId, method: availabilityMethod,
            input: { threadId: event.threadId, requestId: event.requestId },
            outputSchema: availabilitySchema, signal: AbortSignal.timeout(5_000),
          });
        } catch {
          await record("declined", "availability-error"); return;
        }
        if (availability.kind !== "not-routed") { await record("declined", "pool-owned"); return; }
      }

      const thread = await bb.sdk.threads.get({ threadId: event.threadId });
      if (thread.providerId !== "codex" || thread.status !== "error" || thread.archivedAt !== null || thread.deletedAt !== null) {
        await record("declined", "thread-no-longer-eligible"); return;
      }
      if ((await bb.sdk.threads.queue.list({ threadId: event.threadId })).length > 0) {
        await record("declined", "queue-not-empty"); return;
      }
      if (disposed) return;
      // Core validates the failed request again and atomically enforces one live retry in its chain.
      await bb.sdk.threads.retry({
        threadId: event.threadId, turnRequestId: event.requestId, sendAt,
        reason: "Кредиты Codex исчерпаны — автоматический повтор",
      });
      await record("scheduled", "workspace-member-credits", sendAt);
      if (!disposed) bb.log.info("Codex credit retry queued for " + event.threadId + " at " + new Date(sendAt).toISOString());
    } catch (error) {
      if (!disposed) bb.log.warn("Codex credit retry could not be queued for " + event.threadId + ": " + String(error));
    } finally {
      inFlight.delete(event.threadId);
    }
  });
}
