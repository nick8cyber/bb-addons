# bb-plugin-provider-devin

Провайдер `acp-devin` для bb: Devin (SWE-2) через ACP, работающий так же, как Claude и Codex.

## Что внутри

| Часть | Зачем |
|---|---|
| `server.ts` | объявление провайдера `acp-devin`; бинарник — `~/.local/bin/devin`, иначе `/usr/local/bin/devin`, иначе `devin` из PATH |
| `host.ts` + `src/vendor/acp-bridge.js` | ACP-мост из `@get-bb/plugin-sdk` (собирается `npm run vendor`) с диалектом `devin` и сохранением правил bb треда в `~/.local/state/bb-devin/instructions/<thr>.md` |
| `devin-hooks/` | хуки Devin CLI: правила bb возвращаются после сжатия и при восстановлении сессии; треды-исполнители скрыты и привязаны к координатору; защита конфигов; запрет блокирующего ожидания (если он есть у Claude пользователя) |

## Установка у пользователя

1. `bb plugin install <путь к этому каталогу> --yes`; запись `devin` из `bb plugin config provider-acp customAgents` убрать (один id не может быть у двух провайдеров).
2. `python3 -I devin-hooks/install.py` — копирует хуки в `~/.local/share/bb-devin/hooks/` (не в чекаут: его переключают на другие ветки), прописывает их в `~/.config/devin/config.json` (чужие хуки пользователя сохраняются), ставит `read_config_from.claude=true` и `subagents_enabled=false`. Резервная копия рядом. После правки хуков в репозитории — запустить снова.
3. Новые сессии Devin подхватывают хуки сразу; работающие — после перезапуска процесса (`bb thread stop <id>`, когда тред в простое).

Журнал хуков: `~/.local/state/devin-bb-hooks.log`.

## Проверки

```
npm test                                   # диалект и сохранение правил
python3 -I devin-hooks/no_blocking_wait.test.py
python3 -I devin-hooks/install.py --check  # что будет записано
```
