/**
 * The overlay's mount has to be undoable.
 *
 * Both audits reported a leaked subscriber here by reading, and it was real:
 * `app.tsx` mounted the overlay at module scope *and* registered a content
 * script that mounted it again. The overlay removes its predecessor's DOM by
 * id, so nothing looked wrong — but each mount subscribes to the player, and
 * only the disposer the host holds unsubscribes. One listener was left
 * rendering into a detached element for the life of the tab, and another on
 * every plugin reload.
 *
 *   node --experimental-strip-types --test tests/overlay-lifecycle.test.ts
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VIRTUAL_SONNER = "overlay-test:sonner";

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

/** The smallest document the overlay touches. */
function installDom(): { restore(): void; byId: Record<string, unknown> } {
  const scope = globalThis as Record<string, unknown>;
  const saved = { document: scope.document, window: scope.window };
  const byId: Record<string, unknown> = {};
  const element = (tag: string): Record<string, unknown> => ({
    tagName: tag,
    id: "",
    innerHTML: "",
    style: { cssText: "", setProperty() {}, display: "" },
    appendChild(child: unknown) {
      return child;
    },
    remove() {},
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  });
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
  return {
    byId,
    restore() {
      scope.document = saved.document;
      scope.window = saved.window;
    },
  };
}

const dom = installDom();
const { mountSpeakOverlay } = await import("../src/SpeakOverlay.js");
const { player } = await import("../src/player.js");

/** Count live subscriptions by wrapping the real subscribe. */
function countSubscribers(): { live: () => number; restore(): void } {
  const real = player.subscribe.bind(player);
  let live = 0;
  (player as { subscribe: typeof player.subscribe }).subscribe = (listener) => {
    live += 1;
    const off = real(listener);
    let done = false;
    return () => {
      if (!done) {
        done = true;
        live -= 1;
      }
      off();
    };
  };
  return { live: () => live, restore: () => { (player as { subscribe: typeof player.subscribe }).subscribe = real; } };
}

test("a mount is fully undone by its disposer", () => {
  const counter = countSubscribers();
  try {
    const before = counter.live();
    const dispose = mountSpeakOverlay();
    assert.equal(counter.live(), before + 1, "mounting subscribes");
    dispose();
    assert.equal(counter.live(), before, "and the disposer unsubscribes");
  } finally {
    counter.restore();
  }
});

test("two mounts need two disposers — one does not clean up the other", () => {
  // This is the shape of the bug: app.tsx mounted twice and kept one disposer.
  const counter = countSubscribers();
  try {
    const first = mountSpeakOverlay();
    const second = mountSpeakOverlay();
    assert.equal(counter.live(), 2, "each mount is its own subscription");
    second();
    assert.equal(counter.live(), 1, "disposing one leaves the other — hence the leak");
    first();
    assert.equal(counter.live(), 0);
  } finally {
    counter.restore();
  }
});

test("app.tsx mounts the overlay exactly once, inside a content script", () => {
  // The regression guard that matters: the module must have no mount at
  // import time, because a side effect there has nowhere to hang a disposer.
  const source = readSource();
  const mounts = [...source.matchAll(/mountSpeakOverlay\(\)/g)];
  assert.equal(mounts.length, 1, "exactly one call site");
  assert.match(
    source,
    /contentScripts\.register\([\s\S]*mountSpeakOverlay\(\)/,
    "and it is inside the content script's mount",
  );
  assert.doesNotMatch(
    source,
    /^if \(typeof document !== "undefined"\) \{/m,
    "no module-scope side-effect block",
  );
});

function readSource(): string {
  return readFileSync(fileURLToPath(new URL("../app.tsx", import.meta.url)), "utf8");
}

test.after(() => dom.restore());
