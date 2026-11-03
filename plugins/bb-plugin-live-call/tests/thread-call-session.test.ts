import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import type { ServerFrame } from "../src/contract.js";

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
}

function makeThreadCall(targetThreadId?: string, env?: Record<string, unknown>, spawned?: Array<Record<string, unknown>>) {
  const store = new CallStore(new Database(":memory:"));
  const frames: ServerFrame[] = [];
  const fakeSdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({
        id: threadId,
        title: "Оптимизация логики агента",
        projectId: "proj_test",
        status: "idle",
        ...(env ? { environmentId: "env_test" } : {}),
      }),
      spawn: async (a: Record<string, unknown>) => {
        spawned?.push(a);
        return { id: "thr_brain_spawned" };
      },
      list: async () => [],
      events: {
        list: async () => [
          { id: "e1", seq: 1, type: "client/turn/requested", createdAt: 1000, data: { input: [{ text: "Привет" }] } },
          { id: "e2", seq: 2, type: "item/completed", createdAt: 2000, data: { item: { type: "agentMessage", text: "Здравствуйте" } } },
        ],
      },
    },
    projects: {
      list: async () => [{ id: "proj_test", name: "Тестовый проект" }],
    },
    environments: { get: async () => env ?? {} },
  };

  const s = new CallSession({
    callId: "call_tc",
    keys: ["k1", "k2"],
    voice: "Algenib",
    languageCode: "ru-RU",
    thinkingLevel: "LOW",
    mode: "extended",
    routerInput: "text",
    maxCallMinutes: 60,
    store,
    sdk: fakeSdk as never,
    targetThreadId,
    toBrowser: (f) => frames.push(f),
    sendBrowserAudio: () => {},
    spawnCallThread: async () => null,
    advanceCallThread: async () => {},
    sayCallThread: async () => {},
    endCallThread: async () => {},
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
  });

  return { s, store, frames };
}

describe("сессия звонка по треду (§12.1, §12.3, §12.5, §12.7)", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("инициализация звонка по треду: журнал, threadId, кадры и инструкции", async () => {
    const { s, store, frames } = makeThreadCall("thr_testlong01");
    await s.start();
    await vi.advanceTimersByTimeAsync(10);

    // 1. targetThreadId установлен в целевой тред, threadId равен null до первой реплики
    expect(s.targetThreadId).toBe("thr_testlong01");
    expect(s.threadId).toBeNull();

    // 2. События call_started и thread_context записаны в журнал звонка
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const events = db.prepare("SELECT kind, payload FROM call_events WHERE call_id = 'call_tc' ORDER BY seq").all() as Array<{ kind: string; payload: string }>;
    const callStarted = events.find((e) => e.kind === "call_started");
    expect(callStarted).toBeDefined();
    expect(JSON.parse(callStarted!.payload)).toEqual({ targetThreadId: "thr_testlong01" });

    const threadCtx = events.find((e) => e.kind === "thread_context");
    expect(threadCtx).toBeDefined();
    const ctxData = JSON.parse(threadCtx!.payload);
    expect(ctxData.messages).toBe(2);
    expect(ctxData.skipped).toBe(0);
    expect(ctxData.chars).toBeGreaterThan(0);

    // 3. Клиенту отправлен кадр ready (кадр thread отправится при спавне треда звонка)
    expect(frames.some((f) => f.type === "ready")).toBe(true);
    expect(frames.some((f) => f.type === "thread")).toBe(false);

    // 4. Сессия Gemini: ровно 1 сессия (gemini-3.8-live) с инструментами, без ROUTER (§12.10)
    expect(FakeWs.all).toHaveLength(1);
    const voiceSetup = JSON.parse(FakeWs.all[0].sent[0]);
    expect(voiceSetup.setup.model).toBe("models/gemini-3.8-live");
    const voiceInstruction = voiceSetup.setup.systemInstruction.parts[0].text;
    expect(voiceInstruction).toContain("Оптимизация логики агента");
    expect(voiceInstruction).toContain("Тестовый проект");
    expect(voiceInstruction).toContain("СОСТОЯНИЕ ТРЕДА:");
    expect(voiceInstruction).toContain("СООБЩЕНИЯ ТРЕДА:");
    expect(voiceInstruction).toContain("Здравствуйте");

    const toolNames = voiceSetup.setup.tools.flatMap((t: { functionDeclarations: Array<{ name: string }> }) => t.functionDeclarations.map((f) => f.name));
    expect(toolNames).toContain("thread_read_messages");
    expect(toolNames).toContain("thread_send");
    expect(toolNames).toContain("thread_answer");
    expect(toolNames).not.toContain("switch_mode");
    expect(toolNames).not.toContain("start_thread");
  });

  it("sendUserMessage (кадр text): транскрипт, owner_line, clientContent, без подтверждений", async () => {
    const { s, store, frames } = makeThreadCall("thr_testlong01");
    await s.start();
    await vi.advanceTimersByTimeAsync(10);

    // Отправляем текстовый ввод владельца
    s.sendUserMessage("Какая главная задача треда?");

    // 1. Клиент получает transcript owner
    const transcript = frames.find(
      (f): f is Extract<ServerFrame, { type: "transcript" }> =>
        f.type === "transcript" && f.text === "Какая главная задача треда?",
    );
    expect(transcript).toBeDefined();
    expect(transcript?.role).toBe("owner");

    // 2. В журнале записано owner_line
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const ownerEvents = db.prepare("SELECT kind, payload FROM call_events WHERE call_id = 'call_tc' AND kind = 'owner_line'").all() as Array<{ payload: string }>;
    expect(ownerEvents).toHaveLength(1);
    expect(JSON.parse(ownerEvents[0].payload).text).toBe("Какая главная задача треда?");

    // 3. VOICE получает clientContent с turnComplete=true
    const voiceWs = FakeWs.all[0];
    const clientMsg = voiceWs.sent.find((m) => m.includes("Какая главная задача треда?"));
    expect(clientMsg).toBeDefined();
    const parsedClientMsg = JSON.parse(clientMsg!);
    expect(parsedClientMsg.clientContent.turnComplete).toBe(true);

    // 4. Подтверждение текстом не работает: нет pending-подтверждения
    expect(s.pendingConfirmation()).toBeNull();
  });

  it("в звонке по треду режим строго normal (§12.10), switchMode игнорируется", async () => {
    const { s } = makeThreadCall("thr_testlong01");
    await s.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(s.mode).toBe("normal");
    expect(FakeWs.all).toHaveLength(1);

    // Попытка переключить в extended отклоняется
    await s.switchMode("extended");
    await vi.advanceTimersByTimeAsync(10);

    expect(s.mode).toBe("normal");
    expect(s.targetThreadId).toBe("thr_testlong01");
    expect(FakeWs.all).toHaveLength(1);
  });

  it("в звонке по треду реплика владельца НЕ вызывает advanceCallThread/sayCallThread для целевого треда", async () => {
    const targetThreadId = "thr_target_protected_456";
    const advancedThreads: string[] = [];
    const saidThreads: string[] = [];
    let spawnedFirstUtterance: string | null = null;

    const store = new CallStore(new Database(":memory:"));
    const frames: ServerFrame[] = [];
    const fakeSdk = {
      threads: {
        get: async () => ({ id: targetThreadId, title: "Целевой тред", projectId: "proj_test" }),
        list: async () => [],
        events: { list: async () => [] },
      },
      projects: { list: async () => [] },
    };

    let sessionInstance: CallSession | null = null;
    const s = new CallSession({
      callId: "call_isolated",
      keys: ["k1", "k2"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "extended",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: fakeSdk as never,
      targetThreadId,
      toBrowser: (f) => frames.push(f),
      sendBrowserAudio: () => {},
      spawnCallThread: async (first) => {
        spawnedFirstUtterance = first;
        return "thr_calls_dedicated_recording";
      },
      advanceCallThread: async () => {
        const t = sessionInstance?.threadId;
        if (t) advancedThreads.push(t);
      },
      sayCallThread: async () => {
        const t = sessionInstance?.threadId;
        if (t) saidThreads.push(t);
      },
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });
    sessionInstance = s;

    await s.start();
    await vi.advanceTimersByTimeAsync(10);

    // Целевой тред зафиксирован в targetThreadId, а threadId ещё null (до первой реплики)
    expect(s.targetThreadId).toBe(targetThreadId);
    expect(s.threadId).toBeNull();

    // 1-я реплика владельца
    s.sendUserMessage("Первый вопрос владельца");
    await vi.advanceTimersByTimeAsync(10);

    // Создан тред звонка в проекте «Звонки»
    expect(spawnedFirstUtterance).toBe("Первый вопрос владельца");
    expect(s.threadId).toBe("thr_calls_dedicated_recording");

    // 2-я реплика владельца
    s.sendUserMessage("Второй вопрос владельца");
    await vi.advanceTimersByTimeAsync(10);

    // Реплика агента (голос ответил)
    const voiceWs = FakeWs.all[0];
    voiceWs.fire("message", {
      data: JSON.stringify({
        serverContent: {
          outputTranscription: { text: "Ответ агента" },
          turnComplete: true,
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(10);

    // Проверяем: НИ ОДИН вызов advanceCallThread или sayCallThread НЕ был направлен в targetThreadId!
    expect(advancedThreads).not.toContain(targetThreadId);
    expect(saidThreads).not.toContain(targetThreadId);

    // Запись велась ТОЛЬКО в тред звонка thr_calls_dedicated_recording
    expect(advancedThreads.length).toBeGreaterThan(0);
    for (const id of advancedThreads) {
      expect(id).toBe("thr_calls_dedicated_recording");
    }
    expect(saidThreads.length).toBeGreaterThan(0);
    for (const id of saidThreads) {
      expect(id).toBe("thr_calls_dedicated_recording");
    }
  });
});

describe("звонок по треду без мозгового центра (§12.11 п.1, приёмка 03.11)", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("не-git тред → мозговой центр в проекте «Звонки»: голос ждёт сводку, изменения недоступны", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const { s } = makeThreadCall("thr_target_nogit", { id: "env_test", isGitRepo: false }, spawned);
    (s as unknown as { deps: { callsProjectId?: string } }).deps.callsProjectId = "proj_calls_test";
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].projectId).toBe("proj_calls_test");
    expect(s.brain?.canModify).toBe(false);
    const instr = JSON.parse(FakeWs.all[0].sent[0]).setup.systemInstruction.parts[0].text as string;
    expect(instr).toContain("обрабатываю информацию");
    await s.end("owner");
  });

  it("мозговой центр не запустился (ошибка spawn) → голос не ждёт сводку", async () => {
    const { s, store } = makeThreadCall("thr_target_fail");
    (s as unknown as { deps: { sdk: { threads: { spawn: unknown } } } }).deps.sdk.threads.spawn = async () => { throw new Error("spawn failed"); };
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.brain).toBeNull();
    expect(store.transcript("call_tc").some((e) => e.kind === "brain_failed")).toBe(true);
    const ws = FakeWs.all[0];
    ws.fire("message", { data: JSON.stringify({ setupComplete: {} }) });
    await vi.advanceTimersByTimeAsync(10);
    const greet = ws.sent.filter((x) => x.includes('"clientContent"')).join("\n");
    expect(greet).toContain("Мозговой центр недоступен");
    await s.end("owner");
  });
});

describe("мозговой центр: признак git берётся из окружения треда (приёмка 03.11)", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("тред в git-окружении → мозговой центр запускается в managed-worktree от ветки треда", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const { s } = makeThreadCall("thr_target_git", { id: "env_test", isGitRepo: true, branchName: "feat/x", hostId: "host_1" }, spawned);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(spawned).toHaveLength(1);
    const env = JSON.stringify(spawned[0].environment);
    expect(env).toContain("managed-worktree");
    expect(env).toContain("feat/x");
    expect(env).not.toContain("project-default");
    expect(s.brain?.canModify).toBe(true);
    const instr = JSON.parse(FakeWs.all[0].sent[0]).setup.systemInstruction.parts[0].text as string;
    expect(instr).toContain("обрабатываю информацию");
    await s.end("owner");
  });
});


describe("Extended отключён (ADR-0006, пересмотр 2)", () => {
  it("без allowExtended сессия не переходит в extended, switch_mode не объявлен", async () => {
    const { nativeDeclarations } = await import("../src/tools.js");
    expect(JSON.stringify(nativeDeclarations())).not.toContain('"switch_mode"');
    const { s } = makeThreadCall();
    await s.switchMode("extended", "tool");
    expect(s.mode).not.toBe("extended");
  });
});
