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

test("nothing carrying a value reaches the bar's markup unescaped", () => {
  // Read from the source rather than rendered, because rendering needs a DOM.
  // The property that matters: no expression referring to state may reach
  // innerHTML without going through esc() or Number(). An earlier version of
  // this test exempted anything starting with `isPaused`, which exempted by
  // name rather than by proof — a branch could have grown an interpolation
  // and slipped through.
  const interpolations = [...source.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
  const carriesValue = interpolations.filter((expression) => {
    if (!/\bstate\.|\bvoice\b|\bspeed\b/.test(expression)) return false;
    if (expression.startsWith("esc(")) return false;
    if (expression.startsWith("Number(")) return false;
    return true;
  });
  assert.deepEqual(
    carriesValue,
    [],
    `these reach innerHTML unescaped: ${carriesValue.join(" | ")}`,
  );
  assert.ok(interpolations.length > 4, "and the scan actually found the markup");
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
