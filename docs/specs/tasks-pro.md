---
title: Tasks Pro — расширенный просмотр задач bb
status: approved
owner: coordinator
date: 2026-11-06
tags: [bb, plugins, tasks, explorer]
---

# Tasks Pro — расширенный просмотр задач bb

## 1. Запрос владельца

Во встроенном плагине `tasks` нет нормальной сортировки по статусам, датам
(создания/изменения/завершения), проектам, и нет нормального поиска. Нужны
классические фильтры задачника и кастомный плагин, который это даёт.

Решения владельца (2026-11-06): первая версия — **только просмотр** (без
мутаций); виды — **таблица с группировкой + канбан**; дату завершения добывать
**прямым read-only чтением SQLite** базы плагина tasks.

## 2. Поведение

Плагин `tasks-pro`, пакет `bb-plugin-tasks-pro`, живёт в
`plugins/bb-plugin-tasks-pro` репозитория bb-addons. Регистрирует свою
навигационную панель (`app.slots.navPanel`, обязательные `id:"explorer"`,
`title:"Tasks Pro"`, `path:"explorer"`, `icon` `ListFilter` или аналог) —
отдельный экран рядом с родным «Tasks». Родной плагин не трогаем: его доска, CLI `bb tasks` и dispatch
продолжают работать, данные общие.

Экран:

- **Тулбар**: поисковое поле; мультиселекты проектов, папок, статусов,
  приоритетов, лейблов; фильтры по датам; переключатель видов
  «Таблица / Канбан»; селектор сохранённых видов; счётчик «показано X из Y».
- **Таблица**: сортируемые колонки (клик по заголовку — направление,
  Shift+клик — добавление ключа); строки сгруппированы по выбранному ключу с
  сворачиваемыми секциями и счётчиками. Колонки: key, title, project, status,
  priority, labels, due, created, updated, completed, threads, attachments.
- **Канбан**: колонки по статусам в порядке workflow; карточка = key, title,
  project chip, priority, due, badges тредов/вложений. Без drag-and-drop
  (просмотр).
- **Клик по задаче** — read-only drawer справа: все поля задачи, лейблы,
  комментарии, прикреплённые треды (клик → `navigate.toThread`), сабтаски,
  PR-ссылки. Кнопка «Open in Tasks» ведёт в родную панель tasks.
  `experimental_useAppPanel().openTab` открывает только табы своего плагина —
  рабочий механизм: активация `navPanel` через навигационные actions
  (`experimental_useSidebarNavigation().actions.activate("tasks/<panelId>")`)
  либо обычная ссылка на роут панели; точный panelId и механизм исполнитель
  сверяет с SDK/хостом.
- **Сохранённые виды**: именованные наборы {filters, sort, group, search,
  view}, хранятся в storage плагина, применяются из селектора. Пресеты по
  умолчанию: «Просроченные», «В работе», «Сделано за неделю», «Все без
  срока».

Обновление данных: при монтировании, по фокусу окна и ручной кнопкой
refresh; если SDK даёт realtime/invalidation по тегам RPC tasks — использовать
его вместо поллинга.

## 3. Устройство и ограничения

### Источник данных — RPC builtin-плагина `tasks`

Вызов из нашего backend: `bb.sdk.plugins.callRpc({ pluginId: "tasks", method,
input, outputSchema })`. Каждый вызов оборачиваем: tasks выключен/удалён →
панель показывает понятный empty-state, а не падает. `callRpc` отваливается
по 75 с — запросы батчим (один `listAllTasks` + один `listTaskCardMeta` + один
`labelsByProject` на каталог) и кешируем каталог с TTL, а не дёргаем на каждый
клик фильтра.

Схемы вытащены из `bb-app@0.48.1`
`server/dist/builtin-plugins/tasks/dist/server.js` — контракт под этой
версией; исполнитель объявляет zod-схемы сам (они нужны `callRpc` как
`outputSchema`) и при расхождении чинит их, а не логику.

| method | input | output |
|---|---|---|
| `listAllTasks` | `{projectId?, statuses?, priorities?, labelIds?, activeOnly?, parentTaskId?, search?, sort?}` | `{tasks: Task[]}` — без пагинации, для видов «весь проект/фильтр» |
| `listProjects` | `{folderId?}` | `{projects: Project[]}` |
| `listFolders` | `null` | `{folders: Folder[]}` |
| `labelsByProject` | `{keys: projectId[]}` (1–500) | `Record<projectId, Label[]>` |
| `getTask` | `{taskId}` | `{task: Task \| null}` |
| `getTaskByKey` | `{taskKey}` | `{task: Task \| null}` |
| `listComments` | `{taskId}` | `{comments: Comment[]}` |
| `listTaskThreads` | `{taskId}` | `{taskThreads: TaskThread[]}` |
| `listTaskCardMeta` | `{projectId?}` | `{cards: [{taskId, attachmentCount, activeThreads[]}]}` |
| `listTaskPullRequests` | `{taskId}` | `{pullRequests: PR[], unavailableThreadIds}` |

```ts
// Task.status: "backlog"|"todo"|"in_progress"|"in_review"|"done"|"canceled"
// Task.priority: "urgent"|"high"|"medium"|"low"|"none"
Task  = { id, projectId, number, key, title, description, status, priority,
          dueDate: string|null /* YYYY-MM-DD */, parentTaskId: string|null,
          position: number, createdAt: ISO, updatedAt: ISO, labelIds: string[] }
Project = { id, name, prefix, nextTaskNumber, color, folderId: string|null,
            linkedBbProjectId: string|null, createdAt: ISO }
Folder  = { id, name, parentFolderId: string|null, createdAt: ISO }
Label   = { id, projectId, name, color }
Comment = { id, taskId, kind: "user"|"agent"|"system", authorName,
            presetName|null, threadId|null, body, notifiedCount, createdAt }
TaskThread = { id, taskId, threadId, presetName, title,
               liveStatus: "starting"|"working"|"idle"|"completed"|"failed",
               attachedAt, updatedAt }
```

Производные поля — прямой read-only SQLite к
`~/.bb/plugins/tasks/data.db` (через `better-sqlite3` с `readonly: true`;
БД в WAL — параллельное чтение безопасно; devDependency уже используется в
bb-addons, см. bb-plugin-usage-pro):

- `completedAt` — max `created_at` комментария `kind='system'` с телом
  «Status changed to Done%»/«Status changed to Canceled%» (точные строки
  исполнитель сверяет по `SELECT DISTINCT body FROM comments WHERE
  kind='system'` — формат «Status changed to X · …»).
- `lastStatusChangeAt` — max `created_at` любого system-комментария со
  «Status changed to …».
- `commentCount` — `COUNT(*)` по task_id.

Один `GROUP BY` запрос на весь набор. SQLite недоступен или схема съехала →
колонки completed/updated-meta молча отключаются (graceful degradation), UI и
остальные функции живут.

### Границы

- Только чтение: ни одного мутационного RPC (createTask, updateTask,
  boardMove, …) и ни одной записи в чужую SQLite. Канбан без drag.
- Лимиты входов `callRpc` соблюдаем: `labelsByProject` ≤ 500 ключей за вызов.
- Плагин не добавляет CLI-команд и agent tools — skills/ не нужен, README
  плагина на английском по конвенции bb-addons.
- Публичный SDK: `engines.bbPluginSdk >= 0.6.49`, `engines.bb >= 0.46.1` —
  как у bb-plugin-usage-pro; `bb plugin types` перед сборкой.

## 4. Функциональная спека

Backend экспортирует в свой frontend типизированный RPC (не прокси-пайп —
реальные методы):

- `getCatalog()` → `{projects, folders, labelsByProject}` — один вызов для
  тулбара.
- `queryTasks(q: Query)` → `{tasks: EnrichedTask[], total: number}` —
  фильтрация/поиск/сортировка на бэке; `EnrichedTask = Task & {project,
  labels, completedAt|null, lastStatusChangeAt|null, commentCount,
  attachmentCount, activeThreads}`.
- `getTaskDetail(taskId)` → `{task, subtasks, comments, threads,
  pullRequests, completedAt}` для drawer.
- `listViews()` / `saveView(view)` / `deleteView(id)` — сохранённые виды в
  storage плагина.

Query-движок — чистые функции (юнит-тесты на них обязательны):

```ts
type DateRange =
  | { kind: "today" | "last7d" | "last30d" }
  | { kind: "overdue" | "none" }
  | { kind: "range"; from: string; to: string }; // ISO date

interface Query {
  projectIds?: string[];   folderIds?: string[];
  statuses?: TaskStatus[]; priorities?: Priority[];
  labelIds?: string[];
  due?: DateRange; created?: DateRange;
  updated?: DateRange;     completed?: DateRange | "notCompleted";
  threads?: "active" | "any" | "none";
  // "active" = liveStatus in ("starting","working"); "any" = хотя бы один тред
  attachments?: boolean;
  depth?: "top" | "subtasks" | "all";
  search?: string;
  sort?: SortKey[];        // [{key, dir:"asc"|"desc"}], первый — главный
  group?: "status"|"priority"|"project"|"folder"|"dueBucket"|"label"|"parent"|"none";
}
```

- `applyFilters(tasks, q)` — AND между группами, OR внутри мультиселекта;
  пустая группа = без ограничения. `depth` по `parentTaskId`. `threads`
  и `attachments` — по данным `listTaskCardMeta`.
- `applySearch(tasks, q)` — токенизация по пробелам, AND по токенам,
  case-insensitive; поля: title, key, number, description, имя/prefix
  проекта, имена лейблов задачи.
- `applySort(tasks, keys)` — стабильная мультиключевая; нативный порядок
  status = порядок workflow; priority urgent→none; даты null всегда в конец
  независимо от направления; `manual` = position.
- `applyGroup(tasks, key)` — секции с заголовком и count; `dueBucket` =
  overdue/today/this week/later/none; `label` — задача с несколькими лейблами
  входит в каждую секцию + секция «No label».

## 5. Проверка и установка

- `npm run typecheck` (tsc --noEmit), `npm test` (vitest: фильтры, сортировка
  null-last, группировка, поиск по токенам, enrich-парсер system-комментариев).
- `bb plugin build .` — собирается без warnings по API.
- `bb plugin install <абсолютный путь plugins/bb-plugin-tasks-pro в worktree
  исполнителя>` — path-install; в сайдбаре появляется «Tasks Pro», экран
  открывается,
  фильтры/сортировка/поиск/группировка работают на реальных данных, drawer
  открывает тред, «Open in Tasks» ведёт в родную панель.
- Деградация: с выключенным плагином tasks — empty-state; с отсутствующей
  БД — работает без completed-колонок.

## 6. Решение

Отдельная панель, а не форк: builtin-плагин скомпилирован в bb и не имеет
точек расширения, а его RPC-контракт и WAL-БД покрывают все нужные чтения.
Форк бы разошёлся с апстримом и сломал CLI/dispatch. Работа на ветке
`feat/tasks-pro` в worktree `worktrees/bb-addons-tasks-pro`; main не трогаем,
push — только по слову владельца.
