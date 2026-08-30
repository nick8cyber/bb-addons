import assert from "node:assert/strict";
import test from "node:test";

import {
  displayKeyRef,
  keyRefWarnings,
  parseKeyRef,
  parseTemplate,
  resolveKeyRefValue,
} from "../src/keyref.ts";

/**
 * Port fidelity is the whole point of this module: pi decides what a key
 * reference means, and a classification that differs from pi's by one case is
 * either a leaked secret or a provider that silently stops working.
 */
test("parseKeyRef mirrors pi's reference grammar", () => {
  assert.deepEqual(parseKeyRef("!pi-key-openrouter --print"), {
    kind: "command",
    command: "pi-key-openrouter --print",
  });
  assert.deepEqual(parseKeyRef("$OPENROUTER_API_KEY"), { kind: "env", name: "OPENROUTER_API_KEY" });
  assert.deepEqual(parseKeyRef("${OPENROUTER_API_KEY}"), { kind: "env", name: "OPENROUTER_API_KEY" });

  // A trailing literal makes the whole value a literal: treating this as an env
  // reference would drop the suffix and produce a wrong token.
  assert.deepEqual(parseKeyRef("$TOKEN-suffix"), { kind: "literal", hasEnvParts: true });
  assert.deepEqual(parseKeyRef("Bearer $TOK"), { kind: "literal", hasEnvParts: true });
  assert.deepEqual(parseKeyRef("sk-live-abcdefghijklmnop"), { kind: "literal", hasEnvParts: false });
  assert.deepEqual(parseKeyRef("$$literal"), { kind: "literal", hasEnvParts: false });
  assert.deepEqual(parseKeyRef("$!x"), { kind: "literal", hasEnvParts: false });
  // `$1` is not an env reference in pi's grammar (names cannot start with a digit).
  assert.deepEqual(parseKeyRef("$1BAD"), { kind: "literal", hasEnvParts: false });
  assert.deepEqual(parseKeyRef("${not-a-name}"), { kind: "literal", hasEnvParts: false });
  assert.deepEqual(parseKeyRef("${unterminated"), { kind: "literal", hasEnvParts: false });

  assert.deepEqual(parseKeyRef("$AAA${BBB}"), { kind: "env-template", names: ["AAA", "BBB"] });

  assert.deepEqual(parseKeyRef(""), { kind: "none" });
  assert.deepEqual(parseKeyRef(undefined), { kind: "none" });
  assert.deepEqual(parseKeyRef(null), { kind: "none" });
});

test("parseTemplate splits literals and env parts the way pi does", () => {
  assert.deepEqual(parseTemplate("Bearer $TOK!"), [
    { type: "literal", value: "Bearer " },
    { type: "env", name: "TOK" },
    { type: "literal", value: "!" },
  ]);
  assert.deepEqual(parseTemplate("$$a$!b"), [{ type: "literal", value: "$a!b" }]);
});

test("displayKeyRef never echoes a literal credential", () => {
  const literals = [
    "sk-live-abcdefghijklmnop",
    "$TOKEN-suffix",
    "Bearer $TOK",
    "$$literal",
    "$1BAD",
  ];
  for (const raw of literals) {
    const shown = displayKeyRef(raw);
    assert.equal(shown.includes(raw), false, `${raw} was echoed as ${shown}`);
    assert.match(shown, /^«literal/);
    assert.match(shown, new RegExp(`${raw.length} chars`));
  }

  // Configuration, not secrets: these must render verbatim so a broken
  // provider can actually be diagnosed.
  assert.equal(displayKeyRef("!pi-key-kilo"), "!pi-key-kilo");
  assert.equal(displayKeyRef("$OPENROUTER_API_KEY"), "$OPENROUTER_API_KEY");
  assert.equal(displayKeyRef("$AAA${BBB}"), "$AAA${BBB}");
  assert.equal(displayKeyRef(undefined), "«no key»");
});

test("echoed key commands are linted, plain ones are not", () => {
  assert.equal(keyRefWarnings("!echo sk-live-abcdefghijklmnopqrst").length, 1);
  assert.equal(keyRefWarnings("!printf sk-live-abcdefghijklmnopqrst").length, 1);
  assert.equal(keyRefWarnings("!echo hi").length, 0);
  assert.equal(keyRefWarnings("!pi-key-openrouter").length, 0);
  assert.equal(keyRefWarnings("$OPENROUTER_API_KEY").length, 0);
});

test("resolveKeyRefValue interpolates templates and runs commands like pi", () => {
  const env = { PART_ONE: "sk-", PART_TWO: "value" };
  assert.deepEqual(resolveKeyRefValue("$PART_ONE$PART_TWO", { env }), { ok: true, token: "sk-value" });
  assert.deepEqual(resolveKeyRefValue("literal-token", { env }), { ok: true, token: "literal-token" });
  assert.equal(resolveKeyRefValue("$MISSING_VAR_FOR_TEST", { env }).ok, false);
  assert.deepEqual(resolveKeyRefValue("!printf token-from-command"), {
    ok: true,
    token: "token-from-command",
  });
  assert.equal(resolveKeyRefValue("", { env }).ok, false);
});
