import { describe, expect, it } from "vitest";
import {
  fetchThreadMessages,
  formatMessageTime,
  formatThreadMessagesBlock,
  type ThreadMessage,
} from "../src/thread-messages.js";

describe("сбор сообщений треда (контракт §12.2)", () => {
  it("фильтрует только реплики владельца и агента, игнорирует toolCall и пустые сообщения", async () => {
    const rawEvents = [
      { id: "e1", seq: 1, type: "client/turn/requested", createdAt: 1000, data: { input: [{ text: "Привет агент" }] } },
      { id: "e2", seq: 2, type: "turn/started", createdAt: 1005 },
      { id: "e3", seq: 3, type: "item/started", createdAt: 1010 },
      { id: "e4", seq: 4, type: "item/completed", createdAt: 1020, data: { item: { type: "toolCall", tool: "bash" } } },
      { id: "e5", seq: 5, type: "item/completed", createdAt: 1030, data: { item: { type: "agentMessage", text: "Здравствуйте! Чем помочь?" } } },
      { id: "e6", seq: 6, type: "client/turn/requested", createdAt: 1040, data: { input: [{ text: "   " }] } }, // пустое
      { id: "e7", seq: 7, type: "item/completed", createdAt: 1050, data: { item: { type: "agentMessage", text: "" } } }, // пустое
      { id: "e8", seq: 8, type: "client/turn/requested", createdAt: 1060, data: { input: [{ text: "Посчитай сумму" }] } },
      { id: "e9", seq: 9, type: "item/completed", createdAt: 1070, data: { item: { type: "agentMessage", text: "Сумма равна 42." } } },
    ];

    const fakeSdk = {
      threads: {
        events: {
          list: async () => rawEvents,
        },
      },
    };

    const msgs = await fetchThreadMessages(fakeSdk as never, "thr_test");
    expect(msgs).toHaveLength(4);
    expect(msgs.map((m) => m.number)).toEqual([1, 2, 3, 4]);
    expect(msgs[0]).toEqual({
      number: 1,
      role: "owner",
      text: "Привет агент",
      createdAt: 1000,
    });
    expect(msgs[1]).toEqual({
      number: 2,
      role: "agent",
      text: "Здравствуйте! Чем помочь?",
      createdAt: 1030,
    });
    expect(msgs[2]).toEqual({
      number: 3,
      role: "owner",
      text: "Посчитай сумму",
      createdAt: 1060,
    });
    expect(msgs[3]).toEqual({
      number: 4,
      role: "agent",
      text: "Сумма равна 42.",
      createdAt: 1070,
    });
  });

  it("сообщения не обрезаются независимо от длины", async () => {
    const longOwnerText = ("Владелец: " + "очень длинный текст запроса ".repeat(100)).trim();
    const longAgentText = ("Агент: " + "очень подробный ответ со всеми деталями ".repeat(200)).trim();

    const fakeSdk = {
      threads: {
        events: {
          list: async () => [
            { id: "e1", seq: 1, type: "client/turn/requested", createdAt: 1000, data: { input: [{ text: longOwnerText }] } },
            { id: "e2", seq: 2, type: "item/completed", createdAt: 2000, data: { item: { type: "agentMessage", text: longAgentText } } },
          ],
        },
      },
    };

    const msgs = await fetchThreadMessages(fakeSdk as never, "thr_test");
    expect(msgs[0].text).toBe(longOwnerText);
    expect(msgs[1].text).toBe(longAgentText);
  });

  it("постраничный обход событий SDK", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `e_${i + 1}`,
      seq: i + 1,
      type: "client/turn/requested",
      createdAt: 1000 + i,
      data: { input: [{ text: `Запрос ${i + 1}` }] },
    }));
    const page2 = [
      { id: "e_101", seq: 101, type: "item/completed", createdAt: 2000, data: { item: { type: "agentMessage", text: "Финальный ответ" } } },
    ];

    const calls: Array<Record<string, unknown>> = [];
    const fakeSdk = {
      threads: {
        events: {
          list: async (args: Record<string, unknown>) => {
            calls.push(args);
            if (!args.afterSeq) return page1;
            if (args.afterSeq === "100") return page2;
            return [];
          },
        },
      },
    };

    const msgs = await fetchThreadMessages(fakeSdk as never, "thr_page");
    expect(calls).toHaveLength(2);
    expect(calls[0].afterSeq).toBeUndefined();
    expect(calls[1].afterSeq).toBe("100");
    expect(msgs).toHaveLength(101);
    expect(msgs[100].text).toBe("Финальный ответ");
  });

  describe("форматирование блока сообщений (выборка 10+20 и пропуск)", () => {
    it("до 30 сообщений включительно: все сообщения выводятся без пропуска", () => {
      const messages: ThreadMessage[] = Array.from({ length: 25 }, (_, i) => ({
        number: i + 1,
        role: i % 2 === 0 ? "owner" : "agent",
        text: `Сообщение ${i + 1}`,
        createdAt: 1700000000000 + i * 60000,
      }));

      const res = formatThreadMessagesBlock(messages);
      expect(res.messagesCount).toBe(25);
      expect(res.skippedCount).toBe(0);
      expect(res.block).not.toContain("пропущено");
      expect(res.block).toContain("[1] Владелец");
      expect(res.block).toContain("[25] Владелец");
    });

    it("больше 30 сообщений: первые 10 + строка пропуска + последние 20", () => {
      const messages: ThreadMessage[] = Array.from({ length: 47 }, (_, i) => ({
        number: i + 1,
        role: i % 2 === 0 ? "owner" : "agent",
        text: `Текст сообщения ${i + 1}`,
        createdAt: 1700000000000 + i * 60000,
      }));

      const res = formatThreadMessagesBlock(messages);
      expect(res.messagesCount).toBe(30);
      expect(res.skippedCount).toBe(17);
      expect(res.block).toContain("… пропущено 17 сообщений (дочитай инструментом) …");

      // Первые 10
      expect(res.block).toContain("[1] Владелец");
      expect(res.block).toContain("[10] Агент");
      // Пропущенные сообщения не должны быть в блоке
      expect(res.block).not.toContain("[11] Владелец");
      expect(res.block).not.toContain("[27] Владелец");
      // Последние 20: с 28 по 47
      expect(res.block).toContain("[28] Агент");
      expect(res.block).toContain("[47] Владелец");
    });
  });
});
