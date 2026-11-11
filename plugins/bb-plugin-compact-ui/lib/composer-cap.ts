/**
 * Composer height cap: the whole promptbox (text + attachments + toolbar) stays
 * under 1/3 of the working area. The editor scroll region absorbs the overflow,
 * so the toolbar and attachment row are never clipped. The card is anchored on
 * [data-app-composer] — the 0.49 composer is a div, not a <form>. The expanded queued-
 * messages panel shows exactly min(count, MAX_QUEUE_ROWS) rows and scrolls
 * beyond that — one row at a time is unreadable, an unbounded list eats the
 * conversation.
 */
export const COMPOSER_CAP_STYLE_ID = "bb-plugin-compact-ui-composer-cap";

const PROMPTBOX = "[data-app-composer]";
const EDITOR_SCROLL = "div.overflow-y-auto:has(.ProseMirror)";
/** Queued-messages panel's own scroll region (host marks it). */
const QUEUE_SCROLL = "[data-queued-messages-scroll]";
const QUEUE_FRAME = "[data-queued-messages-scroll-frame]";
/** Every visible queue item is an <li> inside ul.group/queue — message rows,
     inline editors, notices; only the zero-height group dividers are skipped. */
const QUEUE_ITEM = "ul > li:not([data-queued-message-group-divider])";
/** App chrome outside the conversation working area: page header + status bar. */
const OUTER_CHROME_PX = 96;
/** BB's own composer ceiling when content is short. */
const BB_EDITOR_CEILING_PX = 312;
/** BB sets inline min-height ~103px on the scroll area; do not fight below it. */
const MIN_EDITOR_PX = 104;
/** Expanded queue shows at most this many rows; the rest scroll. */
const MAX_QUEUE_ROWS = 3;

function padY(el: Element): number {
  const cs = getComputedStyle(el);
  return (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
}

function capPx(win: Window): number {
  return Math.max(120, Math.floor((win.innerHeight - OUTER_CHROME_PX) / 3));
}

let queueObserver: ((queue: Element) => void) | undefined;
const pendingRetry = new WeakSet<Element>();
/* Ancestors we grew last pass — cleared before each enforce so stale
   min-heights cannot linger when the queue shrinks or collapses. */
const grownAncestors = new Set<HTMLElement>();

export function enforce(form: Element, win: Window, retry = true): void {
  const dbgEl = form.ownerDocument.documentElement;
  const dbg = JSON.parse(dbgEl.dataset.capDebug || "{}");
  dbg.runs = (dbg.runs ?? 0) + 1;
  dbg.ts = Date.now();
  /* BB 0.49 no longer wraps the editor in div.overflow-y-auto — fall back to
     the ProseMirror's own scrollable ancestor, then the element itself. */
  const pm = form.querySelector(".ProseMirror") as HTMLElement | null;
  /* BB 0.49 dropped the div.overflow-y-auto editor wrapper — find the real
     scrollable ancestor of the ProseMirror by computed overflow instead. */
  let pmScroll: HTMLElement | null = null;
  for (let el = pm?.parentElement; el && el !== form; el = el.parentElement) {
    const ov = getComputedStyle(el).overflowY;
    if (ov === "auto" || ov === "scroll") { pmScroll = el as HTMLElement; break; }
  }
  const scroll = (form.querySelector(EDITOR_SCROLL) ?? pmScroll ?? pm) as HTMLElement | null;
  dbg.editor = scroll ? scroll.tagName + "." + (scroll.className?.toString?.().split(" ")[0] ?? "") : null;
  dbgEl.dataset.capDebug = JSON.stringify(dbg);
  const cap = capPx(win);
  /* The queue panel may sit outside the form element itself; look just past it.
     bb keeps detached/hidden composer copies mounted — a collapsed stale queue
     sorts first in document order and measures zero; prefer a visible one. */
  const pick = (list: Element[]) => {
    const live = list.filter((q) => q.isConnected) as HTMLElement[];
    return live.find((q) => q.getBoundingClientRect().height > 0) ?? live[0];
  };
  const queue =
    pick(Array.from(form.querySelectorAll(QUEUE_SCROLL))) ??
    pick(Array.from(form.parentElement?.querySelectorAll(QUEUE_SCROLL) ?? [])) ??
    null;
  if (queue) {
    dbg.queueSeen = (dbg.queueSeen ?? 0) + 1;
    dbgEl.dataset.capDebug = JSON.stringify(dbg);
    queueObserver?.(queue);
    const rows = Array.from(queue.querySelectorAll(QUEUE_ITEM));
    const dbg2 = JSON.parse(dbgEl.dataset.capDebug || "{}");
    dbg2.queueH = Math.round(queue.getBoundingClientRect().height);
    dbg2.rows = rows.length;
    dbgEl.dataset.capDebug = JSON.stringify(dbg2);
    /* Row text (markdown/async content) grows after mount; watching each row
       and re-measuring once on a timer keeps the clamp from freezing small. */
    rows.forEach((r) => queueObserver?.(r));
    const frame = queue.closest(QUEUE_FRAME) as HTMLElement | null;
    /* A collapsed panel stays mounted with a zero-height viewport — clamping it
       would resurrect it; an empty one has nothing to bound. */
    for (const el of grownAncestors) el.style.minHeight = "";
    grownAncestors.clear();
    if (queue.getBoundingClientRect().height === 0 || rows.length === 0) {
      queue.style.maxHeight = "";
      if (frame) frame.style.maxHeight = "";
    } else {
      /* Exact height of the first min(N,3) rows including inter-row gaps —
         measured, not multiplied. The scroll element carries its own vertical
         padding (host: pt-1 pb-3); omitting it clips the last visible row. */
      const k = Math.min(rows.length, MAX_QUEUE_ROWS);
      /* For up-to-three rows the scroll's own content height is the exact
         bound (padding included); beyond three, measure the first-k span. */
      const measured = Math.ceil(
        rows[k - 1].getBoundingClientRect().bottom -
          rows[0].getBoundingClientRect().top +
          padY(queue) +
          padY(rows[0].parentElement ?? queue),
      );
      const queueMax = rows.length <= MAX_QUEUE_ROWS
        ? Math.max(measured, Math.ceil(queue.scrollHeight))
        : measured;
      const roomBefore = queue.getBoundingClientRect().height;
      queue.style.maxHeight = `${queueMax}px`;
      if (frame) frame.style.maxHeight = `${queueMax + Math.ceil(padY(frame))}px`;
      /* The frame is flex-1 inside the queue panel: when the panel's own
         height is host-budgeted, extra max-height on the scroll just clips.
         Grow every ancestor up to the composer card by the missing delta so
         the space is actually granted. */
      const delta = queueMax - roomBefore;
      if (delta > 1) {
        let el = (frame ?? queue).parentElement;
        while (el && el !== form && el !== form.ownerDocument.documentElement) {
          const h = el as HTMLElement;
          h.style.minHeight = `${Math.ceil(h.getBoundingClientRect().height + delta)}px`;
          grownAncestors.add(h);
          el = el.parentElement;
        }
      }
      if (retry && !pendingRetry.has(form)) {
        pendingRetry.add(form);
        setTimeout(() => {
          pendingRetry.delete(form);
          if (form.isConnected) enforce(form, win, false);
        }, 300);
      }
    }
  }
  if (!scroll) return;
  const formH = form.getBoundingClientRect().height;
  const cur = scroll.getBoundingClientRect().height;
  /* Height the form would have if the editor were at its natural (BB-capped) size.
     scrollHeight reports content height even while clamped, so this stays stable
     and converges instead of oscillating between capped/uncapped states. */
  const natural = formH - cur + Math.min(scroll.scrollHeight, BB_EDITOR_CEILING_PX);
  scroll.style.maxHeight = natural > cap
    ? `${Math.max(MIN_EDITOR_PX, Math.floor(cur - (formH - cap)))}px`
    : "";
}

export function mountComposerCap(
  signal?: AbortSignal,
  doc: Document = document,
  win: Window = window,
): () => void {
  if (signal?.aborted) return () => {};
  doc.documentElement.dataset.capMounted = "v5";
  const forms = new Set<Element>();
  const track = (form: Element) => {
    if (!forms.has(form)) {
      forms.add(form);
      ro?.observe(form);
    }
    enforce(form, win);
  };
  const rescan = () => doc.querySelectorAll(PROMPTBOX).forEach(track);
  const ro = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          /* An observed queue scroll resizes on expand/collapse — enforce the
             card it lives in (or the first tracked card when it sits outside). */
          const t = entry.target as Element;
          const card = t.matches(PROMPTBOX)
            ? t
            : t.closest(PROMPTBOX) ?? forms.values().next().value;
          if (card) enforce(card, win);
        }
      })
    : null;
  queueObserver = (queue) => ro?.observe(queue);
  const mo = new MutationObserver(rescan);
  mo.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "inert"],
  });
  win.addEventListener("resize", rescan);
  rescan();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    queueObserver = undefined;
    mo.disconnect();
    ro?.disconnect();
    win.removeEventListener("resize", rescan);
    signal?.removeEventListener("abort", dispose);
  };
  signal?.addEventListener("abort", dispose, { once: true });
  return dispose;
}
