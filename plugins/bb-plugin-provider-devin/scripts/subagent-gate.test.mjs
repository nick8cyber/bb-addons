// node --test scripts/subagent-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSubagentsEnabled,
  applyDisabled,
  applyRestore,
} from "../src/subagent-gate.mjs";

test("parse: absent / true / false", () => {
  assert.equal(parseSubagentsEnabled("{}"), null);
  assert.equal(parseSubagentsEnabled('{"subagents_enabled": true}'), true);
  assert.equal(parseSubagentsEnabled('{ "subagents_enabled":false }'), false);
});

test("disable on absent key inserts after the opening brace", () => {
  const out = applyDisabled('{\n  "permissions": {}\n}\n');
  assert.equal(parseSubagentsEnabled(out), false);
  assert.ok(out.includes('"permissions"'), "other keys preserved");
});

test("disable flips true in place (comments survive)", () => {
  const src = '{\n  // user note\n  "subagents_enabled": true,\n  "x": 1\n}\n';
  const out = applyDisabled(src);
  assert.equal(parseSubagentsEnabled(out), false);
  assert.ok(out.includes("// user note"), "JSONC comment preserved");
  assert.ok(out.includes('"x": 1'), "other keys preserved");
});

test("disable is a no-op when already false", () => {
  const src = '{"subagents_enabled": false}';
  assert.equal(applyDisabled(src), src);
});

test("disable on empty file produces a valid minimal config", () => {
  const out = applyDisabled("");
  assert.equal(parseSubagentsEnabled(out), false);
  JSON.parse(out);
});

test("restore with prior=true flips back to true", () => {
  const out = applyRestore('{"subagents_enabled": false, "x": 1}', true);
  assert.equal(parseSubagentsEnabled(out), true);
  assert.ok(out.includes('"x": 1'));
});

test("restore with prior=null removes the inserted key", () => {
  const stamped = applyDisabled('{\n  "permissions": {}\n}\n');
  const back = applyRestore(stamped, null);
  assert.equal(parseSubagentsEnabled(back), null);
  assert.ok(back.includes('"permissions"'));
});

test("roundtrip: insert then restore leaves the other content intact", () => {
  const src = '{\n  "a": 1,\n  "b": {"c": 2}\n}\n';
  const back = applyRestore(applyDisabled(src), null);
  assert.equal(parseSubagentsEnabled(back), null);
  assert.ok(back.includes('"b": {"c": 2}'));
});
