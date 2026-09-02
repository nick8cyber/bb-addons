/**
 * Stop has to reach Google, not just the browser.
 *
 * The player aborts its own fetch when a reading is stopped, and always did;
 * what it could not do was tell the server, because an rpc handler is handed
 * nothing but its validated input — no request, no signal. Up to five chunks
 * were therefore still being generated, and paid for, after the audio went
 * quiet. Synthesis now answers on `bb.http` as well, where the handler is given
 * the request and can pass its signal down to `fetch`.
 *
 * These run against the SDK's fake host, so what is exercised is the real
 * registration, a real Hono context, and the real handler — the only stand-in
 * is Google itself.
 *
 *   node --experimental-strip-types --test tests/server-abort.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

/** The sources import with `.js`, as the bundler wants; here they are `.ts`. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: "module-typescript", shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { default: plugin } = await import("../server.js");
const { DEFAULT_MODEL, FALLBACK_MODEL, PCM_SAMPLE_RATE } = await import("../src/contract.js");

const KEY = "AIzaSy-test-key-not-a-real-one-0123";
const PCM_BASE64 = Buffer.from(new Uint8Array([0, 0, 1, 0])).toString("base64");

const audioReply = () =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: `audio/L16;rate=${PCM_SAMPLE_RATE}`, data: PCM_BASE64 } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** Google's body for a spent daily allowance, which would bench a model. */
const quotaReply = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 429,
        message: "Quota exceeded",
        details: [
          {
            violations: [
              { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" },
              { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" },
            ],
          },
        ],
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );

type Upstream = {
  /** Every call made to "Google", newest last. */
  calls: Array<{ url: string; signal: AbortSignal | undefined }>;
  /** Resolves once the first upstream call has been made. */
  started: Promise<void>;
};

/**
 * Stand in for Google with a `fetch` that answers only when told to, so a test
 * can abort a request that is genuinely in flight rather than one that has
 * already been answered.
 */
function withUpstream(
  reply: (signal: AbortSignal | undefined) => Promise<Response> | Response,
): { upstream: Upstream; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Upstream["calls"] = [];
  let announce!: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal ?? undefined });
    announce();
    return await reply(init?.signal ?? undefined);
  }) as typeof fetch;
  return { upstream: { calls, started }, restore: () => (globalThis.fetch = original) };
}

/** A reply that never comes, and rejects the way `fetch` does when aborted. */
const neverUntilAborted = (signal: AbortSignal | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const stop = () => reject(new DOMException("This operation was aborted", "AbortError"));
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });

async function speakHost() {
  const host = createFakePluginHost({
    pluginId: "speak",
    settings: { geminiApiKey: KEY, baseUrl: "https://gemini.test/v1beta" },
  });
  await plugin(host.bb);
  return host;
}

const post = (
  host: Awaited<ReturnType<typeof speakHost>>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> =>
  host.harness.behavior.fetchHttp("POST", "/synthesize", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

test("stopping the reading aborts the request to Google", async () => {
  const { upstream, restore } = withUpstream(neverUntilAborted);
  const host = await speakHost();
  try {
    const controller = new AbortController();
    const pending = post(host, { text: "Читай пока не остановят.", chunkIndex: 0 }, controller.signal);

    await upstream.started;
    const sent = upstream.calls[0]!;
    assert.equal(sent.signal?.aborted, false, "Google is still being waited on");

    controller.abort();
    const response = await pending;

    assert.equal(
      sent.signal?.aborted,
      true,
      "the fetch to Google saw the browser's abort",
    );
    assert.equal(upstream.calls.length, 1);
    assert.equal(response.status, 499);
    assert.equal(await response.text(), "");
  } finally {
    restore();
    await host.harness.lifecycle.dispose();
  }
});

test("a stopped reading is neither a failure to log nor a model to bench", async () => {
  const { upstream, restore } = withUpstream(neverUntilAborted);
  const host = await speakHost();
  try {
    const controller = new AbortController();
    const pending = post(host, { text: "Тишина после стопа.", chunkIndex: 0 }, controller.signal);
    await upstream.started;
    controller.abort();
    await pending;

    assert.equal(upstream.calls.length, 1, "the fallback model must not be tried");
    assert.deepEqual(
      await host.bb.storage.kv.list("quota-cooldown:"),
      [],
      "no model is benched by a cancellation",
    );
    assert.deepEqual(
      host.harness.inspection.logEntries.filter((entry) => entry.level === "warn"),
      [],
      "a cancellation is not a warning",
    );
  } finally {
    restore();
    await host.harness.lifecycle.dispose();
  }
});

test("a quota reply that lands after the stop still benches nothing", async () => {
  // The far end can win the race: the body arrives just as the caller leaves.
  // Reading a 429 out of it would bench a model for a request nobody made.
  let abort!: () => void;
  const { upstream, restore } = withUpstream((signal) => {
    // The caller leaves while the reply is on the wire; `abort()` is
    // synchronous, so by the time this body is handed back the signal has
    // already fired and the answer is one nobody asked for any more.
    abort();
    assert.equal(signal?.aborted, true);
    return quotaReply();
  });
  const host = await speakHost();
  try {
    const controller = new AbortController();
    abort = () => controller.abort();
    const response = await post(host, { text: "Гонка на финише.", chunkIndex: 0 }, controller.signal);

    assert.equal(response.status, 499);
    assert.equal(upstream.calls.length, 1, "no second model after a cancellation");
    assert.deepEqual(await host.bb.storage.kv.list("quota-cooldown:"), []);
    assert.deepEqual(
      host.harness.inspection.logEntries.filter((entry) => entry.level === "warn"),
      [],
    );
  } finally {
    restore();
    await host.harness.lifecycle.dispose();
  }
});

test("a genuine quota failure still fails over and benches the model", async () => {
  // The other half of the claim: nothing above weakened the ordinary path.
  const { upstream, restore } = withUpstream((signal) => {
    assert.equal(signal?.aborted, false, "a live caller is never pre-aborted");
    return upstream.calls.length === 1 ? quotaReply() : audioReply();
  });
  const host = await speakHost();
  try {
    const response = await post(host, { text: "Обычная работа.", chunkIndex: 0 });
    const body = (await response.json()) as { ok: boolean; result: { ok: boolean; model: string } };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.ok, true);
    assert.equal(body.result.model, FALLBACK_MODEL);
    assert.equal(upstream.calls.length, 2, "the primary is retried on the fallback");
    assert.deepEqual(await host.bb.storage.kv.list("quota-cooldown:"), [
      `quota-cooldown:${DEFAULT_MODEL}`,
    ]);
  } finally {
    restore();
    await host.harness.lifecycle.dispose();
  }
});

test("the route answers the same envelope the rpc method does", async () => {
  const { upstream, restore } = withUpstream(() => audioReply());
  const host = await speakHost();
  try {
    const response = await post(host, { text: "Одно и то же.", chunkIndex: 0 });
    const overRoute = await response.json();
    const overRpc = await host.harness.behavior.callRpc("synthesize", {
      text: "Одно и то же.",
      chunkIndex: 0,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(overRoute, { ok: true, result: overRpc });
    assert.equal(upstream.calls.length, 2);
  } finally {
    restore();
    await host.harness.lifecycle.dispose();
  }
});

test("a body that is not the contract is refused before Google is called", async () => {
  const { upstream, restore } = withUpstream(() => audioReply());
  const host = await speakHost();
  try {
    const notJson = await host.harness.behavior.fetchHttp("POST", "/synthesize", {
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const wrongShape = await post(host, { text: "no index" });

    assert.equal(notJson.status, 400);
    assert.equal(wrongShape.status, 400);
    assert.equal(upstream.calls.length, 0, "nothing reached Google");
  } finally {
    restore();
    await host.harness.lifecycle.dispose();
  }
});
