import { registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * The sources use extension-ful `.js` specifiers, which is what the plugin's
 * esbuild bundler expects; Node's type stripping does not rewrite them, and
 * this tsconfig does not allow writing `.ts` in an import. So teach this
 * process to fall back to the TypeScript sibling, then load the module under
 * test dynamically — the hook has to be in place before the graph is linked.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".")) {
        const candidate = specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : `${specifier}.ts`;
        return nextResolve(candidate, context);
      }
      throw error;
    }
  },
});

const { listVoices, synthesizeChunk } = await import("../src/google-tts");

const KEY = "AIzaSy-super-secret-key-0123456789";

type Call = { url: string; init: RequestInit | undefined };

/** Run `body` with `fetch` answering `reply`, and hand back what was requested. */
async function withFetch<T>(
  reply: (call: Call) => Response | Promise<Response>,
  body: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), init };
    calls.push(call);
    return await reply(call);
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

test("synthesize posts the documented request", async () => {
  await withFetch(
    () => json({ audioContent: "QUJD" }),
    async (calls) => {
      const result = await synthesizeChunk({
        apiKey: KEY,
        text: "Привет",
        languageCode: "ru-RU",
        voiceName: "ru-RU-Wavenet-C",
        speakingRate: 1.25,
      });
      assert.deepEqual(result, { ok: true, audioBase64: "QUJD" });

      assert.equal(calls.length, 1);
      const url = new URL(calls[0]!.url);
      assert.equal(url.origin, "https://texttospeech.googleapis.com");
      assert.equal(url.pathname, "/v1/text:synthesize");
      assert.equal(url.searchParams.get("key"), KEY);

      const init = calls[0]!.init!;
      assert.equal(init.method, "POST");
      assert.deepEqual(init.headers, { "content-type": "application/json" });
      assert.deepEqual(JSON.parse(String(init.body)), {
        input: { text: "Привет" },
        voice: { languageCode: "ru-RU", name: "ru-RU-Wavenet-C" },
        audioConfig: { audioEncoding: "MP3", speakingRate: 1.25 },
      });
      assert.ok(init.signal, "the request carries an abort signal");
    },
  );
});

test("no voice name means Google picks the language default", async () => {
  await withFetch(
    () => json({ audioContent: "QUJD" }),
    async (calls) => {
      await synthesizeChunk({
        apiKey: KEY,
        text: "hi",
        languageCode: "en-US",
        voiceName: undefined,
        speakingRate: 1,
      });
      const body = JSON.parse(String(calls[0]!.init!.body)) as { voice: unknown };
      assert.deepEqual(body.voice, { languageCode: "en-US" });
    },
  );
});

test("a reply without audioContent is a request_failed", async () => {
  await withFetch(
    () => json({}),
    async () => {
      const result = await synthesizeChunk({
        apiKey: KEY,
        text: "hi",
        languageCode: "en-US",
        voiceName: undefined,
        speakingRate: 1,
      });
      assert.deepEqual(result, {
        ok: false,
        code: "request_failed",
        message: "Google Text-to-Speech returned no audio",
      });
    },
  );
});

test("a reply that is not JSON is a request_failed", async () => {
  await withFetch(
    () => new Response("<html>not json</html>", { status: 200 }),
    async () => {
      const result = await synthesizeChunk({
        apiKey: KEY,
        text: "hi",
        languageCode: "en-US",
        voiceName: undefined,
        speakingRate: 1,
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.code, "request_failed");
    },
  );
});

test("a network throw is a request_failed", async () => {
  await withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      const result = await synthesizeChunk({
        apiKey: KEY,
        text: "hi",
        languageCode: "en-US",
        voiceName: undefined,
        speakingRate: 1,
      });
      assert.equal(result.ok === false && result.code, "request_failed");
    },
  );
});

test("an aborted request is a request_failed", async () => {
  const controller = new AbortController();
  controller.abort();
  await withFetch(
    (call) => {
      call.init?.signal?.throwIfAborted();
      return json({ audioContent: "QUJD" });
    },
    async () => {
      const result = await synthesizeChunk({
        apiKey: KEY,
        text: "hi",
        languageCode: "en-US",
        voiceName: undefined,
        speakingRate: 1,
        signal: controller.signal,
      });
      assert.equal(result.ok === false && result.code, "request_failed");
    },
  );
});

const errorBody = (status: string, message: string, code: number) =>
  json({ error: { code, status, message } }, code);

const statusCases: Array<{ label: string; response: () => Response; code: string }> = [
  { label: "401", response: () => errorBody("UNAUTHENTICATED", "Request had invalid authentication credentials.", 401), code: "auth" },
  { label: "403", response: () => errorBody("PERMISSION_DENIED", "Cloud Text-to-Speech API has not been used in project 1.", 403), code: "auth" },
  { label: "400 with API_KEY_INVALID", response: () => errorBody("INVALID_ARGUMENT", "API key not valid. Please pass a valid API key. [reason: API_KEY_INVALID]", 400), code: "auth" },
  { label: "400 otherwise", response: () => errorBody("INVALID_ARGUMENT", "Input size limit exceeded.", 400), code: "request_failed" },
  { label: "429", response: () => errorBody("RESOURCE_EXHAUSTED", "Quota exceeded.", 429), code: "rate_limited" },
  { label: "500", response: () => errorBody("INTERNAL", "Internal error.", 500), code: "request_failed" },
];

for (const { label, response, code } of statusCases) {
  test(`HTTP ${label} maps to ${code}`, async () => {
    await withFetch(response, async () => {
      const result = await synthesizeChunk({
        apiKey: KEY,
        text: "hi",
        languageCode: "en-US",
        voiceName: undefined,
        speakingRate: 1,
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.code, code);
    });
  });
}

test("a 200 body carrying RESOURCE_EXHAUSTED in a 503 still rate-limits", async () => {
  await withFetch(
    () => errorBody("RESOURCE_EXHAUSTED", "Quota exceeded for quota metric.", 503),
    async () => {
      const result = await listVoices({ apiKey: KEY, languageCode: "ru-RU" });
      assert.equal(result.ok === false && result.code, "rate_limited");
    },
  );
});

test("the API key never reaches a returned message", async () => {
  // Google's errors quote the request back, key and all; this is exactly the
  // body that would leak it if `redact` were not applied.
  const leaky = () =>
    json(
      {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message:
            `API key not valid. Please pass a valid API key. Request: ` +
            `https://texttospeech.googleapis.com/v1/text:synthesize?key=${KEY} (key ${KEY})`,
        },
      },
      400,
    );

  await withFetch(leaky, async () => {
    const synth = await synthesizeChunk({
      apiKey: KEY,
      text: "hi",
      languageCode: "en-US",
      voiceName: undefined,
      speakingRate: 1,
    });
    assert.equal(synth.ok === false && synth.code, "auth");
    assert.ok(synth.ok === false && !synth.message.includes(KEY), synth.ok === false ? synth.message : "");
    assert.ok(synth.ok === false && synth.message.includes("REDACTED"));

    const voices = await listVoices({ apiKey: KEY, languageCode: "ru-RU" });
    assert.ok(voices.ok === false && !voices.message.includes(KEY), voices.ok === false ? voices.message : "");
  });
});

test("a network error mentioning the URL is redacted too", async () => {
  await withFetch(
    (call) => {
      throw new Error(`connect ECONNREFUSED for ${call.url}`);
    },
    async () => {
      const result = await synthesizeChunk({
        apiKey: KEY,
        text: "hi",
        languageCode: "en-US",
        voiceName: undefined,
        speakingRate: 1,
      });
      assert.equal(result.ok === false && result.code, "request_failed");
      assert.ok(result.ok === false && !result.message.includes(KEY), result.ok === false ? result.message : "");
    },
  );
});

test("voices are fetched by language and returned sorted by name", async () => {
  await withFetch(
    () =>
      json({
        voices: [
          { name: "ru-RU-Wavenet-C", languageCodes: ["ru-RU"], ssmlGender: "FEMALE", naturalSampleRateHertz: 24000 },
          { name: "ru-RU-Standard-A", languageCodes: ["ru-RU"], ssmlGender: "FEMALE", naturalSampleRateHertz: 24000 },
          { name: "ru-RU-Wavenet-B", languageCodes: ["ru-RU"], ssmlGender: "MALE", naturalSampleRateHertz: 24000 },
        ],
      }),
    async (calls) => {
      const result = await listVoices({ apiKey: KEY, languageCode: "ru-RU" });
      assert.equal(result.ok, true);
      assert.deepEqual(
        result.ok === true ? result.voices.map((voice) => voice.name) : [],
        ["ru-RU-Standard-A", "ru-RU-Wavenet-B", "ru-RU-Wavenet-C"],
      );
      assert.deepEqual(result.ok === true ? result.voices[0] : undefined, {
        name: "ru-RU-Standard-A",
        languageCodes: ["ru-RU"],
        ssmlGender: "FEMALE",
      });

      const url = new URL(calls[0]!.url);
      assert.equal(url.pathname, "/v1/voices");
      assert.equal(url.searchParams.get("languageCode"), "ru-RU");
      assert.equal(url.searchParams.get("key"), KEY);
      assert.equal(calls[0]!.init!.method, "GET");
    },
  );
});

test("a voice list that is not a list is a request_failed", async () => {
  await withFetch(
    () => json({}),
    async () => {
      const result = await listVoices({ apiKey: KEY, languageCode: "ru-RU" });
      assert.equal(result.ok === false && result.code, "request_failed");
    },
  );
});
