/**
 * Shared test scaffolding.
 *
 * Two rules every handler test here obeys:
 *
 * - The real `~/.pi/agent/models.json` is never read for a fixture and never
 *   written. Every test points `PI_GATEWAYS_MODELS_JSON` at its own temp file.
 * - Planted credentials are asserted absent from everything the plugin
 *   produces: RPC outputs, the manifest file, and error messages.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

import hostEntry from "../host.ts";

export interface Sandbox {
  root: string;
  dataDir: string;
  tempDir: string;
  modelsPath: string;
  harness: ReturnType<typeof experimental_createHostEntryHarness<never, never>> extends never
    ? never
    : ReturnType<typeof makeHarness>;
  writeModels(file: unknown): void;
  readModels(): { providers?: Record<string, Record<string, unknown>>; [key: string]: unknown };
  readModelsRaw(): string;
  readManifestRaw(): string;
  dispose(): Promise<void>;
}

/**
 * Credentials planted into fixtures. Every harness call in the suite has its
 * output and its error message checked against this list, so a leak added by a
 * future change fails a test that nobody had to remember to write.
 */
const planted = new Set<string>();

export function plant(secret: string): string {
  planted.add(secret);
  return secret;
}

function makeHarness(dataDir: string, tempDir: string) {
  const harness = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir, tempDir },
  });
  const call = harness.experimental_call.bind(harness);
  return Object.assign(harness, {
    experimental_call: (async (method: never, input: never, options?: never) => {
      try {
        const output = await call(method, input, options);
        for (const secret of planted) assertNoSecret(output, secret, `${String(method)} output`);
        return output;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const secret of planted) assertNoSecret(message, secret, `${String(method)} error`);
        throw error;
      }
    }) as typeof harness.experimental_call,
  });
}

/**
 * A complete, isolated world: temp models.json, temp plugin data dir, and a
 * stubbed pi provider catalogue so reserved-id discovery is "complete" without
 * depending on what happens to be installed on the machine running the tests.
 */
export function sandbox(opts: { reserved?: string[] } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-gateways-test-"));
  const dataDir = join(root, "host-data");
  const tempDir = join(root, "tmp");
  const modelsPath = join(root, "pi", "models.json");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(join(root, "pi"), { recursive: true });

  const providerData = join(root, "pi-providers-data");
  mkdirSync(providerData, { recursive: true });
  for (const id of opts.reserved ?? ["openai", "anthropic", "opencode"]) {
    writeFileSync(join(providerData, `${id}.json`), "{}");
  }

  process.env.PI_GATEWAYS_MODELS_JSON = modelsPath;
  process.env.PI_GATEWAYS_PI_PROVIDERS_DATA = providerData;

  const harness = makeHarness(dataDir, tempDir);

  return {
    root,
    dataDir,
    tempDir,
    modelsPath,
    harness,
    writeModels(file: unknown) {
      writeFileSync(modelsPath, `${JSON.stringify(file, null, 2)}\n`);
    },
    readModels() {
      return JSON.parse(readFileSync(modelsPath, "utf8"));
    },
    readModelsRaw() {
      return readFileSync(modelsPath, "utf8");
    },
    readManifestRaw() {
      try {
        return readFileSync(join(dataDir, "custom-endpoints.json"), "utf8");
      } catch {
        return "";
      }
    },
    async dispose() {
      await harness.experimental_dispose();
      rmSync(root, { recursive: true, force: true });
    },
  } as Sandbox;
}

/** Assert a planted credential appears nowhere in a value the plugin produced. */
export function assertNoSecret(value: unknown, secret: string, context: string): void {
  const serialised = typeof value === "string" ? value : JSON.stringify(value ?? null);
  assert.equal(
    serialised.includes(secret),
    false,
    `${context} leaked the credential: ${serialised.slice(0, 400)}`,
  );
}

export async function expectRejection(promise: Promise<unknown>, secret?: string): Promise<string> {
  try {
    await promise;
    assert.fail("expected the call to be refused");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (secret) assertNoSecret(message, secret, "the error message");
    return message;
  }
}

export function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Foreign Gateway",
    baseUrl: "https://gateway.example/v1",
    api: "openai-completions",
    apiKey: "!pi-key-foreign",
    models: [{ id: "model-a" }, { id: "model-b" }],
    ...overrides,
  };
}

export interface CatalogueStub {
  calls: Array<{ url: string; authorization?: string }>;
  restore(): void;
}

/**
 * Stand in for a gateway's `/models` endpoint (and its chat endpoint, so probes
 * can smoke-test). Records the authorization header so tests can prove which
 * credential the plugin actually used without the plugin ever returning it.
 */
export function stubCatalogue(
  entries: Array<Record<string, unknown>>,
  opts: { fail?: boolean } = {},
): CatalogueStub {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; authorization?: string }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization") ?? undefined });
    if (opts.fail) return new Response("nope", { status: 500 });
    if (url.endsWith("/models")) return Response.json({ data: entries });
    return Response.json({ choices: [] });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}
