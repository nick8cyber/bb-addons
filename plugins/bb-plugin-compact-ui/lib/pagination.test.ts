import { describe, expect, it } from "vitest";
import { createPageState, pageSteps, reconcilePages, setPageBudget } from "./pagination";
import { groupSidebarThreads, type GroupingThread } from "./thread-groups";

describe("paging budgets", () => {
  it.each([3, 10, 12])("uses decade boundaries from %s", base => {
    const first = pageSteps(base, base, 137);
    expect(first.next).toBe(base < 10 ? 10 : 20);
    expect(pageSteps(base, first.next, 137).next).toBe(first.next + 10);
  });
  it("moves through 27 roots and back, retaining the last full budget", () => {
    let budget = 3;
    const shown = [3];
    while (pageSteps(3, budget, 27).more > 0) {
      budget = pageSteps(3, budget, 27).next;
      shown.push(Math.min(budget, 27));
    }
    expect(budget).toBe(30);
    while (budget > 3) {
      budget = pageSteps(3, budget, 27).previous;
      shown.push(Math.min(budget, 27));
    }
    expect(shown).toEqual([3, 10, 20, 27, 20, 10, 3]);
    expect(pageSteps(3, 20, 27).more).toBe(7);
  });
  it("has no cap at 100", () => {
    expect(pageSteps(3, 130, 137)).toMatchObject({next:140,more:7});
    expect(pageSteps(3, 140, 137).previous).toBe(130);
  });
  it.each([0, 2, 3, 5, 12, 27])("shrinking to %s has no hollow back-step or loop", count => {
    expect(pageSteps(3, 30, count).previous).toBe(count < 10 ? 3 : count < 20 ? 10 : 20);
  });
  it("zero means all with no controls", () => {
    expect(pageSteps(0, 0, 137)).toMatchObject({more:0,canLess:false});
  });
  it("keeps groups independent and resets permanently on 3→5→3", () => {
    const a = setPageBudget(createPageState(3), "project:a", 20);
    expect(a.budgets.get("project:b")).toBeUndefined();
    const b = reconcilePages(a, 5, ["a"], true);
    const c = reconcilePages(b, 3, ["a"], true);
    expect(c.budgets.size).toBe(0);
    expect(a.budgets.get("project:a")).toBe(20); // immutable
  });
  it("prunes only ready project IDs, preserving loading and empty thread snapshots", () => {
    const state = setPageBudget(createPageState(3), "project:a", 20);
    expect(reconcilePages(state, 3, [], false)).toBe(state);
    expect(reconcilePages(state, 3, ["a"], true)).toBe(state);
    expect(reconcilePages(state, 3, [], true).budgets.size).toBe(0);
  });
});

it("counts protected roots outside the budget, children outside the counter, and preserves order", () => {
  const make = (id: string, extra: Partial<GroupingThread> = {}): GroupingThread => ({
    id,projectId:"p",title:id,titleFallback:null,parentThreadId:null,
    hasPendingInteraction:false,indicator:"none",isUnread:false,isPinned:false,
    isArchived:false,updatedAt:0,latestAttentionAt:0,createdAt:0,...extra,
  });
  const threads = [
    make("pin",{isPinned:true}), make("attention",{hasPendingInteraction:true}),
    make("parent"), make("child",{parentThreadId:"parent"}),
    ...Array.from({length:27},(_,i)=>make("ordinary"+String(i).padStart(2,"0"))),
  ];
  const input = {threads,projects:[{id:"p",name:"P",isPersonal:false}],
    activeThreadId:"child",limit:3,keepAttention:true,
    groupBudgets:new Map<string,number>(),foldedProjectIds:new Set<string>()};
  const first = groupSidebarThreads(input)[0]!;
  expect(first.shownCount).toBe(6);
  expect(first.rows.length).toBe(7);
  expect(first.ordinaryCount).toBe(27);
  const second = groupSidebarThreads({...input,groupBudgets:new Map([["project:p",10]])})[0]!;
  expect(second.shownCount).toBe(13);
  expect(second.hiddenCount).toBe(17);
  expect(second.rows.filter(r=>r.depth===0).map(r=>r.thread.id))
    .toEqual(expect.arrayContaining(first.rows.filter(r=>r.depth===0).map(r=>r.thread.id)));
});
