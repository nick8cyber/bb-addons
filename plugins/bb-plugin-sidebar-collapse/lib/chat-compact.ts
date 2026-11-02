export interface ActivitySnapshot { label: string; expanded: boolean; controlsId: string }
let sequence = 0;
const sectionSelector = '[data-app-composer-role="primary"] section[aria-label]';
const toggleSelector = '[id="thread-background-commands-card-toggle"]';
/** Decorate native cards in one pane; never move or replace React-owned nodes. */
export function bindActivityHeader(anchor: HTMLElement, onChange: (state: ActivitySnapshot | null) => void) {
  const pane = anchor.closest<HTMLElement>("[data-split-pane-id]");
  const doc = anchor.ownerDocument, win = doc.defaultView!;
  if (!pane) { onChange(null); return { toggle() {}, dispose() {} }; }
  let section: HTMLElement | null = null, open = false, disposed = false, queued = false, last = "";
  let originalId: string | null = null;
  const props = ["--bb-activity-left", "--bb-activity-top", "--bb-activity-width", "--bb-activity-height"];
  const restore = () => {
    if (!section) return;
    section.removeAttribute("data-bb-activity-card");
    section.removeAttribute("data-bb-activity-open");
    if (originalId === null) section.removeAttribute("id"); else section.id = originalId;
    for (const key of props) section.style.removeProperty(key);
  };
  const position = () => {
    if (!section || !open) return;
    const p = pane.getBoundingClientRect(), h = anchor.closest("header")?.getBoundingClientRect();
    if (!h) return;
    const view = win.visualViewport;
    const leftBound = Math.max(8, p.left + 8, (view?.offsetLeft ?? 0) + 8);
    const right = Math.min(p.right, (view?.offsetLeft ?? 0) + (view?.width ?? win.innerWidth)) - 8;
    const width = Math.max(0, Math.min(500, right - leftBound));
    const top = Math.max((view?.offsetTop ?? 0) + 8, h.bottom + 4);
    const values = {
      "--bb-activity-left": Math.max(leftBound, Math.min(anchor.getBoundingClientRect().right - width, right - width)) + "px",
      "--bb-activity-top": top + "px", "--bb-activity-width": width + "px",
      "--bb-activity-height": Math.max(44, Math.min(p.bottom, (view?.offsetTop ?? 0) + (view?.height ?? win.innerHeight)) - top - 8) + "px",
    };
    for (const [key, value] of Object.entries(values)) if (section.style.getPropertyValue(key) !== value) section.style.setProperty(key, value);
  };
  const update = () => {
    if (disposed) return;
    const next = Array.from(pane.querySelectorAll<HTMLElement>(sectionSelector)).find(card =>
      card.querySelector(toggleSelector) ||
      Array.from(card.querySelectorAll("div[aria-label]")).some(row =>
        row.querySelector('[data-icon="Terminal"],[data-icon="UserRoundPlus"]'))
    ) ?? null;
    if (next !== section) {
      restore(); section = next; open = false;
      originalId = section?.getAttribute("id") ?? null;
      if (section && !section.id) section.id = "bb-background-activity-" + ++sequence;
    }
    if (!section || !anchor.closest("header")) {
      restore(); section = null;
      if (last !== "null") { last = "null"; onChange(null); }
      return;
    }
    section.setAttribute("data-bb-activity-card", "");
    const expanded = String(open);
    if (section.getAttribute("data-bb-activity-open") !== expanded) section.setAttribute("data-bb-activity-open", expanded);
    const label = section.querySelector<HTMLElement>(toggleSelector + ",div[aria-label]")?.getAttribute("aria-label")
      || section.getAttribute("aria-label") || "Background activity";
    const snapshot = { label, expanded: open, controlsId: section.id };
    const serialized = JSON.stringify(snapshot);
    if (last !== serialized) { last = serialized; onChange(snapshot); }
    position();
  };
  const schedule = () => { if (!disposed && !queued) { queued = true; queueMicrotask(() => { queued = false; update(); }); } };
  const observer = new win.MutationObserver(schedule);
  observer.observe(pane, { subtree: true, childList: true, characterData: true });
  const resize = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(position) : null;
  resize?.observe(pane); resize?.observe(anchor);
  const close = (focus: boolean) => { if (!open) return; open = false; update(); if (focus) anchor.querySelector("button")?.focus(); };
  const outside = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof win.Element) || anchor.contains(target) || section?.contains(target) ||
      target.closest('[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]')) return;
    close(false);
  };
  const keydown = (event: KeyboardEvent) => {
    const target = event.target;
    if (event.key !== "Escape" || !open || !(target instanceof win.Element) || !pane.contains(target) ||
      target.closest('[role="dialog"],[role="menu"],[role="listbox"]')) return;
    event.preventDefault(); event.stopPropagation(); close(true);
  };
  doc.addEventListener("pointerdown", outside, true); doc.addEventListener("keydown", keydown, true);
  win.addEventListener("resize", position); win.visualViewport?.addEventListener("resize", position);
  win.visualViewport?.addEventListener("scroll", position);
  update();
  return {
    toggle() {
      if (disposed || !section) return;
      open = !open;
      if (open) {
        const native = section.querySelector<HTMLButtonElement>(toggleSelector);
        // This native control expands descriptions only; it never runs or stops a command.
        if (native?.getAttribute("aria-expanded") === "false" && !native.disabled) native.click();
      }
      update();
    },
    dispose() {
      if (disposed) return; disposed = true;
      observer.disconnect(); resize?.disconnect();
      doc.removeEventListener("pointerdown", outside, true); doc.removeEventListener("keydown", keydown, true);
      win.removeEventListener("resize", position); win.visualViewport?.removeEventListener("resize", position);
      win.visualViewport?.removeEventListener("scroll", position); restore();
    },
  };
}

/** Use BB's disclosure state once per queue; user expansion and editors are left alone. */
export function mountCompactQueue(signal?: AbortSignal, doc: Document = document) {
  if (signal?.aborted) return () => {};
  const win = doc.defaultView!;
  const seen = new WeakMap<HTMLButtonElement, string>();
  const shownErrors = new WeakSet<Element>();
  let disposed = false, queued = false;
  const update = () => {
    if (disposed) return;
    for (const header of Array.from(doc.querySelectorAll<HTMLElement>("[data-queued-messages-mode]"))) {
      const trigger = header.querySelector<HTMLButtonElement>("button[aria-controls][aria-expanded]");
      if (!trigger || trigger.disabled) continue;
      const key = trigger.getAttribute("aria-controls")!;
      const card = header.closest("section");
      if (!card || card.querySelector("[data-queued-message-inline-editor]")) continue;
      const failure = card.querySelector("[data-queued-message-failed]");
      if (failure) {
        seen.set(trigger, key);
        if (!shownErrors.has(failure)) {
          shownErrors.add(failure);
          if (trigger.getAttribute("aria-expanded") === "false") trigger.click();
        }
        continue;
      }
      if (seen.get(trigger) === key) continue;
      seen.set(trigger, key);
      if (trigger.getAttribute("aria-expanded") === "true") trigger.click();
    }
  };
  const observer = new win.MutationObserver(() => {
    if (queued || disposed) return;
    queued = true; queueMicrotask(() => { queued = false; update(); });
  });
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["aria-expanded", "data-queued-messages-mode", "data-queued-message-failed"] });
  const dispose = () => { if (disposed) return; disposed = true; observer.disconnect(); signal?.removeEventListener("abort", dispose); };
  signal?.addEventListener("abort", dispose, { once: true }); update();
  return dispose;
}
