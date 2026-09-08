/** Минимум полей треда, который нужен группировке. Структурный подтип
 *  PluginSidebarThread из @get-bb/plugin-sdk — НЕ импортировать SDK. */
export interface GroupingThread {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  parentThreadId: string | null;
  hasPendingInteraction: boolean;
  indicator: string;
  isUnread: boolean;
  isPinned: boolean;
  isArchived: boolean;
  updatedAt: number;
  latestAttentionAt: number;
  createdAt: number;
}

export interface GroupingProject {
  id: string;
  name: string;
  isPersonal: boolean;
}

export interface GroupingInput<T extends GroupingThread = GroupingThread> {
  threads: readonly T[];
  projects: readonly GroupingProject[];
  /** Тред текущего маршрута; null на нетредовых экранах. */
  activeThreadId: string | null;
  /** Сколько корневых тредов показывать в свёрнутой группе. */
  limit: number;
  /** Не скрывать треды, которые ждут пользователя. */
  keepAttention: boolean;
  /** Ключи групп, где пользователь нажал «Show more». */
  expandedGroupKeys: ReadonlySet<string>;
  /** projectId проектов, свёрнутых целиком. */
  foldedProjectIds: ReadonlySet<string>;
}

export interface GroupingRow<T extends GroupingThread = GroupingThread> {
  thread: T;
  /** 0 для корневого треда, +1 на каждый уровень вложенности. */
  depth: number;
}

export interface GroupingGroup<T extends GroupingThread = GroupingThread> {
  /** Стабильный ключ группы: `project:<projectId>`. */
  key: string;
  projectId: string;
  projectName: string;
  isPersonal: boolean;
  /** Группа свёрнута целиком: rows пуст. */
  isFolded: boolean;
  /** Пользователь нажал «Show more» для этой группы. */
  isExpanded: boolean;
  /** Плоский список рядов в порядке отрисовки. */
  rows: readonly GroupingRow<T>[];
  /** Всего корневых тредов в группе. */
  rootCount: number;
  /** Сколько корневых тредов сейчас скрыто лимитом (0, если ничего). */
  hiddenCount: number;
}

const ATTENTION_INDICATORS = new Set(["waiting-for-input", "unread-error"]);

export function groupSidebarThreads<T extends GroupingThread>(
  input: GroupingInput<T>,
): readonly GroupingGroup<T>[] {
  const { threads, projects, activeThreadId, limit, keepAttention, expandedGroupKeys, foldedProjectIds } = input;

  if (threads.length === 0) {
    return [];
  }

  // 1. Filter out archived threads. A descendant of an archived thread becomes
  //    an orphan (its parent is gone from the filtered set) and is promoted to a
  //    root by rule 2 — so only directly-archived threads are removed.
  const filtered = threads.filter((t) => !t.isArchived);

  // Build children map on the filtered set.
  const byId = new Map<string, T>();
  for (const t of filtered) {
    byId.set(t.id, t);
  }

  // Roots: parent null OR parent not in filtered set.
  const parentOf = new Map<string, string | null>();
  for (const t of filtered) {
    const p = t.parentThreadId;
    if (p !== null && byId.has(p)) {
      parentOf.set(t.id, p);
    } else {
      parentOf.set(t.id, null);
    }
  }

  const roots = filtered.filter((t) => parentOf.get(t.id) === null);

  // Children map (only filtered children whose effective parent is this thread).
  const children = new Map<string, T[]>();
  for (const t of filtered) {
    const p = parentOf.get(t.id);
    if (p === null || p === undefined) {
      continue;
    }
    const list = children.get(p);
    if (list === undefined) {
      children.set(p, [t]);
    } else {
      list.push(t);
    }
  }

  // Compute and store children (children may be in different project than root,
  // still drawn under their parent). Children are in same filtered set.
  // Sort children by createdAt asc, id asc.
  for (const list of children.values()) {
    list.sort((a, b) => compareChildren(a, b));
  }

  // Determine forced visibility for each root.
  // forced if: pinned, own subtree contains activeThreadId, or
  // keepAttention && any self/descendant has pending interaction or attention indicator.
  const forcedVisible = new Set<string>();

  // Walk each root's subtree (cycle-safe via visited ids).
  const visitRoot = (root: T) => {
    let attention = root.hasPendingInteraction || ATTENTION_INDICATORS.has(root.indicator);
    let containsActive = root.id === activeThreadId;

    const stack = [root.id];
    const visited = new Set<string>([root.id]);
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      const curThread = byId.get(cur);
      if (curThread === undefined) {
        continue;
      }
      if (curThread.id === activeThreadId) {
        containsActive = true;
      }
      if (curThread.hasPendingInteraction || ATTENTION_INDICATORS.has(curThread.indicator)) {
        attention = true;
      }
      const kids = children.get(cur);
      if (kids !== undefined) {
        for (const k of kids) {
          if (!visited.has(k.id)) {
            visited.add(k.id);
            stack.push(k.id);
          }
        }
      }
    }

    let forced = root.isPinned || containsActive;
    if (keepAttention && attention) {
      forced = true;
    }
    if (forced) {
      forcedVisible.add(root.id);
    }
  };

  for (const r of roots) {
    visitRoot(r);
  }

  // Sort roots within a group (order rule 4) is applied per group during assembly.

  // Build groups.
  const projectMeta = new Map<string, { name: string; isPersonal: boolean }>();
  projects.forEach((p) => projectMeta.set(p.id, { name: p.name, isPersonal: p.isPersonal }));

  // Collect roots per project.
  const rootsByProject = new Map<string, T[]>();
  for (const r of roots) {
    const list = rootsByProject.get(r.projectId);
    if (list === undefined) {
      rootsByProject.set(r.projectId, [r]);
    } else {
      list.push(r);
    }
  }

  // Sort roots within each project (rule 4): pinned first, then by max(latestAttentionAt, updatedAt) desc, id asc.
  for (const list of rootsByProject.values()) {
    list.sort((a, b) => compareRoots(a, b));
  }

  // Determine group order.
  // Projects present in input.projects come in that order; orphan projects after, in order of first appearance.
  const groupOrder: string[] = [];
  const inOrderSet = new Set<string>();
  for (const p of projects) {
    if (rootsByProject.has(p.id)) {
      groupOrder.push(p.id);
      inOrderSet.add(p.id);
    }
  }
  for (const pid of rootsByProject.keys()) {
    if (!inOrderSet.has(pid)) {
      groupOrder.push(pid);
      inOrderSet.add(pid);
    }
  }

  const groups: GroupingGroup<T>[] = [];
  for (const pid of groupOrder) {
    const projRoots = rootsByProject.get(pid)!;
    const meta = projectMeta.get(pid);
    const projectName = meta ? meta.name : pid;
    const isPersonal = meta ? meta.isPersonal : false;
    const key = `project:${pid}`;
    const isFolded = foldedProjectIds.has(pid);
    const isExpanded = expandedGroupKeys.has(key);

    const rootCount = projRoots.length;

    let rows: GroupingRow<T>[] = [];
    let hiddenCount = 0;

    if (!isFolded) {
      if (isExpanded || limit <= 0) {
        // all roots shown
        rows = flattenRoots(projRoots, children, byId);
        hiddenCount = 0;
      } else {
        // take first `limit` roots plus forced roots beyond the limit, preserving rule-4 order.
        const shown = new Map<string, T>();
        let count = 0;
        const orderedShown: T[] = [];
        for (const r of projRoots) {
          const forced = forcedVisible.has(r.id);
          if (count < limit || forced) {
            shown.set(r.id, r);
            orderedShown.push(r);
            if (!forced) {
              count++;
            }
          }
        }
        rows = flattenRoots(orderedShown, children, byId);
        hiddenCount = rootCount - shown.size;
      }
    }

    groups.push({
      key,
      projectId: pid,
      projectName,
      isPersonal,
      isFolded,
      isExpanded,
      rows,
      rootCount,
      hiddenCount,
    });
  }

  return groups;
}

function compareRoots<T extends GroupingThread>(a: T, b: T): number {
  if (a.isPinned !== b.isPinned) {
    return a.isPinned ? -1 : 1;
  }
  const am = Math.max(a.latestAttentionAt, a.updatedAt);
  const bm = Math.max(b.latestAttentionAt, b.updatedAt);
  if (am !== bm) {
    return bm - am;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareChildren<T extends GroupingThread>(a: T, b: T): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function flattenRoots<T extends GroupingThread>(
  roots: readonly T[],
  children: ReadonlyMap<string, T[]>,
  byId: ReadonlyMap<string, T>,
): GroupingRow<T>[] {
  const result: GroupingRow<T>[] = [];
  const visited = new Set<string>();
  const push = (thread: T, depth: number) => {
    if (visited.has(thread.id)) {
      return;
    }
    visited.add(thread.id);
    result.push({ thread, depth });
    const kids = children.get(thread.id);
    if (kids !== undefined) {
      for (const k of kids) {
        push(k, depth + 1);
      }
    }
  };
  for (const r of roots) {
    push(r, 0);
  }
  return result;
}

/** Заголовок треда для отрисовки: title → titleFallback → fallback. */
export function threadDisplayTitle(
  thread: Pick<GroupingThread, "title" | "titleFallback">,
  fallback: string,
): string {
  const title = thread.title?.trim();
  if (title) {
    return title;
  }
  const titleFallback = thread.titleFallback?.trim();
  if (titleFallback) {
    return titleFallback;
  }
  return fallback;
}
