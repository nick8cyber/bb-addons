/**
 * DOM controller for hiding bb's narrow navigation rail (Home / Tasks / More).
 *
 * bb 0.46.1 has no native switch for the rail, so this module owns a small,
 * self-contained compatibility layer:
 *
 * - only the expected sidebar shell markers are touched;
 * - missing or changed markers leave the native UI untouched (fail-open);
 * - every marker, style element and observer belongs to this controller and is
 *   removed on disable, abort, or unmount.
 *
 * The controller itself never reads plugin settings. `app.tsx` registers an
 * `experimental_appOverlay` component that reads `hideNavigationRail` and feeds
 * the value into the module-level bridge below. Without a live bridge the
 * controller stays off.
 */

export const NAVIGATION_RAIL_ROOT_ATTRIBUTE =
  "data-bb-sidebar-hide-navigation-rail";
export const NAVIGATION_RAIL_PART_ATTRIBUTE =
  "data-bb-sidebar-navigation-rail-part";
export const NAVIGATION_RAIL_STYLE_ID =
  "bb-plugin-sidebar-collapse-navigation-rail";

const ROOT_ACTIVE_VALUE = "true";

const RAIL_PART = {
  rail: "rail",
  body: "body",
  header: "header",
  footerGutter: "footer-gutter",
  footerBody: "footer-body",
  grid: "grid",
  bodyShell: "body-shell",
  footerShell: "footer-shell",
} as const;

type RailPart = (typeof RAIL_PART)[keyof typeof RAIL_PART];

function selector(part: RailPart): string {
  return `html[${NAVIGATION_RAIL_ROOT_ATTRIBUTE}="${ROOT_ACTIVE_VALUE}"] [${NAVIGATION_RAIL_PART_ATTRIBUTE}="${part}"]`;
}

/**
 * The freed rail width is `control size + 2 * padding`: 44px on desktop and
 * wider under a coarse pointer (36px control + 12px padding on each side).
 * Keep the host variables so compact/PWA never lets the Toggle-sidebar hit
 * target slide over New thread.
 */
const HEADER_RESERVE =
  "calc(var(--bb-sidebar-control-size, 28px) + 2 * var(--bb-sidebar-rail-padding, 8px))";

const STYLE_TEXT = [
  `${selector(RAIL_PART.rail)} { display: none !important; }`,
  `${selector(RAIL_PART.grid)} { grid-template-columns: minmax(0, 1fr) !important; }`,
  `${selector(RAIL_PART.bodyShell)}, ${selector(RAIL_PART.footerShell)} { grid-column: 1 !important; }`,
  `${selector(RAIL_PART.body)} { width: 100% !important; }`,
  `${selector(RAIL_PART.header)} { margin-left: ${HEADER_RESERVE} !important; }`,
  `${selector(RAIL_PART.footerGutter)} { display: none !important; }`,
  `${selector(RAIL_PART.footerBody)} { width: 100% !important; }`,
].join("\n");

interface NavigationRailTargets {
  parts: ReadonlyArray<readonly [HTMLElement, RailPart]>;
}

function asElement(node: Element | null | undefined): HTMLElement | null {
  return node !== null && node !== undefined && node.nodeType === 1
    ? (node as HTMLElement)
    : null;
}

function isMobileDrawerPanel(node: Element): boolean {
  return (
    node.getAttribute("data-sidebar") === "panel" &&
    node.getAttribute("data-vaul-drawer-direction") === "left"
  );
}

/**
 * `data-state` / `data-collapsible` live on the outer sidebar group in desktop
 * bb and on the mobile panel in compact mode, while an intermediate panel may
 * also carry `data-variant="sidebar"`. Walk every ancestor that looks like a
 * sidebar shell and reject the layout if any desktop shell reports a collapsed
 * state. A mobile drawer keeps `data-sidebar-state="collapsed"` for ~220ms
 * after its opening animation starts; at that point the drawer is already
 * visible (or inert while closed), so it must not disable the prepared CSS. No
 * recognized shell at all is also fail-open.
 */
function isExpandedSidebarShell(sidebarBody: HTMLElement): boolean {
  let node: Element | null = sidebarBody;
  let sawShell = false;

  while (node !== null) {
    const looksLikeShell =
      node.getAttribute("data-variant") === "sidebar" ||
      node.getAttribute("data-sidebar") === "panel" ||
      node.hasAttribute("data-collapsible") ||
      node.hasAttribute("data-sidebar-state");
    if (looksLikeShell) {
      sawShell = true;
      const transientMobileCollapse = isMobileDrawerPanel(node);
      if (
        !transientMobileCollapse &&
        (node.getAttribute("data-state") === "collapsed" ||
          node.getAttribute("data-sidebar-state") === "collapsed" ||
          node.getAttribute("data-collapsible") === "rail")
      ) {
        return false;
      }
    }
    node = node.parentElement;
  }

  return sawShell;
}

/**
 * Locate the exact elements the feature may touch. Returns null whenever the
 * shell is not in the expected expanded chat layout, so a different bb build
 * is left alone.
 */
export function findNavigationRailTargets(
  doc: Document,
): NavigationRailTargets | null {
  const sidebarBody = asElement(
    doc.querySelector('[data-testid="app-sidebar-body"]'),
  );
  if (
    sidebarBody === null ||
    sidebarBody.hasAttribute("hidden") ||
    !isExpandedSidebarShell(sidebarBody)
  ) {
    return null;
  }

  const rail = asElement(doc.querySelector('[data-testid="app-nav-rail"]'));
  const navBody = asElement(
    doc.querySelector('[data-testid="nav-rail-sidebar-body"]'),
  );
  const bodyContent = asElement(navBody?.firstElementChild);
  if (rail === null || bodyContent === null) {
    return null;
  }

  // BB 0.47 moved navigation into an exclusive plugin slot and a two-column grid.
  // Never style Top list or a third-party provider that has no recognized rail.
  const navigation = asElement(rail.closest("[data-sidebar-navigation-placement]"));
  if (navigation !== null) {
    if (navigation.getAttribute("data-sidebar-navigation-placement") !== "rail"
      || navigation.getAttribute("data-testid") !== "sidebar-navigation-rail") return null;
    const grid = navigation.parentElement;
    const footerShell = asElement(doc.querySelector('[data-testid="sidebar-footer-body"]'));
    const footerGutter = asElement(footerShell?.previousElementSibling);
    const footerContent = asElement(footerShell?.firstElementChild);
    const header = asElement(sidebarBody.querySelector('[data-testid="app-sidebar-top-reserve-row"]'));
    if (grid === null || !grid.classList.contains("grid")
      || navBody?.parentElement !== grid || !navBody.contains(sidebarBody)
      || footerShell?.parentElement !== grid || footerGutter === null
      || footerGutter === navBody || footerGutter === navigation
      || footerContent === null || header === null) return null;
    return { parts: [
      [navigation, RAIL_PART.rail], [grid, RAIL_PART.grid],
      [navBody, RAIL_PART.bodyShell], [bodyContent, RAIL_PART.body],
      [header, RAIL_PART.header], [footerGutter, RAIL_PART.footerGutter],
      [footerShell, RAIL_PART.footerShell], [footerContent, RAIL_PART.footerBody],
    ] };
  }

  const footerRow = asElement(
    doc.querySelector('[data-testid="sidebar-footer-row"]'),
  );
  if (footerRow === null || footerRow.children.length < 2) {
    return null;
  }
  const footerGutter = asElement(footerRow.firstElementChild);
  const footerBody = asElement(
    footerRow.querySelector('[data-sidebar="collapsible-body"]')
      ?.firstElementChild,
  );
  if (footerGutter === null || footerBody === null) {
    return null;
  }

  const header = asElement(
    sidebarBody.querySelector(
      '[data-testid="app-sidebar-top-reserve-row"]',
    ),
  );
  // Without the header row there is nowhere to reserve the Toggle-sidebar hit
  // target; hiding the rail would let the trigger overlap New thread.
  if (header === null) {
    return null;
  }

  return {
    parts: [
      [rail, RAIL_PART.rail],
      [bodyContent, RAIL_PART.body],
      [header, RAIL_PART.header],
      [footerGutter, RAIL_PART.footerGutter],
      [footerBody, RAIL_PART.footerBody],
    ],
  };
}

export interface NavigationRailController {
  readonly enabled: boolean;
  readonly active: boolean;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export function createNavigationRailController(
  doc: Document = document,
): NavigationRailController {
  let enabled = false;
  let active = false;
  let disposed = false;
  let style: HTMLStyleElement | null = null;
  let observer: MutationObserver | null = null;
  let scheduled = false;
  let marked: HTMLElement[] = [];

  const clearMarks = () => {
    for (const element of marked) {
      element.removeAttribute(NAVIGATION_RAIL_PART_ATTRIBUTE);
    }
    marked = [];
  };

  const removeStyle = () => {
    style?.remove();
    style = null;
  };

  const installStyle = () => {
    if (style === null) {
      const existing = asElement(doc.getElementById(NAVIGATION_RAIL_STYLE_ID));
      if (existing !== null && existing.tagName === "STYLE") {
        style = existing as HTMLStyleElement;
      } else {
        style = doc.createElement("style");
        style.id = NAVIGATION_RAIL_STYLE_ID;
        (doc.head ?? doc.documentElement).append(style);
      }
    }
    // Never rewrite identical CSS: the observer watches the whole tree, and a
    // textContent assignment mutates <style> children, which would feed the
    // observer again and loop microtasks forever.
    if (style.textContent !== STYLE_TEXT) {
      style.textContent = STYLE_TEXT;
    }
  };

  const deactivate = () => {
    active = false;
    clearMarks();
    removeStyle();
    doc.documentElement.removeAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE);
  };

  const sync = () => {
    scheduled = false;
    if (disposed || !enabled) {
      return;
    }

    clearMarks();
    const targets = findNavigationRailTargets(doc);
    if (targets === null) {
      deactivate();
      return;
    }

    installStyle();
    doc.documentElement.setAttribute(
      NAVIGATION_RAIL_ROOT_ATTRIBUTE,
      ROOT_ACTIVE_VALUE,
    );
    for (const [element, part] of targets.parts) {
      element.setAttribute(NAVIGATION_RAIL_PART_ATTRIBUTE, part);
      marked.push(element);
    }
    active = true;
  };

  const scheduleSync = () => {
    if (disposed || !enabled || scheduled) {
      return;
    }
    scheduled = true;
    const run = () => {
      if (scheduled) {
        sync();
      }
    };
    const view = doc.defaultView;
    if (view !== null && typeof view.queueMicrotask === "function") {
      view.queueMicrotask(run);
    } else {
      void Promise.resolve().then(run);
    }
  };

  const startObserver = () => {
    const MutationObserverImpl = doc.defaultView?.MutationObserver;
    if (observer !== null || MutationObserverImpl === undefined) {
      return;
    }
    observer = new MutationObserverImpl(() => {
      scheduleSync();
    });
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "data-state", "data-sidebar-state", "data-collapsible", "data-sidebar-navigation-placement"],
    });
  };

  const stopObserver = () => {
    observer?.disconnect();
    observer = null;
  };

  return {
    get enabled() {
      return enabled;
    },
    get active() {
      return active;
    },
    setEnabled(next: boolean) {
      if (disposed || enabled === next) {
        return;
      }
      enabled = next;
      if (next) {
        startObserver();
        sync();
      } else {
        stopObserver();
        deactivate();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      enabled = false;
      stopObserver();
      deactivate();
    },
  };
}

let bridgeValue: boolean | null = null;
let controller: NavigationRailController | null = null;

export function attachNavigationRailController(
  next: NavigationRailController,
): () => void {
  if (controller !== null && controller !== next) {
    controller.dispose();
  }
  controller = next;
  next.setEnabled(bridgeValue === true);
  return () => {
    if (controller === next) {
      controller = null;
    }
    next.dispose();
  };
}

/** Called only by the app-wide overlay component that reads the setting. */
export function setNavigationRailBridgeValue(value: boolean): void {
  bridgeValue = value;
  controller?.setEnabled(value);
}

/** Overlay unmount: with no live bridge the controller hides nothing. */
export function clearNavigationRailBridge(): void {
  bridgeValue = null;
  controller?.setEnabled(false);
}

export function resetNavigationRailBridgeForTests(): void {
  bridgeValue = null;
  controller?.dispose();
  controller = null;
}

/** Content-script entry point: one controller per app window generation. */
export function mountNavigationRail(
  signal?: AbortSignal,
  doc: Document = document,
): () => void {
  const next = createNavigationRailController(doc);

  // A generation can be aborted before its mount runs; never install anything
  // for an already-dead generation.
  if (signal?.aborted) {
    next.dispose();
    return () => {};
  }

  const detach = attachNavigationRailController(next);
  const onAbort = () => {
    detach();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  return () => {
    signal?.removeEventListener("abort", onAbort);
    detach();
  };
}
