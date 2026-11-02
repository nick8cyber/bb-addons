/** Тесты кадров и ключевого пула. */
import { describe, expect, it } from "vitest";
import { FRAME_MIC, FRAME_PLAYBACK, BYTES_PER_SECOND_24K, parseFrame, packFrame, clientFrame, serverFrame } from "../src/contract.js";
import { KeyPool, QuotaExhaustedError } from "../src/key-pool.js";

describe("бинарные кадры (контракт §2.1)", () => {
  it("pack/parse туда и обратно", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = packFrame(FRAME_MIC, 42, pcm);
    expect(frame[0]).toBe(FRAME_MIC);
    const parsed = parseFrame(frame);
    expect(parsed.type).toBe(FRAME_MIC);
    expect(parsed.turnSeq).toBe(42);
    expect([...parsed.pcm]).toEqual([1, 2, 3, 4, 5]);
  });
  it("короткий кадр отбрасывается", () => {
    expect(() => parseFrame(new Uint8Array([1, 2]))).toThrow();
  });
});

describe("JSON-кадры", () => {
  it("hello и confirm валидны", () => {
    expect(clientFrame.safeParse({ type: "hello", protocol: 1 }).success).toBe(true);
    expect(clientFrame.safeParse({ type: "confirm", confirmationId: "x", decision: "approve" }).success).toBe(true);
    expect(clientFrame.safeParse({ type: "hello", protocol: 2 }).success).toBe(false);
  });
  it("ready без threadId — ок; thread-кадр отдельный", () => {
    expect(serverFrame.safeParse({ type: "ready", callId: "c", mode: "normal", voice: "Algenib", keys: { active: 1, of: 2 } }).success).toBe(true);
    expect(serverFrame.safeParse({ type: "thread", threadId: "thr_1" }).success).toBe(true);
  });
  it("48 000 байт = 1 с аудио 24 кГц PCM16", () => {
    expect(BYTES_PER_SECOND_24K).toBe(48000);
  });
  it("playback-кадр pack/parse", () => {
    const frame = packFrame(FRAME_PLAYBACK, 7, new Uint8Array(10));
    expect(parseFrame(frame).turnSeq).toBe(7);
  });
});

describe("KeyPool", () => {
  it("основной ключ активен, 429 переводит на запасной", () => {
    const switches: Array<[number, number]> = [];
    const pool = new KeyPool(["k1", "k2"], { onKeySwitch: (a, o) => switches.push([a, o]) });
    expect(pool.activeKey).toBe("k1");
    pool.switchOnQuota();
    expect(pool.activeKey).toBe("k2");
    expect(switches).toEqual([[2, 2]]);
  });
  it("оба ключа исчерпаны — QuotaExhaustedError", () => {
    const pool = new KeyPool(["k1", "k2"]);
    pool.switchOnQuota();
    expect(() => pool.switchOnQuota()).toThrow(QuotaExhaustedError);
  });
  it("один ключ — extended требует оба", () => {
    expect(new KeyPool(["k1"]).extendedNeedsBoth).toBe(false);
    expect(new KeyPool(["k1", "k2"]).extendedNeedsBoth).toBe(true);
  });
  it("TPM за скользящие 60 с и предупреждение на 50 тыс.", () => {
    let warned = "";
    const pool = new KeyPool(["k1"], { onWarning: (m) => (warned = m) });
    pool.addUsage(49_000, 0);
    pool.addUsage(2_000, 11_000);
    expect(warned).toContain("60");
    pool.addUsage(1, 70_000); // запись на 0 с ушла из окна (70-0 ≥ 60), на 11 с — ещё в окне (59 с назад)
    expect(pool.tpm()).toBe(2_001);
  });
});
