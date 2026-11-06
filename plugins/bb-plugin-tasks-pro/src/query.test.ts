import { describe, expect, it } from "vitest";
import {
  applyFilters,
  applyGroup,
  applySearch,
  applySort,
  buildEnriched,
  dueBucketOf,
  matchesDateRange,
  type EnrichSources,
  type EnrichedTask,
} from "./query";
import { isCompletionBody, parseStatusTarget } from "./enrich";
import type { Label, Project, Task, TaskThread } from "./tasks-contract";

const NOW = new Date("2026-11-06T12:00:00"); // a Friday

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? `task_${Math.random().toString(36).slice(2)}`,
    projectId: "proj_a",
    number: 1,
    key: "AAA-1",
    title: "Task",
    description: "",
    status: "todo",
    priority: "medium",
    dueDate: null,
    parentTaskId: null,
    position: 1,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    labelIds: [],
    ...overrides,
  };
}

const PROJ_A: Project = {
  id: "proj_a",
  name: "Alpha",
  prefix: "AAA",
  nextTaskNumber: 10,
  color: "#00f",
  folderId: "fold_1",
  linkedBbProjectId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const PROJ_B: Project = {
  id: "proj_b",
  name: "Beta",
  prefix: "BBB",
  nextTaskNumber: 5,
  color: "#0f0",
  folderId: "fold_2",
  linkedBbProjectId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const LABEL_X: Label = { id: "lbl_x", projectId: "proj_a", name: "Bug", color: "red" };
const LABEL_Y: Label = { id: "lbl_y", projectId: "proj_a", name: "UI", color: "blue" };

function sources(tasks: Task[], cards = new Map()): EnrichSources {
  return {
    projectById: new Map([
      [PROJ_A.id, PROJ_A],
      [PROJ_B.id, PROJ_B],
    ]),
    folderById: new Map([
      ["fold_1", { id: "fold_1", name: "Work", parentFolderId: null, createdAt: "" }],
      ["fold_2", { id: "fold_2", name: "Side", parentFolderId: null, createdAt: "" }],
    ]),
    labelById: new Map([
      [LABEL_X.id, LABEL_X],
      [LABEL_Y.id, LABEL_Y],
    ]),
    taskById: new Map(tasks.map((t) => [t.id, t])),
    cardByTaskId: cards,
    sqliteByTaskId: new Map(),
    sqliteAvailable: true,
  };
}

function enrich(tasks: Task[], cards = new Map()): EnrichedTask[] {
  return buildEnriched(tasks, sources(tasks, cards));
}

function thread(liveStatus: TaskThread["liveStatus"]): TaskThread {
  return {
    id: "tt_1",
    taskId: "t",
    threadId: "thr_x",
    presetName: "p",
    title: "t",
    liveStatus,
    attachedAt: "",
    updatedAt: "",
  };
}

// ---------------------------------------------------------------------------

describe("matchesDateRange", () => {
  it("today / last7d / last30d / range / none", () => {
    expect(matchesDateRange("2026-11-06", { kind: "today" }, NOW)).toBe(true);
    expect(matchesDateRange("2026-11-05", { kind: "today" }, NOW)).toBe(false);
    expect(matchesDateRange("2026-10-31", { kind: "last7d" }, NOW)).toBe(true);
    expect(matchesDateRange("2026-10-30", { kind: "last7d" }, NOW)).toBe(false);
    expect(matchesDateRange("2026-10-08", { kind: "last30d" }, NOW)).toBe(true);
    expect(
      matchesDateRange(
        "2026-10-20",
        { kind: "range", from: "2026-10-01", to: "2026-10-31" },
        NOW,
      ),
    ).toBe(true);
    expect(
      matchesDateRange(
        "2026-11-01",
        { kind: "range", from: "2026-10-01", to: "2026-10-31" },
        NOW,
      ),
    ).toBe(false);
    expect(matchesDateRange(null, { kind: "none" }, NOW)).toBe(true);
    expect(matchesDateRange("2026-11-06", { kind: "none" }, NOW)).toBe(false);
  });

  it("overdue excludes null, future and completed", () => {
    expect(
      matchesDateRange("2026-11-05", { kind: "overdue" }, NOW, { isDue: true }),
    ).toBe(true);
    expect(
      matchesDateRange("2026-11-07", { kind: "overdue" }, NOW, { isDue: true }),
    ).toBe(false);
    expect(
      matchesDateRange(null, { kind: "overdue" }, NOW, { isDue: true }),
    ).toBe(false);
    expect(
      matchesDateRange("2026-11-05", { kind: "overdue" }, NOW, {
        isDue: true,
        completed: true,
      }),
    ).toBe(false);
  });

  it("due last7d looks forward, created last7d looks backward", () => {
    expect(
      matchesDateRange("2026-11-10", { kind: "last7d" }, NOW, { isDue: true }),
    ).toBe(true);
    expect(
      matchesDateRange("2026-11-05", { kind: "last7d" }, NOW, { isDue: true }),
    ).toBe(false);
    expect(matchesDateRange("2026-11-05", { kind: "last7d" }, NOW)).toBe(true);
  });
});

describe("applyFilters", () => {
  const t1 = task({ id: "t1", projectId: "proj_a", status: "in_progress", labelIds: ["lbl_x"] });
  const t2 = task({ id: "t2", projectId: "proj_b", status: "done", priority: "urgent" });
  const t3 = task({ id: "t3", projectId: "proj_a", parentTaskId: "t1", dueDate: "2026-11-01" });
  const all = enrich([t1, t2, t3]);

  it("AND across groups, OR inside multiselect", () => {
    expect(
      applyFilters(all, { statuses: ["in_progress", "done"] }, NOW).map((t) => t.id),
    ).toEqual(["t1", "t2"]);
    expect(
      applyFilters(
        all,
        { statuses: ["in_progress"], projectIds: ["proj_a"] },
        NOW,
      ).map((t) => t.id),
    ).toEqual(["t1"]);
    expect(
      applyFilters(all, { statuses: ["in_progress"], priorities: ["urgent"] }, NOW),
    ).toEqual([]);
  });

  it("folder filter goes through project", () => {
    expect(applyFilters(all, { folderIds: ["fold_2"] }, NOW).map((t) => t.id)).toEqual([
      "t2",
    ]);
  });

  it("label filter matches any of the task's labels", () => {
    expect(applyFilters(all, { labelIds: ["lbl_x"] }, NOW).map((t) => t.id)).toEqual([
      "t1",
    ]);
  });

  it("depth top / subtasks", () => {
    expect(applyFilters(all, { depth: "top" }, NOW).map((t) => t.id)).toEqual([
      "t1",
      "t2",
    ]);
    expect(applyFilters(all, { depth: "subtasks" }, NOW).map((t) => t.id)).toEqual([
      "t3",
    ]);
  });

  it("completed notCompleted excludes done/canceled", () => {
    expect(
      applyFilters(all, { completed: "notCompleted" }, NOW).map((t) => t.id),
    ).toEqual(["t1", "t3"]);
  });

  it("threads filter uses activeThreads / threadCount", () => {
    const withCard = enrich(
      [t1, t2],
      new Map([
        ["t1", { taskId: "t1", attachmentCount: 0, activeThreads: [thread("working")] }],
      ]),
    );
    expect(
      applyFilters(withCard, { threads: "active" }, NOW).map((t) => t.id),
    ).toEqual(["t1"]);
  });

  it("attachments filter", () => {
    const withCard = enrich(
      [t1, t2],
      new Map([
        ["t1", { taskId: "t1", attachmentCount: 3, activeThreads: [] }],
      ]),
    );
    expect(
      applyFilters(withCard, { attachments: true }, NOW).map((t) => t.id),
    ).toEqual(["t1"]);
  });
});

describe("applySearch", () => {
  const t1 = task({
    id: "t1",
    title: "Fix login redirect",
    description: "SSO loop on Safari",
    key: "AAA-42",
    number: 42,
    labelIds: ["lbl_x"],
  });
  const t2 = task({ id: "t2", title: "Write docs", projectId: "proj_b" });
  const all = enrich([t1, t2]);

  it("tokenizes by spaces, AND across tokens, case-insensitive", () => {
    expect(applySearch(all, { search: "login" }).map((t) => t.id)).toEqual(["t1"]);
    expect(applySearch(all, { search: "LOGIN safari" }).map((t) => t.id)).toEqual([
      "t1",
    ]);
    expect(applySearch(all, { search: "login safari missing" })).toEqual([]);
  });

  it("matches key, number, project name/prefix, label names", () => {
    expect(applySearch(all, { search: "aaa-42" }).map((t) => t.id)).toEqual(["t1"]);
    expect(applySearch(all, { search: "42" }).map((t) => t.id)).toEqual(["t1"]);
    expect(applySearch(all, { search: "beta" }).map((t) => t.id)).toEqual(["t2"]);
    expect(applySearch(all, { search: "bug" }).map((t) => t.id)).toEqual(["t1"]);
  });

  it("empty search returns input", () => {
    expect(applySearch(all, { search: "  " })).toHaveLength(2);
  });
});

describe("applySort", () => {
  const a = task({ id: "a", status: "done", priority: "low", dueDate: null, title: "Bravo" });
  const b = task({ id: "b", status: "todo", priority: "urgent", dueDate: "2026-11-01", title: "alpha" });
  const c = task({ id: "c", status: "in_review", priority: "medium", dueDate: "2026-11-03", title: "Charlie" });
  const all = enrich([a, b, c]);

  it("status follows workflow order, not alphabetical", () => {
    expect(
      applySort(all, [{ key: "status", dir: "asc" }]).map((t) => t.id),
    ).toEqual(["b", "c", "a"]);
  });

  it("priority sorts urgent first", () => {
    expect(
      applySort(all, [{ key: "priority", dir: "asc" }]).map((t) => t.id),
    ).toEqual(["b", "c", "a"]);
  });

  it("null dates always land last regardless of direction", () => {
    expect(
      applySort(all, [{ key: "due", dir: "asc" }]).map((t) => t.id),
    ).toEqual(["b", "c", "a"]);
    expect(
      applySort(all, [{ key: "due", dir: "desc" }]).map((t) => t.id),
    ).toEqual(["c", "b", "a"]);
  });

  it("multi-key applies secondary on ties", () => {
    const d = task({ id: "d", status: "todo", priority: "high", title: "delta" });
    const e = task({ id: "e", status: "todo", priority: "urgent", title: "echo" });
    const list = enrich([d, e]);
    expect(
      applySort(list, [
        { key: "status", dir: "asc" },
        { key: "priority", dir: "asc" },
      ]).map((t) => t.id),
    ).toEqual(["e", "d"]);
  });

  it("is stable for equal keys", () => {
    const x = task({ id: "x", status: "todo" });
    const y = task({ id: "y", status: "todo" });
    expect(
      applySort(enrich([x, y]), [{ key: "status", dir: "asc" }]).map((t) => t.id),
    ).toEqual(["x", "y"]);
  });

  it("key sorts by prefix then number", () => {
    const k2 = task({ id: "k2", key: "AAA-2", number: 2 });
    const k10 = task({ id: "k10", key: "AAA-10", number: 10 });
    const kb = task({ id: "kb", key: "BBB-1", number: 1, projectId: "proj_b" });
    expect(
      applySort(enrich([k10, kb, k2]), [{ key: "key", dir: "asc" }]).map(
        (t) => t.id,
      ),
    ).toEqual(["k2", "k10", "kb"]);
  });
});

describe("applyGroup", () => {
  it("groups by status in workflow order with counts", () => {
    const list = enrich([
      task({ id: "a", status: "done" }),
      task({ id: "b", status: "todo" }),
      task({ id: "c", status: "todo" }),
    ]);
    const groups = applyGroup(list, "status", NOW);
    expect(groups.map((g) => [g.id, g.count])).toEqual([
      ["todo", 2],
      ["done", 1],
    ]);
  });

  it("dueBucket covers overdue/today/week/later/none", () => {
    const list = enrich([
      task({ id: "o", dueDate: "2026-11-01" }),
      task({ id: "t", dueDate: "2026-11-06" }),
      task({ id: "w", dueDate: "2026-11-10" }),
      task({ id: "l", dueDate: "2027-01-01" }),
      task({ id: "n" }),
      task({ id: "done", dueDate: "2026-11-01", status: "done" }),
    ]);
    const groups = applyGroup(list, "dueBucket", NOW);
    const map = Object.fromEntries(groups.map((g) => [g.id, g.tasks.map((t) => t.id)]));
    expect(map.overdue).toEqual(["o"]);
    expect(map.today).toEqual(["t"]);
    expect(map.thisWeek).toEqual(["w"]);
    expect(map.later).toEqual(["l"]);
    // completed tasks are never "overdue": they fall in the none bucket
    expect(map.none.sort()).toEqual(["done", "n"]);
  });

  it("label group puts multi-label tasks in each section + 'No label'", () => {
    const list = enrich([
      task({ id: "a", labelIds: ["lbl_x", "lbl_y"] }),
      task({ id: "b", labelIds: ["lbl_x"] }),
      task({ id: "c" }),
    ]);
    const groups = applyGroup(list, "label", NOW);
    const byId = Object.fromEntries(groups.map((g) => [g.label, g.tasks.map((t) => t.id)]));
    expect(byId.Bug.sort()).toEqual(["a", "b"]);
    expect(byId.UI).toEqual(["a"]);
    expect(byId["No label"]).toEqual(["c"]);
  });

  it("parent group uses parent key in the label", () => {
    const list = enrich([
      task({ id: "p", key: "AAA-1", title: "Parent" }),
      task({ id: "ch", parentTaskId: "p", key: "AAA-2" }),
    ]);
    const groups = applyGroup(list, "parent", NOW);
    const parentGroup = groups.find((g) => g.id === "p");
    expect(parentGroup?.label).toBe("AAA-1 · Parent");
    expect(groups[groups.length - 1].id).toBe("");
  });

  it("none group returns a single section", () => {
    const list = enrich([task({ id: "a" })]);
    expect(applyGroup(list, "none", NOW)).toHaveLength(1);
  });
});

describe("dueBucketOf", () => {
  it("does not mark done/canceled tasks overdue", () => {
    const done = enrich([task({ dueDate: "2026-11-01", status: "done" })])[0];
    const canceled = enrich([task({ dueDate: "2026-11-01", status: "canceled" })])[0];
    const open = enrich([task({ dueDate: "2026-11-01", status: "todo" })])[0];
    expect(dueBucketOf(done, NOW)).toBe("none");
    expect(dueBucketOf(canceled, NOW)).toBe("none");
    expect(dueBucketOf(open, NOW)).toBe("overdue");
  });
});

describe("system comment parser", () => {
  it("parses status targets", () => {
    expect(parseStatusTarget("Status changed to Done by agent (thr_x)")).toBe("Done");
    expect(parseStatusTarget("Status changed to In Review by agent (thr_x)")).toBe(
      "In Review",
    );
    expect(parseStatusTarget("Status changed to In Progress · dispatched to swe2")).toBe(
      "In Progress",
    );
    expect(parseStatusTarget("Created by agent")).toBeNull();
  });

  it("recognizes completion bodies", () => {
    expect(isCompletionBody("Status changed to Done by agent (thr_x)")).toBe(true);
    expect(isCompletionBody("Status changed to Canceled by agent (thr_x)")).toBe(true);
    expect(isCompletionBody("Status changed to In Progress by agent (thr_x)")).toBe(
      false,
    );
  });
});
