// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread, PluginSidebarProject } from "@get-bb/plugin-sdk/app";

const input = vi.hoisted(() => ({
  settings: { visibleThreads: 3, keepAttention: false } as Record<string, unknown>,
  sidebar: null as ReturnType<typeof import("@get-bb/plugin-sdk/app").experimental_useSidebarThreads> | null,
}));
vi.mock("@get-bb/plugin-sdk/app", async original => {
  const sdk = await original<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...sdk,
    useSettings: () => ({ values: input.settings }),
    experimental_useSidebarThreads: () => input.sidebar!,
  };
});
function makeThread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: overrides.id ?? "thread-1",
    projectId: overrides.projectId ?? "proj-1",
    title: overrides.title !== undefined ? overrides.title : "Thread 1",
    titleFallback:
      overrides.titleFallback !== undefined ? overrides.titleFallback : null,
    parentThreadId:
      overrides.parentThreadId !== undefined ? overrides.parentThreadId : null,
    sectionId: overrides.sectionId !== undefined ? overrides.sectionId : null,
    originKind:
      overrides.originKind !== undefined ? overrides.originKind : null,
    originPluginId:
      overrides.originPluginId !== undefined ? overrides.originPluginId : null,
    providerId: overrides.providerId ?? "provider-1",
    hasPendingInteraction: overrides.hasPendingInteraction ?? false,
    activity: overrides.activity ?? { kind: "idle" },
    indicator: overrides.indicator ?? "none",
    indicatorLabel:
      overrides.indicatorLabel !== undefined ? overrides.indicatorLabel : null,
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    isArchived: overrides.isArchived ?? false,
    environment:
      overrides.environment !== undefined ? overrides.environment : null,
    host: overrides.host !== undefined ? overrides.host : null,
    createdAt: overrides.createdAt ?? 1000,
    updatedAt: overrides.updatedAt ?? 2000,
    lastReadAt:
      overrides.lastReadAt !== undefined ? overrides.lastReadAt : null,
    latestAttentionAt: overrides.latestAttentionAt ?? 2000,
    ...overrides,
  };
}

function makeProject(
  overrides: Partial<PluginSidebarProject> = {},
): PluginSidebarProject {
  return {
    id: overrides.id ?? "proj-1",
    name: overrides.name ?? "Project One",
    isPersonal: overrides.isPersonal ?? false,
    ...overrides,
  };
}


let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => { app = await loadPluginApp(() => import("./app")); }, 60_000);
afterEach(cleanup);

function mount(base = 3) {
  input.settings = { visibleThreads: base, keepAttention: false };
  const threads = Array.from({length:27}, (_,i)=>makeThread({id:"a"+i,title:"Chat "+i,updatedAt:1000-i,latestAttentionAt:1000-i}));
  input.sidebar = {status:"ready",threads,projects:[makeProject()]} as NonNullable<typeof input.sidebar>;
  const onNavigate = vi.fn();
  let props = {activeThreadId:null as string|null,activeProjectId:null,isCompactViewport:false,onNavigate,searchQuery:"",Original:()=> <div>Native list</div>};
  const registration = app.threadLists[0]!;
  const Component = registration.component;
  const slot = renderSlot(registration,props);
  return {
    slot,threads,onNavigate,
    more:()=>slot.getByRole("button",{name:/^Ещё .* — Project One$/}),
    less:()=>slot.getByRole("button",{name:"Меньше — Project One"}),
    count:()=>slot.container.querySelectorAll("a[data-sidebar-thread-id]").length,
    refresh:(update?:Partial<typeof props>)=>{
      props={...props,...update};
      slot.lifecycle.rerender(<Component {...props}/>);
    },
  };
}

describe("pagination UI and immutable host snapshots", () => {
  it("3→10→20→27→20→10→3, exact counts, stable DOM, focus and no navigation", () => {
    const t=mount();
    const first=t.slot.container.querySelector("a[data-sidebar-thread-id]");
    const counts=[t.count()];
    for(let i=0;i<3;i++) {
      t.more().focus(); fireEvent.click(t.more()); counts.push(t.count());
      expect(t.slot.container.querySelector("a[data-sidebar-thread-id]")).toBe(first);
    }
    expect(document.activeElement).toBe(t.less());
    expect(t.slot.queryByRole("button",{name:/^Ещё/})).toBeNull();
    expect(t.slot.getByText("27 из 27")).toBeTruthy();
    for(let i=0;i<3;i++) { t.less().focus();fireEvent.click(t.less());counts.push(t.count()); }
    expect(counts).toEqual([3,10,20,27,20,10,3]);
    expect(document.activeElement).toBe(t.more());
    expect(t.onNavigate).not.toHaveBeenCalled();
    expect(t.slot.inspection.navigateCalls).toEqual([]);
    expect(t.slot.inspection.sidebarActionCalls).toEqual([]);
  });
  it("both buttons share one row and folding preserves the chosen page", () => {
    const t=mount();fireEvent.click(t.more());fireEvent.click(t.more());
    expect(t.more().parentElement).toBe(t.less().parentElement);
    expect(t.more().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(t.slot.getByRole("button",{name:"Collapse Project One"}));
    expect(t.count()).toBe(0);
    fireEvent.click(t.slot.getByRole("button",{name:"Expand Project One"}));
    expect(t.count()).toBe(20);
  });
  it("host B 3→5→3 resets permanently without resurrecting20", () => {
    const t=mount();fireEvent.click(t.more());fireEvent.click(t.more());
    input.settings={...input.settings,visibleThreads:5};t.refresh();expect(t.count()).toBe(5);
    input.settings={...input.settings,visibleThreads:3};t.refresh();expect(t.count()).toBe(3);
    expect(t.slot.queryByRole("button",{name:/Меньше/})).toBeNull();
  });
  it("realtime, loading, error, temporary empty snapshots and active route preserve budget", () => {
    const t=mount();fireEvent.click(t.more());fireEvent.click(t.more());
    const original=input.sidebar!;
    for(const status of ["loading","error","ready"] as const) {
      input.sidebar={...original,status,threads:[]};t.refresh();
    }
    input.sidebar={...original,threads:[...original.threads]};t.refresh({activeThreadId:"a0"});
    // Active root is protected outside the20 ordinary-root budget.
    expect(t.count()).toBe(21);
    t.refresh({activeThreadId:null});expect(t.count()).toBe(20);
  });
  it("shrinking30→12 jumps straight to10; below B folds without losing keyboard focus", () => {
    const t=mount();for(let i=0;i<3;i++)fireEvent.click(t.more());
    input.sidebar={...input.sidebar!,threads:t.threads.slice(0,12)};t.refresh();
    t.less().focus();fireEvent.click(t.less());expect(t.count()).toBe(10);
    input.sidebar={...input.sidebar!,threads:t.threads.slice(0,2)};t.refresh();
    t.less().focus();fireEvent.click(t.less());expect(t.count()).toBe(2);
    expect(t.slot.container.querySelector("[data-sidebar-pagination]")).toBeNull();
    expect(document.activeElement).toBe(t.slot.getByRole("button",{name:"Collapse Project One"}));
  });
  it("prunes removed projects only when ready", () => {
    const t=mount();fireEvent.click(t.more());fireEvent.click(t.more());
    const original=input.sidebar!;
    input.sidebar={...original,status:"loading",projects:[],threads:[]};t.refresh();
    input.sidebar={...original};t.refresh();expect(t.count()).toBe(20);
    input.sidebar={...original,projects:[],threads:[]};t.refresh();
    input.sidebar={...original};t.refresh();expect(t.count()).toBe(3);
  });
  it("keeps two project budgets independent", () => {
    const t=mount();
    input.sidebar={...input.sidebar!,projects:[makeProject(),makeProject({id:"p2",name:"Second"})],
      threads:[...t.threads,...t.threads.map(x=>({...x,id:"b"+x.id,projectId:"p2"}))]};
    t.refresh();fireEvent.click(t.more());
    const second=t.slot.container.querySelector('[data-sidebar-project="p2"]')!;
    expect(second.querySelectorAll("a[data-sidebar-thread-id]").length).toBe(3);
    expect(t.count()).toBe(13);
  });
  it.each([10,12])("B=%s first expands to20", base => {
    const t=mount(base);expect(t.count()).toBe(base);fireEvent.click(t.more());expect(t.count()).toBe(20);
  });
});
