import assert from "node:assert/strict";
import test from "node:test";

import {
  availableProviderId,
  findSavedProviderPreset,
} from "../src/presets.ts";
import {
  classifyCataloguePrice,
  fetchModelCatalogue,
  selectFreeModels,
} from "../src/gateways.ts";
import { contractSchemas } from "../src/contract.ts";

test("preset lookup and collision-safe ids", () => {
  const google = findSavedProviderPreset("google-ai-studio");
  assert.equal(google?.api, "google-generative-ai");
  assert.equal(google?.keyEnv, "GEMINI_API_KEY");
  assert.equal(
    availableProviderId("TokenRouter", new Set(["tokenrouter", "tokenrouter-2"])),
    "tokenrouter-3",
  );
});

test("OpenRouter and NVIDIA Build presets use official connection metadata", () => {
  const openrouter = findSavedProviderPreset("openrouter");
  assert.equal(openrouter?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(openrouter?.api, "openai-completions");
  assert.equal(openrouter?.keyEnv, "OPENROUTER_API_KEY");
  assert.equal(openrouter?.pricing, "catalogue");
  assert.equal(openrouter?.requiresExplicitModels, false);

  const nvidia = findSavedProviderPreset("nvidia-build");
  assert.equal(nvidia?.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.equal(nvidia?.api, "openai-completions");
  assert.equal(nvidia?.keyEnv, "NVIDIA_API_KEY");
  assert.equal(nvidia?.pricing, "unknown");
  assert.equal(nvidia?.requiresExplicitModels, true);

  const radeon = findSavedProviderPreset("radeon-cloud");
  assert.equal(radeon?.baseUrl, "https://developer.amd.com.cn/radeon/api/v1");
  assert.equal(radeon?.api, "openai-completions");
  assert.equal(radeon?.keyEnv, "RADEON_API_KEY");
  assert.equal(radeon?.pricing, "unknown");
  assert.equal(radeon?.requiresExplicitModels, true);
});

test("strict preset pricing never classifies an unpriced model as free", () => {
  const entries = [
    { id: "unpriced" },
    { id: "free", pricing: { prompt: "0", completion: 0 } },
    { id: "paid", pricing: { prompt: "0.1", completion: 0 } },
  ];

  assert.deepEqual(
    selectFreeModels(entries, "openai-completions", "catalogue"),
    [{ id: "free" }],
  );
  assert.deepEqual(
    selectFreeModels(entries, "openai-completions", "unknown"),
    [{ id: "free" }],
  );
  assert.deepEqual(
    classifyCataloguePrice(entries[0]!, "openai-completions", "unknown"),
    { free: false, priceKnown: false },
  );
  assert.deepEqual(
    selectFreeModels(entries, "openai-completions", "gateway-default"),
    [{ id: "free" }, { id: "unpriced" }],
  );
});

test("saved-provider ids are host-allocated rather than user input", () => {
  assert.equal("id" in contractSchemas.saveCustom.input.shape, false);
  assert.equal(
    availableProviderId("openrouter", new Set(["openrouter", "openrouter-2"])),
    "openrouter-3",
  );
});

test("Google discovery paginates with header auth and maps generateContent chat models", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];
  let page = 0;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    page += 1;
    return Response.json(
      page === 1
        ? {
            models: [
              {
                name: "models/gemini-chat",
                displayName: "Gemini Chat",
                inputTokenLimit: 1_000_000,
                outputTokenLimit: 8192,
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/text-embedding-004",
                displayName: "Embedding",
                supportedGenerationMethods: ["embedContent"],
              },
              {
                name: "models/gemini-image-preview",
                displayName: "Image generation",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
            nextPageToken: "next page",
          }
        : {
            models: [
              {
                name: "models/gemini-fast",
                displayName: "Gemini Fast",
                inputTokenLimit: 128_000,
                outputTokenLimit: 4096,
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          },
    );
  };

  try {
    const result = await fetchModelCatalogue({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      api: "google-generative-ai",
      token: "secret-value",
    });
    assert.deepEqual(result.entries, [
      {
        id: "gemini-chat",
        name: "Gemini Chat",
        context_length: 1_000_000,
        max_tokens: 8192,
      },
      {
        id: "gemini-fast",
        name: "Gemini Fast",
        context_length: 128_000,
        max_tokens: 4096,
      },
    ]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.headers.get("x-goog-api-key"), "secret-value");
    assert.equal(calls[0]?.url.includes("secret-value"), false);
    assert.equal(calls[0]?.url.endsWith("/models"), true);
    assert.equal(calls[1]?.url.endsWith("/models?pageToken=next%20page"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing Google pricing is never selected as free", () => {
  const entries = [{ id: "gemini-chat" }];
  assert.equal(selectFreeModels(entries, "google-generative-ai").length, 0);
  assert.equal(selectFreeModels(entries, "openai-completions").length, 1);
});
