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
          return {
            label: b.getAttribute("aria-label") || "",
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
            svgs: b.querySelectorAll("svg").length,
            html: b.innerHTML.slice(0, 300),
          };
        })
      : [];
    let overlaps = 0;
    for (let i = 1; i < rects.length; i++) {
      if (rects[i].x < rects[i - 1].x + rects[i - 1].w - 1) overlaps++;
    }
    const stackAt = (x: number, y: number) =>
      Array.from(doc.elementsFromPoint(x, y)).slice(0, 6).map((e) => ({
        tag: e.tagName, cls: ((e as HTMLElement).className?.toString?.() || "").slice(0, 60),
        label: (e as HTMLElement).getAttribute?.("aria-label") || "",
        ours: !!(e as HTMLElement).closest?.(`[${HOST_ATTR}]`),
      }));
    const paintStack = rects.length && rects[0]
      ? stackAt(rects[0].x + rects[0].w / 2, rects[0].y + 14)
      : [];
    const region = doc.querySelector('[data-testid="sidebar-navigation-region"]');
    const dots = Array.from(doc.querySelectorAll('[class*="rounded"], [class*="badge"], [class*="avatar"], [class*="dot"], [class*="indicator"], [class*="unread"], [class*="notification"], [class*="count"], [data-nav-rail-badge], [data-icon]'))
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width >= 6 && r.width <= 48 && r.top < 80 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).display !== "none";
      })
      .slice(0, 10)
      .map((e) => {
        const r = e.getBoundingClientRect();
        const el = e as HTMLElement;
        return {
          tag: e.tagName, cls: (el.className?.toString?.() || "").slice(0, 80),
          text: (el.textContent || "").trim().slice(0, 20),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          insideRegion: region?.contains(e) ?? false,
          inTopRow: !!e.closest?.('[data-testid="app-sidebar-top-reserve-row"]'),
        };
      });
    const rowChildren = row
      ? Array.from(row.children).map((c) => {
          const r = c.getBoundingClientRect();
          const el = c as HTMLElement;
          return {
            tag: c.tagName, ours: c.hasAttribute(HOST_ATTR),
            label: el.getAttribute?.("aria-label") || (c.querySelector?.("button")?.getAttribute("aria-label")) || "",
            testid: c.getAttribute?.("data-testid") || "",
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
          };
        })
      : [];
    const pseudoScan = (root: Element | null): Record<string, unknown>[] => {
      if (!root) return [];
      const out: Record<string, unknown>[] = [];
      const els = [root, ...Array.from(root.querySelectorAll("*"))];
      for (const el of els.slice(0, 60)) {
        for (const p of ["::before", "::after"] as const) {
          try {
            const s = getComputedStyle(el, p);
            if (s.display !== "none" && s.position !== "static" && parseFloat(s.width) >= 6 && s.content !== "none" && s.content !== "normal") {
              const r = el.getBoundingClientRect();
              out.push({
                p, cls: ((el as HTMLElement).className?.toString?.() || "").slice(0, 60),
                w: s.width, h: s.height, bg: s.backgroundColor.slice(0, 40), pos: s.position,
                shadow: s.boxShadow.slice(0, 60), border: `${s.borderTopWidth} ${s.borderTopStyle}`,
                elX: Math.round(r.x), elY: Math.round(r.y),
                content: s.content.slice(0, 20),
              });
            }
          } catch { /* skip */ }
        }
      }
      return out.slice(0, 15);
    };
    const pseudo = (el: Element | null | undefined) => {
      if (!el) return null;
      const out: Record<string, string> = {};
      for (const p of ["::before", "::after"] as const) {
        const s = getComputedStyle(el, p);
        if (s.display !== "none" && s.content !== "none" && s.content !== "normal" && parseFloat(s.width) > 0) {
          out[p] = `content=${s.content.slice(0, 30)} w=${s.width} h=${s.height} bg=${s.backgroundColor} pos=${s.position} r=${s.borderRadius}`;
        }
      }
      return Object.keys(out).length ? out : null;
    };
    const moreClone = clone?.querySelector("button:last-of-type");
    const moreSource = sources.find((s) => s.querySelector(".rounded-full"));
    const win = (doc.defaultView || window) as unknown as Record<string, unknown>;
    win.__bbNavTopDiag = {
      ts: Date.now(),
      rowFound: !!row,
      sourceCount: sources.length,
      cloneCount: rects.length,
      rects,
      overlaps,
      rowChildren,
      paintStack,
      dots,
      pseudoClone: pseudo(moreClone),
      pseudoRow: pseudoScan(row),
      pseudoAncestors: [row?.parentElement, row?.parentElement?.parentElement, row?.parentElement?.parentElement?.parentElement]
        .flatMap((p) => pseudoScan(p || null)).slice(0, 15),
      rectScan: Array.from(doc.querySelectorAll("body *")).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= -10 && r.top < 80 && r.width >= 8 && r.width <= 40 && Math.abs(r.width - r.height) <= 10
          && getComputedStyle(e).visibility !== "hidden";
      }).slice(0, 25).map((e) => {
        const r = e.getBoundingClientRect(); const el = e as HTMLElement; const s = getComputedStyle(el);
        return { tag: e.tagName, cls: (el.className?.toString?.() || "").slice(0, 70),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
          pe: s.pointerEvents,
          shadow: s.boxShadow !== "none" ? s.boxShadow.slice(0, 50) : undefined,
          bgImg: s.backgroundImage !== "none" ? s.backgroundImage.slice(0, 60) : undefined,
          plugin: el.closest?.("[data-bb-plugin]")?.getAttribute("data-bb-plugin") || "" };
      }),
      rowBg: row ? getComputedStyle(row).backgroundImage.slice(0, 80) : null,
      rowShadow: row ? getComputedStyle(row).boxShadow.slice(0, 80) : null,
      zoneScan: Array.from(doc.querySelectorAll("body *")).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.left < 285 && r.right > 140 && r.top < 60 && r.bottom > -5 && r.width > 0 && r.width <= 300
          && getComputedStyle(e).visibility !== "hidden";
      }).sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return (ra.width * ra.height) - (rb.width * rb.height); })
        .slice(0, 30).map((e) => {
          const r = e.getBoundingClientRect(); const el = e as HTMLElement;
          return { tag: e.tagName, cls: (el.className?.toString?.() || "").slice(0, 60),
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
            plugin: el.closest?.("[data-bb-plugin]")?.getAttribute("data-bb-plugin") || "" };
        }),
      pseudoSource: pseudo(moreSource),
      sourceBadgeHtml: moreSource?.querySelector(".rounded-full")?.outerHTML?.slice(0, 300) || null,
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
    // A fixed native "Toggle sidebar" button overlays the row's left edge —
    // shift the icons clear of it (recomputed each tick; absent => 0).
    const host = row.querySelector(`[${HOST_ATTR}]`) as HTMLElement | null;
    if (host) {
      const hostRect = host.getBoundingClientRect();
      let shift = 0;
      for (const t of Array.from(doc.querySelectorAll('button[aria-label^="Toggle sidebar" i]'))) {
        const tr = t.getBoundingClientRect();
        if (tr.width && tr.top < hostRect.bottom && tr.bottom > hostRect.top && tr.right > hostRect.left && tr.left < hostRect.right) {
          shift = Math.max(shift, tr.right - hostRect.left + 4);
        }
      }
      host.style.marginLeft = shift > 0 ? `${Math.round(shift)}px` : "";
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
