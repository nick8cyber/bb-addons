import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationGate, argsHash } from "../src/confirmation-gate.js";
import { DEFAULT_WORDS, classify } from "../src/classify.js";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import { LiveClient } from "../src/live-client.js";
import { readProjectRepoConfig } from "../src/project-registry.js";
import { runToolCall, type ToolDef } from "../src/tools.js";

function makeSpeechPcm(blocks = 8, peak = 1000): Uint8Array {
  const bytes = new Uint8Array(blocks * 640);
  const view = new DataView(bytes.buffer);
  for (let b = 0; b < blocks; b++) {
    view.setInt16(b * 640, peak, true);
  }
  return bytes;
}

class DelayedSocket {
  readyState = 1;
  sent: any[] = [];
  private listeners: Record<string, Array<(e: any) => void>> = {};
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {}
  receive(content: unknown) {
    for (const fn of this.listeners.message ?? []) {
      fn({ data: JSON.stringify({ serverContent: content }) });
    }
  }
  get audioCount() {
    return this.sent.filter((m) => m.realtimeInput?.audio).length;
  }
}

function liveFixture(mode: "normal" | "extended", cls: "L" | "P") {
  const fixture = makeSession({ mode, allowExtended: mode === "extended" });
  const { a } = fixture;
  a.mode = mode;
  const socket = new DelayedSocket();
  const client = new LiveClient({
    key: "fake",
    model: "demo",
    voice: "Algenib",
    languageCode: "ru-RU",
    systemInstruction: "synthetic",
    turnSeqBase: 1,
    wsFactory: () => socket as unknown as WebSocket,
  });
  a.voice = client;
  a.wireVoice(client);
  client.connect();
  const state = { executions: 0 };
  const def: ToolDef = {
    name: "demo__action",
    cls,
    word: cls === "L" ? "запускай" : "разрешаю",
    description: "Demo",
    parameters: {},
    confirmSay: () => "Выполнить действие?",
    execute: async () => {
      state.executions++;
      return { ok: true, data: {} };
    },
  };
  a.projectConnectorTools = [def];
  return { ...fixture, client, socket, def, state, word: cls === "L" ? "запускай" : "разрешаю" };
}

function makeSession(opts: Partial<{ mode: "normal" | "extended"; allowExtended: boolean }> = {}) {
  const store = new CallStore(new Database(":memory:"));
  const frames: unknown[] = [];
  const s = new CallSession({
    callId: "call_synthetic",
    keys: ["fake"],
    voice: "Algenib",
    languageCode: "ru-RU",
    mode: opts.mode ?? "normal",
    allowExtended: opts.allowExtended,
    routerInput: "text",
    thinkingLevel: "LOW",
    maxCallMinutes: 60,
    store,
    sdk: {
      threads: {
        get: async ({ threadId }: any) => ({ id: threadId, title: "Thread" }),
        list: async () => [],
        listRunning: async () => [],
        markRead: async () => {},
        interactions: { list: async () => [] },
      },
      projects: { get: async () => ({ id: "demo" }) },
    } as never,
    toBrowser: (f) => frames.push(f),
    sendBrowserAudio: () => {},
    spawnCallThread: async () => null,
    advanceCallThread: async () => {},
    sayCallThread: async () => {},
    endCallThread: async () => {},
  });
  return { s, a: s as any, frames, store };
}

function openWindowManually(gate: ConfirmationGate) {
  gate.onModelAudio(1, 48000);
  vi.advanceTimersByTime(300);
  gate.onPlaybackDrained(1);
  vi.advanceTimersByTime(2100);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PLUG-120: исправления независимых аудитов (agy + codex, волна 1)", () => {
  // --------------------------------------------------------------------------
  // П. 1 (codex F01): Подмена аргументов за неизменной карточкой
  // --------------------------------------------------------------------------
  describe("п. 1: argsHash и защита аргументов", () => {
    it("п. 1 (codex F01): одношаговая C-ручка с _-ключом не подменяется и хеширует payload коннектора", async () => {
      const { s, a } = makeSession();
      const executed: unknown[] = [];
      const def: ToolDef = {
        name: "demo__transfer",
        cls: "C",
        word: "да",
        description: "Перевод средств",
        parameters: { type: "object", properties: { _amount: { type: "number" } } },
        confirmSay: (args) => `Перевести ${args._amount}?`,
        execute: async (args) => {
          executed.push(args._amount);
          return { ok: true, data: {} };
        },
      };
      a.projectConnectorTools = [def];

      const res1 = await runToolCall(def, { _amount: 1 }, "call_1", a.toolContext());
      expect(res1.result.ok).toBe(false);
      const p1 = s.pendingConfirmation()!;
      expect(p1).toBeDefined();
      expect(p1.say).toBe("Перевести 1?");

      // Повторный вызов с изменённым _amount должен отклониться с pending_exists
      const res2 = await runToolCall(def, { _amount: 900 }, "call_2", a.toolContext());
      expect(res2.result.ok).toBe(false);
      if (!res2.result.ok && "error" in res2.result) {
        expect(res2.result.error.code).toBe("pending_exists");
      }

      // Подтверждение кнопки одобряет исходную неизменяемую запись (1, а не 900)
      s.decideConfirmation(p1.confirmationId, "approve");
      await Promise.resolve();
      expect(executed).toEqual([1]);
    });

    it("п. 1: подмена storedArgs в сессии обнаруживается перед исполнением → action failed", async () => {
      const { s, a, frames } = makeSession();
      const executed: unknown[] = [];
      const def: ToolDef = {
        name: "demo__transfer",
        cls: "C",
        word: "да",
        description: "Перевод",
        parameters: { type: "object" },
        confirmSay: () => "Перевести?",
        execute: async (args) => {
          executed.push(args);
          return { ok: true, data: {} };
        },
      };
      a.projectConnectorTools = [def];
      await runToolCall(def, { amount: 100 }, "call_1", a.toolContext());
      const p = s.pendingConfirmation()!;
      // Сбой или подмена в storedArgs
      a.storedArgs.set(p.argsHash, { amount: 99999 });

      s.decideConfirmation(p.confirmationId, "approve");
      await Promise.resolve();
      expect(executed).toEqual([]);
      const actionFrame = frames.find((f: any) => f.type === "action" && f.status === "failed");
      expect(actionFrame).toBeDefined();
    });

    it("п. 1: встроенный инструмент с resolve игнорирует изменение _targetThread.updatedAt в хеше", () => {
      const hash1 = argsHash("send_to_thread", {
        thread: "General",
        text: "hello",
        _targetThread: { id: "thr_1", updatedAt: 1000 },
      });
      const hash2 = argsHash("send_to_thread", {
        thread: "General",
        text: "hello",
        _targetThread: { id: "thr_1", updatedAt: 9999 },
      });
      expect(hash1).toBe(hash2);

      // Но для обычных полей (в т.ч. _amount у коннектора) хеш различается
      const hashConn1 = argsHash("demo__write", { _amount: 1 });
      const hashConn2 = argsHash("demo__write", { _amount: 900 });
      expect(hashConn1).not.toBe(hashConn2);
    });

    it.each(["_targetThread", "_targetInteraction"])("п. 1 (R1): connector payload key %s participates in argsHash", (key) => {
      expect(argsHash("demo__write", { [key]: { amount: 1 } }))
        .not.toBe(argsHash("demo__write", { [key]: { amount: 900 } }));
    });

    it.each(["_targetThread", "_targetInteraction"])("п. 1 (R1): tampered connector field %s never executes behind old card", async (key) => {
      const { s, a } = makeSession();
      const executed: unknown[] = [];
      const def: ToolDef = {
        name: "demo__write",
        cls: "C",
        word: "да",
        description: "Demo",
        parameters: {},
        confirmSay: (args) => "Amount " + (args[key] as any).amount + "?",
        execute: async (args) => {
          executed.push((args[key] as any).amount);
          return { ok: true, data: {} };
        },
      };
      a.projectConnectorTools = [def];
      await runToolCall(def, { [key]: { amount: 1 } }, "one", a.toolContext());
      const p = s.pendingConfirmation()!;
      a.storedArgs.get(p.argsHash)[key] = { amount: 900 };
      s.decideConfirmation(p.confirmationId, "approve");
      await Promise.resolve();
      expect(executed).toEqual([]);
      expect(p.say).toBe("Amount 1?");
    });

    it("п. 1 (R3): pending arguments are a deep snapshot of nested connector payload", async () => {
      const { s, a } = makeSession();
      const executed: unknown[] = [];
      const def: ToolDef = {
        name: "demo__write",
        cls: "C",
        word: "да",
        description: "Demo",
        parameters: {},
        confirmSay: (args) => "Amount " + (args.payload as any).amount + "?",
        execute: async (args) => {
          executed.push((args.payload as any).amount);
          return { ok: true, data: {} };
        },
      };
      a.projectConnectorTools = [def];
      const input = { payload: { amount: 1 } };
      await runToolCall(def, input, "one", a.toolContext());
      const p = s.pendingConfirmation()!;
      input.payload.amount = 900;
      expect.soft(a.storedArgs.get(p.argsHash).payload.amount).toBe(1);
      s.decideConfirmation(p.confirmationId, "approve");
      await Promise.resolve();
      expect(executed).toEqual([1]);
    });
  });

  // --------------------------------------------------------------------------
  // П. 2 (codex F02): Таймер старого аудиохода открывает окно рано
  // --------------------------------------------------------------------------
  describe("п. 2: таймер окна и новое аудио", () => {
    it("п. 2 (codex F02): таймер старого аудиохода отменяется новым аудио и не открывает окно посреди следующего хода", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const verdicts: string[] = [];
      const gate = new ConfirmationGate(DEFAULT_WORDS, undefined, { onVerdict: (_, v) => verdicts.push(v) });
      gate.request("demo__write", {}, "C", "Вопрос?");

      // Ход 1: 1 с аудио (48000 байт)
      gate.onModelAudio(1, 48000);
      vi.advanceTimersByTime(300);
      gate.onPlaybackDrained(1);

      // До открытия окна начинается Ход 2: 10 с аудио (480000 байт)
      vi.advanceTimersByTime(300);
      gate.onModelAudio(2, 480000);

      // t = 2400 мс: старый таймер сработал бы здесь, но окно должно оставаться ЗАКРЫТЫМ
      vi.advanceTimersByTime(1800);
      expect(gate.windowOpen()).toBe(false);

      // «да» владельца во время воспроизведения длинного вопроса не должно давать approved
      gate.onOwnerTranscriptChunk("да");
      vi.advanceTimersByTime(700);
      expect(verdicts).not.toContain("approved");
    });
  });

  // --------------------------------------------------------------------------
  // П. 3 (codex F03 = agy F-01): Звонок завершился — pending жив
  // --------------------------------------------------------------------------
  describe("п. 3: завершение звонка гасит pending", () => {
    it("п. 3 (codex F03 = agy F-01): decideConfirmation после end() не исполняет действие и не пишет в память", async () => {
      const { s, a, store } = makeSession();
      const { toolByName } = await import("../src/tools.js");
      await runToolCall(toolByName("remember")!, { text: "SYNTHETIC MEMORY WRITE" }, "call_1", a.toolContext());
      const id = s.pendingConfirmation()!.confirmationId;
      await s.end("owner");

      s.decideConfirmation(id, "approve");
      await Promise.resolve();
      expect(store.listMemory().map((m) => m.text)).not.toContain("SYNTHETIC MEMORY WRITE");
    });

    it("п. 3: реплика, буферизованная до end(), не исполняется таймером после завершения звонка", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { s, a, store } = makeSession();
      const { toolByName } = await import("../src/tools.js");
      await runToolCall(toolByName("remember")!, { text: "BUFFERED MEMORY WRITE" }, "call_1", a.toolContext());
      openWindowManually(a.gate);
      a.gate.onOwnerTranscriptChunk("да");
      await s.end("owner");
      await vi.advanceTimersByTimeAsync(700);
      expect(store.listMemory().map((m) => m.text)).not.toContain("BUFFERED MEMORY WRITE");
    });

    it("п. 3: pending при end() гасится с verdict: cancelled и reason: call_ended до endCall", async () => {
      const { s, a, store } = makeSession();
      const { toolByName } = await import("../src/tools.js");
      await runToolCall(toolByName("remember")!, { text: "CANCELLED ON HANGUP" }, "call_1", a.toolContext());
      await s.end("owner");

      const events = store.transcript("call_synthetic");
      const verdictEvent = events.find((e) => e.kind === "verdict");
      expect(verdictEvent).toBeDefined();
      const payload = typeof verdictEvent?.payload === "string" ? JSON.parse(verdictEvent.payload) : verdictEvent?.payload;
      expect(payload?.verdict).toBe("cancelled");
      expect(payload?.reason).toBe("call_ended");
    });

    it("п. 3 (R4): end still completes cleanup if cancellation journaling fails", async () => {
      const { s, a, store, frames } = makeSession();
      const { toolByName } = await import("../src/tools.js");
      await runToolCall(toolByName("remember")!, { text: "Demo" }, "one", a.toolContext());
      const close = vi.fn();
      a.voice = { close };
      const ending = vi.fn();
      s.on("ending", ending);
      vi.spyOn(store, "event").mockImplementation(() => {
        throw new Error("synthetic journal unavailable");
      });
      const error = await s.end("owner").then(() => undefined, (e) => String(e));
      expect.soft(error).toBeUndefined();
      expect.soft(close).toHaveBeenCalledTimes(1);
      expect.soft(ending).toHaveBeenCalledTimes(1);
      expect.soft(frames.some((f: any) => f.type === "ended")).toBe(true);
      expect(s.pendingConfirmation()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // П. 6 (codex F07): toolExtra для всех инструментов
  // --------------------------------------------------------------------------
  describe("п. 6: toolExtra только для своего инструмента", () => {
    it("п. 6 (codex F07): toolExtra «останавливай» одобряет только stop_thread, а не любые C-ручки", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { s, a } = makeSession();
      const executed: unknown[] = [];
      const def: ToolDef = {
        name: "demo__send",
        cls: "C",
        word: "да",
        description: "Отправка",
        parameters: { type: "object" },
        confirmSay: () => "Отправить сообщение?",
        execute: async (args) => {
          executed.push(args);
          return { ok: true, data: {} };
        },
      };
      a.projectConnectorTools = [def];
      await runToolCall(def, { text: "hello" }, "call_1", a.toolContext());
      openWindowManually(a.gate);
      a.gate.onOwnerTranscriptChunk("останавливай");
      await vi.advanceTimersByTimeAsync(700);
      // Для demo__send слово «останавливай» не должно давать approved
      expect(executed).toHaveLength(0);
      expect(s.pendingConfirmation()).toBeNull();
      expect(a.lastVerdict?.verdict).toBe("cancelled");
    });
  });

  // --------------------------------------------------------------------------
  // П. 7 (codex F08 = agy F-05): hint не доходит до модели
  // --------------------------------------------------------------------------
  describe("п. 7: подсказка L/P и классификация", () => {
    it("п. 7 (codex F08 = agy F-05): classify для L/P даёт cancelled на вежливые слова и hint только при наличии confirm-слов", () => {
      expect(classify("пожалуйста", "L", DEFAULT_WORDS)).toBe("cancelled");
      expect(classify("пожалуйста", "P", DEFAULT_WORDS)).toBe("cancelled");
      expect(classify("ну да", "L", DEFAULT_WORDS)).toBe("hint");
      expect(classify("ну да", "P", DEFAULT_WORDS)).toBe("hint");
      expect(classify("запускай", "L", DEFAULT_WORDS)).toBe("approved");
      expect(classify("разрешаю", "P", DEFAULT_WORDS)).toBe("approved");
    });

    it("п. 7: native hint отправляет модели вставку подсказки и открывает окно через 3 с без аудио", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { s, a } = makeSession();
      const send = vi.fn();
      a.voice = { sendClientContent: send, sendAudio: vi.fn(() => true) };
      const executed = vi.fn(async () => ({ ok: true as const, data: {} }));
      const def: ToolDef = {
        name: "demo__launch",
        cls: "L",
        word: "запускай",
        description: "Запуск агента",
        parameters: { type: "object" },
        confirmSay: () => "Запустить агента?",
        execute: executed,
      };
      a.projectConnectorTools = [def];
      await runToolCall(def, {}, "call_1", a.toolContext());
      openWindowManually(a.gate);

      // Владелец говорит «да» на действие класса L
      a.gate.onOwnerTranscriptChunk("да");
      await vi.advanceTimersByTimeAsync(700);

      expect(s.pendingConfirmation()!.verdict).toBeNull();
      expect(a.gate.isMicOpen()).toBe(false);
      expect(send).toHaveBeenCalledWith(
        expect.stringContaining("«Да» для этого действия не подходит, ничего не выполнено. Скажи владельцу одной фразой: «Для запуска скажи «запускай»» и жди ответа"),
        true,
      );

      // Без аудио модели через 3 с с отступом 300 мс (3.3 с) окно открывается снова
      await vi.advanceTimersByTimeAsync(3300);
      expect(a.gate.windowOpen()).toBe(true);
      expect(a.gate.isMicOpen()).toBe(true);

      // После открытия окна «запускай» даёт approved и исполняет действие
      a.onBrowserAudio(makeSpeechPcm(8, 1000));
      a.gate.onOwnerTranscriptChunk("запускай");
      await vi.advanceTimersByTimeAsync(700);
      expect(executed).toHaveBeenCalledTimes(1);
      expect(a.lastVerdict?.verdict).toBe("approved");
    });

    it("п. 7: в режиме router hint отправляет подсказку, а не повторяет старый p.say", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { s, a } = makeSession({ mode: "extended", allowExtended: true });
      const send = vi.fn();
      a.voice = { sendClientContent: send, sendAudio: vi.fn(() => true) };
      const def: ToolDef = {
        name: "demo__launch",
        cls: "L",
        word: "запускай",
        description: "Запуск",
        parameters: { type: "object" },
        confirmSay: () => "Запустить?",
        execute: async () => ({ ok: true, data: {} }),
      };
      a.projectConnectorTools = [def];
      await runToolCall(def, {}, "call_1", a.toolContext());
      openWindowManually(a.gate);

      send.mockClear();
      a.gate.onOwnerTranscriptChunk("да");
      await vi.advanceTimersByTimeAsync(700);

      const calls = send.mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((c: string) => c.includes("Для запуска скажи «запускай»"))).toBe(true);
      expect(calls.some((c: string) => c.includes("Скажи владельцу: Запустить?"))).toBe(false);
    });

    it("п. 7 (R2): пока звучит подсказка, шлюз микрофона закрыт (аудио не уходит в сессию, транскрипт отбрасывается), а «запускай» владельца после окна → approved", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { s, a } = makeSession();
      const sendAudio = vi.fn(() => true);
      const voice = Object.assign(new EventEmitter(), {
        sendClientContent: vi.fn(),
        sendAudio,
        sendRealtimeAudio: vi.fn(),
        sendToolResponse: vi.fn(),
      });
      a.voice = voice;
      a.wireVoice(voice);

      const executed: unknown[] = [];
      const def: ToolDef = {
        name: "demo__launch",
        cls: "L",
        word: "запускай",
        description: "Запуск агента",
        parameters: { type: "object" },
        confirmSay: () => "Запустить агента?",
        execute: async () => {
          executed.push(true);
          return { ok: true as const, data: {} };
        },
      };
      a.projectConnectorTools = [def];
      await runToolCall(def, {}, "call_1", a.toolContext());
      openWindowManually(a.gate);

      // 1. Владелец говорит «да» на L-действие -> срабатывает подсказка (hint)
      voice.emit("inputTranscript", "да");
      await vi.advanceTimersByTimeAsync(700);
      expect(a.gate.isMicOpen()).toBe(false);

      // 2. Модель воспроизводит подсказку (ход 2)
      a.gate.onModelAudio(2, 48000);
      voice.emit("outputTranscript", "Для запуска скажи «запускай»");

      // Пока звучит подсказка, шлюз микрофона закрыт
      expect(a.gate.isMicOpen()).toBe(false);

      // Попытка отправить аудио с микрофона: в сессию не уходит
      sendAudio.mockClear();
      a.onBrowserAudio(new Uint8Array([0, 10, 0, 20]));
      expect(sendAudio).not.toHaveBeenCalled();

      // Любой транскрипт или эхо от микрофона в этот момент отбрасывается
      voice.emit("inputTranscript", "запускай");
      await vi.advanceTimersByTimeAsync(100);
      expect(executed).toEqual([]);
      expect(s.pendingConfirmation()?.verdict).toBeNull();

      // 3. Подсказка завершилась: playback drained + пауза -> окно открывается
      vi.advanceTimersByTime(300);
      a.gate.onPlaybackDrained(2);
      await vi.advanceTimersByTimeAsync(2100);
      expect(a.gate.windowOpen()).toBe(true);
      expect(a.gate.isMicOpen()).toBe(true);

      // 4. Теперь настоящее «запускай» от владельца после открытия окна
      a.onBrowserAudio(makeSpeechPcm(8, 1000));
      voice.emit("inputTranscript", "запускай");
      await vi.advanceTimersByTimeAsync(700);

      expect(executed).toHaveLength(1);
      expect(a.lastVerdict?.verdict).toBe("approved");
    });
  });

  // --------------------------------------------------------------------------
  // П. 9 (codex F10): Symlink traversal в реестре проектов
  // --------------------------------------------------------------------------
  describe("п. 9: безопасное чтение конфигурации проектов", () => {
    it("п. 9 (codex F10): симлинк каталога .bb/live-call наружу не читается", () => {
      const dir = mkdtempSync(join(tmpdir(), "live-symlink-test-"));
      try {
        const root = join(dir, "project");
        const external = join(dir, "external");
        mkdirSync(join(root, ".bb"), { recursive: true });
        mkdirSync(external);
        writeFileSync(join(external, "PROMPT.md"), "EXTERNAL FORBIDDEN PROMPT");
        symlinkSync(external, join(root, ".bb", "live-call"), "dir");

        const config = readProjectRepoConfig(root);
        expect(config.promptMd).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("п. 9: FIFO вместо файла окружения не подвешивает чтение", () => {
      const dir = mkdtempSync(join(tmpdir(), "live-fifo-test-"));
      try {
        const root = join(dir, "project");
        const lcDir = join(root, ".bb", "live-call");
        mkdirSync(lcDir, { recursive: true });
        const fifoPath = join(lcDir, "PROMPT.md");
        try {
          execSync(`mkfifo "${fifoPath}"`);
        } catch {
          return;
        }
        const config = readProjectRepoConfig(root);
        expect(config.promptMd).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("п. 9: корень проекта как симлинк успешно читает настоящие файлы внутри", () => {
      const dir = mkdtempSync(join(tmpdir(), "live-root-symlink-test-"));
      try {
        const realRoot = join(dir, "real_project");
        mkdirSync(join(realRoot, ".bb", "live-call"), { recursive: true });
        writeFileSync(join(realRoot, ".bb", "live-call", "PROMPT.md"), "ALLOWED PROJECT PROMPT");

        const symlinkRoot = join(dir, "symlink_project");
        symlinkSync(realRoot, symlinkRoot, "dir");

        const config = readProjectRepoConfig(symlinkRoot);
        expect(config.promptMd).toBe("ALLOWED PROJECT PROMPT");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // П. 10 (codex F11): Ротация не подключена
  // --------------------------------------------------------------------------
  describe("п. 10: ротация CallStore и файлов мозгового центра", () => {
    it("п. 10 (codex F11): ротация CallStore и brain-files вызывается при загрузке плагина и по таймеру 24 ч", async () => {
      const testDir = mkdtempSync(join(tmpdir(), "live-rot-test-"));
      const brainDir = join(testDir, "plugins", "live-call", "brain-files");
      mkdirSync(brainDir, { recursive: true });

      const db = new Database(":memory:");
      const now = Date.now();
      const oldStartedAt = now - 95 * 24 * 3600 * 1000;
      const recentStartedAt = now - 5 * 24 * 3600 * 1000;

      // Инициализируем таблицы CallStore
      new CallStore(db);

      // Вставляем старый звонок (>90 дней) и свежий
      db.prepare("INSERT INTO calls (id, thread_id, started_at) VALUES (?, ?, ?)").run("call_old", "thr_old", oldStartedAt);
      db.prepare("INSERT INTO call_events (call_id, seq, ts, kind, payload) VALUES (?, 1, ?, 'start', '{}')").run("call_old", oldStartedAt);
      db.prepare("INSERT INTO calls (id, thread_id, started_at) VALUES (?, ?, ?)").run("call_recent", "thr_recent", recentStartedAt);
      db.prepare("INSERT INTO call_events (call_id, seq, ts, kind, payload) VALUES (?, 1, ?, 'start', '{}')").run("call_recent", recentStartedAt);

      // Создаём старый и свежий файлы мозгового центра
      const oldBrainFile = join(brainDir, "brain-history-call_old.txt");
      const recentBrainFile = join(brainDir, "brain-history-call_recent.txt");
      writeFileSync(oldBrainFile, "old brain history");
      writeFileSync(recentBrainFile, "recent brain history");
      utimesSync(oldBrainFile, oldStartedAt / 1000, oldStartedAt / 1000);

      const onDisposeCallbacks: Array<() => void> = [];
      const api: any = {
        settings: { define: () => ({ get: async () => ({ geminiKeys: "fake" }), experimental_set: async () => {} }) },
        storage: { database: () => db },
        server: { experimental_dataDir: testDir, loopbackBaseUrl: "http://127.0.0.1" },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        onDispose: (fn: () => void) => onDisposeCallbacks.push(fn),
        sdk: {
          threads: { get: async () => ({ id: "thr_t" }), list: async () => [], listRunning: async () => [], markRead: async () => {} },
          projects: { get: async () => ({ id: "demo" }) },
          system: { config: async () => ({ primaryHostId: "host_local" }) },
        },
        http: { experimental_websocket: () => {} },
        providers: { register: () => {} },
        events: { on: () => {} },
        rpc: { register: () => {} },
        cli: { register: () => {} },
      };

      const { default: plugin } = await import("../server.js");
      await plugin(api);

      // При загрузке ротация удалила старый звонок и старый brain-файл
      const remainingCalls = db.prepare("SELECT id FROM calls").all() as Array<{ id: string }>;
      expect(remainingCalls.map((c) => c.id)).toEqual(["call_recent"]);
      const remainingEvents = db.prepare("SELECT call_id FROM call_events").all() as Array<{ call_id: string }>;
      expect(remainingEvents.map((e) => e.call_id)).toEqual(["call_recent"]);

      const { existsSync } = await import("node:fs");
      expect(existsSync(oldBrainFile)).toBe(false);
      expect(existsSync(recentBrainFile)).toBe(true);

      // Таймер зарегистрирован и снимается в onDispose
      expect(onDisposeCallbacks.length).toBeGreaterThan(0);
      for (const d of onDisposeCallbacks) d();
      db.close();
      rmSync(testDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // П. 11 (agy F-02): Карточка теряется при переподключении
  // --------------------------------------------------------------------------
  describe("п. 11: resendReady() повторяет active confirmation", () => {
    it("п. 11 (agy F-02): resendReady() восстанавливает кадр confirmation для ожидающего подтверждения", async () => {
      const { s, a, frames } = makeSession();
      const { toolByName } = await import("../src/tools.js");
      await runToolCall(toolByName("remember")!, { text: "RESEND TEST" }, "call_1", a.toolContext());
      const id = s.pendingConfirmation()!.confirmationId;

      frames.length = 0;
      s.resendReady();

      const confFrame = frames.find((f: any) => f.type === "confirmation");
      expect(confFrame).toBeDefined();
      expect((confFrame as any)?.confirmationId).toBe(id);
      expect((confFrame as any)?.phase).toBe("asking");
    });

    it("п. 11: resendReady() не повторяет кадр confirmation, если pending уже одобрен (идёт исполнение)", async () => {
      const { s, a, frames } = makeSession();
      let resolveExecute: () => void = () => {};
      const executePromise = new Promise<void>((r) => {
        resolveExecute = r;
      });
      const def: ToolDef = {
        name: "demo__slow",
        cls: "C",
        word: "да",
        description: "Медленное действие",
        parameters: { type: "object" },
        confirmSay: () => "Запустить?",
        execute: async () => {
          await executePromise;
          return { ok: true, data: {} };
        },
      };
      a.projectConnectorTools = [def];
      await runToolCall(def, {}, "call_1", a.toolContext());
      const p = s.pendingConfirmation()!;

      s.decideConfirmation(p.confirmationId, "approve");
      expect(p.verdict).toBe("approved");

      frames.length = 0;
      s.resendReady();

      const confFrame = frames.find((f: any) => f.type === "confirmation");
      expect(confFrame).toBeUndefined();

      resolveExecute();
      await Promise.resolve();
    });
  });

  // --------------------------------------------------------------------------
  // П. 12 (agy F-04): Зависание gate при неизвестном инструменте
  // --------------------------------------------------------------------------
  describe("п. 12: снятие pending при неизвестном инструменте", () => {
    it("п. 12 (agy F-04): onVerdict при неизвестном инструменте потребляет gate и не зависает", async () => {
      const { s, a, frames } = makeSession();
      const req = a.gate.request("unknown_tool_xyz", { foo: "bar" }, "C", "Выполнить неизвестное?");
      expect("pending" in req).toBe(true);
      const id = req.pending.confirmationId;

      s.decideConfirmation(id, "approve");
      await Promise.resolve();

      expect(s.pendingConfirmation()).toBeNull();
      const actionFrame = frames.find((f: any) => f.type === "action" && f.tool === "unknown_tool_xyz" && f.status === "failed");
      expect(actionFrame).toBeDefined();

      // Следующий запрос другого инструмента не получает pending_exists
      const req2 = a.gate.request("remember", { text: "next" }, "C", "Запомнить?");
      expect("pending" in req2).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // П. 13 (agy F-06): systemBatchTimer переживает end()
  // --------------------------------------------------------------------------
  describe("п. 13: очистка systemBatchTimer при end()", () => {
    it("п. 13 (agy F-06): systemBatchTimer очищается в end() и не пишет в журнал после завершения звонка", async () => {
      vi.useFakeTimers();
      const { s, a, store } = makeSession({ mode: "extended", allowExtended: true });
      a.enqueueSystem("read_thread", { ok: true, data: { text: "BATCH AFTER HANGUP" } });

      await s.end("owner");
      await vi.advanceTimersByTimeAsync(400);

      const events = store.transcript("call_synthetic");
      const batchEvent = events.find((e: any) => e.kind === "system_batch");
      expect(batchEvent).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Волна 1 round-3: C1 позднее аудио hint и свидетельство новой речи (§7.1 п. 5.3)
  // --------------------------------------------------------------------------
  describe("Волна 1 round-3: C1 позднее аудио hint и свидетельство новой речи (§7.1 п. 5.3)", () => {
    it.each([["normal", "L"], ["normal", "P"], ["extended", "L"], ["extended", "P"]] as const)(
      "%s %s: input audio sent BEFORE hint cannot vote after its window reopens",
      async (mode, cls) => {
        vi.useFakeTimers();
        vi.setSystemTime(1000000);
        const { s, a, socket, def, state, word } = liveFixture(mode, cls);
        await runToolCall(def, {}, "one", a.toolContext());
        openWindowManually(a.gate);

        // Аудио отправлено ДО hint: распознаватель мог сохранить его
        a.onBrowserAudio(new Uint8Array([0, 100, 0, 100]));
        expect(socket.audioCount).toBe(1);
        socket.receive({ inputTranscription: { text: "да" } });
        await vi.advanceTimersByTimeAsync(700);
        expect(a.gate.isMicOpen()).toBe(false);

        const sendsBeforeHint = socket.audioCount;
        a.onBrowserAudio(new Uint8Array([0, 100, 0, 100]));
        expect(socket.audioCount).toBe(sendsBeforeHint);

        socket.receive({
          modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(48000).toString("base64") } }] },
          outputTranscription: { text: cls === "L" ? "Для запуска скажи запускай" : "Чтобы разрешить скажи разрешаю" },
        });
        await vi.advanceTimersByTimeAsync(300);
        s.onPlaybackDrained(2);
        await vi.advanceTimersByTimeAsync(2100);
        expect(a.gate.windowOpen()).toBe(true);
        expect(socket.audioCount).toBe(sendsBeforeHint);

        // После открытия окна не отправлено аудио. Приходит задержанный транскрипт из старого входа.
        socket.receive({ inputTranscription: { text: word } });
        await vi.advanceTimersByTimeAsync(700);
        expect(state.executions).toBe(0);
        expect(a.gate.pendingConfirmation()?.verdict).toBeNull();
      },
    );

    it.each(["normal", "extended"] as const)(
      "%s: no-audio fallback must close microphone again when hint audio finally arrives",
      async (mode) => {
        vi.useFakeTimers();
        vi.setSystemTime(1000000);
        const { a, socket, def, state } = liveFixture(mode, "L");
        await runToolCall(def, {}, "one", a.toolContext());
        openWindowManually(a.gate);
        socket.receive({ inputTranscription: { text: "да" } });
        await vi.advanceTimersByTimeAsync(700);
        await vi.advanceTimersByTimeAsync(3300);
        expect(a.gate.windowOpen()).toBe(true);

        socket.receive({
          modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(480000).toString("base64") } }] },
          outputTranscription: { text: "Для запуска скажи запускай" },
        });
        const before = socket.audioCount;
        a.onBrowserAudio(new Uint8Array([0, 100, 0, 100]));
        expect.soft(a.gate.isMicOpen()).toBe(false);
        expect.soft(socket.audioCount).toBe(before);

        socket.receive({ inputTranscription: { text: "запускай" } });
        await vi.advanceTimersByTimeAsync(700);
        expect(state.executions).toBe(0);
      },
    );

    it.each([["normal", "L"], ["normal", "P"], ["extended", "L"], ["extended", "P"]] as const)(
      "%s %s: настоящий ответ с речью после окна → approved",
      async (mode, cls) => {
        vi.useFakeTimers();
        vi.setSystemTime(1000000);
        const { s, a, socket, def, state, word } = liveFixture(mode, cls);
        await runToolCall(def, {}, "one", a.toolContext());
        openWindowManually(a.gate);
        socket.receive({ inputTranscription: { text: "да" } });
        await vi.advanceTimersByTimeAsync(700);
        socket.receive({
          modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(48000).toString("base64") } }] },
          outputTranscription: { text: cls === "L" ? "Для запуска скажи запускай" : "Чтобы разрешить скажи разрешаю" },
        });
        await vi.advanceTimersByTimeAsync(300);
        s.onPlaybackDrained(2);
        await vi.advanceTimersByTimeAsync(2100);
        expect(a.gate.windowOpen()).toBe(true);
        expect(a.gate.isMicOpen()).toBe(true);

        // Настоящая речь владельца после окна: 8 блоков по 640 байт с peak 1000 (> 300) = 160 мс >= 150 мс
        a.onBrowserAudio(makeSpeechPcm(8, 1000));
        socket.receive({ inputTranscription: { text: word } });
        await vi.advanceTimersByTimeAsync(700);
        expect(state.executions).toBe(1);
        expect(a.lastVerdict?.verdict).toBe("approved");
      },
    );

    it("ранний partial до набора порога с продолжением → approved", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { a, socket, def, state } = liveFixture("normal", "L");
      await runToolCall(def, {}, "one", a.toolContext());
      openWindowManually(a.gate);
      socket.receive({ inputTranscription: { text: "да" } });
      await vi.advanceTimersByTimeAsync(700);
      await vi.advanceTimersByTimeAsync(3300);
      expect(a.gate.windowOpen()).toBe(true);

      // 1. Владелец начал говорить: отправлено 2 блока (40 мс)
      a.onBrowserAudio(makeSpeechPcm(2, 1000));
      // Приходит ранний partial кусок транскрипта
      socket.receive({ inputTranscription: { text: "зап" } });

      // 2. В процессе реплики речь продолжается: ещё 7 блоков (140 мс), сумма 180 мс >= 150 мс
      await vi.advanceTimersByTimeAsync(100);
      a.onBrowserAudio(makeSpeechPcm(7, 1000));
      socket.receive({ inputTranscription: { text: "ускай" } });
      await vi.advanceTimersByTimeAsync(700);
      expect(state.executions).toBe(1);
      expect(a.lastVerdict?.verdict).toBe("approved");
    });

    it("тихий ответ (пик 250) → вердикта нет", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { a, socket, def, state } = liveFixture("normal", "L");
      await runToolCall(def, {}, "one", a.toolContext());
      openWindowManually(a.gate);
      socket.receive({ inputTranscription: { text: "да" } });
      await vi.advanceTimersByTimeAsync(700);
      await vi.advanceTimersByTimeAsync(3300);
      expect(a.gate.windowOpen()).toBe(true);

      // Тихий ответ: пиковая амплитуда 250 <= 300 (HINT_SPEECH_PEAK)
      a.onBrowserAudio(makeSpeechPcm(8, 250));
      socket.receive({ inputTranscription: { text: "запускай" } });
      await vi.advanceTimersByTimeAsync(700);
      expect(state.executions).toBe(0);
      expect(a.gate.pendingConfirmation()?.verdict).toBeNull();
    });

    it("позднее аудио hint при уже запущенном таймере вердикта → окно инвалидировано", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { a, socket, def, state } = liveFixture("normal", "L");
      await runToolCall(def, {}, "one", a.toolContext());
      openWindowManually(a.gate);
      socket.receive({ inputTranscription: { text: "да" } });
      await vi.advanceTimersByTimeAsync(700);
      // Резервное открытие окна через 3.3 с
      await vi.advanceTimersByTimeAsync(3300);
      expect(a.gate.windowOpen()).toBe(true);

      // Приходит транскрипт "запускай", запустив таймер 700 мс
      socket.receive({ inputTranscription: { text: "запускай" } });
      await vi.advanceTimersByTimeAsync(200);

      // Пока таймер тикает, приходит позднее аудио hint
      socket.receive({
        modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(48000).toString("base64") } }] },
        outputTranscription: { text: "Для запуска скажи запускай" },
      });

      // Окно инвалидировано, шлюз закрыт, таймер вердикта снят
      expect(a.gate.windowOpen()).toBe(false);
      expect(a.gate.isMicOpen()).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      expect(state.executions).toBe(0);
      expect(a.gate.pendingConfirmation()?.verdict).toBeNull();
    });

    it("явное «нет» без свидетельства → cancelled", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { a, socket, def, state } = liveFixture("normal", "L");
      await runToolCall(def, {}, "one", a.toolContext());
      openWindowManually(a.gate);
      socket.receive({ inputTranscription: { text: "да" } });
      await vi.advanceTimersByTimeAsync(700);
      await vi.advanceTimersByTimeAsync(3300);
      expect(a.gate.windowOpen()).toBe(true);

      // Аудио речи нет вообще (0 мс свидетельства)
      socket.receive({ inputTranscription: { text: "нет" } });
      await vi.advanceTimersByTimeAsync(700);
      expect(state.executions).toBe(0);
      expect(a.gate.pendingConfirmation()).toBeNull();
      expect(a.lastVerdict?.verdict).toBe("cancelled");
    });

    it.each(["normal", "extended"] as const)(
      "%s: failed WebSocket.send is not speech evidence (F1)",
      async (mode) => {
        vi.useFakeTimers();
        vi.setSystemTime(1000000);
        const { a, socket, def, state, word } = liveFixture(mode, "L");
        await runToolCall(def, {}, "one", a.toolContext());
        openWindowManually(a.gate);
        socket.receive({ inputTranscription: { text: "да" } });
        await vi.advanceTimersByTimeAsync(700);
        await vi.advanceTimersByTimeAsync(3300);
        expect(a.gate.windowOpen()).toBe(true);

        socket.send = () => {
          throw Error("synthetic websocket write failure");
        };
        a.onBrowserAudio(makeSpeechPcm());
        expect.soft(socket.audioCount).toBe(0);
        expect.soft(a.gate.getSpeechEvidenceMs()).toBe(0);

        socket.receive({ inputTranscription: { text: word } });
        await vi.advanceTimersByTimeAsync(700);
        expect(state.executions).toBe(0);
      },
    );

    it.each(["normal", "extended"] as const)(
      "%s: non-open socket cannot create speech evidence (F1)",
      async (mode) => {
        vi.useFakeTimers();
        vi.setSystemTime(1000000);
        const { a, socket, def } = liveFixture(mode, "L");
        await runToolCall(def, {}, "one", a.toolContext());
        openWindowManually(a.gate);
        socket.receive({ inputTranscription: { text: "да" } });
        await vi.advanceTimersByTimeAsync(700);
        await vi.advanceTimersByTimeAsync(3300);
        expect(a.gate.windowOpen()).toBe(true);

        socket.readyState = 0;
        a.onBrowserAudio(makeSpeechPcm());
        expect(socket.audioCount).toBe(0);
        expect(a.gate.getSpeechEvidenceMs()).toBe(0);
      },
    );

    it.each([0, 250])(
      "VAD utterance end cannot invent evidence for PCM peak %s (F2)",
      async (peak) => {
        vi.useFakeTimers();
        vi.setSystemTime(1000000);
        const { a, socket, def, state, word } = liveFixture("normal", "L");
        await runToolCall(def, {}, "one", a.toolContext());
        openWindowManually(a.gate);
        socket.receive({ inputTranscription: { text: "да" } });
        await vi.advanceTimersByTimeAsync(700);
        await vi.advanceTimersByTimeAsync(3300);
        expect(a.gate.windowOpen()).toBe(true);

        if (peak) a.onBrowserAudio(makeSpeechPcm(8, peak));
        expect(a.gate.getSpeechEvidenceMs()).toBe(0);
        a.gate.onOwnerUtteranceEnd(word, Date.now(), Date.now());
        await Promise.resolve();
        expect(state.executions).toBe(0);
      },
    );

    it("a zero-byte end-of-turn marker preserves an already scheduled hint window (F3)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { s, a, socket, def } = liveFixture("normal", "L");
      await runToolCall(def, {}, "one", a.toolContext());
      openWindowManually(a.gate);
      socket.receive({ inputTranscription: { text: "да" } });
      await vi.advanceTimersByTimeAsync(700);
      socket.receive({
        modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(48000).toString("base64") } }] },
        outputTranscription: { text: "Для запуска скажи запускай" },
      });
      await vi.advanceTimersByTimeAsync(300);
      s.onPlaybackDrained(2);
      expect(a.gate.windowOpen()).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      // Real LiveClient emits audio(turnSeq, Uint8Array(0)) on this message.
      socket.receive({ turnComplete: true });
      await vi.advanceTimersByTimeAsync(1800);
      expect(a.gate.windowOpen()).toBe(true);
    });

    it("odd-byte packets are invalid PCM16 and do not contribute evidence (F4)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      const { a, socket, def } = liveFixture("normal", "L");
      await runToolCall(def, {}, "one", a.toolContext());
      openWindowManually(a.gate);
      socket.receive({ inputTranscription: { text: "да" } });
      await vi.advanceTimersByTimeAsync(700);
      await vi.advanceTimersByTimeAsync(3300);
      expect(a.gate.windowOpen()).toBe(true);

      const odd = makeSpeechPcm(2).subarray(0, 643);
      for (let n = 0; n < 8; n++) a.onBrowserAudio(odd);
      expect(a.gate.getSpeechEvidenceMs()).toBe(0);
    });
  });
});
