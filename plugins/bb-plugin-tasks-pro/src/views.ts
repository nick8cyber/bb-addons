import type { Query } from "./query";

export interface SavedView {
  id: string;
  name: string;
  /** Built-in presets cannot be deleted or renamed. */
  builtin: boolean;
  view: "table" | "board";
  query: Query;
}

export const DEFAULT_VIEWS: readonly SavedView[] = [
  {
    id: "builtin:overdue",
    name: "Overdue",
    builtin: true,
    view: "table",
    query: {
      due: { kind: "overdue" },
      sort: [{ key: "due", dir: "asc" }],
      group: "project",
    },
  },
  {
    id: "builtin:in-progress",
    name: "In progress",
    builtin: true,
    view: "board",
    query: {
      statuses: ["in_progress", "in_review"],
      sort: [{ key: "priority", dir: "asc" }],
    },
  },
  {
    id: "builtin:done-week",
    name: "Done this week",
    builtin: true,
    view: "table",
    query: {
      completed: { kind: "last7d" },
      statuses: ["done", "canceled"],
      sort: [{ key: "completed", dir: "desc" }],
      group: "project",
    },
  },
  {
    id: "builtin:no-due",
    name: "No due date",
    builtin: true,
    view: "table",
    query: {
      due: { kind: "none" },
      completed: "notCompleted",
      sort: [{ key: "priority", dir: "asc" }],
    },
  },
];
