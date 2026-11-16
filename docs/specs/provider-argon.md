---
title: provider-argon — ACP-провайдер веб-интерфейса Gemini (Argon)
status: approved
owner: coordinator
date: 2026-11-16
revision: 8
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
4. **`src/profile-manager.js`, `bin/gemini.js`, `scripts/glogin.mjs`, `scripts/pool-add.mjs`** — CLI и утилиты управления профилями и интерактивного входа в аккаунты пула.

---

## 2. Протокол ACP (`acp-server.mjs`)

### 2.1 Инициализация и сессии

- **`initialize`** → возвращает `{ protocolVersion: params.protocolVersion ?? 1, agentInfo: { name: "argon-gemini", version: "0.2.0" }, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } } }`.
- **`session/new` и `session/load`**:
  - `session/new` создаёт новую запись сессии `{ id, cwd, model, thinking, convId, account, backend }`.
  - `session/load` восстанавливает сессию только в пределах текущего запущенного процесса сервера (из памяти `sessions`); для неизвестного `sessionId` создаётся новая пустая сессия с `convId: null`.
  - Возвращают список моделей `models.availableModels` в виде объектов `{ modelId, name }` по схеме ACP:
    - `'argon'` — «Gemini 4 Argon» (модель по умолчанию)
    - `'carbon'` — «Gemini 4 Carbon» (топовая модель, доступная на тарифе Ultra)
    - `'fast'` — «Gemini 2.5 Flash»
    - `'pro'` — «Gemini 2.5 Pro»
  - Возвращают конфигурационные опции `configOptions`:
    - `model` (категория `"model"`): выбор модели из списка `MODELS` (`argon`, `carbon`, `fast`, `pro`);
    - `thought_level` (категория `"thought_level"`): значения `low` / `medium` / `high`, синхронизированные с `capabilities.reasoningLevels` BB (`Low`, `Medium`, `High`);
    - `account` (категория `"account"`, возвращается при наличии более одного аккаунта в пуле): выбор аккаунта (`"auto"` или конкретный `id` аккаунта).
  Все опции принимаются и обрабатываются в `session/set_config_option`.
- **`session/set_model`** — меняет `s.model` и синхронизирует `s.thinking` по умолчанию (`medium` для `argon` и `carbon`).
- **`session/set_config_option`**:
  - при `configId === "thought_level"` (или `configId === "thinking"`) обновляет уровень мышления `s.thinking`: `"low"` → `"low"`, `"medium"` → `"medium"`, `"high"` → `"high"`, не затрагивая выбранную модель `s.model`;
  - при `configId === "model"` обновляет `s.model` (`argon`, `carbon`, `fast`, `pro`);
  - при `configId === "account"` обновляет `s.account` (`"auto"` или id аккаунта); при смене аккаунта сбрасывает `s.backend = null` и `s.convId = null`.
- **Передача в веб-драйвер**:
  - В драйвер передаётся `model: s.model` (`"argon"` передаётся как есть, без подмены на `"thinking"`, чтобы селектор модели не искал несуществующую модель).
  - Уровни размышлений в UI и словаре драйвера — строго `low` / `medium` / `high` (и их русские аналоги «низкий» / «средний» / «высокий»). Сервер ACP нормализует значение `s.thinking` перед передачей в `sendPrompt`:
    - `"fast"` или `"low"` → `"low"`;
    - `"thinking"` или `"medium"` → `"medium"`;
    - `"pro"` или `"high"` → `"high"`.

### 2.2 Стриминг ответа и отмена (`session/prompt`, `session/cancel`)

- На каждый вызов `session/prompt`:
  1. Текстовые блоки из `params.prompt` склеиваются в строку `text`; при пустом тексте немедленно возвращается `{ stopReason: "end_turn" }`.
  2. При `ARGON_FAKE=1` сервер отправляет нотификацию `session/update` (`sessionUpdate: "agent_message_chunk"`, `text: "FAKE_ARGON_ECHO: " + text.slice(0, 80)`). Если задана задержка `process.env.ARGON_FAKE_DELAY_MS`, генерация удерживает аренду в течение этой паузы для проверки отмены и корректного завершения. По завершении возвращает `{ stopReason: "end_turn" }`.
  3. В боевом режиме выбирается аккаунт из пула (§3), захватывается аренда через `bindBackend` / `acquireInState`, и драйвер вызывает `sendPrompt` с единым объектом параметров: `{ prompt: text, model: s.model, thinking: mappedThinking, convId: s.convId, isNewChat: !s.convId, cdpPort: backend.cdp, strictModel: true, shouldCancel: () => s.cancelled || abortCtrl.signal.aborted || s.activeGen !== gen, headless: HEADLESS, profile: backend.profileDir || backend.profile || backend.id, strict: true, onChunk, signal: abortCtrl.signal }`.
  4. Каждая дельта `onChunk(delta)` немедленно отправляется нотификацией `session/update` с `sessionUpdate: "agent_message_chunk"`.
  5. После завершения генерации `s.convId` извлекается из `res.convId` (драйвер самостоятельно читает URL вкладки и возвращает `convId` в объекте результата), аренда освобождается (`releaseLease`), и возвращается `{ stopReason: "end_turn" }`.
- При получении **`session/cancel`** (как нотификации, так и запроса):
  - отмена инициируется только для сессии, чей `id === params.sessionId`: если `activePromptSessionId === s.id`, вызывается `activePrompt.abort.abort()` (сессии с неизвестным `sessionId` или без него не прерывают чужой активный ход);
  - драйвер перед выходом из `sendPrompt` кликает по кнопке остановки генерации в веб-интерфейсе Gemini (`button[aria-label*="Stop" i], button[aria-label*="Остановить" i]`), чтобы браузерная вкладка немедленно прекратила генерацию;
  - `session/prompt` завершается со `{ stopReason: "cancelled" }` без пометки аккаунта кулдауном.
- При закрытии `stdin` (`rl.on("close")`), а также по сигналам `SIGTERM` и `SIGINT`, `acp-server.mjs` прерывает активный ход (`activePrompt?.abort.abort()`), ожидает завершения вызова драйвера (срабатывание Stop и парковка вкладки на `about:blank`) с таймаутом до 10–15 с, дожидается `releaseLease(activeBackendId)` и только затем завершает процесс. Это гарантирует отсутствие осиротевших аренд и остановку генерации в браузере.

### 2.3 Дедлайны генерации

- Внешний дедлайн хода в `acp-server.mjs`: `SEND_DEADLINE_MS = Number(process.env.ARGON_SEND_DEADLINE_MS) || 1_200_000` (20 минут, предотвращает обрыв длинных глубоких ревью на `argon` high).
- Внутренний потолок ожидания генерации в `src/gemini-driver.js`: `MAX_WAIT_MS = Number(process.env.GEMINI_MAX_WAIT_MS) || 900_000` (15 минут).

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
  - Поле профиля, передаваемое в драйвер: `backend.profileDir || backend.profile || backend.id`. Тильда `~/` раскрывается через `os.homedir()`. Аккаунты с `priority === 0` исключаются из автоматического выбора.
- Состояние хранится в `ARGON_STATE_DIR/accounts-state.json` (по умолчанию `~/.bb/plugins/provider-argon/accounts-state.json`).
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
- Выбор бэкенда в режиме `account: "auto"` (`pickBackendFromState`):
  - При запросе **`carbon`**: кандидатами являются **только** аккаунты с тарифом `"ultra"`. Аккаунты тарифа `"pro"` исключаются.
  - При запросе **`argon`** (или других моделей): кандидатами являются все активные аккаунты, но среди свободных в первую очередь выбираются аккаунты с тарифом **`"pro"`**, чтобы приберечь Ultra-аккаунты для Carbon. Если все `pro`-аккаунты заняты или находятся в кулдауне, пул задействует `ultra`-аккаунт как резервный.
- Ручной выбор аккаунта:
  - Если в сессии явно выбран конкретный аккаунт (`s.account !== "auto"`), а запрошена модель `carbon` на аккаунте с тарифом `"pro"`, `bindBackend` возвращает мгновенную понятную ошибку без обращения к браузеру: `account "<id>" has pro tier and does not support Carbon (Ultra tier required)`.

### 3.4 Классификация отказов и ротация

- `classifyFailure(err)` относит ошибку к одной из категорий:
  1. **`auth-dead`** (`CooldownMs = 7 * 24 * 3600_000`): `"not logged in"`, `"Sign in"`, `"Войти"`, `"check login status"`.
  2. **`model-locked`** (`CooldownMs = 0`, `rotatable: true`): ошибка вида `carbon locked: paid upgrade required` или значок замка (`<mat-icon>lock</mat-icon>`). Не накладывает временной кулдаун на аккаунт, записывает `lockedModels: ["carbon"]` и `tier: "pro"` в состояние аккаунта, и немедленно инициирует прозрачную ротацию на следующий аккаунт.
  3. **`rate-limit`** (`CooldownMs = parsedResetMs || 30 * 60_000`): `"rate-limit"`, `"rate limit"`, `"quota"`, `"limit resets"`, `"thinking level unavailable"`, `"thinking level is rate-limited"`, `"try again later"`, `"too many requests"`, `"лимит"`, `"повторите попытку позже"`.
  4. **`model-unavailable`** (`CooldownMs = 6 * 3600_000`): `"modelunavailable"`, `"model is unavailable"`, `"not available for this account"`, `"недоступна"`.
  5. **`transient`** (без кулдауна аккаунта, но с попыткой переключения на другой свободный аккаунт в рамках текущего хода): сетевые/CDP сбои, таймаут ожидания генерации.
- Итоговый кулдаун ограничен потолком 7 суток: `Math.min(cooldownMs, 7 * 86_400_000)`.
- Разбор времени сброса квоты `parseResetTimeMs(msg, nowMs)` поддерживает:
  - английские форматы: `"Limit resets 2:19 AM"`, `"Limit resets at 14:30"`, `"Limit resets tomorrow at 11:00 AM"`, `"Limit resets Oct 15, 2:19 AM"`, `"Limit resets on Nov 16, 11:00 PM"`;
  - русские форматы: `"Лимит обновится в 14:30"`, `"Лимит сбросится завтра в 09:15"`.
  Правило переноса года: если дата в сообщении указана без года (например, `"Oct 15"`), то если вычисленная дата оказывается раньше текущей больше чем на 30 дней (`targetMs < nowMs - 30 * 86_400_000`), она переносится на следующий год, иначе остаётся в текущем году. К вычисленному времени добавляется буфер 2 минуты (`+ 2 * 60_000`).
- **Детектирование значка замка и строгий выбор уровня мышления**:
  - При выборе модели `carbon` драйвер проверяет наличие значка замка (`mat-icon`, `gem-icon` с текстом или атрибутом `lock`). Если замок обнаружен, драйвер не совершает клик по платному пункту (чтобы не вызывать модальное окно с предложением сменить план) и сразу выбрасывает `ModelUnavailable('model', 'carbon locked: paid upgrade required')` с `isLocked = true`.
  - Если в меню выбора режима мышления (`selectModelAndThinking`) запрошенный пункт (`Fast`, `Thinking` или `Pro`) имеет `isDisabled === true` (`aria-disabled="true"` / класс `disabled`), при `strict: true` драйвер обязан выбросить `new ModelUnavailable('thinking', '<thinking> thinking level is rate-limited (<reset text>)')` **до** общей проверки `if (strict) throw new ModelUnavailable('thinking', ... 'not found')`.
  - Благодаря этому `acp-server.mjs` классифицирует отказ как `rate-limit` с точным временем сброса из текста меню (`Limit resets ...`). Для новых чатов (когда `!s.convId` и клиенту ещё не отправлен ни один чанк `!streamedAny`) сервер прозрачно переключает запрос на следующий свободный аккаунт пула, не блокируя аккаунт на 6 часов как `model-unavailable`.
  - Ротация на следующий аккаунт пула при исчерпании лимита или временной ошибке выполняется **только** для новых чатов (до фиксации `s.convId` и до отправки первого чанка клиенту). Если беседа уже имеет зафиксированный `s.convId`, она остаётся строго привязана к своему аккаунту (`s.backend`), так как история и ID беседы принадлежат конкретному аккаунту Google. Запрос не переключается на другие аккаунты пула, и обрабатываются два случая:
    - если закреплённый аккаунт находится в кулдауне, сразу возвращается ошибка: `account "<id>" is in cooldown until ...; this conversation is pinned to it`;
    - если закреплённый аккаунт занят другим ходом, сервер ждёт освобождения аренды до 130 с (`waitDeadline = Date.now() + 130_000`, `WAIT_BUSY_MS`), опрашивая замок, и только если аренда не освободилась, возвращает ошибку `account "<id>" is busy until...`.

---

## 4. Веб-драйвер (`src/gemini-driver.js`)

### 4.1 Надёжная вставка больших промптов и однократная отправка

- Промпты ревью и аудита могут достигать 50–150 КБ и содержать тысячи строк.
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
