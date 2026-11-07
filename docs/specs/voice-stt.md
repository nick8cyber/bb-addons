# Спека: bb-plugin-voice-stt — голосовой ввод через Gemini Live STT

- Статус: draft → review
- Дата: 2026-11-06
- Референсы логики: `nick8cyber/OmniFlow` (`Sources/GeminiLiveTranscription*.swift`,
  `LiveTranscriptAccumulator.swift`, `GeminiTranscription.swift`,
  `TranscriptionService.swift`, `docs/spec/10-transcription.md`, ADR
  `0002-gemini-live-first`); встроенный `provider-codex` bb 0.48.1.

## 1. Задача

Плагин регистрирует AI-сервис `voice` (голосовой ввод bb: кнопка микрофона в
композере, `bb voice transcribe`). Цепочка движков:

1. **Gemini Live STT** (основной) — WebSocket `BidiGenerateContent`, модель
   `gemini-3.5-transcribe-live`. Ключи — те же, что у плагина live-call
   (настройка `geminiKeys`, 1–2 ключа).
2. **Codex** (фоллбэк №1) — повторяет транспорт встроенного `provider-codex`:
   `~/.codex/auth.json` → `chatgpt.com/backend-api/transcribe` (ChatGPT) или
   `api.openai.com/v1/audio/transcriptions` (API key), модель `gpt-transcribe`.
   Подписка ChatGPT, отдельного ключа не нужно.
3. **Groq** (фоллбэк №2) — `api.groq.com/openai/v1/audio/transcriptions`,
   модель `whisper-large-v3-turbo`, ключ — настройка `groqApiKey`
   (на стенде пока пусто — стадия пропускается).

Выбор сервиса — `bb settings ai-services set voice <serviceId> --plugin voice-stt`
или Settings → AI services → voice. Отдельный код «какой движок сработал»
возвращать не требуется, но факт и причину каждого перехода логируем
(`bb.log.info`/`warn` на сервере и в лог host-воркера).

## 2. Где живёт код

```text
plugins/bb-plugin-voice-stt/
├── package.json         # манифест bb: server + host, без app (headless)
├── server.ts            # settings, register({transcribe,status}), CLI `bb voice-stt`
├── host.ts              # experimental_defineHostEntry: цепочка движков
├── src/
│   ├── contract.ts      # zod-схемы host RPC + общие типы/константы
│   ├── gemini-live.ts   # WS-протокол Gemini Live (порт OmniFlow)
│   ├── accumulator.ts   # LiveTranscriptAccumulator (порт OmniFlow)
│   ├── codex.ts         # auth.json + ChatGPT/OpenAI transcribe (порт provider-codex)
│   ├── groq.ts          # Groq whisper multipart
│   ├── audio.ts         # ffmpeg webm → PCM16 s16le 16 kHz mono
│   └── chain.ts         # оркестратор стадий и бюджеты времени
└── tests/               # vitest, см. §9
```

Ветка `feat/voice-stt`, worktree этого репозитория. Проверки:
`npx vitest run` и `npx tsc --noEmit` в каталоге плагина, `bb plugin build .`
перед установкой.

## 3. Манифест и SDK

`package.json` по образцу `bb-plugin-live-call`:

```jsonc
{
  "name": "bb-plugin-voice-stt",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "bb": ">=0.48.1", "bbPluginSdk": ">=0.6.49" },
  "bb": {
    "name": "Voice STT",
    "description": "Голосовой ввод: Gemini Live STT, фоллбэки Codex и Groq",
    "branding": { "icon": "./icons/mic.svg" },
    "server": "./server.ts",
    "host": "./host.ts"
  }
}
```

devDependencies: `@get-bb/plugin-sdk` (та же линия, что у live-call — 0.6.x;
точную ставит `bb plugin types`/`npm i`), `typescript`, `vitest`, `@types/node`,
`zod` в dependencies (как у live-call). Иконка — простой свой SVG `icons/mic.svg`.

## 4. server.ts

### 4.1. Настройки (`bb.settings.define`)

| ключ | тип | secret | умолчание | назначение |
|---|---|---|---|---|
| `geminiKeys` | string | да | — | 1–2 ключа Gemini AI Studio построчно (как у live-call). |
| `groqApiKey` | string | да | — | ключ Groq; пусто = стадия Groq пропускается. |
| `language` | string | нет | `""` | BCP-47 (`ru`, `ru-RU`); пусто = автодетект. Валидация `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$`, невалидно → null. Gemini получает как есть (`languageCodes`), для Groq срезается регион (`ru-RU`→`ru`, ISO-639-1). |
| `geminiLiveModel` | string | нет | `gemini-3.5-transcribe-live` | live-модель; `models/` добавляется в setup. |
| `groqModel` | string | нет | `whisper-large-v3-turbo` | батч-модель Groq. |

Чтение `geminiKeys`: `raw.split(/\r?\n/).map(trim).filter(Boolean).slice(0,2)` —
ровно как `keysList` в live-call.

### 4.2. Регистрация сервиса

bb 0.48.1 валидирует **функциональную** форму (`validatePluginAiServiceDeclaration`
в server bundle: `complete`/`transcribe`/`status` — функции, хотя бы одна из
complete/transcribe обязательна). Декларативная форма `{id, displayName,
kinds}` из SDK-типов 0.4.x валидатором 0.48.1 НЕ принимается — не использовать.

```ts
bb.experimental_aiServices.register({
  id: "gemini-live",
  displayName: "Gemini Live STT",
  transcribe: async (audio: File, { signal, hint }) => { … },
  status: async () => { … },
});
```

- Вызов ядра (voice-transcription.ts): `service.transcribe(file, {signal, hint})`
  где `file` — File/Blob (`size`≤25 МБ, `type`, `name`, `arrayBuffer()`),
  `hint` — pre-trimmed string | null.
- Возврат — строка; ядро делает `.trim()` и пустую считает «empty reply»
  (мягкий фейл; в режиме automatic пробует следующий сервис).
- Бюджет `signal`: **70 c** (`AI_TASK_TIMEOUT_MS.voice = 70_000`); внутренний
  бюджет цепочки — 65 c (прецедент codex: `timeoutMs=65e3`).
- Ошибка стадии ≠ ошибка сервиса: цепочка пробрасывает ошибку только когда
  отработали все доступные стадии.
- `status()` ≤ **2 c** (`STATUS_TIMEOUT_MS=2000`), строго
  `{ready:true}` | `{ready:false, message}` — без лишних полей.
- Выбор пользователя: `{mode:"service", pluginId, serviceId}` —
  `bb settings ai-services set voice gemini-live --plugin voice-stt`.

### 4.3. Мост к host-энтри

В точности как `provider-codex` (`server.js` бандла 0.48.1): host-клиент
`bb.hosts.experimental_client({ contract })` в фабрике, primary host —
`(await bb.sdk.system.config()).primaryHostId`; `null` → ошибка
«No primary machine is connected».

```ts
transcribe: async (audio, { signal, hint }) => {
  if (audio.size > 20 * 1024 * 1024)
    throw new Error("Recordings over 20 MB are too large to transcribe");
  const cfg = await readSettings();
  const hostId = await primaryHostId();
  const res = await host.call("voice-stt.transcribe", {
    audioBase64: Buffer.from(await audio.arrayBuffer()).toString("base64"),
    mimeType: audio.type || "application/octet-stream",
    filename: audio.name || "voice-input",
    hint,
    config: cfg,            // ключи, модели, язык — см. схему §5
    timeoutMs: 65_000,
  }, { hostId, signal, timeoutMs: 66_000 }); // +1 c grace, как у codex
  if (!res.ok) throw new Error(res.message);
  return res.text;
}
```

`status()`: `{ready:false,message}` если нет ни geminiKeys, ни groqApiKey, ни
доступного codex-auth. Codex-auth виден только на хосте → `status` дёргает
host `voice-stt.status` с бюджетом ~1.2 c (весь status ≤2 c), итог:
`ready = gemini || codex || groq`; message перечисляет что есть/чего нет.
При недоступном хосте — ready только по локальным ключам, message о хосте.

### 4.4. CLI `bb voice-stt`

`bb.cli.register`, команды: `status` (та же сводка, что status()), `transcribe
<file>` — локальная прогонка файла через host-цепочку с печатью выбранного
движка (для отладки; файл читается на стороне CLI-сервера).

## 5. host.ts — контракт и цепочка

`experimental_defineHostEntry` (импорт `@get-bb/plugin-sdk/host`,
образец — `bb-plugin-pi-gateways/host.ts`):

```ts
const contract = {
  "voice-stt.transcribe": { input: z.object({
      audioBase64: z.string().min(1), mimeType: z.string(), filename: z.string(),
      hint: z.string().nullable(),
      config: z.object({
        geminiKeys: z.array(z.string()),
        geminiLiveModel: z.string(),
        groqApiKey: z.string().nullable(),
        groqModel: z.string(),
        language: z.string().nullable(),   // сервер нормализует "" → null
      }).strict(),
      timeoutMs: z.number().int().positive(),
    }).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), text: z.string(),
        engine: z.enum(["gemini-live","codex","groq"]) }).strict(),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }).strict(),
    ]) },
  "voice-stt.status": { input: z.object({}).strict(), output: z.object({
      codexAuth: z.enum(["ok","missing","invalid","unusable","expired"]),
      ffmpeg: z.boolean(),
    }).strict() },
};
```

Порядок `voice-stt.transcribe` (общий дедлайн — `timeoutMs` и `context.signal`):

1. **Подготовка**: `audioBase64` → Buffer → временный файл
   (`context.experimental_paths.tempDir`, имя по `filename`/`mimeType` —
   webm). Лимит входа 20 МБ (как у codex).
2. **ffmpeg → PCM** (`audio.ts`, нужен только для Gemini): `ffmpeg -v error -i
   in -f s16le -acodec pcm_s16le -ar 16000 -ac 1 out` через `spawn`/execFile,
   таймаут 4 c (как в таблице бюджетов). Нет ffmpeg или ошибка декода —
   Gemini-стадия пропускается (пометить в лог), codex/groq работают по
   исходному webm.
3. **Стадия Gemini Live** (§6): по каждому ключу из `geminiKeys` один заход;
   ЛЮБОЙ сбой до первого распознанного текста (auth/quota-отказ апгрейда,
   error-фрейм, таймаут setup, разрыв сокета) — следующий ключ; все ключи
   исчерпаны — стадия провалена, переход к codex. Пустой финал (тишина) =
   мягкий провал стадии → codex (по ADR-0002).
4. **Стадия Codex** (§7): любой сбой → Groq.
5. **Стадия Groq** (§8): нет ключа — пропуск; любой сбой → финальная ошибка.
6. Итог: первый непустой текст побеждает; `engine` = `"gemini-live" | "codex" |
   "groq"` (в лог/CLI; ядру уходит только text). Все стадии упали →
   `{ok:false, code, message}` — message собирает причины по стадиям
   (`gemini-live: …; codex: …; groq: …`), code — код последней стадии.

`code` ошибок — из множества `{timeout, rate_limited, service_unavailable,
auth_required, request_failed, invalid_response}` (классификация как у
provider-codex: `AiServiceFailure{code, detailCode, message}` →
`{ok:false, code, message}`; AbortError → `timeout`).

Бюджеты стадий (в рамках общих 65 c):
ffmpeg ≤4 c, Gemini `min(15 + 0.4·audioSec, 55)` c на ключ-сессию
(connect+setup ≤5 c), Codex ≤15 c, Groq ≤15 c. **Guard по остатку**: перед
каждой стадией если `remainingMs < 5000` — стадия пропускается с пометкой
`timeout` в причинах (дедлайн считается от `timeoutMs`/signal один раз на
входе). Бюджет Gemini масштабируется длиной аудио, потому что файл уходит
пачкой, а транскрипт догоняет потоком (§6.6).

## 6. Gemini Live — точный протокол (порт OmniFlow)

### 6.1. Сокет

- URL: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<apiKey>`
- Аутентификация: ключ в query-параметре `key` — документированный способ
  Google и путь live-call (undici WebSocket на Node 22 технически умеет
  заголовки через init-dict, но держимся канонического варианта).
- Ключ маскируется ВЕЗДЕ: в логах `url.replace(/key=[^&]+/, "key=…")` и из
  текстов ошибок значение ключа вычищается перед пробросом наверх.
- WebSocket — глобальный `WebSocket` Node (как `live-client.ts` live-call);
  кадры могут приходить бинарными — принимать string | Blob | ArrayBuffer.
- Лимит сессии Gemini Live ~10 мин — для файлового STT неактуально, но
  фиксируем: входные записи голосового ввода bb на порядки короче.

### 6.2. Кадры

Setup (первым, один раз):

```json
{"setup":{
  "model":"models/gemini-3.5-transcribe-live",
  "generationConfig":{"responseModalities":["TEXT"]},
  "inputAudioTranscription":{"mode":"SMART",
    "custom_vocabulary":["…"],"languageCodes":["ru"]}}}
```

- `model` — `models/` + id, если префикса нет.
- `custom_vocabulary` — из `hint` (см. `vocabularyTerms` §6.4); пустой список →
  ключ отсутствует.
- `languageCodes` — только когда `language` задан (`["ru"]`); строковое поле
  `language` ЗАПРЕЩЕНО (сервер не отвечает setupComplete — замечено в OmniFlow).

Аудио: `{"realtimeInput":{"audio":{"mimeType":"audio/pcm;rate=16000","data":"<b64>"}}}`
— чанками ~100 мс (3200 байт PCM при 16 кГц).

Конец: `{"realtimeInput":{"audioStreamEnd":true}}`.

### 6.3. Серверные кадры

- `setupComplete` → можно слать аудио; до него чанки буферизируются
  (pendingChunks, drop-oldest 200 — у нас буфер короткий: файл уходит после
  setup, потери недопустимы, лимит не нужен).
- `voiceActivity.type` = `ACTIVITY_START` / `ACTIVITY_END` — границы сегментов.
- `serverContent.interimInputTranscription.text` — интерим, **ЗАМЕНЯЕТ** открытый
  сегмент (пустая строка — валидный сброс).
- `serverContent.inputTranscription.text` — финал сегмента, тоже **ЗАМЕНЯЕТ**
  открытый сегмент (не дописывать — дублирует интерим).
- `modelTurn` — игнорировать.
- `turnComplete`/`generationComplete` — конец СЕРВЕРНОГО хода, не сессии:
  учитывать только после нашего `audioStreamEnd`.
- `error` → провал стадии (`message` — в лог/отчёт).
- Закрытие сокета до финала без error-фрейма → провал стадии (сообщение «Could
  not connect to Gemini live transcription. Check the transcription API key.»
  — при отказе до setupComplete).

### 6.4. `vocabularyTerms` (порт)

split по `\n , ;` → trim → выкинуть пустые → dedup по lowercased (сохранить
первое написание) → `prefix(1000)`. Общая функция для Gemini live и Groq `prompt`
(для Groq — join через запятую либо исходный hint as-is; если hint — это уже
строка подсказки, передаём её как есть без разбора).

### 6.5. `LiveTranscriptAccumulator` (порт)

- `feedInterim/feedFinal` — замена открытого сегмента.
- `startSegment()` = `endSegment()` перед новым; `endSegment()` коммитит
  непустой trim в `committedSegments`.
- `finalText()` — committed + открытый хвост, join `" "`, trim.

### 6.6. Адаптивный финиш — файловый режим (ADR-0002 + поправка PLUG-126)

Файл уходит пачкой (~секунды), а транскрипт догоняет потоком десятки секунд —
константы OmniFlow рассчитаны на живой поток и на длинных записях резали
текст (баг: cap 6 c возвращал урезанный текст как успех). Пейсинг отправки
НЕ используется: blast покрывает файл целиком, а растянутая отправка
теряет хвост (сервер отбрасывает бэклог после audioStreamEnd — проверено
живьём: пейсинг 1.5× → хвост ~8 c записи потерян, blast → полное покрытие).

- `settle`: resolve когда `sinceEnd ≥ 0.8c И sinceLastActivity ≥ 3.0c`;
  poll 80 мс. `lastActivityAt` армируется от setupComplete и обновляется на
  ЛЮБЫХ кадрах активности/транскрипта.
- `cap`: `sinceEnd ≥ min(8 + 0.4·audioSec, 45)` c → **ПРОВАЛ стадии**
  (`timeout`), не resolve с частичным текстом. Урезанный текст никогда не
  возвращается: либо settle (поток реально затих), либо фоллбэк.
- `turnComplete`/`generationComplete` НЕ завершают сессию — в файловом режиме
  могут приходить посреди буфера. Только endSegment для аккумулятора.
- Тишина без кадров: settle от setupComplete/streamEnd → "" → мягкий провал →
  codex (как раньше).

### 6.7. Обработка файла целиком

Наш вход — уже готовый файл, не живой поток: после setupComplete шлём все
чанки подряд (необязательно «в реальном темпе»), затем `audioStreamEnd`.
Ждём финал с адаптивным финишем. Бюджет на одну ключ-сессию
`min(15 + 0.4·audioSec, 55)` c (connect+setup ≤5 c внутри него, иначе
следующий ключ; см. бюджеты §5).

## 7. Codex — точный протокол (порт provider-codex 0.48.1, host.js)

### 7.1. Авторизация `~/.codex/auth.json`

Путь: `join(resolveCodexHome(homedir(), env), "auth.json")` — `CODEX_HOME`
env honoured, иначе `~/.codex`.

`classifyAuthJson`:
- `auth_mode === "apikey" | "apiKey"` ИЛИ (`auth_mode` отсутствует И есть
  `OPENAI_API_KEY`) → `{type:"apiKey", apiKey}` (пустой ключ → unusable/api_key).
- Иначе `tokens.access_token` обязателен (нет → unusable/access_token);
  accountId = `tokens.account_id` ?? JWT(access).`chatgpt_account_id` ??
  JWT(id_token).`chatgpt_account_id` (нет → unusable/account_id);
  `isFedrampAccount` = claim `chatgpt_account_is_fedramp` в любом токене.
- Файл нет/не читается → `auth_required`/`codex_auth_missing`; не-JSON или
  unusable → `auth_required`/`codex_auth_invalid`.
- Рефреша токена нет: истёкший (claim `exp` < now) → классификация `expired`;
  на запросе всё равно идём (токен могли обновить вне файла), 401 →
  `auth_required`.
- Маппинг в `voice-stt.status.codexAuth`: `ok`→`ok` (если `expired` →
  `expired`), `missing`/`unreadable`→`missing`, `malformed`→`invalid`,
  `unusable`→`unusable`.

### 7.2. Запрос (из бандла)

- ChatGPT: `POST https://chatgpt.com/backend-api/transcribe`,
  заголовки `Authorization: Bearer <accessToken>`,
  `chatgpt-account-id: <accountId>`, `originator: bb`,
  `User-Agent: bb-host-daemon`, `X-OpenAI-Fedramp: true` (если fedramp).
- API key: `POST https://api.openai.com/v1/audio/transcriptions`,
  `Authorization: Bearer <key>`, `User-Agent: bb-host-daemon`.
- FormData: `file` = Blob(исходное аудио, mimeType из входа, filename),
  `model` = `gpt-transcribe` (фиксированная), `prompt` = hint (только если
  не null).
- Ответ JSON: текст из поля `text`; нет поля или не-JSON → `invalid_response`/
  `codex_response_invalid`. Лимит ответа 1 МБ.
- Cloudflare challenge: `403` + заголовок `cf-mitigated:"challenge"` ИЛИ
  content-type `text/html` → `service_unavailable` с пояснением. Cookie-jar
  retry из provider-codex НЕ портим (документированное упрощение).
- Маппинг HTTP: 401→`auth_required`, 429→`rate_limited`, ≥500→
  `service_unavailable`, прочее→`request_failed`; AbortError → `timeout`.

## 8. Groq

- `POST https://api.groq.com/openai/v1/audio/transcriptions`,
  `Authorization: Bearer <groqApiKey>`.
- FormData: `file` (исходный webm — Groq принимает webm), `model` = `groqModel`
  (def `whisper-large-v3-turbo`), `response_format` = `verbose_json` для
  `whisper-1`/`whisper-large-v3`/`whisper-large-v3-turbo`, иначе `json`,
  `language` (если задан — только базовый ISO-639-1 субтег: `ru-RU` → `ru`,
  срез региона как в таблице настроек), `prompt` = hint (если не null).
- Ответ: `.text` из JSON; пусто → `invalid_response`/мягкий провал.
- Маппинг статусов — как у codex (401/429/5xx/прочее).

## 9. Тесты (vitest, без сети)

- `accumulator`: замена сегмента interim/final, коммит по ACTIVITY_END, join
  сегментов, пустые сегменты.
- `vocabularyTerms`: split/trim/dedup/limit.
- Парсер кадров Gemini: setupComplete, voiceActivity, interim/final replace,
  turnComplete только после streamEnd, error.
- Адаптивный финиш: фейковые таймеры/часы — settle vs cap, пустой результат →
  мягкий провал.
- `classifyCodexAuth`: apikey-режим, chatgpt+account_id из токена и из JWT,
  missing/malformed → auth_required.
- FormData codex/groq: `model`, `prompt` только при hint, `response_format` по
  модели.
- Цепочка: замоканные стадии — порядок Gemini→Codex→Groq, пропуск Groq без
  ключа, ротация ключей Gemini при quota И при auth-отказе апгрейда,
  guard `remainingMs<5000` пропускает стадию, итоговая ошибка собирает причины.
- Маскировка `?key=` в логах и в текстах ошибок (значение ключа не всплывает).
- `language`: нормализация `""`→null, `ru-RU`→`ru` для Groq, невалидный код →
  null.
- Формат ошибок: коды из множества §5.

Живые сетевые вызовы в тестах запрещены — WS/HTTP мокаются.

## 10. Логирование и секреты

- В лог — только факт стадии и код/текст ошибки, без значений ключей и без
  транскрипта (кроме debug-уровня длины).
- Ключ Gemini — в `?key=` URL (см. §6.1), в логах маскируется `key=…`.
- `~/.codex/auth.json` читается только на хосте, значения наружу не уходят.
- Ключи, приходящие в `config` host RPC, не логируются и не попадают в
  сообщения ошибок.

## 11. Проверка (что значит «работает»)

1. `npx vitest run`, `npx tsc --noEmit`, `bb plugin build .` — зелёные.
2. `bb plugin install <path>` → `bb plugin list` — running.
3. `bb plugin config voice-stt set geminiKeys '<те же ключи, что у live-call>'`.
4. `bb settings ai-services set voice gemini-live --plugin voice-stt` →
   `bb settings ai-services` показывает `voice → Gemini Live STT`.
5. `bb voice transcribe <test.webm>` на реальном файле с речью — текст на выходе;
   в логе видно движок `gemini-live`. При отключённой сети к Google — цепочка
   уходит в codex.
6. `bb voice-stt status` печатает сводку по движкам.

## 12. Ограничения/незадачи

- Не трогаем `provider-codex`, `live-call`, настройки других плагинов.
- Не меняем UI: микрофон рисует ядро, когда сервис voice выбран/ready.
  (Перекрывается отдельной спекой `voice-stt-live.md` — живой ввод через
  плагин-UI; для файлового пайплайна правило остаётся в силе.)
- Пост-обработка (LLM cleanup) — вне задачи; `mode: "SMART"` у Gemini уже даёт
  чистый текст, у codex/groq — как есть.
- Не коммитим в `main`; работа — `feat/voice-stt`, отчёт — ветка + SHA.
  Вливание в `main` — только по слову владельца (правила репо/AGENTS).
- Публичный репозиторий: в код/тесты/коммиты не попадают реальные id тредов,
  пути `/home/...`, ключи, домены стенда (см. AGENTS.md live-call — те же
  правила). Тесты — синтетика (`thr_test…`, `example.com`, dummy-ключи).
- Операции над самим live-call плагином (reload/install/disable) — не нужны
  и запрещены без `bb call status | grep -q "звонок: нет"`.
