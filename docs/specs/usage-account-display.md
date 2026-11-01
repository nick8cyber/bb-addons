---
title: Usage Pro — идентичность аккаунтов и локальные ошибки квот
status: approved
owner: coordinator
date: 2026-11-01
tags: [usage-pro, codex, accounts]
---

# Usage Pro — идентичность аккаунтов и локальные ошибки квот

## 1. Наблюдения, разрешение и сохранение

Владелец сказал «да делай» после аудита дублирования Codex и постоянной плашки refresh error. Разрешено исправить отображение и установить проверенный результат. Аккаунты, токены, авторизации, модели, маршруты, Account Pooler enabled/routing и очередь повторов не изменять.

Native Codex и Pi сейчас используют одну quota identity openai:chatgpt:67628130… (Team). Сборщик после общего dedup вручную добавляет Pi как Team каждому host и принудительно называет native Plus. Отключённый Pool account d42622fa… остаётся отдельной identity и возвращает usage.status=error. Сборщик бросает исключение на валидном account error и хранит failures, затем делает ошибочным весь host; frontend показывает это на любой вкладке.

Основа — merge 7ac05f5: текущий main ee3e3b0 + четыре уже работающих commit активной ветки fix/codex-retry-scheduled-queue cccb12c. Так сохраняются упакованный backend и существующий credit-retry. Не редактировать активный установленный worktree; работать только в отдельных ветках/worktree. credit-retry.ts и его поведение остаются неизменными.

## 2. Каноническая идентичность и тариф

Дедупликация — по (machineId, providerId, accountKey), где accountKey выдан провайдером в пространстве issuer/account scope. Native source уже передаёт accountKey. Pi получает ключ openai:chatgpt:<accountId> из реального chatgpt-account-id, использованного текущим запросом; не брать email или выдуманное имя. Для неизвестного ID ключ null: такие ресурсы НЕ объединять даже при одинаковом email/процентах/тарифе.

Pi проходит через тот же выбор кандидатов, а не добавляется после него. Одна известная identity в одном host даёт одну карточку и один набор окон: проценты НЕ суммировать, окна разных измерений НЕ склеивать. Выбирать успешное измерение перед ошибкой; среди успешных самое свежее observedAt; при равенстве предпочесть native, затем Pi, затем прочее, стабильно сохраняя исходный порядок. Разные accountKey остаются разными карточками. Для других providerId сохранить прежнее предпочтение shared-source, без изменения Google/Claude логики.

Pi использует auth-файл сервера. Привязывать его только к серверному host ID из публичного sdk.system.config().primaryHostId (в текущем BB это readPrimaryHostIdFromDataDir), никогда ко всем hosts и не по позиции массива. При неизвестном origin не приписывать Pi удалённому host: допустима отдельная source-группа либо временное отсутствие host-карточки до разрешения origin, без выдуманных измерений.

Тариф native — из актуального normalized usage.planLabel/plan. Тариф Pi — из реального usage API plan_type/plan metadata; JWT plan hint допустим только при соответствии account scope тому же request accountId. При отсутствии надёжных сведений не выдумывать Team/Plus, использовать нейтральную подпись Pi/Codex либо null. Название маршрута можно добавить отдельно, оно не является тарифом.

При смене известной identity в inventory инвалидировать измерение старого accountKey до dedup/показа, независимо от TTL. Pi cache не должен выдаваться за другой аккаунт после ротации auth scope. Секреты остаются только в серверном collector, не входят в RPC, логи, fixtures и отчёты.

## 3. Ошибки и предупреждения

Валидный provider measurement со status=error — данные отдельного ресурса. Сохранять его в measurements и показывать existing account error UI, включая понятный источник в сообщении/подписи. Не бросать на нём transport exception и не поднимать machine.error. Так отключённый Pool account остаётся видимым с собственной ошибкой, а здоровые Codex/Claude/Google вкладки не получают общую плашку.

Transport/getResource exception также локализовать на соответствующем ресурсе. Если есть старое успешное измерение того же accountKey, сохранить его как last-known и явно показать локальное предупреждение об устаревании/неудачном обновлении; если измерения нет — account error card. Нельзя выдавать stale за свежие, терять действительную ошибку, помечать запрос успешным без данных или удалять неисправные подключения. После успешного refresh локальная ошибка очищается. Проблема одного ресурса не переносится на другую карточку/вкладку/host.

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

## 5. Приёмка и доставка

| Сценарий | Результат |
|---|---|
| Native/Pi same accountKey | Одна карточка, реальные окна/тариф, обе авторизации не изменены |
| Разные/неизвестные IDs, одинаковые email/проценты | Раздельные карточки |
| Разные hosts и server origin | Pi только на своём host; разные hosts не смешиваются |
| Свежий healthy vs stale/error duplicate | Один актуальный набор окон, без суммирования |
| Identity rotation и cache | Старые квоты не приписываются новому account |
| Pool error + healthy others | Локальный account error, нет постоянного общего banner |
| Source transport error + stale data | Локальное честное предупреждение, recovery очищает его |
| Inventory/RPC/offline failure | Реальная ошибка остаётся видимой |
| Credit retry | Прежние tests/поведение и уже созданная очередь сохранены |

Порядок: документный commit → один pre-review opus55-xhigh-review до исполнения → параллельно A+B в отдельных ветках/worktree → проверка координатором реальных modules/integration → один post-review и один advisor_review после implementation/checks → согласование активных агентов только bb-addons → main/push и install path→path с тем же id usage-pro → live checks.

При недоступности исполнителей использовать заданную цепочку, 404/removed не повторять, при 10 min отсутствия рабочих событий сохранять WIP и переключать маршрут. Не расходовать часы на молчание. Есть явное разрешение владельца mem_z5l-vlwc8ru брать Codex/Opus для работы при недоступности базовых исполнителей; перед каждым Claude/Codex запуском проверять usage.

До доставки сохранить source/settings/KV/очереди и старые два dirty generated files main в private backup. Проверить их хэши против ранее снятых fingerprints; если изменились кем-то за время работы — не затирать новые правки. Заменять только затронутые сгенерированные файлы после сохранения исходных данных, не трогать другие dirty paths. Path→path install сохраняет настройки/данные, без uninstall. Откат — прежний path source; не восстанавливать старую глобальную БД поверх новых данных. Не менять provider-retry, active-account selections или Account Pool routing.

Live: у a1-stockholm один healthy Codex account 67628130… с Team и одним набором окон; legacy disabled account d426… отдельно как error, без machine.error. У Dubai-PC нет скопированной Pi source карточки a1. Настоящие transport ошибки не маскировать. Сравнить quota identity/window counts с исходными sources и убедиться, что auth/settings/routes/очередь не менялись. Если подключить другой account, его карточка должна сохраняться (fake tests, без смены живого аккаунта).
