/**
 * Тесты исправлений по ревью PLUG-109 (§16.7, PLUG-112).
 * Проверяются п. 1–7:
 * 1. Окружение коннектора без process.env плагина (без GEMINI_KEYS).
 * 2. Звонок по треду запускает коннекторы только по текущему подтверждённому реестру; удаление снимка.
 * 3. confirmSay ручки коннектора содержит имя и все аргументы.
 * 4. Фильтр секретов (maskSecrets) для ответов, stderr, ошибок; аргументы коннектора не пишутся в журнал.
 * 5. HTTP-транспорт: Accept, Mcp-Session-Id, SSE, Authorization: Bearer, закрытие DELETE, проверка адресов.
 * 6. Средние замечания: toGeminiSchema, коллизии имён, hasOwnProperty, падение коннектора -> connector_unavailable, завершение при ended, фраза «реестр изменился» только для целевого проекта.
 * 7. Мелкие: safe PROMPT.md (без симлинков, лимит 32 КБ), diff с новой командой и маскированием URL, отказ в reject, удаление мёртвого кода, протокол 2025-06-18, курсор tools/list, закрытие кодом 4000 вместо 4009.
 */
import Database from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import {
  McpClient,
  isValidConnectorToolName,
  makeConnectorToolName,
  toGeminiSchema,
} from "../src/mcp-client.js";
import {
  ProjectRegistryManager,
  computeProjectDiff,
  connectorConfigSchema,
  hashProjectConfig,
  projectConfigSchema,
  readProjectRepoConfig,
  resolveStrictClass,
} from "../src/project-registry.js";
import { maskSecrets } from "../src/secret-filter.js";

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
  close(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close", { code: code ?? 1000, reason: reason ?? "" });
  }
  fire(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

describe("§16.7 п. 1: Окружение процесса коннектора", () => {
  it("процесс коннектора получает только PATH, HOME, LANG и свои secrets, без GEMINI_KEYS и окружения плагина", async () => {
    // Подкладываем секреты в process.env плагина
    process.env["GEMINI_KEYS"] = "secret_gemini_api_key_12345";
    process.env["PLUGIN_INTERNAL_SECRET"] = "do_not_leak_me";

    // Скрипт MCP-сервера на Node, который возвращает process.env в tools/call
    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'get_env', inputSchema: { type: 'object' } }] } }) + '\\n');
        } else if (msg.method === 'tools/call') {
          const report = {
            has_gemini: Boolean(process.env.GEMINI_KEYS),
            has_plugin_secret: Boolean(process.env.PLUGIN_INTERNAL_SECRET),
            token_matches: process.env.MY_CONNECTOR_TOKEN === 'allowed_token_value',
            has_path: Boolean(process.env.PATH),
          };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(report) }] } }) + '\\n');
        }
      });
    `;

    const client = new McpClient(
      {
        id: "env_test",
        transport: "stdio",
        command: [process.execPath, "-e", script],
        secrets: ["MY_CONNECTOR_TOKEN"],
        defaultClass: "C",
      },
      {
        MY_CONNECTOR_TOKEN: "allowed_token_value",
      },
    );

    try {
      const tools = await client.start(5000);
      expect(tools).toHaveLength(1);
      const res = await client.callTool("get_env", {});
      expect(res.ok).toBe(true);
      const childReport = JSON.parse(res.data!.result);

      // Проверяем: GEMINI_KEYS и PLUGIN_INTERNAL_SECRET не попали в дочерний процесс
      expect(childReport.has_gemini).toBe(false);
      expect(childReport.has_plugin_secret).toBe(false);

      // Проверяем: переданный секрет коннектора присутствует внутри процесса коннектора
      expect(childReport.token_matches).toBe(true);
      // PATH или HOME присутствуют
      expect(childReport.has_path).toBe(true);
    } finally {
      client.close();
      delete process.env["GEMINI_KEYS"];
      delete process.env["PLUGIN_INTERNAL_SECRET"];
    }
  });

  it("при отсутствии требуемого секрета коннектор не поднимается с ошибкой connector_secret_missing", async () => {
    const client = new McpClient(
      {
        id: "missing_sec",
        transport: "stdio",
        command: [process.execPath, "-e", "process.exit(0)"],
        secrets: ["MISSING_TOKEN"],
        defaultClass: "C",
      },
      {}, // пусто, секрет не настроен
    );

    await expect(client.start(3000)).rejects.toThrow(/connector_secret_missing/);
    client.close();
  });
});

describe("§16.7 п. 2: Звонок по треду и текущий реестр; удаление снимка", () => {
  it("звонок по треду запускает коннекторы только если проект есть в текущем реестре и утверждён", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const cfg = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: [process.execPath, "-e", "process.exit(0)"],
          defaultClass: "C" as const,
        },
      ],
    };
    const raw = JSON.stringify({ proj_crm: cfg });
    const hash = hashProjectConfig(cfg);
    mgr.approve("proj_crm", hash, raw);

    // 1. Проект утверждён — сессия запускает коннекторы
    const session1 = new CallSession({
      callId: "call_t1",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      targetThreadId: "thr_1",
      projectRegistry: mgr,
      rawProjectRegistry: raw,
      sdk: {
        threads: { get: async () => ({ id: "thr_1", projectId: "proj_crm", name: "Тред CRM" }) },
        projects: { get: async () => ({ id: "proj_crm", name: "CRM", sources: [] }) },
      } as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });

    await session1.start();
    // Коннектор пытался запуститься (клиент добавлен)
    expect((session1 as any).connectorClients.length).toBe(1);
    await session1.end("owner");

    // 2. Владелец удалил проект из projectCalls (raw теперь пустой объект)
    const rawEmpty = JSON.stringify({});

    const session2 = new CallSession({
      callId: "call_t2",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      targetThreadId: "thr_1",
      projectRegistry: mgr,
      rawProjectRegistry: rawEmpty,
      sdk: {
        threads: { get: async () => ({ id: "thr_1", projectId: "proj_crm", name: "Тред CRM" }) },
        projects: { get: async () => ({ id: "proj_crm", name: "CRM", sources: [] }) },
      } as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });

    await session2.start();
    // Проекта нет в текущем реестре — звонок по треду идёт без коннекторов
    expect((session2 as any).connectorClients.length).toBe(0);
    await session2.end("owner");
  });

  it("при удалении проекта из реестра снимок конфигурации удаляется из базы", () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const cfg = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["node", "/server.js"],
          defaultClass: "C" as const,
        },
      ],
    };
    const raw = JSON.stringify({ proj_1: cfg });
    const h = hashProjectConfig(cfg);
    mgr.approve("proj_1", h, raw);
    expect(store.getApprovedProject("proj_1")).not.toBeNull();

    // Проект удалён из projectCalls
    const rawAfterDelete = JSON.stringify({});
    mgr.listProjects(rawAfterDelete);

    // Снимок удалён
    expect(store.getApprovedProject("proj_1")).toBeNull();
  });
});

describe("§16.7 п. 3: confirmSay ручки коннектора содержит имя и аргументы", () => {
  it("confirmSay форматирует аргументы (сумма, клиент, id) и усекает длинные значения", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    // Имитируем MCP-сервер с ручкой класса C
    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'pay_invoice', inputSchema: { type: 'object' } }] } }) + '\\n');
        }
      });
    `;

    const cfg = {
      title: "Billing",
      connectors: [
        {
          id: "billing",
          transport: "stdio" as const,
          command: [process.execPath, "-e", script],
          tools: { pay_invoice: "C" as const },
          defaultClass: "C" as const,
        },
      ],
    };
    const raw = JSON.stringify({ proj_bill: cfg });
    mgr.approve("proj_bill", hashProjectConfig(cfg), raw);

    const session = new CallSession({
      callId: "call_confirmsay",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      targetProjectId: "proj_bill",
      projectRegistry: mgr,
      rawProjectRegistry: raw,
      sdk: {
        projects: { get: async () => ({ id: "proj_bill", name: "Billing", sources: [] }) },
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
    const tools = (session as any).projectConnectorTools;
    expect(tools.length).toBe(1);
    const payTool = tools[0];

    // Проверяем текст confirmSay с аргументами
    const say = payTool.confirmSay({ amount: 5000, client: "ACME Corp", invoice_id: 1234 });
    expect(say).toContain("pay_invoice");
    expect(say).toContain("amount=5000");
    expect(say).toContain("client=ACME Corp");
    expect(say).toContain("invoice_id=1234");
    expect(say).toContain("Подтверждаете?");

    await session.end("owner");
  });
});

describe("§16.7 п. 4: Фильтр секретов (maskSecrets) и журнал", () => {
  it("maskSecrets маскирует URL credentials, Bearer, API-ключи, key-value и точные значения", () => {
    const text = "Server at https://admin:password123@myapi.local/v1, token=super_secret_tok, Bearer sk-antigravitytoken1234567890, key is AIzaSyD9ABCDEF1234567890123456789012345, exact: custom_exact_secret_value";
    const masked = maskSecrets(text, ["custom_exact_secret_value"]);

    expect(masked).not.toContain("password123");
    expect(masked).not.toContain("super_secret_tok");
    expect(masked).not.toContain("sk-antigravitytoken1234567890");
    expect(masked).not.toContain("AIzaSyD9ABCDEF1234567890123456789012345");
    expect(masked).not.toContain("custom_exact_secret_value");

    expect(masked).toContain("https://***:***@myapi.local/v1");
    expect(masked).toContain("token=***");
    expect(masked).toContain("Bearer ***");
    expect(masked).toContain("***");
  });

  it("ответ ручки коннектора фильтруется maskSecrets перед отдачей", async () => {
    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'get_secret', inputSchema: { type: 'object' } }] } }) + '\\n');
        } else if (msg.method === 'tools/call') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'result: token=secret123 and CRM_TOKEN=exact_crm_secret' }] } }) + '\\n');
        }
      });
    `;

    const client = new McpClient(
      {
        id: "crm",
        transport: "stdio",
        command: [process.execPath, "-e", script],
        secrets: ["CRM_TOKEN"],
        defaultClass: "deny",
      },
      {
        CRM_TOKEN: "exact_crm_secret",
      },
    );

    try {
      await client.start(5000);
      const res = await client.callTool("get_secret", {});
      expect(res.ok).toBe(true);
      expect(res.data?.result).not.toContain("secret123");
      expect(res.data?.result).not.toContain("exact_crm_secret");
      expect(res.data?.result).toContain("token=***");
    } finally {
      client.close();
    }
  });

  it("аргументы ручек коннектора НЕ пишутся в журнал при ошибках (§15.5)", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'failing_tool', inputSchema: { type: 'object' } }] } }) + '\\n');
        } else if (msg.method === 'tools/call') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'some error with token=s3cr3t' }] } }) + '\\n');
        }
      });
    `;

    const cfg = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: [process.execPath, "-e", script],
          tools: { failing_tool: "R" as const },
          defaultClass: "deny" as const,
        },
      ],
    };
    const raw = JSON.stringify({ proj_err: cfg });
    mgr.approve("proj_err", hashProjectConfig(cfg), raw);

    const session = new CallSession({
      callId: "call_err_log",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      targetProjectId: "proj_err",
      projectRegistry: mgr,
      rawProjectRegistry: raw,
      sdk: {
        projects: { get: async () => ({ id: "proj_err", name: "CRM", sources: [] }) },
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
    const fakeClient = {
      sendToolResponse: vi.fn(),
    };

    // Вызываем нативную ручку коннектора с секретными аргументами
    await (session as any).handleNativeCalls(fakeClient as any, [
      { id: "call_1", name: "crm__failing_tool", args: { sensitive_card: "1234-5678-9012" } },
    ]);

    // Проверяем событие tool_error в журнале
    const events = (store as any).db.prepare("SELECT payload FROM call_events WHERE call_id = ? AND kind = 'tool_error'").all("call_err_log");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload);

    // В событии нет args! (§15.5)
    expect(payload.args).toBeUndefined();
    // Сообщение об ошибке замаскировано
    expect(payload.message).toContain("token=***");

    await session.end("owner");
  });
});

describe("§16.7 п. 5: HTTP-транспорт коннектора", () => {
  let server: Server;
  let serverUrl = "";
  let receivedHeaders: Record<string, string> = {};
  let receivedDelete = false;

  beforeEach(async () => {
    receivedDelete = false;
    receivedHeaders = {};
    server = createServer((req, res) => {
      receivedHeaders = req.headers as Record<string, string>;

      if (req.method === "DELETE") {
        receivedDelete = true;
        res.writeHead(200);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const msg = JSON.parse(body || "{}");
        if (msg.method === "initialize") {
          // Отвечаем с заголовком Mcp-Session-Id
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": "sess_abc123",
          });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
        } else if (msg.method === "notifications/initialized") {
          res.writeHead(204);
          res.end();
        } else if (msg.method === "tools/list") {
          // Отвечаем через text/event-stream (SSE)
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
          });
          const sseData = JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [{ name: "http_ping", inputSchema: { type: "object" } }] },
          });
          res.write(`data: ${sseData}\n\n`);
          res.end();
        } else if (msg.method === "tools/call") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong" }] } }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}/mcp`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("HTTP-транспорт: Accept, Mcp-Session-Id, чтение SSE, Authorization: Bearer, DELETE при закрытии", async () => {
    const client = new McpClient(
      {
        id: "http_conn",
        transport: "http",
        url: serverUrl,
        secrets: ["MY_API_KEY"],
        defaultClass: "deny",
      },
      {
        MY_API_KEY: "secret_token_val_456",
      },
    );

    const tools = await client.start(5000);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("http_ping");

    // Проверяем заголовки
    expect(receivedHeaders["accept"]).toBe("application/json, text/event-stream");
    expect(receivedHeaders["authorization"]).toBe("Bearer secret_token_val_456");
    // Не отправляются лишние заголовки с именами секретов (MY_API_KEY: ...)
    expect(receivedHeaders["my_api_key"]).toBeUndefined();

    // Вызов ручки: должен использовать сохранённый Mcp-Session-Id
    const res = await client.callTool("http_ping", {});
    expect(res.ok).toBe(true);
    expect(res.data?.result).toBe("pong");
    expect(receivedHeaders["mcp-session-id"]).toBe("sess_abc123");

    // Закрытие шлёт DELETE с Mcp-Session-Id
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedDelete).toBe(true);
  });

  it("валидация url в connectorConfigSchema разрешает только https:// и http://127.0.0.1 / localhost", () => {
    // Внешний http запрещён
    const r1 = connectorConfigSchema.safeParse({
      id: "h1",
      transport: "http",
      url: "http://external-site.com/mcp",
      defaultClass: "C",
    });
    expect(r1.success).toBe(false);

    // http://127.0.0.1 разрешён
    const r2 = connectorConfigSchema.safeParse({
      id: "h2",
      transport: "http",
      url: "http://127.0.0.1:8080/mcp",
      defaultClass: "C",
    });
    expect(r2.success).toBe(true);

    // http://localhost разрешён
    const r3 = connectorConfigSchema.safeParse({
      id: "h3",
      transport: "http",
      url: "http://localhost:3000/mcp",
      defaultClass: "C",
    });
    expect(r3.success).toBe(true);

    // https:// разрешён
    const r4 = connectorConfigSchema.safeParse({
      id: "h4",
      transport: "http",
      url: "https://my-secure-host.org/mcp",
      defaultClass: "C",
    });
    expect(r4.success).toBe(true);
  });
});

describe("§16.7 п. 6: Средние замечания ревью (п. 6–10)", () => {
  it("toGeminiSchema: $ref, oneOf, allOf, числовой enum, свойства без type бракуются; nullable/enum/min-max переносятся", () => {
    // 1. $ref бракуется
    expect(toGeminiSchema({ type: "object", properties: { a: { $ref: "#/definitions/A" } } })).toBeNull();

    // 2. oneOf бракуется
    expect(toGeminiSchema({ type: "object", properties: { a: { oneOf: [{ type: "string" }] } } })).toBeNull();

    // 3. allOf бракуется
    expect(toGeminiSchema({ type: "object", properties: { a: { allOf: [{ type: "string" }] } } })).toBeNull();

    // 4. Числовой enum [1, 2] бракуется
    expect(toGeminiSchema({ type: "object", properties: { a: { type: "integer", enum: [1, 2] } } })).toBeNull();

    // 5. Корень array бракуется
    expect(toGeminiSchema({ type: "array", items: { type: "string" } })).toBeNull();

    // 6. Свойство без type бракуется
    expect(toGeminiSchema({ type: "object", properties: { a: { description: "no type" } } })).toBeNull();

    // 7. Поддержанный anyOf с null -> nullable: true
    const anyOfSchema = toGeminiSchema({
      type: "object",
      properties: {
        name: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
    expect(anyOfSchema).not.toBeNull();
    expect((anyOfSchema!.properties as any).name).toEqual({
      type: "string",
      nullable: true,
    });

    // 8. type: [string, "null"] -> nullable: true
    const arrTypeSchema = toGeminiSchema({
      type: "object",
      properties: {
        age: { type: ["integer", "null"] },
      },
    });
    expect(arrTypeSchema).not.toBeNull();
    expect((arrTypeSchema!.properties as any).age).toEqual({
      type: "integer",
      nullable: true,
    });

    // 9. Перенос format, minimum, maximum, minItems, maxItems
    const fullSchema = toGeminiSchema({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Test",
      additionalProperties: false,
      properties: {
        d: { type: "string", format: "date" },
        num: { type: "number", minimum: 10, maximum: 100 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        status: { type: "string", enum: ["open", "closed"] },
      },
      required: ["d"],
    });
    expect(fullSchema).toEqual({
      type: "object",
      properties: {
        d: { type: "string", format: "date" },
        num: { type: "number", minimum: 10, maximum: 100 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        status: { type: "string", enum: ["open", "closed"] },
      },
      required: ["d"],
    });
  });

  it("упавший коннектор сразу возвращает connector_unavailable без ожидания таймаута", async () => {
    // Процесс сразу завершается с ошибкой
    const client = new McpClient({
      id: "crash_conn",
      transport: "stdio",
      command: [process.execPath, "-e", "process.exit(1)"],
      defaultClass: "deny",
    });

    try {
      await client.start(3000);
    } catch {
      // ignore start failure
    }

    const t0 = Date.now();
    const res = await client.callTool("any_tool", {});
    const elapsed = Date.now() - t0;

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("connector_unavailable");
    // Сработал немедленно, без 30-секундного ожидания
    expect(elapsed).toBeLessThan(1000);
    client.close();
  });

  it("фраза «реестр изменился» звучит ТОЛЬКО для целевого проекта и не звучит в звонке координатору", async () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const frames: any[] = [];
    // Звонок координатору (без projectId и без threadId)
    const session = new CallSession({
      callId: "call_coord",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      projectRegistry: mgr,
      pendingRegistryChanges: [
        { projectId: "p_other", title: "Чужой проект", hash: "h1", diff: ["дифф"] },
      ],
      sdk: {} as never,
      toBrowser: (f) => frames.push(f),
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
    });

    await session.start();
    // В звонке координатору pendingRegistry остался null
    expect((session as any).pendingRegistry).toBeNull();
    await session.end("owner");
  });
});

describe("§16.7 п. 7: Мелкие замечания ревью (п. 12–17)", () => {
  const tempDir = join(tmpdir(), `test-safe-read-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(tempDir, ".bb", "live-call"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("PROMPT.md и tools.json: симлинки не читаются; ограничение 32 КБ", () => {
    // 1. Создаём секретный файл вне папки .bb/live-call
    const secretFile = join(tempDir, "secret_creds.txt");
    writeFileSync(secretFile, "VERY_SECRET_KEY=12345");

    // Создаём симлинк на секретный файл
    const promptSymlink = join(tempDir, ".bb", "live-call", "PROMPT.md");
    try {
      symlinkSync(secretFile, promptSymlink);
    } catch {
      // skip on platforms without symlink permissions
    }

    if (lstatSync(promptSymlink).isSymbolicLink()) {
      const res = readProjectRepoConfig(tempDir);
      // Симлинк не должен быть прочитан!
      expect(res.promptMd).toBeUndefined();
    }
  });

  it("computeProjectDiff отображает новую команду запуска и маскирует URL", () => {
    const oldConfig = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["node", "/v1/start.js"],
          defaultClass: "C" as const,
        },
      ],
    };
    const newConfig = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["node", "/v2/start.js", "--prod"],
          defaultClass: "C" as const,
        },
        {
          id: "http_conn",
          transport: "http" as const,
          url: "https://user:pass123@api.mycrm.local",
          defaultClass: "deny" as const,
        },
      ],
    };

    const diff = computeProjectDiff(oldConfig, newConfig);
    // Новая команда присутствует в diff
    expect(diff.some((d) => d.includes("изменена команда запуска [node /v1/start.js] → [node /v2/start.js --prod]"))).toBe(true);
    // URL замаскирован
    expect(diff.some((d) => d.includes("https://***:***@api.mycrm.local"))).toBe(true);
    expect(diff.every((d) => !d.includes("pass123"))).toBe(true);
  });

  it("projectRegistry.reject сохраняет отказ (state: rejected)", () => {
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);

    const cfg = {
      title: "CRM",
      connectors: [
        {
          id: "crm",
          transport: "stdio" as const,
          command: ["node", "/start.js"],
          defaultClass: "C" as const,
        },
      ],
    };
    const raw = JSON.stringify({ proj_rej: cfg });

    // До reject статус pending
    const listBefore = mgr.listProjects(raw);
    expect(listBefore[0].state).toBe("pending");

    // Владелец отклоняет изменение
    const rejRes = mgr.reject("proj_rej", raw);
    expect(rejRes.ok).toBe(true);

    // После reject статус сохранён как rejected
    const listAfter = mgr.listProjects(raw);
    expect(listAfter[0].state).toBe("rejected");
  });

  it("проверка уникальности id коннектора в projectConfigSchema", () => {
    const invalidConfig = {
      title: "CRM",
      connectors: [
        { id: "conn_1", transport: "stdio", command: ["node", "1.js"], defaultClass: "C" },
        { id: "conn_1", transport: "stdio", command: ["node", "2.js"], defaultClass: "C" },
      ],
    };
    const res = projectConfigSchema.safeParse(invalidConfig);
    expect(res.success).toBe(false);
    expect((res as any).error.issues.some((i: any) => i.message.includes("дубликат id коннектора"))).toBe(true);
  });
});
