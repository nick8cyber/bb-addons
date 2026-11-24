---
title: provider-web-gemini (ранее provider-argon) — ACP-провайдер веб-интерфейса Gemini
status: approved
owner: coordinator
date: 2026-11-24
revision: 34 (r34 — r27: управляемые группы браузера Chrome/Xvfb, маркеры и .lock, реапер сирот, fail-closed flock, PLUG-374; r28: §4.5 каналы сбора генерируемых файлов, отсев телеметрии/RPC, magic-bytes и canvas-fallback, PLUG-376; r29: детект стола генерации no-progress вместо wall-clock дедлайна — фазовый SEND_DEADLINE, SESSION_CAP, STALL_MS и авторетрай стола с ротацией, PLUG-371; r30: §2.3 детект прогресса мышления и поиска Gemini Web, hasActiveThinkingOrTool, PLUG-407; r31: §2.3/§4.2 изоляция спиннеров busySelector от hasActiveThinkingOrTool; r32: §2.3/§4.2 единый контракт findTurnTarget с fallback на pending-response; r33: §2.3 продление стола строго при hasStopButton && hasActiveThinkingOrTool, запрет в awaitingContent, statusText в domSig, ограничение присутствия до hasFinishedContent, PLUG-407; r34: §2.3 белый список диалогов, журнал driver:dialog, класс WEB_GEMINI_UNKNOWN_DIALOG в §3.4, PLUG-408; §2.5 промежуточные шаги, мысли и поиск Gemini в BB через ACP, PLUG-409)
tags: [bb, plugins, provider-web-gemini, provider-argon, acp, gemini]
---

# provider-web-gemini (ранее provider-argon) — ACP-провайдер веб-интерфейса Gemini

Плагин `bb-plugin-provider-web-gemini` (ранее `bb-plugin-provider-argon`) регистрирует в BB ACP-провайдера `acp-web-gemini` («Gemini (Web)», с сохранением совместимости для `acp-argon`) поверх веб-интерфейса `gemini.google.com` без API-ключей. Транспорт работает по JSON-RPC 2.0 (протокол ACP) через `acp-server.mjs` и управляет изолированными headless-профилями Chrome по Chrome DevTools Protocol (`playwright` или `playwright-core`).

Архитектурное решение и отвергнутые альтернативы зафиксированы в [ADR 0027](../adr/0027-provider-argon-acp.md). Связанные разделы спеки оркестратора (унифицированные роли с инструментами и абстрактные контракты возможностей) — [orchestrator.md §§12, 20–21](orchestrator.md).

---

## 1. Архитектура и точки входа

1. **`index.mjs`** — точка входа плагина BB (`export default function plugin(bb: BbPluginApi)`):
   - Манифест плагина в `package.json` объявляет `"name": "bb-plugin-provider-web-gemini"` и контракт манифеста `"bb": { "server": "index.mjs" }`.
   - Регистрирует основной провайдер `acp-web-gemini` (`displayName: "Gemini (Web)"`, `badgeLabel: "Gemini"`, `byok: false`, `capabilities.supportsCancel: true`, `capabilities.supportsStreaming: true`, `capabilities.reasoningLevels: ["low", "medium", "high"]`, `permissionModes: ["full"]`, `defaultPermissionMode: "full"`), а также регистрирует `acp-argon` как алиас обратной совместимости.
   - Передаёт в `experimental_bridgeOptions` команду запуска `acp-server.mjs`:
     - по умолчанию — встроенный `acp-server.mjs` из каталога плагина (`import.meta.url`);
     - при заданном `WEB_GEMINI_DIR` / `ARGON_DIR` (или наличии внешнего рабочего каталога `~/.local/share/web-gemini/acp-server.mjs`, фолбэк `~/.local/share/argon-gemini/acp-server.mjs`) — внешний скрипт, если не задан `WEB_GEMINI_USE_BUNDLED=1` / `ARGON_USE_BUNDLED=1`.
2. **`acp-server.mjs`** — JSON-RPC 2.0 ACP-сервер (stdio):
   - Реализует методы `initialize`, `session/new`, `session/load`, `session/set_model`, `session/set_config_option`, `session/set_mode`, `session/prompt`, `session/cancel`.
   - Управляет пулом аккаунтов (`pool.json`), файлом состояния и аренд (`accounts-state.json`), классификацией ошибок, кулдаунами и автоматической ротацией аккаунтов при исчерпании лимита.
3. **`src/gemini-driver.js`** — CDP-драйвер веб-интерфейса `gemini.google.com` на базе `playwright` или `playwright-core` (драйвер пробует сначала `playwright`, затем `playwright-core`):
   - Подключается к запущенному headless Chrome по `http://127.0.0.1:<cdpPort>` или поднимает новый процесс Chrome с изолированным `--user-data-dir=<profileDir>`.
   - Выбирает режим мышления (`Fast`, `Thinking`, `Pro`), отправляет промпт, опрашивает текст ответа через `findTurnTarget`, отслеживает завершение генерации, извлекает `convId` беседы и паркует вкладку в простое.
4. **`src/usage-limits.js`** — модуль сбора лимитов Gemini Web (5h + weekly) через `batchexecute` RPC и ведения файла `accounts-usage.json` (§4.4).
5. **`src/profile-manager.js`, `bin/gemini.js`, `scripts/glogin.mjs`, `scripts/pool-add.mjs`** — CLI и утилиты управления профилями и интерактивного входа в аккаунты пула.

---

## 2. Протокол ACP (`acp-server.mjs`)

### 2.1 Инициализация и сессии

- **`initialize`** → возвращает `{ protocolVersion: params.protocolVersion ?? 1, agentInfo: { name: "web-gemini", version: "0.2.0" }, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } } }`. Возможность `agentCapabilities.loadSession: true` объявляется для всех сессий, включая обычный чат. Сборки до переименования PLUG-298 возвращали `name: "argon-gemini"` в `agentInfo`.
- **`session/new` и `session/load`**:
  - `session/new` проверяет постоянный журнал по доверенному BB-треду и отпечатку рабочей копии. Если найдена единственная подходящая запись и она прошла проверку, новый `sessionId` становится алиасом исходной сессии. При отсутствии совпадений создаётся новая сессия `{ id, cwd, roots, model, thinking, convId, account, backend }`. Неоднозначный результат или отказ проверки найденной записи дают ошибку `not_started`.
  - Рабочие корни сессии для файловых вложений (PLUG-291): параметры `additionalDirectories`/`roots` (строки путей или объекты `{ uri: "file://…" }`) сохраняются в `s.roots` и вместе с `s.cwd` задают каталоги, из которых разрешена отправка локальных файлов в Gemini (§2.2 п.3, §2.4).
  - `sessionId` генерируется глобально уникальным в формате `web-gemini-<pid>-<base36-метка-времени>-<счётчик>` (PLUG-284): счётчик только в памяти процесса давал коллизии между параллельными процессами провайдера и после рестартов — bb отказывал в resume с HTTP 409. Сгенерированный id дублируется в `sessions` алиасом `argon-<pid>-<base36-метка-времени>-<счётчик>` для обратной совместимости. Формат строки свободный, внешние потребители его не парсят.
  - `session/load` возвращает живую сессию без журнальной записи из памяти процесса. Для остальных переданных `sessionId` сервер ищет исходный ID или алиас в постоянном журнале (`findSessionRecord`) и проверяет владельца, каталог, права и срок хранения. Неизвестный `sessionId` завершает вызов ошибкой `not_started` с сообщением `unknown saved session`. Порядок хранения и восстановления описан в [§7.2 «Постоянное состояние»](provider-web-gemini-inner-agent.md#72-постоянное-состояние) и [§7.3 «Продолжай» и повторная доставка](provider-web-gemini-inner-agent.md#73-продолжай-и-повторная-доставка).
  - Возвращают список моделей `models.availableModels` в виде объектов `{ modelId, name }` по схеме ACP:
    - `'neon'` — «Gemini 4 Neon» («4 Neon» / «Deeper analysis» / «Глубокий анализ», модель по умолчанию). UI-слот ранее назывался «Argon» («Gemini 4 Argon»): в BB каноническое имя — `neon`, а `argon` сохраняется псевдонимом обратной совместимости (`resolveModelId('argon') → 'neon'`);
    - `'carbon'` — «Gemini 4 Carbon» («4 Carbon» / «Code & complex work» / «Самые сложные задачи», тариф Ultra);
    - `'hydrogen'` — «Gemini 4 Hydrogen» («4 Hydrogen» / «Повседневные дела»);
    - `'pro'` — «Gemini 3.1 Pro» (Исследования);
    - `'flash-lite'` — «Gemini 3.5 Flash-Lite» (Быстрые ответы).
  - Возвращают конфигурационные опции `configOptions`:
    - `model` (категория `"model"`): выбор модели из списка `MODELS` (`neon`, `carbon`, `hydrogen`, `pro`, `flash-lite`), отфильтрованного по совместимости с выбранным аккаунтом (см. предикат `supported` ниже): при явном `s.account` — только модели, поддерживаемые этим аккаунтом; при `s.account === "auto"` — объединение: модель видна, если её поддерживает хотя бы один аккаунт пула (например, `carbon` видна только при наличии незалоченного Ultra-аккаунта);
    - `thought_level` (категория `"thought_level"`): значения `low` / `medium` / `high`, синхронизированные с `capabilities.reasoningLevels` BB (`Low`, `Medium`, `High`);
    - `account` (категория `"account"`, возвращается при наличии более одного аккаунта в пуле): `"auto"` плюс только те аккаунты, которые поддерживают текущую `s.model`; `currentValue` — `s.account`, если он поддерживает `s.model`; иначе единственный поддерживающий аккаунт (правило single-capable); иначе `"auto"`.
  Все опции принимаются и обрабатываются в `session/set_config_option`.
- **Совместимость модели и аккаунта (предикат `supported(model, account)`, PLUG-280)** — зеркало рантайм-проверок `pickBackendFromState`/`bindBackend` (§3): модель поддерживается аккаунтом, если её нет в `accounts-state.json → accounts[<id>].lockedModels` и не выполняется условие `model === "carbon" && tier(account) !== "ultra"` (эффективный тир — `getAccountTier`: `lockedModels` с `carbon` понижает аккаунт до `pro`). Фильтрация двунаправленная и работает только на уровне селекторов: явные ошибки тира/лока в `bindBackend` остаются страховкой под ней. При несовместимости намерением считается только что выбранное значение, а вторая ось откатывается к дефолту:
  - при смене модели (`session/set_model` или `set_config_option` `model`), если явно выбранный `s.account` не поддерживает новую модель, `s.account` сбрасывается в `"auto"` с тем же сбросом `s.backend = null` и `s.convId = null`, что и при смене аккаунта (auto сроутирует на совместимый аккаунт);
  - при смене аккаунта (`set_config_option` `account`), если `s.model` не поддерживается новым аккаунтом, `s.model` сбрасывается в `"neon"` (дефолт).
- **`session/set_model`** — меняет `s.model` через `resolveModelId`; `s.thinking` не изменяет — при незаданном уровне подставляется `medium`; применяет сброс несовместимого аккаунта (см. выше).
- **`session/set_config_option`**:
  - при `configId === "thought_level"` (или `configId === "thinking"`) обновляет уровень мышления `s.thinking`: `"low"` → `"low"`, `"medium"` → `"medium"`, `"high"` → `"high"`, не затрагивая выбранную модель `s.model`;
  - при `configId === "model"` обновляет `s.model` через `resolveModelId` до одного из `neon`, `carbon`, `hydrogen`, `pro`, `flash-lite` (псевдонимы `argon` → `neon`, `fast`/`flash`/`lite` → `flash-lite`); неизвестное значение — ошибка -32602 `unknown model`; применяет сброс несовместимого аккаунта (см. выше);
  - при `configId === "account"` обновляет `s.account` (`"auto"` или id аккаунта); при смене аккаунта сбрасывает `s.backend = null` и `s.convId = null`; применяет сброс несовместимой модели в `"neon"` (см. выше).
- **Передача в веб-драйвер**:
  - В драйвер передаётся `model: s.model` (`"neon"` передаётся как есть, без подмены на `"thinking"`, чтобы селектор модели не искал несуществующую модель).
  - Уровни размышлений в UI и словаре драйвера — строго `low` / `medium` / `high` (и их русские аналоги «низкий» / «средний» / «высокий»). Сервер ACP нормализует значение `s.thinking` перед передачей в `sendPrompt`:
    - `"fast"` или `"low"` → `"low"`;
    - `"thinking"` или `"medium"` → `"medium"`;
    - `"pro"` или `"high"` → `"high"`.

### 2.2 Стриминг ответа и отмена (`session/prompt`, `session/cancel`)

- На каждый вызов `session/prompt`:
  1. Текстовые блоки из `params.prompt` склеиваются в строку `text`; при пустом тексте немедленно возвращается `{ stopReason: "end_turn" }`.
     - **Вырезание bb-контекста (PLUG-285):** текст-блоки, чей текст начинается с `<system_instructions>` (с учётом ведущих пробелов; агентский контекст bb — инструкции плагинов, манифест инструментов, навыки), целиком отбрасываются до склейки; упоминание метки в середине пользовательского текста и не-text блоки не затрагиваются. Без этого веб-Gemini читал обвязку как «нет инструментов и сети» и отказывался работать.
  2. **Гард размера промпта (PLUG-281) и перелив текста в файл (r22):** `Buffer.byteLength(text)` сверяется с лимитом `WEB_GEMINI_MAX_PROMPT_BYTES` / `ARGON_MAX_PROMPT_BYTES` (см. §4.1).
     - **Превышение → перелив, а не ошибка (r22):** если текст превышает лимит, весь исходный текст атомарно (tmp + rename) пишется в `uploads/pkg-<sessionId>-prompt-<ts>.md` внутри каталога состояния и уходит веб-вложением тем же `session/prompt` (сверх лимитов пользовательских файлов, как spill-пакет §2.4); в тексте остаётся короткое сообщение вида `[Задача передана файлом-вложением «pkg-…-prompt-….md» — изучи его целиком и выполни.]` плюс, при наличии, системная шапка инструментов первого сообщения. Это действует и на первом ходе (новый `convId`, до `packFirstMessage` — перелитый текст задачи сам становится материалом), и на продолжениях разговора (`s.convId`, текст иначе шёл бы «как есть»). Ошибка записи файла — возврат к прежнему поведению: JSON-RPC error `-32000` с сообщением `prompt too large: <N> bytes exceeds limit <L> bytes (WEB_GEMINI_MAX_PROMPT_BYTES). Shrink the request and retry.`
     - **Текст ≤ лимита** — без изменений; любой путь, где итоговое сообщение для вставки в textbox всё же превысило лимит (внутренние отправки tool-loop и т.п.), по-прежнему защищён `promptTooLargeError` на стороне драйвера.
     - Ошибка/перелив — синхронно в `dispatch`/`enqueue`, до выбора аккаунта и аренды: пул, аренды и кулдауны не затрагиваются. Перелитый файл — пользовательский контекст задачи, маскировка не применяется (как и к самому тексту; правила маскировки касаются материалов, собираемых провайдером — §2.4, provider-web-gemini-tools.md §§5–6).
  3. **Валидация файлов-вложений (PLUG-291):** `collectUploadFiles` синхронно собирает из `params.prompt` локальные файлы — `resource_link` с `uri` вида `file://<abs-path>` и блоки `image`/`localFile`/`localImage` с полем `path` — и проверяет каждый по корням сессии, чёрному списку чувствительных файлов и лимитам (полный контракт — §2.4). Ошибка — JSON-RPC `-32602` с текстом причины (`upload file not found`, `outside session roots`, `denied to sensitive file`, `too large`, `too many upload files`), синхронно в `dispatch`, до `enqueue`, выбора аккаунта и аренды — ошибка вызывающего, аккаунт не трогается.
  4. При `WEB_GEMINI_FAKE=1` (алиас `ARGON_FAKE=1`) сервер отправляет нотификацию `session/update` (`sessionUpdate: "agent_message_chunk"`, `text: "FAKE_WEB_GEMINI_ECHO: " + text.slice(0, 80)`). Если задана задержка `process.env.WEB_GEMINI_FAKE_DELAY_MS` / `ARGON_FAKE_DELAY_MS`, генерация удерживает аренду в течение этой паузы для проверки отмены и корректного завершения. По завершении возвращает `{ stopReason: "end_turn" }`.
  5. В боевом режиме выбирается аккаунт из пула (§3), захватывается аренда через `bindBackend` / `acquireInState`, и драйвер вызывает `sendPrompt` с единым объектом параметров: `{ prompt: text, model: s.model, thinking: mappedThinking, convId: s.convId, isNewChat: !s.convId, cdpPort: backend.cdp, strictModel: true, shouldCancel: () => s.cancelled || abortCtrl.signal.aborted || s.activeGen !== gen, headless: HEADLESS, profile: backend.profileDir || backend.profile || backend.id, strict: true, onChunk, signal: abortCtrl.signal, files, sessionId, downloadsDir }`, где `files` — провалидированные пользовательские файлы и сгенерированные провайдером веб-вложения — spill-пакет материалов `pkg-<sessionId>-<ts>.md` (§2.4) и файл перелива промпта `pkg-<sessionId>-prompt-<ts>.md` (§2.2 п.2), а `downloadsDir` — каталог `downloads` в каталоге состояния (`WEB_GEMINI_STATE_DIR` / `ARGON_STATE_DIR`) для сгенерированных файлов ответа (§4.5).
  6. Каждая дельта `onChunk(delta)` немедленно отправляется нотификацией `session/update` с `sessionUpdate: "agent_message_chunk"`.
  7. После завершения генерации `s.convId` извлекается из `res.convId` (драйвер самостоятельно читает URL вкладки и возвращает `convId` в объекте результата), аренда освобождается (`releaseLease`), и возвращается `{ stopReason: "end_turn" }`. Каждый скачанный файл из `res.files` возвращается нотификацией `agent_message_chunk` с блоком `resource_link` (`uri: file://<abs-path>` через `pathToFileURL`, `name`, `mimeType`), после цикла — видимая текстовая сводка `Файлы Gemini: [name](file://…)`; пропущенные файлы `res.skippedDownloads` — текстовым чанком `[Файл Gemini пропущен: <name> — <reason>]`, ход не падает. Список файлов дополнительно кладётся в vendor-поле `result.attachments` ответа `session/prompt` (нестандартное расширение ACP, безвредно).
- **Цикл выполнения инструментов (Tool Loop)**:
  - Полный контракт вызовов, формата упаковки, каталога инструментов и лимитов зафиксирован в [provider-web-gemini-tools.md](provider-web-gemini-tools.md).
  - При первом отправлении на новом `convId` текст сообщения пакуется функцией `packFirstMessage`: формируется системная шапка с каталогом доступных инструментов, автоматические вложения обнаруженных ссылок (`=== file: ... ===`, `=== thread: ... ===`, `=== task: ... ===`) и доступный статус/дифф репозитория (`git status`, `git diff`) в пределах лимита `WEB_GEMINI_MAX_MESSAGE_BYTES` / `ARGON_MAX_MESSAGE_BYTES` (по умолчанию 120 000 байт). При переполнении весь пакет материалов переливается в файл-вложение `pkg-<sessionId>-<ts>.md` (PLUG-291, §2.4); при неудаче записи файла — прежнее вытеснение с подсказкой `Можно запросить инструментом: ...`.
  - Ответ модели разбирается на XML-теги вызова инструментов `<tool name="..." .../>`.
  - Инструменты выполняются только на чтение в пределах рабочей директории сессии (`cwd`), с проверкой `resolveInCwd`, запретом `..`, симлинков наружу и черным списком секретных файлов (`.env*`, `secrets/*`, `*.pem`, `*.key`).
  - Результаты инструментов форматируются блоками `=== tool: <name> <args> ===` и отправляются единым следующим сообщением в том же `convId` на том же бэкенде под той же активной арендой.
  - Количество раундов ограничено `WEB_GEMINI_MAX_TOOL_ROUNDS` / `ARGON_MAX_TOOL_ROUNDS` (по умолчанию 8 раундов). При исчерпании лимита модель принудительно запрашивается сформировать финальный ответ на базе уже полученных данных.
  - Промежуточные вызовы транслируются в тред BB через нотификации протокола ACP: `session/update` с блоками `tool_call` и последующим обновлением статуса `tool_call_update`.
- При получении **`session/cancel`** (как нотификации, так и запроса):
  - отмена инициируется только для сессии, чей `id === params.sessionId`: если `activePromptSessionId === s.id`, вызывается `activePrompt.abort.abort()` (сессии с неизвестным `sessionId` или без него не прерывают чужой активный ход);
  - драйвер перед выходом из `sendPrompt` кликает по кнопке остановки генерации в веб-интерфейсе Gemini (тот же полный набор селекторов stop-кнопки, что у `hasStopButton` в §4.2: `button[aria-label*="Stop" i]`, `button[aria-label*="Остановить" i]`, `button[aria-label*="Прекратить" i]`, `button[data-test-id="stop-button"]`, `button[data-test-id*="stop" i]`, `.stop-button`), чтобы браузерная вкладка немедленно прекратила генерацию;
  - `session/prompt` завершается со `{ stopReason: "cancelled" }` без пометки аккаунта кулдауном.
- При закрытии `stdin` (`rl.on("close")`), а также по сигналам `SIGTERM` и `SIGINT`, `acp-server.mjs` прерывает активный ход (`activePrompt?.abort.abort()`), ожидает завершения вызова драйвера (срабатывание Stop и парковка вкладки на `about:blank`) с таймаутом до 10–15 с, дожидается `releaseLease(activeBackendId)` и только затем завершает процесс. Это гарантирует отсутствие осиротевших аренд и остановку генерации в браузере.
- **Жизненный цикл процесса и сторожа**:
  - Журнал этапов: `slog(stage, extra)` дописывает строки вида `<ISO-ts> pid=<pid> <stage> <json>` в `acp-server.log` в каталоге состояния (`WEB_GEMINI_STATE_DIR` / `ARGON_STATE_DIR`) — по нему видна точная стадия зависшего или тихого хода (постановка в очередь, аренда, вызов драйвера, стриминг, ошибки).
  - Реапер сирот (только Linux): `reapOrphanAcpServers()` вызывается при старте сервера (`startServer`), сканирует `/proc` и шлёт `SIGTERM` другим процессам `acp-server.mjs` с `ppid == 1` (перерождённым на init), чтобы старые копии не держали профили Chrome и аренды.
  - Уборка управляемых групп браузера (PLUG-374): `reapOrphanBrowserGroups()` вызывается при старте сервера (`startServer`) и периодически каждые 60 секунд (каждые 12 тиков 5-секундного таймера `ppidWatch`), убирая осиротевшие группы Chrome/Xvfb (§8). При штатном выходе `cleanShutdown()` вызывает `cleanupOwnBrowserGroups()`, которая убирает свои группы (`ownerPid === process.pid`), если на порту нет чужой активной аренды или внешних CDP-клиентов (собственные playwright-сокеты процесса исключаются через `socketInodesOf(process.pid)`).
  - Сторож родителя: таймер каждые 5 с сравнивает `process.ppid` с захваченным при старте `ownerPpid`; при смене родителя или `ppid === 1` (reparenting на init — родительский мост BB умер) пишет `process:reparented-exit` и вызывает `cleanShutdown()`. Таймер `unref`-нут и сам по себе процесс не держит.
  - Выход по смене кода: в том же 5-секундном цикле, когда нет активного хода (`!activePromptSessionId`), `checkStaleCode()` сравнивает `mtime` файла `acp-server.mjs` с зафиксированным при старте; обновление файла (новая версия плагина) → `server:stale-code-exit` и `cleanShutdown()` — процесс не продолжает работать на устаревшем коде и перезапускается мостом на следующем ходе.

### 2.3 Дедлайны и переменные окружения генерации

Все переменные окружения `ARGON_*` после переименования провайдера (PLUG-298) принимаются под целевыми именами `WEB_GEMINI_*`; прежние `ARGON_*` продолжают работать как фолбэк обратной совместимости (новое имя имеет приоритет).

- Фазовый дедлайн хода в `acp-server.mjs` (PLUG-371): `SEND_DEADLINE_MS = Number(process.env.WEB_GEMINI_SEND_DEADLINE_MS || process.env.ARGON_SEND_DEADLINE_MS) || 1_200_000` (20 минут) применяется к **негенерационным** стадиям хода (collect/delivery/verify/commit) и одновременно служит фазовым бюджетом авторетрая стола. При входе задачи в стадию `generation` дедлайн поднимается до `sessionCapAt`; при выходе из генерации и входе в `verify`/`commit` окно возвращается к `min(now + SEND_DEADLINE_MS, sessionCapAt)`. Перевзвод дедлайна выполняется **только при смене стадии** — повторный heartbeat той же стадии окно не сдвигает (`armAttemptDeadline` подписан на `task.onDeadlineChange` и перевзводит `deadlineTimer`, снимая подписку после `Promise.race`).
- Абсолютный потолок длительности хода и цикла генерации: `SESSION_CAP_MS = Number(process.env.WEB_GEMINI_SESSION_CAP_MS || process.env.ARGON_SESSION_CAP_MS)` при `> 0`, иначе `4 * 3600_000` (4 часа). Пока у генерации есть прогресс, `SEND_DEADLINE_MS` к ней не применяется — медленные модели (`carbon`) могут рассуждать часами; цикл драйвера ограничен `while (Date.now() - streamStartTime < SESSION_CAP_MS)`.
- Детект стола генерации в `src/gemini-driver.js` (PLUG-371, PLUG-407): вычисление `STALL_MS`: если передан явный валидный параметр вызова (`stallMs != null` и `Number.isFinite(Number(stallMs)) && Number(stallMs) > 0`), используется он (`STALL_MS = Number(stallMs)` — тесты драйвера могут задавать короткие пороги без искусственных нижних границ); при невалидном (`NaN`, `<= 0`) или не переданном параметре берётся базовая задержка из окружения `const envStall = Number(process.env.WEB_GEMINI_STALL_MS || process.env.ARGON_STALL_MS); const baseStall = Number.isFinite(envStall) && envStall > 0 ? envStall : 120_000`. При отсутствии валидного явного `stallMs`, для `thinking: "high"` нижняя граница `STALL_MS` составляет `Math.max(baseStall, 600_000)` (10 минут), если переменная окружения не задаёт больше. При `isGenerating` (видимый stop-button/busy) или потере target без контента (`lostWithoutContent`), а также при `awaitingContent` (стоп-кнопка ушла, но готового контента нет) отсутствие прогресса дольше `STALL_MS` бросает `generation stalled — no progress for <n>s` с кодом `WEB_GEMINI_STALLED` — классификация `transient`, `rotatable` (§3.4).
- **Диалоги страницы — только по белому списку и с журналом (PLUG-408, 24.11).** `dismissOverlays` закрывает только известные диалоги.
  - *Признак диалога:* видимый `mat-dialog-container` или `[role="dialog"]`. Меню (`[role="menu"]`, `mat-menu-panel`) и всплывающие подсказки (`[role="tooltip"]`) диалогами не являются и не трогаются.
  - *Белый список:*
    1. Стена согласия Google («Before you continue» / «До того как продолжить»): нажатие Reject all / Accept all / I agree / Согласен.
    2. Баннер «Использовать Gemini» («Use Gemini» / «Использовать Gemini»): нажатие кнопки согласия.
    3. Предложение платного тарифа (текст «Сменить план» / «Change plan» / «/ мес» / «/month»): закрытие через отрицательную кнопку («Не сейчас» / «Not now» / «No thanks» / «Maybe later»).
  - *Запрет слепых кликов:* общие кнопки («Stay signed out», «Не входить в аккаунт», «No thanks», «Не сейчас», «Спасибо, не надо», «Dismiss», «Got it», «Понятно», «Done», «Готово», «Continue», «Продолжить») без распознанного текста диалога из белого списка не нажимаются. Слепое нажатие Escape на оставшемся backdrop без опознанного диалога запрещено.
  - *Журнал:* каждый закрытый диалог пишется в `acp-server.log` событием `driver:dialog` с аккаунтом, первыми 300 символами текста диалога и нажатой кнопкой.
  - *Неизвестный диалог:* обнаружение видимого диалога вне белого списка немедленно останавливает ход с ошибкой `WEB_GEMINI_UNKNOWN_DIALOG`. Скриншот диалога сохраняется: в каталог хода `inner-agent/turns/<sess>/turn-N/` (для inner-agent) либо в `$STATE_DIR/screenshots/` (для обычной сессии). В §3.4 ошибка относится к категории `unknown-dialog` (`rotatable: true`, `parkedReason: "unknown-dialog"`, кулдаун 1 час). Повод: 24.11 с ~02:40 на нескольких аккаунтах появились диалоги (click timeout на `mat-dialog-content` / `cdk-overlay-backdrop`), а драйвер нажимал общие «отказные» кнопки вслепую. После этого поиск в ответах пропал на всех аккаунтах, в том числе при ручном вопросе в тех же профилях.
- При клике по аккордеону `model-thoughts` (разворачивание для чтения мыслей в §2.5) изменение структуры `model-thoughts` исключается из сигнатуры `domSig`, чтобы не создавать ложный признак прогресса для детектора стола.
- **Мышление и поиск — это прогресс (PLUG-407, 24.11).** Пока видна stop-кнопка, признаком жизни хода, кроме роста текста и изменения сигнатуры DOM цели, считается активный индикатор мышления или инструмента Gemini, возвращаемый `checkTurnStatus(doc, idx, promptPrefix)` в поле `hasActiveThinkingOrTool`.
  - *Целевой ответ и единый контракт с fallback на `<pending-response>`:* индекс `idx` всегда строго адресует `model-response[idx]`, а `initialCount` вычисляется исключительно по числу `<model-response>` (число завершённых ответов в истории). Если `model-response[idx]` ещё отсутствует в DOM (фаза ранних рассуждений/поиска до рендера контейнера ответа), `findTurnTarget` ищет последний `<pending-response>`, следующий в DOM строго после `lastQuery` пользователя с проверенным префиксом промпта. Такой `<pending-response>` временно выступает целью хода (`target`) на время мышления/поиска. Старые узлы `<pending-response>`, оставшиеся от предыдущих ходов до `lastQuery`, в выборку не попадают и никогда не сдвигают индекс `idx`.
  - *Единый словарь селекторов и ключевых фраз:*
    - Элементы статуса и инструментов: `thinking-overlay`, `.thinking-container`, `.animated-thinking-content`, `.tool-status`, `[role="status"]`, `.status-container`, `.gpi-static-text-loader`.
    - Ключевые фразы статуса (при сопоставлении многоточия «…» и «...» нормализуются): `"Searching the web"`, `"Ищу в интернете"`, `"Поиск в интернете"`, `"Thinking..."`, `"Думаю..."`.
  - *Строгая изоляция контента ответа:* поддеревья `message-content` (текст ответа) и `model-thoughts` (аккордеон мыслей) **строго исключаются** из всех проверок `hasActiveThinkingOrTool` — как из поиска элементов по селекторам, так и из проверки текста. Фразы вроде «Поиск в интернете показал...» внутри тела ответа не считаются статусом инструмента.
  - *Точный критерий активности и признака прогресса:*
    - Обычные спиннеры (`mat-spinner`, `mat-progress-bar`, `[aria-busy="true"]`, `.spinner` и другие селекторы `busySelector`) определяют исключительно флаг активности хода `isBusyOrThinking` -> `isGenerating = true`. Они запускают и продолжают отсчёт таймера стола, но **не** являются признаком прогресса и **не** входят в `hasActiveThinkingOrTool`. Зависший ход с бесконечным спиннером и видимой stop-кнопкой штатно падает по таймауту `STALL_MS` (сохранение контракта PLUG-371).
    - В `hasActiveThinkingOrTool` входят **только подтверждённые формы рассуждений и работы инструментов** (`checkTurnStatus` возвращает `{ hasActiveThinkingOrTool, statusText }`, где `statusText` — склеенный через пробел в порядке DOM нормализованный текст статусных элементов либо `null`):
      1. Наличие подтверждённого активного слоя анимации внутри цели: `.animated-thinking-content` с непустым текстовым содержимым (например, со `span` внутри `thinking-overlay` или `.thinking-container`), строго вне `message-content` и `model-thoughts` **и строго до начала ответа** (`!hasFinishedContent`). Как только начался стриминг ответа (`hasFinishedContent === true`), прогресс отслеживается исключительно по росту текста ответа и смене `domSig`. Сам по себе контейнер `thinking-overlay` или `.thinking-container` без дочернего `.animated-thinking-content` признаком прогресса по присутствию **не** является.
      2. Присутствие ключевых фраз статуса («Searching the web», «Ищу в интернете», «Поиск в интернете», «Thinking...», «Думаю...») признаётся прогрессом по присутствию **только** внутри `.animated-thinking-content` или `.tool-status` (и также строго при `!hasFinishedContent`).
      3. В остальных контейнерах статуса (`thinking-overlay`, `.thinking-container`, `[role="status"]`, `.status-container`, `.gpi-static-text-loader`) смена текста между тиками опроса фиксируется через `statusText` в `domSig`. Статичное присутствие этих контейнеров без смены текста признаком прогресса не является.
  - *Продление дедлайна стола строго при видимой stop-кнопке и защита перехода в domSig:*
    Отсчёт таймера стола сбрасывается (`lastProgressTime = Date.now()`) на тике опроса **строго при условии `hasStopButton && hasActiveThinkingOrTool`**. Внимание: если stop-кнопка исчезла (включая стадию `awaitingContent` — генерация прекратилась, но готовый ответ отсутствует) либо цель хода потеряна (`!status.targetFound`), индикатор мышления/инструмента стол **НЕ продлевает**! Зависший ход без stop-кнопки или без контента гарантированно падает по `STALL_MS`, предотвращая 4-часовое зависание аккаунта.
    Состояние индикатора и текст статуса включаются в сигнатуру `domSig` (`${Boolean(effectiveStatus.hasActiveThinkingOrTool)}:${effectiveStatus.statusText ?? ''}`): когда фаза мышления завершается и индикатор исчезает, смена `domSig` фиксирует прогресс перехода и однократно обновляет `lastProgressTime`, гарантируя, что ход не получит ложный стол на первом же тике после перехода к стримингу ответа.
  - *Статичные формы (не являются непрерывным прогрессом):* статичный аккордеон `model-thoughts` без активной анимации или статично отрисованные карточки источников; их появление фиксируется разовой сменой DOM-сигнатуры цели, но в статичном состоянии таймер стола отсчитывается штатно до `STALL_MS`.
  - *Связь с авторетраем стола (осознанное проектное решение):* по правилу авторетрая (PLUG-371), повтор хода возможен только при остатке бюджета `> 25%` от `SEND_DEADLINE_MS` (при дефолтных 20 минутах — строго до 15-й минуты хода). При `STALL_MS = 10 мин` для `thinking: "high"`, если ход зависнет после 5-й минуты, стол наступит после 15-й минуты, когда остаток бюджета `<= 25%` — в этом случае авторетрай не запустится, и ход завершится ошибкой `stalled`. Это осознанный компромисс: для глубоких аналитических запросов приоритетом является предоставление модели полного времени на рассуждения и поиск (до 10 минут тишины), а не быстрый сброс на ретрай.
  - *Повод:* 24.11 Neon на чистом research-пакете показывал «Searching the web» внутри `thinking-overlay`, а прежний детектор через 120 с останавливал генерацию и инициировал авторетрай на другой аккаунт; аналогично падал релиз-аудит #1998.
  - *Приёмка:* тесты на уровне драйвера через `_setDriverHooks` в `tests/provider-web-gemini.test.mjs` (с исполнением реального `checkTurnStatus(doc, idx, promptPrefix)` на mock-DOM):
    1. Активный `.animated-thinking-content` с непустым текстом («Searching the web») при видимой stop-кнопке без изменения текста ответа — `hasActiveThinkingOrTool` истинен, ход не падает по `stalled`.
    2. Отрицательный тест обычного спиннера: наличие `mat-spinner` / `[aria-busy="true"]` без `.animated-thinking-content` и без роста текста при видимой stop-кнопке — штатно бросает `stalled` по истечении `STALL_MS`.
    3. Отрицательный тест отсутствия stop-кнопки (`awaitingContent`): в цели есть `.animated-thinking-content`, но stop-кнопка отсутствует (`hasStopButton === false`) и контент пуст — штатно бросает `stalled` по истечении `STALL_MS` (индикатор не продлевает стол без stop-кнопки).
    4. Отрицательный тест статичного контейнера: наличие `thinking-overlay > .thinking-container` без `.animated-thinking-content` и без смены текста при видимой stop-кнопке — штатно бросает `stalled` по истечении `STALL_MS`.
    5. Отрицательный тест статичных мыслей: статичный `model-thoughts` без активной анимации при отсутствии роста текста — штатно бросает `stalled` по истечении `STALL_MS`.
    6. Отрицательный тест изоляции контента: фраза «Поиск в интернете» внутри `message-content` без изменения текста при видимой stop-кнопке — штатно бросает `stalled` по истечении `STALL_MS` (`message-content` исключён из детектора статуса).
    7. Приоритет `model-response` над `pending-response` и изоляция старых pending: (а) если в DOM одновременно присутствуют и `model-response[idx]`, и `<pending-response>`, целью безусловно выбирается `model-response`; (б) старый узел `<pending-response>` до `lastQuery` не сдвигает индекс нового ответа `model-response[idx]`; (в) ход стартует с целью `<pending-response>` с `.animated-thinking-content` (цель найдена, стола нет), затем переходит в `<model-response>` со стримингом в `message-content` и успешно завершается (`passed`), а текст извлекается из `model-response`.
    8. Корректность вычисления `STALL_MS`: валидный явный `stallMs` принимается без ограничений; невалидный/отрицательный `stallMs` откатывается к базовому (`env || 120_000`); для `thinking: "high"` без явного `stallMs` нижняя граница составляет 600 000 мс.
    9. Живьём — research-запрос на `neon` через провайдер BB завершается с первичными ссылками и без `WEB_GEMINI_STALLED` в `acp-server.log`; выполняется снятие DOM цели во время фазы «Searching the web» (включая подтверждение наличия кнопки Stop) и после начала стрима для фиксации живой структуры.
- Авторетрай стола в рамках хода (PLUG-371): при `stalled` `runPrompt` делает **один** повтор, если остаётся `> 25%` фазового бюджета `SEND_DEADLINE_MS`; перед повтором `excludeBackendId = backend.id` — `pickBackendFromState` выбирает свободного соседа по пулу, при отсутствии соседа (`r.none`) допускается возврат на тот же аккаунт (`allowSameBackend`). При установленном `s.convId` (2+ раунд tool-loop) ретрай не запускается; без бюджета исход хода — `failed` с `reason: "stalled"`.
- Прежний внутренний потолок ожидания генерации `MAX_WAIT_MS`/`GEMINI_MAX_WAIT_MS` из `src/gemini-driver.js` удалён (PLUG-371): его роль выполняют `STALL_MS` (отсутствие прогресса) и `SESSION_CAP_MS` (абсолютный потолок).
- `WEB_GEMINI_MAX_TOOL_ROUNDS` / `ARGON_MAX_TOOL_ROUNDS`: максимальное количество раундов вызова инструментов за один ход (по умолчанию `8`).
- `WEB_GEMINI_MAX_MESSAGE_BYTES` / `ARGON_MAX_MESSAGE_BYTES`: максимальный размер первого упакованного сообщения (по умолчанию `120_000` байт).
- `WEB_GEMINI_TOOL_TIMEOUT_MS` / `ARGON_TOOL_TIMEOUT_MS`: таймаут выполнения каждого локального инструмента чтения (по умолчанию `15_000` мс / 15 с).
- `WEB_GEMINI_MAX_UPLOAD_COUNT` / `ARGON_MAX_UPLOAD_COUNT` и `WEB_GEMINI_MAX_UPLOAD_BYTES` / `ARGON_MAX_UPLOAD_BYTES`: лимиты пользовательских файлов-вложений за один `session/prompt` (по умолчанию `5` уникальных файлов / `25 МБ` на файл) (§2.4).
- `WEB_GEMINI_MAX_DOWNLOAD_COUNT` / `ARGON_MAX_DOWNLOAD_COUNT` и `WEB_GEMINI_MAX_DOWNLOAD_BYTES` / `ARGON_MAX_DOWNLOAD_BYTES`: лимиты скачивания сгенерированных Gemini файлов за один ответ (по умолчанию `5` файлов / `50 МБ` на файл) (§2.4, §4.5).
- `WEB_GEMINI_STABLE_DURATION_MS` / `ARGON_STABLE_DURATION_MS`: порог стабильности текста ответа для завершения хода при найденных action-кнопках завершённого ответа (по умолчанию `500` мс) (§4.2).
- `WEB_GEMINI_STABLE_NO_ACTIONS_MS` / `ARGON_STABLE_NO_ACTIONS_MS`: повышенный порог стабильности текста ответа, когда action-кнопки завершения не найдены (по умолчанию `5000` мс) (§4.2).

### 2.4 Веб-вложения файлов (PLUG-291)

Двунаправленный проброс файлов между BB и веб-сессией Gemini: приложенные пользователем файлы загружаются веб-аплоадером Gemini, файлы, сгенерированные моделью в ответе, скачиваются и возвращаются в тред BB как вложения.

- **Исходящие файлы (`session/prompt` → Gemini):**
  - Из блоков `params.prompt` собираются `resource_link` с `uri` вида `file://<abs-path>` и блоки `image`/`localFile`/`localImage` с полем `path`; относительный `path` резолвится от `s.cwd` сессии. URL и не-файловые ресурсы не загружаются; `file://` ссылки в текстовые материалы первого сообщения не эмбеддятся — файл идёт веб-вложением, дублирования содержимого в `insertText` нет. Блоки `resource` (embeddedContext) — не upload: их текст идёт во вложения `packFirstMessage` как раньше.
  - Валидация каждого пути: файл существует и является обычным файлом (не директория); `realpath` внутри корней сессии (`s.cwd` + `s.roots` из `additionalDirectories`/`roots`, §2.1) — закрыты и `..`, и симлинки наружу; не в чёрном списке `isSensitivePath` (`.env*`, `secrets/*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*` — тот же список, что у инструментов чтения, provider-web-gemini-tools.md §6.2); размер ≤ `WEB_GEMINI_MAX_UPLOAD_BYTES` / `ARGON_MAX_UPLOAD_BYTES`; суммарно уникальных файлов ≤ `WEB_GEMINI_MAX_UPLOAD_COUNT` / `ARGON_MAX_UPLOAD_COUNT` (дедупликация по `realpath` выполняется до проверки лимита — N блоков на один файл считаются одним файлом).
  - Валидные пути передаются в `sendPrompt({ files })` и прикладываются через веб-аплоадер Gemini до вставки текста (§4.5); при ротации на новый чат файлы прикладываются заново на первой отправке попытки.
- **Перелив большого пакета материалов в файл:** если первое упакованное сообщение превышает `WEB_GEMINI_MAX_MESSAGE_BYTES` / `ARGON_MAX_MESSAGE_BYTES` (материалы не уложились в лимит), весь пакет блоков-материалов атомарно пишется в `uploads/pkg-<sessionId>-<ts>.md` внутри каталога состояния (`WEB_GEMINI_STATE_DIR` / `ARGON_STATE_DIR`) и уходит тем же веб-вложением; в тексте промпта остаются шапка, задача и пометка о вложении (provider-web-gemini-tools.md §5). Spill-файл идёт сверх `WEB_GEMINI_MAX_UPLOAD_COUNT`/`_BYTES` (фолбэки `ARGON_*`) — это сгенерированный провайдером пакет, обязательный к доставке. `WEB_GEMINI_MAX_MESSAGE_BYTES` / `ARGON_MAX_MESSAGE_BYTES` остаётся текстовым потолком textbox (гард PLUG-281 без изменений) — файл снимает лишь проблему перелива материалов.
- **Входящие файлы (Gemini → BB):** post-turn, пока DOM ответа текущего хода жив, драйвер скачивает сгенерированные файлы в `downloads/` каталога состояния (механика и белый список доменов — §4.5); браузер ради скачивания не поднимается. Формат возврата — `resource_link`-чанки + текстовая сводка + `result.attachments` (§2.2 п.7).
- **Каталоги и чистка:** `uploads/` и `downloads/` внутри каталога состояния (`WEB_GEMINI_STATE_DIR` / `ARGON_STATE_DIR`); при старте сервера `pruneDir` удаляет файлы старше 24 ч (`FILES_MAX_AGE_MS`) и оставляет не более 20 последних по mtime (`FILES_KEEP_COUNT`). Вся запись атомарная: временный файл `.tmp`/`.part` + `rename`.

---

### 2.5 Промежуточные шаги и рассуждения Gemini в BB (PLUG-409)

Во время хода Gemini Web показывает ход работы одной автообновляемой строкой статуса (например, «Searching the web», «Анализирую…», заголовок текущей мысли) и аккордеон мыслей `model-thoughts`. Сейчас провайдер отдаёт в BB только итоговый текст (`agent_message_chunk`), а промежуточные шаги теряются. Провайдер передаёт их в BB стандартными событиями ACP, отдельно от текста ответа.

1. **Строка статуса → `agent_thought_chunk`.** Каждое новое значение строки статуса внутри цели текущего хода (`statusText` из `checkTurnStatus`, PLUG-407) отправляется одной строкой. Повтор того же значения не отправляется. Опрос — в существующем цикле стриминга, без отдельного таймера.
2. **Мысли → `agent_thought_chunk`.** Текст `model-thoughts` текущего хода читается из DOM (если аккордеон свёрнут — разворачивается кликом только внутри цели текущего хода) или из ответа истории `hNvQHb`, если там он есть полнее. Отправляется только прирост к уже отправленному тексту (сравнение по префиксу, как у текста ответа). В текст ответа мысли не попадают, изоляция `message-content` / `model-thoughts` сохраняется.
3. **Поиск Google → `tool_call` / `tool_call_update`.**
   - *Источник данных:* ответ batchexecute RPC `hNvQHb` текущего хода, получаемый post-turn (после завершения ответа модели через in-page `fetch('/_/BardChatUi/data/batchexecute?rpcids=hNvQHb')` с параметрами `["c_" + convId, 10, null, 1, [1], [4, 12], null, 1]` либо из фонового сетевого перехвата; в тестах — фикстура `hnvqhbFixture`). Живой перехват `StreamGenerate` через CDP (`Network.dataReceived`) опционален.
   - *Структура ответа `hNvQHb`:* `respArr = data[0][0][3]`. Запросы поиска: `respArr[1]` (массив `[[query, 1], ...]` либо список строк). Статус инструмента поиска: `respArr[4]` или `respArr[5]` (значение `1` — начат, `4` — завершён). Источники выдачи: `cand[37][1][0][7]` (элементы вида `[favicon, url, title, ...]`). Перенаправляющие ссылки Google (`google.com/url?q=...`) разворачиваются до первичного целевого URL.
   - *События ACP:* на каждый запрос поиска отправляется `tool_call` (`kind: "search"`, заголовок `Google Search: <запрос>`, `status: "in_progress"`). При статусе инструмента `4` отправляется `tool_call_update` (`status: "completed"`) с содержимым: список источников выдачи (заголовок и URL). При post-turn разборе оба события отправляются последовательно в том же потоке.
   - *Журнал и блок ответа:* разбор пишет событие `driver:search` в `acp-server.log` (аккаунт, число запросов, итоговый статус, число источников; inner-agent §4.6 п.8) для всех типов ходов. Блок «Источники поиска» (`### Источники поиска\n* [Title](URL)`) добавляется в конец ответа BB **строго в режиме `research && !write`** (в пишущем режиме `write` блок не добавляется, чтобы не нарушать проверку закрытого блока кода файлового ответа §8.1).
4. **Журнал хода.** Отправленные мысли, статусы и вызовы поиска пишутся в `inner-agent/turns/<sess>/turn-N/thoughts.jsonl` (время, вид, текст). Cookies, токены и служебные идентификаторы Google не пишутся.
5. **Настройка.** `WEB_GEMINI_STREAM_THOUGHTS` (по умолчанию `1`); `0` отключает п.1–3, журнал п.4 остаётся.
6. **Не ломать существующее.** Стриминг текста ответа, детект стола (§2.3) и захват ответа (§4.2) не меняются; ошибка разбора мыслей или поиска не валит ход, а пишется в журнал `driver:thoughts-error`.

**Приёмка.** Тесты драйвера через `_setDriverHooks`: (а) последовательность строк статуса «Searching the web» → «Analyzing results» → «Searching the web» даёт 3 `agent_thought_chunk` без дублей подряд; (б) растущий `model-thoughts` даёт только приросты; мысли не попадают в `agent_message_chunk`; (в) фикстура `hNvQHb` с двумя запросами и статусом `4` даёт 2 `tool_call` и 2 `tool_call_update` со списком источников. Живьём: research-ход на `neon` через провайдер BB — в треде BB видны строки хода работы, мысли и карточки `Google Search` с источниками.

## 3. Пул аккаунтов, аренда, кулдауны и ротация

### 3.1 Конфигурация и файл состояния

- Пул аккаунтов читается функцией `loadBackends(stateDir, poolFile)`:
  - Основной источник — `WEB_GEMINI_POOL_FILE` / `ARGON_POOL_FILE` (по умолчанию `$STATE_DIR/pool.json`, где `STATE_DIR` — `WEB_GEMINI_STATE_DIR` / `ARGON_STATE_DIR`; дефолтный каталог `~/.bb/plugins/provider-web-gemini`, фолбэк `~/.bb/plugins/provider-argon` при отсутствии нового):
  ```json
  {
    "accounts": [
      { "id": "acc1", "email": "user1@example.com", "profileDir": "~/.gemini-cli-profile", "cdpPort": 9222, "priority": 10, "tier": "pro" },
      { "id": "acc2", "email": "user2@example.com", "profileDir": "~/.gemini-cli-profile-2", "cdpPort": 9223, "priority": 10, "tier": "ultra" }
    ]
  }
  ```
  Поле `tier` определяет тариф аккаунта:
  - `"ultra"` — тариф Ultra (доступна модель Carbon);
  - `"pro"` (по умолчанию) — обычный тариф Pro (модель Carbon недоступна / заблокирована значком замка).
  - Источники конфигурации пула перечисляются функцией `loadBackends` строго в порядке их чтения:
    1. `WEB_GEMINI_POOL_FILE` / `ARGON_POOL_FILE` (по умолчанию `$STATE_DIR/pool.json`);
    2. `$STATE_DIR/accounts/<label>/backend.json`;
    3. `~/.config/argon-acp/accounts/*/backend.json` (legacy fallback, только если пул пуст);
    4. `WEB_GEMINI_BACKENDS` / `ARGON_BACKENDS` (JSON-массив бэкендов из переменной окружения);
    5. Одиночный профиль по умолчанию: id: "default", profile: "default", profileDir из GEMINI_PROFILE_DIR / GEMINI_PROFILE или ~/.gemini-cli-profile; порт CDP из GEMINI_CDP_PORT или 9222.
  - Утилита `scripts/pool-add.mjs` актуализируется: при добавлении аккаунта она обновляет и `pool.json`, и подкаталог аккаунта.
  - Поле профиля, передаваемое в драйвер: `backend.profileDir || backend.profile || backend.id`. Тильда `~/` раскрывается через `os.homedir()` — **в домашний каталог читающего процесса**. Аккаунты с эффективным приоритетом `<= 0` (§3.3, `getAccountPriority`) исключаются из автоматического выбора.
  - **Разделяемый пул (несколько uid):** когда один `pool.json`/`STATE_DIR` читают процессы разных OS-пользователей, `profileDir` обязан быть **абсолютным** — `~` у второго юзера резолвится в его HOME, `resolveProfile` не совпадёт с реальным `--user-data-dir` запущенного Chrome (`profileMatches=false`). `scripts/pool-add.mjs` пишет `profileDir` абсолютным на момент добавления (дом добавившего = владелец профиля).
  - **`GEMINI_NO_AUTOSPAWN=1`** (env): при проверке профиля несовпадении (`profileMatches=false`) или холодном/чужом CDP драйвер **бросает ошибку до** `stopChrome`/авто-спауна Chrome, вместо перезапуска. Обязательно для второго юзера на разделяемом пуле — её процесс не имеет права трогать Chrome первого (чужие профили не рестартуются). Без флага драйвер пытается остановить и перезапустить браузер — допустимо только у владельца пула.
- Состояние хранится в `$STATE_DIR/accounts-state.json` (дефолтный `STATE_DIR` — `~/.bb/plugins/provider-web-gemini`, фолбэк `~/.bb/plugins/provider-argon`, если нового каталога нет). При разделении между uid'ами каталог общий: второму юзеру нужен default-ACL `rwx` на `STATE_DIR` и `accounts/` (аренды/состояние пишутся tmp+rename, inode меняется — прав нужно на каталог, не только на файлы).
- Любая модификация `accounts-state.json` выполняется через `withStateLock(fn)`:
  - захват эксклюзивного файла-замка `accounts-state.json.lock` (`O_CREAT | O_EXCL`);
  - если замок старше `LOCK_STALE_MS = 5000` мс — принудительное снятие устаревшего замка;
  - атомарная запись через временный файл `accounts-state.json.<pid>.<ts>.tmp` + `fs.renameSync`.

### 3.2 Аренда (`leases`) и защита от зависших замков

- Один процесс Chrome (`cdpPort`) в один момент времени обслуживает не более одного активного хода (`leases[backendId] = { pid, acquiredMs, cdp }`). Поле `cdp` фиксирует строковый номер CDP-порта группы браузера (`String(b.cdp)`), что позволяет не-ACP читателям (включая конвейер `teardownGroup` и `stopChrome` в драйвере через `leaseBusyOnPort`) проверять занятость порта активной арендой без отдельной загрузки конфигурации пула backends. При захвате аренды в `acquireInState` вызывается `browserGroups.adoptGroup(STATE_DIR, b.cdp)`, чтобы перезаписать `ownerPid` и `ownerStartTime` маркера группы на текущий активный процесс ACP, благодаря чему реапер видит живого проверяемого владельца.
- Пока идёт ход, аренда удерживаемого бэкенда периодически продлевается каждые 60 секунд (периодический таймер обновляет `acquiredMs: Date.now()`), что предотвращает истечение аренды во время длинных ходов (вплоть до `SESSION_CAP_MS = 4` часов).
- При чтении состояния просроченные аренды (`now - acquiredMs >= LEASE_TTL_MS`, где `LEASE_TTL_MS = 10 * 60_000`) и аренды мёртвых процессов (`!isPidAlive(pid)`) автоматически очищаются. Таймаут `LEASE_TTL_MS = 10` минут срабатывает только для зависших или аварийно завершившихся процессов.
- При закрытии `stdin` (`rl.on("close")`), а также по сигналам `SIGTERM` и `SIGINT`, `acp-server.mjs` прерывает активный ход (`activePrompt?.abort.abort()`), дожидается `releaseLease(activeBackendId)` и только затем завершает процесс. Это гарантирует отсутствие осиротевших аренд при перезапуске моста или отмене треда демоном BB.

### 3.3 Умная маршрутизация пула по тарифам и моделям

- Определение эффективного тарифа аккаунта (`getAccountTier(b, state)`):
  - если в состоянии аккаунта `lockedModels` содержит `"carbon"` — тариф строго `"pro"`;
  - иначе, если в состоянии `e.tier` явно задано `"ultra"` — тариф `"ultra"`;
  - иначе берётся `b.tier` из конфигурации пула (`"ultra"` или `"pro"`, по умолчанию `"pro"`).
- Определение эффективного приоритета аккаунта (`getAccountPriority(b, state)`) — порядок разрешения:
  1. `state.accounts[<id>].priority` из `accounts-state.json` — если это целое число `>= 0`;
  2. иначе `b.priority` из конфигурации пула (`pool.json` / `backend.json`) — если это целое число `>= 0`;
  3. иначе дефолт `10`.
  Приоритет из файла состояния важнее конфигурации пула: `e.priority = 0` в `accounts-state.json` отключает аккаунт из автоматического выбора, даже если запись в `pool.json` включена. Эффективный приоритет `<= 0` исключает аккаунт из автоматического выбора (§3.1).
- Выбор бэкенда в режиме `account: "auto"` (`pickBackendFromState`):
  - Из кандидатов исключаются: аккаунт `excludeId`, аккаунты с эффективным приоритетом `<= 0`, при запросе `carbon` — аккаунты с тарифом не `"ultra"`, при запросе любой модели — аккаунты, у которых `lockedModels` содержит эту модель. При загрузке `accounts-state.json` значения `lockedModels` нормализуются через `resolveModelId` (`argon` → `neon`), неизвестные значения сохраняются.
  - Среди **свободных** кандидатов (не в кулдауне и без аренды) сначала отбираются аккаунты с **максимальным эффективным приоритетом** (`maxP`) — фильтр по приоритету применяется ДО предпочтения по тарифу.
  - При запросе **`carbon`**: кандидатами являются **только** аккаунты с тарифом `"ultra"`. Аккаунты тарифа `"pro"` исключаются ещё на этапе фильтрации кандидатов.
  - При запросе **`neon`** (или других моделей): предпочтение тарифа **`"pro"`** действует **только среди свободных аккаунтов с равным максимальным приоритетом `maxP`** — чтобы приберечь Ultra-аккаунты для Carbon. Если свободных `pro`-аккаунтов с приоритетом `maxP` нет, выбирается `ultra`-аккаунт с тем же `maxP`; аккаунт с меньшим приоритетом не выбирается, пока есть свободный с `maxP`.
  - Внутри итогового набора выбор — LRU по `lastUsedMs` с тай-брейком по `id`.
  - Если свободных кандидатов нет, ближайшее время освобождения (`busyUntil` / `cooledUntil`) вычисляется только среди кандидатов с максимальным эффективным приоритетом.
- Ручной выбор аккаунта:
  - Если в сессии явно выбран конкретный аккаунт (`s.account !== "auto"`), а запрошена модель `carbon` на аккаунте с тарифом `"pro"`, `bindBackend` возвращает мгновенную понятную ошибку без обращения к браузеру: `account "<id>" has pro tier and does not support Carbon (Ultra tier required)`.

### 3.4 Классификация отказов и ротация

- `classifyFailure(err)` относит ошибку к одной из категорий:
  0. **`unknown-dialog`** (`CooldownMs = 3600_000`, `rotatable: true`, `parkedReason: "unknown-dialog"`): `err.code === "WEB_GEMINI_UNKNOWN_DIALOG" || "ARGON_UNKNOWN_DIALOG"`, `"unknown dialog"`. Обнаружение модального диалога вне белого списка прерывает ход, скриншот сохраняется, аккаунт временно паркуется на 1 час для расследования с прозрачной ротацией хода на следующий свободный аккаунт.
  1. **`auth-dead`** (`CooldownMs = 7 * 24 * 3600_000`): `"not logged in"`, `"Sign in"`, `"Войти"`, `"check login status"`.
  2. **`model-locked`** (`CooldownMs = 0`, `rotatable: true`): ошибка `err.isLocked` детектора замка §3.4 (вид `<model> locked: paid upgrade required`). Не накладывает временной кулдаун на аккаунт, записывает `lockedModels: [<lockedModel>]` (и `tier: "pro"` при `carbon`) в состояние аккаунта, и немедленно инициирует прозрачную ротацию на следующий аккаунт.
  3. **`rate-limit`** (`CooldownMs = parsedResetMs || 30 * 60_000`): `"rate-limit"`, `"rate limit"`, `"quota"`, `"limit resets"`, `"thinking level unavailable"`, `"thinking level is rate-limited"`, `"try again later"`, `"too many requests"`, `"лимит"`, `"повторите попытку позже"`.
  4. **`model-unavailable`** (`CooldownMs = 6 * 3600_000`, `parkedReason: "model-unavailable"`): `err.code === "WEB_GEMINI_MODEL_UNAVAILABLE" || "ARGON_MODEL_UNAVAILABLE"`, `"(model|thinking)[- ]unavailable"`, `"model is unavailable"`, `"not available for this account"`, `недоступн…` **только в контексте модели** (`модел… недоступн`, `недоступн… модел`, `недоступн… для этого/вашего аккаунта`) — **только по DOM-доказательству**: драйвер бросает `ModelUnavailable` (`code = "ARGON_MODEL_UNAVAILABLE"`) лишь когда пункт реально отсутствует в меню выбора, уровень отключён/залочен, или есть апсейл-диалог. Сбои селекторов, таймауты `waitForSelector`, ошибки навигации/клика в `selectModelAndThinking` при `strict` **пробрасываются как есть** (`throw err`) и классифицируются как `transient` — аккаунт не паркуется (PLUG-286: раньше catch-all заворачивал их в `ModelUnavailable` → 6 ч кулдауна по ложному поводу). Голое `недоступна` без контекста модели (навигационная ошибка вида «страница недоступна») вердиктом `model-unavailable` не является: до PLUG-286 любое вхождение слова в текст ошибки парковало здоровый аккаунт на 6 ч.
  5. **`transient`** (без кулдауна аккаунта и без `parkedReason`, но с попыткой переключения на другой свободный аккаунт в рамках текущего хода): сетевые/CDP сбои, таймаут ожидания генерации, **сбои драйвера и страницы** (PLUG-286 — `DRIVER_TRANSIENT_RE` и `err.name === "TimeoutError"`): таймауты селекторов и навигации (`waitForSelector`, `waiting for selector`, `navigation failed/timeout`), крэш страницы и браузера (`Target crashed`, `page crashed`, `Session closed`, `browser closed`), сетевые отказы (`net::ERR_*`, `ECONNREFUSED`/`ECONNRESET`, `socket hang up`, `protocol error`, `websocket`), разрушение execution context при навигации, неготовность CDP-порта (`failed to become ready`). Ротация и есть «короткий ретрай в рамках дедлайна»: при повторе до исчерпания `maxAttempts` вызывающему возвращается исходная ошибка, а аккаунт не паркуется и в кулдаун не уходит.
  6. **`transient` по умолчанию** (`rotatable: false`): любая прочая ошибка — без парка и кулдауна, но и без ротации: вызывающему возвращается сразу.
- Матрица классификации сбоев (PLUG-286) — источник признака и эффект на аккаунт:

  | Признак отказа | Источник признака | Вердикт | `parkedReason` / кулдаун | Ротация |
  |---|---|---|---|---|
  | Неизвестный модальный диалог вне белого списка (`WEB_GEMINI_UNKNOWN_DIALOG`) | DOM | `unknown-dialog` | `unknown-dialog`, 1 ч | да |
  | `authHint` / «not logged in», «sign-in», «войти» | DOM/проверка логина | `auth-dead` | `auth-dead`, 7 сут | да |
  | Иконка замка в пункте меню; апсейл-диалог с план-CTA (предикат §3.4) | DOM | `model-locked` | нет; `lockedModels += model` | да |
  | Текст квоты/лимита (`rate limit`, `quota`, `Limit resets …`, `лимит`) | DOM-текст меню | `rate-limit` | нет; кулдаун до reset (≤ 7 сут) | да |
  | Пункт отсутствует в меню выбора, уровень отключён/залочен, апсейл-диалог | DOM | `model-unavailable` | `model-unavailable`, 6 ч | да |
  | Таймаут селектора/навигации, `TimeoutError`, крэш страницы, CDP/network-сбой | сбой драйвера | `transient` | нет | да |
  | Таймаут ожидания генерации (stream cap, `hung page`); стол генерации `WEB_GEMINI_STALLED` (нет прогресса `STALL_MS`) | сбой драйвера | `transient` | нет | да |
  | Любая прочая ошибка | — | `transient` (default) | нет | нет — сразу вызывающему |

  Правило PLUG-286: ни один таймаут или сбой страницы не даёт `model-unavailable` без DOM-признака; `model-unavailable` ставится только по DOM-доказательству.
- Итоговый кулдаун ограничен потолком 7 суток: `Math.min(cooldownMs, 7 * 86_400_000)`.
- Разбор времени сброса квоты `parseResetTimeMs(msg, nowMs)` поддерживает:
  - английские форматы: `"Limit resets 2:19 AM"`, `"Limit resets at 14:30"`, `"Limit resets tomorrow at 11:00 AM"`, `"Limit resets Oct 15, 2:19 AM"`, `"Limit resets on Nov 16, 11:00 PM"`;
  - русские форматы: `"Лимит обновится в 14:30"`, `"Лимит сбросится завтра в 09:15"`.
  Правило переноса года: если дата в сообщении указана без года (например, `"Oct 15"`), то если вычисленная дата оказывается раньше текущей больше чем на 30 дней (`targetMs < nowMs - 30 * 86_400_000`), она переносится на следующий год, иначе остаётся в текущем году. К вычисленному времени добавляется буфер 2 минуты (`+ 2 * 60_000`).
- **Детектирование значка замка и строгий выбор уровня мышления** (точный предикат — PLUG-282, ложнопозитивы 16.11 помечали `argon` (нынешний `neon`) залоченным на аккаунтах, где модель доступна; PLUG-324 — детектирование `upsell_*` в `data-mode-id`):
  - `menuItemHasLockIcon(el)` — замком считается признак `upsell_*` в атрибуте `data-mode-id` пункта меню (например, `upsell_MODE_CATEGORY_ULTRA` для заблокированной модели Carbon в новом пикере), либо **только визуально видимая** иконка (`offsetParent !== null`) внутри именно этого пункта меню, чья Material-идентичность **точно** равна `lock`/`lock-filled` по одному из каналов: `innerText` === `'lock'`, `data-mat-icon-name`/`aria-label` === `'lock'`/`'lock-filled'`, либо точный токен `'lock'`/`'lock-filled'` среди классов (split по пробелам с равенством). Подстроки в `className`/`innerText` — `'unlock'`, `'lock_open'`, `'mat-icon-lock-reset'` — замком **не** являются. Если замок обнаружен, драйвер не совершает клик по платному пункту (чтобы не вызывать модальное окно с предложением сменить план) и сразу выбрасывает `ModelUnavailable('model', '<model> locked: paid upgrade required')` с `isLocked = true` и `lockedModel`.
  - Замок по посткликовому диалогу (заблокированная модель кликабельна — клик открывает апсейл) засчитывается только при **двух** условиях: диалог появился **прямым откликом на клик** по этому пункту **и** несёт явный апгрейд-CTA:
    - перед кликом (strict-путь) `markVisibleDialogs` помечает все видимые диалоги атрибутом `data-web-gemini-pre-click`; `upsellDialogConfirmsLock` пропускает помеченные — открытое ранее промо, даже с кнопкой смены плана, замком не является (показ скрытого до клика диалога — отклик, он не помечен);
    - после клика (+500 мс) `selectedNow` перечитывает кнопку пикера: если запрошенная модель выбралась — замка нет независимо от попапов;
    - `upsellDialogConfirmsLock` требует в видимом диалоге (`mat-dialog-container, [role="dialog"]`) кнопку/ссылку смены плана (`сменить план|подписку|тариф`, `change plan|subscription`, `upgrade`, `перейти на тариф|ultra|pro`, `оформить подписку`, `перейти на платную`); generic-промо с ценовым текстом (`…/мес`, `per month`) без такого CTA замком не является и не дисмиссится. При подтверждении диалог закрывается негативной кнопкой (`Не сейчас`/`Not now`/`No thanks`/`Maybe later`) и бросается тот же `ModelUnavailable` с `isLocked`/`lockedModel`.
  - Если в меню выбора режима мышления (`selectModelAndThinking`) запрошенный пункт (`Fast`, `Thinking` или `Pro`) имеет `isDisabled === true` (`aria-disabled="true"` / класс `disabled`), при `strict: true` драйвер обязан выбросить `new ModelUnavailable('thinking', '<thinking> thinking level is rate-limited (<reset text>)')` **до** общей проверки `if (strict) throw new ModelUnavailable('thinking', ... 'not found')`.
  - Благодаря этому `acp-server.mjs` классифицирует отказ как `rate-limit` с точным временем сброса из текста меню (`Limit resets ...`). Для новых чатов (когда `!s.convId` и клиенту ещё не отправлен ни один чанк `!streamedAny`) сервер прозрачно переключает запрос на следующий свободный аккаунт пула, не блокируя аккаунт на 6 часов как `model-unavailable`.
  - Ротация на следующий аккаунт пула при исчерпании лимита или временной ошибке выполняется **только** для новых чатов (до фиксации `s.convId` и до отправки первого чанка клиенту). Если беседа уже имеет зафиксированный `s.convId`, она остаётся строго привязана к своему аккаунту (`s.backend`), так как история и ID беседы принадлежат конкретному аккаунту Google. Запрос не переключается на другие аккаунты пула, и обрабатываются два случая:
    - если закреплённый аккаунт находится в кулдауне, сразу возвращается ошибка: `account "<id>" is in cooldown until ...; this conversation is pinned to it`;
    - если закреплённый аккаунт занят другим ходом, сервер ждёт освобождения аренды до 130 с (`waitDeadline = Date.now() + 130_000`, `WAIT_BUSY_MS`), опрашивая замок, и только если аренда не освободилась, возвращает ошибку `account "<id>" is busy until...`.

---

## 4. Веб-драйвер (`src/gemini-driver.js`)

### 4.1 Надёжная вставка больших промптов и однократная отправка

- Промпты ревью и аудита могут достигать 50–150 КБ и содержать тысячи строк.
- **Гард размера промпта (PLUG-281):** при ~100 КБ и выше `execCommand('insertText')` в Chrome зависает, а таймаут последующего `waitForSelector` раньше ошибочно парковал здоровый аккаунт на 6 ч (`model-unavailable`). Поэтому размер исходящего текста проверяется заранее в байтах UTF-8 на каждой отправке в Gemini:
  - Лимит — `WEB_GEMINI_MAX_PROMPT_BYTES` / `ARGON_MAX_PROMPT_BYTES` (не задан → `100000`, ниже наблюдаемого обрыва ~120 КБ; `0`/отрицательное → без лимита; нечисловое значение → дефолт). При реализации упаковки первого сообщения и инструментов (PLUG-278): потолок упаковки `WEB_GEMINI_MAX_MESSAGE_BYTES` / `ARGON_MAX_MESSAGE_BYTES` обязан быть `≤ WEB_GEMINI_MAX_PROMPT_BYTES / ARGON_MAX_PROMPT_BYTES − ~4 КБ` (запас на системную шапку инструментов), иначе упаковка сама соберёт заведомо неотправимое сообщение; заданное большим значение логируется и зажимается до потолка.
  - `session/prompt`: при превышении — перелив текста в файл-вложение `pkg-<sessionId>-prompt-<ts>.md` (§2.2 п.2); отказ `-32000` синхронно в `dispatch` только при ошибке записи файла — message `prompt too large: <N> bytes exceeds limit <L> bytes (WEB_GEMINI_MAX_PROMPT_BYTES). Shrink the request and retry.` — до `enqueue`, выбора аккаунта и аренды.
  - `sendPrompt` драйвера: `throwIfPromptTooLarge` — первая строка функции, до `ensureChrome`, подключения CDP и любой работы со страницей; это последний рубеж для всех отправок в Gemini (включая будущие отправки первого сообщения и раундов инструментов PLUG-278), включая повторную проверку после чтения `maxlength` поля ввода (эффективный лимит = `min(env, maxlength)`; `contenteditable` maxlength не несёт — тогда действует только env).
  - Ошибка `WEB_GEMINI_PROMPT_TOO_LARGE` (legacy-код `ARGON_PROMPT_TOO_LARGE` тоже принимается обработчиками и `classifyFailure`) — ошибка вызывающего, а не аккаунта: в `runPrompt` она пробрасывается без `probeAuthHint`, классификации, ротации и кулдауна (аренда лишь освобождается), а в ответ агенту уходит verbatim без обёртки `Gemini web driver error:`.
- Вставка текста в редактор (`.ql-editor, div[contenteditable="true"], [role="textbox"]`):
  - Для текста длиной свыше 500 символов (или содержащего переводы строк) сначала выполняется быстрая вставка через `page.evaluate`: фокусировка редактора, очистка и `document.execCommand('insertText', false, text)`.
  - Если после `execCommand` длина текста в редакторе меньше ожидаемой (`gotText.length < Math.min(prompt.length * 0.9, prompt.length - 10)`), драйвер очищает поле и использует резервный `page.keyboard.insertText(prompt)`.
- Отправка сообщения:
  - Если найдена активная кнопка отправки (`button[aria-label*="Send message" i], button[aria-label*="Отправить" i], button.send-button`), выполняется **только** `await sendBtn.click()`.
  - Нажатие `await page.keyboard.press('Enter')` выполняется **только** в том случае, если кнопка отправки не найдена или клик по ней не удался. Безусловная комбинация `sendBtn.click()` + `Enter` запрещена, так как приводит к двойной отправке или отправке пустого второго сообщения.

### 4.2 Многоходовый стриминг без утечки предыдущего ответа

- Перед отправкой промпта драйвер фиксирует число уже существующих в DOM узлов `<model-response>`. В новом чате (`!convId`) берётся текущее число `(await page.$$('model-response')).length`. В существующей беседе (`convId`) вызывается `waitForHistoryStabilization(page, convId)`: функция с интервалом 350 мс опрашивает число `<model-response>` и ждёт двух повторов того же значения подряд (не менее двух интервалов, потолок 10 с), чтобы гарантировать, что история предыдущих ходов полностью отрисовалась в DOM перед вычислением `initialCount`.
- Индекс нового ответа для текущего хода равен `idx = initialCount`.
- Начало генерации проверяется в цикле до 120 с: генерация считается начавшейся (`started === true`), если в DOM появилась кнопка остановки (`button[aria-label*="Stop" i], button[aria-label*="Остановить" i], button[data-test-id="stop-button"]`) либо функция `findTurnTarget(document, idx, promptPrefix)` вернула узел ответа.
- Контракт поиска целевого ответа хода (`findTurnTarget(doc, idx, promptPrefix)`):
  - проверяется список узлов `<user-query>`. Последний запрос `lastQuery = queries[queries.length - 1]` должен содержать нормализованный префикс промпта (первые 40 символов промпта с нормализацией повторяющихся пробельных символов `norm(lastQuery.innerText).includes(norm(promptPrefix).slice(0, 40))`); при отсутствии или несовпадении возвращается `null`;
  - список ответов формируется запросом `const responses = doc.querySelectorAll('model-response')`;
  - берётся элемент `let target = responses[idx] || null`;
  - если `target` отсутствует (ранняя фаза рассуждений/поиска до рендера `<model-response>`), выполняется fallback: `const pending = doc.querySelectorAll('pending-response')`, и при наличии берётся `target = pending[pending.length - 1]`;
  - для выбранного `target` (не `null`) проверяется порядок в DOM: он должен следовать строго после `lastQuery` (`lastQuery.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING`); иначе возвращается `null`.
- Для отслеживания текста и проверки завершения генерации (`currentText`, `hasFinishedContent`):
  - обращения идут строго через `findTurnTarget(document, idx, promptPrefix)`;
  - **запрещён** откат к `responses[responses.length - 1]`, так как на втором и последующих ходах (`isNewChat: false`, `initialCount >= 1`) до появления нового `<model-response>` последним элементом массива в DOM является ответ предыдущего хода, что приводило к мгновенному ложному завершению хода со старым текстом.
- **Предикат завершения хода (PLUG-304):** конец генерации определяется не только отсутствием stop-кнопки, а совокупностью признаков; снимок состояния делает `checkTurnStatus(doc, idx, promptPrefix)` (исполняется в контексте страницы), решение — `isTurnComplete(status, opts)`.
  - `hasStopButton` — активная (не `disabled`, `aria-disabled !== "true"`) кнопка остановки по селекторам `button[aria-label*="Stop"|"Остановить"|"Прекратить"]`, `button[data-test-id="stop-button"]`, `button[data-test-id*="stop"]`, `.stop-button`. Дополнительно stop-кнопка перепроверяется отдельным `safeQuery` вне снимка; любое из найденных значений блокирует завершение.
  - `isBusyOrThinking` — индикатор занятости/thinking: атрибут `aria-busy="true"` на целевом ответе или внутри него, `mat-spinner`, `mat-progress-bar`, `[role="progressbar"]`, `.spinner`, `.loading-spinner`, `.mat-mdc-progress-spinner`, `.mat-mdc-progress-bar`, `[data-test-id*="spinner"|"loader"|"loading"]`, `.shimmer`, `[class*="shimmer"]`, `sparkle-animation`, `[class*="sparkle-anim"]`, `.animated-sparkle`, `.loading-dots`, `[class*="loading-dot"]`, `thinking-indicator`, `.thinking-indicator`, `[data-test-id*="thinking-indicator"]`, `[class*="thinking-spinner"]`, `[class*="thinking-process-spinner"]`; а также глобальный `aria-busy="true"` в `.conversation-container`, `main` или `.input-area`. Наличие любого индикатора блокирует завершение (окно перехода thinking→ответ, когда stop-кнопка временно исчезает).
  - `hasFinishedContent` — в целевом ответе есть непустой `message-content` (либо сгенерированное изображение).
  - `hasActionButtons` — маркеры завершённого ответа: `response-feedback`, `.response-feedback`, `.actions-container`, `.luminous-actions-container`, `message-actions`, `[data-test-id="response-actions"|"message-actions"]`, кнопки Copy/Копировать, Good response/Хороший ответ, Thumbs up/Нравится, thumb/like, Bad response/Плохой ответ, Share/Поделиться.
  - **Двойной порог стабильности:** при `hasActionButtons` ход завершается после стабильности `stableMs >= WEB_GEMINI_STABLE_DURATION_MS` / `ARGON_STABLE_DURATION_MS` (по умолчанию 500 мс); без action-кнопок — только после `stableMs >= WEB_GEMINI_STABLE_NO_ACTIONS_MS` / `ARGON_STABLE_NO_ACTIONS_MS` (по умолчанию 5000 мс). Стабильность сбрасывается при росте текста, смене источника текста (`mc`/`raw`), потере цели и любом активном признаке `hasStopButton`/`isBusyOrThinking`. Короткий завершённый ответ по-прежнему закрывается за ~0.5 с.

### 4.3 Захват `convId` и парковка вкладки (`about:blank`) в простое

- После завершения стриминга на новом чате (`isNewChat: true`) URL вкладки (`https://gemini.google.com/app/<convId>`) может обновиться с небольшой задержкой. Драйвер опрашивает `page.url()` до 5 секунд (с шагом 200 мс) и принимает значение по `/\/app\/([a-f0-9]{8,})/i` либо по `/\/app\/([a-zA-Z0-9_-]+)/`, **исключая** служебное значение `new`; первый найденный `convId` возвращается в объекте результата `{ text, thinking, meta, convId }`.
- **DOM-фолбэк при пустом URL:** если за 5 секунд URL не дал `convId`, тем же шагом 200 мс драйвер читает ссылку текущей беседы в DOM — `gem-nav-list-item[data-test-id="conversation"] a[href*="/app/"], gem-nav-list-item a[href*="/app/"], a[href*="/app/"]` — и извлекает id из `href` по тем же шаблонам с тем же исключением `new`.
- **Финальный повтор перед парковкой:** в блоке `finally` (после сбора лимитов `captureUsageLimits` и до перевода вкладки на `about:blank`) при `isNewChat && !returnedConvId` выполняется ещё один 3-секундный опрос `page.url()` (шаг 200 мс); найденный id записывается в `returnedConvId` и в `resObj.convId`, чтобы ход 2 продолжил беседу, а не создал новый чат.
- Открытая вкладка `gemini.google.com/app/...` в фоновом процессе Chrome непрерывно крутит анимации и таймеры Angular/Material, потребляя ~20–25% CPU на каждый инстанс Chrome в простое.
- Чтобы устранить фоновую нагрузку на CPU, в блоке `finally` метода `sendPrompt` (после захвата `convId` и перед `disconnect()`) при `process.env.GEMINI_PARK_IDLE !== '0'` драйвер переводит рабочую вкладку на `about:blank` (`await page.goto('about:blank', { timeout: 5000 }).catch(() => {})`).
- **Навигация на 2+ ходе и выход из парковки `about:blank`**:
  - Перед началом ввода промпта драйвер проверяет текущий URL (`page.url()`); если вкладка запаркована на `about:blank`, драйвер выполняет переход:
    `await page.goto(convId ? `https://gemini.google.com/app/${convId}` : GEMINI_APP_URL, { timeout: 15000 })`.
  - При наличии `convId` в сессии восстанавливается контекст беседы; если `convId` отсутствует (например, ход 1 был отменён до извлечения ID), выполняется переход на новый чат `GEMINI_APP_URL`. В обоих случаях поиск редактора и ввод текста не зависают на `about:blank`.

### 4.4 Сбор лимитов Gemini Web (`batchexecute`) и файл состояния `accounts-usage.json` (PLUG-289)

- **Назначение:** парсинг лимитов Gemini Web (5-часовое скользящее окно `daily` и недельный лимит `weekly`) по каждому аккаунту пула и запись в `$STATE_DIR/accounts-usage.json` (`STATE_DIR` = `WEB_GEMINI_STATE_DIR` / `ARGON_STATE_DIR`, дефолт `~/.bb/plugins/provider-web-gemini` с фолбэком на `provider-argon`) для последующего чтения плагином Usage Pro.
- **Механика batchexecute:**
  - Gemini отдаёт лимиты через внутренний RPC-канал `batchexecute` (тот же интерфейс, что использует веб-страница `/usage`).
  - Вызов выполняется функцией `captureUsageLimits(page, opts)` через `Runtime.evaluate` (`page.evaluate`) в контексте страницы `gemini.google.com`:
    1. Из глобального объекта `window.WIZ_global_data` читаются параметры: `SNlM0e` (`at`-токен), `cfb2h` (`bl`), `FdrFJe` (`f.sid`). Токены `at` и `f.sid` используются исключительно in-memory и никогда не сохраняются на диск.
    2. Выполняется `POST /_/BardChatUi/data/batchexecute?rpcids=<rpcids>&source-path=/usage&bl=<bl>&f.sid=<fsid>&hl=en&_reqid=<rnd>&rt=c` с заголовком `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`, телом `f.req=[[[rpcid1,args,null,"generic"],[rpcid2,...]]]&at=<at>` и `credentials: "include"`. Внутри браузерного запроса вызов защищён сигналом `AbortController` (таймаут 8 с), а сам `page.evaluate` обёрнут в `Promise.race` с таймаутом 9 с.
    3. Дефолтный рецепт RPC: `rpcid = "jSf9Qc"`, `args = "[]"`. Список кандидатов RPC ID: `['jSf9Qc', 'kAb7Z']`.
    4. **Самолечение рецепта (self-healing):** запрос отправляет батч из 2-3 кандидатов RPC ID (`f.req`/`rpcids`). При сбое батча предусмотрен последовательный фолбэк по списку кандидатов. Парсер обходит все `wrb.fr`-фреймы в ответе. Фрейм, содержащий записи метрик, возвращает свой рабочий `rpcid`. Если он отличается от сохранённого рецепта, поле `recipe` в `accounts-usage.json` обновляется с новым `rpcid`.
    5. **Разбор ответа:** ответ очищается от анти-XSSI префикса `)]}'`, извлекаются фреймы `[["wrb.fr", rpcid, payloadJson], …]`. В `payload` рекурсивно ищется массив записей-метрик `e`:
       - `e[1]` — доля использования 0..1.5 (`percent = Math.round(e[1] * 100)`);
       - `e[2]` — период (`1` = 5-часовое окно/daily, `2` = недельный/weekly);
       - `e[3][0][0]` — время сброса квоты в секундах Unix epoch (`>= 1.6e9`).
       Итог разбора: `{ daily: { percent, resetEpochSec }, weekly: { percent, resetEpochSec }, workingRpcid }`.
- **Условия вызова и ограничения:**
  - **Только в живой вкладке:** вызов выполняется ТОЛЬКО когда вкладка аккаунта уже активна на домене `gemini.google.com` (URL содержит `gemini.google.com`, не `about:blank`).
  - **Никакого запуска Chrome ради статистики:** если Chrome не поднимался для выполнения хода — сбор безусловно пропускается.
  - **Точки обновления:** сбор вызывается в `sendPrompt` в блоке `finally` после завершения каждого хода (независимо от исхода — как при успешном ответе, так и при ошибке хода / rate-limit, когда фиксация лимитов наиболее ценна), непосредственно перед парковкой вкладки на `about:blank`.
  - **Таймаут и изоляция сбоев хода:** вызов `captureUsageLimits` в `finally` ограничен `Promise.race` с таймаутом `WEB_GEMINI_USAGE_TIMEOUT_MS` / `ARGON_USAGE_TIMEOUT_MS` (по умолчанию 10 000 мс). Любой сбой (сетевой, таймаут, отсутствие `SNlM0e`, смена формата) логируется только в debug-режиме (`WEB_GEMINI_DEBUG` / `ARGON_DEBUG`) и ни при каких условиях не влияет на результат или ошибку хода.
  - **Троттлинг:** не чаще одного раза в `WEB_GEMINI_USAGE_REFRESH_MS` / `ARGON_USAGE_REFRESH_MS` (дефолт 300 000 мс / 5 минут) на каждый аккаунт. Троттлинг проверяется в памяти процесса и по штампу `updatedAt` в `accounts-usage.json`.
- **Формат файла `$STATE_DIR/accounts-usage.json`:**
  ```json
  {
    "accounts": {
      "<id>": {
        "daily": { "percent": 25, "resetEpochSec": 1763350000 },
        "weekly": { "percent": 60, "resetEpochSec": 1763950000 },
        "tier": "ultra|pro",
        "updatedAt": 1763345000000,
        "stale": false
      }
    },
    "recipe": {
      "rpcid": "jSf9Qc",
      "args": "[]",
      "updatedAt": 1763345000000
    }
  }
  ```
  - Определение `tier`: значение из `backend.tier` (из `pool.json`), либо детектируется по DOM (`gemini advanced`/`gemini ultra` → `"ultra"`, иначе `"pro"`). При обновлении предотвращается случайный даунгрейд с `ultra` до `pro` при пропуске DOM-детекции.
  - Multi-process пул и частичные ответы:
    - Запись в файл выполняется атомарно через файл-замок `accounts-usage.json.lock`, содержащий уникальный токен процесса (`pid:ts:random`). Замок снимается в `finally` только при точном совпадении токена (защита от гонок при снятии чужого перехваченного лока).
    - Read-merge-write: при частичном ответе сервера (наличие только одной из метрик `daily`/`weekly`) существующие метрики аккаунта объединяются со снапшотом предыдущего состояния (`daily ?? prev?.daily ?? null`). Записи других аккаунтов пула сохраняются.

### 4.5 Файлы-вложения и сгенерированные файлы ответа (PLUG-291)

- **Прикладывание файлов (`attachFile`):** до вставки текста промпта и до `waitForHistoryStabilization` каждый файл из `opts.files` прикладывается через веб-аплоадер Gemini: кнопка «+» (Upload & tools) → скрытый `input[type="file"]` в открытом меню (`setInputFiles`; запасной путь — видимый пункт «Upload files»/«Загрузить файлы» + `filechooser.setFiles`) → ожидание чипа превью и активной кнопки Send (до 15 с). Файлы никогда не идут через `insertText` — это снимает зависание textbox на больших пакетах (§4.1).
- **Сбор сгенерированных файлов (`collectGeneratedFiles`):** post-turn, пока DOM текущего ответа ещё жив (до ephemeral-удаления беседы и парковки вкладки на `about:blank`), сканируется только целевой ответ хода через `findTurnTarget` — никогда `model-response:last-of-type`, иначе файлы прошлых ходов перекачивались бы повторно. Кандидаты внутри ответа: якоря `<a href>` с атрибутом `download`, подписью Download/Export/Скачать/Экспорт или файловым расширением в URL, и кнопки с теми же подписями — только на доменах белого списка `isAllowedDownloadHost` (`google.com`, `*.google.com`, `googleusercontent.com`, `*.googleusercontent.com`, `googleapis.com`, `*.googleapis.com`); ссылки и кнопки вне списка не кликаются и не выгружаются.
- **Каналы скачивания (PLUG-376):** для `<a href>`-кандидатов с разрешённым URL — прямой GET через `context.request` того же контекста (имя из `Content-Disposition`, атрибута `download` или пути URL; `content-length` проверяется до чтения тела). Для клик-кандидатов четыре канала буферизуют события слушателями с начала клика (события вне окна клика игнорируются accept-флагом): нативный `download`-ивент страницы, новая вкладка `ctx.on('page')` (`inspectNewPage` ждёт реальный `^https?` URL — `about:blank` пропускается), сетевой ответ `respFileCandidate` и хук `URL.createObjectURL` (fetch→blob; Blob удерживается для чтения `arrayBuffer`). Победитель — первый непустой результат (`firstNonNull`): `null` или ошибка одного канала не гасит остальные. Каскад клика — обычный `click` (5 с) → `force` (3 с) → `dispatchEvent`; дедлайн гонки `CLICK_WAIT_MS` (по умолчанию 10 с) отсчитывается после успешного клика. `cleanupWaiters` снимает слушателей и закрывает буферные вкладки-не-победители. Хост результата проверяется `classifyDlUrl` до и после редиректов: `allowed` по белому списку, `drive` по `DRIVE_GATE_HOST_RE` (`docs|drive|sheets|slides.google.com` — фиксируется причиной в `skipped`), прочее отклоняется. Сохранение атомарное — `<dest>.part` + `rename` — в `downloads/<sessionId>-<ts>-<n>-<name>`; имя проходит `sanitizeDownloadName` (≤120 символов, без `..`, сепараторов, `#` и управляющих символов).
- **Отсев телеметрии и валидация контента:** `respFileCandidate` применяет строгий порядок — сначала отсев по URL и имени файла (`TELEMETRY_OR_RPC_URL_RE`: `batchexecute`, `gen_204`, `/log`, `telemetry`, `beacon`, `/collect`, `playlog`, `/_`, `rpcids=`; `isTelemetryOrRpcName`: `response.bin`), затем статус 2xx и белый список хостов, затем `Content-Disposition: attachment` или бинарный `content-type` (`image/*` кроме `svg`/`gif`/`icon`). `isValidResponseContent` дополнительно отклоняет JSON-конверт RPC (префиксы `)]}'`, `{`, `[`) при заявленном бинарном типе и проверяет magic bytes (PNG `\x89PNG`, JPEG `\xFF\xD8`, WebP `RIFF…WEBP`, GIF `GIF8`, zip/docx/xlsx/pptx `PK\x03\x04`). Служебный ответ Google с заголовком `attachment` (вроде `response.bin` от `batchexecute`) файлом не становится.
- **Fallback для Imagen (PLUG-376):** когда все четыре канала после успешного клика пусты (кнопка «Скачать в полном размере» в Imagen не порождает событий сети), выполняется canvas-экстракция изображения из контейнера ответа (`canvas.toDataURL('image/png')` либо `img.src`), валидируется `data:image/` и записывается в `res.files`; при неуспехе причина фиксируется в `skipped` (`telemetry/rpc`, если был отсечён RPC, иначе `download did not materialize`).
- **Лимиты и отказоустойчивость:** ≤ `WEB_GEMINI_MAX_DOWNLOAD_BYTES` / `ARGON_MAX_DOWNLOAD_BYTES` (по умолчанию 50 МБ) на файл, ≤ `WEB_GEMINI_MAX_DOWNLOAD_COUNT` / `ARGON_MAX_DOWNLOAD_COUNT` (по умолчанию 5) за ответ и потолок попыток `max(8, 2 × WEB_GEMINI_MAX_DOWNLOAD_COUNT / ARGON_MAX_DOWNLOAD_COUNT)` — длинный хвост неудачных кандидатов не растягивает ход. Превышение и ошибки кандидатов попадают в `skipped` и не роняют ход; сбой самого сканера — только `console.warn`. Отмена хода проверяется между кандидатами через `throwIfCancelled`. Результат — `res.files[]` (`{ path, name, mimeType, sizeBytes }`) и `res.skippedDownloads[]` (`{ name, reason }`), которые `acp-server.mjs` превращает в `resource_link`-чанки и текстовые пометки (§2.2 п.7, §2.4).

### 4.6 Выбор модели в веб-интерфейсе и маппинг пикера (PLUG-324)

- В веб-интерфейсе Gemini слот модели «Argon» переименован в «Neon» («4 Neon» / «Deeper analysis» / «Глубокий анализ»).
- Каноническое имя в BB — `neon`; `argon` сохраняется псевдонимом обратной совместимости (r26, слово владельца 20.11):
  - в `acp-server.mjs`: `resolveModelId` сопоставляет `'argon'` и `'gemini 4 argon'` со значением `'neon'`;
  - в `src/gemini-driver.js`: карта `modelKeywords` связывает канонические имена с подписями нового и прежнего UI:
    - `neon`: `['neon', 'deeper analysis', 'глубокий анализ', 'argon', 'код и анализ']` (плюс зеркальный алиас `argon`);
    - `carbon`: `['carbon', 'code & complex work', 'code and complex work', 'самые сложные задачи']`;
    - `hydrogen`: `['hydrogen', 'повседневные дела']`;
    - `pro`: `['pro', 'исследования']`;
    - `flash-lite` / `lite`: `['flash-lite', 'lite', 'быстрые ответы']`;
    - `flash`: `['flash']`;
    - `fast`: `['flash-lite', 'lite', 'быстрые ответы', 'flash']`.
- Префикс «4 » («4 Neon», «4 Carbon», «4 Hydrogen») поддерживается за счёт разбиения текста пунктов на строки и поиска подстрок (`includes` / `wordMatch`).
- Детектирование Ultra-lock: пункты с `data-mode-id`, начинающимся на `upsell_` (например, `upsell_MODE_CATEGORY_ULTRA` для заблокированной модели Carbon), распознаются функцией `menuItemHasLockIcon` как заблокированные до совершения клика, предотвращая показ диалога апгрейда плана и инициируя прозрачную ротацию на подходящий аккаунт.
- Fallback-поиск кнопки пикера `getPickerButton`: регулярное выражение включает `neon` и `deeper analysis`.

---

## 5. Переносимость и гигиена репозитория

- Во всех файлах плагина (`src/gemini-driver.js`, `src/profile-manager.js`, `bin/gemini.js`, `scripts/glogin.mjs`, `scripts/pool-add.mjs`, `acp-server.mjs`, `index.mjs`) запрещены жёстко зашитые пути домашнего каталога конкретной машины (`/home/...`), идентификаторы сущностей BB (`thr_...`, `proj_...`, `env_...`) и личные почтовые адреса.
- Базовый домашний каталог всегда вычисляется через `os.homedir()`, а пути внутри пакета — через `new URL(..., import.meta.url)` или `path.dirname(fileURLToPath(import.meta.url))`.
- В `scripts/glogin.mjs` отладочный скриншот сохраняется только при явно заданной переменной окружения `GLOGIN_SCREENSHOT`.
- В `scripts/pool-add.mjs` путь к Chrome определяется переносимо через `process.env.GEMINI_CHROME_BIN || process.env.CHROME_BIN` с проверкой стандартных системных путей (`/usr/bin/google-chrome-stable`, `google-chrome`, `chromium`), без привязки к конкретной архитектуре или временной сборке Chromium в кэше пользователя.

---

## 6. Тестирование и верификация (`npm test`)

- В `plugins/bb-plugin-provider-web-gemini/package.json`:
  - `"test": "node --test tests/*.test.mjs"` — автономный офлайн-набор тестов на `node:test`, не требующий запущенного Chrome и сети (выполняется при проверке `scripts/check-changed-plugins.sh` и на шаге 3 конвейера `release`);
  - `"test:live": "node tests/test-driver.js"` — ручной дымовой прогон против живого Chrome.
- Офлайн-тесты (`tests/provider-web-gemini.test.mjs`) проверяют:
  1. Синтаксическую корректность (`node --check`) всех `.js`/`.mjs` файлов плагина и отсутствие запрещённых подстрок (`/home/`, `thr_`, личных email) в отслеживаемых файлах плагина.
  2. Полный цикл JSON-RPC в `acp-server.mjs` (`ARGON_FAKE=1` с временным `ARGON_STATE_DIR` и `ARGON_POOL_FILE`): `initialize`, `session/new`, `session/set_model`, `session/set_config_option`, `session/prompt` (стриминг `agent_message_chunk` + `stopReason: "end_turn"`), `session/cancel` (`stopReason: "cancelled"`), автоматическое снятие аренды при закрытии `stdin` / `SIGTERM`. Поддержка `ARGON_FAKE_DELAY_MS` для проверки удержания аренды во время выполнения запроса и корректного освобождения аренды при отмене хода и `SIGTERM`.
  3. Функции `parseResetTimeMs` и `classifyFailure` на всех вариантах английских и русских сообщений о лимитах, недоступности уровня `thinking` и истечении дедлайна.
  4. Строгий режим `selectModelAndThinking` (`isDisabled` при `strict: true` порождает `rate-limit` ошибку `thinking level is rate-limited`) и индекс `responses[idx]` без отката к `responses[responses.length - 1]`.
  5. Гард размера промпта (PLUG-281): отказ `WEB_GEMINI_PROMPT_TOO_LARGE` на границе драйвера (`sendPrompt` до `ensureChrome`/CDP); подсчёт размера в байтах UTF-8. В `session/prompt` промпт сверх лимита `WEB_GEMINI_MAX_PROMPT_BYTES` / `ARGON_MAX_PROMPT_BYTES` переливается в файл-вложение `pkg-<sessionId>-prompt-<ts>.md` с коротким текстом-указателем и продолжает обычный путь без ошибки; `-32000` — только при ошибке записи файла (синхронно, до выбора аккаунта и захвата аренды); промпт `<=` лимита — без spill.
  6. Умную маршрутизацию `pickBackendFromState`: выбор `pro`-аккаунтов для `neon` и `ultra` для `carbon`, разрешение эффективного приоритета (`state` → `pool` → дефолт `10`, `<= 0` исключает аккаунт), учёт `lockedModels` и LRU по `lastUsedMs` (§3.3).
  7. Жизненный цикл процесса и селекторы драйвера: запись `slog` в `acp-server.log`, `reapOrphanAcpServers` (снятие осиротевших acp-server), visible-селекторы (`gem-menu-item[data-mode-id]:visible`) и русские подписи (`Загрузить файлы`, `Удалить`) в `gemini-driver.js`.
  8. Двунаправленную фильтрацию селекторов model ↔ account (PLUG-280): ограничение списка моделей возможностями выбранного аккаунта (union по пулу при s.account === "auto"), ограничение списка аккаунтов поддержкой текущей модели, правило single-capable для currentValue аккаунта, сброс несовместимого аккаунта в "auto" при смене модели и сброс несовместимой модели в "neon" при смене аккаунта.
  9. Разбор batchexecute wrb.fr фреймов функцией `parseUsageLimits` (daily/weekly, проценты, reset epoch sec, самолечение recipe при смене rpcid) (§4.4).
  10. Multi-process merge-логика и атомарная запись `accounts-usage.json` (сохранение чужих аккаунтов пула при параллельных обновлениях, слияние со снапшотом предыдущего состояния без затирания частичных метрик, сохранение `tier: ultra`, защита файла замка через уникальный токен `pid:ts:random`) (§4.4).
  11. Гейтинг и троттлинг `captureUsageLimits` (пропуск вызова на `about:blank`, соблюдение `WEB_GEMINI_USAGE_REFRESH_MS` / `ARGON_USAGE_REFRESH_MS`, обход через `force: true`, изоляция таймаута браузерного запроса и батчинг кандидатов RPC ID) (§4.4).
  12. Интеграция `sendPrompt` с фиксацией лимитов в `finally` (вызов как при успешном ответе, так и при сбое/rate-limit хода, отсутствие зависания при медленном или зависшем `captureUsageLimits`, проброс `backend.tier`) (§4.4).
  13. Точный предикат замка и ops-очистку `lockedModels` (PLUG-282): `menuItemHasLockIcon` на DOM-фикстурах — видимый замок по каждому каналу (innerText/data-mat-icon-name/aria-label/class-токен) детектится, `'unlock'`/`'lock_open'`/`'mat-icon-lock-reset'`/скрытая иконка — нет; `upsellDialogConfirmsLock` — промо с ценой без план-CTA не замок и не дисмиссится, диалог с `Сменить план` — замок с дисмиссом, скрытый диалог игнорируется, помеченный `data-web-gemini-pre-click` диалог с CTA — не замок, вызовы без аргумента берут `globalThis.document` и не падают без него; e2e `selectModelAndThinking` — пункт с иконкой `unlock` кликается, промо-попап после клика не лочит, диалог-отклик с CTA лочит (`isLocked`/`lockedModel`), предсуществующий CTA-промо не лочит, выбравшаяся модель гасит замок; ops `node acp-server.mjs unlock <id|all> [model]` — точечное снятие модели, `all`, восстановление `tier` при снятии `carbon`, кулдаун и `parkedReason` не трогаются.
  14. Вырезание bb-контекста `<system_instructions>` из `session/prompt` (PLUG-285): предикат `isBbSystemInstructionsBlock` по началу текста с `trimStart`, отбрасывание таких блоков до склейки, сохранение метки внутри пользовательского текста и не-text блоков, edge «только контекст» → немедленный `end_turn` без аренды.
  15. Честную классификацию сбоев драйвера (PLUG-286): таймаут `waitForSelector` и `TimeoutError` по имени ошибки, крэш страницы/браузера, CDP и сетевые отказы → `transient` с `rotatable: true`, `parkedReason: null`, без кулдауна; «страница недоступна» без контекста модели — не `model-unavailable`; DOM-доказательства сохраняются (замок/апсейл → `model-locked`, отсутствие пункта в меню → `model-unavailable` 6 ч); повторные transient-сбои не паркуют аккаунт — исходная ошибка уходит вызывающему.
  16. Веб-вложения файлов (PLUG-291): `collectUploadFiles` — приём `file://` `resource_link` и `image`/`localFile`, игнор URL и `resource`-блоков, дедуп по `realpath` до count-лимита, resolve относительных `path` от `s.cwd`, корни `cwd` + `additionalDirectories`/`roots`, отказы `outside session roots` / `not found` / `not a file` / `sensitive` / `too many upload files`, симлинк наружу; `pruneDir` — TTL и ограничение по числу файлов; `sanitizeDownloadName` и `isAllowedDownloadHost` (включая отказ `google.com.evil.com`); `collectGeneratedFiles` на mock-DOM — прямой URL через `context.request` и клик через `download`-событие, атомарные имена `<sessionId>-<ts>-<n>-<name>` без `.part`-остатков, пустой результат без DOM/каталога; каналы клика (PLUG-376): победитель `firstNonNull` — `null`/ошибка канала не гасит остальные, дедлайн после успешного клика, каскад `click`→`force`→`dispatchEvent`, снятие слушателей и закрытие буферных вкладок; `respFileCandidate` — `attachment`+`image/png` на `batchexecute` с JSON-конвертом отклоняется как telemetry/rpc до проверки disposition, отсев `response.bin`/gen_204/`rpcids=`, whitelist хостов и Drive-гейт; `isValidResponseContent` — magic bytes PNG/JPEG/WebP/GIF/PK и отказ JSON-конверта при бинарном типе; canvas-fallback Imagen при пустых каналах; `sendPrompt` — `attachFile` для каждого файла строго до вставки текста, `res.files`/`skippedDownloads` в результате; e2e FAKE — `file://` вне корней → `-32602`, внутри `cwd` → принят (§2.4, §4.5).
  17. Обратную совместимость переименования `provider-argon` → `provider-web-gemini` (PLUG-298): двойную регистрацию провайдеров — основной `acp-web-gemini` (`Gemini (Web)`, бейдж `Gemini`) и legacy-алиас `acp-argon` (`Gemini (Argon)`); приём переменных `WEB_GEMINI_*` (`WEB_GEMINI_FAKE`, `WEB_GEMINI_FAKE_DELAY_MS`, `WEB_GEMINI_STATE_DIR`, `WEB_GEMINI_POOL_FILE`, `WEB_GEMINI_USE_BUNDLED`) с фолбэком на `ARGON_*`; генерацию sessionId с префиксом `web-gemini-*` и регистрацию алиаса `argon-*` в `sessions` (`session/new` и `session/load`), чтобы клиенты, продолжающие сессии по старому префиксу, попадали в ту же сессию.
  18. Предикат завершения хода (PLUG-304): `checkTurnStatus` на DOM-фикстурах — инцидент «42 символа в `message-content` + spinner/thinking при отсутствии stop-кнопки» не завершает ход; сценарии паузы после thinking без action-кнопок, завершённого ответа с action-кнопками (Copy/Good response), avatar-изображения до появления `message-content`, наличия stop-кнопки, `aria-busy`/`shimmer`/`thinking-indicator`; двойной порог `isTurnComplete` (500 мс с action-кнопками / 5000 мс фолбэк) и сброс стабильности при росте текста; интеграционный `sendPrompt` — полный текст ответа вместо усечённого thinking-фрагмента, стриминг чанков `onChunk`, захват `convId` из URL (§4.2, §4.3).
  19. Маппинг переименованного пикера моделей (Neon/Carbon/Hydrogen) и детект Ultra-lock (PLUG-324): выбор пункта пикера «Deeper analysis | 4 Neon» (и RU-варианта «Глубокий анализ | 4 Neon») при `model: 'neon'` (или обратном алиасе `'argon'`); детектирование пункта «Code & complex work | 4 Carbon» со значением `upsell_MODE_CATEGORY_ULTRA` (и любым `upsell_*`) в `data-mode-id` как заблокированного (`isLocked: true`, `ModelUnavailable`) без совершения клика; сохранение обратной совместимости старых подписей («Argon», «Код и анализ», «Самые сложные задачи»); распознавание Neon (и обратного псевдонима `argon`) в `resolveModelId` как `neon`; поддержка fallback-кнопки пикера с Neon/Deeper analysis (тест fallback-пути `getPickerButton` через `evaluateHandle` и проверка regex-литерала) (§4.6).
  20. Жизненный цикл управляемых групп браузера Chrome/Xvfb (PLUG-374, тесты 24–32):
      - 24 (`browser-groups: marker/adopt/identity primitives`): базовые примитивы создания маркера (`recordGroup`), чтения (`readMarker`), усыновления (`adoptGroup`), идентификации группы (`identifyGroup`) и проверки соответствия живых процессов (`groupAliveMatches`, проверка флага `--remote-debugging-port`).
      - 25 (`browser-groups: orphan reap, lease/CDP preservation, reparented groups`): уборка осиротевших групп процессов (включая Xvfb при погибшем Chrome) при смерти ACP; безусловное сохранение групп под активной арендой в реестре или с живыми CDP-клиентами (`ESTABLISHED`-соединения); корректное обнаружение и уборка сирот при унаследовании процессов user-systemd (`PPID != 1`).
      - 26 (`browser-groups: clean-shutdown cleanup of own groups`): штатный выход процесса ACP (`cleanShutdown` → `cleanupOwnBrowserGroups`) с уборкой собственных групп при отсутствии чужой аренды и сторонних клиентов; исключение собственных Playwright-сокетов через `socketInodesOf(process.pid)`.
      - 27 (`browser-groups: identity mismatch stays doubtful — no signal, marker kept`): защита от повторного использования PGID чужими процессами; несовпадение времени старта (`pgidStartTime`) или наличие неатрибутируемых процессов стека переводит группу в статус `'doubtful'` — сигналы не посылаются, маркер сохраняется с аннотацией `doubt.reason`.
      - 28 (`browser-groups: stale-boot marker authorizes nothing — no signal, port free`): маркер с чужим или отсутствующим `bootId` (прошлая загрузка ОС) классифицируется как `'stale-boot'` и не авторизует посылку сигналов процессам текущей ОС; реапер удаляет только устаревший файл маркера, освобождая порт.
      - 29 (`browser-groups: unreadable boot_id fails closed — no signal, no adopt, marker kept`): при нечитаемом `/proc/sys/kernel/random/boot_id` на Linux (`bootState === 'unknown'`) система переходит в fail-closed режим (`'boot-unknown'`) — запрет посылки сигналов, запрет `adoptGroup`, маркер сохраняется.
      - 30 (`browser-groups: marker lock serializes writers — a concurrent fresh marker survives`): блокировка маркера сериализует параллельные операции записи и удаления; свежий маркер параллельного запуска не затирается отработавшим сносом.
      - 31 (`browser-groups: kernel marker lock + unified stopChrome teardown`): использование блокировки ядра `flock(2)` на открытом файловом дескрипторе `<port>.lock`; отсутствие stale-steal; единый конвейер `teardownGroup` для реапера и `stopChrome` в драйвере.
      - 32 (`browser-groups: no flock on linux fails closed — no in-process degrade`): при отсутствии утилиты `flock` на Linux или ошибке запуска операции завершаются с ошибкой `BG_LOCK_UNAVAILABLE`; тихий откат к внутрипроцессной блокировке запрещён.
  21. Детект стола генерации и фазовые дедлайны (PLUG-371, тесты 33–34): `classifyFailure` относит `WEB_GEMINI_STALLED` к `transient`/`rotatable`; перевзвод дедлайна `createTaskTurn` строго при смене стадии (вход в `generation` поднимает окно до `sessionCapAt`, выход в `verify`/`commit` возвращает `min(now + SEND_DEADLINE_MS, sessionCapAt)`, повторный heartbeat окно не сдвигает); e2e через настоящий `acp-server.mjs` с подменённым драйвером и `bb` (`tests/fixtures/stall-server.mjs`, `fake-bb.sh`) — stall при `> 25%` фазового бюджета даёт один авторетрай с ротацией на соседний аккаунт и исходом `passed`, stall при `≤ 25%` — `failed` с `reason: "stalled"` без ретрая, генерация дольше `SEND_DEADLINE_MS` под `SESSION_CAP_MS` проходит, stall на раунде с `convId` ретрая не даёт.
  22. Детект прогресса мышления и поиска Gemini Web (PLUG-407): `checkTurnStatus` возвращает `hasActiveThinkingOrTool` и `statusText`; активный `.animated-thinking-content` с непустым текстом («Searching the web») внутри цели при видимой stop-кнопке не объявляет stall; обычный спиннер (`mat-spinner`, `[aria-busy="true"]`) без `.animated-thinking-content` и без роста текста по истечении `STALL_MS` бросает `WEB_GEMINI_STALLED` (изоляция спиннеров от признака прогресса); отсутствие stop-кнопки (`hasStopButton === false`, `awaitingContent`) при наличии `.animated-thinking-content` штатно бросает `WEB_GEMINI_STALLED`; статичный контейнер `thinking-overlay > .thinking-container` без `.animated-thinking-content` и без смены текста бросает `WEB_GEMINI_STALLED`; статичный `model-thoughts` без спиннера по истечении `STALL_MS` бросает `WEB_GEMINI_STALLED`; текст «Поиск в интернете» внутри `message-content` не продлевает генерацию и даёт stall (строгая изоляция `message-content`); приоритет `model-response` над `pending-response` при их одновременном наличии; старый `<pending-response>` до `lastQuery` не сдвигает индекс `idx` целевого `model-response`; переход `<pending-response>` с `.animated-thinking-content` в `<model-response>` со стримингом завершается успешно (`passed`); нижняя граница `STALL_MS` 600 000 мс для `thinking: "high"`; unclamped явный `stallMs` для тестов и корректный фолбэк при невалидном `stallMs`.
- Набор `tests/provider-web-gemini-tools.test.mjs` (47 тестов, офлайн) покрывает инструменты чтения веб-Gemini по спеке `provider-web-gemini-tools.md`: разбор текстового протокола вызовов инструментов, sandbox `cwd` (запрет `..`, абсолютных путей и симлинков наружу, чёрный список чувствительных файлов), белый список `git`-команд, маскировку секретов `[скрыто: <тип>]`, раунды tool-loop и лимит `WEB_GEMINI_MAX_TOOL_ROUNDS` / `ARGON_MAX_TOOL_ROUNDS`, упаковку первого сообщения (вложения файлов/тредов/задач, потолок `WEB_GEMINI_MAX_MESSAGE_BYTES` / `ARGON_MAX_MESSAGE_BYTES`).

---

## 7. Жизненный цикл аккаунта: добавление, ручной логин, выключение

### 7.1 Выключение аккаунта — два источника истины

- `loadBackends` читает `pool.json` **и** `$STATE_DIR/accounts/<label>/backend.json` как независимые источники (§3.1): запись из `backend.json` попадает в пул fallback'ом, даже если её нет в `pool.json`.
- Выключение аккаунта = **два действия**: удалить запись из `pool.json` и переименовать `accounts/<label>/backend.json` → `backend.json.disabled`. Одного действия недостаточно — второй источник вернёт аккаунт в пул.
- Возврат — симметрично: запись в `pool.json` + `backend.json.disabled` → `backend.json`.

### 7.2 Ручной логин через web-VNC (когда `glogin.mjs` ловит `signin/rejected`)

Автоматический логин на холодном профиле регулярно отбивается антиботом Google (`signin/rejected`, «This browser or app may not be secure»). Рабочая процедура — ручной вход владельца:

1. `scripts/pool-add.mjs <label> <cdp-port> [priority] [email] [tier]` — позиционные аргументы строго в этом порядке: `<label>` (id в пуле и профиля Chrome `~/.config/google-chrome-<label>`), `<cdp-port>`, `[priority]` (по умолчанию `10`; для `tier=ultra` без явного priority — `1`), `[email]` (без него в `pool.json` пишется заглушка `<label>@example.com`), `[tier]` — `pro` (по умолчанию) или `ultra`. С принудительным `GEMINI_CHROME_BIN` = playwright-хром. **Snap-chromium запрещён**: он игнорирует `--user-data-dir` и пишет в общий системный профиль → перекрёстное заражение сессиями аккаунтов.
2. Headed Chrome под Xvfb на выделенный CDP-порт (`--ozone-platform=x11 --no-sandbox --disable-blink-features=AutomationControlled --user-data-dir=~/.config/google-chrome-<label>`).
3. Web-VNC мост (CDP-screencast → HTTP-polling кадров, клики через playwright mouse API, ввод текста — поле ввода + `insertText`), наружу через `bb connect expose`. Владелец проходит вход и любые верификации сам.

Правила, выведенные из инцидентов 16.11 (`incidents/2026-11-16-argon-manual-logins.md`):

- **Гейт первого визита `/app`**: клиентский отскок `/app → /` с визуально «мёртвой» CTA. Открывается только **реальным кликом владельца** через VNC — synthetic click (playwright mouse, DOM `.click()`) не проходит. Вердикт «нет eligibility у аккаунта» допустим только после того, как не помог и реальный клик.
- **Recovery-speedbump пароля** имеет опцию `Continue`, пропускающую смену пароля. Новый пароль не генерируется, пока пропуск существует в DOM.
- Окно Chrome **не закрывается вручную** после логина (закрытие последнего окна убивает процесс; при не-graceful смерти свежие auth-куки могут не долиться на диск профиля).
- Пароли аккаунтов через `bb secret request`, файл удаляется после использования; передача секретов владельцу — через временную веб-страницу, не через чат.

### 7.3 Проверка пригодности аккаунта после логина

- Личность и бейдж подписки читаются с любой Google-страницы профиля (`[aria-label*="@"]`).
- Пригодность к `/app` — только по факту: редактор `div[contenteditable="true"][role="textbox"]` на `gemini.google.com/app` + успешный `sendPrompt` end-to-end через драйвер (headless, боевой `GEMINI_CHROME_BIN`).
- `signin/rejected` и account-recovery отказ при автоматическом логине — это антибот-защита окружения, **не** доказательство блокировки аккаунта; вердикт по аккаунту — только после ручной попытки.

### 7.4 Ops-команды состояния: `unpark` и `unlock`

Обе команды — сабкоманды `acp-server.mjs`, выполняются под `withStateLock` и завершают процесс (`process.exit(0)`), не поднимая сервер.

- `node acp-server.mjs unpark <id|all>` — снимает парковку и кулдаун: у целевых аккаунтов обнуляет `parkedReason` и `cooldownUntilMs`, у состояния удаляет `state.breaker`. `lockedModels` не трогает — это зона `unlock`.
- `node acp-server.mjs unlock <id|all> [model]` — очищает `lockedModels`, записанные детектором замка (§3.4; до PLUG-282 ложный замок снимался только ручной правкой `accounts-state.json`). С `[model]` удаляет только эту модель из списка (аргумент нормализуется через `resolveModelId` с фолбэком на нижний регистр, чтобы псевдоним `argon` снимал `neon`-блок), без неё — весь список. Если снимается `"carbon"`, дополнительно удаляется записанный `e.tier` — `getAccountTier` возвращается к тарифу из конфигурации пула (§3.3). `cooldownUntilMs`, `parkedReason` и аренды команда не затрагивает — их снимает `unpark`.

---

## 8. Управляемые группы браузера (`src/browser-groups.cjs`, PLUG-374)

Эксплуатационная проблема: процесс Chrome запускается драйвером через `xvfb-run` в отсоединённой группе процессов (`detached: true, unref()`). При падении или перезапуске родительского процесса ACP-сервера процессы Chrome и Xvfb усыновляются `systemd --user` (или `init`) и остаются работать на хосте, удерживая CDP-порт и ресурсы памяти/CPU без активной аренды в `accounts-state.json`.

Модуль `src/browser-groups.cjs` реализует жизненный цикл и безопасную уборку таких групп.

### 8.1 Идентичность и маркеры состояния

- Каждая группа процессов браузера, запущенная драйвером, получает файл маркера `$STATE_DIR/browser-groups/<port>.json`.
- Каталог групп: `$STATE_DIR/browser-groups/` (по умолчанию `~/.bb/plugins/provider-web-gemini/browser-groups/`, фолбэк `~/.bb/plugins/provider-argon/browser-groups/`).
- Маркер содержит проверяемую идентичность группы и владельца (поле `mode` отражает реальный режим запуска из `driver.ensureChrome`: `"xvfb"`, `"native"` или `"visible"`; `profileDir` — каталог профиля внутри `userDataDir`):
  ```json
  {
    "version": 1,
    "port": "9222",
    "pgid": 12345,
    "pgidStartTime": 54321,
    "ownerPid": 12000,
    "ownerStartTime": 54000,
    "bootId": "8f3b2c1a-...",
    "mode": "xvfb",
    "userDataDir": "<profile-user-data-dir>",
    "profileDir": "Default",
    "launchedMs": 1700000000000,
    "adoptedMs": null,
    "reaping": null,
    "doubt": null
  }
  ```
- **Идентичность до порта**: для защиты от переиспользования PGID чужими процессами в ОС фиксируется время старта лидера группы в тиках ядра (`pgidStartTime`, поле 22 `/proc/<pgid>/stat`), а также `ownerStartTime` процесса-владельца.
- Процессы Chrome без маркера (запущенные пользователем или внешними службами) системой никогда не трогаются (строго сохраняются).

### 8.2 Блокировка ядра `flock` и fail-closed `BG_LOCK_UNAVAILABLE`

- Любые операции модификации маркеров (`recordGroup`, `adoptGroup`, `clearReaping`, `removeMarkerUnlocked`, конвейер `teardownGroup`) выполняются под межпроцессной блокировкой ядра:
  - файл замка: `$STATE_DIR/browser-groups/<port>.lock`;
  - блокировка накладывается через системную утилиту `flock` (`flock -x -w <seconds> 3`) на открытом файловом дескрипторе;
  - блокировка удерживается открытым описанием файла (open file description) в ядре Linux. При падении или выходе процесса ядро автоматически снимает блокировку; stale-lock красть не требуется, и держатель блокировки не теряет её при кратковременных паузах;
  - файл `<port>.lock` никогда не удаляется с диска (удаление привело бы к рассинхронизации inode между ожидающими процессами);
  - таймаут ожидания блокировки задаётся переменной окружения `BG_MARKER_LOCK_WAIT_MS` (по умолчанию 10 000 мс / 10 с).
- **Fail-closed на Linux**:
  - на платформе Linux наличие рабочей утилиты `flock` (пакет `util-linux`) является строго обязательным;
  - при отсутствии `flock` на `PATH` или ошибке вызова выбрасывается исключение с кодом `BG_LOCK_UNAVAILABLE` (`markerLockUnavailable`);
  - тихий откат (деградация) к внутрипроцессному словарю на Linux запрещён — иначе параллельные процессы плагина работали бы без взаимной синхронизации;
  - если при создании браузера в `driver.ensureChrome` запись маркера не удалась из-за `BG_LOCK_UNAVAILABLE`, только что запущенный процесс немедленно уничтожается (`process.kill(-proc.pid, 'SIGKILL')`), чтобы не оставить неуправляемую группу без маркера;
  - внутрипроцессный реестр `heldMarkerLocks` служит защитой от повторного входа (reentrancy) в рамках одного процесса, а как фолбэк блокировки используется только на не-Linux платформах.
- Чтение маркеров (`readMarker`, `listMarkers`, `isReaping`) выполняется lock-free, так как запись маркера на диск атомарна (запись в `.tmp`-файл с последующим `fs.renameSync`).

### 8.3 Скоупинг загрузки (`boot_id`) и три состояния `bootState`

PGID и jiffies старта процессов уникальны только в рамках одной загрузки операционной системы. Файлы на диске переживают перезагрузку хоста. Для исключения отправки сигналов чужим процессам после ребута маркеры снабжаются идентификатором загрузки ядра.

- Источник: `/proc/sys/kernel/random/boot_id` (уникальный UUID, генерируемый ядром Linux при каждой загрузке).
- Три состояния функции `bootState()`:
  1. `'off'` — не-Linux окружение: `/proc` и `boot_id` отсутствуют, скоупинг загрузки не применяется (`markerMatchesBoot` возвращает `true`);
  2. `'unknown'` — Linux, но файл `boot_id` не может быть прочитан (EACCES, повреждённый `/proc` в контейнере/песочнице): **FAIL CLOSED**. Маркер может принадлежать как текущей, так и чужой ОС. Функция `markerMatchesBoot` возвращает `null`, группа классифицируется как `'boot-unknown'`. Никакие сигналы не посылаются, группа не усыновляется, и маркер с диска не удаляется;
  3. `<uuid>` — прочитанный UUID текущей загрузки.
- Проверка `markerMatchesBoot(meta)`:
  - `true` — маркер проверен и относится к текущей загрузке ядра (`meta.bootId === currentBootId`);
  - `false` — маркер создан в другой загрузке (или не содержит `bootId`);
  - `null` — неопределённое состояние (`boot-unknown`, fail-closed).
- Маркеры прошлой загрузки классифицируются как `'stale-boot'`: они не дают права посылать сигналы процессам в ОС, так как текущий PGID может принадлежать чужому сервису. Реапер удаляет только устаревший файл маркера на диске, освобождая порт.

### 8.4 Проверка идентичности группы (`identifyGroup`)

Перед отправкой любых сигналов и перед усыновлением выполняется строгая проверка живых процессов группы:
1. **Проверка `markerMatchesBoot`**: выполняется строго до интерпретации PID/PGID/портов. При `false` → `'stale-boot'` (`boot-mismatch` / `boot-unrecorded`), при `null` → `'boot-unknown'` (`boot-unreadable`, fail-closed).
2. **Сканирование членов группы (`groupMembers`)**: через `/proc/*/stat` отбираются живые не-зомби процессы с `pgrp === meta.pgid` (состояние не `'Z'`). Сохраняются `{ pid, startTime, cmdline }`. Если живых членов нет → `'dead'` (`no-members`).
3. **Атрибуция процесса браузерному стеку (`memberLooksOurs`)**:
   - командная строка процесса проверяется регулярным выражением `GROUP_MEMBER_CMDLINE = /xvfb|chrome|chromium|crashpad/i`;
   - время старта процесса не может предшествовать записанному времени старта лидера группы: `m.startTime >= meta.pgidStartTime` (при известном `pgidStartTime`);
   - никаких проверок пути `userDataDir` или флага порта в `memberLooksOurs` не выполняется: атрибуция основана строго на принадлежности бинарника к семейству стека и монотонности времени старта.
4. **Разделение на ветку живого лидера и ветку без лидера (`leader = members.find(m => m.pid === meta.pgid)`)**:
   - **Ветка живого лидера (`leader` найден)**:
     - Проверки лидера выполняются **строго ДО** проверки флага `--remote-debugging-port` (защита от переиспользования PGID чужой группой):
       1. Если `meta.pgidStartTime == null` → статус `'doubtful'` (`leader-starttime-unrecorded`).
       2. Если `leader.startTime !== meta.pgidStartTime` → статус `'doubtful'` (`leader-starttime-mismatch`).
     - Если проверки пройдены:
       - при наличии процесса с флагом `--remote-debugging-port=<port>` (`portFlagInCmdline`) → статус `'matched'` (`port-flag`);
       - при отсутствии флага порта (например, Chrome упал или ещё не стартовал, но лидер `xvfb-run` жив): если все члены группы атрибутируемы (`members.every(m => memberLooksOurs(m, meta))`) → статус `'leftover'` (`attributable-members`), иначе → `'doubtful'` (`unattributed-members`). Таким образом, `'leftover'` возвращается и при живом лидере без флага порта, когда все оставшиеся члены атрибутируемы.
     - *(Окно `MEMBER_LAUNCH_WINDOW_JIFFIES` в ветке живого лидера не применяется: подлинность лидера подтверждена точным совпадением `leader.startTime === meta.pgidStartTime`)*.
   - **Ветка без лидера (leaderless, `leader` завершился)**:
     - Выжившие процессы должны доказать принадлежность исходному запуску:
       1. Если `meta.pgidStartTime == null` → статус `'doubtful'` (`starttime-unrecorded`).
       2. Если хотя бы один член группы не атрибутируем (`!members.every(m => memberLooksOurs(m, meta))`) → статус `'doubtful'` (`unattributed-members`).
       3. **Окно запуска (`MEMBER_LAUNCH_WINDOW_JIFFIES = 3000`)**: самое раннее время старта выживших членов `earliest = Math.min(...members.map(m => m.startTime ?? Infinity))` должно укладываться в окно запуска: `earliest - meta.pgidStartTime <= 3000` джиффи (~30 с при `USER_HZ = 100`). Если члены запустились позже окна запуска → статус `'doubtful'` (`members-postdate-launch`). Это окно применяется **только** в leaderless-ветке, защищая от чужой группы, переиспользовавшей PGID много позже старта нашего браузера.
     - Если проверки пройдены:
       - при наличии процесса с флагом `--remote-debugging-port=<port>` → статус `'matched'` (`port-flag`);
       - при отсутствии флага порта (например, выжил только осиротевший `Xvfb`) → статус `'leftover'` (`attributable-members`).
5. **Действия по результатам классификации**:
   - При `'doubtful'` группе не посылаются никакие сигналы, маркер сохраняется и помечается полем `doubt: { reason, sinceMs }`.
   - При `'dead'` или `'stale-boot'` удаляется устаревший файл маркера без отправки сигналов процессам.
   - При `'boot-unknown'` сигналы не посылаются, маркер сохраняется (fail-closed).
   - Сигналы (`SIGTERM` / `SIGKILL`) разрешено посылать **только** группам со статусом `'matched'` или `'leftover'` (`groupAliveMatches`).

### 8.5 Усыновление (`adoptGroup`)

Когда новый процесс ACP-сервера подключается к уже запущенному браузеру (при рестарте, при вызове `ensureChrome` в драйвере или при захвате аренды в `acquireInState`), он вызывает `browserGroups.adoptGroup(stateDir, port)`:
- под `withMarkerLock` в маркере обновляются поля владельца: `ownerPid = process.pid`, `ownerStartTime = readProcStat(process.pid).startTime`, `adoptedMs = Date.now()`;
- благодаря этому реапер сирот видит живого владельца и не сносит работающую группу.

### 8.6 Гейты занятости: аренда, клиенты CDP и метка `reaping`

Группа считается занятой и защищена от сноса при наличии хотя бы одного из условий:
1. **Гейт активной аренды (`lease`)**: в `accounts-state.json` присутствует активная аренда на данный бэкенд/порт (`leases[backendId].cdp === port`, не просроченная по `LEASE_TTL_MS`, с живым `isPidAlive(l.pid)`).
2. **Гейт живых CDP-клиентов (`cdp-clients`)**: функция `hasLiveCdpClients(port, { ignoreInodes })` проверяет `/proc/net/tcp` и `/proc/net/tcp6` на наличие установленных соединений (`state == '01'`, ESTABLISHED) к CDP-порту. При этом сокеты, принадлежащие самому вызывающему процессу (`ignoreInodes` из `socketInodesOf(process.pid)`), игнорируются, чтобы собственные соединения Playwright не блокировали штатную остановку/перезапуск браузера. Внешние клиенты (например, второй агент или фоновая сессия) блокируют снос.
3. **Гейт старта владельца (`owner-starting`)**: если владелец группы жив (`ownerAlive`), а группа молодая (`launchedMs` или `adoptedMs` младше `DEFAULT_OWNER_GRACE_MS = 60_000` мс), реапер не трогает её, давая процессу Chrome время подняться и открыть порт. Для собственных групп процесса или при явном сносе владельцем (`ownOnly`) этот гейт не применяется.
4. **Метка сноса `reaping` и защита от гонок**:
   - перед отправкой сигналов сноса на маркер ставится отметка `reaping: { by: process.pid, sinceMs: Date.now() }` с TTL `REAPING_TTL_MS = 30_000` мс;
   - функции выбора бэкенда `pickBackendFromState` и привязки `bindBackend` проверяют `reapingBusyUntil`: бэкенд с активной меткой сноса считается занятым и не выдаётся под новые сессии;
   - драйвер в `ensureChrome` при обнаружении `isReaping(runningMeta)` отказывается от переиспользования погибающей группы и выполняет чистый рестарт;
   - это предотвращает гонку, когда свежая аренда могла бы быть выдана на порт в момент отправки `SIGTERM` или ожидания завершения.

### 8.7 Конвейер безопасного сноса (`teardownGroup`)

Снос групп браузера унифицирован в функции `teardownGroup` для реапера и остановки драйвером (`stopChrome`):
1. **Синхронизация**: захват внешнего замка реестра аренд (`withOuterLock` / `withLedgerLock`), затем блокировки маркера (`withMarkerLock`). Порядок захвата всегда строго внешний замок → замок маркера (предотвращение взаимных блокировок).
2. **Проверка маркера и гейтов**: под замками проверяются `ownOnly`, `isReaping`, `ownerAlive` + `ownerGraceMs`, наличие аренды в реестре (`busy`) и наличие внешних клиентов CDP (`hasLiveCdpClients`). При срабатывании любого гейта операция возвращает `{ status: 'busy', reason }`.
3. **Идентификация**: `identifyGroup(cur)`. При `'dead'` или `'stale-boot'` удаляется только файл маркера (`removeMarkerUnlocked`) и возвращается `{ status: 'absent' }`. При `'doubtful'` или `'boot-unknown'` группа пропускается (`{ status: 'skipped' }`).
4. **Первый сигнал (`SIGTERM`)**: на маркер записывается отметка `reaping`, и всей группе посылается `SIGTERM` (`signalGroup(marked, 'SIGTERM')` через `process.kill(-pgid, 'SIGTERM')`).
5. **Ожидание завершения**: замки отпускаются, запускается опрос `waitGroupGone(pgid, { graceMs: 1200 })` до исчезновения всех живых членов группы в `/proc`.
6. **Эскалация до `SIGKILL` с перепроверкой**:
   - если по истечении 1200 мс члены группы ещё живы, под теми же замками (outer + marker) повторно проверяются все условия: неизменность PGID, владельца, метки `reaping`, отсутствие свежей аренды, отсутствие подключившихся CDP-клиентов и соответствие идентичности (`groupAliveMatches`);
   - если условия подтвердились — посылается `SIGKILL` (`process.kill(-pgid, 'SIGKILL')`);
   - если хотя бы одно условие изменилось (например, пришёл клиент CDP) — эскалация ветируется (`escalation-vetoed`), метка `reaping` снимается (`clearReaping`), и группа остаётся жить.
7. **Удаление маркера**: под `withMarkerLock` проверяется, что маркер не был переписан новым процессом, после чего файл маркера удаляется с диска.

### 8.8 Реапер сирот и штатная уборка

- **`reapOrphanBrowserGroups()`**:
  - вызывается при старте `acp-server.mjs` и каждые 60 секунд сторожем `ppidWatch`;
  - сканирует все маркеры в каталоге `$STATE_DIR/browser-groups/`;
  - чистит маркеры `'dead'` и `'stale-boot'`;
  - логирует `'boot-unknown'`;
  - аннотирует `'doubtful'`;
  - для осиротевших групп без живой аренды и без клиентов CDP вызывает `teardownGroup`.
- **`cleanupOwnBrowserGroups()`**:
  - вызывается при штатном завершении `cleanShutdown()` (закрытие stdin, `SIGTERM`, `SIGINT`, смена `ppid`, устаревание кода);
  - находит маркеры, принадлежащие данному процессу (`ownerPid === process.pid`);
  - вызывает `teardownGroup` с флагом `ownOnly: true` и исключением собственных playwright-сокетов (`ignoreInodes: socketInodesOf(process.pid)`);
  - если порт не перехвачен чужой арендой и нет внешних клиентов, группа браузера штатно завершается, предотвращая утечку Chrome и Xvfb.
