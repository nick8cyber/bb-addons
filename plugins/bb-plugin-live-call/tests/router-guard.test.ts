/** Пока ждём ответа на подтверждение, ROUTER не слышит владельца: «да»/«запускай» не должны стать новой командой. */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(public url: string) {
    FakeWs.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.fire("open", {});
    }, 0);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "" });
  }
  fire(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  server(msg: unknown) {
    this.fire("message", { data: JSON.stringify(msg) });
  }
}
const clientContents = (ws: FakeWs) => ws.sent.filter((s) => s.includes('"clientContent"') && s.includes('"turnComplete":true'));

function make(store = new CallStore(new Database(":memory:"))) {
  const s = new CallSession({
    callId: "call_g", keys: ["k1", "k2"], voice: "Algenib", languageCode: "ru-RU", thinkingLevel: "LOW",
    mode: "extended", routerInput: "text", maxCallMinutes: 60, store, sdk: {} as never,
    toBrowser: () => {}, sendBrowserAudio: () => {},
    spawnCallThread: async () => null, advanceCallThread: async () => {}, sayCallThread: async () => {}, endCallThread: async () => {},
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
  });
  return { s, store };
}

describe("routerMayHearOwner", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("pending-подтверждение — реплика владельца в ROUTER не уходит; без него — уходит", async () => {
    const { s } = make();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const anyS = s as unknown as { router: { sendRealtimeText: (t: string) => void }; gate: { pendingConfirmation: () => unknown } };
    expect(anyS.router).toBeTruthy();
    const sent: string[] = [];
    anyS.router.sendRealtimeText = (t: string) => void sent.push(t);

    const real = anyS.gate.pendingConfirmation.bind(anyS.gate);
    anyS.gate.pendingConfirmation = () => ({ actionId: "a1" });
    s.onOwnerUtteranceFinal("запускай");
    expect(sent).toEqual([]);

    anyS.gate.pendingConfirmation = real;
    s.onOwnerUtteranceFinal("что в проекте BB?");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("Владелец: что в проекте BB?");
    await s.end("owner");
  });

  it("повторный вызов инструмента после approved отклоняется сервером и не исполняется дважды (§12.10.5)", async () => {
    let executeCount = 0;
    const { DEFAULT_WORDS } = await import("../src/classify.js");
    const { ConfirmationGate } = await import("../src/confirmation-gate.js");
    const { runToolCall } = await import("../src/tools.js");
    const fakeTool = {
      name: "test_action",
      cls: "L" as const,
      word: "запускай",
      description: "Тестовое действие",
      parameters: { type: "object", properties: { p: { type: "string" } } },
      execute: async () => {
        executeCount++;
        return { ok: true as const, data: { done: true } };
      },
    };
    const gate = new ConfirmationGate(DEFAULT_WORDS);

    // Первый вызов — требует подтверждения
    const r1 = await runToolCall(fakeTool, { p: "val" }, "call_1", {
      sdk: {} as never,
      gate,
      ledger: {} as never,
      reportAction: () => {},
      callsProjectId: () => null,
    });
    expect(r1.result.ok).toBe(false);
    expect("needsConfirmation" in r1.result && r1.result.needsConfirmation).toBeTruthy();

    // Одобряем подтверждение
    const p = gate.pendingConfirmation()!;
    gate.decide(p.confirmationId, "approve");
    expect(p.verdict).toBe("approved");

    // Модель повторно шлёт toolCall: runToolCall должен вернуть already_running и НЕ вызывать execute
    const r2 = await runToolCall(fakeTool, { p: "val" }, "call_1", {
      sdk: {} as never,
      gate,
      ledger: {} as never,
      reportAction: () => {},
      callsProjectId: () => null,
    });
    expect(r2.result.ok).toBe(false);
    expect("error" in r2.result && r2.result.error.code).toBe("already_running");
    expect(r2.executed).toBe(false);
    expect(executeCount).toBe(0);
  });
});
