// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
const testViewport = vi.hoisted(() => ({ compact: false }));
vi.mock("./components/ui/hooks/use-compact-viewport.js", () => ({ useIsCompactViewport: () => testViewport.compact }));
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

let appPromise: ReturnType<typeof loadPluginApp>;
beforeAll(async () => {
  appPromise = loadPluginApp(() => import("./app"));
  await appPromise;
}, 60_000);

afterEach(() => {
  testViewport.compact = false;
  cleanup();
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


describe("persistent row controls", () => {
  const oldClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (oldClipboard) Object.defineProperty(navigator, "clipboard", oldClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    vi.restoreAllMocks();
  });
  async function rowFixture(compact = false, personal = false) {
    testViewport.compact = compact;
    const app = await appPromise;
    const onNavigate = vi.fn();
    const slot = renderSlot(app.threadLists[0]!, {
      activeThreadId: null, activeProjectId: null, isCompactViewport: compact,
      onNavigate, searchQuery: "", Original: () => <div>native</div>,
    }, {
      settings: { visibleThreads: 3, keepAttention: false },
      sidebarThreads: { status: "ready", threads: [makeThread()], projects: [makeProject({isPersonal: personal})] },
    });
    return {slot, onNavigate, row: slot.container.querySelector('a[data-sidebar-thread-id="thread-1"]')!};
  }
  it.each([false, true])("renders Copy -> More without a quick archive (compact=%s)", async compact => {
    const {row} = await rowFixture(compact);
    const buttons = [...row.querySelectorAll<HTMLButtonElement>("button[data-bb-sidebar-row-action]")];
    expect(buttons.map(b=>b.dataset.bbSidebarRowAction)).toEqual(["copy","menu"]);
    for (const b of buttons) {
      expect(b.className).toContain("opacity-100");
      expect(b.className).not.toContain("opacity-0");
      expect(b.className).toContain(compact ? "size-7" : "size-6");
    }
  });
  it.each([false, true])("copies the canonical URL and never navigates (personal=%s)", async personal => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
    const {slot,row,onNavigate} = await rowFixture(false,personal);
    fireEvent.click(row.querySelector('[data-bb-sidebar-row-action="copy"]')!);
    await waitFor(()=>expect(writeText).toHaveBeenCalledExactlyOnceWith(new URL(
      personal ? "/threads/thread-1" : "/projects/proj-1/threads/thread-1", window.location.origin).toString()));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
  });
  it.each(["missing","rejected"])("reports clipboard %s without navigating", async kind => {
    const error = vi.spyOn(toast,"error").mockReturnValue("test-toast");
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:kind==="missing"?undefined:{writeText:vi.fn().mockRejectedValue(Error("denied"))}});
    const {row,onNavigate}=await rowFixture();
    fireEvent.click(row.querySelector('[data-bb-sidebar-row-action="copy"]')!);
    await waitFor(()=>expect(error).toHaveBeenCalledWith("Failed to copy thread link"));
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it("keeps archive in More on the host action without navigation", async () => {
    const {slot,row,onNavigate}=await rowFixture();
    expect(row.querySelector('[data-bb-sidebar-row-action="archive"]')).toBeNull();
    fireEvent.pointerDown(row.querySelector('[data-bb-sidebar-row-action="menu"]')!,{button:0,ctrlKey:false,pointerType:"mouse"});
    expect(await slot.findByText("Copy thread link")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", {name: "Archive"}));
    expect(slot.inspection.sidebarActionCalls).toContainEqual({method:"archive",threadId:"thread-1"});
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it("hides controls during inline rename", async () => {
    const {row}=await rowFixture();
    fireEvent.doubleClick(row.querySelector("span.min-w-0")!);
    expect(row.querySelectorAll("[data-bb-sidebar-row-action]")).toHaveLength(0);
  });
  it("opens compact More on click without cancelling its trigger or navigating", async () => {
    const {row,onNavigate}=await rowFixture(true);
    fireEvent.click(row.querySelector('[data-bb-sidebar-row-action="menu"]')!);
    expect(await screen.findByRole("menuitem",{name:"Copy thread link"})).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it("does not hijack Enter from nested buttons into opening the thread", async () => {
    const {slot,row,onNavigate}=await rowFixture();
    for(const action of ["copy"]) {
      expect(fireEvent.keyDown(row.querySelector(`[data-bb-sidebar-row-action="${action}"]`)!,{key:"Enter"})).toBe(true);
    }
    fireEvent.keyDown(row.querySelector('[data-bb-sidebar-row-action="menu"]')!,{key:"Enter"});
    expect(await screen.findByRole("menuitem",{name:"Copy thread link"})).toBeTruthy();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it("still opens a thread when Enter is pressed on the row itself", async () => {
    const {slot,row,onNavigate}=await rowFixture();
    fireEvent.keyDown(row,{key:"Enter"});
    expect(slot.inspection.sidebarActionCalls).toContainEqual({method:"open",threadId:"thread-1"});
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("bb-plugin-sidebar-collapse frontend tests", () => {
  it("does not crash without Original on current BB and offers native fallback", async () => {
    const app = await appPromise;
    const registration = app.threadLists[0]!;
    const Component = registration.component;
    let called = false;
    const slot = renderSlot({ ...registration, component: props => <Component {...props} Original={undefined as never} /> }, {
      activeThreadId: null, activeProjectId: null, isCompactViewport: false,
      onNavigate: () => {}, searchQuery: "", Original: () => <div>old host</div>,
    }, {
      settings: { useCollapsedList: false },
      sidebarThreads: { status: "error", projects: [], threads: [] },
      rpc: { show_native_list: () => { called = true; return { ok: true }; } },
    });
    fireEvent.click(await slot.findByText("Показать штатный список BB"));
    expect(called).toBe(true);
    slot.lifecycle.unmount();
  });
  it.each([false, true])("renders unreadFirst=%s through plugin settings", async (unreadFirst) => {
    const app = await appPromise;
    const slot = renderSlot(app.threadLists[0]!, {
      activeThreadId: null, activeProjectId: null, isCompactViewport: false,
      onNavigate: () => {}, searchQuery: "", Original: () => <div>bb list</div>,
    }, {
      settings: { unreadFirst, visibleThreads: 1, keepAttention: false },
      sidebarThreads: {
        status: "ready", projects: [makeProject()],
        threads: [
          makeThread({ id: "read", title: "Read thread", updatedAt: 10000, latestAttentionAt: 10000 }),
          makeThread({ id: "unread", title: "Unread thread", isUnread: true, updatedAt: 1, latestAttentionAt: 1 }),
        ],
      },
    });
    const rowIds = () => Array.from(slot.container.querySelectorAll("a[data-sidebar-thread-id]"))
      .map((row) => row.getAttribute("data-sidebar-thread-id"));
    expect(rowIds()).toEqual(unreadFirst ? ["unread"] : ["read"]);
    fireEvent.click(slot.getByText("Ещё 1"));
    expect(rowIds()).toEqual(unreadFirst ? ["unread", "read"] : ["read", "unread"]);
  });

  it("renders 5 threads and 'Ещё 3' when there are 8 threads and visibleThreads is 5", async () => {
    const app = await appPromise;
    const threads = Array.from({ length: 8 }, (_, i) =>
      makeThread({
        id: `t-${i + 1}`,
        title: `Thread ${i + 1}`,
        projectId: "proj-1",
      }),
    );
    const projects = [makeProject({ id: "proj-1", name: "Project One" })];

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        settings: { visibleThreads: 5, keepAttention: true },
        sidebarThreads: { status: "ready", threads, projects },
      },
    );

    for (let i = 1; i <= 5; i++) {
      expect(slot.queryByText(`Thread ${i}`)).toBeTruthy();
    }
    for (let i = 6; i <= 8; i++) {
      expect(slot.queryByText(`Thread ${i}`)).toBeNull();
    }

    expect(slot.queryByText("Ещё 3")).toBeTruthy();
  });

  it("expands to show all 8 threads on 'Show more' click, changes to 'Show less', and collapses on second click", async () => {
    const app = await appPromise;
    const threads = Array.from({ length: 8 }, (_, i) =>
      makeThread({
        id: `t-${i + 1}`,
        title: `Thread ${i + 1}`,
        projectId: "proj-1",
      }),
    );
    const projects = [makeProject({ id: "proj-1", name: "Project One" })];

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        settings: { visibleThreads: 5, keepAttention: true },
        sidebarThreads: { status: "ready", threads, projects },
      },
    );

    const showMoreButton = slot.getByRole("button", {
      name: /Ещё 3/,
    });
    fireEvent.click(showMoreButton);

    for (let i = 1; i <= 8; i++) {
      expect(slot.queryByText(`Thread ${i}`)).toBeTruthy();
    }

    const showLessButton = slot.getByRole("button", { name: /Меньше/ });
    expect(showLessButton).toBeTruthy();

    fireEvent.click(showLessButton);

    for (let i = 1; i <= 5; i++) {
      expect(slot.queryByText(`Thread ${i}`)).toBeTruthy();
    }
    for (let i = 6; i <= 8; i++) {
      expect(slot.queryByText(`Thread ${i}`)).toBeNull();
    }
    expect(slot.queryByText("Ещё 3")).toBeTruthy();
  });

  it("records { method: 'open', threadId: id } on thread row click", async () => {
    const app = await appPromise;
    const threads = [
      makeThread({ id: "t-1", title: "Thread 1", projectId: "proj-1" }),
    ];
    const projects = [makeProject({ id: "proj-1", name: "Project One" })];

    let navigated = false;
    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {
          navigated = true;
        },
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        settings: { visibleThreads: 5, keepAttention: true },
        sidebarThreads: { status: "ready", threads, projects },
      },
    );

    const row = slot.container.querySelector('a[data-sidebar-thread-id="t-1"]');
    expect(row).toBeTruthy();
    fireEvent.click(row!);

    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "t-1",
    });
    expect(navigated).toBe(true);
  });

  it("calls setPinned with { method: 'setPinned', threadId, pinned: true } on Pin menu item", async () => {
    const app = await appPromise;
    const threads = [
      makeThread({
        id: "t-1",
        title: "Thread 1",
        projectId: "proj-1",
        isPinned: false,
      }),
    ];
    const projects = [makeProject({ id: "proj-1", name: "Project One" })];

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        settings: { visibleThreads: 5, keepAttention: true },
        sidebarThreads: { status: "ready", threads, projects },
      },
    );

    const row = slot.container.querySelector('a[data-sidebar-thread-id="t-1"]');
    expect(row).toBeTruthy();

    fireEvent.contextMenu(row!);

    const pinItem = screen.getByRole("menuitem", { name: "Pin" });
    expect(pinItem).toBeTruthy();
    fireEvent.click(pinItem);

    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "setPinned",
      threadId: "t-1",
      pinned: true,
    });
  });

  it("shows loading placeholder on status loading, and renders Original on status error", async () => {
    const app = await appPromise;

    const loadingSlot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        sidebarThreads: { status: "loading" },
      },
    );

    expect(loadingSlot.getByRole("status")).toBeTruthy();
    expect(loadingSlot.getByText("Loading threads…")).toBeTruthy();

    const errorSlot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        sidebarThreads: { status: "error" },
      },
    );

    expect(errorSlot.getByText("bb list")).toBeTruthy();
  });

  it("shows all threads and no 'Show more' button when visibleThreads is 0", async () => {
    const app = await appPromise;
    const threads = Array.from({ length: 8 }, (_, i) =>
      makeThread({
        id: `t-${i + 1}`,
        title: `Thread ${i + 1}`,
        projectId: "proj-1",
      }),
    );
    const projects = [makeProject({ id: "proj-1", name: "Project One" })];

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        settings: { visibleThreads: 0, keepAttention: true },
        sidebarThreads: { status: "ready", threads, projects },
      },
    );

    for (let i = 1; i <= 8; i++) {
      expect(slot.queryByText(`Thread ${i}`)).toBeTruthy();
    }
    expect(
      slot.queryByRole("button", { name: /Ещё/ }),
    ).toBeNull();
    expect(
      slot.queryByRole("button", { name: /Меньше/ }),
    ).toBeNull();
  });

  it("supports inline rename on double click: Enter saves, Escape cancels", async () => {
    const app = await appPromise;
    const threads = [
      makeThread({ id: "t-1", title: "Original Title", projectId: "proj-1" }),
    ];
    const projects = [makeProject({ id: "proj-1", name: "Project One" })];

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        settings: { visibleThreads: 5, keepAttention: true },
        sidebarThreads: { status: "ready", threads, projects },
      },
    );

    const titleSpan = slot.getByText("Original Title");
    fireEvent.doubleClick(titleSpan);

    const input = slot.getByDisplayValue("Original Title");
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "New Renamed Title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "rename",
      threadId: "t-1",
      title: "New Renamed Title",
    });
  });

  it("renders bb's own list when useCollapsedList is turned off", async () => {
    const app = await appPromise;
    const threads = Array.from({ length: 8 }, (_, i) =>
      makeThread({
        id: `t-${i + 1}`,
        title: `Thread ${i + 1}`,
        projectId: "proj-1",
      }),
    );
    const projects = [makeProject({ id: "proj-1", name: "Project One" })];

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        settings: { useCollapsedList: false, visibleThreads: 5 },
        sidebarThreads: { status: "ready", threads, projects },
      },
    );

    expect(slot.queryByText("bb list")).toBeTruthy();
    expect(slot.queryByText("Thread 1")).toBeNull();
    expect(slot.queryByText("Ещё 3")).toBeNull();
  });

  it("hides the branch name and the project chat count unless their settings are on", async () => {
    const app = await appPromise;
    const threads = [
      makeThread({
        id: "t-1",
        title: "Thread 1",
        projectId: "proj-1",
        environment: {
          id: "env-1",
          name: "Worktree",
          branchName: "feature/collapse",
          workspaceDisplayKind: "managed-worktree",
        },
      }),
    ];
    const projects = [makeProject({ id: "proj-1", name: "Project One" })];
    const props = {
      activeThreadId: null,
      activeProjectId: null,
      isCompactViewport: false,
      onNavigate: () => {},
      searchQuery: "",
      Original: () => <div>bb list</div>,
    };

    const off = renderSlot(app.threadLists[0]!, props, {
      settings: { visibleThreads: 5 },
      sidebarThreads: { status: "ready", threads, projects },
    });
    expect(off.queryByText("Thread 1")).toBeTruthy();
    expect(off.queryByText("feature/collapse")).toBeNull();
    expect(off.queryByText("1")).toBeNull();
    off.lifecycle.unmount();

    const on = renderSlot(app.threadLists[0]!, props, {
      settings: {
        visibleThreads: 5,
        showBranchName: true,
        showThreadCount: true,
      },
      sidebarThreads: { status: "ready", threads, projects },
    });
    expect(on.queryByText("feature/collapse")).toBeTruthy();
    expect(on.queryByText("1")).toBeTruthy();
  });

  it("does not expose an accidental archive button on the row", async () => {
    const app = await appPromise;
    const threads = [
      makeThread({ id: "t-1", title: "Thread 1", projectId: "proj-1" }),
    ];
    const projects = [makeProject({ id: "proj-1", name: "Project One" })];

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        settings: { visibleThreads: 5 },
        sidebarThreads: { status: "ready", threads, projects },
      },
    );

    expect(slot.queryByLabelText("Archive Thread 1")).toBeNull();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
  });

  it("reorders projects by dragging their headers", async () => {
    const app = await appPromise;
    const threads = [
      makeThread({ id: "t-1", title: "Thread 1", projectId: "proj-1" }),
      makeThread({ id: "t-2", title: "Thread 2", projectId: "proj-2" }),
    ];
    const projects = [
      makeProject({ id: "proj-1", name: "Project One" }),
      makeProject({ id: "proj-2", name: "Project Two" }),
    ];

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        Original: () => <div>bb list</div>,
      },
      {
        rpc: { reorder_project: () => ({ ok: true as const }) },
        settings: { visibleThreads: 5 },
        sidebarThreads: { status: "ready", threads, projects },
      },
    );

    const header = (name: string): HTMLElement => {
      const found = slot.getByText(name).closest("[draggable]");
      if (found === null) {
        throw new Error(`no draggable header for ${name}`);
      }
      return found as HTMLElement;
    };
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: () => {},
      getData: () => "proj-2",
    };

    fireEvent.dragStart(header("Project Two"), { dataTransfer });
    fireEvent.dragOver(header("Project One"), { dataTransfer });
    fireEvent.drop(header("Project One"), { dataTransfer });

    expect(slot.inspection.rpcCalls).toEqual([
      {
        method: "reorder_project",
        input: {
          projectId: "proj-2",
          previousProjectId: null,
          nextProjectId: "proj-1",
        },
      },
    ]);
  });
});
