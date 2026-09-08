// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

afterEach(() => {
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

describe("bb-plugin-sidebar-collapse frontend tests", () => {
  it("renders 5 threads and 'Show more (3)' when there are 8 threads and visibleThreads is 5", async () => {
    const app = await loadPluginApp(() => import("./app"));
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

    expect(slot.queryByText("Show more (3)")).toBeTruthy();
  });

  it("expands to show all 8 threads on 'Show more' click, changes to 'Show less', and collapses on second click", async () => {
    const app = await loadPluginApp(() => import("./app"));
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
      name: /Show more \(3\)/,
    });
    fireEvent.click(showMoreButton);

    for (let i = 1; i <= 8; i++) {
      expect(slot.queryByText(`Thread ${i}`)).toBeTruthy();
    }

    const showLessButton = slot.getByRole("button", { name: "Show less" });
    expect(showLessButton).toBeTruthy();

    fireEvent.click(showLessButton);

    for (let i = 1; i <= 5; i++) {
      expect(slot.queryByText(`Thread ${i}`)).toBeTruthy();
    }
    for (let i = 6; i <= 8; i++) {
      expect(slot.queryByText(`Thread ${i}`)).toBeNull();
    }
    expect(slot.queryByText("Show more (3)")).toBeTruthy();
  });

  it("records { method: 'open', threadId: id } on thread row click", async () => {
    const app = await loadPluginApp(() => import("./app"));
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
    const app = await loadPluginApp(() => import("./app"));
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
    const app = await loadPluginApp(() => import("./app"));

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
    const app = await loadPluginApp(() => import("./app"));
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
      slot.queryByRole("button", { name: /Show more/ }),
    ).toBeNull();
    expect(
      slot.queryByRole("button", { name: /Show less/ }),
    ).toBeNull();
  });

  it("supports inline rename on double click: Enter saves, Escape cancels", async () => {
    const app = await loadPluginApp(() => import("./app"));
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
    const app = await loadPluginApp(() => import("./app"));
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
    expect(slot.queryByText("Show more (3)")).toBeNull();
  });

  it("hides the branch name and the project chat count unless their settings are on", async () => {
    const app = await loadPluginApp(() => import("./app"));
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

  it("archives from the row's quick action without opening a menu", async () => {
    const app = await loadPluginApp(() => import("./app"));
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

    fireEvent.click(slot.getByLabelText("Archive Thread 1"));

    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "archive", threadId: "t-1" },
    ]);
  });
});
