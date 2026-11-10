---
title: provider-agy — переход на ACP-транспорт agy acp
status: draft
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
