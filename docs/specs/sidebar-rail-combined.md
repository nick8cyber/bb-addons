---
title: Sidebar Collapse — совместная поставка скрытия навигации и пагинации
status: approved
updated: 2026-10-26
tags: [bb, sidebar, compatibility]
---

# Контракт совместной поставки

## Область

Завершить PLUG-64 самостоятельно по повторному поручению владельца 26 октября. База bc3333a (пагинация); взять только дополнение скрытия из 3a67f4a, сохранив N→10→20, «Ещё N», счётчик, «Меньше», сортировку, фокус и настройки. Новый плагин не создавать. Ядро BB, тема, модели, авторизация и чужие треды не меняются. Рабочий BB 0.46.1 не обновлять.

## Поведение

Boolean hideNavigationRail (default false) скрывает только узкую полосу в развёрнутом списке чатов. После успешной живой приёмки включить true. Реактивный appOverlay-мост и cleanup-safe contentScript работают независимо от useCollapsedList. Settings/Plugins/Skills, свёрнутый desktop и неподдержанная разметка остаются штатными. Footer action «Настройки Sidebar Collapse» даёт путь к настройкам и обратному переключателю.

Сохранить контракт PLUG-64: полная ширина списка и footer без пустой колонки; macOS padding не переписывать; toggle не перекрывает New thread и заголовок; мобильный drawer готовит CSS до начала открытия. Disable/abort/reload/false убирают только принадлежащие плагину изменения.

## BB 0.47

Официальный changelog https://getbb.app/changelog описывает возвращение Navigation API и штатные Rail/Top list. В npm опубликован 0.47.1; для проверки распакован официальный tarball, сервер не обновлялся. Публичный слот experimental_sidebarNavigation заменяет только навигацию, а experimental_threadList — только список чатов: это независимые поверхности. Штатный Top list убирает вертикальную колонку, но не всю навигацию; это не эквивалент hideNavigationRail.

Разметка 0.47 изменилась: nav[data-testid=sidebar-navigation-rail][data-sidebar-navigation-placement=rail] оборачивает app-nav-rail; nav-rail-sidebar-body и sidebar-footer-body находятся в общей grid. Поддержать её отдельной строго проверяемой веткой контроллера, снимающей колонку grid и расширяющей body/footer. Не использовать прежний footer-row селектор для 0.47. Нативные Top list и сторонняя навигация без проверенного app-nav-rail не затрагиваются. Смена Rail↔Top list очищает все прежние метки; observer следит также за data-sidebar-state и data-sidebar-navigation-placement.

## Проверки и поставка

### Уточнение по живой проверке Original

В BB 0.46.1 и SDK 0.6.49 Original больше не передаётся в thread-list slot (хотя зафиксированный SDK 0.4.87 обещает его в типах). Не рендерить отсутствующий компонент. Для useCollapsedList false/true серверный settings.onChange последовательно переключает публичную UI preference sidebar.threadListProvider между thread-list/thread-list и sidebar-collapse/collapsed, с optimistic revision и без изменения иных настроек. Если выбран сторонний провайдер списка, его выбор не перезаписывать. Обработчик защищён от dispose и не переключает список при загрузке плагина.

На ошибке данных без Original показывать контролируемый fallback с кнопкой перехода на штатный список через schema-validated RPC. Проверить отсутствие Original, смену false→true, сохранение hideNavigationRail, сохранение стороннего выбора, CAS error, dispose и отсутствие startup writes. Старый Original допустим только при фактическом наличии для совместимости с прежним хостом. Применение fallback не должно падать и не должно скрывать настройки.

- [ ] Unit/SDK regression: все тесты пагинации и старого rail; 0.47 grid, Top list, переходы, missing markers, очистка, mobile/desktop и macOS.
- [ ] npm ci, npm test, npm run typecheck, bb plugin build, git diff --check относительно документной базы.
- [ ] Реальный Chromium: 0.46.1 desktop/mobile light/dark; false→true→false; Settings/Home, collapse, native-list fallback, reload, отсутствие ошибок и перекрытий; пагинация остаётся работающей.
- [ ] Для 0.47 отдельно указывать уровень доказательств: реальные официальные frontend-артефакты/разметка и браузерный fixture не выдаются за end-to-end обновлённого сервера. Рабочий сервер не обновлять ради теста.
- [ ] Проверить сессии только bb-addons перед выкладкой. Установить тот же sidebar-collapse из постоянного worktree, проверить настройки и UI; advisor_review ровно один раз; исправить замечания; commit/push ветки без main merge.

Откат: path:/home/ubuntu/work/bb/worktrees/bb-addons-sidebar-pagination/plugins/bb-plugin-sidebar-collapse @bc3333a, с сохранением существующих настроек.

