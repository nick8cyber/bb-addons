/**
 * DOM Observer: Detects model picker popovers in BB, injects star buttons,
 * and pins favorite models to the top of the list.
 *
 * Pinning is clone-based: the original option rows are never moved, removed
 * or reordered, so BB's keyboard navigation (its own navRows/index ids) keeps
 * walking the untouched DOM order. The pinned section only holds copies that
 * forward clicks to their originals — native handlers still apply the exact
 * `option.value` of the row they belong to.
 */

import {
  cleanModelText,
  getState,
  isFavorite,
  toggleFavorite,
  subscribe,
} from "./favorites-manager.js";
import { normalizeProviderId } from "./store.js";

export { normalizeProviderId };

const STAR_FILLED_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#f59e0b" style="width:14px;height:14px;filter:drop-shadow(0 1px 2px rgba(245,158,11,0.3));">
  <path fill-rule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z" clip-rule="evenodd" />
</svg>
`;

const STAR_OUTLINE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;">
  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
</svg>
`;

/** BB marks each composer root with this attribute (primary vs secondary). */
const COMPOSER_ROOT_SELECTOR = "[data-app-composer-role]";
/** BB's trigger carries aria-label "Provider, model and reasoning (<shortcut>)". */
const MODEL_TRIGGER_SELECTOR = 'button[aria-label*="Provider, model" i]';
const POPOVER_SELECTOR =
  '[role="listbox"], [data-radix-popover-content], [data-radix-popper-content-wrapper]';
const OPTION_SELECTOR = 'button[role="option"], button[id*="-opt-"]';
const MODEL_SEARCH_SELECTOR =
  'input[placeholder*="model" i], input[aria-label*="model" i]';

let observer: MutationObserver | null = null;
let isReordering = false;
// Window during which DOM writes performed by this plugin are ignored by the
// observer, preventing feedback loops (our own star injections / pinning).
let suppressUntil = 0;
let suppressFlushTimer: ReturnType<typeof setTimeout> | null = null;
let dirtyDuringSuppress = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Original inline widths of poppers we widened, restored on dispose. */
const widenedPoppers = new Map<HTMLElement, { width: string; minWidth: string; maxWidth: string }>();

function suppress(): void {
  suppressUntil = Date.now() + 150;
}

function armSuppressFlush(): void {
  if (suppressFlushTimer) return;
  suppressFlushTimer = setTimeout(
    () => {
      suppressFlushTimer = null;
      if (dirtyDuringSuppress) {
        dirtyDuringSuppress = false;
        scheduleRefresh();
      }
    },
    Math.max(1, suppressUntil - Date.now() + 5)
  );
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    suppress();
    refreshAllOpenPickers();
  }, 80);
}

/**
 * External mutations arriving inside our own write window used to be dropped
 * entirely (M7): BB updating rows in that span stayed invisible until the
 * next DOM change. Now they arm a trailing refresh instead.
 */
function noteExternalMutation(): void {
  if (Date.now() < suppressUntil) {
    dirtyDuringSuppress = true;
    armSuppressFlush();
    return;
  }
  scheduleRefresh();
}

function isPluginNode(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    (node.classList.contains("bb-fav-star-btn") ||
      node.classList.contains("bb-fav-section-badge") ||
      node.classList.contains("bb-fav-divider") ||
      node.classList.contains("bb-fav-pin-section") ||
      node.hasAttribute("data-bb-fav-clone") ||
      !!node.closest(".bb-fav-pin-section"))
  );
}

export function initDomObserver(): () => void {
  // Listen for state changes (e.g. user toggles a favorite in settings or via star)
  const unsubscribeState = subscribe((_state) => {
    suppress();
    refreshAllOpenPickers();
  });

  observer = new MutationObserver((mutations) => {
    if (isReordering) return;

    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        const changed = [...mutation.addedNodes, ...mutation.removedNodes];
        if (changed.some((node) => node instanceof HTMLElement && !isPluginNode(node))) {
          noteExternalMutation();
          return;
        }
      } else if (mutation.type === "attributes") {
        // React reuses row nodes: attribute swaps (id/title/aria) without a
        // childList change still mean the row now names a different model.
        const target = mutation.target;
        if (target instanceof HTMLElement && !isPluginNode(target)) {
          noteExternalMutation();
          return;
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["id", "title", "aria-label", "aria-selected", "data-state"],
  });

  // Initial check on existing DOM
  for (const c of pickPickerContainers(document.body)) {
    enhanceModelPickerContainer(c);
  }

  return () => {
    unsubscribeState();
    cancelPendingSwitch();
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (suppressFlushTimer) {
      clearTimeout(suppressFlushTimer);
      suppressFlushTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    restoreDom();
  };
}

/** Undo every DOM change we made: stars, pinned clone sections, widths (M6). */
function restoreDom(): void {
  isReordering = true;
  try {
    for (const el of document.querySelectorAll(
      ".bb-fav-pin-section, .bb-fav-star-btn, .bb-fav-section-badge, .bb-fav-divider"
    )) {
      el.remove();
    }
    for (const row of document.querySelectorAll<HTMLElement>(".bb-fav-row-starred")) {
      row.classList.remove("bb-fav-row-starred");
    }
    for (const [popper, prev] of widenedPoppers) {
      popper.style.width = prev.width;
      popper.style.minWidth = prev.minWidth;
      popper.style.maxWidth = prev.maxWidth;
      delete popper.dataset.favWidened;
    }
    widenedPoppers.clear();
  } finally {
    isReordering = false;
  }
}

/**
 * A container counts as a model picker only when it carries BB's model
 * search field or BB's index-based option ids — bare Radix popovers and
 * listboxes elsewhere must stay untouched (M6).
 */
function isModelPickerContainer(el: HTMLElement): boolean {
  if (el.closest(".bb-fav-pin-section")) return false;
  if (el.querySelector(MODEL_SEARCH_SELECTOR)) return true;
  return !!el.querySelector('button[role="option"][id*="-opt-"]');
}

/** Deepest qualifying containers only — no wrapper+inner double-processing. */
function pickPickerContainers(root: HTMLElement): HTMLElement[] {
  const candidates: HTMLElement[] = [];
  if (root.matches?.(POPOVER_SELECTOR) && isModelPickerContainer(root)) {
    candidates.push(root);
  }
  for (const el of root.querySelectorAll<HTMLElement>(POPOVER_SELECTOR)) {
    if (isModelPickerContainer(el)) candidates.push(el);
  }
  return candidates.filter(
    (c) => !candidates.some((other) => other !== c && c.contains(other))
  );
}

function refreshAllOpenPickers(): void {
  for (const c of pickPickerContainers(document.body)) {
    enhanceModelPickerContainer(c);
  }
}

function providerTabs(popover: HTMLElement): HTMLButtonElement[] {
  const strips = popover.querySelectorAll("div.border-b, div.flex.items-center");
  const tabs: HTMLButtonElement[] = [];
  for (const strip of strips) {
    for (const b of strip.querySelectorAll<HTMLButtonElement>("button[title]")) {
      // Injected stars carry a title and no role="option" — they must never
      // be mistaken for provider tabs (M2).
      if (
        b.getAttribute("role") === "option" ||
        b.classList.contains("bb-fav-star-btn") ||
        b.hasAttribute("data-bb-fav-star") ||
        b.hasAttribute("data-bb-fav-clone") ||
        b.closest(".bb-fav-pin-section") ||
        b.closest('button[role="option"]')
      ) {
        continue;
      }
      const t = (b.getAttribute("title") || b.textContent || "").trim();
      if (t !== "" && !t.includes("/") && !t.includes("·") && !tabs.includes(b)) {
        tabs.push(b);
      }
    }
  }
  return tabs;
}

function tabIsActive(tab: HTMLButtonElement): boolean {
  return (
    tab.className.includes("border-foreground") ||
    tab.getAttribute("data-state") === "active" ||
    tab.getAttribute("aria-selected") === "true"
  );
}

function providerFromTrigger(trigger: HTMLButtonElement): string {
  const titleElem = trigger.hasAttribute("title") ? trigger : trigger.querySelector("[title]");
  const fullTitle = titleElem?.getAttribute("title") || "";
  // Format: "Provider Name: Model Name"
  if (fullTitle.includes(":")) {
    const norm = normalizeProviderId(fullTitle.split(":")[0].trim());
    if (norm !== "default") return norm;
  }
  return "default";
}

export function detectActiveProvider(container?: HTMLElement, anchor?: HTMLElement | null): string {
  // 1. Active provider tab inside THIS popover (scoped — never global).
  if (container) {
    const popover = container.closest<HTMLElement>("[data-radix-popover-content]") || container;
    const tabs = providerTabs(popover);
    const activeTab = tabs.find(tabIsActive) || tabs.find((b) => b.className.includes("text-foreground"));
    if (activeTab) {
      const title = activeTab.getAttribute("title") || activeTab.textContent?.trim();
      if (title) {
        const norm = normalizeProviderId(title);
        if (norm !== "default") return norm;
      }
    }
  }

  // 2. The trigger of OUR composer only — a document-wide lookup reads the
  // provider off whichever composer happens to come first (M4/B1).
  const triggerBtn = findModelTrigger(anchor);
  if (triggerBtn) {
    const prov = providerFromTrigger(triggerBtn);
    if (prov !== "default") return prov;
  }

  return "default";
}

function firstTextNodeText(el: HTMLElement): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node.textContent?.trim();
    if (text) return text;
    node = walker.nextNode();
  }
  return "";
}

export interface ModelOption {
  /** Full identity: cleaned title including the " · route" qualifier (B2). */
  key: string;
  /** Model name part before " · " — display + backward-compat matching. */
  modelId: string;
  /** Route/provider qualifier after " · ", when present. */
  route?: string;
  /** Display label (the full key so alternate routes stay distinguishable). */
  label: string;
}

export function extractModelOption(btn: HTMLButtonElement): ModelOption {
  const truncateSpan = btn.querySelector<HTMLElement>("span.truncate, span[title]");
  let fullTitle =
    truncateSpan?.getAttribute("title") ||
    (truncateSpan ? firstTextNodeText(truncateSpan) : "") ||
    btn.getAttribute("aria-label") ||
    btn.textContent ||
    "";
  fullTitle = cleanModelText(fullTitle.trim());

  let modelId = fullTitle;
  let route: string | undefined;
  if (fullTitle.includes(" · ")) {
    const [head, ...rest] = fullTitle.split(" · ");
    modelId = head.trim();
    route = rest.join(" · ").trim() || undefined;
  }

  const btnId = btn.getAttribute("id") || "";
  let key = fullTitle;
  if (!key && btnId) {
    key = btnId;
    modelId = btnId;
  }

  return { key, modelId, route, label: key };
}

function isToggleRow(btn: HTMLButtonElement): boolean {
  const id = btn.getAttribute("id") || "";
  const text = (btn.textContent || "").trim();
  return (
    id.includes("more-toggle") ||
    id.includes("fewer") ||
    text.startsWith("More models") ||
    text.startsWith("Fewer models")
  );
}

function scanOptions(popover: HTMLElement): HTMLButtonElement[] {
  return Array.from(popover.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR)).filter(
    (b) => !b.hasAttribute("data-bb-fav-clone") && !b.closest(".bb-fav-pin-section") && !isToggleRow(b)
  );
}

interface EnhancedRow {
  btn: HTMLButtonElement;
  opt: ModelOption;
  favorited: boolean;
}

function enhanceModelPickerContainer(container: HTMLElement): void {
  // Our own DOM writes must not retrigger the observer
  suppress();
  const optionButtons = scanOptions(container);
  if (optionButtons.length === 0 && !container.querySelector(MODEL_SEARCH_SELECTOR)) return;

  // Widen the picker popover so model names are not squeezed by the star
  // column; original inline widths are restored on dispose (M6).
  const popper = container.closest<HTMLElement>("[data-radix-popper-content-wrapper]") || container;
  if (optionButtons.length > 0 && !popper.dataset.favWidened) {
    popper.dataset.favWidened = "true";
    widenedPoppers.set(popper, {
      width: popper.style.width,
      minWidth: popper.style.minWidth,
      maxWidth: popper.style.maxWidth,
    });
    const current = popper.getBoundingClientRect().width;
    const desired = Math.round(Math.max(current + 40, 340));
    popper.style.width = `${desired}px`;
    popper.style.minWidth = `${desired}px`;
    popper.style.maxWidth = `${desired}px`;
  }

  const listContainer = optionButtons[0]?.parentElement || null;
  const providerId = detectActiveProvider(container);
  const state = getState();

  const rows: EnhancedRow[] = [];

  isReordering = true;
  try {
    for (const btn of optionButtons) {
      const opt = extractModelOption(btn);
      if (!opt.key) continue;

      const favorited = isFavorite(providerId, opt.key) || isFavorite(providerId, opt.modelId);
      rows.push({ btn, opt, favorited });

      let starBtn = btn.querySelector<HTMLButtonElement>(".bb-fav-star-btn");
      if (!starBtn) {
        starBtn = createStarButton();
        const checkSpan = btn.querySelector<HTMLElement>("span.flex.shrink-0");
        if (checkSpan) {
          btn.insertBefore(starBtn, checkSpan);
        } else {
          btn.appendChild(starBtn);
        }
      }
      // React reuses option rows; rebind EVERY pass so the handler can never
      // act on the model a recycled row showed before (M7).
      bindStarHandler(starBtn, providerId, opt, container);
      updateStarVisual(starBtn, favorited);
    }

    if (listContainer) {
      refreshPinSection(listContainer, providerId, rows, state.pinToTop);
    }
  } finally {
    isReordering = false;
  }
}

function createStarButton(): HTMLButtonElement {
  const starBtn = document.createElement("button");
  starBtn.type = "button";
  starBtn.className = "bb-fav-star-btn";
  starBtn.setAttribute("data-bb-fav-star", "true");
  starBtn.setAttribute("role", "menuitem");
  starBtn.tabIndex = -1;

  starBtn.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    margin-left: auto;
    margin-right: 4px;
    flex-shrink: 0;
    cursor: pointer;
    border: none;
    background: transparent;
    color: currentColor;
    transition: all 0.15s ease;
    z-index: 10;
  `;

  // Prevent option selection on click
  const stopEvents = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  starBtn.addEventListener("pointerdown", stopEvents);
  starBtn.addEventListener("mousedown", stopEvents);
  starBtn.addEventListener("mouseup", stopEvents);
  return starBtn;
}

function bindStarHandler(
  starBtn: HTMLButtonElement,
  providerId: string,
  opt: ModelOption,
  container: HTMLElement
): void {
  // Plain onclick: reassignment replaces the stale closure outright.
  starBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    updateStarVisual(starBtn, !isFavorite(providerId, opt.key));
    void toggleFavorite(providerId, opt.key, opt.label).then(() => {
      updateStarVisual(starBtn, isFavorite(providerId, opt.key) || isFavorite(providerId, opt.modelId));
    });
    if (getState().pinToTop) {
      setTimeout(() => enhanceModelPickerContainer(container), 10);
    }
  };
}

function updateStarVisual(starBtn: HTMLButtonElement, favorited: boolean): void {
  starBtn.innerHTML = favorited ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
  starBtn.title = favorited ? "В избранном (нажмите, чтобы убрать)" : "Добавить в избранное";
  starBtn.style.opacity = favorited ? "1" : "0.45";
  starBtn.style.color = favorited ? "#f59e0b" : "currentColor";

  const row = starBtn.closest<HTMLButtonElement>("button");
  if (row && !row.hasAttribute("data-bb-fav-clone")) {
    row.classList.toggle("bb-fav-row-starred", favorited);
  }
}

/**
 * Rebuild the pinned section from favorites. It contains CLONES only: real
 * option rows keep their DOM positions, so BB's navRows/index-id keyboard
 * order stays aligned with what the user sees (M5/M6). Removing the section
 * is the whole "unpin" path — there is no order to restore.
 */
function refreshPinSection(
  listContainer: HTMLElement,
  providerId: string,
  rows: EnhancedRow[],
  pinToTop: boolean
): void {
  const existing = listContainer.querySelector<HTMLElement>(":scope > .bb-fav-pin-section");
  const favRows = rows.filter((r) => r.favorited);

  if (!pinToTop || favRows.length === 0) {
    existing?.remove();
    return;
  }

  const section = document.createElement("div");
  section.className = "bb-fav-pin-section";
  section.setAttribute("data-bb-fav-pin", "true");

  const favHeader = document.createElement("div");
  favHeader.className =
    "bb-fav-section-badge flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-2xs font-semibold uppercase tracking-wider text-amber-500/90 dark:text-amber-400 select-none";
  favHeader.innerHTML = `
    <span style="display:inline-flex;align-items:center;gap:4px;">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#f59e0b" style="width:12px;height:12px;">
        <path fill-rule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z" clip-rule="evenodd" />
      </svg>
      <span>Избранные модели</span>
    </span>
  `;
  section.appendChild(favHeader);

  for (const { btn, opt } of favRows) {
    section.appendChild(buildCloneRow(btn, providerId, opt));
  }

  const divider = document.createElement("div");
  divider.className = "bb-fav-divider border-t border-border/70 my-1 mx-1.5";
  section.appendChild(divider);

  if (existing) {
    existing.replaceWith(section);
  } else {
    listContainer.insertBefore(section, listContainer.firstElementChild);
  }
}

function buildCloneRow(
  orig: HTMLButtonElement,
  providerId: string,
  opt: ModelOption
): HTMLButtonElement {
  const clone = orig.cloneNode(true) as HTMLButtonElement;
  clone.removeAttribute("id");
  clone.setAttribute("role", "menuitem");
  clone.setAttribute("data-bb-fav-clone", "true");
  clone.tabIndex = -1;
  // Duplicated BB index ids would confuse both our scans and any
  // id-keyed host logic.
  for (const d of clone.querySelectorAll<HTMLElement>("[id]")) {
    d.removeAttribute("id");
  }

  // The clone's copied star is re-bound: it toggles the same favorite and
  // must not forward into the original's click.
  const star = clone.querySelector<HTMLButtonElement>(".bb-fav-star-btn");
  if (star) {
    star.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      updateStarVisual(star, !isFavorite(providerId, opt.key));
      void toggleFavorite(providerId, opt.key, opt.label);
    };
    updateStarVisual(star, true);
  }

  clone.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Native handlers live on the ORIGINAL row and apply its own
    // option.value — the exact route this clone was copied from (B2).
    orig.click();
  });
  return clone;
}

/** Popover owned by THIS trigger via Radix's aria-controls wiring (B1). */
function findOwnedPopover(trigger: HTMLButtonElement): HTMLElement | null {
  const id = trigger.getAttribute("aria-controls");
  if (!id) return null;
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement) || !el.isConnected) return null;
  // The controlled element may be the popper wrapper or the content itself;
  // either way it must look like an overlay, not some other controlled part.
  if (el.matches(POPOVER_SELECTOR) || el.querySelector(POPOVER_SELECTOR)) {
    return el.matches(POPOVER_SELECTOR) ? el : el.querySelector<HTMLElement>(POPOVER_SELECTOR);
  }
  return el;
}

function findModelTrigger(anchor?: HTMLElement | null): HTMLButtonElement | null {
  // Scope strictly to the composer the caller lives in: several composers
  // (thread, side chat, queued message) can be mounted at once and a bare
  // document.querySelector would drive whichever comes first (B1). No
  // document fallback — if this composer has no trigger, we say so.
  const root = anchor?.closest<HTMLElement>(COMPOSER_ROOT_SELECTOR) ?? null;
  return root?.querySelector<HTMLButtonElement>(MODEL_TRIGGER_SELECTOR) ?? null;
}

/**
 * Open the native BB composer model picker popover.
 */
export function openNativeModelPicker(anchor?: HTMLElement | null): void {
  const triggerBtn = findModelTrigger(anchor);
  if (!triggerBtn || triggerBtn.disabled || triggerBtn.getAttribute("aria-disabled") === "true") {
    return;
  }
  // Only click when OUR popover is not already open — a foreign composer's
  // open listbox must not suppress (or be hijacked for) this one.
  if (!findOwnedPopover(triggerBtn)) {
    triggerBtn.click();
  }
}

/**
 * Fast programmatic model switcher:
 * Opens the composer's model picker, clicks the matching model option, and closes it.
 */
export type SwitchFailure =
  | "no-trigger"
  | "trigger-disabled"
  | "no-popover"
  | "provider-tab-missing"
  | "model-not-found"
  | "unconfirmed"
  | "cancelled";

export interface SwitchResult {
  ok: boolean;
  reason?: SwitchFailure;
}

/**
 * Generation guard (B3): every new switch invalidates the polls of the
 * previous one, and `cancelPendingSwitch()` does the same on unmount or a
 * context change, so a stale loop can never click into a menu that appeared
 * after the user's intent changed.
 */
let switchGen = 0;
export function cancelPendingSwitch(): void {
  switchGen++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function switchComposerModel(
  modelId: string,
  providerId?: string,
  anchor?: HTMLElement | null
): Promise<SwitchResult> {
  const gen = ++switchGen;
  const triggerBtn = findModelTrigger(anchor);
  if (!triggerBtn) return { ok: false, reason: "no-trigger" };
  // BB disables the trigger while the model is locked (e.g. mid-run); a click
  // on a disabled button is silently swallowed, so report it instead.
  if (triggerBtn.disabled || triggerBtn.getAttribute("aria-disabled") === "true") {
    return { ok: false, reason: "trigger-disabled" };
  }

  const alive = () => gen === switchGen && triggerBtn.isConnected;

  if (!findOwnedPopover(triggerBtn)) {
    triggerBtn.click();
  }

  // Wait for THIS trigger's popover — a listbox already open for another
  // composer is ignored, not adopted (B1).
  let popover: HTMLElement | null = null;
  for (let i = 0; i < 40 && alive(); i++) {
    popover = findOwnedPopover(triggerBtn);
    if (popover) break;
    await sleep(25);
  }
  if (!alive()) return { ok: false, reason: "cancelled" };
  if (!popover) return { ok: false, reason: "no-popover" };

  // Provider tabs render only when the composer offers more than one provider.
  const wantProvider = providerId ? normalizeProviderId(providerId) : null;
  if (wantProvider) {
    let tabs = providerTabs(popover);
    let target = tabs.find((tab) => normalizeProviderId(tab.getAttribute("title") || "") === wantProvider);
    if (target) {
      if (!tabIsActive(target)) {
        target.click();
        // The tab's list re-renders asynchronously: rows from the PREVIOUS
        // provider are still clickable until the new tab shows active, so we
        // must wait for that signal before matching anything (B3).
        for (let i = 0; i < 40 && alive(); i++) {
          const live = findOwnedPopover(triggerBtn) || popover;
          tabs = providerTabs(live);
          const fresh = tabs.find(
            (tab) => normalizeProviderId(tab.getAttribute("title") || "") === wantProvider
          );
          if (fresh) target = fresh;
          if (tabIsActive(target)) break;
          await sleep(25);
        }
        if (!alive()) return { ok: false, reason: "cancelled" };
        if (!tabIsActive(target)) return { ok: false, reason: "provider-tab-missing" };
      }
    } else if (tabs.length > 0) {
      return { ok: false, reason: "provider-tab-missing" };
    } else {
      // Single-provider picker: nothing to click, but still verify the
      // composer's actual provider against the requested one (M2).
      const actual = providerFromTrigger(triggerBtn);
      if (actual !== "default" && actual !== wantProvider) {
        return { ok: false, reason: "provider-tab-missing" };
      }
    }
  }

  // Find the option. Poll: the list itself may still be loading, the tab
  // switch re-renders it, and "More models"/search may have to reveal it (M3).
  let expandedMore = false;
  let searched = false;
  for (let i = 0; i < 40 && alive(); i++) {
    const live = findOwnedPopover(triggerBtn);
    if (!live) {
      await sleep(25);
      continue;
    }
    popover = live;

    for (const opt of scanOptions(popover)) {
      const ex = extractModelOption(opt);
      if (ex.key !== modelId && ex.modelId !== modelId) continue;
      if (opt.disabled || opt.getAttribute("aria-disabled") === "true") {
        // A disabled row cannot apply anything — keep scanning instead of
        // reporting a click that did nothing (M1).
        continue;
      }
      opt.click();
      return await confirmSwitch(alive, triggerBtn, live, ex);
    }

    if (!expandedMore) {
      const more = Array.from(popover.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) =>
          !b.hasAttribute("data-bb-fav-clone") &&
          !b.closest(".bb-fav-pin-section") &&
          ((b.getAttribute("id") || "").includes("more-toggle") ||
            (b.textContent || "").trim().startsWith("More models"))
      );
      if (more) {
        expandedMore = true;
        more.click();
        continue;
      }
    }

    if (!searched) {
      const input = popover.querySelector<HTMLInputElement>(MODEL_SEARCH_SELECTOR);
      if (input) {
        searched = true;
        setNativeInputValue(input, modelId.split(" · ")[0]);
        continue;
      }
    }

    await sleep(25);
  }

  if (!alive()) return { ok: false, reason: "cancelled" };
  return { ok: false, reason: "model-not-found" };
}

/**
 * After the option click, prove the switch actually happened before claiming
 * success (M1): the owned popover closing, or the trigger reporting the new
 * model, counts. An unconfirmed attempt closes our own popover and reports
 * failure instead of a false "ok".
 */
async function confirmSwitch(
  alive: () => boolean,
  triggerBtn: HTMLButtonElement,
  popover: HTMLElement,
  ex: ModelOption
): Promise<SwitchResult> {
  for (let i = 0; i < 24 && alive(); i++) {
    await sleep(25);
    if (!popover.isConnected) return { ok: true };
    const owned = findOwnedPopover(triggerBtn);
    if (!owned) return { ok: true };
    if (triggerShowsModel(triggerBtn, ex)) return { ok: true };
  }
  if (!alive()) return { ok: false, reason: "cancelled" };
  // Leave no orphan menu we opened behind.
  popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return { ok: false, reason: "unconfirmed" };
}

function triggerShowsModel(triggerBtn: HTMLButtonElement, ex: ModelOption): boolean {
  const titleElem = triggerBtn.hasAttribute("title") ? triggerBtn : triggerBtn.querySelector("[title]");
  const fullTitle = titleElem?.getAttribute("title") || "";
  if (!fullTitle.includes(":")) return false;
  const modelPart = cleanModelText(fullTitle.split(":").slice(1).join(":").trim());
  return modelPart === ex.modelId || modelPart === ex.key || modelPart.includes(ex.modelId);
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
