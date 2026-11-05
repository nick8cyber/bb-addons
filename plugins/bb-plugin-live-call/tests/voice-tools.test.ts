import { describe, expect, it } from "vitest";
import { toolByName } from "../src/tools.js";

const now = Date.now();
const projects = [{ id: "p_bb", name: "BB" }, { id: "p_x", name: "Проект X" }];
const threads = [
  { id: "t1", title: "Разработка плагина", projectId: "p_bb", status: "active", updatedAt: now - 60_000, providerId: "claude-code" },
  { id: "t2", title: "Аудит", projectId: "p_x", status: "active", updatedAt: now - 120_000, providerId: "agy" },
  { id: "t3", title: "Старый", projectId: "p_bb", status: "error", updatedAt: now - 3_600_000, providerId: "codex" },
  { id: "t4", title: "Вопрос", projectId: "p_bb", status: "idle", hasPendingInteraction: true, updatedAt: now - 30_000, providerId: "codex" },
  { id: "c1", title: "📞 Звонок", projectId: "p_calls", status: "active", updatedAt: now, providerId: "live-call" },
  { id: "h1", title: "скрытый", projectId: "p_bb", status: "active", updatedAt: now, visibility: "hidden" },
];
const sdk = {
  projects: { list: async () => projects },
  threads: {
    // Нарочно игнорирует projectId: тест держится на фильтре в threadIndex, а не на фейке.
    list: async () => threads,
    get: async ({ threadId }: { threadId: string }) => threads.find((t) => t.id === threadId),
    listRunning: async () => threads.filter((t) => t.status === "active"),
    output: async () => ({ output: "Упёрся в 5-часовой лимит, жду сброса." }),
    search: async () => ({ active: { results: [{ thread: threads[1] }] }, archived: { results: [] } }),
    events: { list: async () => [{ data: { input: [{ text: "Продолжай аудит модуля оплат" }] } }] },
  },
};
const ctx = { sdk, reportAction: () => {}, callsProjectId: () => null } as never;

describe("инструменты чтения отдают модели правду", () => {
  it("list_threads учитывает проект: в BB есть работающий тред", async () => {
    const r = (await toolByName("list_threads")!.execute({ project: "BB" }, ctx)) as { ok: true; data: { threads: Array<{ id: string; state: string; project: string }> } };
    expect(r.ok).toBe(true);
    const ids = r.data.threads.map((t) => t.id);
    expect(ids).toEqual(["t4", "t1", "t3"]); // новые сверху, без звонков и скрытых, только BB
    expect(r.data.threads.find((t) => t.id === "t1")!.state).toBe("работает");
    expect(r.data.threads.find((t) => t.id === "t4")!.state).toBe("ждёт тебя");
    expect(r.data.threads[0].project).toBe("BB");
  });
  it("list_threads по статусу working", async () => {
    const r = (await toolByName("list_threads")!.execute({ status: "working" }, ctx)) as { ok: true; data: { threads: Array<{ id: string }> } };
    expect(r.data.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
  it("bb_overview считает по проектам и не пустые «ждёт тебя» и ошибки", async () => {
    const r = (await toolByName("bb_overview")!.execute({}, ctx)) as { ok: true; data: Record<string, Array<{ id?: string; project?: string; working?: number }>> };
    expect(r.data.working.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(r.data.waitingForOwner.map((t) => t.id)).toEqual(["t4"]);
    expect(r.data.recentErrors.map((t) => t.id)).toEqual(["t3"]);
    expect(r.data.projects.find((p) => p.project === "BB")!.working).toBe(1);
  });
  it("read_thread работающего треда: старый ответ помечен как прошлый, есть текущая задача", async () => {
    const r = (await toolByName("read_thread")!.execute({ thread: "t2" }, ctx)) as { ok: true; data: { thread: { state: string }; currentTask?: string; note: string } };
    expect(r.data.thread.state).toBe("работает");
    expect(r.data.currentTask).toBe("Продолжай аудит модуля оплат");
    expect(r.data.note).toMatch(/ПРОШЛОГО хода/);
  });
});
