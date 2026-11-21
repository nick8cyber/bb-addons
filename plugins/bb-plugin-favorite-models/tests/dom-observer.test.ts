// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Dom = typeof import("../src/dom-observer.js");
type Manager = typeof import("../src/favorites-manager.js");

let rowSeq = 0;
let popSeq = 0;

/**
 * Fixtures replicate BB 0.49.0's ModelReasoningMenu (Radix popover):
 * - wrapper[data-radix-popper-content-wrapper] > content[role=dialog][id][data-state]
 * - provider tabs AND the search field live inside content but OUTSIDE the
 *   inner option list — narrowing to `[role=listbox]` loses both.
 * - rows are `button[id="…-opt-N"]`; role="option" exists ONLY while the
 *   search box is rendered (>5 models), never on short pickers.
 * - trigger ↔ content link is `aria-controls`; there is NO
 *   `data-radix-popover-content` attribute anywhere in the tree.
 */
function optionRow(
  title: string,
  opts: { disabled?: boolean; withRole?: boolean } = {}
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = `:r5:-opt-${rowSeq++}`;
  if (opts.withRole) b.setAttribute("role", "option");
  if (opts.disabled) b.setAttribute("aria-disabled", "true");
  const s = document.createElement("span");
  s.className = "truncate";
  s.title = title;
  s.textContent = title.split(" · ")[0];
  const chk = document.createElement("span");
  chk.className = "flex shrink-0 items-center gap-1.5";
  b.append(s, chk);
  return b;
}

function nativePicker(opts: {
  tabs?: { title: string; active?: boolean }[];
  rows?: HTMLElement[];
  search?: boolean;
}): { wrapper: HTMLElement; content: HTMLElement; list: HTMLElement } {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-radix-popper-content-wrapper", "");
  const content = document.createElement("div");
  content.setAttribute("role", "dialog");
  content.setAttribute("data-state", "open");
  content.id = `radix-:rp${popSeq++}:`;

  if (opts.tabs?.length) {
    const strip = document.createElement("div");
    strip.className =
      "flex shrink-0 items-center gap-0.5 border-b border-border bg-background px-2.5 pt-1";
    for (const t of opts.tabs) {
      const tb = document.createElement("button");
      tb.title = t.title;
      tb.className = t.active
        ? "flex border-b-2 border-foreground text-foreground"
        : "flex border-b-2 border-transparent text-muted-foreground hover:text-foreground";
      strip.append(tb);
    }
    content.append(strip);
  }
  if (opts.search) {
    const sd = document.createElement("div");
    const input = document.createElement("input");
    input.placeholder = "Search models";
    input.setAttribute("aria-label", "Search models");
    sd.append(input);
    content.append(sd);
  }
  const list = document.createElement("div");
  if (opts.search) {
    list.setAttribute("role", "listbox");
    list.id = `:r5:-listbox-${popSeq}`;
  }
  const hdr = document.createElement("div");
  hdr.className = "sticky top-0";
  hdr.textContent = "Model";
  list.append(hdr, ...(opts.rows ?? []));
  content.append(list);
  wrapper.append(content);
  return { wrapper, content, list };
}

type Picker = ReturnType<typeof nativePicker>;

function composer(role = "primary", triggerTitle = "Codex: gpt-5 · high reasoning") {
  const root = document.createElement("div");
  root.setAttribute("data-app-composer", "");
  root.setAttribute("data-app-composer-role", role);
  const anchor = document.createElement("span");
  const trigger = document.createElement("button");
  trigger.setAttribute("aria-label", "Provider, model and reasoning (⇧⌘M)");
  const ts = document.createElement("span");
  ts.title = triggerTitle;
  trigger.append(ts);
  root.append(anchor, trigger);
  document.body.append(root);
  return { root, anchor, trigger };
}

/** What BB does when the popover is already open: aria-controls + portal. */
function openPicker(trigger: HTMLButtonElement, picker: Picker): void {
  trigger.setAttribute("aria-controls", picker.content.id);
  trigger.setAttribute("aria-expanded", "true");
  document.body.append(picker.wrapper);
}

/** Wire the trigger like Radix does: a click opens the popover. */
function openOnClick(trigger: HTMLButtonElement, picker: Picker): void {
  trigger.addEventListener("click", () => openPicker(trigger, picker));
}

const rowButtons = (root: HTMLElement | Document = document) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button[id*="-opt-"]'));

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
  popSeq = 0;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("native BB 0.49.0 markup — stars (blocker 1)", () => {
  it("short picker (<=5 models): rows have no role/listbox, stars still inject", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const picker = nativePicker({
      rows: [optionRow("m0"), optionRow("m1"), optionRow("m2")],
    });
    openPicker(A.trigger, picker);

    const dispose = dom.initDomObserver();
    expect(document.querySelectorAll(".bb-fav-star-btn").length).toBe(3);
    dispose();
  });

  it("thread picker (no tabs): star click reaches addFavorite with the trigger's provider", async () => {
    const { dom } = await freshModules();
    const bodies: { providerId?: string; modelId?: string }[] = [];
    stubRpc((method, body) => {
      if (method === "addFavorite") bodies.push(body as never);
      return { version: 1, favorites: {}, modelLabels: {}, config: {} };
    });
    const A = composer(); // trigger title says Codex
    const picker = nativePicker({
      search: true,
      rows: Array.from({ length: 7 }, (_, i) => optionRow(`m${i}`, { withRole: true })),
    });
    openPicker(A.trigger, picker);

    const dispose = dom.initDomObserver();
    const star = document.querySelector<HTMLButtonElement>(".bb-fav-star-btn")!;
    star.click();
    await vi.advanceTimersByTimeAsync(50);

    expect(bodies.length).toBe(1);
    expect(bodies[0].providerId).toBe("codex");
    expect(bodies[0].modelId).toBe("m0");
    dispose();
  });

  it("new-thread picker with tabs: provider comes from the ACTIVE tab inside content", async () => {
    const { dom } = await freshModules();
    const bodies: { providerId?: string }[] = [];
    stubRpc((method, body) => {
      if (method === "addFavorite") bodies.push(body as never);
      return { version: 1, favorites: {}, modelLabels: {}, config: {} };
    });
    const A = composer();
    const picker = nativePicker({
      search: true,
      tabs: [{ title: "Claude Code" }, { title: "Codex", active: true }],
      rows: Array.from({ length: 7 }, (_, i) => optionRow(`m${i}`, { withRole: true })),
    });
    openPicker(A.trigger, picker);

    const dispose = dom.initDomObserver();
    document.querySelector<HTMLButtonElement>(".bb-fav-star-btn")!.click();
    await vi.advanceTimersByTimeAsync(50);

    expect(bodies.length).toBe(1);
    expect(bodies[0].providerId).toBe("codex");
    dispose();
  });
});

describe("composer scoping (B1)", () => {
  it("drives only its own composer's popover, not a foreign open one", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const B = composer("secondary");

    // B already has an open popover containing a matching row.
    const pickerB = nativePicker({ rows: [optionRow("target-model", { withRole: true })] });
    openPicker(B.trigger, pickerB);
    const bClicked = vi.fn();
    rowButtons(pickerB.content)[0].addEventListener("click", bClicked);

    // A opens its own popover — without the requested model.
    const pickerA = nativePicker({ rows: [optionRow("other-model")] });
    openOnClick(A.trigger, pickerA);

    const p = dom.switchComposerModel("target-model", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("model-not-found");
    expect(bClicked).not.toHaveBeenCalled();
    // A's trigger got its OWN popover — the foreign one was never adopted.
    expect(A.trigger.getAttribute("aria-controls")).toBe(pickerA.content.id);
  });

  it("reports no-trigger instead of hijacking another composer", async () => {
    const { dom } = await freshModules();
    const rootA = document.createElement("div");
    rootA.setAttribute("data-app-composer-role", "primary");
    const anchor = document.createElement("span");
    rootA.append(anchor);
    document.body.append(rootA);

    const B = composer("secondary");
    const pickerB = nativePicker({ rows: [optionRow("target-model", { withRole: true })] });
    openPicker(B.trigger, pickerB);
    const bClicked = vi.fn();
    rowButtons(pickerB.content)[0].addEventListener("click", bClicked);

    const res = await dom.switchComposerModel("target-model", undefined, anchor);
    expect(res).toEqual({ ok: false, reason: "no-trigger" });
    expect(bClicked).not.toHaveBeenCalled();
  });

  it("openNativeModelPicker opens only the anchored composer's picker", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const B = composer("secondary");
    const pickerA = nativePicker({ rows: [] });
    const pickerB = nativePicker({ rows: [] });
    openOnClick(A.trigger, pickerA);
    openOnClick(B.trigger, pickerB);

    dom.openNativeModelPicker(B.anchor);
    expect(B.trigger.getAttribute("aria-controls")).toBe(pickerB.content.id);
    expect(A.trigger.getAttribute("aria-controls")).toBeNull();
    expect(document.getElementById(pickerB.content.id)).toBeTruthy();
    expect(document.getElementById(pickerA.content.id)).toBeNull();
  });
});

describe("full model key incl. route (B2)", () => {
  it("clicks the row with the matching route, not the first same-name row", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const r1 = optionRow("M · RouteA");
    const r2 = optionRow("M · RouteB");
    const picker = nativePicker({ rows: [r1, r2] });
    const c1 = vi.fn();
    const c2 = vi.fn(() => picker.wrapper.remove());
    r1.addEventListener("click", c1);
    r2.addEventListener("click", c2);
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("M · RouteB", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(500);
    const res = await p;

    expect(res.ok).toBe(true);
    expect(c2).toHaveBeenCalled();
    expect(c1).not.toHaveBeenCalled();
  });
});

describe("cancellable polling (B3)", () => {
  it("a newer switch on the same composer cancels the previous one's polls", async () => {
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

  it("cancelling ANOTHER composer leaves this switch running", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const B = composer("secondary");
    const p = dom.switchComposerModel("x", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(50);
    dom.cancelPendingSwitch(B.anchor); // B has no pending switch — must be a no-op
    await vi.advanceTimersByTimeAsync(1500);
    const res = await p;
    expect(res).toEqual({ ok: false, reason: "no-popover" });
  });

  it("a cancelled poll cannot click into a menu that appears later", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const p = dom.switchComposerModel("target", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(50);
    dom.cancelPendingSwitch();

    // A matching menu shows up only AFTER the cancellation.
    const picker = nativePicker({ rows: [optionRow("target", { withRole: true })] });
    openPicker(A.trigger, picker);
    const clicked = vi.fn();
    rowButtons(picker.content)[0].addEventListener("click", clicked);

    await vi.advanceTimersByTimeAsync(1500);
    const res = await p;
    expect(res.reason).toBe("cancelled");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("aborts when the popover closes mid-scan instead of clicking a reopened one", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const picker = nativePicker({ rows: [optionRow("other-model")] });
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("target", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(100);
    // User closes the menu before the model shows up.
    picker.wrapper.remove();
    A.trigger.removeAttribute("aria-controls");
    await vi.advanceTimersByTimeAsync(100);
    const res = await p;
    expect(res.reason).toBe("cancelled");
  });

  it("waits for the new provider tab before matching rows", async () => {
    const { dom } = await freshModules();
    const A = composer();
    // The OLD provider's list already shows a same-named row; a premature
    // match would click it — the exact B3 reproduction.
    const oldRow = optionRow("target-model", { withRole: true });
    const oldClicked = vi.fn();
    oldRow.addEventListener("click", oldClicked);
    const picker = nativePicker({
      search: true,
      tabs: [
        { title: "Codex", active: true },
        { title: "Antigravity" },
      ],
      rows: [oldRow],
    });
    const newRow = optionRow("target-model", { withRole: true });
    const newClicked = vi.fn(() => picker.wrapper.remove());
    newRow.addEventListener("click", newClicked);

    const tabs = picker.content.querySelectorAll<HTMLButtonElement>("div.border-b button[title]");
    tabs[1].addEventListener("click", () => {
      setTimeout(() => {
        tabs[0].className = "flex border-b-2 border-transparent text-muted-foreground";
        tabs[1].className = "flex border-b-2 border-foreground text-foreground";
        oldRow.remove();
        picker.list.appendChild(newRow);
      }, 75);
    });
    openOnClick(A.trigger, picker);

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
    const row = optionRow("target", { disabled: true, withRole: true });
    const clicked = vi.fn();
    row.addEventListener("click", clicked);
    const picker = nativePicker({ rows: [row] });
    openOnClick(A.trigger, picker);

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
    const picker = nativePicker({ rows: [row] });
    // Native handler does nothing: menu stays open, trigger unchanged.
    openOnClick(A.trigger, picker);
    const escSpy = vi.fn();
    picker.content.addEventListener("keydown", escSpy);

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
    const picker = nativePicker({ rows: [row] });
    row.addEventListener("click", () => picker.wrapper.remove());
    openOnClick(A.trigger, picker);

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
    const picker = nativePicker({ rows: [row] });
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("target-model", "agy", A.anchor);
    await vi.advanceTimersByTimeAsync(500);
    const res = await p;
    expect(res).toEqual({ ok: false, reason: "provider-tab-missing" });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("cross-provider switch works with tabs outside the listbox (blocker 2)", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const claudeRow = optionRow("m2", { withRole: true });
    const clicked = vi.fn(() => picker.wrapper.remove());
    claudeRow.addEventListener("click", clicked);
    const picker = nativePicker({
      search: true,
      tabs: [{ title: "Claude Code" }, { title: "Codex", active: true }],
      rows: Array.from({ length: 7 }, (_, i) => optionRow(`codex-m${i}`, { withRole: true })),
    });
    const strip = picker.content.querySelector<HTMLElement>("div.border-b")!;
    const claudeTab = strip.querySelector<HTMLButtonElement>('button[title="Claude Code"]')!;
    claudeTab.addEventListener("click", () => {
      claudeTab.className = "flex border-b-2 border-foreground text-foreground";
      picker.list.replaceChildren(claudeRow);
    });
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("m2", "provider-claude-code", A.anchor);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;
    expect(res.ok).toBe(true);
    expect(clicked).toHaveBeenCalled();
  });
});

describe("hidden models (M3)", () => {
  it("expands 'More models' to find the row", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const picker = nativePicker({ rows: [optionRow("other-model")] });
    const more = document.createElement("button");
    more.textContent = "More models";
    more.id = "x-more-toggle";
    picker.content.appendChild(more);
    const target = optionRow("deep-model");
    target.addEventListener("click", () => picker.wrapper.remove());
    more.addEventListener("click", () => picker.list.appendChild(target));
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("deep-model", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.ok).toBe(true);
  });

  it("follows 'More models' into a portal submenu (desktop short list)", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const picker = nativePicker({ rows: [optionRow("other-model")] });
    const more = document.createElement("button");
    more.textContent = "More models";
    picker.content.appendChild(more);
    // Radix submenu: content portaled to body, linked via the trigger's
    // aria-controls; submenu rows carry neither -opt- ids nor roles.
    more.addEventListener("click", () => {
      const sub = document.createElement("div");
      sub.setAttribute("role", "menu");
      sub.id = "radix-:sub1:";
      const row = document.createElement("button");
      const s = document.createElement("span");
      s.className = "truncate";
      s.title = "deep-model";
      s.textContent = "deep-model";
      row.appendChild(s);
      row.addEventListener("click", () => {
        sub.remove();
        picker.wrapper.remove();
      });
      sub.appendChild(row);
      document.body.append(sub);
      more.setAttribute("aria-controls", sub.id);
    });
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("deep-model", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.ok).toBe(true);
  });

  it("fills the search box when the row is not rendered, then clears it on failure", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const picker = nativePicker({ rows: [optionRow("other-model")], search: true });
    const input = picker.content.querySelector("input")!;
    const typedValues: string[] = [];
    input.addEventListener("input", () => typedValues.push(input.value));
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("deep-model", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;
    expect(res.reason).toBe("model-not-found");
    expect(typedValues).toContain("deep-model"); // the M3 fallback did type the query
    expect(input.value).toBe(""); // and the failed attempt left no residue
  });

  it("finds the row via search when it appears after filtering", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const picker = nativePicker({ rows: [optionRow("other-model")], search: true });
    const input = picker.content.querySelector("input")!;
    const target = optionRow("deep-model", { withRole: true });
    target.addEventListener("click", () => picker.wrapper.remove());
    input.addEventListener("input", () => picker.list.appendChild(target));
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("deep-model", undefined, A.anchor);
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.ok).toBe(true);
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

    const A = composer();
    const r1 = optionRow("fav-model", { withRole: true });
    const r2 = optionRow("other-model", { withRole: true });
    const picker = nativePicker({
      search: true,
      tabs: [{ title: "Codex", active: true }],
      rows: [r1, r2],
    });
    openPicker(A.trigger, picker);

    const cleanup = dom.initDomObserver();

    const section = document.querySelector(".bb-fav-pin-section");
    expect(section).toBeTruthy();
    const clones = document.querySelectorAll("button[data-bb-fav-clone]");
    expect(clones.length).toBe(1);
    // Originals never moved — BB keyboard order stays intact.
    expect([...picker.list.children].filter((e) => e.id.includes("-opt-"))).toEqual([r1, r2]);
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
    const { dom } = await freshModules();
    const bodies: { providerId?: string; modelId?: string }[] = [];
    stubRpc((method, body) => {
      if (method === "addFavorite") bodies.push(body as never);
      return { version: 1, favorites: {}, modelLabels: {}, config: {} };
    });

    const A = composer();
    const row = optionRow("old-model", { withRole: true });
    const picker = nativePicker({
      search: true,
      tabs: [{ title: "Codex", active: true }],
      rows: [row],
    });
    openPicker(A.trigger, picker);
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

describe("legacy favorites stored as bare modelId", () => {
  it("star click on 'M · route' removes the stored 'M' instead of stacking a twin", async () => {
    const { dom, mgr } = await freshModules();
    const calls: { method: string; modelId?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        const method = url.split("/").pop()!;
        const body = init?.body ? (JSON.parse(init.body) as { modelId?: string } | null) : null;
        calls.push({ method, modelId: body?.modelId });
        const favorites = method === "getFavorites" ? { codex: ["M"] } : {};
        return {
          json: async () => ({
            ok: true,
            result: { version: 1, favorites, modelLabels: {}, config: {} },
          }),
        };
      })
    );
    // Seed the legacy "M" entry from the server snapshot.
    const stopSync = mgr.initBackendSync();
    await vi.waitFor(() => expect(mgr.isFavorite("codex", "M")).toBe(true));
    stopSync();

    const A = composer();
    const row = optionRow("M · route", { withRole: true });
    const picker = nativePicker({
      search: true,
      tabs: [{ title: "Codex", active: true }],
      rows: [row],
    });
    openPicker(A.trigger, picker);
    const cleanup = dom.initDomObserver();

    const star = row.querySelector<HTMLButtonElement>(".bb-fav-star-btn")!;
    star.click();
    await vi.advanceTimersByTimeAsync(50);

    const rm = calls.filter((c) => c.method === "removeFavorite");
    expect(rm.length).toBe(1);
    expect(rm[0].modelId).toBe("M");
    expect(calls.filter((c) => c.method === "addFavorite").length).toBe(0);
    cleanup();
  });
});

/** Real BB ToggleGroup ("Speed" / agent-option sections): a role=radiogroup
 * (or toolbar) flex strip whose items carry title=item.description. */
function titledToggleGroup(role: "radiogroup" | "toolbar" = "radiogroup"): HTMLElement {
  const group = document.createElement("div");
  group.className = "flex items-center justify-center gap-1";
  group.setAttribute("role", role);
  for (const [label, desc, on] of [
    ["Default", "Default speed", false],
    ["Fast", "Priority processing for this model", true],
  ] as const) {
    const item = document.createElement("button");
    item.type = "button";
    item.title = desc;
    item.textContent = label;
    item.className =
      "inline-flex items-center justify-center gap-2 h-6 min-w-0 flex-auto shrink-0 " +
      "whitespace-nowrap rounded-sm px-1 text-xs font-normal shadow-none hover:bg-state-hover " +
      "hover:text-foreground data-[state=on]:bg-state-active data-[state=on]:text-foreground";
    item.setAttribute("data-state", on ? "on" : "off");
    group.append(item);
  }
  return group;
}

/** Real BB disabled row: title = disabledReason, the label lives in the
 * row's own text (base node + "(tag)"/route subtitle spans). */
function disabledOptionRow(
  label: string,
  reason: string | null,
  opts: { tag?: string; route?: string; withRole?: boolean } = {}
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = `:r5:-opt-${rowSeq++}`;
  b.disabled = true;
  if (opts.withRole) b.setAttribute("role", "option");
  const s = document.createElement("span");
  s.className = "truncate";
  s.title = reason ?? (opts.route ? `${label} · ${opts.route}` : label);
  s.appendChild(document.createTextNode(label));
  for (const sub of [opts.tag, opts.route]) {
    if (!sub) continue;
    const sp = document.createElement("span");
    sp.className = "ml-1.5 text-subtle-foreground";
    sp.textContent = sub;
    s.append(sp);
  }
  const chk = document.createElement("span");
  chk.className = "flex shrink-0 items-center gap-1.5";
  b.append(s, chk);
  return b;
}

describe("native ToggleGroup sections (review r3 blocker)", () => {
  it("titled ToggleGroup items are NOT provider tabs — star writes under the trigger's provider", async () => {
    const { dom } = await freshModules();
    const bodies: { providerId?: string; modelId?: string }[] = [];
    stubRpc((method, body) => {
      if (method === "addFavorite") bodies.push(body as never);
      return { version: 1, favorites: {}, modelLabels: {}, config: {} };
    });

    const A = composer();
    const picker = nativePicker({
      search: true,
      rows: Array.from({ length: 7 }, (_, i) => optionRow(`m${i}`, { withRole: true })),
    });
    const section = document.createElement("div");
    section.className = "shrink-0 px-2 py-2.5";
    section.append(titledToggleGroup("radiogroup"), titledToggleGroup("toolbar"));
    picker.content.append(section);
    openPicker(A.trigger, picker);

    const cleanup = dom.initDomObserver();
    expect(dom.detectActiveProvider(picker.content)).toBe("codex");
    document.querySelector<HTMLButtonElement>(".bb-fav-star-btn")!.click();
    await vi.advanceTimersByTimeAsync(50);

    expect(bodies.length).toBe(1);
    expect(bodies[0].providerId).toBe("codex");
    expect(bodies[0].modelId).toBe("m0");
    cleanup();
  });

  it("single-provider picker + ToggleGroup: quick switch reaches the row (no provider-tab-missing)", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const row = optionRow("target", { withRole: true });
    const picker = nativePicker({ search: true, rows: [row] });
    const section = document.createElement("div");
    section.append(titledToggleGroup());
    picker.content.append(section);
    row.addEventListener("click", () => picker.wrapper.remove());
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("target", "codex", A.anchor);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("' (current thread)' marker on a tab title does not poison the provider key", async () => {
    const { dom } = await freshModules();
    const bodies: { providerId?: string }[] = [];
    stubRpc((method, body) => {
      if (method === "addFavorite") bodies.push(body as never);
      return { version: 1, favorites: {}, modelLabels: {}, config: {} };
    });

    const A = composer();
    const picker = nativePicker({
      search: true,
      tabs: [{ title: "Pi (current thread)", active: true }],
      rows: Array.from({ length: 7 }, (_, i) => optionRow(`m${i}`, { withRole: true })),
    });
    openPicker(A.trigger, picker);

    const cleanup = dom.initDomObserver();
    expect(dom.detectActiveProvider(picker.content)).toBe("provider-pi");
    document.querySelector<HTMLButtonElement>(".bb-fav-star-btn")!.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(bodies[0]?.providerId).toBe("provider-pi");
    cleanup();
  });
});

describe("disabled rows (review r3)", () => {
  it("title holds the disable reason → the star stores the row label, not the reason", async () => {
    const { dom } = await freshModules();
    const bodies: { providerId?: string; modelId?: string }[] = [];
    stubRpc((method, body) => {
      if (method === "addFavorite") bodies.push(body as never);
      return { version: 1, favorites: {}, modelLabels: {}, config: {} };
    });

    const A = composer();
    const picker = nativePicker({
      search: true,
      rows: [
        optionRow("gpt-5 · codex", { withRole: true }),
        disabledOptionRow("gpt-5-mini", "Cannot switch while the agent is running", {
          route: "codex",
          withRole: true,
        }),
      ],
    });
    openPicker(A.trigger, picker);

    const cleanup = dom.initDomObserver();
    const stars = document.querySelectorAll<HTMLButtonElement>(".bb-fav-star-btn");
    expect(stars.length).toBe(2);
    stars[1].click();
    await vi.advanceTimersByTimeAsync(50);

    expect(bodies.length).toBe(1);
    expect(bodies[0].modelId).toBe("gpt-5-mini · codex");
    cleanup();
  });

  it("disabled row WITHOUT a reason keeps its real 'label · route' key", async () => {
    const { dom } = await freshModules();
    const bodies: { modelId?: string }[] = [];
    stubRpc((method, body) => {
      if (method === "addFavorite") bodies.push(body as never);
      return { version: 1, favorites: {}, modelLabels: {}, config: {} };
    });

    const A = composer();
    const picker = nativePicker({
      search: true,
      rows: [disabledOptionRow("gpt-5-mini", null, { route: "codex", withRole: true })],
    });
    openPicker(A.trigger, picker);

    const cleanup = dom.initDomObserver();
    document.querySelector<HTMLButtonElement>(".bb-fav-star-btn")!.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(bodies[0]?.modelId).toBe("gpt-5-mini · codex");
    cleanup();
  });
});

describe("switch hygiene (review r3 minor)", () => {
  it("provider-tab-missing closes the popover we opened", async () => {
    const { dom } = await freshModules();
    const A = composer();
    const picker = nativePicker({
      search: true,
      tabs: [{ title: "Claude Code", active: true }],
      rows: [optionRow("m0", { withRole: true })],
    });
    const escapes: string[] = [];
    picker.content.addEventListener("keydown", (e) => escapes.push((e as KeyboardEvent).key));
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("m0", "codex", A.anchor);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ ok: false, reason: "provider-tab-missing" });
    expect(escapes).toContain("Escape");
  });

  it("trigger showing 'M2' does NOT confirm a click on 'M' (exact match only)", async () => {
    const { dom } = await freshModules();
    const A = composer("primary", "Codex: M2");
    const picker = nativePicker({
      search: true,
      rows: [optionRow("M", { withRole: true })],
    });
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("M", "codex", A.anchor);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ ok: false, reason: "unconfirmed" });
  });

  it("trigger's own '· reasoning' qualifier still confirms the right model", async () => {
    const { dom } = await freshModules();
    const A = composer("primary", "Codex: target · high reasoning");
    // The row stays open after our click: only triggerShowsModel can confirm.
    const picker = nativePicker({
      search: true,
      rows: [optionRow("target", { withRole: true })],
    });
    openOnClick(A.trigger, picker);

    const p = dom.switchComposerModel("target", "codex", A.anchor);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ ok: true });
  });
});
