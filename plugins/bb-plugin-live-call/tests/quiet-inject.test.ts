/** Вставки в голос (результаты помощника, события) не обрывают ответ: уходят только после turnComplete. */
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
    callId: "call_q", keys: ["k1", "k2"], voice: "Algenib", languageCode: "ru-RU", thinkingLevel: "LOW",
    mode: "normal", routerInput: "text", maxCallMinutes: 60, store, sdk: {} as never,
    toBrowser: () => {}, sendBrowserAudio: () => {},
    spawnCallThread: async () => null, advanceCallThread: async () => {}, sayCallThread: async () => {}, endCallThread: async () => {},
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
  });
  return { s, store };
}

describe("injectWhenQuiet", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("пока голос говорит — вставка ждёт; после turnComplete уходит одним пакетом", async () => {
    const { s, store } = make();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    const before = clientContents(ws).length;
    // голос начал отвечать
    ws.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: btoa("\x00\x01\x02\x03") } }] } } });
    s.injectWhenQuiet("[СИСТЕМА] инструмент list_threads: ...");
    s.injectWhenQuiet("[СОБЫТИЕ] thread.idle ...");
    expect(clientContents(ws).length).toBe(before); // ничего не ушло посреди ответа
    ws.server({ serverContent: { turnComplete: true } });
    const after = clientContents(ws);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toContain("list_threads");
    expect(after.at(-1)).toContain("thread.idle");
    const injected = store.transcript("call_q").filter((e) => e.kind === "system_injected");
    expect(JSON.parse(injected.at(-1)!.payload).waited).toBe(true);
    await s.end("owner");
  });

  it("голос молчит — вставка уходит сразу", async () => {
    const { s } = make();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    const before = clientContents(ws).length;
    s.injectWhenQuiet("[СИСТЕМА] что-то");
    expect(clientContents(ws).length).toBe(before + 1);
    await s.end("owner");
  });
});

describe("память голосового агента", () => {
  it("addMemory без дублей, listMemory — новые сверху", () => {
    const store = new CallStore(new Database(":memory:"));
    expect(store.addMemory("Называть треды по названию").duplicate).toBe(false);
    expect(store.addMemory("  Называть треды по названию ").duplicate).toBe(true);
    store.addMemory("Отвечать коротко");
    expect(store.listMemory().map((m) => m.text)).toEqual(["Отвечать коротко", "Называть треды по названию"]);
  });
});

describe("подтверждение кнопкой раньше вопроса (живая проверка 03.11)", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("после approve голос получает «вопрос уже решён», карточка — итог, а не вопрос", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const store = new CallStore(new Database(":memory:"));
    const s = new CallSession({
      callId: "call_cf", keys: ["k1"], voice: "Algenib", languageCode: "ru-RU", thinkingLevel: "LOW",
      mode: "normal", routerInput: "text", maxCallMinutes: 60, store, sdk: {} as never,
      toBrowser: (f) => frames.push(f as never), sendBrowserAudio: () => {},
      spawnCallThread: async () => null, advanceCallThread: async () => {}, sayCallThread: async () => {}, endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    ws.server({ toolCall: { functionCalls: [{ id: "f1", name: "remember", args: { text: "тест" } }] } });
    await vi.advanceTimersByTimeAsync(50);
    const conf = frames.find((f) => f.type === "confirmation") as { confirmationId: string } | undefined;
    expect(conf).toBeTruthy();
    s.decideConfirmation(conf!.confirmationId, "approve");
    await vi.advanceTimersByTimeAsync(50);
    ws.server({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(50);
    const injected = clientContents(ws).join("\n");
    expect(injected).toContain("НЕ задавай его снова");
    const doneCard = frames.filter((f) => f.type === "action" && f.tool === "remember" && f.status === "done").at(-1) as { summary: string } | undefined;
    expect(doneCard?.summary).not.toMatch(/Скажи «да»/);
    await s.end("owner");
  });
});

describe("состояние после ответа (аудит PLUG-108)", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const st = (s: unknown) => (s as { state: string }).state;
  const audio = btoa("\x00\x01".repeat(24000)); // 48000 байт = 1 с звука

  it("со звуком: после turnComplete приглушение держится, пока браузер не доиграл (эхо)", async () => {
    const { s } = make();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    ws.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] } } });
    expect(st(s)).toBe("speaking");
    ws.server({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(10);
    expect(st(s)).toBe("speaking");
    s.onPlaybackDrained((s as unknown as { lastAudioTurnSeq: number }).lastAudioTurnSeq);
    expect(st(s)).toBe("listening");
    await s.end("owner");
  });

  it("со звуком, но без playback_drained: запасной таймер по длине звука возвращает «listening»", async () => {
    const { s } = make();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    ws.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] } } });
    ws.server({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(st(s)).toBe("speaking");
    await vi.advanceTimersByTimeAsync(2000);
    expect(st(s)).toBe("listening");
    await s.end("owner");
  });

  it("браузер доиграл раньше turnComplete (настоящий turnSeq) → «listening» сразу, без запасного таймера", async () => {
    const { s } = make();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    ws.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audio } }] } } });
    const seq = (s as unknown as { lastAudioTurnSeq: number }).lastAudioTurnSeq;
    expect(typeof seq).toBe("number");
    s.onPlaybackDrained(seq);
    expect(st(s)).toBe("speaking"); // голос ещё в ходе — переход ждёт turnComplete
    ws.server({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(10);
    expect(st(s)).toBe("listening");
    await s.end("owner");
  });

  it("без звука (ответ текстом): «listening» сразу после turnComplete", async () => {
    const { s } = make();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    (s as unknown as { setState(x: string): void }).setState("speaking");
    ws.server({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(10);
    expect(st(s)).toBe("listening");
    await s.end("owner");
  });
});

describe("«Отмена» кнопкой на уровне сессии (аудит PLUG-108)", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("ожидание снято, модель получает отмену один раз, следующая запись снова спрашивает подтверждение", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const store = new CallStore(new Database(":memory:"));
    const s = new CallSession({
      callId: "call_cx", keys: ["k1"], voice: "Algenib", languageCode: "ru-RU", thinkingLevel: "LOW",
      mode: "normal", routerInput: "text", maxCallMinutes: 60, store, sdk: {} as never,
      toBrowser: (f) => frames.push(f as never), sendBrowserAudio: () => {},
      spawnCallThread: async () => null, advanceCallThread: async () => {}, sayCallThread: async () => {}, endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    ws.server({ toolCall: { functionCalls: [{ id: "f1", name: "remember", args: { text: "раз" } }] } });
    await vi.advanceTimersByTimeAsync(50);
    const c1 = frames.filter((f) => f.type === "confirmation").at(-1) as { confirmationId: string };
    s.decideConfirmation(c1.confirmationId, "cancel");
    await vi.advanceTimersByTimeAsync(50);
    ws.server({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(50);
    expect((s as unknown as { gate: { pendingConfirmation(): unknown } }).gate.pendingConfirmation()).toBeNull();
    const cancels = clientContents(ws).filter((x) => x.includes("отменил"));
    expect(cancels.length).toBe(1);
    ws.server({ toolCall: { functionCalls: [{ id: "f2", name: "remember", args: { text: "два" } }] } });
    await vi.advanceTimersByTimeAsync(50);
    expect(frames.filter((f) => f.type === "confirmation").length).toBe(2);
    await s.end("owner");
  });
});
