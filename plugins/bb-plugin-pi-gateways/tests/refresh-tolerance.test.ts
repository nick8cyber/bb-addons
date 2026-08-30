import assert from "node:assert/strict";
import test from "node:test";

import { selectModelsForSave } from "../src/custom.ts";
import { block, expectRejection, sandbox, stubCatalogue } from "./helpers.ts";

const FREE = { pricing: { prompt: "0", completion: "0" } };

const POLICY = {
  api: "openai-completions" as const,
  freeOnly: false,
  selectionMode: "explicit" as const,
  selectedModelIds: ["kept", "delisted"],
  pricingPolicy: "gateway-default" as const,
  requiresExplicitModels: false,
};

test("refresh mode keeps a delisted model verbatim; save mode still refuses", () => {
  const catalogue = [{ id: "kept", name: "Kept", ...FREE }];
  const liveModels = [
    { id: "kept", name: "old name" },
    { id: "delisted", name: "Delisted", contextWindow: 4096 },
  ];

  const refreshed = selectModelsForSave(catalogue, POLICY, { mode: "refresh", liveModels });
  assert.deepEqual(refreshed.missing, ["delisted"]);
  assert.deepEqual(refreshed.models, [
    { id: "delisted", name: "Delisted", contextWindow: 4096 },
    { id: "kept", name: "Kept" },
  ]);

  assert.throws(
    () => selectModelsForSave(catalogue, POLICY, { mode: "save", liveModels }),
    /catalogue no longer lists: delisted/,
  );

  // Explicitly allowing unverified ids is the save-mode escape hatch.
  const allowed = selectModelsForSave(catalogue, POLICY, {
    mode: "save",
    liveModels,
    allowUnverifiedModels: true,
  });
  assert.deepEqual(allowed.missing, ["delisted"]);
});

test("free-only selection still refuses paid models the catalogue does price", () => {
  assert.throws(
    () =>
      selectModelsForSave(
        [
          { id: "kept", pricing: { prompt: "0.5", completion: "1" } },
          { id: "delisted", ...FREE },
        ],
        { ...POLICY, freeOnly: true },
        { mode: "refresh" },
      ),
    /refusing to save paid models/,
  );
});

test("refresh refuses a drifted provider until the caller accepts the overwrite", async () => {
  const box = sandbox();
  const stub = stubCatalogue([{ id: "model-a", ...FREE }, { id: "model-b", ...FREE }]);
  try {
    box.writeModels({ providers: { adopted: block({ apiKey: "!printf inline-token" }) } });
    await box.harness.experimental_call("adopt", { id: "adopted" });

    // Somebody else — the key generator, an editor — rewrites the block.
    const file = box.readModels();
    file.providers!.adopted!.name = "Renamed By The Generator";
    file.providers!.adopted!.models = [{ id: "model-a" }];
    box.writeModels(file);

    const listed = await box.harness.experimental_call("listProviders", {});
    const row = listed.providers.find((candidate) => candidate.id === "adopted")!;
    assert.equal(row.drifted, true);
    assert.equal(row.warnings.some((warning) => /changed in models\.json/.test(warning)), true);

    const refused = await box.harness.experimental_call("refreshCustom", { ids: ["adopted"] });
    assert.equal(refused.results[0]!.ok, false);
    assert.equal(refused.results[0]!.drifted, true);
    assert.match(refused.results[0]!.error!, /would overwrite/);
    assert.equal(box.readModels().providers!.adopted!.name, "Renamed By The Generator");

    const accepted = await box.harness.experimental_call("refreshCustom", {
      ids: ["adopted"],
      acceptDrift: ["adopted"],
    });
    assert.equal(accepted.results[0]!.ok, true);
    assert.equal(box.readModels().providers!.adopted!.name, "Foreign Gateway");

    // The fingerprint moved with the write, so the next refresh is not drifted.
    const again = await box.harness.experimental_call("refreshCustom", { ids: ["adopted"] });
    assert.equal(again.results[0]!.ok, true);
    assert.equal(again.results[0]!.drifted, undefined);
  } finally {
    stub.restore();
    await box.dispose();
  }
});

test("editing a drifted provider is refused for the same reason", async () => {
  const box = sandbox();
  const stub = stubCatalogue([{ id: "model-a", ...FREE }, { id: "model-b", ...FREE }]);
  try {
    box.writeModels({ providers: { adopted: block({ apiKey: "!printf inline-token" }) } });
    await box.harness.experimental_call("adopt", { id: "adopted" });

    const file = box.readModels();
    file.providers!.adopted!.baseUrl = "https://moved.example/v1";
    box.writeModels(file);

    assert.match(
      await expectRejection(
        box.harness.experimental_call("updateCustom", { id: "adopted", name: "Mine" }),
      ),
      /would overwrite/,
    );
    assert.equal(box.readModels().providers!.adopted!.name, "Foreign Gateway");

    const updated = await box.harness.experimental_call("updateCustom", {
      id: "adopted",
      name: "Mine",
      acceptDrift: true,
    });
    assert.equal(updated.id, "adopted");
    assert.equal(box.readModels().providers!.adopted!.name, "Mine");
    // Accepting drift means our recorded values win: the outside edit is gone,
    // which is exactly what the gate existed to make explicit.
    assert.equal(box.readModels().providers!.adopted!.baseUrl, "https://gateway.example/v1");
  } finally {
    stub.restore();
    await box.dispose();
  }
});

test("one unreachable provider does not abort the refresh of the others", async () => {
  const box = sandbox();
  try {
    box.writeModels({
      providers: {
        good: block({ apiKey: "!printf tok", baseUrl: "https://good.example/v1" }),
        bad: block({ apiKey: "$PLUG6_UNSET_VARIABLE", baseUrl: "https://bad.example/v1" }),
      },
    });
    await box.harness.experimental_call("adopt", { id: "good" });
    await box.harness.experimental_call("adopt", { id: "bad" });

    const stub = stubCatalogue([{ id: "model-a", ...FREE }, { id: "model-b", ...FREE }]);
    try {
      const result = await box.harness.experimental_call("refreshCustom", {});
      const byId = new Map(result.results.map((entry) => [entry.id, entry]));
      assert.equal(byId.get("good")!.ok, true);
      assert.equal(byId.get("bad")!.ok, false);
      assert.match(byId.get("bad")!.error!, /PLUG6_UNSET_VARIABLE/);
      assert.notEqual(result.backupPath, undefined);
    } finally {
      stub.restore();
    }
  } finally {
    await box.dispose();
  }
});

test("an orphaned managed provider is reported and rewritten by a refresh", async () => {
  const box = sandbox();
  const stub = stubCatalogue([{ id: "model-a", ...FREE }, { id: "model-b", ...FREE }]);
  try {
    box.writeModels({ providers: { adopted: block({ apiKey: "!printf tok" }) } });
    await box.harness.experimental_call("adopt", { id: "adopted" });

    box.writeModels({ providers: {} });
    const row = (await box.harness.experimental_call("listProviders", {})).providers.find(
      (candidate) => candidate.id === "adopted",
    )!;
    assert.equal(row.ownership, "orphaned");
    assert.equal(row.inModelsJson, false);
    assert.match(row.error!, /absent from models\.json/);

    const refreshed = await box.harness.experimental_call("refreshCustom", { ids: ["adopted"] });
    assert.equal(refreshed.results[0]!.ok, true);
    assert.equal(box.readModels().providers!.adopted!.name, "Foreign Gateway");
  } finally {
    stub.restore();
    await box.dispose();
  }
});
