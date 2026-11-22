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

  it("portal 'More models' submenu rows get stars and pin under the parent provider", async () => {
    const { dom, mgr } = await freshModules();
    const bodies: { providerId?: string; modelId?: string }[] = [];
    stubRpc((method, body) => {
      if (method === "addFavorite") bodies.push(body as never);
      return method === "getFavorites"
        ? { version: 1, favorites: { codex: ["pinned-deep"] }, modelLabels: {}, config: { pinToTop: true } }
        : { version: 2, favorites: { codex: ["pinned-deep"] }, modelLabels: {}, config: { pinToTop: true } };
    });
    const A = composer();
    const picker = nativePicker({ rows: [optionRow("top-model")] });
    const more = document.createElement("button");
    more.textContent = "More models";
    picker.content.appendChild(more);

    // Radix submenu: content portaled to body, linked via the trigger's
    // aria-controls; submenu rows carry neither -opt- ids nor roles.
    const sub = document.createElement("div");
    sub.setAttribute("role", "menu");
    sub.id = "radix-:sub-stars:";
    sub.dataset.state = "open";
    const portalRow = (title: string) => {
      const row = document.createElement("button");
      const s = document.createElement("span");
      s.className = "truncate";
      s.title = title;
      s.textContent = title;
      row.appendChild(s);
      return row;
    };
    const pinned = portalRow("pinned-deep");
    const plain = portalRow("deep-model");
    sub.append(pinned, plain);
    more.addEventListener("click", () => {
      document.body.append(sub);
      more.setAttribute("aria-controls", sub.id);
      more.setAttribute("aria-expanded", "true");
    });
    openPicker(A.trigger, picker);
    more.click();
    await mgr.refreshFavorites();

    const dispose = dom.initDomObserver();
    await vi.advanceTimersByTimeAsync(150);

    const stars = sub.querySelectorAll<HTMLButtonElement>(":scope > button > .bb-fav-star-btn");
    expect(stars.length).toBe(2);
    // The parent provider's favorite is starred and pinned inside the submenu.
    expect(pinned.classList.contains("bb-fav-row-starred")).toBe(true);
    expect(plain.classList.contains("bb-fav-row-starred")).toBe(false);
    expect(sub.querySelector(".bb-fav-pin-section button[data-bb-fav-clone]")).toBeTruthy();

    plain.querySelector<HTMLButtonElement>(".bb-fav-star-btn")!.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(bodies.length).toBe(1);
    expect(bodies[0].providerId).toBe("codex");
    expect(bodies[0].modelId).toBe("deep-model");
    dispose();
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
            result: { version: ++version, favorites, modelLabels: {}, config: { pinToTop: true } },
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

