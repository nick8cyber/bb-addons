export type UsageIdentity = {
  machineId: string;
  providerId: string;
  accountKey: string | null;
  scopeKind: "host" | "shared";
  usageStatus: string | null;
  observedAt: number | null;
  route: "native" | "pi" | "other";
};

const OPENAI_CHATGPT_PREFIX = "openai:chatgpt:";

export function codexAccountKey(accountId: unknown): string | null {
  if (typeof accountId !== "string") {
    return null;
  }
  const trimmed = accountId.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith(OPENAI_CHATGPT_PREFIX)) {
    const suffix = trimmed.slice(OPENAI_CHATGPT_PREFIX.length).trim();
    if (suffix.length === 0) {
      return null;
    }
    return `${OPENAI_CHATGPT_PREFIX}${suffix}`;
  }
  return `${OPENAI_CHATGPT_PREFIX}${trimmed}`;
}

const KNOWN_PLAN_LABELS = new Map<string, string>([
  ["free", "Free"],
  ["go", "Go"],
  ["plus", "Plus"],
  ["pro", "Pro"],
  ["max", "Max"],
  ["team", "Team"],
  ["business", "Business"],
  ["enterprise", "Enterprise"],
  ["education", "Education"],
  ["edu", "Education"],
]);

function formatPlanString(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const known = KNOWN_PLAN_LABELS.get(lower);
  if (known !== undefined) {
    return known;
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function actualPlanLabel(planType: unknown, fallback?: unknown): string | null {
  if (typeof planType === "string" && planType.trim().length > 0) {
    return formatPlanString(planType);
  }
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return formatPlanString(fallback);
  }
  return null;
}

type IndexedCandidate<T> = {
  resource: T;
  identity: UsageIdentity;
  originalIndex: number;
};

const CODEX_STATUS_RANKS = new Map<string, number>([
  ["ok", 0],
  ["expired", 1],
  ["unauthenticated", 2],
  ["error", 3],
  ["not_installed", 4],
]);

function codexStatusRank(status: string | null | undefined): number {
  if (!status) return 5;
  const rank = CODEX_STATUS_RANKS.get(status.trim().toLowerCase());
  return rank !== undefined ? rank : 5;
}

function routeRank(route: string | null | undefined): number {
  if (!route) return 2;
  const r = route.trim().toLowerCase();
  if (r === "native") return 0;
  if (r === "pi") return 1;
  return 2;
}

function pickCodexWinner<T>(candidates: IndexedCandidate<T>[]): IndexedCandidate<T> {
  if (candidates.length === 1) {
    return candidates[0];
  }

  // 1. Status priority: ok > expired > unauthenticated > error > not_installed > отсутствие измерения
  let minStatusRank = Infinity;
  for (const c of candidates) {
    const rank = codexStatusRank(c.identity.usageStatus);
    if (rank < minStatusRank) {
      minStatusRank = rank;
    }
  }
  const statusFiltered = candidates.filter(
    (c) => codexStatusRank(c.identity.usageStatus) === minStatusRank,
  );
  if (statusFiltered.length === 1) {
    return statusFiltered[0];
  }

  // 2. Freshness within status:
  // observedAt=null старше любого известного времени;
  // разницу известных времён до 5000 ms считать равенством
  const withTime = statusFiltered.filter(
    (c) => typeof c.identity.observedAt === "number" && Number.isFinite(c.identity.observedAt),
  );

  let freshnessFiltered: IndexedCandidate<T>[];
  if (withTime.length > 0) {
    let maxTime = -Infinity;
    for (const c of withTime) {
      if (c.identity.observedAt! > maxTime) {
        maxTime = c.identity.observedAt!;
      }
    }
    freshnessFiltered = withTime.filter(
      (c) => maxTime - c.identity.observedAt! <= 5000,
    );
  } else {
    freshnessFiltered = statusFiltered;
  }

  if (freshnessFiltered.length === 1) {
    return freshnessFiltered[0];
  }

  // 3. Route priority: native > Pi > other
  let minRouteRank = Infinity;
  for (const c of freshnessFiltered) {
    const rank = routeRank(c.identity.route);
    if (rank < minRouteRank) {
      minRouteRank = rank;
    }
  }
  const routeFiltered = freshnessFiltered.filter(
    (c) => routeRank(c.identity.route) === minRouteRank,
  );
  if (routeFiltered.length === 1) {
    return routeFiltered[0];
  }

  // 4. Stable tie-break: first candidate preserved
  let best = routeFiltered[0];
  for (let i = 1; i < routeFiltered.length; i++) {
    if (routeFiltered[i].originalIndex < best.originalIndex) {
      best = routeFiltered[i];
    }
  }
  return best;
}

function pickOtherProviderWinner<T>(candidates: IndexedCandidate<T>[]): IndexedCandidate<T> {
  if (candidates.length === 1) {
    return candidates[0];
  }
  // Preserve shared-source preference
  const firstShared = candidates.find(
    (c) => c.identity.scopeKind === "shared",
  );
  if (firstShared !== undefined) {
    return firstShared;
  }
  return candidates[0];
}

export function selectAccountResources<T>(
  resources: readonly T[],
  identify: (resource: T) => UsageIdentity,
): T[] {
  if (resources.length <= 1) {
    return [...resources];
  }

  type SlotItem<T> = {
    slotIndex: number;
    resource: T;
  };

  const slots: SlotItem<T>[] = [];
  const groups = new Map<string, IndexedCandidate<T>[]>();

  for (let i = 0; i < resources.length; i++) {
    const resource = resources[i];
    const identity = identify(resource);

    if (identity.accountKey === null || identity.accountKey.trim().length === 0) {
      // Unknown IDs are not deduplicated
      slots.push({ slotIndex: i, resource });
      continue;
    }

    // providerId and accountKey are opaque IDs; do not lowercase or trim for grouping
    const key = JSON.stringify([identity.machineId, identity.providerId, identity.accountKey]);

    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push({ resource, identity, originalIndex: i });
  }

  for (const candidates of groups.values()) {
    const winner =
      candidates[0].identity.providerId === "codex"
        ? pickCodexWinner(candidates)
        : pickOtherProviderWinner(candidates);

    // Winner occupies the initial position of the first card of identity
    slots.push({
      slotIndex: candidates[0].originalIndex,
      resource: winner.resource,
    });
  }

  slots.sort((a, b) => a.slotIndex - b.slotIndex);
  return slots.map((s) => s.resource);
}
