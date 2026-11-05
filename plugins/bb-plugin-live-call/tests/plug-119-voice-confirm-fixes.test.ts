/**
 * Тесты PLUG-119: голосовые баги приёмки PLUG-116:
 * - Баг 1: раннее «да» во время филлера → прерывание модели вставкой «НЕ подтверждение»;
 *          ложный доклад об исполнении (false_claim) при pending → вставка и запись в журнал;
 * - Баг 2: эхо в окне ответа («отправ», «да» из вопроса) → не решает ничего, pending жив;
 *          «отмена» владельца → cancelled; подсказка L/P не входит в эхо;
 * - Аудит куратора: проверка TTL на голосовых путях и в confirmAction (защита от гонки до тика).
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import { classify, DEFAULT_WORDS, isEchoWord, isFalseClaim } from "../src/classify.js";
import { ConfirmationGate, type GateClock, type PendingConfirmation } from "../src/confirmation-gate.js";

/** Часы без реального времени: setTimeout только по advance. */
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

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(public url: string) {
    FakeWs.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.fire("open", {});
    }, 0);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "" });
  }
  fire(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  server(msg: unknown) {
    this.fire("message", { data: JSON.stringify(msg) });
  }
}

function makeSession(
  store = new CallStore(new Database(":memory:")),
  mode: "normal" | "extended" = "normal",
  allowExtended = mode === "extended",
) {
  const frames: Array<Record<string, unknown>> = [];
  const s = new CallSession({
    callId: "call_plug119",
    keys: mode === "extended" ? ["k1", "k2"] : ["k1"],
    voice: "Algenib",
    languageCode: "ru-RU",
    thinkingLevel: "LOW",
    mode,
    allowExtended,
    routerInput: "text",
    maxCallMinutes: 60,
    store,
    sdk: {} as never,
    toBrowser: (f) => frames.push(f as Record<string, unknown>),
    sendBrowserAudio: () => {},
    spawnCallThread: async () => null,
    advanceCallThread: async () => {},
    sayCallThread: async () => {},
    endCallThread: async () => {},
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
  });
  return { s, store, frames };
}

describe("Баг 1. Раннее «да» во время филлера (§7.1 п. 3.1)", () => {
  it("раннее «да» до того, как вопрос зазвучал → вставка «НЕ подтверждение», модель прерывается", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const { s, store, frames } = makeSession();
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const req = gate.request("thread_send", { text: "Проверка перебивания" }, "C", "Отправить в тред: «Проверка перебивания»?");
    expect("pending" in req).toBe(true);

    // Модель отдаёт звук филлера (3 секунды) и кусок транскрипта
    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: btoa("\x00\x01\x02\x03".repeat(12000)) } }],
        },
        outputTranscription: { text: "Секунду, отправляю сообщение агенту." },
      },
    });

    // Владелец говорит «да» на 1.8 с (филлер ещё играет, вопрос ещё не звучал)
    await vi.advanceTimersByTimeAsync(1800);
    gate.onOwnerTranscriptChunk("да", Date.now());

    // Ждём 700 мс окончания реплики (правило п. 4)
    await vi.advanceTimersByTimeAsync(750);

    // Проверяем: ход оборван (interrupted), отправлена системная вставка «НЕ подтверждение»
    expect(frames.some((f) => f.type === "interrupted")).toBe(true);
    const injected = ws.sent.filter((x) => x.includes("Владелец сказал «да» до вопроса — это НЕ подтверждение"));
    expect(injected.length).toBeGreaterThanOrEqual(1);

    // Действие не выполнено, вердикта нет (pending жив)
    expect(gate.pendingConfirmation()?.verdict).toBeNull();
    await s.end("owner");
    vi.useRealTimers();
  });

  it("решение по завершённой реплике: «да, но сначала...» не является согласием и не вызывает вставку", () => {
    const t = fakeClock();
    let earlyApprovalCount = 0;
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onEarlyApproval: () => {
        earlyApprovalCount++;
      },
    });

    gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
    gate.onModelAudio(1, 48000 * 3, t.now);
    gate.onModelTranscript("Секунду, отправляю...", t.now);

    // Владелец говорит: «да, но сначала»
    t.advance(1800);
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(200);
    gate.onOwnerTranscriptChunk(" но сначала прочитай тред", t.now);
    t.advance(800);

    // Завершённая реплика — не согласие («но» — стоп-слово), вставка «не подтверждение» не вызывается
    expect(earlyApprovalCount).toBe(0);
    expect(gate.pendingConfirmation()?.verdict).toBeNull();
  });

  it("на один вопрос вставляется не больше одной такой реплики; повторные куски не дублируют вставку", () => {
    const t = fakeClock();
    let earlyApprovalCount = 0;
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onEarlyApproval: () => {
        earlyApprovalCount++;
      },
    });

    gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
    gate.onModelAudio(1, 48000 * 3, t.now);
    gate.onModelTranscript("Секунду, передаю...", t.now);

    // Первое раннее «да»
    t.advance(1800);
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(800);
    expect(earlyApprovalCount).toBe(1);

    // Повторное «да» до нового вопроса
    t.advance(200);
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(800);
    expect(earlyApprovalCount).toBe(1);
  });

  it("P1: филлер без названия объекта действия не устанавливает question_heard и не даёт вердикта при «да»", () => {
    const t = fakeClock();
    const verdicts: string[] = [];
    let heard = 0;
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_, x) => verdicts.push(x),
      onQuestionHeardAt: () => heard++,
    });
    gate.request("thread_send", { text: "Секретное сообщение" }, "C", "Отправить в тред: «Секретное сообщение»?");
    gate.onModelAudio(1, 4800, t.now);
    gate.onModelTranscript("Секунду, я собираюсь отправить в тред", t.now);
    gate.onModelAudio(1, 48000 * 10, t.now);
    t.advance(1800);
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(700);
    expect(heard).toBe(0);
    expect(verdicts).toEqual([]);
  });

  it("P1: слова аргумента («в», «тред») не вызывают question_heard при филлере (репро Review 2)", () => {
    const clock = fakeClock();
    const verdicts: string[] = [];
    let heard = 0;
    const gate = new ConfirmationGate(DEFAULT_WORDS, clock.clock, {
      onVerdict: (_, v) => verdicts.push(v),
      onQuestionHeardAt: () => heard++,
    });
    const text = "Секретное сообщение в рабочий тред";
    gate.request("thread_send", { text }, "C", `Отправить в тред: «${text}»?`);
    gate.onModelAudio(1, 4800, clock.now);
    gate.onModelTranscript("Секунду, я собираюсь отправить в тред", clock.now);
    gate.onModelAudio(1, 48000 * 10, clock.now);
    clock.advance(1800);
    gate.onOwnerTranscriptChunk("да", clock.now);
    clock.advance(700);
    expect(heard).toBe(0);
    expect(verdicts).toEqual([]);
    expect(gate.windowOpen()).toBe(false);
  });

  it("P1: CallSession не исполняет действие на филлер с общими словами аргумента (репро Review 2)", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const executions: Array<Record<string, unknown>> = [];
    (s as unknown as { projectConnectorTools: unknown[] }).projectConnectorTools.push({
      name: "review_action",
      cls: "C",
      description: "Fixture",
      parameters: { type: "object" },
      execute: async (args: Record<string, unknown>) => {
        executions.push(args);
        return { ok: true, data: {} };
      },
    });

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const args = { text: "Секретное сообщение в рабочий тред" };
    const req = gate.request("review_action", args, "C", `Отправить в тред: «${args.text}»?`);
    if (!("pending" in req)) throw new Error("pending rejected");
    (s as unknown as { storedArgs: Map<string, Record<string, unknown>> }).storedArgs.set(req.pending.argsHash, args);

    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 10).toString("base64") } }],
        },
        outputTranscription: { text: "Секунду, я собираюсь отправить в тред" },
      },
    });
    await vi.advanceTimersByTimeAsync(1800);

    ws.server({ serverContent: { inputTranscription: { text: "да" } } });
    await vi.advanceTimersByTimeAsync(800);

    expect(executions.length).toBe(0);
    expect(store.transcript("call_plug119").some((e) => e.kind === "question_heard")).toBe(false);

    await s.end("owner");
    vi.useRealTimers();
  });

  it("P1: вопрос с названием объекта действия устанавливает question_heard и даёт approved после воспроизведения", () => {
    const t = fakeClock();
    const verdicts: string[] = [];
    let heard = 0;
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_, x) => verdicts.push(x),
      onQuestionHeardAt: () => heard++,
    });
    gate.request("thread_send", { text: "Секретное сообщение" }, "C", "Отправить в тред: «Секретное сообщение»?");
    gate.onModelAudio(1, 4800, t.now);
    gate.onModelTranscript("Отправить в тред: «Секретное сообщение»?", t.now);
    expect(heard).toBe(1);
    t.advance(1800);
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(700);
    expect(verdicts).toEqual(["approved"]);
  });

  it("P1: вопрос без названия объекта: филлер не засчитывается, согласие только в окне", () => {
    const t = fakeClock();
    const verdicts: string[] = [];
    let heard = 0;
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_, x) => verdicts.push(x),
      onQuestionHeardAt: () => heard++,
    });
    gate.request("thread_stop", {}, "C", "Остановить?");
    gate.onModelAudio(1, 4800, t.now);
    gate.onModelTranscript("Секунду, останавливаю", t.now);
    t.advance(1800);
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(700);
    expect(heard).toBe(0);
    expect(verdicts).toEqual([]);
  });

  it("сценарий восстановления Ф3: раннее «да» → перезадание вопроса с тем же confirmationId/argsHash → вердикт approved", () => {
    const t = fakeClock();
    let earlyApprovalCount = 0;
    const verdicts: string[] = [];
    let heardCount = 0;

    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onEarlyApproval: () => {
        earlyApprovalCount++;
      },
      onVerdict: (_p, v) => verdicts.push(v),
      onQuestionHeardAt: () => {
        heardCount++;
      },
    });

    const r = gate.request("thread_send", { text: "сообщение" }, "C", "Отправить в тред: «сообщение»?");
    if (!("pending" in r)) throw new Error("нет pending");
    const initialId = r.pending.confirmationId;
    const initialHash = r.pending.argsHash;
    const initialTtl = r.pending.expiresAt;

    // 1. Модель говорит филлер
    gate.onModelAudio(1, 48000 * 3, t.now);
    gate.onModelTranscript("Секунду, отправляю сообщение...", t.now);

    // 2. Раннее «да» во время филлера
    t.advance(1800);
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(800);
    expect(earlyApprovalCount).toBe(1);
    expect(verdicts).toEqual([]);

    // ConfirmationId, argsHash и TTL сохранены
    const p = gate.pendingConfirmation();
    expect(p?.confirmationId).toBe(initialId);
    expect(p?.argsHash).toBe(initialHash);
    expect(p?.expiresAt).toBe(initialTtl);

    // Запоздалый playback_drained от прерванного turn 1 игнорируется
    gate.onPlaybackDrained(1, t.now);
    expect(gate.windowOpen()).toBe(false);

    // 3. Модель перезадаёт вопрос (turn 2)
    t.advance(200);
    gate.onModelAudio(2, 4800, t.now);
    gate.onModelTranscript("Отправить в тред: «сообщение»?", t.now);
    expect(heardCount).toBe(1);

    // 4. Действительное согласие владельца после того, как вопрос зазвучал
    t.advance(1000);
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(800);

    expect(verdicts).toEqual(["approved"]);
    expect(gate.pendingConfirmation()?.verdict).toBe("approved");
  });
});

describe("Баг 1 (продолжение). Ложный доклад об исполнении (false_claim, §7.1 п. 9)", () => {
  it("ложное «отправлено» при живом pending без вердикта → событие false_claim и прерывание модели", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s, frames } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    gate.request("thread_send", { text: "Проверка" }, "C", "Отправить в тред: «Проверка»?");

    // Модель завершает ход заявлением об исполнении, не дождавшись подтверждения
    ws.server({
      serverContent: {
        outputTranscription: { text: "Сообщение отправлено в тред." },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    // Событие false_claim записано в БД звонка
    const events = store.transcript("call_plug119");
    const falseClaimEvent = events.find((e) => e.kind === "false_claim");
    expect(falseClaimEvent).toBeDefined();
    const payload = JSON.parse(falseClaimEvent?.payload ?? "{}") as { tool?: string };
    expect(payload.tool).toBe("thread_send");

    // Модели отправлена вставка с требованием задать вопрос
    const injected = ws.sent.filter((x) => x.includes("Действие ещё не подтверждено и не выполнено"));
    expect(injected.length).toBe(1);

    await s.end("owner");
    vi.useRealTimers();
  });

  it("isFalseClaim: целые слова из списка докладов срабатывают", () => {
    const say = "Отправить в тред: «Текст»?";
    expect(isFalseClaim("Сообщение отправлено в тред.", say)).toBe(true);
    expect(isFalseClaim("Уже отправил сообщение.", say)).toBe(true);
    expect(isFalseClaim("Всё готово.", say)).toBe(true);
    expect(isFalseClaim("Задание выполнено.", say)).toBe(true);
    expect(isFalseClaim("Я выполнил всё.", say)).toBe(true);
    expect(isFalseClaim("Всё сделано.", say)).toBe(true);
    expect(isFalseClaim("Сделал.", say)).toBe(true);
    expect(isFalseClaim("Создано новое сообщение.", say)).toBe(true);
    expect(isFalseClaim("Создал ветку.", say)).toBe(true);
    expect(isFalseClaim("Запущено успешно.", say)).toBe(true);
    expect(isFalseClaim("Запустил агента.", say)).toBe(true);
    // Расширенный список п. 9 (§7.1 п. 9)
    expect(isFalseClaim("Ваш ответ отправлен агенту.", say)).toBe(true);
    expect(isFalseClaim("Отправлена новая версия.", say)).toBe(true);
    expect(isFalseClaim("Я отправила сообщение.", say)).toBe(true);
    expect(isFalseClaim("Передано на проверку.", say)).toBe(true);
    expect(isFalseClaim("Передан запрос.", say)).toBe(true);
    expect(isFalseClaim("Передала информацию.", say)).toBe(true);
    expect(isFalseClaim("Задача выполнена.", say)).toBe(true);
    expect(isFalseClaim("Выполнила работу.", say)).toBe(true);
    expect(isFalseClaim("Сделала дело.", say)).toBe(true);
    expect(isFalseClaim("Задача успешно создана.", say)).toBe(true);
    expect(isFalseClaim("Создала проект.", say)).toBe(true);
    expect(isFalseClaim("Запустила агента.", say)).toBe(true);
    // «создан» НЕ в списке
    expect(isFalseClaim("Этот тред создан для тестов.", say)).toBe(false);
  });

  it("isFalseClaim: исключение с предшествующим «не» не считается докладом", () => {
    const say = "Отправить в тред: «Текст»?";
    expect(isFalseClaim("Сообщение ещё не отправлено.", say)).toBe(false);
    expect(isFalseClaim("Действие не выполнено из-за ошибки.", say)).toBe(false);
    expect(isFalseClaim("Ещё не готово.", say)).toBe(false);
  });

  it("isFalseClaim: правильный вопрос (say-фраза) не даёт false_claim, даже если текст содержит «отправлено»/«готово»", () => {
    const say = "Отправить в тред: «отправлено»?";
    const card = "отправлено";
    expect(isFalseClaim("Отправить в тред: «отправлено»?", say, card)).toBe(false);

    const say2 = "Отправить в тред: «Отчёт готов»?";
    const card2 = "Отчёт готов";
    expect(isFalseClaim("Отправить в тред: «Отчёт готов»?", say2, card2)).toBe(false);
  });

  it("isFalseClaim: «[вопрос]. Уже отправлено» и «Сообщение отправлено в тред» при отправке текста «отправлено» остаются докладом", () => {
    const say = "Отправить в тред: «отправлено»?";
    const card = "отправлено";
    // Вопрос задан, но модель приписала утверждение об исполнении
    expect(isFalseClaim("Отправить в тред: «отправлено»? Уже отправлено.", say, card)).toBe(true);
    // Вопрос пропущен, сказано о выполнении
    expect(isFalseClaim("Сообщение отправлено в тред.", say, card)).toBe(true);
  });

  it("P2: исключение цитаты не скрывает самостоятельный ложный доклад об исполнении (репро ревьюера)", () => {
    const say = "Отправить в тред: «отправлено»?";
    expect(isFalseClaim("Текст «отправлено». Сообщение отправлено в тред.", say, "отправлено")).toBe(true);
    expect(isFalseClaim("Отправить в тред, «отправлено»? Уже отправлено.", say, "отправлено")).toBe(true);
    expect(isFalseClaim("Отправить сообщение «отправлено» в этот тред?", say, say)).toBe(false);
  });

  it("P2: правильный вопрос без кавычек не считается false_claim (репро Review 2)", () => {
    const say = "Отправить в тред: «отправлено»?";
    for (const turn of ["Отправить в тред отправлено", "Отправить в тред: отправлено?"]) {
      expect(isFalseClaim(turn, say, say)).toBe(false);
    }
    expect(isFalseClaim(say, say, say)).toBe(false);
    expect(isFalseClaim("Отправить в тред отправлено. Уже отправлено.", say, say)).toBe(true);
    expect(isFalseClaim("Отправить в тред: «отправлено»? Уже отправлено.", say, say)).toBe(true);
  });

  it("P2: false_claim после turnComplete при буферизованном аудио браузера сбрасывает буфер (кадр interrupted)", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s, frames } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    gate.request("thread_send", { text: "Проверка" }, "C", "Отправить в тред: «Проверка»?");

    // 5 секунд аудио отправлено в браузер, затем доклад в outputTranscript и turnComplete
    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
        },
        outputTranscription: { text: "Сообщение отправлено в тред." },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(store.transcript("call_plug119").some((e) => e.kind === "false_claim")).toBe(true);
    expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);
    // Браузер получил кадр interrupted для сброса играющего звука
    expect(frames.some((f) => f.type === "interrupted")).toBe(true);

    await s.end("owner");
    vi.useRealTimers();
  });

  it("P2: false_claim детерминированно ловит слово доклада, разрезанное между outputTranscript-кусками", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    gate.request("thread_send", { text: "Проверка" }, "C", "Отправить в тред: «Проверка»?");

    // Слово «отправлено» разрезано между кусками: «отправ» + «лено»
    ws.server({ serverContent: { outputTranscription: { text: "Сообщение отправ" } } });
    ws.server({ serverContent: { outputTranscription: { text: "лено в тред." }, turnComplete: true } });
    await vi.advanceTimersByTimeAsync(20);

    expect(store.transcript("call_plug119").some((e) => e.kind === "false_claim")).toBe(true);
    expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);

    await s.end("owner");
    vi.useRealTimers();
  });

  it("на один pending — не больше одной вставки false_claim", () => {
    const gate = new ConfirmationGate(DEFAULT_WORDS);
    gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");

    expect(gate.checkFalseClaim("Сообщение отправлено.")).toBe(true);
    // Повторный ход модели с ложным утверждением не даёт вторую вставку
    expect(gate.checkFalseClaim("Уже всё готово.")).toBe(false);
  });

  it("после вердикта approved те же слова — обычная речь, false_claim не срабатывает", () => {
    const gate = new ConfirmationGate(DEFAULT_WORDS);
    const r = gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
    if (!("pending" in r)) throw new Error("no pending");

    gate.decide(r.pending.confirmationId, "approve");
    // Pending одобрен — доклад об исполнении законен
    expect(gate.checkFalseClaim("Сообщение отправлено в тред.")).toBe(false);
  });
});

describe("Баг 2. Эхо в окне ответа (§7.1 п. 5)", () => {
  it("эхо-обрывок «отправ» в окне ответа → вердикта нет, pending жив; «отмена» владельца после него → cancelled", () => {
    const t = fakeClock();
    const verdicts: string[] = [];
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_p, v) => verdicts.push(v),
    });

    gate.request("thread_send", { text: "Проверка эха" }, "C", "Отправить в тред: «Проверка эха»?");
    // Открываем окно ответа
    gate.onModelAudio(1, 48000, t.now);
    t.advance(300);
    gate.onPlaybackDrained(1, t.now);
    t.advance(2100);
    expect(gate.windowOpen()).toBe(true);

    // 1. В микрофон попадает эхо вопроса («отправ» от «отправить»)
    gate.onOwnerTranscriptChunk("отправ", t.now);
    t.advance(800); // тишина 700 мс

    // Реплика-эхо не решает ничего: ни approved, ни cancelled; pending жив
    expect(verdicts).toEqual([]);
    expect(gate.pendingConfirmation()).not.toBeNull();
    expect(gate.pendingConfirmation()?.verdict).toBeNull();

    // 2. Владелец говорит «отмена»
    t.advance(5000);
    gate.onOwnerTranscriptChunk("отмена", t.now);
    t.advance(800);

    expect(verdicts).toEqual(["cancelled"]);
    expect(gate.pendingConfirmation()).toBeNull();
  });

  it("эхо «да» из вопроса, когда текст действия содержал «да» → нет вердикта, pending жив", () => {
    const t = fakeClock();
    const verdicts: string[] = [];
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_p, v) => verdicts.push(v),
    });

    gate.request("thread_send", { text: "да" }, "C", "Отправить в тред: «да»?", "да");
    // Открываем окно
    gate.onModelAudio(1, 48000, t.now);
    t.advance(300);
    gate.onPlaybackDrained(1, t.now);
    t.advance(2100);
    expect(gate.windowOpen()).toBe(true);

    // В микрофон попало эхо вопроса («да»)
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(800);

    // В вопросе было «да», поэтому голое «да» проглочено эхо-фильтром — вердикта нет
    expect(verdicts).toEqual([]);
    expect(gate.pendingConfirmation()).not.toBeNull();
  });

  it("isEchoWord: точные слова, 6-буквенные корни и обрывки-префиксы от 3 букв распознаются как эхо", () => {
    const echoSet = new Set(["отправить", "тред", "проверка"]);
    expect(isEchoWord("отправить", echoSet)).toBe(true);
    expect(isEchoWord("отправ", echoSet)).toBe(true); // 6 букв и префикс
    expect(isEchoWord("отпр", echoSet)).toBe(true); // префикс 4 буквы
    expect(isEchoWord("проверка", echoSet)).toBe(true);
    expect(isEchoWord("провер", echoSet)).toBe(true);

    // Не эхо
    expect(isEchoWord("отмена", echoSet)).toBe(false);
    expect(isEchoWord("запускай", echoSet)).toBe(false);
    expect(isEchoWord("да", echoSet)).toBe(false);
  });

  it("подсказка класса L/P не входит в эхо-набор: сказанное после подсказки «запускай» засчитывается", () => {
    const t = fakeClock();
    const verdicts: string[] = [];
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_p, v) => verdicts.push(v),
    });

    gate.request("start_thread", { project: "A", task: "x" }, "L", "Запустить агента в «A»?");
    // Открываем окно
    gate.onModelAudio(1, 48000, t.now);
    t.advance(300);
    gate.onPlaybackDrained(1, t.now);
    t.advance(2100);

    // Владелец говорит только «да» на класс L → hint
    gate.onOwnerUtteranceEnd("да", t.now, t.now);
    expect(gate.pendingConfirmation()).not.toBeNull();
    expect(gate.isMicOpen()).toBe(false);

    // Модель произносит подсказку («Для запуска скажи «запускай»») и окно переоткрывается
    gate.onModelAudio(2, 24000, t.now);
    t.advance(300);
    gate.onPlaybackDrained(2, t.now);
    t.advance(1900);
    expect(gate.windowOpen()).toBe(true);

    // Владелец говорит «запускай» — подсказка не входит в эхо-набор окна, засчитывается approved
    gate.onOwnerUtteranceEnd("запускай", t.now, t.now);
    expect(verdicts).toEqual(["approved"]);
    expect(gate.pendingConfirmation()?.verdict).toBe("approved");
  });
});

describe("Аудит куратора (ZCode): защита от гонки с TTL", () => {
  it("реплика-согласие, завершившаяся после expiresAt (тик драйвера ещё не наступил) → expired, исполнения нет", () => {
    const t = fakeClock();
    const verdicts: string[] = [];
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_p, v) => verdicts.push(v),
    });

    const r = gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
    if (!("pending" in r)) throw new Error("no pending");

    // Открываем окно
    gate.onModelAudio(1, 48000, t.now);
    t.advance(300);
    gate.onPlaybackDrained(1, t.now);
    t.advance(2100);

    // Продвигаем время почти до конца TTL (59.5 с от создания)
    t.advance(57_000);
    // Владелец начинает говорить «да» за 500 мс до истечения TTL
    gate.onOwnerTranscriptChunk("да", t.now);

    // Тишина 700 мс завершает реплику уже ПОСЛЕ expiresAt (+60.2 с)
    // Драйвер tick() ещё НЕ вызывал!
    t.advance(700);

    // Реплика завершилась после expiresAt → expired, а не approved
    expect(verdicts).toEqual(["expired"]);
    expect(gate.pendingConfirmation()).toBeNull();
  });

  it("confirmAction для pending после expiresAt (до тика драйвера) возвращает expired, а не approved", async () => {
    const t = fakeClock();
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock);

    const r = gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
    if (!("pending" in r)) throw new Error("no pending");
    const id = r.pending.confirmationId;

    // Продвигаем время за пределы expiresAt без вызова tick()
    t.advance(61_000);

    // confirmAction должен вернуть expired, а не зависать и не возвращать approved
    const verdict = await gate.confirmAction(id);
    expect(verdict).toBe("expired");
    expect(gate.pendingConfirmation()).toBeNull();
  });

  it("onBargeInChunk после expiresAt (до тика) сжигает pending как expired", () => {
    const t = fakeClock();
    const verdicts: string[] = [];
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock, {
      onVerdict: (_p, v) => verdicts.push(v),
    });

    gate.request("thread_send", { text: "x" }, "C", "Отправить в тред: «x»?");
    // Время истекло
    t.advance(61_000);

    // Входящий чанк перебивания
    gate.onOwnerTranscriptChunk("да", t.now);

    expect(verdicts).toEqual(["expired"]);
    expect(gate.pendingConfirmation()).toBeNull();
  });
});

describe("Сценарии восстановления Ф3 и гонки (§9 Ф3, §7.1)", () => {
  it("сессионный сценарий Ф3 (native): раннее «да» → вставка → повторный вопрос → ровно одно исполнение исходных аргументов", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s } = makeSession(store, "normal");
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const executedArgs: Array<Record<string, unknown>> = [];
    const customTool = {
      name: "action_test",
      description: "Test action",
      cls: "C" as const,
      parameters: { type: "object", properties: { target: { type: "string" } } },
      execute: async (args: Record<string, unknown>) => {
        executedArgs.push(args);
        return { ok: true, data: { status: "done" } };
      },
    };
    (s as unknown as { projectConnectorTools: unknown[] }).projectConnectorTools.push(customTool);

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const initialArgs = { target: "crm-prod", text: "Секретный ключ" };
    const req = gate.request("action_test", initialArgs, "C", "Отправить в CRM: «Секретный ключ»?");
    if (!("pending" in req)) throw new Error("pending rejected");
    const initialId = req.pending.confirmationId;
    const initialHash = req.pending.argsHash;
    const initialTtl = req.pending.expiresAt;
    (s as unknown as { storedArgs: Map<string, Record<string, unknown>> }).storedArgs.set(initialHash, initialArgs);

    // 1. Модель говорит филлер
    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 3).toString("base64") } }],
        },
        outputTranscription: { text: "Секунду, передаю..." },
      },
    });
    await vi.advanceTimersByTimeAsync(1800);

    // 2. Владелец говорит «да» во время филлера
    ws.server({ serverContent: { inputTranscription: { text: "да" } } });
    await vi.advanceTimersByTimeAsync(800);

    // Вставка отправлена, ничего не исполнено
    const injected = ws.sent.filter((x) => x.includes("Владелец сказал «да» до вопроса — это НЕ подтверждение"));
    expect(injected.length).toBe(1);
    expect(executedArgs.length).toBe(0);

    // Модель прерывается по вставке
    ws.server({ serverContent: { interrupted: true } });

    // Проверяем, что ID/TTL/argsHash сохранены
    const pending = gate.pendingConfirmation();
    expect(pending?.confirmationId).toBe(initialId);
    expect(pending?.argsHash).toBe(initialHash);
    expect(pending?.expiresAt).toBe(initialTtl);

    // 3. Модель перезадаёт вопрос (turn 2)
    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(4800).toString("base64") } }],
        },
        outputTranscription: { text: "Отправить в CRM: «Секретный ключ»?" },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(1000);

    // 4. Действительное согласие владельца
    ws.server({ serverContent: { inputTranscription: { text: "да" } } });
    await vi.advanceTimersByTimeAsync(800);

    // Проверяем: ровно одно исполнение с исходными аргументами
    expect(executedArgs.length).toBe(1);
    expect(executedArgs[0]).toEqual(initialArgs);

    await s.end("owner");
    vi.useRealTimers();
  });

  it("сессионный сценарий Ф3 (router): раннее «да» → вставка → повторный вопрос → ровно одно исполнение", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s } = makeSession(store, "extended");
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mode).toBe("extended");
    expect(FakeWs.all.length).toBeGreaterThanOrEqual(2);
    const ws = FakeWs.all[0];

    const executedArgs: Array<Record<string, unknown>> = [];
    const customTool = {
      name: "action_test_router",
      description: "Test router action",
      cls: "C" as const,
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async (args: Record<string, unknown>) => {
        executedArgs.push(args);
        return { ok: true, data: { status: "sent" } };
      },
    };
    (s as unknown as { projectConnectorTools: unknown[] }).projectConnectorTools.push(customTool);

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const initialArgs = { text: "Привет всем" };
    const req = gate.request("action_test_router", initialArgs, "C", "Отправить: «Привет всем»?");
    if (!("pending" in req)) throw new Error("pending rejected");
    const initialId = req.pending.confirmationId;
    const initialHash = req.pending.argsHash;
    const initialTtl = req.pending.expiresAt;
    (s as unknown as { storedArgs: Map<string, Record<string, unknown>> }).storedArgs.set(req.pending.argsHash, initialArgs);

    // Филлер + раннее «да»
    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 3).toString("base64") } }],
        },
        outputTranscription: { text: "Минутку..." },
      },
    });
    await vi.advanceTimersByTimeAsync(1800);

    ws.server({ serverContent: { inputTranscription: { text: "да" } } });
    await vi.advanceTimersByTimeAsync(800);

    expect(ws.sent.some((x) => x.includes("Владелец сказал «да» до вопроса"))).toBe(true);
    expect(executedArgs.length).toBe(0);

    // Модель прерывается по вставке
    ws.server({ serverContent: { interrupted: true } });

    // Проверяем сохранение confirmationId, argsHash, expiresAt после раннего «да»
    const pending = gate.pendingConfirmation();
    expect(pending?.confirmationId).toBe(initialId);
    expect(pending?.argsHash).toBe(initialHash);
    expect(pending?.expiresAt).toBe(initialTtl);

    // Модель перезадаёт вопрос
    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(4800).toString("base64") } }],
        },
        outputTranscription: { text: "Отправить: «Привет всем»?" },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.transcript("call_plug119").some((e) => e.kind === "question_heard")).toBe(true);

    // Владелец соглашается
    ws.server({ serverContent: { inputTranscription: { text: "да" } } });
    await vi.advanceTimersByTimeAsync(800);

    expect(executedArgs.length).toBe(1);
    expect(executedArgs[0]).toEqual(initialArgs);

    await s.end("owner");
    vi.useRealTimers();
  });

  it("гонка вставки со звонковой кнопкой «Отмена»: запись сгорает, нет повторного pending и исполнения", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const executedArgs: Array<Record<string, unknown>> = [];
    const customTool = {
      name: "action_cancel_race",
      description: "Cancel race test",
      cls: "C" as const,
      parameters: { type: "object" },
      execute: async (args: Record<string, unknown>) => {
        executedArgs.push(args);
        return { ok: true, data: {} };
      },
    };
    (s as unknown as { projectConnectorTools: unknown[] }).projectConnectorTools.push(customTool);

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const req = gate.request("action_cancel_race", { id: "1" }, "C", "Выполнить «1»?");
    if (!("pending" in req)) throw new Error("pending rejected");
    const confirmationId = req.pending.confirmationId;
    (s as unknown as { storedArgs: Map<string, Record<string, unknown>> }).storedArgs.set(req.pending.argsHash, { id: "1" });

    // Филлер и раннее «да»
    ws.server({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000).toString("base64") } }] },
        outputTranscription: { text: "Секунду..." },
      },
    });
    await vi.advanceTimersByTimeAsync(1800);
    ws.server({ serverContent: { inputTranscription: { text: "да" } } });

    // Дожидаемся 700 мс тишины окончания реплики: ранняя вставка отправлена
    await vi.advanceTimersByTimeAsync(800);
    expect(ws.sent.some((x) => x.includes("Владелец сказал «да» до вопроса — это НЕ подтверждение"))).toBe(true);

    // В момент попытки восстановления модели владелец нажимает кнопку «Отмена»
    s.decideConfirmation(confirmationId, "cancel");
    expect(gate.pendingConfirmation()).toBeNull();

    // Модель после вставки пытается перезадать или подтвердить (запоздалый confirmAction)
    const confirmRes = await gate.confirmAction(confirmationId);
    expect(confirmRes).toBe("expired");
    expect(executedArgs.length).toBe(0);
    expect(gate.pendingConfirmation()).toBeNull();

    await s.end("owner");
    vi.useRealTimers();
  });

  it("гонка вставки с истечением TTL: pending сгорает как expired, нет исполнения", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const executedArgs: Array<Record<string, unknown>> = [];
    const customTool = {
      name: "action_ttl_race",
      description: "TTL race test",
      cls: "C" as const,
      parameters: { type: "object" },
      execute: async (args: Record<string, unknown>) => {
        executedArgs.push(args);
        return { ok: true, data: {} };
      },
    };
    (s as unknown as { projectConnectorTools: unknown[] }).projectConnectorTools.push(customTool);

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const req = gate.request("action_ttl_race", { id: "2" }, "C", "Выполнить «2»?");
    if (!("pending" in req)) throw new Error("pending rejected");
    const confirmationId = req.pending.confirmationId;
    (s as unknown as { storedArgs: Map<string, Record<string, unknown>> }).storedArgs.set(req.pending.argsHash, { id: "2" });

    // Вставка раннего согласия
    ws.server({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000).toString("base64") } }] },
        outputTranscription: { text: "Секунду..." },
      },
    });
    await vi.advanceTimersByTimeAsync(1800);
    ws.server({ serverContent: { inputTranscription: { text: "да" } } });
    await vi.advanceTimersByTimeAsync(20);

    // Проходит больше TTL (60 секунд)
    await vi.advanceTimersByTimeAsync(65_000);
    gate.tick();

    // Запоздалое согласие или confirm_action
    const confirmRes = await gate.confirmAction(confirmationId);
    expect(confirmRes).toBe("expired");
    expect(executedArgs.length).toBe(0);

    await s.end("owner");
    vi.useRealTimers();
  });

  it("P1: слова аргумента в кавычках say не попадают в objectWords и не вызывают question_heard на филлере (репро Round 3)", () => {
    const clock = fakeClock();
    const verdicts: string[] = [];
    let heard = 0;
    const gate = new ConfirmationGate(DEFAULT_WORDS, clock.clock, {
      onVerdict: (_, v) => verdicts.push(v),
      onQuestionHeardAt: () => heard++,
    });
    const text = "Секунду пожалуйста обсудим бюджет после встречи";
    gate.request("thread_send", { text }, "C", `Отправить в тред: «${text}»?`);

    // Филлер со словами «секунду», «пожалуйста»
    gate.onModelAudio(1, 4800, clock.now);
    gate.onModelTranscript("Секунду, пожалуйста, я готовлю вопрос", clock.now);
    gate.onModelAudio(1, 48000 * 10, clock.now);
    clock.advance(1800);
    gate.onOwnerTranscriptChunk("да", clock.now);
    clock.advance(700);

    expect(heard).toBe(0);
    expect(verdicts).toEqual([]);
    expect(gate.windowOpen()).toBe(false);

    // Модель наконец произносит сам вопрос (с хвостом say «после встречи»)
    gate.onModelTranscript(`Отправить в тред: «${text}»?`, clock.now);
    expect(heard).toBe(1);
    // Прокручиваем время вперед, чтобы звук вопроса доиграл до владельца
    clock.advance(11_000);
    gate.onOwnerTranscriptChunk("да", clock.now);
    clock.advance(700);
    expect(verdicts).toEqual(["approved"]);
  });

  it("P1: CallSession не исполняет действие на филлер с цитируемыми аргументными словами (репро Round 3)", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const executions: Array<Record<string, unknown>> = [];
    (s as unknown as { projectConnectorTools: unknown[] }).projectConnectorTools.push({
      name: "review_action_r3",
      cls: "C",
      description: "Fixture",
      parameters: { type: "object" },
      execute: async (args: Record<string, unknown>) => {
        executions.push(args);
        return { ok: true, data: {} };
      },
    });

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const args = { text: "Секунду пожалуйста обсудим бюджет после встречи" };
    const req = gate.request("review_action_r3", args, "C", `Отправить в тред: «${args.text}»?`);
    if (!("pending" in req)) throw new Error("pending rejected");
    (s as unknown as { storedArgs: Map<string, Record<string, unknown>> }).storedArgs.set(req.pending.argsHash, args);

    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 10).toString("base64") } }],
        },
        outputTranscription: { text: "Секунду, пожалуйста, я готовлю вопрос" },
      },
    });
    await vi.advanceTimersByTimeAsync(1800);

    ws.server({ serverContent: { inputTranscription: { text: "да" } } });
    await vi.advanceTimersByTimeAsync(800);

    expect(executions.length).toBe(0);
    expect(store.transcript("call_plug119").some((e) => e.kind === "question_heard")).toBe(false);

    await s.end("owner");
    vi.useRealTimers();
  });

  it("P2: частичные кавычки и незакрытые кавычки не вызывают ложный false_claim (репро Round 3)", () => {
    const say = "Отправить в тред: «Готово, письмо отправлено»?";
    // Вопрос с частичными кавычками вокруг только одного слова
    expect(isFalseClaim("Отправить в тред: готово, письмо «отправлено»?", say, say)).toBe(false);
    // Вопрос с незакрытой кавычкой
    expect(isFalseClaim("Отправить в тред: «Готово, письмо отправлено?", say, say)).toBe(false);
    // Вопрос с частичными кавычками и самостоятельным докладом
    expect(isFalseClaim("Отправить в тред: готово, письмо «отправлено»? Уже отправлено.", say, say)).toBe(true);
  });

  it("P2: CallSession не прерывает модель и не генерирует false_claim на вопрос с частичными кавычками (репро Round 3)", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s, frames } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const say = "Отправить в тред: «Готово, письмо отправлено»?";
    gate.request("thread_send", { text: "Готово, письмо отправлено" }, "C", say, say);

    // Модель озвучивает аудио и транскрипт с частичными кавычками
    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
        },
        outputTranscription: { text: "Отправить в тред: готово, письмо «отправлено»?" },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    const events = store.transcript("call_plug119");
    const falseClaimEvent = events.find((e) => e.kind === "false_claim");
    expect(falseClaimEvent).toBeUndefined();

    const injected = ws.sent.filter((x) => x.includes("Действие ещё не подтверждено"));
    expect(injected.length).toBe(0);

    const interruptedFrame = frames.find((f) => f.type === "interrupted");
    expect(interruptedFrame).toBeUndefined();

    await s.end("owner");
    vi.useRealTimers();
  });

  it("P2: незакрытая кавычка с последующим самостоятельным докладом даёт false_claim (репро Round 4)", () => {
    const say = "Отправить в тред: «Готово, письмо отправлено»?";
    // Незакрытая кавычка « с последующим докладом
    expect(isFalseClaim("Отправить в тред: «Готово, письмо отправлено? Уже отправлено.", say, say)).toBe(true);
    // Незакрытая прямая двойная кавычка " с последующим докладом
    expect(isFalseClaim('Отправить в тред: "Готово, письмо отправлено? Уже отправлено.', say, say)).toBe(true);
    // Одиночный вопрос с незакрытой кавычкой без доклада не даёт false_claim
    expect(isFalseClaim("Отправить в тред: «Готово, письмо отправлено?", say, say)).toBe(false);
    expect(isFalseClaim('Отправить в тред: "Готово, письмо отправлено?', say, say)).toBe(false);
  });

  it("P2: CallSession фиксирует false_claim и сбрасывает аудио при незакрытой кавычке с докладом (репро Round 4)", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s, frames } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const say = "Отправить в тред: «Готово, письмо отправлено»?";
    gate.request("thread_send", { text: "Готово, письмо отправлено" }, "C", say, say);

    // Модель озвучивает аудио и транскрипт с незакрытой кавычкой и самостоятельным докладом
    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
        },
        outputTranscription: { text: "Отправить в тред: «Готово, письмо отправлено? Уже отправлено." },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    const events = store.transcript("call_plug119");
    const falseClaimEvent = events.find((e) => e.kind === "false_claim");
    expect(falseClaimEvent).toBeDefined();

    const injected = ws.sent.filter((x) => x.includes("Действие ещё не подтверждено"));
    expect(injected.length).toBe(1);

    const interruptedFrame = frames.find((f) => f.type === "interrupted");
    expect(interruptedFrame).toBeDefined();

    await s.end("owner");
    vi.useRealTimers();
  });

  it("P2: CallSession фиксирует false_claim при прямой кавычке с докладом (репро Round 4)", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    const store = new CallStore(new Database(":memory:"));
    const { s, frames } = makeSession(store);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];

    const gate = (s as unknown as { gate: ConfirmationGate }).gate;
    const say = "Отправить в тред: «Готово, письмо отправлено»?";
    gate.request("thread_send", { text: "Готово, письмо отправлено" }, "C", say, say);

    ws.server({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
        },
        outputTranscription: { text: 'Отправить в тред: "Готово, письмо отправлено? Уже отправлено.' },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    const events = store.transcript("call_plug119");
    expect(events.some((e) => e.kind === "false_claim")).toBe(true);
    expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);
    expect(frames.some((f) => f.type === "interrupted")).toBe(true);

    await s.end("owner");
    vi.useRealTimers();
  });

  describe("Контрольные случаи детерминированного алгоритма (§7.1 п. 9.1)", () => {
    const defaultSay = "Отправить в тред: «Готово, письмо отправлено»?";
    const defaultCard = "Готово, письмо отправлено";

    const longText = "Передай клиенту, что договор подписан, счёт выставлен, а письмо с актом уже отправлено";
    const longSay = "Отправить в тред: «Передай клиенту, что договор подписан, счёт выставлен, а…»?";

    const tableCases: Array<[string, string, string | string[], string, boolean]> = [
      ["row 1: штатный вопрос с закрытыми кавычками", defaultSay, defaultCard, "Отправить в тред: «Готово, письмо отправлено»?", false],
      ["row 2: вопрос и повторная точная цитата текста", defaultSay, defaultCard, "… «Готово, письмо отправлено»? Текст сообщения: «Готово, письмо отправлено».", false],
      ["row 3: вопрос и отдельный доклад «Уже отправлено»", defaultSay, defaultCard, "… «Готово, письмо отправлено»? Уже отправлено.", true],
      ["row 4: вопрос с незакрытой кавычкой и доклад", defaultSay, defaultCard, "Отправить в тред: «Готово, письмо отправлено? Уже отправлено.", true],
      ["row 5: часть действия без кавычек и одно слово в кавычках", defaultSay, defaultCard, "Текст сообщения: Готово, письмо «отправлено».", false],
      ["row 6: внутренняя пунктуация … внутри действия", "Отправить в тред: «Готово… письмо отправлено»?", "Готово… письмо отправлено", "Отправить сообщение в тред: «Готово… письмо отправлено?", false],
      ["row 7: слово с апострофом O'Reilly и доклад", defaultSay, defaultCard, "Для O'Reilly уже отправлено.", true],
      ["row 8: вопрос со словом с апострофом в кавычках", "Отправить в тред: «Для O'Reilly готово»?", "Для O'Reilly готово", "Отправить сообщение в тред: «Для O'Reilly готово»?", false],
      ["row 9: 1-словное действие и доклад до границы предложения", "Отправить в тред: «Проверка»?", "Проверка", "Отправить в этот тред: «Проверка, уже отправлено.", true],
      ["row 10: 1-словное действие без кавычек в тексте доклада", "Отправить в тред: «отправлено»?", "отправлено", "Отправить в тред «отправлено»? Сообщение отправлено в тред.", true],
      ["row 11: отрицание «не» перед докладом", defaultSay, defaultCard, "Не отправлено, жду ответа.", false],
      ["row 12: отрицание «не было» перед докладом", defaultSay, defaultCard, "Простите, сообщение ещё не было отправлено. Отправить в тред: «Готово, письмо отправлено»?", false],
      ["row 13: будущее время «будет отправлено»", defaultSay, defaultCard, "Сообщение будет отправлено после подтверждения. Отправить в тред: «Готово, письмо отправлено»?", false],
      ["row 14: «было отправлено» без отрицания — доклад", defaultSay, defaultCard, "Сообщение было отправлено в тред.", true],
      ["row 15: «готово к» — не доклад", defaultSay, defaultCard, "Сообщение готово к отправке. Отправить в тред: «Готово, письмо отправлено»?", false],
      ["row 16: расширенный список докладов «отправлен»", defaultSay, defaultCard, "Ваш ответ отправлен агенту.", true],
      ["row 17: дефис между буквами склеивается", "Отправить в тред: «Передай агенту-куратору: всё сделано»?", "Передай агенту-куратору: всё сделано", "Отправить в тред: «Передай агентукуратору: всё сделано»?", false],
      ["row 18: текст действия >8 слов без кавычек со словом доклада после 8-го", longSay, longText, "Отправить в тред сообщение: " + longText.toLowerCase() + ". Отправить?", false],
      ["row 19: принятое ограничение: весь текст действия >=2 слов без кавычек", "Отправить в тред: «Письмо отправлено»?", "Письмо отправлено", "Письмо отправлено.", false],
      ["row 20: неозвученный аргумент spec у tasks_create не источник", "Создать задачу «Проверка»?", "Проверка", "Сообщение отправлено.", true],
      ["row 21: помеченное «не» в вопросе не подавляет доклад", "Отправить в тред: «не»?", "не", "Отправить в тред: «не»? Отправлено.", true],
      ["row 22: апостроф после цифры 1'отправлено — разделитель", "Операция «Проверка»?", "Проверка", "1'отправлено", true],
      ["row 23: tasks_create с префиксом spec — совпадение префикса не источник", "Создать задачу «Проверка»?", ["Проверка"], "Проверка выполнено.", true],
      ["row 24: tasks_create с вложенными кавычками в значении title", "Создать задачу «\"отправлено\" клиенту»?", ['"отправлено" клиенту'], "Создать новую задачу «отправлено клиенту»?", false],
      ["row 25: коннектор: auditNote выпал по лимиту 200 символов", "fixture_tool: first=aaaaaaaa…, second=bbbbbbbb…, third=cccccccc…, fourth=dddddddd…?", ["a".repeat(80), "b".repeat(80), "c".repeat(80), "d".repeat(80)], "Сообщение отправлено.", true],
      ["row 26: коннектор: вложенный озвученный payload.text", 'fixture_tool: payload={"text":"Готово, письмо отправлено"}?', ["Готово, письмо отправлено"], "Установить payload: «Готово, письмо отправлено»?", false],
      ["row 27: коннектор: successMessage совпадает с докладом целиком (принятое ограничение)", "fixture_tool: successMessage=Сообщение отправлено?", ["Сообщение отправлено"], "Сообщение отправлено.", false],
      ["row 28: коннектор: audit скрыт по лимиту 50, совпадение префикса с preview не источник", 'fixture_tool: payload={"preview":"Проверка завершения","pad":"xxxxxxxxx…?', ["Проверка завершения", "x".repeat(80)], "Проверка завершения выполнено.", true],
      ["row 29: коннектор: усечение «Готов…» содержит буквы — источник text представлен", 'fixture_tool: payload={"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxx","text":"Готов…?', ["x".repeat(26), "Готово, письмо отправлено"], "Установить payload: «Готово, письмо отправлено»?", false],
      ["row 30: коннектор: экранирование \\n в say не теряет строковый лист", 'fixture_tool: payload={"text":"Сообщение\\nотправлено"}?', ["Сообщение\nотправлено"], "Установить payload: «Сообщение отправлено»?", false],
      ["row 31: коннектор: экранирование переводов строки без видимых букв значения — не источник", 'fixture_tool: payload={"pad":"xxxxxxxxxxxxxxxxxxxxxxxx","text":"\\n\\n\\n\\…?', ["x".repeat(24)], "Сообщение отправлено.", true],
    ];

    for (const [name, say, card, turn, expected] of tableCases) {
      it(`unit: ${name}`, () => {
        expect(isFalseClaim(turn, say, card)).toBe(expected);
      });
    }

    it("CallSession row 2: повторная цитата действия не вызывает false_claim и interrupted", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const gate = (s as unknown as { gate: ConfirmationGate }).gate;
      gate.request("thread_send", { text: defaultCard }, "C", defaultSay, defaultCard);

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "… «Готово, письмо отправлено»? Текст сообщения: «Готово, письмо отправлено»." },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(false);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(false);
      expect(frames.some((f) => f.type === "interrupted")).toBe(false);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession row 7: доклад со словом с апострофом фиксирует false_claim и сбрасывает аудио", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const gate = (s as unknown as { gate: ConfirmationGate }).gate;
      gate.request("thread_send", { text: defaultCard }, "C", defaultSay, defaultCard);

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Для O'Reilly уже отправлено." },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(true);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);
      expect(frames.some((f) => f.type === "interrupted")).toBe(true);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession row 8: вопрос со словом с апострофом не вызывает false_claim", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const say = "Отправить в тред: «Для O'Reilly готово»?";
      const card = "Для O'Reilly готово";
      const gate = (s as unknown as { gate: ConfirmationGate }).gate;
      gate.request("thread_send", { text: card }, "C", say, card);

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Отправить сообщение в тред: «Для O'Reilly готово»?" },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(false);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(false);
      expect(frames.some((f) => f.type === "interrupted")).toBe(false);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession row 9: доклад внутри кавычки 1-словного действия фиксирует false_claim", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const say = "Отправить в тред: «Проверка»?";
      const card = "Проверка";
      const gate = (s as unknown as { gate: ConfirmationGate }).gate;
      gate.request("thread_send", { text: card }, "C", say, card);

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Отправить в этот тред: «Проверка, уже отправлено." },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(true);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);
      expect(frames.some((f) => f.type === "interrupted")).toBe(true);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession row 12: отрицание «не было» не вызывает false_claim и interrupted", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const gate = (s as unknown as { gate: ConfirmationGate }).gate;
      gate.request("thread_send", { text: defaultCard }, "C", defaultSay, defaultCard);

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Простите, сообщение ещё не было отправлено. Отправить в тред: «Готово, письмо отправлено»?" },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(false);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(false);
      expect(frames.some((f) => f.type === "interrupted")).toBe(false);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession row 14: «было отправлено» без отрицания фиксирует false_claim и сбрасывает аудио", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const gate = (s as unknown as { gate: ConfirmationGate }).gate;
      gate.request("thread_send", { text: defaultCard }, "C", defaultSay, defaultCard);

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Сообщение было отправлено в тред." },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(true);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);
      expect(frames.some((f) => f.type === "interrupted")).toBe(true);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession row 17: дефис «агенту-куратору» склеивается и не вызывает false_claim", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const say = "Отправить в тред: «Передай агенту-куратору: всё сделано»?";
      const card = "Передай агенту-куратору: всё сделано";
      const gate = (s as unknown as { gate: ConfirmationGate }).gate;
      gate.request("thread_send", { text: card }, "C", say, card);

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Отправить в тред: «Передай агентукуратору: всё сделано»?" },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(false);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(false);
      expect(frames.some((f) => f.type === "interrupted")).toBe(false);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession row 18: длинный текст действия >8 слов без кавычек не вызывает false_claim", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const gate = (s as unknown as { gate: ConfirmationGate }).gate;
      gate.request("thread_send", { text: longText }, "C", longSay, longText);

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Отправить в тред сообщение: " + longText.toLowerCase() + ". Отправить?" },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(false);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(false);
      expect(frames.some((f) => f.type === "interrupted")).toBe(false);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession C1: реальный runToolCall tasks_create с совпадающим префиксом args.spec не скрывает false_claim", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const { TOOLS, runToolCall } = await import("../src/tools.js");
      const tool = TOOLS.find((t) => t.name === "tasks_create")!;
      const args = { title: "Проверка", spec: "Проверка выполнено" };
      await runToolCall(tool, args, undefined, {
        gate: (s as unknown as { gate: ConfirmationGate }).gate,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Проверка выполнено." },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(true);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);
      expect(frames.some((f) => f.type === "interrupted")).toBe(true);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession C2: tasks_create с вложенными кавычками в title не вызывает false_claim на правильный вопрос", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const { TOOLS, runToolCall } = await import("../src/tools.js");
      const tool = TOOLS.find((t) => t.name === "tasks_create")!;
      const args = { title: '"отправлено" клиенту', spec: "Обсудить план" };
      await runToolCall(tool, args, undefined, {
        gate: (s as unknown as { gate: ConfirmationGate }).gate,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Создать новую задачу «отправлено клиенту»?" },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(false);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(false);
      expect(frames.some((f) => f.type === "interrupted")).toBe(false);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession коннектор 1: выпавшее по лимиту 200 поле auditNote фиксирует false_claim", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const { runToolCall, formatConnectorSay } = await import("../src/tools.js");
      const connectorDef = {
        name: "fixture_connector",
        cls: "C" as const,
        isConnector: true,
        word: "да",
        description: "Fixture connector",
        parameters: {},
        confirmSay: (args: Record<string, unknown>) => formatConnectorSay("fixture_connector", "conn", args).say,
        execute: async () => ({ ok: true as const, data: {} }),
      };
      const args = {
        first: "a".repeat(80),
        second: "b".repeat(80),
        third: "c".repeat(80),
        fourth: "d".repeat(80),
        auditNote: "Сообщение отправлено",
      };
      await runToolCall(connectorDef, args, undefined, {
        gate: (s as unknown as { gate: ConfirmationGate }).gate,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Сообщение отправлено." },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(true);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);
      expect(frames.some((f) => f.type === "interrupted")).toBe(true);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession коннектор 2: вложенное озвученное поле payload.text не вызывает false_claim на правильный вопрос", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const { runToolCall, formatConnectorSay } = await import("../src/tools.js");
      const connectorDef = {
        name: "fixture_connector",
        cls: "C" as const,
        isConnector: true,
        word: "да",
        description: "Fixture connector",
        parameters: {},
        confirmSay: (args: Record<string, unknown>) => formatConnectorSay("fixture_connector", "conn", args).say,
        execute: async () => ({ ok: true as const, data: {} }),
      };
      const args = { payload: { text: "Готово, письмо отправлено" } };
      await runToolCall(connectorDef, args, undefined, {
        gate: (s as unknown as { gate: ConfirmationGate }).gate,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Установить payload: «Готово, письмо отправлено»?" },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(false);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(false);
      expect(frames.some((f) => f.type === "interrupted")).toBe(false);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession коннектор round-8 (находка 1): скрытый audit по чужому префиксу фиксирует false_claim и прерывает ход", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const { runToolCall, formatConnectorSay } = await import("../src/tools.js");
      const connectorDef = {
        name: "fixture_connector",
        cls: "C" as const,
        isConnector: true,
        word: "да",
        description: "Fixture connector",
        parameters: {},
        confirmSay: (args: Record<string, unknown>) => formatConnectorSay("fixture_connector", "conn", args).say,
        execute: async () => ({ ok: true as const, data: {} }),
      };
      const args = {
        payload: {
          preview: "Проверка завершения",
          pad: "x".repeat(80),
          audit: "Проверка завершения выполнено",
        },
      };
      await runToolCall(connectorDef, args, undefined, {
        gate: (s as unknown as { gate: ConfirmationGate }).gate,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Проверка завершения выполнено." },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(true);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);
      expect(frames.some((f) => f.type === "interrupted")).toBe(true);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession коннектор round-8 (находка 2): видимое короткое усечение «Готов…» не вызывает false_claim на правильный вопрос", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const { runToolCall, formatConnectorSay } = await import("../src/tools.js");
      const connectorDef = {
        name: "fixture_connector",
        cls: "C" as const,
        isConnector: true,
        word: "да",
        description: "Fixture connector",
        parameters: {},
        confirmSay: (args: Record<string, unknown>) => formatConnectorSay("fixture_connector", "conn", args).say,
        execute: async () => ({ ok: true as const, data: {} }),
      };
      const args = {
        payload: {
          pad: "x".repeat(26),
          text: "Готово, письмо отправлено",
        },
      };
      await runToolCall(connectorDef, args, undefined, {
        gate: (s as unknown as { gate: ConfirmationGate }).gate,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Установить payload: «Готово, письмо отправлено»?" },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(false);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(false);
      expect(frames.some((f) => f.type === "interrupted")).toBe(false);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession коннектор round-8 (находка 3): экранирование \\n в JSON не теряет источник и не вызывает false_claim", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const { runToolCall, formatConnectorSay } = await import("../src/tools.js");
      const connectorDef = {
        name: "fixture_connector",
        cls: "C" as const,
        isConnector: true,
        word: "да",
        description: "Fixture connector",
        parameters: {},
        confirmSay: (args: Record<string, unknown>) => formatConnectorSay("fixture_connector", "conn", args).say,
        execute: async () => ({ ok: true as const, data: {} }),
      };
      const args = {
        payload: {
          text: "Сообщение\nотправлено",
        },
      };
      await runToolCall(connectorDef, args, undefined, {
        gate: (s as unknown as { gate: ConfirmationGate }).gate,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Установить payload: «Сообщение отправлено»?" },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(false);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(false);
      expect(frames.some((f) => f.type === "interrupted")).toBe(false);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("CallSession коннектор round-9 (строка 31): экранирование переводов строки без видимых букв значения фиксирует false_claim", async () => {
      vi.useFakeTimers();
      FakeWs.all = [];
      const store = new CallStore(new Database(":memory:"));
      const { s, frames } = makeSession(store);
      await s.start();
      await vi.advanceTimersByTimeAsync(10);
      const ws = FakeWs.all[0];

      const { runToolCall, formatConnectorSay } = await import("../src/tools.js");
      const connectorDef = {
        name: "fixture_connector",
        cls: "C" as const,
        isConnector: true,
        word: "да",
        description: "Fixture connector",
        parameters: {},
        confirmSay: (args: Record<string, unknown>) => formatConnectorSay("fixture_connector", "conn", args).say,
        execute: async () => ({ ok: true as const, data: {} }),
      };
      const args = {
        payload: {
          pad: "x".repeat(24),
          text: "\n\n\n\nСообщение отправлено",
        },
      };
      await runToolCall(connectorDef, args, undefined, {
        gate: (s as unknown as { gate: ConfirmationGate }).gate,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });

      ws.server({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48000 * 5).toString("base64") } }],
          },
          outputTranscription: { text: "Сообщение отправлено." },
          turnComplete: true,
        },
      });
      await vi.advanceTimersByTimeAsync(20);

      const events = store.transcript("call_plug119");
      expect(events.some((e) => e.kind === "false_claim")).toBe(true);
      expect(ws.sent.some((x) => x.includes("Действие ещё не подтверждено"))).toBe(true);
      expect(frames.some((f) => f.type === "interrupted")).toBe(true);

      await s.end("owner");
      vi.useRealTimers();
    });

    it("эталонный набор spec91-newrows: все 7 случаев соответствуют спеке", () => {
      const H = "Передай агенту-куратору: всё сделано", HS = `Отправить в тред: «${H}»?`;
      const rows: Array<[string, string, string, string, boolean]> = [
        ["neg_was", defaultSay, defaultCard, "Простите, сообщение ещё не было отправлено. Отправить в тред: «Готово, письмо отправлено»?", false],
        ["future", defaultSay, defaultCard, "Сообщение будет отправлено после подтверждения. Отправить в тред: «Готово, письмо отправлено»?", false],
        ["was_claim", defaultSay, defaultCard, "Сообщение было отправлено в тред.", true],
        ["hyphen", HS, H, "Отправить в тред: «Передай агентукуратору: всё сделано»?", false],
        ["long_unquoted", longSay, longText, "Отправить в тред сообщение: " + longText.toLowerCase() + ". Отправить?", false],
        ["weak", "Отправить в тред: «Письмо отправлено»?", "Письмо отправлено", "Письмо отправлено.", false],
        ["closing_after_punct_ctrl", defaultSay, defaultCard, 'Отправить в тред: "Готово, письмо отправлено." Уже отправлено.', true],
      ];
      for (const [id, s, t, turn, e] of rows) {
        expect(isFalseClaim(turn, s, t), id).toBe(e);
      }
    });

    it("эталонный набор round-3: 7 случаев соответствуют спеке", () => {
      const s3 = "Отправить в тред: «отправлено»?";
      const r3Cases: Array<[string, boolean]> = [
        ["Отправить в тред отправлено", false],
        ["Отправить в тред: отправлено?", false],
        [s3, false],
        ["Отправить в тред отправлено. Уже отправлено.", true],
        ["Отправить в тред: «отправлено»? Уже отправлено.", true],
        ["Текст «отправлено». Сообщение отправлено в тред.", true],
        ["Отправить сообщение «отправлено» в этот тред?", false],
      ];
      for (const [turn, expected] of r3Cases) {
        expect(isFalseClaim(turn, s3, "отправлено")).toBe(expected);
      }
    });

    it("эталонная матрица round-5 (64 случая) и counter-cases соответствуют спеке", () => {
      const fixtureUrl = new URL("./fixtures/plug119-false-claim-cases.json", import.meta.url);
      const fixture = JSON.parse(fs.readFileSync(fixtureUrl, "utf8")) as {
        matrix64: Array<{ id: string; name: string; turn: string; say: string; card: string; expected: boolean }>;
        counters: Array<{ id: string; turn: string; say: string; text: string; expected: boolean }>;
      };
      expect(fixture.matrix64.length).toBe(64);
      for (const c of fixture.matrix64) {
        expect(isFalseClaim(c.turn, c.say, c.card), `${c.id}: ${c.name}`).toBe(c.expected);
      }
      expect(fixture.counters.length).toBe(15);
      for (const c of fixture.counters) {
        expect(isFalseClaim(c.turn, c.say, c.text), c.id).toBe(c.expected);
      }
    });

    it("репро round-6: явно пустой список источников не разбирает say", () => {
      expect(isFalseClaim("Текст «готово».", "Шаблон «готово»?", [])).toBe(true);
    });

    it("эталонный набор round-7: репро C1/C2 и коннекторов полностью соответствуют спеке 5d02a41", async () => {
      const { TOOLS, extractActionTexts, formatConnectorSay, runToolCall } = await import("../src/tools.js");
      const task = TOOLS.find((t) => t.name === "tasks_create")!;
      const gateTask = new ConfirmationGate(DEFAULT_WORDS);
      const ctxTask = { gate: gateTask, sdk: {} as never, ledger: { add() {} } as never, reportAction() {}, callsProjectId: () => null };

      // C1: unquoted_prefix_arg
      await runToolCall(task, { title: "Проверка", spec: "Проверка выполнено" }, undefined, ctxTask);
      expect(gateTask.pendingConfirmation()?.actionTexts).toEqual(["Проверка"]);
      expect(gateTask.checkFalseClaim("Проверка выполнено.")).toBe(true);

      // C2: nested_double_quotes
      const gateC2 = new ConfirmationGate(DEFAULT_WORDS);
      await runToolCall(task, { title: '"отправлено" клиенту', spec: "Обсудить план" }, undefined, { ...ctxTask, gate: gateC2 });
      expect(gateC2.pendingConfirmation()?.actionTexts).toEqual(['"отправлено" клиенту']);
      expect(gateC2.checkFalseClaim("Создать новую задачу «отправлено клиенту»?")).toBe(false);

      // full_title_control
      const gateCtrl = new ConfirmationGate(DEFAULT_WORDS);
      await runToolCall(task, { title: "отправлено клиенту", spec: "Обсудить план" }, undefined, { ...ctxTask, gate: gateCtrl });
      expect(gateCtrl.pendingConfirmation()?.actionTexts).toEqual(["отправлено клиенту"]);
      expect(gateCtrl.checkFalseClaim("Создать новую задачу «отправлено клиенту»?")).toBe(false);

      // Connector 1: hidden top-level by 200 char limit
      const connArgs1 = {
        first: "a".repeat(80),
        second: "b".repeat(80),
        third: "c".repeat(80),
        fourth: "d".repeat(80),
        auditNote: "Сообщение отправлено",
      };
      const conn1Res = formatConnectorSay("fixture_connector", "", connArgs1);
      expect(conn1Res.say.includes("auditNote")).toBe(false);
      expect(conn1Res.actionTexts.includes("Сообщение отправлено")).toBe(false);
      expect(isFalseClaim("Сообщение отправлено.", conn1Res.say, conn1Res.actionTexts)).toBe(true);

      // Connector 2: nested spoken payload
      const connArgs2 = { payload: { text: "Готово, письмо отправлено" } };
      const conn2Res = formatConnectorSay("fixture_connector", "", connArgs2);
      expect(conn2Res.say.includes("Готово, письмо отправлено")).toBe(true);
      expect(conn2Res.actionTexts).toEqual(["Готово, письмо отправлено"]);
      expect(isFalseClaim("Установить payload: «Готово, письмо отправлено»?", conn2Res.say, conn2Res.actionTexts)).toBe(false);
    });

    it("регрессионный тест: say коннектора побайтово совпадает с прежним formatter-ом на 6 типовых наборах аргументов", async () => {
      const { formatConnectorSay } = await import("../src/tools.js");

      function referenceFormatConnectorSay(
        toolName: string,
        connId: string,
        args: Record<string, unknown>,
      ): string {
        const entries = Object.entries(args ?? {});
        if (entries.length === 0) {
          return connId ? `${toolName} в ${connId}?` : `${toolName}?`;
        }
        const formattedParts: string[] = [];
        for (let i = 0; i < entries.length; i++) {
          const [k, v] = entries[i];
          const valStr = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
          const truncated = valStr.length > 50 ? valStr.slice(0, 49) + "…" : valStr;
          formattedParts.push(`${k}=${truncated}`);
        }
        const formattedArgs = formattedParts.join(", ");
        const truncatedArgs = formattedArgs.length > 200 ? formattedArgs.slice(0, 199) + "…" : formattedArgs;
        return `${toolName}: ${truncatedArgs}?`;
      }

      const sampleArgSets: Array<Record<string, unknown>> = [
        {},
        { target: "support", count: 5, urgent: true },
        { nested: { status: "pending", code: 200 }, notes: null },
        { items: ["alpha", "beta", "gamma"], active: true },
        {
          title: "Заголовок запроса",
          description:
            "Это очень длинный текст описания, который заведомо превышает лимит пятьдесят символов для отдельного значения поля коннектора",
        },
        {
          field1: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          field2: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          field3: "cccccccccccccccccccccccccccccccccccccccc",
          field4: "dddddddddddddddddddddddddddddddddddddddd",
          field5: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          field6: "ffffffffffffffffffffffffffffffffffffffff",
        },
      ];

      for (const args of sampleArgSets) {
        const expectedSay = referenceFormatConnectorSay("my_connector", "conn1", args);
        const actualRes = formatConnectorSay("my_connector", "conn1", args);
        expect(actualRes.say).toBe(expectedSay);
      }
    });

    it("эталонный набор round-8: репро скрытого префикса, короткого усечения, экранирования \\n и области коннектора", async () => {
      const { TOOLS, formatConnectorSay, runToolCall } = await import("../src/tools.js");

      // 1. hidden_leaf_shared_prefix
      const preview = "Проверка завершения";
      const audit = "Проверка завершения выполнено";
      const r1 = formatConnectorSay("fixture_tool", "fixture", {
        payload: { preview, pad: "x".repeat(80), audit },
      });
      expect(r1.actionTexts).toEqual([preview, "x".repeat(80)]);
      expect(isFalseClaim(audit + ".", r1.say, r1.actionTexts)).toBe(true);

      // 2. short_visible_leaf_prefix
      const text = "Готово, письмо отправлено";
      let nFound = -1;
      let padLen = -1;
      for (let n = 0; n < 50; n++) {
        const obj = { pad: "x".repeat(n), text };
        const raw = JSON.stringify(obj);
        const start = raw.indexOf(text);
        if (49 - start === 5) {
          nFound = n;
          padLen = n;
          break;
        }
      }
      expect(nFound).toBeGreaterThan(-1);
      const r2 = formatConnectorSay("fixture_tool", "fixture", {
        payload: { pad: "x".repeat(padLen), text },
      });
      expect(r2.actionTexts).toEqual(["x".repeat(padLen), text]);
      expect(isFalseClaim("Установить payload: «" + text + "»?", r2.say, r2.actionTexts)).toBe(false);

      // 3. escaped_json_leaf
      const escaped = "Сообщение\nотправлено";
      const r3 = formatConnectorSay("fixture_tool", "fixture", { payload: { text: escaped } });
      expect(r3.actionTexts).toEqual([escaped]);
      expect(isFalseClaim("Установить payload: «Сообщение отправлено»?", r3.say, r3.actionTexts)).toBe(false);

      // 4. visible_service_field_policy
      const r4 = formatConnectorSay("fixture_tool", "fixture", { successMessage: "Сообщение отправлено" });
      expect(r4.actionTexts).toEqual(["Сообщение отправлено"]);
      expect(isFalseClaim("Сообщение отправлено.", r4.say, r4.actionTexts)).toBe(false);

      // 5. partially_visible_service_field_policy
      const r5 = formatConnectorSay("fixture_tool", "fixture", {
        a: "x".repeat(80),
        b: "y".repeat(80),
        c: "z".repeat(80),
        d: "p".repeat(13),
        successMessage: "Сообщение отправлено",
      });
      expect(r5.actionTexts).toEqual(["x".repeat(80), "y".repeat(80), "z".repeat(80), "p".repeat(13), "Сообщение отправлено"]);
      expect(isFalseClaim("Сообщение отправлено.", r5.say, r5.actionTexts)).toBe(false);

      // 6. whitespace_only_prefix: по спеке 91ec922 видимая часть должна содержать букву или цифру
      const r6 = formatConnectorSay("fixture_tool", "fixture", { message: " ".repeat(50) + "Сообщение отправлено" });
      expect(r6.actionTexts).toEqual([]);
      expect(isFalseClaim("Сообщение отправлено.", r6.say, r6.actionTexts)).toBe(true);

      // 7. connector_source_a_vs_c_scope: для коннекторов (а) и (б) не применяются
      const droppedArgs = {
        first: "a".repeat(80),
        second: "b".repeat(80),
        third: "c".repeat(80),
        fourth: "d".repeat(80),
        body: "Сообщение отправлено",
      };
      const r7 = formatConnectorSay("fixture_tool", "fixture", droppedArgs);
      expect(r7.actionTexts).toEqual(["a".repeat(80), "b".repeat(80), "c".repeat(80), "d".repeat(80)]);
      expect(isFalseClaim("Сообщение отправлено.", r7.say, r7.actionTexts)).toBe(true);

      // 8 & 9. tasks_create through ConfirmationGate: C1 and C2
      const task = TOOLS.find((t) => t.name === "tasks_create")!;
      const gateC1 = new ConfirmationGate(DEFAULT_WORDS);
      await runToolCall(task, { title: "Проверка", spec: "Проверка выполнено" }, undefined, {
        gate: gateC1,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });
      expect(gateC1.checkFalseClaim("Проверка выполнено.")).toBe(true);

      const gateC2 = new ConfirmationGate(DEFAULT_WORDS);
      await runToolCall(task, { title: '"отправлено" клиенту', spec: "Обсудить план" }, undefined, {
        gate: gateC2,
        sdk: {} as never,
        ledger: { add() {} } as never,
        reportAction() {},
        callsProjectId: () => null,
      });
      expect(gateC2.checkFalseClaim("Создать новую задачу «отправлено клиенту»?")).toBe(false);
    });

    it("эталонный набор round-9: экранирование не создаёт источников без видимых букв значения (\\t, \\u0007, одиночные суррогаты)", async () => {
      const { formatConnectorSay } = await import("../src/tools.js");
      const claim = "Сообщение отправлено";

      // 1. \t: видны только экранирования табуляций (pad 24)
      const rTab = formatConnectorSay("fixture_tool", "fixture", {
        payload: { pad: "x".repeat(24), text: "\t\t\t\t" + claim },
      });
      expect(rTab.actionTexts).toEqual(["x".repeat(24)]);
      expect(isFalseClaim(claim + ".", rTab.say, rTab.actionTexts)).toBe(true);

      // 2. \u0007 обрыв посреди escape (\u00, pad 27)
      const rCutU = formatConnectorSay("fixture_tool", "fixture", {
        payload: { pad: "x".repeat(27), text: "\u0007" + claim },
      });
      expect(rCutU.actionTexts).toEqual(["x".repeat(27)]);
      expect(isFalseClaim(claim + ".", rCutU.say, rCutU.actionTexts)).toBe(true);

      // 3. \u0007 виден целиком (управляющий символ, pad 25)
      const rFullU = formatConnectorSay("fixture_tool", "fixture", {
        payload: { pad: "x".repeat(25), text: "\u0007" + claim },
      });
      expect(rFullU.actionTexts).toEqual(["x".repeat(25)]);
      expect(isFalseClaim(claim + ".", rFullU.say, rFullU.actionTexts)).toBe(true);

      // 4. одиночные суррогаты \ud83d (pad 20)
      const rLoneSurr = formatConnectorSay("fixture_tool", "fixture", {
        payload: { pad: "x".repeat(20), text: "\ud83d\ud83d\ud83d\ud83d" + claim },
      });
      expect(rLoneSurr.actionTexts).toEqual(["x".repeat(20)]);
      expect(isFalseClaim(claim + ".", rLoneSurr.say, rLoneSurr.actionTexts)).toBe(true);

      // 5. контроль: после экранирований \n\n видна буква С значения (pad 22) -> источник
      const rLetter = formatConnectorSay("fixture_tool", "fixture", {
        payload: { pad: "x".repeat(22), text: "\n\n" + claim },
      });
      expect(rLetter.actionTexts).toEqual(["x".repeat(22), claim]);
      expect(isFalseClaim(claim + ".", rLetter.say, rLetter.actionTexts)).toBe(false);

      // 6. контроль: половина суррогатной пары 𝐀 на границе 49 (pad 30)
      const rHalfSurr = formatConnectorSay("fixture_tool", "fixture", {
        payload: { pad: "x".repeat(30), text: "𝐀" + claim },
      });
      expect(rHalfSurr.actionTexts).toEqual(["x".repeat(30)]);
      expect(isFalseClaim(claim + ".", rHalfSurr.say, rHalfSurr.actionTexts)).toBe(true);
    });
  });
});
