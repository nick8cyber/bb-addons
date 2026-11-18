---
title: Провайдер Devin (bb-plugin-provider-devin)
status: implemented
date: 2026-11-18
revision: 1.1 (§7.4 — контракт синтетического входа восстановления [bb recovery] с mentions: [], PLUG-311)
plugin: bb-plugin-provider-devin
---

# Провайдер Devin (`bb-plugin-provider-devin`)

Плагин подключает локальный `devin` CLI (SWE-2) к `bb` по протоколу ACP через вендорную копию моста `src/vendor/acp-bridge.js`, собираемую из `@get-bb/plugin-sdk@0.6.132` скриптом `scripts/vendor-acp-bridge.mjs` с вклейкой `src/devin-dialect.js`, обёртку `host.ts` и пользовательские хуки `devin-hooks/`.

Документ фиксирует контракты режима прав сессии, мягких служебных уведомлений, выбора бинарника CLI, фазового вотчдога хода, двухступенчатого восстановления сессии, прав доступа к локальному состоянию и защитных хуков.

## 1. Режим прав сессии (`permissionMode`)

### 1.1. Контекст

Мост запускает `devin acp` с флагом `--permission-mode` (`permissionCli` в `server.ts`), но `devin acp` не переносит этот флаг в создаваемую ACP-сессию: фактический режим задаётся опцией сессии `mode` из `configOptions` ответа `session/new`, `session/load` или `session/resume`.

### 1.2. Таблица соответствия `DEVIN_ACP_MODE_BY_PERMISSION_MODE`

| `permissionMode` | Значение `mode` в `devin acp` | Статус в мосте `0.6.132` |
| --- | --- | --- |
| `"accept-edits"` | `"accept-edits"` | Активный режим (`server.ts` объявляет `["accept-edits", "full"]`) |
| `"full"` | `"bypass"` | Активный режим |
| `"workspace-write"` | `"accept-edits"` | Защитное соответствие (схема декодера SDK нормализует `workspace-write` в `accept-edits`) |
| `"auto"` | `"smart"` | Защитное соответствие на уровне `applyDevinAcpSessionMode` (`buildAcpSessionParams` отклоняет `auto`) |

### 1.3. Правила применения

1. Сразу после `session/new` и сразу после успешного восстановления сессии (`session/load` или `session/resume`), до `selectAcpNativeModel` и первого `session/prompt`, мост вызывает `applyDevinAcpSessionMode`.
2. Функция ищет в `configOptions` опцию с `category === "mode"`, а при её отсутствии — с `id === "mode"`.
3. Если опция и целевое значение присутствуют в `option.options`, мост отправляет `session/set_config_option` (`sessionId`, `configId: option.id`, `value`) с таймаутом `ACP_SESSION_CONFIG_TIMEOUT_MS` и собственной pass-through схемой `{ safeParse(value) { return { success: true, data: value }; } }` без привязки к внутренним переменным бандла. Если ответ вернул обновлённый `configOptions`, `session.nativeConfig.configOptions` обновляется до вызова `selectAcpNativeModel`.
4. Если опции или значения нет, либо `session/set_config_option` вернул ошибку, мост пишет предупреждение в `stderr` и продолжает работу в режиме агента по умолчанию (fail-open).

## 2. Служебные уведомления не прерывают ход

В ACP нельзя вклинить сообщение в активный `session/prompt` без `session/cancel`. В базовом мосте `turn/steer` и непустая `session.queuedInputs` в `runTurn` вызывают `requestSteerCancel(session)`, обрывая текущую работу агента.

1. Вход считается мягким служебным уведомлением (`isBbSystemNotice(input) === true`), если первый текстовый блок начинается с `"[bb system]"` или `"[orchestrator]"`.
2. В `turn/steer` элемент добавляется в `session.queuedInputs` с полем `soft: isBbSystemNotice(params.input)`. Если `soft === true`, `requestSteerCancel(session)` **не вызывается** — уведомление дожидается естественного окончания текущего `session/prompt` и обрабатывается следующей итерацией цикла `runTurn`.
3. В `runTurn` после отправки `session/prompt` отмена запрашивается только при наличии жёсткого элемента в очереди: `if (session.queuedInputs.some((item) => item.soft !== true)) { requestSteerCancel(session); }`.

## 3. Центральная настройка `subagentsDisabled` и работа с `config.json`

`server.ts` объявляет булеву настройку `subagentsDisabled` (`default: false`) и передаёт в `providerOptions` флаг `providerSubagentsEnabled: ctx.settings.subagentsDisabled !== true`.

1. На запросах `thread/start`, `thread/resume`, `thread/fork` обёртка `host.ts` читает `params.options.providerOptions.providerSubagentsEnabled` и синхронизирует поле `subagents_enabled` в `~/.config/devin/config.json` через `src/subagent-gate.mjs`.
2. При `providerSubagentsEnabled === false`:
   - если конфиг отсутствует, создаётся каталог `~/.config/devin` (`0o700`, если создаётся впервые), записывается `{\n  "subagents_enabled": false\n}\n` с правами `0o600`, а в `<dataDir>/subagents-gate.json` сохраняется `{ "prior": null }`;
   - если `subagents_enabled` уже `false`, конфиг не меняется и снимок не создаётся;
   - иначе исходное значение (`true` или `null`, если ключа не было) однократно фиксируется в `<dataDir>/subagents-gate.json`, а в конфиг прописывается `"subagents_enabled": false`.
3. При `providerSubagentsEnabled === true`:
   - если `<dataDir>/subagents-gate.json` отсутствует, конфиг не трогается;
   - иначе восстанавливается прежнее значение (`true` либо удаление вставленного поля при `prior: null`) и снимок удаляется.
4. **JSONC-безопасность, симлинки и атомарность (`src/subagent-gate.mjs`, `host.ts`):**
   - Поиск корневой открывающей скобки `{` в `applyDisabled` пропускает BOM, однострочные (`// ...`) и блочные (`/* ... */`) комментарии JSONC и строковые литералы, чтобы `{` внутри комментариев не повреждала файл.
   - Перед записью целевой путь разрешается через `realpathSync` (если файл существует и является симлинком, запись идёт в целевой файл без уничтожения симлинка).
   - Если целевой файл уже существует, сохраняются его текущие права (`stat.mode & 0o777`); для вновь создаваемых файлов выставляется `0o600`.
   - Запись выполняется через уникальный временный файл `<realTarget>.<pid>.<random>.tmp` в `dirname(realTarget)` с последующим `renameSync` и удалением временного файла при ошибке.

## 4. Центральная настройка `memoryEnabled`

`devin acp` не предоставляет локального способа отключить облачную память (Memory Drive / auto-notes). Настройка `memoryEnabled` (`default: true`) передаёт `providerMemoryEnabled` в `providerOptions`. При `providerMemoryEnabled === false` `host.ts` пишет диагностическую строку в `<dataDir>/subagents-gate.log` и не вносит недокументированных полей в `config.json`.

## 5. Версия `@get-bb/plugin-sdk@0.6.132` и сборка вендорного моста

1. В `package.json` фиксируются:
   - `engines`: `"bb": ">=0.49.0"`, `"bbPluginSdk": ">=0.6.132"`, `"node": ">=22.5.0"` (бандл моста использует встроенный `node:sqlite`);
   - `dependencies`: `"@get-bb/plugin-sdk": "0.6.132"`, `"cross-spawn": "^7.0.6"`, `"zod": "^4.3.6"` — все внешние пакеты, импортируемые `src/vendor/acp-bridge.js` в рантайме (`Git`-установка плагина не ставит `devDependencies`).
2. `scripts/vendor-acp-bridge.mjs` собирает `src/vendor/acp-bridge.js` из `dist/provider-bridge-acp.js` пакета `@get-bb/plugin-sdk@0.6.132`:
   - все патч-якоря проверяются через `replaceOnce` (ровно одно совпадение, иначе ошибка сборки); устаревшие проверки импортов `0.4.87` удаляются;
   - `src/devin-dialect.js` использует только собственные уникально именованные импорты (`devinFsSync` из `"node:fs"`, `devinFsPromises` из `"node:fs/promises"`, `devinOs` из `"node:os"`, `devinPath` из `"node:path"`, `resolveDevinBin` из `../resolve-devin-bin.mjs`) без обращения к внутренним идентификаторам esbuild (`z51`, `fs4`, `path9`);
   - диалект регистрируется штатным вызовом `registerAcpDialect(DEVIN_ACP_DIALECT)` и добавлением `devin: DEVIN_ACP_DIALECT.id` в `DIALECT_IDS_BY_COMMAND`.

## 6. Динамический выбор бинарника Devin CLI (`src/resolve-devin-bin.mjs`)

Автообновление Devin CLI может переключить `~/.local/bin/devin` на регрессионный релиз (например, `3000.12.57`, где gRPC-стрим `GetChatMessage` обрывается без ответа), а ручной откат симлинка пользователем или установка новой здоровой версии должны подхватываться без перезапуска `bb` и при любом пересоздании процесса внутри живого треда.

### 6.1. Алгоритм `resolveDevinBin(options?)`

Список известных сломанных версий `KNOWN_BAD_VERSIONS` по умолчанию содержит `["3000.12.57"]` и может переопределяться переменной окружения `BB_DEVIN_KNOWN_BAD_VERSIONS` (список через запятую; пустая строка `""` отключает фильтр). Извлечение версии из реального пути бинарника (`realpathSync`) ищет сегмент `\d+\.\d+\.\d+` (покрывая как `~/.local/share/devin/cli/_versions/<ver>/bin/devin`, так и `/usr/local/lib/devin/<ver>/bin/devin`).

Порядок выбора:

1. **Явный пин `BB_DEVIN_BIN`**: если переменная задана и указывает на существующий исполняемый файл (`X_OK`, не директория), возвращается он безусловно.
2. **Активный бинарник пользователя (`~/.local/bin/devin`, затем `/usr/local/bin/devin`)**:
   - проверяется существование и права исполнения; путь раскрывается через `realpathSync` (в тестах системный путь `/usr/local/bin/devin` может переопределяться через переменную `BB_DEVIN_USR_LOCAL_BIN` по аналогии с `BB_DEVIN_STATE_DIR`);
   - если из раскрытого пути извлекается версия из `KNOWN_BAD_VERSIONS`, кандидат отклоняется;
   - иначе возвращается этот кандидат — ручной пин или откат симлинка `~/.local/bin/devin` пользователем имеет приоритет над более свежими каталогами в `_versions`.
3. **Автоматический откат по `~/.local/share/devin/cli/_versions/<ver>/bin/devin`** (когда активный симлинк указывает на версию из `KNOWN_BAD_VERSIONS` или отсутствует):
   - перебираются только реальные подкаталоги (`lstatSync(entry).isDirectory()`; симлинк `current`, `_download` и `_update.lock` отбрасываются), чьё имя строго удовлетворяет `^\d+\.\d+\.\d+$`;
   - исключаются версии из `KNOWN_BAD_VERSIONS`;
   - проверяется наличие непустого исполняемого файла `bin/devin` (`statSync(bin).isFile() && statSync(bin).size > 0` и `accessSync(bin, X_OK)`);
   - оставшиеся версии сортируются по убыванию числовых компонент `[major, minor, patch]`, возвращается старшая здоровая сборка.
4. **Крайний резерв**: если здоровых сборок не нашлось, но существовал отклонённый кандидат из п. 2, пишется предупреждение в `stderr` и возвращается он; иначе возвращается литерал `"devin"`.

### 6.2. Точки применения (внешние запросы и внутренние перезапуски)

1. **`server.ts`** вызывает `resolveDevinBin()` при формировании базового `acpLaunchSpec`.
2. **`host.ts`** перед передачей JSON-RPC сообщения в вендорный мост обновляет `acpLaunchSpec.command = resolveDevinBin()` по точным путям протокола `0.6.132`:
   - `params.options.providerOptions.acpLaunchSpec` — для `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/steer`;
   - `params.providerOptions.acpLaunchSpec` — для `model/list`, `provider/health`, `provider/usage`, `provider/installation/status`, `provider/installation/run`.
3. **Внутри вендорного моста (`startAgentSession` и `reconcileExecutionSettings`):**
   - в самом начале `startAgentSession(request)` вычисляется булев признак `const isDevinLaunch = request.params.dialectId === "devin" || devinPath.basename(request.params.agent.command) === "devin"`; переменная `let params = request.params` при `isDevinLaunch === true` обновляется **до** вызовов `resolveAcpDialect`, `resolveAgentLaunchArgs` и `createBridgeAgentConnection`: `params = { ...params, agent: { ...params.agent, command: resolveDevinBin() } }`;
   - в `reconcileExecutionSettings(session, options)` **до** сборки `construction` сохраняется `const prevCommand = session.construction.agent.command` и вычисляется `const nextCommand = session.dialect.id === "devin" ? resolveDevinBin() : prevCommand`; в `construction` создаётся **новый вложенный объект** `agent: { ...session.construction.agent, command: nextCommand }` (без мутации `session.construction.agent`), а условие `nextCommand !== prevCommand` включается в булев флаг `restart`.

## 7. Фазовый вотчдог LLM-ответа и двухступенчатое восстановление сессии

В `devin acp` случаются зависания стрима `GetChatMessage`, когда `session/prompt` остаётся незавершённым бесконечно. При этом агент штатно не шлёт чанки во время выполнения инструментов (`exec`, MCP `advisor_review`) и ожидания разрешений пользователя.

### 7.1. Область действия, таймеры, флаги сессии и поведение `onExit`

Вотчдог активен **только** при `session.dialect.id === "devin"` и `session.activePromptKind === "turn"`. Для `activePromptKind === "compaction"` и `"agent"` вотчдог никогда не взводится.

На объекте `session` при создании инициализируются:
- `devinIdleTimer: void 0` — ожидание ответа модели (`BB_DEVIN_LLM_IDLE_MS`, резервный алиас `BB_DEVIN_TURN_IDLE_MS`, по умолчанию `75_000` мс);
- `devinOpenWorkTimer: void 0` — страховочный верхний потолок для зависшего незакрытого `tool_call` без ожидания человека (`BB_DEVIN_OPEN_WORK_MAX_MS`, по умолчанию `3_600_000` мс = 60 мин, чтобы не прерывать длительные сборки, прогоны тестов и `advisor_review`; принятый компромисс: действительно повисший `tool_call` обнаруживается через этот интервал);
- `devinGraceTimer: void 0` и `devinCancelSentAtMs: void 0` — ожидание завершения `session/prompt` после отправки вотчдогом `session/cancel` (`BB_DEVIN_CANCEL_GRACE_MS`, по умолчанию `10_000` мс; жёсткий абсолютный потолок от момента `devinCancelSentAtMs` — `3 * BB_DEVIN_CANCEL_GRACE_MS`);
- `devinCancelSent: false` — монотонный булев флаг вызова `session/prompt`: выставляется в `true` в момент отправки вотчдогом `session/cancel`. На объекте сессии, чей процесс завершается или пересобирается после срабатывания вотчдога, `devinCancelSent` **не сбрасывается никогда** (новый объект сессии создаётся со значением `false`; сброс в `false` допустим только на живом невышедшем процессе `!session.connection.exited`, когда `session/prompt` штатно завершился с любым `stopReason !== "cancelled"`);
- `replayedLastUserTurnText: ""` и `replayedPrevUpdateKind: void 0` — явно инициализированные поля для накопления полного текста последнего пользовательского сообщения при `session.loading === true`.

**Обработка `connection.onExit` при `session.devinCancelSent === true`:**
После штатной проверки `if (!wasCurrent || session.stopping || session.providerThreadId === "") { removeSession(session); return; }` добавляется **отдельная ветка без вызова `removeSession(session)`**:
```js
if (session.devinCancelSent) {
  return;
}
```
Благодаря этому:
1. падение CLI во время `devinGraceTimer` или принудительный `kill()` не вызывают ложный `emitSessionError` и не сбрасывают `activePromptKind` до пересборки (`session.reset` не отправляется);
2. сессия остаётся в `sessionsByBbThreadId` с `session.connection.exited === true` — поэтому `thread/stop` находит сессию во время восстановления, а после остановки по `MAX_TURN_RECYCLES` следующий пользовательский `turn/start` штатно находит сессию через `liveSessionForThread` и пересобирает её через `reconcileExecutionSettings`.

Функция **`disarmDevinTurnWatchdog(session)`** синхронно очищает все три таймера (`devinIdleTimer`, `devinOpenWorkTimer`, `devinGraceTimer`) и вызывается безусловно:
1. в `setActivePromptKind(session, null)`;
2. в `stopSession(session)` и `releaseSession(session)`;
3. в `finally` вокруг `await promptResult` в `runTurn`.

### 7.2. Фазовая синхронизация (`syncDevinTurnWatchdog(session)`)

Признаком прогресса модели считается `isTurnOutputUpdate(update) === true` (множество `TURN_OUTPUT_UPDATE_KINDS` SDK: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`). Служебные события (`usage_update`, `available_commands_update`, `current_mode_update`) таймеры не перезапускают.

Точки вызова `syncDevinTurnWatchdog(session)`:
1. сразу после `session.promptRequestPending = true` (и при `!session.connection.exited`: `session.devinCancelSent = false; session.devinCancelSentAtMs = void 0`) перед отправкой `session/prompt` в `runTurn`;
2. в `emitSessionUpdate(session, update, rawUpdate)` **после** `session.model.applySessionUpdate(rawUpdate)` (при `isTurnOutputUpdate(update) === true` или изменении `agentTurnHasOpenWork(session)`);
3. при добавлении и удалении записи в `session.pendingPermissions` (`handlePermissionRequest`, `cancelPendingPermissions`);
4. при добавлении и удалении записи в `session.pendingElicitations`.

Правила `syncDevinTurnWatchdog(session)` (при `activePromptKind === "turn"`, `promptRequestPending === true`, `!session.stopping`, `!session.devinCancelSent`):

| Состояние открытой работы | `devinIdleTimer` | `devinOpenWorkTimer` |
| --- | --- | --- |
| `pendingPermissions.size > 0` или `pendingElicitations.size > 0` (ждём человека) | **Снят** | **Снят** |
| `model.hasUnfinishedToolCalls() === true` (идёт `exec` / MCP-вызов без ожидания человека) | **Снят** | **Взведён** на `BB_DEVIN_OPEN_WORK_MAX_MS` (перезапускается на `isTurnOutputUpdate`) |
| `agentTurnHasOpenWork(session) === false` (ждём `GetChatMessage` от модели) | **Взведён** на `BB_DEVIN_LLM_IDLE_MS` (перезапускается на `isTurnOutputUpdate`) | **Снят** |

### 7.3. Срабатывание вотчдога и перезапуск `devinGraceTimer` с жёстким потолком

При истечении `devinIdleTimer` или `devinOpenWorkTimer` (после повторной проверки условий своей фазы и `!session.stopping`):

1. Выставляются `session.devinCancelSent = true` и `session.devinCancelSentAtMs = Date.now()`, очищаются `devinIdleTimer` и `devinOpenWorkTimer`.
2. Мост отправляет `session.connection.notify("session/cancel", { sessionId: session.providerThreadId })` (не трогая `session.cancelRequested`).
3. Функция `armDevinCancelGraceTimer(session)` проверяет, что вызов `session/prompt` всё ещё активен (`session.activePromptKind === "turn" && session.promptRequestPending === true && !session.stopping && !session.connection.exited`), и взводит `devinGraceTimer` на `Math.max(0, Math.min(graceMs, session.devinCancelSentAtMs + 3 * graceMs - Date.now()))`, где `graceMs = BB_DEVIN_CANCEL_GRACE_MS` (`10_000` мс) — тем самым хвостовые уведомления после `finally` или выхода процесса никогда не перевзводят таймер на отброшенной сессии.
4. **Обработка `session/update` при `session.devinCancelSent === true`:**
   - служебные апдейты (`usage_update`, `available_commands_update`, `current_mode_update`) и `tool_call_update` со `status === "cancelled"` проходят штатно в `emitSessionUpdate`, но **не перезапускают** `devinGraceTimer`;
   - прочие события из `TURN_OUTPUT_UPDATE_KINDS` (например, `tool_call_update{status: "completed" | "failed"}` от завершённого `exec` или финальный `agent_message_chunk`) **не снимают `devinGraceTimer` насовсем и не сбрасывают `session.devinCancelSent`**, а вызывают `armDevinCancelGraceTimer(session)` — **перезапуская** `devinGraceTimer` с зажимом по абсолютному потолку `session.devinCancelSentAtMs + 3 * graceMs`. Благодаря этому если CLI проигнорировал `session/cancel`, доделал `exec` и затем завис в `GetChatMessage` (или не прислал ответ на `session/prompt`), процесс гарантированно будет убит через `graceMs` тишины и не позднее `3 * graceMs` от момента отправки `session/cancel`.
5. При срабатывании `devinGraceTimer` мост вызывает `void session.connection.kill()`, отклоняя зависший `session/prompt`.

### 7.4. Точка встраивания в `runTurn` и двухступенчатое восстановление

В протоколе моста `0.6.132` остановка пользователем выполняется методом `thread/stop` (`session.stopping = true`), а `session.cancelRequested = true` ставится **только** функцией `requestSteerCancel` (жёсткий steer). Вызов `await promptResult` помещается во внутренний блок `try / catch / finally` с локальным флагом `shouldRecoverStall`, чтобы перехват зависшего промпта выполнялся строго во внутреннем `catch`, а ошибки самой пересборки (`reconcileExecutionSettings` / `rebuildAgentSession`) попадали только во внешний `catch` без повторного цикла.

Условие входа в восстановление по вотчдогу — строго **`session.devinCancelSent === true && !session.stopping`**:
- **Ветка А (внутренний `catch (error)` при `shouldRecoverStall === true` и `session.devinCancelSent === true && !session.stopping`):** перехватывается **до** `dropTurnInput(pending)` и `dropQueuedTurnInputs(session, ...)`;
- **Ветка Б (промис `session/prompt` завершился со `stopReason === "cancelled"` при `session.devinCancelSent === true && !session.stopping`):** перехватывается сразу после `await promptResult` (если же `session/prompt` завершился с любым `stopReason !== "cancelled"` и `!session.connection.exited`, то `session.devinCancelSent` и `session.devinCancelSentAtMs` сразу сбрасываются в `false` / `void 0` и ход продолжается штатно).

Единая процедура восстановления в `runTurn`:

1. **Лимит ретраев на ход (`MAX_TURN_RECYCLES = 2`) и учёт вывода (`turnProducedOutput`):**
   - на входе `runTurn` заводятся `let turnRecycleCount = 0`, `let turnProducedOutput = false`, `let stalledProviderThreadId = null` и `let savedRecoveryQueue = []`;
   - в каждой итерации `for (;;)` база счётчика `const iterOutputBaseline = session.turnOutputCount` снимается **после** `reconcileExecutionSettings` (на новом объекте сессии), а в `finally` вокруг `await promptResult` обновляется `if (session.turnOutputCount > iterOutputBaseline) { turnProducedOutput = true; }`; финальная проверка `"ended without replying"` опирается на `!turnProducedOutput`;
   - при каждом входе в восстановление `turnRecycleCount += 1`; если `turnRecycleCount > MAX_TURN_RECYCLES`, выполняется штатная очистка с ошибкой (`await session.connection.kill()`, `dropTurnInput`, `dropQueuedTurnInputs`, `emitSessionError`, `setActivePromptKind(session, null)`), причём `session` остаётся в `sessionsByBbThreadId` с `connection.exited === true` для будущих ходов.
2. **Учёт `stallStreak` и `wedged-sessions.json`:**
   - в памяти процесса моста ведётся `Map<providerThreadId, number>` (`stallStreakByProviderSession`, LRU до 200 записей); для `previousProviderThreadId = session.providerThreadId` счётчик увеличивается на `1`;
   - **Ступень 1 (`stallStreak === 1`):** `previousProviderThreadId` **не записывается** в `wedged-sessions.json`;
   - **Ступень 2 (`stallStreak >= 2`):** `previousProviderThreadId` атомарно дописывается в `~/.local/state/bb-devin/wedged-sessions.json` (LRU до 200 записей; редкая гонка параллельного чтения-модификации-записи между несколькими воркерами принята как безопасная).
3. **Читатель `wedged-sessions.json` и накопление последнего сообщения при реплее (`startAgentSession`):**
   - при `request.kind === "resume"` и `isDevinLaunch === true` (условие из §6.2 п.3) перед вызовом `session/resume` / `session/load` проверяется `isDevinSessionWedged(request.resumeProviderThreadId)`; если `true`, восстановление пропускается и сразу выполняется `session/new` (`createdFreshSession = true`);
   - во время `session.loading === true` в `handleAgentNotification` накапливаются **все подряд идущие чанки** последнего сообщения пользователя: при приходе `user_message_chunk`, если `session.replayedPrevUpdateKind !== "user_message_chunk"`, присваивается `session.replayedLastUserTurnText = chunkText`, иначе `session.replayedLastUserTurnText += chunkText`, и выставляется `session.replayedPrevUpdateKind = "user_message_chunk"`; при любом другом типе апдейта обновляется только `session.replayedPrevUpdateKind = updateKind`.
4. **Пересборка сессии через штатный `reconcileExecutionSettings`, защита очереди и выбор переигрываемого входа:**
   - в процедуре восстановления элементы очереди сохраняются в `savedRecoveryQueue = session.queuedInputs.splice(0)`, сбрасываются `session.promptRequestPending = false`, `session.cancelRequested = false`, `session.restartAfterCancelError = false` (**не трогая** `session.devinCancelSent`), запоминается `stalledProviderThreadId = session.providerThreadId`, вызывается `await session.connection.kill()`, и выполняется `continue`;
   - в начале следующей итерации при выходе по `if (session.stopping)` все элементы `savedRecoveryQueue.splice(0)` отклоняются через `dropTurnInput(..., "ACP turn stopped before the steer was sent")` наряду с `dropQueuedTurnInputs`; иначе `reconcileExecutionSettings(session, pending.options)` видит `session.connection.exited === true` и вызывает `rebuildAgentSession(session, construction)`. После успешного возврата сохраняемая очередь возвращается в начало новой сессии: `if (savedRecoveryQueue.length > 0) { session.queuedInputs.unshift(...savedRecoveryQueue.splice(0)); }`, а `runTurn` сохраняет `session.turnSettled = previousSession.turnSettled` и `session.turnStartedAtMs = previousSession.turnStartedAtMs ?? Date.now()`. Если же пересборка бросила исключение (`awaitingPromptResult === false`), `catch` отклоняет и `pending`, и все элементы `savedRecoveryQueue.splice(0)` через `dropTurnInput(..., message)` с однократной штатной очисткой без потери ответов очереди;
   - **защита от повторного `input.accepted`:** при первом вызове `acceptTurnInput(session, pending)` выставляется `pending.alreadyAccepted = true`; условие отправки — `if (!inputAccepted && !pending.alreadyAccepted)`;
   - **выбор входа при `stalledProviderThreadId !== null`** (после выбора `stalledProviderThreadId` сбрасывается в `null`):
     - вычисляется `contextLost = session.providerThreadId !== stalledProviderThreadId` (истинно на Ступени 2 и при откате `session/resume`/`session/load` на `session/new`);
     - если `contextLost === false` (история сессии восстановлена):
       - ищется первый жёсткий steer `const hardSteerIdx = session.queuedInputs.findIndex((item) => item.soft !== true)`: при `hardSteerIdx !== -1` элемент извлекается через `const [hardSteer] = session.queuedInputs.splice(hardSteerIdx, 1)` и назначается `pending = hardSteer`;
       - иначе вычисляется текст отправленного пользовательского ввода по точной сигнатуре SDK `0.6.132` `buildPromptContentBlocks(session, pending.input)` с сохранением `session.pendingInstructions` (`const savedPendingInstructions = session.pendingInstructions; session.pendingInstructions = void 0; try { blocks = buildPromptContentBlocks(session, pending.input); } finally { session.pendingInstructions = savedPendingInstructions; }`), склеивается `sentText = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim()`, а из накопленного реплея срезается возможный ведущий блок системных инструкций первого хода `replayedNormalized = (session.replayedLastUserTurnText ?? "").replace(/^\s*<system_instructions>[\s\S]*?<\/system_instructions>\s*/, "").trim()`. При строгом совпадении `sentText.length > 0 && replayedNormalized === sentText` используется `{ ...pending, input: [{ type: "text", text: "[bb recovery] Предыдущий ответ прервался из-за зависания стрима CLI. Продолжи выполнение последнего запроса без повторения уже завершённых шагов.", mentions: [] }], requestId: null, alreadyAccepted: true }`; иначе (включая пустой реплей без `user_message_chunk`) повторяется `{ ...pending, requestId: null, alreadyAccepted: true }` с полным исходным `pending.input`;
       - **Правило формы входа (PLUG-311):** синтетический вход восстановления (`[bb recovery] …`) обязан иметь ту же форму, что вход, прошедший `promptInputSchema`, включая `mentions: []`; без него `textWithBbSkillCommandsSpelledOut` падает с TypeError и ход завершается «Provider error»;
     - если `contextLost === true` (новая пустая сессия `session/new`): повторяется `{ ...pending, requestId: null, alreadyAccepted: true }` с полным исходным `pending.input`, а вся очередь `session.queuedInputs` сохраняется следом.
5. **Самоисцеление:** строго внутри `emitSessionUpdate(session, update, rawUpdate)` при `session.activePromptKind === "turn"`, `!session.devinCancelSent` и `isTurnOutputUpdate(update) === true` счётчик `stallStreak` для `session.providerThreadId` сбрасывается в `0`, а при наличии этого `sessionId` в `wedged-sessions.json` он удаляется оттуда.

## 8. Права доступа и атомарность локального состояния

Все собственные файлы состояния и журналов плагина и хуков размещаются внутри каталога `~/.local/state/bb-devin/` (базовый каталог состояния может переопределяться через `BB_DEVIN_STATE_DIR` для изолированных тестов):

| Путь | Права | Правила создания и записи |
| --- | --- | --- |
| `~/.local/state/bb-devin/` | `0o700` | `mkdir(..., { recursive: true, mode: 0o700 })` + явный `chmod(0o700)` только на сам каталог `bb-devin` и его подкаталоги |
| `~/.local/state/bb-devin/instructions/` | `0o700` | подкаталог инструкций тредов |
| `~/.local/state/bb-devin/instructions/<bbThreadId>.md` | `0o600` | уникальная атомарная запись (`<file>.<pid>.<rand>.tmp` + `rename`), только для `^thr_[a-z0-9]+$` |
| `~/.local/state/bb-devin/wedged-sessions.json` | `0o600` | уникальная атомарная запись (`tmp` + `rename`), JSON-массив до 200 записей |
| `~/.local/state/bb-devin/compacted/` | `0o700` | подкаталог меток сжатия контекста |
| `~/.local/state/bb-devin/compacted/<session_id>` | `0o600` | создание через `os.open(..., 0o600)` |
| `~/.local/state/bb-devin/hooks.log` | `0o600` | журнал хуков по умолчанию; если путь переопределён через `DEVIN_BB_LOG`, родительский каталог создаётся без изменения его прав (`chmod` на внешний родительский каталог вроде `/tmp` или `~/.local/state` **запрещён**) |

## 9. Пользовательские хуки `devin-hooks/`

### 9.1. Устойчивость к формату `stdin` и защита от обхода `GUARD_RE`

Единый список перехватываемых инструментов записи и исполнения (совпадает в `matcher` `devin-hooks/install.py` и в логике `devin-hooks/bb_subagents.py`):
`^(exec|write|edit|MultiEdit|apply_patch|notebook_edit|NotebookEdit|write_file|edit_file)$`.

1. Во всех трёх хуках (`bb_subagents.py`, `bb_instructions.py`, `no_blocking_wait.py`) входной JSON проверяется через `isinstance(data, dict)`; при невалидном JSON или не-словарном корне хук завершается кодом `0` без трассировки.
2. В `bb_subagents.py`:
   - `tool_input` разбирается безопасно: если это `str`, предпринимается попытка `json.loads`; если результат `dict` — используется он, иначе исходная строка сохраняется как сырой текст патча `raw_patch_text`, а `tool_input` полагается равным `{}`;
   - `patch_targets` извлекает пути из `tool_input` (`patch`, `diff`, `input`, `content`, `raw`) и из `raw_patch_text` по заголовкам `+++ `, `--- `, `*** Update File:`, `*** Add File:`, `*** Delete File:`, `*** Move to:` (с отсечением префиксов `a/` и `b/`, табуляций временных меток и `/dev/null`);
   - **канонизация путей для всех файловых и патч-инструментов (`write`, `edit`, `MultiEdit`, `notebook_edit`, `NotebookEdit`, `write_file`, `edit_file`, `apply_patch`):** каждый целевой путь (`file_path`, `path`, `notebook_path`, `edits[*].file_path` и элементы `patch_targets`) проходит `expanduser` + `expandvars`, относительный путь склеивается с `data.get("cwd") or os.getcwd()`, после чего проверяются **оба** пути — `os.path.abspath(candidate)` и `os.path.realpath(candidate)`. Путь блокируется кодом `2`, если он попадает под `GUARD_RE` **либо** под динамическую проверку относительно фактического домашнего каталога `os.path.expanduser("~")` / `os.path.realpath(os.path.expanduser("~"))` (защита `.config/devin/config.json`, `.claude/settings.json`, `.local/share/devin/hooks`, `devin-hooks/(bb_subagents|bb_instructions|no_blocking_wait|install).py` работает и при нестандартном `HOME`). Для произвольных shell-строк инструмента `exec` проверка по `GUARD_RE` остаётся эвристической (принятое ограничение анализа текста shell-команд).
3. В `no_blocking_wait.py` при `not isinstance(tool_input, dict)` хук штатно возвращает `0`.
4. В `bb_instructions.py` строго валидируются `BB_THREAD_ID` (`^thr_[a-z0-9]+$`) и `session_id` (`^[A-Za-z0-9_-]{1,128}$`), все типы полей события обрабатываются без необработанных исключений.

### 9.2. Установщик `devin-hooks/install.py`

1. **Чтение JSONC, резервная копия и отсутствующий конфиг:** если `~/.config/devin/config.json` отсутствует, установщик считает исходный объект пустым `{}` (создавая `~/.config/devin` с `0o700` при записи). При чтении существующего файла перед `json.loads` удаляются комментарии JSONC (`// ...` и `/* ... */` вне строковых литералов) и завершающие запятые; если в исходном тексте присутствовали комментарии JSONC и требуется перезапись файла, `install.py` предварительно сохраняет однократную резервную копию `<realTarget>.bak` (`0o600`), так как сериализация `json.dumps` нормализует файл в чистый JSON (документируется в `README.md`).
2. **Режим `--check`:** формирует диагностический вывод `{"would_write_keys": {k: new[k] for k in ("hooks", "subagents_enabled", "read_config_from") if k in new}}` без `KeyError`, когда `subagents_enabled` отсутствует в исходном конфиге, и завершается кодом `0` (в том числе при отсутствующем `config.json`).
3. **Атомарная запись, симлинки и права:** если `config.json` является симлинком, запись выполняется в `os.path.realpath(CONFIG)` без разрушения симлинка; права существующего файла сохраняются (`stat.st_mode & 0o777`), для нового файла выставляется `0o600`; временный файл создаётся уникальным (`<target>.<pid>.<rand>.tmp`) в той же директории с атомарным `os.replace`.
4. **Тестовые переменные окружения:** для изолированного тестирования установщик поддерживает переопределение путей через переменные окружения `DEVIN_CONFIG_PATH` (путь к файлу конфигурации вместо `~/.config/devin/config.json`), `DEVIN_HOOKS_DEST` (каталог установки хуков вместо `~/.local/share/bb-devin/hooks`) и `DEVIN_LEGACY_HOOKS` (путь к устаревшему симлинку вместо `~/.config/devin/hooks`).

## 10. Матрица обязательных проверок

Скрипт `"test"` в `plugins/bb-plugin-provider-devin/package.json` запускает и Node-тесты, и изолированные Python-тесты единой командой:

```json
"test": "node --test scripts/subagent-gate.test.mjs scripts/resolve-devin-bin.test.mjs scripts/devin-dialect.test.mjs scripts/acp-bridge-e2e.test.mjs && python3 -I devin-hooks/bb_subagents.test.py && python3 -I devin-hooks/bb_instructions.test.py && python3 -I devin-hooks/no_blocking_wait.test.py && python3 -I devin-hooks/install.test.py"
```

Состав обязательных тест-кейсов:

1. **`scripts/resolve-devin-bin.test.mjs`:**
   - приоритет `BB_DEVIN_BIN`;
   - приоритет здорового симлинка `~/.local/bin/devin` (ручной откат пользователя на младшую здоровую версию не перебивается более новой версией в `_versions`);
   - пропуск симлинка `~/.local/bin/devin` и `/usr/local/bin/devin` (включая `/usr/local/lib/devin/<ver>/bin/devin`), указывающего на `3000.12.57`, с выбором старшей здоровой версии из `_versions`;
   - игнорирование симлинка `current`, каталога `_download`, файла `_update.lock` и пустых бинарников в `_versions`.
2. **`scripts/devin-dialect.test.mjs`:**
   - классификация субагентов Devin в `delegation`;
   - сохранение инструкций треда с правами `0600` и каталогом `0700` при уникальных временных файлах;
   - `applyDevinAcpSessionMode` (включая защитные строки `"workspace-write"` и `"auto"`, обновление `configOptions` и fail-open);
   - мягкая очередь `[bb system]` / `[orchestrator]` без `requestSteerCancel`.
3. **`scripts/acp-bridge-e2e.test.mjs` (реальный спавн `host.ts` / вендорного моста поверх дочернего фейкового ACP-агента по stdio JSON-RPC):**
   - длинный открытый `tool_call` дольше `BB_DEVIN_LLM_IDLE_MS` успешно завершается без срабатывания `devinIdleTimer`;
   - зависший открытый `tool_call` без ожидания человека срабатывает по `BB_DEVIN_OPEN_WORK_MAX_MS`;
   - зависший `session/prompt`, во время которого пришли сначала мягкое уведомление `[bb system]`, а за ним жёсткий `turn/steer` до срабатывания `devinIdleTimer`: восстановление не блокируется `cancelRequested`, находит жёсткий steer через `findIndex` позади мягкого уведомления, выполняет его первым без повторного `input.accepted` для исходного ввода и доставляет `[bb system]` следом;
   - на `session/cancel` вотчдога фейковый агент присылает `tool_call_update{status: "failed"}` и завершает промис со `stopReason: "cancelled"`: ход проходит восстановление §7.4;
   - на `session/cancel` вотчдога фейковый агент игнорирует отмену, присылает `tool_call_update{status: "completed"}` и замолкает навсегда: `devinGraceTimer` перезапускается (а не снимается), убивает процесс по истечении grace и выполняет Ступень 1;
   - самопроизвольное падение CLI во время `devinGraceTimer` (до истечения grace): не порождает ложный `emitSessionError`, не отправляет `session.reset` и штатно проходит Ступень 1;
   - при игнорировании `session/cancel` и приходе `usage_update` / `tool_call_update{status: "cancelled"}` `devinGraceTimer` убивает процесс и выполняет Ступень 1 (`session/load` с реплеем двумя чанками `user_message_chunk`, включая первый ход с `<system_instructions>`, отправляет `[bb recovery]` без дубля по строгому равенству `===`; при реплее без единого `user_message_chunk` переигрывает полный исходный ввод без `TypeError`; подхватывает смену бинарника как при Ступени 1, так и между обычными ходами);
   - сбой спавна нового процесса при пересборке внутри восстановления: однократная штатная ошибка без повторного цикла и с корректным отклонением элементов очереди через `dropTurnInput`;
   - повторный срыв подряд переводит сессию на Ступень 2 (`wedged-sessions.json` + `session/new` + `contextLost: true` + переигрывание исходного ввода), а последующий `thread/resume` этого `providerThreadId` сразу обходит `session/load`;
   - третий срыв подряд в одном ходе останавливается по `MAX_TURN_RECYCLES = 2` со штатной ошибкой, после чего следующий пользовательский `turn/start` в том же треде штатно проходит и пересобирает сессию;
   - после нормального завершения хода ни один таймер вотчдога не остаётся активным.
4. **`scripts/subagent-gate.test.mjs`:**
   - JSONC с начальными `//` и `/* { } */` комментариями, отсутствующий конфиг, симлинкованный `config.json`, сохранение прав и атомарный round-trip.
5. **Python-тесты (`devin-hooks/*.test.py`):**
   - `bb_subagents.test.py`: строковый `tool_input` в `apply_patch`, блокировка относительных путей (`.config/devin/config.json` при `cwd=$HOME`, `.claude/settings.json`), `notebook_edit` и симлинков на защищённые файлы (в том числе при временном `HOME`), пропуск легитимных патчей, не-словарный JSON;
   - `bb_instructions.test.py`: инжекция после компакции, права `0700`/`0600`, запрет `chmod` на внешний каталог при `DEVIN_BB_LOG=/tmp/...`;
   - `no_blocking_wait.test.py`: блокировка `sleep >= 5` / `poll` и устойчивость к строковому `tool_input`;
   - `install.test.py`: `--check` без `subagents_enabled` и при отсутствующем `config.json`, чтение JSONC с комментариями и создание `.bak`, сохранение симлинка и прав файла, единый `matcher`.
6. **Сборка и типизация:** `npx tsc --noEmit`, `npm run vendor`, `bb plugin build`, `scripts/check-changed-plugins.sh`.
