import assert from "node:assert/strict";
import test from "node:test";

import { assertNoSecret, block, expectRejection, plant, sandbox, stubCatalogue } from "./helpers.ts";

const SECRET = plant("sk-live-PLANTED-0123456789abcdef");
const HEADER_SECRET = plant("header-secret-value");

test("adopting a command-keyed block is lossless and writes nothing", async () => {
  const box = sandbox();
  try {
    box.writeModels({ providers: { "gen-openrouter": block({ apiKey: "!pi-key-openrouter" }) } });
    const before = box.readModelsRaw();

    const result = await box.harness.experimental_call("adopt", { id: "gen-openrouter" });

    assert.equal(result.ownership, "adopted");
    assert.equal(result.keyRefKind, "command");
    assert.equal(result.inPlaceKey, false);
    assert.equal(result.modelCount, 2);
    assert.equal(result.backupPath, undefined);
    // Ordinary adoption is a manifest-only act: the file is untouched, byte for byte.
    assert.equal(box.readModelsRaw(), before);

    const detail = await box.harness.experimental_call("providerDetail", { id: "gen-openrouter" });
    assert.equal(detail.row.ownership, "adopted");
    assert.equal(detail.row.drifted, false);
    assert.equal(detail.manifest?.origin, "adopted");
    assert.equal(detail.manifest?.keySource.type, "command");
    // Adoption never grants auto-free selection.
    assert.equal(detail.row.selectionMode, "explicit");
    assert.equal(detail.row.requiresExplicitModels, true);
  } finally {
    await box.dispose();
  }
});

test("adopting an env-keyed block records the variable, not the value", async () => {
  const box = sandbox();
  process.env.PLUG6_ADOPT_ENV = SECRET;
  try {
    box.writeModels({ providers: { "gen-env": block({ apiKey: "$PLUG6_ADOPT_ENV" }) } });
    const before = box.readModelsRaw();

    const result = await box.harness.experimental_call("adopt", { id: "gen-env" });
    assert.equal(result.keyRefKind, "env");
    assert.equal(result.inPlaceKey, false);
    assert.equal(box.readModelsRaw(), before);

    assertNoSecret(result, SECRET, "the adopt response");
    assertNoSecret(box.readManifestRaw(), SECRET, "the manifest");
    assert.match(box.readManifestRaw(), /PLUG6_ADOPT_ENV/);
  } finally {
    delete process.env.PLUG6_ADOPT_ENV;
    await box.dispose();
  }
});

test("a literal key is adopted in place and never copied anywhere", async () => {
  const box = sandbox();
  try {
    box.writeModels({
      providers: {
        "gen-literal": block({ apiKey: SECRET, headers: { "x-extra": HEADER_SECRET } }),
      },
    });
    const before = box.readModelsRaw();

    const result = await box.harness.experimental_call("adopt", { id: "gen-literal" });
    assert.equal(result.keyRefKind, "literal");
    assert.equal(result.inPlaceKey, true);
    assert.equal(box.readModelsRaw(), before);

    assertNoSecret(result, SECRET, "the adopt response");
    assertNoSecret(box.readManifestRaw(), SECRET, "the manifest");
    assertNoSecret(box.readManifestRaw(), HEADER_SECRET, "the manifest");

    const list = await box.harness.experimental_call("listProviders", {});
    const row = list.providers.find((candidate) => candidate.id === "gen-literal")!;
    assert.equal(row.keyRefKind, "literal");
    assert.equal(row.hasHeaders, true);
    assertNoSecret(list, SECRET, "listProviders");
    assertNoSecret(list, HEADER_SECRET, "listProviders");

    const detail = await box.harness.experimental_call("providerDetail", { id: "gen-literal" });
    assert.deepEqual(detail.headerNames, ["x-extra"]);
    assert.equal(detail.manifest?.keySource.type, "inline");
    assertNoSecret(detail, HEADER_SECRET, "providerDetail");
  } finally {
    await box.dispose();
  }
});

test("migrate-on-adopt rewrites only the apiKey and keeps everything else verbatim", async () => {
  const box = sandbox();
  process.env.PLUG6_MIGRATE_KEY = SECRET;
  try {
    box.writeModels({
      providers: {
        "gen-migrate": block({
          apiKey: SECRET,
          headers: { "x-extra": HEADER_SECRET },
          unknownFuturePiField: { keep: true },
          models: [{ id: "model-a", customCost: 7 }],
        }),
        untouched: block({ apiKey: "!pi-key-other" }),
      },
    });

    const result = await box.harness.experimental_call("adopt", {
      id: "gen-migrate",
      keyMigration: { type: "env", name: "PLUG6_MIGRATE_KEY" },
    });
    assert.equal(result.inPlaceKey, false);
    assert.notEqual(result.backupPath, undefined);

    const after = box.readModels().providers!["gen-migrate"]!;
    assert.equal(after.apiKey, "$PLUG6_MIGRATE_KEY");
    assert.deepEqual(after.headers, { "x-extra": HEADER_SECRET });
    assert.deepEqual(after.unknownFuturePiField, { keep: true });
    assert.deepEqual(after.models, [{ id: "model-a", customCost: 7 }]);
    assert.deepEqual(box.readModels().providers!.untouched, block({ apiKey: "!pi-key-other" }));

    assertNoSecret(result, SECRET, "the adopt response");
    assertNoSecret(box.readManifestRaw(), SECRET, "the manifest");
    assertNoSecret(box.readModelsRaw(), SECRET, "models.json after the migration");
  } finally {
    delete process.env.PLUG6_MIGRATE_KEY;
    await box.dispose();
  }
});

test("a key source that resolves to another token needs an explicit confirmation", async () => {
  const box = sandbox();
  process.env.PLUG6_ROTATED_KEY = "sk-live-DIFFERENT-token-value";
  try {
    box.writeModels({ providers: { "gen-rotated": block({ apiKey: SECRET }) } });
    const before = box.readModelsRaw();

    const message = await expectRejection(
      box.harness.experimental_call("adopt", {
        id: "gen-rotated",
        keyMigration: { type: "env", name: "PLUG6_ROTATED_KEY" },
      }),
      SECRET,
    );
    assert.match(message, /different token/);
    assert.equal(box.readModelsRaw(), before);
    assert.equal(box.readManifestRaw().includes("gen-rotated"), false);

    const confirmed = await box.harness.experimental_call("adopt", {
      id: "gen-rotated",
      keyMigration: { type: "env", name: "PLUG6_ROTATED_KEY" },
      confirmMismatch: true,
    });
    assert.equal(confirmed.warnings.some((warning) => /different token/.test(warning)), true);
    assert.equal(box.readModels().providers!["gen-rotated"]!.apiKey, "$PLUG6_ROTATED_KEY");
  } finally {
    delete process.env.PLUG6_ROTATED_KEY;
    await box.dispose();
  }
});

test("adoption refuses built-ins, reserved ids, already-managed ids and absent ids", async () => {
  const box = sandbox({ reserved: ["openai", "radius-catalogue"] });
  try {
    box.writeModels({
      providers: {
        "opencode-zen": block(),
        openai: block(),
        "gen-ok": block({ apiKey: "!pi-key-ok" }),
      },
    });

    assert.match(
      await expectRejection(box.harness.experimental_call("adopt", { id: "opencode-zen" })),
      /built-in/,
    );
    assert.match(
      await expectRejection(box.harness.experimental_call("adopt", { id: "openai" })),
      /pi ships its own catalogue/,
    );
    assert.match(
      await expectRejection(box.harness.experimental_call("adopt", { id: "nowhere" })),
      /not a provider in/,
    );

    await box.harness.experimental_call("adopt", { id: "gen-ok" });
    assert.match(
      await expectRejection(box.harness.experimental_call("adopt", { id: "gen-ok" })),
      /already managed/,
    );
  } finally {
    await box.dispose();
  }
});

test("a block with an unknown protocol is adopted as limited and refuses refresh per id", async () => {
  const box = sandbox();
  try {
    box.writeModels({
      providers: { weird: block({ api: "some-future-protocol", apiKey: "!pi-key-weird" }) },
    });

    const result = await box.harness.experimental_call("adopt", { id: "weird" });
    assert.equal(result.apiSupported, false);
    assert.equal(result.warnings.some((warning) => /some-future-protocol/.test(warning)), true);

    const refreshed = await box.harness.experimental_call("refreshCustom", { ids: ["weird"] });
    assert.deepEqual(refreshed.results.map((entry) => entry.ok), [false]);
    assert.match(refreshed.results[0]!.error!, /unsupported wire protocol/);
    // A refused refresh must not have written anything.
    assert.equal(refreshed.backupPath, undefined);

    const row = (await box.harness.experimental_call("listProviders", {})).providers.find(
      (candidate) => candidate.id === "weird",
    )!;
    assert.equal(row.apiSupported, false);
    assert.equal(row.ownership, "adopted");
  } finally {
    await box.dispose();
  }
});

test("disown is the exact inverse of adoption and leaves models.json alone", async () => {
  const box = sandbox();
  try {
    box.writeModels({ providers: { "gen-disown": block({ apiKey: "!pi-key-x" }) } });
    await box.harness.experimental_call("adopt", { id: "gen-disown" });
    const before = box.readModelsRaw();

    const result = await box.harness.experimental_call("disown", { id: "gen-disown" });
    assert.deepEqual(result, { id: "gen-disown", forgotten: true });
    assert.equal(box.readModelsRaw(), before);

    const row = (await box.harness.experimental_call("listProviders", {})).providers.find(
      (candidate) => candidate.id === "gen-disown",
    )!;
    assert.equal(row.ownership, "foreign");
  } finally {
    await box.dispose();
  }
});

test("a foreign block cannot be deleted without force, and force deletes only it", async () => {
  const box = sandbox();
  const stub = stubCatalogue([]);
  try {
    box.writeModels({
      providers: { foreign: block({ apiKey: "!pi-key-f" }), other: block({ apiKey: "!pi-key-o" }) },
    });

    assert.match(
      await expectRejection(box.harness.experimental_call("deleteProvider", { id: "foreign" })),
      /pass force/,
    );
    assert.equal(Object.keys(box.readModels().providers!).length, 2);

    const result = await box.harness.experimental_call("deleteProvider", {
      id: "foreign",
      force: true,
    });
    assert.deepEqual(result.removed, ["foreign"]);
    assert.deepEqual(Object.keys(box.readModels().providers!), ["other"]);
  } finally {
    stub.restore();
    await box.dispose();
  }
});
