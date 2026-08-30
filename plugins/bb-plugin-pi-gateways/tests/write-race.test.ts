import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, pruneBackups, updateModelsJson } from "../src/fsutil.ts";

const PREFIX = "bak-pi-gateways";

function fixture(content: unknown): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-gateways-race-"));
  const path = join(dir, "models.json");
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
  return { path, dir };
}

function backups(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(PREFIX)).sort();
}

test("canonicalJson ignores key order at every depth", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [{ f: 1, e: 2 }], c: 3 } }),
    canonicalJson({ a: { c: 3, d: [{ e: 2, f: 1 }] }, b: 1 }),
  );
});

test("the backup holds the exact pre-image bytes, not a re-read", async () => {
  const { path, dir } = fixture({ providers: { keep: { name: "keep" } } });
  const preImage = readFileSync(path, "utf8");

  const result = await updateModelsJson({
    path,
    backupPrefix: PREFIX,
    retain: 10,
    mutate: (file) => ({
      next: { ...(file ?? {}), providers: { ...(file?.providers ?? {}), added: { name: "added" } } },
      changed: true,
    }),
  });

  assert.equal(result.wrote, true);
  assert.equal(readFileSync(result.backupPath!, "utf8"), preImage);
  assert.equal(backups(dir).length, 1);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).providers).sort(), [
    "added",
    "keep",
  ]);
});

test("a concurrent external write makes the mutator re-run against fresh content", async () => {
  const { path } = fixture({ providers: { original: {} } });
  const seen: string[][] = [];
  let injected = false;

  const result = await updateModelsJson({
    path,
    backupPrefix: PREFIX,
    retain: 10,
    mutate: (file) => {
      seen.push(Object.keys(file?.providers ?? {}).sort());
      return {
        next: { ...(file ?? {}), providers: { ...(file?.providers ?? {}), ours: { name: "ours" } } },
        changed: true,
      };
    },
    hooks: {
      afterBackup: () => {
        if (injected) return;
        injected = true;
        // Somebody else's generator lands between our read and our write.
        writeFileSync(path, `${JSON.stringify({ providers: { original: {}, theirs: {} } }, null, 2)}\n`);
      },
    },
  });

  assert.equal(result.wrote, true);
  assert.deepEqual(seen, [["original"], ["original", "theirs"]]);
  // Nothing the other writer added was lost.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).providers).sort(), [
    "original",
    "ours",
    "theirs",
  ]);
});

test("an endlessly rewritten file is reported rather than clobbered", async () => {
  const { path } = fixture({ providers: {} });
  let counter = 0;
  await assert.rejects(
    () =>
      updateModelsJson({
        path,
        backupPrefix: PREFIX,
        retain: 10,
        attempts: 3,
        mutate: (file) => ({ next: { ...(file ?? {}), ours: true }, changed: true }),
        hooks: {
          afterBackup: () => {
            counter += 1;
            writeFileSync(path, `${JSON.stringify({ providers: {}, counter }, null, 2)}\n`);
          },
        },
      }),
    /being rewritten concurrently/,
  );
  assert.equal(counter, 3);
});

test("an unchanged mutation writes nothing at all", async () => {
  const { path, dir } = fixture({ providers: { a: {} } });
  const before = readFileSync(path, "utf8");
  const result = await updateModelsJson({
    path,
    backupPrefix: PREFIX,
    retain: 10,
    mutate: (file) => ({ next: file ?? {}, changed: false }),
  });
  assert.deepEqual(result, { wrote: false });
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(backups(dir).length, 0);
});

test("retention prunes only our own backups and keeps other tools' .bak files", () => {
  const { path, dir } = fixture({ providers: {} });
  const foreign = ["models.json.bak", "models.json.bak-2026", "models.json.bak-other-tool-1"];
  for (const name of foreign) writeFileSync(join(dir, name), "foreign");
  for (const stamp of ["20260101-000000001", "20260101-000000002", "20260101-000000003"]) {
    writeFileSync(join(dir, `models.json.${PREFIX}-${stamp}`), stamp);
  }

  const deleted = pruneBackups(path, PREFIX, 2);
  assert.deepEqual(deleted, [`models.json.${PREFIX}-20260101-000000001`]);
  for (const name of foreign) {
    assert.equal(readFileSync(join(dir, name), "utf8"), "foreign");
  }
  assert.equal(backups(dir).length, 2);
});
