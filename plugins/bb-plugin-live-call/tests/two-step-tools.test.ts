/**
 * Тесты двухшаговых ручек коннектора (§14.10, PLUG-115).
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CallSession, makePreviewKey } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import { ConfirmationGate } from "../src/confirmation-gate.js";
import type { ServerFrame } from "../src/contract.js";
import { McpClient, extractConfirmToken } from "../src/mcp-client.js";
import {
  ProjectRegistryManager,
  canonicalizeJson,
  computeProjectDiff,
  connectorConfigSchema,
  hashProjectConfig,
} from "../src/project-registry.js";
import { DEFAULT_WORDS } from "../src/classify.js";
import { runToolCall, stripConfirmKeys, type ToolContext, type ToolDef } from "../src/tools.js";

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

describe("1. Реестр projectCalls: twoStep (§14.10 п. 1)", () => {
  const store = new CallStore(new Database(":memory:"));
  const mgr = new ProjectRegistryManager(store);

  it("класс R у двухшаговой — реестр invalid", () => {
    const invalidRegistry = JSON.stringify({
      proj_1: {
        title: "Test Project",
        connectors: [
          {
            id: "crm",
            transport: "stdio",
            command: ["/usr/bin/node", "/path/server.js"],
            tools: { issue_refund: "R" },
            defaultClass: "C",
            twoStep: ["issue_refund"],
          },
        ],
      },
    });
    const res = mgr.parseRegistry(invalidRegistry);
    expect(res.parsed).toBeNull();
    expect(res.error).toContain("не может иметь класс R");
    const list = mgr.listProjects(invalidRegistry);
    expect(list[0].state).toBe("invalid");
  });

  it("ручка из twoStep, которой нет в tools — реестр invalid", () => {
    const invalidRegistry = JSON.stringify({
      proj_1: {
        title: "Test Project",
        connectors: [
          {
            id: "crm",
            transport: "stdio",
            command: ["/usr/bin/node", "/path/server.js"],
            tools: { existing_tool: "C" },
            defaultClass: "deny",
            twoStep: ["missing_tool"],
          },
        ],
      },
    });
    const res = mgr.parseRegistry(invalidRegistry);
    expect(res.parsed).toBeNull();
    expect(res.error).toContain("отсутствует в tools");
    const list = mgr.listProjects(invalidRegistry);
    expect(list[0].state).toBe("invalid");
  });

  it("перед хешем нормализовать: сортировка и без повторов", () => {
    const cfgA = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/path/server.js"],
          tools: { op_b: "C" as const, op_a: "C" as const },
          defaultClass: "C" as const,
          twoStep: ["op_b", "op_a", "op_b"],
        },
      ],
    };
    const cfgB = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/path/server.js"],
          tools: { op_a: "C" as const, op_b: "C" as const },
          defaultClass: "C" as const,
          twoStep: ["op_a", "op_b"],
        },
      ],
    };
    expect(hashProjectConfig(cfgA)).toBe(hashProjectConfig(cfgB));
  });

  it("строка diff для twoStep: коннектор «<id>»: двухшаговые ручки [..] → [..]", () => {
    const oldConfig = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/path/server.js"],
          tools: { op_a: "C" as const, op_b: "C" as const },
          defaultClass: "C" as const,
          twoStep: ["op_a"],
        },
      ],
    };
    const newConfig = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/path/server.js"],
          tools: { op_a: "C" as const, op_b: "C" as const },
          defaultClass: "C" as const,
          twoStep: ["op_a", "op_b"],
        },
      ],
    };
    const diffs = computeProjectDiff(oldConfig, newConfig);
    expect(diffs).toContain("коннектор «crm»: двухшаговые ручки [op_a] → [op_a, op_b]");

    // Переход от [] к [op_a]
    const emptyTwoStepConfig = {
      ...oldConfig,
      connectors: [{ ...oldConfig.connectors[0], twoStep: [] }],
    };
    const diffs2 = computeProjectDiff(emptyTwoStepConfig, oldConfig);
    expect(diffs2).toContain("коннектор «crm»: двухшаговые ручки [] → [op_a]");
  });

  it("canonicalizeJson: общий, не ломает сложные объекты под ключом twoStep", () => {
    const objWithTwoStepArg = {
      twoStep: [{ key: "val", nested: 123 }],
      other: "value",
    };
    const canonical = canonicalizeJson(objWithTwoStepArg);
    expect(canonical).toEqual({
      other: "value",
      twoStep: [{ key: "val", nested: 123 }],
    });
  });

  it("diff строки «новый проект» и «добавлен коннектор» содержат двухшаговые ручки", () => {
    const newProjectConfig = {
      title: "New CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/path/server.js"],
          tools: { op_a: "C" as const, op_b: "C" as const },
          defaultClass: "C" as const,
          twoStep: ["op_b", "op_a"],
        },
      ],
    };
    const newProjDiff = computeProjectDiff(null, newProjectConfig);
    expect(newProjDiff[0]).toContain("двухшаговые ручки [op_a, op_b]");

    const baseConfig = {
      title: "CRM",
      connectors: [
        {
          id: "crm1",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/path/server.js"],
          tools: { op_a: "C" as const },
          defaultClass: "C" as const,
        },
      ],
    };
    const addedConnConfig = {
      title: "CRM",
      connectors: [
        baseConfig.connectors[0],
        {
          id: "crm2",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/path/server.js"],
          tools: { op_b: "C" as const },
          defaultClass: "C" as const,
          twoStep: ["op_b"],
        },
      ],
    };
    const addedDiff = computeProjectDiff(baseConfig, addedConnConfig);
    expect(addedDiff.some((d) => d.includes("добавлен коннектор «crm2»") && d.includes("двухшаговые ручки [op_b]"))).toBe(true);
  });
});

describe("2. Логика превью и подтверждения двухшаговых ручек (§14.10 п. 2–5)", () => {
  const gate = new ConfirmationGate(DEFAULT_WORDS);

  function makeMockContext(overrides: Partial<ToolContext> = {}): ToolContext {
    const previews = new Map<string, any>();
    return {
      gate,
      sdk: {} as never,
      ledger: { add: vi.fn() } as never,
      callsProjectId: () => null,
      reportAction: vi.fn(),
      savePreview: vi.fn((tool: string, token: string, args: Record<string, unknown>, previewText: string) => {
        const cleanArgs = stripConfirmKeys(args);
        previews.set(makePreviewKey(tool, token), {
          tool,
          token,
          args: cleanArgs,
          argsCanonical: JSON.stringify(canonicalizeJson(cleanArgs)),
          previewText,
          createdAt: Date.now(),
        });
      }),
      getPreview: vi.fn((tool: string, token: string) => previews.get(makePreviewKey(tool, token))),
      deletePreview: vi.fn((tool: string, token: string) => previews.delete(makePreviewKey(tool, token))),
      rememberArgs: vi.fn(),
      ...overrides,
    } as unknown as ToolContext;
  }

  function makeMockTool(opts: {
    executeMock?: (args: Record<string, unknown>) => Promise<any>;
    twoStep?: boolean;
    name?: string;
  } = {}): ToolDef {
    return {
      name: opts.name ?? "crm__issue_refund",
      cls: "C",
      word: "да",
      description: "Оформить возврат",
      twoStep: opts.twoStep ?? true,
      parameters: { type: "OBJECT", properties: { amount: { type: "NUMBER" } } },
      confirmSay: (args) => `issue_refund: amount=${args.amount}?`,
      confirmCard: (args) => `issue_refund\namount = ${args.amount}`,
      execute: opts.executeMock ?? vi.fn(async (args) => {
        const token = "mock_token_12345";
        return {
          ok: true,
          data: { result: `Превью возврата на сумму ${args.amount}. Токен: ${token}` },
          raw: {
            content: [{ type: "text", text: `Превью возврата на сумму ${args.amount}. Токен: ${token}` }],
            structuredContent: {
              confirm_token: token,
              amount: args.amount,
            },
          },
          rawText: `Превью возврата на сумму ${args.amount}. Токен: ${token}`,
        };
      }),
    };
  }

  it("превью без вопроса: вызывается как R, аргументы без confirm*, токен отдаётся модели", async () => {
    const ctx = makeMockContext();
    const executeMock = vi.fn(async (args: Record<string, unknown>) => {
      expect(args.confirm).toBeUndefined();
      expect(args.confirm_token).toBeUndefined();
      return {
        ok: true,
        data: { result: "Детали возврата" },
        raw: { structuredContent: { confirm_token: "tok_abc_777" } },
        rawText: "Детали возврата с токеном tok_abc_777",
      };
    });
    const tool = makeMockTool({ executeMock });

    const gateRequestSpy = vi.spyOn(gate, "request");
    const { result, executed } = await runToolCall(tool, { amount: 500 }, "f1", ctx);

    expect(executed).toBe(true);
    expect(result.ok).toBe(true);
    expect(gateRequestSpy).not.toHaveBeenCalled();
    if (result.ok) {
      expect((result.data as any).confirm_token).toBe("tok_abc_777");
    }
    // Запись сохранена в хранилище
    expect(ctx.savePreview).toHaveBeenCalled();
    const entry = ctx.getPreview!("crm__issue_refund", "tok_abc_777");
    expect(entry).toBeDefined();
    expect(entry?.args).toEqual({ amount: 500 });
  });

  it("подтверждение — ровно один gate.request", async () => {
    const ctx = makeMockContext();
    const token = "tok_abc_777";
    ctx.savePreview!("crm__issue_refund", token, { amount: 500 }, `Возврат 500. Токен: ${token}`);

    const gateRequestSpy = vi.spyOn(gate, "request");
    const tool = makeMockTool();

    const { result } = await runToolCall(
      tool,
      { amount: 500, confirm: true, confirm_token: token },
      "f2",
      ctx,
    );

    expect(gateRequestSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok && "needsConfirmation" in result) {
      expect(result.needsConfirmation.say).toBe("issue_refund: amount=500?");
    }
  });

  it("confirm: \"true\" и confirm: 1 не доходят до callTool", async () => {
    const executeMock = vi.fn();
    const tool = makeMockTool({ executeMock });
    const ctx = makeMockContext();

    // confirm: "true"
    const resString = await runToolCall(
      tool,
      { amount: 500, confirm: "true", confirm_token: "tok" },
      "f3",
      ctx,
    );
    expect(resString.result.ok).toBe(false);
    if (!resString.result.ok && "error" in resString.result) {
      expect(resString.result.error.code).toBe("invalid_argument");
    }
    expect(executeMock).not.toHaveBeenCalled();

    // confirm: 1
    const resNumber = await runToolCall(
      tool,
      { amount: 500, confirm: 1, confirm_token: "tok" },
      "f4",
      ctx,
    );
    expect(resNumber.result.ok).toBe(false);
    if (!resNumber.result.ok && "error" in resNumber.result) {
      expect(resNumber.result.error.code).toBe("invalid_argument");
    }
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("отказы: токен без превью, превью старше 10 мин, чужие аргументы, токен ручки A для ручки B, чужой CallSession", async () => {
    const ctx = makeMockContext();
    const token = "valid_tok_1";
    ctx.savePreview!("crm__issue_refund", token, { amount: 500 }, "превью текст");
    const tool = makeMockTool();

    // 1. Токен без превью
    const resNoPreview = await runToolCall(
      tool,
      { amount: 500, confirm: true, confirm_token: "unknown_token" },
      "f5",
      ctx,
    );
    expect(resNoPreview.result.ok).toBe(false);
    if (!resNoPreview.result.ok && "error" in resNoPreview.result) {
      expect(resNoPreview.result.error.code).toBe("invalid_argument");
    }

    // 2. Превью старше 10 мин
    const expiredToken = "expired_tok";
    ctx.savePreview!("crm__issue_refund", expiredToken, { amount: 500 }, "превью");
    const entry = ctx.getPreview!("crm__issue_refund", expiredToken)!;
    entry.createdAt = Date.now() - 11 * 60 * 1000; // 11 мин назад

    const resExpired = await runToolCall(
      tool,
      { amount: 500, confirm: true, confirm_token: expiredToken },
      "f6",
      ctx,
    );
    expect(resExpired.result.ok).toBe(false);
    if (!resExpired.result.ok && "error" in resExpired.result) {
      expect(resExpired.result.error.code).toBe("invalid_argument");
      expect(resExpired.result.error.message).toContain("10 минут");
    }

    // 3. Чужие аргументы с верным токеном
    const resWrongArgs = await runToolCall(
      tool,
      { amount: 999, confirm: true, confirm_token: token },
      "f7",
      ctx,
    );
    expect(resWrongArgs.result.ok).toBe(false);
    if (!resWrongArgs.result.ok && "error" in resWrongArgs.result) {
      expect(resWrongArgs.result.error.code).toBe("invalid_argument");
      expect(resWrongArgs.result.error.message).toContain("аргументы не совпадают");
    }

    // 4. Токен ручки A для ручки B
    const toolB = makeMockTool({ name: "crm__other_tool" });
    const resToolMismatch = await runToolCall(
      toolB,
      { amount: 500, confirm: true, confirm_token: token },
      "f8",
      ctx,
    );
    expect(resToolMismatch.result.ok).toBe(false);
    if (!resToolMismatch.result.ok && "error" in resToolMismatch.result) {
      expect(resToolMismatch.result.error.code).toBe("invalid_argument");
    }

    // 5. Токен из другого CallSession
    const ctxOtherSession = makeMockContext();
    const resOtherSession = await runToolCall(
      tool,
      { amount: 500, confirm: true, confirm_token: token },
      "f9",
      ctxOtherSession,
    );
    expect(resOtherSession.result.ok).toBe(false);
    if (!resOtherSession.result.ok && "error" in resOtherSession.result) {
      expect(resOtherSession.result.error.code).toBe("invalid_argument");
    }
  });

  it("нет токена в ответе — модели честно: «подтверждение невозможно»", async () => {
    const ctx = makeMockContext();
    const executeNoToken = vi.fn(async () => ({
      ok: true,
      data: { result: "Ответ без токена" },
      raw: { content: [{ type: "text", text: "Просто текст" }] },
    }));
    const tool = makeMockTool({ executeMock: executeNoToken });

    const { result } = await runToolCall(tool, { amount: 100 }, "f10", ctx);
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error.code).toBe("invalid_argument");
      expect(result.error.message).toBe("подтверждение невозможно");
    }
  });

  it("длинное превью обрезано, токен всё равно у модели", async () => {
    const ctx = makeMockContext();
    const longToken = "secure_token_xyz_987654321";
    // MCP client возвращает сжатый data.result, но сырой raw содержит токен
    const tool = makeMockTool({
      executeMock: async () => ({
        ok: true,
        data: { result: "A".repeat(499) + "…" },
        raw: {
          structuredContent: {
            confirm_token: longToken,
            fullDetails: "A".repeat(3000),
          },
        },
        rawText: "A".repeat(3000),
      }),
    });

    const { result } = await runToolCall(tool, { amount: 10 }, "f11", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as any).confirm_token).toBe(longToken);
      expect((result.data as any).result.length).toBeLessThanOrEqual(500);
      expect((result.data as any).result.endsWith("…")).toBe(true);
    }
  });

  it("stripConfirmKeys снимает только точный набор {confirm, confirm_token}, сохраняя confirmed_by и confirmation_email", () => {
    const rawArgs = {
      title: "Заказ 42",
      confirm: true,
      confirm_token: "tok123",
      confirmed_by: "manager",
      confirmation_email: "test@example.com",
    };
    const stripped = stripConfirmKeys(rawArgs);
    expect(stripped).toEqual({
      title: "Заказ 42",
      confirmed_by: "manager",
      confirmation_email: "test@example.com",
    });
  });

  it("confirmToken в camelCase не принимается как токен", async () => {
    const ctx = makeMockContext();
    const token = "valid_token_abc";
    ctx.savePreview!("crm__issue_refund", token, { amount: 500 }, "превью");
    const tool = makeMockTool();

    const resCamel = await runToolCall(
      tool,
      { amount: 500, confirm: true, confirmToken: token } as any,
      "f_camel",
      ctx,
    );
    expect(resCamel.result.ok).toBe(false);
    if (!resCamel.result.ok && "error" in resCamel.result) {
      expect(resCamel.result.error.code).toBe("invalid_argument");
      expect(resCamel.result.error.message).toContain("отсутствует confirm_token");
    }
  });

  it("Важно 2: handleRouterCalls при ошибке R-инструмента вызывает enqueueSystem", async () => {
    const store = new CallStore(new Database(":memory:"));
    const session = new CallSession({
      callId: "call_router_error_test",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "extended",
      allowExtended: true,
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: {
        threads: {
          messages: {
            list: async () => {
              throw new Error("thread not found or timeout");
            },
          },
        },
      } as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });

    const enqueueSpy = vi.spyOn(session as any, "enqueueSystem");
    const routerMockClient = {
      sendToolResponse: vi.fn(),
    };

    await (session as any).handleRouterCalls(routerMockClient as any, [
      { id: "call_read_fail", name: "read_thread", args: { threadId: "nonexistent" } },
    ]);

    expect(routerMockClient.sendToolResponse).toHaveBeenCalledWith("call_read_fail", expect.objectContaining({ ok: false }), "SILENT", "read_thread");
    expect(enqueueSpy).toHaveBeenCalledWith("read_thread", expect.objectContaining({ ok: false }));
  });
});

describe("3. E2E с тестовым коннектором stdio и CallSession (§14.10, §15.6 п. 2)", () => {
  const fixturePath = join(__dirname, "../research/fixtures/test-connector.mjs");

  it("полный цикл «превью → да → исполнение» на test-connector.mjs: токена нет в журнале и кадрах", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const cfg = {
      title: "Test Service",
      connectors: [
        {
          id: "test",
          transport: "stdio" as const,
          command: ["/usr/bin/node", fixturePath],
          tools: {
            get_info: "R" as const,
            create_record: "C" as const,
          },
          defaultClass: "deny" as const,
          twoStep: ["create_record"],
          maxResultChars: 500,
        },
      ],
    };
    const rawRegistry = JSON.stringify({ proj_test: cfg });
    mgr.approve("proj_test", hashProjectConfig(cfg), rawRegistry);

    const sentFrames: ServerFrame[] = [];
    const callId = "call_two_step_e2e";

    const session = new CallSession({
      callId,
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      targetProjectId: "proj_test",
      projectRegistry: mgr,
      rawProjectRegistry: rawRegistry,
      sdk: {
        projects: { get: async () => ({ id: "proj_test", name: "Test Service", sources: [] }) },
      } as never,
      toBrowser: (f) => sentFrames.push(f),
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });

    await session.start();

    // ШАГ 1: Превью
    let previewResponse: any = null;
    const fakeClient = {
      sendToolResponse: vi.fn((id, res) => {
        previewResponse = res;
      }),
    };

    await (session as any).handleNativeCalls(fakeClient as any, [
      { id: "call_preview", name: "test__create_record", args: { title: "Order #42" } },
    ]);

    expect(previewResponse).toBeDefined();
    expect(previewResponse.ok).toBe(true);
    const token = previewResponse.data.confirm_token;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);

    // Событие confirm НЕ должно быть записано на превью (§14.10 п. 2)
    const eventsAfterPreview = (store as any).db.prepare("SELECT kind FROM call_events WHERE call_id = ?").all(callId);
    expect(eventsAfterPreview.some((e: any) => e.kind === "confirm")).toBe(false);

    // ШАГ 2: Подтверждение
    let confirmResponse: any = null;
    fakeClient.sendToolResponse = vi.fn((id, res) => {
      confirmResponse = res;
    });

    await (session as any).handleNativeCalls(fakeClient as any, [
      {
        id: "call_confirm",
        name: "test__create_record",
        args: { title: "Order #42", confirm: true, confirm_token: token },
      },
    ]);

    expect(confirmResponse).toBeDefined();
    expect(confirmResponse.ok).toBe(false);
    expect(confirmResponse.needsConfirmation).toBeDefined();

    // Проверяем событие confirm в журнале (теперь оно есть)
    const eventsAfterConfirm = (store as any).db.prepare("SELECT kind FROM call_events WHERE call_id = ?").all(callId);
    expect(eventsAfterConfirm.some((e: any) => e.kind === "confirm")).toBe(true);

    // Проверяем карточку в кадре confirmation: токен заменён на ***
    const confirmFrame = sentFrames.find((f) => f.type === "confirmation") as any;
    expect(confirmFrame).toBeDefined();
    expect(confirmFrame.summary).toContain("***");
    expect(confirmFrame.summary).not.toContain(token);

    // ШАГ 3: Владелец говорит «да»
    const pending = session.pendingConfirmation();
    expect(pending).not.toBeNull();
    session.decideConfirmation(pending!.confirmationId, "approve");

    // Даём отработать асинхронному выполнению в test-connector
    await new Promise((r) => setTimeout(r, 200));

    // Проверяем кадр action: завершено
    const doneActionFrame = sentFrames.find((f) => f.type === "action" && f.status === "done") as any;
    expect(doneActionFrame).toBeDefined();
    expect(doneActionFrame.summary).toContain("Выполнено: test__create_record");

    // Превью удалено после approved (одноразовое)
    expect(session.getTwoStepPreview("test__create_record", token)).toBeUndefined();

    // Повторный вызов с тем же токеном отклоняется без вопроса
    let repeatResponse: any = null;
    fakeClient.sendToolResponse = vi.fn((id, res) => {
      repeatResponse = res;
    });
    await (session as any).handleNativeCalls(fakeClient as any, [
      {
        id: "call_repeat",
        name: "test__create_record",
        args: { title: "Order #42", confirm: true, confirm_token: token },
      },
    ]);
    expect(repeatResponse.ok).toBe(false);
    expect(repeatResponse.error.code).toBe("invalid_argument");

    // ШАГ 4: Проверка отсутствия токена во всех событиях и кадрах (§14.10 п. 6, 7)
    const allDbEvents = (store as any).db.prepare("SELECT kind, payload FROM call_events WHERE call_id = ?").all(callId);
    for (const row of allDbEvents) {
      expect(row.payload).not.toContain(token);
    }
    for (const f of sentFrames) {
      const frameStr = JSON.stringify(f);
      expect(frameStr).not.toContain(token);
    }
    expect((session as any).ledger.handoverSummary()).not.toContain(token);
    expect(JSON.stringify((session as any).ledger)).not.toContain(token);

    await session.end("owner");
  });

  it("Блокер 1: payload sendToolResponse для R-ручки — только ok и data, в пределах maxResultChars, секрет замаскирован", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);
    const SECRET = "CRM_API_SECRET_999";

    const cfg = {
      title: "Test Service",
      connectors: [
        {
          id: "test",
          transport: "stdio" as const,
          command: ["/usr/bin/node", fixturePath],
          tools: {
            get_info: "R" as const,
          },
          defaultClass: "deny" as const,
          secrets: ["CRM_SECRET"],
          maxResultChars: 500,
        },
      ],
    };
    const rawRegistry = JSON.stringify({ proj_test: cfg });
    mgr.approve("proj_test", hashProjectConfig(cfg), rawRegistry);

    const session = new CallSession({
      callId: "call_r_secret_leak_check",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      targetProjectId: "proj_test",
      projectRegistry: mgr,
      rawProjectRegistry: rawRegistry,
      projectSecrets: { CRM_SECRET: SECRET },
      sdk: {
        projects: { get: async () => ({ id: "proj_test", name: "Test Service", sources: [] }) },
      } as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });

    await session.start();

    let toolResponse: any = null;
    const fakeClient = {
      sendToolResponse: vi.fn((id, res) => {
        toolResponse = res;
      }),
    };

    await (session as any).handleNativeCalls(fakeClient as any, [
      { id: "call_r_get_info", name: "test__get_info", args: {} },
    ]);

    expect(toolResponse).toBeDefined();
    expect(toolResponse.ok).toBe(true);
    // Только ok и data
    expect(Object.keys(toolResponse).sort()).toEqual(["data", "ok"]);
    expect(toolResponse.raw).toBeUndefined();
    expect(toolResponse.rawText).toBeUndefined();
    expect(toolResponse.data.result.length).toBeLessThanOrEqual(500);

    await session.end("owner");
  });

  it("Блокер 2: секрет из превью не появляется в кадре confirmation", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);
    const SECRET = "LEAK_SECRET_TOKEN_7777";

    const cfg = {
      title: "Test Service",
      connectors: [
        {
          id: "test",
          transport: "stdio" as const,
          command: ["/usr/bin/node", fixturePath],
          tools: {
            create_record: "C" as const,
          },
          defaultClass: "deny" as const,
          twoStep: ["create_record"],
          secrets: ["TEST_SECRET"],
        },
      ],
    };
    const rawRegistry = JSON.stringify({ proj_test: cfg });
    mgr.approve("proj_test", hashProjectConfig(cfg), rawRegistry);

    const sentFrames: ServerFrame[] = [];
    const session = new CallSession({
      callId: "call_preview_secret_leak_check",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      targetProjectId: "proj_test",
      projectRegistry: mgr,
      rawProjectRegistry: rawRegistry,
      projectSecrets: { TEST_SECRET: SECRET },
      sdk: {
        projects: { get: async () => ({ id: "proj_test", name: "Test Service", sources: [] }) },
      } as never,
      toBrowser: (f) => sentFrames.push(f),
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });

    await session.start();

    let previewResponse: any = null;
    const fakeClient = {
      sendToolResponse: vi.fn((id, res) => {
        previewResponse = res;
      }),
    };

    // Вызываем превью с title, содержащим значение секрета
    await (session as any).handleNativeCalls(fakeClient as any, [
      { id: "call_prev_secret", name: "test__create_record", args: { title: `Important Order with secret ${SECRET}` } },
    ]);

    expect(previewResponse.ok).toBe(true);
    const token = previewResponse.data.confirm_token;

    // Вызываем подтверждение
    await (session as any).handleNativeCalls(fakeClient as any, [
      { id: "call_confirm_secret", name: "test__create_record", args: { title: `Important Order with secret ${SECRET}`, confirm: true, confirm_token: token } },
    ]);

    const confFrame = sentFrames.find((f) => f.type === "confirmation") as any;
    expect(confFrame).toBeDefined();
    // Секрет не должен присутствовать в карточке confirmation
    expect(confFrame.summary).not.toContain(SECRET);
    expect(confFrame.summary).not.toContain(token);
    expect(confFrame.summary).toContain("***");

    await session.end("owner");
  });

  it("Мелкое 4: токен из другого CallSession — отказ на уровне реальных CallSession", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const cfg = {
      title: "Test Service",
      connectors: [
        {
          id: "test",
          transport: "stdio" as const,
          command: ["/usr/bin/node", fixturePath],
          tools: { create_record: "C" as const },
          defaultClass: "deny" as const,
          twoStep: ["create_record"],
        },
      ],
    };
    const rawRegistry = JSON.stringify({ proj_test: cfg });
    mgr.approve("proj_test", hashProjectConfig(cfg), rawRegistry);

    const makeSession = (callId: string) =>
      new CallSession({
        callId,
        keys: ["k1"],
        voice: "Algenib",
        languageCode: "ru-RU",
        thinkingLevel: "LOW",
        mode: "normal",
        routerInput: "text",
        maxCallMinutes: 60,
        store,
        targetProjectId: "proj_test",
        projectRegistry: mgr,
        rawProjectRegistry: rawRegistry,
        sdk: {
          projects: { get: async () => ({ id: "proj_test", name: "Test Service", sources: [] }) },
        } as never,
        toBrowser: () => {},
        sendBrowserAudio: () => {},
        spawnCallThread: async () => null,
        advanceCallThread: async () => {},
        sayCallThread: async () => {},
        endCallThread: async () => {},
        wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
      });

    const sessionA = makeSession("call_session_a");
    const sessionB = makeSession("call_session_b");

    await sessionA.start();
    await sessionB.start();

    let previewRespA: any = null;
    const clientA = {
      sendToolResponse: vi.fn((id, res) => {
        previewRespA = res;
      }),
    };

    await (sessionA as any).handleNativeCalls(clientA as any, [
      { id: "call_prev_a", name: "test__create_record", args: { title: "Order A" } },
    ]);

    expect(previewRespA.ok).toBe(true);
    const tokenA = previewRespA.data.confirm_token;

    // Пытаемся подтвердить в sessionB с токеном из sessionA
    let confirmRespB: any = null;
    const clientB = {
      sendToolResponse: vi.fn((id, res) => {
        confirmRespB = res;
      }),
    };

    await (sessionB as any).handleNativeCalls(clientB as any, [
      { id: "call_conf_b", name: "test__create_record", args: { title: "Order A", confirm: true, confirm_token: tokenA } },
    ]);

    expect(confirmRespB.ok).toBe(false);
    expect(confirmRespB.error.code).toBe("invalid_argument");
    expect(confirmRespB.error.message).toContain("превью не найдено");

    await sessionA.end("owner");
    await sessionB.end("owner");
  });

  it("Мелкое 3: sanitizeTokens защищает ledger и sayCallThread от токена", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const cfg = {
      title: "Test Service",
      connectors: [
        {
          id: "test",
          transport: "stdio" as const,
          command: ["/usr/bin/node", fixturePath],
          tools: { create_record: "C" as const },
          defaultClass: "deny" as const,
          twoStep: ["create_record"],
        },
      ],
    };
    const rawRegistry = JSON.stringify({ proj_test: cfg });
    mgr.approve("proj_test", hashProjectConfig(cfg), rawRegistry);

    const saidLines: string[] = [];
    const session = new CallSession({
      callId: "call_token_sanitize_test",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      targetProjectId: "proj_test",
      projectRegistry: mgr,
      rawProjectRegistry: rawRegistry,
      sdk: {
        projects: { get: async () => ({ id: "proj_test", name: "Test Service", sources: [] }) },
      } as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => "th_123",
      advanceCallThread: async () => {},
      sayCallThread: async (line) => {
        saidLines.push(line);
      },
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });

    await session.start();

    let previewResp: any = null;
    const client = {
      sendToolResponse: vi.fn((id, res) => {
        previewResp = res;
      }),
    };

    await (session as any).handleNativeCalls(client as any, [
      { id: "call_prev", name: "test__create_record", args: { title: "Item" } },
    ]);

    expect(previewResp.ok).toBe(true);
    const token = previewResp.data.confirm_token;

    // Владелец произносит реплику с токеном
    (session as any).onOwnerUtteranceFinal(`Я согласен с токеном ${token}`, "speech");

    // Имитируем ответ агента с токеном
    const agentText = `Подтверждаю токен ${token}`;
    const liveClient = (session as any).voice;
    liveClient.emit("outputTranscript", agentText);
    liveClient.emit("turnComplete");
    await new Promise((r) => setTimeout(r, 200));

    expect(saidLines.length).toBeGreaterThan(0);
    for (const line of saidLines) {
      expect(line).not.toContain(token);
      expect(line).toContain("***");
    }

    const ledgerSummary = (session as any).ledger.handoverSummary();
    expect(ledgerSummary).not.toContain(token);
    expect(ledgerSummary).toContain("***");

    await session.end("owner");
  });

  it("длинное превью на реальном коннекторе обрезано, но токен отдаётся модели", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const cfg = {
      title: "Test Service",
      connectors: [
        {
          id: "test",
          transport: "stdio" as const,
          command: ["/usr/bin/node", fixturePath],
          tools: { create_record: "C" as const },
          defaultClass: "deny" as const,
          twoStep: ["create_record"],
          maxResultChars: 500, // жесткий лимит 500
        },
      ],
    };
    const rawRegistry = JSON.stringify({ proj_test: cfg });
    mgr.approve("proj_test", hashProjectConfig(cfg), rawRegistry);

    const session = new CallSession({
      callId: "call_long_preview",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      targetProjectId: "proj_test",
      projectRegistry: mgr,
      rawProjectRegistry: rawRegistry,
      sdk: {
        projects: { get: async () => ({ id: "proj_test", name: "Test Service", sources: [] }) },
      } as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });

    await session.start();

    let previewResponse: any = null;
    const fakeClient = {
      sendToolResponse: vi.fn((id, res) => {
        previewResponse = res;
      }),
    };

    // Вызываем с long: true -> сгенерирует >1000 символов
    await (session as any).handleNativeCalls(fakeClient as any, [
      { id: "call_preview_long", name: "test__create_record", args: { title: "Big Item", long: true } },
    ]);

    expect(previewResponse).toBeDefined();
    expect(previewResponse.ok).toBe(true);
    // Токен на месте и не обрезан
    expect(typeof previewResponse.data.confirm_token).toBe("string");
    expect(previewResponse.data.confirm_token.length).toBe(64); // sha256 hex
    // Текст превью обрезан до 500
    expect(previewResponse.data.result.length).toBeLessThanOrEqual(500);
    expect(previewResponse.data.result.endsWith("…")).toBe(true);

    await session.end("owner");
  });
});
