---
title: Компактная карточка Advisor
status: accepted
updated: 2026-11-02
---

# Компактная карточка Advisor

## 1. Поведение

Карточка Advisor над composer по умолчанию свёрнута на desktop и mobile: видны severity, краткий однострочный preview и кнопка со стрелкой. Preview обрезается ellipsis; полная сводка доступна при раскрытии. Заголовок может сокращаться на узком экране. Кнопка имеет доступное имя, aria-expanded и aria-controls, работает мышью, Enter и Space. Зона нажатия не меньше 44×44 px. Сворачивание и раскрытие не вызывают RPC, не скрывают замечание из истории и не меняют доставку агенту.

Раскрытие хранится в состоянии компонента для пары threadId/advice.id. Повторная загрузка той же карточки не сбрасывает выбор. Другая карточка или другой тред начинают со свёрнутого состояния; состояние не перетекает между тредами.

## 2. Решения пользователя

В раскрытой карточке добавить Not an issue (штатный русификатор показывает «Не проблема»). Вызвать существующий resolveFinding с threadId, chainId показанного замечания, resolved=true, decision=not-an-issue, reason="". PendingAdvice получает additive chainId, вычисленный тем же chainKeyOf(row), что использует панель; не считать id повтора корнем цепочки. При success refetch; failure остаётся видимым с возможностью повтора. Не выдавать решение пользователя за проверенное исправление.

Существующие Dismiss, View review, Fix in new turn сохраняют семантику. Взаимоисключающие mutation buttons заблокированы на время запроса; двойное нажатие не должно отправлять второй запрос. Влияние только на выбранную цепочку и тред. Backend resolveFinding остаётся общей реализацией для панели и карточки; новый RPC не нужен.

## 3. Mobile и ошибки

На ширинах 360 и 390 px нет горизонтального overflow; длинные summary/path должны переноситься в раскрытом режиме. Действия переносятся на строки, touch targets не меньше 44 px. Collapse control остаётся доступным. Ошибка чтения или решения видна даже при свёрнутом состоянии, без ложного success. Не изменять маршрутизацию моделей, reviewer lifecycle, настройки языка, историю и другие плагины.

## 4. Проверка и выпуск

Проверить collapse/expand без mutations, refresh той же карточки, новые advice/thread, exact chainId (включая повтор), successful override и error/retry, blocking concurrent actions, старые действия. Добавить backend assertion для pendingAdvice chainId. Прогнать полный npm run verify в plugins/bb-plugin-advisor. Проверить реальный render desktop/360/390 с fixture без изменения живых findings. После независимого ОК свести изолированную ветку, сохранить backup прежних bundles и выполнить обратимый reload канонического plugin path. Проверить bundle hash и неизменность settings/данных. Push только после разрешённого процесса review. Остальные улучшения composer не входят в изменение.
## 5. Уточнения по проверке плана

A и B начинают параллельно, A проверяет frontend vitest без обхода типов. До сведения B единственная допустимая ошибка typecheck у A — отсутствие нового chainId в inferred pendingAdvice; cast/локальные зеркала типа запрещены. Полный typecheck и verify после сведения обоих изменений обязательны. Проверенный источник зависимостей: ~/.bb/plugins/environment-git-worktree/host-data/worktrees/<thread>-1/bb-addons/plugins/bb-plugin-advisor/node_modules; копировать cp -a, без symlink и установки. Координатор проверяет package-lock; dist собирает и коммитит только координатор, исполнители откатывают только свои изменения dist.

resolveFinding с resolved !== true — ошибка решения, даже при ok:true. Retry после ошибки решения перечитывает данные; повтор решения требует отдельного нажатия Not an issue. Ошибка не заменяет карточку без возможности свернуть/повторить. Hook useThreadAdvisor должен связывать data/error с threadId и отбрасывать устаревшие ответы после смены threadId/размонтирования. Mutation error/busy локальны для threadId/adviceId, поздний запрос старой карточки не меняет новую. Тест смены threadId — setComposerScope и deferred response.

aria-controls указывает на существующий элемент даже в свёрнутом состоянии (hidden). Для toggle использовать уже переводимые Show more / Show less; стрелка остаётся визуальной. Заголовок Review также уже переводится. Не добавлять неподдержанные английские UI-строки.

Browser проверяется изолированным headless Chromium через CDP: настоящий BB frontend со всеми host CSS tokens, Fetch interception только JS/CSS bundle Advisor и его RPC. Candidate bundles подменяются в тестовом браузере, pendingAdvice получает fixture, resolveFinding перехватывается/записывается и никогда не достигает сервера. Измерять card bounds, document scrollWidth, toggle/action target >=44px, collapsed/expanded на desktop/360/390 и success/error решения. Перехват всех RPC Advisor защищает живые findings. Мобильный результат обозначать как эмуляцию.

Перед сведением/выкладкой перечислить сессии проекта BB Plugins с include-hidden, согласовать окно с активными исполнителями этого проекта. Работу остальных проектов не трогать. Backup bundles и sqlite backup до reload; сравнивать неизменность исторических строк и привязок, допуская новые строки от других ревью, а не хешировать живую БД. Сверять schema и настройки отдельно. Существующие активные запросы Advisor должны завершиться до reload. Изменение канонического source только после независимого ОК.
