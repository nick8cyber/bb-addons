# PLUG-349 — живая приёмка пишущего пути на конверте web-gemini-files-v2

Дата: 2026-11-19. Ветка `bb/plug-349-web-gemini-v2-thr-xxxxxxxxxx`, база `origin/main` @ 84a09d44.
Провайдер гонялся из этого worktree (`plugins/bb-plugin-provider-web-gemini`), живые Chrome через CDP, аккаунты из пула `provider-argon`.

## Метод

`scripts/plug-349-live-acceptance.mjs` поднимает на каждый прогон:

- синтетический git-репозиторий + выделенный worktree (фикстурная ветка, чистое дерево);
- fake `bb`-DTO (`thread show --json`) с `managed/isWorktree/isGitRepo`, путём worktree и метаданными треда;
- ACP-мост через SDK, старт сессии в режиме `write` (`accept-edits`, `permissionScope: workspace`);
- частный `WEB_GEMINI_STATE_DIR` и `pool.json` на один аккаунт — прогон ничего не пишет в рабочую копию задачи.

После терминального `outcome` в журнале хода харнес сверяет: число коммитов, родитель = база, чистое дерево, SHA-256 каждого файла по каналу захвата ↔ рабочей копии ↔ индексу ↔ коммиту, перепроверку каналов продукционным verifier'ом (`channelRecheck`), длительность против дедлайна 1 200 000 мс (§9).

## Прогоны

| Run | Аккаунт | Модель / thinking | Содержание | Итог | Время | Ремонты | Коммиты |
|---|---|---|---|---|---|---|---|
| R1 | acct-1 | argon / high | Спека ~31 КБ (заголовки, таблицы, ссылки, Unicode, кодовые ограды) + `empty.txt` (0 B) + `no-eol.txt` (321 B, без финального LF); первый ответ с намеренно неверным nonce (32 нуля) | passed | 427,3 с | 1 | 1 |
| R2 | acct-2 | argon / medium | Таблица с literal `\|` в ячейках (фикстура §12.3) + кодовый блок | passed | 56,4 с | 0 | 1 |
| R3 | acct-3 | argon / low | Малый файл ~1,7 КБ, второй аккаунт | passed | 38,3 с | 0 | 1 |
| R4a | acct-4 | pro / low | Вторая модель | failed: `model-unavailable: pro not in picker` | 8,6 с | 0 | 0 |
| R4b | acct-4 | flash-lite / low | Вторая модель | failed: `model-unavailable: flash-lite not in picker` | 8,3 с | 0 | 0 |
| R4c | acct-3 | pro / low | Вторая модель | failed: `model-unavailable: pro not in picker` | 8,2 с | 0 | 0 |
| R4d | acct-3 | carbon / low | Вторая модель | failed: `web model request failed at collect` (вкладка ушла на about:blank после R4c; до выбора модели не дошло) | 0,2 с | 0 | 0 |

## Наблюдаемое (§12.3)

- **Двухканальный захват**: на каждый файл — `history.md.txt` (RPC `hNvQHb`), `dom.json.txt` (textContent кодового блока), `content-*`, `manifest.json`. `rpcId == domId` во всех принятых конвертах (`channelRecheck.plan == filesMatchManifest == true`).
- **Ремонт формата с причиной дословно**: R1 gate n=1 → `formatPass=false`, причина записана как `file response has the wrong nonce`; запрос исправления отправлен (`send n=2 repair=true`), исправленный конверт принят (gate n=2 `formatPass=true`, новый message-id).
- **Байты**: R1 `reminder-scheduler.md` 31 310 B sha256 `e9f1ddd2…`, `empty.txt` 0 B `e3b0c442…` (канонический хэш пустого файла), `no-eol.txt` 321 B `8feff9b9…` без завершающего LF; R2 `pipe-table.md` 7 477 B `504ed023…` — последовательности `\|` в ячейках дошли до коммита идентично в обоих каналах; R3 1 677 B `58ecc037…`. Во всех прогонах `worktreeMatch == indexMatch == commitMatch == true`.
- **Один коммит от исходного родителя, чистое дерево**: `commits == 1`, `parentIsBase == true`, `clean == true` во всех прогонах; ветка фикстуры не двигалась.
- **Дедлайн**: худший прогон — R1, 427 с из 1 200 с (36 %).
- **Доля сломанных конвертов**: 1 из 4 gate-ответов за сессию (намеренный неверный nonce в R1) — 25 %; без учёта спровоцированного — 0 %.
- **Второй аккаунт и режимы модели**: аккаунты acct-1 / acct-2 / acct-3 (плюс acct-4 в отказных заходах); режимы модели — thinking high/medium/low. Отдельные модели `pro` и `flash-lite` недоступны в пикере этих аккаунтов (`model-unavailable: … not in picker`, зафиксировано провайдером), `carbon` проверить не удалось — вкладка уходила на about:blank до стадии выбора модели.

## Отклонения от матрицы §12.3

- Расхождение каналов с recapture не возникло — каналы во всех ответах совпали (включая `\|` в таблице), повторный захват не потребовался.
- Файл R1 сгенерирован без CRLF внутри контента (модель писала LF) — проверка CRLF осталась на юнит-тестах.
- Живого падения между commit и ответом не устраивали; продолжение с прежним SHA и откаты покрыты `tests/inner-agent-write.test.mjs` (27 проверок, все зелёные). Первый заход R3 упал на стадии delivery (модалка геолокации перехватила клик): `outcome=failed`, 0 коммитов, дерево чистое — повторный прогон прошёл детерминированно, частичной записи не осталось.

## Артефакты

`/tmp/plug349.lab/r{1..4}/` — `observations.jsonl`, `summary.json`, журналы хода (`state/inner-agent/turns/*/turn-0001/record.json`, `file-response/*`), фикстурные worktree и seed-репозитории.

## Тесты

`node --test plugins/bb-plugin-provider-web-gemini/tests/inner-agent-write.test.mjs` — 27/27 pass.
