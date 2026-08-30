import assert from "node:assert/strict";
import test from "node:test";

import { assertNoSecret, block, plant, sandbox, stubCatalogue } from "./helpers.ts";

const SECRET = plant("sk-live-PLANTED-0123456789abcdef");
const HEADER_SECRET = plant("header-secret-value");
const FREE = { pricing: { prompt: "0", completion: "0" } };

test("a provider this plugin created is written as exactly the five fields it owns", async () => {
  const box = sandbox();
  const stub = stubCatalogue([{ id: "model-x", name: "Model X", ...FREE }]);
  process.env.PLUG6_SAVE_KEY = SECRET;
  try {
    const saved = await box.harness.experimental_call("saveCustom", {
      name: "My Gateway",
      baseUrl: "https://mine.example/v1",
      api: "openai-completions",
      keySource: { type: "env", name: "PLUG6_SAVE_KEY" },
      freeOnly: true,
      selectionMode: "all-free",
    });

    const written = box.readModels().providers![saved.id]!;
    assert.deepEqual(Object.keys(written).sort(), ["api", "apiKey", "baseUrl", "models", "name"]);
    assert.equal(written.apiKey, "$PLUG6_SAVE_KEY");
    assert.deepEqual(written.models, [{ id: "model-x", name: "Model X" }]);
    assertNoSecret(saved, SECRET, "the saveCustom response");
    assertNoSecret(box.readModelsRaw(), SECRET, "models.json");
    assertNoSecret(box.readManifestRaw(), SECRET, "the manifest");
    // The credential reached the gateway even though it never reached disk.
    assert.equal(stub.calls[0]?.authorization, `Bearer ${SECRET}`);
  } finally {
    delete process.env.PLUG6_SAVE_KEY;
    stub.restore();
    await box.dispose();
  }
});

test("refreshing an inline-keyed adopted block carries every foreign field forward", async () => {
  const box = sandbox();
  const stub = stubCatalogue([
    { id: "model-a", name: "A", context_length: 1000, ...FREE },
    { id: "model-c", name: "C", ...FREE },
  ]);
  try {
    box.writeModels({
      providers: {
        adopted: block({
          apiKey: SECRET,
          headers: { "x-org": HEADER_SECRET },
          unknownFuturePiField: { nested: [1, 2, 3] },
          models: [
            { id: "model-a", customCost: 7 },
            { id: "model-b", name: "B", vendorNote: "hand-written" },
          ],
        }),
      },
    });
    await box.harness.experimental_call("adopt", { id: "adopted" });

    const refreshed = await box.harness.experimental_call("refreshCustom", { ids: ["adopted"] });
    assert.deepEqual(refreshed.results[0]!.ok, true);
    // model-b is no longer in the catalogue but was selected: kept, and reported.
    assert.deepEqual(refreshed.results[0]!.missing, ["model-b"]);
    assert.match(refreshed.results[0]!.warning!, /model-b/);

    const after = box.readModels().providers!.adopted!;
    // The credential and the headers are byte-identical: we never re-encode them.
    assert.equal(after.apiKey, SECRET);
    assert.deepEqual(after.headers, { "x-org": HEADER_SECRET });
    assert.deepEqual(after.unknownFuturePiField, { nested: [1, 2, 3] });
    assert.deepEqual(after.models, [
      { id: "model-a", customCost: 7, name: "A", contextWindow: 1000 },
      { id: "model-b", name: "B", vendorNote: "hand-written" },
    ]);
    // The inline key was resolved live and used for the fetch.
    assert.equal(stub.calls.at(-1)?.authorization, `Bearer ${SECRET}`);
    assertNoSecret(refreshed, SECRET, "the refresh response");
    assertNoSecret(box.readManifestRaw(), SECRET, "the manifest");
  } finally {
    stub.restore();
    await box.dispose();
  }
});

test("editing an adopted provider preserves foreign fields and can pin unlisted models", async () => {
  const box = sandbox();
  const stub = stubCatalogue([{ id: "model-a", ...FREE }]);
  try {
    box.writeModels({
      providers: {
        adopted: block({
          apiKey: "!printf inline-token",
          vendorSection: { keep: "me" },
          models: [{ id: "model-a" }],
        }),
      },
    });
    await box.harness.experimental_call("adopt", { id: "adopted" });

    const updated = await box.harness.experimental_call("updateCustom", {
      id: "adopted",
      name: "Renamed Gateway",
      selectionMode: "explicit",
      selectedModelIds: ["model-a", "model-hidden"],
      allowUnverifiedModels: true,
    });
    assert.deepEqual(updated.missing, ["model-hidden"]);

    const after = box.readModels().providers!.adopted!;
    assert.equal(after.name, "Renamed Gateway");
    assert.equal(after.apiKey, "!printf inline-token");
    assert.deepEqual(after.vendorSection, { keep: "me" });
    assert.deepEqual(after.models, [{ id: "model-a" }, { id: "model-hidden" }]);
  } finally {
    stub.restore();
    await box.dispose();
  }
});

test("deleting an adopted provider can be softened to a disown", async () => {
  const box = sandbox();
  try {
    box.writeModels({ providers: { adopted: block({ apiKey: "!pi-key-a" }) } });
    await box.harness.experimental_call("adopt", { id: "adopted" });
    const before = box.readModelsRaw();

    const soft = await box.harness.experimental_call("deleteProvider", {
      id: "adopted",
      disownOnly: true,
    });
    assert.deepEqual(soft, { removed: [], disowned: true });
    assert.equal(box.readModelsRaw(), before);

    await box.harness.experimental_call("adopt", { id: "adopted" });
    const hard = await box.harness.experimental_call("deleteProvider", { id: "adopted" });
    assert.deepEqual(hard.removed, ["adopted"]);
    assert.deepEqual(box.readModels().providers, {});
  } finally {
    await box.dispose();
  }
});
