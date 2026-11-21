---
title: provider-agy — восстановление после сбоев и сжатие
status: approved
owner: coordinator
date: 2026-11-18
revision: 7 (ранняя гибель agy: окно ожидания ответа моста — отказ по stderr проходит парковку/ротацию §2.3, синтез -32000 только по истечении окна; provider-agy-acp §12.7, PLUG-373); 6 (ранняя гибель agy до session init — честная `-32000` с хвостом stderr, журнал получения запроса и per-spawn stderr-файл; provider-agy-acp §12.7, PLUG-373); 5 (квота текстом ответа `⚠ Individual quota reached…` — та же строка «Квота аккаунта», provider-agy-acp §2.3 п. 13; инцидент 19.11); 4 (решение владельца 19.11, PLUG-332: отказ eligibility с просьбой/ссылкой проверки — бессрочная парковка validation-required без cooldownUntilMs; отказ без ссылки — 2 ч; суточный eligibility-кулдаун снят, 24 ч остаётся только у auth-dead; ранее 3: синхронизация со спекой ACP рев. 14, PLUG-313; 2: §2 — выбор по тирам priority, PLUG-253)
tags: [bb, plugins, provider-agy, recovery, compaction]
---

# provider-agy — восстановление после сбоев и сжатие

Контракт поведения моста `provider-agy` (Antigravity CLI как провайдер bb) при сбоях Google, аккаунтов и самого agy, и при сжатии контекста. Подробности реализации — в [README плагина](../../plugins/bb-plugin-provider-agy/README.md); решения — в [ADR 0002](../adr/0002-provider-agy-failure-recovery.md), [ADR 0003](../adr/0003-provider-agy-compaction-fallback.md) и [ADR 0021](../adr/0021-provider-agy-acp-transport.md) (транспорт ACP с 10.11.2026).

## 1. Запрос владельца

Треды на agy не должны падать или вставать до ручного вмешательства, когда отказывает один аккаунт Google, когда Google временно отвечает 5xx, когда agy молчит, и когда не удаётся сжать длинный разговор. Источники: инциденты 20.10 (аккаунты «not eligible»), 01.11 (тред дежурного CI/CD: 500 после `/compact`, ложные «stalled», неделями несжимаемые разговоры), слова владельца «делай всё до конца», «давай б», страховка с чтением истории треда.

## 2. Поведение

**Пул аккаунтов.** Тред закрепляется за свободным наименее занятым аккаунтом с высшим приоритетом среди свободных (LRU внутри тира; `priority: 0` не выбирается — см. provider-agy-acp.md §2.2) из `bridge-data/accounts/` (только с файлом входа); разговор возобновляется на аккаунте-владельце.

| Сбой | Что делает мост |
|---|---|
| Квота аккаунта — ошибкой или текстом ответа `⚠ Individual quota reached… Resets in …` (текст пользователю не показывается, см. [provider-agy-acp.md](provider-agy-acp.md) §2.3 п. 13) | Аккаунт откладывается до сброса (без срока — 30 мин); ход сразу на свободный аккаунт, новый разговор + короткая сводка; нет свободного — ожидание окна (до 55 мин, до 2 раз) |
| Нужна проверка Google: `VALIDATION_REQUIRED` / «Verify your account to continue» / агентский маркер `⚠ Verification Required` | Бессрочная парковка `validation-required` (`parkedReason: "validation-required"`, `cooldownUntilMs` в далёком будущем), без автоповторов, вне предохранителя массовой парковки; ссылка проверки пишется в лог без токенов; ход переигрывается на свободном подходящем сиблинге или честный фейл; снятие только вручную оператором после проверки в браузере (см. [provider-agy-acp.md](provider-agy-acp.md) §2.3 п. 11) |
| Бан Google за Terms of Service: «This service has been disabled in this account for violation of Terms of Service» | Бессрочная парковка `tos-disabled` (`parkedReason: "tos-disabled"`, `cooldownUntilMs` в далёком будущем), без автоповторов, вне предохранителя массовой парковки; ход переигрывается на свободном подходящем сиблинге или честный фейл; снятие только вручную оператором ([provider-agy-acp.md](provider-agy-acp.md) §2.3 п. 7) |
| «not eligible», отказ с просьбой или ссылкой проверки аккаунта (`verify your account` — в т.ч. без «to continue» — или URL `accounts.google.com`) | Бессрочная парковка `validation-required` (`parkedReason: "validation-required"` + `ineligibleAtMs` + `lastError`, **без `cooldownUntilMs`**), без автоповторов; ссылка проверки пишется в лог без токенов; предохранитель проверяется до парковки; ход на свободный подходящий аккаунт или честный фейл; снятие только вручную после проверки в браузере (решение владельца 19.11, [provider-agy-acp.md](provider-agy-acp.md) §2.3 п. 11) |
| «not eligible», отказ без просьбы/ссылки проверки (регион «not currently available in your location» и общий отказ eligibility без ссылки) | Отложить на 2 ч (`AGY_LOCATION_COOLDOWN_MS`), лог с причиной `location`, ход на свободный подходящий аккаунт, учитывается в предохранителе |
| ≥3 разных аккаунта отложены за 10 мин | Предохранитель: больше не откладывать, падать с исходным текстом (подозрение на сеть) |
| Слёт Google-входа: `auth_required`, «Authentication required», «Silent sign-in failed», «not logged into Antigravity», «error getting token source» (ACP-транспорт) | Припарковать как ineligible (кулдаун 24 ч `AGY_INELIGIBLE_COOLDOWN_MS` — единственный оставшийся его носитель) + метка `parkedReason:"auth-dead"` в accounts-state.json; ход переигрывается на свободном аккаунте с `contextLost`; свободных нет — честный фейл «every pool account lost its Google sign-in; re-authenticate one and retry». Не квота, не toolError |
| Отказ по модели в полёте: `Unknown model ID` / «not available for the current authentication method» | Без кулдауна всего аккаунта; семейство модели записывается в `unsupported` аккаунта в `accounts-models.json`; не больше одного переезда на аккаунт с моделью в свежем каталоге; если подходящих нет или повторный отказ — честная ошибка ([provider-agy-acp.md](provider-agy-acp.md) §2.3 пп. 4, 10) |
| Все аккаунты пула припаркованы (любой `parkedReason`) | Честная ошибка без ухода в direct-режим на дефолтный HOME (даже для запросов без модели `acp-default`); на `thread/resume` — честная ошибка без запуска `agy` ([provider-agy-acp.md](provider-agy-acp.md) §2.3 п. 7) |
| Google `API error (attempt N): … (code 500/502/503/504)` | `errorInfo {internal, 5xx}` → встроенный bb provider-retry повторяет ход (~1 мин, удвоение, до 4) |
| Ошибка шага инструмента, auth/billing вместе с 5xx | Метки автоповтора нет |
| Тишина ≥15 мин во время хода, тул не открыт | Убить agy; если в полёте один принятый ход без очереди — `errorInfo {stream-disconnected}` → bb повторяет |
| Тишина ≥2 ч с открытым тулом | Убить agy, без автоповтора (команды не повторяются) |
| `AGY_PATH` указан, но не исполняемый | Явная ошибка, без отката на системный agy |
| agy умер до готовности сессии (exit/stderr без session — квота, лицензия, ранний выход) | Окно 4 с на ответ моста висящему `thread/start|resume`: ответ моста несёт stderr и идёт обычной классификацией отказов §2.3 (парковка/ротация); окно истекло — честная `-32000 «agy exited before the session was ready»` с кодом выхода и хвостом stderr, тоже через классификацию. stderr ребёнка — `acp-shim/stderr-<threadId>-<nonce>.log` (штатный shutdown удаляет свой, sweep старше 48 ч), шим-down — строка журнала; запрос журналируется при получении ([provider-agy-acp.md](provider-agy-acp.md) §12.7, ревизия 21) |

Правила парковки по `parkedReason` действуют на ACP-транспорте; для stream-json — см. [provider-agy-acp.md](provider-agy-acp.md) §10 (аккаунт с любым `parkedReason` в stream-json не запускается).

Таймер тишины считается с момента, когда ход отдан agy, а не с его прошлого вывода: agy между ходами живёт до 30 мин (`AGY_IDLE_KILL_MS`).

**Сжатие.** `/compact` от bb уходит в agy как есть; agy сжимает сам той же моделью. Упавший `/compact` и шаги его замены не помечаются для provider-retry (его повтор — «Please continue.», обычный ход).

**Сжатие вручную** — когда `/compact` сорвался по вине Google (5xx/overloaded, зависание, выход без результата):

1. agy на том же разговоре пишет собственный пересказ (`[compaction-fallback]`, без инструментов).
2. Новый разговор открывается с этим пересказом (`[compaction-handoff]`, ответ «OK»); очередь сообщений идёт туда.
3. Нет пересказа (упал, пустой, квота перенесла на другой аккаунт) — памятка моста (последний текст, `git diff --stat`) и ход восстановления только на чтение: `timeout 60 bb thread messages <тред> --limit 30` (не больше 100, без `--all`), затем файлы инструкций; история — справка, не список дел.
4. Новый разговор не открылся за 2 попытки — тред возвращается на прежний разговор у аккаунта-владельца.
5. Отказ из-за оплаты/входа — без замены; `AGY_COMPACT_FALLBACK=0` выключает замену.

## 3. Устройство и ограничения

Все повторы моста идут через один таймер сессии (`autoRetryTimer`): выход умирающего agy игнорируется, очередь ходов сохраняет порядок, остановка треда таймер отменяет. Учёт аккаунтов — `bridge-data/accounts-state.json` + `accounts-overlay.json` (метки: cooldown, время отказа) и `conversations-state.json` (владелец разговора), переживает перезапуск моста. Повторы временных сбоев — не в мосте, а в bb provider-retry по `errorInfo`. Переходы на новый разговор объявляются `session/replaced` (`contextLost`) и `thread/identity`.

Ограничения: точную причину отказа Google в сжатии не сообщает (вероятно, размер разговора); при откате на разговор аккаунта, который сам ещё на квоте, первое сообщение уходит обычной ротацией со сводкой; живые треды получают новый код только после пересоздания своей сессии.

## 4. Проверка

- [x] 8 наборов тестов на поддельном agy: 246/246; typecheck чистый.
- [x] Для каждого исправления — проверка, падающая на коде до него.
- [x] Ревью Opus 5.5 xhigh по каждой задаче (PLUG-63, 76, 77, 78, 79), замечания закрыты.
- [x] `bb plugin reload provider-agy`; новые строки кода присутствуют в живом артефакте.
- [ ] Живое срабатывание сжатия вручную на реальном отказе Google (ждём ночного `/compact`).

## 5. Решения

[ADR 0002](../adr/0002-provider-agy-failure-recovery.md) — кто отвечает за какой сбой; [ADR 0003](../adr/0003-provider-agy-compaction-fallback.md) — сжатие вручную.
