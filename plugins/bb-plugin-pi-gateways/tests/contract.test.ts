import assert from "node:assert/strict";
import test from "node:test";

import {
  contractSchemas,
  editableKeySourceSchema,
  manifestKeySourceSchema,
  providerRowSchema,
  rpcSchemas,
} from "../src/contract.ts";
import { displayKeyRef } from "../src/keyref.ts";

const INLINE = { type: "inline" } as const;

test("an inline key source is host-produced and never accepted from a client", () => {
  assert.equal(manifestKeySourceSchema.safeParse(INLINE).success, true);
  assert.equal(editableKeySourceSchema.safeParse(INLINE).success, false);

  const base = {
    name: "X",
    baseUrl: "https://x.example/v1",
    api: "openai-completions",
    freeOnly: true,
    selectionMode: "all-free",
  };
  assert.equal(
    contractSchemas.saveCustom.input.safeParse({ ...base, keySource: INLINE }).success,
    false,
  );
  assert.equal(
    contractSchemas.updateCustom.input.safeParse({ id: "x", keySource: INLINE }).success,
    false,
  );
  assert.equal(
    contractSchemas.adopt.input.safeParse({ id: "x", keyMigration: INLINE }).success,
    false,
  );
  assert.equal(
    contractSchemas.probe.input.safeParse({ ...base, keySource: INLINE }).success,
    false,
  );

  // The same inputs with a real source are accepted.
  assert.equal(
    contractSchemas.adopt.input.safeParse({ id: "x", keyMigration: { type: "env", name: "TOK" } })
      .success,
    true,
  );
});

test("a provider row can only carry a redacted key rendering", () => {
  const planted = "sk-live-PLANTED-0123456789abcdef";
  const row = providerRowSchema.parse({
    id: "x",
    apiSupported: true,
    ownership: "foreign",
    drifted: false,
    inModelsJson: true,
    modelCount: 1,
    keyRefKind: "literal",
    keyRefDisplay: displayKeyRef(planted),
    hasHeaders: true,
  });
  assert.equal(row.keyRefDisplay.includes(planted), false);
  assert.deepEqual(row.warnings, []);
  // There is nowhere on the row for a credential or a header value to live.
  assert.equal("apiKey" in row, false);
  assert.equal("headers" in row, false);
  assert.equal(providerRowSchema.safeParse({ id: "x" }).success, false);
});

test("deleting an unmanaged provider takes an explicit force flag", () => {
  assert.equal(contractSchemas.deleteProvider.input.safeParse({ id: "x" }).success, true);
  const forced = contractSchemas.deleteProvider.input.parse({ id: "x", force: true });
  assert.equal(forced.force, true);
  assert.equal(
    contractSchemas.deleteProvider.input.safeParse({ id: "x", force: "yes" }).success,
    false,
  );
});

test("refresh results can report drift and kept-but-delisted models", () => {
  const parsed = contractSchemas.refreshCustom.output.parse({
    modelsJsonPath: "/tmp/models.json",
    results: [{ id: "a", ok: true, modelCount: 2, missing: ["gone"], warning: "kept 1" }],
  });
  assert.deepEqual(parsed.results[0]!.missing, ["gone"]);
  assert.deepEqual(
    contractSchemas.refreshCustom.input.parse({ acceptDrift: ["a"] }).acceptDrift,
    ["a"],
  );
});

test("the RPC surface mirrors the host contract method for method", () => {
  const hostMethods = Object.keys(contractSchemas).sort();
  const rpcMethods = Object.keys(rpcSchemas)
    .filter((method) => method !== "hosts")
    .sort();
  assert.deepEqual(rpcMethods, hostMethods);

  for (const method of hostMethods) {
    const rpcInput = rpcSchemas[method as keyof typeof rpcSchemas].input;
    // Every RPC input carries the host picker; the host contract never does.
    assert.equal("host" in (rpcInput as { shape: Record<string, unknown> }).shape, true, method);
    assert.equal(
      "host" in (contractSchemas[method as keyof typeof contractSchemas].input as { shape: Record<string, unknown> }).shape,
      false,
      method,
    );
  }
});
