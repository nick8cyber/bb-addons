import type { MessageTime, TimeRequest } from "./timeline";

export const LABEL_ATTR = "data-bb-thread-timestamp";
export const ROLE_ATTR = "data-bb-thread-timestamp-role";
const SCAN_MS = 500;
const REQUEST_COOLDOWN_MS = 2_000;
const NEGATIVE_CACHE_MS = 30_000;
const MAX_TIMES = 10_000;

type ResponseBody = {
  messages: MessageTime[];
  pendingThreadIds: string[];
  failedThreadIds: string[];
  unavailableIds: string[];
};
type Envelope =
  | { ok: true; result: ResponseBody }
  | { ok: false; error?: { message?: string } };

const pad = (value: number) => String(value).padStart(2, "0");

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatFullTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString("ru-RU", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZoneName: "short",
  });
}

export function conversationRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")].filter((row) => {
    const message = row.querySelector("[data-message-column], .group\\/message");
    if (message?.closest("[data-timeline-row-id]") === row) return true;
    // Incoming agent/system messages use a disclosure instead of a bubble.
    // Their conversation IDs still share BB's user-seed / assistant prefixes.
    return /^[^:]+:(?:user-seed|assistant):/.test(row.dataset.timelineRowId ?? "");
  });
}

export function requestsForRows(
  rows: readonly HTMLElement[],
  known: ReadonlyMap<string, MessageTime>,
  unavailable: ReadonlyMap<string, number>,
  now: number,
): TimeRequest[] {
  const requests = new Map<string, Set<string>>();
  for (const row of rows) {
    const id = row.dataset.timelineRowId;
    if (!id || known.has(id) || (unavailable.get(id) ?? 0) > now) continue;
    const separator = id.indexOf(":");
    if (separator < 1 || id.length > 1_024) continue;
    const threadId = id.slice(0, separator);
    if (threadId.length > 100) continue;
    if (!requests.has(threadId)) {
      if (requests.size >= 8) continue;
      requests.set(threadId, new Set());
    }
    const ids = requests.get(threadId)!;
    if (ids.size < 512) ids.add(id);
  }
  return [...requests].map(([threadId, ids]) => ({ threadId, rowIds: [...ids] }));
}

export function mountTimestamps({ pluginId, signal }: {
  pluginId: string;
  signal: AbortSignal;
}): () => void {
  const times = new Map<string, MessageTime>();
  const unavailable = new Map<string, number>();
  const decorated = new Map<HTMLElement, { previousTitle: string | null; ownedTitle: string }>();
  const controller = new AbortController();
  let stopped = false;
  let inFlight = false;
  let nextRequestAt = 0;
  let failures = 0;
  let scheduled: number | null = null;

  const undecorate = (row: HTMLElement) => {
    const previous = decorated.get(row);
    row.removeAttribute(LABEL_ATTR);
    row.removeAttribute(ROLE_ATTR);
    if (previous && row.getAttribute("title") === previous.ownedTitle) {
      if (previous.previousTitle === null) row.removeAttribute("title");
      else row.setAttribute("title", previous.previousTitle);
    }
    decorated.delete(row);
  };

  const decorate = (rows: readonly HTMLElement[]) => {
    const keep = new Set(rows);
    for (const row of decorated.keys()) {
      if (!keep.has(row)) undecorate(row);
    }
    for (const row of rows) {
      const id = row.dataset.timelineRowId;
      const message = id ? times.get(id) : undefined;
      if (!message) {
        if (decorated.has(row)) undecorate(row);
        continue;
      }
      const label = formatTimestamp(message.createdAt);
      if (!label) continue;
      const title = formatFullTimestamp(message.createdAt);
      if (!decorated.has(row)) {
        decorated.set(row, { previousTitle: row.getAttribute("title"), ownedTitle: title });
      } else {
        decorated.get(row)!.ownedTitle = title;
      }
      if (row.getAttribute(LABEL_ATTR) !== label) row.setAttribute(LABEL_ATTR, label);
      if (row.getAttribute(ROLE_ATTR) !== message.role) row.setAttribute(ROLE_ATTR, message.role);
      if (row.getAttribute("title") !== title) row.setAttribute("title", title);
    }
  };

  const prune = (rows: readonly HTMLElement[]) => {
    const visible = new Set(rows.map((row) => row.dataset.timelineRowId));
    for (const id of times.keys()) {
      if (times.size <= MAX_TIMES) break;
      if (!visible.has(id)) times.delete(id);
    }
    for (const [id, expiresAt] of unavailable) {
      if (expiresAt <= Date.now() || unavailable.size > MAX_TIMES) unavailable.delete(id);
    }
  };

  const scan = () => {
    if (stopped || signal.aborted) return;
    const rows = conversationRows();
    decorate(rows);
    prune(rows);
    const requests = requestsForRows(rows, times, unavailable, Date.now());
    if (requests.length === 0 || inFlight || Date.now() < nextRequestAt) return;
    inFlight = true;
    nextRequestAt = Date.now() + REQUEST_COOLDOWN_MS;
    void fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/messageTimes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests }),
      signal: controller.signal,
    }).then(async (response) => {
      const envelope = await response.json() as Envelope;
      if (!response.ok || !envelope.ok) throw new Error("Timestamp request failed");
      if (stopped || signal.aborted) return;
      for (const message of envelope.result.messages) {
        if (formatTimestamp(message.createdAt)) times.set(message.id, message);
      }
      for (const id of envelope.result.unavailableIds) {
        unavailable.set(id, Date.now() + NEGATIVE_CACHE_MS);
      }
      if (envelope.result.failedThreadIds.length > 0) throw new Error("Some timestamp lookups failed");
      failures = 0;
    }).catch(() => {
      if (stopped || signal.aborted) return;
      failures += 1;
      nextRequestAt = Date.now() + Math.min(30_000, REQUEST_COOLDOWN_MS * 2 ** Math.min(failures, 4));
    }).finally(() => {
      inFlight = false;
      if (!stopped && !signal.aborted) decorate(conversationRows());
    });
  };

  const schedule = () => {
    if (stopped || scheduled !== null) return;
    scheduled = window.setTimeout(() => {
      scheduled = null;
      scan();
    }, 50);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-timeline-row-id"],
  });
  const timer = window.setInterval(scan, SCAN_MS);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    observer.disconnect();
    window.clearInterval(timer);
    if (scheduled !== null) window.clearTimeout(scheduled);
    signal.removeEventListener("abort", cleanup);
    for (const row of decorated.keys()) undecorate(row);
    times.clear();
    unavailable.clear();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  if (signal.aborted) cleanup();
  else scan();
  return cleanup;
}
