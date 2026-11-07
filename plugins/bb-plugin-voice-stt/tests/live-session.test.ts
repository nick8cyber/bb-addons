import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO_STREAM_END_MESSAGE, audioMessage } from "../src/gemini-live.js";
import { LiveGeminiSession } from "../src/live-session.js";
import { FakeWebSocket } from "./helpers.js";

const API_KEY = "AIzaSyDummyTestKey0000000000000000000";

const makeSession = (over: Partial<ConstructorParameters<typeof LiveGeminiSession>[0]> = {}) =>
  new LiveGeminiSession({
    apiKey: API_KEY,
    model: "gemini-3.5-transcribe-live",
    language: null,
    vocabulary: [],
    wsFactory: FakeWebSocket.factory,
    ...over,
  });

const chunk = (fill = 1): Buffer => Buffer.alloc(3200, fill);

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LiveGeminiSession (§4.3, §4.4, §9)", () => {
  it("buffers pushes before setupComplete and flushes them in order", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    session.push(chunk(1));
    session.push(chunk(2));
    ws.simulateOpen();
    expect(ws.sentFrames()).toHaveLength(1); // только setup
    ws.simulateMessage({ setupComplete: {} });
    const frames = ws.sentFrames() as Array<Record<string, { audio?: { data?: string } }>>;
    expect(frames).toHaveLength(3); // setup + 2 аудио
    expect(frames[1]).toEqual(JSON.parse(audioMessage(chunk(1))));
    expect(frames[2]).toEqual(JSON.parse(audioMessage(chunk(2))));
    session.cancel();
  });

  it("sends audioStreamEnd strictly after the last audio chunk (§4.2)", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    session.push(chunk(9));
    const done = session.end();
    const sent = ws.sent;
    expect(sent[sent.length - 1]).toBe(AUDIO_STREAM_END_MESSAGE);
    expect(sent[sent.length - 2]).toBe(audioMessage(chunk(9)));
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(done).resolves.toBe("");
  });

  it("ignores pushes after end", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    const done = session.end();
    session.push(chunk(5));
    expect(ws.sent[ws.sent.length - 1]).toBe(AUDIO_STREAM_END_MESSAGE);
    await vi.advanceTimersByTimeAsync(1_100);
    await done;
  });

  it("end before setupComplete is legal: drains buffer, then streamEnd", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    session.push(chunk(3));
    const done = session.end(); // end до ready — легально (§4.2)
    ws.simulateMessage({ setupComplete: {} });
    const sent = ws.sent;
    expect(sent[sent.length - 1]).toBe(AUDIO_STREAM_END_MESSAGE);
    expect(sent[sent.length - 2]).toBe(audioMessage(chunk(3)));
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(done).resolves.toBe("");
  });

  it("resolves the final transcript on settle (§4.4: 0.8/1.0)", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    ws.simulateMessage({ serverContent: { inputTranscription: { text: "привет" } } });
    const done = session.end();
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(done).resolves.toBe("привет");
  });

  it("turnComplete after our streamEnd resolves immediately (§4.4)", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    ws.simulateMessage({ serverContent: { inputTranscription: { text: "текст" } } });
    const done = session.end();
    ws.simulateMessage({ serverContent: { turnComplete: true } });
    await expect(done).resolves.toBe("текст");
  });

  it("cap 6 s fails the stage when transcript keeps arriving (§4.4)", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    const done = session.end();
    const assertion = expect(done).rejects.toThrow(/still arriving/);
    // Интеримы каждые ~900 мс: sinceLast не дотягивает до 1.0 c settle,
    // но sinceEnd пересекает кап 6.0 c → провал стадии.
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(900);
      ws.simulateMessage({ serverContent: { interimInputTranscription: { text: `…${i}` } } });
    }
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("fresh activity resets the settle window but not the cap", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    ws.simulateMessage({ serverContent: { inputTranscription: { text: "а" } } });
    const done = session.end();
    await vi.advanceTimersByTimeAsync(700);
    ws.simulateMessage({ serverContent: { inputTranscription: { text: "а б" } } });
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(done).resolves.toBe("а б");
  });

  it("forwards interims via onInterim with the accumulated text", async () => {
    const interims: string[] = [];
    const session = makeSession({ onInterim: (t) => interims.push(t) });
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    ws.simulateMessage({ serverContent: { interimInputTranscription: { text: "раз" } } });
    ws.simulateMessage({ serverContent: { inputTranscription: { text: "раз два" } } });
    expect(interims).toEqual(["раз", "раз два"]);
    session.cancel();
  });

  it("emits ready via onSetupComplete", () => {
    let ready = false;
    const session = makeSession({ onSetupComplete: () => (ready = true) });
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    expect(ready).toBe(true);
    session.cancel();
  });

  it("rejects end() on pre-setup socket refusal and fires onFailure once", async () => {
    const failures: string[] = [];
    const session = makeSession({ onFailure: (f) => failures.push(f.detailCode) });
    session.open();
    const ws = FakeWebSocket.latest();
    const done = session.end();
    const assertion = expect(done).rejects.toThrow(/Check the transcription API key/);
    ws.simulateClose(1006, "upgrade refused");
    await assertion;
    expect(failures).toEqual(["gemini_live_socket"]);
  });

  it("setup timeout rejects end()", async () => {
    const session = makeSession({ setupTimeoutMs: 5_000 });
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    const done = session.end();
    const assertion = expect(done).rejects.toThrow(/setup timed out/);
    await vi.advanceTimersByTimeAsync(5_100);
    await assertion;
  });

  it("cancel ends the session without a transcript", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    const done = session.end();
    const assertion = expect(done).rejects.toThrow(/cancelled/);
    session.cancel();
    await assertion;
    expect(ws.closed).toBe(true);
  });

  it("no api key value leaks into frames or failures", async () => {
    const session = makeSession();
    session.open();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    const done = session.end();
    ws.simulateMessage({ error: { message: `bad key ${API_KEY}` } });
    try {
      await done;
      expect.unreachable("end() must reject on a Gemini error frame");
    } catch (e) {
      expect(String(e)).not.toContain(API_KEY);
    }
    expect(ws.sent.every((f) => !f.includes(API_KEY))).toBe(true);
  });
});
