import { describe, expect, it, vi } from "vitest";
import { threadVoiceInstruction, OWNER_RULES_BLOCK, OWNER_RULES_CORRESPONDENCE } from "../src/prompt.js";
import { CallSession } from "../src/call-session.js";

const sampleCtx = {
  thread: { id: "thr_sample", title: "Тест правил владельца" },
  nowUtc: "2026-11-03T18:00:00Z",
  threadState: { status: "свободен" },
  messagesBlock: "[1] Владелец: тест",
  memory: [],
};

describe("Правила владельца в инструкции (§12.12)", () => {
  it("содержит дословный блок правил владельца", () => {
    const text = threadVoiceInstruction(sampleCtx);
    const expectedBlock = `Ты — голосовой ИИ-ассистент. Общайся естественно, лаконично и по делу, без списков и markdown-разметки.

Правила работы с инструментами (Tools):
1. Сначала вызови инструмент — и только потом одной короткой фразой скажи, что делаешь (инструменты неблокирующие и работают, пока ты говоришь). Запрещено говорить «секунду», «уточню», «проверю», «посмотрю», «подниму» и т. п., не вызвав инструмент в том же ходе.
2. Пока инструмент выполняется в фоне, поддерживай диалог, если пользователь что-то спрашивает, но не выдумывай результаты до получения ответа от функции.
3. Если инструмент вернул пустой результат (status: "no_results") или ошибку ("invalid_argument"), обязательно сообщи об этом пользователю и уточни данные. Запрещено молча перезапускать инструмент с угаданными параметрами.
4. Никогда не вызывай более двух инструментов подряд без голосовой обратной связи пользователю.`;

    expect(text).toContain(expectedBlock);
    expect(OWNER_RULES_BLOCK).toBe(expectedBlock);
  });

  it("содержит строку соответствия кодов сразу после блока", () => {
    const text = threadVoiceInstruction(sampleCtx);
    const expectedCorr = "У наших инструментов пустой результат — это ok:false с кодом not_found, ошибка — ok:false с ambiguous, timeout, not_delivered и другими кодами; для правила 3 это то же самое.";
    expect(text).toContain(expectedCorr);
    expect(OWNER_RULES_CORRESPONDENCE).toBe(expectedCorr);
  });

  it("сервер отклоняет повторный вызов того же инструмента после ok:false без реплики владельца", async () => {
    const responses: Array<{ id?: string; response: any; name?: string }> = [];
    const fakeClient = {
      sendToolResponse: vi.fn((id, resp, sched, name) => {
        responses.push({ id, response: resp, name });
      }),
      sendClientContent: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };

    const session = new CallSession({
      callId: "call_rules_1",
      keys: ["key-1", "key-2"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store: {
        startCall: () => {},
        endCall: () => {},
        event: () => {},
        setThread: () => {},
        setModeHistory: () => {},
        incKeySwitches: () => {},
        addMemory: () => {},
        listMemory: () => [],
      } as never,
      sdk: {
        threads: {
          get: async () => ({ status: "idle" }),
        },
      } as never,
      targetThreadId: "thr_target_rules",
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => "thr_call",
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
    });

    // 1) Первый вызов brain_ask с пустым вопросом -> ok: false
    await (session as any).handleNativeCalls(fakeClient, [
      { id: "call_1", name: "brain_ask", args: { question: "" } },
    ]);

    expect(fakeClient.sendToolResponse).toHaveBeenCalledTimes(1);
    const resp1 = responses[0].response;
    expect(resp1.ok).toBe(false);

    // 2) Повторный вызов того же инструмента в том же ходе (без реплики владельца) -> ошибка
    await (session as any).handleNativeCalls(fakeClient, [
      { id: "call_2", name: "brain_ask", args: { question: "что нового?" } },
    ]);

    expect(fakeClient.sendToolResponse).toHaveBeenCalledTimes(2);
    const resp2 = responses[1].response;
    expect(resp2.error).toBe("сначала сообщи владельцу");

    // 3) Владелец что-то сказал -> реплика сбрасывает блокировку
    session.sendUserMessage("попробуй спросить что нового");

    // 4) Теперь тот же инструмент разрешён снова
    await (session as any).handleNativeCalls(fakeClient, [
      { id: "call_3", name: "brain_ask", args: { question: "что нового?" } },
    ]);

    expect(fakeClient.sendToolResponse).toHaveBeenCalledTimes(3);
    const resp3 = responses[2].response;
    expect(resp3.error).not.toBe("сначала сообщи владельцу");
  });
});
