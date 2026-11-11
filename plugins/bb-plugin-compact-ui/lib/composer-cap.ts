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

function enforce(form: Element, win: Window): void {
  const scroll = form.querySelector(EDITOR_SCROLL) as HTMLElement | null;
  if (!scroll) return;
  const cap = capPx(win);
  /* The queue panel may sit outside the form element itself; look just past it. */
  const queue = (form.querySelector(QUEUE_SCROLL) ??
    form.parentElement?.querySelector(QUEUE_SCROLL) ??
    null) as HTMLElement | null;
  if (queue) {
    queueObserver?.(queue);
    const rows = queue.querySelectorAll(QUEUE_ITEM);
    const frame = queue.closest(QUEUE_FRAME) as HTMLElement | null;
    /* A collapsed panel stays mounted with a zero-height viewport — clamping it
       would resurrect it; an empty one has nothing to bound. */
    if (queue.getBoundingClientRect().height === 0 || rows.length === 0) {
      queue.style.maxHeight = "";
      if (frame) frame.style.maxHeight = "";
    } else {
      /* Exact height of the first min(N,3) rows including inter-row gaps —
         measured, not multiplied. The scroll element carries its own vertical
         padding (host: pt-1 pb-3); omitting it clips the last visible row. */
      const k = Math.min(rows.length, MAX_QUEUE_ROWS);
      const queueMax = Math.ceil(
        rows[k - 1].getBoundingClientRect().bottom -
          rows[0].getBoundingClientRect().top +
          padY(queue) +
          padY(rows[0].parentElement ?? queue),
      );
      queue.style.maxHeight = `${queueMax}px`;
      if (frame) frame.style.maxHeight = `${queueMax + Math.ceil(padY(frame))}px`;
    }
  }
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
  mo.observe(doc.documentElement, { subtree: true, childList: true });
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
