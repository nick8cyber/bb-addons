// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/dom";
import { bindActivityHeader, mountCompactQueue } from "./chat-compact";
import { mountSidebarControls } from "./sidebar-controls";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).reverse().forEach(f => f()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function queue() {
  const card = document.createElement("section"), header = document.createElement("header"), trigger = document.createElement("button");
  header.dataset.queuedMessagesMode = "expanded"; trigger.setAttribute("aria-controls", "queue-one"); trigger.setAttribute("aria-expanded", "true");
  trigger.onclick = () => { const open = trigger.getAttribute("aria-expanded") !== "true"; trigger.setAttribute("aria-expanded", String(open)); header.dataset.queuedMessagesMode = open ? "expanded" : "collapsed"; };
  header.append(trigger); card.append(header); document.body.append(card);
  return {card, header, trigger};
}
describe("compact native queue", () => {
  it("reveals a new failure once without preventing the user from closing it", async () => {
    const f = queue(); disposers.push(mountCompactQueue());
    const failure = document.createElement("div"); failure.dataset.queuedMessageFailed = ""; f.card.append(failure);
    await waitFor(() => expect(f.trigger.getAttribute("aria-expanded")).toBe("true"));
    f.trigger.click(); f.card.append(document.createElement("li"));
    await new Promise(r => setTimeout(r, 0)); expect(f.trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it("collapses once and preserves subsequent user expansion and new message updates", async () => {
    const f = queue(), click = vi.spyOn(f.trigger, "click"); disposers.push(mountCompactQueue());
    expect(f.trigger.getAttribute("aria-expanded")).toBe("false"); expect(click).toHaveBeenCalledTimes(1);
    f.trigger.click(); f.card.append(document.createElement("li"));
    await new Promise(r => setTimeout(r, 0));
    expect(f.trigger.getAttribute("aria-expanded")).toBe("true"); expect(click).toHaveBeenCalledTimes(2);
  });
  it.each(["data-queued-message-inline-editor", "data-queued-message-failed"])("never hides %s", async marker => {
    const f = queue(), protectedNode = document.createElement("div"); protectedNode.setAttribute(marker, ""); f.card.append(protectedNode);
    disposers.push(mountCompactQueue()); await new Promise(r => setTimeout(r, 0));
    expect(f.trigger.getAttribute("aria-expanded")).toBe("true");
  });
  it("handles late queues, disabled triggers and abort cleanup", async () => {
    const c = new AbortController(); disposers.push(mountCompactQueue(c.signal));
    const f = queue(); f.trigger.disabled = true;
    await new Promise(r => setTimeout(r, 0)); expect(f.trigger.getAttribute("aria-expanded")).toBe("true");
    f.trigger.disabled = false;
    await waitFor(() => expect(f.trigger.getAttribute("aria-expanded")).toBe("false"));
    c.abort(); const g = queue(); await new Promise(r => setTimeout(r, 0)); expect(g.trigger.getAttribute("aria-expanded")).toBe("true");
  });
});
function activity(name = "one") {
  const pane = document.createElement("div"); pane.dataset.splitPaneId = name;
  const header = document.createElement("header"), anchor = document.createElement("span"), proxy = document.createElement("button");
  anchor.append(proxy); header.append(anchor); pane.append(header);
  const composer = document.createElement("div"); composer.dataset.appComposerRole = "primary";
  const card = document.createElement("section"); card.setAttribute("aria-label", "Background commands"); card.style.minHeight = "32px";
  const line = document.createElement("div"); line.setAttribute("aria-label", "Background command: Read status");
  const icon = document.createElement("span"); icon.dataset.icon = "Terminal"; line.append(icon); card.append(line); composer.append(card); pane.append(composer); document.body.append(pane);
  const state = vi.fn(); const binding = bindActivityHeader(anchor, state); disposers.push(binding.dispose); proxy.onclick = binding.toggle;
  return {pane, header, anchor, proxy, card, composer, state, binding};
}
describe("background card in the header", () => {
  it("starts hidden, opens only its pane, closes on Escape/outside, restores focus and attributes", async () => {
    disposers.push(mountSidebarControls()); const f = activity(), other = activity("two");
    expect(getComputedStyle(f.card).display).toBe("none");
    f.proxy.click(); expect(getComputedStyle(f.card).position).toBe("fixed"); expect(other.card.dataset.bbActivityOpen).toBe("false");
    f.proxy.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true,cancelable:true}));
    expect(f.card.dataset.bbActivityOpen).toBe("false"); expect(document.activeElement).toBe(f.proxy);
    f.binding.toggle(); document.body.dispatchEvent(new Event("pointerdown", {bubbles:true})); expect(f.card.dataset.bbActivityOpen).toBe("false");
    f.binding.dispose(); f.binding.dispose(); expect(f.card.hasAttribute("data-bb-activity-card")).toBe(false); expect(f.card.hasAttribute("id")).toBe(false); expect(f.card.style.minHeight).toBe("32px");
  });
  it("expands the native descriptions without invoking a command and preserves external menus", () => {
    const f = activity(), native = document.createElement("button"); native.id = "thread-background-commands-card-toggle"; native.setAttribute("aria-expanded","false");
    const click = vi.fn(() => native.setAttribute("aria-expanded","true")); native.onclick = click; f.card.append(native);
    f.binding.toggle(); expect(click).toHaveBeenCalledTimes(1);
    const menu = document.createElement("div"); menu.setAttribute("role","menu"); document.body.append(menu); menu.dispatchEvent(new Event("pointerdown",{bubbles:true}));
    expect(f.card.dataset.bbActivityOpen).toBe("true");
  });
  it("restores detached cards and rebinds replacements, leaving unknown cards untouched", async () => {
    const f = activity(); const old = f.card; const replacement = old.cloneNode(true) as HTMLElement;
    replacement.removeAttribute("id"); replacement.removeAttribute("data-bb-activity-card"); replacement.removeAttribute("data-bb-activity-open");
    old.replaceWith(replacement);
    await waitFor(() => expect(replacement.hasAttribute("data-bb-activity-card")).toBe(true));
    expect(old.hasAttribute("data-bb-activity-card")).toBe(false);
    replacement.remove(); await waitFor(() => expect(f.state).toHaveBeenLastCalledWith(null));
    const unknown = document.createElement("section"); unknown.setAttribute("aria-label","Unknown plugin"); f.composer.append(unknown);
    await new Promise(r => setTimeout(r,0)); expect(unknown.attributes.length).toBe(1);
  });
});
