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

const { synthesizeChunk, wrapPcmAsWav } = await import("../src/gemini-tts");
const { PCM_CHANNELS, PCM_SAMPLE_RATE, PCM_SAMPLE_WIDTH } = await import("../src/contract");

const KEY = "AIzaSy-super-secret-key-0123456789";
const MODEL = "gemini-2.5-flash-preview-tts";

/** Four samples of raw 16-bit little-endian PCM: 0, 1, -1, 0x1234. */
const PCM = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0xff, 0xff, 0x34, 0x12]);
const PCM_BASE64 = Buffer.from(PCM).toString("base64");

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

/** A well-formed reply, under whichever spelling of the key the API chose. */
const audioReply = (spelling: "inlineData" | "inline_data", data = PCM_BASE64): unknown => ({
  candidates: [
    {
      content: {
        parts: [
          { text: "" },
          { [spelling]: { mimeType: "audio/L16;codec=pcm;rate=24000", data } },
        ],
      },
    },
  ],
});

const speak = (over: Partial<Parameters<typeof synthesizeChunk>[0]> = {}) =>
  synthesizeChunk({ apiKey: KEY, text: "Привет", voice: "Kore", model: MODEL, ...over });

test("synthesize posts the documented request", async () => {
  await withFetch(
    () => json(audioReply("inlineData")),
    async (calls) => {
      const result = await speak({ text: "Привет", voice: "Kore" });
      assert.equal(result.ok, true);

      assert.equal(calls.length, 1);
      const url = new URL(calls[0]!.url);
      assert.equal(url.origin, "https://generativelanguage.googleapis.com");
      assert.equal(url.pathname, `/v1beta/models/${MODEL}:generateContent`);
      assert.equal(url.searchParams.get("key"), KEY);

      const init = calls[0]!.init!;
      assert.equal(init.method, "POST");
      assert.deepEqual(init.headers, { "content-type": "application/json" });
      assert.deepEqual(JSON.parse(String(init.body)), {
        contents: [{ parts: [{ text: "Привет" }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
        },
      });
      assert.ok(init.signal, "the request carries an abort signal");
    },
  );
});

test("the voice and the model are the ones passed in", async () => {
  await withFetch(
    () => json(audioReply("inlineData")),
    async (calls) => {
      await speak({ voice: "Puck", model: "gemini-2.5-pro-preview-tts" });
      const url = new URL(calls[0]!.url);
      assert.equal(url.pathname, "/v1beta/models/gemini-2.5-pro-preview-tts:generateContent");
      const body = JSON.parse(String(calls[0]!.init!.body)) as {
        generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } };
      };
      assert.equal(
        body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
        "Puck",
      );
    },
  );
});

test("wrapPcmAsWav writes a 44-byte RIFF/WAVE header, little-endian", () => {
  const wav = wrapPcmAsWav(PCM);
  assert.equal(wav.length, 44 + PCM.length);

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(...wav.subarray(offset, offset + 4));

  const byteRate = PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_SAMPLE_WIDTH;

  assert.equal(tag(0), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + PCM.length);
  assert.equal(tag(8), "WAVE");
  assert.equal(tag(12), "fmt ");
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), PCM_CHANNELS);
  assert.equal(view.getUint32(24, true), PCM_SAMPLE_RATE);
  assert.equal(view.getUint32(28, true), byteRate);
  assert.equal(view.getUint16(32, true), PCM_CHANNELS * PCM_SAMPLE_WIDTH);
  assert.equal(view.getUint16(34, true), PCM_SAMPLE_WIDTH * 8);
  assert.equal(tag(36), "data");
  assert.equal(view.getUint32(40, true), PCM.length);
  assert.deepEqual(wav.subarray(44), PCM);

  // Byte for byte, for 24 kHz mono 16-bit: this is what an `<audio>` element
  // has to see, and a big-endian slip here is silent until playback.
  assert.deepEqual(
    [...wav.subarray(0, 44)],
    [
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x2c, 0x00, 0x00, 0x00, // 36 + 8
      0x57, 0x41, 0x56, 0x45, // "WAVE"
      0x66, 0x6d, 0x74, 0x20, // "fmt "
      0x10, 0x00, 0x00, 0x00, // 16
      0x01, 0x00, //             PCM
      0x01, 0x00, //             1 channel
      0xc0, 0x5d, 0x00, 0x00, // 24000
      0x80, 0xbb, 0x00, 0x00, // 48000 bytes a second
      0x02, 0x00, //             block align
      0x10, 0x00, //             16 bits a sample
      0x64, 0x61, 0x74, 0x61, // "data"
      0x08, 0x00, 0x00, 0x00, // 8 bytes of data
    ],
  );
});

test("the returned base64 is the WAV, not the bare PCM", async () => {
  await withFetch(
    () => json(audioReply("inlineData")),
    async () => {
      const result = await speak();
      assert.equal(result.ok, true);
      assert.ok(result.ok);
      const decoded = new Uint8Array(Buffer.from(result.wavBase64, "base64"));
      assert.deepEqual(decoded, wrapPcmAsWav(PCM));
    },
  );
});

test("inline_data is accepted as well as inlineData", async () => {
  for (const spelling of ["inlineData", "inline_data"] as const) {
    await withFetch(
      () => json(audioReply(spelling)),
      async () => {
        const result = await speak();
        assert.ok(result.ok, `${spelling} was not recognised`);
        assert.deepEqual(
          new Uint8Array(Buffer.from(result.wavBase64, "base64")),
          wrapPcmAsWav(PCM),
        );
      },
    );
  }
});

test("a reply with no candidate, no audio part or empty data is a request_failed", async () => {
  const bodies: unknown[] = [
    {},
    { candidates: [] },
    { candidates: [{ content: {} }] },
    { candidates: [{ content: { parts: [{ text: "sorry" }] } }] },
    audioReply("inlineData", ""),
  ];
  for (const body of bodies) {
    await withFetch(
      () => json(body),
      async () => {
        const result = await speak();
        assert.deepEqual(result, {
          ok: false,
          code: "request_failed",
          message: "Gemini TTS returned no audio",
        });
      },
    );
  }
});

test("a reply that is not JSON is a request_failed", async () => {
  await withFetch(
    () => new Response("<html>gateway</html>", { status: 200 }),
    async () => {
      const result = await speak();
      assert.deepEqual(result, {
        ok: false,
        code: "request_failed",
        message: "Gemini TTS returned a reply that is not JSON",
      });
    },
  );
});

test("401, 403 and a 400 naming the key are auth", async () => {
  const cases: Array<[number, unknown]> = [
    [401, { error: { message: "Request had invalid authentication credentials." } }],
    [403, { error: { message: "Permission denied." } }],
    [400, { error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }],
  ];
  for (const [status, body] of cases) {
    await withFetch(
      () => json(body, status),
      async () => {
        const result = await speak();
        assert.equal(result.ok, false);
        assert.ok(!result.ok);
        assert.equal(result.code, "auth", `HTTP ${status} should be auth`);
      },
    );
  }
});

test("429 and RESOURCE_EXHAUSTED are rate_limited", async () => {
  await withFetch(
    () => json({ error: { message: "Quota exceeded." } }, 429),
    async () => {
      const result = await speak();
      assert.ok(!result.ok);
      assert.equal(result.code, "rate_limited");
      assert.match(result.message, /Quota exceeded/);
    },
  );
  await withFetch(
    () => json({ error: { message: "Resource has been exhausted.", status: "RESOURCE_EXHAUSTED" } }, 503),
    async () => {
      const result = await speak();
      assert.ok(!result.ok);
      assert.equal(result.code, "rate_limited");
    },
  );
});

test("an unsupported voice is a request_failed, not an auth failure", async () => {
  // Verbatim from the live API: the key was perfectly good, the voice was not.
  const message =
    "Voice name NotARealVoice is not supported. Allowed voice names are: achernar, achird, algenib, algieba, alnilam, aoede, autonoe, callirrhoe, charon, despina, enceladus, erinome, fenrir, gacrux, iapetus, kore, laomedeia, leda, orus, puck, pulcherrima, rasalgethi, sadachbia, sadaltager, schedar, sulafat, umbriel, vindemiatrix, zephyr, zubenelgenubi";
  await withFetch(
    () => json({ error: { code: 400, message, status: "INVALID_ARGUMENT" } }, 400),
    async () => {
      const result = await speak({ voice: "NotARealVoice" });
      assert.ok(!result.ok);
      assert.equal(result.code, "request_failed");
      assert.match(result.message, /HTTP 400/);
      assert.match(result.message, /Voice name NotARealVoice is not supported/);
    },
  );
});

test("any other non-2xx status is a request_failed", async () => {
  for (const status of [404, 500, 502]) {
    await withFetch(
      () => json({ error: { message: "boom" } }, status),
      async () => {
        const result = await speak();
        assert.ok(!result.ok);
        assert.equal(result.code, "request_failed");
        assert.match(result.message, new RegExp(`HTTP ${status}`));
      },
    );
  }
});

test("a network throw is a request_failed", async () => {
  await withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      const result = await speak();
      assert.ok(!result.ok);
      assert.equal(result.code, "request_failed");
      assert.match(result.message, /unreachable/);
      // Nobody cancelled anything: this one is a failure the app should hear
      // about, and fail over on.
      assert.equal(result.cancelled, undefined);
    },
  );
});

test("the caller's signal reaches fetch", async () => {
  const controller = new AbortController();
  await withFetch(
    async (call) => {
      assert.ok(call.init?.signal, "no signal was passed to fetch");
      assert.equal(call.init.signal.aborted, false);
      controller.abort();
      assert.equal(call.init.signal.aborted, true, "aborting the caller aborts the fetch");
      call.init.signal.throwIfAborted();
      return json(audioReply("inlineData"));
    },
    async () => {
      const result = await speak({ signal: controller.signal });
      assert.ok(!result.ok);
      assert.equal(result.cancelled, true);
    },
  );
});

test("an abort is a cancellation, not a failure to report", async () => {
  const controller = new AbortController();
  controller.abort();
  await withFetch(
    async (call) => {
      // Behave like a real fetch: honour the signal it was handed.
      call.init?.signal?.throwIfAborted();
      return json(audioReply("inlineData"));
    },
    async () => {
      const result = await speak({ signal: controller.signal });
      assert.ok(!result.ok);
      // Still a failure — there is no audio — but flagged as the caller's own
      // doing, which is what keeps it out of the log and off the model chain.
      assert.equal(result.code, "request_failed");
      assert.equal(result.cancelled, true);
    },
  );
});

test("a reply that lands after the abort is still a cancellation", async () => {
  // The race the parallel chunks make real: Google answers, and a 429 read out
  // of that answer would bench a model on behalf of a request nobody made.
  const controller = new AbortController();
  await withFetch(
    () => {
      controller.abort();
      return json({ error: { message: "Quota exceeded" } }, 429);
    },
    async () => {
      const result = await speak({ signal: controller.signal });
      assert.ok(!result.ok);
      assert.equal(result.cancelled, true);
      assert.equal(result.quotaScope, undefined, "a cancelled call reports no quota");
    },
  );
});

test("the key never appears in a returned message", async () => {
  // The real API echoes the whole request URL back inside its error text.
  const echoed = `Invalid request to https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY} — the key ${KEY} was seen here.`;
  const bodies: Array<[number, string]> = [
    [400, JSON.stringify({ error: { message: echoed } })],
    [403, JSON.stringify({ error: { message: echoed } })],
    [429, JSON.stringify({ error: { message: echoed } })],
    [500, echoed], // not JSON at all: quoted as it came, still redacted
  ];
  for (const [status, body] of bodies) {
    await withFetch(
      () => new Response(body, { status }),
      async () => {
        const result = await speak();
        assert.ok(!result.ok);
        assert.ok(!result.message.includes(KEY), `the key leaked in: ${result.message}`);
        assert.ok(!result.message.includes("AIzaSy"), `a key prefix leaked in: ${result.message}`);
      },
    );
  }

  // And when the transport itself puts the URL in the error.
  await withFetch(
    () => {
      throw new Error(`connect ECONNREFUSED for ...:generateContent?key=${KEY}`);
    },
    async () => {
      const result = await speak();
      assert.ok(!result.ok);
      assert.ok(!result.message.includes(KEY), result.message);
      assert.match(result.message, /key=REDACTED/);
    },
  );
});
