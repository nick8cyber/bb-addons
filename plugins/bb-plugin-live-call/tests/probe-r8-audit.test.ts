/**
 * Пробой аудита r8: контрольный случай спеки §7.2.7 — «повтор не перебивает
 * звучащий вопрос»: тишина для повтора от ожидаемого конца воспроизведения,
 * а не от прихода звука; после playback_stopped — 4 с от кадра.
 */
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

function setup(opts?: { turns?: number; bytes?: number }) {
  const t = fakeClock();
  let reasks = 0;
  const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
    onReaskQuestion: () => reasks++,
  });
  if (opts?.turns) for (let s = 1; s <= opts.turns; s++) gate.onModelAudio(s, opts.bytes ?? 48000, t.now);
  gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
  return { t, gate, reasks: { get n() { return reasks; } } };
}

describe("пробой r8: тишина повтора от ожидаемого конца воспроизведения (спека 3b2965d §7.2.1)", () => {
  it("ход 6000 мс получен за ~900 мс, кадров нет — до ~10 с повтора нет", () => {
    const { t, gate, reasks } = setup();
    const t0 = t.now;
    // 6 с звука приходят за ~900 мс (буфер ×7 быстрее реального времени)
    for (let i = 0; i < 6; i++) {
      gate.onModelAudio(1, 48000, t.now);
      t.advance(150);
    }
    // весь звук получен к t0+900; воспроизведение до ~t0+6000+
    t.advance(4000); // t0+4900 — вопрос ещё звучит у владельца
    gate.tick();
    expect(reasks.n).toBe(0); // спека: повтора нет раньше ~10 с
    t.advance(4000); // t0+8900 — ещё рано (ожидаемый конец ~t0+6000 + 4 с)
    gate.tick();
    expect(reasks.n).toBe(0);
    t.advance(1400); // t0+10300 — 4 с после ожидаемого конца прошли
    gate.tick();
    expect(reasks.n).toBe(1);
  });

  it("ход после запроса оборван с playedMs > 0 — звук проигран: окно открывается, повтора нет", () => {
    const { t, gate, reasks } = setup();
    gate.onModelAudio(1, 48000 * 4, t.now); // 4 с звука ответа
    gate.onModelInterrupted(1); // обрыв со стороны модели
    t.advance(400);
    gate.onPlaybackStopped(1, 4500); // звук реально дошёл до обрыва
    t.advance(5000);
    for (let i = 0; i < 3; i++) gate.tick();
    expect(gate.windowOpen()).toBe(true); // окно §7.1 после итога хода с проигрышем
    expect(reasks.n).toBe(0); // звук проигран — «модель молчит» не срабатывает
  });

  it("playback_stopped {ход запроса, playedMs ≤ requestTurnMs} без нового звука — повтор через 4 с от кадра", () => {
    // Ход 1 открыт на момент запроса: requestTurnSeq=1, requestTurnMs=3000.
    const { t, gate, reasks } = setup({ turns: 1, bytes: 48000 * 3 });
    t.advance(3000); // вопрос звучит
    gate.onPlaybackStopped(1, 1500); // обрыв: проиграно 1500 < 3000 — пост-запросный звук не дошёл
    t.advance(3900); // +3,9 с после кадра (< 4 с)
    gate.tick();
    expect(reasks.n).toBe(0); // спека: повтор через 4 с ОТ КАДРА
    t.advance(300); // +4,2 с после кадра
    gate.tick();
    expect(reasks.n).toBe(1);
  });
});
