import { describe, expect, it, vi } from "vitest";
import {
  capabilityList,
  eventContainsText,
  getThreadTools,
  nativeDeclarations,
  readActionLabel,
  runToolCall,
  toolByName,
  verifyThreadDelivery,
} from "../src/tools.js";
import type { ThreadMessage } from "../src/thread-messages.js";

describe("инструменты звонка по треду (контракт §12.4)", () => {
  it("в звонке по треду объявлены только 6 инструментов (§12.10, без switch_mode)", () => {
    const decls = nativeDeclarations("thr_target") as Array<{ functionDeclarations: Array<{ name: string }> }>;
    const names = decls.flatMap((d) => d.functionDeclarations.map((f) => f.name));
    expect(names.sort()).toEqual([
      "end_call",
      "recall",
      "remember",
      "thread_answer",
      "thread_read_messages",
      "thread_send",
    ].sort());

    // Общие инструменты отсутствуют
    expect(names).not.toContain("start_thread");
    expect(names).not.toContain("list_threads");
    expect(names).not.toContain("read_thread");
    expect(names).not.toContain("search_memory");
    expect(names).not.toContain("bb_overview");
  });

  it("toolByName в звонке по треду не находит инструменты общего звонка", () => {
    expect(toolByName("thread_send", "thr_target")).toBeDefined();
    expect(toolByName("thread_read_messages", "thr_target")).toBeDefined();
    expect(toolByName("thread_answer", "thr_target")).toBeDefined();
    expect(toolByName("start_thread", "thr_target")).toBeUndefined();
    expect(toolByName("read_thread", "thr_target")).toBeUndefined();
  });

  it("capabilityList для звонка по треду не содержит launch-инструментов", () => {
    const caps = capabilityList("thr_target");
    expect(caps.launch).toHaveLength(0);
    expect(caps.read).toContain("прочитать сообщения треда");
    expect(caps.confirm).toContain("написать в этот тред");
  });

  describe("thread_read_messages (класс R)", () => {
    const sampleMessages: ThreadMessage[] = Array.from({ length: 25 }, (_, i) => ({
      number: i + 1,
      role: i % 2 === 0 ? "owner" : "agent",
      text: i === 4 ? "Важная подстрока для поиска" : `Сообщение ${i + 1}`,
      createdAt: 1700000000000 + i * 1000,
    }));

    it("читает сообщения по from..to (не более 10 за вызов)", async () => {
      const tool = toolByName("thread_read_messages", "thr_target")!;
      expect(tool.cls).toBe("R");

      const ctx = {
        targetThreadId: "thr_target",
        threadMessages: sampleMessages,
        reportAction: vi.fn(),
      };

      const res = (await tool.execute({ from: 5, to: 12 }, ctx as never)) as {
        ok: true;
        data: { messages: Array<{ number: number; text: string }> };
      };
      expect(res.ok).toBe(true);
      expect(res.data.messages).toHaveLength(8);
      expect(res.data.messages[0].number).toBe(5);
      expect(res.data.messages[7].number).toBe(12);

      // Ограничение максимум 10 за вызов
      const resLimit = (await tool.execute({ from: 1, to: 20 }, ctx as never)) as {
        ok: true;
        data: { messages: Array<{ number: number }> };
      };
      expect(resLimit.data.messages).toHaveLength(10);
      expect(resLimit.data.messages[0].number).toBe(1);
      expect(resLimit.data.messages[9].number).toBe(10);
    });

    it("ищет сообщения по подстроке query (до 5 совпадений)", async () => {
      const tool = toolByName("thread_read_messages", "thr_target")!;
      const ctx = {
        targetThreadId: "thr_target",
        threadMessages: sampleMessages,
        reportAction: vi.fn(),
      };

      const res = (await tool.execute({ query: "важная подстрока" }, ctx as never)) as {
        ok: true;
        data: { messages: Array<{ number: number; text: string }> };
      };
      expect(res.ok).toBe(true);
      expect(res.data.messages).toHaveLength(1);
      expect(res.data.messages[0].number).toBe(5);
      expect(res.data.messages[0].text).toContain("Важная подстрока для поиска");
    });

    it("readActionLabel генерирует человеческую подпись", () => {
      const label = readActionLabel("thread_read_messages", {});
      expect(label?.running).toBe("Читаю сообщения треда");
      expect(label?.done).toBe("Прочитал сообщения треда");
    });

    it("§12.10 п. 4: справка, а не приказ — результат thread_read_messages возвращается с номерами и временем сообщений", async () => {
      const tool = toolByName("thread_read_messages", "thr_target")!;
      const longThreadMessages: ThreadMessage[] = Array.from({ length: 264 }, (_, i) => ({
        number: i + 1,
        role: i % 2 === 0 ? "owner" : "agent",
        text: `Сообщение ${i + 1}`,
        createdAt: 1700000000000 + i * 1000,
      }));

      const ctx = {
        targetThreadId: "thr_target",
        threadMessages: longThreadMessages,
        reportAction: vi.fn(),
      };

      // 1. Запрос 1..5 — возвращает сообщения с номерами, временем и текстом
      const res1to5 = (await tool.execute({ from: 1, to: 5 }, ctx as never)) as {
        ok: true;
        data: { from: number; to: number; count: number; messages: Array<{ number: number; text: string; time: string; role: string }> };
      };
      expect(res1to5.ok).toBe(true);
      expect(res1to5.data.count).toBe(5);
      expect(res1to5.data.from).toBe(1);
      expect(res1to5.data.to).toBe(5);
      expect(res1to5.data.messages).toHaveLength(5);
      expect(res1to5.data.messages[0].number).toBe(1);
      expect(res1to5.data.messages[0].text).toBe("Сообщение 1");
      expect(res1to5.data.messages[0].time).toBeTruthy();

      // 2. Запрос 250..259 — возвращает сообщения
      const resLast = (await tool.execute({ from: 250, to: 259 }, ctx as never)) as {
        ok: true;
        data: { from: number; to: number; count: number; messages: Array<{ number: number; text: string }> };
      };
      expect(resLast.ok).toBe(true);
      expect(resLast.data.count).toBe(10);
      expect(resLast.data.messages[0].number).toBe(250);
      expect(resLast.data.messages[9].number).toBe(259);
    });
  });

  describe("thread_send (класс C, после «да»)", () => {
    it("класс C, слово «да», confirmSay повторяет текст, отправка с префиксом [голос] при подтверждении доставки", async () => {
      const tool = toolByName("thread_send", "thr_target")!;
      expect(tool.cls).toBe("C");
      expect(tool.word).toBe("да");
      expect(tool.confirmSay?.({ text: "проверка связи" })).toContain("«проверка связи»");

      let sentPayload: unknown = null;
      const fakeSdk = {
        threads: {
          send: async (payload: unknown) => {
            sentPayload = payload;
            return { ok: true };
          },
          events: {
            list: async () => ({
              items: [
                {
                  type: "client/turn/requested",
                  createdAt: Date.now(),
                  data: { input: [{ text: "[голос] Привет из теста" }] },
                },
              ],
            }),
          },
        },
      };

      const ledger = { add: vi.fn() };
      const reportAction = vi.fn();
      const ctx = {
        sdk: fakeSdk,
        targetThreadId: "thr_target",
        ledger,
        reportAction,
        deliveryTimeoutMs: 100,
        deliveryIntervalMs: 10,
      };

      const res = (await tool.execute({ text: "Привет из теста" }, ctx as never)) as { ok: true; data: { sent: boolean } };
      expect(res.ok).toBe(true);
      expect(res.data.sent).toBe(true);
      expect(sentPayload).toEqual({
        threadId: "thr_target",
        mode: "auto",
        input: [{ type: "text", text: "[голос] Привет из теста", mentions: [] }],
      });
      expect(reportAction).toHaveBeenCalledWith(
        "thread_send",
        "C",
        "done",
        expect.stringContaining("Привет из теста"),
        "thr_target",
      );
    });

    it("при отсутствии доставки возвращает ok: false и ошибку «не доставлено»", async () => {
      const tool = toolByName("thread_send", "thr_target")!;
      const fakeSdk = {
        threads: {
          send: async () => ({ ok: true }),
          events: {
            list: async () => ({ items: [] }),
          },
          queuedMessages: {
            list: async () => ({ items: [] }),
          },
        },
      };

      const ledger = { add: vi.fn() };
      const reportAction = vi.fn();
      const ctx = {
        sdk: fakeSdk,
        targetThreadId: "thr_target",
        ledger,
        reportAction,
        deliveryTimeoutMs: 50,
        deliveryIntervalMs: 10,
      };

      const res = (await tool.execute({ text: "Привет" }, ctx as never)) as {
        ok: false;
        error: { code: string; message: string };
      };
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("delivery_failed");
      expect(res.error.message).toBe("не доставлено");
      expect(reportAction).toHaveBeenCalledWith("thread_send", "C", "failed", "не доставлено", "thr_target");
    });
  });

  describe("thread_answer (C «да» / P «разрешаю» при grant: true)", () => {
    it("ответ на вопрос: класс C, слово «да»", async () => {
      const tool = toolByName("thread_answer", "thr_target")!;
      expect(tool.cls).toBe("C");
      expect(tool.confirmSay?.({ answer: "используй sqlite" })).toContain("«используй sqlite»");

      let respondedPayload: unknown = null;
      const fakeSdk = {
        threads: {
          interactions: {
            list: async () => [{ id: "int_1", kind: "question" }],
            respond: async (p: unknown) => {
              respondedPayload = p;
            },
          },
        },
      };

      const ledger = { add: vi.fn() };
      const reportAction = vi.fn();
      const ctx = {
        sdk: fakeSdk,
        targetThreadId: "thr_target",
        ledger,
        reportAction,
      };

      const res = (await tool.execute({ answer: "используй sqlite" }, ctx as never)) as { ok: true };
      expect(res.ok).toBe(true);
      expect(respondedPayload).toEqual({
        interactionId: "int_1",
        threadId: "thr_target",
        value: { kind: "user_answer", answers: { default: { freeText: "используй sqlite" } } },
      });
      expect(reportAction).toHaveBeenCalledWith("thread_answer", "C", "done", "Ответил агенту", "thr_target");
    });

    it("разрешение действия: grant=true классифицируется как P («разрешаю»)", async () => {
      const tool = toolByName("thread_answer", "thr_target")!;
      expect(tool.confirmSay?.({ grant: true })).toContain("«разрешаю»");

      let resolvedPayload: unknown = null;
      const fakeSdk = {
        threads: {
          interactions: {
            list: async () => [{ id: "int_2", kind: "permission", payload: { grantedPermissions: { fileSystem: { write: true } } } }],
            resolve: async (p: unknown) => {
              resolvedPayload = p;
            },
          },
        },
      };

      const ledger = { add: vi.fn() };
      const reportAction = vi.fn();
      const gate = {
        request: vi.fn((name, args, cls) => ({ pending: { confirmationId: "c1", argsHash: "h", verdict: "pending" } })),
      };
      const ctx = {
        sdk: fakeSdk,
        gate,
        targetThreadId: "thr_target",
        ledger,
        reportAction,
      };

      // runToolCall с grant: true передает класс P в gate.request
      await runToolCall(tool, { grant: true }, "call_1", ctx as never);
      expect(gate.request).toHaveBeenCalledWith("thread_answer", { grant: true }, "P", expect.any(String));

      // При исполнении вызывает resolve
      const res = (await tool.execute({ grant: true }, ctx as never)) as { ok: true };
      expect(res.ok).toBe(true);
      expect(resolvedPayload).toEqual({
        interactionId: "int_2",
        threadId: "thr_target",
        resolution: { kind: "approval", decision: "allow_once", grantedPermissions: { fileSystem: { write: true } } },
      });
      expect(reportAction).toHaveBeenCalledWith("thread_answer", "P", "done", "Разрешил агенту", "thr_target");
    });
  });

  describe("send_to_thread (проверка доставки)", () => {
    it("успешная доставка через client/turn/requested", async () => {
      const tool = toolByName("send_to_thread")!;
      expect(tool).toBeDefined();

      const fakeSdk = {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, title: "Тестовый тред" }),
          list: async () => ({ items: [{ id: "thr_test", title: "Тестовый тред" }] }),
          send: async () => ({ ok: true }),
          events: {
            list: async () => ({
              items: [
                {
                  type: "client/turn/requested",
                  createdAt: Date.now(),
                  data: { input: [{ text: "[голос] сообщение для треда" }] },
                },
              ],
            }),
          },
        },
      };

      const ledger = { add: vi.fn() };
      const reportAction = vi.fn();
      const ctx = {
        sdk: fakeSdk,
        ledger,
        reportAction,
        deliveryTimeoutMs: 100,
        deliveryIntervalMs: 10,
      };

      const res = (await tool.execute({ thread: "thr_test", text: "сообщение для треда" }, ctx as never)) as {
        ok: true;
        data: { sent: boolean; threadId: string };
      };
      expect(res.ok).toBe(true);
      expect(res.data.sent).toBe(true);
      expect(res.data.threadId).toBe("thr_test");
      expect(reportAction).toHaveBeenCalledWith("send_to_thread", "C", "done", expect.any(String), "thr_test");
    });

    it("неуспешная доставка (таймаут) возвращает ok: false и ошибку «не доставлено»", async () => {
      const tool = toolByName("send_to_thread")!;
      const fakeSdk = {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, title: "Тестовый тред" }),
          list: async () => ({ items: [{ id: "thr_test", title: "Тестовый тред" }] }),
          send: async () => ({ ok: true }),
          events: {
            list: async () => ({ items: [] }),
          },
          queuedMessages: {
            list: async () => ({ items: [] }),
          },
        },
      };

      const ledger = { add: vi.fn() };
      const reportAction = vi.fn();
      const ctx = {
        sdk: fakeSdk,
        ledger,
        reportAction,
        deliveryTimeoutMs: 50,
        deliveryIntervalMs: 10,
      };

      const res = (await tool.execute({ thread: "thr_test", text: "сообщение для треда" }, ctx as never)) as {
        ok: false;
        error: { code: string; message: string };
      };
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("delivery_failed");
      expect(res.error.message).toBe("не доставлено");
      expect(reportAction).toHaveBeenCalledWith("send_to_thread", "C", "failed", "не доставлено", "thr_test");
    });
  });

  describe("verifyThreadDelivery", () => {
    it("находит доставку по очереди queuedMessages", async () => {
      const fakeSdk = {
        threads: {
          events: {
            list: async () => ({ items: [] }),
          },
          queuedMessages: {
            list: async () => ({
              items: [
                {
                  id: "qm_1",
                  state: "waiting",
                  input: [{ text: "[голос] отложенный вопрос" }],
                },
              ],
            }),
          },
        },
      };

      const ok = await verifyThreadDelivery(
        fakeSdk as never,
        "thr_q",
        "отложенный вопрос",
        Date.now() - 500,
        100,
        10,
      );
      expect(ok).toBe(true);
    });

    it("находит доставку по очереди queue.list", async () => {
      const fakeSdk = {
        threads: {
          events: {
            list: async () => ({ items: [] }),
          },
          queue: {
            list: async () => [
              {
                id: "q_2",
                text: "[голос] сообщение в обычной очереди",
              },
            ],
          },
        },
      };

      const ok = await verifyThreadDelivery(
        fakeSdk as never,
        "thr_q",
        "сообщение в обычной очереди",
        Date.now() - 500,
        100,
        10,
      );
      expect(ok).toBe(true);
    });

    it("возвращает false при истечении времени ожидания", async () => {
      const fakeSdk = {
        threads: {
          events: {
            list: async () => ({ items: [] }),
          },
          queuedMessages: {
            list: async () => ({ items: [] }),
          },
        },
      };

      const ok = await verifyThreadDelivery(
        fakeSdk as never,
        "thr_q",
        "несуществующий текст",
        Date.now(),
        50,
        10,
      );
      expect(ok).toBe(false);
    });

    it("находит доставку по steer в provider/unhandled (событие 14:19:32 в thr_testshort1)", async () => {
      const fakeSdk = {
        threads: {
          events: {
            list: async () => ({
              items: [
                {
                  id: "evt_rhiuc69k6k",
                  seq: 33,
                  createdAt: Date.now(),
                  type: "provider/unhandled",
                  data: {
                    providerThreadId: "pi_e152169b",
                    providerId: "pi",
                    rawType: "sdk/unknown",
                    rawEvent: {
                      jsonrpc: "2.0",
                      method: "sdk/message",
                      params: {
                        message: {
                          type: "queue_update",
                          steering: ["[голос] проверка связи"],
                          followUp: [],
                        },
                        threadId: "thr_testshort1",
                      },
                    },
                  },
                },
              ],
            }),
          },
        },
      };

      const ok = await verifyThreadDelivery(
        fakeSdk as never,
        "thr_testshort1",
        "проверка связи",
        Date.now() - 500,
        100,
        10,
      );
      expect(ok).toBe(true);
    });
  });

  describe("eventContainsText (поиск по ВСЕМ типам событий)", () => {
    it("находит текст в input client/turn/requested", () => {
      const e = {
        type: "client/turn/requested",
        data: { input: [{ text: "[голос] тест" }] },
      };
      expect(eventContainsText(e, "тест")).toBe(true);
      expect(eventContainsText(e, "другое")).toBe(false);
    });

    it("находит текст в steer provider/unhandled", () => {
      const e = {
        type: "provider/unhandled",
        data: {
          rawEvent: {
            params: {
              message: {
                steering: ["[голос] срочная задача"],
              },
            },
          },
        },
      };
      expect(eventContainsText(e, "срочная задача")).toBe(true);
      expect(eventContainsText(e, "другое")).toBe(false);
    });

    it("находит текст в произвольных полях text/message", () => {
      expect(eventContainsText({ data: { text: "прямой текст" } }, "прямой текст")).toBe(true);
      expect(eventContainsText({ data: { message: "произвольное сообщение" } }, "сообщение")).toBe(true);
    });
  });
});
