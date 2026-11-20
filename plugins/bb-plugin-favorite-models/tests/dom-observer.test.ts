// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Dom = typeof import("../src/dom-observer.js");
type Manager = typeof import("../src/favorites-manager.js");

let rowSeq = 0;

function optionRow(title: string, opts: { disabled?: boolean } = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.setAttribute("role", "option");
  b.id = `row-opt-${rowSeq++}`;
  if (opts.disabled) b.setAttribute("aria-disabled", "true");
  const s = document.createElement("span");
  s.className = "truncate";
  s.title = title;
  s.textContent = title.split(" · ")[0];
  b.appendChild(s);
  return b;
}

function popover(opts: {
  tabs?: { title: string; active?: boolean }[];
  rows?: HTMLElement[];
  search?: boolean;
}): { pop: HTMLElement; list: HTMLElement } {
  const pop = document.createElement("div");
  pop.setAttribute("data-radix-popover-content", "");
  if (opts.search) {
    const input = document.createElement("input");
    input.setAttribute("placeholder", "Search models");
    pop.appendChild(input);
  }
  if (opts.tabs?.length) {
    const strip = document.createElement("div");
    strip.className = "border-b flex items-center";
    for (const t of opts.tabs) {
      const b = document.createElement("button");
      b.title = t.title;
      if (t.active) b.className = "border-foreground";
      strip.appendChild(b);
    }
    pop.appendChild(strip);
  }
  const list = document.createElement("div");
  list.setAttribute("role", "listbox");
  for (const r of opts.rows ?? []) list.appendChild(r);
  pop.appendChild(list);
  return { pop, list };
}

function composer(role = "primary", triggerTitle = "Codex: gpt-5.4") {
  const root = document.createElement("div");
  root.setAttribute("data-app-composer-role", role);
  const anchor = document.createElement("span");
  const trigger = document.createElement("button");
  trigger.setAttribute("aria-label", "Provider, model and reasoning (⇧-⌘-m)");
  trigger.title = triggerTitle;
  root.append(anchor, trigger);
  document.body.append(root);
  return { root, anchor, trigger };
}

/** Wire the trigger like Radix does: click opens a popover via aria-controls. */
function openOnClick(trigger: HTMLButtonElement, pop: HTMLElement, id = "pop-a"): void {
  trigger.addEventListener("click", () => {
    pop.id = id;
    trigger.setAttribute("aria-controls", id);
    trigger.setAttribute("aria-expanded", "true");
    document.body.append(pop);
  });
}

async function freshModules(): Promise<{ dom: Dom; mgr: Manager }> {
  vi.resetModules();
  const dom = await import("../src/dom-observer.js");
  const mgr = await import("../src/favorites-manager.js");
  return { dom, mgr };
}

function stubRpc(handler: (method: string, body: unknown) => unknown) {
  let version = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const method = url.split("/").pop()!;
      const result = handler(method, init?.body ? JSON.parse(init.body) : null);
      return { json: async () => ({ ok: true, result: result ?? { version: ++version } }) };
    })
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  rowSeq = 0;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("composer scoping (B1)", () => {
  it("drives only its own composer's popover, not a foreign open one", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const B = composer("secondary");

    // B already has an open popover containing a matching row.
    const { pop: popB } = popover({ rows: [optionRow("target-model")] });
    popB.id = "pop-b";
    B.trigger.setAttribute("aria-controls", "pop-b");
    document.body.append(popB);
    const bClicked = vi.fn();
    popB.querySelector("button[role=option]")!.addEventListener("click", bClicked);

    // A opens its own popover — without the requested model.
    const { pop: popA } = popover({ rows: [optionRow("other-model")] });
    openOnClick(A.trigger, popA, "pop-a");

    const p = dom.switchComposerModel("target-model", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("model-not-found");
    expect(bClicked).not.toHaveBeenCalled();
    // A's trigger got its OWN popover — the foreign one was never adopted.
    expect(A.trigger.getAttribute("aria-controls")).toBe("pop-a");
  });

  it("reports no-trigger instead of hijacking another composer", async () => {
    const { dom } = await freshModules();
    const rootA = document.createElement("div");
    rootA.setAttribute("data-app-composer-role", "primary");
    const anchor = document.createElement("span");
    rootA.append(anchor);
    document.body.append(rootA);

    const B = composer("secondary");
    const { pop: popB } = popover({ rows: [optionRow("target-model")] });
    popB.id = "pop-b";
    B.trigger.setAttribute("aria-controls", "pop-b");
    document.body.append(popB);
    const bClicked = vi.fn();
    popB.querySelector("button[role=option]")!.addEventListener("click", bClicked);

    const res = await dom.switchComposerModel("target-model", undefined, anchor);
    expect(res).toEqual({ ok: false, reason: "no-trigger" });
    expect(bClicked).not.toHaveBeenCalled();
  });

  it("openNativeModelPicker opens only the anchored composer's picker", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const B = composer("secondary");
    const { pop: popA } = popover({ rows: [] });
    const { pop: popB } = popover({ rows: [] });
    openOnClick(A.trigger, popA, "pop-a");
    openOnClick(B.trigger, popB, "pop-b");

    dom.openNativeModelPicker(B.anchor);
    expect(B.trigger.getAttribute("aria-controls")).toBe("pop-b");
    expect(A.trigger.getAttribute("aria-controls")).toBeNull();
    expect(document.getElementById("pop-b")).toBeTruthy();
    expect(document.getElementById("pop-a")).toBeNull();
  });
});

describe("full model key incl. route (B2)", () => {
  it("clicks the row with the matching route, not the first same-name row", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const r1 = optionRow("M · RouteA");
    const r2 = optionRow("M · RouteB");
    const { pop } = popover({ rows: [r1, r2] });
    const c1 = vi.fn();
    const c2 = vi.fn(() => pop.remove());
    r1.addEventListener("click", c1);
    r2.addEventListener("click", c2);
    openOnClick(A.trigger, pop);

    const p = dom.switchComposerModel("M · RouteB", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(500);
    const res = await p;

    expect(res.ok).toBe(true);
    expect(c2).toHaveBeenCalled();
    expect(c1).not.toHaveBeenCalled();
  });
});

describe("cancellable polling (B3)", () => {
  it("a newer switch cancels the previous one's polls", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const p1 = dom.switchComposerModel("x", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(50);
    const p2 = dom.switchComposerModel("y", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(1500);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ ok: false, reason: "cancelled" });
    expect(r2).toEqual({ ok: false, reason: "no-popover" });
  });

  it("a cancelled poll cannot click into a menu that appears later", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const p = dom.switchComposerModel("target", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(50);
    dom.cancelPendingSwitch();

    // A matching menu shows up only AFTER the cancellation.
    const { pop } = popover({ rows: [optionRow("target")] });
    pop.id = "pop-a";
    A.trigger.setAttribute("aria-controls", "pop-a");
    document.body.append(pop);
    const clicked = vi.fn();
    pop.querySelector("button[role=option]")!.addEventListener("click", clicked);

    await vi.advanceTimersByTimeAsync(1500);
    const res = await p;
    expect(res.reason).toBe("cancelled");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("waits for the new provider tab before matching rows", async () => {
    const { dom } = await freshModules();
    const A = composer();
    // The OLD provider's list already shows a same-named row; a premature
    // match would click it — the exact B3 reproduction.
    const oldRow = optionRow("target-model");
    const oldClicked = vi.fn();
    oldRow.addEventListener("click", oldClicked);
    const { pop, list } = popover({
      tabs: [
        { title: "Codex", active: true },
        { title: "Antigravity" },
      ],
      rows: [oldRow],
    });
    const newRow = optionRow("target-model");
    const newClicked = vi.fn(() => pop.remove());
    newRow.addEventListener("click", newClicked);

    const tabs = pop.querySelectorAll<HTMLButtonElement>("div.border-b button[title]");
    tabs[1].addEventListener("click", () => {
      setTimeout(() => {
        tabs[0].className = "";
        tabs[1].className = "border-foreground";
        oldRow.remove();
        list.appendChild(newRow);
      }, 75);
    });
    openOnClick(A.trigger, pop);

    const p = dom.switchComposerModel("target-model", "agy", A.anchor);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;

    expect(res.ok).toBe(true);
    expect(oldClicked).not.toHaveBeenCalled();
    expect(newClicked).toHaveBeenCalled();
  });
});

describe("verified application (M1)", () => {
  it("does not report success for a disabled option", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const row = optionRow("target", { disabled: true });
    const clicked = vi.fn();
    row.addEventListener("click", clicked);
    const { pop } = popover({ rows: [row] });
    openOnClick(A.trigger, pop);

    const p = dom.switchComposerModel("target", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("model-not-found");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("reports unconfirmed when the option click applies nothing", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const row = optionRow("target");
    const { pop } = popover({ rows: [row] });
    // Native handler does nothing: menu stays open, trigger unchanged.
    openOnClick(A.trigger, pop);
    const escSpy = vi.fn();
    pop.addEventListener("keydown", escSpy);

    const p = dom.switchComposerModel("target", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unconfirmed");
    expect(escSpy).toHaveBeenCalled(); // we closed the menu we opened
  });
});

describe("provider tab handling (M2)", () => {
  it("does not mistake injected stars for provider tabs", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const row = optionRow("target-model");
    // Stars carry a title and no role="option" — the old code read them as
    // provider tabs and failed with provider-tab-missing.
    const star = document.createElement("button");
    star.className = "bb-fav-star-btn";
    star.title = "Добавить в избранное";
    row.appendChild(star);
    const { pop } = popover({ rows: [row] });
    row.addEventListener("click", () => pop.remove());
    openOnClick(A.trigger, pop);

    const p = dom.switchComposerModel("target-model", "codex", A.anchor);
    await vi.advanceTimersByTimeAsync(500);
    const res = await p;
    expect(res.ok).toBe(true);
  });

  it("single-provider picker still verifies the actual provider", async () => {
    const { dom } = await freshModules();
    const A = composer(); // trigger title says Codex
    const row = optionRow("target-model");
    const clicked = vi.fn();
    row.addEventListener("click", clicked);
    const { pop } = popover({ rows: [row] });
    openOnClick(A.trigger, pop);

    const p = dom.switchComposerModel("target-model", "agy", A.anchor);
    await vi.advanceTimersByTimeAsync(500);
    const res = await p;
    expect(res).toEqual({ ok: false, reason: "provider-tab-missing" });
    expect(clicked).not.toHaveBeenCalled();
  });
});

describe("hidden models (M3)", () => {
  it("expands 'More models' to find the row", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const { pop, list } = popover({ rows: [optionRow("other-model")] });
    const more = document.createElement("button");
    more.textContent = "More models";
    more.id = "x-more-toggle";
    pop.appendChild(more);
    const target = optionRow("deep-model");
    target.addEventListener("click", () => pop.remove());
    more.addEventListener("click", () => list.appendChild(target));
    openOnClick(A.trigger, pop);

    const p = dom.switchComposerModel("deep-model", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.ok).toBe(true);
  });

  it("fills the search box when the row is not rendered", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const { pop, list } = popover({ rows: [optionRow("other-model")], search: true });
    const input = pop.querySelector("input")!;
    const target = optionRow("deep-model");
    target.addEventListener("click", () => pop.remove());
    input.addEventListener("input", () => list.appendChild(target));
    openOnClick(A.trigger, pop);

    const p = dom.switchComposerModel("deep-model", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.ok).toBe(true);
    expect(input.value).toBe("deep-model");
  });
});

describe("pin section + observer (M5, M6, M7)", () => {
  it("pins favorites as clones without moving original rows", async () => {
    const { dom, mgr } = await freshModules();
    let version = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const method = url.split("/").pop()!;
        const favorites = method === "addFavorite" ? { codex: ["fav-model"] } : {};
        return {
          json: async () => ({
            ok: true,
            result: { version: ++version, favorites, modelLabels: {}, config: { pinToTop: true, showQuickBar: true } },
          }),
        };
      })
    );
    await mgr.addFavorite("codex", "fav-model");

    const r1 = optionRow("fav-model");
    const r2 = optionRow("other-model");
    const { pop, list } = popover({ tabs: [{ title: "Codex", active: true }], rows: [r1, r2] });
    document.body.append(pop);

    const cleanup = dom.initDomObserver();

    const section = document.querySelector(".bb-fav-pin-section");
    expect(section).toBeTruthy();
    const clones = document.querySelectorAll("button[data-bb-fav-clone]");
    expect(clones.length).toBe(1);
    // Originals never moved — BB keyboard order stays intact.
    expect([...list.children].filter((e) => e.getAttribute("role") === "option")).toEqual([r1, r2]);
    // The clone forwards the click to its original row.
    const origClick = vi.fn();
    r1.addEventListener("click", origClick);
    (clones[0] as HTMLElement).click();
    expect(origClick).toHaveBeenCalled();

    // Removing the last star unpins instantly — nothing to restore.
    await mgr.removeFavorite("codex", "fav-model");
    expect(document.querySelector(".bb-fav-pin-section")).toBeNull();

    cleanup();
    expect(document.querySelector(".bb-fav-star-btn")).toBeNull();
    expect(document.querySelector(".bb-fav-pin-section")).toBeNull();
  });

  it("rebinds the star handler when a row is reused for another model (M7)", async () => {
    const { dom, mgr } = await freshModules();
    void mgr;
    const bodies: { providerId?: string; modelId?: string }[] = [];
    stubRpc((method, body) => {
      if (method === "addFavorite") bodies.push(body as never);
      return { version: 1, favorites: {}, modelLabels: {}, config: {} };
    });

    const row = optionRow("old-model");
    const { pop } = popover({ tabs: [{ title: "Codex", active: true }], rows: [row] });
    document.body.append(pop);
    const cleanup = dom.initDomObserver();
    const star = row.querySelector<HTMLButtonElement>(".bb-fav-star-btn")!;
    expect(star).toBeTruthy();

    // React reuses the row node for a different model: only the title flips.
    row.querySelector("span.truncate")!.setAttribute("title", "new-model");
    await vi.advanceTimersByTimeAsync(400);

    star.click();
    await vi.advanceTimersByTimeAsync(50);

    expect(bodies.length).toBe(1);
    expect(bodies[0].providerId).toBe("codex");
    expect(bodies[0].modelId).toBe("new-model");
    cleanup();
  });
});
