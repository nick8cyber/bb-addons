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
