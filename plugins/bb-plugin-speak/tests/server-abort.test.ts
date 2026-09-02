import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

/** Resolve the plugin's build-oriented .js specifiers to TypeScript in tests. */
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

test("aborting server synthesis aborts Google without fallback, cooldown, or warning", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "speak",
    settings: {
      geminiApiKey: "test-key-never-sent-to-google",
      baseUrl: "https://google.test/v1beta",
    },
  });
  await plugin(bb);

  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  let upstreamSignal: AbortSignal | undefined;
  let markUpstreamStarted!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => {
    markUpstreamStarted = resolve;
  });

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamCalls += 1;
    upstreamSignal = init?.signal ?? undefined;
    markUpstreamStarted();
    return await new Promise<Response>((_resolve, reject) => {
      if (upstreamSignal?.aborted) {
        reject(upstreamSignal.reason);
        return;
      }
      upstreamSignal?.addEventListener(
        "abort",
        () => reject(upstreamSignal?.reason),
        { once: true },
      );
    });
  }) as typeof fetch;

  try {
    const controller = new AbortController();
    const responsePending = harness.behavior.fetchHttp("POST", "/synthesize", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Cancel this request", chunkIndex: 0 }),
      signal: controller.signal,
    });

    await upstreamStarted;
    assert.equal(upstreamSignal?.aborted, false);
    controller.abort();

    const response = await responsePending;
    assert.equal(response.status, 499);
    assert.equal(upstreamSignal?.aborted, true, "the Google fetch sees the client abort");
    assert.equal(upstreamCalls, 1, "abort does not try the fallback model");
    assert.deepEqual(await bb.storage.kv.list("quota-cooldown:"), []);
    assert.deepEqual(
      harness.inspection.logEntries.filter((entry) => entry.level === "warn"),
      [],
      "abort is not logged as a synthesis warning",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await harness.lifecycle.dispose();
  }
});
