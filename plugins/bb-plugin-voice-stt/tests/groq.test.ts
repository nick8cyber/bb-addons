import { describe, expect, it } from "vitest";
import { AiServiceFailure } from "../src/contract.js";
import { groqResponseFormat, transcribeGroq, GROQ_TRANSCRIBE_URL } from "../src/groq.js";
import { fakeResponse, recordingFetch } from "./helpers.js";

const baseInput = () => ({
  apiKey: "gsk_dummy_test_key",
  model: "whisper-large-v3-turbo",
  audio: Buffer.from("fake-webm"),
  mimeType: "audio/webm",
  filename: "voice.webm",
  language: null as string | null,
  hint: null as string | null,
  timeoutMs: 15_000,
});

describe("transcribeGroq (§8)", () => {
  it("posts to the Groq endpoint with bearer auth and verbose_json", async () => {
    const { fetchImpl, calls } = recordingFetch(() => fakeResponse('{"text":"привет"}'));
    const text = await transcribeGroq({ ...baseInput(), fetchImpl });
    expect(text).toBe("привет");
    const call = calls[0]!;
    expect(call.url).toBe(GROQ_TRANSCRIBE_URL);
    expect(call.headers.get("Authorization")).toBe("Bearer gsk_dummy_test_key");
    expect(call.form.get("model")).toBe("whisper-large-v3-turbo");
    expect(call.form.get("response_format")).toBe("verbose_json");
    expect(call.form.get("prompt")).toBeNull();
    expect(call.form.get("language")).toBeNull();
  });

  it("response_format depends on the model", () => {
    expect(groqResponseFormat("whisper-1")).toBe("verbose_json");
    expect(groqResponseFormat("whisper-large-v3")).toBe("verbose_json");
    expect(groqResponseFormat("whisper-large-v3-turbo")).toBe("verbose_json");
    expect(groqResponseFormat("distil-whisper-large-v3-en")).toBe("json");
  });

  it("sends language (ISO base) and prompt when set", async () => {
    const { fetchImpl, calls } = recordingFetch(() => fakeResponse('{"text":"x"}'));
    await transcribeGroq({ ...baseInput(), language: "ru", hint: "имена", fetchImpl });
    expect(calls[0]!.form.get("language")).toBe("ru");
    expect(calls[0]!.form.get("prompt")).toBe("имена");
  });

  it("maps statuses like codex", async () => {
    const cases: Array<[number, string]> = [
      [401, "auth_required"],
      [429, "rate_limited"],
      [500, "service_unavailable"],
      [400, "request_failed"],
    ];
    for (const [status, code] of cases) {
      const { fetchImpl } = recordingFetch(() => fakeResponse("err", { status }));
      const error = await transcribeGroq({ ...baseInput(), fetchImpl }).catch((e: unknown) => e);
      expect((error as AiServiceFailure).code).toBe(code);
    }
  });

  it("empty or missing text is invalid_response", async () => {
    for (const body of ['{"text":"   "}', '{"other":1}', "not json"]) {
      const { fetchImpl } = recordingFetch(() => fakeResponse(body));
      const error = await transcribeGroq({ ...baseInput(), fetchImpl }).catch((e: unknown) => e);
      expect((error as AiServiceFailure).code).toBe("invalid_response");
    }
  });
});
