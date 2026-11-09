---
name: orchestrator-setup
description: Set up the orchestrator plugin together with the user — their providers and subscriptions, level routes and fallback chains, presets, the policy JSON, git rules for executors. Use when the plugin reports needs-configuration or the user asks to configure delegation.
---

# Настройка orchestrator

Готовых наборов моделей в плагине нет: что на каком уровне стоит, выбираешь ты вместе с пользователем. Не выдумывай модели — бери их только из вывода команд ниже.

## Порядок

1. **Спроси пользователя**, какие у него подписки и провайдеры и что жалко тратить: какие модели он готов пускать в фоне, а какие — только на главное и на проверку.
2. **Посмотри, что реально доступно**: `bb provider list`, затем `bb provider models <id>` для каждого подходящего провайдера. Модели и уровни рассуждений — только из этого вывода. Существующие пресеты — `bb tasks preset list`; подходящие можно использовать как есть.
3. **Предложи уровни и цепочки резерва** — покажи таблицу и дождись согласия:
   - `complex` — сложное: архитектура, поиск причин, многофайловые фичи, миграции, рефакторинг;
   - `medium` — среднее: обычные фичи и тесты по ясной спеке;
   - `simple` — простое: механические правки, документы, сбор данных;
   - `review` — проверка спек до раздачи и результата после; только чтение.
   У уровня может быть цепочка маршрутов: при сбое первого (квота, зависание) сторож берёт следующий. Для `complex` и `review` автоперевыпуск обычно выключают (`autoFallback: false`) — перевыпуск решает координатор.
4. **Создай недостающие пресеты**:
   `bb tasks preset create --name <preset> --provider <id> --model <id> --reasoning <level> --permission full --environment worktree [--instructions <текст>]`.
   В `--instructions` пресетов исполнителей — контракт исполнителя (работать в своей копии, отчёт с веткой и SHA, без push и PR); пресету `review` — контракт «только чтение» (ничего не править и не коммитить, вердикт с находками).
5. **Спроси про правила git** репозитория пользователя: базовая ветка и команда переноса, именование рабочих веток, подпись коммитов, запреты. Текст (≤ 1500 символов) уходит исполнителям первым разделом «Работа с git» при каждой раздаче и перевыпуске. Запиши: `bb plugin config orchestrator set gitInstructions '<текст>'`; пустая строка выключает раздел.
6. **Запиши политику** и проверь её:
   `bb plugin config orchestrator set policy '<json>'`, затем `bb orchestrator policy validate`.
   Формат: `version: 1`, `levels.<имя> = { description, chain: [<маршрут>...], autoFallback }`, `routes.<имя> = { preset, provider, quotaGroup?, quotaPatterns? }`, необязательные `limits`, `firstResponseSeconds` (30–600), `maxRunSeconds` (≥ 300). Пустая или невалидная политика — плагин в `needs-configuration`, `delegate` отклоняет вызовы. После правки настроек перезагрузи плагин, чтобы статус обновился.

Проверь итог: `bb orchestrator policy show` (политика и предупреждения) и `bb orchestrator instructions` (правило, которое увидит координатор).
