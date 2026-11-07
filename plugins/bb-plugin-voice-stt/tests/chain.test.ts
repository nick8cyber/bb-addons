import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTranscribeChain, type ChainDeps } from "../src/chain.js";
import { AiServiceFailure, type TranscribeInput } from "../src/contract.js";

const tempDir = mkdtempSync(join(tmpdir(), "voice-stt-chain-"));

const fail = (code: "timeout" | "rate_limited" | "service_unavailable" | "auth_required" | "request_failed" | "invalid_response", message: string) =>
  Promise.reject(new AiServiceFailure(code, "test", message));

const baseInput = (over: Partial<TranscribeInput> = {}): TranscribeInput => ({
  audioBase64: Buffer.from("fake-audio").toString("base64"),
  mimeType: "audio/webm",
  filename: "voice.webm",
  hint: null,
  config: {
    geminiKeys: ["key-one", "key-two"],
    geminiLiveModel: "gemini-3.5-transcribe-live",
    groqApiKey: "gsk_test",
    groqModel: "whisper-large-v3-turbo",
    language: null,
  },
  timeoutMs: 65_000,
  ...over,
});

const ctx = { signal: new AbortController().signal, tempDir };

const okDeps = (over: Partial<ChainDeps> = {}): ChainDeps => ({
  decodePcm: async () => Buffer.alloc(6400, 1),
  gemini: async () => "",
  codex: async () => "",
  groq: async () => "",
  ...over,
});

describe("runTranscribeChain (§5)", () => {
  it("returns the gemini text when the first key succeeds", async () => {
    const calls: string[] = [];
    const result = await runTranscribeChain(baseInput(), ctx, okDeps({
      gemini: async (o) => {
        calls.push(o.apiKey);
        return " текст ";
      },
      codex: async () => {
        throw new Error("must not run");
      },
    }));
    expect(result).toEqual({ ok: true, text: "текст", engine: "gemini-live" });
    expect(calls).toEqual(["key-one"]);
  });

  it("rotates to the next key on any failure before text", async () => {
    const calls: string[] = [];
    const result = await runTranscribeChain(baseInput(), ctx, okDeps({
      gemini: async (o) => {
        calls.push(o.apiKey);
        if (calls.length === 1) return fail("rate_limited", "quota");
        if (calls.length === 2) return "готово";
        return fail("request_failed", "unreachable");
      },
      codex: async () => {
        throw new Error("must not run");
      },
    }));
    expect(result).toEqual({ ok: true, text: "готово", engine: "gemini-live" });
    expect(calls).toEqual(["key-one", "key-two"]);
  });

  it("rotates keys on an auth refusal of the upgrade too", async () => {
    const calls: string[] = [];
    await runTranscribeChain(baseInput(), ctx, okDeps({
      gemini: async (o) => {
        calls.push(o.apiKey);
        return fail("auth_required", "Could not connect to Gemini live transcription. Check the transcription API key.");
      },
      codex: async () => "codex text",
    }));
    expect(calls).toEqual(["key-one", "key-two"]);
  });

  it("an empty gemini transcript is a soft stage failure → codex, no key rotation", async () => {
    const calls: string[] = [];
    const result = await runTranscribeChain(baseInput(), ctx, okDeps({
      gemini: async (o) => {
        calls.push(o.apiKey);
        return "";
      },
      codex: async () => "codex текст",
    }));
    expect(result).toEqual({ ok: true, text: "codex текст", engine: "codex" });
    expect(calls).toEqual(["key-one"]);
  });

  it("an ffmpeg failure skips the whole gemini stage", async () => {
    const geminiCalls: string[] = [];
    const result = await runTranscribeChain(baseInput(), ctx, okDeps({
      decodePcm: async () => fail("service_unavailable", "ffmpeg missing"),
      gemini: async (o) => {
        geminiCalls.push(o.apiKey);
        return "x";
      },
      codex: async () => "codex текст",
    }));
    expect(result).toEqual({ ok: true, text: "codex текст", engine: "codex" });
    expect(geminiCalls).toEqual([]);
  });

  it("falls through gemini → codex → groq and reports groq engine", async () => {
    const order: string[] = [];
    const result = await runTranscribeChain(baseInput(), ctx, okDeps({
      gemini: async () => {
        order.push("gemini");
        return fail("service_unavailable", "down");
      },
      codex: async () => {
        order.push("codex");
        return fail("auth_required", "no auth");
      },
      groq: async () => {
        order.push("groq");
        return "groq текст";
      },
    }));
    expect(result).toEqual({ ok: true, text: "groq текст", engine: "groq" });
    // Два ключа: gemini вызывается дважды, затем codex, затем groq.
    expect(order).toEqual(["gemini", "gemini", "codex", "groq"]);
  });

  it("skips the groq stage without an API key", async () => {
    const groqCalls: number[] = [];
    const input = baseInput();
    input.config.groqApiKey = null;
    const result = await runTranscribeChain(input, ctx, okDeps({
      codex: async () => fail("request_failed", "nope"),
      groq: async () => {
        groqCalls.push(1);
        return "x";
      },
    }));
    expect(result.ok).toBe(false);
    expect(groqCalls).toEqual([]);
    if (!result.ok) expect(result.message).toContain("groq: skipped (no API key)");
  });

  it("skips gemini entirely without keys", async () => {
    const input = baseInput();
    input.config.geminiKeys = [];
    const result = await runTranscribeChain(input, ctx, okDeps({ codex: async () => "ок" }));
    expect(result).toEqual({ ok: true, text: "ок", engine: "codex" });
  });

  it("collects per-stage reasons into the final message, code of the last stage", async () => {
    const result = await runTranscribeChain(baseInput(), ctx, okDeps({
      gemini: async () => fail("rate_limited", "quota out"),
      codex: async () => fail("auth_required", "run codex login"),
      groq: async () => fail("service_unavailable", "groq down"),
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("service_unavailable");
    expect(result.message).toContain("gemini-live:");
    expect(result.message).toContain("codex: run codex login");
    expect(result.message).toContain("groq: groq down");
  });

  it("guard: a stage with <5s of budget left is skipped as timeout", async () => {
    let now = 0;
    const calls: string[] = [];
    const input = baseInput();
    input.config.geminiKeys = ["k1"];
    // ffmpeg съедает почти весь бюджет: к моменту стадий remaining < 5000.
    const result = await runTranscribeChain(input, ctx, okDeps({
      now: () => now,
      decodePcm: async () => {
        now = 61_000; // deadline 65 000 → remaining 4 000 < 5 000
        return Buffer.alloc(100, 1);
      },
      gemini: async () => {
        calls.push("gemini");
        return "x";
      },
      codex: async () => {
        calls.push("codex");
        return "x";
      },
      groq: async () => {
        calls.push("groq");
        return "x";
      },
    }));
    expect(calls).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
      expect(result.message).toContain("skipped");
    }
  });

  it("stage budgets shrink to the remaining time", async () => {
    let now = 0;
    const budgets: number[] = [];
    const input = baseInput();
    input.config.geminiKeys = ["k1"];
    input.config.groqApiKey = null;
    await runTranscribeChain(input, ctx, okDeps({
      now: () => now,
      decodePcm: async () => {
        now = 55_000; // deadline 65 000 → remaining 10 000
        return Buffer.alloc(100, 1);
      },
      gemini: async (o) => {
        budgets.push(o.timeoutMs);
        return fail("service_unavailable", "down");
      },
      codex: async (o) => {
        budgets.push(o.timeoutMs);
        return "x";
      },
    }));
    expect(budgets).toEqual([10_000, 10_000]); // min(12 000/15 000, remaining)
  });

  it("groq receives the ISO base language, not the BCP-47 form", async () => {
    const input = baseInput();
    input.config.geminiKeys = [];
    input.config.language = "ru-RU";
    let seen: string | null = null;
    await runTranscribeChain(input, ctx, okDeps({
      codex: async () => fail("request_failed", "x"),
      groq: async (o) => {
        seen = o.language;
        return "x";
      },
    }));
    expect(seen).toBe("ru");
  });
});
