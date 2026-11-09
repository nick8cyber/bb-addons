import { describe, expect, it } from "vitest";
import { ConfirmationGate, type GateClock } from "../src/confirmation-gate.js";
import { DEFAULT_WORDS } from "../src/classify.js";

function fakeClock() {
  let now = 1_000_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: GateClock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(Number(handle));
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers.entries()]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    get now() {
      return now;
    },
  };
}

function setup() {
  const t = fakeClock();
  let reasks = 0;
  const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
    onReaskQuestion: () => reasks++,
  });
  gate.onModelAudio(1, 48000 * 10, t.now);
  gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
  return { t, gate, count: () => reasks };
}

describe("§7.2.1 повтор: ранний кадр остановки пред-запросного хода — 4 с от кадра", () => {
  it("early playback_stopped of pre-request turn: reask 4s after frame per spec", () => {
    const { t, gate, count } = setup();
    t.advance(1500);
    gate.onPlaybackStopped(1, 2000);
    t.advance(3900);
    gate.tick();
    expect(count()).toBe(0);
    t.advance(300);
    gate.tick();
    expect(count()).toBe(1);
    if (count() === 0) {
      t.advance(8300);
      gate.tick();
      expect(count()).toBe(1);
    }
  });

  it("early playback_stopped of request turn with playedMs <= requestTurnMs", () => {
    const { t, gate, count } = setup();
    t.advance(3000);
    gate.onPlaybackStopped(1, 3000);
    t.advance(3900);
    gate.tick();
    expect(count()).toBe(0);
    t.advance(300);
    gate.tick();
    expect(count()).toBe(1);
    if (count() === 0) {
      t.advance(6800);
      gate.tick();
      expect(count()).toBe(1);
    }
  });

  it("onModelInterrupted of pre-request turn: same frozen priorPlaybackEnd", () => {
    const { t, gate, count } = setup();
    t.advance(2000);
    gate.onModelInterrupted(1);
    t.advance(3900);
    gate.tick();
    expect(count()).toBe(0);
    t.advance(300);
    gate.tick();
    expect(count()).toBe(1);
    if (count() === 0) {
      t.advance(5800);
      gate.tick();
      expect(count()).toBe(1);
    }
  });
});
