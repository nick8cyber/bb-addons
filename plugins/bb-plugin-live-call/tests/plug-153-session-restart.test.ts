/**
 * PLUG-153 round 4 (§7.2.1): сквозная нумерация ходов при пересоздании
 * голосовой сессии, обрыв незакрытых ходов, однократная запись итога хода.
 * Перенесённые пробы ревьюера (audit3-probes) — адаптированы к целевому
 * поведению: нумерация не рестартит, поэтому «реконнект» моделируется
 * markUnfinishedTurnsInterrupted() и новыми номерами ходов.
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

function setup() {
  const t = fakeClock();
  const verdicts: Array<{ v: string; via?: string; timing?: string }> = [];
  const early: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];
  const phases: string[] = [];
  const reask: string[] = [];
  const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
    onVerdict: (_p, v, via, _at, timing) => verdicts.push({ v, via, timing }),
    onEarlyApprovalLogged: (_p, info) => early.push(info as unknown as Record<string, unknown>),
    onEarlyApproval: () => {},
    onBargeDecision: (_p, info) => decisions.push(info as unknown as Record<string, unknown>),
    onConfirmationUpdate: (_p, phase) => phases.push(phase),
    onReaskQuestion: (p) => reask.push(p.say),
  });
  gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
  return { t, gate, verdicts, early, decisions, phases, reask };
}

const sayDa = (gate: ConfirmationGate, t: ReturnType<typeof fakeClock>) => {
  gate.onOwnerTranscriptChunk("да", t.now);
  t.advance(800);
};

describe("сквозная нумерация при пересоздании сессии (проба A)", () => {
  it("«да» с кадром хода новой сессии — approved: номера продолжаются", () => {
    const { t, gate, verdicts } = setup();
    gate.onModelAudio(1, 19200, t.now);
    gate.markUnfinishedTurnsInterrupted(); // реконнект: старые ходы оборваны
    t.advance(1500);
    gate.onModelAudio(2, 48000 * 2, t.now); // новый клиент продолжает с хода 2
    gate.onSpeechStart(2, 1500, t.now);
    sayDa(gate, t);
    expect(verdicts).toEqual([{ v: "approved", via: "barge", timing: "client" }]);
  });

  it("кадр старого хода после реконнекта — раннее", () => {
    const t = fakeClock();
    const verdicts: Array<{ v: string; via?: string }> = [];
    const early: Array<Record<string, unknown>> = [];
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_p, v, via) => verdicts.push({ v, via }),
      onEarlyApprovalLogged: (_p, info) => early.push(info as unknown as Record<string, unknown>),
    });
    gate.onModelAudio(1, 48000 * 3, t.now); // ход открыт на момент запроса
    gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?"); // requestTurnSeq=1, requestTurnMs=3000
    gate.markUnfinishedTurnsInterrupted();
    t.advance(1500);
    gate.onModelAudio(2, 48000, t.now); // новая сессия продолжает нумерацию
    gate.onSpeechStart(1, 3000, t.now); // тот же ход: playedMs == requestTurnMs — не > → раннее
    sayDa(gate, t);
    expect(verdicts).toEqual([]);
    expect(early.length).toBe(1);
  });
});

describe("итог хода записывается один раз", () => {
  it("playback_stopped не переписывает drained итог", () => {
    const { t, gate } = setup();
    gate.onModelAudio(1, 19200, t.now);
    t.advance(400); // тишина ≥ WINDOW_PADDING
    gate.onPlaybackDrained(1, t.now);
    gate.onPlaybackStopped(1, 9999); // запоздалый кадр — итог не переписывается
    // Контроль косвенно: повторная остановка ничего не ломает, окно работает по §7.1.
    t.advance(2100);
    expect(gate.windowOpen()).toBe(true);
  });
});

// --- Уровень CallSession: нумерация продолжается через реальных клиентов ---

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe as describeSession, expect as expectSession, it as itSession, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";

const sockets: FakeWs[] = [];
class FakeWs {
  readyState = 0;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(public url: string) {
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.fire("open", {});
    }, 0);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send() {}
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  fire(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  /** Кусок аудио модели: modelTurn с inlineData → событие audio LiveClient. */
  pushAudio() {
    this.fire("message", {
      data: JSON.stringify({
        serverContent: { modelTurn: { parts: [{ inlineData: { data: "QUJD" } }] } },
      }),
    });
  }
}

function makeSessionDeps(seqs: number[]) {
  return {
    callId: "call_test",
    keys: ["k1", "k2"],
    voice: "Algenib",
    languageCode: "ru-RU",
    thinkingLevel: "LOW" as const,
    mode: "normal" as const,
    allowExtended: false,
    routerInput: "text" as const,
    maxCallMinutes: 60,
    store: new CallStore(new Database(":memory:")),
    sdk: {} as never,
    toBrowser: () => {},
    sendBrowserAudio: (turnSeq: number) => seqs.push(turnSeq),
    spawnCallThread: async () => null,
    advanceCallThread: async () => {},
    sayCallThread: async () => {},
    endCallThread: async () => {},
    wsFactory: (url: string) => new FakeWs(url) as unknown as WebSocket,
  };
}

describeSession("turnSeqBase: нумерация ходов сквозная в пределах звонка", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  itSession("переподключение голоса: новый клиент продолжает нумерацию", async () => {
    const seqs: number[] = [];
    const s = new CallSession(makeSessionDeps(seqs));
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    sockets[0].pushAudio();
    expectSession(seqs).toEqual([1]);

    (s as unknown as { reconnectVoice(t: number): Promise<void> }).reconnectVoice(0);
    await vi.advanceTimersByTimeAsync(3000);
    const voiceSock = sockets[sockets.length - 1];
    voiceSock.pushAudio();
    // Без сквозной нумерации новый клиент выдал бы снова ход 1.
    expectSession(seqs).toEqual([1, 2]);
    await s.end("owner");
  });

  itSession("возврат браузера (resendReady): ходы без итога помечаются оборванными", async () => {
    const seqs: number[] = [];
    const s = new CallSession(makeSessionDeps(seqs));
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    sockets[0].pushAudio();
    const gate = (s as unknown as { gate: { markUnfinishedTurnsInterrupted(): void } }).gate;
    const spy = vi.spyOn(gate, "markUnfinishedTurnsInterrupted");
    s.resendReady();
    expectSession(spy).toHaveBeenCalledTimes(1);
    await s.end("owner");
  });

  itSession("смена ключа по квоте: нумерация не рестартит", async () => {
    const seqs: number[] = [];
    const s = new CallSession(makeSessionDeps(seqs));
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    sockets[0].pushAudio();
    sockets[0].pushAudio(); // ход 1 открыт — тот же seq
    expectSession(seqs).toEqual([1, 1]);

    (s as unknown as { switchKeyOnQuota(r: "quota"): void }).switchKeyOnQuota("quota");
    await vi.advanceTimersByTimeAsync(10);
    const voiceSock = sockets[sockets.length - 1];
    voiceSock.pushAudio();
    expectSession(seqs).toEqual([1, 1, 2]);
    await s.end("owner");
  });
});

describe("окно и повтор вопроса после упрощения (§7.2.1)", () => {
  it("ход ответа оборван моделью — окно открывается по §7.1, «да» via window", () => {
    const { t, gate, verdicts, phases } = setup();
    gate.onModelAudio(1, 48000 * 4, t.now);
    gate.onModelTranscript("Отправить в тред: «x»?", t.now, 1);
    gate.onModelInterrupted(1); // обрыв со стороны модели
    t.advance(400); // тишина ≥300 мс
    gate.onPlaybackStopped(1, 4500); // доигран до обрыва — звук ответа проигран
    t.advance(5200); // оценка сервера (4 с звука + 1 с) прошла — окно по §7.1
    expect(gate.windowOpen()).toBe(true);
    sayDa(gate, t);
    expect(verdicts).toEqual([{ v: "approved", via: "window", timing: undefined }]);
  });

  it("модель не заговорила после запроса: повтор один раз по тишине 4 с, вторая не выстреливает", () => {
    const { t, gate, reask, phases } = setup();
    t.advance(4100);
    gate.tick();
    expect(reask).toEqual(["Отправить в тред: «x»?"]);
    t.advance(5000);
    gate.tick();
    gate.tick();
    expect(reask).toHaveLength(1); // одна вставка на pending
    expect(phases).not.toContain("listening"); // тишина и после повтора — окна нет
  });

  it("раннее «да» расходует ту же единственную вставку: повтор по тишине не выстреливает", () => {
    const { t, gate, verdicts, reask } = setup();
    t.advance(3500);
    gate.onOwnerTranscriptChunk("да", t.now); // без кадра → no_marker → вставка раннего «да»
    t.advance(800);
    t.advance(5000); // всего >4 с тишины
    gate.tick();
    expect(reask).toHaveLength(0); // лимит вставки уже исчерпан ранним «да»
    expect(verdicts).toEqual([]);
  });
});

