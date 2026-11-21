# bb-addons

Независимые плагины и темы оформления для [bb](https://getbb.app).

Установка любого плагина напрямую из этого репозитория:

```bash
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin ru
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin favorite-models
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin provider-agy
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin provider-web-gemini
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin pi-gateways
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin speak
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin compact-ui
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin tasks-pro
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin orchestrator
```

Либо из локальной копии (удобно при разработке, так как bb автоматически подхватывает изменения при установке из каталога):

```bash
bb plugin install ./plugins/bb-plugin-ru
```

## Плагины

### `ru` — Русификатор

Переводит интерфейс bb на русский язык: словарь на 2337+ записей, строго точные совпадения, поэтому текст диалогов, код, диффы и пользовательский ввод остаются нетронутыми. Кнопка с глобусом в подвале боковой панели переключает язык на лету.

Подробности и методика расширения словаря: [plugins/bb-plugin-ru/README.md](plugins/bb-plugin-ru/README.md).

### `favorite-models` ⭐

Позволяет отметить звёздочкой любимые модели любого провайдера и закрепляет их вверху списка выбора с меню быстрого переключения в строке ввода. Избранные модели группируются по провайдерам, хранилище нормализуется при чтении.

Подробности: [plugins/bb-plugin-favorite-models/README.md](plugins/bb-plugin-favorite-models/README.md).

### `provider-agy` — Antigravity

Запускает треды bb через `agy` (Antigravity CLI) как **нативный провайдер** (а не через ACP-мост): связка из объявления провайдера и нативного моста. Требует наличия `agy` в PATH и авторизованного профиля `~/.gemini`.

Ключевые возможности:
- **Пул аккаунтов:** несколько аккаунтов Google, отдельный agy HOME для каждого; тред привязывается к наименее загруженному аккаунту, при исчерпании квоты ход переносится на свободный аккаунт.
- **Обработка блокировок:** автоматическая изоляция и парковка аккаунтов при отказах Google (`VALIDATION_REQUIRED`, `tos-disabled`, временные ограничения).
- **Выбор аккаунтов с учётом каталога моделей:** опрос `agy models`, выбор аккаунта с поддержкой семейства запрашиваемой модели.
- **Надёжность и сторож зависаний:** встроенный тайм-аут и автоматический перезапуск при сбоях 5xx; сторож зависаний прерывает тишину более 15 минут.
- **Сжатие контекста:** поддержка `/compact` и эвристический фоллбэк сжатия при отказах.
- **Параллельные установки:** поддержка нескольких бинарников agy через реестр `agy-installs.json`.

Подробности: [plugins/bb-plugin-provider-agy/README.md](plugins/bb-plugin-provider-agy/README.md).

### `provider-devin` — Devin (SWE-2)

Запускает треды bb на базе SWE-2 от Devin как нативный ACP-провайдер `acp-devin`. Хуки восстанавливают правила треда после сжатия, скрывают исполнительские треды и связывают их с координатором.

Подробности: [plugins/bb-plugin-provider-devin/README.md](plugins/bb-plugin-provider-devin/README.md).

### `provider-web-gemini` — Gemini Web (`acp-web-gemini`, ранее: `acp-argon`)

Запуск тредов bb через веб-интерфейс Google Gemini (`gemini.google.com`) без API-ключей через Chrome DevTools Protocol (`playwright` / `playwright-core`). Используется пресетами оркестратора (`web-gemini-review`, `web-gemini-research`).

- **Пул аккаунтов:** мульти-аккаунтный пул в `pool.json` с арендой на ход и ротацией при лимитах.
- **Уровни рассуждения:** трансляция `thought_level` (`low`, `medium`, `high`) в режимы Gemini (`fast`, `thinking`, `pro`).
- **Гигиена ресурсов:** потоковая передача, безопасная вставка длинных промптов, парковка неактивных вкладок в `about:blank` для 0% фоновой нагрузки CPU.

Подробности: [plugins/bb-plugin-provider-web-gemini/README.md](plugins/bb-plugin-provider-web-gemini/README.md).

### `pi-gateways`

Предоставляет бесплатные модели OpenCode Zen и шлюз Kilo Code для провайдера `pi` через HTTP API без необходимости запуска отдельных тяжеловесных процессов CLI.

Подробности: [plugins/bb-plugin-pi-gateways/README.md](plugins/bb-plugin-pi-gateways/README.md).

### `speak` 🔊

Кнопка озвучивания под каждым сообщением через **Gemini TTS** (`gemini-3.1-flash-tts-preview`) с выбором из 30 голосов (по умолчанию Kore). Markdown очищается до прозы: блоки кода пропускаются, ссылки читаются по меткам. Встроенный фоллбэк на браузерный Web Speech API при отсутствии сети или ключа.

Подробности: [plugins/bb-plugin-speak/README.md](plugins/bb-plugin-speak/README.md).

### `live-call` 📞 — голосовой звонок с координатором (бета)

Голосовой звонок реального времени с координатором bb через Gemini Live API: разговор, перебивание, чтение тредов и запуск агентов. Релей через сервер bb защищает IP и данные клиента. Поддержка MCP-коннекторов проектов и шлюзов подтверждения владельца.

Подробности: [plugins/bb-plugin-live-call/README.md](plugins/bb-plugin-live-call/README.md).

### `voice-stt` 🎙️ — голосовой ввод Gemini STT

Голосовой ввод текста для bb:
- Микрофон в строке ввода: транскрипция через Gemini Live, Codex или Groq.
- Живая диктовка: плавающая кнопка микрофона с потоковым распознаванием речи в Gemini Live и автоматической вставкой текста в черновик.

Подробности: [plugins/bb-plugin-voice-stt/README.md](plugins/bb-plugin-voice-stt/README.md).

### `privacy-blur`

Размытие конфиденциальных данных в интерфейсе bb в один клик (`Alt+Shift+P` или кнопка с глазом): скрытие email, ID, путей, токенов, доменов и IP для скриншотов и демонстрации экрана через CSS Custom Highlight API без изменения DOM.

Подробности: [plugins/bb-plugin-privacy-blur/README.md](plugins/bb-plugin-privacy-blur/README.md).

### `compact-ui`

Компактный список чатов в боковой панели (сворачивание старых чатов за «Ещё N»), навигация по десяткам, ограничение высоты поля ввода композера до трети экрана.

Подробности: [plugins/bb-plugin-compact-ui/README.md](plugins/bb-plugin-compact-ui/README.md).

### `thread-timestamps`

Постоянное отображение точной даты и времени над сообщениями пользователя и ассистента в локальном часовом поясе.

Подробности: [plugins/bb-plugin-thread-timestamps/README.md](plugins/bb-plugin-thread-timestamps/README.md).

### `tasks-pro`

Расширенная панель встроенного трекера задач bb: таблица с сортировкой и канбан-доска, 12 фильтров, поиск по токенам и сохранённые представления (строго в режиме чтения SQLite).

Подробности: [plugins/bb-plugin-tasks-pro/README.md](plugins/bb-plugin-tasks-pro/README.md).

### `orchestrator`

Универсальный плагин оркестрации задач и управления конвейером разработки как код. Автоматическая маршрутизация задач по уровням сложности, сторож квот и зависаний, фоновое автопродвижение по графу состояний.

Ключевые возможности:
- **Граф задач и очередь кодом (§27–§34):** Детерминированный конечный автомат узлов (`task_queue`, `task_transitions`), фоновый конвейер `run-queue`, фиксация TDD-договоров приёмки до написания кода, машинный узел верификации `checks` и автоматизированный жизненный цикл веток.
- **Иерархический режим графа по проектам (`workGraphProjects`, PLUG-361):** Проектные переопределения (`off` / `shadow` / `strict`). Строгая изоляция гарантирует, что режим `strict` в одном проекте не блокирует работу других проектов стенда, а для проектов в `off` соблюдается абсолютная тишина наблюдателя (0 накладных расходов).
- **Компактное меню роли и режима одобрения (PLUG-359):** Единый элемент в строке действий композера (`RoleApprovalMenu`), совмещающий выбор роли треда (`orchestrator`, `executor`, `auditor`, `researcher`, `architect`) и режима подтверждения владельца (`✅` Авто / `👤` Сам).
- **Защита критических настроек (PLUG-360, §32.3):** Машинный аудит изменений `workGraph`, `workGraphProjects`, `approvalMode` в `events` и `command_runs`, карточки владельцу `PluginInteractionRequest` с кнопками `[ Оставить ]` и `[ Вернуть прежнее значение ]` при смене вне меню, запрет модификации настроек из тредов агентов (`permission-denied: owner-only`).
- **Zero-Leak Sandbox (§33, ADR-0035):** Одноразовая песочница Snapshot Sandbox на базе Bubblewrap с RFC ASCII DLP-маскированием секретов для безопасного запуска публичных и бесплатных моделей.

Подробности: [plugins/bb-plugin-orchestrator/README.md](plugins/bb-plugin-orchestrator/README.md).

## Темы оформления

### `arctic-ledger`

Контрастная синяя светлая тема с согласованной тёмной версией.

```bash
cp -r themes/arctic-ledger "$(bb theme dir)/"
bb theme set arctic-ledger
```
