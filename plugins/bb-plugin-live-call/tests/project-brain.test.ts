/**
 * Мозговой центр звонка по проекту (§15.9, live-call-project-brain.md §7).
 * Матрица приёмки: окружение, протокол моста, отклонения до MCP, лимиты,
 * конкурентность, завершение, журнал без сырых данных. Только выдуманные данные.
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import type { ServerFrame } from "../src/contract.js";
import { ProjectBrain, resolveProjectBrainEnv, validateConnectorArgs, type BrainReadResult, type BrainReadToolSpec, type ProjectBrainEnv } from "../src/project-brain.js";
import { ProjectRegistryManager } from "../src/project-registry.js";
import { getProjectTools, nativeDeclarations, projectBrainAskTool, brainAskTool } from "../src/tools.js";
import { projectVoiceInstruction } from "../src/prompt.js";

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

type ScriptItem = string | ((ctx: { text: string; requestId: string }) => string);

/** Фейковый тред мозга: send() → owner-кадр + следующая заскриптованная реплика агента. */
function makeBrainThread(scripted: ScriptItem[]) {
  const events: Array<Record<string, unknown>> = [];
  let seq = 0;
  const queue = [...scripted];
  return {
    events,
    send(text: string) {
      seq += 1;
      events.push({ seq, type: "client/turn/requested", data: { input: [{ text }] }, createdAt: Date.now() });
      const next = queue.length > 0 ? queue.shift() : undefined;
      if (next === undefined) return;
      const requestId = /requestId[":\s]+([a-zA-Z0-9_-]+)/.exec(text)?.[1] ?? "";
      const body = typeof next === "function" ? next({ text, requestId }) : next;
      seq += 1;
      events.push({ seq, type: "item/completed", data: { item: { type: "agentMessage", text: body } }, createdAt: Date.now() });
    },
    /** Реплика агента вне send (например, первое «готов» после спавна). */
    deliver(text: string) {
      seq += 1;
      events.push({ seq, type: "item/completed", data: { item: { type: "agentMessage", text } }, createdAt: Date.now() });
    },
  };
}

type BrainThread = ReturnType<typeof makeBrainThread>;

function makeSdk(thread: BrainThread, spawnResult?: Promise<{ id: string }>) {
  const sendCalls: Array<{ threadId: string; text: string }> = [];
  const sdk = {
    threads: {
      spawn: vi.fn(async (args: Record<string, unknown>) => {
        void args;
        return spawnResult ? await spawnResult : { id: "thr_pb1" };
      }),
      send: vi.fn(async (a: { threadId: string; input: Array<{ text: string }> }) => {
        sendCalls.push({ threadId: a.threadId, text: a.input[0].text });
        thread.send(a.input[0].text);
        return {};
      }),
      get: vi.fn(async () => ({ status: "idle" })),
      wait: vi.fn(async () => ({ matched: true })),
      output: vi.fn(async () => ({ output: "" })),
      stop: vi.fn(async () => ({})),
      archive: vi.fn(async () => ({})),
      events: { list: vi.fn(async () => ({ events: thread.events })) },
    },
  };
  return { sdk, sendCalls };
}

function makeBrain(args: {
  sdk: ReturnType<typeof makeSdk>["sdk"];
  store: CallStore;
  callId?: string;
  readTools?: BrainReadToolSpec[];
  executeRead?: (tool: string, a: Record<string, unknown>, t: number) => Promise<BrainReadResult>;
  env?: () => Promise<ProjectBrainEnv>;
  recentContext?: () => string;
  secretValues?: string[];
  storageDir: string;
  callsProjectId?: string;
}) {
  return new ProjectBrain({
    sdk: args.sdk as never,
    store: args.store,
    callId: args.callId ?? "call_pb1",
    projectId: "proj_p1",
    projectTitle: "CRM",
    nowUtc: "2026-11-07T00:00:00.000Z",
    readTools: args.readTools ?? [
      { name: "crm__get_info", description: "инфо" },
      { name: "crm__list_clients", description: "список клиентов" },
    ],
    executeRead: args.executeRead ?? (async () => ({ ok: true, result: "данные", ms: 1 })),
    recentContext: args.recentContext ?? (() => "Владелец: сколько регистраций за сегодня"),
    env: args.env ?? (async () => ({ kind: "service" }) as ProjectBrainEnv),
    callsProjectId: args.callsProjectId ?? "proj_calls",
    storageDir: args.storageDir,
    secretValues: args.secretValues ?? [],
  });
}

const testDir = join(tmpdir(), `test-pbrain-${Date.now()}`);
const eventsOf = (store: CallStore, callId: string) => store.transcript(callId).map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) }));
const read = (tool: string, args: Record<string, unknown> = {}) => (ctx: { requestId: string }) =>
  `{"requestId":"${ctx.requestId}","kind":"read","tool":"${tool}","arguments":${JSON.stringify(args)}}`;
const answer = (text: string, evidence: string[] = [], limitations: string[] = []) => (ctx: { requestId: string }) =>
  `{"requestId":"${ctx.requestId}","kind":"answer","answer":${JSON.stringify(text)},"evidence":${JSON.stringify(evidence)},"limitations":${JSON.stringify(limitations)}}`;

describe("1. Окружение мозга проектного звонка (§2, §7)", () => {
  const sdkFor = (envs: Array<Record<string, unknown>> | Error, sources: unknown[] | undefined) => ({
    projects: { get: vi.fn(async () => ({ name: "CRM", sources })) },
    environments: {
      list: vi.fn(async () => {
        if (envs instanceof Error) throw envs;
        return envs;
      }),
    },
  });

  it("git-проект локально: worktree на hostId источника, именованная ветка", async () => {
    const sdk = sdkFor([{ hostId: "h1", path: "/p", isGitRepo: true, branchName: "dev" }], [{ hostId: "h1", path: "/p", isDefault: true }]);
    const env = await resolveProjectBrainEnv({ sdk: sdk as never, projectId: "proj_p1", localHostId: "h1" });
    expect(env).toEqual({ kind: "git", hostId: "h1", branchName: "dev" });
  });

  it("git-проект на другом хосте: метаданные с hostId источника, чужой путь локально не проверяется", async () => {
    const fakeRemotePath = join(testDir, "remote-src");
    mkdirSync(join(fakeRemotePath, ".git"), { recursive: true });
    const sdk = sdkFor([{ hostId: "h_remote", path: fakeRemotePath, isGitRepo: true, branchName: "main" }], [{ hostId: "h_remote", path: fakeRemotePath, isDefault: true }]);
    const env = await resolveProjectBrainEnv({ sdk: sdk as never, projectId: "proj_p1", localHostId: "h1" });
    expect(env).toEqual({ kind: "git", hostId: "h_remote", branchName: "main" });
    rmSync(fakeRemotePath, { recursive: true, force: true });
  });

  it("удалённый хост без метаданных окружения → unavailable, без локальной проверки чужого пути", async () => {
    const fakeRemotePath = join(testDir, "remote-src-git");
    mkdirSync(join(fakeRemotePath, ".git"), { recursive: true });
    const sdk = sdkFor([], [{ hostId: "h_remote", path: fakeRemotePath, isDefault: true }]);
    const env = await resolveProjectBrainEnv({ sdk: sdk as never, projectId: "proj_p1", localHostId: "h1" });
    expect(env.kind).toBe("unavailable");
    rmSync(fakeRemotePath, { recursive: true, force: true });
  });

  it("удалённый хост, environments.list недоступен → unavailable с причиной", async () => {
    const sdk = sdkFor(new Error("rpc down"), [{ hostId: "h_remote", path: "/p", isDefault: true }]);
    const env = await resolveProjectBrainEnv({ sdk: sdk as never, projectId: "proj_p1", localHostId: "h1" });
    expect(env.kind).toBe("unavailable");
  });

  it("non-git проект → служебный проект звонков; без него → unavailable", async () => {
    const sdk = sdkFor([{ hostId: "h1", path: "/p", isGitRepo: false }], [{ hostId: "h1", path: "/p", isDefault: true }]);
    expect(await resolveProjectBrainEnv({ sdk: sdk as never, projectId: "p", localHostId: "h1", fallbackProjectId: "proj_calls" })).toEqual({ kind: "service" });
    const noFb = await resolveProjectBrainEnv({ sdk: sdk as never, projectId: "p", localHostId: "h1" });
    expect(noFb.kind).toBe("unavailable");
  });

  it("проект без источников → служебный проект", async () => {
    const sdk = sdkFor([], []);
    expect(await resolveProjectBrainEnv({ sdk: sdk as never, projectId: "p", localHostId: "h1", fallbackProjectId: "proj_calls" })).toEqual({ kind: "service" });
  });
});

describe("2. Запуск мозга: один скрытый тред с заданной моделью (§2)", () => {
  it("git: spawn в проект с managed-worktree на hostId источника, файл контекста записан", async () => {
    const dir = join(testDir, "s1");
    const thread = makeBrainThread([]);
    const { sdk } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({
      sdk: sdk as never,
      store,
      storageDir: dir,
      env: async () => ({ kind: "git", hostId: "h1", branchName: "dev" }) as ProjectBrainEnv,
    });
    expect(await brain.start()).toBe("thr_pb1");
    expect(sdk.threads.spawn).toHaveBeenCalledTimes(1);
    const a = sdk.threads.spawn.mock.calls[0][0] as Record<string, unknown>;
    expect(a.projectId).toBe("proj_p1");
    expect(a.providerId).toBe("acp-devin");
    expect(a.model).toBe("swe-2-flash-medium");
    expect(a.reasoningLevel).toBe("medium");
    expect(a.permissionMode).toBe("full");
    expect(a.visibility).toBe("hidden");
    expect(a.environment).toEqual({ type: "host", hostId: "h1", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "dev" } } });
    const prompt = String(a.prompt);
    expect(prompt).toContain('kind":"read"');
    expect(prompt).toContain("crm__get_info");
    expect(prompt).toContain("не больше 8 чтений");
    expect(prompt).toContain("brain-history-call_pb1.txt");
    expect(readFileSync(join(dir, "brain-history-call_pb1.txt"), "utf8")).toContain("сколько регистраций");
    expect(eventsOf(store, "call_pb1").map((e) => e.kind)).toContain("brain_started");
    expect(await brain.start()).toBe("thr_pb1");
    expect(sdk.threads.spawn).toHaveBeenCalledTimes(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("non-git: spawn в служебный проект с project-default", async () => {
    const dir = join(testDir, "s2");
    const thread = makeBrainThread([]);
    const { sdk } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir });
    expect(await brain.start()).toBe("thr_pb1");
    const a = sdk.threads.spawn.mock.calls[0][0] as Record<string, unknown>;
    expect(a.projectId).toBe("proj_calls");
    expect(a.environment).toEqual({ type: "project-default" });
    expect(String(a.prompt)).toContain("служебной папке звонков");
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawn не удался → явный unavailable, мозг в общую папку не уходит", async () => {
    const dir = join(testDir, "s3");
    const thread = makeBrainThread([]);
    const { sdk } = makeSdk(thread);
    sdk.threads.spawn.mockRejectedValue(new Error("worktree unsupported"));
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({
      sdk: sdk as never,
      store,
      storageDir: dir,
      env: async () => ({ kind: "git", hostId: "h1", branchName: "dev" }) as ProjectBrainEnv,
    });
    expect(await brain.start()).toBeNull();
    expect(brain.state).toBe("unavailable");
    expect(sdk.threads.spawn).toHaveBeenCalledTimes(1);
    const res = await brain.ask("вопрос");
    expect(res.ok).toBe(false);
    if (!res.ok && "error" in res) expect(res.error.code).toBe("unavailable");
    expect(eventsOf(store, "call_pb1").map((e) => e.kind)).toContain("brain_failed");
    rmSync(dir, { recursive: true, force: true });
  });

  it("секреты в файл контекста не пишутся", async () => {
    const dir = join(testDir, "s4");
    const thread = makeBrainThread([]);
    const { sdk } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const secret = "SECRET-VALUE-1234567890";
    const brain = makeBrain({
      sdk: sdk as never,
      store,
      storageDir: dir,
      secretValues: [secret],
      recentContext: () => `токен ${secret} в тексте`,
    });
    await brain.start();
    const content = readFileSync(join(dir, "brain-history-call_pb1.txt"), "utf8");
    expect(content).not.toContain(secret);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("3. Мост чтения коннекторов (§3, §7)", () => {
  it("вопрос → read → результат → answer с evidence и limitations; requestId серверный", async () => {
    const dir = join(testDir, "b1");
    const thread = makeBrainThread([
      read("crm__get_info", { period: "today" }),
      answer("за сегодня трое", ["crm__get_info: 3 за сегодня"]),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const executeRead = vi.fn(async (tool: string, args: Record<string, unknown>, t: number) => {
      expect(tool).toBe("crm__get_info");
      expect(args).toEqual({ period: "today" });
      expect(t).toBeLessThanOrEqual(30_000);
      return { ok: true, result: "новых за сегодня: 3", truncated: false, ms: 5 };
    });
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir, executeRead });
    await brain.start();
    const res = await brain.ask("сколько новых пользователей за сегодня");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { answer: string; evidence: string[]; limitations: string[] };
      expect(d.answer).toBe("за сегодня трое");
      expect(d.evidence[0]).toContain("crm__get_info");
    }
    expect(executeRead).toHaveBeenCalledTimes(1);
    const requestId = /requestId[":\s]+([a-zA-Z0-9_-]+)/.exec(sendCalls[0].text)?.[1] ?? "";
    expect(requestId).toMatch(/^pbq-call_pb1-1$/);
    const rr = JSON.parse(sendCalls.find((c) => c.text.includes('"kind":"read_result"'))!.text);
    expect(rr.requestId).toBe(requestId);
    expect(rr.step).toBe(1);
    expect(rr.result).toBe("новых за сегодня: 3");
    expect(rr.truncated).toBe(false);
    const ans = eventsOf(store, "call_pb1").find((e) => e.kind === "brain_answer");
    expect(ans?.payload.requestId).toBe(requestId);
    expect(ans?.payload.status).toBe("ok");
    expect(JSON.stringify(ans)).not.toContain("сколько новых пользователей");
    rmSync(dir, { recursive: true, force: true });
  });

  it("C/P/L/twoStep/неизвестное/brain_ask/list_threads — отказ до исполнения чтения", async () => {
    const dir = join(testDir, "b2");
    const thread = makeBrainThread([
      read("crm__write_c"),
      read("crm__two_step"),
      read("brain_ask"),
      read("list_threads"),
      read("no_such_tool"),
      answer("данных нет", [], ["нет нужного инструмента"]),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const executeRead = vi.fn(async () => ({ ok: true, result: "x" } as BrainReadResult));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir, executeRead });
    await brain.start();
    const res = await brain.ask("проверь всё");
    expect(res.ok).toBe(true);
    expect(executeRead).not.toHaveBeenCalled();
    const errors = sendCalls.filter((c) => c.text.includes('"kind":"read_error"'));
    expect(errors.length).toBe(5);
    for (const e of errors) expect(e.text).toContain("tool_not_allowed");
    const rejected = eventsOf(store, "call_pb1").filter((e) => e.kind === "brain_read" && e.payload.status === "tool_not_allowed");
    expect(rejected.length).toBe(5);
    expect(JSON.stringify(rejected)).not.toContain("arguments");
    rmSync(dir, { recursive: true, force: true });
  });

  it("requestId другого вопроса отклоняется; правильный принимается", async () => {
    const dir = join(testDir, "b3");
    const thread = makeBrainThread([
      '{"requestId":"pbq-call_pb1-OLD","kind":"answer","answer":"старый ответ"}',
      answer("правильный"),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir });
    await brain.start();
    const res = await brain.ask("вопрос");
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { answer: string }).answer).toBe("правильный");
    expect(sendCalls.some((c) => c.text.includes("wrong_requestId"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("неверный JSON → контролируемая коррекция, затем ответ", async () => {
    const dir = join(testDir, "b4");
    const thread = makeBrainThread(["это не JSON вообще", answer("ок")]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir });
    await brain.start();
    const res = await brain.ask("вопрос");
    expect(res.ok).toBe(true);
    expect(sendCalls.some((c) => c.text.includes("invalid_json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("лимит 8 чтений: девятое — read_error, исполнено ровно 8", async () => {
    const dir = join(testDir, "b5");
    const thread = makeBrainThread([
      ...Array.from({ length: 9 }, () => read("crm__list_clients")),
      answer("не хватило данных", [], ["не все страницы прочитаны"]),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const executeRead = vi.fn(async () => ({ ok: true, result: "page", truncated: false, ms: 1 } as BrainReadResult));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir, executeRead });
    await brain.start();
    const res = await brain.ask("посчитай всех");
    expect(res.ok).toBe(true);
    expect(executeRead).toHaveBeenCalledTimes(8);
    expect(sendCalls.some((c) => c.text.includes("read_limit"))).toBe(true);
    if (res.ok) expect((res.data as { limitations: string[] }).limitations.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("truncated доходит до мозга и в итог; maskedFullText мозгу не отдаётся", async () => {
    const dir = join(testDir, "b6");
    const thread = makeBrainThread([
      read("crm__list_clients"),
      answer("данные неполные", [], ["ответ обрезан"]),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const executeRead = vi.fn(async () => ({ ok: true, result: "обрезанная страница…", truncated: true, ms: 2 } as BrainReadResult));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir, executeRead });
    await brain.start();
    const res = await brain.ask("все клиенты");
    expect(res.ok).toBe(true);
    const rr = JSON.parse(sendCalls.find((c) => c.text.includes('"kind":"read_result"'))!.text);
    expect(rr.truncated).toBe(true);
    if (res.ok) {
      const d = res.data as { partial?: boolean; truncatedReads?: number };
      expect(d.partial).toBe(true);
      expect(d.truncatedReads).toBe(1);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("два чтения с одним requestId исполняются оба; повтор того же хода не исполняется", async () => {
    const dir = join(testDir, "b8");
    const thread = makeBrainThread([
      read("crm__get_info", { n: 1 }),
      read("crm__list_clients", { n: 2 }),
      answer("готово"),
    ]);
    const { sdk } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const seenArgs: Array<Record<string, unknown>> = [];
    const executeRead = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      seenArgs.push({ tool, ...args });
      return { ok: true, result: "r", ms: 1 } as BrainReadResult;
    });
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir, executeRead });
    await brain.start();
    const res = await brain.ask("два чтения");
    expect(res.ok).toBe(true);
    expect(seenArgs).toEqual([
      { tool: "crm__get_info", n: 1 },
      { tool: "crm__list_clients", n: 2 },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("параллельный brain_ask → busy без смешивания запросов", async () => {
    const dir = join(testDir, "b7");
    const thread = makeBrainThread([]);
    const { sdk } = makeSdk(thread);
    let releaseSend: () => void = () => {};
    sdk.threads.send.mockImplementationOnce(() => new Promise((r) => { releaseSend = () => r({}); }));
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir });
    await brain.start();
    const first = brain.ask("первый");
    const second = await brain.ask("второй");
    expect(second.ok).toBe(false);
    if (!second.ok && "error" in second) expect(second.error.code).toBe("busy");
    releaseSend();
    await brain.archive();
    await first.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("4. Таймауты и завершение (§3, §5, §7)", () => {
  it("мозг не отвечает → контролируемый timeout в бюджете вопроса", async () => {
    vi.useFakeTimers();
    try {
      const dir = join(testDir, "t1");
      const thread = makeBrainThread([]);
      const { sdk } = makeSdk(thread);
      const store = new CallStore(new Database(":memory:"));
      const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir });
      await brain.start();
      const q = brain.ask("вечный вопрос");
      await vi.advanceTimersByTimeAsync(121_000);
      const res = await q;
      expect(res.ok).toBe(false);
      if (!res.ok && "error" in res) expect(res.error.code).toBe("timeout");
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("end во время чтения: поздний ответ не озвучивается, ask — cancelled", async () => {
    const dir = join(testDir, "t2");
    const thread = makeBrainThread([read("crm__get_info")]);
    const { sdk } = makeSdk(thread);
    let releaseRead: (v: BrainReadResult) => void = () => {};
    const executeRead = vi.fn(() => new Promise<BrainReadResult>((r) => { releaseRead = r; }));
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir, executeRead });
    await brain.start();
    const q = brain.ask("вопрос");
    await new Promise((r) => setTimeout(r, 50));
    await brain.archive();
    releaseRead({ ok: true, result: "поздно", ms: 5 });
    const res = await q;
    expect(res.ok).toBe(false);
    if (!res.ok && "error" in res) expect(res.error.code).toBe("cancelled");
    rmSync(dir, { recursive: true, force: true });
  });

  it("archive: stop+archive один раз, повторная без побочных эффектов", async () => {
    const dir = join(testDir, "t3");
    const thread = makeBrainThread([]);
    const { sdk } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir });
    await brain.start();
    await brain.archive();
    expect(sdk.threads.stop).toHaveBeenCalledTimes(1);
    expect(sdk.threads.archive).toHaveBeenCalledTimes(1);
    await brain.archive();
    expect(sdk.threads.stop).toHaveBeenCalledTimes(1);
    expect(sdk.threads.archive).toHaveBeenCalledTimes(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("спавн, завершившийся после end(), останавливается и архивируется", async () => {
    const dir = join(testDir, "t4");
    const thread = makeBrainThread([]);
    let releaseSpawn: (v: { id: string }) => void = () => {};
    const { sdk } = makeSdk(thread, new Promise((r) => { releaseSpawn = r; }));
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir });
    const p = brain.start();
    await new Promise((r) => setTimeout(r, 10));
    await brain.archive();
    releaseSpawn({ id: "thr_late" });
    expect(await p).toBeNull();
    expect(sdk.threads.stop).toHaveBeenCalledWith({ threadId: "thr_late" });
    expect(sdk.threads.archive).toHaveBeenCalledWith({ threadId: "thr_late" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("5. Инструменты и инструкция голоса (§4)", () => {
  it("проектный набор: brain_ask есть, brain_task нет; описание отдельное от тредового", () => {
    const tools = getProjectTools([]);
    const names = tools.map((t) => t.name);
    expect(names).toContain("brain_ask");
    expect(names).toContain("end_call");
    expect(names).toContain("remember");
    expect(names).toContain("recall");
    expect(names).toContain("list_threads");
    expect(names).toContain("read_thread");
    expect(names).not.toContain("brain_task");
    expect(projectBrainAskTool.description).not.toBe(brainAskTool.description);
    const decls = nativeDeclarations(undefined, [], true) as Array<{ functionDeclarations: Array<{ name: string }> }>;
    const declNames = decls.flatMap((d) => d.functionDeclarations.map((f) => f.name));
    expect(declNames).toContain("brain_ask");
    expect(declNames).not.toContain("brain_task");
  });

  it("projectVoiceInstruction: brain_ask для расчётов/периода, честность про вебхуки и «Новый»", () => {
    const text = projectVoiceInstruction({
      projectTitle: "CRM",
      projectId: "proj_p1",
      nowUtc: "2026-11-07T00:00:00Z",
      memory: [],
      availableTools: ["crm__get_info", "brain_ask"],
    });
    expect(text).toContain("brain_ask");
    expect(text).toContain("вебхук");
    expect(text).toContain("Новый");
    expect(text).toContain("не выдавай догадку");
  });
});

describe("6. Ротация и журнал (§5, §7)", () => {
  it("файл контекста старше 90 дней удаляется ротацией", () => {
    const dir = join(testDir, "rot");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "brain-history-call_old.txt");
    writeFileSync(f, "старый контекст");
    const old = Date.now() - 91 * 24 * 3600 * 1000;
    utimesSync(f, old / 1000, old / 1000);
    const store = new CallStore(new Database(":memory:"));
    store.rotate(Date.now(), dir);
    expect(() => readFileSync(f, "utf8")).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ошибки brain_ask: в tool_error нет args и исходного вопроса, нет сырого ответа мозга", async () => {
    const dir = join(testDir, "sec");
    const thread = makeBrainThread([]);
    const { sdk } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir, env: async () => ({ kind: "unavailable", reason: "нет изолированного окружения" }) as ProjectBrainEnv });
    await brain.start();
    FakeWs.all = [];
    const frames: ServerFrame[] = [];
    const session = new CallSession({
      callId: "call_sec",
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
      targetProjectId: "proj_p1",
    });
    (session as never as { projectBrain: unknown }).projectBrain = brain;
    const MARKER = "МАРКЕР-ИСХОДНЫЙ-ВОПРОС-СЕКРЕТ";
    const fakeClient = { sendToolResponse: vi.fn() };
    await (session as never as { handleNativeCalls(c: unknown, calls: unknown): Promise<void> }).handleNativeCalls(
      fakeClient,
      [{ id: "fn1", name: "brain_ask", args: { question: MARKER } }],
    );
    const toolErrors = store.transcript("call_sec").filter((r) => r.kind === "tool_error");
    expect(toolErrors.length).toBeGreaterThan(0);
    for (const e of toolErrors) {
      expect(e.payload).not.toContain(MARKER);
      expect(e.payload).not.toContain('"args"');
    }
    const res = fakeClient.sendToolResponse.mock.calls[0][1] as { ok: boolean; error?: { code: string; message: string } };
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(MARKER);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("7. Интеграция: вопрос → скрытый тред → реальный mock MCP → ответ (§7)", () => {
  it("проектный звонок без targetThreadId: мозг читает коннектор через мост, ответ идёт голосу", async () => {
    const dir = join(testDir, "int");
    const fixturePath = join(__dirname, "../research/fixtures/test-connector.mjs");
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);
    const rawRegistry = JSON.stringify({
      proj_p1: {
        title: "CRM",
        connectors: [
          {
            id: "test",
            transport: "stdio",
            command: ["/usr/bin/node", fixturePath],
            tools: { get_info: "R", set_status: "C", create_record: "C", forbidden_action: "deny" },
            defaultClass: "C",
            twoStep: ["create_record"],
          },
        ],
      },
    });
    const hash = mgr.listProjects(rawRegistry)[0].hash!;
    mgr.approve("proj_p1", hash, rawRegistry);

    const thread = makeBrainThread([
      read("test__get_info"),
      read("test__set_status", { status: "x" }),
      read("test__create_record", { title: "y" }),
      answer("сервис в норме", ["test__get_info"]),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const projectSdk = {
      ...sdk,
      projects: {
        get: vi.fn(async () => ({ name: "CRM", sources: [{ hostId: "h1", path: "/no/such/path", isDefault: true }] })),
        list: vi.fn(async () => [{ id: "proj_p1", name: "CRM" }]),
      },
      environments: { list: vi.fn(async () => [{ hostId: "h1", path: "/no/such/path", isGitRepo: false }]) },
      system: { config: vi.fn(async () => ({ primaryHostId: "h1" })) },
    };

    FakeWs.all = [];
    const session = new CallSession({
      callId: "call_int",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: projectSdk as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
      targetProjectId: "proj_p1",
      projectRegistry: mgr,
      rawProjectRegistry: rawRegistry,
      callsProjectId: "proj_calls",
      storageDir: dir,
      projectSecrets: {},
    });
    await session.start();
    expect(session.projectBrain).not.toBeNull();
    const fakeClient = { sendToolResponse: vi.fn() };
    await (session as never as { handleNativeCalls(c: unknown, calls: unknown): Promise<void> }).handleNativeCalls(
      fakeClient,
      [{ id: "fn1", name: "brain_ask", args: { question: "проверь статус сервиса" } }],
    );
    const res = fakeClient.sendToolResponse.mock.calls[0][1] as { ok: boolean; data?: { answer: string } };
    expect(res.ok).toBe(true);
    expect(res.data?.answer).toBe("сервис в норме");
    // Реальный MCP-вызов дошёл до фикстуры и результат вернулся мозгу.
    const readResult = sendCalls.find((c) => c.text.includes('"kind":"read_result"'))!;
    expect(readResult.text).toContain("test-connector status: OK");
    // C-ручка и двухшаговая — отказ до MCP: connector_call только у get_info.
    const connCalls = store.transcript("call_int").filter((r) => r.kind === "connector_call");
    expect(connCalls).toHaveLength(1);
    expect(connCalls[0].payload).toContain("get_info");

    await session.end("owner");
    expect(sdk.threads.stop).toHaveBeenCalled();
    expect(sdk.threads.archive).toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("первое приветствие не ждёт запуск мозга (медленный спавн)", async () => {
    const dir = join(testDir, "slow");
    const store = new CallStore(new Database(":memory:"));
    const thread = makeBrainThread([]);
    let releaseSpawn: (v: { id: string }) => void = () => {};
    const { sdk } = makeSdk(thread, new Promise((r) => { releaseSpawn = r; }));
    const projectSdk = {
      ...sdk,
      projects: {
        get: vi.fn(async () => ({ name: "CRM", sources: [{ hostId: "h1", path: "/x", isDefault: true }] })),
        list: vi.fn(async () => []),
      },
      environments: { list: vi.fn(async () => [{ hostId: "h1", path: "/x", isGitRepo: false }]) },
      system: { config: vi.fn(async () => ({ primaryHostId: "h1" })) },
    };
    FakeWs.all = [];
    const session = new CallSession({
      callId: "call_slow",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: projectSdk as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
      targetProjectId: "proj_p1",
      callsProjectId: "proj_calls",
      storageDir: dir,
      projectSecrets: {},
    });
    const started = session.start();
    await expect(Promise.race([started.then(() => "started"), new Promise((r) => setTimeout(() => r("still_waiting"), 3000))])).resolves.toBe("started");
    releaseSpawn({ id: "thr_pb_slow" });
    await started;
    await new Promise((r) => setTimeout(r, 50));
    await session.end("owner");
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});

describe("8. Ревью координатора (findings 1–5, P3)", () => {
  const strictSchema = {
    type: "object",
    properties: {
      period: { type: "string", enum: ["today", "week"] },
      n: { type: "integer", minimum: 1 },
    },
    required: ["period"],
    additionalProperties: false,
  };

  it("(1) validateConnectorArgs: required/type/enum/additionalProperties по исходной схеме", () => {
    expect(validateConnectorArgs(strictSchema, { period: "today", n: 2 })).toBeNull();
    expect(validateConnectorArgs(strictSchema, {})).toContain("period");
    expect(validateConnectorArgs(strictSchema, { period: "month" })).toContain("enum");
    expect(validateConnectorArgs(strictSchema, { period: "today", n: "x" })).toContain("integer");
    expect(validateConnectorArgs(strictSchema, { period: "today", n: 0 })).toContain("minimum");
    expect(validateConnectorArgs(strictSchema, { period: "today", extra: 1 })).toContain("лишнее");
    expect(validateConnectorArgs(undefined, { anything: true })).toBeNull();
  });

  it("(1) read: неверные arguments до MCP — invalid_arguments, исполнения нет", async () => {
    const dir = join(testDir, "r1");
    const thread = makeBrainThread([
      read("crm__metric", {}), // нет обязательного period
      read("crm__metric", { period: "month" }), // вне enum
      read("crm__metric", { period: "today", n: "x" }), // тип
      read("crm__metric", { period: "today", extra: 1 }), // additionalProperties:false
      (ctx) => `{"requestId":"${ctx.requestId}","kind":"read","tool":"crm__metric","arguments":["today"]}`, // не объект
      read("crm__metric", { period: "today", n: 3 }), // валидное — исполняется
      answer("готово"),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const executeRead = vi.fn(async (_t: string, _a: Record<string, unknown>, _ms: number) => ({ ok: true, result: "42", ms: 1 } as BrainReadResult));
    const brain = makeBrain({
      sdk: sdk as never,
      store,
      storageDir: dir,
      readTools: [{ name: "crm__metric", description: "метрика", mcpSchema: strictSchema }],
      executeRead,
    });
    await brain.start();
    const res = await brain.ask("метрика");
    expect(res.ok).toBe(true);
    expect(executeRead).toHaveBeenCalledTimes(1);
    expect(executeRead.mock.calls[0][1]).toEqual({ period: "today", n: 3 });
    const invalid = sendCalls.filter((c) => c.text.includes("invalid_arguments"));
    expect(invalid.length).toBe(5);
    const rejEvents = eventsOf(store, "call_pb1").filter((e) => e.kind === "brain_read" && e.payload.status === "invalid_arguments");
    expect(rejEvents.length).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("(2) зависший send: timeout в бюджете, busy освобождается, вызовов после дедлайна нет", async () => {
    vi.useFakeTimers();
    try {
      const dir = join(testDir, "r2");
      const thread = makeBrainThread([]);
      const { sdk } = makeSdk(thread);
      let sendCount = 0;
      sdk.threads.send.mockImplementation(async () => {
        sendCount += 1;
        return new Promise(() => {}); // зависает навсегда
      });
      const store = new CallStore(new Database(":memory:"));
      const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir });
      await brain.start();
      const q = brain.ask("вопрос");
      await vi.advanceTimersByTimeAsync(121_000);
      const res = await q;
      expect(res.ok).toBe(false);
      if (!res.ok && "error" in res) expect(res.error.code).toBe("timeout");
      expect(sendCount).toBe(1); // после дедлайна новых вызовов не было
      // busy освобождён: следующий ask — не busy (тоже timeout, SDK всё ещё висит).
      const q2 = brain.ask("ещё");
      await vi.advanceTimersByTimeAsync(121_000);
      const res2 = await q2;
      expect(res2.ok).toBe(false);
      if (!res2.ok && "error" in res2) expect(res2.error.code).toBe("timeout");
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("(2) зависшие events.list и wait: тот же контролируемый timeout", async () => {
    vi.useFakeTimers();
    try {
      const dir = join(testDir, "r3");
      const thread = makeBrainThread([]);
      const { sdk } = makeSdk(thread);
      sdk.threads.events.list.mockImplementation(() => new Promise(() => {}));
      sdk.threads.wait.mockImplementation(() => new Promise(() => {}));
      const store = new CallStore(new Database(":memory:"));
      const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir });
      await brain.start();
      const q = brain.ask("вопрос");
      await vi.advanceTimersByTimeAsync(121_000);
      const res = await q;
      expect(res.ok).toBe(false);
      if (!res.ok && "error" in res) expect(res.error.code).toBe("timeout");
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("(2) остаток бюджета доходит до MCP: timeoutMs чтения < 30 с при израсходованном времени", async () => {
    vi.useFakeTimers();
    try {
      const dir = join(testDir, "r4");
      const thread = makeBrainThread([read("crm__get_info"), answer("ок")]);
      const { sdk } = makeSdk(thread);
      // Первый send (вопрос) съедает ~95 с бюджета.
      const origSend = sdk.threads.send.getMockImplementation();
      sdk.threads.send.mockImplementationOnce(async (a: { input: Array<{ text: string }> }) => {
        await new Promise((r) => setTimeout(r, 95_000));
        return origSend!(a as never);
      });
      const store = new CallStore(new Database(":memory:"));
      let readTimeout = -1;
      const executeRead = vi.fn(async (_t: string, _a: Record<string, unknown>, tmo: number) => {
        readTimeout = tmo;
        return { ok: true, result: "x", ms: 1 } as BrainReadResult;
      });
      const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir, executeRead });
      await brain.start();
      const q = brain.ask("вопрос");
      await vi.advanceTimersByTimeAsync(119_000);
      const res = await q;
      expect(res.ok).toBe(true);
      expect(readTimeout).toBeGreaterThan(0);
      expect(readTimeout).toBeLessThan(30_000);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("(2) executeBrainRead передаёт остаток реальному McpClient.callTool", async () => {
    const dir = join(testDir, "r5");
    const fixturePath = join(__dirname, "../research/fixtures/test-connector.mjs");
    const store = new CallStore(new Database(":memory:"));
    const mgr = new ProjectRegistryManager(store);
    const rawRegistry = JSON.stringify({
      proj_p1: {
        title: "CRM",
        connectors: [
          { id: "test", transport: "stdio", command: ["/usr/bin/node", fixturePath], tools: { get_info: "R" }, defaultClass: "deny" },
        ],
      },
    });
    mgr.approve("proj_p1", mgr.listProjects(rawRegistry)[0].hash!, rawRegistry);
    FakeWs.all = [];
    const session = new CallSession({
      callId: "call_r5",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: { projects: { get: async () => ({ name: "CRM", sources: [] }), list: async () => [] } } as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
      targetProjectId: "proj_p1",
      projectRegistry: mgr,
      rawProjectRegistry: rawRegistry,
      storageDir: dir,
      projectSecrets: {},
    });
    await session.start();
    const client = (session as never as { connectorClients: Array<{ callTool: (...a: unknown[]) => Promise<unknown> }> }).connectorClients[0];
    const spy = vi.spyOn(client, "callTool");
    const res = await (session as never as { executeBrainRead(t: string, a: Record<string, unknown>, tmo: number): Promise<BrainReadResult> }).executeBrainRead("test__get_info", {}, 7000);
    expect(res.ok).toBe(true);
    expect(spy.mock.calls[0][2]).toBe(7000); // min(30000, 7000) дошёл до реального callTool
    await session.end("owner");
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it("(3) source без hostId/пути → unavailable, а не подтверждённый non-git", async () => {
    const mk = (sources: unknown[]) => ({
      projects: { get: vi.fn(async () => ({ name: "P", sources })) },
      environments: { list: vi.fn(async () => []) },
    });
    const noHost = await resolveProjectBrainEnv({ sdk: mk([{ path: "/p", isDefault: true }]) as never, projectId: "p", localHostId: "h1", fallbackProjectId: "proj_calls" });
    expect(noHost.kind).toBe("unavailable");
    const noPath = await resolveProjectBrainEnv({ sdk: mk([{ hostId: "h1", isDefault: true }]) as never, projectId: "p", localHostId: "h1", fallbackProjectId: "proj_calls" });
    expect(noPath.kind).toBe("unavailable");
  });

  it("(3) env на том же host с другим путём не характеризует default source", async () => {
    // Удалённый хост: окружение только с другим путём → честный unavailable.
    const remote = {
      projects: { get: vi.fn(async () => ({ name: "P", sources: [{ hostId: "h_remote", path: "/src/path", isDefault: true }] })) },
      environments: { list: vi.fn(async () => [{ hostId: "h_remote", path: "/other/env", isGitRepo: true, branchName: "dev" }]) },
    };
    const envRemote = await resolveProjectBrainEnv({ sdk: remote as never, projectId: "p", localHostId: "h1", fallbackProjectId: "proj_calls" });
    expect(envRemote.kind).toBe("unavailable");
    // Локальный хост: env с другим путём игнорируется, но fs-проверка source.path
    // по-прежнему работает (известные non-git/local проекты не ломаются).
    const localDir = join(testDir, "local-src");
    mkdirSync(localDir, { recursive: true });
    const local = {
      projects: { get: vi.fn(async () => ({ name: "P", sources: [{ hostId: "h1", path: localDir, isDefault: true }] })) },
      environments: { list: vi.fn(async () => [{ hostId: "h1", path: "/other/env", isGitRepo: true }]) },
    };
    expect(await resolveProjectBrainEnv({ sdk: local as never, projectId: "p", localHostId: "h1", fallbackProjectId: "proj_calls" })).toEqual({ kind: "service" });
    mkdirSync(join(localDir, ".git"), { recursive: true });
    const gitEnv = await resolveProjectBrainEnv({ sdk: local as never, projectId: "p", localHostId: "h1", fallbackProjectId: "proj_calls" });
    expect(gitEnv.kind).toBe("git");
    rmSync(localDir, { recursive: true, force: true });
  });

  it("(4) синтетический секрет не проходит ни одну строку границы мозга", async () => {
    const dir = join(testDir, "r6");
    const SECRET = "SECRET-BRAIN-BOUNDARY-987654";
    const thread = makeBrainThread([
      read("crm__get_info"),
      answer(`итог ${SECRET}`, [`ev ${SECRET}`], [`lim ${SECRET}`]),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const brain = makeBrain({
      sdk: sdk as never,
      store,
      storageDir: dir,
      secretValues: [SECRET],
      recentContext: () => `контекст с ${SECRET}`,
      env: async () => ({ kind: "service" }) as ProjectBrainEnv,
    });
    const brainAny = brain as never as { opts: { promptMd?: string } };
    brainAny.opts.promptMd = `инструкция ${SECRET}`;
    await brain.start();
    const spawnArgs = sdk.threads.spawn.mock.calls[0][0] as Record<string, unknown>;
    expect(String(spawnArgs.prompt)).not.toContain(SECRET);
    expect(readFileSync(join(dir, "brain-history-call_pb1.txt"), "utf8")).not.toContain(SECRET);
    const res = await brain.ask(`вопрос про ${SECRET}`);
    const allSends = sendCalls.map((c) => c.text).join("\n");
    expect(allSends).not.toContain(SECRET);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { answer: string; evidence: string[]; limitations: string[] };
      expect(d.answer).not.toContain(SECRET);
      expect(d.answer).toContain("***");
      expect(d.evidence[0]).not.toContain(SECRET);
      expect(d.limitations[0]).not.toContain(SECRET);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("(5) end во время initProjectConnectors: мозг не создаётся, треда нет", async () => {
    const dir = join(testDir, "r7");
    const store = new CallStore(new Database(":memory:"));
    const thread = makeBrainThread([]);
    const { sdk } = makeSdk(thread);
    let releaseGet: (v: unknown) => void = () => {};
    const getHeld = new Promise((r) => { releaseGet = r; });
    const projectSdk = {
      ...sdk,
      projects: {
        get: vi.fn(() => getHeld),
        list: vi.fn(async () => []),
      },
      environments: { list: vi.fn(async () => []) },
      system: { config: vi.fn(async () => ({ primaryHostId: "h1" })) },
    };
    FakeWs.all = [];
    const session = new CallSession({
      callId: "call_r7",
      keys: ["k1"],
      voice: "Algenib",
      languageCode: "ru-RU",
      thinkingLevel: "LOW",
      mode: "normal",
      routerInput: "text",
      maxCallMinutes: 60,
      store,
      sdk: projectSdk as never,
      toBrowser: () => {},
      sendBrowserAudio: () => {},
      spawnCallThread: async () => null,
      advanceCallThread: async () => {},
      sayCallThread: async () => {},
      endCallThread: async () => {},
      wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
      targetProjectId: "proj_p1",
      callsProjectId: "proj_calls",
      storageDir: dir,
      projectSecrets: {},
    });
    const started = session.start().catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    await session.end("owner");
    releaseGet({ name: "CRM", sources: [{ hostId: "h1", path: "/x", isDefault: true }] });
    await started;
    await new Promise((r) => setTimeout(r, 50));
    expect(session.projectBrain).toBeNull();
    expect(sdk.threads.spawn).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("(P3) пакет из 2+ agentMessage: первый — значимый read, исполняется ровно 1 раз", async () => {
    const dir = join(testDir, "r8");
    const thread = makeBrainThread([]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const executeRead = vi.fn(async () => ({ ok: true, result: "x", ms: 1 } as BrainReadResult));
    const brain = makeBrain({ sdk: sdk as never, store, storageDir: dir, executeRead });
    await brain.start();
    const q = brain.ask("пакет");
    await new Promise((r) => setTimeout(r, 30));
    const requestId = /requestId[":\s]+([a-zA-Z0-9_-]+)/.exec(sendCalls[0].text)?.[1] ?? "";
    // SDK отдал одним пакетом: commentary без JSON → значимый read → answer.
    thread.deliver("комментарий без протокола");
    thread.deliver(`{"requestId":"${requestId}","kind":"read","tool":"crm__get_info","arguments":{}}`);
    thread.deliver(`{"requestId":"${requestId}","kind":"answer","answer":"ок"}`);
    const res = await q;
    expect(res.ok).toBe(true);
    // Commentary обработан контролируемо, read дошёл ровно один раз, answer не потерян.
    expect(executeRead).toHaveBeenCalledTimes(1);
    expect(sendCalls.some((c) => c.text.includes("invalid_json"))).toBe(true);
    expect(sendCalls.some((c) => c.text.includes('"kind":"read_result"'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("9. Повторное ревью: узел schema validation", () => {
  it("composition — отдельное условие узла: соседний required не пропускается", () => {
    const schema = {
      type: "object",
      required: ["period"],
      anyOf: [{ properties: { kind: { enum: ["d", "w"] } } }],
    };
    // Раньше: anyOf совпал → early return, required игнорировался.
    expect(validateConnectorArgs(schema, { kind: "d" })).toContain("period");
    expect(validateConnectorArgs(schema, { period: "x", kind: "d" })).toBeNull();
    const schemaOneOf = {
      type: "object",
      required: ["period"],
      oneOf: [{ properties: { kind: { enum: ["d"] } } }, { required: ["n"] }],
    };
    expect(validateConnectorArgs(schemaOneOf, { kind: "d" })).toContain("period");
  });

  it("oneOf: ровно одно совпадение, два — ошибка", () => {
    const schema = { oneOf: [{ type: "string" }, { type: ["string", "null"] }] };
    expect(validateConnectorArgs(schema, "abc" as never)).toContain("больше одного");
    expect(validateConnectorArgs(schema, 5 as never)).toBeTruthy();
    const okSchema = { oneOf: [{ type: "string" }, { type: "number" }] };
    expect(validateConnectorArgs(okSchema, "abc" as never)).toBeNull();
    expect(validateConnectorArgs(okSchema, 5 as never)).toBeNull();
  });

  it("allOf: все ветки обязаны совпасть, включая соседние assertions", () => {
    const schema = {
      type: "object",
      allOf: [{ required: ["a"] }, { properties: { b: { type: "number" } } }],
    };
    expect(validateConnectorArgs(schema, { b: 1 })).toContain("a");
    expect(validateConnectorArgs(schema, { a: 1, b: "x" })).toBeTruthy();
    expect(validateConnectorArgs(schema, { a: 1, b: 2 })).toBeNull();
  });

  it("own-property: constructor/toString прототипа не подменяют поля", () => {
    expect(validateConnectorArgs({ type: "object", required: ["constructor"] }, {})).toContain("constructor");
    expect(
      validateConnectorArgs({ type: "object", properties: {}, additionalProperties: false }, { toString: 1 }),
    ).toContain("toString");
    expect(
      validateConnectorArgs(
        { type: "object", properties: { kind: { enum: ["d"] } }, additionalProperties: false },
        { kind: "d", constructor: "x" },
      ),
    ).toContain("constructor");
  });

  it("локальный $ref поддержан; внешний/циклический — unsupported_schema до MCP", () => {
    const schema = {
      type: "object",
      properties: { period: { $ref: "#/$defs/period" } },
      required: ["period"],
      $defs: { period: { type: "string", enum: ["d", "w"] } },
    };
    expect(validateConnectorArgs(schema, { period: "d" })).toBeNull();
    expect(validateConnectorArgs(schema, { period: "x" })).toContain("enum");
    expect(validateConnectorArgs(schema, {})).toContain("period");
    // Внешний URI — не поддерживаем молча.
    const external = { properties: { a: { $ref: "https://example.com/s.json#/x" } } };
    expect(validateConnectorArgs(external, { a: 1 })).toContain("unsupported_schema");
    // Циклические локальные refs — лимит рекурсии → unsupported, не зависание.
    const cycle = { $defs: { a: { $ref: "#/b" }, b: { $ref: "#/a" } }, properties: { v: { $ref: "#/a" } } };
    expect(validateConnectorArgs(cycle, { v: 1 })).toContain("unsupported_schema");
  });

  it("not поддержан; if/then — честный unsupported_schema", () => {
    const notSchema = { type: "string", not: { const: "x" } };
    expect(validateConnectorArgs(notSchema, "x" as never)).toContain("not");
    expect(validateConnectorArgs(notSchema, "y" as never)).toBeNull();
    const ifSchema = { type: "object", if: { properties: { a: { const: 1 } } }, then: { required: ["b"] } };
    expect(validateConnectorArgs(ifSchema, { a: 1 })).toContain("unsupported_schema");
  });

  it("простые валидные MCP-схемы продолжают проходить", () => {
    expect(validateConnectorArgs({ type: "object", properties: { long: { type: "boolean" }, secret_echo: { type: "string" } } }, { long: true, secret_echo: "s" })).toBeNull();
    expect(validateConnectorArgs({ type: "object", properties: {}, additionalProperties: true }, { a: 1, b: "x" })).toBeNull();
    expect(validateConnectorArgs({ properties: { ids: { type: "array", items: { type: "integer" } } } }, { ids: [1, 2, 3] })).toBeNull();
    expect(validateConnectorArgs({ properties: { ids: { type: "array", items: { type: "integer" } } } }, { ids: [1, "x"] })).toBeTruthy();
    expect(validateConnectorArgs({ type: "object", properties: { v: { type: "string" }, n: { type: "number", minimum: 0 } } }, {})).toBeNull();
  });

  it("неверные arguments новых форм отклоняются до executeRead (0 вызовов)", async () => {
    const dir = join(testDir, "r9");
    const thread = makeBrainThread([
      read("crm__combo", { kind: "d" }), // нет обязательного period рядом с anyOf
      read("crm__ref", { period: "x" }), // вне enum через $ref
      read("crm__not", { v: "x" }), // нарушает not
      read("crm__unsup", { a: 1 }), // if/then — unsupported_schema
      answer("готово"),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const executeRead = vi.fn(async (_t: string, _a: Record<string, unknown>, _ms: number) => ({ ok: true, result: "x" } as BrainReadResult));
    const brain = makeBrain({
      sdk: sdk as never,
      store,
      storageDir: dir,
      readTools: [
        {
          name: "crm__combo",
          description: "combo",
          mcpSchema: { type: "object", required: ["period"], anyOf: [{ properties: { kind: { enum: ["d", "w"] } } }] },
        },
        {
          name: "crm__ref",
          description: "ref",
          mcpSchema: { type: "object", properties: { period: { $ref: "#/$defs/p" } }, $defs: { p: { enum: ["d"] } } },
        },
        { name: "crm__not", description: "not", mcpSchema: { properties: { v: { type: "string", not: { const: "x" } } } } },
        { name: "crm__unsup", description: "unsup", mcpSchema: { type: "object", if: { properties: { a: { const: 1 } } }, then: { required: ["b"] } } },
      ],
      executeRead,
    });
    await brain.start();
    const res = await brain.ask("проверь");
    expect(res.ok).toBe(true);
    expect(executeRead).not.toHaveBeenCalled();
    const errors = sendCalls.filter((c) => c.text.includes('"kind":"read_error"'));
    expect(errors.length).toBe(4);
    expect(errors.filter((c) => c.text.includes("invalid_arguments")).length).toBe(3);
    expect(errors.some((c) => c.text.includes("unsupported_schema"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("10. Финальный дефект: boolean-схемы и allowlist ключей", () => {
  it("false-схема отклоняет во всех позициях; true и not:false пропускают", () => {
    expect(validateConnectorArgs({ type: "object", properties: { forbidden: false } }, { forbidden: 1 })).toBeTruthy();
    expect(validateConnectorArgs({ type: "object", properties: { forbidden: false } }, {})).toBeNull();
    expect(validateConnectorArgs({ allOf: [false] }, { a: 1 })).toBeTruthy();
    expect(validateConnectorArgs({ type: "object", properties: { a: true } }, { a: 1 })).toBeNull();
    expect(validateConnectorArgs({ type: "object", properties: { v: { type: "string", not: false } } }, { v: "x" })).toBeNull();
    expect(validateConnectorArgs({ properties: { v: { not: true } } }, { v: "x" })).toBeTruthy();
    expect(validateConnectorArgs(false, { a: 1 })).toBeTruthy();
    expect(validateConnectorArgs(true, { a: 1 })).toBeNull();
  });

  it("items:false отклоняет непустой массив, пустой проходит; $ref на false отклоняет", () => {
    const itemsFalse = { type: "object", properties: { list: { type: "array", items: false } } };
    expect(validateConnectorArgs(itemsFalse, { list: [1] })).toBeTruthy();
    expect(validateConnectorArgs(itemsFalse, { list: [] })).toBeNull();
    const refFalse = { type: "object", properties: { v: { $ref: "#/$defs/f" } }, $defs: { f: false } };
    expect(validateConnectorArgs(refFalse, { v: 1 })).toBeTruthy();
  });

  it("minProperties/maxProperties считают own-keys; additionalProperties-схема и unused $defs", () => {
    expect(validateConnectorArgs({ type: "object", minProperties: 1 }, {})).toBeTruthy();
    expect(validateConnectorArgs({ type: "object", minProperties: 1 }, { a: 1 })).toBeNull();
    expect(validateConnectorArgs({ type: "object", maxProperties: 1 }, { a: 1, b: 2 })).toBeTruthy();
    expect(validateConnectorArgs({ type: "object", additionalProperties: { type: "string" } }, { a: "x" })).toBeNull();
    expect(validateConnectorArgs({ type: "object", additionalProperties: { type: "string" } }, { a: 5 })).toBeTruthy();
    // $defs есть, но не используется — не запрещается.
    expect(validateConnectorArgs({ type: "object", $defs: { unused: { type: "number" } } }, {})).toBeNull();
  });

  it("неизвестный keyword и malformed-узел — unsupported_schema, не успех", () => {
    expect(validateConnectorArgs({ type: "object", unknownKeyword: true }, {})).toContain("unsupported_schema");
    expect(validateConnectorArgs({ type: "object", patternProperties: { "^x": {} } }, { x1: 1 })).toContain("unsupported_schema");
    expect(validateConnectorArgs({ type: "object", properties: { a: 5 } }, { a: 1 })).toContain("unsupported_schema");
    expect(validateConnectorArgs({ type: "object", properties: { a: { type: "string", weird: 1 } } }, { a: "s" })).toContain("unsupported_schema");
    expect(validateConnectorArgs({ properties: { list: { type: "array", items: [ { type: "number" } ] } } }, { list: [1] })).toContain("unsupported_schema");
    expect(validateConnectorArgs({ type: "object", required: "a" }, {})).toContain("unsupported_schema");
  });

  it("executeRead=0 регрессии: forbidden:false, allOf:[false], minProperties, ref→false, items:false", async () => {
    const dir = join(testDir, "r10");
    const thread = makeBrainThread([
      read("crm__forbidden", { forbidden: 1 }),
      read("crm__allfalse", { a: 1 }),
      read("crm__minprops", {}),
      read("crm__reffalse", { v: 1 }),
      read("crm__itemsfalse", { list: [1] }),
      read("crm__unknown", { a: 1 }),
      answer("готово"),
    ]);
    const { sdk, sendCalls } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const executeRead = vi.fn(async (_t: string, _a: Record<string, unknown>, _ms: number) => ({ ok: true, result: "x" } as BrainReadResult));
    const brain = makeBrain({
      sdk: sdk as never,
      store,
      storageDir: dir,
      readTools: [
        { name: "crm__forbidden", description: "f", mcpSchema: { type: "object", properties: { forbidden: false } } },
        { name: "crm__allfalse", description: "f", mcpSchema: { allOf: [false] } },
        { name: "crm__minprops", description: "f", mcpSchema: { type: "object", minProperties: 1 } },
        { name: "crm__reffalse", description: "f", mcpSchema: { type: "object", properties: { v: { $ref: "#/$defs/f" } }, $defs: { f: false } } },
        { name: "crm__itemsfalse", description: "f", mcpSchema: { type: "object", properties: { list: { type: "array", items: false } } } },
        { name: "crm__unknown", description: "f", mcpSchema: { type: "object", if: { properties: { a: { const: 1 } } }, then: {} } },
      ],
      executeRead,
    });
    await brain.start();
    const res = await brain.ask("проверь");
    expect(res.ok).toBe(true);
    expect(executeRead).not.toHaveBeenCalled();
    const errors = sendCalls.filter((c) => c.text.includes('"kind":"read_error"'));
    expect(errors.length).toBe(6);
    expect(errors.filter((c) => c.text.includes("invalid_arguments")).length).toBe(5);
    expect(errors.some((c) => c.text.includes("unsupported_schema"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("положительные простые схемы проходят к executeRead", async () => {
    const dir = join(testDir, "r11");
    const thread = makeBrainThread([
      read("crm__get_info", { long: true }),
      answer("ок"),
    ]);
    const { sdk } = makeSdk(thread);
    const store = new CallStore(new Database(":memory:"));
    const executeRead = vi.fn(async () => ({ ok: true, result: "ok", ms: 1 } as BrainReadResult));
    const brain = makeBrain({
      sdk: sdk as never,
      store,
      storageDir: dir,
      readTools: [
        {
          name: "crm__get_info",
          description: "инфо",
          mcpSchema: { type: "object", properties: { long: { type: "boolean" }, secret_echo: { type: "string" } } },
        },
      ],
      executeRead,
    });
    await brain.start();
    const res = await brain.ask("инфо");
    expect(res.ok).toBe(true);
    expect(executeRead).toHaveBeenCalledTimes(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
