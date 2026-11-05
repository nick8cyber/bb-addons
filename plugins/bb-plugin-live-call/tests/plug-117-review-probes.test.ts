import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";
import { CallStore } from "../src/call-store.js";
import { hashProjectConfig } from "../src/project-registry.js";
import {
  McpClient,
  inspectConnectorTool,
  createMcpStderrCollector,
  liveConnectorClients,
} from "../src/mcp-client.js";
import { CallSession } from "../src/call-session.js";
import { maskSecrets } from "../src/secret-filter.js";

const nativeKill = process.kill.bind(process);

function createMockPluginApi(initialSettings: Record<string, unknown> = {}) {
  const db = new Database(":memory:");
  let rpcHandlers: Record<string, (...args: any[]) => Promise<any>> = {};
  let cliDef: {
    commands: Array<{ name: string; usage: string }>;
    run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;
  } | null = null;
  const wsHandlers = new Map<
    string,
    () => {
      onOpen: (s: any) => void;
      onMessage: (s: any, d: any) => Promise<void>;
      onClose: (s: any) => void;
    }
  >();
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

// ============================================================================
// Suite 1: Round-6 independent contract probes (19 tests)
// ============================================================================
describe("Round-6 independent contract probes", () => {
  const dirs: string[] = [];
  const owned: any[] = [];

  beforeEach(() => {
    liveConnectorClients.clear();
    vi.stubEnv("BB_LIVE_CALL_MCP_TERM_DELAY_MS", "20");
    vi.stubEnv("BB_LIVE_CALL_MCP_KILL_DELAY_MS", "20");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const c of owned.splice(0)) {
      if (c.exitCode !== null || c.signalCode !== null) continue;
      const p = new Promise<void>((r) => c.once("close", () => r()));
      try {
        nativeKill(-c.pid, "SIGKILL");
      } catch {
        try {
          nativeKill(c.pid, "SIGKILL");
        } catch {}
      }
      await p;
    }
    liveConnectorClients.clear();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fixture() {
    const d = mkdtempSync(join(tmpdir(), "plug117-r6-"));
    dirs.push(d);
    const p = join(d, "fixture.mjs");
    writeFileSync(
      p,
      `import readline from "node:readline";setInterval(()=>{},1000);
readline.createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);
if(r.method==="initialize")process.stdout.write(JSON.stringify({id:r.id,result:{}})+"\\n");
if(r.method==="tools/list")process.stdout.write(JSON.stringify({id:r.id,result:{tools:[]}})+"\\n");});`,
    );
    return {
      id: "example",
      transport: "stdio",
      command: [process.execPath, p],
      defaultClass: "C",
    } as const;
  }

  async function native() {
    const c = new McpClient(
      fixture() as never,
      {},
      { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    );
    await c.start();
    const ch = (c as any).child;
    owned.push(ch);
    return { c, ch };
  }

  function stream(text: string, E: string[], B = 2000, cut?: number) {
    const logs: string[] = [];
    const col = createMcpStderrCollector(E, (s) => logs.push(s), B);
    const b = Buffer.from(text);
    if (cut === undefined) col.onData(b);
    else {
      col.onData(b.subarray(0, cut));
      col.onData(b.subarray(cut));
    }
    col.onEnd();
    col.onEnd();
    return { logs, col };
  }

  const leak = (out: string, S: string) =>
    Array.from({ length: Math.max(0, S.length - 3) }, (_, i) => S.slice(i, i + 4)).some((s) =>
      out.includes(s),
    );

  const cfg = {
    id: "example",
    transport: "http",
    url: "http://127.0.0.1:12345/mcp",
    defaultClass: "C",
  } as const;

  const response = (r: any) =>
    new Response(
      JSON.stringify({ id: r.id, result: r.method === "tools/list" ? { tools: [] } : {} }),
      {
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "fake_round6_session",
        },
      },
    );

  function block(ch: any, probe = false) {
    vi.spyOn(ch, "kill").mockReturnValue(false);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, sig: any) => {
      if (
        (pid === ch.pid || pid === -ch.pid) &&
        (sig === "SIGTERM" || sig === "SIGKILL" || probe)
      ) {
        throw Object.assign(new Error("simulated failure"), { code: "EPERM" });
      }
      return nativeKill(pid, sig);
    }) as any);
  }

  it("actual collector: 5825 spec-model positions/cuts and whitespace UTF8 preservation", () => {
    const E = [
      "review_fake_value_987654321",
      "fake pass phrase 42",
      "фейк-пароль-секрет",
      "Fake@Passw0rd_42",
    ];
    let cases = 0,
      leaks = 0;
    for (const S of E) {
      for (let pos = 1940; pos <= 2030; pos++) {
        for (const prefix of ["", S]) {
          const n = pos - prefix.length,
            body = prefix + "w ".repeat(n >> 1).padEnd(n, "q") + S + " after " + S + "\n",
            bytes = Buffer.from(body);
          for (const cut of [0, 1, 7, 13, 2000, 2003, 2005, bytes.length - 3]) {
            const out = stream(body, E, 2000, cut).logs.join("\n");
            cases++;
            if (E.some((s) => leak(out, s))) leaks++;
          }
        }
      }
    }
    const logs: string[] = [];
    const col = createMcpStderrCollector(E, (s) => logs.push(s));
    for (const b of Buffer.from("x".repeat(1985) + E[2] + "\n")) col.onData(Buffer.from([b]));
    col.onEnd();
    cases++;
    if (E.some((s) => leak(logs.join("\n"), s))) leaks++;
    const ordinary = "  leading\tline \r\nsecond  \t \n";
    for (let cut = 0; cut <= Buffer.byteLength(ordinary); cut++) {
      expect(stream(ordinary, [], 2000, cut).logs).toEqual(["  leading\tline ", "second  \t "]);
    }
    expect({ cases, leaks }).toEqual({ cases: 5825, leaks: 0 });
  }, 15000);

  it("URL credentials with IPv6 host are masked without E", () => {
    expect(maskSecrets("https://u:plain_review_password@[2001:db8::1]/x", [])).not.toContain(
      "plain_review_password",
    );
  });

  it("long CRLF removes final CR before omitted count", () => {
    expect(stream("one " + "x".repeat(30) + "\r\n", [], 10).logs).toEqual([
      "one …[обрезано 30]",
    ]);
  });

  it("budget zero stores no subsequent head", () => {
    const c = createMcpStderrCollector(["fake_secret_42"], () => {}, 5);
    c.onData(Buffer.from("12345\n"));
    expect(c.getRemainingBudget()).toBe(0);
    c.onData(Buffer.from("next_line_should_not_be_stored"));
    expect(c.getHeadLen()).toBe(0);
  });

  it("late initialize resolved before close remains tracked during DELETE", async () => {
    let init!: (r: Response) => void, release!: () => void;
    const first = new Promise<Response>((r) => (init = r)),
      del = new Promise<void>((r) => (release = r));
    const f = vi.fn(async (_u: any, o: any) => {
      if (o.method === "DELETE") {
        await del;
        return new Response("{}");
      }
      const r = JSON.parse(o.body);
      return r.method === "initialize" ? first : response(r);
    });
    vi.stubGlobal("fetch", f);
    const c = new McpClient(cfg),
      start = c.start().catch((e) => e);
    let closing: Promise<void> | undefined;
    try {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      init(response({ id: 1, method: "initialize" }));
      closing = c.close();
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(f.mock.calls.some(([, o]) => o.method === "DELETE")).toBe(true);
      expect({ stopped: c.isStopped(), tracked: liveConnectorClients.has(c) }).toEqual({
        stopped: false,
        tracked: true,
      });
    } finally {
      release();
      await closing;
      await start;
      await c.close();
    }
  });

  it("close aborts notifications initialized POST still in flight", async () => {
    let finish!: () => void, signal: AbortSignal | undefined;
    const gate = new Promise<void>((r) => (finish = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: any, o: any) => {
        if (o.method === "DELETE") return new Response("{}");
        const r = JSON.parse(o.body);
        if (r.method === "notifications/initialized") {
          signal = o.signal;
          await gate;
          return new Response("{}");
        }
        return response(r);
      }),
    );
    const c = new McpClient(cfg);
    try {
      await c.start();
      await c.close();
      expect(signal?.aborted).toBe(true);
    } finally {
      finish();
      await c.close();
      await Promise.resolve();
    }
  });

  it("group ESRCH is not confirmation of actual PID exit", async () => {
    const { c, ch } = await native();
    vi.spyOn(process, "kill").mockImplementation(((pid: number, sig: any) => {
      if (pid === -ch.pid && sig !== 0)
        throw Object.assign(new Error("missing group"), { code: "ESRCH" });
      return nativeKill(pid, sig);
    }) as any);
    await c.close({ immediateKill: true, timeoutMs: 40 });
    expect(() => nativeKill(ch.pid, 0)).toThrow();
  });

  it("probe EPERM at hard timer is alive and close rejects", async () => {
    const { c, ch } = await native();
    block(ch, true);
    await expect(c.close({ immediateKill: true, timeoutMs: 40 })).rejects.toThrow(
      "connector_stop_failed",
    );
  });

  it("child error EPERM does not mean exit while PID lives", async () => {
    const { c, ch } = await native();
    ch.emit("error", Object.assign(new Error("signal failed"), { code: "EPERM" }));
    expect(() => nativeKill(ch.pid, 0)).not.toThrow();
    expect(c.isStopped()).toBe(false);
  });

  it("CLI failure close emits id:not stopped(pid) and exit 1", async () => {
    const pcfg = { title: "Example", connectors: [fixture()] },
      m = createMockPluginApi({ projectCalls: JSON.stringify({ project_example: pcfg }) });
    await plugin(m.api as never);
    new CallStore(m.db).setApprovedProject(
      "project_example",
      hashProjectConfig(pcfg),
      JSON.stringify(pcfg),
    );
    const start = McpClient.prototype.start;
    vi.spyOn(McpClient.prototype, "start").mockImplementation(async function (
      this: McpClient,
      t?: number,
    ) {
      const v = await start.call(this, t),
        ch = (this as any).child;
      owned.push(ch);
      block(ch);
      return v;
    });
    const r = await m.getCli().run(["connectors", "--project", "project_example"]);
    expect({ exitCode: r.exitCode, status: r.stdout.includes("не остановлен") }).toEqual({
      exitCode: 1,
      status: true,
    });
  }, 5000);

  it("thread close waits first close attempt and call receives stop-failed event", async () => {
    const { c, ch } = await native();
    block(ch);
    let settled = false,
      saw: boolean | undefined;
    const close = c.close.bind(c);
    vi.spyOn(c, "close").mockImplementation(async (o: any) => {
      try {
        await close(o);
      } finally {
        settled = true;
      }
    });
    const store = new CallStore(new Database(":memory:")),
      ev = vi.spyOn(store, "event");
    const s = new CallSession({
      callId: "call_review_round6",
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
      endCallThread: async () => {
        saw = settled;
      },
      wsFactory: () => {
        throw new Error("No review network");
      },
    } as never);
    (s as any).connectorClients = [c];
    (s as any).threadId = "thr_review_example";
    await s.end("owner");
    expect({
      threadAfterClose: saw,
      callStopEvent: ev.mock.calls.some(([, kind]) => kind === "connector_stop_failed"),
    }).toEqual({ threadAfterClose: true, callStopEvent: true });
  }, 5000);

  it("dispose handles failed close without unhandledRejection", async () => {
    const m = createMockPluginApi();
    await plugin(m.api as never);
    const c = new McpClient(fixture() as never),
      events: any[] = [];
    vi.spyOn(c, "close").mockRejectedValue(new Error("simulated close failure"));
    const on = (e: any) => events.push(e);
    process.on("unhandledRejection", on);
    try {
      const dispose = m.api.onDispose.mock.calls.at(-1)![0] as any;
      await dispose();
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
});

describe("Round-6 updated contract 266a726 invalid secret domain", () => {
  const cfg = {
    id: "example",
    transport: "http",
    url: "http://127.0.0.1:12345/mcp",
    defaultClass: "C",
  } as const;

  const response = (r: any) =>
    new Response(
      JSON.stringify({ id: r.id, result: r.method === "tools/list" ? { tools: [] } : {} }),
      {
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "fake_round6_session",
        },
      },
    );

  it.each([
    ["empty", ""],
    ["LF", "fake_review\nsecret_value"],
    ["CR", "fake_review_secret\r"],
    ["TAB", "fake_review\tsecret_value"],
    ["NUL", "fake_review\u0000secret_value"],
    ["U001F", "fake_review\u001fsecret_value"],
    ["DEL", "fake_review\u007fsecret_value"],
  ])("rejects %s before starting HTTP and keeps value out of logs", async (_label, value) => {
    const f = vi.fn(async (_u: any, o: any) =>
      o.method === "DELETE" ? new Response("{}") : response(JSON.parse(o.body)),
    );
    vi.stubGlobal("fetch", f);
    const logs = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const c = new McpClient({ ...cfg, secrets: ["EXAMPLE"] }, { EXAMPLE: value }, logs);
    try {
      await expect(c.start()).rejects.toThrow("connector_secret_invalid");
      expect(f).not.toHaveBeenCalled();
      if (value) expect(logs.warn.mock.calls.flat().join("\n")).not.toContain(value);
    } finally {
      await c.close();
    }
  });
});

// ============================================================================
// Suite 2: Round-7 independent review probes (14 tests)
// ============================================================================
describe("Round-7 independent review probes", () => {
  const scratch: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    liveConnectorClients.clear();
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratchDir() {
    const d = mkdtempSync(join(tmpdir(), "plug117-r7-"));
    scratch.push(d);
    return d;
  }

  function fixture(script: string, extra = "") {
    const d = scratchDir(),
      path = join(d, "fixture.mjs");
    writeFileSync(
      path,
      `import readline from "node:readline";${extra}
 ${script}
 readline.createInterface({input:process.stdin}).on("line",line=>{
   const r=JSON.parse(line);
   if(r.method==="initialize")process.stdout.write(JSON.stringify({id:r.id,result:{}})+"\\n");
   if(r.method==="tools/list")process.stdout.write(JSON.stringify({id:r.id,result:{tools:[]}})+"\\n");
 });`,
    );
    return {
      title: "Example",
      connectors: [
        {
          id: "example",
          transport: "stdio",
          command: [process.execPath, path],
          defaultClass: "C",
        },
      ],
    };
  }

  async function approvedMock(cfg: any, settings: any = {}) {
    const empty = { title: "Empty", connectors: [] };
    const mock = createMockPluginApi({
      projectCalls: JSON.stringify({ project_example: cfg, project_empty: empty }),
      ...settings,
    });
    await plugin(mock.api as never);
    const store = new CallStore(mock.db);
    store.setApprovedProject("project_example", hashProjectConfig(cfg), JSON.stringify(cfg));
    store.setApprovedProject("project_empty", hashProjectConfig(empty), JSON.stringify(empty));
    return mock;
  }

  function interceptSignals() {
    const children: any[] = [];
    const realStart = McpClient.prototype.start;
    vi.spyOn(McpClient.prototype, "start").mockImplementation(async function (
      this: McpClient,
      timeout?: number,
    ) {
      const tools = await realStart.call(this, timeout);
      const child = (this as any).child;
      if (child) {
        children.push(child);
        vi.spyOn(child, "kill").mockReturnValue(false);
      }
      return tools;
    });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: any) => {
      if (
        children.some((c) => pid === c.pid || pid === -c.pid) &&
        (signal === "SIGTERM" || signal === "SIGKILL")
      ) {
        throw Object.assign(new Error("simulated delivery failure"), { code: "EPERM" });
      }
      return nativeKill(pid, signal);
    }) as any);
    return children;
  }

  async function cleanup(children: any[]) {
    vi.restoreAllMocks();
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        try {
          nativeKill(-child.pid, "SIGKILL");
        } catch {
          try {
            nativeKill(child.pid, "SIGKILL");
          } catch {}
        }
        await closed;
      }),
    );
  }

  // ---------- R7-1: второй hello убивает коннекторы стартовавшего звонка ----------
  describe("R7-1 hello at server.ts:578 force-kills live call connectors", () => {
    it("concurrent thread-hello reaching line 578 after call A became active must not SIGKILL A's connector", async () => {
      const cfg = fixture("setInterval(()=>{},1000);");
      const mock = await approvedMock(cfg, { geminiKeys: "fake_review_key" });
      let sessionA: CallSession | undefined;
      const realSessionStart = CallSession.prototype.start;
      vi.spyOn(CallSession.prototype, "start").mockImplementation(async function (
        this: CallSession,
      ) {
        sessionA ??= this;
        await realSessionStart.call(this);
      });
      vi.spyOn(CallSession.prototype as any, "openSessions").mockResolvedValue(undefined);
      vi.spyOn(CallSession.prototype as any, "gateTicker").mockImplementation(() => {});
      const kills: any[] = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: any) => {
        if (signal) kills.push({ pid, signal });
        return nativeKill(pid, signal);
      }) as any);
      let releaseB!: () => void;
      const gateB = new Promise<void>((r) => (releaseB = r));
      (mock.api.sdk.threads.get as any).mockImplementationOnce(async ({ threadId }: any) => {
        await gateB;
        return { id: threadId, title: "T" };
      });
      const { token } = await mock.getRpc().callToken();
      const sockB = { send: vi.fn(), close: vi.fn() };
      const sockA = { send: vi.fn(), close: vi.fn() };
      const ws = mock.getWs().get("/call")!;
      const pB = ws().onMessage(
        sockB,
        JSON.stringify({ type: "hello", protocol: 1, token, threadId: "thr_example" }),
      );
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await ws().onMessage(
        sockA,
        JSON.stringify({ type: "hello", protocol: 1, token, projectId: "project_example" }),
      );
      expect(sockA.send.mock.calls.map(([s]) => JSON.parse(s).type)).toContain("ready");
      const clientA = (sessionA as any).connectorClients[0];
      const pidA = clientA.getPid();
      expect(() => nativeKill(pidA, 0)).not.toThrow();
      try {
        releaseB();
        await pB;
        await new Promise((r) => setTimeout(r, 300));
        const killedA = kills.filter(
          (k) => (k.pid === pidA || k.pid === -pidA) && k.signal === "SIGKILL",
        );
        let aliveA = true;
        try {
          nativeKill(pidA, 0);
        } catch {
          aliveA = false;
        }
        expect({
          killedA: killedA.length,
          aliveA,
          sessionAEnded: (sessionA as any).ended,
        }).toEqual({ killedA: 0, aliveA: true, sessionAEnded: false });
      } finally {
        await sessionA?.end("owner");
        vi.restoreAllMocks();
        try {
          nativeKill(-pidA, "SIGKILL");
        } catch {}
      }
    }, 15000);
  });

  // ---------- R7-2: два DELETE одновременно, булев httpDeletePending ----------
  describe("R7-2 overlapping DELETEs", () => {
    it("client must stay registered/unstopped while the late DELETE is still in flight", async () => {
      const gates: Array<() => void> = [];
      let releaseCall!: (r: Response) => void;
      const fetchMock = vi.fn(async (_url: any, opts: any) => {
        if (opts.method === "DELETE") {
          await new Promise<void>((r) => gates.push(r));
          return new Response("{}");
        }
        const req = JSON.parse(opts.body);
        if (req.method === "tools/call") return await new Promise<Response>((r) => (releaseCall = r));
        return new Response(
          JSON.stringify({ id: req.id, result: req.method === "tools/list" ? { tools: [] } : {} }),
          { headers: { "content-type": "application/json", "mcp-session-id": "fake_sid" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new McpClient({
        id: "example",
        transport: "http",
        url: "http://127.0.0.1:12345/mcp",
        defaultClass: "C",
      } as never);
      try {
        await client.start();
        const callP = client.callTool("x", {});
        for (let i = 0; i < 5; i++) await Promise.resolve();
        releaseCall(
          new Response(JSON.stringify({ id: 999, result: { content: [] } }), {
            headers: { "content-type": "application/json", "mcp-session-id": "fake_sid" },
          }),
        );
        const closeP = client.close();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await callP;
        const deletes = fetchMock.mock.calls.filter(([, o]) => o.method === "DELETE").length;
        expect(deletes).toBe(2);
        gates[0]();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const st = {
          deletesInFlight: 1,
          stopped: client.isStopped(),
          tracked: liveConnectorClients.has(client),
        };
        expect(st).toEqual({ deletesInFlight: 1, stopped: false, tracked: true });
        gates.forEach((g) => g());
        await closeP;
      } finally {
        gates.forEach((g) => g());
        vi.unstubAllGlobals();
        liveConnectorClients.delete(client);
      }
    });
  });

  // ---------- R7-3: учётка URL — регрессия по сравнению с fc24b90 ----------
  describe("R7-3 URL credentials", () => {
    const OLD = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@]+)@/g;
    const cases = [
      "connect (https://u:plain_review_pw_1@api.example.com:8443) failed",
      '{"url":"https://u:plain_review_pw_1@api.example.com:8443"}',
      "postgres://u:plain_review_pw_1@db.example:5432,retry",
      "mysql://u:plain_review_pw_1@db.example;timeout=3",
      "https://u:plain_review_pw_1@api.example.com:8443.",
    ];
    for (const c of cases) {
      it(`masked without E: ${c.slice(0, 40)}`, () => {
        const oldOut = c.replace(OLD, (_m, s, cr) => `${s}${cr.includes(":") ? "***:***@" : "***@"}`);
        const newOut = maskSecrets(c, []);
        expect(oldOut).not.toContain("plain_review_pw_1");
        expect(newOut).not.toContain("plain_review_pw_1");
      });
    }
  });

  // ---------- R7-4: шаблон sk-… (до диапазона) ----------
  describe("R7-4 sk- keys with dashes", () => {
    for (const k of [
      "sk-proj-" + "Ab3_dE".repeat(10),
      "sk-ant-api03-" + "Zx9-Qw".repeat(10),
    ]) {
      it(`masked: ${k.slice(0, 12)}`, () => {
        const out = maskSecrets(`key ${k} end`, []);
        expect(out).not.toContain(k.slice(8, 24));
      });
    }
  });

  // ---------- R7-5: короткие точные секреты ----------
  describe("R7-5 short exact secret", () => {
    it("valid 3-char secret / whitespace-padded secret is masked; <3 chars not masked (§14.1)", () => {
      const a = maskSecrets("val Q77 end", ["Q77"]);
      const b = maskSecrets("val   x99   end", ["  x99  "]);
      expect(a).not.toContain("Q77");
      expect(b).not.toContain("x99");
      const c = maskSecrets("val Q7 end", ["Q7"]);
      expect(c).toBe("val Q7 end");
    });
  });

  // ---------- R7-6: случайный фазз коллектора ----------
  describe("R7-6 collector fuzz", () => {
    it("random E/positions/chunks: no >=4 substring of any E value; text before C exact", () => {
      let seed = 1234567;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const alpha = "abcxyz Ж文 \t-_.:/=@";
      const pick = (n: number) =>
        Array.from({ length: n }, () => alpha[Math.floor(rnd() * alpha.length)]).join("");
      const leaks: any[] = [];
      let cases = 0;
      for (let iter = 0; iter < 1000; iter++) {
        const B = 5 + Math.floor(rnd() * 60);
        const E: string[] = [];
        const ne = 1 + Math.floor(rnd() * 3);
        for (let j = 0; j < ne; j++) {
          let s = "S" + pick(3 + Math.floor(rnd() * 12)) + "Z";
          s = s.replace(/[\u0000-\u001f\u007f]/g, "q");
          E.push(s);
        }
        if (rnd() < 0.3 && E[0].length > 6) E.push((E[0].slice(2) + "K" + pick(3)).replace(/[\u0000-\u001f\u007f]/g, "q"));
        let line = "";
        const parts = 1 + Math.floor(rnd() * 8);
        for (let p = 0; p < parts; p++) {
          line += pick(Math.floor(rnd() * 20));
          if (rnd() < 0.7) line += E[Math.floor(rnd() * E.length)];
        }
        const lines = [line, pick(Math.floor(rnd() * 10)) + E[0] + pick(Math.floor(rnd() * 30)), line];
        const raw = Buffer.from(lines.join(rnd() < 0.5 ? "\n" : "\r\n"), "utf8");
        const out: string[] = [];
        const col = createMcpStderrCollector(E, (l) => out.push(l), B);
        let pos = 0;
        while (pos < raw.length) {
          const n = 1 + Math.floor(rnd() * 7);
          col.onData(raw.subarray(pos, pos + n));
          pos += n;
        }
        col.onEnd();
        col.onEnd();
        const all = out.join("\n");
        cases++;
        for (const s of E) {
          for (let i = 0; i + 4 <= s.length; i++) {
            const sub = s.slice(i, i + 4);
            if (
              sub.trim().length === 4 &&
              all.includes(sub) &&
              !lines
                .join("")
                .replace(
                  new RegExp(
                    E.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
                    "g",
                  ),
                  "",
                )
                .includes(sub)
            ) {
              leaks.push({ B, E, sub, all });
              break;
            }
          }
        }
        if (leaks.length > 3) break;
      }
      expect(leaks).toEqual([]);
    });
  });

  // ---------- R7-7: дубль connector_stop_failed ----------
  describe("R7-7 stop-failed events", () => {
    it("one stop failure in end() writes one call event", async () => {
      const cfg = fixture("setInterval(()=>{},1000);");
      const mock = await approvedMock(cfg, { geminiKeys: "fake_review_key" });
      const children = interceptSignals();
      let session: CallSession | undefined;
      const realSessionStart = CallSession.prototype.start;
      vi.spyOn(CallSession.prototype, "start").mockImplementation(async function (
        this: CallSession,
      ) {
        session = this;
        await realSessionStart.call(this);
      });
      vi.spyOn(CallSession.prototype as any, "openSessions").mockResolvedValue(undefined);
      vi.spyOn(CallSession.prototype as any, "gateTicker").mockImplementation(() => {});
      try {
        const { token } = await mock.getRpc().callToken();
        const sock = { send: vi.fn(), close: vi.fn() };
        await mock
          .getWs()
          .get("/call")!()
          .onMessage(
            sock,
            JSON.stringify({ type: "hello", protocol: 1, token, projectId: "project_example" }),
          );
        await session!.end("owner");
        const n = (
          mock.db
            .prepare("select count(*) c from call_events where kind='connector_stop_failed'")
            .get() as any
        )?.c;
        expect(n).toBe(1);
      } finally {
        await cleanup(children);
      }
    }, 15000);
  });

  describe("R7-2b late sid DELETE is not awaited by the same close()", () => {
    it("close() must not resolve while the late-session DELETE is in flight", async () => {
      let init!: (r: Response) => void, release!: () => void;
      const first = new Promise<Response>((r) => (init = r)),
        del = new Promise<void>((r) => (release = r));
      const resp = (id: number, result: any) =>
        new Response(JSON.stringify({ id, result }), {
          headers: { "content-type": "application/json", "mcp-session-id": "fake_sid" },
        });
      const f = vi.fn(async (_u: any, o: any) => {
        if (o.method === "DELETE") {
          await del;
          return new Response("{}");
        }
        const r = JSON.parse(o.body);
        return r.method === "initialize" ? first : resp(r.id, { tools: [] });
      });
      vi.stubGlobal("fetch", f);
      const c = new McpClient({
        id: "example",
        transport: "http",
        url: "http://127.0.0.1:12345/mcp",
        defaultClass: "C",
      } as never);
      const start = c.start().catch((e) => e);
      let closed = false;
      try {
        for (let i = 0; i < 5; i++) await Promise.resolve();
        init(resp(1, {}));
        const closing = c.close().then(() => {
          closed = true;
        });
        for (let i = 0; i < 30; i++) await Promise.resolve();
        const st = {
          deleteSent: f.mock.calls.some(([, o]) => o.method === "DELETE"),
          closeResolved: closed,
          stoppedAfterClose: c.isStopped(),
        };
        expect(st).toEqual({ deleteSent: true, closeResolved: false, stoppedAfterClose: false });
        release();
        await closing;
      } finally {
        release();
        await start;
        vi.unstubAllGlobals();
        liveConnectorClients.delete(c);
      }
    });
  });

  describe("R7-8 one trailing CR only", () => {
    it("line 'abc\\r\\r\\n' keeps one CR", () => {
      const out: string[] = [];
      const col = createMcpStderrCollector([], (l) => out.push(l), 2000);
      col.onData(Buffer.from("abc\r\r\n"));
      col.onEnd();
      expect(out).toEqual(["abc\r"]);
    });
  });
});

// ============================================================================
// Suite 3: Round-5 adjusted review probes (7 tests)
// ============================================================================
describe("Round-5 adjusted review probes", () => {
  const scratch: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    liveConnectorClients.clear();
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratchDir() {
    const d = mkdtempSync(join(tmpdir(), "plug117-r5-"));
    scratch.push(d);
    return d;
  }

  function fixture(script: string, extra = "") {
    const d = scratchDir(),
      path = join(d, "fixture.mjs");
    writeFileSync(
      path,
      `import readline from "node:readline";${extra}
 ${script}
 readline.createInterface({input:process.stdin}).on("line",line=>{
   const r=JSON.parse(line);
   if(r.method==="initialize")process.stdout.write(JSON.stringify({id:r.id,result:{}})+"\\n");
   if(r.method==="tools/list")process.stdout.write(JSON.stringify({id:r.id,result:{tools:[]}})+"\\n");
 });`,
    );
    return {
      title: "Example",
      connectors: [
        {
          id: "example",
          transport: "stdio",
          command: [process.execPath, path],
          defaultClass: "C",
        },
      ],
    };
  }

  async function approvedMock(cfg: any, settings: any = {}) {
    const empty = { title: "Empty", connectors: [] };
    const mock = createMockPluginApi({
      projectCalls: JSON.stringify({ project_example: cfg, project_empty: empty }),
      ...settings,
    });
    await plugin(mock.api as never);
    const store = new CallStore(mock.db);
    store.setApprovedProject("project_example", hashProjectConfig(cfg), JSON.stringify(cfg));
    store.setApprovedProject("project_empty", hashProjectConfig(empty), JSON.stringify(empty));
    return mock;
  }

  function interceptSignals() {
    const children: any[] = [];
    const realStart = McpClient.prototype.start;
    vi.spyOn(McpClient.prototype, "start").mockImplementation(async function (
      this: McpClient,
      timeout?: number,
    ) {
      const tools = await realStart.call(this, timeout);
      const child = (this as any).child;
      if (child) {
        children.push(child);
        vi.spyOn(child, "kill").mockReturnValue(false);
      }
      return tools;
    });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: any) => {
      if (
        children.some((c) => pid === c.pid || pid === -c.pid) &&
        (signal === "SIGTERM" || signal === "SIGKILL")
      ) {
        throw Object.assign(new Error("simulated delivery failure"), { code: "EPERM" });
      }
      return nativeKill(pid, signal);
    }) as any);
    return children;
  }

  async function cleanup(children: any[]) {
    vi.restoreAllMocks();
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        try {
          nativeKill(-child.pid, "SIGKILL");
        } catch {
          try {
            nativeKill(child.pid, "SIGKILL");
          } catch {}
        }
        await closed;
      }),
    );
  }

  const stderrBody = (mock: any) =>
    mock.api.log.warn.mock.calls
      .flat()
      .filter((s: any) => String(s).startsWith("MCP [example] stderr: "))
      .map((s: any) => String(s).slice("MCP [example] stderr: ".length))
      .join("");

  describe("Round-5 independent boundary probes", () => {
    it("no secret prefix >=4 characters at ANY retained-tail cut inside a complete secret", async () => {
      const secret = "review_fake_value_987654321",
        tail = secret.length - 1;
      const leaks: any[] = [];
      for (let chars = 4; chars < secret.length; chars++) {
        const before = 2000 - tail - chars,
          after = chars - 1;
        const text = "x".repeat(before) + secret + "y".repeat(after);
        expect(text.length).toBe(2000);
        const cfg = fixture(`process.stderr.write(${JSON.stringify(text)});`);
        const mock = await approvedMock(cfg, { projectSecrets: JSON.stringify({ EXAMPLE: secret }) });
        const res = await mock.getCli().run(["connectors", "--project", "project_example"]);
        expect(res.exitCode).toBe(0);
        const output = stderrBody(mock);
        if (output.includes(secret.slice(0, chars))) leaks.push({ chars, prefix: secret.slice(0, chars) });
      }
      expect(leaks).toEqual([]);
    }, 10000);

    it("ordinary stderr letters are neither lost nor duplicated at tail/final", async () => {
      const text = "ABCDE0123456789".repeat(140).slice(0, 2000);
      const cfg = fixture(`process.stderr.write(${JSON.stringify(text)});`);
      const mock = await approvedMock(cfg, {
        projectSecrets: JSON.stringify({ EXAMPLE: "review_fake_value_987654321" }),
      });
      await mock.getCli().run(["connectors", "--project", "project_example"]);
      expect(stderrBody(mock)).toBe(text);
    });

    it("ordinary stderr SPACE at retained-tail boundary must survive", async () => {
      const secret = "review_fake_value_987654321",
        safe = 2000 - (secret.length - 1);
      const text = "A".repeat(safe - 1) + " " + "B".repeat(2000 - safe);
      const cfg = fixture(`process.stderr.write(${JSON.stringify(text)});`);
      const mock = await approvedMock(cfg, {
        projectSecrets: JSON.stringify({ EXAMPLE: secret }),
      });
      await mock.getCli().run(["connectors", "--project", "project_example"]);
      const actual = stderrBody(mock);
      expect({ length: actual.length, hasSpace: actual.includes(" ") }).toEqual({
        length: 2000,
        hasSpace: true,
      });
    });

    it("failed diagnostic cleanup holds CLI/WS busy and clears after real exit", async () => {
      const cfg = fixture("setInterval(()=>{},1000);");
      const mock = await approvedMock(cfg);
      const children = interceptSignals();
      try {
        const first = await mock.getCli().run(["connectors", "--project", "project_example"]);
        expect(first.exitCode).toBe(1);
        expect(first.stdout).toMatch(/не остановлен \(pid \d+\)/);
        const child = children[0];
        expect(child).toBeDefined();
        expect(() => nativeKill(child.pid, 0)).not.toThrow();
        const busy = await mock.getCli().run(["connectors", "--project", "project_empty"]);
        expect(busy.stdout).toContain("идёт звонок");
        const { token } = await mock.getRpc().callToken();
        const sock = { send: vi.fn(), close: vi.fn() };
        await mock
          .getWs()
          .get("/call")!()
          .onMessage(sock, JSON.stringify({ type: "hello", protocol: 1, token }));
        expect(sock.send.mock.calls.map(([s]) => JSON.parse(s).code)).toContain("busy");
        await cleanup(children);
        const after = await mock.getCli().run(["connectors", "--project", "project_empty"]);
        expect(after.exitCode).toBe(0);
        expect(after.stdout).not.toContain("идёт звонок");
        const sock2 = { send: vi.fn(), close: vi.fn() };
        await mock
          .getWs()
          .get("/call")!()
          .onMessage(sock2, JSON.stringify({ type: "hello", protocol: 1, token }));
        expect(sock2.send.mock.calls.map(([s]) => JSON.parse(s).code)).toContain("no_keys");
        expect(sock2.send.mock.calls.map(([s]) => JSON.parse(s).code)).not.toContain("busy");
      } finally {
        await cleanup(children);
      }
    }, 12000);

    it("failed CALL cleanup must keep CLI busy until actual exit", async () => {
      const cfg = fixture("setInterval(()=>{},1000);");
      const mock = await approvedMock(cfg, { geminiKeys: "fake_review_key" });
      const children = interceptSignals();
      let session: CallSession | undefined;
      const realSessionStart = CallSession.prototype.start;
      vi.spyOn(CallSession.prototype, "start").mockImplementation(async function (
        this: CallSession,
      ) {
        session = this;
        await realSessionStart.call(this);
      });
      vi.spyOn(CallSession.prototype as any, "openSessions").mockResolvedValue(undefined);
      vi.spyOn(CallSession.prototype as any, "gateTicker").mockImplementation(() => {});
      try {
        const { token } = await mock.getRpc().callToken();
        const sock = { send: vi.fn(), close: vi.fn() };
        await mock
          .getWs()
          .get("/call")!()
          .onMessage(
            sock,
            JSON.stringify({ type: "hello", protocol: 1, token, projectId: "project_example" }),
          );
        expect(session).toBeDefined();
        expect(sock.send.mock.calls.map(([s]) => JSON.parse(s).type)).toContain("ready");
        await session!.end("owner");
        expect(() => nativeKill(children[0].pid, 0)).not.toThrow();
        const res = await mock.getCli().run(["connectors", "--project", "project_empty"]);
        expect(res.stdout).toContain("идёт звонок");
        expect(res.exitCode).toBe(1);
      } finally {
        await cleanup(children);
        await session?.end("owner");
      }
    }, 12000);

    it("retry close after ALL signal paths fail resends SIGKILL and stops actual child", async () => {
      const cfg = fixture("setInterval(()=>{},1000); process.on('SIGTERM',()=>{});");
      const children = interceptSignals();
      const client = new McpClient(cfg.connectors[0] as never);
      try {
        await client.start();
        expect(children.length).toBe(1);
        await expect(client.close()).rejects.toThrow("connector_stop_failed");
        expect(client.isStopped()).toBe(false);
        expect((client as any).closePromise).toBeNull();
        vi.restoreAllMocks();
        const sent: any[] = [];
        vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: any) => {
          if (pid === children[0].pid || pid === -children[0].pid) sent.push(signal);
          return nativeKill(pid, signal);
        }) as any);
        await client.close();
        expect(sent).toContain("SIGKILL");
        expect(client.isStopped()).toBe(true);
        expect(() => nativeKill(children[0].pid, 0)).toThrow();
      } finally {
        await cleanup(children);
      }
    }, 18000);
  });

  describe("Round-5 HTTP close concurrency", () => {
    it("a second HTTP close must await the DELETE already in flight", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const fetchMock = vi.fn(async (_url: any, opts: any) => {
        if (opts.method === "DELETE") {
          await gate;
          return new Response("{}");
        }
        const req = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({ id: req.id, result: req.method === "tools/list" ? { tools: [] } : {} }),
          {
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "fake_review_http_session",
            },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new McpClient({
        id: "example",
        transport: "http",
        url: "http://127.0.0.1:12345/mcp",
        defaultClass: "C",
      });
      let first: Promise<void> | undefined, second: Promise<void> | undefined;
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
        release();
        await first;
        await second;
        vi.unstubAllGlobals();
      }
    });
  });
});


// ============================================================================
// Suite 4: Round-8 (Opus) independent review probes
// ============================================================================
describe("Round-8 Opus independent review probes", () => {
  const scratch: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    liveConnectorClients.clear();
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratchDir() {
    const d = mkdtempSync(join(tmpdir(), "plug117-r8-"));
    scratch.push(d);
    return d;
  }

  function fixture(opts: { pre?: string; tools?: string[]; initError?: string; initDelayMs?: number; secrets?: string[] } = {}) {
    const d = scratchDir(),
      path = join(d, "fixture.mjs");
    writeFileSync(
      path,
      `import readline from "node:readline";
 ${opts.pre ?? ""}
 readline.createInterface({input:process.stdin}).on("line",line=>{
   const r=JSON.parse(line);
   const reply=()=>{
     if(r.method==="initialize"){
       ${opts.initError ? `process.stdout.write(JSON.stringify({id:r.id,error:{code:-32000,message:${opts.initError}}})+"\\n");return;` : ""}
       process.stdout.write(JSON.stringify({id:r.id,result:{}})+"\\n");
     }
     if(r.method==="tools/list")process.stdout.write(JSON.stringify({id:r.id,result:{tools:${JSON.stringify(
       (opts.tools ?? []).map((name) => ({ name, description: "probe", inputSchema: { type: "object", properties: {} } })),
     )}}})+"\\n");
   };
   ${opts.initDelayMs ? `if(r.method==="initialize")setTimeout(reply,${opts.initDelayMs});else reply();` : "reply();"}
 });`,
    );
    return {
      title: "Example",
      connectors: [
        { id: "example", transport: "stdio", command: [process.execPath, path], defaultClass: "C", ...(opts.secrets ? { secrets: opts.secrets } : {}) },
      ],
    };
  }

  async function approvedMock(cfg: any, settings: any = {}) {
    const mock = createMockPluginApi({ projectCalls: JSON.stringify({ project_example: cfg }), ...settings });
    await plugin(mock.api as never);
    const store = new CallStore(mock.db);
    store.setApprovedProject("project_example", hashProjectConfig(cfg), JSON.stringify(cfg));
    return mock;
  }

  function mockVoice() {
    vi.spyOn(CallSession.prototype as any, "openSessions").mockResolvedValue(undefined);
    vi.spyOn(CallSession.prototype as any, "gateTicker").mockImplementation(() => {});
  }

  function recordKills() {
    const kills: Array<{ pid: number; signal: any }> = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: any) => {
      if (signal) kills.push({ pid, signal });
      return nativeKill(pid, signal);
    }) as any);
    return kills;
  }

  const alive = (pid: number) => {
    try {
      nativeKill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const codes = (sock: any) => sock.send.mock.calls.map(([s]: any) => JSON.parse(s)).map((f: any) => f.code ?? f.type);

  describe("R8-A гонка двух hello по проекту (§14.8 п. 1а)", () => {
    it("одновременные hello A и B: ровно один ready, второй busy; коннектор первого не получает сигналов", async () => {
      mockVoice();
      const mock = await approvedMock(fixture({ pre: "setInterval(()=>{},1000);" }), { geminiKeys: "fake_review_key" });
      const sessions: CallSession[] = [];
      const realStart = CallSession.prototype.start;
      vi.spyOn(CallSession.prototype, "start").mockImplementation(async function (this: CallSession) {
        sessions.push(this);
        await realStart.call(this);
      });
      const kills = recordKills();
      const { token } = await mock.getRpc().callToken();
      const ws = mock.getWs().get("/call")!;
      const sA = { send: vi.fn(), close: vi.fn() },
        sB = { send: vi.fn(), close: vi.fn() };
      const hello = JSON.stringify({ type: "hello", protocol: 1, token, projectId: "project_example" });
      await Promise.all([ws().onMessage(sA, hello), ws().onMessage(sB, hello)]);
      try {
        const all = [...codes(sA), ...codes(sB)];
        const pid = (sessions[0] as any).connectorClients[0].getPid();
        await new Promise((r) => setTimeout(r, 200));
        expect({
          sessions: sessions.length,
          ready: all.filter((c: string) => c === "ready").length,
          busy: all.filter((c: string) => c === "busy").length,
          kills: kills.filter((k) => Math.abs(k.pid) === pid).length,
          alive: alive(pid),
        }).toEqual({ sessions: 1, ready: 1, busy: 1, kills: 0, alive: true });
      } finally {
        for (const s of sessions) await s.end("owner");
      }
    }, 20000);
  });

  describe("R8-B живой звонок + диагностика (§14.8 п. 1б, 1в)", () => {
    it("CLI во время старта и во время звонка — busy без сигналов коннектору звонка; после конца — exit 0", async () => {
      mockVoice();
      const mock = await approvedMock(fixture({ pre: "setInterval(()=>{},1000);", tools: ["read_probe"], initDelayMs: 400 }), {
        geminiKeys: "fake_review_key",
      });
      let session: CallSession | undefined;
      const realStart = CallSession.prototype.start;
      vi.spyOn(CallSession.prototype, "start").mockImplementation(async function (this: CallSession) {
        session = this;
        await realStart.call(this);
      });
      const kills = recordKills();
      const { token } = await mock.getRpc().callToken();
      const sock = { send: vi.fn(), close: vi.fn() };
      const pHello = mock.getWs().get("/call")!().onMessage(sock, JSON.stringify({ type: "hello", protocol: 1, token, projectId: "project_example" }));
      await new Promise((r) => setTimeout(r, 150));
      const duringStart = await mock.getCli().run(["connectors"]);
      await pHello;
      const pid = (session as any).connectorClients[0].getPid();
      const duringActive = await mock.getCli().run(["connectors"]);
      const killsDuringCall = kills.filter((k) => Math.abs(k.pid) === pid).length;
      const aliveDuringCall = alive(pid);
      await session!.end("owner");
      const after = await mock.getCli().run(["connectors"]);
      expect({
        duringStart: [duringStart.exitCode, duringStart.stdout.trim()],
        duringActive: [duringActive.exitCode, duringActive.stdout.trim()],
        killsDuringCall,
        aliveDuringCall,
        afterExit: after.exitCode,
        afterHasTool: after.stdout.includes("read_probe"),
        registry: liveConnectorClients.size,
      }).toEqual({
        duringStart: [1, "идёт звонок, повторите позже"],
        duringActive: [1, "идёт звонок, повторите позже"],
        killsDuringCall: 0,
        aliveDuringCall: true,
        afterExit: 0,
        afterHasTool: true,
        registry: 0,
      });
    }, 30000);
  });

  describe("R8-C URL-учётки: новые края (§14.6)", () => {
    const ok: Array<[string, string]> = [
      ["userinfo без пароля", "clone https://ghp_fake_review_userinfo@git.example.com/x failed"],
      ["IPv6 с портом", "connect https://u:fake_review_pw6@[2001:db8::1]:8443/x)"],
      ["пароль с @ и портом в скобках", "(postgres://u:fake@review_pw@db.example:5432)"],
    ];
    for (const [name, input] of ok) {
      it(`маскируется: ${name}`, () => {
        const out = maskSecrets(input, []);
        expect(out).not.toMatch(/fake_review_userinfo|fake_review_pw6|review_pw/);
      });
    }
    it("@ в пути и в query не трогает адрес (ложной маски нет)", () => {
      expect(maskSecrets("GET https://api.example.com/users/@me?mail=a@b.example ok", [])).toBe(
        "GET https://api.example.com/users/@me?mail=a@b.example ok",
      );
    });
    const reg: Array<[string, string]> = [
      ["# в пароле (redis)", "connect redis://:p#fake_review_hash@db.example:6379 failed"],
      ["? в пароле", "GET https://u:p?fake_review_query@api.example.com/x"],
    ];
    for (const [name, input] of reg) {
      it(`маскируется (регрессия): ${name}`, () => {
        expect(maskSecrets(input, [])).not.toMatch(/fake_review_(hash|query)/);
      });
    }
  });

  describe("R8-D поздний DELETE при уже открытой сессии (§14.8 п. 3)", () => {
    it("close() не разрешается, пока DELETE поздней сессии в полёте (сессия S была до close)", async () => {
      const gates: Array<() => void> = [];
      let releaseCall!: (r: Response) => void;
      const fetchMock = vi.fn(async (_url: any, opts: any) => {
        if (opts.method === "DELETE") {
          await new Promise<void>((r) => gates.push(r));
          return new Response("{}");
        }
        const req = JSON.parse(opts.body);
        if (req.method === "tools/call") return await new Promise<Response>((r) => (releaseCall = r));
        return new Response(JSON.stringify({ id: req.id, result: req.method === "tools/list" ? { tools: [] } : {} }), {
          headers: { "content-type": "application/json", "mcp-session-id": "fake_sid_a" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new McpClient({ id: "example", transport: "http", url: "http://127.0.0.1:12345/mcp", defaultClass: "C" } as never);
      try {
        await client.start();
        const callP = client.callTool("x", {});
        for (let i = 0; i < 5; i++) await Promise.resolve();
        releaseCall(
          new Response(JSON.stringify({ id: 999, result: { content: [] } }), {
            headers: { "content-type": "application/json", "mcp-session-id": "fake_sid_b" },
          }),
        );
        let closeResolved = false;
        const closeP = client.close().then(() => (closeResolved = true));
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await callP;
        gates[0]();
        await new Promise((r) => setTimeout(r, 50));
        const st = {
          deletes: fetchMock.mock.calls.filter(([, o]) => o.method === "DELETE").length,
          closeResolved,
          stopped: client.isStopped(),
        };
        gates.forEach((g) => g());
        await closeP;
        expect(st).toEqual({ deletes: 2, closeResolved: false, stopped: false });
      } finally {
        gates.forEach((g) => g());
        liveConnectorClients.delete(client);
      }
    });
  });

  describe("R8-E maskSecrets: линейный регэксп схемы URL (§14.5/§14.6)", () => {
    it("строка 100 000 символов без пробелов маскируется быстрее 100 мс", () => {
      const big = "A".repeat(100_000);
      const t0 = performance.now();
      const masked = maskSecrets(big, []);
      const ms = performance.now() - t0;
      expect(masked).toBe(big);
      expect(ms).toBeLessThan(100);
    });

    it("ответ ручки 50 000 символов без пробелов маскируется быстрее 500 мс", async () => {
      const big = "A".repeat(50_000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_u: any, o: any) => {
          if (o.method === "DELETE") return new Response("{}");
          const req = JSON.parse(o.body);
          const result =
            req.method === "tools/call" ? { content: [{ type: "text", text: big }] } : req.method === "tools/list" ? { tools: [] } : {};
          return new Response(JSON.stringify({ id: req.id, result }), { headers: { "content-type": "application/json" } });
        }),
      );
      const client = new McpClient({ id: "example", transport: "http", url: "http://127.0.0.1:12345/mcp", defaultClass: "R" } as never);
      await client.start();
      const t0 = performance.now();
      const r: any = await client.callTool("read_probe", {});
      const ms = Math.round(performance.now() - t0);
      await client.close();
      expect(r.ok).toBe(true);
      expect(ms).toBeLessThan(500);
    }, 30000);
  });

  describe("R8-F короткие секреты вне коллектора stderr (R7 P3-2, остаток)", () => {
    it("CLI: недопустимый 2-символьный секрет проекта не попадает в E (§14.1, 731afa8)", async () => {
      // 1. Необъявленный секрет проекта короче 3 символов в E не попадает:
      const mock = await approvedMock(fixture({ tools: ["Q7_probe_tool"] }), { projectSecrets: "OTHER_TOK=Q7" });
      const res = await mock.getCli().run(["connectors", "--project", "project_example"]);
      expect(res.stdout).toContain("Q7_probe_tool: C");
      expect(res.stdout).not.toContain("***_probe_tool");

      // 2. Объявление секрета короче 3 символов для коннектора отклоняется с connector_secret_invalid (§14.1):
      const mockInvalid = await approvedMock(fixture({ tools: ["tool1"], secrets: ["FAKE_TOK"] }), { projectSecrets: "FAKE_TOK=Q7" });
      const resInvalid = await mockInvalid.getCli().run(["connectors", "--project", "project_example"]);
      expect(resInvalid.stdout).toContain("connector_secret_invalid");
    }, 20000);

    it("звонок: 3-символьный секрет в ошибке initialize не попадает в событие connector_start_failed и журнал", async () => {
      mockVoice();
      const mock = await approvedMock(
        fixture({ initError: '"auth rejected for token "+process.env.FAKE_TOK', secrets: ["FAKE_TOK"] }),
        { geminiKeys: "fake_review_key", projectSecrets: "FAKE_TOK=k9z" },
      );
      let session: CallSession | undefined;
      const realStart = CallSession.prototype.start;
      vi.spyOn(CallSession.prototype, "start").mockImplementation(async function (this: CallSession) {
        session = this;
        await realStart.call(this);
      });
      const { token } = await mock.getRpc().callToken();
      await mock.getWs().get("/call")!().onMessage({ send: vi.fn(), close: vi.fn() }, JSON.stringify({ type: "hello", protocol: 1, token, projectId: "project_example" }));
      try {
        const rows = mock.db.prepare("select payload from call_events where kind='connector_start_failed'").all() as any[];
        const logs = (mock.api.log.warn as any).mock.calls.flat().map(String).filter((s: string) => s.includes("auth rejected"));
        expect(rows.length).toBe(1);
        expect({ event: rows[0].payload.includes("k9z"), log: logs.some((s: string) => s.includes("k9z")) }).toEqual({ event: false, log: false });
      } finally {
        await session?.end("owner");
      }
    }, 20000);
  });
});

// ============================================================================
// Suite 5: Round-9 (Opus) independent review probes
// ============================================================================
describe("Round-9 Opus independent review probes", () => {
  const scratch: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    liveConnectorClients.clear();
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratchDir() {
    const d = mkdtempSync(join(tmpdir(), "plug117-r9-"));
    scratch.push(d);
    return d;
  }

  function fixture(opts: { pre?: string; tools?: string[]; initError?: string; initDelayMs?: number; secrets?: string[] } = {}) {
    const d = scratchDir(),
      path = join(d, "fixture.mjs");
    writeFileSync(
      path,
      `import readline from "node:readline";
 ${opts.pre ?? ""}
 readline.createInterface({input:process.stdin}).on("line",line=>{
   const r=JSON.parse(line);
   const reply=()=>{
     if(r.method==="initialize"){
       ${opts.initError ? `process.stdout.write(JSON.stringify({id:r.id,error:{code:-32000,message:${opts.initError}}})+"\\n");return;` : ""}
       process.stdout.write(JSON.stringify({id:r.id,result:{}})+"\\n");
     }
     if(r.method==="tools/list")process.stdout.write(JSON.stringify({id:r.id,result:{tools:${JSON.stringify(
       (opts.tools ?? []).map((name) => ({ name, description: "probe", inputSchema: { type: "object", properties: {} } })),
     )}}})+"\\n");
   };
   ${opts.initDelayMs ? `if(r.method==="initialize")setTimeout(reply,${opts.initDelayMs});else reply();` : "reply();"}
 });`,
    );
    return {
      title: "Example",
      connectors: [
        { id: "example", transport: "stdio", command: [process.execPath, path], defaultClass: "C", ...(opts.secrets ? { secrets: opts.secrets } : {}) },
      ],
    };
  }

  async function approvedMock(cfg: any, settings: any = {}) {
    const mock = createMockPluginApi({ projectCalls: JSON.stringify({ project_example: cfg }), ...settings });
    await plugin(mock.api as never);
    const store = new CallStore(mock.db);
    store.setApprovedProject("project_example", hashProjectConfig(cfg), JSON.stringify(cfg));
    return mock;
  }

  // Фиктивный ключ шаблона sk- (не настоящий): после "sk-" 30+ символов; внутри — цифра 7.
  const KEY = "sk-revfake7tailQQQQQQQQQQQQQQQQQQQQ";
  const TAIL = /tailQQQQ/;

  describe("R9-1 недопустимое короткое значение в E ломает шаблоны (§14.1 731afa8: «значение в E не попадает»; §14.6)", () => {
    it("контроль: без короткого значения ключ sk- маскируется целиком", () => {
      expect(maskSecrets(`upstream key ${KEY}`, [])).toBe("upstream key ***");
    });
    it("ядро maskSecrets: значение '7' (1 символ — недопустимо по 731afa8) не должно раскрывать хвост ключа sk-", () => {
      expect(maskSecrets(`upstream key ${KEY}`, ["7"])).not.toMatch(TAIL);
    });
    it("ядро maskSecrets: значение '1' не должно раскрывать хвост Bearer", () => {
      expect(maskSecrets("Authorization: Bearer revfake1tailWWWWWWWW", ["1"])).not.toMatch(/tailWWWW/);
    });
  });

  describe("R9-2 те же каналы end-to-end: CLI, журнал, stderr, callTool", () => {
    it("CLI: ошибка initialize с чужим ключом sk- при RETRY_COUNT=7 в projectSecrets — хвоста ключа нет ни в выводе, ни в журнале", async () => {
      const mock = await approvedMock(fixture({ initError: JSON.stringify(`upstream rejected key ${KEY}`) }), { projectSecrets: "RETRY_COUNT=7" });
      const res = await mock.getCli().run(["connectors", "--project", "project_example"]);
      const logs = [...(mock.api.log.warn as any).mock.calls, ...(mock.api.log.info as any).mock.calls, ...(mock.api.log.error as any).mock.calls]
        .flat()
        .map(String)
        .join("\n");
      expect({ stdout: TAIL.test(res.stdout), log: TAIL.test(logs) }).toEqual({ stdout: false, log: false });
    }, 20000);

    it("stderr коннектора (коллектор §14.6): ключ sk- при RETRY_COUNT=7 — хвоста ключа в журнале нет", async () => {
      const mock = await approvedMock(
        fixture({ pre: `process.stderr.write(${JSON.stringify(`upstream key ${KEY}\n`)});`, tools: ["read_probe"] }),
        { projectSecrets: "RETRY_COUNT=7" },
      );
      await mock.getCli().run(["connectors", "--project", "project_example"]);
      const logs = (mock.api.log.warn as any).mock.calls.flat().map(String).filter((s: string) => s.includes("stderr"));
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((s: string) => TAIL.test(s))).toBe(false);
    }, 20000);

    it("callTool: ответ ручки с ключом sk- при RETRY_COUNT=7 среди секретов — хвоста ключа в результате нет", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_u: any, o: any) => {
          if (o.method === "DELETE") return new Response("{}");
          const req = JSON.parse(o.body);
          const result =
            req.method === "tools/call" ? { content: [{ type: "text", text: `upstream key ${KEY}` }] } : req.method === "tools/list" ? { tools: [] } : {};
          return new Response(JSON.stringify({ id: req.id, result }), { headers: { "content-type": "application/json" } });
        }),
      );
      const client = new McpClient(
        { id: "example", transport: "http", url: "http://127.0.0.1:12345/mcp", defaultClass: "R" } as never,
        { RETRY_COUNT: "7" },
      );
      await client.start();
      const r: any = await client.callTool("read_probe", {});
      await client.close();
      expect(TAIL.test(String(r.data?.result ?? r.error?.message))).toBe(false);
    }, 20000);
  });

  describe("R9-3 недопустимое значение маскирует саму диагностику (§14.1: «в журнале только имя секрета»)", () => {
    it("CLI: FAKE_TOK=in (2 символа) — в выводе цельный код connector_secret_invalid и имя секрета", async () => {
      const mock = await approvedMock(fixture({ tools: ["read_probe"], secrets: ["FAKE_TOK"] }), { projectSecrets: "FAKE_TOK=in" });
      const res = await mock.getCli().run(["connectors", "--project", "project_example"]);
      const logs = (mock.api.log.warn as any).mock.calls.flat().map(String).join("\n");
      expect({ stdout: res.stdout.includes("connector_secret_invalid"), log: logs.includes("connector_secret_invalid") }).toEqual({
        stdout: true,
        log: true,
      });
    }, 20000);
  });

  describe("R9-4 URL-учётки: 9 случаев round-8 на настоящем maskSecrets (§14.6)", () => {
    const cases = [
      "connect (https://u:PWsecret@api.example.com:8443) failed",
      '{"url":"https://u:PWsecret@api.example.com:8443"}',
      "postgres://u:PWsecret@db.example:5432,retry",
      "mysql://u:PWsecret@db.example;timeout=3",
      "https://u:PWsecret@api.example.com:8443.",
      "connect redis://:p#PWsecret@db.example:6379 failed",
      "GET https://u:p?PWsecret@api.example.com/x",
      "https://u:p@PWsecret@[2001:db8::1]:8443/x",
      "clone https://PWsecret@git.example.com/x",
    ];
    for (const c of cases) it(`маскируется: ${c}`, () => expect(maskSecrets(c, [])).not.toContain("PWsecret"));
    for (const c of ["GET https://api.example.com/users/@me?mail=a@b.example ok", "see https://api.example.com/x?y=1 and a@b.example"])
      it(`не трогается: ${c}`, () => expect(maskSecrets(c, [])).toBe(c));
  });

  describe("R9-5 время maskSecrets на враждебных входах 100 000 символов (§14.5)", () => {
    const inputs: Array<[string, string]> = [
      ["A×100k", "A".repeat(100_000)],
      ["a.×50k", "a.".repeat(50_000)],
      ["a:×50k", "a:".repeat(50_000)],
      ["a:// + x×100k без @", "a://" + "x".repeat(100_000)],
      ["ab:/×25k", "ab:/".repeat(25_000)],
      ["x@×50k", "x@".repeat(50_000)],
      ["a://@×20k", "a://@".repeat(20_000)],
      ["token= ×14k", "token= ".repeat(14_000)],
      ["Bearer ×14k", "Bearer ".repeat(14_000)],
      ["sk-×33k", "sk-".repeat(33_000)],
    ];
    for (const [name, s] of inputs)
      it(`${name} < 150 мс`, () => {
        const t0 = performance.now();
        maskSecrets(s, ["abc"]);
        expect(performance.now() - t0).toBeLessThan(150);
      });
  });
});
