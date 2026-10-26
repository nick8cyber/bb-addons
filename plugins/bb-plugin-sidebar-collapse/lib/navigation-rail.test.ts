// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import {
  NAVIGATION_RAIL_PART_ATTRIBUTE,
  NAVIGATION_RAIL_ROOT_ATTRIBUTE,
  NAVIGATION_RAIL_STYLE_ID,
  clearNavigationRailBridge,
  createNavigationRailController,
  findNavigationRailTargets,
  mountNavigationRail,
  resetNavigationRailBridgeForTests,
  setNavigationRailBridgeValue,
} from "./navigation-rail";

interface ShellOptions {
  state?: string;
  collapsible?: string;
  panelState?: string;
  panelCollapsible?: string;
  bodyHidden?: boolean;
  footer?: boolean;
  header?: boolean;
  bodyWidth?: string;
  indicator?: string;
}

function buildShell(options: ShellOptions = {}): void {
  // innerHTML below contains only locally authored, trusted test fixtures.
  const {
    state = "expanded",
    collapsible = "",
    panelState = "expanded",
    panelCollapsible = "",
    bodyHidden = false,
    footer = true,
    header = true,
    bodyWidth = "calc(320px - 44px)",
    indicator = "",
  } = options;

  // Real bb nesting: the state markers sit on the outer group while an inner
  // panel may also carry data-variant="sidebar".
  document.body.innerHTML = `
    <div id="sidebar-group" data-variant="sidebar" data-state="${state}" data-collapsible="${collapsible}">
      <div id="sidebar-panel" data-sidebar="panel" data-variant="sidebar"
           data-state="${panelState}" data-collapsible="${panelCollapsible}">
        <div data-sidebar="sidebar">
          <div data-testid="app-nav-rail" ${indicator}>rail</div>
          <div data-testid="nav-rail-sidebar-body" ${indicator}>
            <div id="body-content" style="width: ${bodyWidth}">
              <div data-testid="app-sidebar-body" ${bodyHidden ? "hidden" : ""}>
                ${
                  header
                    ? '<div data-testid="app-sidebar-top-reserve-row">header</div>'
                    : ""
                }
              </div>
            </div>
          </div>
          ${
            footer
              ? `<div data-testid="sidebar-footer-row">
                   <div id="footer-gutter">settings</div>
                   <div data-sidebar="collapsible-body">
                     <div id="footer-body" style="width: ${bodyWidth}">footer</div>
                   </div>
                 </div>`
              : ""
          }
        </div>
      </div>
    </div>`;
}

function buildMobileShell(state: "collapsed" | "expanded"): void {
  document.body.innerHTML = `
    <div id="mobile-panel" data-sidebar="panel" data-variant="sidebar"
         data-vaul-drawer-direction="left"
         data-sidebar-state="${state}"
         data-state="${state === "expanded" ? "open" : "closed"}"
         data-collapsible="">
      <div data-testid="app-nav-rail">rail</div>
      <div data-testid="nav-rail-sidebar-body">
        <div id="body-content" style="width: 100%">
          <div data-testid="app-sidebar-body">
            <div data-testid="app-sidebar-top-reserve-row" style="padding-left: 72px">header</div>
          </div>
        </div>
      </div>
      <div data-testid="sidebar-footer-row">
        <div id="footer-gutter">settings</div>
        <div data-sidebar="collapsible-body">
          <div id="footer-body" style="width: 100%">footer</div>
        </div>
      </div>
    </div>`;
}

function root(): HTMLElement {
  return document.documentElement;
}

function part(name: string): Element | null {
  return document.querySelector(
    `[${NAVIGATION_RAIL_PART_ATTRIBUTE}="${name}"]`,
  );
}

function styleElement(): HTMLStyleElement | null {
  return document.getElementById(NAVIGATION_RAIL_STYLE_ID) as
    | HTMLStyleElement
    | null;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  cleanup();
  resetNavigationRailBridgeForTests();
  document.body.innerHTML = "";
  root().removeAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE);
  styleElement()?.remove();
});

describe("navigation rail controller", () => {
  it("is off by default and leaves the native shell untouched", () => {
    buildShell();
    const controller = createNavigationRailController(document);

    expect(controller.enabled).toBe(false);
    expect(controller.active).toBe(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();
    expect(part("rail")).toBeNull();

    controller.dispose();
  });

  it("toggles false -> true -> false, marking only expected parts and keeping host inline styles", () => {
    buildShell();
    const controller = createNavigationRailController(document);
    const bodyContent = document.getElementById("body-content");
    const footerBody = document.getElementById("footer-body");
    const hostBodyStyle = bodyContent?.getAttribute("style");
    const hostFooterStyle = footerBody?.getAttribute("style");

    controller.setEnabled(true);
    expect(controller.active).toBe(true);
    expect(root().getAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe("true");
    expect(part("rail")?.textContent).toBe("rail");
    expect(part("body")?.id).toBe("body-content");
    expect(part("header")?.textContent).toBe("header");
    expect(part("footer-gutter")?.id).toBe("footer-gutter");
    expect(part("footer-body")?.id).toBe("footer-body");

    const css = styleElement()?.textContent ?? "";
    expect(css).toContain("display: none !important");
    expect(css).toContain("width: 100% !important");
    expect(css).toContain(
      "margin-left: calc(var(--bb-sidebar-control-size, 28px) + 2 * var(--bb-sidebar-rail-padding, 8px)) !important",
    );
    expect(css).not.toContain("padding-left");

    expect(bodyContent?.getAttribute("style")).toBe(hostBodyStyle);
    expect(footerBody?.getAttribute("style")).toBe(hostFooterStyle);

    controller.setEnabled(false);
    expect(controller.active).toBe(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();
    expect(part("rail")).toBeNull();
    expect(part("body")).toBeNull();
    expect(bodyContent?.getAttribute("style")).toBe(hostBodyStyle);
    expect(footerBody?.getAttribute("style")).toBe(hostFooterStyle);

    controller.setEnabled(true);
    expect(document.querySelectorAll(`#${NAVIGATION_RAIL_STYLE_ID}`)).toHaveLength(
      1,
    );
    controller.dispose();
    expect(styleElement()).toBeNull();
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
  });

  it("fails open without the expected markers and recovers when they appear", async () => {
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);

    expect(controller.active).toBe(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();

    buildShell();
    await flush();

    expect(controller.active).toBe(true);
    expect(root().getAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe("true");
    controller.dispose();
  });

  it("fails open when the footer rail segment is missing", () => {
    buildShell({ footer: false });
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);

    expect(findNavigationRailTargets(document)).toBeNull();
    expect(controller.active).toBe(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();
    controller.dispose();
  });

  it("fails open when the header reserve row is missing", () => {
    buildShell({ header: false });
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);

    expect(findNavigationRailTargets(document)).toBeNull();
    expect(controller.active).toBe(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();
    controller.dispose();
  });

  it("checks collapsed state on any ancestor shell, not just the nearest panel", async () => {
    buildShell({ state: "expanded", panelState: "collapsed" });
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);
    expect(controller.active).toBe(false);

    document.getElementById("sidebar-panel")!.setAttribute("data-state", "expanded");
    await flush();
    expect(controller.active).toBe(true);

    document.getElementById("sidebar-group")!.setAttribute("data-state", "collapsed");
    await flush();
    expect(controller.active).toBe(false);
    controller.dispose();
  });

  it("treats data-collapsible=rail on the outer group as collapsed", () => {
    buildShell({ collapsible: "rail" });
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);
    expect(controller.active).toBe(false);
    controller.dispose();
  });

  it("prepares mobile drawer CSS while closed and through the opening animation", async () => {
    buildMobileShell("collapsed");
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);

    expect(controller.active).toBe(true);
    expect(root().getAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe("true");

    document
      .querySelector('[data-testid="app-nav-rail"]')!
      .append(document.createElement("span"));
    await flush();
    expect(controller.active).toBe(true);

    const panel = document.getElementById("mobile-panel")!;
    panel.setAttribute("data-sidebar-state", "expanded");
    panel.setAttribute("data-state", "open");
    await flush();
    expect(controller.active).toBe(true);

    panel.setAttribute("data-sidebar-state", "collapsed");
    panel.setAttribute("data-state", "closed");
    await flush();
    expect(controller.active).toBe(true);
    controller.dispose();
  });

  it("still treats data-sidebar-state=collapsed on a desktop panel as collapsed", () => {
    buildShell();
    document
      .getElementById("sidebar-panel")!
      .setAttribute("data-sidebar-state", "collapsed");
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);

    expect(controller.active).toBe(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    controller.dispose();
  });

  it("preserves host header padding on macOS and reserves space with margin", () => {
    buildShell();
    const header = document.querySelector(
      '[data-testid="app-sidebar-top-reserve-row"]',
    )!;
    header.setAttribute(
      "style",
      "padding-left: calc(84px + 32px - 28px - 16px)",
    );
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);

    expect(header.getAttribute("style")).toBe(
      "padding-left: calc(84px + 32px - 28px - 16px)",
    );
    const css = styleElement()?.textContent ?? "";
    expect(css).toContain("margin-left: calc(");
    expect(css).not.toContain("padding-left");
    controller.dispose();
  });

  it("stops mutating after stabilization (no observer feedback loop)", async () => {
    buildShell();
    const controller = createNavigationRailController(document);
    let mutations = 0;
    const spy = new MutationObserver((records) => {
      mutations += records.length;
    });
    spy.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
    });

    controller.setEnabled(true);
    await flush();
    const settled = mutations;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(mutations).toBe(settled);
    spy.disconnect();
    controller.dispose();
  });

  it("refuses to mount for an already-aborted generation", () => {
    buildShell();
    setNavigationRailBridgeValue(true);
    const signal = new AbortController();
    signal.abort();

    const dispose = mountNavigationRail(signal.signal, document);

    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();
    dispose();
  });

  it("keeps the native rail in Settings (hidden body) and restores hiding on return", async () => {
    buildShell({ bodyHidden: true });
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);

    expect(controller.active).toBe(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();

    document
      .querySelector('[data-testid="app-sidebar-body"]')!
      .removeAttribute("hidden");
    await flush();

    expect(controller.active).toBe(true);
    expect(root().getAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe("true");

    document
      .querySelector('[data-testid="app-sidebar-body"]')!
      .setAttribute("hidden", "");
    await flush();

    expect(controller.active).toBe(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    controller.dispose();
  });

  it("keeps the native rail while collapsed and reapplies it when expanded", async () => {
    buildShell({ state: "collapsed" });
    const controller = createNavigationRailController(document);
    controller.setEnabled(true);

    expect(controller.active).toBe(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);

    const sidebar = document.querySelector('[data-variant="sidebar"]')!;
    sidebar.setAttribute("data-state", "expanded");
    await flush();
    expect(controller.active).toBe(true);

    sidebar.setAttribute("data-collapsible", "rail");
    await flush();
    expect(controller.active).toBe(false);

    sidebar.setAttribute("data-collapsible", "");
    await flush();
    expect(controller.active).toBe(true);
    controller.dispose();
  });

  it("uses width:100% for both compact and desktop host widths without touching them", () => {
    for (const width of ["100%", "calc(320px - 44px)"]) {
      buildShell({ bodyWidth: width });
      const controller = createNavigationRailController(document);
      controller.setEnabled(true);

      expect(styleElement()?.textContent).toContain(
        "width: 100% !important",
      );
      expect(document.getElementById("body-content")?.getAttribute("style")).toBe(
        `width: ${width}`,
      );
      controller.dispose();
      expect(styleElement()).toBeNull();
    }
  });

  it("cleans up on signal abort and stays idempotent on dispose", () => {
    buildShell();
    setNavigationRailBridgeValue(true);
    const abortController = new AbortController();
    const dispose = mountNavigationRail(abortController.signal, document);

    expect(root().getAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe("true");
    expect(styleElement()).not.toBeNull();

    abortController.abort();
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();

    dispose();
    dispose();
    expect(styleElement()).toBeNull();
  });

  it("does not duplicate styles or footer markers across repeated mounts", () => {
    buildShell();
    setNavigationRailBridgeValue(true);

    const disposeFirst = mountNavigationRail(undefined, document);
    const disposeSecond = mountNavigationRail(undefined, document);

    expect(document.querySelectorAll(`#${NAVIGATION_RAIL_STYLE_ID}`)).toHaveLength(
      1,
    );
    expect(document.querySelectorAll(`[${NAVIGATION_RAIL_PART_ATTRIBUTE}]`)).toHaveLength(
      5,
    );

    disposeFirst();
    expect(root().getAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe("true");
    expect(document.querySelectorAll(`#${NAVIGATION_RAIL_STYLE_ID}`)).toHaveLength(
      1,
    );

    disposeSecond();
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();
  });

  it("hides nothing until the settings bridge is live and stops on clear", () => {
    buildShell();
    const dispose = mountNavigationRail(undefined, document);

    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);

    setNavigationRailBridgeValue(true);
    expect(root().getAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe("true");

    setNavigationRailBridgeValue(false);
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);

    setNavigationRailBridgeValue(true);
    expect(root().getAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe("true");

    clearNavigationRailBridge();
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();
    dispose();
  });
});

/** Structural fixture matched against official bb-app@0.47.1 frontend bundle.
 * This checks compatibility, not a claim of running an upgraded BB server. */
function build047Shell() {
  buildShell();
  const panel = document.getElementById("sidebar-panel")!;
  const navBody = document.querySelector('[data-testid="nav-rail-sidebar-body"]')!;
  const rail = document.querySelector('[data-testid="app-nav-rail"]')!;
  const gutter = document.getElementById("footer-gutter")!;
  const footer = gutter.nextElementSibling!;
  const nav = document.createElement("nav");
  nav.dataset.testid = "sidebar-navigation-rail";
  nav.dataset.sidebarNavigationPlacement = "rail";
  nav.append(rail);
  const grid = document.createElement("div");
  grid.className = "grid";
  footer.setAttribute("data-testid", "sidebar-footer-body");
  grid.append(nav, navBody, gutter, footer);
  panel.replaceChildren(grid);
  return { panel, nav, navBody, rail, grid, gutter, footer };
}

describe("BB 0.47 grid compatibility", () => {
  it("hides only the verified native rail and reclaims its grid column", () => {
    const s = build047Shell();
    const c = createNavigationRailController(document);
    c.setEnabled(true);
    expect(c.active).toBe(true);
    expect(part("rail")).toBe(s.nav);
    expect(part("grid")).toBe(s.grid);
    expect(part("body-shell")).toBe(s.navBody);
    expect(part("footer-shell")).toBe(s.footer);
    expect(styleElement()?.textContent).toContain("grid-template-columns: minmax(0, 1fr)");
    c.dispose();
    expect(document.querySelectorAll(`[${NAVIGATION_RAIL_PART_ATTRIBUTE}]`)).toHaveLength(0);
    expect(s.grid.className).toBe("grid");
  });
  it("leaves native Top list untouched and cleans marks on placement changes", async () => {
    const s = build047Shell();
    const c = createNavigationRailController(document);
    c.setEnabled(true);
    s.nav.dataset.sidebarNavigationPlacement = "list";
    await flush();
    expect(c.active).toBe(false);
    expect(styleElement()).toBeNull();
    expect(document.querySelectorAll(`[${NAVIGATION_RAIL_PART_ATTRIBUTE}]`)).toHaveLength(0);
    s.nav.dataset.sidebarNavigationPlacement = "rail";
    await flush();
    expect(c.active).toBe(true);
    c.dispose();
  });
  it.each(["rail", "footer", "grid"] as const)("fails open with missing or unsupported %s", target => {
    const s = build047Shell();
    if (target === "grid") s.grid.className = "unknown-shell";
    else s[target].remove();
    const c = createNavigationRailController(document);
    c.setEnabled(true);
    expect(c.active).toBe(false);
    expect(styleElement()).toBeNull();
    c.dispose();
  });
  it("reacts to desktop data-sidebar-state without any other attribute changing", async () => {
    const s = build047Shell();
    const c = createNavigationRailController(document);
    c.setEnabled(true);
    s.panel.dataset.sidebarState = "collapsed";
    await flush();
    expect(c.active).toBe(false);
    s.panel.dataset.sidebarState = "expanded";
    await flush();
    expect(c.active).toBe(true);
    c.dispose();
  });
  it("restores native navigation on Settings and activates when returning", async () => {
    build047Shell();
    const body = document.querySelector('[data-testid="app-sidebar-body"]')!;
    const c = createNavigationRailController(document);
    c.setEnabled(true);
    body.setAttribute("hidden", "");
    await flush();
    expect(c.active).toBe(false);
    body.removeAttribute("hidden");
    await flush();
    expect(c.active).toBe(true);
    c.dispose();
  });
});

describe("navigation rail plugin registration", () => {
  let appPromise: ReturnType<typeof loadPluginApp>;

  beforeAll(async () => {
    appPromise = loadPluginApp(() => import("../app"));
    await appPromise;
  }, 60_000);

  it("registers the content script and overlay only when the overlay slot exists", async () => {
    await appPromise;
    const { registerNavigationRail } = await import("../app");

    const registerContentScript = vi.fn();
    const experimental_appOverlay = vi.fn();
    registerNavigationRail({
      contentScripts: { register: registerContentScript },
      slots: { experimental_appOverlay },
    } as unknown as PluginAppBuilder);
    expect(registerContentScript).toHaveBeenCalledTimes(1);
    expect(experimental_appOverlay).toHaveBeenCalledTimes(1);

    const noOverlayContentScript = vi.fn();
    registerNavigationRail({
      contentScripts: { register: noOverlayContentScript },
      slots: {},
    } as unknown as PluginAppBuilder);
    expect(noOverlayContentScript).not.toHaveBeenCalled();
  });

  it("registers one content script, one overlay, and the footer settings action", async () => {
    const app = await appPromise;
    expect(app.contentScripts.filter((s) => s.id === "navigation-rail")).toHaveLength(
      1,
    );
    expect(app.appOverlays.filter((o) => o.id === "navigation-rail")).toHaveLength(
      1,
    );

    const footer = app.sidebarFooterActions.find(
      (action) => action.id === "sidebar-collapse-settings",
    );
    expect(footer).toBeTruthy();
    const openSettings = vi.fn();
    await footer?.run({ openSettings });
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("applies the setting through the overlay even with the native thread list", async () => {
    const app = await appPromise;
    buildShell();
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "sidebar-collapse",
    });
    expect(mounted.inspection.mountedIds).toContain("navigation-rail");

    const overlay = renderSlot(
      app.appOverlays[0]!,
      {},
      {
        settings: {
          useCollapsedList: false,
          hideNavigationRail: true,
        },
      },
    );

    expect(root().getAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe("true");
    expect(part("rail")).not.toBeNull();

    overlay.lifecycle.unmount();
    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();

    await mounted.lifecycle.dispose();
  });

  it("keeps the rail native while settings values are undefined", async () => {
    const app = await appPromise;
    buildShell();
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "sidebar-collapse",
    });

    const overlay = renderSlot(app.appOverlays[0]!, {});

    expect(root().hasAttribute(NAVIGATION_RAIL_ROOT_ATTRIBUTE)).toBe(false);
    expect(styleElement()).toBeNull();

    overlay.lifecycle.unmount();
    await mounted.lifecycle.dispose();
  });
});
