// Coordinator contract stub. Executor A replaces the implementations before rollout.
export type UsageIdentity = {
  machineId: string;
  providerId: string;
  accountKey: string | null;
  scopeKind: "host" | "shared";
  usageStatus: string | null;
  observedAt: number | null;
  route: "native" | "pi" | "other";
};
export function codexAccountKey(_accountId: unknown): string | null { throw new Error("Usage policy not implemented"); }
export function actualPlanLabel(_planType: unknown, _fallback?: unknown): string | null { throw new Error("Usage policy not implemented"); }
export function selectAccountResources<T>(_resources: readonly T[], _identify: (resource: T) => UsageIdentity): T[] { throw new Error("Usage policy not implemented"); }
