/**
 * Composer height cap: the whole promptbox (text + attachments + toolbar) stays
 * under 1/3 of the working area. The editor scroll region absorbs the overflow,
 * so the toolbar and attachment row are never clipped.
 */
export const COMPOSER_CAP_STYLE_ID = "bb-plugin-compact-ui-composer-cap";

const PROMPTBOX = 'form[class*="group/promptbox"]';
const EDITOR_SCROLL = "div.overflow-y-auto:has(.ProseMirror)";
/** App chrome outside the conversation working area: page header + status bar. */
const OUTER_CHROME_PX = 96;
/** BB's own composer ceiling when content is short. */
const BB_EDITOR_CEILING_PX = 312;
/** BB sets inline min-height ~103px on the scroll area; do not fight below it. */
const MIN_EDITOR_PX = 104;

function capPx(win: Window): number {
  return Math.max(120, Math.floor((win.innerHeight - OUTER_CHROME_PX) / 3));
}

function enforce(form: Element, win: Window): void {
  const scroll = form.querySelector(EDITOR_SCROLL) as HTMLElement | null;
  if (!scroll) return;
  const cap = capPx(win);
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
        for (const entry of entries) enforce(entry.target, win);
      })
    : null;
  const mo = new MutationObserver(rescan);
  mo.observe(doc.documentElement, { subtree: true, childList: true });
  win.addEventListener("resize", rescan);
  rescan();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    mo.disconnect();
    ro?.disconnect();
    win.removeEventListener("resize", rescan);
    signal?.removeEventListener("abort", dispose);
  };
  signal?.addEventListener("abort", dispose, { once: true });
  return dispose;
}
