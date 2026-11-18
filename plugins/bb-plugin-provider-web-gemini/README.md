# bb-plugin-provider-web-gemini

ACP-провайдер «Gemini Web» (`acp-web-gemini`, обратная совместимость: `acp-argon`) для bb поверх веб-интерфейса `gemini.google.com` без API-ключей.

Провайдер обслуживает семейство моделей веб-Gemini (химические элементы: `argon` [Gemini 4], `carbon`, `hydrogen` и др.).
Транспорт работает по JSON-RPC 2.0 (протокол ACP) через `acp-server.mjs` и управляет изолированными headless-профилями Chrome по Chrome DevTools Protocol (`playwright` или `playwright-core`).

Архитектурное решение и контекст: `docs/adr/0027-provider-argon-acp.md`.
Спецификация: `docs/specs/provider-argon.md`.

## Требования

- Google Chrome (системный `google-chrome-stable` или путь через `GEMINI_CHROME_BIN`);
- `playwright` или `playwright-core` (драйвер пробует сначала `playwright`, затем `playwright-core`);
- Пул аккаунтов (`pool.json`) с авторизованными профилями.

## Модели и возможности

- **`Gemini 4 Argon`** (`argon`) — Код и анализ (модель по умолчанию).
- **`Gemini 4 Carbon`** (`carbon`) — Самые сложные задачи (тариф Ultra).
- **`Gemini 4 Hydrogen`** (`hydrogen`) — Повседневные дела.
- **`Gemini 3.1 Pro`** (`pro`) — Исследования.
- **`Gemini 3.5 Flash-Lite`** (`flash-lite`, псевдоним `fast`) — Быстрые ответы.
- Уровни рассуждений (`thought_level`): **Low**, **Medium**, **High** (`low`, `medium`, `high`).
- Потоковая передача чанков (`supportsStreaming: true`), отмена генерации (`supportsCancel: true`).

## Архитектура

1. **`index.mjs`**: манифест плагина BB (`export default function plugin(bb)`), регистрация основного провайдера `acp-web-gemini` и алиаса обратной совместимости `acp-argon` с возможностями потоковой передачи (`supportsStreaming: true`), отмены (`supportsCancel: true`), уровнями рассуждений `low`, `medium`, `high`.
2. **`acp-server.mjs`**: JSON-RPC 2.0 ACP-сервер (stdio). Управляет пулом аккаунтов (`pool.json`), файлом состояния и эксклюзивной аренды (`accounts-state.json`), разбором времени сброса квот, ротацией и корректным завершением с освобождением аренды при закрытии или `SIGTERM`.
3. **`src/gemini-driver.js`**: веб-драйвер на базе CDP (`playwright` или `playwright-core`), надёжная вставка больших промптов через `execCommand('insertText')`, отслеживание многоходовых ответов строго через `findTurnTarget` без утечки предыдущего ответа, парковка вкладки на `about:blank` в простое для нулевой фоновой нагрузки CPU.
4. **`src/profile-manager.js`**, **`bin/gemini.js`**, **`scripts/`**: утилиты ручного входа в аккаунты Google и управления пулом профилей.

## Универсальная настройка пула аккаунтов

Конфигурация пула задаётся файлом `pool.json` в каталоге состояния (`WEB_GEMINI_POOL_FILE` / `ARGON_POOL_FILE` или `~/.bb/plugins/provider-web-gemini/pool.json`, фолбэк: `~/.bb/plugins/provider-argon/pool.json`):

```json
{
  "accounts": [
    { "id": "acc1", "email": "user1@example.com", "profileDir": "~/.gemini-cli-profile", "cdpPort": 9222, "priority": 10, "tier": "pro" },
    { "id": "acc2", "email": "user2@example.com", "profileDir": "~/.gemini-cli-profile-2", "cdpPort": 9223, "priority": 10, "tier": "ultra" }
  ]
}
```

### Параметры аккаунтов:
- `id`: уникальный идентификатор профиля/аккаунта;
- `email`: контактный email (для информации);
- `profileDir`: путь к каталогу профиля Chrome (`~/` раскрывается автоматически);
- `cdpPort`: порт удалённой отладки Chrome CDP;
- `tier`: тариф аккаунта — `"pro"` (по умолчанию) или `"ultra"`. Запросы к модели Carbon направляются строго на Ultra-аккаунты. При запросах к Argon Pro-аккаунты вызываются первыми, сохраняя квоту Ultra для Carbon;
- `priority`: числовой приоритет аккаунта (по умолчанию `10`). Чем выше приоритет, тем раньше вызывается аккаунт. Значение `priority <= 0` полностью отключает аккаунт.

Также поддерживается обратная совместимость со структурой каталогов `$STATE_DIR/accounts/<label>/backend.json`.

**Выключение аккаунта — два действия**: удалить из `pool.json` И переименовать `accounts/<label>/backend.json` → `backend.json.disabled` (оба файла — независимые источники пула).

### Ручной логин нового аккаунта

Если `scripts/glogin.mjs` упирается в `signin/rejected` (антибот Google на холодном профиле), вход делает владелец через web-VNC: headed-хром под Xvfb на CDP-порту аккаунта + VNC-мост наружу через `bb connect expose`. Процедура и правила (гейт `/app` открывается только реальным кликом владельца; `Continue` на speedbump пароля пропускает смену; не закрывать окно Chrome) — в спецификации `docs/specs/provider-argon.md` §7 и `infra/provider-argon.md` в KB.

## Переменные окружения

Поддерживаются как целевые переменные `WEB_GEMINI_*`, так и прежние `ARGON_*` для полной обратной совместимости:
- `WEB_GEMINI_FAKE=1` / `ARGON_FAKE=1`: офлайн-режим заглушки для тестов протокола (без запуска Chrome и пула).
- `WEB_GEMINI_STATE_DIR` / `ARGON_STATE_DIR`: путь к каталогу состояния (по умолчанию `~/.bb/plugins/provider-web-gemini`, фолбэк: `~/.bb/plugins/provider-argon`).
- `WEB_GEMINI_POOL_FILE` / `ARGON_POOL_FILE`: путь к файлу пула (по умолчанию `$STATE_DIR/pool.json`).
- `WEB_GEMINI_BACKENDS` / `ARGON_BACKENDS`: JSON-массив описаний бэкендов в виде строки.
- `WEB_GEMINI_SEND_DEADLINE_MS` / `ARGON_SEND_DEADLINE_MS`: таймаут генерации на ход (по умолчанию 1 200 000 мс — 20 минут).
- `WEB_GEMINI_MAX_PROMPT_BYTES` / `ARGON_MAX_PROMPT_BYTES`: потолок размера исходящего промпта в байтах UTF-8 (по умолчанию `100000` — ниже порога ~120 КБ, на котором Chrome виснет на `insertText`; `0`/отрицательное — без лимита). При превышении текст задачи переливается в файл-вложение `pkg-<sessionId>-prompt-<ts>.md` (r22, PLUG-303); при ошибке записи файла — отказ `prompt too large: … exceeds limit …` до выбора аккаунта и аренды.
- `WEB_GEMINI_MAX_TOOL_ROUNDS` / `ARGON_MAX_TOOL_ROUNDS`: потолок раундов инструментов чтения за ход (по умолчанию 8; spec `provider-web-gemini-tools`).
- `WEB_GEMINI_MAX_MESSAGE_BYTES` / `ARGON_MAX_MESSAGE_BYTES`: потолок первого сообщения сессии с упакованными вложениями (по умолчанию 120 000 байт).
- `WEB_GEMINI_TOOL_TIMEOUT_MS` / `ARGON_TOOL_TIMEOUT_MS`: таймаут одного вызова локального инструмента (по умолчанию 15 000 мс).
- `WEB_GEMINI_USAGE_REFRESH_MS` / `ARGON_USAGE_REFRESH_MS`: интервал троттлинга сбора лимитов использования на аккаунт (по умолчанию 300 000 мс — 5 минут).
- `WEB_GEMINI_USAGE_TIMEOUT_MS` / `ARGON_USAGE_TIMEOUT_MS`: таймаут сбора лимитов после хода (по умолчанию 10 000 мс).
- `WEB_GEMINI_DEBUG` / `ARGON_DEBUG`: отладочное логирование сбора лимитов и драйвера.
- `GEMINI_MAX_WAIT_MS`: внутренний потолок ожидания стрима в драйвере (по умолчанию 900 000 мс — 15 минут).
- `GEMINI_PARK_IDLE`: парковка вкладки на `about:blank` в простое (`1` по умолчанию, `0` для отключения).
- `GEMINI_PROFILE_DIR`: путь к каталогу профиля Chrome для одиночного профиля по умолчанию.
- `GEMINI_PROFILE`: имя или каталог профиля Chrome для одиночного профиля по умолчанию (по умолчанию `~/.gemini-cli-profile`).
- `GEMINI_CDP_PORT`: порт CDP для одиночного профиля по умолчанию (по умолчанию `9222`).
- `WEB_GEMINI_USE_BUNDLED=1` / `ARGON_USE_BUNDLED=1`: принудительное использование встроенного `acp-server.mjs`.
- `GEMINI_NO_AUTOSPAWN=1`: запрет авто-перезапуска Chrome.

**Разделение пула между OS-пользователями:** `profileDir` в `pool.json` должен быть абсолютным (`~` резолвится в HOME читающего процесса — `pool-add.mjs` пишет абсолютным); `STATE_DIR` общий с default-ACL `rwx` на каталог и `accounts/`; у второго юзера ставить `GEMINI_NO_AUTOSPAWN=1`.

## Тестирование

- Офлайн-тесты: `npm test` (`node --test tests/*.test.mjs`)
- Ручной дымовой тест с живым Chrome: `npm run test:live`
