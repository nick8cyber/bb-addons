---
title: provider-agy — переход на ACP-транспорт agy acp
status: accepted
date: 2026-11-10
---

# provider-agy — переход на ACP-транспорт agy acp

## Контекст

Нативный `agy --output-format stream-json` не отдаёт ни мысли модели, ни аргументы/результаты тулов: в thread-дельтах `agentMessage` приходят пустыми, `toolCall` — без аргументов. Проверено: закрытый словарь `step_type` (`user_input|checkpoint|agent_response|tool`), размышлений и payload тулов в протоколе нет по построению. Живой инцидент-иллюстрация: аудит-тред `thr_egfnmaue4c` проработал 22 минуты и умер с 39 пустыми `agentMessage` — финальный текст потерян при обрыве стрима.

## Решение

Транспорт — `agy acp` (подкоманда agy 1.5.3, полный ACP-сервер). Протокол переводит generic-мост `experimental_acpProviderBridge` из SDK; поверх него в `host.ts` плагина — обёртка `experimental_providerBridge`, перехватывающая `handleLine` в обе стороны (эталон — `rawizhere/bb-plugin-antigravity-acp`).

Перехват двухслойный: `handleLine` видит только границу «демон ↔ мост», а `session/prompt`/`tool_call_update` живут на приватном stdio-пайпе generic-моста — поэтому `acpLaunchSpec.command` получает прозрачный NDJSON-shim (спавнит `agy acp`, снифит `result.usage` и тексты отказов тулов в side-channel). Паттерн — `wrapper-script.ts` у rawizhere.

Проприетарное сохраняется в обёртке и `src/accounts.ts`: пул аккаунтов (`--gemini-dir` — единственный флаг изоляции; `--app-data-dir` резолвится относительно и не трогается), леджер, кулдауны, ineligible-breaker, мгновенная ротация (синтезированный `thread/start` + `sessionReplaced` + handoff-промпт на ретрайном `turn/start`), классификатор квоты с `provider.rateLimits`, compaction fallback (ADR-0003), ArtifactMetadata-nudge. `provider-retry` bb используется только когда остыл весь пул — обёртка инжектирует `errorInfo{rate-limit,429}`, generic-мост его не выставляет. Потурновые токены — из `result.usage` ответа `session/prompt` (SQLite-прокси не нужен).

Старый мост остаётся за `AGY_TRANSPORT=stream-json` на один релиз.

## Отвергнуто

- **Официальный `agy_acp_server.par`** (запись реестра, плагин rawizhere): свой auth-стор `~/.gemini/antigravity-acp` — потребовал бы перелогина всего пула. Отвергнуто словом владельца.
- **Полагаться на bb provider-retry для ротации**: он читает `errorInfo` и ждёт resetsAt — а свободный сиблинг в пуле даёт ответ за ~1 с.
- **SQLite-прокси для usage**: избыточен — `usage` уже в ответе `session/prompt`.

## Следствия

В тредах видны живые мысли (`item/reasoning/textDelta`), аргументы и вывод тулов, потурновые токены. `session/load` читает разговоры stream-json — история не теряется при переходе. Стоимость — слой обёртки ~перенос recovery-логики; риск формы квота-ошибки закрыт классификатором под обе формы и флагом отката.

Контракт: [спецификация](../specs/provider-agy-acp.md).

## Исход (2026-11-10, реализовано)

Смержено в `main`: #7 `f06334e` (миграция), #8 `4d8faac` (permissionModes), #9 `e5027bc` (acp-shim едет внутри host-бандла — блокер артефактов), #10 `d2403fa` (лестница усилий на голых id из `agy models`), #11 `e6dba11` (gitDiffStat не сыплет git-варнинги), #12 `bdf5c7c` (permissionModes без `auto`). После аудита транспорта (PLUG-167, ревью на Gemini 3.8 High): #15 `de47ede` (1 блокер — dead ctl-канал `session/set_mode`, и 7 фиксов очереди/ротации/взаимодействий/side-channel) и #16 `1ccdc9c` (спека догнала код). По инциденту 10.11 (вылогиненный пул-аккаунт убивал треды насовсем): #18 `0fc6b23` — классификация auth-dead, парковка с `parkedReason`, ротация хода и resume, честный фейл при пустом пуле.

Проверено вживую на двух bb-инстансах (ubuntu и ornella, обе на `bdf5c7c`): потурневый ход 5–6 с на `claude-sonnet-4-6`; `session/resume` сохраняет контекст; live-стрим `item/reasoning/textDelta` + `commandExecution` + `tokenUsage/updated`; usage пишется в side-channel (`acp-shim/events.ndjson`, в т.ч. `thoughtTokens`); плагинные agentTools доезжают до модели через MCP-прокси (`zoom_list_meetings` вернул реальные данные из agy-сессии); `model/list` отдаёт лестницу low/medium/high.

Ограничения, найденные при внедрении: `auto`/`default`/`plan` недоставляемы на generic-диалекте (демон гейтит `thread.start` по capabilities адаптера) — заявлены только `full`+`accept-edits`; холодный старт сессии ~1.5–3 мин, причём основная часть — очередь ёмкости у Google на gemini-tiers (503-волна дня, на Claude тот же путь — секунды), не транспорт; живой прогон `AGY_TRANSPORT=stream-json` не делался (env демона, путь покрыт харнессом 9/9).
