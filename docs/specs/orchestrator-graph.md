---
title: Orchestrator — граф задачи и очередь кодом (Work Graphs)
status: approved
updated: 2026-11-19
revision: 34.5 (вынос раздела графа задач в отдельный документ спеки по замечанию 7 архитектора, PLUG-315, ADR-0037)
---

# Граф задачи и очередь кодом (Work Graphs)

Расширение [спеки оркестратора](orchestrator.md) (§27–§32). Документ регламентирует детерминированное продвижение задач через граф состояний, таблицы `task_queue` / `task_transitions`, конвейер `run-queue`, роли архитектора, договоры приёмки и машинные проверки.

> [!NOTE] Нормативный статус документа
> Настоящий документ содержит полный нормативный текст разделов §§27–32 спецификации оркестратора (вынос по замечанию 7 архитектора, PLUG-315, ADR-0037). Документ полностью синхронизирован со спецификацией [orchestrator.md](orchestrator.md).

## 27. Ревизия 34: очередь и граф задачи кодом (18.11, слово владельца; аудит координатора §3, §5–§7)

Аудит координатора за 16–18.11 (материалы аудита координатора в KB `projects/bb-orchestrator-work-graphs-plan.md` и проект `projects/bb-orchestrator-graph-architecture.md`) выявил коренную проблему: «задачу ведёт модель, а не код». Координатор, ведущий задачи в контексте треда, терял поручения владельца при ротации контекста, простаивал часами и подгонял спеки под готовый код (PLUG-293). Спецификация r34 переворачивает управление: **задачу ведёт код сервиса очереди, агенты выполняют работу строго внутри изолированных узлов и сдают детерминированные доказательства**.

Восемь уроков аудита координатора разложены по механизмам:
- Урок 1 (будильник на каждом рабочем узле задачи, молчание — событие) → §28.2.
- Урок 2 (очередь в БД, отложить можно только явной записью «отложено владельцем») → §27.1.
- Урок 3 (договор приёмки до кода пишет архитектор, изменение исполнителем запрещено) → §31.
- Урок 4 (тест связи «роль → уровень → маршрут → живая раздача» при валидации политики) → §2.3, §21.6, §27.3.
- Урок 5 (три исхода везде: прошло, упало, не запускалось; «не запускалось» — не проход) → §31.3.
- Урок 6 (потолок кругов ревью: ровно 3 круга максимум, дальше статус `blocked` и эскалация владельцу) → §28.1.
- Урок 7 (задачу ведёт код, а не координатор; вопрос агента или ход без артефакта/вердикта не является сдачей узла) → §28.1.
- Урок 8 (защита от накопленной истории: любой новый сторож или уведомитель при первом запуске не действует на прошлое, сверка с фактом до напоминания, предел неактивности координатора 24ч) → §5.6.

### 27.1 Состояние — в базе: `task_queue` и `task_transitions`

Плагин оркестратора хранит состояние конвейера задач в SQLite:

```sql
CREATE TABLE IF NOT EXISTS task_queue (
  task_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  coordinator_thread_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK(route IN ('feature', 'fix', 'docs', 'simple', 'research')),
  level TEXT NOT NULL CHECK(level IN ('complex', 'medium', 'simple', 'spec', 'research', 'architect')),
  node TEXT NOT NULL CHECK(node IN (
    'start', 'design', 'spec', 'spec_review', 'owner_gate', 'code', 'checks',
    'review', 'design_check', 'release', 'research'
  )),
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'running', 'waiting_approval', 'waiting_release_note',
    'pr_open', 'blocked', 'stalled', 'deferred', 'done', 'cancelled'
  )),
  priority INTEGER NOT NULL DEFAULT 100,
  depends_on TEXT DEFAULT NULL,
  confirmation_mode TEXT NOT NULL DEFAULT 'manual' CHECK(confirmation_mode IN ('auto', 'manual')),
  branch TEXT DEFAULT NULL,
  interaction_id TEXT DEFAULT NULL,
  spec_sha TEXT DEFAULT NULL,
  acceptance_sha TEXT DEFAULT NULL,
  result_sha TEXT DEFAULT NULL,
  release_note TEXT DEFAULT NULL,
  spec_attempts INTEGER NOT NULL DEFAULT 0,
  spec_review_rounds INTEGER NOT NULL DEFAULT 0,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  check_attempts INTEGER NOT NULL DEFAULT 0,
  code_review_rounds INTEGER NOT NULL DEFAULT 0,
  design_check_rounds INTEGER NOT NULL DEFAULT 0,
  release_attempts INTEGER NOT NULL DEFAULT 0,
  entered_at INTEGER NOT NULL,
  deadline_at INTEGER DEFAULT NULL,
  node_alarm_at INTEGER DEFAULT NULL,
  deferred_by TEXT DEFAULT NULL,
  deferred_reason TEXT DEFAULT NULL,
  payload TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_transitions_task ON task_transitions(task_key, created_at);
```

- **Аудит переходов и служебные маркеры:** в таблице `task_transitions` фиксируются все переходы графа задач. Для служебных записей аудита внеочередных ручных действий координатора по задачам, не поставленным в очередь (в режиме `shadow`, §32), в колонки `from_node`, `to_node`, `from_status`, `to_status` записываются строковые маркеры `'none'`, удовлетворяющие ограничению схемы `NOT NULL`, а тип команды и признак `event: "manual_command"` передаются внутри объекта `payload`.

- **Формирование имени функциональной ветки `branch` (§27.1):** для маршрутов с кодом и документацией (`feature`, `fix`, `docs`, `simple`) имя ветки формируется детерминированно как `bb/<KEY>-<slug>`, где `<KEY>` — ключ задачи в нижнем регистре (например `plug-308`), а `<slug>` — нормализованный префикс названия задачи (латиница, цифры и дефисы в нижнем регистре, длина до 30 символов, без повторяющихся/хвостовых дефисов; если название задачи опущено или не содержит латинских символов — slug формируется по названию маршрута: `feature`, `fix`, `docs`, `simple`). Для маршрута `research` функциональная ветка не создаётся и колонка `branch` остаётся `NULL` (исследования проводятся без веток и без кода). Имя фиксируется в колонке `task_queue.branch` при начальной постановке `enqueue` и сохраняется неизменным на всём жизненном цикле задачи (при повторных вызовах `enqueue` переиспользование существующей ветки строго ведётся по сохранённому `task_queue.branch`).

1. **Единая модель (узел и статус):** текущий этап графа хранится в поле `node` (строго 11 рабочих узлов), а операционное состояние задачи — в поле `status`. Состояния `stalled`, `blocked`, `deferred`, `waiting_approval`, `waiting_release_note`, `pr_open` являются значениями поля `status`, сохраняя текущий рабочий узел `node` (например, `node = 'release', status = 'stalled'`).
2. **Атомарность переходов и защита от гонок:** функция перехода выполняет CAS-обновление (compare-and-swap) в одной транзакции SQLite:
   `UPDATE task_queue SET node = :toNode, status = :toStatus, updated_at = :now WHERE task_key = :taskKey AND node = :expectedFromNode AND status = :expectedFromStatus`.
   Если запись изменилась параллельным тактом, переход безопасно пропускается без повторной раздачи.
3. **Очередь и зависимости:** задачи в статусе `queued` выбираются сервисом `run-queue` по порядку `priority DESC, created_at ASC`. Если у задачи заполнено поле `depends_on` (JSON-массив ключей), задача не берётся в работу до тех пор, пока все задачи из `depends_on` не перейдут в статус `done`.
4. **Откладывание задачи (`defer`):** задача переводится в статус `deferred` исключительно по решению владельца с фиксацией `deferred_by = "owner"` и `deferred_reason`. Агенты (включая координатора) не вправе откладывать задачи.

### 27.2 Граф задачи и маршруты

Граф содержит 11 рабочих узлов (`start`, `design`, `spec`, `spec_review`, `owner_gate`, `code`, `checks`, `review`, `design_check`, `release`, `research`).

Маршруты выполнения в зависимости от режима подтверждения `confirmation_mode`:
- **`feature` (полный конвейер со сменой поведения/архитектуры):**
  - в режиме `manual` (режим «сам», Б1): `start → design → spec → spec_review → owner_gate (pre_code: спека) → code → checks → review → design_check → owner_gate (pre_release: выкладка) → release → done` (решение владельца 15.11: владелец одобряет спецификацию перед кодом и выкладку перед релизом на всех маршрутах);
  - в режиме `auto` («авто»): `start → design → spec → spec_review → code → checks → review → design_check → release → done` (узел `owner_gate` опускается, конвейер работает автономно до завершения задачи (`done`)).
- **`fix` (исправление без изменения спецификации и архитектуры):**
  - в режиме `manual` (режим «сам», Б1): `start → owner_gate (pre_code: договор) → code → checks → review → owner_gate (pre_release: выкладка) → release → done` (шлюз согласования договора перед кодом и шлюз перед выкладкой);
  - в режиме `auto` («авто», Б3): `start → code → checks → review → release → done` (автономный конвейер до завершения задачи (`done`) без блокировки на старте; соблюдение границ проверяется машиной на узле `code` по §31.7 с автовозвратом в `design` при выходе за рамки).
- **`simple` (механические правки, тесты):**
  - в режиме `manual` (режим «сам», Б1): `start → owner_gate (pre_code: договор) → code → checks → review → owner_gate (pre_release: выкладка) → release → done`;
  - в режиме `auto` («авто», Б3): `start → code → checks → review → release → done` (автономный конвейер до завершения задачи (`done`) с машинной проверкой соблюдения рамок маршрута при сдаче кода).
- **`docs` (только документация и спецификации):**
  - в режиме `manual` (режим «сам», Б1): `start → spec → spec_review → owner_gate (pre_release: выкладка) → release → done` (шлюз владельца перед выкладкой документации);
  - в режиме `auto` («авто»): `start → spec → spec_review → release → done` (автономный конвейер до завершения задачи (`done`) с машинной сверкой ссылок на кодовую базу по §31.6).
- **`research` (исследование и сбор данных):**
  - `start → research → done` (уровень `research`, без кода, без ревью, без выкладки).

При постановке задачи `enqueue` параметр `--level` задаёт уровень цепочки для узла реализации кода (`complex`, `medium`, `simple`) либо узла документации (`spec` для маршрута `docs`) или исследования (`research` для маршрута `research`). На маршрутах с кодом (`feature`, `fix`, `simple`) уровень ОБЯЗАН иметь роль `executor`. Попытка указать `--level spec` или `--level architect` для маршрутов с кодом отклоняется с ошибкой `invalid-level: узел code требует уровня с инструментами написания кода (роль executor)`. Узлы `design` и `design_check` ВСЕГДА выполняются ролью `architect` независимо от `--level` задачи.

### 27.3 Тест связи цепочки раздачи (урок 4 аудита)

Проверка целостности цепочки «роль → уровень → маршрут → живая раздача» выполняется при вызове `policy validate` и при старте сервиса `run-queue`:
1. **Связь «роль → уровень»:** каждая используемая роль (`architect`, `executor`, `auditor`, `researcher`) обязана иметь соответствующий уровень в `levels`:
   - `role: "architect"` требует наличия уровня с ролью `architect` (по умолчанию `architect`);
   - Писатель спек конвейера требует уровня `spec`;
   - Роль `researcher` требует уровня `research`;
   - Аудиторы ревью берутся из карты `reviewByLevel` (при отсутствии явного сопоставления для `spec` используется базовый уровень `review`).
2. **Связь «уровень → маршрут»:** каждый уровень в `levels` обязан иметь непустой массив `chain`, все маршруты которого объявлены в `routes` политики.
3. **Связь «маршрут → пресет»:** каждый маршрут обязан ссылаться на реально существующий пресет в `bb tasks preset show`.
4. **Режим совместимости:**
   - При `workGraph: "off"` отсутствие уровней `spec`, `research` или `architect` трактуется как неблокирующее предупреждение `policy-warning: <name>-missing` (действующая политика r33 остаётся валидной);
   - При `workGraph ≠ "off"` любая оборванная связь для используемых маршрутов блокирует валидацию с ошибкой `policy-invalid: <name>-missing`.

## 28. Ревизия 34: конвейер и сервис `run-queue`

### 28.1 Полная матрица переходов «Маршрут × Узел × Событие → Следующий Узел / Новый Статус»

**Вершина выкладки, рабочая копия и синхронизация функциональной ветки:**
Перед запуском шага 1 выкладки (`node = 'release'`) сервис `run-queue` выполняет атомарное fast-forward обновление функциональной ветки `<branch>` (хранимой в `task_queue.branch`, по умолчанию `bb/<KEY>-<slug>`) до проверенной вершины конвейера через `git update-ref refs/heads/<branch> <new_sha> <old_sha>` с предварительной проверкой `git merge-base --is-ancestor <old_sha> <new_sha>`:
- Для маршрутов с кодом (`feature`, `fix`, `simple`): публикуемой вершиной является `result_sha` (содержит коммит договора `acceptance_sha` и коммит спеки `spec_sha` в своей истории git по правилам вершины §17.3);
- Для маршрута `docs`: публикуемой вершиной является `spec_sha` (договор `acceptance_sha = NULL`);
- Рабочая копия для шагов 2 (синк-слияние) и 3 (проверки проекта): используется выделенная служебная копия выкладки `wt/release/<KEY>` на detached HEAD публикуемого коммита (`git worktree add --detach wt/release/<KEY> <publish_sha>`), что исключает коллизии веток с копиями исполнителей. При повторных попытках копия переиспользуется (`git clean -fdx`, `git checkout --detach`), а после публикации или при переходе в `blocked`/`stalled` удаляется (`git worktree remove --force`);
- Синхронизация при доработке в PR-режиме (доработка замечаний в открытом PR `pr.changes_requested`, `resume` после `pr.closed`, либо отказ push на шаге 6): если удалённая ветка существует, сервис `run-queue` создаёт временную служебную копию `wt/sync/<KEY>` на detached HEAD (`git worktree add --detach wt/sync/<KEY> refs/heads/<branch>`) и выполняет `git fetch origin refs/heads/<branch>`. Если локальная ветка актуальна — синк завершается; если удалённая ветка опережает локальную fast-forward — выполняется `git merge --ff-only` и атомарный `git update-ref refs/heads/<branch> <ff_sha> <old_sha>`; при расхождении веток конвейер в `wt/sync/<KEY>` автоматически делает слияние `git merge --no-ff origin/<branch>`, продвигает ветку через `git update-ref ... <merge_sha> <old_sha>`, сохраняет хэш коммита в `task_queue.payload.pipeline_shas` (с переносом в `releases.pipeline_shas` при выкладке) и удаляет `wt/sync/<KEY>`. При конфликте копия сохраняется (`payload.conflict_worktree = "wt/sync/<KEY>"`), фиксируются `payload.sync_old_sha` и `payload.sync_remote_sha`, а задача переводится в `stalled: diverged-remote` (конфликт разрешается коммитом в `wt/sync/<KEY>` координатором или владельцем, после чего `resume <KEY>` проверяет отсутствие `MERGE_HEAD`, чистоту дерева и происхождение от обоих сохранённых SHA, заносит коммит слияния в `payload.pipeline_shas`, сдвигает ветку с проверкой `sync_old_sha` и удаляет копию). Исполнитель получает новую рабочую копию `wt/<KEY>-<round>` от актуальной вершины `<branch>` (`from: refs/heads/<branch>`). Отказ push на шаге 6 относится к событию отказа выкладки матрицы §28.1 (инкремент `release_attempts`, при < 3 возврат в `code` для маршрутов с кодом либо в `spec` для `docs`, при ≥ 3 → `blocked`).
Выкладка выполняется от ветки `<branch>` с `head_sha = <sha>`, гарантируя попадание и неизменяемого договора приёмки, и утверждённой спецификации, и проверенного кода в удалённую цель (`origin/<target>`) либо Pull Request.

| Маршрут | Текущий узел (`node`) | Исполнитель / Механизм | Событие / Исход | Следующий узел (`node`) | Новый статус (`status`) | Доказательство / Действие |
|---|---|---|---|---|---|---|
| `feature` | `start` | `run-queue` | Задача взята в работу из очереди | `design` | `running` | Создание ветки `task_queue.branch` от `origin/<mergeBaseBranch>` (при наличии чистой ветки — переиспользование) |
| `docs` | `start` | `run-queue` | Задача взята в работу из очереди | `spec` | `running` | Создание ветки `task_queue.branch` от `origin/<mergeBaseBranch>`. Поле `acceptance_sha = NULL` |
| `fix`, `simple` | `start` | `run-queue` | Задача взята при `mode: manual` (постановка человеком или агентом) | `owner_gate` | `waiting_approval` | Создание ветки `task_queue.branch`. Плагин коммитит договор `acceptance_sha` из `payload.acceptance_text`. Установка `payload.gate_stage = 'pre_code'`. Уведомление владельцу |
| `fix`, `simple` | `start` | `run-queue` | Задача взята при `mode: auto` (постановка человеком или агентом, Б3) | `code` | `running` | Создание ветки `task_queue.branch`. Плагин коммитит договор `acceptance_sha` из `payload.acceptance_text`. Раздача `code` с `--from <acceptance_sha>` (автономный конвейер без блокировки на старте; границы маршрута проверяются машиной при сдаче кода по §31.7) |
| `feature`, `fix`, `docs`, `simple` | `start` | `run-queue` | Ветка `task_queue.branch` уже существует и содержит коммиты вне `origin/<mergeBaseBranch>` | `start` | `stalled` | Зависание `stalled: branch-exists: ветка <branch> уже существует и содержит коммиты; проверь состояние ветки или выполни dequeue`. Оповещение координатора/владельца |
| `research` | `start` | `run-queue` | Задача взята в работу из очереди | `research` | `running` | Раздача задачи исследователю (без ветки и без кода) |
| `feature` | `design` | `architect` (роль `architect`) | Сдан текст договора приёмки и архитектурное решение | `spec` | `running` | Процесс плагина через git plumbing коммитит `docs/specs/acceptance/<KEY>.md` в ветку задачи под автором из git-конфига (`acceptance_sha`). Раздача `spec` идёт строго с `--from <acceptance_sha>` |
| `feature` | `design` | `architect` | Сбой / таймаут / квота / отмена | `design` | `running` (перевыпуск) / `stalled` | Перевыпуск по цепочке уровня `architect`; при исчерпании — `stalled` |
| `feature` | `design` | `architect` | Ход завершился вопросом / без структурированного отчёта (урок 7) | `design` | `running` | Узел остаётся в работе, повторный nudge исполнительскому треду |
| `feature` | `spec` | `spec` (роль `executor`) | Сдан коммит спецификаций, договор `acceptance/<KEY>.md` не затронут, сверка ссылок пройдена (§31.6, Б7, r34.2) | `spec_review` | `running` | Проверка `git diff --name-only`: изменения строго в `docs/`, `*.md`, diff договора пуст. Машинная сверка путей и символов спецификации с кодом (§31.6, r34.2). Исполнитель всегда читает и коммитит в git (никакой сдачи текстом). Фиксация `spec_sha`. Раздача ревью с `--from <spec_sha>` |
| `docs` | `spec` | `spec` (роль `executor`) | Сдан коммит документации, сверка ссылок пройдена (§31.6, Б7, r34.2) | `spec_review` | `running` | Раздача `spec` идёт от ветки задачи (без проверки договора). Машинная сверка путей и символов по §31.6 (r34.2). Исполнитель читает и коммитит в git. Фиксация `spec_sha`. Раздача ревью с `--from <spec_sha>` |
| `feature`, `docs` | `spec` | `spec` | Спецификация ссылается на непомеченные несуществующие файлы или символы в кодовой базе (§31.6, Б7, r34.2) | `spec` | `running` | Отказ захода: `spec-refused: invalid-codebase-reference`. Инкремент `spec_attempts` (при ≥ 3 → `blocked`). Возврат писателю спек с отчётом машинной проверки ссылок до траты токенов аудитора |
| `feature` | `spec` | `spec` | Писатель спек изменил или удалил `docs/specs/acceptance/<KEY>.md` | `spec` | `running` | Отказ захода: `spec-refused: acceptance-contract-modified` (урок 3). Инкремент `spec_attempts` (при ≥ 3 → `blocked`) |
| `feature`, `docs` | `spec` | `spec` | Сбой / таймаут / квота / отмена | `spec` | `running` (перевыпуск) / `stalled` | Перевыпуск по цепочке уровня `spec`; при исчерпании — `stalled` |
| `feature`, `docs` | `spec` | `spec` | Ход завершился вопросом / коммит затрагивает файлы вне docs | `spec` | `running` | Инкремент `spec_attempts` (при ≥ 3 → `blocked`). Возврат в работу с ошибкой |
| `feature` | `spec_review` | `reviewByLevel["spec"]` (по умолч. `review`) | `verdict: OK, blockers: 0` при `mode: manual` | `owner_gate` | `waiting_approval` | Шлюз согласования спецификации перед кодом (Б1). Установка `payload.gate_stage = 'pre_code'`. Плагин создаёт `PluginInteractionRequest` (уведомление и кнопки) владельцу с `spec_sha` и `acceptance_sha` |
| `feature` | `spec_review` | `reviewByLevel["spec"]` | `verdict: OK, blockers: 0` при `mode: auto` | `code` | `running` | Автопереход к реализации кода: раздача узла `code` строго с `--from <spec_sha>` (спека не теряется!) |
| `docs` | `spec_review` | `reviewByLevel["spec"]` | `verdict: OK, blockers: 0` при `mode: manual` | `owner_gate` | `waiting_approval` | Шлюз владельца перед выкладкой документации (Б1). Установка `payload.gate_stage = 'pre_release'`. Плагин создаёт `PluginInteractionRequest` владельцу с `spec_sha` |
| `docs` | `spec_review` | `reviewByLevel["spec"]` | `verdict: OK, blockers: 0` при `mode: auto` | `release` | `running` | Автопереход к выкладке документации с `--from <spec_sha>` |
| `feature`, `docs` | `spec_review` | `reviewByLevel["spec"]` | Замечания (`CHANGES`/`blockers>0`): инкремент `spec_review_rounds += 1`, раунд < 3 | `spec` | `running` | Новый заход писателя спек с замечаниями аудитора. Со 2-го круга (раунд ≥ 1) аудитор проверяет СТРОГО только блокеры прошлого круга (Б6) |
| `feature`, `docs` | `spec_review` | `reviewByLevel["spec"]` | Замечания (`CHANGES`/`blockers>0`): инкремент `spec_review_rounds += 1`, раунд ≥ 3 (Б6) | `spec` / `design` (`running`, в `auto` при 1-м impasse) / `spec_review` (`blocked`) | `running` / `blocked` | Потолок 3 кругов (урок 6, Б6): автоматическая консультация архитектора. В режиме `auto` при 1-й блокировке рекомендация архитектора (`target: spec|design`) исполняется один раз автоматически (`payload.architect_auto_applied = true`, сброс счётчиков). При 2-м тупике либо в `manual` → `blocked`, эскалация владельцу со сводкой в `task_queue.payload` |
| `feature`, `docs` | `spec_review` | `reviewByLevel["spec"]` | Сбой / таймаут / квота / отмена ревьюера | `spec_review` | `running` (перевыпуск) / `stalled` | Перевыпуск по цепочке уровня ревью; при исчерпании — `stalled` |
| `feature`, `docs` | `spec_review` | `reviewByLevel["spec"]` | Ход завершился вопросом / без JSON-вердикта (урок 7) | `spec_review` | `running` | Узел в работе, повторный nudge ревьюеру с требованием вердикта |
| `feature`, `fix`, `simple` | `owner_gate` (`gate_stage: 'pre_code'`) | Владелец (человек, без `BB_THREAD_ID`) | Одобрено владельцем через UI плагина (кнопка `[Одобрить]`, Б2) / команду CLI `approve <KEY>` | `code` | `running` | Разблокировка конвейера для написания кода. Раздача `code`: для feature строго с `--from <spec_sha>`, для fix/simple строго с `--from <acceptance_sha>`. При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `feature`, `fix`, `simple`, `docs` | `owner_gate` (`gate_stage: 'pre_release'`) | Владелец (человек, без `BB_THREAD_ID`) | Одобрено владельцем через UI плагина (кнопка `[Одобрить]`, Б2) / команду CLI `approve <KEY>` | `release` | `running` | Разблокировка публикации перед релизом (Б1). Запуск шага 1 конвейера публикации `release`. При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `feature` | `owner_gate` (`gate_stage: 'pre_code'`) | Владелец (человек, без `BB_THREAD_ID`) | Возвращено владельцем через UI (кнопка `[Вернуть]`, Б2) / `reject [--target spec|design] [--reason "<причина>"]` | `spec` / `design` | `running` | Возврат на доработку спеки или дизайна. Цель по умолчанию (если `--target` опущен): `spec`. Сброс счётчиков: при target spec сбрасываются `spec_attempts = 0`, `spec_review_rounds = 0`; при target design сбрасываются все последующие счётчики (`design_check_rounds = 0`, `spec_attempts = 0`, `spec_review_rounds = 0`, `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `release_attempts = 0`). Цели `code` или `release` на шлюзе pre_code запрещены: отказ `target-invalid: cannot reject to code or release at pre_code gate`. При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `fix`, `simple` | `owner_gate` (`gate_stage: 'pre_code'`) | Владелец (человек, без `BB_THREAD_ID`) | Отклонено владельцем: `reject --reason "<причина>"` (строго без `--target`) при шлюзе договора | `owner_gate` | `deferred` | Отклонение договора приёмки владельцем (§31.5). Задача переходит в статус `deferred` на узле `owner_gate` в ожидании нового договора (`enqueue --acceptance`) или отмены (`dequeue`). Указание любого `--target` запрещено: отказ `target-invalid: reject at contract gate does not take --target; update contract via enqueue --acceptance or dequeue`. При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `feature`, `fix`, `simple`, `docs` | `owner_gate` (`gate_stage: 'pre_release'`) | Владелец (человек, без `BB_THREAD_ID`) | Возвращено владельцем через UI (кнопка `[Вернуть]`, Б2) / `reject [--target <node>] [--reason "<причина>"]` | Допустимый узел возврата (`code`, `spec`, `design`) | `running` | Возврат на доработку перед выкладкой. Цель по умолчанию при отсутствии `--target`: `code` для feature/fix/simple, `spec` для docs. Явные допустимые цели строго по маршруту: feature — `code`, `spec`, `design`; fix/simple — строго `code`; docs — строго `spec`. Сброс счётчиков: при target design сбрасываются все счётчики (`design_check_rounds = 0`, `spec_attempts = 0`, `spec_review_rounds = 0`, `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `release_attempts = 0`); при target spec сбрасываются `spec_attempts = 0`, `spec_review_rounds = 0`, `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `design_check_rounds = 0`, `release_attempts = 0`; при target code сбрасываются `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `design_check_rounds = 0`, `release_attempts = 0`. Указание `--target release` либо цели вне маршрута отклоняется с ошибкой `target-invalid: <причина>`. При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `fix`, `simple` | `owner_gate` (`gate_stage: 'pre_code'`) | Только Владелец (человек, без `BB_THREAD_ID`) | `enqueue <KEY> --acceptance <файл|текст>` при статусе `waiting_approval` или `deferred` | `owner_gate` | `waiting_approval` | Обновление договора приёмки владельцем (§31.5). Плагин коммитит `docs/specs/acceptance/<KEY>.md` через git plumbing под автором из git-конфига, фиксирует `acceptance_sha = <new_sha>` и оставляет/переводит задачу в `waiting_approval` для проверки и одобрения. При вызове на шлюзе выкладки (`gate_stage: 'pre_release'`) отказ `acceptance-contract-immutable: cannot update acceptance contract at pre_release gate; return task to design/spec or dequeue`. (Для маршрута `feature` изменение договора выполняется исключительно через `reject --target design`). При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `feature`, `fix`, `simple`, `docs` | `owner_gate` | Владелец (человек, без `BB_THREAD_ID`) | Отложено владельцем через UI (кнопка `[Отложить]`, Б2) / `defer` | `owner_gate` | `deferred` | Запись `deferred_by = "owner"`. При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `feature`, `fix`, `simple`, `docs` | `owner_gate` | `run-queue` | Таймаут карточки взаимодействия / рестарт сервера | `owner_gate` | `waiting_approval` | Автоматический перевыпуск `PluginInteractionRequest`; постоянный статус в UI без повторных напоминаний (r34.5) |
| `fix`, `simple` | `code` | Уровень задачи | Сдан коммит кода, но обнаружен выход за рамки маршрута (§31.7, Б3, r34.2) | `design` | `running` | Машинный контроль маршрута (Б3, r34.2): затронуты пути спек, миграций, публичных API или нетто-дифф без тестов превысил лимиты проекта `routeLimits` (по умолчанию >3 файлов, >150 строк). Автоматический перевод задачи на маршрут `feature` (`task.route = 'feature'`, сброс счётчиков), передача архитектору на redesign |
| `feature`, `fix`, `simple` | `code` | Уровень задачи (`complex`/`medium`/`simple`) | Сдан коммит кода (`done`, чистая копия, `commits > 0`), рамки соблюдены, договор не изменён | `checks` | `running` | Фиксация `result_sha`. Проверка: diff `acceptance_sha..result_sha -- docs/specs/acceptance/<KEY>.md` пуст. Счётчик `check_attempts` не сбрасывается при каждой сдаче (накапливается до порога 3 отказов проверок) |
| `feature`, `fix`, `simple` | `code` | Уровень задачи | Исполнитель изменил `docs/specs/acceptance/<KEY>.md` (§31.5) | `code` | `running` | Отказ захода: `acceptance-contract-tampered`. Инкремент `code_attempts` (при ≥ 3 → `blocked`) |
| `feature`, `fix`, `simple` | `code` | Уровень задачи | Сдача со статусом done без коммитов (урок 7) | `code` | `running` | Отказ приёмки (если не `no_code`), инкремент `code_attempts` (при ≥ 3 → `blocked`), повтор с требованием коммита |
| `feature`, `fix`, `simple` | `code` | Уровень задачи | Сбой / таймаут / квота / отмена исполнителя | `code` | `running` (перевыпуск) / `stalled` | Перевыпуск по цепочке уровня задачи; при исчерпании — `stalled` |
| `feature`, `fix`, `simple` | `code` | Уровень задачи | Ход завершился вопросом / без сдачи артефакта | `code` | `running` | Узел остаётся в работе, повторный nudge исполнителя |
| `feature`, `fix`, `simple` | `code` | Координатор / Владелец | Ручной возврат при статусе `running` или `stalled`: `reject --target code --reason "..."` | `code` | `running` | Возврат на доработку кода с передачей причины. При статусе `blocked` или `deferred` вызов `reject` строго запрещён: вывод из `blocked` разрешён исключительно владельцу через команду `resume` |
| `feature`, `fix`, `simple` | `checks` | Машина (тестовый раннер в рабочей копии задачи) | Все тесты проекта и договора прошли (`exit 0`) | `review` | `running` | Автопереход к аудиту кода. Счётчик `check_attempts` успешно сброшен в 0 (токены ревьюера не тратятся на битый код) |
| `feature`, `fix`, `simple` | `checks` | Машина | Ошибка тестов (`exit ≠ 0`): инкремент `check_attempts += 1`, попыток < 3 | `code` | `running` | Возврат исполнителю кода с выводом ошибки тестов |
| `feature`, `fix`, `simple` | `checks` | Машина | Ошибка тестов (`exit ≠ 0`): инкремент `check_attempts += 1`, попыток ≥ 3 (Б6) | `code` / `design` (`running`, в `auto` при 1-м impasse) / `checks` (`blocked`) | `running` / `blocked` | Потолок 3 попыток проверок (урок 6, Б6): консультация архитектора. В `auto` при 1-й блокировке рекомендация исполняется автоматически один раз (`payload.architect_auto_applied = true`). При 2-м тупике либо в `manual` → `blocked`, эскалация владельцу со сводкой в `task_queue.payload` |
| `feature`, `fix`, `simple` | `checks` | Машина | Исход «не запускалось» (таймаут, запрещённая команда §23/§31.3) | `checks` | `stalled` | Закон «неизвестное — не ноль»: проверка не пройдена, остановка |
| `feature` | `review` | `reviewByLevel[task.level]` (роль `auditor`) | `verdict: OK, blockers: 0` для `feature` | `design_check` | `running` | Автопереход к архитектурной валидации |
| `fix`, `simple` | `review` | `reviewByLevel[task.level]` | `verdict: OK, blockers: 0` при `mode: manual` (Б1) | `owner_gate` | `waiting_approval` | Шлюз владельца перед выкладкой (Б1). Установка `payload.gate_stage = 'pre_release'`. Плагин создаёт `PluginInteractionRequest` владельцу с `result_sha` и `acceptance_sha` |
| `fix`, `simple` | `review` | `reviewByLevel[task.level]` | `verdict: OK, blockers: 0` при `mode: auto` | `release` | `running` | Автопереход к конвейеру выкладки |
| `feature`, `fix`, `simple` | `review` | `reviewByLevel[task.level]` | Замечания (`CHANGES`): инкремент `code_review_rounds += 1`, раунд < 3 | `code` | `running` | Новый заход исполнителя кода с замечаниями аудитора. Со 2-го круга (раунд ≥ 1) аудитор проверяет СТРОГО только блокеры прошлого круга (Б6) |
| `feature`, `fix`, `simple` | `review` | `reviewByLevel[task.level]` | Замечания (`CHANGES`): инкремент `code_review_rounds += 1`, раунд ≥ 3 (Б6) | `code` / `design` (`running`, в `auto` при 1-м impasse) / `review` (`blocked`) | `running` / `blocked` | Потолок 3 кругов (урок 6, Б6): автоматическая консультация архитектора. В `auto` при 1-й блокировке рекомендация архитектора (`target: code|design`) исполняется один раз автоматически (`payload.architect_auto_applied = true`, сброс счётчиков). При 2-м тупике либо в `manual` → `blocked`, эскалация владельцу (`task.blocked`) со сводкой в `task_queue.payload` |
| `feature`, `fix`, `simple` | `review` | `reviewByLevel[task.level]` | Сбой / таймаут / квота / отмена ревьюера | `review` | `running` (перевыпуск) / `stalled` | Перевыпуск по цепочке уровня ревью; при исчерпании — `stalled` |
| `feature`, `fix`, `simple` | `review` | `reviewByLevel[task.level]` | Ход завершился вопросом / без JSON-вердикта (урок 7) | `review` | `running` | Повторный nudge ревьюеру с требованием вердикта |
| `feature` | `design_check` | `architect` (роль `architect`) | `verdict: OK, blockers: 0` при `mode: manual` (Б1) | `owner_gate` | `waiting_approval` | Шлюз владельца перед выкладкой (Б1). Архитектура и договор приёмки подтверждены. Установка `payload.gate_stage = 'pre_release'`. Плагин создаёт `PluginInteractionRequest` владельцу с `result_sha` и `acceptance_sha` |
| `feature` | `design_check` | `architect` (роль `architect`) | `verdict: OK, blockers: 0` при `mode: auto` | `release` | `running` | Архитектура и договор приёмки подтверждены, автопереход к выкладке |
| `feature` | `design_check` | `architect` | Замечания (`target: "code"`): инкремент `design_check_rounds += 1`, раунд < 3 | `code` | `running` | Возврат исполнителю кода с замечаниями архитектора |
| `feature` | `design_check` | `architect` | Замечания (`target: "design"`): инкремент `design_check_rounds += 1`, раунд < 3 | `design` | `running` | Возврат архитектору на redesign с замечаниями архитектора. Сбрасываются счётчики последующих этапов спецификации и кода: `spec_attempts = 0`, `spec_review_rounds = 0`, `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0` (поскольку спецификация и код будут перерабатываться под новый дизайн с нуля) |
| `feature` | `design_check` | `architect` | Замечания по архитектуре: инкремент `design_check_rounds += 1`, раунд ≥ 3 (Б6) | `code` / `design` (`running`, в `auto` при 1-м impasse) / `design_check` (`blocked`) | `running` / `blocked` | Потолок 3 кругов (урок 6, Б6): консультация архитектора. В `auto` при 1-й блокировке рекомендация исполняется автоматически один раз (`payload.architect_auto_applied = true`). При 2-м тупике либо в `manual` → `blocked`, эскалация владельцу со сводкой разногласий в `task_queue.payload` |
| `feature` | `design_check` | `architect` | Сбой / таймаут / квота / отмена архитектора | `design_check` | `running` (перевыпуск) / `stalled` | Перевыпуск по цепочке уровня `architect`; при исчерпании — `stalled` |
| `feature` | `design_check` | `architect` | Ход завершился вопросом / без JSON-вердикта (урок 7) | `design_check` | `running` | Повторный nudge архитектору с требованием вердикта |
| `*` (push-режим) | `release` | Конвейер release (§2, роль `orchestrator`) | Публикация успешна (`published`) | `release` | `done` | Автоочистка копий `taskCleanup`, закрытие задачи в трекере |
| `*` (pr-режим) | `release` | Конвейер release | PR успешно открыт (`published`) | `release` | `pr_open` | Переход в ожидание слияния PR |
| `*` (pr-режим) | `release` | Webhook / Polling PR | PR слит в целевую ветку (`pr.merged`) | `release` | `done` | Автоочистка копий `taskCleanup`, закрытие задачи в трекере |
| `feature`, `fix`, `simple` (pr-режим) | `release` | Webhook / Polling PR | Замечания ревью в PR (`pr.changes_requested`) при статусе `pr_open` | `code` | `running` | Доработка замечаний ревью кода в открытом PR. Синхронизация ветки `<branch>` через служебную копию `wt/sync/<KEY>` (fast-forward или автослияние в `payload.pipeline_shas`), полный сброс счётчиков цикла доработки: `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `design_check_rounds = 0`, `release_attempts = 0`, раздача исполнителя кода от актуальной вершины ветки `<branch>` |
| `docs` (pr-режим) | `release` | Webhook / Polling PR | Замечания ревью в PR (`pr.changes_requested`) при статусе `pr_open` | `spec` | `running` | Доработка документации по замечаниям ревью в открытом PR. Синхронизация ветки `<branch>` через служебную копию `wt/sync/<KEY>`, сброс счётчиков: `spec_attempts = 0`, `spec_review_rounds = 0`, `release_attempts = 0`, раздача писателя спек от актуальной вершины ветки `<branch>` |
| `*` (pr-режим) | `release` | Webhook / Polling PR | PR закрыт без слияния (`pr.closed`) | `release` | `stalled` | Запись `pr_closed`, ожидание решения владельца (в течение 72 ч следит за переоткрытием; `resume` опрашивает PR, `resume --reopen` переоткрывает PR) |
| `feature`, `fix`, `simple` (pr-режим) | `release` | Только Владелец (человек, без `BB_THREAD_ID`) | `resume <KEY> --target code` при статусе `stalled` (причина `pr_closed`) | `code` | `running` | Возобновление работы после закрытия PR. Разрешено исключительно владельцу (при наличии `BB_THREAD_ID` отказ `permission-denied: owner-only`). Сбрасываются счётчики: `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `design_check_rounds = 0`, `release_attempts = 0`. Синхронизация ветки и раздача исполнителя кода от актуальной вершины ветки `<branch>` |
| `docs` (pr-режим) | `release` | Только Владелец (человек, без `BB_THREAD_ID`) | `resume <KEY> --target spec` при статусе `stalled` (причина `pr_closed`) | `spec` | `running` | Возобновление работы над документацией после закрытия PR. Разрешено исключительно владельцу (при наличии `BB_THREAD_ID` отказ `permission-denied: owner-only`). Сбрасываются счётчики: `spec_attempts = 0`, `spec_review_rounds = 0`, `release_attempts = 0`. Синхронизация ветки и раздача писателя спек от актуальной вершины ветки `<branch>` |
| `*` | `release` | Конвейер release | Отказ `release-refused: uncommitted-kb` | `release` | `stalled` | Ожидание очистки KB координатором |
| `*` | `release` | Конвейер release | Отказ `release-refused: unmerged-ui` | `release` | `stalled` | Ожидание слияния зависимости или `--force-drop-unmerged` |
| `*` | `release` | Конвейер release | Пустая заметка при `requireNote: true` | `release` | `waiting_release_note` | Ожидание заметки релиза от координатора/владельца |
| `feature`, `fix`, `simple` | `release` | Конвейер release | Отказ шагов 3/4, `conflict`, аудит-код `REJECT`: инкремент `release_attempts += 1`, попыток < 3 | `code` | `running` | Возврат в `code` от вершины ветки `<branch>` с текстом отказа выкладки |
| `feature`, `fix`, `simple` | `release` | Конвейер release | Отказ выкладки: инкремент `release_attempts += 1`, попыток ≥ 3 (Б6) | `release` / `code` / `design` (`running`, в `auto` при 1-м impasse) / `release` (`blocked`) | `running` / `blocked` | Потолок 3 попыток выкладки (урок 6, Б6): автоматическая консультация архитектора. В режиме `auto` при 1-й блокировке рекомендация архитектора (`target: release|code|design`) исполняется один раз автоматически (`payload.architect_auto_applied = true`, сброс счётчиков). При 2-м тупике либо в `manual` → `blocked`, эскалация владельцу со сводкой в `task_queue.payload` |
| `docs` | `release` | Конвейер release | Отказ шага 5 аудит-спека `REJECT` или сбой выкладки docs: инкремент `release_attempts += 1`, попыток < 3 | `spec` | `running` | Возврат в `spec` от вершины ветки `<branch>` с текстом находок аудита |
| `docs` | `release` | Конвейер release | Отказ выкладки docs: инкремент `release_attempts += 1`, попыток ≥ 3 (Б6) | `release` / `spec` (`running`, в `auto` при 1-м impasse) / `release` (`blocked`) | `running` / `blocked` | Потолок 3 попыток выкладки docs (урок 6, Б6): автоматическая консультация архитектора. В режиме `auto` при 1-й блокировке рекомендация архитектора (`target: release|spec`) исполняется один раз автоматически (`payload.architect_auto_applied = true`, сброс счётчиков). При 2-м тупике либо в `manual` → `blocked`, эскалация владельцу со сводкой в `task_queue.payload` |
| `*` | `release` | Конвейер release | Сбой выполнения скрипта выкладки | `release` | `stalled` | Оповещение координатора об ошибке выкладки |
| `*` | `release` | Координатор / Владелец | Передана заметка: `bb orchestrator release-note <KEY> "..."` строго при статусе `waiting_release_note` | `release` | `running` | Перезапуск шага 1 выкладки с указанной заметкой. При любом ином статусе задачи команда отклоняется с ошибкой `invalid-status: task is not waiting for release note (current: node=<node>, status=<status>)` |
| `*` | `[любой узел]` | Координатор / Владелец | `resume <KEY>` при статусе `stalled` (без `--target`; устранена причина: снят лимит, очистка KB, слияние UI, разрешён конфликт `diverged-remote`) | Текущий узел (`node`) | `running` | Снятие состояния зависания, повторный запуск этапа узла. Для `diverged-remote` плагин перед возобновлением верифицирует завершение слияния в `wt/sync/<KEY>` (отсутствие `MERGE_HEAD`, чистое дерево, потомок обеих сохранённых вершин `payload.sync_old_sha` и `payload.sync_remote_sha`; при нарушении — отказ `sync-unresolved`), заносит коммит слияния в `payload.pipeline_shas`, обновляет ветку через `git update-ref refs/heads/<branch> <HEAD_sha> <payload.sync_old_sha>` и удаляет `wt/sync/<KEY>`. Счётчики раундов blocked не сбрасываются. (Переходы с `--target code` или `--target spec` из `release/stalled` после `pr_closed` оформлены отдельными строками выше и разрешены строго владельцу) |
| `*` | `[любой узел]` | Только Владелец (человек, без `BB_THREAD_ID`) | `dequeue <KEY> [--reason "<причина>"]` при статусе `status ∉ ('done', 'cancelled')` | Текущий узел (`node`) | `cancelled` | Снятие задачи с очереди графа владельцем. Немедленная остановка активных тредов задачи; если по задаче был создан PR (включая статусы `pr_open` или `code/running` при доработке замечаний в PR), открытый PR закрывается через API провайдера (`gh pr close`) с комментарием об отмене; если выполнялась выкладка (`node = release`), конвейер прерывается до шага публикации; если функциональная ветка задана (`branch IS NOT NULL`): при наличии локальной ветки `refs/heads/<branch>` плагин архивирует её в тег `refs/tags/archive/<KEY>-cancelled-<ts>` и удаляет (`git branch -D <branch>`); если ветка существует в origin (`git ls-remote --heads origin refs/heads/<branch>` не пуст), плагин выполняет `git fetch origin refs/heads/<branch>`, и если локальной ветки не было либо origin опережает/разошёлся с локальной — архивирует вершину origin в тег `refs/tags/archive/<KEY>-remote-cancelled-<ts>`, после чего удаляет ветку в origin (`git push origin --delete <branch>`); если `branch IS NULL` (задача снята до старта или маршрут `research`) либо ветка отсутствует и локально, и в origin, операции с git пропускаются; временные служебные копии (`wt/release/<KEY>`, `wt/sync/<KEY>`) удаляются (`worktree remove --force`); статус переводится в `cancelled`, фиксация `cancelled_reason` в `task_queue.payload`. При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `*` | `[любой узел]` | Только Владелец (человек, без `BB_THREAD_ID`) | `resume <KEY> [--target spec|design|code|release]` при статусе `blocked` | Допустимый узел маршрута | `running` | Возобновление задачи владельцем. Общее правило: сбрасываются счётчики всех узлов от целевого до узла блокировки включительно: при target design сбрасываются все счётчики (`design_check_rounds = 0`, `spec_attempts = 0`, `spec_review_rounds = 0`, `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `release_attempts = 0`); при target spec сбрасываются `spec_attempts = 0`, `spec_review_rounds = 0`, `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `design_check_rounds = 0`, `release_attempts = 0`; при target code сбрасываются `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `design_check_rounds = 0`, `release_attempts = 0`; при target release сбрасывается `release_attempts = 0`. Цель `--target release` разрешена СТРОГО только при условии, что задача была заблокирована непосредственно на узле `release` (при вызове `--target release` из блокировки на checks, review или design_check возвращается ошибка `target-invalid: cannot resume to release from unreviewed or unverified code`). Цель по умолчанию — заблокированный узел (для checks/review — `code`, для spec_review — `spec`, для design_check — `design`, для release — `release`). Допустимые цели строго по маршруту: feature — `code`, `spec`, `design`, `release`; fix/simple — строго `code`, `release`; docs — строго `spec`, `release`. Попытка указать узел вне маршрута отклоняется `target-invalid`. При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `*` | `[любой узел]` | Только Владелец (человек, без `BB_THREAD_ID`) | `resume <KEY>` при статусе `deferred` | Текущий узел (`node`) | `running` / `waiting_approval` | Возобновление работы владельцем. При наличии `BB_THREAD_ID` отказ `permission-denied: owner-only` |
| `research` | `research` | `research` (роль `researcher`) | Отчёт сдан (`status: done`) | `research` | `done` | Сохранение отчёта в базу/KB, закрытие задачи |
| `research` | `research` | `research` | Сбой / таймаут / квота / отмена исследователя | `research` | `running` (перевыпуск) / `stalled` | Перевыпуск по цепочке уровня `research`; при исчерпании — `stalled` |
| `research` | `research` | `research` | Ход завершился вопросом / без отчёта (урок 7) | `research` | `running` | Узел в работе, повторный nudge исследователю |
| `feature` | `spec_review` | Машина (предпроверка TDD Fail-First) | Договор приёмки тривиален / без падающих тестов (`acceptance_vacuous`, r34.5) | `design` | `running` | Возврат архитектору на redesign договора приёмки. Инкремент `design_check_rounds` (при ≥ 3 → `blocked`) |
| `fix`, `simple` | `start, owner_gate` (статусы `queued`, `running`, `waiting_approval`, `deferred`) | Машина (предпроверка TDD Fail-First) | Договор приёмки тривиален / без падающих тестов (`acceptance_vacuous`, r34.5) | `owner_gate` | `waiting_approval` | Остановка перед кодом: договор приёмки на fix/simple уже полностью зелёный на базовом коммите. Инкремент `check_attempts` (при ≥ 3 → `blocked`). `payload.gate_stage = 'pre_code'`, `payload.vacuous_contract = true`. Сброс `deferred_by`/`deferred_reason`. Запрос владельцу на обновление договора через `enqueue --acceptance` |

### 28.2 Сервис `run-queue`, лимиты и будильник узла

1. **Сервис и CLI:** Конвейер `run-queue` работает как постоянная фоновая служба внутри процесса плагина оркестратора. Команда CLI `bb orchestrator run-queue` выполняет ровно один такт проверки и продвижения очереди (`--once`, по умолчанию).
2. **Лимит параллельности (`maxActiveTasks`):** Настройка проекта `orchestrator.maxActiveTasks` (целое число, по умолчанию 1). Сервис берёт новую задачу из очереди (`queued`) только пока число задач в статусе `status = 'running'` строго меньше `maxActiveTasks`. Задачи в пассивных состояниях ожидания (`waiting_approval`, `waiting_release_note`, `pr_open`, `deferred`, `blocked`, `stalled`, `cancelled`) слот активного параллелизма не занимают. Если исполнитель в статусе `stalled` завершает работу (`done`), переход в `running` выполняется с учётом `maxActiveTasks` (при нехватке слотов задача ожидает освобождения в очереди).
3. **Конфигурация узлов (`node_policy`):** Объект конфигурации в политике проекта:
   `node_policy: { [nodeName]: { timeout_seconds: number, max_retries: number, level?: string } }`.
   Умолчания при отсутствии явной записи: `timeout_seconds = 3600`, `max_retries = 3`.
4. **Механизм эскалации архитектору при блокировке (урок 6 аудита, уточнения r34.1, Б6):**
   - **Правило со 2-го круга ревью (Б6):** начиная со второго круга (`spec_review_rounds ≥ 1` или `code_review_rounds ≥ 1`), аудитор проверяет **СТРОГО ТОЛЬКО блокеры, зафиксированные на предыдущем круге**. Запрещается предъявлять новые блокирующие замечания к частям спецификации или кода, которые не менялись со времени прошлого круга. Новые соображения оформляются исключительно как неблокирующие предложения.
   - **Авто-исполнение рекомендации архитектора при 1-й блокировке (Б6):**
     При достижении потолка 3 кругов на узлах `spec_review`, `review`, `checks`, `design_check` или `release` задача переходит в фазу разрешения тупика. Сервис `run-queue` формирует сводку разногласий в `task_queue.payload` и автоматически запрашивает разовую консультацию уровня `architect` (роль `architect`, `tools: []`):
     «Задача <KEY> заблокирована после 3 кругов замечаний/отказов. Изучи сводку разногласий в payload и дай рекомендацию: целесообразен ли возврат в code, spec, design, повтор выкладки release, смягчение договора или эскалация владельцу (отказ от фичи)».
     Консультация архитектора — это короткий служебный запрос без инструментов (`tools: []`), выполняемый в контексте задачи, и **НЕ занимает слот параллельности `maxActiveTasks`** (не задерживает продвижение активных задач в очереди).
     - **В режиме `auto` («авто»):** если это первая блокировка задачи (`payload.architect_auto_applied` не установлен) и архитектор вернул чёткую рекомендацию с указанием целевого узла из допустимого подмножества для текущего узла и маршрута:
       * при блокировке на `spec_review`: допустимы `spec`, `design` (для `feature`) либо строго `spec` (для `docs`);
       * при блокировке на `checks` или `review`: допустимы `code`, `design` (для `feature`) либо строго `code` (для `fix`, `simple`);
       * при блокировке на `design_check`: допустимы `code`, `design`;
       * при блокировке на `release`: допустимы `release` (повтор публикации), `code`, `design` (для `feature`), строго `release`, `code` (для `fix`, `simple`), строго `release`, `spec` (для `docs`).
       Если архитектор указал цель вне допустимого подмножества узла и маршрута (например, `target: release` при сбое проверок на `checks`, либо `target: design` на маршруте `fix`), рекомендация считается **неприменимой**, авто-исполнение отклоняется, и задача штатно переводится в статус `blocked` с эскалацией владельцу.
       При валидной допустимой цели рекомендация **автоматически исполняется ровно один раз кодом конвейера**:
       - задача переводится в целевой узел со статусом `running`;
       - сбрасываются счётчики последующих этапов от целевого узла строго по правилам `resume` матрицы §28.1: при `target: release` сбрасывается `release_attempts = 0`; при `target: code` сбрасываются `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `design_check_rounds = 0`, `release_attempts = 0`; при `target: spec` сбрасываются `spec_attempts = 0`, `spec_review_rounds = 0`, `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `design_check_rounds = 0`, `release_attempts = 0`; при `target: design` сбрасываются все 7 счётчиков (`design_check_rounds = 0`, `spec_attempts = 0`, `spec_review_rounds = 0`, `code_attempts = 0`, `check_attempts = 0`, `code_review_rounds = 0`, `release_attempts = 0`);
       - в `task_queue.payload` фиксируется флаг `architect_auto_applied = true` и текст рекомендации.
     - **В режиме `manual` («сам»), либо при 2-м тупике (если `payload.architect_auto_applied === true`), либо при отсутствии применимой рекомендации архитектора:** задача переводится в статус `blocked`, эскалируется владельцу (`task.blocked`) со сводкой в `task_queue.payload`, и дальнейшее продвижение разрешается исключительно владельцем через команду `bb orchestrator resume <KEY> [--target ...]`, кнопки UI (Б2) либо `bb orchestrator defer <KEY>`.

5. **Будильник узла (`node_alarm_at`):**
   - Будильник узла взводится **ТОЛЬКО на активных рабочих узлах**: `design`, `spec`, `spec_review`, `code`, `checks`, `review`, `design_check`, `release`, `research`.
   - Пассивные состояния ожидания (`owner_gate`, `waiting_release_note`, `pr_open`, `deferred`, `blocked`, `done`, `stalled`, `cancelled`) будильник **НЕ взводят** (задача вправе ждать решения человека или слияния PR).
   - **Лимит выполнения при живом исполнителе:** если тред исполнителя находится в активном выполнении хода (`thread.status === 'running'`), будильник не переводит задачу в `stalled` до истечения предельного лимита времени выполнения хода (по умолчанию 3× `timeout_seconds`, т.е. 3 часа) либо срабатывания сторожа зависаний §5 (отсутствие активности дольше `firstResponseSeconds`). По истечении предельного времени тред останавливается и задача переводится в `stalled`.
   - **Сброс будильника:** Сбрасывается и пересчитывается **СТРОГО** при получении доказательства, относящегося **непосредственно к этой задаче и текущему узлу**:
     1) Новый коммит в ветке задачи `<branch>` (хранимой в `task_queue.branch`) от исполнителя узла;
     2) Запись вердикта ревью для коммита этой задачи;
     3) Успешный переход задачи в следующий узел.
   - Фоновые такты сервиса `run-queue`, действия над другими задачами (`enqueue`/`transition` других задач) и сообщения тредов без артефактов **НЕ СБРАСЫВАЮТ** будильник узла!
   - При срабатывании будильника: первое срабатывание — повторный пинг исполнителя узла; второе срабатывание (2× timeout) — перевод задачи в статус `stalled` и оповещение координатора/владельца.
   - Сторож координатора (§5.6) будит координатора только тогда, когда задача перешла в статус `blocked`, `stalled` или `waiting_release_note`, требующий вмешательства. В штатном режиме исполнения координатор остаётся в покое.

## 29. Ревизия 34: режимы одобрения (`approvalMode`)

Режим подтверждения перехода задаётся полем `confirmation_mode` в таблице `task_queue` (`CHECK(confirmation_mode IN ('auto', 'manual'))`).

1. **Режимы:**
   - **`auto` («авто»):** Полная автономность конвейера. Конвейер работает непрерывно до полного завершения задачи (`done`) без пауз на человека. Переходы между узлами происходят автоматически по доказательствам машинного конвейера (сдача спеки → ревью спеки → при `OK` сразу переход к коду и раздаче исполнителю с `--from <spec_sha>` для feature или `--from <acceptance_sha>` для fix/simple → проверки `checks` → ревью кода → `design_check` → выкладка `release` → `done`).
   - **`manual` (режим «сам», решение владельца 15.11, Б1):** Владелец одобряет ТОЛЬКО спецификацию/договор и выкладку на всех маршрутах. Шлюз владельца `owner_gate` активируется:
     - на маршруте `feature`: дважды — после `spec_review` (согласование спеки перед кодом, `payload.gate_stage = 'pre_code'`) и после `design_check` (перед выкладкой `release`, `payload.gate_stage = 'pre_release'`);
     - на маршрутах `fix` и `simple`: дважды — при `start` (проверка договора перед кодом, `payload.gate_stage = 'pre_code'`) и после `review` (перед выкладкой `release`, `payload.gate_stage = 'pre_release'`);
     - на маршруте `docs`: один раз — после `spec_review` (перед выкладкой документации `release`, `payload.gate_stage = 'pre_release'`).
     При входе в `owner_gate` задача получает статус `waiting_approval` и отметку этапа в `payload.gate_stage` (`'pre_code'` либо `'pre_release'`). Владелец получает уведомление:
     - на шлюзе перед кодом (`gate_stage: 'pre_code'`): ссылка на договор приёмки (`acceptance_sha`), коммит спецификации (`spec_sha` для `feature`), маршрут и уровень;
     - на шлюзе перед выкладкой (`gate_stage: 'pre_release'`): проверяемый коммит готового результата (`result_sha` для маршрутов с кодом, либо `spec_sha` для `docs`), ссылка на неизменяемый договор приёмки (`acceptance_sha`), краткая сводка диффа и пройденных проверок/ревью.
     Переход в `code` (при `pre_code`) или в `release` (при `pre_release`) разрешается ТОЛЬКО решением владельца.

2. **Интерфейс: единый компактный селектор роли и режима одобрения (решение владельца 20.11, замена тумблера):**
   - **Компактный элемент в строке поля ввода:** Вместо раздельных элементов «подпись Роль + список + тумблер» плагин занимает в строке поля ввода ровно один компактный элемент — кнопку-меню. Подпись «Роль» отсутствует, ширина элемента не превышает стандартный размер селектора роли. На кнопке отображается название текущей роли и значок режима одобрения (`✅` для авто, `👤` для ручного режима), если режим применим.
   - **Составное выпадающее меню:** По нажатию на кнопку открывается меню, состоящее из двух независимых секций:
     1) **«Роль»:** список доступных ролей треда, галочкой отмечена активная роль;
     2) **Разделитель и секция «Одобрение»:** пункты `✅ Авто` и `👤 Сам`, галочкой отмечен текущий режим подтверждения.
     Выбор в одной части не сбрасывает режим в другой, и наоборот.
   - **Условия отображения режима одобрения:** Секция «Одобрение» в меню и значок режима (`✅`/`👤`) на кнопке отображаются ТОЛЬКО при включённом графе задач (`workGraph` в режиме `shadow` или `strict`, не `off`) и ТОЛЬКО у тредов с ролью `orchestrator` или `executor`. Для роли `auditor`, `researcher`, `none` либо при выключенном графе (`workGraph: off`) секция одобрения отсутствует и значок на кнопке не показывается (чтобы не вводить в заблуждение недействующей кнопкой).
   - **Доступность и реализация:** Меню строится на базе готового компонента меню BB UI (без самописных выпадающих списков с нуля), поддерживает открытие и навигацию на мобильных экранах (360–430px) и с клавиатуры.
   - **Область действия переключения режима:**
     * в окне чата конкретной задачи (тред исполнителя с привязанной задачей `<KEY>`): переключает `confirmation_mode` **ТОЛЬКО этой конкретной задачи** в `task_queue` (`UPDATE task_queue SET confirmation_mode = ? WHERE task_key = ?`) и **НЕ затрагивает** проектную настройку;
     * в окне чата координатора (`orchestrator`): обновляет проектную настройку `orchestrator.approvalMode` (действует как значение по умолчанию для всех вновь создаваемых задач).
   - **Кнопки действий владельца в UI:** Каждое действие владельца представлено нативной интерактивной кнопкой в карточке задачи, панели очереди задач и в карточке запроса подтверждения `PluginInteractionRequest`:
     - `[ Одобрить ]` — переход к написанию кода либо к выкладке (`bb orchestrator approve <KEY>`);
     - `[ Вернуть ]` — вызов модального окна выбора целевого узла возврата (`spec`, `design`, `code`) и ввода причины (`bb orchestrator reject <KEY>`);
     - `[ Отложить ]` — модальное окно ввода причины (`bb orchestrator defer <KEY> --reason ...`);
     - `[ Возобновить ]` — модальное окно выбора целевого узла при блокировке (`bb orchestrator resume <KEY> --target ...`);
     - `[ Снять с очереди ]` — подтверждение отмены (`bb orchestrator dequeue <KEY>`).
   - Кнопки отправляют RPC с категорией `kind: 'client'`, исключая необходимость ручной работы в терминале при штатном взаимодействии.

3. **Старшинство настроек и разрешение режима:**
   1) При постановке человеком (`enqueue` без `BB_THREAD_ID`): явный флаг `--mode auto|manual`, либо переключение тумблера владельца в UI окна чата;
   2) Если владелец явно установил проектную настройку `orchestrator.approvalMode` (`auto` или `manual`, §18.7), она применяется ко всем задачам проекта (и при постановке агентом, и при постановке человеком без явного флага);
   3) Если настройка `orchestrator.approvalMode` не задана явно (значение по умолчанию `null`):
      - при постановке человеком без флага: по умолчанию `manual` для `feature`, `auto` для `fix`, `simple`, `docs`, `research`;
      - при постановке агентом (`enqueue` с `BB_THREAD_ID`, где флаг `--mode` запрещён правилом owner-only): режим вычисляется автоматически по маршруту — `manual` для `feature`, и `auto` для облегчённых маршрутов `fix`, `simple`, `docs`, `research` (сохраняя автономность конвейера Б3 с обязательным машинным контролем соблюдения рамок маршрута при сдаче кода по §31.7).
   При постановке задачи команда `bb orchestrator enqueue` вычисляет значение `confirmation_mode` строго по правилам разрешения 1–3 и явно записывает вычисленное значение в колонку `task_queue.confirmation_mode`. Значение `DEFAULT 'manual'` в схеме SQLite (§27.1) служит лишь защитным фолбэком на случай прямых/неполных вставок и не подавляет маршрутный дефолт `auto`.

4. **Единое строгое правило «только владелец» (согласованно с §23 п.3, PLUG-360):**
   - Любой вызов команд управления очередью и критических настроек, требующих человеческого решения:
     - `bb orchestrator approve <KEY> [--comment <текст>]`
     - `bb orchestrator defer <KEY> --reason <причина>`
     - `bb orchestrator dequeue <KEY> [--reason <причина>]`
     - передача параметра `--acceptance` в `bb orchestrator enqueue`
     - `bb orchestrator resume <KEY>` (при статусе `blocked` или `deferred`)
     - `bb orchestrator reject <KEY>` (на узле `owner_gate`)
     - передача флага `--mode` в `bb orchestrator enqueue`
     выполненный при наличии переменной окружения `BB_THREAD_ID` (независимо от объявленной роли в треде: `orchestrator`, `helper`, `executor`, `auditor`, `researcher`, `architect`, `release-auditor` или при отсутствии роли), **СТРОГО ОТКЛОНЯЕТСЯ** кодом плагина с ошибкой `permission-denied: owner-only (команды управления очередью и подтверждениями разрешены исключительно владельцу)`.
   - **Выбор режима в меню из окна треда разрешён:** селектор роли и режима одобрения расположен в поле ввода внутри треда. Вызов RPC из меню (`setProjectApprovalMode`, `setTaskConfirmationMode`) выполняется от имени интерфейса владельца и разрешён; команды смены режимов и одобрения отсутствуют в наборе инструментов агентов, поэтому агент не может вызвать их через схемы инструментов.
   - Честная фиксация границы платформы (строго по аналогии с §23.3, PLUG-360):
     В локальной однопользовательской ОС субпроцессы агентов работают под той же учётной записью пользователя ОС, поэтому агент технически может попытаться вызвать команду CLI напрямую (`env -u BB_THREAD_ID bb orchestrator approve ...` или `bb plugin config orchestrator set ...`). При `settings.onChange` платформа BB не передаёт идентификатор треда и не различает инициатора (терминал, агент, UI).
     Поэтому защита критических настроек строится на совокупности мер:
     1) Команды управления очередью и смены режимов (`approve`, `defer`, `setProjectApprovalMode`) отсутствуют в наборе инструментов этих ролей (у ролей `executor`, `auditor`, `researcher`, `architect` нет этих инструментов в схемах `tools: []`, а также они не предоставляются координатору: координатор не одобряет задачи и не меняет глобальный режим за владельца — слово владельца 18.11);
     2) Проверка контекста процессов: отказ CLI-команд при наличии `BB_THREAD_ID` в переменных окружения;
     3) Карточка уведомления (`PluginInteractionRequest`) используется исключительно как форма отображения и принятия решений для владельца; программные ответы агентов игнорируются плагином;
     4) Машинная запись и карточка владельцу (PLUG-360): плагин считает «своей» только смену, пришедшую из его собственного интерактивного меню (перед записью настройки меню выставляет короткоживущую метку/токен намерения); любая другая смена критических настроек (`workGraph`, `workGraphProjects`, `approvalMode`) фиксируется машинным событием `settings_changed_outside_menu` в таблице `events` и журнале `command_runs`, и немедленно создаёт интерактивную карточку владельцу `PluginInteractionRequest` с двумя кнопками: «Оставить» и «Вернуть прежнее значение». Никаких команд в терминале для владельца не требуется.

5. **Защита от занижения маршрута без ломки автономности (Б3):**
   - Задачи `fix`, `simple`, `docs`, поставленные агентом (получающие режим `auto` по умолчанию маршрута или из `orchestrator.approvalMode`), выполняются полностью автономно до завершения задачи (`done`) без блокирующей ручной паузы на старте (сохраняя принцип «поставил задачу, конвейер работает до сдачи/релиза»).
   - Защита обеспечивается **машинной проверкой соблюдения границ маршрута при сдаче кода (§31.7, Б3, r34.2)**: если исполнитель на маршруте `fix` или `simple` затронул спецификации (пути `orchestrator.routeLimits.specPaths`), миграции/схемы БД (`migrationPaths`), публичные интерфейсы/CLI (`apiPaths`) или превысил лимиты нетто-диффа без тестов (`maxFiles`, `maxLines`, по умолчанию >3 файлов, >150 строк), сдача кода автоматически бракуется машиной, и задача переводится на маршрут `feature` в узел `design` (перепроектирование архитектором), исключая незаметное протаскивание архитектурных правок под видом простых задач.

## 30. Ревизия 34: роль и уровень `architect`

Слово владельца 18.11: сильная модель проектного уровня (например, Opus 5.5 / Gemini 3.8 Pro) проектирует на старте и валидирует в конце; оркестратор ведёт операционную работу.

1. **Роль `architect`:** встроенная (`LevelRole`: `executor`, `auditor`, `researcher`, `architect`). Текст роли (en/ru, ≤ 2500): «Ты — архитектор. Проектируешь на старте и перепроверяешь в конце: архитектура решения, спека верхнего уровня, договор приёмки (§31), а также проводишь разовые консультации при эскалациях и блокировках задач (§28.2 п.4). Код не пишешь, файлы не коммитишь, работу не раздаёшь, не выкладываешь, помощников не зовёшь. Итог — текстом: решения и договор приёмки (узел `design`), вердикт по архитектуре и договору (узел `design_check`; последней строкой JSON `{"verdict":"OK"|"CHANGES","blockers":N,"target":"code"|"design"}`), либо рекомендация владельцу при эскалации». Инструментов изменения кода и раздачи у архитектора нет (`tools: []`).
2. **Уровень `architect` в политике:** `role: "architect"`. Пример конфигурации владельца на стенде: `architect-opus` (Opus 5.5, claude-code) → `architect-gemini` (Gemini 3.8 Pro, agy).
3. **Узлы архитектора:**
   - `design` (до кода, маршрут `feature`): архитектор получает задачу и контекст, возвращает архитектурное решение и текст договора приёмки (§31);
   - `design_check` (перед выкладкой): архитектор проверяет готовый результат против архитектуры и покрытия договора приёмки; вердикт — строгий JSON `{"verdict":"OK"|"CHANGES","blockers":N,"target":"code"|"design"}`.
4. **Пропуск для простых задач:** маршруты `fix`, `docs`, `simple`, `research` пропускают узлы `design` и `design_check` (сильная модель не расходуется на механические правки).

## 31. Ревизия 34: договор приёмки до кода и машинные проверки (`checks`)

Урок аудита: PLUG-293 — критерий «готово» плавал, спека росла под код (17 отказов аудита). Договор приёмки пишется **до кода** на узле `design` архитектором (§30); на маршрутах без `design` (`fix`, `simple`) — задаётся параметром `--acceptance <файл|текст>` при постановке задачи `enqueue`, либо формируется из настроенных команд проверок проекта `checks.commands`. Если при постановке `fix`/`simple` не переданы ни `--acceptance`, ни `checks.commands`, постановка задачи отклоняется с ошибкой `acceptance-missing: укажи --acceptance или настрой checks.commands проекта`.

1. **Состав договора:** список проверяемых пунктов; у каждого — явная команда верификации (тесты проекта, вызовы CLI) и ожидаемый результат.
2. **Фиксация коммитом (`acceptance_sha`) и изоляция:**
   - Имя функциональной ветки задачи фиксируется при постановке в очередь `enqueue` в колонке `task_queue.branch` (`bb/<KEY>-<slug>`, §27.1; для `research` — `NULL`). При старте задачи сервис `run-queue` создаёт эту ветку от `origin/<mergeBaseBranch>` (если ветка уже существует чистой — переиспользует её; если содержит сторонние коммиты — `stalled: branch-exists`).
   - На узле `design` архитектор возвращает текст договора приёмки. Внутренний процесс плагина через git plumbing (`git hash-object`, `git mktree`, `git commit-tree`) напрямую создаёт коммит с файлом `docs/specs/acceptance/<KEY>.md` в функциональной ветке `task_queue.branch` под автором из git-конфига репозитория (`user.name`/`user.email`) без создания рабочих копий и без срабатывания агентских pre-commit хуков. SHA этого коммита сохраняется в `task_queue.acceptance_sha`.
   - На маршрутах `fix` и `simple` сервис плагина аналогично коммитит договор при старте задачи (`start`) из сохранённого `task_queue.payload.acceptance_text` (или из `checks.commands`) до запуска узла `code`. Значение `spec_sha = NULL`.
   - На маршруте `docs` узел `spec` раздаётся непосредственно от ветки задачи (договор приёмки не используется, `acceptance_sha = NULL`).
   - На маршруте `feature` узел `spec` раздаётся строго с параметром `from: <acceptance_sha>`. Проверка сдачи узла `spec` верифицирует, что `docs/specs/acceptance/<KEY>.md` не изменён (`git diff acceptance_sha..HEAD -- docs/specs/acceptance/<KEY>.md` пуст). Писатель спек коммитит документацию поверх договора (`spec_sha`).
   - Раздача узла `code`:
     - Для маршрута `feature`: раздаётся строго с параметром `from: <spec_sha>`. Изолированная копия исполнителя гарантированно содержит и неизменяемый договор приёмки (в истории коммитов), и утверждённую спецификацию.
     - Для маршрутов `fix` и `simple`: раздаётся строго с параметром `from: <acceptance_sha>`. Изолированная копия исполнителя содержит неизменяемый договор приёмки в ветке задачи.
   - Защита от подмены договора (§31.5): при завершении захода исполнителя кода плагин проверяет `git diff <acceptance_sha>..<result_sha> -- docs/specs/acceptance/<KEY>.md`. Любая модификация договора исполнителем приводит к отклонению захода: `acceptance-contract-tampered: исполнитель изменил договор приёмки`.
3. **Безопасность выполнения на машинном узле `checks`:**
   - Команды проверок запускаются в изолированной рабочей копии задачи текущего захода исполнителя `wt/<KEY>-<round>` (сокращённо `wt/<KEY>`).
   - Машина считывает договор строго из коммита `acceptance_sha`: `git show <acceptance_sha>:docs/specs/acceptance/<KEY>.md`.
   - В целях предотвращения выполнения непроверенного кода (§23) машина запускает ТОЛЬКО:
     1) Команды проверок проекта из настройки `checks.commands` / `testCommand`, предварительно одобренные владельцем по §23;
     2) Команды верификации договора приёмки, если соблюдено хотя бы одно условие:
        - задача находится в режиме `manual` и договор был подтверждён владельцем на шлюзе `owner_gate` (коммит `acceptance_sha`);
        - либо команда соответствует списку `checks.allowedRunners` (настройка проекта, по умолчанию: `["npm test", "npm run test", "npm run test:*", "npm run lint", "pytest", "cargo test", "go test ./..."]`).
   - **Правила передачи аргументов и запуск:**
     - Запуск команд раннеров производится строго массивом аргументов (`shell: false`).
     - Команда обязана начинаться с разрешённого префикса из `checks.allowedRunners`.
     - Дополнительные аргументы допускаются ТОЛЬКО для фильтрации и параметров тестов (например, `-k <паттерн>`, `-v`, `--filter <имя>`, `--bail`, `--ci`, `--coverage`, `pytest -k ...`, `cargo test -- <имя_теста>`).
     - Любые флаги, допускающие запуск произвольного исполняемого файла или кода (например, `go test -exec ...`, `--import ...`, `-o ...`, `--pdb`, `--run-command`), любые утилиты скачивания и произвольного выполнения пакетов (`npx`, `npm exec`, `npm x`, `npm init`, `npm install`, `npm i`, `go run`, `go install`, `go get`, `cargo install`) и любые шелл-метасимволы (`&&`, `||`, `;`, `|`, `$()`, backticks) СТРОГО ЗАПРЕЩЕНЫ и отклоняются с ошибкой `checks-refused: forbidden-command` или `checks-refused: forbidden-flag`.
   - Произвольные неавторизованные команды отклоняются, переводя узел `checks` в исход «не запускалось» (`not_run`).
   - Честная фиксация границы безопасности на узле `checks` (по аналогии с §23.3, обновлено в r34.5 / ADR-0037, §34.3): запуск раннера (`npm test`, `pytest`, `cargo test`, `go test`) неизбежно исполняет код тестов и конфигурации из рабочего дерева (`package.json`, `conftest.py`, `build.rs`). Белый список раннеров отсекает произвольный шелл и скачивание внешних утилит (`curl|bash`, `npx`, `go run`). Для защиты хоста узел `checks`: (1) запускается в изолированной копии текущего захода задачи (`wt/<KEY>-<round>`, сокращённо `wt/<KEY>`); (2) формирует окружение строго по белому списку разрешённых системных переменных `checks.allowedEnvVars` (по умолчанию: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `SHELL`, `TERM`, `TMPDIR`, `NODE_ENV`, `CI`; в `checks.extraEnvVars` переменные со словами `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` строго запрещены); (3) ограничен настраиваемым тайм-аутом `checks.timeout_seconds` (по умолч. 600 с / 10 мин, диапазон 30…3600 с) с завершением по `SIGKILL`.
   - Если проверки упали (`exit ≠ 0`): задача возвращается исполнителю в узел `code` с выводом ошибки без траты токенов ревьюера. Ревьюер подключается только к зелёному коду.
4. **Закон трёх исходов каждого пункта:** «прошло», «упало», «не запускалось». «Не запускалось» не считается проходом («неизвестное — не ноль»). Пустой договор или все пункты «не запускалось» — проверка не пройдена.
5. **Защита и изменение договора приёмки:**
- Для маршрута `feature`: текст договора приёмки `docs/specs/acceptance/<KEY>.md` формируется и изменяется **исключительно архитектором** на узле `design` (при начальном проектировании, автоматическом возврате на redesign с узла `design_check` при замечаниях архитектора, либо по решению владельца через `reject --target design` / `resume --target design`).
- Для маршрутов `fix` и `simple`: начальный договор задаётся владельцем параметром `--acceptance <файл|текст>` при `enqueue` либо формируется из `checks.commands`. Если владелец на шлюзе `owner_gate` при `gate_stage = 'pre_code'` отклоняет договор (`reject --reason "<причина>"` строго без `--target`), задача переходит в статус `deferred`. Для изменения договора на `fix`/`simple` владелец вызывает команду обновления договора задачи `bb orchestrator enqueue <KEY> --acceptance <файл|текст>` (при нахождении задачи в статусе `waiting_approval` или `deferred` на узле `owner_gate` при `gate_stage = 'pre_code'`), либо снимает задачу с очереди командой `bb orchestrator dequeue <KEY>` и ставит её заново с новым договором через `bb orchestrator enqueue <KEY> --acceptance <файл|текст> [--force-reset-branch]`. Передача параметра `--acceptance` разрешена исключительно владельцу (при наличии `BB_THREAD_ID` отказ `permission-denied: owner-only`). Попытка вызвать `enqueue --acceptance` на шлюзе выкладки (`gate_stage = 'pre_release'`) отклоняется с ошибкой `acceptance-contract-immutable: cannot update acceptance contract at pre_release gate; return task to design/spec or dequeue`. При получении обновлённого договора процесс плагина через git plumbing коммитит обновлённый файл `docs/specs/acceptance/<KEY>.md` в ветку задачи под автором из git-конфига репозитория, обновляет `acceptance_sha = <new_sha>` и оставляет/переводит задачу в статус `waiting_approval` на узле `owner_gate` для проверки и одобрения владельцем. Прямая ручная правка файлов в ветке в обход процесса плагина запрещена. (Для маршрута `feature` изменение договора приёмки через `enqueue --acceptance` запрещено: договор проектируется и изменяется исключительно архитектором на узле `design` через `reject --target design`).
- Писателю спеки на узле `spec` и исполнителю кода на узле `code` любая модификация или удаление договора приёмки СТРОГО ЗАПРЕЩЕНЫ и приводят к отказу захода (`spec-refused: acceptance-contract-modified` на спеке, `acceptance-contract-tampered` на коде) без смены узла, с инкрементом счётчика попыток этапа (при ≥ 3 → `blocked`).
6. **Машинная сверка спецификации перед ревью (Б7, r34.2):**
   До передачи коммита спецификации на узел `spec_review` плагин запускает автоматическую проверку спецификации против базового состояния кодовой базы (`origin/<mergeBaseBranch>`):
   1) Сверка спецификаций строго по дельте: проверка ссылок на кодовую базу анализирует ТОЛЬКО ДОБАВЛЕННЫЕ СТРОКИ коммита спецификации (`git diff -U0 $baseSha..$specSha -- docs/`, строки, начинающиеся с `+`, кроме `+++`). Предсуществующий текст спецификаций повторно не валидируется. Все непомеченные сущности в добавленных строках обязаны физически существовать на базовом коммите `$baseSha`.
   2) Сверка путей файлов: все пути к файлам репозитория, упоминаемые в добавленных строках спецификации (вне явного раздела новых сущностей `## Новые сущности / New Entities` или явных пометок `[new]`), обязаны физически существовать в дереве проекта на базовом коммите.
   3) Сверка символов и сущностей: для существующих файлов упоминаемые в добавленных строках имена функций, классов, методов, констант и типов обязаны физически присутствовать в тексте названного файла на базовом коммите (проверка прямым текстовым поиском подстроки/идентификатора в содержимом файла, без привязки к языку программирования, AST и package.json).
   4) Явная пометка нового: новые файлы, функции, классы, методы, константы и типы, которые предстоит создать в коде задачи, автор спецификации обязан явно пометить в тексте спеки: отдельным разделом `## Новые сущности / New Entities`, либо явной пометкой `[new]` у имени. Все сущности и пути в добавленных строках, НЕ помеченные как новые, подлежат обязательной сверке на физическое существование в кодовой базе базового коммита. Проверка непомеченных команд отдельно не производится (так как привязка к `package.json` и AST исключена); если упоминаемая функциональность привязана к исходному коду, она проверяется в нём текстовым поиском как символ.
   5) Универсальность проверки и закон трёх исходов (§31.4):
      - проверка полностью универсальна и не зависит от языка реализации проекта;
      - если проверка не смогла запуститься или завершилась системным сбоем (нет git, ошибка доступа, таймаут, сбой окружения) — фиксируется исход «не запускалось», что по §31.4 НЕ считается проходом («неизвестное — не ноль»), и сдача не допускается к ревью до устранения причины сбоя проверки;
      - если спецификация ссылается на непомеченные несуществующие файлы или символы: сдача отклоняется machine-side с ошибкой `spec-refused: invalid-codebase-reference` с возвратом писателю спек перечня некорректных ссылок до траты токенов аудитора (инкремент `spec_attempts`, при ≥ 3 → `blocked`).
   **Правило универсальности (слово владельца 18.11, Б7):** исполнитель оркестратора на узлах спецификации (`spec`) и написания кода (`code`) всегда читает из git и коммитит в git. Никакой «сдачи текстом» для кода и спецификаций в оркестраторе нет. Если провайдер не имеет нативных пишущих инструментов, адаптер записи и коммита реализуется внутри его собственного плагина провайдера. (Исключения: архитектор на узлах `design` и `design_check` сдаёт структурированный текст/JSON без коммита файлов по §30; исследователь на узле `research` сдаёт отчёт в базу/KB по §21).
7. **Машинная проверка соблюдения границ маршрута при сдаче кода (Б3, r34.2):**
   При сдаче кода на маршрутах `fix` и `simple` сервис `run-queue` выполняет автоматическую верификацию диффа `acceptance_sha..result_sha`:
   1) Запрет изменения спецификаций: ни один файл в путях спецификаций проекта не должен быть затронут (настройка проекта `orchestrator.routeLimits.specPaths`, по умолчанию: `["docs/specs/**", "docs/adr/**"]`, диалект glob-шаблонов §18.5);
   2) Запрет изменения миграций и схем БД: ни один файл в путях миграций и схем БД не должен быть затронут (настройка проекта `orchestrator.routeLimits.migrationPaths`, по умолчанию: `["migrations/**", "schema.sql", "**/*.sql"]`, диалект glob-шаблонов §18.5);
   3) Запрет изменения публичных интерфейсов: публично экспортируемые команды CLI и API не должны быть модифицированы (настройка проекта `orchestrator.routeLimits.apiPaths`, по умолчанию: `["src/api/**", "src/cli/**"]`, диалект glob-шаблонов §18.5);
   4) Порог объёма изменений: суммарный diff не превышает лимитов проекта (настройки `orchestrator.routeLimits.maxFiles` — по умолчанию 3 изменённых файла, `orchestrator.routeLimits.maxLines` — по умолчанию 150 добавленных/удалённых строк кода).
      **Исключение тестовых файлов:** тестовые файлы (файлы, соответствующие маскам `tests/**`, `**/tests/**`, `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `**/__tests__/**` по диалекту glob-шаблонов §18.5, где `*` сопоставляется внутри сегмента пути без `/`, а `**` покрывает произвольное число каталогов) **В ОБЪЁМ НЕ СЧИТАЮТСЯ** (не увеличивают счётчик изменённых файлов и строк для порога объёма правок).
   При нарушении любого критерия (затронуты защищённые пути либо превышен порог объёма нетто-кода без тестов): фиксируется событие `route_violation`, задача автоматически переводится на маршрут `feature` в узел `design` (`node = 'design', route = 'feature', status = 'running'`) с полным сбросом последующих счётчиков и фиксацией причины в `payload` (`route-violation: fix/simple task exceeded scope thresholds or touched specs/migrations/APIs`).
8. **Замечания ревью:** замечания аудиторов вне рамок договора приёмки оформляются как неблокирующие предложения и не раздувают круги ревью.

## 32. Ревизия 34: порядок реализации и режимы графа задач

Сначала журнал и очередь в базе, затем репетиция пути с подставными агентами, и только затем живые прогоны.

### 32.1 Режимы работы графа задач (off, shadow, strict)

Управление графом регулируется настройкой режима `workGraph`:
- **`off` (по умолчанию):** полная совместимость с r33. Очередь `task_queue` не ведётся, команды `delegate`, `merge`, `release` работают в классическом ручном режиме координатора. Наблюдатель в проектах с режимом `off` полностью отключён и не производит никаких записей в базу данных (правило абсолютного молчания, §32.2).
- **`shadow` (пассивный режим аудита и зеркалирования, Б4):** таблицы `task_queue` и `task_transitions` ведутся, команды очереди `enqueue`, `dequeue`, `defer`, `reject`, `resume`, `approve`, `release-note`, `run-queue` функционируют. Прямые вызовы команд `delegate`, `merge`, `release` не блокируются и выполняются в штатном режиме.
  Scope зеркалирования:
  - Для задач, зарегистрированных в `task_queue`: каждое ручное действие координатора (`delegate`, `merge`, `release`) зеркалируется в `task_transitions` (с актором `shadow:coordinator` / `shadow:machine`), а конвейер графа параллельно вычисляет и протоколирует в `task_queue.payload.shadow_eval`:
    1) `would_allow: delegate` / `would_reject: invalid_node`: соответствует ли раздача координатора текущему узлу графа;
    2) `would_transition: { from_node, to_node, event }`: какой машинный переход выполнил бы граф при автоматическом продвижении;
    3) `would_reject: { reason }`: какие действия исполнителя или координатора граф забраковал бы (например, сдача без коммита, изменение договора приёмки, нарушение рамок маршрута `fix`, пропуск тестов `checks`, отсутствие ревью);
    4) `would_allow: release` / `would_block: { reason }`: допустил бы граф выкладку релиза или заблокировал бы её по гейтам готовности.
  - Для ручных вызовов `delegate`, `merge`, `release` по задачам, **НЕ зарегистрированным в `task_queue`** (строго для проектов, находящихся в режиме `shadow`): плагин не создаёт неявную запись в `task_queue` (очередь остаётся чистой), но логирует в аудит `task_transitions` служебную запись о внеочередном действии (с маркерами `'none'` в NOT NULL колонках схемы, §27.1): `actor: "shadow:coordinator"`, `from_node: "none"`, `to_node: "none"`, `from_status: "none"`, `to_status: "none"`, `reason: "task-not-enqueued"`, `payload: JSON({ event: "manual_command", command, would_reject: "graph-required" })`.
  Это даёт объективный сравнительный лог для проверки графа на живом потоке задач перед переключением проекта в `strict`.
- **`strict` (строгий режим графа задач):** закон «задачу ведёт код, а не агент». Любая задача проекта обязана управляться через граф:
  1) Прямые вызовы команд `bb orchestrator delegate <KEY>`, `bb orchestrator merge <KEY>` (включая `merge <delegationId>`, где проверяется задача раздачи) и `bb orchestrator release <KEY>` вне сервиса `run-queue` **СТРОГО БЛОКИРУЮТСЯ**:
     - если задача `<KEY>` отсутствует в `task_queue`: отказ `graph-required: задача <KEY> не зарегистрирована в очереди графа; поставь задачу через bb orchestrator enqueue <KEY>`;
     - если задача `<KEY>` зарегистрирована в `task_queue` со статусом `done`: прямой вызов запрещён, отказ `graph-managed: задача <KEY> завершена (done); для повторной доработки выполни bb orchestrator enqueue <KEY>`;
     - если задача `<KEY>` зарегистрирована в `task_queue` со статусом, отличным от `done`: отказ `graph-managed: задача <KEY> управляется графом (текущее состояние: node=<node>, status=<status>). Прямой вызов запрещён; продвижение выполняется конвейером run-queue`.
     (Исключение: локальные помощники координатора `orchestrator_helper` по §19.1 не требуют задачи в трекере и выполняются вне очереди).
  2) Постановка и повторная постановка в очередь (`enqueue <KEY> [--force-reset-branch]`):
     - Если задача с ключом `<KEY>` уже существует в `task_queue` в активном статусе (например, `running`, `queued`, `blocked`, `stalled`): повторный вызов `enqueue <KEY>` немедленно отклоняется с ошибкой `task-already-enqueued: задача <KEY> уже находится в очереди (текущее состояние: node=<node>, status=<status>); повторная постановка допустима только после завершения (status=done) либо отмены (status=cancelled)`. (Исключение: обновление договора приёмки через `enqueue <KEY> --acceptance <файл|текст>` владельцем для маршрутов `fix` и `simple` при нахождении в `waiting_approval` или `deferred` на узле `owner_gate` по §31.5; для маршрута `feature` изменение договора через `enqueue --acceptance` отклоняется с ошибкой `acceptance-contract-immutable: для маршрута feature договор формируется и изменяется исключительно архитектором на узле design через reject --target design`).
     - Синхронная проверка чистоты имени функциональной ветки (для новой задачи и для повторной постановки из `done`/`cancelled`):
       * Для маршрута `research` ветка не создаётся (`branch = NULL`), проверка git пропускается.
       * Для маршрутов с кодом и документацией:
         - при повторной постановке задачи из `done` или `cancelled`: плагин проверяет и сбрасывает СТРОГО сохранённое имя функциональной ветки `task_queue.branch` (если `branch IS NULL`, имя вычисляется по §27.1 и записывается в `branch`);
         - при начальной постановке новой задачи: имя `<branch>` вычисляется по правилам §27.1 (`bb/<KEY>-<slug>`).
       * Проверка наличия ветки: сервис проверяет наличие локальной ветки `refs/heads/<branch>` и удалённой ветки в origin (`git ls-remote --heads origin refs/heads/<branch>`).
         - Если ветка отсутствует и локально, и в origin (ветка ещё не существовала или была штатно удалена): проверка пропускается, имя `<branch>` фиксируется в `task_queue.branch`, а сама ветка создаётся заново при старте конвейера.
         - Если ветка существует локально или в origin: перед проверкой плагин выполняет `git fetch origin refs/heads/<branch>` (если ветка есть в origin). Выполняется синхронная проверка на вливание в целевую ветку `origin/<mergeBaseBranch>` ДЛЯ ОБЕИХ существующих вершин (локальной и origin):
           - Слияние считается подтверждённым, если для каждой существующей вершины (`HEAD` локальной ветки и `origin/<branch>`) выполняется `git merge-base --is-ancestor <sha> origin/<mergeBaseBranch>` ЛИБО при наличии влитого Pull Request по этой ветке (поиск PR в API провайдера по имени ветки `head: <branch>` или по сохранённому `task_queue.payload.pr_number`) со статусом `pullRequest.merged === true`: проверяемая вершина `<sha>` строго совпадает со слитой вершиной PR (`sha === pullRequest.headRefOid`) или является её предком (`git merge-base --is-ancestor <sha> pullRequest.headRefOid` истинно). Если на локальной ветке или в origin есть коммиты поверх слитого PR, слияние НЕ считается подтверждённым (защита от потери коммитов, добавленных после слияния PR). Закрытие PR без слияния или удаление ветки в origin признаком слияния НЕ ЯВЛЯЮТСЯ.
           - Если слияние подтверждено: плагин синхронно удаляет старую ветку при её наличии (локально `git branch -D <branch>`, в origin `git push origin --delete <branch>`, если удалённая ветка ещё существует).
           - Если слияние НЕ подтверждено у любой из существующих вершин:
             + если флаг `--force-reset-branch` НЕ указан: команда `enqueue` немедленно завершается с ошибкой (`exitCode ≠ 0`): `unmerged-branch-exists: прошлая ветка задачи <branch> не влита в целевую ветку; укажи флаг --force-reset-branch для принудительного архивирования и пересоздания`. Запись в SQLite НЕ ИЗМЕНЯЕТСЯ (для новой задачи запись не создаётся; для существующей — остаётся в статусе `done` или `cancelled`), задача в очередь НЕ ставится;
             + если флаг `--force-reset-branch` указан: плагин синхронно архивирует существующие вершины:
               1) если существует локальная ветка — архивирует её в тег `refs/tags/archive/<KEY>-force-reset-<ts>` и удаляет (`git branch -D <branch>`);
               2) если существует ветка в origin: если локальной ветки не было, либо origin опережает/разошёлся с локальной — архивирует вершину origin в тег `refs/tags/archive/<KEY>-remote-force-reset-<ts>`; затем удаляет ветку в origin (`git push origin --delete <branch>`).
     - Создание или обновление записи в SQLite при успешном `enqueue`:
       * для новой задачи: создаётся запись со статусом `queued`, узлом `start`, `branch = <branch>` (для `research` — `NULL`), `confirmation_mode` записывается строго вычисленный по правилам разрешения §29.3, аргументами CLI и нулевыми счётчиками; если передан флаг `--release-note "<текст>"`, значение записывается в `task_queue.release_note`; если передан флаг `--acceptance <файл|текст>`, текст договора сохраняется в `task_queue.payload.acceptance_text`;
       * для повторной постановки (`done` или `cancelled`): поля конфигурации (`route`, `level`, `priority`, `depends_on`), а также `confirmation_mode` (вычисленный по правилам разрешения §29.3) обновляются из переданных аргументов CLI; поля артефактов и состояния (`spec_sha`, `acceptance_sha`, `result_sha`, `interaction_id`, `node_alarm_at`, `deadline_at`, отметки `deferred_*`) сбрасываются в `NULL`; колонка `branch` сохраняет прежнее имя функциональной ветки задачи; поле `release_note` устанавливается из флага `--release-note` (или `NULL`, если не передан); в `payload` сохраняется `acceptance_text` из флага `--acceptance` (или `NULL`), остальные служебные поля `payload` сбрасываются; все 7 счётчиков попыток сбрасываются в 0; статус переводится в `queued`, узел в `start`, обновляются `entered_at`, `created_at`, `updated_at`.
     - Взятие задачи сервисом `run-queue` на узле `start`:
       * если функциональная ветка `<branch>` отсутствует локально: создаётся чистая ветка от `origin/<mergeBaseBranch>` (`git branch <branch> origin/<mergeBaseBranch>`);
       * если ветка `<branch>` уже существует локально: если `refs/heads/<branch>` равна `origin/<mergeBaseBranch>` или является её предком (ветка создана конвейером и ещё не модифицировалась): ветка переиспользуется;
       * если ветка уже существует и содержит коммиты, не являющиеся предками `origin/<mergeBaseBranch>`: конвейер переводит задачу в статус `stalled: branch-exists: ветка <branch> уже существует и содержит коммиты; проверь состояние ветки или выполни dequeue`.
     - Команды очереди в строгом режиме: управление задачами графа выполняется через набор команд `bb orchestrator`: `enqueue`, `dequeue`, `defer`, `reject`, `resume`, `approve`, `release-note`, `run-queue`.
  3) Выкладка задачи (шаг 1 [orchestrator-release](orchestrator-release.md)) допускается исключительно при условии, что задача зарегистрирована в `task_queue` и её состояние строго равно `node = 'release', status = 'running'`.
  4) Координатор освобождается от ручной диспетчеризации — задача продвигается детерминированным конвейером по машинным доказательствам.

### 32.2 Режим графа задач на уровне проекта (PLUG-361)

Режим проекта задаёт продвижение задач по графу. Выделение рабочих копий и веток для параллельных координаторов одного проекта описано в [orchestrator §13.5](orchestrator.md#135-рабочая-копия-координатора) и действует независимо от режима графа.

Установка строгого режима `strict` глобально на весь стенд блокирует работу сторонних проектов, чьи координаторы ведут задачи по классической схеме без очереди (например, задачи проекта `NET`, где прямая раздача получала бы `would_reject: graph-required`). Для безопасной поэтапной эксплуатации стенда режим работы графа настраивается гранулярно на уровне каждого проекта.

1. **Иерархия настроек и наследование (единственный источник режима проекта):**
   - **Глобальный режим плагина (`workGraph`):** базовое значение настроек плагина (`'off' | 'shadow' | 'strict'`, по умолчанию `'off'`). Служит общесистемным значением по умолчанию для любого проекта стенда, у которого отсутствует индивидуальная настройка.
   - **Проектные переопределения (`workGraphProjects`):** JSON-словарь сопоставления идентификаторов проектов BB с режимами (`{ [projectId: string]: 'off' | 'shadow' | 'strict' }`), настраиваемый в конфигурации плагина. Это **единственный источник режима проекта** (вариант с хранением режима в `.bb/policy.json` исключён, так как файл репозитория доступен агентам для коммита и позволил бы агенту самостоятельно переключать режим).
   - **Функция разрешения режима (`resolveWorkGraphMode(projectId?: string | null)`):**
     1) Если передан валидный `projectId`, проверяется наличие переопределения в `workGraphProjects[projectId]`. При наличии валидного значения (`'off'`, `'shadow'`, `'strict'`) возвращается оно.
     2) Если переопределение для проекта отсутствует — возвращается глобальное значение настройки `workGraph` плагина (по умолчанию `'off'`).
     3) Если `projectId` не передан или не может быть вычислен по контексту задачи: возвращается глобальное значение `workGraph` плагина (по умолчанию `'off'`).

2. **Порядок определения проекта задачи (Task Project Resolution):**
   Для определения `projectId` задачи проверка выполняется строго по порядку:
   1) **Очередь графа (`task_queue`):** колонка `project_id` (или поле в `payload.project_id`), если задача зарегистрирована в очереди;
   2) **Делегирование (`delegations`):** колонка `project_id` из таблицы `delegations` по активному или последнему завершённому делегированию задачи;
   3) **Трекер задач (`tracker`):** запрос метаданных задачи через API трекера задач BB (`bb tasks` / `tracker.getTask(key)`), возвращающий `task.projectId`.
   Если `projectId` не удалось определить ни по одному из источников 1–3:
   - применяется глобальный режим `workGraph` плагина (по умолчанию `'off'`);
   - в журнал плагина логируется предупреждение: `orchestrator: task <KEY> project undetermined; falling back to global workGraph mode (<mode>)`.

3. **Поведение наблюдателя (`shadow`) при `workGraph: 'off'` в проекте:**
   - **Правило абсолютного молчания наблюдателя:** Для любого проекта, эффективный режим которого равен `'off'`, наблюдатель **НЕ ПИШЕТ НИЧЕГО** (полная тишина).
   - В таблицы `task_transitions` и `task_queue` не добавляется никаких записей (включая служебные строки о внеочередных действиях `none` / `task-not-enqueued`), конвейер `shadow_eval` не вызывается. Накладные расходы на аудит для проектов вне графа строго равны нулю.
   - Зеркалирование действий координатора (`recordShadowAction`) выполняется **ТОЛЬКО** для задач тех проектов, чей режим явно разрешён в `'shadow'`.

4. **Изоляция проектов в `strict` (невлияние на другие проекты стенда):**
   - Нахождение одного проекта в режиме `strict` (например, `proj_at84bcu8q7`) **СТРОГО НЕ ВЛИЯЕТ** на операции координаторов и агентов других проектов стенда.
   - Функция контроля `assertGraphAllowsDirectAction` перед проверкой определяет `projectId` задачи по порядку п. 2 и запрашивает эффективный режим через `resolveWorkGraphMode(projectId)`.
   - Если проект задачи находится в `'off'`: прямой вызов `delegate`, `merge`, `release` выполняется штатно по классическому процессу r33 без проверки очереди и без отказа `graph-required`.
   - Если проект задачи находится в `'shadow'`: прямой вызов выполняется штатно и зеркалируется в `task_transitions`.
   - Блокирующий отказ `graph-required` (или `graph-managed`) генерируется **ИСКЛЮЧИТЕЛЬНО** для задач тех проектов, чей режим разрешён в `'strict'`.

5. **Обязательные тесты изоляции проектов:**
   1) **Тест молчания наблюдателя при `off`:** Прямая раздача (`delegate`), слияние (`merge`) или выкладка (`release`) по задаче проекта с `workGraph: 'off'` (даже если на том же стенде другой проект переведён в `shadow` или `strict`) оставляет таблицу `task_transitions` без изменений (0 новых строк, наблюдатель молчит).
   2) **Тест невлияния проекта в `strict` на другие проекты:** Стенд настроен с проектом `A` (`workGraph: 'strict'`) и проектом `B` (`workGraph: 'off'`). Прямой вызов `bb orchestrator delegate` по задаче проекта `B` без постановки в очередь завершается успешно, в то время как вызов по задаче проекта `A` немедленно отклоняется с ошибкой `graph-required`.
   3) **Тест задачи с неопределённым проектом:** Задача, чей проект не определён ни в очереди, ни в делегированиях, ни в трекере, разрешает режим из глобального `workGraph` плагина и записывает предупреждающую строку в журнал.

### 32.3 Защита критических настроек графа и режима одобрения (PLUG-360)

Настройки `workGraph`, `workGraphProjects` и `approvalMode` управляют конвейером исполнения и шлюзами человека. Плагин обеспечивает защиту критических настроек без необоснованных предположений об окружении:

1. **Разграничение прав доступа (owner-only):** Изменение настроек `workGraph`, `workGraphProjects` и `approvalMode` разрешено **исключительно владельцу** (человеку) из интерактивного интерфейса чата (селектор в композере, карточки `PluginInteractionRequest`) либо из терминала при отсутствии активного треда агента (переменная окружения `BB_THREAD_ID` отсутствует).
2. **Разрешение меню владельца в окне треда:** Выбор режима одобрения в меню плагина из окна треда разрешён (интерфейсный вызов из окна чата владельца). Режим графа меняется только в настройках плагина, значит любая его смена всегда даёт карточку владельцу. Команды смены режимов (`setProjectApprovalMode`, `setTaskConfirmationMode`) отсутствуют в наборе инструментов агентов, поэтому меню владельца работает беспрепятственно.
3. **Детекция смены настроек (своя смена vs смена вне меню):**
   - При `settings.onChange` платформа BB не передаёт `threadId` и не различает инициатора (терминал, агент, UI). Плагин не делает ложных утверждений об агенте в аудите;
   - «Своей» плагин считает только смену, пришедшую из его собственного интерактивного меню: перед записью настройки меню выставляет короткоживущую метку/токен намерения (TTL 5–10 с);
   - Любая другая смена критических настроек (`workGraph`, `workGraphProjects`, `approvalMode`) классифицируется как смена вне меню (`source: 'outside_menu'`).
4. **Машинная запись и карточка владельцу (без терминальных команд):**
   - **Машинная запись в журнал:** В журнал пишется **каждая** смена трёх настроек (`workGraph`, `workGraphProjects`, `approvalMode`), а не только смена вне меню. Плагин фиксирует структурированное машинное событие в таблице `events` с полями `{ setting, oldValue, newValue, timestamp, source }`, где `source`: `'menu'` или `'outside_menu'`, и логирует в `command_runs`. (Причина: вызов из меню и прямой вызов того же RPC из командной строки плагин не различает; запись в журнале должна остаться в обоих случаях).
   - **Карточка владельцу в интерфейсе:** Карточка владельцу `PluginInteractionRequest` создаётся **только** для смены вне меню (`source: 'outside_menu'`) с текстом: «⚠️ Настройка <setting> оркестратора изменена вне меню плагина (было: <oldValue>, стало: <newValue>)» и ровно двумя интерактивными кнопками:
     - `[ Оставить ]` — подтверждает новое значение настройки и закрывает карточку;
     - `[ Вернуть прежнее значение ]` — возвращает значение `oldValue` в настройки плагина и закрывает карточку.
   Никаких команд в терминале для владельца не требуется.
5. **Обязательные тесты защиты:**
   1) **Тест меню владельца:** Настоящий интерфейсный вызов из меню окна треда (`setProjectApprovalMode`, `setTaskConfirmationMode`) успешно изменяет режим проекта (`orchestrator.approvalMode`) и режим задачи (`confirmation_mode` в `task_queue`).
   2) **Тест смены вне меню:** Изменение настройки плагина без предварительной метки меню фиксирует событие в таблице `events` с `source: 'outside_menu'` и создаёт карточку с двумя кнопками.
   3) **Тест записи в журнал с `source` в обоих случаях:** Проверяется фиксация машинного события в `events` с `source: 'menu'` при смене из меню и `source: 'outside_menu'` при смене вне меню.
   4) **Тест кнопки возврата:** Нажатие кнопки `[ Вернуть прежнее значение ]` восстанавливает `oldValue` в настройках плагина.
   5) **Тест кнопки подтверждения:** Нажатие кнопки `[ Оставить ]` сохраняет новое значение настройки.
   6) **Тест CLI-защиты:** Попытка прямого вызова команды смены настроек из процесса с `BB_THREAD_ID` отклоняется с `permission-denied: owner-only`.

### 32.4 Порядок реализации (конспект agent-work-graphs)

Код реализуется срезами за флагом `workGraph`:

- **5а** — таблицы `task_queue`, `task_transitions`, функция перехода, команды CLI `enqueue`, `dequeue`, `defer`, `reject`, `resume`, `approve`, `release-note`, `run-queue` в пассивном режиме (`shadow`); тесты схемы и переходов (`PLUG-309`, статус done).
- **5б** — конвейер `run-queue`: автопереходы по матрице §28.1 и Б5 чистая функция `resolveTransition` с таблицей переходов как данные и тестами на каждую строку матрицы (`PLUG-312`, статус done).
- **Спека r34.1** — закрытие блокеров архитектора Б1–Б4, Б6, Б7 (только документы).
- **5в** — репетиция всего пути с подставными агентами через настоящие входы (как §19.7): сквозной прогон всех уровней (`spec`, `research`, `architect`, `review`, `complex`) с верификацией живой раздачи («вычислено, но не подключено»), честный путь `start → done`, ошибающийся исполнитель, попытка пропустить шаг, падение тестов на `checks`; каждый отказ проверяется за секунды, до живых прогонов (`PLUG-336`, статус done).
- **5г** — автопереходы конвейера `run-queue` и будильник узлов за флагом `strict`: автозапуск `checks` → `review` → `design_check` → `release`, автоэскалация по потолку 3 кругов в `blocked` (`PLUG-341`, статус done).
- **5д** — уровень `spec`, роль `architect`, узлы `design` и `design_check`, автофиксация договора приёмки в `docs/specs/acceptance/<KEY>.md` (`PLUG-343`, статус done).
- **5е** — режим одобрения `approvalMode` (`auto` / `manual`), тумблер ✅/👤 в окне чата, кнопки действий владельца в UI, карточка согласования через `PluginInteractionRequest` (`PLUG-344`, статус done).
- **Zero-Leak Sandbox** — изоляция данных и Snapshot Sandbox для публичных моделей (§33, `PLUG-345`, ADR-0035, статус done).
- **Архитектурная очистка провайдеров** — удаление `packet.ts` и `tools: false`, обобщенные алиасы политики (§20, `PLUG-316`, ADR-0036, статус done).
- **Неблокирующие улучшения архитектуры** — 7 замечаний архитектора к r34 (§34, `PLUG-315`, ADR-0037, статус in_progress).
- **Сверка установленной сборки плагина** (§24.3, 20.11, решение архитектора) — машинная проверка соответствия артефактов `dist/` коду коммита (`MATCH`, `STALE_BUILD`, `MISSING_BUILD`). Определение статуса «выложено»: задача считается выложенной ТОЛЬКО когда изменения влиты в `main`, собраны (`bb plugin build`), перезагружены (`bb plugin reload`) и проверены на соответствие на стенде.

Живые прогоны — только после репетиции: первая задача полного маршрута в режиме `manual` на одном проекте, затем остальные. Приёмка — повтор провалов аудита: каждая попытка отклониться от графа получает отказ кода.

