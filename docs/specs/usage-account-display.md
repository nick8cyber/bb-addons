---
title: Usage Pro — идентичность аккаунтов и локальные ошибки квот
status: approved
owner: coordinator
date: 2026-11-16
revision: 2.3 (§7 — карточки acp-argon по accounts-usage.json от provider-argon; 2.2 — §6.2 — дедуп модельных окон по мгновению сброса; §6.5 — порядок окон блоками семейств; 2.1 — §6.3 — отключённые бакеты как у пула; 2 — §6 — карточка acp-antigravity, исключение из запрета фильтра по email)
tags: [usage-pro, codex, accounts]
---

# Usage Pro — идентичность аккаунтов и локальные ошибки квот

## 1. Наблюдения, разрешение и сохранение

Владелец сказал «да делай» после аудита дублирования Codex и постоянной плашки refresh error. Разрешено исправить отображение и установить проверенный результат. Аккаунты, токены, авторизации, модели, маршруты, Account Pooler enabled/routing и очередь повторов не изменять.

Native Codex и Pi сейчас используют одну quota identity openai:chatgpt:<team-id>… (Team). Сборщик после общего dedup вручную добавляет Pi как Team каждому host и принудительно называет native Plus. Отключённый Pool account остаётся отдельной identity и возвращает usage.status=error. Сборщик бросает исключение на валидном account error и хранит failures, затем делает ошибочным весь host; frontend показывает это на любой вкладке.

Основа — merge 7ac05f5: текущий main ee3e3b0 + четыре уже работающих commit активной ветки fix/codex-retry-scheduled-queue cccb12c. Так сохраняются упакованный backend и существующий credit-retry. Не редактировать активный установленный worktree; работать только в отдельных ветках/worktree. credit-retry.ts и его поведение остаются неизменными.

## 2. Каноническая идентичность и тариф

Дедупликация — по (machineId, providerId, accountKey), где accountKey выдан провайдером в пространстве issuer/account scope. Native source уже передаёт accountKey. Pi получает ключ openai:chatgpt:<accountId> из реального chatgpt-account-id, использованного текущим запросом; не брать email или выдуманное имя. Для неизвестного ID ключ null: такие ресурсы НЕ объединять даже при одинаковом email/процентах/тарифе.

Pi проходит через тот же выбор кандидатов, а не добавляется после него. Одна известная identity в одном host даёт одну карточку и один набор окон: проценты НЕ суммировать, окна разных измерений НЕ склеивать. Выбирать успешное измерение перед ошибкой; среди успешных самое свежее observedAt; при равенстве предпочесть native, затем Pi, затем прочее, стабильно сохраняя исходный порядок. Разные accountKey остаются разными карточками. Для других providerId сохранить прежнее предпочтение shared-source, без изменения Google/Claude логики.

Полный порядок Codex: ok > expired > unauthenticated > error > not_installed > отсутствие измерения. Внутри статуса observedAt=null старше любого известного времени; разницу известных времён до 5000 ms считать равенством, затем native > Pi > other. Победитель занимает исходную позицию первой карточки identity; при полном равенстве сохраняется первый кандидат. Pi использует те же подписи окон, что native (Five-hour limit / Weekly limit), чтобы смена источника не меняла названия квот. actualPlanLabel: free/Free, go/Go, plus/Plus, pro/Pro, max/Max, team/Team, business/Business, enterprise/Enterprise, education|edu/Education; неизвестный непустой id — первая буква заглавная, остальное без выдумывания тарифов; пустой/нестроковый — надёжный fallback либо null.

Pi использует auth-файл сервера. Привязывать его только к серверному host ID из публичного sdk.system.config().primaryHostId (в текущем BB это readPrimaryHostIdFromDataDir), никогда ко всем hosts и не по позиции массива. При неизвестном origin не приписывать Pi удалённому host: допустима отдельная source-группа либо временное отсутствие host-карточки до разрешения origin, без выдуманных измерений.

Тариф native — из актуального normalized usage.planLabel/plan. Тариф Pi — из реального usage API plan_type/plan metadata; JWT plan hint допустим только при соответствии account scope тому же request accountId. При отсутствии надёжных сведений не выдумывать Team/Plus, использовать нейтральную подпись Pi/Codex либо null. Название маршрута можно добавить отдельно, оно не является тарифом.

При смене известной identity в inventory инвалидировать измерение старого accountKey до dedup/показа, независимо от TTL. Pi cache не должен выдаваться за другой аккаунт после ротации auth scope. Секреты остаются только в серверном collector, не входят в RPC, логи, fixtures и отчёты.

Особенность native: не-ok measurement и inventory могут терять accountKey при HTTP error. Для того же (pluginId, resourceId) допустимо наследовать последний известный accountKey только для не-ok/transport error при отсутствии другого non-null ключа. Другой non-null ключ немедленно сбрасывает прежний cache/identity; успешное измерение с null остаётся неизвестным и не объединяется. Удаление ресурса удаляет его identity history. Обязательно проверить error без ключа рядом со здоровым Pi, ротацию известного ключа и первый error без истории. In-flight результат прежней известной identity не должен перезаписывать новую после ротации.

Pi: нет auth entry — нет дополнительного ресурса; entry без пригодного accountId — unknown unauthenticated card, без quota HTTP request и без undefined account header. HTTP 401/403 — expired card с известной identity, прежние квоты не выдаются за успешные. HTTP 429/5xx, malformed response и timeout — local error либо last-known с warning той же identity. Recovery очищает warning. План JWT разрешён только для того же request accountId. Смена auth identity во время запроса не публикует старый результат под новой identity.

## 3. Ошибки и предупреждения

Валидный provider measurement со status=error — данные отдельного ресурса. Сохранять его в measurements и показывать existing account error UI, включая понятный источник в сообщении/подписи. Не бросать на нём transport exception и не поднимать machine.error. Ошибка включённого аккаунта остаётся локальной и не вызывает общей плашки на здоровых вкладках.

Уточнение владельца 2026-11-02: отключённые аккаунты Account Pooler не относятся к отображаемым квотам. Для source pluginId=account-pool читать публичный RPC account.list (input=null, только id/enabled); исключать из inventory и сбора usage только resource.id с явным enabled=false. Аккаунты и их credentials/settings/routing не менять. Включённые и неизвестные IDs не скрывать, даже при status=error; при недоступных/невалидных metadata сохранить обычный inventory. После включения аккаунт возвращается при следующем чтении, без перезагрузки. Не фильтровать по email, тексту ошибки, тарифу или accountKey. Старый cache исключённого ресурса очищается штатной inventory-reconciliation. Проверить disabled+active error, повторное enable/disable без reload, metadata failure и совпадающий id другого source.

Transport/getResource exception также локализовать на соответствующем ресурсе. Если есть старое успешное измерение того же accountKey, сохранить его как last-known и явно показать локальное предупреждение об устаревании/неудачном обновлении; если измерения нет — account error card. Нельзя выдавать stale за свежие, терять действительную ошибку, помечать запрос успешным без данных или удалять неисправные подключения. После успешного refresh локальная ошибка очищается. Проблема одного ресурса не переносится на другую карточку/вкладку/host.

Точный RPC/UI контракт: provider.warning?: string|null — локальный текст предупреждения карточки, optional для обратной совместимости. При stale windows текст явно сообщает, что обновление не удалось и показаны последние данные. Обе strict схемы (handwritten usage-schema в backend и frontend app.bundle.js) принимают поле; frontend отображает warning рядом с соответствующей карточкой, отдельно от тарифа и окон. Не складывать warning в planLabel. B вправе минимально править handwritten schema section и app.bundle.js (не встроенную реализацию Zod). Новый успешный refresh возвращает null/отсутствие warning.

Настоящие ошибки inventory/listing, сетевой сбой общего frontend RPC, отключённый host остаются видимыми; не убирать все предупреждения безусловно. Если источник с известными ресурсами не перечислился, предупреждение относится к нему; если состав неизвестен, допустима общая inventory warning с названием источника. Рабочие карточки должны оставаться доступны.

На основном live кейсе получить machine.error=null при существующем Pool account usage.status=error и здоровых native/Pi. Не менять Account Pooler ради достижения этого условия.

## 4. Границы файлов и интерфейс

Исполнитель A (Gemini) владеет только plugins/bb-plugin-usage-pro/usage-policy.ts и usage-policy.test.ts. Модуль чистый, без BB SDK, auth IO и сети.

~~~ts
export type UsageIdentity = {
  machineId: string;
  providerId: string;
  accountKey: string | null;
  scopeKind: "host" | "shared";
  usageStatus: string | null;
  observedAt: number | null;
  route: "native" | "pi" | "other";
};
export function codexAccountKey(accountId: unknown): string | null;
export function actualPlanLabel(planType: unknown, fallback?: unknown): string | null;
export function selectAccountResources<T>(
  resources: readonly T[],
  identify: (resource: T) => UsageIdentity,
): T[];
~~~

До раздачи координатор коммитит signature-compatible throwing stub, B не меняет этот файл. A заменяет тела. B при разработке может использовать vi.mock существующего модуля, но финальные integration tests обязаны работать на настоящем A.

Исполнитель B (OpenCode) владеет collector wiring и error policy: dist/provider-usage-base.js как сохранённым backend baseline, его .d.ts, server.ts при необходимости, tsconfig/package config для новых модулей и usage-integration.test.ts. Допустим отдельный небольшой TypeScript adapter для локальных warning/metadata и соответствующие tests, если он улучшает поддерживаемость. Не переписывать встроенный SDK/Zod внутри baseline bundle. Внести минимальные scoped changes в его handwritten collector section; frontend app.bundle.js менять только если existing error card не позволяет показать локальное stale warning. Не редактировать credit-retry.ts, OAuth/маршруты, prefs других плагинов. .bb/plugins.json, README, спеки/ADR и финальные build artifacts — координатор.

Для fake-host integration предусмотреть test-only collector dependency injection userHome (tmp fixture) и fetch/mock collectors. Тесты никогда не читают реальные auth-файлы, не вызывают pi/agy login/refresh и не выполняют внешние quota requests. В рабочем режиме существующий credential flow сохраняется. Не печатать токены ни в каком виде.

DI передаётся в factory ДО запуска любого prewarm: userHome, fetch, exec/spawn runner, agyPath, now, prewarm=false. Тестовые runner/fetch по умолчанию fail-fast; глобальный fetch также throw. Не рассчитывать на vi.mock(node:child_process/fs), потому что baseline использует createRequire. Тест истёкшего fixture token обязан использовать fake runner, не реальную pi auth. tsconfig включает новые .ts/tests. B может временно mock A, но координатор после сведения удаляет mock и запускает real-module tests; финальный B regression commit не должен зависеть от mock A. Исполнители не коммитят generated dist/server.js, dist/app.js/css/meta/maps после своей проверки build — финальная сборка координатора. AGY host-копии явно вне этой задачи; live условие про вторую машину относится только к Codex/Pi.

Задачи A/B запускаются task-specific presets usage-display-gemini и usage-display-deepseek с baseBranch=bb/usage-account-display-20261101, где c251dce — обязательный предок. Первый шаг исполнителя: git merge-base --is-ancestor c251dce HEAD и проверить наличие stub/backend/retry. Если нет — остановиться с ошибкой базы; не реализовывать от main. Зависимости копировать из <worktrees>/usage-account-display/plugins/bb-plugin-usage-pro/node_modules, не symlink production.

## 5. Приёмка и доставка

| Сценарий | Результат |
|---|---|
| Native/Pi same accountKey | Одна карточка, реальные окна/тариф, обе авторизации не изменены |
| Разные/неизвестные IDs, одинаковые email/проценты | Раздельные карточки |
| Разные hosts и server origin | Pi только на своём host; разные hosts не смешиваются |
| Свежий healthy vs stale/error duplicate | Один актуальный набор окон, без суммирования |
| Identity rotation и cache | Старые квоты не приписываются новому account |
| Pool disabled / enabled error + healthy others | Disabled скрыт; enabled error локален, нет общего banner |
| Source transport error + stale data | Локальное честное предупреждение, recovery очищает его |
| Inventory/RPC/offline failure | Реальная ошибка остаётся видимой |
| Credit retry | Прежние tests/поведение и уже созданная очередь сохранены |

Порядок: документный commit → один pre-review opus55-xhigh-review до исполнения → параллельно A+B в отдельных ветках/worktree → проверка координатором реальных modules/integration → один post-review и один advisor_review после implementation/checks → согласование активных агентов только bb-addons → main/push и install path→path с тем же id usage-pro → live checks.

При недоступности исполнителей использовать заданную цепочку, 404/removed не повторять, при 10 min отсутствия рабочих событий сохранять WIP и переключать маршрут. Не расходовать часы на молчание. Есть явное разрешение владельца mem_z5l-vlwc8ru брать Codex/Opus для работы при недоступности базовых исполнителей; перед каждым Claude/Codex запуском проверять usage.

До доставки сохранить source/settings/KV/очереди и старые два dirty generated files main в private backup. Проверить их хэши против ранее снятых fingerprints; если изменились кем-то за время работы — не затирать новые правки. Заменять только затронутые сгенерированные файлы после сохранения исходных данных, не трогать другие dirty paths. Path→path install сохраняет настройки/данные, без uninstall. Откат — прежний path source; не восстанавливать старую глобальную БД поверх новых данных. Не менять provider-retry, active-account selections или Account Pool routing.

Точная цель: <bb-addons>/plugins/bb-plugin-usage-pro; добавить usage-pro в .bb/plugins.json, затем bb plugin install path:<bb-addons> --plugin usage-pro --yes --json. Откат: bb plugin install path:<worktrees>/bb-addons-codex-retry-queue/plugins/bb-plugin-usage-pro --yes --json (старый источник не редактируется). Private backup: <thread-storage>/usage-display-backup; dirty-main-hashes.json содержит сохранённые отпечатки двух main artifacts, также сверять с advisor-language-backup/preexisting-dirty-hashes.json.

Live: у основного хоста один healthy Codex account (Team) с одним набором окон; legacy disabled account отсутствует в виджете, сохранён в Account Pooler и не меняет machine.error. У второй машины нет скопированной Pi source карточки основного хоста. Настоящие transport ошибки включённых аккаунтов не маскировать. Сравнить quota identity/window counts с исходными sources и убедиться, что auth/settings/routes/очередь не менялись. Если подключить другой account, его карточка должна сохраняться (fake tests, без смены живого аккаунта).

## 6. Нативный профиль Antigravity ACP — карточка `acp-antigravity` (ревизия 2, 16.11)

Код — коммиты владельца в usage-pro (публикация PLUG-270); раздел описывает поведение, решение — владельца.

1. **Источник.** Отдельный таб `acp-antigravity` для нативного ACP-профиля Antigravity: OAuth-токен профиля из каталога профиля ACP Antigravity (`~/.gemini/antigravity-acp/`), refresh grant, `loadCodeAssist`, `retrieveUserQuotaSummary`, `fetchAvailableModels`. Только чтение: креденшелы не пишутся, агенты не запускаются. Кэш, дедупликация запросов, stale-предупреждение и инвалидация при смене профиля — как у остальных источников (§3).
2. **Окна.** Отдельно для моделей Gemini и для 3P-моделей (Claude/GPT). Модельная квота читается только с бэкенда своего тира (prod-точка у consumer-тарифов отдаёт номинальную полную долю и расход не отражает). Если сгруппированная сводка не отдаёт семейство целиком, окно семейства — минимальная доля остатка среди его моделей из `fetchAvailableModels`. Суффикс окна — по времени до сброса: ≤ 10 ч — `5h`, ≤ 40 ч — `Daily`, иначе `Weekly`. При равной доле предпочитается измерение с известным временем сброса. Производное модельное окно отбрасывается, когда в сводке уже есть окно того же семейства с тем же мгновением сброса (допуск 120 с) — модельные записи без `remainingFraction` повторяют недельный сброс и по дистанции ложно метились `Daily`, дублируя настоящее `Weekly`.
3. **Отключённые бакеты** (замороженные счётчики, пока семейство ограничено более длинным окном) передаются на карточку как есть — так же, как на карточке пула agy (ревизия 2.1, коммит владельца, PLUG-271; раньше скрывались).
4. **Исключение из запрета фильтра по email (§3).** Аккаунт пула agy с `priority = 0` (выведен из ротации), чей `id_token_email` совпадает с email нативного ACP-профиля, после того как нативная карточка собрала квоты, на табе agy не показывается — его квоты уже на карточке `acp-antigravity`, иначе один аккаунт был бы виден дважды. Это единственное исключение из правила «не фильтровать по email»; остальная логика Google (§1) не меняется.
5. **Порядок окон на карточке** — блоками семейств, а не типами окон: сначала блок Gemini (`5h` → `Daily` → `Weekly`), затем блок Claude в том же порядке; окна вне таблицы сохраняют порядок источника. До ревизии 2.2 сортировка группировала по типу окна (все `5h`, потом все `Weekly`), что разрывало семейства на смешанных карточках (`Claude 5h` → `Gemini Weekly` → `Claude Weekly`).

## 7. Gemini Web (Argon) — карточки `acp-argon:<id>` (ревизия 2.3, 17.11)

Секция usage-pro по данным provider-argon (контракт PLUG-289, спека provider-argon §4.4); реализация — PLUG-290.

1. **Источник.** Локальный файл `$ARGON_STATE_DIR/accounts-usage.json` (дефолт `~/.bb/plugins/provider-argon/accounts-usage.json`), который пишет provider-argon: `{"accounts": {"<id>": {"daily": {"percent": N, "resetEpochSec": N}, "weekly": {…}, "tier": "ultra"|"pro", "updatedAt": N, "stale": bool}}}`. Читается безусловно на каждый `getUsage`: файл дешёвый, а кэш или гейт по `providerId` прятали бы секцию при scoped-рефреше чужого таба — весь snapshot ответа заменяется фронтом целиком (agy и acp-antigravity переживают scoped-запросы за счёт своих кэшей). Карточки привязываются к primary host — файл локален для машины collector'а.
2. **Окна.** `daily` — 5-часовое скользящее окно Gemini Web → подпись «Gemini 5h»; `weekly` → «Gemini Weekly». `percent` — доля использования → `usedPercent` без инверсии; `resetEpochSec` в секундах → `resetsAt` ISO (×1000); невалидное время (не число или <1.6e9) → `resetsAt=null`.
3. **Идентичность и возраст.** id карточки `acp-argon:<account-id>`; `accountLabel` = `<id> · обновлено <возраст>` («только что» / «N мин назад» / «N ч назад» / «N д назад»), `accountEmail=null`: строки таба рендерят `accountEmail ?? accountLabel`, и возраст в accountEmail затенял бы id, делая строки пула неразличимыми. `usage.status="ok"`, `planLabel` — по tier: ultra→Ultra, pro→Pro, прочий непустой — с заглавной буквы, отсутствующий → null.
4. **Stale.** `stale=true` в записи, отсутствующий `updatedAt` или возраст >30 мин → warning «Данные устарели — обновлено <возраст>» (без возраста — «Данные устарели»), `accountLabel` = голый `<id>` — возраст уже в warning.
5. **Защитная валидация.** Файл отсутствует, не парсится, верхний уровень или `accounts` — не объект → секция скрыта без ошибок. Пустой/blank id аккаунта пропускается — `""` ломал бы nonemptyString strict-схему всего ответа `getUsage`. Запись-не-объект пропускается; невалидный `percent` (не конечное число или <0) обнуляет только свою метрику — карточка остаётся с оставшимися окнами.
6. **Регистрация.** `acp-argon` добавлен в исключение `acp-*`-фильтра рядом с `acp-antigravity` и в `providerOrder`=4 после него; таб формируется динамически по providerId, регистрация источника не требуется. logoUrl-фолбэк `/api/v1/system/providers/acp-argon/logo`, иконка по умолчанию — glyph Sparkles.
