// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { enforce } from "./composer-cap";

/** jsdom has no layout — stub geometry per element via props. */
function box(el: Element, top: number, height: number) {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ top, bottom: top + height, height, width: 390, left: 0, right: 390, x: 0, y: top, toJSON: () => ({}) }),
    configurable: true,
  });
}

function buildDom(opts: { rows: number; rowH?: number; queueH?: number }) {
  const { rows, rowH = 60, queueH } = opts;
  const card = document.createElement("div");
  card.setAttribute("data-app-composer", "");
  const editor = document.createElement("div");
  editor.className = "overflow-y-auto";
  const pm = document.createElement("div");
  pm.className = "ProseMirror";
  editor.appendChild(pm);
  const frame = document.createElement("div");
  frame.setAttribute("data-queued-messages-scroll-frame", "");
  const scroll = document.createElement("div");
  scroll.setAttribute("data-queued-messages-scroll", "");
  scroll.style.paddingTop = "4px";
  scroll.style.paddingBottom = "12px";
  const ul = document.createElement("ul");
  ul.style.paddingTop = "4px";
  const lis: HTMLElement[] = [];
  let top = 0;
  for (let i = 0; i < rows; i++) {
    const li = document.createElement("li");
    box(li, top, rowH);
    top += rowH;
    ul.appendChild(li);
    lis.push(li);
  }
  scroll.appendChild(ul);
  frame.appendChild(scroll);
  card.appendChild(frame);
  card.appendChild(editor);
  document.body.appendChild(card);
  Object.defineProperty(ul, "scrollHeight", { value: rows * rowH + 4, configurable: true });
  const realQH = queueH ?? rows * rowH + 16 + 4;
  box(scroll, 0, realQH);
  box(frame, 0, realQH);
  box(editor, 0, 200);
  box(card, 400, 420); // card content = editor 200 + queue 220
  Object.defineProperty(editor, "scrollHeight", { value: 200, configurable: true });
  return { card, editor, scroll, frame, lis };
}

const win = { innerHeight: 932 } as Window; // cap = floor((932-96)/3) = 278

/* jsdom keeps appended cards in document.body across tests — a stale card's
   mocked queue heights leak into parent-scope candidate picks otherwise. */
afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-cap-debug");
});

describe("enforce: expanded queue shows exactly min(N,3) items", () => {
  it("2 items → height of both + paddings", () => {
    const { card, scroll, frame } = buildDom({ rows: 2 });
    enforce(card, win);
    // 2*60 rows + scroll padY 16 + ul padY 4 = 140
    expect(scroll.style.maxHeight).toBe("140px");
    expect(frame.style.maxHeight).toBe("140px");
  });
  it("5 items → height of first 3 + paddings", () => {
    const { card, scroll } = buildDom({ rows: 5 });
    enforce(card, win);
    expect(scroll.style.maxHeight).toBe("200px"); // 3*60+16+4
  });
  it("1 item → single row", () => {
    const { card, scroll } = buildDom({ rows: 1 });
    enforce(card, win);
    expect(scroll.style.maxHeight).toBe("80px"); // 60+16+4
  });
  it("collapsed queue (0 height) → no clamp, nothing resurrected", () => {
    const { card, scroll, frame } = buildDom({ rows: 2, queueH: 0 });
    enforce(card, win);
    expect(scroll.style.maxHeight).toBe("");
    expect(frame.style.maxHeight).toBe("");
  });
  it("editor clamps when natural card height exceeds cap", () => {
    const { card, editor } = buildDom({ rows: 1 });
    enforce(card, win);
    // card 420 > cap 278 → desired = max(104, 200-(420-278)) = 104
    expect(editor.style.maxHeight).toBe("104px");
  });
  it("clears clamps when card fits under cap", () => {
    const { card, editor, scroll } = buildDom({ rows: 1 });
    box(card, 0, 100); // small card
    enforce(card, win);
    expect(editor.style.maxHeight).toBe("");
    // queue clamp is unconditional: 1 row still bounded
    expect(scroll.style.maxHeight).toBe("80px");
  });
  it("grows only the queue's own section, slack from in-section siblings", () => {
    const { card, scroll, frame } = buildDom({ rows: 2 });
    box(scroll, 0, 103);
    box(frame, 0, 103);
    // Real host shape: section > [header 30 + frame]; the grid/card above
    // must never get a min-height — it stretch-inflates sibling tracks.
    const section = document.createElement("section");
    const header = document.createElement("div");
    box(header, 0, 30);
    card.removeChild(frame);
    section.appendChild(header);
    section.appendChild(frame);
    card.insertBefore(section, card.firstChild);
    box(section, 0, 140);
    enforce(card, win);
    // needed frame 140 + header slack 30 = 170 > 140 → grown on the section
    expect(section.style.minHeight).toBe("170px");
    expect(card.style.minHeight).toBe("");
    // Header collapses (idle state) → slack 0 → want 140 ≤ h → released
    box(header, 0, 0);
    enforce(card, win);
    expect(section.style.minHeight).toBe("140px");
    // queue collapse → everything cleared
    box(scroll, 0, 0);
    enforce(card, win);
    expect(section.style.minHeight).toBe("");
    expect(scroll.style.maxHeight).toBe("");
  });
  it("editor cap skips ProseMirror/scroll inside the queue (inline edit)", () => {
    const { card, scroll, frame, editor } = buildDom({ rows: 2 });
    // Inline edit open: the row holds an overflow-auto wrapper with .ProseMirror
    const qWrap = document.createElement("div");
    qWrap.className = "overflow-y-auto";
    const qPm = document.createElement("div");
    qPm.className = "ProseMirror";
    qWrap.appendChild(qPm);
    scroll.appendChild(qWrap);
    box(card, 400, 420); // over cap → editor must be clamped, queue scroll not
    enforce(card, win);
    expect(scroll.style.maxHeight).toBe("140px"); // queue clamp intact
    expect(editor.style.maxHeight).toBe("104px"); // cap hit the REAL editor
    expect(qWrap.style.maxHeight).toBe("");       // queue's own scroll untouched
  });
  it("dividers (h-0, marked) are not counted as items", () => {
    const { card, scroll, lis } = buildDom({ rows: 3 });
    lis[1].setAttribute("data-queued-message-group-divider", "");
    enforce(card, win);
    // 2 реальных сообщения — 1-е и 3-е li; высота до низа 3-го = 180 + pads 20
    expect(scroll.style.maxHeight).toBe("200px");
  });
  it("removes all queue and section grants while an inline editor is mounted", () => {
    const { card, scroll, frame, lis } = buildDom({ rows: 2 });
    const section = document.createElement("section");
    card.removeChild(frame);
    section.appendChild(frame);
    card.insertBefore(section, card.firstChild);
    box(scroll, 0, 103);
    box(frame, 0, 103);
    box(section, 0, 103);

    enforce(card, win);
    expect(scroll.style.maxHeight).toBe("140px");
    expect(frame.style.maxHeight).toBe("140px");
    expect(section.style.minHeight).toBe("140px");

    lis[0].setAttribute("data-queued-message-inline-editor", "");
    // The host pins the section/frame to an explicit pixel height
    // (expand transition + stored resize) — stale dead space while editing.
    // Cleared only when it exceeds natural content (+8): a correct pin stays.
    Object.defineProperty(scroll, "scrollHeight", { value: 140, configurable: true });
    section.style.height = "585px";
    frame.style.height = "300px";
    enforce(card, win);
    expect(scroll.style.maxHeight).toBe("");
    expect(frame.style.maxHeight).toBe("");
    expect(section.style.minHeight).toBe("");
    expect(section.style.height).toBe("");
    expect(frame.style.height).toBe("");

    // A correct host pin (<= natural + 8) survives — no oscillation.
    // buildDom gives the scroll the host padding pt-1 pb-3 = 16px, so the
    // threshold here exercises padY(queue) being included in natural height.
    section.style.height = "140px";
    enforce(card, win);
    expect(section.style.height).toBe("140px");

    // Pin-stretched scroll: its own scrollHeight reports the inflated
    // clientHeight, so the stale pin would confirm itself — the natural
    // height must be read from the <ul> content instead. scrollHeight is
    // set equal to the pin (clientHeight): an implementation reading the
    // scroll's own scrollHeight would wrongly keep the pin.
    Object.defineProperty(scroll, "scrollHeight", { value: 585, configurable: true });
    box(scroll, 0, 585);
    Object.defineProperty(scroll.firstElementChild, "scrollHeight", { value: 140, configurable: true });
    section.style.height = "585px";
    enforce(card, win);
    expect(section.style.height).toBe("");

    // If the <ul> itself stretches under the pin (host reserve lives in
    // content), natural height inflates equally — the pin is kept
    // (fail-safe: never clear what is not provably stale).
    Object.defineProperty(scroll.firstElementChild, "scrollHeight", { value: 585, configurable: true });
    section.style.height = "585px";
    enforce(card, win);
    expect(section.style.height).toBe("585px");
    Object.defineProperty(scroll.firstElementChild, "scrollHeight", { value: 124, configurable: true });
    Object.defineProperty(scroll, "scrollHeight", { value: 140, configurable: true });

    // Collapsed queue keeps its pin even with the editor mounted —
    // clearing it would expand the panel.
    box(scroll, 0, 0);
    section.style.height = "44px";
    enforce(card, win);
    expect(section.style.height).toBe("44px");
    box(scroll, 0, 103);

    lis[0].removeAttribute("data-queued-message-inline-editor");
    enforce(card, win);
    expect(scroll.style.maxHeight).toBe("140px");
    expect(frame.style.maxHeight).toBe("140px");
    expect(section.style.minHeight).toBe("140px");
  });
  it("clears only px-format pins and only beyond natural+8 — boundary on scroll, frame, section", () => {
    const { card, scroll, frame, lis } = buildDom({ rows: 2 });
    const section = document.createElement("section");
    card.removeChild(frame);
    section.appendChild(frame);
    card.insertBefore(section, card.firstChild);
    box(scroll, 0, 140);
    box(frame, 0, 140);
    box(section, 0, 140);
    lis[0].setAttribute("data-queued-message-inline-editor", "");
    // natural heights here: qContent = ul 124 + padY(queue) 16 = 140;
    // jsdom padY(frame)=padY(section)=0, no siblings → naturalFrame = naturalSec = 140.

    // Non-px values are host-owned (resize/percent layout) — never touched.
    // Values above the natural+8 threshold so a naive parseFloat would evict them.
    scroll.style.height = "200%";
    frame.style.height = "200%";
    section.style.height = "200%";
    enforce(card, win);
    expect(scroll.style.height).toBe("200%");
    expect(frame.style.height).toBe("200%");
    expect(section.style.height).toBe("200%");

    // Boundary: pin == natural + 8 survives, pin == natural + 9 is cleared.
    scroll.style.height = "148px";
    frame.style.height = "148px";
    section.style.height = "148px";
    enforce(card, win);
    expect(scroll.style.height).toBe("148px");
    expect(frame.style.height).toBe("148px");
    expect(section.style.height).toBe("148px");
    scroll.style.height = "149px";
    frame.style.height = "149px";
    section.style.height = "149px";
    enforce(card, win);
    expect(scroll.style.height).toBe("");
    expect(frame.style.height).toBe("");
    expect(section.style.height).toBe("");
  });
  it("without a frame wrapper the scroll padY is counted once, not twice", () => {
    const { card, scroll, frame, lis } = buildDom({ rows: 2 });
    card.removeChild(frame);
    const section = document.createElement("section");
    section.appendChild(scroll);
    card.insertBefore(section, card.firstChild);
    box(scroll, 0, 140);
    box(section, 0, 140);
    lis[0].setAttribute("data-queued-message-inline-editor", "");
    // natural = qContent 140 + padY(section 0) + 0 siblings = 140.
    // A double padY(queue) would raise the threshold to 164 and keep 149.
    section.style.height = "149px";
    enforce(card, win);
    expect(section.style.height).toBe("");
  });
  it("reconciles grown section grant down to want after large row/editor closes (delta ~ 0)", () => {
    const { card, scroll, frame, lis } = buildDom({ rows: 2 });
    const section = document.createElement("section");
    card.removeChild(frame);
    section.appendChild(frame);
    card.insertBefore(section, card.firstChild);

    // Initial state: row 0 was large (300px), requiring a large grant (380px)
    box(lis[0], 0, 300);
    box(lis[1], 300, 60);
    box(scroll, 0, 103);
    box(frame, 0, 103);
    box(section, 0, 103);
    enforce(card, win);
    expect(section.style.minHeight).toBe("380px");

    // Editor closes / row shrinks back to 60px.
    // scroll reports 140px (roomBefore = 140, queueMax = 140 -> delta = 0).
    // Section still holds 380px from previous grant.
    box(lis[0], 0, 60);
    box(lis[1], 60, 60);
    box(scroll, 0, 140);
    box(frame, 0, 140);
    box(section, 0, 380);

    enforce(card, win);
    // Overinflated grant must be reconciled down to actual want (140px)
    expect(section.style.minHeight).toBe("140px");
  });
});
