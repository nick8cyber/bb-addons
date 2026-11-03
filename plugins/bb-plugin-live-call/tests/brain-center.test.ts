import { describe, expect, it, vi } from "vitest";
import { BrainCenter } from "../src/brain-center.js";
import { brainAskTool, brainTaskTool } from "../src/tools.js";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function mockStore() {
  const events: Array<{ type: string; payload?: unknown }> = [];
  return {
    events,
    event: (callId: string, type: string, payload?: unknown) => {
      events.push({ type, payload });
    },
  };
}

describe("BrainCenter (§12.11)", () => {
  const testDir = join(tmpdir(), `test-brain-${Date.now()}`);

  it("сохраняет все сообщения в файл и запускает скрытый тред agy в отдельном worktree", async () => {
    const store = mockStore();
    let spawnArgs: Record<string, unknown> | null = null;
    const sdk = {
      threads: {
        spawn: vi.fn(async (args: Record<string, unknown>) => {
          spawnArgs = args;
          return { id: "thr_brain_1" };
        }),
        get: vi.fn(async () => ({ environment: { path: "/mock/worktree" } })),
        wait: vi.fn(async () => ({ matched: true })),
        output: vi.fn(async () => ({ output: "Сводка: цель треда — тест, сделано всё." })),
        stop: vi.fn(async () => ({})),
        archive: vi.fn(async () => ({})),
      },
    };

    const brain = new BrainCenter({
      sdk: sdk as never,
      store: store as never,
      callId: "call_test_1",
      targetThreadId: "thr_target_1",
      targetThreadTitle: "Тестовый тред",
      targetProjectId: "proj_test_1",
      targetHostId: "host_test_1",
      targetBranchName: "feat/my-branch",
      isGitRepo: true,
      allMessages: [
        { number: 1, role: "owner", text: "Привет", createdAt: new Date("2026-11-03T18:00:00Z").getTime() },
        { number: 2, role: "agent", text: "Здравствуйте", createdAt: new Date("2026-11-03T18:01:00Z").getTime() },
      ],
      storageDir: testDir,
    });

    let summaryReceived: string | null = null;
    brain.onSummaryReady = (s) => {
      summaryReceived = s;
    };

    const threadId = await brain.start();
    expect(threadId).toBe("thr_brain_1");
    expect(spawnArgs).not.toBeNull();
    const args = spawnArgs as unknown as Record<string, unknown>;
    expect(args.providerId).toBe("agy");
    expect(args.model).toBe("gemini-3.8-flash-medium");
    expect(args.visibility).toBe("hidden");
    expect(args.environment).toEqual({
      type: "host",
      hostId: "host_test_1",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "feat/my-branch" },
      },
    });

    // Проверяем запись в файл
    const historyFile = join(testDir, "brain-history-call_test_1.txt");
    const content = readFileSync(historyFile, "utf8");
    expect(content).toContain("[1] Владелец (03.11 18:00):\nПривет");
    expect(content).toContain("[2] Агент (03.11 18:01):\nЗдравствуйте");

    // Ожидаем завершения waitInitialSummary
    await new Promise((r) => setTimeout(r, 100));
    expect(summaryReceived).toContain("цель треда — тест");

    // Проверяем события в журнале
    const evTypes = store.events.map((e) => e.type);
    expect(evTypes).toContain("brain_started");
    expect(evTypes).toContain("brain_summary");

    // Очистка
    await brain.archive();
    expect(sdk.threads.stop).toHaveBeenCalledWith({ threadId: "thr_brain_1" });
    expect(sdk.threads.archive).toHaveBeenCalledWith({ threadId: "thr_brain_1" });
    rmSync(testDir, { recursive: true, force: true });
  });

  it("brain_ask: класс R, задаёт вопрос и фиксирует событие brain_answer", async () => {
    expect(brainAskTool.cls).toBe("R");
    const store = mockStore();
    const sdk = {
      threads: {
        send: vi.fn(async () => ({})),
        wait: vi.fn(async () => ({ matched: true })),
        output: vi.fn(async () => ({ output: "Ответ мозгового центра: всё в порядке." })),
      },
    };

    const brain = new BrainCenter({
      sdk: sdk as never,
      store: store as never,
      callId: "call_test_2",
      targetThreadId: "thr_target_2",
      targetThreadTitle: "Тред",
      targetProjectId: "proj_1",
      allMessages: [],
      storageDir: testDir,
    });
    brain.threadId = "thr_brain_2";

    const res = await brain.ask("Каков статус теста?");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as any)?.answer).toBe("Ответ мозгового центра: всё в порядке.");
    }
    expect(sdk.threads.send).toHaveBeenCalled();
    const ev = store.events.find((e) => e.type === "brain_answer");
    expect(ev).toBeDefined();
    expect((ev?.payload as Record<string, unknown>).tool).toBe("brain_ask");
  });

  it("brain_task: класс C с подтверждением «да»; при активном треде возвращает target_active", async () => {
    expect(brainTaskTool.cls).toBe("C");
    expect(brainTaskTool.word).toBe("да");

    const store = mockStore();
    const sdk = {
      threads: {
        send: vi.fn(async () => ({})),
        wait: vi.fn(async () => ({ matched: true })),
        output: vi.fn(async () => ({ output: "Файл создан успешно" })),
      },
    };

    const brain = new BrainCenter({
      sdk: sdk as never,
      store: store as never,
      callId: "call_test_3",
      targetThreadId: "thr_target_3",
      targetThreadTitle: "Тред",
      targetProjectId: "proj_1",
      allMessages: [],
      storageDir: testDir,
    });
    brain.threadId = "thr_brain_3";
    brain.canModify = true; // worktree создан (start() в этом тесте не вызывается)

    // 1) Целевой тред активен -> ошибка target_active
    const busyRes = await brain.task("создай файл", async () => true);
    expect(busyRes.ok).toBe(false);
    if (!busyRes.ok && "error" in busyRes) {
      expect(busyRes.error.code).toBe("target_active");
      expect(busyRes.error.message).toContain("агент треда сейчас работает — передать задачу ему?");
    }
    expect(sdk.threads.send).not.toHaveBeenCalled();

    // 2) Целевой тред свободен -> выполнение
    const freeRes = await brain.task("создай файл test-brain.txt", async () => false);
    expect(freeRes.ok).toBe(true);
    if (freeRes.ok) {
      expect((freeRes.data as any)?.result).toBe("Файл создан успешно");
    }
    expect(sdk.threads.send).toHaveBeenCalled();
    const ev = store.events.find((e) => e.type === "brain_answer" && (e.payload as Record<string, unknown>).tool === "brain_task");
    expect(ev).toBeDefined();
  });
});

describe("BrainCenter — изоляция (§12.11 п.1, приёмка 03.11)", () => {
  const mk = (spawn: (a: Record<string, unknown>) => Promise<unknown>, isGitRepo: boolean) =>
    new BrainCenter({
      sdk: { threads: { spawn: vi.fn(spawn), get: vi.fn(async () => ({})), wait: vi.fn(async () => ({ matched: true })), output: vi.fn(async () => ({ output: "ok" })), stop: vi.fn(async () => ({})), archive: vi.fn(async () => ({})) } } as never,
      store: mockStore() as never,
      callId: "call_iso",
      targetThreadId: "thr_target_iso",
      targetThreadTitle: "Тред",
      targetProjectId: "proj_iso",
      targetBranchName: "feat/x",
      isGitRepo,
      allMessages: [{ number: 1, role: "owner", text: "Привет", createdAt: 0 }],
      storageDir: join(tmpdir(), `test-brain-iso-${Date.now()}-${Math.random()}`),
    });

  it("worktree не создался → в общую папку проекта не уходит, мозгового центра нет", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const b = mk(async (a) => { calls.push(a); throw new Error("worktree unsupported"); }, true);
    expect(await b.start()).toBeNull();
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls[0].environment)).toContain("managed-worktree");
    expect(calls.some((a) => JSON.stringify(a.environment).includes("project-default"))).toBe(false);
    expect(b.canModify).toBe(false);
  });

  it("не-git проект → мозговой центр в отдельной пустой папке (personal), без права изменений", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let prompt = "";
    const b = mk(async (a) => { calls.push(a); prompt = String(a.prompt); return { id: "thr_brain_personal" }; }, false);
    expect(await b.start()).toBe("thr_brain_personal");
    const env = JSON.stringify(calls[0].environment);
    expect(env).toContain('"personal"');
    expect(env).not.toContain("project-default");
    expect(env).not.toContain("managed-worktree");
    expect(b.canModify).toBe(false);
    expect(prompt).toContain("файлов проекта здесь нет");
    const r = await b.task("создай файл", async () => false);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("changes_unavailable");
  });

  it("git-проект и worktree создан → изменения разрешены", async () => {
    const b = mk(async () => ({ id: "thr_brain_rw" }), true);
    await b.start();
    expect(b.canModify).toBe(true);
  });
});
