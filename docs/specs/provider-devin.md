---
title: Provider Devin — режим прав сессии
status: draft
updated: 2026-11-07
revision: 2 (замечания ревью PLUG-131)
---

# Provider Devin

Контракт плагина `bb-plugin-provider-devin` в части, которую меняет этап MVP оркестратора. Остальное описано в README плагина.

## 1. Режим прав сессии

Проблема: тред `acp-devin` с `permissionMode = full` стартует в режиме Devin `accept-edits` и висит на подтверждениях. Мост передаёт Devin флаг `--permission-mode dangerous`, но сессия ACP его не учитывает: режим прав в ACP — опция сессии `mode` (`accept-edits`, `smart`, `ask`, `plan`, `bypass`), и мост её не выставляет.

Требование: после `session/new` и после успешного `session/load` мост выставляет опцию `mode` по `permissionMode` треда:

| permissionMode треда | mode сессии Devin |
|---|---|
| `full` | `bypass` |
| `accept-edits` | `accept-edits` |
| `auto` | `smart` |

- Если агент не сообщает опцию `mode` или нужного значения в ней нет — ничего не менять, одно предупреждение в журнал моста на каждое построение сессии.
- Ошибка `set_config_option` — предупреждение в журнал, тред продолжает работать в режиме агента (fail-open).
- Пользователь может сменить режим вручную; мост не перезаписывает его до следующего пересоздания сессии.
- Правка — в генераторе моста (`scripts/vendor-acp-bridge.mjs` + `src/devin-dialect.js`), сгенерированный файл пересобирается `npm run vendor`.

Проверка: мост не сообщает опции сессии в BB, поэтому `bb thread options` режим не покажет. Живая проверка — тред `acp-devin` с пресетом `full` выполняет команды без запросов подтверждения (`bb thread interactions list` пуст), а журнал моста не содержит предупреждения «does not offer session mode». Тест на соответствие режимов и на fail-open.

## 2. Служебные сообщения не прерывают ход

Сейчас мост не отменяет ход Devin только для сообщений, начинающихся с `[bb system]`; остальные (владелец, другие треды) отменяют ход — ACP не умеет вклинивать сообщение в идущий ход.

Требование: так же мягко обрабатывать сообщения, начинающиеся с `[orchestrator]` (служебные сообщения сторожа оркестратора). Сообщения владельца и других тредов по-прежнему прерывают ход.

Проверка: тест `isBbSystemNotice` (или переименованной функции) на оба префикса и на обычный текст; живой прогон — сообщение `[orchestrator] …` посреди длинной команды Devin не отменяет её и доставляется после хода.

## 3. Центральная настройка субагентов (11.11.2026)

- Тот же контракт, что у codex/claude-code/agy: `bb.settings.define({subagentsDisabled})` (default **false** — субагенты Devin видны в треде как `delegation`-карточки, проблемы невидимости нет) + `deriveProviderOptions` → `options.providerOptions.providerSubagentsEnabled`.
- У Devin нет per-session провода для запрета: `devin acp` читает только юзерский конфиг (`subagents_enabled`, документирован как user-only, применяется живьём). Host-обёртка (`host.ts` + `src/subagent-gate.mjs`) на thread/start|resume|fork стемпит `subagents_enabled:false` при запрете и откатывает ровно свой стемп при включении (prior хранится в `dataDir/subagents-gate.json`); чужой `false` в конфиге (devin-hooks/install.py) не трогается. JSONC-комментарии конфига сохраняются (правки value-in-place).
- Покрытие: `node --test scripts/subagent-gate.test.mjs` (parse/insert/flip/restore, JSONC).

