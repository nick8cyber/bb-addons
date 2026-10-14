import { describe, expect, it, vi } from "vitest";
import { collectMessageTimes, TimestampReader, type TimelinePage, type TimelineReader } from "./timeline";
import { rpcContract } from "./server";

const message = (id: string, role = "assistant", createdAt = 1_791_911_469_665) => ({
  id, kind: "conversation", role, createdAt,
});
const page = (ids: string[], cursor: number | null): TimelinePage => ({
  rows: ids.map((id) => message(id)),
  timelinePage: {
    hasOlderRows: cursor !== null,
    olderCursor: cursor === null ? null : { anchorSeq: cursor, anchorId: `turn-${cursor}` },
  },
});

describe("message coverage", () => {
  it("includes both roles, agent-origin users and nested messages, ignoring tools and invalid dates", () => {
    const times = new Map();
    collectMessageTimes([
      message("user", "user"),
      { ...message("other-agent", "user"), initiator: "agent" },
      { kind: "turn", children: [message("nested")] },
      { ...message("tool"), kind: "work" },
      message("nan", "user", NaN),
      message("out-of-range", "assistant", 9e15),
    ], times);
    expect([...times.keys()]).toEqual(["user", "other-agent", "nested"]);
    expect(times.get("nested").role).toBe("assistant");
  });

  it("rejects cross-thread IDs and oversized RPC arrays", () => {
    const input = rpcContract.messageTimes.input;
    expect(input.safeParse({ requests: [{ threadId: "thr_a", rowIds: ["thr_b:message"] }] }).success).toBe(false);
    expect(input.safeParse({ requests: [{ threadId: "thr_a", rowIds: Array(513).fill("thr_a:message") }] }).success).toBe(false);
    expect(input.safeParse({ requests: [{ threadId: "thr_a", rowIds: ["thr_a:message"] }] }).success).toBe(true);
  });
});

describe("bounded timeline loading", () => {
  it("continues old history across calls instead of silently dropping messages beyond a page cap", async () => {
    const timeline = vi.fn(async (args: Parameters<TimelineReader>[0]) => {
      if (!args.beforeAnchorSeq) return page(["thr_a:recent"], 6);
      const cursor = Number(args.beforeAnchorSeq);
      return page([cursor === 1 ? "thr_a:old" : `thr_a:intermediate-${cursor}`], cursor === 1 ? null : cursor - 1);
    });
    const reader = new TimestampReader(timeline, () => 100);
    const request = { threadId: "thr_a", rowIds: ["thr_a:old"] };
    const first = await reader.read(request);
    expect(first.messages).toEqual([]);
    expect(first.pending).toBe(true);
    expect(timeline).toHaveBeenCalledTimes(5);
    const second = await reader.read(request);
    expect(second.messages.map((m) => m.id)).toEqual(["thr_a:old"]);
    expect(second.pending).toBe(false);
    const before = timeline.mock.calls.length;
    await reader.read(request);
    expect(timeline).toHaveBeenCalledTimes(before);
  });

  it("coalesces concurrent callers and retries a failed lookup", async () => {
    let resolve!: (value: TimelinePage) => void;
    const timeline = vi.fn(() => new Promise<TimelinePage>((done) => { resolve = done; }));
    const reader = new TimestampReader(timeline);
    const request = { threadId: "thr_a", rowIds: ["thr_a:one"] };
    const first = reader.read(request);
    const second = reader.read(request);
    expect(timeline).toHaveBeenCalledTimes(1);
    resolve(page(["thr_a:one"], null));
    expect((await first).messages).toEqual((await second).messages);

    const retry = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(page(["thr_a:one"], null));
    const retryReader = new TimestampReader(retry);
    await expect(retryReader.read(request)).rejects.toThrow("offline");
    expect((await retryReader.read(request)).messages).toHaveLength(1);
  });

  it("refetches newly appearing messages after the cooldown and negatively caches absent ones", async () => {
    let now = 100;
    const timeline = vi.fn()
      .mockResolvedValueOnce(page(["thr_a:one"], null))
      .mockResolvedValueOnce(page(["thr_a:one", "thr_a:two"], null));
    const reader = new TimestampReader(timeline, () => now);
    await reader.read({ threadId: "thr_a", rowIds: ["thr_a:one"] });
    expect((await reader.read({ threadId: "thr_a", rowIds: ["thr_a:two"] })).pending).toBe(true);
    now += 2_001;
    expect((await reader.read({ threadId: "thr_a", rowIds: ["thr_a:two"] })).messages).toHaveLength(1);
    const absentReader = new TimestampReader(async () => page([], null), () => now);
    expect((await absentReader.read({ threadId: "thr_a", rowIds: ["thr_a:absent"] })).unavailableIds).toEqual(["thr_a:absent"]);
  });

  it("detects a stuck older cursor and bounds per-thread cache count", async () => {
    const stuck = new TimestampReader(async () => page([], 5));
    await expect(stuck.read({ threadId: "thr_a", rowIds: ["thr_a:old"] })).rejects.toThrow("cursor did not advance");
    const timeline = vi.fn(async () => page([], null));
    const reader = new TimestampReader(timeline, () => 100);
    for (let index = 0; index < 17; index += 1) {
      await reader.read({ threadId: `thr_${index}`, rowIds: [`thr_${index}:one`] });
    }
    await reader.read({ threadId: "thr_0", rowIds: ["thr_0:one"] });
    expect(timeline).toHaveBeenCalledTimes(18);
  });

  it("recovers messages evicted from a very large thread", async () => {
    let now = 100;
    const many = Array.from({ length: 10_010 }, (_, index) => `thr_a:${index}`);
    const timeline = vi.fn(async () => page(many, null));
    const reader = new TimestampReader(timeline, () => now);
    await reader.read({ threadId: "thr_a", rowIds: ["thr_a:10009"] });
    now += 2_001;
    expect((await reader.read({ threadId: "thr_a", rowIds: ["thr_a:0"] })).messages[0]?.id).toBe("thr_a:0");
    expect(timeline).toHaveBeenCalledTimes(2);
  });

  it("does not mark a concurrent caller's new row absent after sharing a cached-only request", async () => {
    let now = 100;
    const timeline = vi.fn()
      .mockResolvedValueOnce(page(["thr_a:one"], null))
      .mockResolvedValueOnce(page(["thr_a:one", "thr_a:two"], null));
    const reader = new TimestampReader(timeline, () => now);
    await reader.read({ threadId: "thr_a", rowIds: ["thr_a:one"] });
    now += 2_001;
    const cached = reader.read({ threadId: "thr_a", rowIds: ["thr_a:one"] });
    const fresh = reader.read({ threadId: "thr_a", rowIds: ["thr_a:two"] });
    await cached;
    expect((await fresh).messages.map((entry) => entry.id)).toEqual(["thr_a:two"]);
    expect(timeline).toHaveBeenCalledTimes(2);
  });
});
