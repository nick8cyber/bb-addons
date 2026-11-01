import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const NOTICE = "Не удалось перевести ревью на русский; показан оригинал";
const EN_SUMMARY = "State is saved too late";
const EN_DETAILS = "- The function returns before the database commit completes.";
const RU_TEXT = {
  summary: "Состояние сохраняется слишком поздно",
  details: "- Функция возвращает результат до завершения записи.",
};
const context = makePluginAgentConfigurationContext({
  thread: { id: "thread-primary", title: "Implement feature" },
  provider: { id: "codex", model: "gpt-6.1-sol" },
});
const finding = (severity = "concern", summary = EN_SUMMARY, details = EN_DETAILS, key = "none", resolved = "none") =>
  ["ADVISOR_RESULT", "severity: " + severity, "key: " + key,
    "summary: " + summary, "details:", details, "resolved: " + resolved,
    "END_ADVISOR_RESULT"].join("\n");

type SendArgs = { threadId: string; input?: readonly { type: string; text?: string }[] };
type Panel = {
  reviewing: boolean;
  reviews: { severity: string; summary: string; details: string; chainId: number; repeatCount: number; closedAt: number | null }[];
};
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.useRealTimers();
});

async function fixture(settings: Record<string, string | boolean> = {}) {
  let seq = 42;
  let raw = finding();
  let translated = JSON.stringify(RU_TEXT);
  let phase: "review" | "translation" = "review";
  const response = (id: string) => makeThreadResponse({
    id, projectId: context.project.id, environmentId: context.environment.id,
    providerId: "codex", title: id === "thread-primary" ? "Implement feature" : "Advisor",
    status: "idle",
  });
  const spawn = vi.fn(async (_args: { prompt?: string }) => {
    phase = "review";
    return response("thread-advisor");
  });
  const sendDefault = async (args: SendArgs) => {
    if (args.threadId === "thread-advisor") {
      const prompt = args.input?.find((item) => item.type === "text")?.text ?? "";
      phase = prompt.startsWith("Переведи готовое ревью") ? "translation" : "review";
    }
    return { ok: true as const };
  };
  const send = vi.fn(sendDefault);
  const wait = vi.fn(async (): Promise<{ matched: boolean }> => ({ matched: true }));
  const output = vi.fn(async (): Promise<{ output: string | null }> =>
    ({ output: phase === "review" ? raw : translated }));
  const stop = vi.fn(async () => ({ ok: true as const }));
  const host = createFakePluginHost({
    pluginId: "advisor",
    settings: { autoReview: false, outputLanguage: "ru", ...settings },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => response(threadId),
        timeline: async () => ({
          maxSeq: seq,
          rows: [{ kind: "conversation", role: "assistant", text: "Implemented it." }],
        }),
        spawn, send, wait, output, stop,
        defaultExecutionOptions: async () => ({
          model: "gpt-6.1-sol", serviceTier: "default", reasoningLevel: "high",
          permissionMode: "accept-edits", source: "client/turn/start",
        }),
      },
    },
  });
  await plugin(host.bb);
  disposals.push(() => host.harness.lifecycle.dispose());
  await host.harness.resolveAgentConfiguration(context);
  return {
    ...host, spawn, send, sendDefault, wait, output, stop, response,
    isTranslation: () => phase === "translation",
    review: (signal?: AbortSignal) => host.harness.callAgentTool(
      "advisor_review", { focus: "Verify completed work." },
      { threadId: "thread-primary", ...(signal ? { signal } : {}) },
    ),
    panel: () => host.harness.callRpc("threadReviews", { threadId: "thread-primary" }) as Promise<Panel>,
    next(rawNext: string, text = RU_TEXT) {
      seq += 1;
      raw = rawNext;
      translated = JSON.stringify(text);
    },
    translationOutput(value: string) { translated = value; },
  };
}

describe("review language through the real Advisor lifecycle", () => {
  it("delivers a translated post-turn finding through pending advice", async () => {
    const f = await fixture({ autoReview: true });
    await f.harness.emitThreadEvent("thread.idle", {
      thread: f.response("thread-primary"), lastAssistantText: "Implemented.",
    });
    const pending = await f.harness.callRpc("pendingAdvice", { threadId: "thread-primary" });
    expect(pending).toMatchObject({ advice: RU_TEXT });
    const next = await f.harness.resolveAgentConfiguration(context);
    expect(next.instructions).toContain(RU_TEXT.summary);
    expect(next.instructions).not.toContain(EN_SUMMARY);
  });

  it("manual review persists the same translated finding", async () => {
    const f = await fixture();
    await expect(f.harness.callRpc("requestReview", { threadId: "thread-primary" }))
      .resolves.toEqual({ started: true, waiting: false });
    await vi.waitFor(async () => expect((await f.panel()).reviewing).toBe(false));
    expect((await f.panel()).reviews[0]).toMatchObject({ severity: "concern", ...RU_TEXT });
  });

  it("translates only the text, keeps the verdict, and reuses the same model and reviewer", async () => {
    const f = await fixture();
    await f.review();
    const panel = await f.panel();
    expect(panel.reviews).toHaveLength(1);
    expect(panel.reviews[0]).toMatchObject({ severity: "concern", ...RU_TEXT });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-6.1-sol", providerId: "codex",
      environment: { type: "reuse", environmentId: context.environment.id },
    });
    expect(f.spawn.mock.calls[0]?.[0].prompt).toContain("Всегда пиши summary и details ревью по-русски");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].threadId).toBe("thread-advisor");
    expect(f.send.mock.calls[0]?.[0].input?.[0]?.text).toContain("Это только перевод");
  });

  it("does not request translation for an already Russian review", async () => {
    const f = await fixture();
    f.next(finding("concern", RU_TEXT.summary, RU_TEXT.details));
    await f.review();
    expect((await f.panel()).reviews[0]).toMatchObject(RU_TEXT);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("auto omits the language contract and leaves English text intact", async () => {
    const f = await fixture({ outputLanguage: "auto" });
    await f.review();
    expect((await f.panel()).reviews[0]).toMatchObject({ summary: EN_SUMMARY, details: EN_DETAILS });
    expect(f.spawn.mock.calls[0]?.[0].prompt).not.toContain("Всегда пиши summary");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("reinforces Russian on reuse and preserves the original keyless blocker chain", async () => {
    const f = await fixture();
    f.next(finding("blocker"));
    await f.review();
    const original = (await f.panel()).reviews[0]!;
    f.next(finding("nit"), { summary: "Запись выполняется слишком поздно", details: "- Результат возвращается до завершения записи." });
    await f.review();
    const second = (await f.panel()).reviews[0]!;
    expect(second).toMatchObject({
      severity: "blocker", chainId: original.chainId, repeatCount: 2,
      summary: "Запись выполняется слишком поздно",
    });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const reviewPrompts = f.send.mock.calls.map(([args]) => args.input?.[0]?.text ?? "")
      .filter((text) => text.includes("You are the independent advisor"));
    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]).toContain("Всегда пиши summary");
  });

  it.each(["invalid JSON", JSON.stringify({ ...RU_TEXT, severity: "pass" }), JSON.stringify({ summary: "", details: "" })])(
    "keeps the original verdict and text if translation is invalid: %s",
    async (bad) => {
      const f = await fixture();
      f.translationOutput(bad);
      await f.review();
      expect((await f.panel()).reviews[0]).toMatchObject({
        severity: "concern", summary: EN_SUMMARY, details: EN_DETAILS + "\n\n" + NOTICE,
      });
      expect(f.stop).toHaveBeenCalled();
    },
  );

  it("retains the blocker chain if the next translation fails", async () => {
    const f = await fixture();
    f.next(finding("blocker"));
    await f.review();
    const root = (await f.panel()).reviews[0]!;
    f.next(finding("nit"));
    f.translationOutput("broken");
    await f.review();
    expect((await f.panel()).reviews[0]).toMatchObject({
      severity: "blocker", chainId: root.chainId, repeatCount: 2,
      summary: EN_SUMMARY, details: expect.stringContaining(NOTICE),
    });
  });

  it("stops on an unmatched translation wait without reading stale output", async () => {
    const f = await fixture();
    f.wait.mockResolvedValueOnce({ matched: true }).mockResolvedValueOnce({ matched: false });
    await f.review();
    expect(f.output).toHaveBeenCalledTimes(1);
    expect(f.stop).toHaveBeenCalled();
    expect((await f.panel()).reviews[0]?.details).toContain(NOTICE);
  });

  it.each(["send", "output"] as const)("enforces one 30-second deadline when translation %s never resolves", async (stage) => {
    vi.useFakeTimers();
    const f = await fixture();
    if (stage === "send") f.send.mockImplementation(() => new Promise(() => {}));
    else f.output.mockImplementation(async () =>
      f.isTranslation() ? await new Promise(() => {}) : { output: finding() });
    let settled = false;
    const pending = f.review().then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.stop).toHaveBeenCalled();
    expect((await f.panel()).reviews[0]).toMatchObject({
      severity: "concern", summary: EN_SUMMARY, details: expect.stringContaining(NOTICE),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late send after the deadline stops again and never advances to wait or output", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    let release!: (value: { ok: true }) => void;
    f.send.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.review();
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    const stops = f.stop.mock.calls.length;
    expect(f.wait).toHaveBeenCalledTimes(1);
    expect(f.output).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.stop.mock.calls.length).toBeGreaterThan(stops);
    expect(f.wait).toHaveBeenCalledTimes(1);
    expect(f.output).toHaveBeenCalledTimes(1);
    expect((await f.panel()).reviews).toHaveLength(1);
  });

  it("cancelled shared tool/manual translation preserves the finding without automatic continuation", async () => {
    const f = await fixture({ autoContinue: true });
    let releaseGet!: (value: ReturnType<typeof makeThreadResponse>) => void;
    let firstGet = true;
    f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (firstGet) {
        firstGet = false;
        return await new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => { releaseGet = resolve; });
      }
      return f.response(threadId);
    });
    const manual = f.harness.callRpc("requestReview", { threadId: "thread-primary" });
    await vi.waitFor(() => expect(releaseGet).toBeTypeOf("function"));
    f.send.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const tool = f.review(controller.signal);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    releaseGet(f.response("thread-primary"));
    await manual;
    // Let the manual caller join the existing in-flight review before aborting.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await tool;
    await vi.waitFor(async () => expect((await f.panel()).reviewing).toBe(false));
    expect((await f.panel()).reviews[0]?.details).toContain(NOTICE);
    const primarySends = f.harness.sdk.callsTo("threads.send")
      .filter(([args]) => (args as { threadId: string }).threadId === "thread-primary");
    expect(primarySends).toHaveLength(0);
    expect(f.stop).toHaveBeenCalled();
  });

  it("keeps the language snapshot when settings change while the review is running", async () => {
    const f = await fixture();
    f.wait.mockImplementationOnce(async () => {
      await f.harness.setSettings({ outputLanguage: "auto" });
      return { matched: true };
    });
    await f.review();
    expect((await f.panel()).reviews[0]).toMatchObject(RU_TEXT);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("the deadline reminder carries Russian while keeping service labels unchanged", async () => {
    vi.useFakeTimers();
    const f = await fixture({ timeoutSeconds: "30 seconds" });
    f.next(finding("pass", "Проверка завершена", "none"));
    f.wait.mockImplementationOnce(() => new Promise((resolve) =>
      setTimeout(() => resolve({ matched: true }), 22_500)));
    const pending = f.review();
    await vi.advanceTimersByTimeAsync(22_000);
    const reminder = f.send.mock.calls.map(([args]) => args.input?.[0]?.text ?? "")
      .find((text) => text.startsWith("FINALIZE NOW"));
    expect(reminder).toContain("Keep summary and details in Russian");
    expect(reminder).toContain("key and resolved");
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
