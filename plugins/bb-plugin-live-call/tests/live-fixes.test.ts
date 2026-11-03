import { describe, expect, it, vi } from "vitest";
import { LiveClient } from "../src/live-client.js";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import Database from "better-sqlite3";

class MockWs {
  sent: string[] = [];
  listeners: Record<string, Array<(ev: unknown) => void>> = {};
  readyState = 1;

  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    for (const fn of this.listeners["close"] ?? []) fn({ code: 1000, reason: "" });
  }
  fire(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

describe("исправления из ветки агента на Gemini (§12.10 п. 5)", () => {
  it("goAway.timeLeft разбирается из строки вида «50s» и из числа", () => {
    let wsInstance: MockWs | null = null;
    const client = new LiveClient({
      key: "fake_key",
      model: "gemini-3.8-live",
      voice: "Algenib",
      languageCode: "ru-RU",
      systemInstruction: "test",
      wsFactory: () => {
        wsInstance = new MockWs();
        return wsInstance as unknown as WebSocket;
      },
    });

    client.connect();

    const receivedTimes: number[] = [];
    client.on("goAway", (timeLeft) => {
      receivedTimes.push(timeLeft);
    });

    // 1. Строка вида "50s"
    wsInstance!.fire("message", { data: JSON.stringify({ goAway: { timeLeft: "50s" } }) });
    expect(receivedTimes[0]).toBe(50);

    // 2. Число 25
    wsInstance!.fire("message", { data: JSON.stringify({ goAway: { timeLeft: 25 } }) });
    expect(receivedTimes[1]).toBe(25);
  });

  it("sendToolResponse содержит name в functionResponses", () => {
    let wsInstance: MockWs | null = null;
    const client = new LiveClient({
      key: "fake_key",
      model: "gemini-3.8-live",
      voice: "Algenib",
      languageCode: "ru-RU",
      systemInstruction: "test",
      wsFactory: () => {
        wsInstance = new MockWs();
        return wsInstance as unknown as WebSocket;
      },
    });

    client.connect();
    client.sendToolResponse("call_123", { ok: true }, "WHEN_IDLE", "thread_send");

    expect(wsInstance!.sent).toHaveLength(1);
    const sent = JSON.parse(wsInstance!.sent[0]);
    expect(sent.toolResponse.functionResponses[0]).toEqual({
      id: "call_123",
      name: "thread_send",
      response: { ok: true },
      scheduling: "WHEN_IDLE",
    });
  });

  it("end() гасит таймер переподключения и таймер реплики, переподключение после конца невозможно", async () => {
    vi.useFakeTimers();
    const store = new CallStore(new Database(":memory:"));
    let wsCreated = 0;
    const session = new CallSession({
      callId: "call_test_end",
      keys: ["k1", "k2"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: {} as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: () => {
        wsCreated++;
        return new MockWs() as unknown as WebSocket;
      },
    });

    await session.start();
    expect(wsCreated).toBe(1);

    // Вызываем end()
    await session.end("owner");

    // Пытаемся запустить таймеры или события, которые могли бы переподключить сессию
    await vi.advanceTimersByTimeAsync(15000);

    // Новых сокетов создано быть не должно
    expect(wsCreated).toBe(1);
    expect(session.state).toBe("ended");
    vi.useRealTimers();
  });
});
