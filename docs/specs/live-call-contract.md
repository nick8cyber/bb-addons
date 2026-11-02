---
title: Live Call — контракт для исполнителей
status: draft
owner: coordinator
date: 2026-11-02
tags: [live-call, contract]
---

# Live Call — контракт для исполнителей

> [!IMPORTANT]
> Это контракт: имена, форматы, числа. Архитектура и причины — в [live-call.md](live-call.md). Расхождение кода с этим файлом — вопрос координатору, а не повод импровизировать. Версия протоколов — `1`.

## 1. Плагин и настройки

- id `live-call`, пакет `plugins/bb-plugin-live-call/`, точки входа `server.ts`, `app.tsx`, `host.ts` (мост провайдера), структура — спека §8.
- Провайдер `live-call` (скрытый, §7), CLI `bb call`.

| Ключ (`bb.settings.define`) | Тип | По умолчанию | Правила |
|---|---|---|---|
| `geminiKeys` | secret, строки | — | 1–2 ключа AI Studio, по одному на строку. Первый — основной, второй — запасной. Нет ключей → `needsConfiguration` |
| `defaultMode` | `"normal" \| "extended"` | `"normal"` | Режим нового звонка. После звонка сохраняется последний выбранный (`lastMode` в хранилище плагина) |
| `extendedThinkingLevel` | `"LOW" \| "MEDIUM" \| "HIGH"` | `"LOW"` | Только для VOICE в режиме `extended` |
| `voice` | строка из 30 голосов | `"Algenib"` | `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` |
| `languageCode` | строка | `"ru-RU"` | `speechConfig.languageCode` |
| `echoMode` | `"auto" \| "headphones" \| "duck"` | `"auto"` | `duck` — микрофон приглушается, пока говорит агент |
| `maxCallMinutes` | число 5–120 | `60` | За 2 мин до конца агент предупреждает, на лимите — `end_call` |
| `callsProjectId` | строка | пусто | Пусто → при первом звонке плагин создаёт проект «Звонки» (§6) и записывает его id |
| `callsWorkspacePath` | путь на основном хосте | `~/bb-calls` | Папка-источник проекта «Звонки»: пустая, код в ней не живёт |
| `wordsConfirm` / `wordsPermit` / `wordsLaunch` | списки строк | §7.1 спеки | Только дополнять: пустой список отклоняется |
| `wordsRefuse` | список строк | §7.1 спеки | Слова отказа, тоже не пустой |
| `hotkeyCall` / `hotkeyMode` | строка | `"Mod+Shift+KeyL"` / `"Mod+Shift+KeyK"` | Сравнение по `event.code` |

Секреты только на сервере. Во фронтенд уходят `configured: boolean` и число ключей.

## 2. WebSocket браузер ↔ сервер

Маршрут `bb.http.experimental_websocket("/call", …, { auth: "local" })`, то есть `/api/v1/plugins/live-call/http/call`. Один активный звонок на хост: второе подключение получает `error { code: "busy" }` и закрывается кодом `4009`.

### 2.1. Бинарные кадры

```text
byte 0      тип: 0x01 — микрофон (клиент → сервер), 0x02 — звук агента (сервер → клиент)
bytes 1..4  turnSeq, uint32 LE (для 0x01 всегда 0)
bytes 5..   PCM16 LE, моно: 0x01 — 16 кГц, 20 мс = 640 байт; 0x02 — 24 кГц, любой длины
```

### 2.2. JSON-кадры (zod, `discriminatedUnion("type")`)

Клиент → сервер:

| `type` | Поля | Смысл |
|---|---|---|
| `hello` | `protocol: 1`, `mode?: "normal"\|"extended"` | Первый кадр. Без него через 5 с соединение закрывается |
| `mute` | `muted: boolean` | Микрофон выключен: сервер шлёт в Gemini тишину |
| `playback_drained` | `turnSeq: number` | Плеер доиграл последний кадр хода (§7.1 п. 3 спеки) |
| `switch_mode` | `mode` | Переключение режима, отклоняется при pending (`error { code: "pending_confirmation" }`) |
| `confirm` | `confirmationId: string`, `decision: "approve"\|"cancel"` | Кнопки в оверлее, равносильны слову владельца |
| `end` | — | Завершить звонок |

Сервер → клиент:

| `type` | Поля |
|---|---|
| `ready` | `callId`, `threadId`, `mode`, `voice`, `keys: { active: 1\|2, of: 1\|2 }` |
| `state` | `state: "connecting"\|"listening"\|"thinking"\|"speaking"\|"working"\|"reconnecting"\|"muted"\|"ended"`, `detail?` |
| `transcript` | `role: "owner"\|"agent"`, `text`, `final: boolean`, `turnSeq?` |
| `interrupted` | `turnSeq` — клиент сразу сбрасывает буфер плеера |
| `action` | `actionId`, `tool`, `class: "R"\|"C"\|"P"\|"L"`, `status: "running"\|"done"\|"failed"\|"cancelled"`, `summary`, `threadId?` |
| `confirmation` | `confirmationId`, `class`, `tool`, `summary`, `word`, `expiresAt` (ISO), `phase: "asking"\|"listening"` |
| `confirmation_result` | `confirmationId`, `verdict: "approved"\|"hint"\|"cancelled"\|"expired"` |
| `event` | `kind: "thread.idle"\|"thread.failed"\|"interaction.pending"`, `threadId`, `summary`, `queued: boolean` |
| `mode` | `mode`, `switching: boolean` |
| `key` | `active`, `of`, `reason: "quota"\|"unavailable"` — переход на запасной ключ |
| `warning` | `code: "tpm_near_limit"\|"call_ending"`, `message` |
| `error` | `code`, `message`, `retryable: boolean` |
| `ended` | `callId`, `threadId`, `reason: "owner"\|"limit"\|"error"` |

Коды `error`: `busy`, `no_keys`, `quota_all_keys`, `google_unreachable`, `extended_unavailable`, `pending_confirmation`, `protocol`, `internal`. `mic_denied` фронтенд показывает сам, сервер о нём не знает.

## 3. Gemini Live (сервер → Google)

- `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=…`. Ключ из `geminiKeys`. Клиентские заголовки не пересылаются (ADR-0005).
- Общий `setup`: `generationConfig.responseModalities: ["AUDIO"]`, `speechConfig` (§1), `inputAudioTranscription: {}`, `outputAudioTranscription: {}`, `sessionResumption: { handle? }`, `contextWindowCompression: { triggerTokens: 20000, slidingWindow: { targetTokens: 10000 } }` (числа уточняет Ф0).

| Сессия | `model` | Отличия `setup` |
|---|---|---|
| `normal` | `models/gemini-3.8-live` | `tools` (§4), без `thinkingConfig` |
| `extended` VOICE | `models/gemini-3.8-live-extended-thinking` | `thinkingConfig.thinkingLevel` (§1), **без `tools`** |
| `extended` ROUTER | `models/gemini-3.8-live` | `tools` (§4), `systemInstruction` маршрутизатора (§8), звук выбрасывается |

- `goAway` → переподключение тем же ключом с последним `newHandle` до истечения `timeLeft`.
- 429 / `RESOURCE_EXHAUSTED` / закрытие с кодом квоты → `KeyPool` переходит на запасной ключ: новая сессия + пересказ из `ContextLedger` (последние 10 реплик + сводка ≤800 токенов, `clientContent`, `turnComplete: false`). Запасного нет → `error { code: "quota_all_keys" }`.
- `usageMetadata` суммируется за скользящие 60 с. Больше 50 000 → `warning { code: "tpm_near_limit" }`. Ключ заранее не меняется.

## 4. Инструменты

Все объявления — `behavior: "NON_BLOCKING"`, формат `parameters` (OpenAPI-подмножество, не `parametersJsonSchema`). Ответ инструмента всегда:

```ts
type ToolResult =
  | { ok: true; data: JsonValue; truncated?: boolean }            // ≤ 6000 символов после JSON.stringify
  | { ok: false; error: { code: string; message: string } }
  | { ok: false; needsConfirmation: { confirmationId: string; say: string } };
```

| Имя | Параметры | Класс | `data` |
|---|---|---|---|
| `bb_overview` | — | R | `{ projects: {id,name}[]; running: ThreadBrief[]; waiting: ThreadBrief[]; failed: ThreadBrief[] }`, до 10 в каждом |
| `list_threads` | `project?: string`, `status?: "active"\|"waiting"\|"error"\|"any"`, `query?: string` | R | `ThreadBrief[]`, до 15 |
| `read_thread` | `thread: string` (id или название) | R | `{ thread: ThreadBrief; lastOutput: string }`, `lastOutput` ≤ 4000 символов |
| `list_pending` | — | R | `{ threadId; title; kind: "question"\|"permission"; prompt }[]` |
| `watch_thread` | `thread: string` | R | `{ watching: true }` |
| `send_to_thread` | `thread: string`, `text: string` | C | `{ sent: true; threadId }` |
| `answer_interaction` | `thread: string`, `answer: string`, `grant?: boolean` | C, или P при `grant: true` | `{ resolved: true }` |
| `stop_thread` | `thread: string` | C | `{ stopped: true }` |
| `start_thread` | `project: string`, `task: string`, `preset?: string` | L | `{ threadId; title }` |
| `tasks_create` | `title: string`, `spec: string`, `project?: string` | C | `{ key }` |
| `tasks_dispatch` | `key: string`, `preset: string` | L | `{ threadId }` |
| `search_memory` | `query: string` | R | `{ items: { name; summary }[] }`, до 5 |
| `switch_mode` | `mode: "normal"\|"extended"` | R | `{ switching: true }` |
| `end_call` | — | R | `{ ending: true }` |

`ThreadBrief = { id; title; project; status; updatedAt }`. Имя треда из речи сопоставляется с открытыми тредами нечётким поиском. Двусмысленность → `ok: false, error.code: "ambiguous"` со списком до 3 кандидатов в `message`. Сообщения, отправленные голосом, начинаются с `[голос] `. Таймаут исполнителя — 20 с → `error.code: "timeout"`.

Сигнатуры SDK (сверено с типами 0.6.49): вопрос агента — `threads.interactions.respond({ interactionId, threadId, value })` (`value: JsonValue`); запрос разрешения — `threads.interactions.resolve({ interactionId, threadId, resolution })` (`resolution: PendingInteractionResolution`). Глобального списка ожидающих в SDK нет: снимок — `threads.listRunning` + `threads.interactions.list({ threadId })` по каждому; в реальном времени — realtime-событие `interaction.pending` (несёт `{ thread, interaction }`), его кеширует `EventBridge`.

## 5. ConfirmationGate

Правила — спека §7.1, здесь только интерфейс:

```ts
interface ConfirmationGate {
  request(tool: string, args: JsonObject, cls: "C" | "P" | "L"): { confirmationId: string; say: string } | { rejected: "pending_exists" };
  onPlaybackDrained(turnSeq: number): void;                     // открывает окно (§7.1 п. 3)
  onOwnerUtterance(text: string, final: boolean, at: number): void;
  decide(confirmationId: string, source: "voice" | "button", decision?: "approve" | "cancel"): Verdict;
  pending(): PendingConfirmation | null;
}
type Verdict = "approved" | "hint" | "cancelled" | "expired" | "not_confirmed";
```

Константы: TTL — 60 с, отступ окна — 300 мс, конец реплики — 700 мс тишины, ожидание транскрипта — до 3 с, длина реплики — не больше 6 слов. Классификатор — чистая функция `classify(text, cls, words) → Verdict`, покрыта тестами из приёмки Ф3.

## 6. Тред звонка (провайдер `live-call`)

1. `callsProjectId` пуст → папка `callsWorkspacePath` создаётся на основном хосте (`sdk.system.config().primaryHostId`), затем `bb.sdk.projects.create({ name: "Звонки", source: { type: "local_path", hostId, path } })`, id сохраняется в настройку. Окружение создавать не нужно: `projects.create` с `local_path` сама даёт проекту окружение `project-checkout` (unmanaged workspace по пути проекта), и `threads.spawn({ projectId })` без явного `environmentId` подхватывает его. Проверено спайком 02.11 (проект создан, тред заспавнен, окружение `project-checkout` присвоено автоматически).
2. Первая законченная реплика владельца → `threads.spawn({ projectId, providerId: "live-call", model: "live", title: "📞 Звонок ДД.ММ ЧЧ:ММ", prompt })`.
3. Следующая реплика: сервер шлёт мосту `end` для открытого хода, ждёт `turn/completed`, затем `threads.send({ threadId, mode: "start", input: [{ type: "text", text, mentions: [] }] })`.
4. Реплики агента, действия и события — `say` в открытый ход. Действия выглядят так: `✉️ Отправил в «…»`, `📖 Прочитал «…»`, `🚀 Запустил «…»` — со ссылкой `@thread`.
5. Конец звонка → `say` с итогом (решения, действия, хвосты), потом `end`. Заголовок дополняется темами: «📞 Звонок 02.11 12:40 — проект A, проект B».

## 7. Сервер ↔ мост (внутренний протокол)

- Сервер пишет `<dataDir>/plugins/live-call/bridge-data/server.json = { "url": bb.server.loopbackBaseUrl, "protocol": 1 }` при загрузке.
- Мост читает файл (повтор раз в секунду, пока файла нет) и подключается к WS `/bridge` (`auth: "local"`, без `Origin`).
- Мост → сервер: `hello { pid, protocol: 1 }`, `own { threadId }` (после `thread/start` и `thread/resume`), `turn { threadId, providerTurnId, text }`, `turn_closed { threadId, providerTurnId, status }`.
- Сервер → мост: `say { threadId, text }`, `end { threadId }`. Сообщения идут только процессу-владельцу треда (`own`).
- Рукопожатие: `grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3]`, `steerMode: "queue"`. У `item.close` обязателен `status`. Каждая пачка дельт в тестах проходит `threadDeltaSchema`.
- Скрытие: `experimental_visibility: "installed"`, `maintenance: { health: true }`, `provider/health → status: "not_installed"`. Обычное сообщение, напечатанное в тред звонка вне звонка, получает ответ «Это запись звонка. Новый звонок — кнопкой 📞» и ход закрывается.

## 8. Системные инструкции

**VOICE, режим `normal`:**

> Ты — голосовой координатор BB, говоришь с владельцем по-русски. Сначала главное, потом детали; не больше 3–5 пунктов за реплику; числа и время — конкретно. Код, пути, ключи и длинные выводы вслух не читай — скажи «прислал в тред». Данные BB бери только из инструментов, не выдумывай. Действия, которые что-то меняют, сервер подтверждает у владельца сам: получив `needsConfirmation`, зачитай `say` дословно по смыслу и жди. «Да» не запускает агентов — для запуска нужно «запускай». Push, merge и деплой голосом недоступны. Пока инструмент работает, коротко скажи, что делаешь.

**VOICE, режим `extended`:** то же, плюс:

> У тебя нет инструментов. Действия и данные BB выполняет система по словам владельца и присылает сообщения, которые начинаются с `[СИСТЕМА]`. Пока ждёшь — коротко скажи, что смотришь. Не говори «выполнено», пока `[СИСТЕМА]` не сообщила. Не говори про системную ошибку. Можешь предлагать действия — делает их владелец своими словами.

**ROUTER:**

> Ты маршрутизатор инструментов BB. Тебе приходят реплики владельца с выжимкой последней реплики голосового агента: `[голос сказал: «…»] Владелец: …`. Просьбы — только слова владельца. Если нужны данные или действие BB — вызови инструмент. Можно цепочкой: найти тред, потом прочитать. Каждый инструмент — не больше одного раза на реплику. Ничего не объясняй и не отвечай текстом.

## 9. Хранилище и CLI

- `bb.storage` — доступ плагина к своему SQLite: `bb.storage.database()` открывает `<dataDir>/plugins/live-call/data.db` (better-sqlite3, WAL, busy_timeout 5000, один хэндл на загрузку плагина); миграции — `bb.storage.migrate(db, statements)` (append-only). Схема: `calls(id, thread_id, started_at, ended_at, mode_history JSON, key_switches INT, end_reason)`, `call_events(call_id, seq, ts, kind, payload JSON)`. Хранится 90 дней. Мелкие настройки (последний режим) — `bb.storage.kv` (значения ≤256 КБ).
- RPC (`bb.rpc`): `status → { configured, keys: 0|1|2, activeCall: { callId, threadId, mode, startedAt } | null }`, `probe → { extendedNativeTools: boolean, checkedAt }`.
- CLI `bb call`: `status`, `calls [--limit N]`, `transcript <callId>`, `probe [--json]` — проверка нативных вызовов Extended одной сессией, только отчёт, режимы не меняет.

## 10. Связь с приёмкой

| Раздел контракта | Этап | Приёмка (спека §9) |
|---|---|---|
| §1–3 | Ф1 | 15 мин без обрыва, перебивание < 300 мс, переход на запасной ключ ≤ 1,5 с |
| §4, §8 (normal, ROUTER) | Ф2 | ответ голосом ≤ 3 с, маршрутизатор не зацикливается |
| §5, §6 | Ф3 | все негативные тесты ConfirmationGate, звонок = тред |
| §7, §9 | Ф4 | `bb plugin build`, тесты, ревью ОК |
