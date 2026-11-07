import { describe, expect, it } from "vitest";
import { LiveTranscriptAccumulator } from "../src/accumulator.js";

// Порт LiveTranscriptAccumulator (спека §6.5): interim и final ЗАМЕНЯЮТ
// открытый сегмент, сегменты коммитятся и склеиваются пробелом.
describe("LiveTranscriptAccumulator", () => {
  it("interim replaces the open segment instead of appending", () => {
    const acc = new LiveTranscriptAccumulator();
    acc.feedInterim("при");
    acc.feedInterim("привет");
    expect(acc.current()).toBe("привет");
  });

  it("final replaces the interim of the same segment", () => {
    const acc = new LiveTranscriptAccumulator();
    acc.feedInterim("привет м");
    acc.feedFinal("привет мир");
    expect(acc.current()).toBe("привет мир");
  });

  it("endSegment commits and a new segment starts clean", () => {
    const acc = new LiveTranscriptAccumulator();
    acc.feedFinal("первый сегмент");
    acc.endSegment();
    acc.feedInterim("второй");
    expect(acc.current()).toBe("первый сегмент второй");
    acc.endSegment();
    expect(acc.finalText()).toBe("первый сегмент второй");
  });

  it("startSegment closes the open segment before a new one", () => {
    const acc = new LiveTranscriptAccumulator();
    acc.feedFinal("один");
    acc.startSegment();
    acc.feedFinal("два");
    expect(acc.finalText()).toBe("один два");
  });

  it("empty segments are not committed", () => {
    const acc = new LiveTranscriptAccumulator();
    acc.feedInterim("   ");
    acc.endSegment();
    acc.endSegment();
    expect(acc.finalText()).toBe("");
  });

  it("an empty interim is a valid segment reset", () => {
    const acc = new LiveTranscriptAccumulator();
    acc.feedInterim("черновик");
    acc.feedInterim("");
    expect(acc.current()).toBe("");
  });

  it("finalText joins committed segments with the open tail", () => {
    const acc = new LiveTranscriptAccumulator();
    acc.feedFinal("раз");
    acc.endSegment();
    acc.feedFinal("два");
    acc.endSegment();
    acc.feedInterim("три ещё пишется");
    expect(acc.finalText()).toBe("раз два три ещё пишется");
  });
});
