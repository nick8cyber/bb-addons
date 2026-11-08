/**
 * Потоковый запасной захват: досылка хвоста при остановке (08.11).
 * Chromium отвечает на requestData() сначала пустым dataavailable, а сам
 * хвост (0,2–0,3 с) приходит следующим событием. Раньше flushStream
 * завершался на пустом событии, и конец фразы не доходил до сервера.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MicCapture } from "../src/ui/capture.js";

type Handler = ((e: { data: Blob }) => void) | null;

class FakeRecorder {
  ondataavailable: Handler = null;
  state = "recording";
  constructor(private readonly onRequest: (mr: FakeRecorder) => void) {}
  requestData(): void {
    this.onRequest(this);
  }
}

/** Байт куска = 100 сэмплов: «раскодированная» длина = сумма байт × 100. */
function fakeDecodeCtx() {
  return {
    decodeAudioData: async (buf: ArrayBuffer) => {
      const n = new Uint8Array(buf).length * 100;
      return { getChannelData: () => new Float32Array(n) };
    },
  };
}

function setup(onRequest: (mr: FakeRecorder) => void) {
  const cap = new MicCapture();
  const mr = new FakeRecorder(onRequest);
  const sent: number[] = [];
  const c = cap as unknown as Record<string, unknown>;
  c.mode = "recorder";
  c.mr = mr;
  c.mrMime = "audio/mp4";
  c.streaming = true;
  c.decodeCtx = fakeDecodeCtx();
  c.mrChunks = [new Blob([new Uint8Array(30)])];
  c.sentSamples = 0;
  c.onChunk = (pcm: Uint8Array) => sent.push(pcm.byteLength / 2);
  return { cap, mr, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("flushStream: хвост записи при остановке", () => {
  it("пустое событие после requestData не обрывает досылку — хвост уходит", async () => {
    const { cap, sent } = setup((mr) => {
      mr.ondataavailable?.({ data: new Blob([]) });
      setTimeout(() => mr.ondataavailable?.({ data: new Blob([new Uint8Array(5)]) }), 20);
    });
    await cap.flushStream();
    expect(sent.reduce((a, b) => a + b, 0)).toBe(35 * 100);
  });

  it("хвост не пришёл — по таймауту отправляется то, что есть, обработчик восстановлен", async () => {
    vi.useFakeTimers();
    const prev = () => {};
    const { cap, mr, sent } = setup((r) => r.ondataavailable?.({ data: new Blob([]) }));
    mr.ondataavailable = prev;
    const p = cap.flushStream();
    await vi.advanceTimersByTimeAsync(800);
    await p;
    expect(mr.ondataavailable).toBe(prev);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(30 * 100);
  });
});
