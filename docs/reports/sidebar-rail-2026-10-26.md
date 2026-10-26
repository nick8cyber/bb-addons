---
title: Проверка Sidebar Collapse и BB 0.47
status: verified
date: 2026-10-26
tags: [bb, sidebar, compatibility]
---

# Результат проверки

Рабочий BB остался 0.46.1. Установлен тот же sidebar-collapse из постоянного worktree bb-addons-sidebar-complete. Скрытие полосы включено, список чатов и пагинация сохранены. Авторизация, модели, ядро и чужие треды не менялись.

| Проверка | Результат |
| --- | --- |
| Unit/SDK | PASS — 101 тест; включая отсутствие Original и переход Automatic → native list → Sidebar Collapse |
| Typecheck, build, diff-check | PASS |
| Живой BB: desktop/mobile × light/dark | PASS — скрытие/возврат полосы, полная ширина, кнопки, Settings/Home, collapse |
| Штатный список и reload | PASS — скрытие работает независимо, ошибок frontend нет |
| Живая пагинация | PASS — 3→10→20→30→37→30→20→10→3, четыре варианта экрана/темы; настройки не изменились |

## Новая версия BB

[Официальный changelog](https://getbb.app/changelog) описывает Rail, Top list и возвращённый API навигации в 0.47. В npm проверен официальный bb-app 0.47.1 / SDK 0.6.79. В его frontend runtime сохранены используемые hooks, appOverlay, content scripts и footer action; встроенный список имеет прежний ключ thread-list/thread-list. Независимость выбора навигации и списка чатов сохранена.

Старая и новая разметка обрабатываются отдельно. Нативный Top list и неподдержанные структуры не меняются. Смена раскладки очищает метки. Отдельно исправлен прежний небезопасный вызов отсутствующего Original в BB 0.46+. Единственное замечание Advisor — обработка стандартного ключа __automatic__ — исправлено и покрыто отдельным тестом; повторный полный прогон прошёл.

> [!IMPORTANT]
> Проверка 0.47: официальные frontend-артефакты, SDK runtime и браузерный structural fixture новой grid (4 варианта экрана/темы). Полный E2E сервера 0.47.1 не проводился: владелец не поручал обновлять рабочий BB. Безусловная совместимость с любыми будущими версиями не заявляется.

## Локальные артефакты

В thread storage thr_bnzwnz9wfn, каталог nav-rail-browser-check: combined-verified.json, combined-after-reload.png, combined-hidden-*.png, pagination-verified.json и compat047-verified.json. Первые проверки выявили ошибку сценария мобильной навигации (drawer закрывается асинхронно), а native-list проверка выявила настоящий дефект Original. Итоговые повторные прогоны после исправлений прошли.

Откат и контракт: [совместная поставка](../specs/sidebar-rail-combined.md).
