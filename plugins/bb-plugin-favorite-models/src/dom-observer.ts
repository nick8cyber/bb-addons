/**
 * DOM Observer: Detects model picker popovers in BB, injects star buttons,
 * and reorders favorite models to the top of the list.
 */

import {
  cleanModelText,
  getState,
  isFavorite,
  toggleFavorite,
  subscribe,
  type FavoritesState,
} from "./favorites-manager.js";

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

let observer: MutationObserver | null = null;
let isReordering = false;
// Window during which DOM writes performed by this plugin are ignored by the
// observer, preventing feedback loops (our own star injections / reordering).
let suppressUntil = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function suppress(): void {
  suppressUntil = Date.now() + 150;
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    suppress();
    refreshAllOpenPickers();
  }, 80);
}

export function initDomObserver(): () => void {
  // Listen for state changes (e.g. user toggles a favorite in settings or via star)
  const unsubscribeState = subscribe((_state) => {
    suppress();
    refreshAllOpenPickers();
  });

  // Observe DOM for newly mounted popovers or list changes. React often
  // reuses existing row nodes (e.g. while filtering via the search box),
  // stripping injected stars without adding new nodes — so any relevant
  // mutation schedules a debounced full refresh of open pickers.
  observer = new MutationObserver((mutations) => {
    if (isReordering || Date.now() < suppressUntil) return;

    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      const changed = [...mutation.addedNodes, ...mutation.removedNodes];
      const external = changed.some((node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (
          node.classList.contains("bb-fav-star-btn") ||
          node.classList.contains("bb-fav-section-badge") ||
          node.classList.contains("bb-fav-divider")
        ) {
          return false;
        }
        return true;
      });
      if (external) {
        scheduleRefresh();
        return;
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Initial check on existing DOM
  checkAndEnhanceElement(document.body);

  return () => {
    unsubscribeState();
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

function checkAndEnhanceElement(root: HTMLElement): void {
  // Look for popover containers or listboxes
  const listboxes = root.querySelectorAll<HTMLElement>(
    '[role="listbox"], [data-radix-popover-content], [data-radix-popper-content-wrapper]'
  );

  for (const lb of listboxes) {
    enhanceModelPickerContainer(lb);
  }

  // Also check root itself
  if (
    root.matches?.(
      '[role="listbox"], [data-radix-popover-content], [data-radix-popper-content-wrapper]'
    )
  ) {
    enhanceModelPickerContainer(root);
  }
}

function refreshAllOpenPickers(): void {
  const popovers = document.querySelectorAll<HTMLElement>(
    '[role="listbox"], [data-radix-popover-content], [data-radix-popper-content-wrapper]'
  );
  for (const p of popovers) {
    enhanceModelPickerContainer(p, true);
  }
}

export function detectActiveProvider(container?: HTMLElement): string {
  // 1. If popover container is present, look for active provider tab in header
  if (container) {
    const popover = container.closest('[data-radix-popover-content]') || container;
    const tabStrip = popover.querySelector('div.flex.items-center.gap-0\\.5, div[class*="border-b"]');
    if (tabStrip) {
      // Only real provider tabs: skip model option rows (role="option") and
      // anything whose title looks like a model name ("x/y", "x · y").
      const tabs = Array.from(tabStrip.querySelectorAll<HTMLButtonElement>("button")).filter(
        (b) =>
          b.getAttribute("role") !== "option" &&
          !b.querySelector('[role="option"]') &&
          (() => {
            const t = (b.getAttribute("title") || b.textContent || "").trim();
            return t !== "" && !t.includes("/") && !t.includes("·");
          })()
      );
      const activeTab =
        tabs.find((b) => b.className.includes("border-foreground")) ||
        tabs.find((b) => b.className.includes("text-foreground"));
      if (activeTab) {
        const title = activeTab.getAttribute("title") || activeTab.textContent?.trim();
        if (title) {
          const norm = normalizeProviderId(title);
          if (norm !== "default") return norm;
        }
      }
    }
  }

  // 2. Look for composer trigger button in active composer
  const triggerBtn = document.querySelector<HTMLButtonElement>(
    'button[aria-label*="Provider, model" i], button[aria-label*="Model" i]'
  );
  if (triggerBtn) {
    const titleElem = triggerBtn.hasAttribute("title")
      ? triggerBtn
      : triggerBtn.querySelector("[title]");
    const fullTitle = titleElem?.getAttribute("title") || "";
    // Format: "Provider Name: Model Name"
    if (fullTitle.includes(":")) {
      const provPart = fullTitle.split(":")[0].trim();
      const norm = normalizeProviderId(provPart);
      if (norm !== "default") return norm;
    }
  }

  // 3. Look globally for open model picker popover tab strip
  const tabStrip = document.querySelector(
    '[data-radix-popover-content] div.border-b, [role="listbox"] div.border-b'
  );
  if (tabStrip) {
    const tabs = Array.from(tabStrip.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) =>
        b.getAttribute("role") !== "option" &&
        (() => {
          const t = (b.getAttribute("title") || b.textContent || "").trim();
          return t !== "" && !t.includes("/") && !t.includes("·");
        })()
    );
    const activeTab =
      tabs.find((b) => b.className.includes("border-foreground")) ||
      tabs.find((b) => b.className.includes("text-foreground"));
    if (activeTab) {
      const title = activeTab.getAttribute("title") || activeTab.textContent?.trim();
      if (title) {
        const norm = normalizeProviderId(title);
        if (norm !== "default") return norm;
      }
    }
  }

  return "default";
}

export function normalizeProviderId(name: string): string {
  let clean = (name || "").toLowerCase().trim();
  // Filter out shortcut strings (like ⇧-⌘-m, Alt+M)
  if (
    clean.includes("⌘") ||
    clean.includes("⇧") ||
    clean.includes("alt") ||
    clean.includes("ctrl") ||
    clean.includes("shift")
  ) {
    return "default";
  }
  // Drop model qualifiers: "Provider / Model" and "Model · qualifier" both
  // reduce to the provider part, keeping keys consistent across contexts.
  if (clean.includes(" · ")) clean = clean.split(" · ")[0].trim();
  if (clean.includes("/")) clean = clean.split("/")[0].trim();
  if (clean.includes("codex") || clean === "openai") return "codex";
  if (clean.includes("claude") || clean === "anthropic") return "provider-claude-code";
  if (clean.includes("antigravity") || clean === "agy" || clean.includes("gemini")) return "agy";
  if (clean === "pi" || clean === "provider-pi" || clean.startsWith("pi-") || clean.includes("inflection"))
    return "provider-pi";
  if (clean.includes("opencode")) return "opencode";
  if (clean.includes("cursor") || clean.includes("acp")) return "acp-cursor";
  return clean.replace(/\s+/g, "-");
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

function extractModelIdFromButton(btn: HTMLButtonElement): { modelId: string; label: string } {
  // Option structure in BB:
  // <button role="option" ...>
  //   <span class="truncate" title="gpt-5.4 · OpenRouter">
  //     gpt-5.4
  //     <span class="ml-1.5 text-subtle-foreground">...</span>
  //   </span>
  //   <span>⇧-⌘-m</span>  <- shortcut, must be excluded
  // </button>

  const truncateSpan = btn.querySelector<HTMLElement>("span.truncate, span[title]");
  // Prefer the clean title attribute, then the first text node (model name
  // only), and only then the full textContent as a last resort.
  let fullTitle =
    truncateSpan?.getAttribute("title") ||
    (truncateSpan ? firstTextNodeText(truncateSpan) : "") ||
    btn.textContent ||
    "";
  fullTitle = cleanModelText(fullTitle.trim());

  // If title has " · qualifier", split
  let label = fullTitle;
  let modelId = fullTitle;
  if (fullTitle.includes(" · ")) {
    modelId = fullTitle.split(" · ")[0].trim();
  }

  // Also check if id attribute is present: e.g. "opt-gpt-5.4"
  const btnId = btn.getAttribute("id") || "";
  if (!modelId && btnId) {
    modelId = btnId;
  }

  return { modelId, label };
}

function enhanceModelPickerContainer(container: HTMLElement, forceRefresh = false): void {
  // Our own DOM writes (star injection, reordering) must not retrigger the observer
  suppress();
  // Check if this container is indeed a model picker popover or listbox
  const searchInput = container.querySelector('input[placeholder*="models" i], input[aria-label*="models" i]');
  const optionButtons = Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[role="option"], button[id*="-opt-"]'
    )
  );

  // If no option buttons and no search input, skip
  if (optionButtons.length === 0 && !searchInput) return;

  // Widen the picker popover so model names are not squeezed by the star column
  const popper =
    container.closest<HTMLElement>("[data-radix-popper-content-wrapper]") || container;
  if (optionButtons.length > 0 && !popper.dataset.favWidened) {
    popper.dataset.favWidened = "true";
    const current = popper.getBoundingClientRect().width;
    const desired = Math.round(Math.max(current + 40, 340));
    popper.style.width = `${desired}px`;
    popper.style.minWidth = `${desired}px`;
    popper.style.maxWidth = `${desired}px`;
  }

  // Find the list container that actually holds the option buttons
  const listContainer =
    optionButtons[0]?.parentElement ||
    container.querySelector<HTMLElement>('div[class*="overflow-y-auto"], [role="listbox"]') ||
    container;

  const providerId = detectActiveProvider(container);
  const state = getState();

  const favoriteOptions: HTMLButtonElement[] = [];
  const normalOptions: HTMLButtonElement[] = [];

  for (const btn of optionButtons) {
    // Skip if more-toggle or non-model button
    if (btn.getAttribute("id")?.includes("more-toggle") || btn.textContent?.includes("More models")) {
      continue;
    }

    const { modelId, label } = extractModelIdFromButton(btn);
    if (!modelId) continue;

    const favorited = isFavorite(providerId, modelId);

    // Decorate with star button if not present or needs update
    let starBtn = btn.querySelector<HTMLButtonElement>(".bb-fav-star-btn");
    if (!starBtn || forceRefresh) {
      if (!starBtn) {
        starBtn = document.createElement("button");
        starBtn.type = "button";
        starBtn.className = "bb-fav-star-btn";
        starBtn.setAttribute("data-bb-fav-star", "true");

        // Styling
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

        starBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const nextFav = toggleFavorite(providerId, modelId, label);
          updateStarVisual(starBtn!, nextFav);

          // Re-sort the list immediately
          if (state.pinToTop) {
            setTimeout(() => {
              enhanceModelPickerContainer(container, true);
            }, 10);
          }
        });

        // Insert before the checkmark span
        const checkSpan = btn.querySelector<HTMLElement>("span.flex.shrink-0");
        if (checkSpan) {
          btn.insertBefore(starBtn, checkSpan);
        } else {
          btn.appendChild(starBtn);
        }
      }

      updateStarVisual(starBtn, favorited);
    }

    if (favorited) {
      favoriteOptions.push(btn);
    } else {
      normalOptions.push(btn);
    }
  }

  // Reorder elements if pinToTop is enabled
  if (state.pinToTop && listContainer && (favoriteOptions.length > 0 || container.querySelector(".bb-fav-header"))) {
    reorderOptionsWithFavorites(listContainer, favoriteOptions, normalOptions);
  }
}

function updateStarVisual(starBtn: HTMLButtonElement, favorited: boolean): void {
  starBtn.innerHTML = favorited ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
  starBtn.title = favorited ? "В избранном (нажмите, чтобы убрать)" : "Добавить в избранное";
  starBtn.style.opacity = favorited ? "1" : "0.45";

  if (favorited) {
    starBtn.style.color = "#f59e0b";
  } else {
    starBtn.style.color = "currentColor";
  }

  // Row highlight if favorited
  const row = starBtn.closest<HTMLButtonElement>("button");
  if (row) {
    if (favorited) {
      row.classList.add("bb-fav-row-starred");
    } else {
      row.classList.remove("bb-fav-row-starred");
    }
  }
}

function reorderOptionsWithFavorites(
  listContainer: HTMLElement,
  favoriteOptions: HTMLButtonElement[],
  normalOptions: HTMLButtonElement[]
): void {
  isReordering = true;
  try {
    // Remove old headers/dividers
    const oldHeaders = listContainer.querySelectorAll(".bb-fav-section-badge, .bb-fav-divider");
    for (const h of oldHeaders) {
      h.remove();
    }

    if (favoriteOptions.length === 0) {
      return;
    }

    // Create "⭐ Избранные" header
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

    // Prepend header + favorite items
    const firstChild = listContainer.firstElementChild;
    listContainer.insertBefore(favHeader, firstChild);

    let insertRef: Node = favHeader.nextSibling || favHeader;
    for (const favBtn of favoriteOptions) {
      listContainer.insertBefore(favBtn, insertRef);
      insertRef = favBtn.nextSibling || favBtn;
    }

    // If there are also normal options, add a divider and "Все модели" label
    if (normalOptions.length > 0) {
      const divider = document.createElement("div");
      divider.className = "bb-fav-divider border-t border-border/70 my-1 mx-1.5";
      listContainer.insertBefore(divider, insertRef);

      const allHeader = document.createElement("div");
      allHeader.className =
        "bb-fav-section-badge flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground/70 select-none";
      allHeader.textContent = "Все модели";
      listContainer.insertBefore(allHeader, divider.nextSibling);

      insertRef = allHeader.nextSibling || allHeader;
      for (const normBtn of normalOptions) {
        listContainer.insertBefore(normBtn, insertRef);
        insertRef = normBtn.nextSibling || normBtn;
      }
    }
  } finally {
    isReordering = false;
  }
}

/**
 * Open the native BB composer model picker popover.
 */
export function openNativeModelPicker(anchor?: HTMLElement | null): void {
  const triggerBtn = findModelTrigger(anchor);
  if (!triggerBtn || triggerBtn.disabled) return;

  const isAlreadyOpen = !!document.querySelector(POPOVER_SELECTOR);
  if (!isAlreadyOpen) {
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
  | "model-not-found";

export interface SwitchResult {
  ok: boolean;
  reason?: SwitchFailure;
}

/** BB marks each composer root with this attribute (primary vs secondary). */
const COMPOSER_ROOT_SELECTOR = "[data-app-composer-role]";
/** BB's trigger carries aria-label "Provider, model and reasoning (<shortcut>)". */
const MODEL_TRIGGER_SELECTOR = 'button[aria-label*="Provider, model" i]';
const POPOVER_SELECTOR =
  '[role="listbox"], [data-radix-popover-content], [data-radix-popper-content-wrapper]';

function findModelTrigger(anchor?: HTMLElement | null): HTMLButtonElement | null {
  // Scope to the composer the caller lives in: several composers (thread,
  // side chat, queued message) can be mounted at once and a bare
  // document.querySelector would drive whichever happens to come first.
  const root = anchor?.closest<HTMLElement>(COMPOSER_ROOT_SELECTOR) ?? null;
  return (
    root?.querySelector<HTMLButtonElement>(MODEL_TRIGGER_SELECTOR) ??
    document.querySelector<HTMLButtonElement>(MODEL_TRIGGER_SELECTOR)
  );
}

/**
 * Fast programmatic model switcher:
 * Opens the composer's model picker, clicks the matching model option, and closes it.
 * Returns a reason on failure so the caller can say what actually went wrong.
 */
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

  // Open the popover if not open
  if (!document.querySelector(POPOVER_SELECTOR)) {
    triggerBtn.click();
  }

  // Wait for popover to mount. Models can load asynchronously, so allow ~1s.
  let popover: HTMLElement | null = null;
  for (let i = 0; i < 40; i++) {
    popover = document.querySelector<HTMLElement>(POPOVER_SELECTOR);
    if (popover) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!popover) return { ok: false, reason: "no-popover" };

  // Provider tabs render only when the composer offers more than one provider.
  // Each tab shows an icon or a single letter, so title is the only usable key.
  const wantProvider = providerId ? normalizeProviderId(providerId) : null;
  if (wantProvider) {
    const tabs = Array.from(
      popover.querySelectorAll<HTMLButtonElement>("div.border-b button[title], button[title]")
    ).filter((b) => b.getAttribute("role") !== "option");
    const target = tabs.find(
      (tab) => normalizeProviderId(tab.getAttribute("title") || "") === wantProvider
    );
    if (target) {
      const isActive = target.className.includes("border-foreground");
      if (!isActive) {
        target.click();
      }
    } else if (tabs.length > 0) {
      // Tabs exist but none is the provider we were asked for.
      return { ok: false, reason: "provider-tab-missing" };
    }
    // No tabs at all: single-provider composer, nothing to switch.
  }

  // Find the option. A provider tab click re-renders the list asynchronously,
  // and the list itself may still be loading, so poll rather than guess a delay.
  for (let i = 0; i < 40; i++) {
    // Re-query: the popover subtree can be replaced during the tab switch.
    const live = document.querySelector<HTMLElement>(POPOVER_SELECTOR) || popover;
    const options = Array.from(
      live.querySelectorAll<HTMLButtonElement>('button[role="option"], button[id*="-opt-"]')
    );
    for (const opt of options) {
      const { modelId: id, label } = extractModelIdFromButton(opt);
      if (id === modelId || label === modelId) {
        opt.click();
        return { ok: true };
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  return { ok: false, reason: "model-not-found" };
}
