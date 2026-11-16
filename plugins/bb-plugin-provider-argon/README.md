# bb-plugin-provider-argon

ACP-провайдер «Gemini (Argon)» (`acp-argon`) для bb поверх веб-интерфейса `gemini.google.com` без API-ключей.

Транспорт работает по JSON-RPC 2.0 (протокол ACP) через `acp-server.mjs` и управляет изолированными headless-профилями Chrome по Chrome DevTools Protocol (`playwright` или `playwright-core`).

Архитектурное решение и контекст: `docs/adr/0027-provider-argon-acp.md`.
Спецификация: `docs/specs/provider-argon.md`.

## Требования

- Google Chrome (системный `google-chrome-stable` или путь через `GEMINI_CHROME_BIN`);
- `playwright` или `playwright-core` (драйвер пробует сначала `playwright`, затем `playwright-core`);
- Пул аккаунтов (`pool.json`) с авторизованными профилями.

## Архитектура

1. **`index.mjs`**: манифест плагина BB (`export default function plugin(bb)`), регистрация провайдера `acp-argon` с возможностями потоковой передачи (`supportsStreaming: true`), отмены (`supportsCancel: true`), уровнями рассуждений `low`, `medium`, `high`.
2. **`acp-server.mjs`**: JSON-RPC 2.0 ACP-сервер (stdio). Управляет пулом аккаунтов (`pool.json`), файлом состояния и эксклюзивной аренды (`accounts-state.json`), разбором времени сброса квот, ротацией и корректным завершением с освобождением аренды при закрытии или `SIGTERM`.
3. **`src/gemini-driver.js`**: веб-драйвер на базе CDP (`playwright` или `playwright-core`), надёжная вставка больших промптов через `execCommand('insertText')`, отслеживание многоходовых ответов строго через `findTurnTarget` без утечки предыдущего ответа, парковка вкладки на `about:blank` в простое для нулевой фоновой нагрузки CPU.
4. **`src/profile-manager.js`**, **`bin/gemini.js`**, **`scripts/`**: утилиты ручного входа в аккаунты Google и управления пулом профилей.

## Настройка пула аккаунтов

Конфигурация пула задаётся файлом `pool.json` в каталоге состояния (`ARGON_POOL_FILE` или `~/.bb/plugins/provider-argon/pool.json`):

```json
{
  "accounts": [
    { "id": "acc1", "email": "user1@example.com", "profileDir": "~/.gemini-cli-profile", "cdpPort": 9222, "priority": 10, "tier": "pro" },
    { "id": "acc2", "email": "user2@example.com", "profileDir": "~/.gemini-cli-profile-2", "cdpPort": 9223, "priority": 10, "tier": "ultra" }
  ]
}
```

Также поддерживается обратная совместимость со структурой каталогов `$ARGON_STATE_DIR/accounts/<label>/backend.json`.

## Переменные окружения

- `ARGON_FAKE=1`: офлайн-режим заглушки для тестов протокола (без запуска Chrome и пула).
- `ARGON_STATE_DIR`: путь к каталогу состояния (по умолчанию `~/.bb/plugins/provider-argon`).
- `ARGON_POOL_FILE`: путь к файлу пула (по умолчанию `$ARGON_STATE_DIR/pool.json`).
- `ARGON_BACKENDS`: JSON-массив описаний бэкендов в виде строки (альтернативный способ передачи пула через окружение).
- `ARGON_SEND_DEADLINE_MS`: таймаут генерации на ход (по умолчанию 1 200 000 мс — 20 минут).
- `GEMINI_MAX_WAIT_MS`: внутренний потолок ожидания стрима в драйвере (по умолчанию 900 000 мс — 15 минут).
- `GEMINI_PARK_IDLE`: парковка вкладки на `about:blank` в простое (`1` по умолчанию, `0` для отключения).
- `GEMINI_PROFILE_DIR`: путь к каталогу профиля Chrome для одиночного профиля по умолчанию.
- `GEMINI_PROFILE`: имя или каталог профиля Chrome для одиночного профиля по умолчанию (резервный вариант, если не задан `GEMINI_PROFILE_DIR`; по умолчанию `~/.gemini-cli-profile`).
- `GEMINI_CDP_PORT`: порт CDP для одиночного профиля по умолчанию (по умолчанию `9222`).
- `ARGON_USE_BUNDLED=1`: принудительное использование встроенного `acp-server.mjs`.

## Тестирование

- Офлайн-тесты: `npm test` (`node --test tests/*.test.mjs`)
- Ручной дымовой тест с живым Chrome: `npm run test:live`
