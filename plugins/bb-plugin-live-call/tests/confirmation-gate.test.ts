/** Тесты ConfirmationGate: шлюз микрофона, окно, одноразовость, дедупликация. */
import { describe, expect, it } from "vitest";
import { ConfirmationGate, argsHash, type GateClock } from "../src/confirmation-gate.js";
import { DEFAULT_WORDS } from "../src/classify.js";

/** Часы без реального времени: setTimeout только по продвижению. */
function fakeClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock: GateClock = {
    now: () => now,
    setTimeout(fn, ms) {
      timers.push({ at: now + ms, fn });
      return timers.length;
    },
    clearTimeout(handle) {
      const i = Number(handle) - 1;
      if (timers[i]) timers.splice(i, 1);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      for (const t of due) t.fn();
      for (let i = timers.length - 1; i >= 0; i--) {
        if (due.includes(timers[i])) timers.splice(i, 1);
      }
    },
    get now() {
      return now;
    },
  };
}

function openWindow(gate: ConfirmationGate, t: ReturnType<typeof fakeClock>) {
  // Модель задала вопрос: 48 000 байт = 1 с аудио. Оценка сервера:
  // first + 1000 мс аудио + 1000 мс запас + 300 мс отступ ≈ 2,3 с от первого кадра.
  gate.onModelAudio(1, 48000, t.now);
  t.advance(300);
  gate.onPlaybackDrained(1, t.now);
  t.advance(2100);
  return gate;
}

describe("request: pending, повторы и дедупликация", () => {
  it("создаёт pending; повтор с тем же argsHash возвращает ту же запись", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    const r1 = gate.request("start_thread", { project: "A", task: "x" }, "L", "скажи запускай");
    const r2 = gate.request("start_thread", { task: "x", project: "A" }, "L", "скажи запускай");
    expect("pending" in r1).toBe(true);
    expect("pending" in r2).toBe(true);
    if ("pending" in r1 && "pending" in r2) {
      expect(r2.pending.confirmationId).toBe(r1.pending.confirmationId);
    }
  });

  it("другой вызов записи, пока ждёт подтверждение, отклоняется", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    const r = gate.request("stop_thread", { thread: "t1" }, "C", "s");
    expect(r).toEqual({ rejected: "pending_exists", message: "сначала ответь на текущее подтверждение" });
  });

  it("после approved тот же argsHash в течение 5 мин — «уже выполнено», без нового pending", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    const r1 = gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    if (!("pending" in r1)) throw new Error("no pending");
    gate.decide(r1.pending.confirmationId, "approve");
    gate.consume(r1.pending.confirmationId);
    const r2 = gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    expect(r2).toEqual({ rejected: "recent_verdict", message: "уже выполнено, больше не вызывай" });
    t.advance(6 * 60_000);
    const r3 = gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    expect("pending" in r3).toBe(true);
  });
});

describe("шлюз микрофона и окно ответа (§7.1 п. 3)", () => {
  it("микрофон закрыт с момента pending и до открытия окна", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    expect(gate.isMicOpen()).toBe(true);
    gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    expect(gate.isMicOpen()).toBe(false);
    openWindow(gate, t);
    expect(gate.isMicOpen()).toBe(true);
    expect(gate.windowOpen()).toBe(true);
  });

  it("окно не открывается по turnComplete без playback_drained", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    gate.onModelAudio(1, 48000, t.now);
    t.advance(3000);
    gate.tick();
    expect(gate.windowOpen()).toBe(false);
  });

  it("playback_drained потерян — окно открывается по резервной оценке, «запускай» засчитывается", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    gate.onModelAudio(1, 48000, t.now);
    // 1 с аудио + 1 с запас оценки + 2,5 с резерв
    t.advance(4600);
    gate.tick();
    t.advance(400);
    expect(gate.windowOpen()).toBe(true);
    expect(gate.isMicOpen()).toBe(true);
    gate.onOwnerTranscriptChunk("запускай", t.now);
    t.advance(800);
    expect(gate.pendingConfirmation()?.verdict).toBe("approved");
  });

  it("реплика, начатая до открытия окна, не идёт в зачёт даже с хвостом после", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    gate.onModelAudio(1, 48000, t.now);
    gate.onOwnerTranscriptChunk("за", t.now + 100); // ещё до окна
    t.advance(300);
    gate.onPlaybackDrained(1, t.now);
    t.advance(400);
    gate.onOwnerTranscriptChunk("пускай", t.now); // хвост опоздавшей речи
    t.advance(800); // конец реплики по тишине
    expect(gate.pendingConfirmation()?.verdict).toBeNull();
  });

  it("«запускай» после открытия окна — approved", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    openWindow(gate, t);
    gate.onOwnerTranscriptChunk("зап", t.now);
    gate.onOwnerTranscriptChunk("ускай", t.now);
    t.advance(800);
    expect(gate.pendingConfirmation()?.verdict).toBe("approved");
  });

  it("«да» на запуск — hint: pending жив, микрофон снова закрыт до подсказки", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    openWindow(gate, t);
    gate.onOwnerUtteranceEnd("да", t.now, t.now);
    expect(gate.pendingConfirmation()).not.toBeNull();
    expect(gate.isMicOpen()).toBe(false);
    // Подсказка прозвучала: окно переоткрывается по правилу п. 3.
    gate.onModelAudio(2, 24000, t.now);
    t.advance(300);
    gate.onPlaybackDrained(2, t.now);
    t.advance(1900);
    gate.onOwnerUtteranceEnd("запускай", t.now, t.now);
    expect(gate.pendingConfirmation()?.verdict).toBe("approved");
  });

  it("«нет» после вопроса — отмена, запись сгорает", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    openWindow(gate, t);
    gate.onOwnerUtteranceEnd("нет", t.now, t.now);
    expect(gate.pendingConfirmation()).toBeNull();
  });

  it("TTL 60 с — expired", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    t.advance(61_000);
    gate.tick();
    expect(gate.pendingConfirmation()).toBeNull();
  });
});

describe("кнопки и одноразовость", () => {
  it("кнопка «Подтвердить» = approved, consume() сжигает id", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    const r = gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    if (!("pending" in r)) throw new Error("no pending");
    expect(gate.decide(r.pending.confirmationId, "approve")).toBe("approved");
    gate.consume(r.pending.confirmationId);
    expect(gate.pendingConfirmation()).toBeNull();
    expect(gate.decide(r.pending.confirmationId, "approve")).toBe("expired");
  });

  it("confirm_action с чужим id — not_confirmed, с использованным — expired", async () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    expect(await gate.confirmAction("cf_nope")).toBe("not_confirmed");
    const r = gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    if (!("pending" in r)) throw new Error("no pending");
    gate.decide(r.pending.confirmationId, "approve");
    gate.consume(r.pending.confirmationId);
    expect(await gate.confirmAction(r.pending.confirmationId)).toBe("expired");
  });

  it("повторный decide() при уже вынесенном вердикте не вызывает onVerdict повторно (§12.10.5)", () => {
    const t = fakeClock();
    let verdictCount = 0;
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: () => {
        verdictCount++;
      },
    });
    const r = gate.request("start_thread", { project: "A", task: "x" }, "L", "s");
    if (!("pending" in r)) throw new Error("no pending");
    expect(gate.decide(r.pending.confirmationId, "approve")).toBe("approved");
    expect(verdictCount).toBe(1);

    // Второй вызов decide до сжигания: вердикт уже вынесен, onVerdict не вызывается повторно
    expect(gate.decide(r.pending.confirmationId, "approve")).toBe("approved");
    expect(verdictCount).toBe(1);
  });
});

describe("argsHash", () => {
  it("не зависит от порядка ключей", () => {
    expect(argsHash("t", { a: 1, b: { c: 2, d: 3 } })).toBe(argsHash("t", { b: { d: 3, c: 2 }, a: 1 }));
  });
  it("разные аргументы — разный хеш", () => {
    expect(argsHash("t", { a: 1 })).not.toBe(argsHash("t", { a: 2 }));
  });
});

describe("кнопки подтверждения (аудит PLUG-108)", () => {
  it("«Отмена» сразу снимает ожидание: микрофон открыт, следующая запись не получает pending_exists", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    const r = gate.request("send_to_thread", { thread: "A", text: "x" }, "C", "отправить?");
    expect("pending" in r).toBe(true);
    if (!("pending" in r)) return;
    expect(gate.decide(r.pending.confirmationId, "cancel")).toBe("cancelled");
    expect(gate.pendingConfirmation()).toBeNull();
    expect(gate.isMicOpen()).toBe(true);
    const r2 = gate.request("send_to_thread", { thread: "B", text: "y" }, "C", "отправить?");
    expect("pending" in r2).toBe(true);
  });

  it("«Подтвердить» кнопкой сразу открывает микрофон, не дожидаясь конца исполнения", () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);
    const r = gate.request("send_to_thread", { thread: "A", text: "x" }, "C", "отправить?");
    if (!("pending" in r)) throw new Error("нет pending");
    expect(gate.decide(r.pending.confirmationId, "approve")).toBe("approved");
    expect(gate.isMicOpen()).toBe(true);
  });
});
