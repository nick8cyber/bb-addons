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

- **`Gemini 4 Argon`** (`argon`) — основная модель по умолчанию.
- **`Gemini 4 Carbon`** (`carbon`) — флагманская модель для аккаунтов с тарифом Ultra.
- **`Gemini 2.5 Flash`** (`fast` / `flash`) — быстрая модель.
- **`Gemini 2.5 Pro`** (`pro`) — модель повышенной точности.
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

## Переменные окружения

- `ARGON_FAKE=1`: офлайн-режим заглушки для тестов протокола (без запуска Chrome и пула).
- `ARGON_STATE_DIR`: путь к каталогу состояния (по умолчанию `~/.bb/plugins/provider-argon`).
- `ARGON_POOL_FILE`: путь к файлу пула (по умолчанию `$ARGON_STATE_DIR/pool.json`).
- `ARGON_BACKENDS`: JSON-массив описаний бэкендов в виде строки.
- `ARGON_SEND_DEADLINE_MS`: таймаут генерации на ход (по умолчанию 1 200 000 мс — 20 минут).
- `GEMINI_MAX_WAIT_MS`: внутренний потолок ожидания стрима в драйвере (по умолчанию 900 000 мс — 15 минут).
- `GEMINI_PARK_IDLE`: парковка вкладки на `about:blank` в простое (`1` по умолчанию, `0` для отключения).
- `GEMINI_PROFILE_DIR`: путь к каталогу профиля Chrome для одиночного профиля по умолчанию.
- `GEMINI_PROFILE`: имя или каталог профиля Chrome для одиночного профиля по умолчанию (по умолчанию `~/.gemini-cli-profile`).
- `GEMINI_CDP_PORT`: порт CDP для одиночного профиля по умолчанию (по умолчанию `9222`).
- `ARGON_USE_BUNDLED=1`: принудительное использование встроенного `acp-server.mjs`.

## Тестирование

- Офлайн-тесты: `npm test` (`node --test tests/*.test.mjs`)
- Ручной дымовой тест с живым Chrome: `npm run test:live`
