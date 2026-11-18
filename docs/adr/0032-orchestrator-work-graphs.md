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

1. **Узел задачи — запись в базе, а не текст хендоффа.** Таблица `task_queue` (очередь: `task_key`, `project_id`, `coordinator_thread_id`, `route`, `level`, `node`, `status`, `priority`, `depends_on`, `confirmation_mode`, `interaction_id`, `spec_sha`, `acceptance_sha`, `release_note`, `spec_review_rounds`, `check_attempts`, `code_review_rounds`, `design_check_rounds`, `entered_at`, `deadline_at`, `node_alarm_at`, `deferred_by`, `deferred_reason`) и неизменяемый журнал `task_transitions` (`task_key`, `from_node`, `to_node`, `from_status`, `to_status`, `actor`, `reason`, `payload`, `created_at`). Единая модель: узел — рабочий этап (`node`), операционное состояние — статус (`status`). Отложить пункт очереди можно только явным решением владельца.
2. **Детерминированный граф задачи:**
   `start → design → spec → spec_review → [owner_gate] → code → checks → review → design_check → release → done`.
   Переход делает только код и только по доказательству: коммит, вердикт ревью, машинные тесты, решение владельца, итог выкладки, таймаут будильника. Маршруты:
   - `feature`: полный путь со всеми узлами;
   - `fix`: `start → code → checks → review → release → done` (без проектирования и спеки);
   - `docs`: `start → spec → spec_review → [owner_gate] → release → done` (без кода и архитектора);
   - `simple`: `start → code → checks → review → release → done`;
   - `research`: `start → research → done` (без кода и выкладки).
3. **Конвейер `run-queue` (фоновая служба плагина и CLI `bb orchestrator run-queue`):**
   - Фоновый процесс плагина, действующий от лица координатора задачи (`coordinator_thread_id`, роль `orchestrator`). CLI выполняет один такт (`--once`).
   - Автопереходы по событиям: сдача `design` → коммит договора плагином (`acceptance_sha`) → раздача `spec` с `--from <acceptance_sha>` → сдача `spec` (`spec_sha`) → автозапуск `spec_review` (по `reviewByLevel["spec"]`) → при OK в `auto` сразу раздача `code` с `--from <spec_sha>` (спека не теряется!), в `manual` — переход в `owner_gate` → сдача кода → машинный узел `checks` (запуск безопасных тестов и проверок договора из `acceptance_sha`) → при успехе автозапуск ревью по `reviewByLevel` → при `{"verdict":"OK","blockers":0}` → автозапуск `design_check` (для `feature`) → при OK → автозапуск `release` → `published` → автоочистка копий `taskCleanup` → взятие следующей задачи из `task_queue`. Для PR-режима: статус `pr_open` до события слияния `on: merged`.
   - Замечания ревью — возврат на доработку новым заходом; потолок — **3 круга**, дальше статус `blocked` и эскалация к архитектору или владельцу.
4. **Будильник на каждом рабочем узле, включая координатора.** У каждого активного рабочего узла (`design`, `spec`, `spec_review`, `code`, `checks`, `review`, `design_check`, `release`, `research`) — детерминированный срок (`node_policy`). Пассивные состояния ожидания (`owner_gate`, `waiting_release_note`, `pr_open`, `deferred`, `blocked`, `stalled`, `done`) будильник не взводят. Сброс будильника происходит **строго по доказательствам текущего узла этой задачи** (коммит, вердикт, переход); такты `run-queue` и чужие задачи будильник не сбрасывают. Координатор спит, пока задачи идут штатно, и просыпается только по блокировкам (`blocked`, `stalled`, `waiting_release_note`). В §5.6 задачи из `task_queue` при `workGraph ≠ "off"` исключены из автонапоминаний простоя.
5. **Режимы одобрения (`approvalMode`):**
   - `auto`: полная автономность по цепочке;
   - `manual` (режим «сам»): обязательный шлюз владельца (`owner_gate`) после `spec_review` перед переходом к `code`. Владелец подтверждает коммит спеки и договора приёмки карточкой в интерфейсе (`PluginInteractionRequest`) либо через CLI владельца.
   - Защита от обхода: инструменты одобрения исключены из агентских схем (`tools: []`). В CLI проверка контекста отвергает вызовы с агентским `BB_THREAD_ID`. Защита от необоснованного занижения маршрута: отклоняется `route-downgrade-refused` и требует подтверждения владельца через UI.
6. **Роль и уровень `architect` (§30):**
   - Роль `architect` (Opus 5.5 / Gemini 3.8 Pro): сильная модель проектирует на старте (узел `design`) и валидирует в конце (узел `design_check`).
   - Архитектор код не пишет и не коммитит (`tools: []`), сдаёт результаты текстом — исключён риск «второго координатора».
7. **Уровни `spec` и `research` в политике:**
   - `spec` — отдельный писатель спек (у владельца: Gemini 3.8 High, agy);
   - `research` — исследования (Gemini 3.8 / web-gemini).
   - При `workGraph: "off"` отсутствие уровней даёт предупреждение, не ломая действующую политику r33; при `workGraph ≠ "off"` — валидируется тестом связи (§27.3).
8. **Договор приёмки до кода (узел `design`) и машинные проверки (`checks`):**
   - Архитектор формирует проверяемые критерии с командами верификации в отчёте; процесс плагина коммитит их в `docs/specs/acceptance/<KEY>.md` в функциональной ветке задачи под автором из git-конфига репозитория (`acceptance_sha`).
   - `spec` раздаётся с `--from <acceptance_sha>`, `code` раздаётся с `--from <spec_sha>`. Изменение договора исполнителем кода строго запрещено и отклоняется проверкой diff.
   - Машинный узел `checks` перед ревью: считывает договор строго из блоба `acceptance_sha` и запускает команды из белого списка проекта (`checks.allowedRunners`) и одобренные владельцем команды договора, возвращая ошибки исполнителю без траты токенов аудитора. Произвольные unapproved команды отклоняются.
   - Закон трёх исходов: прошло, упало, не запускалось; «не запускалось» не считается проходом.
9. **Команды управления очередью (§6):**
   - `bb orchestrator enqueue <KEY> [--priority N] [--mode auto|manual] [--route feature|fix|docs|simple|research] [--level complex|medium|simple|spec|research|architect] [--acceptance <файл|текст>] [--release-note "<текст>"]`
   - `bb orchestrator release-note <KEY> "<заметка>"` (передача заметки для waiting_release_note)
   - `bb orchestrator defer <KEY> --reason "<причина>"` (только владелец)
   - `bb orchestrator reject <KEY> --reason "<причина>"` (возврат текущего узла на доработку)
   - `bb orchestrator resume <KEY>` (возобновление задачи из deferred/blocked/stalled)
   - `bb orchestrator approve <KEY>` (одобрение перехода owner_gate владельцем)
   - `bb orchestrator run-queue [--once] [--json]`
10. **Порядок реализации срезами (за флагом `workGraph`):**
    - Флаг проекта `workGraph`: `off` (по умолчанию), `shadow` (пассивный режим: журнал и БД пишутся, команды работают без блокировок), `strict` (строгий режим переходов).
    - Срезы 5а (таблицы, transitions, CLI run-queue в `shadow`), 5б (репетиция с подставными агентами), 5в (автопереходы и будильник за флагом), 5г (`approvalMode`, архитектор, договор приёмки).

## Последствия

- Поручения владельца не теряются после сжатия контекста: дорожная карта и очередь — записи базы, а не текст хендоффа.
- Спека не теряется: `code` раздаётся от коммита `spec_sha`, выкладка публикует и спеку, и код.
- Простой становится событием: будильник узла будит ответственного и эскалирует владельцу; пассивные состояния ожидания человека будильник не взводят; сторож §5.6 не спамит при штатной работе очереди.
- «Готово» — по договору приёмки, а не по слову агента; договор защищён от подмены исполнителем; машинный узел `checks` отсекает сломанный код до ревьюера.
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
