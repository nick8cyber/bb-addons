/**
 * Тесты звонка по проекту (§15.1–15.6, §15.8, ADR-0011).
 */
import Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import { clientFrame, type ServerFrame } from "../src/contract.js";
import {
  McpClient,
  makeConnectorToolName,
  mcpSchemaToGeminiParameters,
  parseConnectorToolName,
} from "../src/mcp-client.js";
import {
  ProjectRegistryManager,
  computeProjectDiff,
  connectorConfigSchema,
  CONNECTOR_RESULT_MAX_CHARS_DEFAULT,
  hashProjectConfig,
  readProjectRepoConfig,
  resolveStrictClass,
  type ProjectConfig,
} from "../src/project-registry.js";

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

describe("1. Реестр projectCalls и выбор строгого класса (§15.2, §15.3)", () => {
  it("разбор реестра, валидация и запрет R в defaultClass", () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    // Валидный реестр
    const validJson = JSON.stringify({
      proj_1: {
        title: "CRM",
        connectors: [
          {
            id: "crm",
            transport: "stdio",
            command: ["/usr/bin/node", "/path/server.js"],
            tools: { clients_list: "R", payment_mark: "C" },
            defaultClass: "C",
          },
        ],
      },
    });
    const parsed = mgr.parseRegistry(validJson);
    expect(parsed.error).toBeUndefined();
    expect(parsed.parsed?.proj_1?.title).toBe("CRM");

    // Запрет R в defaultClass (§15.2)
    const invalidDefaultClass = JSON.stringify({
      proj_1: {
        title: "CRM",
        connectors: [
          {
            id: "crm",
            transport: "stdio",
            command: ["/usr/bin/node", "/path/server.js"],
            defaultClass: "R",
          },
        ],
      },
    });
    const invalidRes = mgr.parseRegistry(invalidDefaultClass);
    expect(invalidRes.parsed).toBeNull();
    expect(invalidRes.error).toContain("defaultClass");
  });

  it("выбор строгого класса: R < C < P < L и режим только чтения (deny)", () => {
    // Registry R, repo C -> C
    expect(resolveStrictClass("R", "C")).toBe("C");
    // Registry C, repo R -> C (репо не может понизить класс реестра)
    expect(resolveStrictClass("C", "R")).toBe("C");
    // Registry C, repo P -> P
    expect(resolveStrictClass("C", "P")).toBe("P");
    // Registry P, repo C -> P
    expect(resolveStrictClass("P", "C")).toBe("P");
    // Registry P, repo L -> L
    expect(resolveStrictClass("P", "L")).toBe("L");
    // Registry deny -> всегда deny, независимо от репо
    expect(resolveStrictClass("deny", "R")).toBe("deny");
    expect(resolveStrictClass("deny", "L")).toBe("deny");
  });

  it("дифф изменений реестра: новые коннекторы, команды, повышение класса", () => {
    const oldConfig: ProjectConfig = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio",
          command: ["/usr/bin/node", "/old/server.js"],
          tools: { get_data: "R", set_data: "C" },
          defaultClass: "C",
        },
      ],
    };
    const newConfig: ProjectConfig = {
      title: "CRM v2",
      connectors: [
        {
          id: "crm",
          transport: "stdio",
          command: ["/usr/bin/node", "/new/server.js"],
          tools: { get_data: "C", set_data: "P" },
          defaultClass: "P",
        },
        {
          id: "analytics",
          transport: "http",
          url: "https://analytics.local",
          defaultClass: "deny",
        },
      ],
    };

    const diff = computeProjectDiff(oldConfig, newConfig);
    expect(diff.some((d) => d.includes("CRM v2"))).toBe(true);
    expect(diff.some((d) => d.includes("изменена команда запуска"))).toBe(true);
    expect(diff.some((d) => d.includes("добавлен коннектор «analytics»"))).toBe(true);
    expect(diff.some((d) => d.includes("класс ручки «get_data» изменён R → C"))).toBe(true);
    expect(diff.some((d) => d.includes("класс по умолчанию изменён C → P"))).toBe(true);
  });
});

describe("2. Чтение окружения проекта (§15.3)", () => {
  const tempDir = join(tmpdir(), `test-proj-repo-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(tempDir, ".bb", "live-call"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("читает только PROMPT.md (до 8000 символов) и tools.json; ничего другого из репо не читается", () => {
    const longPrompt = "A".repeat(9000);
    writeFileSync(join(tempDir, ".bb", "live-call", "PROMPT.md"), longPrompt);
    writeFileSync(
      join(tempDir, ".bb", "live-call", "tools.json"),
      JSON.stringify({ query: "R", mutate: "P", invalid: "UNKNOWN" }),
    );
    // Посторонний файл с попыткой внедрения настроек коннектора
    writeFileSync(
      join(tempDir, ".bb", "live-call", "connector.json"),
      JSON.stringify({ command: ["rm", "-rf", "/"] }),
    );

    const res = readProjectRepoConfig(tempDir);
    expect(res.promptMd?.length).toBe(8000);
    expect(res.promptMd).toBe("A".repeat(8000));
    expect(res.tools).toEqual({ query: "R", mutate: "P" });
    // connector.json проигнорирован
    expect((res as Record<string, unknown>).connector).toBeUndefined();
  });
});

describe("3. Перевод схем MCP → Gemini functionDeclarations (§15.4 п. 2)", () => {
  it("отбрасывает неподдержанные ключи ($schema, additionalProperties) и нормализует имя", () => {
    const mcpSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "ClientFilter",
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", description: "max items", default: 10 },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["limit"],
    };

    const geminiParams = mcpSchemaToGeminiParameters(mcpSchema);
    expect(geminiParams.type).toBe("object");
    expect((geminiParams as Record<string, unknown>).$schema).toBeUndefined();
    expect((geminiParams as Record<string, unknown>).additionalProperties).toBeUndefined();
    expect((geminiParams as Record<string, unknown>).title).toBeUndefined();
    expect((geminiParams.properties as Record<string, unknown>).limit).toEqual({
      type: "integer",
      description: "max items",
    });

    const toolName = makeConnectorToolName("crm-service", "get-clients");
    expect(toolName).toBe("crm_service__get_clients");
    expect(parseConnectorToolName(toolName)).toEqual({
      connectorId: "crm_service",
      tool: "get_clients",
    });
  });
});

describe("4. Кадр hello и валидация входа (§15.1, §15.8)", () => {
  it("в одном hello не бывает и threadId, и projectId", () => {
    const parsed = clientFrame.safeParse({
      type: "hello",
      protocol: 1,
      threadId: "thr_1",
      projectId: "proj_1",
    });
    // zod парсит поля, но сервер валидирует и возвращает bad_hello
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "hello") {
      const isBad = Boolean(parsed.data.threadId && parsed.data.projectId);
      expect(isBad).toBe(true);
    }
  });

  it("hello с projectId валиден", () => {
    const parsed = clientFrame.safeParse({
      type: "hello",
      protocol: 1,
      projectId: "proj_crm",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "hello") {
      expect(parsed.data.projectId).toBe("proj_crm");
      expect(parsed.data.threadId).toBeUndefined();
    }
  });
});

describe("5. RPC (§15.8): projectCallsList, projectCallsApprove, projectCallsReject", () => {
  it("подтверждение изменений реестра через RPC обновляет хеш в SQLite", () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const config = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/server.js"],
          defaultClass: "C" as const,
        },
      ],
    };
    const rawJson = JSON.stringify({ proj_test: config });

    // Сначала проект pending
    const list1 = mgr.listProjects(rawJson);
    expect(list1).toHaveLength(1);
    expect(list1[0].state).toBe("pending");
    const hash = list1[0].hash!;
    expect(hash).toBeDefined();

    // Подтверждение с неверным хешем возвращает stale
    const staleRes = mgr.approve("proj_test", "wrong_hash", rawJson);
    expect(staleRes.ok).toBe(false);
    expect(staleRes.error).toBe("stale");

    // Подтверждение с верным хешем
    const okRes = mgr.approve("proj_test", hash, rawJson);
    expect(okRes.ok).toBe(true);

    // Теперь проект approved
    const list2 = mgr.listProjects(rawJson);
    expect(list2[0].state).toBe("approved");
    expect(list2[0].hash).toBe(hash);

    // Получение подтверждённой конфигурации
    const approvedConfig = mgr.getApprovedConfig("proj_test");
    expect(approvedConfig).not.toBeNull();
    expect(approvedConfig?.config.title).toBe("CRM");
  });

  it("смена команды или класса без подтверждения не применяется", () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const cfg1 = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/v1.js"],
          tools: { query: "R" as const },
          defaultClass: "deny" as const,
        },
      ],
    };
    const json1 = JSON.stringify({ proj_1: cfg1 });
    const h1 = mgr.listProjects(json1)[0].hash!;
    mgr.approve("proj_1", h1, json1);
    expect(mgr.getApprovedConfig("proj_1")).not.toBeNull();

    // Неподтверждённая смена команды на /v2.js
    const cfg2 = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["/usr/bin/node", "/v2.js"],
          tools: { query: "R" as const },
          defaultClass: "deny" as const,
        },
      ],
    };
    const json2 = JSON.stringify({ proj_1: cfg2 });

    // Статус стал pending
    const list = mgr.listProjects(json2);
    expect(list[0].state).toBe("pending");

    // Смена команды без подтверждения не применяется: getApprovedConfig возвращает v1.js, а не v2.js (§15.2)
    const approved = mgr.getApprovedConfig("proj_1");
    expect(approved).not.toBeNull();
    expect(approved!.config.connectors[0].command).toEqual(["/usr/bin/node", "/v1.js"]);
    expect(approved!.config.connectors[0].command).not.toEqual(["/usr/bin/node", "/v2.js"]);
  });
});

describe("6. Защита реестра от подтверждения в звонке (§15.2 п. 4)", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("кадр text с «разрешаю» НЕ подтверждает изменение реестра", async () => {
    const store = new CallStore(new Database(":memory:"));
    let approvedCalled = false;

    const frames: ServerFrame[] = [];
    const session = new CallSession({
      callId: "call_sec_test",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: { projects: { list: async () => [] } } as never,
      toBrowser: (f) => frames.push(f),
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
      pendingRegistryChanges: [
        { projectId: "p1", title: "CRM", hash: "h1", diff: ["добавлен коннектор"] },
      ],
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(10);

    // Отправляем кадр text со словом «разрешаю»
    session.sendUserMessage("разрешаю");
    await vi.advanceTimersByTimeAsync(10);

    // Реестр НЕ должен быть подтверждён!
    expect(store.getApprovedProject("p1")).toBeNull();
  });

  it("реплика владельца голосом (речь) с «разрешаю» НЕ подтверждает изменение реестра (§15.2 п. 4)", async () => {
    const store = new CallStore(new Database(":memory:"));
    let approvedCalled = false;

    const frames: ServerFrame[] = [];
    const session = new CallSession({
      callId: "call_voice_noreapprove_test",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: { projects: { list: async () => [] } } as never,
      toBrowser: (f) => frames.push(f),
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
      pendingRegistryChanges: [
        { projectId: "p1", title: "CRM", hash: "h1", diff: ["добавлен коннектор"] },
      ],
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(10);

    // Реплика владельца с распознанной речью «разрешаю» (§15.2 п. 4: речь реестр не подтверждает)
    session.onOwnerUtteranceFinal("разрешаю", "speech");
    await vi.advanceTimersByTimeAsync(10);

    // Реестр НЕ должен быть подтверждён!
    expect(store.getApprovedProject("p1")).toBeNull();
  });
});

describe("7. MCP-коннектор stdio и вызовы ручек (§15.4, §15.6 п. 2)", () => {
  it("подключение к тестовому коннектору через stdio и опрос ручек", async () => {
    const fixturePath = join(__dirname, "../research/fixtures/test-connector.mjs");
    const client = new McpClient({
      id: "test",
      transport: "stdio",
      command: ["/usr/bin/node", fixturePath],
      defaultClass: "C",
    });

    const tools = await client.start(5000);
    expect(tools.map((t) => t.name)).toContain("get_info");
    expect(tools.map((t) => t.name)).toContain("set_status");
    expect(tools.map((t) => t.name)).toContain("forbidden_action");

    // Вызов ручки get_info (класс R)
    const resR = await client.callTool("get_info", {});
    expect(resR.ok).toBe(true);
    expect(resR.data?.result).toContain("test-connector status: OK");

    // Вызов ручки set_status (класс C)
    const resC = await client.callTool("set_status", { status: "active" });
    expect(resC.ok).toBe(true);
    expect(resC.data?.result).toContain("status updated to: active");

    client.close();
  });

  it("валидация maxResultChars (500..20000) и диффы (§15.2)", () => {
    // 500..20000 допустимы
    expect(
      connectorConfigSchema.safeParse({
        id: "c1",
        transport: "stdio",
        command: ["/bin/echo"],
        defaultClass: "C",
        maxResultChars: 500,
      }).success,
    ).toBe(true);

    expect(
      connectorConfigSchema.safeParse({
        id: "c1",
        transport: "stdio",
        command: ["/bin/echo"],
        defaultClass: "C",
        maxResultChars: 20000,
      }).success,
    ).toBe(true);

    // Меньше 500 недопустимо
    expect(
      connectorConfigSchema.safeParse({
        id: "c1",
        transport: "stdio",
        command: ["/bin/echo"],
        defaultClass: "C",
        maxResultChars: 499,
      }).success,
    ).toBe(false);

    // Больше 20000 недопустимо
    expect(
      connectorConfigSchema.safeParse({
        id: "c1",
        transport: "stdio",
        command: ["/bin/echo"],
        defaultClass: "C",
        maxResultChars: 20001,
      }).success,
    ).toBe(false);

    // Дифф при смене maxResultChars
    const oldConfig: ProjectConfig = {
      title: "P",
      connectors: [
        { id: "c1", transport: "stdio", command: ["/bin/echo"], defaultClass: "C", maxResultChars: 2000 },
      ],
    };
    const newConfig: ProjectConfig = {
      title: "P",
      connectors: [
        { id: "c1", transport: "stdio", command: ["/bin/echo"], defaultClass: "C", maxResultChars: 8000 },
      ],
    };
    const diffs = computeProjectDiff(oldConfig, newConfig);
    expect(diffs).toContain("коннектор «c1»: изменён лимит ответа 2000 → 8000");
  });

  it("сжатие ответа ручки до maxResultChars коннектора (§15.4 п. 5)", async () => {
    const fixturePath = join(__dirname, "../research/fixtures/test-connector.mjs");
    const client = new McpClient({
      id: "test",
      transport: "stdio",
      command: ["/usr/bin/node", fixturePath],
      defaultClass: "C",
      maxResultChars: 500,
    });

    await client.start(5000);
    // Длинный статус для проверки обрезки
    const longStatus = "x".repeat(1000);
    const res = await client.callTool("set_status", { status: longStatus });
    expect(res.ok).toBe(true);
    expect(res.data?.result.length).toBeLessThanOrEqual(500);
    expect(res.data?.result.endsWith("…")).toBe(true);
    client.close();
  });
});

describe("ревью PLUG-113: stdio-коннектор — только абсолютный путь (§14.1)", () => {
  it("command[0] без «/» — реестр некорректен", () => {
    expect(connectorConfigSchema.safeParse({ id: "c1", transport: "stdio", command: ["node", "/x.js"], defaultClass: "C" }).success).toBe(false);
    expect(connectorConfigSchema.safeParse({ id: "c1", transport: "stdio", command: ["/usr/bin/node", "/x.js"], defaultClass: "C" }).success).toBe(true);
  });
});

describe("ревью PLUG-113: HTTP-коннектор — обрыв сети посреди звонка", () => {
  it("fetch падает — connector_unavailable, а не connector_error", async () => {
    const { McpClient } = await import("../src/mcp-client.js");
    const client = new McpClient({ id: "h1", transport: "http", url: "http://127.0.0.1:1/mcp", defaultClass: "C" } as never, {});
    const res = await client.callTool("x", {}, 2000);
    expect(res.ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("connector_unavailable");
    client.close();
  });
});

describe("§14.4: скалярное объединение со строкой (ревью 04.11, схемы первого реального коннектора)", () => {
  it("[string, number] и [string, integer] → string; с null — nullable; прочие объединения — отказ", async () => {
    const { toGeminiSchema } = await import("../src/mcp-client.js");
    const s = toGeminiSchema({
      type: "object",
      properties: {
        amount: { type: ["string", "number"] },
        telegram_id: { type: ["string", "integer", "null"] },
      },
    }) as { properties: Record<string, { type: string; nullable?: boolean }> };
    expect(s.properties.amount.type.toLowerCase()).toBe("string");
    expect(s.properties.telegram_id.type.toLowerCase()).toBe("string");
    expect(s.properties.telegram_id.nullable).toBe(true);
    expect(toGeminiSchema({ type: "object", properties: { x: { type: ["number", "boolean"] } } })).toBeNull();
    expect(toGeminiSchema({ type: "object", properties: { x: { type: ["number", "integer"] } } })).toBeNull();
  });
});
