// @vitest-environment jsdom
import {afterEach,describe,expect,it} from "vitest";
import {mountSidebarControls,SIDEBAR_CONTROLS_STYLE_ID,SIDEBAR_CONTROLS_CSS} from "./sidebar-controls";

afterEach(()=>{document.body.replaceChildren();document.getElementById(SIDEBAR_CONTROLS_STYLE_ID)?.remove()});
describe("owned sidebar control styles",()=>{
 it("deduplicates only our Settings item while native Settings exists, then restores it",()=>{
  const footer=document.createElement("div");footer.dataset.sidebar="footer";
  const ours=document.createElement("li");ours.dataset.footerItem="plugin:sidebar-collapse/sidebar-collapse-settings";
  const other=document.createElement("li");other.dataset.footerItem="plugin:other/settings";
  footer.append(ours,other);document.body.append(footer);
  const dispose=mountSidebarControls();
  expect(getComputedStyle(ours).display).not.toBe("none");
  const native=document.createElement("li");native.dataset.footerItem="builtin:settings";
  const a=document.createElement("a");a.id="sidebar-footer-settings";native.append(a);footer.prepend(native);
  expect(getComputedStyle(ours).display).toBe("none");
  expect(getComputedStyle(other).display).not.toBe("none");
  native.remove();
  expect(getComputedStyle(ours).display).not.toBe("none");
  dispose();
  expect(document.getElementById(SIDEBAR_CONTROLS_STYLE_ID)).toBeNull();
 });
 it("cleans up exactly once on abort and never mounts an aborted generation",()=>{
  const c=new AbortController(),dispose=mountSidebarControls(c.signal);
  expect(document.getElementById(SIDEBAR_CONTROLS_STYLE_ID)).not.toBeNull();
  c.abort();dispose();dispose();
  expect(document.getElementById(SIDEBAR_CONTROLS_STYLE_ID)).toBeNull();
  mountSidebarControls(c.signal);
  expect(document.getElementById(SIDEBAR_CONTROLS_STYLE_ID)).toBeNull();
 });
 it("scopes neutral count colors to native Top list without changing warning/critical tones",()=>{
  expect(SIDEBAR_CONTROLS_CSS).toContain('[data-testid="sidebar-navigation-region"][data-sidebar-navigation-placement="list"]');
  expect(SIDEBAR_CONTROLS_CSS).toContain('[data-nav-rail-badge="count"][data-nav-badge-tone="neutral"] > span');
  expect(SIDEBAR_CONTROLS_CSS).not.toMatch(/data-nav-badge-tone="(?:warning|critical)"/);
  expect(SIDEBAR_CONTROLS_CSS).toContain("var(--sidebar-foreground)");
 });
});
