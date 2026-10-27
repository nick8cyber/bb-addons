// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/dom";
import { bindGitHeader, type GitHeaderSnapshot } from "./git-header";
import { mountSidebarControls } from "./sidebar-controls";

const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).reverse().forEach(d => d()); document.body.replaceChildren(); vi.restoreAllMocks(); });

function fixture(name = "one", other = false) {
  const pane = document.createElement("div"); pane.dataset.splitPaneId = name;
  const header = document.createElement("header"), anchor = document.createElement("span");
  const proxy = document.createElement("button"); anchor.append(proxy); header.append(anchor); pane.append(header);
  const section = document.createElement("section");
  section.style.minHeight = "35px";
  const source = document.createElement("button"); source.id = "thread-prompt-banner-git-toggle";
  source.setAttribute("aria-label", "Changed files: Untracked, 813 files");
  source.setAttribute("aria-expanded", "false");
  const summary = document.createElement("span"); summary.textContent = "Untracked · 813 files"; source.append(summary);
  const body = document.createElement("div"); body.id = "thread-prompt-banner-git-body";
  section.append(source, body);
  if (other) { const status = document.createElement("button"); status.id = "thread-prompt-banner-status-toggle"; section.append(status); }
  pane.append(section); document.body.append(pane);
  const nativeClick = vi.fn(() => source.setAttribute("aria-expanded", String(source.getAttribute("aria-expanded") !== "true")));
  source.addEventListener("click", nativeClick);
  let state: GitHeaderSnapshot | null = null;
  const binding = bindGitHeader(anchor, s => state = s); disposers.push(binding.dispose);
  proxy.onclick = binding.toggle;
  return { pane, header, anchor, proxy, section, source, summary, body, nativeClick, binding, state: () => state };
}

describe("native git header binding", () => {
  it("uses the host disclosure, tracks text/state/disabled, and cleans only owned changes", async () => {
    const f = fixture(); disposers.push(mountSidebarControls());
    expect(f.state()).toMatchObject({ summary: "Untracked · 813 files", count: "813", expanded: false });
    expect(getComputedStyle(f.section).display).toBe("none");
    f.binding.toggle();
    await waitFor(() => expect(f.state()?.expanded).toBe(true));
    expect(f.nativeClick).toHaveBeenCalledTimes(1);
    expect(getComputedStyle(f.section).position).toBe("fixed");
    f.summary.textContent = "Untracked · 999 files"; f.source.setAttribute("aria-label", "Changed files: 999 files");
    await waitFor(() => expect(f.state()?.count).toBe("999"));
    f.source.disabled = true;
    await waitFor(() => expect(f.state()?.disabled).toBe(true));
    f.binding.toggle(); expect(f.nativeClick).toHaveBeenCalledTimes(1);
    f.binding.dispose(); f.binding.dispose();
    expect(f.section.hasAttribute("data-bb-git-section")).toBe(false);
    expect(f.section.style.minHeight).toBe("35px");
    expect(f.section.style.getPropertyValue("--bb-git-left")).toBe("");
    expect(f.source.hasAttribute("data-bb-git-source")).toBe(false);
    expect(f.anchor.hasAttribute("data-bb-git-compact")).toBe(false);
  });
  it("scopes duplicate native ids to each split pane and preserves other context segments", async () => {
    const a = fixture("a"), b = fixture("b", true); disposers.push(mountSidebarControls());
    b.binding.toggle();
    await waitFor(() => expect(b.state()?.expanded).toBe(true));
    expect(a.state()?.expanded).toBe(false);
    expect(a.nativeClick).not.toHaveBeenCalled();
    expect(b.section.dataset.bbGitSection).toBe("mixed");
    expect(getComputedStyle(b.section).display).not.toBe("none");
    expect(getComputedStyle(b.source).display).toBe("none");
    expect(getComputedStyle(b.body).position).toBe("fixed");
  });
  it("closes on Escape with proxy focus, closes outside, and allows native dialogs", async () => {
    const f = fixture();
    f.binding.toggle(); await waitFor(() => expect(f.state()?.expanded).toBe(true));
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
    dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(f.source.getAttribute("aria-expanded")).toBe("true");
    f.proxy.focus();
    f.proxy.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    await waitFor(() => expect(f.state()?.expanded).toBe(false));
    expect(document.activeElement).toBe(f.proxy);
    f.binding.toggle(); await waitFor(() => expect(f.state()?.expanded).toBe(true));
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await waitFor(() => expect(f.state()?.expanded).toBe(false));
  });
  it("rebinds replaced source nodes and restores detached nodes", async () => {
    const f = fixture();
    const replacement = f.source.cloneNode(true) as HTMLButtonElement;
    replacement.removeAttribute("data-bb-git-source");
    f.source.replaceWith(replacement);
    await waitFor(() => expect(replacement.hasAttribute("data-bb-git-source")).toBe(true));
    expect(f.source.hasAttribute("data-bb-git-source")).toBe(false);
    const click = vi.fn(); replacement.onclick = click; f.binding.toggle(); expect(click).toHaveBeenCalledTimes(1);
    f.section.remove();
    await waitFor(() => expect(f.state()).toBeNull());
    expect(replacement.hasAttribute("data-bb-git-source")).toBe(false);
  });
  it("fails open without a pane or a complete native disclosure", async () => {
    const anchor = document.createElement("span"); document.body.append(anchor);
    const onChange = vi.fn(), b = bindGitHeader(anchor, onChange);
    b.toggle(); b.dispose(); expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
    const f = fixture(); f.body.remove();
    await waitFor(() => expect(f.state()).toBeNull());
    expect(f.section.hasAttribute("data-bb-git-section")).toBe(false);
  });
  it("does not react to mutations after disposal", async () => {
    const f = fixture(); f.binding.dispose();
    f.source.setAttribute("aria-expanded", "true"); f.summary.textContent = "changed";
    await Promise.resolve();
    expect(f.section.hasAttribute("data-bb-git-open")).toBe(false);
  });
  it("preserves static status text and plugin controls without native toggle ids", async () => {
    const f = fixture();
    const status = document.createElement("p"); status.textContent = "Waiting for host";
    f.section.append(status);
    await waitFor(() => expect(f.section.dataset.bbGitSection).toBe("mixed"));
    status.remove();
    const plugin = document.createElement("button"); plugin.setAttribute("aria-label", "Plugin action");
    f.section.append(plugin);
    await waitFor(() => expect(f.section.dataset.bbGitSection).toBe("mixed"));
    expect(plugin.isConnected).toBe(true);
  });
  it("Escape affects only the pane containing keyboard focus", async () => {
    const a = fixture("a"), b = fixture("b");
    a.binding.toggle(); b.binding.toggle();
    await waitFor(() => expect(b.state()?.expanded).toBe(true));
    b.proxy.focus(); b.proxy.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => expect(b.state()?.expanded).toBe(false));
    expect(a.state()?.expanded).toBe(true);
  });
});
