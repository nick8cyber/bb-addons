// Derived from bighitbiker3/message-timestamps: read timestamps from BB's timeline.
export type MessageTime = {
  id: string;
  createdAt: number;
  role: "user" | "assistant";
};

export type TimelineNode = {
  id?: string;
  kind?: string;
  role?: string;
  initiator?: string;
  createdAt?: number;
  children?: readonly TimelineNode[] | null;
};

export type Cursor = { anchorSeq: number; anchorId: string };
export type TimelinePage = {
  rows: readonly TimelineNode[];
  timelinePage: { hasOlderRows: boolean; olderCursor: Cursor | null };
};

export type TimelineReader = (args: {
  threadId: string;
  includeNestedRows: "true";
  segmentLimit: string;
  beforeAnchorSeq?: string;
  beforeAnchorId?: string;
}) => Promise<TimelinePage>;

export type TimeRequest = { threadId: string; rowIds: string[] };

export function collectMessageTimes(
  rows: readonly TimelineNode[],
  into: Map<string, MessageTime>,
): void {
  for (const row of rows) {
    if (
      row.kind === "conversation" &&
      (row.role === "user" || row.role === "assistant") &&
      typeof row.id === "string" &&
      typeof row.createdAt === "number" &&
      Number.isFinite(row.createdAt) &&
      !Number.isNaN(new Date(row.createdAt).getTime())
    ) {
      into.set(row.id, { id: row.id, createdAt: row.createdAt, role: row.role });
    }
    if (Array.isArray(row.children)) collectMessageTimes(row.children, into);
  }
}

type ThreadCache = {
  messages: Map<string, MessageTime>;
  older: Cursor | null;
  loaded: boolean;
  complete: boolean;
  lastLatestAt: number;
  inFlight: Promise<boolean> | null;
  inFlightIds: Set<string> | null;
  evicted: boolean;
};

const MAX_THREADS = 16;
const MAX_MESSAGES = 10_000;
const PAGES_PER_CALL = 4;
const LATEST_COOLDOWN_MS = 2_000;

export class TimestampReader {
  private readonly threads = new Map<string, ThreadCache>();

  constructor(
    private readonly readTimeline: TimelineReader,
    private readonly now: () => number = Date.now,
  ) {}

  clear(): void {
    this.threads.clear();
  }

  private cacheFor(threadId: string): ThreadCache {
    const cached = this.threads.get(threadId);
    if (cached) {
      this.threads.delete(threadId);
      this.threads.set(threadId, cached);
      return cached;
    }
    if (this.threads.size >= MAX_THREADS) {
      const oldest = [...this.threads].find(([, value]) => !value.inFlight);
      if (!oldest) throw new Error("Timestamp cache is busy");
      this.threads.delete(oldest[0]);
    }
    const cache: ThreadCache = {
      messages: new Map(),
      older: null,
      loaded: false,
      complete: false,
      lastLatestAt: 0,
      inFlight: null,
      inFlightIds: null,
      evicted: false,
    };
    this.threads.set(threadId, cache);
    return cache;
  }

  private async fill(request: TimeRequest, cache: ThreadCache): Promise<boolean> {
    const missing = () => request.rowIds.some((id) => !cache.messages.has(id));
    if (!missing()) return false;
    let readLatest = false;
    // A completed scan may have evicted rows from a very large thread. Start a
    // new scan for unseen rows; never reset a scan that is still in progress.
    if (cache.complete && cache.evicted) {
      cache.loaded = false;
      cache.complete = false;
      cache.evicted = false;
    }
    if (!cache.loaded || this.now() - cache.lastLatestAt >= LATEST_COOLDOWN_MS) {
      const latest = await this.readTimeline({
        threadId: request.threadId,
        includeNestedRows: "true",
        segmentLimit: "100",
      });
      collectMessageTimes(latest.rows, cache.messages);
      if (!cache.loaded) {
        cache.older = latest.timelinePage.olderCursor;
        cache.complete = !latest.timelinePage.hasOlderRows || !cache.older;
      }
      cache.loaded = true;
      cache.lastLatestAt = this.now();
      readLatest = true;
    }
    for (let page = 0; missing() && !cache.complete && cache.older && page < PAGES_PER_CALL; page += 1) {
      const previous = cache.older;
      const older = await this.readTimeline({
        threadId: request.threadId,
        includeNestedRows: "true",
        segmentLimit: "100",
        beforeAnchorSeq: String(previous.anchorSeq),
        beforeAnchorId: previous.anchorId,
      });
      collectMessageTimes(older.rows, cache.messages);
      cache.older = older.timelinePage.olderCursor;
      cache.complete = !older.timelinePage.hasOlderRows || !cache.older;
      if (
        cache.older?.anchorId === previous.anchorId &&
        cache.older?.anchorSeq === previous.anchorSeq
      ) {
        throw new Error("Timestamp history cursor did not advance");
      }
    }
    return readLatest;
  }

  async read(request: TimeRequest): Promise<{
    messages: MessageTime[];
    pending: boolean;
    unavailableIds: string[];
  }> {
    const cache = this.cacheFor(request.threadId);
    const sharesRequest = cache.inFlight === null || request.rowIds.every((id) => cache.inFlightIds?.has(id));
    if (!cache.inFlight) {
      cache.inFlightIds = new Set(request.rowIds);
      cache.inFlight = this.fill(request, cache).finally(() => {
        cache.inFlight = null;
        cache.inFlightIds = null;
      });
    }
    const readLatest = await cache.inFlight;
    // A different client's scan may have stopped as soon as its own rows were
    // found. Resolve this caller's distinct rows before declaring them absent.
    if (!sharesRequest && request.rowIds.some((id) => !cache.messages.has(id))) {
      return this.read(request);
    }
    const messages = request.rowIds.flatMap((id) => {
      const message = cache.messages.get(id);
      return message ? [message] : [];
    });
    const unresolved = request.rowIds.filter((id) => !cache.messages.has(id));
    const pending =
      unresolved.length > 0 &&
      (!cache.complete || (!readLatest && this.now() - cache.lastLatestAt < LATEST_COOLDOWN_MS));

    // Preserve this caller's requested rows while bounding the rest of history.
    const keep = new Set(request.rowIds);
    for (const id of cache.messages.keys()) {
      if (cache.messages.size <= MAX_MESSAGES) break;
      if (!keep.has(id)) {
        cache.messages.delete(id);
        cache.evicted = true;
      }
    }
    return {
      messages,
      pending,
      unavailableIds: pending ? [] : unresolved,
    };
  }
}
