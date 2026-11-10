import { describe, expect, it, vi } from "vitest";
import {
  buildContinuationMessage,
  buildMergePrompt,
  buildSummaryPrompt,
  chunkSummaryInput,
  commonPrefixLength,
  compactThread,
  ExternalCompactError,
  isCompactionOffered,
  mapGeminiHttpError,
  MAX_CHUNKS,
  parseGeminiKeys,
  pickChunkCuts,
  SAFE_SINGLE_PASS_TOKENS,
  sizeGate,
  sliceChunkDelta,
  splitTextBySize,
  summarizeHistoryHierarchical,
  summarizeWithGemini,
  SUMMARIZER_MODEL,
  transcriptBody,
  type CompactThreadDeps,
  type HierarchicalSummarizeDeps,
} from "../src/external-compact.js";

const SILENT_LOG = { info: () => {}, warn: () => {} };

function makeDeps(overrides: Partial<CompactThreadDeps> = {}): CompactThreadDeps {
  return {
    getKeys: async () => ["key-one"],
    getAutoArchive: async () => false,
    getThread: async () => ({
      projectId: "proj_test",
      environmentId: "env_test",
      providerId: "provider-test",
      model: "model-test",
      title: "source thread",
    }),
    getUsage: async () => ({ usedTokens: 150_000, compactionOfferAt: null }),
    exportHistory: async () => "serialized history",
    listCutSeqs: async () => [],
    summarize: async () => "summary text",
    spawnContinuation: async () => "thr_new0000001",
    archiveSource: async () => {},
    log: SILENT_LOG,
    ...overrides,
  };
}

describe("parseGeminiKeys", () => {
  it("разбирает 1–2 ключа по строкам, пропуская пустые", () => {
    expect(parseGeminiKeys("  key-a \n\nkey-b\n")).toEqual(["key-a", "key-b"]);
    expect(parseGeminiKeys("key-a")).toEqual(["key-a"]);
  });
  it("пусто/undefined → []", () => {
    expect(parseGeminiKeys(undefined)).toEqual([]);
    expect(parseGeminiKeys(null)).toEqual([]);
    expect(parseGeminiKeys("  \n \n")).toEqual([]);
  });
  it("дедупликация и крышка в 2 ключа", () => {
    expect(parseGeminiKeys("a\na\nb\nc")).toEqual(["a", "b"]);
  });
});

describe("isCompactionOffered", () => {
  it("compactionOfferAt в прошлом → true", () => {
    const usage = { compactionOfferAt: new Date(Date.now() - 1000).toISOString() };
    expect(isCompactionOffered(usage)).toBe(true);
  });
  it("в будущем или отсутствует → false", () => {
    expect(
      isCompactionOffered({ compactionOfferAt: new Date(Date.now() + 60_000).toISOString() }),
    ).toBe(false);
    expect(isCompactionOffered({ compactionOfferAt: null })).toBe(false);
    expect(isCompactionOffered(null)).toBe(false);
    expect(isCompactionOffered({ compactionOfferAt: "not-a-date" })).toBe(false);
  });
});

describe("sizeGate", () => {
  it("до безопасной границы — single, сверх — chunked", () => {
    expect(sizeGate(100_000)).toBe("single");
    expect(sizeGate(SAFE_SINGLE_PASS_TOKENS)).toBe("single");
    expect(sizeGate(SAFE_SINGLE_PASS_TOKENS + 1)).toBe("chunked");
  });
  it("неизвестный размер пропускаем как single", () => {
    expect(sizeGate(null)).toBe("single");
    expect(sizeGate(undefined)).toBe("single");
  });
});

describe("prompt builders", () => {
  it("buildSummaryPrompt держит обязательные секции спеки", () => {
    const p = buildSummaryPrompt();
    for (const part of ["цели", "решени", "репозитор", "открытые задачи", "инструкции"]) {
      expect(p.toLowerCase()).toContain(part);
    }
  });
  it("buildContinuationMessage ссылается на исходный тред", () => {
    const msg = buildContinuationMessage("SUM", "thr_abc1230000");
    expect(msg).toContain("@thread:thr_abc1230000");
    expect(msg).toContain("SUM");
  });
});

describe("mapGeminiHttpError (таблица ответов шлюзов)", () => {
  it("429 → следующий ключ", () => {
    expect(mapGeminiHttpError(429)).toEqual({ code: "rate_limited", tryNextKey: true });
  });
  it("403 → следующий ключ; 400/404 → не повторять; 5xx → следующий ключ", () => {
    expect(mapGeminiHttpError(403).tryNextKey).toBe(true);
    expect(mapGeminiHttpError(400)).toEqual({ code: "gemini_rejected", tryNextKey: false });
    expect(mapGeminiHttpError(404)).toEqual({ code: "gemini_rejected", tryNextKey: false });
    expect(mapGeminiHttpError(503)).toEqual({ code: "rate_limited", tryNextKey: true });
  });
});

describe("summarizeWithGemini", () => {
  const okResponse = (text: string) =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
    });

  it("отдаёт текст первого кандидата", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse("итог"));
    await expect(summarizeWithGemini("hist", ["k1"], { fetchImpl })).resolves.toBe("итог");
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain(SUMMARIZER_MODEL);
    expect(url).not.toContain("k1"); // ключ — в заголовке, не в URL
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k1");
  });

  it("429 на первом ключе → фолбэк на второй", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("quota", { status: 429 }))
      .mockResolvedValueOnce(okResponse("ok-by-second"));
    await expect(
      summarizeWithGemini("hist", ["k1", "k2"], { fetchImpl }),
    ).resolves.toBe("ok-by-second");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("все ключи на 429 → rate_limited", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("quota", { status: 429 }));
    await expect(
      summarizeWithGemini("hist", ["k1", "k2"], { fetchImpl }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("400 → gemini_rejected без повтора", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("bad", { status: 400 }));
    await expect(summarizeWithGemini("hist", ["k1"], { fetchImpl })).rejects.toMatchObject({
      code: "gemini_rejected",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("без ключей → no_keys до сети", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(summarizeWithGemini("hist", [], { fetchImpl })).rejects.toMatchObject({
      code: "no_keys",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("503 → фолбэк на следующий ключ", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(okResponse("ok-after-503"));
    await expect(
      summarizeWithGemini("hist", ["k1", "k2"], { fetchImpl }),
    ).resolves.toBe("ok-after-503");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("403 (квота/доступ) → фолбэк на следующий ключ", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(okResponse("ok-after-403"));
    await expect(
      summarizeWithGemini("hist", ["k1", "k2"], { fetchImpl }),
    ).resolves.toBe("ok-after-403");
    const second = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect((second.headers as Record<string, string>)["x-goog-api-key"]).toBe("k2");
  });

  it("404 (модель снята) → gemini_rejected, второй ключ не трогаем", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nf", { status: 404 }));
    await expect(
      summarizeWithGemini("hist", ["k1", "k2"], { fetchImpl }),
    ).rejects.toMatchObject({ code: "gemini_rejected" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("сетевой сбой → следующий ключ; все упали → rate_limited", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket hangup"))
      .mockResolvedValueOnce(okResponse("ok-after-net-fail"));
    await expect(
      summarizeWithGemini("hist", ["k1", "k2"], { fetchImpl }),
    ).resolves.toBe("ok-after-net-fail");
    const allFail = vi.fn<typeof fetch>(async () => {
      throw new Error("timeout");
    });
    await expect(
      summarizeWithGemini("hist", ["k1", "k2"], { fetchImpl: allFail }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("ответ без текста/не-JSON → invalid_response", async () => {
    const empty = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    );
    await expect(summarizeWithGemini("hist", ["k1"], { fetchImpl: empty })).rejects.toMatchObject(
      { code: "invalid_response" },
    );
    const notJson = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 200 }));
    await expect(summarizeWithGemini("hist", ["k1"], { fetchImpl: notJson })).rejects.toMatchObject(
      { code: "invalid_response" },
    );
  });

  it("ключи не попадают в ошибки: ни в URL, ни в message", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("quota exceeded for project", { status: 429 }),
    );
    const err = await summarizeWithGemini("hist", ["key-AAA-secret", "key-BBB-secret"], {
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalCompactError);
    const message = (err as Error).message;
    expect(message).not.toContain("key-AAA-secret");
    expect(message).not.toContain("key-BBB-secret");
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).not.toContain("secret");
    }
  });
});

describe("compactThread (оркестрация)", () => {
  it("полный путь: экспорт → summary → новый тред", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      exportHistory: async (id) => {
        calls.push(`export:${id}`);
        return "H";
      },
      summarize: async (h, keys) => {
        calls.push(`summarize:${h}:${keys.join(",")}`);
        return "S";
        },
      spawnContinuation: async (target, prompt) => {
        calls.push(`spawn:${target.environmentId}:${prompt.includes("thr_src000001")}`);
        return "thr_new000001";
      },
    });
    const res = await compactThread(deps, { threadId: "thr_src000001" });
    expect(res).toEqual({ ok: true, newThreadId: "thr_new000001" });
    expect(calls).toEqual([
      "export:thr_src000001",
      "summarize:H:key-one",
      "spawn:env_test:true",
    ]);
  });

  it("нет ключей → ok:false no_keys, сайд-эффектов нет", async () => {
    const deps = makeDeps({ getKeys: async () => [] });
    const res = await compactThread(deps, { threadId: "thr_src000002" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no_keys");
  });

  it("тред не найден → ok:false thread_not_found", async () => {
    const deps = makeDeps({ getThread: async () => null });
    const res = await compactThread(deps, { threadId: "thr_missing00" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("thread_not_found");
  });

  it("сверх границы → иерархическое сжатие: экспорт по срезам, summary чанков, сводка", async () => {
    const exportedSeqs: (number | undefined)[] = [];
    const summaries: string[] = [];
    // Префиксные экспорты делят общий транскрипт: срез N оканчивается записью N.
    const full = ["T1", "T2", "T3"].join("\n---\n");
    const docFor = (upToSeq?: number) =>
      `# Session handoff\n\n## Transcript\n\n${
        upToSeq === 10 ? "T1" : upToSeq === 20 ? "T1\n---\nT2" : full
      }`;
    const deps = makeDeps({
      getUsage: async () => ({ usedTokens: 1_700_000 }),
      listCutSeqs: async () => [10, 20, 30],
      exportHistory: async (_id, upToSeq) => {
        exportedSeqs.push(upToSeq);
        return docFor(upToSeq);
      },
      summarize: async (h) => {
        summaries.push(h);
        return `S${summaries.length}`;
      },
      spawnContinuation: async () => "thr_new_chunked",
    });
    const res = await compactThread(deps, { threadId: "thr_big0000001" });
    expect(res).toEqual({ ok: true, newThreadId: "thr_new_chunked" });
    // 1_700_000 / 800_000 → 3 чанка: срезы по seq 10 и 20 + полный экспорт.
    expect(exportedSeqs).toEqual([10, 20, undefined]);
    // 3 summary чанков + 1 сводное.
    expect(summaries).toHaveLength(4);
    expect(summaries[0]).toContain("T1");
    expect(summaries[1]).toContain("T2");
    expect(summaries[1]).not.toContain("T1\n---");
    expect(summaries[2]).toContain("T3");
    expect(summaries[3]).toContain("## Часть 1");
    expect(summaries[3]).toContain("S1");
    expect(summaries[3]).toContain("S3");
  });

  it("слишком большая история → явный отказ too_large, без экспорта", async () => {
    const exportHistory = vi.fn(async () => "doc");
    const deps = makeDeps({
      getUsage: async () => ({ usedTokens: MAX_CHUNKS * SAFE_SINGLE_PASS_TOKENS + 1 }),
      exportHistory,
    });
    const res = await compactThread(deps, { threadId: "thr_huge000001" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("too_large");
    expect(exportHistory).not.toHaveBeenCalled();
  });

  it("autoArchiveSource=on → исходный архивируется; падение архивации не валит результат", async () => {
    let archived = "";
    const deps = makeDeps({
      getAutoArchive: async () => true,
      archiveSource: async (id) => {
        archived = id;
      },
    });
    const res = await compactThread(deps, { threadId: "thr_src000003" });
    expect(res.ok).toBe(true);
    expect(archived).toBe("thr_src000003");

    const deps2 = makeDeps({
      getAutoArchive: async () => true,
      archiveSource: async () => {
        throw new Error("archive boom");
      },
    });
    const res2 = await compactThread(deps2, { threadId: "thr_src000004" });
    expect(res2.ok).toBe(true);
  });

  it("сбой summarize: ключи не попадают ни в error, ни в лог", async () => {
    const warnings: string[] = [];
    const deps = makeDeps({
      getKeys: async () => ["key-SECRET-1", "key-SECRET-2"],
      summarize: async () => {
        throw new ExternalCompactError("rate_limited", "Gemini HTTP 429: quota exceeded");
      },
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    const res = await compactThread(deps, { threadId: "thr_mask000001" });
    expect(res.ok).toBe(false);
    for (const surface of [res.error ?? "", ...warnings]) {
      expect(surface).not.toContain("key-SECRET-1");
      expect(surface).not.toContain("key-SECRET-2");
    }
  });
});

describe("pickChunkCuts", () => {
  it("равномерные внутренние срезы: chunkCount-1 точек, без дублей", () => {
    const seqs = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(pickChunkCuts(seqs, 3)).toEqual([4, 7]);
    expect(pickChunkCuts(seqs, 2)).toEqual([5]);
  });
  it("chunkCount <= 1 или нет кандидатов → срезов нет", () => {
    expect(pickChunkCuts([1, 2, 3], 1)).toEqual([]);
    expect(pickChunkCuts([], 5)).toEqual([]);
  });
  it("кандидатов меньше нужного — берём все, вход сортируется и дедупится", () => {
    expect(pickChunkCuts([30, 10, 30, 20], 5)).toEqual([10, 20, 30]);
  });
});

describe("transcriptBody / sliceChunkDelta", () => {
  const doc = (t: string) => `# Session handoff\n\n- Captured: x\n\n## Transcript\n\n${t}`;
  it("берёт часть после ## Transcript; без заголовка — весь документ", () => {
    expect(transcriptBody(doc("BODY"))).toBe("\nBODY");
    expect(transcriptBody("no marker")).toBe("no marker");
  });
  it("дельта чанка — транскрипт большего среза без общего префикса", () => {
    const t1 = transcriptBody(doc("A1\n---\nA2"));
    const t2 = transcriptBody(doc("A1\n---\nA2\n---\nA3"));
    expect(sliceChunkDelta(t1, t2)).toBe("\n---\nA3");
  });
  it("недетерминированный рендер → чанк с перекрытием, не пропуск", () => {
    expect(sliceChunkDelta("XYZ", "ABCDEF")).toBe("ABCDEF");
    expect(commonPrefixLength("abc", "abd")).toBe(2);
  });
});

describe("splitTextBySize", () => {
  it("режет по границам абзацев, каждая часть <= maxChars", () => {
    const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n\n");
    const parts = splitTextBySize(text, 10);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(10);
    expect(parts.join(" ").replace(/\s+/g, " ")).toContain("aaaa");
    expect(parts.join(" ").replace(/\s+/g, " ")).toContain("dddd");
  });
  it("абзац длиннее maxChars → жёсткий рез по длине", () => {
    const parts = splitTextBySize("x".repeat(25), 10);
    expect(parts).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
  it("короткий текст → одна часть", () => {
    expect(splitTextBySize("short", 100)).toEqual(["short"]);
  });
});

describe("summarizeHistoryHierarchical", () => {
  const doc = (t: string) => `head\n## Transcript\n\n${t}`;
  function makeHDeps(overrides: Partial<HierarchicalSummarizeDeps> = {}) {
    const calls: { exportSeqs: (number | undefined)[]; summaries: string[] } = {
      exportSeqs: [],
      summaries: [],
    };
    const deps: HierarchicalSummarizeDeps = {
      listCutSeqs: async () => [10, 20],
      exportPart: async (_id, upToSeq) => {
        calls.exportSeqs.push(upToSeq);
        return doc(upToSeq === 10 ? "C1" : upToSeq === 20 ? "C1\n---\nC2" : "C1\n---\nC2\n---\nC3");
      },
      summarize: async (h) => {
        calls.summaries.push(h);
        return `S${calls.summaries.length}`;
      },
      log: SILENT_LOG,
      ...overrides,
    };
    return { deps, calls };
  }

  it("чанки по срезам → summary каждого → сводное summary", async () => {
    const { deps, calls } = makeHDeps();
    const out = await summarizeHistoryHierarchical(deps, "thr_t", 1_700_000, ["k1"]);
    expect(calls.exportSeqs).toEqual([10, 20, undefined]);
    expect(calls.summaries).toHaveLength(4);
    expect(calls.summaries[0]).toContain("C1");
    expect(calls.summaries[1]).toContain("C2");
    expect(calls.summaries[2]).toContain("C3");
    expect(calls.summaries[3]).toContain(buildMergePrompt().split("\n")[0]);
    expect(out).toBe("S4");
  });

  it("без кандидатов на срезы — один полный экспорт, один чанк", async () => {
    const { deps, calls } = makeHDeps({ listCutSeqs: async () => [] });
    const out = await summarizeHistoryHierarchical(deps, "thr_t", 900_000, ["k1"]);
    expect(calls.exportSeqs).toEqual([undefined]);
    expect(calls.summaries).toHaveLength(2); // чанк + сводка
    expect(out).toBe("S2");
  });

  it("объём сверх MAX_CHUNKS → too_large до экспорта", async () => {
    const exportPart = vi.fn(async () => "x");
    const { deps } = makeHDeps({ exportPart });
    await expect(
      summarizeHistoryHierarchical(
        deps,
        "thr_t",
        MAX_CHUNKS * SAFE_SINGLE_PASS_TOKENS + 1,
        ["k1"],
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(exportPart).not.toHaveBeenCalled();
  });

  it("второй уровень сведения, если частичные summary не влезают", async () => {
    const big = "y".repeat(SAFE_SINGLE_PASS_TOKENS + 1);
    const { deps, calls } = makeHDeps({
      exportPart: async () => doc("C"),
      summarize: async (h) => {
        calls.summaries.push(h);
        return big; // каждый summary сам огромный → merged > лимита
      },
    });
    // MAX_REDUCE_DEPTH=3: раунды сведения исчерпаются → too_large.
    await expect(
      summarizeHistoryHierarchical(deps, "thr_t", 900_000, ["k1"]),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("chunkSummaryInput нумерует части", () => {
    expect(chunkSummaryInput("CH", 1, 3)).toContain("часть 2 из 3");
    expect(chunkSummaryInput("CH", 1, 3)).toContain("CH");
  });
});

describe("compactUiStore", () => {
  it("request выставляет pending и будит подписчиков; cancel снимает", async () => {
    const { compactUiStore } = await import("../src/ui/compactUiStore.js");
    const seen: (object | null)[] = [];
    const unsub = compactUiStore.subscribe(() => seen.push(compactUiStore.getSnapshot()));
    compactUiStore.request({ threadId: "thr_ui0000001" });
    expect(compactUiStore.getSnapshot()).toEqual({ threadId: "thr_ui0000001" });
    compactUiStore.cancel();
    expect(compactUiStore.getSnapshot()).toBeNull();
    unsub();
    expect(seen).toEqual([{ threadId: "thr_ui0000001" }, null]);
  });

  it("cancel на пустом сторе не эмитит", async () => {
    const { compactUiStore } = await import("../src/ui/compactUiStore.js");
    let calls = 0;
    const unsub = compactUiStore.subscribe(() => calls++);
    compactUiStore.cancel();
    expect(calls).toBe(0);
    unsub();
  });
});
