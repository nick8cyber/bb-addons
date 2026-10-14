// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationRows, formatTimestamp, LABEL_ATTR, mountTimestamps, requestsForRows, ROLE_ATTR } from "./browser";

let cleanup: (() => void) | undefined;

function addRow(id: string, role: "user" | "assistant" = "assistant"): HTMLElement {
  const row = document.createElement("div");
  row.dataset.timelineRowId = id;
  const column = document.createElement("div");
  column.setAttribute("data-message-column", "");
  const content = document.createElement("div");
  content.className = role === "user" ? "group/message ml-auto" : "group/message";
  content.textContent = role === "user" ? "User message" : "Assistant message";
  column.append(content);
  row.append(column);
  document.body.append(row);
  return row;
}

const respond = (messages: { id: string; createdAt: number; role: string }[], unavailableIds: string[] = []) =>
  Promise.resolve({
    ok: true,
    json: async () => ({ ok: true, result: { messages, unavailableIds, pendingThreadIds: [], failedThreadIds: [] } }),
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 13, 20, 11));
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("visible timestamps", () => {
  it("decorates both message roles without old hover classes, covers split panes, and stops fetching known IDs", async () => {
    const user = addRow("thr_a:user", "user");
    const assistant = addRow("thr_b:assistant");
    const fetch = vi.fn((_url: string, _options: RequestInit) => respond([
      { id: "thr_a:user", role: "user", createdAt: Date.now() },
      { id: "thr_b:assistant", role: "assistant", createdAt: Date.now() },
    ]));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    cleanup = mountTimestamps({ pluginId: "thread-timestamps", signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    expect(user.getAttribute(LABEL_ATTR)).toBe("13.10.2026 20:11");
    expect(assistant.getAttribute(ROLE_ATTR)).toBe("assistant");
    expect(user.getAttribute(ROLE_ATTR)).toBe("user");
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).requests.map((r: { threadId: string }) => r.threadId)).toEqual(["thr_a", "thr_b"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(user.hasAttribute(LABEL_ATTR)).toBe(false);
    expect(assistant.hasAttribute(ROLE_ATTR)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("finds fresh messages and reuses cached dates after changing threads", async () => {
    const first = addRow("thr_a:first");
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      const ids = JSON.parse(options.body as string).requests.flatMap((request: { rowIds: string[] }) => request.rowIds);
      return respond(ids.map((id: string) => ({ id, createdAt: Date.now(), role: "assistant" })));
    });
    vi.stubGlobal("fetch", fetch);
    cleanup = mountTimestamps({ pluginId: "thread-timestamps", signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(100);
    const second = addRow("thr_a:second");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(second.hasAttribute(LABEL_ATTR)).toBe(true);
    first.remove();
    second.remove();
    const other = addRow("thr_b:other");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(other.hasAttribute(LABEL_ATTR)).toBe(true);
    other.remove();
    const again = addRow("thr_a:first");
    const requests = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(again.hasAttribute(LABEL_ATTR)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it("backs off after a failed request and restores an existing title on cleanup", async () => {
    const row = addRow("thr_a:one");
    row.title = "Existing title";
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(() =>
      respond([{ id: "thr_a:one", createdAt: Date.now(), role: "assistant" }]),
    );
    vi.stubGlobal("fetch", fetch);
    cleanup = mountTimestamps({ pluginId: "thread-timestamps", signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(row.hasAttribute(LABEL_ATTR)).toBe(true);
    cleanup();
    expect(row.title).toBe("Existing title");
  });

  it("does not decorate after a pending request resolves past disposal", async () => {
    const row = addRow("thr_a:one");
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
    cleanup = mountTimestamps({ pluginId: "thread-timestamps", signal: new AbortController().signal });
    cleanup();
    resolve(await respond([{ id: "thr_a:one", createdAt: Date.now(), role: "assistant" }]));
    await vi.advanceTimersByTimeAsync(100);
    expect(row.hasAttribute(LABEL_ATTR)).toBe(false);
  });

  it("ignores work rows and turn wrappers and bounds requests", () => {
    const turn = document.createElement("div");
    turn.dataset.timelineRowId = "thr_a:turn";
    document.body.append(turn);
    const nested = addRow("thr_a:nested");
    turn.append(nested);
    const work = document.createElement("div");
    work.dataset.timelineRowId = "thr_a:tool";
    work.textContent = "Tool output";
    document.body.append(work);
    expect(conversationRows()).toEqual([nested]);
    const incoming = document.createElement("div");
    incoming.dataset.timelineRowId = "thr_a:user-seed:42";
    incoming.textContent = "Incoming agent message";
    document.body.append(incoming);
    expect(conversationRows()).toContain(incoming);
    expect(requestsForRows([nested], new Map(), new Map(), Date.now())).toEqual([
      { threadId: "thr_a", rowIds: ["thr_a:nested"] },
    ]);
    expect(formatTimestamp(NaN)).toBe("");
    expect(formatTimestamp(new Date(2026, 0, 2, 3, 4).getTime())).toBe("02.01.2026 03:04");
    const rows = Array.from({ length: 520 }, (_, index) => addRow(`thr_a:${index}`));
    expect(requestsForRows(rows, new Map(), new Map(), Date.now())[0]!.rowIds).toHaveLength(512);
  });

  it("suppresses unavailable optimistic IDs instead of hammering the backend", async () => {
    addRow("thr_a:optimistic");
    const fetch = vi.fn(() => respond([], ["thr_a:optimistic"]));
    vi.stubGlobal("fetch", fetch);
    cleanup = mountTimestamps({ pluginId: "thread-timestamps", signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
