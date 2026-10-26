---
title: ADR — навигация и список чатов поставляются вместе
status: accepted
date: 2026-10-26
---

# Сохранить один Sidebar Collapse

Визуальные исправления 0.47: кнопки строки постоянны, а собственный footer settings item не дублирует уже доступный штатный Settings. Нейтральный count badge Top list получает контрастную пару цветов sidebar. Это отдельный статический cleanup-safe content script, не часть включаемого rail controller; настройки, другие footer items и warning/critical badges не меняются. Контракт: [действия и визуал](../specs/sidebar-controls-047.md).

Пагинация и скрытие навигации не должны заменять друг друга при установке разных веток одного plugin id. Поставляем их в одном артефакте из базы bc3333a. Для BB 0.46 и 0.47 изолируем разные DOM-контракты и сохраняем fail-open. Нативный Top list 0.47 — выбор владельца после отдельного обновления BB; плагин не меняет этот выбор и не подменяет навигацию.

Приёмка и откат: [контракт](../specs/sidebar-rail-combined.md).
<!-- 2026-10-26: follow-up UI contract -->

## Компактные панели чата

По запросу владельца: архивировать тред только через меню; перенести changed-files summary в верхний thread header; показать native queued-message actions на мобильном. Контракт — [chat-chrome-047](../specs/chat-chrome-047.md). Остаётся тот же плагин Sidebar Collapse. Native React nodes не перемещаются: header proxy управляет исходным раскрытием, которое позиционируется под header. Контекст и cleanup ограничены pane; при неизвестных маркерах остаётся исходный интерфейс.
