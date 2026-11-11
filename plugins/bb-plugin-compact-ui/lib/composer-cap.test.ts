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
  it("grows panel ancestors only when constrained, slack from real siblings", () => {
    const { card, scroll, frame } = buildDom({ rows: 2 });
    box(scroll, 0, 103);
    box(frame, 0, 103);
    // Tight panel (140) with a 30px sibling bar beside the frame.
    const panel = document.createElement("div");
    const sibling = document.createElement("div");
    box(sibling, 0, 30);
    card.removeChild(frame);
    panel.appendChild(sibling);
    panel.appendChild(frame);
    card.insertBefore(panel, card.firstChild);
    box(panel, 0, 140);
    enforce(card, win);
    // needed 140 + sibling slack 30 = 170 > 140 → grown
    expect(panel.style.minHeight).toBe("170px");
    // Sibling collapses (idle state) → slack 0 → want 140 ≤ h → released
    box(sibling, 0, 0);
    enforce(card, win);
    expect(panel.style.minHeight).toBe("140px");
    // queue collapse → everything cleared
    box(scroll, 0, 0);
    enforce(card, win);
    expect(panel.style.minHeight).toBe("");
    expect(scroll.style.maxHeight).toBe("");
  });
  it("dividers (h-0, marked) are not counted as items", () => {
    const { card, scroll, lis } = buildDom({ rows: 3 });
    lis[1].setAttribute("data-queued-message-group-divider", "");
    enforce(card, win);
    // 2 реальных сообщения — 1-е и 3-е li; высота до низа 3-го = 180 + pads 20
    expect(scroll.style.maxHeight).toBe("200px");
  });
});
