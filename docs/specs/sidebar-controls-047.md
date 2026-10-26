---
title: Sidebar — видимые действия и визуальные исправления BB 0.47
status: approved
updated: 2026-10-26
tags: [bb, sidebar, controls]
---

# Контракт

Владелец поручил исправить исчезнувшие действия тредов и визуальные дефекты на двух скриншотах. Реализация самостоятельно в существующем sidebar-collapse, изолированно от main. База adde8ff. Новый плагин не создавать; BB/core, тема, агенты, модели и маршрутизация не меняются. После проверки установить и запушить исправление без повторного вопроса.

## Действия строки

В обычной строке всегда видны три кнопки, слева направо: «Скопировать ссылку», «Архивировать», «⋯». Не ждать hover; это одинаково для desktop, широкого touch и compact/PWA. Минимальные размеры: 24px desktop, 28px touch/compact. Текст треда обрезается многоточием, кнопки не сжимаются и не перекрываются.

Копирование использует существующий canonical URL: origin текущего клиента + project/personal thread path. Один helper используется кнопкой и существующим меню. Ошибка/отсутствие clipboard API показывается как ошибка, не успех и не необработанное исключение. Действия не открывают тред и не закрывают drawer; клавиатура, фокус и menu pointer handling сохраняются. При inline rename кнопки по-прежнему скрыты. Архивирование идёт через прежний host action/подтверждение; production-треды ради проверки не архивировать.

## Футер

В Top list штатный Settings уже находится в футере, поэтому не показывать рядом вторую кнопку настроек Collapse. Изменять только собственный footer item plugin:sidebar-collapse/sidebar-collapse-settings, если в том же футере есть штатный builtin:settings. При отсутствии штатного Settings, в том числе скрытом Rail, собственная кнопка остаётся доступной; дать ей отличимый значок ChevronsUp, сохранив label и действие открытия настроек. Не прятать другие пункты футера и не переписывать сохранённые preferences.

## Счётчик

В текущей теме neutral badge «99+» имеет белый текст на rgb(200,216,237), низкий контраст. Исправить только neutral count badge нативного Top list по точным DOM-маркерам. Цвета взять из пары sidebar/sidebar-foreground. Не менять значение, ARIA, warning/critical тона, другие бейджи и навигацию. Проверить контраст >=4.5:1 в светлом и тёмном режимах, desktop/mobile, и вмещение в строку.

## Реализация и проверки

Один cleanup-safe content script держит статический собственный style; lifecycle abort/dispose удаляет только его. CSS :has реагирует на наличие родного Settings без observer/polling. Неизвестные маркеры — fail-open. Сохранить rail controller и пагинацию 3→10→20→30→37 и обратно, текущие настройки и native fallback.

- Unit: порядок трёх действий, canonical clipboard URL для project/personal, reject/missing clipboard, отсутствие навигации, archive host call, menu opening, rename; CSS и cleanup script.
- npm ci; vitest последовательно; typecheck; bb plugin build; git diff --check от документной базы.
- Живой Chromium: desktop/mobile light/dark и wide touch; три кнопки видны без hover, не перекрываются, Copy пишет ссылку и не навигирует; menu открывается; Archive проверяется без мутации настоящих тредов. Один Settings в Top list, доступ к настройкам, fallback кнопка в скрытом Rail. Контраст count badge измерить численно.
- Проверить сессии только bb-addons перед выкладкой. Без других агентов/остановок. Advisor ровно один раз после проверок, устранить замечания, commit/push ветки и проверка remote SHA.

Откат: path:/home/ubuntu/work/bb/worktrees/bb-addons-sidebar-complete/plugins/bb-plugin-sidebar-collapse @adde8ff.
