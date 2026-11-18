---
title: ADR-0032 — Граф работы задачи кодом: task_queue/task_transitions, run-queue, режимы одобрения, роль архитектора, договор приёмки
status: proposed
date: 2026-11-18
---

# ADR-0032: Граф работы задачи кодом (ревизия 34)

## Контекст

Аудит координатора за 16–18.11 (материалы аудита координатора в KB `projects/bb-orchestrator-work-graphs-plan.md`) показал: координатор, ведущий задачу «в голове», теряет поручения владельца (четыре пункта без спеки и задач), простаивает часами (6 часов 17.11, повторно 18.11), а спека растёт под уже написанный код (PLUG-293 — 17 отказов аудита, §26 вырос с 6,7 КБ до 18 КБ в ходе исполнения). Плагин был построен как набор инструментов, которые агент вызывает, когда вспомнит: порядок шагов держался на памяти модели, а не на коде.

Ошибка проектирования — та же, что описана в проекте жёсткого графа (KB `projects/bb-orchestrator-graph-architecture.md`): «задачу ведёт модель, а не код». Исправление — перевернуть управление: **задачу ведёт код, агент выполняет работу внутри узла и сдаёт результат**. Принципы взяты из открытой заметки agent-work-graphs (конспект — KB `projects/bb-orchestrator-work-graphs-plan.md`); семь уроков под конкретные провалы трёх дней — раздел 7 аудита координатора.

## Решения (ревизия 34, спека §27–§32)

1. **Узел задачи — запись в базе, а не текст хендоффа.** Таблица `task_queue` (очередь: `task_key`, `project_id`, `coordinator_thread_id`, `route`, `level`, `node`, `status`, `priority`, `depends_on`, `confirmation_mode`, `branch`, `interaction_id`, `spec_sha`, `acceptance_sha`, `result_sha`, `release_note`, `payload`, 7 изолированных счётчиков: `spec_attempts`, `spec_review_rounds`, `code_attempts`, `check_attempts`, `code_review_rounds`, `design_check_rounds`, `release_attempts`, `entered_at`, `deadline_at`, `node_alarm_at`, `deferred_by`, `deferred_reason`) и неизменяемый журнал `task_transitions` (`task_key`, `from_node`, `to_node`, `from_status`, `to_status`, `actor`, `reason`, `payload`, `created_at`). Единая модель: узел — рабочий этап (`node`), операционное состояние — статус (`status`, включая `cancelled`). Отложить или отменить пункт очереди можно только явным решением владельца.
2. **Детерминированный граф задачи:**
   `start → design → spec → spec_review → [owner_gate] → code → checks → review → design_check → release → done`.
   Переход делает только код и только по доказательству: коммит, вердикт ревью, машинные тесты, решение владельца, итог выкладки, таймаут будильника. Маршруты:
   - `feature`: полный путь со всеми узлами (в `manual` со шлюзом `owner_gate` перед кодом);
   - `fix`: в `manual` — `start → owner_gate → code → checks → review → release → done`; в `auto` (только человек) — `start → code → checks → review → release → done`;
   - `docs`: в `manual` — `start → spec → spec_review → owner_gate → release → done`; в `auto` — `start → spec → spec_review → release → done`;
   - `simple`: в `manual` — `start → owner_gate → code → checks → review → release → done`; в `auto` — `start → code → checks → review → release → done`;
   - `research`: `start → research → done` (без кода и выкладки).
3. **Конвейер `run-queue` (фоновая служба плагина и CLI `bb orchestrator run-queue`):**
   - Фоновый процесс плагина, действующий от лица координатора задачи (`coordinator_thread_id`, роль `orchestrator`). CLI выполняет один такт (`--once`).
   - Автопереходы по событиям: сдача `design` → коммит договора плагином (`acceptance_sha`) → раздача `spec` с `--from <acceptance_sha>` → сдача `spec` (`spec_sha`) → автозапуск `spec_review` (по `reviewByLevel["spec"]`) → при OK в `auto` сразу раздача `code` (с `--from <spec_sha>` для feature, с `--from <acceptance_sha>` для fix/simple; спека и договор не теряются!), в `manual` — переход в `owner_gate` → сдача кода → машинный узел `checks` (запуск безопасных тестов и проверок договора из `acceptance_sha` в копии задачи) → при успехе автозапуск ревью по `reviewByLevel` → при `{"verdict":"OK","blockers":0}` → автозапуск `design_check` (для `feature`) → при OK → автозапуск `release` → `published` → автоочистка копий `taskCleanup` → взятие следующей задачи из `task_queue`. Для PR-режима: статус `pr_open` до события слияния `on: merged`.
   - Замечания ревью, проверок и выкладки — возврат на доработку новым заходом; потолок — **3 круга** (инкремент при получении замечаний, при достижении порога 3 — переход в `blocked` со сводкой в `payload` и автоматической консультацией архитектора). Счётчик `check_attempts` накапливается и сбрасывается только при успешном переходе на `review` либо при `resume` владельцем. При возобновлении задачи владельцем (`resume <KEY> [--target <target>]`) сбрасываются счётчики всех узлов от целевого до узла блокировки включительно (для target design/spec сбрасываются все последующие счётчики, включая `design_check_rounds = 0`; для target code — счётчики кода, проверок, ревью, design_check и выкладки; для target release — `release_attempts = 0`). Цель `--target release` допустима исключительно при блокировке на узле `release`.
4. **Будильник на каждом рабочем узле, включая координатора.** У каждого активного рабочего узла (`design`, `spec`, `spec_review`, `code`, `checks`, `review`, `design_check`, `release`, `research`) — детерминированный срок (`node_policy`). Пассивные состояния ожидания (`owner_gate`, `waiting_release_note`, `pr_open`, `deferred`, `blocked`, `stalled`, `done`, `cancelled`) будильник не взводят. При живом исполнителе в ходе будильник задачу не останавливает до истечения предельного времени хода. Сброс будильника происходит **строго по доказательствам текущего узла этой задачи** (коммит, вердикт, переход); такты `run-queue` и чужие задачи будильник не сбрасывают. Координатор спит, пока задачи идут штатно, и просыпается только по блокировкам (`blocked`, `stalled`, `waiting_release_note`). В §5.6 задачи из `task_queue` при `workGraph ≠ "off"` исключены из автонапоминаний простоя.
5. **Режимы одобрения (`approvalMode`):**
   - `auto`: полная автономность по цепочке;
   - `manual` (режим «сам»): обязательный шлюз владельца (`owner_gate`) перед реализацией кода (на `feature`, `fix`, `simple`) или перед выкладкой (`docs`). Владелец подтверждает коммит спеки/договора через UI плагина либо CLI владельца.
   - Единое строгое правило «только владелец» (согласованно с §23 п.3): любой вызов команд `approve`, `defer`, `resume` (из `blocked`/`deferred`), `reject` на `owner_gate` и передача флага `--mode` в `enqueue` при наличии переменной окружения `BB_THREAD_ID` (независимо от роли) СТРОГО ОТКЛОНЯЕТСЯ с ошибкой `permission-denied: owner-only`. Доступ разрешён только человеку: CLI без `BB_THREAD_ID` или UI (честная граница по §23.3: tools: [] для всех агентских ролей, проверка BB_THREAD_ID, игнорирование ответов карточки, сквозной аудит в task_transitions).
   - Защита от необоснованного занижения маршрута: если агент ставит облегчённый маршрут (`docs`, `fix`, `simple`), задача принудительно переводится в режим `manual` и проходит обязательный шлюз владельца `owner_gate` перед кодом (`start → owner_gate → code`).
6. **Роль и уровень `architect` (§30):**
   - Роль `architect` (Opus 5.5 / Gemini 3.8 Pro): сильная модель проектирует на старте (узел `design`) и валидирует в конце (узел `design_check`).
   - Архитектор код не пишет и не коммитит (`tools: []`), сдаёт результаты текстом — исключён риск «второго координатора».
7. **Уровни `spec` и `research` в политике:**
   - `spec` — отдельный писатель спек (у владельца: Gemini 3.8 High, agy);
   - `research` — исследования (Gemini 3.8 / web-gemini).
   - При `workGraph: "off"` отсутствие уровней даёт предупреждение, не ломая действующую политику r33; при `workGraph ≠ "off"` — валидируется тестом связи (§27.3).
8. **Договор приёмки до кода (узел `design`) и машинные проверки (`checks`):**
   - Архитектор формирует проверяемые критерии с командами верификации в отчёте; процесс плагина коммитит их через git plumbing в `docs/specs/acceptance/<KEY>.md` в функциональной ветке задачи под автором из git-конфига репозитория (`acceptance_sha`). На `fix`/`simple` плагин коммитит договор при `start` (`acceptance_sha`), и код раздаётся с `--from <acceptance_sha>`.
   - На маршруте `docs` узел `spec` раздаётся от ветки задачи (договор не используется, `acceptance_sha = NULL`). На `feature` раздаётся с `--from <acceptance_sha>`, `code` — с `--from <spec_sha>`. Изменение договора писателем спеки или исполнителем кода строго запрещено и блокируется проверкой diff (без смены узла, с инкрементом счётчика попыток). Перед выкладкой функциональная ветка задачи `<branch>` (хранимая в `task_queue.branch`, по умолчанию `bb/<KEY>-<slug>`) атомарно продвигается fast-forward (`update-ref` с проверкой предка) до проверенной вершины (`result_sha` или `spec_sha`), а шаги 2 и 3 выполняются в выделенной служебной копии выкладки (`wt/release/<KEY>`) на detached HEAD публикуемого коммита (`git worktree add --detach`), переиспользуемой при повторных попытках и удаляемой после выкладки (`git worktree remove --force`). При возврате в узел (в `code` для маршрутов с кодом либо в `spec` для `docs`) в открытом PR (`pr.changes_requested`) или после `pr.closed` конвейер выполняет синхронизацию через временную служебную копию `wt/sync/<KEY>` на detached HEAD (fast-forward или автослияние служебным коммитом в `payload.pipeline_shas` с последующим переносом в `releases.pipeline_shas`; при конфликте — сохранение `payload.sync_old_sha` и `payload.sync_remote_sha`, переход в `stalled: diverged-remote`; разрешение координатором или владельцем коммитом в `wt/sync/<KEY>` с занесением коммита в `pipeline_shas` при `resume`), а новый заход раздаётся строго от актуальной вершины ветки задачи (`from: refs/heads/<branch>`). Отказ push на шаге 6 относится к отказам выкладки (инкремент `release_attempts`).
   - Машинный узел `checks` перед ревью: считывает договор строго из блоба `acceptance_sha` и запускает в рабочей копии задачи исполнителя `wt/<KEY>-<round>` (сокращённо `wt/<KEY>`) команды из настроенного списка безопасных раннеров (`checks.allowedRunners`: `npm test`, `npm run test`, `npm run test:*`, `npm run lint`, `pytest`, `cargo test`, `go test ./...`) и одобренные владельцем команды договора (`shell: false`, без утилит скачивания пакетов `npx`, `go run` и без шелл-метасимволов). Честная граница (§23.3): запуск в рабочей копии захода `wt/<KEY>-<round>`, очистка секретов окружения, таймаут 300 с с SIGKILL.
   - Закон трёх исходов: прошло, упало, не запускалось; «не запускалось» не считается проходом.
9. **Команды управления очередью (§6):**

   - `bb orchestrator release-note <KEY> "<заметка>"` (передача заметки для waiting_release_note)
   - `bb orchestrator defer <KEY> --reason "<причина>"` (только владелец)
   - `bb orchestrator dequeue <KEY> [--reason "<причина>"]` (снятие задачи с очереди владельцем, архивация ветки в теги refs/tags/archive/<KEY>-cancelled-<ts> и удаление локально и в origin при наличии ветки, статус cancelled)
   - `bb orchestrator enqueue <KEY> [--priority N] [--mode auto|manual] [--route ...] [--level ...] [--acceptance <файл|текст>] [--release-note <текст>] [--depends-on ...] [--force-reset-branch]` (постановка и повторный запуск задачи; флаг --acceptance и смена договора — только владелец; синхронная проверка невлитой ветки в enqueue: отказ unmerged-branch-exists без изменения записи, либо синхронная архивация в тег refs/tags/archive/<KEY>-force-reset-<ts> и удаление старой ветки при --force-reset-branch)
   - `bb orchestrator reject <KEY> [--target spec|design|code] --reason "<причина>"` (возврат текущего узла на доработку в рамках маршрута; при blocked/deferred запрещён)
   - `bb orchestrator resume <KEY> [--target spec|design|code|release] [--reopen]` (возобновление задачи из deferred/blocked/stalled; blocked/deferred — только владелец, с допустимыми целями строго по маршруту)
   - `bb orchestrator approve <KEY> [--comment <текст>]` (одобрение перехода owner_gate владельцем)
   - `bb orchestrator run-queue [--once] [--json]`
10. **Порядок реализации срезами (за флагом `workGraph`):**
    - Режимы `workGraph`: `off` (по умолчанию, совместимость r33), `shadow` (пассивный режим: аудит и БД), `strict` (строгий режим: блокировка прямых delegate/merge/release вне run-queue для любых задач вне очереди (graph-required) и внутри очереди (graph-managed), выкладка строго при node=release, status=running).
    - Срезы 5а (таблицы, transitions, CLI enqueue/dequeue/run-queue в `shadow`), 5б (репетиция с подставными агентами: сквозной прогон всех уровней для валидации связи), 5в (автопереходы и будильник за флагом `strict`), 5г (`approvalMode`, архитектор, договор приёмки).

## Последствия

- Поручения владельца не теряются после сжатия контекста: дорожная карта и очередь — записи базы, а не текст хендоффа.
- Спека не теряется: `code` раздаётся от коммита `spec_sha`, выкладка публикует и спеку, и код.
- Простой становится событием: будильник узла будит ответственного и эскалирует владельцу; пассивные состояния ожидания человека будильник не взводят; сторож §5.6 не спамит при штатной работе очереди.
- «Готово» — по договору приёмки, а не по слову агента; договор защищён от подмены; машинный узел `checks` отсекает сломанный код до ревьюера.
- Одобрение владельца стоит в правильной точке (перед кодом, а не перед выкладкой) и надёжно отслеживается.
- Конвейер выкладки защищён: запуск `release` от `run-queue` валидируется через `coordinator_thread_id`, пустая заметка при `requireNote: true` переводит задачу в `waiting_release_note` с возможностью передачи заметки через команду `release-note`.

## Связанные документы

- [ADR-0015: Оркестратор](0015-orchestrator.md) — базовые контракты раздачи и координации
- [ADR-0018: Выкладка релизов](0018-orchestrator-release.md) — конвейер release как узел графа
- [ADR-0024: Уборщик сред и веток](0024-orchestrator-branches-janitor.md) — автоочистка копий `taskCleanup` при публикации
- [ADR-0028: Интеграция базы знаний](0028-orchestrator-kb-integration.md) — гейт чистоты KB и автозапись релизов
- [ADR-0031: Защита от сброса UI](0031-orchestrator-ui-reset-protection.md) — гейт unmerged-ui
- [docs/specs/orchestrator.md](../specs/orchestrator.md) — §27–§32 (ревизия 34)
- [docs/specs/orchestrator-release.md](../specs/orchestrator-release.md) — шаг 1 (вызов release от run-queue)
- База знаний: `projects/bb-orchestrator-graph-architecture.md`, `projects/bb-orchestrator-work-graphs-plan.md`
