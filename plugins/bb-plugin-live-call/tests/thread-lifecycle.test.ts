import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { CallStore } from "../src/call-store.js";
import {
  createCallThreadManager,
  closeStaleCallThreads,
  type SockLike,
} from "../src/thread-lifecycle.js";
import { CallSession } from "../src/call-session.js";

describe("жизненный цикл треда звонка (контракт §13)", () => {
  function createTestDb() {
    return new Database(":memory:");
  }

  describe("§13.1 — закрытие хода треда звонка при любом конце звонка", () => {
    it("при наличии сокета моста отправляет say и end и дожидается закрытия хода", async () => {
      const db = createTestDb();
      const store = new CallStore(db);
      const sentFrames: string[] = [];
      const mockSock: SockLike = {
        send: vi.fn((data: string) => sentFrames.push(data)),
      };

      const bridgeOwner = new Map<string, SockLike>([["thr_call_1", mockSock]]);
      const turnClosedWaiters = new Map<string, () => void>();

      const mockSdk = {
        threads: {
          get: vi.fn(async () => ({ thread: { id: "thr_call_1", status: "idle" } })),
          stop: vi.fn(async () => ({ ok: true })),
          send: vi.fn(async () => ({ ok: true })),
        },
      };

      const manager = createCallThreadManager({
        sdk: mockSdk as never,
        store,
        bridgeOwner,
        turnClosedWaiters,
      });

      // Имитируем приход turn_closed через таймер
      setTimeout(() => {
        turnClosedWaiters.get("thr_call_1")?.();
      }, 50);

      await manager.endCallThread("thr_call_1", "Звонок завершён, 2 мин.", "call_1");

      expect(mockSock.send).toHaveBeenCalledTimes(2);
      expect(sentFrames[0]).toContain('"type":"say"');
      expect(sentFrames[0]).toContain("Звонок завершён");
      expect(sentFrames[1]).toContain('"type":"end"');
      // Поскольку статус стал idle, threads.stop не вызывается
      expect(mockSdk.threads.stop).not.toHaveBeenCalled();
    });

    it("при отсутствии сокета моста вызывает bb.sdk.threads.stop как запасной путь", async () => {
      const db = createTestDb();
      const store = new CallStore(db);
      const bridgeOwner = new Map<string, SockLike>(); // моста нет
      const turnClosedWaiters = new Map<string, () => void>();

      let stopped = false;
      const mockSdk = {
        threads: {
          get: vi.fn(async () => ({ thread: { id: "thr_call_2", status: stopped ? "idle" : "active" } })),
          stop: vi.fn(async () => {
            stopped = true;
            return { ok: true };
          }),
          send: vi.fn(async () => ({ ok: true })),
        },
      };

      const manager = createCallThreadManager({
        sdk: mockSdk as never,
        store,
        bridgeOwner,
        turnClosedWaiters,
      });

      await manager.endCallThread("thr_call_2", "Звонок завершён", "call_2");

      expect(mockSdk.threads.stop).toHaveBeenCalledWith({ threadId: "thr_call_2" });
    });

    it("если закрытие упало, ошибка пишется в журнал звонка (thread_close_failed)", async () => {
      const db = createTestDb();
      const store = new CallStore(db);
      store.startCall("call_fail", 1000, "normal");
      const bridgeOwner = new Map<string, SockLike>();
      const turnClosedWaiters = new Map<string, () => void>();

      const mockSdk = {
        threads: {
          get: vi.fn(async () => {
            throw new Error("network error get");
          }),
          stop: vi.fn(async () => {
            throw new Error("daemon stop failure");
          }),
          send: vi.fn(async () => ({ ok: true })),
        },
      };

      const manager = createCallThreadManager({
        sdk: mockSdk as never,
        store,
        bridgeOwner,
        turnClosedWaiters,
      });

      await expect(manager.endCallThread("thr_fail", "Итог", "call_fail")).rejects.toThrow("daemon stop failure");

      const events = store.transcript("call_fail");
      const failedEvt = events.find((e) => e.kind === "thread_close_failed");
      expect(failedEvt).toBeDefined();
      expect(failedEvt?.payload).toContain("daemon stop failure");
      expect(failedEvt?.payload).toContain("thr_fail");
    });

    it("CallSession.end вызывает endCallThread и при сбое логирует thread_close_failed без падения", async () => {
      const db = createTestDb();
      const store = new CallStore(db);
      store.startCall("call_sess", 1000, "normal");

      const endCallThreadMock = vi.fn(async () => {
        throw new Error("failed to close thread");
      });

      const session = new CallSession({
        callId: "call_sess",
        mode: "normal",
        keys: ["key1"],
        store,
        toBrowser: vi.fn(),
        endCallThread: endCallThreadMock,
        advanceCallThread: vi.fn(),
        sayCallThread: vi.fn(),
        spawnCallThread: vi.fn(),
        openGeminiSession: vi.fn(),
      } as never);

      // Имитируем созданный тред звонка
      (session as unknown as { threadId: string }).threadId = "thr_call_test";

      await session.end("owner");

      expect(endCallThreadMock).toHaveBeenCalledWith(expect.stringContaining("по просьбе владельца"));
      const events = store.transcript("call_sess");
      const failEvt = events.find((e) => e.kind === "thread_close_failed");
      expect(failEvt).toBeDefined();
      expect(failEvt?.payload).toContain("failed to close thread");
    });
  });

  describe("§13.2 — closeStale закрывает ходы тредов в BB при active или starting", () => {
    it("закрывает звонки в SQLite и вызывает threads.stop для active/starting тредов", async () => {
      const db = createTestDb();
      const store = new CallStore(db);
      store.startCall("c1", 1000, "normal");
      store.setThread("c1", "thr_active_1");
      store.startCall("c2", 2000, "normal");
      store.setThread("c2", "thr_starting_2");
      store.startCall("c3", 3000, "normal");
      store.setThread("c3", "thr_idle_3");

      const stopped: string[] = [];
      const mockSdk = {
        threads: {
          get: vi.fn(async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr_active_1") return { thread: { status: "active" } };
            if (threadId === "thr_starting_2") return { thread: { status: "starting" } };
            return { thread: { status: "idle" } };
          }),
          stop: vi.fn(async ({ threadId }: { threadId: string }) => {
            stopped.push(threadId);
            return { ok: true };
          }),
        },
      };

      const result = await closeStaleCallThreads(store, mockSdk as never);

      expect(result.sort()).toEqual(["thr_active_1", "thr_starting_2"].sort());
      expect(stopped.sort()).toEqual(["thr_active_1", "thr_starting_2"].sort());

      // Повторный вызов closeStale ничего не возвращает, так как звонки закрыты
      const secondCall = store.closeStale();
      expect(secondCall).toHaveLength(0);
    });

    it("останавливает зависшие active/starting треды в проекте Звонки", async () => {
      const db = createTestDb();
      const store = new CallStore(db);

      const stopped: string[] = [];
      const mockSdk = {
        threads: {
          get: vi.fn(async () => ({ thread: { status: "idle" } })),
          list: vi.fn(async () => [
            { id: "thr_orphan_1", status: "active" },
            { id: "thr_orphan_2", status: "starting" },
            { id: "thr_normal_3", status: "idle" },
          ]),
          stop: vi.fn(async ({ threadId }: { threadId: string }) => {
            stopped.push(threadId);
            return { ok: true };
          }),
        },
      };

      const result = await closeStaleCallThreads(store, mockSdk as never, "proj_calls");

      expect(result.sort()).toEqual(["thr_orphan_1", "thr_orphan_2"].sort());
      expect(stopped.sort()).toEqual(["thr_orphan_1", "thr_orphan_2"].sort());
    });
  });

  describe("§13.3 — advanceCallThread и sayCallThread не бросают исключений, 409 очередится", () => {
    it("sayCallThread не бросает исключений при ошибке сокета", async () => {
      const db = createTestDb();
      const store = new CallStore(db);
      const mockSock: SockLike = {
        send: vi.fn(() => {
          throw new Error("Broken pipe");
        }),
      };
      const bridgeOwner = new Map<string, SockLike>([["thr_1", mockSock]]);

      const manager = createCallThreadManager({
        sdk: {} as never,
        store,
        bridgeOwner,
        turnClosedWaiters: new Map(),
      });

      await expect(manager.sayCallThread("thr_1", "Тестовая реплика")).resolves.not.toThrow();
    });

    it("advanceCallThread перехватывает 409 Thread is already active, ставит в очередь и отправляет после turn_closed", async () => {
      const db = createTestDb();
      const store = new CallStore(db);
      const bridgeOwner = new Map<string, SockLike>();
      const turnClosedWaiters = new Map<string, () => void>();

      let sendAttempts = 0;
      const sentInputs: unknown[] = [];
      const mockSdk = {
        threads: {
          send: vi.fn(async (payload: unknown) => {
            sendAttempts++;
            if (sendAttempts === 1) {
              const err = new Error("HTTP 409 Thread is already active");
              (err as unknown as { status: number }).status = 409;
              throw err;
            }
            sentInputs.push(payload);
            return { ok: true };
          }),
        },
      };

      const manager = createCallThreadManager({
        sdk: mockSdk as never,
        store,
        bridgeOwner,
        turnClosedWaiters,
      });

      // Первый вызов получает 409, не бросает исключение наружу
      await expect(manager.advanceCallThread("thr_active", "Первая отложенная реплика")).resolves.not.toThrow();
      expect(sendAttempts).toBe(1);
      expect(manager.getQueue("thr_active")).toEqual(["Первая отложенная реплика"]);

      // Завершается ход (имитируем вызов processAdvanceQueue по turn_closed)
      await manager.processAdvanceQueue("thr_active");

      expect(sendAttempts).toBe(2);
      expect(sentInputs).toHaveLength(1);
      expect(sentInputs[0]).toEqual({
        threadId: "thr_active",
        mode: "start",
        input: [{ type: "text", text: "Первая отложенная реплика", mentions: [] }],
      });
      // Очередь очистилась после успешной отправки
      expect(manager.getQueue("thr_active")).toHaveLength(0);
    });

    it("endCallThread очищает advanceQueues и предотвращает отправку отложенных 409 реплик после конца звонка", async () => {
      const db = createTestDb();
      const store = new CallStore(db);
      const bridgeOwner = new Map<string, SockLike>();
      const turnClosedWaiters = new Map<string, () => void>();

      let sendAttempts = 0;
      let threadStopped = false;
      const mockSdk = {
        threads: {
          get: vi.fn(async () => ({ thread: { status: threadStopped ? "idle" : "active" } })),
          stop: vi.fn(async () => {
            threadStopped = true;
            return { ok: true };
          }),
          send: vi.fn(async () => {
            sendAttempts++;
            const err = new Error("HTTP 409 Thread is already active");
            (err as unknown as { status: number }).status = 409;
            throw err;
          }),
        },
      };

      const manager = createCallThreadManager({
        sdk: mockSdk as never,
        store,
        bridgeOwner,
        turnClosedWaiters,
      });

      // Реплика получает 409 и встаёт в очередь
      await manager.advanceCallThread("thr_queue_end", "Отложенная реплика 409");
      expect(manager.getQueue("thr_queue_end")).toHaveLength(1);

      // Завершаем звонок
      await manager.endCallThread("thr_queue_end", "Звонок завершён", "call_q");

      // Очередь должна быть очищена
      expect(manager.getQueue("thr_queue_end")).toHaveLength(0);

      // Попытка вызвать processAdvanceQueue (например, по сработавшему таймеру 1500ms) не шлёт send
      const sendCountBefore = sendAttempts;
      await manager.processAdvanceQueue("thr_queue_end");
      expect(sendAttempts).toBe(sendCountBefore);

      // Новые реплики в завершённый тред игнорируются
      await manager.advanceCallThread("thr_queue_end", "Ещё реплика после конца");
      expect(manager.getQueue("thr_queue_end")).toHaveLength(0);
      expect(sendAttempts).toBe(sendCountBefore);
    });
  });
});
