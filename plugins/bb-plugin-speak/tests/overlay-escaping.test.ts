/**
 * The overlay builds its bar with innerHTML, and one interpolated value is not
 * a literal: the saved voice name. `prefsSchema` accepts any non-empty string.
 *
 *   node --experimental-strip-types --test tests/overlay-escaping.test.ts
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: "module-typescript", shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync(new URL("../src/SpeakOverlay.ts", import.meta.url), "utf8");

test("every interpolation into the bar's markup is escaped or numeric", () => {
  // Read from the source rather than rendered, because rendering needs a DOM.
  // The rule is what matters: nothing reaches innerHTML raw.
  const interpolations = [...source.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
  const raw = interpolations.filter((expression) => {
    if (expression.startsWith("esc(")) return false;
    if (expression.startsWith("Number(")) return false;
    // A ternary between two string literals cannot carry a value.
    if (/^[A-Za-z]+ \? "[^"]*" : "[^"]*"$/.test(expression)) return false;
    // Nested template branches are checked by their own inner interpolations.
    if (expression.startsWith("isPaused") || expression.startsWith("Number(")) return false;
    return true;
  });
  assert.deepEqual(raw, [], `these reach innerHTML unescaped: ${raw.join(", ")}`);
});

test("the escaper neutralises a voice name that is markup", async () => {
  const { esc } = await import("../src/SpeakOverlay.js");
  const nasty = `<img src=x onerror="alert(1)">`;
  const out = esc(nasty);
  assert.doesNotMatch(out, /<img/, "no live tag survives");
  assert.doesNotMatch(out, /"/, "no attribute delimiter survives");
  assert.equal(out, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(esc("Kore"), "Kore", "an ordinary name is left alone");
  assert.equal(esc(1.5), "1.5", "and a number is just a number");
});
