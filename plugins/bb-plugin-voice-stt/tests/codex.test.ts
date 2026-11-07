import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiServiceFailure } from "../src/contract.js";
import {
  classifyAuthJson,
  codexAuthPath,
  mapCodexAuthState,
  readCodexAuthCredentials,
  readCodexAuthFile,
  resolveCodexHome,
  transcribeCodex,
  CODEX_TRANSCRIBE_MODEL,
} from "../src/codex.js";
import { chatGptClaimsJwt, fakeJwt, fakeResponse, recordingFetch, writeCodexHome } from "./helpers.js";

const AUTH_NS = "https://api.openai.com/auth";

const accessJwt = (claims: Record<string, unknown>, exp?: number) =>
  fakeJwt({ [AUTH_NS]: claims, ...(exp !== undefined ? { exp } : {}) });

const chatGptAuth = (exp?: number) => ({
  auth_mode: "chatgpt",
  tokens: {
    access_token: accessJwt({ chatgpt_account_id: "acct_test_1" }, exp),
    id_token: chatGptClaimsJwt({ chatgpt_account_id: "acct_test_1" }),
    account_id: "acct_test_1",
  },
});

describe("classifyAuthJson (порт provider-codex, §7.1)", () => {
  it("apikey auth_mode yields apiKey credentials", () => {
    const result = classifyAuthJson({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" });
    expect(result).toEqual({ state: "ok", credentials: { type: "apiKey", apiKey: "sk-test" } });
  });

  it("bare OPENAI_API_KEY without auth_mode is apiKey too", () => {
    const result = classifyAuthJson({ OPENAI_API_KEY: "sk-test" });
    expect(result.state).toBe("ok");
  });

  it("apikey mode without a key is unusable", () => {
    expect(classifyAuthJson({ auth_mode: "apikey" })).toEqual({
      state: "unusable",
      reason: "api_key",
    });
  });

  it("chatgpt mode reads account_id from tokens", () => {
    const result = classifyAuthJson(chatGptAuth());
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.credentials.type).toBe("chatgpt");
    if (result.credentials.type !== "chatgpt") return;
    expect(result.credentials.accountId).toBe("acct_test_1");
    expect(result.credentials.expired).toBe(false);
  });

  it("falls back to chatgpt_account_id inside the JWT claims", () => {
    const result = classifyAuthJson({
      tokens: { access_token: accessJwt({ chatgpt_account_id: "acct_from_jwt" }) },
    });
    expect(result.state).toBe("ok");
    if (result.state !== "ok" || result.credentials.type !== "chatgpt") return;
    expect(result.credentials.accountId).toBe("acct_from_jwt");
  });

  it("accepts an already-decoded id_token claims object", () => {
    const result = classifyAuthJson({
      tokens: {
        access_token: accessJwt({}),
        id_token: { chatgpt_account_id: "acct_object" },
      },
    });
    expect(result.state).toBe("ok");
    if (result.state !== "ok" || result.credentials.type !== "chatgpt") return;
    expect(result.credentials.accountId).toBe("acct_object");
  });

  it("marks an expired access token but stays ok", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const result = classifyAuthJson(chatGptAuth(past));
    expect(result.state).toBe("ok");
    if (result.state !== "ok" || result.credentials.type !== "chatgpt") return;
    expect(result.credentials.expired).toBe(true);
  });

  it("missing access_token and missing account_id are unusable", () => {
    expect(classifyAuthJson({ tokens: {} })).toEqual({
      state: "unusable",
      reason: "access_token",
    });
    expect(classifyAuthJson({ tokens: { access_token: accessJwt({}) } })).toEqual({
      state: "unusable",
      reason: "account_id",
    });
  });

  it("non-object input is unusable", () => {
    expect(classifyAuthJson("nope")).toEqual({ state: "unusable", reason: "not_object" });
  });
});

describe("readCodexAuthFile / mapCodexAuthState (§7.1)", () => {
  it("missing file maps to missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-stt-test-"));
    return readCodexAuthFile({ env: { CODEX_HOME: dir } }).then((state) => {
      expect(mapCodexAuthState(state)).toBe("missing");
    });
  });

  it("malformed JSON maps to invalid", async () => {
    const dir = writeCodexHome("{not json");
    const state = await readCodexAuthFile({ env: { CODEX_HOME: dir } });
    expect(mapCodexAuthState(state)).toBe("invalid");
  });

  it("unusable content maps to unusable", async () => {
    const dir = writeCodexHome({ tokens: {} });
    const state = await readCodexAuthFile({ env: { CODEX_HOME: dir } });
    expect(mapCodexAuthState(state)).toBe("unusable");
  });

  it("expired token maps to expired", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const dir = writeCodexHome(chatGptAuth(past));
    const state = await readCodexAuthFile({ env: { CODEX_HOME: dir } });
    expect(mapCodexAuthState(state)).toBe("expired");
  });

  it("ok maps to ok; CODEX_HOME is honoured", async () => {
    const dir = writeCodexHome(chatGptAuth());
    const state = await readCodexAuthFile({ homeDir: "/nonexistent-home", env: { CODEX_HOME: dir } });
    expect(mapCodexAuthState(state)).toBe("ok");
    expect(codexAuthPath("/h", { CODEX_HOME: dir })).toBe(join(dir, "auth.json"));
    expect(resolveCodexHome("/h", {})).toBe(join("/h", ".codex"));
  });

  it("readCodexAuthCredentials throws auth_required on missing/malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-stt-test-"));
    await expect(readCodexAuthCredentials({ env: { CODEX_HOME: dir } })).rejects.toMatchObject({
      name: "AiServiceFailure",
      code: "auth_required",
      detailCode: "codex_auth_missing",
    });
    const bad = writeCodexHome("{oops");
    await expect(readCodexAuthCredentials({ env: { CODEX_HOME: bad } })).rejects.toMatchObject({
      code: "auth_required",
      detailCode: "codex_auth_invalid",
    });
  });
});

describe("transcribeCodex transport (§7.2)", () => {
  const audio = Buffer.from("fake-webm-audio");
  const baseInput = {
    audio,
    mimeType: "audio/webm",
    filename: "voice.webm",
    hint: null as string | null,
    timeoutMs: 15_000,
  };

  const codexHome = () => writeCodexHome(chatGptAuth());

  it("posts multipart to chatgpt.com with the codex headers", async () => {
    const { fetchImpl, calls } = recordingFetch(() => fakeResponse('{"text":"привет"}'));
    const text = await transcribeCodex({ ...baseInput, fetchImpl, env: { CODEX_HOME: codexHome() } });
    expect(text).toBe("привет");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/transcribe");
    expect(call.headers.get("Authorization")).toMatch(/^Bearer /);
    expect(call.headers.get("chatgpt-account-id")).toBe("acct_test_1");
    expect(call.headers.get("originator")).toBe("bb");
    expect(call.headers.get("User-Agent")).toBe("bb-host-daemon");
    expect(call.form.get("model")).toBe(CODEX_TRANSCRIBE_MODEL);
    expect(call.form.get("prompt")).toBeNull();
    const file = call.form.get("file") as File;
    expect(file.name).toBe("voice.webm");
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(audio.length);
  });

  it("sets prompt only when a hint is present", async () => {
    const { fetchImpl, calls } = recordingFetch(() => fakeResponse('{"text":"x"}'));
    await transcribeCodex({ ...baseInput, hint: "имена: Девин", fetchImpl, env: { CODEX_HOME: codexHome() } });
    expect(calls[0]!.form.get("prompt")).toBe("имена: Девин");
  });

  it("apikey credentials go to api.openai.com", async () => {
    const dir = writeCodexHome({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" });
    const { fetchImpl, calls } = recordingFetch(() => fakeResponse('{"text":"x"}'));
    await transcribeCodex({ ...baseInput, fetchImpl, env: { CODEX_HOME: dir } });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer sk-test");
    expect(calls[0]!.headers.get("chatgpt-account-id")).toBeNull();
  });

  it("fedramp accounts get the X-OpenAI-Fedramp header", async () => {
    const dir = writeCodexHome({
      tokens: {
        access_token: accessJwt({ chatgpt_account_id: "a", chatgpt_account_is_fedramp: true }),
      },
    });
    const { fetchImpl, calls } = recordingFetch(() => fakeResponse('{"text":"x"}'));
    await transcribeCodex({ ...baseInput, fetchImpl, env: { CODEX_HOME: dir } });
    expect(calls[0]!.headers.get("X-OpenAI-Fedramp")).toBe("true");
  });

  it("maps HTTP statuses to failure codes", async () => {
    const cases: Array<[number, string]> = [
      [401, "auth_required"],
      [429, "rate_limited"],
      [503, "service_unavailable"],
      [400, "request_failed"],
    ];
    for (const [status, code] of cases) {
      const { fetchImpl } = recordingFetch(() => fakeResponse("oops", { status }));
      const error = await transcribeCodex({
        ...baseInput,
        fetchImpl,
        env: { CODEX_HOME: codexHome() },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiServiceFailure);
      expect((error as AiServiceFailure).code).toBe(code);
    }
  });

  it("detects a Cloudflare challenge by the cf-mitigated header", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
    );
    const error = await transcribeCodex({
      ...baseInput,
      fetchImpl,
      env: { CODEX_HOME: codexHome() },
    }).catch((e: unknown) => e);
    expect((error as AiServiceFailure).code).toBe("service_unavailable");
    expect((error as AiServiceFailure).message).toContain("Cloudflare");
  });

  it("detects a Cloudflare challenge by an HTML body on 403", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse("<html>cf</html>", { status: 403, headers: { "content-type": "text/html" } }),
    );
    const error = await transcribeCodex({
      ...baseInput,
      fetchImpl,
      env: { CODEX_HOME: codexHome() },
    }).catch((e: unknown) => e);
    expect((error as AiServiceFailure).code).toBe("service_unavailable");
  });

  it("non-JSON or missing text field is invalid_response", async () => {
    for (const body of ["<html>nope</html>", '{"result":"x"}']) {
      const { fetchImpl } = recordingFetch(() => fakeResponse(body));
      const error = await transcribeCodex({
        ...baseInput,
        fetchImpl,
        env: { CODEX_HOME: codexHome() },
      }).catch((e: unknown) => e);
      expect((error as AiServiceFailure).code).toBe("invalid_response");
    }
  });

  it("extracts the provider error message from the body", async () => {
    const { fetchImpl } = recordingFetch(() =>
      fakeResponse('{"error":{"message":"model unavailable"}}', { status: 400 }),
    );
    const error = await transcribeCodex({
      ...baseInput,
      fetchImpl,
      env: { CODEX_HOME: codexHome() },
    }).catch((e: unknown) => e);
    expect((error as AiServiceFailure).message).toContain("model unavailable");
  });

  it("times out as `timeout`", async () => {
    const fetchImpl = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const error = await transcribeCodex({
      ...baseInput,
      timeoutMs: 5,
      fetchImpl,
      env: { CODEX_HOME: codexHome() },
    }).catch((e: unknown) => e);
    expect((error as AiServiceFailure).code).toBe("timeout");
  });
});
