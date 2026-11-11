# bb-plugin-provider-devin

Провайдер `acp-devin` для bb: Devin (SWE-2) через ACP, работающий так же, как Claude и Codex.

## Что внутри

| Часть | Зачем |
|---|---|
| `server.ts` | объявление провайдера `acp-devin`; бинарник — `~/.local/bin/devin`, иначе `/usr/local/bin/devin`, иначе `devin` из PATH |
| `host.ts` + `src/vendor/acp-bridge.js` | ACP-мост из `@get-bb/plugin-sdk` (собирается `npm run vendor`) с диалектом `devin` и сохранением правил bb треда в `~/.local/state/bb-devin/instructions/<thr>.md` |
| `devin-hooks/` | хуки Devin CLI: правила bb возвращаются после сжатия и при восстановлении сессии; защита конфигов (~/.config/devin, ~/.claude, хуки); запрет блокирующего ожидания (если он есть у Claude пользователя). Раздача задач и привязка тредов — через плагин `orchestrator` (`bb orchestrator delegate`) |

## Центральная настройка субагентов

`bb plugin config acp-devin set subagentsDisabled true` — тот же контракт, что у
codex/claude-code/agy: server.ts через `deriveProviderOptions` кладёт её в
`options.providerOptions.providerSubagentsEnabled` на каждый thread/start|resume,
а host-обёртка применяет её к `subagents_enabled` в юзерском конфиге Devin —
единственному рычагу, который `devin acp` читает. Запрет запоминает прошлое
значение в dataDir (`subagents-gate.json`) и при выключении настройки его
восстанавливает; `subagents_enabled:false`, поставленный самим пользователем
(в т.ч. `devin-hooks/install.py`), не трогается ни в одну сторону.
Действие глобально — затрагивает и интерактивный `devin` на хосте.

## Центральная настройка памяти

`memoryEnabled` (default **true**, контракт как у codex/claude-code) доезжает до
host-обёртки как `providerMemoryEnabled` — но применять нечего: в этом `devin
acp` локального рычага памяти нет. Memory Drive и auto-notes — облачные фичи,
в юзерском конфиге ключа для них нет (`disabled_tools` существует, но memory-тула
в реестре `devin acp` нет — стемпить имена наугад значило бы врать про эффект).
Гейт логирует «nothing applied» при запросе OFF; когда devin добавит рычаг —
он подключается в `applyMemoryGate` (host.ts).

## Установка у пользователя

1. `bb plugin install <путь к этому каталогу> --yes`; запись `devin` из `bb plugin config provider-acp customAgents` убрать (один id не может быть у двух провайдеров).
2. `python3 -I devin-hooks/install.py` — копирует хуки в `~/.local/share/bb-devin/hooks/` (не в чекаут: его переключают на другие ветки), прописывает их в `~/.config/devin/config.json` (чужие хуки пользователя сохраняются), ставит `read_config_from.claude=true` и `subagents_enabled=false`. Резервная копия рядом. После правки хуков в репозитории — запустить снова.
3. Новые сессии Devin подхватывают хуки сразу; работающие — после перезапуска процесса (`bb thread stop <id>`, когда тред в простое).

Журнал хуков: `~/.local/state/devin-bb-hooks.log`.

## Проверки

```
npm test                                   # диалект и сохранение правил
python3 -I devin-hooks/bb_subagents.test.py # хук защиты конфигов (без spawn/dispatch)
python3 -I devin-hooks/no_blocking_wait.test.py
python3 -I devin-hooks/install.py --check  # что будет записано
```
