/**
 * Renders the sidebar navigation items ("New thread / Search / panel / More")
 * as icon buttons inside the sidebar's top chrome row (clone-and-forward:
 * React nodes cannot leave their tree — bb blocks the move). Each clone
 * forwards clicks to the real button, so native handlers, shortcuts and
 * menus keep working. The original region is hidden via CSS, freeing ~57px.
 *
 * Re-sync runs on a plain 1.5s interval, not a MutationObserver: a signature
 * check skips unchanged layouts, so the tick is cheap and can never loop.
 */
const LIST = '[data-testid="sidebar-navigation-list"]';
const ROW = '[data-testid="app-sidebar-top-reserve-row"]';
const HOST_ATTR = "data-bb-nav-top-icons";
const RESYNC_MS = 1500;

function sourceButtons(list: Element): HTMLElement[] {
  return [
    ...Array.from(list.querySelectorAll('[data-sidebar-navigation-item] > button:first-of-type')),
    ...Array.from(list.children).filter((c) => c.tagName === "BUTTON"),
  ] as HTMLElement[];
}

function signature(sources: HTMLElement[]): string {
  return sources
    .map((s) =>
      (s.getAttribute("aria-label") || "") +
      "|" + (s.querySelector("[data-icon]")?.getAttribute("data-icon") || "") +
      "|" + (s.querySelector(".rounded-full") ? "b" : ""))
    .join(";");
}

function buildIcons(doc: Document, sources: HTMLElement[]): HTMLElement | null {
  if (!sources.length) return null;
  const host = doc.createElement("div");
  host.className = "bb-nav-top-icons";
  host.setAttribute(HOST_ATTR, "");
  for (const src of sources) {
    const btn = doc.createElement("button");
    btn.type = "button";
    const label = src.getAttribute("aria-label") || src.textContent?.trim() || "";
    btn.setAttribute("aria-label", label);
    btn.title = label;
    const icon = src.querySelector("[data-icon-root] svg, [data-icon-root]")?.cloneNode(true);
    if (icon) btn.append(icon);
    if (!btn.childNodes.length) return null;
    if (src.querySelector(".rounded-full")) {
      const dot = doc.createElement("span");
      dot.className = "bb-nav-top-badge";
      btn.append(dot);
    }
    btn.addEventListener("click", () => {
      for (const type of ["pointerdown", "pointerup", "click"]) {
        src.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
      }
    });
    host.append(btn);
  }
  return host;
}

function collectDiag(doc: Document, row: Element | null, sources: HTMLElement[], clone: Element | null): void {
  try {
    const rects = clone
      ? Array.from(clone.querySelectorAll("button")).map((b) => {
          const r = b.getBoundingClientRect();
          return { label: b.getAttribute("aria-label") || "", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
        })
      : [];
    let overlaps = 0;
    for (let i = 1; i < rects.length; i++) {
      if (rects[i].x < rects[i - 1].x + rects[i - 1].w - 1) overlaps++;
    }
    const region = doc.querySelector('[data-testid="sidebar-navigation-region"]');
    const win = (doc.defaultView || window) as unknown as Record<string, unknown>;
    win.__bbNavTopDiag = {
      ts: Date.now(),
      rowFound: !!row,
      sourceCount: sources.length,
      cloneCount: rects.length,
      rects,
      overlaps,
      regionHidden: region ? getComputedStyle(region).visibility === "hidden" : null,
    };
  } catch { /* diagnostics must never break the script */ }
}

export function mountNavTopRow(signal?: AbortSignal, doc: Document = document): () => void {
  if (signal?.aborted) return () => {};
  let lastSig = "";
  const sync = () => {
    const row = doc.querySelector(ROW);
    if (!row) return;
    const existing = row.querySelector(`[${HOST_ATTR}]`);
    const list = doc.querySelector(LIST);
    const sources = list ? sourceButtons(list) : [];
    const sig = signature(sources);
    if (!sources.length || (sig === lastSig && existing)) return;
    const rebuilt = buildIcons(doc, sources);
    if (rebuilt) {
      lastSig = sig;
      existing?.remove();
      row.insertBefore(rebuilt, row.firstChild);
      doc.documentElement.setAttribute("data-bb-nav-icons-active", "");
    }
    collectDiag(doc, row, sources, row.querySelector(`[${HOST_ATTR}]`));
  };
  sync();
  const timer = setInterval(sync, RESYNC_MS);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    doc.querySelector(`[${HOST_ATTR}]`)?.remove();
    doc.documentElement.removeAttribute("data-bb-nav-icons-active");
    signal?.removeEventListener("abort", dispose);
  };
  signal?.addEventListener("abort", dispose, { once: true });
  return dispose;
}
