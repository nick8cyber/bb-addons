/** Утечки сессий Gemini: после переподключения и смены ключа в Extended — ровно две, после конца — ноль. */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";

const sockets: FakeWs[] = [];
class FakeWs {
  readyState = 0;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(public url: string) {
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.fire("open", {});
    }, 0);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send() {}
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  fire(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}
const openCount = () => sockets.filter((s) => s.readyState !== 3).length;

function makeSession() {
  return new CallSession({
    callId: "call_test",
    keys: ["k1", "k2"],
    voice: "Algenib",
    languageCode: "ru-RU",
    thinkingLevel: "LOW",
    mode: "extended",
    routerInput: "text",
    maxCallMinutes: 60,
    store: new CallStore(new Database(":memory:")),
    sdk: {} as never,
    toBrowser: () => {},
    sendBrowserAudio: () => {},
    spawnCallThread: async () => null,
    advanceCallThread: async () => {},
    sayCallThread: async () => {},
    endCallThread: async () => {},
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
  });
}

describe("сессии Gemini не утекают", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("Extended: старт — 2, переподключение голоса — 2, смена ключа — 2, конец — 0", async () => {
    const s = makeSession();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(openCount()).toBe(2);

    // Google закрыл голос (goAway/обрыв) — переподключается только голос.
    (s as unknown as { reconnectVoice(t: number): Promise<void> }).reconnectVoice(0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(openCount()).toBe(2);
    expect(sockets.length).toBe(3);

    // Смена ключа по квоте: обе сессии пересоздаются, старые закрыты.
    (s as unknown as { switchKeyOnQuota(r: string): void }).switchKeyOnQuota("quota");
    await vi.advanceTimersByTimeAsync(10);
    expect(openCount()).toBe(2);

    await s.end("owner");
    await vi.advanceTimersByTimeAsync(10);
    expect(openCount()).toBe(0);
  });

  it("смена режима Extended → Быстрый: 1 сессия, обратно — 2, без сирот", async () => {
    const s = makeSession();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    await s.switchMode("normal");
    await vi.advanceTimersByTimeAsync(10);
    expect(openCount()).toBe(1);
    await s.switchMode("extended");
    await vi.advanceTimersByTimeAsync(10);
    expect(openCount()).toBe(2);
    await s.end("owner");
    await vi.advanceTimersByTimeAsync(10);
    expect(openCount()).toBe(0);
  });
});
