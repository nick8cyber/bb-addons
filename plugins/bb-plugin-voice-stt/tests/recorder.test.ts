import type { CaptureEvent, RecordedAudio } from "../src/ui/capture.js";
import { describe, expect, it } from "vitest";
import {
  createVoiceRecorder,
  type ComposerTarget,
  type RecorderDeps,
  type RecorderSock,
} from "../src/ui/recorder.js";
import type { MicCaptureLike } from "../src/ui/capture.js";

class FakeSock implements RecorderSock {
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  simulateMessage(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  simulateClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === "string").map((s) => JSON.parse(s));
  }
  binary(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== "string");
  }
}

class FakeCapture implements MicCaptureLike {
  unlocked = 0;
  started = 0;
  stopped = 0;
  /** Имитация pending getUserMedia — start ждёт, пока тест отопрёт гейт. */
  gate: Promise<void> | null = null;
  private cb: ((pcm: Uint8Array, level: number) => void) | null = null;
  unlock(): void {
    this.unlocked += 1;
  }
  /** Тёплый микрофон: сколько чанков «до нажатия» отдать синхронно внутри start. */
  syncEmit = 0;
  private ev: ((e: CaptureEvent) => void) | null = null;
  recorderMode = false;
  recording: RecordedAudio | null = null;
  async start(
    onChunk: (pcm: Uint8Array, level: number) => void,
    onEvent?: (e: CaptureEvent) => void,
  ): Promise<void> {
    this.started += 1;
    this.cb = onChunk;
    this.ev = onEvent ?? null;
    for (let i = 0; i < this.syncEmit; i++) onChunk(new Uint8Array(1600).fill(2), 0);
    if (this.gate !== null) await this.gate;
  }
  stop(): void {
    this.stopped += 1;
    this.cb = null;
  }
  parked = 0;
  park(): void {
    // Тёплый микрофон: в запись больше не пишем (как у MicCapture).
    this.parked += 1;
    this.cb = null;
  }
  /** Web Audio замолчал → запасной режим MediaRecorder. */
  fireFallback(): void {
    this.recorderMode = true;
    this.ev?.({ kind: "fallback", info: "recorder audio/mp4; test" });
  }
  isRecorderMode(): boolean {
    return this.recorderMode;
  }
  async finishRecording(): Promise<RecordedAudio | null> {
    return this.recording;
  }
  emit(bytes = 3200): void {
    this.cb?.(new Uint8Array(bytes).fill(1), 0.5);
  }
}

class FakeComposer implements ComposerTarget {
  readonly key = "composer-1";
  inserted: Array<{ text: string; at?: string }> = [];
  focused = 0;
  insert(text: string, options?: { at?: "cursor" | "end" }): void {
    this.inserted.push({ text, at: options?.at });
  }
  focus(): void {
    this.focused += 1;
  }
}

function makeRecorder(over: Partial<RecorderDeps> = {}) {
  const socks: FakeSock[] = [];
  const rpcCalls: Array<{ method: string; input: object }> = [];
  const capture = new FakeCapture();
  const responses: Record<string, unknown> = {
    liveToken: { token: "tok-1" },
    liveFallback: { ok: true, text: "фоллбэк", engine: "codex" },
  };
  const deps: RecorderDeps = {
    rpc: async (method, input = {}) => {
      rpcCalls.push({ method, input });
      return responses[method];
    },
    wsFactory: () => {
      const s = new FakeSock();
      socks.push(s);
      return s;
    },
    wsUrl: () => "wss://example.test/live-voice",
    capture,
    holdMs: 40,
    readyTimeoutMs: 300,
    reconnectTimeoutMs: 80,
    listenKeys: false,
    listenPagehide: false,
    ...over,
  };
  return { recorder: createVoiceRecorder(deps), socks, rpcCalls, capture, responses };
}

const flush = async (ms = 2): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

const openWithHello = async (r: ReturnType<typeof makeRecorder>): Promise<FakeSock> => {
  const sock = r.socks[0];
  sock.open();
  await flush();
  return sock;
};

describe("voiceRecorder (§3.3, §9)", () => {
  it("pressStart opens ws, sends hello after liveToken, streams PCM", async () => {
    const r = makeRecorder();
    const composer = new FakeComposer();
    r.recorder.pressStart(composer);
    expect(r.recorder.getSnapshot().phase).toBe("recording");
    expect(r.capture.unlocked).toBe(1); // iOS: синхронно в жесте
    const sock = await openWithHello(r);
    expect(sock.json()[0]).toEqual({ type: "hello", token: "tok-1" });
    r.capture.emit();
    expect(sock.binary()).toHaveLength(1);
    r.recorder.cancel();
  });

  it("tap <400ms toggles: stays recording on release, second press ends", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer(), 1);
    const sock = await openWithHello(r);
    r.recorder.pressEnd({ pointerId: 1 }); // тап — запись продолжается
    expect(r.recorder.getSnapshot().phase).toBe("recording");
    r.recorder.pressStart(new FakeComposer(), 1); // повторное нажатие → end
    expect(r.recorder.getSnapshot().phase).toBe("finishing");
    expect(sock.json().at(-1)).toEqual({ type: "end" });
    r.recorder.cancel();
  });

  it("hold:true (FAB push-to-talk) — release of that pointer ends at once", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer(), 3, { hold: true });
    const sock = await openWithHello(r);
    expect(r.recorder.getSnapshot().holdArmed).toBe(false);
    r.recorder.pressEnd({ pointerId: 9 }); // чужой указатель — не конец
    expect(r.recorder.getSnapshot().phase).toBe("recording");
    r.recorder.pressEnd({ pointerId: 3 });
    expect(r.recorder.getSnapshot().phase).toBe("finishing");
    expect(sock.json().at(-1)).toEqual({ type: "end" });
    r.recorder.cancel();
  });

  it("BLOCKER: stray releases in toggle mode do NOT end the session", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer(), 1);
    await openWithHello(r);
    r.recorder.pressEnd({ pointerId: 1 }); // тап → toggle
    expect(r.recorder.getSnapshot().phase).toBe("recording");
    // Любые отпускания (клик, скролл, выделение, по оверлею) — не конец §3.3.
    r.recorder.pressEnd({ pointerId: 1 });
    r.recorder.pressEnd({ pointerId: 7 });
    r.recorder.pressEnd();
    expect(r.recorder.getSnapshot().phase).toBe("recording");
    r.recorder.cancel();
  });

  it("BLOCKER: command/footer start has no press — releases never end it", async () => {
    const r = makeRecorder();
    r.recorder.toggle(new FakeComposer());
    await openWithHello(r);
    expect(r.recorder.getSnapshot().phase).toBe("recording");
    r.recorder.pressEnd({ pointerId: 1 });
    r.recorder.pressEnd();
    expect(r.recorder.getSnapshot().phase).toBe("recording");
    r.recorder.cancel();
  });

  it("BLOCKER: hold release off-button via window still ends (same pointerId)", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer(), 3);
    const sock = await openWithHello(r);
    await flush(50); // > holdMs — hold-режим
    r.recorder.pressEnd({ pointerId: 3 }); // отпускание того же пальца вне кнопки
    expect(r.recorder.getSnapshot().phase).toBe("finishing");
    expect(sock.json().at(-1)).toEqual({ type: "end" });
    r.recorder.cancel();
  });

  it("hold >400ms: release ends the session", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer(), 1);
    const sock = await openWithHello(r);
    await flush(50); // прошло больше holdMs
    r.recorder.pressEnd({ pointerId: 1 });
    expect(sock.json().at(-1)).toEqual({ type: "end" });
    r.recorder.cancel();
  });

  it("final inserts text at end into the bound composer", async () => {
    const r = makeRecorder();
    const composer = new FakeComposer();
    r.recorder.pressStart(composer);
    const sock = await openWithHello(r);
    r.capture.emit();
    r.recorder.stop();
    sock.simulateMessage({ type: "final", text: "привет мир", engine: "gemini-live" });
    await flush();
    expect(composer.inserted).toEqual([{ text: "привет мир", at: "end" }]);
    expect(composer.focused).toBe(1);
    expect(r.recorder.getSnapshot().inserted).toBe(true);
  });

  it("final with a dead insert keeps text in the overlay (no silent loss)", async () => {
    const r = makeRecorder();
    const composer = new FakeComposer();
    composer.insert = () => {
      throw new Error("composer no longer available");
    };
    r.recorder.pressStart(composer);
    const sock = await openWithHello(r);
    r.recorder.stop();
    sock.simulateMessage({ type: "final", text: "текст", engine: "gemini-live" });
    await flush();
    expect(r.recorder.getSnapshot().finalText).toBe("текст");
    r.recorder.dismiss();
  });

  it("silence final inserts nothing", async () => {
    const r = makeRecorder();
    const composer = new FakeComposer();
    r.recorder.pressStart(composer);
    const sock = await openWithHello(r);
    r.recorder.stop();
    sock.simulateMessage({ type: "final", text: "", engine: "silence" });
    await flush();
    expect(composer.inserted).toHaveLength(0);
    expect(r.recorder.getSnapshot().phase).toBe("done");
  });

  it("repeat presses during finishing are ignored, no new session", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer());
    await openWithHello(r);
    r.recorder.stop();
    r.recorder.pressStart(new FakeComposer());
    r.recorder.pressStart(new FakeComposer());
    expect(r.socks).toHaveLength(1);
    expect(r.recorder.getSnapshot().ignorePulse).toBeGreaterThan(0);
    r.recorder.cancel();
  });

  it("dead socket on release → replay: new session gets hello + all PCM + end", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer());
    const first = await openWithHello(r);
    r.capture.emit();
    first.simulateClose();
    expect(r.recorder.getSnapshot().phase).toBe("reconnecting");
    r.recorder.stop(); // отпускание при мёртвом сокете → реплей
    const second = r.socks[1];
    second.open();
    await flush();
    const frames = second.json();
    expect(frames[0]).toEqual({ type: "hello", token: "tok-1" });
    expect(frames.at(-1)).toEqual({ type: "end" });
    expect(second.binary()).toHaveLength(1); // весь PCM реплеем
    second.simulateMessage({ type: "final", text: "реплей", engine: "gemini-live" });
    await flush();
    expect(r.recorder.getSnapshot().phase).toBe("done");
  });

  it("reconnect failure → WAV → liveFallback rpc", async () => {
    const r = makeRecorder();
    const composer = new FakeComposer();
    r.recorder.pressStart(composer);
    const first = await openWithHello(r);
    first.simulateClose();
    r.recorder.stop();
    // второй сокет не открывается — 80 мс → файловая цепочка
    await flush(120);
    expect(r.rpcCalls.some((c) => c.method === "liveFallback")).toBe(true);
    const fb = r.rpcCalls.find((c) => c.method === "liveFallback");
    expect(typeof (fb?.input as { audioBase64?: string }).audioBase64).toBe("string");
    expect(composer.inserted).toEqual([{ text: "фоллбэк", at: "end" }]);
  });

  it("micLive turns on with the first mic chunk (card: «включаю микрофон» → «говорите»)", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer(), 1);
    await openWithHello(r);
    expect(r.recorder.getSnapshot().micLive).toBe(false);
    r.capture.emit();
    expect(r.recorder.getSnapshot().micLive).toBe(true);
    r.recorder.cancel();
    expect(r.recorder.getSnapshot().micLive).toBe(false);
  });

  it("pre-roll: prime на касании поднимает микрофон, звук до старта уходит в запись", async () => {
    const r = makeRecorder();
    r.recorder.prime();
    expect(r.capture.started).toBe(1);
    expect(r.socks).toHaveLength(0); // сокет — только после решения «тап/удержание»
    r.capture.emit(3200);
    r.capture.emit(3200);
    expect(r.recorder.getSnapshot().phase).toBe("idle");
    r.recorder.pressStart(new FakeComposer(), 1, { hold: true });
    expect(r.capture.started).toBe(1); // повторно микрофон не поднимаем
    expect(r.recorder.getSnapshot().micLive).toBe(true);
    const sock = await openWithHello(r);
    expect(sock.binary()).toHaveLength(2); // pre-roll ушёл сразу после hello
    r.capture.emit();
    expect(sock.binary()).toHaveLength(3);
    r.recorder.cancel();
  });

  it("pre-roll: перенос (unprime) отцепляет микрофон (тёплый), звук никуда не уходит", async () => {
    const r = makeRecorder();
    r.recorder.prime();
    r.capture.emit();
    r.recorder.unprime();
    expect(r.capture.parked).toBe(1);
    r.recorder.pressStart(new FakeComposer(), 1);
    expect(r.capture.started).toBe(2); // новая запись — новый захват, без старого pre-roll
    const sock = await openWithHello(r);
    expect(sock.binary()).toHaveLength(0);
    r.recorder.cancel();
  });

  it("тёплый микрофон: конец записи паркует захват; warm=0 и releaseMic — выключают", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer(), 1);
    await openWithHello(r);
    r.recorder.stop();
    expect(r.capture.parked).toBeGreaterThanOrEqual(1);
    expect(r.capture.stopped).toBe(0);
    r.recorder.cancel();
    const before = r.capture.stopped;
    r.recorder.setWarmMs(0);
    expect(r.capture.stopped).toBe(before + 1);
    r.recorder.releaseMic();
    expect(r.capture.stopped).toBe(before + 2);
  });

  it("тёплый микрофон: кольцо «до нажатия», отданное синхронно в start, попадает в запись", async () => {
    const r = makeRecorder();
    r.capture.syncEmit = 3;
    r.recorder.prime();
    r.recorder.pressStart(new FakeComposer(), 1, { hold: true });
    expect(r.recorder.getSnapshot().micLive).toBe(true);
    const sock = await openWithHello(r);
    expect(sock.binary()).toHaveLength(3);
    r.recorder.cancel();
  });

  it("запасной режим: Web Audio молчит → сессия отменена, файл MediaRecorder → liveFallback → вставка", async () => {
    const r = makeRecorder();
    const composer = new FakeComposer();
    r.recorder.pressStart(composer, 1);
    const sock = await openWithHello(r);
    r.capture.fireFallback();
    expect(sock.json().at(-1)).toMatchObject({ type: "cancel" });
    expect(r.recorder.getSnapshot().micLive).toBe(true);
    expect(r.recorder.getSnapshot().notice).toContain("распознаю после записи");
    r.capture.recording = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mp4", filename: "live-dictation.m4a" };
    r.recorder.stop();
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));
    const call = r.rpcCalls.find((c) => c.method === "liveFallback");
    expect(call?.input).toMatchObject({ mimeType: "audio/mp4", filename: "live-dictation.m4a" });
    expect(composer.inserted.at(-1)?.text).toBe("фоллбэк");
  });

  it("нажатие, пока висит плашка результата, закрывает её и сразу начинает новую запись", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer(), 1);
    const sock = await openWithHello(r);
    r.recorder.stop();
    sock.simulateMessage({ type: "final", text: "", engine: "silence" });
    expect(r.recorder.getSnapshot().phase).toBe("done");
    r.recorder.pressStart(new FakeComposer(), 2);
    expect(r.recorder.getSnapshot().phase).toBe("recording");
    r.recorder.cancel();
  });

  it("cancel sends cancel and never inserts", async () => {
    const r = makeRecorder();
    const composer = new FakeComposer();
    r.recorder.pressStart(composer);
    const sock = await openWithHello(r);
    r.recorder.cancel();
    expect(sock.json().at(-1)).toEqual({ type: "cancel", reason: "user" });
    expect(r.recorder.getSnapshot().phase).toBe("idle");
    expect(composer.inserted).toHaveLength(0);
  });

  it("second start after cancel creates a fresh session, target rebinds", async () => {
    const r = makeRecorder();
    const c1 = new FakeComposer();
    const c2 = new FakeComposer();
    r.recorder.pressStart(c1);
    await openWithHello(r);
    r.recorder.cancel();
    r.recorder.pressStart(c2);
    const second = r.socks[1];
    second.open();
    await flush();
    second.simulateMessage({ type: "ready" });
    r.recorder.stop();
    second.simulateMessage({ type: "final", text: "два", engine: "gemini-live" });
    await flush();
    expect(c1.inserted).toHaveLength(0);
    expect(c2.inserted).toEqual([{ text: "два", at: "end" }]);
  });

  it("BLOCKER: cancel during pending getUserMedia — later chunks never flow", async () => {
    const capture = new FakeCapture();
    let openGate: (() => void) | undefined;
    capture.gate = new Promise<void>((res) => {
      openGate = res;
    });
    const r = makeRecorder({ capture });
    r.recorder.pressStart(new FakeComposer(), 1);
    const sock = await openWithHello(r);
    // getUserMedia ещё pending — отменяем; потом старт «оживает».
    r.recorder.cancel();
    openGate?.();
    await flush();
    capture.emit();
    expect(sock.binary()).toHaveLength(0);
    expect(r.recorder.getSnapshot().phase).toBe("idle");
  });

  it("BLOCKER: stale done-dismiss timer does not kill the next session", async () => {
    const r = makeRecorder({ doneDismissMs: 30 });
    const composer = new FakeComposer();
    r.recorder.pressStart(composer, 1);
    const first = await openWithHello(r);
    r.recorder.stop();
    first.simulateMessage({ type: "final", text: "раз", engine: "gemini-live" });
    await flush();
    expect(r.recorder.getSnapshot().phase).toBe("done");
    r.recorder.dismiss(); // таймер обязан умереть здесь, не в сессии ниже
    r.recorder.pressStart(composer, 1);
    const second = r.socks[1];
    second.open();
    await flush(50); // > doneDismissMs — протухший таймер сработал бы
    expect(r.recorder.getSnapshot().phase).toBe("recording");
    r.recorder.cancel();
  });

  it("BLOCKER: server error during finishing → client WAV fallback", async () => {
    const r = makeRecorder();
    const composer = new FakeComposer();
    r.recorder.pressStart(composer, 1);
    const sock = await openWithHello(r);
    r.capture.emit();
    r.recorder.stop();
    sock.simulateMessage({ type: "error", code: "service_unavailable", message: "gemini died" });
    await flush();
    expect(r.rpcCalls.some((c) => c.method === "liveFallback")).toBe(true);
    expect(composer.inserted).toEqual([{ text: "фоллбэк", at: "end" }]);
  });

  it("BLOCKER: replay retries on 4009, second attempt lands the session", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer(), 1);
    const first = await openWithHello(r);
    first.simulateClose();
    r.recorder.stop();
    const second = r.socks[1];
    second.open();
    await flush();
    second.simulateClose(4009); // сервер ещё не снёс старое соединение
    await flush(300); // ретрай ~250 мс
    const third = r.socks[2];
    third.open();
    await flush();
    expect(third.json()[0]).toEqual({ type: "hello", token: "tok-1" });
    expect(third.json().at(-1)).toEqual({ type: "end" });
    r.recorder.cancel();
  });

  it("REMARK: cancel during in-flight liveFallback does not insert", async () => {
    const r = makeRecorder();
    const composer = new FakeComposer();
    let resolveFallback: ((v: unknown) => void) | undefined;
    r.responses.liveFallback = new Promise((res) => {
      resolveFallback = res;
    });
    r.recorder.pressStart(composer, 1);
    const first = await openWithHello(r);
    first.simulateClose();
    r.recorder.stop();
    await flush(120); // reconnectTimeout прошёл — liveFallback в полёте
    r.recorder.cancel();
    resolveFallback?.({ ok: true, text: "поздний текст", engine: "codex" });
    await flush();
    expect(composer.inserted).toHaveLength(0);
    expect(r.recorder.getSnapshot().phase).toBe("idle");
  });

  it("token stays inside the hello frame only", async () => {
    const r = makeRecorder();
    r.recorder.pressStart(new FakeComposer());
    const sock = await openWithHello(r);
    r.capture.emit();
    r.recorder.stop();
    sock.simulateMessage({ type: "final", text: "x", engine: "gemini-live" });
    await flush();
    const hello = sock.sent.filter((d): d is string => typeof d === "string" && d.includes("tok-1"));
    expect(hello).toHaveLength(1);
    expect(hello[0]).toContain('"type":"hello"');
  });
});
