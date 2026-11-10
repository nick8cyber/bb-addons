---
title: provider-agy — миграция на ACP-транспорт
status: draft
owner: coordinator
date: 2026-11-10
revision: 2 (аудит спеки thr_zr4e7sjrhv)
tags: [bb, plugins, provider-agy, acp]
---

# provider-agy — миграция на ACP-транспорт

Мост `bb-plugin-provider-agy` пересаживается с нативного `agy --output-format stream-json` на `agy acp` поверх generic-моста `experimental_acpProviderBridge` (SDK `@get-bb/plugin-sdk`). Причина: stream-json не отдаёт ни мысли модели, ни аргументы/результаты тулов — в треде видны только пустые `agentMessage` и имя тула. По ACP generic-мост сам переводит `agent_thought_chunk` → `item/reasoning/textDelta`, `agent_message_chunk` → `item/agentMessage/delta`, `tool_call`/`tool_call_update` → `toolCall`/`commandExecution` с аргументами и выводом.

Живой прогон `acp-agy` (customAgents) подтвердил: мысли стримятся дельтами по ходу хода, тул-вызовы несут команду/путь/вывод/exitCode, существующий токен `~/.gemini/antigravity-cli` подходит без перелогина, `session/load` читает разговоры, созданные в stream-json.

Решение и отклонённые варианты — [ADR 0021](../adr/0021-provider-agy-acp-transport.md). Аудиты: дизайна — `thr_sjeifftbdr`, спеки — `thr_zr4e7sjrhv`; все находки учтены ниже.

## 1. Архитектура: обёртка + транспортный shim

Два слоя перехвата, потому что `handleLine` видит только границу «демон BB ↔ мост», а трафик `session/prompt`/`session/update` живёт на приватном stdio-пайпе между generic-мостом и процессом `agy acp`.

- **Обёртка** (`src/acp-wrapper.ts`, реэкспорт через `host.ts` — чистый фасад): объявляет `experimental_providerBridge`, оборачивает `experimental_acpProviderBridge`. Делегирует `handleLine` и `onClose` (метода `start` у generic-моста нет — `start(context)` реализует сама обёртка: инициализация `accountsDir`, леджера, пула). Перехватывает строки в обе стороны на границе демона.
- **stdio-shim** (`src/acp-shim`, подставляется в `acpLaunchSpec.command` вместо `agy`): прозрачный NDJSON-ретранслятор, спавнит реальный `agy acp`, пробрасывает stdin/stdout и параллельно снифит JSON-RPC — ответ `session/prompt` (`result.usage`, текст ошибки) и нотификации `session/update` (`tool_call_update` с текстом отказа) — и пишет события в side-channel (fd/файл), который читает обёртка. В обратную сторону shim правит запросы `session/new`/`session/load`: инъектит `params.disableBuiltInTools` (см. §9). Паттерн — `wrapper-script.ts` у rawizhere.

Generic-мост отвечает за: JSON-RPC, `session/new`/`load`/`prompt`/`cancel`/`set_mode`, перевод session/update → thread-дельты, permissions, steer. Обёртка отвечает за всё проприетарное ниже.

`server.ts` провайдера обновляется: `permissionModes: ["full","accept-edits"]` и `experimental_bridgeOptions` (`acpLaunchSpec`, `acpDialect: "generic"`) — сейчас заявлен только `"full"`, без правки демон не даст сменить режим. Из первоначального набора `["full","default","accept-edits","plan"]` оставлены два: generic-мост маппит режимы через `permissionCli.insertAfterArgs`, и доставляемы на этом диалекте только `full` и `accept-edits`; заявленный, но недоставляемый режим (проверено на `auto`) отклоняется демоном на `thread.start` («does not support permission mode») — декларируем только то, что реально доезжает.

## 2. Пул аккаунтов и изоляция

- Изоляция аккаунта — **только** флаг `--gemini-dir <account-home>/.gemini` с абсолютным путём в `acpLaunchSpec.args` при `thread/start`/`thread/resume`. Флаг `--app-data-dir` не передаётся: в agy 1.5.3 он резолвится относительно `--gemini-dir` и с абсолютным путём ломает стор. `HOME` не подменяется (остаются `~/.gitconfig`, `~/.ssh`).
- Прокси аккаунта (`accounts/<label>/proxy`) — через `HTTP(S)_PROXY` в `acpLaunchSpec.env`.
- `src/accounts.ts` переезжает с одним дополнением: в него переносятся `isAccountIneligible` и `ineligibleBreaker` из `src/provider-bridge.ts` (~L484–509, ~L787–805) — парковка аккаунтов с капчей/регион-блоком и предохранитель от массовой парковки. Остальное без изменений: `listAccounts`, леджер `accounts-state.json`, `pickAccount` (LRU, исключая сгоревший), `markAccountCooldown`, `writeAccountHome`. Тесты пула обновляются под новые точки входа.
- Sticky: `providerThreadId` → аккаунт записывается в леджер на первом `thread/identity`; `thread/resume` берёт аккаунт-владельца из леджера.

Проверка: харнесс `harness-pool.mjs` прогоняется на ACP-транспорте — новая сессия стартует на выбранном аккаунте, в env/args уходят `--gemini-dir` и прокси; `thread/resume` возвращается на аккаунт-владельца.

## 3. Ротация аккаунтов и авторетрай по квоте

Штатный `provider-retry` сам не справляется: generic-мост шлёт `provider.error` без `errorInfo`, демон повтор не инициирует, а generic-мост отвергает параллельный `turn/start` («A turn is already active») и сбрасывает очередь вводов при ошибке хода (`dropQueuedTurnInputs`). Поэтому ротацию и повтор делает сама обёртка — по строгому автомату:

1. Ошибка квоты перехвачена (из shim/`provider.error`) → аккаунт помечается кулдауном, внешний `provider.error` **подавляется** — для демона ход остаётся активным.
2. Обёртка ждёт остановки/релиза текущей сессии, затем синтезирует `thread/start` на том же треде с `--gemini-dir` сиблинга → generic-мост релизит старую сессию и строит новую → обёртка эмитит `sessionReplaced` (contextLost).
3. Обёртка синтезирует `turn/start` с `input` = handoff-промпт (`[quota-rotation-handoff]` + recentAssistantText ≤4k + `git diff --stat`); идентификаторы хода маппятся на ожидаемый демоном turn, чтобы boundary/дельты закрыли исходный ход честно.
- Очередь ходов — **в самой обёртке** (generic очередь не держит): ходы, пришедшие во время ротации, выполняются по порядку на новой сессии.
- Если остыл весь пул: обёртка пропускает `provider.error` наружу с инжектированным `errorInfo{category:"rate-limit", httpStatusCode:429}` и эмитит `provider.rateLimits` (blocked, resetsAt = ближайший конец кулдауна) → штатный `provider-retry` ждёт resetsAt и перезапускает ход. Когда от `provider-retry` приходит повторный `turn/start`, обёртка проверяет кулдаун текущего аккаунта сессии: если мёртв/сменился — сначала автомат пп.2–3 (новая сессия + handoff), затем пропуск хода. Снятие blocked — `provider.rateLimits` ready. Пока сессия в состоянии blocked, `drainQueue` **удерживает daemon-ходы** в очереди (internal-ходы автомата всегда дренируются); после `ready`/settle очередь снимается `drainQueue` из `onSettled`.
- `AGY_AUTO_RETRY_MAX`, `AGY_AUTO_RETRY_MAX_WAIT_MS`, `AGY_INELIGIBLE_*` — те же env и смыслы; бюджет ретраев — на сессию, сбрасывается на честно завершённом ходе. Stop отменяет ожидание ретрая и висящий повтор.
- **auth-dead (инцидент 10.11):** слёт Google-входа пул-аккаунта — agy отвечает `auth_required`/`Authentication required` (в его логе «Silent sign-in failed», «not logged into Antigravity», «error getting token source»). Это НЕ квота и НЕ eligibility: классификатор (`isAuthDead`, единый список сигнатур в `accounts.ts`) заводит причину `auth-dead` → аккаунт паркуется как ineligible (длинный `cooldownUntilMs` + `ineligibleAtMs`, плюс `parkedReason:"auth-dead"` в accounts-state.json; тот же ineligible-breaker) → та же ротация пп.2–3 со свободного сиблинга, `sessionReplaced` с reason «the session's account lost its Google sign-in (auth_required)». `turn/start` и `resume` на припаркованном аккаунте попадают в ту же ветку по `cooldownUntilMs`. Пустой пул → честный `provider.error` (unauthorized) с текстом об исчерпании пула — без спама ротаций. `auth-dead` не трогает quota-поля и не считается toolError; наружу уходит `errorInfo{category:"unauthorized", httpStatusCode:401}` только когда ротация невозможна.

Проверка: харнесс `harness-rotation.mjs` на ACP — квота на А → переезд на Б с handoff за ~1с, демон видит один непрерывный ход; весь пул в кулдауне → rateLimits blocked + ретрай после resetsAt на ожившем сиблинге; ход, пришедший во время ротации, выполняется после неё; auth_required на живом ходу → парковка + переигровка на соседе; resume на мёртвом — ротация; все мертвы → честный фейл.

## 4. Классификация ошибок и rateLimits

`classifyError`/`quotaResetAtMs` переносятся дословно; парсинг «Resets in X» сохраняется. Форма квоты по ACP берётся из двух источников: JSON-RPC error `session/prompt` (видит shim) и `provider.error`/неуспешный boundary (видит обёртка на границе демона). `provider.rateLimits` эмитится обёрткой напрямую в поток дельт — generic-мост его не знает.

Проверка: фикстура fake-agy-acp (создаётся в рамках работ) с ответом квоты → классификатор даёт resetsAt, эмитится blocked-снапшот.

## 5. Usage за ход

`agy acp` возвращает `result.usage` (`inputTokens`, `outputTokens`, `thoughtTokens`, `totalTokens`) в ответе `session/prompt`; generic-мост его игнорирует (схема читает только `stopReason`), и на границу `handleLine` он не попадает. Добыча — **stdio-shim** (§1): снифит ответ `session/prompt`, пишет usage в side-channel, обёртка эмитит usage-дельту в тред. SQLite-прокси не нужен. Лимиты аккаунтов по-прежнему собирает `bb-plugin-usage-pro` — не трогаем.

Проверка: в треде после хода виден расход токенов; фикстура отдаёт usage → дельта проходит.

## 6. Восстановление: compaction fallback и ArtifactMetadata

- **Compact fallback** (`AGY_COMPACT_FALLBACK`): конечный автомат ADR-0003 переносится в обёртку — при отказе сжатия: `compactSummaryPrompt` в том же разговоре → новая сессия с `compactSeedPrompt`/`compactMemoPrompt` первым ходом. `/compact` у agy acp идёт обычным текстом промпта (проверено живым тестом); собственного `session/compact` у сервера нет.
- **ArtifactMetadata**: основной механизм — превентивный `WRITE_GUARDRAIL` в инструкциях сессии (перехват `tool_call_update` через `handleLine` невозможен). Дополнительно shim видит текст отказа `tool_call_update` («is not a valid artifact path») в side-channel → обёртка может однократно подать `writeRetryNudge` следующим вводом (`MAX_ARTIFACT_RETRIES=1` **на ход**: счётчик и флаг nudge сбрасываются на каждой границе хода — долгоживущая сессия не теряет nudge после первого использования).

Проверка: харнесс `harness-errors.mjs`/`harness-artifact.mjs` на ACP — компакт-фоллбэк проходит два шага, артефактный отказ встречает один повтор с nudge.

## 7. `thread/resume` при остывшем владельце и `turn/start` на остывшей сессии

Перехват `thread/resume` читает леджер: если аккаунт-владелец в кулдауне — запрос трансформируется в `thread/start` на свободном сиблинге, `needsHandoffPrompt` на первый ход (handoff-промпт подменяет `input`), клиенту шлётся `sessionReplaced`. Если владелец жив — делегируется как есть (session/load читает разговор, в т.ч. созданный в stream-json).

Та же проверка на каждом входящем `turn/start`: если аккаунт текущей сессии остыл (напр., повтор пришёл от provider-retry спустя часы) — сначала ротационный автомат §3 пп.2–3, затем пропуск хода.

Проверка: харнесс — resume с кулдаун-владельцем стартует сиблинга с handoff; resume с живым владельцем грузит ту же беседу; повторный turn/start на мёртвой сессии сначала ротирует.

## 8. Модели, режимы, permissions

- `model/list`: быстрый путь — ответ из кэша (TTL 6 ч) или `agy models` (~100 мс); холодный прогон ACP-сервера только на промахе кэша (таймаут, при неудаче — последний кэш). Усилия — не отдельные модели: `gemini-3.8-flash` + `supportedReasoningEfforts` (low/medium/high) → `session/set_config_option` (`thought_level`), маппинг id вида `<model>-<effort>` по образцу `model-utils.ts` rawizhere; голый id без суффикса — стандартная лестница `thought_level` (low/medium/high), не «только medium».
- Permission mode треда → `session/set_mode` на живой сессии (`default`/`accept-edits`/`plan`; проверено: работает на лету). `--dangerously-skip-permissions` добавляется в args для `full` (`permissionCli`-маппинг). Декларация режимов в `server.ts` — см. §1.
- Канал смены режима на живой сессии — side-channel файл `acp-shim/ctl-<thread>-<nonce>.ndjson`: обёртка **создаёт его пустым при запуске сессии** (shim ставит `fs.watch` до первой записи; без файла watch молча не регистрируется). Shim дополнительно создаёт файл перед `watch` и дренирует его на каждой входящей строке — три независимых гарантии доставки `{"cmd":"set_mode","mode":...}` → `session/set_mode` в agy.
- Стиринг — `turn/steer` generic-моста (session/prompt на живой сессии); очередь стирингов старого моста не нужна — `session/cancel` отменяет mid-tool штатно (проверено).

Проверка: `bb provider models agy` отвечает <1с на горячем кэше; смена режима в треде не пересоздаёт сессию; стиринг доезжает в идущий ход.

## 9. Прочее из аудита

- Висящие `interactionRequest`: обёртка ведёт мапу активных `interactionId` из перехваченных нотификаций демона и при релизе сессии (ротация, stop, failOut) эмитит клиенту событие резолва/отмены каждого — иначе диалог аппрува висит в UI навсегда (`cancelPendingPermissions` generic-моста закрывает только внутренний запрос агента).
- Аудит PLUG-167 (10.11.2026, Gemini review): дополнительно закрыты — ctl-канал set_mode (см. §8), `input.accepted` для стиринга в ротации, per-turn бюджет artifact-nudge (§5), удержание очереди при rateLimits-blocked (§3), shim SIGTERM ребёнку по таймауту после закрытия stdin, `events.ndjson` читается с EOF при старте (без реплея мёртвых сессий), armed-ошибка side-channel помечается handled при первой классификации.
- **Нативные субагенты agy отключены (11.11.2026)**: agy умеет запускать собственных субагентов (`invoke_subagent`, `manage_subagents`, `define_subagent`, `browser_subagent`, `native_swarm`/`manage_swarm`, `boost`) — они живут внутри процесса agy и в BB не видны; каждый субагент обязан быть тредом BB. Управление — центральная настройка провайдера `subagentsDisabled` (`bb plugin config provider-agy set subagentsDisabled false`, по умолчанию **включена** — в отличие от codex, где нативные субагенты по умолчанию разрешены): server.ts через `deriveProviderOptions` кладёт её в `options.providerOptions.providerSubagentsEnabled` на каждый thread/start|resume — тот же контракт, что у codex/claude-code. Обёртка резолвит: `AGY_DISABLE_SUBAGENTS` env-override ("0" разрешает, прочее запрещает) > `providerSubagentsEnabled` > по умолчанию запрещено. Два слоя исполнения: (1) обёртка передаёт решение в env шима `AGY_DISABLE_SUBAGENTS`, shim инъектит `params.disableBuiltInTools` (список выше) в каждый `session/new`/`session/load` — поле штатного ACP `NewSessionParams`, агент фильтрует по своему реестру, лишние имена безвредны; (2) обёртка перед каждым запуском аддитивно мёржит в `<account-home>/.gemini/settings.json` `antigravityConfig.subagentsConfig.enabled=<resolved>` и `boostCommandDisabled=<!resolved>` (пишет и snake_case-вариант — схема парсера agy не подтверждена, protojson принимает оба) — re-enable тоже доезжает, страховка для путей без session-параметров.
- Общий `conversation_summaries.db` мостом для чтения не используется — `SQLITE_BUSY` не возникает.
- Параллельные треды на одном аккаунте допустимы; кулдаун от 429 любого из них ставится на аккаунт целиком (как сейчас); покрывается тестом §11.

## 10. Что выкидывается

Парсер `step_update`/`handleResult` (заменён ACP-переводом), stale-quota-residue (в ACP ошибки не липнут), свипперы сессий/ходов (lifecycle ведёт generic-мост), очередь стирингов (штатный steer). Старый stream-json мост целиком остаётся за флагом `AGY_TRANSPORT=stream-json` на один релиз — откат без деплоя.

## 11. Тест-план

1. Юнит: классификатор квоты под обе ACP-формы; маппинг `model/effort → session/set_config_option`; разбор usage из side-channel shim → usage-дельта; маппинг turn-идентификаторов при внутренней ротации.
2. Харнессы на **fake-agy-acp** (создаётся: NDJSON ACP по stdin/stdout, вкл. `result.usage` и отказы `tool_call_update`): пул+sticky; ротация по автомату §3 с handoff и подавленной ошибкой; весь пул в кулдауне → rateLimits+provider-retry → ретрай на ожившем сиблинге; resume на остылом; turn/start на мёртвой сессии; compact fallback 2 стадии; ArtifactMetadata (guardrail + nudge через shim); резолв висящего interaction при релизе сессии; **два параллельных треда на одном аккаунте** — кулдаун распространяется без сбоя соседнего треда; `disableBuiltInTools` во всех `session/new`/`session/load` транскрипта и `settings.json` аккаунта с `subagentsConfig.enabled=false`.
3. Живой прогон: тред на `agy` (ACP) — мысли стримом, аргументы/вывод тулов видны, usage после хода, стиринг, stop mid-tool, resume после рестарта bb; валидация обновлённого `server.ts` (режимы переключаются в UI).
4. Откат: `AGY_TRANSPORT=stream-json` — старое поведение без изменений; **регрессионный прогон существующего сьюта харнессов под флагом**.
