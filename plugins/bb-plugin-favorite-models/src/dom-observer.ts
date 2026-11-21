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

import { toast } from "sonner";
import {
  cleanModelText,
  getState,
  isFavorite,
  refreshFavorites,
  resolvePickerProvider,
  resolveProviderKey,
  toggleFavorite,
  subscribe,
} from "./favorites-manager.js";
import { isContextSizeTag, normalizeModelKey } from "./store.js";

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
  '[role="listbox"], [data-radix-popover-content], [data-radix-popper-content-wrapper], [role="dialog"][data-state]';
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
const enhancedSubmenus = new Set<HTMLElement>();
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
          if (mutation.attributeName === "class" && !target.matches("button.border-b-2[title]")) continue;
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
    attributeFilter: ["id", "title", "aria-label", "aria-selected", "aria-controls", "aria-expanded", "data-state", "class"],
  });

  // Initial check on existing DOM
  refreshAllOpenPickers();

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
    for (const popper of widenedPoppers.keys()) restorePopperWidth(popper);
    enhancedSubmenus.clear();
  } finally {
    isReordering = false;
  }
}

function restorePopperWidth(popper: HTMLElement): void {
  const previous = widenedPoppers.get(popper);
  if (!previous) return;
  Object.assign(popper.style, previous);
  delete popper.dataset.favWidened;
  widenedPoppers.delete(popper);
}

/**
 * A container counts as a model picker only when it carries BB's model
 * search field or BB's index-based option ids — bare Radix popovers and
 * listboxes elsewhere must stay untouched (M6).
 */
function isModelPickerContainer(el: HTMLElement): boolean {
  if (el.closest(".bb-fav-pin-section")) return false;
  if (el.querySelector(MODEL_SEARCH_SELECTOR)) return true;
  // BB only stamps role="option" on rows when the search box is rendered
  // (>5 models); short pickers carry bare `…-opt-N` ids, so the id — not
  // the role — is the reliable marker.
  return !!el.querySelector('button[id*="-opt-"]') ||
    (findMoreSubmenus(el).length > 0 && findOwnerTrigger(el) !== null);
}

/**
 * The element we treat as "the popover" is the whole content node — the
 * thing aria-controls points at — so provider tabs and the search field
 * (which sit OUTSIDE the inner listbox) stay reachable. A bare inner
 * listbox is never the container.
 */
function popoverRoot(el: HTMLElement): HTMLElement {
  const wrapper = el.matches?.("[data-radix-popper-content-wrapper]")
    ? el
    : el.closest<HTMLElement>("[data-radix-popper-content-wrapper]");
  if (wrapper) {
    for (const child of wrapper.children) {
      if (child instanceof HTMLElement && (child === el || child.contains(el))) {
        return child;
      }
    }
    return wrapper;
  }
  return el.closest<HTMLElement>("[data-radix-popover-content]") ?? el;
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
  const deepest = candidates.filter(
    (c) => !candidates.some((other) => other !== c && c.contains(other))
  );
  const roots: HTMLElement[] = [];
  for (const c of deepest) {
    const r = popoverRoot(c);
    if (!roots.includes(r)) roots.push(r);
  }
  return roots;
}

function refreshAllOpenPickers(): void {
  const submenus = new Set<HTMLElement>();
  for (const container of pickPickerContainers(document.body)) {
    if (container.dataset.state === "closed") continue;
    enhanceModelPickerContainer(container, scanOptions(container), container);
    if (!findOwnerTrigger(container)) continue;
    for (const submenu of findMoreSubmenus(container)) {
      submenus.add(submenu);
      enhanceModelPickerContainer(submenu, scanPortalOptions(submenu), container);
    }
  }
  for (const old of enhancedSubmenus) {
    if (submenus.has(old)) continue;
    for (const node of old.querySelectorAll(".bb-fav-pin-section, .bb-fav-star-btn")) node.remove();
    for (const row of old.querySelectorAll(".bb-fav-row-starred")) row.classList.remove("bb-fav-row-starred");
    restorePopperWidth(old.closest<HTMLElement>("[data-radix-popper-content-wrapper]") ?? old);
  }
  enhancedSubmenus.clear();
  for (const submenu of submenus) enhancedSubmenus.add(submenu);
  for (const popper of widenedPoppers.keys()) {
    if (!popper.isConnected) restorePopperWidth(popper);
  }
}

function providerTabs(popover: HTMLElement): HTMLButtonElement[] {
  // Only the bordered strip is the provider tab bar: BB renders it as
  // `div.border-b` of `border-b-2` buttons. Option-section ToggleGroups
  // (Speed/agent options) are flex containers WITHOUT border-b and live
  // under role="radiogroup"/"toolbar" — both excluded so their
  // description-titled items are never mistaken for provider tabs.
  const strips = popover.querySelectorAll("div.border-b");
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
        b.closest('button[role="option"]') ||
        b.closest('[role="radiogroup"], [role="toolbar"]') ||
        !b.className.includes("border-b-2")
      ) {
        continue;
      }
      if (providerTabLabel(b) && !tabs.includes(b)) {
        tabs.push(b);
      }
    }
  }
  return tabs;
}

/** Provider name on a tab, without BB's " (current thread)" marker. */
function providerTabLabel(tab: HTMLButtonElement): string {
  return (tab.getAttribute("title") || tab.textContent || "")
    .trim()
    .replace(/\s*\(current thread\)\s*$/i, "")
    .trim();
}

function tabIsActive(tab: HTMLButtonElement): boolean {
  return (
    tab.className.includes("border-foreground") ||
    tab.getAttribute("data-state") === "active" ||
    tab.getAttribute("aria-selected") === "true"
  );
}

function providerLabelFromTrigger(trigger: HTMLButtonElement): string {
  const titleElem = trigger.hasAttribute("title") ? trigger : trigger.querySelector("[title]");
  const fullTitle = titleElem?.getAttribute("title") || "";
  return fullTitle.includes(":") ? fullTitle.split(":", 1)[0].trim() : "";
}

/** Match the picker to its model trigger via Radix/Vaul aria-controls. */
function findOwnerTrigger(container: HTMLElement): HTMLButtonElement | null {
  const triggers = document.querySelectorAll<HTMLButtonElement>(MODEL_TRIGGER_SELECTOR);
  for (const trigger of triggers) {
    const owned = findOwnedPopover(trigger);
    if (owned && (owned === container || owned.contains(container) || container.contains(owned))) {
      return trigger;
    }
  }
  return null;
}

function activeProviderLabel(container?: HTMLElement, anchor?: HTMLElement | null): string {
  if (container) {
    const active = providerTabs(container).find(tabIsActive);
    if (active) return providerTabLabel(active);
  }
  const owner = container ? findOwnerTrigger(container) : null;
  const trigger = owner ?? findModelTrigger(anchor);
  return trigger ? providerLabelFromTrigger(trigger) : "";
}

export function detectActiveProvider(container?: HTMLElement, anchor?: HTMLElement | null): string {
  return resolvePickerProvider(activeProviderLabel(container, anchor));
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
  const disabled = btn.disabled || btn.getAttribute("aria-disabled") === "true";
  let fullTitle: string;
  if (disabled && truncateSpan) {
    // A disabled row's title carries the disable REASON (native BB:
    // title = disabledReason ?? "label · route") — the key must come from
    // the row's own text instead.
    fullTitle = disabledRowKey(truncateSpan) || btn.textContent || "";
  } else {
    fullTitle =
      truncateSpan?.getAttribute("title") ||
      (truncateSpan ? firstTextNodeText(truncateSpan) : "") ||
      btn.getAttribute("aria-label") ||
      btn.textContent ||
      "";
  }
  fullTitle = normalizeModelKey(fullTitle);

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

/**
 * Rebuild the "label · route" key for a disabled row from its rendered
 * text: the leading text node is the label base, trailing subtitle spans
 * are the "(tag)" and then the route qualifier (title already holds the
 * reason, so it is only trusted when it echoes the label itself).
 */
function disabledRowKey(truncateSpan: HTMLElement): string {
  const base = firstTextNodeText(truncateSpan);
  const title = (truncateSpan.getAttribute("title") || "").trim();
  const subs = Array.from(truncateSpan.children)
    .map((el) => (el.textContent || "").trim())
    .filter(Boolean);
  if (!base) return subs.join(" ");
  if (title === base || title.startsWith(`${base} · `) || title.startsWith(`${base} (`)) return title;
  if (!subs.length) return base;
  const [first, second] = subs;
  if (second || isContextSizeTag(first) || /^\(.*\)$/.test(first)) {
    const tag = first.replace(/^\((.*)\)$/, "$1");
    return second ? `${base} (${tag}) · ${second}` : `${base} (${tag})`;
  }
  return `${base} · ${first}`;
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
  favorited: boolean;
}

function enhanceModelPickerContainer(
  container: HTMLElement,
  optionButtons: HTMLButtonElement[],
  providerContext: HTMLElement
): void {
  suppress();
  if (optionButtons.length === 0 && !container.querySelector(MODEL_SEARCH_SELECTOR)) return;

  // Widen the picker popover so model names are not squeezed by the star
  // column; original inline widths are restored on dispose (M6).
  const popper = container.closest<HTMLElement>("[data-radix-popper-content-wrapper]");
  if (popper && optionButtons.length > 0 && !popper.dataset.favWidened) {
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
  const providerId = detectActiveProvider(providerContext);
  const state = getState();

  const rows: EnhancedRow[] = [];

  isReordering = true;
  try {
    for (const btn of optionButtons) {
      const opt = extractModelOption(btn);
      if (!opt.key) continue;

      const favorited = isFavorite(providerId, opt.key) || isFavorite(providerId, opt.modelId);
      rows.push({ btn, favorited });

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
      bindStarHandler(starBtn, btn, providerContext);
      updateStarVisual(starBtn, favorited);
    }

    if (listContainer) {
      refreshPinSection(listContainer, providerContext, rows, state.pinToTop);
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
  star: HTMLButtonElement,
  row: HTMLButtonElement,
  providerContext: HTMLElement
): void {
  star.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const label = activeProviderLabel(providerContext);
    const option = extractModelOption(row);
    let provider = resolvePickerProvider(label);
    if (provider === "default" && label && label.toLowerCase() !== "default") {
      // The trigger may still display a raw ID while BB loads its directory.
      // Wait for verification and discard clicks whose row or tab has changed.
      await refreshFavorites();
      provider = resolvePickerProvider(label);
      if (!row.isConnected || !providerContext.isConnected || extractModelOption(row).key !== option.key) return;
      const liveLabel = activeProviderLabel(providerContext);
      if (liveLabel !== label &&
          (provider === "default" || resolvePickerProvider(liveLabel) !== provider)) return;
    }
    if (provider === "default") {
      toast.error("Провайдер не определён");
      return;
    }
    void toggleFavorite(provider, option.key, option.label);
  };
}

function updateStarVisual(starBtn: HTMLButtonElement, favorited: boolean): void {
  starBtn.innerHTML = favorited ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
  starBtn.title = favorited ? "В избранном (нажмите, чтобы убрать)" : "Добавить в избранное";
  starBtn.style.opacity = favorited ? "1" : "0.45";
  starBtn.style.color = favorited ? "#f59e0b" : "currentColor";

  const row = starBtn.parentElement?.closest<HTMLButtonElement>("button");
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
  providerContext: HTMLElement,
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

  for (const { btn } of favRows) {
    section.appendChild(buildCloneRow(btn, providerContext));
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
  providerContext: HTMLElement
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
    bindStarHandler(star, orig, providerContext);
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

/** Popover owned by THIS trigger via Radix's aria-controls wiring (B1).
 * The controlled element IS the popover — descending into an inner listbox
 * would cut off the provider tabs and the search field that live next to
 * it (review: tabs/search unreachable at >5 models). */
function findOwnedPopover(trigger: HTMLButtonElement): HTMLElement | null {
  const id = trigger.getAttribute("aria-controls");
  if (!id) return null;
  const el = document.getElementById(id);
  return el instanceof HTMLElement && el.isConnected ? el : null;
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
 * Cancellation (B3): tokens are PER TRIGGER. A new switch on the same
 * composer cancels the previous one, and `cancelPendingSwitch(anchor)`
 * cancels only that composer's loop — another composer unmounting must not
 * abort a switch the user started elsewhere. Tokens also die with their
 * trigger (`isConnected`), so a removed composer frees itself.
 */
const pendingSwitches = new Map<HTMLElement, { cancelled: boolean }>();

export function cancelPendingSwitch(anchor?: HTMLElement | null): void {
  if (anchor === undefined || anchor === null) {
    for (const token of pendingSwitches.values()) token.cancelled = true;
    return;
  }
  const trigger = findModelTrigger(anchor);
  const token = trigger ? pendingSwitches.get(trigger) : undefined;
  if (token) token.cancelled = true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function switchComposerModel(
  modelId: string,
  providerId?: string,
  anchor?: HTMLElement | null
): Promise<SwitchResult> {
  const triggerBtn = findModelTrigger(anchor);
  if (!triggerBtn) return { ok: false, reason: "no-trigger" };
  // BB disables the trigger while the model is locked (e.g. mid-run); a click
  // on a disabled button is silently swallowed, so report it instead.
  if (triggerBtn.disabled || triggerBtn.getAttribute("aria-disabled") === "true") {
    return { ok: false, reason: "trigger-disabled" };
  }

  const token = { cancelled: false };
  const prev = pendingSwitches.get(triggerBtn);
  if (prev) prev.cancelled = true;
  pendingSwitches.set(triggerBtn, token);
  const alive = () => !token.cancelled && triggerBtn.isConnected;

  try {
    return await runSwitch(modelId, providerId, triggerBtn, alive);
  } finally {
    if (pendingSwitches.get(triggerBtn) === token) pendingSwitches.delete(triggerBtn);
  }
}

async function runSwitch(
  modelId: string,
  providerId: string | undefined,
  triggerBtn: HTMLButtonElement,
  alive: () => boolean
): Promise<SwitchResult> {
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
  const closeOurPopover = () => {
    const live = findOwnedPopover(triggerBtn) || popover;
    if (live?.isConnected) {
      live.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
  };
  const wantProvider = providerId ? resolveProviderKey(providerId) : null;
  if (wantProvider) {
    let tabs = providerTabs(popover);
    let target = tabs.find((tab) => resolvePickerProvider(providerTabLabel(tab)) === wantProvider);
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
            (tab) => resolvePickerProvider(providerTabLabel(tab)) === wantProvider
          );
          if (fresh) target = fresh;
          if (tabIsActive(target)) break;
          await sleep(25);
        }
        if (!alive()) return { ok: false, reason: "cancelled" };
        if (!tabIsActive(target)) {
          // Leave no menu WE opened hanging behind a reported failure.
          closeOurPopover();
          return { ok: false, reason: "provider-tab-missing" };
        }
      }
    } else if (tabs.length > 0) {
      closeOurPopover();
      return { ok: false, reason: "provider-tab-missing" };
    } else {
      // Single-provider picker: nothing to click, but still verify the
      // composer's actual provider against the requested one (M2).
      const actual = resolvePickerProvider(providerLabelFromTrigger(triggerBtn));
      if (actual !== "default" && actual !== wantProvider) {
        closeOurPopover();
        return { ok: false, reason: "provider-tab-missing" };
      }
    }
  }

  // Find the option. Poll: the list itself may still be loading, the tab
  // switch re-renders it, and "More models"/search may have to reveal it (M3).
  let expandedMore = false;
  let searchedInput: HTMLInputElement | null = null;
  const fail = (reason: SwitchFailure): SwitchResult => {
    cleanupSwitchRemnants(popover, searchedInput);
    return { ok: false, reason };
  };
  for (let i = 0; i < 40 && alive(); i++) {
    const live = findOwnedPopover(triggerBtn);
    if (!live) {
      // The popover was open and is gone (Escape, outside click): abort —
      // a menu the USER reopens later must not receive our click.
      return fail("cancelled");
    }
    popover = live;

    for (const opt of [...scanOptions(popover), ...scanSubmenuOptions(popover)]) {
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

    if (!searchedInput) {
      const input = popover.querySelector<HTMLInputElement>(MODEL_SEARCH_SELECTOR);
      if (input) {
        searchedInput = input;
        setNativeInputValue(input, modelId.split(" · ")[0]);
        continue;
      }
    }

    await sleep(25);
  }

  if (!alive()) return fail("cancelled");
  return fail("model-not-found");
}

/** More models uses a separate Radix Popover on desktop (BB ve/ye).
 * Follow only the owner's More button. Its portal rows have title spans
 * even though they have neither option ids nor option roles. */
function findMoreSubmenus(popover: HTMLElement): HTMLElement[] {
  const submenus: HTMLElement[] = [];
  for (const trigger of popover.querySelectorAll<HTMLButtonElement>("button[aria-controls]")) {
    if (!(trigger.textContent ?? "").trim().startsWith("More models") ||
        trigger.getAttribute("aria-expanded") === "false") continue;
    const submenu = findOwnedPopover(trigger);
    if (submenu && !popover.contains(submenu) && submenu.dataset.state !== "closed") {
      submenus.push(submenu);
    }
  }
  return submenus;
}

function scanPortalOptions(submenu: HTMLElement): HTMLButtonElement[] {
  return Array.from(submenu.querySelectorAll<HTMLButtonElement>("button")).filter(
    (button) => !button.closest(".bb-fav-pin-section") && !!button.querySelector(":scope > span.truncate[title]")
  );
}

function scanSubmenuOptions(popover: HTMLElement): HTMLButtonElement[] {
  return findMoreSubmenus(popover).flatMap(scanPortalOptions);
}

/**
 * Undo whatever the failed scan left behind: the search text WE typed and
 * any menu surface we opened (the popover plus portal submenus it spawned).
 */
function cleanupSwitchRemnants(
  popover: HTMLElement | null,
  searchedInput: HTMLInputElement | null
): void {
  if (searchedInput?.isConnected && searchedInput.value) {
    setNativeInputValue(searchedInput, "");
  }
  if (!popover?.isConnected) return;
  for (const submenu of findMoreSubmenus(popover)) {
    submenu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
  popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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
  // The trigger appends its own qualifier ("· high reasoning"), so the bare
  // label head counts too — but never a substring ("M2" must not confirm a
  // click on "M").
  const head = modelPart.split(" · ")[0].trim();
  return modelPart === ex.modelId || modelPart === ex.key || head === ex.modelId;
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
