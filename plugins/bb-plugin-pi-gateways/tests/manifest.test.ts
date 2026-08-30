import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadManifest, manifestPath, saveManifest, isCustomDef } from "../src/custom.ts";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-gateways-manifest-"));
}

const V1_ENTRY = {
  id: "tokenrouter",
  name: "TokenRouter",
  baseUrl: "https://api.tokenrouter.com/v1",
  api: "openai-completions",
  keySource: { type: "env", name: "TOKENROUTER_API_KEY" },
  keyRef: "$TOKENROUTER_API_KEY",
  freeOnly: true,
  selectionMode: "all-free" as const,
};

test("a v1 manifest loads, gains created origins, and is rewritten as v2", () => {
  const dir = dataDir();
  writeFileSync(
    manifestPath(dir),
    JSON.stringify({ version: 1, owned: { tokenrouter: V1_ENTRY } }, null, 2),
  );

  const manifest = loadManifest(dir);
  assert.equal(manifest.version, 2);
  const entry = manifest.owned.tokenrouter;
  assert.equal(isCustomDef(entry), true);
  assert.equal(isCustomDef(entry) ? entry.origin : undefined, "created");
  assert.equal(isCustomDef(entry) ? entry.fingerprint : "set", undefined);

  // Built-ins are recorded in both versions so no foreign writer can take them over.
  assert.deepEqual(manifest.owned["opencode-zen"], { builtin: true });
  assert.deepEqual(manifest.owned.kilo, { builtin: true });

  saveManifest(dir, manifest);
  const written = JSON.parse(readFileSync(manifestPath(dir), "utf8"));
  assert.equal(written.version, 2);
  assert.equal(written.owned.tokenrouter.origin, "created");
  assert.equal(written.owned.tokenrouter.keyRef, "$TOKENROUTER_API_KEY");
});

test("a v2 manifest round-trips with adoption metadata intact", () => {
  const dir = dataDir();
  const manifest = loadManifest(dir);
  manifest.owned.adopted = {
    ...V1_ENTRY,
    id: "adopted",
    api: "some-future-protocol",
    keySource: { type: "inline" },
    keyRef: undefined,
    origin: "adopted",
    fingerprint: "abc123",
    adoptedAt: "2026-08-26T00:00:00.000Z",
  };
  saveManifest(dir, manifest);

  const reloaded = loadManifest(dir);
  const entry = reloaded.owned.adopted;
  assert.equal(isCustomDef(entry) && entry.origin, "adopted");
  assert.equal(isCustomDef(entry) && entry.keySource.type, "inline");
  assert.equal(isCustomDef(entry) && entry.fingerprint, "abc123");
  assert.equal(isCustomDef(entry) && entry.adoptedAt, "2026-08-26T00:00:00.000Z");
  assert.equal(isCustomDef(entry) && entry.api, "some-future-protocol");
});

test("a corrupt manifest is kept aside and reseeded rather than bricking the plugin", () => {
  const dir = dataDir();
  writeFileSync(manifestPath(dir), "{not json");
  const manifest = loadManifest(dir);
  assert.equal(Object.keys(manifest.owned).length, 2); // the two builtins
  assert.equal(
    readdirSync(dir).some((name) => name.includes(".corrupt-")),
    true,
  );
  assert.equal(existsSync(manifestPath(dir)), false);
});

test("an unknown manifest version is a hard error, never a silent reseed", () => {
  const dir = dataDir();
  writeFileSync(manifestPath(dir), JSON.stringify({ version: 99, owned: {} }));
  assert.throws(() => loadManifest(dir), /unsupported format/);
});
