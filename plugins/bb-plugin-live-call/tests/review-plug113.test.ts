/** Регрессии по ревью PLUG-113: стабильный хеш подтверждения (A), хвост реплики (B). */
import { describe, expect, it, vi } from "vitest";
import { ConfirmationGate } from "../src/confirmation-gate.js";
import { DEFAULT_WORDS } from "../src/classify.js";
import { runToolCall, toolByName } from "../src/tools.js";

function fakeClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > target) break;
      timers.shift(); now = t.at; t.fn();
    }
    now = target;
  };
  return { clock, advance, get now() { return now; } };
}

const sdkWithThread = (thread: () => Record<string, unknown>) => ({
  threads: {
    list: vi.fn(async () => [thread()]),
    listRunning: vi.fn(async () => []),
    search: vi.fn(async () => ({ active: { results: [] } })),
    get: vi.fn(async () => thread()),
    send: vi.fn(async () => ({ ok: true, delivery: "sent" })),
    events: { list: vi.fn(async () => []) },
  },
  projects: { list: vi.fn(async () => []) },
});

describe("A: хеш подтверждения не зависит от меняющейся записи треда", () => {
  it("повтор после approve (тред ожил) — «уже выполнено», без нового pending", async () => {
    let updatedAt = 100;
    const sdk = sdkWithThread(() => ({ id: "thr_42", title: "Парсер", projectId: "p1", status: "idle", updatedAt }));
    const gate = new ConfirmationGate(DEFAULT_WORDS);
    const ctx = { sdk, gate, reportAction: () => {}, ledger: { add: () => {} } };
    const tool = toolByName("send_to_thread")!;
    await runToolCall(tool, { thread: "Парсер", text: "привет" }, "c1", ctx as never);
    const p1 = gate.pendingConfirmation()!;
    gate.decide(p1.confirmationId, "approve");
    updatedAt += 5;
    gate.consume(p1.confirmationId);
    const r2 = await runToolCall(tool, { thread: "Парсер", text: "привет" }, "c2", ctx as never);
    expect(gate.pendingConfirmation()).toBeNull();
    expect(JSON.stringify(r2.result)).toContain("recent_verdict");
  });

  it("повтор, пока ждёт подтверждение, — та же запись, а не pending_exists", async () => {
    let updatedAt = 100;
    const sdk = sdkWithThread(() => ({ id: "thr_42", title: "Парсер", projectId: "p1", status: "active", updatedAt: updatedAt++ }));
    const gate = new ConfirmationGate(DEFAULT_WORDS);
    const ctx = { sdk, gate, reportAction: () => {}, ledger: { add: () => {} } };
    const tool = toolByName("send_to_thread")!;
    const r1 = await runToolCall(tool, { thread: "Парсер", text: "привет" }, "c1", ctx as never);
    const r2 = await runToolCall(tool, { thread: "Парсер", text: "привет" }, "c2", ctx as never);
    const id = (r: unknown) => (r as { needsConfirmation?: { confirmationId: string } }).needsConfirmation?.confirmationId;
    expect(id(r2.result)).toBeDefined();
    expect(id(r2.result)).toBe(id(r1.result));
  });
});

describe("B: реплика, начатая раньше 1,5 с, — хвост просьбы целиком", () => {
  const setup = () => {
    const t = fakeClock();
    const verdicts: string[] = [];
    const gate = new ConfirmationGate(DEFAULT_WORDS, t.clock as never, { onVerdict: (_p, v) => verdicts.push(v) });
    gate.request("send_to_thread", { text: "Готово" }, "C", "Отправить в «CRM»: «Готово»?");
    gate.onModelAudio(1, 48000 * 5, t.now);
    gate.onModelTranscript("Отправить в «CRM»: «Готово»?", t.now + 100); // вопрос звучит
    return { t, gate, verdicts };
  };

  it("«…и» на 1,2 с, «давай» на 1,6 с без паузы — не ответ", () => {
    const { t, gate, verdicts } = setup();
    t.advance(1200);
    gate.onOwnerTranscriptChunk(" и", t.now);
    t.advance(400);
    gate.onOwnerTranscriptChunk(" давай", t.now);
    t.advance(800);
    expect(verdicts).toEqual([]);
  });

  it("после паузы ≥700 мс новое «да» засчитывается", () => {
    const { t, gate, verdicts } = setup();
    t.advance(1200);
    gate.onOwnerTranscriptChunk(" и", t.now);
    t.advance(1500);
    gate.onOwnerTranscriptChunk("да", t.now);
    t.advance(800);
    expect(verdicts).toEqual(["approved"]);
  });
});
