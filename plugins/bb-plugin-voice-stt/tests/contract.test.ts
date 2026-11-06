import { describe, expect, it } from "vitest";
import {
  AiServiceFailure,
  FAILURE_CODES,
  contract,
  languageBaseCode,
  normalizeLanguage,
  toFailureResult,
  type FailureCode,
} from "../src/contract.js";

describe("normalizeLanguage (§4.1)", () => {
  it("empty and whitespace settings become null", () => {
    expect(normalizeLanguage("")).toBeNull();
    expect(normalizeLanguage("   ")).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
  });

  it("accepts BCP-47 codes", () => {
    expect(normalizeLanguage("ru")).toBe("ru");
    expect(normalizeLanguage("ru-RU")).toBe("ru-RU");
    expect(normalizeLanguage("pt-BR")).toBe("pt-BR");
  });

  it("rejects malformed codes", () => {
    expect(normalizeLanguage("russian")).toBeNull();
    expect(normalizeLanguage("ru_RU")).toBeNull();
    expect(normalizeLanguage("123")).toBeNull();
  });
});

describe("languageBaseCode (§8)", () => {
  it("slices the region for ISO-639-1 providers", () => {
    expect(languageBaseCode("ru-RU")).toBe("ru");
    expect(languageBaseCode("ru")).toBe("ru");
    expect(languageBaseCode(null)).toBeNull();
  });
});

describe("error codes (§5)", () => {
  it("failure codes come only from the spec set", () => {
    expect(new Set(FAILURE_CODES)).toEqual(
      new Set([
        "timeout",
        "rate_limited",
        "service_unavailable",
        "auth_required",
        "request_failed",
        "invalid_response",
      ]),
    );
  });

  it("toFailureResult maps AiServiceFailure, AbortError and generic errors", () => {
    const f1 = toFailureResult(new AiServiceFailure("rate_limited", "d", "quota"));
    expect(f1).toEqual({ ok: false, code: "rate_limited", message: "quota" });
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(toFailureResult(abort).code).toBe("timeout");
    expect(toFailureResult(new Error("boom")).code).toBe("request_failed");
    expect(toFailureResult("weird").code).toBe("request_failed");
    const f: FailureCode = f1.code;
    expect(FAILURE_CODES).toContain(f);
  });
});

describe("host RPC contract (§5)", () => {
  const validInput = {
    audioBase64: "eA==",
    mimeType: "audio/webm",
    filename: "v.webm",
    hint: null,
    config: {
      geminiKeys: ["k"],
      geminiLiveModel: "m",
      groqApiKey: null,
      groqModel: "w",
      language: null,
    },
    timeoutMs: 65_000,
  };

  it("accepts a valid transcribe input", () => {
    expect(contract["voice-stt.transcribe"].input.safeParse(validInput).success).toBe(true);
  });

  it("rejects extra fields and an empty audio payload", () => {
    expect(
      contract["voice-stt.transcribe"].input.safeParse({ ...validInput, extra: 1 }).success,
    ).toBe(false);
    expect(
      contract["voice-stt.transcribe"].input.safeParse({ ...validInput, audioBase64: "" }).success,
    ).toBe(false);
  });

  it("output union: ok variants validate", () => {
    const out = contract["voice-stt.transcribe"].output;
    expect(out.safeParse({ ok: true, text: "x", engine: "codex" }).success).toBe(true);
    expect(out.safeParse({ ok: false, code: "timeout", message: "m" }).success).toBe(true);
    expect(out.safeParse({ ok: true, text: "x", engine: "other" }).success).toBe(false);
    expect(out.safeParse({ ok: false, code: "weird", message: "m" }).success).toBe(false);
  });

  it("status output shape is strict", () => {
    const out = contract["voice-stt.status"].output;
    expect(out.safeParse({ codexAuth: "expired", ffmpeg: true }).success).toBe(true);
    expect(out.safeParse({ codexAuth: "bogus", ffmpeg: true }).success).toBe(false);
  });
});
