# bb-plugin-provider-argon

ACP-провайдер «Gemini (Argon)» (`acp-argon`) для bb поверх веб-интерфейса `gemini.google.com` без API-ключей.

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

## Универсальная настройка пула аккаунтов

Конфигурация пула задаётся файлом `pool.json` в каталоге состояния (`ARGON_POOL_FILE` или `~/.bb/plugins/provider-argon/pool.json`):

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

**Выключение аккаунта — два действия**: удалить из `pool.json` И переименовать `accounts/<label>/backend.json` → `backend.json.disabled` (оба файла — независимые источники пула).

### Ручной логин нового аккаунта

Если `scripts/glogin.mjs` упирается в `signin/rejected` (антибот Google на холодном профиле), вход делает владелец через web-VNC: headed-хром под Xvfb на CDP-порту аккаунта + VNC-мост наружу через `bb connect expose`. Процедура и правила (гейт `/app` открывается только реальным кликом владельца; `Continue` на speedbump пароля пропускает смену; не закрывать окно Chrome) — в спецификации `docs/specs/provider-argon.md` §7 и `infra/provider-argon.md` в KB.

## Переменные окружения

- `ARGON_FAKE=1`: офлайн-режим заглушки для тестов протокола (без запуска Chrome и пула).
- `ARGON_STATE_DIR`: путь к каталогу состояния (по умолчанию `~/.bb/plugins/provider-argon`).
- `ARGON_POOL_FILE`: путь к файлу пула (по умолчанию `$ARGON_STATE_DIR/pool.json`).
- `ARGON_BACKENDS`: JSON-массив описаний бэкендов в виде строки.
- `ARGON_SEND_DEADLINE_MS`: таймаут генерации на ход (по умолчанию 1 200 000 мс — 20 минут).
- `ARGON_MAX_PROMPT_BYTES`: потолок размера исходящего промпта в байтах UTF-8 (по умолчанию `100000` — ниже порога ~120 КБ, на котором Chrome виснет на `insertText`; `0`/отрицательное — без лимита). Превышение — немедленный отказ `prompt too large: … exceeds limit …` до выбора аккаунта и аренды, без кулдауна.
- `ARGON_MAX_TOOL_ROUNDS`: потолок раундов инструментов чтения за ход (по умолчанию 8; spec `provider-web-gemini-tools`).
- `ARGON_MAX_MESSAGE_BYTES`: потолок первого сообщения сессии с упакованными вложениями (по умолчанию 120 000 байт).
- `ARGON_TOOL_TIMEOUT_MS`: таймаут одного вызова локального инструмента (по умолчанию 15 000 мс).
- `ARGON_USAGE_REFRESH_MS`: интервал троттлинга сбора лимитов использования на аккаунт (по умолчанию 300 000 мс — 5 минут).
- `ARGON_USAGE_TIMEOUT_MS`: таймаут сбора лимитов после хода (по умолчанию 10 000 мс).
- `GEMINI_MAX_WAIT_MS`: внутренний потолок ожидания стрима в драйвере (по умолчанию 900 000 мс — 15 минут).
- `GEMINI_PARK_IDLE`: парковка вкладки на `about:blank` в простое (`1` по умолчанию, `0` для отключения).
- `GEMINI_PROFILE_DIR`: путь к каталогу профиля Chrome для одиночного профиля по умолчанию.
- `GEMINI_PROFILE`: имя или каталог профиля Chrome для одиночного профиля по умолчанию (по умолчанию `~/.gemini-cli-profile`).
- `GEMINI_CDP_PORT`: порт CDP для одиночного профиля по умолчанию (по умолчанию `9222`).
- `ARGON_USE_BUNDLED=1`: принудительное использование встроенного `acp-server.mjs`.
- `GEMINI_NO_AUTOSPAWN=1`: запрет авто-перезапуска Chrome — при несовпадении профиля или чужом/холодном CDP драйвер бросает ошибку вместо `stopChrome`/спауна. Обязательно для OS-пользователя, которому раздали пул по CDP (чужие браузеры не трогает).

**Разделение пула между OS-пользователями:** `profileDir` в `pool.json` должен быть абсолютным (`~` резолвится в HOME читающего процесса — `pool-add.mjs` пишет абсолютным); `ARGON_STATE_DIR` общий с default-ACL `rwx` на каталог и `accounts/`; у второго юзера ставить `GEMINI_NO_AUTOSPAWN=1`.

## Тестирование

- Офлайн-тесты: `npm test` (`node --test tests/*.test.mjs`)
- Ручной дымовой тест с живым Chrome: `npm run test:live`
