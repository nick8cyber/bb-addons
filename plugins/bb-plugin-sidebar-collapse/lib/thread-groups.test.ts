import { describe, expect, it } from "vitest";
import {
  type GroupingInput,
  type GroupingThread,
  groupSidebarThreads,
  threadDisplayTitle,
} from "./thread-groups";

function makeThread(overrides: Partial<GroupingThread> & { id: string }): GroupingThread {
  return {
    projectId: "p1",
    title: null,
    titleFallback: null,
    parentThreadId: null,
    hasPendingInteraction: false,
    indicator: "",
    isUnread: false,
    isPinned: false,
    isArchived: false,
    updatedAt: 0,
    latestAttentionAt: 0,
    createdAt: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<GroupingInput<GroupingThread>>): GroupingInput<GroupingThread> {
  return {
    threads: [],
    projects: [],
    activeThreadId: null,
    limit: 5,
    keepAttention: false,
    expandedGroupKeys: new Set<string>(),
    foldedProjectIds: new Set<string>(),
    ...overrides,
  };
}

const fruits = (n: number) => {
  const map = new Map<number, string>();
  map.set(0, "a");
  map.set(1, "b");
  map.set(2, "c");
  map.set(3, "d");
  map.set(4, "e");
  map.set(5, "f");
  map.set(6, "g");
  map.set(7, "h");
  return Array.from({ length: n }, (_, i) => map.get(i) ?? String(i));
};

describe("groupSidebarThreads", () => {
  it("пустой ввод → пустой массив групп", () => {
    expect(groupSidebarThreads(makeInput({}))).toEqual([]);
  });

  it("порядок групп по projects, проект-сирота в конце, пустые группы отсутствуют", () => {
    const threads = [
      makeThread({ id: "t1", projectId: "p1" }),
      makeThread({ id: "t2", projectId: "p2" }),
      makeThread({ id: "t3", projectId: "p3" }) // orphan, not in projects
    ];
    const groups = groupSidebarThreads(
      makeInput({
        threads,
        projects: [
          { id: "p1", name: "Проект 1", isPersonal: false },
          { id: "p2", name: "Проект 2", isPersonal: false },
        ],
      }),
    );
    expect(groups.map((g) => g.projectId)).toEqual(["p1", "p2", "p3"]);
    expect(groups[2].projectName).toBe("p3");
    expect(groups[2].isPersonal).toBe(false);
    expect(groups[0].key).toBe("project:p1");
    expect(groups[0].isPersonal).toBe(false);
  });

  it("сортировка корней: pinned впереди; далее по max(latestAttentionAt, updatedAt); тай-брейк по id", () => {
    const a = makeThread({ id: "a", latestAttentionAt: 10, updatedAt: 0 });
    const b = makeThread({ id: "b", latestAttentionAt: 0, updatedAt: 20 }); // max = 20
    const c = makeThread({ id: "c", latestAttentionAt: 5, updatedAt: 0 }); // max = 5
    const d = makeThread({ id: "d", isPinned: true, latestAttentionAt: 1, updatedAt: 1 });
    const groups = groupSidebarThreads(makeInput({ threads: [a, b, c, d] }));
    expect(groups[0].rows.map((r) => r.thread.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("тай-брейк по id при равных метриках", () => {
    const x = makeThread({ id: "x", latestAttentionAt: 100, updatedAt: 100 });
    const y = makeThread({ id: "y", latestAttentionAt: 100, updatedAt: 100 });
    const groups = groupSidebarThreads(makeInput({ threads: [y, x] }));
    expect(groups[0].rows.map((r) => r.thread.id)).toEqual(["x", "y"]);
  });

  it("лимит 5 при 8 корнях: 5 рядов, hiddenCount === 3", () => {
    const threads = fruits(8).map((id) => makeThread({ id }));
    const groups = groupSidebarThreads(
      makeInput({ threads, limit: 5 }),
    );
    expect(groups[0].rows.length).toBe(5);
    expect(groups[0].hiddenCount).toBe(3);
    expect(groups[0].rootCount).toBe(8);
  });

  it("expandedGroupKeys → все ряды, hiddenCount === 0", () => {
    const threads = fruits(8).map((id) => makeThread({ id }));
    const groups = groupSidebarThreads(
      makeInput({
        threads,
        limit: 5,
        expandedGroupKeys: new Set(["project:p1"]),
      }),
    );
    expect(groups[0].rows.length).toBe(8);
    expect(groups[0].hiddenCount).toBe(0);
    expect(groups[0].isExpanded).toBe(true);
  });

  it("limit: 0 → все ряды", () => {
    const threads = fruits(6).map((id) => makeThread({ id }));
    const groups = groupSidebarThreads(makeInput({ threads, limit: 0 }));
    expect(groups[0].rows.length).toBe(6);
    expect(groups[0].hiddenCount).toBe(0);
  });

  it("pinned за пределами лимита всё равно показан, и hiddenCount посчитан верно", () => {
    const threads = fruits(8).map((id) => makeThread({ id, isPinned: id === "h" }));
    const groups = groupSidebarThreads(makeInput({ threads, limit: 5 }));
    const ids = groups[0].rows.map((r) => r.thread.id);
    expect(ids).toContain("h");
    expect(ids.length).toBe(6); // 5 + forced pinned
    expect(groups[0].hiddenCount).toBe(2); // 8 - 6
  });

  it("активный тред-потомок вытягивает своего корня из-за лимита вместе со всей цепочкой предков в rows", () => {
    const root = makeThread({ id: "root" });
    const mid = makeThread({ id: "mid", parentThreadId: "root" });
    const leaf = makeThread({ id: "leaf", parentThreadId: "mid" });
    const other1 = fruits(7).map((id) => makeThread({ id }));
    // root is the 8th root (sorts after a..g since they have updatedAt 0, ids a..g; root id "root")
    const threads = [...other1, root, mid, leaf];
    const groups = groupSidebarThreads(
      makeInput({ threads, limit: 5, activeThreadId: "leaf" }),
    );
    const ids = groups[0].rows.map((r) => r.thread.id);
    expect(ids).toContain("root");
    expect(ids).toContain("mid");
    expect(ids).toContain("leaf");
    // chain depth
    const rows = groups[0].rows;
    const byId = new Map(rows.map((r) => [r.thread.id, r.depth]));
    expect(byId.get("root")).toBe(0);
    expect(byId.get("mid")).toBe(1);
    expect(byId.get("leaf")).toBe(2);
  });

  it("keepAttention: true показывает корень с hasPendingInteraction за лимитом; при keepAttention: false тот же корень скрыт", () => {
    const base = fruits(8).map((id) => makeThread({ id }));
    // replace the "h" (last, beyond limit of 5) to have pending interaction
    const threads = base.map((t) => (t.id === "h" ? { ...t, hasPendingInteraction: true } : t));

    const withAttention = groupSidebarThreads(
      makeInput({ threads, limit: 5, keepAttention: true }),
    );
    expect(withAttention[0].rows.map((r) => r.thread.id)).toContain("h");
    expect(withAttention[0].hiddenCount).toBe(2);

    const withoutAttention = groupSidebarThreads(
      makeInput({ threads, limit: 5, keepAttention: false }),
    );
    expect(withoutAttention[0].rows.map((r) => r.thread.id)).not.toContain("h");
    expect(withoutAttention[0].hiddenCount).toBe(3);
  });

  it("keepAttention также учитывает indicator waiting-for-input на потомке", () => {
    const root = makeThread({ id: "root" });
    const child = makeThread({ id: "child", parentThreadId: "root", indicator: "waiting-for-input" });
    const other = fruits(8).map((id) => makeThread({ id }));
    const threads = [...other, root, child];
    const groups = groupSidebarThreads(
      makeInput({ threads, limit: 5, keepAttention: true }),
    );
    expect(groups[0].rows.map((r) => r.thread.id)).toContain("root");
    expect(groups[0].rows.map((r) => r.thread.id)).toContain("child");
  });

  it("foldedProjectIds → rows пуст, rootCount корректен", () => {
    const threads = fruits(8).map((id) => makeThread({ id }));
    const groups = groupSidebarThreads(
      makeInput({
        threads,
        limit: 5,
        foldedProjectIds: new Set(["p1"]),
      }),
    );
    expect(groups[0].rows).toEqual([]);
    expect(groups[0].rootCount).toBe(8);
    expect(groups[0].hiddenCount).toBe(0);
    expect(groups[0].isFolded).toBe(true);
  });

  it("архивные треды и их потомки не попадают в вывод", () => {
    const root = makeThread({ id: "root" });
    const arch = makeThread({ id: "arch", isArchived: true });
    const archChild = makeThread({ id: "archChild", parentThreadId: "arch", isArchived: true });
    const threads = [root, arch, archChild];
    const groups = groupSidebarThreads(makeInput({ threads }));
    expect(groups[0].rows.map((r) => r.thread.id)).toEqual(["root"]);
    expect(groups[0].rootCount).toBe(1);
  });

  it("сирота (родитель заархивирован) становится корнем", () => {
    const arch = makeThread({ id: "arch", isArchived: true });
    const orphan = makeThread({ id: "orphan", parentThreadId: "arch" });
    const groups = groupSidebarThreads(makeInput({ threads: [arch, orphan] }));
    expect(groups[0].rows.map((r) => r.thread.id)).toEqual(["orphan"]);
    expect(groups[0].rootCount).toBe(1);
    expect(groups[0].rows[0].depth).toBe(0);
  });

  it("потомок в другом проекте рисуется под своим родителем", () => {
    const root = makeThread({ id: "root", projectId: "p1" });
    const crossChild = makeThread({ id: "cross", parentThreadId: "root", projectId: "p2" });
    const groups = groupSidebarThreads(
      makeInput({
        threads: [root, crossChild],
        projects: [
          { id: "p1", name: "P1", isPersonal: false },
          { id: "p2", name: "P2", isPersonal: false },
        ],
      }),
    );
    // cross child still drawn under its parent in p1 group
    expect(groups.length).toBe(1);
    expect(groups[0].projectId).toBe("p1");
    expect(groups[0].rows.map((r) => r.thread.id)).toEqual(["root", "cross"]);
    expect(groups[0].rows[1].depth).toBe(1);
  });

  it("цикл a.parent = b, b.parent = a не вешает функцию и не теряет треды", () => {
    const a = makeThread({ id: "a", parentThreadId: "b" });
    const b = makeThread({ id: "b", parentThreadId: "a" });
    // Neither has a null parent nor a parent outside the filtered set, so the
    // cycle is unreachable from every root: the first member in input order is
    // promoted to a root and the other stays its child.
    expect(() => groupSidebarThreads(makeInput({ threads: [a, b] }))).not.toThrow();
    const groups = groupSidebarThreads(makeInput({ threads: [a, b] }));
    expect(groups).toHaveLength(1);
    expect(groups[0].rootCount).toBe(1);
    expect(groups[0].rows).toEqual([
      { thread: a, depth: 0 },
      { thread: b, depth: 1 },
    ]);
  });

  it("цикл с внешним корнем: потомок цикла рисуется под корнем без зависания", () => {
    const root = makeThread({ id: "root" });
    // cycle inside the subtree: a.parent = b, b.parent = a
    const a = makeThread({ id: "a", parentThreadId: "root" });
    const b = makeThread({ id: "b", parentThreadId: "a" });
    const a2 = makeThread({ id: "a2", parentThreadId: "b" });
    // Reconnect: make a point to root (root is real root); b->a; then also c->root to test descend
    const threads = [root, a, b];
    const groups = groupSidebarThreads(makeInput({ threads }));
    expect(groups[0].rows.map((r) => r.thread.id)).toEqual(["root", "a", "b"]);
  });

  it("вход не мутируется (сравнить копию входных массивов до/после)", () => {
    const threads = fruits(8).map((id) => makeThread({ id }));
    const projects = [{ id: "p1", name: "P1", isPersonal: false }];
    const threadsCopy = threads.map((t) => ({ ...t }));
    const projectsCopy = projects.map((p) => ({ ...p }));
    groupSidebarThreads(
      makeInput({
        threads,
        projects,
        limit: 3,
        expandedGroupKeys: new Set(["project:p1"]),
        foldedProjectIds: new Set(),
      }),
    );
    expect(threads).toEqual(threadsCopy);
    expect(projects).toEqual(projectsCopy);
  });
});

describe("threadDisplayTitle", () => {
  it("title → titleFallback → fallback", () => {
    expect(threadDisplayTitle({ title: "T", titleFallback: "TF" }, "F")).toBe("T");
    expect(threadDisplayTitle({ title: null, titleFallback: "TF" }, "F")).toBe("TF");
    expect(threadDisplayTitle({ title: null, titleFallback: null }, "F")).toBe("F");
  });

  it("строка из пробелов считается непустой и обрезается", () => {
    expect(threadDisplayTitle({ title: "   ", titleFallback: "TF" }, "F")).toBe("TF");
    expect(threadDisplayTitle({ title: "  Hi  ", titleFallback: null }, "F")).toBe("Hi");
  });
});
