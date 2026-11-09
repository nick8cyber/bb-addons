/**
 * PLUG-153 / спека §7.2.1 (правка 1c0ee7a): «после вопроса» только если вопросный
 * ход реально проигран до questionOffsetMs — playback_stopped и finalPlayedMs
 * хода вопроса, сброс точки отсчёта при обрыве; повторная остановка хода не меняет
 * проигранное; кадр привязан только к последующей реплике; barge_decision на хвосты.
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
  const verdicts: Array<{ v: string; timing?: string }> = [];
  const early: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];
  const durations: number[] = [];
  const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
    onVerdict: (_p, v, _via, _at, timing) => verdicts.push({ v, timing }),
    onEarlyApprovalLogged: (_p, info) => early.push(info as unknown as Record<string, unknown>),
    onEarlyApproval: () => {},
    onBargeDecision: (_p, info) => decisions.push(info as unknown as Record<string, unknown>),
    onQuestionDuration: (_p, _at, _o, ms) => durations.push(ms),
  });
  gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
  return { t, gate, verdicts, early, decisions, durations };
}

const sayDa = (gate: ConfirmationGate, t: ReturnType<typeof fakeClock>) => {
  gate.onOwnerTranscriptChunk("да", t.now);
  t.advance(800);
};

describe("§7.2.1 решение не зависит от судьбы хода вопроса (упрощение r7)", () => {
  it("«да» с кадром более позднего хода — approved даже если ход запроса оборван моделью без итога", () => {
    const { t, gate, verdicts } = setup();
    gate.onModelAudio(1, 48000 * 4, t.now);
    gate.onModelInterrupted(1); // Gemini-side interrupt, playedMs неизвестен
    t.advance(2000);
    gate.onSpeechStart(2, 300, t.now); // следующий ход со звуком — «да» засчитывается
    sayDa(gate, t);
    expect(verdicts).toEqual([{ v: "approved", timing: "client" }]);
    // Решение по кадру окончательное: запоздалый playback_stopped его не меняет.
    gate.onPlaybackStopped(1, 0);
    expect(verdicts).toEqual([{ v: "approved", timing: "client" }]);
  });

  it("playback_stopped хода запроса не меняет снимок: ранние остаются ранними", () => {
    const { t, gate, verdicts, early, decisions } = setup();
    gate.onModelAudio(1, 48000 * 4, t.now);
    gate.onPlaybackStopped(1, 4500);
    t.advance(2000);
    gate.onSpeechStart(1, 0, t.now); // playedMs=0 — раннее
    sayDa(gate, t);
    expect(verdicts).toEqual([]);
    expect(decisions.at(-1)).toMatchObject({ result: "early", turnSeq: 1, playedMs: 0 });
    expect(early.at(-1)).toMatchObject({ timing: "client", requestTurnSeq: 0 });
  });

  it("окно открывается после оборванного хода ответа (§7.1), «да» — via window", () => {
    const { t, gate, verdicts, decisions } = setup();
    gate.onModelAudio(1, 48000 * 4, t.now);
    gate.onSpeechStart(1, 0, t.now);
    t.advance(3600); // оценка старта ≥1,5 с — не хвост
    gate.onOwnerTranscriptChunk("подожди, а что там?", t.now); // не согласие
    t.advance(800);
    expect(decisions.at(-1)?.result).toBe("not_approval");
    gate.onModelInterrupted(1);
    gate.onPlaybackStopped(1, 4500); // ход доигран до обрыва — звук ответа проигран
    t.advance(1000);
    expect(gate.windowOpen()).toBe(true);
    sayDa(gate, t);
    expect(verdicts).toEqual([{ v: "approved", timing: undefined }]);
  });

  it("durationMs — по серверной оценке начала вопроса до конца его хода (журнал)", () => {
    const a = setup();
    a.gate.onModelAudio(1, 48000, a.t.now);
    a.gate.onModelTranscript("Отправить в тред: «x»?", a.t.now, 1);
    a.t.advance(3000);
    a.gate.onPlaybackDrained(1, a.t.now); // durationMs = drained − оценка начала
    expect(a.durations.length).toBe(1);
    expect(a.durations[0]).toBeGreaterThan(0);
  });
});

describe("§7.2.1 привязка кадра и журнал хвостов", () => {
  it("кадр, пришедший после первого куска реплики, к ней не привязывается (no_marker)", () => {
    const { t, gate, verdicts, decisions } = setup();
    gate.onModelAudio(1, 48000, t.now);
    t.advance(3600);
    gate.onOwnerTranscriptChunk("да", t.now);
    gate.onSpeechStart(1, 200, t.now);
    t.advance(800);
    expect(verdicts).toEqual([]);
    expect(decisions.at(-1)).toMatchObject({ result: "no_marker", turnSeq: null });
  });

  it("barge_decision пишется и на реплики-хвосты (result: tail, tailSource)", () => {
    const { t, gate, verdicts, decisions } = setup();
    gate.onSpeechStart(1, 100, t.now);
    t.advance(500);
    gate.onOwnerTranscriptChunk("ну отправь же это", t.now);
    t.advance(800);
    expect(decisions.at(-1)).toMatchObject({ result: "tail", tailSource: "client", turnSeq: 1, playedMs: 100 });
    expect(verdicts).toEqual([]);
  });
});

describe("§7.2.1 браузер: повторный interrupted() остановленного хода", () => {
  function fakeCtx(at = 10) {
    const sources: Array<{ onended: (() => void) | null; stop(): void; start(): void; connect(): void }> = [];
    const ctx = {
      currentTime: at,
      destination: {},
      createBuffer: (_ch: number, len: number, rate: number) => ({
        duration: len / rate,
        getChannelData: () => new Float32Array(len),
      }),
      createBufferSource: () => {
        const s = {
          buffer: null as unknown,
          onended: null as null | (() => void),
          connect() {},
          start() {},
          stop() {
            s.onended = null;
          },
        };
        sources.push(s);
        return s;
      },
    };
    return { ctx, sources };
  }

  it("не меняет playedMs и не шлёт playback_stopped повторно", async () => {
    const { TurnPlayer } = await import("../src/ui/engine.js");
    const f = fakeCtx(10);
    const stops: Array<{ seq: number; ms: number }> = [];
    const player = new TurnPlayer(
      f.ctx as never,
      () => {},
      (seq, ms) => stops.push({ seq, ms }),
    );
    // Ход 1: один буфер 8 с (24000 сэмплов/с * 8).
    player.enqueue(1, new Uint8Array(24000 * 8 * 2));
    f.ctx.currentTime = 10.5; // проиграно ~500 мс
    player.interrupted();
    expect(stops.length).toBe(1);
    expect(stops[0].seq).toBe(1);
    expect(stops[0].ms).toBeLessThan(600);
    const pos1 = player.playbackPosition();
    expect(pos1?.playedMs).toBeLessThan(600);
    // 5 с спустя — второй interrupted() (стрей кадр Gemini / смена режима / реконнект):
    // уже остановленный ход не отчитывается заново и playedMs не растёт.
    f.ctx.currentTime = 15;
    player.interrupted();
    expect(stops.length).toBe(1);
    const pos2 = player.playbackPosition();
    expect(pos2?.playedMs).toBeLessThan(1000);
  });
});
