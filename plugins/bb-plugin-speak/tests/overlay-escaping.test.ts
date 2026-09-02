/**
 * Nothing carrying a value may reach the overlay's markup unescaped.
 *
 * The bar is built with innerHTML and one interpolated value is not a literal:
 * the saved voice name, which `prefsSchema` accepts as any non-empty string.
 *
 * This used to be checked by scanning the source for `${…}` shapes, twice —
 * and an audit defeated it twice, first by exempting on an identifier name and
 * then by aliasing `state.voice` into a local. Source shape cannot answer a
 * dataflow question. So the check is now behavioural: render with a hostile
 * voice name and look at what comes out. An alias, a helper, a refactor —
 * none of them can slip past a test that reads the output.
 *
 *   node --experimental-strip-types --test tests/overlay-escaping.test.ts
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VIRTUAL_SONNER = "escaping-test:sonner";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "sonner") return { url: VIRTUAL_SONNER, shortCircuit: true };
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: "module-typescript", shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === VIRTUAL_SONNER) {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export const toast = Object.assign(() => {}, " +
          "{ info() {}, error() {}, success() {}, warning() {} });",
      };
    }
    return nextLoad(url, context);
  },
});

import assert from "node:assert/strict";
import test from "node:test";

/** Records every innerHTML the overlay writes, into whichever element. */
const written: string[] = [];

function installDom(): () => void {
  const scope = globalThis as Record<string, unknown>;
  const saved = { document: scope.document, window: scope.window };
  const byId: Record<string, unknown> = {};
  const element = (tag: string): Record<string, unknown> => {
    const node: Record<string, unknown> = {
      tagName: tag,
      id: "",
      style: { cssText: "", setProperty() {}, display: "" },
      children: [] as unknown[],
      appendChild(child: unknown) {
        (node.children as unknown[]).push(child);
        return child;
      },
      remove() {},
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
    };
    let html = "";
    Object.defineProperty(node, "innerHTML", {
      get: () => html,
      set: (value: string) => {
        html = value;
        if (value.length > 0) written.push(value);
      },
    });
    return node;
  };
  scope.document = {
    createElement: element,
    body: element("body"),
    head: element("head"),
    getElementById: (id: string) => byId[id] ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  scope.window = scope;
  return () => {
    scope.document = saved.document;
    scope.window = saved.window;
  };
}

const restoreDom = installDom();
const { mountSpeakOverlay, esc } = await import("../src/SpeakOverlay.js");
const { player } = await import("../src/player.js");

/** Mount, capturing the render callback so a state can be forced through it. */
function captureRender(): { render: (s: unknown) => void; dispose: () => void } {
  const real = player.subscribe.bind(player);
  let captured: ((s: unknown) => void) | undefined;
  (player as { subscribe: typeof player.subscribe }).subscribe = ((listener: never) => {
    captured ??= listener as unknown as (s: unknown) => void;
    return real(listener);
  }) as typeof player.subscribe;
  const dispose = mountSpeakOverlay();
  (player as { subscribe: typeof player.subscribe }).subscribe = real;
  if (!captured) throw new Error("the overlay did not subscribe; the harness is wrong");
  return { render: captured, dispose };
}

const HOSTILE = `<img src=x onerror="alert(1)">`;

test("a hostile voice name cannot inject markup, at any stage", () => {
  for (const stage of ["generating", "playing", "paused"]) {
    written.length = 0;
    const { render, dispose } = captureRender();
    try {
      render({
        speaking: true,
        messageId: "m1",
        stage,
        chunkIndex: 1,
        chunkCount: 4,
        speed: 1.5,
        voice: HOSTILE,
      });
      const html = written.join("\n");
      assert.ok(html.length > 0, `nothing was rendered at stage ${stage}`);
      // The precise property: the value appears only in its escaped form.
      // `onerror=` on its own is not the test — inside escaped text it is
      // inert prose, and asserting on it would be asserting on the wrong
      // thing.
      assert.ok(
        !html.includes(HOSTILE),
        `the raw value reached the markup at stage ${stage}`,
      );
      assert.doesNotMatch(html, /<img/, `a live tag survived at stage ${stage}`);
      if (stage !== "generating") {
        assert.ok(
          html.includes(esc(HOSTILE)),
          `the voice name was not rendered at all at stage ${stage}`,
        );
      }
    } finally {
      dispose();
    }
  }
});

test("an ordinary voice name is shown as written", () => {
  written.length = 0;
  const { render, dispose } = captureRender();
  try {
    render({
      speaking: true,
      messageId: "m1",
      stage: "playing",
      chunkIndex: 0,
      chunkCount: 1,
      speed: 1,
      voice: "Kore",
    });
    assert.match(written.join("\n"), /Kore/, "escaping must not mangle a normal name");
  } finally {
    dispose();
  }
});

test("the escaper itself", () => {
  assert.equal(esc(HOSTILE), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(esc("Kore"), "Kore");
  assert.equal(esc(1.5), "1.5");
  assert.equal(esc("a & b"), "a &amp; b");
});

test.after(() => restoreDom());
