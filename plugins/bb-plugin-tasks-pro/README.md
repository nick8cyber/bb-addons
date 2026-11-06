# Tasks Pro

An advanced **read-only** task browser for bb tasks. Registers a separate
"Tasks Pro" navigation panel next to the builtin Tasks view: multi-field
filtering, tokenized search, multi-key sorting, grouping, a kanban board, a
task detail drawer, and named saved views.

Tasks Pro never mutates anything: it issues no write RPCs to the `tasks`
plugin, performs no writes to its SQLite database, and the kanban has no
drag-and-drop. The builtin board, `bb tasks` CLI, and dispatch keep working
on the same data.

## Features

- **Toolbar** — free-text search; multi-selects for projects, folders,
  statuses, priorities, labels; due/created/updated/completed date filters;
  thread/attachment/depth filters; Table↔Kanban switch; saved-view selector;
  "shown X of Y" counter.
- **Table** — every column sorts (click = direction, Shift+click = extra key);
  rows group by status / priority / project / folder / due bucket / label /
  parent with collapsible sections and counts.
- **Kanban** — workflow-status columns (backlog → canceled) with task cards:
  key, title, project chip, priority, due date, active-thread and attachment
  badges. View only.
- **Drawer** — click a task for a read-only panel: all fields, labels,
  markdown description, comments, attached threads (click → opens the bb
  thread), subtasks, PR links. "Open in Tasks" activates the native Tasks
  panel.
- **Saved views** — named `{filters, sort, group, search, view}` sets kept in
  plugin storage. Ships presets: *Overdue*, *In progress*, *Done this week*,
  *No due date*.
- **Derived columns** — `completedAt`, `lastStatusChangeAt`, `commentCount`,
  `threadCount` are read straight from the tasks plugin's SQLite database
  (`<dataDir>/plugins/tasks/data.db`, opened `readonly` — it runs in WAL
  mode, so parallel reads are safe). Without the DB those columns simply
  disappear; everything else keeps working.

## Data flow

`server.ts` exposes a typed RPC contract:

| Method | Purpose |
|---|---|
| `getCatalog` | projects + folders + per-project labels for the toolbar |
| `queryTasks` | filtered + searched + sorted `EnrichedTask[]` (`total` is the unfiltered count) |
| `getTaskDetail` | one task, its subtasks, comments, threads, PRs |
| `listViews` / `saveView` / `deleteView` | saved views in plugin KV storage |

Reads go through `bb.sdk.plugins.callRpc({ pluginId: "tasks" })` —
`listAllTasks` + `listTaskCardMeta` + `listProjects`/`listFolders` +
`labelsByProject` (batched under the 500-key cap), cached with short TTLs so
filter clicks don't re-hit the builtin plugin (`callRpc` is expensive). Pass
`refresh: true` in `queryTasks`/`getCatalog` input to bypass the cache.

Filtering, search, sorting and grouping live in `src/query.ts` as pure
functions (`applyFilters`, `applySearch`, `applySort`, `applyGroup`), shared
between the server and unit tests.

## Degradation

- Builtin `tasks` plugin disabled/removed → the panel shows a retryable
  empty state instead of crashing.
- `data.db` missing or schema drifted → completed/comment/thread-count
  columns are skipped (`null`), all other views unaffected.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest — filters, sort (null-last), grouping, search, enrich parser
npm run build       # bb plugin build .
bb plugin install <absolute path to this directory>
```

Requires `bb >= 0.46.1`, `bbPluginSdk >= 0.6.49`. Schemas in
`src/tasks-contract.ts` mirror the builtin tasks RPC contract of
bb-app 0.48.1 — when upstream renames a field, fix the schema, not the
logic.
