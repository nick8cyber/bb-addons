# Voice STT — статус

## Файловый пайплайн (`ai.voice.transcribe`)

Работает: ffmpeg → Gemini Live → Codex → Groq, ротация 2 ключей, маскировка
секретов. Контракт — `docs/specs/voice-stt.md`.

## Живой режим (диктовка, спека `docs/specs/voice-stt-live.md`)

Реализовано:

- Кнопка в `composer.actions` (все scope'ы), composer-команда «Voice STT
  Live: диктовка» (Mod+Shift+V), вход из sidebar footer. В compact-
  композере плагинные actions хост не рисует — вход через команду/футер.
- Оверлей записи (`experimental_appOverlay`): пульс + секундомер, живой
  интерим (единственное место показа), Enter — вставить, Esc — отмена.
  Гибридная модель: hold >400 мс — «держи и говори», тап — toggle.
- WS `/live-voice` (`auth:"local"` + одноразовый токен 30 с через RPC
  `liveToken`, hello-гейт 3 с, busy → 4009, unauthorized → 4401).
- Потоковая Gemini-сессия в server entry: буфер до `setupComplete`,
  `audioStreamEnd` строго после последнего аудио-кадра, финиш OmniFlow
  0.8/1.0/6.0, ротация ключей до ready.
- RMS-тишина → `final{engine:"silence"}` без фоллбэка; пустой финал при
  звуке и сбой сессии → PCM→WAV→host-RPC `skipStages:["gemini-live"]` →
  codex→groq (`degraded:true`).
- Обрыв сокета у клиента: запись продолжается локально; на отпускании —
  новая сессия с реплеем PCM; реконнект >5 с → WAV → RPC `liveFallback`
  (файловая цепочка целиком).
- Настройки `liveInput` (default true) и `vocabularyTerms` для live-словаря.
- Юнит-тесты по §9: 146 тестов зелёные (`npx vitest run`), `npx tsc
  --noEmit`, `bb plugin build .`.

Не проверено вручную (acceptance §10): живой прогон в браузере, iOS,
запись >5 мин — требуется ручная проверка после установки.
