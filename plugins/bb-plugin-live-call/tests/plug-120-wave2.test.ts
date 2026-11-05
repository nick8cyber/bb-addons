/**
 * PLUG-120 Волна 2: Тесты по контракту §14.1, §14.6, §14.10
 * П. 4: Устранение утечек секретов с " и \ (JSON-экранированные формы E′)
 * П. 5: Регрессия потокового фильтра stderr (tests/plug-117-stderr-registry.test.ts)
 * П. 8: Регрессия взаимного исключения (два hello по треду одновременно)
 * Пробы ревьюера: W-1…W-6
 */
import Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import {
  McpClient,
  createMcpStderrCollector,
  extractConfirmToken,
  liveConnectorClients,
} from "../src/mcp-client.js";
import { hashProjectConfig, type ProjectConfig } from "../src/project-registry.js";
import { buildSecretFilterSet, isValidSecretValue, maskSecrets } from "../src/secret-filter.js";

const dirsToClean: string[] = [];

function createMockPluginApi(initialSettings: Record<string, unknown> = {}) {
  const db = new Database(":memory:");
  let rpcHandlers: Record<string, (...args: any[]) => Promise<any>> = {};
  let cliDef: any = null;
  const wsHandlers = new Map<
    string,
    () => {
      onOpen: (s: any) => void;
      onMessage: (s: any, d: any) => Promise<void>;
      onClose: (s: any) => void;
    }
  >();
  let settingsData = { ...initialSettings };

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
      experimental_dataDir: "/tmp",
      loopbackBaseUrl: "http://localhost:3000",
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    sdk: {
      projects: {
        get: vi.fn(async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: `Project ${projectId}`,
          sources: [],
        })),
      },
      threads: {
        get: vi.fn(async ({ threadId }: { threadId: string }) => ({ id: threadId, title: "Thread Title" })),
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
      on: vi.fn(),
    },
    rpc: {
      register: vi.fn((_contract: any, handlers: any) => {
        rpcHandlers = handlers;
      }),
    },
    cli: {
      register: vi.fn((d: any) => {
        cliDef = d;
      }),
    },
  };

  return {
    api,
    db,
    getCli: () => cliDef,
    getRpc: () => rpcHandlers,
    getWs: () => wsHandlers,
  };
}

function mockVoice() {
  vi.spyOn(CallSession.prototype as any, "openSessions").mockResolvedValue(undefined);
  vi.spyOn(CallSession.prototype as any, "gateTicker").mockImplementation(() => {});
}

function noSubstr(out: string, s: string, min = 4) {
  for (let len = min; len <= s.length; len++) {
    for (let i = 0; i + len <= s.length; i++) {
      expect(out, `подстрока «${s.slice(i, i + len)}»`).not.toContain(s.slice(i, i + len));
    }
  }
}

describe("PLUG-120 волна 2: п. 4 — допустимые секреты с \" и \\ (E′ по §14.6)", () => {
  const validSecrets = ['pa"ss_word_77', "pa\\ss_word_77"];

  beforeEach(() => {
    liveConnectorClients.clear();
  });

  afterEach(() => {
    for (const d of dirsToClean.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  for (const secret of validSecrets) {
    const jsonForm = JSON.stringify(secret).slice(1, -1);

    it(`значение structuredContent с секретом ${JSON.stringify(secret)} маскируется без утечки`, async () => {
      expect(isValidSecretValue(secret)).toBe(true);
      const c = new McpClient(
        { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
        { DEMO: secret },
      );
      (c as any).alive = true;
      (c as any).request = async () => ({ structuredContent: { value: secret } });
      const r = await c.callTool("read", {});
      await c.close().catch(() => {});

      expect(r.ok).toBe(true);
      const resultStr = (r as any).data.result;
      expect(resultStr).not.toContain(secret);
      expect(resultStr).not.toContain(jsonForm);
      const parsed = JSON.parse(resultStr);
      expect(parsed.value).toBe("***");
    });

    it(`ключ объекта structuredContent с секретом ${JSON.stringify(secret)} маскируется без утечки`, async () => {
      const c = new McpClient(
        { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
        { DEMO: secret },
      );
      (c as any).alive = true;
      (c as any).request = async () => ({ structuredContent: { [secret]: "safe_value" } });
      const r = await c.callTool("read", {});
      await c.close().catch(() => {});

      expect(r.ok).toBe(true);
      const resultStr = (r as any).data.result;
      expect(resultStr).not.toContain(secret);
      expect(resultStr).not.toContain(jsonForm);
      const parsed = JSON.parse(resultStr);
      expect(parsed["***"]).toBe("safe_value");
    });

    it(`вложенный массив structuredContent с секретом ${JSON.stringify(secret)} маскируется без утечки`, async () => {
      const c = new McpClient(
        { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
        { DEMO: secret },
      );
      (c as any).alive = true;
      (c as any).request = async () => ({ structuredContent: { list: [1, "safe", [secret]] } });
      const r = await c.callTool("read", {});
      await c.close().catch(() => {});

      expect(r.ok).toBe(true);
      const resultStr = (r as any).data.result;
      expect(resultStr).not.toContain(secret);
      expect(resultStr).not.toContain(jsonForm);
      const parsed = JSON.parse(resultStr);
      expect(parsed.list[2][0]).toBe("***");
    });

    it(`text-часть с JSON-строкой, содержащей ${JSON.stringify(secret)}, маскируется без утечки`, async () => {
      const c = new McpClient(
        { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
        { DEMO: secret },
      );
      (c as any).alive = true;
      const jsonText = JSON.stringify({ data: secret });
      (c as any).request = async () => ({ content: [{ type: "text", text: jsonText }] });
      const r = await c.callTool("read", {});
      await c.close().catch(() => {});

      expect(r.ok).toBe(true);
      const resultStr = (r as any).data.result;
      expect(resultStr).not.toContain(secret);
      expect(resultStr).not.toContain(jsonForm);
      expect(resultStr).toContain('{"data":"***"}');
    });

    it(`stderr: секрет ${JSON.stringify(secret)} и его JSON-форма маскируются, в т.ч. на границе обрезки (P3-2: ≥ 4 символов до C)`, () => {
      const logs: string[] = [];
      const coll = createMcpStderrCollector([secret], (l) => logs.push(l), 2000);
      coll.onData(Buffer.from(`log info: ${jsonForm}\n`));
      coll.onEnd();
      expect(logs.length).toBe(1);
      expect(logs[0]).not.toContain(jsonForm);
      expect(logs[0]).not.toContain(secret);
      expect(logs[0]).toContain("***");

      // Граница обрезки B: до точки C попадает >= 4 символов JSON-формы (P3-2)
      const logsTrunc: string[] = [];
      const budget = 50;
      const collTrunc = createMcpStderrCollector([secret], (l) => logsTrunc.push(l), budget);
      // jsonForm имеет длину 14. Префикс budget - 8 (42) -> 8 символов до budget (>= 4):
      const prefix = "a".repeat(budget - 8);
      collTrunc.onData(Buffer.from(`${prefix}${jsonForm} trailing data\n`));
      collTrunc.onEnd();
      expect(logsTrunc.length).toBe(1);
      expect(logsTrunc[0]).not.toContain(jsonForm);
      expect(logsTrunc[0]).not.toContain(secret);
      noSubstr(logsTrunc[0], jsonForm, 4);
    });
  }

  it("многострочный секрет (\\n, \\r) недопустим по §14.1 → connector_secret_invalid, коннектор не стартует", async () => {
    const multilineSecret = "SYNTHETIC\nPRIVATE-VALUE";
    expect(isValidSecretValue(multilineSecret)).toBe(false);
    const c = new McpClient(
      { id: "demo_invalid", transport: "http", url: "http://127.0.0.1", defaultClass: "C", secrets: ["DEMO"] } as any,
      { DEMO: multilineSecret },
    );
    await expect(c.start()).rejects.toThrow("connector_secret_invalid");
  });

  it("инварианты §14.10: res.raw не мутирован, токен извлекается, токен не в наборе маскирования", async () => {
    const secret = 'pa"ss_word_77';
    const jsonForm = JSON.stringify(secret).slice(1, -1);
    const token = "confirm_tok_secret_value_12345";
    const rawPayload = {
      structuredContent: {
        tokenField: secret,
        confirm_token: token,
        nested: { inner: secret },
      },
    };
    const originalJson = JSON.stringify(rawPayload);

    const c = new McpClient(
      { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
      { DEMO: secret },
    );
    (c as any).alive = true;
    (c as any).request = async () => rawPayload;
    const r = await c.callTool("read", {});
    await c.close().catch(() => {});

    expect(r.ok).toBe(true);
    // 1. res.raw не мутирован
    expect(JSON.stringify((r as any).raw)).toBe(originalJson);
    expect((r as any).raw.structuredContent.tokenField).toBe(secret);
    // 2. токен извлекается
    const extracted = extractConfirmToken((r as any).raw);
    expect(extracted).toBe(token);
    // 3. токен не в наборе маскирования и присутствует в выводе
    expect((r as any).data.result).toContain(token);
    // Секреты при этом замаскированы
    expect((r as any).data.result).not.toContain(secret);
    expect((r as any).data.result).not.toContain(jsonForm);
  });
});

describe("PLUG-120 волна 2: п. 4 — дополнительные каналы и граничные условия", () => {
  beforeEach(() => {
    liveConnectorClients.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("канал вне mcp-client (вывод bb call connectors / tool_error) маскирует JSON-форму секрета", () => {
    const secret = 'pa"ss_word_77';
    const jsonForm = JSON.stringify(secret).slice(1, -1);
    const errorMsg = `tool execution failed with error: ${jsonForm} in database connection`;
    const masked = maskSecrets(errorMsg, [secret]);
    expect(masked).not.toContain(jsonForm);
    expect(masked).not.toContain(secret);
    expect(masked).toBe("tool execution failed with error: *** in database connection");
  });

  it("текст превью для карточки (maskedFullText) замаскирован по E′", async () => {
    const secret = 'pa"ss_word_77';
    const jsonForm = JSON.stringify(secret).slice(1, -1);
    const c = new McpClient(
      { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
      { DEMO: secret },
    );
    (c as any).alive = true;
    (c as any).request = async () => ({
      content: [{ type: "text", text: `preview with escaped ${jsonForm}` }],
    });
    const r = await c.callTool("preview", {});
    await c.close().catch(() => {});

    expect(r.ok).toBe(true);
    expect((r as any).maskedFullText).toBeDefined();
    expect((r as any).maskedFullText).not.toContain(jsonForm);
    expect((r as any).maskedFullText).not.toContain(secret);
    expect((r as any).maskedFullText).toContain("***");
  });

  it("путь isError с JSON-формой секрета маскируется без утечки", async () => {
    const secret = 'pa"ss_word_77';
    const jsonForm = JSON.stringify(secret).slice(1, -1);
    const c = new McpClient(
      { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
      { DEMO: secret },
    );
    (c as any).alive = true;
    (c as any).request = async () => ({
      isError: true,
      structuredContent: { errorMsg: `fatal: ${jsonForm}` },
    });
    const r = await c.callTool("read", {});
    await c.close().catch(() => {});

    expect(r.ok).toBe(false);
    expect(r.error?.message).not.toContain(jsonForm);
    expect(r.error?.message).not.toContain(secret);
    expect(r.error?.message).toContain("***");
    expect((r as any).maskedFullText).not.toContain(jsonForm);
  });

  it("ошибка JSON-RPC с JSON-формой секрета маскируется без утечки", async () => {
    const secret = 'pa"ss_word_77';
    const jsonForm = JSON.stringify(secret).slice(1, -1);
    const c = new McpClient(
      { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
      { DEMO: secret },
    );
    (c as any).alive = true;
    (c as any).request = async () => {
      throw new Error(`JSON-RPC error -32603: backend returned ${jsonForm}`);
    };
    const r = await c.callTool("read", {});
    await c.close().catch(() => {});

    expect(r.ok).toBe(false);
    expect(r.error?.message).not.toContain(jsonForm);
    expect(r.error?.message).not.toContain(secret);
    expect(r.error?.message).toContain("***");
  });

  it("враждебная глубокая вложенность structuredContent → ok:false без утечки и без падения процесса (RangeError ловится)", async () => {
    const secret = 'pa"ss_word_77';
    let deepObj: any = { secretVal: secret };
    for (let i = 0; i < 15000; i++) {
      deepObj = { nested: deepObj };
    }
    const c = new McpClient(
      { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
      { DEMO: secret },
    );
    (c as any).alive = true;
    (c as any).request = async () => ({ structuredContent: deepObj });

    const r = await c.callTool("read", {});
    await c.close().catch(() => {});

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("connector_error");
    expect(r.error?.message).toBeDefined();
    expect(r.error?.message).not.toContain(secret);
  });
});

describe("PLUG-120 волна 2: пробы ревьюера Opus W-1…W-6", () => {
  const SECRETS = ['pa"ss_word_77', "pa\\ss_word_77"];
  const jf = (s: string) => JSON.stringify(s).slice(1, -1);

  beforeEach(() => {
    liveConnectorClients.clear();
  });

  afterEach(() => {
    for (const d of dirsToClean.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function client(secret: string, res: unknown) {
    const c = new McpClient(
      { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
      { DEMO: secret },
    );
    (c as any).alive = true;
    (c as any).request = async () => res;
    return c;
  }

  describe("W-1 stderr: обрезка (а) по E′ — JSON-форма поперёк C на любой позиции (§14.6 п. 5, §14.9)", () => {
    for (const secret of SECRETS) {
      const f = jf(secret);
      it(`${JSON.stringify(secret)}: позиции [B−|e′|−2, B+2], нет подстроки ≥4 ни секрета, ни JSON-формы`, () => {
        const B = 200;
        for (let pos = B - f.length - 2; pos <= B + 2; pos++) {
          const logs: string[] = [];
          const coll = createMcpStderrCollector([secret], (l) => logs.push(l), B);
          const line = "x".repeat(pos - 1) + " " + f + " tail tail tail " + "y".repeat(300);
          coll.onData(Buffer.from(line + "\n"));
          coll.onEnd();
          const out = logs.join("\n");
          noSubstr(out, f);
          noSubstr(out, secret);
        }
      });
    }
  });

  describe("W-2 производительность structuredContent ~100 тыс. символов в рекурсии (§14.6: < 150 мс)", () => {
    const many = Array.from({ length: 10 }, (_, i) => `sec_${i}_"q\\x_${i}`);
    const cases: Array<[string, unknown]> = [
      ["широкий массив 25 тыс. коротких строк", Array.from({ length: 25_000 }, () => "a")],
      [
        "объект 12,5 тыс. ключей",
        Object.fromEntries(Array.from({ length: 12_500 }, (_, i) => [`k${i}`, "v"])),
      ],
      ["одна строка 100 тыс. из \\ и \"", '\\"'.repeat(50_000)],
    ];
    for (const [name, sc] of cases) {
      it(`${name}: callTool < 150 мс при 10 секретах`, async () => {
        const c = new McpClient(
          { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
          Object.fromEntries(many.map((s, i) => [`S${i}`, s])),
        );
        (c as any).alive = true;
        (c as any).request = async () => ({ structuredContent: sc });
        const t0 = performance.now();
        const r = await c.callTool("read", {});
        const ms = performance.now() - t0;
        await c.close().catch(() => {});
        expect(r.ok).toBe(true);
        expect(ms).toBeLessThan(150);
      });
    }
  });

  describe("W-3 ключи structuredContent: __proto__ и коллизии масок (P3-1)", () => {
    it("__proto__ с секретом внутри: секрета нет; поле сохраняется как собственное свойство", async () => {
      const secret = SECRETS[0];
      const sc = JSON.parse(`{"__proto__": {"v": ${JSON.stringify(secret)}}, "keep": 1}`);
      const c = client(secret, { structuredContent: sc });
      const r = await c.callTool("read", {});
      await c.close().catch(() => {});
      expect(r.ok).toBe(true);
      const out = (r as any).data.result as string;
      expect(out).not.toContain(secret);
      expect(out).not.toContain(jf(secret));
      // С Object.create(null) поле __proto__ сохраняется в результате как собственное свойство
      expect(JSON.parse(out)).toEqual({ ["__proto__"]: { v: "***" }, keep: 1 });
    });

    it("два ключа-секрета сливаются в один «***» — без утечки, значение одного перезаписывается", async () => {
      const [a, b] = SECRETS;
      const c = new McpClient(
        { id: "demo", transport: "http", url: "http://127.0.0.1", defaultClass: "C" } as any,
        { A: a, B: b },
      );
      (c as any).alive = true;
      (c as any).request = async () => ({ structuredContent: { [a]: 1, [b]: 2 } });
      const r = await c.callTool("read", {});
      await c.close().catch(() => {});
      const out = (r as any).data.result as string;
      for (const s of [a, b]) {
        expect(out).not.toContain(s);
        expect(out).not.toContain(jf(s));
      }
      // Коллизия двух ключей-секретов в один "***" допустима по спеке (безопасная сторона)
      expect(Object.keys(JSON.parse(out))).toEqual(["***"]);
    });
  });

  describe("W-4 канал вне mcp-client: реальный вывод `bb call connectors` (§14.8, §14.6 «все каналы»)", () => {
    it("JSON-форма секрета в имени ручки и в ошибке initialize не печатается", async () => {
      const secret = SECRETS[0];
      const f = jf(secret);
      const dir = join(tmpdir(), `w4_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      dirsToClean.push(dir);

      const okScript = join(dir, "ok.mjs");
      writeFileSync(
        okScript,
        `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => { const q = JSON.parse(l);
  const out = (r) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: r }) + "\\n");
  if (q.method === "initialize") out({ protocolVersion: "2024-11-05" });
  else if (q.method === "tools/list") out({ tools: [{ name: ${JSON.stringify("x " + f)}, inputSchema: { type: "object", properties: {} } }] });
});\n`,
      );

      const badScript = join(dir, "bad.mjs");
      writeFileSync(
        badScript,
        `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => { const q = JSON.parse(l);
  if (q.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code: -32603, message: ${JSON.stringify("boom " + f)} } }) + "\\n");
});\n`,
      );

      const cfg: ProjectConfig = {
        title: "W4",
        connectors: [
          { id: "okc", transport: "stdio", command: [process.execPath, okScript], defaultClass: "C" },
          { id: "badc", transport: "stdio", command: [process.execPath, badScript], defaultClass: "C" },
        ],
      } as any;

      const mock = createMockPluginApi({
        projectCalls: JSON.stringify({ proj_w4: cfg }),
        projectSecrets: JSON.stringify({ DEMO: secret }),
      });
      await plugin(mock.api as any);
      new CallStore(mock.db).setApprovedProject("proj_w4", hashProjectConfig(cfg), JSON.stringify(cfg));
      const cli = mock.getCli();
      const res = await cli.run(["connectors", "--project", "proj_w4"]);
      expect(res.stdout).toContain("коннектор: okc");
      expect(res.stdout).toContain("коннектор: badc");
      expect(res.stdout).not.toContain(f);
      expect(res.stdout).not.toContain(secret);
      expect(res.stdout).toContain("***");
    });
  });

  describe("W-5 §14.10: превью двухшаговой ручки с JSON-формой секрета", () => {
    it("raw цел, токен извлекается, maskedFullText и data без секрета, токен в выводе", async () => {
      const secret = SECRETS[1];
      const raw = {
        structuredContent: {
          preview: `refund to ${secret}`,
          note: `esc ${jf(secret)}`,
          confirm_token: "tok_w5_preview",
        },
      };
      const before = JSON.stringify(raw);
      const c = client(secret, raw);
      const r = await c.callTool("refund", { amount: 1 });
      await c.close().catch(() => {});
      expect(JSON.stringify((r as any).raw)).toBe(before);
      expect(extractConfirmToken((r as any).raw)).toBe("tok_w5_preview");
      for (const t of [(r as any).maskedFullText, (r as any).data.result]) {
        expect(t).not.toContain(secret);
        expect(t).not.toContain(jf(secret));
        expect(t).toContain("tok_w5_preview");
      }
    });
  });

  describe("W-6 E′: суррогаты и прием готового E′ без повторного расширения (P3-3)", () => {
    it("секрет с одиночным суррогатом: JSON-форма в наборе и маскируется", () => {
      const s = "ab\ud800cd_77";
      const set = buildSecretFilterSet([s]);
      expect(set).toContain(jf(s));
      expect(maskSecrets(`x ${jf(s)} y`, [s])).toBe("x *** y");
    });

    it("maskSecrets принимает готовый E′ напрямую без создания E″", () => {
      const s = SECRETS[0];
      const set = buildSecretFilterSet([s]);
      expect(maskSecrets(`escaped: ${jf(s)} raw: ${s}`, set)).toBe("escaped: *** raw: ***");
    });

    it("наблюдение: повторный вызов buildSecretFilterSet от готового набора даёт двойное экранирование (E″)", () => {
      const s = SECRETS[0];
      const twice = buildSecretFilterSet(buildSecretFilterSet([s]));
      expect(twice).toContain(jf(jf(s)));
    });
  });
});

describe("PLUG-120 волна 2: п. 8 (регрессия, закрыт PLUG-117)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("одновременные hello A и B по треду: ровно один ready, второй busy (§14.8)", async () => {
    mockVoice();
    const mock = createMockPluginApi({ geminiKeys: "fake_review_key" });
    await plugin(mock.api as never);
    const sessions: CallSession[] = [];
    const realStart = CallSession.prototype.start;
    vi.spyOn(CallSession.prototype, "start").mockImplementation(async function (this: CallSession) {
      sessions.push(this);
      await realStart.call(this);
    });
    const { token } = await mock.getRpc().callToken();
    const ws = mock.getWs().get("/call")!;
    const sA = { send: vi.fn(), close: vi.fn() };
    const sB = { send: vi.fn(), close: vi.fn() };
    const hello = JSON.stringify({ type: "hello", protocol: 1, token, threadId: "thr_test_concurrent" });

    await Promise.all([ws().onMessage(sA, hello), ws().onMessage(sB, hello)]);
    try {
      const codes = (sock: any) =>
        sock.send.mock.calls.map(([s]: any) => JSON.parse(s)).map((f: any) => f.code ?? f.type);
      const all = [...codes(sA), ...codes(sB)];
      expect({
        sessions: sessions.length,
        ready: all.filter((c: string) => c === "ready").length,
        busy: all.filter((c: string) => c === "busy").length,
      }).toEqual({ sessions: 1, ready: 1, busy: 1 });
    } finally {
      for (const s of sessions) await s.end("owner");
    }
  });
});

describe("PLUG-120 волна 2: п. 5 (регрессия, закрыт PLUG-117)", () => {
  it.todo(
    "потоковый фильтр stderr с удержанием хвоста и UTF-8 декодером покрыт в tests/plug-117-stderr-registry.test.ts (§14.6, §14.9 критерии 1–7)",
  );
});
