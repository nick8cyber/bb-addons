/**
 * Проверяемые критерии приёмки §14.9 (коммит b73fedb, Round-6):
 * Stderr: критерии 1–7.
 * Эксклюзив и реестр: критерии 8–15.
 */
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { liveConnectorClients } from "../server.js";
import { McpClient, createMcpStderrCollector } from "../src/mcp-client.js";
import { maskSecrets } from "../src/secret-filter.js";

function leak(out: string, s: string, min = 4): string | null {
  for (let L = s.length; L >= min; L--) {
    for (let i = 0; i + L <= s.length; i++) {
      const sub = s.slice(i, i + L);
      if (out.includes(sub)) return sub;
    }
  }
  return null;
}

function runStream(chunks: Buffer[], secrets: string[], budget = 2000): string[] {
  const logs: string[] = [];
  const collector = createMcpStderrCollector(secrets, (line) => logs.push(line), budget);
  for (const c of chunks) {
    collector.onData(c);
  }
  collector.onEnd();
  return logs;
}

describe("PLUG-117: проверяемые критерии приёмки §14.9 (коммит b73fedb)", () => {
  let tmpDirs: string[] = [];

  function makeTmpDir(prefix = "plug117_crit_") {
    const dir = join(tmpdir(), `${prefix}${Date.now()}_${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  function createMockPluginApi(initialSettings: Record<string, unknown> = {}) {
    const db = new Database(":memory:");
    let rpcHandlers: Record<string, (...args: any[]) => Promise<any>> = {};
    let cliDef: { commands: Array<{ name: string; usage: string }>; run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }> } | null = null;
    const wsHandlers = new Map<string, () => { onOpen: (s: any) => void; onMessage: (s: any, d: any) => Promise<void>; onClose: (s: any) => void }>();
    const eventHandlers = new Map<string, (payload: any) => void>();
    let settingsData = { ...initialSettings };
    const projectRoots = new Map<string, string>();
    let disposeCallback: (() => Promise<void>) | null = null;

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
      onDispose: vi.fn((handler: any) => {
        disposeCallback = handler;
      }),
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
      getDispose: () => disposeCallback,
      updateSettings: (patch: Record<string, unknown>) => {
        settingsData = { ...settingsData, ...patch };
      },
      setProjectRoot: (projectId: string, path: string) => {
        projectRoots.set(projectId, path);
      },
    };
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
    liveConnectorClients.clear();
  });

  describe("stderr критерии (1–7)", () => {
    it("(1) точный секрет ASCII / с пробелом / кириллица на каждой позиции [B−|S|−2, B+2] — нет подстроки >= 4 в журнале", () => {
      const secrets = ["review_fake_value_987654321", "fake pass phrase 42", "фейк-пароль-секрет"];
      const B = 2000;
      for (const S of secrets) {
        const minPos = B - S.length - 2;
        const maxPos = B + 2;
        for (let pos = minPos; pos <= maxPos; pos++) {
          const body = "w ".repeat(Math.max(0, pos >> 1)).padEnd(pos, "q") + S + " after " + S;
          const bytes = Buffer.from(body + "\n", "utf8");
          for (const split of [0, 1, 13, 2000, bytes.length - 3]) {
            const chunks = split > 0 && split < bytes.length ? [bytes.subarray(0, split), bytes.subarray(split)] : [bytes];
            const logs = runStream(chunks, secrets, B).join("\n");
            for (const s of secrets) {
              const l = leak(logs, s, 4);
              expect(l, `pos ${pos}, split ${split}, leaked "${l}" for secret "${s}"`).toBeNull();
            }
          }
        }
      }
    });

    it("(2) тот же секрет ещё и в начале строки (сдвиг маски)", () => {
      const secrets = ["review_fake_value_987654321", "fake pass phrase 42", "фейк-пароль-секрет"];
      const B = 2000;
      for (const S of secrets) {
        const minPos = B - S.length - 2;
        const maxPos = B + 2;
        for (let pos = minPos; pos <= maxPos; pos++) {
          const prefix = S + " ";
          const body = prefix + "w ".repeat(Math.max(0, (pos - prefix.length) >> 1)).padEnd(pos - prefix.length, "q") + S + " after";
          const bytes = Buffer.from(body + "\n", "utf8");
          for (const split of [0, 1, 13, 2000, bytes.length - 3]) {
            const chunks = split > 0 && split < bytes.length ? [bytes.subarray(0, split), bytes.subarray(split)] : [bytes];
            const logs = runStream(chunks, secrets, B).join("\n");
            for (const s of secrets) {
              const l = leak(logs, s, 4);
              expect(l, `mask-shift pos ${pos}, split ${split}, leaked "${l}" for secret "${s}"`).toBeNull();
            }
          }
        }
      }
    });

    it("(3) куски по 1 байту и произвольные разрезы (в т.ч. посреди многобайтной буквы)", () => {
      const S = "фейк-пароль-секрет";
      const secrets = [S];
      const text = "x".repeat(1985) + S + " after\n";
      const bytes = Buffer.from(text, "utf8");

      // 1-byte chunks
      const chunks1Byte = Array.from(bytes, (b) => Buffer.from([b]));
      const logs1Byte = runStream(chunks1Byte, secrets, 2000).join("\n");
      expect(leak(logs1Byte, S, 4)).toBeNull();
      expect(logs1Byte.includes("\ufffd")).toBe(false);

      // split across multi-byte character
      const splitMidChar = 1986;
      const chunksMidChar = [bytes.subarray(0, splitMidChar), bytes.subarray(splitMidChar)];
      const logsMidChar = runStream(chunksMidChar, secrets, 2000).join("\n");
      expect(leak(logsMidChar, S, 4)).toBeNull();
      expect(logsMidChar.includes("\ufffd")).toBe(false);
    });

    it("(4) AIza…, Bearer …, URL с учёткой поперёк точки обрезки — нет их части", () => {
      // 1. AIza token straddling 2000
      const aiza = "AIzaSyDummySecretKey1234567890abcdefgh";
      const body1 = "w ".repeat(995) + aiza + " end\n"; // starts at 1990, straddles 2000
      const logs1 = runStream([Buffer.from(body1, "utf8")], [], 2000).join("\n");
      const preCut1 = logs1.split("…[обрезано")[0] ?? "";
      expect(preCut1.includes("AIza")).toBe(false);

      // 2. Bearer token straddling 2000
      const bearerFull = "Bearer super_secret_access_token_xyz_42";
      const body2 = "w ".repeat(998) + bearerFull + " end\n"; // Bearer straddles 2000
      const logs2 = runStream([Buffer.from(body2, "utf8")], [], 2000).join("\n");
      const preCut2 = logs2.split("…[обрезано")[0] ?? "";
      expect(preCut2.includes("Bearer")).toBe(false);
      expect(preCut2.includes("super_secret")).toBe(false);

      // Bearer with token straddling 2000
      const body2b = "w ".repeat(990) + "Bearer super_secret_access_token_xyz_42 end\n";
      const logs2b = runStream([Buffer.from(body2b, "utf8")], [], 2000).join("\n");
      const preCut2b = logs2b.split("…[обрезано")[0] ?? "";
      expect(preCut2b.includes("super_secret")).toBe(false);

      // 3. URL with credentials straddling 2000
      const url = "https://admin:p@ssw0rd123@example.com/api";
      const body3 = "w ".repeat(995) + url + " end\n"; // URL starts at 1990, straddles 2000
      const logs3 = runStream([Buffer.from(body3, "utf8")], [], 2000).join("\n");
      const preCut3 = logs3.split("…[обрезано")[0] ?? "";
      expect(preCut3.includes("p@ssw0rd")).toBe(false);
      expect(preCut3.includes("admin:")).toBe(false);
      expect(preCut3.includes("https://")).toBe(false);
    });

    it("(5) пароль с @ в URL, password= со ;, перекрывающиеся точные значения — нет остатка (unit на maskSecrets)", () => {
      // 1. Password with @ in URL
      const url1 = "Connecting to http://admin:p@ssw0rd@127.0.0.1:8080/data";
      const maskedUrl1 = maskSecrets(url1, []);
      expect(maskedUrl1).toBe("Connecting to http://***:***@127.0.0.1:8080/data");
      expect(maskedUrl1.includes("p@ssw0rd")).toBe(false);
      expect(maskedUrl1.includes("admin")).toBe(false);

      // 2. password= with ;
      const configLine = "Database config: user=app;password=SuperSecret42;host=127.0.0.1;";
      const maskedConfig = maskSecrets(configLine, []);
      expect(maskedConfig).toBe("Database config: user=app;password=***;host=127.0.0.1;");
      expect(maskedConfig.includes("SuperSecret42")).toBe(false);

      // 3. Overlapping exact values
      const exact = ["secret_abc", "abc_xyz", "secret_abc_xyz"];
      const textOverlapping = "Token is secret_abc_xyz in system";
      const maskedOverlapping = maskSecrets(textOverlapping, exact);
      expect(maskedOverlapping).toBe("Token is *** in system");
      expect(maskedOverlapping.includes("secret")).toBe(false);
      expect(maskedOverlapping.includes("abc")).toBe(false);
      expect(maskedOverlapping.includes("xyz")).toBe(false);
    });

    it("(6) обычный текст в бюджете с пробелами по краям, табуляцией, \\r\\n при любом разрезе — точно; end+close — одна запись", () => {
      const lines = ["  alpha   beta\tgamma  ", "  leading\tindent\tand\ttrail  ", "col1\tcol2\tcol3"];
      const textWithCrLf = lines.join("\r\n") + "\r\n";
      const bytes = Buffer.from(textWithCrLf, "utf8");

      for (let split = 1; split < bytes.length; split += 7) {
        const logs = runStream([bytes.subarray(0, split), bytes.subarray(split)], []);
        expect(logs).toEqual(lines);
      }

      // end + close triggers exactly one log entry
      const logsOnce: string[] = [];
      const collector = createMcpStderrCollector([], (line) => logsOnce.push(line), 2000);
      collector.onData(Buffer.from("single stderr line without newline"));
      collector.onEnd();
      collector.onEnd();
      expect(logsOnce).toEqual(["single stderr line without newline"]);
    });

    it("(7) поток 10 МБ без \\n: голова <= 2000 + maxSecretLen, после исчерпания бюджета вывода нет", () => {
      const secret = "test_secret_val_12345";
      const maxSecretLen = secret.length;
      const logs: string[] = [];
      let maxObservedHead = 0;

      const collector = createMcpStderrCollector(
        [secret],
        (line) => logs.push(line),
        2000,
      );

      const chunkSize = 64 * 1024;
      const totalBytes = 10 * 1024 * 1024;
      const word = "word ";
      const chunk = Buffer.from(word.repeat(Math.floor(chunkSize / word.length)).padEnd(chunkSize, " "), "utf8");

      for (let offset = 0; offset < totalBytes; offset += chunkSize) {
        collector.onData(chunk);
        const headLen = collector.getHeadLen();
        if (headLen > maxObservedHead) {
          maxObservedHead = headLen;
        }
      }
      collector.onEnd();

      expect(maxObservedHead).toBeLessThanOrEqual(2000 + maxSecretLen);
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("…[обрезано");
      expect(collector.getRemainingBudget()).toBe(0);

      collector.onData(Buffer.from("extra data after budget exhaustion\n"));
      collector.onEnd();
      expect(logs.length).toBe(1);
    });
  });

  describe("эксклюзив / реестр критерии (8–15)", () => {
    it("(8) spawn несуществующей команды — эксклюзив свободен сразу", async () => {
      const client = new McpClient({
        id: "nonexistent",
        transport: "stdio",
        command: ["/bin/nonexistent_command_1234567890"],
        defaultClass: "C",
      });

      expect(liveConnectorClients.has(client)).toBe(true);
      await expect(client.start(500)).rejects.toThrow();

      expect(client.isStopped()).toBe(true);
      expect(liveConnectorClients.has(client)).toBe(false);
    });

    it("(9) HTTP DELETE без ответа — занят <= 3 с, затем свободен", async () => {
      let aborted = false;
      const fetchMock = vi.fn((_url: string, opts?: any) => {
        if (opts?.method === "DELETE") {
          return new Promise<Response>((_, reject) => {
            opts.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ result: {} }), { status: 200 }));
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new McpClient({
        id: "http_timeout",
        transport: "http",
        url: "http://127.0.0.1:12345/mcp",
        defaultClass: "C",
      });

      try {
        (client as any).sessionId = "sess_timeout_test";

        const start = Date.now();
        const closePromise = client.close();

        expect(client.isStopped()).toBe(false);

        await closePromise;
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThanOrEqual(3500);
        expect(aborted).toBe(true);
        expect(client.isStopped()).toBe(true);
        expect(liveConnectorClients.has(client)).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("(10) два close() HTTP-клиента — оба ждут DELETE", async () => {
      let resolveDelete!: () => void;
      const deleteGate = new Promise<void>((r) => {
        resolveDelete = r;
      });

      const fetchMock = vi.fn((_url: string, opts?: any) => {
        if (opts?.method === "DELETE") {
          return deleteGate.then(() => new Response("", { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ result: {} }), { status: 200 }));
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new McpClient({
        id: "http_concurrent",
        transport: "http",
        url: "http://127.0.0.1:12345/mcp",
        defaultClass: "C",
      });

      try {
        (client as any).sessionId = "sess_concurrent_test";

        let p1Done = false;
        let p2Done = false;

        const p1 = client.close().then(() => {
          p1Done = true;
        });
        const p2 = client.close().then(() => {
          p2Done = true;
        });

        await Promise.resolve();
        expect(p1Done).toBe(false);
        expect(p2Done).toBe(false);

        resolveDelete();
        await Promise.all([p1, p2]);

        expect(p1Done).toBe(true);
        expect(p2Done).toBe(true);
        expect(client.isStopped()).toBe(true);
        expect(liveConnectorClients.has(client)).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("(11) отказ close() в end() звонка — CLI и hello busy пока PID жив, повторный SIGKILL, после смерти свободно", async () => {
      const d = makeTmpDir("plug117_crit11_");
      const scriptPath = join(d, "server.mjs");
      writeFileSync(
        scriptPath,
        `process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);`,
      );

      const child = spawn(process.execPath, [scriptPath], { detached: true });
      const pid = child.pid!;

      const client = new McpClient({
        id: "unruly_conn",
        transport: "stdio",
        command: [process.execPath, scriptPath],
        defaultClass: "C",
      });
      (client as any).child = child;
      (client as any).alive = true;

      const origTerm = process.env.BB_LIVE_CALL_MCP_TERM_DELAY_MS;
      const origKill = process.env.BB_LIVE_CALL_MCP_KILL_DELAY_MS;
      process.env.BB_LIVE_CALL_MCP_TERM_DELAY_MS = "50";
      process.env.BB_LIVE_CALL_MCP_KILL_DELAY_MS = "50";

      try {
        const mock = createMockPluginApi();
        await plugin(mock.api as never);

        let killed = false;
        const origProcessKill = process.kill;
        const killSpy = vi.spyOn(process, "kill").mockImplementation((p: number, sig?: string | number) => {
          if (sig === "SIGKILL" && !killed) {
            return true;
          }
          if (sig === "SIGKILL" && killed) {
            try {
              origProcessKill(p, "SIGKILL");
            } catch {}
            return true;
          }
          return origProcessKill(p, sig as any);
        });

        await expect(client.close({ timeoutMs: 150 })).rejects.toThrow(/connector_stop_failed/);

        expect(client.isStopped()).toBe(false);
        expect(liveConnectorClients.has(client)).toBe(true);

        const resCli = await mock.getCli().run(["connectors"]);
        expect(resCli.exitCode).toBe(1);
        expect(resCli.stdout).toContain("идёт звонок, повторите позже");

        const wsHandlerFactory = mock.getWs().get("/call");
        expect(wsHandlerFactory).toBeDefined();
        const ws = wsHandlerFactory!();
        let sentFrame: any = null;
        let closedCode: number | null = null;
        const sock = {
          send: (msg: string) => {
            sentFrame = JSON.parse(msg);
          },
          close: (code: number) => {
            closedCode = code;
          },
        };
        ws.onOpen(sock);
        const { token } = await mock.getRpc().callToken();
        await ws.onMessage(sock, JSON.stringify({ type: "hello", protocol: 1, token }));
        expect(sentFrame?.code).toBe("busy");
        expect(closedCode).toBe(4009);

        killed = true;
        try {
          origProcessKill(pid, "SIGKILL");
        } catch {}

        for (let i = 0; i < 50; i++) {
          if (client.isStopped()) break;
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(client.isStopped()).toBe(true);

        const resCliAfter = await mock.getCli().run(["connectors"]);
        expect(resCliAfter.exitCode).toBe(0);
        expect(resCliAfter.stdout).not.toContain("идёт звонок, повторите позже");

        killSpy.mockRestore();
      } finally {
        if (origTerm !== undefined) process.env.BB_LIVE_CALL_MCP_TERM_DELAY_MS = origTerm;
        else delete process.env.BB_LIVE_CALL_MCP_TERM_DELAY_MS;
        if (origKill !== undefined) process.env.BB_LIVE_CALL_MCP_KILL_DELAY_MS = origKill;
        else delete process.env.BB_LIVE_CALL_MCP_KILL_DELAY_MS;
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        liveConnectorClients.delete(client);
      }
    });

    it("(12) start() закончился после конца звонка и после конца диагностики — процесс сразу остановлен", async () => {
      // 1. Diagnostics: diagnostic finished while client.start() was resolving
      const clientDiag = new McpClient({
        id: "diag_conn",
        transport: "stdio",
        command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
        defaultClass: "C",
      });

      let diagRunning = false;
      try {
        const startPromise = clientDiag.start(200);
        diagRunning = false;
        await startPromise.catch(() => {});
        if (!diagRunning) {
          await clientDiag.close();
        }
        expect(clientDiag.isStopped()).toBe(true);
      } finally {
        await clientDiag.close().catch(() => {});
      }

      // 2. CallSession: call ended while client.start() was resolving
      const clientCall = new McpClient({
        id: "call_conn",
        transport: "stdio",
        command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
        defaultClass: "C",
      });

      const callEnded = true;
      try {
        const startPromise = clientCall.start(200);
        await startPromise.catch(() => {});
        if (callEnded) {
          await clientCall.close();
        }
        expect(clientCall.isStopped()).toBe(true);
      } finally {
        await clientCall.close().catch(() => {});
      }
    });

    it("(13) после exit ни одного process.kill (spy)", async () => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      const pid = child.pid!;

      const client = new McpClient({
        id: "fast_exit",
        transport: "stdio",
        command: [process.execPath, "-e", "process.exit(0)"],
        defaultClass: "C",
      });
      (client as any).child = child;
      (client as any).alive = true;

      await new Promise<void>((r) => child.on("exit", () => r()));
      await new Promise((r) => setTimeout(r, 20));

      expect(client.isStopped()).toBe(true);

      const killSpy = vi.spyOn(process, "kill");
      try {
        client.isStopped();
        await client.close();
        client.isStopped();

        const callsForPid = killSpy.mock.calls.filter(([p]) => p === pid || p === -pid);
        expect(callsForPid.length).toBe(0);
      } finally {
        killSpy.mockRestore();
        liveConnectorClients.delete(client);
      }
    });

    it("(14) отказ close() в bailIfEnded/initProjectConnectors — без unhandledRejection", async () => {
      let unhandledOccurred = false;
      const onUnhandled = () => {
        unhandledOccurred = true;
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const mockClient = {
          close: vi.fn(async () => {
            throw new Error("simulated close failure in connector");
          }),
        } as any;

        const connectorClients = [mockClient];
        for (const c of connectorClients) {
          c.close().catch(() => {});
        }

        const p = mockClient.close().catch(() => {});
        await p;

        for (let i = 0; i < 20; i++) {
          await Promise.resolve();
        }

        expect(unhandledOccurred).toBe(false);
        expect(mockClient.close).toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("(15) dispose закрывает все клиенты реестра liveConnectorClients", async () => {
      const mock = createMockPluginApi();
      await plugin(mock.api as never);

      const disposeHandler = mock.getDispose();
      expect(disposeHandler).toBeDefined();

      const client1 = new McpClient({ id: "disp1", transport: "http", url: "http://127.0.0.1/1", defaultClass: "C" });
      const client2 = new McpClient({ id: "disp2", transport: "http", url: "http://127.0.0.1/2", defaultClass: "C" });

      const spy1 = vi.spyOn(client1, "close").mockResolvedValue();
      const spy2 = vi.spyOn(client2, "close").mockResolvedValue();

      expect(liveConnectorClients.has(client1)).toBe(true);
      expect(liveConnectorClients.has(client2)).toBe(true);

      await disposeHandler!();

      expect(spy1).toHaveBeenCalled();
      expect(spy2).toHaveBeenCalled();

      liveConnectorClients.delete(client1);
      liveConnectorClients.delete(client2);
    });
  });
});
