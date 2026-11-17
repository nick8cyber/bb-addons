---
title: provider-argon — ACP-провайдер веб-интерфейса Gemini (Argon)
status: approved
owner: coordinator
date: 2026-11-17
revision: 16
tags: [bb, plugins, provider-argon, acp, gemini]
---

# provider-argon — ACP-провайдер веб-интерфейса Gemini (Argon)

Плагин `bb-plugin-provider-argon` регистрирует в BB ACP-провайдера `acp-argon` («Gemini (Argon)») поверх веб-интерфейса `gemini.google.com` без API-ключей. Транспорт работает по JSON-RPC 2.0 (протокол ACP) через `acp-server.mjs` и управляет изолированными headless-профилями Chrome по Chrome DevTools Protocol (`playwright` или `playwright-core`).

Архитектурное решение и отвергнутые альтернативы зафиксированы в [ADR 0027](../adr/0027-provider-argon-acp.md). Связанные разделы спеки оркестратора (роли без инструментов `auditor` и `researcher` на `acp-argon`) — [orchestrator.md §§20–21](orchestrator.md).

---

## 1. Архитектура и точки входа

1. **`index.mjs`** — точка входа плагина BB (`export default function plugin(bb: BbPluginApi)`):
   - Манифест плагина в `package.json` объявляет `"name": "bb-plugin-provider-argon"` и контракт манифеста `"bb": { "server": "index.mjs" }`.
   - Регистрирует провайдер `acp-argon` (`displayName: "Gemini (Argon)"`, `badgeLabel: "Argon"`, `byok: false`, `capabilities.supportsCancel: true`, `capabilities.supportsStreaming: true`, `capabilities.reasoningLevels: ["low", "medium", "high"]`, `permissionModes: ["full"]`, `defaultPermissionMode: "full"`).
   - Передаёт в `experimental_acpProviderBridge` команду запуска `acp-server.mjs`:
     - по умолчанию — встроенный `acp-server.mjs` из каталога плагина (`import.meta.url`);
     - при заданном `ARGON_DIR` (или наличии внешнего рабочего каталога `~/.local/share/argon-gemini/acp-server.mjs`) — внешний скрипт, если не задан `ARGON_USE_BUNDLED=1`.
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

- **`initialize`** → возвращает `{ protocolVersion: params.protocolVersion ?? 1, agentInfo: { name: "argon-gemini", version: "0.2.0" }, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } } }`.
- **`session/new` и `session/load`**:
  - `session/new` создаёт новую запись сессии `{ id, cwd, model, thinking, convId, account, backend }`.
  - `sessionId` генерируется глобально уникальным в формате `argon-<pid>-<base36-метка-времени>-<счётчик>` (PLUG-284): счётчик только в памяти процесса давал коллизии `argon-N` между параллельными процессами провайдера и после рестартов — bb отказывал в resume с HTTP 409. Формат строки свободный, внешние потребители его не парсят.
  - `session/load` восстанавливает сессию только в пределах текущего запущенного процесса сервера (из памяти `sessions`); для неизвестного `sessionId` создаётся новая пустая сессия с `convId: null`.
  - Возвращают список моделей `models.availableModels` в виде объектов `{ modelId, name }` по схеме ACP:
    - `'argon'` — «Gemini 4 Argon» (Код и анализ, модель по умолчанию)
    - `'carbon'` — «Gemini 4 Carbon» (Самые сложные задачи, тариф Ultra)
    - `'hydrogen'` — «Gemini 4 Hydrogen» (Повседневные дела)
    - `'pro'` — «Gemini 3.1 Pro» (Исследования)
    - `'flash-lite'` — «Gemini 3.5 Flash-Lite» (Быстрые ответы)
  - Возвращают конфигурационные опции `configOptions`:
    - `model` (категория `"model"`): выбор модели из списка `MODELS` (`argon`, `carbon`, `hydrogen`, `pro`, `flash-lite`), отфильтрованного по совместимости с выбранным аккаунтом (см. предикат `supported` ниже): при явном `s.account` — только модели, поддерживаемые этим аккаунтом; при `s.account === "auto"` — объединение: модель видна, если её поддерживает хотя бы один аккаунт пула (например, `carbon` видна только при наличии незалоченного Ultra-аккаунта);
    - `thought_level` (категория `"thought_level"`): значения `low` / `medium` / `high`, синхронизированные с `capabilities.reasoningLevels` BB (`Low`, `Medium`, `High`);
    - `account` (категория `"account"`, возвращается при наличии более одного аккаунта в пуле): `"auto"` плюс только те аккаунты, которые поддерживают текущую `s.model`; `currentValue` — `s.account`, если он поддерживает `s.model`; иначе единственный поддерживающий аккаунт (правило single-capable); иначе `"auto"`.
  Все опции принимаются и обрабатываются в `session/set_config_option`.
- **Совместимость модели и аккаунта (предикат `supported(model, account)`, PLUG-280)** — зеркало рантайм-проверок `pickBackendFromState`/`bindBackend` (§3): модель поддерживается аккаунтом, если её нет в `accounts-state.json → accounts[<id>].lockedModels` и не выполняется условие `model === "carbon" && tier(account) !== "ultra"` (эффективный тир — `getAccountTier`: `lockedModels` с `carbon` понижает аккаунт до `pro`). Фильтрация двунаправленная и работает только на уровне селекторов: явные ошибки тира/лока в `bindBackend` остаются страховкой под ней. При несовместимости намерением считается только что выбранное значение, а вторая ось откатывается к дефолту:
  - при смене модели (`session/set_model` или `set_config_option` `model`), если явно выбранный `s.account` не поддерживает новую модель, `s.account` сбрасывается в `"auto"` с тем же сбросом `s.backend = null` и `s.convId = null`, что и при смене аккаунта (auto сроутирует на совместимый аккаунт);
  - при смене аккаунта (`set_config_option` `account`), если `s.model` не поддерживается новым аккаунтом, `s.model` сбрасывается в `"argon"` (дефолт).
- **`session/set_model`** — меняет `s.model` через `resolveModelId`; `s.thinking` не изменяет — при незаданном уровне подставляется `medium`; применяет сброс несовместимого аккаунта (см. выше).
- **`session/set_config_option`**:
  - при `configId === "thought_level"` (или `configId === "thinking"`) обновляет уровень мышления `s.thinking`: `"low"` → `"low"`, `"medium"` → `"medium"`, `"high"` → `"high"`, не затрагивая выбранную модель `s.model`;
  - при `configId === "model"` обновляет `s.model` через `resolveModelId` до одного из `argon`, `carbon`, `hydrogen`, `pro`, `flash-lite` (псевдонимы `fast`/`flash`/`lite` → `flash-lite`); неизвестное значение — ошибка -32602 `unknown model`; применяет сброс несовместимого аккаунта (см. выше);
  - при `configId === "account"` обновляет `s.account` (`"auto"` или id аккаунта); при смене аккаунта сбрасывает `s.backend = null` и `s.convId = null`; применяет сброс несовместимой модели в `"argon"` (см. выше).
- **Передача в веб-драйвер**:
  - В драйвер передаётся `model: s.model` (`"argon"` передаётся как есть, без подмены на `"thinking"`, чтобы селектор модели не искал несуществующую модель).
  - Уровни размышлений в UI и словаре драйвера — строго `low` / `medium` / `high` (и их русские аналоги «низкий» / «средний» / «высокий»). Сервер ACP нормализует значение `s.thinking` перед передачей в `sendPrompt`:
    - `"fast"` или `"low"` → `"low"`;
    - `"thinking"` или `"medium"` → `"medium"`;
    - `"pro"` или `"high"` → `"high"`.

### 2.2 Стриминг ответа и отмена (`session/prompt`, `session/cancel`)

- На каждый вызов `session/prompt`:
  1. Текстовые блоки из `params.prompt` склеиваются в строку `text`; при пустом тексте немедленно возвращается `{ stopReason: "end_turn" }`.
  2. **Гард размера промпта (PLUG-281):** `Buffer.byteLength(text)` сверяется с лимитом `ARGON_MAX_PROMPT_BYTES` (см. §4.1). Превышение — немедленный JSON-RPC error `-32000` с сообщением `prompt too large: <N> bytes exceeds limit <L> bytes (ARGON_MAX_PROMPT_BYTES). Shrink the request and retry.` — синхронно в `dispatch`, до очереди `enqueue`, выбора аккаунта и аренды. Это ошибка вызывающего, а не аккаунта: пул, аренды и кулдауны не затрагиваются.
  3. При `ARGON_FAKE=1` сервер отправляет нотификацию `session/update` (`sessionUpdate: "agent_message_chunk"`, `text: "FAKE_ARGON_ECHO: " + text.slice(0, 80)`). Если задана задержка `process.env.ARGON_FAKE_DELAY_MS`, генерация удерживает аренду в течение этой паузы для проверки отмены и корректного завершения. По завершении возвращает `{ stopReason: "end_turn" }`.
  4. В боевом режиме выбирается аккаунт из пула (§3), захватывается аренда через `bindBackend` / `acquireInState`, и драйвер вызывает `sendPrompt` с единым объектом параметров: `{ prompt: text, model: s.model, thinking: mappedThinking, convId: s.convId, isNewChat: !s.convId, cdpPort: backend.cdp, strictModel: true, shouldCancel: () => s.cancelled || abortCtrl.signal.aborted || s.activeGen !== gen, headless: HEADLESS, profile: backend.profileDir || backend.profile || backend.id, strict: true, onChunk, signal: abortCtrl.signal }`.
  5. Каждая дельта `onChunk(delta)` немедленно отправляется нотификацией `session/update` с `sessionUpdate: "agent_message_chunk"`.
  6. После завершения генерации `s.convId` извлекается из `res.convId` (драйвер самостоятельно читает URL вкладки и возвращает `convId` в объекте результата), аренда освобождается (`releaseLease`), и возвращается `{ stopReason: "end_turn" }`.
- **Цикл выполнения инструментов (Tool Loop)**:
  - Полный контракт вызовов, формата упаковки, каталога инструментов и лимитов зафиксирован в [provider-web-gemini-tools.md](provider-web-gemini-tools.md).
  - При первом отправлении на новом `convId` текст сообщения пакуется функцией `packFirstMessage`: формируется системная шапка с каталогом доступных инструментов, автоматические вложения обнаруженных ссылок (`=== file: ... ===`, `=== thread: ... ===`, `=== task: ... ===`) и доступный статус/дифф репозитория (`git status`, `git diff`) в пределах лимита `ARGON_MAX_MESSAGE_BYTES` (по умолчанию 120 000 байт). При переполнении добавляется подсказка `Можно запросить инструментом: ...`.
  - Ответ модели разбирается на XML-теги вызова инструментов `<tool name="..." .../>`.
  - Инструменты выполняются только на чтение в пределах рабочей директории сессии (`cwd`), с проверкой `resolveInCwd`, запретом `..`, симлинков наружу и черным списком секретных файлов (`.env*`, `secrets/*`, `*.pem`, `*.key`).
  - Результаты инструментов форматируются блоками `=== tool: <name> <args> ===` и отправляются единым следующим сообщением в том же `convId` на том же бэкенде под той же активной арендой.
  - Количество раундов ограничено `ARGON_MAX_TOOL_ROUNDS` (по умолчанию 8 раундов). При исчерпании лимита модель принудительно запрашивается сформировать финальный ответ на базе уже полученных данных.
  - Промежуточные вызовы транслируются в тред BB через нотификации протокола ACP: `session/update` с блоками `tool_call` и последующим обновлением статуса `tool_call_update`.
- При получении **`session/cancel`** (как нотификации, так и запроса):
  - отмена инициируется только для сессии, чей `id === params.sessionId`: если `activePromptSessionId === s.id`, вызывается `activePrompt.abort.abort()` (сессии с неизвестным `sessionId` или без него не прерывают чужой активный ход);
  - драйвер перед выходом из `sendPrompt` кликает по кнопке остановки генерации в веб-интерфейсе Gemini (`button[aria-label*="Stop" i], button[aria-label*="Остановить" i]`), чтобы браузерная вкладка немедленно прекратила генерацию;
  - `session/prompt` завершается со `{ stopReason: "cancelled" }` без пометки аккаунта кулдауном.
- При закрытии `stdin` (`rl.on("close")`), а также по сигналам `SIGTERM` и `SIGINT`, `acp-server.mjs` прерывает активный ход (`activePrompt?.abort.abort()`), ожидает завершения вызова драйвера (срабатывание Stop и парковка вкладки на `about:blank`) с таймаутом до 10–15 с, дожидается `releaseLease(activeBackendId)` и только затем завершает процесс. Это гарантирует отсутствие осиротевших аренд и остановку генерации в браузере.
- **Жизненный цикл процесса и сторожа**:
  - Журнал этапов: `slog(stage, extra)` дописывает строки вида `<ISO-ts> pid=<pid> <stage> <json>` в `acp-server.log` в `ARGON_STATE_DIR` — по нему видна точная стадия зависшего или тихого хода (постановка в очередь, аренда, вызов драйвера, стриминг, ошибки).
  - Реапер сирот (только Linux): `reapOrphanAcpServers()` вызывается при старте сервера (`startServer`), сканирует `/proc` и шлёт `SIGTERM` другим процессам `acp-server.mjs` с `ppid == 1` (перерождённым на init), чтобы старые копии не держали профили Chrome и аренды.
  - Сторож родителя: таймер каждые 5 с сравнивает `process.ppid` с захваченным при старте `ownerPpid`; при смене родителя или `ppid === 1` (reparenting на init — родительский мост BB умер) пишет `process:reparented-exit` и вызывает `cleanShutdown()`. Таймер `unref`-нут и сам по себе процесс не держит.
  - Выход по смене кода: в том же 5-секундном цикле, когда нет активного хода (`!activePromptSessionId`), `checkStaleCode()` сравнивает `mtime` файла `acp-server.mjs` с зафиксированным при старте; обновление файла (новая версия плагина) → `server:stale-code-exit` и `cleanShutdown()` — процесс не продолжает работать на устаревшем коде и перезапускается мостом на следующем ходе.

### 2.3 Дедлайны и переменные окружения генерации

- Внешний дедлайн хода в `acp-server.mjs`: `SEND_DEADLINE_MS = Number(process.env.ARGON_SEND_DEADLINE_MS) || 1_200_000` (20 минут, предотвращает обрыв длинных глубоких ревью на `argon` high).
- Внутренний потолок ожидания генерации в `src/gemini-driver.js`: `MAX_WAIT_MS = Number(process.env.GEMINI_MAX_WAIT_MS) || 900_000` (15 минут).
- `ARGON_MAX_TOOL_ROUNDS`: максимальное количество раундов вызова инструментов за один ход (по умолчанию `8`).
- `ARGON_MAX_MESSAGE_BYTES`: максимальный размер первого упакованного сообщения (по умолчанию `120_000` байт).
- `ARGON_TOOL_TIMEOUT_MS`: таймаут выполнения каждого локального инструмента чтения (по умолчанию `15_000` мс / 15 с).

---

## 3. Пул аккаунтов, аренда, кулдауны и ротация

### 3.1 Конфигурация и файл состояния

- Пул аккаунтов читается функцией `loadBackends(stateDir, poolFile)`:
  - Основной источник — `ARGON_POOL_FILE` (по умолчанию `~/.bb/plugins/provider-argon/pool.json`):
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
    1. `ARGON_POOL_FILE` (по умолчанию `$STATE_DIR/pool.json`);
    2. `$STATE_DIR/accounts/<label>/backend.json`;
    3. `~/.config/argon-acp/accounts/*/backend.json` (legacy fallback, только если пул пуст);
    4. `ARGON_BACKENDS` (JSON-массив бэкендов из переменной окружения);
    5. Одиночный профиль по умолчанию: id: "default", profile: "default", profileDir из GEMINI_PROFILE_DIR / GEMINI_PROFILE или ~/.gemini-cli-profile; порт CDP из GEMINI_CDP_PORT или 9222.
  - Утилита `scripts/pool-add.mjs` актуализируется: при добавлении аккаунта она обновляет и `pool.json`, и подкаталог аккаунта.
  - Поле профиля, передаваемое в драйвер: `backend.profileDir || backend.profile || backend.id`. Тильда `~/` раскрывается через `os.homedir()` — **в домашний каталог читающего процесса**. Аккаунты с эффективным приоритетом `<= 0` (§3.3, `getAccountPriority`) исключаются из автоматического выбора.
  - **Разделяемый пул (несколько uid):** когда один `pool.json`/`ARGON_STATE_DIR` читают процессы разных OS-пользователей, `profileDir` обязан быть **абсолютным** — `~` у второго юзера резолвится в его HOME, `resolveProfile` не совпадёт с реальным `--user-data-dir` запущенного Chrome (`profileMatches=false`). `scripts/pool-add.mjs` пишет `profileDir` абсолютным на момент добавления (дом добавившего = владелец профиля).
  - **`GEMINI_NO_AUTOSPAWN=1`** (env): при проверке профиля несовпадении (`profileMatches=false`) или холодном/чужом CDP драйвер **бросает ошибку до** `stopChrome`/авто-спауна Chrome, вместо перезапуска. Обязательно для второго юзера на разделяемом пуле — её процесс не имеет права трогать Chrome первого (чужие профили не рестартуются). Без флага драйвер пытается остановить и перезапустить браузер — допустимо только у владельца пула.
- Состояние хранится в `ARGON_STATE_DIR/accounts-state.json` (по умолчанию `~/.bb/plugins/provider-argon/accounts-state.json`). При разделении между uid'ами каталог общий: второму юзеру нужен default-ACL `rwx` на `ARGON_STATE_DIR` и `accounts/` (аренды/состояние пишутся tmp+rename, inode меняется — прав нужно на каталог, не только на файлы).
- Любая модификация `accounts-state.json` выполняется через `withStateLock(fn)`:
  - захват эксклюзивного файла-замка `accounts-state.json.lock` (`O_CREAT | O_EXCL`);
  - если замок старше `LOCK_STALE_MS = 5000` мс — принудительное снятие устаревшего замка;
  - атомарная запись через временный файл `accounts-state.json.<pid>.<ts>.tmp` + `fs.renameSync`.

### 3.2 Аренда (`leases`) и защита от зависших замков

- Один процесс Chrome (`cdpPort`) в один момент времени обслуживает не более одного активного хода (`leases[backendId] = { pid, acquiredMs }`).
- Пока идёт ход, аренда удерживаемого бэкенда периодически продлевается каждые 60 секунд (периодический таймер обновляет `acquiredMs: Date.now()`), что предотвращает истечение аренды во время длинных ходов (вплоть до `SEND_DEADLINE_MS = 20` минут).
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
  - Из кандидатов исключаются: аккаунт `excludeId`, аккаунты с эффективным приоритетом `<= 0`, при запросе `carbon` — аккаунты с тарифом не `"ultra"`, при запросе любой модели — аккаунты, у которых `lockedModels` содержит эту модель.
  - Среди **свободных** кандидатов (не в кулдауне и без аренды) сначала отбираются аккаунты с **максимальным эффективным приоритетом** (`maxP`) — фильтр по приоритету применяется ДО предпочтения по тарифу.
  - При запросе **`carbon`**: кандидатами являются **только** аккаунты с тарифом `"ultra"`. Аккаунты тарифа `"pro"` исключаются ещё на этапе фильтрации кандидатов.
  - При запросе **`argon`** (или других моделей): предпочтение тарифа **`"pro"`** действует **только среди свободных аккаунтов с равным максимальным приоритетом `maxP`** — чтобы приберечь Ultra-аккаунты для Carbon. Если свободных `pro`-аккаунтов с приоритетом `maxP` нет, выбирается `ultra`-аккаунт с тем же `maxP`; аккаунт с меньшим приоритетом не выбирается, пока есть свободный с `maxP`.
  - Внутри итогового набора выбор — LRU по `lastUsedMs` с тай-брейком по `id`.
  - Если свободных кандидатов нет, ближайшее время освобождения (`busyUntil` / `cooledUntil`) вычисляется только среди кандидатов с максимальным эффективным приоритетом.
- Ручной выбор аккаунта:
  - Если в сессии явно выбран конкретный аккаунт (`s.account !== "auto"`), а запрошена модель `carbon` на аккаунте с тарифом `"pro"`, `bindBackend` возвращает мгновенную понятную ошибку без обращения к браузеру: `account "<id>" has pro tier and does not support Carbon (Ultra tier required)`.

### 3.4 Классификация отказов и ротация

- `classifyFailure(err)` относит ошибку к одной из категорий:
  1. **`auth-dead`** (`CooldownMs = 7 * 24 * 3600_000`): `"not logged in"`, `"Sign in"`, `"Войти"`, `"check login status"`.
  2. **`model-locked`** (`CooldownMs = 0`, `rotatable: true`): ошибка `err.isLocked` детектора замка §3.4 (вид `<model> locked: paid upgrade required`). Не накладывает временной кулдаун на аккаунт, записывает `lockedModels: [<lockedModel>]` (и `tier: "pro"` при `carbon`) в состояние аккаунта, и немедленно инициирует прозрачную ротацию на следующий аккаунт.
  3. **`rate-limit`** (`CooldownMs = parsedResetMs || 30 * 60_000`): `"rate-limit"`, `"rate limit"`, `"quota"`, `"limit resets"`, `"thinking level unavailable"`, `"thinking level is rate-limited"`, `"try again later"`, `"too many requests"`, `"лимит"`, `"повторите попытку позже"`.
  4. **`model-unavailable`** (`CooldownMs = 6 * 3600_000`): `"modelunavailable"`, `"model is unavailable"`, `"not available for this account"`, `"недоступна"` — **только по DOM-доказательству**: драйвер бросает `ModelUnavailable` (`code = "ARGON_MODEL_UNAVAILABLE"`) лишь когда пункт реально отсутствует в меню выбора, уровень отключён/залочен, или есть апсейл-диалог. Сбои селекторов, таймауты `waitForSelector`, ошибки навигации/клика в `selectModelAndThinking` при `strict` **пробрасываются как есть** (`throw err`) и классифицируются как `transient` — аккаунт не паркуется (PLUG-286: раньше catch-all заворачивал их в `ModelUnavailable` → 6 ч кулдауна по ложному поводу).
  5. **`transient`** (без кулдауна аккаунта, но с попыткой переключения на другой свободный аккаунт в рамках текущего хода): сетевые/CDP сбои, таймаут ожидания генерации.
- Итоговый кулдаун ограничен потолком 7 суток: `Math.min(cooldownMs, 7 * 86_400_000)`.
- Разбор времени сброса квоты `parseResetTimeMs(msg, nowMs)` поддерживает:
  - английские форматы: `"Limit resets 2:19 AM"`, `"Limit resets at 14:30"`, `"Limit resets tomorrow at 11:00 AM"`, `"Limit resets Oct 15, 2:19 AM"`, `"Limit resets on Nov 16, 11:00 PM"`;
  - русские форматы: `"Лимит обновится в 14:30"`, `"Лимит сбросится завтра в 09:15"`.
  Правило переноса года: если дата в сообщении указана без года (например, `"Oct 15"`), то если вычисленная дата оказывается раньше текущей больше чем на 30 дней (`targetMs < nowMs - 30 * 86_400_000`), она переносится на следующий год, иначе остаётся в текущем году. К вычисленному времени добавляется буфер 2 минуты (`+ 2 * 60_000`).
- **Детектирование значка замка и строгий выбор уровня мышления** (точный предикат — PLUG-282, ложнопозитивы 16.11 помечали `argon` залоченным на аккаунтах, где модель доступна):
  - `menuItemHasLockIcon(el)` — замком считается **только визуально видимая** иконка (`offsetParent !== null`) внутри именно этого пункта меню, чья Material-идентичность **точно** равна `lock`/`lock-filled` по одному из каналов: `innerText` === `'lock'`, `data-mat-icon-name`/`aria-label` === `'lock'`/`'lock-filled'`, либо точный токен `'lock'`/`'lock-filled'` среди классов (split по пробелам с равенством). Подстроки в `className`/`innerText` — `'unlock'`, `'lock_open'`, `'mat-icon-lock-reset'` — замком **не** являются. Если замок обнаружен, драйвер не совершает клик по платному пункту (чтобы не вызывать модальное окно с предложением сменить план) и сразу выбрасывает `ModelUnavailable('model', '<model> locked: paid upgrade required')` с `isLocked = true` и `lockedModel`.
  - Замок по посткликовому диалогу (заблокированная модель кликабельна — клик открывает апсейл) засчитывается только при **двух** условиях: диалог появился **прямым откликом на клик** по этому пункту **и** несёт явный апгрейд-CTA:
    - перед кликом (strict-путь) `markVisibleDialogs` помечает все видимые диалоги атрибутом `data-argon-pre-click`; `upsellDialogConfirmsLock` пропускает помеченные — открытое ранее промо, даже с кнопкой смены плана, замком не является (показ скрытого до клика диалога — отклик, он не помечен);
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
  - Лимит — `ARGON_MAX_PROMPT_BYTES` (не задан → `100000`, ниже наблюдаемого обрыва ~120 КБ; `0`/отрицательное → без лимита; нечисловое значение → дефолт). При реализации упаковки первого сообщения и инструментов (PLUG-278): потолок упаковки `ARGON_MAX_MESSAGE_BYTES` обязан быть `≤ ARGON_MAX_PROMPT_BYTES − ~4 КБ` (запас на системную шапку инструментов), иначе упаковка сама соберёт заведомо неотправимое сообщение; заданное большим значение логируется и зажимается до потолка.
  - `session/prompt`: отказ синхронно в `dispatch` сразу после склейки блоков — JSON-RPC error `-32000`, message `prompt too large: <N> bytes exceeds limit <L> bytes (ARGON_MAX_PROMPT_BYTES). Shrink the request and retry.` — до `enqueue`, выбора аккаунта и аренды (§2.2 п.2).
  - `sendPrompt` драйвера: `throwIfPromptTooLarge` — первая строка функции, до `ensureChrome`, подключения CDP и любой работы со страницей; это последний рубеж для всех отправок в Gemini (включая будущие отправки первого сообщения и раундов инструментов PLUG-278), включая повторную проверку после чтения `maxlength` поля ввода (эффективный лимит = `min(env, maxlength)`; `contenteditable` maxlength не несёт — тогда действует только env).
  - Ошибка `ARGON_PROMPT_TOO_LARGE` — ошибка вызывающего, а не аккаунта: в `runPrompt` она пробрасывается без `probeAuthHint`, классификации, ротации и кулдауна (аренда лишь освобождается), а в ответ агенту уходит verbatim без обёртки `Gemini web driver error:`.
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
  - берётся элемент `target = responses[idx]`; если он отсутствует — возвращается `null`;
  - проверяется список узлов `<user-query>`. Последний запрос `lastQuery` должен содержать нормализованный префикс промпта (первые 40 символов промпта с нормализацией повторяющихся пробельных символов `norm(lastQuery.innerText).includes(norm(promptPrefix).slice(0, 40))`);
  - проверяется порядок в DOM: целевой ответ `target` должен следовать строго после `lastQuery` (`lastQuery.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING`);
  - при невыполнении любого условия возвращается `null`.
- Для отслеживания текста и проверки завершения генерации (`currentText`, `hasFinishedContent`):
  - обращения идут строго через `findTurnTarget(document, idx, promptPrefix)`;
  - **запрещён** откат к `responses[responses.length - 1]`, так как на втором и последующих ходах (`isNewChat: false`, `initialCount >= 1`) до появления нового `<model-response>` последним элементом массива в DOM является ответ предыдущего хода, что приводило к мгновенному ложному завершению хода со старым текстом.

### 4.3 Захват `convId` и парковка вкладки (`about:blank`) в простое

- После завершения стриминга на новом чате (`isNewChat: true`) URL вкладки (`https://gemini.google.com/app/<convId>`) может обновиться с небольшой задержкой. Драйвер опрашивает `page.url()` до 3 секунд (с шагом 200 мс), пока URL не совпадёт с `/\/app\/([a-f0-9]{8,})/i`, и возвращает найденный `convId` в объекте результата `{ text, thinking, meta, convId }`.
- Открытая вкладка `gemini.google.com/app/...` в фоновом процессе Chrome непрерывно крутит анимации и таймеры Angular/Material, потребляя ~20–25% CPU на каждый инстанс Chrome в простое.
- Чтобы устранить фоновую нагрузку на CPU, в блоке `finally` метода `sendPrompt` (после захвата `convId` и перед `disconnect()`) при `process.env.GEMINI_PARK_IDLE !== '0'` драйвер переводит рабочую вкладку на `about:blank` (`await page.goto('about:blank', { timeout: 5000 }).catch(() => {})`).
- **Навигация на 2+ ходе и выход из парковки `about:blank`**:
  - Перед началом ввода промпта драйвер проверяет текущий URL (`page.url()`); если вкладка запаркована на `about:blank`, драйвер выполняет переход:
    `await page.goto(convId ? `https://gemini.google.com/app/${convId}` : GEMINI_APP_URL, { timeout: 15000 })`.
  - При наличии `convId` в сессии восстанавливается контекст беседы; если `convId` отсутствует (например, ход 1 был отменён до извлечения ID), выполняется переход на новый чат `GEMINI_APP_URL`. В обоих случаях поиск редактора и ввод текста не зависают на `about:blank`.

### 4.4 Сбор лимитов Gemini Web (`batchexecute`) и файл состояния `accounts-usage.json` (PLUG-289)

- **Назначение:** парсинг лимитов Gemini Web (5-часовое скользящее окно `daily` и недельный лимит `weekly`) по каждому аккаунту пула и запись в `$ARGON_STATE_DIR/accounts-usage.json` для последующего чтения плагином Usage Pro.
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
  - **Таймаут и изоляция сбоев хода:** вызов `captureUsageLimits` в `finally` ограничен `Promise.race` с таймаутом `ARGON_USAGE_TIMEOUT_MS` (по умолчанию 10 000 мс). Любой сбой (сетевой, таймаут, отсутствие `SNlM0e`, смена формата) логируется только в debug-режиме (`ARGON_DEBUG`) и ни при каких условиях не влияет на результат или ошибку хода.
  - **Троттлинг:** не чаще одного раза в `ARGON_USAGE_REFRESH_MS` (дефолт 300 000 мс / 5 минут) на каждый аккаунт. Троттлинг проверяется в памяти процесса и по штампу `updatedAt` в `accounts-usage.json`.
- **Формат файла `$ARGON_STATE_DIR/accounts-usage.json`:**
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

---

## 5. Переносимость и гигиена репозитория

- Во всех файлах плагина (`src/gemini-driver.js`, `src/profile-manager.js`, `bin/gemini.js`, `scripts/glogin.mjs`, `scripts/pool-add.mjs`, `acp-server.mjs`, `index.mjs`) запрещены жёстко зашитые пути домашнего каталога конкретной машины (`/home/...`), идентификаторы сущностей BB (`thr_...`, `proj_...`, `env_...`) и личные почтовые адреса.
- Базовый домашний каталог всегда вычисляется через `os.homedir()`, а пути внутри пакета — через `new URL(..., import.meta.url)` или `path.dirname(fileURLToPath(import.meta.url))`.
- В `scripts/glogin.mjs` отладочный скриншот сохраняется только при явно заданной переменной окружения `GLOGIN_SCREENSHOT`.
- В `scripts/pool-add.mjs` путь к Chrome определяется переносимо через `process.env.GEMINI_CHROME_BIN || process.env.CHROME_BIN` с проверкой стандартных системных путей (`/usr/bin/google-chrome-stable`, `google-chrome`, `chromium`), без привязки к конкретной архитектуре или временной сборке Chromium в кэше пользователя.

---

## 6. Тестирование и верификация (`npm test`)

- В `plugins/bb-plugin-provider-argon/package.json`:
  - `"test": "node --test tests/*.test.mjs"` — автономный офлайн-набор тестов на `node:test`, не требующий запущенного Chrome и сети (выполняется при проверке `scripts/check-changed-plugins.sh` и на шаге 3 конвейера `release`);
  - `"test:live": "node tests/test-driver.js"` — ручной дымовой прогон против живого Chrome.
- Офлайн-тесты (`tests/provider-argon.test.mjs`) проверяют:
  1. Синтаксическую корректность (`node --check`) всех `.js`/`.mjs` файлов плагина и отсутствие запрещённых подстрок (`/home/`, `thr_`, личных email) в отслеживаемых файлах плагина.
  2. Полный цикл JSON-RPC в `acp-server.mjs` (`ARGON_FAKE=1` с временным `ARGON_STATE_DIR` и `ARGON_POOL_FILE`): `initialize`, `session/new`, `session/set_model`, `session/set_config_option`, `session/prompt` (стриминг `agent_message_chunk` + `stopReason: "end_turn"`), `session/cancel` (`stopReason: "cancelled"`), автоматическое снятие аренды при закрытии `stdin` / `SIGTERM`. Поддержка `ARGON_FAKE_DELAY_MS` для проверки удержания аренды во время выполнения запроса и корректного освобождения аренды при отмене хода и `SIGTERM`.
  3. Функции `parseResetTimeMs` и `classifyFailure` на всех вариантах английских и русских сообщений о лимитах, недоступности уровня `thinking` и истечении дедлайна.
  4. Строгий режим `selectModelAndThinking` (`isDisabled` при `strict: true` порождает `rate-limit` ошибку `thinking level is rate-limited`) и индекс `responses[idx]` без отката к `responses[responses.length - 1]`.
  5. Гард размера промпта (PLUG-281): отказ `ARGON_PROMPT_TOO_LARGE` на границе драйвера (`sendPrompt` до `ensureChrome`/CDP) и немедленный синхронный ответ `-32000` в `session/prompt` до выбора аккаунта и захвата аренды; подсчёт размера в байтах UTF-8; проход промпта размером `<=` лимита `ARGON_MAX_PROMPT_BYTES`.
  6. Умную маршрутизацию `pickBackendFromState`: выбор `pro`-аккаунтов для `argon` и `ultra` для `carbon`, разрешение эффективного приоритета (`state` → `pool` → дефолт `10`, `<= 0` исключает аккаунт), учёт `lockedModels` и LRU по `lastUsedMs` (§3.3).
  7. Жизненный цикл процесса и селекторы драйвера: запись `slog` в `acp-server.log`, `reapOrphanAcpServers` (снятие осиротевших acp-server), visible-селекторы (`gem-menu-item[data-mode-id]:visible`) и русские подписи (`Загрузить файлы`, `Удалить`) в `gemini-driver.js`.
  8. Двунаправленную фильтрацию селекторов model ↔ account (PLUG-280): ограничение списка моделей возможностями выбранного аккаунта (union по пулу при s.account === "auto"), ограничение списка аккаунтов поддержкой текущей модели, правило single-capable для currentValue аккаунта, сброс несовместимого аккаунта в "auto" при смене модели и сброс несовместимой модели в "argon" при смене аккаунта.
  9. Разбор batchexecute wrb.fr фреймов функцией `parseUsageLimits` (daily/weekly, проценты, reset epoch sec, самолечение recipe при смене rpcid) (§4.4).
  10. Multi-process merge-логика и атомарная запись `accounts-usage.json` (сохранение чужих аккаунтов пула при параллельных обновлениях, слияние со снапшотом предыдущего состояния без затирания частичных метрик, сохранение `tier: ultra`, защита файла замка через уникальный токен `pid:ts:random`) (§4.4).
  11. Гейтинг и троттлинг `captureUsageLimits` (пропуск вызова на `about:blank`, соблюдение `ARGON_USAGE_REFRESH_MS`, обход через `force: true`, изоляция таймаута браузерного запроса и батчинг кандидатов RPC ID) (§4.4).
  12. Интеграция `sendPrompt` с фиксацией лимитов в `finally` (вызов как при успешном ответе, так и при сбое/rate-limit хода, отсутствие зависания при медленном или зависшем `captureUsageLimits`, проброс `backend.tier`) (§4.4).
  13. Точный предикат замка и ops-очистку `lockedModels` (PLUG-282): `menuItemHasLockIcon` на DOM-фикстурах — видимый замок по каждому каналу (innerText/data-mat-icon-name/aria-label/class-токен) детектится, `'unlock'`/`'lock_open'`/`'mat-icon-lock-reset'`/скрытая иконка — нет; `upsellDialogConfirmsLock` — промо с ценой без план-CTA не замок и не дисмиссится, диалог с `Сменить план` — замок с дисмиссом, скрытый диалог игнорируется, помеченный `data-argon-pre-click` диалог с CTA — не замок, вызовы без аргумента берут `globalThis.document` и не падают без него; e2e `selectModelAndThinking` — пункт с иконкой `unlock` кликается, промо-попап после клика не лочит, диалог-отклик с CTA лочит (`isLocked`/`lockedModel`), предсуществующий CTA-промо не лочит, выбравшаяся модель гасит замок; ops `node acp-server.mjs unlock <id|all> [model]` — точечное снятие модели, `all`, восстановление `tier` при снятии `carbon`, кулдаун и `parkedReason` не трогаются.
- Набор `tests/provider-web-gemini-tools.test.mjs` (47 тестов, офлайн) покрывает инструменты чтения веб-Gemini по спеке `provider-web-gemini-tools.md`: разбор текстового протокола вызовов инструментов, sandbox `cwd` (запрет `..`, абсолютных путей и симлинков наружу, чёрный список чувствительных файлов), белый список `git`-команд, маскировку секретов `[скрыто: <тип>]`, раунды tool-loop и лимит `ARGON_MAX_TOOL_ROUNDS`, упаковку первого сообщения (вложения файлов/тредов/задач, потолок `ARGON_MAX_MESSAGE_BYTES`).

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
- `node acp-server.mjs unlock <id|all> [model]` — очищает `lockedModels`, записанные детектором замка (§3.4; до PLUG-282 ложный замок снимался только ручной правкой `accounts-state.json`). С `[model]` удаляет только эту модель из списка, без неё — весь список. Если снимается `"carbon"`, дополнительно удаляется записанный `e.tier` — `getAccountTier` возвращается к тарифу из конфигурации пула (§3.3). `cooldownUntilMs`, `parkedReason` и аренды команда не затрагивает — их снимает `unpark`.
