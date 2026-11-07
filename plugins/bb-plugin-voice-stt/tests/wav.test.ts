import { describe, expect, it } from "vitest";
import { pcmToWav } from "../src/wav.js";

const ascii = (bytes: Uint8Array, from: number, len: number): string =>
  String.fromCharCode(...bytes.subarray(from, from + len));

const u32 = (bytes: Uint8Array, off: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(off, true);
const u16 = (bytes: Uint8Array, off: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint16(off, true);

describe("pcmToWav (§4.5, §9)", () => {
  it("writes a canonical 44-byte RIFF/WAVE header", () => {
    const pcm = new Uint8Array(3200).fill(7);
    const wav = pcmToWav(pcm);
    expect(wav.byteLength).toBe(44 + 3200);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(u32(wav, 4)).toBe(36 + 3200);
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(u32(wav, 16)).toBe(16);
    expect(u16(wav, 20)).toBe(1); // PCM
    expect(u16(wav, 22)).toBe(1); // mono
    expect(u32(wav, 24)).toBe(16_000);
    expect(u32(wav, 28)).toBe(16_000 * 2); // byteRate
    expect(u16(wav, 32)).toBe(2); // blockAlign
    expect(u16(wav, 34)).toBe(16); // bits
    expect(ascii(wav, 36, 4)).toBe("data");
    expect(u32(wav, 40)).toBe(3200);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it("handles empty PCM", () => {
    const wav = pcmToWav(new Uint8Array(0));
    expect(wav.byteLength).toBe(44);
    expect(u32(wav, 40)).toBe(0);
    expect(u32(wav, 4)).toBe(36);
  });

  it("honours a custom sample rate", () => {
    const wav = pcmToWav(new Uint8Array(100), 24_000);
    expect(u32(wav, 24)).toBe(24_000);
    expect(u32(wav, 28)).toBe(48_000);
  });
});
