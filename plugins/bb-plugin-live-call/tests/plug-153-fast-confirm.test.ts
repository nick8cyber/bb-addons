/**
 * PLUG-153 / спека §7.2 (ADR-0018): быстрое «да» по часам браузера, короткий
 * вопрос, сначала вызов, single-flight мозгового центра.
 */
import { describe, expect, it, vi } from "vitest";
import { BrainCenter } from "../src/brain-center.js";
import { ConfirmationGate, type GateClock } from "../src/confirmation-gate.js";
import { DEFAULT_WORDS } from "../src/classify.js";
import { brainAskTool } from "../src/tools.js";
import { sameBrainQuestion } from "../src/single-flight.js";

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

function mockStore() {
  const events: Array<{ type: string; payload?: unknown }> = [];
  return {
    events,
    event: (callId: string, type: string, payload?: unknown) => {
      events.push({ type, payload });
    },
  };
}

function makeBrain(sdk: Record<string, unknown>, store: ReturnType<typeof mockStore>) {
  const b = new BrainCenter({
    sdk: sdk as never,
    store: store as never,
    callId: "call_sf",
    targetThreadId: "thr_t",
    targetThreadTitle: "Тред",
    targetProjectId: "proj_t",
    allMessages: [],
    storageDir: "/tmp/plug153-brain",
  });
  b.threadId = "thr_brain_sf";
  return b;
}

describe("§7.2.6 single-flight мозгового центра", () => {
  it("sameBrainQuestion: совпадение и префикс в обе стороны", () => {
    expect(sameBrainQuestion("что в треде", "что в треде сейчас?")).toBe(true);
    expect(sameBrainQuestion("что в треде сейчас?", "что в треде")).toBe(true);
    expect(sameBrainQuestion("  Что  в треде ", "что в треде")).toBe(true);
    expect(sameBrainQuestion("что в треде", "статус проекта")).toBe(false);
  });

  it("второй вызов с продолжением вопроса присоединяется: один ход мозга, один ответ, callIds обоих", async () => {
    const store = mockStore();
    let resolveSend: (() => void) | undefined;
    const sdk = {
      threads: {
        send: vi.fn(async () => {
          await new Promise<void>((r) => {
            resolveSend = r;
          });
        }),
        wait: vi.fn(async () => ({ matched: true })),
        output: vi.fn(async () => ({ output: "ответ мозга" })),
      },
    };
    const brain = makeBrain(sdk, store);

    const p1 = brain.ask("что в треде", "call_1");
    const p2 = brain.ask("что в треде сейчас?", "call_2");
    expect(brain.askWillJoin("что в треде")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    resolveSend?.();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2); // тот же ответ
    expect(sdk.threads.send).toHaveBeenCalledTimes(1); // один ход мозгового центра
    const ev = store.events.find((e) => e.type === "brain_answer");
    expect((ev?.payload as Record<string, unknown>).callIds).toEqual(["call_1", "call_2"]);
  });

  it("другой вопрос ждёт в очереди и уходит после ответа на текущий", async () => {
    const store = mockStore();
    const order: string[] = [];
    const sdk = {
      threads: {
        send: vi.fn(async (a: { input: Array<{ text: string }> }) => {
          order.push(a.input[0].text.slice(-20));
        }),
        wait: vi.fn(async () => ({ matched: true })),
        output: vi.fn(async () => ({ output: "ответ" })),
      },
    };
    const brain = makeBrain(sdk, store);
    let resolveFirst: (() => void) | undefined;
    sdk.threads.send = vi.fn(async (a: { input: Array<{ text: string }> }) => {
      order.push(a.input[0].text);
      if (order.length === 1) await new Promise<void>((r) => { resolveFirst = r; });
    });

    const p1 = brain.ask("вопрос первый", "call_1");
    const p2 = brain.ask("совсем другой вопрос", "call_2");
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.threads.send).toHaveBeenCalledTimes(1); // второй ждёт
    resolveFirst?.();
    await Promise.all([p1, p2]);
    expect(sdk.threads.send).toHaveBeenCalledTimes(2);
    expect(order[0]).toContain("вопрос первый");
    expect(order[1]).toContain("совсем другой вопрос");
    const answers = store.events.filter((e) => e.type === "brain_answer");
    expect((answers[1].payload as Record<string, unknown>).callIds).toEqual(["call_2"]);
  });

  it("brain_ask: присоединившийся вызов подавляет карточку действия", () => {
    const ctxJoin = { brain: { askWillJoin: () => true } };
    const ctxNew = { brain: { askWillJoin: () => false } };
    const fn = brainAskTool.suppressActionCard;
    expect(fn?.({ question: "q" }, ctxJoin as never)).toBe(true);
    expect(fn?.({ question: "q" }, ctxNew as never)).toBe(false);
  });
});

describe("§7.2.4 итог подтверждения доходит до модели сразу", () => {
  it("вердикт approved по голосу: модель прерывается немедленно, не ждёт тишины", async () => {
    vi.useFakeTimers();
    const { CallSession } = await import("../src/call-session.js");
    const { CallStore } = await import("../src/call-store.js");
    const Database = (await import("better-sqlite3")).default;
    const store = new CallStore(new Database(":memory:"));
    const frames: Array<Record<string, unknown>> = [];
    const injected: string[] = [];
    const s = new CallSession({
      callId: "call_724",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: {} as never,
      toBrowser: (f: Record<string, unknown>) => frames.push(f),
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
    } as never);
    // Модель «говорит»: имитируем проигрываемый звук хода
    (s as never as { voiceTalking: boolean }).voiceTalking = true;
    (s as never as { lastAudioTurnSeq: number }).lastAudioTurnSeq = 3;
    (s as never as { voice: { sendClientContent(t: string): void } }).voice = {
      sendClientContent: (t: string) => injected.push(t),
    };

    const gate = (s as never as { gate: ConfirmationGate }).gate;
    const req = gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
    if (!("pending" in req)) throw new Error("нет pending");
    const p = req.pending;
    (s as never as { storedArgs: Map<string, Record<string, unknown>> }).storedArgs.set(p.argsHash, { text: "x" });
    (s as never as { projectConnectorTools: unknown[] }).projectConnectorTools.push({
      name: "thread_send",
      cls: "C",
      parameters: {},
      execute: async () => ({ ok: true, data: { sent: true } }),
    });

    await (s as never as { onVerdict(...a: unknown[]): Promise<void> }).onVerdict(p, "approved", "barge", Date.now());
    expect(frames.some((f) => f.type === "interrupted")).toBe(true);
    expect(injected.some((t) => t.includes("уже выполняется"))).toBe(true);
    expect(injected.some((t) => t.includes("выполнено"))).toBe(true);
    vi.useRealTimers();
  });
});

describe("§7.2.1–7.2.2 «да» по кадру speech_start против снимка запроса", () => {
  function setup(opts?: { turns?: number; bytes?: number; noInject?: boolean }) {
    const t = fakeClock();
    const verdicts: Array<{ v: string; via?: string; timing?: string }> = [];
    const early: Array<Record<string, unknown>> = [];
    const decisions: Array<Record<string, unknown>> = [];
    let injects = 0;
    let reasks = 0;
    const phases: string[] = [];
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_p, v, via, _at, timing) => verdicts.push({ v, via, timing }),
      onEarlyApprovalLogged: (_p, info) => early.push(info as unknown as Record<string, unknown>),
      ...(opts?.noInject ? {} : { onEarlyApproval: () => injects++ }),
      onBargeDecision: (_p, info) => decisions.push(info as unknown as Record<string, unknown>),
      onReaskQuestion: () => reasks++,
      onConfirmationUpdate: (_p, phase) => phases.push(phase),
    });
    // Открытый ход на момент запроса (или последний выданный) — снимок requestTurnSeq/requestTurnMs.
    if (opts?.turns) for (let s = 1; s <= opts.turns; s++) gate.onModelAudio(s, opts.bytes ?? 48000, t.now);
    gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
    return { t, gate, verdicts, early, decisions, phases, reasks: { get n() { return reasks; } }, injects: { get n() { return injects; } } };
  }
  const sayDa = (gate: ConfirmationGate, t: ReturnType<typeof fakeClock>, chunk = "да") => {
    gate.onOwnerTranscriptChunk(chunk, t.now);
    t.advance(800);
  };

  it("«да» с кадром хода после запроса и playedMs > 0 → approved via barge (в т.ч. фраза ожидания, транскрипт 2,5 с)", () => {
    const { t, gate, verdicts, decisions } = setup();
    gate.onModelAudio(1, 48000 * 4, t.now); // фраза ожидания + вопрос в одном ходе
    gate.onModelTranscript("Секунду. Отправить в тред: «x»?", t.now, 1);
    t.advance(2500); // транскрипт приходит через 2,5 с — не мешает
    gate.onSpeechStart(1, 500, t.now); // речь началась ≥1,5 с после запроса
    sayDa(gate, t);
    expect(verdicts).toEqual([{ v: "approved", via: "barge", timing: "client" }]);
    expect(decisions.at(-1)).toMatchObject({ result: "approved", turnSeq: 1, playedMs: 500, requestTurnSeq: 0, requestTurnMs: 0 });
  });

  it("тот же ход, что на момент запроса: playedMs ≤ requestTurnMs → раннее, > requestTurnMs → approved", () => {
    // Открытый ход 1: к запросу получено 1 с звука.
    const a = setup({ turns: 1, bytes: 48000 });
    a.gate.onModelAudio(1, 48000 * 2, a.t.now); // ещё 2 с после запроса
    a.t.advance(2000);
    a.gate.onSpeechStart(1, 800, a.t.now);
    sayDa(a.gate, a.t);
    expect(a.verdicts).toEqual([]);
    expect(a.early.at(-1)).toMatchObject({ timing: "client", requestTurnSeq: 1 });
    expect(a.decisions.at(-1)).toMatchObject({ result: "early", requestTurnMs: 1000 });

    const b = setup({ turns: 1, bytes: 48000 });
    b.gate.onModelAudio(1, 48000 * 2, b.t.now);
    b.t.advance(2000);
    b.gate.onSpeechStart(1, 1600, b.t.now); // > requestTurnMs 1000 — звук именно после запроса
    sayDa(b.gate, b.t);
    expect(b.verdicts).toEqual([{ v: "approved", via: "barge", timing: "client" }]);
  });

  it("кадр хода раньше requestTurnSeq или playedMs = 0 → раннее", () => {
    const a = setup({ turns: 2, bytes: 48000 });
    a.t.advance(2000);
    a.gate.onSpeechStart(1, 900, a.t.now); // ход 1 < requestTurnSeq 2
    sayDa(a.gate, a.t);
    expect(a.verdicts).toEqual([]);
    expect(a.early.at(-1)).toMatchObject({ timing: "client" });

    const b = setup();
    b.gate.onModelAudio(1, 48000 * 2, b.t.now);
    b.t.advance(2000);
    b.gate.onSpeechStart(1, 0, b.t.now); // playedMs = 0 — раннее при любом turnSeq
    sayDa(b.gate, b.t);
    expect(b.verdicts).toEqual([]);
    expect(b.early.at(-1)).toMatchObject({ timing: "client" });
  });

  it("нет открытого хода на момент запроса: кадр последнего выданного — раннее; следующего хода — approved", () => {
    const a = setup({ turns: 1, bytes: 48000 * 3 });
    a.gate.onModelTurnComplete(1); // ход закрыт: requestTurnSeq=1, requestTurnMs=3000 (весь звук)
    a.t.advance(2000);
    a.gate.onSpeechStart(1, 3000, a.t.now); // проигран целиком — но звук пред-запросный
    sayDa(a.gate, a.t);
    expect(a.verdicts).toEqual([]);
    expect(a.decisions.at(-1)).toMatchObject({ result: "early", requestTurnSeq: 1, requestTurnMs: 3000 });

    const b = setup({ turns: 1, bytes: 48000 });
    b.gate.onModelTurnComplete(1);
    b.gate.onModelAudio(2, 48000, b.t.now); // ход ответа — после запроса
    b.t.advance(2000);
    b.gate.onSpeechStart(2, 50, b.t.now);
    sayDa(b.gate, b.t);
    expect(b.verdicts).toEqual([{ v: "approved", via: "barge", timing: "client" }]);
  });

  it("реплика в первые 1,5 с от запроса — хвост: по кадру (client) и по оценке (estimate)", () => {
    const a = setup({ noInject: true });
    a.gate.onSpeechStart(1, 100, a.t.now); // кадр: речь началась сразу после запроса
    a.t.advance(400);
    sayDa(a.gate, a.t, "ну отправь же это");
    expect(a.decisions.at(-1)).toMatchObject({ result: "tail", tailSource: "client", turnSeq: 1, playedMs: 100 });
    expect(a.verdicts).toEqual([]);

    const b = setup({ noInject: true });
    b.t.advance(1600); // без кадра: firstChunk − 2 с = −400 мс → хвост
    sayDa(b.gate, b.t);
    expect(b.decisions.at(-1)).toMatchObject({ result: "tail", tailSource: "estimate", turnSeq: null });
    // Настоящее «да» в хвосте — журнал early_approval timing "tail", без вставки.
    b.t.advance(800);
    expect(b.early.at(-1)).toMatchObject({ timing: "tail", requestTurnSeq: 0 });
    expect(b.injects.n).toBe(0);
    expect(b.verdicts).toEqual([]);
  });

  it("привязка кадра: >3 с до реплики — не привязан; два кадра — по порядку; кадр после первого куска — не привязан", () => {
    const a = setup({ noInject: true });
    a.gate.onModelAudio(1, 48000 * 4, a.t.now);
    a.gate.onSpeechStart(1, 500, a.t.now);
    a.t.advance(6000); // кадр старше 3 с к реплике — осиротел
    sayDa(a.gate, a.t);
    expect(a.decisions.at(-1)).toMatchObject({ result: "no_marker", turnSeq: null });
    expect(a.verdicts).toEqual([]);

    const b = setup({ noInject: true });
    b.gate.onModelAudio(1, 48000 * 6, b.t.now);
    b.t.advance(1600);
    b.gate.onSpeechStart(1, 0, b.t.now); // playedMs=0 → ранняя реплика
    sayDa(b.gate, b.t); // первая реплика берёт первый кадр → раннее
    expect(b.decisions.at(-1)).toMatchObject({ result: "early", playedMs: 0 });
    b.t.advance(1000);
    b.gate.onSpeechStart(1, 5000, b.t.now); // второй кадр — вторая реплика
    sayDa(b.gate, b.t); // → approved
    expect(b.verdicts).toEqual([{ v: "approved", via: "barge", timing: "client" }]);

    const c = setup({ noInject: true });
    c.gate.onModelAudio(1, 48000 * 4, c.t.now);
    c.t.advance(3500);
    c.gate.onOwnerTranscriptChunk("да", c.t.now); // первый кусок
    c.gate.onSpeechStart(1, 200, c.t.now); // кадр после куска — не привязывается
    c.t.advance(800);
    expect(c.decisions.at(-1)).toMatchObject({ result: "no_marker", turnSeq: null });
  });

  it("без кадра «да» — no_marker: одна вставка и early_approval timing no_marker; второе — только журнал", () => {
    const { t, gate, verdicts, early, decisions, injects } = setup();
    gate.onModelAudio(1, 48000 * 3, t.now);
    t.advance(3500); // без кадра — перебивание не засчитывается
    sayDa(gate, t);
    expect(verdicts).toEqual([]);
    expect(decisions.at(-1)).toMatchObject({ result: "no_marker", turnSeq: null, playedMs: null });
    expect(early.at(-1)).toMatchObject({ timing: "no_marker", requestTurnSeq: 0 });
    expect(injects.n).toBe(1);
    t.advance(1000); // конец хвоста
    sayDa(gate, t);
    expect(early.length).toBe(2);
    expect(injects.n).toBe(1); // вставка — раз на pending
  });

  it("окно после playback_drained хода ответа: «да» без кадра — via window", () => {
    const { t, gate, verdicts } = setup({ noInject: true });
    gate.onModelAudio(1, 48000, t.now);
    t.advance(300);
    gate.onPlaybackDrained(1, t.now);
    t.advance(2100);
    expect(gate.windowOpen()).toBe(true);
    sayDa(gate, t);
    expect(verdicts).toEqual([{ v: "approved", via: "window", timing: undefined }]);
  });

  it("модель молчит 4 с после запроса → один повтор; после повтора тишина — окна нет (резерв тоже), кнопка работает", () => {
    const { t, gate, verdicts, reasks, phases } = setup({ noInject: true });
    t.advance(4100);
    gate.tick();
    expect(reasks.n).toBe(1);
    gate.tick();
    expect(reasks.n).toBe(1); // не дублируется
    // Модель молчит и после повтора: окна нет даже по резервному таймеру.
    t.advance(10_000);
    for (let i = 0; i < 3; i++) gate.tick();
    expect(phases).not.toContain("listening");
    sayDa(gate, t);
    expect(verdicts).toEqual([]);
    const p = gate.pendingConfirmation()!;
    expect(gate.decide(p.confirmationId, "approve")).toBe("approved");
  });

  it("реплика владельца сдвигает тишину повтора: до реплики — нет, после 4 с — повтор", () => {
    const { t, gate, reasks } = setup({ noInject: true });
    t.advance(2000);
    gate.onOwnerTranscriptChunk("ну что там", t.now); // реплика-не-согласие
    t.advance(3000); // от запроса 5 с, от реплики 3 с — повтора нет
    gate.tick();
    expect(reasks.n).toBe(0);
    t.advance(1200); // от реплики 4,2 с
    gate.tick();
    expect(reasks.n).toBe(1);
  });

  it("резервное окно — только при проигранном звуке ответа: нет кадров/итогов → нет окна", () => {
    const { t, gate, phases, reasks } = setup({ noInject: true });
    gate.onModelAudio(1, 48000 * 2, t.now); // звук получен, но проигрывание не подтверждено
    t.advance(4600);
    gate.tick();
    t.advance(1000); // t0+5600: оценка (~3 с) + DRAINED_LOST_SLACK прошли, повтор ещё рано (конец ~2 с + 4 с)
    gate.tick();
    expect(phases).not.toContain("listening");
    expect(reasks.n).toBe(0); // < 4 с тишины от ожидаемого конца — повтор ещё не выстрелил
    // Тот же сценарий + playback_stopped с проигранным звуком после запроса → окно.
    gate.onPlaybackStopped(1, 1500);
    t.advance(300);
    gate.tick();
    expect(gate.windowOpen()).toBe(true);
  });

  it("кадр speech_start с проигранным звуком после запроса тоже открывает резервное окно", () => {
    const { t, gate, phases } = setup({ noInject: true });
    gate.onModelAudio(1, 48000 * 2, t.now);
    gate.onSpeechStart(1, 500, t.now); // ход 1 > requestTurnSeq 0, playedMs > 0 — проигрыш подтверждён
    t.advance(6200); // оценка ~3 с + DRAINED_LOST_SLACK 2,5 с прошли
    gate.tick();
    t.advance(400);
    gate.tick();
    expect(phases).toContain("listening");
  });

  it("вставка «повтори вопрос» общая на pending: по тишине, затем раннее «да» — только журнал", () => {
    const { t, gate, early, injects, reasks } = setup();
    t.advance(4100);
    gate.tick();
    expect(reasks.n).toBe(1);
    gate.onModelAudio(1, 48000, t.now); // модель наконец заговорила
    t.advance(2000);
    gate.onSpeechStart(1, 0, t.now); // раннее «да» — вставки больше нет
    sayDa(gate, t);
    expect(early.length).toBe(1);
    expect(injects.n).toBe(0);
  });

  it("эхо вопроса и не-согласие — как §7.1: не решают ничего", () => {
    const { t, gate, verdicts, decisions } = setup({ noInject: true });
    gate.onModelAudio(1, 48000 * 4, t.now);
    t.advance(2000);
    gate.onSpeechStart(1, 500, t.now);
    sayDa(gate, t, "отправить в тред"); // эхо
    expect(decisions.at(-1)?.result).toBe("echo");
    t.advance(1000);
    sayDa(gate, t, "подожди не надо");
    expect(decisions.at(-1)?.result).toBe("not_approval");
    expect(verdicts).toEqual([]);
  });

  it("playback_stopped с playedMs = 0: окна нет и «да» не засчитано — владелец не слышал звука ответа (r8)", () => {
    const { t, gate, verdicts, phases } = setup({ noInject: true });
    gate.onModelAudio(1, 48000 * 4, t.now); // вопрос получен сервером (4 с звука)
    gate.onModelInterrupted(1); // обрыв со стороны модели
    t.advance(400);
    gate.onPlaybackStopped(1, 0); // ни одного байта не проиграно
    t.advance(5200); // оценка сервера (4 с + 1 с + отступы) и запас прошли
    gate.tick();
    expect(gate.windowOpen()).toBe(false);
    expect(phases).not.toContain("listening");
    sayDa(gate, t);
    expect(verdicts).toEqual([]); // «да» не засчитано — ни barge, ни window
  });

  it("playback_stopped хода запроса с playedMs ≤ requestTurnMs: звук после запроса не проигран — окна нет", () => {
    const { t, gate, verdicts } = setup({ turns: 1, bytes: 48000 }); // ход 1 открыт, requestTurnMs=1000
    gate.onModelAudio(1, 48000 * 2, t.now); // ещё 2 с звука после запроса
    t.advance(300);
    gate.onPlaybackStopped(1, 800); // проиграно меньше, чем получено к запросу (800 < 1000)
    t.advance(4000);
    gate.tick();
    expect(gate.windowOpen()).toBe(false);
    sayDa(gate, t);
    expect(verdicts).toEqual([]);
  });

  it("кадр speech_start с turnSeq = 0 звуком не считается: playedMs > 0 при requestTurnSeq 0 → раннее", () => {
    const { t, gate, verdicts, early, decisions, phases } = setup({ noInject: true });
    t.advance(2000);
    gate.onSpeechStart(0, 5000, t.now); // кадр «до первого хода» — не звук ответа
    sayDa(gate, t);
    expect(verdicts).toEqual([]);
    expect(decisions.at(-1)).toMatchObject({ result: "early", turnSeq: 0, playedMs: 5000 });
    expect(early.at(-1)).toMatchObject({ timing: "client", requestTurnSeq: 0 });
    // И проигрыш не засчитан: резервное окно не открывается даже со звуком.
    gate.onModelAudio(1, 48000 * 2, t.now);
    t.advance(3000); // < 4 с — повтор ещё не выстрелил
    gate.tick();
    expect(phases).not.toContain("listening");
    expect(gate.windowOpen()).toBe(false);
  });

  it("неподтверждённый звук не блокирует повтор по тишине: обрыв без playback_stopped → вставка через 4 с; drained → повтор не нужен", () => {
    // Старый клиент: ход оборван, playback_stopped так и не пришёл.
    const { t, gate, reasks } = setup({ noInject: true });
    gate.onModelAudio(1, 48000 * 4, t.now); // вопрос получен сервером
    gate.onModelInterrupted(1); // обрыв — итог проигрыша неизвестен
    t.advance(4100); // 4 с без нового звука и без реплики
    gate.tick();
    expect(reasks.n).toBe(1); // одна вставка повтора
    t.advance(5000);
    gate.tick();
    expect(reasks.n).toBe(1); // не дублируется

    // Звук ответа проигран (drained) — повтор по тишине не выстреливает.
    const { t: t2, gate: g2, reasks: r2 } = setup({ noInject: true });
    g2.onModelAudio(1, 48000, t2.now);
    g2.onPlaybackDrained(1, t2.now);
    t2.advance(4200);
    g2.tick();
    expect(r2.n).toBe(0);
  });
});

describe("§7.2.1 браузер: TurnPlayer — позиция от начала хода и прерванный ход", () => {
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
  const pcmSec = (s: number) => new Uint8Array(s * 48000); // 24 кГц × 2 байта

  it("playedMs — от первого буфера хода, а не текущего (ход из нескольких буферов)", async () => {
    const { TurnPlayer } = await import("../src/ui/engine.js");
    const { ctx, sources } = fakeCtx(10);
    const player = new TurnPlayer(ctx as never, () => {});
    player.enqueue(5, pcmSec(2)); // буфер 1: старт 10.015, до 12.015
    player.enqueue(5, pcmSec(2)); // буфер 2: до 14.015
    ctx.currentTime = 11.0;
    expect(player.playbackPosition()?.playedMs).toBeGreaterThan(900);
    expect(player.playbackPosition()?.playedMs).toBeLessThan(1100);
    // Первый буфер доиграл — играет второй; playedMs всё равно от начала хода.
    sources[0].onended?.();
    ctx.currentTime = 12.5;
    const pos = player.playbackPosition();
    expect(pos?.turnSeq).toBe(5);
    expect(pos?.playedMs).toBeGreaterThan(2400); // ~2485 мс, а не ~485 от буфера 2
    expect(pos?.playedMs).toBeLessThan(2600);
  });

  it("interrupted: прерванный ход отчитывается реально проигранным, а не полным буфером", async () => {
    const { TurnPlayer } = await import("../src/ui/engine.js");
    const { ctx } = fakeCtx(10);
    const player = new TurnPlayer(ctx as never, () => {});
    player.enqueue(7, pcmSec(4)); // 4 с
    ctx.currentTime = 11.0; // играло ~1 с
    player.interrupted();
    const pos = player.playbackPosition();
    expect(pos?.turnSeq).toBe(7);
    expect(pos?.playedMs).toBeGreaterThan(900); // ~985 мс реально прозвучало
    expect(pos?.playedMs).toBeLessThan(1200); // а не 4000 мс полного буфера
  });
});

describe("§7.2.1 журнал звонка: кадр speech_start и решение barge_decision", () => {
  it("каждый кадр браузера — событие speech_start в журнале (контракт §11)", async () => {
    vi.useFakeTimers();
    const { CallSession } = await import("../src/call-session.js");
    const { CallStore } = await import("../src/call-store.js");
    const Database = (await import("better-sqlite3")).default;
    const store = new CallStore(new Database(":memory:"));
    const s = new CallSession({
      callId: "call_ss",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: {} as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
    } as never);
    s.onSpeechStart(3, 1250);
    s.onSpeechStart(4, 0);
    const events = store.transcript("call_ss").filter((e) => e.kind === "speech_start");
    expect(events.length).toBe(2);
    expect(JSON.parse(events[0].payload)).toEqual({ turnSeq: 3, playedMs: 1250 });
    expect(JSON.parse(events[1].payload)).toEqual({ turnSeq: 4, playedMs: 0 });
    vi.useRealTimers();
  });
});
