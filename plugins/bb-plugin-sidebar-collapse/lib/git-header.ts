export interface GitHeaderSnapshot {
  label: string;
  summary: string;
  count: string;
  expanded: boolean;
  disabled: boolean;
}
/** Enhance one host pane without reparenting React-owned nodes. Missing markers fail open. */
export function bindGitHeader(
  anchor: HTMLElement,
  onChange: (snapshot: GitHeaderSnapshot | null) => void,
): { toggle: () => void; dispose: () => void } {
  const pane = anchor.closest<HTMLElement>("[data-split-pane-id]");
  if (!pane) { onChange(null); return { toggle() {}, dispose() {} }; }
  const doc = anchor.ownerDocument;
  const win = doc.defaultView!;
  const selector = '[id="thread-prompt-banner-git-toggle"]';
  let source: HTMLButtonElement | null = null;
  let section: HTMLElement | null = null;
  let body: HTMLElement | null = null;
  let disposed = false;
  let pending = false;
  let last = "";
  const owned = new Map<HTMLElement, Map<string, string | null>>();
  const properties = ["--bb-git-left", "--bb-git-top", "--bb-git-width", "--bb-git-height"];
  function mark(el: HTMLElement, key: string, value: string) {
    let attrs = owned.get(el);
    if (!attrs) { attrs = new Map(); owned.set(el, attrs); }
    if (!attrs.has(key)) attrs.set(key, el.getAttribute(key));
    if (el.getAttribute(key) !== value) el.setAttribute(key, value);
  }
  function clear() {
    for (const [el, attrs] of owned) {
      for (const [key, value] of attrs) {
        if (value === null) el.removeAttribute(key); else el.setAttribute(key, value);
      }
    }
    owned.clear();
    for (const el of [section, body]) {
      for (const key of properties) el?.style.removeProperty(key);
    }
    section = body = null;
  }
  function position() {
    if (disposed || !section) return;
    const p = pane!.getBoundingClientRect();
    const h = anchor.closest("header")?.getBoundingClientRect();
    if (!h) return;
    const viewWidth = doc.documentElement.clientWidth || win.innerWidth;
    const viewHeight = win.visualViewport?.height ?? win.innerHeight;
    const minLeft = Math.max(8, p.left + 8);
    const right = Math.min(p.right, viewWidth) - 8;
    const width = Math.max(0, Math.min(500, right - minLeft));
    const left = Math.max(minLeft, Math.min(anchor.getBoundingClientRect().right - width, right - width));
    const top = Math.max(0, h.bottom + 4);
    const target = section.getAttribute("data-bb-git-section") === "only" ? section : body;
    if (target) {
      for (const [key, value] of Object.entries({
        "--bb-git-left": left + "px", "--bb-git-top": top + "px",
        "--bb-git-width": width + "px", "--bb-git-height": Math.max(80, viewHeight - top - 12) + "px",
      })) if (target.style.getPropertyValue(key) !== value) target.style.setProperty(key, value);
    }
    mark(anchor, "data-bb-git-compact", String(p.width < 620));
  }
  const sourceObserver = new win.MutationObserver(() => schedule());
  function update() {
    if (disposed) return;
    const next = pane!.querySelector<HTMLButtonElement>(selector);
    const nextSection = next?.closest<HTMLElement>("section") ?? null;
    const nextBody = pane!.querySelector<HTMLElement>('[id="thread-prompt-banner-git-body"]');
    // Do not hide anything until both the original disclosure and our header exist.
    if (source !== next || section !== nextSection || body !== nextBody) {
      sourceObserver.disconnect();
      clear();
      source = next;
      if (next && nextSection && nextBody && anchor.closest("header")) {
        section = nextSection;
        body = nextBody;
        sourceObserver.observe(next, { subtree: true, childList: true, characterData: true,
          attributes: true, attributeFilter: ["aria-label", "aria-expanded", "disabled"] });
      }
    }
    if (!source || !section || !body) {
      if (last !== "null") { last = "null"; onChange(null); }
      return;
    }
    // Unknown plugin segments and static status text must also remain accessible.
    const hasOtherContent = (node: Node): boolean => {
      if (node === source || node === body) return false;
      if (node.nodeType === 3) return Boolean(node.textContent?.trim());
      if (node instanceof win.Element && node.matches('button,a,input,select,textarea,[role="button"]')) return true;
      return Array.from(node.childNodes).some(hasOtherContent);
    };
    const others = Array.from(section.childNodes).some(hasOtherContent);
    const expanded = source.getAttribute("aria-expanded") === "true";
    mark(section, "data-bb-git-section", others ? "mixed" : "only");
    mark(section, "data-bb-git-open", String(expanded));
    mark(source, "data-bb-git-source", "");
    mark(body, "data-bb-git-body", "");
    mark(body, "data-bb-git-open", String(expanded));
    const summary = Array.from(source.children).find(el => el.tagName === "SPAN")?.textContent?.trim() || source.textContent?.trim() || "Changed files";
    const snapshot: GitHeaderSnapshot = {
      summary, label: source.getAttribute("aria-label") || summary,
      count: summary.match(/\d[\d,.\s]*/)?.[0].trim() || "",
      expanded, disabled: source.disabled,
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized !== last) { last = serialized; onChange(snapshot); }
    position();
  }
  function schedule() {
    if (pending || disposed) return;
    pending = true;
    queueMicrotask(() => { pending = false; update(); });
  }
  const paneObserver = new win.MutationObserver(records => {
    if (records.some(r => (source && r.target instanceof win.Element && r.target.contains(source)) ||
      [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some(n => n instanceof win.Element &&
        (n.matches(selector) || n.querySelector(selector))))) schedule();
  });
  paneObserver.observe(pane, { childList: true, subtree: true });
  const resize = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(position) : null;
  resize?.observe(pane);
  resize?.observe(anchor);
  const close = (focus: boolean) => {
    if (source?.getAttribute("aria-expanded") !== "true" || source.disabled) return;
    source.click();
    if (focus) anchor.querySelector("button")?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || source?.getAttribute("aria-expanded") !== "true") return;
    const target = e.target as Element | null;
    if (!target || !pane.contains(target)) return;
    if (target?.closest('[role="dialog"],[role="menu"],[role="listbox"]')) return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Element | null;
    if (!target || anchor.contains(target) || section?.contains(target) ||
      target.closest('[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]')) return;
    close(false);
  };
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  win.addEventListener("resize", position);
  win.visualViewport?.addEventListener("resize", position);
  update();
  return {
    toggle() { if (!disposed && source && !source.disabled) source.click(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      paneObserver.disconnect();
      sourceObserver.disconnect();
      resize?.disconnect();
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      win.removeEventListener("resize", position);
      win.visualViewport?.removeEventListener("resize", position);
      clear();
    },
  };
}
