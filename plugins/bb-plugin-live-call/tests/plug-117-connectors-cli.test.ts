/**
 * Тесты CLI-команды `bb call connectors` (§14.8, review PLUG-117).
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";
import { CallStore } from "../src/call-store.js";
import { hashProjectConfig, ProjectRegistryManager, type ProjectConfig } from "../src/project-registry.js";
import { McpClient, inspectConnectorTool, createMcpStderrCollector } from "../src/mcp-client.js";
import { maskSecrets } from "../src/secret-filter.js";
import { CallSession } from "../src/call-session.js";

describe("CLI bb call connectors (§14.8, review PLUG-117)", () => {
  let tmpDirs: string[] = [];

  function makeTmpDir(prefix = "plug117_") {
    const dir = join(tmpdir(), `${prefix}${Date.now()}_${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs = [];
  });

  function createMockPluginApi(initialSettings: Record<string, unknown> = {}) {
    const db = new Database(":memory:");
    let rpcHandlers: Record<string, (...args: any[]) => Promise<any>> = {};
    let cliDef: { commands: Array<{ name: string; usage: string }>; run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }> } | null = null;
    const wsHandlers = new Map<string, () => { onOpen: (s: any) => void; onMessage: (s: any, d: any) => Promise<void>; onClose: (s: any) => void }>();
    const eventHandlers = new Map<string, (payload: any) => void>();
    let settingsData = { ...initialSettings };

    const projectRoots = new Map<string, string>();

    const api = {
      settings: {
        define: vi.fn(() => ({
          get: vi.fn(async () => settingsData),
          experimental_set: vi.fn(async () => {}),
        })),
      },
      storage: {
        database: vi.fn(() => db),
      },
      server: {
        experimental_dataDir: tmpdir(),
        loopbackBaseUrl: "http://localhost:3000",
      },
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      sdk: {
        projects: {
          get: vi.fn(async ({ projectId }: { projectId: string }) => {
            const path = projectRoots.get(projectId) ?? "";
            return {
              id: projectId,
              name: `Project ${projectId}`,
              sources: path ? [{ path, isDefault: true }] : [],
            };
          }),
        },
        threads: {
          get: vi.fn(async ({ threadId }) => ({ id: threadId, title: "Thread Title" })),
          spawn: vi.fn(async () => ({ id: "thr_new" })),
          list: vi.fn(async () => []),
          listRunning: vi.fn(async () => []),
          markRead: vi.fn(async () => {}),
        },
        system: {
          config: vi.fn(async () => ({ primaryHostId: "host_local" })),
        },
      },
      onDispose: vi.fn(),
      http: {
        experimental_websocket: vi.fn((path: string, factory: any) => {
          wsHandlers.set(path, factory);
        }),
      },
      providers: {
        register: vi.fn(),
      },
      events: {
        on: vi.fn((ev: string, handler: any) => {
          eventHandlers.set(ev, handler);
        }),
      },
      rpc: {
        register: vi.fn((_contract: any, handlers: any) => {
          rpcHandlers = handlers;
        }),
      },
      cli: {
        register: vi.fn((def: any) => {
          cliDef = def;
        }),
      },
    };

    return {
      api,
      db,
      getCli: () => cliDef!,
      getRpc: () => rpcHandlers,
      getWs: () => wsHandlers,
      updateSettings: (patch: Record<string, unknown>) => {
        settingsData = { ...settingsData, ...patch };
      },
      setProjectRoot: (projectId: string, path: string) => {
        projectRoots.set(projectId, path);
      },
    };
  }

  describe("1. Регистрация команды и аргументы CLI", () => {
    it("bb call --help регистрирует команду connectors с описанием и usage", async () => {
      const mock = createMockPluginApi();
      await plugin(mock.api as never);

      const cli = mock.getCli();
      expect(cli).toBeDefined();
      const cmd = cli.commands.find((c) => c.name === "connectors");
      expect(cmd).toBeDefined();
      expect(cmd?.usage).toContain("bb call connectors [--project <projId>]");
    });

    it("неверные аргументы возвращают exitCode 2 и usage", async () => {
      const mock = createMockPluginApi();
      await plugin(mock.api as never);
      const cli = mock.getCli();

      const res1 = await cli.run(["connectors", "--unknown"]);
      expect(res1.exitCode).toBe(2);
      expect(res1.stdout).toContain("usage: bb call connectors");

      const res2 = await cli.run(["connectors", "--project"]);
      expect(res2.exitCode).toBe(2);
      expect(res2.stdout).toContain("usage: bb call connectors");

      const res3 = await cli.run(["connectors", "--project="]);
      expect(res3.exitCode).toBe(2);
      expect(res3.stdout).toContain("usage: bb call connectors");
    });

    it("пустой реестр возвращает сообщение об отсутствии проектов", async () => {
      const mock = createMockPluginApi({ projectCalls: "{}" });
      await plugin(mock.api as never);
      const cli = mock.getCli();

      const res = await cli.run(["connectors"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("нет проектов в реестре");
    });

    it("неизвестный projectId возвращает ошибку (exitCode 2), без отката на все проекты (§14.8, п. 4)", async () => {
      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({
          proj_crm: {
            title: "CRM",
            connectors: [],
          },
        }),
      });
      await plugin(mock.api as never);
      const cli = mock.getCli();

      const res = await cli.run(["connectors", "--project", "unknown_proj"]);
      expect(res.exitCode).toBe(2);
      expect(res.stdout).toContain("проект «unknown_proj» не найден в реестре");
      // Не должно быть вывода о proj_crm
      expect(res.stdout).not.toContain("CRM");
    });
  });

  describe("2. Поднятие коннектора только из подтверждённого снимка (уточнение 1)", () => {
    it("pending-проект без подтверждённого снимка: коннектор НЕ запускается", async () => {
      const markerDir = makeTmpDir("marker_");
      const markerFile = join(markerDir, "started.txt");

      // stdio коннектор, который пишет в файл при запуске
      const scriptPath = join(markerDir, "conn.mjs");
      writeFileSync(
        scriptPath,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerFile)}, "started");\nprocess.exit(0);\n`,
      );

      const cfg: ProjectConfig = {
        title: "Pending Project",
        connectors: [
          {
            id: "conn_1",
            transport: "stdio",
            command: [process.execPath, scriptPath],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_pending: cfg }),
      });
      await plugin(mock.api as never);
      const cli = mock.getCli();

      const res = await cli.run(["connectors", "--project", "proj_pending"]);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain("нет подтверждённого снимка (коннекторы не запускались)");
      // Процесс stdio не должен был запускаться!
      expect(() => rmSync(markerFile)).toThrow(); // файла нет!
    });

    it("pending-проект с прежним confirmed-снимком: запускается прежний снимок с пометкой в выводе", async () => {
      const markerDir = makeTmpDir("old_snap_");
      const oldServerPath = join(markerDir, "old-server.mjs");
      writeFileSync(
        oldServerPath,
        `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
  } else if (req.method === "notifications/initialized") {
  } else if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "old_tool", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
  }
});\n`,
      );

      const oldConfig: ProjectConfig = {
        title: "CRM Old",
        connectors: [
          {
            id: "conn_old",
            transport: "stdio",
            command: [process.execPath, oldServerPath],
            defaultClass: "C",
          },
        ],
      };

      const newConfig: ProjectConfig = {
        title: "CRM New (Pending)",
        connectors: [
          {
            id: "conn_new",
            transport: "stdio",
            command: [process.execPath, "/non/existent/never/run.mjs"],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_1: newConfig }),
      });
      await plugin(mock.api as never);

      // Вносим старый подтверждённый снимок напрямую в store
      const store = new CallStore(mock.db);
      const oldHash = hashProjectConfig(oldConfig);
      store.setApprovedProject("proj_1", oldHash, JSON.stringify(oldConfig));

      const cli = mock.getCli();
      const res = await cli.run(["connectors", "--project", "proj_1"]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("состояние реестра: pending");
      expect(res.stdout).toContain("используется прежний подтверждённый снимок (текущая запись отличается: pending)");
      // Поднялся коннектор из старого снимка:
      expect(res.stdout).toContain("коннектор: conn_old");
      expect(res.stdout).toContain("old_tool: C");
      // Новый неподтверждённый коннектор не запускался:
      expect(res.stdout).not.toContain("conn_new");
    });

    it("rejected-проект: отклонённая конфигурация не запускается, поднимается прежний снимок если есть", async () => {
      const dir = makeTmpDir("rej_test_");
      const approvedScript = join(dir, "approved.mjs");
      writeFileSync(
        approvedScript,
        `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
  } else if (req.method === "notifications/initialized") {
  } else if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "approved_tool", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
  }
});\n`,
      );

      const approvedCfg: ProjectConfig = {
        title: "Approved Version",
        connectors: [
          {
            id: "conn_appr",
            transport: "stdio",
            command: [process.execPath, approvedScript],
            defaultClass: "C",
          },
        ],
      };

      const rejectedCfg: ProjectConfig = {
        title: "Rejected Version",
        connectors: [
          {
            id: "conn_rej",
            transport: "stdio",
            command: [process.execPath, "/do/not/run/rej.mjs"],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_rej: rejectedCfg }),
      });
      await plugin(mock.api as never);

      const store = new CallStore(mock.db);
      store.setApprovedProject("proj_rej", hashProjectConfig(approvedCfg), JSON.stringify(approvedCfg));
      store.setRejectedProject("proj_rej", hashProjectConfig(rejectedCfg));

      const cli = mock.getCli();
      const res = await cli.run(["connectors", "--project", "proj_rej"]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("состояние реестра: rejected");
      expect(res.stdout).toContain("используется прежний подтверждённый снимок (текущая запись отличается: rejected)");
      expect(res.stdout).toContain("коннектор: conn_appr");
      expect(res.stdout).toContain("approved_tool: C");
      expect(res.stdout).not.toContain("conn_rej");
    });

    it("invalid-проект без снимка: коннекторы не запускаются, честный статус ошибки", async () => {
      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({
          proj_inv: {
            title: "Bad Config",
            connectors: [
              {
                id: "bad_conn",
                transport: "stdio",
                command: ["relative/path/node"], // не абсолютный путь -> Zod error!
                defaultClass: "C",
              },
            ],
          },
        }),
      });
      await plugin(mock.api as never);

      const cli = mock.getCli();
      const res = await cli.run(["connectors", "--project", "proj_inv"]);

      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain("состояние реестра: invalid");
      expect(res.stdout).toContain("нет подтверждённого снимка (коннекторы не запускались)");
      expect(res.stdout).toContain("ошибка:");
    });
  });

  describe("3. Только чтение, без мутаций хранилища (уточнение 2)", () => {
    it("содержимое реестра и сохранённых снимков до и после команды идентично (удалённые проекты не стираются)", async () => {
      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({
          proj_active: {
            title: "Active Project",
            connectors: [],
          },
        }),
      });
      await plugin(mock.api as never);

      const store = new CallStore(mock.db);
      // Сохраняем одобренный снимок для отсутствующего проекта proj_removed
      store.setApprovedProject("proj_removed", "hash_removed", JSON.stringify({ title: "Removed", connectors: [] }));
      store.setRejectedProject("proj_rejected_other", "hash_rej");

      const approvedBefore = store.listApprovedProjectIds();
      const rejectedBefore = store.listRejectedProjectIds();
      expect(approvedBefore).toContain("proj_removed");
      expect(rejectedBefore).toContain("proj_rejected_other");

      const cli = mock.getCli();
      await cli.run(["connectors"]);

      const approvedAfter = store.listApprovedProjectIds();
      const rejectedAfter = store.listRejectedProjectIds();

      // Снимки отсутствующих проектов НЕ были удалены!
      expect(approvedAfter).toEqual(approvedBefore);
      expect(rejectedAfter).toEqual(rejectedBefore);
    });
  });

  describe("4. Взаимное исключение со звонком (уточнение 3)", () => {
    it("если звонок активен, в состоянии starting или reattach — вывод «идёт звонок, повторите позже» (exitCode 1)", async () => {
      const mock = createMockPluginApi({
        geminiKeys: "fake_key_1\nfake_key_2",
        projectCalls: JSON.stringify({
          proj_1: {
            title: "Proj 1",
            connectors: [],
          },
        }),
      });
      await plugin(mock.api as never);
      const cli = mock.getCli();

      // 1. Получаем токен
      const rpc = mock.getRpc();
      const { token } = await rpc.callToken();

      // 2. Симулируем WebSocket звонок
      const wsFactory = mock.getWs().get("/call")!;
      const client = wsFactory();

      let closedCode: number | null = null;
      let sentMessages: string[] = [];
      const mockSock = {
        send: (d: string) => sentMessages.push(d),
        close: (code: number) => {
          closedCode = code;
        },
      };

      client.onOpen(mockSock);
      // Шлём hello -> звонок стартует
      void client.onMessage(mockSock, JSON.stringify({ type: "hello", token, protocol: 1 }));

      // Пока звонок активен или стартует:
      const res = await cli.run(["connectors"]);
      expect(res.exitCode).toBe(1);
      expect(res.stdout.trim()).toBe("идёт звонок, повторите позже");
    });

    it("параллельный запуск самой диагностики возвращает «идёт звонок, повторите позже»", async () => {
      const markerDir = makeTmpDir("slow_conn_");
      const slowServer = join(markerDir, "slow.mjs");

      // Сервер, который отвечает на initialize с небольшой задержкой (150 мс)
      writeFileSync(
        slowServer,
        `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
    }, 150);
  } else if (req.method === "notifications/initialized") {
  } else if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [] } }) + "\\n");
  }
});\n`,
      );

      const cfg: ProjectConfig = {
        title: "Slow Project",
        connectors: [
          {
            id: "slow_conn",
            transport: "stdio",
            command: [process.execPath, slowServer],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_slow: cfg }),
      });
      await plugin(mock.api as never);

      const store = new CallStore(mock.db);
      store.setApprovedProject("proj_slow", hashProjectConfig(cfg), JSON.stringify(cfg));

      const cli = mock.getCli();

      // Запускаем диагностику 1 (асинхронно)
      const p1 = cli.run(["connectors"]);
      // Небольшая пауза, чтобы первый успел захватить эксклюзив
      await new Promise((r) => setTimeout(r, 20));

      // Запуск 2 во время работы 1
      const p2 = await cli.run(["connectors"]);
      expect(p2.exitCode).toBe(1);
      expect(p2.stdout.trim()).toBe("идёт звонок, повторите позже");

      const r1 = await p1;
      expect(r1.exitCode).toBe(0);
      expect(r1.stdout).toContain("статус: ok");
    });
  });

  describe("5. Расчёт классов и причины пропуска (§14.3, §14.4, §15.3, уточнение 4)", () => {
    it("правила имён, конфликты, схемы и строгий класс из tools.json", async () => {
      const projDir = makeTmpDir("proj_repo_");
      const liveCallDir = join(projDir, ".bb", "live-call");
      mkdirSync(liveCallDir, { recursive: true });

      // tools.json ужесточает класс: read_tool R -> C
      writeFileSync(
        join(liveCallDir, "tools.json"),
        JSON.stringify({
          read_tool: "C",
        }),
      );

      const connScript = join(projDir, "tools-server.mjs");
      writeFileSync(
        connScript,
        `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
  } else if (req.method === "notifications/initialized") {
  } else if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          { name: "read_tool", inputSchema: { type: "object", properties: {} } },
          { name: "forbidden_tool", inputSchema: { type: "object", properties: {} } },
          { name: "bad-name-tool", inputSchema: { type: "object", properties: {} } },
          { name: "complex_tool", inputSchema: { type: "object", properties: { x: { oneOf: [{ type: "string" }, { type: "number" }] } } } },
          { name: "dup_tool", inputSchema: { type: "object", properties: {} } },
          { name: "dup_tool", inputSchema: { type: "object", properties: {} } },
        ]
      }
    }) + "\\n");
  }
});\n`,
      );

      const cfg: ProjectConfig = {
        title: "Test Tools Calc",
        connectors: [
          {
            id: "conn_1",
            transport: "stdio",
            command: [process.execPath, connScript],
            tools: {
              read_tool: "R",
              forbidden_tool: "deny",
            },
            defaultClass: "P",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_test: cfg }),
      });
      mock.setProjectRoot("proj_test", projDir);
      await plugin(mock.api as never);

      const store = new CallStore(mock.db);
      store.setApprovedProject("proj_test", hashProjectConfig(cfg), JSON.stringify(cfg));

      const cli = mock.getCli();
      const res = await cli.run(["connectors", "--project", "proj_test"]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("read_tool: C"); // ужесточено из tools.json!
      expect(res.stdout).toContain("forbidden_tool: deny");
      expect(res.stdout).toContain("bad-name-tool: invalid_name");
      expect(res.stdout).toContain("complex_tool: schema_unsupported");
      expect(res.stdout).toContain("dup_tool: P"); // первый прошёл с defaultClass P
      expect(res.stdout).toContain("dup_tool: конфликт имени (name_collision)"); // дубликат отклонён
    });
  });

  describe("6. Маскирование всех каналов вывода (уточнение 5, §14.6)", () => {
    it("секрет в метаданных ручки, ошибке и неверный класс — сырые значения секрета не попадают в вывод", async () => {
      const SECRET_TOKEN = "SUPER_SECRET_TOKEN_XYZ_123456";
      const SECRET_PASSWORD = "my_top_secret_pass_987654";

      const dir = makeTmpDir("leak_test_");
      const leakServer = join(dir, "leak-server.mjs");

      // Сервер возвращает секрет в имени/описании ручки и падает с паролем в ошибке
      writeFileSync(
        leakServer,
        `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
  } else if (req.method === "notifications/initialized") {
  } else if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          { name: "tool_${SECRET_TOKEN}", description: "with secret ${SECRET_TOKEN}", inputSchema: { type: "object", properties: {} } },
          { name: "failing_tool", inputSchema: null }
        ]
      }
    }) + "\\n");
  }
});\n`,
      );

      const cfg: ProjectConfig = {
        title: "Security Test",
        connectors: [
          {
            id: "conn_sec",
            transport: "stdio",
            command: [process.execPath, leakServer],
            tools: {
              // Намеренно невалидный класс (в обход Zod через БД)
              failing_tool: "SECRET_CLASS_INJECT" as any,
            },
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectSecrets: JSON.stringify({
          MY_SEC_TOKEN: SECRET_TOKEN,
          MY_PASS: SECRET_PASSWORD,
        }),
        projectCalls: JSON.stringify({ proj_sec: cfg }),
      });
      await plugin(mock.api as never);

      const store = new CallStore(mock.db);
      store.setApprovedProject("proj_sec", hashProjectConfig(cfg), JSON.stringify(cfg));

      const cli = mock.getCli();
      const res = await cli.run(["connectors", "--project", "proj_sec"]);

      // 1. Секрет из имени/описания замаскирован
      expect(res.stdout).not.toContain(SECRET_TOKEN);
      expect(res.stdout).toContain("***");

      // 2. Неверный класс не напечатан сырым
      expect(res.stdout).not.toContain("SECRET_CLASS_INJECT");
      expect(res.stdout).toContain("неверный класс");
    });

    it("секрет в ошибке (URL credentials, token=) замаскирован до логирования и вывода", async () => {
      const RAW_PASS = "very_secret_pass_12345";
      const cfg: ProjectConfig = {
        title: "Error Leak Test",
        connectors: [
          {
            id: "conn_err",
            transport: "http",
            url: `https://user:${RAW_PASS}@127.0.0.1:59999/mcp`,
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectSecrets: JSON.stringify({ DB_PASS: RAW_PASS }),
        projectCalls: JSON.stringify({ proj_err: cfg }),
      });
      await plugin(mock.api as never);

      const store = new CallStore(mock.db);
      store.setApprovedProject("proj_err", hashProjectConfig(cfg), JSON.stringify(cfg));

      const cli = mock.getCli();
      const res = await cli.run(["connectors", "--project", "proj_err"]);

      expect(res.exitCode).toBe(1);
      expect(res.stdout).not.toContain(RAW_PASS);
      expect(res.stdout).toContain("***");
    });

    it("диагностика не вызывает tools/call и не печатает токены звонка", async () => {
      const markerDir = makeTmpDir("no_call_");
      const calledMarker = join(markerDir, "tool_called.txt");

      const serverScript = join(markerDir, "server.mjs");
      writeFileSync(
        serverScript,
        `import { writeFileSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
  } else if (req.method === "notifications/initialized") {
  } else if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "my_tool", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
  } else if (req.method === "tools/call") {
    writeFileSync(${JSON.stringify(calledMarker)}, "CALLED!");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
  }
});\n`,
      );

      const cfg: ProjectConfig = {
        title: "No Call Project",
        connectors: [
          {
            id: "conn_nocall",
            transport: "stdio",
            command: [process.execPath, serverScript],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_nocall: cfg }),
      });
      await plugin(mock.api as never);

      const store = new CallStore(mock.db);
      store.setApprovedProject("proj_nocall", hashProjectConfig(cfg), JSON.stringify(cfg));

      const rpc = mock.getRpc();
      const { token: secretCallToken } = await rpc.callToken();

      const cli = mock.getCli();
      const res = await cli.run(["connectors", "--project", "proj_nocall"]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("my_tool: C");

      // tools/call никогда не вызывался!
      expect(() => rmSync(calledMarker)).toThrow(); // файла нет!

      // Токен звонка нигде не выводится!
      expect(res.stdout).not.toContain(secretCallToken);
    });
  });

  describe("7. E2E с тестовым коннектором research/fixtures/test-connector.mjs", () => {
    it("поднимает реальный тестовый коннектор, проверяет tools и закрывает процесс", async () => {
      const fixturePath = resolve(__dirname, "../research/fixtures/test-connector.mjs");

      const cfg: ProjectConfig = {
        title: "Test Connector Project",
        connectors: [
          {
            id: "test_mcp",
            transport: "stdio",
            command: [process.execPath, fixturePath],
            tools: {
              get_info: "R",
              set_status: "C",
              forbidden_action: "deny",
            },
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_test_fixture: cfg }),
      });
      await plugin(mock.api as never);

      const store = new CallStore(mock.db);
      store.setApprovedProject("proj_test_fixture", hashProjectConfig(cfg), JSON.stringify(cfg));

      const cli = mock.getCli();
      const res = await cli.run(["connectors", "--project", "proj_test_fixture"]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("проект: proj_test_fixture");
      expect(res.stdout).toContain("состояние реестра: approved");
      expect(res.stdout).toContain("коннектор: test_mcp");
      expect(res.stdout).toContain("транспорт: stdio: ");
      expect(res.stdout).toContain("статус: ok");
      expect(res.stdout).toContain("get_info: R");
      expect(res.stdout).toContain("set_status: C");
      expect(res.stdout).toContain("forbidden_action: deny");
    });
  });

  describe("8. Регрессионные тесты по замечаниям ревью Codex (PLUG-117)", () => {
    it("P1-1: удерживает эксклюзив до полного завершения непослушного stdio-процесса", async () => {
      const d = makeTmpDir("plug117_stdio_cleanup_");
      const pidPath = join(d, "pid.txt");
      const fixturePath = join(d, "unruly.mjs");
      writeFileSync(
        fixturePath,
        `import readline from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") process.stdout.write(JSON.stringify({ id: r.id, result: { protocolVersion: "2025-06-18" } }) + "\\n");
  if (r.method === "tools/list") process.stdout.write(JSON.stringify({ id: r.id, result: { tools: [{ name: "unruly_tool", inputSchema: { type: "object" } }] } }) + "\\n");
});`,
      );

      const cfg: ProjectConfig = {
        title: "Unruly Project",
        connectors: [
          {
            id: "unruly_conn",
            transport: "stdio",
            command: [process.execPath, fixturePath],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_unruly: cfg }),
      });
      await plugin(mock.api as never);
      new CallStore(mock.db).setApprovedProject("proj_unruly", hashProjectConfig(cfg), JSON.stringify(cfg));

      const cli = mock.getCli();
      const res = await cli.run(["connectors"]);
      expect(res.exitCode).toBe(0);

      const pid = Number(readFileSync(pidPath, "utf-8"));
      // Процесс должен быть уже мёртв после завершения команды!
      expect(() => process.kill(pid, 0)).toThrow();

      // Второй запуск успешен и не порождает конфликтов/живых предков
      const second = await cli.run(["connectors"]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("статус: ok");
      const secondPid = Number(readFileSync(pidPath, "utf-8"));
      expect(secondPid).not.toBe(pid);
      expect(() => process.kill(secondPid, 0)).toThrow();
    });

    it("P1-1: поздний initialize после HTTP-таймаута прерывается и получает DELETE", async () => {
      vi.useFakeTimers();
      try {
        let complete!: (r: Response) => void;
        const initializeResponse = new Promise<Response>((r) => (complete = r));
        const fetchMock = vi.fn(async (_url: unknown, opts: any) => {
          if (opts.method === "POST" && JSON.parse(opts.body).method === "initialize") return initializeResponse;
          return new Response("{}", { status: 200 });
        });
        vi.stubGlobal("fetch", fetchMock);

        const cfg: ProjectConfig = {
          title: "HTTP Timeout Project",
          connectors: [
            {
              id: "http_conn",
              transport: "http",
              url: "http://127.0.0.1:12345/mcp",
              defaultClass: "C",
            },
          ],
        };

        const mock = createMockPluginApi({
          projectCalls: JSON.stringify({ proj_http: cfg }),
        });
        await plugin(mock.api as never);
        new CallStore(mock.db).setApprovedProject("proj_http", hashProjectConfig(cfg), JSON.stringify(cfg));

        const running = mock.getCli().run(["connectors"]);
        for (let i = 0; i < 20 && fetchMock.mock.calls.length === 0; i++) await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Таймаут коннектора (10 с)
        await vi.advanceTimersByTimeAsync(10_001);
        const res = await running;
        expect(res.exitCode).toBe(1);

        // Сигнал fetch должен быть aborted после таймаута коннектора
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);

        // Поздний ответ от сервера с Mcp-Session-Id
        complete(
          new Response(JSON.stringify({ id: 1, result: {} }), {
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "fake_late_session_id",
            },
          }),
        );
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // Должен быть отправлен DELETE-запрос для очистки сессии
        const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts.method === "DELETE");
        expect(deleteCalls.length).toBeGreaterThan(0);
        expect(deleteCalls[0][1].headers["Mcp-Session-Id"]).toBe("fake_late_session_id");
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });

    it("P1-2: неизвестный аргумент маскирует настроенный секрет", async () => {
      const secret = "review_fake_secret_987654321";
      const mock = createMockPluginApi({
        projectSecrets: JSON.stringify({ MY_SECRET: secret }),
      });
      await plugin(mock.api as never);

      const res = await mock.getCli().run(["connectors", "--bad=" + secret]);
      expect(res.exitCode).toBe(2);
      expect(res.stdout).not.toContain(secret);
      expect(res.stdout).toContain("***");
    });

    it("P1-2: stderr маскирует секрет до обрезки границы длины", async () => {
      const secret = "review_fake_stderr_secret_12345";
      const d = makeTmpDir("plug117_stderr_");
      const fixturePath = join(d, "stderr_fixture.mjs");
      writeFileSync(
        fixturePath,
        `import readline from "node:readline";
process.stderr.write("y".repeat(1990) + ${JSON.stringify(secret)} + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") process.stdout.write(JSON.stringify({ id: r.id, result: { protocolVersion: "2025-06-18" } }) + "\\n");
  if (r.method === "tools/list") process.stdout.write(JSON.stringify({ id: r.id, result: { tools: [{ name: "tool1", inputSchema: { type: "object" } }] } }) + "\\n");
});`,
      );

      const cfg: ProjectConfig = {
        title: "Stderr Project",
        connectors: [
          {
            id: "conn_stderr",
            transport: "stdio",
            command: [process.execPath, fixturePath],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_stderr: cfg }),
        projectSecrets: JSON.stringify({ SECRET_KEY: secret }),
      });
      await plugin(mock.api as never);
      new CallStore(mock.db).setApprovedProject("proj_stderr", hashProjectConfig(cfg), JSON.stringify(cfg));

      const cli = mock.getCli();
      await cli.run(["connectors"]);

      const logs = mock.api.log.warn.mock.calls.flat().join("\n");
      expect(logs).not.toContain(secret.slice(0, 10));
      expect(logs).not.toContain(secret);
    });

    it("P2-1: --project изолирует валидацию и не выводит ошибки других проектов", async () => {
      const validCfg: ProjectConfig = {
        title: "Selected Valid Project",
        connectors: [],
      };
      const invalidCfg = {
        title: "Other Invalid Project",
        connectors: [
          {
            id: "bad_connector_id_invalid",
            transport: "stdio",
            command: ["relative-command-not-allowed"],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({
          proj_selected: validCfg,
          proj_other: invalidCfg,
        }),
      });
      await plugin(mock.api as never);

      const res = await mock.getCli().run(["connectors", "--project", "proj_selected"]);
      expect(res.stdout).not.toContain("proj_other");
      expect(res.stdout).not.toContain("состояние реестра: invalid");
      expect(res.stdout).toContain("проект: proj_selected");
    });

    it("P2-2: неверный класс в реестре даёт invalid_class и не превращается в P через tools.json", async () => {
      // 1. Проверка чистой функции inspectConnectorTool
      const inspected = inspectConnectorTool(
        { name: "test_tool", inputSchema: { type: "object" } },
        { id: "test_conn", transport: "stdio", command: ["/bin/echo"], defaultClass: "bogus_class" as never },
        { tools: { test_tool: "P" } },
        new Set(),
      );
      expect(inspected.status).toBe("skipped");
      expect(inspected.skipReason).toBe("invalid_class");

      // 2. Проверка вывода CLI команды connectors
      const d = makeTmpDir("plug117_inv_class_");
      mkdirSync(join(d, ".bb", "live-call"), { recursive: true });
      writeFileSync(join(d, ".bb", "live-call", "tools.json"), JSON.stringify({ my_action: "P" }));

      const fixturePath = join(d, "fixture.mjs");
      writeFileSync(
        fixturePath,
        `import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") process.stdout.write(JSON.stringify({ id: r.id, result: {} }) + "\\n");
  if (r.method === "tools/list") process.stdout.write(JSON.stringify({ id: r.id, result: { tools: [{ name: "my_action", inputSchema: { type: "object" } }] } }) + "\\n");
});`,
      );

      const cfg: ProjectConfig = {
        title: "Invalid Class Project",
        connectors: [
          {
            id: "conn_bad_class",
            transport: "stdio",
            command: [process.execPath, fixturePath],
            defaultClass: "C",
            tools: { my_action: "bogus_class" as never },
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_bad_class: cfg }),
      });
      mock.setProjectRoot("proj_bad_class", d);
      await plugin(mock.api as never);
      new CallStore(mock.db).setApprovedProject("proj_bad_class", hashProjectConfig(cfg), JSON.stringify(cfg));

      const res = await mock.getCli().run(["connectors"]);
      expect(res.stdout).not.toContain("my_action: P");
      expect(res.stdout).toContain("my_action: неверный класс (invalid_class)");
    });

    it("P2-3: коннекторы без подтверждённого снимка перечисляются со статусом 'нет подтверждённого снимка'", async () => {
      const cfg: ProjectConfig = {
        title: "Unapproved Project",
        connectors: [
          {
            id: "conn_unapproved_1",
            transport: "stdio",
            command: ["/nonexistent/executable"],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_pending: cfg }),
      });
      await plugin(mock.api as never);

      const res = await mock.getCli().run(["connectors"]);
      expect(res.stdout).toContain("нет подтверждённого снимка");
      expect(res.stdout).toContain("коннектор: conn_unapproved_1");
      expect(res.stdout).toContain("статус: нет подтверждённого снимка (не запускался)");
      expect(res.stdout).toContain("ручки: (не запускался)");
    });

    it("read-only: сериализованные байты SQLite и настройки полностью идентичны до и после", async () => {
      const d = makeTmpDir("plug117_readonly_");
      const fixturePath = join(d, "fixture.mjs");
      writeFileSync(
        fixturePath,
        `import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") process.stdout.write(JSON.stringify({ id: r.id, result: { protocolVersion: "2025-06-18" } }) + "\\n");
  if (r.method === "tools/list") process.stdout.write(JSON.stringify({ id: r.id, result: { tools: [{ name: "t", inputSchema: { type: "object" } }] } }) + "\\n");
});`,
      );

      const cfg: ProjectConfig = {
        title: "Readonly Project",
        connectors: [
          {
            id: "conn_ro",
            transport: "stdio",
            command: [process.execPath, fixturePath],
            defaultClass: "C",
          },
        ],
      };

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_ro: cfg }),
      });
      await plugin(mock.api as never);

      const store = new CallStore(mock.db);
      store.setApprovedProject("proj_ro", hashProjectConfig(cfg), JSON.stringify(cfg));
      // Снимки удалённых проектов
      store.setApprovedProject("proj_orphan", "fake_hash_1", JSON.stringify({ title: "Orphan", connectors: [] }));
      store.setRejectedProject("proj_other_orphan", "fake_hash_2");

      const dbBefore = mock.db.serialize();
      const settingsBefore = JSON.stringify(await mock.api.settings.define().get());

      await mock.getCli().run(["connectors"]);

      expect(mock.db.serialize()).toEqual(dbBefore);
      expect(JSON.stringify(await mock.api.settings.define().get())).toEqual(settingsBefore);
    });

    it("P1-2 (Round-2): stderr не разрезает и не раскрывает точный секрет без переноса строки (no newline)", async () => {
      const secret = "review_fake_value_987654321";
      const d = makeTmpDir("plug117_stderr_r2_");
      const path = join(d, "stderr.mjs");
      writeFileSync(
        path,
        `import readline from "node:readline";
process.stderr.write("x".repeat(100) + ${JSON.stringify(secret)} + "y".repeat(50));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") process.stdout.write(JSON.stringify({ id: r.id, result: {} }) + "\\n");
  if (r.method === "tools/list") process.stdout.write(JSON.stringify({ id: r.id, result: { tools: [] } }) + "\\n");
});`,
      );
      const cfg: ProjectConfig = {
        title: "Example",
        connectors: [{ id: "example", transport: "stdio", command: [process.execPath, path], defaultClass: "C" }],
      };
      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ project_example: cfg }),
        projectSecrets: JSON.stringify({ EXAMPLE: secret }),
      });
      await plugin(mock.api as never);
      new CallStore(mock.db).setApprovedProject("project_example", hashProjectConfig(cfg), JSON.stringify(cfg));
      await mock.getCli().run(["connectors"]);
      const logs = (mock.api.log.warn as any).mock.calls.flat().join("\n");
      expect(logs).not.toContain(secret.slice(0, 10));
      expect(logs).not.toContain(secret.slice(10));
      expect(logs).not.toContain(secret);
    });

    it("P1-1 (Round-2): CallSession ended ожидает завершение очистки, уже начатой по таймауту start()", async () => {
      const d = makeTmpDir("plug117_timeout_cleanup_");
      const path = join(d, "hang.mjs");
      const pidPath = join(d, "pid");
      writeFileSync(
        path,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
process.stdin.resume();`,
      );
      const client = new McpClient({
        id: "example",
        transport: "stdio",
        command: [process.execPath, path],
        defaultClass: "C",
      });
      const starting = client.start(200).catch((e) => e);
      try {
        await vi.waitFor(() => expect((client as any).closed).toBe(true), { timeout: 2000 });
        const pid = Number(readFileSync(pidPath, "utf8"));
        const alive = (p: number) => {
          try {
            process.kill(p, 0);
            return true;
          } catch {
            return false;
          }
        };
        expect(alive(pid)).toBe(true);
        const store = new CallStore(new Database(":memory:"));
        const session = new CallSession({
          callId: "call_review",
          keys: ["fake_review_key"],
          voice: "Algenib",
          languageCode: "ru-RU",
          thinkingLevel: "LOW",
          mode: "normal",
          routerInput: "text",
          maxCallMinutes: 60,
          store,
          sdk: {} as never,
          toBrowser: () => {},
          sendBrowserAudio: () => {},
          spawnCallThread: async () => null,
          advanceCallThread: async () => {},
          sayCallThread: async () => {},
          endCallThread: async () => {},
          wsFactory: () => {
            throw new Error("No network in review");
          },
        } as never);
        (session as any).connectorClients = [client];
        let aliveAtEnded: boolean | undefined;
        session.on("ended", () => {
          aliveAtEnded = alive(pid);
        });
        await session.end("owner");
        expect(aliveAtEnded).toBe(false);
      } finally {
        await starting;
        await client.close();
      }
    }, 10000);

    it("P1-1 (Round-2): CLI connectors остаётся занятым (идёт звонок, повторите позже) пока таймаутный коннектор завершающегося звонка ещё закрывается", async () => {
      const d = makeTmpDir("plug117_r2_server_");
      let hello: Promise<void> | undefined;
      const realStart = McpClient.prototype.start;
      let client: McpClient | undefined;
      vi.spyOn(McpClient.prototype, "start").mockImplementation(function (this: McpClient) {
        client = this;
        return realStart.call(this, 200);
      });
      try {
        const path = join(d, "hang.mjs");
        const pidPath = join(d, "pid");
        writeFileSync(
          path,
          `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
process.stdin.resume();`,
        );
        const cfg: ProjectConfig = {
          title: "Example",
          connectors: [{ id: "example", transport: "stdio", command: [process.execPath, path], defaultClass: "C" }],
        };
        const empty: ProjectConfig = { title: "Empty", connectors: [] };
        const mock = createMockPluginApi({
          geminiKeys: "fake_review_key",
          projectCalls: JSON.stringify({ project_example: cfg, project_empty: empty }),
        });
        await plugin(mock.api as never);
        const store = new CallStore(mock.db);
        store.setApprovedProject("project_example", hashProjectConfig(cfg), JSON.stringify(cfg));
        store.setApprovedProject("project_empty", hashProjectConfig(empty), JSON.stringify(empty));
        const ws = mock.getWs().get("/call")!();
        const sock = { send: vi.fn(), close: vi.fn() };
        const { token } = await mock.getRpc().callToken();
        hello = ws.onMessage(
          sock,
          JSON.stringify({ type: "hello", protocol: 1, token, projectId: "project_example", mode: "normal" }),
        );
        await vi.waitFor(() => expect(client && (client as any).closed).toBe(true), { timeout: 2000 });
        const pid = Number(readFileSync(pidPath, "utf8"));
        expect(() => process.kill(pid, 0)).not.toThrow();
        await ws.onMessage(sock, JSON.stringify({ type: "end" }));
        expect(() => process.kill(pid, 0)).not.toThrow();
        const res = await mock.getCli().run(["connectors", "--project", "project_empty"]);
        expect(res.stdout).toContain("идёт звонок, повторите позже");
        expect(res.exitCode).toBe(1);
      } finally {
        await hello;
        await client?.close();
        vi.restoreAllMocks();
      }
    }, 10000);

    it("P1-2 (Round-3/4): маскирует точный секрет на стыке чанков при флаше 2000 символов без переноса строки", async () => {
      const secret = "review_fake_value_987654321";
      const d = makeTmpDir("plug117_r3_stderr_");
      const path = join(d, "split.mjs");
      writeFileSync(
        path,
        `import readline from "node:readline";
const secret = ${JSON.stringify(secret)};
process.stderr.write("x".repeat(1990) + secret.slice(0, 10));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") process.stdout.write(JSON.stringify({ id: r.id, result: {} }) + "\\n");
  if (r.method === "tools/list") setTimeout(() => {
    process.stderr.write(secret.slice(10) + "\\n");
    process.stdout.write(JSON.stringify({ id: r.id, result: { tools: [] } }) + "\\n");
  }, 100);
});`,
      );
      const cfg: ProjectConfig = {
        title: "Example",
        connectors: [{ id: "example", transport: "stdio", command: [process.execPath, path], defaultClass: "C" }],
      };
      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ project_example: cfg }),
        projectSecrets: JSON.stringify({ EXAMPLE: secret }),
      });
      await plugin(mock.api as never);
      new CallStore(mock.db).setApprovedProject("project_example", hashProjectConfig(cfg), JSON.stringify(cfg));
      const res = await mock.getCli().run(["connectors"]);
      expect(res.exitCode).toBe(0);
      const logs = (mock.api.log.warn as any).mock.calls.flat().join("\n");
      expect(logs).not.toContain(secret.slice(0, 10));
      expect(logs).not.toContain(secret);
    });

    it("P1-1 (Round-3/4): не считает коннектор остановленным, пока PID жив после ошибок доставки сигналов", async () => {
      const d = makeTmpDir("plug117_r3_cleanup_");
      const path = join(d, "unruly.mjs");
      writeFileSync(
        path,
        `import readline from "node:readline";
setInterval(() => {}, 1000);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") process.stdout.write(JSON.stringify({ id: r.id, result: {} }) + "\\n");
  if (r.method === "tools/list") process.stdout.write(JSON.stringify({ id: r.id, result: { tools: [] } }) + "\\n");
});`,
      );
      const client = new McpClient({
        id: "example",
        transport: "stdio",
        command: [process.execPath, path],
        defaultClass: "C",
      });
      const realKill = process.kill.bind(process);
      let child: any;
      let exited: Promise<void> | undefined;
      try {
        await client.start();
        child = (client as any).child;
        const pid = child.pid as number;
        exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
        vi.spyOn(process, "kill").mockImplementation(((target: number, signal: any) => {
          if (target === -pid && (signal === "SIGTERM" || signal === "SIGKILL")) {
            const err = Object.assign(new Error("simulated signal failure"), { code: "EPERM" });
            throw err;
          }
          return realKill(target, signal);
        }) as any);
        vi.spyOn(child, "kill").mockReturnValue(false);
        await client.close();
        expect(() => realKill(pid, 0)).toThrow();
      } finally {
        vi.restoreAllMocks();
        if (child?.pid) {
          try {
            realKill(-child.pid, "SIGKILL");
          } catch {}
        }
        await exited;
        await client.close();
      }
    }, 10000);

    it("Round-5: HTTP close concurrency — второй close ожидает уже выполняющийся DELETE", async () => {
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => (releaseGate = resolve));
      const fetchMock = vi.fn(async (_url: any, opts: any) => {
        if (opts.method === "DELETE") {
          await gate;
          return new Response("{}");
        }
        const req = JSON.parse(opts.body);
        return new Response(JSON.stringify({ id: req.id, result: req.method === "tools/list" ? { tools: [] } : {} }), {
          headers: { "content-type": "application/json", "mcp-session-id": "fake_round5_http_session" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new McpClient({ id: "example", transport: "http", url: "http://127.0.0.1:12345/mcp", defaultClass: "C" });
      let first: Promise<void> | undefined;
      let second: Promise<void> | undefined;
      try {
        await client.start();
        first = client.close();
        expect(fetchMock.mock.calls.some(([, o]) => o.method === "DELETE")).toBe(true);
        let secondDone = false;
        second = client.close().then(() => {
          secondDone = true;
        });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(secondDone).toBe(false);
      } finally {
        releaseGate();
        await first;
        await second;
        vi.unstubAllGlobals();
      }
    });

    it("Round-5: построчное накопление и маскирование head сохраняет границу секрета и пробелы", async () => {
      const secret = "review_fake_value_987654321";
      const safe = 2000 - (secret.length - 1);
      const text = "A".repeat(safe - 1) + " " + "B".repeat(2000 - safe);
      const d = makeTmpDir("plug117_r5_stderr_");
      const path = join(d, "fixture.mjs");
      writeFileSync(
        path,
        `import readline from "node:readline";
process.stderr.write(${JSON.stringify(text)});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize") process.stdout.write(JSON.stringify({ id: r.id, result: {} }) + "\\n");
  if (r.method === "tools/list") process.stdout.write(JSON.stringify({ id: r.id, result: { tools: [] } }) + "\\n");
});`,
      );
      const cfg = {
        title: "Example",
        connectors: [{ id: "example", transport: "stdio", command: [process.execPath, path], defaultClass: "C" }],
      };
      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ project_example: cfg }),
        projectSecrets: JSON.stringify({ EXAMPLE: secret }),
      });
      await plugin(mock.api as never);
      new CallStore(mock.db).setApprovedProject("project_example", hashProjectConfig(cfg as any), JSON.stringify(cfg));
      const res = await mock.getCli().run(["connectors", "--project", "project_example"]);
      expect(res.exitCode).toBe(0);
      const calls = (mock.api.log.warn as any).mock.calls.flat();
      const output = calls
        .filter((s: any) => String(s).startsWith("MCP [example] stderr: "))
        .map((s: any) => String(s).slice("MCP [example] stderr: ".length))
        .join("");
      expect(output.length).toBe(2000);
      expect(output.includes(" ")).toBe(true);
    });

    describe("9. Замечания ревью Codex Round-6 и контракт 266a726", () => {
      it("IPv6 URL credentials маскируются целиком без раскрытия пароля", () => {
        const input = "https://u:plain_review_password@[2001:db8::1]/x";
        const masked = maskSecrets(input, []);
        expect(masked).not.toContain("plain_review_password");
        expect(masked).toBe("https://***:***@[2001:db8::1]/x");
      });

      it("длинный CRLF удаляет завершающий CR перед подсчётом omitted", () => {
        let logged = "";
        const c = createMcpStderrCollector([], (line) => {
          logged = line;
        }, 10);
        c.onData(Buffer.from("one " + "x".repeat(30) + "\r\n"));
        c.onEnd();
        expect(logged).toContain("[обрезано 30]");
        expect(logged).not.toContain("\r");
      });

      it("при budget = 0 строки не сохраняются в head", () => {
        const c = createMcpStderrCollector(["fake_secret_42"], () => {}, 5);
        c.onData(Buffer.from("12345\n"));
        expect(c.getRemainingBudget()).toBe(0);
        c.onData(Buffer.from("next_line_should_not_be_stored"));
        expect(c.getHeadLen()).toBe(0);
      });

      it("секреты по 266a726: недопустимые значения отклоняются до транспорта с кодом connector_secret_invalid", async () => {
        const invalidValues = ["", "\n", "\r", "\t", "\0", "\x1f", "\x7f"];
        for (const badVal of invalidValues) {
          const warnCalls: string[] = [];
          const log = {
            warn: (m: string) => warnCalls.push(m),
            info: () => {},
            error: () => {},
          };
          const client = new McpClient(
            {
              id: "example",
              transport: "http",
              url: "http://127.0.0.1:12345/mcp",
              defaultClass: "C",
              secrets: ["EXAMPLE"],
            },
            { EXAMPLE: badVal },
            log as never,
          );
          await expect(client.start()).rejects.toThrow("connector_secret_invalid");
          // Значение секрета НЕ должно попасть в лог:
          if (badVal.length > 0) {
            for (const call of warnCalls) {
              expect(call).not.toContain(badVal);
            }
          }
        }
      });
    });
  });
});
