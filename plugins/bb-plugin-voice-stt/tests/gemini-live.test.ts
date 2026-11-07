import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiServiceFailure,
  maskKeyParam,
  maskSecretValue,
} from "../src/contract.js";
import {
  AUDIO_STREAM_END_MESSAGE,
  audioMessage,
  normalizedModelPath,
  parseServerFrame,
  setupMessage,
  socketUrl,
  transcribeGeminiLive,
  vocabularyTerms,
} from "../src/gemini-live.js";
import { FakeWebSocket } from "./helpers.js";

const API_KEY = "AIzaSyDummyTestKey0000000000000000000";

const baseOptions = () => ({
  apiKey: API_KEY,
  model: "gemini-3.5-transcribe-live",
  pcm: Buffer.alloc(9600, 1), // ~300 мс PCM16 16 кГц → 3 чанка по 3200 байт
  language: null as string | null,
  hint: null as string | null,
  timeoutMs: 12_000,
  wsFactory: FakeWebSocket.factory,
});

describe("vocabularyTerms (§6.4)", () => {
  it("splits on newline, comma, semicolon; trims; drops empties", () => {
    expect(vocabularyTerms(" астра, бобр\nкот ; ,,")).toEqual(["астра", "бобр", "кот"]);
  });

  it("dedups case-insensitively keeping the first spelling", () => {
    expect(vocabularyTerms("GitHub, github, GITHUB")).toEqual(["GitHub"]);
  });

  it("caps the list at 1000 terms", () => {
    const raw = Array.from({ length: 1200 }, (_, i) => `term${i}`).join(",");
    expect(vocabularyTerms(raw)).toHaveLength(1000);
  });
});

describe("setupMessage (§6.2)", () => {
  it("adds models/ prefix and SMART mode", () => {
    const frame = JSON.parse(
      setupMessage({ model: "gemini-3.5-transcribe-live", vocabularyTerms: [], languageCodes: null }),
    );
    expect(frame.setup.model).toBe("models/gemini-3.5-transcribe-live");
    expect(frame.setup.generationConfig.responseModalities).toEqual(["TEXT"]);
    expect(frame.setup.inputAudioTranscription.mode).toBe("SMART");
  });

  it("keeps an existing models/ prefix", () => {
    expect(normalizedModelPath("models/x")).toBe("models/x");
  });

  it("omits custom_vocabulary and languageCodes when empty", () => {
    const frame = JSON.parse(
      setupMessage({ model: "m", vocabularyTerms: [], languageCodes: null }),
    );
    expect(frame.setup.inputAudioTranscription).not.toHaveProperty("custom_vocabulary");
    expect(frame.setup.inputAudioTranscription).not.toHaveProperty("languageCodes");
    expect(frame.setup).not.toHaveProperty("language");
  });

  it("includes custom_vocabulary (snake_case, как OmniFlow) and languageCodes", () => {
    const frame = JSON.parse(
      setupMessage({ model: "m", vocabularyTerms: ["bb"], languageCodes: ["ru"] }),
    );
    expect(frame.setup.inputAudioTranscription.custom_vocabulary).toEqual(["bb"]);
    expect(frame.setup.inputAudioTranscription.languageCodes).toEqual(["ru"]);
  });
});

describe("parseServerFrame (§6.3)", () => {
  it("detects setupComplete", () => {
    expect(parseServerFrame('{"setupComplete":{}}').isSetupComplete).toBe(true);
  });

  it("detects voiceActivity segment boundaries", () => {
    const start = parseServerFrame('{"voiceActivity":{"type":"ACTIVITY_START"}}');
    expect(start.activityStartsSegment).toBe(true);
    expect(start.activityEndsSegment).toBe(false);
    const end = parseServerFrame('{"voiceActivity":{"type":"ACTIVITY_END"}}');
    expect(end.activityEndsSegment).toBe(true);
  });

  it("reads interim and final transcription texts", () => {
    const frame = parseServerFrame(
      JSON.stringify({
        serverContent: {
          interimInputTranscription: { text: "черновик" },
          inputTranscription: { text: "финал" },
        },
      }),
    );
    expect(frame.interimTranscript).toBe("черновик");
    expect(frame.transcript).toBe("финал");
  });

  it("marks turnComplete and generationComplete", () => {
    expect(parseServerFrame('{"serverContent":{"turnComplete":true}}').isComplete).toBe(true);
    expect(parseServerFrame('{"serverContent":{"generationComplete":true}}').isComplete).toBe(true);
    expect(parseServerFrame('{"serverContent":{"turnComplete":false}}').isComplete).toBe(false);
  });

  it("extracts the error message", () => {
    const frame = parseServerFrame('{"error":{"code":401,"message":"bad key"}}');
    expect(frame.errorMessage).toBe("bad key");
    expect(frame.isComplete).toBe(true);
  });

  it("ignores modelTurn content", () => {
    const frame = parseServerFrame(
      '{"serverContent":{"modelTurn":{"parts":[{"text":"model output"}]}}}',
    );
    expect(frame.transcript).toBeNull();
    expect(frame.interimTranscript).toBeNull();
  });

  it("tolerates malformed frames", () => {
    const frame = parseServerFrame("not json");
    expect(frame.isSetupComplete).toBe(false);
    expect(frame.errorMessage).toBeNull();
  });
});

describe("key masking (§6.1, §10)", () => {
  it("masks ?key= in URLs", () => {
    const url = socketUrl(API_KEY);
    expect(url).toContain(API_KEY);
    expect(maskKeyParam(`connecting ${url}`)).not.toContain(API_KEY);
    expect(maskKeyParam(`connecting ${url}`)).toContain("key=…");
  });

  it("scrubs the key value out of error text", () => {
    expect(maskSecretValue(`POST ?key=${API_KEY} failed`, API_KEY)).not.toContain(API_KEY);
  });
});

describe("transcribeGeminiLive session", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const openAndSetup = () => {
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ setupComplete: {} });
    return ws;
  };

  it("sends audio only after setupComplete, then audioStreamEnd", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = openAndSetup();
    const frames = ws.sentFrames() as Array<Record<string, unknown>>;
    expect(frames[0]).toHaveProperty("setup");
    const realtime = frames.slice(1);
    expect(realtime).toHaveLength(4); // 3 аудио-чанка + audioStreamEnd
    for (const f of realtime.slice(0, 3)) {
      expect(f).toHaveProperty("realtimeInput.audio.mimeType", "audio/pcm;rate=16000");
    }
    expect(realtime[3]).toEqual(JSON.parse(AUDIO_STREAM_END_MESSAGE));
    // Тишина без кадров: финиш по settle (~3 с) — пустой текст валиден (§6.6).
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(promise).resolves.toBe("");
  });

  it("accumulates interim/final replacement across voiceActivity segments", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = openAndSetup();
    ws.simulateMessage({ voiceActivity: { type: "ACTIVITY_START" } });
    ws.simulateMessage({ serverContent: { interimInputTranscription: { text: "при" } } });
    ws.simulateMessage({ serverContent: { interimInputTranscription: { text: "привет" } } });
    ws.simulateMessage({ voiceActivity: { type: "ACTIVITY_END" } });
    ws.simulateMessage({ voiceActivity: { type: "ACTIVITY_START" } });
    ws.simulateMessage({ serverContent: { inputTranscription: { text: "мир" } } });
    ws.simulateMessage({ voiceActivity: { type: "ACTIVITY_END" } });
    // turnComplete коммитит сегмент, но сессию не завершает (§6.6) — финиш по settle.
    ws.simulateMessage({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(promise).resolves.toBe("привет мир");
  });

  it("ignores turnComplete before our audioStreamEnd", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ serverContent: { turnComplete: true } });
    ws.simulateMessage({ setupComplete: {} });
    ws.simulateMessage({ serverContent: { inputTranscription: { text: "текст" } } });
    ws.simulateMessage({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(promise).resolves.toBe("текст");
  });

  it("does not finish on turnComplete mid-buffer — waits for settle", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = openAndSetup();
    ws.simulateMessage({ serverContent: { inputTranscription: { text: "первая" } } });
    ws.simulateMessage({ serverContent: { turnComplete: true } });
    // turnComplete пришёл посреди буфера — дальше ещё едет текст.
    ws.simulateMessage({ serverContent: { inputTranscription: { text: "вторая" } } });
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2_200);
    await expect(promise).resolves.toBe("первая вторая");
  });

  it("resolves by settle when interims went quiet after streamEnd", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = openAndSetup();
    ws.simulateMessage({ serverContent: { interimInputTranscription: { text: "текст" } } });
    // sinceLastActivity < 3.0 с — ждём settle; последний кадр был ~сразу после streamEnd.
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(promise).resolves.toBe("текст");
  });

  it("keeps waiting while interims keep arriving", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = openAndSetup();
    ws.simulateMessage({ serverContent: { interimInputTranscription: { text: "a" } } });
    await vi.advanceTimersByTimeAsync(700);
    ws.simulateMessage({ serverContent: { interimInputTranscription: { text: "ab" } } });
    await vi.advanceTimersByTimeAsync(700);
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    await expect(promise).resolves.toBe("ab");
  });

  it("fails the stage on finish cap while frames still arrive — never returns partial text", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const expectation = expect(promise).rejects.toMatchObject({
      name: "AiServiceFailure",
      code: "timeout",
    });
    const ws = openAndSetup();
    // Для тестового PCM (~300 мс аудио) cap ≈ 8.1 с; кадры приходят каждую секунду.
    for (let i = 0; i < 10; i += 1) {
      ws.simulateMessage({ serverContent: { interimInputTranscription: { text: `w${i}` } } });
      await vi.advanceTimersByTimeAsync(900);
    }
    await expectation;
  });

  it("fails the stage on an error frame", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = openAndSetup();
    ws.simulateMessage({ error: { message: "RESOURCE_EXHAUSTED: quota" } });
    await expect(promise).rejects.toMatchObject({
      name: "AiServiceFailure",
      code: "rate_limited",
    });
  });

  it("maps API-key error frames to auth_required and scrubs the key", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = openAndSetup();
    ws.simulateMessage({ error: { message: `API key ${API_KEY} is invalid` } });
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiServiceFailure);
    expect((error as AiServiceFailure).code).toBe("auth_required");
    expect((error as AiServiceFailure).message).not.toContain(API_KEY);
  });

  it("fails with the API-key hint when the socket dies before setupComplete", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    FakeWebSocket.latest().simulateError();
    await expect(promise).rejects.toMatchObject({
      code: "service_unavailable",
      message: "Could not connect to Gemini live transcription. Check the transcription API key.",
    });
  });

  it("times out when setupComplete never arrives", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const expectation = expect(promise).rejects.toMatchObject({ code: "timeout" });
    FakeWebSocket.latest().simulateOpen();
    await vi.advanceTimersByTimeAsync(5_100);
    await expectation;
  });

  it("fails when the socket closes mid-stream before the final", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = openAndSetup();
    ws.simulateMessage({ serverContent: { interimInputTranscription: { text: "x" } } });
    ws.simulateClose(1006, "abnormal");
    await expect(promise).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("sends languageCodes only when a language is configured", async () => {
    const promise = transcribeGeminiLive({ ...baseOptions(), language: "ru-RU" });
    const ws = openAndSetup();
    const setup = ws.sentFrames()[0] as { setup: { inputAudioTranscription: Record<string, unknown> } };
    expect(setup.setup.inputAudioTranscription.languageCodes).toEqual(["ru-RU"]);
    ws.simulateMessage({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(promise).resolves.toBe("");
  });

  it("derives custom_vocabulary from the hint", async () => {
    const promise = transcribeGeminiLive({ ...baseOptions(), hint: "astra, github" });
    const ws = openAndSetup();
    const setup = ws.sentFrames()[0] as { setup: { inputAudioTranscription: Record<string, unknown> } };
    expect(setup.setup.inputAudioTranscription.custom_vocabulary).toEqual(["astra", "github"]);
    ws.simulateMessage({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(promise).resolves.toBe("");
  });

  it("accepts binary message frames", async () => {
    const promise = transcribeGeminiLive(baseOptions());
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateBinaryMessage({ setupComplete: {} });
    ws.simulateBinaryMessage({ serverContent: { inputTranscription: { text: "bin" } } });
    ws.simulateBinaryMessage({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(promise).resolves.toBe("bin");
  });
});
