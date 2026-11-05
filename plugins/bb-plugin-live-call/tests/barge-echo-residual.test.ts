/**
 * Перебивание вопроса: остаток реплики считается после удаления эха вопроса и карточки
 * (спека §7.1 п. 5.3). Живой звонок 05.11: «Да, отправь.» во время вопроса
 * «Отправить в тред: «…»?» молча терялось, отправила только кнопка.
 */
import { describe, expect, it } from "vitest";
import { ConfirmationGate, type GateClock } from "../src/confirmation-gate.js";
import { DEFAULT_WORDS } from "../src/classify.js";

function fakeClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock: GateClock = {
    now: () => now,
    setTimeout(fn, ms) {
      timers.push({ at: now + ms, fn });
      return timers.length;
    },
    clearTimeout(h) {
      const i = Number(h) - 1;
      if (timers[i]) timers.splice(i, 1);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      for (const t of due) t.fn();
      for (let i = timers.length - 1; i >= 0; i--) if (due.includes(timers[i])) timers.splice(i, 1);
    },
    get now() {
      return now;
    },
  };
}

function bargeIn(answer: string, cls: "C" | "L" = "C") {
  const t = fakeClock();
  const verdicts: string[] = [];
  let early = 0;
  const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
    onVerdict: (_p, v, via) => verdicts.push(`${v}/${via}`),
    onEarlyApproval: () => {
      early++;
    },
  });
  const text = "Какие модели сейчас используются?";
  const tool = cls === "L" ? "start_thread" : "thread_send";
  const verb = cls === "L" ? "Запустить агента" : "Отправить в тред";
  const say = `${verb}: «${text}»?`;
  const r = gate.request(tool, { text }, cls, say, say, [text]);
  if (!("pending" in r)) throw new Error("нет pending");
  // Филлер модели перед вопросом — его слова попадают в широкий эхо-набор перебивания.
  gate.onModelTranscript("Секунду, отправляю запрос в тред по поводу используемых моделей.", t.now);
  gate.onModelTurnComplete();
  // Вопрос начинает звучать: начало вопроса в транскрипте в начале звука.
  gate.onModelAudio(1, 4800, t.now);
  gate.onModelTranscript(`${verb}: «Какие модели`, t.now);
  gate.onModelAudio(1, 48000 * 3, t.now);
  t.advance(2600);
  gate.onOwnerTranscriptChunk(answer, t.now);
  t.advance(800);
  return { verdicts, early };
}

describe("перебивание: остаток после эха вопроса и карточки (§7.1 п. 5.3)", () => {
  for (const answer of ["Да, отправь.", "да", "Да, отправляй."]) {
    it(`«${answer}» во время вопроса → approved/barge`, () => {
      expect(bargeIn(answer).verdicts).toEqual(["approved/barge"]);
    });
  }

  for (const answer of ["да, по поводу моделей", "да, запрос отправляю"]) {
    it(`«${answer}» (уточнение из слов филлера модели) → вердикта нет`, () => {
      const r = bargeIn(answer);
      expect(r.verdicts).toEqual([]);
      expect(r.early).toBe(0); // отклонено классификацией, а не ушло в «раннее да»
    });
  }

  it("одно «Отправь.» (возможное эхо глагола вопроса) → вердикта нет", () => {
    const r = bargeIn("Отправь.");
    expect(r.verdicts).toEqual([]);
    expect(r.early).toBe(0);
  });

  it("класс L: «запускай агента» во время вопроса → approved/barge", () => {
    expect(bargeIn("запускай агента", "L").verdicts).toEqual(["approved/barge"]);
  });

  for (const answer of ["да, запустить", "запусти"]) {
    it(`класс L: «${answer}» (эхо глагола вопроса) → вердикта нет`, () => {
      const r = bargeIn(answer, "L");
      expect(r.verdicts).toEqual([]);
      expect(r.early).toBe(0);
    });
  }
});
